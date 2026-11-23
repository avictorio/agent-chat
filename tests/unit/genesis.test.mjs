// Public room creation's room side and caller keys (worker/room/Room.ts
// genesis methods, the quota object's createReserve, worker/lib/address.ts),
// on the real Room class (room-harness.mjs).
import test from "node:test";
import assert from "node:assert/strict";
import { makeRoom } from "./room-harness.mjs";
import { GENESIS_PENDING_MS } from "../../worker/limits.ts";
import { GENESIS_EMPTY_TABLES } from "../../worker/room/Room.ts";
import { addressKey, networkKey, plainAddress } from "../../worker/lib/address.ts";

const R = "unit";

/** A room that does not exist yet (makeRoom makes one: it is deleted first). */
async function freeRoom() {
  const h = makeRoom();
  await h.room.destroy(R);
  return h;
}

/** Moves the pending genesis back by ms. */
function age(h, ms) {
  const g = JSON.parse(h.one("SELECT v FROM cfg WHERE k = 'genesis'").v);
  h.db.prepare("UPDATE cfg SET v = ? WHERE k = 'genesis'").run(JSON.stringify({ ...g, at: g.at - ms }));
}

test("a genesis is pending until its mail is confirmed: a second creator meanwhile is told to wait", async () => {
  const h = await freeRoom();
  const g = h.room.createGenesis("Ada");
  assert.ok(g.created && g.invite.token);
  const again = h.room.createGenesis("Bob");
  assert.equal(again.pending, true);
  assert.ok(again.retry_after > 0 && again.retry_after <= GENESIS_PENDING_MS / 1000, String(again.retry_after));
  assert.equal(h.room.genesisCheck().state, "pending");
  assert.equal(h.room.confirmGenesis("not-its-token"), false, "only the genesis's own token confirms it");
  assert.equal(h.room.confirmGenesis(g.invite.token), true);
  assert.equal(h.room.genesisCheck().state, "taken");
  assert.deepEqual(h.room.createGenesis("Bob"), { existed: true });
});

test("a stale pending room nobody touched starts over for the next creator, and again after that; nothing is deleted", async () => {
  const h = await freeRoom();
  const first = h.room.createGenesis("Ada");
  age(h, GENESIS_PENDING_MS + 1000);
  assert.equal(h.room.genesisCheck().state, "free");
  const second = h.room.createGenesis("Ada");
  assert.ok(second.created && second.invite.token && second.invite.token !== first.invite.token);
  assert.equal(h.room.lookupInvite(first.invite.token).code, "invite_revoked", "the unopened invite is replaced");
  assert.equal(h.room.lookupInvite(second.invite.token).ok, true);
  assert.equal(h.all("SELECT token FROM inv").length, 2, "its row is kept, revoked");
  assert.equal(h.room.genesisCheck().state, "pending", "the new genesis is pending in its turn");
  // the first creator's late rollback does not take the second one's room
  assert.equal(await h.room.abandonGenesis(first.invite.token, R), false);
  assert.equal(h.room.exists(), true);
  assert.equal(h.room.lookupInvite(second.invite.token).ok, true);
  // the replaced invite's revoked row does not make the room touched
  age(h, GENESIS_PENDING_MS + 1000);
  assert.equal(h.room.genesisCheck().state, "free");
  const third = h.room.createGenesis("Bob");
  assert.ok(third.created && third.invite.token);
  assert.equal(h.all("SELECT token FROM inv").length, 3);
});

test("a stale pending room someone wrote in is the owner's: taken, nothing revoked or destroyed", async () => {
  // a confirm that failed after the mail went out leaves the mark for good;
  // the owner, with the owner key, invites Carol, who posts
  const h = await freeRoom();
  const first = h.room.createGenesis("Ada");
  const carol = h.room.invite("Carol", "human", null);
  assert.equal(h.room.access(carol.token, false).ok, true);
  await h.room.post("Carol", "carol's message", R, false);
  age(h, GENESIS_PENDING_MS + 1000);
  assert.equal(h.room.genesisCheck().state, "taken");
  assert.equal(h.one("SELECT v FROM cfg WHERE k = 'genesis'"), undefined, "the mark goes: an ordinary room");
  assert.deepEqual(h.room.createGenesis("Mallory"), { existed: true });
  assert.equal(h.room.lookupInvite(first.invite.token).ok, true, "the first creator's link still works");
  assert.equal(h.room.lookupInvite(carol.token).ok, true);
  assert.equal(await h.room.abandonGenesis(first.invite.token, R), false);
  assert.equal(h.room.exists(), true);
  assert.equal(h.all("SELECT id FROM m").length, 1);
});

test("each thing a member or the owner can write makes a stale pending room taken", async () => {
  const writes = {
    "an owner-key post": (h) => h.room.post("Ada", "written with the owner key", R, true),
    "an owner invite, revoked unopened": (h) => h.room.revoke(h.room.invite("Carol", "human", null).token),
    "the genesis invite revoked": (h, g) => h.room.revoke(g.invite.token),
    "every invite revoked": (h) => h.room.revokeAll(),
    "a board question, deleted": (h) => h.room.deleteQuestion(h.room.addQuestion("why?", "Ada").id),
    "a constitution": (h) => h.room.setConstitution("be kind", "Ada"),
    "a message deleted": async (h) => { const m = await h.room.post("Ada", "x", R, true); await h.room.deleteMessage(m.id, null, true); },
  };
  for (const [what, write] of Object.entries(writes)) {
    const h = await freeRoom();
    const g = h.room.createGenesis("Ada");
    await write(h, g);
    age(h, GENESIS_PENDING_MS + 1000);
    assert.equal(h.room.genesisCheck().state, "taken", what);
  }
});

test("a start-over refused for a held name leaves the room exactly as it was", async () => {
  const h = await freeRoom();
  const first = h.room.createGenesis("Ada");
  h.room.invite("Carol", "human", null);
  age(h, GENESIS_PENDING_MS + 1000);
  // touched, so taken before the name is even looked at
  assert.deepEqual(h.room.createGenesis("Carol"), { existed: true });
  assert.equal(h.room.lookupInvite(first.invite.token).ok, true);
  // the name check on its own, on an untouched room: a name only a
  // reserved word holds is refused without revoking anything either
  const h2 = await freeRoom();
  const g2 = h2.room.createGenesis("Ada");
  age(h2, GENESIS_PENDING_MS + 1000);
  const mark = h2.one("SELECT v FROM cfg WHERE k = 'genesis'").v;
  assert.deepEqual(h2.room.createGenesis("Referee"), { existed: true });
  assert.equal(h2.room.lookupInvite(g2.invite.token).ok, true, "the first creator's link still works");
  assert.equal(h2.one("SELECT v FROM cfg WHERE k = 'genesis'").v, mark, "and the mark is in place");
});

test("a failed mail's rollback in a room someone wrote in deletes nothing", async () => {
  // the owner writes while the creator's mail is still out
  const h = await freeRoom();
  const g = h.room.createGenesis("Ada");
  const carol = h.room.invite("Carol", "human", null);
  await h.room.post("Ada", "written with the owner key", R, true);
  assert.equal(await h.room.abandonGenesis(g.invite.token, R), false);
  assert.equal(h.room.exists(), true);
  assert.equal(h.all("SELECT id FROM m").length, 1);
  assert.equal(h.room.lookupInvite(carol.token).ok, true);
  assert.equal(h.room.lookupInvite(g.invite.token).code, "invite_revoked", "only the creator's own unsent invite goes");
  assert.equal(h.one("SELECT v FROM cfg WHERE k = 'genesis'"), undefined);
  assert.equal(h.room.genesisCheck().state, "taken");
});

test("opening the genesis invite confirms the room: it never starts over, however old", async () => {
  const h = await freeRoom();
  const g = h.room.createGenesis("Ada");
  assert.equal(h.room.access(g.invite.token, false).ok, true);
  assert.equal(h.one("SELECT v FROM cfg WHERE k = 'genesis'"), undefined, "the mark is gone");
  assert.equal(h.room.genesisCheck().state, "taken");
  assert.deepEqual(h.room.createGenesis("Bob"), { existed: true });
});

test("a stale pending room whose invite was opened is taken (opened before the mark could be cleared)", async () => {
  const h = await freeRoom();
  const g = h.room.createGenesis("Ada");
  h.db.prepare("UPDATE inv SET used = ? WHERE token = ?").run(Date.now(), g.invite.token);
  age(h, GENESIS_PENDING_MS + 1000);
  assert.equal(h.room.genesisCheck().state, "taken");
});

test("a failed mail's rollback removes the room it made, and only while it is still that creator's", async () => {
  const h = await freeRoom();
  const g = h.room.createGenesis("Ada");
  assert.equal(await h.room.abandonGenesis(g.invite.token, R), true);
  assert.equal(h.room.exists(), false);
  assert.equal(h.room.genesisCheck().state, "free");
  const h2 = await freeRoom();
  const g2 = h2.room.createGenesis("Ada");
  h2.room.confirmGenesis(g2.invite.token);
  assert.equal(await h2.room.abandonGenesis(g2.invite.token, R), false, "a confirmed room is not rolled back");
  assert.equal(h2.room.exists(), true);
});

test("rooms from before the mark are never pending", () => {
  const h = makeRoom();
  assert.equal(h.room.genesisCheck().state, "taken");
  assert.deepEqual(h.room.createGenesis("Ada"), { existed: true });
});

test("the quota object takes a place in every cap at once, refuses past any, and gives places back", () => {
  const h = makeRoom();
  const caps = (ip) => [["all:d", 4], ["email:x:d", 2], ["ip:" + ip + ":d", 3]];
  assert.equal(h.room.createReserve(caps("a"), "d"), true);
  assert.equal(h.room.createReserve(caps("b"), "d"), true);
  assert.equal(h.room.createReserve(caps("c"), "d"), false, "the address is at 2");
  assert.equal(h.one("SELECT n FROM cq WHERE k = 'all:d'").n, 2, "a refusal takes no place anywhere");
  h.room.createRelease(caps("b").map((c) => c[0]));
  assert.equal(h.room.createReserve(caps("c"), "d"), true, "a released place is free again");
  h.room.createRelease(["ip:zzz:d"]);
  assert.equal(h.room.createReserve([["old:k", 1]], "c"), true);
  assert.equal(h.room.createReserve([["new:k", 1]], "e"), true);
  assert.equal(h.one("SELECT n FROM cq WHERE k = 'old:k'"), undefined, "a past day's counters go");
});

test("only a plain address is taken", () => {
  for (const ok of ["ada@example.com", "a.b-c+tag@mail.example.co.uk", "x_y@sub.example.org", "o'neil@example.ie"]) assert.equal(plainAddress(ok), true, ok);
  for (const bad of ["Your-Bank<victim@example.com>", "<victim@example.com>", "Ada <ada@example.com>", "a@example.com,b@example.com", "a@example.com;b@example.com", "a:b@example.com", "a b@example.com", "ada@localhost", "a@b@example.com", ".ada@example.com", "ada.@example.com", "a..b@example.com", "ada@-x.com", "ada@x.123", "ada@example.com\u0007", "\"ada\"@example.com", "a".repeat(250) + "@x.io", ""]) assert.equal(plainAddress(bad), false, JSON.stringify(bad));
});

test("the per-address cap counts one mailbox, the per-IP cap one /64", () => {
  assert.equal(addressKey("Ada+one@Example.COM"), "ada@example.com");
  assert.equal(addressKey("ada+two@example.com"), addressKey("ADA@example.com"));
  assert.equal(addressKey("+x@example.com"), "+x@example.com", "a local part that is all tag stays as it is");
  assert.equal(networkKey("2001:db8:1:2::1"), networkKey("2001:0db8:0001:0002:ffff:1:2:3"));
  assert.notEqual(networkKey("2001:db8:1:2::1"), networkKey("2001:db8:1:3::1"));
  assert.equal(networkKey("2001:db8::"), "2001:db8:0:0::/64");
  assert.equal(networkKey("203.0.113.7"), "203.0.113.7");
  assert.equal(networkKey("::ffff:203.0.113.7"), "203.0.113.7");
  assert.equal(networkKey(""), "unknown");
});

// The list is kept by hand. A table a later schema step adds and members
// write, left off it, would not count as "someone wrote here": a stale
// pending room holding its rows could be handed to a new creator, or
// rolled back with them.
test("every table but the invites and the settings counts as written-to for a pending room", () => {
  const h = makeRoom();
  const tables = h.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").map((r) => r.name).sort();
  const listed = new Set(GENESIS_EMPTY_TABLES);
  const missing = tables.filter((t) => t !== "inv" && t !== "cfg" && !listed.has(t));
  assert.deepEqual(missing, [], "add these to GENESIS_EMPTY_TABLES in worker/room/Room.ts (or say here why a table holds nothing a member or the owner wrote)");
  for (const t of GENESIS_EMPTY_TABLES) assert.ok(tables.includes(t), t + " is listed but is not a table");
});
