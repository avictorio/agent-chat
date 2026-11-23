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

/** a 5-seat Werewolf at dawn of day 1: its roles, and one villager already dead */
async function day1() {
  const names = NINE.slice(0, 5);
  const { h, id } = await running("werewolf", names);
  const role = {};
  for (const n of names) role[n] = (await h.room.gameState(id, n, R)).game.you.role;
  const wolf = names.find((n) => role[n] === "werewolf");
  const seer = names.find((n) => role[n] === "seer");
  const vill = names.filter((n) => role[n] === "villager");
  const move = async (who, dir) => {
    const r = await h.room.gameMove(id, who, dir, R);
    assert.equal(r.status, 200, who + " " + dir + ": " + r.error);
    return r;
  };
  for (let i = 0; i < 3; i++) await move(wolf, "den: night plan " + i);
  await move(seer, "check " + wolf);
  assert.equal((await move(wolf, "kill " + vill[2])).game.phase, "day");
  return { h, id, wolf, seer, vill, move };
}

test("the town's numbers count town lines only, whatever the den says", async () => {
  const { h, id, wolf, seer, vill, move } = await day1();
  await move(vill[0], "say: one");
  await move(wolf, "den: they suspect nothing");
  await move(wolf, "den: vote with them");
  await move(seer, "say: two");
  await move(wolf, "say: three");
  // the public view: the games list (what any member reads) and a
  // non-player's state; each town number is the line's place in the town
  const listed = h.room.listGames().games.find((g) => g.id === id);
  const pub = (await h.room.gameState(id, null, R)).game;
  for (const lines of [listed.talk_recent, pub.talk_recent, pub.talk]) assert.deepEqual(lines.map((t) => [t.n, t.text]), [[1, "one"], [2, "two"], [3, "three"]]);
  assert.equal(listed.talk_count, 3);
  assert.equal(listed.den, undefined);
  assert.equal(pub.den, undefined);
  const mine = (await h.room.gameState(id, wolf, R)).game;
  assert.deepEqual(mine.den.map((t) => t.n), [1, 2, 3, 4, 5], "the den is numbered on its own too");
});

test("den lines never push the town's lines out", async () => {
  const { h, id, wolf, vill, move } = await day1();
  await move(vill[0], "say: the seer said it was " + wolf);
  await move(vill[1], "say: agreed");
  // den lines send no frame and nobody else sees them: 600 of them used
  // to cut every town line from the shared 600-line store
  for (let i = 0; i < 650; i++) await move(wolf, "den: x" + i);
  const pub = (await h.room.gameState(id, vill[0], R)).game;
  assert.deepEqual(pub.talk.map((t) => t.text), ["the seer said it was " + wolf, "agreed"]);
  const st = JSON.parse(h.room.sql.exec("SELECT state FROM gm WHERE id = ?", id).one().state);
  assert.equal(st.talk.length, 2);
  assert.equal(st.den.length, 600, "each channel keeps its own 600");
  assert.equal(st.den[599].n, 653, "a den number stays an id once the oldest are cut");
  assert.equal(st.den[599].text, "x649");
});

test("a match stored with both channels in one list still reads, and keeps every line", async () => {
  const { h, id, wolf, vill } = await day1();
  // the shape before den was stored on its own: one list, one counter
  const st = JSON.parse(h.room.sql.exec("SELECT state FROM gm WHERE id = ?", id).one().state);
  const line = (n, by, text, ch) => ({ n, by, text, ch, phase: ch === "den" ? "night" : "day", day: 1, at: 1000 + n });
  st.talk = [line(1, wolf, "d1", "den"), line(2, wolf, "d2", "den"), line(3, vill[0], "t1", "town"), line(4, wolf, "d3", "den"), line(5, vill[1], "t2", "town")];
  delete st.den;
  h.room.sql.exec("UPDATE gm SET state = ? WHERE id = ?", JSON.stringify(st), id);
  const pub = (await h.room.gameState(id, null, R)).game;
  assert.deepEqual(pub.talk.map((t) => [t.n, t.text]), [[1, "t1"], [2, "t2"]], "the town, numbered in its own order");
  assert.equal(pub.den, undefined);
  assert.equal(h.room.listGames().games.find((g) => g.id === id).talk_count, 2);
  const mine = (await h.room.gameState(id, wolf, R)).game;
  assert.deepEqual(mine.den.map((t) => [t.n, t.text]), [[1, "d1"], [2, "d2"], [3, "d3"]]);
  // reading changed nothing stored
  assert.equal(JSON.parse(h.room.sql.exec("SELECT state FROM gm WHERE id = ?", id).one().state).talk.length, 5);
  // the next line follows on in its channel, and the save keeps all six
  const r = await h.room.gameMove(id, vill[0], "say: t3", R);
  assert.equal(r.status, 200, r.error);
  assert.deepEqual(r.game.talk.map((t) => t.n), [1, 2, 3]);
  const after = JSON.parse(h.room.sql.exec("SELECT state FROM gm WHERE id = ?", id).one().state);
  assert.deepEqual(after.talk.map((t) => t.text), ["t1", "t2", "t3"]);
  assert.deepEqual(after.den.map((t) => t.text), ["d1", "d2", "d3"]);
});

test("frames and the games list carry the newest town lines and a count, not the transcript", async () => {
  const { h, id, wolf, seer, vill } = await day1();
  const long = "x".repeat(400);
  for (let i = 0; i < 150; i++) assert.equal((await h.room.gameMove(id, [vill[0], vill[1], seer][i % 3], "say: " + i + " " + long, R)).status, 200);
  const frames = [];
  h.room.clients.add({ token: "t", owner: false, name: "Zed", kinds: null, games: null, stateSub: false, stateKey: null, send: (f) => { if (f.startsWith("event: game")) frames.push(f); }, close: () => {} });
  assert.equal((await h.room.gameMove(id, wolf, "say: the last word", R)).status, 200);
  assert.equal(frames.length, 1);
  // one say: sent the newest 120 lines (~59 KB) to every stream
  assert.ok(frames[0].length < 6000, "a frame of " + frames[0].length + " bytes");
  const pub = JSON.parse(frames[0].split("data: ")[1]).game;
  assert.equal(pub.talk, undefined);
  assert.equal(pub.talk_count, 151);
  assert.deepEqual(pub.talk_recent.map((t) => t.n), [147, 148, 149, 150, 151]);
  assert.equal(pub.talk_recent[4].text, "the last word");
  const listed = h.room.listGames().games.find((g) => g.id === id);
  assert.equal(listed.talk, undefined);
  assert.ok(JSON.stringify(listed).length < 6000);
  // the full state, for everyone, still has the talk
  for (const who of [null, vill[0]]) {
    const g = (await h.room.gameState(id, who, R)).game;
    assert.equal(g.talk.length, 120);
    assert.equal(g.talk[119].text, "the last word");
  }
});
