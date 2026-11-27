// The agent key's identity object and the creation counters
// (worker/room/agent.ts) on the real Room class over node:sqlite
// (room-harness.mjs): made once, opened with its verifier only, a list
// swapped on its version, dropped whole; nothing written by a probe of an
// object that holds no identity; every method refusing on a room, and a
// room's create() and createGenesis() refusing on an identity; the
// counters' caps, windows and release. Run with `npm run test:unit`.
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

test("agentOpen answers the right verifier only, and a wrong one writes nothing", () => {
  const h = makeRoom({ bare: true });
  const made = h.room.agentMake(V, "wrapped-dk", "sealed-ring");
  assert.deepEqual(h.room.agentOpen("key", V), { ok: true, wrapped: "wrapped-dk", ver: 1, ring: "sealed-ring", created: made.created });
  const before = changes(h);
  for (const [slot, verifier] of [["key", W], ["key", V.slice(1)], ["key", ""], ["access", V], ["", V]]) assert.deepEqual(h.room.agentOpen(slot, verifier), { ok: false }, slot + " " + verifier.slice(0, 4));
  assert.equal(changes(h), before, "no write");
});

test("an open, a swap or a drop on an object never made leaves no table and writes nothing", async () => {
  const h = makeRoom({ bare: true });
  assert.deepEqual(h.room.agentOpen("key", V), { ok: false });
  assert.deepEqual(h.room.agentSwap("key", V, 1, "x"), { ok: false });
  assert.deepEqual(await h.room.agentDrop("key", V), { ok: false });
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

test("agentDrop deletes the whole identity: no table left, the key opens nothing", async () => {
  const h = makeRoom({ bare: true });
  h.room.agentMake(V, "wrapped-dk", "ring-1");
  assert.deepEqual(await h.room.agentDrop("key", W), { ok: false }, "a wrong verifier drops nothing");
  assert.deepEqual(tables(h), ["ak", "aks"]);
  assert.deepEqual(await h.room.agentDrop("key", V), { ok: true });
  assert.deepEqual(tables(h), []);
  assert.deepEqual(h.room.agentOpen("key", V), { ok: false });
  assert.deepEqual(h.room.agentSwap("key", V, 1, "x"), { ok: false });
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
  assert.equal(h.room.agentReserve([{ k: "all:2026-11-27", w: "2026-11-27", max: 10, ends: Date.now() + 1000 }]), false);
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

test("agentReserve checks every cap and takes a place in each; a full one answers the seconds left; release gives back", () => {
  const h = makeRoom({ bare: true });
  const now = Date.now();
  const hour = "2026-11-27T05:00", day = "2026-11-27";
  const caps = (room) => [{ k: "net:abc:" + hour, w: hour, max: 3, ends: now + 120000 }, { k: "all:" + day, w: day, max: 100, ends: now + 3600000 }, { k: "room:" + room + ":" + day, w: day, max: 2, ends: now + 3600000 }];
  assert.equal(h.room.agentReserve(caps("r1")), true);
  assert.equal(h.room.agentReserve(caps("r1")), true);
  const wait = h.room.agentReserve(caps("r1"));
  assert.ok(typeof wait === "number" && wait > 3500 && wait <= 3600, "the room's day is full: its window's seconds, " + wait);
  assert.deepEqual(h.all("SELECT k, n FROM aq ORDER BY k").map((r) => [r.k, r.n]), [["all:" + day, 2], ["net:abc:" + hour, 2], ["room:r1:" + day, 2]], "a refused call took no place");
  assert.equal(h.room.agentReserve(caps("r2")), true, "another room");
  const full = h.room.agentReserve(caps("r3"));
  assert.ok(typeof full === "number" && full > 100 && full <= 120, "the network's window is full: " + full);
  h.room.agentRelease(caps("r2").map((c) => c.k));
  assert.equal(h.one("SELECT n FROM aq WHERE k = ?", "net:abc:" + hour).n, 2);
  assert.equal(h.one("SELECT n FROM aq WHERE k = ?", "room:r2:" + day).n, 0);
  h.room.agentRelease(caps("r2").map((c) => c.k));
  assert.equal(h.one("SELECT n FROM aq WHERE k = ?", "room:r2:" + day).n, 0, "never below 0");
  // a later window drops the rows of the past ones
  const nextHour = "2026-11-27T06:00", nextDay = "2026-11-28";
  assert.equal(h.room.agentReserve([{ k: "net:abc:" + nextHour, w: nextHour, max: 3, ends: now + 1000 }, { k: "all:" + nextDay, w: nextDay, max: 100, ends: now + 1000 }]), true);
  assert.deepEqual(h.all("SELECT k FROM aq ORDER BY k").map((r) => r.k), ["all:" + nextDay, "net:abc:" + nextHour]);
  // the counters' object is no identity, and agentReserve refuses on one
  const id = makeRoom({ bare: true });
  id.room.agentMake(V, "w", "r");
  assert.equal(id.room.agentReserve(caps("r1")), false);
  assert.deepEqual(tables(id), ["ak", "aks"]);
});

test("the test hook lowers the caps only under TEST_HOOKS", () => {
  const live = makeRoom({ bare: true });
  assert.deepEqual(live.room.setTestAgentLimits({ per_ip: 1 }), { error: "Not found" });
  assert.deepEqual(tables(live), []);
  const t = makeRoom({ bare: true, env: { TEST_HOOKS: "1" } });
  assert.deepEqual(t.room.setTestAgentLimits({ per_ip: 1, glance_gap_ms: 5 }), { agent_limits: { glance_gap_ms: 5, per_ip: 1 } });
  const hour = "2026-11-27T05:00";
  const cap = [{ k: "net:abc:" + hour, w: hour, max: 10, ends: Date.now() + 1000 }];
  assert.equal(t.room.agentReserve(cap), true);
  assert.equal(typeof t.room.agentReserve(cap), "number", "lowered to 1");
  assert.deepEqual(t.room.setTestAgentLimits(null), { agent_limits: {} });
  assert.equal(t.room.agentReserve(cap), true, "back to the constant");
});
