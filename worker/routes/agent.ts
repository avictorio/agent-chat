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
//   POST   /api/agent/rooms/leave    the agent leaves one of the key's rooms,
//                                    which comes off the key
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
  AGENT_WAKE_ITEMS_MAX,
  AGENT_WAKE_LINK_MAX,
  AGENT_WAKE_RETRY_MS,
  AGENT_WAKE_SET_MS,
  AGENT_WAKE_SKEW_MS,
  MAX_ACTIVE_INVITES,
  MCP_ECHO_MAX,
  MEMBER_INVITES_PER_DAY,
  MIB,
  MUSE_CODE_MAX,
  ROOM_RE,
  SIGNIN_SCOPE,
  SETTLED_BODY_MAX,
  SMALL_BODY_MAX,
  pollGap,
  spanS,
} from "../limits.js";
import { BadRequest, CORS_SIGNIN, isObject, json, rateLimited, readBody, settleBody, type Body } from "../lib/http.js";
import { isGoneError } from "../lib/errors.js";
import { AGENT_UNREADABLE, agentCredential, agentDataKey, agentSealRing, agentUnseal, agentVerifier, clearPre, newAgentKey, newHolderTag, newRecordingId, tagsKept, withTag, type AgentEntry } from "../lib/agentkey.js";
import { keepsWakes, wakeAnswered, wakeExpired, wakeLinksAfter, wakeRecord, wakeSettle, wakeWeight, type WakeSeen } from "../lib/wakes.js";
import { hashKey, networkKey } from "../lib/address.js";
import { cleanName, memberNameProblem, nameFold, sameName } from "../lib/text.js";
import { warn } from "../lib/log.js";
import {
  AGENT_KEY_INVALID, AGENT_KEY_MISSING, LEAVE_NO_DELETE, NOT_AGENT_KEY, activeCapError, agentInstructions, agentKeyNote, claudeCodeLine, dayCapError, dropBusy, dropNote, leaveEntryRefused,
  leaveLastMember, leaveNote, leaveNotJoined, leaveRoomGone, mcpJsonEntry, nameTakenError, notPersonInviteError, personKeyHandoff, personKeyNote, removedHeldNote, removedRefusedNote, seatInUseError, unusedNote,
  wakeAgain, wakeLinkUnusable, wakeLost, wakeNotSettled, wakeStillSetting, type AgentVariant, type LeaveKept, type WakeSaid, type Who,
  AGENT_KEY_INVALID as KEY_INVALID_SENTENCE, SIGNIN_TOKEN_ENDED, signinInstructions, signinLeaveNote, signinNeeded, signinNotHeld, signinRemovedNote, signinRoomHeld, signinWrongInstructions, signinWrongInvite, signinWrongKey,
} from "../agents/onboarding.js";
import { leaveAfter, leaveAsk, leaveBody, leaveConfirmRefusal } from "./members.js";
import type { LastMemberRefusal, LeaveResult } from "../room/members.js";
import { MCP_AGENT_CATALOG_VERSION, MCP_SIGNIN_CATALOG_VERSION, agentServerInfo, mcpAgentCatalogBuilt, mcpCallOf, mcpErr, mcpHasAgentTool, mcpHasSigninTool, mcpOk, mcpSigninCatalogBuilt, signinServerInfo } from "../agents/mcp.js";
import { signinCredential, signinOrigin } from "../lib/oauth.js";
import { openSigninAccess } from "./oauth.js";
import { mcpServe, roomToolAnswer, type ToolAnswer, type Worded } from "./agents.js";
import { museClaim } from "./muse.js";
import type { RouteContext } from "../index.js";
import { inviteMissing, type InviteLookup, type Refusal, type StartView } from "../room/Room.js";
import type { AgentCap } from "../room/agent.js";
import { MUSE_ROUTING_DEFAULT, MUSE_ROUTING_ERROR, museBridge, museNotJoined, museReportRoom, museRouting } from "../room/muse.js";

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
/** What the routes' list functions need of an identity, a key or a sign-in
 *  (routes/oauth.ts signinCred): its open (the list as it is now; null once
 *  cut, revoked or gone, rewrite's "gone"), the room list opened from what
 *  an open read (null when it does not open, logged as agentUnseal logs),
 *  and the new list sealed at the next version and swapped in, compare-and-
 *  set on the version read. Nothing else in the routes knows which kind of
 *  identity it has but the words it answers with (via). */
export type Cred = {
  open(): Promise<Opened | null>,
  unseal(o: Opened): Promise<Unsealed | null>,
  swap(u: Unsealed, rooms: AgentEntry[]): Promise<{ ok: true, ring: string } | { ok: false, code?: "stale" }>,
};
/** An identity opened: its object and id, what its open read (the wrapped
 *  data key; for a sign-in the wake key wrapped too; the list's version and
 *  sealed list; when it was made), its credential, and which kind it is. */
export type Opened = { stub: DurableObjectStub, id: string, wrapped: string | null, wk?: string | null, ver: number, ring: string, created: number, cred: Cred, via: Who };
/** ... and the list opened (for a sign-in, with its wake key). */
export type Unsealed = Opened & { dk: Uint8Array<ArrayBuffer>, rooms: AgentEntry[], wkBytes?: Uint8Array<ArrayBuffer> };

/** The key's credential: the four calls the key's routes have always made,
 *  agentOpen and agentSwap on its slot "key", agentUnseal and agentSealRing. */
function keyCred(k: Keyed): Cred {
  const cred: Cred = {
    async open() {
      const o = await k.stub.agentOpen("key", k.verifier);
      return o.ok ? { stub: k.stub, id: k.id, wrapped: o.wrapped, ver: o.ver, ring: o.ring, created: o.created, cred, via: "key" } : null;
    },
    async unseal(o) {
      const u = await agentUnseal(k.id, k.secret, o.wrapped, o.ver, o.ring);
      return u ? { ...o, dk: u.dk, rooms: u.rooms } : null;
    },
    async swap(u, rooms) {
      const ring = await agentSealRing(u.dk, u.id, u.ver + 1, rooms);
      const s = await k.stub.agentSwap("key", k.verifier, u.ver, ring);
      return s.ok ? { ok: true, ring } : s;
    },
  };
  return cred;
}

/** A refusal: its status, code (when it has one), sentence, room (when it
 *  names one) and, for a cap that resets with time, the seconds until it
 *  does (sent over REST as Retry-After). */
export type Refused = { status: number, code?: string, error: string, room?: string, retry_after?: number };

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
  const o = await keyCred({ stub, id: c.id, secret: c.secret, verifier }).open();
  if (!o) return { variant: "invalid" };
  return { variant: "ok", key: o };
}

/** The identity opened again (its list as it is now); null once disconnected. */
async function reopen(k: Opened): Promise<Opened | null> {
  return k.cred.open();
}

/** The list opened with the identity's credential; null when it does not open (logged, lib/agentkey.ts). */
async function unseal(k: Opened): Promise<Unsealed | null> {
  return k.cred.unseal(k);
}

/** The key opened again once a request's body is in, and its list as that
 *  open finds it, for every REST route of the key that takes a body: a
 *  client can hold a body back for as long as the platform lets it hold
 *  one, and the key may be disconnected meanwhile, so what the key may do
 *  is decided when the body is in, as the MCP address decides it (agentTool).
 *  A key that no longer opens is refused (agent_key_invalid), a list that
 *  does not open is agent_unreadable (room: the room the refusal names). */
async function keyAfterBody(first: Opened, room?: string): Promise<Unsealed | Response> {
  const o = await reopen(first);
  if (!o) return refusedJson(KEY_REFUSED.invalid);
  const u = await unseal(o);
  return u || refusedJson(room === undefined ? UNREADABLE : { ...UNREADABLE, room });
}

/** A change to the key's list: the new list and what to answer, with the
 *  rooms' observations (lib/wakes.ts) on which recorded Muse wake links
 *  leave it, each stamped with the version this change read (seen), and
 *  the recordings that are this call's own (own: the ids of the sets it
 *  sent and saw answered), or only an answer (nothing written). */
type Changed<T> = { rooms: AgentEntry[], then: T, seen?: WakeSeen[], own?: string[] } | { answer: T };

/** What a rewrite came to: done (with the list as it now stands, after
 *  its swap), an answer that wrote nothing, or a swap that did not happen. */
type Rewritten<T> = { done: T, after: Unsealed } | { answer: T } | { busy: true } | { gone: true } | { unreadable: true };

/** Changes the identity's list, compare-and-set: change gets the list as
 *  stored (asking a room anything it needs after that read, so an
 *  observation it makes is stamped with that version); pre is dropped from
 *  every entry the new list leaves with no recorded link (clearPre); the new
 *  list is checked (keepsWakes, against the version read, and tagsKept),
 *  sealed at the next version and swapped in (the credential's swap), and on
 *  a stale swap (another call wrote meanwhile) the list is read again and
 *  the change made again, its observations taken again, tries times at most.
 *  A swap the object refuses otherwise means the identity was disconnected
 *  (cut) meanwhile (gone). */
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
    const rooms = clearPre(c.rooms);
    keepsWakes(u.ver, u.rooms, rooms, c.seen || [], c.own || []);
    tagsKept(u.rooms, rooms);
    const s = await u.cred.swap(u, rooms);
    if (s.ok) return { done: c.then, after: { ...u, ver: u.ver + 1, ring: s.ring, rooms } };
    if (s.code !== "stale") return { gone: true };
    u = null;
  }
  return { busy: true };
}

/** A room as the key's listings show it: never its token, and never the
 *  link id of a Muse wake the key set up there: muse_wake says the key
 *  records one it set up (and turns it off when the room is taken off or
 *  the key disconnected); the room's hook may have been replaced since. */
function entryView(e: AgentEntry) {
  const out: { room: string, name: string, added: number, state: string, code?: string, at?: number, muse_wake?: true } = { room: e.room, name: e.name, added: e.added, state: e.state };
  if (e.code !== undefined) out.code = e.code;
  if (e.at !== undefined) out.at = e.at;
  if (e.hooks && e.hooks.length) out.muse_wake = true;
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
export async function creationCaps(request: Request, rooms: string[]): Promise<AgentCap[]> {
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
// (a failure after the caps gives the places back, once; from the caps on
// the work runs under waitUntil, registered before the counters are
// taken). Nothing is made unless every room took its token.
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
  // from the counters on, under waitUntil: places taken are made into a key or given back
  return await outlive(rc, () => agentKeyNow(env, url, caps, found));
}

async function agentKeyNow(env: Env, url: URL, caps: AgentCap[], found: Array<{ room: string, token: string, name: string, opened: boolean }>): Promise<Response> {
  const q = quota(env);
  const got = await q.agentReserve(caps);
  if (!Array.isArray(got)) {
    if (typeof got === "number") return rateLimited("Too many agent keys were made just now, from this network, for one of these rooms or on the whole site. Try again later.", got);
    return json({ error: "The key could not be made; nothing was kept. Try again." }, 500);
  }
  let made = false;
  try {
    const now = Date.now();
    const rooms: AgentEntry[] = found.map((f) => ({ room: f.room, token: f.token, name: f.name, added: now, state: "held", tag: newHolderTag() }));
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
          claude_code: claudeCodeLine(address),
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

/* ---------- the Muse wakes a key set up ---------- */

// The record of the wakes a key set up, and the one rule that takes a link
// off it, are lib/wakes.ts's (its comment says why it holds): a call
// records a set before sending it and, after the room's answer, takes off
// its own recording only; a link leaves only in a settling write, on an
// observation of the room (observe, below) made after the list it writes
// from was read. The routes below settle: a take-off, an add over a refused
// entry and the entry of a seat that left through the key (dropWake), the
// disconnect (dropWakes), and muse_register at the bound and in its tidy.
// Each looks before it drops anything: while a recording may still reach
// the room (outstanding, and not yet expired by the room's clock: its
// registration still runs, was cut short, lost its set's answer, or could
// not write its own write) nothing is dropped, and a take-off or an add
// answers try_again, a leave keeps the entry marked left with its links,
// and the disconnect waits. Nothing waits once a registration's own write
// has taken its recordings off.

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Work that must not be cut short when its caller goes away: registered
 *  with waitUntil before it starts, so before its first write (the platform
 *  gives such work about 30 seconds after the answer), and awaited by the
 *  answer. */
export function outlive<T>(rc: RouteContext, work: () => Promise<T>): Promise<T> {
  let start = () => {};
  const p = new Promise<void>((r) => { start = r; }).then(work);
  rc.ctx.waitUntil(p.catch(() => undefined));
  start();
  return p;
}

/** The refusals of a hook method that say no hook can be filed for the
 *  token there: no row for the token, the room gone. */
const NO_SEAT = new Set(["invite_invalid", "room_missing", "room_deleted"]);

/** Asks the room about an entry's seat, after the list was read at version
 *  ver: a look, or a drop of one link; for an entry with a holder tag its
 *  own hold's (museHolderLook, museHolderDrop, with its token, counting the
 *  room's untagged holds as its own when it has pre; a sign-in's wake-list
 *  entry, whose token is its tag, with no token and no untagged holds: the
 *  tag's rows find its seat), for one without the untagged holds'
 *  (museHookLook, museDropLook). Its answer as an
 *  observation stamped with ver: link the Muse link the asked holds hold
 *  after the call, which is what lib/wakes.ts reads as the link the hook is
 *  on; on, beside it, the link the hook is on whoever holds it (null for a
 *  gone seat, whose hook went with it); removed whether the drop took the
 *  hook off. Null when it threw twice, AGENT_WAKE_RETRY_MS apart, sent no
 *  clock, or refused with a code NO_SEAT does not hold (bad_holder and
 *  holder_mismatch among them). A drop's answer that does not say which
 *  link is on after it settles the link it dropped and no other. */
async function observe(env: Env, e: AgentEntry, ver: number, drop: string | null): Promise<(WakeSeen & { removed: boolean, on?: string | null }) | null> {
  for (let i = 0; i < 2; i++) {
    if (i) await sleep(AGENT_WAKE_RETRY_MS);
    let r: { ok: boolean, removed?: boolean, link?: unknown, on?: unknown, code?: string, now?: unknown };
    try {
      const stub = roomStub(env, e.room);
      if (e.tag !== undefined) {
        // a wake-list entry is told by its token, which is its tag (a room's invite token is 18 bytes, a tag 16)
        const tok = e.token === e.tag ? null : e.token;
        const legacy = tok !== null && e.pre === true;
        r = drop === null ? await stub.museHolderLook(e.tag, tok, legacy) : await stub.museHolderDrop(e.tag, drop, tok, legacy);
      } else r = drop === null ? await stub.museHookLook(e.token) : await stub.museDropLook(e.token, drop);
    } catch { continue; /* asked once more, then none; the caller counts it */ }
    if (typeof r.now !== "number" || !Number.isFinite(r.now)) return null;
    const base = { room: e.room, token: e.token, ver, now: r.now };
    if (!r.ok) return NO_SEAT.has(String(r.code)) ? { ...base, link: null, on: null, removed: false } : null;
    const removed = drop !== null && !!r.removed;
    const on = typeof r.on === "string" || r.on === null ? { on: r.on } : {};
    if (typeof r.link === "string" || r.link === null) return { ...base, link: r.link, ...on, removed };
    return drop === null ? null : { ...base, link: null, only: drop, ...on, removed };
  }
  return null;
}

/** How long (ms) until every outstanding recording of the entry has
 *  expired by the room's clock now: 0 when none is outstanding. */
function stillOut(e: AgentEntry, now: number): number {
  let wait = 0;
  for (const h of e.hooks || []) for (const r of h.recs) if (!wakeExpired(r, now)) wait = Math.max(wait, r.deadline + AGENT_WAKE_SKEW_MS - now + 1);
  return wait;
}

/** One entry's wakes turned off as far as the room allows, from the list
 *  read at version ver: a look; while a recording may still reach the room,
 *  nothing is dropped (waitMax: how long the caller may wait for that, then
 *  look again); else, when the hook is one of the entry's links, it is
 *  dropped (museDropLook), whose answer is the observation. What it comes
 *  to: the last observation (null: none), the entry's links that stay
 *  after it, whether a hook went, and how long a recording may still land
 *  (wait: 0 once none may). */
type Cleared = { seen: (WakeSeen & { on?: string | null }) | null, stay: string[], removed: boolean, wait: number };
async function clear(env: Env, e: AgentEntry, ver: number, waitMax: number): Promise<Cleared> {
  const links = (e.hooks || []).map((h) => h.link);
  let o = await observe(env, e, ver, null);
  if (!o) return { seen: null, stay: links, removed: false, wait: 0 };
  let wait = stillOut(e, o.now);
  if (wait > 0 && waitMax > 0) {
    await sleep(Math.min(wait, waitMax));
    o = await observe(env, e, ver, null);
    if (!o) return { seen: null, stay: links, removed: false, wait: 0 };
    wait = stillOut(e, o.now);
  }
  let removed = false;
  if (wait === 0 && o.link !== null && links.includes(o.link)) {
    const d = await observe(env, e, ver, o.link);
    if (d) { o = d; removed = d.removed; }
  }
  return { seen: o, stay: wakeLinksAfter(e, o).map((h) => h.link), removed, wait };
}

/** Lets go of every Muse wake the identity recorded in one room, before its
 *  entry is taken off or replaced, from the list read at version ver
 *  (clear, waiting for nothing). Ready, with its observation, only when
 *  every link of the entry may leave on it; otherwise the try_again the
 *  caller answers, changing nothing: a recording that may still reach the
 *  room (nothing dropped), or a room that did not let every link go. Its
 *  on is the observation's: the link the hook is on after the call,
 *  whoever holds it (absent when the room found no member). */
async function dropWake(env: Env, e: AgentEntry, ver: number, who: Who = "key"): Promise<{ ok: true, seen: WakeSeen, removed: boolean, on?: string | null } | { ok: false, refused: Refused }> {
  const c = await clear(env, e, ver, 0);
  if (c.seen && c.wait > 0) {
    const sec = Math.max(1, Math.ceil(c.wait / 1000));
    return { ok: false, refused: { status: 503, code: "try_again", error: wakeStillSetting(e.room, sec, who), room: e.room, retry_after: sec } };
  }
  if (!c.seen || c.stay.length) return { ok: false, refused: { status: 503, code: "try_again", error: wakeNotSettled(e.room, who), room: e.room, retry_after: 1 } };
  const on = c.seen.on;
  return on === undefined ? { ok: true, seen: c.seen, removed: c.removed } : { ok: true, seen: c.seen, removed: c.removed, on };
}

/** What a take-off says of a wake it let go of: kept when the room says
 *  the hook is still on one of the links the entry recorded (another
 *  holder keeps it), else off; a missing on is not kept. */
function wakeSaid(e: AgentEntry, d: { on?: string | null }): "off" | "kept" {
  return typeof d.on === "string" && (e.hooks || []).some((h) => h.link === d.on) ? "kept" : "off";
}

/** The wakes a cut key set up, turned off from its list read at version
 *  ver: every entry that records one, AGENT_GLANCE_PARALLEL rooms at a
 *  time, each waiting for a recording that may still land at most
 *  AGENT_WAKE_SET_MS + AGENT_WAKE_SKEW_MS. Which rooms did not let every
 *  link go (with their entries as they stay), which let every link go with
 *  a hook taken off (never one of the first), and the observations. */
export async function dropWakes(env: Env, rooms: AgentEntry[], ver: number): Promise<{ removed: string[], left: string[], remain: AgentEntry[], seen: WakeSeen[] }> {
  const hooked = rooms.filter((e) => e.hooks && e.hooks.length);
  const got: Cleared[] = [];
  let next = 0;
  const lane = async () => {
    while (next < hooked.length) {
      const i = next++;
      got[i] = await clear(env, hooked[i], ver, AGENT_WAKE_SET_MS + AGENT_WAKE_SKEW_MS);
    }
  };
  await Promise.all(Array.from({ length: Math.min(AGENT_GLANCE_PARALLEL, hooked.length) }, lane));
  const seen = got.flatMap((g) => (g.seen ? [g.seen] : []));
  const remain = hooked.map((e) => wakeSettle([e], seen)[0]).filter((e) => e.hooks && e.hooks.length);
  return {
    removed: hooked.filter((_, i) => got[i].removed && !got[i].stay.length).map((e) => e.room),
    left: remain.map((e) => e.room),
    remain,
    seen,
  };
}

/* ---------- GET, HEAD and DELETE /api/agent ---------- */

// GET /api/agent with the key: its rooms (never a token), the most it can
// hold and when it was made; HEAD the same headers. DELETE disconnects it
// everywhere, in two steps. First the cut (agentCut): the key's slot is
// marked cut, and from then on the key opens nothing, every route and the
// MCP address refusing it as they refuse a key that does not exist, but
// this same DELETE. Then the Muse wakes the key set up (muse_register) are
// turned off, on the list as the cut read it, room by room with a look and
// a drop that open nothing (museHookLook, museDropLook: dropWakes); a hook
// the agent set with a room's own token on another link stays. When every
// one settled the identity is deleted (agentDrop, from the version read).
// When some did not, the list is written again, from that version, holding
// only the rooms whose wakes did not settle (agentRemain), and the answer
// names them; the record stays so, and the key opens nothing, until DELETE
// again with the same key settles them (nothing else removes it). A write
// that meets a newer list (another DELETE of the key meanwhile) reads it
// and asks the rooms again. Every seat stays in its room (as does any token the
// agent kept). Joins nothing. The whole of it, the cut included, runs under
// waitUntil, registered before the cut, and the answer waits for it, so a
// caller that goes away does not cut it short (the platform gives such work
// about 30 seconds; a Worker that stops in between leaves the key cut and
// its list as it was, for the next DELETE).
export async function agentRoute(rc: RouteContext): Promise<Response> {
  const res = await agentAnswer(rc);
  return rc.request.method === "HEAD" ? new Response(null, { status: res.status, headers: res.headers }) : res;
}
async function agentAnswer(rc: RouteContext): Promise<Response> {
  const { request, env } = rc;
  const method = request.method;
  if (method !== "GET" && method !== "HEAD" && method !== "DELETE") return json({ error: "Method not allowed" }, 405);
  if (method === "DELETE") {
    // a cut key is refused by openKey, as an unknown one: its own DELETE goes to the slot directly
    const c = agentCredential(request);
    if (c.kind !== "key") return refusedJson(KEY_REFUSED[c.kind === "bad" ? "invalid" : c.kind]);
    const stub = identity(env, c.id);
    const verifier = await agentVerifier(c.id, c.secret);
    return await outlive(rc, () => disconnect(env, stub, c.id, c.secret, verifier));
  }
  const k = await openKey(env, request);
  if (k.variant !== "ok") return refusedJson(KEY_REFUSED[k.variant]);
  const u = await unseal(k.key);
  if (!u) return refusedJson(UNREADABLE);
  return json({ rooms: u.rooms.map(entryView), max_rooms: AGENT_ROOMS_MAX, created: u.created });
}

/** DELETE /api/agent's two steps, the cut and the wakes (above). */
async function disconnect(env: Env, stub: DurableObjectStub, id: string, secret: Uint8Array<ArrayBuffer>, verifier: string): Promise<Response> {
  // what this call itself turned off, over its tries, and the key's rooms as its first read found them
  const removed = new Set<string>();
  let rooms: string[] | null = null;
  for (let t = 0; t < AGENT_SWAP_TRIES; t++) {
    const cut = await stub.agentCut("key", verifier);
    if (!cut.ok) {
      // refused at once: no such key. Refused after this call read it: another DELETE of the key deleted the
      // record meanwhile, which it does only once every wake on it settled, so the disconnect is complete
      if (rooms === null) return refusedJson(KEY_REFUSED.invalid);
      return json({ deleted: true, rooms, muse_wakes_removed: [...removed], muse_wakes_left: [], note: dropNote([]) });
    }
    // a list that does not open is no reason to keep the key: it goes, and
    // the answer says its wakes could not be turned off
    const list = await agentUnseal(id, secret, cut.wrapped, cut.ver, cut.ring);
    if (!list) {
      await stub.agentDrop("key", verifier);
      return json({ deleted: true, rooms: rooms || [], muse_wakes_removed: [...removed], muse_wakes_left: null, note: dropNote(null) });
    }
    if (rooms === null) rooms = list.rooms.map((e) => e.room);
    // the wakes, on observations made after this read of the list (its version)
    const w = await dropWakes(env, list.rooms, cut.ver);
    for (const r of w.removed) removed.add(r);
    const gone = [...removed].filter((r) => !w.left.includes(r));
    if (!w.left.length) {
      keepsWakes(cut.ver, list.rooms, [], w.seen);
      const r = await stub.agentDrop("key", verifier, cut.ver);
      if (r.ok) return json({ deleted: true, rooms, muse_wakes_removed: gone, muse_wakes_left: [], note: dropNote([]) });
      continue; // the list moved, or another DELETE deleted it: cut again and read what is there
    }
    // only the rooms whose wakes did not settle stay, for the next DELETE
    keepsWakes(cut.ver, list.rooms, w.remain, w.seen);
    tagsKept(list.rooms, w.remain);
    const ring = await agentSealRing(list.dk, id, cut.ver + 1, w.remain);
    const kept = await stub.agentRemain("key", verifier, cut.ver, ring);
    if (kept.ok) {
      warn("agent.drop", null, { left: w.left.length });
      return json({ deleted: true, rooms, muse_wakes_removed: gone, muse_wakes_left: w.left, note: dropNote(w.left) });
    }
    // the list moved, or another DELETE deleted it: cut again and read what is there
  }
  // the last try's write met a moved list or none: one more cut tells which; a record gone is a complete disconnect
  if (!(await stub.agentCut("key", verifier)).ok && rooms !== null) return json({ deleted: true, rooms, muse_wakes_removed: [...removed], muse_wakes_left: [], note: dropNote([]) });
  // the list kept moving under this call (other DELETEs of the same key): the key is cut, and nothing else it says could be sure
  warn("agent.drop", null, { remain: "not written" });
  return refusedJson({ status: 503, code: "try_again", error: dropBusy(), retry_after: 1 });
}

/* ---------- POST /api/agent/rooms and /api/agent/rooms/remove ---------- */

/** Puts entries on the key (REST's list, or MCP add_room's one): a room
 *  already held is refused, one the room refused since is replaced in
 *  place, the key holds AGENT_ROOMS_MAX at most, and every new room's token
 *  is looked up, in order, before anything is written. A refused entry that
 *  records Muse wakes has them turned off first (dropWake, through its gone
 *  seat, after this write's read of the list): it is replaced only when
 *  every link of it may leave, otherwise the call answers try_again and
 *  changes nothing. */
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
    const seen: WakeSeen[] = [];
    for (const f of found) {
      const old = x.rooms.find((e) => e.room === f.room);
      if (!old || !(old.hooks && old.hooks.length)) continue;
      const d = await dropWake(env, old, x.ver);
      if (!d.ok) return { answer: d.refused };
      seen.push(d.seen);
    }
    const now = Date.now();
    const rooms = x.rooms.slice();
    for (const f of found) {
      const entry: AgentEntry = { room: f.room, token: f.token, name: f.name, added: now, state: "held", tag: newHolderTag() };
      const at = rooms.findIndex((e) => e.room === f.room);
      if (at >= 0) rooms[at] = entry;
      else rooms.push(entry);
    }
    return { rooms, then: { rooms: found.map((f) => ({ room: f.room, name: f.name, opened: f.opened })), rooms_held: rooms.length }, seen };
  });
}

/** Takes one room off the identity. A room where it recorded a Muse wake
 *  (the entry's hooks) has its hold let go of first (dropWake, after this
 *  write's read of the list), and goes off the list only when every link of
 *  it may leave on the room's answer: once the room is off the identity
 *  nothing but the gadget could turn that wake off (with a key a person made,
 *  or a sign-in, the agent holds no token of that room), and a wake for a
 *  room the agent can no longer read through it serves nobody. A recording
 *  that may still reach the room (outstanding and not expired), or a room
 *  that does not let every link go, keeps the room on, its wake as it was:
 *  try_again. A room that refused the invite says so instead of the seat.
 *  Of the wake it says what the room said after the drop: off, and only then
 *  muse_wake_removed, or kept on by another holder. A sign-in takes off only
 *  a refused room (its caller refuses a held one) and says so in its words. */
type Removed = Refused | { room: string, removed: true, muse_wake_removed?: true, note: string };
async function removeRoom(env: Env, u: Unsealed, room: string): Promise<Rewritten<Removed>> {
  const note = (e: AgentEntry, wake: WakeSaid) => (u.via === "signin" ? signinRemovedNote(room, wake) : e.state === "refused" ? removedRefusedNote(room, wake) : removedHeldNote(room, wake));
  return rewrite<Removed>(u, async (x): Promise<Changed<Removed>> => {
    const e = x.rooms.find((y) => y.room === room);
    if (!e) return { answer: { status: 404, code: "room_not_held", error: room + (u.via === "signin" ? " is not on this sign-in." : " is not on this key."), room } };
    // a sign-in takes a room off only by leaving it, or once its seat is gone (refused)
    if (u.via === "signin" && e.state === "held") return { answer: { status: 409, code: "room_held", error: signinRoomHeld(room), room } };
    const rooms = x.rooms.filter((y) => y.room !== room);
    if (!(e.hooks && e.hooks.length)) return { rooms, then: { room, removed: true as const, note: note(e, false) } };
    const d = await dropWake(env, e, x.ver, u.via);
    if (!d.ok) return { answer: d.refused };
    const wake = wakeSaid(e, d);
    return { rooms, then: wake === "off" ? { room, removed: true as const, muse_wake_removed: true as const, note: note(e, wake) } : { room, removed: true as const, note: note(e, wake) }, seen: [d.seen] };
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
  const u = await keyAfterBody(k.key);
  if (u instanceof Response) return u;
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
  const u = await keyAfterBody(k.key);
  if (u instanceof Response) return u;
  const r = await outlive(rc, () => removeRoom(env, u, room));
  if (!("done" in r) && !("answer" in r)) return rewriteRefusal(r);
  const out = "done" in r ? r.done : r.answer;
  return "status" in out ? refusedJson(out) : json(out);
}

/* ---------- POST /api/agent/rooms/leave ---------- */

// POST /api/agent/rooms/leave {"room", "confirm"} with the key: the agent
// leaves one of the key's rooms for good, its own leave through its key (the
// room's leave, room/members.ts, with the token the key holds, as leave_room
// asks it), and the room comes off the key: the person who holds the key
// takes the agent out from the web app's Agent keys view. It never deletes a
// room: a body with "delete_room" is refused whatever its value, and the
// room's leave is asked with false, so the last member who has joined is
// refused (last_member); the agent itself can leave and delete such a room
// with leave_room. In order, each refusal before anything later runs: the
// method, the key, the body (at most SMALL_BODY_MAX), the room's name,
// "delete_room", confirm (leaveAsk, the rule of every leave), the key opened
// again now that the body is in (keyAfterBody) and its list, the room on it
// (a room the key already marks refused answers from the record); none of
// these writes anything or asks a room. Then, under
// waitUntil registered before the leave is asked: the leave (the room looks
// the token up, lookupInvite, and runs no access(), so an invite never
// opened is refused as it is), leaveAfter, and the key's list (leaveOff). A
// refusal of the seat's token marks the entry refused, as a room tool's does.
// The answer is the leave's (leaveBody) with off_key, kept when the key still
// lists the room (what it holds there: LeaveKept, which the web app words for
// a person) and a note saying it for an agent. The lines it logs are leaveAfter's, with {room}, as on
// the room's own leave route, and markRefused's, with no room.
export async function agentLeaveRoute(rc: RouteContext): Promise<Response> {
  const { request, env } = rc;
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const k = await openKey(env, request);
  if (k.variant !== "ok") return refusedJson(KEY_REFUSED[k.variant]);
  const small = await settleBody(request, SMALL_BODY_MAX);
  if (!small) return json({ error: "That request's body is too large: send {\"room\", \"confirm\"}." }, 413);
  const b = await readBody(small);
  const room = fieldText(b ? b.room : undefined).trim().toLowerCase();
  if (!ROOM_RE.test(room)) return json({ error: ROOM_NAME_RULE }, 400);
  if (b && Object.prototype.hasOwnProperty.call(b, "delete_room")) return json({ error: LEAVE_NO_DELETE, room }, 400);
  let confirmed: boolean;
  try {
    confirmed = leaveAsk(b, room).confirmed;
  } catch (e) {
    // a confirm that is not text: the field readers' 400, with the room beside it
    if (e instanceof BadRequest) return json({ error: e.message, room }, 400);
    throw e;
  }
  if (!confirmed) return json({ error: leaveConfirmRefusal(room), code: "confirm_mismatch", room }, 400);
  const u = await keyAfterBody(k.key, room);
  if (u instanceof Response) return u;
  const e = u.rooms.find((x) => x.room === room);
  if (!e) return refusedJson({ status: 404, code: "room_not_held", error: room + " is not on this key.", room });
  if (e.state === "refused") {
    const code = e.code || "invite_invalid";
    return refusedJson({ status: code === "room_deleted" ? 410 : 403, code, error: leaveEntryRefused(room, code), room });
  }
  return await outlive(rc, () => leaveNow(rc, u, e));
}

/** The leave itself, with the literal false (this address never deletes a
 *  room), and what follows it. */
async function leaveNow(rc: RouteContext, u: Unsealed, e: AgentEntry): Promise<Response> {
  const room = e.room;
  const stub = roomStub(rc.env, room);
  let r: LeaveResult | Refusal | LastMemberRefusal;
  try {
    r = await stub.leave(e.token, room, false);
  } catch (err) {
    // deleted meanwhile: the room's leave throws goneError, which only its message carries over the call
    if (!isGoneError(err)) throw err;
    await markRefused(u, [{ room, token: e.token, code: "room_deleted" }]);
    return refusedJson({ status: 410, code: "room_deleted", error: leaveRoomGone(room), room });
  }
  if (!r.ok) {
    if (r.code === "not_joined") return refusedJson({ status: 409, code: "not_joined", error: leaveNotJoined(e.name, room), room });
    if ("unopened" in r) return refusedJson({ status: 409, code: r.code, error: leaveLastMember(e.name, room, r.unopened), room }, undefined, { unopened: r.unopened });
    // the seat's token refused (revoked, left by another call, or none of the room's): marked on the key
    await markRefused(u, [{ room, token: e.token, code: r.code }]);
    return refusedJson({ status: r.status, code: r.code, error: "Room \"" + room + "\": " + r.error, room });
  }
  leaveAfter(rc, stub, room, r);
  const kept = await leaveOff(rc.env, u, e);
  return json({ ...leaveBody(room, r), off_key: kept === "off", ...(kept === "off" ? {} : { kept }), note: leaveNote(r.name, room, kept) });
}

/** After a leave, the key's entry for the seat that left (by its room and
 *  token) in a settling write (lib/wakes.ts), as a take-off makes it: each
 *  try reads the list (version v) and, when the entry records Muse wakes,
 *  turns them off through the seat that just left (dropWake: a look, then a
 *  drop, after that read, so the observation is stamped v; the room answers
 *  for a left seat, and in an older room whose two active invites' names
 *  fold alike the leave kept the name's hook, which this drop takes off
 *  when it is on a recorded link). Every link may leave: the entry comes
 *  off. One may not (the room could not be reached for it, or a
 *  registration's set may still reach the room): the entry stays with its
 *  links, marked left (refused, invite_revoked, as markRefused marks it; an
 *  entry marked refused already keeps its code), for a take-off to settle
 *  them. An entry already gone stays gone; one put back with another
 *  invite is left alone. A write that does not go through
 *  (the list moved AGENT_SWAP_TRIES times, the key's object threw) is
 *  followed by the mark alone, tried twice; the key cut meanwhile is
 *  said so. What the key holds then (LeaveKept). */
async function leaveOff(env: Env, u: Unsealed, e: AgentEntry): Promise<LeaveKept> {
  const mine = (y: AgentEntry) => y.room === e.room && y.token === e.token;
  const at = Date.now();
  // the entry marked left, its links as they are (nothing leaves the record in this write); one marked
  // refused already keeps its code (room_deleted, say), written by the call that saw it
  const marked = (x: Unsealed, y: AgentEntry): Changed<LeaveKept> => {
    const kept: LeaveKept = y.hooks && y.hooks.length ? "marked_wake" : "marked";
    if (y.state === "refused") return { answer: kept };
    return { rooms: x.rooms.map((z) => (z === y ? { ...z, state: "refused" as const, code: "invite_revoked", at } : z)), then: kept };
  };
  const elsewhere = (x: Unsealed): LeaveKept => (x.rooms.some((y) => y.room === e.room) ? "other" : "off");
  let r: Rewritten<LeaveKept>;
  try {
    r = await rewrite<LeaveKept>(u, async (x): Promise<Changed<LeaveKept>> => {
      const y = x.rooms.find(mine);
      if (!y) return { answer: elsewhere(x) };
      const rooms = x.rooms.filter((z) => z !== y);
      if (!(y.hooks && y.hooks.length)) return { rooms, then: "off" };
      const d = await dropWake(env, y, x.ver, u.via);
      if (!d.ok) return marked(x, y);
      return { rooms, then: "off", seen: [d.seen] };
    });
  } catch {
    r = { busy: true }; /* the key's object threw (or the guard refused the write): the mark alone, which takes nothing off, is tried below */
  }
  if ("done" in r) return r.done;
  if ("answer" in r) return r.answer;
  if ("gone" in r) return "cut";
  try {
    const m = await rewrite<LeaveKept>(u, async (x): Promise<Changed<LeaveKept>> => {
      const y = x.rooms.find(mine);
      return y ? marked(x, y) : { answer: elsewhere(x) };
    }, 2);
    if ("done" in m) return m.done;
    if ("answer" in m) return m.answer;
    return "gone" in m ? "cut" : "listed";
  } catch {
    return "listed"; /* the key's object threw again: the entry stays as the list holds it */
  }
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
export type Planned = { e: PersonEntry, inviter?: Inviter, seat?: Seat, problem?: Refused };

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

/** The body of both routes: the list (1 to AGENT_ROOMS_MAX), every entry's
 *  shape, and whether it only asks: check true; absent or false is the call
 *  itself, and any other value (a string, a number, null) is refused as the
 *  field readers refuse a flag of the wrong type, so a check is never taken
 *  for the call. */
export function personBody(b: Body | null): { entries: PersonEntry[], check: boolean } | Refused {
  const list = b ? b.rooms : undefined;
  if (!Array.isArray(list) || list.length < 1 || list.length > AGENT_ROOMS_MAX) return { status: 400, error: "\"rooms\" must list 1 to " + AGENT_ROOMS_MAX + " rooms: [{\"room\", \"inviter_token\"}], with your own invites" };
  const seen = new Set<string>();
  const entries: PersonEntry[] = [];
  for (let i = 0; i < list.length; i++) {
    const e = personShape(list[i], i, seen, b ? b.name : undefined);
    if ("status" in e) return e;
    entries.push(e);
  }
  const check = b && "check" in b ? b.check : false;
  if (typeof check !== "boolean") return { status: 400, error: "\"check\" must be true or false" };
  return { entries, check };
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
  if (l.row.kind !== "human") return { ok: false, status: 403, code: "not_person_invite", error: notPersonInviteError(e.room), room: e.room };
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
export async function lookInviters(env: Env, planned: Planned[], all: boolean): Promise<Refused | null> {
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
  return { status: 429, code: "rate_limited", error: dayCapError(room), room, retry_after: retryAfter };
}
function activeCap(room: string): Refused {
  return { status: 429, code: "limit_reached", error: activeCapError(room), room };
}

/** An entry's seat, planned from what the room itself says, read only:
 *  whether invite() would take the name as held (nameHeld, the very test it
 *  applies) and, when it would, the room's members (members()) only to find
 *  a seat of this person's to reuse; when it would not, the inviter's load
 *  (inviteLoad, what invite() counts against its caps). Nothing is rebuilt
 *  here from rows: the room's own methods answer. */
async function planSeat(stub: DurableObjectStub, e: PersonEntry, inv: Inviter): Promise<{ ok: true, seat: Seat } | (Refused & { ok: false })> {
  if (await stub.nameHeld(e.name, null)) {
    if (e.reuse !== "none") {
      const list = await stub.members();
      const mine = list.members.find((m) => m.status !== "revoked" && sameName(m.name, e.name) && m.kind !== "human" && m.invited_by === inv.name && m.invited >= inv.created);
      if (mine && mine.status === "unused") return { ok: true, seat: { seat: "reused", name: mine.name, token: mine.invite_token, opened: false } };
      if (mine && e.reuse === "any") return { ok: true, seat: { seat: "reused", name: mine.name, token: mine.invite_token, opened: true } };
      if (mine) return { ok: false, status: 409, code: "seat_in_use", error: seatInUseError(e.room, mine.name), room: e.room };
    }
    return { ok: false, status: 409, code: "name_taken", error: nameTakenError(e.room, e.name), room: e.room };
  }
  const load = await stub.inviteLoad(inv.name);
  if (load.recent >= MEMBER_INVITES_PER_DAY) return { ok: false, ...dayCap(e.room, load.retry_after || 1) };
  if (load.active >= MAX_ACTIVE_INVITES) return { ok: false, ...activeCap(e.room) };
  return { ok: true, seat: { seat: "new", name: e.name } };
}

/** Every entry whose inviter passed gets its seat planned, in order; all
 *  (a check) records each refusal as its entry's problem, otherwise the
 *  first is the answer. No other entry's room is asked anything. */
export async function planSeats(env: Env, planned: Planned[], all: boolean): Promise<Refused | null> {
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
export function plannedView(p: Planned) {
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
/** The rooms where a call made invites: sure (the room answered with the
 *  invite) and maybe (the room's answer was lost, and a look afterwards
 *  could not say whether it wrote one). */
export type Made = { sure: string[], maybe: string[] };
async function seatNow(env: Env, p: Planned, made: Made, unreached: string): Promise<SeatNow | Refused> {
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
    let r: Awaited<ReturnType<typeof stub.invite>>;
    try {
      r = await stub.invite(plan.name, "agent", inv.name, { perDay: MEMBER_INVITES_PER_DAY, maxActive: MAX_ACTIVE_INVITES }, p.e.inviter);
    } catch {
      // the room may have written the invite before its answer was lost: one look, the read planning uses
      const name = plan.name;
      try {
        const list = await stub.members();
        if (list.members.some((m) => m.status === "unused" && sameName(m.name, name) && m.kind !== "human" && m.invited_by === inv.name && m.invited >= inv.created)) made.sure.push(room);
      } catch { made.maybe.push(room); }
      return { status: 500, error: "Room \"" + room + "\" " + unreached, room };
    }
    if (!r) return { status: 409, code: "name_taken", error: nameTakenError(room, plan.name), room };
    if ("ok" in r) return { status: r.status, code: r.code, error: "Room \"" + room + "\": " + r.error, room };
    if ("limit" in r) return r.limit === "day" ? dayCap(room, ("retry_after" in r && r.retry_after) || 1) : activeCap(room);
    made.sure.push(room);
    return { seat: "new", token: r.token, name: r.name, opened: false };
  } catch {
    return { status: 500, error: "Room \"" + room + "\" " + unreached, room };
  }
}

/** The fields a failed call adds once it has made invites, or may have:
 *  the rooms where it did (left_unused), those where it cannot tell
 *  (maybe_unused), and the sentence that says they stay unused. */
export function unusedFields(made: Made): Record<string, unknown> | undefined {
  if (!made.sure.length && !made.maybe.length) return undefined;
  const out: Record<string, unknown> = {};
  if (made.sure.length) out.left_unused = made.sure.slice();
  if (made.maybe.length) out.maybe_unused = made.maybe.slice();
  out.note = unusedNote(made.sure, made.maybe);
  return out;
}

/** A new identity with no rooms yet, and its key: made first, so that each
 *  seat goes on it the moment it is made. One more try with a new id when
 *  the id names an object that exists. drop deletes it again (agentDrop). */
async function emptyIdentity(env: Env): Promise<{ key: string, u: Unsealed, drop: () => Promise<unknown> } | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const k = newAgentKey();
    const verifier = await agentVerifier(k.id, k.secret);
    const { dk, wrapped } = await agentDataKey(k.id, k.secret);
    const stub = identity(env, k.id);
    const ring = await agentSealRing(dk, k.id, 1, []);
    const r = await stub.agentMake(verifier, wrapped, ring);
    if (r.ok) return { key: k.key, u: { stub, id: k.id, wrapped, ver: 1, ring, created: r.created, cred: keyCred({ stub, id: k.id, secret: k.secret, verifier }), via: "key", dk, rooms: [] }, drop: () => stub.agentDrop("key", verifier) };
    if (r.code !== "exists") return null;
  }
  return null;
}

// POST /api/agents/invite {"name", "rooms": [{"room", "inviter_token",
// "name"?, "reuse"?}], "check"?: true | false}: a new key whose seats are
// agent invites the site makes, or reuses, with the person's own invites
// (the person's tokens in the body, as POST /api/muse/hooks takes them; no
// Authorization and no owner key is read). In order: the method; the body
// (at most SMALL_BODY_MAX); the list; every entry's shape and check, a
// boolean (no object asked yet); every inviter looked up, in order; each
// seat planned (reads only); with check, the answer is here: what the
// call would do, with the counters only peeked at (agentPeek: the
// network's and the site's, and only the rooms' whose inviter passed; none
// at all when no inviter passed), and nothing is written anywhere; without
// it the first refusal is the answer, nothing counted. Then, under
// waitUntil registered before the counters are taken, with the answer
// awaiting it (as room creation does), so a caller that goes away does not
// cut it short (the platform gives such work about 30 seconds;
// past that it stops as the Worker would midway: the identity holds the
// seats added so far, and an invite made but not yet added is an unused
// agent seat of this person's, which a retry reuses): the caps
// (agentReserve, as POST /api/agents), the identity, made empty, then each
// seat in order, made or reused, and put on the key at once. A failure after that keeps the invites this call made, unopened,
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
    // a check in which no inviter passed reads no counter at all: its answer is the refusals
    if (!planned.some((p) => p.inviter)) return json({ ok: false, rooms: planned.map(plannedView) });
    const wait = await q.agentPeek(caps);
    const full = typeof wait === "number" && wait > 0;
    const out: { ok: boolean, rooms: unknown[], retry_after?: number } = { ok: !full && planned.every((p) => !p.problem), rooms: planned.map(plannedView) };
    if (full) out.retry_after = wait;
    return json(out);
  }
  return await outlive(rc, async () => {
    const got = await q.agentReserve(caps);
    if (!Array.isArray(got)) {
      if (typeof got === "number") return rateLimited("Too many agent keys were made just now, from this network, for one of these rooms or on the whole site. Try again later.", got);
      return json({ error: "The key could not be made; nothing was kept. Try again." }, 500);
    }
    return personKeyNow(env, url, q, got, planned);
  });
}

/** A seat made or reused, as a new identity's answer names it. */
export type SeatMade = { room: string, name: string, opened: boolean, seat: "new" | "reused" };
/** The seats of a new identity, in order (personKeyNow's and the sign-in
 *  approval's one loop, routes/oauth.ts signinSeatsNow): each planned entry's
 *  seat made or reused (seatNow), then put on the identity at once, with a
 *  new holder tag, through rewrite. The seats, or the first refusal (busy:
 *  the list kept moving; gone: the identity's swap was refused, its code
 *  expired or it was cut meanwhile), with made holding the rooms where
 *  invites were made either way. */
export async function seatsNow(env: Env, first: Unsealed, planned: Planned[], made: Made, unreached: string): Promise<{ ok: true, rooms: SeatMade[], u: Unsealed } | { ok: false, refused: Refused } | { ok: false, busy: true } | { ok: false, gone: true }> {
  let u = first;
  const rooms: SeatMade[] = [];
  for (const p of planned) {
    const s = await seatNow(env, p, made, unreached);
    if ("status" in s) return { ok: false, refused: s };
    const entry: AgentEntry = { room: p.e.room, token: s.token, name: s.name, added: Date.now(), state: "held", tag: newHolderTag() };
    const w = await rewrite<true>(u, async (x): Promise<Changed<true>> => ({ rooms: x.rooms.concat([entry]), then: true }));
    if (!("done" in w)) return "busy" in w ? { ok: false, busy: true } : { ok: false, gone: true };
    u = w.after;
    rooms.push({ room: p.e.room, name: s.name, opened: s.opened, seat: s.seat });
  }
  return { ok: true, rooms, u };
}

async function personKeyNow(env: Env, url: URL, q: DurableObjectStub, got: string[], planned: Planned[]): Promise<Response> {
  const made: Made = { sure: [], maybe: [] };
  let drop: (() => Promise<unknown>) | null = null;
  let kept = false;
  const fail = (r: Refused) => refusedJson(r, undefined, unusedFields(made));
  try {
    const k = await emptyIdentity(env);
    if (!k) return json({ error: "The key could not be made; nothing was kept. Try again." }, 500);
    drop = k.drop;
    const run = await seatsNow(env, k.u, planned, made, "could not be reached, so no key was made. Try again.");
    if (!run.ok) return fail("refused" in run ? run.refused : "busy" in run ? { ...BUSY, retry_after: 1 } : { status: 500, error: "The key could not be made. Try again." });
    const rooms = run.rooms;
    kept = true;
    const address = url.origin + "/api/mcp";
    return json({
      key: k.key, address, rooms, max_rooms: AGENT_ROOMS_MAX,
      // the three hold the word KEY where the key goes, so the key is in the answer once
      claude_code: claudeCodeLine(address),
      mcp_json: mcpJsonEntry(address),
      handoff: personKeyHandoff(url.origin, rooms.map((r) => r.room)),
      note: personKeyNote(rooms.some((r) => r.seat === "reused")),
    }, 201);
  } catch (e) {
    warn("agent.person", e && (e as Error).name ? (e as Error).name : "failed");
    return fail({ status: 500, error: made.sure.length || made.maybe.length ? "The key could not be made. Try again." : "The key could not be made; nothing was kept. Try again." });
  } finally {
    // a key not made whole goes, and its places come back once
    if (!kept) {
      if (drop) { try { await drop(); } catch (e) { warn("agent.drop", e && (e as Error).name ? (e as Error).name : "failed"); } }
      try { await q.agentRelease(got); } catch (e) { warn("agent.release", e); }
    }
  }
}

// POST /api/agent/rooms/invite with the key as Authorization: Bearer and
// the body of POST /api/agents/invite: more seats made, or reused, with
// the person's own invites, on a key the person holds. In order: the
// method; the key; the body; the list; every entry's shape and check;
// the key's list (500 agent_unreadable); a room already on the key and
// held (409 room_held); the most rooms a key holds (429 limit_reached, counted as
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
  const u = await keyAfterBody(k.key);
  if (u instanceof Response) return u;
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
  return await outlive(rc, () => personAddNow(env, u, planned));
}

async function personAddNow(env: Env, first: Unsealed, planned: Planned[]): Promise<Response> {
  // a refused entry that records Muse wakes is replaced only once they are off: first, before any invite, in a
  // settling write of its own (each try reads the list and asks the rooms again)
  const names = new Set(planned.map((p) => p.e.room));
  const off = await rewrite<Refused | null>(first, async (x): Promise<Changed<Refused | null>> => {
    const seen: WakeSeen[] = [];
    for (const h of x.rooms) {
      if (!names.has(h.room) || h.state === "held" || !(h.hooks && h.hooks.length)) continue;
      const d = await dropWake(env, h, x.ver);
      if (!d.ok) return { answer: d.refused };
      seen.push(d.seen);
    }
    if (!seen.length) return { answer: null };
    return { rooms: wakeSettle(x.rooms, seen), then: null, seen };
  });
  if ("answer" in off && off.answer) return refusedJson(off.answer);
  if ("busy" in off || "gone" in off || "unreadable" in off) return refusedJson("gone" in off ? KEY_REFUSED.invalid : "unreadable" in off ? UNREADABLE : { ...BUSY, retry_after: 1 });
  const made: Made = { sure: [], maybe: [] };
  const added: AgentEntry[] = [];
  // the entries this call replaced, as they were (links included), for the rollback
  const replaced = new Map<string, AgentEntry>();
  let u = "done" in off ? off.after : first;
  let kept = false;
  const fail = (r: Refused) => refusedJson(r, undefined, unusedFields(made));
  try {
    const rooms: Array<{ room: string, name: string, opened: boolean, seat: "new" | "reused" }> = [];
    for (const p of planned) {
      const s = await seatNow(env, p, made, "could not be reached, so it was not added. Try again.");
      if ("status" in s) return fail(s);
      const entry: AgentEntry = { room: p.e.room, token: s.token, name: s.name, added: Date.now(), state: "held", tag: newHolderTag() };
      let was: AgentEntry | undefined;
      const w = await rewrite<Refused | null>(u, async (x): Promise<Changed<Refused | null>> => {
        const h = x.rooms.find((y) => y.room === entry.room);
        was = h;
        if (h && h.state === "held") return { answer: { status: 409, code: "room_held", error: about(p.e.i, entry.room + " is already on this key", false), room: entry.room } };
        if (!h && x.rooms.length + 1 > AGENT_ROOMS_MAX) return { answer: { status: 429, code: "limit_reached", error: "This key holds at most " + AGENT_ROOMS_MAX + " rooms; take one off first (remove_room)." } };
        // links recorded on it again since (marked refused with them meanwhile): off first, on this read
        const seen: WakeSeen[] = [];
        if (h && h.hooks && h.hooks.length) {
          const d = await dropWake(env, h, x.ver);
          if (!d.ok) return { answer: d.refused };
          seen.push(d.seen);
        }
        return { rooms: h ? x.rooms.map((y) => (y.room === entry.room ? entry : y)) : x.rooms.concat([entry]), then: null, seen };
      });
      if ("answer" in w) return fail(w.answer || { status: 500, error: "The rooms could not be added. Try again." });
      if (!("done" in w)) return fail("gone" in w ? KEY_REFUSED.invalid : "unreadable" in w ? UNREADABLE : { ...BUSY, retry_after: 1 });
      u = w.after;
      added.push(entry);
      if (was) replaced.set(entry.room, was);
      rooms.push({ room: p.e.room, name: s.name, opened: s.opened, seat: s.seat });
    }
    kept = true;
    return json({ rooms, rooms_held: u.rooms.length }, 201);
  } catch (e) {
    warn("agent.person", e && (e as Error).name ? (e as Error).name : "failed");
    return fail({ status: 500, error: "The rooms could not be added. Try again." });
  } finally {
    // this call's entries come off the key again (each by its room and token,
    // so an entry another call put there meanwhile stays), the entry each
    // replaced put back as it was, links included; one a registration has
    // recorded a wake on since stays, as only a settling write takes a link off
    if (!kept && added.length) {
      try {
        await rewrite<true>(u, async (x): Promise<Changed<true>> => ({
          rooms: x.rooms.flatMap((y) => {
            const mine = added.some((a) => a.room === y.room && a.token === y.token) && !(y.hooks && y.hooks.length);
            if (!mine) return [y];
            const back = replaced.get(y.room);
            return back ? [back] : [];
          }),
          then: true,
        }));
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
/** The sign-in's: its token no longer opens it (cut, idle, revoked, or
 *  replaced while a request held its body back), its record unreadable,
 *  or its list busy. */
const SIGNIN_ENDED_RPC: ToolAnswer = { error: { code: -32001, message: SIGNIN_TOKEN_ENDED, data: { code: "invalid_token" } } };
const SIGNIN_UNREADABLE_RPC: ToolAnswer = { error: { code: -32603, message: "This sign-in's record could not be read." } };
const SIGNIN_BUSY: Refused = { status: 503, code: "try_again", error: "This sign-in is busy; try again." };
/** An identity that no longer opens, and one whose record does not, as a tools/call answers each. */
function goneRpc(who: Who): ToolAnswer {
  return who === "signin" ? SIGNIN_ENDED_RPC : keyError(KEY_REFUSED.invalid);
}
function unreadableRpc(who: Who): ToolAnswer {
  return who === "signin" ? SIGNIN_UNREADABLE_RPC : UNREADABLE_RPC;
}
/** A rewrite that did not happen, as a tools/call answers it. */
function rewriteRpc(r: { busy: true } | { gone: true } | { unreadable: true }, who: Who = "key"): ToolAnswer {
  if ("gone" in r) return goneRpc(who);
  if ("unreadable" in r) return unreadableRpc(who);
  return refusedTool(who === "signin" ? SIGNIN_BUSY : BUSY);
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
    const r = await outlive(rc, () => removeRoom(env, u, room));
    if (!("done" in r) && !("answer" in r)) return rewriteRpc(r);
    const out = "done" in r ? r.done : r.answer;
    return "status" in out ? refusedTool(out) : { result: mcpOk(out) };
  }
  if (name === "muse_register") return outlive(rc, () => museRegister(env, u, args));
  return roomTool(rc, u, name, args);
}

/** One room's answer in muse_register, as POST /api/muse/hooks answers it. */
type WakeResult = { room: string, ok: true, name: string, hook: unknown } | { room: string, ok: false, status: number, code: string, error: string };

/** Why a room was not registered this time, told once it is known whether
 *  the code was claimed (spent): unreached (its look threw: no set was
 *  sent), late (it reached the room after its deadline, and the room
 *  refused it), busy (the key's list changed under the call), full (its
 *  entry holds AGENT_WAKE_ITEMS_MAX links and recordings that cannot be
 *  settled yet), not_joined (its seat was never opened); and two that are
 *  no "not registered": lost (its set was sent and its answer lost, so the
 *  wake may be on: answer_lost), unusable (the code's Muse link is longer
 *  than AGENT_WAKE_LINK_MAX, so it was neither recorded nor set:
 *  link_unusable). */
type Skip = "unreached" | "late" | "busy" | "full" | "not_joined" | "lost" | "unusable";
function skipped(room: string, why: Skip, spent: boolean, who: Who = "key"): WakeResult {
  if (why === "not_joined") return { room, ok: false, status: 409, code: "not_joined", error: museNotJoined(spent) };
  if (why === "lost") return { room, ok: false, status: 503, code: "answer_lost", error: wakeLost(room, who) };
  if (why === "unusable") return { room, ok: false, status: 502, code: "link_unusable", error: wakeLinkUnusable(room, who) };
  return { room, ok: false, status: 503, code: "try_again", error: wakeAgain(room, why, spent, who) };
}

/** muse_register's and the room tools' sentences that name the identity,
 *  a key's or a sign-in's. */
function heldWords(who: Who) {
  return who === "signin"
    ? {
      rule: "\"rooms\" must list 1 to " + AGENT_ROOMS_MAX + " rooms of this sign-in by name, or be left out for every room of it",
      notHeld: (room: string) => signinNotHeld(room),
      refusedEntry: (code: string | undefined) => "This room has refused the seat this sign-in holds" + (code ? " (" + code + ")" : "") + ": take it off with remove_room.",
      noRooms: "No room of this sign-in took its invite, so the code was not used.",
      gone: (room: string) => room + " is no longer on this sign-in.",
    }
    : {
      rule: "\"rooms\" must list 1 to " + AGENT_ROOMS_MAX + " rooms on your key by name, or be left out for every room on it",
      notHeld: (room: string) => room + " is not on your key: list_rooms lists yours; add_room adds one.",
      refusedEntry: (code: string | undefined) => "This room has refused the invite on your key" + (code ? " (" + code + ")" : "") + ": take it off with remove_room.",
      noRooms: "No room on your key took its invite, so the code was not used.",
      gone: (room: string) => room + " is no longer on your key.",
    };
}

/** A settling write for these entries (by room and token) from the list u:
 *  each looked at (museHookLook) after the read, and its links settled on
 *  that look (lib/wakes.ts); tries times at most, the list read and the
 *  rooms asked again each time the list moved; once only for a tidy. The
 *  list as it then stands, or null when the key was cut or its list does
 *  not open (a look that throws settles that entry nothing). */
async function settleRooms(env: Env, u: Unsealed, which: Array<{ room: string, token: string }>, tries: number): Promise<Unsealed | null> {
  const r = await rewrite<null>(u, async (x): Promise<Changed<null>> => {
    const seen: WakeSeen[] = [];
    for (const w of which) {
      const e = x.rooms.find((y) => y.room === w.room && y.token === w.token);
      if (!e || !(e.hooks && e.hooks.length)) continue;
      const o = await observe(env, e, x.ver, null);
      if (o) seen.push(o);
    }
    const rooms = wakeSettle(x.rooms, seen);
    if (JSON.stringify(rooms) === JSON.stringify(x.rooms)) return { answer: null };
    return { rooms, then: null, seen };
  }, tries);
  if ("done" in r) return r.after;
  if ("answer" in r || "busy" in r) return "answer" in r ? u : null;
  return null;
}

// muse_register {code, routing?, rooms?}: the person's Muse woken by rooms
// on the key, with one gadget code for the batch, as POST /api/muse/hooks
// does with room tokens, through room methods that look the key's token up
// and open nothing (museSetHookLook; museHookLook to settle). So it joins
// nothing and marks nobody seen: a room the agent has not joined yet is
// skipped (a wake would join it). The whole of it runs under waitUntil,
// registered before its first write. In order: the code and routing as the
// REST route checks them; which rooms (the ones named, each on the key, or
// every held room); a look in each (lookupInvite, as entryLookup asks), so
// the code is not spent on rooms that refuse; for a room whose entry is at
// the bound (AGENT_WAKE_ITEMS_MAX), a settling write first, still full: it
// is skipped and spends nothing; the claim, once; a recording on each
// accepted room's entry (lib/wakes.ts: its own id, the link, a deadline
// AGENT_WAKE_SET_MS from now), written before any hook is set; the hooks
// set, AGENT_GLANCE_PARALLEL rooms at a time, each carrying its recording's
// deadline, which the room keeps by its own clock, and the entry's holder
// tag as the recording write wrote it, when it has one (a tag is only ever
// read here), each sent once and never again; then this call's own write:
// each recording whose set the room answered, ok or refused, goes, and one
// whose set threw stays outstanding
// (no set's answer takes a link off); then a tidy, once, best effort: each
// room whose entry holds a link other than the one this call's set left on
// (its own too after a refusal) is looked at after that write, and a
// settling write from the version it wrote takes off what the rule lets go
// (a tidy that throws, or meets a newer list, changes nothing). A key cut
// meanwhile has the hook this call set turned off again (only its own hold:
// by the entry's tag when it has one; its disconnect turns off every link
// the list names). The bridge is asked what the REST
// route asks it: /claim once, /rooms once per hook set. The link id is in
// no answer.
async function museRegister(env: Env, u: Unsealed, args: Body): Promise<ToolAnswer> {
  const code = fieldText(args.code).trim();
  if (!code) return { result: mcpErr("\"code\" is required: the one-time link code your Muse gave you") };
  if (code.length > MUSE_CODE_MAX) return { result: mcpErr("\"code\" is longer than " + MUSE_CODE_MAX + " characters") };
  const rawRouting = fieldText(args.routing).trim();
  const routing = rawRouting ? museRouting(rawRouting) : MUSE_ROUTING_DEFAULT;
  if (!routing) return { result: mcpErr(MUSE_ROUTING_ERROR) };
  const say = heldWords(u.via);
  let asked: AgentEntry[];
  if (args.rooms === undefined || args.rooms === null) asked = u.rooms.filter((e) => e.state === "held");
  else {
    const list = args.rooms;
    const rule = say.rule;
    if (!Array.isArray(list) || list.length < 1 || list.length > AGENT_ROOMS_MAX) return { result: mcpErr(rule) };
    asked = [];
    for (const raw of list) {
      if (typeof raw !== "string" || !raw.trim()) return { result: mcpErr(rule) };
      const room = raw.trim().toLowerCase();
      if (!ROOM_RE.test(room)) return { result: mcpErr(ROOM_NAME_RULE) };
      const e = u.rooms.find((x) => x.room === room);
      if (!e) return { result: mcpErr(say.notHeld(room), { code: "room_not_held", room }) };
      if (!asked.includes(e)) asked.push(e);
    }
  }
  const same = (a: { room: string, token: string }, b: { room: string, token: string }) => a.room === b.room && a.token === b.token;
  // first pass: a look in each room, in order (an entry the room refused before is not asked again)
  const results: Array<WakeResult | Skip> = [];
  const accepted: Array<{ i: number, e: AgentEntry }> = [];
  const marks: Array<{ room: string, token: string, code: string }> = [];
  const full: Array<{ i: number, e: AgentEntry }> = [];
  for (const e of asked) {
    if (e.state === "refused") {
      results.push({ room: e.room, ok: false, status: e.code === "room_deleted" ? 404 : 403, code: e.code || "invite_invalid", error: say.refusedEntry(e.code) });
      continue;
    }
    const stub = roomStub(env, e.room);
    let l: InviteLookup;
    try { l = await stub.lookupInvite(e.token); } catch { results.push("unreached"); continue; /* reported in its room's result */ }
    if (!l.ok) {
      marks.push({ room: e.room, token: e.token, code: l.code });
      results.push(l.code === "room_deleted" ? { room: e.room, ok: false, status: 404, code: "room_deleted", error: "No room with that name yet. Create it from the home page." } : { room: e.room, ok: false, status: l.status, code: l.code, error: l.error });
      continue;
    }
    if (!l.row.used) { results.push("not_joined"); continue; }
    results.push("unreached"); // filled in below
    accepted.push({ i: results.length - 1, e });
    // a new link and its recording count two: at the bound, a settling write comes first
    if (wakeWeight(e) + 2 > AGENT_WAKE_ITEMS_MAX) full.push({ i: results.length - 1, e });
  }
  if (marks.length) await markRefused(u, marks);
  // each change of the list below starts from the list as the one before left it
  let base = u;
  if (full.length) {
    const after = await settleRooms(env, base, full.map((f) => f.e), AGENT_SWAP_TRIES);
    if (after) base = after;
    for (const f of full) {
      const e = base.rooms.find((y) => same(y, f.e));
      if (e && wakeWeight(e) + 2 <= AGENT_WAKE_ITEMS_MAX) continue;
      // still full: not asked this time, and spends nothing
      results[f.i] = "full";
      accepted.splice(0, accepted.length, ...accepted.filter((a) => a.i !== f.i));
    }
  }
  const told = (spent: boolean) => results.map((r, i) => (typeof r === "string" ? skipped(asked[i].room, r, spent, u.via) : r));
  if (!accepted.length) return { result: mcpErr(say.noRooms, { code: "no_rooms", results: told(false) }) };
  // the code, claimed once for every room
  const bridge = museBridge(env);
  const c = await museClaim(bridge, code);
  if (!c.ok) return { result: mcpErr(c.error, c.code === "rate_limited" ? { code: c.code, retry_after: c.retry_after } : { code: c.code }) };
  const link = c.link;
  // a link longer than the key records: no room is recorded or set (the code is spent: the bridge claimed it)
  if (link.length > AGENT_WAKE_LINK_MAX) {
    for (const a of accepted) results[a.i] = "unusable";
    return { result: mcpOk({ claimed: true, results: told(true) }) };
  }
  // a recording on each entry (by its room and token), written before any
  // hook is set; an entry with no holder tag gets one here (withTag: with
  // pre when it already records a link), and only here
  const deadline = Date.now() + AGENT_WAKE_SET_MS;
  const ids = accepted.map(() => newRecordingId());
  const rec = await rewrite<Set<number>>(base, async (x): Promise<Changed<Set<number>>> => {
    const recorded = new Set<number>();
    let rooms = x.rooms;
    accepted.forEach((a, n) => {
      const next = wakeRecord(withTag(rooms, a.e.room, a.e.token), a.e.room, a.e.token, link, { id: ids[n], deadline }, AGENT_WAKE_ITEMS_MAX);
      if (next) { rooms = next; recorded.add(n); }
    });
    return { rooms, then: recorded };
  });
  if ("gone" in rec) return goneRpc(u.via);
  if ("unreadable" in rec || "answer" in rec) return unreadableRpc(u.via);
  if ("busy" in rec) {
    for (const a of accepted) results[a.i] = "busy";
    return { result: mcpOk({ claimed: true, results: told(true) }) };
  }
  const recorded = rec.done;
  // a room not recorded: taken off meanwhile, refused meanwhile, or filled by another registration
  for (const [n, a] of accepted.entries()) {
    if (recorded.has(n)) continue;
    const e = rec.after.rooms.find((y) => same(y, a.e));
    results[a.i] = e && e.state === "held" ? (wakeWeight(e) + 2 > AGENT_WAKE_ITEMS_MAX ? "full" : "busy") : { room: a.e.room, ok: false, status: 404, code: "room_not_held", error: say.gone(a.e.room) };
  }
  // the hooks, each set with a look at the room's own invite, carrying its recording's deadline; sent once, never again
  const tagOf = (x: { room: string, token: string }) => { const y = rec.after.rooms.find((z) => same(z, x)); return y ? y.tag : undefined; };
  const outcome = new Map<number, "ok" | "refused" | "threw">();
  const todo = [...recorded];
  let next = 0, unreached = 0;
  const lane = async () => {
    while (next < todo.length) {
      const n = todo[next++], a = accepted[n];
      try {
        // the tag of the entry as the recording write wrote it, never as first read: a set without its tag is held as "pre"
        const tag = tagOf(a.e);
        const stub = roomStub(env, a.e.room);
        const s = tag === undefined ? await stub.museSetHookLook(a.e.token, link, routing, a.e.room, deadline) : await stub.museSetHookLook(a.e.token, link, routing, a.e.room, deadline, tag);
        if (!s.ok) {
          outcome.set(n, "refused");
          results[a.i] = s.code === "too_late" ? "late" : { room: a.e.room, ok: false, status: s.status, code: s.code, error: s.error };
          continue;
        }
        outcome.set(n, "ok");
        results[a.i] = { room: a.e.room, ok: true, name: s.name, hook: s.hook };
      } catch { unreached++; outcome.set(n, "threw"); results[a.i] = "lost"; /* counted, and logged below with no room */ }
    }
  };
  await Promise.all(Array.from({ length: Math.min(AGENT_GLANCE_PARALLEL, todo.length) }, lane));
  if (unreached) warn("agent.muse", null, { unreached });
  // this call's own write: the recordings whose sets the room answered go; nothing else changes
  const answered = todo.filter((n) => outcome.get(n) !== "threw");
  const post = await rewrite<Set<number>>(rec.after, async (x): Promise<Changed<Set<number>>> => {
    const there = new Set<number>();
    let rooms = x.rooms;
    for (const n of todo) {
      if (x.rooms.some((y) => same(y, accepted[n].e))) there.add(n);
      if (answered.includes(n)) rooms = wakeAnswered(rooms, accepted[n].e.room, accepted[n].e.token, link, ids[n]);
    }
    return { rooms, then: there, own: answered.map((n) => ids[n]) };
  });
  if ("gone" in post) {
    // cut meanwhile: the hooks this call set go again (the disconnect also turns off every link it recorded)
    for (const n of todo) {
      if (outcome.get(n) !== "ok") continue;
      // only the hold this call set: by its tag, or, for an entry without one, by the holds an untagged set makes (museDropLook)
      const a = accepted[n].e, tag = tagOf(a), stub = roomStub(env, a.room);
      try { await (tag === undefined ? stub.museDropLook(a.token, link) : stub.museHolderDrop(tag, link, a.token, false)); } catch { /* the disconnect asks it */ }
    }
    return goneRpc(u.via);
  }
  if ("done" in post) {
    // a room whose entry changed under the call (taken off, or put back with another invite): its result says so
    for (const n of todo) {
      if (post.done.has(n)) continue;
      const a = accepted[n];
      const onKey = post.after.rooms.some((e) => e.room === a.e.room);
      results[a.i] = onKey ? "busy" : { room: a.e.room, ok: false, status: 404, code: "room_not_held", error: say.gone(a.e.room) };
    }
    // the tidy: one look after this call's own write, one settling write from the version it wrote
    const tidy = answered.filter((n) => post.done.has(n)).map((n) => accepted[n].e).filter((a) => {
      const e = post.after.rooms.find((y) => same(y, a));
      const own = outcome.get(accepted.findIndex((x) => same(x.e, a))) === "ok";
      return !!e && (e.hooks || []).some((h) => h.link !== link || !own);
    });
    if (tidy.length) { try { await settleRooms(env, post.after, tidy, 1); } catch (e) { warn("agent.muse", e && (e as Error).name ? (e as Error).name : "failed"); } }
  }
  // the bridge counts the link's rooms for the gadget (best effort: never fails the registration)
  for (const n of todo) {
    const r = results[accepted[n].i];
    if (typeof r !== "string" && r.ok) await museReportRoom(bridge, link, accepted[n].e.room, true);
  }
  return { result: mcpOk({ claimed: true, results: told(true) }) };
}

/** A room tool through the key or a sign-in: the room it names must be on
 *  the identity; then the room is asked exactly what the same call at its
 *  own address asks - the look that address makes once per request
 *  (lookupInvite, which opens nothing), then roomToolAnswer with the token
 *  the identity holds, owner false. A refusal of the token is the tool's
 *  error {code, room}, and the room is marked refused on the identity. A
 *  leave through the key marks the room left; through a sign-in it takes
 *  the room off as POST /api/agent/rooms/leave does (leaveOff: off when every
 *  recorded link may leave on its observation, else marked left with its
 *  links), and the answer's signin line says which. */
async function roomTool(rc: RouteContext, u: Unsealed, name: string, args: Body): Promise<ToolAnswer> {
  const raw = args.room;
  if (typeof raw !== "string" || !raw.trim()) return { result: mcpErr("\"room\" is required: one of your rooms, as list_rooms gives it") };
  const room = raw.trim().toLowerCase();
  if (!ROOM_RE.test(room)) return { result: mcpErr(ROOM_NAME_RULE) };
  const e = u.rooms.find((x) => x.room === room);
  if (!e) return { result: mcpErr(heldWords(u.via).notHeld(room), { code: "room_not_held", room }) };
  const stub = roomStub(rc.env, room);
  const look = stub.lookupInvite(e.token).then((l: InviteLookup) => (l.ok ? { ok: true as const } : l));
  let refused: string | null = null;
  const refuse = (r: Worded): ToolAnswer => { refused = r.code; return { result: mcpErr("Room \"" + room + "\": " + r.error, { code: r.code, room }) }; };
  const tk: { ok: true } | Refusal = await look;
  // the tool's own arguments, as the room's address takes them
  const targs: Body = Object.fromEntries(Object.entries(args).filter(([key]) => key !== "room"));
  let a: ToolAnswer = tk.ok ? await roomToolAnswer({ rc, stub, room, invite: e.token, owner: false, checkToken: () => look, missing: inviteMissing, refuse, viaKey: true, viaSignin: u.via === "signin" }, name, targs) : refuse(tk);
  // the mark is the identity's own bookkeeping: if it cannot be written, the
  // room's answer goes out as it was (the next call marks it)
  if (refused) await markRefused(u, [{ room, token: e.token, code: refused }]);
  else if (name === "leave_room" && "result" in a && !(a.result as { isError?: boolean }).isError) {
    const left = (a.result as { structuredContent?: Record<string, unknown> }).structuredContent || {};
    if (u.via === "signin") {
      const kept = await leaveOff(rc.env, u, e);
      a = { result: mcpOk({ ...left, signin: signinLeaveNote(room, kept === "other" ? "listed" : kept, !!left.room_deleted) }) };
    } else if (await markRefused(u, [{ room, token: e.token, code: left.room_deleted ? "room_deleted" : "invite_revoked" }])) {
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
  if (wait > 0) return { result: mcpErr("whats_waiting answers at most once " + pollGap(AGENT_GLANCE_GAP_S) + (u.via === "signin" ? " for a sign-in" : " for a key") + "; try again in " + spanS(wait) + ".", { code: "rate_limited", retry_after: wait }) };
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

/* ---------- POST /api/mcp/signin ---------- */

/** Every answer of the sign-in address with CORS_SIGNIN in place of CORS,
 *  so a browser client can read a 401's WWW-Authenticate. */
function signinCors(res: Response): Response {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(CORS_SIGNIN)) headers.set(k, v);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

// POST /api/mcp/signin: the sign-in's MCP address, for an access token the
// sign-in (routes/oauth.ts) issued for it. Before any body is read, the
// credential decides, from Authorization: Bearer alone: an access token
// that opens its sign-in live, not idle, issued for this address, is signed
// in; any other sign-in token (expired, unknown, ended, idle, the default
// token, another resource's, a code, a refresh token, a disconnect code) is
// 401 invalid_token, and no credential is 401 sign_in_required, each with
// WWW-Authenticate naming this address's metadata, for every method in both
// kinds of revision; an agent key, a room's invite token or another dot form
// is 200, the tools -32001 wrong_address with where it works (a 401 would
// start a sign-in in a key holder's client: the one deliberate exception to
// MCP's "invalid tokens MUST receive a 401", for credentials that are not
// this server's tokens). Signed in, mcpServe answers as the key's address
// does, with the sign-in's catalog and instructions, and every tools/call
// opens the sign-in again once the body is in (signinTool). Every answer
// carries CORS_SIGNIN.
export async function signinMcpRoute(rc: RouteContext): Promise<Response> {
  const { request, env } = rc;
  const origin = signinOrigin(env), address = origin + "/api/mcp/signin";
  if (request.method !== "POST") return json({ error: "Method not allowed. POST JSON-RPC here; call tools/list for the catalog." }, 405, CORS_SIGNIN);
  const c = signinCredential(request);
  const unauthorized = async (code: "sign_in_required" | "invalid_token"): Promise<Response> => {
    // decided before the body; what was sent is read away, bounded, so the client gets this answer rather than a reset
    await settleBody(request, SMALL_BODY_MAX);
    const meta = origin + "/.well-known/oauth-protected-resource/api/mcp/signin";
    const www = code === "invalid_token" ? "Bearer error=\"invalid_token\", resource_metadata=\"" + meta + "\"" : "Bearer resource_metadata=\"" + meta + "\", scope=\"" + SIGNIN_SCOPE + "\"";
    return json({ jsonrpc: "2.0", id: null, error: { code: -32001, message: signinNeeded(origin), data: { code } } }, 401, { ...CORS_SIGNIN, "WWW-Authenticate": www });
  };
  if (c.kind === "none") return unauthorized("sign_in_required");
  let opened: Opened | null = null;
  if (c.kind === "token") {
    opened = await openSigninAccess(env, c.t, address);
    if (!opened) return unauthorized("invalid_token");
  }
  const body = await settleBody(request, opened ? SETTLED_BODY_MAX : SMALL_BODY_MAX);
  if (!body) return json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: opened ? "Request too large: a request can be up to " + Math.floor(SETTLED_BODY_MAX / MIB) + " MiB" : "Request too large: without a sign-in a request can be up to " + Math.floor(SMALL_BODY_MAX / MIB) + " MiB" } }, 413, CORS_SIGNIN);
  let rpcBody: unknown = null;
  try { rpcBody = await body.json(); } catch { return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error: send one JSON-RPC request object" } }, 400, CORS_SIGNIN); }
  if (Array.isArray(rpcBody)) return json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request: this address takes no batches; send each request as its own POST." } }, 400, CORS_SIGNIN);
  const signedIn = opened;
  // a credential that is no sign-in: where it works, for every method but ping, initialize and server/discover
  const wrong = c.kind === "token" ? null : { error: c.kind === "key" ? signinWrongKey(origin) : c.kind === "invite" ? signinWrongInvite(origin) : KEY_INVALID_SENTENCE, code: "wrong_address" };
  return signinCors(await mcpServe(rc, {
    serverInfo: signinServerInfo(origin),
    catalog: mcpSigninCatalogBuilt,
    catalogVersion: MCP_SIGNIN_CATALOG_VERSION,
    has: mcpHasSigninTool,
    instructions: signedIn ? signinInstructions(origin) : signinWrongInstructions(origin),
    verdict: async () => (wrong ? { ok: false as const, ...wrong } : { ok: true as const }),
    unknownVerdict: async () => wrong,
    say: (r: Worded) => r,
    tool: async (name, args) => (wrong || !signedIn ? { error: { code: -32001, message: wrong ? wrong.error : SIGNIN_TOKEN_ENDED, data: { code: wrong ? wrong.code : "invalid_token" } } } : signinTool(rc, signedIn, name, args)),
  }, rpcBody));
}

/** A tools/call at the sign-in address, of a tool in its catalog. The
 *  sign-in is opened again first, now that the body is in, with the access
 *  slot's write grace: one cut, idle or revoked while its request held the
 *  body back acts nowhere (-32001 invalid_token), and one whose token merely
 *  expired meanwhile still serves the request it opened live. */
async function signinTool(rc: RouteContext, first: Opened, name: string, args: Body): Promise<ToolAnswer> {
  const { env } = rc;
  const o = await reopen(first);
  if (!o) return SIGNIN_ENDED_RPC;
  const u = await unseal(o);
  if (!u) return SIGNIN_UNREADABLE_RPC;
  if (name === "list_rooms") return { result: mcpOk({ rooms: u.rooms.map(entryView), max_rooms: AGENT_ROOMS_MAX, created: u.created }) };
  if (name === "whats_waiting") return glance(env, u);
  if (name === "remove_room") {
    const room = fieldText(args.room).trim().toLowerCase();
    if (!ROOM_RE.test(room)) return { result: mcpErr(ROOM_NAME_RULE) };
    const r = await outlive(rc, () => removeRoom(env, u, room));
    if (!("done" in r) && !("answer" in r)) return rewriteRpc(r, "signin");
    const out = "done" in r ? r.done : r.answer;
    return "status" in out ? refusedTool(out) : { result: mcpOk(out) };
  }
  if (name === "muse_register") return outlive(rc, () => museRegister(env, u, args));
  return roomTool(rc, u, name, args);
}
