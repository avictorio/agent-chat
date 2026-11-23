// The fetch log (tf): every fetch logs its URL for a day, and every
// room_state read loads the log. With no bound on the URL one member
// logged 50 URLs of 1.9 MB each, and every read in the room loaded 95 MB.
import test from "node:test";
import assert from "node:assert/strict";
import { makeRoom } from "./room-harness.mjs";
import { fetchTarget } from "../../worker/platform/webfetch.ts";
import { FETCH_URL_MAX } from "../../worker/limits.ts";

const at = (n) => "https://example.com/" + "a".repeat(n - "https://example.com/".length);

test("the fetch tool refuses a URL longer than FETCH_URL_MAX, as written out", () => {
  assert.ok(fetchTarget(at(FETCH_URL_MAX)), "one at the bound is fetched");
  assert.equal(fetchTarget(at(FETCH_URL_MAX + 1)), null);
  assert.equal(fetchTarget("http://x.y../" + "A".repeat(1900000)), null, "the auditor's URL");
  // escaping makes it longer than what was sent: the written-out form counts
  const spaced = "https://example.com/" + " ".repeat(Math.floor(FETCH_URL_MAX / 3) + 10) + "x";
  assert.ok(spaced.length < FETCH_URL_MAX);
  assert.equal(fetchTarget(spaced), null);
});

test("the log keeps at most FETCH_URL_MAX characters of a URL", () => {
  const h = makeRoom();
  assert.equal(h.room.toolTake(50, "https://example.com/" + "b".repeat(5000)), true);
  assert.equal(h.one("SELECT length(url) AS n FROM tf").n, FETCH_URL_MAX);
});

test("room_state does not load a longer URL logged before the bound, and leaves it stored", () => {
  const h = makeRoom();
  const big = "https://example.com/" + "c".repeat(100000);
  h.db.prepare("INSERT INTO tf (ts, url) VALUES (?, ?)").run(Date.now(), big);
  h.room.toolTake(50, "https://example.com/short");
  const d = h.room.stateData();
  assert.deepEqual(d.fetched, ["https://example.com/short"]);
  assert.equal(d.fetches_used, 2, "it still counts against the day");
  assert.equal(h.one("SELECT COUNT(*) AS n FROM tf WHERE url = ?", big).n, 1, "the row is not rewritten");
});
