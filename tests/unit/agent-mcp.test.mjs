// The agent key's MCP address (worker/routes/agent.ts agentMcpRoute) on
// both kinds of protocol revision, against a Room namespace of real Room
// objects reached through stubs that record each method asked
// (agent-world.mjs): initialize and server/discover for each kind of
// credential, tools/list refused at HTTP 200 with -32001, the per-request
// checks as the room's own address makes them, no batches, the body caps,
// the unknown tool and the room tool's own refusals asking no room, and
// one tool call through the room's address (routes/agents.ts mcpRoute) and
// through the key asking the room the same methods with the same token in
// the same order. Keys and tokens are made here. Run with `npm run test:unit`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeWorld, read, agentInvite, ORIGIN } from "./agent-world.mjs";
import { agentCreateRoute, agentMcpRoute } from "../../worker/routes/agent.ts";
import { mcpRoute } from "../../worker/routes/agents.ts";
import { AGENT_KEY_INVALID, AGENT_KEY_MISSING, NOT_AGENT_KEY, agentInstructions } from "../../worker/agents/onboarding.ts";
import { MCP_AGENT_CATALOG_VERSION, MCP_CATALOG_VERSION, MCP_MODERN_VERSIONS, agentServerInfo, mcpAgentCatalogBuilt } from "../../worker/agents/mcp.ts";
import { API_VERSION } from "../../worker/agents/notices.ts";
import { MCP_TOOLS_TTL_MS, SMALL_BODY_MAX } from "../../worker/limits.ts";
import { newAgentKey } from "../../worker/lib/agentkey.ts";

const V = "io.modelcontextprotocol/protocolVersion", C = "io.modelcontextprotocol/clientCapabilities";
const NEW = MCP_MODERN_VERSIONS[0];
/** a request of revision 2026-07-28 as the official v2 client writes it, and its headers */
const req = (method, params = {}, id = 1) => ({ jsonrpc: "2.0", id, method, params: { ...params, _meta: { [V]: NEW, [C]: {} } } });
const heads = (method, name) => ({ "MCP-Protocol-Version": NEW, "Mcp-Method": method, ...(name === undefined ? {} : { "Mcp-Name": name }) });
const call = (name, args, id = 1) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });

/** a world with these rooms, an agent invite "Hank" in each, and a key holding them */
async function keyed(names = ["lima", "oslo"]) {
  const w = makeWorld();
  const tok = {};
  for (const n of names) tok[n] = agentInvite(w.room(n), "Hank");
  const r = await read(agentCreateRoute(w.rc("POST", "/api/agents", { json: { rooms: names.map((room) => ({ room, token: tok[room] })) }, headers: { "CF-Connecting-IP": "10.2.0.1" } })));
  assert.equal(r.status, 201, r.text);
  return { w, tok, key: r.json.key, id: w.identities()[0] };
}
/** POST /api/mcp: its answer, and the objects asked meanwhile (name.method) */
async function mcp(w, body, headers = {}) {
  const mark = w.asked.length;
  const a = await read(agentMcpRoute(w.rc("POST", "/api/mcp", { json: body, headers })));
  return { ...a, asked: w.asked.slice(mark).map((x) => x.name + "." + x.method) };
}
const auth = (key) => ({ Authorization: "Bearer " + key });
const CREDS = async (k) => [["ok", auth(k.key)], ["none", {}], ["invite", auth(k.tok.lima)], ["invalid", auth(newAgentKey().key)], ["invalid", auth(".ao1.not-yet")]];
const REFUSED = { none: ["agent_key_missing", AGENT_KEY_MISSING], invite: ["not_agent_key", NOT_AGENT_KEY], invalid: ["agent_key_invalid", AGENT_KEY_INVALID] };

test("initialize answers every credential with the agent server, its catalog, the changes link and the instructions for it", async () => {
  const k = await keyed();
  const cat = mcpAgentCatalogBuilt();
  for (const [variant, headers] of await CREDS(k)) {
    const r = await mcp(k.w, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }, headers);
    assert.equal(r.status, 200, variant);
    assert.deepEqual(r.json.result, {
      protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: agentServerInfo(ORIGIN),
      catalog: { version: MCP_AGENT_CATALOG_VERSION, digest: cat.digest },
      changes: { api_version: API_VERSION, catalog_version: MCP_CATALOG_VERSION, url: ORIGIN + "/api/changes" },
      instructions: agentInstructions(ORIGIN, variant),
    }, variant);
    assert.ok(r.asked.every((a) => a.endsWith(".agentOpen")), variant + ": no room asked: " + r.asked);
  }
  assert.deepEqual(agentServerInfo(ORIGIN), { name: "agent-chat-agent", title: "Agent Chat: your rooms", version: MCP_AGENT_CATALOG_VERSION, websiteUrl: ORIGIN });
  // ping and notifications, for anyone
  assert.deepEqual((await mcp(k.w, { jsonrpc: "2.0", id: 2, method: "ping" })).json, { jsonrpc: "2.0", id: 2, result: {} });
  const n = await mcp(k.w, { jsonrpc: "2.0", method: "notifications/initialized" });
  assert.equal(n.status, 202);
  assert.equal(n.text, "");
});

test("server/discover answers every credential, as the room's address does, with the agent's server in _meta", async () => {
  const k = await keyed();
  for (const [variant, headers] of await CREDS(k)) {
    const r = await mcp(k.w, req("server/discover"), { ...headers, ...heads("server/discover") });
    assert.equal(r.status, 200, variant);
    assert.deepEqual(r.json.result, {
      resultType: "complete", supportedVersions: MCP_MODERN_VERSIONS, capabilities: { tools: {} }, instructions: agentInstructions(ORIGIN, variant),
      catalog: { version: MCP_AGENT_CATALOG_VERSION, digest: mcpAgentCatalogBuilt().digest },
      changes: { api_version: API_VERSION, catalog_version: MCP_CATALOG_VERSION, url: ORIGIN + "/api/changes" }, ttlMs: 0, cacheScope: "private",
      _meta: { "io.modelcontextprotocol/serverInfo": agentServerInfo(ORIGIN) },
    }, variant);
  }
});

test("tools/list: the catalog for a key, -32001 at HTTP 200 with the code and sentence otherwise, in both kinds", async () => {
  const k = await keyed();
  for (const [variant, headers] of await CREDS(k)) {
    const a = await mcp(k.w, { jsonrpc: "2.0", id: 1, method: "tools/list" }, headers);
    const b = await mcp(k.w, req("tools/list"), { ...headers, ...heads("tools/list") });
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    if (variant === "ok") {
      assert.deepEqual(a.json.result, { tools: mcpAgentCatalogBuilt().tools, catalog: { version: MCP_AGENT_CATALOG_VERSION, digest: mcpAgentCatalogBuilt().digest } });
      assert.equal(b.json.result.ttlMs, MCP_TOOLS_TTL_MS);
      assert.equal(b.json.result.cacheScope, "private");
      assert.deepEqual(b.json.result.tools, mcpAgentCatalogBuilt().tools);
      continue;
    }
    const [code, message] = REFUSED[variant];
    for (const x of [a, b]) assert.deepEqual(x.json.error, { code: -32001, message, data: { code } }, variant);
    // a tools/call is refused the same way, and no room is asked
    const c = await mcp(k.w, call("whoami", { room: "lima" }), headers);
    assert.deepEqual(c.json.error, { code: -32001, message, data: { code } }, variant + " tools/call");
    const d = await mcp(k.w, req("tools/call", { name: "whoami", arguments: { room: "lima" } }), { ...headers, ...heads("tools/call", "whoami") });
    assert.deepEqual(d.json.error, { code: -32001, message, data: { code } }, variant + " per-request tools/call");
    for (const x of [a, b, c, d]) assert.ok(x.asked.every((n) => n.endsWith(".agentOpen")), variant + ": " + x.asked);
  }
});

test("the per-request kind's checks come first, as at the room's address; a cursor and bad arguments are -32602", async () => {
  const k = await keyed();
  let r = await mcp(k.w, req("tools/list"), { ...auth(k.key), "MCP-Protocol-Version": "2099-01-01" });
  assert.equal(r.status, 400);
  assert.equal(r.json.error.code, -32020, "the header against the body");
  r = await mcp(k.w, req("tools/list"), { ...auth(k.key), "MCP-Protocol-Version": NEW });
  assert.equal(r.status, 400);
  assert.equal(r.json.error.code, -32020, "no Mcp-Method");
  r = await mcp(k.w, req("ping"), { ...auth(k.key), ...heads("ping") });
  assert.equal(r.status, 404);
  assert.equal(r.json.error.code, -32601);
  r = await mcp(k.w, { jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: { [V]: "2099-01-01", [C]: {} } } }, { ...auth(k.key), "MCP-Protocol-Version": "2099-01-01", "Mcp-Method": "tools/list" });
  assert.equal(r.status, 400);
  assert.equal(r.json.error.code, -32022);
  r = await mcp(k.w, req("tools/list", { cursor: "x" }), { ...auth(k.key), ...heads("tools/list") });
  assert.equal(r.json.error.code, -32602);
  r = await mcp(k.w, req("tools/call", { name: "whoami", arguments: "lima" }), { ...auth(k.key), ...heads("tools/call", "whoami") });
  assert.equal(r.json.error.code, -32602);
  r = await mcp(k.w, req("tools/call", { arguments: {} }), { ...auth(k.key), ...heads("tools/call") });
  assert.deepEqual(r.json.error, { code: -32602, message: "tools/call needs params.name" });
});

test("no batches, for anyone; the body caps follow the credential; GET is 405", async () => {
  const k = await keyed();
  for (const headers of [auth(k.key), {}, auth(k.tok.lima)]) {
    for (const batch of [[], [{ jsonrpc: "2.0", id: 1, method: "ping" }], [{ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }]]) {
      const r = await mcp(k.w, batch, headers);
      assert.equal(r.status, 400);
      assert.deepEqual(r.json, { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request: this address takes no batches; send each request as its own POST." } });
    }
  }
  const big = { jsonrpc: "2.0", id: 1, method: "initialize", params: { pad: "x".repeat(SMALL_BODY_MAX + 10) } };
  for (const headers of [{}, auth(k.tok.lima), auth(newAgentKey().key)]) {
    const r = await mcp(k.w, big, headers);
    assert.equal(r.status, 413);
    assert.deepEqual(r.json, { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Request too large: without a valid agent key a request can be up to 1 MiB" } });
  }
  const ok = await mcp(k.w, big, auth(k.key));
  assert.equal(ok.status, 200, "a current key's request may be bigger");
  const bad = await mcp(k.w, "{nope", auth(k.key));
  assert.deepEqual(bad.json, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error: send one JSON-RPC request object" } });
  const g = await read(agentMcpRoute(k.w.rc("GET", "/api/mcp", { headers: auth(k.key) })));
  assert.equal(g.status, 405);
  assert.deepEqual(g.json, { error: "Method not allowed. POST JSON-RPC here; call tools/list for the catalog." });
});

test("an unknown tool and every refusal of a room tool's room join nothing and ask no room", async () => {
  const k = await keyed();
  const cases = [
    [call("no_such_tool", { room: "lima" }), "Unknown tool: no_such_tool. Call tools/list for the catalog.", undefined],
    [call("whoami", {}), "\"room\" is required: one of your rooms, as list_rooms gives it", undefined],
    [call("whoami", { room: 7 }), "\"room\" is required: one of your rooms, as list_rooms gives it", undefined],
    [call("whoami", { room: "Not A Room" }), "Room names are 1-64 lowercase letters, digits, - or _", undefined],
    [call("whoami", { room: "__agent-x" }), "Room names are 1-64 lowercase letters, digits, - or _", undefined],
    [call("whoami", { room: "rome" }), "rome is not on your key: list_rooms lists yours; add_room adds one.", { code: "room_not_held", room: "rome" }],
  ];
  for (const [body, text, structured] of cases) {
    const r = await mcp(k.w, body, auth(k.key));
    assert.equal(r.json.result.isError, true, text);
    assert.equal(r.json.result.content[0].text, text);
    assert.deepEqual(r.json.result.structuredContent, structured, text);
    assert.ok(r.asked.every((n) => n.startsWith("__agent-")), "no room asked: " + r.asked);
  }
  // over the per-request kind an unknown tool is -32602, as at the room's address
  const p = await mcp(k.w, req("tools/call", { name: "no_such_tool", arguments: {} }), { ...auth(k.key), ...heads("tools/call", "no_such_tool") });
  assert.equal(p.json.error.code, -32602);
  for (const n of ["lima", "oslo"]) assert.equal(k.w.harness(n).one("SELECT used FROM inv WHERE name = 'Hank'").used, null, n + " unopened");
});

/** the methods a room was asked and their arguments, the token written as TOKEN */
const roomCalls = (w, room, mark, token) => w.asked.slice(mark).filter((a) => a.name === room).map((a) => a.method + " " + JSON.stringify(a.args).split(token).join("TOKEN"));

test("a room tool's call through the key asks the room the same methods, with the same token, in the same order as at the room's own address", async () => {
  const tools = [
    ["get_invite", {}],
    ["get_start_page", {}],
    ["whoami", {}],
    ["post_message", { text: "hello", client_msg_id: "same-hello" }],
    ["leave_room", { confirm: "lima" }],
  ];
  for (const [name, args] of tools) {
    for (const kind of ["initialize", "per-request"]) {
      // the room's own address, in a world of its own
      const a = await keyed(["lima"]);
      const ra = makeRoomAddress(a.w, a.tok.lima);
      let mark = a.w.asked.length;
      const direct = await read(mcpRoute(ra.rc(kind === "initialize" ? call(name, args) : req("tools/call", { name, arguments: args }), kind === "initialize" ? {} : heads("tools/call", name)), ["/api/rooms/lima/mcp", "lima"]));
      const viaRoom = roomCalls(a.w, "lima", mark, a.tok.lima);
      // the same call through the key, in a world set up the same way
      const b = await keyed(["lima"]);
      mark = b.w.asked.length;
      const keyArgs = { room: "lima", ...args };
      const through = await mcp(b.w, kind === "initialize" ? call(name, keyArgs) : req("tools/call", { name, arguments: keyArgs }), { ...auth(b.key), ...(kind === "initialize" ? {} : heads("tools/call", name)) });
      const viaKey = roomCalls(b.w, "lima", mark, b.tok.lima);
      assert.deepEqual(viaKey, viaRoom, name + " (" + kind + ")");
      assert.ok(viaRoom.length >= 2, name + ": " + viaRoom.join(" | "));
      assert.equal(direct.json.result.isError, through.json.result.isError, name + " answered alike");
      // joined exactly when the room's own address joined
      assert.equal(!!b.w.harness("lima").one("SELECT used FROM inv WHERE name = 'Hank'").used, !!a.w.harness("lima").one("SELECT used FROM inv WHERE name = 'Hank'").used, name + " joined alike");
    }
  }
});

/** POST /api/rooms/lima/mcp with that token, as index.ts routes it */
function makeRoomAddress(w, token) {
  return { rc: (body, headers) => w.rc("POST", "/api/rooms/lima/mcp", { json: body, headers: { "X-Invite-Token": token, ...headers } }) };
}

test("a room's refusal through the key is the tool's error {code, room}, and the room is marked refused", async () => {
  const k = await keyed();
  k.w.harness("oslo").room.revoke(k.tok.oslo);
  const r = await mcp(k.w, call("post_message", { room: "oslo", text: "hi" }), auth(k.key));
  assert.equal(r.json.result.isError, true);
  assert.deepEqual(r.json.result.structuredContent, { code: "invite_revoked", room: "oslo" });
  assert.equal(r.json.result.content[0].text, "Room \"oslo\": This invite link has been revoked. Ask whoever gave it to you for a new one.");
  assert.ok(!r.asked.includes("oslo.access"), "refused at the look, before access()");
  const per = await mcp(k.w, req("tools/call", { name: "post_message", arguments: { room: "oslo", text: "hi" } }), { ...auth(k.key), ...heads("tools/call", "post_message") });
  assert.equal(per.status, 200);
  assert.deepEqual(per.json.result.structuredContent, { code: "invite_revoked", room: "oslo" }, "a tool error over the per-request kind too, not -32001");
  const list = await mcp(k.w, call("list_rooms", {}), auth(k.key));
  const oslo = list.json.result.structuredContent.rooms.find((x) => x.room === "oslo");
  assert.equal(oslo.state, "refused");
  assert.equal(oslo.code, "invite_revoked");
  assert.ok(oslo.at > 0);
  // the other room goes on
  const ok = await mcp(k.w, call("post_message", { room: "lima", text: "still here" }), auth(k.key));
  assert.ok(!ok.json.result.isError, ok.text.slice(0, 200));
});

test("through the key every mcp_call names the room, first", async () => {
  const k = await keyed(["lima"]);
  const h = k.w.harness("lima");
  agentInvite(h, "Pat", "human");
  h.room.access(h.one("SELECT token FROM inv WHERE name = 'Pat'").token, false);
  h.room.addDecision("Book the hotel", "", "Pat");
  const r = await mcp(k.w, call("get_room_state", { room: "lima" }), auth(k.key));
  const items = r.json.result.structuredContent.awaiting_you;
  assert.ok(items.length > 0, r.text.slice(0, 300));
  for (const i of items) assert.equal(Object.keys(i.mcp_call.arguments)[0], "room", JSON.stringify(i.mcp_call));
  for (const i of items) assert.equal(i.mcp_call.arguments.room, "lima");
  // and the room's own address names none
  const d = await read(mcpRoute(makeRoomAddress(k.w, k.tok.lima).rc(call("get_room_state", {})), ["/api/rooms/lima/mcp", "lima"]));
  for (const i of d.json.result.structuredContent.awaiting_you) assert.ok(!("room" in i.mcp_call.arguments));
});

test("whats_waiting answers at most once per gap, as a tool error with rate_limited and retry_after", async () => {
  const k = await keyed();
  const a = await mcp(k.w, call("whats_waiting", {}), auth(k.key));
  assert.ok(!a.json.result.isError, a.text.slice(0, 200));
  assert.deepEqual(Object.keys(a.json.result.structuredContent), ["rooms", "refused"]);
  const b = await mcp(k.w, call("whats_waiting", {}), auth(k.key));
  assert.equal(b.json.result.isError, true);
  assert.equal(b.json.result.structuredContent.code, "rate_limited");
  assert.ok(b.json.result.structuredContent.retry_after >= 1 && b.json.result.structuredContent.retry_after <= 15);
  assert.match(b.json.result.content[0].text, /^whats_waiting answers at most once every 15 seconds for a key; try again in \d+ seconds?\.$/);
  assert.ok(b.asked.every((n) => n.startsWith("__agent-")), "the refused glance asks no room");
});

test("a key disconnected while its request held the body back acts nowhere: the key is opened again after the body", async () => {
  const k = await keyed(["lima"]);
  // the open before the body passes; the identity is dropped before the tool runs
  const obj = k.w.harness(k.id).room;
  const realOpen = obj.agentOpen.bind(obj);
  let opens = 0;
  obj.agentOpen = (slot, v) => { opens++; const r = realOpen(slot, v); if (opens === 1) obj.ctx.storage.deleteAll(); return r; };
  const r = await mcp(k.w, call("post_message", { room: "lima", text: "after the disconnect" }), auth(k.key));
  assert.deepEqual(r.json.error, { code: -32001, message: AGENT_KEY_INVALID, data: { code: "agent_key_invalid" } });
  assert.ok(!r.asked.some((n) => n.startsWith("lima.")), "the room was not asked");
  assert.equal(k.w.harness("lima").db.prepare("SELECT COUNT(*) AS n FROM m").get().n, 0, "nothing posted");
});
