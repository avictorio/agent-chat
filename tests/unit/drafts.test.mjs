// Drafts are their sender's alone until they publish (worker/room/messages.ts,
// media.ts, uploads.ts), on the real Room class (room-harness.mjs). Each
// test is a way another member could tell a draft was there.
import test from "node:test";
import assert from "node:assert/strict";
import { makeRoom } from "./room-harness.mjs";

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
