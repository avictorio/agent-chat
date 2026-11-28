// The sign-in MCP address, POST /api/mcp/signin (worker/routes/agent.ts
// signinMcpRoute): the credential decided before any body is read, a 401
// with WWW-Authenticate for every token of this server's that fails and for
// none, in both kinds of revision, initialize and server/discover included;
// 200 wrong_address for an agent key, a room token or another dot form;
// CORS_SIGNIN on every answer; the catalog and its tools as a sign-in serves
// them (no add_room, remove_room for a refused room only, leave_room that
// takes the room off); a call whose body arrived after a disconnect acts
// nowhere; and the access slot's write grace near the hour's end. Run with
// `npm run test:unit`.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  makeSigninWorld, people, signIn, signin, rpc, toolCall, PUBLIC_APP, ORIGIN, ADDRESS, signins, disconnect, museSignIn, hookOf, holdersOf, token,
} from "./signin-world.mjs";
import { read } from "./agent-world.mjs";
import { signinMcpRoute, agentLeaveRoute } from "../../worker/routes/agent.ts";
import { MCP_SIGNIN_CATALOG_VERSION, mcpSigninCatalogBuilt } from "../../worker/agents/mcp.ts";
import { AGENT_KEY_INVALID, LEAVE_NO_DELETE, SIGNIN_TOKEN_ENDED, signinInstructions, signinLeaveNote, signinNeeded, signinRemovedNote, signinRoomHeld, signinWrongInstructions, signinWrongInvite, signinWrongKey } from "../../worker/agents/onboarding.ts";
import { OAUTH_ACCESS_TTL_S, OAUTH_ACCESS_WRITE_GRACE_S, OAUTH_IDLE_DAYS } from "../../worker/limits.ts";

const META = ORIGIN + "/.well-known/oauth-protected-resource/api/mcp/signin";
const MODERN = "2026-07-28";
/** a request of the revisions without initialize: its _meta and headers */
const modern = (method, params = {}) => ({ jsonrpc: "2.0", id: 1, method, params: { ...params, _meta: { "io.modelcontextprotocol/protocolVersion": MODERN, "io.modelcontextprotocol/clientCapabilities": {} } } });
const modernHeaders = (method, name) => ({ "MCP-Protocol-Version": MODERN, "Mcp-Method": method, ...(name ? { "Mcp-Name": name } : {}) });
const result = (r) => r.json.result;
const sc = (r) => result(r).structuredContent;

test("401 before the body, for every method in both kinds of revision: none (sign_in_required, the scope named) and every sign-in token that fails (invalid_token): expired, unknown, revoked, idle, the default token, a code, a refresh token, a disconnect code; each with CORS_SIGNIN, WWW-Authenticate readable", async () => {
  const w = makeSigninWorld();
  w.harness("__agent-quota").room.setTestAgentLimits({ per_ip: 1000, per_room: 1000, per_day: 1000 });
  const pat = people(w, ["lima"]);
  const s = await signIn(w, PUBLIC_APP, pat);
  const def = await signIn(w, PUBLIC_APP, pat, { resource: null, tokenResource: ORIGIN });
  assert.equal(def.token.status, 200, def.token.text);
  const idle = await signIn(w, PUBLIC_APP, pat);
  w.harness(signins(w).find((n) => n.endsWith(idle.access.split(".")[2]))).db.prepare("UPDATE aks SET created = created - ? WHERE kind = 'refresh'").run((OAUTH_IDLE_DAYS * 86400 + 60) * 1000);
  const expired = await signIn(w, PUBLIC_APP, pat);
  w.harness(signins(w).find((n) => n.endsWith(expired.access.split(".")[2]))).db.prepare("UPDATE aks SET expires = expires - ? WHERE kind = 'access'").run((OAUTH_ACCESS_TTL_S + 1) * 1000);
  const fake = ".ao1." + "A".repeat(22) + "." + "A".repeat(11) + "." + "A".repeat(43);
  const cases = [
    ["none", null, "sign_in_required"], ["expired", expired.access, "invalid_token"], ["unknown", fake, "invalid_token"], ["idle", idle.access, "invalid_token"],
    ["the default token", def.access, "invalid_token"], ["a code", s.code, "invalid_token"], ["a refresh token", s.refresh, "invalid_token"], ["a disconnect code", s.disconnectCode, "invalid_token"],
  ];
  for (const [what, bearer, code] of cases) {
    for (const [kind, body, headers] of [["initialize", rpc("initialize", { protocolVersion: "2025-06-18" }), {}], ["ping", rpc("ping"), {}], ["tools/list", rpc("tools/list"), {}], ["tools/call", toolCall("list_rooms"), {}], ["server/discover", modern("server/discover"), modernHeaders("server/discover")], ["modern tools/call", modern("tools/call", { name: "list_rooms" }), modernHeaders("tools/call", "list_rooms")]]) {
      const mark = w.asked.length;
      const r = await signin(w, bearer, body, headers);
      assert.equal(r.status, 401, what + " " + kind);
      assert.deepEqual(r.json, { jsonrpc: "2.0", id: null, error: { code: -32001, message: signinNeeded(ORIGIN), data: { code } } }, what + " " + kind);
      assert.equal(r.headers.get("WWW-Authenticate"), code === "invalid_token" ? "Bearer error=\"invalid_token\", resource_metadata=\"" + META + "\"" : "Bearer resource_metadata=\"" + META + "\", scope=\"rooms\"", what);
      assert.match(r.headers.get("Access-Control-Expose-Headers"), /WWW-Authenticate/, what + ": readable by a browser client");
      assert.match(r.headers.get("Access-Control-Allow-Headers"), /Poppy-Session/);
      assert.ok(!w.asked.slice(mark).some((a) => !a.name.startsWith("__agent-")), what + ": no room asked");
    }
  }
  // a revoked access token, and one of a disconnected sign-in
  const { revoke } = await import("./signin-world.mjs");
  await revoke(w, { token: s.access, client_id: PUBLIC_APP.client_id });
  assert.equal((await signin(w, s.access, rpc("initialize"))).status, 401);
  assert.equal(signinNeeded(ORIGIN), "This address takes a sign-in: connect from Claude, Claude Code or another known app, which signs in through " + ORIGIN + "/oauth/authorize. Agent keys work at " + ORIGIN + "/api/mcp.");
});

test("an agent key, a room's invite token, another dot form: 200; ping, initialize and server/discover answer with where they work; every other method -32001 wrong_address; no object asked", async () => {
  const w = makeSigninWorld();
  for (const [what, bearer, message] of [["a key", ".ac1." + "A".repeat(22) + "." + "A".repeat(43), signinWrongKey(ORIGIN)], ["an invite token", "tok-some-room-invite-x", signinWrongInvite(ORIGIN)], ["another dot form", ".xx1.whatever", AGENT_KEY_INVALID]]) {
    const mark = w.asked.length;
    assert.deepEqual((await signin(w, bearer, rpc("ping"))).json, { jsonrpc: "2.0", id: 1, result: {} }, what);
    const init = await signin(w, bearer, rpc("initialize", { protocolVersion: "2025-06-18" }));
    assert.equal(init.status, 200, what);
    assert.equal(result(init).instructions, signinWrongInstructions(ORIGIN), what);
    assert.equal(result(init).serverInfo.name, "agent-chat-signin");
    assert.match(init.headers.get("Access-Control-Expose-Headers"), /WWW-Authenticate/, "CORS_SIGNIN on every answer");
    assert.equal(init.headers.get("WWW-Authenticate"), null, what + ": no challenge");
    for (const body of [rpc("tools/list"), toolCall("list_rooms"), toolCall("no_such_tool")]) {
      const r = await signin(w, bearer, body);
      assert.deepEqual([r.status, r.json.error], [200, { code: -32001, message, data: { code: "wrong_address" } }], what + " " + body.method);
    }
    const disc = await signin(w, bearer, modern("server/discover"), modernHeaders("server/discover"));
    assert.equal(result(disc).instructions, signinWrongInstructions(ORIGIN));
    const call = await signin(w, bearer, modern("tools/call", { name: "list_rooms" }), modernHeaders("tools/call", "list_rooms"));
    assert.deepEqual([call.status, call.json.error.data], [200, { code: "wrong_address" }]);
    assert.deepEqual(w.asked.slice(mark), [], what + ": no object asked");
  }
  assert.equal(signinWrongKey(ORIGIN), "Agent keys work at " + ORIGIN + "/api/mcp; this address takes a sign-in.");
  assert.equal(signinWrongInvite(ORIGIN), "A room's invite token works at that room's own address, " + ORIGIN + "/api/rooms/ROOM/mcp.");
  // a method other than POST, with CORS_SIGNIN
  const get = await read(signinMcpRoute(w.rc("GET", "/api/mcp/signin")));
  assert.deepEqual([get.status, get.headers.get("Allow")], [405, "POST"]);
  assert.match(get.headers.get("Access-Control-Expose-Headers"), /WWW-Authenticate/);
});

test("signed in: the sign-in's server, catalog and instructions; no add_room; list_rooms the approved rooms; a post as the agent invited by the person, no invite link anywhere", async () => {
  const w = makeSigninWorld();
  const pat = people(w, ["lima", "oslo"]);
  const s = await signIn(w, PUBLIC_APP, pat);
  const init = await signin(w, s.access, rpc("initialize", { protocolVersion: "2025-06-18" }));
  assert.deepEqual(result(init).serverInfo, { name: "agent-chat-signin", title: "Agent Chat: your approved rooms", version: MCP_SIGNIN_CATALOG_VERSION, websiteUrl: ORIGIN });
  assert.deepEqual(result(init).catalog, { version: MCP_SIGNIN_CATALOG_VERSION, digest: mcpSigninCatalogBuilt().digest });
  assert.equal(result(init).instructions, signinInstructions(ORIGIN));
  const list = await signin(w, s.access, rpc("tools/list"));
  const names = result(list).tools.map((t) => t.name);
  assert.ok(!names.includes("add_room") && names.includes("leave_room") && names.includes("muse_register"));
  assert.deepEqual((await signin(w, s.access, toolCall("add_room", { room: "rome", token: "x" }))).json.result.content[0].text.startsWith("Unknown tool"), true, "add_room is no tool here");
  const rooms = sc(await signin(w, s.access, toolCall("list_rooms")));
  assert.deepEqual(rooms.rooms.map((x) => [x.room, x.name, x.state]), [["lima", "Scout", "held"], ["oslo", "Scout", "held"]]);
  const post = await signin(w, s.access, toolCall("post_message", { room: "lima", text: "hello through the sign-in" }));
  assert.equal(sc(post).from, "Scout");
  const members = sc(await signin(w, s.access, toolCall("get_members", { room: "lima" })));
  const scout = members.members.find((m) => m.name === "Scout");
  assert.deepEqual([scout.kind, scout.invited_by, scout.status], ["agent", "Pat", "active"]);
  const text = JSON.stringify(members);
  assert.ok(!/invite_link|#invite=|agent_onboarding/.test(text), "no row carries an invite link or note");
  for (const t of w.harness("lima").all("SELECT token FROM inv").map((x) => x.token)) assert.ok(!text.includes(t));
  const page = result(await signin(w, s.access, toolCall("get_start_page", { room: "lima" }))).content[0].text;
  assert.ok(page.includes("You reached this page through your sign-in. At " + ADDRESS + " every tool below takes \"room\": \"lima\""), page.slice(0, 300));
  const notHeld = result(await signin(w, s.access, toolCall("whoami", { room: "rome" })));
  assert.deepEqual([notHeld.isError, notHeld.content[0].text], [true, "rome is not on this sign-in: list_rooms lists its rooms; to add one, ask your person to approve this app again."]);
});

test("remove_room: a held room refused with room_held and its two-step sentence; a refused room taken off", async () => {
  const w = makeSigninWorld();
  const pat = people(w, ["lima", "oslo"]);
  const s = await signIn(w, PUBLIC_APP, pat);
  const held = result(await signin(w, s.access, toolCall("remove_room", { room: "lima" })));
  assert.deepEqual([held.isError, held.content[0].text, held.structuredContent], [true, signinRoomHeld("lima"), { code: "room_held", room: "lima" }]);
  assert.equal(signinRoomHeld("lima"), "lima is still held by this connection: leave it with leave_room, which takes it off (for a seat that has already gone, leave_room marks it, and remove_room then takes it off).");
  // the owner revokes oslo's seat: a call marks it refused, then remove_room takes it off
  const tok = w.harness("oslo").one("SELECT token FROM inv WHERE name = 'Scout'").token;
  w.harness("oslo").room.revoke(tok);
  assert.equal(result(await signin(w, s.access, toolCall("whoami", { room: "oslo" }))).structuredContent.code, "invite_revoked");
  const off = sc(await signin(w, s.access, toolCall("remove_room", { room: "oslo" })));
  assert.deepEqual(off, { room: "oslo", removed: true, note: signinRemovedNote("oslo", false) });
  assert.deepEqual(sc(await signin(w, s.access, toolCall("list_rooms"))).rooms.map((x) => x.room), ["lima"]);
});

test("leave_room: the room's own leave, then off the sign-in when its links leave; marked left (marked_wake) when they cannot yet, settled later by remove_room; with delete_room as the last member, deleted and off; the key's REST leave still never deletes", async () => {
  // off (Pat has joined lima, so the agent is not its last member)
  {
    const w = makeSigninWorld();
    const pat = people(w, ["lima", "oslo"]);
    w.harness("lima").room.access(pat.lima, false);
    const s = await signIn(w, PUBLIC_APP, pat);
    await signin(w, s.access, toolCall("whoami", { room: "lima" }));
    const r = sc(await signin(w, s.access, toolCall("leave_room", { room: "lima", confirm: "lima" })));
    assert.equal(r.signin, signinLeaveNote("lima", "off", false));
    assert.equal(r.signin, "lima is off this sign-in: only a new approval by your person puts it back.");
    assert.ok(!("key" in r));
    assert.deepEqual(sc(await signin(w, s.access, toolCall("list_rooms"))).rooms.map((x) => x.room), ["oslo"]);
  }
  // marked_wake, then remove_room settles it
  {
    const m = await museSignIn(["lima", "oslo"]);
    try {
      m.w.harness("lima").room.access(m.pat.lima, false);
      const room = m.w.harness("lima").room;
      room.museHolderLook = () => { throw new Error("the room did not answer"); };
      const r = sc(await signin(m.w, m.s.access, toolCall("leave_room", { room: "lima", confirm: "lima" })));
      assert.equal(r.signin, signinLeaveNote("lima", "marked_wake", false));
      assert.equal(r.signin, "This sign-in could not yet confirm that it has let go of the Muse wake it set up in lima, so lima is still listed on it as left; remove_room tries again.");
      delete room.museHolderLook;
      const listed = sc(await signin(m.w, m.s.access, toolCall("list_rooms"))).rooms.find((x) => x.room === "lima");
      assert.deepEqual([listed.state, listed.code, listed.muse_wake], ["refused", "invite_revoked", true]);
      const off = sc(await signin(m.w, m.s.access, toolCall("remove_room", { room: "lima" })));
      assert.equal(off.removed, true);
      assert.deepEqual(sc(await signin(m.w, m.s.access, toolCall("list_rooms"))).rooms.map((x) => x.room), ["oslo"]);
    } finally {
      m.b.restore();
    }
  }
  // the last member who has joined, with delete_room: the room deleted, the entry off
  {
    const w = makeSigninWorld();
    const pat = people(w, ["lima"]);
    const s = await signIn(w, PUBLIC_APP, pat);
    await signin(w, s.access, toolCall("whoami", { room: "lima" }));
    const refused = result(await signin(w, s.access, toolCall("leave_room", { room: "lima", confirm: "lima" })));
    assert.equal(refused.structuredContent.code, "last_member", "without delete_room the last member is refused");
    const r = sc(await signin(w, s.access, toolCall("leave_room", { room: "lima", confirm: "lima", delete_room: true })));
    assert.equal(r.room_deleted, true);
    assert.equal(r.signin, "lima is deleted, and off this sign-in.");
    assert.deepEqual(sc(await signin(w, s.access, toolCall("list_rooms"))).rooms, []);
  }
  // the key's REST leave still refuses delete_room
  {
    const w = makeSigninWorld();
    const r = await read(agentLeaveRoute(w.rc("POST", "/api/agent/rooms/leave", { json: { room: "lima", confirm: "lima", delete_room: true }, headers: { Authorization: "Bearer .ac1." + "A".repeat(22) + "." + "A".repeat(43) } })));
    assert.notEqual(r.json.error, undefined);
    assert.ok(r.status === 403 || r.json.error === LEAVE_NO_DELETE, "a key that does not open is refused before the body; " + r.text);
  }
});

test("a tools/call whose body arrives after the connection was disconnected acts nowhere: -32001 invalid_token at 200 (the sign-in opened again once the body is in)", async () => {
  const w = makeSigninWorld();
  const pat = people(w, ["lima"]);
  const s = await signIn(w, PUBLIC_APP, pat);
  let release;
  const held = new Promise((r) => { release = r; });
  const body = new ReadableStream({ async start(c) { await held; c.enqueue(new TextEncoder().encode(JSON.stringify(toolCall("post_message", { room: "lima", text: "late" })))); c.close(); } });
  const pending = read(signinMcpRoute(w.rc("POST", "/api/mcp/signin", { body, headers: { Authorization: "Bearer " + s.access, "Content-Type": "application/json" } })));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal((await disconnect(w, { code: s.disconnectCode })).json.disconnected, true);
  release();
  const r = await pending;
  assert.deepEqual([r.status, r.json.error], [200, { code: -32001, message: SIGNIN_TOKEN_ENDED, data: { code: "invalid_token" } }]);
  assert.equal(w.harness("lima").all("SELECT id FROM m").length, 0, "nothing posted");
});

test("near the hour's end: a muse_register whose own write lands after the access token expired keeps its wakes inside the grace (ok, no hook dropped); 61 s past it answers invalid_token and lets go of the hooks it set; leave_room and remove_room inside the grace answer as for a live token", async () => {
  for (const late of [OAUTH_ACCESS_WRITE_GRACE_S - 1, OAUTH_ACCESS_WRITE_GRACE_S + 1]) {
    const m = await museSignIn(["lima"], { register: false });
    try {
      const id = signins(m.w)[0];
      const h = m.w.harness(id), room = m.w.harness("lima").room, set = room.museSetHookLook.bind(room);
      // the clock moves between the set and the call's own write: the access token expired late seconds ago
      room.museSetHookLook = (...a) => { const r = set(...a); h.db.prepare("UPDATE aks SET expires = ? WHERE kind = 'access'").run(Date.now() - late * 1000); return r; };
      const r = await signin(m.w, m.s.access, toolCall("muse_register", { code: m.g.code, rooms: ["lima"] }));
      delete room.museSetHookLook;
      if (late < OAUTH_ACCESS_WRITE_GRACE_S) {
        assert.equal(sc(r).results[0].ok, true, "inside the grace: " + r.text);
        assert.equal(hookOf(m.w, "lima").link, m.g.link, "the wake stays");
        assert.equal(holdersOf(m.w, "lima").length, 1);
      } else {
        assert.deepEqual(r.json.error, { code: -32001, message: SIGNIN_TOKEN_ENDED, data: { code: "invalid_token" } }, "61 s past");
        assert.equal(hookOf(m.w, "lima"), null, "the hook it set let go of again");
      }
    } finally {
      m.b.restore();
    }
  }
  // leave_room and remove_room inside the grace: the token expires just after the request's first open
  for (const tool of ["leave_room", "remove_room"]) {
    const w = makeSigninWorld();
    const pat = people(w, ["lima", "oslo"]);
    w.harness("lima").room.access(pat.lima, false);
    const s = await signIn(w, PUBLIC_APP, pat);
    await signin(w, s.access, toolCall("whoami", { room: "lima" }));
    if (tool === "remove_room") { w.harness("lima").room.revoke(w.harness("lima").one("SELECT token FROM inv WHERE name = 'Scout'").token); await signin(w, s.access, toolCall("whoami", { room: "lima" })); }
    const id = signins(w)[0];
    const obj = w.harness(id).room, open = obj.signinOpen.bind(obj);
    let opens = 0;
    obj.signinOpen = (...a) => { const r = open(...a); if (++opens === 1) w.harness(id).db.prepare("UPDATE aks SET expires = ? WHERE kind = 'access'").run(Date.now() - 30000); return r; };
    const r = await signin(w, s.access, toolCall(tool, tool === "leave_room" ? { room: "lima", confirm: "lima" } : { room: "lima" }));
    delete obj.signinOpen;
    assert.ok(!r.json.error && !result(r).isError, tool + ": " + r.text);
    // the expired token refreshed, the list read: the room is off
    const fresh = await token(w, { grant_type: "refresh_token", refresh_token: s.refresh, resource: ADDRESS, client_id: PUBLIC_APP.client_id });
    assert.deepEqual(sc(await signin(w, fresh.json.access_token, toolCall("list_rooms"))).rooms.map((x) => x.room), ["oslo"], tool + ": the room is off");
  }
});
