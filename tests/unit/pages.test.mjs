// The site's pages (worker/routes/pages.ts): the app shell read through the
// ASSETS binding, and the headers it is served with.
import test from "node:test";
import assert from "node:assert/strict";
import { appShell, page } from "../../worker/routes/pages.ts";

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
