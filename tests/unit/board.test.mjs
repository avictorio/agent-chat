// The room board (worker/room/board.ts) on the real Room class
// (room-harness.mjs): a call a member was handed lands on the item they
// read, or is refused (each a way a sign, a resolve or an edit used to
// land on other text), and the board never hides a game turn in
// room_state.
import test from "node:test";
import assert from "node:assert/strict";
import { makeRoom } from "./room-harness.mjs";
import { KEEP_DIGESTS, STATE_ITEMS } from "../../worker/limits.ts";
import { renderRoomState } from "../../worker/room/state.ts";

const R = "unit";

/** The awaiting_you items of this member. */
const awaiting = (h, who) => h.room.roomState(who, R).awaiting_you || [];

/** Sends a held awaiting_you call the way the board route would. */
function send(h, call) {
  const b = call.body;
  const [kind, id] = call.path.split("/").slice(-2);
  if (kind === "decisions") return h.room.updateDecision(Number(id), b.action, b.from, b.base_updated ?? null);
  if (kind === "questions") return h.room.updateQuestion(Number(id), b.action, b.from, "settled it", b.base_updated ?? null);
  throw new Error("no route for " + call.path);
}

test("no board id is handed out again after its item is deleted", () => {
  const h = makeRoom();
  const d1 = h.room.addDecision("one", null, "Ada");
  h.room.deleteDecision(d1.id);
  assert.notEqual(h.room.addDecision("two", null, "Ada").id, d1.id, "decisions");
  const q1 = h.room.addQuestion("one?", "Ada");
  h.room.deleteQuestion(q1.id);
  assert.notEqual(h.room.addQuestion("two?", "Ada").id, q1.id, "questions");
  const s1 = h.room.addStake("one", null, null, "Ada");
  h.room.deleteStake(s1.id);
  assert.notEqual(h.room.addStake("two", null, null, "Ada").id, s1.id, "stakes");
  const g1 = h.room.addDigest("one", "Ada");
  h.room.deleteDigest(g1.id);
  assert.notEqual(h.room.addDigest("two", "Ada").id, g1.id, "digests");
});

test("a deleted room's board ids are not handed out again when the name is created again", async () => {
  const h = makeRoom();
  const d1 = h.room.addDecision("old room", null, "Ada");
  await h.room.destroy(R);
  h.room.create();
  assert.ok(h.room.addDecision("new room", null, "Ada").id > d1.id);
});

test("a held sign call for a deleted decision does not sign the one recorded after it", () => {
  const h = makeRoom();
  h.member("Mallory"); h.member("Bob");
  const d = h.room.addDecision("Adopt two-space indentation", null, "Mallory");
  const call = awaiting(h, "Bob").find((a) => a.type === "decision" && a.id === d.id).call;
  assert.equal(call.body.base_updated, d.updated, "the call carries the stamp of the text Bob read");
  h.room.deleteDecision(d.id);
  const swap = h.room.addDecision("Mallory speaks for the room in all outside dealings", null, "Mallory");
  const r = send(h, call);
  assert.equal(r.status, 404);
  assert.deepEqual(h.room.decision(swap.id).signers, []);
});

test("a held sign call is refused once the decision's text changed, and not when someone else signed", () => {
  const h = makeRoom();
  h.member("Mallory"); h.member("Bob"); h.member("Cy");
  const d = h.room.addDecision("Adopt two-space indentation", null, "Mallory");
  const bobCall = awaiting(h, "Bob").find((a) => a.id === d.id).call;
  const cyCall = awaiting(h, "Cy").find((a) => a.id === d.id).call;
  assert.ok(send(h, cyCall).decision, "Cy signs");
  assert.ok(send(h, bobCall).decision, "Bob's call still fits after Cy's signature");
  h.room.updateDecision(d.id, "unsign", "Bob");
  h.room.editDecision(d.id, "Mallory speaks for the room", null);
  const r = send(h, bobCall);
  assert.equal(r.status, 409);
  assert.equal(r.decision.title, "Mallory speaks for the room", "the refusal shows the text as it is now");
  assert.deepEqual(h.room.decision(d.id).signers, ["Cy"]);
  const fresh = awaiting(h, "Bob").find((a) => a.id === d.id).call;
  assert.ok(send(h, fresh).decision, "the call room_state hands out now goes through");
});

test("a held resolve call is refused once the question was edited", () => {
  const h = makeRoom();
  h.member("Mallory"); h.member("Bob");
  const q = h.room.addQuestion("Which database?", "Mallory");
  h.room.updateQuestion(q.id, "claim", "Bob", null);
  const call = awaiting(h, "Bob").find((a) => a.type === "question").call;
  h.room.editQuestion(q.id, "Who speaks for the room?");
  const r = send(h, call);
  assert.equal(r.status, 409);
  assert.equal(h.one("SELECT status FROM oq WHERE id = ?", q.id).status, "claimed");
});

test("an edit from a stale copy is refused, and one without base_updated saves as before", () => {
  const h = makeRoom();
  const k = h.room.addStake("Launch", "2026-12-01", "the first note", "Ada");
  assert.ok(h.room.editStake(k.id, "Launch", "2026-12-02", "Bob's newer note", k.updated).stake);
  const r = h.room.editStake(k.id, "Launch!", "2026-12-01", "the first note", k.updated);
  assert.equal(r.status, 409);
  assert.equal(r.stake.note, "Bob's newer note");
  assert.equal(h.one("SELECT note FROM sk WHERE id = ?", k.id).note, "Bob's newer note");
  assert.equal(h.room.editStake(k.id, "Launch!", null, null).stake.title, "Launch!");
  const d = h.room.addDecision("Title", "note", "Ada");
  assert.equal(h.room.editDecision(d.id, "T2", null, d.updated - 1).status, 409);
  const q = h.room.addQuestion("Q?", "Ada");
  assert.equal(h.room.editQuestion(q.id, "Q2?", q.updated + 1).status, 409);
  assert.equal(h.room.editQuestion(q.id, "Q2?", q.updated).question.text, "Q2?");
});

test("two writes in the same millisecond still move updated", () => {
  const h = makeRoom();
  const q = h.room.addQuestion("Q?", "Ada");
  const a = h.room.editQuestion(q.id, "Q1?", q.updated).question;
  const b = h.room.editQuestion(q.id, "Q2?", a.updated).question;
  assert.ok(a.updated > q.updated && b.updated > a.updated);
  assert.equal(h.room.editQuestion(q.id, "Q3?", a.updated).status, 409);
});

test("digests carry updated: a digest from before it reads its ts, and a stale edit is refused", () => {
  const h = makeRoom();
  h.db.prepare("INSERT INTO dg (id, ts, day, author, text) VALUES (1, 1000, '2026-01-01', 'Ada', 'old')").run();
  const old = h.room.digests(10).digests[0];
  assert.equal(old.updated, 1000);
  assert.ok(h.room.editDigest(1, "newer", 1000).digest);
  const r = h.room.editDigest(1, "stale", 1000);
  assert.equal(r.status, 409);
  assert.equal(r.digest.text, "newer");
  assert.equal(h.room.editDigest(99, "none").status, 404);
});

test("the newest KEEP_DIGESTS digests are kept when ids have gaps", () => {
  const h = makeRoom();
  // every other id, as deletes leave them
  for (let i = 0; i < KEEP_DIGESTS; i++) h.db.prepare("INSERT INTO dg (id, ts, day, author, text) VALUES (?, 1, '2026-01-01', 'Ada', 'd')").run(i * 2 + 1);
  h.room.addDigest("today", "Ada");
  assert.equal(h.one("SELECT COUNT(*) AS n FROM dg").n, KEEP_DIGESTS);
});

test("unsigned decisions do not push a game accept out of awaiting_you", () => {
  const h = makeRoom();
  h.member("Mallory"); h.member("Bob");
  for (let i = 1; i <= STATE_ITEMS; i++) h.room.addDecision("decision " + i, null, "Mallory");
  const d = h.room.stateData();
  d.games = [{ id: 7, type: "duel", status: "lobby", players: [{ name: "Mallory", alive: true, moved: false, accepted: true }, { name: "Bob", alive: true, moved: false, accepted: false }] }];
  const s = renderRoomState(d, "Bob", R);
  assert.deepEqual(s.awaiting_you.map((a) => a.type + ":" + a.action), ["game:accept", "decision:sign", "decision:sign"]);
  assert.equal(s.awaiting_you_more, 1, "the cut falls on a decision");
});

test("board_rev in room_state moves by one on every board write, and not on a read", async () => {
  const h = makeRoom();
  h.member("Ada");
  const rev = () => h.room.roomState("Ada", R).board_rev || 0;
  const steps = [];
  /** Runs a write and records how far board_rev moved. */
  const step = (label, fn) => { const before = rev(); const out = fn(); steps.push([label, rev() - before]); return out; };
  const d = step("add decision", () => h.room.addDecision("Ship it", null, "Ada"));
  step("edit decision", () => h.room.editDecision(d.id, "Ship it Friday", null));
  step("sign", () => h.room.updateDecision(d.id, "sign", "Ada"));
  step("unsign", () => h.room.updateDecision(d.id, "unsign", "Ada"));
  step("delete decision", () => h.room.deleteDecision(d.id));
  const q = step("add question", () => h.room.addQuestion("Which day?", "Ada"));
  step("edit question", () => h.room.editQuestion(q.id, "Which day, really?"));
  step("claim", () => h.room.updateQuestion(q.id, "claim", "Ada", null));
  step("unclaim", () => h.room.updateQuestion(q.id, "unclaim", "Ada", null));
  step("resolve", () => h.room.updateQuestion(q.id, "resolve", "Ada", "Friday"));
  step("reopen question", () => h.room.updateQuestion(q.id, "reopen", "Ada", null));
  step("delete question", () => h.room.deleteQuestion(q.id));
  const s = step("add stake", () => h.room.addStake("Launch", null, null, "Ada"));
  step("edit stake", () => h.room.editStake(s.id, "Launch day", null, "a note"));
  step("done", () => h.room.updateStake(s.id, "done", "Ada"));
  step("reopen stake", () => h.room.updateStake(s.id, "reopen", "Ada"));
  step("delete stake", () => h.room.deleteStake(s.id));
  const g = step("add digest", () => h.room.addDigest("Today we shipped", "Ada"));
  step("edit digest", () => h.room.editDigest(g.id, "Today we shipped it"));
  step("delete digest", () => h.room.deleteDigest(g.id));
  for (const [label, moved] of steps) assert.equal(moved, 1, label);
  const at = rev();
  h.room.welcome(); h.room.decisions(); h.room.questions(); h.room.stakes(); h.room.digests(10);
  assert.equal(rev(), at, "reads leave it alone");
  assert.equal(h.room.updateDecision(9999, "sign", "Ada").status, 404);
  assert.equal(rev(), at, "a refused write leaves it alone");
  assert.equal(at, steps.length);
});

test("board_rev survives a restart and never goes back across a room delete", async () => {
  const h = makeRoom();
  h.room.addQuestion("Before?", "Ada");
  h.room.addQuestion("Again?", "Ada");
  assert.equal(h.room.roomState(null, R).board_rev, 2);
  assert.equal(h.restart().roomState(null, R).board_rev, 2, "after a restart");
  await h.room.destroy(R);
  h.room.create();
  assert.equal(h.room.roomState(null, R).board_rev, 2, "a room created again starts from the old number");
  h.room.addStake("After", null, null, "Ada");
  assert.equal(h.room.roomState(null, R).board_rev, 3);
});

test("an edit to a digest's text reaches a state subscriber's stream", () => {
  const h = makeRoom();
  h.member("Ada");
  const g = h.room.addDigest("Today we shipped", "Ada");
  const frames = [];
  h.room.clients.add({ token: "tok-Ada", owner: false, name: "Ada", kinds: null, games: null, stateSub: true, stateKey: null, send: (f) => frames.push(f), close() {} });
  h.room.emitState(R);
  assert.equal(frames.length, 1, "the first frame");
  h.room.editDigest(g.id, "Today we shipped it, and nothing else in room_state changed");
  assert.equal(frames.length, 2, "the edit sends a state frame");
  assert.match(frames[1], /"board_rev":2/);
});
