// Unit tests for the Worker's failure log (worker/lib/log.ts) and its JSON
// body reader (worker/lib/http.ts readBody): one structured line per
// failure, ids only, no flood; a broken body is a 400, an empty one is no
// body. Run with `npm run test:unit`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { resetWarnings, warn } from "../../worker/lib/log.ts";
import { BadRequest, readBody } from "../../worker/lib/http.ts";

function capture(fn) {
  const lines = [];
  const orig = console.warn;
  console.warn = (s) => lines.push(JSON.parse(s));
  try { fn(); } finally { console.warn = orig; }
  return lines;
}

test("warn writes one JSON line with the label, the error and the ids", () => {
  resetWarnings();
  const lines = capture(() => warn("media.read", new TypeError("bucket unavailable"), { room: "r1", id: 7 }));
  assert.deepEqual(lines, [{ warn: "media.read", error: "TypeError: bucket unavailable", room: "r1", id: 7 }]);
});

test("warn takes null (a JSON.parse failure) or a string of its own", () => {
  resetWarnings();
  const lines = capture(() => {
    warn("game.state.parse", null, { id: 3 });
    warn("push.send", "HTTP 403", { room: "r1" });
  });
  assert.deepEqual(lines, [
    { warn: "game.state.parse", error: null, id: 3 },
    { warn: "push.send", error: "HTTP 403", room: "r1" },
  ]);
});

test("warn cuts a long message and logs the same failure once per window", () => {
  resetWarnings();
  const lines = capture(() => {
    for (let i = 0; i < 5; i++) warn("alarm.arm", new Error("x".repeat(500)), { room: "r1" });
    warn("alarm.arm", new Error("again"), { room: "r2" });
  });
  assert.equal(lines.length, 2, "the same label and ids log once; another room logs too");
  assert.equal(lines[0].error.length, 200);
  assert.equal(lines[1].room, "r2");
});

const post = (body) => new Request("https://example.test/api", { method: "POST", headers: { "Content-Type": "application/json" }, body });

test("readBody: JSON reads, an empty or blank body is null, anything else is a 400", async () => {
  assert.deepEqual(await readBody(post('{"name": "Ada"}')), { name: "Ada" });
  assert.equal(await readBody(post("")), null);
  assert.equal(await readBody(post(" \n\t")), null);
  assert.equal(await readBody(new Request("https://example.test/api", { method: "POST" })), null);
  await assert.rejects(readBody(post('{"name": "Ha')), (e) => e instanceof BadRequest && /not valid JSON/.test(e.message));
  await assert.rejects(readBody(post("text=hello")), BadRequest);
});
