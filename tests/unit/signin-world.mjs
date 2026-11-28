// A world for the sign-in's tests (worker/routes/oauth.ts, the sign-in
// address in routes/agent.ts): the agent key's stand-in world
// (agent-world.mjs) under TEST_HOOKS, with a static-assets stand-in for the
// app shell, stand-in apps put on the OAUTH_QUOTA_ROOM object as the test
// hook puts them, a person in each room, and the OAuth client's side done by
// hand: PKCE, signed client assertions (ES256 and PS384) and DPoP proofs,
// each key made here with Web Crypto. A helper, not a test.
import { makeWorld, read, agentInvite } from "./agent-world.mjs";
import { authorizeRoute, decideRoute, disconnectRoute, revokeRoute, tokenRoute, wellKnownRoute } from "../../worker/routes/oauth.ts";
import { signinMcpRoute } from "../../worker/routes/agent.ts";
import { OAUTH_QUOTA_ROOM } from "../../worker/limits.ts";
import { b64urlEncode } from "../../worker/lib/crypto.ts";

export const ORIGIN = "http://localhost";
export const ADDRESS = ORIGIN + "/api/mcp/signin";
export const SHELL = "<!doctype html><html><head><meta name=\"build\" content=\"next-dev\"><!--page-head--></head><body><div id=\"root\"></div><!--page-note--></body></html>";

const enc = new TextEncoder();
export const b64json = (v) => b64urlEncode(enc.encode(JSON.stringify(v)));
export const sha256b64 = async (s) => b64urlEncode(await crypto.subtle.digest("SHA-256", enc.encode(s)));

/** A key pair for an app's assertions or a client's proofs, with its public JWK. */
export async function keyPair(alg = "ES256", kid) {
  const params = alg === "ES256" ? { name: "ECDSA", namedCurve: "P-256" } : { name: "RSA-PSS", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-384" };
  const kp = await crypto.subtle.generateKey(params, true, ["sign", "verify"]);
  const full = await crypto.subtle.exportKey("jwk", kp.publicKey);
  const jwk = alg === "ES256" ? { kty: "EC", crv: "P-256", x: full.x, y: full.y } : { kty: "RSA", n: full.n, e: full.e };
  if (kid) jwk.kid = kid;
  return { alg, privateKey: kp.privateKey, jwk };
}

/** A compact JWS of header and payload, signed with the pair (ES256 raw r||s, PS384 salt saltLength). */
export async function jws(pair, header, payload, opts = {}) {
  const input = b64json(header) + "." + b64json(payload);
  const algo = pair.alg === "ES256" ? { name: "ECDSA", hash: "SHA-256" } : { name: "RSA-PSS", saltLength: opts.saltLength ?? 48 };
  let sig = new Uint8Array(await crypto.subtle.sign(algo, pair.privateKey, enc.encode(input)));
  if (opts.der && pair.alg === "ES256") sig = toDer(sig);
  return input + "." + b64urlEncode(sig);
}
/** an ECDSA signature as DER, the form a JWS must not carry */
function toDer(raw) {
  const int = (b) => { let i = 0; while (i < b.length - 1 && b[i] === 0) i++; let v = b.slice(i); if (v[0] & 0x80) v = Uint8Array.of(0, ...v); return Uint8Array.of(2, v.length, ...v); };
  const r = int(raw.slice(0, 32)), s = int(raw.slice(32));
  return Uint8Array.of(0x30, r.length + s.length, ...r, ...s);
}

const nowS = () => Math.floor(Date.now() / 1000);
let jtiN = 0;
export const newJti = () => "jti-" + Date.now() + "-" + (++jtiN) + "-" + Math.random().toString(36).slice(2, 10);

/** A client assertion for app, signed by pair (claims overridable). */
export function assertion(app, pair, claims = {}, header = {}, opts = {}) {
  const t = nowS();
  const h = { alg: pair.alg, ...(pair.jwk.kid ? { kid: pair.jwk.kid } : {}), ...header };
  return jws(pair, h, { iss: app.client_id, sub: app.client_id, aud: ORIGIN, iat: t, exp: t + 120, jti: newJti(), ...claims }, opts);
}

/** A DPoP proof for the token endpoint, signed by pair (claims and header overridable). */
export function dpopProof(pair, claims = {}, header = {}, opts = {}) {
  return jws(pair, { typ: "dpop+jwt", alg: pair.alg, jwk: pair.jwk, ...header }, { jti: newJti(), htm: "POST", htu: ORIGIN + "/api/oauth/token", iat: nowS(), ...claims }, opts);
}

/** PKCE: a verifier and its S256 challenge. */
export async function pkce() {
  const verifier = b64urlEncode(crypto.getRandomValues(new Uint8Array(32)));
  return { verifier, challenge: await sha256b64(verifier) };
}

/** The public stand-in app: a loopback redirect, as Claude Code's. */
export const PUBLIC_APP = { key: "standin-public", client_id: "https://standin.example/oauth/public.json", kind: "public", name: "Stand-in", host: "standin.example", redirect_uris: ["http://127.0.0.1/callback"], loopback: true, page: "agent" };

/** A world under TEST_HOOKS, its app shell served, the given stand-in apps known. */
export function makeSigninWorld(apps = [PUBLIC_APP], opts = {}) {
  const env = { TEST_HOOKS: "1", TEST_SIGNIN_ORIGIN: ORIGIN, ASSETS: { fetch: async () => new Response(SHELL, { headers: { "Content-Type": "text/html" } }) }, ...(opts.env || {}) };
  const w = makeWorld({ env });
  for (const a of apps) w.harness(OAUTH_QUOTA_ROOM).room.setTestOauthApp(a);
  return w;
}
/** A poppy stand-in app with its key set inline (ES256 and PS384 keys, each with a kid). */
export async function poppyApp(extra = {}) {
  const es = await keyPair("ES256", "es-1"), ps = await keyPair("PS384", "ps-1");
  const app = { key: "standin-poppy", client_id: "https://agent.example/.well-known/poppy-client", kind: "poppy", name: "Muse", host: "agent.example", redirect_uris: ["https://agent.example/callback"], loopback: false, page: "agent", jwks: { keys: [es.jwk, ps.jwk] }, ...extra };
  return { app, es, ps };
}

/** A person, Pat, in each room: Pat's tokens by room. */
export function people(w, names) {
  const pat = {};
  for (const n of names) pat[n] = agentInvite(w.room(n), "Pat", "human");
  return pat;
}

/** An authorization request's query string for app (parameters overridable; null leaves one out). */
export function authzQuery(app, challenge, extra = {}) {
  const p = new URLSearchParams();
  const base = { response_type: "code", client_id: app.client_id, redirect_uri: app.loopback ? "http://127.0.0.1:43123/callback" : app.redirect_uris[0], code_challenge: challenge, code_challenge_method: "S256", state: "st-1", ...(app.kind === "poppy" ? { scope: "rooms" } : {}), ...extra };
  for (const [k, v] of Object.entries(base)) {
    if (v === null) continue;
    for (const x of Array.isArray(v) ? v : [v]) p.append(k, x);
  }
  return p.toString();
}

export const SAME = { "Sec-Fetch-Site": "same-origin" };
export const authorize = (w, query, method = "GET") => read(authorizeRoute(w.rc(method, "/oauth/authorize?" + query)));
export const decide = (w, body, headers = SAME) => read(decideRoute(w.rc("POST", "/api/oauth/decide", { json: body, headers })));
export const disconnect = (w, body, headers = SAME) => read(disconnectRoute(w.rc("POST", "/api/oauth/disconnect", { json: body, headers })));
export const document = (w, path, method = "GET") => { const r = wellKnownRoute(w.rc(method, path)); return r === undefined ? undefined : read(r); };
/** a form POST to the token or revocation endpoint */
export function form(route, w, fields, headers = {}) {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) { if (v === null || v === undefined) continue; for (const x of Array.isArray(v) ? v : [v]) body.append(k, x); }
  return read(route(w.rc("POST", route === tokenRoute ? "/api/oauth/token" : "/api/oauth/revoke", { body: body.toString(), headers: { "Content-Type": "application/x-www-form-urlencoded", "CF-Connecting-IP": "10.9.0.1", ...headers } })));
}
export const token = (w, fields, headers) => form(tokenRoute, w, fields, headers);
export const revoke = (w, fields, headers) => form(revokeRoute, w, fields, headers);

/** A call to the sign-in address: Bearer token (or none), a JSON-RPC body, extra headers. */
export function signin(w, bearer, body, headers = {}) {
  return read(signinMcpRoute(w.rc("POST", "/api/mcp/signin", { json: body, headers: { ...(bearer ? { Authorization: "Bearer " + bearer } : {}), ...headers } })));
}
export const rpc = (method, params, id = 1) => ({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) });
export const toolCall = (name, args = {}) => rpc("tools/call", { name, arguments: args });

/** The client's credentials for a token request: a public app's client_id, or a poppy app's assertion. */
export async function clientAuth(app, pair) {
  return app.kind === "public" ? { client_id: app.client_id } : { client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer", client_assertion: await assertion(app, pair) };
}

/**
 * The whole sign-in of app for Pat's rooms: authorize, decide, the code
 * exchange. Returns the tokens and what each step answered.
 * @param o {rooms, name, pair (poppy), proof (a DPoP pair), resource, extra (authorize parameters)}
 */
export async function signIn(w, app, pat, o = {}) {
  const { verifier, challenge } = await pkce();
  const query = authzQuery(app, challenge, { resource: o.resource === undefined ? ADDRESS : o.resource, ...(o.extra || {}) });
  const rooms = (o.rooms || Object.keys(pat)).map((room) => ({ room, inviter_token: pat[room], ...(o.reuse ? { reuse: o.reuse } : {}) }));
  const d = await decide(w, { params: query, approve: true, name: o.name || "Scout", rooms });
  if (d.status !== 200 || !d.json.redirect) return { decide: d };
  const back = new URL(d.json.redirect);
  const code = back.searchParams.get("code");
  const q = new URLSearchParams(query);
  const t = await token(w, { grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: q.get("redirect_uri"), resource: o.tokenResource === undefined ? ADDRESS : o.tokenResource, ...(await clientAuth(app, o.pair)) }, o.proof ? { DPoP: await dpopProof(o.proof) } : {});
  return { decide: d, code, query, verifier, token: t, access: t.json && t.json.access_token, refresh: t.json && t.json.refresh_token, disconnectCode: d.json.disconnect_code };
}

/** The sign-in identities that exist (names starting __agent- whose ak.client is set). */
export function signins(w) {
  return [...w.objects.keys()].filter((n) => n.startsWith("__agent-") && n !== "__agent-quota" && (() => { try { return w.harness(n).one("SELECT client FROM ak").client !== null; } catch { return false; } })());
}

/**
 * A sign-in with Muse wakes: the bridge's stand-in (bridge-world.mjs), the
 * app signed in for Pat's rooms, each room joined through the sign-in
 * address (a wake would join it), and muse_register with a gadget's code.
 * Returns the world, the bridge, the sign-in and the gadget (code, link).
 */
export async function museSignIn(rooms = ["lima"], o = {}) {
  const { bridgeWorld } = await import("./bridge-world.mjs");
  const b = o.b || await bridgeWorld();
  const w = o.w || makeSigninWorld(o.apps || [PUBLIC_APP], { env: b.env });
  const pat = o.pat || people(w, rooms);
  const s = await signIn(w, o.app || PUBLIC_APP, pat, { rooms, name: o.name || "Scout", ...(o.signIn || {}) });
  for (const room of rooms) await signin(w, s.access, toolCall("get_room_state", { room }));
  const g = o.gadget ? await b.connect(o.gadget) : await b.connect();
  const reg = o.register === false ? null : await signin(w, s.access, toolCall("muse_register", { code: g.code, rooms }));
  return { b, w, pat, s, g, reg };
}
/** the member's Muse hook in a room (null: none), and its holders */
export const hookOf = (w, room, name = "Scout") => w.harness(room).all("SELECT kind, link FROM mh WHERE name = ?", name).map((x) => ({ ...x }))[0] || null;
export const holdersOf = (w, room) => w.harness(room).all("SELECT holder FROM mhh ORDER BY holder").map((r) => r.holder);
