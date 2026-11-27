// The two hook methods an agent key calls (worker/room/muse.ts
// museSetHookLook, museDropLook) on the real Room over node:sqlite
// (room-harness.mjs), against the Muse bridge in the same process
// (bridge-world.mjs): every inv column of the member's row is the same
// before and after each (they open nothing and mark nobody seen); an invite
// never opened is refused not_joined and set no hook; a set replaces a
// webhook and a hook on another link (that link loses the room at the
// bridge); a drop removes only a Muse hook on the same link, and keeps a
// webhook and another link's; a revoked seat is refused; and the bridge
// hears each hook set and each removed (its room count). Run with
// `npm run test:unit`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeRoom } from "./room-harness.mjs";
import { bridgeWorld } from "./bridge-world.mjs";
import { museBridge, museReportRoom, MUSE_NOT_JOINED } from "../../worker/room/muse.ts";

const R = "hooks-unit";
/** the member's inv row, every column */
const invRow = (h, name) => ({ ...h.one("SELECT * FROM inv WHERE name = ?", name) });
const hookOf = (h, name) => h.all("SELECT kind, link, url, routing, enabled FROM mh WHERE name = ?", name).map((r) => ({ ...r }))[0] || null;

test("museSetHookLook and museDropLook leave every inv column of the member's row as it was", async () => {
  const b = await bridgeWorld();
  try {
    const h = makeRoom({ env: b.env });
    h.member("Ada", "agent");
    // seen a while ago: an access() would stamp it again
    h.db.prepare("UPDATE inv SET seen = ? WHERE name = 'Ada'").run(Date.now() - 3600e3);
    const { link } = await b.connect();
    const before = invRow(h, "Ada");
    const set = h.room.museSetHookLook("tok-Ada", link, "agent-chat", R);
    assert.equal(set.ok, true, JSON.stringify(set));
    assert.deepEqual(invRow(h, "Ada"), before, "the set wrote nothing in inv");
    assert.deepEqual(hookOf(h, "Ada"), { kind: "muse", link, url: null, routing: "agent-chat", enabled: 1 });
    assert.equal(set.name, "Ada");
    assert.ok(!JSON.stringify(set).includes(link), "the answer has no link id");
    const drop = h.room.museDropLook("tok-Ada", link);
    assert.deepEqual(drop, { ok: true, removed: true });
    assert.deepEqual(invRow(h, "Ada"), before, "the drop wrote nothing in inv");
    assert.equal(hookOf(h, "Ada"), null);
    await h.settled();
  } finally {
    b.restore();
  }
});

test("an invite never opened is refused not_joined, stays unopened, and gets no hook", async () => {
  const b = await bridgeWorld();
  try {
    const h = makeRoom({ env: b.env });
    const tok = h.room.invite("Bo", "agent", null).token;
    const { link } = await b.connect();
    const before = invRow(h, "Bo");
    assert.deepEqual(h.room.museSetHookLook(tok, link, "agent-chat", R), { ok: false, status: 409, code: "not_joined", error: MUSE_NOT_JOINED });
    assert.equal(MUSE_NOT_JOINED, "You have not joined this room yet: a wake would join it. Join it first (any call that joins), then register it with a new code.");
    assert.deepEqual(invRow(h, "Bo"), before);
    assert.equal(invRow(h, "Bo").used, null);
    assert.equal(hookOf(h, "Bo"), null);
    assert.deepEqual(h.room.museDropLook(tok, link), { ok: true, removed: false }, "nothing to drop");
  } finally {
    b.restore();
  }
});

test("a drop removes only a Muse hook on the same link: a webhook and another link's stay; a set replaces either", async () => {
  const b = await bridgeWorld();
  try {
    const h = makeRoom({ env: b.env });
    h.member("Ada", "agent");
    const one = await b.connect(), two = await b.connect();
    // a hook the agent set itself, with the room's own token, on another link
    assert.equal(h.room.museSetHook("tok-Ada", two.link, "main", R).ok, true);
    assert.deepEqual(h.room.museDropLook("tok-Ada", one.link), { ok: true, removed: false });
    assert.deepEqual(hookOf(h, "Ada"), { kind: "muse", link: two.link, url: null, routing: "main", enabled: 1 }, "another link's hook stays");
    // a webhook stays too
    assert.equal(h.room.webhookSet("tok-Ada", "https://hooks.example.org/x", "secret", R).ok, true);
    assert.deepEqual(h.room.museDropLook("tok-Ada", one.link), { ok: true, removed: false });
    assert.equal(hookOf(h, "Ada").kind, "webhook");
    // a set through the key replaces the webhook
    assert.equal(h.room.museSetHookLook("tok-Ada", one.link, "agent-chat", R).ok, true);
    assert.deepEqual(hookOf(h, "Ada"), { kind: "muse", link: one.link, url: null, routing: "agent-chat", enabled: 1 });
    // and one on another link: that link loses the room at the bridge
    await museReportRoom(museBridge(b.env), two.link, R, true);
    assert.equal(h.room.museSetHook("tok-Ada", two.link, "main", R).ok, true);
    assert.equal(await b.rooms(two.link), 1);
    assert.equal(h.room.museSetHookLook("tok-Ada", one.link, "agent-chat", R).ok, true);
    await h.settled();
    assert.equal(await b.rooms(two.link), 0, "the replaced link was told the room is gone");
    assert.deepEqual(h.room.museDropLook("tok-Ada", one.link), { ok: true, removed: true });
  } finally {
    b.restore();
  }
});

test("a revoked or left seat is refused by both, and a room with no storage answers room_missing", async () => {
  const b = await bridgeWorld();
  try {
    const h = makeRoom({ env: b.env });
    h.member("Ada", "agent");
    const { link } = await b.connect();
    assert.equal(h.room.museSetHookLook("tok-Ada", link, "agent-chat", R).ok, true);
    h.room.revoke("tok-Ada");
    assert.equal(hookOf(h, "Ada"), null, "the revoke took the hook");
    assert.equal(h.room.museDropLook("tok-Ada", link).code, "invite_revoked");
    assert.equal(h.room.museSetHookLook("tok-Ada", link, "agent-chat", R).code, "invite_revoked");
    assert.equal(h.room.museDropLook("tok-nobody", link).code, "invite_invalid");
    const bare = makeRoom({ bare: true, env: b.env });
    assert.deepEqual(bare.room.museSetHookLook("tok-Ada", link, "agent-chat", R), { ok: false, status: 404, code: "room_missing", error: "No room with that name" });
    assert.deepEqual(bare.room.museDropLook("tok-Ada", link), { ok: false, status: 404, code: "room_missing", error: "No room with that name" });
  } finally {
    b.restore();
  }
});

test("the bridge hears the hook set (museReportRoom) and the hook removed (museReportGone, after the answer)", async () => {
  const b = await bridgeWorld();
  try {
    const h = makeRoom({ env: b.env });
    h.member("Ada", "agent");
    const { code, link } = await b.connect();
    assert.equal((await b.call("/claim", { code })).status, 200);
    assert.equal(await b.rooms(link), 0);
    assert.equal(h.room.museSetHookLook("tok-Ada", link, "agent-chat", R).ok, true);
    await museReportRoom(museBridge(b.env), link, R, true);
    assert.equal(await b.rooms(link), 1, "counted once the caller reports it");
    assert.deepEqual(h.room.museDropLook("tok-Ada", link), { ok: true, removed: true });
    await h.settled();
    assert.equal(await b.rooms(link), 0, "the drop told the bridge");
    // the members list shows the delivery while it is on, and not after
    assert.equal(h.room.members().members.find((m) => m.name === "Ada").muse_delivery, false);
  } finally {
    b.restore();
  }
});
