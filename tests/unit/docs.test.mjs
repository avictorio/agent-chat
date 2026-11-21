// Unit tests for the agent-readable /api docs (worker/agents/docs.ts): the
// text lives in docs.txt with {{name}} placeholders filled from docsValues.
// A placeholder without a value would throw on every /api request, and a
// value nothing uses is a limit the docs stopped quoting - catch both here.
// Run with `npm run test:unit`.
import { test } from "node:test";
import assert from "node:assert/strict";
import TEXT from "../../worker/agents/docs.txt";
import { docs, docsValues } from "../../worker/agents/docs.ts";

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

// The /llms.txt primer (primer.txt, filled by primerValues) and the shared
// etiquette (etiquette.txt).
import PRIMER from "../../worker/agents/primer.txt";
import { ETIQUETTE_LINES, primer, primerValues } from "../../worker/agents/docs.ts";
import { agentOnboarding } from "../../worker/agents/onboarding.ts";

test("every placeholder in primer.txt has a value, and every value is used", () => {
  const usedP = new Set([...PRIMER.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]));
  const have = Object.keys(primerValues("https://example.test"));
  assert.deepEqual([...usedP].filter((k) => !have.includes(k)), [], "placeholders without a value");
  assert.deepEqual(have.filter((k) => !usedP.has(k)), [], "values primer.txt never uses");
});

test("the primer is short, starts by linking the full reference, and teaches the join", () => {
  const out = primer("https://example.test");
  assert.ok(!/\{\{\w+\}\}/.test(out), "an unfilled placeholder is left");
  assert.ok(out.length < 6500, "the primer is " + out.length + " characters; keep it a primer");
  assert.match(out.split("\n")[0], /https:\/\/example\.test\/api\.txt/);
  for (const want of ["#invite=", "X-Invite-Token", "Authorization: Bearer", "/api/rooms/ROOM/invite", "/api/rooms/ROOM/me", "/api/changes", "invite_missing", "rate_limited"]) assert.ok(out.includes(want), "the primer should mention " + want);
  for (const l of ETIQUETTE_LINES) assert.ok(out.includes(l), "the primer carries the etiquette line: " + l);
});

test("the full reference's first example posts with the header and no from", () => {
  const out = docs("https://example.test");
  const send = out.slice(out.indexOf("SEND A MESSAGE"), out.indexOf("REACTIONS"));
  assert.ok(send.includes("-H 'X-Invite-Token: TOKEN'"), "the curl example sends the header");
  assert.ok(!/"from"\s*:/.test(send), "no from in the member examples");
  assert.ok(!out.includes("CLAUDE (RETIRED)"));
  assert.ok(out.includes("https://example.test/llms.txt"), "the reference points newcomers at the primer");
});

test("the onboarding block: who invited you, the header, a look first, the etiquette", () => {
  const withBy = agentOnboarding("https://example.test", "lima", "Hank", "tok_123", { invitedBy: "Henry", purpose: "Plan the Lima trip." });
  assert.match(withBy, /^Henry invited you to the Agent Chat room "lima" as the agent "Hank"\./);
  assert.ok(withBy.includes("Plan the Lima trip."));
  const bare = agentOnboarding("https://example.test", "lima", "Hank", "tok_123");
  assert.match(bare, /^You are invited to the Agent Chat room "lima" as the agent "Hank"\./, "falls back when nobody is named");
  for (const want of ["X-Invite-Token: tok_123", "Authorization: Bearer tok_123", "/api/rooms/lima/invite", "/api/rooms/lima/mcp", "/agent-recipe", "rooms.txt", "lima tok_123 Hank", "post a short hello", "Keep this token private"]) assert.ok(bare.includes(want), "the block should carry " + want);
  for (const l of ETIQUETTE_LINES) assert.ok(bare.includes(l), "the block carries the etiquette line: " + l);
  assert.ok(!/\*\*|^#/m.test(bare), "plain text, no Markdown");
});
