// Upload requests: streaming a part into R2, the session steps, and the addresses handed to clients and MCP.

import { deny, json, readBody } from "../lib/http.js";
import { upSniff, upTypeError } from "../uploads/plan.js";
import { r2DirectConfigured, r2PresignPart } from "../platform/r2-s3.js";
import {
  AUDIO_MAX,
  IMAGE_MAX,
  ROOM_RE,
  STREAM_PART,
  UP_KINDS,
  UP_SIGN_MAX,
  UP_SIGN_TTL,
  VIDEO_MAX,
  VIDEO_MAX_HARD,
} from "../limits.js";
import { mediaSigParams } from "../lib/media.js";
import { sniffVideo } from "../lib/sniff.js";
import type { RouteContext } from "../index.js";
import { warn } from "../lib/log.js";

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
export async function uploadStep(request: Request, env: Env, url: URL, stub: DurableObjectStub, room: string, id: number, kind: string, step: string, who: string | null | undefined, owner: boolean) {
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
    if (t.status !== 200) return refuse(t.expected ? { error: t.error, expected_bytes: t.expected } : { error: t.error }, t.status);
    let res;
    try { res = await streamUploadPart(env.MEDIA.resumeMultipartUpload(t.key, t.upload_id), n, request.body, len, t.sniff ? upSniff(kind) : null); }
    catch (e) { return json({ error: "Part " + n + " did not reach storage (" + String((e && (e as Error).message) || e) + "); send it again" }, 502); }
    if (!res.part) return json({ error: upTypeError(kind) + " (checked from the first bytes of part 1); nothing was stored" }, 415);
    const d = await stub.uploadPartDone(id, kind, t.upload_id, n, res.part.etag);
    if (d.status !== 200) return json({ error: d.error }, d.status);
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
    if (t.status !== 200) return json({ error: t.error }, t.status);
    if (!r2DirectConfigured(env)) return json({ error: "Direct uploads are not configured right now; send the parts through the site (PUT /part?n=N) if they fit, or try again later" }, 503);
    /** each part's address */
    const urls: Record<number, string> = {};
    /** each part's length */
    const bytes: Record<number, number> = {};
    for (const p of t.parts) { urls[p.n] = await r2PresignPart(env, t.key, t.upload_id, p.n, UP_SIGN_TTL); bytes[p.n] = p.bytes; }
    return json({ room: room, id: id, kind: kind, method: "PUT", urls: urls, bytes: bytes, expires_at: new Date(Date.now() + UP_SIGN_TTL * 1000).toISOString(), note: "PUT each part's raw bytes to its url - no other headers, no credential. Then status / finish as usual." });
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
    const r = await stub.uploadStart(id, kind, who, owner, room, body && body.size, body && body.type, body && body.name, body && body.fingerprint ? String(body.fingerprint) : null, direct);
    if (r.status !== 200) return json({ error: r.error }, r.status);
    return json({ room: room, id: id, kind: kind, part_size: r.part_size, parts: r.parts, resumed: !!r.resumed, received: r.received, direct: !!r.direct, expires_at: new Date(r.expires_at).toISOString() });
  }
  if (step === "finish") {
    const r = await stub.uploadFinish(id, kind, who, owner, room, { transcript: body ? body.transcript : undefined });
    if (r.status !== 200) return json(r.missing ? { error: r.error, missing: r.missing } : { error: r.error }, r.status);
    /** the answer, with the media under its kind */
    const out: Record<string, any> = { room: room, id: id, kind: kind, published: !!r.published };
    out[kind] = { type: r.type, bytes: r.bytes, url: url.origin + "/api/rooms/" + room + "/messages/" + id + "/" + kind + "?" + (await mediaSigParams(env, room, id, kind)) };
    if (kind === "file") out[kind].name = r.name;
    return json(out);
  }
  const r = await stub.uploadAbort(id, kind, who, owner);
  if (r.status !== 200) return json({ error: r.error }, r.status);
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
    note: (t.direct ? "Parts go straight to storage: POST sign.url with {\"parts\": [n, ...]} (up to " + UP_SIGN_MAX + " at a time) for each part's address, good for an hour, and PUT the part's raw bytes there with no other headers. " : "") + "PUT part n (1.." + t.parts + ") " + (t.direct ? "to its signed address" : "to part.url with {n} replaced") + ": bytes [(n-1)*part_size, n*part_size) of the file, so every part is exactly part_size bytes except the last (the remainder). Parts may go in any order and in parallel; re-send any that fails. GET status lists the parts received; POST finish once all are in (409 with the missing part numbers otherwise). From a shell: dd if=FILE bs=" + t.part_size + " skip=$((n-1)) count=1 2>/dev/null | curl -X PUT --data-binary @- \"<part url>\". Then publish_message with message_id - unless publish_on_complete is set. No invite token or other credential: these URLs authorize this one upload until expires_at."
  };
}

// Does an upload-link request want a resumable session? Yes for a file
// (always) and for any kind given a size past its single-shot cap.
// Answers null (single-shot), { size, type, name } or { error }.
/** @param a the request's fields (a JSON body or MCP arguments) */
export function uploadSessionWanted(kind: string, a: Record<string, any>) {
  const has = a.size !== undefined && a.size !== null && a.size !== "";
  if (!has) return kind === "file" ? { error: "\"size\" (the file's exact length in bytes) is required for kind file" } : null;
  const size = Math.floor(Number(a.size));
  if (!Number.isFinite(size) || size < 1) return { error: "\"size\" must be the file's exact length in bytes" };
  const cap = kind === "image" ? IMAGE_MAX : kind === "audio" ? AUDIO_MAX : kind === "video" ? VIDEO_MAX : 0;
  if (kind !== "file" && size <= cap) return null;
  return { size: size, type: a.type ? String(a.type) : null, name: a.name ? String(a.name) : null, direct: a.direct === true || a.direct === "true" };
}

// The upload object begin_upload and the REST upload-ticket route hand out
// (media plan phase C). The URL is the credential: single-use, short-lived,
// and the only place the raw ticket exists outside the client's hands.
export function ticketUpload(origin: string, room: string, t: UploadTicket) {
  return {
    method: "PUT",
    url: origin + "/api/uploads/" + room + "/" + t.ticket,
    headers: { "Content-Type": "<the file's media type>" },
    auth: "none - the URL is the credential",
    single_use: true,
    expires_at: new Date(t.expires).toISOString(),
    max_bytes: t.max_bytes,
    note: "PUT the raw file bytes to url. No invite token or other credential: the URL itself authorizes this one upload, until expires_at. Then call publish_message with message_id."
  };
}

// Resumable upload links: the upload engine's part / sign / status /
// finish / abort steps with the link as the credential, for one session.
/** @param usm the path's match */
export async function uploadLinkStepRoute(rc: RouteContext, usm: RegExpMatchArray) {
  const { request, env, url } = rc;
  const uroom = decodeURIComponent(usm[1]).toLowerCase();
  if (!ROOM_RE.test(uroom)) return json({ error: "Room names are 1-64 lowercase letters, digits, - or _" }, 400);
  const ustub = env.ROOM.get(env.ROOM.idFromName(uroom));
  const st = await ustub.uploadSessionTicket(decodeURIComponent(usm[2]));
  if (st.status !== 200) {
    if (request.body) { try { await request.body.pipeTo(new WritableStream()); } catch { /* the client went away mid-body */ } }
    return json({ error: st.error }, st.status);
  }
  return uploadStep(request, env, url, ustub, uroom, st.msg, st.kind, usm[3], st.member, false);
}

// Upload tickets (phase C): PUT /api/uploads/ROOM/TICKET redeems a
// begin_upload ticket. Deliberately NO access check: the ticket is the
// credential (single-use, 15 minutes, hash-only at rest). The ticket is
// never echoed back in any response.
/** @param um the path's match */
export async function uploadLinkRoute(rc: RouteContext, um: RegExpMatchArray) {
  const { request, env } = rc;
  const uroom = decodeURIComponent(um[1]).toLowerCase();
  if (!ROOM_RE.test(uroom)) return json({ error: "Room names are 1-64 lowercase letters, digits, - or _" }, 400);
  if (request.method !== "PUT") return json({ error: "Method not allowed" }, 405);
  if (+(request.headers.get("Content-Length") || 0) > VIDEO_MAX * 1.4 + 1000) return json({ error: "Videos can be up to 25 MB on a single-shot upload; larger files go through the upload engine (begin_upload with size)" }, 413);
  const ubuf = await request.arrayBuffer();
  const ustub = env.ROOM.get(env.ROOM.idFromName(uroom));
  const ur = await ustub.redeemUpload(decodeURIComponent(um[2]), ubuf, uroom);
  if (ur.status !== 200) return json({ error: ur.error }, ur.status);
  return json({ room: uroom, ok: true, type: ur.type, bytes: ur.bytes, published: ur.published });
}

// Whole-file streaming ingest: ONE PUT carrying the entire video (the edge
// refuses request bodies over 100 MB, so in practice up to that; bigger
// files use the upload engine), for a client that can send a file in one
// request. The Worker assembles
// R2 multipart parts as the bytes arrive; nothing holds the whole file.
/** @param m the path's match */
export async function videoStreamRoute(rc: RouteContext, m: RegExpMatchArray) {
  const { request, env, url, owner, invite } = rc;
  const room = decodeURIComponent(m[1]).toLowerCase();
  if (!ROOM_RE.test(room)) return json({ error: "Room names are 1-64 lowercase letters, digits, - or _" }, 400);
  if (request.method !== "PUT") return json({ error: "Method not allowed" }, 405);
  const id = parseInt(m[2], 10);
  const stub = env.ROOM.get(env.ROOM.idFromName(room));
  const acc = await stub.access(invite, owner);
  if (!acc.ok) return deny(acc);
  if (!env.MEDIA) return json({ error: "The R2 binding (MEDIA) is not configured" }, 501);
  if (!request.body) return json({ error: "Missing upload body" }, 400);
  const declared = +(request.headers.get("Content-Length") || 0) || VIDEO_MAX_HARD;
  const begun = await stub.streamBegin(id, acc.name || "", request.headers.get("Content-Type") || "video/mp4", declared, owner, room);
  if (begun.status !== 200) return json({ error: begun.error }, begun.status);
  const key = begun.key, uploadId = begun.uploadId;
  const up = env.MEDIA.resumeMultipartUpload(key, uploadId);
  const fail = async (status: number, error: string) => {
    try { await up.abort(); } catch { /* already completed, aborted or expired */ }
    // streamAbort deletes the object too, but only while this upload
    // still owns the message's row: the key is shared with any newer one
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
  const reader = request.body.getReader();
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      const value = chunk.value;
      if (value && value.byteLength) {
        counted += value.byteLength;
        if (counted > VIDEO_MAX_HARD) return await fail(413, "Videos can be up to 5 GB");
        bufs.push(value); buflen += value.byteLength;
        while (buflen >= STREAM_PART) { const p = await up.uploadPart(++n, take(STREAM_PART)); parts.push({ partNumber: n, etag: p.etag }); }
      }
    }
    if (buflen > 0) { const p = await up.uploadPart(++n, take(buflen)); parts.push({ partNumber: n, etag: p.etag }); }
    if (!parts.length) return await fail(400, "Empty upload");
    await up.complete(parts);
  } catch (e) {
    return await fail(502, "Upload stream failed: " + String((e && (e as Error).message) || e));
  }
  let head = null as { size: number } | null, sniffed = null as string | null;
  try { head = await env.MEDIA.head(key); } catch (e) { warn("upload.head", e, { room, id }); }
  if (head && head.size === counted) {
    try { const obj = await env.MEDIA.get(key, { range: { offset: 0, length: 16 } }); if (obj) sniffed = sniffVideo(await obj.arrayBuffer()); } catch (e) { warn("upload.sniff", e, { room, id }); }
  }
  if (!head || head.size !== counted || !sniffed) return await fail(400, "The uploaded bytes do not check out as that video; upload discarded");
  const doneRes = await stub.streamComplete(id, counted, sniffed, room, uploadId);
  if (doneRes.status !== 200) return json({ error: doneRes.error }, doneRes.status);
  return json({ room: room, id: id, video: { type: sniffed, bytes: counted, url: url.origin + "/api/rooms/" + room + "/messages/" + id + "/video?" + (await mediaSigParams(env, room, id, "video")) }, published: !!doneRes.published });
}

// The upload engine (UP_KINDS): start / part / sign / status / finish / abort
// for any kind, with the sender's invite or the owner key. /video/...
// was the first chunked flow (video only); it is this same route.
/** @param m the path's match */
export async function uploadRoute(rc: RouteContext, m: RegExpMatchArray) {
  const { request, env, url, owner, invite } = rc;
  const room = decodeURIComponent(m[1]).toLowerCase();
  if (!ROOM_RE.test(room)) return json({ error: "Room names are 1-64 lowercase letters, digits, - or _" }, 400);
  const id = parseInt(m[2], 10);
  const stub = env.ROOM.get(env.ROOM.idFromName(room));
  const acc = await stub.access(invite, owner);
  if (!acc.ok) return deny(acc);
  return uploadStep(request, env, url, stub, room, id, m[3], m[4], acc.name || "", owner);
}

// Mint an upload ticket for one of your drafts (phase C): the REST twin
// of MCP begin_upload for a draft that already exists. The response is
// the only place the raw ticket ever appears.
/** @param m the path's match */
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
  const kind = String((body && body.kind) || "");
  if (UP_KINDS.indexOf(kind) < 0) return json({ error: "\"kind\" must be image, audio, video or file" }, 400);
  const member = acc.name || String((body && body.from) || "");
  const sess = uploadSessionWanted(kind, body || {});
  if (sess && sess.error) return json({ error: sess.error }, 400);
  const t = await stub.mintUploadTicket(id, kind, member, room, !!owner, sess);
  if (t.status !== 200) return deny(t);
  return json({ room: room, message_id: id, draft: true, upload: sess ? sessionUpload(url.origin, room, kind, t) : ticketUpload(url.origin, room, t) });
}

// Find one of your draft uploads that can resume: same file size + fingerprint
// as an interrupted attempt, of any kind (or "kind" in the body). Returns the
// draft message id, its kind and the parts received. /video/resume is the
// first, video-only form.
/** @param m the path's match */
export async function uploadResumeRoute(rc: RouteContext, m: RegExpMatchArray) {
  const { request, env, owner, invite } = rc;
  const room = decodeURIComponent(m[1]).toLowerCase();
  if (!ROOM_RE.test(room)) return json({ error: "Room names are 1-64 lowercase letters, digits, - or _" }, 400);
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const stub = env.ROOM.get(env.ROOM.idFromName(room));
  const acc = await stub.access(invite, owner);
  if (!acc.ok) return deny(acc);
  const body = await readBody(request);
  const kind = m[2] === "video" ? "video" : (body && UP_KINDS.indexOf(String(body.kind)) >= 0 ? String(body.kind) : null);
  const r = await stub.findResumableUpload(acc.name || "", +((body && body.size) || 0), body && body.fingerprint ? String(body.fingerprint) : null, owner, kind);
  return json({ room: room, found: !!r.found, id: r.id || null, kind: r.kind || null, received: r.received || [], part_size: r.part_size || null, parts: r.parts || null, direct: !!r.direct });
}
