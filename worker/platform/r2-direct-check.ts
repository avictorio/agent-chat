// Direct uploads are offered only while storage proves they are safe.
//
// A direct upload hands the uploader addresses on R2 itself, and the
// Worker never sees what is sent to them. An address is a credential
// (r2-s3.ts, r2PartCredential): its holder can sign requests of their own
// with it. The one fence is R2 enforcing that credential's scope -
// UploadPart, on the upload's own object. That is R2's behaviour, not this
// code's, and the local emulation does not have it, so no test here can
// show it. So the Worker tries, on the live bucket, with objects of its
// own under CHECK_PREFIX, what the holder of an address could try:
//
//   part     the address takes its part                      must be 200
//   copy     a copy of another object into the upload, the
//            copy source signed with the address's credential  must be 403
//   header   the same copy, the source sent as an extra header
//            on a part address without signing it             must not copy
//   read     a read of the other object with the credential   must be 403
//   control  the signed copy again, made with the API
//            credential, which is allowed to                   must copy
//
// The control is what gives `copy` its meaning: without it a refusal could
// be a malformed request, not the scope. (On the live bucket `header` is
// refused as a signature mismatch: R2, like AWS S3, counts an x-amz header
// nobody signed against the signature. The local emulation acts on it.) Direct uploads are offered only
// after all five come out as above. A try storage did not answer (a 5xx,
// a 429, an error) settles nothing: the check is inconclusive and runs
// again within a minute.
//
// The verdict is kept in KV with the version of this check and a
// fingerprint of the credential, so a change to either is proven afresh:
// a day when good (and GET /api/build, which every open page polls,
// renews it from half a day on, so an upload seldom waits for a check), a
// quarter of an hour when storage failed a try, a minute when
// inconclusive. While there is no good verdict every upload goes through
// the site, as when R2_DIRECT is off.

import { hexBytes, hmacBytes } from "../lib/crypto.js";
import { warn } from "../lib/log.js";
import { r2Address, r2DirectConfigured, r2ListParts, r2PartAddresses, sigv4Presign, type R2Credential, type R2DirectEnv } from "./r2-s3.js";

/** No room's objects live here: a room name cannot start with "_". */
export const CHECK_PREFIX = "_check/";
/** Raise it whenever r2-s3.ts signs part addresses differently or this check asks something else: verdicts kept under the old number stop counting. */
export const CHECK_VERSION = 2;
const KV_KEY = "check:r2-direct";
const GOOD_S = 86400;
const BAD_S = 900;
const UNSURE_S = 60;
const RENEW_MS = 12 * 3600 * 1000;

export type DirectVerdict = {
  /** all five tries came out as they must */
  ok: boolean,
  at: number,
  /** CHECK_VERSION when it ran */
  v: number,
  /** fingerprint of the credential it ran with */
  cred: string,
  /** what storage answered each try: its status and error code, and "copied" when it copied */
  tries: Record<string, string>,
  /** storage did not answer a try: nothing is known, and the check runs again soon */
  inconclusive?: boolean,
  error?: string,
};

/** This isolate's copy of the verdict, so most requests read neither KV nor R2. */
let known: { verdict: DirectVerdict, until: number } | null = null;
/** When this isolate last began a check. */
let began = 0;

/** Whether this deployment may hand out part addresses right now. */
export async function directUploadsProven(env: Env | null | undefined): Promise<boolean> {
  if (!r2DirectConfigured(env)) return false;
  return (await directVerdict(env)).ok;
}

/** The verdict in force, running the check when there is none. */
export async function directVerdict(env: R2DirectEnv): Promise<DirectVerdict> {
  const cred = await fingerprint(env);
  const have = await kept(env, cred);
  if (have) return have;
  // One check at a time in an isolate. A request cannot wait on another
  // request's promise in a Worker (each has its own I/O context), so one
  // that arrives while a check runs is told "not proven yet" instead.
  if (Date.now() - began < 30000) return { ok: false, at: Date.now(), v: CHECK_VERSION, cred: cred, tries: {}, inconclusive: true, error: "a check is running" };
  return run(env, cred, null);
}

/** For GET /api/build: prove it now if nothing is, and renew a pass that is half a day old. */
export async function renewDirectVerdict(env: R2DirectEnv): Promise<void> {
  const cred = await fingerprint(env);
  const have = await kept(env, cred);
  const now = Date.now();
  if (have && !(have.ok && now - have.at > RENEW_MS)) return;
  if (now - began < 60000) return;
  await run(env, cred, have);
}

/** Only for tests: forget this isolate's copy of the verdict and its last run. */
export function forgetDirectVerdict(): void {
  known = null;
  began = 0;
}

// Not the secret, and no way back to it: enough to tell that the
// credential a verdict was earned with is still the one in use.
async function fingerprint(env: R2DirectEnv) {
  return hexBytes(await hmacBytes(env.R2_SECRET_ACCESS_KEY, "r2-direct-check:" + env.R2_ACCESS_KEY_ID)).slice(0, 12);
}

/** The verdict kept in this isolate or in KV, if it is for this check and this credential. */
async function kept(env: R2DirectEnv, cred: string): Promise<DirectVerdict | null> {
  const now = Date.now();
  if (known && known.until > now) return known.verdict;
  known = null;
  let text: string | null = null;
  try { text = await env.REQUESTS.get(KV_KEY); } catch (e) { warn("r2direct.kv", e); }
  let verdict: DirectVerdict | null = null;
  try { verdict = text ? JSON.parse(text) as DirectVerdict : null; } catch { /* unreadable: no verdict */ }
  if (!verdict || typeof verdict.ok !== "boolean" || verdict.v !== CHECK_VERSION || verdict.cred !== cred) return null;
  remember(verdict);
  return verdict;
}

function remember(verdict: DirectVerdict) {
  known = { verdict: verdict, until: Date.now() + (verdict.ok ? 600000 : 30000) };
}

/** @param standing a pass still in force that this run is renewing */
async function run(env: R2DirectEnv, cred: string, standing: DirectVerdict | null): Promise<DirectVerdict> {
  began = Date.now();
  const verdict = await r2DirectCheck(env);
  verdict.cred = cred;
  // a renewal that could not be answered leaves the standing pass in force
  if (standing && verdict.inconclusive) return standing;
  try { await env.REQUESTS.put(KV_KEY, JSON.stringify(verdict), { expirationTtl: verdict.ok ? GOOD_S : verdict.inconclusive ? UNSURE_S : BAD_S }); } catch (e) { warn("r2direct.kv", e); }
  remember(verdict);
  return verdict;
}

type Answer = { status: number, code: string, copied: boolean };

/** Runs the check against the live bucket; never throws. */
export async function r2DirectCheck(env: R2DirectEnv): Promise<DirectVerdict> {
  const verdict: DirectVerdict = { ok: false, at: Date.now(), v: CHECK_VERSION, cred: "", tries: {} };
  const id = crypto.randomUUID();
  const other = CHECK_PREFIX + id + "/other";
  const mine = CHECK_PREFIX + id + "/upload";
  // different lengths, so storage's list of parts shows whose bytes a part holds
  const otherBytes = crypto.getRandomValues(new Uint8Array(64));
  const partBytes = crypto.getRandomValues(new Uint8Array(1024));
  let up: R2MultipartUpload | null = null;
  try {
    await sweep(env);
    await env.MEDIA.put(other, otherBytes);
    up = await env.MEDIA.createMultipartUpload(mine);
    const uploadId = up.uploadId;
    const now = new Date();
    const ttl = 300;
    const send = async (name: string, url: string, init: RequestInit): Promise<Answer> => {
      const res = await fetch(url, init);
      const text = await res.text();
      // the error's code and never its message: a signature error's message repeats the request, token and all
      const code = (/<Code>([A-Za-z0-9]{1,60})<\/Code>/.exec(text) || [])[1] || "";
      const a = { status: res.status, code: code, copied: res.status < 300 && text.includes("<CopyPartResult") };
      verdict.tries[name] = [String(a.status), a.code, a.copied ? "copied" : ""].filter(Boolean).join(" ");
      return a;
    };
    const mineAt = r2Address(env, mine);
    const otherAt = r2Address(env, other);
    const copyFrom = { "x-amz-copy-source": "/" + env.R2_BUCKET + "/" + other };
    const api: R2Credential = { accessKey: env.R2_ACCESS_KEY_ID, secretKey: env.R2_SECRET_ACCESS_KEY };
    const partOf = (n: number, cred: R2Credential, headers: Record<string, string> | null) =>
      sigv4Presign(Object.assign({ method: "PUT", host: mineAt.host, path: mineAt.path, query: { partNumber: String(n), uploadId: uploadId }, headers: headers, region: "auto", expires: ttl, date: now }, cred));

    // Part addresses exactly as the sign route makes them; everything
    // else is signed with the credential they disclose, as their holder could.
    const addresses = await r2PartAddresses(env, mine, uploadId, [{ n: 1, bytes: partBytes.length }, { n: 2, bytes: 0 }], ttl, now);
    const held = await credentialOf(addresses[1]);
    const part = await send("part", addresses[1], { method: "PUT", body: partBytes });
    const header = await send("header", addresses[2], { method: "PUT", headers: copyFrom });
    const copy = await send("copy", await partOf(3, held, copyFrom), { method: "PUT", headers: copyFrom });
    const read = await send("read", await sigv4Presign(Object.assign({ method: "GET", host: otherAt.host, path: otherAt.path, region: "auto", expires: ttl, date: now }, held)), { method: "GET" });
    const control = await send("control", await partOf(4, api, copyFrom), { method: "PUT", headers: copyFrom });

    const parts = await r2ListParts(env, mine, uploadId);
    const holds = (n: number) => (parts.get(n) || { size: -1 }).size;
    const copied = header.copied || copy.copied || holds(2) === otherBytes.length || holds(3) === otherBytes.length;
    const unanswered = [part, header, copy, read, control].some((a) => a.status >= 500 || a.status === 429);
    if (unanswered) { verdict.inconclusive = true; verdict.error = "storage did not answer a try"; }
    else if (copied) verdict.error = "a part address copied another object";
    else if (part.status !== 200 || holds(1) !== partBytes.length) verdict.error = "storage did not take the part";
    else if (copy.status !== 403 || read.status !== 403) verdict.error = "the credential's scope was not what refused";
    else if (!control.copied) verdict.error = "the control copy did not copy, so the refusals prove nothing";
    else verdict.ok = true;
  } catch (e) {
    verdict.inconclusive = true;
    verdict.error = String((e && (e as Error).message) || e).slice(0, 200);
  } finally {
    if (up) { try { await up.abort(); } catch { /* nothing to clear */ } }
    try { await env.MEDIA.delete(other); } catch (e) { warn("r2direct.cleanup", e); }
  }
  if (verdict.ok) console.log(JSON.stringify(Object.assign({ note: "r2direct.check", ok: true }, verdict.tries)));
  else warn("r2direct.check", verdict.error || "failed", Object.assign({ inconclusive: !!verdict.inconclusive }, verdict.tries));
  return verdict;
}

/** The credential an address discloses to whoever holds it. */
async function credentialOf(address: string): Promise<Required<R2Credential>> {
  const q = new URL(address).searchParams;
  const token = q.get("X-Amz-Security-Token") || "";
  const jwt = atob(token).slice("jwt/".length);
  return { accessKey: (q.get("X-Amz-Credential") || "").split("/")[0], secretKey: hexBytes(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(jwt))), token: token };
}

// A run cut short (a deploy, a cancelled request) can leave its "other"
// object behind; its upload goes with the bucket's 7-day abort rule.
async function sweep(env: R2DirectEnv) {
  try {
    const old = Date.now() - 3600000;
    const listed = await env.MEDIA.list({ prefix: CHECK_PREFIX, limit: 100 });
    const stale = listed.objects.filter((o) => o.uploaded.getTime() < old).map((o) => o.key);
    if (stale.length) await env.MEDIA.delete(stale);
  } catch (e) { warn("r2direct.cleanup", e); }
}
