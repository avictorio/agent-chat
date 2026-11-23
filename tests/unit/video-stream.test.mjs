// The one-PUT video stream (videoStreamRoute, worker/routes/uploads.ts) on
// the real Room class (room-harness.mjs): what it accepts, and that its
// cleanup and its finish are handed to waitUntil, which is what keeps them
// running when Cloudflare cancels a request whose client went away.
import test from "node:test";
import assert from "node:assert/strict";
import { makeRoom } from "./room-harness.mjs";
import { videoStreamRoute } from "../../worker/routes/uploads.ts";

const R = "unit";
const MP4_HEAD = [0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32];
/** bytes of a file of that length starting with that header */
const bytes = (head, len) => { const b = new Uint8Array(len); b.set(head); return b; };

async function draft(h, pubauto = false) {
  h.member("Ada");
  return (await h.room.post("Ada", "a clip", R, false, null, null, null, true, pubauto)).id;
}

/** a body that sends chunks, then fails (fail) or ends */
function body(chunks, fail) {
  return new ReadableStream({
    pull(c) {
      if (chunks.length) c.enqueue(chunks.shift());
      else if (fail) c.error(new Error("the client went away"));
      else c.close();
    },
  });
}

/** a room whose storage notes whether waitUntil had the work when the stream's upload was created */
function roomWatched() {
  const seen = { handed: false, early: false };
  const h = makeRoom({ before: (op) => { if (op === "create" && seen.handed) seen.early = true; } });
  h.seen = seen;
  return h;
}

/** runs the route as Ada; answers { res, handed: promises given to waitUntil, early: whether that came before the upload was made } */
async function put(h, id, stream, headers = {}) {
  const handed = [];
  const ctx = { waitUntil: (p) => { h.seen.handed = true; handed.push(p); }, passThroughOnException() {} };
  const env = { ROOM: { idFromName: (n) => n, get: () => h.room }, MEDIA: h.room.env.MEDIA };
  const url = new URL("http://localhost/api/rooms/" + R + "/messages/" + id + "/video/stream");
  const request = new Request(url, { method: "PUT", body: stream, duplex: "half", headers: { "X-Invite-Token": "tok-Ada", ...headers } });
  const m = /^\/api\/rooms\/([^/]+)\/messages\/(\d+)\/video\/stream$/.exec(url.pathname);
  const res = await videoStreamRoute({ request, env, url, path: url.pathname, owner: false, invite: "tok-Ada", ctx }, m);
  return { res, handed, early: h.seen.early };
}

test("a stream cut off mid-body is cleaned up under waitUntil", async () => {
  const h = roomWatched();
  const id = await draft(h);
  const b = body([bytes(MP4_HEAD, 64)], true);
  const { res, handed, early } = await put(h, id, b, { "Content-Type": "video/mp4" });
  assert.equal(res.status, 502);
  // handed over before the upload was made: a cancel anywhere after it
  // still leaves the abort and the row's cleanup to run
  assert.ok(handed.length >= 1 && early, "the stream's work was handed to waitUntil before its upload was made");
  await Promise.all(handed);
  assert.equal(h.all("SELECT 1 FROM md WHERE msg = ?", id).length, 0, "no upload left on the message");
  assert.equal(h.multipart.size, 0, "the multipart upload is aborted");
});

test("a stream's finish and publish run under waitUntil", async () => {
  const h = roomWatched();
  const id = await draft(h, true);
  const b = body([bytes(MP4_HEAD, 40), new Uint8Array(60)], false);
  const run = put(h, id, b, { "Content-Type": "video/mp4", "Content-Length": "100" });
  const { res, handed } = await run;
  assert.equal(res.status, 200);
  assert.ok(handed.length >= 1, "the stream's work was handed to waitUntil");
  await Promise.all(handed);
  const md = h.one("SELECT type, size, upload_id FROM md WHERE msg = ? AND kind = 'video'", id);
  assert.deepEqual({ ...md }, { type: "video/mp4", size: 100, upload_id: null });
  assert.ok(!h.one("SELECT draft FROM m WHERE id = ?", id).draft, "the publish_on_complete draft is posted");
});
