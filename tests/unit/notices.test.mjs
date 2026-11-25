// Unit tests for the site notices behind GET /api/changes
// (worker/agents/notices.ts): well-formed entries, and an expired notice
// drops out. Run with `npm run test:unit`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { API_VERSION, NOTICES, activeNotices } from "../../worker/agents/notices.ts";

const DAY = /^\d{4}-\d{2}-\d{2}$/;

test("every notice is well formed, with a unique id", () => {
  // a date, with .2, .3 for a later change the same day
  assert.match(API_VERSION, /^\d{4}-\d{2}-\d{2}(\.\d+)?$/);
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

// The room page's "What's new" strip (NoticeStrip in the web app) shows the
// newest notice by date, the first listed on a tie (a stable sort). The
// MCP route's URL-token retirement is for MCP clients only, so it is listed
// after the same day's announcements for people and leaves the strip to them.
test("the room page's strip does not show the MCP route's URL-token retirement", () => {
  const strip = NOTICES.slice().sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))[0];
  assert.notEqual(strip.id, "2026-11-25-mcp-query-token-retired");
  assert.ok(NOTICES.some((n) => n.id === "2026-11-25-mcp-query-token-retired"), "the feed still announces it");
});

// A list dir used to be joined with commas and worked by accident in
// Battleship and Frontlines; now it answers 400 there too, and agents that
// sent one must hear which games changed.
test("the dir-type notice names the games where a list used to work", () => {
  const n = NOTICES.find((x) => x.id === "2026-11-23-engine-rules");
  assert.ok(n, "the notice is there");
  assert.match(n.text, /Battleship/);
  assert.match(n.text, /Frontlines/);
  assert.match(n.text, /send one string/);
});
