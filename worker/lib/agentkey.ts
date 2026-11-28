// Agent keys: the credential an agent sends to the agent routes and the
// one MCP address (worker/routes/agent.ts), and the sealing of the list of
// rooms its identity holds (worker/room/agent.ts stores it). Every step runs
// in the Worker, with Web Crypto: the identity's object stores, compares and
// swaps bytes it cannot read, and is sent a verifier, never a secret.
//
// A key is ".ac1." + the identity's id (16 random bytes) + "." + its secret
// (32 random bytes), both base64url: 71 characters. An invite token is 24
// characters of [A-Za-z0-9_-] (AGENTS.md section 5), so the first byte, a
// dot, tells the two apart with no lookup; any other value that starts with
// a dot is refused as a key. A 256-bit random secret
// needs no slow hash: the verifier is an HKDF of it (as upload tickets are
// kept as plain SHA-256), and a second HKDF with its own label wraps the
// data key, so the two are independent.
//
// The list is sealed with AES-256-GCM under a data key (dk) made with the
// identity, stored only wrapped under the key's own HKDF. Its additional
// data binds it to the identity and to its version, so a list cannot be
// moved to another identity or put back at another version unseen. It is
// padded with spaces to a multiple of AGENT_RING_PAD bytes. Sealing keeps
// the list out of anything that reads storage alone; it does not keep it
// from someone who holds both a copy of the storage and the key, nor from
// code that runs in the Worker.

import { AGENT_RING_PAD } from "../limits.js";
import { b64urlDecode, b64urlEncode, concatBytes, hexBytes, hkdf } from "./crypto.js";
import { warn } from "./log.js";

/** An agent key: the identity's id (22 characters) and its secret (43). */
export const AGENT_KEY_RE = /^\.ac1\.([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})$/;

/** What an Authorization: Bearer value turned out to be: none sent; a room
 *  invite token (its first character is not a dot); an agent key; or a
 *  value that starts with a dot and is no agent key. */
export type AgentCredential = { kind: "none" } | { kind: "invite" } | { kind: "key", id: string, secret: Uint8Array<ArrayBuffer> } | { kind: "bad" };

/** base64url text that is exactly the encoding of n bytes, decoded; null
 *  for anything else (a non-canonical last character included, so one key
 *  has one spelling). */
export function decodeExact(s: string, n: number): Uint8Array<ArrayBuffer> | null {
  let b: Uint8Array<ArrayBuffer>;
  try { b = b64urlDecode(s); } catch { return null; /* not base64: no key */ }
  return b.length === n && b64urlEncode(b) === s ? b : null;
}

/** The credential the agent routes read: Authorization: Bearer only, as
 *  headerToken (lib/tokens.ts) reads it. Never X-Invite-Token, never
 *  X-Owner-Key: neither is an agent key. */
export function agentCredential(request: Request): AgentCredential {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(request.headers.get("Authorization") || "");
  if (!m) return { kind: "none" };
  const v = m[1];
  if (v.charAt(0) !== ".") return { kind: "invite" };
  const k = AGENT_KEY_RE.exec(v);
  if (!k) return { kind: "bad" };
  const id = decodeExact(k[1], 16), secret = decodeExact(k[2], 32);
  if (!id || !secret) return { kind: "bad" };
  return { kind: "key", id: k[1], secret };
}

/** A new agent key: its text, the identity's id and the secret's bytes,
 *  all from crypto.getRandomValues. */
export function newAgentKey(): { key: string, id: string, secret: Uint8Array<ArrayBuffer> } {
  const id = b64urlEncode(crypto.getRandomValues(new Uint8Array(16)));
  const secret = crypto.getRandomValues(new Uint8Array(32));
  return { key: ".ac1." + id + "." + b64urlEncode(secret), id, secret };
}

const enc = new TextEncoder();

/** A slot's two derivations from its secret, each with its own label: the
 *  salt names the identity and the slot, the info the slot's kind and the
 *  use. An agent key's one slot is "key", of kind "key"; a sign-in's slots
 *  have random names and the kinds code, access, refresh and disconnect, so
 *  no two slots of any identity share a derivation. */
function slotDerive(id: string, slot: string, kind: string, secret: Uint8Array<ArrayBuffer>, what: "verify" | "wrap") {
  return hkdf(secret, enc.encode(id + "|" + slot), enc.encode("agent-chat " + kind + " " + what + " v1"), 32);
}
/** The key's two derivations: its slot's. */
function derive(id: string, secret: Uint8Array<ArrayBuffer>, what: "verify" | "wrap") {
  return slotDerive(id, "key", "key", secret, what);
}

/** What the identity's object keeps of the key and compares: a one-way
 *  derivation of its secret, in hex. */
export async function agentVerifier(id: string, secret: Uint8Array<ArrayBuffer>): Promise<string> {
  return hexBytes(await derive(id, secret, "verify"));
}

function aesKey(raw: Uint8Array<ArrayBuffer>) {
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

/** AES-GCM of data under raw with that additional data: iv (12 bytes) then
 *  the ciphertext, as base64url. */
async function seal(raw: Uint8Array<ArrayBuffer>, data: Uint8Array<ArrayBuffer>, aad: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: enc.encode(aad) }, await aesKey(raw), data));
  return b64urlEncode(concatBytes(iv, ct));
}

/** seal's inverse; throws when anything does not match. */
async function open(raw: Uint8Array<ArrayBuffer>, sealed: string, aad: string): Promise<Uint8Array<ArrayBuffer>> {
  const b = b64urlDecode(sealed);
  return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: b.subarray(0, 12), additionalData: enc.encode(aad) }, await aesKey(raw), b.subarray(12)));
}

/** The additional data of a slot's wrapped keys, the key's slot's, and of
 *  the list and the wake list at a version. */
const slotAadOf = (id: string, slot: string, kind: string) => "slot|" + id + "|" + slot + "|" + kind;
const slotAad = (id: string) => slotAadOf(id, "key", "key");
const ringAad = (id: string, ver: number) => "ring|" + id + "|" + ver;
const wakesAad = (id: string, ver: number) => "wakes|" + id + "|" + ver;

/** A new data key, and it wrapped under the key's secret (what the slot stores). */
export async function agentDataKey(id: string, secret: Uint8Array<ArrayBuffer>): Promise<{ dk: Uint8Array<ArrayBuffer>, wrapped: string }> {
  const dk = crypto.getRandomValues(new Uint8Array(32));
  return { dk, wrapped: await seal(await derive(id, secret, "wrap"), dk, slotAad(id)) };
}

/** One room on a key: its name, the invite token the key presents there,
 *  the member's name there (from the lookup when it was added), when it was
 *  added, and whether the room has refused the token since (state refused,
 *  the room's code and when). hooks are the Muse wakes the key set up in
 *  that room (muse_register), sealed with the rest and in no answer: a link
 *  id is a bearer secret at the bridge. tag, when the entry has one, is the
 *  holder its sets are held by in the room (room/muse.ts, mhh), and what its
 *  looks and drops go by (museHolderLook, museHolderDrop); pre: its looks
 *  and drops also count the room's untagged holds as its own (wakes it
 *  records may have been set without its tag). muse_register's recording
 *  write gives an untagged entry its tag (withTag), and a write drops pre
 *  once the entry records no link (clearPre); every other write keeps what
 *  an entry carries (tagsKept), and the room is only passed them and
 *  observed by them. An entry without a tag is looked at and dropped by the
 *  holds a set without a tag makes (the room's LEGACY_HOLDS). */
export type AgentEntry = { room: string, token: string, name: string, added: number, state: "held" | "refused", code?: string, at?: number, hooks?: AgentWake[], tag?: string, pre?: true };

/** The check beside keepsWakes (lib/wakes.ts) on every write of a key's
 *  list: an entry's holder tag is what its holds in the room are found by,
 *  so an entry of after (matched by room and token) that recorded a Muse
 *  wake in before keeps how its holds are found: its tag, if it had one; no
 *  tag gained without pre while it records a link; pre not lost while it
 *  records a link. Otherwise the room's hold would no longer be its own to
 *  look at, a link would leave on an observation that its holder holds
 *  nothing while the hook stays on, and keepsWakes, which matches entries by
 *  room and token, cannot see it. An entry that recorded no link may change
 *  freely, and one that leaves the list is keepsWakes' to check. It throws,
 *  and nothing is written. */
export function tagsKept(before: AgentEntry[], after: AgentEntry[]): void {
  for (const e of before) {
    if (!(e.hooks && e.hooks.length)) continue;
    const a = after.find((x) => x.room === e.room && x.token === e.token);
    if (!a) continue;
    const records = !!(a.hooks && a.hooks.length);
    if (e.tag !== undefined && a.tag !== e.tag) throw new Error("an entry's holder tag would change while it records a Muse wake");
    if (e.tag === undefined && a.tag !== undefined && a.pre !== true && records) throw new Error("an entry would gain a holder tag without its pre hold while it records a Muse wake");
    if (e.pre === true && a.pre !== true && records) throw new Error("an entry's pre hold would go while it records a Muse wake");
  }
}

/** A Muse wake recorded on an entry (worker/lib/wakes.ts): its link id,
 *  present while a hook of that link may be on in the room, and its
 *  outstanding recordings: one per attempt to set it whose call has not
 *  written the room's answer yet, each with an id of its own and its
 *  deadline, the last moment by the room's clock at which its set may
 *  still reach the room (the room refuses a later one). */
export type AgentWake = { link: string, recs: AgentRec[] };
export type AgentRec = { id: string, deadline: number };

/** A recording's id: random, unique on the list. */
export function newRecordingId(): string {
  return b64urlEncode(crypto.getRandomValues(new Uint8Array(12)));
}

/** The list sealed for the version the row will hold after the write:
 *  {v: 1, rooms} as JSON, padded with spaces to a multiple of
 *  AGENT_RING_PAD bytes. */
export async function agentSealRing(dk: Uint8Array<ArrayBuffer>, id: string, ver: number, rooms: AgentEntry[]): Promise<string> {
  const json = enc.encode(JSON.stringify({ v: 1, rooms }));
  const padded = new Uint8Array(Math.max(1, Math.ceil(json.length / AGENT_RING_PAD)) * AGENT_RING_PAD).fill(0x20);
  padded.set(json);
  return seal(dk, padded, ringAad(id, ver));
}

/** The refusal of a list that does not open with a good verifier (storage
 *  corrupted, or rows put back by hand): never a refused key. */
export const AGENT_UNREADABLE = "This key's record could not be read.";

/** The data key and the list, opened with the key's secret; null when
 *  either does not open, logged once as agent.unseal with no error object
 *  (V8 quotes a failed JSON.parse's input in its message) and no ids. */
export async function agentUnseal(id: string, secret: Uint8Array<ArrayBuffer>, wrapped: string | null, ver: number, ring: string): Promise<{ dk: Uint8Array<ArrayBuffer>, rooms: AgentEntry[] } | null> {
  try {
    if (!wrapped) throw new Error("no wrapped key");
    const dk = await open(await derive(id, secret, "wrap"), wrapped, slotAad(id));
    const text = new TextDecoder("utf-8", { fatal: true }).decode(await open(dk, ring, ringAad(id, ver)));
    const v: unknown = JSON.parse(text.trim());
    if (!v || typeof v !== "object" || (v as { v?: unknown }).v !== 1 || !Array.isArray((v as { rooms?: unknown }).rooms)) throw new Error("not a list");
    return { dk, rooms: (v as { rooms: AgentEntry[] }).rooms };
  } catch {
    warn("agent.unseal", null);
    return null;
  }
}

// ---- A sign-in's slots (worker/routes/oauth.ts, room/agent.ts signin*) ----
// A sign-in is an identity of this kind whose slots are its tokens: a code,
// access tokens, refresh tokens and the disconnect-only code, each a slot
// with a random name, its own verifier and its own wrapped copies of the
// data key (dk, which opens the room list) and of the wake key (wk, which
// opens the wake list). The disconnect slot holds wk only.

/** A slot's verifier: the one-way derivation the identity's object keeps. */
export async function slotVerifier(id: string, slot: string, kind: string, secret: Uint8Array<ArrayBuffer>): Promise<string> {
  return hexBytes(await slotDerive(id, slot, kind, secret, "verify"));
}

/** A 32-byte key (dk or wk) wrapped under a slot's wrap key, as its row stores it. */
export async function slotWrap(id: string, slot: string, kind: string, secret: Uint8Array<ArrayBuffer>, key: Uint8Array<ArrayBuffer>): Promise<string> {
  return seal(await slotDerive(id, slot, kind, secret, "wrap"), key, slotAadOf(id, slot, kind));
}

/** slotWrap's inverse; null when it does not open (a wrong slot, kind or
 *  secret, or storage changed). Logs nothing: the caller says what failed. */
export async function slotUnwrap(id: string, slot: string, kind: string, secret: Uint8Array<ArrayBuffer>, wrapped: string | null | undefined): Promise<Uint8Array<ArrayBuffer> | null> {
  if (!wrapped) return null;
  try {
    const k = await open(await slotDerive(id, slot, kind, secret, "wrap"), wrapped, slotAadOf(id, slot, kind));
    return k.length === 32 ? k : null;
  } catch {
    return null; /* not this slot's wrapping: the caller refuses */
  }
}

/** The key that seals a spent refresh token's replacement pair ("next"):
 *  derived from that token's own secret, so only its holder opens it. */
function nextKey(id: string, slot: string, secret: Uint8Array<ArrayBuffer>) {
  return hkdf(secret, enc.encode(id + "|" + slot), enc.encode("agent-chat refresh next v1"), 32);
}
const nextAad = (id: string, slot: string) => "next|" + id + "|" + slot;

/** A refresh's answer, sealed for the grace (next): the pair and when its access token was issued. */
export type NextPair = { access_token: string, refresh_token: string, issued: number };
export async function sealNext(id: string, slot: string, secret: Uint8Array<ArrayBuffer>, pair: NextPair): Promise<string> {
  return seal(await nextKey(id, slot, secret), enc.encode(JSON.stringify(pair)), nextAad(id, slot));
}
/** sealNext's inverse; null when it does not open. */
export async function openNext(id: string, slot: string, secret: Uint8Array<ArrayBuffer>, sealed: string | null | undefined): Promise<NextPair | null> {
  if (!sealed) return null;
  try {
    const v: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await open(await nextKey(id, slot, secret), sealed, nextAad(id, slot))));
    if (!v || typeof v !== "object") return null;
    const p = v as Record<string, unknown>;
    return typeof p.access_token === "string" && typeof p.refresh_token === "string" && typeof p.issued === "number" ? { access_token: p.access_token, refresh_token: p.refresh_token, issued: p.issued } : null;
  } catch {
    return null; /* not this token's pair: the caller refuses */
  }
}

/** A new 32-byte key (a data key or a wake key). */
export function newKeyBytes(): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(32));
}

/** The room list sealed under dk with dk itself handed in (a sign-in's
 *  lists are made from keys the Worker already holds). */
export async function agentOpenRing(dk: Uint8Array<ArrayBuffer>, id: string, ver: number, ring: string): Promise<AgentEntry[] | null> {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(await open(dk, ring, ringAad(id, ver)));
    const v: unknown = JSON.parse(text.trim());
    if (!v || typeof v !== "object" || (v as { v?: unknown }).v !== 1 || !Array.isArray((v as { rooms?: unknown }).rooms)) throw new Error("not a list");
    return (v as { rooms: AgentEntry[] }).rooms;
  } catch {
    warn("agent.unseal", null);
    return null;
  }
}

// ---- The wake list: the key's record, readable without the room list ----

/** The wake list's projection of a room list: every entry that records a
 *  Muse wake, with its holder tag in place of the room's token (token: tag,
 *  and tag beside it, so observe tells a wake-list entry from a room-list
 *  one) and no name and never pre: a sign-in's entries are made with their
 *  tags. An entry with no tag has nothing a wake-list entry could be
 *  observed by, and none exists on a sign-in. */
export function wakesOf(rooms: AgentEntry[]): AgentEntry[] {
  return rooms.filter((e) => e.hooks && e.hooks.length && e.tag !== undefined).map((e) => ({ room: e.room, token: e.tag as string, tag: e.tag as string, name: "", added: e.added, state: e.state, hooks: e.hooks }));
}

/** The wake list sealed under wk for the version the row will hold:
 *  {v: 1, rooms} as JSON, padded as the room list is. */
export async function agentSealWakes(wk: Uint8Array<ArrayBuffer>, id: string, ver: number, wakes: AgentEntry[]): Promise<string> {
  const json = enc.encode(JSON.stringify({ v: 1, rooms: wakes }));
  const padded = new Uint8Array(Math.max(1, Math.ceil(json.length / AGENT_RING_PAD)) * AGENT_RING_PAD).fill(0x20);
  padded.set(json);
  return seal(wk, padded, wakesAad(id, ver));
}

/** agentSealWakes' inverse; null when it does not open (logged, as agentUnseal logs). */
export async function agentUnsealWakes(wk: Uint8Array<ArrayBuffer>, id: string, ver: number, sealed: string | null): Promise<AgentEntry[] | null> {
  try {
    if (!sealed) throw new Error("no wake list");
    const text = new TextDecoder("utf-8", { fatal: true }).decode(await open(wk, sealed, wakesAad(id, ver)));
    const v: unknown = JSON.parse(text.trim());
    if (!v || typeof v !== "object" || (v as { v?: unknown }).v !== 1 || !Array.isArray((v as { rooms?: unknown }).rooms)) throw new Error("not a list");
    return (v as { rooms: AgentEntry[] }).rooms;
  } catch {
    warn("agent.unseal", null);
    return null;
  }
}

// ---- Holder tags (room/muse.ts, mhh) on a key's or a sign-in's entries ----

/** A new holder tag: 16 random bytes, base64url (22 characters). */
export function newHolderTag(): string {
  return b64urlEncode(crypto.getRandomValues(new Uint8Array(16)));
}

/** The list with the entry of that room and token tagged: an entry with no
 *  tag gets a new one, with pre when it already records a link (those links
 *  were set without a tag, so the room holds them as "pre"); an entry with a
 *  tag keeps it. muse_register's recording write calls it, the only write
 *  that tags an entry that has no tag: two registrations racing on one
 *  untagged entry each propose a tag, the compare-and-set lets one write,
 *  and the other reads the list again and keeps the tag it finds. */
export function withTag(rooms: AgentEntry[], room: string, token: string): AgentEntry[] {
  return rooms.map((e) => {
    if (e.room !== room || e.token !== token || e.tag !== undefined) return e;
    return e.hooks && e.hooks.length ? { ...e, tag: newHolderTag(), pre: true as const } : { ...e, tag: newHolderTag() };
  });
}

/** The list with pre dropped from every entry that records no link: pre
 *  says some of the entry's links may be held as "pre", and a link leaves
 *  only on an observation that counted pre and once every recording of it
 *  has expired, so once the last link has left, no set sent without a tag
 *  can still land for this entry (tagsKept refuses dropping it earlier). */
export function clearPre(rooms: AgentEntry[]): AgentEntry[] {
  if (!rooms.some((e) => e.pre === true && !(e.hooks && e.hooks.length))) return rooms;
  return rooms.map((e) => {
    if (e.pre !== true || (e.hooks && e.hooks.length)) return e;
    const out: AgentEntry = { ...e };
    delete out.pre;
    return out;
  });
}
