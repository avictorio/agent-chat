// A room deleted while calls to it are still in flight (worker/room/
// Room.ts: destroy, fence), on the real Room class (room-harness.mjs).
// Each test holds one storage call open, deletes the room (and mostly
// creates it again under the name), then lets the call go on: it used to
// write into the new room, delete from it, or leave its object in the
// bucket for good.
import test from "node:test";
import assert from "node:assert/strict";
import { makeRoom } from "./room-harness.mjs";
import { isGoneError } from "../../worker/lib/errors.ts";

const R = "unit";
const PNG_HEAD = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13];
/** a PNG-looking file of len bytes */
const png = (len) => { const b = new Uint8Array(len); b.set(PNG_HEAD); return { data: b.buffer, type: "image/png" }; };
const tick = () => new Promise((r) => setTimeout(r, 5));

// Holds the next storage call of each named op (or throws in it) until
// released (as in upload-sessions.test.mjs).
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
    hold(op) {
      let reached, release;
      const r = new Promise((res) => { reached = res; });
      const gate = new Promise((res) => { release = res; });
      held.set(op, { reached, gate });
      return { reached: r, release };
    },
    fail(op, message) { held.set(op, { reached: () => {}, error: new Error(message) }); },
  };
}

/** the owner removes everyone, deletes the room and creates it again with Bea in it */
async function deleteAndRecreate(h) {
  await h.room.revokeAll();
  assert.deepEqual(await h.room.destroy(R), { deleted: true });
  assert.equal(h.room.create(), true);
  h.member("Bea");
}

/** a stream client that records its frames */
function listener(h) {
  const frames = [];
  h.room.clients.add({ token: "", owner: true, name: "", kinds: null, games: null, stateSub: false, stateKey: null, send: (s) => frames.push(s), close() {} });
  return frames;
}

test("a room created again under the name hands out new ids, not the old room's", async () => {
  const h = makeRoom();
  h.member("Ada");
  for (let i = 0; i < 3; i++) await h.room.post("Ada", "old " + i, R, false);
  await deleteAndRecreate(h);
  const m = await h.room.post("Bea", "new", R, false);
  assert.equal(m.id, 4, "ids carry on from the deleted room's");
  assert.equal(h.one("SELECT COUNT(*) AS n FROM m").n, 1, "and nothing else of it is left");
});

test("a post whose picture lands after the room is deleted and created again stops with 410 and leaves nothing", async () => {
  const st = holder();
  const h = makeRoom({ before: st.hook });
  h.member("Ada");
  const p = st.hold("put");
  const post = h.room.post("Ada", "old room secret caption", R, false, null, png(50));
  await p.reached;
  await deleteAndRecreate(h);
  const mine = await h.room.post("Bea", "the new room's first message", R, false);
  const frames = listener(h);
  p.release();
  await assert.rejects(post, (e) => isGoneError(e));
  assert.equal(h.objects.size, 0, "the picture stored for the deleted room is deleted");
  assert.equal(h.one("SELECT COUNT(*) AS n FROM md").n, 0, "no media row in the new room");
  assert.equal(h.one("SELECT image_type FROM m WHERE id = ?", mine.id).image_type, null, "the new room's message has no picture");
  assert.deepEqual(frames, [], "nothing is announced to the new room");
});

test("a post whose picture lands after the room is deleted stops with 410 and deletes the picture", async () => {
  const st = holder();
  const h = makeRoom({ before: st.hook });
  h.member("Ada");
  const p = st.hold("put");
  const post = h.room.post("Ada", "caption", R, false, null, png(50));
  await p.reached;
  await h.room.revokeAll();
  await h.room.destroy(R);
  p.release();
  await assert.rejects(post, (e) => isGoneError(e));
  assert.equal(h.objects.size, 0, "no object is left in the bucket");
});

test("a delete waiting on storage across a delete and re-create leaves the new room's picture alone", async () => {
  const st = holder();
  const h = makeRoom({ before: st.hook });
  h.member("Ada");
  const old = await h.room.post("Ada", "old", R, false, null, png(40));
  const d = st.hold("delete");
  const del = h.room.deleteMessage(old.id, "Ada", false);
  await d.reached;
  await deleteAndRecreate(h);
  const neu = await h.room.post("Bea", "new", R, false, null, png(60));
  d.release();
  await del;
  const r = h.one("SELECT r2key FROM md WHERE msg = ? AND kind = 'image'", neu.id);
  assert.ok(r && h.objects.has(r.r2key), "the new room's picture is still stored");
});

test("a stream opened while the room is being deleted is refused", async () => {
  const st = holder();
  const h = makeRoom({ before: st.hook });
  h.member("Ada");
  await h.room.post("Ada", "with a picture", R, false, null, png(40));
  await h.room.revokeAll();
  const d = st.hold("delete");
  const gone = h.room.destroy(R);
  await d.reached;
  try {
    const res = await h.room.fetch(new Request("http://room/?room=" + R + "&after=latest&owner=1"));
    assert.equal(res.status, 410);
    assert.equal((await res.json()).code, "room_deleted");
    d.release();
    await gone;
    assert.equal(h.room.create(), true);
    assert.equal(h.room.clients.size, 0, "no stream carries on into the room created again");
  } finally {
    // the old code registered the stream and started its keep-alive timer
    d.release();
    if (h.room.pinger) clearInterval(h.room.pinger);
  }
});

test("an upload finish that completes in storage after the room is deleted stops with 410 and deletes the file", async () => {
  const st = holder();
  const h = makeRoom({ before: st.hook });
  h.member("Ada");
  const id = (await h.room.post("Ada", "with a file", R, false, null, null, null, true, false)).id;
  const s = await h.room.uploadStart(id, "image", "Ada", false, R, 100, "image/png", "pic.png", "fp", false);
  assert.equal(s.status, 200);
  const up = h.one("SELECT upload_id FROM md WHERE msg = ?", id).upload_id;
  h.multipart.get(up).data = new Uint8Array(png(100).data);
  assert.equal(h.room.uploadPartDone(id, "image", up, 1, "e1").status, 200);
  const c = st.hold("complete");
  const f = h.room.uploadFinish(id, "image", "Ada", false, R, null);
  await c.reached;
  // storage was already completing it, so the delete's abort finds nothing to end
  st.fail("abort", "the upload is completing");
  await h.room.revokeAll();
  await h.room.destroy(R);
  c.release();
  await assert.rejects(f, (e) => isGoneError(e));
  assert.equal(h.objects.size, 0, "the completed file is not left in the bucket");
});

test("an avatar stored while the room is deleted and created again is not given to the new member of that name", async () => {
  const st = holder();
  const h = makeRoom({ before: st.hook });
  h.member("Ada");
  const p = st.hold("put");
  const set = h.room.setAvatar("Ada", png(30).data, "image/png", R);
  await p.reached;
  await deleteAndRecreate(h);
  h.member("Ada");
  p.release();
  await assert.rejects(set, (e) => isGoneError(e));
  assert.equal(h.one("SELECT avatar_key FROM inv WHERE name = 'Ada'").avatar_key, null, "the new Ada has no avatar");
  assert.equal(h.objects.size, 0);
});

test("a voice sample stored while the room is deleted and created again does not land on the new member's", async () => {
  const st = holder();
  const h = makeRoom({ before: st.hook });
  h.member("Ada");
  const p = st.hold("put");
  const put = h.room.putVoiceSample("Ada", new Uint8Array([1, 2, 3]).buffer, "audio/mpeg", R);
  await p.reached;
  await deleteAndRecreate(h);
  h.member("Ada");
  const { key } = await h.room.putVoiceSample("Ada", new Uint8Array([9, 9]).buffer, "audio/mpeg", R);
  p.release();
  await assert.rejects(put, (e) => isGoneError(e));
  assert.equal(h.one("SELECT sample_key FROM mv WHERE name = 'ada'").sample_key, key, "the new Ada keeps her own sample");
  assert.deepEqual([...h.objects.get(key)], [9, 9], "with her own bytes");
  assert.equal(h.objects.size, 1, "the old room's sample is not left in the bucket");
});

test("a media link signed before a delete opens nothing in the room created again; the new room's own links work", async () => {
  const h = makeRoom();
  h.room.roomName = R;
  const linkOf = (id, kind) => {
    const q = new URLSearchParams(h.room.mediaQuery(id, kind).slice(1));
    return { room: R, id: id, kind: kind, exp: q.get("exp"), sig: q.get("sig") };
  };
  const old = linkOf("ada", "avatar");
  assert.equal(h.room.access(null, false, old).ok, true, "a good link opens the read");
  const bad = h.room.access(null, false, { ...old, sig: old.sig.slice(1) + "A" });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, "media_link_invalid");
  assert.equal(h.room.access(null, false).code, "invite_missing", "no link and no invite is the usual refusal");
  await h.room.destroy(R);
  h.room.create();
  assert.equal(h.room.access(null, false, old).ok, false, "the old room's link is refused");
  assert.equal(h.room.access(null, false, linkOf("ada", "avatar")).ok, true, "the new room's link is good");
});

// The Referee's judge (a Claude call) is in flight when the room is
// deleted and created again, and the new room plays a match that gets the
// same id. The old verdict used to score the new round, and the new
// round's judge never started.
test("a Sketch & Guess judge in flight across a delete and re-create neither scores nor holds up the new room's round", async () => {
  const PIC = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  const asked = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => new Promise((resolve) => { asked.push({ resolve, guesses: JSON.parse(JSON.parse(init.body).messages[0].content).guesses }); });
  // a verdict for every guess the call was sent (by the ids it carries)
  const answer = (call, right) => call.resolve({ ok: true, json: async () => ({ stop_reason: "end_turn", model: "stub", content: [{ type: "text", text: JSON.stringify({ verdicts: call.guesses.map((x) => ({ name: x.name, right })), roast: "" }) }] }) });
  try {
    const h = makeRoom({ env: { ANTHROPIC_API_KEY: "stub" } });
    const players = ["Ann", "Bob", "Cy"];
    /** a match up to its last guess, which starts the judge: answers the move in flight */
    const play = async () => {
      for (const n of players) h.member(n);
      const id = (await h.room.createGame("Ann", players, { game: "sketch", guess_seconds: 60 }, R)).game.id;
      await h.room.gameAccept(id, "Bob", R);
      await h.room.gameAccept(id, "Cy", R);
      const artist = h.room.gameRow(id).st.artist;
      assert.equal((await h.room.gameMove(id, artist, null, R, { image: PIC })).status, 200);
      const [g1, g2] = players.filter((n) => n !== artist);
      await h.room.gameMove(id, g1, null, R, { guess: "a close call from " + g1 });
      const last = h.room.gameMove(id, g2, null, R, { guess: "a close call from " + g2 });
      return { id, g1, g2, last };
    };
    const old = await play();
    await tick();
    assert.equal(asked.length, 1, "the old round's judge is asking");
    await h.room.revokeAll();
    await h.room.destroy(R);
    h.room.create();
    const neu = await play();
    assert.equal(neu.id, old.id, "the new match has the old one's id");
    await tick();
    assert.equal(asked.length, 2, "the new round's judge starts");
    answer(asked[0], true);
    await assert.rejects(old.last, (e) => isGoneError(e), "the old move stops");
    assert.equal(h.room.gameRow(neu.id).st.phase, "judging", "the old verdict did not score the new round");
    answer(asked[1], false);
    const r = await neu.last;
    assert.equal(r.status, 200);
    const round = h.room.gameRow(neu.id).st.rounds[0];
    assert.ok(round && Object.values(round.guesses).every((x) => !x.right), "the new round is scored by its own judge");
  } finally {
    globalThis.fetch = realFetch;
  }
});
