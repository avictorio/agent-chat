// POST /api/oauth/decide (worker/routes/oauth.ts decideRoute): the
// approval page's call. Same origin only; the body as POST
// /api/agents/invite reads it (personBody), with params, the authorize
// URL's raw query string, checked again exactly as GET /oauth/authorize
// checks it; a check that writes nothing; the sign-in made before its first
// seat and every seat written from its code slot; the code's bind; a failure
// that keeps the invites it made, unopened, names them and drops the
// sign-in from its code slot; a decline that makes nothing; one approval per
// request; the creation caps; and no Access-Control-Allow-Origin on any
// answer. Keys, tokens and codes are made here. Run with `npm run test:unit`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeSigninWorld, decide, authzQuery, pkce, people, PUBLIC_APP, ORIGIN, ADDRESS, SAME, signIn, token, clientAuth, signins } from "./signin-world.mjs";
import { read } from "./agent-world.mjs";
import { decideRoute } from "../../worker/routes/oauth.ts";
import { AGENT_QUOTA_ROOM, AGENT_ROOMS_MAX, OAUTH_CODE_TTL_S, SIGNIN_SCOPE } from "../../worker/limits.ts";
import { unusedNote } from "../../worker/agents/onboarding.ts";
import WORKER from "../../worker/index.ts";

const body = async (pat, rooms, extra = {}) => {
  const { verifier, challenge } = await pkce();
  return { verifier, challenge, b: { params: authzQuery(PUBLIC_APP, challenge, { resource: ADDRESS }), approve: true, name: "Scout", rooms: rooms.map((room) => ({ room, inviter_token: pat[room] })), ...extra } };
};
const noCors = (r, what) => assert.equal(r.headers.get("Access-Control-Allow-Origin"), null, what + ": no CORS");

test("same origin only: Sec-Fetch-Site same-origin, or without it Origin the site's; anything else 403 cross_site, nothing asked", async () => {
  const w = makeSigninWorld();
  const pat = people(w, ["lima"]);
  const { b } = await body(pat, ["lima"]);
  for (const [what, headers] of [["cross-site", { "Sec-Fetch-Site": "cross-site" }], ["same-site", { "Sec-Fetch-Site": "same-site" }], ["none", { "Sec-Fetch-Site": "none" }], ["another Origin", { Origin: "https://evil.example" }], ["no header at all", {}], ["same-origin Origin beside a cross-site fetch", { "Sec-Fetch-Site": "cross-site", Origin: ORIGIN }]]) {
    const mark = w.asked.length;
    const r = await decide(w, b, headers);
    assert.deepEqual([r.status, r.json], [403, { error: "This request must come from Agent Chat's own sign-in page.", code: "cross_site" }], what);
    noCors(r, what);
    assert.deepEqual(w.asked.slice(mark), [], what + ": nothing asked");
  }
  assert.equal((await decide(w, b, { Origin: ORIGIN })).status, 200, "Origin the site's, with no Sec-Fetch-Site");
});

test("the body as personBody reads it: {params, approve, name, rooms, check?} taken; an entries list refused by personBody's check; a decline needs no rooms; too large is 413", async () => {
  const w = makeSigninWorld();
  const pat = people(w, ["lima"]);
  const { b, challenge } = await body(pat, ["lima"]);
  const r = await decide(w, { ...b, check: true });
  assert.deepEqual([r.status, r.json], [200, { ok: true, rooms: [{ room: "lima", name: "Scout", seat: "new", opened: false }] }]);
  const old = await decide(w, { params: b.params, approve: true, name: "Scout", entries: [{ room: "lima", inviter_token: pat.lima }] });
  assert.deepEqual([old.status, old.json], [400, { error: "\"rooms\" must list 1 to " + AGENT_ROOMS_MAX + " rooms: [{\"room\", \"inviter_token\"}], with your own invites" }]);
  noCors(old, "a refusal");
  const no = await decide(w, { params: b.params, approve: false });
  assert.equal(no.status, 200);
  assert.deepEqual(Object.fromEntries(new URL(no.json.redirect).searchParams), { error: "access_denied", state: "st-1", iss: ORIGIN });
  for (const bad of [{ params: b.params, approve: "yes", rooms: b.rooms }, { params: b.params, rooms: b.rooms }]) assert.deepEqual((await decide(w, bad)).json, { error: "\"approve\" must be true or false", code: "invalid_request" });
  const big = await read(decideRoute(w.rc("POST", "/api/oauth/decide", { json: { ...b, pad: "x".repeat(2 * 1024 * 1024) }, headers: SAME })));
  assert.equal(big.status, 413);
  noCors(big, "413");
  const notJson = await read(decideRoute(w.rc("POST", "/api/oauth/decide", { body: "{nope", headers: { ...SAME, "Content-Type": "application/json" } })));
  assert.equal(notJson.status, 400);
  noCors(notJson, "a body that is not JSON");
  assert.ok(challenge);
});

test("params, the raw query string, checked again as authorize checks it, duplicates included: a fixed page's failure is 400 invalid_request, a redirecting one answers its redirect", async () => {
  const w = makeSigninWorld();
  const pat = people(w, ["lima"]);
  const { b, challenge } = await body(pat, ["lima"]);
  const notValid = { error: "This sign-in request is not valid.", code: "invalid_request" };
  for (const [what, params] of [
    ["an unknown app", authzQuery({ ...PUBLIC_APP, client_id: "https://nobody.example/c" }, challenge)],
    ["another redirect", authzQuery(PUBLIC_APP, challenge, { redirect_uri: "https://evil.example/cb" })],
    ["client_id twice", authzQuery(PUBLIC_APP, challenge, { client_id: [PUBLIC_APP.client_id, PUBLIC_APP.client_id] })],
    ["redirect_uri twice", authzQuery(PUBLIC_APP, challenge, { redirect_uri: ["http://127.0.0.1:1/callback", "http://127.0.0.1:2/callback"] })],
    ["no params", undefined],
  ]) {
    const r = await decide(w, { ...b, params });
    assert.deepEqual([r.status, r.json], [400, notValid], what);
  }
  for (const [what, extra, error] of [["state twice", { state: ["a", "b"] }, "invalid_request"], ["plain PKCE", { code_challenge_method: "plain" }, "invalid_request"], ["another resource", { resource: "https://evil.example" }, "invalid_target"], ["response_type token", { response_type: "token" }, "unsupported_response_type"]]) {
    const mark = w.asked.length;
    const r = await decide(w, { ...b, params: authzQuery(PUBLIC_APP, challenge, extra) });
    assert.equal(r.status, 200, what);
    assert.equal(new URL(r.json.redirect).searchParams.get("error"), error, what);
    assert.ok(!w.asked.slice(mark).some((a) => a.name === "lima"), what + ": no room asked");
  }
});

test("a check writes nothing: no identity, no invite, no counter, no request spent; a refused inviter's room learns nothing", async () => {
  const w = makeSigninWorld();
  const pat = people(w, ["lima", "oslo"]);
  const { b } = await body(pat, ["lima", "oslo"]);
  const rows = () => ["lima", "oslo"].map((n) => w.harness(n).all("SELECT * FROM inv"));
  const before = rows();
  const mark = w.asked.length;
  const r = await decide(w, { ...b, rooms: [{ room: "lima", inviter_token: pat.lima }, { room: "oslo", inviter_token: "not-a-token" }], check: true });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.rooms[1], { room: "oslo", name: "Scout", problem: { status: 403, code: "invite_invalid", error: "Room \"oslo\": This invite link isn't valid for this room." } });
  assert.deepEqual(rows(), before, "nothing written in any room");
  assert.deepEqual(signins(w), [], "no sign-in made");
  const methods = w.asked.slice(mark).map((a) => a.name + "." + a.method);
  assert.ok(!methods.some((m) => /\.(signinMake|agentReserve|invite)$/.test(m)), methods.join(" "));
  assert.deepEqual(w.asked.slice(mark).filter((a) => a.method === "clientNote").map((a) => a.args[0]), [{ peek: [w.asked.slice(mark).find((a) => a.method === "clientNote").args[0].peek[0]] }], "the request only peeked at");
  assert.deepEqual(methods.filter((m) => m.startsWith("oslo.")), ["oslo.lookupInvite"], "the refused inviter's room: its look, nothing more");
  // and the same request then approves (a check spent nothing)
  assert.equal((await decide(w, b)).status, 200);
});

test("approve: the sign-in made before its first seat, each seat put on it at once from its code slot, the code's bind, the redirect with code, state and iss, and the disconnect-only code", async () => {
  const w = makeSigninWorld();
  const pat = people(w, ["lima", "oslo"]);
  const { b, challenge } = await body(pat, ["lima", "oslo"], { params: undefined });
  b.params = authzQuery(PUBLIC_APP, challenge, { resource: [ADDRESS, ORIGIN], dpop_jkt: "J".repeat(43) });
  const mark = w.asked.length;
  const r = await decide(w, b);
  assert.equal(r.status, 200, r.text);
  noCors(r, "the approval");
  assert.deepEqual(Object.keys(r.json), ["redirect", "rooms", "disconnect_code"]);
  const back = new URL(r.json.redirect);
  assert.equal(back.origin + back.pathname, "http://127.0.0.1:43123/callback", "the loopback address as sent");
  assert.deepEqual([...back.searchParams.keys()], ["code", "state", "iss"]);
  assert.match(back.searchParams.get("code"), /^\.oc1\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{11}\.[A-Za-z0-9_-]{43}$/);
  assert.deepEqual([back.searchParams.get("state"), back.searchParams.get("iss")], ["st-1", ORIGIN]);
  assert.match(r.json.disconnect_code, /^\.ad1\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{11}\.[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(r.json.rooms, [{ room: "lima", name: "Scout", opened: false, seat: "new" }, { room: "oslo", name: "Scout", opened: false, seat: "new" }]);
  const seq = w.asked.slice(mark).map((a) => a.name.replace(/^__agent-.*/, "ID") + "." + a.method);
  const made = seq.indexOf("ID.signinMake"), firstInvite = seq.indexOf("lima.invite");
  assert.ok(made > 0 && made < firstInvite, "the sign-in made before the first seat: " + seq.join(" "));
  const swaps = w.asked.slice(mark).filter((a) => a.method === "signinSwap");
  assert.equal(swaps.length, 2, "each seat in its own write");
  const [id] = signins(w);
  const h = w.harness(id);
  const code = h.one("SELECT * FROM aks WHERE kind = 'code'");
  assert.ok(swaps.every((s) => s.args[0] === code.slot), "written from the code slot");
  const bind = JSON.parse(code.bind);
  assert.deepEqual(Object.keys(bind), ["client", "redirect", "challenge", "resources", "scope", "jkt", "wk"]);
  assert.deepEqual([bind.client, bind.redirect, bind.challenge, bind.resources, bind.scope, bind.jkt], [PUBLIC_APP.client_id, "http://127.0.0.1:43123/callback", challenge, [ADDRESS, ORIGIN], SIGNIN_SCOPE, "J".repeat(43)]);
  assert.equal(code.expires - code.created, OAUTH_CODE_TTL_S * 1000);
  assert.equal(h.one("SELECT ver FROM ak").ver, 3, "two seats, two writes");
  assert.deepEqual(h.all("SELECT kind FROM aks ORDER BY kind").map((x) => x.kind), ["code", "disconnect"], "a code slot and a disconnect slot, no token yet");
  // the seats: agent invites by Pat, unopened, and no token in the answer
  for (const n of ["lima", "oslo"]) {
    const row = w.harness(n).one("SELECT kind, invited_by, used FROM inv WHERE name = 'Scout'");
    assert.deepEqual({ ...row }, { kind: "agent", invited_by: "Pat", used: null });
    for (const t of w.harness(n).all("SELECT token FROM inv").map((x) => x.token)) assert.ok(!r.text.includes(t), "no room token in the answer");
  }
  // the resources the request named are the code's; with none named, both
  const { b: b2 } = await body(pat, ["lima"]);
  b2.params = authzQuery(PUBLIC_APP, (await pkce()).challenge);
  const r2 = await decide(w, { ...b2, rooms: [{ room: "lima", inviter_token: pat.lima }], name: "Scout" });
  assert.equal(r2.status, 200, r2.text);
  const id2 = signins(w).find((x) => x !== id);
  assert.deepEqual(JSON.parse(w.harness(id2).one("SELECT bind FROM aks WHERE kind = 'code'").bind).resources, [ADDRESS, ORIGIN]);
  // resources are a set once normalised: the address named twice, in two spellings, is the address once
  const { b: b3 } = await body(pat, ["lima"]);
  b3.params = authzQuery(PUBLIC_APP, (await pkce()).challenge, { resource: [ADDRESS, "HTTP://LOCALHOST/api/mcp/signin/"] });
  const r3 = await decide(w, { ...b3, rooms: [{ room: "lima", inviter_token: pat.lima }], name: "Scout" });
  assert.equal(r3.status, 200, r3.text);
  const id3 = signins(w).find((x) => x !== id && x !== id2);
  assert.deepEqual(JSON.parse(w.harness(id3).one("SELECT bind FROM aks WHERE kind = 'code'").bind).resources, [ADDRESS]);
});

test("a decline: the deny redirect, nothing made, counted or spent; a pinned address's query kept", async () => {
  const w = makeSigninWorld([PUBLIC_APP, { ...PUBLIC_APP, key: "q", client_id: "https://standin.example/q.json", loopback: false, redirect_uris: ["https://standin.example/cb?t=1"] }]);
  const pat = people(w, ["lima"]);
  const { challenge } = await pkce();
  const q = { kind: "public", client_id: "https://standin.example/q.json", loopback: false, redirect_uris: ["https://standin.example/cb?t=1"] };
  const mark = w.asked.length;
  const r = await decide(w, { params: authzQuery(q, challenge), approve: false });
  assert.equal(r.json.redirect, "https://standin.example/cb?t=1&error=access_denied&state=st-1&iss=http%3A%2F%2Flocalhost");
  assert.ok(!w.asked.slice(mark).some((a) => /signinMake|agentReserve|invite|clientNote|lookupInvite/.test(a.method)), "nothing asked but the app's lookup");
  assert.deepEqual(signins(w), []);
  // the declined request approves afterwards: declining spent nothing
  assert.equal((await decide(w, { params: authzQuery(q, challenge), approve: true, name: "Scout", rooms: [{ room: "lima", inviter_token: pat.lima }] })).status, 200);
});

test("one approval per request: a second is 409 request_used (logged), also when two run at once (exactly one succeeds); a failed approval releases the request", async () => {
  const w = makeSigninWorld();
  const pat = people(w, ["lima", "oslo"]);
  const { b } = await body(pat, ["lima"]);
  assert.equal((await decide(w, b)).status, 200);
  const again = await decide(w, b);
  assert.deepEqual([again.status, again.json], [409, { error: "This sign-in link has already been used to connect.", code: "request_used" }]);
  noCors(again, "409");
  assert.deepEqual((await decide(w, { ...b, check: true })).json, { error: "This sign-in link has already been used to connect.", code: "request_used" }, "a check says so too");
  // two at once
  const { b: b2 } = await body(pat, ["oslo"]);
  const both = await Promise.all([decide(w, b2), decide(w, b2)]);
  assert.deepEqual(both.map((x) => x.status).sort(), [200, 409]);
  // a failure releases it: oslo's room made to fail its invite, then the same link works
  const { b: b3 } = await body(pat, ["lima"], { name: "Other" });
  const lima = w.harness("lima").room, real = lima.invite.bind(lima);
  lima.invite = () => { throw new Error("the room did not answer"); };
  const failed = await decide(w, b3);
  delete lima.invite;
  assert.equal(failed.status, 500, failed.text);
  assert.ok(real);
  assert.equal((await decide(w, b3)).status, 200, "the same link, approved after a failure");
});

test("a failure keeps the invites it made, unopened, names them, and drops the sign-in from its code slot with no version; its places come back", async () => {
  const w = makeSigninWorld();
  const pat = people(w, ["lima", "oslo"]);
  const { b } = await body(pat, ["lima", "oslo"]);
  const oslo = w.harness("oslo").room;
  oslo.invite = () => { throw new Error("the room did not answer"); };
  oslo.members = () => { throw new Error("the room did not answer"); };
  const mark = w.asked.length;
  const r = await decide(w, b);
  assert.equal(r.status, 500);
  assert.deepEqual(r.json, { error: "Room \"oslo\" could not be reached, so no connection was made. Try again.", room: "oslo", left_unused: ["lima"], maybe_unused: ["oslo"], note: unusedNote(["lima"], ["oslo"]) });
  noCors(r, "the failure");
  const drop = w.asked.slice(mark).find((a) => a.method === "signinDrop");
  assert.ok(drop, "dropped");
  assert.equal(drop.args.length, 2, "no version: from the code slot, nothing recorded on it");
  assert.deepEqual(signins(w), [], "nothing of the sign-in is left");
  assert.equal(w.harness("lima").one("SELECT used FROM inv WHERE name = 'Scout'").used, null, "lima's invite stays, unopened");
  const placed = w.asked.slice(mark).find((a) => a.method === "agentReserve");
  const given = w.asked.slice(mark).find((a) => a.method === "agentRelease");
  assert.ok(placed && given, "its places given back");
});

test("a full creation counter: 429 rate_limited with Retry-After, the connection's sentence, no CORS; a check carries retry_after", async () => {
  const w = makeSigninWorld();
  const pat = people(w, ["lima", "oslo"]);
  w.harness(AGENT_QUOTA_ROOM).room.setTestAgentLimits({ per_ip: 1 });
  const { b } = await body(pat, ["lima"]);
  assert.equal((await decide(w, b)).status, 200);
  const { b: b2 } = await body(pat, ["oslo"]);
  const r = await decide(w, b2);
  assert.equal(r.status, 429, r.text);
  assert.equal(r.json.error, "Too many connections were made just now, from this network, for one of these rooms or on the whole site. Try again later.");
  assert.equal(r.json.code, "rate_limited");
  assert.ok(r.json.retry_after > 0 && r.headers.get("Retry-After") === String(r.json.retry_after));
  noCors(r, "429");
  const c = await decide(w, { ...b2, check: true });
  assert.ok(c.json.ok === false && c.json.retry_after > 0, c.text);
  // the 429 released the request: once the counter has room, the same link works
  w.harness(AGENT_QUOTA_ROOM).room.setTestAgentLimits(null);
  assert.equal((await decide(w, b2)).status, 200);
});

test("no Access-Control-Allow-Origin on the OPTIONS of decide and disconnect, and their own on the sign-in's other paths", async () => {
  const w = makeSigninWorld();
  const opt = (path) => WORKER.fetch(new Request(ORIGIN + path, { method: "OPTIONS" }), w.env, { waitUntil() {}, passThroughOnException() {} });
  for (const p of ["/api/oauth/decide", "/api/oauth/disconnect"]) {
    const r = await opt(p);
    assert.equal(r.status, 204);
    assert.equal(r.headers.get("Access-Control-Allow-Origin"), null, p);
  }
  for (const p of ["/api/oauth/token", "/api/oauth/revoke"]) assert.match((await opt(p)).headers.get("Access-Control-Allow-Headers"), /, DPoP$/, p);
  const s = await opt("/api/mcp/signin");
  assert.match(s.headers.get("Access-Control-Allow-Headers"), /Poppy-Session, Poppy-Version, Poppy-Extensions$/);
  assert.match(s.headers.get("Access-Control-Expose-Headers"), /^Retry-After, WWW-Authenticate$/);
  const other = await opt("/api/mcp");
  assert.equal(other.headers.get("Access-Control-Allow-Headers"), "Content-Type, Last-Event-ID, X-Owner-Key, X-Invite-Token, Authorization, MCP-Protocol-Version, Mcp-Method, Mcp-Name", "every other path as before");
  assert.equal(other.headers.get("Access-Control-Expose-Headers"), "Retry-After");
});

test("the approval's code redeems for tokens, and after that the code slot writes nothing: the sign-in's seats as approved", async () => {
  const w = makeSigninWorld();
  const pat = people(w, ["lima"]);
  const s = await signIn(w, PUBLIC_APP, pat);
  assert.equal(s.token.status, 200, s.token.text);
  const [id] = signins(w);
  const h = w.harness(id);
  const code = h.one("SELECT * FROM aks WHERE kind = 'code'");
  assert.equal(code.wrapped, null, "its wrapped data key gone at redemption");
  assert.ok(code.used > 0);
  const a = h.one("SELECT ver, ring, wakes FROM ak");
  const swap = h.room.signinSwap(code.slot, code.verifier, a.ver, a.ring, a.wakes);
  assert.deepEqual(swap, { ok: false }, "a redeemed code swaps nothing");
  assert.ok(clientAuth && token);
});

import { emptySignin } from "../../worker/routes/oauth.ts";
test("with the disconnect-only code switched off, a sign-in has no disconnect slot, so the approval gives the page none", async () => {
  const w = makeSigninWorld();
  const req = { app: PUBLIC_APP, redirect: "http://127.0.0.1:1/callback", state: null, challenge: (await pkce()).challenge, resources: [ADDRESS], jkt: null };
  const off = await emptySignin(w.env, ORIGIN, req, false);
  assert.equal(off.disconnect, null);
  assert.deepEqual(w.harness("__agent-" + off.u.id).all("SELECT kind FROM aks").map((x) => x.kind), ["code"]);
  const on = await emptySignin(w.env, ORIGIN, req);
  assert.match(on.disconnect, /^\.ad1\./);
  assert.deepEqual(w.harness("__agent-" + on.u.id).all("SELECT kind FROM aks ORDER BY kind").map((x) => x.kind), ["code", "disconnect"]);
});
