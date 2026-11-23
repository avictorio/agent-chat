// One upload session owns a message's media kind at a time (worker/room/
// uploads.ts, media.ts), on the real Room class (room-harness.mjs). Each
// test holds one storage call open while another request for the same
// message and kind runs: the interleavings that used to lose a published
// file, leave one listed that answered 404, or fail an upload that worked.
import test from "node:test";
import assert from "node:assert/strict";
import { makeRoom } from "./room-harness.mjs";
import { MIB, STREAM_PART, UP_PART_MAX } from "../../worker/limits.ts";

const R = "unit";
const PNG_HEAD = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13];
const MP4_HEAD = [0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32];
/** bytes of a file of that length starting with that header */
const bytes = (head, len) => { const b = new Uint8Array(len); b.set(head); return b; };
const tick = () => new Promise((r) => setTimeout(r, 5));

// Holds the next storage call of each named op (or throws in it) until
// released. hook is passed as the harness's before (or after) hook.
function holder() {
  const held = new Map();
  return {
    hook: async (op) => {
      const h = held.get(op);
      if (!h) return;
      held.delete(op);
      h.reached();
      if (h.error) throw h.error;
      await h.gate;
    },
    /** the next call of op waits; answers { reached, release } */
    hold(op) {
      let reached, release;
      const r = new Promise((res) => { reached = res; });
      const gate = new Promise((res) => { release = res; });
      held.set(op, { reached, gate });
      return { reached: r, release };
    },
    /** the next call of op throws */
    fail(op, message) { held.set(op, { reached: () => {}, error: new Error(message) }); },
  };
}

async function draft(h) {
  h.member("Ada");
  return (await h.room.post("Ada", "with a file", R, false, null, null, null, true, false)).id;
}

/** an image session of len bytes with every part in; answers its upload id */
async function imageSession(h, id, len) {
  const s = await h.room.uploadStart(id, "image", "Ada", false, R, len, "image/png", "pic.png", "fp-" + len, false);
  assert.equal(s.status, 200, s.error);
  const up = h.one("SELECT upload_id FROM md WHERE msg = ? AND kind = 'image'", id).upload_id;
  h.multipart.get(up).data = bytes(PNG_HEAD, len);
  for (let n = 1; n <= s.parts; n++) assert.equal(h.room.uploadPartDone(id, "image", up, n, "e" + n).status, 200);
  return up;
}

const row = (h, id, kind) => h.one("SELECT type, size, upload_id, r2key FROM md WHERE msg = ? AND kind = ?", id, kind);

test("two starts at once leave one live upload, the one the row names", async () => {
  const st = holder();
  const h = makeRoom({ before: st.hook });
  const id = await draft(h);
  const c = st.hold("create");
  const a = h.room.uploadStart(id, "image", "Ada", false, R, 100, "image/png", "a.png", "fp-a", false);
  await c.reached;
  const b = h.room.uploadStart(id, "image", "Ada", false, R, 200, "image/png", "b.png", "fp-b", false);
  await tick();
  c.release();
  assert.equal((await a).status, 200);
  assert.equal((await b).status, 200);
  assert.equal(h.multipart.size, 1, "the replaced upload is ended in storage");
  assert.ok(h.multipart.has(row(h, id, "image").upload_id), "and the row names the one left");
  assert.equal(row(h, id, "image").size, 200, "the later start won");
});

test("a part receipt of the upload being replaced does not count in the new one", async () => {
  const st = holder();
  const h = makeRoom({ before: st.hook });
  const id = await draft(h);
  await h.room.uploadStart(id, "image", "Ada", false, R, 100, "image/png", "a.png", "fp-a", false);
  const old = row(h, id, "image").upload_id;
  const c = st.hold("create");
  const b = h.room.uploadStart(id, "image", "Ada", false, R, 200, "image/png", "b.png", "fp-b", false);
  await c.reached;
  // part 1 of the old upload lands while storage creates the new one
  h.room.uploadPartDone(id, "image", old, 1, "old-etag");
  c.release();
  assert.equal((await b).status, 200);
  const status = await h.room.uploadStatus(id, "image", "Ada", false);
  assert.deepEqual(status.received, [], "the new upload has no parts yet");
});

test("a restart that storage refuses leaves the upload it was replacing usable", async () => {
  const st = holder();
  const h = makeRoom({ before: st.hook });
  const id = await draft(h);
  const up = await imageSession(h, id, 100);
  st.fail("create", "storage is down");
  const b = await h.room.uploadStart(id, "image", "Ada", false, R, 200, "image/png", "b.png", "fp-b", false);
  assert.equal(b.status, 503);
  assert.equal(row(h, id, "image").upload_id, up, "the row still names the first upload");
  assert.ok(h.multipart.has(up), "which storage still has");
  const again = await h.room.uploadStart(id, "image", "Ada", false, R, 100, "image/png", "pic.png", "fp-100", false);
  assert.equal(again.resumed, true);
  assert.equal((await h.room.uploadFinish(id, "image", "Ada", false, R, null)).status, 200, "and it finishes");
});

test("a stream begun when storage refuses answers 503", async () => {
  const st = holder();
  const h = makeRoom({ before: st.hook });
  const id = await draft(h);
  st.fail("create", "storage is down");
  const r = await h.room.streamBegin(id, "Ada", "video/mp4", 100, false, R);
  assert.equal(r.status, 503);
  assert.equal(row(h, id, "video"), undefined);
});

test("a start during a finish waits for it, then finds the file in place", async () => {
  const st = holder();
  const h = makeRoom({ before: st.hook });
  const id = await draft(h);
  await imageSession(h, id, 100);
  const c = st.hold("complete");
  const f = h.room.uploadFinish(id, "image", "Ada", false, R, null);
  await c.reached;
  const s = h.room.uploadStart(id, "image", "Ada", false, R, 9437184, "image/png", "big.png", "fp-big", false);
  await tick();
  c.release();
  assert.equal((await f).status, 200);
  assert.equal((await s).status, 409, "the message already has its image");
  const r = row(h, id, "image");
  assert.equal(r.upload_id, null);
  assert.equal(r.size, 100, "the size is the stored file's");
  assert.equal(h.objects.get(r.r2key).byteLength, 100);
  assert.equal(h.multipart.size, 0, "no upload left open");
});

test("an abort during a finish leaves the finished file and its row together", async () => {
  const st = holder();
  const h = makeRoom({ before: st.hook });
  const id = await draft(h);
  await imageSession(h, id, 100);
  const c = st.hold("complete");
  const f = h.room.uploadFinish(id, "image", "Ada", false, R, null);
  await c.reached;
  const a = h.room.uploadAbort(id, "image", "Ada", false);
  await tick();
  c.release();
  assert.equal((await f).status, 200);
  assert.equal((await a).aborted, false, "the abort came after the finish: nothing left to cancel");
  const r = row(h, id, "image");
  assert.ok(r && h.objects.has(r.r2key), "the file is listed and stored");
  assert.ok(h.room.mediaMeta(id, "image"));
});

test("a finish sent twice answers both with the same result, and again later", async () => {
  const st = holder();
  const h = makeRoom({ before: st.hook });
  const id = await draft(h);
  await imageSession(h, id, 100);
  const c = st.hold("complete");
  const f1 = h.room.uploadFinish(id, "image", "Ada", false, R, null);
  await c.reached;
  const f2 = h.room.uploadFinish(id, "image", "Ada", false, R, null);
  await tick();
  c.release();
  const [r1, r2] = await Promise.all([f1, f2]);
  assert.equal(r1.status, 200);
  assert.deepEqual(r2, r1, "the retry gets the first finish's answer");
  const r3 = await h.room.uploadFinish(id, "image", "Ada", false, R, null);
  assert.equal(r3.status, 200, "a retry after it ended (its answer lost) answers the stored file");
  assert.equal(r3.bytes, 100);
  assert.equal(r3.type, "image/png");
});

test("a finish for an upload an attach replaced answers 409, not the attach's file", async () => {
  const h = makeRoom();
  const id = await draft(h);
  const s = await h.room.uploadStart(id, "image", "Ada", false, R, 5000, "image/png", "big.png", "fp-big", false);
  assert.equal(s.status, 200);
  assert.equal((await h.room.attachImage(id, "Ada", bytes(PNG_HEAD, 100).buffer, "image/png", false, R)).status, 200);
  const f = await h.room.uploadFinish(id, "image", "Ada", false, R, null);
  assert.equal(f.status, 409, "the upload was replaced; its finish does not report the attached file");
  assert.equal(row(h, id, "image").size, 100, "the attached image stays");
});

// Upload A is replaced by upload B of the same message and kind (its
// start aborts A), and B finishes. A finish from A's client used to answer
// 200 with B's file as A's: the row B left is as engine-made as A's would
// have been. One that says which file it means is told it is not this one.
async function replacedAndFinished(h, id) {
  assert.equal((await h.room.uploadStart(id, "image", "Ada", false, R, 5000, "image/png", "a.png", "fp-a", false)).status, 200);
  await tick(); // B starts a moment later than A, as two uploads do
  await imageSession(h, id, 100);
  assert.equal((await h.room.uploadFinish(id, "image", "Ada", false, R, null)).status, 200, "B finishes");
}

test("a finish naming the file another upload replaced answers 409, not that upload's file", async () => {
  const h = makeRoom();
  const id = await draft(h);
  await replacedAndFinished(h, id);
  const fin = (ask) => h.room.uploadFinish(id, "image", "Ada", false, R, ask);
  assert.equal((await fin({ size: 5000 })).status, 409, "A's size is not the stored file's");
  assert.equal((await fin({ size: 100, fp: "fp-a" })).status, 409, "nor is A's fingerprint, even at the same size");
  assert.equal((await fin({ fp: "fp-a" })).status, 409);
  const b = await fin({ size: 100, fp: "fp-100" });
  assert.equal(b.status, 200, "B's own repeat still answers its file");
  assert.equal(b.bytes, 100);
  const any = await fin(null);
  assert.equal(any.status, 200, "a finish naming nothing answers the stored file");
  assert.equal(any.bytes, 100);
  assert.equal(any.name, "pic.png");
  assert.equal(row(h, id, "image").size, 100, "B's file stays");
});

test("an upload link opened for a replaced upload cannot claim the file that replaced it", async () => {
  const h = makeRoom();
  const id = await draft(h);
  const link = await h.room.mintUploadTicket(id, "image", "Ada", R, false, { size: 5000, type: "image/png", name: "a.png" }, "tok-Ada");
  assert.equal(link.status, 200, link.error);
  await tick();
  await imageSession(h, id, 100);
  assert.equal((await h.room.uploadFinish(id, "image", "Ada", false, R, null)).status, 200, "B finishes");
  const t = await h.room.uploadSessionTicket(link.ticket);
  assert.equal(t.status, 200, "A's link still resolves: it names only the message and kind");
  const r = await h.room.uploadFinish(t.msg, t.kind, t.member, false, R, { expires: t.expires });
  assert.equal(r.status, 409, "the link was opened for another session; the caller sent nothing else");
  // a link opened for the upload that did finish still gets its answer
  const id2 = (await h.room.post("Ada", "another", R, false, null, null, null, true, false)).id;
  const own = await h.room.mintUploadTicket(id2, "image", "Ada", R, false, { size: 100, type: "image/png", name: "b.png" }, "tok-Ada");
  const up = h.one("SELECT upload_id FROM md WHERE msg = ? AND kind = 'image'", id2).upload_id;
  h.multipart.get(up).data = bytes(PNG_HEAD, 100);
  assert.equal(h.room.uploadPartDone(id2, "image", up, 1, "e1").status, 200);
  const t2 = await h.room.uploadSessionTicket(own.ticket);
  assert.equal((await h.room.uploadFinish(id2, "image", "Ada", false, R, { expires: t2.expires })).status, 200);
  const again = await h.room.uploadFinish(id2, "image", "Ada", false, R, { expires: t2.expires });
  assert.equal(again.status, 200, "its repeat after it ended answers the stored file");
  assert.equal(again.bytes, 100);
});

test("a finish on a kind that only ever had an attach or a stream answers 409", async () => {
  const h = makeRoom();
  const id = await draft(h);
  assert.equal((await h.room.attachImage(id, "Ada", bytes(PNG_HEAD, 100).buffer, "image/png", false, R)).status, 200);
  assert.equal((await h.room.uploadFinish(id, "image", "Ada", false, R, null)).status, 409);
  const a = await h.room.streamBegin(id, "Ada", "video/mp4", 100, false, R);
  h.multipart.get(a.uploadId).data = bytes(MP4_HEAD, 100);
  assert.equal((await h.room.streamFinish(id, a.uploadId, [{ partNumber: 1, etag: "e" }], 100, R)).status, 200);
  assert.equal((await h.room.uploadFinish(id, "video", "Ada", false, R, null)).status, 409);
});

test("a stream's part size never looks like an engine plan's (finish tells them apart by it)", () => {
  assert.notEqual(STREAM_PART % MIB, 0);
});

test("a finish whose upload storage already completed indexes the file instead of losing it", async () => {
  // what an instance reset between complete() and the row update leaves
  const h = makeRoom();
  const id = await draft(h);
  const up = await imageSession(h, id, 100);
  const key = row(h, id, "image").r2key;
  await h.room.env.MEDIA.resumeMultipartUpload(key, up).complete([]);
  const f = await h.room.uploadFinish(id, "image", "Ada", false, R, null);
  assert.equal(f.status, 200, f.error);
  assert.equal(row(h, id, "image").upload_id, null);
  assert.ok(h.room.mediaMeta(id, "image"));
});

test("an attach during a finish is not deleted by the finish's size check", async () => {
  const st = holder();
  const h = makeRoom({ after: st.hook });
  const id = await draft(h);
  await imageSession(h, id, 100);
  // the multipart upload has landed in storage; the finish has not looked yet
  const c = st.hold("complete");
  const f = h.room.uploadFinish(id, "image", "Ada", false, R, null);
  await c.reached;
  const at = h.room.attachImage(id, "Ada", bytes(PNG_HEAD, 70).buffer, "image/png", false, R);
  await tick();
  c.release();
  await f;
  assert.equal((await at).status, 200);
  const r = row(h, id, "image");
  assert.ok(r && r.upload_id === null && h.objects.has(r.r2key), "the attached image is listed and stored");
  assert.equal(h.objects.get(r.r2key).byteLength, r.size, "with its own size");
  assert.equal(r.size, 70);
});

test("an attach during a start is not turned back into an upload in flight", async () => {
  const st = holder();
  const h = makeRoom({ before: st.hook });
  const id = await draft(h);
  const c = st.hold("create");
  const s = h.room.uploadStart(id, "image", "Ada", false, R, 100, "image/png", "a.png", "fp-a", false);
  await c.reached;
  const at = h.room.attachImage(id, "Ada", bytes(PNG_HEAD, 70).buffer, "image/png", false, R);
  await tick();
  c.release();
  await s;
  assert.equal((await at).status, 200);
  const r = row(h, id, "image");
  assert.ok(h.room.mediaMeta(id, "image"), "the attached image is served");
  assert.equal(h.objects.get(r.r2key).byteLength, r.size);
  assert.equal(h.multipart.size, 0, "no upload left open");
});

test("a failed stream's cleanup leaves the stream that replaced it alone", async () => {
  const st = holder();
  const h = makeRoom({ before: st.hook });
  const id = await draft(h);
  const a = await h.room.streamBegin(id, "Ada", "video/mp4", 100, false, R);
  const c = st.hold("abort");
  const ab = h.room.streamAbort(id, a.uploadId);
  await c.reached;
  const b = h.room.streamBegin(id, "Ada", "video/mp4", 100, false, R);
  await tick();
  c.release();
  await ab;
  const bb = await b;
  assert.equal(bb.status, 200);
  assert.equal(row(h, id, "video").upload_id, bb.uploadId, "the newer stream keeps its row");
  assert.ok(h.multipart.has(bb.uploadId));
});

test("two streams begun at once: the one that lost cannot replace the published video", async () => {
  const st = holder();
  const h = makeRoom({ before: st.hook });
  const id = await draft(h);
  const c = st.hold("create");
  const a = h.room.streamBegin(id, "Ada", "video/mp4", 100, false, R);
  await c.reached;
  const b = h.room.streamBegin(id, "Ada", "video/mp4", 100, false, R);
  await tick();
  c.release();
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(ra.status, 200);
  assert.equal(rb.status, 200);
  const won = row(h, id, "video").upload_id;
  const lost = won === ra.uploadId ? rb.uploadId : ra.uploadId;
  assert.equal(h.multipart.has(lost), false, "the upload that lost the row is ended");
  h.multipart.get(won).data = bytes(MP4_HEAD, 100);
  const done = await h.room.streamFinish(id, won, [{ partNumber: 1, etag: "e" }], 100, R);
  assert.equal(done.status, 200, done.error);
  assert.equal(h.one("SELECT video_size FROM m WHERE id = ?", id).video_size, 100);
  const key = row(h, id, "video").r2key;
  const late = await h.room.streamFinish(id, lost, [{ partNumber: 1, etag: "e" }], 48, R);
  assert.equal(late.status, 409);
  assert.equal(h.objects.get(key).byteLength, 100, "the published bytes are untouched");
  assert.deepEqual([...h.objects.get(key).slice(0, 12)], MP4_HEAD);
});

test("a sender revoked while the stream waits for its turn gets nothing stored", async () => {
  const h = makeRoom();
  const id = await draft(h);
  const a = await h.room.streamBegin(id, "Ada", "video/mp4", 100, false, R);
  h.multipart.get(a.uploadId).data = bytes(MP4_HEAD, 100);
  // something else holds the message's video turn (a finish or an attach
  // waiting on storage) as the stream's last bytes come in
  let release;
  const busy = h.room.withMediaLock(id, "video", () => new Promise((r) => { release = r; }));
  const done = h.room.streamFinish(id, a.uploadId, [{ partNumber: 1, etag: "e" }], 100, R, { token: "tok-Ada", member: "Ada" });
  await tick();
  assert.equal(h.room.revoke("tok-Ada"), true);
  release();
  await busy;
  const r = await done;
  assert.equal(r.status, 403, r.error);
  assert.ok(!h.multipart.has(a.uploadId), "the stream's upload is ended");
  assert.equal(row(h, id, "video"), undefined, "nothing is stored for it");
  assert.equal(h.objects.size, 0);
});

test("a sender revoked while the stream's upload completes in storage gets nothing stored", async () => {
  const st = holder();
  const h = makeRoom({ before: st.hook });
  const id = await draft(h);
  const a = await h.room.streamBegin(id, "Ada", "video/mp4", 100, false, R);
  h.multipart.get(a.uploadId).data = bytes(MP4_HEAD, 100);
  // the invite was asked before complete(); the revoke lands while storage completes
  const c = st.hold("complete");
  const done = h.room.streamFinish(id, a.uploadId, [{ partNumber: 1, etag: "e" }], 100, R, { token: "tok-Ada", member: "Ada" });
  await c.reached;
  assert.equal(h.room.revoke("tok-Ada"), true);
  c.release();
  const r = await done;
  assert.equal(r.status, 403, r.error);
  assert.equal(row(h, id, "video"), undefined, "nothing is stored for it");
  assert.equal(h.objects.size, 0, "the completed object is deleted");
});

test("a stream whose bytes do not check out is discarded with its row", async () => {
  const h = makeRoom();
  const id = await draft(h);
  const a = await h.room.streamBegin(id, "Ada", "video/mp4", 48, false, R);
  h.multipart.get(a.uploadId).data = new TextEncoder().encode("<html><script>alert(1)</script></html>          ");
  const r = await h.room.streamFinish(id, a.uploadId, [{ partNumber: 1, etag: "e" }], 48, R);
  assert.equal(r.status, 400);
  assert.equal(row(h, id, "video"), undefined);
  assert.equal(h.objects.size, 0);
});

// A direct session's parts are listed by storage (S3 ListParts over fetch).
const DIRECT_ENV = { R2_ACCESS_KEY_ID: "k", R2_SECRET_ACCESS_KEY: "s", R2_ACCOUNT_ID: "acct", R2_BUCKET: "b" };
async function withFetch(answer, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = async () => answer();
  try { return await fn(); } finally { globalThis.fetch = real; }
}
async function directSession(h, id, len) {
  const up = await imageSession(h, id, len);
  h.db.prepare("UPDATE md SET mode = 'direct' WHERE msg = ?").run(id);
  return up;
}

test("a resume whose part list storage would not give answers 502, not an empty list", async () => {
  const h = makeRoom({ env: DIRECT_ENV });
  const id = await draft(h);
  const up = await directSession(h, id, 100);
  const r = await withFetch(() => new Response("<Error><Code>InternalError</Code></Error>", { status: 500 }),
    () => h.room.uploadStart(id, "image", "Ada", false, R, 100, "image/png", "pic.png", "fp-100", false));
  assert.equal(r.status, 502, "the client asks again instead of re-sending every part");
  assert.equal(row(h, id, "image").upload_id, up, "the session is kept");
});

test("a resume of an upload storage no longer has starts a fresh one", async () => {
  const h = makeRoom({ env: DIRECT_ENV });
  const id = await draft(h);
  const up = await directSession(h, id, 100);
  const r = await withFetch(() => new Response("<Error><Code>NoSuchUpload</Code></Error>", { status: 404 }),
    () => h.room.uploadStart(id, "image", "Ada", false, R, 100, "image/png", "pic.png", "fp-100", false));
  assert.equal(r.status, 200);
  assert.equal(r.resumed, false);
  assert.notEqual(row(h, id, "image").upload_id, up);
  assert.ok(h.multipart.has(row(h, id, "image").upload_id));
});

test("a start whose upload storage already completed indexes the file instead of starting over", async () => {
  const h = makeRoom({ env: DIRECT_ENV });
  const id = await draft(h);
  const up = await directSession(h, id, 100);
  await h.room.env.MEDIA.resumeMultipartUpload(row(h, id, "image").r2key, up).complete([]);
  const r = await withFetch(() => new Response("<Error><Code>NoSuchUpload</Code></Error>", { status: 404 }),
    () => h.room.uploadStart(id, "image", "Ada", false, R, 100, "image/png", "pic.png", "fp-100", false));
  assert.equal(r.status, 409, "answered as for a file in place, not a fresh session");
  assert.equal(row(h, id, "image").upload_id, null);
  assert.equal(h.multipart.size, 0, "no new upload opened");
  assert.ok(h.room.mediaMeta(id, "image"), "the file is listed");
});

test("a direct finish retried after storage completed the upload indexes it", async () => {
  const h = makeRoom({ env: DIRECT_ENV });
  const id = await draft(h);
  const up = await directSession(h, id, 100);
  await h.room.env.MEDIA.resumeMultipartUpload(row(h, id, "image").r2key, up).complete([]);
  const f = await withFetch(() => new Response("<Error><Code>NoSuchUpload</Code></Error>", { status: 404 }),
    () => h.room.uploadFinish(id, "image", "Ada", false, R, null));
  assert.equal(f.status, 200, f.error);
  assert.ok(h.room.mediaMeta(id, "image"));
});

// Turning R2_DIRECT off stops the direct path for uploads in flight too,
// not only new ones: resumes went on direct and /sign kept signing for
// up to the session's 7 days.
const LISTED_NONE = () => new Response("<ListPartsResult><IsTruncated>false</IsTruncated></ListPartsResult>");

test("with R2_DIRECT off, a direct upload in flight carries on through the site", async () => {
  const on = makeRoom({ env: { ...DIRECT_ENV, R2_DIRECT: "1" } });
  const onId = await draft(on);
  await directSession(on, onId, 100);
  assert.equal(on.room.uploadSignTarget(onId, "image", "Ada", false, [1]).status, 200, "switched on, it signs");

  const h = makeRoom({ env: DIRECT_ENV });
  const id = await draft(h);
  const up = await directSession(h, id, 100);
  const s = h.room.uploadSignTarget(id, "image", "Ada", false, [1]);
  assert.equal(s.status, 409);
  assert.match(s.error, /turned off.*\/part\?n=N/);
  assert.equal(h.room.uploadSignTarget(id, "image", null, true, [1]).status, 200, "the owner may still force it");
  assert.equal(h.room.uploadPartTarget(id, "image", "Ada", false, 1, 100).status, 200, "its parts go through the site");
  const r = await withFetch(LISTED_NONE, () => h.room.uploadStart(id, "image", "Ada", false, R, 100, "image/png", "pic.png", "fp-100", true));
  assert.equal(r.status, 200, r.error);
  assert.equal(r.resumed, true, "the same upload, with the parts it has");
  assert.equal(r.direct, false);
  assert.equal(row(h, id, "image").upload_id, up);
  const st = await withFetch(LISTED_NONE, () => h.room.uploadStatus(id, "image", "Ada", false));
  assert.equal(st.direct, false);
});

test("with R2_DIRECT off, a direct upload whose parts only storage takes is told to start again, and kept", async () => {
  const h = makeRoom({ env: DIRECT_ENV });
  const id = await draft(h);
  const up = await directSession(h, id, 100);
  const ps = UP_PART_MAX + MIB, size = 3 * ps;
  h.db.prepare("UPDATE md SET part_size = ?, size = ? WHERE msg = ?").run(ps, size, id);
  const s = h.room.uploadSignTarget(id, "image", "Ada", false, [1]);
  assert.equal(s.status, 409);
  assert.match(s.error, /Abort it .* and start again/);
  assert.equal(h.room.uploadPartTarget(id, "image", "Ada", false, 1, ps).status, 409);
  const r = await withFetch(LISTED_NONE, () => h.room.uploadStart(id, "image", "Ada", false, R, size, "image/png", "pic.png", "fp-100", true));
  assert.equal(r.status, 409, "no resume onto parts nothing can carry");
  assert.match(r.error, /Abort it .* and start again/);
  assert.equal(row(h, id, "image").upload_id, up, "the upload is left as it was");
  assert.ok(h.multipart.has(up));
});

test("a message deleted during a finish leaves no object behind", async () => {
  const st = holder();
  const h = makeRoom({ after: st.hook });
  const id = await draft(h);
  await imageSession(h, id, 100);
  const key = row(h, id, "image").r2key;
  const c = st.hold("complete");
  const f = h.room.uploadFinish(id, "image", "Ada", false, R, null);
  await c.reached;
  assert.equal((await h.room.deleteMessage(id, "Ada", false)).status, 200);
  // storage put the completed object back after the delete removed it
  h.objects.set(key, bytes(PNG_HEAD, 100));
  c.release();
  const r = await f;
  assert.notEqual(r.status, 200);
  assert.equal(h.objects.has(key), false, "the object goes with its message");
  assert.equal(h.all("SELECT msg FROM md").length, 0);
});

// A removed member's uploads in flight end with the removal: storage
// aborts each one, so a part address already handed out (a direct
// upload's are good for an hour) is refused, and nothing is left for a
// name invited again to resume. Files already in place stay.
test("a revoke aborts the member's uploads in flight and keeps their finished files", async () => {
  const h = makeRoom();
  const id = await draft(h);
  const up = await imageSession(h, id, 100);
  const done = (await h.room.post("Ada", "a finished picture", R, false, null, null, null, true, false)).id;
  await imageSession(h, done, 100);
  assert.equal((await h.room.uploadFinish(done, "image", "Ada", false, R, null)).status, 200);
  const doneKey = row(h, done, "image").r2key;
  h.member("Bob");
  const bobDraft = (await h.room.post("Bob", "Bob's", R, false, null, null, null, true, false)).id;
  const bs = await h.room.uploadStart(bobDraft, "image", "Bob", false, R, 100, "image/png", "b.png", "fp-b", false);
  assert.equal(bs.status, 200);
  const bobUp = row(h, bobDraft, "image").upload_id;

  assert.equal(h.room.revoke("tok-Ada"), true);
  await h.settled();
  assert.equal(h.multipart.has(up), false, "storage aborted the upload: its part addresses are refused");
  assert.equal(h.all("SELECT msg FROM md WHERE msg = ?", id).length, 0, "the session's rows went");
  assert.equal(h.all("SELECT msg FROM upp WHERE msg = ?", id).length, 0);
  assert.equal(h.room.uploadPartDone(id, "image", up, 1, "e1").status, 409);
  assert.ok(h.one("SELECT id FROM m WHERE id = ?", id), "the draft itself stays");
  assert.ok(h.objects.has(doneKey) && h.room.mediaMeta(done, "image"), "a finished file stays");
  assert.ok(h.multipart.has(bobUp), "another member's upload goes on");
});

test("a revoke during an upload start aborts the session that start writes", async () => {
  const st = holder();
  const h = makeRoom({ after: st.hook });
  const id = await draft(h);
  const c = st.hold("create");
  const s = h.room.uploadStart(id, "image", "Ada", false, R, 100, "image/png", "pic.png", "fp-1", false);
  await c.reached;
  assert.equal(h.room.revoke("tok-Ada"), true);
  await tick();
  c.release();
  await s;
  await h.settled();
  assert.equal(h.multipart.size, 0, "no upload left in storage");
  assert.equal(h.all("SELECT msg FROM md WHERE msg = ?", id).length, 0);
});

test("revoke everyone aborts every member's uploads in flight", async () => {
  const h = makeRoom();
  const id = await draft(h);
  const up = await imageSession(h, id, 100);
  await h.room.revokeAll();
  await h.settled();
  assert.equal(h.multipart.has(up), false);
  assert.equal(h.all("SELECT msg FROM md").length, 0);
});
