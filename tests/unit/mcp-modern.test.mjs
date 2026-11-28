// The MCP route (worker/routes/agents.ts mcpRoute) for revision 2026-07-28
// beside the revisions that open with initialize: which kind each request
// is (mcpRequestKind, from that request alone), the checks a request of the
// new kind passes (mcpCheck) and each refusal, server/discover, tools/list
// and tools/call over it, the unknown tool that joins nothing in both
// kinds, and that a client opening with initialize is answered byte for
// byte as before. The room is a stand-in that records every method asked;
// nothing else runs. tests/unit/mcp-route.test.mjs keeps its own checks of
// the initialize kind as they were.
import test from "node:test";
import assert from "node:assert/strict";
import { mcpRoute } from "../../worker/routes/agents.ts";
import { MCP_NO_TOKEN, mcpInstructions } from "../../worker/agents/onboarding.ts";
import {
  MCP_CATALOG_VERSION,
  MCP_FIRST_MODERN_VERSION,
  MCP_MODERN_VERSIONS,
  MCP_PROTOCOL_VERSIONS,
  MCP_TOOL_TITLES,
  mcpCallTool,
  mcpCatalogBuilt,
  mcpCheck,
  mcpDecodeName,
  mcpHasTool,
  mcpRequestKind,
} from "../../worker/agents/mcp.ts";
import { API_VERSION } from "../../worker/agents/notices.ts";
import { MCP_SKILLS_TTL_MS, MCP_TOOLS_TTL_MS, SMALL_BODY_MAX } from "../../worker/limits.ts";
import { OWNER_NO_START_PAGE, START_INVALID, startPage } from "../../worker/agents/start.ts";
import { watcherPin } from "../../worker/agents/docs.ts";
import { base } from "./start-views.mjs";
import { mcpDiscoverCapabilities, resourceRead, resourceTemplatesList, resourcesList, skillGet, skillsList } from "../../worker/agents/skills.ts";
import { SERVED_SKILLS } from "../../worker/agents/skills/served/index.ts";
import { GONE_MSG } from "../../worker/lib/errors.ts";

// Node wants duplex: "half" on a Request built with a stream body, which
// settleBody (lib/http.ts) makes; the Workers runtime does not.
const NodeRequest = globalThis.Request;
globalThis.Request = class extends NodeRequest {
  constructor(input, init) { super(input, init && init.body && typeof init.body.getReader === "function" ? { duplex: "half", ...init } : init); }
};

const ORIGIN = "http://localhost";
const PIN = await watcherPin(ORIGIN);
const V = "io.modelcontextprotocol/protocolVersion", C = "io.modelcontextprotocol/clientCapabilities";
const NEW = MCP_MODERN_VERSIONS[0];
const INVALID = { ok: false, status: 403, code: "invite_invalid", error: "This invite link isn't valid for this room." };
const REVOKED = { ok: false, status: 403, code: "invite_revoked", error: "This invite link has been revoked. Ask whoever gave it to you for a new one." };
const row = (used) => ({ name: "Ada", revoked: null, used, seen: used, kind: "agent", invited_by: null, created: 1, posted: null, left_ts: null });
const UNUSED = { ok: true, row: row(null) };
const ACTIVE = { ok: true, row: row(5) };
const ACC = { ok: true, name: "Ada", kind: "agent", invited_by: null, invited: 1, joined: 2, posted: false };
const PREVIEW = { ok: true, invite: { name: "Ada", kind: "agent", status: "unused", invited_by: null, invited: 1, joined: null }, purpose: null, members: [], opened: false };

/**
 * POST /api/rooms/unit/mcp through the route, the room a stand-in that
 * records each method asked and answers from what is given.
 * @param body the JSON body (a string is sent as it is)
 * @param o headers, invite (the header token, as index.ts reads it), lookup
 *   (lookupInvite's answer, invite_invalid unless given), owner, view
 *   (startView's), preview (previewInvite's), access (access()'s), leave
 *   (leave's), method (the HTTP method), search (the query string)
 */
function call(body, o = {}) {
  const asked = [];
  const found = o.lookup || INVALID;
  const answers = { lookupInvite: found, startView: o.view, previewInvite: o.preview, access: o.access, leave: o.leave };
  const stub = new Proxy({}, { get: (_, name) => async (...a) => { asked.push(String(name)); const v = answers[name]; if (v !== undefined) return v; throw new Error("unexpected call " + String(name) + " " + JSON.stringify(a)); } });
  const env = { ROOM: { idFromName: (n) => n, get: () => stub } };
  const url = new URL(ORIGIN + "/api/rooms/unit/mcp" + (o.search || ""));
  const method = o.method || "POST";
  const init = { method, headers: { "Content-Type": "application/json", ...(o.headers || {}) } };
  if (method !== "GET" && method !== "HEAD") init.body = typeof body === "string" ? body : JSON.stringify(body);
  const request = new Request(url, init);
  const m = /^\/api\/rooms\/([^/]+)\/mcp$/.exec(url.pathname);
  return { asked, res: mcpRoute({ request, env, url, path: url.pathname, owner: !!o.owner, invite: o.invite || "", ctx: { waitUntil() {} } }, m) };
}
/** the answer's status, headers, body text and JSON, and what the room was asked */
async function answer(body, o) {
  const { asked, res } = call(body, o);
  const r = await res;
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* an empty 202 */ }
  return { status: r.status, headers: r.headers, text, json, asked };
}
/** a request of revision 2026-07-28 as the official v2 client writes it */
const req = (method, params = {}, id = 1, meta = { [V]: NEW, [C]: {} }) => ({ jsonrpc: "2.0", id, method, params: { ...params, _meta: meta } });
/** its headers: the revision, the method and, on tools/call, the tool */
const heads = (method, name) => ({ "MCP-Protocol-Version": NEW, "Mcp-Method": method, ...(name === undefined ? {} : { "Mcp-Name": name }) });
const toolCall = (name, args, id = 1) => req("tools/call", args === undefined ? { name } : { name, arguments: args }, id);
/** the same request over revision 2026-07-28 with the token states that change nothing for a refusal */
const TOKENS = [["no token", {}], ["a good token", { invite: "tok-good", lookup: ACTIVE }], ["an unknown token", { invite: "tok-bad" }]];
const SERVER = { name: "agent-chat", title: "Agent Chat", version: MCP_CATALOG_VERSION, websiteUrl: ORIGIN };

// ---- 1. Which kind each request is: every row of the table ----

test("the classifier: initialize, a batch and a body that is no object are the initialize kind; the claim or a header from 2026-07-28 on is the other", () => {
  const per = (revision, spoken = true) => ({ kind: "per-request", revision, spoken });
  const init = { kind: "initialize" };
  assert.deepEqual(mcpRequestKind([], NEW), init, "a batch, even with the header");
  assert.deepEqual(mcpRequestKind([req("tools/list")], NEW), init, "a batch holding a claim is still a batch");
  for (const v of [5, "x", null, true]) assert.deepEqual(mcpRequestKind(v, NEW), init, JSON.stringify(v));
  assert.deepEqual(mcpRequestKind(req("initialize"), NEW), init, "initialize with the claim and the header");
  assert.deepEqual(mcpRequestKind({ jsonrpc: "2.0", id: 1, method: "tools/list" }, null), init, "no claim, no header");
  for (const v of MCP_PROTOCOL_VERSIONS) assert.deepEqual(mcpRequestKind({ jsonrpc: "2.0", id: 1, method: "tools/list" }, v), init, v);
  for (const v of ["2024-10-07", "latest", "", "2026-07-28x", "2026-7-28", " 2026-07-28", "2026-07-2", "garbage"]) assert.deepEqual(mcpRequestKind({ jsonrpc: "2.0", id: 1, method: "tools/list" }, v), init, JSON.stringify(v));
  assert.deepEqual(mcpRequestKind({ jsonrpc: "2.0", id: 1, method: "tools/list" }, NEW), per(NEW), "the header alone, spoken");
  assert.deepEqual(mcpRequestKind({ jsonrpc: "2.0", id: 1, method: "tools/list" }, "2099-01-01"), per("2099-01-01", false), "the header alone, a later revision");
  assert.deepEqual(mcpRequestKind(req("tools/list"), null), per(NEW), "the claim alone");
  assert.deepEqual(mcpRequestKind(req("tools/list"), "2025-11-25"), per(NEW), "the claim beside an older header");
  assert.deepEqual(mcpRequestKind(req("tools/list", {}, 1, { [V]: 20260728 }), null), per(20260728, false), "a claim that is not a string is still the claim");
  assert.deepEqual(mcpRequestKind(req("tools/list", {}, 1, { [V]: null }), null), per(null, false), "a null claim too");
  // the line is MCP_FIRST_MODERN_VERSION's, not the spoken list's
  assert.equal(MCP_FIRST_MODERN_VERSION, "2026-07-28");
  assert.deepEqual(mcpRequestKind({ jsonrpc: "2.0", id: 1, method: "tools/list" }, NEW, []), per(NEW, false), "with nothing spoken, 2026-07-28 is still the new kind");
  const told = mcpCheck(req("tools/list"), (n) => heads("tools/list")[n] ?? null, []);
  assert.deepEqual(told, { status: 400, id: 1, error: { code: -32022, message: "Unsupported protocol version", data: { supported: [], requested: NEW } } }, "and is answered -32022");
});

test("row 0: any HTTP method but POST answers 405 with the JSON sentence, before the body or the room", async () => {
  for (const method of ["GET", "PUT", "DELETE", "HEAD"]) {
    for (const headers of [{}, heads("tools/list")]) {
      const a = await answer(req("tools/list"), { method, headers, invite: "tok-good", lookup: ACTIVE });
      assert.equal(a.status, 405, method);
      assert.deepEqual(a.json, { error: "Method not allowed. POST JSON-RPC here; call tools/list for the catalog." }, method);
      assert.deepEqual(a.asked, [], method);
    }
  }
});

test("row 1: a body that is not JSON answers 400 -32700, whatever the headers", async () => {
  for (const headers of [{}, heads("tools/list")]) {
    const a = await answer("{nope", { headers });
    assert.equal(a.status, 400);
    assert.deepEqual(a.json, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error: send one JSON-RPC request object" } });
  }
});

test("rows 2 to 4: batches - refused without a token as before, each element as before with one, and refused whole when an element carries the claim", async () => {
  // row 2: no valid token, the empty batch and one with a claim included
  for (const [label, o] of [["no token", {}], ["an unknown token", { invite: "tok-bad" }]]) {
    for (const batch of [[], [{ jsonrpc: "2.0", id: 1, method: "ping" }], [req("tools/list")]]) {
      const plain = await answer(batch, o);
      const withHeader = await answer(batch, { ...o, headers: heads("tools/list") });
      assert.equal(plain.status, 400, label);
      assert.equal(plain.json.error.code, -32600, label);
      assert.equal(plain.json.error.data.code, o.invite ? "invite_invalid" : "invite_missing", label);
      assert.ok(plain.json.error.message.startsWith("Invalid request: a batch (a JSON array of requests) is answered only for a valid invite token. "), label);
      assert.equal(withHeader.text, plain.text, label + ": the header changes nothing");
    }
  }
  // row 3: a valid token, no element claims: each as before (the header changes nothing), the empty one 202
  const batch = [{ jsonrpc: "2.0", id: 1, method: "ping" }, { jsonrpc: "2.0", id: 2, method: "tools/list" }, { jsonrpc: "2.0", method: "notifications/initialized" }];
  const plain = await answer(batch, { invite: "tok-good", lookup: ACTIVE });
  const withHeader = await answer(batch, { invite: "tok-good", lookup: ACTIVE, headers: heads("tools/list") });
  assert.equal(plain.status, 200);
  assert.deepEqual(plain.json.map((x) => x.id), [1, 2]);
  assert.deepEqual(plain.json[0], { jsonrpc: "2.0", id: 1, result: {} });
  assert.deepEqual(Object.keys(plain.json[1].result).sort(), ["catalog", "tools"]);
  assert.equal(withHeader.text, plain.text);
  const empty = await answer([], { invite: "tok-good", lookup: ACTIVE });
  assert.equal(empty.status, 202);
  assert.equal(empty.text, "");
  // row 4: a valid token's batch with an element carrying the claim: 400, nothing run
  for (const claimed of [req("tools/list"), req("initialize"), req("tools/call", { name: "whoami" }, 3, { [V]: 5 })]) {
    const a = await answer([{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "whoami" } }, claimed], { invite: "tok-good", lookup: ACTIVE, access: ACC });
    assert.equal(a.status, 400, claimed.method);
    assert.deepEqual(a.json, { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request: revision 2026-07-28 has no batches; send each request as its own POST." } });
    assert.deepEqual(a.asked, ["lookupInvite"], "nothing run, nothing opened");
  }
});

test("row 5: initialize is answered as before, even with the full _meta and a 2026-07-28 header", async () => {
  const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "x", version: "0" } } };
  for (const o of [{}, { invite: "tok-good", lookup: ACTIVE }, { invite: "tok-bad" }, { owner: true }]) {
    const before = await answer(init, o);
    const after = await answer({ ...init, params: { ...init.params, _meta: { [V]: NEW, [C]: {} } } }, { ...o, headers: heads("initialize") });
    assert.equal(after.status, 200);
    assert.deepEqual(after.json, before.json);
    assert.equal(after.json.result.protocolVersion, "2025-11-25");
  }
});

test("rows 6 to 8: without the claim, no header, an older revision's or one that is no date from 2026-07-28 on is answered as before", async () => {
  const methods = [{ jsonrpc: "2.0", id: 1, method: "tools/list" }, { jsonrpc: "2.0", id: 2, method: "ping" }, { jsonrpc: "2.0", id: 3, method: "no/such" }, { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "get_invite", arguments: {} } }];
  for (const body of methods) {
    const o = { invite: "tok-good", lookup: UNUSED, preview: PREVIEW };
    const before = await answer(body, o);
    for (const v of [...MCP_PROTOCOL_VERSIONS, "2024-10-07", "latest", "", "2026-07-28x", "2026-7-28"]) {
      const a = await answer(body, { ...o, headers: { "MCP-Protocol-Version": v, "Mcp-Method": body.method } });
      assert.equal(a.status, before.status, body.method + " " + v);
      assert.equal(a.text, before.text, body.method + " " + JSON.stringify(v));
    }
  }
});

test("rows 9a and 9b: a header from 2026-07-28 on without the claim is the new kind: told how to recover, or -32022; its notification 202", async () => {
  const bare = { jsonrpc: "2.0", id: 7, method: "tools/list" };
  for (const [label, o] of TOKENS) {
    let a = await answer(bare, { ...o, headers: heads("tools/list") });
    assert.equal(a.status, 400, label);
    assert.deepEqual(a.json, { jsonrpc: "2.0", id: 7, error: { code: -32602, message: "Invalid params: revision 2026-07-28 needs io.modelcontextprotocol/protocolVersion (a string) and io.modelcontextprotocol/clientCapabilities (an object) in params._meta on every request; to open with initialize instead, send the revision initialize answered in MCP-Protocol-Version, or no such header.", data: { missing: [V, C] } } }, label);
    a = await answer(bare, { ...o, headers: { "MCP-Protocol-Version": "2099-01-01", "Mcp-Method": "tools/list" } });
    assert.equal(a.status, 400, label);
    assert.deepEqual(a.json, { jsonrpc: "2.0", id: 7, error: { code: -32022, message: "Unsupported protocol version", data: { supported: MCP_MODERN_VERSIONS, requested: "2099-01-01" } } }, label);
    for (const v of [NEW, "2099-01-01"]) {
      a = await answer({ jsonrpc: "2.0", method: "notifications/initialized" }, { ...o, headers: { "MCP-Protocol-Version": v } });
      assert.equal(a.status, 202, label + " " + v);
      assert.equal(a.text, "", label);
      assert.equal(a.headers.get("Access-Control-Allow-Origin"), "*", label);
    }
  }
});

test("row 10: the claim makes the new kind with or without the header", async () => {
  // with no header: the claim is read, the header is then missing
  let a = await answer(req("tools/list"), { invite: "tok-good", lookup: ACTIVE, headers: { "Mcp-Method": "tools/list" } });
  assert.equal(a.status, 400);
  assert.equal(a.json.error.code, -32020);
  // with an older revision's header: a mismatch
  a = await answer(req("tools/list"), { invite: "tok-good", lookup: ACTIVE, headers: { "MCP-Protocol-Version": "2025-11-25", "Mcp-Method": "tools/list" } });
  assert.equal(a.json.error.message, "Header mismatch: MCP-Protocol-Version header value '2025-11-25' does not match body value '2026-07-28'");
  // with the matching header: served
  a = await answer(req("tools/list"), { invite: "tok-good", lookup: ACTIVE, headers: heads("tools/list") });
  assert.equal(a.status, 200);
  assert.equal(a.json.result.resultType, "complete");
});

test("row 11: a request of the new kind without an id member is a notification: 202, nothing validated or run", async () => {
  for (const body of [{ jsonrpc: "2.0", method: "notifications/initialized", params: { _meta: { [V]: NEW } } }, { jsonrpc: "2.0", method: 5, params: { _meta: { [V]: 5 } } }, { jsonrpc: "2.0", method: "tools/call", params: { name: "whoami", _meta: { [V]: "2099-01-01" } } }]) {
    for (const [label, o] of TOKENS) {
      const a = await answer(body, { ...o, access: ACC });
      assert.equal(a.status, 202, label);
      assert.equal(a.text, "", label);
      assert.equal(a.headers.get("Access-Control-Allow-Origin"), "*", label);
      assert.deepEqual(a.asked, o.invite ? ["lookupInvite"] : [], label + ": only the look before the body");
    }
  }
});

test("rows 12 and 13: ping is no method of revision 2026-07-28 (404 -32601); the initialize kind's ping and notifications are as before", async () => {
  for (const [label, o] of TOKENS) {
    const a = await answer(req("ping"), { ...o, headers: heads("ping") });
    assert.equal(a.status, 404, label);
    assert.deepEqual(a.json, { jsonrpc: "2.0", id: 1, error: { code: -32601, message: "Method not found: ping" } }, label);
    const p = await answer({ jsonrpc: "2.0", id: 1, method: "ping" }, o);
    assert.deepEqual(p.json, { jsonrpc: "2.0", id: 1, result: {} }, label);
    const n = await answer({ jsonrpc: "2.0", method: "notifications/initialized" }, o);
    assert.equal(n.status, 202, label);
  }
});

test("row 14: a JSON value that is neither an object nor a list is 200 -32600 Invalid request, as before", async () => {
  for (const v of [5, "x", null, true]) {
    for (const headers of [{}, heads("tools/list")]) {
      const a = await answer(JSON.stringify(v), { headers });
      assert.equal(a.status, 200, JSON.stringify(v));
      assert.deepEqual(a.json, { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request" } });
    }
  }
});

// ---- 2. and 3. Clients that open with initialize: byte for byte, and nothing gained ----

test("the request sequence the v1 client sends is answered byte for byte as without its MCP-Protocol-Version header", async () => {
  const o = { invite: "tok-good", lookup: ACTIVE, access: ACC, view: base, preview: PREVIEW };
  const steps = [
    { jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "v1", version: "0" } } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 1, method: "tools/list" },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get_start_page", arguments: {} } },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "get_invite", arguments: {} } },
    { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "whoami", arguments: {} } },
    { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "post_message", arguments: {} } },
    { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "no_such_tool", arguments: {} } },
    { jsonrpc: "2.0", id: 7, method: "ping" },
  ];
  for (const [i, body] of steps.entries()) {
    const plain = await answer(body, o);
    // initialize goes without the header, as the client sends it; every later request with the negotiated one
    const sent = await answer(body, i === 0 ? o : { ...o, headers: { "MCP-Protocol-Version": "2025-11-25" } });
    assert.equal(sent.status, plain.status, body.method);
    assert.equal(sent.text, plain.text, body.method + " " + (body.params && body.params.name));
  }
});

test("answers over the initialize kind gain no field: no resultType, _meta, ttlMs or cacheScope, and a tool only its title", async () => {
  const o = { invite: "tok-good", lookup: ACTIVE, access: ACC, view: base };
  const keys = async (body, want, oo = o) => {
    const a = await answer(body, { ...oo, headers: { "MCP-Protocol-Version": "2025-11-25" } });
    assert.deepEqual(Object.keys(a.json.result), want, body.method + " " + JSON.stringify(body.params || {}));
    for (const k of ["resultType", "_meta", "ttlMs", "cacheScope"]) assert.ok(!a.text.includes("\"" + k + "\""), body.method + " carries " + k);
    return a.json.result;
  };
  const list = await keys({ jsonrpc: "2.0", id: 1, method: "tools/list" }, ["tools", "catalog"]);
  for (const t of list.tools) assert.deepEqual(Object.keys(t), ["name", "title", "description", "inputSchema", "annotations"], t.name);
  await keys({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "whoami", arguments: {} } }, ["content", "structuredContent"]);
  await keys({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "post_message", arguments: {} } }, ["content", "isError"]);
  await keys({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "no_such_tool", arguments: {} } }, ["content", "isError"]);
  await keys({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "get_start_page", arguments: {} } }, ["content"]);
  assert.deepEqual(await keys({ jsonrpc: "2.0", id: 6, method: "ping" }, []), {});
  const init = await keys({ jsonrpc: "2.0", id: 7, method: "initialize", params: {} }, ["protocolVersion", "capabilities", "serverInfo", "catalog", "changes", "instructions"]);
  assert.deepEqual(init.serverInfo, SERVER);
});

// ---- 4. and 5. Every refusal of the new kind, and their order ----

/** each refusal of the new kind before its method runs: the body, its headers, and the answer (status, id, code, message, data) */
const long = "x".repeat(200), cut = "x".repeat(128) + "...";
const REFUSALS = [
  ["1: an id that is null", { jsonrpc: "2.0", id: null, method: "tools/list", params: { _meta: { [V]: NEW, [C]: {} } } }, heads("tools/list"), [400, null, -32600, "Invalid request: id must be a string or an integer."]],
  ["1: an id that is no integer", { ...req("tools/list"), id: 1.5 }, heads("tools/list"), [400, null, -32600, "Invalid request: id must be a string or an integer."]],
  ["1: an id that is an object", { ...req("tools/list"), id: {} }, heads("tools/list"), [400, null, -32600, "Invalid request: id must be a string or an integer."]],
  ["2: a method that is no string", { ...req("tools/list"), method: 5 }, heads("tools/list"), [400, 1, -32600, "Invalid request: method must be a string."]],
  ["3: a claim that is no string", req("tools/list", {}, "a", { [V]: 20260728, [C]: {} }), heads("tools/list"), [400, "a", -32602, "Invalid params: io.modelcontextprotocol/protocolVersion in params._meta must be a string naming a revision, such as 2026-07-28.", { missing: [V] }]],
  ["4: the header unlike the claim", req("tools/list"), { ...heads("tools/list"), "MCP-Protocol-Version": "2025-11-25" }, [400, 1, -32020, "Header mismatch: MCP-Protocol-Version header value '2025-11-25' does not match body value '2026-07-28'"]],
  ["4: cut to 128", req("tools/list", {}, 1, { [V]: long, [C]: {} }), heads("tools/list"), [400, 1, -32020, "Header mismatch: MCP-Protocol-Version header value '2026-07-28' does not match body value '" + cut + "'"]],
  ["5: Mcp-Method unlike the method", req("tools/list"), { ...heads("tools/list"), "Mcp-Method": "tools/call" }, [400, 1, -32020, "Header mismatch: Mcp-Method header value 'tools/call' does not match body value 'tools/list'"]],
  ["5: cut to 128", req("tools/list"), { ...heads("tools/list"), "Mcp-Method": long }, [400, 1, -32020, "Header mismatch: Mcp-Method header value '" + cut + "' does not match body value 'tools/list'"]],
  ["6: a claim of a revision not spoken", req("tools/list", {}, 1, { [V]: "2099-01-01", [C]: {} }), { ...heads("tools/list"), "MCP-Protocol-Version": "2099-01-01" }, [400, 1, -32022, "Unsupported protocol version", { supported: MCP_MODERN_VERSIONS, requested: "2099-01-01" }]],
  ["6: the header alone naming one", { jsonrpc: "2.0", id: 1, method: "tools/list" }, { ...heads("tools/list"), "MCP-Protocol-Version": "2099-01-01" }, [400, 1, -32022, "Unsupported protocol version", { supported: MCP_MODERN_VERSIONS, requested: "2099-01-01" }]],
  ["6: requested cut to 128", req("tools/list", {}, 1, { [V]: "2099-01-01" + long, [C]: {} }), { "Mcp-Method": "tools/list" }, [400, 1, -32022, "Unsupported protocol version", { supported: MCP_MODERN_VERSIONS, requested: ("2099-01-01" + long).slice(0, 128) + "..." }]],
  ["7: no clientCapabilities (the claim is there, so no way back to initialize is told)", req("tools/list", {}, 1, { [V]: NEW }), heads("tools/list"), [400, 1, -32602, "Invalid params: revision 2026-07-28 needs io.modelcontextprotocol/protocolVersion (a string) and io.modelcontextprotocol/clientCapabilities (an object) in params._meta on every request.", { missing: [C] }]],
  ["7: clientCapabilities that are no object", req("tools/list", {}, 1, { [V]: NEW, [C]: [] }), heads("tools/list"), [400, 1, -32602, null, { missing: [C] }]],
  ["7: the header alone, capabilities in _meta", { jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: { [C]: {} } } }, heads("tools/list"), [400, 1, -32602, null, { missing: [V] }]],
  ["7: the header alone, _meta no object", { jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: 5 } }, heads("tools/list"), [400, 1, -32602, null, { missing: [V, C] }]],
  ["8: no MCP-Protocol-Version", req("tools/list"), { "Mcp-Method": "tools/list" }, [400, 1, -32020, "Header mismatch: the MCP-Protocol-Version header is missing; it must equal io.modelcontextprotocol/protocolVersion in params._meta."]],
  ["9: no Mcp-Method", req("tools/list"), { "MCP-Protocol-Version": NEW }, [400, 1, -32020, "Header mismatch: the Mcp-Method header is missing; it must equal the request's method."]],
  ["10: no Mcp-Name", toolCall("whoami", {}), heads("tools/call"), [400, 1, -32020, "Header mismatch: the Mcp-Name header is missing; on tools/call it must equal params.name."]],
  ["11: a malformed Base64 sentinel", toolCall("whoami", {}), heads("tools/call", "=?base64?abc?="), [400, 1, -32020, "Header mismatch: the Mcp-Name header's =?base64?...?= value is not Base64 of UTF-8 text."]],
  ["11: Base64 of no UTF-8 text", toolCall("whoami", {}), heads("tools/call", "=?base64?/w==?="), [400, 1, -32020, "Header mismatch: the Mcp-Name header's =?base64?...?= value is not Base64 of UTF-8 text."]],
  ["11: markers that overlap", toolCall("whoami", {}), heads("tools/call", "=?base64?=" ), [400, 1, -32020, "Header mismatch: the Mcp-Name header's =?base64?...?= value is not Base64 of UTF-8 text."]],
  ["12: Mcp-Name unlike the tool", toolCall("get_invite", {}), heads("tools/call", "whoami"), [400, 1, -32020, "Header mismatch: Mcp-Name header value 'whoami' does not match body value 'get_invite'"]],
  ["12: compared decoded", toolCall("whoami", {}), heads("tools/call", "=?base64?aMOpbGxvIHfDtnJsZA==?="), [400, 1, -32020, "Header mismatch: Mcp-Name header value 'héllo wörld' does not match body value 'whoami'"]],
  ["12: case-sensitive", toolCall("whoami", {}), heads("tools/call", "WHOAMI"), [400, 1, -32020, "Header mismatch: Mcp-Name header value 'WHOAMI' does not match body value 'whoami'"]],
  ["12: cut to 128", toolCall(long, {}), heads("tools/call", "y"), [400, 1, -32020, "Header mismatch: Mcp-Name header value 'y' does not match body value '" + cut + "'"]],
  ["13: ping", req("ping"), heads("ping"), [404, 1, -32601, "Method not found: ping"]],
  ["13: initialize-kind methods and others", req("prompts/list"), heads("prompts/list"), [404, 1, -32601, "Method not found: prompts/list"]],
  ["13: resources/directory/read (no skill declares it)", req("resources/directory/read", { uri: "skill://agent-chat/taking-part" }), heads("resources/directory/read"), [404, 1, -32601, "Method not found: resources/directory/read"]],
  ["13: subscriptions/listen", req("subscriptions/listen"), heads("subscriptions/listen"), [404, 1, -32601, "Method not found: subscriptions/listen"]],
  ["13: cut to 128", req(long), heads(long), [404, 1, -32601, "Method not found: " + cut]],
];

test("every refusal before a method runs: status, code, message, data and id exactly, the same in every token state, asking only the look before the body", async () => {
  for (const [label, body, headers, [status, id, code, message, data]] of REFUSALS) {
    for (const [tl, o] of TOKENS) {
      const a = await answer(body, { ...o, headers, access: ACC });
      const what = label + ", " + tl;
      assert.equal(a.status, status, what);
      assert.equal(a.json.jsonrpc, "2.0", what);
      assert.equal(a.json.id, id, what);
      assert.equal(a.json.error.code, code, what);
      if (message !== null) assert.equal(a.json.error.message, message, what);
      assert.deepEqual(a.json.error.data, data, what);
      assert.equal(a.headers.get("Content-Type"), "application/json; charset=utf-8", what);
      assert.equal(a.headers.get("Access-Control-Allow-Origin"), "*", what);
      assert.deepEqual(a.asked, o.invite ? ["lookupInvite"] : [], what);
    }
  }
});

test("the methods' own refusals are in-band (HTTP 200) and come before the token's: a cursor, a name, arguments", async () => {
  const cases = [
    ["a cursor", req("tools/list", { cursor: "abc" }), heads("tools/list"), "Invalid cursor: tools/list answers in one page; send it without a cursor."],
    ["a cursor of 0", req("tools/list", { cursor: 0 }), heads("tools/list"), "Invalid cursor: tools/list answers in one page; send it without a cursor."],
    ["no name", req("tools/call", { arguments: {} }), heads("tools/call"), "tools/call needs params.name"],
    ["an empty name", toolCall("", {}), heads("tools/call", "=?base64??="), "tools/call needs params.name"],
    ["a name that is no string", req("tools/call", { name: 5, arguments: {} }), heads("tools/call"), "tools/call needs params.name"],
    ["arguments that are a list", toolCall("whoami", []), heads("tools/call", "whoami"), "Invalid params for tools/call: 'arguments' must be an object"],
    ["arguments that are text", toolCall("whoami", "x"), heads("tools/call", "whoami"), "Invalid params for tools/call: 'arguments' must be an object"],
    ["arguments that are null", toolCall("whoami", null), heads("tools/call", "whoami"), "Invalid params for tools/call: 'arguments' must be an object"],
  ];
  for (const [label, body, headers, message] of cases) {
    for (const [tl, o] of [...TOKENS, ["a revoked token", { invite: "tok-gone", lookup: REVOKED }]]) {
      const a = await answer(body, { ...o, headers, access: ACC });
      assert.equal(a.status, 200, label + ", " + tl);
      assert.deepEqual(a.json, { jsonrpc: "2.0", id: 1, error: { code: -32602, message } }, label + ", " + tl);
      assert.ok(!a.asked.includes("access"), label);
    }
  }
  // a null cursor is none
  const a = await answer(req("tools/list", { cursor: null }), { invite: "tok-good", lookup: ACTIVE, headers: heads("tools/list") });
  assert.equal(a.json.result.resultType, "complete");
});

test("a refused token over revision 2026-07-28: HTTP 200, -32001 with data.code, the start page's sentence for a token that is none of the room's", async () => {
  const states = [
    ["no token", {}, "invite_missing", MCP_NO_TOKEN],
    ["a token only in the URL counts as none", { search: "?invite=tok-in-the-url" }, "invite_missing", MCP_NO_TOKEN],
    ["an unknown token", { invite: "tok-bad" }, "invite_invalid", START_INVALID],
    ["a revoked token", { invite: "tok-gone", lookup: REVOKED }, "invite_revoked", REVOKED.error],
  ];
  const bodies = [["tools/list", req("tools/list"), heads("tools/list")], ["whoami", toolCall("whoami", {}), heads("tools/call", "whoami")], ["get_invite", toolCall("get_invite", {}), heads("tools/call", "get_invite")], ["get_start_page", toolCall("get_start_page", {}), heads("tools/call", "get_start_page")], ["leave_room", toolCall("leave_room", { confirm: "unit" }), heads("tools/call", "leave_room")], ["an unknown tool", toolCall("no_such_tool", {}), heads("tools/call", "no_such_tool")]];
  for (const [what, body, headers] of bodies) {
    for (const [label, o, code, message] of states) {
      const a = await answer(body, { ...o, headers, access: ACC, view: base, preview: PREVIEW });
      assert.equal(a.status, 200, what + ", " + label);
      assert.deepEqual(a.json, { jsonrpc: "2.0", id: 1, error: { code: -32001, message, data: { code } } }, what + ", " + label);
      assert.deepEqual(a.asked, o.invite ? ["lookupInvite"] : [], what + ", " + label + ": only the look, nothing opened");
    }
  }
  // a refusal from a later look in the same request (revoked in between) gets the same words
  let a = await answer(toolCall("get_invite", {}), { invite: "tok-good", lookup: ACTIVE, preview: INVALID, headers: heads("tools/call", "get_invite") });
  assert.deepEqual(a.json.error, { code: -32001, message: START_INVALID, data: { code: "invite_invalid" } });
  a = await answer(toolCall("whoami", {}), { invite: "tok-good", lookup: ACTIVE, access: REVOKED, headers: heads("tools/call", "whoami") });
  assert.deepEqual(a.json.error, { code: -32001, message: REVOKED.error, data: { code: "invite_revoked" } });
  assert.deepEqual(a.asked, ["lookupInvite", "access"]);
});

test("the order of the checks: the first a request fails answers", async () => {
  const pairs = [
    ["1 before 2", { ...req("tools/list"), id: null, method: 5 }, heads("tools/list"), -32600, "Invalid request: id must be a string or an integer."],
    ["3 before 4", req("tools/list", {}, 1, { [V]: 5, [C]: {} }), { ...heads("tools/list"), "MCP-Protocol-Version": "2025-11-25" }, -32602, "Invalid params: io.modelcontextprotocol/protocolVersion in params._meta must be a string naming a revision, such as 2026-07-28."],
    ["4 before 5", req("tools/list"), { "MCP-Protocol-Version": "2025-11-25", "Mcp-Method": "tools/call" }, -32020, "Header mismatch: MCP-Protocol-Version header value '2025-11-25' does not match body value '2026-07-28'"],
    ["4 before 6", req("tools/list", {}, 1, { [V]: "2099-01-01", [C]: {} }), heads("tools/list"), -32020, "Header mismatch: MCP-Protocol-Version header value '2026-07-28' does not match body value '2099-01-01'"],
    ["5 before 6", req("tools/list", {}, 1, { [V]: "2099-01-01", [C]: {} }), { "Mcp-Method": "tools/call" }, -32020, "Header mismatch: Mcp-Method header value 'tools/call' does not match body value 'tools/list'"],
    ["6 before 7", req("tools/list", {}, 1, { [V]: "2099-01-01" }), { ...heads("tools/list"), "MCP-Protocol-Version": "2099-01-01" }, -32022, "Unsupported protocol version"],
    ["6 before 8", req("tools/list", {}, 1, { [V]: "2099-01-01", [C]: {} }), { "Mcp-Method": "tools/list" }, -32022, "Unsupported protocol version"],
    ["7 before 8", req("tools/list", {}, 1, { [V]: NEW }), { "Mcp-Method": "tools/list" }, -32602, null],
    ["8 before 9", req("tools/list"), {}, -32020, "Header mismatch: the MCP-Protocol-Version header is missing; it must equal io.modelcontextprotocol/protocolVersion in params._meta."],
    ["9 before 10", toolCall("whoami", {}), { "MCP-Protocol-Version": NEW }, -32020, "Header mismatch: the Mcp-Method header is missing; it must equal the request's method."],
    ["9 before 13", req("ping"), { "MCP-Protocol-Version": NEW }, -32020, "Header mismatch: the Mcp-Method header is missing; it must equal the request's method."],
  ];
  for (const [label, body, headers, code, message] of pairs) {
    const a = await answer(body, { headers });
    assert.equal(a.json.error.code, code, label);
    if (message !== null) assert.equal(a.json.error.message, message, label);
  }
  // 13 before the token: a method this endpoint lacks is 404 whatever the token
  for (const [tl, o] of TOKENS) assert.equal((await answer(req("ping"), { ...o, headers: heads("ping") })).status, 404, tl);
  // tools/call: the name before the arguments, the arguments before the token, the token before the catalog
  let a = await answer(req("tools/call", { name: 5, arguments: [] }), { headers: heads("tools/call") });
  assert.equal(a.json.error.message, "tools/call needs params.name");
  a = await answer(toolCall("whoami", []), { headers: heads("tools/call", "whoami") });
  assert.equal(a.json.error.message, "Invalid params for tools/call: 'arguments' must be an object");
  a = await answer(toolCall("no_such_tool", {}), { headers: heads("tools/call", "no_such_tool") });
  assert.deepEqual(a.json.error, { code: -32001, message: MCP_NO_TOKEN, data: { code: "invite_missing" } }, "no catalog for a caller without a token");
  // the cursor before the token
  a = await answer(req("tools/list", { cursor: "x" }), { headers: heads("tools/list") });
  assert.equal(a.json.error.code, -32602);
});

// ---- 6. to 8. server/discover, tools/list and tools/call over revision 2026-07-28 ----

test("server/discover answers every token state, with the instructions for it and nothing more, opening nothing", async () => {
  const states = [
    ["no token", {}, "none", []],
    ["an unknown token", { invite: "tok-bad" }, "invalid", ["lookupInvite"]],
    ["a revoked token", { invite: "tok-gone", lookup: REVOKED }, "revoked", ["lookupInvite"]],
    ["an unused invite", { invite: "tok-good", lookup: UNUSED }, "ok", ["lookupInvite"]],
    ["the owner key", { owner: true }, "owner", []],
    ["the owner key beside a token", { owner: true, invite: "tok-good" }, "owner", []],
  ];
  for (const [label, o, variant, asked] of states) {
    const a = await answer(req("server/discover"), { ...o, headers: heads("server/discover") });
    assert.equal(a.status, 200, label);
    assert.equal(a.json.id, 1, label);
    const r = a.json.result;
    assert.deepEqual(Object.keys(r), ["resultType", "supportedVersions", "capabilities", "instructions", "catalog", "changes", "ttlMs", "cacheScope", "_meta"], label);
    assert.equal(r.resultType, "complete");
    assert.deepEqual(r.supportedVersions, MCP_MODERN_VERSIONS);
    assert.equal(JSON.stringify(r.capabilities), JSON.stringify(mcpDiscoverCapabilities()), label + ": tools, resources and the skills extension, in that order");
    assert.deepEqual(r.capabilities, { tools: {}, resources: {}, extensions: { "io.modelcontextprotocol/skills": {} } });
    assert.equal(r.instructions, mcpInstructions(ORIGIN, variant), label);
    assert.ok(r.instructions.length < 4096, label);
    assert.deepEqual(r.catalog, { version: MCP_CATALOG_VERSION, digest: mcpCatalogBuilt().digest });
    assert.deepEqual(r.changes, { api_version: API_VERSION, catalog_version: MCP_CATALOG_VERSION, url: ORIGIN + "/api/changes" });
    assert.equal(r.ttlMs, 0);
    assert.equal(r.cacheScope, "private");
    assert.deepEqual(r._meta, { "io.modelcontextprotocol/serverInfo": SERVER });
    assert.deepEqual(a.asked, asked, label + ": at most the one look");
  }
  // the same catalog and instructions initialize gives
  const init = (await answer({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, { invite: "tok-good", lookup: UNUSED })).json.result;
  const disc = (await answer(req("server/discover"), { invite: "tok-good", lookup: UNUSED, headers: heads("server/discover") })).json.result;
  assert.deepEqual([disc.catalog, disc.changes, disc.instructions, disc._meta["io.modelcontextprotocol/serverInfo"]], [init.catalog, init.changes, init.instructions, init.serverInfo]);
});

test("tools/list over revision 2026-07-28: the same catalog, with resultType, ttlMs, cacheScope and the server in _meta", async () => {
  for (const [label, o] of [["an active invite", { invite: "tok-good", lookup: ACTIVE }], ["the owner key", { owner: true }]]) {
    const a = await answer(req("tools/list", {}, "list-1"), { ...o, headers: heads("tools/list") });
    assert.equal(a.status, 200, label);
    assert.equal(a.json.id, "list-1");
    const r = a.json.result;
    assert.deepEqual(Object.keys(r), ["resultType", "tools", "catalog", "ttlMs", "cacheScope", "_meta"], label);
    assert.equal(r.resultType, "complete");
    assert.deepEqual(r.tools, mcpCatalogBuilt().tools);
    const old = (await answer({ jsonrpc: "2.0", id: 1, method: "tools/list" }, o)).json.result;
    assert.deepEqual(r.catalog, old.catalog, "the same version and digest as the other kind's");
    assert.deepEqual(r.tools, old.tools);
    assert.equal(r.ttlMs, MCP_TOOLS_TTL_MS);
    assert.equal(r.cacheScope, "private");
    assert.deepEqual(r._meta, { "io.modelcontextprotocol/serverInfo": SERVER });
    assert.deepEqual(a.asked, o.invite ? ["lookupInvite"] : []);
  }
});

test("tools/call over revision 2026-07-28: resultType first and the server last on every result, the looks open nothing, a joining tool opens once", async () => {
  const meta = { "io.modelcontextprotocol/serverInfo": SERVER };
  const go = (name, args, o) => answer(toolCall(name, args), { headers: heads("tools/call", name), ...o });
  // a joining tool: the look, then access() once
  let a = await go("whoami", {}, { invite: "tok-good", lookup: UNUSED, access: ACC });
  assert.deepEqual(Object.keys(a.json.result), ["resultType", "content", "structuredContent", "_meta"]);
  assert.equal(a.json.result.resultType, "complete");
  assert.equal(a.json.result.structuredContent.name, "Ada");
  assert.deepEqual(a.json.result._meta, meta);
  assert.deepEqual(a.asked, ["lookupInvite", "access"]);
  // a tool error is still complete, with the server in _meta
  a = await go("post_message", {}, { invite: "tok-good", lookup: ACTIVE, access: ACC });
  assert.deepEqual(Object.keys(a.json.result), ["resultType", "content", "isError", "_meta"]);
  assert.equal(a.json.result.isError, true);
  assert.deepEqual(a.json.result._meta, meta);
  // the looks and the leave: never access()
  a = await go("get_invite", {}, { invite: "tok-good", lookup: UNUSED, preview: PREVIEW });
  assert.deepEqual(Object.keys(a.json.result), ["resultType", "content", "structuredContent", "_meta"]);
  assert.equal(a.json.result.structuredContent.invite.status, "unused");
  assert.deepEqual(a.asked, ["lookupInvite", "previewInvite"]);
  a = await go("get_start_page", {}, { invite: "tok-good", lookup: UNUSED, view: base });
  assert.deepEqual(a.json.result, { resultType: "complete", content: [{ type: "text", text: startPage(base, ORIGIN, "unit", PIN) }], _meta: meta });
  assert.deepEqual(a.asked, ["lookupInvite", "startView"]);
  a = await go("leave_room", { confirm: "unit" }, { invite: "tok-good", lookup: UNUSED, leave: { ok: false, status: 409, code: "not_joined", error: "Not joined." } });
  assert.deepEqual(a.json.result, { resultType: "complete", content: [{ type: "text", text: "Not joined." }], isError: true, structuredContent: { code: "not_joined" }, _meta: meta });
  assert.deepEqual(a.asked, ["lookupInvite", "leave"]);
  // the owner key: get_invite has no invite to look at, get_start_page no page, leave_room no member
  a = await go("get_invite", {}, { owner: true });
  assert.deepEqual(a.json.error, { code: -32001, message: MCP_NO_TOKEN, data: { code: "invite_missing" } });
  a = await go("get_start_page", {}, { owner: true });
  assert.deepEqual(a.json.result, { resultType: "complete", content: [{ type: "text", text: OWNER_NO_START_PAGE }], isError: true, _meta: meta });
  a = await go("leave_room", { confirm: "unit" }, { owner: true });
  assert.equal(a.json.result.isError, true);
  assert.deepEqual(a.json.result.structuredContent, { code: "owner_not_member" });
  assert.deepEqual(a.asked, []);
  // arguments left out are none; inputResponses and requestState change nothing
  a = await go("whoami", undefined, { invite: "tok-good", lookup: ACTIVE, access: ACC });
  const plain = await go("whoami", {}, { invite: "tok-good", lookup: ACTIVE, access: ACC });
  assert.equal(a.text, plain.text);
  a = await answer(req("tools/call", { name: "whoami", arguments: {}, inputResponses: { x: { action: "accept" } }, requestState: "opaque" }), { headers: heads("tools/call", "whoami"), invite: "tok-good", lookup: ACTIVE, access: ACC });
  assert.equal(a.text, plain.text);
  // Mcp-Name as a Base64 sentinel of a real tool is served
  a = await answer(toolCall("whoami", {}), { headers: heads("tools/call", "=?base64?" + btoa("whoami") + "?="), invite: "tok-good", lookup: ACTIVE, access: ACC });
  assert.equal(a.text, plain.text);
});

// ---- 9. The unknown tool: no access() in either kind ----

test("a tools/call that names no tool of the catalog never asks access(), in either kind and every token state", async () => {
  const states = [
    ["an unused invite", { invite: "tok-good", lookup: UNUSED }, null, null],
    ["an active invite", { invite: "tok-good", lookup: ACTIVE }, null, null],
    ["the owner key", { owner: true }, null, null],
    ["a revoked token", { invite: "tok-gone", lookup: REVOKED }, [REVOKED.error, "invite_revoked"], [REVOKED.error, "invite_revoked"]],
    ["an unknown token", { invite: "tok-bad" }, [INVALID.error, "invite_invalid"], [START_INVALID, "invite_invalid"]],
    ["no token", {}, [MCP_NO_TOKEN, "invite_missing"], [MCP_NO_TOKEN, "invite_missing"]],
  ];
  for (const name of ["no_such_tool", "constructor", "__proto__", "toString", "hasOwnProperty", "valueOf", "WHOAMI"]) {
    assert.equal(mcpHasTool(name), false, name);
    for (const [label, o, older, newer] of states) {
      const what = name + ", " + label;
      const text = "Unknown tool: " + name + ". Call tools/list for the catalog.";
      // the initialize kind: the same tool error as ever, or the refusal access() gave
      const one = await answer({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name, arguments: {} } }, { ...o, access: ACC });
      assert.equal(one.status, 200, what);
      assert.deepEqual(one.json, older ? { jsonrpc: "2.0", id: 9, error: { code: -32001, message: older[0], data: { code: older[1] } } } : { jsonrpc: "2.0", id: 9, result: { content: [{ type: "text", text }], isError: true } }, what);
      assert.ok(!one.asked.includes("access"), what + ": " + one.asked);
      // the initialize kind's look is a fresh one, beside the look before the body
      assert.deepEqual(one.asked, o.invite && !o.owner ? ["lookupInvite", "lookupInvite"] : [], what);
      // revision 2026-07-28: -32602 after the token's verdict
      const two = await answer(toolCall(name, {}, 9), { ...o, access: ACC, headers: heads("tools/call", name) });
      assert.equal(two.status, 200, what);
      assert.deepEqual(two.json, newer ? { jsonrpc: "2.0", id: 9, error: { code: -32001, message: newer[0], data: { code: newer[1] } } } : { jsonrpc: "2.0", id: 9, error: { code: -32602, message: text } }, what);
      assert.deepEqual(two.asked, o.invite && !o.owner ? ["lookupInvite"] : [], what);
    }
  }
  // inside a batch too
  const b = await answer([{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "no_such_tool" } }, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "constructor", arguments: {} } }], { invite: "tok-good", lookup: UNUSED, access: ACC });
  assert.deepEqual(b.json.map((x) => x.result.content[0].text), ["Unknown tool: no_such_tool. Call tools/list for the catalog.", "Unknown tool: constructor. Call tools/list for the catalog."]);
  assert.ok(!b.asked.includes("access"), String(b.asked));
  // a long name is cut to 128 over revision 2026-07-28, and repeated whole over the other kind (as it always was)
  const longName = "z".repeat(300);
  const c = await answer(toolCall(longName, {}), { invite: "tok-good", lookup: ACTIVE, headers: heads("tools/call", longName) });
  // the template keeps its own full stop after the cut name's "..."
  assert.equal(c.json.error.message, "Unknown tool: " + "z".repeat(128) + ".... Call tools/list for the catalog.");
  const d = await answer({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: longName } }, { invite: "tok-good", lookup: ACTIVE });
  assert.equal(d.json.result.content[0].text, "Unknown tool: " + longName + ". Call tools/list for the catalog.");
});

// ---- 10. to 12. Mcp-Name, headers that change nothing, sizes ----

test("Mcp-Name: the Base64 sentinel decoded, a malformed one refused, anything else taken as it is", () => {
  const cases = [
    ["get_invite", "get_invite"],
    ["=?base64?aMOpbGxvIHfDtnJsZA==?=", "héllo wörld"],
    ["=?base64??=", ""],
    ["=?base64?=", undefined],
    ["=?base64?abc?=", undefined],
    ["=?base64?/w==?=", undefined],
    ["=?base64?Zm9v?=", "foo"],
    // a leading U+FEFF stays in the name, so it cannot pass for the name without it
    ["=?base64?77u/d2hvYW1p?=", "\ufeffwhoami"],
    ["=?base64?Zm9v ?=", undefined],
    ["=?BASE64?Zm9v?=", "=?BASE64?Zm9v?="],
    ["=?base64?x", "=?base64?x"],
  ];
  for (const [sent, want] of cases) assert.equal(mcpDecodeName(sent), want, sent);
});

test("Origin, Mcp-Session-Id and Last-Event-ID change no answer in either kind, and no answer carries a session id", async () => {
  const extra = [{ Origin: "https://evil.example" }, { Origin: "null" }, { "Mcp-Session-Id": "abc-123" }, { "Last-Event-ID": "7" }];
  const o = { invite: "tok-good", lookup: ACTIVE, access: ACC, view: base };
  const bodies = [
    [{ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, {}],
    [{ jsonrpc: "2.0", id: 1, method: "tools/list" }, {}],
    [{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "whoami", arguments: {} } }, {}],
    [{ jsonrpc: "2.0", method: "notifications/initialized" }, {}],
    [req("server/discover"), heads("server/discover")],
    [req("tools/list"), heads("tools/list")],
    [toolCall("whoami", {}), heads("tools/call", "whoami")],
    [req("ping"), heads("ping")],
  ];
  for (const [body, headers] of bodies) {
    const plain = await answer(body, { ...o, headers });
    assert.equal(plain.headers.get("Mcp-Session-Id"), null);
    for (const e of extra) {
      const a = await answer(body, { ...o, headers: { ...headers, ...e } });
      assert.equal(a.status, plain.status, body.method + " " + JSON.stringify(e));
      assert.equal(a.text, plain.text, body.method + " " + JSON.stringify(e));
      assert.equal(a.headers.get("Mcp-Session-Id"), null);
    }
  }
});

test("a tokenless body of revision 2026-07-28 over SMALL_BODY_MAX gets the same 413 as any, before it is read as either kind", async () => {
  const big = req("server/discover", { pad: "x".repeat(SMALL_BODY_MAX + 1024) });
  const a = await answer(big, { headers: heads("server/discover") });
  const b = await answer({ jsonrpc: "2.0", id: 1, method: "initialize", params: { pad: "x".repeat(SMALL_BODY_MAX + 1024) } }, {});
  assert.equal(a.status, 413);
  assert.equal(a.text, b.text);
  assert.match(a.json.error.message, /^Request too large: without a valid invite token a request can be up to \d+ MiB$/);
  assert.deepEqual(a.asked, []);
});

// ---- 13. The catalog: titles, and every tool reaches its case ----

test("every tool has its own title, the titles name no other tool, and every tool past the looks reaches its case in mcpCallTool", async () => {
  const tools = mcpCatalogBuilt().tools;
  const titles = tools.map((t) => t.title);
  for (const t of tools) assert.ok(typeof t.title === "string" && t.title.trim().length > 0 && t.title.length <= 40, t.name + " has no title");
  assert.equal(new Set(titles).size, titles.length, "titles differ");
  assert.deepEqual(Object.keys(MCP_TOOL_TITLES).sort(), tools.map((t) => t.name).sort(), "one title per tool of the catalog, and none else");
  assert.deepEqual(Object.keys(tools[0]), ["name", "title", "description", "inputSchema", "annotations"]);
  for (const t of tools) assert.ok(mcpHasTool(t.name), t.name);
  // with a room that throws on any call, no tool's error is "Unknown tool"
  const stub = new Proxy({}, { get: (_, name) => async () => { throw new Error("room call " + String(name)); } });
  for (const t of tools) {
    if (["get_invite", "get_start_page", "leave_room"].includes(t.name)) continue;
    let error = null;
    try { await mcpCallTool({}, stub, "unit", ORIGIN, false, { kind: "agent" }, "Ada", t.name, {}, "tok"); } catch (e) { error = String(e && e.message); }
    assert.ok(!/^Unknown tool/.test(String(error)), t.name + ": " + error);
  }
});

// ---- 14. The skills over revision 2026-07-28 (worker/agents/skills.ts) ----

/** the five methods, each with params that pass its own check, and the result body it answers */
const SKILL_CALLS = () => {
  const first = SERVED_SKILLS[0], file = SERVED_SKILLS[2].files[1];
  return [
    ["skills/list", {}, undefined, skillsList()],
    ["skills/get", { uri: first.uri }, undefined, skillGet(first.uri)],
    ["resources/list", {}, undefined, resourcesList()],
    ["resources/templates/list", {}, undefined, resourceTemplatesList()],
    ["resources/read", { uri: file.uri }, file.uri, resourceRead(file.uri)],
  ];
};
const ROOM_GONE = { ok: false, status: 410, code: "room_deleted", error: GONE_MSG };

test("the skills' five methods take exactly tools/list's verdict at a room's address, asking at most the one look, and serve the same bytes in every passing state", async () => {
  const refused = [
    ["no token", {}, "invite_missing", MCP_NO_TOKEN, []],
    ["a token only in the URL", { search: "?invite=tok-in-the-url" }, "invite_missing", MCP_NO_TOKEN, []],
    ["an unknown token", { invite: "tok-bad" }, "invite_invalid", START_INVALID, ["lookupInvite"]],
    ["a revoked token", { invite: "tok-gone", lookup: REVOKED }, "invite_revoked", REVOKED.error, ["lookupInvite"]],
    ["a token at a room that does not exist", { invite: "tok-good", lookup: ROOM_GONE }, "room_deleted", GONE_MSG, ["lookupInvite"]],
  ];
  const passing = [
    ["an unused invite", { invite: "tok-good", lookup: UNUSED }, ["lookupInvite"]],
    ["an active invite", { invite: "tok-good", lookup: ACTIVE }, ["lookupInvite"]],
    ["the owner key", { owner: true }, []],
    ["the owner key beside a token", { owner: true, invite: "tok-good" }, []],
  ];
  for (const [method, params, name, body] of SKILL_CALLS()) {
    for (const [label, o, code, message, asked] of refused) {
      const a = await answer(req(method, params), { ...o, headers: heads(method, name), access: ACC });
      assert.equal(a.status, 200, method + ", " + label);
      assert.deepEqual(a.json, { jsonrpc: "2.0", id: 1, error: { code: -32001, message, data: { code } } }, method + ", " + label);
      assert.deepEqual(a.asked, asked, method + ", " + label + ": only the look, nothing opened");
    }
    for (const [label, o, asked] of passing) {
      const a = await answer(req(method, params), { ...o, headers: heads(method, name), access: ACC });
      assert.equal(a.status, 200, method + ", " + label);
      const r = a.json.result;
      assert.deepEqual(Object.keys(r), ["resultType", ...Object.keys(body), "_meta"], method + ", " + label + ": resultType first, _meta last");
      const { resultType, _meta, ...rest } = r;
      assert.equal(resultType, "complete");
      assert.deepEqual(_meta, { "io.modelcontextprotocol/serverInfo": SERVER });
      assert.equal(JSON.stringify(rest), JSON.stringify(body), method + ", " + label + ": the module's answer, byte for byte");
      assert.equal(r.ttlMs, MCP_SKILLS_TTL_MS);
      assert.equal(r.cacheScope, "private");
      assert.deepEqual(a.asked, asked, method + ", " + label + ": at most the one look; never access()");
      assert.equal(a.headers.get("Access-Control-Allow-Origin"), "*");
    }
  }
});

test("the skills' own parameter checks come before the credential's, in-band; a URI no skill serves comes after it", async () => {
  const file = SERVED_SKILLS[0].files[0].uri;
  const cases = [
    ["skills/list", { cursor: "abc" }, undefined, "Invalid cursor: skills/list answers in one page; send it without a cursor."],
    ["resources/list", { cursor: 0 }, undefined, "Invalid cursor: resources/list answers in one page; send it without a cursor."],
    ["resources/templates/list", { cursor: "" }, undefined, "Invalid cursor: resources/templates/list answers in one page; send it without a cursor."],
    ["skills/get", {}, undefined, "skills/get needs params.uri: the URI of a skill's SKILL.md."],
    ["skills/get", { uri: 5 }, undefined, "skills/get needs params.uri: the URI of a skill's SKILL.md."],
    ["skills/get", { uri: "" }, undefined, "skills/get needs params.uri: the URI of a skill's SKILL.md."],
    ["resources/read", {}, undefined, "resources/read needs params.uri."],
    ["resources/read", { uri: ["x"] }, undefined, "resources/read needs params.uri."],
    ["resources/read", { uri: "" }, "", "resources/read needs params.uri."],
  ];
  for (const [method, params, name, message] of cases) {
    for (const [tl, o] of [...TOKENS, ["a revoked token", { invite: "tok-gone", lookup: REVOKED }]]) {
      const a = await answer(req(method, params), { ...o, headers: heads(method, name) });
      assert.equal(a.status, 200, method + " " + JSON.stringify(params) + ", " + tl);
      assert.deepEqual(a.json, { jsonrpc: "2.0", id: 1, error: { code: -32602, message } }, method + " " + JSON.stringify(params) + ", " + tl);
    }
  }
  // a null cursor is none
  assert.equal((await answer(req("skills/list", { cursor: null }), { invite: "tok-good", lookup: ACTIVE, headers: heads("skills/list") })).json.result.resultType, "complete");
  // an unknown URI: after the verdict, so a caller without a credential learns nothing of the skills
  const longUri = "skill://agent-chat/" + "x".repeat(300);
  const unknown = [
    ["skills/get", "skill://agent-chat/no-such/SKILL.md", { code: -32602, message: "No skill is served at skill://agent-chat/no-such/SKILL.md" }],
    ["skills/get", SERVED_SKILLS[2].files[1].uri, { code: -32602, message: "No skill is served at " + SERVED_SKILLS[2].files[1].uri }],
    ["skills/get", "skill://agent-chat/taking-part", { code: -32602, message: "No skill is served at skill://agent-chat/taking-part" }],
    ["skills/get", "constructor", { code: -32602, message: "No skill is served at constructor" }],
    ["resources/read", "skill://agent-chat/taking-part/", { code: -32602, message: "Resource not found: skill://agent-chat/taking-part/", data: { uri: "skill://agent-chat/taking-part/" } }],
    ["resources/read", "__proto__", { code: -32602, message: "Resource not found: __proto__", data: { uri: "__proto__" } }],
    ["resources/read", longUri, { code: -32602, message: "Resource not found: " + longUri.slice(0, 128) + "...", data: { uri: longUri.slice(0, 128) + "..." } }],
  ];
  for (const [method, uri, error] of unknown) {
    const name = method === "resources/read" ? uri : undefined;
    let a = await answer(req(method, { uri }), { invite: "tok-good", lookup: ACTIVE, headers: heads(method, name) });
    assert.equal(a.status, 200, method + " " + uri);
    assert.deepEqual(a.json, { jsonrpc: "2.0", id: 1, error }, method + " " + uri);
    a = await answer(req(method, { uri }), { headers: heads(method, name) });
    assert.deepEqual(a.json.error, { code: -32001, message: MCP_NO_TOKEN, data: { code: "invite_missing" } }, method + " " + uri + " without a token: the credential first");
  }
  // and a known one, so the refusal above is not every answer
  const a = await answer(req("resources/read", { uri: file }), { invite: "tok-good", lookup: ACTIVE, headers: heads("resources/read", file) });
  assert.equal(a.json.result.contents[0].uri, file);
});

test("Mcp-Name on resources/read: required and compared with params.uri, its Base64 sentinel decoded; not read on skills/get or the lists", async () => {
  const uri = SERVED_SKILLS[0].uri;
  const o = { invite: "tok-good", lookup: ACTIVE };
  const refusals = [
    [heads("resources/read"), "Header mismatch: the Mcp-Name header is missing; on resources/read it must equal params.uri."],
    [heads("resources/read", "skill://agent-chat/room-board/SKILL.md"), "Header mismatch: Mcp-Name header value 'skill://agent-chat/room-board/SKILL.md' does not match body value '" + uri + "'"],
    [heads("resources/read", uri.toUpperCase()), "Header mismatch: Mcp-Name header value '" + uri.toUpperCase() + "' does not match body value '" + uri + "'"],
    [heads("resources/read", "=?base64?abc?="), "Header mismatch: the Mcp-Name header's =?base64?...?= value is not Base64 of UTF-8 text."],
  ];
  for (const [label, oo] of [["a good token", o], ["no token", {}]]) {
    for (const [headers, message] of refusals) {
      const a = await answer(req("resources/read", { uri }), { ...oo, headers });
      assert.equal(a.status, 400, label + " " + message);
      assert.deepEqual(a.json, { jsonrpc: "2.0", id: 1, error: { code: -32020, message } }, label);
      assert.deepEqual(a.asked, oo.invite ? ["lookupInvite"] : [], label);
    }
  }
  // the sentinel of the uri itself is served, as the plain one is
  const plain = await answer(req("resources/read", { uri }), { ...o, headers: heads("resources/read", uri) });
  const coded = await answer(req("resources/read", { uri }), { ...o, headers: heads("resources/read", "=?base64?" + btoa(uri) + "?=") });
  assert.equal(plain.status, 200);
  assert.equal(coded.text, plain.text);
  // a uri that is no string: no header is asked for, and the method's own refusal answers
  assert.equal((await answer(req("resources/read", { uri: 5 }), { ...o, headers: heads("resources/read") })).json.error.message, "resources/read needs params.uri.");
  // skills/get and the lists do not read the header: any value, or none, answers the same
  for (const [method, params] of [["skills/get", { uri }], ["skills/list", {}], ["resources/list", {}]]) {
    const none = await answer(req(method, params), { ...o, headers: heads(method) });
    const other = await answer(req(method, params), { ...o, headers: heads(method, "anything at all") });
    assert.equal(none.status, 200, method);
    assert.equal(other.text, none.text, method);
  }
  // tools/call's refusals come out as before
  assert.equal((await answer(toolCall("whoami", {}), { ...o, headers: heads("tools/call") })).json.error.message, "Header mismatch: the Mcp-Name header is missing; on tools/call it must equal params.name.");
});

test("over the initialize kind nothing changes: the skills' methods are refused or not found as before, initialize declares only tools", async () => {
  for (const method of ["skills/list", "skills/get", "resources/list", "resources/templates/list", "resources/read"]) {
    const body = { jsonrpc: "2.0", id: 4, method, params: method.endsWith("get") || method.endsWith("read") ? { uri: SERVED_SKILLS[0].uri } : {} };
    for (const [label, o, want] of [
      ["an active invite", { invite: "tok-good", lookup: ACTIVE }, { code: -32601, message: "Method not found: " + method }],
      ["the owner key", { owner: true }, { code: -32601, message: "Method not found: " + method }],
      ["no token", {}, { code: -32001, message: MCP_NO_TOKEN, data: { code: "invite_missing" } }],
      ["an unknown token", { invite: "tok-bad" }, { code: -32001, message: INVALID.error, data: { code: "invite_invalid" } }],
    ]) {
      for (const headers of [{}, { "MCP-Protocol-Version": "2025-11-25" }]) {
        const a = await answer(body, { ...o, headers });
        assert.equal(a.status, 200, method + ", " + label);
        assert.deepEqual(a.json, { jsonrpc: "2.0", id: 4, error: want }, method + ", " + label);
        assert.ok(!a.asked.includes("access"), method + ", " + label);
      }
    }
  }
  const init = await answer({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25" } }, { invite: "tok-good", lookup: UNUSED });
  assert.deepEqual(init.json.result.capabilities, { tools: {} });
  assert.ok(!init.text.includes("io.modelcontextprotocol/skills") && !init.text.includes("\"resources\""), "initialize names no skill");
});
