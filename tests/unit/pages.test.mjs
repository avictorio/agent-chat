// The site's pages (worker/routes/pages.ts): the app shell read through the
// ASSETS binding, and the headers it is served with.
import test from "node:test";
import assert from "node:assert/strict";
import { appShell, museTermsBody, museTermsRoute, page } from "../../worker/routes/pages.ts";
import { MUSE_TERMS_VERSION } from "../../worker/limits.ts";

const INDEX = '<!doctype html><html><head><meta name="build" content="next-dev"><!--page-head--></head><body><!--page-note--></body></html>';

// This test must run first in the file: the shell is kept per module, so it
// needs a module that has not read one yet.
test("a request that finds the shell being read by another request does its own read", async () => {
  const calls = [];
  const env = {
    ASSETS: {
      fetch(req) {
        calls.push(req.url);
        // The first read belongs to a request that ended before its fetch
        // did: it never settles. A request waiting on it would hang.
        if (calls.length === 1) return new Promise(() => {});
        return Promise.resolve(new Response(INDEX));
      },
    },
  };
  void appShell(env, "http://localhost");
  const second = appShell(env, "http://localhost");
  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error("the second request waited on the first one's read")), 1000));
  const s = await Promise.race([second, timeout]);
  assert.equal(calls.length, 2);
  assert.match(s.id, /^[0-9a-f]{16}$/);
  // once settled, the shell is kept: no third read
  const r = await page(env, "http://localhost");
  assert.equal(calls.length, 2);
  assert.ok((await r.text()).includes('content="' + s.id + '"'));
});

test("the page shell limits its frames to the site and YouTube's embed, and nothing else", async () => {
  const env = { ASSETS: { fetch: async () => new Response(INDEX) } };
  for (const room of [undefined, "unit"]) {
    const r = await page(env, "http://localhost", room);
    // A posted HTML page navigated its frame to any site: the shell's
    // frame-src is what holds the frame.
    assert.equal(r.headers.get("Content-Security-Policy"), "frame-src 'self' https://www.youtube-nocookie.com");
  }
});

// The Muse terms quote the bridge's numbers from worker/limits.ts, not as
// text of their own: written out by hand they stayed behind when a
// constant changed.
test("the Muse terms are built from the bridge's constants, and other numbers change the page", async () => {
  const text = await museTermsRoute({}).text();
  assert.ok(text.includes(museTermsBody()));
  // Today's constants give the words terms v1 was agreed with. A constant
  // changed in limits.ts fails this: the terms then say something else,
  // which may need a new MUSE_TERMS_VERSION and a firmware release
  // (worker/routes/pages.ts).
  assert.equal(MUSE_TERMS_VERSION, "v1");
  for (const s of [
    "The code is good for 30 minutes and works once.",
    "the last item it delivered, for 10 minutes, so that a retry is not sent twice",
    "Wakes are limited to 30 per 10 minutes for each connected Muse.",
    "up to the latest 100 items per room",
    "If Muse keeps refusing your token for 6 hours, the bridge deletes it",
  ]) assert.ok(text.includes(s), s);
  const other = museTermsBody({ codeTtlS: 3600, wakesMax: 12, wakesWindowS: 300, dedupeS: 1200, queueMax: 40, tokenGraceS: 2 * 86400 });
  for (const s of [
    "The code is good for an hour and works once.",
    "the last item it delivered, for 20 minutes, so that",
    "Wakes are limited to 12 per 5 minutes for each connected Muse.",
    "up to the latest 40 items per room",
    "refusing your token for 2 days",
  ]) assert.ok(other.includes(s), s);
  for (const s of ["30 minutes", "30 per", "10 minutes", "100 items", "6 hours"]) assert.ok(!other.includes(s), s);
});
