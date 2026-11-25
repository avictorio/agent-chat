// Room methods: Muse delivery hooks. A member whose agent runs on Muse
// registers a hook here (routes/muse.ts) and the room wakes that agent
// itself, through the Muse bridge (worker/bridge, called in-process by
// museBridge below), instead of the agent holding a watcher on its own
// machine.
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
//
// A hook can instead wake an HTTPS URL (kind "webhook", routes/webhook.ts,
// lib/webhook.ts), for agents that are not on Muse: the same queue, cursor,
// grouping, retries and switches, with the wake POSTed to the URL, signed
// with the hook's secret, at most one per WEBHOOK_MIN_GAP_MS. A 410 from
// the URL turns the hook off (off_reason "gone"). The bridge never hears
// of webhook hooks. Every hook keeps its last answer (last_status,
// last_error) for its member to see.

import { nameFold } from "../lib/text.js";
import { warn } from "../lib/log.js";
import { webhookCall } from "../lib/webhook.js";
import { bridgeFetch } from "../bridge/index.js";
import { WAKE_BUDGET_HEADER } from "../bridge/util.js";
import {
  WEBHOOK_ERROR_MAX, WEBHOOK_MIN_GAP_MS,
  MUSE_ALARM_WAKES_MS, MUSE_FETCH_MS, MUSE_GRACE_MS, MUSE_ITEM_CUT, MUSE_ITEM_MAX, MUSE_PER_WAKE, MUSE_QUEUE_MAX,
  MUSE_RETRY_AFTER_MAX_MS, MUSE_RETRY_FIRST_MS, MUSE_RETRY_MAX_MS, MUSE_WAKE_BUDGET_MS, MUSE_WAKE_WAIT_MARGIN_MS, MUSE_WAKES_AT_ONCE,
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
  last_at: number | null, due_at: number | null, fails: number, skipped: number, created: number, updated: number, off_reason: string | null,
  kind: HookKind, url: string | null, secret: string | null, last_status: number | null, last_error: string | null };

/** What a hook wakes: a Muse (through the bridge) or an HTTPS URL. */
export type HookKind = "muse" | "webhook";
/** mq: one item waiting for a hook: its number (the cursor's line), the
 *  kind of frame, when it was queued, and the frame's data as JSON. */
export type MqRow = { n: number, member: string, kind: string, at: number, data: string };

/** The kinds of item a hook is woken for. */
export type MuseItemKind = "message" | "reaction" | "game";

/** A hook as its member sees it (no link id: the Muse side has it). */
export type MuseHookView = { kind: HookKind, url?: string, routing?: string, enabled: boolean, muted: boolean, last_delivered_at: number | null, pending: number,
  last_status: number | null, last_error: string | null, created: number, updated: number, off_reason: string | null };

/** A call to the Muse bridge: a path ("/claim"), and a body to POST as
 *  JSON (none: a GET), answered as the bridge's router answers it. A wake
 *  (/deliver) also passes its time, budgetMs. */
export type MuseBridge = (path: string, body?: unknown, budgetMs?: number) => Promise<Response>;

/** The bridge (worker/bridge/index.ts bridgeFetch), in this Worker. A wake
 *  carries its time (WAKE_BUDGET_HEADER), within which the bridge always
 *  answers; the room waits MUSE_WAKE_WAIT_MARGIN_MS longer than that, for
 *  the trip to the link and back. Any other call waits MUSE_FETCH_MS. A
 *  call that has not answered by then rejects with a TimeoutError: the
 *  caller tries again later, and a wake whose answer was lost after it
 *  landed is the bridge's dedupe to catch, so it is not sent twice. */
export function museBridge(env: Env): MuseBridge {
  return (path, body, budgetMs) => {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (budgetMs !== undefined) headers[WAKE_BUDGET_HEADER] = String(budgetMs);
    const request = new Request("https://muse-bridge" + path, body === undefined
      ? { method: "GET", headers }
      : { method: "POST", headers, body: JSON.stringify(body) });
    return withTimeout(bridgeFetch(request, env), budgetMs === undefined ? MUSE_FETCH_MS : budgetMs + MUSE_WAKE_WAIT_MARGIN_MS);
  };
}

/** p, or a TimeoutError once ms have passed. p runs on either way. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new DOMException("The Muse bridge did not answer in time", "TimeoutError")), ms);
  });
  // a failure after the race gave up on p has no one left to tell
  p.catch(() => undefined);
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
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
    const v: MuseHookView = { kind: h.kind, enabled: !!h.enabled, muted: !!h.muted, last_delivered_at: h.last_at, pending: pending,
      last_status: h.last_status, last_error: h.last_error, created: h.created, updated: h.updated, off_reason: h.off_reason };
    // a Muse hook's routing; a webhook's URL (never its secret)
    if (h.kind === "webhook") v.url = h.url || ""; else v.routing = h.routing;
    return v;
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
    this.museWrite(member, who.name, room, "muse", link, routing, null, null, old, now);
    this.roomName = room;
    // moved to another link: the old one loses this room (the new one is told by the caller)
    if (old && old.kind === "muse" && old.link !== link) this.museReportGone([{ link: old.link, room: old.room }]);
    this.notifyMembers(who.name);
    return { ok: true, name: who.name, hook: this.museView(this.museRow(member) as MhRow) };
  },

  /** Writes a member's hook, replacing what they had; the cursor carries
   *  over (queue numbers are room-wide), the creation time too. */
  museWrite(member: string, name: string, room: string, kind: HookKind, link: string, routing: string, url: string | null, secret: string | null, old: MhRow | null, now: number) {
    this.sql.exec("INSERT OR REPLACE INTO mh (member, name, room, link, routing, enabled, muted, cursor, last_at, due_at, fails, skipped, created, updated, off_reason, kind, url, secret, last_status, last_error) VALUES (?, ?, ?, ?, ?, 1, 0, ?, NULL, NULL, 0, 0, ?, ?, NULL, ?, ?, ?, NULL, NULL)",
      member, name, room, link, routing, old ? old.cursor : 0, old ? old.created : now, now, kind, url, secret);
  },

  /** Sets the token's member's hook to call this URL (its challenge already
   *  answered: routes/webhook.ts), replacing any hook they had. */
  webhookSet(token: string, url: string, secret: string, room: string): { ok: true, name: string, hook: MuseHookView } | Refusal {
    const who = this.museMember(token);
    if (!who.ok) return who;
    const member = nameFold(who.name);
    const now = Date.now();
    this.sql.exec("DELETE FROM mq WHERE member = ?", member);
    const old = this.museRow(member);
    this.museWrite(member, who.name, room, "webhook", "", "", url, secret, old, now);
    this.roomName = room;
    // was a Muse hook: its link loses this room
    if (old && old.kind === "muse") this.museReportGone([{ link: old.link, room: old.room }]);
    this.notifyMembers(who.name);
    return { ok: true, name: who.name, hook: this.museView(this.museRow(member) as MhRow) };
  },

  /** A webhook's new secret, replacing the old one at once. */
  webhookRotate(token: string, secret: string): { ok: true, name: string, hook: MuseHookView } | Refusal {
    const who = this.museMember(token);
    if (!who.ok) return who;
    const member = nameFold(who.name);
    const h = this.museRow(member);
    if (!h || h.kind !== "webhook") return { ok: false, status: 404, code: "no_webhook", error: "You have no webhook in this room. Register one with POST /api/rooms/ROOM/webhook {\"url\"}." };
    this.sql.exec("UPDATE mh SET secret = ?, updated = ? WHERE member = ?", secret, Date.now(), member);
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
    if (!h) return { ok: false, status: 404, code: "no_hook", error: "You have no hook in this room. Register a Muse with POST /api/muse/hooks, or a webhook with POST /api/rooms/ROOM/webhook." };
    if (change.routing !== undefined && h.kind !== "muse") return { ok: false, status: 400, code: "not_muse", error: "\"routing\" is for Muse hooks; your hook in this room is a webhook" };
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
      const all = this.sql.exec<Pick<MhRow, "link" | "room">>("SELECT link, room FROM mh WHERE kind = 'muse'").toArray();
      this.sql.exec("DELETE FROM mh");
      this.sql.exec("DELETE FROM mq");
      this.museReportGone(all);
      return;
    }
    const member = nameFold(name);
    const h = this.museRow(member);
    this.sql.exec("DELETE FROM mh WHERE member = ?", member);
    this.sql.exec("DELETE FROM mq WHERE member = ?", member);
    if (h && h.kind === "muse") this.museReportGone([{ link: h.link, room: h.room }]);
  },

  /** Tells the bridge these hooks are gone, after the response (best effort). */
  museReportGone(hooks: Array<{ link: string, room: string }>) {
    if (!hooks.length) return;
    const bridge = museBridge(this.env);
    this.ctx.waitUntil((async () => {
      for (const h of hooks) await museReportRoom(bridge, h.link, h.room, false);
    })());
  },

  /** The members whose delivery is on (a hook, on and not muted), by folded name. */
  museOn(): Set<string> {
    return new Set(this.museOnKinds().keys());
  },

  /** The same, with each hook's kind. */
  museOnKinds(): Map<string, HookKind> {
    return new Map(this.sql.exec<Pick<MhRow, "member" | "kind">>("SELECT member, kind FROM mh WHERE enabled = 1 AND muted = 0").toArray().map((r) => [r.member, r.kind] as [string, HookKind]));
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

  /**
   * Sends the wakes that are due (the alarm calls it, after the match
   * clocks). Wakes for different members go out together, at most
   * MUSE_WAKES_AT_ONCE at a time; a member's wakes go one at a time (a busy
   * hook's next wake starts once its last has settled). New wakes start only
   * within the run's allowance, MUSE_ALARM_WAKES_MS: what is still due when
   * it is used up stays queued and due, and the alarm the caller re-arms
   * (armGameAlarm, museDueAt) comes right after for it. Wakes used to go one
   * after another with nothing but a round cap, so one slow Muse held every
   * other member's wake, and the room's alarm, for as long as it took. One
   * run per room: a second call while one runs leaves the wakes to it.
   * Each wake gets its own time, MUSE_WAKE_BUDGET_MS, whenever in the
   * allowance it starts.
   * @param limits a shorter allowance and wake time, for tests
   */
  async museDeliver(limits: { allowanceMs?: number, budgetMs?: number } = {}) {
    if (this.museBusy) return;
    this.museBusy = true;
    const gen = this.gen;
    const until = Date.now() + (limits.allowanceMs ?? MUSE_ALARM_WAKES_MS);
    const budget = limits.budgetMs ?? MUSE_WAKE_BUDGET_MS;
    /** members with a wake out, or whose wake failed this run */
    const taken = new Set<string>();
    const next = (): MhRow | null => {
      if (!this.alive(gen) || Date.now() >= until) return null;
      const due = this.sql.exec<MhRow>("SELECT * FROM mh WHERE enabled = 1 AND muted = 0 AND due_at IS NOT NULL AND due_at <= ? ORDER BY due_at", Date.now()).toArray();
      return due.find((h) => !taken.has(h.member)) || null;
    };
    // A lane whose pick fails (storage) stops; the run ends only when every
    // lane has, or the next run would pick the members whose wakes are
    // still out and send them again.
    const pickFailed: { error: unknown }[] = [];
    const pick = (): MhRow | null => {
      try {
        return next();
      } catch (e) {
        pickFailed.push({ error: e });
        return null;
      }
    };
    const lane = async () => {
      for (let h = pick(); h; h = pick()) {
        taken.add(h.member);
        try {
          await this.museWake(h, gen, budget);
          taken.delete(h.member);
        } catch (e) {
          // A wake that threw left its hook due: picked again at once, it
          // would spin until the allowance ran out, and every run after.
          // It waits out a backoff instead, and sits out this run. Its
          // name only: a queued item that no longer parses would put
          // member text in the message (lib/log.ts).
          warn("muse.wake", e instanceof Error ? e.name : null, { room: h.room });
          this.museDefer(h.member, gen);
        }
      }
    };
    try {
      await Promise.allSettled(Array.from({ length: MUSE_WAKES_AT_ONCE }, lane));
    } finally {
      this.museBusy = false;
    }
    const failed = pickFailed[0];
    if (failed) warn("muse.pick", failed.error, { room: this.roomName, lanes: pickFailed.length });
  },

  /** A hook whose wake failed outside museSettle (a throw): tried again
   *  after the backoff, as a refused wake is. */
  museDefer(member: string, gen: number) {
    try {
      if (!this.alive(gen)) return;
      const h = this.museRow(member);
      if (!h) return;
      this.sql.exec("UPDATE mh SET fails = ?, due_at = ? WHERE member = ?", h.fails + 1, Date.now() + backoff(h.fails + 1), member);
    } catch (e) {
      warn("muse.defer", e, { room: this.roomName });
    }
  },

  /** One wake for one hook: its oldest waiting items, to the bridge (with
   *  budgetMs, the wake's time) or the URL. */
  async museWake(h: MhRow, gen: number, budgetMs: number = MUSE_WAKE_BUDGET_MS) {
    const items = this.sql.exec<MqRow>("SELECT n, member, kind, at, data FROM mq WHERE member = ? AND n > ? ORDER BY n LIMIT ?", h.member, h.cursor, MUSE_PER_WAKE).toArray();
    if (!items.length) { this.sql.exec("UPDATE mh SET due_at = NULL WHERE member = ?", h.member); return; }
    if (h.kind === "webhook") return this.webhookWake(h, items, gen);
    const bridge = museBridge(this.env);
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
      const r = await bridge("/deliver", payload, budgetMs);
      status = r.status;
      const text = await r.text();
      if (status === 410) gone = true;
      else if (status >= 400 && status < 500) {
        try { const j = JSON.parse(text) as { code?: unknown, error?: unknown }; gone = j.code === "link_gone" || /link gone/i.test(String(j.error || "")); } catch { /* not JSON: an ordinary refusal */ }
      }
      // 429 (rate cap) and 503 (a refused token, a pause, a wake out of time) say how long to wait
      if (status === 429 || status === 503) retryAfter = Math.min(MUSE_RETRY_AFTER_MAX_MS, (parseInt(r.headers.get("Retry-After") || "", 10) || 0) * 1000);
    } catch (e) {
      // a timeout or an unreachable bridge: tried again below
      warn("muse.deliver", e && (e as Error).name ? (e as Error).name : "fetch failed", { room: h.room, items: items.length });
    }
    // the room went, or the hook changed while the wake was out (removed,
    // registered again to another link): this answer is not that hook's
    if (!this.alive(gen)) return;
    const now = this.museRow(h.member);
    if (!now || now.kind !== "muse" || now.link !== h.link) return;
    const ok = status >= 200 && status < 300;
    this.museSettle(h, now, cursor, status, gone ? "link_gone" : null, retryAfter, ok ? null : status ? "HTTP " + status : "the bridge did not answer", 0);
    if (gone) warn("muse.link_gone", "HTTP " + status, { room: h.room });
    else if (status && !ok) warn("muse.deliver", "HTTP " + status, { room: h.room, items: items.length, fails: now.fails + 1 });
  },

  /** One wake for a webhook hook: the items POSTed to its URL, signed. */
  async webhookWake(h: MhRow, items: MqRow[], gen: number) {
    const cursor = items[items.length - 1]!.n;
    const payload: Record<string, unknown> = {
      type: "wake",
      room: h.room,
      member: h.name,
      cursor: cursor,
      items: items.map((i) => ({ seq: i.n, kind: i.kind, at: i.at, data: JSON.parse(i.data) as unknown })),
    };
    if (h.skipped) payload.skipped = h.skipped;
    const a = await webhookCall(h.url || "", h.secret || "", "wake", payload);
    // as for a Muse wake: an answer for a hook that has changed since is not that hook's
    if (!this.alive(gen)) return;
    const now = this.museRow(h.member);
    if (!now || now.kind !== "webhook" || now.url !== h.url) return;
    const retryAfter = Math.min(MUSE_RETRY_AFTER_MAX_MS, a.retryAfter * 1000);
    this.museSettle(h, now, cursor, a.status, a.status === 410 ? "gone" : null, retryAfter, a.error, WEBHOOK_MIN_GAP_MS);
    if (a.error) warn("webhook.deliver", a.status ? "HTTP " + a.status : "no answer", { room: h.room, items: items.length });
  },

  /**
   * Records how a wake went. 2xx: the items up to cursor are delivered and
   * the next wake, if more wait, is due after gap ms. offReason: the target
   * is gone, so the hook goes off and its queue with it. Otherwise the wake
   * is tried again after retryAfter ms (when the answer asked) or the backoff.
   * @param h the hook as the wake read it; now, as it stands
   */
  museSettle(h: MhRow, now: MhRow, cursor: number, status: number, offReason: string | null, retryAfter: number, error: string | null, gap: number) {
    const t = Date.now();
    const err = error ? error.slice(0, WEBHOOK_ERROR_MAX) : null;
    if (status >= 200 && status < 300) {
      this.sql.exec("DELETE FROM mq WHERE member = ? AND n <= ?", h.member, cursor);
      const more = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM mq WHERE member = ?", h.member).one().n > 0;
      this.sql.exec("UPDATE mh SET cursor = ?, last_at = ?, fails = 0, skipped = MAX(0, skipped - ?), due_at = ?, last_status = ?, last_error = NULL WHERE member = ?", cursor, t, h.skipped, more ? t + gap : null, status, h.member);
      return;
    }
    if (offReason) {
      this.sql.exec("UPDATE mh SET enabled = 0, off_reason = ?, due_at = NULL, fails = 0, updated = ?, last_status = ?, last_error = ? WHERE member = ?", offReason, t, status, err, h.member);
      this.sql.exec("DELETE FROM mq WHERE member = ?", h.member);
      this.notifyMembers(h.name);
      return;
    }
    const fails = now.fails + 1;
    const wait = retryAfter > 0 ? retryAfter : backoff(fails);
    this.sql.exec("UPDATE mh SET fails = ?, due_at = ?, last_status = ?, last_error = ? WHERE member = ?", fails, t + wait, status, err, h.member);
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

