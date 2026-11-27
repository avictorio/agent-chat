// The agent key's routes. An agent key holds an agent's invites to several
// rooms, sealed in an identity of its own (room/agent.ts stores it,
// lib/agentkey.ts holds the key's forms and the sealing):
//   POST   /api/agents               a key from the caller's own agent invites
//   POST   /api/agents/invite        a key a person makes for their agent: its
//                                    seats made with the person's own invites
//   GET    /api/agent                the key's rooms (HEAD: the headers)
//   POST   /api/agent/rooms          more rooms on the key
//   POST   /api/agent/rooms/invite   more seats made with a person's invites
//   POST   /api/agent/rooms/remove   one room off the key
//   DELETE /api/agent                the key disconnected everywhere
//   POST   /api/mcp                  every room tool, with the room as an argument
// None is under a room, and no room changes for them: a room is reached
// only through its own methods, with the token the key holds for it,
// exactly as a call to the room's own address presents it, so the room
// stays the authority on every call (a revoke, a leave, revoke-everyone or a
// deleted room refuses the token at the next call; nothing is cached).
// Holding a room on a key never joins it: a call joins a room exactly when
// the same call at the room's own address would (only the room tools that
// run access() do). No answer here carries a room's token or mints a
// credential beyond the key itself: the invites a person's routes make go
// straight onto the key, and no answer carries them, a link or a note.
// Disconnecting a key (DELETE /api/agent) ends every call made with it, at
// once, and then turns off the Muse wakes the key set up (muse_register). It
// does not end what lives outside the key: each room's own invite still
// works for whoever holds it, and the links a room tool already handed out
// through the key run out on their own clocks (upload tickets and resumable
// upload sessions, which also end with the room's invite, and signed media
// links).
//
// The credential is read only from Authorization: Bearer (never
// X-Invite-Token, never X-Owner-Key); POST /api/agents/invite reads none
// there, and takes a person's invite tokens in its body, each looked up by
// its own room, a refused one learning nothing about it. A caller with no
// valid key learns nothing about any room or key and writes nothing: a
// refused key makes at most one call to an object that does not exist or
// does not match, and no room is asked. No route here has a room or a
// credential in its URL. The
// lines this file logs carry no room name, no id and no credential; a room
// asked through the key logs its own lines as at its own address.

import {
  AGENT_GLANCE_GAP_S,
  AGENT_GLANCE_PARALLEL,
  AGENT_KEYS_PER_DAY,
  AGENT_KEYS_PER_IP,
  AGENT_KEYS_PER_ROOM_DAY,
  AGENT_KEYS_WINDOW_S,
  AGENT_QUOTA_ROOM,
  AGENT_ROOMS_MAX,
  AGENT_SWAP_TRIES,
  AGENT_WAKE_RETRY_MS,
  MAX_ACTIVE_INVITES,
  MCP_ECHO_MAX,
  MEMBER_INVITES_PER_DAY,
  MIB,
  MUSE_CODE_MAX,
  ROOM_RE,
  SETTLED_BODY_MAX,
  SMALL_BODY_MAX,
  pollGap,
  spanS,
} from "../limits.js";
import { isObject, json, rateLimited, readBody, settleBody, type Body } from "../lib/http.js";
import { AGENT_UNREADABLE, agentCredential, agentDataKey, agentSealRing, agentUnseal, agentVerifier, newAgentKey, type AgentEntry } from "../lib/agentkey.js";
import { hashKey, networkKey } from "../lib/address.js";
import { cleanName, memberNameProblem, nameFold, sameName } from "../lib/text.js";
import { warn } from "../lib/log.js";
import { AGENT_KEY_INVALID, AGENT_KEY_MISSING, NOT_AGENT_KEY, agentInstructions, agentKeyNote, dropNote, personKeyClaudeCode, personKeyHandoff, personKeyNote, unusedNote, type AgentVariant } from "../agents/onboarding.js";
import { MCP_AGENT_CATALOG_VERSION, agentServerInfo, mcpAgentCatalogBuilt, mcpCallOf, mcpErr, mcpHasAgentTool, mcpOk } from "../agents/mcp.js";
import { mcpServe, roomToolAnswer, type ToolAnswer, type Worded } from "./agents.js";
import { museClaim } from "./muse.js";
import type { RouteContext } from "../index.js";
import { inviteMissing, type InviteLookup, type Refusal, type StartView } from "../room/Room.js";
import type { AgentCap } from "../room/agent.js";
import { MUSE_NOT_JOINED, MUSE_ROUTING_DEFAULT, MUSE_ROUTING_ERROR, museBridge, museReportRoom, museRouting } from "../room/muse.js";

/** The identity's object: a Room under a name no room can have. */
function identity(env: Env, id: string): DurableObjectStub {
  return env.ROOM.get(env.ROOM.idFromName("__agent-" + id));
}
function roomStub(env: Env, room: string): DurableObjectStub {
  return env.ROOM.get(env.ROOM.idFromName(room));
}
function quota(env: Env): DurableObjectStub {
  return env.ROOM.get(env.ROOM.idFromName(AGENT_QUOTA_ROOM));
}

/* ---------- the key ---------- */

/** A current key: its identity's object, id, secret and verifier. */
type Keyed = { stub: DurableObjectStub, id: string, secret: Uint8Array<ArrayBuffer>, verifier: string };
/** ... and what its open read: the wrapped data key, the list's version and sealed list, when it was made. */
type Opened = Keyed & { wrapped: string | null, ver: number, ring: string, created: number };
/** ... and the list opened. */
type Unsealed = Opened & { dk: Uint8Array<ArrayBuffer>, rooms: AgentEntry[] };

/** A refusal: its status, code (when it has one), sentence, room (when it
 *  names one) and, for a cap that resets with time, the seconds until it
 *  does (sent over REST as Retry-After). */
type Refused = { status: number, code?: string, error: string, room?: string, retry_after?: number };

/** The key's three refusals, over REST and (as -32001) over MCP. */
const KEY_REFUSED: Record<Exclude<AgentVariant, "ok">, Refused & { code: string }> = {
  none: { status: 401, code: "agent_key_missing", error: AGENT_KEY_MISSING },
  invite: { status: 403, code: "not_agent_key", error: NOT_AGENT_KEY },
  invalid: { status: 403, code: "agent_key_invalid", error: AGENT_KEY_INVALID },
};

/** The request's credential: a current key, opened (one call to its
 *  object), or what it turned out to be instead. A malformed key, a room
 *  token or no key asks no object at all. */
async function openKey(env: Env, request: Request): Promise<{ variant: "ok", key: Opened } | { variant: Exclude<AgentVariant, "ok"> }> {
  const c = agentCredential(request);
  if (c.kind === "none") return { variant: "none" };
  if (c.kind === "invite") return { variant: "invite" };
  if (c.kind === "bad") return { variant: "invalid" };
  const stub = identity(env, c.id);
  const verifier = await agentVerifier(c.id, c.secret);
  const o = await stub.agentOpen("key", verifier);
  if (!o.ok) return { variant: "invalid" };
  return { variant: "ok", key: { stub, id: c.id, secret: c.secret, verifier, wrapped: o.wrapped, ver: o.ver, ring: o.ring, created: o.created } };
}

/** The key opened again (its list as it is now); null once disconnected. */
async function reopen(k: Keyed): Promise<Opened | null> {
  const o = await k.stub.agentOpen("key", k.verifier);
  return o.ok ? { stub: k.stub, id: k.id, secret: k.secret, verifier: k.verifier, wrapped: o.wrapped, ver: o.ver, ring: o.ring, created: o.created } : null;
}

/** The list opened with the key's secret; null when it does not open (logged, lib/agentkey.ts). */
async function unseal(k: Opened): Promise<Unsealed | null> {
  const u = await agentUnseal(k.id, k.secret, k.wrapped, k.ver, k.ring);
  return u ? { ...k, dk: u.dk, rooms: u.rooms } : null;
}

/** A change to the key's list: the new list and what to answer, or only
 *  an answer (nothing written). */
type Changed<T> = { rooms: AgentEntry[], then: T } | { answer: T };
/** What a rewrite came to: done (with the list as it now stands, after
 *  its swap), an answer that wrote nothing, or a swap that did not happen. */
type Rewritten<T> = { done: T, after: Unsealed } | { answer: T } | { busy: true } | { gone: true } | { unreadable: true };

/** Changes the key's list, compare-and-set: change gets the list as stored;
 *  the new list is sealed at the next version and swapped in, and on a
 *  stale swap (another call wrote meanwhile) the list is read again and the
 *  change made again, tries times at most. A swap the object refuses
 *  otherwise means the key was disconnected meanwhile (gone). */
async function rewrite<T>(first: Unsealed, change: (u: Unsealed) => Promise<Changed<T>>, tries = AGENT_SWAP_TRIES): Promise<Rewritten<T>> {
  let u: Unsealed | null = first;
  for (let i = 0; i < tries; i++) {
    if (!u) {
      const o = await reopen(first);
      if (!o) return { gone: true };
      u = await unseal(o);
      if (!u) return { unreadable: true };
    }
    const c = await change(u);
    if ("answer" in c) return { answer: c.answer };
    const ring = await agentSealRing(u.dk, u.id, u.ver + 1, c.rooms);
    const s = await u.stub.agentSwap("key", u.verifier, u.ver, ring);
    if (s.ok) return { done: c.then, after: { ...u, ver: u.ver + 1, ring, rooms: c.rooms } };
    if (s.code !== "stale") return { gone: true };
    u = null;
  }
  return { busy: true };
}

/** A room as the key's listings show it: never its token, and never the
 *  link id of a Muse wake the key set up there (muse_wake says there is one). */
function entryView(e: AgentEntry) {
  const out: { room: string, name: string, added: number, state: string, code?: string, at?: number, muse_wake?: true } = { room: e.room, name: e.name, added: e.added, state: e.state };
  if (e.code !== undefined) out.code = e.code;
  if (e.at !== undefined) out.at = e.at;
  if (e.hook) out.muse_wake = true;
  return out;
}

/** Marks rooms the rooms refused (each by its room and the token that was
 *  refused, so a room put back on the key with a new token meanwhile is left
 *  alone): a write, tried twice, then left (the next call marks it). Whether
 *  the list now says so; a mark that fails (the key's object throws, or the
 *  swap stays stale) changes nothing in the answer the call gives. */
async function markRefused(u: Unsealed, marks: Array<{ room: string, token: string, code: string }>): Promise<boolean> {
  const at = Date.now();
  try {
    const r = await rewrite<boolean>(u, async (x): Promise<Changed<boolean>> => {
      let changed = false;
      const rooms = x.rooms.map((e) => {
        const m = marks.find((k) => k.room === e.room && k.token === e.token);
        if (!m || (e.state === "refused" && e.code === m.code)) return e;
        changed = true;
        return { ...e, state: "refused" as const, code: m.code, at };
      });
      return changed ? { rooms, then: true } : { answer: true };
    }, 2);
    return "done" in r || "answer" in r;
  } catch (e) {
    warn("agent.mark", e);
    return false;
  }
}

/* ---------- the entries: {room, token} ---------- */

/** A body field as text: a string as sent, a number as its digits, anything else none. */
function fieldText(v: unknown): string {
  return typeof v === "string" ? v : typeof v === "number" && Number.isFinite(v) ? String(v) : "";
}
/** A sentence about one entry: "rooms[i]: ..." in a REST body's list, the
 *  sentence alone for MCP add_room's one room, capitalised there only when
 *  it is a fixed one (fixed): one that starts with a room's name keeps the
 *  name as it is. */
function about(i: number | null, s: string, fixed = true): string {
  if (i !== null) return "rooms[" + i + "]: " + s;
  return fixed ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}
/** A room name a refusal repeats from the request, cut short (MCP_ECHO_MAX). */
function echo(room: string): string {
  return room.length > MCP_ECHO_MAX ? room.slice(0, MCP_ECHO_MAX) + "..." : room;
}
const ROOM_NAME_RULE = "Room names are 1-64 lowercase letters, digits, - or _";

/** One entry's shape, checked before any object call: an object, a room
 *  name, not twice, a token that is there and is no agent key. */
function entryShape(v: unknown, i: number | null, seen: Set<string>): { room: string, token: string } | Refused {
  if (!isObject(v)) return { status: 400, error: "rooms[" + i + "] must be an object: {\"room\", \"token\"}" };
  const room = fieldText(v.room).trim().toLowerCase();
  if (!ROOM_RE.test(room)) return { status: 400, error: about(i, ROOM_NAME_RULE), room: echo(room) };
  if (seen.has(room)) return { status: 400, error: about(i, room + " is listed twice", false), room };
  seen.add(room);
  const token = fieldText(v.token).trim();
  if (!token) return { status: 401, code: "invite_missing", error: about(i, "\"token\" is required: your agent invite token for " + room), room };
  if (token.charAt(0) === ".") return { status: 403, code: "invite_invalid", error: about(i, "that is an agent key, not a room invite token"), room };
  return { room, token };
}

/** What a room says of an entry's token: a look (lookupInvite), which
 *  opens nothing. A room with no storage answers as the room routes
 *  answer an unknown name; a person's invite is refused. */
async function entryLookup(env: Env, e: { room: string, token: string }): Promise<{ ok: true, entry: { room: string, token: string, name: string, opened: boolean } } | (Refused & { ok: false })> {
  const l: InviteLookup = await roomStub(env, e.room).lookupInvite(e.token);
  if (!l.ok) {
    if (l.code === "room_deleted") return { ok: false, status: 404, error: "No room with that name yet. Create it from the home page.", room: e.room };
    return { ok: false, status: l.status, code: l.code, error: "Room \"" + e.room + "\": " + l.error, room: e.room };
  }
  if (l.row.kind === "human") return { ok: false, status: 403, code: "not_agent_invite", error: "Room \"" + e.room + "\": this is a person's invite. An agent key holds only agent invites: an agent joins under its own name, never as a person.", room: e.room };
  return { ok: true, entry: { room: e.room, token: e.token, name: l.row.name, opened: !!l.row.used } };
}

/** A refusal as a REST answer: {error, code?, room?}, then any extra
 *  fields; Retry-After when the refusal says when to try again. */
function refusedJson(r: Refused, headers?: Record<string, string>, extra?: Record<string, unknown>): Response {
  const body: Record<string, unknown> = { error: r.error };
  if (r.code !== undefined) body.code = r.code;
  if (r.room !== undefined) body.room = r.room;
  if (extra) Object.assign(body, extra);
  const h = r.retry_after !== undefined ? Object.assign({ "Retry-After": String(Math.max(1, Math.ceil(r.retry_after))) }, headers || {}) : headers;
  return json(body, r.status, h);
}
/** A refusal as an MCP tool error: the sentence, and {code?, room?}. */
function refusedTool(r: Refused): ToolAnswer {
  const s: Record<string, unknown> = {};
  if (r.code !== undefined) s.code = r.code;
  if (r.room !== undefined) s.room = r.room;
  return { result: mcpErr(r.error, Object.keys(s).length ? s : undefined) };
}

const UNREADABLE: Refused = { status: 500, code: "agent_unreadable", error: AGENT_UNREADABLE };
const BUSY: Refused = { status: 503, code: "try_again", error: "This key is busy; try again." };
/** A rewrite that did not happen, as REST answers it. */
function rewriteRefusal(r: { busy: true } | { gone: true } | { unreadable: true }): Response {
  if ("gone" in r) return refusedJson(KEY_REFUSED.invalid);
  if ("unreadable" in r) return refusedJson(UNREADABLE);
  return refusedJson(BUSY, { "Retry-After": "1" });
}

/** The rooms of a list of entries, as it must be: 1 to AGENT_ROOMS_MAX. */
function roomsListRefusal(): Refused {
  return { status: 400, error: "\"rooms\" must list 1 to " + AGENT_ROOMS_MAX + " rooms: [{\"room\", \"token\"}], your agent invites" };
}
const BODY_TOO_LARGE = "That request's body is too large: send {\"rooms\": [{\"room\", \"token\"}]}.";

/* ---------- POST /api/agents ---------- */

/** What one new key counts in: the network per AGENT_KEYS_WINDOW_S, the
 *  site per UTC day, and each room the key holds (every one has taken its
 *  token by then) per UTC day, the network and the rooms as hashes. The
 *  counters' object puts each in its window by its own clock. */
async function creationCaps(request: Request, rooms: string[]): Promise<AgentCap[]> {
  const caps: AgentCap[] = [
    { k: "net:" + (await hashKey(networkKey(request.headers.get("CF-Connecting-IP")))), max: AGENT_KEYS_PER_IP, per: AGENT_KEYS_WINDOW_S },
    { k: "all", max: AGENT_KEYS_PER_DAY, per: "day" },
  ];
  for (const room of rooms) caps.push({ k: "room:" + (await hashKey(room)), max: AGENT_KEYS_PER_ROOM_DAY, per: "day" });
  return caps;
}

// POST /api/agents {"rooms": [{"room", "token"}]}: a new key holding the
// caller's own agent invites. Joins nothing and changes nothing in any room.
// In order: the method, the body (at most SMALL_BODY_MAX), the list, every
// entry's shape (no object asked yet), every room's look in order (the
// first refused is the answer, with nothing counted anywhere), then the
// caps, counted only for the network, the site and rooms whose tokens all
// passed, so a caller learns of no room's counter but its own rooms' and
// leaves no row for a room it is not in, then the identity, made at once
// (a failure after the caps gives the places back, once). Nothing is made
// unless every room took its token.
export async function agentCreateRoute(rc: RouteContext): Promise<Response> {
  const { request, env, url } = rc;
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const small = await settleBody(request, SMALL_BODY_MAX);
  if (!small) return json({ error: BODY_TOO_LARGE }, 413);
  const b = await readBody(small);
  const list = b ? b.rooms : undefined;
  if (!Array.isArray(list) || list.length < 1 || list.length > AGENT_ROOMS_MAX) return refusedJson(roomsListRefusal());
  const seen = new Set<string>();
  const entries: Array<{ room: string, token: string }> = [];
  for (let i = 0; i < list.length; i++) {
    const e = entryShape(list[i], i, seen);
    if ("status" in e) return refusedJson(e);
    entries.push(e);
  }
  const found: Array<{ room: string, token: string, name: string, opened: boolean }> = [];
  for (const e of entries) {
    const l = await entryLookup(env, e);
    if (!l.ok) return refusedJson(l);
    found.push(l.entry);
  }
  const caps = await creationCaps(request, found.map((f) => f.room));
  const q = quota(env);
  const got = await q.agentReserve(caps);
  if (!Array.isArray(got)) {
    if (typeof got === "number") return rateLimited("Too many agent keys were made just now, from this network, for one of these rooms or on the whole site. Try again later.", got);
    return json({ error: "The key could not be made; nothing was kept. Try again." }, 500);
  }
  let made = false;
  try {
    const now = Date.now();
    const rooms: AgentEntry[] = found.map((f) => ({ room: f.room, token: f.token, name: f.name, added: now, state: "held" }));
    // a fresh random id names an object nobody made; one that exists all
    // the same gets one more try with a new id
    for (let attempt = 0; attempt < 2; attempt++) {
      const k = newAgentKey();
      const verifier = await agentVerifier(k.id, k.secret);
      const { dk, wrapped } = await agentDataKey(k.id, k.secret);
      const r = await identity(env, k.id).agentMake(verifier, wrapped, await agentSealRing(dk, k.id, 1, rooms));
      if (r.ok) {
        made = true;
        const address = url.origin + "/api/mcp";
        return json({
          key: k.key, address, rooms: found.map((f) => ({ room: f.room, name: f.name, opened: f.opened })), max_rooms: AGENT_ROOMS_MAX,
          // the line holds the word KEY, so the key itself is in the answer once
          claude_code: "claude mcp add --transport http agent-chat " + address + " --header \"Authorization: Bearer KEY\"",
          note: agentKeyNote(url.origin),
        }, 201);
      }
      if (r.code !== "exists") break;
    }
    return json({ error: "The key could not be made; nothing was kept. Try again." }, 500);
  } finally {
    // the places this call took, given back once when it made nothing
    if (!made) { try { await q.agentRelease(got); } catch (e) { warn("agent.release", e); } }
  }
}

/* ---------- GET, HEAD and DELETE /api/agent ---------- */

/* ---------- the Muse wakes a key set up ---------- */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Turns off the Muse wake a key set up in one room (the entry's hook):
 *  museDropLook, a look at the room's own invite that opens nothing and
 *  removes the member's hook only while it is a Muse hook on that same link.
 *  removed; kept (the hook there is not the key's any more: a webhook, or
 *  one the agent set itself on another link); gone (the room refuses the
 *  seat, and the hook went with it); left (the room's call threw twice,
 *  AGENT_WAKE_RETRY_MS apart: one still on older code just after a deploy,
 *  say, or one that cannot be reached). */
async function dropWake(env: Env, e: AgentEntry): Promise<"removed" | "kept" | "gone" | "left"> {
  for (let i = 0; i < 2; i++) {
    if (i) await sleep(AGENT_WAKE_RETRY_MS);
    try {
      const r = await roomStub(env, e.room).museDropLook(e.token, e.hook || "");
      return r.ok ? (r.removed ? "removed" : "kept") : "gone";
    } catch { /* asked once more, then reported as left; the caller logs the count */ }
  }
  return "left";
}

/** The wakes a disconnected key set up, turned off: every entry with a
 *  hook, AGENT_GLANCE_PARALLEL rooms at a time. Which rooms' wakes this
 *  turned off, and which it could not reach. */
async function dropWakes(env: Env, rooms: AgentEntry[]): Promise<{ removed: string[], left: string[] }> {
  const hooked = rooms.filter((e) => e.hook);
  const got: string[] = hooked.map(() => "");
  let next = 0;
  const lane = async () => {
    while (next < hooked.length) {
      const i = next++;
      got[i] = await dropWake(env, hooked[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(AGENT_GLANCE_PARALLEL, hooked.length) }, lane));
  return { removed: hooked.filter((_, i) => got[i] === "removed").map((e) => e.room), left: hooked.filter((_, i) => got[i] === "left").map((e) => e.room) };
}

// GET /api/agent with the key: its rooms (never a token), the most it can
// hold and when it was made; HEAD the same headers. DELETE disconnects it
// everywhere: the identity goes, the key works nowhere from then on, and
// every seat stays in its room (as does any token the agent kept). Then
// the Muse wakes the key set up (muse_register) are turned off, from the
// list as it stood when the key was cut, each with a look that opens
// nothing (museDropLook); a hook the agent set with a room's own token on
// another link stays. Joins nothing. The work after the cut runs under
// waitUntil and the answer waits for it, so a caller that goes away does
// not cut it short (the platform gives such work about 30 seconds; past
// that, rooms not reached keep their wakes, and the gadget's Disconnect
// stops every wake).
export async function agentRoute(rc: RouteContext): Promise<Response> {
  const res = await agentAnswer(rc);
  return rc.request.method === "HEAD" ? new Response(null, { status: res.status, headers: res.headers }) : res;
}
async function agentAnswer(rc: RouteContext): Promise<Response> {
  const { request, env } = rc;
  const method = request.method;
  if (method !== "GET" && method !== "HEAD" && method !== "DELETE") return json({ error: "Method not allowed" }, 405);
  const k = await openKey(env, request);
  if (k.variant !== "ok") return refusedJson(KEY_REFUSED[k.variant]);
  if (method === "DELETE") {
    // the key is cut first; the list comes back from the cut itself
    const d = await k.key.stub.agentDrop("key", k.key.verifier);
    if (!d.ok) return refusedJson(KEY_REFUSED.invalid);
    // a list that does not open is no reason to keep the key working: it is
    // cut, and the answer says its wakes could not be turned off (the slot,
    // gone now, held the same wrapped data key the open read)
    const list = await agentUnseal(k.key.id, k.key.secret, k.key.wrapped, d.ver, d.ring);
    if (!list) return json({ deleted: true, rooms: [], muse_wakes_removed: [], muse_wakes_left: null, note: dropNote(null) });
    const work = dropWakes(env, list.rooms);
    rc.ctx.waitUntil(work.catch(() => undefined));
    const w = await work;
    if (w.left.length) warn("agent.drop", null, { left: w.left.length });
    return json({ deleted: true, rooms: list.rooms.map((e) => e.room), muse_wakes_removed: w.removed, muse_wakes_left: w.left, note: dropNote(w.left) });
  }
  const u = await unseal(k.key);
  if (!u) return refusedJson(UNREADABLE);
  return json({ rooms: u.rooms.map(entryView), max_rooms: AGENT_ROOMS_MAX, created: u.created });
}

/* ---------- POST /api/agent/rooms and /api/agent/rooms/remove ---------- */

/** Puts entries on the key (REST's list, or MCP add_room's one): a room
 *  already held is refused, one the room refused since is replaced in
 *  place, the key holds AGENT_ROOMS_MAX at most, and every new room's token
 *  is looked up, in order, before anything is written. */
type Added = Refused | { rooms: Array<{ room: string, name: string, opened: boolean }>, rooms_held: number };
async function addRooms(env: Env, u: Unsealed, entries: Array<{ room: string, token: string }>, rest: boolean): Promise<Rewritten<Added>> {
  return rewrite<Added>(u, async (x): Promise<Changed<Added>> => {
    for (let i = 0; i < entries.length; i++) {
      const held = x.rooms.find((e) => e.room === entries[i].room);
      if (held && held.state === "held") return { answer: { status: 409, code: "room_held", error: about(rest ? i : null, entries[i].room + " is already on this key", false), room: entries[i].room } };
    }
    const fresh = new Set(entries.map((e) => e.room));
    if (x.rooms.filter((e) => !fresh.has(e.room)).length + entries.length > AGENT_ROOMS_MAX) return { answer: { status: 429, code: "limit_reached", error: "This key holds at most " + AGENT_ROOMS_MAX + " rooms; take one off first (remove_room)." } };
    const found: Array<{ room: string, token: string, name: string, opened: boolean }> = [];
    for (const e of entries) {
      const l = await entryLookup(env, e);
      if (!l.ok) return { answer: l };
      found.push(l.entry);
    }
    const now = Date.now();
    const rooms = x.rooms.slice();
    for (const f of found) {
      const entry: AgentEntry = { room: f.room, token: f.token, name: f.name, added: now, state: "held" };
      const at = rooms.findIndex((e) => e.room === f.room);
      if (at >= 0) rooms[at] = entry;
      else rooms.push(entry);
    }
    return { rooms, then: { rooms: found.map((f) => ({ room: f.room, name: f.name, opened: f.opened })), rooms_held: rooms.length } };
  });
}

/** Takes one room off the key. A room where the key set up a Muse wake
 *  (its entry's hook) has that wake turned off first, and goes off the
 *  list only once the room has answered (the wake removed; kept, as it is
 *  not the key's any more; or the seat gone, with its hook): once the room
 *  is off the key nothing but the gadget could turn that wake off (with a
 *  key a person made, the agent holds no token of that room), and a wake
 *  for a room the agent can no longer read through its key serves nobody.
 *  A room that cannot be reached stays on the key, its wake on: try_again. */
type Removed = Refused | { room: string, removed: true, muse_wake_removed?: true, note: string };
async function removeRoom(env: Env, u: Unsealed, room: string): Promise<Rewritten<Removed>> {
  return rewrite<Removed>(u, async (x): Promise<Changed<Removed>> => {
    const e = x.rooms.find((y) => y.room === room);
    if (!e) return { answer: { status: 404, code: "room_not_held", error: room + " is not on this key.", room } };
    const rooms = x.rooms.filter((y) => y.room !== room);
    const note = "Your seat stays: you are still a member of " + room + ". To leave it for good, call leave_room through the key, or use the room's own address.";
    if (!e.hook) return { rooms, then: { room, removed: true as const, note } };
    if ((await dropWake(env, e)) === "left") return { answer: { status: 503, code: "try_again", error: room + " could not be reached to turn off the Muse wake this key set up there, so it is still on this key and its wake is still on. Try again shortly.", room, retry_after: 1 } };
    return { rooms, then: { room, removed: true as const, muse_wake_removed: true as const, note: note + " The Muse wake this key set up in " + room + " is off." } };
  });
}

// POST /api/agent/rooms {"rooms": [{"room", "token"}]} with the key: more
// rooms on it, each the caller's own agent invite, every token looked up
// first (a look: joins nothing). No creation cap: no key is made.
export async function agentRoomsRoute(rc: RouteContext): Promise<Response> {
  const { request, env } = rc;
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const k = await openKey(env, request);
  if (k.variant !== "ok") return refusedJson(KEY_REFUSED[k.variant]);
  const small = await settleBody(request, SMALL_BODY_MAX);
  if (!small) return json({ error: BODY_TOO_LARGE }, 413);
  const b = await readBody(small);
  const list = b ? b.rooms : undefined;
  if (!Array.isArray(list) || list.length < 1 || list.length > AGENT_ROOMS_MAX) return refusedJson(roomsListRefusal());
  const seen = new Set<string>();
  const entries: Array<{ room: string, token: string }> = [];
  for (let i = 0; i < list.length; i++) {
    const e = entryShape(list[i], i, seen);
    if ("status" in e) return refusedJson(e);
    entries.push(e);
  }
  const u = await unseal(k.key);
  if (!u) return refusedJson(UNREADABLE);
  const r = await addRooms(env, u, entries, true);
  if (!("done" in r) && !("answer" in r)) return rewriteRefusal(r);
  const out = "done" in r ? r.done : r.answer;
  return "status" in out ? refusedJson(out) : json(out, 201);
}

// POST /api/agent/rooms/remove {"room"} with the key: the key forgets the
// room (the room in the body, out of a logged URL). The seat and everything
// else in the room stay, but for the Muse wake the key set up there, which
// is turned off first (removeRoom).
export async function agentRemoveRoute(rc: RouteContext): Promise<Response> {
  const { request, env } = rc;
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const k = await openKey(env, request);
  if (k.variant !== "ok") return refusedJson(KEY_REFUSED[k.variant]);
  const small = await settleBody(request, SMALL_BODY_MAX);
  if (!small) return json({ error: "That request's body is too large: send {\"room\"}." }, 413);
  const b = await readBody(small);
  const room = fieldText(b ? b.room : undefined).trim().toLowerCase();
  if (!ROOM_RE.test(room)) return json({ error: ROOM_NAME_RULE }, 400);
  const u = await unseal(k.key);
  if (!u) return refusedJson(UNREADABLE);
  const r = await removeRoom(env, u, room);
  if (!("done" in r) && !("answer" in r)) return rewriteRefusal(r);
  const out = "done" in r ? r.done : r.answer;
  return "status" in out ? refusedJson(out) : json(out);
}

/* ---------- the person's way: POST /api/agents/invite and /api/agent/rooms/invite ---------- */

// A person makes a key for their agent (the web app's Home, Agent keys): in
// each room the person names, the site creates the agent's seat with the
// person's own invite, exactly as the person could by inviting it (the
// room's invite(), with its daily and active caps and its name rules, the
// person's token looked up again in the call that writes), and puts it on
// the key at once, so the new invites' tokens go into the sealed list and
// into no answer, to the page or to the agent. How a person's invite is
// told from an agent's, at every step: only an invite the room stores as
// kind human invites (one with no kind counts as an agent's, as access()
// reports it); every seat made is kind agent; a seat reused is an agent's,
// invited_by the inviter's name exactly as the room stores it, and invited
// no earlier than the inviter's own invite (invited_by is a name, and a
// name passes to a new holder once its invite is revoked: a seat an earlier
// holder of the name invited is not this person's); and a reused seat's
// token is looked up again before it goes on the key. So a person's own
// seat never goes on a key. Nothing here opens an invite or marks anyone
// seen: the inviters and the seats are only looked up (lookupInvite,
// nameHeld, inviteLoad, members), and invite() writes no used or seen (only
// Room.access does). A refused inviter learns nothing about its room: no
// seat is planned there and no counter of that room is read.

/** How an entry may find its seat: "unused" (the default) reuses an
 *  unused agent seat of that name the same person invited, "any" also one
 *  already in use, "none" never. */
type Reuse = "unused" | "any" | "none";
/** One entry of a person's body, its shape checked: its place in the list,
 *  the room, the person's own token there, the agent's name there, how a
 *  seat may be reused. */
type PersonEntry = { i: number, room: string, inviter: string, name: string, reuse: Reuse };
/** The person's invite in a room, as the look found it: its name as the
 *  room stores it, and when it was made. */
type Inviter = { name: string, created: number };
/** A seat for an entry: a new invite to make, or an agent seat to reuse. */
type Seat = { seat: "new", name: string } | { seat: "reused", name: string, token: string, opened: boolean };
/** An entry and what was found for it so far: its inviter once its look
 *  passed, its seat once planned, or why not. */
type Planned = { e: PersonEntry, inviter?: Inviter, seat?: Seat, problem?: Refused };

const PERSON_BODY_TOO_LARGE = "That request's body is too large: send {\"name\", \"rooms\": [{\"room\", \"inviter_token\"}]}.";

/** One entry's shape, checked before any object call (entryShape's rules,
 *  with inviter_token in place of token), then the agent's name there (the
 *  entry's own, else the body's) as the members route checks a new name,
 *  and reuse. */
function personShape(v: unknown, i: number, seen: Set<string>, topName: unknown): PersonEntry | Refused {
  if (!isObject(v)) return { status: 400, error: "rooms[" + i + "] must be an object: {\"room\", \"inviter_token\"}" };
  const room = fieldText(v.room).trim().toLowerCase();
  if (!ROOM_RE.test(room)) return { status: 400, error: about(i, ROOM_NAME_RULE), room: echo(room) };
  if (seen.has(room)) return { status: 400, error: about(i, room + " is listed twice", false), room };
  seen.add(room);
  const inviter = fieldText(v.inviter_token).trim();
  if (!inviter) return { status: 401, code: "invite_missing", error: about(i, "\"inviter_token\" is required: your own invite token for " + room), room };
  if (inviter.charAt(0) === ".") return { status: 403, code: "invite_invalid", error: about(i, "that is an agent key, not a room invite token"), room };
  const name = cleanName(fieldText(v.name)) || cleanName(fieldText(topName));
  if (!name) return { status: 400, error: about(i, "\"name\" is required: the agent's name in " + room), room };
  const problem = memberNameProblem(name);
  if (problem) return { status: 400, error: about(i, problem), room };
  if (nameFold(name) === "referee") return { status: 400, error: about(i, "\"Referee\" is a reserved name - it belongs to the room's game official and cannot be a member."), room };
  const reuse = v.reuse === undefined || v.reuse === null ? "unused" : v.reuse;
  if (reuse !== "unused" && reuse !== "any" && reuse !== "none") return { status: 400, error: about(i, "\"reuse\" must be \"unused\", \"any\" or \"none\""), room };
  return { i, room, inviter, name, reuse };
}

/** The body of both routes: the list (1 to AGENT_ROOMS_MAX) and every
 *  entry's shape, and whether it only asks (check: the boolean true). */
function personBody(b: Body | null): { entries: PersonEntry[], check: boolean } | Refused {
  const list = b ? b.rooms : undefined;
  if (!Array.isArray(list) || list.length < 1 || list.length > AGENT_ROOMS_MAX) return { status: 400, error: "\"rooms\" must list 1 to " + AGENT_ROOMS_MAX + " rooms: [{\"room\", \"inviter_token\"}], with your own invites" };
  const seen = new Set<string>();
  const entries: PersonEntry[] = [];
  for (let i = 0; i < list.length; i++) {
    const e = personShape(list[i], i, seen, b ? b.name : undefined);
    if ("status" in e) return e;
    entries.push(e);
  }
  return { entries, check: !!b && b.check === true };
}

/** What a room says of an entry's inviter: a look (lookupInvite), which
 *  opens nothing. A room with no storage answers as the room routes answer
 *  an unknown name (no other room method is asked of it); an agent's
 *  invite, or one stored with no kind, invites no one onto a key. */
async function inviterLookup(env: Env, e: PersonEntry): Promise<{ ok: true, inviter: Inviter } | (Refused & { ok: false })> {
  const l: InviteLookup = await roomStub(env, e.room).lookupInvite(e.inviter);
  if (!l.ok) {
    if (l.code === "room_deleted") return { ok: false, status: 404, error: "No room with that name yet. Create it from the home page.", room: e.room };
    return { ok: false, status: l.status, code: l.code, error: "Room \"" + e.room + "\": " + l.error, room: e.room };
  }
  if (l.row.kind !== "human") return { ok: false, status: 403, code: "not_person_invite", error: "Room \"" + e.room + "\": this is an agent's invite. Only a person's own invite can invite an agent onto a key.", room: e.room };
  return { ok: true, inviter: { name: l.row.name, created: l.row.created } };
}

/** A refusal without the ok flag a lookup's answer carries beside it. */
function refusalOnly(r: Refused & { ok: false }): Refused {
  const out: Refused = { status: r.status, error: r.error };
  if (r.code !== undefined) out.code = r.code;
  if (r.room !== undefined) out.room = r.room;
  if (r.retry_after !== undefined) out.retry_after = r.retry_after;
  return out;
}

/** The refusal's own fields, for a list that carries it beside its room. */
function asProblem(r: Refused): { status: number, code?: string, error: string } {
  return r.code !== undefined ? { status: r.status, code: r.code, error: r.error } : { status: r.status, error: r.error };
}

/** Every entry still without a problem gets its inviter looked up, in
 *  order. all (a check) records each refusal as its entry's problem;
 *  otherwise the first refusal is the answer. */
async function lookInviters(env: Env, planned: Planned[], all: boolean): Promise<Refused | null> {
  for (const p of planned) {
    if (p.problem) continue;
    const l = await inviterLookup(env, p.e);
    if (!l.ok) {
      const r = refusalOnly(l);
      if (!all) return r;
      p.problem = r;
      continue;
    }
    p.inviter = l.inviter;
  }
  return null;
}

/** The two caps of a room's invite(), worded as the members route words
 *  them (routes/members.ts), for room R. */
function dayCap(room: string, retryAfter: number): Refused {
  return { status: 429, code: "rate_limited", error: "Room \"" + room + "\": You can create up to " + MEMBER_INVITES_PER_DAY + " invites a day", room, retry_after: retryAfter };
}
function activeCap(room: string): Refused {
  return { status: 429, code: "limit_reached", error: "Room \"" + room + "\": This room already has " + MAX_ACTIVE_INVITES + " active invites", room };
}

/** An entry's seat, planned from what the room itself says, read only:
 *  whether invite() would take the name as held (nameHeld, the very test it
 *  applies) and, when it would, the room's members (members()) only to find
 *  a seat of this person's to reuse; when it would not, the inviter's load
 *  (inviteLoad, what invite() counts against its caps). Nothing is rebuilt
 *  here from rows: the room's own methods answer. */
async function planSeat(stub: DurableObjectStub, e: PersonEntry, inv: Inviter): Promise<{ ok: true, seat: Seat } | (Refused & { ok: false })> {
  const R = "Room \"" + e.room + "\": ";
  if (await stub.nameHeld(e.name, null)) {
    if (e.reuse !== "none") {
      const list = await stub.members();
      const mine = list.members.find((m) => m.status !== "revoked" && sameName(m.name, e.name) && m.kind !== "human" && m.invited_by === inv.name && m.invited >= inv.created);
      if (mine && mine.status === "unused") return { ok: true, seat: { seat: "reused", name: mine.name, token: mine.invite_token, opened: false } };
      if (mine && e.reuse === "any") return { ok: true, seat: { seat: "reused", name: mine.name, token: mine.invite_token, opened: true } };
      if (mine) return { ok: false, status: 409, code: "seat_in_use", error: R + mine.name + " is already a member here, invited by you: use that seat, or pick another name.", room: e.room };
    }
    return { ok: false, status: 409, code: "name_taken", error: R + e.name + " is already taken here. Pick another name.", room: e.room };
  }
  const load = await stub.inviteLoad(inv.name);
  if (load.recent >= MEMBER_INVITES_PER_DAY) return { ok: false, ...dayCap(e.room, Math.max(1, Math.ceil(((load.oldest || Date.now()) + 86400e3 - Date.now()) / 1000))) };
  if (load.active >= MAX_ACTIVE_INVITES) return { ok: false, ...activeCap(e.room) };
  return { ok: true, seat: { seat: "new", name: e.name } };
}

/** Every entry whose inviter passed gets its seat planned, in order; all
 *  (a check) records each refusal as its entry's problem, otherwise the
 *  first is the answer. No other entry's room is asked anything. */
async function planSeats(env: Env, planned: Planned[], all: boolean): Promise<Refused | null> {
  for (const p of planned) {
    if (p.problem || !p.inviter) continue;
    const s = await planSeat(roomStub(env, p.e.room), p.e, p.inviter);
    if (!s.ok) {
      const r = refusalOnly(s);
      if (!all) return r;
      p.problem = r;
      continue;
    }
    p.seat = s.seat;
  }
  return null;
}

/** An entry as a check answers it: its seat, or its problem alone (a
 *  refused inviter's entry says nothing else about its room). */
function plannedView(p: Planned) {
  if (p.problem || !p.seat) return { room: p.e.room, name: p.e.name, problem: asProblem(p.problem || { status: 500, error: "Not checked." }) };
  return { room: p.e.room, name: p.seat.name, seat: p.seat.seat, opened: p.seat.seat === "reused" ? p.seat.opened : false };
}

/** A seat made or reused: what goes on the key, and what the answer says of it. */
type SeatNow = { seat: "new" | "reused", token: string, name: string, opened: boolean };

/** Makes or reuses an entry's planned seat. A reused one is looked up again
 *  first (still unrevoked, an agent's, invited_by the inviter, and unused
 *  unless reuse is any); one that is no longer that is planned again, as it
 *  is now. A new one is the room's invite(name, "agent", inviter, caps,
 *  inviter's token), which looks the inviter's token up again in the step
 *  that writes; each new invite's room goes into made. A room call that
 *  throws (a room on older code during a deploy, say) is refused with
 *  unreached. */
async function seatNow(env: Env, p: Planned, made: string[], unreached: string): Promise<SeatNow | Refused> {
  const room = p.e.room, inv = p.inviter as Inviter;
  const stub = roomStub(env, room);
  let plan = p.seat as Seat;
  try {
    if (plan.seat === "reused") {
      const l: InviteLookup = await stub.lookupInvite(plan.token);
      if (l.ok && l.row.kind !== "human" && l.row.invited_by === inv.name && sameName(l.row.name, plan.name) && (p.e.reuse === "any" || !l.row.used)) return { seat: "reused", token: plan.token, name: l.row.name, opened: !!l.row.used };
      const again = await planSeat(stub, p.e, inv);
      if (!again.ok) return refusalOnly(again);
      plan = again.seat;
      if (plan.seat === "reused") return { seat: "reused", token: plan.token, name: plan.name, opened: plan.opened };
    }
    const r = await stub.invite(plan.name, "agent", inv.name, { perDay: MEMBER_INVITES_PER_DAY, maxActive: MAX_ACTIVE_INVITES }, p.e.inviter);
    if (!r) return { status: 409, code: "name_taken", error: "Room \"" + room + "\": " + plan.name + " is already taken here. Pick another name.", room };
    if ("ok" in r) return { status: r.status, code: r.code, error: "Room \"" + room + "\": " + r.error, room };
    if ("limit" in r) return r.limit === "day" ? dayCap(room, ("retry_after" in r && r.retry_after) || 3600) : activeCap(room);
    made.push(room);
    return { seat: "new", token: r.token, name: r.name, opened: false };
  } catch {
    return { status: 500, error: "Room \"" + room + "\" " + unreached, room };
  }
}

/** The fields a failed call adds once it has made invites: their rooms
 *  (left_unused), and the sentence that says they stay unused. */
function unusedFields(made: string[]): Record<string, unknown> | undefined {
  return made.length ? { left_unused: made.slice(), note: unusedNote(made) } : undefined;
}

/** A new identity with no rooms yet, and its key: made first, so that each
 *  seat goes on it the moment it is made. One more try with a new id when
 *  the id names an object that exists. */
async function emptyIdentity(env: Env): Promise<{ key: string, u: Unsealed } | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const k = newAgentKey();
    const verifier = await agentVerifier(k.id, k.secret);
    const { dk, wrapped } = await agentDataKey(k.id, k.secret);
    const stub = identity(env, k.id);
    const ring = await agentSealRing(dk, k.id, 1, []);
    const r = await stub.agentMake(verifier, wrapped, ring);
    if (r.ok) return { key: k.key, u: { stub, id: k.id, secret: k.secret, verifier, wrapped, ver: 1, ring, created: r.created, dk, rooms: [] } };
    if (r.code !== "exists") return null;
  }
  return null;
}

// POST /api/agents/invite {"name", "rooms": [{"room", "inviter_token",
// "name"?, "reuse"?}], "check"?: true}: a new key whose seats are agent
// invites the site makes, or reuses, with the person's own invites (the
// person's tokens in the body, as POST /api/muse/hooks takes them; no
// Authorization and no owner key is read). In order: the method; the body
// (at most SMALL_BODY_MAX); the list; every entry's shape (no object asked
// yet); every inviter looked up, in order; each seat planned (reads only);
// with check, the answer is here: what the call would do, with the
// counters only peeked at (agentPeek: the network's and the site's, and
// only the rooms' whose inviter passed), and nothing is written anywhere;
// without it the first refusal is the answer, nothing counted. Then the
// caps (agentReserve, as POST /api/agents). Then, under waitUntil with the
// answer awaiting it (as room creation does), so a caller that goes away
// does not cut it short (the platform gives such work about 30 seconds;
// past that it stops as the Worker would midway: the identity holds the
// seats added so far, and an invite made but not yet added is an unused
// agent seat of this person's, which a retry reuses): the identity, made
// empty, then each seat in order, made or reused, and put on the key at
// once. A failure after that keeps the invites this call made, unopened,
// and names them (left_unused): trying again with the same name reuses
// them, so no second invite is made (revoking them would spend the
// person's daily invites in every room on each try, since the cap counts
// revoked invites too). The key goes and its counted places are given
// back. Joins nothing.
export async function agentInviteCreateRoute(rc: RouteContext): Promise<Response> {
  const { request, env, url } = rc;
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const small = await settleBody(request, SMALL_BODY_MAX);
  if (!small) return json({ error: PERSON_BODY_TOO_LARGE }, 413);
  const pb = personBody(await readBody(small));
  if ("status" in pb) return refusedJson(pb);
  const planned: Planned[] = pb.entries.map((e) => ({ e }));
  let stop = await lookInviters(env, planned, pb.check);
  if (stop) return refusedJson(stop);
  stop = await planSeats(env, planned, pb.check);
  if (stop) return refusedJson(stop);
  const caps = await creationCaps(request, planned.filter((p) => p.inviter).map((p) => p.e.room));
  const q = quota(env);
  if (pb.check) {
    const wait = await q.agentPeek(caps);
    const full = typeof wait === "number" && wait > 0;
    const out: { ok: boolean, rooms: unknown[], retry_after?: number } = { ok: !full && planned.every((p) => !p.problem), rooms: planned.map(plannedView) };
    if (full) out.retry_after = wait;
    return json(out);
  }
  const got = await q.agentReserve(caps);
  if (!Array.isArray(got)) {
    if (typeof got === "number") return rateLimited("Too many agent keys were made just now, from this network, for one of these rooms or on the whole site. Try again later.", got);
    return json({ error: "The key could not be made; nothing was kept. Try again." }, 500);
  }
  const work = personKeyNow(env, url, q, got, planned);
  rc.ctx.waitUntil(work.catch(() => undefined));
  return await work;
}

async function personKeyNow(env: Env, url: URL, q: DurableObjectStub, got: string[], planned: Planned[]): Promise<Response> {
  const made: string[] = [];
  let id: Unsealed | null = null;
  let kept = false;
  const fail = (r: Refused) => refusedJson(r, undefined, unusedFields(made));
  try {
    const k = await emptyIdentity(env);
    if (!k) return json({ error: "The key could not be made; nothing was kept. Try again." }, 500);
    id = k.u;
    let u = k.u;
    const rooms: Array<{ room: string, name: string, opened: boolean, seat: "new" | "reused" }> = [];
    for (const p of planned) {
      const s = await seatNow(env, p, made, "could not be reached, so no key was made. Try again.");
      if ("status" in s) return fail(s);
      const entry: AgentEntry = { room: p.e.room, token: s.token, name: s.name, added: Date.now(), state: "held" };
      const w = await rewrite<true>(u, async (x): Promise<Changed<true>> => ({ rooms: x.rooms.concat([entry]), then: true }));
      if (!("done" in w)) return fail("busy" in w ? { ...BUSY, retry_after: 1 } : { status: 500, error: "The key could not be made. Try again." });
      u = w.after;
      rooms.push({ room: p.e.room, name: s.name, opened: s.opened, seat: s.seat });
    }
    kept = true;
    const address = url.origin + "/api/mcp";
    return json({
      key: k.key, address, rooms, max_rooms: AGENT_ROOMS_MAX,
      // both hold the word KEY where the key goes, so the key is in the answer once
      claude_code: personKeyClaudeCode(address),
      handoff: personKeyHandoff(url.origin, rooms.map((r) => r.room)),
      note: personKeyNote(rooms.some((r) => r.seat === "reused")),
    }, 201);
  } catch (e) {
    warn("agent.person", e && (e as Error).name ? (e as Error).name : "failed");
    return fail({ status: 500, error: made.length ? "The key could not be made. Try again." : "The key could not be made; nothing was kept. Try again." });
  } finally {
    // a key not made whole goes, and its places come back once
    if (!kept) {
      if (id) { try { await id.stub.agentDrop("key", id.verifier); } catch (e) { warn("agent.drop", e && (e as Error).name ? (e as Error).name : "failed"); } }
      try { await q.agentRelease(got); } catch (e) { warn("agent.release", e); }
    }
  }
}

// POST /api/agent/rooms/invite with the key as Authorization: Bearer and
// the body of POST /api/agents/invite: more seats made, or reused, with
// the person's own invites, on a key the person holds. In order: the
// method; the key; the body; the list; every entry's shape; the key's list
// (500 agent_unreadable); a room already on the key and held (409
// room_held); the most rooms a key holds (429 limit_reached, counted as
// add_room counts: a room the key holds that the room has refused is
// replaced in place and counts once); every inviter looked up, in order;
// each seat planned. check answers there and writes nothing (a held room is
// its entry's problem, the most rooms a problem of the whole call). No
// creation counter is taken: no key is made. Then, under waitUntil with the
// answer awaiting it, each seat in order, made or reused and put on the key
// at once. A failure takes this call's entries off the key again and keeps
// the invites it made, unopened (left_unused), as creation does. Joins nothing.
export async function agentInviteAddRoute(rc: RouteContext): Promise<Response> {
  const { request, env } = rc;
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const k = await openKey(env, request);
  if (k.variant !== "ok") return refusedJson(KEY_REFUSED[k.variant]);
  const small = await settleBody(request, SMALL_BODY_MAX);
  if (!small) return json({ error: PERSON_BODY_TOO_LARGE }, 413);
  const pb = personBody(await readBody(small));
  if ("status" in pb) return refusedJson(pb);
  const u = await unseal(k.key);
  if (!u) return refusedJson(UNREADABLE);
  const planned: Planned[] = pb.entries.map((e) => {
    const h = u.rooms.find((x) => x.room === e.room);
    return h && h.state === "held" ? { e, problem: { status: 409, code: "room_held", error: about(e.i, e.room + " is already on this key", false), room: e.room } } : { e };
  });
  const firstHeld = planned.find((p) => p.problem);
  if (firstHeld && !pb.check) return refusedJson(firstHeld.problem as Refused);
  const fresh = new Set(planned.filter((p) => !p.problem).map((p) => p.e.room));
  const over: Refused | null = u.rooms.filter((x) => !fresh.has(x.room)).length + fresh.size > AGENT_ROOMS_MAX ? { status: 429, code: "limit_reached", error: "This key holds at most " + AGENT_ROOMS_MAX + " rooms; take one off first (remove_room)." } : null;
  if (over && !pb.check) return refusedJson(over);
  let stop = await lookInviters(env, planned, pb.check);
  if (stop) return refusedJson(stop);
  stop = await planSeats(env, planned, pb.check);
  if (stop) return refusedJson(stop);
  if (pb.check) {
    const out: { ok: boolean, rooms: unknown[], problem?: unknown } = { ok: !over && planned.every((p) => !p.problem), rooms: planned.map(plannedView) };
    if (over) out.problem = asProblem(over);
    return json(out);
  }
  const work = personAddNow(env, u, planned);
  rc.ctx.waitUntil(work.catch(() => undefined));
  return await work;
}

async function personAddNow(env: Env, first: Unsealed, planned: Planned[]): Promise<Response> {
  const made: string[] = [];
  const added: AgentEntry[] = [];
  let u = first;
  let kept = false;
  const fail = (r: Refused) => refusedJson(r, undefined, unusedFields(made));
  try {
    const rooms: Array<{ room: string, name: string, opened: boolean, seat: "new" | "reused" }> = [];
    for (const p of planned) {
      const s = await seatNow(env, p, made, "could not be reached, so it was not added. Try again.");
      if ("status" in s) return fail(s);
      const entry: AgentEntry = { room: p.e.room, token: s.token, name: s.name, added: Date.now(), state: "held" };
      const w = await rewrite<Refused | null>(u, async (x): Promise<Changed<Refused | null>> => {
        const h = x.rooms.find((y) => y.room === entry.room);
        if (h && h.state === "held") return { answer: { status: 409, code: "room_held", error: about(p.e.i, entry.room + " is already on this key", false), room: entry.room } };
        if (!h && x.rooms.length + 1 > AGENT_ROOMS_MAX) return { answer: { status: 429, code: "limit_reached", error: "This key holds at most " + AGENT_ROOMS_MAX + " rooms; take one off first (remove_room)." } };
        return { rooms: h ? x.rooms.map((y) => (y.room === entry.room ? entry : y)) : x.rooms.concat([entry]), then: null };
      });
      if ("answer" in w) return fail(w.answer || { status: 500, error: "The rooms could not be added. Try again." });
      if (!("done" in w)) return fail("gone" in w ? KEY_REFUSED.invalid : "unreadable" in w ? UNREADABLE : { ...BUSY, retry_after: 1 });
      u = w.after;
      added.push(entry);
      rooms.push({ room: p.e.room, name: s.name, opened: s.opened, seat: s.seat });
    }
    kept = true;
    return json({ rooms, rooms_held: u.rooms.length }, 201);
  } catch (e) {
    warn("agent.person", e && (e as Error).name ? (e as Error).name : "failed");
    return fail({ status: 500, error: "The rooms could not be added. Try again." });
  } finally {
    // this call's entries come off the key again (each by its room and token,
    // so an entry another call put there meanwhile stays)
    if (!kept && added.length) {
      try {
        await rewrite<true>(u, async (x): Promise<Changed<true>> => ({ rooms: x.rooms.filter((y) => !added.some((a) => a.room === y.room && a.token === y.token)), then: true }));
      } catch (e) { warn("agent.person", e && (e as Error).name ? (e as Error).name : "failed"); }
    }
  }
}

/* ---------- POST /api/mcp ---------- */

/** A refused key as a tools/call answers it: -32001 with data.code. */
function keyError(r: Refused & { code: string }): ToolAnswer {
  return { error: { code: -32001, message: r.error, data: { code: r.code } } };
}
const UNREADABLE_RPC: ToolAnswer = { error: { code: -32603, message: AGENT_UNREADABLE } };
/** A rewrite that did not happen, as a tools/call answers it. */
function rewriteRpc(r: { busy: true } | { gone: true } | { unreadable: true }): ToolAnswer {
  if ("gone" in r) return keyError(KEY_REFUSED.invalid);
  if ("unreadable" in r) return UNREADABLE_RPC;
  return refusedTool(BUSY);
}

// POST /api/mcp with the key as Authorization: Bearer: one MCP server for
// every room on the key (agents/mcp.ts mcpAgentCatalog), both kinds of
// protocol revision, served by mcpServe as the room's own address is
// (routes/agents.ts). Before the body: the method, and the credential,
// once (one call to the key's object), which decides the instructions and
// how big a body is read: SMALL_BODY_MAX without a current key,
// SETTLED_BODY_MAX with one, read whole before any room is asked. No batch,
// for anyone: the key is checked once per HTTP request, and a batch would
// go on acting after a disconnect.
export async function agentMcpRoute(rc: RouteContext): Promise<Response> {
  const { request, env, url } = rc;
  if (request.method !== "POST") return json({ error: "Method not allowed. POST JSON-RPC here; call tools/list for the catalog." }, 405);
  const k = await openKey(env, request);
  const refusal = k.variant === "ok" ? null : KEY_REFUSED[k.variant];
  const body = await settleBody(request, refusal ? SMALL_BODY_MAX : SETTLED_BODY_MAX);
  if (!body) return json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: refusal ? "Request too large: without a valid agent key a request can be up to " + Math.floor(SMALL_BODY_MAX / MIB) + " MiB" : "Request too large: a request can be up to " + Math.floor(SETTLED_BODY_MAX / MIB) + " MiB" } }, 413);
  let rpcBody: unknown = null;
  try { rpcBody = await body.json(); } catch { return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error: send one JSON-RPC request object" } }, 400); }
  if (Array.isArray(rpcBody)) return json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request: this address takes no batches; send each request as its own POST." } }, 400);
  return mcpServe(rc, {
    serverInfo: agentServerInfo(url.origin),
    catalog: mcpAgentCatalogBuilt,
    catalogVersion: MCP_AGENT_CATALOG_VERSION,
    has: mcpHasAgentTool,
    instructions: agentInstructions(url.origin, k.variant),
    verdict: async () => (refusal ? { ok: false as const, error: refusal.error, code: refusal.code } : { ok: true as const }),
    unknownVerdict: async () => (refusal ? { error: refusal.error, code: refusal.code } : null),
    say: (r: Worded) => r,
    tool: async (name, args) => (k.variant !== "ok" ? keyError(KEY_REFUSED[k.variant]) : agentTool(rc, k.key, name, args)),
  }, rpcBody);
}

/** A tools/call at the agent key's address, of a tool in its catalog. The
 *  key is opened again first, now that the body is in: a key disconnected
 *  while its request held the body back acts nowhere (as a room checks its
 *  token after the body). */
async function agentTool(rc: RouteContext, first: Opened, name: string, args: Body): Promise<ToolAnswer> {
  const { env } = rc;
  const o = await reopen(first);
  if (!o) return keyError(KEY_REFUSED.invalid);
  const u = await unseal(o);
  if (!u) return UNREADABLE_RPC;
  if (name === "list_rooms") return { result: mcpOk({ rooms: u.rooms.map(entryView), max_rooms: AGENT_ROOMS_MAX, created: u.created }) };
  if (name === "whats_waiting") return glance(env, u);
  if (name === "add_room") {
    const e = entryShape({ room: args.room, token: args.token }, null, new Set());
    if ("status" in e) return refusedTool(e);
    const r = await addRooms(env, u, [e], false);
    if (!("done" in r) && !("answer" in r)) return rewriteRpc(r);
    const out = "done" in r ? r.done : r.answer;
    return "status" in out ? refusedTool(out) : { result: mcpOk({ ...out.rooms[0], rooms_held: out.rooms_held }) };
  }
  if (name === "remove_room") {
    const room = fieldText(args.room).trim().toLowerCase();
    if (!ROOM_RE.test(room)) return { result: mcpErr(ROOM_NAME_RULE) };
    const r = await removeRoom(env, u, room);
    if (!("done" in r) && !("answer" in r)) return rewriteRpc(r);
    const out = "done" in r ? r.done : r.answer;
    return "status" in out ? refusedTool(out) : { result: mcpOk(out) };
  }
  if (name === "muse_register") return museRegister(env, u, args);
  return roomTool(rc, u, name, args);
}

/** One room's answer in muse_register, as POST /api/muse/hooks answers it. */
type WakeResult = { room: string, ok: true, name: string, hook: unknown } | { room: string, ok: false, status: number, code: string, error: string };

/** A room's answer when its call throws (a room still on older code just after a deploy, say). */
function unreachedWake(room: string): WakeResult {
  return { room, ok: false, status: 503, code: "try_again", error: room + " could not be reached just now: register it again shortly." };
}

// muse_register {code, routing?, rooms?}: the person's Muse woken by rooms
// on the key, with one gadget code for the batch, as POST /api/muse/hooks
// does with room tokens, through two room methods that look the key's
// token up and open nothing (museSetHookLook; museDropLook to undo). So it
// joins nothing and marks nobody seen: a room the agent has not joined yet
// is skipped (a wake would join it). In order: the code and routing as the
// REST route checks them; which rooms (the ones named, each on the key, or
// every held room); a look in each (lookupInvite, as entryLookup asks), so
// the code is not spent on rooms that refuse; the claim, once; each
// accepted room's hook recorded on the key's list (hook: the link id,
// sealed) before it is set, so a disconnect or a take-off that comes after
// finds it; the hooks set; then the key opened again, and any hook whose
// room left the key meanwhile (or the whole key, disconnected) turned off
// again. The bridge is asked what the REST route asks it: /claim once,
// /rooms once per hook set. The link id is in no answer.
async function museRegister(env: Env, u: Unsealed, args: Body): Promise<ToolAnswer> {
  const code = fieldText(args.code).trim();
  if (!code) return { result: mcpErr("\"code\" is required: the one-time link code your Muse gave you") };
  if (code.length > MUSE_CODE_MAX) return { result: mcpErr("\"code\" is longer than " + MUSE_CODE_MAX + " characters") };
  const rawRouting = fieldText(args.routing).trim();
  const routing = rawRouting ? museRouting(rawRouting) : MUSE_ROUTING_DEFAULT;
  if (!routing) return { result: mcpErr(MUSE_ROUTING_ERROR) };
  let asked: AgentEntry[];
  if (args.rooms === undefined || args.rooms === null) asked = u.rooms.filter((e) => e.state === "held");
  else {
    const list = args.rooms;
    const rule = "\"rooms\" must list 1 to " + AGENT_ROOMS_MAX + " rooms on your key by name, or be left out for every room on it";
    if (!Array.isArray(list) || list.length < 1 || list.length > AGENT_ROOMS_MAX) return { result: mcpErr(rule) };
    asked = [];
    for (const raw of list) {
      if (typeof raw !== "string" || !raw.trim()) return { result: mcpErr(rule) };
      const room = raw.trim().toLowerCase();
      if (!ROOM_RE.test(room)) return { result: mcpErr(ROOM_NAME_RULE) };
      const e = u.rooms.find((x) => x.room === room);
      if (!e) return { result: mcpErr(room + " is not on your key: list_rooms lists yours; add_room adds one.", { code: "room_not_held", room }) };
      if (!asked.includes(e)) asked.push(e);
    }
  }
  // first pass: a look in each room, in order (an entry the room refused before is not asked again)
  const results: WakeResult[] = [];
  const accepted: Array<{ i: number, e: AgentEntry }> = [];
  const marks: Array<{ room: string, token: string, code: string }> = [];
  for (const e of asked) {
    if (e.state === "refused") {
      results.push({ room: e.room, ok: false, status: e.code === "room_deleted" ? 404 : 403, code: e.code || "invite_invalid", error: "This room has refused the invite on your key" + (e.code ? " (" + e.code + ")" : "") + ": take it off with remove_room." });
      continue;
    }
    let l: InviteLookup;
    try { l = await roomStub(env, e.room).lookupInvite(e.token); } catch { results.push(unreachedWake(e.room)); continue; /* reported in its room's result */ }
    if (!l.ok) {
      marks.push({ room: e.room, token: e.token, code: l.code });
      results.push(l.code === "room_deleted" ? { room: e.room, ok: false, status: 404, code: "room_deleted", error: "No room with that name yet. Create it from the home page." } : { room: e.room, ok: false, status: l.status, code: l.code, error: l.error });
      continue;
    }
    if (!l.row.used) { results.push({ room: e.room, ok: false, status: 409, code: "not_joined", error: MUSE_NOT_JOINED }); continue; }
    results.push(unreachedWake(e.room)); // filled in below
    accepted.push({ i: results.length - 1, e });
  }
  if (marks.length) await markRefused(u, marks);
  if (!accepted.length) return { result: mcpErr("No room on your key took its invite, so the code was not used.", { code: "no_rooms", results }) };
  // the code, claimed once for every room
  const bridge = museBridge(env);
  const c = await museClaim(bridge, code);
  if (!c.ok) return { result: mcpErr(c.error, c.code === "rate_limited" ? { code: c.code, retry_after: c.retry_after } : { code: c.code }) };
  const link = c.link;
  // recorded on the key before any hook is set (each entry by its room and token)
  const rec = await rewrite<Set<number>>(u, async (x): Promise<Changed<Set<number>>> => {
    const kept = new Set<number>();
    const rooms = x.rooms.map((e) => {
      const a = accepted.findIndex((y) => y.e.room === e.room && y.e.token === e.token);
      if (a < 0) return e;
      kept.add(a);
      return { ...e, hook: link };
    });
    return { rooms, then: kept };
  });
  if (!("done" in rec)) return "answer" in rec ? UNREADABLE_RPC : rewriteRpc(rec);
  const notHeld = (room: string): WakeResult => ({ room, ok: false, status: 404, code: "room_not_held", error: room + " is no longer on your key." });
  // the hooks, each set with a look at the room's own invite
  const set: Array<{ i: number, e: AgentEntry }> = [];
  let unreached = 0;
  for (const [n, a] of accepted.entries()) {
    if (!rec.done.has(n)) { results[a.i] = notHeld(a.e.room); continue; }
    try {
      const s = await roomStub(env, a.e.room).museSetHookLook(a.e.token, link, routing, a.e.room);
      if (!s.ok) { results[a.i] = { room: a.e.room, ok: false, status: s.status, code: s.code, error: s.error }; continue; }
      results[a.i] = { room: a.e.room, ok: true, name: s.name, hook: s.hook };
      set.push(a);
    } catch { unreached++; results[a.i] = unreachedWake(a.e.room); continue; /* counted, and logged below with no room */ }
    // the bridge counts the link's rooms for the gadget (best effort: never fails the registration)
    await museReportRoom(bridge, link, a.e.room, true);
  }
  if (unreached) warn("agent.muse", null, { unreached });
  // checked after they are set: a disconnect, or a take-off, that came in between turns them off again
  if (set.length) {
    const o = await reopen(u);
    if (!o) {
      for (const a of set) await dropWake(env, { ...a.e, hook: link });
      return keyError(KEY_REFUSED.invalid);
    }
    const now = await unseal(o);
    if (now) {
      for (const a of set) {
        if (now.rooms.some((e) => e.room === a.e.room && e.token === a.e.token && e.hook === link)) continue;
        await dropWake(env, { ...a.e, hook: link });
        results[a.i] = notHeld(a.e.room);
      }
    }
  }
  return { result: mcpOk({ claimed: true, results }) };
}

/** A room tool through the key: the room it names must be on the key; then
 *  the room is asked exactly what the same call at its own address asks -
 *  the look that address makes once per request (lookupInvite, which opens
 *  nothing), then roomToolAnswer with the token the key holds, owner false.
 *  A refusal of the token is the tool's error {code, room}, and the room is
 *  marked refused on the key; a leave marks it left. */
async function roomTool(rc: RouteContext, u: Unsealed, name: string, args: Body): Promise<ToolAnswer> {
  const raw = args.room;
  if (typeof raw !== "string" || !raw.trim()) return { result: mcpErr("\"room\" is required: one of your rooms, as list_rooms gives it") };
  const room = raw.trim().toLowerCase();
  if (!ROOM_RE.test(room)) return { result: mcpErr(ROOM_NAME_RULE) };
  const e = u.rooms.find((x) => x.room === room);
  if (!e) return { result: mcpErr(room + " is not on your key: list_rooms lists yours; add_room adds one.", { code: "room_not_held", room }) };
  const stub = roomStub(rc.env, room);
  const look = stub.lookupInvite(e.token).then((l: InviteLookup) => (l.ok ? { ok: true as const } : l));
  let refused: string | null = null;
  const refuse = (r: Worded): ToolAnswer => { refused = r.code; return { result: mcpErr("Room \"" + room + "\": " + r.error, { code: r.code, room }) }; };
  const tk: { ok: true } | Refusal = await look;
  // the tool's own arguments, as the room's address takes them
  const targs: Body = Object.fromEntries(Object.entries(args).filter(([key]) => key !== "room"));
  let a: ToolAnswer = tk.ok ? await roomToolAnswer({ rc, stub, room, invite: e.token, owner: false, checkToken: () => look, missing: inviteMissing, refuse, viaKey: true }, name, targs) : refuse(tk);
  // the mark is the key's own bookkeeping: if it cannot be written, the
  // room's answer goes out as it was (the next call marks it)
  if (refused) await markRefused(u, [{ room, token: e.token, code: refused }]);
  else if (name === "leave_room" && "result" in a && !(a.result as { isError?: boolean }).isError) {
    const left = (a.result as { structuredContent?: Record<string, unknown> }).structuredContent || {};
    if (await markRefused(u, [{ room, token: e.token, code: left.room_deleted ? "room_deleted" : "invite_revoked" }])) {
      a = { result: mcpOk({ ...left, key: room + " is marked left on your key; take it off with remove_room." }) };
    }
  }
  return a;
}

/** whats_waiting's gap: AGENT_GLANCE_GAP_S, or what the API suite's test
 *  hook set on the quota object (TEST_HOOKS only: no call is made live). */
async function glanceGapMs(env: Env): Promise<number> {
  if (!env.TEST_HOOKS) return AGENT_GLANCE_GAP_S * 1000;
  const t = await quota(env).agentTestLimits();
  return t.glance_gap_ms > 0 ? t.glance_gap_ms : AGENT_GLANCE_GAP_S * 1000;
}

// whats_waiting: what waits on the agent in every room on the key, from
// each room's start-page view (startView: a look, so it joins no room and
// marks the agent seen nowhere), AGENT_GLANCE_PARALLEL rooms at a time, at
// most once per AGENT_GLANCE_GAP_S per key. Every room on the key is named
// once, in the key's order: under rooms (opened or not), or under refused -
// a room marked refused already, with its code and since when, and not
// asked again; a room that refuses its token now, which is marked on the
// key; or a room whose call fails (one still on older code, say), as
// unavailable, not marked. The lines it logs carry counts only, never a room.
async function glance(env: Env, u: Unsealed): Promise<ToolAnswer> {
  const wait = await u.stub.agentGlanceTake(await glanceGapMs(env));
  if (wait > 0) return { result: mcpErr("whats_waiting answers at most once " + pollGap(AGENT_GLANCE_GAP_S) + " for a key; try again in " + spanS(wait) + ".", { code: "rate_limited", retry_after: wait }) };
  const seen: Array<{ e: AgentEntry, v: StartView | Refusal | null }> = u.rooms.map((e) => ({ e, v: null }));
  const asked = seen.filter((s) => s.e.state === "held");
  let next = 0, failed = 0;
  const lane = async () => {
    while (next < asked.length) {
      const s = asked[next++];
      try { s.v = await roomStub(env, s.e.room).startView(s.e.token, s.e.room); } catch { failed++; /* counted, and logged below with no room */ }
    }
  };
  await Promise.all(Array.from({ length: Math.min(AGENT_GLANCE_PARALLEL, asked.length) }, lane));
  const rooms: unknown[] = [];
  const refused: Array<{ room: string, code: string, at?: number }> = [];
  const marks: Array<{ room: string, token: string, code: string }> = [];
  for (const { e, v } of seen) {
    if (e.state === "refused") { refused.push(e.at === undefined ? { room: e.room, code: e.code || "" } : { room: e.room, code: e.code || "", at: e.at }); continue; }
    if (!v) { refused.push({ room: e.room, code: "unavailable" }); continue; }
    if (!v.ok) { refused.push({ room: e.room, code: v.code }); marks.push({ room: e.room, token: e.token, code: v.code }); continue; }
    rooms.push({
      room: e.room, name: v.invite.name, opened: v.opened,
      awaiting: v.awaiting.map((i) => { const m = mcpCallOf(i, undefined, e.room); return m ? { ...i, mcp_call: m } : i; }),
      awaiting_more: v.awaiting_more,
      since: v.since && { count: v.since.count, for_you: v.since.for_you },
    });
  }
  if (failed) warn("agent.glance", null, { unavailable: failed });
  if (marks.length) await markRefused(u, marks);
  return { result: mcpOk({ rooms, refused }) };
}
