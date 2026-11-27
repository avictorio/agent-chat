// POST /api/agent/rooms/leave (worker/routes/agent.ts agentLeaveRoute): the
// agent leaves one of its key's rooms for good, through its key, and the
// room comes off the key; it never deletes a room. Against a Room namespace
// of real Room objects reached through stubs that record each method asked
// (agent-world.mjs), with the Muse bridge in the process for the wakes the
// key set up (bridge-world.mjs) and Cartesia stood in for by a stub of
// fetch: the order of the refusals (none asks a room or writes), delete_room
// refused in every form, what a leave does in the room, the Muse wake off
// (in an older room whose two names fold alike too), a wake the key cannot
// confirm is off kept for a take-off, the last member and the protected
// room, a seat never opened, the key's list changed under the leave, a room
// deleted meanwhile, and waitUntil registered before the leave is asked.
// Run with `npm run test:unit`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeWorld, read, agentInvite } from "./agent-world.mjs";
import { bridgeWorld } from "./bridge-world.mjs";
import { agentCreateRoute, agentInviteAddRoute, agentLeaveRoute, agentMcpRoute, agentRemoveRoute, agentRoomsRoute, agentRoute } from "../../worker/routes/agent.ts";
import { AGENT_KEY_INVALID, AGENT_KEY_MISSING, LEAVE_NO_DELETE, NOT_AGENT_KEY, dropNote, leaveEntryRefused, leaveLastMember, leaveNote, leaveNotJoined, leaveRoomGone, removedRefusedNote } from "../../worker/agents/onboarding.ts";
import { leaveConfirmRefusal } from "../../worker/routes/members.ts";
import { AGENT_WAKE_SET_MS, AGENT_WAKE_SKEW_MS, PROTECTED_ROOMS, SMALL_BODY_MAX } from "../../worker/limits.ts";
import { agentCredential, agentUnseal, agentVerifier, newAgentKey } from "../../worker/lib/agentkey.ts";
import { BadRequest } from "../../worker/lib/http.ts";
import { LEFT_MSG } from "../../worker/room/Room.ts";

const auth = (key) => ({ Authorization: "Bearer " + key });
const call = (name, args) => ({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
const ROOM_RULE = "Room names are 1-64 lowercase letters, digits, - or _";
const MP3 = new Uint8Array([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0, 1, 2, 3, 4]).buffer;

/** rooms with the agent Hank on a key: joined unless open is false, with
 *  Bea, a person who has joined, beside it unless alone; muse: the bridge
 *  in the process and a gadget linked (code, link) */
async function keyed(names = ["lima"], o = {}) {
  const b = o.muse ? await bridgeWorld() : null;
  const w = makeWorld({ env: { ...(b ? b.env : {}), ...(o.env || {}) } });
  const tok = {};
  for (const n of names) {
    const h = w.room(n);
    tok[n] = agentInvite(h, "Hank");
    if (o.open !== false) h.room.access(tok[n], false);
    if (!o.alone) h.member("Bea", "human");
  }
  const r = await read(agentCreateRoute(w.rc("POST", "/api/agents", { json: { rooms: names.map((room) => ({ room, token: tok[room] })) }, headers: { "CF-Connecting-IP": "10.4.0.1" } })));
  assert.equal(r.status, 201, r.text);
  const g = b ? await b.connect() : {};
  return { b, w, tok, key: r.json.key, ...g, restore: () => b && b.restore() };
}
/** what a key's identity stores: its slot's kind and its list's entries, opened as the Worker opens it; null once nothing is stored */
async function storedOf(w, key) {
  const c = agentCredential(new Request("http://localhost/", { headers: auth(key) }));
  const h = w.harness("__agent-" + c.id);
  if (!h.one("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table'").n) return null;
  const a = h.one("SELECT ver, ring FROM ak"), slot = h.one("SELECT kind, wrapped FROM aks WHERE slot = 'key'");
  const u = await agentUnseal(c.id, c.secret, slot.wrapped, a.ver, a.ring);
  return { kind: slot.kind, rooms: u.rooms };
}
/** the key's identity object, on the harness */
const identityOf = (w, key) => w.harness("__agent-" + agentCredential(new Request("http://localhost/", { headers: auth(key) })).id).room;
/** POST /api/agent/rooms/leave: the answer, once the work it left to waitUntil is done, and what was asked meanwhile */
async function leave(w, key, json, o = {}) {
  const mark = w.asked.length;
  const init = o.method === "GET" ? { headers: o.headers || auth(key) } : { json, headers: o.headers || auth(key) };
  if (o.body !== undefined) { delete init.json; init.body = o.body; init.headers = { ...init.headers, "Content-Type": "application/json" }; }
  const r = await read(agentLeaveRoute(w.rc(o.method || "POST", "/api/agent/rooms/leave", init)));
  await Promise.all(w.pending.splice(0));
  return { ...r, asked: w.asked.slice(mark), mark };
}
const mcp = async (w, key, name, args) => (await read(agentMcpRoute(w.rc("POST", "/api/mcp", { json: call(name, args), headers: auth(key) })))).json;
/** the invite rows of a room, as they stand */
const rows = (h) => h.all("SELECT token, name, used, seen, revoked, left_ts FROM inv ORDER BY token").map((r) => ({ ...r }));
const hooksAll = (h) => h.all("SELECT member, kind, link FROM mh ORDER BY member").map((r) => ({ ...r }));
/** each room's clock past every deadline a registration so far gave */
const pastDeadlines = (w, ...rooms) => { for (const r of rooms) w.harness(r).room.museNow = () => Date.now() + AGENT_WAKE_SET_MS + AGENT_WAKE_SKEW_MS + 1000; };
/** Cartesia as a stub: every call answered ok, and listed */
function cartesia() {
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (!u.startsWith("https://api.cartesia.ai/")) return real(url, init);
    calls.push(((init && init.method) || "GET") + " " + u);
    return new Response(null, { status: 200 });
  };
  return { calls, restore: () => { globalThis.fetch = real; } };
}
const OK = { room: "lima", confirm: "lima" };

test("every refusal before the leave changes nothing and asks no room: the method, the key, the body, the room's name, delete_room in every form, confirm, a room not on the key, a room the key marks refused", async () => {
  const k = await keyed(["lima", "oslo"]);
  // oslo refused the key's invite since, and the key marks it so
  k.w.harness("oslo").room.revoke(k.tok.oslo);
  assert.equal((await mcp(k.w, k.key, "whoami", { room: "oslo" })).result.structuredContent.code, "invite_revoked");
  const before = await storedOf(k.w, k.key);
  assert.deepEqual(before.rooms.map((e) => [e.room, e.state, e.code]), [["lima", "held", undefined], ["oslo", "refused", "invite_revoked"]]);
  const inv = { lima: rows(k.w.harness("lima")), oslo: rows(k.w.harness("oslo")) };
  const cases = [
    ["GET", undefined, { method: "GET" }, 405, { error: "Method not allowed" }, false],
    ["no key", OK, { headers: {} }, 401, { error: AGENT_KEY_MISSING, code: "agent_key_missing" }, false],
    ["a room token", OK, { headers: auth(k.tok.lima) }, 403, { error: NOT_AGENT_KEY, code: "not_agent_key" }, false],
    ["a key that does not exist", OK, { headers: auth(newAgentKey().key) }, 403, { error: AGENT_KEY_INVALID, code: "agent_key_invalid" }, true],
    ["a body over SMALL_BODY_MAX", undefined, { body: JSON.stringify({ room: "lima", confirm: "lima", pad: "x".repeat(SMALL_BODY_MAX) }) }, 413, { error: "That request's body is too large: send {\"room\", \"confirm\"}." }, true],
    ["no room", { confirm: "lima" }, {}, 400, { error: ROOM_RULE }, true],
    ["a bad room name", { room: "Not A Room", confirm: "Not A Room" }, {}, 400, { error: ROOM_RULE }, true],
    ["delete_room false", { ...OK, delete_room: false }, {}, 400, { error: LEAVE_NO_DELETE, room: "lima" }, true],
    ["delete_room null", { ...OK, delete_room: null }, {}, 400, { error: LEAVE_NO_DELETE, room: "lima" }, true],
    ["delete_room \"true\"", { ...OK, delete_room: "true" }, {}, 400, { error: LEAVE_NO_DELETE, room: "lima" }, true],
    ["delete_room 0", { ...OK, delete_room: 0 }, {}, 400, { error: LEAVE_NO_DELETE, room: "lima" }, true],
    ["delete_room true", { ...OK, delete_room: true }, {}, 400, { error: LEAVE_NO_DELETE, room: "lima" }, true],
    ["no confirm", { room: "lima" }, {}, 400, { error: leaveConfirmRefusal("lima"), code: "confirm_mismatch", room: "lima" }, true],
    ["confirm naming another room", { room: "lima", confirm: "oslo" }, {}, 400, { error: leaveConfirmRefusal("lima"), code: "confirm_mismatch", room: "lima" }, true],
    ["confirm in capitals", { room: "LIMA", confirm: "LIMA" }, {}, 400, { error: leaveConfirmRefusal("lima"), code: "confirm_mismatch", room: "lima" }, true],
    ["confirm not text", { room: "lima", confirm: { room: "lima" } }, {}, 400, { error: "\"confirm\" must be text", room: "lima" }, true],
    ["a room not on the key", { room: "rome", confirm: "rome" }, {}, 404, { error: "rome is not on this key.", code: "room_not_held", room: "rome" }, 2],
    ["a room the key marks refused", { room: "oslo", confirm: "oslo" }, {}, 403, { error: leaveEntryRefused("oslo", "invite_revoked"), code: "invite_revoked", room: "oslo" }, 2],
  ];
  for (const [what, body, o, status, answer, opens] of cases) {
    const r = await leave(k.w, k.key, body, o);
    assert.deepEqual([r.status, r.json], [status, answer], what);
    // the key's own object at most, opened once before the body and once again once it is in: no room asked, nothing written
    assert.deepEqual(r.asked.map((a) => a.method), Array(Number(opens)).fill("agentOpen"), what + ": " + r.asked.map((a) => a.name + "." + a.method));
    assert.ok(r.asked.every((a) => a.name.startsWith("__agent-")), what);
  }
  // a body that is not JSON: the field readers' BadRequest (index.ts answers 400), before any room
  const mark = k.w.asked.length;
  await assert.rejects(agentLeaveRoute(k.w.rc("POST", "/api/agent/rooms/leave", { body: "{nope", headers: { ...auth(k.key), "Content-Type": "application/json" } })), BadRequest);
  assert.ok(k.w.asked.slice(mark).every((a) => a.name.startsWith("__agent-")));
  assert.deepEqual(await storedOf(k.w, k.key), before, "the key's list as it was");
  assert.deepEqual({ lima: rows(k.w.harness("lima")), oslo: rows(k.w.harness("oslo")) }, inv, "every seat as it was");
  assert.equal(k.w.harness("lima").room.ready, true, "the room is there");
});

test("a leave through the key: the seat revoked with left set, its lobbies called off (one it was invited to and had not accepted included), its claims released, its clone delete asked, its Muse wake off and the room off the key; no access(), no token in the answer; another key on the same seat finds it refused at its next call", async () => {
  const c = cartesia();
  const k = await keyed(["lima", "oslo"], { muse: true, env: { CARTESIA_API_KEY: "test-key" } });
  try {
    const h = k.w.harness("lima");
    h.member("Cy", "human");
    // another key that holds the same seat
    const k2 = (await read(agentCreateRoute(k.w.rc("POST", "/api/agents", { json: { rooms: [{ room: "lima", token: k.tok.lima }] }, headers: { "CF-Connecting-IP": "10.4.0.2" } })))).json.key;
    assert.equal((await mcp(k.w, k.key, "muse_register", { code: k.code, rooms: ["lima"] })).result.structuredContent.results[0].ok, true);
    assert.deepEqual(hooksAll(h), [{ member: "hank", kind: "muse", link: k.link }]);
    const put = await h.room.putVoiceSample("Hank", MP3, "audio/mpeg", "lima");
    await h.room.setVoiceId("Hank", "cartesia", "v-hank", put.gen, put.key);
    const q = h.room.addQuestion("Which day?", "Bea");
    h.room.updateQuestion(q.id, "claim", "Hank", null);
    const invited = (await h.room.createGame("Bea", ["Bea", "Hank"], { game: "duel" }, "lima")).game;
    const created = (await h.room.createGame("Hank", ["Bea", "Cy"], { game: "duel" }, "lima")).game;
    const seen = h.one("SELECT seen FROM inv WHERE token = ?", k.tok.lima).seen;
    const r = await leave(k.w, k.key, OK);
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(Object.keys(r.json), ["room", "name", "left", "room_deleted", "off_key", "note"]);
    assert.deepEqual({ ...r.json, left: typeof r.json.left }, { room: "lima", name: "Hank", left: "number", room_deleted: false, off_key: true, note: leaveNote("Hank", "lima", "off") });
    assert.ok(!r.text.includes(k.tok.lima) && !r.text.includes(k.link), "no token or link in the answer");
    // the room: the seat left (revoked, left set to one time), nothing opened or marked seen
    const row = h.one("SELECT used, seen, revoked, left_ts FROM inv WHERE token = ?", k.tok.lima);
    assert.equal(row.left_ts, r.json.left);
    assert.equal(row.revoked, r.json.left);
    assert.equal(row.seen, seen, "not marked seen");
    assert.ok(!r.asked.some((a) => a.method === "access"), "no access(): " + r.asked.map((a) => a.method));
    assert.equal(h.room.gameRow(invited.id).status, "cancelled", "the lobby it was invited to and had not accepted is called off");
    assert.equal(h.room.gameRow(created.id).status, "cancelled", "the lobby it created without a seat is called off");
    assert.deepEqual({ ...h.one("SELECT status, claimed_by FROM oq WHERE id = ?", q.id) }, { status: "open", claimed_by: null }, "its claim released");
    assert.equal(h.one("SELECT COUNT(*) AS n FROM mv WHERE name = 'hank'").n, 0, "its voice row goes");
    assert.deepEqual(c.calls, ["DELETE https://api.cartesia.ai/voices/v-hank"], "its clone delete asked (leaveAfter)");
    assert.deepEqual(hooksAll(h), [], "its Muse wake is off");
    await h.settled();
    assert.equal(await k.b.rooms(k.link), 0, "the bridge counts no room for the link");
    // the key: lima off, oslo as it was
    const after = await storedOf(k.w, k.key);
    assert.deepEqual(after.rooms.map((e) => [e.room, e.state]), [["oslo", "held"]]);
    assert.deepEqual((await read(agentRoute(k.w.rc("GET", "/api/agent", { headers: auth(k.key) })))).json.rooms.map((e) => e.room), ["oslo"]);
    // the other key's next call there is refused, and it marks the room
    const other = await mcp(k.w, k2, "whoami", { room: "lima" });
    assert.equal(other.result.isError, true);
    assert.deepEqual(other.result.structuredContent, { code: "invite_revoked", room: "lima" });
    assert.equal(other.result.content[0].text, "Room \"lima\": " + LEFT_MSG);
    assert.deepEqual((await storedOf(k.w, k2)).rooms.map((e) => [e.room, e.state, e.code]), [["lima", "refused", "invite_revoked"]]);
  } finally {
    c.restore();
    k.restore();
  }
});

test("the leave is registered with waitUntil before the room is asked to leave, and the room is asked with false", async () => {
  const k = await keyed();
  const r = await leave(k.w, k.key, OK);
  assert.equal(r.status, 200);
  const at = k.w.asked.findIndex((a, i) => i >= r.mark && a.method === "leave");
  assert.ok(at >= 0, "the room was asked to leave");
  assert.deepEqual(k.w.asked[at].args, [k.tok.lima, "lima", false], "the literal false");
  assert.ok(k.w.waits.some((x) => x >= r.mark && x <= at), "waitUntil before the leave: " + JSON.stringify({ waits: k.w.waits, at }));
});

/** lima holds Hank and an active "hank" besides: one hook, filed under the folded name, the key's link on it */
async function sharedName() {
  const k = await keyed(["lima"], { muse: true });
  const h = k.w.harness("lima");
  const now = Date.now();
  h.db.prepare("INSERT INTO inv (token, name, created, kind, used, seen) VALUES ('tok-hank-lower-0000000', 'hank', ?, 'agent', ?, ?)").run(now - 3000, now - 2000, now - 2000);
  assert.equal((await mcp(k.w, k.key, "muse_register", { code: k.code, rooms: ["lima"] })).result.structuredContent.results[0].ok, true);
  return { k, h };
}

test("in an older room where two active invites' names fold alike, the leave keeps the name's hook: the key's wake is turned off through the seat that left; the other invite's own hook stays", async () => {
  // the key's wake is the hook: the leave keeps it, the write after it takes it off
  {
    const { k, h } = await sharedName();
    try {
      const r = await leave(k.w, k.key, OK);
      assert.deepEqual([r.status, r.json.off_key, r.json.note], [200, true, leaveNote("Hank", "lima", "off")]);
      assert.deepEqual(r.asked.filter((a) => a.name === "lima").map((a) => a.method), ["leave", "museHookLook", "museDropLook"]);
      assert.deepEqual(hooksAll(h), [], "the key's wake is off");
      assert.deepEqual((await storedOf(k.w, k.key)).rooms, []);
    } finally {
      k.restore();
    }
  }
  // the other invite set its own hook since, on another gadget's link: it stays
  {
    const { k, h } = await sharedName();
    try {
      const g2 = await k.b.connect();
      const s = h.room.museSetHookLook("tok-hank-lower-0000000", g2.link, "main", "lima", Date.now() + AGENT_WAKE_SET_MS);
      assert.equal(s.ok, true);
      const r = await leave(k.w, k.key, OK);
      assert.deepEqual([r.status, r.json.off_key], [200, true]);
      assert.deepEqual(r.asked.filter((a) => a.name === "lima").map((a) => a.method), ["leave", "museHookLook"], "nothing dropped");
      assert.deepEqual(hooksAll(h), [{ member: "hank", kind: "muse", link: g2.link }], "the other invite's own hook is untouched");
      assert.deepEqual((await storedOf(k.w, k.key)).rooms, []);
    } finally {
      k.restore();
    }
  }
});

/** a registration whose Worker stops right after the room's ok, before its own write: its recording stays outstanding */
async function stoppedAfterSet(k, args) {
  const obj = identityOf(k.w, k.key), real = obj.agentSwap.bind(obj);
  let swaps = 0;
  obj.agentSwap = (...a) => { if (++swaps === 2) throw new Error("the Worker stopped"); return real(...a); };
  try {
    await assert.rejects(read(agentMcpRoute(k.w.rc("POST", "/api/mcp", { json: call("muse_register", { code: k.code, ...args }), headers: auth(k.key) }))), /the Worker stopped/);
  } finally {
    delete obj.agentSwap;
  }
}

test("a wake the key cannot confirm is off (the room not reached for it, or a registration's set that may still reach the room) keeps the entry, marked left with its link; a later take-off settles it", async () => {
  for (const how of ["not reached", "a set may still arrive"]) {
    const { k, h } = how === "not reached" ? await sharedName() : await (async () => {
      const kk = await keyed(["lima"], { muse: true });
      await stoppedAfterSet(kk, { rooms: ["lima"] });
      return { k: kk, h: kk.w.harness("lima") };
    })();
    try {
      if (how === "not reached") h.room.museHookLook = () => { throw new Error("the room did not answer"); };
      const r = await leave(k.w, k.key, OK);
      assert.equal(r.status, 200, how + ": " + r.text);
      assert.deepEqual([r.json.off_key, r.json.kept, r.json.note], [false, "marked_wake", leaveNote("Hank", "lima", "marked_wake")], how);
      assert.equal(h.one("SELECT left_ts FROM inv WHERE token = ?", k.tok.lima).left_ts, r.json.left, how + ": the seat left all the same");
      const kept = (await storedOf(k.w, k.key)).rooms;
      assert.deepEqual(kept.map((e) => [e.room, e.state, e.code, (e.hooks || []).map((x) => x.link)]), [["lima", "refused", "invite_revoked", [k.link]]], how + ": marked left, its link kept");
      assert.deepEqual(r.asked.filter((a) => a.name === "lima").map((a) => a.method).filter((m) => m === "museDropLook"), [], how + ": nothing dropped");
      // later: the room answers, the set's deadline has passed by its clock
      delete h.room.museHookLook;
      pastDeadlines(k.w, "lima");
      const t = await read(agentRemoveRoute(k.w.rc("POST", "/api/agent/rooms/remove", { json: { room: "lima" }, headers: auth(k.key) })));
      assert.deepEqual(t.json, { room: "lima", removed: true, muse_wake_removed: true, note: removedRefusedNote("lima", true) }, how);
      assert.deepEqual(hooksAll(h), [], how + ": the wake is off");
      assert.deepEqual((await storedOf(k.w, k.key)).rooms, [], how);
    } finally {
      k.restore();
    }
  }
});

test("the last member who has joined is refused (409 last_member, unopened carried) and the room is intact; a protected room's last member leaves and the room stays", async () => {
  for (const unopened of [0, 1, 2]) {
    const k = await keyed(["lima"], { alone: true });
    const h = k.w.harness("lima");
    for (let i = 0; i < unopened; i++) agentInvite(h, "Zed" + i);
    const before = { inv: rows(h), key: await storedOf(k.w, k.key) };
    const r = await leave(k.w, k.key, OK);
    assert.deepEqual([r.status, r.json], [409, { error: leaveLastMember("Hank", "lima", unopened), code: "last_member", room: "lima", unopened }], String(unopened));
    assert.deepEqual(r.asked.filter((a) => a.name === "lima").map((a) => a.method), ["leave"]);
    assert.equal(h.room.ready, true, "the room is there");
    assert.deepEqual({ inv: rows(h), key: await storedOf(k.w, k.key) }, before, "nothing changed, nothing marked");
  }
  assert.match(leaveLastMember("Hank", "lima", 1), /, and the invite not yet opened would stop working\./);
  assert.match(leaveLastMember("Hank", "lima", 2), /, and the 2 invites not yet opened would stop working\./);
  assert.doesNotMatch(leaveLastMember("Hank", "lima", 0), /not yet opened/);
  const P = PROTECTED_ROOMS[0];
  const k = await keyed([P], { alone: true });
  const h = k.w.harness(P);
  agentInvite(h, "Zed");
  const r = await leave(k.w, k.key, { room: P, confirm: P });
  assert.deepEqual([r.status, r.json.room_deleted, r.json.off_key], [200, false, true]);
  assert.equal(h.room.ready, true, "a protected room stays");
  assert.equal(h.one("SELECT COUNT(*) AS n FROM inv WHERE revoked IS NULL").n, 1, "its unopened invite stays");
});

test("a seat never opened is refused (409 not_joined) and stays unopened: nothing is marked used or seen, and the key keeps it", async () => {
  const k = await keyed(["lima"], { open: false });
  const h = k.w.harness("lima");
  const before = { inv: rows(h), key: await storedOf(k.w, k.key) };
  const r = await leave(k.w, k.key, OK);
  assert.deepEqual([r.status, r.json], [409, { error: leaveNotJoined("Hank", "lima"), code: "not_joined", room: "lima" }]);
  assert.equal(h.one("SELECT used FROM inv WHERE token = ?", k.tok.lima).used, null, "still unopened");
  assert.deepEqual({ inv: rows(h), key: await storedOf(k.w, k.key) }, before);
  assert.ok(!r.asked.some((a) => a.method === "access"));
});

test("a refusal of the seat's token (revoked, left with the room's own token, none of the room's) is the room's code and sentence after the room's name, and marks the entry; nothing else changes", async () => {
  const ways = {
    revoked: (k, h) => h.room.revoke(k.tok.lima),
    left: async (k, h) => assert.equal((await h.room.leave(k.tok.lima, "lima", false)).ok, true),
    "none of the room's": (k, h) => h.db.prepare("DELETE FROM inv WHERE token = ?").run(k.tok.lima),
  };
  const said = {
    revoked: [403, "invite_revoked", "This invite link has been revoked. Ask whoever gave it to you for a new one."],
    left: [403, "invite_revoked", LEFT_MSG],
    "none of the room's": [403, "invite_invalid", "This invite link isn't valid for this room."],
  };
  for (const [how, make] of Object.entries(ways)) {
    const k = await keyed();
    const h = k.w.harness("lima");
    await make(k, h);
    const inv = rows(h);
    const [status, code, sentence] = said[how];
    const r = await leave(k.w, k.key, OK);
    assert.deepEqual([r.status, r.json], [status, { error: "Room \"lima\": " + sentence, code, room: "lima" }], how);
    assert.deepEqual((await storedOf(k.w, k.key)).rooms.map((e) => [e.room, e.state, e.code]), [["lima", "refused", code]], how + ": marked");
    assert.deepEqual(rows(h), inv, how + ": the room as it was");
  }
});

test("a room deleted meanwhile: 410 room_deleted, the entry marked; asked again, the key answers from its record and asks no room", async () => {
  const k = await keyed();
  // deleted as the owner deletes a room: every invite revoked, then the room
  const h = k.w.harness("lima");
  await h.room.revokeAll();
  assert.deepEqual(await h.room.destroy("lima", "deleted for the test"), { deleted: true });
  const r = await leave(k.w, k.key, OK);
  assert.deepEqual([r.status, r.json], [410, { error: leaveRoomGone("lima"), code: "room_deleted", room: "lima" }]);
  assert.deepEqual((await storedOf(k.w, k.key)).rooms.map((e) => [e.room, e.state, e.code]), [["lima", "refused", "room_deleted"]]);
  const again = await leave(k.w, k.key, OK);
  assert.deepEqual([again.status, again.json], [410, { error: leaveEntryRefused("lima", "room_deleted"), code: "room_deleted", room: "lima" }]);
  assert.ok(again.asked.every((a) => a.name.startsWith("__agent-")), "no room asked");
});

test("the key's list changed while the room was leaving: a disconnect, a take-off, the room put back with another invite, the writes failing: the leave answers what the key holds, truly", async () => {
  /** lima's leave runs race once the room has left, before the key's list is written */
  const racing = (k, race) => {
    const h = k.w.harness("lima"), real = h.room.leave.bind(h.room);
    h.room.leave = async (...a) => { const r = await real(...a); await race(); return r; };
  };
  // a disconnect
  {
    const k = await keyed(["lima", "oslo"]);
    let d = null;
    racing(k, async () => { d = await read(agentRoute(k.w.rc("DELETE", "/api/agent", { headers: auth(k.key) }))); });
    const r = await leave(k.w, k.key, OK);
    assert.deepEqual([r.status, r.json.off_key, r.json.kept, r.json.note], [200, false, "cut", leaveNote("Hank", "lima", "cut")]);
    assert.deepEqual(d.json, { deleted: true, rooms: ["lima", "oslo"], muse_wakes_removed: [], muse_wakes_left: [], note: dropNote([]) });
    assert.equal(await storedOf(k.w, k.key), null, "the key is gone");
  }
  // a take-off
  {
    const k = await keyed(["lima", "oslo"]);
    racing(k, async () => { assert.equal((await read(agentRemoveRoute(k.w.rc("POST", "/api/agent/rooms/remove", { json: { room: "lima" }, headers: auth(k.key) })))).status, 200); });
    const r = await leave(k.w, k.key, OK);
    assert.deepEqual([r.status, r.json.off_key, r.json.note], [200, true, leaveNote("Hank", "lima", "off")]);
    assert.ok(!("kept" in r.json), "no kept when the room is off the key");
    assert.deepEqual((await storedOf(k.w, k.key)).rooms.map((e) => e.room), ["oslo"]);
  }
  // taken off and put back with another invite
  {
    const k = await keyed(["lima", "oslo"]);
    const other = agentInvite(k.w.harness("lima"), "Hank2");
    racing(k, async () => {
      assert.equal((await read(agentRemoveRoute(k.w.rc("POST", "/api/agent/rooms/remove", { json: { room: "lima" }, headers: auth(k.key) })))).status, 200);
      assert.equal((await read(agentRoomsRoute(k.w.rc("POST", "/api/agent/rooms", { json: { rooms: [{ room: "lima", token: other }] }, headers: auth(k.key) })))).status, 201);
    });
    const r = await leave(k.w, k.key, OK);
    assert.deepEqual([r.status, r.json.off_key, r.json.kept, r.json.note], [200, false, "other", leaveNote("Hank", "lima", "other")]);
    const kept = (await storedOf(k.w, k.key)).rooms.find((e) => e.room === "lima");
    assert.deepEqual([kept.token === other, kept.state, kept.name], [true, "held", "Hank2"], "the new seat is left alone");
  }
  // the key's writes: the take-off's write never goes through, then the mark does; or neither; or the key's object throws
  for (const [what, swap, kept, state] of [
    ["the list moves under every take-off write, then the mark goes through", (n) => (n <= 3 ? { ok: false, code: "stale" } : null), "marked", "refused"],
    ["the list moves under every write", () => ({ ok: false, code: "stale" }), "listed", "held"],
    ["the key's object throws", () => { throw new Error("the object is down"); }, "listed", "held"],
  ]) {
    const k = await keyed(["lima", "oslo"]);
    const obj = identityOf(k.w, k.key), real = obj.agentSwap.bind(obj);
    let n = 0;
    obj.agentSwap = (...a) => swap(++n) || real(...a);
    const r = await leave(k.w, k.key, OK);
    delete obj.agentSwap;
    assert.deepEqual([r.status, r.json.off_key, r.json.kept, r.json.note], [200, false, kept, leaveNote("Hank", "lima", kept)], what);
    assert.deepEqual(Object.keys(r.json), ["room", "name", "left", "room_deleted", "off_key", "kept", "note"], what);
    assert.deepEqual((await storedOf(k.w, k.key)).rooms.map((e) => [e.room, e.state]), [["lima", state], ["oslo", "held"]], what);
    assert.equal(k.w.harness("lima").one("SELECT left_ts FROM inv WHERE token = ?", k.tok.lima).left_ts, r.json.left, what + ": the seat left");
  }
  // a note that says the key's next call marks it: it does
  {
    const k = await keyed(["lima", "oslo"]);
    const obj = identityOf(k.w, k.key), real = obj.agentSwap.bind(obj);
    obj.agentSwap = () => ({ ok: false, code: "stale" });
    await leave(k.w, k.key, OK);
    obj.agentSwap = real;
    assert.equal((await mcp(k.w, k.key, "whoami", { room: "lima" })).result.structuredContent.code, "invite_revoked");
    assert.deepEqual((await storedOf(k.w, k.key)).rooms.map((e) => [e.room, e.state, e.code]), [["lima", "refused", "invite_revoked"], ["oslo", "held", undefined]]);
  }
});

/** a request to a key route whose body arrives only when release() is called */
function heldBody(w, key, path, json) {
  let release = () => {};
  const gate = new Promise((r) => { release = r; });
  const body = new ReadableStream({ start(c) { gate.then(() => { c.enqueue(new TextEncoder().encode(JSON.stringify(json))); c.close(); }); } });
  const rc = w.rc("POST", path, { headers: auth(key) });
  rc.request = new Request(rc.url, { method: "POST", headers: { ...auth(key), "Content-Type": "application/json" }, body, duplex: "half" });
  return { rc, release };
}

// A client can hold a request's body back for as long as the platform lets it. Every REST route
// of the key that takes a body opens the key again once the body is in: a key disconnected
// meanwhile acts nowhere, as at the key's MCP address. For each, the sequence: the request opens the
// key and waits for its body; DELETE /api/agent disconnects the key (and answers that every seat
// stays); the body arrives: agent_key_invalid, nothing asked of any room, nothing changed.
test("a body held back past the key's disconnect acts nowhere, on each of the four routes of the key that take a body: agent_key_invalid, no room asked, nothing changed", async () => {
  const routes = {
    "POST /api/agent/rooms/leave": [agentLeaveRoute, "/api/agent/rooms/leave", () => ({ room: "lima", confirm: "lima" })],
    "POST /api/agent/rooms/remove": [agentRemoveRoute, "/api/agent/rooms/remove", () => ({ room: "lima" })],
    "POST /api/agent/rooms": [agentRoomsRoute, "/api/agent/rooms", (k) => ({ rooms: [{ room: "oslo", token: agentInvite(k.w.room("oslo"), "Hank") }] })],
    "POST /api/agent/rooms/invite": [agentInviteAddRoute, "/api/agent/rooms/invite", (k) => { const h = k.w.room("rome"); h.member("Pat", "human"); return { name: "Hank", rooms: [{ room: "rome", inviter_token: "tok-Pat" }] }; }],
  };
  for (const [what, [route, path, body]] of Object.entries(routes)) {
    const k = await keyed();
    const json = body(k);
    const rows0 = Object.fromEntries(["lima", "oslo", "rome"].filter((n) => k.w.objects.has(n)).map((n) => [n, rows(k.w.harness(n))]));
    const { rc, release } = heldBody(k.w, k.key, path, json);
    const p = read(route(rc));
    await new Promise((r) => setTimeout(r, 20)); // the route has opened the key and waits for the body
    const d = await read(agentRoute(k.w.rc("DELETE", "/api/agent", { headers: auth(k.key) })));
    assert.deepEqual([d.status, d.json.note], [200, dropNote([])], what + ": the disconnect answers that every seat stays");
    const mark = k.w.asked.length;
    release();
    const r = await p;
    await Promise.all(k.w.pending.splice(0));
    assert.deepEqual([r.status, r.json], [403, { error: AGENT_KEY_INVALID, code: "agent_key_invalid" }], what + ": " + r.text);
    assert.deepEqual(k.w.asked.slice(mark).map((a) => a.method), ["agentOpen"], what + ": once the body is in, only the key's open, refused: " + k.w.asked.slice(mark).map((a) => a.name + "." + a.method));
    const rows1 = Object.fromEntries(Object.keys(rows0).map((n) => [n, rows(k.w.harness(n))]));
    assert.deepEqual(rows1, rows0, what + ": every room's invites as they were (no seat left, no invite made)");
  }
});

// A wake the key cannot confirm is off, on an entry another call marked refused meanwhile with a
// code of its own (the room deleted, say): the leave's mark keeps that code.
test("the leave's mark keeps a code another call marked the entry with meanwhile", async () => {
  const k = await keyed(["lima"], { muse: true });
  try {
    await stoppedAfterSet(k, { rooms: ["lima"] });
    const h = k.w.harness("lima"), real = h.room.leave.bind(h.room);
    const obj = identityOf(k.w, k.key), swap = obj.agentSwap.bind(obj);
    // once the room has left, another call marks the entry room_deleted
    h.room.leave = async (...a) => {
      const r = await real(...a);
      const c = agentCredential(new Request("http://localhost/", { headers: auth(k.key) }));
      const ak = k.w.harness("__agent-" + c.id).one("SELECT ver, ring FROM ak"), slot = k.w.harness("__agent-" + c.id).one("SELECT wrapped FROM aks WHERE slot = 'key'");
      const u = await agentUnseal(c.id, c.secret, slot.wrapped, ak.ver, ak.ring);
      const { agentSealRing } = await import("../../worker/lib/agentkey.ts");
      const rooms = u.rooms.map((e) => ({ ...e, state: "refused", code: "room_deleted", at: 1 }));
      assert.deepEqual(await swap("key", await agentVerifier(c.id, c.secret), ak.ver, await agentSealRing(u.dk, c.id, ak.ver + 1, rooms)), { ok: true });
      return r;
    };
    const r = await leave(k.w, k.key, OK);
    assert.deepEqual([r.status, r.json.off_key, r.json.kept], [200, false, "marked_wake"], r.text);
    assert.deepEqual((await storedOf(k.w, k.key)).rooms.map((e) => [e.room, e.state, e.code]), [["lima", "refused", "room_deleted"]], "its code kept, not replaced by invite_revoked");
  } finally {
    k.restore();
  }
});

// What the served reference says of a leave through the key: room_not_held only once the room is
// off the key, kept and its five values, and the key opened again once the body is in.
import { docs } from "../../worker/agents/docs.ts";
test("/api says a room left through the key answers room_not_held only once it is off the key, names kept's values, and that a key disconnected while a body was held back acts nowhere", () => {
  const api = docs("https://example.test").replace(/\s+/g, " ");
  assert.ok(api.includes("Once a room your person had you leave this way is off your key, a later call there answers room_not_held; while the key still lists it, a call there answers as in a room you left (invite_revoked)."), "room_not_held only once it is off the key");
  for (const v of ["\"marked\"", "\"marked_wake\"", "\"listed\"", "\"cut\"", "\"other\""]) assert.ok(api.includes(v + " ("), "kept " + v);
  assert.ok(api.includes("so a key disconnected while a request held its body back acts nowhere (403 agent_key_invalid)"));
  assert.ok(api.includes("the key forgets the room (it does not leave it: a seat you still hold there stays)"));
});
