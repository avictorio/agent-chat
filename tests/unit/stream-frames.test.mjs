// The stream frames that tell an open page or agent what it cannot see
// otherwise (Room.ts, members.ts, messages.ts, on room-harness.mjs): a
// members frame on every change to the members list.
import test from "node:test";
import assert from "node:assert/strict";
import { makeRoom } from "./room-harness.mjs";

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
  return frames;
}

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
