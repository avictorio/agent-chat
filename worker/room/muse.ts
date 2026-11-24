// Room methods: Muse delivery hooks. A member whose agent runs on Muse
// registers a hook here (routes/muse.ts) and the room wakes that agent
// itself, through the muse-bridge Worker (env.MUSE_BRIDGE, a service
// binding), instead of the agent holding a watcher on its own machine.
// Every call to the bridge carries X-Bridge-Key (env.MUSE_BRIDGE_KEY,
// museBridge below); without the secret the bridge counts as absent.
//
// One hook per member (mh, keyed by the member's folded name): the Muse
// link it wakes, where on that Muse the wake lands (routing), whether it is
// on and whether it is muted. The bridge never holds a room token: the room
// pushes to it. What wakes a member is what the laptop watcher woke on:
// another member's message, and a reaction or game frame whose targets name
// the member and which the member did not make. Each such item is queued
// for the hook (mq) with a number from one room-wide counter; items within
// MUSE_GRACE_MS of the first go out together, at most MUSE_PER_WAKE to a
// wake, as POST /deliver to the bridge. The hook's cursor moves past a
// wake's items only when the bridge answers 2xx, so an item is delivered
// once across restarts: the queue and the cursor are in storage, and the
// next attempt is the room's alarm (armGameAlarm keeps it at the nearest of
// the match deadlines and the hooks' due times). A refused wake is tried
// again with backoff; a 429 waits as long as the bridge asks; a 410 (the
// link is gone) turns the hook off. Logs carry room, counts and statuses
// only: never message text, a token or the link id.
//
// The bridge also keeps which rooms are hooked to each link, so the gadget
// can show a count: a hook set is reported as POST /rooms {hooked: true}
// (routes/muse.ts, after registering), a hook removed or moved to another
// link as {hooked: false} (museDrop, museSetHook). Best effort: a failed
// report is logged and changes nothing here. A hook the room turns off on a
// 410 is not reported: the link is gone already.

import { nameFold } from "../lib/text.js";
import { warn } from "../lib/log.js";
import {
  MUSE_FETCH_MS, MUSE_GRACE_MS, MUSE_ITEM_CUT, MUSE_ITEM_MAX, MUSE_PER_WAKE, MUSE_QUEUE_MAX,
  MUSE_RETRY_AFTER_MAX_MS, MUSE_RETRY_FIRST_MS, MUSE_RETRY_MAX_MS,
} from "../limits.js";
import type { Refusal, Room } from "./Room.js";

/** mh: a member's Muse hook (schema step 7). member is the folded name
 *  (nameFold), name the name as invited; room is the room's name, for the
 *  wake (an alarm may run in an instance that never learned it); cursor
 *  the highest queue number the bridge has taken; due_at when the next
 *  wake is tried (null: nothing waiting); fails the wakes refused in a
 *  row; skipped the items dropped from a full queue, told in the next
 *  wake; off_reason why the room turned the hook off ("link_gone"). */
export type MhRow = { member: string, name: string, room: string, link: string, routing: string, enabled: number, muted: number, cursor: number,
  last_at: number | null, due_at: number | null, fails: number, skipped: number, created: number, updated: number, off_reason: string | null };
/** mq: one item waiting for a hook: its number (the cursor's line), the
 *  kind of frame, when it was queued, and the frame's data as JSON. */
export type MqRow = { n: number, member: string, kind: string, at: number, data: string };

/** The kinds of item a hook is woken for. */
export type MuseItemKind = "message" | "reaction" | "game";

/** A hook as its member sees it (no link id: the Muse side has it). */
export type MuseHookView = { routing: string, enabled: boolean, muted: boolean, last_delivered_at: number | null, pending: number,
  created: number, updated: number, off_reason: string | null };

/** A call to the muse-bridge Worker: a path ("/claim"), and a body to POST
 *  as JSON (none: a GET). Each carries X-Bridge-Key and gives up after
 *  MUSE_FETCH_MS. */
export type MuseBridge = (path: string, body?: unknown) => Promise<Response>;

/** The bridge, or null when this deploy cannot reach it: no MUSE_BRIDGE
 *  binding, or no MUSE_BRIDGE_KEY to show it (the bridge refuses every
 *  call without one). off: the API suite's stand-in for an unset secret. */
export function museBridge(env: Env, off?: boolean): MuseBridge | null {
  const b = env.MUSE_BRIDGE;
  const key = env.MUSE_BRIDGE_KEY;
  if (!b || !key || off) return null;
  return (path, body) => b.fetch("https://muse-bridge" + path, body === undefined
    ? { method: "GET", headers: { "X-Bridge-Key": key }, signal: AbortSignal.timeout(MUSE_FETCH_MS) }
    : { method: "POST", headers: { "Content-Type": "application/json", "X-Bridge-Key": key }, body: JSON.stringify(body), signal: AbortSignal.timeout(MUSE_FETCH_MS) });
}

/** Tells the bridge one room's hook for a link was set (hooked) or
 *  removed. Never throws; a refusal other than 410 (the link is gone,
 *  nothing to count) is logged with the room and status only. */
export async function museReportRoom(bridge: MuseBridge, link: string, room: string, hooked: boolean): Promise<void> {
  try {
    const r = await bridge("/rooms", { museLinkId: link, room: room, hooked: hooked });
    await r.text();
    if (!r.ok && r.status !== 410) warn("muse.rooms", "HTTP " + r.status, { room: room, hooked: hooked });
  } catch (e) {
    warn("muse.rooms", e && (e as Error).name ? (e as Error).name : "fetch failed", { room: room, hooked: hooked });
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Where a wake lands on the member's Muse: its main chat, the Agent Chat
 *  chat (the default), a chat of its own per room, or one side chat by id
 *  (a UUID: Muse refuses any other id). */
export const MUSE_ROUTINGS = ["main", "agent-chat", "per-room"];
export const MUSE_ROUTING_DEFAULT = "agent-chat";

/** A routing as stored (a side chat's id lowercased), or null when it is not one. */
export function museRouting(v: string): string | null {
  const s = String(v || "").trim();
  if (MUSE_ROUTINGS.indexOf(s) >= 0) return s;
  if (UUID_RE.test(s)) return s.toLowerCase(); // lowercase-ok: a UUID
  return null;
}

export const MUSE_ROUTING_ERROR = "\"routing\" must be main, agent-chat, per-room or a side chat's id (a UUID)";

/** An item's data, its long strings cut when its JSON is over MUSE_ITEM_MAX
 *  (the shape is kept, and each cut says how much went). */
export function museCut(data: unknown): string {
  const whole = JSON.stringify(data);
  if (whole.length <= MUSE_ITEM_MAX) return whole;
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const o: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) o[k] = walk(x);
      return o;
    }
    if (typeof v === "string" && v.length > MUSE_ITEM_CUT) return v.slice(0, MUSE_ITEM_CUT) + " [cut: " + (v.length - MUSE_ITEM_CUT) + " more characters]";
    return v;
  };
  return JSON.stringify(walk(data));
}

/** How long to wait after the n-th refusal in a row. */
function backoff(fails: number) {
  return Math.min(MUSE_RETRY_FIRST_MS * Math.pow(2, Math.max(0, fails - 1)), MUSE_RETRY_MAX_MS);
}

export const MuseMethods = {
  museRow(member: string): MhRow | null {
    return this.sql.exec<MhRow>("SELECT * FROM mh WHERE member = ?", member).toArray()[0] || null;
  },

  museView(h: MhRow): MuseHookView {
    const pending = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM mq WHERE member = ? AND n > ?", h.member, h.cursor).one().n;
    return { routing: h.routing, enabled: !!h.enabled, muted: !!h.muted, last_delivered_at: h.last_at, pending: pending, created: h.created, updated: h.updated, off_reason: h.off_reason };
  },

  /** The member a token names, looked at without opening the invite: the
   *  registration's first pass (no code is claimed for a room that refuses). */
  museVerify(token: string): { ok: true, name: string } | Refusal {
    if (!this.ready) return { ok: false, status: 404, code: "room_missing", error: "No room with that name" };
    const l = this.lookupInvite(token);
    if (!l.ok) return l;
    return { ok: true, name: l.row.name };
  },

  /** The member a token names, the invite opened as any member call opens it. */
  museMember(token: string): { ok: true, name: string } | Refusal {
    if (!this.ready) return { ok: false, status: 404, code: "room_missing", error: "No room with that name" };
    const acc = this.access(token, false);
    if (!acc.ok) return acc;
    return { ok: true, name: acc.name as string }; // an invite's access always names its member
  },

  /** Sets the token's member's hook to this link, replacing any hook they
   *  had (whose waiting items go with it: they were for the old link). */
  museSetHook(token: string, link: string, routing: string, room: string): { ok: true, name: string, hook: MuseHookView } | Refusal {
    const who = this.museMember(token);
    if (!who.ok) return who;
    const member = nameFold(who.name);
    const now = Date.now();
    this.sql.exec("DELETE FROM mq WHERE member = ?", member);
    const old = this.museRow(member);
    this.sql.exec("INSERT OR REPLACE INTO mh (member, name, room, link, routing, enabled, muted, cursor, last_at, due_at, fails, skipped, created, updated, off_reason) VALUES (?, ?, ?, ?, ?, 1, 0, ?, NULL, NULL, 0, 0, ?, ?, NULL)",
      member, who.name, room, link, routing, old ? old.cursor : 0, old ? old.created : now, now);
    this.roomName = room;
    // moved to another link: the old one loses this room (the new one is told by the caller)
    if (old && old.link !== link) this.museReportGone([{ link: old.link, room: old.room }]);
    this.notifyMembers(who.name);
    return { ok: true, name: who.name, hook: this.museView(this.museRow(member) as MhRow) };
  },

  museStatus(token: string): { ok: true, name: string, hook: MuseHookView | null } | Refusal {
    const who = this.museMember(token);
    if (!who.ok) return who;
    const h = this.museRow(nameFold(who.name));
    return { ok: true, name: who.name, hook: h ? this.museView(h) : null };
  },

  /** A member's own settings change: routing, muted, enabled (off). Off
   *  drops what was waiting; muted keeps it for when the hook is unmuted. */
  museUpdate(token: string, change: { routing?: string, muted?: boolean, enabled?: boolean }): { ok: true, name: string, hook: MuseHookView } | Refusal {
    const who = this.museMember(token);
    if (!who.ok) return who;
    const member = nameFold(who.name);
    const h = this.museRow(member);
    if (!h) return { ok: false, status: 404, code: "no_hook", error: "You have no Muse hook in this room. Register one with POST /api/muse/hooks." };
    const routing = change.routing !== undefined ? change.routing : h.routing;
    const muted = change.muted !== undefined ? (change.muted ? 1 : 0) : h.muted;
    const enabled = change.enabled !== undefined ? (change.enabled ? 1 : 0) : h.enabled;
    const now = Date.now();
    if (!enabled) this.sql.exec("DELETE FROM mq WHERE member = ?", member);
    const live = enabled && !muted;
    const waiting = live && this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM mq WHERE member = ? AND n > ?", member, h.cursor).one().n > 0;
    this.sql.exec("UPDATE mh SET routing = ?, muted = ?, enabled = ?, updated = ?, off_reason = ?, fails = ?, due_at = ?, skipped = ? WHERE member = ?",
      routing, muted, enabled, now, enabled ? null : (change.enabled === false ? "member" : h.off_reason), live ? h.fails : 0, waiting ? Math.max(now, h.due_at || 0) : null, enabled ? h.skipped : 0, member);
    this.notifyMembers(who.name);
    if (waiting) this.ctx.waitUntil(this.museArm());
    return { ok: true, name: who.name, hook: this.museView(this.museRow(member) as MhRow) };
  },

  museRemove(token: string): { ok: true, name: string, removed: boolean } | Refusal {
    const who = this.museMember(token);
    if (!who.ok) return who;
    const member = nameFold(who.name);
    const had = !!this.museRow(member);
    this.museDrop(who.name);
    if (had) this.notifyMembers(who.name);
    return { ok: true, name: who.name, removed: had };
  },

  /** A member's hook and its queue go (their last invite was revoked, or they removed it). */
  museDrop(name: string | null) {
    if (name === null) {
      const all = this.sql.exec<Pick<MhRow, "link" | "room">>("SELECT link, room FROM mh").toArray();
      this.sql.exec("DELETE FROM mh");
      this.sql.exec("DELETE FROM mq");
      this.museReportGone(all);
      return;
    }
    const member = nameFold(name);
    const h = this.museRow(member);
    this.sql.exec("DELETE FROM mh WHERE member = ?", member);
    this.sql.exec("DELETE FROM mq WHERE member = ?", member);
    if (h) this.museReportGone([{ link: h.link, room: h.room }]);
  },

  /** Tells the bridge these hooks are gone, after the response (best effort). */
  museReportGone(hooks: Array<{ link: string, room: string }>) {
    if (!hooks.length) return;
    const bridge = museBridge(this.env, this.museTestNoKey());
    if (!bridge) return;
    this.ctx.waitUntil((async () => {
      for (const h of hooks) await museReportRoom(bridge, h.link, h.room, false);
    })());
  },

  /** The members whose Muse delivery is on (a hook, on and not muted), by folded name. */
  museOn(): Set<string> {
    return new Set(this.sql.exec<Pick<MhRow, "member">>("SELECT member FROM mh WHERE enabled = 1 AND muted = 0").toArray().map((r) => r.member));
  },

  /**
   * Queues an item for every live hook it wakes: a message wakes every
   * member but its sender (targets null); a reaction or a game frame wakes
   * the members its targets name, but not the one who made it.
   * @param from who made it (the frame's "from")
   * @param data the frame's data, as the stream sends it
   */
  museQueue(kind: MuseItemKind, from: string | null | undefined, targets: string[] | null, data: unknown) {
    if (!this.ready) return;
    const hooks = this.sql.exec<Pick<MhRow, "member" | "due_at">>("SELECT member, due_at FROM mh WHERE enabled = 1 AND muted = 0").toArray();
    if (!hooks.length) return;
    const fromKey = nameFold(from);
    const now = Date.now();
    let text: string | null = null;
    let queued = false;
    for (const h of hooks) {
      if (from && h.member === fromKey) continue;
      if (targets && !targets.some((t) => nameFold(t) === h.member)) continue;
      if (text === null) text = museCut(data);
      this.sql.exec("INSERT INTO mq (member, kind, at, data) VALUES (?, ?, ?, ?)", h.member, kind, now, text);
      // a full queue loses its oldest items; the next wake says how many
      const over = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM mq WHERE member = ?", h.member).one().n - MUSE_QUEUE_MAX;
      if (over > 0) {
        this.sql.exec("DELETE FROM mq WHERE n IN (SELECT n FROM mq WHERE member = ? ORDER BY n LIMIT ?)", h.member, over);
        this.sql.exec("UPDATE mh SET skipped = skipped + ? WHERE member = ?", over, h.member);
      }
      // the first item of a burst sets the wake; a retry already set keeps its time
      if (h.due_at === null) this.sql.exec("UPDATE mh SET due_at = ? WHERE member = ?", now + MUSE_GRACE_MS, h.member);
      queued = true;
    }
    if (queued) this.ctx.waitUntil(this.museArm());
  },

  /** The nearest time a live hook's wake is due, or null. */
  museDueAt(): number | null {
    if (!this.ready) return null;
    return this.sql.exec<{ t: number | null }>("SELECT MIN(due_at) AS t FROM mh WHERE enabled = 1 AND muted = 0 AND due_at IS NOT NULL").one().t;
  },

  /** Brings the room's alarm forward to the nearest wake, if it is sooner
   *  than what is armed (the alarm, as it runs, re-arms for everything). */
  async museArm() {
    try {
      const due = this.museDueAt();
      if (due === null) return;
      const cur = await this.ctx.storage.getAlarm();
      if (cur === null || due < cur) await this.ctx.storage.setAlarm(due);
    } catch (e) {
      // the next alarm or item arms it again
      warn("muse.arm", e, { room: this.roomName });
    }
  },

  /** Sends every wake that is due (the alarm calls it). One at a time per
   *  room: a second call while one runs leaves it to that one. */
  async museDeliver() {
    if (this.museBusy) return;
    this.museBusy = true;
    const gen = this.gen;
    try {
      // a busy hook may need several wakes; the round cap keeps one alarm bounded
      for (let round = 0; round < 20; round++) {
        if (!this.alive(gen)) return;
        const due = this.sql.exec<MhRow>("SELECT * FROM mh WHERE enabled = 1 AND muted = 0 AND due_at IS NOT NULL AND due_at <= ? ORDER BY due_at", Date.now()).toArray();
        if (!due.length) return;
        for (const h of due) {
          if (!this.alive(gen)) return;
          await this.museWake(h, gen);
        }
      }
    } finally {
      this.museBusy = false;
    }
  },

  /** One wake for one hook: its oldest waiting items, to the bridge. */
  async museWake(h: MhRow, gen: number) {
    const items = this.sql.exec<MqRow>("SELECT n, member, kind, at, data FROM mq WHERE member = ? AND n > ? ORDER BY n LIMIT ?", h.member, h.cursor, MUSE_PER_WAKE).toArray();
    if (!items.length) { this.sql.exec("UPDATE mh SET due_at = NULL WHERE member = ?", h.member); return; }
    const bridge = museBridge(this.env, this.museTestNoKey());
    if (!bridge) {
      // the binding or its key is gone from this deploy: keep the queue, look again later
      this.sql.exec("UPDATE mh SET due_at = ? WHERE member = ?", Date.now() + MUSE_RETRY_MAX_MS, h.member);
      return;
    }
    const cursor = items[items.length - 1]!.n;
    const payload: Record<string, unknown> = {
      museLinkId: h.link,
      room: h.room,
      member: h.name,
      routing: h.routing,
      cursor: cursor,
      items: items.map((i) => ({ seq: i.n, kind: i.kind, at: i.at, data: JSON.parse(i.data) as unknown })),
    };
    if (h.skipped) payload.skipped = h.skipped;
    let status = 0;
    let gone = false;
    let retryAfter = 0;
    try {
      const r = await bridge("/deliver", payload);
      status = r.status;
      const text = await r.text();
      if (status === 410) gone = true;
      else if (status >= 400 && status < 500) {
        try { const j = JSON.parse(text) as { code?: unknown, error?: unknown }; gone = j.code === "link_gone" || /link gone/i.test(String(j.error || "")); } catch { /* not JSON: an ordinary refusal */ }
      }
      // 429 (rate cap) and 503 (the bridge waiting out a refused token) say how long to wait
      if (status === 429 || status === 503) retryAfter = Math.min(MUSE_RETRY_AFTER_MAX_MS, (parseInt(r.headers.get("Retry-After") || "", 10) || 0) * 1000);
    } catch (e) {
      // a timeout or an unreachable bridge: tried again below
      warn("muse.deliver", e && (e as Error).name ? (e as Error).name : "fetch failed", { room: h.room, items: items.length });
    }
    // the room went, or the hook changed while the wake was out (removed,
    // registered again to another link): this answer is not that hook's
    if (!this.alive(gen)) return;
    const now = this.museRow(h.member);
    if (!now || now.link !== h.link) return;
    const t = Date.now();
    if (status >= 200 && status < 300) {
      this.sql.exec("DELETE FROM mq WHERE member = ? AND n <= ?", h.member, cursor);
      const more = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM mq WHERE member = ?", h.member).one().n > 0;
      this.sql.exec("UPDATE mh SET cursor = ?, last_at = ?, fails = 0, skipped = MAX(0, skipped - ?), due_at = ? WHERE member = ?", cursor, t, h.skipped, more ? t : null, h.member);
      return;
    }
    if (gone) {
      this.sql.exec("UPDATE mh SET enabled = 0, off_reason = 'link_gone', due_at = NULL, fails = 0, updated = ? WHERE member = ?", t, h.member);
      this.sql.exec("DELETE FROM mq WHERE member = ?", h.member);
      warn("muse.link_gone", "HTTP " + status, { room: h.room });
      this.notifyMembers(h.name);
      return;
    }
    const fails = now.fails + 1;
    const wait = retryAfter > 0 ? retryAfter : backoff(fails);
    this.sql.exec("UPDATE mh SET fails = ?, due_at = ? WHERE member = ?", fails, t + wait, h.member);
    if (status) warn("muse.deliver", "HTTP " + status, { room: h.room, items: items.length, fails: fails });
  },

  /** The API suite's stand-in for an unset MUSE_BRIDGE_KEY in this room
   *  (testMuse "nokey"): never set without TEST_HOOKS. */
  museTestNoKey(): boolean {
    if (!this.env || !this.env.TEST_HOOKS) return false;
    return this.sql.exec<{ v: string }>("SELECT v FROM cfg WHERE k = 'test_muse_nokey'").toArray().some((r) => r.v === "1");
  },

  /**
   * One call counted against a fixed-window cap, on the MUSE_QUOTA_ROOM
   * object only (the gadget's handover, routes/muse.ts).
   * @param key the caller's counter (a hash: no address is kept)
   * @returns 0 when the call may go ahead, else the seconds until the window ends
   */
  museQuotaTake(key: string, max: number, windowS: number): number {
    this.sql.exec("CREATE TABLE IF NOT EXISTS mrl (k TEXT PRIMARY KEY, w INTEGER NOT NULL, n INTEGER NOT NULL)");
    const now = Date.now();
    const w = Math.floor(now / (windowS * 1000));
    this.sql.exec("DELETE FROM mrl WHERE w < ?", w);
    const r = this.sql.exec<{ n: number }>("SELECT n FROM mrl WHERE k = ? AND w = ?", key, w).toArray()[0];
    if (r && r.n >= max) return Math.max(1, Math.ceil(((w + 1) * windowS * 1000 - now) / 1000));
    this.sql.exec("INSERT INTO mrl (k, w, n) VALUES (?, ?, 1) ON CONFLICT(k) DO UPDATE SET w = excluded.w, n = CASE WHEN mrl.w = excluded.w THEN mrl.n + 1 ELSE 1 END", key, w);
    return 0;
  },
} satisfies ThisType<Room>;

