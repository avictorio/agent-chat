// Match clocks on the real Room class (room-harness.mjs): what a deadline
// that has passed but has not been settled yet does to the calls that
// arrive before the alarm (cancel, accept), how a late clock advances, and
// how the alarm backs off a match whose clock work keeps throwing.
import test from "node:test";
import assert from "node:assert/strict";
import { makeRoom } from "./room-harness.mjs";

const R = "unit";

/** a running match of game between names, every seat accepted */
async function running(game, names, opts = {}) {
  const h = makeRoom();
  for (const n of names) h.member(n);
  const c = await h.room.createGame(names[0], names, { game, ...opts }, R);
  assert.equal(c.status, 201, c.error);
  for (const n of names.slice(1)) assert.equal((await h.room.gameAccept(c.game.id, n, R)).status, 200);
  const id = c.game.id;
  const stored = () => JSON.parse(h.room.sql.exec("SELECT state FROM gm WHERE id = ?", id).one().state);
  const status = () => h.room.sql.exec("SELECT status FROM gm WHERE id = ?", id).one().status;
  /** rewrite the stored state (as the game-expire test hook does) */
  const edit = (fn) => { const g = h.room.gameRow(id); fn(g.st); h.room.saveGame(g); };
  const posts = () => h.all("SELECT text FROM m WHERE sender = 'Referee'").map((r) => r.text);
  return { h, id, stored, status, edit, posts };
}

test("cancelling a duel the deadline has already decided answers 409 finished, with the result posted", async () => {
  const { h, id, stored, status, edit, posts } = await running("duel", ["Poc", "Rex"], { best_of: 1 });
  assert.equal((await h.room.gameMove(id, "Rex", "rock", R)).status, 200);
  // the round clock runs out with only Rex's throw in, before the alarm runs
  edit((st) => { st.deadline = Date.now() - 1; });
  const r = await h.room.gameCancel(id, "Poc", false, R);
  assert.equal(r.status, 409, JSON.stringify(r));
  assert.equal(status(), "finished");
  assert.equal(stored().winner, "Rex");
  assert.equal(posts().filter((t) => /is over/.test(t)).length, 1, "the result is posted once: " + JSON.stringify(posts()));
});

test("a cancel before the deadline still calls the match off", async () => {
  const { h, id, status } = await running("duel", ["Poc", "Rex"], { best_of: 1 });
  assert.equal((await h.room.gameMove(id, "Rex", "rock", R)).status, 200);
  const r = await h.room.gameCancel(id, "Poc", false, R);
  assert.equal(r.status, 200, r.error);
  assert.equal(status(), "cancelled");
});

test("a match whose clock work throws can still be cancelled", async () => {
  const { h, id, status, edit } = await running("duel", ["Poc", "Rex"], { best_of: 1 });
  assert.equal((await h.room.gameMove(id, "Rex", "rock", R)).status, 200);
  edit((st) => { st.deadline = Date.now() - 1; });
  // the duel's clock work fails (a bug, a save that does not fit)
  h.room.advanceDuel = () => { throw new Error("broken clock"); };
  const r = await h.room.gameCancel(id, "Poc", true, R);
  assert.equal(r.status, 200, r.error);
  assert.equal(status(), "cancelled");
});

test("re-accepting a running match settles the clock first", async () => {
  const { h, id, status, edit } = await running("duel", ["Poc", "Rex"], { best_of: 3 });
  // round 1 goes by unthrown: the duel is called off at the deadline
  edit((st) => { st.deadline = Date.now() - 1; });
  const r = await h.room.gameAccept(id, "Rex", R);
  assert.equal(r.status, 409, "the deadline ended the match: " + JSON.stringify(r).slice(0, 200));
  assert.equal(status(), "cancelled");
});

test("re-accepting a running match re-arms the clock", async () => {
  const { h, id, stored } = await running("duel", ["Poc", "Rex"]);
  const armed = [];
  h.room.ctx.storage.setAlarm = async (t) => { armed.push(t); };
  const r = await h.room.gameAccept(id, "Rex", R);
  assert.equal(r.status, 200, r.error);
  assert.equal(r.game.status, "running");
  assert.deepEqual(armed, [stored().deadline]);
});

test("a Light Cycles clock running 65 s late resolves one tick and gives the next a full clock", async () => {
  const { h, id, stored, edit } = await running("lightcycles", ["Ann", "Bob"], { tick_seconds: 30 });
  edit((st) => { st.deadline = Date.now() - 65000; });
  const r = await h.room.gameState(id, "Ann", R);
  assert.equal(r.status, 200, r.error);
  const st = stored();
  assert.equal(st.tick, 1, "one tick, not the three the late clock spanned");
  assert.ok(st.players.every((p) => p.alive), "nobody taken out for windows that were never open");
  assert.ok(st.deadline >= Date.now() + 29000, "the next tick's window opens now: " + (st.deadline - Date.now()));
  // the alarm, running late as well, does the same
  edit((s) => { s.deadline = Date.now() - 65000; });
  await h.room.alarm();
  assert.equal(stored().tick, 2);
});

test("a Battleship clock running late settles one turn: no misses for turns never announced", async () => {
  const { h, id, stored, status, edit } = await running("battleship", ["Ann", "Bob"], { tick_seconds: 30 });
  // the placement clock ran out 125 s ago: the fleets are placed and play opens, nothing more
  edit((st) => { st.deadline = Date.now() - 125000; });
  await h.room.gameState(id, "Ann", R);
  let st = stored();
  assert.equal(status(), "running");
  assert.equal(st.phase, "play");
  assert.deepEqual(st.misses || {}, {}, "no turn was announced yet, so nobody missed one");
  assert.ok(st.deadline >= Date.now() + 29000);
  // the first turn's clock runs 125 s late: one miss for the captain to move, and the turn passes
  const first = st.turn_of;
  edit((s) => { s.deadline = Date.now() - 125000; });
  await h.room.alarm();
  st = stored();
  assert.equal(status(), "running");
  assert.deepEqual(st.misses, { [first]: 1 });
  assert.notEqual(st.turn_of, first);
});
