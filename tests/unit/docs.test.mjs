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
  for (const want of ["#invite=", "X-Invite-Token", "Authorization: Bearer", "/api/rooms/ROOM/invite", "/api/rooms/ROOM/me", "/api/changes", "invite_missing", "rate_limited", "LOOK BEFORE JOINING"]) assert.ok(out.includes(want), "the primer should mention " + want);
  for (const l of ETIQUETTE_LINES) assert.ok(out.includes(l), "the primer carries the etiquette line: " + l);
  // "any other call joins" was false both ways (an invite or an avatar
  // call does not join; a refused read does): the primer points at the rule
  assert.ok(!out.includes("Any other call"), "the primer still says any other call joins");
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
  // the join rule is LOOK BEFORE JOINING's, and only a refused token is a
  // JSON-RPC error (a cap or a bad argument is a tool error)
  assert.ok(!bare.includes("Any other call joins"), "the block still says any other call joins");
  assert.ok(bare.includes("LOOK BEFORE JOINING"), "the block points at the join rule");
  assert.ok(bare.includes("A refused token is a JSON-RPC error"), "the block says which refusals are JSON-RPC errors");
});

// No served text asks an agent for a browser User-Agent (or any particular
// one): the edge rule in AGENTS.md section 7 turns Browser Integrity Check
// off on the agent paths, and the token is the only credential.
import WATCHER from "../../worker/agents/agent-watch.sh";
import { MCP_NO_TOKEN, mcpInstructions } from "../../worker/agents/onboarding.ts";
import { mcpCatalog } from "../../worker/agents/mcp.ts";
import { agentNoteText } from "../../worker/routes/pages.ts";
import { CURSOR_REFUSAL, STREAM_CURSOR_REFUSAL } from "../../worker/lib/http.ts";
import { PLACEHOLDER_CID, PLACEHOLDER_TEXT } from "../../worker/lib/text.ts";
import { OWNER_NO_START_PAGE, START_NO_TOKEN, startPage } from "../../worker/agents/start.ts";
import { makeRoom } from "./room-harness.mjs";
import { ROOM as START_ROOM, base as startBase, joined as startJoined } from "./start-views.mjs";

const VARIANTS = ["ok", "owner", "none", "invalid", "revoked"];

/** the sentence a revoked token is refused with, as the room gives it */
function revokedSentence() {
  const h = makeRoom();
  h.db.prepare("INSERT INTO inv (token, name, created, revoked) VALUES (?, ?, ?, ?)").run("tok-gone", "Gone", Date.now(), Date.now());
  return h.room.lookupInvite("tok-gone").error;
}

/** every text an agent reads as documentation, by where it is served */
function servedTexts(o) {
  return {
    "/api (docs.txt)": docs(o),
    "/api/games (games.txt)": gamesDocs(o),
    "/llms.txt (primer.txt)": primer(o),
    "agent_onboarding": agentOnboarding(o, "lima", "Hank", "tok_123", { invitedBy: "Henry", purpose: "x" }),
    ...Object.fromEntries(VARIANTS.map((v) => ["MCP instructions, " + v, mcpInstructions(o, v)])),
    "MCP tokenless refusal": MCP_NO_TOKEN,
    "MCP tool catalog": JSON.stringify(mcpCatalog()),
    "cursor refusals": CURSOR_REFUSAL + " " + STREAM_CURSOR_REFUSAL,
    "placeholder refusals": PLACEHOLDER_TEXT + " " + PLACEHOLDER_CID,
    "revoked refusal": revokedSentence(),
    "agent recipe": recipe(),
    "agent watcher": WATCHER,
    "room page note": agentNoteText(o, "lima"),
    "start page": startPage(startBase, o, START_ROOM),
    "start page, joined": startPage(startJoined, o, START_ROOM),
    "start page, with the owner key": startPage(startJoined, o, START_ROOM, undefined, true),
    "start page refusals": START_NO_TOKEN + " " + OWNER_NO_START_PAGE,
  };
}

test("the served texts are all there", () => {
  for (const [name, text] of Object.entries(servedTexts("https://example.test"))) assert.ok(typeof text === "string" && text.length > 20, name + " is missing");
  assert.match(revokedSentence(), /revoked/);
});

// Every text is true of the code as it is: none names what is not built
// (a START HERE section in /api, a start link in for_agents or in the
// preview's next), and none repeats a statement that was false: stopping
// reads stops no hook or webhook, whoami joins, no room owner revokes,
// "any other call joins" was wrong both ways, and get_invite is not the
// only tool that looks without joining.
test("no served text names what is not built, or a false rule", () => {
  for (const [name, text] of Object.entries(servedTexts("https://example.test"))) {
    assert.ok(!/START HERE|for_agents\.start|next\.start/.test(text), name + " names something not built: " + (text.match(/.{0,40}(START HERE|for_agents\.start|next\.start).{0,20}/) || [""])[0]);
    for (const bad of ["stop polling", "call whoami", "room owner", "Any other call", "every tool but get_invite)", "The only tool that does not"]) assert.ok(!text.toLowerCase().includes(bad.toLowerCase()), name + " still says " + bad);
  }
});

test("the etiquette's fourth line says to remove a wake when leaving", () => {
  assert.equal(ETIQUETTE_LINES[3], "- Leaving a room: remove any wake you set up and stop reading.");
  const turns = docs("https://example.test");
  assert.ok(turns.includes("\n     Leaving a room: remove any wake you set up and stop reading.\n"), "TAKING TURNS step 4 carries it");
});

test("MCP initialize's instructions, by token: short, and the ok one carries the etiquette and the guide", () => {
  const o = "https://chat.victorio.cloud";
  for (const v of VARIANTS) {
    const t = mcpInstructions(o, v);
    assert.ok(t.length <= (v === "ok" ? 1100 : 800), v + " is " + t.length + " characters");
    for (const re of [/call whoami/i, /follow it/, /agent-recipe/, /for now/, /changes block/]) assert.ok(!re.test(t), v + " matches " + re);
    assert.match(t, /^One Agent Chat room as tools/);
  }
  const ok = mcpInstructions(o, "ok");
  for (const l of ETIQUETTE_LINES) assert.ok(ok.includes(l.replace(/^- /, "")), "the ok instructions carry the etiquette line: " + l);
  assert.ok(ok.includes(o + "/llms.txt"));
  assert.ok(ok.includes(o + "/api/changes"), "site changes are a link");
  assert.match(mcpInstructions(o, "none"), /no invite token/);
  assert.match(mcpInstructions(o, "invalid"), /invite_invalid/);
  assert.match(mcpInstructions(o, "revoked"), /invite_revoked/);
  assert.match(mcpInstructions(o, "owner"), /"as"/);
  assert.ok(ok.includes("get_invite and get_start_page never join"), "the ok instructions name both looks");
});

test("three tool descriptions say what joins and what the invite links are", () => {
  const by = Object.fromEntries(mcpCatalog().map((t) => [t.name, t.description]));
  assert.ok(by.whoami.includes("joins the room: it opens your invite"), by.whoami);
  assert.ok(by.get_invite.includes("(unused until you join)"), by.get_invite);
  assert.ok(by.get_members.includes("never use or post them"), by.get_members);
  assert.ok(by.whoami.includes("every tool but get_invite and get_start_page"), by.whoami);
  assert.ok(by.get_invite.includes("call get_start_page"), by.get_invite);
  assert.ok(by.get_start_page.includes("It changes nothing in the room"), by.get_start_page);
  // the start page names get_invite as a look, so agents call it: its
  // description says the answer holds the token, as the page does
  assert.ok(by.get_invite.includes("agent_onboarding, its hand-off note with your token in it: keep that field out of anything you save or share"), by.get_invite);
});

// get_start_page reads the token's invite only: the owner key's "as" would
// be ignored there, so its schema does not offer it; every other tool does.
test("every tool offers the owner key's as, except get_start_page", () => {
  for (const t of mcpCatalog()) assert.equal("as" in t.inputSchema.properties, t.name !== "get_start_page", t.name);
});

test("the poll numbers come from limits.ts", async () => {
  const { POLL_GAP_S, WAIT_MAX_S, span } = await import("../../worker/limits.ts");
  for (const [file, raw] of [["docs.txt", TEXT], ["primer.txt", PRIMER]]) {
    for (const lit of ["wait=25", "max 25", "once a minute"]) assert.ok(!raw.includes(lit), file + " quotes " + lit + " as a literal");
  }
  const o = "https://example.test";
  assert.equal(docsValues(o).WAIT_MAX_S, WAIT_MAX_S);
  assert.equal(docsValues(o).POLL_GAP, span(POLL_GAP_S));
  assert.equal(primerValues(o).WAIT_MAX_S, WAIT_MAX_S);
  assert.equal(primerValues(o).POLL_GAP, span(POLL_GAP_S));
  assert.ok(docs(o).includes("wait=" + WAIT_MAX_S), "/api quotes the long poll's cap");
  assert.ok(primer(o).includes("once " + span(POLL_GAP_S)), "/llms.txt quotes the poll gap");
});

/** a section of /api: from its heading to the next one */
function sectionOf(text, head) {
  const at = text.indexOf("\n" + head + "\n");
  assert.ok(at >= 0, "no section " + head);
  const next = text.slice(at + head.length + 2).search(/\n[A-Z][A-Z ,&()-]+\n/);
  return text.slice(at, next < 0 ? undefined : at + head.length + 2 + next);
}

test("/api says exactly which calls join", () => {
  const api = docs("https://example.test");
  for (const gone of ["Any other call", "first other call", "Joining a room is"]) assert.ok(!api.includes(gone), "/api still says " + gone);
  const look = sectionOf(api, "LOOK BEFORE JOINING");
  for (const want of ["Only look, never join:", "Act without joining:", "Join only when they succeed:", "Join: every other room call"]) assert.ok(look.includes(want), "LOOK BEFORE JOINING lacks " + want);
  const folded = look.replace(/\s+/g, " ");
  for (const want of ["GET or HEAD /api/rooms/ROOM (the start page)", "get_start_page", "the owner key alone has no start page (400)"]) assert.ok(folded.includes(want), "LOOK BEFORE JOINING lacks " + want);
});

test("/api documents mcp_call in ROOM STATE and the caller's fields in WELCOME PACKET", () => {
  const api = docs("https://example.test");
  const state = sectionOf(api, "ROOM STATE").replace(/\s+/g, " ");
  for (const want of ["mcp_call", "as for the owner key", "over MCP, mcp_call is added after the cut"]) assert.ok(state.includes(want), "ROOM STATE lacks " + want);
  const welcome = sectionOf(api, "WELCOME PACKET").replace(/\s+/g, " ");
  for (const want of ["you_kind", "get_board", "the owner key gets none of the three"]) assert.ok(welcome.includes(want), "WELCOME PACKET lacks " + want);
  assert.ok(sectionOf(api, "ROOMS").replace(/\s+/g, " ").includes("GET or HEAD /api/rooms/ROOM is your start page"), "ROOMS names the start page");
});

test("/llms.txt names get_start_page beside get_invite as a look", () => {
  const out = primer("https://example.test").replace(/\s+/g, " ");
  assert.ok(out.includes("get_invite and get_start_page look without joining"));
  assert.ok(!out.includes("get_invite looks without"));
});

test("/api's statements about Muse wakes, muting and the webhook challenge are true", () => {
  const api = docs("https://example.test").replace(/\s+/g, " ");
  assert.ok(!api.includes("the same items as the wake recipe's watcher"));
  assert.ok(!api.includes("(muted keeps what was waiting;"));
  assert.ok(api.includes("nothing new is queued while muted"));
  assert.ok(api.includes("Answer the challenge without checking its signature"));
});

test("/api states the cursor refusals, the placeholder refusal and initialize's link", () => {
  const raw = docs("https://example.test");
  const api = raw.replace(/\s+/g, " ");
  assert.ok(!api.includes("the same feed as changes"));
  assert.ok(api.includes("a link to this feed"));
  assert.ok(api.includes("after must be a whole number: anything else answers 400 (an empty after= is the same as none)"));
  assert.ok(api.includes("anything else answers 400 (a literal placeholder too)"));
  assert.ok(sectionOf(raw, "SEND A MESSAGE").includes("<...> placeholder"));
  assert.ok(sectionOf(raw, "SEND A MESSAGE").replace(/\s+/g, " ").includes("An agent's client_msg_id (below) that is one such placeholder, such as <a new id for each post>, is refused the same way"), "/api states the client_msg_id refusal");
  // the message test leaves out autolinks (isPlaceholderMessage), and says so
  assert.ok(sectionOf(raw, "SEND A MESSAGE").replace(/\s+/g, " ").includes("a link or an address in angle brackets (<https://...>, <mailto:...>, <name@example.com>) is no placeholder"));
});

test("the room page's note and the web app's texts drop the false sentences", async () => {
  const { readFileSync } = await import("node:fs");
  const root = new URL("../../", import.meta.url);
  assert.ok(!agentNoteText("https://example.test", "lima").includes("Any other call"));
  // the web app's fallback note and home page are not importable in Node: read as text
  const stream = readFileSync(new URL("web/app/src/features/room/useRoomStream.ts", root), "utf8");
  assert.ok(!stream.includes("Call whoami"), "the fallback note still says to call whoami (it joins)");
  const home = readFileSync(new URL("web/app/src/features/home/StaticViews.tsx", root), "utf8");
  assert.ok(!home.includes("room owner"), "the home page says a room owner revokes");
  assert.ok(!home.includes("gets a 401"), "the home page says a wrong token gets a 401");
});

test("no served text asks for a browser User-Agent", () => {
  const o = "https://example.test";
  const served = servedTexts(o);
  const asks = [
    /browser[- ]?(like )?user[- ]?agent/i,
    /\b(send|set|use|pass|add)\b[^.\n]{0,40}\buser[- ]?agent\b/i,
    /error 1010|names? cloudflare/i,
  ];
  for (const [name, text] of Object.entries(served)) {
    for (const re of asks) assert.ok(!re.test(text), name + " still asks for a User-Agent: " + (text.match(re) || [""])[0]);
  }
});

// The token in a request's URL (?invite=) is retired and no route reads
// it: the texts say only how to send the header, and a refusal answers it
// as no token. Only the changes feed announces the retirement, and it is
// not here. An invite link's #invite= fragment is how every link works.
test("no served text tells an agent about a token in the URL", () => {
  for (const [name, text] of Object.entries(servedTexts("https://example.test"))) {
    assert.ok(!/[?&]invite=/.test(text), name + " mentions a token in the URL: " + (text.match(/.{0,60}[?&]invite=.{0,20}/) || [""])[0]);
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

// A stream from after=0 gets a gap frame first once the room has dropped
// anything (a room deleted and created again starts msg_forgot at its old
// msg_hwm, so even an empty one sends it: stream-frames.test.mjs), and
// none in a young room that has dropped nothing (replay sends one only
// when forgotten() > after). The text once said a reader from 0 always
// got one, and an agent waiting for it as a "replay begins" marker would
// wait forever. A reader told only "treat what you held as out of date"
// could take the gap for missing history, so the text says a reader with
// nothing held can ignore it.
test("STREAM MESSAGES says a reader from 0 gets a gap once the room has dropped anything, and one holding nothing can ignore it", () => {
  const text = docs("https://example.test");
  const stream = text.slice(text.indexOf("STREAM MESSAGES"), text.indexOf("\n\n", text.indexOf("event: gap")));
  assert.match(stream, /after=0 gets one too once the room has\s+dropped anything/);
  assert.match(stream, /deleted and\s+created again, even when the new room is empty/);
  assert.match(stream, /a young room that has dropped nothing\s+sends none/);
  assert.doesNotMatch(stream, /the gap\s+comes first/);
  assert.match(stream, /holds no\s+messages yet[^.]*can ignore it/);
});
