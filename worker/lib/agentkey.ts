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
function decodeExact(s: string, n: number): Uint8Array<ArrayBuffer> | null {
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

/** The secret's two derivations, each with its own label. */
function derive(id: string, secret: Uint8Array<ArrayBuffer>, what: "verify" | "wrap") {
  return hkdf(secret, enc.encode(id + "|key"), enc.encode("agent-chat key " + what + " v1"), 32);
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

/** The additional data of the key's slot and of the list at a version. */
const slotAad = (id: string) => "slot|" + id + "|key|key";
const ringAad = (id: string, ver: number) => "ring|" + id + "|" + ver;

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
 *  id is a bearer secret at the bridge. */
export type AgentEntry = { room: string, token: string, name: string, added: number, state: "held" | "refused", code?: string, at?: number, hooks?: AgentWake[] };

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
