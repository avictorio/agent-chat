// Direct uploads hand out addresses on the storage service itself. These
// tests hold what keeps such an address safe: what it is signed with (a
// credential for one action on one object), and the check that keeps
// direct uploads off unless the live bucket is seen to enforce that scope
// against everything the holder of an address could try.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { r2Address, r2PartAddresses, r2PartCredential, sigv4Presign } from "../../worker/platform/r2-s3.ts";
import { CHECK_PREFIX, CHECK_VERSION, directUploadsProven, directVerdict, forgetDirectVerdict, r2DirectCheck, renewDirectVerdict } from "../../worker/platform/r2-direct-check.ts";
import { UploadMethods } from "../../worker/room/uploads.ts";
import { uploadStep } from "../../worker/routes/uploads.ts";
import { MIB, ROOM_RE, UP_PART_MAX } from "../../worker/limits.ts";
import { resetWarnings } from "../../worker/lib/log.ts";

const CRED = { R2_ACCESS_KEY_ID: "0123456789abcdef0123456789abcdef", R2_SECRET_ACCESS_KEY: "f".repeat(64), R2_ACCOUNT_ID: "acct123", R2_BUCKET: "my-bucket" };
const KEY = "some-room/12/file";
const NOW = new Date("2026-11-22T20:00:00Z");
const b64url = (b) => Buffer.from(b).toString("base64url");
/** The claims of the JWT a session token carries. */
const claimsOf = (token) => JSON.parse(Buffer.from(Buffer.from(token, "base64").toString().slice(4).split(".")[1], "base64url"));

test("a part credential allows one action on one object, and is derived the way R2 documents", async () => {
  const cred = await r2PartCredential(CRED, KEY, 3600, NOW);
  const jwt = Buffer.from(cred.token, "base64").toString();
  assert.ok(jwt.startsWith("jwt/"), "the session token is base64 of jwt/<the JWT>");
  const [head, claims, sig] = jwt.slice(4).split(".");
  assert.deepEqual(JSON.parse(Buffer.from(head, "base64url")), { alg: "HS256", typ: "JWT" });
  assert.deepEqual(JSON.parse(Buffer.from(claims, "base64url")), {
    bucket: "my-bucket", actions: ["UploadPart"], paths: { prefixPaths: [], objectPaths: [KEY] },
    sub: "acct123", iss: CRED.R2_ACCESS_KEY_ID, aud: "acct123.r2.cloudflarestorage.com", iat: 1795377600, exp: 1795381200,
  });
  assert.equal(sig, b64url(createHmac("sha256", CRED.R2_SECRET_ACCESS_KEY).update(head + "." + claims).digest()), "signed with the API credential's secret (HS256)");
  assert.equal(cred.secretKey, createHash("sha256").update(jwt.slice(4)).digest("hex"), "the temporary secret is the SHA-256 of the JWT");
  assert.equal(cred.accessKey, CRED.R2_ACCESS_KEY_ID);
  assert.notEqual(cred.secretKey, CRED.R2_SECRET_ACCESS_KEY);
});

test("every part address is signed with the upload's own credential, never the API credential", async () => {
  const urls = await r2PartAddresses(CRED, KEY, "UPLOADID+/=", [{ n: 7, bytes: 8388608 }, { n: 8, bytes: 8388608 }, { n: 9, bytes: 5 }], 3600, NOW);
  assert.deepEqual(Object.keys(urls), ["7", "8", "9"]);
  const cred = await r2PartCredential(CRED, KEY, 3600, NOW);
  for (const n of [7, 8, 9]) {
    const url = new URL(urls[n]);
    const q = url.searchParams;
    assert.equal(url.host + url.pathname, "acct123.r2.cloudflarestorage.com/my-bucket/some-room/12/file");
    assert.equal(q.get("X-Amz-Security-Token"), cred.token, "part " + n + " carries the upload's credential");
    const claims = claimsOf(q.get("X-Amz-Security-Token"));
    assert.deepEqual(claims.actions, ["UploadPart"]);
    assert.deepEqual(claims.paths, { prefixPaths: [], objectPaths: [KEY] });
    assert.equal(claims.exp - claims.iat, 3600);
    assert.equal(q.get("X-Amz-SignedHeaders"), "content-length;host");
    assert.equal(q.get("partNumber"), String(n));
    assert.equal(q.get("uploadId"), "UPLOADID+/=");
    assert.equal(q.get("X-Amz-Expires"), "3600");
  }
  // Part 7's signature, worked out here from the SigV4 definition...
  const q = new URL(urls[7]).searchParams;
  const enc = (v) => encodeURIComponent(v).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
  const qs = [...q.entries()].filter((e) => e[0] !== "X-Amz-Signature").map((e) => [enc(e[0]), enc(e[1])]).sort((x, y) => (x[0] < y[0] ? -1 : 1)).map((e) => e.join("=")).join("&");
  const canonical = "PUT\n/my-bucket/some-room/12/file\n" + qs + "\ncontent-length:8388608\nhost:acct123.r2.cloudflarestorage.com\n\ncontent-length;host\nUNSIGNED-PAYLOAD";
  const toSign = "AWS4-HMAC-SHA256\n20261122T200000Z\n20261122/auto/s3/aws4_request\n" + createHash("sha256").update(canonical).digest("hex");
  const hm = (k, s) => createHmac("sha256", k).update(s).digest();
  const k = hm(hm(hm(hm("AWS4" + cred.secretKey, "20261122"), "auto"), "s3"), "aws4_request");
  assert.equal(q.get("X-Amz-Signature"), hm(k, toSign).toString("hex"));
  // ...and pinned: the value aws4fetch (the signer Cloudflare's docs use) gave for this request when the code was written.
  assert.equal(q.get("X-Amz-Signature"), "64fd877dc5fc8a6212a172e900c80a8bf1045e8fee64d7a66e4c23ac2830f962");
});

test("an address with no extra headers still signs as AWS's published example does", async () => {
  const url = await sigv4Presign({ method: "GET", host: "examplebucket.s3.amazonaws.com", path: "/test.txt", query: {}, accessKey: "AKIAIOSFODNN7EXAMPLE", secretKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", region: "us-east-1", expires: 86400, date: new Date("2013-05-24T00:00:00Z") });
  assert.match(url, /X-Amz-SignedHeaders=host&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404$/);
  assert.ok(!url.includes("X-Amz-Security-Token"));
});

test("the check's objects cannot be a room's", () => {
  assert.equal(ROOM_RE.test(CHECK_PREFIX.split("/")[0]), false);
});

test("r2Address encodes each segment of the key", () => {
  assert.deepEqual(r2Address(CRED, "a room/1/fi le"), { host: "acct123.r2.cloudflarestorage.com", path: "/my-bucket/a%20room/1/fi%20le" });
});

// A stand-in for the bucket: the binding's side (put, delete, list,
// multipart create and abort) and the S3 side the check reaches with
// fetch. `storage` says how the S3 side behaves:
//   scoped          enforces a part credential's scope (UploadPart, one object)
//   unsignedHeaders "honour" (acts on an x-amz header nobody signed),
//                   "refuse" (403, as AWS S3 does) or "ignore"
//   accepts         takes requests made with a part credential at all
//   copies          can copy at all (false: every copy answers 400)
//   scopedCopy, scopedRead  a status other than 403 for a copy or a read
//                   made with a part credential (a refusal for another reason)
//   quietCopy       copies without saying so in its answer
//   fails           tries answered 503, by part number (or "read")
//   down            the binding itself throws
const SOUND = { scoped: true, unsignedHeaders: "honour", accepts: true, copies: true };
const LAX = { scoped: false, unsignedHeaders: "honour", accepts: true, copies: true };
function bucket(storage) {
  const objects = new Map();
  const uploads = new Map();
  const kv = new Map();
  const calls = { fetch: 0, kvGet: 0, kvPut: [], checks: 0 };
  const env = Object.assign({}, CRED, {
    MEDIA: {
      async put(key, bytes) { if (storage.down) throw new Error("storage is down"); objects.set(key, { bytes, uploaded: new Date(Date.now()) }); },
      async delete(keys) { for (const k of [].concat(keys)) objects.delete(k); },
      async list(o) { return { objects: [...objects.entries()].filter(([k]) => k.startsWith(o.prefix)).map(([key, v]) => ({ key, uploaded: v.uploaded })), truncated: false, delimitedPrefixes: [] }; },
      async createMultipartUpload(key) {
        calls.checks++;
        const uploadId = "up" + (uploads.size + 1);
        uploads.set(uploadId, { key, parts: new Map(), aborted: false });
        return { uploadId, async abort() { uploads.get(uploadId).aborted = true; } };
      },
    },
    REQUESTS: {
      async get(key) { calls.kvGet++; return kv.has(key) ? kv.get(key) : null; },
      async put(key, value, options) { calls.kvPut.push({ key, value: JSON.parse(value), ttl: options.expirationTtl }); kv.set(key, value); },
    },
  });
  const s3 = async (input, init = {}) => {
    calls.fetch++;
    const url = new URL(input);
    const q = url.searchParams;
    const refuse = (status, code) => new Response("<Error><Code>" + code + "</Code><Message>secret-looking detail</Message></Error>", { status });
    const scopedCred = !!q.get("X-Amz-Security-Token");
    const fails = storage.fails || [];
    const up = uploads.get(q.get("uploadId"));
    if ((init.method || "GET") === "GET") {
      if (up) {
        const rows = [...up.parts.entries()].map(([n, p]) => "<Part><PartNumber>" + n + "</PartNumber><ETag>&quot;e" + n + "&quot;</ETag><Size>" + p.size + "</Size></Part>").join("");
        return new Response("<ListPartsResult>" + rows + "<IsTruncated>false</IsTruncated></ListPartsResult>", { status: 200 });
      }
      if (fails.includes("read")) return refuse(503, "ServiceUnavailable");
      if (scopedCred && storage.scopedRead) return refuse(storage.scopedRead, "NoSuchKey");
      if (scopedCred && storage.scoped) return refuse(403, "AccessDenied");
      return new Response("the other object", { status: 200 });
    }
    const n = Number(q.get("partNumber"));
    if (fails.includes(n)) return refuse(503, "ServiceUnavailable");
    if (scopedCred && !storage.accepts) return refuse(403, "InvalidArgument");
    const signed = q.get("X-Amz-SignedHeaders").split(";");
    let from = init.headers && init.headers["x-amz-copy-source"];
    if (from && !signed.includes("x-amz-copy-source")) {
      if (storage.unsignedHeaders === "refuse") return refuse(403, "AccessDenied");
      if (storage.unsignedHeaders === "ignore") from = null;
    }
    if (from) {
      if (scopedCred && storage.scopedCopy) return refuse(storage.scopedCopy, "InvalidRequest");
      if (scopedCred && storage.scoped) return refuse(403, "AccessDenied");
      if (!storage.copies) return refuse(400, "InvalidRequest");
      const source = objects.get(from.replace("/" + CRED.R2_BUCKET + "/", ""));
      up.parts.set(n, { size: source.bytes.length });
      return new Response(storage.quietCopy ? "" : "<CopyPartResult><ETag>&quot;c&quot;</ETag></CopyPartResult>", { status: 200 });
    }
    up.parts.set(n, { size: init.body ? init.body.length : 0 });
    return new Response("", { status: 200, headers: { ETag: "\"e" + n + "\"" } });
  };
  return { env, objects, uploads, kv, calls, s3, storage };
}
/** Runs fn with the check's fetch going to a stand-in bucket, and its log lines collected. */
async function withBucket(storage, fn) {
  const b = bucket(Object.assign({}, storage));
  const real = { fetch: globalThis.fetch, warn: console.warn, log: console.log, now: Date.now };
  const logged = [];
  globalThis.fetch = b.s3;
  console.warn = (line) => logged.push(JSON.parse(line));
  console.log = (line) => logged.push(JSON.parse(line));
  resetWarnings();
  forgetDirectVerdict();
  try { return await fn(b, logged); } finally { globalThis.fetch = real.fetch; console.warn = real.warn; console.log = real.log; Date.now = real.now; forgetDirectVerdict(); }
}

test("the check passes when storage enforces the credential's scope, and leaves nothing behind", async () => {
  await withBucket(SOUND, async (b, logged) => {
    const v = await r2DirectCheck(b.env);
    assert.equal(v.ok, true, JSON.stringify(v));
    assert.equal(v.v, CHECK_VERSION);
    assert.deepEqual(v.tries, { part: "200", header: "403 AccessDenied", copy: "403 AccessDenied", read: "403 AccessDenied", control: "200 copied" });
    assert.equal(v.error, undefined);
    assert.equal(b.objects.size, 0, "its own object is deleted");
    assert.deepEqual([...b.uploads.values()].map((u) => u.aborted), [true], "its upload is aborted");
    assert.ok([...b.uploads.values()].every((u) => u.key.startsWith(CHECK_PREFIX)));
    const line = logged.find((l) => l.note === "r2direct.check");
    assert.ok(line && line.ok === true && line.copy === "403 AccessDenied" && line.control === "200 copied", "the log says what storage answered");
    assert.ok(!JSON.stringify(logged).includes("secret-looking detail"), "an error's message never reaches the log, only its code");
  });
});

test("the check passes on storage that refuses or ignores headers nobody signed", async () => {
  for (const unsignedHeaders of ["refuse", "ignore"]) {
    await withBucket(Object.assign({}, SOUND, { unsignedHeaders }), async (b) => {
      const v = await r2DirectCheck(b.env);
      assert.equal(v.ok, true, JSON.stringify(v));
      assert.equal(v.tries.header, unsignedHeaders === "refuse" ? "403 AccessDenied" : "200");
    });
  }
});

test("the check fails when the scope is not enforced, even on storage that refuses unsigned headers", async () => {
  // The holder of an address can sign the copy source themselves, so
  // storage refusing an unsigned one protects nothing by itself.
  for (const unsignedHeaders of ["honour", "refuse", "ignore"]) {
    await withBucket(Object.assign({}, LAX, { unsignedHeaders }), async (b, logged) => {
      const v = await r2DirectCheck(b.env);
      assert.equal(v.ok, false, unsignedHeaders);
      assert.equal(v.tries.copy, "200 copied");
      assert.equal(v.tries.read, "200");
      assert.equal(v.error, "a part address copied another object");
      assert.equal(v.inconclusive, undefined);
      assert.equal(b.objects.size, 0);
      assert.equal(logged.filter((l) => l.warn === "r2direct.check" && l.copy === "200 copied").length, 1, "and says so in the log");
    });
  }
});

test("the check goes by storage's own list of parts, not only by what a copy answered", async () => {
  await withBucket(Object.assign({}, LAX, { quietCopy: true }), async (b) => {
    const v = await r2DirectCheck(b.env);
    assert.equal(v.ok, false);
    assert.equal(v.tries.copy, "200");
    assert.equal(v.error, "a part address copied another object");
  });
});

test("the check fails when storage does not take the address at all", async () => {
  await withBucket(Object.assign({}, SOUND, { accepts: false }), async (b) => {
    const v = await r2DirectCheck(b.env);
    assert.equal(v.ok, false);
    assert.equal(v.tries.part, "403 InvalidArgument");
    assert.equal(v.error, "storage did not take the part");
  });
});

test("a refusal proves nothing unless the same copy works with a credential that is allowed to", async () => {
  await withBucket(Object.assign({}, SOUND, { copies: false }), async (b) => {
    const v = await r2DirectCheck(b.env);
    assert.equal(v.ok, false);
    assert.equal(v.tries.control, "400 InvalidRequest");
    assert.match(v.error, /control copy did not copy/);
  });
});

test("a copy or a read turned away for another reason than the scope is not proof", async () => {
  // storage that enforces no scope, and answers these two requests with an error of its own
  for (const quirk of [{ scopedCopy: 400 }, { scopedRead: 404 }]) {
    await withBucket(Object.assign({}, LAX, { unsignedHeaders: "refuse" }, quirk), async (b) => {
      const v = await r2DirectCheck(b.env);
      assert.equal(v.ok, false, JSON.stringify(quirk));
    });
    await withBucket(Object.assign({}, SOUND, quirk), async (b) => {
      const v = await r2DirectCheck(b.env);
      assert.equal(v.ok, false, JSON.stringify(quirk));
      assert.equal(v.error, "the credential's scope was not what refused");
    });
  }
});

test("a try storage did not answer makes the check inconclusive, never a pass", async () => {
  for (const fails of [[1], [2], [3], ["read"], [4]]) {
    await withBucket(Object.assign({}, SOUND, { fails }), async (b) => {
      const v = await r2DirectCheck(b.env);
      assert.equal(v.ok, false, String(fails));
      assert.equal(v.inconclusive, true, String(fails));
      assert.equal(v.error, "storage did not answer a try");
    });
    // with no scope enforced, a 503 on one try must not hide the copy, or be read as a refusal
    await withBucket(Object.assign({}, LAX, { unsignedHeaders: "refuse", fails }), async (b) => {
      assert.equal((await r2DirectCheck(b.env)).ok, false, String(fails));
    });
  }
});

test("the check never throws: storage being down is an inconclusive check", async () => {
  await withBucket({ down: true }, async (b) => {
    const v = await r2DirectCheck(b.env);
    assert.equal(v.ok, false);
    assert.equal(v.inconclusive, true);
    assert.match(v.error, /storage is down/);
  });
});

test("the check clears what an interrupted run left behind, and only that", async () => {
  await withBucket(SOUND, async (b) => {
    b.objects.set(CHECK_PREFIX + "old/other", { bytes: new Uint8Array(64), uploaded: new Date(Date.now() - 2 * 3600000) });
    b.objects.set(CHECK_PREFIX + "now/other", { bytes: new Uint8Array(64), uploaded: new Date(Date.now() - 60000) });
    b.objects.set("some-room/1/image", { bytes: new Uint8Array(64), uploaded: new Date(Date.now() - 9 * 3600000) });
    await r2DirectCheck(b.env);
    assert.deepEqual([...b.objects.keys()].sort(), [CHECK_PREFIX + "now/other", "some-room/1/image"]);
  });
});

test("a pass is kept a day, a failure a quarter of an hour, an unanswered check a minute", async () => {
  await withBucket(SOUND, async (b) => {
    assert.equal(await directUploadsProven(b.env), true);
    assert.deepEqual(b.calls.kvPut.map((p) => [p.key, p.value.ok, p.value.v, p.ttl]), [["check:r2-direct", true, CHECK_VERSION, 86400]]);
    assert.match(b.calls.kvPut[0].value.cred, /^[0-9a-f]{12}$/);
    assert.ok(!JSON.stringify(b.calls.kvPut).includes(CRED.R2_SECRET_ACCESS_KEY));
    const fetches = b.calls.fetch, gets = b.calls.kvGet;
    assert.equal(await directUploadsProven(b.env), true);
    assert.equal(b.calls.fetch, fetches, "the same isolate asks nothing again");
    assert.equal(b.calls.kvGet, gets);
    forgetDirectVerdict();
    assert.equal((await directVerdict(b.env)).ok, true);
    assert.equal(b.calls.fetch, fetches, "another isolate reads the kept verdict instead of checking again");
    assert.equal(b.calls.kvGet, gets + 1);
  });
  await withBucket(LAX, async (b) => {
    assert.equal(await directUploadsProven(b.env), false);
    assert.deepEqual(b.calls.kvPut.map((p) => [p.value.ok, p.ttl]), [[false, 900]]);
  });
  await withBucket(Object.assign({}, SOUND, { fails: [3] }), async (b) => {
    assert.equal(await directUploadsProven(b.env), false);
    assert.deepEqual(b.calls.kvPut.map((p) => [p.value.ok, p.value.inconclusive, p.ttl]), [[false, true, 60]]);
  });
});

test("a kept verdict counts only for this version of the check and this credential", async () => {
  await withBucket(SOUND, async (b) => {
    assert.equal(await directUploadsProven(b.env), true);
    const kept = JSON.parse(b.kv.get("check:r2-direct"));
    for (const stale of [Object.assign({}, kept, { v: CHECK_VERSION - 1 }), Object.assign({}, kept, { cred: "000000000000" }), { ok: true }, "not json"]) {
      b.kv.set("check:r2-direct", typeof stale === "string" ? stale : JSON.stringify(stale));
      forgetDirectVerdict();
      const before = b.calls.checks;
      assert.equal(await directUploadsProven(b.env), true);
      assert.equal(b.calls.checks, before + 1, "proved afresh for " + JSON.stringify(stale).slice(0, 40));
    }
    // a rolled secret is another credential
    forgetDirectVerdict();
    const before = b.calls.checks;
    assert.equal(await directUploadsProven(Object.assign({}, b.env, { R2_SECRET_ACCESS_KEY: "e".repeat(64) })), true);
    assert.equal(b.calls.checks, before + 1);
  });
});

test("one check at a time in an isolate: a caller that arrives while one runs is told not yet", async () => {
  await withBucket(SOUND, async (b) => {
    // which caller gets to run it is not fixed; that only one does is
    const [a, c, d] = await Promise.all([directVerdict(b.env), directVerdict(b.env), directVerdict(b.env), renewDirectVerdict(b.env)]);
    const ran = [a, c, d].filter((v) => v.ok);
    const waited = [a, c, d].filter((v) => !v.ok);
    assert.ok(ran.length <= 1, "at most one of them ran the check");
    assert.ok(waited.every((v) => v.inconclusive === true && v.error === "a check is running"));
    assert.equal(b.calls.checks, 1);
    assert.equal(b.calls.kvPut.length, 1);
    assert.equal(await directUploadsProven(b.env), true, "and the next caller has the verdict");
  });
});

test("the build route renews a pass from half a day on", async () => {
  await withBucket(SOUND, async (b) => {
    const t0 = Date.now();
    await renewDirectVerdict(b.env);
    assert.equal(b.calls.checks, 1, "nothing proven yet: it runs");
    await renewDirectVerdict(b.env);
    forgetDirectVerdict();
    await renewDirectVerdict(b.env);
    assert.equal(b.calls.checks, 1, "a fresh pass is left alone");
    Date.now = () => t0 + 13 * 3600000;
    forgetDirectVerdict();
    await renewDirectVerdict(b.env);
    assert.equal(b.calls.checks, 2, "half a day on, it is proven again");
    assert.equal(JSON.parse(b.kv.get("check:r2-direct")).at, t0 + 13 * 3600000);
  });
});

test("a renewal that gets no answer leaves the pass standing; one that finds a copy takes it away", async () => {
  await withBucket(SOUND, async (b) => {
    const t0 = Date.now();
    await renewDirectVerdict(b.env);
    const stood = b.kv.get("check:r2-direct");
    Date.now = () => t0 + 13 * 3600000;
    forgetDirectVerdict();
    b.storage.fails = [1, 2, 3, 4, "read"];
    await renewDirectVerdict(b.env);
    assert.equal(b.calls.checks, 2);
    assert.equal(b.kv.get("check:r2-direct"), stood, "not replaced by an unanswered renewal");
    forgetDirectVerdict();
    assert.equal(await directUploadsProven(b.env), true);
  });
  await withBucket(SOUND, async (b) => {
    const t0 = Date.now();
    await renewDirectVerdict(b.env);
    Date.now = () => t0 + 13 * 3600000;
    forgetDirectVerdict();
    b.storage.scoped = false;
    await renewDirectVerdict(b.env);
    assert.equal(JSON.parse(b.kv.get("check:r2-direct")).ok, false);
    forgetDirectVerdict();
    assert.equal(await directUploadsProven(b.env), false);
  });
});

test("direct uploads are offered only when asked for, switched on, configured and proven", async () => {
  const allowed = (env, direct, owner) => UploadMethods.upDirectAllowed.call({ env }, direct, owner);
  await withBucket(SOUND, async (b) => {
    const on = Object.assign({ R2_DIRECT: "1" }, b.env);
    assert.equal(await allowed(on, true, false), true);
    assert.equal(await allowed(on, false, false), false, "not asked for");
    assert.equal(await allowed(b.env, true, false), false, "switched off");
    assert.equal(await allowed(b.env, "force", false), false, "force is the owner's");
    assert.equal(await allowed(b.env, "force", true), true);
    assert.equal(await allowed(Object.assign({}, on, { R2_SECRET_ACCESS_KEY: "" }), true, false), false, "not configured");
  });
  await withBucket(Object.assign({}, LAX, { unsignedHeaders: "refuse" }), async (b) => {
    const on = Object.assign({ R2_DIRECT: "1" }, b.env);
    assert.equal(await allowed(on, true, false), false, "storage does not enforce the scope: no direct uploads");
    assert.equal(await allowed(on, "force", true), false, "not even for the owner");
  });
  assert.equal(await directUploadsProven({}), false);
});

test("the sign route hands out only addresses made with the upload's own credential, and none unless proven", async () => {
  // the Room's side of sign, answering for a live direct session
  const stub = { uploadSignTarget: async () => ({ status: 200, key: KEY, upload_id: "U1", parts: [{ n: 1, bytes: 10 }, { n: 2, bytes: 5 }] }) };
  const sign = (env) => {
    const url = new URL("https://chat.example/api/rooms/some-room/messages/12/file/sign");
    return uploadStep(new Request(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ parts: [1, 2] }) }), env, url, stub, "some-room", 12, "file", "sign", "Ada", false);
  };
  await withBucket(SOUND, async (b) => {
    const res = await sign(b.env);
    assert.equal(res.status, 200);
    const j = await res.json();
    assert.deepEqual(j.bytes, { 1: 10, 2: 5 });
    assert.deepEqual(Object.keys(j.urls), ["1", "2"]);
    for (const n of [1, 2]) {
      const q = new URL(j.urls[n]).searchParams;
      const claims = claimsOf(q.get("X-Amz-Security-Token"));
      assert.deepEqual([claims.actions, claims.paths.objectPaths, claims.paths.prefixPaths], [["UploadPart"], [KEY], []]);
      assert.equal(q.get("X-Amz-SignedHeaders"), "content-length;host");
      assert.equal(q.get("partNumber"), String(n));
    }
  });
  await withBucket(Object.assign({}, LAX, { unsignedHeaders: "refuse" }), async (b) => {
    const res = await sign(b.env);
    assert.equal(res.status, 503);
    assert.ok(!(await res.text()).includes("X-Amz"), "no address in a refusal");
  });
});

test("an upload already in flight goes through the site while the check is not passing, if its parts fit", async () => {
  const stays = (env, mode, partSize, owner) => UploadMethods.upStaysDirect.call({ env, upDirectOff: UploadMethods.upDirectOff }, mode, partSize, owner);
  const on = (env) => Object.assign({ R2_DIRECT: "1" }, env);
  await withBucket(SOUND, async (b) => {
    assert.equal(await stays(on(b.env), "direct", 8 * MIB), true);
    assert.equal(await stays(on(b.env), null, 8 * MIB), false, "a session through the site stays there");
    assert.equal(await stays(b.env, "direct", 8 * MIB), false, "the switch off: through the site");
    assert.equal(await stays(b.env, "direct", 8 * MIB, true), true, "unless the owner, who may force it");
  });
  await withBucket(Object.assign({}, LAX, { unsignedHeaders: "refuse" }), async (b) => {
    assert.equal(await stays(on(b.env), "direct", 8 * MIB), false, "parts that fit a request to the site go through it");
    assert.equal(await stays(on(b.env), "direct", UP_PART_MAX), false);
    assert.equal(await stays(on(b.env), "direct", UP_PART_MAX + 1), true, "bigger parts have only storage: their sign waits");
  });
  assert.equal(await stays(on({}), "direct", 8 * MIB), false, "the credential gone: through the site");
});

test("the check gives storage a deadline: a request that hangs is a try not answered", async () => {
  await withBucket(SOUND, async (b) => {
    const real = AbortSignal.timeout;
    AbortSignal.timeout = () => real.call(AbortSignal, 30);
    const s3 = globalThis.fetch;
    globalThis.fetch = (input, init = {}) => (init.method === "PUT" && String(input).includes("partNumber=3")
      // never answers; the timer only keeps the test's event loop alive until the deadline fires
      ? new Promise((_, reject) => { const t = setTimeout(reject, 5000); init.signal.addEventListener("abort", () => { clearTimeout(t); reject(init.signal.reason); }); })
      : s3(input, init));
    try {
      const v = await r2DirectCheck(b.env);
      assert.equal(v.ok, false);
      assert.equal(v.inconclusive, true);
      assert.equal(b.objects.size, 0, "and it still cleans up");
    } finally { AbortSignal.timeout = real; }
  });
});
