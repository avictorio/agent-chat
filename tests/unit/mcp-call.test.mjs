// mcp_call (worker/agents/mcp.ts mcpCallOf, withMcpCalls): over MCP each
// room_state.awaiting_you item carries the tool call that does what its
// REST call does. Every kind of item room_state makes maps to a tool in the
// catalog, with arguments its inputSchema takes; a call no tool makes gets
// none; the block passed in is left as it was. Run with `npm run test:unit`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mcpCallOf, mcpCatalog, withMcpCalls } from "../../worker/agents/mcp.ts";
import { renderRoomState, stateCall } from "../../worker/room/state.ts";

const room = "unit";
const cat = new Map(mcpCatalog().map((t) => [t.name, t]));
/** one item of each kind stateAttempt makes, a move with and without its turn */
const ITEMS = [
  [{ type: "digest", action: "file", call: stateCall(room, "digests", { from: "Scout", text: "<your digest of the day>" }) }, "file_digest", { text: "<your digest of the day>" }],
  [{ type: "game", id: 3, turn: "lobby", action: "accept", call: stateCall(room, "games/3/accept", { from: "Scout" }) }, "accept_game", { id: 3 }],
  [{ type: "game", id: 4, turn: 2, action: "move", call: stateCall(room, "games/4/moves", { from: "Scout", dir: "<rock|paper|scissors>", turn: 2 }) }, "submit_move", { id: 4, dir: "<rock|paper|scissors>", turn: 2 }],
  [{ type: "game", id: 5, turn: 14, action: "move", call: stateCall(room, "games/5/moves", { from: "Scout", dir: "<up|down|left|right>" }) }, "submit_move", { id: 5, dir: "<up|down|left|right>" }],
  [{ type: "decision", id: 6, action: "sign", call: stateCall(room, "decisions/6", { from: "Scout", action: "sign", base_updated: 1795640441942 }) }, "decision_action", { id: 6, action: "sign", base_updated: 1795640441942 }],
  [{ type: "question", id: 7, action: "resolve", call: stateCall(room, "questions/7", { from: "Scout", action: "resolve", note: "<how it was resolved>", base_updated: 1795640441942 }) }, "question_action", { id: 7, action: "resolve", note: "<how it was resolved>", base_updated: 1795640441942 }],
  [{ type: "tool_fetch", id: 8, action: "fetch", call: stateCall(room, "tools/fetch", { from: "Scout", url: "https://example.org/a", post: true }) }, "fetch_url", { url: "https://example.org/a", post: true }],
];

/** the call fits its tool: the tool exists, takes every argument, gets every required one, and none is from */
function fits(m, what) {
  const t = cat.get(m.tool);
  assert.ok(t, what + ": no tool " + m.tool);
  assert.ok(!("from" in m.arguments), what + ": carries from");
  for (const k of Object.keys(m.arguments)) assert.ok(k in t.inputSchema.properties, what + ": " + m.tool + " takes no argument " + k);
  for (const r of t.inputSchema.required) assert.ok(r in m.arguments, what + ": " + m.tool + " needs " + r);
}

test("each kind of item maps to its tool, with the body as arguments, the id first, and no from", () => {
  for (const [item, tool, args] of ITEMS) {
    const m = mcpCallOf(item);
    assert.deepEqual(m, { tool, arguments: args }, item.type + " " + item.action);
    assert.deepEqual(Object.keys(m.arguments), Object.keys(args), "the order: the id, then the body's");
    fits(m, item.type + " " + item.action);
  }
  // a tool_fetch item's id is a message's, not an argument
  assert.ok(!("id" in mcpCallOf(ITEMS[6][0]).arguments));
});

test("for the owner key, each call also carries the name it acts as", () => {
  for (const [item] of ITEMS) {
    const m = mcpCallOf(item, "Scout");
    assert.equal(m.arguments.as, "Scout");
    assert.equal(Object.keys(m.arguments).at(-1), "as");
    fits(m, item.type + " as the owner");
  }
});

test("a call no tool makes gets none, and its item is left as it is", () => {
  const odd = { type: "digest", action: "file", call: stateCall(room, "nothing/1", { from: "Scout" }) };
  assert.equal(mcpCallOf(odd), null);
  const s = { v: 1, awaiting_you: [odd, ITEMS[1][0]] };
  const out = withMcpCalls(s);
  assert.equal(out.awaiting_you[0], odd, "no mcp_call");
  assert.deepEqual(out.awaiting_you[1].mcp_call, { tool: "accept_game", arguments: { id: 3 } });
});

test("withMcpCalls returns a copy with mcp_call last in each item, and leaves a block without items alone", () => {
  const items = ITEMS.map(([i]) => i);
  const s = { v: 1, board_rev: 4, awaiting_you: items, awaiting_you_more: 2, memory: { latest_digest_day: null, latest_digest_by: null, digests_today: 0 } };
  const before = JSON.stringify(s);
  const out = withMcpCalls(s, "Scout");
  assert.equal(JSON.stringify(s), before, "the block passed in is unchanged");
  assert.notEqual(out, s);
  assert.deepEqual(Object.keys(out), Object.keys(s), "the block's keys keep their order");
  assert.equal(out.awaiting_you_more, 2);
  out.awaiting_you.forEach((i, n) => {
    assert.deepEqual(Object.keys(i), [...Object.keys(items[n]), "mcp_call"]);
    assert.deepEqual(i.mcp_call, mcpCallOf(items[n], "Scout"));
  });
  assert.equal(withMcpCalls(undefined), undefined);
  const quiet = { v: 1, board_rev: 2 };
  assert.equal(withMcpCalls(quiet), quiet);
});

// The kinds room_state makes, rendered from a hand-made room, one kind at a
// time (the list is cut to STATE_ITEMS): a digest due, a lobby, a running
// Duel, a live Light Cycles race, an unsigned decision, a claimed question
// and a link to fetch. A new kind needs its MCP_BY_PATH row.
test("every item room_state makes gets an mcp_call that fits its tool", () => {
  const quiet = {
    members: ["Scout", "Anthony"], humans: ["anthony"], constitution: null, questions: [], decisions: [], stakes: [], digest: null, digests_today: 0,
    awaiting_digest: null, digest_due_at: "2026-11-27T08:00:00Z", fetches_used: 0, recent: [], fetched: [], rx: [], games: [], board_rev: 3,
  };
  const seat = (accepted, moved) => ({ name: "Scout", alive: true, moved, accepted });
  const rooms = [
    { awaiting_digest: "Scout" },
    { games: [{ id: 3, type: "duel", status: "lobby", round: 1, players: [seat(false, false)] }] },
    { games: [{ id: 4, type: "duel", status: "running", round: 2, players: [seat(true, false)] }] },
    { games: [{ id: 5, type: "lightcycles", status: "running", tick: 14, mode: "live", players: [seat(true, false)] }] },
    { decisions: [{ id: 1, title: "Book it", signed_by: ["Anthony"], missing: ["Scout"], updated: 1795640441000 }] },
    { questions: [{ id: 2, text: "Which hotel?", added_by: "Anthony", claimed_by: "Scout", updated: 1795640441942 }] },
    { recent: [{ id: 9, sender: "Anthony", text: "see https://example.org/lima-hotels" }] },
  ];
  const made = [];
  for (const over of rooms) {
    const s = renderRoomState({ ...quiet, ...over }, "Scout", room);
    assert.equal((s.awaiting_you || []).length, 1, JSON.stringify(over));
    const out = withMcpCalls(s);
    assert.ok(!("mcp_call" in s.awaiting_you[0]), "the rendered block itself carries none");
    const i = out.awaiting_you[0];
    made.push(i.type + "/" + i.action);
    assert.ok(i.mcp_call, i.type + "/" + i.action + " has no mcp_call: add its MCP_BY_PATH row");
    fits(i.mcp_call, i.type + "/" + i.action);
    if (i.id === 5) assert.ok(!("turn" in i.mcp_call.arguments), "a live race's move carries no turn, as its call does not");
    if (i.id === 4) assert.equal(i.mcp_call.arguments.turn, 2);
  }
  assert.deepEqual([...new Set(made)].sort(), ["decision/sign", "digest/file", "game/accept", "game/move", "question/resolve", "tool_fetch/fetch"]);
});
