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

/** a route context for POST /api/rooms/unit/mcp with that body and token */
function call(body, invite) {
  const asked = [];
  const stub = new Proxy({}, { get: (_, name) => async (...args) => { asked.push(String(name)); if (name === "lookupInvite") return { ok: false, status: 403, code: "invite_invalid", error: "This invite link isn't valid for this room." }; throw new Error("unexpected call " + String(name) + " " + JSON.stringify(args)); } });
  const env = { ROOM: { idFromName: (n) => n, get: () => stub } };
  const url = new URL("http://localhost/api/rooms/unit/mcp");
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
