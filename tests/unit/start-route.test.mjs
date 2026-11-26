// The room's own address (worker/routes/rooms.ts roomRoute): GET and HEAD
// are the start page (routes/agents.ts startPageRoute), POST and DELETE stay
// the owner's. The room is a stand-in that records what it is asked: the
// page is a look, so access() is never asked, and a missing room is 404
// before any token is looked at. Run with `npm run test:unit`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { roomRoute } from "../../worker/routes/rooms.ts";
import { OWNER_NO_START_PAGE, START_INVALID, START_NO_TOKEN, startPage } from "../../worker/agents/start.ts";
import { watcherPin } from "../../worker/agents/docs.ts";
import { base, joined } from "./start-views.mjs";

const ORIGIN = "http://localhost";
/** the watcher's version and SHA-256 at ORIGIN, which the page's step 3c prints */
const PIN = await watcherPin(ORIGIN);
const INVALID = { ok: false, status: 403, code: "invite_invalid", error: "This invite link isn't valid for this room." };
const REVOKED = { ok: false, status: 403, code: "invite_revoked", error: "This invite link has been revoked. Ask whoever gave it to you for a new one." };
const MISSING_ROOM = { error: "No room with that name yet. Create it from the home page." };

/** A request to /api/rooms/unit (or the path given): method, the header
 *  token (as index.ts reads it), the owner key, the query string; exists
 *  is what the stand-in room says, view what its startView answers. */
async function call(method, { invite = "", owner = false, search = "", exists = true, view = joined, path = "/api/rooms/unit" } = {}) {
  const asked = [];
  const stub = new Proxy({}, {
    get: (_, name) => async (...args) => {
      asked.push([String(name), ...args]);
      if (name === "exists") return exists;
      if (name === "startView") return view;
      if (name === "create") return true;
      throw new Error("unexpected call " + String(name));
    },
  });
  const env = { ROOM: { idFromName: (n) => n, get: () => stub } };
  const url = new URL(ORIGIN + path + search);
  const request = new Request(url, { method });
  const rm = url.pathname.match(/^\/(?:r|api\/rooms)\/([^/]+)/);
  const res = await roomRoute({ request, env, url, path: url.pathname, owner, invite, ctx: { waitUntil() {} } }, rm);
  // a path below the room's address goes on to its own route
  if (res === undefined) return { res, text: "", body: null, asked, names: asked.map((a) => a[0]) };
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* the page is text */ }
  return { res, text, body, asked, names: asked.map((a) => a[0]) };
}

test("GET with a good token is the page: text, no-store, CORS, startPage of the room's view", async () => {
  for (const view of [base, joined]) {
    const r = await call("GET", { invite: "tok-good", view });
    assert.equal(r.res.status, 200);
    assert.equal(r.res.headers.get("Content-Type"), "text/plain; charset=utf-8");
    assert.equal(r.res.headers.get("Cache-Control"), "no-store");
    assert.equal(r.res.headers.get("Access-Control-Allow-Origin"), "*");
    assert.equal(r.text, startPage(view, ORIGIN, "unit", PIN));
    assert.deepEqual(r.asked, [["exists"], ["startView", "tok-good", "unit"]], "a look: no access()");
  }
});

test("HEAD answers GET's status and headers without the text", async () => {
  const get = await call("GET", { invite: "tok-good" });
  const head = await call("HEAD", { invite: "tok-good" });
  assert.equal(head.res.status, 200);
  assert.equal(head.text, "");
  for (const h of ["Content-Type", "Cache-Control", "Access-Control-Allow-Origin"]) assert.equal(head.res.headers.get(h), get.res.headers.get(h), h);
  assert.ok(!head.names.includes("access"));
  const refused = await call("HEAD", {});
  assert.equal(refused.res.status, 401);
});

test("the refusals: no token 401, the owner key alone 400, the lookup's 403s, each JSON and no-store", async () => {
  let r = await call("GET", {});
  assert.equal(r.res.status, 401);
  assert.deepEqual(r.body, { error: START_NO_TOKEN, code: "invite_missing" });
  assert.deepEqual(r.names, ["exists"], "no token: the room is asked nothing more");
  r = await call("GET", { owner: true });
  assert.equal(r.res.status, 400);
  assert.deepEqual(r.body, { error: OWNER_NO_START_PAGE });
  assert.deepEqual(r.names, ["exists"]);
  // a token that is none of the room's invites gets the page's own
  // sentence (the room's names a link); a revoked one keeps the room's
  for (const [view, want, error] of [[INVALID, "invite_invalid", START_INVALID], [REVOKED, "invite_revoked", REVOKED.error]]) {
    r = await call("GET", { invite: "tok-x", view });
    assert.equal(r.res.status, 403, want);
    assert.deepEqual(r.body, { error, code: want });
    assert.ok(!r.names.includes("access"), want);
  }
  for (const [m, o] of [["GET", {}], ["GET", { owner: true }], ["GET", { invite: "tok-x", view: REVOKED }]]) {
    r = await call(m, o);
    assert.equal(r.res.headers.get("Content-Type"), "application/json; charset=utf-8");
    assert.equal(r.res.headers.get("Cache-Control"), "no-store");
  }
});

// No route reads a token in the URL (lib/tokens.ts): the request is
// answered exactly as one with no token, with no notice field.
test("a token only in the URL is answered as no token", async () => {
  const url = await call("GET", { search: "?invite=tok-in-the-url" });
  const bare = await call("GET", {});
  assert.equal(url.res.status, 401);
  assert.equal(url.text, bare.text);
  assert.ok(!("notice" in url.body));
  for (const h of ["Deprecation", "Sunset", "Link"]) assert.equal(url.res.headers.get(h), null, h);
});

// Calls that carry the key act as the owner (Room.access): they join
// nothing and a post needs "from", so the token's page says so first.
test("the owner key with a token gets that token's page, opening with the owner-key line", async () => {
  const r = await call("GET", { owner: true, invite: "tok-good" });
  assert.equal(r.res.status, 200);
  assert.equal(r.text, startPage(joined, ORIGIN, "unit", PIN, undefined, true));
  assert.ok(r.text.startsWith("Agent Chat start page: \"Scout\" in the room \"unit\"\n\nThis request also carried the owner key. Calls that carry it act as the owner, not as \"Scout\":"), r.text.slice(0, 200));
  const alone = (await call("GET", { invite: "tok-good" })).text;
  assert.ok(!alone.includes("owner key. Calls"), "a token alone gets no such line");
  assert.equal(r.text.replace(/\n\nThis request also carried the owner key\.[^\n]*/, ""), alone, "the rest is the token's page");
  assert.deepEqual(r.asked, [["exists"], ["startView", "tok-good", "unit"]]);
});

test("a missing room is 404 before any token is looked at", async () => {
  for (const o of [{}, { invite: "tok-good" }, { owner: true }, { owner: true, invite: "tok-good" }]) {
    for (const m of ["GET", "HEAD"]) {
      const r = await call(m, { ...o, exists: false });
      assert.equal(r.res.status, 404, m + " " + JSON.stringify(o));
      if (m === "GET") assert.deepEqual(r.body, MISSING_ROOM);
      assert.deepEqual(r.names, ["exists"], "startView never asked");
    }
  }
});

test("POST and DELETE stay the owner's, other methods 405, as before", async () => {
  let r = await call("POST", { invite: "tok-good" });
  assert.equal(r.res.status, 403);
  assert.deepEqual(r.body, { error: "Creating or deleting a room needs the owner key" });
  r = await call("DELETE", { invite: "tok-good" });
  assert.equal(r.res.status, 403);
  for (const m of ["PUT", "PATCH"]) {
    for (const owner of [false, true]) {
      r = await call(m, { owner, invite: "tok-good" });
      assert.equal(r.res.status, 405, m);
      assert.deepEqual(r.body, { error: "Method not allowed" });
    }
  }
  r = await call("POST", { owner: true });
  assert.equal(r.res.status, 409, "the room exists");
  r = await call("POST", { owner: true, exists: false });
  assert.equal(r.res.status, 201);
  assert.deepEqual(r.names, ["exists", "create"]);
  r = await call("DELETE", { owner: true });
  assert.equal(r.res.status, 400, "no confirm");
  for (const [m, o] of [["POST", { owner: true }], ["DELETE", { owner: true }], ["PUT", { invite: "tok-good" }]]) assert.ok(!(await call(m, o)).names.includes("startView"), m);
});

test("the address with a trailing slash is the same page; a deeper path is not", async () => {
  const r = await call("GET", { invite: "tok-good", path: "/api/rooms/unit/" });
  assert.equal(r.res.status, 200);
  assert.equal(r.text, startPage(joined, ORIGIN, "unit", PIN));
  const deeper = await call("GET", { invite: "tok-good", path: "/api/rooms/unit/welcome" });
  assert.equal(deeper.res, undefined, "roomRoute leaves it to the router");
  assert.deepEqual(deeper.names, ["exists"]);
});

// The web app's agent gate shows the start page ("What your agent reads
// first") through the contract client's startPage(): GET of the room's own
// address with the device's token in the header, through the Worker's
// router. It gets the page as text, the room is only looked at (no
// access(), so an unused invite stays unused), and a refusal comes back as
// an ApiError with the room's status and sentence.
import WORKER from "../../worker/index.ts";
import { ApiError, RoomClient } from "../../contract/src/client.ts";
test("the web app's startPage() reads the page through the router as a look, and a refusal as an ApiError", async () => {
  const realFetch = globalThis.fetch;
  const asked = [];
  let view = base;
  const stub = new Proxy({}, { get: (_, name) => async (...args) => { asked.push([String(name), ...args]); if (name === "exists") return true; if (name === "startView") return view; throw new Error("unexpected call " + String(name)); } });
  const env = { ROOM: { idFromName: (n) => n, get: () => stub } };
  const sent = [];
  globalThis.fetch = async (input, init) => {
    const req = new Request(new URL(String(input), ORIGIN), init);
    sent.push([req.method, new URL(req.url).pathname, req.headers.get("x-invite-token")]);
    return WORKER.fetch(req, env, { waitUntil() {}, passThroughOnException() {} });
  };
  try {
    const text = await new RoomClient("unit", "tok-good").startPage();
    assert.equal(text, startPage(base, ORIGIN, "unit", PIN));
    assert.deepEqual(sent, [["GET", "/api/rooms/unit", "tok-good"]], "GET of the room's own address, the token in the header");
    assert.deepEqual(asked.map((a) => a[0]), ["exists", "startView"], "a look: no access()");
    view = INVALID;
    await assert.rejects(new RoomClient("unit", "tok-bad").startPage(), (e) => e instanceof ApiError && e.status === 403 && e.message === START_INVALID);
    await assert.rejects(new RoomClient("unit", null).startPage(), (e) => e instanceof ApiError && e.status === 401 && e.message === START_NO_TOKEN);
    assert.ok(!asked.some((a) => a[0] === "access"), "nothing ran access()");
  } finally {
    globalThis.fetch = realFetch;
  }
});
