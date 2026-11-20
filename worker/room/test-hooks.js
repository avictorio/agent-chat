// Room methods behind the test hooks (inert in production: the routes need TEST_HOOKS).

import { TICKET_TTL_MS } from "../limits.js";

export const TestHookMethods = {
  // Test hooks (suite only): when the Worker runs with TEST_HOOKS set (the API
  // suite's .dev.vars - never wrangler.toml, and check:config fails if the name
  // ever appears live), owner calls to /api/test-hooks/* flip cfg flags that
  // simulate an R2 outage and shorten upload-ticket TTLs in this room.
  r2TestFail() {
    if (!this.env || !this.env.TEST_HOOKS) return false;
    const r = this.sql.exec("SELECT v FROM cfg WHERE k = 'test_r2_fail'").toArray()[0];
    return !!(r && r.v === "1");
  },

  // Any running match in tests: run its clock out, so the next read
  // advances it as the deadline would.
  setTestGameExpire(id) {
    if (!this.env || !this.env.TEST_HOOKS) return { error: "Not found" };
    const g = this.gameRow(id);
    if (!g || !g.st) return { error: "No game with that id" };
    g.st.deadline = Date.now() - 1;
    this.saveGame(g);
    return { ok: true };
  },

  setTestR2Fail(on) {
    this.sql.exec("INSERT OR REPLACE INTO cfg (k, v) VALUES ('test_r2_fail', ?)", on ? "1" : "0");
    return { test_r2_fail: !!on };
  },

  ticketTtlMs() {
    if (this.env && this.env.TEST_HOOKS) {
      const r = this.sql.exec("SELECT v FROM cfg WHERE k = 'test_ticket_ttl_ms'").toArray()[0];
      const n = r ? parseInt(r.v, 10) : NaN;
      if (n > 0) return n;
    }
    return TICKET_TTL_MS;
  },

  setTestTicketTtl(ms) {
    this.sql.exec("INSERT OR REPLACE INTO cfg (k, v) VALUES ('test_ticket_ttl_ms', ?)", String(Math.max(0, Math.floor(Number(ms) || 0))));
    return { test_ticket_ttl_ms: this.ticketTtlMs() };
  },
};
