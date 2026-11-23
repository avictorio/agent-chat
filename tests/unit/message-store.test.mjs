// What the Room keeps and what it lets go (worker/room/messages.ts,
// uploads.ts, media.ts), on the real Room class (room-harness.mjs). Each
// test is a way a member used to lose a message or a file.
import test from "node:test";
import assert from "node:assert/strict";
import { makeRoom } from "./room-harness.mjs";
import { KEEP } from "../../worker/limits.ts";

const R = "unit";
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]).buffer;
const live = (h) => h.one("SELECT COUNT(*) AS n FROM m WHERE draft IS NULL OR draft = 0").n;

test("a draft published after KEEP newer messages survives the next post", async () => {
  const h = makeRoom();
  h.member("Ada"); h.member("Bob");
  const draft = await h.room.post("Ada", "a long upload", R, false, null, null, null, true, false);
  for (let i = 0; i < KEEP + 5; i++) await h.room.post("Bob", "filler " + i, R, false);
  const key = await h.room.putMedia(draft.id, "image", PNG, "image/png", R);
  h.room.react(draft.id, "Ada", "👍", R, false);
  assert.equal((await h.room.publishMessage(draft.id, "Ada", false, R, undefined)).status, 200);
  await h.room.post("Bob", "the post that used to delete it", R, false);
  await h.settled();
  assert.ok(h.one("SELECT id FROM m WHERE id = ?", draft.id), "the published message is still there");
  assert.ok(h.one("SELECT msg FROM md WHERE msg = ?", draft.id) && h.objects.has(key), "and so is its picture");
  assert.ok(h.one("SELECT msg FROM rx WHERE msg = ?", draft.id), "and its reaction");
  assert.equal(live(h), KEEP, "the room holds its newest KEEP live messages");
  assert.equal(h.one("SELECT id FROM m WHERE text = 'filler 0'"), undefined, "the oldest by live time went instead");
});

test("the trim takes a message's media and reactions with it, and leaves drafts", async () => {
  const h = makeRoom();
  h.member("Ada"); h.member("Bob");
  const first = await h.room.post("Ada", "first, with a picture", R, false, null, { data: PNG, type: "image/png" });
  const key = h.one("SELECT r2key FROM md WHERE msg = ?", first.id).r2key;
  h.room.react(first.id, "Bob", "👍", R, false);
  const draft = await h.room.post("Ada", "still uploading", R, false, null, null, null, true, false);
  for (let i = 0; i < KEEP; i++) await h.room.post("Bob", "filler " + i, R, false);
  await h.settled();
  assert.equal(h.one("SELECT id FROM m WHERE id = ?", first.id), undefined);
  assert.equal(h.one("SELECT msg FROM md WHERE msg = ?", first.id), undefined);
  assert.equal(h.one("SELECT msg FROM rx WHERE msg = ?", first.id), undefined);
  assert.equal(h.objects.has(key), false, "the object is deleted from storage");
  assert.ok(h.one("SELECT id FROM m WHERE id = ?", draft.id), "a draft is never trimmed");
});

test("the Referee's posts and match cards are trimmed like any other", async () => {
  const h = makeRoom();
  h.member("Ada");
  for (let i = 0; i < KEEP + 20; i++) h.room.postSystem("result " + i, R);
  assert.equal(live(h), KEEP);
  for (let i = 0; i < 10; i++) await h.room.postGameCard("Ada", "card " + i, i + 1, R);
  assert.equal(live(h), KEEP);
});

test("a draft is not swept the day its long upload finishes", async () => {
  const h = makeRoom();
  h.member("Ada"); h.member("Bob");
  const DAY = 86400000;
  const draft = await h.room.post("Ada", "video and pdf", R, false, null, null, null, true, false);
  const vs = await h.room.uploadStart(draft.id, "video", "Ada", false, R, 100, "video/mp4", "clip.mp4", "fp-v", false);
  assert.equal(vs.status, 200);
  const up = h.one("SELECT upload_id, r2key FROM md WHERE msg = ? AND kind = 'video'", draft.id);
  const clip = new Uint8Array(100); clip.set([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32]);
  h.multipart.get(up.upload_id).data = clip;
  assert.equal(h.room.uploadPartDone(draft.id, "video", up.upload_id, 1, "etag").status, 200);
  // the draft and its upload began over a day ago
  h.db.prepare("UPDATE m SET ts = ? WHERE id = ?").run(Date.now() - 26 * 3600000, draft.id);
  h.db.prepare("UPDATE md SET began = ? WHERE msg = ?").run(Date.now() - 26 * 3600000, draft.id);
  assert.equal((await h.room.uploadFinish(draft.id, "video", "Ada", false, R, null)).status, 200);
  // the composer starts the message's second file; someone else posts
  h.room._sweptAt = 0;
  const fs = await h.room.uploadStart(draft.id, "file", "Ada", false, R, 50, "application/pdf", "doc.pdf", "fp-f", false);
  assert.equal(fs.status, 200, "the second file starts");
  h.room._sweptAt = 0;
  await h.room.post("Bob", "meanwhile", R, false);
  assert.ok(h.one("SELECT id FROM m WHERE id = ?", draft.id), "the draft is still there");
  assert.ok(h.objects.has(up.r2key), "and its finished video");
  // a draft left alone for a day after its last file does go
  h.db.prepare("UPDATE md SET at = ?, began = ?, upload_id = NULL WHERE msg = ?").run(Date.now() - DAY - 1000, Date.now() - 9 * DAY, draft.id);
  await h.sweepNow();
  assert.equal(h.one("SELECT id FROM m WHERE id = ?", draft.id), undefined, "an abandoned draft is swept");
  assert.equal(h.objects.has(up.r2key), false);
});

test("an upload start for a message swept or deleted meanwhile answers 404 and leaves nothing", async () => {
  const h = makeRoom();
  h.member("Ada");
  const old = await h.room.post("Ada", "abandoned", R, false, null, null, null, true, false);
  h.db.prepare("UPDATE m SET ts = ? WHERE id = ?").run(Date.now() - 2 * 86400000, old.id);
  h.room._sweptAt = 0;
  const r = await h.room.uploadStart(old.id, "file", "Ada", false, R, 50, "application/pdf", "doc.pdf", "fp", false);
  assert.equal(r.status, 404, "the sweep ran first, so the start sees the message is gone");
  assert.equal(h.all("SELECT msg FROM md").length, 0);
  assert.equal(h.multipart.size, 0, "no upload left open");
});

test("a deleted message has no media, whatever was left behind", async () => {
  const h = makeRoom();
  h.member("Ada");
  const msg = await h.room.post("Ada", "with a picture", R, false, null, { data: PNG, type: "image/png" });
  const key = h.one("SELECT r2key FROM md WHERE msg = ?", msg.id).r2key;
  assert.ok(h.room.mediaMeta(msg.id, "image"), "served while the message exists");
  // what a write racing the delete leaves: the row and the object, no message
  h.db.prepare("DELETE FROM m WHERE id = ?").run(msg.id);
  assert.equal(h.room.mediaMeta(msg.id, "image"), null, "not served once the message is gone");
  assert.equal(await h.room.getMedia(msg.id, "image", null), null);
  await h.sweepNow();
  assert.equal(h.one("SELECT msg FROM md WHERE msg = ?", msg.id), undefined, "the sweep collects the row");
  assert.equal(h.objects.has(key), false, "and the object");
});

test("a post with media is not readable until its media is stored, then goes live at once", async () => {
  const seen = [];
  const h = makeRoom({ put: () => { seen.push(h.room.read(0, 50).map((m) => m.text)); } });
  h.member("Ada"); h.member("Bob");
  await h.room.post("Bob", "before", R, false);
  const msg = await h.room.post("Ada", "with a picture", R, false, null, { data: PNG, type: "image/png" });
  assert.deepEqual(seen, [["before"]], "while the picture was being stored, readers saw nothing of it");
  const row = h.one("SELECT draft, pub_ts, ts FROM m WHERE id = ?", msg.id);
  assert.equal(row.draft, null);
  assert.ok(row.pub_ts >= row.ts);
  assert.deepEqual(h.room.read(0, 50).map((m) => m.text), ["before", "with a picture"]);
  assert.equal(h.room.read(0, 50)[1].image.type, "image/png", "and it arrives with its picture");
});

test("a message deleted while its media is stored is not posted", async () => {
  let h = null;
  let deleted = null;
  h = makeRoom({ put: async () => { const id = h.one("SELECT MAX(id) AS id FROM m").id; deleted = await h.room.deleteMessage(id, "Ada", false); } });
  h.member("Ada");
  const frames = [];
  h.room.clients.add({ token: "t", owner: true, name: "", kinds: null, games: null, stateSub: false, stateKey: null, send: (s) => frames.push(s), close: () => {} });
  const msg = await h.room.post("Ada", "gone before it landed", R, false, null, { data: PNG, type: "image/png" });
  assert.equal(deleted.status, 200);
  assert.equal(msg, null, "the post reports that nothing was posted");
  assert.equal(frames.filter((f) => f.includes("gone before it landed")).length, 0, "no frame was sent");
  assert.equal(h.all("SELECT msg FROM md").length, 0);
  assert.equal(h.objects.size, 0, "and nothing is left in storage");
});

test("deleting a message removes its rows before storage is asked", async () => {
  const h = makeRoom();
  h.member("Ada");
  const msg = await h.room.post("Ada", "with a picture", R, false, null, { data: PNG, type: "image/png" });
  let rowsAtDelete = null;
  const real = h.room.env.MEDIA.delete;
  h.room.env.MEDIA.delete = async (k) => { rowsAtDelete = h.all("SELECT id FROM m WHERE id = ?", msg.id).length + h.all("SELECT msg FROM md WHERE msg = ?", msg.id).length; return real(k); };
  assert.equal((await h.room.deleteMessage(msg.id, "Ada", false)).status, 200);
  assert.equal(rowsAtDelete, 0, "the rows were gone by the time storage was called");
  assert.equal(h.objects.size, 0);
});

// A stream client that records the message frames it gets.
const watch = (h) => {
  const frames = [];
  h.room.clients.add({ token: "t", owner: false, name: "Bob", kinds: null, games: null, stateSub: false, stateKey: null, send: (s) => { if (s.includes("event: message")) frames.push(JSON.parse(s.split("data: ")[1])); }, close: () => {} });
  return frames;
};
const tick = () => new Promise((r) => setTimeout(r, 3));

test("media attached to a live message reaches the stream, a long poll and a later cursor", async () => {
  const h = makeRoom();
  h.member("Ada"); h.member("Bob");
  const msg = await h.room.post("Ada", "here is the chart", R, false);
  await tick();
  const later = await h.room.post("Bob", "waiting for it", R, false);
  const frames = watch(h);
  const poll = h.room.list(later.id, 50, 5, "Bob", R);
  const t0 = Date.now();
  assert.equal((await h.room.attachImage(msg.id, "Ada", PNG, "image/png", false, R)).status, 200);
  const woke = await poll;
  assert.ok(Date.now() - t0 < 1000, "the long poll woke at once instead of waiting out its 5 s");
  assert.deepEqual(woke.messages.map((m) => [m.id, m.image && m.image.type]), [[msg.id, "image/png"]], "and returned the message with its picture");
  assert.deepEqual(frames.map((f) => [f.id, f.image && f.image.type]), [[msg.id, "image/png"]], "open tabs got the message again, with its picture");
  assert.deepEqual(h.room.read(later.id, 50).map((m) => m.id), [msg.id], "a cursor past its id still gets it");
  await h.settled();
});

test("an upload finished on a live message is sent again; one on a draft waits for its publish", async () => {
  const h = makeRoom();
  h.member("Ada"); h.member("Bob");
  const msg = await h.room.post("Ada", "notes to follow", R, false);
  await tick();
  const later = await h.room.post("Bob", "ok", R, false);
  const draft = await h.room.post("Ada", "a draft", R, false, null, null, null, true, false);
  const frames = watch(h);
  const finish = async (id) => {
    assert.equal((await h.room.uploadStart(id, "file", "Ada", false, R, 5, "text/plain", "n.txt", null, false)).status, 200);
    const up = h.one("SELECT upload_id FROM md WHERE msg = ? AND kind = 'file'", id);
    h.multipart.get(up.upload_id).data = new Uint8Array([1, 2, 3, 4, 5]);
    assert.equal(h.room.uploadPartDone(id, "file", up.upload_id, 1, "etag").status, 200);
    assert.equal((await h.room.uploadFinish(id, "file", "Ada", false, R, null)).status, 200);
  };
  await finish(msg.id);
  assert.deepEqual(frames.map((f) => [f.id, f.file && f.file.name]), [[msg.id, "n.txt"]]);
  assert.deepEqual(h.room.read(later.id, 50).map((m) => m.id), [msg.id]);
  const pub = h.one("SELECT pub_ts FROM m WHERE id = ?", draft.id).pub_ts;
  await finish(draft.id);
  assert.equal(frames.length, 1, "nothing is sent for a draft");
  assert.equal(h.one("SELECT pub_ts FROM m WHERE id = ?", draft.id).pub_ts, pub);
  assert.equal((await h.room.publishMessage(draft.id, "Ada", false, R, undefined)).status, 200);
  assert.deepEqual(frames.map((f) => f.id), [msg.id, draft.id], "its publish announces it once, with its file");
  assert.equal(frames[1].file.name, "n.txt");
  await h.settled();
});
