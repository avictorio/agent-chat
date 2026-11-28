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
    assert.deepEqual(noNow(drop), { ok: true, removed: true, link: null, on: null }, "removed, and no hook on after it");
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
    assert.deepEqual(noNow(h.room.museDropLook(tok, link)), { ok: true, removed: false, link: null, on: null }, "nothing to drop");
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
    assert.deepEqual(noNow(h.room.museDropLook("tok-Ada", one.link)), { ok: true, removed: false, link: null, on: two.link }, "it says which link is on after it, held by no untagged hold of the caller's (self is the member's own)");
    assert.deepEqual(hookOf(h, "Ada"), { kind: "muse", link: two.link, url: null, routing: "main", enabled: 1 }, "another link's hook stays");
    // a webhook stays too
    assert.equal(h.room.webhookSet("tok-Ada", "https://hooks.example.org/x", "secret", R).ok, true);
    assert.deepEqual(noNow(h.room.museDropLook("tok-Ada", one.link)), { ok: true, removed: false, link: null, on: null }, "a webhook is no Muse link");
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
    assert.deepEqual(noNow(h.room.museDropLook("tok-Ada", one.link)), { ok: true, removed: true, link: null, on: null });
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
    assert.deepEqual(noNow(h.room.museDropLook("tok-Ada", link)), { ok: true, removed: false, link: null, on: null }, "the drop answers for the revoked seat: nothing there");
    assert.equal(h.room.museSetHookLook("tok-Ada", link, "agent-chat", R, LATER).code, "invite_revoked");
    assert.deepEqual(noNow(h.room.museHookLook("tok-Ada")), { ok: true, link: null, on: null }, "the look answers for the revoked seat: no hook there");
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
      assert.deepEqual(noNow(h.room.museHookLook("tok-scout-upper-0000000")), { ok: true, link: one.link, on: one.link }, "the look through the gone seat sees it");
      const seat = () => ({ ...h.one("SELECT * FROM inv WHERE token = 'tok-scout-upper-0000000'") });
      const before = seat();
      // the hook the other invite set itself, on another link, is not the key's: it stays
      assert.equal(h.room.museSetHook("tok-scout-lower-0000000", two.link, "main", R).ok, true);
      assert.deepEqual(noNow(h.room.museDropLook("tok-scout-upper-0000000", one.link)), { ok: true, removed: false, link: null, on: two.link });
      assert.deepEqual(hooksAll(h), [{ member: "scout", kind: "muse", link: two.link }]);
      // so does its webhook
      assert.equal(h.room.webhookSet("tok-scout-lower-0000000", "https://hooks.example.org/x", "s", R).ok, true);
      assert.deepEqual(noNow(h.room.museDropLook("tok-scout-upper-0000000", one.link)), { ok: true, removed: false, link: null, on: null });
      assert.equal(hooksAll(h)[0].kind, "webhook");
      // the key's link back on that name, as an untagged set left it right after the revoke: the drop removes it
      assert.equal(h.room.museSetHookLook("tok-scout-lower-0000000", one.link, "agent-chat", R, LATER).ok, true);
      assert.deepEqual(noNow(h.room.museDropLook("tok-scout-upper-0000000", one.link)), { ok: true, removed: true, link: null, on: null });
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
    assert.deepEqual(noNow(h.room.museHookLook("tok-Ada")), { ok: true, link: null, on: null });
    assert.equal(h.room.museSetHookLook("tok-Ada", link, "agent-chat", R, LATER).ok, true);
    const hooks = h.all("SELECT * FROM mh").map((r) => ({ ...r }));
    assert.deepEqual(noNow(h.room.museHookLook("tok-Ada")), { ok: true, link, on: link });
    assert.deepEqual(h.all("SELECT * FROM mh").map((r) => ({ ...r })), hooks, "the look wrote no hook");
    assert.deepEqual(invRow(h, "Ada"), before, "nor any inv column");
    assert.equal(h.room.webhookSet("tok-Ada", "https://hooks.example.org/x", "s", R).ok, true);
    assert.deepEqual(noNow(h.room.museHookLook("tok-Ada")), { ok: true, link: null, on: null }, "a webhook is no Muse link");
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
    assert.deepEqual(noNow(h.room.museDropLook("tok-Ada", link)), { ok: true, removed: true, link: null, on: null });
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
    assert.deepEqual(h.room.museDropLook("tok-Ada", link), { ok: true, removed: true, link: null, on: null, now: clock });
    // one millisecond after it: refused, nothing set, nothing read of the seat
    clock += 1;
    r = h.room.museSetHookLook("tok-Ada", link, "agent-chat", R, clock - 1);
    assert.deepEqual(r, { ok: false, status: 409, code: "too_late", error: "This registration reached the room after its time, so nothing was set.", now: clock });
    assert.equal(hookOf(h, "Ada"), null);
    assert.deepEqual(invRow(h, "Ada"), before);
    // a deadline that is no number is never taken
    assert.equal(h.room.museSetHookLook("tok-Ada", link, "agent-chat", R, undefined).code, "too_late");
    // the look and the drop carry the clock, refusals included
    assert.deepEqual(h.room.museHookLook("tok-Ada"), { ok: true, link: null, on: null, now: clock });
    assert.equal(h.room.museHookLook("tok-nobody").now, clock);
    assert.equal(h.room.museDropLook("tok-nobody", link).now, clock);
    await h.settled();
  } finally {
    b.restore();
  }
});

// ---- The holders of a member's Muse hook (mhh, schema step 10) ----
// Beside each member's hook the room keeps who set it up on its link: a
// holder tag (an identity's), "self" (the room's own registration) or "pre"
// (a set that sent no tag, or a Muse hook step 10 found with no holder). One test per
// writer and per method; then the model of holders-model.mjs (roomCall)
// against the real Room on every state and call it takes.
import { LEGACY_HOLDS } from "../../worker/room/muse.ts";
import { held, roomCall } from "./holders-model.mjs";

/** two holder tags as a key's entry would carry them: 22 characters of base64url */
const TAG_A = "aaaaaaaaaaaaaaaaaaaaaA", TAG_B = "bbbbbbbbbbbbbbbbbbbbbB";
/** a room with Ada, an agent who has joined, whose bridge reports are kept instead of sent */
function holderRoom(o = {}) {
  const h = makeRoom(o);
  h.member("Ada", "agent");
  const gone = [], told = [];
  h.room.museReportGone = (hooks) => { gone.push(...hooks.map((x) => x.link)); };
  const notify = h.room.notifyMembers.bind(h.room);
  h.room.notifyMembers = (name) => { told.push(name); return notify(name); };
  return { h, gone, told };
}
/** Ada's holder rows, sorted */
const rowsOf = (h, member = "ada") => h.all("SELECT holder FROM mhh WHERE member = ? ORDER BY holder", member).map((r) => r.holder);
const linkOf = (h) => { const r = h.all("SELECT kind, link FROM mh WHERE member = 'ada'")[0]; return r ? (r.kind === "muse" ? r.link : "webhook") : null; };
const tables = (h) => JSON.stringify([h.all("SELECT * FROM mh ORDER BY member"), h.all("SELECT member, holder FROM mhh ORDER BY member, holder"), h.all("SELECT * FROM inv ORDER BY token")]);

test("holders: a set with no tag is held by pre, one with a tag by the tag; on the same link the holders stay and the new one joins (the same tag twice is one row); on another link they are cleared", () => {
  const { h } = holderRoom();
  assert.ok(h.room.museSetHookLook("tok-Ada", "L", "agent-chat", R, LATER).ok);
  assert.deepEqual(rowsOf(h), ["pre"]);
  assert.ok(h.room.museSetHookLook("tok-Ada", "L", "agent-chat", R, LATER, TAG_A).ok);
  assert.deepEqual(rowsOf(h), ["pre", TAG_A].sort(), "pre beside a tag");
  assert.ok(h.room.museSetHookLook("tok-Ada", "L", "agent-chat", R, LATER, TAG_B).ok);
  assert.ok(h.room.museSetHookLook("tok-Ada", "L", "agent-chat", R, LATER, TAG_B).ok);
  assert.deepEqual(rowsOf(h), ["pre", TAG_A, TAG_B].sort(), "a second tag beside a first; the same tag twice is one row");
  // another link, through a key or the room's own registration: the holders cleared, then the new one alone
  assert.ok(h.room.museSetHookLook("tok-Ada", "M", "agent-chat", R, LATER, TAG_A).ok);
  assert.deepEqual(rowsOf(h), [TAG_A]);
  assert.ok(h.room.museSetHook("tok-Ada", "L", "main", R).ok);
  assert.deepEqual(rowsOf(h), ["self"]);
  // a fresh member with a tag: the tag alone
  h.member("Bo", "agent");
  assert.ok(h.room.museSetHookLook("tok-Bo", "L", "agent-chat", R, LATER, TAG_B).ok);
  assert.deepEqual(rowsOf(h, "bo"), [TAG_B]);
});

test("holders: the room's own registration is held by self, beside the holders already on that link; a webhook clears them", () => {
  const { h } = holderRoom();
  assert.ok(h.room.museSetHookLook("tok-Ada", "L", "agent-chat", R, LATER, TAG_A).ok);
  assert.ok(h.room.museSetHook("tok-Ada", "L", "main", R).ok);
  assert.deepEqual(rowsOf(h), ["self", TAG_A].sort());
  assert.ok(h.room.webhookSet("tok-Ada", "https://hooks.example.org/x", "s", R).ok);
  assert.deepEqual(rowsOf(h), [], "a webhook has no holders");
  assert.equal(linkOf(h), "webhook");
});

test("holders: a hook removed takes its holders (museRemove, the revoke of a name's last invite, revoke everyone); in a room whose two invites' names fold alike a revoke keeps the hook and its holders, and either seat finds the same member", async () => {
  {
    const { h } = holderRoom();
    assert.ok(h.room.museSetHookLook("tok-Ada", "L", "agent-chat", R, LATER, TAG_A).ok);
    assert.ok(h.room.museRemove("tok-Ada").ok);
    assert.deepEqual(rowsOf(h), []);
  }
  {
    const { h } = holderRoom();
    assert.ok(h.room.museSetHookLook("tok-Ada", "L", "agent-chat", R, LATER).ok);
    h.room.revoke("tok-Ada");
    assert.deepEqual([linkOf(h), rowsOf(h)], [null, []]);
  }
  {
    const { h } = holderRoom();
    h.member("Bo", "agent");
    assert.ok(h.room.museSetHookLook("tok-Ada", "L", "agent-chat", R, LATER).ok);
    assert.ok(h.room.museSetHookLook("tok-Bo", "M", "agent-chat", R, LATER, TAG_B).ok);
    await h.room.revokeAll();
    assert.deepEqual(h.all("SELECT * FROM mhh"), []);
  }
  {
    const h = sharedNameRoom();
    h.room.museReportGone = () => {};
    assert.ok(h.room.museSetHookLook("tok-scout-upper-0000000", "L", "agent-chat", R, LATER, TAG_A).ok);
    h.room.revoke("tok-scout-upper-0000000");
    assert.deepEqual(hooksAll(h), [{ member: "scout", kind: "muse", link: "L" }], "the hook stays");
    assert.deepEqual(rowsOf(h, "scout"), [TAG_A], "and its holders");
    for (const tok of ["tok-scout-upper-0000000", "tok-scout-lower-0000000"]) assert.deepEqual(noNow(h.room.museHolderLook(TAG_A, tok, false)), { ok: true, link: "L", on: "L" }, tok + ": the same member");
  }
});

test("holders: a hook changed in place keeps its holders (museUpdate, and the wake's failure path turning it off)", () => {
  const { h } = holderRoom();
  assert.ok(h.room.museSetHookLook("tok-Ada", "L", "agent-chat", R, LATER, TAG_A).ok);
  assert.ok(h.room.museUpdate("tok-Ada", { routing: "main", muted: true }).ok);
  assert.deepEqual(rowsOf(h), [TAG_A]);
  const row = h.room.museRow("ada");
  h.room.museSettle(row, row, 0, 410, "link_gone", 0, "HTTP 410", 0);
  assert.equal(h.one("SELECT enabled FROM mh WHERE member = 'ada'").enabled, 0, "turned off");
  assert.deepEqual(rowsOf(h), [TAG_A], "still a Muse hook on its link, its holders kept");
});

test("holders: the untagged look and drop (museHookLook, museDropLook) answer every state an untagged set, the room's own registration and a webhook make as the pinned literals say, with on beside; a hold of self or of a tag is not theirs", () => {
  /** [state, its writer] */
  const states = {
    "no hook": () => {},
    "a Muse hook on L held by pre": (h) => h.room.museSetHookLook("tok-Ada", "L", "agent-chat", R, LATER),
    "a Muse hook on L held by self": (h) => h.room.museSetHook("tok-Ada", "L", "main", R),
    "a Muse hook on L held by pre and self": (h) => { h.room.museSetHookLook("tok-Ada", "L", "agent-chat", R, LATER); h.room.museSetHook("tok-Ada", "L", "main", R); },
    "a webhook": (h) => h.room.webhookSet("tok-Ada", "https://hooks.example.org/x", "s", R),
  };
  // the answers as literals: LEGACY_HOLDS is pre alone, so a hook held by pre is the untagged look's and drop's, one
  // held by self alone is not (its drop leaves it on), and one held by both loses pre to the drop and stays, self's;
  // on, the link the hook is on; after the drop of L, the hook's link and its holders
  const pre = { look: { ok: true, link: "L", on: "L" }, dropL: { ok: true, removed: true, link: null, on: null }, dropM: { ok: true, removed: false, link: "L", on: "L" }, after: [null, []] };
  const self = { look: { ok: true, link: null, on: "L" }, dropL: { ok: true, removed: false, link: null, on: "L" }, dropM: { ok: true, removed: false, link: null, on: "L" }, after: ["L", ["self"]] };
  const both = { look: { ok: true, link: "L", on: "L" }, dropL: { ok: true, removed: false, link: null, on: "L" }, dropM: { ok: true, removed: false, link: "L", on: "L" }, after: ["L", ["self"]] };
  const none = { look: { ok: true, link: null, on: null }, dropL: { ok: true, removed: false, link: null, on: null }, dropM: { ok: true, removed: false, link: null, on: null } };
  const wants = { "no hook": none, "a Muse hook on L held by pre": pre, "a Muse hook on L held by self": self, "a Muse hook on L held by pre and self": both, "a webhook": none };
  for (const [what, make] of Object.entries(states)) {
    const want = wants[what];
    for (const [c, call] of [["look", (h) => h.room.museHookLook("tok-Ada")], ["dropL", (h) => h.room.museDropLook("tok-Ada", "L")], ["dropM", (h) => h.room.museDropLook("tok-Ada", "M")]]) {
      const { h } = holderRoom();
      make(h);
      assert.deepEqual(noNow(call(h)), want[c], what + ", " + c);
      if (c === "dropL" && want.after) assert.deepEqual([linkOf(h), rowsOf(h)], want.after, what + ": after the drop");
    }
  }
  // a tag's hold (a state only a tagged set makes): the untagged look sees none, and the drop leaves it
  const { h } = holderRoom();
  h.room.museSetHookLook("tok-Ada", "L", "agent-chat", R, LATER, TAG_A);
  assert.deepEqual(noNow(h.room.museHookLook("tok-Ada")), { ok: true, link: null, on: "L" });
  assert.deepEqual(noNow(h.room.museDropLook("tok-Ada", "L")), { ok: true, removed: false, link: null, on: "L" });
  assert.deepEqual([linkOf(h), rowsOf(h)], ["L", [TAG_A]]);
  assert.deepEqual(LEGACY_HOLDS, ["pre"]);
});

test("museHolderLook: by the tag's row, by the token's seat when the tag has none, with legacy; holder_mismatch, bad_holder, room_missing; on only when a member is found; writes nothing", () => {
  const { h } = holderRoom();
  h.member("Bo", "agent");
  h.room.museSetHookLook("tok-Ada", "L", "agent-chat", R, LATER, TAG_A);
  h.room.museSetHookLook("tok-Bo", "M", "agent-chat", R, LATER);
  const before = tables(h);
  assert.deepEqual(noNow(h.room.museHolderLook(TAG_A, null, false)), { ok: true, link: "L", on: "L" }, "the row finds the seat by itself");
  assert.deepEqual(noNow(h.room.museHolderLook(TAG_A, "tok-Ada", false)), { ok: true, link: "L", on: "L" });
  assert.deepEqual(noNow(h.room.museHolderLook(TAG_B, "tok-Bo", false)), { ok: true, link: null, on: "M" }, "the token's seat: Bo's hook is pre's, not the tag's");
  assert.deepEqual(noNow(h.room.museHolderLook(TAG_B, "tok-Bo", true)), { ok: true, link: "M", on: "M" }, "with legacy, pre counts");
  assert.deepEqual(noNow(h.room.museHolderLook(TAG_B, null, false)), { ok: true, link: null }, "held nowhere, no token: this holder holds nothing, and no member is named");
  assert.deepEqual(noNow(h.room.museHolderLook(TAG_A, "tok-Bo", false)), { ok: false, status: 409, code: "holder_mismatch", error: "This holder tag belongs to another seat in this room." });
  h.db.prepare("INSERT INTO mhh (member, holder, at) VALUES ('bo', ?, 1)").run(TAG_A);
  assert.equal(h.room.museHolderLook(TAG_A, null, false).code, "holder_mismatch", "a tag with rows under two members");
  h.db.prepare("DELETE FROM mhh WHERE member = 'bo' AND holder = ?").run(TAG_A);
  for (const bad of ["pre", "self", "short", TAG_A + "x", "aaaaaaaaaaaaaaaaaaaa+/"]) assert.deepEqual(noNow(h.room.museHolderLook(bad, "tok-Ada", false)), { ok: false, status: 400, code: "bad_holder", error: "This holder tag is not one this room keeps." }, bad);
  assert.equal(h.room.museHolderLook(TAG_B, "tok-nobody", false).code, "invite_invalid", "the seat's refusal when the tag has no row");
  assert.deepEqual(noNow(h.room.museHolderLook(TAG_A, "tok-nobody", false)), { ok: true, link: "L", on: "L" }, "a row decides by itself");
  assert.equal(tables(h), before, "nothing written");
  const bare = makeRoom({ bare: true });
  assert.deepEqual(noNow(bare.room.museHolderLook(TAG_A, "tok-Ada", false)), { ok: false, status: 404, code: "room_missing", error: "No room with that name" });
});

test("museHolderDrop: only the asked holds go; with another holder left the hook stays and nobody hears of it; the last holder's drop removes it, tells the members once and the bridge once; not held on that link, nothing written", () => {
  const { h, gone, told } = holderRoom();
  h.room.museSetHookLook("tok-Ada", "L", "agent-chat", R, LATER, TAG_A);
  h.room.museSetHookLook("tok-Ada", "L", "agent-chat", R, LATER, TAG_B);
  h.room.museSetHookLook("tok-Ada", "L", "agent-chat", R, LATER);
  told.length = 0;
  let before = tables(h);
  assert.deepEqual(noNow(h.room.museHolderDrop(TAG_A, "M", "tok-Ada", false)), { ok: true, removed: false, link: "L", on: "L" }, "not on that link");
  assert.equal(tables(h), before, "nothing written");
  assert.deepEqual(noNow(h.room.museHolderDrop(TAG_A, "L", "tok-Ada", false)), { ok: true, removed: false, link: null, on: "L" });
  assert.deepEqual([rowsOf(h), told, gone], [["pre", TAG_B].sort(), [], []], "the hook stays, held by the others; nobody told");
  before = tables(h);
  assert.deepEqual(noNow(h.room.museHolderDrop(TAG_A, "L", "tok-Ada", false)), { ok: true, removed: false, link: null, on: "L" }, "its hold is gone already");
  assert.equal(tables(h), before);
  assert.deepEqual(noNow(h.room.museHolderDrop(TAG_B, "L", "tok-Ada", true)), { ok: true, removed: true, link: null, on: null }, "with legacy, pre goes too: no holder left");
  assert.deepEqual([linkOf(h), rowsOf(h), told, gone], [null, [], ["Ada"], ["L"]], "the hook went; the members told once, the bridge once");
});

test("every answer of the hook methods carries the room's clock, refusals included, and none changes an inv column; a tag that is not one is refused before a set writes anything", () => {
  const { h } = holderRoom();
  const inv = () => h.all("SELECT * FROM inv ORDER BY token").map((r) => ({ ...r }));
  const before = inv();
  for (const r of [
    h.room.museSetHookLook("tok-Ada", "L", "agent-chat", R, LATER, TAG_A), h.room.museSetHookLook("tok-Ada", "L", "agent-chat", R, LATER, "nope"),
    h.room.museHookLook("tok-Ada"), h.room.museDropLook("tok-Ada", "M"), h.room.museHolderLook(TAG_A, "tok-Ada", false), h.room.museHolderLook("nope", null, false),
    h.room.museHolderDrop(TAG_A, "M", "tok-Ada", false), h.room.museHolderDrop(TAG_B, "L", "tok-nobody", false),
  ]) assert.equal(typeof r.now, "number", JSON.stringify(r));
  assert.deepEqual(noNow(h.room.museSetHookLook("tok-Ada", "M", "agent-chat", R, LATER, "short")), { ok: false, status: 400, code: "bad_holder", error: "This holder tag is not one this room keeps." });
  assert.deepEqual([linkOf(h), rowsOf(h)], ["L", [TAG_A]], "the refused set wrote nothing");
  assert.deepEqual(inv(), before);
});

test("schema step 10: pre for a Muse hook with no holder, none for a webhook; run again, nothing added to a hook held already; run after a first run cut short, exactly pre; a Muse hook with no row is held by pre for every method", () => {
  const { h } = holderRoom();
  h.member("Bo", "agent");
  h.room.museSetHookLook("tok-Ada", "L", "agent-chat", R, LATER);
  h.room.webhookSet("tok-Bo", "https://hooks.example.org/x", "s", R);
  // a room that has not run step 10: no mhh, schema version 9
  h.db.exec("DROP TABLE mhh");
  h.db.prepare("UPDATE cfg SET v = '9' WHERE k = 'schema_version'").run();
  h.room.ensureSchema();
  assert.deepEqual(h.all("SELECT member, holder FROM mhh ORDER BY member").map((r) => [r.member, r.holder]), [["ada", "pre"]], "pre on the Muse hook, none on the webhook");
  // run again on a hook held by a tag: exactly that tag
  h.room.museSetHookLook("tok-Ada", "M", "agent-chat", R, LATER, TAG_A);
  h.db.prepare("UPDATE cfg SET v = '9' WHERE k = 'schema_version'").run();
  h.room.ensureSchema();
  assert.deepEqual(rowsOf(h), [TAG_A], "a second run adds nothing to a hook held already");
  // a first run cut short: the table made, the backfill not run
  h.db.exec("DELETE FROM mhh");
  h.db.prepare("UPDATE cfg SET v = '9' WHERE k = 'schema_version'").run();
  h.room.ensureSchema();
  assert.deepEqual(rowsOf(h), ["pre"]);
  assert.equal(h.one("SELECT v FROM cfg WHERE k = 'schema_version'").v, "10");
  // a Muse hook with no row at all (written by hand): held by pre
  h.db.exec("DELETE FROM mhh");
  assert.deepEqual(noNow(h.room.museHookLook("tok-Ada")), { ok: true, link: "M", on: "M" });
  assert.deepEqual(noNow(h.room.museHolderLook(TAG_B, "tok-Ada", true)), { ok: true, link: "M", on: "M" }, "with legacy");
  assert.deepEqual(noNow(h.room.museHolderLook(TAG_B, "tok-Ada", false)), { ok: true, link: null, on: "M" }, "not the tag's");
  h.room.museSetHookLook("tok-Ada", "M", "agent-chat", R, LATER, TAG_B);
  assert.deepEqual(rowsOf(h), ["pre", TAG_B].sort(), "a set on that link first gives it the pre it is held by");
});

test("an identity object never runs step 10: after an agent key's calls it has no mhh table", async () => {
  const { makeWorld, read, agentInvite } = await import("./agent-world.mjs");
  const { agentCreateRoute, agentRoute } = await import("../../worker/routes/agent.ts");
  const w = makeWorld();
  const tok = agentInvite(w.room("lima"), "Hank");
  const r = await read(agentCreateRoute(w.rc("POST", "/api/agents", { json: { rooms: [{ room: "lima", token: tok }] }, headers: { "CF-Connecting-IP": "10.6.0.1" } })));
  assert.equal(r.status, 201);
  assert.equal((await read(agentRoute(w.rc("GET", "/api/agent", { headers: { Authorization: "Bearer " + r.json.key } })))).status, 200);
  const id = w.identities()[0];
  w.harness(id).restart();
  assert.equal(w.harness(id).one("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'mhh'").n, 0);
  assert.equal(w.harness("lima").one("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'mhh'").n, 1, "a room has it");
});

// The model's room (holders-model.mjs roomCall) against the real Room: for
// every state (no hook, a Muse hook on L or M, a webhook; any subset of
// pre, self and two tags as holder rows) and every call the model makes (a
// set with and without a tag, and the room's own, on L and on M; the looks
// and drops by tag with and without legacy; the untagged look and drop;
// step 10; webhookSet; museDrop), the same hook, holders and answer. So the
// exhaustive search runs over a room shown equal to the real one on every
// transition it takes.
test("the model's room is the real Room: every state and call, the same hook, holders and answer", () => {
  const { h } = holderRoom();
  const real = { "tag-A": TAG_A, "tag-B": TAG_B, pre: "pre", self: "self" };
  const back = Object.fromEntries(Object.entries(real).map(([k, v]) => [v, k]));
  const HOLDERS = ["pre", "self", "tag-A", "tag-B"];
  const HOOKS = [null, { kind: "muse", link: "L" }, { kind: "muse", link: "M" }, { kind: "webhook" }];
  const CALLS = [];
  for (const link of ["L", "M"]) {
    for (const holder of ["pre", "self", "tag-A", "tag-B"]) CALLS.push({ op: "set", link, holder });
    CALLS.push({ op: "drop", link });
    for (const tag of ["tag-A", "tag-B"]) for (const legacy of [false, true]) CALLS.push({ op: "drop", link, tag, legacy });
  }
  CALLS.push({ op: "look" });
  for (const tag of ["tag-A", "tag-B"]) for (const legacy of [false, true]) CALLS.push({ op: "look", tag, legacy });
  CALLS.push({ op: "step10", backfill: "only" }, { op: "webhook" }, { op: "museDrop" });
  const write = (st) => {
    h.db.exec("DELETE FROM mh; DELETE FROM mhh; DELETE FROM mq");
    if (st.hook) h.db.prepare("INSERT INTO mh (member, name, room, link, routing, enabled, muted, cursor, created, updated, kind, url, secret) VALUES ('ada', 'Ada', ?, ?, ?, 1, 0, 0, 1, 1, ?, ?, ?)")
      .run(R, st.hook.kind === "muse" ? st.hook.link : "", st.hook.kind === "muse" ? "agent-chat" : "", st.hook.kind, st.hook.kind === "muse" ? null : "https://hooks.example.org/x", st.hook.kind === "muse" ? null : "s");
    for (const r of st.rows) h.db.prepare("INSERT INTO mhh (member, holder, at) VALUES ('ada', ?, 1)").run(real[r]);
  };
  const readBack = () => {
    const m = h.all("SELECT kind, link FROM mh WHERE member = 'ada'")[0];
    return { hook: m ? (m.kind === "muse" ? { kind: "muse", link: m.link } : { kind: "webhook" }) : null, rows: h.all("SELECT holder FROM mhh WHERE member = 'ada'").map((r) => back[r.holder]).sort() };
  };
  const invoke = (c) => {
    const tag = c.tag === undefined ? undefined : real[c.tag];
    switch (c.op) {
      case "set": return c.holder === "self" ? h.room.museSetHook("tok-Ada", c.link, "agent-chat", R) : c.holder === "pre" ? h.room.museSetHookLook("tok-Ada", c.link, "agent-chat", R, LATER) : h.room.museSetHookLook("tok-Ada", c.link, "agent-chat", R, LATER, real[c.holder]);
      case "webhook": return h.room.webhookSet("tok-Ada", "https://hooks.example.org/x", "s", R);
      case "museDrop": h.room.museDrop("Ada"); return { ok: true };
      case "look": return tag === undefined ? h.room.museHookLook("tok-Ada") : h.room.museHolderLook(tag, "tok-Ada", c.legacy);
      case "drop": return tag === undefined ? h.room.museDropLook("tok-Ada", c.link) : h.room.museHolderDrop(tag, c.link, "tok-Ada", c.legacy);
      case "step10": h.db.prepare("UPDATE cfg SET v = '9' WHERE k = 'schema_version'").run(); h.room.ensureSchema(); return { ok: true };
    }
  };
  const fields = { set: ["ok"], webhook: ["ok"], museDrop: ["ok"], step10: ["ok"], look: ["ok", "link", "on"], drop: ["ok", "removed", "link", "on"] };
  let n = 0;
  for (const hook of HOOKS) for (let mask = 0; mask < 16; mask++) {
    const st = { hook, rows: HOLDERS.filter((_, i) => mask & (1 << i)).sort() };
    for (const c of CALLS) {
      write(st);
      const ans = invoke(c);
      const m = roomCall(st, c, LEGACY_HOLDS);
      const what = JSON.stringify(st) + " " + JSON.stringify(c);
      assert.deepEqual(readBack(), m.st, what + ": the hook and its holders");
      assert.deepEqual(Object.fromEntries(fields[c.op].map((k) => [k, ans[k]])), Object.fromEntries(fields[c.op].map((k) => [k, m.ans[k]])), what + ": the answer");
      n++;
    }
  }
  assert.equal(n, HOOKS.length * 16 * CALLS.length);
  assert.equal(held({ hook: { kind: "muse", link: "L" }, rows: [] }, ["pre"]), true, "a Muse hook with no row is held by pre");
});
