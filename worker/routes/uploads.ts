// Upload requests: streaming a part into R2, the session steps, and the addresses handed to clients and MCP.

import { deny, json, readBody, type Body, bodyNumber, bodyText, refused, settleBody } from "../lib/http.js";
import { cleanMediaType, upSniff, upTypeError } from "../uploads/plan.js";
import { sniffVideo } from "../lib/sniff.js";
import { directUploadsProven } from "../platform/r2-direct-check.js";
import { r2DirectConfigured, r2PartAddresses } from "../platform/r2-s3.js";
import {
  mediaTooBig,
  MIB,
  ROOM_RE,
  SMALL_BODY_MAX,
  STREAM_PART,
  UP_PART_MAX,
  UP_KINDS,
  UP_SIGN_MAX,
  UP_SIGN_TTL,
  VIDEO_MAX_HARD,
  VIDEO_STREAM_TOO_BIG,
} from "../limits.js";
import { mediaSigParams } from "../lib/media.js";
import { isGoneError } from "../lib/errors.js";
import { warn } from "../lib/log.js";
import type { RouteContext } from "../index.js";

// Stream one part's request body into its R2 multipart slot. Nothing is
// buffered: R2 takes the request stream as it is (its length is known
// from Content-Length). With sniff set (part 1 of an image, audio or
// video upload) the first bytes are read and checked before anything is
// stored, then rejoined to the rest through a FixedLengthStream, so a
// wrong kind of file is refused at its first part, not after the whole
// upload. Answers { part } - or { part: null } when the sniff fails.
/**
 * @param n the part number
 * @param len the part's length
 * @param sniff the kind's sniffer, for a first part
 */
export async function streamUploadPart(up: R2MultipartUpload, n: number, body: ReadableStream<Uint8Array>, len: number, sniff: ((buf: ArrayBuffer) => string | null) | null) {
  if (!sniff) return { part: await up.uploadPart(n, body) };
  const reader = body.getReader();
  const head = [];
  let got = 0;
  while (got < 16 && got < len) {
    const c = await reader.read();
    if (c.done) break;
    if (c.value && c.value.byteLength) { head.push(c.value); got += c.value.byteLength; }
  }
  const first = new Uint8Array(got);
  let off = 0;
  for (const h of head) { first.set(h, off); off += h.byteLength; }
  if (!sniff(first.buffer)) {
    // read the rest away, so the client gets the refusal as a clean answer
    try { for (;;) { const c = await reader.read(); if (c.done) break; } } catch { /* the client went away mid-body */ }
    return { part: null };
  }
  const fixed = new FixedLengthStream(len);
  const w = fixed.writable.getWriter();
  const pump = (async () => {
    try {
      await w.write(first);
      for (;;) {
        const c = await reader.read();
        if (c.done) break;
        if (c.value && c.value.byteLength) await w.write(c.value);
      }
      await w.close();
    } catch (e) {
      try { await w.abort(e); } catch { /* the stream had already failed */ }
      throw e;
    }
  })();
  // awaited below; this only keeps an early failure from counting as unhandled
  pump.catch(() => {});
  let part;
  try { part = await up.uploadPart(n, fixed.readable); }
  catch (e) { try { await reader.cancel(); } catch { /* the body had already ended */ } throw e; }
  await pump;
  return { part: part };
}

// The upload engine's five steps over HTTP, shared by the invite-token
// routes (/messages/ID/KIND/STEP) and resumable upload links
// (/api/uploads/ROOM/LINK/STEP, which cannot start: their session
// started when the link was opened).
/**
 * @param stub the room
 * @param step start, part, sign, status, finish or abort
 */
/** @param still asked once a streamed part has arrived: the refusal if the caller's credential has gone meanwhile
 *  @param linkExpires an upload link's expiry, which names the session it was opened for (a finish compares it) */
export async function uploadStep(request: Request, env: Env, url: URL, stub: DurableObjectStub, room: string, id: number, kind: string, step: string, who: string | null | undefined, owner: boolean, still?: () => Promise<{ status: number, error: string, code?: string } | null>, linkExpires?: number) {
  if (step === "part") {
    // A refused part is read away before the answer goes back: a client
    // still sending its body would otherwise see the connection drop
    // instead of the reason.
    const refuse = async (body: Record<string, unknown>, status: number) => {
      if (request.body) { try { await request.body.pipeTo(new WritableStream()); } catch { /* the client went away mid-body */ } }
      return json(body, status);
    };
    if (request.method !== "PUT" && request.method !== "POST") return refuse({ error: "Method not allowed" }, 405);
    if (!env.MEDIA) return refuse({ error: "The R2 binding (MEDIA) is not configured" }, 501);
    const n = parseInt(url.searchParams.get("n") || "", 10);
    const cl = request.headers.get("Content-Length");
    if (cl === null || cl === "") return refuse({ error: "Send each part with a Content-Length: its exact byte length" }, 411);
    const len = Number(cl);
    if (!request.body || !len) return refuse({ error: "Send the part as the request body" }, 400);
    const t = await stub.uploadPartTarget(id, kind, who, owner, n, len);
    if (refused(t)) return refuse(t.expected ? { error: t.error, expected_bytes: t.expected } : { error: t.error }, t.status);
    let res;
    try { res = await streamUploadPart(env.MEDIA.resumeMultipartUpload(t.key, t.upload_id), n, request.body, len, t.sniff ? upSniff(kind) : null); }
    catch (e) { return json({ error: "Part " + n + " did not reach storage (" + String((e && (e as Error).message) || e) + "); send it again" }, 502); }
    if (!res.part) return json({ error: upTypeError(kind) + " (checked from the first bytes of part 1); nothing was stored" }, 415);
    // a part can take minutes to arrive: whoever sent it must still be welcome when it is recorded
    const gone = still ? await still() : null;
    if (gone) return deny(gone);
    const d = await stub.uploadPartDone(id, kind, t.upload_id, n, res.part.etag);
    if (refused(d)) return json({ error: d.error }, d.status);
    return json({ room: room, id: id, kind: kind, part: n });
  }
  if (step === "sign") {
    // A direct session's part addresses: presigned PUTs straight to R2,
    // up to UP_SIGN_MAX at a time, each good for UP_SIGN_TTL seconds.
    if (request.method !== "POST" && request.method !== "GET") return json({ error: "Method not allowed" }, 405);
    let nums = [];
    if (request.method === "GET") nums = String(url.searchParams.get("n") || "").split(",").filter(Boolean);
    else { const sb = await readBody(request); nums = sb && Array.isArray(sb.parts) ? sb.parts : []; }
    const t = await stub.uploadSignTarget(id, kind, who, owner, nums);
    if (refused(t)) return json({ error: t.error }, t.status);
    // no address leaves unless storage has shown what one can do (r2-direct-check.ts)
    if (!r2DirectConfigured(env) || !(await directUploadsProven(env))) return json({ error: "Direct uploads are paused for the moment: ask again in a few minutes, or send each part through the site instead (PUT its /part?n=N) if the parts are " + Math.floor(UP_PART_MAX / MIB) + " MiB or less" }, 503);
    // the check above can take a while: whoever asked must still be welcome before an address (good for an hour) leaves
    const gone = still ? await still() : null;
    if (gone) return deny(gone);
    const now = new Date();
    /** each part's address */
    const urls = await r2PartAddresses(env, t.key, t.upload_id, t.parts, UP_SIGN_TTL, now);
    /** each part's length */
    const bytes: Record<number, number> = {};
    for (const p of t.parts) bytes[p.n] = p.bytes;
    return json({ room: room, id: id, kind: kind, method: "PUT", urls: urls, bytes: bytes, expires_at: new Date(now.getTime() + UP_SIGN_TTL * 1000).toISOString(), note: "PUT each part's raw bytes to its url: exactly bytes[n] of them (the address is signed for that length), no other headers, no credential. Then status / finish as usual." });
  }
  if (step === "status") {
    if (request.method !== "GET" && request.method !== "POST") return json({ error: "Method not allowed" }, 405);
    const r = await stub.uploadStatus(id, kind, who, owner);
    if (r.status && r.status !== 200) return json({ error: r.error }, r.status);
    return json({ room: room, id: id, kind: kind, uploading: r.uploading, complete: !!r.complete, direct: !!r.direct, size: r.size || null, type: r.type || null, name: r.name || null, part_size: r.part_size || null, parts: r.parts || null, received: r.received, expires_at: r.expires_at ? new Date(r.expires_at).toISOString() : null });
  }
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const body = await readBody(request);
  if (step === "start") {
    const direct = body && (body.direct === "force" ? "force" : !!body.direct);
    const size = body && (typeof body.size === "number" || typeof body.size === "string") ? body.size : null;
    const r = await stub.uploadStart(id, kind, who, owner, room, size, body && body.type, body && body.name, body && body.fingerprint ? bodyText(body.fingerprint, "fingerprint") : null, direct);
    if (refused(r)) return json({ error: r.error }, r.status);
    return json({ room: room, id: id, kind: kind, part_size: r.part_size, parts: r.parts, resumed: !!r.resumed, received: r.received, direct: !!r.direct, expires_at: new Date(r.expires_at).toISOString() });
  }
  if (step === "finish") {
    // Optional: the file this finish means, so a repeat after another
    // upload replaced this one and finished is told so (upFinishNow).
    const size = body && body.size !== undefined && body.size !== null ? bodyNumber(body.size, "size", true) : null;
    if (size !== null && !(size >= 1)) return json({ error: "\"size\" must be the file's exact length in bytes" }, 400);
    const fp = body ? bodyText(body.fp, "fp") || null : null;
    const r = await stub.uploadFinish(id, kind, who, owner, room, { transcript: body ? body.transcript : undefined, size: size, fp: fp, expires: linkExpires ?? null });
    if (refused(r)) return json(r.missing ? { error: r.error, missing: r.missing } : { error: r.error }, r.status);
    /** the answer, with the media under its kind */
    const media: { type: string, bytes: number, url: string, name?: string | null } = { type: r.type, bytes: r.bytes, url: url.origin + "/api/rooms/" + room + "/messages/" + id + "/" + kind + "?" + (await mediaSigParams(env, room, id, kind)) };
    if (kind === "file") media.name = r.name;
    return json({ room: room, id: id, kind: kind, published: !!r.published, [kind]: media });
  }
  const r = await stub.uploadAbort(id, kind, who, owner);
  if (refused(r)) return json({ error: r.error }, r.status);
  return json({ room: room, id: id, kind: kind, aborted: true });
}

// A resumable upload link's addresses (begin_upload or upload-ticket with
// a size): the engine's steps, with the link itself as the credential.
/** An upload ticket as mintUploadTicket answers it (status 200): the raw
 *  ticket, when it expires and how big its upload may be, plus a
 *  resumable session's plan. */
export type UploadTicket = { ticket: string, expires: number, max_bytes: number, size?: number, part_size?: number, parts?: number, direct?: boolean };
export function sessionUpload(origin: string, room: string, kind: string, t: UploadTicket) {
  const base = origin + "/api/uploads/" + room + "/" + t.ticket;
  return {
    mode: "resumable",
    kind: kind,
    size: t.size,
    part_size: t.part_size,
    parts: t.parts,
    part: t.direct ? null : { method: "PUT", url: base + "/part?n={n}" },
    sign: t.direct ? { method: "POST", url: base + "/sign", body: { parts: [1, 2] } } : null,
    status: { method: "GET", url: base + "/status" },
    finish: { method: "POST", url: base + "/finish" },
    abort: { method: "POST", url: base + "/abort" },
    auth: "none - these URLs are the credential",
    expires_at: new Date(t.expires).toISOString(),
    direct: !!t.direct,
    note: (t.direct ? "POST sign.url with {\"parts\": [n, ...]} (up to " + UP_SIGN_MAX + " a call) for each part's address and PUT part n's raw bytes there - " : "PUT part n to part.url with {n} replaced - ") + "bytes [(n-1)*part_size, n*part_size) of the file, n = 1.." + t.parts + ", in any order, re-sending any that fails; then POST finish.url, and publish_message with message_id unless publish_on_complete is set. These URLs are the credential until expires_at; see UPLOADING FILES at " + origin + "/api."
  };
}

// Does an upload-link request want a resumable session? Yes whenever it
// gives a size, for every kind, as the docs and the begin_upload schema
// promise; a file must give one. Only a call without a size gets a
// single-shot ticket. Small media given a size once got the single-shot
// shape anyway, so a script written for upload.part.url broke on it.
// Answers null (single-shot), { size, type, name } or { error }.
/** @param a the request's fields (a JSON body or MCP arguments) */
export function uploadSessionWanted(kind: string, a: Body) {
  const has = a.size !== undefined && a.size !== null && a.size !== "";
  if (!has) return kind === "file" ? { error: "\"size\" (the file's exact length in bytes) is required for kind file" } : null;
  const size = Math.floor(Number(a.size));
  if (!Number.isFinite(size) || size < 1) return { error: "\"size\" must be the file's exact length in bytes" };
  return { size: size, type: bodyText(a.type, "type") || null, name: bodyText(a.name, "name") || null, direct: a.direct === true || a.direct === "true" };
}

// The upload object begin_upload and the REST upload-ticket route hand out.
// The URL is the credential: single-use, short-lived, and the only place
// the raw ticket exists outside the client's hands.
export function ticketUpload(origin: string, room: string, t: UploadTicket) {
  return {
    method: "PUT",
    url: origin + "/api/uploads/" + room + "/" + t.ticket,
    headers: { "Content-Type": "<the file's media type>" },
    auth: "none - the URL is the credential",
    single_use: true,
    expires_at: new Date(t.expires).toISOString(),
    max_bytes: t.max_bytes,
    note: "PUT the raw file bytes to url (single use; the URL is the credential until expires_at), then publish_message with message_id unless publish_on_complete is set; see UPLOADING FILES at " + origin + "/api."
  };
}

// Resumable upload links: the upload engine's part / sign / status /
// finish / abort steps with the link as the credential, for one session.
export async function uploadLinkStepRoute(rc: RouteContext, usm: RegExpMatchArray) {
  const { request, env, url } = rc;
  const uroom = decodeURIComponent(usm[1]).toLowerCase();
  if (!ROOM_RE.test(uroom)) return json({ error: "Room names are 1-64 lowercase letters, digits, - or _" }, 400);
  const ustub = env.ROOM.get(env.ROOM.idFromName(uroom));
  const link = decodeURIComponent(usm[2]);
  // Every step but a part has a small body or none: it is read before
  // the link is looked up, so a body held back cannot carry a step (a
  // finish that publishes, say) past the link's end (settleBody).
  let asked: Request | null = request;
  if (usm[3] !== "part") asked = await settleBody(request, SMALL_BODY_MAX);
  if (!asked) return json({ error: "That request's body is too large for this step" }, 413);
  const st = await ustub.uploadSessionTicket(link);
  if (refused(st)) {
    if (asked.body && !asked.bodyUsed) { try { await asked.body.pipeTo(new WritableStream()); } catch { /* the client went away mid-body */ } }
    return json({ error: st.error }, st.status);
  }
  const still = async () => { const again = await ustub.uploadSessionTicket(link); return refused(again) ? again : null; };
  return uploadStep(asked, env, url, ustub, uroom, st.msg, st.kind, usm[3], st.member, false, still, st.expires);
}

// Upload tickets: PUT /api/uploads/ROOM/TICKET redeems a
// begin_upload ticket. Deliberately NO access check: the ticket is the
// credential (single-use, 15 minutes, hash-only at rest). The ticket is
// never echoed back in any response.
export async function uploadLinkRoute(rc: RouteContext, um: RegExpMatchArray) {
  const { request, env } = rc;
  const uroom = decodeURIComponent(um[1]).toLowerCase();
  if (!ROOM_RE.test(uroom)) return json({ error: "Room names are 1-64 lowercase letters, digits, - or _" }, 400);
  if (request.method !== "PUT") return json({ error: "Method not allowed" }, 405);
  const ustub = env.ROOM.get(env.ROOM.idFromName(uroom));
  const ticket = decodeURIComponent(um[2]);
  // The ticket first, then a body no bigger than it allows. This route
  // takes anyone's request, and it used to hold the whole body before
  // asking whether the ticket existed: with no Content-Length (chunked)
  // nothing stopped it short of the edge's 100 MB, a few such requests
  // filled the isolate's memory, and over 32 MiB the hand-off to the room
  // failed with a 500.
  const lim = await ustub.uploadTicketLimit(ticket);
  const refuse = async (status: number, error: string) => {
    // read away, not held: a client still sending sees the reason, not a dropped connection
    if (request.body && !request.bodyUsed) { try { await request.body.pipeTo(new WritableStream()); } catch { /* the client went away mid-body */ } }
    return json({ error: error }, status);
  };
  if (refused(lim)) return refuse(lim.status, lim.error);
  const tooBig = mediaTooBig(lim.kind as "image" | "audio" | "video", "single-shot");
  if (+(request.headers.get("Content-Length") || 0) > lim.max_bytes) return refuse(413, tooBig);
  const held = await settleBody(request, lim.max_bytes);
  if (!held) return json({ error: tooBig }, 413);
  const ubuf = await held.arrayBuffer();
  const ur = await ustub.redeemUpload(ticket, ubuf, uroom);
  if (ur.status !== 200) return json({ error: ur.error }, ur.status);
  return json({ room: uroom, ok: true, type: ur.type, bytes: ur.bytes, published: ur.published });
}

// Content-Types that name no kind of file: a stream sent with one of these
// (or none) is typed by its first bytes.
const UNTYPED = ["application/octet-stream", "binary/octet-stream", "application/x-www-form-urlencoded"];

// Whole-file streaming ingest: ONE PUT carrying the entire video (the edge
// refuses request bodies over 100 MB, so in practice up to that; bigger
// files use the upload engine), for a client that can send a file in one
// request. The Worker assembles
// R2 multipart parts as the bytes arrive; nothing holds the whole file.
export async function videoStreamRoute(rc: RouteContext, m: RegExpMatchArray) {
  const { request, env, owner, invite, ctx } = rc;
  const room = decodeURIComponent(m[1]).toLowerCase();
  if (!ROOM_RE.test(room)) return json({ error: "Room names are 1-64 lowercase letters, digits, - or _" }, 400);
  if (request.method !== "PUT") return json({ error: "Method not allowed" }, 405);
  const id = parseInt(m[2], 10);
  const stub = env.ROOM.get(env.ROOM.idFromName(room));
  const acc = await stub.access(invite, owner);
  if (!acc.ok) return deny(acc);
  if (!env.MEDIA) return json({ error: "The R2 binding (MEDIA) is not configured" }, 501);
  if (!request.body) return json({ error: "Missing upload body" }, 400);
  // From the reservation on, the work runs under waitUntil as well as
  // being awaited for the answer. Cloudflare may cancel a request's work
  // when its client disconnects, awaits and all: a phone dropping mid-body
  // then skipped the cleanup, leaving the parts in storage and the row
  // holding its upload id (which kept the draft for days), and one
  // dropping after its last byte skipped the finish, so the video was
  // never indexed and a publish_on_complete draft never posted.
  const work = videoStreamIngest(rc, stub, room, id, acc.name || "", request.body);
  ctx.waitUntil(work.catch((e) => { if (!isGoneError(e)) warn("upload.stream", e, { room, id }); }));
  return await work;
}

/** videoStreamRoute's part from the reservation to the answer: take the
 *  body into storage, then finish (or clean up) in the Room. */
async function videoStreamIngest(rc: RouteContext, stub: DurableObjectStub, room: string, id: number, member: string, body: ReadableStream<Uint8Array>) {
  const { request, env, url, owner, invite } = rc;
  const media = env.MEDIA as R2Bucket;
  const declared = +(request.headers.get("Content-Length") || 0) || VIDEO_MAX_HARD;
  const reader = body.getReader();
  // The type, lower-cased and without parameters ("Video/MP4; codecs=...").
  // None, or one that says only "bytes" (application/octet-stream, or the
  // form type curl --data-binary sends), is read from the file's first
  // bytes instead: those used to be refused as "must be MP4, WebM or MOV"
  // with a real MP4 in the body. The chunks read for that go into storage
  // first, below.
  const ahead: Uint8Array[] = [];
  let type = cleanMediaType(request.headers.get("Content-Type"));
  if (!type || UNTYPED.indexOf(type) >= 0) {
    let got = 0;
    try {
      while (got < 16) {
        const c = await reader.read();
        if (c.done) break;
        if (c.value && c.value.byteLength) { ahead.push(c.value); got += c.value.byteLength; }
      }
    } catch (e) { return json({ error: "Upload stream failed: " + String((e && (e as Error).message) || e) }, 502); }
    if (!got) return json({ error: "Empty upload" }, 400);
    const first = new Uint8Array(got);
    let off = 0;
    for (const a of ahead) { first.set(a, off); off += a.byteLength; }
    type = sniffVideo(first.buffer);
    if (!type) {
      // read the rest away, so the client gets the refusal as a clean answer
      try { for (;;) { const c = await reader.read(); if (c.done) break; } } catch { /* the client went away mid-body */ }
      return json({ error: upTypeError("video") + " (checked from the file's first bytes, as no video type was sent); nothing was stored" }, 415);
    }
  }
  const begun = await stub.streamBegin(id, member, type, declared, owner, room);
  if (refused(begun)) return json({ error: begun.error }, begun.status);
  const key = begun.key, uploadId = begun.uploadId;
  const up = media.resumeMultipartUpload(key, uploadId);
  const fail = async (status: number, error: string) => {
    try { await up.abort(); } catch { /* already completed, aborted or expired */ }
    // streamAbort drops the row only while this upload still owns it
    await stub.streamAbort(id, uploadId);
    return json({ error: error }, status);
  };
  const parts = [];
  let counted = 0, n = 0, bufs = [] as Uint8Array[], buflen = 0;
  const take = (amount: number) => {
    const out = new Uint8Array(amount);
    let off = 0;
    while (off < amount) {
      const head = bufs[0], need = amount - off;
      if (head.byteLength <= need) { out.set(head, off); off += head.byteLength; bufs.shift(); }
      else { out.set(head.subarray(0, need), off); bufs[0] = head.subarray(need); off += need; }
    }
    buflen -= amount;
    return out;
  };
  try {
    for (;;) {
      const chunk = ahead.length ? { done: false, value: ahead.shift() } : await reader.read();
      if (chunk.done) break;
      const value = chunk.value;
      if (value && value.byteLength) {
        counted += value.byteLength;
        if (counted > VIDEO_MAX_HARD) return await fail(413, VIDEO_STREAM_TOO_BIG);
        bufs.push(value); buflen += value.byteLength;
        // oxlint-disable-next-line no-unmodified-loop-condition -- take() shrinks buflen
        while (buflen >= STREAM_PART) { const p = await up.uploadPart(++n, take(STREAM_PART)); parts.push({ partNumber: n, etag: p.etag }); }
      }
    }
    if (buflen > 0) { const p = await up.uploadPart(++n, take(buflen)); parts.push({ partNumber: n, etag: p.etag }); }
    if (!parts.length) return await fail(400, "Empty upload");
  } catch (e) {
    return await fail(502, "Upload stream failed: " + String((e && (e as Error).message) || e));
  }
  // The Room completes the upload, only while it still owns the
  // message's row and only while its sender is still in the room (the
  // stream can take minutes), then checks and indexes it (streamFinish).
  const doneRes = await stub.streamFinish(id, uploadId, parts, counted, room, owner ? null : { token: invite, member: member });
  if (refused(doneRes)) {
    // replaced meanwhile: this upload is nobody's now
    try { await up.abort(); } catch { /* already completed, aborted or expired */ }
    return json({ error: doneRes.error }, doneRes.status);
  }
  return json({ room: room, id: id, video: { type: doneRes.type, bytes: doneRes.bytes, url: url.origin + "/api/rooms/" + room + "/messages/" + id + "/video?" + (await mediaSigParams(env, room, id, "video")) }, published: !!doneRes.published });
}

// The upload engine (UP_KINDS): start / part / sign / status / finish / abort
// for any kind, with the sender's invite or the owner key. /video/... is
// this same route.
export async function uploadRoute(rc: RouteContext, m: RegExpMatchArray) {
  const { request, env, url, owner, invite } = rc;
  const room = decodeURIComponent(m[1]).toLowerCase();
  if (!ROOM_RE.test(room)) return json({ error: "Room names are 1-64 lowercase letters, digits, - or _" }, 400);
  const id = parseInt(m[2], 10);
  const stub = env.ROOM.get(env.ROOM.idFromName(room));
  const acc = await stub.access(invite, owner);
  if (!acc.ok) return deny(acc);
  const still = async () => { if (owner) return null; const l = await stub.lookupInvite(invite); return l.ok ? null : l; };
  return uploadStep(request, env, url, stub, room, id, m[3], m[4], acc.name || "", owner, still);
}

// Mint an upload ticket for one of your drafts: the REST twin
// of MCP begin_upload for a draft that already exists. The response is
// the only place the raw ticket ever appears.
export async function uploadTicketRoute(rc: RouteContext, m: RegExpMatchArray) {
  const { request, env, url, owner, invite } = rc;
  const room = decodeURIComponent(m[1]).toLowerCase();
  if (!ROOM_RE.test(room)) return json({ error: "Room names are 1-64 lowercase letters, digits, - or _" }, 400);
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const id = parseInt(m[2], 10);
  const stub = env.ROOM.get(env.ROOM.idFromName(room));
  const acc = await stub.access(invite, owner);
  if (!acc.ok) return deny(acc);
  const body = await readBody(request);
  const kind = bodyText(body?.kind, "kind");
  if (UP_KINDS.indexOf(kind) < 0) return json({ error: "\"kind\" must be image, audio, video or file" }, 400);
  const member = acc.name || bodyText(body?.from, "from");
  const sess = uploadSessionWanted(kind, body || {});
  if (sess && sess.error !== undefined) return json({ error: sess.error }, 400);
  const t = await stub.mintUploadTicket(id, kind, member, room, !!owner, sess, invite);
  if (refused(t)) return deny(t);
  return json({ room: room, message_id: id, draft: true, upload: sess ? sessionUpload(url.origin, room, kind, t) : ticketUpload(url.origin, room, t) });
}

// Find one of your draft uploads that can resume: same file size + fingerprint
// as an interrupted attempt, of any kind (or "kind" in the body). Returns the
// draft message id, its kind and the parts received. /video/resume is the
// video-only form.
export async function uploadResumeRoute(rc: RouteContext, m: RegExpMatchArray) {
  const { request, env, owner, invite } = rc;
  const room = decodeURIComponent(m[1]).toLowerCase();
  if (!ROOM_RE.test(room)) return json({ error: "Room names are 1-64 lowercase letters, digits, - or _" }, 400);
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const stub = env.ROOM.get(env.ROOM.idFromName(room));
  const acc = await stub.access(invite, owner);
  if (!acc.ok) return deny(acc);
  const body = await readBody(request);
  const kind = m[2] === "video" ? "video" : (body && UP_KINDS.indexOf(bodyText(body.kind, "kind")) >= 0 ? bodyText(body.kind, "kind") : null);
  const r = await stub.findResumableUpload(acc.name || "", +((body && body.size) || 0), body && body.fingerprint ? bodyText(body.fingerprint, "fingerprint") : null, owner, kind);
  return json({ room: room, found: !!r.found, id: r.id || null, kind: r.kind || null, received: r.received || [], part_size: r.part_size || null, parts: r.parts || null, direct: !!r.direct });
}
