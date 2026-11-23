// Media URLs and serving: per-room signatures, CSP, headers, ranges.

import { b64urlDecode, b64urlEncode, hmacSha256 } from "./crypto.js";
import { CORS, json, parseRange } from "./http.js";
import type { MediaViewer } from "../room/media.js";
import { warn } from "./log.js";

// Signed media URLs: media reads accept a short-lived signature instead
// of a credential: sig = base64url(HMAC-SHA256(room key, room|id|kind|exp)),
// exp a unix timestamp on an hour grid, one to two hours out. The grid
// keeps the URL, and so the browser's cache entry, stable within the hour.
// The room key is 32 random bytes in the room's own cfg (media_sig_key;
// room/media.ts), so there is no site-wide secret to rotate. Header auth
// works on the same routes; signatures are what listings, frames and the
// web app use.
/**
 * @param id a message id, or "match.n" for a Sketch & Guess drawing
 * @param exp unix seconds
 */
export function mediaSig(keyBytes: Uint8Array, room: string | null | undefined, id: number | string, kind: string, exp: number) {
  return b64urlEncode(hmacSha256(keyBytes, new TextEncoder().encode(room + "|" + id + "|" + kind + "|" + exp)));
}

// A signed link is checked by the room itself, against its key as it is
// now (access(), with the link): the Worker used to keep each room's key
// for a minute, and that copy outlived a room's delete - an old room's
// links went on opening the files of a room created again under the name
// (the same ids, kinds and so signatures), while the new room's own links
// answered 403. The check rides the access() call each read already makes.
/** A media read's signature, as access() takes it. */
export type MediaLink = { room: string, id: number | string, kind: string, exp: string, sig: string };
/** The code access() refuses a bad or expired link with; each route words
 *  that 403 itself. */
export const LINK_REFUSED = "media_link_invalid";

/** The URL's exp and sig for access() to check, or undefined when it has none. */
export function mediaLink(url: URL, room: string, id: number | string, kind: string): MediaLink | undefined {
  const exp = url.searchParams.get("exp");
  const sig = url.searchParams.get("sig");
  if (!exp || !sig) return undefined;
  return { room: room, id: id, kind: kind, exp: exp, sig: sig };
}

/** Whether a link is good under these key bytes: unexpired, and signed
 *  for this room, id and kind. */
export function mediaLinkOk(keyBytes: Uint8Array, link: MediaLink) {
  const e = parseInt(link.exp, 10);
  if (!e || e < Math.floor(Date.now() / 1000)) return false;
  return mediaSig(keyBytes, link.room, link.id, link.kind, e) === link.sig;
}

// Links the Worker mints itself (attach answers, avatars in a members
// list) take the key from the room each time, for the same reason: a
// copy kept from before a delete signed links the room created since
// refuses. One read serves a whole list.
/** A signer for this room's media, or null when the room has no key (it does not exist). */
export async function mediaSigner(env: Env, room: string): Promise<((id: number | string, kind: string) => string) | null> {
  const stub = env.ROOM.get(env.ROOM.idFromName(room));
  const b64 = await stub.mediaSigKey();
  if (!b64) return null;
  const key = b64urlDecode(b64);
  // Same hour grid as the Room's mediaQuery, so a URL minted here is
  // byte-identical to the one listings carry (and hits the same
  // browser cache entry).
  const exp = (Math.floor(Date.now() / 3600000) + 2) * 3600;
  return (id, kind) => "exp=" + exp + "&sig=" + mediaSig(key, room, id, kind, exp);
}

/** @param ver the stored file's version (md.at), put after the signature
 *  as listings put it (Room.mediaQuery), so an attach or finish answer's
 *  url is the one the next listing carries. Without it the two differed
 *  while the file was the same, and a client comparing urls to spot a new
 *  file saw one that was not there. */
export async function mediaSigParams(env: Env, room: string, id: number | string, kind: string, ver?: number | null) {
  const sign = await mediaSigner(env, room);
  return sign ? sign(id, kind) + (ver ? "&v=" + ver : "") : "";
}

// The CSP served with a media object. Ordinary media is fully locked down.
// An HTML artifact is a self-contained page a member chose to share: it may
// run its own inline scripts and styles and use data: images, but it gets an
// opaque origin (the sandbox flags, echoed by the embedding iframe) and can
// fetch and load nothing, so it can never reach the room API or the page
// around it. Two ways out are closed elsewhere, not here: navigating its own
// frame to another site (the app shell's frame-src, SHELL_CSP in
// routes/pages.ts) and running top-level on the site's address (mediaHeaders
// makes that a download). One stays open: no browser lets a CSP stop WebRTC,
// so a page's script can still send packets (STUN) to a host it names.
export function mediaCsp(kind: string) {
  if (kind === "html") return "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:; connect-src 'none'; frame-ancestors 'self'; sandbox allow-scripts";
  return "default-src 'none'; sandbox";
}

// The headers every media response carries. A general file (kind file)
// is only ever a download: octet-stream, Content-Disposition attachment
// under its own name, nosniff and the locked-down CSP, so no file - an
// .html, an .svg, a PDF - is ever rendered as a page on this origin.
// An HTML page renders only inside a frame (pageOpenedOutsideFrame).
export function mediaHeaders(request: Request, kind: string, type: string, name: string | null | undefined) {
  const h: Record<string, string> = {
    "Content-Type": kind === "file" ? "application/octet-stream" : type, "Cache-Control": MEDIA_CACHE,
    "X-Content-Type-Options": "nosniff", "Content-Security-Policy": mediaCsp(kind),
    "Accept-Ranges": "bytes",
  };
  if (kind === "file") h["Content-Disposition"] = attachmentDisposition(name || "file");
  if (kind === "html") {
    if (pageOpenedOutsideFrame(request)) h["Content-Disposition"] = attachmentDisposition(pageFileName(name));
    // The answer depends on how the browser asked: without Vary, the copy
    // a frame cached for the hour would be reused when the same link is
    // opened in a tab.
    h["Vary"] = "Sec-Fetch-Dest";
  }
  return Object.assign(h, CORS);
}

// A signed page link needs no credential, so anyone it reached could open
// it in a tab: the member's page then ran its script top-level on the
// site's own address, where it could imitate the site, ask for an invite
// link or the owner key, and forward the tab anywhere. Opened by a browser
// as a document (or an object or embed), it is now a download; a frame
// (the room's card and viewer) still renders it, and so does a read that
// is not a navigation (an agent's GET, a fetch). A browser too old to send
// Sec-Fetch-Dest still gets the page inline.
export function pageOpenedOutsideFrame(request: Request) {
  const dest = request.headers.get("Sec-Fetch-Dest");
  return !!dest && dest !== "iframe" && dest !== "frame" && dest !== "empty";
}

function pageFileName(name: string | null | undefined) {
  const n = String(name || "page").trim() || "page";
  return /\.html?$/i.test(n) ? n : n + ".html";
}

// RFC 6266: an ASCII fallback name plus the exact UTF-8 one (RFC 5987).
export function attachmentDisposition(name: string) {
  const ascii = String(name).replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_") || "file";
  const exact = encodeURIComponent(String(name)).replace(/['()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
  return "attachment; filename=\"" + ascii + "\"; filename*=UTF-8''" + exact;
}

// A message's media URL names one stored file: it is stable for an hour
// at a time (mediaQuery) and its v= changes when the file is replaced,
// so browsers may keep a copy for an hour instead of re-downloading on
// every render. private: the signed URL is a capability - no shared
// cache may store it.
export const MEDIA_CACHE = "private, max-age=3600, immutable";

// Stream one media object to the client. The fast path reads R2 directly here in
// the Worker (the Room only supplies the index row), so even a 5 GB video never
// materializes inside the Durable Object. If that direct read fails, the Room's
// own buffered R2 read (getMedia) is the second try; there is no in-DB copy.
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
          const headers = mediaHeaders(request, kind, meta.type, meta.name);
          if (rr) {
            headers["Content-Range"] = "bytes " + rr.start + "-" + rr.end + "/" + meta.size;
            headers["Content-Length"] = String(rr.end - rr.start + 1);
            return new Response(obj.body, { status: 206, headers: headers });
          }
          headers["Content-Length"] = String(meta.size);
          return new Response(obj.body, { headers: headers });
        }
      }
    } catch (e) {
      // the Room's own buffered read below is the second try
      warn("media.read", e, { room, id, kind });
    }
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
  const headers = mediaHeaders(request, kind, a.type, a.name);
  if (a.partial) {
    headers["Content-Range"] = "bytes " + a.start + "-" + a.end + "/" + a.size;
    headers["Content-Length"] = String(a.end - a.start + 1);
    return new Response(request.method === "HEAD" ? null : a.data, { status: 206, headers: headers });
  }
  headers["Content-Length"] = String(a.size);
  return new Response(request.method === "HEAD" ? null : a.data, { headers: headers });
}
