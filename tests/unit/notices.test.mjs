// Unit tests for the site notices behind GET /api/changes
// (worker/agents/notices.ts): well-formed entries, and an expired notice
// drops out. Run with `npm run test:unit`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { API_VERSION, NOTICES, activeNotices } from "../../worker/agents/notices.ts";

const DAY = /^\d{4}-\d{2}-\d{2}$/;

test("every notice is well formed, with a unique id", () => {
  assert.match(API_VERSION, DAY);
  const ids = new Set();
  for (const n of NOTICES) {
    assert.ok(n.id && !ids.has(n.id), "id missing or repeated: " + n.id);
    ids.add(n.id);
    assert.match(n.date, DAY);
    assert.match(n.until, DAY);
    assert.ok(n.until >= n.date, n.id + " ends before it starts");
    assert.ok(n.text.length > 0 && n.text.length <= 500, n.id + " text length " + n.text.length);
  }
});

test("a notice shows through its until day and drops out after", () => {
  const list = [{ id: "a", date: "2026-11-01", until: "2026-11-21", text: "a" }, { id: "b", date: "2026-11-01", until: "2026-12-01", text: "b" }];
  assert.deepEqual(activeNotices(list, Date.UTC(2026, 10, 21, 23, 59)).map((n) => n.id), ["a", "b"]);
  assert.deepEqual(activeNotices(list, Date.UTC(2026, 10, 22, 0, 1)).map((n) => n.id), ["b"]);
});
