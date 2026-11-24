// Ended matches' results (gr, schema step 6), on the real Room class
// (room-harness.mjs). The games list, the record, the ladder and Duel's
// head-to-head used to re-read and parse every stored match state on every
// call; they now read gr. These tests hold them to the answers the old
// code gave (its functions are kept below as the reference, not in the
// Worker), for matches played by the engines, for rows the schema step
// backfilled, and check a list in a long history parses no ended state.
import test from "node:test";
import assert from "node:assert/strict";
import { makeRoom } from "./room-harness.mjs";
import { GAME_ENGINES } from "../../worker/games/engine.ts";

const R = "unit";
const NAMES = ["Ann", "Bob", "Cy", "Dee", "Eve"];

/* ---------- the reference: the functions as they were before gr ---------- */

function oldListGames(room) {
  const scanned = room.sql.exec("SELECT id FROM gm ORDER BY id DESC LIMIT 500").toArray();
  const all = scanned.map((r) => {
    const g = room.gameRow(r.id);
    if (!g || !g.st) return null;
    const s = room.gameSummary(g);
    if (s) {
      s.targets = room.gameTargets(g, s);
      if (s.boards) delete s.boards;
      s.created = g.created;
      s.ended = (g.st && g.st.ended) || null;
    }
    return s;
  }).filter(Boolean);
  const live = all.filter((g) => g.status === "lobby" || g.status === "running").slice(0, 100);
  const done = all.filter((g) => g.status !== "lobby" && g.status !== "running");
  const byType = {};
  const placed = (row, places, name) => {
    const k = Array.isArray(places) ? places.indexOf(name) : -1;
    if (k === 1) row.p2 = (row.p2 || 0) + 1;
    else if (k === 2) row.p3 = (row.p3 || 0) + 1;
  };
  done.forEach((g) => {
    if (g.status !== "finished" || (!g.winner && !(g.winners && g.winners.length))) return;
    const table = byType[g.type] || (byType[g.type] = {});
    (g.players || []).forEach((p) => {
      const row = table[p.name] || (table[p.name] = { name: p.name, hex: p.hex, w: 0, l: 0 });
      if (g.winners ? g.winners.indexOf(p.name) >= 0 : p.name === g.winner) row.w++;
      else row.l++;
      placed(row, g.places, p.name);
    });
  });
  if (scanned.length === 500) {
    const floor = scanned[scanned.length - 1].id;
    const rows = room.sql.exec("SELECT json_extract(gm.state, '$.type') AS t, json_extract(gm.state, '$.winner') AS w, json_extract(gm.state, '$.winners') AS ws, json_extract(gm.state, '$.places') AS places, json_extract(pl.value, '$.name') AS name, json_extract(pl.value, '$.hex') AS hex FROM gm, json_each(gm.state, '$.players') AS pl WHERE gm.status = 'finished' AND gm.id < ?", floor).toArray();
    for (const r of rows) {
      if ((!r.w && !r.ws) || !r.name) continue;
      const type = GAME_ENGINES[r.t] ? r.t : "lightcycles";
      const table = byType[type] || (byType[type] = {});
      const row = table[r.name] || (table[r.name] = { name: r.name, hex: r.hex || null, w: 0, l: 0 });
      let ws = null;
      if (r.ws) { try { ws = JSON.parse(r.ws); } catch { ws = null; } }
      if (ws ? ws.indexOf(r.name) >= 0 : r.name === r.w) row.w++;
      else row.l++;
      if (r.places) placed(row, JSON.parse(r.places), r.name);
    }
  }
  const record = {};
  Object.keys(byType).forEach((t) => {
    record[t] = Object.values(byType[t]).sort((a, b) => b.w - a.w || a.l - b.l || (a.name < b.name ? -1 : 1));
  });
  return { games: live.concat(done).slice(0, 40), record, ladder: oldLadder(room) };
}

function oldLadder(room) {
  const ladder = {};
  const rows = room.sql.exec("SELECT id, json_extract(state, '$.type') AS t, json_extract(state, '$.winner') AS w, json_extract(state, '$.draw') AS d, json_extract(state, '$.players') AS ps FROM gm WHERE status = 'finished' ORDER BY id").toArray();
  for (const r of rows) {
    const ps = JSON.parse(r.ps || "[]");
    if (!Array.isArray(ps) || ps.length !== 2) continue;
    const [a, b] = ps;
    let sa;
    if (r.w && r.w === a.name) sa = 1;
    else if (r.w && r.w === b.name) sa = 0;
    else if (r.d) sa = 0.5;
    else continue;
    const type = GAME_ENGINES[r.t] ? r.t : "lightcycles";
    const table = ladder[type] || (ladder[type] = {});
    const seat = (p) => {
      const x = table[p.name] || (table[p.name] = { name: p.name, hex: null, rating: 1000, w: 0, l: 0, d: 0, last: 0 });
      if (p.hex) x.hex = p.hex;
      return x;
    };
    const ra = seat(a), rb = seat(b);
    const ea = 1 / (1 + Math.pow(10, (rb.rating - ra.rating) / 400));
    const da = 32 * (sa - ea);
    ra.rating += da;
    rb.rating -= da;
    ra.last = da;
    rb.last = -da;
    if (sa === 1) { ra.w++; rb.l++; }
    else if (sa === 0) { ra.l++; rb.w++; }
    else { ra.d++; rb.d++; }
  }
  const out = {};
  Object.keys(ladder).forEach((t) => {
    out[t] = Object.values(ladder[t])
      .map((x) => ({ name: x.name, hex: x.hex, rating: Math.round(x.rating), w: x.w, l: x.l, d: x.d, last: Math.round(x.last) }))
      .sort((x, y) => y.rating - x.rating || (x.name < y.name ? -1 : 1));
  });
  return out;
}

function oldDuelH2H(room, st) {
  const pair = st.players.map((p) => p.name).sort().join("|");
  const tally = {};
  let total = 0;
  for (const r of room.sql.exec("SELECT state FROM gm WHERE status = 'finished'").toArray()) {
    const s = JSON.parse(r.state || "{}");
    if (s.type !== "duel" || !s.winner || !Array.isArray(s.players)) continue;
    if (s.players.map((p) => p.name).sort().join("|") !== pair) continue;
    tally[s.winner] = (tally[s.winner] || 0) + 1;
    total++;
  }
  return total ? { tally: tally, total: total } : null;
}

/* ---------- a room with a history, played by the engines ---------- */

/** a seeded random: the same history on every run */
function seeded(seed) {
  let x = seed >>> 0;
  return () => { x = (x * 1664525 + 1013904223) >>> 0; return x / 4294967296; };
}

/** plays match id to its end: each seat plays a legal move when its state
 *  offers some, and a clock with nobody moving is run out */
async function playOut(h, id, seats, rnd) {
  for (let i = 0; i < 400; i++) {
    if (h.room.gameRow(id).status !== "running") return;
    let moved = false;
    for (const n of seats) {
      const f = (await h.room.gameState(id, n, R)).game;
      const lm = f.you && f.you.legal_moves;
      if (f.status === "running" && lm && lm.length && (await h.room.gameMove(id, n, lm[Math.floor(rnd() * lm.length)], R)).status === 200) moved = true;
    }
    if (!moved) {
      const g = h.room.gameRow(id);
      g.st.deadline = Date.now() - 1;
      h.room.saveGame(g);
      await h.room.gameState(id, seats[0], R);
    }
  }
}

/** creates a match of game at the smallest table it takes from sizes,
 *  every seat accepted; null when it takes none of them */
async function start(h, game, sizes, rnd) {
  for (const n of sizes) {
    const seats = NAMES.slice(0, n);
    // a different seat order each time, so ladders and pairs mix
    if (rnd() < 0.5) seats.reverse();
    const c = await h.room.createGame(seats[0], seats, { game }, R);
    if (c.status !== 201) continue;
    for (const s of seats.slice(1)) assert.equal((await h.room.gameAccept(c.game.id, s, R)).status, 200);
    return { id: c.game.id, seats };
  }
  return null;
}

/** a room with every game played out, cancelled and declined, duels and
 *  Four in a Row played again and again, and matches still live */
async function history() {
  const h = makeRoom();
  for (const n of NAMES) h.member(n);
  // signs Sketch & Guess drawing links (relist)
  h.room.roomName = R;
  const rnd = seeded(7);
  const games = Object.keys(GAME_ENGINES);
  for (let pass = 0; pass < 2; pass++) {
    for (const game of games) {
      const m = await start(h, game, [2, 3, 5], rnd);
      assert.ok(m, game + " starts");
      await playOut(h, m.id, m.seats, rnd);
    }
  }
  for (let i = 0; i < 12; i++) {
    for (const game of ["duel", "fourinarow", "trust", "coderace", "werewolf"]) {
      const m = await start(h, game, [2, 3, 5], rnd);
      await playOut(h, m.id, m.seats, rnd);
    }
  }
  // called off: by the creator, by a decline, by an empty lobby
  for (const game of ["duel", "battleship", "trivia"]) {
    const m = await start(h, game, [2, 3], rnd);
    assert.equal((await h.room.gameCancel(m.id, m.seats[0], false, R)).status, 200);
    const c = await h.room.createGame("Ann", ["Ann", "Bob"], { game }, R);
    assert.equal((await h.room.gameDecline(c.game.id, "Bob", R)).status, 200);
  }
  // still live: a lobby and two running matches
  await h.room.createGame("Ann", ["Ann", "Cy"], { game: "duel" }, R);
  await start(h, "fourinarow", [2], rnd);
  const live = await start(h, "duel", [2], rnd);
  return { h, live };
}

const statuses = (h) => Object.fromEntries(h.all("SELECT status, COUNT(*) AS n FROM gm GROUP BY status").map((r) => [r.status, r.n]));

test("the games list, record, ladder and Duel's head-to-head answer as the full scan did", async () => {
  const { h, live } = await history();
  const st = statuses(h);
  assert.ok(st.finished >= 40 && st.cancelled >= 6 && st.running >= 2 && st.lobby >= 1, "a mixed history: " + JSON.stringify(st));
  const types = new Set(h.all("SELECT type FROM gr WHERE status = 'finished'").map((r) => r.type));
  assert.ok(types.size >= 8, "finished matches of many games: " + [...types]);
  assert.ok(h.one("SELECT COUNT(*) AS n FROM gr WHERE winners IS NOT NULL").n > 0, "team wins are in it");
  assert.ok(h.one("SELECT COUNT(*) AS n FROM gr WHERE places IS NOT NULL AND status = 'finished'").n > 0, "placements are in it");
  // one result row for every ended match, and none for a live one
  assert.equal(h.one("SELECT COUNT(*) AS n FROM gr").n, st.finished + st.cancelled);

  const want = oldListGames(h.room);
  assert.ok(Object.keys(want.ladder).length >= 2 && Object.keys(want.record).length >= 5, "the reference has a ladder and a record");
  assert.deepEqual(h.room.listGames(), want);

  // Duel's full state, for every pair that duelled, live and ended
  const duels = h.all("SELECT id FROM gm WHERE json_extract(state, '$.type') = 'duel' AND status IN ('finished', 'running')").map((r) => r.id);
  let shown = 0;
  for (const id of duels) {
    const g = h.room.gameRow(id);
    const ref = oldDuelH2H(h.room, g.st);
    const full = (await h.room.gameState(id, g.st.players[0].name, R)).game;
    assert.deepEqual(full.h2h, ref, "match " + id);
    if (ref) shown++;
  }
  assert.ok(shown >= 3, "some pairs have a record: " + shown);
  const before = (await h.room.gameState(live.id, live.seats[0], R)).game;
  // the live duel plays out: its own result joins the tally
  await playOut(h, live.id, live.seats, seeded(3));
  const after = (await h.room.gameState(live.id, live.seats[0], R)).game;
  assert.equal(after.status, "finished");
  assert.deepEqual(after.h2h, oldDuelH2H(h.room, h.room.gameRow(live.id).st));
  assert.equal(after.h2h.total, (before.h2h ? before.h2h.total : 0) + 1);
  assert.deepEqual(h.room.listGames(), oldListGames(h.room));
});

test("rows the schema step backfilled answer the same, and the list keeps the entries it builds", async () => {
  const { h } = await history();
  const want = oldListGames(h.room);
  const rows = h.all("SELECT id, type, status, ended, winner, winners, draw, places, players, pair FROM gr ORDER BY id");
  // a room as the code before step 6 left it: no gr, five steps run
  h.db.exec("DROP TABLE gr");
  h.db.prepare("UPDATE cfg SET v = '5' WHERE k = 'schema_version'").run();
  h.restart().ensureSchema();
  // every step from 6 on ran (steps 7 and 8, the Muse and webhook hooks, came after this one)
  assert.equal(h.one("SELECT v FROM cfg WHERE k = 'schema_version'").v, "8");
  const back = h.all("SELECT id, type, status, ended, winner, winners, draw, places, players, pair FROM gr ORDER BY id");
  assert.deepEqual(back, rows, "the backfill reads what saveGame writes");
  assert.equal(h.one("SELECT COUNT(*) AS n FROM gr WHERE pub IS NULL").n, rows.length);
  assert.deepEqual(h.room.listGames(), want);
  assert.ok(h.one("SELECT COUNT(*) AS n FROM gr WHERE pub IS NOT NULL").n > 0, "the list kept the entries it built");
  // a second list reads the kept entries, and nothing in gm changed
  assert.deepEqual(h.room.listGames(), want);
  const g = h.all("SELECT id FROM gm WHERE status = 'finished' AND json_extract(state, '$.type') = 'duel'")[0];
  assert.deepEqual((await h.room.gameState(g.id, "Ann", R)).game.h2h, oldDuelH2H(h.room, h.room.gameRow(g.id).st));
  // running the step again changes nothing
  h.db.prepare("UPDATE cfg SET v = '5' WHERE k = 'schema_version'").run();
  h.room.ensureSchema();
  assert.deepEqual(h.room.listGames(), want);
});

test("a games list and a Duel read in a room of 2,000 finished matches parse no ended match's state", async () => {
  const h = makeRoom();
  for (const n of NAMES) h.member(n);
  for (let i = 0; i < 2000; i++) {
    const [a, b] = i % 3 ? ["Ann", "Bob"] : ["Cy", "Dee"];
    const c = await h.room.createGame(a, [a, b], { game: "duel", best_of: 1 }, R);
    await h.room.gameAccept(c.game.id, b, R);
    await h.room.gameMove(c.game.id, a, i % 2 ? "rock" : "paper", R);
    await h.room.gameMove(c.game.id, b, "scissors", R);
  }
  const c = await h.room.createGame("Ann", ["Ann", "Bob"], { game: "duel" }, R);
  await h.room.gameAccept(c.game.id, "Bob", R);
  // count every state read: gameRow and any SELECT of gm.state
  const ended = new Set(h.all("SELECT id FROM gm WHERE status = 'finished'").map((r) => r.id));
  let rowReads = 0, stateScans = 0;
  const gameRow = h.room.gameRow.bind(h.room);
  h.room.gameRow = (id) => { if (ended.has(id)) rowReads++; return gameRow(id); };
  const exec = h.room.sql.exec.bind(h.room.sql);
  h.room.sql = { exec: (q, ...p) => { if (/\bstate\b/.test(q) && !/WHERE id = \?|status IN \('running', 'lobby'\)|status IN \('lobby', 'running'\)/.test(q)) stateScans++; return exec(q, ...p); } };
  const t0 = performance.now();
  const list = h.room.listGames();
  const listMs = performance.now() - t0;
  const t1 = performance.now();
  const full = (await h.room.gameState(c.game.id, "Ann", R)).game;
  const duelMs = performance.now() - t1;
  assert.equal(rowReads, 0, "no ended match was read as a row");
  assert.equal(stateScans, 0, "no query read the states");
  assert.equal(h.one("SELECT COUNT(*) AS n FROM gr WHERE status = 'finished'").n, 2000);
  assert.equal(list.games.length, 40);
  assert.equal(list.ladder.duel.length, 4);
  assert.equal(full.h2h.total, 1333);
  // the full scan took about 200 ms at this size; the bound is generous
  assert.ok(listMs < 1000, "the list took " + listMs.toFixed(0) + " ms");
  assert.ok(duelMs < 500, "the Duel read took " + duelMs.toFixed(0) + " ms");
});

test("an ended Sketch & Guess match in the list carries a drawing link signed for this read, not the one stored", async () => {
  const PIC = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  const h = makeRoom();
  for (const n of ["Ann", "Bob", "Cat"]) h.member(n);
  const c = await h.room.createGame("Ann", ["Ann", "Bob", "Cat"], { game: "sketch" }, R);
  for (const n of ["Bob", "Cat"]) await h.room.gameAccept(c.game.id, n, R);
  const id = c.game.id;
  const artist = h.room.gameRow(id).st.artist;
  assert.equal((await h.room.gameMove(id, artist, null, R, { image: PIC })).status, 200);
  // round 1 on the record, as its resolution leaves it
  const g = h.room.gameRow(id);
  g.st.rounds = [{ n: 1, artist, prompt: "p", guesses: {}, right: [], missed: [], points: {}, judge: "referee", judge_note: null, roast: null, forfeit: false, at: 0 }];
  h.room.saveGame(g);
  // it ends three hours ago, in an instance with no room name (an alarm's)
  const now = Date.now;
  Date.now = () => now() - 3 * 3600000;
  try { assert.equal((await h.room.gameCancel(id, "Ann", false, R)).status, 200); } finally { Date.now = now; }
  assert.equal(JSON.parse(h.one("SELECT pub FROM gr WHERE id = ?", id).pub).last_round.image.url, null);
  h.room.roomName = R;
  const entry = h.room.listGames().games.find((x) => x.id === id);
  const fresh = h.room.gameSummary(h.room.gameRow(id)).last_round.image.url;
  assert.ok(fresh && /[?&]exp=/.test(fresh), fresh);
  assert.equal(entry.last_round.image.url, fresh);
});
