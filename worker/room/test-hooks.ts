// Room methods behind the test hooks (inert in production: the routes need TEST_HOOKS).

import { TICKET_TTL_MS } from "../limits.js";
import type { CfgRow, Room } from "./Room.js";

type AnyFn = (...args: unknown[]) => unknown;
/** Under TEST_HOOKS only: the room's bindings with an R2 bucket whose every
 *  call first waits the room's test delay. A test sets the delay, starts a
 *  call that awaits storage, and sends a second request into that open
 *  window - the interleavings a Durable Object allows at any external await,
 *  made reproducible. The multipart handles (create / resume) wait too.
 *  @param delayMs the room's current delay, read at each call */
export function withR2Delay(env: Env, delayMs: () => number): Env {
  const wait = async () => { const ms = delayMs(); if (ms > 0) await new Promise((r) => setTimeout(r, ms)); };
  const slow = <T extends object>(target: T, wrap?: (key: string | symbol, result: unknown) => unknown): T => new Proxy(target, {
    get(t, k) {
      const v: unknown = Reflect.get(t, k);
      if (typeof v !== "function") return v;
      const fn = v as AnyFn;
      // resumeMultipartUpload answers at once with a handle: slow the handle
      if (k === "resumeMultipartUpload") return (...a: unknown[]) => slow(fn.apply(t, a) as object);
      return async (...a: unknown[]) => { await wait(); const r = await fn.apply(t, a); return wrap ? wrap(k, r) : r; };
    },
  });
  const media = slow(env.MEDIA, (k, r) => (k === "createMultipartUpload" && r ? slow(r as object) : r));
  return new Proxy(env, { get: (t, k) => (k === "MEDIA" ? media : Reflect.get(t, k)) });
}

export const TestHookMethods = {
  // Test hooks (suite only): when the Worker runs with TEST_HOOKS set, owner
  // calls to /api/test-hooks/* flip cfg flags that simulate an R2 outage and
  // shorten upload-ticket TTLs in this room. TEST_HOOKS is set only in the
  // API suite's local server (--var), never in wrangler.toml; check:config fails if the
  // name ever appears live.
  r2TestFail() {
    if (!this.env || !this.env.TEST_HOOKS) return false;
    const r = this.sql.exec<Pick<CfgRow, "v">>("SELECT v FROM cfg WHERE k = 'test_r2_fail'").toArray()[0];
    return !!(r && r.v === "1");
  },

  // Any running match in tests: run its clock out, so the next read
  // advances it as the deadline would.
  setTestGameExpire(id: number) {
    if (!this.env || !this.env.TEST_HOOKS) return { error: "Not found" };
    const g = this.gameRow(id);
    if (!g || !g.st) return { error: "No game with that id" };
    g.st.deadline = Date.now() - 1;
    this.saveGame(g);
    return { ok: true };
  },

  // Run the Room's alarm now, as the platform would at the armed time, and
  // report one match straight from storage (no read, so no read-side
  // catch-up) plus the alarm armed afterwards: the suite checks that the
  // alarm alone advances an expired match, without waiting for a clock.
  async testRunAlarm(id: number) {
    if (!this.env || !this.env.TEST_HOOKS) return { error: "Not found" };
    const before = await this.ctx.storage.getAlarm();
    await this.alarm();
    const g = this.gameRow(id);
    if (!g || !g.st) return { error: "No game with that id" };
    return { ran: true, armed_before: before, armed_after: await this.ctx.storage.getAlarm(), status: g.status, tick: g.st.tick === undefined ? null : g.st.tick, deadline: g.st.deadline || null };
  },

  // Hold every R2 call in this room open for ms (0 turns it off). Memory
  // only: an evicted room forgets it, and production never sets it.
  setTestR2Delay(ms: unknown) {
    if (!this.env || !this.env.TEST_HOOKS) return { error: "Not found" };
    this.testR2DelayMs = Math.max(0, Math.min(10000, Math.floor(Number(ms) || 0)));
    return { test_r2_delay_ms: this.testR2DelayMs };
  },

  // Muse hooks (room/muse.ts): "peek" reports every hook as stored, "run"
  // makes every waiting wake due now and runs the alarm (a retry without
  // waiting out its backoff), "restart" resets the object as an eviction
  // or a deploy would - memory gone, storage kept - so the suite can show
  // a wake is neither lost nor sent twice across one.
  async testMuse(action: unknown) {
    if (!this.env || !this.env.TEST_HOOKS) return { error: "Not found" };
    if (action === "restart") {
      // answered before the reset: the abort ends this instance's calls
      setTimeout(() => this.ctx.abort("test restart"), 50);
      return { restarting: true };
    }
    if (action === "run") {
      this.sql.exec("UPDATE mh SET due_at = ? WHERE due_at IS NOT NULL", Date.now());
      await this.alarm();
    } else if (action !== "peek") return { error: "action must be peek, run or restart" };
    const hooks = this.sql.exec<{ member: string, routing: string, enabled: number, muted: number, cursor: number, fails: number, due_at: number | null, skipped: number, off_reason: string | null }>("SELECT member, routing, enabled, muted, cursor, fails, due_at, skipped, off_reason FROM mh ORDER BY member").toArray();
    return { hooks: hooks.map((h) => Object.assign({}, h, { pending: this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM mq WHERE member = ?", h.member).one().n })), alarm: await this.ctx.storage.getAlarm(), now: Date.now() };
  },

  setTestR2Fail(on: unknown) {
    this.sql.exec("INSERT OR REPLACE INTO cfg (k, v) VALUES ('test_r2_fail', ?)", on ? "1" : "0");
    return { test_r2_fail: !!on };
  },

  ticketTtlMs() {
    if (this.env && this.env.TEST_HOOKS) {
      const r = this.sql.exec<Pick<CfgRow, "v">>("SELECT v FROM cfg WHERE k = 'test_ticket_ttl_ms'").toArray()[0];
      const n = r ? parseInt(r.v, 10) : NaN;
      if (n > 0) return n;
    }
    return TICKET_TTL_MS;
  },

  setTestTicketTtl(ms: unknown) {
    this.sql.exec("INSERT OR REPLACE INTO cfg (k, v) VALUES ('test_ticket_ttl_ms', ?)", String(Math.max(0, Math.floor(Number(ms) || 0))));
    return { test_ticket_ttl_ms: this.ticketTtlMs() };
  },
} satisfies ThisType<Room>;
