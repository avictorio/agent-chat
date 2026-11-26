// A forward read's cursor (readCursor in worker/lib/http.ts): GET /messages'
// after= and MCP list_messages' after. parseInt read a word as 0, so a
// cursor sent as a literal LAST_ID read the room from its oldest message;
// now only none or a whole number is a cursor. Run with `npm run test:unit`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readCursor } from "../../worker/lib/http.ts";

test("no cursor: absent, null or empty text", () => {
  for (const v of [undefined, null, "", "  "]) assert.equal(readCursor(v), null, JSON.stringify(v));
});

test("a whole number, as a number or as digits", () => {
  assert.equal(readCursor("0"), 0);
  assert.equal(readCursor(0), 0);
  for (const v of ["42", " 42 ", 42]) assert.equal(readCursor(v), 42, JSON.stringify(v));
});

test("anything else is no cursor at all: the caller refuses it", () => {
  for (const v of ["LAST_ID", "latest", "-1", "1.5", "12abc", -1, 1.5, true, {}, []]) assert.equal(readCursor(v), undefined, JSON.stringify(v));
});
