// Engines doing what their rules say, on the real Room class
// (room-harness.mjs): each test is a move or an ending the engine used to
// get wrong while answering 200.
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
  return { h, id: c.game.id };
}

test("a dir that is an object or a list is refused with 400, and the turn is not spent", async () => {
  const { h, id } = await running("corpse", ["Ann", "Bob", "Cat"], { rotations: 1 });
  const writer = h.room.gameRow(id).st.writer;
  for (const dir of [{ text: "It was a dark night." }, ["The rain fell.", "A door creaked."]]) {
    const r = await h.room.gameMove(id, writer, dir, R);
    assert.equal(r.status, 400, JSON.stringify(dir) + " answered " + r.status);
    assert.match(r.error, /dir is your move as text/);
  }
  const st = h.room.gameRow(id).st;
  assert.equal(st.segments.length, 0, "nothing was stored");
  assert.equal(st.writer, writer, "still the same writer's turn");
  const ok = await h.room.gameMove(id, writer, "The rain fell. A door creaked.", R);
  assert.equal(ok.status, 200, ok.error);
  assert.equal(h.room.gameRow(id).st.segments[0].text, "The rain fell. A door creaked.");
  // the same check stands in front of every engine, numbers still pass
  const c4 = await running("fourinarow", ["Ann", "Bob"]);
  const first = c4.h.room.gameRow(c4.id).st.turn_of;
  assert.equal((await c4.h.room.gameMove(c4.id, first, [4], R)).status, 400);
  assert.equal((await c4.h.room.gameMove(c4.id, first, 4, R)).status, 200);
  const fl = await running("frontlines", ["Ann", "Bob"]);
  assert.equal((await fl.h.room.gameMove(fl.id, "Ann", [20, 20, 20, 20, 20], R)).status, 400);
  assert.equal((await fl.h.room.gameMove(fl.id, "Ann", "20,20,20,20,20", R)).status, 200);
});

test("Trust refuses a second bare C or D instead of letting the last one win", async () => {
  const { h, id } = await running("trust", ["Aa", "Bb", "Cc"]);
  for (const dir of ["C, D", "D, C", "C, C"]) {
    const r = await h.room.gameMove(id, "Aa", dir, R);
    assert.equal(r.status, 400, dir + " answered " + r.status);
    assert.match(r.error, /one C or D for everyone only/);
  }
  assert.equal(h.room.gameRow(id).st.pending.Aa, undefined, "nothing was queued");
  const ok = await h.room.gameMove(id, "Aa", "C, Cc:D", R);
  assert.equal(ok.status, 200, ok.error);
  assert.deepEqual(ok.game.you.queued, { Bb: "C", Cc: "D" });
  assert.deepEqual((await h.room.gameMove(id, "Bb", "Aa:C, Cc:D", R)).game.you.queued, { Aa: "C", Cc: "D" });
});
