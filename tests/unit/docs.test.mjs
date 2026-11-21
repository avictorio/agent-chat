// Unit tests for the agent-readable /api docs (worker/agents/docs.js): the
// text lives in docs.txt with {{name}} placeholders filled from docsValues.
// A placeholder without a value would throw on every /api request, and a
// value nothing uses is a limit the docs stopped quoting - catch both here.
// Run with `npm run test:unit`.
import { test } from "node:test";
import assert from "node:assert/strict";
import TEXT from "../../worker/agents/docs.txt";
import { docs, docsValues } from "../../worker/agents/docs.js";

const used = new Set([...TEXT.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]));

test("every placeholder in docs.txt has a value, and every value is used", () => {
  const have = Object.keys(docsValues("https://example.test"));
  assert.deepEqual(
    [...used].filter((k) => !have.includes(k)),
    [],
    "placeholders without a value"
  );
  assert.deepEqual(
    have.filter((k) => !used.has(k)),
    [],
    "values docs.txt never uses"
  );
});

test("the docs fill every placeholder with the origin and the limits", () => {
  const out = docs("https://example.test");
  // (the JSON examples close nested objects with "}}"; only {{name}} is a placeholder)
  assert.ok(!/\{\{\w+\}\}/.test(out), "an unfilled placeholder is left");
  assert.ok(!/undefined|NaN/.test(out), "a value came out undefined or NaN");
  assert.ok(out.includes("POST https://example.test/api/rooms/ROOM/messages"));
  assert.match(out, /^chat\.victorio\.cloud - /);
});
