// What every answer reached with an agent key gives out (worker/routes/
// agent.ts), over real rooms on node:sqlite (agent-world.mjs): every route,
// every tool of the agent catalog (a call that succeeds where the harness
// can make one, else its error) and the refusals, each scanned for any
// room's invite token, an invite link (#invite=) and an invite note
// (agent_onboarding); and the owner key sent beside an agent key, which
// the agent routes never read: the call acts as the invite's member, and
// nothing the owner key unlocks is reached. Keys and tokens are made here.
// Run with `npm run test:unit`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeWorld, read, agentInvite } from "./agent-world.mjs";
import { agentCreateRoute, agentMcpRoute, agentRemoveRoute, agentRoomsRoute, agentRoute } from "../../worker/routes/agent.ts";
import { mcpAgentCatalog } from "../../worker/agents/mcp.ts";
import { newAgentKey } from "../../worker/lib/agentkey.ts";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAwS2OUAAAAABJRU5ErkJggg==";
const call = (name, args, id = 1) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });

/** rooms lima and oslo, each with the agent Hank on the key, a person Pat who has joined, a message and a decision; rome to add later */
async function world() {
  const w = makeWorld();
  const tok = {};
  for (const n of ["lima", "oslo", "rome"]) {
    const h = w.room(n);
    tok[n] = agentInvite(h, "Hank");
    const pat = agentInvite(h, "Pat", "human");
    h.room.access(pat, false);
    agentInvite(h, "Ada");
    await h.room.post("Pat", "Hello @Hank, see https://example.org/page", n, false, null, null, null, false);
    h.room.addDecision("Book the hotel", "", "Pat");
  }
  const made = await read(agentCreateRoute(w.rc("POST", "/api/agents", { json: { rooms: [{ room: "lima", token: tok.lima }, { room: "oslo", token: tok.oslo }] }, headers: { "CF-Connecting-IP": "10.5.0.1" } })));
  assert.equal(made.status, 201, made.text);
  return { w, tok, key: made.json.key, made };
}
/** every invite token in every room of the world */
const allTokens = (w) => [...w.objects.values()].flatMap((h) => { try { return h.all("SELECT token FROM inv").map((r) => r.token); } catch { return []; /* an object with no invite table */ } });
/** the scan: no token, no link, no note in an answer's text (the key itself left out) */
function clean(w, what, text, key) {
  const t = key ? text.split(key).join("<KEY>") : text;
  for (const tok of allTokens(w)) assert.ok(!t.includes(tok), what + " carries a room's token");
  // an invite link with its token (the catalog says where a token is found: "the text after #invite=")
  assert.ok(!/#invite=[A-Za-z0-9_-]/.test(t), what + " carries an invite link");
  assert.ok(!t.includes("agent_onboarding"), what + " carries an invite note");
}

test("no answer reached with a key carries a room's token, an invite link or an invite note: every route, every tool, every refusal", async () => {
  const { w, tok, key, made } = await world();
  const auth = { Authorization: "Bearer " + key };
  const mcp = async (body) => (await read(agentMcpRoute(w.rc("POST", "/api/mcp", { json: body, headers: auth })))).text;
  clean(w, "POST /api/agents", made.text, key);
  assert.equal(made.text.split(key).length, 2, "the key once, and nothing else secret");
  // every tool of the catalog, the room ones in lima, in an order the harness can serve
  const room = (args) => ({ room: "lima", ...args });
  const calls = [
    ["list_rooms", {}], ["whats_waiting", {}],
    ["whoami", room({})], ["get_invite", room({})], ["get_start_page", room({})], ["get_room_state", room({})], ["list_messages", room({})], ["list_attachments", room({})],
    ["post_message", room({ text: "through the key", client_msg_id: "k1" })], ["publish_message", room({ id: 999 })], ["delete_message", room({ id: 999 })],
    ["react", room({ id: 1, reaction: "like" })], ["get_reactions", room({ id: 1 })], ["get_members", room({})], ["get_board", room({})], ["get_constitution", room({})],
    ["set_constitution", room({ text: "We plan the trip." })], ["get_decisions", room({})], ["create_decision", room({ title: "Take the train" })],
    ["decision_action", room({ id: 1, action: "sign" })], ["get_questions", room({})], ["ask_question", room({ text: "Which day?" })],
    ["question_action", room({ id: 1, action: "claim" })], ["get_stakes", room({})], ["create_stake", room({ title: "Tickets", date: "2027-01-01" })],
    ["stake_action", room({ id: 1, action: "done" })], ["get_digests", room({})], ["file_digest", room({ text: "Today the room planned a trip." })],
    ["edit_digest", room({ id: 1, text: "Today the room planned a trip, and more." })], ["delete_digest", room({ id: 999 })],
    ["fetch_url", room({ url: "http://127.0.0.1/" })], ["list_games", room({})], ["create_game", room({ players: ["Hank", "Pat"], game: "duel" })],
    ["get_game", room({ id: 1 })], ["accept_game", room({ id: 1 })], ["submit_move", room({ id: 1, dir: "rock", turn: 1 })], ["cancel_game", room({ id: 999 })],
    ["decline_game", room({ id: 999 })], ["speak_message", room({ id: 1 })], ["get_voice", room({})],
    ["begin_upload", room({ kind: "image" })], ["begin_upload", room({ kind: "file", size: 20000000, name: "big.bin", type: "application/octet-stream" })],
    ["attach_media", room({ id: 2, kind: "image", base64: PNG })],
    ["add_room", { room: "rome", token: tok.rome }], ["remove_room", { room: "rome" }],
    ["leave_room", room({ confirm: "not-this-room" })],
  ];
  const named = new Set(calls.map(([n]) => n));
  for (const t of mcpAgentCatalog()) assert.ok(named.has(t.name), t.name + " is not called here");
  let worked = 0;
  for (const [name, args] of calls) {
    const text = await mcp(call(name, args));
    clean(w, name, text);
    if (!JSON.parse(text).result.isError) worked++;
  }
  assert.ok(worked >= 35, worked + " of " + calls.length + " calls succeeded");
  // a room refusal through the key, the leave itself, and the room tools' own refusals
  w.harness("oslo").room.revoke(tok.oslo);
  for (const body of [call("whoami", { room: "oslo" }), call("get_start_page", { room: "oslo" }), call("whats_waiting", {}), call("list_rooms", {}), call("whoami", { room: "rome" }), call("whoami", {}), call("no_such_tool", { room: "lima" }), call("add_room", { room: "oslo", token: tok.oslo }), call("add_room", { room: "lima", token: "tok-not-limas-0123456789" })]) clean(w, JSON.stringify(body.params).slice(0, 50), await mcp(body));
  clean(w, "leave_room", await mcp(call("leave_room", { room: "lima", confirm: "lima" })));
  // the initialize kind's and the per-request kind's other answers
  for (const body of [{ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, { jsonrpc: "2.0", id: 1, method: "tools/list" }]) clean(w, body.method, await mcp(body));
  // the REST routes, their answers and their refusals
  const rest = [
    agentRoute(w.rc("GET", "/api/agent", { headers: auth })),
    agentRoomsRoute(w.rc("POST", "/api/agent/rooms", { headers: auth, json: { rooms: [{ room: "rome", token: tok.rome }] } })),
    agentRoomsRoute(w.rc("POST", "/api/agent/rooms", { headers: auth, json: { rooms: [{ room: "rome", token: tok.rome }] } })),
    agentRoomsRoute(w.rc("POST", "/api/agent/rooms", { headers: auth, json: { rooms: [{ room: "nowhere", token: tok.rome }] } })),
    agentRemoveRoute(w.rc("POST", "/api/agent/rooms/remove", { headers: auth, json: { room: "rome" } })),
    agentRemoveRoute(w.rc("POST", "/api/agent/rooms/remove", { headers: auth, json: { room: "rome" } })),
    agentRoute(w.rc("GET", "/api/agent", { headers: { Authorization: "Bearer " + tok.lima } })),
    agentRoute(w.rc("GET", "/api/agent", { headers: { Authorization: "Bearer " + newAgentKey().key } })),
    agentCreateRoute(w.rc("POST", "/api/agents", { json: { rooms: [{ room: "lima", token: tok.lima }] } })),
    agentCreateRoute(w.rc("POST", "/api/agents", { json: { rooms: [{ room: "rome", token: tok.rome }, { room: "oslo", token: tok.oslo }] } })),
  ];
  for (const [i, p] of rest.entries()) { const r = await read(p); clean(w, "REST answer " + i, r.text, r.json && r.json.key); }
  const gone = await read(agentRoute(w.rc("DELETE", "/api/agent", { headers: auth })));
  assert.equal(gone.status, 200);
  clean(w, "DELETE /api/agent", gone.text);
});

test("the owner key beside an agent key is not read: the call acts as the invite's member, and nothing the owner key unlocks is reached", async () => {
  const { w, tok, key } = await world();
  const owner = (method, path, o = {}) => w.rc(method, path, { ...o, owner: true, headers: { Authorization: "Bearer " + key, ...(o.headers || {}) } });
  const mcp = async (body) => (await read(agentMcpRoute(owner("POST", "/api/mcp", { json: body })))).json.result;
  let r = await mcp(call("whoami", { room: "lima" }));
  assert.equal(r.structuredContent.owner, false);
  assert.equal(r.structuredContent.name, "Hank");
  r = await mcp(call("post_message", { room: "lima", text: "as whom?", as: "Pat", from: "Pat" }));
  assert.equal(r.structuredContent.from, "Hank", "the post goes out under the invite's name");
  assert.equal(w.harness("lima").one("SELECT sender FROM m WHERE text = 'as whom?'").sender, "Hank");
  // the owner key gets every member's link and note; through the key, none
  r = await mcp(call("get_members", { room: "lima" }));
  for (const m of r.structuredContent.members) assert.ok(!("invite_link" in m) && !("agent_onboarding" in m), m.name);
  // the owner key may delete any message and cancel any match; through the key, only the agent's own
  const patMsg = w.harness("lima").one("SELECT id FROM m WHERE sender = 'Pat'").id;
  r = await mcp(call("delete_message", { room: "lima", id: patMsg }));
  assert.equal(r.isError, true, "another member's message stays");
  assert.ok(w.harness("lima").one("SELECT id FROM m WHERE id = ?", patMsg));
  const g = await w.harness("lima").room.createGame("Pat", ["Pat", "Hank"], { game: "duel" }, "lima");
  assert.ok(g.game, JSON.stringify(g).slice(0, 160));
  r = await mcp(call("cancel_game", { room: "lima", id: g.game.id }));
  assert.equal(r.isError, true, "another member's match stays");
  // the start page is the invite's, with no owner-key line
  r = await mcp(call("get_start_page", { room: "lima" }));
  assert.ok(!r.content[0].text.includes("also carried the owner key"));
  // the REST routes: the owner key is no key, and lets no wrong token through
  const noKey = await read(agentRoute(w.rc("GET", "/api/agent", { owner: true })));
  assert.equal(noKey.status, 401);
  assert.equal(noKey.json.code, "agent_key_missing");
  const make = await read(agentCreateRoute(w.rc("POST", "/api/agents", { owner: true, json: { rooms: [{ room: "lima", token: "tok-not-limas-0123456789" }] } })));
  assert.equal(make.status, 403);
  assert.equal(make.json.code, "invite_invalid");
  const add = await read(agentRoomsRoute(owner("POST", "/api/agent/rooms", { json: { rooms: [{ room: "rome", token: "tok-not-romes-0123456789" }] } })));
  assert.equal(add.status, 403);
  assert.equal(add.json.code, "invite_invalid");
  assert.ok(tok.rome);
  // initialize's instructions are the key's, never the owner key's
  const init = (await read(agentMcpRoute(owner("POST", "/api/mcp", { json: { jsonrpc: "2.0", id: 1, method: "initialize", params: {} } })))).json.result;
  assert.match(init.instructions, /^All your Agent Chat rooms as tools, through your agent key\./);
});
