// The approval page names an app, and words its agreement, from its own
// copy of the Worker's pinned entries and numbers
// (web/app/src/features/signin/apps.ts): the same apps, names, hosts and
// headings as worker/lib/oauth.ts KNOWN_APPS, and the same idle days and
// scope sentence as worker/limits.ts. The record it keeps of a connection is
// found by the id of the disconnect-only code the Worker makes. Run with
// `npm run test:unit`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { OAUTH_IDLE_DAYS, SIGNIN_APPS, SIGNIN_SCOPE_TEXT, appById, appByKey } from "../../web/app/src/features/signin/apps.ts";
import { codeId } from "../../web/app/src/features/signin/records.ts";
import { KNOWN_APPS, newSigninId, newSlotToken } from "../../worker/lib/oauth.ts";
import * as LIMITS from "../../worker/limits.ts";

test("the page's apps are the Worker's pinned ones: key, client_id, name, host and heading; its numbers and scope sentence the Worker's", () => {
  assert.deepEqual(SIGNIN_APPS, KNOWN_APPS.map((a) => ({ key: a.key, client_id: a.client_id, name: a.name, host: a.host, page: a.page })));
  assert.equal(OAUTH_IDLE_DAYS, LIMITS.OAUTH_IDLE_DAYS);
  assert.equal(SIGNIN_SCOPE_TEXT, LIMITS.SIGNIN_SCOPE_TEXT);
  for (const a of KNOWN_APPS) {
    assert.equal(appById(a.client_id).key, a.key);
    assert.equal(appByKey(a.key).client_id, a.client_id);
  }
  assert.equal(appById("https://standin.example/oauth/public.json"), null, "a stand-in is no app of the page's");
  assert.equal(appById(null), null);
});

test("a connection's record is found by its disconnect-only code's id, and by nothing else", () => {
  const id = newSigninId();
  for (const kind of ["disconnect", "code", "access", "refresh"]) {
    const t = newSlotToken(id, kind);
    assert.equal(codeId(t.token), kind === "disconnect" ? id : null, kind);
  }
  assert.equal(codeId(".ac1." + "A".repeat(22) + "." + "B".repeat(43)), null, "an agent key");
  assert.equal(codeId(""), null);
});
