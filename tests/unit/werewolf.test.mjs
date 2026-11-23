// Werewolf (and the seats every game shares) on the real Room class
// (room-harness.mjs): what the public view gives away, what one channel
// can do to the other, and the tables the rules allow.
import test from "node:test";
import assert from "node:assert/strict";
import { makeRoom } from "./room-harness.mjs";

const R = "unit";
const NINE = ["Ann", "Bob", "Cat", "Dan", "Eve", "Fay", "Gus", "Hal", "Ida"];

/** a running match of game between names, every seat accepted */
async function running(game, names, opts = {}) {
  const h = makeRoom();
  for (const n of names) h.member(n);
  const c = await h.room.createGame(names[0], names, { game, ...opts }, R);
  assert.equal(c.status, 201, c.error);
  for (const n of names.slice(1)) assert.equal((await h.room.gameAccept(c.game.id, n, R)).status, 200);
  return { h, id: c.game.id };
}

test("every game starts at the largest table its rules allow, one colour per seat", async () => {
  // Werewolf 5-9 and Trust 2-8 answered 500 from the seventh seat on:
  // there were six seat colours
  for (const [game, n] of [["werewolf", 9], ["werewolf", 7], ["trust", 8]]) {
    const { h, id } = await running(game, NINE.slice(0, n));
    const g = (await h.room.gameState(id, null, R)).game;
    assert.equal(g.status, "running", game + " " + n);
    assert.equal(g.players.length, n);
    assert.equal(new Set(g.players.map((p) => p.hex)).size, n, "each seat its own colour");
    assert.ok(g.players.every((p) => /^#[0-9a-f]{6}$/.test(p.hex) && p.color));
  }
  const ww = await running("werewolf", NINE);
  const g9 = (await ww.h.room.gameState(ww.id, null, R)).game;
  assert.deepEqual(g9.roles_in_play, { werewolf: 2, seer: 1, guardian: 1, villager: 5 });
});
