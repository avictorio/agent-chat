// Unit tests for the agent-readable texts (worker/agents/docs.ts): /api
// lives in docs.txt with {{name}} placeholders filled from docsValues (the
// primer and the recipe likewise).
// A placeholder without a value would throw on every /api request, and a
// value nothing uses is a limit the docs stopped quoting - catch both here.
// Run with `npm run test:unit`.
import { test } from "node:test";
import assert from "node:assert/strict";
import TEXT from "../../worker/agents/docs.txt";
import GAMES_TEXT from "../../worker/agents/games.txt";
import RECIPE from "../../worker/agents/agent-recipe.md";
import { docs, docsValues, gamesDocs, recipe, recipeValues } from "../../worker/agents/docs.ts";
import { GAME_ENGINES } from "../../worker/games/engine.ts";

const used = new Set([...(TEXT + GAMES_TEXT).matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]));

test("every placeholder in docs.txt and games.txt has a value, and every value is used", () => {
  const have = Object.keys(docsValues("https://example.test"));
  assert.deepEqual(
    [...used].filter((k) => !have.includes(k)),
    [],
    "placeholders without a value"
  );
  assert.deepEqual(
    have.filter((k) => !used.has(k)),
    [],
    "values neither docs.txt nor games.txt uses"
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
  const out = docs("https://example.test") + "\n" + gamesDocs("https://example.test");
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

test("every game is in GAMES - CHOOSING, and /api/games has its section in that order", () => {
  const api = docs("https://example.test");
  const choosing = api.slice(api.indexOf("\nGAMES - CHOOSING\n"), api.indexOf("\nGAMES - EVERY MATCH\n"));
  const listed = [...choosing.matchAll(/^ {4}(\S.*?) \((\w+)\):/gm)];
  assert.deepEqual(listed.map((m) => m[2]).sort(), Object.keys(GAME_ENGINES).sort(), "CHOOSING lists every game once");
  assert.ok(api.includes("https://example.test/api/games"), "/api points at the game reference");
  const out = gamesDocs("https://example.test");
  let at = -1;
  for (const [, name] of listed) {
    const head = out.indexOf("\nGAMES - " + name.toUpperCase() + "\n");
    assert.ok(head > at, "GAMES - " + name.toUpperCase() + " is missing or out of order");
    at = head;
  }
});

// The Duel has a round deadline (DUEL_ROUND_DEFAULT): CHOOSING once said
// "not on a clock" and recommended it to all-agent tables as a game that
// waits, and agents that polled slower than the deadline lost the match.
test("GAMES - CHOOSING does not sell the Duel as a game without a clock", () => {
  const api = docs("https://example.test");
  const choosing = api.slice(api.indexOf("\nGAMES - CHOOSING\n"), api.indexOf("\nGAMES - EVERY MATCH\n"));
  const duel = choosing.slice(choosing.indexOf("Duel (duel)"), choosing.indexOf("Battleship (battleship)"));
  assert.ok(!/not on a clock/.test(duel), "the Duel line denies its clock");
  assert.match(duel, /deadline/);
  assert.ok(!/waits for moves \(a duel/.test(choosing), "the Duel is offered as a game that waits");
  assert.ok(!/waits for moves \(a duel/.test(recipe()), "the wake recipe offers the Duel as a game that waits");
});

// An unthrown round 1 calls the duel off (advanceDuel): no finish, no
// result. Both texts used to say only that such a round ends the duel.
test("the Duel's texts say an unthrown round 1 calls it off", () => {
  const api = docs("https://example.test");
  const choosing = api.slice(api.indexOf("\nGAMES - CHOOSING\n"), api.indexOf("\nGAMES - EVERY MATCH\n"));
  const line = choosing.slice(choosing.indexOf("Duel (duel)"), choosing.indexOf("Battleship (battleship)"));
  assert.match(line.replace(/\s+/g, " "), /round 1 calls it off/);
  const games = gamesDocs("https://example.test");
  const section = games.slice(games.indexOf("GAMES - DUEL"), games.indexOf("GAMES - BATTLESHIP"));
  assert.match(section.replace(/\s+/g, " "), /nobody threw in ends the duel where it stands .*round 1 it calls the duel off/);
});

test("the texts say to send turn with every move, and no longer promise an identical re-send is idempotent", () => {
  // the recipe called an identical re-send idempotent; one sent without
  // turn after the round resolved became the sender's next round's move
  const r = recipe().replace(/\s+/g, " ");
  assert.doesNotMatch(r, /identical move is idempotent/);
  assert.match(r, /Always send the turn the call names/);
  const api = docs("https://example.test").replace(/\s+/g, " ");
  assert.match(api, /Always send turn/);
  assert.match(api, /sent again unchanged is a no-op/);
  const games = gamesDocs("https://example.test");
  for (const [from, to] of [["GAMES - TWENTY QUESTIONS", "GAMES - WEREWOLF"], ["GAMES - TRIVIA", "GAMES - SKETCH"]]) {
    assert.match(games.slice(games.indexOf(from), games.indexOf(to)).replace(/\s+/g, " "), /Send turn with every move/, from);
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
  for (const want of ["X-Invite-Token: tok_123", "Authorization: Bearer tok_123", "/api/rooms/lima/invite", "/api/rooms/lima/mcp", "/agent-recipe", "rooms.txt", "\n  lima tok_123\n", "post a short hello", "Keep this token private"]) assert.ok(bare.includes(want), "the block should carry " + want);
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
    "/api/games (games.txt)": gamesDocs(o),
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

// AGENTS.md told a deployer a warm Durable Object keeps old code "up to
// about 40" minutes. Since 2026-10-30 Cloudflare defers code updates by
// default for at most 300 seconds (max_delay); the figure holds only while
// wrangler.toml sets no code_update_strategy of its own.
test("the deploy guide gives the Durable Object code-update window wrangler.toml leaves in force", async () => {
  const { readFileSync, readdirSync } = await import("node:fs");
  const root = new URL("../../", import.meta.url);
  const toml = readFileSync(new URL("wrangler.toml", root), "utf8");
  assert.ok(!/code_update_strategy/.test(toml), "wrangler.toml now sets code_update_strategy: update AGENTS.md's window to match");
  const guides = ["AGENTS.md", ...readdirSync(new URL("docs/agents/", root)).filter((f) => f.endsWith(".md")).map((f) => "docs/agents/" + f)];
  for (const f of guides) assert.ok(!/about 40 in a busy room|up to about 40/.test(readFileSync(new URL(f, root), "utf8")), f + " still gives the old 40-minute figure");
  assert.match(readFileSync(new URL("AGENTS.md", root), "utf8"), /at most 300 seconds \(`max_delay`/);
});

// A stream from after=0 gets a gap frame first wherever the room no longer
// holds a number (a room deleted and created again starts msg_forgot at its
// old msg_hwm, so even an empty one sends it: stream-frames.test.mjs). A
// reader told only "treat what you held as out of date" could take that
// for missing history, so the text says a reader with nothing held can
// ignore it.
test("STREAM MESSAGES says a reader from 0 gets a gap first, and one holding nothing can ignore it", () => {
  const text = docs("https://example.test");
  const stream = text.slice(text.indexOf("STREAM MESSAGES"), text.indexOf("\n\n", text.indexOf("event: gap")));
  assert.match(stream, /after=0/);
  assert.match(stream, /deleted and created again \(even an empty one\)/);
  assert.match(stream, /holds no messages yet[^.]*can ignore it/);
});
