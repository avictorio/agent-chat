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

test("a fan-out sends several at a time, each with a timeout, and signs once per push service", async (t) => {
  const h = pushRoom();
  h.member("Ada"); h.member("Bob"); h.member("Cy");
  // an origin no other test uses: the signed header is kept per origin for the whole process
  const ep = (who, i) => "https://wns2-unit.notify.windows.com/w/?token=" + who + i;
  for (let i = 0; i < 7; i++) await subscribe(h, "Bob", ep("bob", i));
  for (let i = 0; i < 5; i++) await subscribe(h, "Cy", ep("cy", i));
  const net = pushServices(t, (url) => { if (url.endsWith("bob0")) throw new TypeError("network down"); return 201; });
  t.mock.method(console, "warn", () => {});
  await h.room.post("Ada", "hello all", R, false);
  await net.waitFor(6);
  assert.equal(net.maxInFlight, 6, "six sends in flight at once, not one after another");
  net.release();
  await h.settled();
  assert.equal(net.sent.length, 12, "every subscription got its push, after one failed");
  for (const x of net.sent) {
    assert.ok(x.init.signal instanceof AbortSignal, "every send can be given up");
    assert.equal(x.init.redirect, "manual");
  }
  assert.equal(h.signed.filter((a) => a === "https://wns2-unit.notify.windows.com").length, 1, "one VAPID signing for twelve sends");
  await h.room.post("Ada", "and again", R, false);
  await h.settled();
  assert.equal(h.signed.filter((a) => a === "https://wns2-unit.notify.windows.com").length, 1, "the next post reuses it");
});

test("a subscription whose every send fails for a day is dropped; one that comes back is kept", async (t) => {
  const h = pushRoom();
  h.member("Ada"); h.member("Bob");
  const dead = "https://fcm.googleapis.com/fcm/send/junk-1", flaky = "https://fcm.googleapis.com/fcm/send/flaky-1";
  await subscribe(h, "Bob", dead);
  await subscribe(h, "Bob", flaky);
  let flakyUp = false;
  const net = pushServices(t, (url) => (url === dead || !flakyUp ? 500 : 201));
  net.release();
  t.mock.method(console, "warn", () => {});
  const row = (ep) => h.one("SELECT fails, fail_ts FROM push WHERE endpoint = ?", ep);
  for (let i = 0; i < 5; i++) { await h.room.post("Ada", "post " + i, R, false); await h.settled(); }
  assert.equal(row(dead).fails, 5, "five failures in a row are counted");
  assert.ok(row(flaky), "but five failures within the hour (a push service's outage) drop nothing");
  // the first failure was more than a day ago
  h.db.prepare("UPDATE push SET fail_ts = ?").run(Date.now() - 86400000 - 1000);
  flakyUp = true;
  await h.room.post("Ada", "a day later", R, false);
  await h.settled();
  assert.equal(row(dead), undefined, "the one still failing is gone");
  assert.deepEqual({ ...row(flaky) }, { fails: null, fail_ts: null }, "the one that answered again starts over");
});

test("the schema step drops the oversized subscriptions older rooms kept", () => {
  const h = pushRoom();
  h.member("Bob");
  const ins = h.db.prepare("INSERT INTO push (member, endpoint, p256dh, auth, ts, mode) VALUES ('bob', ?, ?, ?, 1, 'all')");
  ins.run("https://fcm.googleapis.com/fcm/send/fine", "p".repeat(87), "a".repeat(22));
  ins.run("https://fcm.googleapis.com/fcm/send/" + "A".repeat(2_000_000), "p".repeat(87), "a".repeat(22));
  ins.run("https://fcm.googleapis.com/fcm/send/big-auth", "p".repeat(87), "a".repeat(300_000));
  h.db.prepare("UPDATE cfg SET v = '3' WHERE k = 'schema_version'").run();
  h.room.ensureSchema();
  assert.deepEqual(h.all("SELECT endpoint FROM push").map((r) => r.endpoint), ["https://fcm.googleapis.com/fcm/send/fine"]);
});
