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
import { agentCredential, agentUnseal, newAgentKey } from "../../worker/lib/agentkey.ts";

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
import { museNotJoined } from "../../worker/room/muse.ts";
import { dropNote, wakeNotSettled, wakeStillSetting } from "../../worker/agents/onboarding.ts";
import { AGENT_SWAP_TRIES, AGENT_WAKE_ITEMS_MAX, AGENT_WAKE_LINK_MAX, AGENT_WAKE_RETRY_MS, AGENT_WAKE_SET_MS, AGENT_WAKE_SKEW_MS } from "../../worker/limits.ts";

/** what a key's identity stores: its slot's kind and its list's entries, the
 *  sealed list opened as the Worker opens it; null once nothing is stored */
async function storedOf(w, key) {
  const c = agentCredential(new Request("http://localhost/", { headers: { Authorization: "Bearer " + key } }));
  const h = w.harness("__agent-" + c.id);
  if (!h.one("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table'").n) return null;
  const a = h.one("SELECT ver, ring FROM ak"), slot = h.one("SELECT kind, wrapped FROM aks WHERE slot = 'key'");
  const u = await agentUnseal(c.id, c.secret, slot.wrapped, a.ver, a.ring);
  return { kind: slot.kind, rooms: u.rooms };
}
/** the links a key records in each of its rooms */
async function hooksOf(w, key) {
  const s = await storedOf(w, key);
  return Object.fromEntries(s.rooms.map((e) => [e.room, e.hooks || []]));
}

/** rooms with the agent Hank on a key, the Muse bridge in the process, a gadget linked */
async function museKeyed(names = ["lima", "oslo"]) {
  const b = await bridgeWorld();
  // the Worker's and the rooms' env: the bridge's own stays as it is (TEST_HOOKS there would send Muse's calls elsewhere)
  const w = makeWorld({ env: b.env });
  const tok = {};
  for (const n of names) tok[n] = agentInvite(w.room(n), "Hank");
  const r = await read(agentCreateRoute(w.rc("POST", "/api/agents", { json: { rooms: names.map((room) => ({ room, token: tok[room] })) }, headers: { "CF-Connecting-IP": "10.2.0.9" } })));
  assert.equal(r.status, 201, r.text);
  const g = await b.connect();
  const key = r.json.key;
  return { b, w, tok, key, id: w.identities()[0], peek: () => hooksOf(w, key), ...g };
}
const result = (r) => r.json.result;
/** the links the key records in each room, by opening its sealed list as the Worker does */
const recorded = (k) => k.peek();
const hookIn = (w, room) => w.harness(room).all("SELECT kind, link, routing FROM mh WHERE name = 'Hank'").map((x) => ({ ...x }))[0] || null;
/** the links the key records in a room, in order; their outstanding recordings' deadlines, all links together */
const links = (list, room) => (list[room] || []).map((h) => h.link);
const deadlines = (list, room) => (list[room] || []).flatMap((h) => h.recs.map((r) => r.deadline));
const outstanding = (list, room) => (list[room] || []).map((h) => [h.link, h.recs.length]);
/** a room's own clock, as its three hook methods read it (museNow): at a fixed time, or the real one moved by ms */
const clockAt = (w, room, t) => { w.harness(room).room.museNow = () => t; };
const clockBy = (w, room, ms) => { w.harness(room).room.museNow = () => Date.now() + ms; };
/** each room's clock past every deadline a registration so far gave, so each link can settle */
const pastDeadlines = (w, ...rooms) => { for (const r of rooms) clockBy(w, r, AGENT_WAKE_SET_MS + AGENT_WAKE_SKEW_MS + 1000); };
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
/** a registration whose Worker stops right after the room's ok, before its final write: its link stays
 *  recorded and pending (not answered), its hook on */
async function stoppedAfterSet(k, code, args = {}) {
  const obj = k.w.harness(k.id).room, real = obj.agentSwap.bind(obj);
  let swaps = 0;
  obj.agentSwap = (...a) => { if (++swaps === 2) throw new Error("the Worker stopped"); return real(...a); };
  try {
    await assert.rejects(mcp(k.w, call("muse_register", { code, ...args }), auth(k.key)), /the Worker stopped/);
  } finally {
    delete obj.agentSwap;
  }
}
/** waits (a few ms at a time) until cond holds */
async function until(cond) {
  for (let i = 0; i < 400 && !cond(); i++) await sleepMs(5);
  assert.ok(cond(), "waited for it");
}

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
      { room: "lima", ok: false, status: 409, code: "not_joined", error: museNotJoined(false) },
      { room: "oslo", ok: false, status: 409, code: "not_joined", error: museNotJoined(false) },
    ] });
    assert.ok(!r.asked.some((n) => /museSetHook/.test(n)), "no hook asked for");
    // lima joined (a call that joins, through the key); oslo stays unopened
    await mcp(k.w, call("whoami", { room: "lima" }), auth(k.key));
    const before = { ...k.w.harness("lima").one("SELECT * FROM inv WHERE name = 'Hank'") };
    const oslo = { ...k.w.harness("oslo").one("SELECT * FROM inv WHERE name = 'Hank'") };
    const mark = k.w.asked.length, t0 = Date.now();
    r = await mcp(k.w, call("muse_register", { code: k.code, routing: "main" }), auth(k.key));
    assert.ok(!result(r).isError, r.text.slice(0, 300));
    const got = result(r).structuredContent;
    assert.equal(got.claimed, true);
    assert.equal(got.results.length, 2);
    assert.deepEqual({ room: got.results[0].room, ok: got.results[0].ok, name: got.results[0].name, routing: got.results[0].hook.routing }, { room: "lima", ok: true, name: "Hank", routing: "main" });
    assert.deepEqual(got.results[1], { room: "oslo", ok: false, status: 409, code: "not_joined", error: museNotJoined(true) });
    assert.ok(!r.text.includes(k.link), "no link id in the answer");
    assert.deepEqual(hookIn(k.w, "lima"), { kind: "muse", link: k.link, routing: "main" });
    assert.equal(hookIn(k.w, "oslo"), null);
    // recorded on the key before it was set, with its deadline, which the set carries; then the room's answer written
    const seq = k.w.asked.slice(mark).map((a) => a.name + "." + a.method).filter((m) => /agentSwap|museSetHookLook/.test(m));
    assert.deepEqual(seq, [k.id + ".agentSwap", "lima.museSetHookLook", k.id + ".agentSwap"]);
    const rec = (await recorded(k)).lima;
    assert.deepEqual(rec, [{ link: k.link, recs: [] }], "lima records the link, its recording gone with the room's answer");
    const sent = k.w.asked.slice(mark).find((a) => a.method === "museSetHookLook").args[4];
    assert.ok(sent >= t0 + AGENT_WAKE_SET_MS && sent <= Date.now() + AGENT_WAKE_SET_MS, "the set carries its recording's deadline: AGENT_WAKE_SET_MS after the record");
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

/** the key's verifier, as the Worker works it out, for asking its identity directly */
async function verifierOf(key) {
  const c = agentCredential(new Request("http://localhost/", { headers: { Authorization: "Bearer " + key } }));
  return agentVerifier(c.id, c.secret);
}

test("muse_register: a key cut between the set and the final write turns off what it set; so does one whose identity is gone", async () => {
  for (const how of ["cut", "gone"]) {
    const k = await museKeyed(["lima"]);
    try {
      k.w.harness("lima").room.access(k.tok.lima, false);
      const room = k.w.harness("lima").room, real = room.museSetHookLook.bind(room);
      const obj = k.w.harness(k.id).room, verifier = await verifierOf(k.key);
      room.museSetHookLook = async (...a) => {
        const s = real(...a);
        if (how === "cut") assert.equal(obj.agentCut("key", verifier).ok, true);
        else await obj.ctx.storage.deleteAll();
        return s;
      };
      const r = await mcp(k.w, call("muse_register", { code: k.code }), auth(k.key));
      assert.deepEqual(r.json.error, { code: -32001, message: AGENT_KEY_INVALID, data: { code: "agent_key_invalid" } }, how);
      assert.equal(hookIn(k.w, "lima"), null, how + ": the hook it set is gone");
      await k.w.harness("lima").settled();
      assert.equal(await k.b.rooms(k.link), 0, "and the bridge heard it");
    } finally {
      k.b.restore();
    }
  }
});

test("muse_register: a take-off while the set may still reach the room is try_again and turns nothing off; a set that reaches the room after its deadline sets nothing, and its own link settles on that refusal", async () => {
  {
    // the take-off asks the room's clock first: the deadline still to come, nothing is dropped
    const k = await museKeyed(["lima", "oslo"]);
    try {
      for (const n of ["lima", "oslo"]) k.w.harness(n).room.access(k.tok[n], false);
      const room = k.w.harness("lima").room, real = room.museSetHookLook.bind(room);
      let off, offAsked;
      room.museSetHookLook = async (...a) => {
        clockAt(k.w, "lima", a[4] - 4500);
        const mark = k.w.asked.length;
        off = await read(agentRemoveRoute(k.w.rc("POST", "/api/agent/rooms/remove", { json: { room: "lima" }, headers: auth(k.key) })));
        offAsked = k.w.methods("lima", mark);
        return real(...a);
      };
      const r = await mcp(k.w, call("muse_register", { code: k.code }), auth(k.key));
      assert.equal(off.status, 503);
      const sec = Math.ceil((4500 + AGENT_WAKE_SKEW_MS + 1) / 1000);
      assert.deepEqual(off.json, { error: wakeStillSetting("lima", sec), code: "try_again", room: "lima" });
      assert.equal(off.headers.get("Retry-After"), String(sec));
      assert.deepEqual(offAsked, ["museHookLook"], "a look at the room's clock, and nothing dropped");
      const got = result(r).structuredContent;
      assert.deepEqual(got.results.map((x) => [x.room, x.ok, x.code]), [["lima", true, undefined], ["oslo", true, undefined]], "a room on the key never answers room_not_held");
      assert.equal(hookIn(k.w, "lima").link, k.link);
      delete room.museSetHookLook;
      pastDeadlines(k.w, "lima");
      const t = await read(agentRemoveRoute(k.w.rc("POST", "/api/agent/rooms/remove", { json: { room: "lima" }, headers: auth(k.key) })));
      assert.equal(t.json.muse_wake_removed, true, "once its deadline has passed by the room's clock, the take-off turns it off");
      assert.equal(hookIn(k.w, "lima"), null);
    } finally {
      k.b.restore();
    }
  }
  for (const between of ["nothing", "a take-off"]) {
    // the set reaches the room one millisecond after its deadline by the room's clock
    const k = await museKeyed(["lima", "oslo"]);
    try {
      for (const n of ["lima", "oslo"]) k.w.harness(n).room.access(k.tok[n], false);
      const room = k.w.harness("lima").room, real = room.museSetHookLook.bind(room);
      let t;
      room.museSetHookLook = async (...a) => {
        // late: after its deadline; for the take-off, past it by the skew margin too, so its recording has expired
        clockAt(k.w, "lima", a[4] + (between === "a take-off" ? AGENT_WAKE_SKEW_MS + 1 : 1));
        if (between === "a take-off") t = await read(agentRemoveRoute(k.w.rc("POST", "/api/agent/rooms/remove", { json: { room: "lima" }, headers: auth(k.key) })));
        return real(...a);
      };
      const r = await mcp(k.w, call("muse_register", { code: k.code }), auth(k.key));
      const got = result(r).structuredContent.results;
      if (between === "nothing") {
        assert.deepEqual(got[0], { room: "lima", ok: false, status: 503, code: "try_again", error: wakeAgain("lima", "late", true) });
        assert.deepEqual(links(await k.peek(), "lima"), [], "its own write took its recording off, and the tidy's look the link");
      } else {
        assert.deepEqual(t.json, { room: "lima", removed: true, muse_wake_removed: true, note: removedHeldNote("lima", true) }, "past its deadline by the room's clock: the take-off settles it");
        assert.deepEqual(got[0], { room: "lima", ok: false, status: 404, code: "room_not_held", error: "lima is no longer on your key." });
      }
      assert.equal(hookIn(k.w, "lima"), null, between + ": the late set set nothing");
      assert.deepEqual([got[1].room, got[1].ok], ["oslo", true]);
      assert.equal(hookIn(k.w, "oslo").link, k.link);
    } finally {
      k.b.restore();
    }
  }
});

test("DELETE /api/agent turns off the wakes the key set up, after the cut, from the list as it was then; a hook the agent set itself on another link stays; once all settled nothing is stored", async () => {
  const k = await museKeyed(["lima", "oslo", "rome"]);
  try {
    for (const n of ["lima", "oslo", "rome"]) k.w.harness(n).room.access(k.tok[n], false);
    await mcp(k.w, call("muse_register", { code: k.code, rooms: ["lima", "oslo"] }), auth(k.key));
    pastDeadlines(k.w, "lima", "oslo");
    // rome: the agent's own hook, with its room token, on another link
    const own = await k.b.connect();
    assert.equal(k.w.harness("rome").room.museSetHook(k.tok.rome, own.link, "main", "rome").ok, true);
    const mark = k.w.asked.length;
    const d = await read(agentRoute(k.w.rc("DELETE", "/api/agent", { headers: auth(k.key) })));
    assert.equal(d.status, 200);
    assert.deepEqual(d.json, { deleted: true, rooms: ["lima", "oslo", "rome"], muse_wakes_removed: ["lima", "oslo"], muse_wakes_left: [], note: dropNote([]) });
    const seq = k.w.asked.slice(mark).map((a) => a.name + "." + a.method);
    assert.equal(seq[0], k.id + ".agentCut", "the cut first: " + seq.join(" "));
    assert.ok(seq.indexOf("lima.museDropLook") > 0 && seq.indexOf("oslo.museDropLook") > 0);
    assert.equal(seq[seq.length - 1], k.id + ".agentDrop", "the record deleted last");
    assert.ok(!seq.includes("rome.museDropLook"), "no wake of the key's in rome: not asked");
    assert.equal(hookIn(k.w, "lima"), null);
    assert.equal(hookIn(k.w, "oslo"), null);
    assert.equal(hookIn(k.w, "rome").link, own.link, "the agent's own hook stays");
    assert.equal(await storedOf(k.w, k.key), null, "nothing stored");
    for (const n of ["lima", "oslo"]) await k.w.harness(n).settled();
    assert.equal(await k.b.rooms(k.link), 0);
  } finally {
    k.b.restore();
  }
});

test("DELETE /api/agent: a room added just before the cut is named; a room that throws is asked once more; one that will not answer stays on the cut record alone, and a second DELETE turns it off and deletes the record", async () => {
  const k = await museKeyed(["lima", "oslo"]);
  try {
    for (const n of ["lima", "oslo"]) k.w.harness(n).room.access(k.tok[n], false);
    await mcp(k.w, call("muse_register", { code: k.code }), auth(k.key));
    pastDeadlines(k.w, "lima", "oslo");
    const before = await storedOf(k.w, k.key);
    // rome goes on the key just before the cut
    const tr = agentInvite(k.w.room("rome"), "Hank");
    const obj = k.w.harness(k.id).room;
    const realCut = obj.agentCut.bind(obj);
    obj.agentCut = async (...a) => { await mcp(k.w, call("add_room", { room: "rome", token: tr }), auth(k.key)); delete obj.agentCut; return realCut(...a); };
    // lima throws once, oslo every time
    let limaTries = 0;
    const lima = k.w.harness("lima").room, realLook = lima.museDropLook.bind(lima);
    lima.museDropLook = (...a) => { if (++limaTries === 1) throw new Error("RPC receiver does not implement the method"); return realLook(...a); };
    k.w.harness("oslo").room.museDropLook = () => { throw new Error("RPC receiver does not implement the method"); };
    const d = await read(agentRoute(k.w.rc("DELETE", "/api/agent", { headers: auth(k.key) })));
    assert.equal(d.status, 200);
    assert.deepEqual(d.json, { deleted: true, rooms: ["lima", "oslo", "rome"], muse_wakes_removed: ["lima"], muse_wakes_left: ["oslo"], note: dropNote(["oslo"]) }, "rome, added before the cut, is named");
    assert.equal(limaTries, 2, "asked once more after a throw");
    assert.ok(!/the Muse wakes it set up are off/.test(d.json.note), "it does not say the wakes are off");
    assert.equal(hookIn(k.w, "oslo").link, k.link, "oslo's wake is still on");
    // what is stored: the cut slot, and only oslo's entry, as it was
    const left = await storedOf(k.w, k.key);
    assert.equal(left.kind, "cut");
    assert.deepEqual(left.rooms, before.rooms.filter((e) => e.room === "oslo"), "only the entry whose wake did not settle, its link with it");
    const again = await mcp(k.w, call("list_rooms", {}), auth(k.key));
    assert.equal(again.json.error.data.code, "agent_key_invalid", "the key is cut all the same");
    // oslo answers again: the second DELETE turns it off and deletes the record
    delete k.w.harness("oslo").room.museDropLook;
    const d2 = await read(agentRoute(k.w.rc("DELETE", "/api/agent", { headers: auth(k.key) })));
    assert.equal(d2.status, 200);
    assert.deepEqual(d2.json, { deleted: true, rooms: ["oslo"], muse_wakes_removed: ["oslo"], muse_wakes_left: [], note: dropNote([]) });
    assert.equal(hookIn(k.w, "oslo"), null);
    assert.equal(await storedOf(k.w, k.key), null, "nothing stored");
    // a third: as a key that does not exist
    const d3 = await read(agentRoute(k.w.rc("DELETE", "/api/agent", { headers: auth(k.key) })));
    const unknown = await read(agentRoute(k.w.rc("DELETE", "/api/agent", { headers: auth(newAgentKey().key) })));
    assert.deepEqual([d3.status, d3.text], [unknown.status, unknown.text]);
  } finally {
    k.b.restore();
  }
});

test("a Worker that stops right after the cut, or between two rooms' drops: the key stays cut, its list as it was; a second DELETE turns the remaining wakes off and deletes the record", async () => {
  {
    const k = await museKeyed(["lima", "oslo"]);
    try {
      for (const n of ["lima", "oslo"]) k.w.harness(n).room.access(k.tok[n], false);
      await mcp(k.w, call("muse_register", { code: k.code }), auth(k.key));
      pastDeadlines(k.w, "lima", "oslo");
      const before = await storedOf(k.w, k.key);
      const obj = k.w.harness(k.id).room, realCut = obj.agentCut.bind(obj);
      obj.agentCut = (...a) => { realCut(...a); throw new Error("the Worker stopped"); };
      await assert.rejects(read(agentRoute(k.w.rc("DELETE", "/api/agent", { headers: auth(k.key) }))), /the Worker stopped/);
      delete obj.agentCut;
      const cut = await storedOf(k.w, k.key);
      assert.deepEqual([cut.kind, cut.rooms], ["cut", before.rooms], "cut, its list as it was");
      assert.equal(hookIn(k.w, "lima").link, k.link);
      const g = await read(agentRoute(k.w.rc("GET", "/api/agent", { headers: auth(k.key) })));
      assert.equal(g.json.code, "agent_key_invalid", "the key opens nothing");
      const d = await read(agentRoute(k.w.rc("DELETE", "/api/agent", { headers: auth(k.key) })));
      assert.deepEqual(d.json, { deleted: true, rooms: ["lima", "oslo"], muse_wakes_removed: ["lima", "oslo"], muse_wakes_left: [], note: dropNote([]) });
      assert.deepEqual([hookIn(k.w, "lima"), hookIn(k.w, "oslo")], [null, null]);
      assert.equal(await storedOf(k.w, k.key), null);
    } finally {
      k.b.restore();
    }
  }
  {
    const k = await museKeyed(["lima", "oslo"]);
    try {
      for (const n of ["lima", "oslo"]) k.w.harness(n).room.access(k.tok[n], false);
      await mcp(k.w, call("muse_register", { code: k.code }), auth(k.key));
      pastDeadlines(k.w, "lima", "oslo");
      const before = await storedOf(k.w, k.key);
      // oslo's drop never answers: the Worker stops there, lima's drop done
      const oslo = k.w.harness("oslo").room;
      oslo.museDropLook = () => new Promise(() => {});
      const first = read(agentRoute(k.w.rc("DELETE", "/api/agent", { headers: auth(k.key) })));
      let answered = false;
      first.then(() => { answered = true; }, () => { answered = true; });
      await until(() => k.w.methods("oslo").includes("museDropLook") && k.w.methods("lima").includes("museDropLook"));
      await sleepMs(20);
      assert.equal(answered, false);
      assert.equal(hookIn(k.w, "lima"), null, "lima's wake is off");
      const cut = await storedOf(k.w, k.key);
      assert.deepEqual([cut.kind, cut.rooms], ["cut", before.rooms], "the record as it was: nothing written yet");
      delete oslo.museDropLook;
      const d = await read(agentRoute(k.w.rc("DELETE", "/api/agent", { headers: auth(k.key) })));
      assert.deepEqual(d.json, { deleted: true, rooms: ["lima", "oslo"], muse_wakes_removed: ["oslo"], muse_wakes_left: [], note: dropNote([]) }, "lima's had gone already");
      assert.equal(hookIn(k.w, "oslo"), null);
      assert.equal(await storedOf(k.w, k.key), null);
    } finally {
      k.b.restore();
    }
  }
});

test("a cut key is refused by every route and tool but its own DELETE exactly as a key that does not exist", async () => {
  const k = await museKeyed(["lima", "oslo"]);
  try {
    for (const n of ["lima", "oslo"]) k.w.harness(n).room.access(k.tok[n], false);
    await mcp(k.w, call("muse_register", { code: k.code }), auth(k.key));
    pastDeadlines(k.w, "lima", "oslo");
    k.w.harness("oslo").room.museDropLook = () => { throw new Error("RPC receiver does not implement the method"); };
    const d = await read(agentRoute(k.w.rc("DELETE", "/api/agent", { headers: auth(k.key) })));
    assert.deepEqual(d.json.muse_wakes_left, ["oslo"]);
    assert.equal((await storedOf(k.w, k.key)).kind, "cut");
    const pat = agentInvite(k.w.harness("lima"), "Pat", "human");
    const other = agentInvite(k.w.harness("lima"), "Other");
    const unknown = newAgentKey().key;
    const routes = [
      ["GET /api/agent", (key) => agentRoute(k.w.rc("GET", "/api/agent", { headers: auth(key) }))],
      ["HEAD /api/agent", (key) => agentRoute(k.w.rc("HEAD", "/api/agent", { headers: auth(key) }))],
      ["POST /api/agent/rooms", (key) => agentRoomsRoute(k.w.rc("POST", "/api/agent/rooms", { json: { rooms: [{ room: "lima", token: other }] }, headers: auth(key) }))],
      ["POST /api/agent/rooms/remove", (key) => agentRemoveRoute(k.w.rc("POST", "/api/agent/rooms/remove", { json: { room: "lima" }, headers: auth(key) }))],
      ["POST /api/agent/rooms/invite", (key) => agentInviteAddRoute(k.w.rc("POST", "/api/agent/rooms/invite", { json: { name: "Scout", rooms: [{ room: "lima", inviter_token: pat }] }, headers: auth(key) }))],
      ["POST /api/agent/rooms/invite (check)", (key) => agentInviteAddRoute(k.w.rc("POST", "/api/agent/rooms/invite", { json: { name: "Scout", rooms: [{ room: "lima", inviter_token: pat }], check: true }, headers: auth(key) }))],
      ["initialize", (key) => agentMcpRoute(k.w.rc("POST", "/api/mcp", { json: { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }, headers: auth(key) }))],
      ["server/discover", (key) => agentMcpRoute(k.w.rc("POST", "/api/mcp", { json: req("server/discover"), headers: { ...auth(key), ...heads("server/discover") } }))],
      ["tools/list", (key) => agentMcpRoute(k.w.rc("POST", "/api/mcp", { json: { jsonrpc: "2.0", id: 1, method: "tools/list" }, headers: auth(key) }))],
      ...[["list_rooms", {}], ["whats_waiting", {}], ["add_room", { room: "rome", token: other }], ["remove_room", { room: "lima" }], ["muse_register", { code: "AAAAA-BBBBB" }], ["whoami", { room: "lima" }], ["leave_room", { room: "lima" }], ["read_messages", { room: "lima" }]]
        .map(([name, args]) => [name, (key) => agentMcpRoute(k.w.rc("POST", "/api/mcp", { json: call(name, args), headers: auth(key) }))]),
    ];
    for (const [what, go] of routes) {
      const a = await read(go(k.key)), b = await read(go(unknown));
      assert.deepEqual([a.status, a.text, [...a.headers]], [b.status, b.text, [...b.headers]], what);
    }
    assert.equal(hookIn(k.w, "lima"), null);
    assert.equal(hookIn(k.w, "oslo").link, k.link, "the refusals changed nothing in any room");
    assert.equal(k.w.harness("lima").all("SELECT name FROM inv WHERE name = 'Scout'").length, 0, "no invite made");
  } finally {
    k.b.restore();
  }
});

test("remove_room and POST /api/agent/rooms/remove turn the room's wake off first; a room with none answers as before; one that cannot be reached stays on the key, its wake on", async () => {
  const k = await museKeyed(["lima", "oslo", "rome"]);
  try {
    for (const n of ["lima", "oslo", "rome"]) k.w.harness(n).room.access(k.tok[n], false);
    await mcp(k.w, call("muse_register", { code: k.code, rooms: ["lima", "oslo"] }), auth(k.key));
    pastDeadlines(k.w, "lima", "oslo");
    // MCP: lima's wake goes, then lima
    const mark = k.w.asked.length;
    let r = await mcp(k.w, call("remove_room", { room: "lima" }), auth(k.key));
    assert.deepEqual(result(r).structuredContent, { room: "lima", removed: true, muse_wake_removed: true, note: removedHeldNote("lima", true) });
    const seq = k.w.asked.slice(mark).map((a) => a.name + "." + a.method);
    assert.ok(seq.indexOf("lima.museHookLook") < seq.indexOf("lima.museDropLook") && seq.indexOf("lima.museDropLook") < seq.lastIndexOf(k.id + ".agentSwap"), "the room's clock, the wake, then the list: " + seq.join(" "));
    assert.equal(hookIn(k.w, "lima"), null);
    // REST, a room with no wake: byte for byte as before
    const rest = await read(agentRemoveRoute(k.w.rc("POST", "/api/agent/rooms/remove", { json: { room: "rome" }, headers: auth(k.key) })));
    assert.equal(rest.text, JSON.stringify({ room: "rome", removed: true, note: removedHeldNote("rome", false) }));
    // oslo cannot be reached: it stays on the key, its wake on, try_again (its link is answered: no clock asked first)
    for (const m of ["museDropLook"]) {
      k.w.harness("oslo").room[m] = () => { throw new Error("RPC receiver does not implement the method"); };
      const t = await read(agentRemoveRoute(k.w.rc("POST", "/api/agent/rooms/remove", { json: { room: "oslo" }, headers: auth(k.key) })));
      assert.equal(t.status, 503, m);
      assert.equal(t.headers.get("Retry-After"), "1");
      assert.deepEqual(t.json, { error: wakeNotSettled("oslo"), code: "try_again", room: "oslo" });
      r = await mcp(k.w, call("remove_room", { room: "oslo" }), auth(k.key));
      assert.equal(result(r).isError, true);
      assert.deepEqual(result(r).structuredContent, { code: "try_again", room: "oslo" });
      assert.equal(hookIn(k.w, "oslo").link, k.link, m + ": its wake on");
      delete k.w.harness("oslo").room[m];
    }
    const list = result(await mcp(k.w, call("list_rooms", {}), auth(k.key))).structuredContent.rooms;
    assert.deepEqual(list.map((x) => [x.room, x.muse_wake]), [["oslo", true]]);
    // once it answers: off, and off the key
    r = await mcp(k.w, call("remove_room", { room: "oslo" }), auth(k.key));
    assert.equal(result(r).structuredContent.muse_wake_removed, true);
    assert.equal(hookIn(k.w, "oslo"), null);
  } finally {
    k.b.restore();
  }
});

// ---- the record of the wakes a key set up (worker/lib/wakes.ts): a recording before each set, its own call's write after it, and a link off only in a settling write ----
import { waitedBeforeWrite } from "./agent-world.mjs";
import { wakeAgain, wakeLinkUnusable, wakeLost, removedHeldNote, removedRefusedNote } from "../../worker/agents/onboarding.ts";
import { agentVerifier } from "../../worker/lib/agentkey.ts";
import { agentInviteAddRoute, agentRoomsRoute } from "../../worker/routes/agent.ts";

const SKEW = AGENT_WAKE_SKEW_MS;

/** a set that waits at the room until released: gates[i](mode) runs it ("take": the room's own set; "refuse":
 *  refused too late, nothing set); hold[i] = true keeps its answer from its call until deliver[i]() */
function gatedSets(room) {
  const real = room.museSetHookLook.bind(room);
  const g = { gates: [], carried: [], hold: [], deliver: [] };
  room.museSetHookLook = async (...a) => {
    const i = g.carried.length;
    g.carried.push(a);
    const mode = await new Promise((r) => { g.gates[i] = r; });
    const answer = mode === "refuse" ? { ok: false, status: 409, code: "too_late", error: "This registration reached the room after its time, so nothing was set.", now: room.museNow() } : real(...a);
    if (g.hold[i]) await new Promise((r) => { g.deliver[i] = r; });
    return answer;
  };
  g.restore = () => { delete room.museSetHookLook; };
  return g;
}
/** the identity's next own write throws, as a Worker that stops before it */
function stopNextSwap(k) {
  const obj = k.w.harness(k.id).room, real = obj.agentSwap.bind(obj);
  obj.agentSwap = () => { obj.agentSwap = real; throw new Error("the Worker stopped"); };
}

test("after a finished registration nothing is outstanding: a take-off and a DELETE settle at once, a look and a drop each, no wait and no try_again", async () => {
  const k = await museKeyed(["lima", "oslo", "rome"]);
  try {
    for (const n of ["lima", "oslo", "rome"]) k.w.harness(n).room.access(k.tok[n], false);
    await mcp(k.w, call("muse_register", { code: k.code }), auth(k.key));
    for (const r of ["lima", "oslo", "rome"]) assert.deepEqual(outstanding(await k.peek(), r), [[k.link, 0]], r + ": its link, nothing outstanding");
    let mark = k.w.asked.length, t0 = Date.now();
    const t = await read(agentRemoveRoute(k.w.rc("POST", "/api/agent/rooms/remove", { json: { room: "lima" }, headers: auth(k.key) })));
    assert.equal(t.status, 200, t.text);
    assert.equal(t.json.muse_wake_removed, true);
    assert.ok(Date.now() - t0 < AGENT_WAKE_RETRY_MS, "no wait");
    assert.deepEqual(k.w.methods("lima", mark), ["museHookLook", "museDropLook"], "a look, then the drop");
    assert.equal(hookIn(k.w, "lima"), null);
    mark = k.w.asked.length; t0 = Date.now();
    const d = await read(agentRoute(k.w.rc("DELETE", "/api/agent", { headers: auth(k.key) })));
    assert.deepEqual(d.json, { deleted: true, rooms: ["oslo", "rome"], muse_wakes_removed: ["oslo", "rome"], muse_wakes_left: [], note: dropNote([]) });
    assert.ok(Date.now() - t0 < AGENT_WAKE_RETRY_MS, "no wait");
    assert.deepEqual([k.w.methods("oslo", mark), k.w.methods("rome", mark)], [["museHookLook", "museDropLook"], ["museHookLook", "museDropLook"]]);
    assert.deepEqual([hookIn(k.w, "oslo"), hookIn(k.w, "rome")], [null, null]);
  } finally {
    k.b.restore();
  }
});

test("a recording leaves only by its own call's write: answered (ok or refused) it goes, its link stays; a set that throws is not sent again and leaves it outstanding; a Worker that stops before its write leaves it too", async () => {
  const k = await museKeyed(["lima", "oslo"]);
  try {
    for (const n of ["lima", "oslo"]) k.w.harness(n).room.access(k.tok[n], false);
    // lima's set throws, once: not sent again; oslo's is answered, but the Worker stops before its write
    let sent = 0;
    k.w.harness("lima").room.museSetHookLook = () => { sent++; throw new Error("Network connection lost."); };
    await stoppedAfterSet(k, k.code);
    delete k.w.harness("lima").room.museSetHookLook;
    assert.equal(sent, 1, "a set that throws is not sent again");
    let list = await k.peek();
    assert.deepEqual([outstanding(list, "lima"), outstanding(list, "oslo")], [[[k.link, 1]], [[k.link, 1]]], "both outstanding");
    assert.equal(hookIn(k.w, "oslo").link, k.link);
    // a second gadget in oslo, finished: its own recording goes; the first link stays (its recording may still land)
    const g2 = await k.b.connect();
    assert.equal(result(await mcp(k.w, call("muse_register", { code: g2.code, rooms: ["oslo"] }), auth(k.key))).structuredContent.results[0].ok, true);
    list = await k.peek();
    assert.deepEqual(outstanding(list, "oslo"), [[k.link, 1], [g2.link, 0]]);
    // a third whose set the room refuses: its recording goes; the link it never set leaves at the tidy
    const g3 = await k.b.connect();
    const oslo = k.w.harness("oslo").room;
    oslo.museSetHookLook = () => ({ ok: false, status: 403, code: "invite_revoked", error: "This invite link has been revoked. Ask whoever gave it to you for a new one.", now: oslo.museNow() });
    const r3 = await mcp(k.w, call("muse_register", { code: g3.code, rooms: ["oslo"] }), auth(k.key));
    delete oslo.museSetHookLook;
    assert.equal(result(r3).structuredContent.results[0].code, "invite_revoked");
    assert.deepEqual(outstanding(await k.peek(), "oslo"), [[k.link, 1], [g2.link, 0]], "the refused one's link is gone after the tidy; the others as they were");
  } finally {
    k.b.restore();
  }
});

test("with a recording outstanding and unexpired, a take-off answers try_again and drops nothing; at deadline + AGENT_WAKE_SKEW_MS exactly by the room's clock still; one millisecond later it settles", async () => {
  const k = await museKeyed(["lima"]);
  try {
    k.w.harness("lima").room.access(k.tok.lima, false);
    await stoppedAfterSet(k, k.code);
    assert.equal(hookIn(k.w, "lima").link, k.link, "its hook is on");
    const [d] = deadlines(await k.peek(), "lima");
    for (const [at, sec] of [[Date.now(), null], [d + SKEW, 1]]) {
      if (sec !== null) clockAt(k.w, "lima", at);
      const mark = k.w.asked.length;
      const t = await read(agentRemoveRoute(k.w.rc("POST", "/api/agent/rooms/remove", { json: { room: "lima" }, headers: auth(k.key) })));
      assert.deepEqual([t.status, t.json.code], [503, "try_again"], t.text);
      if (sec !== null) assert.deepEqual(t.json, { error: wakeStillSetting("lima", sec), code: "try_again", room: "lima" });
      assert.deepEqual(k.w.methods("lima", mark), ["museHookLook"], "a look, and nothing dropped");
      assert.equal(hookIn(k.w, "lima").link, k.link, "the hook still on");
    }
    clockAt(k.w, "lima", d + SKEW + 1);
    const t2 = await read(agentRemoveRoute(k.w.rc("POST", "/api/agent/rooms/remove", { json: { room: "lima" }, headers: auth(k.key) })));
    assert.equal(t2.json.muse_wake_removed, true, t2.text);
    assert.equal(hookIn(k.w, "lima"), null);
  } finally {
    k.b.restore();
  }
});

test("the disconnect waits for an outstanding recording at most AGENT_WAKE_SET_MS + AGENT_WAKE_SKEW_MS, looks again, drops nothing while it may still land, and leaves the room for a second DELETE (in muse_wakes_left only)", async () => {
  const k = await museKeyed(["lima"]);
  try {
    k.w.harness("lima").room.access(k.tok.lima, false);
    await stoppedAfterSet(k, k.code);
    const before = await storedOf(k.w, k.key);
    const [d] = deadlines(await k.peek(), "lima");
    clockAt(k.w, "lima", d + SKEW);
    const mark = k.w.asked.length;
    const r = await read(agentRoute(k.w.rc("DELETE", "/api/agent", { headers: auth(k.key) })));
    assert.deepEqual(r.json, { deleted: true, rooms: ["lima"], muse_wakes_removed: [], muse_wakes_left: ["lima"], note: dropNote(["lima"]) });
    assert.deepEqual(k.w.methods("lima", mark), ["museHookLook", "museHookLook"], "a look, the wait, a look again; nothing dropped");
    assert.equal(hookIn(k.w, "lima").link, k.link);
    assert.deepEqual(await storedOf(k.w, k.key), { ...before, kind: "cut" });
    clockAt(k.w, "lima", d + SKEW + 1);
    const r2 = await read(agentRoute(k.w.rc("DELETE", "/api/agent", { headers: auth(k.key) })));
    assert.deepEqual(r2.json, { deleted: true, rooms: ["lima"], muse_wakes_removed: ["lima"], muse_wakes_left: [], note: dropNote([]) });
    assert.equal(hookIn(k.w, "lima"), null);
    assert.equal(await storedOf(k.w, k.key), null);
  } finally {
    k.b.restore();
  }
});

test("a settling write whose compare-and-set loses throws its observation away and asks the room again", async () => {
  const k = await museKeyed(["lima", "oslo"]);
  try {
    for (const n of ["lima", "oslo"]) k.w.harness(n).room.access(k.tok[n], false);
    await mcp(k.w, call("muse_register", { code: k.code, rooms: ["lima"] }), auth(k.key));
    k.w.harness("oslo").room.revoke(k.tok.oslo);
    // the first look at lima: meanwhile another call writes the list (oslo marked refused)
    const lima = k.w.harness("lima").room, real = lima.museHookLook.bind(lima);
    let looks = 0;
    lima.museHookLook = async (...a) => { if (++looks === 1) await mcp(k.w, call("whoami", { room: "oslo" }), auth(k.key)); return real(...a); };
    const t = await read(agentRemoveRoute(k.w.rc("POST", "/api/agent/rooms/remove", { json: { room: "lima" }, headers: auth(k.key) })));
    delete lima.museHookLook;
    assert.equal(t.json.muse_wake_removed, true, t.text);
    assert.equal(looks, 2, "looked again on the newer list");
    assert.equal(hookIn(k.w, "lima"), null);
  } finally {
    k.b.restore();
  }
});

test("a refused first registration of a link (too late, not joined) leaves nothing after its tidy; with the tidy's look made to throw, the link stays, and the next take-off settles it", async () => {
  for (const how of ["too late", "not joined", "tidy throws"]) {
    const k = await museKeyed(["lima"]);
    try {
      const room = k.w.harness("lima").room;
      room.access(k.tok.lima, false);
      const real = room.museSetHookLook.bind(room);
      room.museSetHookLook = (...a) => (how === "not joined" ? { ok: false, status: 409, code: "not_joined", error: museNotJoined(true), now: room.museNow() } : (clockAt(k.w, "lima", a[4] + 1), real(...a)));
      if (how === "tidy throws") room.museHookLook = () => { throw new Error("Network connection lost."); };
      const r = await mcp(k.w, call("muse_register", { code: k.code }), auth(k.key));
      delete room.museSetHookLook;
      delete room.museNow;
      assert.equal(result(r).structuredContent.results[0].ok, false, how);
      assert.equal(hookIn(k.w, "lima"), null, how + ": nothing set");
      if (how !== "tidy throws") {
        assert.deepEqual(outstanding(await k.peek(), "lima"), [], how + ": nothing left");
        continue;
      }
      delete room.museHookLook;
      assert.deepEqual(outstanding(await k.peek(), "lima"), [[k.link, 0]], "the link stays, nothing outstanding");
      const mark = k.w.asked.length;
      const t = await read(agentRemoveRoute(k.w.rc("POST", "/api/agent/rooms/remove", { json: { room: "lima" }, headers: auth(k.key) })));
      assert.equal(t.json.muse_wake_removed, true, t.text);
      assert.deepEqual(k.w.methods("lima", mark), ["museHookLook"], "a look: no hook there, nothing to drop");
    } finally {
      k.b.restore();
    }
  }
});

test("a set whose answer is lost says so: after the room ran it the wake is on, before it is not, and either way the answer is true (answer_lost: it may be on; the key keeps it on its record; register again with a new code to be sure), and the take-off or disconnect turns it off", async () => {
  for (const when of ["after the room ran it", "before it reached the room"]) {
    const k = await museKeyed(["lima"]);
    try {
      const room = k.w.harness("lima").room;
      room.access(k.tok.lima, false);
      const real = room.museSetHookLook.bind(room);
      room.museSetHookLook = (...a) => { if (when === "after the room ran it") real(...a); throw new Error("Network connection lost."); };
      const r = await mcp(k.w, call("muse_register", { code: k.code }), auth(k.key));
      delete room.museSetHookLook;
      assert.deepEqual(result(r).structuredContent.results, [{ room: "lima", ok: false, status: 503, code: "answer_lost", error: wakeLost("lima") }], when);
      assert.equal(wakeLost("lima"), "lima did not answer the registration, so its Muse wake may be on there or not: this key keeps it on its record, so taking lima off the key or disconnecting the key turns it off either way. To be sure it is on, register lima again with a new code from the gadget, since this one was used.");
      assert.equal(hookIn(k.w, "lima") && hookIn(k.w, "lima").link, when === "after the room ran it" ? k.link : null, when + ": the wake is " + (when === "after the room ran it" ? "on" : "off"));
      assert.deepEqual(outstanding(await k.peek(), "lima"), [[k.link, 1]], when + ": the key keeps it on its record");
      const list = result(await mcp(k.w, call("list_rooms", {}), auth(k.key))).structuredContent.rooms;
      assert.equal(list[0].muse_wake, true);
      pastDeadlines(k.w, "lima");
      const d = await read(agentRoute(k.w.rc("DELETE", "/api/agent", { headers: auth(k.key) })));
      assert.deepEqual(d.json.muse_wakes_left, [], when);
      assert.equal(hookIn(k.w, "lima"), null, when + ": off");
    } finally {
      k.b.restore();
    }
  }
});

test("a registration whose own write loses its compare-and-set every time leaves its recording outstanding: a take-off then waits, and its sentence is true (the outcome is not on the key's record yet)", async () => {
  const k = await museKeyed(["lima"]);
  try {
    k.w.harness("lima").room.access(k.tok.lima, false);
    const obj = k.w.harness(k.id).room, realSwap = obj.agentSwap.bind(obj);
    let swaps = 0;
    obj.agentSwap = (...a) => (++swaps === 1 ? realSwap(...a) : { ok: false, code: "stale" });
    const r = await mcp(k.w, call("muse_register", { code: k.code }), auth(k.key));
    delete obj.agentSwap;
    assert.equal(result(r).structuredContent.results[0].ok, true, "the room took the set");
    assert.equal(hookIn(k.w, "lima").link, k.link);
    assert.deepEqual(outstanding(await k.peek(), "lima"), [[k.link, 1]], "its own write never went through");
    const t = await read(agentRemoveRoute(k.w.rc("POST", "/api/agent/rooms/remove", { json: { room: "lima" }, headers: auth(k.key) })));
    assert.deepEqual([t.status, t.json.code], [503, "try_again"]);
    assert.match(t.json.error, /^lima may still be reached by a Muse registration through this key whose outcome there is not on the key's record yet, so it is still on this key as it was\. Try again in \d+ seconds\.$/);
    assert.equal(hookIn(k.w, "lima").link, k.link, "nothing dropped");
  } finally {
    k.b.restore();
  }
});

test("a Muse link longer than AGENT_WAKE_LINK_MAX is neither recorded on the key nor set in any room: each room answers link_unusable, nothing is written, the code is spent", async () => {
  const k = await museKeyed(["lima", "oslo"]);
  try {
    for (const n of ["lima", "oslo"]) k.w.harness(n).room.access(k.tok[n], false);
    // the bridge's directory hands this code's claim a link one character too long
    const dir = k.b.env.MUSE_DIRECTORY.instances.get("directory");
    const long = "ml_" + "0".repeat(AGENT_WAKE_LINK_MAX - 2);
    dir.sql.db.prepare("UPDATE codes SET link = ? WHERE link = ?").run(long, k.link);
    const before = await storedOf(k.w, k.key);
    const mark = k.w.asked.length;
    const r = await mcp(k.w, call("muse_register", { code: k.code }), auth(k.key));
    assert.deepEqual(result(r).structuredContent, { claimed: true, results: ["lima", "oslo"].map((room) => ({ room, ok: false, status: 502, code: "link_unusable", error: wakeLinkUnusable(room) })) });
    // a new code from the same gadget gives the same link: the sentence sends the agent to the room's own registration instead
    assert.equal(wakeLinkUnusable("lima"), "The link to your person's Muse that this code gave cannot be used through an agent key, so nothing was set in lima, and the code was used. A new code from the same gadget gives the same link: to have lima wake that Muse, register it with lima's own token instead (POST /api/muse/hooks, MUSE DELIVERY at /api).");
    assert.doesNotMatch(wakeLinkUnusable("lima"), /connect the gadget again|for a new one/);
    assert.ok(!k.w.asked.slice(mark).some((a) => a.method === "museSetHookLook" || a.method === "agentSwap"), "no set sent, nothing written");
    assert.deepEqual(await storedOf(k.w, k.key), before);
    assert.deepEqual([hookIn(k.w, "lima"), hookIn(k.w, "oslo")], [null, null]);
    assert.ok(!r.text.includes(long), "the link is in no answer");
  } finally {
    k.b.restore();
  }
});

test("two DELETEs of one key at once both answer truly: one whose write finds the record gone answers a complete disconnect; one whose write finds the list moved cuts, reads again and answers what is left; a third DELETE's refusal contradicts neither", async () => {
  {
    // the second DELETE runs inside the first one's look at lima, settles lima and deletes the record; the first's look throws
    const k = await museKeyed(["lima"]);
    try {
      k.w.harness("lima").room.access(k.tok.lima, false);
      await mcp(k.w, call("muse_register", { code: k.code }), auth(k.key));
      const lima = k.w.harness("lima").room, real = lima.museHookLook.bind(lima);
      let mine = 0, other = false, second = null;
      lima.museHookLook = async (...a) => {
        if (other || mine >= 2) return real(...a);
        if (++mine === 1) { other = true; second = await read(agentRoute(k.w.rc("DELETE", "/api/agent", { headers: auth(k.key) }))); other = false; }
        throw new Error("Network connection lost.");
      };
      const first = await read(agentRoute(k.w.rc("DELETE", "/api/agent", { headers: auth(k.key) })));
      delete lima.museHookLook;
      assert.deepEqual(second.json, { deleted: true, rooms: ["lima"], muse_wakes_removed: ["lima"], muse_wakes_left: [], note: dropNote([]) });
      assert.deepEqual(first.json, { deleted: true, rooms: ["lima"], muse_wakes_removed: [], muse_wakes_left: [], note: dropNote([]) }, "the record is gone: complete, and this call removed nothing");
      assert.equal(hookIn(k.w, "lima"), null);
      assert.equal(await storedOf(k.w, k.key), null, "no record is left, and no answer says one is");
      const third = await read(agentRoute(k.w.rc("DELETE", "/api/agent", { headers: auth(k.key) })));
      assert.equal(third.json.code, "agent_key_invalid");
    } finally {
      k.b.restore();
    }
  }
  {
    // lima and oslo; oslo never answers a drop: the second DELETE settles lima and keeps oslo; the first's remainder is stale
    const k = await museKeyed(["lima", "oslo"]);
    try {
      for (const n of ["lima", "oslo"]) k.w.harness(n).room.access(k.tok[n], false);
      await mcp(k.w, call("muse_register", { code: k.code }), auth(k.key));
      k.w.harness("oslo").room.museDropLook = () => { throw new Error("Network connection lost."); };
      const lima = k.w.harness("lima").room, real = lima.museHookLook.bind(lima);
      let mine = 0, other = false, second = null;
      lima.museHookLook = async (...a) => {
        if (other || mine >= 2) return real(...a);
        if (++mine === 1) { other = true; second = await read(agentRoute(k.w.rc("DELETE", "/api/agent", { headers: auth(k.key) }))); other = false; }
        throw new Error("Network connection lost.");
      };
      const first = await read(agentRoute(k.w.rc("DELETE", "/api/agent", { headers: auth(k.key) })));
      delete lima.museHookLook;
      assert.deepEqual(second.json, { deleted: true, rooms: ["lima", "oslo"], muse_wakes_removed: ["lima"], muse_wakes_left: ["oslo"], note: dropNote(["oslo"]) });
      assert.deepEqual(first.json, { deleted: true, rooms: ["lima", "oslo"], muse_wakes_removed: [], muse_wakes_left: ["oslo"], note: dropNote(["oslo"]) }, "it read the record again: oslo is what is left");
      const left = await storedOf(k.w, k.key);
      assert.deepEqual(left.rooms.map((e) => e.room), ["oslo"], "the record keeps oslo, as both answers say");
      delete k.w.harness("oslo").room.museDropLook;
      const third = await read(agentRoute(k.w.rc("DELETE", "/api/agent", { headers: auth(k.key) })));
      assert.deepEqual(third.json, { deleted: true, rooms: ["oslo"], muse_wakes_removed: ["oslo"], muse_wakes_left: [], note: dropNote([]) });
    } finally {
      k.b.restore();
    }
  }
});

test("a second gadget whose set throws: its link stays outstanding; a take-off waits for it and drops nothing; past its deadline the take-off drops the first wake and both links leave; the disconnect waits, looks again and does the same", async () => {
  for (const end of ["take-off", "disconnect"]) {
    const k = await museKeyed(["lima"]);
    try {
      k.w.harness("lima").room.access(k.tok.lima, false);
      assert.equal(result(await mcp(k.w, call("muse_register", { code: k.code }), auth(k.key))).structuredContent.results[0].ok, true);
      const g2 = await k.b.connect();
      const room = k.w.harness("lima").room;
      room.museSetHookLook = () => { throw new Error("Network connection lost."); };
      const r = await mcp(k.w, call("muse_register", { code: g2.code }), auth(k.key));
      assert.deepEqual(result(r).structuredContent.results, [{ room: "lima", ok: false, status: 503, code: "answer_lost", error: wakeLost("lima") }]);
      delete room.museSetHookLook;
      const list = await k.peek();
      assert.deepEqual(outstanding(list, "lima"), [[k.link, 0], [g2.link, 1]], "the throw took nothing off");
      const [d2] = deadlines(list, "lima");
      assert.equal(hookIn(k.w, "lima").link, k.link, "the first wake is still on");
      const mark = k.w.asked.length;
      const early = await read(agentRemoveRoute(k.w.rc("POST", "/api/agent/rooms/remove", { json: { room: "lima" }, headers: auth(k.key) })));
      assert.deepEqual([early.status, early.json.code], [503, "try_again"]);
      assert.ok(!k.w.methods("lima", mark).includes("museDropLook"), "nothing dropped");
      if (end === "take-off") {
        clockAt(k.w, "lima", d2 + SKEW + 1);
        const t = await read(agentRemoveRoute(k.w.rc("POST", "/api/agent/rooms/remove", { json: { room: "lima" }, headers: auth(k.key) })));
        assert.equal(t.json.muse_wake_removed, true, t.text);
      } else {
        clockBy(k.w, "lima", d2 + SKEW - 300 - Date.now());
        const m2 = k.w.asked.length;
        const d = await read(agentRoute(k.w.rc("DELETE", "/api/agent", { headers: auth(k.key) })));
        assert.deepEqual([d.json.muse_wakes_removed, d.json.muse_wakes_left, d.json.note], [["lima"], [], dropNote([])]);
        assert.deepEqual(k.w.methods("lima", m2), ["museHookLook", "museHookLook", "museDropLook"], "a look, the wait, a look again, the drop");
      }
      assert.equal(hookIn(k.w, "lima"), null, "the wake the key set up is off, as the answer says");
      await k.w.harness("lima").settled();
      assert.equal(await k.b.rooms(k.link), 0);
    } finally {
      k.b.restore();
    }
  }
});

test("a Worker that stops before its own write leaves its recording outstanding; a later registration's tidy takes off only a link that is not on and has nothing outstanding", async () => {
  const k = await museKeyed(["lima"]);
  try {
    k.w.harness("lima").room.access(k.tok.lima, false);
    await mcp(k.w, call("muse_register", { code: k.code }), auth(k.key));
    const g2 = await k.b.connect();
    k.w.harness("lima").room.museSetHookLook = () => { throw new Error("the Worker stopped"); };
    await stoppedAfterSet(k, g2.code);
    delete k.w.harness("lima").room.museSetHookLook;
    assert.deepEqual(outstanding(await k.peek(), "lima"), [[k.link, 0], [g2.link, 1]]);
    const g3 = await k.b.connect();
    assert.equal(result(await mcp(k.w, call("muse_register", { code: g3.code }), auth(k.key))).structuredContent.results[0].ok, true);
    assert.deepEqual(outstanding(await k.peek(), "lima"), [[g2.link, 1], [g3.link, 0]], "the first link off (not on, nothing outstanding); the stopped one kept");
    assert.equal(hookIn(k.w, "lima").link, g3.link);
    pastDeadlines(k.w, "lima");
    const d = await read(agentRoute(k.w.rc("DELETE", "/api/agent", { headers: auth(k.key) })));
    assert.deepEqual([d.json.muse_wakes_removed, d.json.muse_wakes_left], [["lima"], []]);
    assert.equal(hookIn(k.w, "lima"), null);
  } finally {
    k.b.restore();
  }
});

/** two registrations of one key at once, two gadgets: the first one's set held at the room until the second is done */
async function heldPair(k, beforeSecond = () => {}) {
  const g2 = await k.b.connect();
  const room = k.w.harness("lima").room, real = room.museSetHookLook.bind(room);
  let hold, d1;
  const held = new Promise((r) => { hold = r; });
  let n = 0;
  room.museSetHookLook = async (...a) => { if (++n === 1) { d1 = a[4]; await held; } return real(...a); };
  const c1 = mcp(k.w, call("muse_register", { code: k.code }), auth(k.key));
  await until(() => d1 !== undefined);
  await sleepMs(5);
  beforeSecond(d1);
  const r2 = await mcp(k.w, call("muse_register", { code: g2.code }), auth(k.key));
  hold();
  const r1 = await c1;
  delete room.museSetHookLook;
  return { g2, d1, r1: result(r1).structuredContent.results[0], r2: result(r2).structuredContent.results[0] };
}

test("two registrations of one key at once, the first one's set landing last: both answer truly, no room on the key answers room_not_held, and the wake on is the one recorded", async () => {
  const k = await museKeyed(["lima"]);
  try {
    k.w.harness("lima").room.access(k.tok.lima, false);
    const p = await heldPair(k);
    assert.deepEqual([p.r1, p.r2].map((x) => [x.room, x.ok]), [["lima", true], ["lima", true]], "each set happened, one after the other");
    assert.equal(hookIn(k.w, "lima").link, k.link, "the first call's set came last");
    assert.deepEqual(outstanding(await k.peek(), "lima"), [[k.link, 0]], "it is recorded; the other left at the first call's tidy");
    const d = await read(agentRoute(k.w.rc("DELETE", "/api/agent", { headers: auth(k.key) })));
    assert.deepEqual([d.json.muse_wakes_removed, d.json.muse_wakes_left], [["lima"], []]);
    assert.equal(hookIn(k.w, "lima"), null);
  } finally {
    k.b.restore();
  }
});

test("a set the room holds past another registration's own write and tidy: at its deadline by the room's clock it is taken and recorded; one millisecond after, the room refuses it and it sets nothing; either way the wake on is recorded", async () => {
  for (const edge of ["at the deadline", "one millisecond after"]) {
    const k = await museKeyed(["lima"]);
    try {
      k.w.harness("lima").room.access(k.tok.lima, false);
      const p = await heldPair(k, (d1) => clockAt(k.w, "lima", edge === "at the deadline" ? d1 : d1 + 1));
      assert.equal(p.r2.ok, true);
      const on = hookIn(k.w, "lima").link;
      const rec = links(await k.peek(), "lima");
      if (edge === "at the deadline") {
        assert.equal(p.r1.ok, true, JSON.stringify(p.r1));
        assert.equal(on, k.link, "the first set came last");
      } else {
        assert.deepEqual(p.r1, { room: "lima", ok: false, status: 503, code: "try_again", error: wakeAgain("lima", "late", true) });
        assert.equal(on, p.g2.link, "the late set set nothing");
      }
      assert.deepEqual(rec, [on], edge + ": the wake on is recorded, the other link gone at the last tidy");
      pastDeadlines(k.w, "lima");
      const d = await read(agentRoute(k.w.rc("DELETE", "/api/agent", { headers: auth(k.key) })));
      assert.deepEqual([d.json.muse_wakes_removed, d.json.muse_wakes_left, d.json.note], [["lima"], [], dropNote([])]);
      assert.equal(hookIn(k.w, "lima"), null, "and the answer is true");
    } finally {
      k.b.restore();
    }
  }
});

test("two gadgets: Y's set reaches the room first, X's after it; X's call writes first and Y's last (its tidy looks after its own write): the wake on, X, stays recorded", async () => {
  const k = await museKeyed(["lima"]);
  try {
    k.w.harness("lima").room.access(k.tok.lima, false);
    const gx = await k.b.connect();
    // Y: its own write held until X's call is done
    const obj = k.w.harness(k.id).room, realSwap = obj.agentSwap.bind(obj);
    let swaps = 0, release, reached = false;
    const gate = new Promise((r) => { release = r; });
    obj.agentSwap = async (...a) => { if (++swaps === 2) { reached = true; await gate; } return realSwap(...a); };
    const cy = mcp(k.w, call("muse_register", { code: k.code }), auth(k.key));
    await until(() => reached);
    assert.equal(result(await mcp(k.w, call("muse_register", { code: gx.code }), auth(k.key))).structuredContent.results[0].ok, true);
    assert.equal(hookIn(k.w, "lima").link, gx.link);
    release();
    assert.equal(result(await cy).structuredContent.results[0].ok, true);
    obj.agentSwap = realSwap;
    assert.equal(hookIn(k.w, "lima").link, gx.link, "X's wake is on");
    assert.deepEqual(outstanding(await k.peek(), "lima"), [[gx.link, 0]], "and recorded; Y, not on, left at Y's tidy");
    const d = await read(agentRoute(k.w.rc("DELETE", "/api/agent", { headers: auth(k.key) })));
    assert.deepEqual([d.json.muse_wakes_removed, d.json.muse_wakes_left], [["lima"], []]);
    assert.equal(hookIn(k.w, "lima"), null);
  } finally {
    k.b.restore();
  }
});

test("one gadget's link recorded twice, in every order of the two sets and the two writes, the later set taken, refused, or taken by a Worker that stops before its write: the wake on is recorded; a take-off between the first answer and the second set waits and drops nothing", async () => {
  for (const firstSet of [0, 1]) {
    for (const writes of ["first set's call writes first", "first set's call writes last"]) {
      for (const later of ["taken", "refused", "stopped"]) {
        const what = "call " + (firstSet + 1) + "'s set first, " + writes + ", the later set " + later;
        const k = await museKeyed(["lima"]);
        try {
          k.w.harness("lima").room.access(k.tok.lima, false);
          const g = gatedSets(k.w.harness("lima").room);
          const c = [];
          c[0] = mcp(k.w, call("muse_register", { code: k.code }), auth(k.key));
          await until(() => g.carried.length === 1);
          const again = await k.b.connect({ n: k.n });
          assert.equal(again.link, k.link);
          c[1] = mcp(k.w, call("muse_register", { code: again.code }), auth(k.key));
          await until(() => g.carried.length === 2);
          assert.deepEqual(outstanding(await k.peek(), "lima"), [[k.link, 2]], what + ": two recordings of one link");
          const A = firstSet, Bc = 1 - firstSet;
          if (writes === "first set's call writes first") {
            g.gates[A]("take");
            assert.equal(result(await c[A]).structuredContent.results[0].ok, true, what);
            const t = await read(agentRemoveRoute(k.w.rc("POST", "/api/agent/rooms/remove", { json: { room: "lima" }, headers: auth(k.key) })));
            assert.deepEqual([t.status, t.json.code], [503, "try_again"], what + ": the other recording may still land");
            assert.equal(hookIn(k.w, "lima").link, k.link, what + ": nothing dropped");
          } else {
            g.hold[A] = true;
            g.gates[A]("take");
            await until(() => typeof g.deliver[A] === "function");
          }
          if (later === "stopped") stopNextSwap(k);
          g.gates[Bc](later === "refused" ? "refuse" : "take");
          if (later === "stopped") await assert.rejects(c[Bc], /the Worker stopped/, what);
          else await c[Bc];
          if (writes === "first set's call writes last") { g.deliver[A](); await c[A]; }
          g.restore();
          assert.equal(hookIn(k.w, "lima").link, k.link, what + ": the wake is on");
          assert.deepEqual(links(await k.peek(), "lima"), [k.link], what + ": and recorded");
          pastDeadlines(k.w, "lima");
          const t2 = await read(agentRemoveRoute(k.w.rc("POST", "/api/agent/rooms/remove", { json: { room: "lima" }, headers: auth(k.key) })));
          assert.equal(t2.json.muse_wake_removed, true, what + ": " + t2.text);
          assert.equal(hookIn(k.w, "lima"), null);
        } finally {
          k.b.restore();
        }
      }
    }
  }
});

test("one gadget's link recorded twice: the earlier recording's set reaches the room after its deadline and is refused, the later one's lands after that refusal and its call writes first: the refused call's write and tidy, last, leave the wake recorded", async () => {
  const k = await museKeyed(["lima"]);
  try {
    k.w.harness("lima").room.access(k.tok.lima, false);
    const room = k.w.harness("lima").room, real = room.museSetHookLook.bind(room), realNow = room.museNow.bind(room);
    let n = 0, goA, goB, refused = false;
    const gateA = new Promise((r) => { goA = r; }), gateB = new Promise((r) => { goB = r; });
    room.museSetHookLook = async (...a) => {
      if (++n === 1) {
        await gateA;
        // this set reaches the room one millisecond after its deadline: refused, no hook of the link there yet
        room.museNow = () => a[4] + 1;
        const r = real(...a);
        room.museNow = realNow;
        refused = true;
        await gateB; // its answer reaches its call late
        return r;
      }
      await until(() => refused);
      return real(...a);
    };
    const c2 = mcp(k.w, call("muse_register", { code: k.code }), auth(k.key));
    await until(() => n === 1);
    const again = await k.b.connect({ n: k.n });
    const c1 = mcp(k.w, call("muse_register", { code: again.code }), auth(k.key));
    await until(() => n === 2);
    goA();
    assert.equal(result(await c1).structuredContent.results[0].ok, true, "the later recording's set took");
    goB();
    assert.equal(result(await c2).structuredContent.results[0].code, "try_again", "the earlier one was refused, late");
    delete room.museSetHookLook;
    assert.equal(hookIn(k.w, "lima").link, k.link, "the wake is on");
    assert.deepEqual(links(await k.peek(), "lima"), [k.link], "and recorded");
    pastDeadlines(k.w, "lima");
    const d = await read(agentRoute(k.w.rc("DELETE", "/api/agent", { headers: auth(k.key) })));
    assert.deepEqual([d.json.muse_wakes_removed, d.json.muse_wakes_left], [["lima"], []]);
    assert.equal(hookIn(k.w, "lima"), null);
  } finally {
    k.b.restore();
  }
});

test("the same gadget registered again while its first wake is on, the room refusing the new set (too late; the seat revoked in the shared-name room): the link stays, the pill stays, and the disconnect turns the wake off", async () => {
  for (const how of ["too late", "seat revoked"]) {
    const { k, h } = await sharedNameKey(["lima"]);
    try {
      const again = await k.b.connect({ n: k.n });
      const real = h.room.museSetHookLook.bind(h.room);
      h.room.museSetHookLook = (...a) => {
        if (how === "seat revoked") { h.room.revoke(k.tok.lima); return real(...a); }
        clockAt(k.w, "lima", a[4] + 1);
        try { return real(...a); } finally { delete h.room.museNow; }
      };
      const r = await mcp(k.w, call("muse_register", { code: again.code }), auth(k.key));
      delete h.room.museSetHookLook;
      assert.equal(result(r).structuredContent.results[0].ok, false, how);
      assert.equal(hookIn(k.w, "lima").link, k.link, how + ": the first wake is still on");
      assert.deepEqual(outstanding(await k.peek(), "lima"), [[k.link, 0]], how + ": and still recorded");
      const list = result(await mcp(k.w, call("list_rooms", {}), auth(k.key))).structuredContent.rooms;
      assert.equal(list[0].muse_wake, true, how + ": the pill stays");
      const d = await read(agentRoute(k.w.rc("DELETE", "/api/agent", { headers: auth(k.key) })));
      assert.deepEqual([d.json.muse_wakes_removed, d.json.muse_wakes_left], [["lima"], []], how);
      assert.equal(h.all("SELECT member FROM mh").length, 0, how + ": off, as the answer says");
    } finally {
      k.b.restore();
    }
  }
});

test("the Worker's and the room's clocks several seconds apart, either way, change nothing: the same sets are taken, the same links recorded, a finished registration's take-off is at once, a cut-short one's waits by the room's clock", async () => {
  for (const skew of [-5000, 0, 5000]) {
    for (const end of ["finished", "cut short"]) {
      const what = "skew " + skew + ", " + end;
      const k = await museKeyed(["lima"]);
      try {
        k.w.harness("lima").room.access(k.tok.lima, false);
        clockBy(k.w, "lima", skew);
        const p = await heldPair(k);
        assert.deepEqual([p.r1.ok, p.r2.ok], [true, true], what);
        assert.equal(hookIn(k.w, "lima").link, k.link);
        assert.deepEqual(outstanding(await k.peek(), "lima"), [[k.link, 0]], what + ": the wake on is recorded");
        let g3 = null;
        if (end === "cut short") {
          g3 = await k.b.connect();
          await stoppedAfterSet(k, g3.code);
          assert.equal(hookIn(k.w, "lima").link, g3.link);
        }
        const list = await k.peek();
        const t = await read(agentRemoveRoute(k.w.rc("POST", "/api/agent/rooms/remove", { json: { room: "lima" }, headers: auth(k.key) })));
        if (end === "finished") {
          assert.equal(t.json.muse_wake_removed, true, what + ": " + t.text);
          assert.equal(hookIn(k.w, "lima"), null);
          continue;
        }
        assert.deepEqual([t.status, t.json.code], [503, "try_again"], what + ": still to come by the room's clock");
        const wait = Number(t.headers.get("Retry-After"));
        const due = Math.max(...deadlines(list, "lima")) + SKEW - (Date.now() + skew);
        assert.ok(Math.abs(wait - due / 1000) <= 1.5, what + ": the wait is the room's: " + wait + " for " + due);
        assert.equal(hookIn(k.w, "lima").link, g3.link, "nothing turned off");
        pastDeadlines(k.w, "lima");
        const t2 = await read(agentRemoveRoute(k.w.rc("POST", "/api/agent/rooms/remove", { json: { room: "lima" }, headers: auth(k.key) })));
        assert.equal(t2.json.muse_wake_removed, true, t2.text);
        assert.equal(hookIn(k.w, "lima"), null);
      } finally {
        k.b.restore();
      }
    }
  }
});

test("an answer from a room that sends no clock, or a drop that does not say what is on after it, settles nothing but the link it dropped: the take-off and the disconnect keep the link recorded", async () => {
  /** the room's own method, its answer without the clock (or without the link) */
  const without = (room, m, field) => { const real = room[m].bind(room); room[m] = (...a) => { const r = { ...real(...a) }; delete r[field]; return r; }; };
  for (const end of ["finished", "cut short"]) {
    const k = await museKeyed(["lima"]);
    try {
      k.w.harness("lima").room.access(k.tok.lima, false);
      if (end === "cut short") await stoppedAfterSet(k, k.code);
      else await mcp(k.w, call("muse_register", { code: k.code }), auth(k.key));
      pastDeadlines(k.w, "lima");
      const before = await storedOf(k.w, k.key);
      const room = k.w.harness("lima").room;
      without(room, "museHookLook", "now");
      const t = await read(agentRemoveRoute(k.w.rc("POST", "/api/agent/rooms/remove", { json: { room: "lima" }, headers: auth(k.key) })));
      assert.deepEqual([t.status, t.json], [503, { error: wakeNotSettled("lima"), code: "try_again", room: "lima" }], end);
      assert.deepEqual(await storedOf(k.w, k.key), before, "the list as it was");
      assert.equal(hookIn(k.w, "lima").link, k.link);
      delete room.museHookLook;
      without(room, "museDropLook", "now");
      const t2 = await read(agentRemoveRoute(k.w.rc("POST", "/api/agent/rooms/remove", { json: { room: "lima" }, headers: auth(k.key) })));
      assert.deepEqual([t2.status, t2.json], [503, { error: wakeNotSettled("lima"), code: "try_again", room: "lima" }], end + ": a drop with no clock: not settled, though its hook went");
      assert.deepEqual(await storedOf(k.w, k.key), before);
      assert.equal(hookIn(k.w, "lima"), null, "the drop ran in the room all the same");
      // the wake on again (set with the room's own token on the same link): the disconnect keeps it while the drop sends no clock
      assert.equal(room.museSetHook(k.tok.lima, k.link, "main", "lima").ok, true);
      const d = await read(agentRoute(k.w.rc("DELETE", "/api/agent", { headers: auth(k.key) })));
      assert.deepEqual([d.json.muse_wakes_removed, d.json.muse_wakes_left], [[], ["lima"]]);
      const linksOf = (st) => st.rooms.map((e) => [e.room, (e.hooks || []).map((h) => h.link)]);
      assert.deepEqual(linksOf(await storedOf(k.w, k.key)), linksOf(before), "the cut record keeps it (an expired recording pruned)");
      // a drop that says it removed the link but not what is on after it: that link settles
      delete room.museDropLook;
      assert.equal(room.museSetHook(k.tok.lima, k.link, "main", "lima").ok, true);
      without(room, "museDropLook", "link");
      const d2 = await read(agentRoute(k.w.rc("DELETE", "/api/agent", { headers: auth(k.key) })));
      assert.deepEqual([d2.json.muse_wakes_removed, d2.json.muse_wakes_left], [["lima"], []], end);
    } finally {
      k.b.restore();
    }
  }
});

test("a room is in one of the disconnect's two lists: a hook taken off while another link of the entry stays names the room as left only; a second DELETE settles it and names it removed only if a hook goes then", async () => {
  const k = await museKeyed(["lima"]);
  try {
    const room = k.w.harness("lima").room;
    room.access(k.tok.lima, false);
    // Y finished; then X, whose tidy's look throws, so Y (not on, nothing outstanding) stays recorded beside it
    const gy = await k.b.connect();
    assert.equal(result(await mcp(k.w, call("muse_register", { code: gy.code }), auth(k.key))).structuredContent.results[0].ok, true);
    const realLook = room.museHookLook.bind(room);
    room.museHookLook = () => { throw new Error("Network connection lost."); };
    assert.equal(result(await mcp(k.w, call("muse_register", { code: k.code }), auth(k.key))).structuredContent.results[0].ok, true);
    room.museHookLook = realLook;
    assert.deepEqual(outstanding(await k.peek(), "lima"), [[gy.link, 0], [k.link, 0]]);
    assert.equal(hookIn(k.w, "lima").link, k.link);
    // the drop answers without saying what is on after it: it settles the link it dropped only, so Y stays
    const realDrop = room.museDropLook.bind(room);
    room.museDropLook = (...a) => { const r = { ...realDrop(...a) }; delete r.link; return r; };
    const d = await read(agentRoute(k.w.rc("DELETE", "/api/agent", { headers: auth(k.key) })));
    assert.deepEqual([d.json.muse_wakes_removed, d.json.muse_wakes_left], [[], ["lima"]], "the hook went, but a link stays: left only");
    assert.equal(hookIn(k.w, "lima"), null);
    room.museDropLook = realDrop;
    const d2 = await read(agentRoute(k.w.rc("DELETE", "/api/agent", { headers: auth(k.key) })));
    assert.deepEqual([d2.json.muse_wakes_removed, d2.json.muse_wakes_left], [[], []], "settled on a look, no hook taken off this time");
  } finally {
    k.b.restore();
  }
});

test("the bound: an entry holds at most AGENT_WAKE_ITEMS_MAX links and outstanding recordings; at the bound a settling write comes first, and a room still full is skipped without spending the code; once the room's clock passes them, they settle and the new one goes on", async () => {
  const k = await museKeyed(["lima", "oslo"]);
  try {
    for (const n of ["lima", "oslo"]) k.w.harness(n).room.access(k.tok[n], false);
    const lima = k.w.harness("lima").room;
    lima.museSetHookLook = () => { throw new Error("Network connection lost."); };
    // each throwing registration of a new gadget leaves its link and its recording
    let code = k.code;
    for (let i = 0; i < AGENT_WAKE_ITEMS_MAX; i++) {
      const w = (await k.peek()).lima || [];
      if (w.reduce((n, h) => n + 1 + h.recs.length, 0) + 2 > AGENT_WAKE_ITEMS_MAX) break;
      await mcp(k.w, call("muse_register", { code, rooms: ["lima"] }), auth(k.key));
      code = (await k.b.connect()).code;
    }
    delete lima.museSetHookLook;
    const filled = (await k.peek()).lima;
    assert.ok(filled.length >= 2 && filled.every((h) => h.recs.length === 1), "every throw left its link and its recording");
    // lima alone, while those may still land: a look first, then skipped, and the code not used
    const claims = k.b.paths.filter((p) => p === "/claim").length;
    let mark = k.w.asked.length;
    let r = await mcp(k.w, call("muse_register", { code, rooms: ["lima"] }), auth(k.key));
    assert.equal(result(r).content[0].text, "No room on your key took its invite, so the code was not used.");
    assert.deepEqual(result(r).structuredContent.results, [{ room: "lima", ok: false, status: 503, code: "try_again", error: wakeAgain("lima", "full", false) }]);
    assert.ok(k.w.asked.slice(mark).some((a) => a.name === "lima" && a.method === "museHookLook"), "a settling look first");
    assert.equal(k.b.paths.filter((p) => p === "/claim").length, claims, "the code was not claimed");
    // with oslo too: oslo is registered, lima skipped, the code used once
    r = await mcp(k.w, call("muse_register", { code }), auth(k.key));
    assert.deepEqual(result(r).structuredContent.results.map((x) => [x.room, x.ok, x.code, x.error]), [["lima", false, "try_again", wakeAgain("lima", "full", true)], ["oslo", true, undefined, undefined]]);
    assert.deepEqual((await k.peek()).lima, filled, "nothing taken off while it may still land");
    // the room's clock past them when it is looked at: the settling write takes them off, and the new one goes on
    const realLook = lima.museHookLook.bind(lima);
    lima.museHookLook = (...a) => { pastDeadlines(k.w, "lima"); try { return realLook(...a); } finally { delete lima.museNow; } };
    const g2 = await k.b.connect();
    mark = k.w.asked.length;
    r = await mcp(k.w, call("muse_register", { code: g2.code, rooms: ["lima"] }), auth(k.key));
    delete lima.museHookLook;
    assert.equal(result(r).structuredContent.results[0].ok, true, r.text.slice(0, 300));
    assert.deepEqual(outstanding(await k.peek(), "lima"), [[g2.link, 0]]);
    assert.equal(hookIn(k.w, "lima").link, g2.link);
  } finally {
    k.b.restore();
  }
});

/** lima holds Hank and an active "hank" besides: one hook, filed under the folded name; Pat, a person, there too */
async function sharedNameKey(names = ["lima"], end = "finished") {
  const k = await museKeyed(names);
  const h = k.w.harness("lima");
  for (const n of names) k.w.harness(n).room.access(k.tok[n], false);
  const now = Date.now();
  h.db.prepare("INSERT INTO inv (token, name, created, kind, used, seen) VALUES ('tok-hank-lower-0000000', 'hank', ?, 'agent', ?, ?)").run(now - 3000, now - 2000, now - 2000);
  // the registration finished (its link answered), or cut short after the room's ok (pending)
  if (end === "cut short") await stoppedAfterSet(k, k.code, { rooms: ["lima"] });
  else assert.equal(result(await mcp(k.w, call("muse_register", { code: k.code, rooms: ["lima"] }), auth(k.key))).structuredContent.results[0].ok, true);
  assert.equal(hookIn(k.w, "lima").link, k.link);
  return { k, h };
}
const hooksAll = (h) => h.all("SELECT member, kind, link FROM mh").map((r) => ({ ...r }));

test("in an older room where two active invites' names fold alike, a gone seat keeps its hook: the take-off and the disconnect turn it off through the gone seat, and a room that will not answer for it keeps the room on the key", async () => {
  // revoked by the owner, then taken off the key
  {
    const { k, h } = await sharedNameKey();
    try {
      h.room.revoke(k.tok.lima);
      assert.deepEqual(hooksAll(h), [{ member: "hank", kind: "muse", link: k.link }], "the revoke kept the hook");
      await mcp(k.w, call("whoami", { room: "lima" }), auth(k.key)); // marks lima refused
      pastDeadlines(k.w, "lima");
      const rows = h.all("SELECT token, used, seen, revoked, left_ts FROM inv ORDER BY token").map((r) => ({ ...r }));
      const t = await read(agentRemoveRoute(k.w.rc("POST", "/api/agent/rooms/remove", { json: { room: "lima" }, headers: auth(k.key) })));
      assert.deepEqual(t.json, { room: "lima", removed: true, muse_wake_removed: true, note: removedRefusedNote("lima", true) });
      assert.ok(!/nothing else changes/.test(t.json.note), "the note does not say nothing else changes");
      assert.deepEqual(hooksAll(h), [], "the wake is off, as the answer says");
      assert.deepEqual(h.all("SELECT token, used, seen, revoked, left_ts FROM inv ORDER BY token").map((r) => ({ ...r })), rows, "nothing opened or marked seen");
    } finally {
      k.b.restore();
    }
  }
  // left, then the key disconnected
  {
    const { k, h } = await sharedNameKey();
    try {
      assert.equal((await h.room.leave(k.tok.lima, "lima", false)).ok, true);
      assert.equal(hooksAll(h).length, 1, "the leave kept the hook");
      pastDeadlines(k.w, "lima");
      const d = await read(agentRoute(k.w.rc("DELETE", "/api/agent", { headers: auth(k.key) })));
      assert.deepEqual([d.json.muse_wakes_removed, d.json.muse_wakes_left, d.json.note], [["lima"], [], dropNote([])]);
      assert.deepEqual(hooksAll(h), []);
    } finally {
      k.b.restore();
    }
  }
  // a room still on code that refuses a gone seat: nothing is counted as off
  {
    const { k, h } = await sharedNameKey();
    try {
      h.room.revoke(k.tok.lima);
      pastDeadlines(k.w, "lima");
      const now = Date.now() + AGENT_WAKE_SET_MS + 1000;
      const gone = { ok: false, status: 403, code: "invite_revoked", error: "This invite link has been revoked. Ask whoever gave it to you for a new one.", now };
      h.room.museHookLook = () => gone;
      h.room.museDropLook = () => gone;
      const t = await read(agentRemoveRoute(k.w.rc("POST", "/api/agent/rooms/remove", { json: { room: "lima" }, headers: auth(k.key) })));
      assert.deepEqual([t.status, t.json], [503, { error: wakeNotSettled("lima"), code: "try_again", room: "lima" }]);
      assert.deepEqual(links(await k.peek(), "lima"), [k.link], "still on the key, its link recorded");
      const d = await read(agentRoute(k.w.rc("DELETE", "/api/agent", { headers: auth(k.key) })));
      assert.deepEqual([d.json.muse_wakes_removed, d.json.muse_wakes_left, d.json.note], [[], ["lima"], dropNote(["lima"])]);
      assert.equal(hooksAll(h).length, 1, "the wake is on, and the answer does not say it is off");
    } finally {
      k.b.restore();
    }
  }
  // a token the room never had, or a room that is gone, settles the link (by the room's clock)
  for (const code of ["invite_invalid", "room_deleted"]) {
    const { k, h } = await sharedNameKey();
    try {
      const now = Date.now() + AGENT_WAKE_SET_MS + 1000;
      h.room.museDropLook = () => ({ ok: false, status: 403, code, error: "gone", now });
      const d = await read(agentRoute(k.w.rc("DELETE", "/api/agent", { headers: auth(k.key) })));
      assert.deepEqual([d.json.muse_wakes_removed, d.json.muse_wakes_left], [[], []], code);
    } finally {
      k.b.restore();
    }
  }
});

test("the shared-name room, its seat revoked or left, put back on the key with another invite by add_room, POST /api/agent/rooms or POST /api/agent/rooms/invite: after a finished registration at once; after one cut short try_again while its set may still arrive, changing nothing; either way its wake is turned off first, and the disconnect after it says the wakes are off, and they are", async () => {
  const paths = {
    add_room: async (k, other) => {
      const r = result(await mcp(k.w, call("add_room", { room: "lima", token: other }), auth(k.key)));
      return r.isError ? { refused: r.structuredContent, text: r.content[0].text } : { ok: true };
    },
    "POST /api/agent/rooms": async (k, other) => {
      const r = await read(agentRoomsRoute(k.w.rc("POST", "/api/agent/rooms", { json: { rooms: [{ room: "lima", token: other }] }, headers: auth(k.key) })));
      return r.status === 201 ? { ok: true } : { refused: { code: r.json.code, room: r.json.room }, text: r.json.error, status: r.status, retry: r.headers.get("Retry-After") };
    },
    "POST /api/agent/rooms/invite": async (k, _other, pat) => {
      const r = await read(agentInviteAddRoute(k.w.rc("POST", "/api/agent/rooms/invite", { json: { name: "Other", rooms: [{ room: "lima", inviter_token: pat }] }, headers: auth(k.key) })));
      return r.status === 201 ? { ok: true } : { refused: { code: r.json.code, room: r.json.room }, text: r.json.error, status: r.status, retry: r.headers.get("Retry-After") };
    },
  };
  for (const end of ["finished", "cut short"]) for (const how of ["revoked", "left"]) {
    for (const [path, add] of Object.entries(paths)) {
      const what = end + ", " + how + ", " + path;
      const { k, h } = await sharedNameKey(["lima"], end);
      try {
        const pat = agentInvite(h, "Pat", "human");
        if (how === "revoked") h.room.revoke(k.tok.lima);
        else assert.equal((await h.room.leave(k.tok.lima, "lima", false)).ok, true);
        assert.deepEqual(hooksAll(h), [{ member: "hank", kind: "muse", link: k.link }], what + ": the hook outlived the seat");
        await mcp(k.w, call("whoami", { room: "lima" }), auth(k.key)); // marks lima refused, its link kept
        const other = path === "POST /api/agent/rooms/invite" ? null : agentInvite(h, "Other");
        const before = await storedOf(k.w, k.key);
        assert.deepEqual(before.rooms.map((e) => [e.room, e.state, (e.hooks || []).map((x) => x.link)]), [["lima", "refused", [k.link]]]);
        const invites = h.all("SELECT token FROM inv").length;
        if (end === "cut short") {
          // the registration's deadline still to come by the room's clock: try_again, nothing changed
          const r = await add(k, other, pat);
          assert.deepEqual(r.refused, { code: "try_again", room: "lima" }, what + ": " + JSON.stringify(r));
          assert.match(r.text, /^lima may still be reached by a Muse registration through this key whose outcome there is not on the key's record yet/);
          if (r.status !== undefined) assert.deepEqual([r.status, Number(r.retry) > 0], [503, true]);
          assert.deepEqual(await storedOf(k.w, k.key), before, what + ": the list as it was");
          assert.equal(hooksAll(h).length, 1, what + ": the wake as it was");
          assert.equal(h.all("SELECT token FROM inv").length, invites, what + ": no invite made");
          // once its deadline has passed
          pastDeadlines(k.w, "lima");
        }
        // the wake goes first, then the entry is replaced (a finished registration's link: at once, the room's clock as it is)
        const t0 = Date.now();
        const r = await add(k, other, pat);
        assert.deepEqual(r, { ok: true }, what);
        if (end === "finished") assert.ok(Date.now() - t0 < AGENT_WAKE_RETRY_MS, what + ": no wait");
        assert.deepEqual(hooksAll(h), [], what + ": the old wake is off");
        const after = await storedOf(k.w, k.key);
        assert.deepEqual(after.rooms.map((e) => [e.room, e.state, e.name, e.hooks]), [["lima", "held", "Other", undefined]]);
        const d = await read(agentRoute(k.w.rc("DELETE", "/api/agent", { headers: auth(k.key) })));
        assert.deepEqual(d.json, { deleted: true, rooms: ["lima"], muse_wakes_removed: [], muse_wakes_left: [], note: dropNote([]) }, what);
        assert.deepEqual(hooksAll(h), [], what + ": the answer is true");
      } finally {
        k.b.restore();
      }
    }
  }
});

test("POST /api/agent/rooms/invite: a refused entry's wake goes off in a settling write before any invite; an add that fails after it replaced that entry puts it back as it was", async () => {
  const { k, h } = await sharedNameKey(["lima", "oslo"]);
  try {
    const pat = { lima: agentInvite(h, "Pat", "human"), oslo: agentInvite(k.w.harness("oslo"), "Pat", "human") };
    h.room.revoke(k.tok.lima);
    await mcp(k.w, call("whoami", { room: "lima" }), auth(k.key));
    k.w.harness("oslo").room.revoke(k.tok.oslo);
    await mcp(k.w, call("whoami", { room: "oslo" }), auth(k.key));
    const before = await storedOf(k.w, k.key);
    assert.deepEqual(before.rooms.map((e) => [e.room, e.state, (e.hooks || []).map((x) => x.link)]), [["lima", "refused", [k.link]], ["oslo", "refused", []]]);
    // lima's wake goes first, in a settling write of its own, before any invite; lima is then replaced; oslo's invite fails
    k.w.harness("oslo").room.invite = () => { throw new Error("RPC receiver does not implement the method \"invite\""); };
    const r = await read(agentInviteAddRoute(k.w.rc("POST", "/api/agent/rooms/invite", { json: { name: "Other", rooms: [{ room: "lima", inviter_token: pat.lima }, { room: "oslo", inviter_token: pat.oslo }] }, headers: auth(k.key) })));
    assert.equal(r.status, 500, r.text);
    assert.deepEqual(r.json.left_unused, ["lima"]);
    assert.deepEqual(hooksAll(h), [], "lima's wake was turned off before any invite");
    const lima = before.rooms[0];
    delete lima.hooks;
    assert.deepEqual(await storedOf(k.w, k.key), before, "lima's entry is back as the add replaced it: its token and state, its links settled by then");
  } finally {
    k.b.restore();
  }
});

test("the disconnect, the take-off and muse_register register their work with waitUntil before their first write", async () => {
  const k = await museKeyed(["lima", "oslo"]);
  try {
    for (const n of ["lima", "oslo"]) k.w.harness(n).room.access(k.tok[n], false);
    let mark = k.w.asked.length;
    await mcp(k.w, call("muse_register", { code: k.code }), auth(k.key));
    let first = waitedBeforeWrite(k.w, mark);
    assert.equal(k.w.asked[first.first].method, "agentSwap");
    assert.ok(first.ok, "muse_register: " + JSON.stringify({ waits: k.w.waits, first: first.first }));
    pastDeadlines(k.w, "lima", "oslo");
    mark = k.w.asked.length;
    await mcp(k.w, call("remove_room", { room: "oslo" }), auth(k.key));
    first = waitedBeforeWrite(k.w, mark);
    assert.equal(k.w.asked[first.first].method, "museDropLook");
    assert.ok(first.ok, "remove_room");
    mark = k.w.asked.length;
    await read(agentRemoveRoute(k.w.rc("POST", "/api/agent/rooms/remove", { json: { room: "lima" }, headers: auth(k.key) })));
    first = waitedBeforeWrite(k.w, mark);
    assert.ok(first.first >= 0 && first.ok, "POST /api/agent/rooms/remove");
    mark = k.w.asked.length;
    await read(agentRoute(k.w.rc("DELETE", "/api/agent", { headers: auth(k.key) })));
    first = waitedBeforeWrite(k.w, mark);
    assert.equal(k.w.asked[first.first].method, "agentCut");
    assert.ok(first.ok, "DELETE /api/agent: before the cut");
  } finally {
    k.b.restore();
  }
});

// A disconnect whose writes keep meeting a record other DELETEs of the key
// changed: when the write on its last try finds the record gone, one more
// cut says so, and the answer is the complete disconnect; when the list
// still moves, the 503 says the key is cut already and DELETE again
// finishes, and it does.
import { dropBusy } from "../../worker/agents/onboarding.ts";
test("a disconnect's write on its last try that finds the record gone answers the complete disconnect; one whose list kept moving answers 503 try_again saying the key is cut already, and DELETE again finishes", async () => {
  {
    const k = await museKeyed(["lima"]);
    try {
      k.w.harness("lima").room.access(k.tok.lima, false);
      assert.equal(result(await mcp(k.w, call("muse_register", { code: k.code }), auth(k.key))).structuredContent.results[0].ok, true);
      const obj = k.w.harness(k.id).room, realDrop = obj.agentDrop.bind(obj);
      let drops = 0, inner = false, other = null;
      // two stale answers stand for two other DELETEs' remainder writes; on the third try another DELETE deletes the record
      obj.agentDrop = async (...a) => {
        if (inner) return realDrop(...a);
        if (++drops <= 2) return { ok: false, code: "stale" };
        inner = true;
        other = await read(agentRoute(k.w.rc("DELETE", "/api/agent", { headers: auth(k.key) })));
        inner = false;
        return realDrop(...a);
      };
      const first = await read(agentRoute(k.w.rc("DELETE", "/api/agent", { headers: auth(k.key) })));
      delete obj.agentDrop;
      assert.equal(drops, AGENT_SWAP_TRIES, "the record went on the last try");
      assert.deepEqual(other.json, { deleted: true, rooms: ["lima"], muse_wakes_removed: [], muse_wakes_left: [], note: dropNote([]) }, "the other DELETE deleted the record");
      assert.deepEqual([first.status, first.json], [200, { deleted: true, rooms: ["lima"], muse_wakes_removed: ["lima"], muse_wakes_left: [], note: dropNote([]) }], "this call took lima's hook off on its first try");
      assert.equal(hookIn(k.w, "lima"), null, "and the wake is off");
      assert.equal((await read(agentRoute(k.w.rc("DELETE", "/api/agent", { headers: auth(k.key) })))).json.code, "agent_key_invalid", "nothing is left to finish");
    } finally {
      k.b.restore();
    }
  }
  {
    const k = await museKeyed(["lima"]);
    try {
      k.w.harness("lima").room.access(k.tok.lima, false);
      assert.equal(result(await mcp(k.w, call("muse_register", { code: k.code }), auth(k.key))).structuredContent.results[0].ok, true);
      const obj = k.w.harness(k.id).room;
      obj.agentDrop = async () => ({ ok: false, code: "stale" });
      const r = await read(agentRoute(k.w.rc("DELETE", "/api/agent", { headers: auth(k.key) })));
      delete obj.agentDrop;
      assert.deepEqual([r.status, r.json, r.headers.get("Retry-After")], [503, { error: dropBusy(), code: "try_again" }, "1"]);
      assert.match(dropBusy(), /^This key is disconnected already: it works nowhere now\./);
      assert.match(dropBusy(), /DELETE \/api\/agent again with this key tries the rooms still left again, and its answer names any that still do not confirm\.$/);
      assert.doesNotMatch(dropBusy(), /finishes it/, "DELETE again tries; it may still leave some");
      assert.equal((await read(agentRoute(k.w.rc("GET", "/api/agent", { headers: auth(k.key) })))).json.code, "agent_key_invalid", "the key is cut, as the answer says");
      const again = await read(agentRoute(k.w.rc("DELETE", "/api/agent", { headers: auth(k.key) })));
      assert.deepEqual([again.status, again.json.muse_wakes_left, again.json.note], [200, [], dropNote([])], "DELETE again finishes");
      assert.equal(hookIn(k.w, "lima"), null);
      assert.equal(await storedOf(k.w, k.key), null, "the record is gone");
    } finally {
      k.b.restore();
    }
  }
});

// ---- A key's entry with a holder tag (worker/lib/agentkey.ts AgentEntry.tag, pre) ----
// This Worker makes no tag, and understands one: it looks and drops by it,
// passes on the tag of the list its recording write wrote, drops by it when
// cut meanwhile, and keeps it on every write (tagsKept beside keepsWakes).
// The tests write a tag into a key's stored list by hand, as a Worker that
// makes them would.
import { agentSealRing } from "../../worker/lib/agentkey.ts";
import { tagsKept } from "../../worker/lib/agentkey.ts";
const TAG = "tttttttttttttttttttttT";
/** the key's stored list changed by f, sealed at the next version, as another call's write would leave it */
async function editStored(w, key, f) {
  const c = agentCredential(new Request("http://localhost/", { headers: auth(key) }));
  const h = w.harness("__agent-" + c.id);
  const a = h.one("SELECT ver, ring FROM ak"), slot = h.one("SELECT wrapped FROM aks WHERE slot = 'key'");
  const u = await agentUnseal(c.id, c.secret, slot.wrapped, a.ver, a.ring);
  h.db.prepare("UPDATE ak SET ver = ?, ring = ? WHERE k = 1").run(a.ver + 1, await agentSealRing(u.dk, c.id, a.ver + 1, f(u.rooms)));
}
const holdersIn = (w, room) => w.harness(room).all("SELECT holder FROM mhh ORDER BY holder").map((r) => r.holder);

test("tagsKept: an entry recording a Muse wake keeps its tag, gains none without pre and keeps its pre; an entry recording none may change; one that leaves is keepsWakes' to check", () => {
  const e = (x = {}) => ({ room: "lima", token: "tok", name: "Hank", added: 1, state: "held", ...x });
  const W = [{ link: "L", recs: [] }];
  assert.throws(() => tagsKept([e({ hooks: W, tag: TAG })], [e({ hooks: W, tag: "uuuuuuuuuuuuuuuuuuuuuU" })]), /holder tag would change/);
  assert.throws(() => tagsKept([e({ hooks: W, tag: TAG })], [e({ hooks: W })]), /holder tag would change/);
  assert.throws(() => tagsKept([e({ hooks: W, tag: TAG })], [e({ tag: "uuuuuuuuuuuuuuuuuuuuuU" })]), /holder tag would change/, "while it recorded one, even if this write settles it");
  assert.throws(() => tagsKept([e({ hooks: W })], [e({ hooks: W, tag: TAG })]), /gain a holder tag without its pre/);
  assert.doesNotThrow(() => tagsKept([e({ hooks: W })], [e({ hooks: W, tag: TAG, pre: true })]));
  assert.throws(() => tagsKept([e({ hooks: W, tag: TAG, pre: true })], [e({ hooks: W, tag: TAG })]), /pre hold would go/);
  assert.doesNotThrow(() => tagsKept([e({ hooks: W, tag: TAG, pre: true })], [e({ tag: TAG })]), "pre may go with its last link");
  assert.doesNotThrow(() => tagsKept([e({ tag: TAG })], [e({ tag: "uuuuuuuuuuuuuuuuuuuuuU" })]), "an entry recording no link may change");
  assert.doesNotThrow(() => tagsKept([e({ hooks: W, tag: TAG })], []), "one that leaves the list");
  assert.doesNotThrow(() => tagsKept([e({ hooks: W, tag: TAG })], [e({ hooks: W, tag: TAG, token: "other" })]), "another token is another entry");
  assert.doesNotThrow(() => tagsKept([e({ hooks: W })], [e({ hooks: W })]), "with no tag anywhere, nothing is refused");
});

test("an entry with a tag is looked at and dropped by its own hold (museHolderLook, museHolderDrop, with its token, legacy as its pre); one without, as before", async () => {
  for (const pre of [false, true]) {
    const k = await museKeyed(["lima"]);
    try {
      k.w.harness("lima").room.access(k.tok.lima, false);
      assert.equal(result(await mcp(k.w, call("muse_register", { code: k.code }), auth(k.key))).structuredContent.results[0].ok, true);
      assert.deepEqual(holdersIn(k.w, "lima"), ["pre"], "set with no tag: held by pre");
      // a tag on the entry, and its hold in the room, as a Worker that makes tags leaves them
      await editStored(k.w, k.key, (rooms) => rooms.map((e) => ({ ...e, tag: TAG, ...(pre ? { pre: true } : {}) })));
      k.w.harness("lima").db.prepare("INSERT INTO mhh (member, holder, at) VALUES ('hank', ?, 1)").run(TAG);
      pastDeadlines(k.w, "lima");
      const mark = k.w.asked.length;
      const r = await read(agentRemoveRoute(k.w.rc("POST", "/api/agent/rooms/remove", { json: { room: "lima" }, headers: auth(k.key) })));
      assert.equal(r.status, 200, r.text);
      const asked = k.w.asked.slice(mark).filter((a) => a.name === "lima");
      assert.deepEqual(asked.map((a) => a.method), ["museHolderLook", "museHolderDrop"], "pre " + pre);
      assert.deepEqual(asked[0].args, [TAG, k.tok.lima, pre]);
      assert.deepEqual(asked[1].args, [TAG, k.link, k.tok.lima, pre]);
      // the tag's hold went; with pre, the untagged one too, and with it the hook
      assert.deepEqual(holdersIn(k.w, "lima"), pre ? [] : ["pre"]);
      assert.equal(hookIn(k.w, "lima") === null, pre);
    } finally {
      k.b.restore();
    }
  }
});

test("muse_register: the set carries the tag of the entry as its recording write wrote it, not as first read; cut meanwhile, it drops only that hold, by the tag", async () => {
  {
    const k = await museKeyed(["lima"]);
    try {
      const h = k.w.harness("lima");
      h.room.access(k.tok.lima, false);
      // the entry is tagged by another write between this call's first read and its recording write
      const obj = k.w.harness(k.id).room, swap = obj.agentSwap.bind(obj);
      let once = true;
      obj.agentSwap = async (...a) => { if (once) { once = false; await editStored(k.w, k.key, (rooms) => rooms.map((e) => ({ ...e, tag: TAG }))); } return swap(...a); };
      const mark = k.w.asked.length;
      const out = result(await mcp(k.w, call("muse_register", { code: k.code }), auth(k.key)));
      delete obj.agentSwap;
      assert.equal(k.w.asked.slice(mark).filter((a) => a.method === "agentSwap").length >= 2, true, "the recording write met the tagged list and wrote again");
      assert.equal(out.structuredContent.results[0].ok, true, JSON.stringify(out));
      const set = k.w.asked.slice(mark).find((a) => a.method === "museSetHookLook");
      assert.equal(set.args[5], TAG, "the set carries the tag");
      assert.deepEqual(holdersIn(k.w, "lima"), [TAG], "held by the tag, not by pre");
      assert.equal((await storedOf(k.w, k.key)).rooms[0].tag, TAG, "and the tag kept on the entry, beside its link");
      assert.deepEqual(links(await k.peek(), "lima"), [k.link]);
    } finally {
      k.b.restore();
    }
  }
  {
    const k = await museKeyed(["lima"]);
    try {
      const h = k.w.harness("lima");
      h.room.access(k.tok.lima, false);
      await editStored(k.w, k.key, (rooms) => rooms.map((e) => ({ ...e, tag: TAG })));
      // another identity holds the same hook on that link: only this call's hold goes
      const set = h.room.museSetHookLook.bind(h.room);
      const obj = k.w.harness(k.id).room;
      h.room.museSetHookLook = (...a) => {
        const r = set(...a);
        h.db.prepare("INSERT INTO mhh (member, holder, at) VALUES ('hank', 'uuuuuuuuuuuuuuuuuuuuuU', 1)").run();
        return r;
      };
      // the key is cut after the set, before this call's own write
      const swap = obj.agentSwap.bind(obj);
      let swaps = 0;
      obj.agentSwap = async (...a) => { if (++swaps === 2) { const c = agentCredential(new Request("http://localhost/", { headers: auth(k.key) })); obj.agentCut("key", await agentVerifier(c.id, c.secret)); } return swap(...a); };
      const mark = k.w.asked.length;
      const r = await mcp(k.w, call("muse_register", { code: k.code }), auth(k.key));
      delete obj.agentSwap;
      delete h.room.museSetHookLook;
      assert.equal(r.json.error.data.code, "agent_key_invalid");
      const drop = k.w.asked.slice(mark).find((a) => a.method === "museHolderDrop" || a.method === "museDropLook");
      assert.deepEqual([drop.method, drop.args], ["museHolderDrop", [TAG, k.link, k.tok.lima, false]]);
      assert.deepEqual(holdersIn(k.w, "lima"), ["uuuuuuuuuuuuuuuuuuuuuU"], "only this call's hold went");
      assert.equal(hookIn(k.w, "lima").link, k.link, "the hook stays for the other holder");
    } finally {
      k.b.restore();
    }
  }
});

test("a tag and pre on an entry recording a Muse wake survive every write of the list: the own write, a mark, the leave's mark", async () => {
  const k = await museKeyed(["lima", "oslo"]);
  try {
    for (const n of ["lima", "oslo"]) k.w.harness(n).room.access(k.tok[n], false);
    await editStored(k.w, k.key, (rooms) => rooms.map((e) => ({ ...e, tag: e.room === "lima" ? TAG : "uuuuuuuuuuuuuuuuuuuuuU", pre: true })));
    assert.equal(result(await mcp(k.w, call("muse_register", { code: k.code }), auth(k.key))).structuredContent.results.every((x) => x.ok), true);
    const tagsOf = async () => (await storedOf(k.w, k.key)).rooms.map((e) => [e.room, e.tag, e.pre, (e.hooks || []).length, e.state]);
    assert.deepEqual(await tagsOf(), [["lima", TAG, true, 1, "held"], ["oslo", "uuuuuuuuuuuuuuuuuuuuuU", true, 1, "held"]]);
    // a mark: oslo revoked by the owner
    k.w.harness("oslo").room.revoke(k.tok.oslo);
    await mcp(k.w, call("whoami", { room: "oslo" }), auth(k.key));
    assert.deepEqual((await tagsOf())[1], ["oslo", "uuuuuuuuuuuuuuuuuuuuuU", true, 1, "refused"]);
    assert.deepEqual((await tagsOf())[0], ["lima", TAG, true, 1, "held"]);
  } finally {
    k.b.restore();
  }
});

// No write of a key's list in this Worker changes a tag, so no behaviour
// shows tagsKept missing from one: every write that keepsWakes checks
// (rewrite, the disconnect's remainder; its deletion leaves no entry) also
// goes through tagsKept, on the same two lists, read off the source.
import { readFileSync } from "node:fs";
test("every write of a key's list that keepsWakes checks goes through tagsKept too, on the same lists", () => {
  const src = readFileSync(new URL("../../worker/routes/agent.ts", import.meta.url), "utf8");
  const calls = [...src.matchAll(/^\s*keepsWakes\(([^,]+), ([^,]+), ([^,]+), [^\n]*\);\n\s*(.*)$/gm)];
  const writes = calls.filter((m) => m[3] !== "[]");
  assert.ok(writes.length >= 2, "found the checked writes: " + calls.length);
  for (const m of writes) assert.equal(m[4], "tagsKept(" + m[2] + ", " + m[3] + ");", "after keepsWakes(" + m[1] + ", " + m[2] + ", " + m[3] + ", ...)");
});
