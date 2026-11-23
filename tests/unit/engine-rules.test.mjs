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
    assert.match(r.error, /dir is your move as text: send one string/);
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
  const list = await fl.h.room.gameMove(fl.id, "Ann", [20, 20, 20, 20, 20], R);
  assert.equal(list.status, 400);
  assert.match(list.error, /send one string .*not a list - put all its parts in that one string/, "the refusal says what to send");
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

/** rewrite a match's stored state, as the game-expire test hook does */
const edit = (h, id, fn) => { const g = h.room.gameRow(id); fn(g.st); h.room.saveGame(g); };

test("Letter Grid: a leader out for three missed rounds places below the player still in", async () => {
  const { h, id } = await running("lettergrid", ["Ann", "Bob"]);
  // Bob leads 40-20 and has missed two rounds; Ann has a word in
  edit(h, id, (st) => {
    st.prog.Bob.score = 40;
    st.prog.Bob.missed = 2;
    st.prog.Ann.score = 20;
    st.pending.Ann = { word: "zzz", path: [[0, 0], [0, 1], [0, 2]] };
    st.deadline = Date.now() - 1;
  });
  const g = (await h.room.gameState(id, null, R)).game;
  assert.equal(g.status, "finished", "one player left ends the match");
  assert.equal(g.winner, "Ann", "not Bob, who is out with more points");
  assert.deepEqual(g.places, ["Ann", "Bob"]);
  assert.equal(g.draw, false);
});

test("Trust: a leader out for three missed rounds places below the player still in", async () => {
  const { h, id } = await running("trust", ["Ann", "Bob"]);
  assert.equal((await h.room.gameMove(id, "Ann", "C", R)).status, 200);
  edit(h, id, (st) => {
    st.prog.Bob.score = 30;
    st.prog.Bob.missed = 2;
    st.prog.Ann.score = 30;
    st.deadline = Date.now() - 1;
  });
  const g = (await h.room.gameState(id, null, R)).game;
  assert.equal(g.status, "finished");
  assert.equal(g.winner, "Ann", "Bob out with more points does not win, and an equal score is no tie with him");
  assert.deepEqual(g.places, ["Ann", "Bob"]);
  assert.match(g.log[g.log.length - 1].text, /^Too few players left\. Ann wins\./);
  // three still in: an out leader keeps their score but ranks last
  const t = await running("trust", ["Ann", "Bob", "Cat"]);
  for (const n of ["Ann", "Cat"]) assert.equal((await t.h.room.gameMove(t.id, n, "C", R)).status, 200);
  edit(t.h, t.id, (st) => {
    st.prog.Bob.score = 99;
    st.prog.Bob.missed = 2;
    st.deadline = Date.now() - 1;
  });
  assert.equal((await t.h.room.gameState(t.id, null, R)).game.status, "running", "two still in: the match goes on");
  const st = t.h.room.gameRow(t.id).st;
  assert.equal(st.prog.Bob.out, true);
  t.h.room.trStanding(st);
  assert.equal(st.places[2], "Bob", "last, with the top score");
});

test("Liar's Dice: a timeout opens no cup; only a liar call does", async () => {
  const { h, id } = await running("liarsdice", ["Al", "Bo"], { dice: 2 });
  h.member("Cy");
  const st0 = h.room.gameRow(id).st;
  const first = st0.turn_of, second = first === "Al" ? "Bo" : "Al";
  edit(h, id, (st) => { st.cups = { Al: [6, 6], Bo: [2, 3] }; });
  assert.equal((await h.room.gameMove(id, first, "4x6", R)).status, 200);
  // the next player lets the clock run out
  edit(h, id, (st) => { st.deadline = Date.now() - 1; });
  for (const who of ["Cy", first, second, null]) {
    const g = (await h.room.gameState(id, who, R)).game;
    assert.equal(g.rounds.length, 1);
    assert.equal(g.rounds[0].reason, "timeout");
    assert.deepEqual(g.rounds[0].cups, {}, "no cup opened for " + who);
    assert.deepEqual(g.rounds[0].held, { Al: 2, Bo: 2 }, "the dice counts still show");
    assert.deepEqual(g.last_round.cups, {});
  }
  const listed = h.room.listGames().games.find((x) => x.id === id);
  assert.deepEqual(listed.last_round.cups, {}, "nor in the games list");
  assert.deepEqual(h.room.gameRow(id).st.rounds[0].cups, {}, "nor stored");
  // a call opens every cup
  const g1 = h.room.gameRow(id).st;
  const opener = g1.turn_of, other = opener === "Al" ? "Bo" : "Al";
  assert.equal((await h.room.gameMove(id, opener, "1x2", R)).status, 200);
  const c = await h.room.gameMove(id, other, "liar", R);
  assert.equal(c.status, 200, c.error);
  const called = c.game.rounds[1];
  assert.equal(called.reason, "call");
  assert.deepEqual(Object.keys(called.cups).sort(), Object.keys(called.held).sort());
});

test("Liar's Dice: a match stored with cups on a timeout round shows them only once it is over", async () => {
  const { h, id } = await running("liarsdice", ["Al", "Bo"], { dice: 3 });
  // a round closed by a timeout under the old rule, every cup stored
  edit(h, id, (st) => {
    st.rounds.push({ n: 1, cups: { Al: [1, 4, 6], Bo: [2, 2, 5] }, bids: [], reason: "timeout", loser: "Bo", out: false, dice_left: 2, at: Date.now() });
    st.round = 2;
    st.count.Bo = 2;
    st.cups.Bo = [3, 3];
  });
  const g = (await h.room.gameState(id, null, R)).game;
  assert.deepEqual(g.rounds[0].cups, {});
  assert.deepEqual(g.rounds[0].held, { Al: 3, Bo: 3 }, "counted from the stored cups");
  assert.deepEqual(g.last_round.cups, {});
  assert.deepEqual(h.room.gameRow(id).st.rounds[0].cups.Al, [1, 4, 6], "nothing stored is removed");
  // the match still plays out and finishes
  edit(h, id, (st) => { st.timeouts[st.turn_of] = 2; st.deadline = Date.now() - 1; });
  const end = (await h.room.gameState(id, null, R)).game;
  assert.equal(end.status, "finished");
  assert.deepEqual(end.rounds[0].cups.Al, [1, 4, 6], "shown once the match is over");
});

test("Exquisite Corpse counts sentences past abbreviations and in any script", async () => {
  const { h, id } = await running("corpse", ["Ann", "Bob", "Cat"], { rotations: 1 });
  const writer = () => h.room.gameRow(id).st.writer;
  const five = await h.room.gameMove(id, writer(), "Он пришёл. Она ушла. Дождь. Снег. Ночь.", R);
  assert.equal(five.status, 400, "five Russian sentences are more than 3");
  assert.match(five.error, /yours has 5/);
  // a sentence ending on a one-letter word is not an initial: this
  // counted 1 and was taken
  const plans = await h.room.gameMove(id, writer(), "Plan A. Plan B. Plan C. Plan D. Plan E. Plan F.", R);
  assert.equal(plans.status, 400, "six sentences that end on a letter");
  assert.match(plans.error, /yours has 6/);
  for (const text of ["Dr. Watson knocked at 5 p.m. on Baker St. Nobody answered.", "J. R. R. Tolkien wrote it.", "I saw George W. Bush. He waved."]) {
    const r = await h.room.gameMove(id, writer(), text, R);
    assert.equal(r.status, 200, text + ": " + r.error);
  }
});

// "none" used to reject every close match too (agents that always send it
// quietly lost typo answers that had scored), and a close match nobody
// ruled on was stored as judged, so the reveal said "judged right".
test("Trivia: none leaves close matches standing, reject all refuses them, and judged means a ruling", async () => {
  const { h, id } = await running("trivia", ["Ann", "Bob", "Cat"], { rotations: 2 });
  const st = () => h.room.gameRow(id).st;
  /** one round: the quizmaster asks, the two others answer, then the ruling */
  const round = async (near, miss, ruling) => {
    const asker = st().asker;
    const [a, b] = st().order.filter((n) => n !== asker);
    assert.equal((await h.room.gameMove(id, asker, null, R, { question: "My cat?", answer: "Biscuit" })).status, 200);
    assert.equal((await h.room.gameMove(id, a, null, R, { answer: near, wager: 5 })).status, 200);
    const r = await h.room.gameMove(id, b, null, R, { answer: miss, wager: 5 });
    assert.equal(st().phase, "judge", r.error);
    assert.match(st().log.at(-1).text, /judging the answers the match missed or took as close/);
    for (const dir of ruling(a, b)) {
      const m = await h.room.gameMove(id, asker, dir, R);
      assert.equal(m.status, 200, dir + ": " + m.error);
    }
    const rec = st().rounds.at(-1);
    return { near: rec.answers[a], miss: rec.answers[b] };
  };
  const none = await round("Biscut", "Rex", () => ["none"]);
  assert.deepEqual([none.near.right, none.near.judged, none.near.near], [true, false, true], "a close match left alone counts, as a close match: " + JSON.stringify(none.near));
  assert.deepEqual([none.miss.right, none.miss.judged, none.miss.near], [false, false, false]);
  const no = await round("Biscut", "Rex", () => ["no"]);
  assert.equal(no.near.right, true, "no reads as none");
  const all = await round("Biscut", "Rex", () => ["reject all"]);
  assert.deepEqual([all.near.right, all.miss.right], [false, false], "reject all refuses close matches too");
  const named = await round("Biscut", "Kitty", (a, b) => ["reject " + a, "accept " + b]);
  assert.deepEqual([named.near.right, named.near.near, named.near.judged], [false, false, false], "a rejected close match");
  assert.deepEqual([named.miss.right, named.miss.judged], [true, true], "an accepted miss is judged right");
  const kept = await round("Biscut", "Rex", (a) => ["accept " + a, "done"]);
  assert.deepEqual([kept.near.right, kept.near.judged, kept.near.near], [true, true, false], "an explicit accept of a close match is a ruling");
});
