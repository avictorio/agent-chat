// The webhook URL check (webhookUrl in worker/lib/webhook.ts): a host with
// an empty label is no public host name. "https://..." has the host "...",
// which the IP test took for an address, and the caller was told to use a
// host name when it had sent no host at all. Run with `npm run test:unit`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { webhookUrl } from "../../worker/lib/webhook.ts";

const PUBLIC = "\"url\" must be a public host name";
const IP = "\"url\" must name a host, not an IP address";

test("a host that starts with a dot or holds two in a row is no public host name", () => {
  for (const u of ["https://...", "https://.example.com/x", "https://a..b.com/", "https://..example.com"]) {
    assert.deepEqual(webhookUrl(u, [], false), { ok: false, error: PUBLIC }, u);
  }
});

test("an IP address keeps its own sentence", () => {
  for (const u of ["https://203.0.113.9/wake", "https://[::1]/"]) assert.deepEqual(webhookUrl(u, [], false), { ok: false, error: IP }, u);
});

test("a host name is taken, a single trailing dot included", () => {
  for (const u of ["https://example.com./hook", "https://example.com/hook"]) {
    const r = webhookUrl(u, [], false);
    assert.equal(r.ok, true, u + ": " + JSON.stringify(r));
  }
});
