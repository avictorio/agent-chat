// A sign-in's identity object (worker/room/agent.ts SigninMethods) and an
// app's store (clientNote), on the real Room class on node:sqlite: each
// method's checks; an open that writes nothing, with the access slot's write
// grace and nothing more; expired rows dropped only by writes; the slots a
// swap takes; the drop without a version; the cut, the remainder and the
// drop with one; the room list and its wake list written together, the wake
// list as wakesOf projects it; the store's windows; and the guards between
// sign-ins, keys and rooms. Run with `npm run test:unit`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeRoom } from "./room-harness.mjs";
import { agentSealRing, agentSealWakes, agentUnsealWakes, agentOpenRing, newKeyBytes, wakesOf, newHolderTag } from "../../worker/lib/agentkey.ts";
import { OAUTH_ACCESS_LIVE_MAX, OAUTH_ACCESS_TTL_S, OAUTH_ACCESS_WRITE_GRACE_S, OAUTH_CODE_TTL_S, OAUTH_IDLE_DAYS, OAUTH_KEYSET_REFETCH_S, OAUTH_REFRESH_GRACE_S } from "../../worker/limits.ts";

const CLIENT = "https://standin.example/oauth/public.json";
const v = (name) => "v-" + name;
const slot = (name, bind = { client: CLIENT, wk: "WK-" + name }) => ({ slot: name, verifier: v(name), wrapped: "DK-" + name, bind: JSON.stringify(bind) });
/** a sign-in on a bare object: code slot "c", disconnect slot "d", lists at version 1 */
function made() {
  const h = makeRoom({ bare: true });
  const r = h.room.signinMake(CLIENT, "RING1", "WAKES1", slot("c"), { slot: "d", verifier: v("d"), wrapped: "WK-d", bind: JSON.stringify({ client: CLIENT }) });
  assert.equal(r.ok, true);
  return h;
}
/** the code redeemed into access slot "a1" and refresh slot "r1" */
function redeemed() {
  const h = made();
  assert.deepEqual(h.room.signinRedeem("c", v("c"), { access: slot("a1"), refresh: slot("r1") }), { ok: true, ver: 1 });
  return h;
}
const tables = (h) => JSON.stringify([h.all("SELECT * FROM ak"), h.all("SELECT * FROM aks ORDER BY slot")]);
const shift = (h, col, ms, where) => h.db.prepare("UPDATE aks SET " + col + " = " + col + " - ? WHERE " + where).run(ms);

test("signinMake: the two tables, both lists at version 1, the code slot for OAUTH_CODE_TTL_S, the disconnect slot; refused on a room, on any identity, and twice", () => {
  const h = made();
  assert.deepEqual({ ...h.one("SELECT ver, client, ring, wakes, cut FROM ak") }, { ver: 1, client: CLIENT, ring: "RING1", wakes: "WAKES1", cut: null });
  const c = h.one("SELECT * FROM aks WHERE slot = 'c'");
  assert.deepEqual([c.kind, c.verifier, c.wrapped, c.expires - c.created, c.used], ["code", v("c"), "DK-c", OAUTH_CODE_TTL_S * 1000, null]);
  assert.deepEqual([h.one("SELECT kind FROM aks WHERE slot = 'd'").kind, h.one("SELECT wrapped FROM aks WHERE slot = 'd'").wrapped], ["disconnect", "WK-d"]);
  assert.deepEqual(h.room.signinMake(CLIENT, "R", "W", slot("x"), null), { ok: false, code: "exists" });
  const room = makeRoom();
  assert.deepEqual(room.room.signinMake(CLIENT, "R", "W", slot("x"), null), { ok: false, code: "not_identity" });
  const key = makeRoom({ bare: true });
  assert.ok(key.room.agentMake("kv", "kw", "kr").ok);
  assert.deepEqual(key.room.signinMake(CLIENT, "R", "W", slot("x"), null), { ok: false, code: "exists" });
  const none = makeRoom({ bare: true });
  assert.ok(none.room.signinMake(CLIENT, "R", "W", slot("x"), null).ok, "no disconnect slot with the switch off");
  assert.deepEqual(none.all("SELECT kind FROM aks").map((x) => x.kind), ["code"]);
});

test("signinOpen: the verifier and the kind; live slots only, spent ones with spent, an access slot within the grace with grace, never a revoked one or one of a cut sign-in; idle; it writes nothing", () => {
  const h = redeemed();
  const before = tables(h);
  assert.equal(h.room.signinOpen("a1", v("a1"), ["access"]).ok, true);
  assert.deepEqual(h.room.signinOpen("a1", "wrong", ["access"]), { ok: false });
  assert.deepEqual(h.room.signinOpen("a1", v("a1"), ["refresh"]), { ok: false }, "another kind");
  assert.deepEqual(h.room.signinOpen("d", v("d"), ["disconnect"]), { ok: false }, "the disconnect slot never opens");
  assert.deepEqual(h.room.signinOpen("c", v("c"), ["code"]), { ok: false }, "a redeemed code");
  const spentCode = h.room.signinOpen("c", v("c"), ["code"], { spent: true });
  assert.deepEqual([spentCode.ok, spentCode.spent], [true, true]);
  const o = h.room.signinOpen("r1", v("r1"), ["refresh"]);
  assert.deepEqual([o.ok, o.kind, o.wrapped, o.wk, o.ver, o.ring, o.wakes, o.bind.client, o.idle, o.spent, o.client], [true, "refresh", "DK-r1", "WK-r1", 1, "RING1", "WAKES1", CLIENT, false, false, CLIENT]);
  assert.equal(tables(h), before, "opens wrote nothing");
  // the grace: an access slot expired 59 s ago opens with grace, not without; 61 s ago, neither
  shift(h, "expires", OAUTH_ACCESS_TTL_S * 1000 + (OAUTH_ACCESS_WRITE_GRACE_S - 1) * 1000, "slot = 'a1'");
  assert.deepEqual([h.room.signinOpen("a1", v("a1"), ["access"]).ok, h.room.signinOpen("a1", v("a1"), ["access"], { grace: true }).ok], [false, true]);
  shift(h, "expires", 2000, "slot = 'a1'");
  assert.deepEqual(h.room.signinOpen("a1", v("a1"), ["access"], { grace: true }), { ok: false }, "61 s past");
  // revoked: no row
  const h2 = redeemed();
  assert.ok(h2.room.signinAccessDrop("a1", v("a1")).ok);
  assert.deepEqual(h2.room.signinOpen("a1", v("a1"), ["access"], { grace: true }), { ok: false });
  // cut: refused, saying so, to a matching slot only
  assert.ok(h2.room.signinCut("r1", v("r1")).ok);
  assert.deepEqual(h2.room.signinOpen("r1", v("r1"), ["refresh"], { spent: true }), { ok: false, cut: true, client: CLIENT });
  assert.deepEqual(h2.room.signinOpen("r1", "wrong", ["refresh"]), { ok: false });
  // idle: the newest refresh slot made more than OAUTH_IDLE_DAYS ago (with none, the code)
  const h3 = redeemed();
  shift(h3, "created", (OAUTH_IDLE_DAYS * 86400 + 60) * 1000, "kind = 'refresh'");
  assert.equal(h3.room.signinOpen("a1", v("a1"), ["access"]).idle, true);
  const h4 = made();
  assert.equal(h4.room.signinOpen("c", v("c"), ["code"]).idle, false);
});

test("signinSwap takes a live unredeemed code, an access slot live or within the grace, an unspent refresh slot; refuses a redeemed code, a revoked access slot, one past the grace, a spent refresh slot, the disconnect slot and every slot of a cut sign-in; stale on a moved version", () => {
  const ok = (h, s, ver = h.one("SELECT ver FROM ak").ver) => h.room.signinSwap(s, v(s), ver, "R" + (ver + 1), "W" + (ver + 1));
  const code = made();
  assert.deepEqual(ok(code, "c"), { ok: true });
  assert.deepEqual(ok(code, "d"), { ok: false }, "the disconnect slot");
  const h = redeemed();
  assert.deepEqual(ok(h, "c"), { ok: false }, "a redeemed code");
  assert.deepEqual(ok(h, "a1"), { ok: true });
  assert.deepEqual(ok(h, "r1"), { ok: true });
  assert.deepEqual(h.room.signinSwap("r1", v("r1"), 1, "x", "y"), { ok: false, code: "stale" });
  shift(h, "expires", OAUTH_ACCESS_TTL_S * 1000 + (OAUTH_ACCESS_WRITE_GRACE_S - 1) * 1000, "slot = 'a1'");
  assert.deepEqual(ok(h, "a1"), { ok: true }, "59 s past its hour: the grace");
  shift(h, "expires", 2000, "slot = 'a1'");
  assert.deepEqual(ok(h, "a1"), { ok: false }, "61 s past");
  assert.equal(h.room.signinRefresh("r1", v("r1"), { access: slot("a2"), refresh: slot("r2") }, "NEXT", null).fresh, true);
  assert.deepEqual(ok(h, "r1"), { ok: false }, "a spent refresh slot");
  assert.deepEqual(ok(h, "a2"), { ok: true });
  assert.ok(h.room.signinAccessDrop("a2", v("a2")).ok);
  assert.deepEqual(ok(h, "a2"), { ok: false }, "a revoked access slot");
  const cut = redeemed();
  assert.ok(cut.room.signinCut("d", v("d")).ok);
  for (const s of ["a1", "r1", "c", "d"]) assert.deepEqual(ok(cut, s), { ok: false }, "cut: " + s);
  // the room list and the wake list written together, at one version
  assert.deepEqual({ ...h.one("SELECT ver, ring, wakes FROM ak") }, { ver: 5, ring: "R5", wakes: "W5" });
});

test("expired rows go only at a write: a code past its minute, an access slot only once it expired more than OAUTH_ACCESS_WRITE_GRACE_S ago, a spent refresh token's pair once its grace is over (its row stays)", () => {
  const h = redeemed();
  assert.ok(h.room.signinRefresh("r1", v("r1"), { access: slot("a2"), refresh: slot("r2") }, "NEXT", null).fresh);
  shift(h, "expires", OAUTH_CODE_TTL_S * 1000 + 1000, "slot = 'c'");
  shift(h, "expires", OAUTH_ACCESS_TTL_S * 1000 + (OAUTH_ACCESS_WRITE_GRACE_S - 5) * 1000, "slot = 'a1'");
  shift(h, "used", (OAUTH_REFRESH_GRACE_S + 1) * 1000, "slot = 'r1'");
  const before = tables(h);
  h.room.signinOpen("a2", v("a2"), ["access"]);
  h.room.signinOpen("r1", v("r1"), ["refresh"], { spent: true });
  assert.equal(tables(h), before, "opens drop nothing");
  assert.ok(h.room.signinSwap("a2", v("a2"), 1, "R", "W").ok);
  const slots = h.all("SELECT slot, next FROM aks ORDER BY slot").map((x) => [x.slot, x.next]);
  assert.deepEqual(slots, [["a1", null], ["a2", null], ["d", null], ["r1", null], ["r2", null]], "the code gone, a1 kept (in its grace), r1's pair gone and its row kept");
  shift(h, "expires", 10000, "slot = 'a1'");
  assert.ok(h.room.signinSwap("a2", v("a2"), 2, "R", "W").ok);
  assert.deepEqual(h.all("SELECT slot FROM aks ORDER BY slot").map((x) => x.slot), ["a2", "d", "r1", "r2"], "a1 past its grace: gone");
});

test("signinRedeem once: the code marked used and its data key gone (its row stays to recognise a reuse), the pair stored; again a reuse; an expired code nothing; at most OAUTH_ACCESS_LIVE_MAX access slots", () => {
  const h = made();
  assert.deepEqual(h.room.signinRedeem("c", "wrong", { access: slot("a1"), refresh: slot("r1") }), { ok: false });
  assert.deepEqual(h.room.signinRedeem("c", v("c"), { access: slot("a1"), refresh: slot("r1") }), { ok: true, ver: 1 });
  const c = h.one("SELECT used, wrapped FROM aks WHERE slot = 'c'");
  assert.ok(c.used > 0 && c.wrapped === null);
  assert.deepEqual(h.room.signinRedeem("c", v("c"), { access: slot("a9"), refresh: slot("r9") }), { ok: false, reuse: true });
  assert.equal(h.all("SELECT slot FROM aks WHERE slot IN ('a9', 'r9')").length, 0, "a reuse writes nothing");
  const old = made();
  shift(old, "expires", OAUTH_CODE_TTL_S * 1000 + 1, "slot = 'c'");
  assert.deepEqual(old.room.signinRedeem("c", v("c"), { access: slot("a1"), refresh: slot("r1") }), { ok: false });
  // the oldest access slots beyond the most kept go
  let rt = "r1";
  for (let i = 2; i < OAUTH_ACCESS_LIVE_MAX + 4; i++) {
    shift(h, "created", 1000, "kind = 'access'");
    assert.equal(h.room.signinRefresh(rt, v(rt), { access: slot("a" + i), refresh: slot("r" + i) }, "NEXT", null).fresh, true);
    rt = "r" + i;
  }
  assert.equal(h.all("SELECT slot FROM aks WHERE kind = 'access'").length, OAUTH_ACCESS_LIVE_MAX);
  assert.deepEqual(h.room.signinOpen("a1", v("a1"), ["access"]), { ok: false }, "the oldest went");
});

test("signinRefresh: fresh once, the same pair within the grace (with next_jkt), a reuse after it; nothing for a cut sign-in", () => {
  const h = redeemed();
  assert.deepEqual(h.room.signinRefresh("r1", v("r1"), { access: slot("a2"), refresh: slot("r2") }, "NEXT", "JKT"), { ok: true, fresh: true });
  assert.equal(JSON.parse(h.one("SELECT bind FROM aks WHERE slot = 'r1'").bind).next_jkt, "JKT");
  assert.deepEqual(h.room.signinRefresh("r1", v("r1"), { access: slot("a3"), refresh: slot("r3") }, "NEXT2", null), { ok: true, fresh: false, next: "NEXT", next_jkt: "JKT" });
  assert.equal(h.all("SELECT slot FROM aks WHERE slot = 'a3'").length, 0, "the repeat's prepared pair discarded");
  shift(h, "used", OAUTH_REFRESH_GRACE_S * 1000, "slot = 'r1'");
  assert.deepEqual(h.room.signinRefresh("r1", v("r1"), null, null, null), { ok: false, reuse: true });
  assert.ok(h.room.signinCut("r2", v("r2")).ok);
  assert.deepEqual(h.room.signinRefresh("r2", v("r2"), { access: slot("a4"), refresh: slot("r4") }, "N", null), { ok: false });
});

test("signinCut from any slot whose verifier matches; then every open, swap, redeem and refresh refused; it answers again to any slot; signinRemain writes only the wake list, stale on a moved version; signinDrop(ver) stale on a moved version", async () => {
  const h = made();
  assert.deepEqual(h.room.signinCut("c", "wrong"), { ok: false });
  const c1 = h.room.signinCut("c", v("c"));
  assert.deepEqual(c1, { ok: true, ver: 1, wakes: "WAKES1", wkWrapped: "WK-c" });
  assert.deepEqual(h.room.signinCut("d", v("d")), { ok: true, ver: 1, wakes: "WAKES1", wkWrapped: "WK-d" }, "the disconnect slot: its wrapped is the wake key");
  assert.deepEqual(h.room.signinOpen("c", v("c"), ["code"]), { ok: false, cut: true, client: CLIENT });
  assert.deepEqual(h.room.signinSwap("c", v("c"), 1, "R", "W"), { ok: false });
  assert.deepEqual(h.room.signinRedeem("c", v("c"), { access: slot("a1"), refresh: slot("r1") }), { ok: false });
  const cutAt = h.one("SELECT cut FROM ak").cut;
  h.room.signinCut("c", v("c"));
  assert.equal(h.one("SELECT cut FROM ak").cut, cutAt, "cut once");
  assert.deepEqual(h.room.signinRemain("c", v("c"), 1, "W2"), { ok: true });
  assert.deepEqual({ ...h.one("SELECT ver, ring, wakes FROM ak") }, { ver: 2, ring: "RING1", wakes: "W2" }, "the room list untouched");
  assert.deepEqual(h.room.signinRemain("c", v("c"), 1, "W3"), { ok: false, code: "stale" });
  assert.deepEqual(await h.room.signinDrop("d", v("d"), 1), { ok: false, code: "stale" });
  assert.deepEqual(await h.room.signinDrop("d", v("d"), 2), { ok: true });
});

test("signinDrop: with a version once every wake settled (stale when it moved); without one only from a code slot not redeemed, live or expired, or on a cut sign-in", async () => {
  {
    const h = made();
    assert.deepEqual(await h.room.signinDrop("c", v("c"), 2), { ok: false, code: "stale" });
    assert.deepEqual(await h.room.signinDrop("d", v("d")), { ok: false }, "the disconnect slot of a sign-in not cut, without a version");
    assert.deepEqual(await h.room.signinDrop("c", v("c")), { ok: true }, "the approval's own failure: the code slot, not redeemed");
    assert.deepEqual(h.all("SELECT name FROM sqlite_master"), [], "all of it gone");
  }
  {
    const h = made();
    shift(h, "expires", OAUTH_CODE_TTL_S * 1000 + 5000, "slot = 'c'");
    assert.deepEqual(await h.room.signinDrop("c", v("c")), { ok: true }, "a code past its minute, never redeemed");
  }
  {
    const h = redeemed();
    for (const s of ["c", "a1", "r1", "d"]) assert.deepEqual(await h.room.signinDrop(s, v(s)), { ok: false }, s + ": refused without a version");
    assert.ok(h.room.signinCut("a1", v("a1")).ok);
    assert.deepEqual(await h.room.signinDrop("r1", v("r1")), { ok: true }, "a cut sign-in, from any slot");
  }
  {
    const h = redeemed();
    assert.deepEqual(await h.room.signinDrop("r1", v("r1"), 1), { ok: true }, "with its version");
  }
});

test("signinSwap through the routes writes the room list and wakesOf of it at one version: tag beside token: tag, never pre", async () => {
  const h = made();
  const id = "IDIDIDIDIDIDIDIDIDIDID", dk = newKeyBytes(), wk = newKeyBytes();
  const tag = newHolderTag();
  const rooms = [
    { room: "lima", token: "tok-lima", name: "Scout", added: 1, state: "held", tag, pre: true, hooks: [{ link: "ml_1", recs: [] }] },
    { room: "oslo", token: "tok-oslo", name: "Scout", added: 2, state: "held", tag: newHolderTag() },
  ];
  const wakes = wakesOf(rooms);
  assert.deepEqual(wakes, [{ room: "lima", token: tag, tag, name: "", added: 1, state: "held", hooks: [{ link: "ml_1", recs: [] }] }]);
  assert.ok(!("pre" in wakes[0]), "never pre");
  const ring = await agentSealRing(dk, id, 2, rooms);
  assert.ok(h.room.signinSwap("c", v("c"), 1, ring, await agentSealWakes(wk, id, 2, wakes)).ok);
  const a = h.one("SELECT ver, ring, wakes FROM ak");
  assert.equal(a.ver, 2);
  assert.deepEqual(await agentOpenRing(dk, id, 2, a.ring), rooms);
  assert.deepEqual(await agentUnsealWakes(wk, id, 2, a.wakes), wakesOf(await agentOpenRing(dk, id, 2, a.ring)), "the wake list is wakesOf of the room list, at the same version");
  assert.equal(await agentUnsealWakes(wk, id, 1, a.wakes), null, "sealed to its version");
});

test("clientNote: rows past their window go; release; peek writes nothing; a jti once; the refetch gate once per OAUTH_KEYSET_REFETCH_S; refused on a room, an identity or the agent counters", () => {
  const h = makeRoom({ bare: true });
  const now = Date.now();
  assert.deepEqual(h.room.clientNote({ jtis: [{ h: "a:1", exp: now + 60000 }, { h: "a:2", exp: now - 1 }] }), { fresh: [true, true], seen: [], refetch: false });
  assert.deepEqual(h.room.clientNote({ jtis: [{ h: "a:1", exp: now + 60000 }], peek: ["a:2", "r:x"] }), { fresh: [false], seen: [false, false], refetch: false }, "a:2 past its window went");
  assert.deepEqual(h.room.clientNote({ peek: ["a:1"] }), { fresh: [], seen: [true], refetch: false });
  assert.deepEqual(h.room.clientNote({ release: ["a:1"], peek: ["a:1"] }), { fresh: [], seen: [false], refetch: false });
  assert.equal(h.room.clientNote({ wantRefetch: true }).refetch, true);
  assert.equal(h.room.clientNote({ wantRefetch: true }).refetch, false, "within the window");
  h.db.prepare("UPDATE ok SET tried = tried - ?").run(OAUTH_KEYSET_REFETCH_S * 1000);
  assert.equal(h.room.clientNote({ wantRefetch: true }).refetch, true, "after it");
  assert.equal(makeRoom().room.clientNote({}), false);
  const key = makeRoom({ bare: true });
  key.room.agentMake("v", "w", "r");
  assert.equal(key.room.clientNote({}), false);
  const q = makeRoom({ bare: true });
  q.room.agentReserve([{ k: "all", max: 1, per: "day" }]);
  assert.equal(q.room.clientNote({}), false);
});

test("the guards: every sign-in method refuses on a room, on a key's identity and where nothing is; every key method refuses a sign-in's object", async () => {
  const room = makeRoom();
  const key = makeRoom({ bare: true });
  assert.ok(key.room.agentMake("kv", "kw", "kr").ok);
  const bare = makeRoom({ bare: true });
  for (const h of [room, key, bare]) {
    const before = h.all("SELECT name FROM sqlite_master ORDER BY name").map((x) => x.name);
    assert.deepEqual(h.room.signinOpen("key", "kv", ["access", "refresh", "code"], { spent: true, grace: true }), { ok: false });
    assert.deepEqual(h.room.signinSwap("key", "kv", 1, "R", "W"), { ok: false });
    assert.deepEqual(h.room.signinRedeem("key", "kv", { access: slot("a"), refresh: slot("r") }), { ok: false });
    assert.deepEqual(h.room.signinRefresh("key", "kv", { access: slot("a"), refresh: slot("r") }, "N", null), { ok: false });
    assert.deepEqual(h.room.signinAccessDrop("key", "kv"), { ok: false });
    assert.deepEqual(h.room.signinCut("key", "kv"), { ok: false });
    assert.deepEqual(h.room.signinRemain("key", "kv", 1, "W"), { ok: false });
    assert.deepEqual(await h.room.signinDrop("key", "kv"), { ok: false });
    assert.deepEqual(h.all("SELECT name FROM sqlite_master ORDER BY name").map((x) => x.name), before, "nothing made");
  }
  const s = redeemed();
  const before = tables(s);
  // the key's methods are only ever asked of the slot "key", which no sign-in has
  for (const [sl, ver] of [["key", v("c")], ["key", v("a1")], ["key", v("r1")], ["key", v("d")]]) {
    assert.deepEqual(s.room.agentOpen(sl, ver), { ok: false });
    assert.deepEqual(s.room.agentSwap(sl, ver, 1, "R"), { ok: false });
    assert.deepEqual(s.room.agentCut(sl, ver), { ok: false });
    assert.deepEqual(s.room.agentRemain(sl, ver, 1, "R"), { ok: false });
    assert.deepEqual(await s.room.agentDrop(sl, ver), { ok: false });
  }
  assert.equal(tables(s), before, "a key's methods wrote nothing on a sign-in");
  assert.equal(s.room.agentReserve([{ k: "all", max: 1, per: "day" }]), false);
  assert.equal(s.room.ensureSchema === undefined || !s.room.ready, true, "no room is made on it");
});
