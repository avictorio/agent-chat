// Games: matches, moves, cancel/accept/decline, Sketch & Guess drawings.
// Sketch & Guess drawings (2026-11-20): a signed URL (the hour grid of
// message media, kind "sketch", id "GAME.ROUND") or the room credential.

import { ROOM_RE } from "../limits.js";
import { CORS, json, readBody } from "../lib/http.js";
import { MEDIA_CACHE, mediaCsp, mediaSigState } from "../lib/media.js";
import { MAX_NAME } from "../lib/text.js";
import { moveFields } from "../games/engine.js";

export async function sketchImageRoute(rc, m) {
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
    if (!acc.ok) return json({ error: acc.error }, acc.status);
  }
  const meta = await stub.sketchImage(sgid, sn);
  if (!meta || !env.MEDIA) return json({ error: "No drawing for that round" }, 404);
  const obj = request.method === "HEAD" ? await env.MEDIA.head(meta.key) : await env.MEDIA.get(meta.key);
  if (!obj) return json({ error: "No drawing for that round" }, 404);
  const headers = Object.assign({ "Content-Type": meta.type, "Cache-Control": MEDIA_CACHE, "X-Content-Type-Options": "nosniff", "Content-Security-Policy": mediaCsp("image"), "Content-Length": String(meta.bytes) }, CORS);
  return new Response(request.method === "HEAD" ? null : obj.body, { headers: headers });
}

export async function gamesRoute(rc, m) {
  const { request, env, owner, invite } = rc;
  const room = decodeURIComponent(m[1]).toLowerCase();
  if (!ROOM_RE.test(room)) return json({ error: "Room names are 1-64 lowercase letters, digits, - or _" }, 400);
  const gid = m[2] ? parseInt(m[2], 10) : null;
  const sub = m[3] || null;
  const stub = env.ROOM.get(env.ROOM.idFromName(room));
  const acc = await stub.access(invite, owner);
  if (!acc.ok) return json({ error: acc.error }, acc.status);
  if (request.method === "GET" && gid === null) return json(Object.assign({ room }, await stub.listGames()));
  if (request.method === "GET" && gid !== null && !sub) {
    const r = await stub.gameState(gid, acc.name || "", room);
    if (r.error) return json({ error: r.error }, r.status);
    return json({ room, game: r.game });
  }
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const body = await readBody(request);
  const from = acc.name || String((body && body.from) || "").trim().slice(0, MAX_NAME);
  if (!from) return json({ error: "\"from\" is required" }, 400);
  if (gid === null && !sub) {
    const r = await stub.createGame(from, (body && body.players) || [], body || {}, room);
    if (r.error) return json({ error: r.error }, r.status);
    return json({ room, game: r.game }, 201);
  }
  if (gid !== null && sub === "moves") {
    const r = await stub.gameMove(gid, from, body && (body.throw || body.dir), room, moveFields(body));
    if (r.error) { const e = { error: r.error }; if (r.legal_moves) e.legal_moves = r.legal_moves; return json(e, r.status); }
    return json({ room, game: r.game, resolved: r.resolved });
  }
  if (gid !== null && sub === "cancel") {
    const r = await stub.gameCancel(gid, from, owner, room);
    if (r.error) return json({ error: r.error }, r.status);
    return json({ room, game: r.game });
  }
  if (gid !== null && sub === "accept") {
    const r = await stub.gameAccept(gid, from, room);
    if (r.error) return json({ error: r.error }, r.status);
    return json({ room, game: r.game });
  }
  if (gid !== null && sub === "decline") {
    const r = await stub.gameDecline(gid, from, room);
    if (r.error) return json({ error: r.error }, r.status);
    return json({ room, game: r.game });
  }
  return json({ error: "Not found" }, 404);
}
