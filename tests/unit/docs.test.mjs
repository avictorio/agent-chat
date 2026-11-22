// Unit tests for the agent-readable texts (worker/agents/docs.ts): /api
// lives in docs.txt with {{name}} placeholders filled from docsValues (the
// primer and the recipe likewise).
// A placeholder without a value would throw on every /api request, and a
// value nothing uses is a limit the docs stopped quoting - catch both here.
// Run with `npm run test:unit`.
import { test } from "node:test";
import assert from "node:assert/strict";
import TEXT from "../../worker/agents/docs.txt";
import RECIPE from "../../worker/agents/agent-recipe.md";
import { docs, docsValues, recipe, recipeValues } from "../../worker/agents/docs.ts";
import { GAME_ENGINES } from "../../worker/games/engine.ts";

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

test("the full reference's first example posts with the header, and no request example sends from", () => {
  const out = docs("https://example.test");
  const send = out.slice(out.indexOf("SEND A MESSAGE"), out.indexOf("REACTIONS"));
  assert.ok(send.includes("-H 'X-Invite-Token: TOKEN'"), "the curl example sends the header");
  // the invite names the poster; only the server's own output (frames,
  // awaiting_you calls) shows a from
  const requests = out.split("\n").filter((l) => /^\s*(POST|PUT|DELETE)\s/.test(l) || l.includes("-d '"));
  assert.ok(requests.length > 20, "found the request examples");
  for (const l of requests) assert.ok(!/"from"\s*:/.test(l), "a request example sends from: " + l.trim());
  assert.ok(!out.includes("CLAUDE (RETIRED)"));
  assert.ok(out.includes("https://example.test/llms.txt"), "the reference points newcomers at the primer");
});

test("every game is in GAMES - CHOOSING, and its section follows in that order", () => {
  const out = docs("https://example.test");
  const choosing = out.slice(out.indexOf("\nGAMES - CHOOSING\n"), out.indexOf("\nGAMES - EVERY MATCH\n"));
  const listed = [...choosing.matchAll(/^ {4}(\S.*?) \((\w+)\):/gm)];
  assert.deepEqual(listed.map((m) => m[2]).sort(), Object.keys(GAME_ENGINES).sort(), "CHOOSING lists every game once");
  let at = out.indexOf("\nGAMES - EVERY MATCH\n");
  for (const [, name] of listed) {
    const head = out.indexOf("\nGAMES - " + name.toUpperCase() + "\n");
    assert.ok(head > at, "GAMES - " + name.toUpperCase() + " is missing or out of order");
    at = head;
  }
});

test("every placeholder in agent-recipe.md has a value, and every value is used", () => {
  const usedR = new Set([...RECIPE.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]));
  const have = Object.keys(recipeValues());
  assert.deepEqual([...usedR].filter((k) => !have.includes(k)), [], "placeholders without a value");
  assert.deepEqual(have.filter((k) => !usedR.has(k)), [], "values the recipe never uses");
  assert.ok(!/\{\{\w+\}\}|undefined|NaN/.test(recipe()), "the filled recipe is whole");
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

// No served text asks an agent for a browser User-Agent (or any particular
// one): the edge rule in AGENTS.md section 7 turns Browser Integrity Check
// off on the agent paths, and the token is the only credential.
import WATCHER from "../../worker/agents/agent-watch.sh";
import { mcpInstructions } from "../../worker/agents/onboarding.ts";
import { agentNoteText } from "../../worker/routes/pages.ts";

test("no served text asks for a browser User-Agent", () => {
  const o = "https://example.test";
  const served = {
    "/api (docs.txt)": docs(o),
    "/llms.txt (primer.txt)": primer(o),
    "agent_onboarding": agentOnboarding(o, "lima", "Hank", "tok_123", { invitedBy: "Henry", purpose: "x" }),
    "MCP initialize instructions": mcpInstructions(o),
    "agent recipe": recipe(),
    "agent watcher": WATCHER,
    "room page note": agentNoteText(o, "lima"),
  };
  const asks = [
    /browser[- ]?(like )?user[- ]?agent/i,
    /\b(send|set|use|pass|add)\b[^.\n]{0,40}\buser[- ]?agent\b/i,
    /error 1010|names? cloudflare/i,
  ];
  for (const [name, text] of Object.entries(served)) {
    for (const re of asks) assert.ok(!re.test(text), name + " still asks for a User-Agent: " + (text.match(re) || [""])[0]);
  }
});
