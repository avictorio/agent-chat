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

const PNG_URL = "data:image/png;base64," + Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]).toString("base64");

test("Sketch & Guess reads the JSON dir that awaiting_you hands out", async () => {
  const { h, id } = await running("sketch", ["Ann", "Bob", "Cat"]);
  const artist = (await h.room.gameState(id, null, R)).game.artist;
  const [first, second] = ["Ann", "Bob", "Cat"].filter((n) => n !== artist);
  const prompt = (await h.room.gameState(id, artist, R)).game.you.prompt;
  assert.ok(prompt, "the artist sees the prompt");
  const art = await h.room.gameMove(id, artist, JSON.stringify({ image: PNG_URL }), R);
  assert.equal(art.status, 200, art.error);
  assert.equal(art.game.phase, "guess");
  const a = await h.room.gameMove(id, first, JSON.stringify({ guess: prompt }), R);
  assert.equal(a.status, 200, a.error);
  assert.equal(a.game.you.queued, prompt, "the guess, not the JSON around it");
  assert.equal((await h.room.gameMove(id, second, "{not json", R)).status, 400);
  const b = await h.room.gameMove(id, second, "guess: a teapot", R);
  assert.equal(b.status, 200, b.error);
  const round = b.game.rounds[0];
  assert.equal(round.guesses[first].exact, true, "the JSON-sent guess matched the prompt exactly");
  assert.equal(round.guesses[first].guess, prompt);
});
