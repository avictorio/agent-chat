// Muse delivery hooks: registering a member's Muse agent to be woken by its
// rooms, and each member's own view and settings of their hook in a room.
// The room does the waking (room/muse.ts); the muse-bridge Worker, behind
// the MUSE_BRIDGE service binding, claims link codes and takes the wakes.

import { BadRequest, bodyList, bodyObject, bodyText, deny, json, rateLimited, readBody, settleBody, type Body } from "../lib/http.js";
import { MIB, MUSE_BATCH_MAX, MUSE_CODE_MAX, MUSE_FETCH_MS, ROOM_RE, SMALL_BODY_MAX } from "../limits.js";
import { MUSE_ROUTING_DEFAULT, MUSE_ROUTING_ERROR, museRouting } from "../room/muse.js";
import type { RouteContext } from "../index.js";
import { warn } from "../lib/log.js";

const UNAVAILABLE = { error: "Muse delivery is not set up on this site yet. Use the wake recipe (GET /api/rooms/ROOM/agent-recipe) meanwhile.", code: "muse_unavailable" };

/** One room's answer in a registration. */
type RoomResult = { room: string, ok: true, name: string, hook: unknown } | { room: string, ok: false, status: number, code?: string, error: string };

/** A boolean field, or undefined when absent. */
function bodyFlag(v: unknown, name: string): boolean | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === "boolean") return v;
  throw new BadRequest("\"" + name + "\" must be true or false");
}

// POST /api/muse/hooks {code, routing?, rooms: [{room, token, routing?}]}
//
// One call registers a Muse link for several rooms. Each pair's token is
// first checked against its room (nothing is opened or written); the code
// is claimed from the bridge only when at least one room accepted its
// token, so a call that registers nothing does not spend it. Then each
// accepted room sets that member's hook to the claimed link. Nothing here
// keeps a token: each one is only checked by its own room, and the bridge
// is given the code alone.
export async function museRegisterRoute(rc: RouteContext) {
  const { request, env } = rc;
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const bridge = env.MUSE_BRIDGE;
  if (!bridge) return json(UNAVAILABLE, 503);
  const small = await settleBody(request, SMALL_BODY_MAX);
  if (!small) return json({ error: "That request's body is over " + Math.floor(SMALL_BODY_MAX / MIB) + " MiB" }, 413);
  const body = await readBody(small);
  const code = bodyText(body?.code, "code").trim();
  if (!code) return json({ error: "\"code\" is required: the one-time link code your Muse gave you" }, 400);
  if (code.length > MUSE_CODE_MAX) return json({ error: "\"code\" is longer than " + MUSE_CODE_MAX + " characters" }, 400);
  const defRaw = bodyText(body?.routing, "routing");
  const def = defRaw ? museRouting(defRaw) : MUSE_ROUTING_DEFAULT;
  if (!def) return json({ error: MUSE_ROUTING_ERROR }, 400);
  const list = bodyList(body?.rooms, "rooms");
  if (!list || !list.length) return json({ error: "\"rooms\" must list the rooms to register: [{\"room\", \"token\", \"routing\"?}]" }, 400);
  if (list.length > MUSE_BATCH_MAX) return json({ error: "One registration covers up to " + MUSE_BATCH_MAX + " rooms" }, 400);

  // First pass: every pair, checked by its room.
  const results: RoomResult[] = [];
  const accepted: Array<{ i: number, room: string, token: string, routing: string }> = [];
  for (let i = 0; i < list.length; i++) {
    let entry: Body | null;
    try { entry = bodyObject(list[i], "rooms[" + i + "]"); } catch (e) { results.push({ room: "", ok: false, status: 400, error: (e as Error).message }); continue; }
    const room = bodyText(entry?.room, "room").trim().toLowerCase();
    const token = bodyText(entry?.token, "token").trim();
    const rRaw = bodyText(entry?.routing, "routing");
    const routing = rRaw ? museRouting(rRaw) : def;
    if (!ROOM_RE.test(room)) { results.push({ room, ok: false, status: 400, error: "Room names are 1-64 lowercase letters, digits, - or _" }); continue; }
    if (!token) { results.push({ room, ok: false, status: 401, code: "invite_missing", error: "\"token\" is required: your invite token for this room" }); continue; }
    if (!routing) { results.push({ room, ok: false, status: 400, error: MUSE_ROUTING_ERROR }); continue; }
    const v = await env.ROOM.get(env.ROOM.idFromName(room)).museVerify(token);
    if (!v.ok) { results.push({ room, ok: false, status: v.status, code: v.code, error: v.error }); continue; }
    results.push({ room, ok: false, status: 0, error: "" }); // filled in below
    accepted.push({ i: results.length - 1, room, token, routing });
  }
  if (!accepted.length) return json({ error: "No room accepted its token, so the code was not used", code: "no_rooms", results }, 403);

  // The code, claimed once for every room.
  let link = "";
  try {
    const r = await bridge.fetch("https://muse-bridge/claim", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: code }), signal: AbortSignal.timeout(MUSE_FETCH_MS) });
    if (r.status === 429) return rateLimited("The Muse bridge is busy; try again shortly", parseInt(r.headers.get("Retry-After") || "", 10) || 30);
    if (r.status >= 400 && r.status < 500) return json({ error: "That link code is not valid: it may have expired or been used already. Ask your Muse for a new one.", code: "code_invalid" }, 403);
    if (!r.ok) { warn("muse.claim", "HTTP " + r.status); return json({ error: "The Muse bridge did not answer; nothing was registered. Try again shortly.", code: "muse_unreachable" }, 502); }
    const j = await r.json().catch(() => null) as { museLinkId?: unknown } | null;
    link = j && typeof j.museLinkId === "string" ? j.museLinkId : "";
  } catch (e) {
    warn("muse.claim", e && (e as Error).name ? (e as Error).name : "fetch failed");
    return json({ error: "The Muse bridge did not answer; nothing was registered. Try again shortly.", code: "muse_unreachable" }, 502);
  }
  if (!link || link.length > MUSE_CODE_MAX) {
    warn("muse.claim", "no link id");
    return json({ error: "The Muse bridge's answer had no link; nothing was registered.", code: "muse_unreachable" }, 502);
  }

  // Each accepted room sets the hook (its token checked again there: it
  // could have been revoked since the first pass).
  for (const a of accepted) {
    const s = await env.ROOM.get(env.ROOM.idFromName(a.room)).museSetHook(a.token, link, a.routing, a.room);
    results[a.i] = s.ok ? { room: a.room, ok: true, name: s.name, hook: s.hook } : { room: a.room, ok: false, status: s.status, code: s.code, error: s.error };
  }
  return json({ claimed: true, results });
}

// GET | POST | DELETE /api/rooms/ROOM/muse-hook: your own hook in this
// room, with your invite token. GET shows it (or null), POST changes
// routing, muted or enabled, DELETE removes it. A hook is a member's, so
// the owner key alone has none.
export async function museHookRoute(rc: RouteContext, m: RegExpMatchArray) {
  const { request, env, invite } = rc;
  const room = decodeURIComponent(m[1]).toLowerCase();
  if (!ROOM_RE.test(room)) return json({ error: "Room names are 1-64 lowercase letters, digits, - or _" }, 400);
  if (!invite) return json({ error: "A Muse hook is a member's own: send your invite token (X-Invite-Token)", code: "invite_missing" }, 401);
  const stub = env.ROOM.get(env.ROOM.idFromName(room));
  if (request.method === "GET" || request.method === "HEAD") {
    const s = await stub.museStatus(invite);
    if (!s.ok) return deny(s);
    return json({ room, name: s.name, hook: s.hook });
  }
  if (request.method === "DELETE") {
    const s = await stub.museRemove(invite);
    if (!s.ok) return deny(s);
    if (!s.removed) return json({ error: "You have no Muse hook in this room", code: "no_hook" }, 404);
    return json({ room, name: s.name, removed: true });
  }
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const body = await readBody(request);
  const change: { routing?: string, muted?: boolean, enabled?: boolean } = {};
  if (body && body.routing !== undefined && body.routing !== null) {
    const r = museRouting(bodyText(body.routing, "routing"));
    if (!r) return json({ error: MUSE_ROUTING_ERROR }, 400);
    change.routing = r;
  }
  const muted = bodyFlag(body?.muted, "muted");
  if (muted !== undefined) change.muted = muted;
  const enabled = bodyFlag(body?.enabled, "enabled");
  if (enabled !== undefined) change.enabled = enabled;
  if (change.routing === undefined && change.muted === undefined && change.enabled === undefined) return json({ error: "Send at least one of \"routing\", \"muted\" or \"enabled\"" }, 400);
  const s = await stub.museUpdate(invite, change);
  if (!s.ok) return deny(s);
  return json({ room, name: s.name, hook: s.hook });
}
