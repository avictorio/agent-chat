// The record of the Muse wakes an agent key set up (muse_register in
// routes/agent.ts), kept on each room's entry of the key's sealed list
// (AgentEntry.hooks), and the one check every write of the list goes
// through. Pure functions over the list: the routes ask the rooms and write.
//
// A recording is one attempt to set one link in one room: it has an id of
// its own (random), the link, and a deadline (AGENT_WAKE_SET_MS after the
// record). It goes on the entry before its set is sent; its set is sent at
// most once, never again (a set that throws is not retried), and only
// before its deadline; and the room refuses it after its deadline by the
// room's own clock (museSetHookLook). Per link the entry keeps the list of
// its outstanding recordings ({id, deadline}). A link's presence means "a
// hook of this link may be on"; a link with an empty list is one whose
// every set has answered.
//
// Three writes change the record:
// - recording a set (wakeRecord): the link, if new, and the recording.
// - a call's own write after its set (wakeAnswered): it takes off only its
//   own recording id, when the room answered that set (ok or refused alike)
//   or the set was never sent; a set that threw leaves it outstanding. A
//   set's answer settles nothing: it never takes a link off, its own or
//   another's.
// - a settling write (wakeSettle): the list is read (version v); after that
//   read the room is asked (museHookLook, or museDropLook for one link), and
//   its answer is an observation: the room's clock T and the Muse link H
//   the seat's hook is on after the call, or none (a room with no row for
//   the token, or gone, is an observation with no hook; an answer without a
//   clock is none). Then a compare-and-set write from version v takes off
//   each link X != H whose outstanding recordings at v all have
//   deadline + AGENT_WAKE_SKEW_MS < T (an empty list at once), and prunes
//   recordings so expired from the links that stay. A write that meets a
//   newer version throws its observations away and asks the room again.
// Nothing else takes a link off. Why it is enough: a recording missing from
// the list at v had answered before v was written, so its set ran in the
// room before the observation; a recording on the list at v has either
// expired before T by the room's own clock (the room refuses it after) or
// blocks the removal; and nothing can be recorded between v and the write.
// So a wake the key set up is on in a room only while its link is on the
// record. It rests on a set being sent once (above), and on the room's
// clock running back no further than AGENT_WAKE_SKEW_MS (a room object
// restarted on another machine).

import { AGENT_WAKE_SKEW_MS } from "../limits.js";
import type { AgentEntry, AgentRec, AgentWake } from "./agentkey.js";

/** An observation of one entry's seat: the room's clock (now) and the Muse
 *  link its hook is on after the call (link: null for none), stamped with
 *  the list's version read before the room was asked (ver). only: the
 *  room's drop said which link it dropped but not what is on after it, so
 *  the observation settles that one link and no other. */
export type WakeSeen = { room: string, token: string, ver: number, now: number, link: string | null, only?: string };

/** Whether a recording's set can no longer reach the room by the time of
 *  an observation whose room clock is now. */
export function wakeExpired(r: AgentRec, now: number): boolean {
  return r.deadline + AGENT_WAKE_SKEW_MS < now;
}

/** How much of the bound an entry holds: its links and their outstanding recordings. */
export function wakeWeight(e: AgentEntry): number {
  return (e.hooks || []).reduce((n, h) => n + 1 + h.recs.length, 0);
}

/** The entry with these links (none: no hooks field). */
export function withWakes(e: AgentEntry, hooks: AgentWake[]): AgentEntry {
  const out: AgentEntry = { ...e };
  delete out.hooks;
  if (hooks.length) out.hooks = hooks;
  return out;
}

const at = (rooms: AgentEntry[], room: string, token: string) => rooms.findIndex((e) => e.room === room && e.token === token);

/** Recording a set of link on the held entry (room, token): the link, if
 *  new, and the recording. Null when that entry is not there (taken off,
 *  replaced, refused meanwhile) or holds too much to take it (max). */
export function wakeRecord(rooms: AgentEntry[], room: string, token: string, link: string, rec: AgentRec, max: number): AgentEntry[] | null {
  const i = at(rooms, room, token);
  if (i < 0 || rooms[i].state !== "held") return null;
  const e = rooms[i], hooks = e.hooks || [];
  const has = hooks.some((h) => h.link === link);
  if (wakeWeight(e) + (has ? 1 : 2) > max) return null;
  const next = has ? hooks.map((h) => (h.link === link ? { link, recs: h.recs.concat([rec]) } : h)) : hooks.concat([{ link, recs: [rec] }]);
  return rooms.map((x, j) => (j === i ? withWakes(x, next) : x));
}

/** A call's own write after its set: its recording id (on the entry
 *  (room, token), under link) goes; the link stays. Unchanged when it is
 *  not there. */
export function wakeAnswered(rooms: AgentEntry[], room: string, token: string, link: string, id: string): AgentEntry[] {
  const i = at(rooms, room, token);
  if (i < 0) return rooms;
  const hooks = (rooms[i].hooks || []).map((h) => (h.link === link ? { link, recs: h.recs.filter((r) => r.id !== id) } : h));
  return rooms.map((x, j) => (j === i ? withWakes(x, hooks) : x));
}

/** An entry's links after an observation of its seat: those that stay (the
 *  one the hook is on, or one with a recording not expired), each without
 *  its expired recordings. */
export function wakeLinksAfter(e: AgentEntry, s: WakeSeen): AgentWake[] {
  const out: AgentWake[] = [];
  for (const h of e.hooks || []) {
    const recs = h.recs.filter((r) => !wakeExpired(r, s.now));
    const leaves = (s.only === undefined || s.only === h.link) && h.link !== s.link && recs.length === 0;
    if (!leaves) out.push({ link: h.link, recs });
  }
  return out;
}

/** A settling write's change: every entry observed (each observation
 *  stamped with the version the list was read at) with its links after
 *  that observation. */
export function wakeSettle(rooms: AgentEntry[], seen: WakeSeen[]): AgentEntry[] {
  return rooms.map((e) => {
    const s = seen.find((x) => x.room === e.room && x.token === e.token);
    return s ? withWakes(e, wakeLinksAfter(e, s)) : e;
  });
}

/** The one check every write of a key's list goes through (routes/agent.ts
 *  rewrite, and a cut key's remainder and deletion): every link on the list
 *  at version ver (before) is on the new list (after, same room and token),
 *  or comes with an observation of its entry stamped with ver, whose hook
 *  is not that link, by whose room clock each of its outstanding
 *  recordings at ver has expired (one that names the link it dropped
 *  settles that link only). It throws otherwise, and nothing is written. A
 *  recording may go while its link stays: a call's own write after its
 *  set, or a prune. */
export function keepsWakes(ver: number, before: AgentEntry[], after: AgentEntry[], seen: WakeSeen[]): void {
  for (const e of before) {
    for (const h of e.hooks || []) {
      const still = after.find((a) => a.room === e.room && a.token === e.token);
      if (still && (still.hooks || []).some((k) => k.link === h.link)) continue;
      const s = seen.find((x) => x.room === e.room && x.token === e.token);
      if (!s) throw new Error("a recorded Muse wake would leave the key's list with no observation of its room");
      if (s.ver !== ver) throw new Error("a recorded Muse wake would leave the key's list on an observation made before another version of it");
      if (s.only !== undefined && s.only !== h.link) throw new Error("a recorded Muse wake would leave the key's list on a drop of another link");
      if (s.link === h.link) throw new Error("a recorded Muse wake would leave the key's list while its hook is on");
      if (h.recs.some((r) => !wakeExpired(r, s.now))) throw new Error("a recorded Muse wake would leave the key's list while a set of it may still reach the room");
    }
  }
}
