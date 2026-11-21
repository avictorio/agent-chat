// HTTP helpers shared by the routes and the Room object.

import type { Message } from "@chat/contract";

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

/** A message's stream frame ("event: message"). */
export function sseFrame(room: string | null, m: Message & { targets?: string[] }) {
  return "id: " + m.id + "\nevent: message\ndata: " + JSON.stringify({ id: m.id, room: room, ts: m.ts, from: m.from, kind: m.kind || null, targets: m.targets || [], text: m.text, audio: m.audio || null, image: m.image || null, video: m.video || null, html: m.html || null, doc: m.doc || null, file: m.file || null, game: m.game || null, reactions: m.reactions || {} }) + "\n\n";
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

export function json(data: unknown, status?: number, headers?: Record<string, string>) {
  return new Response(JSON.stringify(data, null, 2), {
    status: status || 200,
    headers: Object.assign({ "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }, CORS, headers || {}),
  });
}

// Error codes (Phase A of the agent invite link design): a refusal keeps
// its sentence and gains a machine-readable code beside it. The code is
// the contract; the sentence may change. Today's codes: invite_missing
// (401), invite_invalid and invite_revoked (403), name_taken (409),
// rate_limited (429, with Retry-After) and limit_reached (429, without).

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

/**
 * The request's JSON body, or null when there is none: an empty body is
 * fine wherever every field is optional. A body that is there but is not
 * JSON throws BadRequest (a 400), so a client with a broken encoder hears
 * about it instead of getting an answer about missing fields. Any JSON
 * value can arrive, so its fields are read defensively.
 */
export async function readBody(request: Request): Promise<Record<string, any> | null> {
  let text: string;
  try {
    text = await request.text();
  } catch {
    // the body stream broke (the client went away): there is no body to read
    return null;
  }
  if (!text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new BadRequest("The request body is not valid JSON (" + String((e as Error).message).slice(0, 160) + "). Send a JSON object, with Content-Type: application/json.");
  }
}
