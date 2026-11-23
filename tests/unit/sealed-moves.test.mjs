// Sealed moves sent again, on the real Room class (room-harness.mjs): an
// unchanged copy (a retry after a lost reply, a second wake, a loop) sends
// no game frame and keeps its time, so watchers learn nothing and the
// sender keeps their place in the tie-breaks that go to the earlier move.
import test from "node:test";
import assert from "node:assert/strict";
import { makeRoom } from "./room-harness.mjs";
import { gameEngine } from "../../worker/games/engine.ts";

const R = "unit";
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

/** a running match of game between names, every seat accepted, with a
 *  spectator's stream collecting its game frames */
async function running(game, names, opts = {}) {
  const h = makeRoom();
  for (const n of names) h.member(n);
  const c = await h.room.createGame(names[0], names, { game, ...opts }, R);
  assert.equal(c.status, 201, c.error);
  for (const n of names.slice(1)) assert.equal((await h.room.gameAccept(c.game.id, n, R)).status, 200);
  const frames = [];
  h.room.clients = new Set([{ token: "t", owner: false, name: "Spec", kinds: null, games: null, stateSub: false, stateKey: null, send: (f) => { if (f.startsWith("event: game")) frames.push(JSON.parse(f.split("\ndata: ")[1])); }, close() {} }]);
  const id = c.game.id;
  const stored = () => JSON.parse(h.room.sql.exec("SELECT state FROM gm WHERE id = ?", id).one().state);
  const move = async (who, dir, fields = null) => {
    const r = await h.room.gameMove(id, who, dir, R, fields);
    assert.equal(r.status, 200, who + " " + JSON.stringify(dir || fields) + ": " + r.error);
    return r;
  };
  return { h, id, frames, stored, move };
}

/** Date.now moves on 5 ms per call, so every move has its own time */
function steppedClock(t) {
  const real = Date.now;
  let now = real();
  Date.now = () => (now += 5);
  t.after(() => { Date.now = real; });
}

test("an unchanged duel throw sent again sends no frame and keeps its time; a changed one still lands", async () => {
  const { frames, stored, move } = await running("duel", ["Ann", "Bob"]);
  await move("Ann", "rock");
  const at = stored().pending_at.Ann;
  assert.equal(frames.length, 1);
  const r = await move("Ann", "rock");
  assert.equal(r.resolved, false);
  assert.equal(r.game.you.queued, "rock");
  assert.equal(frames.length, 1, "no frame for the copy");
  assert.equal(stored().pending_at.Ann, at, "its time is kept");
  await move("Ann", "paper");
  assert.equal(stored().pending.Ann, "paper", "a change of mind is still taken");
  await move("Bob", "rock");
  assert.equal(stored().rounds[0].throws.Ann, "paper");
});

test("an Auction bid re-sent unchanged keeps the bidder first in a tie", async (t) => {
  steppedClock(t);
  const { frames, stored, move } = await running("auction", ["Ann", "Bob", "Cy"]);
  await move("Ann", "40");
  await move("Bob", "40");
  const n = frames.length;
  await move("Ann", "40");
  assert.equal(frames.length, n, "no frame for the copy");
  await move("Cy", "pass");
  const lot = stored().rounds[0];
  assert.equal(lot.winner, "Ann", "Ann bid first: " + JSON.stringify(lot));
  assert.equal(lot.tie, "bid first");
});

test("a Light Cycles steer sent twice sends one frame", async () => {
  const { frames, stored, move } = await running("lightcycles", ["Ann", "Bob"], { mode: "async" });
  const head = stored().players.find((p) => p.name === "Ann").dir;
  const turn = { up: "left", down: "left", left: "up", right: "up" }[head];
  await move("Ann", turn);
  const at = stored().pending_at.Ann;
  await move("Ann", turn);
  assert.equal(frames.length, 1);
  assert.equal(stored().pending_at.Ann, at);
});

test("a Two Truths vote sent again sends no frame and keeps its time", async () => {
  const { h, id, frames, stored, move } = await running("twotruths", ["Ann", "Bob", "Cy"]);
  const teller = stored().teller;
  await move(teller, null, { statements: ["I swim", "I sing", "I fly"], lie: 3 });
  const [v1, v2] = ["Ann", "Bob", "Cy"].filter((n) => n !== teller);
  const n = frames.length;
  await move(v1, "2");
  const at = stored().vote_at[v1];
  await move(v1, "2");
  assert.equal(frames.length, n + 1, "one frame for the vote, none for the copy");
  assert.equal(stored().vote_at[v1], at);
  await move(v1, "3");
  assert.equal(stored().votes[v1], 3, "a changed vote is still taken");
  await move(v2, "3");
  assert.ok((await h.room.gameState(id, v2, R)).game.rounds.length >= 1);
});

test("a Sketch & Guess guess sent again sends no frame and keeps its time", async () => {
  const { frames, stored, move } = await running("sketch", ["Ann", "Bob", "Cy"]);
  const artist = stored().artist;
  await move(artist, null, { image: PNG });
  const [g1] = ["Ann", "Bob", "Cy"].filter((n) => n !== artist);
  const n = frames.length;
  await move(g1, null, { guess: "a  cat" });
  const at = stored().guesses[g1].at;
  await move(g1, null, { guess: "a cat" });
  assert.equal(frames.length, n + 1);
  assert.equal(stored().guesses[g1].at, at);
});

test("a Corpse vote sent again sends no frame", async () => {
  const { frames, stored, move } = await running("corpse", ["Ann", "Bob", "Cy"], { rotations: 1 });
  // the writing order is drawn at creation
  for (let i = 0; i < 3; i++) { const w = stored().writer; await move(w, w + " was here."); }
  assert.equal(stored().phase, "vote");
  const pick = String(stored().segments.find((x) => x.by !== "Ann").n);
  const n = frames.length;
  await move("Ann", pick);
  await move("Ann", pick);
  assert.equal(frames.length, n + 1);
});

test("Trivia: one frame per answerer per round, and the log does not count the answers that missed", async () => {
  const { h, id, frames, stored, move } = await running("trivia", ["Ann", "Bob", "Cy"]);
  const asker = stored().asker;
  await move(asker, null, { question: "Capital of France?", answer: "Paris" });
  const [a1, a2] = ["Ann", "Bob", "Cy"].filter((n) => n !== asker);
  const n = frames.length;
  await move(a1, null, { answer: "Lyon", wager: 10 });
  await move(a1, null, { answer: "Lyon", wager: 10 });
  await move(a1, null, { answer: "Marseille", wager: 20 });
  assert.equal(frames.length, n + 1, "the first answer sends a frame, the copy and the change none");
  assert.equal(stored().answers[a1].answer, "Marseille", "the change is taken");
  await move(a2, null, { answer: "Nice", wager: 5 });
  assert.equal(stored().phase, "judge");
  for (const viewer of [null, a1, a2]) {
    const log = (await h.room.gameState(id, viewer, R)).game.log.map((l) => l.text).join("\n");
    assert.match(log, /is judging the answers the match did not take/);
    assert.doesNotMatch(log, /judging \d/, "no count of the missed answers");
  }
});

test("Werewolf: a day vote sent again sends no frame", async () => {
  const names = ["Ann", "Bob", "Cat", "Dan", "Eve"];
  const { h, id, frames, stored, move } = await running("werewolf", names);
  // play the night: every role acts on a villager, the guardian on itself
  const st = stored();
  const wolves = names.filter((n) => st.roles[n] === "werewolf");
  const victim = names.find((n) => st.roles[n] === "villager");
  for (const n of names) {
    const r = st.roles[n];
    if (r === "werewolf") await move(n, "kill " + victim);
    else if (r === "seer") await move(n, "check " + wolves[0]);
    else if (r === "guardian") await move(n, "guard " + n);
  }
  assert.equal(stored().phase, "day", JSON.stringify((await h.room.gameState(id, null, R)).game.log));
  const voter = names.find((n) => stored().alive[n]);
  const n = frames.length;
  await move(voter, "vote " + wolves[0]);
  await move(voter, "vote " + wolves[0]);
  assert.equal(frames.length, n + 1);
});

test("a copy that names its turn is refused once the round moved on, instead of becoming the next round's move", async () => {
  // a duel: Ann's lost reply is re-sent after Bob's throw resolved round 1
  const d = await running("duel", ["Ann", "Bob"]);
  await d.h.room.gameMove(d.id, "Ann", "rock", R, null, false, 1);
  await d.move("Bob", "paper");
  const late = await d.h.room.gameMove(d.id, "Ann", "rock", R, null, false, 1);
  assert.equal(late.status, 409);
  assert.equal(late.turn, 2);
  assert.equal(d.stored().pending.Ann, undefined, "nothing queued for round 2");
  // Twenty Questions: a winning guess tapped twice; the guesser answers next
  const t = await running("twenty", ["Ann", "Bob"]);
  const answerer = t.stored().answerer;
  const guesser = answerer === "Ann" ? "Bob" : "Ann";
  await t.move(answerer, "a lighthouse");
  // the turn awaiting_you hands the guesser
  const eng = gameEngine(t.stored());
  const now = eng.turnOf(eng.stateItem({ id: t.id, status: "running" }, t.stored()));
  assert.equal((await t.h.room.gameMove(t.id, guesser, "guess: a lighthouse", R, null, false, now)).status, 200);
  assert.equal(t.stored().answerer, guesser, "the right guess ended the round");
  const again = await t.h.room.gameMove(t.id, guesser, "guess: a lighthouse", R, null, false, now);
  assert.equal(again.status, 409, "the copy is refused, not stored as the next secret");
  assert.equal(t.stored().secret, null, "the new answerer still has a secret to choose");
});
