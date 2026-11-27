// What an agent key's identity stores (worker/room/agent.ts, sealed by
// worker/lib/agentkey.ts): with rooms on the key, no row of the identity's
// object holds a room's name, an invite token, a member's name or the key,
// and the quota object holds no room name or address either; only what
// the key opens shows them. Keys and tokens are made here. Run with
// `npm run test:unit`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeWorld, read, agentInvite } from "./agent-world.mjs";
import { agentCreateRoute, agentRoute } from "../../worker/routes/agent.ts";
import { AGENT_QUOTA_ROOM } from "../../worker/limits.ts";
import { b64urlDecode } from "../../worker/lib/crypto.ts";

/** every value of every row of every table of an object, as text */
function dump(h) {
  const out = [];
  for (const { name } of h.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all()) {
    out.push(name);
    for (const row of h.db.prepare("SELECT * FROM \"" + name + "\"").all()) for (const v of Object.values(row)) out.push(String(v));
  }
  return out.join("\n");
}

test("with two rooms on a key, no row of its identity holds a room name, a token, a member name or the key", async () => {
  const w = makeWorld();
  const rooms = { "lima-harbour": "Hank Hawthorne", "oslo-fjord": "Ölaf Øster" };
  const tok = {};
  for (const [room, name] of Object.entries(rooms)) tok[room] = agentInvite(w.room(room), name);
  const r = await read(agentCreateRoute(w.rc("POST", "/api/agents", { json: { rooms: Object.keys(rooms).map((room) => ({ room, token: tok[room] })) }, headers: { "CF-Connecting-IP": "10.3.0.9" } })));
  assert.equal(r.status, 201, r.text);
  const key = r.json.key;
  const [id] = w.identities();
  const stored = dump(w.harness(id));
  // the sealed list, decoded as bytes, holds none of them either
  const ring = w.harness(id).one("SELECT ring FROM ak").ring;
  const raw = Buffer.from(b64urlDecode(ring)).toString("latin1");
  const secrets = [...Object.keys(rooms), ...Object.values(rooms), ...Object.values(tok), key, key.slice(5, 27), key.slice(28), "Hank", "lima", "oslo"];
  for (const s of secrets) {
    assert.ok(!stored.includes(s), "the identity stores " + s.slice(0, 6) + "...");
    assert.ok(!raw.includes(s), "the sealed list's bytes hold " + s.slice(0, 6) + "...");
  }
  assert.deepEqual(w.harness(id).all("SELECT slot, kind FROM aks").map((x) => [x.slot, x.kind]), [["key", "key"]], "one slot, the key's");
  const q = dump(w.harness(AGENT_QUOTA_ROOM));
  for (const s of [...Object.keys(rooms), "10.3.0.9"]) assert.ok(!q.includes(s), "the counters store " + s);
  // the key opens them, and its answer carries no token
  const g = await read(agentRoute(w.rc("GET", "/api/agent", { headers: { Authorization: "Bearer " + key } })));
  assert.deepEqual(g.json.rooms.map((x) => [x.room, x.name]), Object.entries(rooms));
  for (const t of Object.values(tok)) assert.ok(!g.text.includes(t));
});
