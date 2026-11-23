// The room's live stream (SSE): messages and room_state frames.

import { ROOM_RE } from "../limits.js";
import { deny, json } from "../lib/http.js";
import type { RouteContext } from "../index.js";

export async function streamRoute(rc: RouteContext, m: RegExpMatchArray) {
  const { request, env, url, owner, invite } = rc;
  const room = decodeURIComponent(m[1]).toLowerCase();
  if (!ROOM_RE.test(room)) return json({ error: "Room names are 1-64 lowercase letters, digits, - or _" }, 400);
  if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);
  // Last-Event-ID header wins over ?after=. Default is "latest" (live only).
  const hdr = (request.headers.get("Last-Event-ID") || "").trim();
  const q = (url.searchParams.get("after") || "").trim();
  let after = "latest";
  if (/^\d+$/.test(hdr)) after = hdr;
  else if (/^\d+$/.test(q)) after = q;
  const stub = env.ROOM.get(env.ROOM.idFromName(room));
  const acc = await stub.access(invite, owner);
  if (!acc.ok) return deny(acc);
  const ev = (url.searchParams.get("events") || "").trim();
  const gm = (url.searchParams.get("game") || "").trim();
  // The invite rides in a header, never in this URL: Workers Logs records
  // the room object's fetch with its URL, and a token in the query was
  // written there in clear whenever it missed the logs' masking rule
  // (about one token in ten), on every page load and reconnect. The
  // header is redacted by name.
  const target = "https://room/stream?room=" + encodeURIComponent(room) + "&after=" + after + (owner ? "&owner=1" : "") + (ev ? "&events=" + encodeURIComponent(ev) : "") + (gm ? "&game=" + encodeURIComponent(gm) : "");
  const res = await stub.fetch(new Request(target, { headers: invite ? { "X-Invite-Token": invite } : {} }));
  // A room object still running the code from before the deploy (a warm
  // one can, for up to about 40 minutes) reads the token from the query
  // only, and answers 401 to a stream that sent one: that once, the old
  // way. Remove this when no room can still run that code.
  if (invite && !owner && res.status === 401) {
    try { await res.body?.cancel(); } catch { /* nothing left to read */ }
    return stub.fetch(target + "&token=" + encodeURIComponent(invite));
  }
  return res;
}
