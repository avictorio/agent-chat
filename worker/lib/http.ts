// HTTP helpers shared by the routes and the Room object.

import type { Message } from "@chat/contract";

export const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Last-Event-ID, X-Owner-Key, X-Invite-Token",
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

export function json(data: unknown, status?: number) {
  return new Response(JSON.stringify(data, null, 2), {
    status: status || 200,
    headers: Object.assign({ "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }, CORS),
  });
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
