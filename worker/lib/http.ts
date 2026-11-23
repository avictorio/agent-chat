// HTTP helpers shared by the routes and the Room object.

import type { Message, StreamDeleteFrame, StreamGapFrame } from "@chat/contract";

export const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Last-Event-ID, X-Owner-Key, X-Invite-Token, Authorization",
  // response headers a browser client may read beyond the safelisted ones
  "Access-Control-Expose-Headers": "Retry-After, Deprecation, Sunset, Link",
};

export const SSE_HEADERS = Object.assign({
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache",
  "X-Accel-Buffering": "no",
}, CORS);

/** A message's stream frame ("event: message").
 *  @param dn the message's delivery number (its id unless it went live late or was sent again): the "id:" line a reconnect resumes from */
export function sseFrame(room: string | null, m: Message & { targets?: string[] }, dn: number = m.id) {
  return "id: " + dn + "\nevent: message\ndata: " + JSON.stringify({ id: m.id, room: room, ts: m.ts, from: m.from, kind: m.kind || null, targets: m.targets || [], text: m.text, audio: m.audio || null, image: m.image || null, video: m.video || null, html: m.html || null, doc: m.doc || null, file: m.file || null, game: m.game || null, reactions: m.reactions || {} }) + "\n\n";
}

/** @param dn the delete's own delivery number, its "id:" line */
export function deleteFrame(dn: number, data: StreamDeleteFrame) {
  return "id: " + dn + "\nevent: delete\ndata: " + JSON.stringify(data) + "\n\n";
}

/** No id: line: a gap is not a delivery, and a Last-Event-ID taken from
 *  it would move a resume past the replay that follows it. */
export function gapFrame(data: StreamGapFrame) {
  return "event: gap\ndata: " + JSON.stringify(data) + "\n\n";
}

// Parse a single-range Range header against a known size. Returns {start, end, r2}
// (r2 is the options shape the R2 binding takes) or null for anything else - no header,
// a malformed value, or a multi-range - in which case the whole object is served.
export function parseRange(header: string | null | undefined, size: number): { start: number, end: number, r2: { offset: number, length: number } } | null {
  if (!header || !size) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!m || (m[1] === "" && m[2] === "")) return null;
  let start, end;
  if (m[1] === "") { const n = Math.min(parseInt(m[2], 10), size); start = size - n; end = size - 1; }
  else { start = parseInt(m[1], 10); end = m[2] === "" ? size - 1 : Math.min(parseInt(m[2], 10), size - 1); }
  if (isNaN(start) || isNaN(end) || start < 0 || start > end || start >= size) return null;
  return { start: start, end: end, r2: { offset: start, length: end - start + 1 } };
}

/** A JSON answer, compact: indentation made replies up to twice as big.
 *  ?pretty=1 on any request gets it indented (index.ts). */
export function json(data: unknown, status?: number, headers?: Record<string, string>) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: Object.assign({ "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }, CORS, headers || {}),
  });
}

// Error codes: a refusal keeps its sentence and gains a machine-readable
// code beside it. The code is the contract; the sentence may change.
// Today's codes: invite_missing (401), invite_invalid and invite_revoked
// (403), name_taken (409), rate_limited (429, with Retry-After) and
// limit_reached (429, without).

/** A refusal - an access() result, or any {error, status, code} a Room
 *  method returns - as its JSON answer: the sentence, and its code when it
 *  has one. */
export function deny(r: { error?: string, status?: number, code?: string }) {
  return json(r.code ? { error: r.error, code: r.code } : { error: r.error }, r.status);
}

/** 429 for a cap that resets with time: rate_limited, and Retry-After in
 *  seconds. */
export function rateLimited(error: string, retryAfter: number, extra?: Record<string, unknown>) {
  return json(Object.assign({}, extra || {}, { error: error, code: "rate_limited" }), 429, { "Retry-After": String(Math.max(1, Math.ceil(retryAfter))) });
}

/** 429 for a cap on how many can exist at once: limit_reached, and no
 *  Retry-After - one frees up when it finishes, not at a time. */
export function limitReached(error: string) {
  return json({ error: error, code: "limit_reached" }, 429);
}

/** Seconds until the next UTC midnight, when the per-day caps reset. */
export function secondsToUtcMidnight(now?: number) {
  const t = now === undefined ? Date.now() : now;
  const d = new Date(t);
  return Math.max(1, Math.ceil((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) - t) / 1000));
}

export function html(body: string) {
  return new Response(body, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

/** A client's mistake found inside a handler (a body that is not JSON): the
 *  Worker's fetch (index.ts) answers it with a 400 carrying this message. */
export class BadRequest extends Error {}

/** A JSON object from a client - a request body, an object inside one, or
 *  an MCP call's arguments. Its fields are unknown until read with one of
 *  the readers below (or narrowed by hand). */
export type Body = { readonly [field: string]: unknown };

/**
 * The request's JSON body, or null when there is none: an empty body (or
 * JSON null) is fine wherever every field is optional. A body that is not
 * JSON, or is JSON but not an object, throws BadRequest (a 400), so a
 * client with a broken encoder hears about it instead of getting an
 * answer about missing fields.
 */
export async function readBody(request: Request): Promise<Body | null> {
  let text: string;
  try {
    text = await request.text();
  } catch {
    // the body stream broke (the client went away): there is no body to read
    return null;
  }
  return parseBody(text);
}

/** readBody's parse of a body already read as text: null for an empty
 *  body or JSON null, BadRequest (a 400) for anything but a JSON object. */
export function parseBody(text: string): Body | null {
  if (!text.trim()) return null;
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch (e) {
    throw new BadRequest("The request body is not valid JSON (" + String((e as Error).message).slice(0, 160) + "). Send a JSON object, with Content-Type: application/json.");
  }
  if (v === null) return null;
  if (!isObject(v)) throw new BadRequest("The request body must be a JSON object, like {\"text\": \"hi\"}.");
  return v;
}

/**
 * The same request with its body already read: the whole body is taken
 * in first, and the request handed back carries those bytes, so every
 * later read (text, JSON, bytes, a form) returns at once.
 *
 * Why. A route checks the caller's invite and then reads the body, and a
 * client decides when its body arrives. One that sent its headers and
 * held the body back was past the check for as long as it liked: the
 * owner could remove that member - or everyone, or delete the room and
 * make it again - and the request, finished afterwards, still acted
 * under the old name. It posted, moved in games, read the next holder's
 * hand, and minted itself a fresh invite after "revoke everyone". With
 * the body in hand before the route runs, nothing the client controls
 * sits between the check and the act.
 *
 * @returns the request to route; or null when the body is over `cap`
 */
export async function settleBody(request: Request, cap: number): Promise<Request | null> {
  if (!request.body) return request;
  if (Number(request.headers.get("Content-Length")) > cap) return null;
  const chunks: Uint8Array[] = [];
  let broke: unknown = null;
  let size = 0;
  const reader = request.body.getReader();
  try {
    for (;;) {
      const c = await reader.read();
      if (c.done) break;
      size += c.value.byteLength;
      if (size > cap) {
        try { await reader.cancel(); } catch { /* the client went away */ }
        return null;
      }
      chunks.push(c.value);
    }
  } catch (e) {
    // the client went away mid-body: the route sees the same broken body it would have read itself
    broke = e || new Error("the request body broke");
  }
  // the chunks are handed over as they are: nothing is copied, whatever the size
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      if (broke) { controller.error(broke); return; }
      for (const c of chunks) controller.enqueue(c);
      controller.close();
    },
  });
  return new Request(request, { body: body });
}

/** Whether a Room answer refused (any status but 200). Past this check
 *  the type checker knows the answer is the success shape. */
export function refused<T extends { status?: number }>(r: T): r is Extract<T, { error: string }> {
  return r.status !== undefined && r.status !== 200;
}

/** Whether a JSON value is an object (not null, not a list). */
export function isObject(v: unknown): v is Body {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/* Field readers. Each accepts every sensible form of a field and refuses
   only what would turn into nonsense: an object, a list or true/false
   where text is expected, a list where a number is. The refusal is a
   BadRequest naming the field, so a 400 from a route and a tool error
   over MCP. An absent field (undefined or null) reads as empty. */

/** Text: a string as sent, a number as its digits; absent is "". */
export function bodyText(v: unknown, name: string): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  throw new BadRequest("\"" + name + "\" must be text");
}

/** A number: a number, or a string read as one (parseInt for whole
 *  ones); absent is NaN, which each caller turns into its default or its
 *  "is required". */
export function bodyNumber(v: unknown, name: string, whole?: boolean): number {
  if (v === undefined || v === null) return NaN;
  if (typeof v === "number") return whole ? Math.trunc(v) : v;
  if (typeof v === "string") return whole ? parseInt(v, 10) : Number(v);
  throw new BadRequest("\"" + name + "\" must be a number");
}

/** A stamp a write carries (a board write's base_updated: the item's
 *  updated as the caller read it); absent is null. */
export function bodyStamp(v: unknown, name: string): number | null {
  if (v === undefined || v === null || v === "") return null;
  const n = bodyNumber(v, name, true);
  if (!Number.isFinite(n)) throw new BadRequest("\"" + name + "\" must be a number");
  return n;
}

/** An object field (a Body); absent is null. */
export function bodyObject(v: unknown, name: string): Body | null {
  if (v === undefined || v === null) return null;
  if (isObject(v)) return v;
  throw new BadRequest("\"" + name + "\" must be an object");
}

/** A list field; absent is null. */
export function bodyList(v: unknown, name: string): unknown[] | null {
  if (v === undefined || v === null) return null;
  if (Array.isArray(v)) return v as unknown[];
  throw new BadRequest("\"" + name + "\" must be a list");
}
