// The three hook methods an agent key calls (worker/room/muse.ts
// museSetHookLook, museDropLook, museHookLook) on the real Room over
// node:sqlite (room-harness.mjs), against the Muse bridge in the same
// process (bridge-world.mjs): every inv column of the member's row is the
// same before and after each (they open nothing and mark nobody seen); an
// invite never opened is refused not_joined and set no hook; a set replaces
// a webhook and a hook on another link (that link loses the room at the
// bridge); a drop removes only a Muse hook on the same link, and keeps a
// webhook and another link's, and says which link is on after it; the drop
// and the look answer for a revoked or left seat too, which matters in an
// older room where two active invites' names fold alike (a revoke keeps
// their shared hook); a token the room never had is refused; the look says
// which link the hook is on and writes nothing; a set carries its
// deadline, which the room keeps by its own clock, and every answer carries
// that clock; and the bridge hears each hook set and each removed (its room
// count). Run with `npm run test:unit`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeRoom } from "./room-harness.mjs";
import { bridgeWorld } from "./bridge-world.mjs";
import { museBridge, museNotJoined, museReportRoom } from "../../worker/room/muse.ts";

const R = "hooks-unit";
/** a deadline far ahead of the room's clock */
const LATER = Date.now() + 3600e3;
/** an answer without the room's clock in it, which every answer of the three carries */
const noNow = (r) => { assert.equal(typeof r.now, "number", "the room's clock: " + JSON.stringify(r)); const { now: _now, ...rest } = r; return rest; };
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
    const set = h.room.museSetHookLook("tok-Ada", link, "agent-chat", R, LATER);
    assert.equal(set.ok, true, JSON.stringify(set));
    assert.deepEqual(invRow(h, "Ada"), before, "the set wrote nothing in inv");
    assert.deepEqual(hookOf(h, "Ada"), { kind: "muse", link, url: null, routing: "agent-chat", enabled: 1 });
    assert.equal(set.name, "Ada");
    assert.ok(!JSON.stringify(set).includes(link), "the answer has no link id");
    const drop = h.room.museDropLook("tok-Ada", link);
    assert.deepEqual(noNow(drop), { ok: true, removed: true, link: null }, "removed, and no hook on after it");
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
    assert.deepEqual(noNow(h.room.museSetHookLook(tok, link, "agent-chat", R, LATER)), { ok: false, status: 409, code: "not_joined", error: museNotJoined(true) });
    assert.equal(museNotJoined(true), "You have not joined this room yet, so no wake was set up in it: a wake would join it. Make a first call that joins it (get_room_state with this room, say), then register it with a new code from the gadget: this one was used for your other rooms.");
    assert.equal(museNotJoined(false), "You have not joined this room yet, so no wake was set up in it: a wake would join it. Make a first call that joins it (get_room_state with this room, say), then register it again: this code was not used, so it still works until it expires.");
    assert.deepEqual(invRow(h, "Bo"), before);
    assert.equal(invRow(h, "Bo").used, null);
    assert.equal(hookOf(h, "Bo"), null);
    assert.deepEqual(noNow(h.room.museDropLook(tok, link)), { ok: true, removed: false, link: null }, "nothing to drop");
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
    assert.deepEqual(noNow(h.room.museDropLook("tok-Ada", one.link)), { ok: true, removed: false, link: two.link }, "it says which link is on after it");
    assert.deepEqual(hookOf(h, "Ada"), { kind: "muse", link: two.link, url: null, routing: "main", enabled: 1 }, "another link's hook stays");
    // a webhook stays too
    assert.equal(h.room.webhookSet("tok-Ada", "https://hooks.example.org/x", "secret", R).ok, true);
    assert.deepEqual(noNow(h.room.museDropLook("tok-Ada", one.link)), { ok: true, removed: false, link: null }, "a webhook is no Muse link");
    assert.equal(hookOf(h, "Ada").kind, "webhook");
    // a set through the key replaces the webhook
    assert.equal(h.room.museSetHookLook("tok-Ada", one.link, "agent-chat", R, LATER).ok, true);
    assert.deepEqual(hookOf(h, "Ada"), { kind: "muse", link: one.link, url: null, routing: "agent-chat", enabled: 1 });
    // and one on another link: that link loses the room at the bridge
    await museReportRoom(museBridge(b.env), two.link, R, true);
    assert.equal(h.room.museSetHook("tok-Ada", two.link, "main", R).ok, true);
    assert.equal(await b.rooms(two.link), 1);
    assert.equal(h.room.museSetHookLook("tok-Ada", one.link, "agent-chat", R, LATER).ok, true);
    await h.settled();
    assert.equal(await b.rooms(two.link), 0, "the replaced link was told the room is gone");
    assert.deepEqual(noNow(h.room.museDropLook("tok-Ada", one.link)), { ok: true, removed: true, link: null });
  } finally {
    b.restore();
  }
});

test("a revoked seat: the set refuses it, the drop and the look answer for it; a token the room never had is refused; a room with no storage answers room_missing", async () => {
  const b = await bridgeWorld();
  try {
    const h = makeRoom({ env: b.env });
    h.member("Ada", "agent");
    const { link } = await b.connect();
    assert.equal(h.room.museSetHookLook("tok-Ada", link, "agent-chat", R, LATER).ok, true);
    h.room.revoke("tok-Ada");
    assert.equal(hookOf(h, "Ada"), null, "the revoke took the hook");
    assert.deepEqual(noNow(h.room.museDropLook("tok-Ada", link)), { ok: true, removed: false, link: null }, "the drop answers for the revoked seat: nothing there");
    assert.equal(h.room.museSetHookLook("tok-Ada", link, "agent-chat", R, LATER).code, "invite_revoked");
    assert.deepEqual(noNow(h.room.museHookLook("tok-Ada")), { ok: true, link: null }, "the look answers for the revoked seat: no hook there");
    assert.equal(h.room.museDropLook("tok-nobody", link).code, "invite_invalid");
    assert.equal(h.room.museHookLook("tok-nobody").code, "invite_invalid");
    const bare = makeRoom({ bare: true, env: b.env });
    for (const r of [bare.room.museSetHookLook("tok-Ada", link, "agent-chat", R, LATER), bare.room.museDropLook("tok-Ada", link), bare.room.museHookLook("tok-Ada")]) {
      assert.deepEqual(noNow(r), { ok: false, status: 404, code: "room_missing", error: "No room with that name" });
    }
  } finally {
    b.restore();
  }
});

// An older room holding two active invites whose names fold alike (the name
// rules once let this through): hooks are filed by the folded name, and a
// revoke drops that hook only when no other active invite's name folds the
// same, so the hook the key's seat set outlives the seat.
function sharedNameRoom(env) {
  const h = makeRoom({ env });
  const now = Date.now();
  h.db.prepare("INSERT INTO inv (token, name, created, kind, used, seen) VALUES ('tok-scout-upper-0000000', 'Scout', ?, 'agent', ?, ?)").run(now - 5000, now - 4000, now - 4000);
  h.db.prepare("INSERT INTO inv (token, name, created, kind, used, seen) VALUES ('tok-scout-lower-0000000', 'scout', ?, 'agent', ?, ?)").run(now - 3000, now - 2000, now - 2000);
  return h;
}
const hooksAll = (h) => h.all("SELECT member, kind, link FROM mh").map((r) => ({ ...r }));

for (const how of ["revoked by the owner", "left"]) {
  test("a seat " + how + " in a room where another active invite's name folds the same: the drop through its token removes the hook it set, and nothing else", async () => {
    const b = await bridgeWorld();
    try {
      const h = sharedNameRoom(b.env);
      const one = await b.connect(), two = await b.connect();
      assert.equal(h.room.museSetHookLook("tok-scout-upper-0000000", one.link, "agent-chat", R, LATER).ok, true);
      if (how === "left") assert.equal((await h.room.leave("tok-scout-upper-0000000", R, false)).ok, true);
      else h.room.revoke("tok-scout-upper-0000000");
      assert.equal(h.one("SELECT revoked IS NOT NULL AS gone FROM inv WHERE token = 'tok-scout-upper-0000000'").gone, 1, "the seat is gone");
      assert.deepEqual(hooksAll(h), [{ member: "scout", kind: "muse", link: one.link }], "and its hook is still on: the room keeps a name's hook while another invite folds alike");
      assert.deepEqual(noNow(h.room.museHookLook("tok-scout-upper-0000000")), { ok: true, link: one.link }, "the look through the gone seat sees it");
      const seat = () => ({ ...h.one("SELECT * FROM inv WHERE token = 'tok-scout-upper-0000000'") });
      const before = seat();
      // the hook the other invite set itself, on another link, is not the key's: it stays
      assert.equal(h.room.museSetHook("tok-scout-lower-0000000", two.link, "main", R).ok, true);
      assert.deepEqual(noNow(h.room.museDropLook("tok-scout-upper-0000000", one.link)), { ok: true, removed: false, link: two.link });
      assert.deepEqual(hooksAll(h), [{ member: "scout", kind: "muse", link: two.link }]);
      // so does its webhook
      assert.equal(h.room.webhookSet("tok-scout-lower-0000000", "https://hooks.example.org/x", "s", R).ok, true);
      assert.deepEqual(noNow(h.room.museDropLook("tok-scout-upper-0000000", one.link)), { ok: true, removed: false, link: null });
      assert.equal(hooksAll(h)[0].kind, "webhook");
      // the key's link back on that name, as it was right after the revoke: the drop removes it
      assert.equal(h.room.museSetHook("tok-scout-lower-0000000", one.link, "agent-chat", R).ok, true);
      assert.deepEqual(noNow(h.room.museDropLook("tok-scout-upper-0000000", one.link)), { ok: true, removed: true, link: null });
      assert.deepEqual(hooksAll(h), []);
      assert.deepEqual(seat(), before, "the gone seat's row as it was: nothing opened, used or seen");
      await h.settled();
    } finally {
      b.restore();
    }
  });
}

test("museHookLook says which Muse link the member's hook is on and writes nothing", async () => {
  const b = await bridgeWorld();
  try {
    const h = makeRoom({ env: b.env });
    h.member("Ada", "agent");
    const { link } = await b.connect();
    const before = invRow(h, "Ada");
    assert.deepEqual(noNow(h.room.museHookLook("tok-Ada")), { ok: true, link: null });
    assert.equal(h.room.museSetHookLook("tok-Ada", link, "agent-chat", R, LATER).ok, true);
    const hooks = h.all("SELECT * FROM mh").map((r) => ({ ...r }));
    assert.deepEqual(noNow(h.room.museHookLook("tok-Ada")), { ok: true, link });
    assert.deepEqual(h.all("SELECT * FROM mh").map((r) => ({ ...r })), hooks, "the look wrote no hook");
    assert.deepEqual(invRow(h, "Ada"), before, "nor any inv column");
    assert.equal(h.room.webhookSet("tok-Ada", "https://hooks.example.org/x", "s", R).ok, true);
    assert.deepEqual(noNow(h.room.museHookLook("tok-Ada")), { ok: true, link: null }, "a webhook is no Muse link");
    assert.equal(h.room.museHookLook("tok-nobody").code, "invite_invalid");
    await h.settled();
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
    assert.equal(h.room.museSetHookLook("tok-Ada", link, "agent-chat", R, LATER).ok, true);
    await museReportRoom(museBridge(b.env), link, R, true);
    assert.equal(await b.rooms(link), 1, "counted once the caller reports it");
    assert.deepEqual(noNow(h.room.museDropLook("tok-Ada", link)), { ok: true, removed: true, link: null });
    await h.settled();
    assert.equal(await b.rooms(link), 0, "the drop told the bridge");
    // the members list shows the delivery while it is on, and not after
    assert.equal(h.room.members().members.find((m) => m.name === "Ada").muse_delivery, false);
  } finally {
    b.restore();
  }
});

test("a set carries its deadline and the room keeps it by its own clock: just before, the set is taken; just after, it is refused too_late and sets nothing; every answer carries the room's clock", async () => {
  const b = await bridgeWorld();
  try {
    const h = makeRoom({ env: b.env });
    h.member("Ada", "agent");
    const { link } = await b.connect();
    let clock = 1_000_000;
    h.room.museNow = () => clock;
    const before = invRow(h, "Ada");
    // the deadline itself: still taken
    let r = h.room.museSetHookLook("tok-Ada", link, "agent-chat", R, clock);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.now, clock, "the room's clock in the answer");
    assert.deepEqual(h.room.museDropLook("tok-Ada", link), { ok: true, removed: true, link: null, now: clock });
    // one millisecond after it: refused, nothing set, nothing read of the seat
    clock += 1;
    r = h.room.museSetHookLook("tok-Ada", link, "agent-chat", R, clock - 1);
    assert.deepEqual(r, { ok: false, status: 409, code: "too_late", error: "This registration reached the room after its time, so nothing was set.", now: clock });
    assert.equal(hookOf(h, "Ada"), null);
    assert.deepEqual(invRow(h, "Ada"), before);
    // a deadline that is no number is never taken
    assert.equal(h.room.museSetHookLook("tok-Ada", link, "agent-chat", R, undefined).code, "too_late");
    // the look and the drop carry the clock, refusals included
    assert.deepEqual(h.room.museHookLook("tok-Ada"), { ok: true, link: null, now: clock });
    assert.equal(h.room.museHookLook("tok-nobody").now, clock);
    assert.equal(h.room.museDropLook("tok-nobody", link).now, clock);
    await h.settled();
  } finally {
    b.restore();
  }
});
