// MuseLink: one Durable Object per Muse link (idFromName(museLinkId)),
// SQLite-backed. The only place a Muse access token is stored.
//
// Tables (each holds at most what one link needs):
//   link   (k=1) id, vm_id, node_id, api_root, noise_host, terms_version,
//          terms_at, created, updated
//   secret (k=1) access_token, vm_auth_token (cached from fetch_vms), updated,
//          refused_first / refused_n: Muse refusing the token. It is dropped
//          only once refusals reach MUSE_TOKEN_REFUSALS_MAX over at least
//          MUSE_TOKEN_GRACE_S (a glitch must not switch every room off);
//          until then a wake gets 503 with Retry-After. A success, /update
//          or /connect resets it.
//   wakes  at: send attempts, for the per-link rate cap
//   acked  room -> seq, at: the last item of the last acknowledged wake
//          per room, so a retry of a wake that did land (Agent Chat gave up
//          waiting) is not sent twice
//   rooms  room -> at: the rooms Agent Chat has hooked to this link (it
//          reports each hook set or removed), so the gadget can show a
//          count. Kept across /connect (connecting again adds rooms).
//
// Internal routes (POST, JSON), called by the bridge's router (index.ts) only:
//   /connect, /update, /deliver, /disconnect, /rooms, /status
// Every request runs one at a time (a chain), so a disconnect or update
// never interleaves with a send.

import { fetchVmsWithStatus } from './muse/api.js';
import { acknowledgement, sendChatOnce, vmIdOf, workersWebSocketFactory } from './muse/session.js';
import type { ChatResult } from './muse/session.js';
import { UpgradeRejected, errName } from './muse/errors.js';
import { apiRootAllowed, config, deps, json, log, museFetch, noiseHostAllowed, refuse, tag } from './util.js';
import type { BridgeConfig } from './util.js';
import { sessionIdFor, wakeText } from './wake.js';

const GONE = () => refuse(410, 'link_gone', 'link gone');

/** The link table's one row. */
type LinkRow = {
  k: number;
  id: string;
  vm_id: string;
  node_id: string;
  api_root: string;
  noise_host: string;
  terms_version: string;
  terms_at: number;
  created: number;
  updated: number;
};

/** What send() and fetchVm() read of the secret row. */
type SecretRow = {
  access_token: string;
  vm_auth_token: string | null;
};

/** The VM a handover resolved to (index.ts handover()). */
export interface VmCredentials {
  vmId: string | undefined;
  vmAuthToken: string;
}

/** /update body (index.ts updateRoute). */
export interface UpdateBody {
  museLinkId: string;
  accessToken: string;
  nodeId: string;
  apiRoot: string;
  noiseHost: string;
  vm: VmCredentials;
}

/** /connect body (index.ts connectRoute). */
export interface ConnectBody extends UpdateBody {
  termsVersion: string;
}

/** One wake item, as Agent Chat sends it (index.ts deliverError checks it). */
export interface WakeItem {
  seq: number;
  kind: string;
  at: number;
  data: unknown;
}

/** /deliver body: Agent Chat's wake, checked by index.ts deliverError. */
export interface DeliverBody {
  museLinkId: string;
  room: string;
  member: string;
  routing: string;
  cursor: number;
  items: WakeItem[];
  skipped?: number;
}

/** /rooms body (index.ts roomsRoute). */
export interface RoomsBody {
  museLinkId: string;
  room: string;
  hooked: boolean;
}

/** fetchVm() result. */
type FetchVmResult =
  | { gone: true; why: string; code?: undefined; vmAuthToken?: undefined }
  | { code: 'muse_unreachable' | 'vm_missing'; museStatus?: number | null; gone?: undefined; vmAuthToken?: undefined }
  | { vmAuthToken: string; gone?: undefined; code?: undefined };

/** send() result. */
type SendResult =
  | { ok: true; gone?: undefined }
  | { gone: true; why: string; ok?: undefined }
  | { ok: false; code: string; museStatus?: number | null; gone?: undefined };

export class MuseLink {
  ctx: DurableObjectState;
  env: BridgeEnv;
  sql: SqlStorage;
  chain: Promise<unknown>;

  constructor(ctx: DurableObjectState, env: BridgeEnv) {
    this.ctx = ctx;
    this.env = env;
    this.sql = ctx.storage.sql;
    this.chain = Promise.resolve();
    this.sql.exec(
      'CREATE TABLE IF NOT EXISTS link (k INTEGER PRIMARY KEY CHECK (k = 1), id TEXT NOT NULL, vm_id TEXT NOT NULL, node_id TEXT NOT NULL, ' +
        'api_root TEXT NOT NULL, noise_host TEXT NOT NULL, terms_version TEXT NOT NULL, terms_at INTEGER NOT NULL, created INTEGER NOT NULL, updated INTEGER NOT NULL)',
    );
    this.sql.exec('CREATE TABLE IF NOT EXISTS secret (k INTEGER PRIMARY KEY CHECK (k = 1), access_token TEXT NOT NULL, vm_auth_token TEXT, updated INTEGER NOT NULL, ' +
        'refused_first INTEGER, refused_n INTEGER NOT NULL DEFAULT 0)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS wakes (at INTEGER NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS acked (room TEXT PRIMARY KEY, seq INTEGER NOT NULL, at INTEGER NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS rooms (room TEXT PRIMARY KEY, at INTEGER)');
  }

  fetch(request: Request): Promise<Response> {
    const run = () => this.handle(request);
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => {}); // the caller gets p and its failure; the chain only keeps the order
    return p;
  }

  async handle(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    const body: unknown = await request.json().catch(() => ({}));
    // Each body is one the Worker (index.ts) built or checked for this route.
    try {
      switch (path) {
        case '/connect':
          return this.connect(body as ConnectBody);
        case '/update':
          return this.update(body as UpdateBody);
        case '/deliver':
          return await this.deliver(body as DeliverBody);
        case '/disconnect':
          return this.disconnect();
        case '/rooms':
          return this.rooms(body as RoomsBody);
        case '/status':
          return this.status(body as { museLinkId: string });
        default:
          return refuse(404, 'not_found', 'no such route');
      }
    } catch (err) {
      log('link.error', { route: path, err: errName(err) });
      return refuse(500, 'internal', 'internal error');
    }
  }

  row(): LinkRow | null {
    return this.sql.exec<LinkRow>('SELECT * FROM link WHERE k = 1').toArray()[0] ?? null;
  }

  secret(): SecretRow | null {
    return this.sql.exec<SecretRow>('SELECT access_token, vm_auth_token FROM secret WHERE k = 1').toArray()[0] ?? null;
  }

  storeSecret(accessToken: string, vmAuthToken: string | null | undefined): void {
    this.sql.exec(
      'INSERT OR REPLACE INTO secret (k, access_token, vm_auth_token, updated) VALUES (1, ?, ?, ?)',
      accessToken,
      vmAuthToken ?? null,
      deps.now(),
    );
  }

  /** {museLinkId, accessToken, nodeId, apiRoot, noiseHost, vm: {vmId, vmAuthToken}, termsVersion} */
  connect(b: ConnectBody): Response {
    const now = deps.now();
    const old = this.row();
    this.sql.exec(
      'INSERT OR REPLACE INTO link (k, id, vm_id, node_id, api_root, noise_host, terms_version, terms_at, created, updated) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      b.museLinkId,
      b.vm.vmId,
      b.nodeId,
      b.apiRoot,
      b.noiseHost,
      b.termsVersion,
      now,
      old ? old.created : now,
      now,
    );
    this.storeSecret(b.accessToken, b.vm.vmAuthToken);
    log('link.connect', { link: tag(b.museLinkId), again: !!old });
    return json({ museLinkId: b.museLinkId, reconnected: !!old });
  }

  /** {museLinkId, accessToken, nodeId, apiRoot, noiseHost, vm: {vmId, vmAuthToken}} */
  update(b: UpdateBody): Response {
    const link = this.row();
    if (!link || link.id !== b.museLinkId) return GONE();
    if (link.vm_id !== b.vm.vmId) return refuse(409, 'vm_mismatch', 'that token is for another Muse');
    this.sql.exec(
      'UPDATE link SET node_id = ?, api_root = ?, noise_host = ?, updated = ? WHERE k = 1',
      b.nodeId,
      b.apiRoot,
      b.noiseHost,
      deps.now(),
    );
    this.storeSecret(b.accessToken, b.vm.vmAuthToken);
    log('link.update', { link: tag(link.id) });
    return json({ museLinkId: link.id, updated: true });
  }

  disconnect(): Response {
    const link = this.row();
    for (const t of ['link', 'secret', 'wakes', 'acked', 'rooms']) this.sql.exec(`DELETE FROM ${t}`);
    log('link.disconnect', { link: tag(link?.id), had: !!link });
    return json({ removed: !!link, vmId: link ? link.vm_id : null });
  }

  roomCount(): number {
    return this.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM rooms').one().n;
  }

  /** {museLinkId, room, hooked}: a hook set (true) or removed (false). Idempotent. */
  rooms(b: RoomsBody): Response {
    const link = this.row();
    if (!link || link.id !== b.museLinkId) return GONE();
    if (b.hooked) this.sql.exec('INSERT OR REPLACE INTO rooms (room, at) VALUES (?, ?)', b.room, deps.now());
    else this.sql.exec('DELETE FROM rooms WHERE room = ?', b.room);
    const n = this.roomCount();
    log('link.rooms', { link: tag(link.id), hooked: !!b.hooked, rooms: n });
    return json({ museLinkId: link.id, rooms: n });
  }

  /** {museLinkId}: what the gadget shows. */
  status(b: { museLinkId: string }): Response {
    const link = this.row();
    if (!link || link.id !== b.museLinkId) return GONE();
    return json({ museLinkId: link.id, connected: true, rooms: this.roomCount(), termsVersion: link.terms_version, tokenHeld: !!this.secret() });
  }

  /** The Worker has checked the payload's shape (index.ts deliverError). */
  async deliver(p: DeliverBody): Promise<Response> {
    const t0 = deps.now();
    const cfg = config();
    const link = this.row();
    const sec = link && link.id === p.museLinkId ? this.secret() : null;
    const done = (resp: Response, fields: Record<string, unknown> = {}): Response => {
      log('deliver', { link: tag(p.museLinkId), status: resp.status, items: p.items.length, ms: deps.now() - t0, ...fields });
      return resp;
    };
    if (!sec) return done(GONE());

    // A retry of a wake that landed: drop what Muse already has.
    let items = p.items;
    const last = this.sql.exec<{ seq: number; at: number }>('SELECT seq, at FROM acked WHERE room = ?', p.room).toArray()[0];
    if (last && t0 - last.at < cfg.dedupeMs) items = items.filter((i) => i.seq > last.seq);
    if (!items.length) return done(json({ ok: true, duplicate: true, cursor: p.cursor }), { dup: true });

    // Rate cap: attempts in the sliding window.
    this.sql.exec('DELETE FROM wakes WHERE at <= ?', t0 - cfg.rateWindowMs);
    const { n, oldest } = this.sql.exec<{ n: number; oldest: number | null }>('SELECT COUNT(*) AS n, MIN(at) AS oldest FROM wakes').one();
    if (n >= cfg.rateWakes) {
      // n >= rateWakes >= 1 rows, so MIN(at) is not NULL.
      const retry = Math.max(1, Math.ceil((oldest! + cfg.rateWindowMs - t0) / 1000));
      return done(refuse(429, 'rate_limited', 'too many wakes for this link', { 'Retry-After': String(retry) }));
    }
    this.sql.exec('INSERT INTO wakes (at) VALUES (?)', t0);

    // sec is only non-null when link is (see above).
    const sessionId = await sessionIdFor(link!.id, p.routing, p.room);
    const text = wakeText({ room: p.room, items, skipped: p.skipped ?? 0 });

    const r = await this.send(link!, sec, text, sessionId, cfg);
    if (r.gone) {
      const now = deps.now();
      this.sql.exec('UPDATE secret SET refused_first = COALESCE(refused_first, ?), refused_n = refused_n + 1 WHERE k = 1', now);
      const { refused_first: first, refused_n: refusals } = this.sql
        .exec<{ refused_first: number; refused_n: number }>('SELECT refused_first, refused_n FROM secret WHERE k = 1')
        .one();
      if (refusals >= cfg.tokenRefusals && now - first >= cfg.tokenGraceMs) {
        this.sql.exec('DELETE FROM secret');
        return done(GONE(), { why: r.why, refusals });
      }
      return done(
        refuse(503, 'token_refused', 'Muse refused the token; retrying', { 'Retry-After': String(cfg.tokenRetryS) }),
        { why: r.why, refusals },
      );
    }
    if (!r.ok) return done(refuse(502, r.code, 'Muse did not take the wake'), { why: r.code, museStatus: r.museStatus });

    const now = deps.now();
    this.sql.exec('UPDATE secret SET refused_first = NULL, refused_n = 0 WHERE k = 1');
    const top = Math.max(...items.map((i) => i.seq));
    this.sql.exec('INSERT OR REPLACE INTO acked (room, seq, at) VALUES (?, ?, ?)', p.room, top, now);
    return done(json({ ok: true, cursor: p.cursor, delivered: items.length }), { sent: items.length });
  }

  /** Fresh VM credentials for this link's VM: {vmAuthToken} | {gone} | {code}. */
  async fetchVm(link: LinkRow, sec: SecretRow): Promise<FetchVmResult> {
    const { vms, status } = await fetchVmsWithStatus(sec.access_token, { root: link.api_root, fetch: museFetch(this.env) });
    if (status === 401 || status === 403) return { gone: true, why: 'token_refused' };
    if (status === null || status >= 400) return { code: 'muse_unreachable', museStatus: status };
    const vm = vms.find((v) => vmIdOf(v) === link.vm_id);
    if (!vm) return { code: 'vm_missing' };
    this.sql.exec('UPDATE secret SET vm_auth_token = ? WHERE k = 1', vm.vm_auth_token);
    return { vmAuthToken: vm.vm_auth_token };
  }

  /**
   * One session, one text, close on the ack. A cached VM bearer refused at
   * the upgrade (401/403) or by the request is re-fetched once.
   */
  async send(link: LinkRow, sec: SecretRow, text: string, sessionId: string | null, cfg: BridgeConfig): Promise<SendResult> {
    // The hosts were checked when a handover stored them, and are checked
    // again here, so that no stored row, whatever wrote it, sends the access
    // token or the VM bearer to a host off MUSE_API_HOSTS / MUSE_NOISE_HOSTS.
    // A gadget's next /update stores checked hosts again.
    if (!apiRootAllowed(link.api_root) || !noiseHostAllowed(link.noise_host)) return { ok: false, code: 'host_not_allowed' };
    let vmAuthToken = sec.vm_auth_token;
    let refetched = false;
    for (;;) {
      if (!vmAuthToken) {
        if (refetched) return { ok: false, code: 'vm_refused' };
        const f = await this.fetchVm(link, sec);
        refetched = true;
        if (f.gone) return f;
        if (f.code) return { ok: false, ...f };
        vmAuthToken = f.vmAuthToken;
      }
      let result: ChatResult;

      try {
        result = await sendChatOnce(
          {
            noiseHost: link.noise_host,
            vmId: link.vm_id,
            vmAuthToken,
            deviceId: link.node_id,
            connect: deps.connect ?? workersWebSocketFactory({ fetch: museFetch(this.env) }),
            handshakeTimeoutMs: cfg.handshakeTimeoutMs,
            requestTimeoutMs: cfg.requestTimeoutMs,
          },
          text,
          { sessionId },
        );
      } catch (err) {
        if (err instanceof UpgradeRejected) {
          vmAuthToken = null;
          this.sql.exec('UPDATE secret SET vm_auth_token = NULL WHERE k = 1');
          if (!refetched) continue;
          return { ok: false, code: 'vm_refused', museStatus: err.status };
        }
        return { ok: false, code: 'muse_unreachable' };
      }
      if (result.ok) {
        try {
          acknowledgement(result);
        } catch {
          return { ok: false, code: 'no_ack', museStatus: result.status };
        }
        return { ok: true };
      }
      if ((result.status === 401 || result.status === 403) && !refetched) {
        vmAuthToken = null;
        this.sql.exec('UPDATE secret SET vm_auth_token = NULL WHERE k = 1');
        continue;
      }
      return { ok: false, code: 'muse_rejected', museStatus: result.status };
    }
  }
}
