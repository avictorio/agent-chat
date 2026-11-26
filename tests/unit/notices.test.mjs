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
// day's earlier ones (the two newest days are held to it here). The room
// page's "What's new" strip (NoticeStrip in the web app) shows the newest
// notice by date, the first listed on a tie, whoever it is written for.
test("the feed lists the newest day first, and the newest days' later notices above their earlier ones", () => {
  for (let i = 1; i < NOTICES.length; i++) assert.ok(NOTICES[i - 1].date >= NOTICES[i].date, NOTICES[i - 1].id + " is listed above a newer " + NOTICES[i].id);
  const ids = NOTICES.map((n) => n.id);
  // the day of the start page: the preview and the names, MCP's revisions, the invite note's three, then the start page's two, then the cursor's two
  const day = ids.filter((id) => id.startsWith("2026-11-26-"));
  assert.deepEqual(day, ["2026-11-26-preview-and-names", "2026-11-26-mcp-versions", "2026-11-26-invite-note", "2026-11-26-fewer-tokens", "2026-11-26-start-page-names", "2026-11-26-start-page", "2026-11-26-placeholder-id", "2026-11-26-cursor-placeholder", "2026-11-26-mcp-and-url-token"]);
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
test("the preview-and-names notice says what changed and what stays as it was", () => {
  const n = NOTICES.find((x) => x.id === "2026-11-26-preview-and-names");
  assert.ok(n, "the notice is there");
  assert.equal(NOTICES[0].id, n.id, "listed first");
  assert.equal(n.date, "2026-11-26");
  assert.equal(n.until, "2026-12-26");
  assert.ok(n.date <= API_VERSION.slice(0, 10), "dated after the API version");
  assert.ok(n.text.length <= 500, String(n.text.length));
  for (const want of ["GET /invite no longer returns agent_onboarding", "an agent already holds its note", "the web app builds it", "start page", "invite note", "wake recipe", "JSON string", "\\\\ for a backslash", "\\\" for a double quote", "\\uXXXX", "invisible format character", "U+200C, U+200D", "Ordinary names print as before", "@Name", "JSON bodies keep the name as typed"]) assert.ok(n.text.includes(want), "the notice lacks " + want);
  // what it says of a backslash, a double quote and an ordinary name is what quoted() does
  assert.equal(quoted("a\\b"), "\"a\\\\b\"");
  assert.equal(quoted("a\"b"), "\"a\\\"b\"");
  assert.equal(quoted("Scout"), "\"Scout\"");
  // the older notice that said GET /invite still carries the note is made true
  const fewer = NOTICES.find((x) => x.id === "2026-11-26-fewer-tokens").text;
  assert.ok(!/GET \/invite still/.test(fewer), fewer);
  for (const x of NOTICES) assert.ok(!/(GET \/invite|preview)[^.]*(still )?(carries|does)[^.]*agent_onboarding|agent_onboarding[^.]*(GET \/invite|preview) still/.test(x.text), x.id + " says the preview carries the note");
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
