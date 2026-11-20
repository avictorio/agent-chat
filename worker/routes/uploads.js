// Upload requests: streaming a part into R2, the session steps, and the addresses handed to clients and MCP.
// Stream one part's request body into its R2 multipart slot. Nothing is
// buffered: R2 takes the request stream as it is (its length is known
// from Content-Length). With sniff set (part 1 of an image, audio or
// video upload) the first bytes are read and checked before anything is
// stored, then rejoined to the rest through a FixedLengthStream, so a
// wrong kind of file is refused at its first part, not after the whole
// upload. Answers { part } - or { part: null } when the sniff fails.

import { json, readBody } from "../lib/http.js";
import { upSniff, upTypeError } from "../uploads/plan.js";
import { r2DirectConfigured, r2PresignPart } from "../platform/r2-s3.js";
import { AUDIO_MAX, IMAGE_MAX, UP_SIGN_MAX, UP_SIGN_TTL, VIDEO_MAX } from "../limits.js";
import { mediaSigParams } from "../lib/media.js";

export async function streamUploadPart(up, n, body, len, sniff) {
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
    try { for (;;) { const c = await reader.read(); if (c.done) break; } } catch (e) {}
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
      try { await w.abort(e); } catch (e2) {}
      throw e;
    }
  })();
  pump.catch(() => {});
  let part;
  try { part = await up.uploadPart(n, fixed.readable); }
  catch (e) { try { await reader.cancel(); } catch (e2) {} throw e; }
  await pump;
  return { part: part };
}

// The upload engine's five steps over HTTP, shared by the invite-token
// routes (/messages/ID/KIND/STEP) and resumable upload links
// (/api/uploads/ROOM/LINK/STEP, which cannot start: their session
// started when the link was opened).
export async function uploadStep(request, env, url, stub, room, id, kind, step, who, owner) {
  if (step === "part") {
    // A refused part is read away before the answer goes back: a client
    // still sending its body would otherwise see the connection drop
    // instead of the reason.
    const refuse = async (body, status) => {
      if (request.body) { try { await request.body.pipeTo(new WritableStream()); } catch (e) {} }
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
    catch (e) { return json({ error: "Part " + n + " did not reach storage (" + String((e && e.message) || e) + "); send it again" }, 502); }
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
    const urls = {};
    const bytes = {};
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
    const out = { room: room, id: id, kind: kind, published: !!r.published };
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
export function sessionUpload(origin, room, kind, t) {
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
export function uploadSessionWanted(kind, a) {
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
export function ticketUpload(origin, room, t) {
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
