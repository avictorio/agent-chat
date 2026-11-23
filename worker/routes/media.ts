// Media routes: avatars and message attachments - setting and attaching them,
// and reads (header or signed URL; never ?invite=).

import {
  AUDIO_MAX,
  AVATAR_MAX,
  IMAGE_MAX,
  MAX_TEXT,
  mb,
  mediaTooBig,
  ROOM_RE,
  STORE_MSG,
  VIDEO_MAX,
} from "../limits.js";
import { CORS, deny, json, readBody, bodyText, refused } from "../lib/http.js";
import { LINK_REFUSED, mediaLink, mediaSigParams, serveMedia } from "../lib/media.js";
import { inlineBytes, sniffAudio, sniffImage, sniffVideo } from "../lib/sniff.js";
import type { RouteContext } from "../index.js";
import { warn } from "../lib/log.js";

// Avatars. Members set their own (invite token); the owner can set or clear anyone's;
// reading takes the header or a signed URL.
export async function avatarRoute(rc: RouteContext, m: RegExpMatchArray) {
  const { request, env, url, owner, invite } = rc;
  const room = decodeURIComponent(m[1]).toLowerCase();
  if (!ROOM_RE.test(room)) return json({ error: "Room names are 1-64 lowercase letters, digits, - or _" }, 400);
  const stub = env.ROOM.get(env.ROOM.idFromName(room));
  if (m[3] !== undefined) {
    if (request.method !== "GET" && request.method !== "HEAD") return json({ error: "Method not allowed" }, 405);
    const acc = await stub.access(invite, owner, mediaLink(url, room, decodeURIComponent(m[3]).toLowerCase(), "avatar"));
    if (!acc.ok) return acc.code === LINK_REFUSED ? json({ error: acc.error }, 403) : deny(acc);
    const a = await stub.getAvatar(decodeURIComponent(m[3]));
    if (!a) return json({ error: "No avatar" }, 404);
    const fresh = url.searchParams.get("v") === String(a.ver);
    const aheaders: Record<string, string> = Object.assign({
      "Content-Type": a.type || "application/octet-stream", "Cache-Control": fresh ? "private, max-age=31536000, immutable" : "private, no-cache",
      "ETag": "\"" + a.ver + "\"", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; sandbox",
    }, CORS);
    // The bytes live in R2 only; stream them from the Worker.
    try {
      if (env.MEDIA) {
        if (request.method === "HEAD") {
          const head = await env.MEDIA.head(a.key);
          if (head) { aheaders["Content-Length"] = String(head.size); return new Response(null, { headers: aheaders }); }
        } else {
          const obj = await env.MEDIA.get(a.key);
          if (obj) { aheaders["Content-Length"] = String(obj.size); return new Response(obj.body, { headers: aheaders }); }
        }
      }
    } catch (e) {
      warn("media.read", e, { room, kind: "avatar" });
    }
    return json({ error: "No avatar" }, 404);
  }
  let who;
  if (m[2] !== undefined) {
    if (!owner) return json({ error: "Changing someone else's avatar needs the owner key" }, 403);
    who = decodeURIComponent(m[2]);
  } else {
    who = await stub.inviter(invite);
    if (!who) return json({ error: "Avatars are for members: send your X-Invite-Token." }, 403);
  }
  if (request.method === "DELETE") {
    if (!(await stub.clearAvatar(who))) return json({ error: "No avatar to remove" }, 404);
    return json({ room, name: who, avatar: null });
  }
  if (request.method !== "PUT" && request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (+(request.headers.get("Content-Length") || 0) > AVATAR_MAX * 1.4 + 1000) return json({ error: "Avatars can be up to " + mb(AVATAR_MAX) }, 413);
  let buf;
  if ((request.headers.get("Content-Type") || "").toLowerCase().includes("json")) {
    const body = await readBody(request);
    const s = String((body && (body.image || body.image_base64)) || "").replace(/^data:[^,]*,/, "").replace(/\s+/g, "");
    const b = inlineBytes(s, AVATAR_MAX);
    if (b === null) return json({ error: "\"image\" must be base64 or a data: URL" }, 400);
    if (b === "too_big") return json({ error: "Avatars can be up to " + mb(AVATAR_MAX) }, 413);
    buf = b;
  } else {
    buf = await request.arrayBuffer();
  }
  if (!buf.byteLength) return json({ error: "Send the image as the request body (or JSON {\"image\": base64})" }, 400);
  if (buf.byteLength > AVATAR_MAX) return json({ error: "Avatars can be up to " + mb(AVATAR_MAX) }, 413);
  const type = sniffImage(buf);
  if (!type) return json({ error: "Avatars must be PNG, JPEG, WebP or GIF" }, 415);
  const ver = await stub.setAvatar(who, buf, type, room);
  if (ver === "STORE_FAIL") return json({ error: STORE_MSG }, 503);
  if (!ver) return json({ error: "No member with that name" }, 404);
  return json({ room, name: who, type, bytes: buf.byteLength, avatar: url.origin + "/api/rooms/" + room + "/avatars/" + encodeURIComponent(who) + "?v=" + ver });
}

// Audio clips attached to messages. Reading takes the header or a signed
// URL; attaching is the sender's own invite or the owner key.
export async function audioRoute(rc: RouteContext, m: RegExpMatchArray) {
  const { request, env, url, owner, invite } = rc;
  const room = decodeURIComponent(m[1]).toLowerCase();
  if (!ROOM_RE.test(room)) return json({ error: "Room names are 1-64 lowercase letters, digits, - or _" }, 400);
  const id = parseInt(m[2], 10);
  const stub = env.ROOM.get(env.ROOM.idFromName(room));
  const read = request.method === "GET" || request.method === "HEAD";
  const acc = await stub.access(invite, owner, read ? mediaLink(url, room, id, "audio") : undefined);
  if (!acc.ok) return acc.code === LINK_REFUSED ? json({ error: acc.error }, 403) : deny(acc);
  if (request.method === "GET" || request.method === "HEAD") {
    return serveMedia(request, env, stub, id, "audio", room, { name: acc.name, owner: owner });
  }
  if (request.method !== "PUT" && request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (+(request.headers.get("Content-Length") || 0) > AUDIO_MAX * 1.4 + 1000) return json({ error: mediaTooBig("audio", "inline") }, 413);
  let buf, putTranscript;
  if ((request.headers.get("Content-Type") || "").toLowerCase().includes("json")) {
    const body = await readBody(request);
    const s = String((body && (body.audio || body.audio_base64)) || "").replace(/^data:[^,]*,/, "").replace(/\s+/g, "");
    const b = inlineBytes(s, AUDIO_MAX);
    if (b === null) return json({ error: "\"audio\" must be base64 or a data: URL" }, 400);
    if (b === "too_big") return json({ error: mediaTooBig("audio", "inline") }, 413);
    buf = b;
    if (body && body.transcript !== undefined) putTranscript = body.transcript ? bodyText(body.transcript, "transcript").slice(0, MAX_TEXT) : null;
  } else {
    buf = await request.arrayBuffer();
  }
  if (!buf.byteLength) return json({ error: "Send the audio as the request body (or JSON {\"audio\": base64})" }, 400);
  if (buf.byteLength > AUDIO_MAX) return json({ error: mediaTooBig("audio", "inline") }, 413);
  const atype = sniffAudio(buf);
  if (!atype) return json({ error: "Audio must be MP3, WAV, OGG, WebM or M4A" }, 415);
  const r = await stub.attachAudio(id, acc.name || "", buf, atype, owner, putTranscript, room);
  if (refused(r)) return json({ error: r.error }, r.status);
  return json({ room, id, audio: { type: r.type, bytes: r.bytes, url: url.origin + "/api/rooms/" + room + "/messages/" + id + "/audio?" + (await mediaSigParams(env, room, id, "audio")) } });
}

// Images attached to messages. Reading takes the header or a signed URL;
// attaching is the sender's own invite or the owner key.
export async function imageRoute(rc: RouteContext, m: RegExpMatchArray) {
  const { request, env, url, owner, invite } = rc;
  const room = decodeURIComponent(m[1]).toLowerCase();
  if (!ROOM_RE.test(room)) return json({ error: "Room names are 1-64 lowercase letters, digits, - or _" }, 400);
  const id = parseInt(m[2], 10);
  const stub = env.ROOM.get(env.ROOM.idFromName(room));
  const read = request.method === "GET" || request.method === "HEAD";
  const acc = await stub.access(invite, owner, read ? mediaLink(url, room, id, "image") : undefined);
  if (!acc.ok) return acc.code === LINK_REFUSED ? json({ error: acc.error }, 403) : deny(acc);
  if (request.method === "GET" || request.method === "HEAD") {
    return serveMedia(request, env, stub, id, "image", room, { name: acc.name, owner: owner });
  }
  if (request.method !== "PUT" && request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (+(request.headers.get("Content-Length") || 0) > IMAGE_MAX * 1.4 + 1000) return json({ error: mediaTooBig("image", "inline") }, 413);
  let buf;
  if ((request.headers.get("Content-Type") || "").toLowerCase().includes("json")) {
    const body = await readBody(request);
    const s = String((body && (body.image || body.image_base64)) || "").replace(/^data:[^,]*,/, "").replace(/\s+/g, "");
    const b = inlineBytes(s, IMAGE_MAX);
    if (b === null) return json({ error: "\"image\" must be base64 or a data: URL" }, 400);
    if (b === "too_big") return json({ error: mediaTooBig("image", "inline") }, 413);
    buf = b;
  } else {
    buf = await request.arrayBuffer();
  }
  if (!buf.byteLength) return json({ error: "Send the image as the request body (or JSON {\"image\": base64})" }, 400);
  if (buf.byteLength > IMAGE_MAX) return json({ error: mediaTooBig("image", "inline") }, 413);
  const itype = sniffImage(buf);
  if (!itype) return json({ error: "Image must be JPEG, PNG, GIF, WebP or AVIF" }, 415);
  const r = await stub.attachImage(id, acc.name || "", buf, itype, owner, room);
  if (refused(r)) return json({ error: r.error }, r.status);
  return json({ room, id, image: { type: r.type, bytes: r.bytes, url: url.origin + "/api/rooms/" + room + "/messages/" + id + "/image?" + (await mediaSigParams(env, room, id, "image")) } });
}

// Videos attached to messages. Same access as images; serving honours Range so
// players can seek. The bytes live in R2 (room/media.ts).
export async function videoRoute(rc: RouteContext, m: RegExpMatchArray) {
  const { request, env, url, owner, invite } = rc;
  const room = decodeURIComponent(m[1]).toLowerCase();
  if (!ROOM_RE.test(room)) return json({ error: "Room names are 1-64 lowercase letters, digits, - or _" }, 400);
  const id = parseInt(m[2], 10);
  const stub = env.ROOM.get(env.ROOM.idFromName(room));
  const read = request.method === "GET" || request.method === "HEAD";
  const acc = await stub.access(invite, owner, read ? mediaLink(url, room, id, "video") : undefined);
  if (!acc.ok) return acc.code === LINK_REFUSED ? json({ error: acc.error }, 403) : deny(acc);
  if (request.method === "GET" || request.method === "HEAD") {
    return serveMedia(request, env, stub, id, "video", room, { name: acc.name, owner: owner });
  }
  if (request.method !== "PUT" && request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (+(request.headers.get("Content-Length") || 0) > VIDEO_MAX * 1.4 + 1000) return json({ error: mediaTooBig("video", "inline") }, 413);
  let buf;
  if ((request.headers.get("Content-Type") || "").toLowerCase().includes("json")) {
    const body = await readBody(request);
    const s = String((body && (body.video || body.video_base64)) || "").replace(/^data:[^,]*,/, "").replace(/\s+/g, "");
    const b = inlineBytes(s, VIDEO_MAX);
    if (b === null) return json({ error: "\"video\" must be base64 or a data: URL" }, 400);
    if (b === "too_big") return json({ error: mediaTooBig("video", "inline") }, 413);
    buf = b;
  } else {
    buf = await request.arrayBuffer();
  }
  if (!buf.byteLength) return json({ error: "Send the video as the request body (or JSON {\"video\": base64})" }, 400);
  if (buf.byteLength > VIDEO_MAX) return json({ error: mediaTooBig("video", "inline") }, 413);
  const vtype = sniffVideo(buf);
  if (!vtype) return json({ error: "Video must be MP4, WebM or MOV" }, 415);
  const r = await stub.attachVideo(id, acc.name || "", buf, vtype, owner, room);
  if (refused(r)) return json({ error: r.error }, r.status);
  return json({ room, id, video: { type: r.type, bytes: r.bytes, url: url.origin + "/api/rooms/" + room + "/messages/" + id + "/video?" + (await mediaSigParams(env, room, id, "video")) } });
}

// HTML artifacts and Markdown documents attached to messages. Reading
// takes the header or a signed URL. The bytes are attached inline at post
// time (fields html / doc on POST /messages); these routes only serve.
// HTML is served with the artifact CSP (see mediaCsp): an opaque origin,
// inline scripts allowed, no network.
// A general file (kind file) is read the same way and always served as
// a download (mediaHeaders); its bytes arrive through the upload engine.
export async function artifactRoute(rc: RouteContext, m: RegExpMatchArray) {
  const { request, env, url, owner, invite } = rc;
  const room = decodeURIComponent(m[1]).toLowerCase();
  if (!ROOM_RE.test(room)) return json({ error: "Room names are 1-64 lowercase letters, digits, - or _" }, 400);
  const id = parseInt(m[2], 10);
  const kind = m[3];
  const stub = env.ROOM.get(env.ROOM.idFromName(room));
  const read = request.method === "GET" || request.method === "HEAD";
  const acc = await stub.access(invite, owner, read ? mediaLink(url, room, id, kind) : undefined);
  if (!acc.ok) return acc.code === LINK_REFUSED ? json({ error: acc.error }, 403) : deny(acc);
  if (kind === "file" && request.method !== "GET" && request.method !== "HEAD") return json({ error: "Files upload in parts: POST /messages/ID/file/start {\"size\", \"name\"} - see UPLOADING FILES in GET /api" }, 405);
  if (request.method !== "GET" && request.method !== "HEAD") return json({ error: "Method not allowed" }, 405);
  return serveMedia(request, env, stub, id, kind, room, { name: acc.name, owner: owner });
}
