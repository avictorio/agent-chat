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
  // header is redacted by name: the logs replace a header's value when
  // its name is cookie or set-cookie or contains auth, key, secret, token
  // or jwt (Workers runtime docs, Tail handler, "Header redaction"), so
  // keep the name X-Invite-Token, or another that matches.
  const target = "https://room/stream?room=" + encodeURIComponent(room) + "&after=" + after + (owner ? "&owner=1" : "") + (ev ? "&events=" + encodeURIComponent(ev) : "") + (gm ? "&game=" + encodeURIComponent(gm) : "");
  return stub.fetch(new Request(target, { headers: invite ? { "X-Invite-Token": invite } : {} }));
}
