// The sign-in for known apps: an OAuth authorization server whose sign-ins
// are identities of the agent key's kind (room/agent.ts SigninMethods), and
// whose tokens open them (lib/oauth.ts holds the forms, the known apps and
// the checks). Claude's apps (claude.ai, desktop, mobile), Claude Code and
// Muse connect to /api/mcp/signin (routes/agent.ts signinMcpRoute), meet its
// 401, find these documents, and send their person here:
//   GET  /.well-known/oauth-protected-resource[/api/mcp/signin]  the documents
//   GET  /.well-known/oauth-authorization-server
//   GET  /oauth/authorize       the request checked, then the app shell's
//                               approval page (web/app/src/features/signin/)
//   POST /api/oauth/decide      the page's approve or deny (same origin only)
//   POST /api/oauth/token       a code or a refresh token for tokens
//   POST /api/oauth/revoke      RFC 7009
//   POST /api/oauth/disconnect  the disconnect-only code (same origin only)
// The person approves on this site's own page, in the browser that holds
// their rooms, and chooses the rooms: the approval makes the agent's seats
// exactly as the person's way of making a key does, with the same functions
// (routes/agent.ts personBody, lookInviters, planSeats, seatNow), and puts
// each on the sign-in at once, sealed, so no answer carries a room's token.
// A sign-in holds no invite it could open, and opens nothing it holds:
// holding a room never joins it. Every body is capped before it is read, and
// a credential sent in a body is opened only once the body is in. The lines
// this file logs carry names and booleans only.

import {
  OAUTH_ACCESS_TTL_S, OAUTH_AUTH_FAILS_PER_IP, OAUTH_AUTH_FAILS_WINDOW_S, OAUTH_CLIENT_PREFIX, OAUTH_DISCONNECT_CODE, OAUTH_DPOP_WINDOW_S, OAUTH_FORM_MAX,
  OAUTH_QUOTA_ROOM, OAUTH_REQUEST_KEEP_S, OAUTH_SKEW_S, AGENT_QUOTA_ROOM, AGENT_SWAP_TRIES, SIGNIN_SCOPE, SMALL_BODY_MAX,
} from "../limits.js";
import { BadRequest, CORS, CORS_OAUTH, jsonAs, readBody, settleBody, type Body } from "../lib/http.js";
import {
  agentOpenRing, agentSealRing, agentSealWakes, agentUnsealWakes, newKeyBytes, openNext, sealNext, slotUnwrap, slotVerifier, slotWrap, tagsKept, wakesOf, type AgentEntry,
} from "../lib/agentkey.js";
import { keepsWakes } from "../lib/wakes.js";
import { hashKey, networkKey } from "../lib/address.js";
import { b64urlEncode, sha256hex } from "../lib/crypto.js";
import { warn } from "../lib/log.js";
import {
  JKT_RE, assertionSubject, authServerDoc, parseJws, signinOrigin, canonicalResource, checkAssertion, checkDpop, compareDocument, domainResourceDoc, knownApp, newSigninId, newSlotToken,
  parseSigninToken, redirectAllowed, signinResourceDoc, storedHash, type KnownApp, type SigninKind, type SigninToken,
} from "../lib/oauth.js";
import { signinDropNote } from "../agents/onboarding.js";
import { AUTHORIZE_HEADERS, page } from "./pages.js";
import {
  creationCaps, dropWakes, lookInviters, outlive, personBody, planSeats, plannedView, seatsNow, unusedFields,
  type Cred, type Made, type Opened, type Planned, type Refused, type SeatMade, type Unsealed,
} from "./agent.js";
import type { RouteContext } from "../index.js";

/** The identity's object, a Room under a name no room can have (as a key's). */
function identity(env: Env, id: string): DurableObjectStub {
  return env.ROOM.get(env.ROOM.idFromName("__agent-" + id));
}
/** The name of a known app's store: its seen jtis and approved requests (room/agent.ts clientNote). */
async function appStoreName(app: KnownApp): Promise<string> {
  return OAUTH_CLIENT_PREFIX + (await sha256hex(app.client_id)).slice(0, 32);
}
/** A known app's store, by its name (a stub is never handed through a promise). */
function appStore(env: Env, name: string): DurableObjectStub {
  return env.ROOM.get(env.ROOM.idFromName(name));
}
function quotas(env: Env): DurableObjectStub {
  return env.ROOM.get(env.ROOM.idFromName(OAUTH_QUOTA_ROOM));
}
function agentQuota(env: Env): DurableObjectStub {
  return env.ROOM.get(env.ROOM.idFromName(AGENT_QUOTA_ROOM));
}

/* ---------- the documents ---------- */

/** A document's answer: cached an hour, open to every origin; nothing read from the request. */
function document(rc: RouteContext, data: unknown): Response {
  if (rc.request.method !== "GET" && rc.request.method !== "HEAD") return jsonAs({ error: "Method not allowed" }, 405, CORS, "no-store", { Allow: "GET, HEAD" });
  const res = jsonAs(data, 200, CORS, "public, max-age=3600");
  return rc.request.method === "HEAD" ? new Response(null, { status: 200, headers: res.headers }) : res;
}

// GET (or HEAD) /.well-known/oauth-protected-resource: the domain's
// metadata, which names the issuer for Poppy agents and which the official
// MCP client falls back to for any address on this host (hence the rule
// that no MCP address but the sign-in address answers 401);
// .../api/mcp/signin: the sign-in address's own; every other path under it
// 404. /.well-known/oauth-authorization-server: the issuer's. Undefined for
// any other path (the unknown path's answer).
export function wellKnownRoute(rc: RouteContext): Response | undefined {
  const { path, env } = rc;
  const notFound = () => jsonAs({ error: "not found" }, 404, CORS, "no-store");
  if (path === "/.well-known/oauth-protected-resource") return document(rc, domainResourceDoc(signinOrigin(env)));
  if (path === "/.well-known/oauth-protected-resource/api/mcp/signin") return document(rc, signinResourceDoc(signinOrigin(env)));
  if (path.startsWith("/.well-known/oauth-protected-resource/")) return notFound();
  if (path === "/.well-known/oauth-authorization-server") return document(rc, authServerDoc(signinOrigin(env)));
  if (path.startsWith("/.well-known/oauth-authorization-server/")) return notFound();
  return undefined;
}

/* ---------- the authorization request (authorize, and decide, which checks it again) ---------- */

/** An authorization request that passed every check: its app, its redirect
 *  address (for loopback as sent), its state when sent, its PKCE challenge,
 *  the resources it may get tokens for (canonical, a set), its DPoP key's
 *  thumbprint when sent. */
export type AuthzRequest = { app: KnownApp, redirect: string, state: string | null, challenge: string, resources: string[], jkt: string | null };
/** What the checks came to: the request, a fixed page (unknown: an app that
 *  is not known; wrong: a redirect address, or client_id or redirect_uri
 *  sent twice), or an error to redirect with. */
type Authz = { ok: true, req: AuthzRequest } | { ok: false, page: "unknown" | "wrong" } | { ok: false, redirect: string };

const CHALLENGE_RE = /^[A-Za-z0-9_-]{43,128}$/;

/** A redirect to the app's address, as pinned (for loopback as sent),
 *  keeping any query it has: the parameters appended by URLSearchParams, iss
 *  last. */
function redirectTo(address: string, params: Array<[string, string]>, iss: string): string {
  const u = new URL(address);
  for (const [k, v] of params) u.searchParams.append(k, v);
  u.searchParams.append("iss", iss);
  return u.toString();
}

/** The request's checks, in order, on one parse of its query string
 *  (URLSearchParams): client_id or redirect_uri twice (wrong); then, with
 *  every parameter sent without a value treated as omitted (RFC 6749 3.1),
 *  client_id a known app (unknown), redirect_uri one of its own (wrong);
 *  then, by redirect, any other parameter but resource sent twice
 *  (invalid_request), response_type, the PKCE challenge, scope by the app's
 *  kind, each resource, dpop_jkt. Every later step reads this parse. */
async function checkAuthorize(env: Env, query: string, origin: string): Promise<Authz> {
  const raw = new URLSearchParams(query);
  const twice = (k: string) => raw.getAll(k).length > 1;
  if (twice("client_id") || twice("redirect_uri")) return { ok: false, page: "wrong" };
  const q = new URLSearchParams([...raw].filter(([, v]) => v !== ""));
  const app = await knownApp(env, q.get("client_id") || "");
  if (!app) return { ok: false, page: "unknown" };
  const redirect = q.get("redirect_uri") || "";
  if (!redirectAllowed(app, redirect)) return { ok: false, page: "wrong" };
  const state = q.get("state");
  const fail = (error: string): Authz => ({ ok: false, redirect: redirectTo(redirect, state === null ? [["error", error]] : [["error", error], ["state", state]], origin) });
  const keys = new Set<string>(raw.keys());
  for (const k of keys) if (k !== "resource" && twice(k)) return fail("invalid_request");
  if (q.get("response_type") !== "code") return fail("unsupported_response_type");
  const challenge = q.get("code_challenge") || "";
  if (q.get("code_challenge_method") !== "S256" || !CHALLENGE_RE.test(challenge)) return fail("invalid_request");
  // a poppy app names the scope, and only it; a public app's is rooms whatever it sends
  if (app.kind === "poppy" && q.get("scope") !== SIGNIN_SCOPE) return fail("invalid_scope");
  const resources: string[] = [];
  for (const v of q.getAll("resource")) {
    const c = canonicalResource(v, origin);
    if (!c) return fail("invalid_target");
    if (!resources.includes(c)) resources.push(c);
  }
  const jkt = q.get("dpop_jkt");
  if (jkt !== null && !JKT_RE.test(jkt)) return fail("invalid_request");
  return { ok: true, req: { app, redirect, state, challenge, resources: resources.length ? resources : [origin + "/api/mcp/signin", origin], jkt } };
}

/** The two fixed pages: plain HTML that echoes nothing from the request and
 *  loads nothing. They follow the reader's light or dark setting
 *  (color-scheme light dark, in the browser's own Canvas and CanvasText),
 *  so a phone in dark mode does not show them black on white; with no
 *  script and no outside file, as the rest of the page. */
function fixedPage(which: "unknown" | "wrong"): Response {
  const title = which === "unknown" ? "Agent Chat: app not known" : "Agent Chat: sign-in stopped";
  const text = which === "unknown"
    ? "This app isn't known to Agent Chat yet, so it can't connect here. Nothing was shared. If you run this site, SIGNING IN at chat.victorio.cloud/api says how an app is added."
    : "This sign-in link doesn't match the app it names, so it was stopped. Nothing was shared. Start again from the app.";
  const body = "<!doctype html>\n<html lang=\"en\" style=\"color-scheme:light dark\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"><meta name=\"color-scheme\" content=\"light dark\"><title>" + title +
    "</title></head><body style=\"background:Canvas;color:CanvasText;font:16px/1.5 system-ui,sans-serif;max-width:36em;margin:3em auto;padding:0 1em\"><p>" + text + "</p></body></html>\n";
  return new Response(body, { status: 400, headers: { "Content-Type": "text/html; charset=utf-8", ...AUTHORIZE_HEADERS } });
}

// GET (or HEAD) /oauth/authorize: the checks of checkAuthorize, in order
// (the request's URL is in the invocation log, as every URL is; it holds no
// secret), then the app shell, which shows the approval page and reads its
// parameters from the URL. Nothing is stored. An unknown app gets its fixed
// page and the counts-only line oauth.authorize_unknown; a known app's
// document is compared with what was pinned, at most once a day per isolate,
// in the background (never under TEST_HOOKS), and nothing follows from it but
// a logged line.
export async function authorizeRoute(rc: RouteContext): Promise<Response> {
  const { request, env, url } = rc;
  if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405, headers: { "Content-Type": "text/plain; charset=utf-8", Allow: "GET, HEAD", ...AUTHORIZE_HEADERS } });
  const query = url.search.slice(1);
  const a = await checkAuthorize(env, query, signinOrigin(env));
  const head = (r: Response) => (request.method === "HEAD" ? new Response(null, { status: r.status, headers: r.headers }) : r);
  if (!a.ok && "page" in a) {
    if (a.page === "unknown") {
      const q = new URLSearchParams(query);
      const redirect = q.get("redirect_uri") || "";
      warn("oauth.authorize_unknown", null, {
        https: (q.get("client_id") || "").startsWith("https://"), has_scope: q.has("scope"), has_resource: q.has("resource"),
        has_prompt: q.has("prompt"), has_dpop_jkt: q.has("dpop_jkt"), redirect_https: redirect.startsWith("https://"),
      });
    }
    return head(fixedPage(a.page));
  }
  if (!a.ok) return head(new Response(null, { status: 302, headers: { Location: a.redirect, ...AUTHORIZE_HEADERS } }));
  // a test server (TEST_HOOKS) never asks an outside host, so it compares nothing
  if (!env.TEST_HOOKS) rc.ctx.waitUntil(compareDocument(a.req.app).catch(() => undefined));
  // the shell's own links name the address it was asked at, as every page's do
  const shell = await page(env, url.origin);
  const headers = new Headers(shell.headers);
  for (const [k, v] of Object.entries(AUTHORIZE_HEADERS)) headers.set(k, v);
  return head(new Response(shell.body, { status: 200, headers }));
}

/* ---------- the same-origin calls: decide and disconnect ---------- */

/** No CORS on these answers, and no cache. */
function plain(data: unknown, status = 200, headers?: Record<string, string>): Response {
  return jsonAs(data, status, null, "no-store", headers);
}
/** A refusal as these routes answer it (refusedJson's shape, without CORS). */
function refusedPlain(r: Refused, extra?: Record<string, unknown>): Response {
  const body: Record<string, unknown> = { error: r.error };
  if (r.code !== undefined) body.code = r.code;
  if (r.room !== undefined) body.room = r.room;
  if (extra) Object.assign(body, extra);
  return plain(body, r.status, r.retry_after !== undefined ? { "Retry-After": String(Math.max(1, Math.ceil(r.retry_after))) } : undefined);
}
/** Sec-Fetch-Site same-origin, or, without that header, Origin the site's. */
function sameOrigin(request: Request, origin: string): boolean {
  const site = request.headers.get("Sec-Fetch-Site");
  if (site !== null) return site === "same-origin";
  return request.headers.get("Origin") === origin;
}
const CROSS_SITE = { error: "This request must come from Agent Chat's own sign-in page.", code: "cross_site" };
const NOT_VALID = { error: "This sign-in request is not valid.", code: "invalid_request" };
const REQUEST_USED = { error: "This sign-in link has already been used to connect.", code: "request_used" };
const CAP_FULL = "Too many connections were made just now, from this network, for one of these rooms or on the whole site. Try again later.";
const NOT_MADE = "The connection could not be made; nothing was kept. Try again.";

/** The request's fingerprint in its app's store: its client and its PKCE
 *  challenge, fresh per request (state may be absent). */
function requestHash(req: AuthzRequest): Promise<string> {
  return storedHash("r:", req.app.client_id + "|" + req.challenge);
}

// POST /api/oauth/decide {params, approve, name, rooms: [{room,
// inviter_token, name?, reuse?}], check?}: the approval page's call. In
// order: the method; same origin (no other site can make it, and none could
// supply the person's tokens, which live in this origin's storage); the
// body, at most SMALL_BODY_MAX; params, the authorize URL's raw query
// string, checked again exactly as GET /oauth/authorize checks it (a fixed
// page's failure is 400 invalid_request; a redirecting one answers its
// redirect); approve false, the deny redirect, nothing made or counted. Then
// the person's part, read by personBody as POST /api/agents/invite reads it:
// every inviter looked up, each seat planned (reads only). With check, the
// answer is the person routes' check answer (counters and the request only
// peeked at); a request approved before is 409 request_used. Without it,
// under waitUntil registered before anything is counted: the request
// reserved (one approval per request), the creation caps (a sign-in counts
// as a key), the sign-in made empty, then each seat made or reused and put
// on it at once, from its code slot. A failure keeps the invites it made,
// unopened, names them, drops the sign-in and gives back its places and the
// request. The answer: the redirect with the code, the disconnect-only code
// for the page to keep, and the rooms. No CORS on any answer. Joins nothing.
export async function decideRoute(rc: RouteContext): Promise<Response> {
  const { request, env } = rc;
  if (request.method !== "POST") return plain({ error: "Method not allowed" }, 405, { Allow: "POST" });
  if (!sameOrigin(request, signinOrigin(env))) return plain(CROSS_SITE, 403);
  const small = await settleBody(request, SMALL_BODY_MAX);
  if (!small) return plain({ error: "That request's body is too large." }, 413);
  let b: Body | null;
  try { b = await readBody(small); } catch (e) { if (e instanceof BadRequest) return plain({ error: e.message }, 400); throw e; }
  if (!b || typeof b.params !== "string") return plain(NOT_VALID, 400);
  const a = await checkAuthorize(env, b.params, signinOrigin(env));
  if (!a.ok) return "page" in a ? plain(NOT_VALID, 400) : plain({ redirect: a.redirect });
  const req = a.req;
  if (b.approve === false) return plain({ redirect: redirectTo(req.redirect, req.state === null ? [["error", "access_denied"]] : [["error", "access_denied"], ["state", req.state]], signinOrigin(env)) });
  if (b.approve !== true) return plain({ error: "\"approve\" must be true or false", code: "invalid_request" }, 400);
  const pb = personBody(b);
  if ("status" in pb) return refusedPlain(pb);
  const store = appStore(env, await appStoreName(req.app));
  const fp = await requestHash(req);
  const planned: Planned[] = pb.entries.map((e) => ({ e }));
  if (pb.check) {
    const seen = await store.clientNote({ peek: [fp] });
    if (seen && seen.seen[0]) { warn("oauth.request_reused", null, { app: req.app.key }); return plain(REQUEST_USED, 409); }
    await lookInviters(env, planned, true);
    await planSeats(env, planned, true);
    if (!planned.some((p) => p.inviter)) return plain({ ok: false, rooms: planned.map(plannedView) });
    const caps = await creationCaps(request, planned.filter((p) => p.inviter).map((p) => p.e.room));
    const wait = await agentQuota(env).agentPeek(caps);
    const full = typeof wait === "number" && wait > 0;
    const out: { ok: boolean, rooms: unknown[], retry_after?: number } = { ok: !full && planned.every((p) => !p.problem), rooms: planned.map(plannedView) };
    if (full) out.retry_after = wait;
    return plain(out);
  }
  let stop = await lookInviters(env, planned, false);
  if (stop) return refusedPlain(stop);
  stop = await planSeats(env, planned, false);
  if (stop) return refusedPlain(stop);
  const caps = await creationCaps(request, planned.map((p) => p.e.room));
  return await outlive(rc, () => approveNow(env, signinOrigin(env), req, store, fp, caps, planned));
}

/** The approval itself, from the request's reservation on (decideRoute). */
async function approveNow(env: Env, origin: string, req: AuthzRequest, store: DurableObjectStub, fp: string, caps: Awaited<ReturnType<typeof creationCaps>>, planned: Planned[]): Promise<Response> {
  const note = await store.clientNote({ jtis: [{ h: fp, exp: Date.now() + OAUTH_REQUEST_KEEP_S * 1000 }] });
  if (!note) return plain({ error: NOT_MADE }, 500);
  if (!note.fresh[0]) { warn("oauth.request_reused", null, { app: req.app.key }); return plain(REQUEST_USED, 409); }
  const q = agentQuota(env);
  let got: string[] | null = null;
  const made: Made = { sure: [], maybe: [] };
  let drop: (() => Promise<unknown>) | null = null;
  let kept = false;
  const fail = (r: Refused) => refusedPlain(r, unusedFields(made));
  try {
    const g = await q.agentReserve(caps);
    if (!Array.isArray(g)) {
      if (typeof g === "number") return plain({ error: CAP_FULL, code: "rate_limited", retry_after: g }, 429, { "Retry-After": String(Math.max(1, Math.ceil(g))) });
      return plain({ error: NOT_MADE }, 500);
    }
    got = g;
    const s = await emptySignin(env, origin, req);
    if (!s) return plain({ error: NOT_MADE }, 500);
    drop = s.drop;
    const run = await seatsNow(env, s.u, planned, made, "could not be reached, so no connection was made. Try again.");
    if (!run.ok) {
      return fail("refused" in run ? run.refused : "busy" in run ? { status: 503, code: "try_again", error: "This connection is busy; try again.", retry_after: 1 } : { status: 500, error: made.sure.length || made.maybe.length ? "The connection could not be made. Try again." : NOT_MADE });
    }
    kept = true;
    const rooms: SeatMade[] = run.rooms;
    const out: { redirect: string, disconnect_code?: string, rooms: SeatMade[] } = { redirect: redirectTo(req.redirect, req.state === null ? [["code", s.code]] : [["code", s.code], ["state", req.state]], origin), rooms };
    if (s.disconnect) out.disconnect_code = s.disconnect;
    return plain(out);
  } catch (e) {
    warn("oauth.approve", e && (e as Error).name ? (e as Error).name : "failed");
    return fail({ status: 500, error: made.sure.length || made.maybe.length ? "The connection could not be made. Try again." : NOT_MADE });
  } finally {
    // a sign-in not made whole goes; its places and the request come back once
    if (!kept) {
      if (drop) { try { await drop(); } catch (e) { warn("agent.drop", e && (e as Error).name ? (e as Error).name : "failed"); } }
      if (got) { try { await q.agentRelease(got); } catch (e) { warn("agent.release", e && (e as Error).name ? (e as Error).name : "failed"); } }
      try { await store.clientNote({ release: [fp] }); } catch (e) { warn("oauth.release", e && (e as Error).name ? (e as Error).name : "failed"); }
    }
  }
}

/** A sign-in's slot as the routes hold it: the object, the identity's id,
 *  the slot's name and kind, its secret and verifier. */
type SlotHeld = { stub: DurableObjectStub, id: string, slot: string, kind: SigninKind, secret: Uint8Array<ArrayBuffer>, verifier: string };

/** A slot of a token, with its verifier derived. */
async function heldOf(env: Env, t: SigninToken): Promise<SlotHeld> {
  return { stub: identity(env, t.id), id: t.id, slot: t.slot, kind: t.kind, secret: t.secret, verifier: await slotVerifier(t.id, t.slot, t.kind, t.secret) };
}

/** The routes' credential for a sign-in, on one of its slots: open is
 *  signinOpen with that slot's kind and the access slot's write grace (a
 *  request that opened it live may still write), and with resource set it
 *  also refuses an idle sign-in and a token for another resource; unseal
 *  unwraps the data key and the wake key with the slot's wrap key and opens
 *  the room list; swap seals the room list and its wake list (wakesOf) at the
 *  next version and swaps both (signinSwap). Built only by the sign-in
 *  address, after a first open that took no grace, and by the approval on
 *  the code slot: the identity judges each slot alone, so this is what makes
 *  the grace serve only a request that opened its token live. */
export function signinCred(s: SlotHeld, opts?: { resource?: string }): Cred {
  const resource = opts && opts.resource;
  const cred: Cred = {
    async open() {
      const o = await s.stub.signinOpen(s.slot, s.verifier, [s.kind], { grace: true });
      if (!o.ok) return null;
      if (resource !== undefined && (o.idle || o.bind.resource !== resource)) return null;
      return { stub: s.stub, id: s.id, wrapped: o.wrapped, wk: o.wk, ver: o.ver, ring: o.ring, created: o.created, cred, via: "signin" };
    },
    async unseal(o) {
      const dk = await slotUnwrap(s.id, s.slot, s.kind, s.secret, o.wrapped);
      const wk = await slotUnwrap(s.id, s.slot, s.kind, s.secret, o.wk);
      if (!dk || !wk) { warn("agent.unseal", null); return null; }
      const rooms = await agentOpenRing(dk, s.id, o.ver, o.ring);
      return rooms ? { ...o, dk, rooms, wkBytes: wk } : null;
    },
    async swap(u, rooms) {
      if (!u.wkBytes) return { ok: false };
      const ring = await agentSealRing(u.dk, u.id, u.ver + 1, rooms);
      const wakes = await agentSealWakes(u.wkBytes, u.id, u.ver + 1, wakesOf(rooms));
      const r = await s.stub.signinSwap(s.slot, s.verifier, u.ver, ring, wakes);
      return r.ok ? { ok: true, ring } : r;
    },
  };
  return cred;
}

/** The sign-in address's first open of an access token, before the body is
 *  read: live (no grace), not idle, issued for that address. Opened with the
 *  credential later opens take (with the write grace), or null. */
export async function openSigninAccess(env: Env, t: SigninToken, address: string): Promise<Opened | null> {
  if (t.kind !== "access") return null;
  const s = await heldOf(env, t);
  const o = await s.stub.signinOpen(s.slot, s.verifier, ["access"]);
  if (!o.ok || o.idle || o.bind.resource !== address) return null;
  return { stub: s.stub, id: s.id, wrapped: o.wrapped, wk: o.wk, ver: o.ver, ring: o.ring, created: o.created, cred: signinCred(s, { resource: address }), via: "signin" };
}

/** A new sign-in with no rooms yet, made before the first seat (as
 *  emptyIdentity makes a key): its id, a data key, a wake key, the room list
 *  and the wake list sealed empty, the code slot bound to the request and the
 *  disconnect slot. One more try with a new id when the id names an object
 *  that exists. Its credential is the code slot's; drop deletes it again
 *  from that slot (signinDrop with no version: no access token exists before
 *  redemption, so nothing can have been recorded on it). */
export async function emptySignin(env: Env, origin: string, req: AuthzRequest, withDisconnect = OAUTH_DISCONNECT_CODE): Promise<{ code: string, disconnect: string | null, u: Unsealed, drop: () => Promise<unknown> } | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const id = newSigninId();
    const dk = newKeyBytes(), wk = newKeyBytes();
    const code = newSlotToken(id, "code");
    const codeVerifier = await slotVerifier(id, code.slot, "code", code.secret);
    const bind: Record<string, unknown> = { client: req.app.client_id, redirect: req.redirect, challenge: req.challenge, resources: req.resources, scope: SIGNIN_SCOPE };
    if (req.jkt) bind.jkt = req.jkt;
    bind.wk = await slotWrap(id, code.slot, "code", code.secret, wk);
    const codeRow = { slot: code.slot, verifier: codeVerifier, wrapped: await slotWrap(id, code.slot, "code", code.secret, dk), bind: JSON.stringify(bind) };
    let disc: { token: string, row: { slot: string, verifier: string, wrapped: string, bind: string } } | null = null;
    if (withDisconnect) {
      const d = newSlotToken(id, "disconnect");
      disc = { token: d.token, row: { slot: d.slot, verifier: await slotVerifier(id, d.slot, "disconnect", d.secret), wrapped: await slotWrap(id, d.slot, "disconnect", d.secret, wk), bind: JSON.stringify({ client: req.app.client_id }) } };
    }
    const ring = await agentSealRing(dk, id, 1, []);
    const wakes = await agentSealWakes(wk, id, 1, []);
    const stub = identity(env, id);
    const r = await stub.signinMake(req.app.client_id, ring, wakes, codeRow, disc ? disc.row : null);
    if (r.ok) {
      const held: SlotHeld = { stub, id, slot: code.slot, kind: "code", secret: code.secret, verifier: codeVerifier };
      return {
        code: code.token, disconnect: disc ? disc.token : null,
        u: { stub, id, wrapped: codeRow.wrapped, wk: bind.wk as string, ver: 1, ring, created: r.created, cred: signinCred(held), via: "signin", dk, rooms: [], wkBytes: wk },
        drop: () => stub.signinDrop(code.slot, codeVerifier),
      };
    }
    if (r.code !== "exists") return null;
  }
  return null;
}

/* ---------- how a sign-in is disconnected ---------- */

/** What a disconnect came to: no such sign-in; done (every wake settled,
 *  the sign-in deleted); a remainder (its rooms: their wakes did not
 *  settle, and the cut sign-in keeps them for the next presentation); busy
 *  (the list kept moving under this call; the rooms of its last read that
 *  record a wake); its wake list unreadable (the sign-in deleted). */
type Dropped = { kind: "unknown" } | { kind: "done" } | { kind: "remain", left: string[] } | { kind: "busy", left: string[] } | { kind: "unreadable" };

/** Every way a sign-in ends (a revoke of its refresh token, the
 *  disconnect-only code, a reused code or refresh token, an idle refresh):
 *  the key's two steps, from the presenting slot. signinCut (refused at once:
 *  no such sign-in); the wake key unwrapped with that slot's wrap key and
 *  the wake list opened (it does not open: the sign-in deleted, unreadable);
 *  its wakes let go of (dropWakes, observed by tag: a wake-list entry's token
 *  is its tag); every one settled: the sign-in deleted from the version read
 *  (signinDrop); otherwise the wake list written to hold only what did not
 *  settle (signinRemain, through keepsWakes and tagsKept). A write that
 *  meets a newer version cuts and reads again, AGENT_SWAP_TRIES times; then
 *  one more cut tells a record gone (complete) from one still moving (busy).
 *  The callers run it under waitUntil, registered before the cut. */
async function signinDisconnect(env: Env, t: SigninToken): Promise<Dropped> {
  const s = await heldOf(env, t);
  let read = false;
  let lastLeft: string[] = [];
  for (let i = 0; i < AGENT_SWAP_TRIES; i++) {
    const cut = await s.stub.signinCut(s.slot, s.verifier);
    if (!cut.ok) return read ? { kind: "done" } : { kind: "unknown" };
    read = true;
    const wk = await slotUnwrap(s.id, s.slot, s.kind, s.secret, cut.wkWrapped);
    const wakes = wk ? await agentUnsealWakes(wk, s.id, cut.ver, cut.wakes) : null;
    if (!wk || !wakes) {
      await s.stub.signinDrop(s.slot, s.verifier);
      return { kind: "unreadable" };
    }
    lastLeft = wakes.filter((e: AgentEntry) => e.hooks && e.hooks.length).map((e: AgentEntry) => e.room);
    const w = await dropWakes(env, wakes, cut.ver);
    if (!w.left.length) {
      keepsWakes(cut.ver, wakes, [], w.seen);
      const r = await s.stub.signinDrop(s.slot, s.verifier, cut.ver);
      if (r.ok) return { kind: "done" };
      continue; // the list moved, or another disconnect deleted it: cut again and read what is there
    }
    keepsWakes(cut.ver, wakes, w.remain, w.seen);
    tagsKept(wakes, w.remain);
    const kept = await s.stub.signinRemain(s.slot, s.verifier, cut.ver, await agentSealWakes(wk, s.id, cut.ver + 1, w.remain));
    if (kept.ok) {
      warn("agent.drop", null, { left: w.left.length });
      return { kind: "remain", left: w.left };
    }
  }
  // one more cut tells which: a record gone is a complete disconnect
  if (!(await s.stub.signinCut(s.slot, s.verifier)).ok) return { kind: "done" };
  warn("agent.drop", null, { remain: "not written" });
  return { kind: "busy", left: lastLeft };
}

// POST /api/oauth/disconnect {code}: the disconnect-only code the approval
// gave the page, read before anything else is asked (the credential is in
// the body). Same origin only, no CORS on its answers. It can do one thing:
// cut the sign-in and let go of its Muse wakes (signinDisconnect, under
// waitUntil, the answer waiting for it). It opens the wake list only, inside
// the Worker: never the room list, never an invite.
export async function disconnectRoute(rc: RouteContext): Promise<Response> {
  const { request, env } = rc;
  if (request.method !== "POST") return plain({ error: "Method not allowed" }, 405, { Allow: "POST" });
  if (!sameOrigin(request, signinOrigin(env))) return plain(CROSS_SITE, 403);
  const small = await settleBody(request, OAUTH_FORM_MAX);
  if (!small) return plain({ error: "That request's body is too large." }, 413);
  let b: Body | null = null;
  try { b = await readBody(small); } catch (e) { if (!(e instanceof BadRequest)) throw e; /* not JSON: not a disconnect code */ }
  const t = parseSigninToken(b ? b.code : undefined);
  if (!t || t.kind !== "disconnect") return plain({ error: "Not a disconnect code.", code: "invalid_request" }, 400);
  const d = await outlive(rc, () => signinDisconnect(env, t));
  if (d.kind === "unknown") return plain({ disconnected: false, code: "unknown" });
  if (d.kind === "done") return plain({ disconnected: true, wakes_left: [], note: signinDropNote([]) });
  if (d.kind === "remain") return plain({ disconnected: true, wakes_left: d.left, note: signinDropNote(d.left) });
  if (d.kind === "busy") return plain({ disconnected: true, wakes_left: d.left, note: signinDropNote(d.left, true) });
  return plain({ disconnected: true, wakes_left: null, note: signinDropNote(null) });
}

/* ---------- the token and revocation endpoints ---------- */

/** Their answers: CORS_OAUTH, no-store and Pragma: no-cache (RFC 6749 5.1). */
function oauthJson(data: unknown, status = 200, headers?: Record<string, string>): Response {
  return jsonAs(data, status, CORS_OAUTH, "no-store", { Pragma: "no-cache", ...(headers || {}) });
}
function oauthError(error: string, status = 400, description?: string, headers?: Record<string, string>): Response {
  return oauthJson(description ? { error, error_description: description } : { error }, status, headers);
}
/** 401 invalid_client, with WWW-Authenticate naming the scheme of the
 *  Authorization header the request sent (Basic when it is not a plain
 *  token), and none when it sent none (RFC 6749 5.2). The header is never
 *  read as a client credential: a Basic one only names a public client
 *  (clientOf). */
function invalidClient(request: Request): Response {
  const auth = request.headers.get("Authorization");
  if (auth === null) return oauthError("invalid_client", 401);
  const m = /^([!#$%&'*+.^_`|~0-9A-Za-z-]+)(?:\s|$)/.exec(auth.trim());
  return oauthError("invalid_client", 401, undefined, { "WWW-Authenticate": m ? m[1] : "Basic" });
}

/** A form body, at most OAUTH_FORM_MAX, each parameter once (RFC 6749
 *  3.2), a parameter sent without a value treated as omitted (3.1): too
 *  large, or a parameter repeated. */
async function readForm(request: Request): Promise<{ form: URLSearchParams } | { tooLarge: true } | { repeated: true }> {
  const small = await settleBody(request, OAUTH_FORM_MAX);
  if (!small) return { tooLarge: true };
  let text = "";
  try { text = await small.text(); } catch { text = ""; /* the body broke: an empty form, refused below for what it lacks */ }
  const form = new URLSearchParams(text);
  const keys = new Set<string>(form.keys());
  for (const k of keys) if (form.getAll(k).length > 1) return { repeated: true };
  return { form: new URLSearchParams([...form].filter(([, v]) => v !== "")) };
}

/** The failed signature checks of one app's client assertions from one
 *  network (OAUTH_QUOTA_ROOM, the agent quota's methods): the network's hash
 *  and the app's key, so a failure naming one app on one network can only
 *  hold back that app there. */
async function failCaps(request: Request, app: KnownApp) {
  return [{ k: "net:" + (await hashKey(networkKey(request.headers.get("CF-Connecting-IP")))) + ":" + app.key, max: OAUTH_AUTH_FAILS_PER_IP, per: OAUTH_AUTH_FAILS_WINDOW_S }];
}

/** What an Authorization: Basic header says (RFC 6749 2.3.1: the id and the
 *  password each form-encoded, joined by a colon, in base64): null for no
 *  header or another scheme, which these endpoints do not read; bad for one
 *  that does not decode. */
function basicOf(request: Request): { id: string, password: string } | "bad" | null {
  const auth = request.headers.get("Authorization");
  const m = auth === null ? null : /^Basic(?:\s+(.*))?$/i.exec(auth.trim());
  if (!m) return null;
  const b64 = (m[1] || "").trim();
  if (!b64 || b64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return "bad";
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
    const at = text.indexOf(":");
    if (at < 0) return "bad";
    const unform = (x: string) => decodeURIComponent(x.replace(/\+/g, " "));
    return { id: unform(text.slice(0, at)), password: unform(text.slice(at + 1)) };
  } catch { return "bad"; /* not base64, not UTF-8, or a broken escape: no id can be read from it */ }
}

/** The app a token or revocation request names: its client_id, or without
 *  one the client assertion's sub; or, for a public app, the id of an
 *  Authorization: Basic header with an empty password, since some client
 *  libraries put a public client's id only there. That header names the
 *  client and authenticates nothing, so it must agree with the form: a
 *  password, a header that does not decode, or an id other than the form's
 *  is refused, as a public app's client_secret is. For an app that signs its
 *  requests the header is not read. null: no known app is named. A lookup
 *  and nothing more, so a request naming none, or refused here, is answered
 *  before any proof or signature is checked. */
async function clientOf(env: Env, request: Request, form: URLSearchParams): Promise<KnownApp | "refused" | null> {
  const assertion = form.get("client_assertion");
  const id = form.get("client_id");
  const named = await knownApp(env, id || (assertion !== null ? assertionSubject(assertion) : null) || "");
  const basic = basicOf(request);
  if (basic === null || (named && named.kind !== "public")) return named;
  let app = named;
  if (!app && id === null && basic !== "bad") {
    const b = await knownApp(env, basic.id);
    app = b && b.kind === "public" ? b : null;
  }
  if (!app) return null;
  if (basic === "bad" || basic.password !== "" || (id !== null && basic.id !== id)) return "refused";
  return app;
}

/** The counts-only line of a token or revocation request that names no
 *  known app: how it tried to name one, never what it named. */
function unknownClient(request: Request, form: URLSearchParams): void {
  const auth = request.headers.get("Authorization");
  warn("oauth.token_unknown", null, { has_client_id: form.has("client_id"), has_basic: auth !== null && /^Basic(?:\s|$)/i.test(auth.trim()), has_assertion: form.has("client_assertion") });
}

/** How a refresh token presented by a watched app stood: the live one, a
 *  repeat within OAUTH_REFRESH_GRACE_S, one spent before that (a reuse,
 *  which ends the sign-in), or none such. */
type RefreshStanding = "fresh" | "grace" | "spent" | "unknown";

/** A watched app's counts-only line at the token endpoint (oauth.token_watch):
 *  what it sent, names and booleans only, and for a refresh how the token
 *  it presented stood, once the grant has read it. Said at most once. */
function watchLine(request: Request, form: URLSearchParams, app: KnownApp, grant: string | null): (refresh?: RefreshStanding) => void {
  let said = false;
  return (refresh) => {
    if (!app.watch || said) return;
    said = true;
    const assertion = form.get("client_assertion");
    const j = assertion !== null ? parseJws(assertion) : null;
    const head: Record<string, unknown> | null = assertion === null ? null : j ? j.header : {};
    warn("oauth.token_watch", null, {
      app: app.key, grant_type: grant === "authorization_code" || grant === "refresh_token" ? grant : "other",
      alg: head && (head.alg === "ES256" || head.alg === "PS384") ? String(head.alg) : head ? "other" : null,
      has_kid: !!(head && typeof head.kid === "string"), has_client_id: form.has("client_id"), has_resource: form.has("resource"), has_dpop: request.headers.has("DPoP"),
      ...(refresh ? { refresh } : {}),
    });
  };
}

/** The authentication of a token or revocation request's client, a known
 *  app (clientOf), by its kind: a public app sends neither client_assertion
 *  nor client_secret; a poppy app a signed client assertion (lib/oauth.ts
 *  checkAssertion), whose jti is recorded in the app's store with the DPoP
 *  proof's, in one call. Every failure is 401 invalid_client. The costly
 *  part, a key-set fetch or a signature check, is limited, and only what
 *  costs fills the limit: an assertion whose signature was checked and
 *  matched no key takes a place in this app's counter on this network
 *  (failCaps). The counter is read once, just before the first costly step
 *  of the assertion (a key-set fetch this request would start, or its first
 *  signature check), and full it refuses the app's assertion from that
 *  network (429 slow_down). A public app's failure, no assertion, a
 *  malformed one, claims that fail, and a kid no key matches when no fetch
 *  may start never ask the counter; a replayed jti after a matched
 *  signature, and a request that read the counter before a fetch, its own
 *  or one another request started at the same moment, that brought no key
 *  for its kid, read it (and are refused while it is full) and take no
 *  place. A key-set fetch is handed to waitUntil (the request's), so it
 *  outlives a requester that hangs up. dpopJti: the proof's jti to record
 *  (null: none). */
type Authed = { ok: true, app: KnownApp, alg: string | null, hasKid: boolean, dpopFresh: boolean } | { ok: false, response: Response };
async function authenticate(env: Env, request: Request, form: URLSearchParams, origin: string, app: KnownApp, dpopJti: string | null, waitUntil: (p: Promise<unknown>) => void): Promise<Authed> {
  const refuse = (): Authed => ({ ok: false, response: invalidClient(request) });
  const assertion = form.get("client_assertion");
  const nowS = Math.floor(Date.now() / 1000);
  const store = appStore(env, await appStoreName(app));
  if (app.kind === "public") {
    if (assertion !== null || form.has("client_secret")) return refuse();
    if (dpopJti === null) return { ok: true, app, alg: null, hasKid: false, dpopFresh: true };
    const n = await store.clientNote({ jtis: [{ h: await storedHash("d:", dpopJti), exp: Date.now() + (OAUTH_DPOP_WINDOW_S + OAUTH_SKEW_S) * 1000 }] });
    return { ok: true, app, alg: null, hasKid: false, dpopFresh: !!n && n.fresh[0] };
  }
  if (form.get("client_assertion_type") !== "urn:ietf:params:oauth:client-assertion-type:jwt-bearer" || assertion === null) return refuse();
  const caps = await failCaps(request, app);
  let wait = 0;
  const c = await checkAssertion(app, assertion, origin, nowS, {
    // this app's counter on this network, full, refuses before the work it limits
    mayVerify: async () => { const w = await quotas(env).agentPeek(caps); wait = typeof w === "number" ? w : 0; return wait <= 0; },
    waitUntil,
  });
  if (!c.ok) {
    if (c.stopped) return { ok: false, response: oauthError("slow_down", 429, "Too many failed attempts for this app from this network; try again later.", { "Retry-After": String(wait) }) };
    if (c.checked) { try { await quotas(env).agentReserve(caps); } catch (e) { warn("oauth.count", e && (e as Error).name ? (e as Error).name : "failed"); } }
    return refuse();
  }
  // the jti is kept for as long as the assertion would be accepted: until its exp and the skew
  const jtis = [{ h: await storedHash("a:", c.jti), exp: (c.exp + OAUTH_SKEW_S) * 1000 }];
  if (dpopJti !== null) jtis.push({ h: await storedHash("d:", dpopJti), exp: Date.now() + (OAUTH_DPOP_WINDOW_S + OAUTH_SKEW_S) * 1000 });
  const n = await store.clientNote({ jtis });
  if (!n || !n.fresh[0]) return refuse();
  return { ok: true, app, alg: c.alg, hasKid: c.hasKid, dpopFresh: dpopJti === null ? true : n.fresh[1] };
}

/** The tokens' answer (RFC 6749 5.1): Bearer, the scope always stated. */
function tokensAnswer(access: string, refresh: string, expiresIn: number): Response {
  return oauthJson({ access_token: access, token_type: "Bearer", expires_in: expiresIn, refresh_token: refresh, scope: SIGNIN_SCOPE });
}

/** A resource asked for at the token endpoint, against the resources the
 *  code or refresh token was bound to: none sent is the default token (the
 *  domain), which only a request that named the domain (or none) may get. */
function tokenResource(form: URLSearchParams, origin: string, bound: unknown): string | null {
  const list = Array.isArray(bound) ? bound.map(String) : [];
  const v = form.get("resource");
  const r = v === null ? origin : canonicalResource(v, origin);
  return r !== null && list.includes(r) ? r : null;
}

/** A new access slot and refresh slot for a sign-in, each wrapping the data
 *  key and the wake key: the rows the identity stores, and the tokens. */
async function preparePair(id: string, dk: Uint8Array<ArrayBuffer>, wk: Uint8Array<ArrayBuffer>, accessBind: Record<string, unknown>, refreshBind: Record<string, unknown>) {
  const a = newSlotToken(id, "access"), r = newSlotToken(id, "refresh");
  const access = { slot: a.slot, verifier: await slotVerifier(id, a.slot, "access", a.secret), wrapped: await slotWrap(id, a.slot, "access", a.secret, dk), bind: JSON.stringify({ ...accessBind, wk: await slotWrap(id, a.slot, "access", a.secret, wk) }) };
  const refresh = { slot: r.slot, verifier: await slotVerifier(id, r.slot, "refresh", r.secret), wrapped: await slotWrap(id, r.slot, "refresh", r.secret, dk), bind: JSON.stringify({ ...refreshBind, wk: await slotWrap(id, r.slot, "refresh", r.secret, wk) }) };
  return { rows: { access, refresh }, access: a.token, refresh: r.token };
}

// POST /api/oauth/token, a form of at most OAUTH_FORM_MAX: in order, the
// method; the form's size and a parameter sent twice (400 invalid_request);
// the client, from client_id or, without it, the assertion's sub, or a
// public app's id in a Basic header with an empty password, a known app (401
// invalid_client, before any proof is looked at: clientOf; a request naming
// none is logged oauth.token_unknown); a watched app's counts-only line
// (watchLine, a refresh's once its grant has read the token); a DPoP header
// checked when sent; the client's authentication by kind (401
// invalid_client; a signed assertion's claims are judged as presented, then
// its key and its signature, with this app's counter of failed signature
// checks on this network read just before the first costly step, a key-set
// fetch or a signature check, full: 429 slow_down: authenticate); the
// proof's verdict (400 invalid_dpop_proof; one required by an app whose
// document says dpop_bound_access_tokens); then the grant:
// authorization_code or refresh_token (400 invalid_request when none is
// named, unsupported_grant_type for another). The credential is in the
// body, so the sign-in is opened only once the body is in. Every answer
// carries CORS_OAUTH, no-store and Pragma: no-cache; errors are RFC 6749
// 5.2's, with nothing about the client. A reused code or refresh token, and
// a refresh after OAUTH_IDLE_DAYS, end the sign-in (signinDisconnect, under
// waitUntil).
export async function tokenRoute(rc: RouteContext): Promise<Response> {
  const { request, env } = rc;
  if (request.method !== "POST") return oauthError("invalid_request", 405, "Use POST.", { Allow: "POST" });
  const f = await readForm(request);
  if ("tooLarge" in f) return oauthError("invalid_request", 413);
  if ("repeated" in f) return oauthError("invalid_request", 400, "A parameter was sent more than once.");
  const form = f.form;
  const named = await clientOf(env, request, form);
  if (named === "refused") return invalidClient(request);
  if (!named) { unknownClient(request, form); return invalidClient(request); }
  const grant = form.get("grant_type");
  // a refresh's line waits for the grant to read the token it presents; any other is said now
  const watch = watchLine(request, form, named, grant);
  if (grant !== "refresh_token") watch();
  try {
    const nowS = Math.floor(Date.now() / 1000);
    const dpop = await checkDpop(request, signinOrigin(env) + "/api/oauth/token", nowS);
    const auth = await authenticate(env, request, form, signinOrigin(env), named, dpop.kind === "ok" ? dpop.jti : null, (p) => rc.ctx.waitUntil(p));
    if (!auth.ok) return auth.response;
    const app = auth.app;
    if (dpop.kind === "bad" || (dpop.kind === "ok" && !auth.dpopFresh)) return oauthError("invalid_dpop_proof");
    if (dpop.kind === "none" && app.dpop_always) return oauthError("invalid_dpop_proof");
    const proof = dpop.kind === "ok" ? dpop.jkt : null;
    if (grant === "authorization_code") return await codeGrant(rc, app, form, proof);
    if (grant === "refresh_token") return await refreshGrant(rc, app, form, proof, watch);
    return oauthError(grant === null ? "invalid_request" : "unsupported_grant_type");
  } finally {
    // a refresh refused before its grant read the token: the line without how it stood
    watch();
  }
}

/** grant_type=authorization_code: the code's slot (live, or redeemed
 *  within its minute; one of a cut sign-in finishes its disconnect), its
 *  app, its redirect, PKCE (a redeemed code that passes these three is a
 *  reuse, which ends the sign-in), the resource, the DPoP key it was bound
 *  to; then the identity, in one step, marks it used and stores the new
 *  pair (a family bound to the proof's key when one was sent). */
async function codeGrant(rc: RouteContext, app: KnownApp, form: URLSearchParams, proof: string | null): Promise<Response> {
  const { env } = rc;
  const t = parseSigninToken(form.get("code") || "");
  if (!t || t.kind !== "code") return oauthError("invalid_grant");
  const s = await heldOf(env, t);
  const o = await s.stub.signinOpen(s.slot, s.verifier, ["code"], { spent: true });
  if (!o.ok) {
    if (o.cut && o.client === app.client_id) await outlive(rc, () => signinDisconnect(env, t));
    return oauthError("invalid_grant");
  }
  if (o.bind.client !== app.client_id) return oauthError("invalid_grant");
  if (form.get("redirect_uri") !== o.bind.redirect) return oauthError("invalid_grant");
  const verifier = form.get("code_verifier") || "";
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || b64urlEncode(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))) !== o.bind.challenge) return oauthError("invalid_grant");
  // a code redeemed already, within its minute, presented by its own client with its redirect and verifier: the
  // code was used twice, so the sign-in ends (RFC 6749 4.1.2); a bare copy of the code ends nothing
  if (o.spent) {
    await outlive(rc, () => signinDisconnect(env, t));
    warn("oauth.reuse", null, { kind: "code" });
    return oauthError("invalid_grant");
  }
  const resource = tokenResource(form, signinOrigin(env), o.bind.resources);
  if (!resource) return oauthError("invalid_target");
  if (typeof o.bind.jkt === "string" && proof !== o.bind.jkt) return oauthError("invalid_grant");
  const dk = await slotUnwrap(s.id, s.slot, "code", s.secret, o.wrapped);
  const wk = await slotUnwrap(s.id, s.slot, "code", s.secret, o.wk);
  if (!dk || !wk) return oauthError("invalid_grant");
  const family = b64urlEncode(crypto.getRandomValues(new Uint8Array(12)));
  const pair = await preparePair(s.id, dk, wk, { client: app.client_id, resource, scope: SIGNIN_SCOPE, family }, proof ? { client: app.client_id, resources: o.bind.resources, scope: SIGNIN_SCOPE, family, jkt: proof } : { client: app.client_id, resources: o.bind.resources, scope: SIGNIN_SCOPE, family });
  const r = await s.stub.signinRedeem(s.slot, s.verifier, pair.rows);
  if (!r.ok) {
    if (r.reuse) {
      await outlive(rc, () => signinDisconnect(env, t));
      warn("oauth.reuse", null, { kind: "code" });
    }
    return oauthError("invalid_grant");
  }
  return tokensAnswer(pair.access, pair.refresh, OAUTH_ACCESS_TTL_S);
}

/** grant_type=refresh_token: the refresh slot (spent ones too, for the
 *  grace and to recognise a reuse; one of a cut sign-in finishes its
 *  disconnect), its app, idle (ends the sign-in), the DPoP binding (a bound
 *  family needs a proof of its key; an unbound public family is bound by the
 *  first refresh that carries one, a poppy family never), the scope and the
 *  resource; then the identity, in one step: a fresh rotation, the same pair
 *  within the grace (to a proof of the key the new refresh token carries),
 *  or a reuse, which ends the sign-in. */
async function refreshGrant(rc: RouteContext, app: KnownApp, form: URLSearchParams, proof: string | null, watch: (refresh: RefreshStanding) => void): Promise<Response> {
  const { env } = rc;
  const t = parseSigninToken(form.get("refresh_token") || "");
  if (!t || t.kind !== "refresh") { watch("unknown"); return oauthError("invalid_grant"); }
  const s = await heldOf(env, t);
  const o = await s.stub.signinOpen(s.slot, s.verifier, ["refresh"], { spent: true });
  if (!o.ok) {
    watch("unknown");
    if (o.cut && o.client === app.client_id) await outlive(rc, () => signinDisconnect(env, t));
    return oauthError("invalid_grant");
  }
  if (o.bind.client !== app.client_id) { watch("unknown"); return oauthError("invalid_grant"); }
  // a spent token's standing, the grace's pair or a reuse, read now (a read only: a spent slot is not written),
  // so a watched app's line says it whichever check below refuses the request
  const spentRead = o.spent ? await s.stub.signinRefresh(s.slot, s.verifier, null, null, null) : null;
  watch(spentRead === null ? "fresh" : spentRead.ok ? "grace" : spentRead.reuse ? "spent" : "unknown");
  if (o.idle) {
    await outlive(rc, () => signinDisconnect(env, t));
    warn("oauth.idle_end", null, {});
    return oauthError("invalid_grant");
  }
  const bound = typeof o.bind.jkt === "string" ? o.bind.jkt : null;
  if (bound !== null && proof !== bound) return oauthError("invalid_grant");
  const scope = form.get("scope");
  if (scope !== null && scope !== SIGNIN_SCOPE) return oauthError("invalid_scope");
  const resource = tokenResource(form, signinOrigin(env), o.bind.resources);
  if (!resource) return oauthError("invalid_target");
  let r: Awaited<ReturnType<DurableObjectStub["signinRefresh"]>>;
  let fresh: { access: string, refresh: string } | null = null;
  if (spentRead !== null) r = spentRead;
  else {
    const dk = await slotUnwrap(s.id, s.slot, "refresh", s.secret, o.wrapped);
    const wk = await slotUnwrap(s.id, s.slot, "refresh", s.secret, o.wk);
    if (!dk || !wk) return oauthError("invalid_grant");
    const jkt = bound !== null ? bound : proof !== null && app.kind === "public" ? proof : null;
    const family = typeof o.bind.family === "string" ? o.bind.family : b64urlEncode(crypto.getRandomValues(new Uint8Array(12)));
    const refreshBind: Record<string, unknown> = { client: app.client_id, resources: o.bind.resources, scope: SIGNIN_SCOPE, family };
    if (jkt !== null) refreshBind.jkt = jkt;
    const pair = await preparePair(s.id, dk, wk, { client: app.client_id, resource, scope: SIGNIN_SCOPE, family }, refreshBind);
    const next = await sealNext(s.id, s.slot, s.secret, { access_token: pair.access, refresh_token: pair.refresh, issued: Date.now() });
    r = await s.stub.signinRefresh(s.slot, s.verifier, pair.rows, next, jkt);
    fresh = { access: pair.access, refresh: pair.refresh };
  }
  if (r.ok && r.fresh && fresh) return tokensAnswer(fresh.access, fresh.refresh, OAUTH_ACCESS_TTL_S);
  if (r.ok && !r.fresh) {
    // within the grace: the same pair, to a proof of the key the new refresh token carries; anything else ends nothing
    if (r.next_jkt !== null && proof !== r.next_jkt) return oauthError("invalid_grant");
    const p = await openNext(s.id, s.slot, s.secret, r.next);
    if (!p) return oauthError("invalid_grant");
    return tokensAnswer(p.access_token, p.refresh_token, Math.max(0, OAUTH_ACCESS_TTL_S - Math.floor((Date.now() - p.issued) / 1000)));
  }
  if (!r.ok && r.reuse) {
    await outlive(rc, () => signinDisconnect(env, t));
    warn("oauth.reuse", null, { kind: "refresh" });
  }
  return oauthError("invalid_grant");
}

// POST /api/oauth/revoke {token, token_type_hint?} (RFC 7009), a form of at
// most OAUTH_FORM_MAX: the method, the form, the client (a known app named
// as at the token endpoint, clientOf, else 401 invalid_client, logged
// oauth.token_unknown) and its authentication by kind (401 invalid_client, or
// 429 slow_down as at the token endpoint), then by the token's form: a
// refresh token, live or spent, issued to this client ends its sign-in
// (signinDisconnect, under waitUntil); an access token issued to it ends
// itself (signinAccessDrop); a refresh or access token of a cut sign-in of
// this client finishes that disconnect. Anything
// else, unknown, gone or another app's, changes nothing, and is answered as a
// success all the same: a token issued to another client is a deliberate 200,
// since its caller holds the token already and a refusal would tell it
// nothing more. Always 200 {} once the client authenticated, a remainder of
// wakes the rooms did not confirm included.
export async function revokeRoute(rc: RouteContext): Promise<Response> {
  const { request, env } = rc;
  if (request.method !== "POST") return oauthError("invalid_request", 405, "Use POST.", { Allow: "POST" });
  const f = await readForm(request);
  if ("tooLarge" in f) return oauthError("invalid_request", 413);
  if ("repeated" in f) return oauthError("invalid_request", 400, "A parameter was sent more than once.");
  const form = f.form;
  const named = await clientOf(env, request, form);
  if (named === "refused") return invalidClient(request);
  if (!named) { unknownClient(request, form); return invalidClient(request); }
  const auth = await authenticate(env, request, form, signinOrigin(env), named, null, (p) => rc.ctx.waitUntil(p));
  if (!auth.ok) return auth.response;
  const t = parseSigninToken(form.get("token") || "");
  if (t && t.kind === "refresh") {
    const s = await heldOf(env, t);
    const o = await s.stub.signinOpen(s.slot, s.verifier, ["refresh"], { spent: true });
    if ((o.ok && o.bind.client === auth.app.client_id) || (!o.ok && o.cut && o.client === auth.app.client_id)) await outlive(rc, () => signinDisconnect(env, t));
  } else if (t && t.kind === "access") {
    const s = await heldOf(env, t);
    const o = await s.stub.signinOpen(s.slot, s.verifier, ["access"], { grace: true });
    if (o.ok && o.bind.client === auth.app.client_id) await s.stub.signinAccessDrop(s.slot, s.verifier);
    else if (!o.ok && o.cut && o.client === auth.app.client_id) await outlive(rc, () => signinDisconnect(env, t));
  }
  return oauthJson({});
}
