// A key a person makes for their agent (worker/routes/agent.ts
// agentInviteCreateRoute, agentInviteAddRoute) against a Room namespace of
// real Room objects on node:sqlite, reached through stubs that record each
// method asked (agent-world.mjs). The order of the checks (shapes before
// any object; every inviter looked up before any seat is planned or any
// counter read; a refused inviter's room asked nothing more and its
// counter never read, in a check too); a check that writes nothing; the
// identity made before the first invite, each seat put on it right after
// its invite; a failure that keeps the invites it made, unopened, names
// them and drops the key (a retry with the same name reuses them); the
// room's caps and name rules as invite() applies them, two calls at once
// included; which seats are reused; and no answer carrying a token the
// call made. Keys and tokens are made here. Run with `npm run test:unit`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeWorld, read, agentInvite } from "./agent-world.mjs";
import { agentInviteAddRoute, agentInviteCreateRoute, agentMcpRoute, agentRoute } from "../../worker/routes/agent.ts";
import { personKeyHandoff, personKeyNote, unusedNote } from "../../worker/agents/onboarding.ts";
import { AGENT_KEYS_PER_DAY, AGENT_KEYS_PER_IP, AGENT_KEYS_PER_ROOM_DAY, AGENT_KEYS_WINDOW_S, AGENT_QUOTA_ROOM, AGENT_ROOMS_MAX, MAX_ACTIVE_INVITES, MEMBER_INVITES_PER_DAY } from "../../worker/limits.ts";
import { hashKey, networkKey } from "../../worker/lib/address.ts";
import { newAgentKey } from "../../worker/lib/agentkey.ts";

const IP = "10.7.0.1";
/** a world with these rooms, a person Pat in each: Pat's tokens by room */
function people(names, w = makeWorld()) {
  const pat = {};
  for (const n of names) pat[n] = agentInvite(w.room(n), "Pat", "human");
  return { w, pat };
}
const invite = (w, body, ip = IP) => read(agentInviteCreateRoute(w.rc("POST", "/api/agents/invite", { json: body, headers: { "CF-Connecting-IP": ip } })));
const addInvite = (w, key, body) => read(agentInviteAddRoute(w.rc("POST", "/api/agent/rooms/invite", { json: body, headers: { Authorization: "Bearer " + key } })));
const entries = (pat, rooms, extra = {}) => rooms.map((room) => ({ room, inviter_token: pat[room], ...extra }));
/** a room's invite rows of one name */
const rowsOf = (w, room, name) => w.harness(room).all("SELECT token, name, kind, invited_by, used, seen, revoked, created FROM inv WHERE name = ? ORDER BY created", name);
/** every invite token in the world */
const allTokens = (w) => [...w.objects.values()].flatMap((h) => { try { return h.all("SELECT token FROM inv").map((r) => r.token); } catch { return []; /* no invite table */ } });
/** an answer's text carries no room token, invite link or invite note (the key left out) */
function clean(w, what, r) {
  const t = r.json && r.json.key ? r.text.split(r.json.key).join("<KEY>") : r.text;
  for (const tok of allTokens(w)) assert.ok(!t.includes(tok), what + " carries a room's token");
  assert.ok(!/#invite=[A-Za-z0-9_-]/.test(t), what + " carries an invite link");
  assert.ok(!t.includes("agent_onboarding"), what + " carries an invite note");
}
/** the methods asked since mark, as name.method */
const asked = (w, mark) => w.asked.slice(mark).map((a) => a.name + "." + a.method);
const call = (name, args) => ({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
const mcp = async (w, key, name, args) => (await read(agentMcpRoute(w.rc("POST", "/api/mcp", { json: call(name, args), headers: { Authorization: "Bearer " + key } })))).json.result;

test("a key made with a person's invites: the answer's fields, the key once, two new agent seats invited by the person, unopened, and no token anywhere", async () => {
  const { w, pat } = people(["lima", "oslo"]);
  const r = await invite(w, { name: "Scout", rooms: entries(pat, ["lima", "oslo"]) });
  assert.equal(r.status, 201, r.text);
  assert.equal(r.headers.get("Cache-Control"), "no-store");
  assert.equal(r.headers.get("Access-Control-Allow-Origin"), "*");
  assert.deepEqual(Object.keys(r.json), ["key", "address", "rooms", "max_rooms", "claude_code", "handoff", "note"]);
  assert.match(r.json.key, /^\.ac1\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/);
  assert.equal(r.json.address, "http://localhost/api/mcp");
  assert.deepEqual(r.json.rooms, [{ room: "lima", name: "Scout", opened: false, seat: "new" }, { room: "oslo", name: "Scout", opened: false, seat: "new" }]);
  assert.equal(r.json.max_rooms, AGENT_ROOMS_MAX);
  assert.deepEqual(JSON.parse(r.json.claude_code), { mcpServers: { "agent-chat": { type: "http", url: "http://localhost/api/mcp", headers: { Authorization: "Bearer KEY" } } } });
  assert.equal(r.json.handoff, personKeyHandoff("http://localhost", ["lima", "oslo"]));
  assert.equal(r.json.handoff.split("Bearer KEY").length, 2, "the handoff holds the word KEY once");
  assert.equal(r.json.note, personKeyNote(false));
  assert.equal(r.text.split(r.json.key).length, 2, "the key appears once");
  clean(w, "the creation", r);
  for (const n of ["lima", "oslo"]) {
    const rows = rowsOf(w, n, "Scout");
    assert.equal(rows.length, 1, n);
    assert.deepEqual({ kind: rows[0].kind, invited_by: rows[0].invited_by, used: rows[0].used, seen: rows[0].seen, revoked: rows[0].revoked }, { kind: "agent", invited_by: "Pat", used: null, seen: null, revoked: null }, n + ": an agent seat Pat invited, never opened");
    assert.equal(w.harness(n).one("SELECT used FROM inv WHERE name = 'Pat'").used, null, n + ": the person's own invite stays unopened");
    assert.ok(!w.methods(n).includes("access"), n + ": access() never asked");
  }
  // the key holds the new seats: list_rooms, and a call through it in each room
  const list = await mcp(w, r.json.key, "list_rooms", {});
  assert.deepEqual(list.structuredContent.rooms.map((x) => ({ room: x.room, name: x.name, state: x.state })), r.json.rooms.map((x) => ({ room: x.room, name: x.name, state: "held" })), "list_rooms equals the creation's rooms");
  const who = await mcp(w, r.json.key, "whoami", { room: "oslo" });
  assert.equal(who.structuredContent.name, "Scout");
  assert.equal(w.identities().length, 1);
});

test("the shapes are checked for every entry before any object is asked", async () => {
  const { w, pat } = people(["lima"]);
  const one = (e) => ({ name: "Scout", rooms: [{ room: "lima", inviter_token: pat.lima }, e] });
  const cases = [
    [{}, 400, { error: "\"rooms\" must list 1 to " + AGENT_ROOMS_MAX + " rooms: [{\"room\", \"inviter_token\"}], with your own invites" }],
    [{ name: "Scout", rooms: [] }, 400, null],
    [{ name: "Scout", rooms: Array.from({ length: AGENT_ROOMS_MAX + 1 }, (_, i) => ({ room: "r" + i, inviter_token: "t" })) }, 400, null],
    [one("oslo"), 400, { error: "rooms[1] must be an object: {\"room\", \"inviter_token\"}" }],
    [one({ room: "Bad Name!", inviter_token: "t" }), 400, { error: "rooms[1]: Room names are 1-64 lowercase letters, digits, - or _", room: "bad name!" }],
    [one({ room: "LIMA", inviter_token: pat.lima }), 400, { error: "rooms[1]: lima is listed twice", room: "lima" }],
    [one({ room: "oslo" }), 401, { error: "rooms[1]: \"inviter_token\" is required: your own invite token for oslo", code: "invite_missing", room: "oslo" }],
    [one({ room: "oslo", inviter_token: newAgentKey().key }), 403, { error: "rooms[1]: that is an agent key, not a room invite token", code: "invite_invalid", room: "oslo" }],
    [{ rooms: [{ room: "lima", inviter_token: pat.lima }] }, 400, { error: "rooms[0]: \"name\" is required: the agent's name in lima", room: "lima" }],
    [{ name: "   ", rooms: [{ room: "lima", inviter_token: pat.lima, name: " " }] }, 400, { error: "rooms[0]: \"name\" is required: the agent's name in lima", room: "lima" }],
    [{ name: "Sc<out", rooms: [{ room: "lima", inviter_token: pat.lima }] }, 400, { error: "rooms[0]: Names can't contain < > \" ' & ` or control characters", room: "lima" }],
    [{ name: "Scout", rooms: [{ room: "lima", inviter_token: pat.lima, name: "a:b" }] }, 400, { error: "rooms[0]: Names can't contain a comma or a colon (they separate targets in game moves)", room: "lima" }],
    [{ name: "toString", rooms: [{ room: "lima", inviter_token: pat.lima }] }, 400, { error: "rooms[0]: That name is reserved - pick another", room: "lima" }],
    [{ name: "REFEREE", rooms: [{ room: "lima", inviter_token: pat.lima }] }, 400, { error: "rooms[0]: \"Referee\" is a reserved name - it belongs to the room's game official and cannot be a member.", room: "lima" }],
    [{ name: "Scout", rooms: [{ room: "lima", inviter_token: pat.lima, reuse: "all" }] }, 400, { error: "rooms[0]: \"reuse\" must be \"unused\", \"any\" or \"none\"", room: "lima" }],
  ];
  for (const [body, status, want] of cases) {
    const mark = w.asked.length;
    const r = await invite(w, body);
    assert.equal(r.status, status, JSON.stringify(body).slice(0, 90));
    if (want) assert.deepEqual(r.json, want);
    assert.equal(w.asked.length, mark, "no object asked: " + JSON.stringify(body).slice(0, 90));
  }
  const big = await read(agentInviteCreateRoute(w.rc("POST", "/api/agents/invite", { body: JSON.stringify({ name: "x", rooms: [{ room: "lima", inviter_token: "x".repeat(1100 * 1024) }] }) })));
  assert.equal(big.status, 413);
  assert.deepEqual(big.json, { error: "That request's body is too large: send {\"name\", \"rooms\": [{\"room\", \"inviter_token\"}]}." });
  const get = await read(agentInviteCreateRoute(w.rc("GET", "/api/agents/invite")));
  assert.equal(get.status, 405);
  assert.deepEqual(get.json, { error: "Method not allowed" });
  assert.equal(w.identities().length, 0);
  assert.ok(!w.objects.has(AGENT_QUOTA_ROOM), "nothing counted");
});

test("every inviter is looked up, in order, before any seat is planned or counted; the first refused is the answer and nothing else is asked", async () => {
  const { w, pat } = people(["lima", "oslo"]);
  const hank = agentInvite(w.harness("lima"), "Hank");
  w.harness("oslo").db.prepare("INSERT INTO inv (token, name, created, kind) VALUES ('tok-nokind-000000000000', 'Old', ?, NULL)").run(Date.now());
  const revoked = agentInvite(w.harness("oslo"), "Gone", "human");
  w.harness("oslo").room.revoke(revoked);
  const cases = [
    [{ room: "nowhere", inviter_token: "tok-123456789012345678901" }, 404, { error: "No room with that name yet. Create it from the home page.", room: "nowhere" }],
    [{ room: "lima", inviter_token: "tok-not-one-of-lima-s-xx" }, 403, { error: "Room \"lima\": This invite link isn't valid for this room.", code: "invite_invalid", room: "lima" }],
    [{ room: "oslo", inviter_token: revoked }, 403, { error: "Room \"oslo\": This invite link has been revoked. Ask whoever gave it to you for a new one.", code: "invite_revoked", room: "oslo" }],
    [{ room: "lima", inviter_token: hank }, 403, { error: "Room \"lima\": this is an agent's invite. Only a person's own invite can invite an agent onto a key.", code: "not_person_invite", room: "lima" }],
    [{ room: "oslo", inviter_token: "tok-nokind-000000000000" }, 403, { error: "Room \"oslo\": this is an agent's invite. Only a person's own invite can invite an agent onto a key.", code: "not_person_invite", room: "oslo" }],
  ];
  for (const [bad, status, want] of cases) {
    const first = bad.room === "lima" ? { room: "oslo", inviter_token: pat.oslo } : { room: "lima", inviter_token: pat.lima };
    const mark = w.asked.length;
    const r = await invite(w, { name: "Scout", rooms: [first, bad] });
    assert.equal(r.status, status, bad.room);
    assert.deepEqual(r.json, want);
    assert.deepEqual(asked(w, mark), [first.room + ".lookupInvite", bad.room + ".lookupInvite"], "the looks, in order, and nothing more: " + asked(w, mark));
  }
  // a room with no storage was asked its look and nothing else (no inviter(), no table made)
  assert.deepEqual(w.methods("nowhere"), ["lookupInvite"]);
  assert.equal(w.harness("nowhere").db.prepare("SELECT COUNT(*) AS n FROM sqlite_master").get().n, 0);
  assert.equal(w.identities().length, 0);
  assert.ok(!w.objects.has(AGENT_QUOTA_ROOM), "no counter asked");
  // every look before any planning: two good rooms
  const mark = w.asked.length;
  const ok = await invite(w, { name: "Scout", rooms: entries(pat, ["lima", "oslo"]) });
  assert.equal(ok.status, 201, ok.text);
  const order = asked(w, mark);
  assert.deepEqual(order.slice(0, 2), ["lima.lookupInvite", "oslo.lookupInvite"], order.join(" "));
  assert.ok(order.indexOf("lima.nameHeld") > 1 && order.indexOf(AGENT_QUOTA_ROOM + ".agentReserve") > order.lastIndexOf("oslo.inviteLoad"), "planning after every look, the counters after every plan: " + order.join(" "));
});

test("check answers what the call would do and writes nothing: no invite, no counter, no identity, no table", async () => {
  const { w, pat } = people(["lima", "oslo"]);
  const before = { lima: w.harness("lima").all("SELECT * FROM inv"), oslo: w.harness("oslo").all("SELECT * FROM inv") };
  const mark = w.asked.length;
  const r = await invite(w, { name: "Scout", rooms: entries(pat, ["lima", "oslo"]), check: true });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json, { ok: true, rooms: [{ room: "lima", name: "Scout", seat: "new", opened: false }, { room: "oslo", name: "Scout", seat: "new", opened: false }] });
  const methods = asked(w, mark);
  for (const m of methods) assert.ok(/\.(lookupInvite|nameHeld|inviteLoad|members|agentPeek)$/.test(m), "a read only: " + m);
  assert.ok(methods.includes(AGENT_QUOTA_ROOM + ".agentPeek"), "the counters peeked");
  for (const n of ["lima", "oslo"]) assert.deepEqual(w.harness(n).all("SELECT * FROM inv"), before[n], n + ": inv as it was");
  assert.equal(w.identities().length, 0);
  assert.equal(w.harness(AGENT_QUOTA_ROOM).db.prepare("SELECT COUNT(*) AS n FROM sqlite_master").get().n, 0, "the peek made no table");
  // only the boolean true checks
  const truthy = await invite(w, { name: "Scout", rooms: entries(pat, ["lima"]), check: "true" });
  assert.equal(truthy.status, 201, "check: \"true\" is no check");
});

test("check with a refused inviter: that entry says its refusal and nothing more, no seat is planned there and its room's counter is never read", async () => {
  const { w, pat } = people(["lima", "oslo"]);
  // oslo holds a Scout already, and Pat is near the day cap there: none of it may show for a refused inviter
  agentInvite(w.harness("oslo"), "Scout");
  const r = await invite(w, { name: "Scout", rooms: [{ room: "lima", inviter_token: pat.lima }, { room: "oslo", inviter_token: "tok-not-oslo-s-0123456789" }, { room: "nowhere", inviter_token: "tok-123456789012345678901" }], check: true });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, {
    ok: false,
    rooms: [
      { room: "lima", name: "Scout", seat: "new", opened: false },
      { room: "oslo", name: "Scout", problem: { status: 403, code: "invite_invalid", error: "Room \"oslo\": This invite link isn't valid for this room." } },
      { room: "nowhere", name: "Scout", problem: { status: 404, error: "No room with that name yet. Create it from the home page." } },
    ],
  });
  assert.deepEqual(w.methods("oslo"), ["lookupInvite"], "no planning in a room whose inviter was refused");
  assert.deepEqual(w.methods("nowhere"), ["lookupInvite"]);
  const peek = w.asked.find((a) => a.method === "agentPeek");
  const keys = peek.args[0].map((c) => c.k);
  assert.deepEqual(keys, ["net:" + (await hashKey(networkKey(IP))), "all", "room:" + (await hashKey("lima"))], "the network's, the site's, and only the passed room's counter");
});

test("check: a full counter gives retry_after and ok false; the seat problems of rooms whose inviter passed are their entries'", async () => {
  const { w, pat } = people(["lima", "oslo", "rome"]);
  // lima: Pat used the day's invites; oslo: the name is a person's
  const h = w.harness("lima");
  for (let i = 0; i < MEMBER_INVITES_PER_DAY; i++) h.room.invite("Bot" + i, "agent", "Pat", null, pat.lima);
  agentInvite(w.harness("oslo"), "Scout", "human");
  // rome is full of active invites
  for (let i = 0; i < MAX_ACTIVE_INVITES; i++) agentInvite(w.harness("rome"), "R" + i);
  const r = await invite(w, { name: "Scout", rooms: entries(pat, ["lima", "oslo", "rome"]), check: true });
  assert.equal(r.json.ok, false);
  assert.deepEqual(r.json.rooms.map((x) => [x.room, x.problem && x.problem.code, x.problem && x.problem.error]), [
    ["lima", "rate_limited", "Room \"lima\": You can create up to " + MEMBER_INVITES_PER_DAY + " invites a day"],
    ["oslo", "name_taken", "Room \"oslo\": Scout is already taken here. Pick another name."],
    ["rome", "limit_reached", "Room \"rome\": This room already has " + MAX_ACTIVE_INVITES + " active invites"],
  ]);
  assert.ok(!("retry_after" in r.json));
  // the network's counter full: retry_after, the seconds until its window ends
  const t = people(["paris"]);
  for (let i = 0; i < AGENT_KEYS_PER_IP; i++) {
    const room = "p" + i;
    const tok = agentInvite(t.w.room(room), "Pat", "human");
    assert.equal((await invite(t.w, { name: "Scout", rooms: [{ room, inviter_token: tok }] })).status, 201);
  }
  const full = await invite(t.w, { name: "Scout", rooms: entries(t.pat, ["paris"]), check: true });
  assert.equal(full.json.ok, false);
  assert.deepEqual(full.json.rooms, [{ room: "paris", name: "Scout", seat: "new", opened: false }]);
  assert.ok(full.json.retry_after > 0 && full.json.retry_after <= AGENT_KEYS_WINDOW_S, String(full.json.retry_after));
  const real = await invite(t.w, { name: "Scout", rooms: entries(t.pat, ["paris"]) });
  assert.equal(real.status, 429);
  assert.equal(real.json.code, "rate_limited");
  assert.equal(real.json.error, "Too many agent keys were made just now, from this network, for one of these rooms or on the whole site. Try again later.");
  assert.ok(Number(real.headers.get("Retry-After")) > 0);
  assert.equal(rowsOf(t.w, "paris", "Scout").length, 0, "nothing made");
  void AGENT_KEYS_PER_DAY; void AGENT_KEYS_PER_ROOM_DAY;
});

test("the identity is made first, then each seat's invite and its swap, in order; the counters are taken once every seat is planned", async () => {
  const { w, pat } = people(["lima", "oslo"]);
  const mark = w.asked.length;
  const r = await invite(w, { name: "Scout", rooms: entries(pat, ["lima", "oslo"]) });
  assert.equal(r.status, 201);
  const id = w.identities()[0];
  const seq = asked(w, mark).filter((m) => /\.(agentReserve|agentMake|invite|agentSwap)$/.test(m)).map((m) => m.replace(id, "ID"));
  assert.deepEqual(seq, [AGENT_QUOTA_ROOM + ".agentReserve", "ID.agentMake", "lima.invite", "ID.agentSwap", "oslo.invite", "ID.agentSwap"]);
  assert.equal(w.pending.length, 1, "the work runs under waitUntil");
});

test("a refusal at a later room keeps the invites the call made, unopened, names them, drops the key and gives back exactly the counters taken; a retry with the same name reuses them", async () => {
  const { w, pat } = people(["lima", "oslo", "rome"]);
  const rome = w.harness("rome");
  // the name goes in rome between the plan and the invite: a person takes it
  const realInvite = rome.room.invite.bind(rome.room);
  let raced = false;
  rome.room.invite = (...a) => { if (!raced) { raced = true; realInvite("Scout", "human", null); } return realInvite(...a); };
  const quotaBefore = () => w.objects.has(AGENT_QUOTA_ROOM) ? w.harness(AGENT_QUOTA_ROOM).all("SELECT k, n FROM aq ORDER BY k") : [];
  const q0 = quotaBefore();
  const loadBefore = { lima: rome.room.inviteLoad("Pat"), oslo: w.harness("oslo").room.inviteLoad("Pat") };
  const r = await invite(w, { name: "Scout", rooms: entries(pat, ["lima", "oslo", "rome"]) });
  assert.equal(r.status, 409, r.text);
  assert.deepEqual(r.json, {
    error: "Room \"rome\": Scout is already taken here. Pick another name.", code: "name_taken", room: "rome",
    left_unused: ["lima", "oslo"], note: unusedNote(["lima", "oslo"]),
  });
  assert.equal(r.json.note, "The invites this call made in lima, oslo stay unused, and trying again with the same name uses them.");
  clean(w, "the refusal", r);
  for (const n of ["lima", "oslo"]) {
    const rows = rowsOf(w, n, "Scout");
    assert.equal(rows.length, 1);
    assert.deepEqual({ used: rows[0].used, seen: rows[0].seen, revoked: rows[0].revoked, invited_by: rows[0].invited_by }, { used: null, seen: null, revoked: null, invited_by: "Pat" }, n + ": kept, unopened, not revoked");
    // what the person's daily count is now: one more, as inviteLoad counts it
    assert.equal(w.harness(n).room.inviteLoad("Pat").recent, 1);
  }
  void loadBefore;
  assert.equal(w.identities().filter((id) => w.harness(id).db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table'").get().n > 0).length, 0, "the identity is dropped");
  const q1 = w.harness(AGENT_QUOTA_ROOM).all("SELECT k, n FROM aq ORDER BY k");
  assert.ok(q1.every((x) => x.n === 0) && q0.length === 0, "every place taken was given back: " + JSON.stringify(q1));
  // the retry, rome under another name: the kept invites are reused, no new one is made
  rome.room.invite = realInvite;
  const mark = w.asked.length;
  const again = await invite(w, { name: "Scout", rooms: [...entries(pat, ["lima", "oslo"]), { room: "rome", inviter_token: pat.rome, name: "Scout Two" }] });
  assert.equal(again.status, 201, again.text);
  assert.deepEqual(again.json.rooms.map((x) => [x.room, x.name, x.seat]), [["lima", "Scout", "reused"], ["oslo", "Scout", "reused"], ["rome", "Scout Two", "new"]]);
  assert.equal(again.json.note, personKeyNote(true));
  assert.ok(!asked(w, mark).includes("lima.invite") && !asked(w, mark).includes("oslo.invite"), "no second invite");
  for (const n of ["lima", "oslo"]) assert.equal(rowsOf(w, n, "Scout").length, 1);
  clean(w, "the retry", again);
});

test("a call whose caller went away runs to its end (waitUntil); its key is nobody's, and a retry with the same name reuses its seats", async () => {
  const { w, pat } = people(["lima", "oslo"]);
  const rc = w.rc("POST", "/api/agents/invite", { json: { name: "Scout", rooms: entries(pat, ["lima", "oslo"]) }, headers: { "CF-Connecting-IP": IP } });
  // the answer is never read
  void agentInviteCreateRoute(rc);
  await Promise.all(w.pending);
  await new Promise((r) => setTimeout(r, 20));
  for (const n of ["lima", "oslo"]) assert.equal(rowsOf(w, n, "Scout").length, 1, n + ": the seat was made");
  const again = await invite(w, { name: "Scout", rooms: entries(pat, ["lima", "oslo"]) });
  assert.equal(again.status, 201);
  assert.deepEqual(again.json.rooms.map((x) => x.seat), ["reused", "reused"]);
  for (const n of ["lima", "oslo"]) assert.equal(rowsOf(w, n, "Scout").length, 1, n + ": no second invite");
  assert.equal(w.identities().length, 2, "two keys, the first one nobody saw");
});

test("which seats are reused: an unused one of the person's by default, one in use with reuse any, none with reuse none, never another person's or an earlier holder's", async () => {
  const { w, pat } = people(["lima"]);
  const h = w.harness("lima");
  const patRow = h.one("SELECT created FROM inv WHERE name = 'Pat'");
  // an unused seat Pat invited
  const scout = h.room.invite("Scout", "agent", "Pat", null, pat.lima).token;
  let r = await invite(w, { name: "scout", rooms: entries(pat, ["lima"]), check: true });
  assert.deepEqual(r.json.rooms, [{ room: "lima", name: "Scout", seat: "reused", opened: false }], "the seat's own spelling");
  r = await invite(w, { name: "Scout", rooms: entries(pat, ["lima"], { reuse: "none" }), check: true });
  assert.equal(r.json.rooms[0].problem.code, "name_taken");
  // in use: seat_in_use by default, reused with any
  h.room.access(scout, false);
  r = await invite(w, { name: "Scout", rooms: entries(pat, ["lima"]), check: true });
  assert.deepEqual(r.json.rooms[0], { room: "lima", name: "Scout", problem: { status: 409, code: "seat_in_use", error: "Room \"lima\": Scout is already a member here, invited by you: use that seat, or pick another name." } });
  r = await invite(w, { name: "Scout", rooms: entries(pat, ["lima"], { reuse: "any" }) });
  assert.equal(r.status, 201);
  assert.deepEqual(r.json.rooms, [{ room: "lima", name: "Scout", opened: true, seat: "reused" }]);
  // another person's agent seat: never
  const ann = agentInvite(h, "Ann", "human");
  h.room.invite("Bolt", "agent", "Ann", null, ann);
  r = await invite(w, { name: "Bolt", rooms: entries(pat, ["lima"], { reuse: "any" }), check: true });
  assert.equal(r.json.rooms[0].problem.code, "name_taken");
  // an earlier holder of the name "Pat" invited Echo before this Pat's invite was made: not this Pat's
  h.db.prepare("INSERT INTO inv (token, name, created, kind, invited_by) VALUES ('tok-echo-0000000000000000', 'Echo', ?, 'agent', 'Pat')").run(patRow.created - 1000);
  r = await invite(w, { name: "Echo", rooms: entries(pat, ["lima"]), check: true });
  assert.equal(r.json.rooms[0].problem.code, "name_taken", "invited before the inviter's own invite");
  // an older room with two active people whose names fold alike: invited_by must be this one's spelling exactly
  h.db.prepare("INSERT INTO inv (token, name, created, kind) VALUES ('tok-lowpat-000000000000', 'pat', ?, 'human')").run(Date.now() - 5000);
  h.db.prepare("INSERT INTO inv (token, name, created, kind, invited_by) VALUES ('tok-fold-0000000000000000', 'Fold', ?, 'agent', 'pat')").run(Date.now());
  r = await invite(w, { name: "Fold", rooms: entries(pat, ["lima"]), check: true });
  assert.equal(r.json.rooms[0].problem.code, "name_taken", "a seat invited by \"pat\" is not \"Pat\"'s");
  // a person's own seat of the name is never an agent's to reuse
  r = await invite(w, { name: "Ann", rooms: entries(pat, ["lima"], { reuse: "any" }), check: true });
  assert.equal(r.json.rooms[0].problem.code, "name_taken");
});

test("a name invite() takes as held with no row of the same name (the lunate sigmas) is name_taken", async () => {
  const { w, pat } = people(["lima"]);
  const a = "ϹX", b = "ϲX"; // lower-case alike, fold apart
  w.harness("lima").room.invite(a, "agent", "Pat", null, pat.lima);
  const r = await invite(w, { name: b, rooms: entries(pat, ["lima"]), check: true });
  assert.deepEqual(r.json.rooms[0].problem, { status: 409, code: "name_taken", error: "Room \"lima\": " + b + " is already taken here. Pick another name." });
  const real = await invite(w, { name: b, rooms: entries(pat, ["lima"]) });
  assert.equal(real.status, 409);
  assert.equal(rowsOf(w, "lima", b).length, 0);
});

test("the room's caps answer per room, from invite(): the person's day and the room's active invites", async () => {
  const { w, pat } = people(["lima", "oslo"]);
  for (let i = 0; i < MEMBER_INVITES_PER_DAY; i++) w.harness("lima").room.invite("Bot" + i, "agent", "Pat", null, pat.lima);
  let r = await invite(w, { name: "Scout", rooms: entries(pat, ["oslo", "lima"]) });
  assert.equal(r.status, 429);
  assert.deepEqual(r.json, { error: "Room \"lima\": You can create up to " + MEMBER_INVITES_PER_DAY + " invites a day", code: "rate_limited", room: "lima" });
  const ra = Number(r.headers.get("Retry-After"));
  assert.ok(ra > 86000 && ra <= 86400, String(ra));
  assert.equal(rowsOf(w, "oslo", "Scout").length, 0, "planning stopped the call before anything was made");
  for (let i = 0; i < MAX_ACTIVE_INVITES - 1; i++) agentInvite(w.harness("oslo"), "R" + i);
  r = await invite(w, { name: "Scout", rooms: entries(pat, ["oslo"]) });
  assert.equal(r.status, 429);
  assert.deepEqual(r.json, { error: "Room \"oslo\": This room already has " + MAX_ACTIVE_INVITES + " active invites", code: "limit_reached", room: "oslo" });
  assert.equal(r.headers.get("Retry-After"), null);
});

test("two calls at once for the same person: the room's caps hold exactly", async () => {
  // the same name: one seat in all, whichever way the two calls interleave
  {
    const { w, pat } = people(["lima"]);
    const [a, b] = await Promise.all([invite(w, { name: "Scout", rooms: entries(pat, ["lima"]) }), invite(w, { name: "Scout", rooms: entries(pat, ["lima"]) })]);
    assert.ok([a.status, b.status].includes(201), a.status + " " + b.status);
    assert.equal(rowsOf(w, "lima", "Scout").length, 1, "one seat");
    assert.equal(w.harness("lima").room.inviteLoad("Pat").recent, 1);
    for (const x of [a, b]) if (x.status !== 201) assert.deepEqual([x.status, x.json.code, x.json.left_unused], [409, "name_taken", undefined]);
  }
  // one invite left today: two names at once, one gets it
  {
    const { w, pat } = people(["lima"]);
    for (let i = 0; i < MEMBER_INVITES_PER_DAY - 1; i++) w.harness("lima").room.invite("Bot" + i, "agent", "Pat", null, pat.lima);
    const got = await Promise.all([invite(w, { name: "One", rooms: entries(pat, ["lima"]) }), invite(w, { name: "Two", rooms: entries(pat, ["lima"]) })]);
    assert.deepEqual(got.map((x) => x.status).sort(), [201, 429]);
    assert.equal(got.find((x) => x.status === 429).json.code, "rate_limited");
    assert.equal(w.harness("lima").room.inviteLoad("Pat").recent, MEMBER_INVITES_PER_DAY, "exactly the cap");
    assert.equal(w.identities().filter((id) => w.harness(id).db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table'").get().n > 0).length, 1, "one key kept");
  }
});

test("a person's invite revoked between the plan and the invite: the refusal, and the invite already made kept unused", async () => {
  const { w, pat } = people(["lima", "oslo"]);
  const oslo = w.harness("oslo");
  const real = oslo.room.invite.bind(oslo.room);
  oslo.room.invite = (...a) => { oslo.room.revoke(pat.oslo); return real(...a); };
  const r = await invite(w, { name: "Scout", rooms: entries(pat, ["lima", "oslo"]) });
  assert.equal(r.status, 403);
  assert.deepEqual(r.json, { error: "Room \"oslo\": This invite link has been revoked. Ask whoever gave it to you for a new one.", code: "invite_revoked", room: "oslo", left_unused: ["lima"], note: "The invite this call made in lima stays unused, and trying again with the same name uses it." });
  assert.equal(rowsOf(w, "lima", "Scout")[0].revoked, null);
  assert.equal(rowsOf(w, "oslo", "Scout").length, 0);
});

test("a room that throws (older code) stops the call with its sentence, the earlier invites kept", async () => {
  const { w, pat } = people(["lima", "oslo"]);
  w.harness("oslo").room.invite = () => { throw new Error("RPC receiver does not implement the method \"invite\""); };
  const r = await invite(w, { name: "Scout", rooms: entries(pat, ["lima", "oslo"]) });
  assert.equal(r.status, 500);
  assert.deepEqual(r.json, { error: "Room \"oslo\" could not be reached, so no key was made. Try again.", room: "oslo", left_unused: ["lima"], note: unusedNote(["lima"]) });
});

test("POST /api/agent/rooms/invite: the key's checks, held rooms, the most rooms, a check, seats added, and a failure that takes them off again", async () => {
  const { w, pat } = people(["lima", "oslo", "rome", "nice"]);
  const made = await invite(w, { name: "Scout", rooms: entries(pat, ["lima"]) });
  const key = made.json.key;
  // the key's refusals, before the body is read
  for (const [h, code] of [[{}, "agent_key_missing"], [{ Authorization: "Bearer " + pat.lima }, "not_agent_key"], [{ Authorization: "Bearer " + newAgentKey().key }, "agent_key_invalid"]]) {
    const r = await read(agentInviteAddRoute(w.rc("POST", "/api/agent/rooms/invite", { json: { name: "Scout", rooms: entries(pat, ["oslo"]) }, headers: h })));
    assert.equal(r.json.code, code);
  }
  // a room already held
  let r = await addInvite(w, key, { name: "Scout", rooms: entries(pat, ["oslo", "lima"]) });
  assert.equal(r.status, 409);
  assert.deepEqual(r.json, { error: "rooms[1]: lima is already on this key", code: "room_held", room: "lima" });
  // a check: the held room is its entry's problem, the rest planned
  r = await addInvite(w, key, { name: "Scout", rooms: entries(pat, ["oslo", "lima"]), check: true });
  assert.deepEqual(r.json, { ok: false, rooms: [{ room: "oslo", name: "Scout", seat: "new", opened: false }, { room: "lima", name: "Scout", problem: { status: 409, code: "room_held", error: "rooms[1]: lima is already on this key" } }] });
  assert.deepEqual(w.methods("lima").filter((m) => m !== "lookupInvite" && m !== "nameHeld" && m !== "inviteLoad" && m !== "invite"), [], "the held room asked nothing for the check");
  // added
  const mark = w.asked.length;
  r = await addInvite(w, key, { name: "Scout", rooms: entries(pat, ["oslo", "rome"]) });
  assert.equal(r.status, 201, r.text);
  assert.deepEqual(r.json, { rooms: [{ room: "oslo", name: "Scout", opened: false, seat: "new" }, { room: "rome", name: "Scout", opened: false, seat: "new" }], rooms_held: 3 });
  assert.ok(!asked(w, mark).some((m) => m.startsWith(AGENT_QUOTA_ROOM)), "no creation counter");
  clean(w, "the add", r);
  const list = await mcp(w, key, "list_rooms", {});
  assert.deepEqual(list.structuredContent.rooms.map((x) => x.room), ["lima", "oslo", "rome"]);
  // a failure: nice's name is taken meanwhile; the entries this call added come off, its invites stay unused
  const t = people(["a1", "a2"], w);
  const realInvite = w.harness("a2").room.invite.bind(w.harness("a2").room);
  w.harness("a2").room.invite = (...x) => { realInvite("Scout", "human", null); return realInvite(...x); };
  r = await addInvite(w, key, { name: "Scout", rooms: entries(t.pat, ["a1", "a2"]) });
  assert.equal(r.status, 409);
  assert.deepEqual(r.json.left_unused, ["a1"]);
  const after = await mcp(w, key, "list_rooms", {});
  assert.deepEqual(after.structuredContent.rooms.map((x) => x.room), ["lima", "oslo", "rome"], "a1 came off again");
  assert.equal(rowsOf(w, "a1", "Scout")[0].revoked, null, "its invite stays, unused");
});

test("POST /api/agent/rooms/invite: the most rooms counts as add_room counts, a refused room replaced in place; a check says it as the call's problem", async () => {
  const names = Array.from({ length: AGENT_ROOMS_MAX + 1 }, (_, i) => "m" + i);
  const { w, pat } = people(names);
  const made = await invite(w, { name: "Scout", rooms: entries(pat, names.slice(0, AGENT_ROOMS_MAX)) });
  assert.equal(made.status, 201, made.text);
  const key = made.json.key;
  let r = await addInvite(w, key, { name: "Scout", rooms: entries(pat, [names[AGENT_ROOMS_MAX]]) });
  assert.equal(r.status, 429);
  assert.deepEqual(r.json, { error: "This key holds at most " + AGENT_ROOMS_MAX + " rooms; take one off first (remove_room).", code: "limit_reached" });
  r = await addInvite(w, key, { name: "Scout", rooms: entries(pat, [names[AGENT_ROOMS_MAX]]), check: true });
  assert.deepEqual(r.json.problem, { status: 429, code: "limit_reached", error: "This key holds at most " + AGENT_ROOMS_MAX + " rooms; take one off first (remove_room)." });
  assert.equal(r.json.ok, false);
  // m0 refuses the key's invite (revoked): it is marked refused, and adding m0 again replaces it in place
  const m0 = w.harness("m0");
  m0.room.revoke(rowsOf(w, "m0", "Scout")[0].token);
  await mcp(w, key, "whoami", { room: "m0" });
  r = await addInvite(w, key, { name: "Scout", rooms: entries(pat, ["m0"]) });
  assert.equal(r.status, 201, r.text);
  assert.equal(r.json.rooms_held, AGENT_ROOMS_MAX, "replaced in place, counted once");
  const g = (await read(agentRoute(w.rc("GET", "/api/agent", { headers: { Authorization: "Bearer " + key } })))).json;
  assert.equal(g.rooms.filter((x) => x.room === "m0").length, 1);
  assert.equal(g.rooms.find((x) => x.room === "m0").state, "held");
});
