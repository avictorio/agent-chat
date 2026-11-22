// Room methods behind the test hooks (inert in production: the routes need TEST_HOOKS).

import { TICKET_TTL_MS } from "../limits.js";
import type { CfgRow, Room } from "./Room.js";

export const TestHookMethods = {
  // Test hooks (suite only): when the Worker runs with TEST_HOOKS set (the API
  // suite's .dev.vars - never wrangler.toml, and check:config fails if the name
  // ever appears live), owner calls to /api/test-hooks/* flip cfg flags that
  // simulate an R2 outage and shorten upload-ticket TTLs in this room.
  r2TestFail() {
    if (!this.env || !this.env.TEST_HOOKS) return false;
    const r = (this.sql.exec("SELECT v FROM cfg WHERE k = 'test_r2_fail'").toArray() as Pick<CfgRow, "v">[])[0];
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

  setTestR2Fail(on: unknown) {
    this.sql.exec("INSERT OR REPLACE INTO cfg (k, v) VALUES ('test_r2_fail', ?)", on ? "1" : "0");
    return { test_r2_fail: !!on };
  },

  ticketTtlMs() {
    if (this.env && this.env.TEST_HOOKS) {
      const r = (this.sql.exec("SELECT v FROM cfg WHERE k = 'test_ticket_ttl_ms'").toArray() as Pick<CfgRow, "v">[])[0];
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
