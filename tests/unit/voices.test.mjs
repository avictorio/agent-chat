// The voice route (worker/routes/voices.ts) on the real Room class
// (room-harness.mjs), with Cartesia stood in for by a stub of fetch: a
// removed voice goes from the room at once and its clone is kept as a
// pending delete until Cartesia confirms it, and the daily clone
// allowance is taken in one call before the sample is read.
import test from "node:test";
import assert from "node:assert/strict";
import { makeRoom } from "./room-harness.mjs";
import { voiceRoute } from "../../worker/routes/voices.ts";
import { roomRoute } from "../../worker/routes/rooms.ts";
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

/** the route's answer to method on /api/rooms/unit/<rest> as Ada (opts.key false: no CARTESIA_API_KEY) */
async function call(h, method, rest, body, opts = {}) {
  const url = new URL("http://localhost/api/rooms/unit/" + rest);
  // a KV with KV's delay, for code that counts there (the clone cap did)
  const kv = h.kv || (h.kv = new Map());
  const REQUESTS = { get: async (k) => { await new Promise((r) => setTimeout(r, 1)); return kv.get(k) ?? null; }, put: async (k, v) => { await new Promise((r) => setTimeout(r, 1)); kv.set(k, v); } };
  const env = { ROOM: { idFromName: (n) => n, get: () => h.room }, REQUESTS, ...(opts.key === false ? {} : { CARTESIA_API_KEY: "test-key" }) };
  const request = new Request(url, body ? { method, body, headers: { "Content-Type": "audio/mpeg" } } : { method });
  const later = h.later || (h.later = []);
  const ctx = { waitUntil: (p) => { later.push(p); } };
  const r = await voiceRoute({ request, env, url, path: url.pathname, owner: false, invite: "tok-Ada", ctx }, ROUTE.exec(url.pathname));
  await Promise.all(later.splice(0));
  return { status: r.status, json: await r.json() };
}

/** the clone ids the room holds as pending deletes */
const pending = (h) => h.all("SELECT k FROM cfg WHERE k LIKE 'voice-del:%' ORDER BY k").map((r) => r.k.slice(10));

const mv = (h) => { const r = h.one("SELECT voice_id, sample_key FROM mv WHERE name = 'ada'"); return r && { ...r }; };

// Withdrawing a voice never waits on Cartesia: the sample goes and the
// room stops using the voice at once, and a clone Cartesia does not
// confirm deleted is kept as a pending delete, tried again by the room's
// next voice call. The wave before answered 502 and removed nothing, so a
// member could not withdraw their recording while Cartesia was down, and
// with the key unset never; before that the 200 lost the clone's id.
for (const [what, answer] of [["answers 500", () => new Response("{}", { status: 500 })], ["answers 429", () => new Response("{}", { status: 429 })], ["cannot be reached", () => { throw new TypeError("fetch failed"); }]]) {
  test("DELETE /voice while Cartesia " + what + " removes the voice, keeps the clone as a pending delete, and the next voice call deletes it", async () => {
    const h = await withVoice();
    const key = mv(h).sample_key;
    let up = false;
    let n = 0;
    const c = cartesia((x) => x.url.endsWith("/voices/clone") ? Response.json({ id: "v-new" + (++n) }) : up ? new Response(null, { status: 200 }) : answer());
    try {
      const r = await call(h, "DELETE", "voice");
      assert.equal(r.status, 200, JSON.stringify(r.json));
      assert.equal(r.json.voice, null);
      assert.equal(r.json.clone_delete_pending, true);
      assert.equal(mv(h), undefined, "the room no longer uses the voice");
      assert.ok(!h.objects.has(key), "the sample is gone");
      assert.deepEqual(pending(h), ["v-old"]);
      up = true;
      const s = await call(h, "PUT", "voice/sample", MP3);
      assert.equal(s.status, 200, JSON.stringify(s.json));
      assert.deepEqual(pending(h), [], "deleted at Cartesia, off the list");
      assert.ok(c.calls.filter((x) => x.method === "DELETE" && x.url.endsWith("/voices/v-old")).length === 2);
    } finally { c.restore(); }
  });
}

test("DELETE /voice with the key unset removes the voice and keeps the clone, deleted once the key is back", async () => {
  const h = await withVoice();
  const key = mv(h).sample_key;
  const c = cartesia(() => new Response(null, { status: 200 }));
  try {
    const r = await call(h, "DELETE", "voice", undefined, { key: false });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.clone_delete_pending, true);
    assert.equal(mv(h), undefined);
    assert.ok(!h.objects.has(key));
    assert.deepEqual(pending(h), ["v-old"]);
    assert.equal(c.calls.length, 0, "nothing is sent without the key");
    // a voice call with the key set: the reclone has no sample (404), the pending delete still goes
    const s = await call(h, "POST", "voice/reclone");
    assert.equal(s.status, 404);
    assert.deepEqual(pending(h), []);
    assert.deepEqual(c.calls.map((x) => x.method + " " + x.url), ["DELETE https://api.cartesia.ai/voices/v-old"]);
  } finally { c.restore(); }
});

test("DELETE /voice that Cartesia answers 404 records nothing pending", async () => {
  const h = await withVoice();
  const c = cartesia(() => new Response(null, { status: 404 }));
  try {
    const r = await call(h, "DELETE", "voice");
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.clone_delete_pending, false);
    assert.equal(mv(h), undefined);
    assert.deepEqual(pending(h), []);
  } finally { c.restore(); }
});

test("a clone replaced while Cartesia will not delete the old one is kept as a pending delete", async () => {
  const h = await withVoice();
  const c = cartesia((x) => x.url.endsWith("/voices/clone") ? Response.json({ id: "v-new" }) : new Response("{}", { status: 503 }));
  try {
    const r = await call(h, "POST", "voice/reclone");
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(mv(h).voice_id, "v-new");
    assert.deepEqual(pending(h), ["v-old"]);
  } finally { c.restore(); }
});

test("pending deletes are tried a few at a time, and only a 2xx or 404 takes one off", async () => {
  const h = await withVoice();
  h.room.voiceDelPend(["p1", "p2", "p3", "p4", "p5"]);
  const c = cartesia((x) => x.url.endsWith("/voices/p2") ? new Response(null, { status: 500 }) : x.url.endsWith("/voices/p3") ? new Response(null, { status: 404 }) : new Response(null, { status: 200 }));
  try {
    await call(h, "POST", "voice/reclone", undefined);
    const tried = c.calls.filter((x) => /\/voices\/p\d$/.test(x.url)).map((x) => x.url.slice(-2));
    assert.deepEqual(tried, ["p1", "p2", "p3"], "CLONE_DELETE_RETRY of them, oldest first");
    assert.deepEqual(pending(h), ["p2", "p4", "p5"]);
  } finally { c.restore(); }
});

test("a room delete tries the pending deletes, and keeps the ids Cartesia still refuses", async () => {
  const h = await withVoice();
  h.room.voiceDelPend(["p1", "p2"]);
  await h.room.revokeAll();
  const c = cartesia((x) => x.url.endsWith("/voices/p2") ? new Response(null, { status: 500 }) : new Response(null, { status: 200 }));
  try {
    const url = new URL("http://localhost/api/rooms/unit?confirm=unit");
    const later = [];
    const env = { ROOM: { idFromName: (n) => n, get: () => h.room }, CARTESIA_API_KEY: "test-key" };
    const r = await roomRoute({ request: new Request(url, { method: "DELETE" }), env, url, path: url.pathname, owner: true, invite: "", ctx: { waitUntil: (p) => { later.push(p); } } }, ["/api/rooms/unit", "unit"]);
    await Promise.all(later);
    assert.equal(r.status, 200, await r.clone().text());
    assert.equal(h.room.exists(), false);
    assert.deepEqual(c.calls.filter((x) => x.method === "DELETE").map((x) => x.url.slice(-2)).sort(), ["p1", "p2"]);
    assert.deepEqual(pending(h), ["p2"], "the refused one outlives the room");
    // and a room created again under the name tries it on its next voice call
    h.room.create();
    h.member("Ada");
    c.restore();
    const c2 = cartesia(() => new Response(null, { status: 200 }));
    try {
      await call(h, "POST", "voice/reclone");
      assert.deepEqual(pending(h), []);
    } finally { c2.restore(); }
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
