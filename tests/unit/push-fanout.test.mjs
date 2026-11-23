// A post's Web Push fan-out (worker/room/push.ts notifyPush,
// platform/webpush.ts), on the real Room class (room-harness.mjs). The
// push services are a stand-in fetch and the __vapid object a stand-in
// signer: nothing leaves the machine.
import test from "node:test";
import assert from "node:assert/strict";
import { makeRoom } from "./room-harness.mjs";

const R = "unit";
const tick = () => new Promise((r) => setImmediate(r));

/** a browser subscription's keys: a real P-256 public key (the payload is really encrypted) */
async function subKeys() {
  const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  return { p256dh: Buffer.from(raw).toString("base64url"), auth: Buffer.alloc(16, 9).toString("base64url") };
}

/** a room whose __vapid stand-in counts the headers it signs */
function pushRoom() {
  const signed = [];
  const ROOM = { idFromName: (n) => n, get: () => ({ vapidAuth: async (aud) => { signed.push(aud); return "vapid t=h.c.s, k=K"; } }) };
  const h = makeRoom({ env: { ROOM } });
  h.signed = signed;
  return h;
}

/**
 * Replaces fetch for one test. Every send is recorded; while held, a send
 * waits until release(), after that it answers at once.
 * @param status what the push service answers
 */
function pushServices(t, status = 201) {
  const real = globalThis.fetch;
  t.after(() => { globalThis.fetch = real; });
  const s = { sent: [], held: [], holding: true, inFlight: 0, maxInFlight: 0 };
  globalThis.fetch = async (url, init) => {
    s.sent.push({ url: String(url), init });
    s.inFlight++;
    s.maxInFlight = Math.max(s.maxInFlight, s.inFlight);
    if (s.holding) await new Promise((r) => s.held.push(r));
    s.inFlight--;
    return new Response(null, { status: typeof status === "function" ? status(String(url)) : status });
  };
  s.release = () => { s.holding = false; for (const r of s.held.splice(0)) r(); };
  s.waitFor = async (n) => { for (let i = 0; i < 2000 && s.sent.length < n; i++) await tick(); assert.ok(s.sent.length >= n, "expected " + n + " sends in flight, saw " + s.sent.length); };
  return s;
}

async function subscribe(h, name, endpoint, mode = "all") {
  const k = await subKeys();
  assert.equal(h.room.pushSubscribe("tok-" + name, false, { endpoint, ...k }, mode).status, 200);
}

const EP = (who, i) => "https://fcm.googleapis.com/fcm/send/" + who + "-" + i;

test("a member removed while a fan-out runs gets nothing more from it", async (t) => {
  const h = pushRoom();
  h.member("Ada"); h.member("Bob"); h.member("Cy");
  // Cy's six registrations come first and keep every send slot busy, so
  // Bob's is still waiting when he is removed.
  for (let i = 0; i < 6; i++) await subscribe(h, "Cy", EP("cy", i));
  await subscribe(h, "Bob", EP("bob", 0));
  const net = pushServices(t);
  await h.room.post("Ada", "the plan, before Bob leaves", R, false);
  await net.waitFor(1);
  assert.equal(h.room.revoke("tok-Bob"), true);
  net.release();
  await h.settled();
  assert.equal(net.sent.filter((x) => x.url.includes("/bob-")).length, 0, "no push went to Bob after his revoke");
  assert.equal(net.sent.filter((x) => x.url.includes("/cy-")).length, 6, "Cy still got hers");
});

test("a message deleted while its fan-out runs is not pushed to the members still waiting", async (t) => {
  const h = pushRoom();
  h.member("Ada"); h.member("Bob");
  for (let i = 0; i < 8; i++) await subscribe(h, "Bob", EP("bob", i));
  const net = pushServices(t);
  const msg = await h.room.post("Ada", "a pasted password", R, false);
  await net.waitFor(1);
  const before = net.sent.length;
  assert.equal((await h.room.deleteMessage(msg.id, "Ada", false)).status, 200);
  net.release();
  await h.settled();
  assert.equal(net.sent.length, before, "no send started after the delete");
  assert.ok(before < 8);
});
