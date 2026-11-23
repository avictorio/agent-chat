// The stream frames that tell an open page or agent what it cannot see
// otherwise (Room.ts, members.ts, messages.ts, on room-harness.mjs): a
// members frame on every change to the members list, a delete frame when
// a message is deleted (live, and in a reconnect's replay), and a gap
// frame when a replay cannot give everything past its cursor.
import test from "node:test";
import assert from "node:assert/strict";
import { makeRoom } from "./room-harness.mjs";
import { KEEP } from "../../worker/limits.ts";

/** a stream client that records its frames as {event, id, data} */
function listen(h, opts = {}) {
  const frames = [];
  const c = {
    token: opts.token || "", owner: opts.owner ?? true, name: opts.name || "", kinds: opts.kinds || null, games: null, stateSub: false, stateKey: null,
    send: (s) => {
      if (s.startsWith(":") || s.startsWith("retry:")) return;
      const f = { event: "message", id: null, data: null };
      for (const line of s.split("\n")) {
        if (line.startsWith("event: ")) f.event = line.slice(7);
        else if (line.startsWith("id: ")) f.id = Number(line.slice(4));
        else if (line.startsWith("data: ")) f.data = JSON.parse(line.slice(6));
      }
      frames.push(f);
    },
    close() { h.room.clients.delete(c); },
  };
  h.room.clients.add(c);
  frames.client = c;
  return frames;
}

/** what a stream opened with after= is sent before it goes live, asking for kinds (null: all) */
function replayed(h, after, kinds = null) {
  const frames = listen(h, { kinds: kinds && new Set(kinds) });
  h.room.clients.delete(frames.client);
  h.room.replay(frames.client, "unit", after);
  return frames;
}

const post = (h, text) => h.room.post("Ada", text, "unit", false);

const members = (frames) => frames.filter((f) => f.event === "members").map((f) => f.data.from);

test("an invite, its first open, a changed kind and a revoke each send a members frame", () => {
  const h = makeRoom();
  h.member("Henry");
  const seen = listen(h, { owner: false, name: "Henry", token: "tok-Henry" });
  const inv = h.room.invite("Probe", "agent", null);
  assert.deepEqual(members(seen), ["Probe"], "the invite");
  assert.equal(seen[0].data.kind, "agent");
  assert.deepEqual(seen[0].data.targets, []);

  assert.equal(h.room.access(inv.token, false).ok, true);
  assert.deepEqual(members(seen), ["Probe", "Probe"], "the first open");
  h.room.access(inv.token, false);
  assert.equal(members(seen).length, 2, "a later read is no change");

  h.room.setKind("Probe", "human");
  assert.deepEqual(members(seen), ["Probe", "Probe", "Probe"], "a changed kind");

  const probe = listen(h, { owner: false, name: "Probe", token: inv.token });
  assert.equal(h.room.revoke(inv.token), true);
  assert.deepEqual(members(seen), ["Probe", "Probe", "Probe", "Probe"], "the revoke");
  assert.equal(members(probe).length, 0, "the member removed is not told");
});

test("revoking everyone sends the owner's streams a members frame", async () => {
  const h = makeRoom();
  h.member("Henry");
  const owner = listen(h);
  await h.room.revokeAll();
  assert.deepEqual(members(owner), [null]);
});

test("a members frame goes only to streams that asked for members", () => {
  const h = makeRoom();
  const msgs = listen(h, { kinds: new Set(["message"]) });
  const all = listen(h);
  h.room.invite("Probe", "agent", null);
  assert.equal(msgs.length, 0);
  assert.equal(members(all).length, 1);
});

test("deleting a live message sends a delete frame under a delivery number of its own; a draft's sends none", async () => {
  const h = makeRoom();
  h.member("Ada");
  const m1 = await post(h, "one");
  const draft = await h.room.post("Ada", "draft", "unit", false, null, null, null, true);
  const all = listen(h, { owner: false, name: "Bob", token: "t" });
  const msgs = listen(h, { kinds: new Set(["message"]) });
  assert.equal((await h.room.deleteMessage(m1.id, "Ada", false)).status, 200);
  const del = all.filter((f) => f.event === "delete");
  assert.equal(del.length, 1);
  assert.deepEqual(del[0].data, { type: "delete", room: "unit", from: "Ada", kind: "agent", targets: [], id: m1.id });
  assert.ok(del[0].id > draft.id, "a fresh number, past every id handed out: " + del[0].id);
  assert.equal(msgs.length, 0, "only to streams that asked for deletes");
  await h.room.deleteMessage(draft.id, "Ada", false);
  assert.equal(all.filter((f) => f.event === "delete").length, 1, "a draft was never shown: no frame");
  // the owner key deletes as no one
  const m2 = await post(h, "two");
  await h.room.deleteMessage(m2.id, "", true);
  assert.deepEqual(all.filter((f) => f.event === "delete").map((f) => [f.data.id, f.data.from, f.data.kind]).pop(), [m2.id, null, null]);
});

test("a reconnect replays the deletes past its cursor, in order with the messages", async () => {
  const h = makeRoom();
  const ids = [];
  for (let i = 0; i < 4; i++) ids.push((await post(h, "m" + i)).id);
  const cursor = ids[1];
  await h.room.deleteMessage(ids[0], "Ada", false); // held before the cursor: deleted while away
  await h.room.deleteMessage(ids[2], "Ada", false);
  const m5 = await post(h, "after the deletes");
  const got = replayed(h, cursor).map((f) => [f.event, f.event === "delete" ? f.data.id : f.data.id, f.id]);
  assert.deepEqual(got.map((g) => g.slice(0, 2)), [["message", ids[3]], ["delete", ids[0]], ["delete", ids[2]], ["message", m5.id]]);
  assert.deepEqual(got.map((g) => g[2]), [...got.map((g) => g[2])].sort((a, b) => a - b), "delivery order");
  // from the delete's own number, nothing is sent again
  const last = replayed(h, got[got.length - 1][2]);
  assert.equal(last.length, 0);
  // a stream that did not ask for deletes gets the messages only
  assert.deepEqual(replayed(h, cursor, ["message"]).map((f) => f.event), ["message", "message"]);
});

test("the stream accepts delete and gap in events=, and replays a delete", async () => {
  const h = makeRoom();
  h.member("Ada");
  const a = await post(h, "a");
  const b = await post(h, "b");
  await h.room.deleteMessage(b.id, "Ada", false);
  const r = await h.room.fetch(new Request("https://room/stream?room=unit&after=" + a.id + "&events=message,delete,gap", { headers: { "X-Invite-Token": "tok-Ada" } }));
  assert.equal(r.status, 200);
  const reader = r.body.getReader();
  let text = "";
  while (!text.includes("event: delete")) text += new TextDecoder().decode((await reader.read()).value);
  assert.match(text, /id: \d+\nevent: delete\ndata: \{"type":"delete","room":"unit","from":"Ada","kind":"agent","targets":\[\],"id":/);
  await reader.cancel();
  for (const c of [...h.room.clients]) c.close();
  clearInterval(h.room.pinger);
  const bad = await h.room.fetch(new Request("https://room/stream?room=unit&after=latest&events=bogus", { headers: { "X-Invite-Token": "tok-Ada" } }));
  assert.equal(bad.status, 400);
  assert.match(await bad.text(), /delete, gap, all/);
});

test("a replay from below the messages the room no longer keeps starts with a gap frame", async () => {
  const h = makeRoom();
  const first = await post(h, "first");
  for (let i = 0; i < KEEP + 4; i++) await post(h, "m" + i);
  const kept = h.one("SELECT MIN(id) AS n FROM m").n;
  const frames = replayed(h, first.id);
  assert.equal(frames[0].event, "gap");
  assert.equal(frames[0].id, null, "a gap moves no cursor");
  assert.deepEqual(frames[0].data, { type: "gap", room: "unit", from: null, kind: null, targets: [], after: first.id, through: kept - 1 });
  assert.equal(frames[1].data.id, kept, "then everything still held");
  assert.equal(frames.filter((f) => f.event === "message").length, KEEP);
  // a cursor at or past the last trimmed number lost nothing
  assert.equal(replayed(h, kept - 1)[0].event, "message");
  assert.equal(replayed(h, kept - 1, ["message"]).filter((f) => f.event === "gap").length, 0);
  assert.equal(replayed(h, first.id, ["message"]).filter((f) => f.event === "gap").length, 0, "only to streams that asked for gaps");
});

test("deletes past the newest KEEP are dropped, and a replay from below them gets a gap", () => {
  const h = makeRoom();
  for (let i = 1; i <= KEEP + 3; i++) h.db.prepare("INSERT INTO mdel (dn, id, ts, who) VALUES (?, ?, ?, NULL)").run(100 + i, i, Date.now());
  h.room.trimDeletes();
  assert.equal(h.one("SELECT COUNT(*) AS n FROM mdel").n, KEEP);
  assert.equal(h.room.forgotten(), 103);
  assert.equal(replayed(h, 50)[0].event, "gap");
  assert.equal(replayed(h, 103)[0].event, "delete");
});

test("a replay gives every message past the cursor, past KEEP of them too", async () => {
  const h = makeRoom();
  const drafts = [];
  for (let i = 0; i < 5; i++) drafts.push(await h.room.post("Ada", "d" + i, "unit", false, null, null, null, true));
  for (let i = 0; i < KEEP; i++) await post(h, "m" + i);
  // published drafts are not trimmed until the next post: KEEP + 5 live
  for (const d of drafts) assert.equal((await h.room.publishMessage(d.id, "Ada", false, "unit", undefined)).status, 200);
  const frames = replayed(h, 0);
  assert.equal(frames.filter((f) => f.event === "gap").length, 0);
  assert.equal(frames.length, KEEP + 5);
  assert.deepEqual(frames.slice(-5).map((f) => f.data.id), drafts.map((d) => d.id), "the newest last");
});

test("a room created again tells a stream from the old room's numbers that they are gone", async () => {
  const h = makeRoom();
  const m = await post(h, "old room");
  await h.room.destroy("unit");
  assert.equal(h.room.create(), true);
  const frames = replayed(h, 0);
  assert.deepEqual(frames.map((f) => [f.event, f.data.through]), [["gap", m.id]]);
});
