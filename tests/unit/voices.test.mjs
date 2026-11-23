// The voice route (worker/routes/voices.ts) on the real Room class
// (room-harness.mjs), with Cartesia stood in for by a stub of fetch: a
// removed voice is forgotten only once Cartesia has deleted it, and the
// daily clone allowance is taken in one call before the sample is read.
import test from "node:test";
import assert from "node:assert/strict";
import { makeRoom } from "./room-harness.mjs";
import { voiceRoute } from "../../worker/routes/voices.ts";
import { VOICE_CLONES_PER_DAY } from "../../worker/limits.ts";
import { isGoneError } from "../../worker/lib/errors.ts";

const ROUTE = /^\/api\/rooms\/([^/]+)\/(?:voice(?:\/(sample|reclone))?|members\/([^/]+)\/voice(?:\/(sample|reclone))?)\/?$/;
const MP3 = new Uint8Array([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0, 1, 2, 3, 4]).buffer;

/** Cartesia as a stub: answer(req) gives each call's Response; calls lists them */
function cartesia(answer) {
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (!u.startsWith("https://api.cartesia.ai/")) throw new Error("unexpected fetch " + u);
    const c = { method: (init && init.method) || "GET", url: u };
    calls.push(c);
    return answer(c);
  };
  return { calls, restore: () => { globalThis.fetch = real; } };
}

/** a room where Ada has a stored sample and the clone v-old */
async function withVoice(hooks) {
  const h = makeRoom(hooks);
  h.member("Ada");
  assert.ok(await h.room.putVoiceSample("Ada", MP3, "audio/mpeg", "unit"));
  await h.room.setVoiceId("Ada", "cartesia", "v-old", h.room.gen);
  return h;
}

/** the route's answer to method on /api/rooms/unit/<rest> as Ada */
async function call(h, method, rest, body) {
  const url = new URL("http://localhost/api/rooms/unit/" + rest);
  // a KV with KV's delay, for code that counts there (the clone cap did)
  const kv = h.kv || (h.kv = new Map());
  const REQUESTS = { get: async (k) => { await new Promise((r) => setTimeout(r, 1)); return kv.get(k) ?? null; }, put: async (k, v) => { await new Promise((r) => setTimeout(r, 1)); kv.set(k, v); } };
  const env = { ROOM: { idFromName: (n) => n, get: () => h.room }, REQUESTS, CARTESIA_API_KEY: "test-key" };
  const request = new Request(url, body ? { method, body, headers: { "Content-Type": "audio/mpeg" } } : { method });
  const r = await voiceRoute({ request, env, url, path: url.pathname, owner: false, invite: "tok-Ada" }, ROUTE.exec(url.pathname));
  return { status: r.status, json: await r.json() };
}

const mv = (h) => { const r = h.one("SELECT voice_id, sample_key FROM mv WHERE name = 'ada'"); return r && { ...r }; };

test("a voice Cartesia did not delete stays recorded, and the DELETE answers 502", async () => {
  const h = await withVoice();
  const key = mv(h).sample_key;
  let status = 500;
  const c = cartesia(() => new Response("{}", { status }));
  try {
    for (const s of [500, 429]) {
      status = s;
      const r = await call(h, "DELETE", "voice");
      assert.equal(r.status, 502, "Cartesia " + s + ": " + JSON.stringify(r.json));
      assert.deepEqual(mv(h), { voice_id: "v-old", sample_key: key }, "the row keeps the clone's id");
      assert.ok(h.objects.has(key), "the sample stays");
    }
    assert.deepEqual(c.calls.map((x) => x.method + " " + x.url), ["DELETE https://api.cartesia.ai/voices/v-old", "DELETE https://api.cartesia.ai/voices/v-old"]);
    // a 404 means Cartesia no longer has it: the room forgets it now
    status = 404;
    const r = await call(h, "DELETE", "voice");
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.voice, null);
    assert.equal(mv(h), undefined);
    assert.ok(!h.objects.has(key), "the sample went with it");
  } finally { c.restore(); }
});

test("a sample storage would not delete keeps its row, and a second DELETE finishes", async () => {
  let failDelete = true;
  const h = await withVoice({ before: (op, key) => { if (op === "delete" && failDelete && key.includes("/voice-sample/")) throw new Error("R2 down"); } });
  const key = mv(h).sample_key;
  const c = cartesia(() => new Response(null, { status: 200 }));
  try {
    let r = await call(h, "DELETE", "voice");
    assert.equal(r.status, 503, JSON.stringify(r.json));
    assert.deepEqual(mv(h), { voice_id: null, sample_key: key }, "the clone is gone, the sample's pointer stays");
    failDelete = false;
    r = await call(h, "DELETE", "voice");
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(mv(h), undefined);
    assert.ok(!h.objects.has(key));
    assert.equal(c.calls.length, 1, "Cartesia is asked once: the second DELETE has no clone to delete");
  } finally { c.restore(); }
});

test("reclones sent together take the daily allowance once each, and a refused one reads no sample", async () => {
  let reads = 0;
  const h = await withVoice({ before: (op, key) => { if (op === "get" && key.includes("/voice-sample/")) reads++; } });
  let n = 0;
  const c = cartesia((x) => x.url.endsWith("/voices/clone") ? Response.json({ id: "v" + (++n) }) : new Response(null, { status: 200 }));
  try {
    const all = await Promise.all(Array.from({ length: VOICE_CLONES_PER_DAY * 3 }, () => call(h, "POST", "voice/reclone")));
    const ok = all.filter((r) => r.status === 200).length;
    assert.equal(ok, VOICE_CLONES_PER_DAY, all.map((r) => r.status).join(","));
    assert.equal(all.filter((r) => r.status === 429).length, VOICE_CLONES_PER_DAY * 2);
    assert.equal(c.calls.filter((x) => x.url.endsWith("/voices/clone")).length, VOICE_CLONES_PER_DAY, "one clone per allowance");
    assert.equal(reads, VOICE_CLONES_PER_DAY, "only the allowed reclones read the sample");
    const r = await call(h, "POST", "voice/reclone");
    assert.equal(r.status, 429);
    assert.equal(reads, VOICE_CLONES_PER_DAY, "a member at the cap costs no read");
  } finally { c.restore(); }
});

// The route clones in the Worker, seconds after the room stored or read
// the sample. A room deleted, created again and the name invited in that
// wait used to give the new room's member the old room's clone.
for (const [what, method, rest] of [["a sample upload", "PUT", "voice/sample"], ["a reclone", "POST", "voice/reclone"]]) {
  test(what + " whose room is deleted and created again while it clones answers 410 and deletes its clone", async () => {
    const h = await withVoice();
    let cloned, release;
    const reached = new Promise((r) => { cloned = r; });
    const gate = new Promise((r) => { release = r; });
    const c = cartesia(async (x) => {
      if (x.url.endsWith("/voices/clone")) { cloned(); await gate; return Response.json({ id: "v-stale" }); }
      return new Response(null, { status: 200 });
    });
    try {
      const r = call(h, method, rest, method === "PUT" ? MP3 : undefined);
      await reached;
      await h.room.revokeAll();
      assert.deepEqual(await h.room.destroy("unit"), { deleted: true });
      assert.equal(h.room.create(), true);
      h.member("Ada");
      release();
      await assert.rejects(r, (e) => isGoneError(e), "410 room_deleted");
      assert.equal(mv(h), undefined, "the new room's Ada has no voice");
      assert.ok(c.calls.some((x) => x.method === "DELETE" && x.url.endsWith("/voices/v-stale")), "the clone it made is deleted at Cartesia");
    } finally { c.restore(); }
  });
}
