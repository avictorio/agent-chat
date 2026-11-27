// The record of the Muse wakes an agent key set up (worker/lib/wakes.ts),
// as pure functions: the guard every write of the key's list goes through
// (keepsWakes), the list's three writes (a recording before a set, a call's
// own write after it, a settling write on a stamped observation), and a
// bounded exhaustive model over those functions in which registrations and
// a take-off interleave in every order: at every state reached, a hook that
// is on has its link on the record. The same rule against real rooms and
// routes: agent-mcp.test.mjs. Run with `npm run test:unit`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { AGENT_WAKE_ITEMS_MAX, AGENT_WAKE_LINK_MAX, AGENT_WAKE_SKEW_MS } from "../../worker/limits.ts";
import { keepsWakes, wakeAnswered, wakeExpired, wakeLinksAfter, wakeRecord, wakeSettle } from "../../worker/lib/wakes.ts";

const SKEW = AGENT_WAKE_SKEW_MS;
/** an entry of lima with these links */
const entry = (hooks, token = "tok-a") => ({ room: "lima", token, name: "Hank", added: 1, state: "held", ...(hooks ? { hooks } : {}) });
/** an observation of lima's seat, stamped with version ver */
const seenAt = (ver, now, link, extra = {}) => ({ room: "lima", token: "tok-a", ver, now, link, ...extra });

test("the guard: a link may leave the list only with an observation of its seat stamped with the version replaced, whose hook is another, by whose room clock each of its outstanding recordings has expired; a recording may go while its link stays only as its call's own or expired", () => {
  const ok = (before, after, seen = [], own = []) => assert.doesNotThrow(() => keepsWakes(7, before, after, seen, own));
  const refused = (before, after, seen, why) => assert.throws(() => keepsWakes(7, before, after, seen), why);
  const X = { link: "link-x", recs: [] };
  const P = { link: "link-x", recs: [{ id: "r1", deadline: 1000 }] };
  ok([entry([X])], [entry([X])]);
  ok([entry([P])], [entry([X])], [], ["r1"]);
  ok([entry([X])], [entry([X, { link: "link-y", recs: [{ id: "r2", deadline: 5 }] }])]);
  // gone with no observation, or with one stamped with another version
  refused([entry([X])], [], [], /no observation/);
  refused([entry([X])], [entry(null)], [], /no observation/);
  refused([entry([X])], [entry(null, "tok-b")], [], /no observation/);
  refused([entry([X])], [], [seenAt(6, 10, null)], /another version/);
  refused([entry([X])], [], [{ ...seenAt(7, 10, null), token: "tok-b" }], /no observation/);
  // its hook on, or a set of it still able to land: the skew margin's edge exactly, then one millisecond after
  refused([entry([X])], [], [seenAt(7, 10, "link-x")], /hook is on/);
  refused([entry([P])], [], [seenAt(7, 1000 + SKEW, null)], /may still reach/);
  ok([entry([P])], [], [seenAt(7, 1000 + SKEW + 1, null)]);
  ok([entry([X])], [], [seenAt(7, 10, "link-y")]);
  // a drop that did not say what is on after it settles only the link it dropped
  ok([entry([X])], [], [seenAt(7, 10, null, { only: "link-x" })]);
  refused([entry([X, { link: "link-y", recs: [] }])], [], [seenAt(7, 10, null, { only: "link-x" })], /drop of another link/);
});

test("the guard checks recordings too: one may leave only as the caller's own or expired by a stamped observation of its entry, so a write that drops another call's outstanding recording is refused", () => {
  const two = entry([{ link: "L", recs: [{ id: "mine", deadline: 1000 }, { id: "theirs", deadline: 1000 }] }]);
  // a call's own write: its own id goes
  assert.doesNotThrow(() => keepsWakes(7, [two], wakeAnswered([two], "lima", "tok-a", "L", "mine"), [], ["mine"]));
  // ... not unnamed
  assert.throws(() => keepsWakes(7, [two], wakeAnswered([two], "lima", "tok-a", "L", "mine"), []), /neither its call's own nor expired/);
  // an own write that takes off every recording of its link (another call's included) is refused
  assert.throws(() => keepsWakes(7, [two], [entry([{ link: "L", recs: [] }])], [], ["mine"]), /neither its call's own nor expired/);
  // a settling write that prunes a recording of the link its hook is on before it expired is refused; after, allowed
  const on = entry([{ link: "L", recs: [{ id: "r", deadline: 1000 }] }]);
  assert.throws(() => keepsWakes(7, [on], [entry([{ link: "L", recs: [] }])], [seenAt(7, 1000 + SKEW, "L")]), /may still reach/);
  assert.doesNotThrow(() => keepsWakes(7, [on], [entry([{ link: "L", recs: [] }])], [seenAt(7, 1000 + SKEW + 1, "L")]));
  assert.throws(() => keepsWakes(7, [on], [entry([{ link: "L", recs: [] }])], [seenAt(6, 1000 + SKEW + 1, "L")]), /neither its call's own nor expired/, "an observation of another version prunes nothing");
  // a link leaves only with every recording expired, the caller's own included
  assert.throws(() => keepsWakes(7, [on], [], [seenAt(7, 10, "other")], ["r"]), /may still reach/);
});

// The two writes that take nothing off (wakes.ts): a mark keeps an
// entry's links as they are; a failed person's add's rollback takes off its
// own entries that hold no link and puts back each entry it replaced as it
// was before, links and recordings included: the guard lets both through
// with no observation at all, and refuses a rollback that would take a link
// or a recording off.
test("a mark and a person's add's rollback take no link or recording off: the guard lets them through with no observation; the rollback may put back a link the replacing write had settled off; one that takes a link or a recording off is refused", () => {
  const X = { link: "link-x", recs: [{ id: "r1", deadline: 1000 }] };
  const was = entry([X], "tok-old");
  const mine = { ...entry(null, "tok-new"), name: "Other" };
  // the mark: the same entry, refused, its links as they are
  assert.doesNotThrow(() => keepsWakes(7, [entry([X])], [{ ...entry([X]), state: "refused", code: "invite_revoked", at: 5 }], []));
  // the rollback: the add's own entry (no link) off, the entry it replaced back as it was before, its link and recording included
  assert.doesNotThrow(() => keepsWakes(7, [mine], [was], []));
  assert.doesNotThrow(() => keepsWakes(7, [mine, entry(null, "tok-z")], [entry(null, "tok-z")], []), "an own entry with no link taken off, nothing put back");
  // a rollback that took a link or a recording off the list it read would be refused
  assert.throws(() => keepsWakes(7, [{ ...mine, hooks: [X] }], [was], []), /no observation/);
  assert.throws(() => keepsWakes(7, [{ ...mine, hooks: [X] }], [{ ...mine, hooks: [{ link: "link-x", recs: [] }] }], []), /neither its call's own nor expired/);
});

test("the list's three writes as pure functions: a recording before a set (at most AGENT_WAKE_ITEMS_MAX links and recordings), a call's own write takes off its own id only, a settling write keeps the hook's link and what may still land and prunes what has expired", () => {
  let rooms = [entry(null)];
  // two recordings of one link in the same millisecond: two ids
  rooms = wakeRecord(rooms, "lima", "tok-a", "L", { id: "a", deadline: 100 }, AGENT_WAKE_ITEMS_MAX);
  rooms = wakeRecord(rooms, "lima", "tok-a", "L", { id: "b", deadline: 100 }, AGENT_WAKE_ITEMS_MAX);
  assert.deepEqual(rooms[0].hooks, [{ link: "L", recs: [{ id: "a", deadline: 100 }, { id: "b", deadline: 100 }] }]);
  rooms = wakeAnswered(rooms, "lima", "tok-a", "L", "a");
  assert.deepEqual(rooms[0].hooks, [{ link: "L", recs: [{ id: "b", deadline: 100 }] }], "only its own id");
  rooms = wakeAnswered(rooms, "lima", "tok-a", "L", "b");
  assert.deepEqual(rooms[0].hooks, [{ link: "L", recs: [] }], "the link stays when its last recording goes");
  // the bound counts links and recordings together
  let full = [entry(null)];
  for (let i = 0; full && i < AGENT_WAKE_ITEMS_MAX; i++) full = wakeRecord(full, "lima", "tok-a", "L" + i, { id: "r" + i, deadline: 1 }, AGENT_WAKE_ITEMS_MAX) || full;
  assert.ok(full[0].hooks.reduce((n, h) => n + 1 + h.recs.length, 0) <= AGENT_WAKE_ITEMS_MAX);
  assert.equal(wakeRecord(full, "lima", "tok-a", "new", { id: "z", deadline: 1 }, AGENT_WAKE_ITEMS_MAX), null, "full: not recorded");
  assert.equal(wakeRecord([{ ...entry(null), state: "refused" }], "lima", "tok-a", "L", { id: "z", deadline: 1 }, AGENT_WAKE_ITEMS_MAX), null, "a refused entry is not recorded on");
  // a link longer than AGENT_WAKE_LINK_MAX is never recorded
  assert.ok(wakeRecord([entry(null)], "lima", "tok-a", "m".repeat(AGENT_WAKE_LINK_MAX), { id: "z", deadline: 1 }, AGENT_WAKE_ITEMS_MAX));
  assert.equal(wakeRecord([entry(null)], "lima", "tok-a", "m".repeat(AGENT_WAKE_LINK_MAX + 1), { id: "z", deadline: 1 }, AGENT_WAKE_ITEMS_MAX), null);
  // a settling write: the hook's link stays, a link with a recording still to land stays (its expired ones pruned)
  const e = entry([{ link: "on", recs: [{ id: "old", deadline: 10 }] }, { link: "gone", recs: [] }, { link: "late", recs: [{ id: "x", deadline: 10 }, { id: "y", deadline: 9000 }] }]);
  assert.deepEqual(wakeLinksAfter(e, seenAt(7, 10 + SKEW + 1, "on")), [{ link: "on", recs: [] }, { link: "late", recs: [{ id: "y", deadline: 9000 }] }]);
  assert.deepEqual(wakeSettle([e], [seenAt(7, 10 + SKEW + 1, "on")])[0].hooks.map((h) => h.link), ["on", "late"]);
  assert.ok(!wakeExpired({ deadline: 10 }, 10 + SKEW) && wakeExpired({ deadline: 10 }, 10 + SKEW + 1), "expired only past the margin");
});

// A bounded exhaustive model over the three pure functions and the guard: one room's seat (its hook), its
// clock (ticks of a second, monotone), the key's list for it with a version, and actors that interleave in
// every order: registrations (record, then a set that takes, is refused, throws after running or before,
// or never runs as its Worker stops; then its own write; then a tidy: a look after its own write and a
// compare-and-set from the version it wrote, giving up when that version moved), and a take-off that
// reads the list, looks, drops the hook when nothing may still land, and writes from the version it read
// (a lost compare-and-set reads and looks again). Every write passes keepsWakes. After every step: a hook
// that is on has its link on the record.
function wakeModel(regs, takeOffs, ticks) {
  // a tick of the room's clock: 2000 ms; a recording's deadline 1000 ms after its record: so a set is taken in the
  // tick it was recorded in, refused after one tick, and its recording expired (deadline + AGENT_WAKE_SKEW_MS
  // passed) after two
  const SET = 1000, TICK = 2000;
  const init = { T: 0, ticks: 0, hook: null, ver: 0, rooms: [entry(null)], r: regs.map(() => ({ pc: "rec" })), o: takeOffs.map(() => ({ pc: "read", tries: 0 })) };
  const seen = new Set();
  let states = 0, broken = null;
  const write = (s, next, obs, own = []) => { keepsWakes(s.ver, s.rooms, next, obs, own); return { ...s, rooms: next, ver: s.ver + 1 }; };
  const step = (s, path) => {
    if (broken) return;
    const key = JSON.stringify(s);
    if (seen.has(key)) return;
    seen.add(key);
    states++;
    const hooks = s.rooms[0].hooks || [];
    if (s.hook !== null && !hooks.some((h) => h.link === s.hook)) { broken = path; return; }
    if (s.ticks < ticks) step({ ...s, T: s.T + TICK, ticks: s.ticks + 1 }, path.concat("tick"));
    regs.forEach((g, i) => {
      const me = s.r[i];
      const set = (st, patch) => ({ ...st, r: st.r.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
      if (me.pc === "rec") {
        const d = s.T + SET;
        const next = wakeRecord(s.rooms, "lima", "tok-a", g.link, { id: g.id, deadline: d }, AGENT_WAKE_ITEMS_MAX);
        if (!next) step(set(s, { pc: "done" }), path.concat(g.id + ".full"));
        else step(set(write(s, next, []), { pc: "set", d }), path.concat(g.id + ".rec"));
      } else if (me.pc === "set") {
        const takes = s.T <= me.d;
        step(set({ ...s, hook: takes ? g.link : s.hook }, { pc: "own", answered: true }), path.concat(g.id + (takes ? ".set" : ".refused")));
        step(set({ ...s, hook: takes ? g.link : s.hook }, { pc: "own", answered: false }), path.concat(g.id + ".ran-threw"));
        step(set(s, { pc: "own", answered: false }), path.concat(g.id + ".threw"));
        step(set(s, { pc: "done" }), path.concat(g.id + ".stopped"));
      } else if (me.pc === "own") {
        const next = me.answered ? wakeAnswered(s.rooms, "lima", "tok-a", g.link, g.id) : s.rooms;
        const w = write(s, next, [], me.answered ? [g.id] : []);
        step(set(w, { pc: me.answered ? "look" : "done", v: w.ver }), path.concat(g.id + ".own"));
        step(set(s, { pc: "done" }), path.concat(g.id + ".stopped-before-own"));
      } else if (me.pc === "look") {
        step(set(s, { pc: "tidy", obs: seenAt(me.v, s.T, s.hook) }), path.concat(g.id + ".look"));
      } else if (me.pc === "tidy") {
        if (s.ver !== me.v) step(set(s, { pc: "done" }), path.concat(g.id + ".tidy-lost"));
        else step(set(write(s, wakeSettle(s.rooms, [me.obs]), [me.obs]), { pc: "done" }), path.concat(g.id + ".tidy"));
      }
    });
    takeOffs.forEach((_, j) => {
      const me = s.o[j];
      const set = (st, patch) => ({ ...st, o: st.o.map((x, k) => (k === j ? { ...x, ...patch } : x)) });
      if (me.pc === "read") step(set(s, { pc: "look", v: s.ver, rooms: s.rooms }), path.concat("O.read"));
      else if (me.pc === "look") {
        const e = me.rooms[0], obs = seenAt(me.v, s.T, s.hook);
        const waits = (e.hooks || []).some((h) => h.recs.some((r) => !wakeExpired(r, s.T)));
        if (waits) step(set(s, { pc: "done" }), path.concat("O.try_again"));
        else if (s.hook !== null && (e.hooks || []).some((h) => h.link === s.hook)) step(set(s, { pc: "drop", obs }), path.concat("O.look"));
        else step(set(s, { pc: "write", obs }), path.concat("O.look"));
      } else if (me.pc === "drop") {
        // museDropLook of the link the look saw: removes the hook only while it is that link; answers what is on after
        const hook = s.hook === me.obs.link ? null : s.hook;
        step(set({ ...s, hook }, { pc: "write", obs: seenAt(me.v, s.T, hook) }), path.concat("O.drop"));
      } else if (me.pc === "write") {
        if (s.ver !== me.v) {
          if (me.tries < 1) step(set(s, { pc: "read", tries: me.tries + 1 }), path.concat("O.lost"));
          else step(set(s, { pc: "done" }), path.concat("O.lost-busy"));
        } else step(set(write(s, wakeSettle(me.rooms, [me.obs]), [me.obs]), { pc: "done" }), path.concat("O.write"));
      }
    });
  };
  step(init, []);
  return { states, broken };
}

test("a bounded exhaustive model of the record: two registrations of one link or of two, sets that take, are refused, throw or never run, every order of sets, own writes, tidies and a take-off, lost compare-and-sets: a hook that is on always has its link on the record", () => {
  const cases = [
    ["two links", [{ id: "B", link: "L" }, { id: "C", link: "Y" }], [], 3],
    ["one link twice", [{ id: "A", link: "L" }, { id: "B", link: "L" }], [], 3],
    ["one registration and a take-off", [{ id: "A", link: "L" }], [{}], 3],
    ["two links and a take-off", [{ id: "B", link: "L" }, { id: "C", link: "Y" }], [{}], 2],
    ["one link twice and a take-off", [{ id: "A", link: "L" }, { id: "B", link: "L" }], [{}], 2],
  ];
  const out = [];
  for (const [what, regs, offs, ticks] of cases) {
    const r = wakeModel(regs, offs, ticks);
    out.push(what + ": " + r.states + " states");
    assert.equal(r.broken, null, what + ": a hook on with no link recorded after " + JSON.stringify(r.broken));
  }
  console.log("the wake record's model: " + out.join("; "));
});

// The holders of a member's Muse hook (worker/room/muse.ts, mhh) under the
// same functions, tagsKept beside keepsWakes: holders-model.mjs explores
// every order of registrations and take-offs of identities on one seat
// (tagged, untagged and the member's own registration), the room as one pure
// function that agent-hooks.test.mjs shows equal to the real Room. Here: the
// runs that must break (a tagged set reaching a room that keeps no holders;
// step 10's backfill giving "pre" to every Muse hook when it runs again), and
// the smaller cases that must hold, with LEGACY_HOLDS as the rooms keep it
// and narrowed to "pre". Every case at full size: `npm run test:model`.
import { CASES, LEGACY_NOW, LEGACY_PRE, run, runs } from "./holders-model.mjs";
test("the holders: a tagged set on a room that keeps none, or step 10's earlier backfill run again, breaks the record; the smaller cases hold with either LEGACY_HOLDS; a hook goes with its self hold only with LEGACY_HOLDS as the rooms keep it", () => {
  const chosen = runs().filter(([variant, i, , expect]) => expect === "broken" || (variant === "holders" && CASES[i][5]));
  assert.ok(chosen.length >= 16, String(chosen.length));
  for (const spec of chosen) {
    const r = run(spec);
    assert.ok(r.ok, r.label + ": " + r.states + " states, " + (r.broken ? "BROKEN " + r.broken.why + " after " + r.broken.path.join(" ") : "held"));
  }
  // the member's own registration beside an untagged key on one link, the key taking off: the hook goes with it only as before tags
  const self = CASES.findIndex((c) => c[0].startsWith("S (the room's own token) and U"));
  assert.equal(run(["holders", self, { legacy: LEGACY_NOW, tag: "now" }, "held"]).goneWithSelf, true, "with the rooms' LEGACY_HOLDS the key's drop takes it, as before holders were kept");
  assert.equal(run(["holders", self, { legacy: LEGACY_PRE, tag: "pre" }, "held"]).goneWithSelf, false, "narrowed to pre, never");
});
