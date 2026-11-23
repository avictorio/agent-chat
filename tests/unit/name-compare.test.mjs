// Member names compare one way in the room: sameName (worker/lib/text.ts).
// They were compared three ways - nameFold, JS toLowerCase and SQL lower(),
// which folds ASCII only - so a member with a capital outside ASCII
// ("Émile", "Иван", a dotted-R "Referee" look-alike) matched no invite in
// SQL and read as a system actor (kind non_interactive) on every message,
// and their reactions, avatar and kind could not be found by another case.
import test from "node:test";
import assert from "node:assert/strict";
import { makeRoom } from "./room-harness.mjs";
import { cleanName, memberNameProblem, nameKey, sameName } from "../../worker/lib/text.ts";

const R = "unit";
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]).buffer;

/** a room with these active members, each of the kind given */
function roomWith(members) {
  const h = makeRoom();
  for (const [name, kind] of members) {
    h.member(name);
    h.db.prepare("UPDATE inv SET kind = ? WHERE name = ?").run(kind, name);
  }
  return h;
}

test("a member whose name has a capital outside ASCII reads as their own kind, not a system actor's", async () => {
  const h = roomWith([["Émile", "human"], ["Иван", "human"], ["Ṛeferee", "human"], ["Ada", "agent"]]);
  for (const name of ["Émile", "Иван", "Ṛeferee", "Ada"]) {
    const msg = await h.room.post(name, "hello from " + name, R, false);
    assert.equal(msg.kind, name === "Ada" ? "agent" : "human", name + " on the post's answer");
    assert.equal(h.room.memberKind(name), name === "Ada" ? "agent" : "human", name + " in frames (memberKind)");
    assert.equal(h.room.memberKind(name.toLowerCase()), name === "Ada" ? "agent" : "human", name + " lower-cased");
  }
  // the real system actor still reads as one
  const ref = await h.room.post("Referee", "match over", R, true);
  assert.equal(ref.kind, "non_interactive");
});

test("the newest invite gives the kind when a name was invited again", async () => {
  const h = makeRoom();
  h.db.prepare("INSERT INTO inv (token, name, created, used, revoked, kind) VALUES ('t1', 'émile', 1, 1, 2, 'agent')").run();
  h.db.prepare("INSERT INTO inv (token, name, created, used, kind) VALUES ('t2', 'Émile', 3, 3, 'human')").run();
  const msg = await h.room.post("Émile", "back again", R, false);
  assert.equal(msg.kind, "human");
  assert.equal(h.room.memberKind("ÉMILE"), "human");
});

test("a member's kind, avatar and reaction are found under any case of their name", async () => {
  const h = roomWith([["Émile", "agent"]]);
  assert.equal(h.room.setKind("émile", "human"), true);
  assert.equal(h.room.memberKind("Émile"), "human");
  const ver = await h.room.setAvatar("ÉMILE", PNG, "image/png", R);
  assert.equal(typeof ver, "number");
  assert.equal(h.room.getAvatar("émile").ver, ver);
  assert.equal(await h.room.clearAvatar("émile"), true);
  assert.equal(h.room.getAvatar("Émile"), null);
  const msg = await h.room.post("Ada", "react to me", R, false);
  h.room.react(msg.id, "Émile", "👍", R, false);
  h.room.react(msg.id, "émile", "🎉", R, false);
  assert.deepEqual(h.all("SELECT emoji FROM rx WHERE msg = ?", msg.id).map((r) => r.emoji), ["🎉"], "the second reaction replaced the first");
});

test("a member's draft is theirs under any case of their name, and no one else's", async () => {
  const h = roomWith([["Émile", "human"], ["Ada", "agent"]]);
  const draft = await h.room.post("Émile", "in the making", R, false, null, null, null, true, false);
  assert.ok(h.room.reactionsOf(draft.id, "émile", false), "its sender reads it");
  assert.equal(h.room.reactionsOf(draft.id, "Ada", false), null, "another member does not");
  const pub = await h.room.publishMessage(draft.id, "ÉMILE", false, R, undefined);
  assert.equal(pub.status, 200, JSON.stringify(pub));
});

test("the name checked is the name stored: NFC comes before the check", () => {
  // U+1FEF (Greek varia) composes to a backtick, which names may not carry
  const raw = "x`id";
  assert.equal(cleanName(raw), "x`id");
  assert.ok(memberNameProblem(cleanName(raw)), "refused once composed");
  assert.equal(cleanName("José"), "José", "decomposed letters are stored composed");
});

test("sameName folds; nameKey is the plain key stored rows were filed under", () => {
  assert.ok(sameName("Émile", "éMILE"));
  assert.ok(sameName("Ｂob", "bob"), "full-width letters fold");
  assert.ok(!sameName("Ann", "Anne"));
  assert.equal(nameKey("Émile"), "émile");
});
