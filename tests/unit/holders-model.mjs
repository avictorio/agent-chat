// A bounded exhaustive model of the holders of a member's Muse hook
// (worker/room/muse.ts, mhh) under the key's own pure functions
// (worker/lib/wakes.ts: wakeRecord, wakeAnswered, wakeSettle, keepsWakes,
// wakeExpired; worker/lib/agentkey.ts: tagsKept): one room seat, its hook
// and its holders, identities on that seat (agent keys or sign-ins, each
// its own list with one entry, tagged or not, and the member's own
// registration with the room's token, "self"), registrations (record, a set
// carrying the entry's tag, own write) and take-offs (read, look, drop when
// nothing may still land, compare-and-set write), in every order, with the
// room's clock. The room is one pure function, roomCall, of (hook, holders,
// call) to (hook, holders, answer), with LEGACY_HOLDS as a parameter;
// agent-hooks.test.mjs shows it equal to the real Room on every state and
// call it takes. Invariants after every step:
//   I1: every tag holding the hook has its link on its identity's record
//   I2: every identity whose set of the hook's link landed and that has not
//       let go records the link
//   I3: a Muse hook has a holder (once its room keeps holders)
//   I4: the hook stays on only while someone who set it still holds it
//       (the member's own registration, "self", among them)
//   I5 (with LEGACY_HOLDS ["pre"]): a "self" hold goes only by the room's
//       own controls, never by an identity's drop
// Variants: holders (every room keeps holders), oldroom (a set reaches a
// room on code that keeps none, and the room starts on the new code later:
// step 10 gives the hook "pre"), rerun (step 10 runs again on a room that
// ran it) with the step's backfill or one that would give "pre" to
// every Muse hook. The unit suite (agent-wakes.test.mjs) runs the variants
// that must break and the smaller cases; `npm run test:model` runs this
// file with --full: every case and variant, with its states and time.
import { keepsWakes, wakeAnswered, wakeExpired, wakeRecord, wakeSettle } from "../../worker/lib/wakes.ts";
import { tagsKept } from "../../worker/lib/agentkey.ts";
import { AGENT_WAKE_ITEMS_MAX } from "../../worker/limits.ts";
import { LEGACY_HOLDS } from "../../worker/room/muse.ts";

/** LEGACY_HOLDS as the rooms keep it now, and as it is once tags are made (narrowed to "pre"). */
export const LEGACY_NOW = LEGACY_HOLDS;
export const LEGACY_PRE = ["pre"];

const sorted = (a) => [...new Set(a)].sort();

/** Whether a room state's hook is a Muse hook held by one of holders (a
 *  hook with no holder row is held by "pre"), as muse.ts museHeld. */
export function held(st, holders) {
  if (!st.hook || st.hook.kind !== "muse") return false;
  return st.rows.length ? st.rows.some((r) => holders.includes(r)) : holders.includes("pre");
}
const onLink = (st) => (st.hook && st.hook.kind === "muse" ? st.hook.link : null);

/**
 * The room, as one pure function: a state {hook: null | {kind: "muse",
 * link} | {kind: "webhook"}, rows: holders, sorted} and a call, to the
 * state after it and the answer. Calls:
 *   {op: "set", link, holder}       museSetHookLook (holder its tag, or "pre"
 *                                   with none) and museSetHook ("self")
 *   {op: "webhook"}                 webhookSet
 *   {op: "museDrop"}                museDrop (a revoke, museRemove, revokeAll)
 *   {op: "look"}                    museHookLook: LEGACY_HOLDS as its own
 *   {op: "look", tag, legacy}       museHolderLook
 *   {op: "drop", link}              museDropLook
 *   {op: "drop", link, tag, legacy} museHolderDrop
 *   {op: "step10", backfill}        schema step 10: "pre" for a Muse hook with
 *                                   no holder ("only"), or, as a backfill
 *                                   without its NOT IN would, for every
 *                                   Muse hook ("every")
 */
export function roomCall(st, call, legacy) {
  const holdsOf = (c) => (c.tag === undefined ? legacy : c.legacy ? [c.tag, ...legacy] : [c.tag]);
  switch (call.op) {
    case "set": {
      let rows = st.rows;
      if (st.hook && st.hook.kind === "muse" && st.hook.link === call.link) { if (!rows.length) rows = ["pre"]; } else rows = [];
      return { st: { hook: { kind: "muse", link: call.link }, rows: sorted(rows.concat(call.holder)) }, ans: { ok: true } };
    }
    case "webhook": return { st: { hook: { kind: "webhook" }, rows: [] }, ans: { ok: true } };
    case "museDrop": return { st: { hook: null, rows: [] }, ans: { ok: true } };
    case "look": {
      const H = holdsOf(call);
      return { st, ans: { ok: true, link: held(st, H) ? st.hook.link : null, on: onLink(st) } };
    }
    case "drop": {
      const H = holdsOf(call);
      let next = st, removed = false;
      if (held(st, H) && st.hook.link === call.link) {
        const rows = st.rows.filter((r) => !H.includes(r));
        if (rows.length) next = { hook: st.hook, rows };
        else { next = { hook: null, rows: [] }; removed = true; }
      }
      return { st: next, ans: { ok: true, removed, link: held(next, H) ? next.hook.link : null, on: onLink(next) } };
    }
    case "step10": {
      if (!st.hook || st.hook.kind !== "muse") return { st, ans: { ok: true } };
      if (call.backfill === "every") return { st: { ...st, rows: sorted(st.rows.concat("pre")) }, ans: { ok: true } };
      return { st: st.rows.length ? st : { ...st, rows: ["pre"] }, ans: { ok: true } };
    }
  }
  throw new Error("no such call: " + JSON.stringify(call));
}

const SET = 1000, TICK = 2000;
/** a key identity's one entry: tagged ("tag-" + who) unless untagged */
const entryOf = (who, tagged) => ({ room: "lima", token: "tok-" + who, name: "Hank", added: 1, state: "held", ...(tagged ? { tag: "tag-" + who } : {}) });

/**
 * Explores every order of the registrations and take-offs.
 * @param variant "holders" | "oldroom" | "rerun"
 * @param ids {who: "tagged" | "untagged" | "self"}: the identities
 * @param regs [{id, who, link}]: registrations (a "self" one is the member's own, with the room's token)
 * @param offs [{who}]: take-offs (key identities only)
 * @param ticks how many times the room's clock moves on
 * @param o {legacy: LEGACY_HOLDS, backfill: step 10's ("only") or the earlier one ("every")}
 * @returns {states, broken: {why, path} | null, goneWithSelf}
 */
export function explore(variant, ids, regs, offs, ticks, o = {}) {
  const legacy = o.legacy || LEGACY_NOW;
  const backfill = o.backfill || "only";
  const keys = Object.keys(ids).filter((w) => ids[w] !== "self");
  const init = {
    T: 0, ticks: 0, upgraded: variant !== "oldroom", rerun: false,
    room: { hook: null, rows: [] },
    // who set the hook's link and has not let go of it
    setBy: [],
    lists: Object.fromEntries(keys.map((w) => [w, { ver: 0, rooms: [entryOf(w, ids[w] === "tagged")] }])),
    r: regs.map(() => ({ pc: "rec" })), o: offs.map(() => ({ pc: "read" })),
  };
  const seen = new Set();
  let states = 0, broken = null, goneWithSelf = false;
  const write = (s, who, next, obs, own = []) => {
    const L = s.lists[who];
    keepsWakes(L.ver, L.rooms, next, obs, own);
    tagsKept(L.rooms, next);
    return { ...s, lists: { ...s.lists, [who]: { ver: L.ver + 1, rooms: next } } };
  };
  const records = (s, who, link) => (s.lists[who].rooms[0].hooks || []).some((x) => x.link === link);
  const check = (s) => {
    const { hook, rows } = s.room;
    if (!hook || hook.kind !== "muse") return null;
    if (s.upgraded && !rows.length) return "I3: a Muse hook with no holder";
    if (!s.setBy.length) return "I4: the hook stays on after everyone who set it let go (holders " + rows.join(",") + ")";
    for (const h of rows) if (h.startsWith("tag-") && !records(s, h.slice(4), hook.link)) return "I1: " + h + " holds " + hook.link + " but its record does not have it";
    for (const who of s.setBy) if (ids[who] !== "self" && !records(s, who, hook.link)) return "I2: " + who + " set " + hook.link + ", has not let go, and its record does not have it";
    return null;
  };
  // the room's answer to a call; on a room still on code that keeps no holders, a set keeps none
  const call = (s, c) => {
    if (!s.upgraded && c.op === "set") return { st: { hook: { kind: "muse", link: c.link }, rows: [] }, ans: { ok: true } };
    return roomCall(s.room, c, legacy);
  };
  const step = (s, path) => {
    if (broken) return;
    const key = JSON.stringify(s);
    if (seen.has(key)) return;
    seen.add(key);
    states++;
    const bad = check(s);
    if (bad) { broken = { why: bad, path }; return; }
    if (s.ticks < ticks) step({ ...s, T: s.T + TICK, ticks: s.ticks + 1 }, path.concat("tick"));
    // the room starts on the new code: step 10 runs
    if (!s.upgraded) step({ ...s, upgraded: true, room: roomCall(s.room, { op: "step10", backfill: "only" }, legacy).st }, path.concat("room.upgrade"));
    // step 10 runs again on a room that ran it
    if (variant === "rerun" && !s.rerun) step({ ...s, rerun: true, room: roomCall(s.room, { op: "step10", backfill }, legacy).st }, path.concat("room.step10-again"));
    regs.forEach((g, i) => {
      const me = s.r[i], who = g.who;
      const set = (st, patch) => ({ ...st, r: st.r.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
      const landed = (st, room) => {
        const same = st.room.hook && st.room.hook.kind === "muse" && st.room.hook.link === g.link;
        return { ...st, room, setBy: same ? (st.setBy.includes(who) ? st.setBy : st.setBy.concat(who)) : [who] };
      };
      if (ids[who] === "self") {
        // the member's own registration, with the room's token: no record, no deadline
        if (me.pc === "rec") step(set(landed(s, call(s, { op: "set", link: g.link, holder: "self" }).st), { pc: "done" }), path.concat(g.id + ".self"));
        return;
      }
      const L = s.lists[who];
      if (me.pc === "rec") {
        const d = s.T + SET;
        const next = wakeRecord(L.rooms, "lima", "tok-" + who, g.link, { id: g.id, deadline: d }, AGENT_WAKE_ITEMS_MAX);
        if (!next) return step(set(s, { pc: "done" }), path.concat(g.id + ".full"));
        step(set(write(s, who, next, []), { pc: "set", d }), path.concat(g.id + ".rec"));
      } else if (me.pc === "set") {
        // the set carries the entry's tag, as the recording write wrote it; an entry with none is held as "pre"
        const e = s.lists[who].rooms[0];
        const takes = s.T <= me.d;
        const after = takes ? landed(s, call(s, { op: "set", link: g.link, holder: e.tag || "pre" }).st) : s;
        step(set(after, { pc: "own", answered: true }), path.concat(g.id + (takes ? ".set" : ".refused")));
        step(set(after, { pc: "own", answered: false }), path.concat(g.id + ".ran-threw"));
        step(set(s, { pc: "own", answered: false }), path.concat(g.id + ".threw"));
      } else if (me.pc === "own") {
        const next = me.answered ? wakeAnswered(L.rooms, "lima", "tok-" + who, g.link, g.id) : L.rooms;
        step(set(write(s, who, next, [], me.answered ? [g.id] : []), { pc: "done" }), path.concat(g.id + ".own"));
        step(set(s, { pc: "done" }), path.concat(g.id + ".stopped-before-own"));
      }
    });
    offs.forEach((off, j) => {
      const me = s.o[j], who = off.who;
      const set = (st, patch) => ({ ...st, o: st.o.map((x, k) => (k === j ? { ...x, ...patch } : x)) });
      // an entry's look and drop: by its tag, or, with none, the room's untagged holds
      const asked = (e) => (e.tag ? { tag: e.tag, legacy: false } : {});
      if (me.pc === "read") step(set(s, { pc: "look", v: s.lists[who].ver, rooms: s.lists[who].rooms }), path.concat("O" + who + ".read"));
      else if (me.pc === "look") {
        const e = me.rooms[0];
        // a room on code that keeps no holders has no holder methods: the look of a tagged entry throws, and makes no observation
        if (!s.upgraded && e.tag) return step(set(s, { pc: "done" }), path.concat("O" + who + ".look-threw"));
        const a = s.upgraded ? roomCall(s.room, { op: "look", ...asked(e) }, legacy).ans : { link: onLink(s.room) };
        const obs = { room: "lima", token: "tok-" + who, ver: me.v, now: s.T, link: a.link };
        const waits = (e.hooks || []).some((h) => h.recs.some((r) => !wakeExpired(r, s.T)));
        if (waits) step(set(s, { pc: "done" }), path.concat("O" + who + ".try_again"));
        else if (a.link !== null && (e.hooks || []).some((h) => h.link === a.link)) step(set(s, { pc: "drop", obs }), path.concat("O" + who + ".look"));
        else step(set(s, { pc: "write", obs }), path.concat("O" + who + ".look"));
      } else if (me.pc === "drop") {
        const e = me.rooms[0];
        if (!s.upgraded && e.tag) return step(set(s, { pc: "done" }), path.concat("O" + who + ".drop-threw"));
        const before = s.room;
        // a room on older code drops the hook on that link whoever set it
        const r = s.upgraded ? roomCall(before, { op: "drop", link: me.obs.link, ...asked(e) }, legacy)
          : before.hook && before.hook.link === me.obs.link ? { st: { hook: null, rows: [] }, ans: { link: null } } : { st: before, ans: { link: onLink(before) } };
        const hadSelf = before.rows.includes("self") && before.hook && before.hook.link === me.obs.link;
        const lostSelf = hadSelf && !(r.st.hook && r.st.hook.link === me.obs.link && r.st.rows.includes("self"));
        if (lostSelf && !r.st.hook) goneWithSelf = true;
        if (lostSelf && !legacy.includes("self")) { broken = { why: "I5: a self hold went by " + who + "'s drop", path: path.concat("O" + who + ".drop") }; return; }
        const next = { ...s, room: r.st, setBy: s.setBy.filter((x) => x !== who) };
        step(set(next, { pc: "write", obs: { ...me.obs, now: s.T, link: r.ans.link } }), path.concat("O" + who + ".drop"));
      } else if (me.pc === "write") {
        const L = s.lists[who];
        if (L.ver !== me.v) step(set(s, { pc: "read" }), path.concat("O" + who + ".lost"));
        else step(set(write(s, who, wakeSettle(me.rooms, [me.obs]), [me.obs]), { pc: "done" }), path.concat("O" + who + ".write"));
      }
    });
  };
  step(init, []);
  return { states, broken, goneWithSelf };
}

const AB = { A: "tagged", B: "tagged" };
/** The cases: [name, identities, registrations, take-offs, ticks, which runs in the unit suite] */
export const CASES = [
  ["A and B register one link; A takes off", AB, [{ id: "a", who: "A", link: "L" }, { id: "b", who: "B", link: "L" }], [{ who: "A" }], 2, true],
  ["A and B register one link; both take off", AB, [{ id: "a", who: "A", link: "L" }, { id: "b", who: "B", link: "L" }], [{ who: "A" }, { who: "B" }], 1, false],
  ["A registers L, B registers M; A takes off", AB, [{ id: "a", who: "A", link: "L" }, { id: "b", who: "B", link: "M" }], [{ who: "A" }], 2, true],
  ["A registers L twice; B registers L; A takes off", AB, [{ id: "a1", who: "A", link: "L" }, { id: "a2", who: "A", link: "L" }, { id: "b", who: "B", link: "L" }], [{ who: "A" }], 1, false],
  ["U (no tag, held as pre) and A register one link; U takes off", { U: "untagged", A: "tagged" }, [{ id: "u", who: "U", link: "L" }, { id: "a", who: "A", link: "L" }], [{ who: "U" }], 2, true],
  ["S (the room's own token) and A register one link; A takes off", { S: "self", A: "tagged" }, [{ id: "s", who: "S", link: "L" }, { id: "a", who: "A", link: "L" }], [{ who: "A" }], 2, true],
  ["S (the room's own token) and U (no tag) register one link; U takes off", { S: "self", U: "untagged" }, [{ id: "s", who: "S", link: "L" }, { id: "u", who: "U", link: "L" }], [{ who: "U" }], 2, true],
];

/**
 * Every run, and what each must show: [variant, case index, options, expected: "held" | "broken"].
 * holders with both constants: held in every case (the last case with
 * LEGACY_NOW reaches a hook gone with its "self" hold, as before holders were
 * kept; with LEGACY_PRE it never does); oldroom: broken in the four cases
 * of two tagged identities (why tags wait until every room keeps holders); rerun: broken with
 * the backfill that gives "pre" to every Muse hook, held with step 10's.
 */
export function runs() {
  const out = [];
  for (const [legacy, tag] of [[LEGACY_NOW, "now"], [LEGACY_PRE, "pre"]]) CASES.forEach((_, i) => out.push(["holders", i, { legacy, tag }, "held"]));
  for (let i = 0; i < 4; i++) out.push(["oldroom", i, { legacy: LEGACY_PRE, tag: "pre" }, "broken"]);
  for (let i = 0; i < 4; i++) out.push(["rerun", i, { legacy: LEGACY_PRE, tag: "pre", backfill: "every" }, "broken"]);
  for (let i = 0; i < 4; i++) out.push(["rerun", i, { legacy: LEGACY_PRE, tag: "pre", backfill: "only" }, "held"]);
  return out;
}

/** One run: its result and whether it shows what it must. */
export function run([variant, i, opts, expect]) {
  const [name, ids, regs, offs, ticks] = CASES[i];
  const t0 = Date.now();
  const r = explore(variant, ids, regs, offs, ticks, opts);
  const ok = expect === "held" ? !r.broken : !!r.broken;
  return { label: variant + (opts.backfill ? "(" + opts.backfill + ")" : "") + " [LEGACY_HOLDS " + opts.tag + "] | " + name, ...r, ok, ms: Date.now() - t0 };
}

// `npm run test:model`: every run at full size, with its states and time; exits non-zero when one does not show what it must
if (process.argv.includes("--full")) {
  let bad = 0;
  for (const spec of runs()) {
    const r = run(spec);
    if (!r.ok) bad++;
    console.log((r.ok ? "ok   " : "FAIL ") + r.label + ": " + r.states + " states, " + r.ms + " ms, " + (r.broken ? "BROKEN " + r.broken.why + " after " + r.broken.path.join(" ") : "held") + (r.goneWithSelf ? " (a hook went with its self hold)" : ""));
  }
  console.log(bad ? "HOLDER MODEL: " + bad + " run(s) did not show what they must" : "HOLDER MODEL: every run shows what it must");
  process.exit(bad ? 1 : 0);
}
