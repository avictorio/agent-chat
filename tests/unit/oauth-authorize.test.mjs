// GET /oauth/authorize (worker/routes/oauth.ts authorizeRoute): its checks
// in the order the sign-in specifies, on one parse of the query; the two
// fixed pages, which echo nothing, redirect nowhere and fetch nothing; the
// redirecting errors with state and iss, built on the address as pinned;
// loopback on any port; scope by the app's kind; resource; dpop_jkt; the
// headers every answer carries, and no Cross-Origin-Opener-Policy (a popup
// must see its callback). Run with `npm run test:unit`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeSigninWorld, authorize, authzQuery, pkce, PUBLIC_APP, ORIGIN, ADDRESS, poppyApp, SHELL, token, document } from "./signin-world.mjs";
import { read } from "./agent-world.mjs";
import { hookOauthApp } from "../../worker/routes/test-hooks.ts";
import { OAUTH_QUOTA_ROOM, SITE_ORIGIN } from "../../worker/limits.ts";
import { AUTHORIZE_HEADERS } from "../../worker/routes/pages.ts";
import { resetWarnings } from "../../worker/lib/log.ts";
import { KNOWN_APPS } from "../../worker/lib/oauth.ts";

/** the lines logged while f runs, parsed */
async function logged(f) {
  resetWarnings();
  const lines = [], real = console.warn;
  console.warn = (s) => { try { lines.push(JSON.parse(s)); } catch { lines.push(s); } };
  try { await f(); } finally { console.warn = real; }
  return lines;
}
/** global fetch replaced by a recorder for f's run (answering with doc for any URL) */
async function fetched(f, doc) {
  const calls = [], real = globalThis.fetch;
  globalThis.fetch = async (url, init) => { calls.push({ url: String(url), init }); return new Response(JSON.stringify(doc || {}), { status: 200 }); };
  try { await f(); } finally { globalThis.fetch = real; }
  return calls;
}
const params = (url) => Object.fromEntries(new URL(url).searchParams);
const headersOk = (r, what) => {
  for (const [k, v] of Object.entries(AUTHORIZE_HEADERS)) assert.equal(r.headers.get(k), v, what + ": " + k);
  assert.equal(r.headers.get("Cross-Origin-Opener-Policy"), null, what + ": no COOP, so a popup's opener sees its callback");
  assert.equal(r.headers.get("Access-Control-Allow-Origin"), null, what);
};

test("the headers of every authorize answer: frame-ancestors 'none' beside the shell's frame-src, X-Frame-Options DENY, no-store, no-referrer; never Cross-Origin-Opener-Policy", async () => {
  assert.deepEqual(AUTHORIZE_HEADERS, { "Content-Security-Policy": "frame-src 'self' https://www.youtube-nocookie.com; frame-ancestors 'none'", "X-Frame-Options": "DENY", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
  const w = makeSigninWorld();
  const { challenge } = await pkce();
  const shell = await authorize(w, authzQuery(PUBLIC_APP, challenge));
  assert.equal(shell.status, 200);
  assert.ok(shell.text.startsWith("<!doctype html>") && shell.text.includes("<div id=\"root\">"), "the app shell");
  headersOk(shell, "the shell");
  headersOk(await authorize(w, authzQuery({ ...PUBLIC_APP, client_id: "https://nobody.example/c" }, challenge)), "the unknown-app page");
  headersOk(await authorize(w, authzQuery(PUBLIC_APP, challenge, { redirect_uri: "https://evil.example/cb" })), "the wrong-address page");
  headersOk(await authorize(w, authzQuery(PUBLIC_APP, challenge, { response_type: "token" })), "an error redirect");
  const head = await authorize(w, authzQuery(PUBLIC_APP, challenge), "HEAD");
  assert.deepEqual([head.status, head.text], [200, ""]);
  headersOk(head, "HEAD");
  const post = await authorize(w, authzQuery(PUBLIC_APP, challenge), "POST");
  assert.deepEqual([post.status, post.text, post.headers.get("Content-Type"), post.headers.get("Allow")], [405, "Method not allowed", "text/plain; charset=utf-8", "GET, HEAD"]);
  assert.equal(SHELL.includes("frame-ancestors"), false);
});

test("an unknown app: its fixed page (400), no redirect, nothing of the request in it, no fetch, and one counts-only line", async () => {
  const w = makeSigninWorld();
  const { challenge } = await pkce();
  const q = authzQuery({ ...PUBLIC_APP, client_id: "https://muse.example.org/oauth/client" }, challenge, { redirect_uri: "https://muse.example.org/cb?<script>", scope: "rooms", resource: ADDRESS, prompt: "consent" });
  let r;
  const calls = await fetched(async () => {
    const lines = await logged(async () => { r = await authorize(w, q); });
    assert.deepEqual(lines, [{ warn: "oauth.authorize_unknown", error: null, https: true, has_scope: true, has_resource: true, has_prompt: true, has_dpop_jkt: false, redirect_https: true }]);
  });
  assert.deepEqual(calls, [], "nothing fetched");
  assert.equal(r.status, 400);
  assert.equal(r.headers.get("Location"), null);
  assert.ok(r.text.includes("<title>Agent Chat: app not known</title>"));
  assert.ok(r.text.includes("This app isn't known to Agent Chat yet, so it can't connect here. Nothing was shared. If you run this site, SIGNING IN at chat.victorio.cloud/api says how an app is added."));
  for (const echo of ["muse.example.org", "script", "consent", challenge]) assert.ok(!r.text.includes(echo), "echoes nothing: " + echo);
  assert.ok(!/<script|<link|src=|href=/.test(r.text), "loads nothing");
});

test("the wrong-address page: a redirect_uri not the app's, and client_id or redirect_uri sent twice; no redirect, nothing echoed", async () => {
  const w = makeSigninWorld();
  const { challenge } = await pkce();
  const page = "This sign-in link doesn't match the app it names, so it was stopped. Nothing was shared. Start again from the app.";
  for (const [what, extra] of [
    ["another host", { redirect_uri: "https://evil.example/callback" }],
    ["https on loopback", { redirect_uri: "https://127.0.0.1:4000/callback" }],
    ["another path", { redirect_uri: "http://127.0.0.1:4000/other" }],
    ["a non-loopback host on http", { redirect_uri: "http://10.0.0.1:4000/callback" }],
    ["none", { redirect_uri: null }],
    ["client_id twice", { client_id: [PUBLIC_APP.client_id, PUBLIC_APP.client_id] }],
    ["redirect_uri twice", { redirect_uri: ["http://127.0.0.1:4000/callback", "http://127.0.0.1:4001/callback"] }],
  ]) {
    const r = await authorize(w, authzQuery(PUBLIC_APP, challenge, extra));
    assert.equal(r.status, 400, what);
    assert.equal(r.headers.get("Location"), null, what);
    assert.ok(r.text.includes(page), what);
    assert.ok(!r.text.includes("evil") && !r.text.includes("127.0.0.1"), what + ": nothing echoed");
  }
});

test("the order of the checks: duplicates of client_id first, the app, its redirect, then each redirecting error in turn, state and iss on every one", async () => {
  const w = makeSigninWorld();
  const { challenge } = await pkce();
  const unknown = { ...PUBLIC_APP, client_id: "https://nobody.example/c" };
  // client_id twice beats an unknown app; an unknown app beats a wrong redirect; a wrong redirect beats every redirecting error
  assert.ok((await authorize(w, authzQuery(unknown, challenge, { client_id: [unknown.client_id, unknown.client_id] }))).text.includes("doesn't match"));
  assert.ok((await authorize(w, authzQuery(unknown, challenge, { redirect_uri: "https://evil.example/" }))).text.includes("isn't known"));
  assert.ok((await authorize(w, authzQuery(PUBLIC_APP, challenge, { redirect_uri: "https://evil.example/", response_type: "token" }))).text.includes("doesn't match"));
  // then, by redirect, in order
  const cb = "http://127.0.0.1:43123/callback";
  const steps = [
    [{ state: ["a", "b"], response_type: "token" }, "invalid_request", "a"],
    [{ response_type: "token", code_challenge_method: "plain" }, "unsupported_response_type", "st-1"],
    [{ response_type: null }, "unsupported_response_type", "st-1"],
    [{ code_challenge_method: "plain", resource: "https://evil.example" }, "invalid_request", "st-1"],
    [{ code_challenge: "short", resource: "https://evil.example" }, "invalid_request", "st-1"],
    [{ code_challenge: "a".repeat(129) }, "invalid_request", "st-1"],
    [{ code_challenge: null }, "invalid_request", "st-1"],
    [{ resource: "https://evil.example", dpop_jkt: "x" }, "invalid_target", "st-1"],
    [{ dpop_jkt: "x" }, "invalid_request", "st-1"],
  ];
  for (const [extra, error, state] of steps) {
    const r = await authorize(w, authzQuery(PUBLIC_APP, challenge, extra));
    assert.equal(r.status, 302, JSON.stringify(extra));
    const loc = r.headers.get("Location");
    assert.ok(loc.startsWith(cb + "?"), loc);
    assert.deepEqual(params(loc), { error, state, iss: ORIGIN }, JSON.stringify(extra));
  }
  // no state sent: none in the redirect, iss still
  assert.deepEqual(params((await authorize(w, authzQuery(PUBLIC_APP, challenge, { state: null, response_type: "token" }))).headers.get("Location")), { error: "unsupported_response_type", iss: ORIGIN });
});

test("parameters sent twice: client_id and redirect_uri are the wrong-address page; state, scope, code_challenge and response_type are invalid_request by redirect; resource may repeat, each value checked", async () => {
  const w = makeSigninWorld();
  const { challenge } = await pkce();
  for (const k of ["state", "scope", "code_challenge", "response_type", "code_challenge_method", "prompt"]) {
    const v = k === "code_challenge" ? challenge : k === "response_type" ? "code" : k === "code_challenge_method" ? "S256" : "rooms";
    const r = await authorize(w, authzQuery(PUBLIC_APP, challenge, { [k]: [v, v] }));
    assert.equal(r.status, 302, k);
    const p = params(r.headers.get("Location"));
    assert.equal(p.error, "invalid_request", k);
    assert.equal(p.state, k === "state" ? "rooms" : "st-1", k + ": state's first value when state is the one sent twice");
  }
  // resource twice with both offered values: accepted (the shell); with one unknown: invalid_target
  const both = await authorize(w, authzQuery(PUBLIC_APP, challenge, { resource: [ADDRESS, ORIGIN] }));
  assert.equal(both.status, 200);
  const one = await authorize(w, authzQuery(PUBLIC_APP, challenge, { resource: [ADDRESS, "https://evil.example"] }));
  assert.equal(params(one.headers.get("Location")).error, "invalid_target");
});

test("resource: the sign-in address or the domain, with an upper-case scheme or host or a trailing slash; nothing else", async () => {
  const w = makeSigninWorld();
  const { challenge } = await pkce();
  for (const ok of [ADDRESS, ORIGIN, ORIGIN + "/", "HTTP://LOCALHOST/api/mcp/signin", ADDRESS + "/", "http://Localhost"]) {
    assert.equal((await authorize(w, authzQuery(PUBLIC_APP, challenge, { resource: ok }))).status, 200, ok);
  }
  for (const bad of [ORIGIN + "/api/mcp", ORIGIN + "/API/MCP/SIGNIN", ADDRESS + "?x=1", ADDRESS + "#f", "http://localhost:8080/api/mcp/signin", "https://localhost/api/mcp/signin", "rooms"]) {
    const r = await authorize(w, authzQuery(PUBLIC_APP, challenge, { resource: bad }));
    assert.equal(params(r.headers.get("Location")).error, "invalid_target", bad);
  }
});

test("a parameter sent without a value is treated as omitted (RFC 6749 3.1): resource=, dpop_jkt= and scope= pass as absent, state= is echoed as no state, an empty client_id is the unknown app; decide reads the query the same way", async () => {
  const w = makeSigninWorld();
  const { challenge } = await pkce();
  for (const extra of [{ resource: "" }, { dpop_jkt: "" }, { scope: "" }, { resource: ["", ADDRESS] }]) {
    assert.equal((await authorize(w, authzQuery(PUBLIC_APP, challenge, extra))).status, 200, JSON.stringify(extra));
  }
  const r = await authorize(w, authzQuery(PUBLIC_APP, challenge, { state: "", response_type: "token" }));
  assert.deepEqual(Object.keys(params(r.headers.get("Location"))), ["error", "iss"], "state= is no state: none echoed");
  assert.ok((await authorize(w, authzQuery(PUBLIC_APP, challenge, { client_id: "" }))).text.includes("<title>Agent Chat: app not known</title>"));
  // decide: resource= is no resource, so the code is bound to both offered resources
  const { decide, people, signins } = await import("./signin-world.mjs");
  const pat = people(w, ["lima"]);
  const d = await decide(w, { params: authzQuery(PUBLIC_APP, challenge, { resource: "", dpop_jkt: "" }), approve: true, name: "Scout", rooms: [{ room: "lima", inviter_token: pat.lima }] });
  assert.equal(d.status, 200, d.text);
  const bind = JSON.parse(w.harness(signins(w)[0]).one("SELECT bind FROM aks WHERE kind = 'code'").bind);
  assert.deepEqual([bind.resources, bind.jkt], [[ADDRESS, ORIGIN], undefined]);
});

test("an exact redirect entry matches only itself: a path below it, a query, a fragment or a dot segment after it is the wrong-address page", async () => {
  const P = await poppyApp();
  const w = makeSigninWorld([P.app]);
  const { challenge } = await pkce();
  const entry = P.app.redirect_uris[0];
  assert.equal((await authorize(w, authzQuery(P.app, challenge, { redirect_uri: entry }))).status, 200, "the entry itself");
  for (const near of [entry + "/x", entry + "?y=1", entry + "#f", entry + "/../x"]) {
    const r = await authorize(w, authzQuery(P.app, challenge, { redirect_uri: near }));
    assert.deepEqual([r.status, r.headers.get("Location")], [400, null], near);
    assert.ok(r.text.includes("<title>Agent Chat: sign-in stopped</title>"), near);
  }
});

test("loopback on any port, with the pinned path, on 127.0.0.1 or localhost; an exact app's address exactly; a pinned address's own query kept by every redirect", async () => {
  const w = makeSigninWorld([PUBLIC_APP, { ...PUBLIC_APP, key: "standin-q", client_id: "https://standin.example/q.json", loopback: false, redirect_uris: ["https://standin.example/cb?tenant=a&x=1"] }]);
  const { challenge } = await pkce();
  for (const cb of ["http://127.0.0.1:1/callback", "http://127.0.0.1:65535/callback", "http://localhost:3000/callback", "http://127.0.0.1/callback"]) {
    assert.equal((await authorize(w, authzQuery(PUBLIC_APP, challenge, { redirect_uri: cb }))).status, 200, cb);
  }
  const q = { key: "standin-q", client_id: "https://standin.example/q.json", loopback: false, redirect_uris: ["https://standin.example/cb?tenant=a&x=1"], kind: "public" };
  assert.equal((await authorize(w, authzQuery(q, challenge))).status, 200);
  assert.equal((await authorize(w, authzQuery(q, challenge, { redirect_uri: "https://standin.example/cb" }))).status, 400, "the query is part of the pinned address");
  const loc = (await authorize(w, authzQuery(q, challenge, { response_type: "token" }))).headers.get("Location");
  assert.equal(loc, "https://standin.example/cb?tenant=a&x=1&error=unsupported_response_type&state=st-1&iss=http%3A%2F%2Flocalhost", "appended by URLSearchParams to the pinned address, its query kept");
});

test("scope: a poppy app must name rooms (missing or any other value is invalid_scope); a public app's is rooms whatever it sends", async () => {
  const { app } = await poppyApp();
  const w = makeSigninWorld([PUBLIC_APP, app]);
  const { challenge } = await pkce();
  assert.equal((await authorize(w, authzQuery(app, challenge))).status, 200);
  for (const s of [null, "", "rooms offline_access", "admin", "ROOMS"]) {
    const r = await authorize(w, authzQuery(app, challenge, { scope: s }));
    assert.equal(params(r.headers.get("Location")).error, "invalid_scope", String(s));
  }
  for (const s of [null, "rooms", "openid profile", "rooms offline_access"]) assert.equal((await authorize(w, authzQuery(PUBLIC_APP, challenge, { scope: s }))).status, 200, String(s));
});

test("dpop_jkt: 43 characters of base64url, else invalid_request; prompt, nonce and unknown parameters pass", async () => {
  const w = makeSigninWorld();
  const { challenge } = await pkce();
  assert.equal((await authorize(w, authzQuery(PUBLIC_APP, challenge, { dpop_jkt: "A".repeat(43) }))).status, 200);
  for (const bad of ["A".repeat(42), "A".repeat(44), "A".repeat(42) + "+"]) assert.equal(params((await authorize(w, authzQuery(PUBLIC_APP, challenge, { dpop_jkt: bad }))).headers.get("Location")).error, "invalid_request", bad);
  assert.equal((await authorize(w, authzQuery(PUBLIC_APP, challenge, { prompt: "consent", nonce: "n", whatever: "x" }))).status, 200);
});

test("on a test server (TEST_HOOKS) an authorize for a pinned app fetches nothing: its document is not compared", async () => {
  const w = makeSigninWorld();
  const { challenge } = await pkce();
  const calls = await fetched(async () => {
    for (const app of KNOWN_APPS) assert.equal((await authorize(w, authzQuery(app, challenge, { redirect_uri: app.loopback ? "http://127.0.0.1:43123/callback" : app.redirect_uris[0] }))).status, 200, app.key);
    await Promise.all(w.pending);
  });
  assert.deepEqual(calls, [], "no fetch at all");
  assert.equal(w.pending.length, 0, "nothing left to run in the background");
});

test("a pinned app's document is compared in the background, at most once a day per isolate, with no redirect; a difference is one counts-only line; a stand-in's never is", async () => {
  // a live server: TEST_HOOKS off, fetch replaced by the recorder
  const w = makeSigninWorld([], { env: { TEST_HOOKS: undefined } });
  const { challenge } = await pkce();
  const claude = KNOWN_APPS.find((a) => a.key === "claude");
  const same = { client_id: claude.client_id, client_name: "Claude", redirect_uris: ["https://claude.ai/api/mcp/auth_callback"], grant_types: ["authorization_code", "refresh_token", "urn:ietf:params:oauth:grant-type:jwt-bearer"], token_endpoint_auth_method: "none" };
  let calls = await fetched(async () => {
    const lines = await logged(async () => {
      assert.equal((await authorize(w, authzQuery(claude, challenge, { redirect_uri: claude.redirect_uris[0] }))).status, 200);
      await Promise.all(w.pending);
    });
    assert.deepEqual(lines, [], "the same document: nothing logged");
  }, same);
  assert.deepEqual(calls.map((c) => [c.url, c.init.redirect, "credentials" in c.init]), [[claude.client_id, "manual", false]], "no redirects followed, and no credentials field (a Worker's fetch sends no cookie)");
  calls = await fetched(async () => { await authorize(w, authzQuery(claude, challenge, { redirect_uri: claude.redirect_uris[0] })); await Promise.all(w.pending); }, same);
  assert.deepEqual(calls, [], "once a day per isolate");
  const code = KNOWN_APPS.find((a) => a.key === "claude-code");
  calls = await fetched(async () => {
    const lines = await logged(async () => { await authorize(w, authzQuery(code, challenge)); await Promise.all(w.pending); });
    assert.deepEqual(lines, [{ warn: "oauth.client_changed", error: null, app: "claude-code" }], "a difference: the app's key, nothing else");
  }, { ...same, client_id: code.client_id, client_name: "Claude Code (new)" });
  assert.equal(calls.length, 1);
  const w2 = makeSigninWorld();
  calls = await fetched(async () => { assert.equal((await authorize(w2, authzQuery(PUBLIC_APP, challenge))).status, 200); await Promise.all(w2.pending); });
  assert.deepEqual(calls, [], "a stand-in is never fetched");
});

test("the stand-in apps and the local origin only under TEST_HOOKS: a stand-in stored under it is no known app once the Worker or its object runs without it, the issuer is then the site's whatever TEST_SIGNIN_ORIGIN says, and the hook that stores one answers 404", async () => {
  const { challenge } = await pkce();
  const unknownPage = async (w) => { const r = await authorize(w, authzQuery(PUBLIC_APP, challenge)); return r.status === 400 && r.text.includes("<title>Agent Chat: app not known</title>"); };
  // stored under TEST_HOOKS, then a Worker without it: not known, invalid_client, the site's issuer and resource
  const w = makeSigninWorld([PUBLIC_APP]);
  assert.equal((await authorize(w, authzQuery(PUBLIC_APP, challenge))).status, 200, "known under TEST_HOOKS");
  delete w.env.TEST_HOOKS;
  assert.ok(await unknownPage(w), "a Worker without TEST_HOOKS");
  const t = await token(w, { grant_type: "authorization_code", client_id: PUBLIC_APP.client_id, code: "x" });
  assert.deepEqual([t.status, t.json.error], [401, "invalid_client"]);
  assert.equal((await document(w, "/.well-known/oauth-authorization-server")).json.issuer, SITE_ORIGIN);
  assert.equal((await document(w, "/.well-known/oauth-protected-resource/api/mcp/signin")).json.resource, SITE_ORIGIN + "/api/mcp/signin");
  assert.equal((await read(hookOauthApp(w.rc("POST", "/api/test-hooks/oauth-app", { owner: true, json: { app: PUBLIC_APP } })))).status, 404);
  // the object that holds it, without TEST_HOOKS, answers none and stores none
  const w2 = makeSigninWorld([PUBLIC_APP]);
  const q = w2.harness(OAUTH_QUOTA_ROOM).room;
  delete q.env.TEST_HOOKS;
  assert.ok(await unknownPage(w2), "an object without TEST_HOOKS");
  assert.deepEqual(q.setTestOauthApp(PUBLIC_APP), { error: "Not found" });
  // under TEST_HOOKS, an origin that is not http on a loopback host is not taken
  const odd = makeSigninWorld([PUBLIC_APP], { env: { TEST_SIGNIN_ORIGIN: "https://example.org" } });
  assert.equal((await document(odd, "/.well-known/oauth-authorization-server")).json.issuer, SITE_ORIGIN);
  assert.equal((await document(makeSigninWorld(), "/.well-known/oauth-authorization-server")).json.issuer, ORIGIN);
});
