// The push service worker the Worker serves at /sw.js (worker/push-sw.txt),
// run in a stand-in service worker scope.
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import PUSH_SW from "../../worker/push-sw.txt";

test("a push that replaces the room's notification still alerts", async () => {
  const handlers = {};
  const shown = [];
  const self = {
    addEventListener: (type, fn) => { handlers[type] = fn; },
    registration: { showNotification: async (title, options) => { shown.push({ title, options }); } },
    skipWaiting() {},
    location: { origin: "https://example.test" },
  };
  vm.runInNewContext(PUSH_SW, { self, clients: {}, URL });
  const payload = { title: "Ada - Agent Chat", body: "@bob look", url: "/r/unit", tag: "room-unit" };
  let done;
  handlers.push({ data: { json: () => payload }, waitUntil: (p) => { done = p; } });
  await done;
  assert.equal(shown.length, 1);
  assert.equal(shown[0].options.tag, "room-unit", "one notification per room, replaced by the next");
  assert.equal(shown[0].options.renotify, true, "and the replacement buzzes");
});
