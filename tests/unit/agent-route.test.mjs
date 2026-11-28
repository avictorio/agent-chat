// The agent key's REST routes (worker/routes/agent.ts) against a Room
// namespace whose every object is the real Room class on node:sqlite,
// reached through stubs that record each method asked (agent-world.mjs):
// creation's order (the shapes before any object, every room's look before
// the caps, so a refused room counts nothing anywhere and a caller learns
// no other room's count), the caps' keys and windows, the key check of every /api/agent* route, adding rooms (held,
// over the most, a refused one replaced, stale swaps read again), removing
// one and disconnecting. Keys and tokens are made here. Run with
// `npm run test:unit`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeWorld, read, agentInvite } from "./agent-world.mjs";
import { agentCreateRoute, agentLeaveRoute, agentRemoveRoute, agentRoomsRoute, agentRoute } from "../../worker/routes/agent.ts";
import { AGENT_KEY_INVALID, AGENT_KEY_MISSING, NOT_AGENT_KEY, agentKeyNote } from "../../worker/agents/onboarding.ts";
import { AGENT_KEYS_PER_DAY, AGENT_KEYS_PER_IP, AGENT_KEYS_PER_ROOM_DAY, AGENT_KEYS_WINDOW_S, AGENT_QUOTA_ROOM, AGENT_ROOMS_MAX } from "../../worker/limits.ts";
import { hashKey, networkKey } from "../../worker/lib/address.ts";
import { newAgentKey } from "../../worker/lib/agentkey.ts";

const IP = "10.1.2.3";
/** a world with rooms, each with an agent invite "Hank" (and a person "Pat"): the tokens by room */
function rooms(names, w = makeWorld()) {
  const tok = {}, pat = {};
  for (const n of names) { const h = w.room(n); tok[n] = agentInvite(h, "Hank"); pat[n] = agentInvite(h, "Pat", "human"); }
  return { w, tok, pat };
}
const create = (w, body, ip = IP) => read(agentCreateRoute(w.rc("POST", "/api/agents", { json: body, headers: { "CF-Connecting-IP": ip } })));
const bearer = (key) => ({ Authorization: "Bearer " + key });
/** a key holding these rooms: its text */
async function keyFor(w, tok, names) {
  const r = await create(w, { rooms: names.map((room) => ({ room, token: tok[room] })) });
  assert.equal(r.status, 201, r.text);
  return r.json.key;
}

test("POST /api/agents makes a key: the answer's fields, the key once, nothing joined", async () => {
  const { w, tok } = rooms(["lima", "oslo"]);
  const r = await create(w, { rooms: [{ room: "lima", token: tok.lima }, { room: " OSLO ", token: " " + tok.oslo + " " }] });
  assert.equal(r.status, 201);
  assert.equal(r.headers.get("Cache-Control"), "no-store");
  assert.equal(r.headers.get("Access-Control-Allow-Origin"), "*");
  assert.deepEqual(Object.keys(r.json), ["key", "address", "rooms", "max_rooms", "claude_code", "note"]);
  assert.match(r.json.key, /^\.ac1\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/);
  assert.equal(r.json.address, "http://localhost/api/mcp");
  assert.deepEqual(r.json.rooms, [{ room: "lima", name: "Hank", opened: false }, { room: "oslo", name: "Hank", opened: false }]);
  assert.equal(r.json.max_rooms, AGENT_ROOMS_MAX);
  assert.equal(r.json.claude_code, "claude mcp add --transport http agent-chat http://localhost/api/mcp --header \"Authorization: Bearer KEY\"");
  assert.equal(r.json.note, agentKeyNote("http://localhost"));
  assert.equal(r.text.split(r.json.key).length, 2, "the key appears once");
  for (const t of Object.values(tok)) assert.ok(!r.text.includes(t), "no room token in the answer");
  for (const n of ["lima", "oslo"]) {
    assert.equal(w.harness(n).one("SELECT used FROM inv WHERE name = 'Hank'").used, null, n + ": the invite stays unopened");
    assert.deepEqual(w.methods(n), ["lookupInvite"], n + ": one look, nothing else");
  }
  assert.equal(w.identities().length, 1);
});

test("creation's shape checks run for every entry before any object call", async () => {
  const { w, tok } = rooms(["lima"]);
  const k = newAgentKey();
  const cases = [
    [{}, 400, { error: "\"rooms\" must list 1 to " + AGENT_ROOMS_MAX + " rooms: [{\"room\", \"token\"}], your agent invites" }],
    [{ rooms: [] }, 400, null],
    [{ rooms: "lima" }, 400, null],
    [{ rooms: Array.from({ length: AGENT_ROOMS_MAX + 1 }, (_, i) => ({ room: "r" + i, token: "t" })) }, 400, null],
    [{ rooms: [{ room: "lima", token: tok.lima }, "oslo"] }, 400, { error: "rooms[1] must be an object: {\"room\", \"token\"}" }],
    [{ rooms: [{ room: "lima", token: tok.lima }, { room: "Bad Name!", token: "t" }] }, 400, { error: "rooms[1]: Room names are 1-64 lowercase letters, digits, - or _", room: "bad name!" }],
    [{ rooms: [{ room: "__agent-quota", token: "t" }] }, 400, { error: "rooms[0]: Room names are 1-64 lowercase letters, digits, - or _", room: "__agent-quota" }],
    [{ rooms: [{ room: "lima", token: tok.lima }, { room: "LIMA", token: tok.lima }] }, 400, { error: "rooms[1]: lima is listed twice", room: "lima" }],
    [{ rooms: [{ room: "lima", token: tok.lima }, { room: "oslo" }] }, 401, { error: "rooms[1]: \"token\" is required: your agent invite token for oslo", code: "invite_missing", room: "oslo" }],
    [{ rooms: [{ room: "lima", token: k.key }] }, 403, { error: "rooms[0]: that is an agent key, not a room invite token", code: "invite_invalid", room: "lima" }],
  ];
  for (const [body, status, want] of cases) {
    const mark = w.asked.length;
    const r = await create(w, body);
    assert.equal(r.status, status, JSON.stringify(body).slice(0, 80));
    if (want) assert.deepEqual(r.json, want);
    assert.equal(w.asked.length, mark, "no object asked: " + JSON.stringify(body).slice(0, 80));
  }
  // a body that is no object throws BadRequest, which index.ts answers 400
  await assert.rejects(create(w, "[1]"), { name: "Error", message: "The request body must be a JSON object, like {\"text\": \"hi\"}." });
  const big = await read(agentCreateRoute(w.rc("POST", "/api/agents", { body: JSON.stringify({ rooms: [{ room: "lima", token: "x".repeat(1100 * 1024) }] }) })));
  assert.equal(big.status, 413);
  assert.deepEqual(big.json, { error: "That request's body is too large: send {\"rooms\": [{\"room\", \"token\"}]}." });
  assert.equal((await read(agentCreateRoute(w.rc("GET", "/api/agents")))).status, 405);
  assert.equal(w.identities().length, 0);
  assert.ok(!w.objects.has(AGENT_QUOTA_ROOM), "nothing counted");
});

test("every room is looked up before the caps; a refusal counts nothing and writes nothing", async () => {
  const { w, tok, pat } = rooms(["lima", "oslo"]);
  w.harness("lima").room.revoke(tok.lima);
  const cases = [
    [{ room: "nowhere", token: "tok-123456789012345678901" }, 404, { error: "No room with that name yet. Create it from the home page.", room: "nowhere" }],
    [{ room: "lima", token: "tok-not-one-of-lima-s-xx" }, 403, { error: "Room \"lima\": This invite link isn't valid for this room.", code: "invite_invalid", room: "lima" }],
    [{ room: "lima", token: tok.lima }, 403, { error: "Room \"lima\": This invite link has been revoked. Ask whoever gave it to you for a new one.", code: "invite_revoked", room: "lima" }],
    [{ room: "oslo", token: pat.oslo }, 403, { error: "Room \"oslo\": this is a person's invite. An agent key holds only agent invites: an agent joins under its own name, never as a person.", code: "not_agent_invite", room: "oslo" }],
  ];
  for (const [entry, status, want] of cases) {
    const mark = w.asked.length;
    const r = await create(w, { rooms: [entry, entry.room === "oslo" ? { room: "lima", token: tok.lima } : { room: "oslo", token: tok.oslo }] });
    assert.equal(r.status, status, entry.room);
    assert.deepEqual(r.json, want);
    assert.deepEqual(w.asked.slice(mark).map((a) => a.name + "." + a.method), [entry.room + ".lookupInvite"], "the first look refused: the answer, with nothing else asked");
  }
  // an unknown room's look wrote nothing: the object has no table
  assert.equal(w.harness("nowhere").db.prepare("SELECT COUNT(*) AS n FROM sqlite_master").get().n, 0);
  assert.equal(w.identities().length, 0);
  assert.ok(!w.objects.has(AGENT_QUOTA_ROOM), "no place taken");
});

test("a refused later room is the answer before anything is counted, and makes nothing", async () => {
  const { w, tok } = rooms(["lima", "oslo", "rome"]);
  // one key made first, so the counters' object holds rows to compare
  await keyFor(w, tok, ["lima"]);
  const before = w.harness(AGENT_QUOTA_ROOM).all("SELECT k, w, n FROM aq ORDER BY k");
  const mark = w.asked.length;
  const r = await create(w, { rooms: [{ room: "lima", token: tok.lima }, { room: "oslo", token: tok.oslo }, { room: "rome", token: "tok-not-rome-s-0123456789" }] });
  assert.equal(r.status, 403);
  assert.deepEqual(r.json, { error: "Room \"rome\": This invite link isn't valid for this room.", code: "invite_invalid", room: "rome" });
  assert.deepEqual(w.asked.slice(mark).map((a) => a.name + "." + a.method), ["lima.lookupInvite", "oslo.lookupInvite", "rome.lookupInvite"], "every look in order, the counters never asked");
  assert.deepEqual(w.harness(AGENT_QUOTA_ROOM).all("SELECT k, w, n FROM aq ORDER BY k"), before, "aq as it was");
  assert.equal(w.identities().length, 1, "only the first key");
});

test("an outsider naming a room at its cap gets that room's refusal of its token, never 429, and leaves no row for it", async () => {
  const { w, tok } = rooms(["victim", "mine"]);
  // the victim room's day is used up by its own agent's keys
  for (let i = 0; i < AGENT_KEYS_PER_ROOM_DAY; i++) assert.equal((await create(w, { rooms: [{ room: "victim", token: tok.victim }] }, "10.6.0." + i)).status, 201);
  const victimRow = "room:" + (await hashKey("victim")) + ":" + new Date().toISOString().slice(0, 10);
  const before = w.harness(AGENT_QUOTA_ROOM).all("SELECT k, w, n FROM aq ORDER BY k");
  assert.ok(before.some((x) => x.k === victimRow && x.n === AGENT_KEYS_PER_ROOM_DAY));
  // an outsider holding a good invite to its own room and a guess at the victim's
  for (const guess of ["not-the-victims-token-xx", tok.mine]) {
    const r = await create(w, { rooms: [{ room: "mine", token: tok.mine }, { room: "victim", token: guess }] }, "10.6.9.9");
    assert.equal(r.status, 403, guess.slice(0, 6));
    assert.equal(r.json.code, "invite_invalid");
    assert.equal(r.json.room, "victim");
    assert.notEqual(r.status, 429);
  }
  // and rooms that do not exist: their own 404, no row
  const r = await create(w, { rooms: [{ room: "mine", token: tok.mine }, ...Array.from({ length: 5 }, (_, i) => ({ room: "ghost-" + i, token: "tok-ghost-0123456789abcd" }))] }, "10.6.9.9");
  assert.equal(r.status, 404);
  assert.equal(r.json.room, "ghost-0");
  const after = w.harness(AGENT_QUOTA_ROOM).all("SELECT k, w, n FROM aq ORDER BY k");
  assert.deepEqual(after, before, "no row added or moved: not the victim's, not the outsider's network's, not a ghost's");
  // the victim's own agent, holding its token, is the one told its room is full
  assert.equal((await create(w, { rooms: [{ room: "victim", token: tok.victim }] }, "10.6.1.1")).status, 429);
});

test("the caps: one per network, one for the site, one per distinct room, as hashes, each put in its window by the counters' object", async () => {
  const { w, tok } = rooms(["lima", "oslo"]);
  const mark = w.asked.length;
  await keyFor(w, tok, ["lima", "oslo"]);
  const reserve = w.asked.slice(mark).find((a) => a.method === "agentReserve");
  const [caps] = reserve.args;
  assert.deepEqual(caps, [
    { k: "net:" + (await hashKey(networkKey(IP))), max: AGENT_KEYS_PER_IP, per: AGENT_KEYS_WINDOW_S },
    { k: "all", max: AGENT_KEYS_PER_DAY, per: "day" },
    { k: "room:" + (await hashKey("lima")), max: AGENT_KEYS_PER_ROOM_DAY, per: "day" },
    { k: "room:" + (await hashKey("oslo")), max: AGENT_KEYS_PER_ROOM_DAY, per: "day" },
  ], "what to count, and how long its window is: no window from the route");
  const now = new Date();
  const day = now.toISOString().slice(0, 10), hour = new Date(Math.floor(now.getTime() / (AGENT_KEYS_WINDOW_S * 1000)) * AGENT_KEYS_WINDOW_S * 1000).toISOString().slice(0, 16);
  assert.deepEqual(w.harness(AGENT_QUOTA_ROOM).all("SELECT k, w, n FROM aq ORDER BY k").map((x) => [x.k, x.w, x.n]), [
    ["all:" + day, day, 1],
    ["net:" + (await hashKey(networkKey(IP))) + ":" + hour, hour, 1],
    ["room:" + (await hashKey("lima")) + ":" + day, day, 1],
    ["room:" + (await hashKey("oslo")) + ":" + day, day, 1],
  ].sort((a, b) => (a[0] < b[0] ? -1 : 1)));
  assert.ok(!JSON.stringify(w.harness(AGENT_QUOTA_ROOM).all("SELECT * FROM aq")).match(/lima|oslo|10\.1\.2\.3/), "no room name or address stored");
});

test("the caps answer 429 rate_limited with Retry-After: per room at its constant, per network", async () => {
  const { w, tok } = rooms(["lima", "oslo"]);
  for (let i = 0; i < AGENT_KEYS_PER_ROOM_DAY; i++) assert.equal((await create(w, { rooms: [{ room: "lima", token: tok.lima }] }, "10.7.0." + i)).status, 201, "key " + i);
  const r = await create(w, { rooms: [{ room: "lima", token: tok.lima }] }, "10.7.1.1");
  assert.equal(r.status, 429);
  assert.deepEqual(r.json, { error: "Too many agent keys were made just now, from this network, for one of these rooms or on the whole site. Try again later.", code: "rate_limited" });
  assert.ok(Number(r.headers.get("Retry-After")) > 0);
  assert.equal((await create(w, { rooms: [{ room: "oslo", token: tok.oslo }] }, "10.7.1.1")).status, 201, "another room is not capped by lima's");
  // per network: the same address, other rooms
  const more = rooms(Array.from({ length: AGENT_KEYS_PER_IP + 1 }, (_, i) => "net" + i));
  for (let i = 0; i < AGENT_KEYS_PER_IP; i++) assert.equal((await create(more.w, { rooms: [{ room: "net" + i, token: more.tok["net" + i] }] }, "10.8.0.1")).status, 201);
  const n = await create(more.w, { rooms: [{ room: "net" + AGENT_KEYS_PER_IP, token: more.tok["net" + AGENT_KEYS_PER_IP] }] }, "10.8.0.1");
  assert.equal(n.status, 429);
  assert.ok(Number(n.headers.get("Retry-After")) > 0 && Number(n.headers.get("Retry-After")) <= 3600);
  assert.equal(more.w.identities().length, AGENT_KEYS_PER_IP);
});

test("the key check of every /api/agent route: no key 401, a room token 403, anything else 403, with no object asked but the key's own", async () => {
  const { w, tok } = rooms(["lima"]);
  const key = await keyFor(w, tok, ["lima"]);
  const dropped = newAgentKey().key;
  const routes = [
    ["GET /api/agent", (h) => agentRoute(w.rc("GET", "/api/agent", { headers: h }))],
    ["HEAD /api/agent", (h) => agentRoute(w.rc("HEAD", "/api/agent", { headers: h }))],
    ["DELETE /api/agent", (h) => agentRoute(w.rc("DELETE", "/api/agent", { headers: h }))],
    ["POST /api/agent/rooms", (h) => agentRoomsRoute(w.rc("POST", "/api/agent/rooms", { headers: h, json: { rooms: [{ room: "lima", token: tok.lima }] } }))],
    ["POST /api/agent/rooms/remove", (h) => agentRemoveRoute(w.rc("POST", "/api/agent/rooms/remove", { headers: h, json: { room: "lima" } }))],
    ["POST /api/agent/rooms/leave", (h) => agentLeaveRoute(w.rc("POST", "/api/agent/rooms/leave", { headers: h, json: { room: "lima", confirm: "lima" } }))],
  ];
  const refusals = [
    [{}, 401, "agent_key_missing", AGENT_KEY_MISSING, false],
    [{ "X-Invite-Token": tok.lima }, 401, "agent_key_missing", AGENT_KEY_MISSING, false],
    [{ "X-Owner-Key": "the-owner-key", "X-Invite-Token": key }, 401, "agent_key_missing", AGENT_KEY_MISSING, false],
    [bearer(tok.lima), 403, "not_agent_key", NOT_AGENT_KEY, false],
    [bearer(".ac1.nope"), 403, "agent_key_invalid", AGENT_KEY_INVALID, false],
    [bearer(".ao1.something"), 403, "agent_key_invalid", AGENT_KEY_INVALID, false],
    [bearer(dropped), 403, "agent_key_invalid", AGENT_KEY_INVALID, true],
    [bearer(key.slice(0, -2) + (key.slice(-2) === "AA" ? "AQ" : "AA")), 403, "agent_key_invalid", AGENT_KEY_INVALID, true],
  ];
  for (const [what, call] of routes) {
    for (const [headers, status, code, error, asks] of refusals) {
      const mark = w.asked.length;
      const r = await read(call(headers));
      assert.equal(r.status, status, what + " " + JSON.stringify(headers).slice(0, 40));
      if (what.startsWith("HEAD")) assert.equal(r.text, "");
      else assert.deepEqual(r.json, { error, code }, what);
      const names = [...new Set(w.asked.slice(mark).map((a) => a.name))];
      assert.ok(asks ? names.length === 1 && names[0].startsWith("__agent-") : names.length === 0, what + ": asked " + names.join());
      // DELETE asks the slot to cut (a cut key's own DELETE is let through to finish it); a wrong verifier writes nothing
      assert.ok(w.asked.slice(mark).every((a) => a.method === (what.startsWith("DELETE") ? "agentCut" : "agentOpen")), what + ": only an open, or for DELETE a cut: " + w.asked.slice(mark).map((a) => a.method));
    }
  }
  // nothing was written: the key still opens, its one room held
  const g = await read(agentRoute(w.rc("GET", "/api/agent", { headers: bearer(key) })));
  assert.equal(g.status, 200);
  assert.deepEqual(g.json.rooms.map((x) => [x.room, x.state]), [["lima", "held"]]);
  assert.equal((await read(agentRoute(w.rc("PUT", "/api/agent", { headers: bearer(key) })))).status, 405);
  assert.equal((await read(agentRoomsRoute(w.rc("GET", "/api/agent/rooms", { headers: bearer(key) })))).status, 405);
});

test("GET /api/agent lists the rooms, never a token; HEAD gives the headers", async () => {
  const { w, tok } = rooms(["lima", "oslo"]);
  const key = await keyFor(w, tok, ["lima", "oslo"]);
  const g = await read(agentRoute(w.rc("GET", "/api/agent", { headers: bearer(key) })));
  assert.equal(g.status, 200);
  assert.deepEqual(Object.keys(g.json), ["rooms", "max_rooms", "created"]);
  assert.deepEqual(g.json.rooms.map((x) => Object.keys(x)), [["room", "name", "added", "state"], ["room", "name", "added", "state"]]);
  for (const t of Object.values(tok)) assert.ok(!g.text.includes(t));
  const h = await read(agentRoute(w.rc("HEAD", "/api/agent", { headers: bearer(key) })));
  assert.equal(h.status, 200);
  assert.equal(h.text, "");
  assert.equal(h.headers.get("Content-Type"), "application/json; charset=utf-8");
});

test("POST /api/agent/rooms: a held room 409, over the most 429, a refused one replaced, each token looked up first", async () => {
  const { w, tok } = rooms(["lima", "oslo", "rome"]);
  const key = await keyFor(w, tok, ["lima"]);
  const add = (list) => read(agentRoomsRoute(w.rc("POST", "/api/agent/rooms", { headers: bearer(key), json: { rooms: list } })));
  let r = await add([{ room: "oslo", token: tok.oslo }, { room: "lima", token: tok.lima }]);
  assert.equal(r.status, 409);
  assert.deepEqual(r.json, { error: "rooms[1]: lima is already on this key", code: "room_held", room: "lima" });
  r = await add([{ room: "rome", token: "tok-not-rome-s-0123456789" }]);
  assert.equal(r.status, 403);
  assert.equal(r.json.code, "invite_invalid");
  r = await add([{ room: "oslo", token: tok.oslo }]);
  assert.equal(r.status, 201);
  assert.deepEqual(r.json, { rooms: [{ room: "oslo", name: "Hank", opened: false }], rooms_held: 2 });
  assert.equal(w.harness("oslo").one("SELECT used FROM inv WHERE name = 'Hank'").used, null, "joins nothing");
  // lima refuses its token, is marked so, and a new invite there replaces it in place
  w.harness("lima").room.revoke(tok.lima);
  const fresh = agentInvite(w.harness("lima"), "Hank");
  const list = async () => (await read(agentRoute(w.rc("GET", "/api/agent", { headers: bearer(key) })))).json.rooms;
  // the key's view: a GET does not ask the room; a tool call would mark it (agent-rooms.test.mjs)
  assert.deepEqual((await list()).map((x) => x.state), ["held", "held"]);
  r = await add([{ room: "lima", token: fresh }]);
  assert.equal(r.status, 409, "still held as the key last saw it");
  // over the most: a key at AGENT_ROOMS_MAX takes no more
  const many = rooms(Array.from({ length: AGENT_ROOMS_MAX + 1 }, (_, i) => "m" + i));
  const mkey = await keyFor(many.w, many.tok, Array.from({ length: AGENT_ROOMS_MAX }, (_, i) => "m" + i));
  r = await read(agentRoomsRoute(many.w.rc("POST", "/api/agent/rooms", { headers: bearer(mkey), json: { rooms: [{ room: "m" + AGENT_ROOMS_MAX, token: many.tok["m" + AGENT_ROOMS_MAX] }] } })));
  assert.equal(r.status, 429);
  assert.deepEqual(r.json, { error: "This key holds at most " + AGENT_ROOMS_MAX + " rooms; take one off first (remove_room).", code: "limit_reached" });
  assert.equal(r.headers.get("Retry-After"), null);
});

test("a refused room on the key is replaced by a new invite there, in place", async () => {
  const { w, tok } = rooms(["lima", "oslo"]);
  const key = await keyFor(w, tok, ["lima", "oslo"]);
  // mark lima refused as a tool call through the key would (its token revoked)
  const id = w.identities()[0];
  const { agentMcpRoute } = await import("../../worker/routes/agent.ts");
  w.harness("lima").room.revoke(tok.lima);
  const call = await read(agentMcpRoute(w.rc("POST", "/api/mcp", { headers: bearer(key), json: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "whoami", arguments: { room: "lima" } } } })));
  assert.equal(call.json.result.structuredContent.code, "invite_revoked");
  const fresh = agentInvite(w.harness("lima"), "Hank");
  const r = await read(agentRoomsRoute(w.rc("POST", "/api/agent/rooms", { headers: bearer(key), json: { rooms: [{ room: "lima", token: fresh }] } })));
  assert.equal(r.status, 201);
  assert.equal(r.json.rooms_held, 2);
  const g = (await read(agentRoute(w.rc("GET", "/api/agent", { headers: bearer(key) })))).json.rooms;
  assert.deepEqual(g.map((x) => [x.room, x.state]), [["lima", "held"], ["oslo", "held"]], "replaced where it was");
  assert.ok(id);
});

test("a stale swap reads the list again and redoes the change; after AGENT_SWAP_TRIES it answers try_again", async () => {
  const { w, tok } = rooms(["lima", "oslo", "rome"]);
  const key = await keyFor(w, tok, ["lima"]);
  const id = w.identities()[0];
  const obj = w.harness(id).room;
  const real = obj.agentSwap.bind(obj);
  // another writer gets in first, once: the swap is stale, and the add is made again on what it wrote
  let stale = 1;
  obj.agentSwap = (slot, verifier, ver, ring) => { if (stale-- > 0) return { ok: false, code: "stale" }; return real(slot, verifier, ver, ring); };
  let mark = w.asked.length;
  let r = await read(agentRoomsRoute(w.rc("POST", "/api/agent/rooms", { headers: bearer(key), json: { rooms: [{ room: "oslo", token: tok.oslo }] } })));
  assert.equal(r.status, 201, r.text);
  assert.deepEqual(w.methods(id, mark), ["agentOpen", "agentOpen", "agentSwap", "agentOpen", "agentSwap"], "opened again once the body is in, and again after the stale swap");
  assert.equal(w.methods("oslo", mark).length, 2, "its token looked up again");
  // always stale: three tries, then 503 try_again with Retry-After: 1, and nothing added
  stale = 99;
  mark = w.asked.length;
  r = await read(agentRoomsRoute(w.rc("POST", "/api/agent/rooms", { headers: bearer(key), json: { rooms: [{ room: "rome", token: tok.rome }] } })));
  assert.equal(r.status, 503);
  assert.deepEqual(r.json, { error: "This key is busy; try again.", code: "try_again" });
  assert.equal(r.headers.get("Retry-After"), "1");
  assert.equal(w.methods(id, mark).filter((m) => m === "agentSwap").length, 3);
  obj.agentSwap = real;
  const g = (await read(agentRoute(w.rc("GET", "/api/agent", { headers: bearer(key) })))).json.rooms;
  assert.deepEqual(g.map((x) => x.room), ["lima", "oslo"]);
});

test("POST /api/agent/rooms/remove forgets a room, the seat stays; a room not on the key 404", async () => {
  const { w, tok } = rooms(["lima", "oslo"]);
  const key = await keyFor(w, tok, ["lima", "oslo"]);
  const rm = (body) => read(agentRemoveRoute(w.rc("POST", "/api/agent/rooms/remove", { headers: bearer(key), json: body })));
  let r = await rm({ room: "rome" });
  assert.equal(r.status, 404);
  assert.deepEqual(r.json, { error: "rome is not on this key.", code: "room_not_held", room: "rome" });
  r = await rm({ room: "Not A Room" });
  assert.equal(r.status, 400);
  assert.deepEqual(r.json, { error: "Room names are 1-64 lowercase letters, digits, - or _" });
  const mark = w.asked.length;
  r = await rm({ room: "LIMA" });
  assert.equal(r.status, 200);
  // the take-off asks the room nothing, so it claims no membership: the agent may have left meanwhile
  assert.deepEqual(r.json, { room: "lima", removed: true, note: "The key forgets lima. Taking a room off a key does not leave it: a seat still held there stays. To leave lima for good, call leave_room through the key first, or use the room's own address." });
  assert.doesNotMatch(r.json.note, /still a member/);
  assert.deepEqual(w.methods("lima", mark), [], "the room is not asked");
  assert.equal(w.harness("lima").one("SELECT revoked FROM inv WHERE token = ?", tok.lima).revoked, null, "the seat stays");
  const g = (await read(agentRoute(w.rc("GET", "/api/agent", { headers: bearer(key) })))).json.rooms;
  assert.deepEqual(g.map((x) => x.room), ["oslo"]);
});

test("DELETE /api/agent disconnects everywhere: the key works nowhere, every seat stays", async () => {
  const { w, tok } = rooms(["lima", "oslo"]);
  const key = await keyFor(w, tok, ["lima", "oslo"]);
  const id = w.identities()[0];
  const mark = w.asked.length;
  const r = await read(agentRoute(w.rc("DELETE", "/api/agent", { headers: bearer(key) })));
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { deleted: true, rooms: ["lima", "oslo"], muse_wakes_removed: [], muse_wakes_left: [], note: "This key works nowhere now, and it has let go of every Muse wake it set up: a wake that another key or connection holding the same seat, or a registration with the room's own token, also holds stays on. Every seat stays as it was: you are still a member of each of these rooms that still takes your invite, and any room token you kept still works. Links the key already handed out, for an upload or a file, run until they expire." });
  assert.deepEqual(w.methods("lima", mark).concat(w.methods("oslo", mark)), [], "no room asked: the key set up no wake");
  assert.equal(w.harness(id).db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table'").get().n, 0, "the identity is gone");
  for (const n of ["lima", "oslo"]) assert.equal(w.harness(n).one("SELECT revoked FROM inv WHERE token = ?", tok[n]).revoked, null, n + ": the seat stays");
  const again = await read(agentRoute(w.rc("GET", "/api/agent", { headers: bearer(key) })));
  assert.equal(again.status, 403);
  assert.equal(again.json.code, "agent_key_invalid");
  assert.equal((await read(agentRoute(w.rc("DELETE", "/api/agent", { headers: bearer(key) })))).status, 403);
});
