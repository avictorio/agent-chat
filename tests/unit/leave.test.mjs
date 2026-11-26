// A member leaving the room by itself (POST /api/rooms/ROOM/leave:
// worker/routes/members.ts leaveRoute; worker/room/members.ts leave), on the
// real Room class (room-harness.mjs), with Cartesia stood in for by a stub
// of fetch. One test per thing a leave does or refuses: what a revoke of
// its own invite does, the time it left, its picture and voice, its claims,
// the lobbies waiting on it, the name freed, the invites it made, the last
// member's room (deleted only on a second yes, and never a protected one),
// the owner key, the confirm, and the schema step on an older room.
import test from "node:test";
import assert from "node:assert/strict";
import { makeRoom } from "./room-harness.mjs";
import { leaveRoute } from "../../worker/routes/members.ts";
import { roomRoute } from "../../worker/routes/rooms.ts";
import { mcpRoute } from "../../worker/routes/agents.ts";
import { PROTECTED_ROOMS } from "../../worker/limits.ts";
import { nameFold } from "../../worker/lib/text.ts";

// Node wants duplex: "half" on a Request built with a stream body, which
// settleBody (lib/http.ts) makes; the Workers runtime does not.
const NodeRequest = globalThis.Request;
globalThis.Request = class extends NodeRequest {
  constructor(input, init) { super(input, init && init.body && typeof init.body.getReader === "function" ? { duplex: "half", ...init } : init); }
};

const R = "unit";
const MP3 = new Uint8Array([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0, 1, 2, 3, 4]).buffer;
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 1, 2, 3]).buffer;

/** Cartesia as a stub: answer(call) gives each call's Response; calls lists them */
function cartesia(answer) {
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (!u.startsWith("https://api.cartesia.ai/")) throw new Error("unexpected fetch " + u);
    calls.push((init && init.method || "GET") + " " + u);
    return answer();
  };
  return { calls, restore: () => { globalThis.fetch = real; } };
}

/** the harness's room as the Worker reaches it: every method answers a promise, as over RPC */
const stubOf = (h) => new Proxy({}, { get: (_, n) => { const f = h.room[n]; return typeof f === "function" ? async (...a) => f.apply(h.room, a) : f; } });

/** a route context for a request to /api/rooms/ROOM/<rest> on the harness's room */
function ctxOf(h, method, room, rest, opts = {}) {
  const url = new URL("http://localhost/api/rooms/" + room + "/" + rest);
  const env = { ROOM: { idFromName: (n) => n, get: () => stubOf(h) }, REQUESTS: { put: async () => {}, get: async () => null }, ...(opts.key === false ? {} : { CARTESIA_API_KEY: "test-key" }) };
  const later = h.later || (h.later = []);
  const ctx = { waitUntil: (p) => { later.push(p); } };
  const init = { method };
  if (opts.body !== undefined && method !== "GET") { init.body = typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body); init.headers = { "Content-Type": "application/json" }; }
  return { request: new Request(url, init), env, url, path: url.pathname, owner: !!opts.owner, invite: opts.token === undefined ? "" : opts.token, ctx };
}

/** POST /api/rooms/ROOM/leave with that token and body, and what the route left to run after its answer */
async function leave(h, token, body, opts = {}) {
  const room = opts.room || R;
  const rc = ctxOf(h, opts.method || "POST", room, "leave", { ...opts, token, body });
  const r = await leaveRoute(rc, /^\/api\/rooms\/([^/]+)\/leave$/.exec(rc.url.pathname));
  await Promise.all((h.later || []).splice(0));
  await h.settled();
  return { status: r.status, json: await r.json() };
}

/** the room's answer to anything on /api/rooms/ROOM/<rest>: roomRoute first, as index.ts runs it */
async function roomAnswer(h, room, rest, token) {
  const rc = ctxOf(h, "GET", room, rest, { token });
  const r = await roomRoute(rc, /^\/(?:r|api\/rooms)\/([^/]+)/.exec(rc.url.pathname));
  return r ? { status: r.status, json: await r.json() } : null;
}

/** an unopened invite: a row nobody has used */
function unopened(h, name, by) { h.db.prepare("INSERT INTO inv (token, name, created, kind, invited_by) VALUES (?, ?, ?, 'agent', ?)").run("tok-" + name, name, Date.now() - 1000, by || null); }
const inv = (h, name) => { const r = h.one("SELECT * FROM inv WHERE token = ?", "tok-" + name); return r && { ...r }; };
const OK = { confirm: R };

test("a joined member leaves: its row is kept, revoked and left set to one time, its streams close, and its token is refused from then on", async () => {
  const h = makeRoom();
  h.member("Ada", "agent");
  h.member("Bea", "human");
  const closed = [];
  h.room.clients.add({ token: "tok-Ada", owner: false, name: "Ada", kinds: null, games: null, stateSub: false, stateKey: null, send() {}, close() { closed.push("Ada"); h.room.clients.delete(this); } });
  const frames = [];
  h.room.clients.add({ token: "tok-Bea", owner: false, name: "Bea", kinds: null, games: null, stateSub: false, stateKey: null, send: (s) => frames.push(s), close() {} });
  await h.room.post("Ada", "a message that stays", R, false);
  const r = await leave(h, "tok-Ada", OK);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(Object.keys(r.json), ["room", "name", "left", "room_deleted"]);
  assert.equal(r.json.name, "Ada");
  assert.equal(r.json.room_deleted, false);
  const row = inv(h, "Ada");
  assert.ok(row.revoked && row.left_ts === row.revoked && r.json.left === row.revoked, "revoked and left are the same moment: " + JSON.stringify(row));
  assert.deepEqual(closed, ["Ada"], "its stream closed");
  assert.ok(frames.some((f) => f.startsWith("event: members") && f.includes("\"from\":\"Ada\"")), "the others get a members frame naming it");
  assert.equal(h.one("SELECT COUNT(*) AS n FROM m WHERE sender = 'Ada'").n, 1, "its message stays");
  assert.equal(h.one("SELECT COUNT(*) AS n FROM m WHERE sender = 'Referee'").n, 0, "leaving posts nothing");
  const l = h.room.lookupInvite("tok-Ada");
  assert.deepEqual([l.ok, l.status, l.code], [false, 403, "invite_revoked"]);
  const again = await leave(h, "tok-Ada", OK);
  assert.deepEqual([again.status, again.json.code], [403, "invite_revoked"]);
  // the members list: status revoked, left carried; the owner's invite list too
  const m = h.room.members().members.find((x) => x.name === "Ada");
  assert.deepEqual([m.status, m.left, m.revoked], ["revoked", row.left_ts, row.revoked]);
  assert.equal(h.room.members().members.find((x) => x.name === "Bea").left, null);
  assert.equal(h.room.invites().find((x) => x.name === "Ada").left, row.left_ts);
  assert.ok(!("left_ts" in h.room.invites()[0]), "the invite list names the field left");
});

test("an invite never opened is refused (409 not_joined) and stays unopened: nothing is marked used or seen", async () => {
  const h = makeRoom();
  h.member("Bea");
  unopened(h, "Cy", "Bea");
  const before = inv(h, "Cy");
  const r = await leave(h, "tok-Cy", OK);
  assert.deepEqual([r.status, r.json.code], [409, "not_joined"], JSON.stringify(r.json));
  assert.match(r.json.error, /never opened.*not using it is all it takes.*did not open it/);
  assert.deepEqual(inv(h, "Cy"), before, "the row is as it was: used, seen and revoked all unset");
  // even with delete_room and as the room's only other invite: the room stays
  const r2 = await leave(h, "tok-Cy", { confirm: R, delete_room: true });
  assert.equal(r2.json.code, "not_joined");
  assert.equal(h.room.exists(), true);
});

test("its picture and its voice are deleted: the rows, the avatar and sample objects, the cached speak audio and the clone at Cartesia", async () => {
  const c = cartesia(() => new Response(null, { status: 200 }));
  try {
    const h = makeRoom();
    h.member("Ada");
    h.member("Bea");
    assert.ok(await h.room.setAvatar("Ada", PNG, "image/png", R));
    const put = await h.room.putVoiceSample("Ada", MP3, "audio/mpeg", R);
    await h.room.setVoiceId("Ada", "cartesia", "v-ada", put.gen, put.key);
    const msg = await h.room.post("Ada", "spoken", R, false);
    await h.room.putMedia(msg.id, "speak", MP3, "audio/mpeg", R);
    const avatarKey = inv(h, "Ada").avatar_key;
    const speakKey = h.one("SELECT r2key FROM md WHERE msg = ? AND kind = 'speak'", msg.id).r2key;
    for (const k of [avatarKey, put.key, speakKey]) assert.ok(h.objects.has(k), "stored first: " + k);
    // Bea's picture is hers
    await h.room.setAvatar("Bea", PNG, "image/png", R);
    const r = await leave(h, "tok-Ada", OK);
    assert.equal(r.status, 200);
    const row = inv(h, "Ada");
    assert.deepEqual([row.avatar_key, row.avatar_ver, row.avatar_type], [null, null, null]);
    assert.equal(h.one("SELECT COUNT(*) AS n FROM mv WHERE name = 'ada'").n, 0, "the voice row goes");
    for (const k of [avatarKey, put.key, speakKey]) assert.ok(!h.objects.has(k), "deleted: " + k);
    assert.equal(h.one("SELECT COUNT(*) AS n FROM md WHERE kind = 'speak'").n, 0);
    assert.deepEqual(c.calls, ["DELETE https://api.cartesia.ai/voices/v-ada"]);
    assert.equal(h.one("SELECT COUNT(*) AS n FROM cfg WHERE k LIKE 'voice-del:%'").n, 0, "Cartesia confirmed: no pending delete left");
    assert.ok(inv(h, "Bea").avatar_key && h.objects.has(inv(h, "Bea").avatar_key), "another member's picture stays");
  } finally { c.restore(); }
});

test("a clone Cartesia does not delete (or no key) stays a pending delete, and storage refusing a delete undoes no leave", async () => {
  const c = cartesia(() => new Response("{}", { status: 500 }));
  try {
    const h = makeRoom({ before: (op) => { if (op === "delete") throw new Error("R2 down"); } });
    h.member("Ada");
    h.member("Bea");
    const put = await h.room.putVoiceSample("Ada", MP3, "audio/mpeg", R);
    await h.room.setVoiceId("Ada", "cartesia", "v-kept", put.gen, put.key);
    const r = await leave(h, "tok-Ada", OK);
    assert.equal(r.status, 200, "the leave stands");
    assert.ok(inv(h, "Ada").revoked);
    assert.equal(h.one("SELECT COUNT(*) AS n FROM mv").n, 0, "the voice row went in the leave's own step");
    assert.equal(h.one("SELECT COUNT(*) AS n FROM cfg WHERE k = 'voice-del:v-kept'").n, 1, "the clone's id is kept for a later try");
  } finally { c.restore(); }
  const h2 = makeRoom();
  h2.member("Ada");
  h2.member("Bea");
  const put2 = await h2.room.putVoiceSample("Ada", MP3, "audio/mpeg", R);
  await h2.room.setVoiceId("Ada", "cartesia", "v-nokey", put2.gen, put2.key);
  const r2 = await leave(h2, "tok-Ada", OK, { key: false });
  assert.equal(r2.status, 200);
  assert.equal(h2.one("SELECT COUNT(*) AS n FROM cfg WHERE k = 'voice-del:v-nokey'").n, 1, "without the key the clone waits as a pending delete");
});

test("questions it claimed go back to open; its signatures on decisions stay", async () => {
  const h = makeRoom();
  h.member("Ada");
  h.member("Bea");
  const q1 = h.room.addQuestion("Ada's", "Bea");
  const q2 = h.room.addQuestion("Bea's", "Bea");
  h.room.updateQuestion(q1.id, "claim", "Ada", null);
  h.room.updateQuestion(q2.id, "claim", "Bea", null);
  const d = h.room.addDecision("Lima first", null, "Bea");
  h.room.updateDecision(d.id, "sign", "Ada");
  const rev = h.room.boardRev();
  assert.equal((await leave(h, "tok-Ada", OK)).status, 200);
  assert.deepEqual({ ...h.one("SELECT status, claimed_by FROM oq WHERE id = ?", q1.id) }, { status: "open", claimed_by: null });
  assert.deepEqual({ ...h.one("SELECT status, claimed_by FROM oq WHERE id = ?", q2.id) }, { status: "claimed", claimed_by: "Bea" }, "another member's claim stays");
  assert.deepEqual(JSON.parse(h.one("SELECT signers FROM dc WHERE id = ?", d.id).signers), ["Ada"], "the signature stays");
  assert.ok(h.room.boardRev() > rev, "the release is a board write");
});

test("lobbies waiting for its accept are declined at once, with the Referee's line; a lobby it accepted and a running match are left alone", async () => {
  const h = makeRoom();
  h.member("Ada");
  h.member("Bea");
  const waiting = (await h.room.createGame("Bea", ["Bea", "Ada"], { game: "duel" }, R)).game;
  const mine = (await h.room.createGame("Ada", ["Ada", "Bea"], { game: "duel" }, R)).game;
  const running = (await h.room.createGame("Bea", ["Bea", "Ada"], { game: "duel" }, R)).game;
  assert.equal((await h.room.gameAccept(running.id, "Ada", R)).game.status, "running");
  assert.equal((await leave(h, "tok-Ada", OK)).status, 200);
  const st = (id) => h.room.gameRow(id);
  assert.equal(st(waiting.id).status, "cancelled");
  assert.equal(st(waiting.id).st.declined_by, "Ada");
  assert.equal(st(mine.id).status, "lobby", "a lobby it accepted waits on others, as before");
  assert.equal(st(running.id).status, "running", "a running match is left to its clock");
  const posts = h.all("SELECT text FROM m WHERE sender = 'Referee'").map((x) => x.text);
  assert.deepEqual(posts, ["Duel match #" + waiting.id + " is off - Ada declined the seat."]);
});

test("its push registrations, hook and upload links go", async () => {
  const h = makeRoom();
  h.member("Ada");
  h.member("Bea");
  const now = Date.now();
  h.db.prepare("INSERT INTO push (member, endpoint, p256dh, auth, ts) VALUES ('ada', 'https://fcm.googleapis.com/fcm/send/a', 'k', 'a', ?)").run(now);
  h.db.prepare("INSERT INTO push (member, endpoint, p256dh, auth, ts) VALUES ('bea', 'https://fcm.googleapis.com/fcm/send/b', 'k', 'a', ?)").run(now);
  h.db.prepare("INSERT INTO mh (member, name, room, link, routing, enabled, muted, created, updated, kind, url, secret) VALUES ('ada', 'Ada', 'unit', '', '', 1, 0, ?, ?, 'webhook', 'https://agent.example.org/wake', 's')").run(now, now);
  h.db.prepare("INSERT INTO ut (h, msg, kind, member, created, expires, max_bytes) VALUES ('h1', 1, 'image', 'Ada', ?, ?, 10)").run(now, now + 60000);
  assert.equal((await leave(h, "tok-Ada", OK)).status, 200);
  assert.deepEqual(h.all("SELECT member FROM push").map((x) => x.member), ["bea"]);
  assert.equal(h.one("SELECT COUNT(*) AS n FROM mh").n, 0);
  assert.equal(h.one("SELECT COUNT(*) AS n FROM ut").n, 0);
});

test("its name is free at once, and the invites it made for others keep working", async () => {
  const h = makeRoom();
  h.member("Ada");
  h.member("Bea");
  const made = h.room.invite("Cy", "agent", "Ada", { perDay: 5, maxActive: 50 }, "tok-Ada");
  assert.ok(made && made.token);
  assert.equal((await leave(h, "tok-Ada", OK)).status, 200);
  assert.equal(h.room.lookupInvite(made.token).ok, true, "Cy's invite still works");
  assert.equal(h.room.access(made.token, false).name, "Cy");
  const again = h.room.invite("ada", "human", "Bea", { perDay: 5, maxActive: 50 }, "tok-Bea");
  assert.ok(again && again.token, "the name can be invited again at once: " + JSON.stringify(again));
});

test("the last member who has joined is refused (409 last_member) without delete_room, and nothing changes", async () => {
  const h = makeRoom();
  h.member("Ada");
  unopened(h, "Cy", "Ada");
  unopened(h, "Dee", "Ada");
  const before = h.all("SELECT * FROM inv ORDER BY token").map((x) => ({ ...x }));
  const r = await leave(h, "tok-Ada", OK);
  assert.deepEqual([r.status, r.json.code], [409, "last_member"], JSON.stringify(r.json));
  assert.match(r.json.error, /last member of this room who has joined: leaving deletes the room and everything in it, for good, and the 2 invites not yet opened stop working too\./);
  assert.match(r.json.error, /"delete_room": true/);
  assert.deepEqual(h.all("SELECT * FROM inv ORDER BY token").map((x) => ({ ...x })), before);
  assert.equal(h.room.exists(), true);
  // delete_room as text "true" is the same yes; anything else is none
  assert.equal((await leave(h, "tok-Ada", { confirm: R, delete_room: "yes" })).json.code, "last_member");
});

test("with delete_room the last member's leave deletes the room as the owner's deletion does, its unopened invites included", async () => {
  const c = cartesia(() => new Response(null, { status: 200 }));
  try {
    const h = makeRoom();
    h.member("Ada");
    unopened(h, "Cy", "Ada");
    const m = await h.room.post("Ada", "with a picture", R, false, null, { data: PNG, type: "image/png" });
    await h.room.setAvatar("Ada", PNG, "image/png", R);
    const put = await h.room.putVoiceSample("Ada", MP3, "audio/mpeg", R);
    await h.room.setVoiceId("Ada", "cartesia", "v-last", put.gen, put.key);
    assert.ok(h.objects.size >= 3);
    const gen = h.room.gen;
    const r = await leave(h, "tok-Ada", { confirm: R, delete_room: true });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual(r.json, { room: R, name: "Ada", left: r.json.left, room_deleted: true });
    assert.equal(h.room.exists(), false, "the room is gone");
    assert.equal(h.room.gen, gen + 1, "calls in flight are fenced off (destroy)");
    assert.equal(h.objects.size, 0, "every object went: the message's image, the picture, the sample");
    const tables = h.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").map((x) => x.name);
    assert.deepEqual(tables, ["cfg"], "only the marks destroy() keeps");
    assert.ok(Number(h.one("SELECT v FROM cfg WHERE k = 'msg_hwm'").v) >= m.id, "the id counter outlives the room");
    assert.deepEqual(c.calls, ["DELETE https://api.cartesia.ai/voices/v-last"], "its clone is deleted at Cartesia");
    assert.equal(h.one("SELECT COUNT(*) AS n FROM cfg WHERE k LIKE 'voice-del:%'").n, 0);
    // afterwards: the unopened invite's token, and the leaver's, find no room
    for (const tok of ["tok-Cy", "tok-Ada"]) assert.deepEqual((await roomAnswer(h, R, "messages", tok)).status, 404);
    // the lookup a request with a body meets first (index.ts settleRoomBody) answers, where it threw "no such table"
    const l = h.room.lookupInvite("tok-Cy");
    assert.deepEqual([l.ok, l.status, l.code], [false, 410, "room_deleted"]);
    assert.equal(h.room.create(), true, "the name is free for a new room");
  } finally { c.restore(); }
});

test("one other active member makes it an ordinary leave: the room stays, room_deleted false, delete_room ignored", async () => {
  const h = makeRoom();
  h.member("Ada");
  h.member("Bea");
  const r = await leave(h, "tok-Ada", { confirm: R, delete_room: true });
  assert.equal(r.status, 200);
  assert.equal(r.json.room_deleted, false);
  assert.equal(h.room.exists(), true);
  assert.ok(inv(h, "Ada").left_ts && !inv(h, "Bea").revoked);
  // and now Bea is the last one who has joined
  assert.equal((await leave(h, "tok-Bea", OK)).json.code, "last_member");
});

test("a protected room is never deleted: its last member leaves as any member does, and its unopened invites stay", async () => {
  const P = PROTECTED_ROOMS[0];
  const h = makeRoom();
  h.member("Ada");
  unopened(h, "Cy");
  for (const body of [{ confirm: P }, { confirm: P, delete_room: true }]) {
    if (body.delete_room) { h.member("Eve"); }
    const who = body.delete_room ? "tok-Eve" : "tok-Ada";
    const r = await leave(h, who, body, { room: P });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.room_deleted, false);
    assert.equal(h.room.exists(), true);
  }
  assert.ok(inv(h, "Ada").left_ts && inv(h, "Eve").left_ts);
  assert.equal(inv(h, "Cy").revoked, null, "the unopened invite is untouched");
});

test("the owner key cannot leave, alone or beside a token (400 owner_not_member), and nothing changes", async () => {
  const h = makeRoom();
  h.member("Ada");
  h.member("Bea");
  for (const token of ["", "tok-Ada"]) {
    const r = await leave(h, token, OK, { owner: true });
    assert.deepEqual([r.status, r.json.code], [400, "owner_not_member"], JSON.stringify(r.json));
    assert.match(r.json.error, /owner key is no member/);
  }
  assert.equal(inv(h, "Ada").revoked, null);
});

test("a confirm that is missing or names another room changes nothing (400 confirm_mismatch); other refusals keep the room's codes", async () => {
  const h = makeRoom();
  h.member("Ada");
  h.member("Bea");
  for (const body of [undefined, {}, { confirm: "other-room" }, { confirm: "UNIT" }, { delete_room: true }]) {
    const r = await leave(h, "tok-Ada", body);
    assert.deepEqual([r.status, r.json.code], [400, "confirm_mismatch"], JSON.stringify(body));
    assert.ok(r.json.error.includes("{\"confirm\": \"unit\"}"), r.json.error);
  }
  assert.equal(inv(h, "Ada").revoked, null);
  assert.deepEqual([(await leave(h, "", OK)).status, (await leave(h, "", OK)).json.code], [401, "invite_missing"]);
  assert.deepEqual((await leave(h, "tok-nobody", OK)).json.code, "invite_invalid");
  assert.equal((await leave(h, "tok-Ada", OK, { method: "GET" })).status, 405);
});

test("the schema step adds inv.left_ts to a room an older version left, and a leave works there", async () => {
  const h = makeRoom();
  h.member("Ada");
  h.member("Bea");
  h.db.exec("ALTER TABLE inv DROP COLUMN left_ts");
  h.db.prepare("UPDATE cfg SET v = '8' WHERE k = 'schema_version'").run();
  h.restart();
  assert.equal(h.one("SELECT v FROM cfg WHERE k = 'schema_version'").v, "9");
  assert.ok(h.all("SELECT name FROM pragma_table_info('inv')").some((c) => c.name === "left_ts"));
  assert.equal(inv(h, "Bea").left_ts, null, "older rows read as never left");
  assert.equal((await leave(h, "tok-Ada", OK)).status, 200);
  assert.ok(inv(h, "Ada").left_ts);
  // the step is safe to run again
  h.db.prepare("UPDATE cfg SET v = '8' WHERE k = 'schema_version'").run();
  h.restart();
  assert.equal(h.one("SELECT v FROM cfg WHERE k = 'schema_version'").v, "9");
});

/** one MCP tools/call of leave_room on the harness's room */
async function mcpLeave(h, token, args, owner) {
  const rc = ctxOf(h, "POST", R, "mcp", { token, owner, body: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "leave_room", arguments: args } } });
  const r = await mcpRoute(rc, /^\/api\/rooms\/([^/]+)\/mcp$/.exec(rc.url.pathname));
  await Promise.all((h.later || []).splice(0));
  return (await r.json());
}

test("MCP leave_room: refuses an invite never opened without joining, refuses the owner key, and leaves as the route does", async () => {
  const h = makeRoom();
  h.member("Ada");
  h.member("Bea");
  unopened(h, "Cy");
  let j = await mcpLeave(h, "tok-Cy", OK);
  assert.equal(j.result.isError, true);
  assert.equal(j.result.structuredContent.code, "not_joined");
  assert.equal(inv(h, "Cy").used, null, "the tool did not open the invite");
  assert.equal(inv(h, "Cy").seen, null);
  j = await mcpLeave(h, "tok-Ada", { confirm: "nope" });
  assert.equal(j.result.structuredContent.code, "confirm_mismatch");
  j = await mcpLeave(h, "", OK, true);
  assert.equal(j.result.structuredContent.code, "owner_not_member");
  j = await mcpLeave(h, "", OK);
  assert.deepEqual([j.error.code, j.error.data.code], [-32001, "invite_missing"]);
  j = await mcpLeave(h, "tok-Ada", OK);
  assert.deepEqual(j.result.structuredContent, { room: R, name: "Ada", left: inv(h, "Ada").left_ts, room_deleted: false });
  j = await mcpLeave(h, "tok-Ada", OK);
  assert.deepEqual([j.error.code, j.error.data.code], [-32001, "invite_revoked"]);
  j = await mcpLeave(h, "tok-Bea", OK);
  assert.equal(j.result.structuredContent.code, "last_member");
  j = await mcpLeave(h, "tok-Bea", { confirm: R, delete_room: true });
  assert.equal(j.result.structuredContent.room_deleted, true);
  assert.equal(h.room.exists(), false);
});

/* ---------- the review round: shared names, body caps, the refusals' details ---------- */

/** console.warn's lines while fn runs (warn() writes one JSON line each) */
async function warnsDuring(fn) {
  const real = console.warn;
  const lines = [];
  console.warn = (s) => { lines.push(String(s)); };
  try { await fn(); } finally { console.warn = real; }
  return lines;
}

// A room may still hold two active invites for one name, from before the
// name rules: "Ada" beside "ada" (one fold), or two names that lower-case
// alike and fold apart (U+03F9 and U+03F2). The claims, lobbies, picture,
// voice, push rows and hook the name holds are the other holder's too: A's
// leave touches none of them, and the Referee names nobody.
for (const [kind, A, B] of [["the same fold", "Ada", "ada"], ["the same lower case, folding apart", "Ϲx", "ϲx"]]) {
  test("a second active invite for the name (" + kind + "): the leave takes nothing that holder holds", async () => {
    const c = cartesia(() => new Response(null, { status: 200 }));
    try {
      const h = makeRoom();
      const ins = (tok, name) => { const at = Date.now() - 30 * 86400000; h.db.prepare("INSERT INTO inv (token, name, created, used, kind) VALUES (?, ?, ?, ?, 'agent')").run(tok, name, at, at); };
      ins("tA", A);
      ins("tB", B);
      h.member("Cy");
      const q = h.room.addQuestion("B's question", "Cy");
      h.room.updateQuestion(q.id, "claim", B, null);
      const lobby = (await h.room.createGame("Cy", ["Cy", B], { game: "duel" }, R)).game;
      assert.ok(await h.room.setAvatar(B, PNG, "image/png", R));
      const put = await h.room.putVoiceSample(B, MP3, "audio/mpeg", R);
      await h.room.setVoiceId(B, "cartesia", "v-B", put.gen, put.key);
      const keyB = B.toLowerCase(); // lowercase-ok: the push rows' key (nameKey)
      h.db.prepare("INSERT INTO push (member, endpoint, p256dh, auth, ts) VALUES (?, 'https://fcm.googleapis.com/fcm/send/b', 'k', 'a', ?)").run(keyB, Date.now());
      // B's hook, filed under the fold (for the first pair, A's fold too)
      h.db.prepare("INSERT INTO mh (member, name, room, link, routing, enabled, muted, created, updated, kind, url, secret) VALUES (?, ?, 'unit', '', '', 1, 0, ?, ?, 'webhook', 'https://agent.example.org/wake', 's')").run(nameFold(B), B, Date.now(), Date.now());
      const r = await h.room.leave("tA", R, false);
      await h.settled();
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.ok(h.one("SELECT revoked FROM inv WHERE token = 'tA'").revoked, "A left");
      assert.equal(h.one("SELECT revoked FROM inv WHERE token = 'tB'").revoked, null, "B is still in");
      assert.deepEqual({ ...h.one("SELECT status, claimed_by FROM oq WHERE id = ?", q.id) }, { status: "claimed", claimed_by: B }, "B's claim stays");
      assert.equal(h.room.gameRow(lobby.id).status, "lobby", "B's lobby still waits");
      assert.equal(h.one("SELECT COUNT(*) AS n FROM m WHERE sender = 'Referee'").n, 0, "no Referee line");
      assert.ok(h.one("SELECT avatar_key FROM inv WHERE token = 'tB'").avatar_key, "B's picture stays");
      assert.equal(h.room.voiceOf(B).voice_id, "v-B", "B's voice stays");
      assert.equal(h.one("SELECT COUNT(*) AS n FROM cfg WHERE k LIKE 'voice-del:%'").n, 0, "no clone queued for deletion");
      assert.deepEqual(c.calls, [], "nothing asked of Cartesia");
      assert.equal(h.one("SELECT COUNT(*) AS n FROM push WHERE member = ?", keyB).n, 1, "B's push row stays");
      assert.equal(h.one("SELECT COUNT(*) AS n FROM mh").n, 1, "B's hook stays");
      for (const k of [put.key]) assert.ok(h.objects.has(k), "B's sample object stays");
      assert.equal(r.clone, null);
    } finally { c.restore(); }
  });
}

/** a JSON body of about mb MiB (an object, then spaces), as a stream that counts what was read */
function bigBody(mb) {
  let pulled = 0, first = true;
  const stream = new ReadableStream({
    pull(ctl) {
      if (pulled >= mb * (1 << 20)) { ctl.enqueue(new TextEncoder().encode("}")); ctl.close(); return; }
      const b = new Uint8Array(1 << 20).fill(0x20);
      if (first) { b.set(new TextEncoder().encode("{\"confirm\": \"unit\"")); first = false; }
      pulled += b.byteLength;
      ctl.enqueue(b);
    },
  });
  return { stream, pulled: () => pulled };
}
import { museHookRoute } from "../../worker/routes/muse.ts";
import { webhookHookRoute } from "../../worker/routes/webhook.ts";
import { SMALL_BODY_MAX, REFUSED_DRAIN_MAX } from "../../worker/limits.ts";
// what a refused body may cost: the cap, what settleBody reads away past it
// so the 413 arrives (REFUSED_DRAIN_MAX), and the stream's 1 MiB chunks
// read ahead; well under the 40 MiB sent
const READ_MAX = SMALL_BODY_MAX + REFUSED_DRAIN_MAX + 3 * (1 << 20);

test("the leave looks the token up before it reads a body: a refused token gets its 403 unread, and a body over SMALL_BODY_MAX is 413", async () => {
  const h = makeRoom();
  h.member("Ada");
  h.member("Bea");
  for (const tok of ["not-a-token", "tok-gone"]) {
    if (tok === "tok-gone") { h.member("Gone"); h.room.revoke("tok-Gone"); }
    const b = bigBody(40);
    const url = new URL("http://localhost/api/rooms/unit/leave");
    const rc = { request: new Request(url, { method: "POST", body: b.stream, headers: { "Content-Type": "application/json" } }), env: { ROOM: { idFromName: (n) => n, get: () => stubOf(h) } }, url, path: url.pathname, owner: false, invite: tok === "tok-gone" ? "tok-Gone" : tok, ctx: { waitUntil() {} } };
    const r = await leaveRoute(rc, /^\/api\/rooms\/([^/]+)\/leave$/.exec(url.pathname));
    assert.equal(r.status, 403, tok);
    assert.ok(b.pulled() <= 2 * (1 << 20), tok + ": read " + b.pulled() + " bytes of a refused caller's body");
  }
  // a member's own body: at most SMALL_BODY_MAX
  const b = bigBody(40);
  const url = new URL("http://localhost/api/rooms/unit/leave");
  const rc = { request: new Request(url, { method: "POST", body: b.stream, headers: { "Content-Type": "application/json" } }), env: { ROOM: { idFromName: (n) => n, get: () => stubOf(h) } }, url, path: url.pathname, owner: false, invite: "tok-Ada", ctx: { waitUntil() {} } };
  const r = await leaveRoute(rc, /^\/api\/rooms\/([^/]+)\/leave$/.exec(url.pathname));
  assert.equal(r.status, 413);
  assert.ok(b.pulled() <= READ_MAX, "read " + b.pulled());
  assert.equal(inv(h, "Ada").revoked, null, "nothing changed");
  // the token's refusal comes before a body's: no confirm, a junk token -> 403, not 400
  assert.deepEqual([(await leave(h, "not-a-token", {})).status], [403]);
});

// The muse-hook and webhook POSTs read their few fields before the room has
// checked the token: at most SMALL_BODY_MAX now (413 past it), for any
// caller; a body within it is answered as before.
for (const [label, route, re, path] of [["muse-hook", museHookRoute, /^\/api\/rooms\/([^/]+)\/muse-hook\/?$/, "muse-hook"], ["webhook", webhookHookRoute, /^\/api\/rooms\/([^/]+)\/webhook\/?$/, "webhook"]]) {
  test("POST .../" + label + " reads at most SMALL_BODY_MAX of a body (413 past it), whatever the token", async () => {
    const h = makeRoom();
    h.member("Ada");
    for (const tok of ["not-a-token", "tok-Ada"]) {
      const b = bigBody(40);
      const url = new URL("http://localhost/api/rooms/unit/" + path);
      const rc = { request: new Request(url, { method: "POST", body: b.stream, headers: { "Content-Type": "application/json" } }), env: { ROOM: { idFromName: (n) => n, get: () => stubOf(h) } }, url, path: url.pathname, owner: false, invite: tok, ctx: { waitUntil() {} } };
      const r = await route(rc, re.exec(url.pathname));
      assert.equal(r.status, 413, label + " " + tok);
      assert.ok(b.pulled() <= READ_MAX, label + " " + tok + ": read " + b.pulled());
    }
    // a small body is answered as it was: a junk token's 403, and a member's 400 for an empty change
    const small = async (tok, body) => {
      const url = new URL("http://localhost/api/rooms/unit/" + path);
      const rc = { request: new Request(url, { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }), env: { ROOM: { idFromName: (n) => n, get: () => stubOf(h) } }, url, path: url.pathname, owner: false, invite: tok, ctx: { waitUntil() {} } };
      const r = await route(rc, re.exec(url.pathname));
      return { status: r.status, json: await r.json() };
    };
    assert.equal((await small("tok-Ada", {})).status, 400);
    assert.equal((await small("not-a-token", { muted: true })).status, 403);
  });
}

test("last_member's refusal carries unopened, the count of invites not yet opened, over REST and MCP", async () => {
  const h = makeRoom();
  h.member("Ada");
  unopened(h, "Cy");
  unopened(h, "Dee");
  const r = await leave(h, "tok-Ada", OK);
  assert.deepEqual(r.json, { error: r.json.error, code: "last_member", unopened: 2 });
  const j = await mcpLeave(h, "tok-Ada", OK);
  assert.deepEqual(j.result.structuredContent, { code: "last_member", unopened: 2 });
  const h2 = makeRoom();
  h2.member("Ada");
  assert.equal((await leave(h2, "tok-Ada", OK)).json.unopened, 0);
});

test("delete_room is the boolean true and nothing else: \"true\", 1 and \"yes\" are no yes, and change nothing", async () => {
  const h = makeRoom();
  h.member("Ada");
  for (const v of ["true", 1, "yes", "1", {}]) {
    const r = await leave(h, "tok-Ada", { confirm: R, delete_room: v });
    assert.deepEqual([r.status, r.json.code], [409, "last_member"], JSON.stringify(v));
    const j = await mcpLeave(h, "tok-Ada", { confirm: R, delete_room: v });
    assert.equal(j.result.structuredContent.code, "last_member", "MCP " + JSON.stringify(v));
  }
  assert.equal(inv(h, "Ada").revoked, null);
  assert.equal(h.room.exists(), true);
});

test("MCP leave_room answers the token's refusal before a wrong confirm, as every tool does", async () => {
  const h = makeRoom();
  h.member("Ada");
  h.member("Gone");
  h.room.revoke("tok-Gone");
  for (const [tok, code] of [["tok-Gone", "invite_revoked"], ["not-a-token", "invite_invalid"]]) {
    const j = await mcpLeave(h, tok, { confirm: "nope" });
    assert.deepEqual([j.error && j.error.code, j.error && j.error.data.code], [-32001, code], tok);
  }
});

import { LEFT_MSG } from "../../worker/room/Room.ts";
test("a token whose member left is refused with a sentence of its own, under 403 invite_revoked; an owner's revoke keeps its sentence", async () => {
  const h = makeRoom();
  h.member("Ada");
  h.member("Bea");
  h.member("Cut");
  h.room.revoke("tok-Cut");
  assert.equal((await leave(h, "tok-Ada", OK)).status, 200);
  const l = h.room.lookupInvite("tok-Ada");
  assert.deepEqual([l.ok, l.status, l.code, l.error], [false, 403, "invite_revoked", LEFT_MSG]);
  assert.equal(LEFT_MSG, "You left this room with this invite, so it will not work again. A member of the room can invite you anew.");
  assert.equal(h.room.lookupInvite("tok-Cut").error, "This invite link has been revoked. Ask whoever gave it to you for a new one.");
  // every surface says it: access (REST), the stream, MCP
  assert.equal(h.room.access("tok-Ada", false).error, LEFT_MSG);
  const s = await h.room.fetch(new Request("http://do/stream?room=unit&after=0", { headers: { "X-Invite-Token": "tok-Ada" } }));
  assert.deepEqual([s.status, (await s.json()).error], [403, LEFT_MSG]);
  const j = await mcpLeave(h, "tok-Ada", OK);
  assert.deepEqual([j.error.code, j.error.message, j.error.data.code], [-32001, LEFT_MSG, "invite_revoked"]);
});

test("after its waits the leave writes no rows in a room deleted meanwhile (its cached speak audio is left to the room's deletion)", async () => {
  let release, hold = false;
  const gate = new Promise((r) => { release = r; });
  const h = makeRoom({ before: async (op, key) => { if (hold && op === "delete" && String(key).includes("avatars/")) await gate; } });
  h.member("Ada");
  h.member("Bea");
  await h.room.setAvatar("Ada", PNG, "image/png", R);
  const put = await h.room.putVoiceSample("Ada", MP3, "audio/mpeg", R);
  await h.room.setVoiceId("Ada", "cartesia", "v-ada", put.gen, put.key);
  hold = true;
  let a, b;
  const lines = await warnsDuring(async () => {
    const pa = h.room.leave("tok-Ada", R, false);
    await new Promise((r) => setTimeout(r, 5));
    b = await h.room.leave("tok-Bea", R, true);
    release();
    a = await pa;
    await h.settled();
  });
  assert.equal(a.ok, true);
  assert.equal(b.room_deleted, true, "Bea was the last member then, and the room went");
  assert.ok(!lines.some((l) => l.includes("leave.speak") || l.includes("no such table")), "no write was tried in the deleted room: " + lines.join(" | "));
});

test("a room-deleting leave whose clone delete fails keeps the clone's pending record through the deletion", async () => {
  const c = cartesia(() => new Response("{}", { status: 500 }));
  try {
    const h = makeRoom();
    h.member("Ada");
    const put = await h.room.putVoiceSample("Ada", MP3, "audio/mpeg", R);
    await h.room.setVoiceId("Ada", "cartesia", "v-kept", put.gen, put.key);
    const r = await leave(h, "tok-Ada", { confirm: R, delete_room: true });
    assert.equal(r.json.room_deleted, true);
    assert.equal(h.room.exists(), false);
    assert.ok(c.calls.includes("DELETE https://api.cartesia.ai/voices/v-kept"), "Cartesia was asked");
    assert.deepEqual(h.all("SELECT k FROM cfg WHERE k LIKE 'voice-del:%'").map((x) => x.k), ["voice-del:v-kept"], "the record outlives the room, for a later try");
  } finally { c.restore(); }
});

test("two leaves at once: the room is deleted at most once, and never left with nobody in it", async () => {
  for (const del of [false, true]) {
    const logged = [];
    const h = makeRoom({ env: { REQUESTS: { put: async (k, v) => { logged.push(v); }, get: async () => null } } });
    h.member("Ada");
    h.member("Bea");
    await h.room.createGame("Bea", ["Bea", "Ada"], { game: "duel" }, R);
    const [a, b] = await Promise.all([h.room.leave("tok-Ada", R, del), h.room.leave("tok-Bea", R, del)]);
    await h.settled();
    const deletions = logged.filter((v) => /room deleted/.test(v)).length;
    if (del) {
      assert.deepEqual([a.ok, b.ok, a.room_deleted, b.room_deleted], [true, true, false, true], JSON.stringify([a, b]));
      assert.equal(deletions, 1);
      assert.equal(h.room.exists(), false);
    } else {
      assert.deepEqual([a.ok, b.code], [true, "last_member"], JSON.stringify([a, b]));
      assert.equal(deletions, 0);
      assert.equal(inv(h, "Bea").revoked, null, "Bea is still in: the room is not empty");
    }
  }
});

test("lobbies it created, or accepted without creating, wait on the others: only those waiting for its accept are declined", async () => {
  const h = makeRoom();
  h.member("Ada");
  h.member("Bea");
  h.member("Cy");
  const created = (await h.room.createGame("Ada", ["Ada", "Bea"], { game: "duel" }, R)).game;
  const accepted = (await h.room.createGame("Bea", ["Bea", "Ada", "Cy"], { game: "auction" }, R)).game;
  await h.room.gameAccept(accepted.id, "Ada", R);
  const waiting = (await h.room.createGame("Cy", ["Cy", "Ada"], { game: "duel" }, R)).game;
  assert.equal((await leave(h, "tok-Ada", OK)).status, 200);
  assert.deepEqual([created, accepted, waiting].map((g) => h.room.gameRow(g.id).status), ["lobby", "lobby", "cancelled"]);
});

test("a revoked older row of the same spelling loses its picture too (the clear reaches every row of the spelling), and stays as it was otherwise", async () => {
  const h = makeRoom();
  const at = Date.now() - 60 * 86400000;
  h.db.prepare("INSERT INTO inv (token, name, created, used, kind) VALUES ('tOld', 'ADA', ?, ?, 'agent')").run(at, at);
  await h.room.setAvatar("ADA", PNG, "image/png", R);
  const oldKey = h.one("SELECT avatar_key FROM inv WHERE token = 'tOld'").avatar_key;
  h.room.revoke("tOld");
  h.member("Ada");
  h.member("Bea");
  assert.equal((await leave(h, "tok-Ada", OK)).status, 200);
  const old = { ...h.one("SELECT avatar_key, left_ts, revoked FROM inv WHERE token = 'tOld'") };
  assert.equal(old.avatar_key, null);
  assert.ok(!h.objects.has(oldKey), "its object is deleted");
  assert.ok(old.revoked && old.left_ts === null, "it was revoked, not left: " + JSON.stringify(old));
});

import { speakRoute } from "../../worker/routes/voices.ts";
test("the speak route's answer for a voice changed mid-synthesis (served uncached) carries the CORS headers", async () => {
  const h = makeRoom();
  h.member("Ada");
  const put = await h.room.putVoiceSample("Ada", MP3, "audio/mpeg", R);
  await h.room.setVoiceId("Ada", "cartesia", "v-1", put.gen, put.key);
  const m = await h.room.post("Ada", "say this", R, false);
  const real = globalThis.fetch;
  // Cartesia speaks, and the voice changes while it does: the play is not cached
  globalThis.fetch = async () => { h.db.prepare("UPDATE mv SET voice_id = 'v-2'").run(); return new Response(MP3, { status: 200, headers: { "Content-Type": "audio/mpeg" } }); };
  try {
    const url = new URL("http://localhost/api/rooms/unit/messages/" + m.id + "/speak");
    const rc = { request: new Request(url), env: { ROOM: { idFromName: (n) => n, get: () => stubOf(h) }, CARTESIA_API_KEY: "test-key" }, url, path: url.pathname, owner: false, invite: "tok-Ada", ctx: { waitUntil() {} } };
    const r = await speakRoute(rc, /^\/api\/rooms\/([^/]+)\/messages\/(\d+)\/speak$/.exec(url.pathname));
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("Cache-Control"), "no-store", "the uncached answer");
    assert.equal(r.headers.get("Access-Control-Allow-Origin"), "*");
  } finally { globalThis.fetch = real; }
});
