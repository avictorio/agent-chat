// How engines read a move, on the real Room class (room-harness.mjs):
// each test is a move that used to be read as something else, or that
// held the whole room while it was parsed.
import test from "node:test";
import assert from "node:assert/strict";
import { makeRoom } from "./room-harness.mjs";
import { splitLastWord } from "../../worker/games/shared.ts";
import { MOVE_DIR_MAX } from "../../worker/limits.ts";

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
  // a hyphen right after the word is part of a word, not the guess form
  const q2 = await h.room.gameMove(id, second, "Guess-timate: is it heavy?", R);
  assert.equal(q2.status, 200, q2.error);
  const asked2 = q2.game.qa[q2.game.qa.length - 1];
  assert.equal(asked2.kind, "q", "\"Guess-timate: ...\" is a question");
  assert.equal(asked2.q, "Guess-timate: is it heavy?");
  assert.equal((await h.room.gameMove(id, ans, "no", R)).status, 200);
  // the colon form the docs teach still guesses
  const g1 = await h.room.gameMove(id, first, "guess: a blue car", R);
  assert.equal(g1.status, 200, g1.error);
  assert.equal(g1.game.qa[g1.game.qa.length - 1].kind, "guess");
  assert.equal((await h.room.gameMove(id, ans, "wrong", R)).status, 200);
  // and so does the hyphen form, with a space on both sides
  const g = await h.room.gameMove(id, second, "guess - a red bicycle", R);
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

// A move that held the room: each parser on a hostile dir, timed. The
// regexes these replaced took seconds (Trust: a letter, 60,000 spaces and
// a letter; Letter Grid: a letter, 3,000 spaces and a line break, cubic;
// Trivia: 60,000 @ and a word).
const fast = (label, fn) => {
  const t = performance.now();
  const out = fn();
  const ms = performance.now() - t;
  assert.ok(ms < 250, label + " took " + Math.round(ms) + " ms");
  return out;
};

test("splitLastWord answers as the regexes it replaced did", () => {
  const trust = /^(.+?)\s*[:=]\s*(\S+)$/;
  const trivia = /^(.*?)\s*@\s*(\S+)\s*$/;
  const abc = ["a", "b", " ", " ", ":", "=", "@", "\t"];
  for (let n = 0; n < 20000; n++) {
    let s = "";
    const len = 1 + (n % 9);
    for (let i = 0; i < len; i++) s += abc[(n * 7 + i * 13 + ((n >> i) & 7)) % abc.length];
    const tok = s.trim();
    const a = tok.match(trust), b = splitLastWord(tok, ":=", 1);
    assert.deepEqual(b && [b[0].trim(), b[1]], a && [a[1].trim(), a[2]], JSON.stringify(tok));
    const c = tok.match(trivia), d = splitLastWord(tok, "@", 0);
    assert.deepEqual(d && [d[0].trim(), d[1]], c && [c[1].trim(), c[2]], JSON.stringify(tok));
  }
});

test("Trust, Letter Grid and Trivia read a hostile dir in linear time", async () => {
  const tr = await running("trust", ["Ann", "Bob"]);
  const trSt = tr.h.room.gameRow(tr.id).st;
  const ann = (st) => st.players.find((p) => p.name === "Ann");
  const r1 = fast("Trust", () => tr.h.room.trParse(trSt, ann(trSt), "a" + " ".repeat(60000) + "b"));
  assert.ok(r1.error);
  assert.deepEqual(tr.h.room.trParse(trSt, ann(trSt), "Bob = defect").choices, { Bob: "D" }, "and still reads a choice");
  const lg = await running("lettergrid", ["Ann", "Bob"]);
  const lgSt = lg.h.room.gameRow(lg.id).st;
  assert.ok(fast("Letter Grid", () => lg.h.room.lgParse(lgSt, ann(lgSt), "a" + " ".repeat(3000) + "1\nz", null)).error);
  assert.ok(fast("Letter Grid, long", () => lg.h.room.lgParse(lgSt, ann(lgSt), "a" + " ".repeat(60000) + "1\nz", null)).error);
  const tv = await running("trivia", ["Ann", "Bob", "Cat"]);
  const tvSt = tv.h.room.gameRow(tv.id).st;
  const r3 = fast("Trivia", () => tv.h.room.tvParseAnswer(tvSt, ann(tvSt), "@".repeat(60000) + " a b", null));
  assert.ok(r3.error, "far too long an answer");
  assert.deepEqual(tv.h.room.tvParseAnswer(tvSt, ann(tvSt), "Paris @ 0", null), { answer: "Paris", wager: 0 });
});

test("a move's dir past MOVE_DIR_MAX is refused before any engine reads it; a drawing is not", async () => {
  const lg = await running("lettergrid", ["Ann", "Bob"]);
  const long = fast("the refusal", () => lg.h.room.gameMove(lg.id, "Ann", "a" + " ".repeat(MOVE_DIR_MAX) + "1\nz", R));
  assert.equal((await long).status, 413);
  const at = await lg.h.room.gameMove(lg.id, "Ann", "a" + " ".repeat(MOVE_DIR_MAX - 4) + "1\nz", R);
  assert.equal(at.status, 400, "a dir at the cap still reaches the engine");
  const sk = await running("sketch", ["Ann", "Bob", "Cat"]);
  const artist = (await sk.h.room.gameState(sk.id, null, R)).game.artist;
  const big = PNG_URL + "A".repeat(MOVE_DIR_MAX * 4);
  const r = await sk.h.room.gameMove(sk.id, artist, big, R);
  assert.notEqual(r.status, 413, "a Sketch drawing is a long data URL");
  assert.equal((await sk.h.room.gameMove(sk.id, artist, JSON.stringify({ image: PNG_URL }), R)).status, 200);
});

test("a move naming a turn the match has moved past is refused, not played on the new turn", async () => {
  const { h, id } = await running("fourinarow", ["Ann", "Bob"]);
  const st0 = (await h.room.gameState(id, null, R)).game;
  const F = st0.turn_of, S = F === "Ann" ? "Bob" : "Ann";
  assert.equal(st0.turn, 1);
  assert.equal((await h.room.gameMove(id, F, "4", R, null, false, 1)).status, 200);
  assert.equal((await h.room.gameMove(id, S, "3", R, null, false, "2")).status, 200, "a turn may come as a string");
  // the first drop, re-sent after the rival answered
  const late = await h.room.gameMove(id, F, "4", R, null, false, 1);
  assert.equal(late.status, 409);
  assert.equal(late.turn, 3);
  assert.equal(late.game.turn, 3, "the state as it is now");
  assert.equal(late.game.moves.length, 2, "nothing was played");
  assert.equal((await h.room.gameMove(id, F, "4", R, null, false, { n: 3 })).status, 400);
  // without turn, as before
  const plain = await h.room.gameMove(id, F, "4", R);
  assert.equal(plain.status, 200);
  assert.equal(plain.game.moves.length, 3);
});

// A live Light Cycles tick is ended by the clock: the call room_state hands
// out used to name the tick, so an agent's steer sent a moment after the
// tick resolved was refused, the clock carried the rider and the absence
// rule could take it out. There the call leaves turn out; async (ticks wait
// for every rider) and every other game keep it.
test("Light Cycles live: the awaiting_you call leaves turn out, so a late steer applies to the next tick", async () => {
  const callFor = (h, who, id) => (h.room.roomState(who, R).awaiting_you || []).find((a) => a.type === "game" && a.id === id);
  const live = await running("lightcycles", ["Ann", "Bob"], { w: 12, h: 10 });
  const c = callFor(live.h, "Ann", live.id);
  assert.equal(c.turn, 0, "the item still names the tick");
  assert.equal("turn" in c.call.body, false, "the live call does not");
  // Ann's steer for tick 0 arrives after the tick resolved without her
  const st0 = (await live.h.room.gameState(live.id, "Ann", R)).game;
  assert.equal((await live.h.room.gameMove(live.id, "Bob", st0.players.find((p) => p.name === "Bob").dir, R)).status, 200);
  live.h.db.prepare("UPDATE gm SET state = json_set(state, '$.deadline', ?) WHERE id = ?").run(Date.now() - 10, live.id);
  const dir = st0.you.safe_moves[0] || st0.you.legal_moves[0];
  const late = await live.h.room.gameMove(live.id, "Ann", dir, R, null, false, c.call.body.turn);
  assert.equal(late.status, 200, late.error);
  assert.equal(late.game.tick, 1, "the clock resolved tick 0 first");
  assert.equal(late.game.you.queued, dir, "and the steer is queued for tick 1");
  const stale = await live.h.room.gameMove(live.id, "Ann", dir, R, null, false, 0);
  assert.equal(stale.status, 409, "a caller who names a past tick is still refused");
  assert.equal(stale.turn, 1);
  const as = await running("lightcycles", ["Ann", "Bob"], { mode: "async", w: 12, h: 10 });
  assert.equal(callFor(as.h, "Ann", as.id).call.body.turn, 0, "an async match's call names the tick");
  const c4 = await running("fourinarow", ["Ann", "Bob"]);
  const first = (await c4.h.room.gameState(c4.id, null, R)).game.turn_of;
  assert.equal(callFor(c4.h, first, c4.id).call.body.turn, 1, "and so does every other game's");
});
