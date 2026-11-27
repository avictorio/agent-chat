// The agent key's identity object and the creation counters
// (worker/room/agent.ts) on the real Room class over node:sqlite
// (room-harness.mjs): made once, opened with its verifier only, a list
// swapped on its version, dropped whole (handing back the list as it stood
// when the key was cut); nothing written by a probe of an object that
// holds no identity; every method refusing on a room, and a room's
// create() and createGenesis() refusing on an identity; the counters'
// caps, their windows by the object's own clock (an hour's and a day's
// turn included), release, and the peek that only reads them. Run with
// `npm run test:unit`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeRoom } from "./room-harness.mjs";

const V = "a".repeat(64), W = "b".repeat(64);
/** the object's tables (Cloudflare's own and SQLite's aside) */
const tables = (h) => h.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name);
/** SQLite's count of rows written so far on this database */
const changes = (h) => h.db.prepare("SELECT total_changes() AS n").get().n;

test("agentMake makes the identity once; a second is refused exists", () => {
  const h = makeRoom({ bare: true });
  assert.deepEqual(tables(h), []);
  const r = h.room.agentMake(V, "wrapped-dk", "sealed-ring");
  assert.equal(r.ok, true);
  assert.ok(Math.abs(r.created - Date.now()) < 5000);
  assert.deepEqual(tables(h), ["ak", "aks"]);
  assert.deepEqual({ ...h.one("SELECT k, ver, client, ring FROM ak") }, { k: 1, ver: 1, client: null, ring: "sealed-ring" });
  assert.deepEqual({ ...h.one("SELECT slot, kind, verifier, wrapped, expires, used, bind, next FROM aks") }, { slot: "key", kind: "key", verifier: V, wrapped: "wrapped-dk", expires: null, used: null, bind: null, next: null });
  assert.deepEqual(h.room.agentMake(W, "x", "y"), { ok: false, code: "exists" });
  assert.equal(h.one("SELECT verifier FROM aks").verifier, V, "the first stays");
});

/** every row of every table of the object, as it is stored */
const rows = (h) => tables(h).map((t) => [t, h.all("SELECT * FROM \"" + t + "\" ORDER BY rowid")]);

test("agentOpen answers the right verifier only, and an open, good or wrong, writes nothing at all", () => {
  const h = makeRoom({ bare: true });
  const made = h.room.agentMake(V, "wrapped-dk", "sealed-ring");
  const stored = JSON.stringify(rows(h));
  const before = changes(h);
  assert.deepEqual(h.room.agentOpen("key", V), { ok: true, wrapped: "wrapped-dk", ver: 1, ring: "sealed-ring", created: made.created });
  assert.equal(changes(h), before, "a good open writes nothing");
  for (const [slot, verifier] of [["key", W], ["key", V.slice(1)], ["key", ""], ["access", V], ["", V]]) assert.deepEqual(h.room.agentOpen(slot, verifier), { ok: false }, slot + " " + verifier.slice(0, 4));
  assert.equal(changes(h), before, "no write");
  assert.equal(JSON.stringify(rows(h)), stored, "the object's rows byte for byte as they were");
  // a slot with an expires set is no different: nothing here drops rows
  h.db.prepare("UPDATE aks SET expires = 1").run();
  const stale = JSON.stringify(rows(h)), n = changes(h);
  assert.equal(h.room.agentOpen("key", V).ok, true);
  assert.equal(changes(h), n);
  assert.equal(JSON.stringify(rows(h)), stale);
});

test("an open, a swap or a drop on an object never made leaves no table and writes nothing", async () => {
  const h = makeRoom({ bare: true });
  assert.deepEqual(h.room.agentOpen("key", V), { ok: false });
  assert.deepEqual(h.room.agentSwap("key", V, 1, "x"), { ok: false });
  assert.deepEqual(await h.room.agentDrop("key", V), { ok: false });
  assert.equal(h.room.agentPeek([{ k: "net:abc", max: 1, per: 3600 }]), 0, "a peek on a fresh object: nothing full");
  assert.equal(h.room.agentGlanceTake(1000), 0, "the gap is memory only");
  assert.deepEqual(tables(h), [], "sqlite_master empty after");
  assert.equal(changes(h), 0);
});

test("a swap moves the version on; a stale one is refused, and a swap with a wrong verifier too", () => {
  const h = makeRoom({ bare: true });
  h.room.agentMake(V, "wrapped-dk", "ring-1");
  assert.deepEqual(h.room.agentSwap("key", V, 1, "ring-2"), { ok: true });
  assert.deepEqual({ ...h.one("SELECT ver, ring FROM ak") }, { ver: 2, ring: "ring-2" });
  assert.deepEqual(h.room.agentSwap("key", V, 1, "ring-stale"), { ok: false, code: "stale" }, "read at version 1, now 2");
  assert.deepEqual(h.room.agentSwap("key", W, 2, "ring-thief"), { ok: false }, "a wrong verifier swaps nothing");
  assert.deepEqual({ ...h.one("SELECT ver, ring FROM ak") }, { ver: 2, ring: "ring-2" });
  assert.equal(h.room.agentOpen("key", V).ver, 2);
});

test("agentDrop deletes the whole identity and hands back the list as it was: no table left, the key opens nothing", async () => {
  const h = makeRoom({ bare: true });
  h.room.agentMake(V, "wrapped-dk", "ring-1");
  h.room.agentSwap("key", V, 1, "ring-2");
  assert.deepEqual(await h.room.agentDrop("key", W), { ok: false }, "a wrong verifier drops nothing");
  assert.deepEqual(tables(h), ["ak", "aks"]);
  assert.deepEqual(await h.room.agentDrop("key", V), { ok: true, ver: 2, ring: "ring-2" }, "the list's version and sealed list as they stood");
  assert.deepEqual(tables(h), []);
  assert.deepEqual(h.room.agentOpen("key", V), { ok: false });
  assert.deepEqual(h.room.agentSwap("key", V, 1, "x"), { ok: false });
  assert.deepEqual(await h.room.agentDrop("key", V), { ok: false }, "a second drop finds nothing");
});

test("agentDrop cuts the key before its storage goes: an open or a swap that lands in between is refused", async () => {
  const h = makeRoom({ bare: true });
  h.room.agentMake(V, "wrapped-dk", "ring-1");
  // hold deleteAll: the slot is already gone when it starts
  const real = h.room.ctx.storage.deleteAll;
  let release;
  h.room.ctx.storage.deleteAll = () => new Promise((r) => { release = () => r(real()); });
  const drop = h.room.agentDrop("key", V);
  assert.deepEqual(h.room.agentOpen("key", V), { ok: false }, "an open after the cut");
  assert.deepEqual(h.room.agentSwap("key", V, 1, "raced"), { ok: false }, "a swap after the cut");
  release();
  assert.deepEqual(await drop, { ok: true, ver: 1, ring: "ring-1" });
  h.room.ctx.storage.deleteAll = real;
  assert.deepEqual(tables(h), []);
});

test("agentGlanceTake: once per gap, in memory only", () => {
  const h = makeRoom({ bare: true });
  h.room.agentMake(V, "w", "r");
  const before = changes(h);
  assert.equal(h.room.agentGlanceTake(15000), 0);
  const wait = h.room.agentGlanceTake(15000);
  assert.ok(wait >= 14 && wait <= 15, String(wait));
  assert.equal(h.room.agentGlanceTake(0), 0, "a gap of nothing passes");
  assert.equal(changes(h), before, "no write");
  assert.equal(h.restart().agentGlanceTake(15000), 0, "an evicted object forgets it");
});

test("every agent method refuses on a room, and writes nothing there", async () => {
  const h = makeRoom();
  h.member("Ada", "agent");
  const before = tables(h), n = changes(h);
  assert.deepEqual(h.room.agentMake(V, "w", "r"), { ok: false, code: "not_identity" });
  assert.deepEqual(h.room.agentOpen("key", V), { ok: false });
  assert.deepEqual(h.room.agentSwap("key", V, 1, "r"), { ok: false });
  assert.deepEqual(await h.room.agentDrop("key", V), { ok: false });
  assert.equal(h.room.agentReserve([{ k: "all", max: 10, per: "day" }]), false);
  h.room.agentRelease(["all:2026-11-27"]);
  assert.deepEqual(tables(h), before, "no table made");
  assert.equal(changes(h), n, "no write");
  assert.equal(h.one("SELECT name FROM inv").name, "Ada", "the room is as it was");
});

test("create() and createGenesis() refuse on an identity, which stays as it was", () => {
  const h = makeRoom({ bare: true });
  h.room.agentMake(V, "w", "r");
  assert.equal(h.room.create(), false);
  assert.deepEqual(h.room.createGenesis("Ada"), { existed: true });
  assert.deepEqual(tables(h), ["ak", "aks"], "no room schema step ran");
  assert.equal(h.room.exists(), false);
  assert.deepEqual(h.room.agentOpen("key", V).ok, true);
  // and a fresh object can still be made a room (the guard is the identity's table only)
  const r = makeRoom({ bare: true });
  assert.equal(r.room.create(), true);
  assert.deepEqual(r.room.agentMake(V, "w", "r"), { ok: false, code: "not_identity" });
});

/** runs fn with Date.now() reading at (ms) */
function at(ms, fn) {
  const real = Date.now;
  Date.now = () => ms;
  try { return fn(); } finally { Date.now = real; }
}
const T = Date.UTC(2026, 10, 27, 5, 30);
const caps = (room) => [{ k: "net:abc", max: 3, per: 3600 }, { k: "all", max: 100, per: "day" }, { k: "room:" + room, max: 2, per: "day" }];

test("agentReserve checks every cap and takes a place in each, in the window its own clock gives; a full one answers the seconds left; release gives back", () => {
  const h = makeRoom({ bare: true });
  const hour = "2026-11-27T05:00", day = "2026-11-27";
  assert.deepEqual(at(T, () => h.room.agentReserve(caps("r1"))), ["net:abc:" + hour, "all:" + day, "room:r1:" + day], "the keys of the places taken");
  assert.ok(Array.isArray(at(T, () => h.room.agentReserve(caps("r1")))));
  const wait = at(T, () => h.room.agentReserve(caps("r1")));
  assert.equal(wait, 18.5 * 3600, "the room's day is full: the seconds to midnight");
  assert.deepEqual(h.all("SELECT k, w, n FROM aq ORDER BY k").map((r) => [r.k, r.w, r.n]), [["all:" + day, day, 2], ["net:abc:" + hour, hour, 2], ["room:r1:" + day, day, 2]], "a refused call took no place");
  const r2 = at(T, () => h.room.agentReserve(caps("r2")));
  assert.ok(Array.isArray(r2), "another room");
  assert.equal(at(T, () => h.room.agentReserve(caps("r3"))), 30 * 60, "the network's window is full: the seconds to its end");
  h.room.agentRelease(r2);
  assert.equal(h.one("SELECT n FROM aq WHERE k = ?", "net:abc:" + hour).n, 2);
  assert.equal(h.one("SELECT n FROM aq WHERE k = ?", "room:r2:" + day).n, 0);
  h.room.agentRelease(r2);
  assert.equal(h.one("SELECT n FROM aq WHERE k = ?", "room:r2:" + day).n, 0, "never below 0");
  // the counters' object is no identity, and agentReserve refuses on one
  const id = makeRoom({ bare: true });
  id.room.agentMake(V, "w", "r");
  assert.equal(id.room.agentReserve(caps("r1")), false);
  assert.deepEqual(tables(id), ["ak", "aks"]);
});

test("at an hour's and a day's turn, the counters count in the new windows and drop only the ended ones", () => {
  const h = makeRoom({ bare: true });
  const before = Date.UTC(2026, 10, 27, 23, 59, 59, 999), after = Date.UTC(2026, 10, 28, 0, 0, 0, 1);
  assert.ok(Array.isArray(at(before, () => h.room.agentReserve(caps("r1")))));
  assert.deepEqual(h.all("SELECT w FROM aq ORDER BY w").map((r) => r.w), ["2026-11-27", "2026-11-27", "2026-11-27T23:00"]);
  // the first creation after the turn: the old windows' rows go, the new ones are counted from 1
  assert.ok(Array.isArray(at(after, () => h.room.agentReserve(caps("r1")))));
  assert.deepEqual(h.all("SELECT k, n FROM aq ORDER BY k").map((r) => [r.k, r.n]), [["all:2026-11-28", 1], ["net:abc:2026-11-28T00:00", 1], ["room:r1:2026-11-28", 1]]);
  // a second one just after: the new rows are kept and counted on (the route sends no window, so a request
  // that set out before the turn cannot clear what the new windows hold)
  assert.ok(Array.isArray(at(after + 5, () => h.room.agentReserve(caps("r1")))));
  assert.deepEqual(h.all("SELECT k, n FROM aq ORDER BY k").map((r) => [r.k, r.n]), [["all:2026-11-28", 2], ["net:abc:2026-11-28T00:00", 2], ["room:r1:2026-11-28", 2]]);
  assert.equal(at(after + 10, () => h.room.agentReserve(caps("r1"))), Math.ceil((Date.UTC(2026, 10, 29) - after - 10) / 1000), "the room's new day is full");
});

test("the test hook lowers the caps only under TEST_HOOKS", () => {
  const live = makeRoom({ bare: true });
  assert.deepEqual(live.room.setTestAgentLimits({ per_ip: 1 }), { error: "Not found" });
  assert.deepEqual(tables(live), []);
  const t = makeRoom({ bare: true, env: { TEST_HOOKS: "1" } });
  assert.deepEqual(t.room.setTestAgentLimits({ per_ip: 1, glance_gap_ms: 5 }), { agent_limits: { glance_gap_ms: 5, per_ip: 1 } });
  const cap = [{ k: "net:abc", max: 10, per: 3600 }];
  assert.ok(Array.isArray(t.room.agentReserve(cap)));
  assert.equal(typeof t.room.agentReserve(cap), "number", "lowered to 1");
  assert.deepEqual(t.room.setTestAgentLimits(null), { agent_limits: {} });
  assert.ok(Array.isArray(t.room.agentReserve(cap)), "back to the constant");
});

test("agentPeek answers what agentReserve would, and writes nothing: no table made, no place taken, no past window dropped", () => {
  const h = makeRoom({ bare: true });
  assert.equal(at(T, () => h.room.agentPeek(caps("r1"))), 0, "no table: nothing full");
  assert.deepEqual(tables(h), [], "a peek makes no table");
  assert.equal(changes(h), 0);
  at(T, () => h.room.agentReserve(caps("r1")));
  at(T, () => h.room.agentReserve(caps("r1")));
  const counted = h.all("SELECT k, w, n FROM aq ORDER BY k");
  const before = changes(h);
  assert.equal(at(T, () => h.room.agentPeek(caps("r1"))), 18.5 * 3600, "the room's day is full: the seconds to midnight, as agentReserve says");
  assert.equal(at(T, () => h.room.agentReserve(caps("r1"))), 18.5 * 3600);
  assert.equal(at(T, () => h.room.agentPeek(caps("r2"))), 0, "another room has room");
  // a later window: the peek counts it fresh and drops nothing of the ended one
  assert.equal(at(T + 86400e3, () => h.room.agentPeek(caps("r1"))), 0);
  assert.equal(changes(h), before, "nothing written");
  assert.deepEqual(h.all("SELECT k, w, n FROM aq ORDER BY k"), counted);
  // on an identity or a room, refused
  const id = makeRoom({ bare: true });
  id.room.agentMake(V, "w", "r");
  assert.equal(id.room.agentPeek(caps("r1")), false);
  assert.equal(makeRoom().room.agentPeek(caps("r1")), false);
  // the test hook's lowered caps count, as in agentReserve
  const t = makeRoom({ bare: true, env: { TEST_HOOKS: "1" } });
  t.room.setTestAgentLimits({ per_ip: 1 });
  const cap = [{ k: "net:abc", max: 10, per: 3600 }];
  assert.equal(t.room.agentPeek(cap), 0);
  t.room.agentReserve(cap);
  assert.ok(t.room.agentPeek(cap) > 0, "lowered to 1, now full");
});
