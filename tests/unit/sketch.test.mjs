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

// A tie on score and exact guesses: the times of right guesses used to be
// summed, so a player who scored only as the artist (no right guess, 0 ms)
// beat one with two quick right guesses, and two 60 s guesses lost to one
// of 90 s.
test("a tie goes to more right guesses, then the quicker ones on average", async () => {
  const { h, id } = await running(["Ann", "Bob", "Cat"]);
  const st = h.room.gameRow(id).st;
  const g = (ms) => ({ guess: "x", right: true, exact: false, how: "referee", at: 0, ms });
  const round = (artist, points, guesses) => ({ n: 1, artist, prompt: "p", guesses, right: Object.keys(guesses), missed: [], points, judge: "referee", judge_note: null, roast: null, forfeit: false, at: 0 });
  // Ann 4 as the artist alone; Bob 4 from two right guesses of 5 s
  st.rounds = [round("Ann", { Ann: 2, Bob: 2, Cat: 0 }, { Bob: g(5000) }), round("Ann", { Ann: 2, Bob: 2 }, { Bob: g(5000) })];
  assert.equal(h.room.sgStanding(st), "Bob", "two right guesses beat none");
  assert.deepEqual(st.places.slice(0, 2), ["Bob", "Ann"]);
  // Ann one right guess of 90 s plus 2 as the artist; Bob two of 60 s
  st.rounds = [round("Cat", { Ann: 2, Bob: 2, Cat: 2 }, { Ann: g(90000), Bob: g(60000) }), round("Ann", { Ann: 2, Bob: 2 }, { Bob: g(60000) })];
  assert.equal(h.room.sgStanding(st), "Bob", "more right guesses first, whatever their total time");
  // the same count: the quicker average wins; equal averages are a draw
  st.rounds = [round("Cat", { Ann: 2, Bob: 2, Cat: 2 }, { Ann: g(10000), Bob: g(20000) })];
  assert.equal(h.room.sgStanding(st), "Ann");
  st.rounds = [round("Cat", { Ann: 2, Bob: 2, Cat: 2 }, { Ann: g(10000), Bob: g(10000) })];
  assert.equal(h.room.sgStanding(st), null);
  assert.equal(st.draw, true);
});

// A drawing whose base64 is line-wrapped (a shell's base64 breaks every 76
// characters): moveFields used to cut it to the cap with the breaks still
// in, so an image just under the cap lost its end, was stored broken and
// the round went on. One over the cap was cut and stored too, when it was
// not refused as invalid base64.
test("a line-wrapped drawing under the cap is stored whole; one over it answers 413", async () => {
  const { moveFields } = await import("../../worker/games/engine.ts");
  const { SG_IMAGE_MAX } = await import("../../worker/games/sketch.ts");
  const png = (n) => { const b = Buffer.alloc(n, 7); b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); b[n - 1] = 0x42; return b; };
  const wrapped = (b) => "data:image/png;base64," + b.toString("base64").replace(/.{76}/g, "$&\n");
  const ok = png(SG_IMAGE_MAX - 10000);
  for (const via of ["fields", "dir"]) {
    const { h, id } = await running(["Ann", "Bob", "Cat"]);
    const artist = h.room.gameRow(id).st.artist;
    const text = wrapped(ok);
    const r = via === "fields" ? await h.room.gameMove(id, artist, undefined, R, moveFields({ image: text })) : await h.room.gameMove(id, artist, JSON.stringify({ image: text }), R);
    assert.equal(r.status, 200, via + ": " + r.error);
    const stored = h.objects.get(h.room.gameRow(id).st.images[1].key);
    assert.equal(Buffer.compare(Buffer.from(stored), ok), 0, via + ": the drawing is stored whole");
  }
  for (const n of [SG_IMAGE_MAX + 1, SG_IMAGE_MAX + 60000]) {
    const { h, id } = await running(["Ann", "Bob", "Cat"]);
    const artist = h.room.gameRow(id).st.artist;
    const text = wrapped(png(n));
    const f = await h.room.gameMove(id, artist, undefined, R, moveFields({ image: text }));
    assert.equal(f.status, 413, n + " bytes in fields: " + f.error);
    assert.match(f.error, /up to 1500 KB/);
    const d = await h.room.gameMove(id, artist, JSON.stringify({ image: text }), R);
    assert.equal(d.status, 413, n + " bytes in dir: " + d.error);
    assert.equal(h.room.gameRow(id).st.phase, "draw", "the round waits for a drawing that fits");
    assert.deepEqual(drawings(h), []);
  }
});
