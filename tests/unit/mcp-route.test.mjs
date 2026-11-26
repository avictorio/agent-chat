// The MCP route (worker/routes/agents.ts mcpRoute) before it reaches the
// room: what a caller with no token costs. The room is a stand-in that
// counts what it is asked; nothing else runs.
import test from "node:test";
import assert from "node:assert/strict";
import { mcpRoute } from "../../worker/routes/agents.ts";
import { MCP_NO_TOKEN, mcpInstructions } from "../../worker/agents/onboarding.ts";
import { MCP_CATALOG_VERSION } from "../../worker/agents/mcp.ts";
import { API_VERSION } from "../../worker/agents/notices.ts";

// Node wants duplex: "half" on a Request built with a stream body, which
// settleBody (lib/http.ts) makes; the Workers runtime does not.
const NodeRequest = globalThis.Request;
globalThis.Request = class extends NodeRequest {
  constructor(input, init) { super(input, init && init.body && typeof init.body.getReader === "function" ? { duplex: "half", ...init } : init); }
};

/** a route context for POST /api/rooms/unit/mcp with that body and token
 *  (the header token, as index.ts reads it), and that query string; lookup
 *  is what the stand-in's lookupInvite answers (invite_invalid unless given),
 *  owner whether the request carries the owner key */
function call(body, invite, search, lookup, owner) {
  const asked = [];
  const found = lookup || { ok: false, status: 403, code: "invite_invalid", error: "This invite link isn't valid for this room." };
  const stub = new Proxy({}, { get: (_, name) => async (...args) => { asked.push(String(name)); if (name === "lookupInvite") return found; throw new Error("unexpected call " + String(name) + " " + JSON.stringify(args)); } });
  const env = { ROOM: { idFromName: (n) => n, get: () => stub } };
  const url = new URL("http://localhost/api/rooms/unit/mcp" + (search || ""));
  const request = new Request(url, { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });
  const m = /^\/api\/rooms\/([^/]+)\/mcp$/.exec(url.pathname);
  return { asked, res: mcpRoute({ request, env, url, path: url.pathname, owner: !!owner, invite }, m) };
}
const ORIGIN = "http://localhost";
const INIT = { jsonrpc: "2.0", id: 1, method: "initialize", params: {} };
const REVOKED = { ok: false, status: 403, code: "invite_revoked", error: "This invite link has been revoked. Ask whoever gave it to you for a new one." };
const GOOD = { ok: true, row: { name: "Ada", revoked: null, used: null, seen: null, kind: "agent", invited_by: null, created: 1, posted: null } };

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
  assert.equal(j.error.message, MCP_NO_TOKEN, "MCP's own sentence, not the REST one about opening the link");
  assert.deepEqual(asked, []);
  ({ asked, res } = call([{ jsonrpc: "2.0", id: 1, method: "ping" }], ""));
  const r = await res;
  assert.equal(r.status, 400);
  j = await r.json();
  assert.equal(j.error.data.code, "invite_missing");
  assert.ok(j.error.message.includes(MCP_NO_TOKEN), j.error.message);
  assert.deepEqual(asked, []);
});

test("a token that was sent is still looked up, once", async () => {
  const { asked, res } = call({ jsonrpc: "2.0", id: 1, method: "tools/list" }, "tok-nobody");
  const j = await (await res).json();
  assert.equal(j.error.data.code, "invite_invalid");
  assert.deepEqual(asked, ["lookupInvite"]);
});

// No route reads a token in the URL (lib/tokens.ts): a request that sent
// only ?invite= is answered exactly as one that sent none, without asking
// the room. A tool call is refused the same way (with no token, access()
// could only say invite_missing).
test("a token only in the URL is answered as no token", async () => {
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
    assert.equal(j.error.message, MCP_NO_TOKEN, what);
    assert.deepEqual(asked, [], what + " asked the room nothing");
  }
  const { asked, res } = call([{ jsonrpc: "2.0", id: 1, method: "ping" }], "", "?invite=tok-in-the-url");
  const r = await res;
  assert.equal(r.status, 400);
  const j = await r.json();
  assert.equal(j.error.code, -32600);
  assert.equal(j.error.data.code, "invite_missing");
  assert.ok(j.error.message.includes(MCP_NO_TOKEN), j.error.message);
  assert.ok(!j.error.message.includes("?invite="), j.error.message);
  assert.deepEqual(asked, []);
});

// A tokenless body is held to SMALL_BODY_MAX, and the 413 says only that,
// a URL token or not.
test("a body too big without a header token gets the same size sentence, a URL token or not", async () => {
  const big = { jsonrpc: "2.0", id: 1, method: "initialize", params: { pad: "x".repeat(1100 * 1024) } };
  const a = await call(big, "", "?invite=tok-in-the-url").res;
  const b = await call(big, "").res;
  assert.equal(a.status, 413);
  assert.equal(b.status, 413);
  const ja = await a.json(), jb = await b.json();
  assert.equal(ja.error.code, -32600);
  assert.equal(ja.error.message, jb.error.message);
  assert.match(ja.error.message, /^Request too large: without a valid invite token a request can be up to \d+ MiB$/);
  assert.doesNotMatch(ja.error.message, /no longer read|\?invite=/);
});

/** initialize's result, and what the room was asked */
async function initialize(invite, search, lookup, owner) {
  const { asked, res } = call(INIT, invite, search, lookup, owner);
  const r = await res;
  assert.equal(r.status, 200);
  return { asked, result: (await r.json()).result };
}

// initialize answers anyone and opens nothing; its instructions follow what
// the token turned out to be (the one lookup the route makes), and changes
// is a link to the feed, not the feed, which was most of the answer.
test("initialize's instructions follow the token, from one lookup at most", async () => {
  for (const [invite, search] of [["", ""], ["", "?invite=tok-in-the-url"]]) {
    const { asked, result } = await initialize(invite, search);
    assert.equal(result.instructions, mcpInstructions(ORIGIN, "none"), "no header token" + search);
    assert.deepEqual(asked, [], "asked the room nothing" + search);
  }
  for (const [lookup, variant] of [[undefined, "invalid"], [REVOKED, "revoked"], [GOOD, "ok"]]) {
    const { asked, result } = await initialize("tok-x", "", lookup);
    assert.equal(result.instructions, mcpInstructions(ORIGIN, variant), variant);
    assert.deepEqual(asked, ["lookupInvite"], variant + ": one lookup, nothing opened");
  }
  for (const invite of ["", "tok-x"]) {
    const { asked, result } = await initialize(invite, "", undefined, true);
    assert.equal(result.instructions, mcpInstructions(ORIGIN, "owner"), "the owner key" + (invite ? " with a token" : ""));
    assert.deepEqual(asked, []);
  }
});

test("initialize's result: its fields, serverInfo, the changes link and its size", async () => {
  const cases = [["", "", undefined, false], ["tok-x", "", undefined, false], ["tok-x", "", REVOKED, false], ["tok-x", "", GOOD, false], ["", "", undefined, true]];
  for (const [invite, search, lookup, owner] of cases) {
    const { result } = await initialize(invite, search, lookup, owner);
    const what = result.instructions.slice(0, 120);
    assert.deepEqual(Object.keys(result).sort(), ["capabilities", "catalog", "changes", "instructions", "protocolVersion", "serverInfo"], what);
    assert.deepEqual(result.serverInfo, { name: "agent-chat", title: "Agent Chat", version: MCP_CATALOG_VERSION, websiteUrl: ORIGIN }, what);
    assert.deepEqual(result.changes, { api_version: API_VERSION, catalog_version: MCP_CATALOG_VERSION, url: ORIGIN + "/api/changes" }, what);
    assert.ok(JSON.stringify(result).length <= 2000, what + ": " + JSON.stringify(result).length + " characters");
  }
});
