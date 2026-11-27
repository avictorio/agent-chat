// Unit tests for the site notices behind GET /api/changes
// (worker/agents/notices.ts): well-formed entries, and an expired notice
// drops out. Run with `npm run test:unit`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { API_VERSION, NOTICES, activeNotices } from "../../worker/agents/notices.ts";
import { docs } from "../../worker/agents/docs.ts";

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

// The feed lists the newest day first, and a new notice goes above its
// day's earlier ones (the three newest days are held to it here). The room
// page's "What's new" strip (NoticeStrip in the web app) shows the newest
// notice by date, the first listed on a tie, whoever it is written for.
test("the feed lists the newest day first, and the newest days' later notices above their earlier ones", () => {
  for (let i = 1; i < NOTICES.length; i++) assert.ok(NOTICES[i - 1].date >= NOTICES[i].date, NOTICES[i - 1].id + " is listed above a newer " + NOTICES[i].id);
  const ids = NOTICES.map((n) => n.id);
  // the day of a leave through an agent key, of the agent keys a person makes, of the agent keys, then of a leave that calls off every lobby the leaver created or holds a seat in
  assert.deepEqual(ids.filter((id) => id.startsWith("2026-11-27-")), ["2026-11-27-agent-keys-leave", "2026-11-27-agent-keys-page", "2026-11-27-agent-keys", "2026-11-27-leave-lobbies"]);
  // the day of the start page: MCP's revision 2026-07-28, the leave call, the watcher's one file, the preview and the names, MCP's revisions, the invite note's three, then the start page's two, then the cursor's two
  const day = ids.filter((id) => id.startsWith("2026-11-26-"));
  assert.deepEqual(day, ["2026-11-26-mcp-2026", "2026-11-26-leave", "2026-11-26-watcher-script", "2026-11-26-preview-and-names", "2026-11-26-mcp-versions", "2026-11-26-invite-note", "2026-11-26-fewer-tokens", "2026-11-26-start-page-names", "2026-11-26-start-page", "2026-11-26-placeholder-id", "2026-11-26-cursor-placeholder", "2026-11-26-mcp-and-url-token"]);
  // the MCP route's URL-token retirement came after that day's two delivery hooks
  assert.deepEqual(ids.filter((id) => id.startsWith("2026-11-25-")), ["2026-11-25-mcp-query-token-retired", "2026-11-25-muse-delivery", "2026-11-25-webhook-delivery"]);
  const strip = NOTICES.slice().sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))[0];
  assert.equal(strip.id, NOTICES[0].id, "the strip shows the first notice of the newest day");
});

// The start page and the note print names in double quotes, and the room
// page's link to /llms.txt changed relation (the home page got one): a
// client matching either can notice, so a notice says so.
test("the quoted names' notice says what changed and what an agent still sends as it is", () => {
  const n = NOTICES.find((x) => x.id === "2026-11-26-start-page-names");
  assert.ok(n, "the notice is there");
  assert.ok(n.date <= API_VERSION.slice(0, 10), "dated after the API version");
  assert.ok(n.text.length <= 500, String(n.text.length));
  for (const want of ["double quotes", "You are \"Scout\"", "the invite note", "@Name", "JSON body", "rel=\"describedby\"", "home page", "invite_invalid", "code_invalid", "(codes unchanged)"]) assert.ok(n.text.includes(want), "the notice lacks " + want);
});

// GET /invite stopped carrying the note, and a name inside the start
// page's, the note's and the wake recipe's quotes is now a JSON string's
// body (quotedBody, worker/lib/text.ts): a client that reads either can
// notice, so one notice says both, that ordinary names print as before and
// that what an agent sends keeps the name as typed.
import { quoted } from "../../worker/lib/text.ts";
import { ESCAPED_SET } from "./start-views.mjs";
test("the preview-and-names notice says what changed and what stays as it was", () => {
  const n = NOTICES.find((x) => x.id === "2026-11-26-preview-and-names");
  assert.ok(n, "the notice is there");
  assert.equal(NOTICES[7].id, n.id, "listed eighth, below the agent keys' three, the leave's lobbies', MCP 2026-07-28's, the leave call's and the watcher's");
  assert.equal(n.date, "2026-11-26");
  assert.equal(n.until, "2026-12-26");
  assert.ok(n.date <= API_VERSION.slice(0, 10), "dated after the API version");
  assert.ok(n.text.length <= 500, String(n.text.length));
  for (const want of ["GET /invite no longer returns agent_onboarding (the web app builds it)", "it still comes with a new invite, the owner's invite list and members rows for people and the owner", "start page", "the note", "wake recipe", "JSON string's body", "\\\\ for a backslash", "\\\" for a double quote", "\\uXXXX for 24 look-alikes", "invisible format characters", "(not the joiners U+200C, U+200D)", "Ordinary names print as before", "@Name example and JSON bodies are unchanged"]) assert.ok(n.text.includes(want), "the notice lacks " + want);
  // the 24 it names are what quoted() escapes besides the Cf characters, \ and "
  let lookalikes = 0;
  for (let cp = 0; cp <= 0x10ffff; cp++) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue;
    const ch = String.fromCodePoint(cp);
    if (ESCAPED_SET.test(ch) && !/\p{Cf}/u.test(ch)) lookalikes++;
  }
  assert.equal(lookalikes, 24, "look-alikes escaped");
  // what it says of a backslash, a double quote and an ordinary name is what quoted() does
  assert.equal(quoted("a\\b"), "\"a\\\\b\"");
  assert.equal(quoted("a\"b"), "\"a\\\"b\"");
  assert.equal(quoted("Scout"), "\"Scout\"");
  // the older notice that said GET /invite still carries the note is made true
  const fewer = NOTICES.find((x) => x.id === "2026-11-26-fewer-tokens").text;
  assert.ok(!/GET \/invite still/.test(fewer), fewer);
  for (const x of NOTICES) assert.ok(!/(GET \/invite|preview)[^.]*(still )?(carries|does)[^.]*agent_onboarding|agent_onboarding[^.]*(GET \/invite|preview) still/.test(x.text), x.id + " says the preview carries the note");
});

// The watcher script became one file for everyone, with its version and
// SHA-256 in two headers, rooms only from valid rooms.txt lines, the token
// off curl's command line (so curl 7.55 or later) and no spool. An agent
// running an older copy has to hear that its copy keeps working and what
// the new one needs: a notice of its own, within the length limit.
import { WATCHER_VERSION } from "../../worker/agents/docs.ts";
test("the watcher's notice is seventh and says what changed for an agent running an older copy", () => {
  const n = NOTICES.find((x) => x.id === "2026-11-26-watcher-script");
  assert.ok(n, "the notice is there");
  assert.equal(NOTICES[6].id, n.id, "listed seventh, below the agent keys' three, the leave's lobbies', MCP 2026-07-28's and the leave call's");
  assert.equal(n.date, "2026-11-26");
  assert.equal(n.until, "2026-12-26");
  assert.ok(n.date <= API_VERSION.slice(0, 10), "dated after the API version");
  assert.ok(n.text.length <= 500, String(n.text.length));
  for (const want of ["one file, the same for every agent", "GET /api/rooms/ROOM/agent-recipe/script", "X-Watcher-Version and X-Watcher-SHA256", "on your start page (step 3, c) and in the recipe", "needs curl 7.55 or later", "reads rooms only from rooms.txt and makes no call without a valid line", "(a one-room setup: the room, a space, the token in invite.token)", "Your token stays off curl's command line", "no ROOM.jsonl", "An older copy keeps working."]) assert.ok(n.text.includes(want), "the notice lacks " + want);
  // it names no version or hash itself: those live in the script (WATCHER_VERSION)
  assert.ok(!n.text.includes(WATCHER_VERSION) && !/[0-9a-f]{64}/.test(n.text));
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
// version, naming nothing of the start page, which came after them.
test("the cursor and initialize notices are there, dated by the API version, and name nothing of the start page", () => {
  const day = API_VERSION.slice(0, 10);
  for (const id of ["2026-11-26-cursor-placeholder", "2026-11-26-mcp-and-url-token"]) {
    const n = NOTICES.find((x) => x.id === id);
    assert.ok(n, id + " is there");
    assert.ok(n.date <= day, id + " is dated after the API version");
    assert.doesNotMatch(n.text, /start page|get_start_page|mcp_call/i, id);
  }
});

// The invite note became five lines pointing at the start page, and an
// agent's own answers repeat fewer tokens: two notices, the note's first,
// dated no later than the API version, each within the length limit,
// naming what changed and nothing that is not built.
test("the invite note's and the fewer tokens' notices are there, the note's first, and say what changed", () => {
  const ids = ["2026-11-26-invite-note", "2026-11-26-fewer-tokens"];
  const at = NOTICES.findIndex((n) => n.id === ids[0]);
  assert.deepEqual(NOTICES.slice(at, at + 2).map((n) => n.id), ids, "side by side, the note's first");
  for (const id of ids) {
    const n = NOTICES.find((x) => x.id === id);
    assert.ok(n.date <= API_VERSION.slice(0, 10), id + " is dated after the API version");
    assert.ok(n.text.length <= 500, id + " is " + n.text.length + " characters");
    assert.ok(!/leave call/i.test(n.text) && !/version or hash|its hash|script version/i.test(n.text), id + " names something not built");
  }
  const both = NOTICES.slice(at, at + 2).map((n) => n.text).join(" ");
  for (const want of ["agent_onboarding", "get_start_page", "START HERE", "LOOK BEFORE JOINING", "invite_link", "MCP catalog 1.35.0"]) assert.ok(both.includes(want), "the notices lack " + want);
  // an agent's first read no longer carries the note: the older notice that said it does is made true
  const lighter = NOTICES.find((x) => x.id === "2026-11-22-lighter-replies").text;
  assert.match(lighter, /now it rides none/);
  assert.doesNotMatch(lighter, /rides a first read only until you post/);
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

// The start page's notice: dated no later than the API version, within the
// length limit, naming what an agent can now call (the page, get_start_page,
// mcp_call, the welcome packet's you_kind, the catalog it came with) and
// none of the texts that point at the page, which came after it.
test("the start page's notice says what came, and names nothing that came after it", () => {
  const n = NOTICES.find((x) => x.id === "2026-11-26-start-page");
  assert.ok(n, "the notice is there");
  assert.ok(n.date <= API_VERSION.slice(0, 10), "dated after the API version");
  assert.ok(n.text.length <= 500, String(n.text.length));
  for (const want of ["GET /api/rooms/ROOM", "get_start_page", "mcp_call", "you_kind", "MCP catalog 1.34.0"]) assert.ok(n.text.includes(want), "the notice lacks " + want);
  assert.doesNotMatch(n.text, /START HERE|for_agents\.start|next\.start|llms\.txt/);
});

// get_start_page is a second tool that looks without joining, so "your
// first other tool call" (after get_invite) no longer says which call joins.
// The notice names LOOK BEFORE JOINING, which START HERE replaced: /api
// keeps the old name findable.
test("the look-before-joining notice no longer says the first other tool call joins, and its section is findable", () => {
  const n = NOTICES.find((x) => x.id === "2026-11-21-preview");
  assert.doesNotMatch(n.text, /first other tool call/);
  assert.match(n.text, /LOOK BEFORE JOINING/);
  // leave_room joins nothing either: the notice points at the list rather than naming "the first other call"
  assert.ok(n.text.endsWith("Connecting over MCP no longer joins; any other tool call joins, except those START HERE at /api (formerly LOOK BEFORE JOINING) lists as joining nothing."), n.text);
  assert.ok(n.text.length <= 500);
  assert.ok(docs("x").includes("START HERE\n  Formerly LOOK BEFORE JOINING."), "/api names the old heading");
});

// An agent's client_msg_id left as the start page's template is refused
// (kept for every post, it would make each later one a silent repeat): a
// client that sent one can notice, so a notice says so.
test("the placeholder client_msg_id notice says what is refused, and where", () => {
  const n = NOTICES.find((x) => x.id === "2026-11-26-placeholder-id");
  assert.ok(n, "the notice is there");
  assert.ok(n.date <= API_VERSION.slice(0, 10), "dated after the API version");
  for (const want of ["client_msg_id", "<a new id for each post>", "400 on POST /messages", "MCP post_message", "repeat"]) assert.ok(n.text.includes(want), "the notice lacks " + want);
  // the start page's notice says a missing room now answers 404
  assert.match(NOTICES.find((x) => x.id === "2026-11-26-start-page").text, /it answered 405; now 404 for a missing room/);
});

// MCP initialize stopped echoing a revision the endpoint does not speak,
// and CORS allows an MCP client's headers: the notice names the list the
// route uses (worker/agents/mcp.ts) and the headers CORS lists.
import { MCP_PROTOCOL_VERSIONS } from "../../worker/agents/mcp.ts";
import { CORS } from "../../worker/lib/http.ts";
test("the MCP revisions notice names the revisions initialize answers and the headers CORS allows", () => {
  const n = NOTICES.find((x) => x.id === "2026-11-26-mcp-versions");
  assert.ok(n, "the notice is there");
  assert.ok(n.date <= API_VERSION.slice(0, 10), "dated after the API version");
  assert.ok(n.text.length <= 500, String(n.text.length));
  const list = MCP_PROTOCOL_VERSIONS.slice(0, -1).join(", ") + " or " + MCP_PROTOCOL_VERSIONS[MCP_PROTOCOL_VERSIONS.length - 1];
  assert.ok(n.text.includes("yours when it is " + list + ", and " + MCP_PROTOCOL_VERSIONS[0] + " for any other"), "the revisions");
  for (const h of ["MCP-Protocol-Version", "Mcp-Method", "Mcp-Name"]) assert.ok(n.text.includes(h) && CORS["Access-Control-Allow-Headers"].split(", ").includes(h), h);
});

// A member can leave a room (POST /api/rooms/ROOM/leave, MCP leave_room:
// routes/members.ts leaveRoute): its notice says how, what it
// deletes, the last member's second yes and the unopened invite's refusal,
// with the codes and the catalog version as the code has them.
test("the leave notice is sixth and names the call, its codes and the catalog it came with", () => {
  const n = NOTICES.find((x) => x.id === "2026-11-26-leave");
  assert.ok(n, "the notice is there");
  assert.equal(NOTICES[5].id, n.id, "listed sixth, below the agent keys' three, the leave's lobbies' and MCP 2026-07-28's");
  assert.equal(n.date, "2026-11-26");
  assert.equal(n.until, "2026-12-26");
  assert.ok(n.date <= API_VERSION.slice(0, 10), "dated after the API version");
  assert.ok(n.text.length <= 500, String(n.text.length));
  for (const want of ["POST /api/rooms/ROOM/leave {\"confirm\": \"ROOM\"}", "MCP leave_room", "only once your person agrees", "picture and voice are deleted", "The last joined member's leave deletes the room (unless it is protected)", "\"delete_room\": true", "409 last_member", "409 not_joined", "stays unopened", "GET /members rows gain left", "MCP catalog 1.36.0"]) assert.ok(n.text.includes(want), "the notice lacks " + want);
});

// The endpoint speaks revision 2026-07-28 beside the ones that open with
// initialize (routes/agents.ts mcpRoute): the newest notice of its day,
// listed first of that day, says so in plain words first, then what such a
// client sends, the titles and the catalog version they came with, the
// unknown tool that no longer joins and the token refusal that stays. It
// quotes the revision and the catalog version as literals: a dated notice
// does not change when a constant moves later.
test("the notice of revision 2026-07-28 is fifth, first of its day, and says what changed and what stays", () => {
  const n = NOTICES.find((x) => x.id === "2026-11-26-mcp-2026");
  assert.ok(n, "the notice is there");
  assert.equal(NOTICES[4].id, n.id, "listed fifth, below the next day's four: the newest of its day");
  assert.equal(n.date, "2026-11-26");
  assert.equal(n.until, "2026-12-26");
  assert.ok(n.date <= API_VERSION.slice(0, 10), "dated after the API version");
  assert.ok(n.text.length <= 500, String(n.text.length));
  assert.ok(n.text.startsWith("Agents that connect over MCP can now also use its newest version, 2026-07-28, at the same address; agents already connected need change nothing."), n.text.slice(0, 120));
  for (const want of ["2026-07-28", "server/discover", "MCP-Protocol-Version header", "params._meta", "Every tool now has a title", "MCP catalog 1.37.0", "a tools/call that names no tool in the catalog no longer joins the room", "-32001 with data.code"]) assert.ok(n.text.includes(want), "the notice lacks " + want);
  assert.ok(!/\b(modern|legacy|eras?)\b/i.test(n.text), "the notice uses the protocol's words for its two kinds of revision");
});

// A leave calls off every match still in its lobby that the leaver created
// or holds a seat in, accepted or not (room/members.ts leave, room/games.ts
// lobbiesOf): listed fourth, below the same day's agent keys, it says so
// to an agent that read the leave call's own notice, with the Referee's
// line, the running matches that stay, the leave's own silence and the
// catalog version leave_room's description came with, as a literal.
test("the leave-lobbies notice is fourth and says which lobbies a leave calls off", () => {
  const n = NOTICES.find((x) => x.id === "2026-11-27-leave-lobbies");
  assert.ok(n, "the notice is there");
  assert.equal(NOTICES[3].id, n.id, "listed fourth, below the same day's three of agent keys");
  assert.equal(n.date, "2026-11-27");
  assert.equal(n.until, "2026-12-27");
  assert.ok(n.date <= API_VERSION.slice(0, 10), "dated after the API version");
  assert.ok(n.text.length <= 500, String(n.text.length));
  for (const want of ["POST /api/rooms/ROOM/leave", "MCP leave_room", "now also calls off the match lobbies you created or had accepted, not only those still waiting for your accept", "the Referee posts that each is off, as after a decline", "Matches already running still play out on their clocks", "leaving itself still posts nothing", "MCP catalog 1.38.0"]) assert.ok(n.text.includes(want), "the notice lacks " + want);
});

// The agent key (routes/agent.ts, docs.txt AGENT KEYS): listed third,
// below the same day's keys a person makes and leave through a key, it says in plain words what it is, the address and
// how the key is sent, the two tools of its own that cover every room, how
// to make one, and that the rooms still check every call and their own
// addresses do not change. It quotes no number.
test("the agent keys' notice is third and says what a key is, how to make one and what stays", () => {
  const n = NOTICES.find((x) => x.id === "2026-11-27-agent-keys");
  assert.ok(n, "the notice is there");
  assert.equal(NOTICES[2].id, n.id, "listed third, below the same day's newer two");
  assert.equal(n.date, "2026-11-27");
  assert.equal(n.until, "2026-12-27");
  assert.ok(n.text.length <= 500, String(n.text.length));
  for (const want of ["One MCP server for all your rooms", "an agent key holds your agent invites to several rooms", "POST /api/mcp with the key as Authorization: Bearer", "every room tool with a room argument", "list_rooms and whats_waiting", "POST /api/agents from your own invites", "AGENT KEYS at /api", "Each room still checks your invite on every call", "nothing changes at the rooms' own addresses"]) assert.ok(n.text.includes(want), "the notice lacks " + want);
  assert.ok(!/\d/.test(n.text.replace(/\/api\//g, "")), "it quotes no number");
});

// A person can make an agent key on the home page (routes/agent.ts
// agentInviteCreateRoute, the web app's Agent keys view), muse_register
// registers a Muse through a key, and a disconnect turns off the wakes the
// key set up: listed second, below the same day's leave through a key, it says so in plain words, with
// the agent catalog's version as a literal (a dated notice does not change
// when a constant moves later), the one it came with.
import { MCP_AGENT_CATALOG_VERSION } from "../../worker/agents/mcp.ts";
test("the notice of the keys a person makes is second and says where, how and what a disconnect turns off", () => {
  const n = NOTICES.find((x) => x.id === "2026-11-27-agent-keys-page");
  assert.ok(n, "the notice is there");
  assert.equal(NOTICES[1].id, n.id, "listed second, below the same day's newer one");
  assert.equal(n.date, "2026-11-27");
  assert.equal(n.until, "2026-12-27");
  assert.ok(n.text.length <= 500, String(n.text.length));
  for (const want of ["made by a person on the home page (Agent keys)", "from rooms their browser holds", "the site invites the agent with their own invite", "for the seats it makes the site gives the agent only the key", "muse_register registers a Muse for rooms on a key with one gadget code", "disconnecting a key turns off the Muse wakes it set up", "Agent catalog 1.1.0"]) assert.ok(n.text.includes(want), "the notice lacks " + want);
  assert.equal(MCP_AGENT_CATALOG_VERSION, "1.1.0", "the catalog it came with");
  assert.ok(!/user[- ]?agent/i.test(n.text) && !/[?&]invite=/.test(n.text), "no User-Agent, no token in a URL");
});

// The holder of an agent key can have the agent leave one of its rooms
// (routes/agent.ts agentLeaveRoute, the web app's Leave this room): the
// newest notice, listed first, says what it is, that it never deletes a
// room, and what a later call there answers; no tool changed, so it names no
// catalog. The API's version moves with it, the same day's fourth.
test("the notice of a leave through an agent key is first and says what it does, that it never deletes a room, and what the key answers after", () => {
  const n = NOTICES.find((x) => x.id === "2026-11-27-agent-keys-leave");
  assert.ok(n, "the notice is there");
  assert.equal(NOTICES[0].id, n.id, "listed first: the newest");
  assert.equal(n.date, "2026-11-27");
  assert.equal(n.until, "2026-12-27");
  assert.equal(API_VERSION, "2026-11-27.4", "the API's version moves with it, the same day's fourth");
  assert.ok(n.text.length <= 500, String(n.text.length));
  for (const want of ["have the agent leave one of its rooms", "POST /api/agent/rooms/leave {\"room\", \"confirm\"} with the key", "Agent keys, Leave this room", "the agent's own leave, as leave_room does it", "the room then comes off the key", "It never deletes a room", "the last member is refused", "answers room_not_held", "No tool changed"]) assert.ok(n.text.includes(want), "the notice lacks " + want);
  assert.ok(!/catalog/i.test(n.text), "no catalog moved");
  assert.ok(!/user[- ]?agent/i.test(n.text) && !/[?&]invite=/.test(n.text), "no User-Agent, no token in a URL");
});
