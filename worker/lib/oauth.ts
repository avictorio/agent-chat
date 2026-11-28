// The sign-in's OAuth machinery (worker/routes/oauth.ts): the known apps,
// the token forms, the documents, JWS and DPoP verification with Web
// Crypto, and known apps' key sets.
//
// Only known apps sign in. Every check OAuth defines can be passed by anyone
// who owns a domain: a client document named "Claude" on a look-alike domain
// passes them all, members do not check domains, and an approval gives the
// app full agent membership in every room ticked. So an app's name, redirect
// addresses, kind and key set address are constants here, read by a person
// from its document before it is added (nothing about an app is learned at
// run time), and the authorize page of an unknown app echoes nothing and
// fetches nothing. A caller with no credential can make the Worker fetch a
// pinned key set, at most once per OAUTH_KEYSET_REFETCH_S per isolate (and
// none while its data centre's copy is fresher than that), and a pinned
// app's own document once a day per isolate; nothing else, and never an
// address a caller chose.
//
// The tokens are an identity's slots (room/agent.ts SigninMethods): ".oc1."
// (code), ".ao1." (access), ".ar1." (refresh) and ".ad1." (the
// disconnect-only code), each followed by the identity's id, the slot's name
// and its secret, base64url with one spelling. lib/agentkey.ts
// agentCredential answers "bad" for every one of them, so every key route and
// /api/mcp refuse them as they refuse any malformed key.

import {
  OAUTH_ASSERTION_MAX_S, OAUTH_DPOP_WINDOW_S, OAUTH_FETCH_TIMEOUT_MS, OAUTH_KEYS_TRIED_MAX, OAUTH_KEYSET_MAX_BYTES, OAUTH_KEYSET_REFETCH_S,
  OAUTH_KEYSET_TTL_MAX_S, OAUTH_KEYSET_TTL_MIN_S, OAUTH_QUOTA_ROOM, OAUTH_SKEW_S, SIGNIN_SCOPE, SITE_ORIGIN,
} from "../limits.js";
import { AGENT_KEY_RE, decodeExact } from "./agentkey.js";
import { b64urlDecode, b64urlEncode, sha256hex } from "./crypto.js";
import { warn } from "./log.js";

/** The sign-in's issuer and origin, in every document, redirect, audience,
 *  htu and challenge: the site's (SITE_ORIGIN), never the request's Host.
 *  Under TEST_HOOKS, a local server's own loopback origin when its runner
 *  gives one (TEST_SIGNIN_ORIGIN), so a test's OAuth client meets the
 *  address it connected to and no request leaves the machine. */
export function signinOrigin(env: Env): string {
  const t = env.TEST_HOOKS ? env.TEST_SIGNIN_ORIGIN : undefined;
  return typeof t === "string" && /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(t) ? t : SITE_ORIGIN;
}

/* ---------- the known apps ---------- */

/** An app that may sign in, as pinned from its client document (or, for an
 *  app that publishes none, from its own requests). */
export type KnownApp = {
  /** a short name for logs */
  key: string,
  /** exactly */
  client_id: string,
  /** public: no client authentication; poppy: private_key_jwt */
  kind: "public" | "poppy",
  /** as the approval page shows it, and its host beside it */
  name: string,
  host: string,
  /** exactly; a loopback app's entries match any port (RFC 8252 section 7.3) */
  redirect_uris: string[],
  loopback: boolean,
  /** poppy only: HTTPS, on the client_id's host */
  jwks_uri?: string,
  /** the app's document says dpop_bound_access_tokens: true (RFC 9449): a token request without a proof is refused */
  dpop_always?: true,
  /** the token endpoint logs the counts-only line oauth.token_watch for it */
  watch?: true,
  /** which warning the approval page shows */
  page: "claude" | "claude-code" | "agent",
  /** a stand-in's key set, inline (TEST_HOOKS only: no live entry has one) */
  jwks?: unknown,
};

/** The known apps, all public clients and all watched: their
 *  oauth.token_watch lines say what they send at the token endpoint, which
 *  no document says. Claude's two are pinned from their client documents.
 *  Muse's connector publishes none: the person types its Client ID, muse,
 *  so its entry pins the return address Muse's own requests carry, and
 *  nothing is fetched for it. If Meta changes
 *  that address, Muse's sign-in stops at the wrong-address page until the
 *  entry is changed. */
export const KNOWN_APPS: KnownApp[] = [
  { key: "claude", client_id: "https://claude.ai/oauth/mcp-oauth-client-metadata", kind: "public", name: "Claude", host: "claude.ai", redirect_uris: ["https://claude.ai/api/mcp/auth_callback"], loopback: false, watch: true, page: "claude" },
  { key: "claude-code", client_id: "https://claude.ai/oauth/claude-code-client-metadata", kind: "public", name: "Claude Code", host: "a program on this computer", redirect_uris: ["http://localhost/callback", "http://127.0.0.1/callback"], loopback: true, watch: true, page: "claude-code" },
  { key: "muse", client_id: "muse", kind: "public", name: "Muse", host: "agent.meta.ai", redirect_uris: ["https://agent.meta.ai/api/hatch/oauth/callback"], loopback: false, watch: true, page: "agent" },
];

/** What a known app's document said when it was pinned, for the daily
 *  comparison (compareDocument): a difference is logged and followed by a
 *  person, never by the code. Muse has none to compare: it publishes no
 *  client document. */
const PINNED_DOCUMENTS: Record<string, { client_name: string, redirect_uris: string[], grant_types: string[], token_endpoint_auth_method: string }> = {
  claude: { client_name: "Claude", redirect_uris: ["https://claude.ai/api/mcp/auth_callback"], grant_types: ["authorization_code", "refresh_token", "urn:ietf:params:oauth:grant-type:jwt-bearer"], token_endpoint_auth_method: "none" },
  "claude-code": { client_name: "Claude Code", redirect_uris: ["http://localhost/callback", "http://127.0.0.1/callback"], grant_types: ["authorization_code", "refresh_token"], token_endpoint_auth_method: "none" },
};

/** A stand-in entry as the test hook stored it, checked; null when it is not one. */
function standIn(v: unknown): KnownApp | null {
  if (!v || typeof v !== "object") return null;
  const a = v as Record<string, unknown>;
  const str = (x: unknown) => typeof x === "string" && x.length > 0;
  if (!str(a.key) || !str(a.client_id) || (a.kind !== "public" && a.kind !== "poppy") || !str(a.name) || !str(a.host)) return null;
  if (!Array.isArray(a.redirect_uris) || !a.redirect_uris.every(str) || typeof a.loopback !== "boolean") return null;
  if (a.page !== "claude" && a.page !== "claude-code" && a.page !== "agent") return null;
  const out: KnownApp = { key: String(a.key), client_id: String(a.client_id), kind: a.kind, name: String(a.name), host: String(a.host), redirect_uris: a.redirect_uris.map(String), loopback: a.loopback, page: a.page };
  if (a.dpop_always === true) out.dpop_always = true;
  if (a.watch === true) out.watch = true;
  if (a.jwks !== undefined) out.jwks = a.jwks;
  // a stand-in's key set address: the test's own server (a test server's Worker fetches nothing outside)
  if (typeof a.jwks_uri === "string" && /^http:\/\/127\.0\.0\.1:\d+\//.test(a.jwks_uri)) out.jwks_uri = a.jwks_uri;
  return out;
}

/** The known app of a client_id, or null. Under TEST_HOOKS only, also the
 *  API suite's stand-ins (routes/test-hooks.ts hookOauthApp), from the
 *  OAUTH_QUOTA_ROOM object; live, no object is asked. */
export async function knownApp(env: Env, clientId: string): Promise<KnownApp | null> {
  const pinned = KNOWN_APPS.find((a) => a.client_id === clientId);
  if (pinned) return pinned;
  if (!env.TEST_HOOKS || !clientId) return null;
  const list = await env.ROOM.get(env.ROOM.idFromName(OAUTH_QUOTA_ROOM)).oauthTestApps();
  for (const v of Array.isArray(list) ? list : []) {
    const a = standIn(v);
    if (a && a.client_id === clientId) return a;
  }
  return null;
}

/** Whether a redirect_uri is one of the app's, exactly; or, for a loopback
 *  app, http on 127.0.0.1 or localhost, either, with a pinned loopback
 *  entry's path and any port. */
export function redirectAllowed(app: KnownApp, redirect: string): boolean {
  if (app.redirect_uris.includes(redirect)) return true;
  if (!app.loopback) return false;
  let u: URL;
  try { u = new URL(redirect); } catch { return false; /* not an address: not one of the app's */ }
  if (u.protocol !== "http:" || (u.hostname !== "127.0.0.1" && u.hostname !== "localhost") || u.username || u.password || u.hash) return false;
  return app.redirect_uris.some((p) => {
    try { const q = new URL(p); return q.protocol === "http:" && (q.hostname === "127.0.0.1" || q.hostname === "localhost") && q.pathname === u.pathname && q.search === u.search; } catch { return false; /* a pinned entry that is no address matches nothing */ }
  });
}

/** One day per isolate per app: when each app's document was last compared. */
const compared = new Map<string, string>();

/** The daily comparison of a pinned app's document with what was pinned:
 *  at most once a UTC day per isolate, on an authorize for that app, no
 *  redirects, at most 5 KB, within OAUTH_FETCH_TIMEOUT_MS. A difference, or
 *  a document that cannot be read, is logged oauth.client_changed with the
 *  app's key, and nothing else follows from it. An app with no pinned
 *  document, Muse or a stand-in, is never fetched. */
export async function compareDocument(app: KnownApp): Promise<void> {
  const pinned = PINNED_DOCUMENTS[app.key];
  if (!pinned || KNOWN_APPS.indexOf(app) < 0) return;
  const day = new Date().toISOString().slice(0, 10);
  if (compared.get(app.key) === day) return;
  compared.set(app.key, day);
  let same = false;
  try {
    const text = await boundedFetch(app.client_id, 5000);
    const d: unknown = text === null ? null : JSON.parse(text);
    if (d && typeof d === "object") {
      const doc = d as Record<string, unknown>;
      const list = (x: unknown) => (Array.isArray(x) ? x.map(String).sort().join(" ") : "");
      same = doc.client_id === app.client_id && doc.client_name === pinned.client_name && list(doc.redirect_uris) === list(pinned.redirect_uris)
        && list(doc.grant_types) === list(pinned.grant_types) && doc.token_endpoint_auth_method === pinned.token_endpoint_auth_method;
    }
  } catch { same = false; /* a document that cannot be read is a difference to look at */ }
  if (!same) warn("oauth.client_changed", null, { app: app.key });
}

/** A GET with no redirects, no cookie or credential, at most max bytes,
 *  within OAUTH_FETCH_TIMEOUT_MS: the text, or null (any other status, a
 *  redirect, too long, too slow). */
async function boundedFetch(url: string, max: number): Promise<string | null> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), OAUTH_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { method: "GET", redirect: "manual", signal: ctl.signal, headers: { accept: "application/json" } });
    if (res.status !== 200 || !res.body) { try { await res.body?.cancel(); } catch { /* nothing left to read */ } return null; }
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const c = await reader.read();
      if (c.done) break;
      size += c.value.byteLength;
      if (size > max) { try { await reader.cancel(); } catch { /* the far end went away */ } return null; }
      chunks.push(c.value);
    }
    const all = new Uint8Array(size);
    let o = 0;
    for (const c of chunks) { all.set(c, o); o += c.byteLength; }
    return new TextDecoder("utf-8", { fatal: true }).decode(all);
  } finally {
    clearTimeout(t);
  }
}

/* ---------- the token forms ---------- */

export type SigninForm = "oc" | "ao" | "ar" | "ad";
export type SigninKind = "code" | "access" | "refresh" | "disconnect";
export const FORM_KIND: Record<SigninForm, SigninKind> = { oc: "code", ao: "access", ar: "refresh", ad: "disconnect" };
const KIND_FORM: Record<SigninKind, SigninForm> = { code: "oc", access: "ao", refresh: "ar", disconnect: "ad" };
/** A sign-in token: its form, the identity's id (16 bytes), the slot's name (8) and the secret (32). */
export const SIGNIN_TOKEN_RE = /^\.(oc|ao|ar|ad)1\.([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{11})\.([A-Za-z0-9_-]{43})$/;
export type SigninToken = { form: SigninForm, kind: SigninKind, id: string, slot: string, secret: Uint8Array<ArrayBuffer> };

/** A text as a sign-in token, every part base64url of one spelling; null for anything else. */
export function parseSigninToken(v: unknown): SigninToken | null {
  if (typeof v !== "string") return null;
  const m = SIGNIN_TOKEN_RE.exec(v);
  if (!m) return null;
  if (!decodeExact(m[2], 16) || !decodeExact(m[3], 8)) return null;
  const secret = decodeExact(m[4], 32);
  if (!secret) return null;
  const form = m[1] as SigninForm;
  return { form, kind: FORM_KIND[form], id: m[2], slot: m[3], secret };
}

/** The credential the sign-in address reads: Authorization: Bearer only.
 *  none; a sign-in token; an agent key (its form: the address only says
 *  where keys work, so it asks no object); a room invite token (no dot
 *  first); or another dot form. */
export type SigninCredential = { kind: "none" } | { kind: "token", t: SigninToken } | { kind: "key" } | { kind: "invite" } | { kind: "bad" };
export function signinCredential(request: Request): SigninCredential {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(request.headers.get("Authorization") || "");
  if (!m) return { kind: "none" };
  const v = m[1];
  if (v.charAt(0) !== ".") return { kind: "invite" };
  const t = parseSigninToken(v);
  if (t) return { kind: "token", t };
  const k = AGENT_KEY_RE.exec(v);
  return k && decodeExact(k[1], 16) && decodeExact(k[2], 32) ? { kind: "key" } : { kind: "bad" };
}

/** A new slot of a sign-in: its name (8 random bytes), its secret (32) and the token that carries them. */
export function newSlotToken(id: string, kind: SigninKind): { slot: string, secret: Uint8Array<ArrayBuffer>, token: string } {
  const slot = b64urlEncode(crypto.getRandomValues(new Uint8Array(8)));
  const secret = crypto.getRandomValues(new Uint8Array(32));
  return { slot, secret, token: "." + KIND_FORM[kind] + "1." + id + "." + slot + "." + b64urlEncode(secret) };
}

/** A new identity id for a sign-in: 16 random bytes, as a key's. */
export function newSigninId(): string {
  return b64urlEncode(crypto.getRandomValues(new Uint8Array(16)));
}

/* ---------- the documents ---------- */

/** The domain's protected-resource metadata (RFC 9728), at
 *  /.well-known/oauth-protected-resource. */
export function domainResourceDoc(origin: string) {
  return { resource: origin, authorization_servers: [origin], scopes_supported: [SIGNIN_SCOPE] };
}
/** The sign-in address's, at /.well-known/oauth-protected-resource/api/mcp/signin. */
export function signinResourceDoc(origin: string) {
  return { resource: origin + "/api/mcp/signin", authorization_servers: [origin], scopes_supported: [SIGNIN_SCOPE], bearer_methods_supported: ["header"], resource_name: "Agent Chat", resource_documentation: origin + "/api" };
}
/** The authorization server's metadata (RFC 8414). */
export function authServerDoc(origin: string) {
  return {
    issuer: origin,
    authorization_endpoint: origin + "/oauth/authorize",
    token_endpoint: origin + "/api/oauth/token",
    revocation_endpoint: origin + "/api/oauth/revoke",
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none", "private_key_jwt"],
    token_endpoint_auth_signing_alg_values_supported: ["ES256", "PS384"],
    revocation_endpoint_auth_methods_supported: ["none", "private_key_jwt"],
    revocation_endpoint_auth_signing_alg_values_supported: ["ES256", "PS384"],
    dpop_signing_alg_values_supported: ["ES256", "PS384"],
    scopes_supported: [SIGNIN_SCOPE],
    protected_resources: [origin, origin + "/api/mcp/signin"],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
  };
}

/** A resource indicator as the sign-in takes it: the sign-in address or
 *  the domain, with an upper-case scheme or host or a trailing slash
 *  accepted, in its canonical spelling; null for any other. */
export function canonicalResource(v: string, origin: string): string | null {
  let u: URL;
  try { u = new URL(v); } catch { return null; /* not an address: not one this server offers */ }
  if (u.username || u.password || u.search || u.hash || v.includes("?") || v.includes("#")) return null;
  if (u.origin !== origin) return null;
  if (u.pathname === "/" || u.pathname === "") return origin;
  if (u.pathname === "/api/mcp/signin" || u.pathname === "/api/mcp/signin/") return origin + "/api/mcp/signin";
  return null;
}

/* ---------- JWS ---------- */

/** A compact JWS, split and its JSON parts parsed (nothing verified yet). */
export type Jws = { header: Record<string, unknown>, payload: Record<string, unknown>, signed: Uint8Array<ArrayBuffer>, sig: Uint8Array<ArrayBuffer> };
const B64URL_RE = /^[A-Za-z0-9_-]*$/;

function jsonPart(part: string): Record<string, unknown> | null {
  if (!part || !B64URL_RE.test(part)) return null;
  try {
    const v: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(b64urlDecode(part)));
    return v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null;
  } catch { return null; /* not JSON: no JWS */ }
}

/** Three parts, base64url, the first two JSON objects; null for anything else. */
export function parseJws(text: unknown): Jws | null {
  if (typeof text !== "string" || text.length > 16384) return null;
  const parts = text.split(".");
  if (parts.length !== 3 || !B64URL_RE.test(parts[2]) || !parts[2]) return null;
  const header = jsonPart(parts[0]), payload = jsonPart(parts[1]);
  if (!header || !payload) return null;
  let sig: Uint8Array<ArrayBuffer>;
  try { sig = b64urlDecode(parts[2]); } catch { return null; /* not base64url */ }
  return { header, payload, signed: new TextEncoder().encode(parts[0] + "." + parts[1]), sig };
}

/** A public JWK as the sign-in takes one: EC P-256, or RSA of 2048 to 4096
 *  bits; never one with private members. */
export type Jwk = Record<string, unknown>;
const PRIVATE_MEMBERS = ["d", "p", "q", "dp", "dq", "qi", "oth", "k"];
export function jwkHasPrivate(k: Jwk): boolean {
  return PRIVATE_MEMBERS.some((m) => m in k);
}
/** The algorithm a key fits: ES256 for EC P-256, PS384 for RSA of 2048 to 4096 bits; null for any other. */
export function jwkAlg(k: Jwk): "ES256" | "PS384" | null {
  if (jwkHasPrivate(k)) return null;
  if (k.kty === "EC" && k.crv === "P-256" && typeof k.x === "string" && typeof k.y === "string") {
    const x = decodeExact(k.x, 32), y = decodeExact(k.y, 32);
    return x && y ? "ES256" : null;
  }
  if (k.kty === "RSA" && typeof k.n === "string" && typeof k.e === "string" && B64URL_RE.test(k.n) && B64URL_RE.test(k.e)) {
    let n: Uint8Array;
    try { n = b64urlDecode(k.n); } catch { return null; /* not base64url */ }
    let i = 0;
    while (i < n.length && n[i] === 0) i++;
    const bits = i < n.length ? (n.length - i - 1) * 8 + (32 - Math.clz32(n[i])) : 0;
    return bits >= 2048 && bits <= 4096 ? "PS384" : null;
  }
  return null;
}

/** Whether a JWS verifies with a key, for its algorithm: ES256 over the raw
 *  64-byte r||s (a signature of any other length fails), PS384 with a salt
 *  of 48 bytes. */
export async function jwsVerifies(j: Jws, k: Jwk, alg: "ES256" | "PS384"): Promise<boolean> {
  if (jwkAlg(k) !== alg) return false;
  try {
    if (alg === "ES256") {
      if (j.sig.length !== 64) return false;
      const key = await crypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", x: String(k.x), y: String(k.y) }, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
      return await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, j.sig, j.signed);
    }
    const key = await crypto.subtle.importKey("jwk", { kty: "RSA", n: String(k.n), e: String(k.e) }, { name: "RSA-PSS", hash: "SHA-384" }, false, ["verify"]);
    return await crypto.subtle.verify({ name: "RSA-PSS", saltLength: 48 }, key, j.sig, j.signed);
  } catch {
    return false; /* a key Web Crypto refuses verifies nothing */
  }
}

/** RFC 7638's SHA-256 thumbprint of a public key, base64url. */
export async function jwkThumbprint(k: Jwk): Promise<string> {
  const members = k.kty === "EC" ? { crv: k.crv, kty: k.kty, x: k.x, y: k.y } : { e: k.e, kty: k.kty, n: k.n };
  return b64urlEncode(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(members))));
}

/** A hash a store keeps instead of a value (a jti, a request): SHA-256, hex, with its prefix. */
export async function storedHash(prefix: string, v: string): Promise<string> {
  return prefix + (await sha256hex(v));
}

/** A JWS's time claims as seconds, or null when one is there and not a number. */
function claimNumber(p: Record<string, unknown>, name: string): number | null | undefined {
  const v = p[name];
  if (v === undefined) return undefined;
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/* ---------- key sets ---------- */

// An app's key set, per isolate and jwks_uri, with nothing shared that a
// caller could hold and no object called: the set this isolate holds, the
// fetch it has in flight, and its last try; and the data centre's Cache API
// copy, which carries when it was fetched. A fetch starts only when no
// fetch is in flight here, the last try started more than
// OAUTH_KEYSET_REFETCH_S ago (failed or not), and the data centre's copy is
// no fresher than that; every request that needs the set meanwhile waits
// for the one in flight. So fetches follow where requests land, at most one
// per window per isolate, never how many arrive.

/** A key set as kept: its keys, when it was fetched and until when it is live (ms). */
type KeySet = { keys: Jwk[], fetchedAt: number, until: number };
/** One try: when it started, and whether the app's host failed it. */
type KeyTry = { at: number, failed: boolean };
/** What this isolate keeps of one jwks_uri: the set; the fetch in flight
 *  (its promise settles once the set is kept, plain data shared by the
 *  requests that wait, never a Response); the last try. */
type HeldSet = { set: KeySet | null, inflight: { done: Promise<void>, of: KeyTry } | null, lastTry: KeyTry | null };
const heldSets = new Map<string, HeldSet>();
/** Stand-ins' inline sets, parsed once. */
const inlineSets = new Map<string, Jwk[]>();

/** Only for tests: this isolate's key sets forgotten, as a new isolate starts. */
export function forgetKeySets(): void {
  heldSets.clear();
  inlineSets.clear();
}

/** The keys of a set this server takes: public EC P-256 or RSA of 2048 to
 *  4096 bits, each with a kid; a key without one is skipped and logged. */
function keptKeys(app: KnownApp, set: unknown): Jwk[] {
  const list = set && typeof set === "object" && Array.isArray((set as { keys?: unknown }).keys) ? (set as { keys: unknown[] }).keys : [];
  const out: Jwk[] = [];
  let noKid = false;
  for (const v of list) {
    if (!v || typeof v !== "object" || Array.isArray(v)) continue;
    const k = v as Jwk;
    if (!jwkAlg(k)) continue;
    if (typeof k.kid !== "string" || !k.kid) { noKid = true; continue; }
    out.push(k);
  }
  if (noKid) warn("oauth.keyset", null, { app: app.key, reason: "no_kid" });
  return out;
}

/** What the key lookup asks of its caller: whether a fetch this request
 *  would start may start (the caller's counter, read just before: false
 *  stops the lookup with no fetch), and where to hand a fetch so that it
 *  outlives a requester that hangs up (the request's waitUntil). */
export type KeyLookup = { mayFetch: () => Promise<boolean>, waitUntil: (p: Promise<unknown>) => void };

/** The keys of the app's set this assertion can be checked with (pick: its
 *  kid's key, or the keys of its type), in this order. A stand-in's inline
 *  set. Else: 1. this isolate's copy, while live and holding such a key; 2.
 *  the data centre's copy, adopted when live and fetched later than this
 *  isolate's, and used if it now holds one; 3. a fetch in flight here is
 *  waited for, each waiter on a timer of its own, at most
 *  OAUTH_FETCH_TIMEOUT_MS and a second more (and one older than that is
 *  forgotten, so a fetch that never settles holds nothing); else a fetch
 *  starts only when the last try started more than OAUTH_KEYSET_REFETCH_S
 *  ago and the data centre's copy, if any, was fetched more than that ago
 *  (a fresher copy that lacks the key means there is no such key): the
 *  caller's mayFetch first, then, in one synchronous step, the try and the
 *  fetch in flight recorded, and the fetch handed to waitUntil; 4. a live
 *  set's keys; a set whose time is up only after a try the app's host
 *  failed, and never once older than its time plus OAUTH_KEYSET_TTL_MAX_S;
 *  else none. stopped: mayFetch refused. */
export async function keysFor(app: KnownApp, pick: (keys: Jwk[]) => Jwk[], o: KeyLookup): Promise<{ keys: Jwk[] } | { stopped: true }> {
  if (app.jwks !== undefined) {
    const id = app.client_id + "\n" + JSON.stringify(app.jwks);
    let keys = inlineSets.get(id);
    if (!keys) { keys = keptKeys(app, app.jwks); inlineSets.set(id, keys); }
    return { keys: pick(keys) };
  }
  const uri = app.jwks_uri;
  if (!uri) return { keys: [] };
  let h = heldSets.get(uri);
  if (!h) { h = { set: null, inflight: null, lastTry: null }; heldSets.set(uri, h); }
  const held = h;
  const live = (now: number) => (held.set && held.set.until > now ? pick(held.set.keys) : []);
  let got = live(Date.now());
  if (got.length) return { keys: got };
  const cached = await cacheGet(uri);
  if (cached && cached.until > Date.now() && (!held.set || cached.fetchedAt > held.set.fetchedAt)) held.set = { keys: keptKeys(app, cached.set), fetchedAt: cached.fetchedAt, until: cached.until };
  got = live(Date.now());
  if (got.length) return { keys: got };
  const waitMs = OAUTH_FETCH_TIMEOUT_MS + 1000, windowMs = OAUTH_KEYSET_REFETCH_S * 1000;
  const mayStart = (now: number) => !held.inflight && (!held.lastTry || now - held.lastTry.at > windowMs) && (!cached || now - cached.fetchedAt > windowMs);
  if (held.inflight && Date.now() - held.inflight.of.at > waitMs) held.inflight = null;
  if (held.inflight) await settledWithin(held.inflight.done, waitMs);
  else if (mayStart(Date.now())) {
    if (!(await o.mayFetch())) return { stopped: true };
    // another request may have started one while the counter was read: wait for it instead
    const meanwhile = held.inflight as HeldSet["inflight"];
    if (meanwhile) await settledWithin(meanwhile.done, waitMs);
    else if (mayStart(Date.now())) {
      const tr: KeyTry = { at: Date.now(), failed: false };
      held.lastTry = tr;
      const done = fetchInto(app, uri, held, tr);
      held.inflight = { done, of: tr };
      o.waitUntil(done);
      await settledWithin(done, waitMs);
    }
  }
  const now = Date.now();
  if (held.set && held.set.until > now) return { keys: pick(held.set.keys) };
  if (held.set && held.lastTry && held.lastTry.failed && now <= held.set.until + OAUTH_KEYSET_TTL_MAX_S * 1000) return { keys: pick(held.set.keys) };
  return { keys: [] };
}

/** p settled, or ms passed, whichever is first (a timer of the waiter's own). */
async function settledWithin(p: Promise<void>, ms: number): Promise<void> {
  let t: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([p, new Promise<void>((res) => { t = setTimeout(res, ms); })]);
  } finally {
    clearTimeout(t);
  }
}

/** The try's fetch of the set, kept by this isolate and the data centre's
 *  Cache API on success. One OAUTH_FETCH_TIMEOUT_MS covers both attempts, so
 *  a fetch in flight ends within it. A fetch that rejects for a reason
 *  other than that timeout (a refused connection, a name or TLS failure, a
 *  fetch cut off) is fetched once more, at once: a refused connection is
 *  the app's host being down, which is what the last set is kept for, and a
 *  fetch cut off because its requester hung up cannot also cut one started
 *  after the requester had gone, so a caller cannot make a try fail. The
 *  try is marked failed when the host failed an attempt (a status, a
 *  redirect, the size cap, the timeout, a body that does not parse: no
 *  second attempt after such a first), or when the second rejected too,
 *  logged as cut. The fetch in flight is cleared either way. Never throws. */
async function fetchInto(app: KnownApp, uri: string, held: HeldSet, tr: KeyTry): Promise<void> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), OAUTH_FETCH_TIMEOUT_MS);
  try {
    let got = await fetchKeySet(app, uri, ctl.signal);
    if (got === "rejected") got = await fetchKeySet(app, uri, ctl.signal);
    if (got === "rejected") warn("oauth.keyset", null, { app: app.key, cut: true });
    if (got === "failed" || got === "rejected") { tr.failed = true; return; }
    const now = Date.now();
    const set: KeySet = { keys: keptKeys(app, got.set), fetchedAt: now, until: now + got.ttl * 1000 };
    if (!held.set || set.fetchedAt >= held.set.fetchedAt) held.set = set;
    await cachePut(uri, got.text, set);
  } catch {
    // keptKeys or the cache threw: nothing kept, nothing marked failed
  } finally {
    clearTimeout(t);
    if (held.inflight && held.inflight.of === tr) held.inflight = null;
  }
}

/** One fetch of the pinned key set (no redirects, no credential, at most
 *  OAUTH_KEYSET_MAX_BYTES, until signal aborts it: the try's one timeout),
 *  with how long to keep it (its Cache-Control within the bounds). failed:
 *  the app's host failed it (a status, a redirect, the size cap, the
 *  timeout, a body that does not parse), logged with the status; rejected:
 *  the fetch broke off for any other reason, unlogged, as fetchInto tries
 *  once more. */
async function fetchKeySet(app: KnownApp, uri: string, signal: AbortSignal): Promise<{ set: unknown, text: string, ttl: number } | "failed" | "rejected"> {
  const failed = (status: number): "failed" => { warn("oauth.keyset", null, { app: app.key, status }); return "failed"; };
  try {
    const res = await fetch(uri, { method: "GET", redirect: "manual", signal, headers: { accept: "application/jwk-set+json, application/json" } });
    if (res.status !== 200 || !res.body) { try { await res.body?.cancel(); } catch { /* nothing left to read */ } return failed(res.status); }
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const c = await reader.read();
      if (c.done) break;
      size += c.value.byteLength;
      if (size > OAUTH_KEYSET_MAX_BYTES) { try { await reader.cancel(); } catch { /* the far end went away */ } return failed(413); }
      chunks.push(c.value);
    }
    const all = new Uint8Array(size);
    let o = 0;
    for (const c of chunks) { all.set(c, o); o += c.byteLength; }
    let set: unknown, text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(all);
      set = JSON.parse(text) as unknown;
    } catch {
      return failed(200);
    }
    const m = /max-age=(\d+)/i.exec(res.headers.get("Cache-Control") || "");
    const ttl = Math.min(OAUTH_KEYSET_TTL_MAX_S, Math.max(OAUTH_KEYSET_TTL_MIN_S, m ? Number(m[1]) : OAUTH_KEYSET_TTL_MIN_S));
    return { set, text, ttl };
  } catch {
    // the timeout aborted it: the host failed it; anything else rejected it
    if (signal.aborted) return failed(0);
    return "rejected";
  }
}

/** The data centre's Cache API copy of a key set while it is live, with
 *  when it was fetched (absent where the runtime has none). */
async function cacheGet(uri: string): Promise<{ set: unknown, fetchedAt: number, until: number } | null> {
  if (typeof caches === "undefined") return null;
  try {
    const r = await (caches as unknown as { default: Cache }).default.match(new Request(uri));
    if (!r) return null;
    const until = Number(r.headers.get("X-Kept-Until")) || 0;
    const fetchedAt = Number(r.headers.get("X-Fetched-At")) || 0;
    if (until <= Date.now()) return null;
    return { set: JSON.parse(await r.text()) as unknown, fetchedAt, until };
  } catch { return null; /* no cache here, or a copy that does not parse: as if none */ }
}
async function cachePut(uri: string, text: string, set: KeySet): Promise<void> {
  if (typeof caches === "undefined") return;
  try {
    const maxAge = Math.max(1, Math.ceil((set.until - Date.now()) / 1000));
    await (caches as unknown as { default: Cache }).default.put(new Request(uri), new Response(text, { headers: { "Cache-Control": "max-age=" + maxAge, "X-Fetched-At": String(set.fetchedAt), "X-Kept-Until": String(set.until) } }));
  } catch { /* the cache refused it: this isolate keeps its own copy */ }
}

/* ---------- the client assertion (RFC 7523, Poppy 4.1) ---------- */

/** What checkAssertion asks its caller: whether the costly part may run
 *  (the caller's counter, read once, just before the first of a key-set
 *  fetch this request would start or the first signature check: false
 *  stops the check), and where to hand a key-set fetch so that it outlives
 *  the request (its waitUntil). */
export type AssertionHooks = { mayVerify: () => Promise<boolean>, waitUntil: (p: Promise<unknown>) => void };

/** A client assertion's checks, in this order, so that a copy of an app's
 *  old assertion, or one it signed for another site, costs no key, fetch or
 *  signature: the JWS parsed, its alg ES256 or PS384, no crit; the claims as
 *  the assertion presents them (iss and sub the client_id, aud the issuer, a
 *  string, character for character; exp, iat and nbf with OAUTH_SKEW_S of
 *  skew; exp - iat at most OAUTH_ASSERTION_MAX_S; a jti of at least 16
 *  characters), refused before the signature proves them; then the key
 *  (keysFor: its kid's key, or each key of its type, at most
 *  OAUTH_KEYS_TRIED_MAX, with no kid), with hooks.mayVerify asked just
 *  before a fetch this request would start; then hooks.mayVerify, if not
 *  asked yet, just before the first signature check; then the signature.
 *  The caller records the jti once this passes, and refuses a replay there.
 *  Not ok: checked says a signature was checked and none matched (the one
 *  failure the caller counts); stopped that mayVerify refused. jku, x5u, jwk
 *  and x5c are ignored. */
export async function checkAssertion(app: KnownApp, assertion: unknown, issuer: string, nowS: number, hooks: AssertionHooks): Promise<{ ok: true, jti: string, exp: number, alg: string, hasKid: boolean } | { ok: false, alg: string | null, hasKid: boolean, checked: boolean, stopped?: true }> {
  const j = parseJws(assertion);
  const alg = j && typeof j.header.alg === "string" ? j.header.alg : null;
  const kid = j && typeof j.header.kid === "string" ? j.header.kid : null;
  const no = { ok: false as const, alg, hasKid: kid !== null, checked: false };
  if (!j || (alg !== "ES256" && alg !== "PS384") || "crit" in j.header) return no;
  const p = j.payload;
  if (p.iss !== app.client_id || p.sub !== app.client_id || typeof p.aud !== "string" || p.aud !== issuer) return no;
  const exp = claimNumber(p, "exp"), iat = claimNumber(p, "iat"), nbf = claimNumber(p, "nbf");
  if (typeof exp !== "number" || typeof iat !== "number" || nbf === null) return no;
  if (!(exp > nowS - OAUTH_SKEW_S) || !(iat <= nowS + OAUTH_SKEW_S) || (typeof nbf === "number" && !(nbf <= nowS + OAUTH_SKEW_S))) return no;
  if (exp - iat > OAUTH_ASSERTION_MAX_S) return no;
  if (typeof p.jti !== "string" || p.jti.length < 16) return no;
  // the counter, read once, just before the first costly step
  let asked: Promise<boolean> | null = null;
  const mayVerify = () => (asked = asked || hooks.mayVerify());
  const pick = (keys: Jwk[]) => (kid !== null ? keys.filter((k) => k.kid === kid && jwkAlg(k) === alg) : keys.filter((k) => jwkAlg(k) === alg).slice(0, OAUTH_KEYS_TRIED_MAX));
  const found = await keysFor(app, pick, { mayFetch: mayVerify, waitUntil: hooks.waitUntil });
  if ("stopped" in found) return { ...no, stopped: true };
  if (!found.keys.length) return no;
  if (!(await mayVerify())) return { ...no, stopped: true };
  for (const k of found.keys) if (await jwsVerifies(j, k, alg)) return { ok: true, jti: p.jti, exp, alg, hasKid: kid !== null };
  return { ...no, checked: true };
}

/** A client assertion's sub, decoded and not yet trusted: which app it names
 *  when the form names none. */
export function assertionSubject(assertion: unknown): string | null {
  const j = parseJws(assertion);
  return j && typeof j.payload.sub === "string" ? j.payload.sub : null;
}

/* ---------- DPoP (RFC 9449, "Checking DPoP Proofs") ---------- */

/** The URI a proof's htu is compared on: scheme and host in lower case, no
 *  default port, no query or fragment; null when it is no address. */
function htuOf(v: string): string | null {
  try { const u = new URL(v); return u.protocol + "//" + u.host + u.pathname; } catch { return null; /* not an address */ }
}

/** The request's DPoP header checked as RFC 9449 lists: one header, one
 *  well-formed JWT, jti (at least 16 characters), htm, htu and iat there,
 *  typ dpop+jwt, no crit, nbf with OAUTH_SKEW_S of skew, alg ES256 or PS384,
 *  the signature by the jwk header's key, that key public, htm POST, htu
 *  this endpoint (built from the issuer, never from Host), iat within
 *  OAUTH_DPOP_WINDOW_S and at most OAUTH_SKEW_S ahead. This server sends no
 *  nonce. none: no header; else the proof's key thumbprint and jti (its
 *  replay is the caller's, clientNote), or bad. */
export async function checkDpop(request: Request, htu: string, nowS: number): Promise<{ kind: "none" } | { kind: "bad" } | { kind: "ok", jkt: string, jti: string }> {
  const raw = request.headers.get("DPoP");
  if (raw === null) return { kind: "none" };
  // two headers arrive joined with a comma, which no JWT holds
  if (raw.includes(",")) return { kind: "bad" };
  const j = parseJws(raw.trim());
  if (!j) return { kind: "bad" };
  const h = j.header, p = j.payload;
  if (typeof p.jti !== "string" || p.jti.length < 16 || typeof p.htm !== "string" || typeof p.htu !== "string") return { kind: "bad" };
  const iat = claimNumber(p, "iat"), nbf = claimNumber(p, "nbf");
  if (typeof iat !== "number" || nbf === null) return { kind: "bad" };
  if (h.typ !== "dpop+jwt" || "crit" in h) return { kind: "bad" };
  if (typeof nbf === "number" && !(nbf <= nowS + OAUTH_SKEW_S)) return { kind: "bad" };
  const alg = h.alg;
  if (alg !== "ES256" && alg !== "PS384") return { kind: "bad" };
  const jwk = h.jwk;
  if (!jwk || typeof jwk !== "object" || Array.isArray(jwk) || jwkHasPrivate(jwk as Jwk)) return { kind: "bad" };
  if (!(await jwsVerifies(j, jwk as Jwk, alg))) return { kind: "bad" };
  if (p.htm !== "POST") return { kind: "bad" };
  const want = htuOf(htu), got = htuOf(p.htu);
  if (!want || !got || want !== got) return { kind: "bad" };
  if (!(iat >= nowS - OAUTH_DPOP_WINDOW_S) || !(iat <= nowS + OAUTH_SKEW_S)) return { kind: "bad" };
  return { kind: "ok", jkt: await jwkThumbprint(jwk as Jwk), jti: p.jti };
}

/** A dpop_jkt as an authorization request may send it: 43 characters of base64url. */
export const JKT_RE = /^[A-Za-z0-9_-]{43}$/;
