// A member's avatar (worker/room/members.ts, setAvatar) on the real Room
// class (room-harness.mjs): two sets for one name at once. Each stored its
// picture, then recorded it and deleted the picture it had read before
// its put - the same old one for both - so the picture recorded first and
// then overwritten stayed in storage with nothing pointing at it, past
// the room's delete.
import test from "node:test";
import assert from "node:assert/strict";
import { makeRoom } from "./room-harness.mjs";

const R = "unit";
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]).buffer;
const tick = () => new Promise((r) => setTimeout(r, 5));
const avatars = (h) => [...h.objects.keys()].filter((k) => k.startsWith("avatars/")).sort();

/** a room whose puts can be held: each hold() catches the next put */
function heldRoom() {
  const gates = [];
  const h = makeRoom({ put: async () => { const g = gates.shift(); if (!g) return; g.reached(); await g.gate; } });
  return {
    h,
    /** the next put not yet caught waits; answers { reached, release } */
    hold() {
      let release, reached;
      const gate = new Promise((res) => { release = res; });
      const r = new Promise((res) => { reached = res; });
      gates.push({ gate, reached });
      return { reached: r, release: () => release() };
    },
  };
}

test("an avatar set that finishes after a later one is dropped, and only the later picture stays", async () => {
  const { h, hold } = heldRoom();
  h.member("Bob");
  const first = await h.room.setAvatar("Bob", PNG, "image/png", R);
  assert.equal(avatars(h).length, 1);
  await tick();
  const held = hold();
  const older = h.room.setAvatar("Bob", PNG, "image/png", R);
  await held.reached;
  await tick();
  const newer = await h.room.setAvatar("Bob", PNG, "image/png", R);
  held.release();
  const olderVer = await older;
  assert.ok(newer > first);
  assert.equal(olderVer, newer, "the set that lost answers the picture that stays");
  const rec = h.one("SELECT avatar_key, avatar_ver FROM inv WHERE name = 'Bob'");
  assert.equal(rec.avatar_ver, newer, "the later upload stays recorded");
  assert.deepEqual(avatars(h), [rec.avatar_key], "and is the only picture in storage: the first and the one that lost are gone");
});

test("an avatar set recorded while a later one was storing is replaced by it, and its picture deleted", async () => {
  const { h, hold } = heldRoom();
  h.member("Bob");
  await h.room.setAvatar("Bob", PNG, "image/png", R);
  await tick();
  const ha = hold();
  const a = h.room.setAvatar("Bob", PNG, "image/png", R);
  await ha.reached;
  await tick();
  const hb = hold();
  const b = h.room.setAvatar("Bob", PNG, "image/png", R);
  await hb.reached;
  ha.release();
  const av = await a; // records first, while the later one still stores
  hb.release();
  const bv = await b;
  assert.ok(bv > av);
  const rec = h.one("SELECT avatar_key, avatar_ver FROM inv WHERE name = 'Bob'");
  assert.equal(rec.avatar_ver, bv, "the later upload is recorded");
  assert.deepEqual(avatars(h), [rec.avatar_key], "and the picture it replaced is deleted, not left behind");
});

test("two avatar sets begun before either is recorded leave one picture, the later one", async () => {
  const { h, hold } = heldRoom();
  h.member("Bob");
  await h.room.setAvatar("Bob", PNG, "image/png", R);
  await tick();
  // A begins first and is held; B begins later and records first; then A
  // records. Before, A overwrote B's pointer and deleted only the first
  // picture, so B's stayed with nothing pointing at it.
  const held = hold();
  const a = h.room.setAvatar("Bob", PNG, "image/png", R);
  await held.reached;
  await tick();
  const b = await h.room.setAvatar("Bob", PNG, "image/png", R);
  held.release();
  await a;
  await h.room.clearAvatar("Bob");
  assert.deepEqual(avatars(h), [], "removing the avatar leaves nothing behind");
  assert.ok(b);
});
