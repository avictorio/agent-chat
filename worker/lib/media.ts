// Media URLs and serving: per-room signatures, CSP, headers, ranges.

import { b64urlDecode, b64urlEncode, hmacSha256 } from "./crypto.js";
import { CORS, json, parseRange } from "./http.js";
import type { MediaViewer } from "../room/media.js";

// Signed media URLs (media plan phase E): media reads accept a
// short-lived signature instead of a credential:
// sig = base64url(HMAC-SHA256(room key, room|id|kind|exp)), exp a unix
// timestamp on an hour grid, one to two hours out (the grid keeps the
// URL - and so the browser's cache entry - stable within the hour).
// The room key is 32 random bytes kept in the room's own cfg
// (media_sig_key; room/media.ts), so there is no site-wide secret to
// rotate. The HMAC is lib/crypto.ts's synchronous one. Header auth keeps
// working on the same routes (?invite= no longer authenticates media
// reads); signatures are what listings, frames and the web app use.
/**
 * @param id a message id, or "match.n" for a Sketch & Guess drawing
 * @param exp unix seconds
 */
export function mediaSig(keyBytes: Uint8Array, room: string | null | undefined, id: number | string, kind: string, exp: number) {
  return b64urlEncode(hmacSha256(keyBytes, new TextEncoder().encode(room + "|" + id + "|" + kind + "|" + exp)));
}

// The Worker verifies signatures with the room's key, fetched from the
// room object once and cached in the isolate for a minute.
export const _mediaKeyCache: Map<string, { bytes: Uint8Array, at: number }> = new Map();

export async function roomMediaKeyBytes(env: Env, room: string): Promise<Uint8Array | null> {
  const hit = _mediaKeyCache.get(room);
  if (hit && Date.now() - hit.at < 60000) return hit.bytes;
  const stub = env.ROOM.get(env.ROOM.idFromName(room));
  const b64 = await stub.mediaSigKey();
  if (!b64) return null;
  const bytes = b64urlDecode(b64);
  _mediaKeyCache.set(room, { bytes: bytes, at: Date.now() });
  return bytes;
}

export async function mediaSigParams(env: Env, room: string, id: number | string, kind: string) {
  const key = await roomMediaKeyBytes(env, room);
  if (!key) return "";
  // Same hour grid as the Room's mediaQuery, so a URL minted here is
  // byte-identical to the one listings carry (and hits the same
  // browser cache entry).
  const exp = (Math.floor(Date.now() / 3600000) + 2) * 3600;
  return "exp=" + exp + "&sig=" + mediaSig(key, room, id, kind, exp);
}

// Tri-state for read routes: "none" (no signature params - fall through
// to credential auth), "ok" (serve), "bad" (params present but invalid
// or expired - the route answers 403).
export async function mediaSigState(env: Env, room: string, id: number | string, kind: string, url: URL) {
  const exp = url.searchParams.get("exp");
  const sig = url.searchParams.get("sig");
  if (!exp || !sig) return "none";
  const e = parseInt(exp, 10);
  if (!e || e < Math.floor(Date.now() / 1000)) return "bad";
  const key = await roomMediaKeyBytes(env, room);
  if (!key) return "bad";
  return mediaSig(key, room, id, kind, e) === sig ? "ok" : "bad";
}

// The CSP served with a media object. Ordinary media is fully locked down.
// An HTML artifact is a self-contained page a member chose to share: it may
// run its own inline scripts and styles and use data: images, but it gets an
// opaque origin (the sandbox flags, echoed by the embedding iframe) and no
// network access at all, so it can never reach the room API, the page around
// it, or anywhere else.
export function mediaCsp(kind: string) {
  if (kind === "html") return "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:; connect-src 'none'; sandbox allow-scripts";
  return "default-src 'none'; sandbox";
}

// The headers every media response carries. A general file (kind file)
// is only ever a download: octet-stream, Content-Disposition attachment
// under its own name, nosniff and the locked-down CSP, so no file - an
// .html, an .svg, a PDF - is ever rendered as a page on this origin.
export function mediaHeaders(kind: string, type: string, name: string | null | undefined) {
  const h: Record<string, string> = {
    "Content-Type": kind === "file" ? "application/octet-stream" : type, "Cache-Control": MEDIA_CACHE,
    "X-Content-Type-Options": "nosniff", "Content-Security-Policy": mediaCsp(kind),
    "Accept-Ranges": "bytes",
  };
  if (kind === "file") h["Content-Disposition"] = attachmentDisposition(name || "file");
  return Object.assign(h, CORS);
}

// RFC 6266: an ASCII fallback name plus the exact UTF-8 one (RFC 5987).
export function attachmentDisposition(name: string) {
  const ascii = String(name).replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_") || "file";
  const exact = encodeURIComponent(String(name)).replace(/['()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
  return "attachment; filename=\"" + ascii + "\"; filename*=UTF-8''" + exact;
}

// Media bytes under a message are effectively immutable once published,
// and the signed URL is stable for an hour at a time (mediaQuery), so
// browsers may keep a copy for an hour instead of re-downloading on
// every render. private: the signed URL is a capability - no shared
// cache may store it.
export const MEDIA_CACHE = "private, max-age=3600, immutable";

// Stream one media object to the client. The fast path reads R2 directly here in
// the Worker (the Room only supplies the index row), so even a 5 GB video never
// materializes inside the Durable Object. If that direct read fails, the Room's
// own buffered R2 read (getMedia) is the second try; there is no in-DB copy
// (phase B).
/** @param stub the room */
export async function serveMedia(request: Request, env: Env, stub: DurableObjectStub, id: number, kind: string, room: string, viewer: MediaViewer) {
  const meta = await stub.mediaMeta(id, kind, viewer);
  if (meta && meta.r2key && env.MEDIA) {
    try {
      const rr = parseRange(request.headers.get("Range"), meta.size);
      if (request.method === "HEAD") {
        const head = await env.MEDIA.head(meta.r2key);
        if (head) {
          const a = { type: meta.type, size: meta.size, name: meta.name, partial: !!rr, start: rr ? rr.start : 0, end: rr ? rr.end : meta.size - 1, data: null };
          return mediaResponse(request, a, kind);
        }
      } else {
        const obj = await env.MEDIA.get(meta.r2key, rr ? { range: rr.r2 } : {});
        if (obj) {
          const headers = mediaHeaders(kind, meta.type, meta.name);
          if (rr) {
            headers["Content-Range"] = "bytes " + rr.start + "-" + rr.end + "/" + meta.size;
            headers["Content-Length"] = String(rr.end - rr.start + 1);
            return new Response(obj.body, { status: 206, headers: headers });
          }
          headers["Content-Length"] = String(meta.size);
          return new Response(obj.body, { headers: headers });
        }
      }
    } catch (e) {}
  }
  const a = await stub.getMedia(id, kind, request.headers.get("Range"), viewer);
  if (!a) return json({ error: "No " + kind + " on that message" }, 404);
  return mediaResponse(request, a, kind);
}

// Serve one media object (from the Room's media layer) with Range support, so audio
// and video players can seek. The object carries the bytes for the requested range.
/** One media object's bytes (or none, for a HEAD) and how they sit in the
 *  whole: a range when partial, start and end inclusive. */
export type MediaBytes = { type: string, size: number, name: string | null, partial: boolean, start: number, end: number, data: ArrayBuffer | null };
export function mediaResponse(request: Request, a: MediaBytes, kind: string) {
  const headers = mediaHeaders(kind, a.type, a.name);
  if (a.partial) {
    headers["Content-Range"] = "bytes " + a.start + "-" + a.end + "/" + a.size;
    headers["Content-Length"] = String(a.end - a.start + 1);
    return new Response(request.method === "HEAD" ? null : a.data, { status: 206, headers: headers });
  }
  headers["Content-Length"] = String(a.size);
  return new Response(request.method === "HEAD" ? null : a.data, { headers: headers });
}
