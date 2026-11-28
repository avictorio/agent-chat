// How big whats_waiting's answer gets on a key holding AGENT_ROOMS_MAX
// rooms, built by the real code (worker/routes/agent.ts) over real rooms on
// node:sqlite (agent-world.mjs): every room as full as an agent's
// room_state gets - its name and the room's at their longest, a digest due,
// a match owing its move, a decision to sign and a question it claimed, and
// messages from others since its last post - so STATE_ITEMS items wait in
// each, with more besides. The answer's JSON (what its text carries) must
// stay under 60,000 characters, a size an agent's context takes in one
// result, and the sealed list under 8 KB. Prints both. Run with
// `npm run test:unit`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeWorld, read, agentInvite } from "./agent-world.mjs";
import { agentCreateRoute, agentMcpRoute } from "../../worker/routes/agent.ts";
import { AGENT_ROOMS_MAX, STATE_ITEMS } from "../../worker/limits.ts";
import { MAX_NAME } from "../../worker/lib/text.ts";
import { b64urlDecode } from "../../worker/lib/crypto.ts";

const fit = (s, n) => (s + "-".repeat(n)).slice(0, n);

test("whats_waiting on AGENT_ROOMS_MAX full rooms: its JSON under 60,000 characters, the sealed list under 8 KB", async () => {
  const w = makeWorld();
  const agent = fit("Hank Hawthorne the Longest Named Agent", MAX_NAME);
  const person = fit("Patricia Quinn the Longest Named Person", MAX_NAME);
  const entries = [];
  for (let i = 0; i < AGENT_ROOMS_MAX; i++) {
    const room = fit("room-" + i + "-with-a-name-as-long-as-room-names-are-allowed-to-be", 64);
    const h = w.room(room);
    const tok = agentInvite(h, agent);
    h.room.access(agentInvite(h, person, "human"), false);
    h.room.access(tok, false);
    // the agent has posted (so the digest is its turn), others since
    await h.room.post(agent, "Hello from the agent.", room, false, null, null, null, false);
    for (let m = 0; m < 5; m++) await h.room.post(person, "@" + agent + " a message for you, number " + m, room, false, null, null, null, false);
    const made = await h.room.createGame(person, [person, agent], { game: "duel" }, room);
    assert.equal((await h.room.gameAccept(made.game.id, agent, room)).game.status, "running");
    h.room.addDecision(fit("Book the hotel by the harbour for the whole week of the trip", 300), "", person);
    h.room.updateQuestion(h.room.addQuestion(fit("Which day do we take the train up the valley and back", 500), person).id, "claim", agent, null);
    entries.push({ room, token: tok });
  }
  const r = await read(agentCreateRoute(w.rc("POST", "/api/agents", { json: { rooms: entries }, headers: { "CF-Connecting-IP": "10.4.0.1" } })));
  assert.equal(r.status, 201, r.text.slice(0, 300));
  const sealed = b64urlDecode(w.harness(w.identities()[0]).one("SELECT ring FROM ak").ring).length;
  const g = await read(agentMcpRoute(w.rc("POST", "/api/mcp", { json: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "whats_waiting", arguments: {} } }, headers: { Authorization: "Bearer " + r.json.key } })));
  const out = g.json.result.structuredContent;
  assert.equal(out.rooms.length, AGENT_ROOMS_MAX);
  assert.deepEqual(out.refused, []);
  for (const x of out.rooms) {
    assert.deepEqual(x.awaiting.map((i) => i.type), ["digest", "game", "decision"], "STATE_ITEMS items in each room");
    assert.equal(x.awaiting.length, STATE_ITEMS);
    assert.ok(x.awaiting_more >= 1, "and more besides");
    assert.ok(x.since.count >= 5 && x.since.for_you >= 5);
    for (const i of x.awaiting) assert.equal(i.mcp_call.arguments.room, x.room);
  }
  const text = g.json.result.content[0].text.length;
  console.log("whats_waiting on " + AGENT_ROOMS_MAX + " full rooms: its JSON " + text + " characters (the whole JSON-RPC answer, which carries it as text and as structuredContent, " + g.text.length + "); the sealed list " + sealed + " bytes");
  assert.ok(text < 60000, "whats_waiting's JSON is " + text + " characters on " + AGENT_ROOMS_MAX + " rooms");
  assert.ok(sealed < 8192, "the sealed list is " + sealed + " bytes on " + AGENT_ROOMS_MAX + " rooms");
});

// The sealed lists' sizes with every entry of a full key or sign-in at the
// wake bound: AGENT_ROOMS_MAX rooms, each name and token at its longest,
// each refused (a code and a time besides), each with its holder tag (22
// characters) and pre, its name MAX_NAME three-byte characters (the most
// UTF-8 a stored name takes), and each holding AGENT_WAKE_ITEMS_MAX links
// and outstanding recordings together, in every split (k links, the rest
// recordings), every link at the longest a key records (AGENT_WAKE_LINK_MAX:
// a longer one is neither recorded nor set) and at the bridge's own length.
// For a sign-in, its wake list too (wakesOf: each entry's tag in place of
// its token, no name), which its one ak row holds beside the room list.
// Measured on this sealing: the room list at most 24,604 bytes, the wake
// list at most 19,484, the two together at most 44,088. Printed, and
// bounded: each list under 32,768 and the two together under 49,152, far
// inside SQLite's row and the RPC's limits; the lists go into one row and
// one RPC with each change, and into each call's memory.
import { agentDataKey, agentSealRing, agentSealWakes, newAgentKey, newRecordingId, newHolderTag, newKeyBytes, wakesOf } from "../../worker/lib/agentkey.ts";
import { AGENT_WAKE_ITEMS_MAX, AGENT_WAKE_LINK_MAX } from "../../worker/limits.ts";
import { wakeWeight } from "../../worker/lib/wakes.ts";

test("the sealed lists of a full key or sign-in with every entry at the wake bound, tagged, with pre and the longest names: printed; each under 32,768 bytes, the two together under 49,152", async () => {
  const k = newAgentKey();
  const { dk } = await agentDataKey(k.id, k.secret);
  const wk = newKeyBytes();
  const at = Date.now();
  const sizes = {};
  for (const [what, len] of [["the bridge's links", ("ml_" + "0".repeat(32)).length], ["the longest links a key records", AGENT_WAKE_LINK_MAX]]) {
    for (let links = 1; links <= AGENT_WAKE_ITEMS_MAX; links++) {
      const rooms = Array.from({ length: AGENT_ROOMS_MAX }, (_, i) => ({
        room: fit("room-" + i + "-with-a-name-as-long-as-room-names-are-allowed-to-be", 64),
        token: fit("tok" + i + "-xxxxxxxxxxxxxxxxxxxxxxxx", 24),
        name: "漢".repeat(MAX_NAME),
        added: at, state: "refused", code: "invite_revoked", at,
        tag: newHolderTag(), pre: true,
        hooks: Array.from({ length: links }, (__, j) => ({
          link: fit("ml_" + i + "_" + j + "_" + "0".repeat(len), len),
          recs: j ? [] : Array.from({ length: AGENT_WAKE_ITEMS_MAX - links }, (___, r) => ({ id: newRecordingId(), deadline: at + 15000 + r })),
        })),
      }));
      assert.equal(wakeWeight(rooms[0]), AGENT_WAKE_ITEMS_MAX);
      const ring = b64urlDecode(await agentSealRing(dk, k.id, 1, rooms)).length;
      const wakes = b64urlDecode(await agentSealWakes(wk, k.id, 1, wakesOf(rooms))).length;
      sizes[what + ", " + links + " links"] = { ring, wakes, both: ring + wakes };
    }
  }
  console.log("the sealed lists on " + AGENT_ROOMS_MAX + " rooms at the wake bound (" + AGENT_WAKE_ITEMS_MAX + " links and recordings each): " + JSON.stringify(sizes) + " bytes");
  for (const [what, n] of Object.entries(sizes)) {
    assert.ok(n.ring < 32768, what + ": the room list " + n.ring + " bytes");
    assert.ok(n.wakes < 32768, what + ": the wake list " + n.wakes + " bytes");
    assert.ok(n.both < 49152, what + ": both " + n.both + " bytes");
  }
});
