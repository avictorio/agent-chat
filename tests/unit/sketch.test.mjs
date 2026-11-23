// Sketch & Guess on the real Room class (room-harness.mjs): what a draw
// leaves in the bucket, what the Referee is sent and what of its answer is
// kept, the tie-break, and how a drawing's size is judged. Claude is
// stubbed in every test: nothing here calls it.
import test from "node:test";
import assert from "node:assert/strict";
import { makeRoom } from "./room-harness.mjs";

const R = "unit";
const PIC = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const tick = () => new Promise((r) => setTimeout(r, 0));

/** a running Sketch match between names, every seat accepted */
async function running(names, hooks = {}, opts = {}) {
  const h = makeRoom(hooks);
  for (const n of names) h.member(n);
  const c = await h.room.createGame(names[0], names, { game: "sketch", ...opts }, R);
  assert.equal(c.status, 201, c.error);
  for (const n of names.slice(1)) assert.equal((await h.room.gameAccept(c.game.id, n, R)).status, 200);
  return { h, id: c.game.id };
}

const drawings = (h) => [...h.objects.keys()].filter((k) => k.startsWith("games/"));

test("a draw that loses its race deletes the drawing it stored", async () => {
  /** the puts held until the test lets them go */
  const held = [];
  let hold = false;
  const { h, id } = await running(["Ann", "Bob", "Cat"], { put: (key) => (hold && key.startsWith("games/") ? new Promise((r) => held.push(r)) : undefined) });
  const artist = h.room.gameRow(id).st.artist;
  hold = true;
  // the same drawing sent three times at once (an agent retrying)
  const moves = [1, 2, 3].map(() => h.room.gameMove(id, artist, null, R, { image: PIC }));
  while (held.length < 3) await tick();
  hold = false;
  for (const r of held) r();
  const out = await Promise.all(moves);
  assert.deepEqual(out.map((r) => r.status).sort(), [200, 409, 409]);
  const kept = h.room.gameRow(id).st.images[1].key;
  assert.deepEqual(drawings(h), [kept], "only the recorded drawing is in the bucket");

  // and a draw the clock overtakes while it is stored
  const m2 = await running(["Ann", "Bob", "Cat"], { put: (key) => (key.startsWith("games/") ? new Promise((r) => held.push(r)) : undefined) });
  held.length = 0;
  const a2 = m2.h.room.gameRow(m2.id).st.artist;
  const late = m2.h.room.gameMove(m2.id, a2, null, R, { image: PIC });
  while (!held.length) await tick();
  const g = m2.h.room.gameRow(m2.id);
  g.st.deadline = Date.now() - 1;
  m2.h.room.saveGame(g);
  m2.h.room.advanceGame(m2.h.room.gameRow(m2.id), R); // the round is forfeit
  held[0]();
  assert.equal((await late).status, 409);
  assert.deepEqual(drawings(m2.h), [], "the overtaken drawing is gone too");
});
