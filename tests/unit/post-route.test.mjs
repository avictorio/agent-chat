// POST /messages (worker/routes/messages.ts messagesRoute) end to end on
// the real Room class (room-harness.mjs): the room object is the route's
// stub, so what the route reads from the body, refuses and answers is
// checked against what the room really stored.
import test from "node:test";
import assert from "node:assert/strict";
import { messagesRoute, publishRoute } from "../../worker/routes/messages.ts";
import { mcpCallTool } from "../../worker/agents/mcp.ts";
import { BadRequest } from "../../worker/lib/http.ts";
import { makeRoom } from "./room-harness.mjs";
import { CLIENT_MSG_ID_KEEP, CLIENT_MSG_ID_MAX, CLIENT_MSG_ID_MS, DOC_MAX, HTML_MAX, IMAGE_MAX, INLINE_TOTAL_MAX, VIDEO_MAX } from "../../worker/limits.ts";

const R = "unit";

/** POST /api/rooms/unit/messages as Ada, through the route; a BadRequest
 *  is answered as the Worker's fetch answers it (index.ts) */
async function post(h, body, headers = {}, stub = h.room) {
  const env = { ROOM: { idFromName: (n) => n, get: () => stub } };
  const url = new URL("http://localhost/api/rooms/" + R + "/messages");
  const request = new Request(url, { method: "POST", body, headers: { "X-Invite-Token": "tok-Ada", ...headers } });
  let res;
  try { res = await messagesRoute({ request, env, url, path: url.pathname, owner: false, invite: "tok-Ada" }, /^\/api\/rooms\/([^/]+)\/messages$/.exec(url.pathname)); }
  catch (e) { if (e instanceof BadRequest) return { status: 400, json: { error: e.message } }; throw e; }
  return { status: res.status, json: await res.json() };
}

const texts = (h) => h.all("SELECT text, draft FROM m ORDER BY id").map((r) => ({ text: r.text, draft: r.draft }));

test("a JSON body sent without a JSON Content-Type is read as JSON", async () => {
  const h = makeRoom();
  h.member("Ada");
  // fetch's default for a string body, and curl -d's default
  for (const ct of [null, "text/plain;charset=UTF-8", "application/x-www-form-urlencoded"]) {
    const r = await post(h, JSON.stringify({ text: "hello " + ct, draft: true }), ct ? { "Content-Type": ct } : {});
    assert.equal(r.status, 201, ct + ": " + JSON.stringify(r.json));
    assert.equal(r.json.text, "hello " + ct);
    assert.equal(r.json.draft, true, ct + ": the draft field was read");
  }
  assert.deepEqual(texts(h).map((x) => x.text), ["hello null", "hello text/plain;charset=UTF-8", "hello application/x-www-form-urlencoded"]);
});

test("a body that starts with { but is not JSON is refused, not posted", async () => {
  const h = makeRoom();
  h.member("Ada");
  const r = await post(h, "{not json", { "Content-Type": "text/plain" });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /Send JSON like/);
  assert.equal(texts(h).length, 0);
});

test("plain text and form bodies still post their text", async () => {
  const h = makeRoom();
  h.member("Ada");
  assert.equal((await post(h, "just words", { "Content-Type": "text/plain" })).status, 201);
  assert.equal((await post(h, "text=from+a+form", { "Content-Type": "application/x-www-form-urlencoded" })).status, 201);
  const fd = new FormData();
  fd.set("text", "from a multipart form");
  assert.equal((await post(h, fd)).status, 201);
  assert.deepEqual(texts(h).map((x) => x.text), ["just words", "from a form", "from a multipart form"]);
});

/** the room as its stub, except that room_state fails as an RPC to an
 *  object that reset between two calls does */
function stateFails(h) {
  return new Proxy(h.room, { get: (t, k) => (k === "roomState" ? async () => { throw new Error("Durable Object reset because its code was updated."); } : typeof t[k] === "function" ? t[k].bind(t) : t[k]) });
}

test("a saved post, publish or MCP post is answered as saved when the room_state read after it fails", async () => {
  const h = makeRoom();
  h.member("Ada");
  const stub = stateFails(h);
  let r = await post(h, JSON.stringify({ text: "saved" }), { "Content-Type": "application/json" }, stub);
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.equal(r.json.text, "saved");
  assert.ok(!("room_state" in r.json), "room_state is left out, not an error");
  r = await post(h, JSON.stringify({ text: "a draft", draft: true }), { "Content-Type": "application/json" }, stub);
  const env = { ROOM: { idFromName: (n) => n, get: () => stub } };
  const url = new URL("http://localhost/api/rooms/" + R + "/messages/" + r.json.id + "/publish");
  const res = await publishRoute({ request: new Request(url, { method: "POST" }), env, url, path: url.pathname, owner: false, invite: "tok-Ada" }, /^\/api\/rooms\/([^/]+)\/messages\/(\d+)\/publish$/.exec(url.pathname));
  assert.equal(res.status, 200);
  assert.equal((await res.json()).id, r.json.id);
  const m = await mcpCallTool({}, stub, R, "http://localhost", false, { kind: "agent" }, "Ada", "post_message", { text: "over MCP" });
  assert.equal(m.text, "over MCP");
  assert.ok(!("room_state" in JSON.parse(JSON.stringify(m))));
  assert.deepEqual(texts(h).map((x) => [x.text, x.draft]), [["saved", null], ["a draft", null], ["over MCP", null]], "each was saved once");
});

/** a file of n bytes that sniffs as its kind */
function file(kind, n) {
  const b = Buffer.alloc(n, 0);
  if (kind === "video") Buffer.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]).copy(b);
  if (kind === "image") Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b);
  if (kind === "audio") Buffer.from([0x49, 0x44, 0x33]).copy(b);
  return b.toString("base64");
}

test("inline files that together pass what one call to the room carries are refused with 413, before anything is stored", async () => {
  const h = makeRoom();
  h.member("Ada");
  // each under its own cap: 25 + 5 + 2 MB is exactly the most a post carries
  const at = { text: "at the cap", video: file("video", VIDEO_MAX), image: file("image", IMAGE_MAX), audio: file("audio", INLINE_TOTAL_MAX - VIDEO_MAX - IMAGE_MAX) };
  let r = await post(h, JSON.stringify(at), { "Content-Type": "application/json" });
  assert.equal(r.status, 201, JSON.stringify(r.json).slice(0, 200));
  const over = { ...at, text: "one byte over", audio: file("audio", INLINE_TOTAL_MAX - VIDEO_MAX - IMAGE_MAX + 1) };
  r = await post(h, JSON.stringify(over), { "Content-Type": "application/json" });
  assert.equal(r.status, 413);
  assert.match(r.json.error, /together/);
  assert.match(r.json.error, /\/start/, "it names the upload path");
  await assert.rejects(mcpCallTool({}, h.room, R, "http://localhost", false, { kind: "agent" }, "Ada", "post_message", { text: "over MCP", video_base64: over.video, image_base64: over.image, audio_base64: over.audio }), /together[\s\S]*begin_upload/);
  assert.deepEqual(texts(h).map((x) => x.text), ["at the cap"], "nothing was stored for the refused posts");
  assert.equal(h.objects.size, 3, "only the first post's three files are in storage");
});

const asJson = { "Content-Type": "application/json" };

test("a post sent again with its client_msg_id answers with the first post instead of posting twice", async () => {
  const h = makeRoom();
  h.member("Ada"); h.member("Bob");
  const first = await post(h, JSON.stringify({ text: "only once", client_msg_id: "c-1" }), asJson);
  assert.equal(first.status, 201);
  assert.ok(!("repeat" in first.json));
  const again = await post(h, JSON.stringify({ text: "only once", client_msg_id: "c-1" }), asJson);
  assert.equal(again.status, 200, "nothing new was made");
  assert.equal(again.json.repeat, true);
  assert.equal(again.json.id, first.json.id);
  assert.equal(again.json.text, "only once");
  // a new id posts; the id is the sender's own, so Bob's c-1 is his first
  assert.equal((await post(h, JSON.stringify({ text: "only once", client_msg_id: "c-2" }), asJson)).status, 201);
  const bob = await mcpCallTool({}, h.room, R, "http://localhost", false, { kind: "agent" }, "Bob", "post_message", { text: "bob's", client_msg_id: "c-1" });
  assert.notEqual(bob.id, first.json.id);
  const bobAgain = await mcpCallTool({}, h.room, R, "http://localhost", false, { kind: "agent" }, "Bob", "post_message", { text: "bob's", client_msg_id: "c-1" });
  assert.equal(bobAgain.repeat, true);
  assert.equal(bobAgain.id, bob.id);
  assert.deepEqual(texts(h).map((x) => x.text), ["only once", "only once", "bob's"]);
});

test("a repeated draft answers with the draft, and once it is published with the live message", async () => {
  const h = makeRoom();
  h.member("Ada");
  const d = await post(h, JSON.stringify({ text: "caption", draft: true, publish_on_complete: true, client_msg_id: "d-1" }), asJson);
  let again = await post(h, JSON.stringify({ text: "caption", draft: true, publish_on_complete: true, client_msg_id: "d-1" }), asJson);
  assert.equal(again.status, 200);
  assert.deepEqual([again.json.id, again.json.draft, again.json.publish_on_complete, again.json.repeat], [d.json.id, true, true, true]);
  assert.equal(h.all("SELECT id FROM m").length, 1, "one draft, not two");
  await h.room.publishMessage(d.json.id, "Ada", false, R, "now live");
  again = await post(h, JSON.stringify({ text: "caption", draft: true, client_msg_id: "d-1" }), asJson);
  assert.equal(again.status, 200);
  assert.equal(again.json.text, "now live");
  assert.ok(!again.json.draft && !again.json.publish_on_complete);
});

test("a repeat while the first post is still storing its files, or after its message is gone, posts nothing and says so", async () => {
  let release;
  const held = new Promise((r) => { release = r; });
  const h = makeRoom({ put: () => held });
  h.member("Ada");
  const body = JSON.stringify({ text: "with a picture", image: file("image", 100), client_msg_id: "p-1" });
  const first = post(h, body, asJson);
  await new Promise((r) => setTimeout(r, 10));
  const during = await post(h, body, asJson);
  assert.equal(during.status, 409);
  assert.match(during.json.error, /still storing/);
  assert.equal(during.json.code, "still_storing");
  release();
  const done = await first;
  assert.equal(done.status, 201);
  assert.equal(during.json.id, done.json.id);
  assert.equal((await post(h, body, asJson)).json.repeat, true);
  await h.room.deleteMessage(done.json.id, "Ada", false);
  const gone = await post(h, body, asJson);
  assert.equal(gone.status, 409, "a deleted message is not brought back");
  assert.match(gone.json.error, /no longer in the room/);
  assert.equal(gone.json.code, "post_gone");
  assert.equal(h.all("SELECT id FROM m").length, 0);
});

test("a post whose storage failed is posted by the retry with the same client_msg_id", async () => {
  let fail = true;
  const h = makeRoom({ put: () => { if (fail) throw new Error("R2 down"); } });
  h.member("Ada");
  const body = JSON.stringify({ text: "pic", image: file("image", 100), client_msg_id: "f-1" });
  assert.equal((await post(h, body, asJson)).status, 503);
  fail = false;
  const retry = await post(h, body, asJson);
  assert.equal(retry.status, 201, JSON.stringify(retry.json));
  assert.ok(!retry.json.repeat);
  assert.equal(h.all("SELECT id FROM m").length, 1);
});

// Any failure while the files are stored, not only storage's, drops the
// held message and its client_msg_id: only a store error did, and a retry
// with the same id was told "still storing its files" for a day.
test("a post that fails for any reason while storing its files is posted by the retry with the same client_msg_id", async () => {
  const h = makeRoom();
  h.member("Ada");
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]).buffer;
  const real = h.room.putMedia;
  let failing = true;
  h.room.putMedia = async function (...args) { if (failing) throw new TypeError("not a storage error"); return real.apply(this, args); };
  await assert.rejects(h.room.postKeyed("x-1", "Ada", "pic", R, false, null, { data: png, type: "image/png" }), /not a storage error/);
  assert.equal(h.all("SELECT id FROM m").length, 0, "nothing was posted");
  assert.equal(h.all("SELECT cid FROM pcid").length, 0, "and the id is free again");
  failing = false;
  const retry = await h.room.postKeyed("x-1", "Ada", "pic", R, false, null, { data: png, type: "image/png" });
  assert.ok(retry && !("repeat" in retry) && !("status" in retry), JSON.stringify(retry));
  assert.ok(retry.image, "posted with its picture");
  assert.equal(h.all("SELECT id FROM m WHERE draft IS NULL").length, 1);
});

// A post's files are stored one put at a time, with the first file's row
// in place while the next is stored. Nothing publishes or sweeps the
// message meanwhile (Room.storing): a sweep, an upload's auto-publish or
// the sender's own publish sent it out with half its files, and when the
// next put failed the post's cleanup deleted a live message unannounced.
test("a draft still storing its files is not published by a sweep or its sender, and a failed put leaves nothing", async () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]).buffer;
  const mp3 = new Uint8Array([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, 0]).buffer;
  let puts = 0, reached, fail;
  const at = new Promise((r) => { reached = r; });
  const gate = new Promise((_, rej) => { fail = rej; });
  const h = makeRoom({ before: async (op) => { if (op === "put" && ++puts === 2) { reached(); await gate; } } });
  h.member("Ada");
  const frames = [];
  h.room.clients.add({ token: "t", owner: true, name: "", kinds: null, games: null, stateSub: false, stateKey: null, send: (f) => frames.push(f), close: () => {} });
  const first = h.room.postKeyed("s-1", "Ada", "two files", R, false, { data: mp3, type: "audio/mpeg" }, { data: png, type: "image/png" }, null, true, true).then(() => "posted", (e) => "failed: " + e.message);
  await at;
  const id = h.one("SELECT max(id) AS id FROM m").id;
  assert.ok(h.one("SELECT 1 AS x FROM md WHERE msg = ? AND kind = 'audio'", id), "the first file's row is in");
  await h.sweepNow();
  assert.equal(await h.room.maybeAutoPublish(id, R), null);
  const p = await h.room.publishMessage(id, "Ada", false, R, undefined);
  assert.equal(p.status, 409);
  assert.match(p.error, /still storing its files/);
  assert.equal(h.one("SELECT draft FROM m WHERE id = ?", id).draft, 1, "still a draft");
  fail(new Error("R2 down"));
  assert.match(await first, /^failed/);
  assert.equal(h.one("SELECT id FROM m WHERE id = ?", id), undefined, "no row");
  assert.deepEqual(frames.filter((f) => f.startsWith("event: message") || f.startsWith("event: delete")), [], "and no frame");
  assert.equal(h.room.storing.size, 0);
  const retry = await h.room.postKeyed("s-1", "Ada", "two files", R, false, { data: mp3, type: "audio/mpeg" }, { data: png, type: "image/png" }, null, true, true);
  assert.ok(retry && !("repeat" in retry) && !("status" in retry), JSON.stringify(retry));
  assert.ok(retry.audio && retry.image, "the retry posts, with both files");
});

test("a post with two files goes live with both, and its draft publishes once the post has answered", async () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]).buffer;
  const mp3 = new Uint8Array([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, 0]).buffer;
  const h = makeRoom();
  h.member("Ada");
  const live = await h.room.postKeyed("o-1", "Ada", "live", R, false, { data: mp3, type: "audio/mpeg" }, { data: png, type: "image/png" });
  assert.ok(live.audio && live.image);
  assert.ok(!h.one("SELECT draft FROM m WHERE id = ?", live.id).draft, "live");
  const d = await h.room.postKeyed("o-2", "Ada", "draft", R, false, { data: mp3, type: "audio/mpeg" }, { data: png, type: "image/png" }, null, true);
  const p = await h.room.publishMessage(d.id, "Ada", false, R, undefined);
  assert.equal(p.status, 200, p.error);
  assert.ok(p.msg.audio && p.msg.image);
  assert.equal(h.room.storing.size, 0);
});

// The owner key posts under any name: its client_msg_ids are kept apart
// from the member's own, so neither is answered with the other's post.
test("an owner-key post as a member and that member's own post with the same client_msg_id are two posts", async () => {
  const h = makeRoom();
  h.member("Ada");
  const byOwner = await h.room.postKeyed("same", "Ada", "from the owner key", R, true);
  const byAda = await h.room.postKeyed("same", "Ada", "from Ada", R, false);
  assert.ok(!("repeat" in byAda), "Ada's post is not taken for a repeat of the owner's");
  assert.notEqual(byAda.id, byOwner.id);
  const ownerAgain = await h.room.postKeyed("same", "ada", "from the owner key", R, true);
  assert.equal(ownerAgain.repeat, true);
  assert.equal(ownerAgain.msg.id, byOwner.id, "each repeat finds its own first post");
  const adaAgain = await h.room.postKeyed("same", "Ada", "from Ada", R, false);
  assert.equal(adaAgain.msg.id, byAda.id);
});

test("the room still knows a client_msg_id after it restarts", async () => {
  const h = makeRoom();
  h.member("Ada");
  const first = await post(h, JSON.stringify({ text: "before", client_msg_id: "r-1" }), asJson);
  const restarted = new h.room.constructor(h.room.ctx, h.room.env);
  const again = await post(h, JSON.stringify({ text: "before", client_msg_id: "r-1" }), asJson, restarted);
  assert.equal(again.status, 200);
  assert.equal(again.json.id, first.json.id);
});

test("the room keeps a bounded number of client_msg_ids per sender, for a day", async () => {
  const h = makeRoom();
  h.member("Ada");
  for (let i = 0; i < CLIENT_MSG_ID_KEEP + 5; i++) await h.room.postKeyed("k-" + i, "Ada", "n" + i, R, false);
  assert.equal(h.one("SELECT COUNT(*) AS n FROM pcid").n, CLIENT_MSG_ID_KEEP);
  assert.equal(h.one("SELECT COUNT(*) AS n FROM pcid WHERE cid = 'k-0'").n, 0, "the oldest went first");
  h.db.prepare("UPDATE pcid SET ts = ts - ?").run(CLIENT_MSG_ID_MS + 1);
  await h.room.postKeyed("k-new", "Ada", "later", R, false);
  assert.equal(h.one("SELECT COUNT(*) AS n FROM pcid").n, 1, "ids older than a day are let go");
});

test("a client_msg_id that is not one is refused before anything is posted", async () => {
  const h = makeRoom();
  h.member("Ada");
  for (const cid of ["", " ", "x".repeat(CLIENT_MSG_ID_MAX + 1), { a: 1 }, true]) {
    const r = await post(h, JSON.stringify({ text: "x", client_msg_id: cid }), asJson);
    assert.equal(r.status, 400, JSON.stringify(cid));
    assert.match(r.json.error, /client_msg_id/);
  }
  assert.equal(h.all("SELECT id FROM m").length, 0);
});

test("a page or document past its cap is refused with 413 by REST and MCP, as raw text or base64", async () => {
  const h = makeRoom();
  h.member("Ada");
  const big = "<p>" + "x".repeat(HTML_MAX) + "</p>";
  for (const html of [big, "data:text/html;base64," + Buffer.from(big).toString("base64")]) {
    const r = await post(h, JSON.stringify({ text: "page", html }), asJson);
    assert.equal(r.status, 413);
    assert.match(r.json.error, /HTML pages can be up to/);
    await assert.rejects(mcpCallTool({}, h.room, R, "http://localhost", false, { kind: "agent" }, "Ada", "post_message", { text: "page", html }), /HTML pages can be up to/);
  }
  const doc = "data:text/markdown;base64," + Buffer.alloc(DOC_MAX + 1, 65).toString("base64");
  assert.equal((await post(h, JSON.stringify({ text: "doc", doc }), asJson)).status, 413);
  assert.equal(h.all("SELECT id FROM m").length, 0);
});
