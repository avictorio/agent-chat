// Drafts are their sender's alone until they publish (worker/room/messages.ts,
// media.ts, uploads.ts), on the real Room class (room-harness.mjs). Each
// test is a way another member could tell a draft was there.
import test from "node:test";
import assert from "node:assert/strict";
import { makeRoom } from "./room-harness.mjs";
import { MAX_TEXT } from "../../worker/limits.ts";

const R = "unit";
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]).buffer;

test("every write path answers another member's draft exactly like an id that holds nothing", async () => {
  const h = makeRoom();
  h.member("Ada"); h.member("Bob");
  const draft = await h.room.post("Ada", "a post in the making", R, false, null, null, null, true, false);
  const none = draft.id + 1000;
  const calls = {
    publish: (id) => h.room.publishMessage(id, "Bob", false, R, "x"),
    delete: (id) => h.room.deleteMessage(id, "Bob", false),
    "attach audio": (id) => h.room.attachAudio(id, "Bob", PNG, "audio/mpeg", false, null, R),
    "attach image": (id) => h.room.attachImage(id, "Bob", PNG, "image/png", false, R),
    "attach video": (id) => h.room.attachVideo(id, "Bob", PNG, "video/mp4", false, R),
    "upload ticket": (id) => h.room.mintUploadTicket(id, "image", "Bob", R, false, null, "tok-Bob"),
    "upload start": (id) => h.room.uploadStart(id, "image", "Bob", false, R, 12, "image/png", null, "fp", false),
    "upload status": (id) => h.room.uploadStatus(id, "image", "Bob", false),
    "upload abort": (id) => h.room.uploadAbort(id, "image", "Bob", false),
    "video stream": (id) => h.room.streamBegin(id, "Bob", "video/mp4", 100, false, R),
  };
  for (const [what, call] of Object.entries(calls)) {
    const a = await call(draft.id), b = await call(none);
    // status answers any refusal as "no upload here" (200), alike for both
    if (what !== "upload status") assert.deepEqual({ status: a.status, error: a.error }, { status: 404, error: "No message with that id" }, what + " on the draft");
    assert.deepEqual(a, b, what + ": the draft and the empty id answer alike");
  }
  assert.equal((await h.room.publishMessage(draft.id, "Ada", false, R, undefined)).status, 200, "the draft was left alone: its sender publishes it");
  assert.equal((await h.room.deleteMessage(draft.id, "Bob", false)).status, 403, "a live message keeps its honest 403");
  assert.equal(h.objects.size, 0, "nothing was stored for the probes");
});

test("the owner still reaches any draft", async () => {
  const h = makeRoom();
  h.member("Ada");
  const draft = await h.room.post("Ada", "owner check", R, false, null, null, null, true, false);
  assert.equal((await h.room.deleteMessage(draft.id, "", true)).status, 200);
});

test("a draft does not count as its sender's first post: the digest rotation names them only once it publishes", async () => {
  const h = makeRoom();
  h.member("Aaron"); h.member("Zed");
  await h.room.post("Zed", "hello", R, false);
  const due = () => h.room.roomState("Zed", R).memory?.awaiting_digest_from;
  assert.equal(due(), "Zed", "Zed is the only agent who has posted");
  const draft = await h.room.post("Aaron", "", R, false, null, null, null, true, false);
  assert.equal(due(), "Zed", "Aaron's draft is invisible, so it does not change who is named");
  assert.equal(h.one("SELECT posted FROM inv WHERE name = 'Aaron'").posted, null);
  await h.room.deleteMessage(draft.id, "Aaron", false);
  assert.equal(due(), "Zed", "nor does the deleted draft");
  const second = await h.room.post("Aaron", "coming up", R, false, null, null, null, true, false);
  assert.equal((await h.room.publishMessage(second.id, "Aaron", false, R, undefined)).status, 200);
  assert.ok(h.one("SELECT posted FROM inv WHERE name = 'Aaron'").posted, "publishing is Aaron's first post");
  assert.equal(due(), "Aaron", "and puts him in the rotation");
});

test("publishing with an over-long caption is refused like posting it, and changes nothing", async () => {
  const h = makeRoom();
  h.member("Ada");
  const draft = await h.room.post("Ada", "the first caption", R, false, null, null, null, true, false);
  const r = await h.room.publishMessage(draft.id, "Ada", false, R, "a".repeat(MAX_TEXT + 1));
  assert.deepEqual(r, { status: 413, error: "\"text\" is limited to " + MAX_TEXT + " characters" });
  const row = h.one("SELECT text, draft FROM m WHERE id = ?", draft.id);
  assert.equal(row.text, "the first caption", "the draft keeps its caption");
  assert.ok(row.draft, "and stays a draft");
  const ok = await h.room.publishMessage(draft.id, "Ada", false, R, "b".repeat(MAX_TEXT));
  assert.equal(ok.status, 200);
  assert.equal(ok.msg.text.length, MAX_TEXT, "a caption at the limit publishes whole");
});

/** Bob writes a draft (with a picture, a resumable upload in flight and
 *  a client_msg_id); then the owner revokes him and invites someone new
 *  under the name, spelled "bob". */
async function reissued() {
  const h = makeRoom();
  h.member("Bob");
  const old = await h.room.postKeyed("cid-1", "Bob", "old Bob's private caption", R, false, null, null, null, true, false);
  await h.room.putMedia(old.id, "image", PNG, "image/png", R);
  h.db.prepare("UPDATE m SET image_type = 'image/png', image_size = 12 WHERE id = ?").run(old.id);
  const vs = await h.room.uploadStart(old.id, "video", "Bob", false, R, 100, "video/mp4", "clip.mp4", "fp-old", false);
  assert.equal(vs.status, 200, vs.error);
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(h.room.revoke("tok-Bob"), true);
  const inv = h.room.invite("bob", "human", null);
  assert.ok(inv.token);
  return { h, old, tok: inv.token };
}

test("a name the owner re-issues does not hand the earlier holder's drafts to the new holder", async () => {
  const { h, old, tok } = await reissued();
  const none = old.id + 1000;
  const calls = {
    publish: (id) => h.room.publishMessage(id, "bob", false, R, "x"),
    delete: (id) => h.room.deleteMessage(id, "bob", false),
    "attach audio": (id) => h.room.attachAudio(id, "bob", PNG, "audio/mpeg", false, null, R),
    "attach image": (id) => h.room.attachImage(id, "bob", PNG, "image/png", false, R),
    "attach video": (id) => h.room.attachVideo(id, "bob", PNG, "video/mp4", false, R),
    "upload ticket": (id) => h.room.mintUploadTicket(id, "image", "bob", R, false, null, tok),
    "upload start": (id) => h.room.uploadStart(id, "video", "bob", false, R, 100, "video/mp4", "clip.mp4", "fp-old", false),
    "upload part": (id) => h.room.uploadPartTarget(id, "video", "bob", false, 1, 100),
    "upload sign": (id) => h.room.uploadSignTarget(id, "video", "bob", false, [1]),
    "upload status": (id) => h.room.uploadStatus(id, "video", "bob", false),
    "upload finish": (id) => h.room.uploadFinish(id, "video", "bob", false, R, null),
    "upload abort": (id) => h.room.uploadAbort(id, "video", "bob", false, R),
    "video stream": (id) => h.room.streamBegin(id, "bob", "video/mp4", 100, false, R),
  };
  for (const [what, call] of Object.entries(calls)) {
    const a = await call(old.id), b = await call(none);
    if (what !== "upload status") assert.equal(a.status, 404, what + " on the earlier holder's draft: " + JSON.stringify(a));
    assert.deepEqual(a, b, what + ": the draft and the empty id answer alike");
  }
  assert.equal(h.room.reactionsOf(old.id, "bob", false), null, "its reactions read as a missing message");
  assert.equal(h.room.react(old.id, "bob", "👍", R, false), null, "and it takes no reaction");
  assert.equal(h.room.mediaMeta(old.id, "image", { name: "bob", owner: false }), null, "its picture is not served to the new holder");
  assert.deepEqual(await h.room.findResumableUpload("bob", 100, "fp-old", false, null), { status: 200, found: false }, "upload/resume does not find it");
  // the client_msg_id the earlier holder used is not a repeat for the new one
  const again = await h.room.postKeyed("cid-1", "bob", "new bob's own post", R, false);
  assert.ok(!again.repeat && again.id !== old.id && again.text === "new bob's own post", JSON.stringify(again).slice(0, 200));
  const twice = await h.room.postKeyed("cid-1", "bob", "new bob's own post", R, false);
  assert.ok(twice.repeat && twice.msg.id === again.id, "and the new post's own repeat still answers it");
  // nothing of the old draft was deleted or changed
  const row = h.one("SELECT text, draft FROM m WHERE id = ?", old.id);
  assert.deepEqual({ ...row }, { text: "old Bob's private caption", draft: 1 });
  assert.ok(h.one("SELECT upload_id FROM md WHERE msg = ? AND kind = 'video'", old.id).upload_id, "its upload is still in flight");
  assert.ok(h.room.mediaMeta(old.id, "image", { owner: true }), "the owner key still sees it");
});

test("the new holder's own drafts are theirs, and the owner key reaches the earlier holder's", async () => {
  const { h, old } = await reissued();
  const mine = await h.room.post("bob", "new bob's draft", R, false, null, null, null, true, false);
  const s = await h.room.uploadStart(mine.id, "image", "bob", false, R, 12, "image/png", "a.png", "fp-new", false);
  assert.equal(s.status, 200, s.error);
  assert.equal((await h.room.deleteMessage(mine.id, "bob", false)).status, 200);
  assert.equal((await h.room.publishMessage(old.id, "Bob", true, R, undefined)).status, 409, "the owner reaches it (its upload is still in flight)");
});
