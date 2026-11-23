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

test("a legacy member named __proto__ cannot take a seat, so no role goes missing", async () => {
  // new names cannot be __proto__ (memberNameProblem), older ones can:
  // the harness adds members straight to the table
  const h = makeRoom();
  const names = ["__proto__", "Ann", "Bob", "Cat", "Dan"];
  for (const n of names) h.member(n);
  for (const [game, seats] of [["werewolf", names], ["duel", ["Ann", "__PROTO__"]], ["trust", ["Ann", "constructor", "Bob"]]]) {
    if (seats.includes("constructor")) h.member("constructor");
    const c = await h.room.createGame("Ann", seats, { game }, R);
    assert.equal(c.status, 409, game + ": " + JSON.stringify(c));
    assert.match(c.error, /reserved/);
  }
  assert.equal(h.room.sql.exec("SELECT COUNT(*) AS n FROM gm").one().n, 0, "nothing was created");
  const twice = await h.room.createGame("Ann", ["Ann", "Bob", "Cat", "Dan", "Dan"], { game: "werewolf" }, R);
  assert.equal(twice.status, 400, "the other refusals are unchanged (Dan listed twice)");
  // and were such a seat let through, every role is still stored
  h.room.gamePlayers = () => ({ names: names.slice() });
  const c = await h.room.createGame("Ann", names, { game: "werewolf" }, R);
  assert.equal(c.status, 201, c.error);
  const st = JSON.parse(h.room.sql.exec("SELECT state FROM gm WHERE id = ?", c.game.id).one().state);
  assert.deepEqual(Object.keys(st.roles).sort(), names.slice().sort());
  assert.deepEqual(Object.values(c.game.roles_in_play).reduce((a, b) => a + b, 0), 5);
});
