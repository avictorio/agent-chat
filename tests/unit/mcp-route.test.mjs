// The MCP route (worker/routes/agents.ts mcpRoute) before it reaches the
// room: what a caller with no token costs. The room is a stand-in that
// counts what it is asked; nothing else runs.
import test from "node:test";
import assert from "node:assert/strict";
import { mcpRoute } from "../../worker/routes/agents.ts";
import { MCP_NO_TOKEN, mcpInstructions } from "../../worker/agents/onboarding.ts";
import { MCP_CATALOG_VERSION, MCP_PROTOCOL_VERSION, MCP_PROTOCOL_VERSIONS, mcpProtocolVersion } from "../../worker/agents/mcp.ts";
import { API_VERSION } from "../../worker/agents/notices.ts";
import { OWNER_NO_START_PAGE, START_INVALID, startPage } from "../../worker/agents/start.ts";
import { watcherPin } from "../../worker/agents/docs.ts";
import { base, joined } from "./start-views.mjs";

// Node wants duplex: "half" on a Request built with a stream body, which
// settleBody (lib/http.ts) makes; the Workers runtime does not.
const NodeRequest = globalThis.Request;
globalThis.Request = class extends NodeRequest {
  constructor(input, init) { super(input, init && init.body && typeof init.body.getReader === "function" ? { duplex: "half", ...init } : init); }
};

/** a route context for POST /api/rooms/unit/mcp with that body and token
 *  (the header token, as index.ts reads it), and that query string; lookup
 *  is what the stand-in's lookupInvite answers (invite_invalid unless given),
 *  owner whether the request carries the owner key, view what its
 *  startView answers (args records each call's arguments) */
function call(body, invite, search, lookup, owner, view) {
  const asked = [];
  const args = [];
  const found = lookup || { ok: false, status: 403, code: "invite_invalid", error: "This invite link isn't valid for this room." };
  const stub = new Proxy({}, { get: (_, name) => async (...a) => { asked.push(String(name)); args.push(a); if (name === "lookupInvite") return found; if (name === "startView" && view) return view; throw new Error("unexpected call " + String(name) + " " + JSON.stringify(a)); } });
  const env = { ROOM: { idFromName: (n) => n, get: () => stub } };
  const url = new URL("http://localhost/api/rooms/unit/mcp" + (search || ""));
  const request = new Request(url, { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });
  const m = /^\/api\/rooms\/([^/]+)\/mcp$/.exec(url.pathname);
  return { asked, args, res: mcpRoute({ request, env, url, path: url.pathname, owner: !!owner, invite }, m) };
}
const ORIGIN = "http://localhost";
/** the watcher's version and SHA-256 at ORIGIN, which the page's step 3c prints */
const PIN = await watcherPin(ORIGIN);
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

// initialize answers a revision this endpoint speaks: the client's own when
// it is one, the newest for anything else it sends (a client that cannot
// speak that one disconnects; an echo of its unknown revision would keep
// it connected to a server that does not speak it), and the default when
// the client names none.
test("initialize answers the client's revision when the server speaks it, the newest for any other, the default for none", async () => {
  assert.deepEqual(MCP_PROTOCOL_VERSIONS, [...MCP_PROTOCOL_VERSIONS].sort().reverse(), "newest first");
  assert.ok(MCP_PROTOCOL_VERSIONS.includes(MCP_PROTOCOL_VERSION), "the default is one of them");
  assert.ok(MCP_PROTOCOL_VERSIONS.every((v) => /^\d{4}-\d{2}-\d{2}$/.test(v) && v < "2026-07-28"), "only revisions that open with initialize");
  const newest = MCP_PROTOCOL_VERSIONS[0];
  for (const v of MCP_PROTOCOL_VERSIONS) assert.equal(mcpProtocolVersion(v), v);
  for (const v of ["2026-07-28", "2024-10-07", "1999-01-01", "", "latest", " 2025-03-26", "toString", "constructor"]) assert.equal(mcpProtocolVersion(v), newest, JSON.stringify(v));
  for (const v of [null, 7, 20250618, true, {}, ["2025-11-25"]]) assert.equal(mcpProtocolVersion(v), newest, JSON.stringify(v));
  assert.equal(mcpProtocolVersion(undefined), MCP_PROTOCOL_VERSION, "none named");
  // through the route, with and without a token
  for (const [params, want] of [[{ protocolVersion: "2025-06-18" }, "2025-06-18"], [{ protocolVersion: "2099-12-31" }, newest], [{ protocolVersion: 20250618 }, newest], [{ protocolVersion: null }, newest], [{}, MCP_PROTOCOL_VERSION], [undefined, MCP_PROTOCOL_VERSION]]) {
    for (const invite of ["", "tok-x"]) {
      const j = await (await call({ jsonrpc: "2.0", id: 1, method: "initialize", params }, invite, "", invite ? GOOD : undefined).res).json();
      assert.equal(j.result.protocolVersion, want, JSON.stringify(params));
    }
  }
});

// get_start_page is a look, dispatched before access() beside get_invite:
// the page's text once (no structuredContent copy), the token's lookup the
// route already makes, then startView, never access().
const START = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_start_page", arguments: {} } };
test("get_start_page returns the page's text once, from startView, and never opens the invite", async () => {
  for (const view of [base, joined]) {
    const { asked, args, res } = call(START, "tok-good", "", GOOD, false, view);
    const r = await res;
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.deepEqual(j, { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: startPage(view, ORIGIN, "unit", PIN) }] } });
    assert.deepEqual(asked, ["lookupInvite", "startView"], "a look: no access()");
    assert.deepEqual(args[1], ["tok-good", "unit"]);
  }
});

test("get_start_page without a header token is refused invite_missing, asking the room nothing", async () => {
  for (const search of ["", "?invite=tok-in-the-url"]) {
    const { asked, res } = call(START, "", search);
    const j = await (await res).json();
    assert.equal(j.error.code, -32001, search);
    assert.equal(j.error.data.code, "invite_missing", search);
    assert.equal(j.error.message, MCP_NO_TOKEN, search);
    assert.deepEqual(asked, [], search);
  }
});

test("get_start_page: the owner key alone gets a tool error; with a token, that token's page with the owner-key line", async () => {
  let { asked, res } = call(START, "", "", undefined, true);
  let j = await (await res).json();
  assert.equal(j.result.isError, true);
  assert.equal(j.result.content[0].text, OWNER_NO_START_PAGE);
  assert.deepEqual(asked, []);
  let args;
  ({ asked, args, res } = call(START, "tok-good", "", undefined, true, joined));
  j = await (await res).json();
  assert.equal(j.result.content[0].text, startPage(joined, ORIGIN, "unit", PIN, undefined, true));
  assert.match(j.result.content[0].text, /\nThis request also carried the owner key\. Calls that carry it act as the owner, not as "Scout": they join nothing, and a post needs "from" \(over MCP, "as"\)\./);
  assert.deepEqual(asked, ["startView"], "the owner key skips the lookup; the view is the token's");
  assert.deepEqual(args[0], ["tok-good", "unit"]);
});

// A token that is none of the room's invites: the page's own sentence, as
// over REST (the room's names a link, and an MCP client sent a header).
test("get_start_page refuses an unknown token with -32001 invite_invalid and the page's sentence", async () => {
  const INVALID = { ok: false, status: 403, code: "invite_invalid", error: "This invite link isn't valid for this room." };
  const { asked, res } = call(START, "tok-bad", "", undefined, false, INVALID);
  const j = await (await res).json();
  assert.equal(j.error.code, -32001);
  assert.equal(j.error.data.code, "invite_invalid");
  assert.equal(j.error.message, START_INVALID);
  assert.ok(!asked.includes("access"));
});

test("get_start_page refuses a revoked token with -32001 invite_revoked", async () => {
  const { asked, res } = call(START, "tok-gone", "", GOOD, false, REVOKED);
  const j = await (await res).json();
  assert.equal(j.error.code, -32001);
  assert.equal(j.error.data.code, "invite_revoked");
  assert.equal(j.error.message, REVOKED.error);
  assert.ok(!asked.includes("access"));
});
