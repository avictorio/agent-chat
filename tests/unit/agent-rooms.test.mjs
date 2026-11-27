// An agent key in real rooms (the Room class on node:sqlite,
// agent-world.mjs): add_room, list_rooms and whats_waiting look and leave
// every invite as it was; each way a seat ends (the owner's revoke, a leave
// at the room's own address, revoke-everyone, the room deleted, and created
// again) refuses the token at the next call through the key, which the list
// records; and get_members through the key carries no invite link and no
// note in any row, whatever the member's kind. Run with `npm run test:unit`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeWorld, read, agentInvite } from "./agent-world.mjs";
import { agentCreateRoute, agentMcpRoute } from "../../worker/routes/agent.ts";
import { LEFT_MSG } from "../../worker/room/Room.ts";

const call = (name, args) => ({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
async function setup(names) {
  const w = makeWorld();
  const tok = {};
  for (const n of names) tok[n] = agentInvite(w.room(n), "Hank");
  const r = await read(agentCreateRoute(w.rc("POST", "/api/agents", { json: { rooms: [{ room: names[0], token: tok[names[0]] }] } })));
  assert.equal(r.status, 201, r.text);
  const key = r.json.key;
  const tool = async (name, args) => (await read(agentMcpRoute(w.rc("POST", "/api/mcp", { json: call(name, args), headers: { Authorization: "Bearer " + key } })))).json.result;
  return { w, tok, key, tool };
}
const inv = (w, room, tok) => ({ ...w.harness(room).one("SELECT used, seen FROM inv WHERE token = ?", tok) });
const entry = async (tool, room) => (await tool("list_rooms", {})).structuredContent.rooms.find((x) => x.room === room);

test("add_room, list_rooms and whats_waiting leave every invite unopened and unseen", async () => {
  const { w, tok, tool } = await setup(["lima", "oslo"]);
  const a = await tool("add_room", { room: "oslo", token: tok.oslo });
  assert.deepEqual(a.structuredContent, { room: "oslo", name: "Hank", opened: false, rooms_held: 2 });
  assert.deepEqual((await tool("list_rooms", {})).structuredContent.rooms.map((x) => [x.room, x.state]), [["lima", "held"], ["oslo", "held"]]);
  const g = (await tool("whats_waiting", {})).structuredContent;
  assert.deepEqual(g.rooms.map((x) => [x.room, x.opened, x.since]), [["lima", false, null], ["oslo", false, null]]);
  assert.deepEqual(g.refused, []);
  for (const n of ["lima", "oslo"]) assert.deepEqual(inv(w, n, tok[n]), { used: null, seen: null }, n);
  // a seat already open keeps its used and seen as they were too
  await tool("whoami", { room: "lima" });
  const before = inv(w, "lima", tok.lima);
  assert.ok(before.used && before.seen, "whoami joined");
  // whats_waiting's gap is the identity's, in its memory: let this one through
  w.harness(w.identities()[0]).room.agentGlanceAt = 0;
  await tool("list_rooms", {});
  await tool("whats_waiting", {});
  assert.deepEqual(inv(w, "lima", tok.lima), before, "a look moves neither");
  // add_room refuses a person's invite and a room already held
  const pat = agentInvite(w.harness("oslo"), "Pat", "human");
  const p = await tool("add_room", { room: "oslo", token: pat });
  assert.deepEqual(p.structuredContent, { code: "room_held", room: "oslo" });
  await tool("remove_room", { room: "oslo" });
  const q = await tool("add_room", { room: "oslo", token: pat });
  assert.equal(q.isError, true);
  assert.deepEqual(q.structuredContent, { code: "not_agent_invite", room: "oslo" });
  assert.equal(inv(w, "oslo", pat).used, null);
});

test("each way a seat ends refuses the token at the next call through the key, and the list records each", async () => {
  // an owner's revoke
  {
    const { w, tok, tool } = await setup(["lima"]);
    w.harness("lima").room.revoke(tok.lima);
    const r = await tool("whoami", { room: "lima" });
    assert.deepEqual(r.structuredContent, { code: "invite_revoked", room: "lima" });
    assert.equal(r.content[0].text, "Room \"lima\": This invite link has been revoked. Ask whoever gave it to you for a new one.");
    assert.deepEqual([(await entry(tool, "lima")).state, (await entry(tool, "lima")).code], ["refused", "invite_revoked"]);
  }
  // a leave at the room's own address (after joining through the key)
  {
    const { w, tok, tool } = await setup(["lima"]);
    // another member who has joined, so the leave is not the last member's
    w.harness("lima").room.access(agentInvite(w.harness("lima"), "Pat", "human"), false);
    await tool("whoami", { room: "lima" });
    const left = await w.harness("lima").room.leave(tok.lima, "lima", false);
    assert.equal(left.ok, true, JSON.stringify(left));
    const r = await tool("get_board", { room: "lima" });
    assert.deepEqual(r.structuredContent, { code: "invite_revoked", room: "lima" });
    assert.equal(r.content[0].text, "Room \"lima\": " + LEFT_MSG, "the leave's own sentence");
    assert.equal((await entry(tool, "lima")).code, "invite_revoked");
  }
  // revoke-everyone, then the room deleted, then created again under its name
  {
    const { w, tool } = await setup(["lima"]);
    const h = w.harness("lima");
    await h.room.revokeAll();
    let r = await tool("whoami", { room: "lima" });
    assert.deepEqual(r.structuredContent, { code: "invite_invalid", room: "lima" });
    assert.equal((await entry(tool, "lima")).code, "invite_invalid");
    assert.deepEqual(await h.room.destroy("lima"), { deleted: true });
    r = await tool("list_messages", { room: "lima" });
    assert.deepEqual(r.structuredContent, { code: "room_deleted", room: "lima" });
    assert.equal((await entry(tool, "lima")).code, "room_deleted", "the list records the new code");
    assert.equal(h.room.create(), true);
    r = await tool("whoami", { room: "lima" });
    assert.deepEqual(r.structuredContent, { code: "invite_invalid", room: "lima" });
    assert.equal((await entry(tool, "lima")).code, "invite_invalid");
    assert.equal(h.one("SELECT COUNT(*) AS n FROM inv").n, 0, "nothing came back into the room");
  }
  // whats_waiting reports a refusal too, and marks it
  {
    const { w, tok, tool } = await setup(["lima", "oslo"]);
    await tool("add_room", { room: "oslo", token: tok.oslo });
    w.harness("oslo").room.revoke(tok.oslo);
    const g = (await tool("whats_waiting", {})).structuredContent;
    assert.deepEqual(g.refused, [{ room: "oslo", code: "invite_revoked" }]);
    assert.deepEqual(g.rooms.map((x) => x.room), ["lima"]);
    assert.equal((await entry(tool, "oslo")).state, "refused");
  }
});

test("leave_room through the key leaves the room as the room's own address does, and marks it left on the key", async () => {
  const { w, tok, tool } = await setup(["lima"]);
  agentInvite(w.harness("lima"), "Pat", "human");
  w.harness("lima").room.access(w.harness("lima").one("SELECT token FROM inv WHERE name = 'Pat'").token, false);
  await tool("whoami", { room: "lima" });
  assert.equal((await tool("leave_room", { room: "lima", confirm: "oslo" })).structuredContent.code, "confirm_mismatch");
  const r = await tool("leave_room", { room: "lima", confirm: "lima" });
  assert.ok(!r.isError, JSON.stringify(r));
  assert.equal(r.structuredContent.key, "lima is marked left on your key; take it off with remove_room.");
  assert.equal(r.structuredContent.name, "Hank");
  assert.ok(w.harness("lima").one("SELECT left_ts FROM inv WHERE token = ?", tok.lima).left_ts > 0);
  assert.deepEqual([(await entry(tool, "lima")).state, (await entry(tool, "lima")).code], ["refused", "invite_revoked"]);
});

test("get_members through the key carries no invite link and no note in any row, also once the agent's invite is a person's", async () => {
  const { w, tok, tool } = await setup(["lima"]);
  const h = w.harness("lima");
  agentInvite(h, "Pat", "human");
  agentInvite(h, "Ada", "agent");
  const look = async () => {
    const r = await tool("get_members", { room: "lima" });
    const text = JSON.stringify(r);
    assert.ok(!r.isError, text.slice(0, 200));
    for (const m of r.structuredContent.members) {
      assert.ok(!("invite_link" in m), m.name + " has a link");
      assert.ok(!("agent_onboarding" in m), m.name + " has a note");
    }
    for (const t of h.all("SELECT token FROM inv").map((x) => x.token)) assert.ok(!text.includes(t), "a token is in the answer");
    assert.ok(!text.includes("#invite="));
    return r.structuredContent.members.map((m) => m.name).sort();
  };
  assert.deepEqual(await look(), ["Ada", "Hank", "Pat"]);
  assert.equal(h.room.setKind("Hank", "human"), true);
  assert.deepEqual(await look(), ["Ada", "Hank", "Pat"], "a person's invite: still no row's link");
  assert.ok(tok.lima);
});
