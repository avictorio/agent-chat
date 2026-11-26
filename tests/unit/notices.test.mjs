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

// The day the read cursors, the placeholder rule and MCP initialize changed:
// two notices (each within the length limit), dated no later than the API
// version, naming nothing that is not built.
test("the cursor and initialize notices are there, dated by the API version, and name nothing unbuilt", () => {
  const day = API_VERSION.slice(0, 10);
  for (const id of ["2026-11-26-cursor-placeholder", "2026-11-26-mcp-and-url-token"]) {
    const n = NOTICES.find((x) => x.id === id);
    assert.ok(n, id + " is there");
    assert.ok(n.date <= day, id + " is dated after the API version");
    assert.doesNotMatch(n.text, /start page|get_start_page|mcp_call/i, id);
  }
  // the room page's strip shows the first listed of a day: the cursor one
  assert.equal(NOTICES.filter((x) => x.date === "2026-11-26")[0].id, "2026-11-26-cursor-placeholder");
});

// What an agent can notice that day, each said: an empty after is no cursor
// (MCP list_messages read "" as 0 and now reads the latest page, so the
// cursor notice may not call every non-number refused), MCP's tokenless
// refusal has a new sentence beside the revoked one, and a URL token beside
// a header token no longer adds a notice field.
test("the day's notices say what changed for an empty after, the tokenless MCP refusal and a header token", () => {
  const cursor = NOTICES.find((x) => x.id === "2026-11-26-cursor-placeholder").text;
  assert.match(cursor, /not empty or a whole number/);
  assert.match(cursor, /empty after is no cursor: list_messages now reads the latest page/);
  const mcp = NOTICES.find((x) => x.id === "2026-11-26-mcp-and-url-token").text;
  assert.match(mcp, /revoked refusal and MCP's tokenless one have new sentences \(codes unchanged\)/);
  assert.match(mcp, /beside a header token it adds nothing either/);
});

// Most 400s carry no code (ERRORS AND THEIR CODES in /api), the cursor and
// placeholder refusals among them: no notice may say every refusal has one.
test("no notice says every refusal carries a code", () => {
  for (const n of NOTICES) assert.doesNotMatch(n.text, /(^|[.:] )Refusals (now )?carry a (machine-readable )?code/, n.id);
  assert.match(NOTICES.find((x) => x.id === "2026-11-21-codes").text, /branch on code where there is one/);
});

// The URL token's retirement stays announced until its notices' day, after
// the special answers to it are gone.
test("both URL-token notices stay until 2027-01-31", () => {
  for (const id of ["2026-11-22-query-token-retired", "2026-11-25-mcp-query-token-retired"]) {
    const n = NOTICES.find((x) => x.id === id);
    assert.ok(n, id + " is there");
    assert.equal(n.until, "2027-01-31", id);
  }
});
