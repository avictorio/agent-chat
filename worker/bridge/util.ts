// Shared helpers: config from env, JSON responses, logging, test seams.

import { DEFAULT_NOISE_HOST } from './muse/session.js';
import type { SocketFactory } from './muse/session.js';

export interface Deps {
  fetch: typeof fetch;
  connect: SocketFactory | null;
  now: () => number;
  log: (line: string) => void;
}

/**
 * Seams the tests replace: the fetch the Muse API is called with, the
 * WebSocket factory (null: workersWebSocketFactory()), the clock.
 */
export const deps: Deps = {
  fetch: (...args) => globalThis.fetch(...args),
  connect: null,
  now: () => Date.now(),
  log: (line) => console.log(line),
};

/** The [vars] tunables config() reads; a missing or malformed one takes its default. */
export type Tunables = Partial<
  Record<
    | 'RATE_WAKES'
    | 'RATE_WINDOW_S'
    | 'CODE_TTL_S'
    | 'HANDSHAKE_TIMEOUT_MS'
    | 'REQUEST_TIMEOUT_MS'
    | 'DEDUPE_S'
    | 'TOKEN_REFUSALS'
    | 'TOKEN_GRACE_S'
    | 'TOKEN_RETRY_S'
    | 'MUSE_API_HOSTS'
    | 'MUSE_NOISE_HOSTS',
    string
  >
>;

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
  apiHosts: string[];
  noiseHosts: string[];
}

function int(v: string | undefined, def: number, min: number, max: number): number {
  const n = Number.parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) && n >= min && n <= max ? n : def;
}

function hostList(v: string | undefined, def: string[]): string[] {
  const list = String(v ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  return list.length ? list : def;
}

export function config(env: Tunables = {}): BridgeConfig {
  return {
    rateWakes: int(env.RATE_WAKES, 30, 1, 100_000),
    rateWindowMs: int(env.RATE_WINDOW_S, 600, 1, 86_400) * 1000,
    codeTtlMs: int(env.CODE_TTL_S, 1800, 60, 86_400) * 1000,
    handshakeTimeoutMs: int(env.HANDSHAKE_TIMEOUT_MS, 5000, 100, 60_000),
    requestTimeoutMs: int(env.REQUEST_TIMEOUT_MS, 8000, 100, 120_000),
    dedupeMs: int(env.DEDUPE_S, 600, 0, 86_400) * 1000,
    // A refused access token counts as gone only after this many refusals
    // spread over at least this long; until then the room waits and retries.
    tokenRefusals: int(env.TOKEN_REFUSALS, 5, 1, 1000),
    tokenGraceMs: int(env.TOKEN_GRACE_S, 21_600, 0, 30 * 86_400) * 1000,
    tokenRetryS: int(env.TOKEN_RETRY_S, 900, 1, 86_400),
    apiHosts: hostList(env.MUSE_API_HOSTS, ['api.muse.ai']),
    noiseHosts: hostList(env.MUSE_NOISE_HOSTS, [DEFAULT_NOISE_HOST]),
  };
}

/** host matches an allowlist entry: exact, or "*.example.com" for its subdomains. */
export function hostAllowed(host: string, list: readonly string[]): boolean {
  const h = host.toLowerCase();
  return list.some((e) => (e.startsWith('*.') ? h.endsWith(e.slice(1)) && h.length > e.length - 1 : h === e));
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

/** Link id prefix for logs. */
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

/** Equal-time comparison of two strings (through their hashes, so lengths do not leak). */
export async function sameSecret(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([sha256Hex(String(a)), sha256Hex(String(b))]);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
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
