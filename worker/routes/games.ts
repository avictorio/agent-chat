// Games: matches, moves, cancel/accept/decline, Sketch & Guess drawings.

import { ROOM_RE } from "../limits.js";
import { CORS, deny, json, readBody, bodyText, bodyList } from "../lib/http.js";
import { MEDIA_CACHE, mediaCsp, mediaSigState } from "../lib/media.js";
import { MAX_NAME } from "../lib/text.js";
import { moveFields } from "../games/engine.js";
import type { RouteContext } from "../index.js";

// Sketch & Guess drawings: a signed URL (on message media's hour grid,
// kind "sketch", id "GAME.ROUND") or the room credential.
export async function sketchImageRoute(rc: RouteContext, m: RegExpMatchArray) {
  const { request, env, url, owner, invite } = rc;
  const room = decodeURIComponent(m[1]).toLowerCase();
  if (!ROOM_RE.test(room)) return json({ error: "Room names are 1-64 lowercase letters, digits, - or _" }, 400);
  if (request.method !== "GET" && request.method !== "HEAD") return json({ error: "Method not allowed" }, 405);
  const sgid = parseInt(m[2], 10);
  const sn = parseInt(m[3], 10);
  const sig = await mediaSigState(env, room, sgid + "." + sn, "sketch", url);
  if (sig === "bad") return json({ error: "That image link has expired - reload the game" }, 403);
  const stub = env.ROOM.get(env.ROOM.idFromName(room));
  if (sig === "none") {
    const acc = await stub.access(invite, owner);
    if (!acc.ok) return deny(acc);
  }
  const meta = await stub.sketchImage(sgid, sn);
  if (!meta || !env.MEDIA) return json({ error: "No drawing for that round" }, 404);
  const obj = request.method === "HEAD" ? await env.MEDIA.head(meta.key) : await env.MEDIA.get(meta.key);
  if (!obj) return json({ error: "No drawing for that round" }, 404);
  const headers = Object.assign({ "Content-Type": meta.type, "Cache-Control": MEDIA_CACHE, "X-Content-Type-Options": "nosniff", "Content-Security-Policy": mediaCsp("image"), "Content-Length": String(meta.bytes) }, CORS);
  // a GET read the object with its body
  return new Response(request.method === "HEAD" ? null : (obj as R2ObjectBody).body, { headers: headers });
}

export async function gamesRoute(rc: RouteContext, m: RegExpMatchArray) {
  const { request, env, url, owner, invite } = rc;
  const room = decodeURIComponent(m[1]).toLowerCase();
  if (!ROOM_RE.test(room)) return json({ error: "Room names are 1-64 lowercase letters, digits, - or _" }, 400);
  const gid = m[2] ? parseInt(m[2], 10) : null;
  const sub = m[3] || null;
  const stub = env.ROOM.get(env.ROOM.idFromName(room));
  const acc = await stub.access(invite, owner);
  if (!acc.ok) return deny(acc);
  if (request.method === "GET" && gid === null) return json(Object.assign({ room }, await stub.listGames()));
  // ?log=full on any call that answers with the match's state: the whole
  // move record, where a full state carries only its recent part (Light
  // Cycles' move_log). The web app always asks; agents rarely need it.
  const fullLog = url.searchParams.get("log") === "full";
  if (request.method === "GET" && gid !== null && !sub) {
    const r = await stub.gameState(gid, acc.name || "", room, fullLog);
    if (r.error) return json({ error: r.error }, r.status);
    return json({ room, game: r.game });
  }
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const body = await readBody(request);
  const from = acc.name || bodyText(body?.from, "from").trim().slice(0, MAX_NAME);
  if (!from) return json({ error: "\"from\" is required" }, 400);
  if (gid === null && !sub) {
    const r = await stub.createGame(from, bodyList(body?.players, "players") || [], body || {}, room);
    if (r.error) return json({ error: r.error }, r.status);
    return json({ room, game: r.game }, 201);
  }
  if (gid !== null && sub === "moves") {
    const r = await stub.gameMove(gid, from, body && (body.throw || body.dir), room, moveFields(body), fullLog);
    if (r.error) { const e = { error: r.error } as { error: string, legal_moves?: string[] }; if (r.legal_moves) e.legal_moves = r.legal_moves; return json(e, r.status); }
    return json({ room, game: r.game, resolved: r.resolved });
  }
  if (gid !== null && sub === "cancel") {
    const r = await stub.gameCancel(gid, from, owner, room, fullLog);
    if (r.error) return json({ error: r.error }, r.status);
    return json({ room, game: r.game });
  }
  if (gid !== null && sub === "accept") {
    const r = await stub.gameAccept(gid, from, room, fullLog);
    if (r.error) return json({ error: r.error }, r.status);
    return json({ room, game: r.game });
  }
  if (gid !== null && sub === "decline") {
    const r = await stub.gameDecline(gid, from, room, fullLog);
    if (r.error) return json({ error: r.error }, r.status);
    return json({ room, game: r.game });
  }
  return json({ error: "Not found" }, 404);
}
