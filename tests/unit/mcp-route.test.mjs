// The MCP route (worker/routes/agents.ts mcpRoute) before it reaches the
// room: what a caller with no token costs. The room is a stand-in that
// counts what it is asked; nothing else runs.
import test from "node:test";
import assert from "node:assert/strict";
import { mcpRoute } from "../../worker/routes/agents.ts";

// Node wants duplex: "half" on a Request built with a stream body, which
// settleBody (lib/http.ts) makes; the Workers runtime does not.
const NodeRequest = globalThis.Request;
globalThis.Request = class extends NodeRequest {
  constructor(input, init) { super(input, init && init.body && typeof init.body.getReader === "function" ? { duplex: "half", ...init } : init); }
};

/** a route context for POST /api/rooms/unit/mcp with that body and token
 *  (the header token, as index.ts reads it), and that query string */
function call(body, invite, search) {
  const asked = [];
  const stub = new Proxy({}, { get: (_, name) => async (...args) => { asked.push(String(name)); if (name === "lookupInvite") return { ok: false, status: 403, code: "invite_invalid", error: "This invite link isn't valid for this room." }; throw new Error("unexpected call " + String(name) + " " + JSON.stringify(args)); } });
  const env = { ROOM: { idFromName: (n) => n, get: () => stub } };
  const url = new URL("http://localhost/api/rooms/unit/mcp" + (search || ""));
  const request = new Request(url, { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });
  const m = /^\/api\/rooms\/([^/]+)\/mcp$/.exec(url.pathname);
  return { asked, res: mcpRoute({ request, env, url, path: url.pathname, owner: false, invite }, m) };
}

test("a tokenless initialize, ping or notification asks the room nothing", async () => {
  for (const body of [{ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, { jsonrpc: "2.0", id: 2, method: "ping" }, { jsonrpc: "2.0", method: "notifications/initialized" }]) {
    const { asked, res } = call(body, "");
    const r = await res;
    assert.ok(r.status === 200 || r.status === 202, body.method + " answered " + r.status);
    assert.deepEqual(asked, [], body.method + " made no Durable Object call");
  }
});

test("a tokenless tools/list or batch is refused invite_missing without asking the room", async () => {
  let { asked, res } = call({ jsonrpc: "2.0", id: 1, method: "tools/list" }, "");
  let j = await (await res).json();
  assert.equal(j.error.code, -32001);
  assert.equal(j.error.data.code, "invite_missing");
  assert.deepEqual(asked, []);
  ({ asked, res } = call([{ jsonrpc: "2.0", id: 1, method: "ping" }], ""));
  const r = await res;
  assert.equal(r.status, 400);
  j = await r.json();
  assert.equal(j.error.data.code, "invite_missing");
  assert.deepEqual(asked, []);
});

test("a token that was sent is still looked up, once", async () => {
  const { asked, res } = call({ jsonrpc: "2.0", id: 1, method: "tools/list" }, "tok-nobody");
  const j = await (await res).json();
  assert.equal(j.error.data.code, "invite_invalid");
  assert.deepEqual(asked, ["lookupInvite"]);
});

// No route reads a token in the URL (lib/tokens.ts): a request that sent
// only ?invite= is refused as tokenless, without asking the room, and its
// sentence says where the token goes. A tool call is refused the same way
// (with no token, access() could only say invite_missing).
test("a token only in the URL is refused as no token, its sentence saying to use the header", async () => {
  const calls = [
    { jsonrpc: "2.0", id: 1, method: "tools/list" },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "whoami", arguments: {} } },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "get_invite", arguments: {} } },
  ];
  for (const body of calls) {
    const { asked, res } = call(body, "", "?invite=tok-in-the-url");
    const r = await res;
    assert.equal(r.status, 200);
    const j = await r.json();
    const what = body.method + " " + (body.params ? body.params.name : "");
    assert.equal(j.error.code, -32001, what);
    assert.equal(j.error.data.code, "invite_missing", what);
    assert.match(j.error.message, /no longer read/, what);
    assert.match(j.error.message, /X-Invite-Token/, what);
    assert.deepEqual(asked, [], what + " asked the room nothing");
  }
  const { asked, res } = call([{ jsonrpc: "2.0", id: 1, method: "ping" }], "", "?invite=tok-in-the-url");
  const r = await res;
  assert.equal(r.status, 400);
  const j = await r.json();
  assert.equal(j.error.data.code, "invite_missing");
  assert.match(j.error.message, /no longer read/);
  assert.deepEqual(asked, []);
});

// A tokenless body is held to SMALL_BODY_MAX. A caller whose only token is
// in the URL did not know it was tokenless: the 413 says why too.
test("a body too big for a caller whose only token is in the URL says the URL token is not read", async () => {
  const big = { jsonrpc: "2.0", id: 1, method: "initialize", params: { pad: "x".repeat(1100 * 1024) } };
  let r = await call(big, "", "?invite=tok-in-the-url").res;
  assert.equal(r.status, 413);
  let j = await r.json();
  assert.equal(j.error.code, -32600);
  assert.match(j.error.message, /Request too large/);
  assert.match(j.error.message, /no longer read/);
  assert.match(j.error.message, /X-Invite-Token/);
  r = await call(big, "").res;
  assert.equal(r.status, 413);
  j = await r.json();
  assert.doesNotMatch(j.error.message, /no longer read/, "with no URL token, the sentence is only about size");
});
