// Muse delivery hooks: registering a member's Muse agent to be woken by its
// rooms, and each member's own view and settings of their hook in a room.
// The room does the waking (room/muse.ts); the Muse bridge (worker/bridge,
// in this Worker: museBridge) claims link codes and takes the wakes.
// Also the gadget's handover (museHandoverRoute): the Muse gadget, which is
// no room's member, hands the bridge its sealed Muse token through here.

import { BadRequest, bodyList, bodyObject, bodyText, CORS, deny, json, rateLimited, readBody, settleBody, type Body } from "../lib/http.js";
import {
  MIB, MUSE_BATCH_MAX, MUSE_CODE_MAX, MUSE_HANDOVER_BODY_MAX, MUSE_HANDOVER_PER_IP, MUSE_HANDOVER_WINDOW_S, MUSE_QUOTA_ROOM,
  MUSE_SEAL_KEY_CACHE_S, ROOM_RE, SMALL_BODY_MAX,
} from "../limits.js";
import { MUSE_ROUTING_DEFAULT, MUSE_ROUTING_ERROR, museBridge, museReportRoom, museRouting } from "../room/muse.js";
import { hashKey, networkKey } from "../lib/address.js";
import type { RouteContext } from "../index.js";
import { warn } from "../lib/log.js";

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
  const bridge = museBridge(env);
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
    const r = await bridge("/claim", { code: code });
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
    // the bridge counts the link's rooms for the gadget (best effort: never fails the registration)
    if (s.ok) await museReportRoom(bridge, link, a.room, true);
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

// The gadget's handover: POST /api/muse/connect {sealed, termsVersion},
// POST /api/muse/update {sealed, museLinkId?}, POST /api/muse/disconnect
// {museLinkId}, POST /api/muse/status {museLinkId} (the link's room count,
// for the gadget's screen) and GET /api/muse/seal-key, each relayed to the bridge's
// route of the same name, its answer (status, body, Retry-After) passed
// back as it came. The gadget is no member of any room, so no token is
// asked for: each network gets MUSE_HANDOVER_PER_IP calls a
// MUSE_HANDOVER_WINDOW_S, and a body is at most MUSE_HANDOVER_BODY_MAX.
// Only the fields named go on to the bridge. A sealed blob, a code and a
// link id are never logged (the link id is a bearer secret: /disconnect
// and /status take nothing else).
export type MuseHandover = "connect" | "update" | "disconnect" | "status" | "seal-key";

/** The last seal key the bridge gave, kept for MUSE_SEAL_KEY_CACHE_S (the
 *  settled answer only, as appShell keeps its shell). */
let sealKeyKept: { text: string, type: string, until: number } | null = null;

/** A string field: absent is "", anything else but a string is refused. */
function handoverText(v: unknown, name: string, max: number): string {
  if (v === undefined || v === null) return "";
  if (typeof v !== "string") throw new BadRequest("\"" + name + "\" must be text");
  if (v.length > max) throw new BadRequest("\"" + name + "\" is longer than " + max + " characters");
  return v;
}

export async function museHandoverRoute(rc: RouteContext, which: MuseHandover) {
  const { request, env } = rc;
  const method = which === "seal-key" ? "GET" : "POST";
  if (request.method !== method && !(method === "GET" && request.method === "HEAD")) return json({ error: "Method not allowed" }, 405);
  const bridge = museBridge(env);
  const quota = env.ROOM.get(env.ROOM.idFromName(MUSE_QUOTA_ROOM));
  const wait = await quota.museQuotaTake("ip:" + (await hashKey(networkKey(request.headers.get("CF-Connecting-IP")))), MUSE_HANDOVER_PER_IP, MUSE_HANDOVER_WINDOW_S);
  if (wait > 0) return rateLimited("Too many Muse handover calls from this network; try again later", wait);

  let out: Record<string, string> | undefined;
  if (method === "POST") {
    const small = await settleBody(request, MUSE_HANDOVER_BODY_MAX);
    if (!small) return json({ error: "That request's body is over " + MUSE_HANDOVER_BODY_MAX + " bytes" }, 413);
    const body = await readBody(small);
    const sealed = handoverText(body?.sealed, "sealed", MUSE_HANDOVER_BODY_MAX).trim();
    const terms = handoverText(body?.termsVersion, "termsVersion", 64).trim();
    const link = handoverText(body?.museLinkId, "museLinkId", MUSE_CODE_MAX).trim();
    if (which === "disconnect" || which === "status") {
      if (!link) return json({ error: "\"museLinkId\" is required" }, 400);
      out = { museLinkId: link };
    } else {
      if (!sealed) return json({ error: "\"sealed\" is required: the gadget's Muse token, sealed to GET /api/muse/seal-key" }, 400);
      if (which === "connect") {
        if (!terms) return json({ error: "\"termsVersion\" is required: the version of /muse-terms the person agreed to" }, 400);
        out = { sealed, termsVersion: terms };
      } else {
        out = link ? { sealed, museLinkId: link } : { sealed };
      }
    }
  } else if (sealKeyKept && sealKeyKept.until > Date.now()) {
    return sealKeyAnswer(sealKeyKept.text, sealKeyKept.type, 200);
  }

  let status = 0, text = "", type = "", retry = "";
  try {
    const r = await bridge("/" + which, out);
    status = r.status;
    type = r.headers.get("Content-Type") || "";
    retry = r.headers.get("Retry-After") || "";
    text = await r.text();
  } catch (e) {
    warn("muse.handover", e && (e as Error).name ? (e as Error).name : "fetch failed", { route: which });
    return json({ error: "The Muse bridge did not answer. Try again shortly.", code: "muse_unreachable" }, 502);
  }
  if (status >= 500) warn("muse.handover", "HTTP " + status, { route: which });
  if (which === "seal-key") {
    if (status === 200) sealKeyKept = { text, type, until: Date.now() + MUSE_SEAL_KEY_CACHE_S * 1000 };
    return sealKeyAnswer(text, type, status);
  }
  const headers: Record<string, string> = Object.assign({ "Content-Type": type || "application/json; charset=utf-8", "Cache-Control": "no-store" }, CORS);
  if (retry) headers["Retry-After"] = retry;
  return new Response(text, { status, headers });
}

/** The seal key's answer: cacheable when it is the key. */
function sealKeyAnswer(text: string, type: string, status: number) {
  const cache = status === 200 ? "public, max-age=" + MUSE_SEAL_KEY_CACHE_S : "no-store";
  return new Response(text, { status, headers: Object.assign({ "Content-Type": type || "application/json; charset=utf-8", "Cache-Control": cache }, CORS) });
}
