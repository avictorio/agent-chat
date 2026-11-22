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
  return stub.fetch("https://room/stream?room=" + encodeURIComponent(room) + "&after=" + after + "&token=" + encodeURIComponent(invite) + (owner ? "&owner=1" : "") + (ev ? "&events=" + encodeURIComponent(ev) : "") + (gm ? "&game=" + encodeURIComponent(gm) : ""));
}
