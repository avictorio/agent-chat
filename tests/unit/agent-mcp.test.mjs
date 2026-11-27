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

// ---- Muse wakes through the key: muse_register, the disconnect and the take-off ----
import { bridgeWorld } from "./bridge-world.mjs";
import { agentRemoveRoute, agentRoute } from "../../worker/routes/agent.ts";
import { MUSE_NOT_JOINED } from "../../worker/room/muse.ts";

/** rooms with the agent Hank on a key, the Muse bridge in the process, a gadget linked */
async function museKeyed(names = ["lima", "oslo"]) {
  const b = await bridgeWorld();
  const w = makeWorld({ env: b.env });
  const tok = {};
  for (const n of names) tok[n] = agentInvite(w.room(n), "Hank");
  const r = await read(agentCreateRoute(w.rc("POST", "/api/agents", { json: { rooms: names.map((room) => ({ room, token: tok[room] })) }, headers: { "CF-Connecting-IP": "10.2.0.9" } })));
  assert.equal(r.status, 201, r.text);
  const g = await b.connect();
  return { b, w, tok, key: r.json.key, id: w.identities()[0], ...g };
}
const result = (r) => r.json.result;
const hookIn = (w, room) => w.harness(room).all("SELECT kind, link, routing FROM mh WHERE name = 'Hank'").map((x) => ({ ...x }))[0] || null;

test("muse_register: the code and routing checked, the rooms named checked, and nothing asked of a room for any of it", async () => {
  const k = await museKeyed();
  try {
    const cases = [
      [{}, "\"code\" is required: the one-time link code your Muse gave you", undefined],
      [{ code: "  " }, "\"code\" is required: the one-time link code your Muse gave you", undefined],
      [{ code: "x".repeat(201) }, "\"code\" is longer than 200 characters", undefined],
      [{ code: k.code, routing: "sideways" }, "\"routing\" must be main, agent-chat, per-room or a side chat's id (a UUID)", undefined],
      [{ code: k.code, rooms: [] }, "\"rooms\" must list 1 to 30 rooms on your key by name, or be left out for every room on it", undefined],
      [{ code: k.code, rooms: "lima" }, "\"rooms\" must list 1 to 30 rooms on your key by name, or be left out for every room on it", undefined],
      [{ code: k.code, rooms: ["Not A Room"] }, "Room names are 1-64 lowercase letters, digits, - or _", undefined],
      [{ code: k.code, rooms: ["lima", "rome"] }, "rome is not on your key: list_rooms lists yours; add_room adds one.", { code: "room_not_held", room: "rome" }],
    ];
    for (const [args, text, structured] of cases) {
      const r = await mcp(k.w, call("muse_register", args), auth(k.key));
      assert.equal(result(r).isError, true, text);
      assert.equal(result(r).content[0].text, text);
      assert.deepEqual(result(r).structuredContent, structured);
      assert.ok(r.asked.every((n) => n.startsWith("__agent-")), "no room asked: " + r.asked);
    }
  } finally {
    k.b.restore();
  }
});

test("muse_register: a look per room first, so no code is spent when no room takes it; then one claim, the hook recorded on the key, then set; it joins nothing", async () => {
  const k = await museKeyed();
  try {
    // neither room joined yet: both skipped, the code not used
    let r = await mcp(k.w, call("muse_register", { code: k.code }), auth(k.key));
    assert.equal(result(r).isError, true);
    assert.equal(result(r).content[0].text, "No room on your key took its invite, so the code was not used.");
    assert.deepEqual(result(r).structuredContent, { code: "no_rooms", results: [
      { room: "lima", ok: false, status: 409, code: "not_joined", error: MUSE_NOT_JOINED },
      { room: "oslo", ok: false, status: 409, code: "not_joined", error: MUSE_NOT_JOINED },
    ] });
    assert.ok(!r.asked.some((n) => /museSetHook/.test(n)), "no hook asked for");
    // lima joined (a call that joins, through the key); oslo stays unopened
    await mcp(k.w, call("whoami", { room: "lima" }), auth(k.key));
    const before = { ...k.w.harness("lima").one("SELECT * FROM inv WHERE name = 'Hank'") };
    const oslo = { ...k.w.harness("oslo").one("SELECT * FROM inv WHERE name = 'Hank'") };
    const mark = k.w.asked.length;
    r = await mcp(k.w, call("muse_register", { code: k.code, routing: "main" }), auth(k.key));
    assert.ok(!result(r).isError, r.text.slice(0, 300));
    const got = result(r).structuredContent;
    assert.equal(got.claimed, true);
    assert.equal(got.results.length, 2);
    assert.deepEqual({ room: got.results[0].room, ok: got.results[0].ok, name: got.results[0].name, routing: got.results[0].hook.routing }, { room: "lima", ok: true, name: "Hank", routing: "main" });
    assert.deepEqual(got.results[1], { room: "oslo", ok: false, status: 409, code: "not_joined", error: MUSE_NOT_JOINED });
    assert.ok(!r.text.includes(k.link), "no link id in the answer");
    assert.deepEqual(hookIn(k.w, "lima"), { kind: "muse", link: k.link, routing: "main" });
    assert.equal(hookIn(k.w, "oslo"), null);
    // recorded on the key before it was set
    const seq = k.w.asked.slice(mark).map((a) => a.name + "." + a.method).filter((m) => /agentSwap|museSetHookLook/.test(m));
    assert.deepEqual(seq, [k.id + ".agentSwap", "lima.museSetHookLook"]);
    // nothing joined, nobody marked seen
    assert.deepEqual({ ...k.w.harness("lima").one("SELECT * FROM inv WHERE name = 'Hank'") }, before);
    assert.deepEqual({ ...k.w.harness("oslo").one("SELECT * FROM inv WHERE name = 'Hank'") }, oslo);
    assert.ok(!k.w.asked.slice(mark).some((a) => a.method === "access"), "access() never asked");
    // list_rooms and GET /api/agent say where a wake is, never the link
    const list = result(await mcp(k.w, call("list_rooms", {}), auth(k.key))).structuredContent.rooms;
    assert.deepEqual(list.map((x) => [x.room, x.muse_wake]), [["lima", true], ["oslo", undefined]]);
    const g = await read(agentRoute(k.w.rc("GET", "/api/agent", { headers: auth(k.key) })));
    assert.deepEqual(g.json.rooms.map((x) => Object.keys(x)), [["room", "name", "added", "state", "muse_wake"], ["room", "name", "added", "state"]]);
    assert.ok(!g.text.includes(k.link));
    // the bridge counts the room; the code was used once
    assert.equal(await k.b.rooms(k.link), 1);
    r = await mcp(k.w, call("muse_register", { code: k.code }), auth(k.key));
    assert.equal(result(r).structuredContent.code, "code_invalid");
  } finally {
    k.b.restore();
  }
});

test("muse_register replaces a webhook the agent had, and a refused room is marked on the key and not asked again", async () => {
  const k = await museKeyed(["lima", "oslo"]);
  try {
    for (const n of ["lima", "oslo"]) k.w.harness(n).room.access(k.tok[n], false);
    assert.equal(k.w.harness("lima").room.webhookSet(k.tok.lima, "https://hooks.example.org/x", "s", "lima").ok, true);
    k.w.harness("oslo").room.revoke(k.tok.oslo);
    let r = await mcp(k.w, call("muse_register", { code: k.code }), auth(k.key));
    const got = result(r).structuredContent;
    assert.deepEqual(got.results.map((x) => [x.room, x.ok, x.code]), [["lima", true, undefined], ["oslo", false, "invite_revoked"]]);
    assert.equal(hookIn(k.w, "lima").kind, "muse", "the webhook was replaced");
    const list = result(await mcp(k.w, call("list_rooms", {}), auth(k.key))).structuredContent.rooms;
    assert.equal(list.find((x) => x.room === "oslo").state, "refused");
    const g = await k.b.connect();
    const mark = k.w.asked.length;
    r = await mcp(k.w, call("muse_register", { code: g.code, rooms: ["oslo"] }), auth(k.key));
    assert.deepEqual(result(r).structuredContent.results, [{ room: "oslo", ok: false, status: 403, code: "invite_revoked", error: "This room has refused the invite on your key (invite_revoked): take it off with remove_room." }]);
    assert.ok(!k.w.asked.slice(mark).some((a) => a.name === "oslo"), "a room marked refused is not asked");
  } finally {
    k.b.restore();
  }
});

test("muse_register: a key disconnected between the set and the check removes what it set; a room taken off between them likewise", async () => {
  {
    const k = await museKeyed(["lima"]);
    try {
      k.w.harness("lima").room.access(k.tok.lima, false);
      const room = k.w.harness("lima").room;
      const real = room.museSetHookLook.bind(room);
      room.museSetHookLook = async (...a) => { const s = real(...a); await k.w.harness(k.id).room.ctx.storage.deleteAll(); return s; };
      const r = await mcp(k.w, call("muse_register", { code: k.code }), auth(k.key));
      assert.deepEqual(r.json.error, { code: -32001, message: AGENT_KEY_INVALID, data: { code: "agent_key_invalid" } });
      assert.equal(hookIn(k.w, "lima"), null, "the hook it set is gone");
      await k.w.harness("lima").settled();
      assert.equal(await k.b.rooms(k.link), 0, "and the bridge heard it");
    } finally {
      k.b.restore();
    }
  }
  {
    const k = await museKeyed(["lima", "oslo"]);
    try {
      for (const n of ["lima", "oslo"]) k.w.harness(n).room.access(k.tok[n], false);
      const room = k.w.harness("lima").room;
      const real = room.museSetHookLook.bind(room);
      room.museSetHookLook = async (...a) => {
        const s = real(...a);
        // the hook is set: now another call takes lima off the key, outside this call
        room.museDropLook = () => ({ ok: true, removed: false });
        await read(agentRemoveRoute(k.w.rc("POST", "/api/agent/rooms/remove", { json: { room: "lima" }, headers: auth(k.key) })));
        delete room.museDropLook;
        return s;
      };
      const r = await mcp(k.w, call("muse_register", { code: k.code }), auth(k.key));
      const got = result(r).structuredContent;
      assert.deepEqual(got.results.map((x) => [x.room, x.ok, x.code]), [["lima", false, "room_not_held"], ["oslo", true, undefined]]);
      assert.equal(hookIn(k.w, "lima"), null, "the hook set in a room that left the key is turned off");
      assert.equal(hookIn(k.w, "oslo").link, k.link);
    } finally {
      k.b.restore();
    }
  }
});

test("DELETE /api/agent turns off the wakes the key set up, after the cut, from the list as it was then; a hook the agent set itself on another link stays", async () => {
  const k = await museKeyed(["lima", "oslo", "rome"]);
  try {
    for (const n of ["lima", "oslo", "rome"]) k.w.harness(n).room.access(k.tok[n], false);
    await mcp(k.w, call("muse_register", { code: k.code, rooms: ["lima", "oslo"] }), auth(k.key));
    // rome: the agent's own hook, with its room token, on another link
    const own = await k.b.connect();
    assert.equal(k.w.harness("rome").room.museSetHook(k.tok.rome, own.link, "main", "rome").ok, true);
    const mark = k.w.asked.length;
    const d = await read(agentRoute(k.w.rc("DELETE", "/api/agent", { headers: auth(k.key) })));
    assert.equal(d.status, 200);
    assert.deepEqual(d.json, { deleted: true, rooms: ["lima", "oslo", "rome"], muse_wakes_removed: ["lima", "oslo"], muse_wakes_left: [], note: "This key works nowhere now, and the Muse wakes it set up are off. Every seat stays: you are still a member of these rooms, and any room token you kept still works. Links the key already handed out, for an upload or a file, run until they expire." });
    const seq = k.w.asked.slice(mark).map((a) => a.name + "." + a.method);
    assert.ok(seq.indexOf(k.id + ".agentDrop") < seq.indexOf("lima.museDropLook"), "the cut first: " + seq.join(" "));
    assert.ok(!seq.includes("rome.museDropLook"), "no wake of the key's in rome: not asked");
    assert.equal(hookIn(k.w, "lima"), null);
    assert.equal(hookIn(k.w, "oslo"), null);
    assert.equal(hookIn(k.w, "rome").link, own.link, "the agent's own hook stays");
    for (const n of ["lima", "oslo"]) await k.w.harness(n).settled();
    assert.equal(await k.b.rooms(k.link), 0);
  } finally {
    k.b.restore();
  }
});

test("DELETE /api/agent names a room added between its open and its drop, asks a room that throws once more, and says which wakes are left", async () => {
  const k = await museKeyed(["lima", "oslo"]);
  try {
    for (const n of ["lima", "oslo"]) k.w.harness(n).room.access(k.tok[n], false);
    await mcp(k.w, call("muse_register", { code: k.code }), auth(k.key));
    // rome goes on the key just before the drop
    const tr = agentInvite(k.w.room("rome"), "Hank");
    const obj = k.w.harness(k.id).room;
    const realDrop = obj.agentDrop.bind(obj);
    obj.agentDrop = async (...a) => { await mcp(k.w, call("add_room", { room: "rome", token: tr }), auth(k.key)); return realDrop(...a); };
    // lima throws once, oslo every time
    let limaTries = 0;
    const lima = k.w.harness("lima").room, realLook = lima.museDropLook.bind(lima);
    lima.museDropLook = (...a) => { if (++limaTries === 1) throw new Error("RPC receiver does not implement the method"); return realLook(...a); };
    k.w.harness("oslo").room.museDropLook = () => { throw new Error("RPC receiver does not implement the method"); };
    const d = await read(agentRoute(k.w.rc("DELETE", "/api/agent", { headers: auth(k.key) })));
    assert.equal(d.status, 200);
    assert.deepEqual(d.json.rooms, ["lima", "oslo", "rome"], "rome, added between the open and the drop, is named");
    assert.deepEqual([d.json.muse_wakes_removed, d.json.muse_wakes_left], [["lima"], ["oslo"]]);
    assert.equal(limaTries, 2, "asked once more after a throw");
    assert.equal(d.json.note, "This key works nowhere now. Every seat stays: you are still a member of these rooms, and any room token you kept still works. Links the key already handed out, for an upload or a file, run until they expire. These rooms could not be reached to turn off the Muse wakes this key set up: oslo; in each, DELETE /api/rooms/ROOM/muse-hook with that room's own token turns it off, and Disconnect on the Muse gadget stops every wake at once.");
    assert.ok(!/the Muse wakes it set up are off/.test(d.json.note), "it does not say the wakes are off");
    assert.equal(hookIn(k.w, "oslo").link, k.link, "oslo's wake is still on");
    const again = await mcp(k.w, call("list_rooms", {}), auth(k.key));
    assert.equal(again.json.error.data.code, "agent_key_invalid", "the key is cut all the same");
  } finally {
    k.b.restore();
  }
});

test("DELETE /api/agent with a list that does not open still disconnects, and says the wakes could not be turned off", async () => {
  const k = await museKeyed(["lima"]);
  try {
    k.w.harness(k.id).db.prepare("UPDATE ak SET ring = 'not-a-sealed-list'").run();
    const d = await read(agentRoute(k.w.rc("DELETE", "/api/agent", { headers: auth(k.key) })));
    assert.equal(d.status, 200);
    assert.deepEqual(d.json, { deleted: true, rooms: [], muse_wakes_removed: [], muse_wakes_left: null, note: "This key works nowhere now. Every seat stays: you are still a member of these rooms, and any room token you kept still works. Links the key already handed out, for an upload or a file, run until they expire. This key's record could not be read, so the Muse wakes it set up could not be turned off: Disconnect on the Muse gadget stops every wake at once." });
    assert.equal(k.w.harness(k.id).db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table'").get().n, 0, "the identity is gone");
  } finally {
    k.b.restore();
  }
});

test("remove_room and POST /api/agent/rooms/remove turn the room's wake off first; a room with none answers as before; one that cannot be reached stays on the key, its wake on", async () => {
  const k = await museKeyed(["lima", "oslo", "rome"]);
  try {
    for (const n of ["lima", "oslo", "rome"]) k.w.harness(n).room.access(k.tok[n], false);
    await mcp(k.w, call("muse_register", { code: k.code, rooms: ["lima", "oslo"] }), auth(k.key));
    // MCP: lima's wake goes, then lima
    const mark = k.w.asked.length;
    let r = await mcp(k.w, call("remove_room", { room: "lima" }), auth(k.key));
    assert.deepEqual(result(r).structuredContent, { room: "lima", removed: true, muse_wake_removed: true, note: "Your seat stays: you are still a member of lima. To leave it for good, call leave_room through the key, or use the room's own address. The Muse wake this key set up in lima is off." });
    const seq = k.w.asked.slice(mark).map((a) => a.name + "." + a.method);
    assert.ok(seq.indexOf("lima.museDropLook") < seq.lastIndexOf(k.id + ".agentSwap"), "the wake first, then the list: " + seq.join(" "));
    assert.equal(hookIn(k.w, "lima"), null);
    // REST, a room with no wake: byte for byte as before
    const rest = await read(agentRemoveRoute(k.w.rc("POST", "/api/agent/rooms/remove", { json: { room: "rome" }, headers: auth(k.key) })));
    assert.equal(rest.text, JSON.stringify({ room: "rome", removed: true, note: "Your seat stays: you are still a member of rome. To leave it for good, call leave_room through the key, or use the room's own address." }));
    // oslo cannot be reached: it stays on the key, its wake on, try_again
    k.w.harness("oslo").room.museDropLook = () => { throw new Error("RPC receiver does not implement the method"); };
    const t = await read(agentRemoveRoute(k.w.rc("POST", "/api/agent/rooms/remove", { json: { room: "oslo" }, headers: auth(k.key) })));
    assert.equal(t.status, 503);
    assert.equal(t.headers.get("Retry-After"), "1");
    assert.deepEqual(t.json, { error: "oslo could not be reached to turn off the Muse wake this key set up there, so it is still on this key and its wake is still on. Try again shortly.", code: "try_again", room: "oslo" });
    r = await mcp(k.w, call("remove_room", { room: "oslo" }), auth(k.key));
    assert.equal(result(r).isError, true);
    assert.deepEqual(result(r).structuredContent, { code: "try_again", room: "oslo" });
    assert.equal(hookIn(k.w, "oslo").link, k.link);
    const list = result(await mcp(k.w, call("list_rooms", {}), auth(k.key))).structuredContent.rooms;
    assert.deepEqual(list.map((x) => [x.room, x.muse_wake]), [["oslo", true]]);
    // once it answers: off, and off the key
    delete k.w.harness("oslo").room.museDropLook;
    r = await mcp(k.w, call("remove_room", { room: "oslo" }), auth(k.key));
    assert.equal(result(r).structuredContent.muse_wake_removed, true);
    assert.equal(hookIn(k.w, "oslo"), null);
  } finally {
    k.b.restore();
  }
});
