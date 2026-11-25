// The Muse bridge's router, called in-process: bridgeFetch(request, env)
// answers a path and a JSON body as the muse-bridge Worker answered them
// over its service binding, so the chat side (worker/room/muse.ts
// museBridge, worker/routes/muse.ts) and this router's tests keep that
// contract one to one. Only that Muse code calls it, each call with a path
// of its own (no request names the path), and nothing else reaches
// MuseLink or Directory. Routes:
//
//   GET  /seal-key    -> {alg, info, publicKey}
//   POST /connect     {sealed, termsVersion}          -> {code, museLinkId, expiresAt}
//   POST /claim       {code}                          -> {museLinkId}
//   POST /update      {sealed, museLinkId?}           -> {museLinkId, updated}
//   POST /deliver     {museLinkId, room, member, routing, cursor, items, skipped?} -> {ok, cursor, delivered}
//   POST /disconnect  {museLinkId}                    -> {museLinkId, removed}
//   POST /rooms       {museLinkId, room, hooked}      -> {museLinkId, rooms}
//   POST /status      {museLinkId}                    -> {museLinkId, connected, rooms, termsVersion, tokenHeld}
//
// Refusals are {code, error}. Without MUSE_SEAL_KEY, /seal-key, /connect
// and /update answer 503 not_configured and the rest work. Logs carry link
// id prefixes, statuses, counts and timings: never a token, a code or
// message text.

import { fetchVmsWithStatus, apiRoot } from './muse/api.js';
import { errName } from './muse/errors.js';
import { vmIdOf, DEFAULT_NOISE_HOST } from './muse/session.js';
import { importBridgeKey, openJson, SealError, SEAL_ALG, SEAL_INFO, b64encode } from './seal.js';
import type { BridgeKey } from './seal.js';
import { ROOM_RE, validRouting } from './wake.js';
import { LINK_ID_RE, apiRootAllowed, callDo, deps, json, log, museFetch, noiseHostAllowed, readJson, refuse, tag } from './util.js';
import type { VmCredentials } from './link.js';

const SMALL_MAX = 32 * 1024;
const DELIVER_MAX = 2 * 1024 * 1024;
const ITEMS_MAX = 100;
const KINDS: ReadonlySet<unknown> = new Set(['message', 'reaction', 'game']);
const NODE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const TOKEN_RE = /^[\x21-\x7e]{1,8192}$/;
const TERMS_RE = /^[\x20-\x7e]{1,64}$/;
const HOST_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:[0-9]{1,5})?$/i;

/** A checked handover: what a link stores to reach its Muse. */
export interface Handover {
  accessToken: string;
  nodeId: string;
  apiRoot: string;
  noiseHost: string;
}

/** A route's refusal, or its result (error left out). */
type Refusable<T> = { error: Response } | (T & { error?: undefined });

let keyCache: { secret: string | null | undefined; key: BridgeKey | null } = { secret: null, key: null };
async function bridgeKey(env: BridgeEnv): Promise<BridgeKey> {
  if (keyCache.secret !== env.MUSE_SEAL_KEY) {
    keyCache = { secret: env.MUSE_SEAL_KEY, key: await importBridgeKey(env.MUSE_SEAL_KEY) };
  }
  // Set with the secret it came from: a secret is a string or undefined, never the initial null.
  return keyCache.key!;
}

function directory(env: BridgeEnv) {
  return env.MUSE_DIRECTORY.get(env.MUSE_DIRECTORY.idFromName('directory'));
}

function linkStub(env: BridgeEnv, id: string) {
  return env.MUSE_LINK.get(env.MUSE_LINK.idFromName(id));
}

/**
 * The opened handover, checked: {accessToken, nodeId, apiRoot, noiseHost},
 * or {error: Response}. apiUrlV2 and noiseHost must be https hosts on the
 * allowlists (MUSE_API_HOSTS, MUSE_NOISE_HOSTS in worker/limits.ts): the
 * token is only ever sent to Muse, and the VM id a link is keyed by only
 * ever comes from Muse.
 */
export function checkHandover(p: Record<string, unknown>): Refusable<Handover> {
  const bad = (code: string, error: string) => ({ error: refuse(400, code, error) });
  if (typeof p.accessToken !== 'string' || !TOKEN_RE.test(p.accessToken)) return bad('bad_handover', 'accessToken is missing or malformed');
  if (typeof p.nodeId !== 'string' || !NODE_ID_RE.test(p.nodeId)) return bad('bad_handover', 'nodeId is missing or malformed');
  let root = apiRoot('');
  if (p.apiUrlV2 !== undefined && p.apiUrlV2 !== null && p.apiUrlV2 !== '') {
    let u;
    try {
      u = new URL(String(p.apiUrlV2));
    } catch {
      return bad('bad_handover', 'apiUrlV2 is not a URL');
    }
    if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash) return bad('host_not_allowed', 'apiUrlV2 must be a plain https URL');
    root = apiRoot(u.origin + u.pathname);
    if (!apiRootAllowed(root)) return bad('host_not_allowed', 'apiUrlV2 is not a Muse host');
  }
  let noiseHost = DEFAULT_NOISE_HOST;
  if (p.noiseHost !== undefined && p.noiseHost !== null && p.noiseHost !== '') {
    const h = String(p.noiseHost);
    if (!HOST_RE.test(h)) return bad('bad_handover', 'noiseHost is not a host name');
    if (!noiseHostAllowed(h)) return bad('host_not_allowed', 'noiseHost is not a Muse host');
    noiseHost = h.toLowerCase();
  }
  return { accessToken: p.accessToken, nodeId: p.nodeId, apiRoot: root, noiseHost };
}

/** Opens and checks a sealed handover, then asks Muse for its VMs. */
async function handover(env: BridgeEnv, sealed: unknown): Promise<Refusable<{ h: Handover; vms: VmCredentials[] }>> {
  if (typeof sealed !== 'string' || !sealed) return { error: refuse(400, 'bad_request', '"sealed" is required') };
  let key;
  try {
    key = await bridgeKey(env);
  } catch {
    log('seal.key', { ok: false });
    return { error: refuse(503, 'not_configured', 'bridge key not set') };
  }
  let p;
  try {
    p = await openJson(sealed, key);
  } catch (err) {
    if (err instanceof SealError) return { error: refuse(400, 'seal_invalid', 'sealed blob does not open') };
    throw err;
  }
  const h = checkHandover(p);
  if (h.error) return h;
  const t0 = deps.now();
  const { vms, status } = await fetchVmsWithStatus(h.accessToken, { root: h.apiRoot, fetch: museFetch(env) });
  log('muse.fetch_vms', { status, vms: vms.length, ms: deps.now() - t0 });
  if (status === null || status >= 500) return { error: refuse(502, 'muse_unreachable', 'Muse did not answer') };
  if (status >= 400) return { error: refuse(403, 'token_refused', 'Muse refused that token') };
  if (!vms.length) return { error: refuse(422, 'no_vm', 'that Muse account has no VM') };
  // The default VM first: it is the one a new link takes.
  const ordered = [...vms.filter((v) => v.is_default), ...vms.filter((v) => !v.is_default)];
  return { h, vms: ordered.map((v) => ({ vmId: vmIdOf(v), vmAuthToken: v.vm_auth_token })).filter((v) => v.vmId) };
}

async function connectRoute(env: BridgeEnv, body: Record<string, unknown>): Promise<Response> {
  const termsVersion = body.termsVersion;
  if (typeof termsVersion !== 'string' || !TERMS_RE.test(termsVersion)) return refuse(400, 'bad_request', '"termsVersion" is required');
  const r = await handover(env, body.sealed);
  if (r.error) return r.error;
  if (!r.vms.length) return refuse(422, 'no_vm', 'that Muse account has no VM');
  const vm = r.vms[0];
  const dir = directory(env);
  const v = await callDo<{ museLinkId: string; created: boolean }>(dir, '/vm-link', { vmId: vm.vmId });
  if (v.status !== 200) return refuse(500, 'internal', 'directory failed');
  const museLinkId = v.data.museLinkId;
  const c = await callDo(linkStub(env, museLinkId), '/connect', { museLinkId, ...r.h, vm, termsVersion });
  if (c.status !== 200) return refuse(500, 'internal', 'link failed');
  const code = await callDo<{ code: string; expiresAt: number }>(dir, '/code-new', { museLinkId });
  if (code.status !== 200) return refuse(500, 'internal', 'directory failed');
  log('connect', { link: tag(museLinkId), created: v.data.created });
  return json({ code: code.data.code, museLinkId, expiresAt: code.data.expiresAt });
}

async function updateRoute(env: BridgeEnv, body: Record<string, unknown>): Promise<Response> {
  if (body.museLinkId !== undefined && !(typeof body.museLinkId === 'string' && LINK_ID_RE.test(body.museLinkId))) {
    return refuse(400, 'bad_request', '"museLinkId" is malformed');
  }
  const r = await handover(env, body.sealed);
  if (r.error) return r.error;
  const f = await callDo<{ museLinkId: string; vmId: string }>(directory(env), '/vm-find', { vmIds: r.vms.map((v) => v.vmId) });
  if (f.status === 404) return refuse(404, 'no_link', 'no link for that Muse: connect first');
  if (f.status !== 200) return refuse(500, 'internal', 'directory failed');
  const museLinkId = f.data.museLinkId;
  if (body.museLinkId && body.museLinkId !== museLinkId) return refuse(409, 'vm_mismatch', 'that token is for another Muse');
  const vm = r.vms.find((x) => x.vmId === f.data.vmId);
  const u = await callDo(linkStub(env, museLinkId), '/update', { museLinkId, ...r.h, vm });
  log('update', { link: tag(museLinkId), status: u.status });
  return json(u.data, u.status);
}

async function claimRoute(env: BridgeEnv, body: Record<string, unknown>): Promise<Response> {
  const code = body.code;
  if (typeof code !== 'string' || !code || code.length > 200) return refuse(400, 'bad_request', '"code" is required');
  const c = await callDo<{ museLinkId: string }>(directory(env), '/code-claim', { code });
  log('claim', { status: c.status, link: c.status === 200 ? tag(c.data.museLinkId) : undefined });
  return json(c.data, c.status);
}

async function disconnectRoute(env: BridgeEnv, body: Record<string, unknown>): Promise<Response> {
  const id = body.museLinkId;
  if (typeof id !== 'string' || !LINK_ID_RE.test(id)) return refuse(400, 'bad_request', '"museLinkId" is required');
  const l = await callDo<{ removed?: boolean } | null>(linkStub(env, id), '/disconnect', {});
  const d = await callDo<{ removed?: boolean } | null>(directory(env), '/forget', { museLinkId: id });
  return json({ museLinkId: id, removed: !!(l.data?.removed || d.data?.removed) });
}

async function roomsRoute(env: BridgeEnv, body: Record<string, unknown>): Promise<Response> {
  const id = body.museLinkId;
  if (typeof id !== 'string' || !LINK_ID_RE.test(id)) return refuse(400, 'bad_request', '"museLinkId" is required');
  if (typeof body.room !== 'string' || !ROOM_RE.test(body.room)) return refuse(400, 'bad_request', '"room" is malformed');
  if (typeof body.hooked !== 'boolean') return refuse(400, 'bad_request', '"hooked" must be true or false');
  const r = await callDo(linkStub(env, id), '/rooms', { museLinkId: id, room: body.room, hooked: body.hooked });
  return json(r.data, r.status);
}

async function statusRoute(env: BridgeEnv, body: Record<string, unknown>): Promise<Response> {
  const id = body.museLinkId;
  if (typeof id !== 'string' || !LINK_ID_RE.test(id)) return refuse(400, 'bad_request', '"museLinkId" is required');
  const r = await callDo(linkStub(env, id), '/status', { museLinkId: id });
  return json(r.data, r.status);
}

function isInt(v: unknown, min = 0): boolean {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= min;
}

/** Agent Chat's wake (worker/room/muse.ts museWake), checked. Returns an error string or null. */
export function deliverError(p: Record<string, unknown>): string | null {
  if (typeof p.museLinkId !== 'string' || !LINK_ID_RE.test(p.museLinkId)) return '"museLinkId" is malformed';
  if (typeof p.room !== 'string' || !ROOM_RE.test(p.room)) return '"room" is malformed';
  if (typeof p.member !== 'string' || !p.member || p.member.length > 200) return '"member" is malformed';
  if (!validRouting(p.routing)) return '"routing" must be main, agent-chat, per-room or a UUID';
  if (!isInt(p.cursor)) return '"cursor" must be an integer';
  if (!Array.isArray(p.items) || !p.items.length || p.items.length > ITEMS_MAX) return `"items" must hold 1-${ITEMS_MAX} items`;
  // Elements are JSON values: the first check below makes each an object.
  for (const i of p.items as (Record<string, unknown> | null)[]) {
    if (i === null || typeof i !== 'object' || Array.isArray(i)) return 'an item is not an object';
    if (!isInt(i.seq, 1)) return 'an item\'s "seq" must be a positive integer';
    if (!KINDS.has(i.kind)) return 'an item\'s "kind" must be message, reaction or game';
    if (typeof i.at !== 'number' || !Number.isFinite(i.at)) return 'an item\'s "at" must be a number';
    if (!('data' in i)) return 'an item has no "data"';
  }
  if (p.skipped !== undefined && !isInt(p.skipped)) return '"skipped" must be a non-negative integer';
  return null;
}

async function deliverRoute(env: BridgeEnv, body: Record<string, unknown>): Promise<Response> {
  const err = deliverError(body);
  if (err) return refuse(400, 'bad_request', err);
  // Maintenance switch: with the MUSE_DELIVER_PAUSED secret set to "1", every
  // wake is refused as busy and the room keeps it queued, retrying after
  // Retry-After. Deleting the secret resumes delivery (no code deploy).
  if (env.MUSE_DELIVER_PAUSED === '1') {
    log('deliver.paused', { link: tag(body.museLinkId) });
    return refuse(503, 'paused', 'Delivery is paused; retry later', { 'Retry-After': '30' });
  }
  // The link object answers as is: 200, 410 link_gone, 429 + Retry-After, 502.
  // deliverError() checked museLinkId: a string matching LINK_ID_RE.
  return linkStub(env, body.museLinkId as string).fetch('https://do/deliver', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function sealKeyRoute(env: BridgeEnv): Promise<Response> {
  try {
    const key = await bridgeKey(env);
    return json({ alg: SEAL_ALG, info: SEAL_INFO, publicKey: b64encode(key.publicKey) });
  } catch {
    return refuse(503, 'not_configured', 'bridge key not set');
  }
}

export async function bridgeFetch(request: Request, env: BridgeEnv): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === '/seal-key') {
    if (request.method !== 'GET' && request.method !== 'HEAD') return refuse(405, 'method', 'method not allowed');
    return sealKeyRoute(env);
  }
  const routes: Record<string, (b: Record<string, unknown>) => Promise<Response>> = {
    '/connect': (b) => connectRoute(env, b),
    '/claim': (b) => claimRoute(env, b),
    '/update': (b) => updateRoute(env, b),
    '/deliver': (b) => deliverRoute(env, b),
    '/disconnect': (b) => disconnectRoute(env, b),
    '/rooms': (b) => roomsRoute(env, b),
    '/status': (b) => statusRoute(env, b),
  };
  const route = routes[url.pathname];
  if (!route) return refuse(404, 'not_found', 'no such route');
  if (request.method !== 'POST') return refuse(405, 'method', 'method not allowed');
  const { body, tooLarge } = await readJson(request, url.pathname === '/deliver' ? DELIVER_MAX : SMALL_MAX);
  if (tooLarge) return refuse(413, 'too_large', 'body too large');
  if (!body) return refuse(400, 'bad_request', 'body must be a JSON object');
  try {
    return await route(body);
  } catch (err) {
    log('request', { path: url.pathname, status: 500, err: errName(err) });
    return refuse(500, 'internal', 'internal error');
  }
}
