// The agent key's routes. An agent key holds an agent's invites to several
// rooms, sealed in an identity of its own (room/agent.ts stores it,
// lib/agentkey.ts holds the key's forms and the sealing):
//   POST   /api/agents               a key from the caller's own agent invites
//   GET    /api/agent                the key's rooms (HEAD: the headers)
//   POST   /api/agent/rooms          more rooms on the key
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
// run access() do). No answer here carries a room's token or mints a lasting
// credential, so a key that is disconnected reaches nothing it held.
//
// The credential is read only from Authorization: Bearer (never
// X-Invite-Token, never X-Owner-Key). A caller with no valid key learns
// nothing about any room or key and writes nothing: a refused key makes at
// most one call to an object that does not exist or does not match, and no
// room is asked. No route here has a room or a credential in its URL, and
// nothing here logs a room's name, a token, a key or its id.

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
  MCP_ECHO_MAX,
  MIB,
  ROOM_RE,
  SETTLED_BODY_MAX,
  SMALL_BODY_MAX,
  pollGap,
  spanS,
} from "../limits.js";
import { isObject, json, rateLimited, readBody, settleBody, type Body } from "../lib/http.js";
import { AGENT_UNREADABLE, agentCredential, agentDataKey, agentSealRing, agentUnseal, agentVerifier, newAgentKey, type AgentEntry } from "../lib/agentkey.js";
import { hashKey, networkKey } from "../lib/address.js";
import { warn } from "../lib/log.js";
import { AGENT_KEY_INVALID, AGENT_KEY_MISSING, NOT_AGENT_KEY, agentInstructions, agentKeyNote, type AgentVariant } from "../agents/onboarding.js";
import { MCP_AGENT_CATALOG_VERSION, agentServerInfo, mcpAgentCatalogBuilt, mcpCallOf, mcpErr, mcpHasAgentTool, mcpOk } from "../agents/mcp.js";
import { mcpServe, roomToolAnswer, type ToolAnswer, type Worded } from "./agents.js";
import type { RouteContext } from "../index.js";
import { inviteMissing, type InviteLookup, type Refusal, type StartView } from "../room/Room.js";
import type { AgentCap } from "../room/agent.js";

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

/** A refusal: its status, code (when it has one), sentence and room (when it names one). */
type Refused = { status: number, code?: string, error: string, room?: string };

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
type Rewritten<T> = { done: T } | { answer: T } | { busy: true } | { gone: true } | { unreadable: true };

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
    const s = await u.stub.agentSwap("key", u.verifier, u.ver, await agentSealRing(u.dk, u.id, u.ver + 1, c.rooms));
    if (s.ok) return { done: c.then };
    if (s.code !== "stale") return { gone: true };
    u = null;
  }
  return { busy: true };
}

/** A room as the key's listings show it: never its token. */
function entryView(e: AgentEntry) {
  const out: { room: string, name: string, added: number, state: string, code?: string, at?: number } = { room: e.room, name: e.name, added: e.added, state: e.state };
  if (e.code !== undefined) out.code = e.code;
  if (e.at !== undefined) out.at = e.at;
  return out;
}

/** Marks rooms the rooms refused (each by its room and the token that was
 *  refused, so a room put back on the key with a new token meanwhile is left
 *  alone): a write, tried twice, then left (the next call marks it). */
async function markRefused(u: Unsealed, marks: Array<{ room: string, token: string, code: string }>): Promise<void> {
  const at = Date.now();
  await rewrite<boolean>(u, async (x): Promise<Changed<boolean>> => {
    let changed = false;
    const rooms = x.rooms.map((e) => {
      const m = marks.find((k) => k.room === e.room && k.token === e.token);
      if (!m || (e.state === "refused" && e.code === m.code)) return e;
      changed = true;
      return { ...e, state: "refused" as const, code: m.code, at };
    });
    return changed ? { rooms, then: true } : { answer: true };
  }, 2);
}

/* ---------- the entries: {room, token} ---------- */

/** A body field as text: a string as sent, a number as its digits, anything else none. */
function fieldText(v: unknown): string {
  return typeof v === "string" ? v : typeof v === "number" && Number.isFinite(v) ? String(v) : "";
}
/** A sentence about one entry: "rooms[i]: ..." in a REST body's list, the
 *  sentence alone (capitalized) for MCP add_room's one room. */
function about(i: number | null, s: string): string {
  return i === null ? s.charAt(0).toUpperCase() + s.slice(1) : "rooms[" + i + "]: " + s;
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
  if (seen.has(room)) return { status: 400, error: about(i, room + " is listed twice"), room };
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

/** A refusal as a REST answer: {error, code?, room?}. */
function refusedJson(r: Refused, headers?: Record<string, string>): Response {
  const body: { error: string, code?: string, room?: string } = { error: r.error };
  if (r.code !== undefined) body.code = r.code;
  if (r.room !== undefined) body.room = r.room;
  return json(body, r.status, headers);
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

/** The creation counters of one new key, each with its window: the
 *  network per AGENT_KEYS_WINDOW_S, the site per UTC day, and each room
 *  the key holds per UTC day, the network and the rooms as hashes. */
async function creationCaps(request: Request, rooms: string[], now: number): Promise<AgentCap[]> {
  const win = Math.floor(now / (AGENT_KEYS_WINDOW_S * 1000));
  const hour = new Date(win * AGENT_KEYS_WINDOW_S * 1000).toISOString().slice(0, 16);
  const d = new Date(now);
  const day = d.toISOString().slice(0, 10);
  const dayEnds = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
  const caps: AgentCap[] = [
    { k: "net:" + (await hashKey(networkKey(request.headers.get("CF-Connecting-IP")))) + ":" + hour, w: hour, max: AGENT_KEYS_PER_IP, ends: (win + 1) * AGENT_KEYS_WINDOW_S * 1000 },
    { k: "all:" + day, w: day, max: AGENT_KEYS_PER_DAY, ends: dayEnds },
  ];
  for (const room of rooms) caps.push({ k: "room:" + (await hashKey(room)) + ":" + day, w: day, max: AGENT_KEYS_PER_ROOM_DAY, ends: dayEnds });
  return caps;
}

// POST /api/agents {"rooms": [{"room", "token"}]}: a new key holding the
// caller's own agent invites. Joins nothing and changes nothing in any room.
// In order: the method, the body (at most SMALL_BODY_MAX), the list, every
// entry's shape (no object asked yet), the first room's look, the caps
// (taken only then, so a wrong token costs no place), the other rooms'
// looks in order (the first refused gives the places back and is the
// answer), then the identity, made at once. Nothing is made unless every
// room took its token.
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
  const first = await entryLookup(env, entries[0]);
  if (!first.ok) return refusedJson(first);
  const now = Date.now();
  const caps = await creationCaps(request, entries.map((e) => e.room), now);
  const q = quota(env);
  const got = await q.agentReserve(caps);
  if (got !== true) {
    if (typeof got === "number") return rateLimited("Too many agent keys were made just now, from this network, for one of these rooms or on the whole site. Try again later.", got);
    return json({ error: "The key could not be made; nothing was kept. Try again." }, 500);
  }
  let made = false;
  try {
    const found = [first.entry];
    for (const e of entries.slice(1)) {
      const l = await entryLookup(env, e);
      if (!l.ok) return refusedJson(l);
      found.push(l.entry);
    }
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
    if (!made) { try { await q.agentRelease(caps.map((c) => c.k)); } catch (e) { warn("agent.release", e); } }
  }
}

/* ---------- GET, HEAD and DELETE /api/agent ---------- */

// GET /api/agent with the key: its rooms (never a token), the most it can
// hold and when it was made; HEAD the same headers. DELETE disconnects it
// everywhere: the identity goes, the key works nowhere from then on, and
// every seat stays in its room (as does any token the agent kept). Joins nothing.
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
  const u = await unseal(k.key);
  if (method === "DELETE") {
    // a list that does not open is no reason to keep the key working
    const rooms = u ? u.rooms.map((e) => e.room) : [];
    const d = await k.key.stub.agentDrop("key", k.key.verifier);
    if (!d.ok) return refusedJson(KEY_REFUSED.invalid);
    return json({ deleted: true, rooms, note: "This key works nowhere now. Every seat stays: you are still a member of these rooms, and any room token you kept still works." });
  }
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
      if (held && held.state === "held") return { answer: { status: 409, code: "room_held", error: about(rest ? i : null, entries[i].room + " is already on this key"), room: entries[i].room } };
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

/** Takes one room off the key. */
type Removed = Refused | { room: string, removed: true, note: string };
async function removeRoom(u: Unsealed, room: string): Promise<Rewritten<Removed>> {
  return rewrite<Removed>(u, async (x): Promise<Changed<Removed>> => {
    if (!x.rooms.some((e) => e.room === room)) return { answer: { status: 404, code: "room_not_held", error: room + " is not on this key.", room } };
    return { rooms: x.rooms.filter((e) => e.room !== room), then: { room, removed: true as const, note: "Your seat stays: you are still a member of " + room + ". To leave it for good, call leave_room through the key, or use the room's own address." } };
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
// room (the room in the body, out of a logged URL). The seat, its hooks and
// everything else in the room stay.
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
  const r = await removeRoom(u, room);
  if (!("done" in r) && !("answer" in r)) return rewriteRefusal(r);
  const out = "done" in r ? r.done : r.answer;
  return "status" in out ? refusedJson(out) : json(out);
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
    const r = await removeRoom(u, room);
    if (!("done" in r) && !("answer" in r)) return rewriteRpc(r);
    const out = "done" in r ? r.done : r.answer;
    return "status" in out ? refusedTool(out) : { result: mcpOk(out) };
  }
  return roomTool(rc, u, name, args);
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
  if (refused) await markRefused(u, [{ room, token: e.token, code: refused }]);
  else if (name === "leave_room" && "result" in a && !(a.result as { isError?: boolean }).isError) {
    const left = (a.result as { structuredContent?: Record<string, unknown> }).structuredContent || {};
    await markRefused(u, [{ room, token: e.token, code: left.room_deleted ? "room_deleted" : "invite_revoked" }]);
    a = { result: mcpOk({ ...left, key: room + " is marked left on your key; take it off with remove_room." }) };
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
// most once per AGENT_GLANCE_GAP_S per key. A room that refuses its token is
// listed under refused and marked on the key; a room whose call fails (a
// room still on older code, say) is listed as unavailable, not marked. The
// lines it logs carry counts only, never a room.
async function glance(env: Env, u: Unsealed): Promise<ToolAnswer> {
  const wait = await u.stub.agentGlanceTake(await glanceGapMs(env));
  if (wait > 0) return { result: mcpErr("whats_waiting answers at most once " + pollGap(AGENT_GLANCE_GAP_S) + " for a key; try again in " + spanS(wait) + ".", { code: "rate_limited", retry_after: wait }) };
  const held = u.rooms.filter((e) => e.state === "held");
  const seen: Array<{ e: AgentEntry, v: StartView | Refusal | null }> = held.map((e) => ({ e, v: null }));
  let next = 0, failed = 0;
  const lane = async () => {
    while (next < seen.length) {
      const s = seen[next++];
      try { s.v = await roomStub(env, s.e.room).startView(s.e.token, s.e.room); } catch { failed++; /* counted, and logged below with no room */ }
    }
  };
  await Promise.all(Array.from({ length: Math.min(AGENT_GLANCE_PARALLEL, seen.length) }, lane));
  const rooms: unknown[] = [];
  const refused: Array<{ room: string, code: string }> = [];
  const marks: Array<{ room: string, token: string, code: string }> = [];
  for (const { e, v } of seen) {
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
