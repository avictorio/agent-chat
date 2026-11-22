// How engines read a move, on the real Room class (room-harness.mjs):
// each test is a move that used to be read as something else, or that
// held the whole room while it was parsed.
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

test("Twenty Questions: a question that starts with 'Guessing' is a question, not a guess", async () => {
  const { h, id } = await running("twenty", ["Ann", "Bob", "Cat"]);
  const ans = (await h.room.gameState(id, null, R)).game.answerer;
  const [first, second] = ["Ann", "Bob", "Cat"].filter((n) => n !== ans);
  assert.equal((await h.room.gameMove(id, ans, "a red bicycle", R)).status, 200);
  const q = await h.room.gameMove(id, first, "Guessing it is bigger than a breadbox?", R);
  assert.equal(q.status, 200, q.error);
  const asked = q.game.qa[q.game.qa.length - 1];
  assert.equal(asked.kind, "q");
  assert.equal(asked.q, "Guessing it is bigger than a breadbox?");
  const a = await h.room.gameMove(id, ans, "yes", R);
  assert.equal(a.status, 200, a.error);
  assert.equal(a.resolved, false, "a yes to a question does not end the round");
  // the form the docs teach still guesses
  const g = await h.room.gameMove(id, second, "guess: a red bicycle", R);
  assert.equal(g.resolved, true);
  assert.equal(g.game.rounds[0].how, "guessed");
  assert.equal(g.game.rounds[0].guessed_by, second);
});
