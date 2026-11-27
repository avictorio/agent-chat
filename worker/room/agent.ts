// The identity behind an agent key (worker/routes/agent.ts), and the
// creation counters for new keys. Both are objects of the Room class under
// names no room can have (ROOM_RE wants a letter or digit first): an
// identity is "__agent-" + its id, the counters AGENT_QUOTA_ROOM. Reusing
// the class needs no migration tag, so a revert leaves these objects unread,
// as the other quota objects are; the cost is that the two kinds share one
// class's methods, so each is guarded against the other: every method here
// refuses on an object that holds a room (table m), Room.create() and
// Room.createGenesis() refuse on one that holds an identity (table ak), and
// Room.ensureSchema runs only where m exists.
//
// An identity stores what the Worker sealed (lib/agentkey.ts): table ak, one
// row (when it was made, the list's version, the sealed list), and table aks,
// one row, the key's slot (its verifier, and the data key wrapped under it);
// the columns ak.client and aks.expires, used, bind and next are unused
// (NULL): an agent key neither expires nor is used once. The object compares
// verifiers and swaps the list on its version, and never sees a secret, a
// data key or a token. Probing writes nothing: only agentMake creates
// tables, every other method looks in sqlite_master first (as lookupInvite
// does for inv) and refuses without a write where there is no identity, and
// an open only reads. No alarm runs here (Room.alarm returns on an object
// with no room).

import type { AkRow, AksRow, AqRow, Room } from "./Room.js";

/** Whether the object's storage holds that table. */
function hasTable(sql: SqlStorage, name: string): boolean {
  return sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", name).toArray().length > 0;
}

/** Whether the object holds an agent key's identity (Room.create and
 *  Room.createGenesis refuse on one). */
export function isIdentity(sql: SqlStorage): boolean {
  return hasTable(sql, "ak");
}

/** The two verifiers, compared in time that does not depend on where they differ. */
function sameText(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

/** One creation counter of agentReserve: what it counts (a key without its
 *  window), its cap, and how long its window is: seconds, or the UTC day.
 *  The object puts it in its window by its own clock. */
export type AgentCap = { k: string, max: number, per: number | "day" };

/** A counter's window at now, as the object's own clock places it: its
 *  name (a UTC day, or the time its window starts to the minute) and when
 *  it ends (ms). */
function windowOf(per: number | "day", now: number): { w: string, ends: number } {
  if (per === "day") {
    const d = new Date(now);
    return { w: d.toISOString().slice(0, 10), ends: Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) };
  }
  const ms = Math.max(1, Number(per)) * 1000;
  const start = Math.floor(now / ms) * ms;
  return { w: new Date(start).toISOString().slice(0, 16), ends: start + ms };
}

/** Whether a slot's verifier matches, on an object that holds an identity
 *  and no room; nothing is written either way. */
function slotOk(sql: SqlStorage, slot: string, verifier: string): boolean {
  if (hasTable(sql, "m") || !hasTable(sql, "ak")) return false;
  const row = sql.exec<Pick<AksRow, "verifier">>("SELECT verifier FROM aks WHERE slot = ?", String(slot)).toArray()[0];
  return !!row && sameText(row.verifier, String(verifier));
}

/** A counter's cap, lowered by the API suite's test hook where it set one
 *  (TEST_HOOKS only: routes/test-hooks.ts hookAgentLimits). */
function capOf(k: string, max: number, lower: Record<string, number>): number {
  const kind = k.startsWith("net:") ? "per_ip" : k.startsWith("all:") ? "per_day" : k.startsWith("room:") ? "per_room" : "";
  return kind && lower[kind] > 0 ? lower[kind] : max;
}

export const AgentMethods = {
  /** Makes the identity: its two tables, the list's first version and the
   *  key's slot. The only method that creates tables, and only on an object
   *  that holds neither a room nor an identity. */
  agentMake(verifier: string, wrapped: string, ring: string): { ok: true, created: number } | { ok: false, code: "not_identity" | "exists" } {
    if (hasTable(this.sql, "m")) return { ok: false, code: "not_identity" };
    if (hasTable(this.sql, "ak")) return { ok: false, code: "exists" };
    const created = Date.now();
    // ak.client and aks.expires, used, bind and next are left NULL: unused,
    // as an agent key neither expires nor is used once
    this.sql.exec("CREATE TABLE IF NOT EXISTS ak (k INTEGER PRIMARY KEY CHECK (k = 1), created INTEGER NOT NULL, ver INTEGER NOT NULL, client TEXT, ring TEXT NOT NULL)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS aks (slot TEXT PRIMARY KEY, kind TEXT NOT NULL, verifier TEXT NOT NULL, wrapped TEXT, created INTEGER NOT NULL, expires INTEGER, used INTEGER, bind TEXT, next TEXT)");
    this.sql.exec("INSERT INTO ak (k, created, ver, client, ring) VALUES (1, ?, 1, NULL, ?)", created, String(ring));
    this.sql.exec("INSERT INTO aks (slot, kind, verifier, wrapped, created) VALUES ('key', 'key', ?, ?, ?)", String(verifier), String(wrapped), created);
    return { ok: true, created };
  },

  /** Opens the identity for a credential: the slot's verifier compared;
   *  the wrapped data key, the list's version, the sealed list and when the
   *  identity was made. It only reads: a good open, a wrong one and one on
   *  an object that holds no identity all write nothing. Refused where there
   *  is no identity, or the slot or verifier does not match. */
  agentOpen(slot: string, verifier: string): { ok: true, wrapped: string | null, ver: number, ring: string, created: number } | { ok: false } {
    if (hasTable(this.sql, "m") || !hasTable(this.sql, "ak")) return { ok: false };
    const s = this.sql.exec<Pick<AksRow, "verifier" | "wrapped">>("SELECT verifier, wrapped FROM aks WHERE slot = ?", String(slot)).toArray()[0];
    if (!s || !sameText(s.verifier, String(verifier))) return { ok: false };
    const a = this.sql.exec<Pick<AkRow, "created" | "ver" | "ring">>("SELECT created, ver, ring FROM ak WHERE k = 1").toArray()[0];
    if (!a) return { ok: false };
    return { ok: true, wrapped: s.wrapped, ver: a.ver, ring: a.ring, created: a.created };
  },

  /** Puts a new sealed list in place of the version the caller read:
   *  refused (stale) when the list has moved on since, so a caller reads it
   *  again and redoes its change. The verifier is checked again here, so a
   *  disconnect between the caller's open and this swap refuses it. */
  agentSwap(slot: string, verifier: string, ver: number, ring: string): { ok: true } | { ok: false, code?: "stale" } {
    if (!slotOk(this.sql, slot, verifier)) return { ok: false };
    const a = this.sql.exec<Pick<AkRow, "ver">>("SELECT ver FROM ak WHERE k = 1").toArray()[0];
    if (!a || a.ver !== Number(ver)) return { ok: false, code: "stale" };
    this.sql.exec("UPDATE ak SET ver = ver + 1, ring = ? WHERE ver = ?", String(ring), Number(ver));
    return { ok: true };
  },

  /** Disconnects the key everywhere: the whole identity goes. Nothing in
   *  any room changes here. The list's version and sealed list are read and
   *  the slot deleted in one synchronous step, so from that instant every
   *  open and swap of the key is refused, and the list handed back is the
   *  one as it stood when the key was cut (a wake recorded by a call that
   *  raced the disconnect is in it): the Worker turns off the Muse wakes it
   *  names (routes/agent.ts). Then the rest of the storage goes. */
  async agentDrop(slot: string, verifier: string): Promise<{ ok: true, ver: number, ring: string } | { ok: false }> {
    if (!slotOk(this.sql, slot, verifier)) return { ok: false };
    const a = this.sql.exec<Pick<AkRow, "ver" | "ring">>("SELECT ver, ring FROM ak WHERE k = 1").toArray()[0];
    this.sql.exec("DELETE FROM aks");
    await this.ctx.storage.deleteAll();
    // a slot with no list row (rows changed by hand) is cut all the same; its
    // list is answered as one that does not open
    return a ? { ok: true, ver: a.ver, ring: a.ring } : { ok: true, ver: 0, ring: "" };
  },

  /** whats_waiting's gap, in this object's memory only (an evicted object
   *  forgets it): 0 and the time taken, or the seconds left. Called after a
   *  good open; writes nothing. */
  agentGlanceTake(gapMs: number): number {
    const now = Date.now();
    const last = this.agentGlanceAt || 0;
    if (last && now - last < gapMs) return Math.max(1, Math.ceil((gapMs - (now - last)) / 1000));
    this.agentGlanceAt = now;
    return 0;
  },

  // ---- The creation counters, on the AGENT_QUOTA_ROOM object only ----
  // Every cap of one creation is checked and its place taken in this one
  // call, so a burst arriving together cannot all pass, as createReserve
  // does for rooms. A place is taken once every room's token has been
  // looked up and given back (agentRelease) when the creation then makes
  // nothing. Each counter is put in its window here, by this object's own
  // clock, so a request that set out just before an hour or a day turned
  // cannot count in, or clear, a window other than the current one. Rows of
  // past windows go as the next creation comes in: they are counters,
  // nothing else, keyed by hashes.
  /** @returns the keys of the places taken (each with its window), for
   *  agentRelease; else the seconds until the first full counter's window
   *  ends; false on an object that holds a room or an identity */
  agentReserve(caps: AgentCap[]): string[] | number | false {
    if (hasTable(this.sql, "m") || hasTable(this.sql, "ak")) return false;
    this.sql.exec("CREATE TABLE IF NOT EXISTS aq (k TEXT PRIMARY KEY, w TEXT NOT NULL, n INTEGER NOT NULL)");
    const now = Date.now();
    const placed = caps.map((c) => { const win = windowOf(c.per, now); return { k: String(c.k) + ":" + win.w, w: win.w, ends: win.ends, max: Number(c.max) }; });
    // a row of a window that has ended: every window here is the current one of its length
    const current = Array.from(new Set(placed.map((p) => p.w)));
    if (current.length) this.sql.exec("DELETE FROM aq WHERE w NOT IN (" + current.map(() => "?").join(", ") + ")", ...current);
    const lower = this.env && this.env.TEST_HOOKS ? this.agentTestLimits() : {};
    for (const p of placed) {
      const r = this.sql.exec<Pick<AqRow, "n">>("SELECT n FROM aq WHERE k = ?", p.k).toArray()[0];
      if ((r ? r.n : 0) >= capOf(p.k, p.max, lower)) return Math.max(1, Math.ceil((p.ends - now) / 1000));
    }
    for (const p of placed) this.sql.exec("INSERT INTO aq (k, w, n) VALUES (?, ?, 1) ON CONFLICT(k) DO UPDATE SET n = n + 1", p.k, p.w);
    return placed.map((p) => p.k);
  },

  /** agentReserve's check alone, for a call that only asks what a creation
   *  would meet (POST /api/agents/invite with check): no place taken, no row
   *  of a past window deleted, and no table made (a check must leave nothing
   *  behind; with no table nothing is full). Each counter is read in the
   *  window this object's clock puts it in now, as agentReserve reads it.
   *  @returns 0 when every counter has room, else the seconds until the
   *  first full counter's window ends; false on an object that holds a room
   *  or an identity */
  agentPeek(caps: AgentCap[]): number | false {
    if (hasTable(this.sql, "m") || hasTable(this.sql, "ak")) return false;
    if (!hasTable(this.sql, "aq")) return 0;
    const now = Date.now();
    const lower = this.env && this.env.TEST_HOOKS ? this.agentTestLimits() : {};
    for (const c of caps) {
      const win = windowOf(c.per, now);
      const k = String(c.k) + ":" + win.w;
      const r = this.sql.exec<Pick<AqRow, "n">>("SELECT n FROM aq WHERE k = ?", k).toArray()[0];
      if ((r ? r.n : 0) >= capOf(k, Number(c.max), lower)) return Math.max(1, Math.ceil((win.ends - now) / 1000));
    }
    return 0;
  },

  /** Gives back the places agentReserve took (its keys), for a creation that made nothing. */
  agentRelease(keys: string[]): void {
    if (hasTable(this.sql, "m") || hasTable(this.sql, "ak") || !hasTable(this.sql, "aq")) return;
    for (const k of keys) this.sql.exec("UPDATE aq SET n = MAX(0, n - 1) WHERE k = ?", String(k));
  },
} satisfies ThisType<Room>;
