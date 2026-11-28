// POST /api/oauth/token (worker/routes/oauth.ts tokenRoute): its checks in
// order; every refusal of a client assertion (RFC 7523, Poppy 4.1); a key
// set's keys, fetched per isolate and data centre; the failed-authentication
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
  PUBLIC_APP, ORIGIN, ADDRESS, signins, signin, toolCall, revoke,
} from "./signin-world.mjs";
import { OAUTH_ACCESS_TTL_S, OAUTH_AUTH_FAILS_PER_IP, OAUTH_CLIENT_PREFIX, OAUTH_CODE_TTL_S, OAUTH_FETCH_TIMEOUT_MS, OAUTH_IDLE_DAYS, OAUTH_KEYSET_MAX_BYTES, OAUTH_KEYSET_REFETCH_S, OAUTH_KEYSET_TTL_MAX_S, OAUTH_KEYSET_TTL_MIN_S, OAUTH_QUOTA_ROOM, OAUTH_REFRESH_GRACE_S } from "../../worker/limits.ts";
import { KNOWN_APPS, forgetKeySets, jwkThumbprint } from "../../worker/lib/oauth.ts";
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
/** Authorization: Basic for id and password, each form-encoded first (RFC 6749 2.3.1) */
const basic = (id, password) => "Basic " + Buffer.from(encodeURIComponent(id) + ":" + encodeURIComponent(password)).toString("base64");
/** f run with the clock (Date.now) moved ms ahead, as every object and route reads it */
async function later(ms, f) {
  const real = Date.now;
  Date.now = () => real() + ms;
  try { return await f(); } finally { Date.now = real; }
}

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
  // a public client's good request that also names it in Authorization: Basic, with no password, is answered as if it had none
  const s2 = await signIn(w, PUBLIC_APP, pat, { name: "Scout2" });
  const r = await refreshOf(w, PUBLIC_APP, s2.refresh, { client_id: PUBLIC_APP.client_id }, {}, { Authorization: basic(PUBLIC_APP.client_id, "") });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.headers.get("WWW-Authenticate"), null);
});

test("the order of the checks: the method, the form, the client (before any proof), the proof, the client's authentication (the app's failed-check limit just before its assertion's check), the proof's verdict, then the grant", async () => {
  const c = await poppyCode();
  const w = c.w;
  // a method other than POST
  const { read } = await import("./agent-world.mjs");
  const { tokenRoute } = await import("../../worker/routes/oauth.ts");
  const get = await read(tokenRoute(w.rc("GET", "/api/oauth/token")));
  assert.deepEqual([get.status, get.headers.get("Allow")], [405, "POST"]);
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
  // no grant named: a missing parameter (RFC 6749 5.2)
  r = await token(w, { ...(await asserted(c, c.es)) });
  assert.deepEqual([r.status, r.json.error], [400, "invalid_request"]);
  // a parameter sent twice (one of them empty included: the duplicate check reads the form as sent), and a body too large
  r = await token(w, { grant_type: ["authorization_code", "authorization_code"], ...(await asserted(c, c.es)) });
  assert.deepEqual([r.status, r.json.error], [400, "invalid_request"]);
  r = await token(w, { grant_type: "authorization_code", code: ["", c.code], code_verifier: c.verifier, redirect_uri: c.redirect, resource: ADDRESS, ...(await asserted(c, c.es)) });
  assert.deepEqual([r.status, r.json.error], [400, "invalid_request"], "code=&code=X");
  r = await token(w, { grant_type: "authorization_code", pad: "x".repeat(9000) });
  assert.deepEqual([r.status, r.json.error], [413, "invalid_request"]);
  // the limit, full, stops a signed assertion's check: a good one is 429, before its proof's verdict and its grant
  w.harness(OAUTH_QUOTA_ROOM).room.setTestAgentLimits({ per_ip: 1 });
  const net = { "CF-Connecting-IP": "10.50.0.1" };
  r = await token(w, { grant_type: "authorization_code", ...(await asserted(c, await keyPair("ES256", c.es.jwk.kid))) }, net);
  assert.equal(r.status, 401, "the one failed check the counter takes");
  r = await token(w, { client_id: "https://nobody.example/c", grant_type: "authorization_code" }, net);
  assert.deepEqual([r.status, r.json.error], [401, "invalid_client"], "an unknown client is never refused by the counter");
  r = await token(w, { grant_type: "nope", ...(await asserted(c, c.es)) }, { DPoP: "bad", ...net });
  assert.deepEqual([r.status, r.json.error], [429, "slow_down"], "before the proof's verdict and the grant");
  r = await exchange(c, await asserted(c, c.es), {}, net);
  assert.deepEqual([r.status, r.json], [429, { error: "slow_down", error_description: "Too many failed attempts for this app from this network; try again later." }]);
  assert.ok(Number(r.headers.get("Retry-After")) > 0);
  assert.equal(r.headers.get("Pragma"), "no-cache");
  w.harness(OAUTH_QUOTA_ROOM).room.setTestAgentLimits(null);
  assert.equal((await exchange(c, await asserted(c, c.es), {}, net)).status, 200, "the limit cleared, the same code redeems");
});

// The failed-authentication limit is one app's on one network, and only the
// work it exists for fills it: a signature that was checked and matched no
// key. The counter is read once, just before the first costly step (a
// key-set fetch the request would start, or its first signature check): a
// request naming no known app, a public app's failure, no assertion, a
// malformed one, claims that fail as presented, and a kid no key matches
// when no fetch may start never ask it (the quota object's agentPeek and
// agentReserve; under TEST_HOOKS the stand-in apps are also read from that
// object, oauthTestApps, which live has no call for); a replay whose
// signature matched reads it once and takes no place.
test("the failed-authentication limit is one app's on one network, filled only by a signature that matched no key: OAUTH_AUTH_FAILS_PER_IP of each other failure take no place (those with no costly step never ask the counter, a replay reads it once), and a fresh good assertion is taken after each batch; as many bad signatures for app X refuse X there (429 slow_down with Retry-After), and not another app or another network", async () => {
  const X = await poppyApp();
  const yKey = await keyPair("ES256", "y-1");
  const Y = { ...X.app, key: "standin-poppy-y", client_id: "https://agent-y.example/.well-known/poppy-client", name: "Muse Y", jwks: { keys: [yKey.jwk] } };
  const w = makeSigninWorld([PUBLIC_APP, X.app, Y]);
  const pat = people(w, ["lima"]);
  const calls = (m) => w.asked.filter((a) => a.name === OAUTH_QUOTA_ROOM && a.method === m).length;
  const sx = await signIn(w, X.app, pat, { pair: X.es });
  assert.equal(sx.token.status, 200, sx.token.text);
  let rt = sx.refresh;
  const N = "10.70.0.1", at = (ip) => ({ "CF-Connecting-IP": ip });
  /** X's good refresh (a fresh assertion) from a network: its answer, and the next refresh token kept */
  const good = async (ip) => {
    const r = await refreshOf(w, X.app, rt, await clientAuth(X.app, X.es), {}, at(ip));
    if (r.status === 200) rt = r.json.refresh_token;
    return r;
  };
  const send = async (fields) => token(w, { grant_type: "refresh_token", refresh_token: ".ar1.x", ...fields }, at(N));
  const signed = async (pair, claims) => send({ client_assertion_type: URN, client_assertion: await assertion(X.app, pair, claims) });
  const replayed = { client_assertion_type: URN, client_assertion: await assertion(X.app, X.es) };
  assert.equal((await send(replayed)).json.error, "invalid_grant", "the assertion to replay, taken once");
  const realVerify = crypto.subtle.verify;
  let verifies = 0;
  crypto.subtle.verify = async (...a) => { verifies++; return realVerify.apply(crypto.subtle, a); };
  try {
    // [what, the request, counter reads per request, signatures checked per request]
    const batches = [
      ["a request naming no known app", () => token(w, { client_id: "https://nobody.example/c", grant_type: "refresh_token" }, at(N)), 0, 0],
      ["a public app sending a client_secret", () => refreshOf(w, PUBLIC_APP, ".ar1.x", { client_id: PUBLIC_APP.client_id, client_secret: "s" }, {}, at(N)), 0, 0],
      ["a request naming X with no assertion", () => send({ client_id: X.app.client_id }), 0, 0],
      ["a malformed assertion", () => send({ client_id: X.app.client_id, client_assertion_type: URN, client_assertion: "not.an.assertion" }), 0, 0],
      ["a good signature with an expired exp", () => signed(X.es, { iat: nowS() - 400, exp: nowS() - 120 }), 0, 0],
      ["a good signature with another aud", () => signed(X.es, { aud: "https://elsewhere.example" }), 0, 0],
      ["a kid X's set lacks, no fetch possible (its keys inline)", async () => signed(await keyPair("ES256", "es-9")), 0, 0],
      ["a replay of one good assertion", () => send(replayed), 1, 1],
    ];
    for (const [what, f, reads, sigs] of batches) {
      const peeks = calls("agentPeek"), places = calls("agentReserve");
      verifies = 0;
      for (let i = 0; i < OAUTH_AUTH_FAILS_PER_IP; i++) {
        const r = await f();
        assert.deepEqual([r.status, r.json], [401, { error: "invalid_client" }], what);
      }
      assert.deepEqual([calls("agentPeek") - peeks, calls("agentReserve") - places, verifies], [reads * OAUTH_AUTH_FAILS_PER_IP, 0, sigs * OAUTH_AUTH_FAILS_PER_IP], what + ": counter reads, places taken, signatures checked");
      const r = await good(N);
      assert.equal(r.status, 200, what + ": then X's fresh good assertion from that network is taken: " + r.text);
    }
  } finally {
    crypto.subtle.verify = realVerify;
  }
  // as many assertions for X whose signature fails (a key of X's kid that X does not hold): each takes a place
  const wrong = await keyPair("ES256", X.es.jwk.kid);
  const places = calls("agentReserve");
  for (let i = 0; i < OAUTH_AUTH_FAILS_PER_IP; i++) assert.equal((await refreshOf(w, X.app, rt, await clientAuth(X.app, wrong), {}, at(N))).status, 401);
  assert.equal(calls("agentReserve") - places, OAUTH_AUTH_FAILS_PER_IP);
  const r = await good(N);
  assert.deepEqual([r.status, r.json], [429, { error: "slow_down", error_description: "Too many failed attempts for this app from this network; try again later." }], "X from that network: refused before its check");
  assert.ok(Number(r.headers.get("Retry-After")) > 0);
  const sy = await signIn(w, Y, pat, { pair: yKey, name: "Scout Y" });
  assert.equal(sy.token.status, 200, "another app's sign-in: taken");
  const y = await refreshOf(w, Y, sy.refresh, await clientAuth(Y, yKey), {}, at(N));
  assert.equal(y.status, 200, "another app from the same network: taken: " + y.text);
  assert.equal((await good("10.71.0.1")).status, 200, "X from another network: taken");
});

// The claims are judged as the assertion presents them, before any key or
// signature: each failing claim with a good signature costs no signature
// check, no key-set fetch and no call to the counter.
test("an assertion's claims are judged before any key or signature: each failing claim with a good signature is 401, with no signature checked, no key set fetched and no counter call", async () => {
  const real = globalThis.fetch, realVerify = crypto.subtle.verify;
  let fetches = 0, verifies = 0;
  try {
    forgetKeySets();
    const c = await poppyCode({ app: { key: "remote-claims", client_id: "https://remote.example/claims", jwks: undefined, jwks_uri: "http://127.0.0.1:9/claims.json" } });
    globalThis.fetch = async () => { fetches++; return new Response(JSON.stringify({ keys: [c.es.jwk] }), { status: 200, headers: { "Cache-Control": "max-age=600" } }); };
    const counterCalls = () => c.w.asked.filter((a) => a.name === OAUTH_QUOTA_ROOM && (a.method === "agentPeek" || a.method === "agentReserve")).length;
    crypto.subtle.verify = async (...a) => { verifies++; return realVerify.apply(crypto.subtle, a); };
    const before = counterCalls();
    for (const [what, claims] of [
      ["iss", { iss: "https://other.example/c" }], ["sub", { sub: "https://other.example/c" }], ["aud", { aud: ORIGIN + "/api/oauth/token" }],
      ["exp past", { iat: nowS() - 400, exp: nowS() - 120 }], ["iat ahead", { iat: nowS() + 600, exp: nowS() + 700 }], ["nbf ahead", { nbf: nowS() + 600 }],
      ["exp - iat too long", { iat: nowS(), exp: nowS() + 3600 }], ["a short jti", { jti: "short" }],
    ]) {
      const r = await exchange(c, await asserted(c, c.es, claims), { code: "x" });
      assert.deepEqual([r.status, r.json], [401, { error: "invalid_client" }], what);
    }
    assert.deepEqual([verifies, fetches, counterCalls() - before], [0, 0, 0], "no signature checked, no key set fetched, no counter call");
  } finally {
    globalThis.fetch = real;
    crypto.subtle.verify = realVerify;
    forgetKeySets();
  }
});

// The limit stops the work it is for: with X's counter full, X's assertion
// is refused before any signature is verified and before any key-set fetch.
test("with an app's counter full, its assertion is refused before any signature is verified or any key set fetched", async () => {
  const real = globalThis.fetch, realVerify = crypto.subtle.verify;
  let fetches = 0, verifies = 0;
  try {
    const c = await poppyCode({ app: { key: "remote-full", client_id: "https://remote.example/full", jwks: undefined, jwks_uri: "http://127.0.0.1:9/full.json" } });
    globalThis.fetch = async () => { fetches++; return new Response(JSON.stringify({ keys: [c.es.jwk] }), { status: 200, headers: { "Cache-Control": "max-age=600" } }); };
    forgetKeySets();
    c.w.harness(OAUTH_QUOTA_ROOM).room.setTestAgentLimits({ per_ip: 1 });
    assert.equal((await exchange(c, await asserted(c, await keyPair("ES256", c.es.jwk.kid)))).status, 401, "one failed check fills it");
    forgetKeySets();
    fetches = 0;
    crypto.subtle.verify = async (...a) => { verifies++; return realVerify.apply(crypto.subtle, a); };
    const r = await exchange(c, await asserted(c, c.es));
    assert.deepEqual([r.status, r.json.error], [429, "slow_down"]);
    assert.deepEqual([verifies, fetches], [0, 0], "no signature verified, no key set fetched");
  } finally {
    globalThis.fetch = real;
    crypto.subtle.verify = realVerify;
    forgetKeySets();
  }
});

// A request that names no known app is refused before its DPoP proof is
// looked at: no signature is verified for it.
test("an unknown client with a DPoP proof: 401 invalid_client, and no signature verified", async () => {
  const w = makeSigninWorld();
  const pair = await keyPair("PS384", "p");
  const proof = await dpopProof(pair);
  const realVerify = crypto.subtle.verify;
  let verifies = 0;
  crypto.subtle.verify = async (...a) => { verifies++; return realVerify.apply(crypto.subtle, a); };
  try {
    const r = await token(w, { client_id: "https://nobody.example/c", grant_type: "refresh_token", refresh_token: ".ar1.x" }, { DPoP: proof });
    assert.deepEqual([r.status, r.json], [401, { error: "invalid_client" }]);
    assert.equal(verifies, 0, "the proof was not checked");
  } finally {
    crypto.subtle.verify = realVerify;
  }
});

test("a parameter sent without a value is treated as omitted (RFC 6749 3.1): an empty scope at a refresh, an empty resource at the exchange, an empty client_secret from a public client, which is no failure either", async () => {
  const P = await poppyApp();
  const w = makeSigninWorld([PUBLIC_APP, P.app]);
  const pat = people(w, ["lima"]);
  const s = await signIn(w, PUBLIC_APP, pat, { resource: null, tokenResource: "" });
  assert.equal(s.token.status, 200, "resource= at the exchange is no resource: the default token, for a request that named none: " + s.token.text);
  let r = await refreshOf(w, PUBLIC_APP, s.refresh, { client_id: PUBLIC_APP.client_id }, { scope: "", resource: null });
  assert.equal(r.status, 200, "scope= is no scope: " + r.text);
  for (let i = 0; i <= OAUTH_AUTH_FAILS_PER_IP; i++) {
    r = await refreshOf(w, PUBLIC_APP, r.json.refresh_token, { client_id: PUBLIC_APP.client_id, client_secret: "" }, { resource: null });
    assert.equal(r.status, 200, "client_secret= is no secret: " + r.text);
  }
  const a = await token(w, { grant_type: "refresh_token", refresh_token: ".ar1.x", ...(await clientAuth(P.app, P.es)) });
  assert.deepEqual([a.status, a.json.error], [400, "invalid_grant"], "none of those counted as a failure: an assertion from that network is still checked");
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

// ---- Key sets (worker/lib/oauth.ts keysFor): per isolate and jwks_uri, the
// set, the fetch in flight and the last try; the data centre's Cache API copy
// with when it was fetched; nothing shared that a caller could hold, and no
// object called. A stand-in for the app's key-set host replaces fetch, and
// one for caches.default plays the data centre, on the test's clock.

/** caches.default for one data centre, on the test's clock (Date.now): a copy lives its max-age. */
function dataCentre() {
  const store = new Map();
  const had = "caches" in globalThis, real = globalThis.caches;
  globalThis.caches = {
    default: {
      async match(req) {
        const e = store.get(req.url);
        return e && e.expires > Date.now() ? new Response(e.text, { headers: e.headers }) : undefined;
      },
      async put(req, res) {
        const m = /max-age=(\d+)/.exec(res.headers.get("Cache-Control") || "");
        store.set(req.url, { text: await res.text(), headers: Object.fromEntries(res.headers), expires: Date.now() + (m ? Number(m[1]) : 0) * 1000 });
      },
    },
  };
  /** a copy put there by another isolate of the data centre */
  const put = (uri, set, fetchedAt, until) => store.set(uri, { text: JSON.stringify(set), headers: { "x-fetched-at": String(fetchedAt), "x-kept-until": String(until) }, expires: until });
  return { store, put, restore: () => { if (had) globalThis.caches = real; else delete globalThis.caches; } };
}
/** fetch replaced by the key-set host: answer(url) gives a Response (or a promise of one, or throws); every fetch counted */
function keyHost(answer) {
  const real = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, init) => { seen.push(String(url)); return answer(String(url), init); };
  return { count: (part) => seen.filter((u) => !part || u.includes(part)).length, restore: () => { globalThis.fetch = real; } };
}
const setOf = (...pairs) => ({ keys: pairs.map((p) => p.jwk) });
const served = (set, maxAge) => new Response(JSON.stringify(set), { status: 200, headers: { "Cache-Control": "max-age=" + maxAge } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** poppy stand-ins whose key sets are at addresses, one per name, in one world */
async function remoteApps(...names) {
  const apps = [];
  for (const n of names) apps.push(await poppyApp({ key: "keys-" + n, client_id: "https://remote.example/" + n, jwks: undefined, jwks_uri: "http://127.0.0.1:9/" + n + ".json" }));
  return { w: makeSigninWorld(apps.map((a) => a.app)), apps };
}
/** a token request with an assertion of app's signed by pair (a refresh of no token: authenticated, it is invalid_grant) */
const tryKey = async (w, app, pair, headers) => token(w, { grant_type: "refresh_token", refresh_token: ".ar1.x", client_assertion_type: URN, client_assertion: await assertion(app, pair) }, headers);
const taken = (r) => r.status === 400 && r.json.error === "invalid_grant";
const refused = (r) => r.status === 401 && r.json.error === "invalid_client";
/** the quota object's counter read made to take ms, as a call to another object does */
function slowCounter(w, ms) {
  const room = w.harness(OAUTH_QUOTA_ROOM).room, read = room.agentPeek;
  room.agentPeek = async (...args) => { await sleep(ms); return read.apply(room, args); };
}
/** what a fetch rejects with when the host refuses the connection or it breaks off */
const lost = () => new TypeError("Network connection lost.");
/** an answer that comes after ms, unless the fetch's signal aborts it first */
const answerAfter = (init, ms, res) => new Promise((ok, no) => {
  const t = setTimeout(() => ok(res()), ms);
  init.signal.addEventListener("abort", () => { clearTimeout(t); no(init.signal.reason); });
});
/** runs f with a data centre, a key-set host and an isolate of its own, all put back after */
async function withKeys(answer, f) {
  forgetKeySets();
  const dc = dataCentre(), host = keyHost(answer);
  try { return await f(host, dc); } finally { host.restore(); dc.restore(); forgetKeySets(); }
}

test("an inline set's key without a kid is skipped and logged once", async () => {
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
});

test("a burst of assertions on an isolate holding no set, the counter's read taking as long as a call to another object, makes one fetch, and every one is taken; the same once the set's time is up; the fetch asks for the set with no redirect followed and no credentials field", async () => {
  const { w, apps: [A] } = await remoteApps("burst");
  slowCounter(w, 20); // so the requests overlap while they wait for the read
  const inits = [];
  await withKeys(async (url, init) => { inits.push([init.redirect, "credentials" in init]); await sleep(50); return served(setOf(A.es), OAUTH_KEYSET_TTL_MIN_S); }, async (host) => {
    const first = await Promise.all(Array.from({ length: 25 }, () => tryKey(w, A.app, A.es)));
    assert.deepEqual([first.filter(taken).length, host.count()], [25, 1], "one fetch for 25 at once, all taken");
    assert.deepEqual(inits[0], ["manual", false], "no redirect followed, and no credentials field (a Worker's fetch sends no cookie)");
    await later((OAUTH_KEYSET_TTL_MIN_S + 1) * 1000, async () => {
      const again = await Promise.all(Array.from({ length: 25 }, () => tryKey(w, A.app, A.es)));
      assert.deepEqual([again.filter(taken).length, host.count()], [25, 2], "the set's time up: one fetch for 25 at once, all taken");
    });
  });
});

test("an isolate holding no set, whose own fetch lacks the assertion's kid: one fetch, refused, and no second fetch within OAUTH_KEYSET_REFETCH_S", async () => {
  const { w, apps: [A] } = await remoteApps("lacking");
  const other = await keyPair("ES256", "es-9");
  await withKeys(async () => served(setOf(A.es), 600), async (host) => {
    assert.ok(refused(await tryKey(w, A.app, other)));
    assert.equal(host.count(), 1, "one fetch");
    assert.ok(refused(await tryKey(w, A.app, other)));
    assert.equal(host.count(), 1, "no second fetch within the window");
  });
});

test("one app's failed fetch does not hold back another's: B's set, its time up, is fetched and B taken just after A's host failed", async () => {
  const { w, apps: [A, B] } = await remoteApps("down", "up");
  await withKeys(async (url) => (url.includes("/down.json") ? new Response("down", { status: 503 }) : served(setOf(B.es), OAUTH_KEYSET_TTL_MIN_S)), async (host) => {
    assert.ok(taken(await tryKey(w, B.app, B.es)));
    await later((OAUTH_KEYSET_TTL_MIN_S + 1) * 1000, async () => {
      assert.ok(refused(await tryKey(w, A.app, A.es)), "A's host failed, A had no set");
      assert.ok(taken(await tryKey(w, B.app, B.es)), "B fetched and taken");
      assert.deepEqual([host.count("/down.json"), host.count("/up.json")], [1, 2]);
    });
  });
});

test("200 assertions naming kids the set lacks, within one window, requests one after another: one fetch, one read of the counter and no other call to the quota object, none to the app's store, no place", async () => {
  const { w, apps: [A] } = await remoteApps("stream");
  const quota = (m) => w.asked.filter((a) => a.name === OAUTH_QUOTA_ROOM && a.method === m).length;
  const store = () => w.asked.filter((a) => a.name.startsWith(OAUTH_CLIENT_PREFIX)).length;
  await withKeys(async () => served(setOf(A.es), 600), async (host) => {
    const peeks = quota("agentPeek"), places = quota("agentReserve"), calls = store();
    for (let i = 0; i < 200; i++) assert.ok(refused(await tryKey(w, A.app, await keyPair("ES256", "unknown-" + i))), "kid " + i);
    assert.deepEqual([host.count(), quota("agentPeek") - peeks, quota("agentReserve") - places, store() - calls], [1, 1, 0, 0], "fetches, counter reads, places, store calls");
  });
});

test("the data centre's copy: fetched OAUTH_KEYSET_REFETCH_S ago or less and lacking the kid, no fetch and refused; older than that, one fetch and taken; a live copy fetched later than this isolate's is adopted, with no fetch", async () => {
  const { w, apps: [A] } = await remoteApps("dc");
  const k2 = await keyPair("ES256", "es-2"), k3 = await keyPair("ES256", "es-3");
  await withKeys(async () => served(setOf(A.es, k2), 600), async (host, dc) => {
    const uri = A.app.jwks_uri, t0 = Date.now();
    dc.put(uri, setOf(A.es), t0 - 10000, t0 + 50000);
    assert.ok(refused(await tryKey(w, A.app, k2)), "a copy fetched 10 s ago that lacks the kid");
    assert.ok(taken(await tryKey(w, A.app, A.es)), "the copy serves the keys it has");
    assert.equal(host.count(), 0, "no fetch");
    await later(21000, async () => {
      assert.ok(taken(await tryKey(w, A.app, k2)), "at 31 s: fetched, and taken");
      assert.equal(host.count(), 1);
    });
    await later(26000, async () => {
      dc.put(uri, setOf(A.es, k2, k3), Date.now(), Date.now() + 600000);
      assert.ok(taken(await tryKey(w, A.app, k3)), "a live copy fetched later than this isolate's: adopted");
      assert.equal(host.count(), 1, "no fetch");
    });
  });
});

test("an older data centre copy is not adopted over this isolate's newer set: a key the app removed, still listed in a live copy fetched before this isolate's set, is refused", async () => {
  const { w, apps: [A] } = await remoteApps("older");
  const gone = await keyPair("ES256", "es-gone");
  await withKeys(async () => served(setOf(A.es), 600), async (host, dc) => {
    assert.ok(taken(await tryKey(w, A.app, A.es)), "this isolate's set, fetched after the app removed es-gone");
    const t0 = Date.now();
    dc.put(A.app.jwks_uri, setOf(A.es, gone), t0 - 10000, t0 + 600000);
    assert.ok(refused(await tryKey(w, A.app, gone)), "the removed key, listed only in the older copy: refused");
    assert.equal(host.count(), 1, "no fetch");
  });
});

test("a key the app has just published is taken once OAUTH_KEYSET_REFETCH_S has passed since the last fetch, whatever kids others sent meanwhile", async () => {
  const { w, apps: [A] } = await remoteApps("publish");
  const fresh = await keyPair("ES256", "es-new");
  let set = setOf(A.es);
  await withKeys(async () => served(set, 600), async (host) => {
    assert.ok(taken(await tryKey(w, A.app, A.es)));
    for (const at of [1000, 10000, 29000]) await later(at, async () => { for (let i = 0; i < 5; i++) assert.ok(refused(await tryKey(w, A.app, await keyPair("ES256", "x-" + at + "-" + i)))); });
    assert.equal(host.count(), 1, "no fetch for the stream within the window");
    set = setOf(A.es, fresh);
    await later((OAUTH_KEYSET_REFETCH_S + 1) * 1000, async () => {
      assert.ok(refused(await tryKey(w, A.app, await keyPair("ES256", "x-late"))), "another unknown kid first");
      assert.ok(taken(await tryKey(w, A.app, fresh)), "the new key: taken");
      assert.equal(host.count(), 2);
    });
  });
});

test("the fetch is handed to the request's waitUntil: a requester that hangs up before it ends leaves a set the next request uses, with no further fetch; so does a first attempt cut off as its requester leaves, whose second attempt answers", async () => {
  for (const cut of [false, true]) {
    const { w, apps: [A] } = await remoteApps(cut ? "dropped-cut" : "dropped");
    let release = null;
    await withKeys(() => new Promise((ok, no) => { release = (off) => (off ? no(lost()) : ok(served(setOf(A.es), 600))); }), async (host) => {
      const before = w.pending.length;
      const dropped = tryKey(w, A.app, A.es);
      for (let i = 0; i < 200 && host.count() === 0; i++) await sleep(5);
      assert.equal(host.count(), 1, "the fetch started");
      assert.equal(w.pending.length, before + 1, "handed to waitUntil");
      if (cut) {
        release(true);
        for (let i = 0; i < 200 && host.count() === 1; i++) await sleep(5);
        assert.deepEqual([host.count(), w.pending.length - before], [2, 1], "cut off: fetched once more, in the same handed-over promise");
      }
      release(false);
      await Promise.all(w.pending);
      assert.ok(taken(await tryKey(w, A.app, A.es)), "the next request: the set the fetch left");
      assert.equal(host.count(), cut ? 2 : 1, "no further fetch");
      await dropped;
    });
  }
});

test("a fetch rejected for a reason other than the timeout is fetched once more, at once, within the same try: the second answering, its set is kept and taken, nothing is logged, and no other fetch within OAUTH_KEYSET_REFETCH_S", async () => {
  const { w, apps: [A] } = await remoteApps("refused-once");
  let calls = 0;
  const lines = await logged(() => withKeys(async () => { calls++; if (calls === 1) throw lost(); return served(setOf(A.es), 600); }, async (host) => {
    const before = w.pending.length;
    assert.ok(taken(await tryKey(w, A.app, A.es)), "taken with the second attempt's set");
    assert.deepEqual([host.count(), w.pending.length - before], [2, 1], "two fetches in one handed-over promise");
    assert.ok(refused(await tryKey(w, A.app, await keyPair("ES256", "es-9"))), "an unknown kid within the window");
    assert.ok(taken(await tryKey(w, A.app, A.es)), "the set kept");
    assert.equal(host.count(), 2, "one try: no other fetch within the window");
  }));
  assert.deepEqual(lines.filter((l) => l.warn === "oauth.keyset"), [], "not failed: nothing logged");
});

test("a first attempt whose body breaks off mid-stream is fetched once more, at once, within the same try: the second answering whole, its set is kept and taken, nothing is logged, and no other fetch within OAUTH_KEYSET_REFETCH_S", async () => {
  const { w, apps: [A] } = await remoteApps("broken-body");
  const whole = JSON.stringify(setOf(A.es));
  let calls = 0, broke = false;
  // a 200 answer whose body gives its first half, then breaks off before it is whole
  const breaking = () => new Response(new ReadableStream({
    start(c) { c.enqueue(new TextEncoder().encode(whole.slice(0, whole.length >> 1))); },
    pull(c) { broke = true; c.error(lost()); },
  }), { status: 200, headers: { "Cache-Control": "max-age=600" } });
  const lines = await logged(() => withKeys(async () => { calls++; return calls === 1 ? breaking() : served(setOf(A.es), 600); }, async (host) => {
    const before = w.pending.length;
    assert.ok(taken(await tryKey(w, A.app, A.es)), "taken with the second attempt's set");
    assert.ok(broke, "the first body broke off mid-stream");
    assert.deepEqual([host.count(), w.pending.length - before], [2, 1], "two fetches in one handed-over promise");
    assert.ok(refused(await tryKey(w, A.app, await keyPair("ES256", "es-9"))), "an unknown kid within the window");
    assert.ok(taken(await tryKey(w, A.app, A.es)), "the set kept");
    assert.equal(host.count(), 2, "one try: no other fetch within the window");
  }));
  assert.deepEqual(lines.filter((l) => l.warn === "oauth.keyset"), [], "not failed: nothing logged");
});

test("a first attempt the app's host failed (a status, a redirect, the size cap, a body that does not parse, the timeout) marks the try failed with no second: one fetch, the last set serves, logged with the status", async () => {
  const kinds = [
    ["status", () => new Response("down", { status: 503 }), 503],
    ["redirect", () => new Response(null, { status: 302, headers: { Location: "http://127.0.0.1:9/elsewhere.json" } }), 302],
    ["cap", () => new Response("x".repeat(OAUTH_KEYSET_MAX_BYTES + 1), { status: 200 }), 413],
    ["body", () => new Response("{\"keys\": [", { status: 200 }), 200],
    ["timeout", (init) => answerAfter(init, OAUTH_FETCH_TIMEOUT_MS * 2, () => served({ keys: [] }, 600)), 0],
  ];
  const { w, apps } = await remoteApps(...kinds.map(([k]) => "host-" + k));
  let down = false;
  const lines = await logged(() => withKeys(async (url, init) => {
    const i = apps.findIndex((a) => a.app.jwks_uri === url);
    return down ? kinds[i][1](init) : served(setOf(apps[i].es), OAUTH_KEYSET_TTL_MIN_S);
  }, async (host) => {
    for (const a of apps) assert.ok(taken(await tryKey(w, a.app, a.es)));
    down = true;
    await later((OAUTH_KEYSET_TTL_MIN_S + 1) * 1000, async () => {
      const rs = await Promise.all(apps.map((a) => tryKey(w, a.app, a.es)));
      kinds.forEach(([k], i) => {
        assert.ok(taken(rs[i]), k + ": failed, the last set serves");
        assert.equal(host.count(apps[i].app.jwks_uri), 2, k + ": no second attempt");
      });
    });
  }));
  const got = lines.filter((l) => l.warn === "oauth.keyset").map((l) => l.app + " " + JSON.stringify(l.status) + " " + JSON.stringify(l.cut)).sort();
  assert.deepEqual(got, kinds.map(([k, , st]) => "keys-host-" + k + " " + st + " undefined").sort());
});

test("both attempts of a try share one OAUTH_FETCH_TIMEOUT_MS: a slow rejection, then a slow answer past it, is failed by the timeout (the last set serves, logged with status 0), and the fetch in flight has ended within it", async () => {
  const { w, apps: [A] } = await remoteApps("slow");
  let slow = false, calls = 0, started = 0;
  const lines = await logged(() => withKeys((url, init) => {
    if (!slow) return served(setOf(A.es), OAUTH_KEYSET_TTL_MIN_S);
    calls++;
    if (calls === 1) { started = Date.now(); return sleep(OAUTH_FETCH_TIMEOUT_MS * 0.6).then(() => { throw lost(); }); }
    return answerAfter(init, OAUTH_FETCH_TIMEOUT_MS * 0.8, () => served(setOf(A.es), 600));
  }, async (host) => {
    assert.ok(taken(await tryKey(w, A.app, A.es)));
    slow = true;
    await later((OAUTH_KEYSET_TTL_MIN_S + 1) * 1000, async () => {
      const before = w.pending.length;
      const r = tryKey(w, A.app, A.es);
      for (let i = 0; i < 200 && w.pending.length === before; i++) await sleep(5);
      const ended = w.pending[before].then(() => Date.now());
      assert.ok(taken(await r), "failed by the timeout: the last set serves");
      assert.equal(host.count(), 3, "two attempts");
      // a timer fires a little after its time: a quarter of a second allowed
      assert.ok((await ended) - started < OAUTH_FETCH_TIMEOUT_MS + 250, "the fetch in flight ended within OAUTH_FETCH_TIMEOUT_MS");
    });
  }));
  assert.deepEqual(lines.filter((l) => l.warn === "oauth.keyset"), [{ warn: "oauth.keyset", error: null, app: "keys-slow", status: 0 }]);
});

test("a key the app removed stops working once its set's time is up: fetched again, the key refused, the new one taken", async () => {
  const { w, apps: [A] } = await remoteApps("removed");
  const k2 = await keyPair("ES256", "es-2");
  let set = setOf(A.es);
  await withKeys(async () => served(set, OAUTH_KEYSET_TTL_MIN_S), async (host) => {
    assert.ok(taken(await tryKey(w, A.app, A.es)));
    set = setOf(k2);
    assert.ok(taken(await tryKey(w, A.app, A.es)), "within the set's time: kept");
    await later((OAUTH_KEYSET_TTL_MIN_S + 1) * 1000, async () => {
      assert.ok(refused(await tryKey(w, A.app, A.es)), "its time up: fetched again, and the removed key refused");
      assert.ok(taken(await tryKey(w, A.app, k2)), "the new key taken");
      assert.equal(host.count(), 2, "one fetch");
    });
  });
});

test("failed fetches: the last set serves only after a try the host failed, by a status or by refusing the connection at both attempts, within its time plus OAUTH_KEYSET_TTL_MAX_S and not after; a failed try counts toward the window, with its two fetches when the first was rejected", async () => {
  const { w, apps: [A, C] } = await remoteApps("outage", "refusing");
  const both = [A, C];
  let down = false;
  await withKeys(async (url) => {
    if (!down) return served(setOf(url.includes("/refusing.json") ? C.es : A.es), OAUTH_KEYSET_TTL_MIN_S);
    if (url.includes("/refusing.json")) throw lost();
    return new Response("down", { status: 500 });
  }, async (host) => {
    const fetches = () => [host.count("/outage.json"), host.count("/refusing.json")];
    for (const X of both) assert.ok(taken(await tryKey(w, X.app, X.es)));
    down = true;
    const lines = await logged(() => later((OAUTH_KEYSET_TTL_MIN_S + 1) * 1000, async () => {
      for (const X of both) {
        assert.ok(taken(await tryKey(w, X.app, X.es)), X.app.key + ": a failed try: the last set, within its bound");
        assert.ok(taken(await tryKey(w, X.app, X.es)), X.app.key + ": again within the window");
      }
      assert.deepEqual(fetches(), [2, 3], "within the window of a failed try: one fetch, two when the first was rejected");
    }));
    assert.deepEqual(lines.filter((l) => l.warn === "oauth.keyset"), [
      { warn: "oauth.keyset", error: null, app: "keys-outage", status: 500 },
      { warn: "oauth.keyset", error: null, app: "keys-refusing", cut: true },
    ]);
    await later((OAUTH_KEYSET_TTL_MIN_S + OAUTH_KEYSET_REFETCH_S + 2) * 1000, async () => {
      for (const X of both) assert.ok(taken(await tryKey(w, X.app, X.es)), X.app.key + ": past the window: fetched again, failed, the last set");
      assert.deepEqual(fetches(), [3, 5]);
    });
    await later((OAUTH_KEYSET_TTL_MIN_S + OAUTH_KEYSET_TTL_MAX_S + 1) * 1000, async () => {
      for (const X of both) assert.ok(refused(await tryKey(w, X.app, X.es)), X.app.key + ": an outage past the bound: no set, refused");
      assert.deepEqual(fetches(), [4, 7], "the fetch was tried, and failed");
    });
  });
});

test("a fetch that never settles: each waiter goes on after its own timer, refused, as a set whose time is up serves only after a try that failed; a request after the window fetches again", async () => {
  const { w, apps: [A] } = await remoteApps("hung");
  let hang = false;
  await withKeys(async () => (hang ? new Promise(() => {}) : served(setOf(A.es), OAUTH_KEYSET_TTL_MIN_S)), async (host) => {
    assert.ok(taken(await tryKey(w, A.app, A.es)));
    hang = true;
    await later((OAUTH_KEYSET_TTL_MIN_S + 1) * 1000, async () => {
      const t = Date.now();
      const rs = await Promise.all([tryKey(w, A.app, A.es), tryKey(w, A.app, A.es)]);
      assert.ok(rs.every(refused), "the set's time up and its try still in flight: both refused once their timers ran out");
      assert.ok(Date.now() - t < OAUTH_FETCH_TIMEOUT_MS + 3000, "each waited about OAUTH_FETCH_TIMEOUT_MS and a second, no more");
      assert.equal(host.count(), 2, "one fetch for both");
    });
    hang = false;
    await later((OAUTH_KEYSET_TTL_MIN_S + OAUTH_KEYSET_REFETCH_S + 2) * 1000, async () => {
      assert.ok(taken(await tryKey(w, A.app, A.es)), "after the window: the hung fetch forgotten, fetched again");
      assert.equal(host.count(), 3);
    });
  });
});

test("a code redeemed already: a bare copy (wrong verifier or redirect) ends nothing, within its minute or after; its own client with its redirect and verifier within the minute ends the sign-in; after the minute it is invalid_grant and ends nothing", async () => {
  for (const when of ["within", "after"]) {
    const w = makeSigninWorld();
    const pat = people(w, ["lima"]);
    const s = await signIn(w, PUBLIC_APP, pat);
    const redirect = new URLSearchParams(s.query).get("redirect_uri");
    const again = (extra) => token(w, { grant_type: "authorization_code", code: s.code, code_verifier: s.verifier, redirect_uri: redirect, resource: ADDRESS, client_id: PUBLIC_APP.client_id, ...extra });
    const run = async (f) => (when === "within" ? f() : later((OAUTH_CODE_TTL_S + 1) * 1000, f));
    await run(async () => {
      for (const [what, extra] of [["a wrong verifier", { code_verifier: "v".repeat(43) }], ["a wrong redirect", { redirect_uri: "http://127.0.0.1:9/callback" }], ["no verifier", { code_verifier: undefined }]]) {
        assert.deepEqual((await again(extra)).json, { error: "invalid_grant" }, when + ", " + what);
        assert.equal(signins(w).length, 1, when + ", " + what + ": nothing ended");
      }
      const r = await again({});
      assert.deepEqual(r.json, { error: "invalid_grant" }, when + ": its own client, redirect and verifier");
      assert.equal(signins(w).length, when === "within" ? 0 : 1, when === "within" ? "within the minute: a reuse, the sign-in ended" : "after the minute: unknown, nothing ended");
    });
  }
});

test("an assertion's jti is kept for as long as the assertion is accepted: a replay just before its exp and the skew is refused", async () => {
  const c = await poppyCode();
  const t = nowS();
  const a = await asserted(c, c.es, { iat: t + 29, exp: t + 29 + 300 });
  assert.equal((await exchange(c, a, { code: "x" })).json.error, "invalid_grant", "the first use authenticates");
  assert.equal((await exchange(c, a, { code: "x" })).status, 401, "a replay at once");
  await later(335 * 1000, async () => {
    const r = await exchange(c, a, { code: "x" });
    assert.deepEqual([r.status, r.json], [401, { error: "invalid_client" }], "a replay 335 s later, the assertion still within its exp and the skew");
  });
});

test("a key's thumbprint (RFC 7638), as dpop_jkt names it: the members in their order, on the published examples", async () => {
  assert.equal(await jwkThumbprint({ kty: "EC", x: "l8tFrhx-34tV3hRICRDY9zCkDlpBhF42UQUfWVAWBFs", y: "9VE4jf_Ok_o64zbTTlcuNJajHmt6v9TDVrU0CdvGRDA", crv: "P-256" }), "0ZcOCORZNYy-DWpqq30jZyJGHTN0d2HglBV3uiguA4I", "RFC 9449's key");
  const n = "0vx7agoebGcQSuuPiLJXZptN9nndrQmbXEps2aiAFbWhM78LhWx4cbbfAAtVT86zwu1RK7aPFFxuhDR1L6tSoc_BJECPebWKRXjBZCiFV4n3oknjhMstn64tZ_2W-5JsGY4Hc5n9yBXArwl93lqt7_RN5w6Cf0h4QyQ5v-65YGjQR0_FDW2QvzqY368QQMicAtaSqzs8KJZgnYb9c7d0zgdAZHzu6qMQvRL5hajrn1n91CbOpbISD08qNLyrdkt-bFTWhAI4vMQFh6WeZu0fM4lFd2NcRwr3XPksINHaQ-G_xBniIqbw0Ls1jF44-csFCur-kEgU8awapJzKnqDKgw";
  assert.equal(await jwkThumbprint({ kty: "RSA", n, e: "AQAB", alg: "RS256", kid: "2011-04-29" }), "NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs", "RFC 7638 3.1's key");
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
  assert.deepEqual((await run({ resource: ADDRESS }, { redirect_uri: undefined })).json, { error: "invalid_grant" }, "no redirect_uri: the one the request named is required");
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

// Muse: a pinned public client (client_id muse), as Claude's two are.
const MUSE = KNOWN_APPS.find((a) => a.key === "muse");
const CLAUDE = KNOWN_APPS.find((a) => a.key === "claude");
const watchLines = (lines) => lines.filter((l) => l.warn === "oauth.token_watch");

test("Muse's code exchange as a public client: client_id in the form, no secret, no assertion: 200; with a client_secret: 401; its code presented by Claude's client, or Claude's by Muse's, is invalid_grant and ends nothing; one counts-only line, app muse", async () => {
  const w = makeSigninWorld([]);
  const pat = people(w, ["lima", "oslo"]);
  let s;
  const lines = await logged(async () => { s = await signIn(w, MUSE, pat, { rooms: ["lima"], name: "Muse" }); });
  assert.equal(s.token.status, 200, s.token.text);
  assert.deepEqual([s.token.json.token_type, s.token.json.scope, s.token.json.expires_in], ["Bearer", "rooms", OAUTH_ACCESS_TTL_S]);
  assert.deepEqual(watchLines(lines), [{ warn: "oauth.token_watch", error: null, app: "muse", grant_type: "authorization_code", alg: null, has_kid: false, has_client_id: true, has_resource: true, has_dpop: false }]);
  for (const l of lines) assert.ok(!/\.o[ca]1\.|\.ar1\.|lima|Muse/.test(JSON.stringify(l)), "names and booleans only: " + JSON.stringify(l));
  assert.equal((await signin(w, s.access, toolCall("list_rooms"))).status, 200, "its access token works at the sign-in address");
  // a client_secret: refused, as for any public app
  const withSecret = await refreshOf(w, MUSE, s.refresh, { client_id: "muse", client_secret: "x" });
  assert.deepEqual([withSecret.status, withSecret.json.error], [401, "invalid_client"]);
  // Muse's code by Claude's client, and Claude's by Muse's: invalid_grant, and each code still works for its own client
  for (const [own, other] of [[MUSE, CLAUDE], [CLAUDE, MUSE]]) {
    const { verifier, challenge } = await pkce();
    const query = authzQuery(own, challenge, { resource: ADDRESS });
    const d = await decide(w, { params: query, approve: true, name: own.name + " 2", rooms: [{ room: "oslo", inviter_token: pat.oslo }] });
    const code = new URL(d.json.redirect).searchParams.get("code");
    const ex = (app) => token(w, { grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: own.redirect_uris[0], resource: ADDRESS, client_id: app.client_id });
    const cross = await ex(other);
    assert.deepEqual([cross.status, cross.json.error], [400, "invalid_grant"], own.key + "'s code by " + other.key);
    assert.equal((await ex(own)).status, 200, own.key + "'s code still works for it: nothing ended");
  }
  assert.equal((await signin(w, s.access, toolCall("list_rooms"))).status, 200, "nor the first sign-in");
});

test("a public app may name itself only in Authorization: Basic with an empty password (the code exchange, a refresh and a revoke: 200); a password, a header that does not decode or another id than the form's is 401 invalid_client; for an app that signs its requests the header changes nothing", async () => {
  const w = makeSigninWorld([]);
  const pat = people(w, ["lima"]);
  const { verifier, challenge } = await pkce();
  const query = authzQuery(MUSE, challenge, { resource: ADDRESS });
  const d = await decide(w, { params: query, approve: true, name: "Muse", rooms: [{ room: "lima", inviter_token: pat.lima }] });
  const code = new URL(d.json.redirect).searchParams.get("code");
  const exchangeAs = (headers, extra = {}) => token(w, { grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: MUSE.redirect_uris[0], resource: ADDRESS, ...extra }, headers);
  const refusedClient = (r, what) => { assert.deepEqual([r.status, r.json, r.headers.get("WWW-Authenticate")], [401, { error: "invalid_client" }, "Basic"], what); };
  // refused, each before the code is looked at: the code still works after them
  for (const [what, header, extra] of [
    ["a password", basic("muse", "secret"), {}],
    ["a password, with client_id in the form", basic("muse", "secret"), { client_id: "muse" }],
    ["another id than the form's", basic("muse", ""), { client_id: CLAUDE.client_id }],
    ["the form's id another than the header's", basic(CLAUDE.client_id, ""), { client_id: "muse" }],
    ["no colon", "Basic " + Buffer.from("muse").toString("base64"), {}],
    ["not base64", "Basic m*se", {}],
    ["no credentials at all", "Basic", {}],
    ["two words", basic("muse", "") + " x", {}],
    ["a broken escape", "Basic " + Buffer.from("mu%e:").toString("base64"), { client_id: "muse" }],
  ]) refusedClient(await exchangeAs({ Authorization: header }, extra), what);
  const ex = await exchangeAs({ Authorization: basic("muse", "") });
  assert.equal(ex.status, 200, "the id only in the header, with no password: " + ex.text);
  const r1 = await token(w, { grant_type: "refresh_token", refresh_token: ex.json.refresh_token, resource: ADDRESS }, { Authorization: basic("muse", "") });
  assert.equal(r1.status, 200, "a refresh: " + r1.text);
  const r2 = await token(w, { grant_type: "refresh_token", refresh_token: r1.json.refresh_token, resource: ADDRESS, client_id: "muse" }, { Authorization: "basic " + Buffer.from("muse:").toString("base64") });
  assert.equal(r2.status, 200, "the scheme in any case, and the form's client_id the same: " + r2.text);
  refusedClient(await revoke(w, { token: r2.json.refresh_token }, { Authorization: basic("muse", "x") }), "a revoke with a password");
  assert.equal((await signin(w, r2.json.access_token, toolCall("list_rooms"))).status, 200, "nothing revoked by a refused request");
  const rv = await revoke(w, { token: r2.json.refresh_token }, { Authorization: basic("muse", "") });
  assert.deepEqual([rv.status, rv.json], [200, {}], "a revoke");
  assert.equal((await signin(w, r2.json.access_token, toolCall("list_rooms"))).status, 401, "revoked");
  // an app that signs its requests: the header is not read, whatever it says
  const P = await poppyApp();
  const pw = makeSigninWorld([P.app]);
  const ppat = people(pw, ["lima"]);
  const ps = await signIn(pw, P.app, ppat, { pair: P.es });
  let rt = ps.refresh;
  for (const header of [basic(P.app.client_id, ""), basic(P.app.client_id, "secret"), basic("muse", ""), "Basic m*se"]) {
    const r = await token(pw, { grant_type: "refresh_token", refresh_token: rt, resource: ADDRESS, ...(await clientAuth(P.app, P.es)) }, { Authorization: header });
    assert.equal(r.status, 200, header + ": " + r.text);
    rt = r.json.refresh_token;
  }
  // its id in the header alone names nothing: its requests are named by their assertion
  const alone = await token(pw, { grant_type: "refresh_token", refresh_token: rt }, { Authorization: basic(P.app.client_id, "") });
  assert.deepEqual([alone.status, alone.json.error], [401, "invalid_client"]);
});

test("a token or revoke request that names no known app: 401 and one counts-only line, oauth.token_unknown, saying only how it tried to name one", async () => {
  const w = makeSigninWorld([]);
  const P = await poppyApp({ client_id: "https://nobody.example/signs" });
  const cases = [
    [{ client_id: "https://nobody.example/c" }, {}, { has_client_id: true, has_basic: false, has_assertion: false }],
    [{}, { Authorization: basic("nobody", "") }, { has_client_id: false, has_basic: true, has_assertion: false }],
    [{ client_assertion_type: URN, client_assertion: await assertion(P.app, P.es) }, { Authorization: "Basic m*se" }, { has_client_id: false, has_basic: true, has_assertion: true }],
    [{}, {}, { has_client_id: false, has_basic: false, has_assertion: false }],
  ];
  for (const [fields, headers, want] of cases) {
    for (const call of [(f, h) => token(w, { grant_type: "refresh_token", refresh_token: ".ar1.x", ...f }, h), (f, h) => revoke(w, { token: ".ar1.x", ...f }, h)]) {
      let r;
      const lines = await logged(async () => { r = await call(fields, headers); });
      assert.deepEqual([r.status, r.json.error], [401, "invalid_client"]);
      assert.deepEqual(lines, [{ warn: "oauth.token_unknown", error: null, ...want }], JSON.stringify(want));
    }
  }
  // a known app refused by its Basic header is not this line
  const lines = await logged(async () => { await token(w, { grant_type: "refresh_token", refresh_token: ".ar1.x" }, { Authorization: basic("muse", "x") }); });
  assert.deepEqual(lines.filter((l) => l.warn === "oauth.token_unknown"), []);
});

test("a watched app's refresh line says how the refresh token it presented stood: fresh, grace (a repeat within OAUTH_REFRESH_GRACE_S), spent (after it: a reuse, which ends the sign-in) or unknown; a refresh refused before its grant has no such field", async () => {
  const w = makeSigninWorld([]);
  const pat = people(w, ["lima"]);
  const s = await signIn(w, MUSE, pat, { rooms: ["lima"], name: "Muse" });
  const refresh = (rt, extra = {}) => token(w, { grant_type: "refresh_token", refresh_token: rt, client_id: "muse", resource: ADDRESS, ...extra });
  const standing = async (f) => { let r; const lines = await logged(async () => { r = await f(); }); const ws = watchLines(lines); assert.equal(ws.length, 1, JSON.stringify(lines)); return [r, ws[0]]; };
  const base = { warn: "oauth.token_watch", error: null, app: "muse", grant_type: "refresh_token", alg: null, has_kid: false, has_client_id: true, has_resource: true, has_dpop: false };
  let [r, line] = await standing(() => refresh(s.refresh));
  assert.equal(r.status, 200);
  assert.deepEqual(line, { ...base, refresh: "fresh" });
  [r, line] = await standing(() => refresh(s.refresh));
  assert.equal(r.status, 200, "within the grace: the same pair");
  assert.deepEqual(line, { ...base, refresh: "grace" });
  [r, line] = await standing(() => refresh(".ar1." + "A".repeat(22) + "." + "A".repeat(11) + "." + "A".repeat(43)));
  assert.deepEqual([r.status, r.json.error, line], [400, "invalid_grant", { ...base, refresh: "unknown" }]);
  [r, line] = await standing(() => refresh(s.refresh, { client_secret: "x" }));
  assert.deepEqual([r.status, line], [401, base], "refused before the grant: no refresh field");
  await later((OAUTH_REFRESH_GRACE_S + 1) * 1000, async () => {
    [r, line] = await standing(() => refresh(s.refresh));
    assert.deepEqual([r.status, r.json.error, line], [400, "invalid_grant", { ...base, refresh: "spent" }]);
    await Promise.all(w.pending);
    assert.equal((await signin(w, s.access, toolCall("list_rooms"))).status, 401, "the reuse ended the sign-in");
  });
});
