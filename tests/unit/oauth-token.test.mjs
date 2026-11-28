// POST /api/oauth/token (worker/routes/oauth.ts tokenRoute): its checks in
// order; every refusal of a client assertion (RFC 7523, Poppy 4.1); a key
// set's keys and its site-wide refetch gate; the failed-authentication
// limit; the headers on every answer; the code exchange; the refresh with
// its rotation, its grace and its reuse; idle; and DPoP (RFC 9449): each of
// its checks, the family bound at its code exchange (and a public family at
// its first refresh with a proof), a grace repeat held to the bound key,
// dpop_jkt and dpop_always. Keys, tokens and codes are made here. Run with
// `npm run test:unit`.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  makeSigninWorld, people, signIn, token, clientAuth, assertion, dpopProof, keyPair, poppyApp, pkce, authzQuery, decide, jws, newJti,
  PUBLIC_APP, ORIGIN, ADDRESS, signins, signin, toolCall,
} from "./signin-world.mjs";
import { OAUTH_ACCESS_TTL_S, OAUTH_AUTH_FAILS_PER_IP, OAUTH_IDLE_DAYS, OAUTH_QUOTA_ROOM, OAUTH_REFRESH_GRACE_S } from "../../worker/limits.ts";
import { forgetKeySets } from "../../worker/lib/oauth.ts";
import { resetWarnings } from "../../worker/lib/log.ts";

const URN = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";
const nowS = () => Math.floor(Date.now() / 1000);
async function logged(f) {
  resetWarnings();
  const lines = [], real = console.warn;
  console.warn = (s) => { try { lines.push(JSON.parse(s)); } catch { lines.push(s); } };
  try { await f(); } finally { console.warn = real; }
  return lines;
}
/** a poppy world with Pat in lima, and the app's code ready to exchange (not yet exchanged) */
async function poppyCode(opts = {}) {
  const P = await poppyApp(opts.app || {});
  const w = makeSigninWorld([P.app]);
  const pat = people(w, ["lima"]);
  const { verifier, challenge } = await pkce();
  const query = authzQuery(P.app, challenge, { resource: ADDRESS, ...(opts.extra || {}) });
  const d = await decide(w, { params: query, approve: true, name: "Scout", rooms: [{ room: "lima", inviter_token: pat.lima }] });
  const code = new URL(d.json.redirect).searchParams.get("code");
  return { ...P, w, pat, verifier, code, redirect: new URLSearchParams(query).get("redirect_uri") };
}
const exchange = (c, auth, extra = {}, headers = {}) => token(c.w, { grant_type: "authorization_code", code: c.code, code_verifier: c.verifier, redirect_uri: c.redirect, resource: ADDRESS, ...auth, ...extra }, headers);
const asserted = async (c, pair, claims, header, opts) => ({ client_assertion_type: URN, client_assertion: await assertion(c.app, pair, claims, header, opts) });
const refreshOf = (w, app, rt, auth, extra = {}, headers = {}) => token(w, { grant_type: "refresh_token", refresh_token: rt, resource: ADDRESS, ...auth, ...extra }, headers);

test("every answer: CORS_OAUTH, no-store and Pragma: no-cache; a 401 invalid_client names the scheme of the Authorization header sent, and none when none was sent; the header is never read as a credential", async () => {
  const w = makeSigninWorld();
  const pat = people(w, ["lima"]);
  const s = await signIn(w, PUBLIC_APP, pat);
  for (const r of [s.token, await token(w, { grant_type: "refresh_token" }), await token(w, { grant_type: "nope", client_id: PUBLIC_APP.client_id })]) {
    assert.equal(r.headers.get("Cache-Control"), "no-store");
    assert.equal(r.headers.get("Pragma"), "no-cache");
    assert.equal(r.headers.get("Access-Control-Allow-Origin"), "*");
    assert.match(r.headers.get("Access-Control-Allow-Headers"), /, DPoP$/);
  }
  const unknown = { client_id: "https://nobody.example/c", grant_type: "authorization_code" };
  for (const [auth, want] of [[null, null], ["Basic Zm9vOmJhcg==", "Basic"], ["Bearer x", "Bearer"], ["bogus(scheme) x", "Basic"]]) {
    const r = await token(w, unknown, auth ? { Authorization: auth } : {});
    assert.deepEqual([r.status, r.json], [401, { error: "invalid_client" }], String(auth));
    assert.equal(r.headers.get("WWW-Authenticate"), want, String(auth));
  }
  // a public client's good request that also carries Authorization: Basic is answered as if it had none
  const s2 = await signIn(w, PUBLIC_APP, pat, { name: "Scout2" });
  const r = await refreshOf(w, PUBLIC_APP, s2.refresh, { client_id: PUBLIC_APP.client_id }, {}, { Authorization: "Basic Zm9vOmJhcg==" });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.headers.get("WWW-Authenticate"), null);
});

test("the order of the checks: the method, the failed-authentication limit, the client, its authentication, DPoP, then the grant", async () => {
  const c = await poppyCode();
  const w = c.w;
  // a method other than POST
  const { read } = await import("./agent-world.mjs");
  const { tokenRoute } = await import("../../worker/routes/oauth.ts");
  assert.equal((await read(tokenRoute(w.rc("GET", "/api/oauth/token")))).status, 405);
  // an unknown client beats a bad proof and an unknown grant
  let r = await token(w, { client_id: "https://nobody.example/c", grant_type: "nope" }, { DPoP: "bad" });
  assert.deepEqual([r.status, r.json.error], [401, "invalid_client"]);
  // a failed authentication beats a bad proof
  r = await token(w, { grant_type: "nope", ...(await asserted(c, c.es, { aud: ORIGIN + "/api/oauth/token" })) }, { DPoP: "bad" });
  assert.deepEqual([r.status, r.json.error], [401, "invalid_client"]);
  // a bad proof beats an unknown grant
  r = await token(w, { grant_type: "nope", ...(await asserted(c, c.es)) }, { DPoP: "bad" });
  assert.deepEqual([r.status, r.json.error], [400, "invalid_dpop_proof"]);
  r = await token(w, { grant_type: "nope", ...(await asserted(c, c.es)) });
  assert.deepEqual([r.status, r.json.error], [400, "unsupported_grant_type"]);
  // a parameter sent twice, and a body too large
  r = await token(w, { grant_type: ["authorization_code", "authorization_code"], ...(await asserted(c, c.es)) });
  assert.deepEqual([r.status, r.json.error], [400, "invalid_request"]);
  r = await token(w, { grant_type: "authorization_code", pad: "x".repeat(9000) });
  assert.deepEqual([r.status, r.json.error], [413, "invalid_request"]);
  // the limit beats everything after the method: full, a good request is 429
  w.harness(OAUTH_QUOTA_ROOM).room.setTestAgentLimits({ per_ip: 1 });
  const net = { "CF-Connecting-IP": "10.50.0.1" };
  r = await token(w, { client_id: "https://nobody.example/c", grant_type: "authorization_code" }, net);
  assert.equal(r.status, 401, "the one failure the counter takes");
  r = await exchange(c, await asserted(c, c.es), {}, net);
  assert.deepEqual([r.status, r.json], [429, { error: "slow_down", error_description: "Too many failed attempts from this network; try again later." }]);
  assert.ok(Number(r.headers.get("Retry-After")) > 0);
  assert.equal(r.headers.get("Pragma"), "no-cache");
  w.harness(OAUTH_QUOTA_ROOM).room.setTestAgentLimits(null);
  assert.equal((await exchange(c, await asserted(c, c.es), {}, net)).status, 200, "the limit cleared, the same code redeems");
});

test("the failed-authentication limit counts failures only, per network, OAUTH_AUTH_FAILS_PER_IP of them", async () => {
  const w = makeSigninWorld();
  const pat = people(w, ["lima"]);
  const s = await signIn(w, PUBLIC_APP, pat);
  for (let i = 0; i < OAUTH_AUTH_FAILS_PER_IP; i++) assert.equal((await token(w, { client_id: "https://nobody.example/c", grant_type: "refresh_token" })).status, 401);
  assert.equal((await refreshOf(w, PUBLIC_APP, s.refresh, { client_id: PUBLIC_APP.client_id })).status, 429);
  assert.equal((await refreshOf(w, PUBLIC_APP, s.refresh, { client_id: PUBLIC_APP.client_id }, {}, { "CF-Connecting-IP": "10.99.0.1" })).status, 200, "another network");
});

test("a public client: neither client_assertion nor client_secret may be sent", async () => {
  const w = makeSigninWorld();
  const pat = people(w, ["lima"]);
  const s = await signIn(w, PUBLIC_APP, pat);
  const pair = await keyPair("ES256", "k");
  for (const extra of [{ client_secret: "s" }, { client_assertion_type: URN, client_assertion: await assertion(PUBLIC_APP, pair) }]) {
    const r = await refreshOf(w, PUBLIC_APP, s.refresh, { client_id: PUBLIC_APP.client_id, ...extra });
    assert.deepEqual([r.status, r.json], [401, { error: "invalid_client" }], JSON.stringify(Object.keys(extra)));
  }
});

test("a client assertion refused for each fault: aud the token endpoint, aud a list, ten minutes, a reused jti, an unknown kid, a key not in the set, HS256, none, a DER signature, PS384 with salt 32, crit, nbf ahead, a short jti, iss or sub another, the wrong assertion type", async () => {
  const c = await poppyCode();
  const stranger = await keyPair("ES256", "es-1");
  const t = nowS();
  const hs = "eyJhbGciOiJIUzI1NiJ9." + Buffer.from(JSON.stringify({ iss: c.app.client_id, sub: c.app.client_id, aud: ORIGIN, iat: t, exp: t + 60, jti: newJti() })).toString("base64url") + ".c2ln";
  const none = "eyJhbGciOiJub25lIn0." + Buffer.from(JSON.stringify({ iss: c.app.client_id, sub: c.app.client_id, aud: ORIGIN, iat: t, exp: t + 60, jti: newJti() })).toString("base64url") + ".";
  const reused = await assertion(c.app, c.es);
  assert.equal((await exchange(c, { client_assertion_type: URN, client_assertion: reused }, { code: "x" })).status, 400, "the first use authenticates (the code is bad)");
  const cases = [
    ["aud the token endpoint", await asserted(c, c.es, { aud: ORIGIN + "/api/oauth/token" })],
    ["aud a list", await asserted(c, c.es, { aud: [ORIGIN] })],
    ["ten minutes", await asserted(c, c.es, { exp: t + 600 })],
    ["expired", await asserted(c, c.es, { iat: t - 400, exp: t - 100 })],
    ["iat ahead", await asserted(c, c.es, { iat: t + 120, exp: t + 180 })],
    ["a reused jti", { client_assertion_type: URN, client_assertion: reused }],
    ["an unknown kid", await asserted(c, c.es, {}, { kid: "nope" })],
    ["a key not in the set", { client_assertion_type: URN, client_assertion: await assertion(c.app, stranger) }],
    ["HS256", { client_assertion_type: URN, client_assertion: hs }],
    ["none", { client_assertion_type: URN, client_assertion: none }],
    ["an ES256 signature in DER", await asserted(c, c.es, {}, {}, { der: true })],
    ["PS384 with salt 32", await asserted(c, c.ps, {}, {}, { saltLength: 32 })],
    ["a crit header", await asserted(c, c.es, {}, { crit: ["exp"] })],
    ["an empty crit", await asserted(c, c.es, {}, { crit: [] })],
    ["nbf a minute ahead", await asserted(c, c.es, { nbf: t + 60 })],
    ["a short jti", await asserted(c, c.es, { jti: "short" })],
    ["iss another", await asserted(c, c.es, { iss: "https://other.example/" })],
    ["sub another", await asserted(c, c.es, { sub: "https://other.example/" })],
    ["no exp", await asserted(c, c.es, { exp: undefined })],
    ["the wrong assertion type", { client_assertion_type: "urn:other", client_assertion: await assertion(c.app, c.es) }],
    ["none at all", { client_id: c.app.client_id }],
  ];
  for (const [i, [what, auth]] of cases.entries()) {
    const r = await exchange(c, auth, {}, { "CF-Connecting-IP": "10.60.0." + i });
    assert.deepEqual([r.status, r.json], [401, { error: "invalid_client" }], what);
  }
  // accepted: PS384 with salt 48, nbf now, no kid (tried by algorithm), the client named by client_id too
  assert.equal((await exchange(c, await asserted(c, c.ps, { nbf: t }))).status, 200, "PS384, salt 48, nbf now");
  const c2 = await poppyCode();
  const noKid = { ...c2.es, jwk: { ...c2.es.jwk } };
  delete noKid.jwk.kid;
  const r = await exchange(c2, { client_id: c2.app.client_id, client_assertion_type: URN, client_assertion: await assertion(c2.app, noKid) });
  assert.equal(r.status, 200, "no kid: each key of the type tried: " + r.text);
});

test("the client the code or refresh token is bound to: another known app's authentication is invalid_grant, and ends nothing", async () => {
  const P = await poppyApp();
  const w = makeSigninWorld([PUBLIC_APP, P.app]);
  const pat = people(w, ["lima"]);
  const s = await signIn(w, PUBLIC_APP, pat);
  const r = await refreshOf(w, P.app, s.refresh, await clientAuth(P.app, P.es));
  assert.deepEqual([r.status, r.json], [400, { error: "invalid_grant" }]);
  assert.equal((await refreshOf(w, PUBLIC_APP, s.refresh, { client_id: PUBLIC_APP.client_id })).status, 200, "the sign-in still works for its own app");
  // a code likewise, even to an app whose redirect is the same, with the right verifier and redirect
  const TWIN = { ...PUBLIC_APP, key: "twin", client_id: "https://standin.example/oauth/twin.json" };
  const w2 = makeSigninWorld([PUBLIC_APP, TWIN]);
  const pat2 = people(w2, ["lima"]);
  const { verifier, challenge } = await pkce();
  const query = authzQuery(PUBLIC_APP, challenge, { resource: ADDRESS });
  const d = await decide(w2, { params: query, approve: true, name: "Scout", rooms: [{ room: "lima", inviter_token: pat2.lima }] });
  const c = { w: w2, code: new URL(d.json.redirect).searchParams.get("code"), verifier, redirect: new URLSearchParams(query).get("redirect_uri") };
  const t = await exchange(c, { client_id: TWIN.client_id });
  assert.deepEqual([t.status, t.json], [400, { error: "invalid_grant" }]);
  assert.equal((await exchange(c, { client_id: PUBLIC_APP.client_id })).status, 200, "the code still serves its own app");
});

test("a key set: a key without a kid is skipped and logged once; the refetch gate grants one fetch per OAUTH_KEYSET_REFETCH_S site-wide, across isolates, failures counted", async () => {
  // inline: a key with no kid is skipped (so the assertion it signs fails) and logged
  const P = await poppyApp();
  const bare = { ...P.es.jwk };
  delete bare.kid;
  const lines = await logged(async () => {
    const c = await poppyCode({ app: { key: "nokid", client_id: "https://nokid.example/c", jwks: { keys: [bare] } } });
    const noKidPair = { ...c.es, jwk: bare, privateKey: P.es.privateKey };
    const r = await exchange(c, { client_assertion_type: URN, client_assertion: await assertion(c.app, noKidPair) });
    assert.equal(r.status, 401, "the key without a kid is not used");
  });
  assert.deepEqual(lines.filter((l) => l.warn === "oauth.keyset"), [{ warn: "oauth.keyset", error: null, app: "nokid", reason: "no_kid" }]);
  // a key set at an address (a stand-in's local one, fetch stubbed): two unknown kids within the window make one fetch
  const real = globalThis.fetch;
  const asked = [];
  let serve = null;
  globalThis.fetch = async (url, init) => { asked.push([String(url), init.redirect, init.credentials]); return new Response(JSON.stringify(serve), { status: 200, headers: { "Cache-Control": "max-age=600" } }); };
  try {
    const uri = "http://127.0.0.1:9/jwks.json";
    const c = await poppyCode({ app: { key: "remote", client_id: "https://remote.example/c", jwks: undefined, jwks_uri: uri } });
    serve = { keys: [c.es.jwk] };
    let r = await exchange(c, await asserted(c, c.es));
    assert.equal(r.status, 200, "the first fetch: granted (nothing kept yet): " + r.text);
    assert.deepEqual(asked, [[uri, "manual", "omit"]]);
    const fresh = await keyPair("ES256", "es-2");
    serve = { keys: [c.es.jwk, fresh.jwk] };
    // a kid this isolate does not hold, within the window: the gate (the app's store, site-wide) is closed
    r = await exchange(c, await asserted(c, fresh), { code: "x" });
    assert.equal(r.status, 401, "an unknown kid within the window: no refetch, refused");
    // another isolate, its memory empty: the gate still closed
    forgetKeySets();
    r = await exchange(c, await asserted(c, fresh), { code: "x" });
    assert.equal(r.status, 401, "a second isolate: still no refetch");
    assert.equal(asked.length, 1, "one fetch for two unknown kids, across two isolates");
    // past the window, the refetch is granted and the new key works
    const name = c.w.asked.find((a) => a.method === "clientNote").name;
    c.w.harness(name).db.prepare("UPDATE ok SET tried = tried - 31000").run();
    r = await exchange(c, await asserted(c, fresh), { code: "x" });
    assert.equal(r.json.error, "invalid_grant", "authenticated with the new key (the code is not one)");
    assert.equal(asked.length, 2);
  } finally {
    globalThis.fetch = real;
    forgetKeySets();
  }
});

test("the code exchange: PKCE, the redirect, the resource (the default token only where the request named the domain or none), a code once; tokens with the scope always stated", async () => {
  const w = makeSigninWorld();
  w.harness("__agent-quota").room.setTestAgentLimits({ per_ip: 1000, per_room: 1000, per_day: 1000 });
  const pat = people(w, ["lima", "oslo"]);
  const run = async (o, ex = {}) => {
    const { verifier, challenge } = await pkce();
    const query = authzQuery(PUBLIC_APP, challenge, o.resource === undefined ? {} : { resource: o.resource });
    // the same name each time reuses the unused seat the first approval made (the person's invite caps stay untouched)
    const d = await decide(w, { params: query, approve: true, name: "Scout", rooms: [{ room: "lima", inviter_token: pat.lima }] });
    const code = new URL(d.json.redirect).searchParams.get("code");
    return token(w, { grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: new URLSearchParams(query).get("redirect_uri"), client_id: PUBLIC_APP.client_id, ...ex });
  };
  const ok = await run({ resource: ADDRESS }, { resource: ADDRESS });
  assert.equal(ok.status, 200, ok.text);
  assert.deepEqual(Object.keys(ok.json), ["access_token", "token_type", "expires_in", "refresh_token", "scope"]);
  assert.deepEqual([ok.json.token_type, ok.json.expires_in, ok.json.scope], ["Bearer", OAUTH_ACCESS_TTL_S, "rooms"]);
  assert.match(ok.json.access_token, /^\.ao1\./);
  assert.match(ok.json.refresh_token, /^\.ar1\./);
  assert.deepEqual((await run({ resource: ADDRESS }, { code_verifier: "x".repeat(43) })).json, { error: "invalid_grant" }, "PKCE");
  assert.deepEqual((await run({ resource: ADDRESS }, { code_verifier: undefined })).json, { error: "invalid_grant" }, "no verifier");
  assert.deepEqual((await run({ resource: ADDRESS }, { redirect_uri: "http://127.0.0.1:9/callback" })).json, { error: "invalid_grant" }, "another port: the redirect exactly as sent");
  assert.deepEqual((await run({ resource: ADDRESS }, {})).json, { error: "invalid_target" }, "no resource: the default token, which a request that named only the address cannot get");
  assert.equal((await run({ resource: ORIGIN }, {})).status, 200, "the default token, for a request that named the domain");
  assert.equal((await run({}, {})).status, 200, "the default token, for a request that named none");
  assert.deepEqual((await run({ resource: ORIGIN }, { resource: ADDRESS })).json, { error: "invalid_target" }, "a resource the request did not name");
  assert.equal((await run({}, { resource: "HTTP://LOCALHOST/api/mcp/signin/" })).status, 200, "normalised as authorize normalises it");
  // the default token does not sign in at the sign-in address
  const d = await run({}, {});
  assert.equal((await signin(w, d.json.access_token, toolCall("list_rooms"))).status, 401);
  assert.deepEqual((await token(w, { grant_type: "authorization_code", code: ".oc1.x", client_id: PUBLIC_APP.client_id })).json, { error: "invalid_grant" });
});

test("a code used twice ends the sign-in: the second is invalid_grant, logged, and every token issued from it is refused", async () => {
  const w = makeSigninWorld();
  const pat = people(w, ["lima"]);
  const s = await signIn(w, PUBLIC_APP, pat);
  const q = new URLSearchParams(s.query);
  let again;
  const lines = await logged(async () => { again = await token(w, { grant_type: "authorization_code", code: s.code, code_verifier: s.verifier, redirect_uri: q.get("redirect_uri"), resource: ADDRESS, client_id: PUBLIC_APP.client_id }); });
  assert.deepEqual(again.json, { error: "invalid_grant" });
  assert.deepEqual(lines.filter((l) => l.warn === "oauth.reuse"), [{ warn: "oauth.reuse", error: null, kind: "code" }]);
  assert.deepEqual(signins(w), [], "the sign-in is gone");
  assert.equal((await signin(w, s.access, toolCall("list_rooms"))).status, 401);
  assert.deepEqual((await refreshOf(w, PUBLIC_APP, s.refresh, { client_id: PUBLIC_APP.client_id })).json, { error: "invalid_grant" });
});

test("refresh: a rotation; three at once end with one pair; within the grace the same pair; after it a reuse that ends the sign-in; scope and resource", async () => {
  const w = makeSigninWorld();
  const pat = people(w, ["lima"]);
  const s = await signIn(w, PUBLIC_APP, pat);
  const auth = { client_id: PUBLIC_APP.client_id };
  const [a, b, c] = await Promise.all([refreshOf(w, PUBLIC_APP, s.refresh, auth), refreshOf(w, PUBLIC_APP, s.refresh, auth), refreshOf(w, PUBLIC_APP, s.refresh, auth)]);
  for (const x of [a, b, c]) assert.equal(x.status, 200, x.text);
  assert.equal(new Set([a, b, c].map((x) => x.json.refresh_token)).size, 1, "one pair");
  assert.equal(new Set([a, b, c].map((x) => x.json.access_token)).size, 1);
  assert.notEqual(a.json.refresh_token, s.refresh, "rotated");
  assert.ok(b.json.expires_in <= OAUTH_ACCESS_TTL_S && b.json.expires_in >= OAUTH_ACCESS_TTL_S - 5, "expires_in counted from the pair's issue");
  assert.equal((await signin(w, a.json.access_token, toolCall("list_rooms"))).status, 200, "the new access token works");
  // scope and resource
  assert.deepEqual((await refreshOf(w, PUBLIC_APP, a.json.refresh_token, auth, { scope: "admin" })).json, { error: "invalid_scope" });
  assert.deepEqual((await refreshOf(w, PUBLIC_APP, a.json.refresh_token, auth, { resource: "https://evil.example" })).json, { error: "invalid_target" });
  assert.equal((await refreshOf(w, PUBLIC_APP, a.json.refresh_token, auth, { scope: "rooms" })).status, 200, "scope rooms: a rotation");
  // past the grace: the first refresh token again is a reuse, which ends the sign-in
  const [id] = signins(w);
  w.harness(id).db.prepare("UPDATE aks SET used = used - ? WHERE used IS NOT NULL AND kind = 'refresh'").run((OAUTH_REFRESH_GRACE_S + 1) * 1000);
  let reuse;
  const lines = await logged(async () => { reuse = await refreshOf(w, PUBLIC_APP, s.refresh, auth); });
  assert.deepEqual(reuse.json, { error: "invalid_grant" });
  assert.deepEqual(lines.filter((l) => l.warn === "oauth.reuse"), [{ warn: "oauth.reuse", error: null, kind: "refresh" }]);
  assert.deepEqual(signins(w), [], "ended");
});

test("idle: a refresh after OAUTH_IDLE_DAYS without one ends the sign-in (invalid_grant, logged); its seats stay", async () => {
  const w = makeSigninWorld();
  const pat = people(w, ["lima"]);
  const s = await signIn(w, PUBLIC_APP, pat);
  const [id] = signins(w);
  w.harness(id).db.prepare("UPDATE aks SET created = created - ? WHERE kind = 'refresh'").run((OAUTH_IDLE_DAYS * 86400 + 60) * 1000);
  assert.equal((await signin(w, s.access, toolCall("list_rooms"))).status, 401, "an idle sign-in is no sign-in at its address either");
  let r;
  const lines = await logged(async () => { r = await refreshOf(w, PUBLIC_APP, s.refresh, { client_id: PUBLIC_APP.client_id }); });
  assert.deepEqual(r.json, { error: "invalid_grant" });
  assert.deepEqual(lines.filter((l) => l.warn === "oauth.idle_end"), [{ warn: "oauth.idle_end", error: null }]);
  assert.deepEqual(signins(w), []);
  assert.equal(w.harness("lima").one("SELECT revoked FROM inv WHERE name = 'Scout'").revoked, null, "the seat stays");
});

// ---- DPoP ----

test("DPoP: each of RFC 9449's checks, and crit and nbf, one failing at a time, is invalid_dpop_proof", async () => {
  const w = makeSigninWorld();
  const pat = people(w, ["lima"]);
  const s = await signIn(w, PUBLIC_APP, pat);
  const pair = await keyPair("ES256"), rsa = await keyPair("PS384");
  const t = nowS();
  const priv = await crypto.subtle.exportKey("jwk", (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"])).privateKey);
  const cases = [
    ["two DPoP headers", async () => (await dpopProof(pair)) + ", " + (await dpopProof(pair))],
    ["not a JWT", async () => "not-a-jwt"],
    ["no jti", async () => dpopProof(pair, { jti: undefined })],
    ["a short jti", async () => dpopProof(pair, { jti: "abc" })],
    ["no htm", async () => dpopProof(pair, { htm: undefined })],
    ["no htu", async () => dpopProof(pair, { htu: undefined })],
    ["no iat", async () => dpopProof(pair, { iat: undefined })],
    ["typ JWT", async () => dpopProof(pair, {}, { typ: "JWT" })],
    ["crit", async () => dpopProof(pair, {}, { crit: ["x"] })],
    ["nbf ahead", async () => dpopProof(pair, { nbf: t + 120 })],
    ["alg none", async () => { const p = await dpopProof(pair, {}, { alg: "none" }); return p; }],
    ["alg HS256", async () => dpopProof(pair, {}, { alg: "HS256" })],
    ["a signature by another key", async () => dpopProof(pair, {}, { jwk: (await keyPair("ES256")).jwk })],
    ["a private key in jwk", async () => dpopProof(pair, {}, { jwk: { ...pair.jwk, d: priv.d } })],
    ["no jwk", async () => dpopProof(pair, {}, { jwk: undefined })],
    ["htm GET", async () => dpopProof(pair, { htm: "GET" })],
    ["htu another endpoint", async () => dpopProof(pair, { htu: ORIGIN + "/api/oauth/revoke" })],
    ["htu another host", async () => dpopProof(pair, { htu: "https://evil.example/api/oauth/token" })],
    ["iat too old", async () => dpopProof(pair, { iat: t - 120 })],
    ["iat ahead", async () => dpopProof(pair, { iat: t + 120 })],
    ["a DER signature", async () => dpopProof(pair, {}, {}, { der: true })],
    ["PS384 salt 32", async () => dpopProof(rsa, {}, {}, { saltLength: 32 })],
  ];
  for (const [what, make] of cases) {
    const r = await refreshOf(w, PUBLIC_APP, s.refresh, { client_id: PUBLIC_APP.client_id }, {}, { DPoP: await make() });
    assert.deepEqual([r.status, r.json], [400, { error: "invalid_dpop_proof" }], what);
  }
  // a replayed proof
  const once = await dpopProof(pair);
  const first = await refreshOf(w, PUBLIC_APP, s.refresh, { client_id: PUBLIC_APP.client_id }, {}, { DPoP: once });
  assert.equal(first.status, 200, first.text);
  const replay = await refreshOf(w, PUBLIC_APP, first.json.refresh_token, { client_id: PUBLIC_APP.client_id }, {}, { DPoP: once });
  assert.deepEqual(replay.json, { error: "invalid_dpop_proof" }, "a proof's jti once");
  // accepted: htu with a query and an upper-case host, PS384 salt 48
  assert.equal((await refreshOf(w, PUBLIC_APP, first.json.refresh_token, { client_id: PUBLIC_APP.client_id }, {}, { DPoP: await dpopProof(pair, { htu: "HTTP://LOCALHOST/api/oauth/token?x=1" }) })).status, 200);
});

test("DPoP: a family bound at its code exchange (public and poppy); a bound family's refresh without a proof or with another key's is invalid_grant and ends nothing", async () => {
  for (const kind of ["public", "poppy"]) {
    const P = await poppyApp();
    const app = kind === "public" ? PUBLIC_APP : P.app;
    const w = makeSigninWorld([app]);
    const pat = people(w, ["lima"]);
    const key = await keyPair("ES256");
    const s = await signIn(w, app, pat, { pair: P.es, proof: key });
    assert.equal(s.token.status, 200, kind + ": " + s.token.text);
    const auth = async () => clientAuth(app, P.es);
    assert.deepEqual((await refreshOf(w, app, s.refresh, await auth())).json, { error: "invalid_grant" }, kind + ": no proof");
    assert.deepEqual((await refreshOf(w, app, s.refresh, await auth(), {}, { DPoP: await dpopProof(await keyPair("ES256")) })).json, { error: "invalid_grant" }, kind + ": another key");
    const r = await refreshOf(w, app, s.refresh, await auth(), {}, { DPoP: await dpopProof(key) });
    assert.equal(r.status, 200, kind + ": the bound key: " + r.text);
    assert.equal(r.json.token_type, "Bearer", "access tokens stay Bearer");
    assert.deepEqual((await refreshOf(w, app, r.json.refresh_token, await auth())).json, { error: "invalid_grant" }, kind + ": the binding carried to the new refresh token");
  }
});

test("DPoP: a public app's unbound family is bound by its first refresh with a proof; a poppy app's is not", async () => {
  // public
  {
    const w = makeSigninWorld();
    const pat = people(w, ["lima"]);
    const s = await signIn(w, PUBLIC_APP, pat);
    const key = await keyPair("ES256");
    const r = await refreshOf(w, PUBLIC_APP, s.refresh, { client_id: PUBLIC_APP.client_id }, {}, { DPoP: await dpopProof(key) });
    assert.equal(r.status, 200);
    assert.deepEqual((await refreshOf(w, PUBLIC_APP, r.json.refresh_token, { client_id: PUBLIC_APP.client_id })).json, { error: "invalid_grant" }, "bound: none is refused");
    assert.deepEqual((await refreshOf(w, PUBLIC_APP, r.json.refresh_token, { client_id: PUBLIC_APP.client_id }, {}, { DPoP: await dpopProof(await keyPair("ES256")) })).json, { error: "invalid_grant" }, "bound: another key is refused");
    assert.equal((await refreshOf(w, PUBLIC_APP, r.json.refresh_token, { client_id: PUBLIC_APP.client_id }, {}, { DPoP: await dpopProof(key) })).status, 200);
  }
  // poppy
  {
    const P = await poppyApp();
    const w = makeSigninWorld([P.app]);
    const pat = people(w, ["lima"]);
    const s = await signIn(w, P.app, pat, { pair: P.es });
    const r = await refreshOf(w, P.app, s.refresh, await clientAuth(P.app, P.es), {}, { DPoP: await dpopProof(await keyPair("ES256")) });
    assert.equal(r.status, 200);
    assert.equal((await refreshOf(w, P.app, r.json.refresh_token, await clientAuth(P.app, P.es))).status, 200, "a poppy family stays unbound: a later refresh without a proof works");
  }
});

test("DPoP: a grace repeat on a bound family gets the same pair only to a proof of the bound key; another key's, or none, is invalid_grant and ends nothing", async () => {
  for (const bound of ["at the code exchange", "at its first refresh"]) {
    const w = makeSigninWorld();
    const pat = people(w, ["lima"]);
    const key = await keyPair("ES256");
    const s = await signIn(w, PUBLIC_APP, pat, bound === "at the code exchange" ? { proof: key } : {});
    const auth = { client_id: PUBLIC_APP.client_id };
    const first = await refreshOf(w, PUBLIC_APP, s.refresh, auth, {}, { DPoP: await dpopProof(key) });
    assert.equal(first.status, 200, bound);
    const same = await refreshOf(w, PUBLIC_APP, s.refresh, auth, {}, { DPoP: await dpopProof(key) });
    assert.deepEqual([same.status, same.json.refresh_token], [200, first.json.refresh_token], bound + ": the same key, the same pair");
    assert.deepEqual((await refreshOf(w, PUBLIC_APP, s.refresh, auth, {}, { DPoP: await dpopProof(await keyPair("ES256")) })).json, { error: "invalid_grant" }, bound + ": another key");
    assert.deepEqual((await refreshOf(w, PUBLIC_APP, s.refresh, auth)).json, { error: "invalid_grant" }, bound + ": none");
    assert.equal(signins(w).length, 1, bound + ": nothing ended");
    assert.equal((await signin(w, first.json.access_token, toolCall("list_rooms"))).status, 200);
  }
});

test("DPoP: dpop_jkt binds the code to that key (another key's proof, or none, is invalid_grant); dpop_always refuses a request with no proof; a client that never sends one signs in", async () => {
  const { jwkThumbprint } = await import("../../worker/lib/oauth.ts");
  const key = await keyPair("ES256");
  const jkt = await jwkThumbprint(key.jwk);
  for (const [what, proof, ok] of [["the key", key, true], ["another key", await keyPair("ES256"), false], ["none", null, false]]) {
    const w = makeSigninWorld();
    const pat = people(w, ["lima"]);
    const s = await signIn(w, PUBLIC_APP, pat, { extra: { dpop_jkt: jkt }, ...(proof ? { proof } : {}) });
    assert.equal(s.token.status, ok ? 200 : 400, what + ": " + s.token.text);
    if (!ok) assert.deepEqual(s.token.json, { error: "invalid_grant" }, what);
  }
  const always = { ...PUBLIC_APP, key: "always", client_id: "https://always.example/c", dpop_always: true };
  const w = makeSigninWorld([always]);
  const pat = people(w, ["lima"]);
  const s = await signIn(w, always, pat);
  assert.deepEqual([s.token.status, s.token.json], [400, { error: "invalid_dpop_proof" }], "dpop_always: no proof refused");
  assert.equal((await signIn(w, always, pat, { proof: key, name: "Two" })).token.status, 200, "with one, it signs in");
  const w2 = makeSigninWorld();
  const s2 = await signIn(w2, PUBLIC_APP, people(w2, ["lima"]));
  assert.equal(s2.token.status, 200, "no proof ever: signs in");
  assert.equal((await refreshOf(w2, PUBLIC_APP, s2.refresh, { client_id: PUBLIC_APP.client_id })).status, 200);
  assert.ok(jws);
});

test("the counts-only line of a watched app: what it sent, names and booleans only", async () => {
  const watched = { ...PUBLIC_APP, key: "watched", client_id: "https://watched.example/c", watch: true };
  const w = makeSigninWorld([watched]);
  const pat = people(w, ["lima"]);
  const lines = await logged(async () => { await signIn(w, watched, pat, { proof: await keyPair("ES256") }); });
  const watch = lines.filter((l) => l.warn === "oauth.token_watch");
  assert.deepEqual(watch, [{ warn: "oauth.token_watch", error: null, app: "watched", grant_type: "authorization_code", alg: null, has_kid: false, has_client_id: true, has_resource: true, has_dpop: true }]);
  for (const l of lines) assert.ok(!JSON.stringify(l).includes(watched.client_id) && !/\.o[ca]1\.|\.ar1\./.test(JSON.stringify(l)), "no client_id value, no token: " + JSON.stringify(l));
});
