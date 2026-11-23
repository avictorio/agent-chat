// A match's revision (rev), on the real Room class (room-harness.mjs): it
// grows on every stored change and every summary, frame and full state
// carries the stored value, so a reader holding two copies keeps the newer.
// The web app used to let a read answered before the rival's move overwrite
// the frame of that move, and showed the old turn until its next poll.
import test from "node:test";
import assert from "node:assert/strict";
import { makeRoom } from "./room-harness.mjs";
import { GAME_ENGINES } from "../../worker/games/engine.ts";

const R = "unit";

/** a room with names as members and a spectator's stream that checks each
 *  game frame against the row as stored when the frame goes out */
function roomWithStream(names) {
  const h = makeRoom();
  for (const n of names) h.member(n);
  const frames = [];
  const storedRev = (id) => JSON.parse(h.room.sql.exec("SELECT state FROM gm WHERE id = ?", id).one().state).rev || 0;
  h.room.clients = new Set([{ token: "t", owner: false, name: "Spec", kinds: null, games: null, stateSub: false, stateKey: null, send: (f) => {
    if (!f.startsWith("event: game")) return;
    const d = JSON.parse(f.split("\ndata: ")[1]);
    // the summary of the row as stored right now: a frame sent before its
    // change was saved would carry the old rev with the new state
    const row = h.room.gameRow(d.game.id);
    const now = h.room.gameSummary(row);
    if (row.st.trails) now.trails = row.st.trails;
    frames.push({ rev: d.game.rev, stored: storedRev(d.game.id), same: JSON.stringify(now) === JSON.stringify(d.game) });
  }, close() {} }]);
  return { h, frames, storedRev };
}

async function play(h, id, who, dir, fields = null) {
  const r = await h.room.gameMove(id, who, dir, R, fields);
  assert.equal(r.status, 200, who + " " + dir + ": " + r.error);
  return r;
}

test("every frame, read and answer carries the stored rev, which grows with each change", async () => {
  const { h, frames, storedRev } = roomWithStream(["Ann", "Bob"]);
  const c = await h.room.createGame("Ann", ["Ann", "Bob"], { game: "fourinarow" }, R);
  assert.equal(c.status, 201, c.error);
  const id = c.game.id;
  assert.equal(typeof c.game.rev, "number");
  const acc = await h.room.gameAccept(id, "Bob", R);
  assert.ok(acc.game.rev > c.game.rev, "the accept is a newer revision");
  let last = acc.game.rev;
  for (const col of ["1", "2", "1", "2"]) {
    const st = (await h.room.gameState(id, "Ann", R)).game;
    const r = await play(h, id, st.turn_of, col, null);
    assert.ok(r.game.rev > last, "a move makes a newer revision: " + r.game.rev + " after " + last);
    assert.equal(r.game.rev, storedRev(id));
    assert.ok(st.rev < r.game.rev);
    last = r.game.rev;
  }
  const list = h.room.listGames().games.find((g) => g.id === id);
  assert.equal(list.rev, storedRev(id), "the Games list carries it");
  assert.ok(frames.length >= 5, "frames were sent: " + frames.length);
  for (const f of frames) {
    assert.equal(f.rev, f.stored, "a frame carries the rev of the row it describes");
    assert.ok(f.same, "a frame describes the row as stored");
  }
});

test("frames carry the stored rev in round games, a cancel and a decline too", async () => {
  const { h, frames } = roomWithStream(["Ann", "Bob", "Cy"]);
  const d = await h.room.createGame("Ann", ["Ann", "Bob"], { game: "duel" }, R);
  await h.room.gameAccept(d.game.id, "Bob", R);
  await play(h, d.game.id, "Ann", "rock");
  await play(h, d.game.id, "Bob", "paper");
  const a = await h.room.createGame("Ann", ["Ann", "Bob", "Cy"], { game: "auction" }, R);
  await h.room.gameAccept(a.game.id, "Bob", R);
  await h.room.gameAccept(a.game.id, "Cy", R);
  await play(h, a.game.id, "Ann", "10");
  const x = await h.room.gameCancel(a.game.id, "Ann", false, R);
  assert.equal(x.game.status, "cancelled");
  const l = await h.room.createGame("Ann", ["Ann", "Cy"], { game: "duel" }, R);
  const dec = await h.room.gameDecline(l.game.id, "Cy", R);
  assert.equal(dec.game.status, "cancelled");
  assert.ok(frames.length >= 6, "frames were sent: " + frames.length);
  for (const f of frames) {
    assert.equal(f.rev, f.stored, "a frame carries the rev of the row it describes");
    assert.ok(f.same, "a frame describes the row as stored");
  }
});

test("an unchanged re-send is no new revision", async () => {
  const { h } = roomWithStream(["Ann", "Bob"]);
  const c = await h.room.createGame("Ann", ["Ann", "Bob"], { game: "duel" }, R);
  await h.room.gameAccept(c.game.id, "Bob", R);
  const one = await play(h, c.game.id, "Ann", "rock");
  const two = await play(h, c.game.id, "Ann", "rock");
  assert.equal(two.game.rev, one.game.rev);
});

test("a match stored before revisions reads as rev 0, and its next change makes it 1", async () => {
  const { h, storedRev } = roomWithStream(["Ann", "Bob"]);
  const c = await h.room.createGame("Ann", ["Ann", "Bob"], { game: "duel" }, R);
  await h.room.gameAccept(c.game.id, "Bob", R);
  const id = c.game.id;
  // the row as the code before revisions stored it
  const st = JSON.parse(h.room.sql.exec("SELECT state FROM gm WHERE id = ?", id).one().state);
  delete st.rev;
  h.room.sql.exec("UPDATE gm SET state = ? WHERE id = ?", JSON.stringify(st), id);
  const r = await h.room.gameState(id, "Ann", R);
  assert.equal(r.game.rev, 0);
  assert.equal(h.room.listGames().games.find((g) => g.id === id).rev, 0);
  const m = await play(h, id, "Ann", "rock");
  assert.equal(m.game.rev, 1);
  assert.equal(storedRev(id), 1);
});

test("every game's create, accept and frames carry the stored rev", async () => {
  const names = ["Ann", "Bob", "Cy", "Dee", "Eve"];
  const { h, frames } = roomWithStream(names);
  for (const game of Object.keys(GAME_ENGINES)) {
    let c = null;
    for (const n of [2, 3, 5]) {
      c = await h.room.createGame("Ann", names.slice(0, n), { game }, R);
      if (c.status === 201) break;
    }
    assert.equal(c.status, 201, game + ": " + c.error);
    assert.equal(c.game.rev, 0, game + ": a new match");
    let last = c.game;
    for (const p of c.game.players.filter((x) => x.name !== "Ann")) last = (await h.room.gameAccept(c.game.id, p.name, R)).game;
    assert.equal(last.status, "running", game);
    assert.ok(last.rev > 0, game + ": the accepts are stored changes");
    assert.equal(h.room.listGames().games.find((g) => g.id === c.game.id).rev, last.rev, game + ": the list");
  }
  for (const f of frames) {
    assert.equal(f.rev, f.stored, "a frame carries the rev of the row it describes");
    assert.ok(f.same, "a frame describes the row as stored");
  }
});
