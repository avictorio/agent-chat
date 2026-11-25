// Shared helpers: the bridge's numbers, JSON responses, logging, test seams.

import type { SocketFactory } from './muse/session.js';
import { MuseConnectionError, MuseTimeoutError } from './muse/errors.js';
import {
  MUSE_API_HOSTS,
  MUSE_CHAT_TIMEOUT_MS,
  MUSE_HANDSHAKE_TIMEOUT_MS,
  MUSE_LINK_CODE_TTL_S,
  MUSE_LINK_WAKES_MAX,
  MUSE_LINK_WAKES_WINDOW_S,
  MUSE_LOOKUP_TIMEOUT_MS,
  MUSE_NOISE_HOSTS,
  MUSE_TOKEN_GRACE_S,
  MUSE_TOKEN_REFUSALS_MAX,
  MUSE_TOKEN_RETRY_AFTER_S,
  MUSE_WAKE_BUDGET_MS,
  MUSE_WAKE_DEDUPE_S,
  MUSE_WAKE_LATE_RETRY_S,
  MUSE_WAKE_STEP_MIN_MS,
} from '../limits.js';

/** The bridge's numbers (worker/limits.ts), in the units its code counts in. */
export interface BridgeConfig {
  rateWakes: number;
  rateWindowMs: number;
  codeTtlMs: number;
  handshakeTimeoutMs: number;
  requestTimeoutMs: number;
  dedupeMs: number;
  tokenRefusals: number;
  tokenGraceMs: number;
  tokenRetryS: number;
  wakeBudgetMs: number;
  lookupTimeoutMs: number;
  stepMinMs: number;
  lateRetryS: number;
}

export interface Deps {
  fetch: typeof fetch;
  connect: SocketFactory | null;
  now: () => number;
  log: (line: string) => void;
  limits: Partial<BridgeConfig>;
}

/**
 * Seams the tests replace: the fetch the Muse API is called with, the
 * WebSocket factory (null: workersWebSocketFactory()), the clock, the log,
 * and numbers to shorten (a timeout, the rate cap) so a test need not wait
 * them out. Nothing in the Worker sets them. The host allow-lists are not
 * among them: no seam widens those.
 */
export const deps: Deps = {
  fetch: (...args) => globalThis.fetch(...args),
  connect: null,
  now: () => Date.now(),
  log: (line) => console.log(line),
  limits: {},
};

export function config(): BridgeConfig {
  return {
    rateWakes: MUSE_LINK_WAKES_MAX,
    rateWindowMs: MUSE_LINK_WAKES_WINDOW_S * 1000,
    codeTtlMs: MUSE_LINK_CODE_TTL_S * 1000,
    handshakeTimeoutMs: MUSE_HANDSHAKE_TIMEOUT_MS,
    requestTimeoutMs: MUSE_CHAT_TIMEOUT_MS,
    dedupeMs: MUSE_WAKE_DEDUPE_S * 1000,
    tokenRefusals: MUSE_TOKEN_REFUSALS_MAX,
    tokenGraceMs: MUSE_TOKEN_GRACE_S * 1000,
    tokenRetryS: MUSE_TOKEN_RETRY_AFTER_S,
    wakeBudgetMs: MUSE_WAKE_BUDGET_MS,
    lookupTimeoutMs: MUSE_LOOKUP_TIMEOUT_MS,
    stepMinMs: MUSE_WAKE_STEP_MIN_MS,
    lateRetryS: MUSE_WAKE_LATE_RETRY_S,
    ...deps.limits,
  };
}

/**
 * The header a wake's time comes in, in milliseconds: the room sets it on
 * its /deliver (worker/room/muse.ts museBridge), the router passes it on to
 * the link (index.ts deliverRoute), and the link counts it from when it
 * takes the wake (link.ts). A header, not a body field, so the link reads
 * it as the wake arrives, before the wake waits its turn.
 */
export const WAKE_BUDGET_HEADER = 'X-Wake-Budget-Ms';

/** A wake's time from that header: cfg.wakeBudgetMs without one, and never
 *  more; null when the header is not a whole number of milliseconds. */
export function wakeBudget(header: string | null, cfg: BridgeConfig): number | null {
  if (header === null) return cfg.wakeBudgetMs;
  if (!/^[0-9]{1,10}$/.test(header) || Number(header) < 1) return null;
  return Math.min(Number(header), cfg.wakeBudgetMs);
}

/** A wake that stopped for lack of time before its chat request went to
 *  Muse: nothing landed, so it can be tried again soon. */
export function outOfTime(cfg: BridgeConfig): Response {
  return refuse(503, 'out_of_time', 'the wake ran out of time before it reached Muse; retry later', { 'Retry-After': String(cfg.lateRetryS) });
}

/**
 * p, or a MuseTimeoutError once ms have passed; onLate runs then, to stop
 * what p waits on (a session's close() ends its pending steps). p runs on
 * either way.
 */
export function within<T>(p: Promise<T>, ms: number, onLate: () => void): Promise<T> {
  // a loser that fails after the race is over has no one left to tell
  p.catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      onLate();
      reject(new MuseTimeoutError('out of time'));
    }, Math.max(0, ms));
  });
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}

/** host matches an allowlist entry: exact, or "*.example.com" for its subdomains. */
export function hostAllowed(host: string, list: readonly string[]): boolean {
  const h = host.toLowerCase();
  return list.some((e) => (e.startsWith('*.') ? h.endsWith(e.slice(1)) && h.length > e.length - 1 : h === e));
}

/** The API root a link stored is on MUSE_API_HOSTS (https only). */
export function apiRootAllowed(root: string): boolean {
  let u: URL;
  try {
    u = new URL(root);
  } catch {
    return false;
  }
  return u.protocol === 'https:' && hostAllowed(u.hostname, MUSE_API_HOSTS);
}

/** The Noise host a link stored ("host" or "host:port") is on MUSE_NOISE_HOSTS. */
export function noiseHostAllowed(host: string): boolean {
  return hostAllowed(host.replace(/:[0-9]+$/, ''), MUSE_NOISE_HOSTS);
}

// A loopback http origin and nothing else: the API suite's fake Muse.
const TEST_MUSE_ORIGIN_RE = /^http:\/\/127\.0\.0\.1:[0-9]{1,5}$/;

/**
 * The fetch the bridge reaches Muse with: fetch_vms, and the VM's Noise
 * socket (workersWebSocketFactory upgrades through it). Both carry an
 * Authorization header, the member's access token or the VM bearer, so no
 * call follows a redirect: each goes with redirect "manual", and a 3xx
 * answer fails it as if Muse had not answered (muse_unreachable). Under
 * this Worker's compatibility date workerd sends Authorization on to a
 * redirect's target on another origin (it drops it only from 2025-09-01,
 * strip_authorization_on_cross_origin_redirect), so an answer from Muse's
 * host could have taken the token to a host off MUSE_API_HOSTS and
 * MUSE_NOISE_HOSTS, which only ever see the URL the bridge asked for.
 *
 * Under TEST_HOOKS a call to a host on MUSE_API_HOSTS or MUSE_NOISE_HOSTS
 * goes to TEST_MUSE_ORIGIN, the API suite's fake Muse on 127.0.0.1
 * (tests/api/server.js), and fails when that is not set: a test server
 * runs the real bridge and never reaches the real Muse. The origin must be
 * a loopback address, so even live the switch could send a token nowhere
 * but the Worker's own machine; check:config fails if either name is live.
 */
export function museFetch(env: BridgeEnv): typeof fetch {
  const send: typeof fetch = env.TEST_HOOKS ? toFakeMuse(env) : (input, init) => deps.fetch(input, init);
  return async (input, init) => {
    const r = await send(input, { ...init, redirect: 'manual' });
    if (r.status < 300 || r.status > 399) return r;
    try {
      await r.body?.cancel();
    } catch {
      // the call fails below either way; the body only held the connection
    }
    throw new MuseConnectionError(`Muse answered HTTP ${r.status}, a redirect, which is never followed`);
  };
}

/** TEST_HOOKS only: Muse's hosts swapped for the fake Muse (museFetch). */
function toFakeMuse(env: BridgeEnv): typeof fetch {
  const origin = env.TEST_MUSE_ORIGIN && TEST_MUSE_ORIGIN_RE.test(env.TEST_MUSE_ORIGIN) ? env.TEST_MUSE_ORIGIN : null;
  return (input, init) => {
    const u = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (!hostAllowed(u.hostname, MUSE_API_HOSTS) && !hostAllowed(u.hostname, MUSE_NOISE_HOSTS)) return deps.fetch(input, init);
    if (!origin) return Promise.reject(new TypeError('a test server reaches no real Muse, and TEST_MUSE_ORIGIN names no fake'));
    return deps.fetch(origin + u.pathname + u.search, init);
  };
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
  });
}

export function refuse(status: number, code: string, error: string, headers?: Record<string, string>): Response {
  return json({ code, error }, status, headers);
}

/** Link id prefix for logs: "ml_" and 8 of its 32 hex digits, never the whole id (a bearer secret). */
export function tag(linkId: unknown): string {
  return typeof linkId === 'string' ? linkId.slice(0, 11) : '';
}

/** One JSON log line. Callers pass ids, statuses, counts and timings only. */
export function log(evt: string, fields: Record<string, unknown> = {}): void {
  deps.log(JSON.stringify({ evt, ...fields }));
}

export const LINK_ID_RE = /^ml_[0-9a-f]{32}$/;

export function newLinkId(): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  return 'ml_' + [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

export async function sha256Hex(text: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return [...d].map((x) => x.toString(16).padStart(2, '0')).join('');
}

/** Reads a JSON object body of at most max bytes; null when it is not one. */
export async function readJson(
  request: Request,
  max: number,
): Promise<{ tooLarge: true; body?: undefined } | { tooLarge?: undefined; body: Record<string, unknown> | null }> {
  const len = Number(request.headers.get('Content-Length') || 0);
  if (len > max) return { tooLarge: true };
  const buf = new Uint8Array(await request.arrayBuffer());
  if (buf.length > max) return { tooLarge: true };
  try {
    const v: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(buf));
    // A request body: a JSON object (checked here); each route checks its fields.
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? { body: v as Record<string, unknown> } : { body: null };
  } catch {
    return { body: null };
  }
}

/**
 * Calls a Durable Object stub's internal route with a JSON body. T is the
 * body the route answers with; callers read it after checking the status.
 */
export async function callDo<T = unknown>(
  stub: { fetch: Fetcher['fetch'] },
  path: string,
  body?: unknown,
): Promise<{ status: number; data: T; headers: Headers }> {
  const r = await stub.fetch('https://do' + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  const text = await r.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  // The answer of one of this Worker's own Durable Objects.
  return { status: r.status, data: data as T, headers: r.headers };

}
