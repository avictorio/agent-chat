// The directory: one Durable Object (idFromName("directory")) holding the
// two indexes the links need, and nothing secret.
//
//   vms   (vm_id PRIMARY KEY, link, created)
//         which link a Muse VM has, so the same Muse reconnecting gets its
//         link back.
//   codes (hash PRIMARY KEY, link, expires_at, used_at)
//         one-time link codes, stored as SHA-256 of the normalised code.
//         One live code per link: a new code replaces the link's others.
//
// Internal routes (POST, JSON), called by the Worker only:
//   /vm-link   {vmId}          -> {museLinkId, created}
//   /vm-find   {vmIds: [..]}   -> {museLinkId, vmId} | 404
//   /code-new  {museLinkId}    -> {code, expiresAt}
//   /code-claim {code}         -> {museLinkId} | 404 unknown | 410 used/expired
//   /forget    {museLinkId}    -> {removed}

import { config, deps, json, newLinkId, refuse, sha256Hex } from './util.js';

/** Crockford base32: no I, L, O, U. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const CODE_CHARS = 10; // 50 bits

export function newCode(): string {
  const b = crypto.getRandomValues(new Uint8Array(CODE_CHARS));
  let s = '';
  for (const x of b) s += ALPHABET[x & 31];
  return s.slice(0, 5) + '-' + s.slice(5);
}

/** A code as typed or relayed: case, spaces and dashes ignored, O/I/L read as 0/1/1. */
export function normaliseCode(code: unknown): string {
  return String(code).toUpperCase().replace(/[\s-]+/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
}

export class Directory {
  ctx: DurableObjectState;
  env: BridgeEnv;
  sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: BridgeEnv) {
    this.ctx = ctx;
    this.env = env;
    this.sql = ctx.storage.sql;
    this.sql.exec('CREATE TABLE IF NOT EXISTS vms (vm_id TEXT PRIMARY KEY, link TEXT NOT NULL, created INTEGER NOT NULL)');
    this.sql.exec('CREATE INDEX IF NOT EXISTS vms_link ON vms (link)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS codes (hash TEXT PRIMARY KEY, link TEXT NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER)');
    this.sql.exec('CREATE INDEX IF NOT EXISTS codes_link ON codes (link)');
  }

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    // Sent by this Worker (callDo): a JSON object; each field is coerced below.
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    switch (path) {
      case '/vm-link':
        return this.vmLink(String(body.vmId || ''));
      case '/vm-find':
        return this.vmFind(Array.isArray(body.vmIds) ? body.vmIds.map(String) : []);
      case '/code-new':
        return this.codeNew(String(body.museLinkId || ''));
      case '/code-claim':
        return this.codeClaim(String(body.code || ''));
      case '/forget':
        return this.forget(String(body.museLinkId || ''));
      default:
        return refuse(404, 'not_found', 'no such route');
    }
  }

  vmLink(vmId: string): Response {
    if (!vmId) return refuse(400, 'bad_request', 'vmId is required');
    const row = this.sql.exec<{ link: string }>('SELECT link FROM vms WHERE vm_id = ?', vmId).toArray()[0];
    if (row) return json({ museLinkId: row.link, created: false });
    const link = newLinkId();
    this.sql.exec('INSERT INTO vms (vm_id, link, created) VALUES (?, ?, ?)', vmId, link, deps.now());
    return json({ museLinkId: link, created: true });
  }

  vmFind(vmIds: string[]): Response {
    for (const vmId of vmIds) {
      const row = this.sql.exec<{ link: string }>('SELECT link FROM vms WHERE vm_id = ?', vmId).toArray()[0];
      if (row) return json({ museLinkId: row.link, vmId });
    }
    return refuse(404, 'no_link', 'no link for that Muse');
  }

  async codeNew(link: string): Promise<Response> {
    if (!link) return refuse(400, 'bad_request', 'museLinkId is required');
    const now = deps.now();
    const ttl = config(this.env).codeTtlMs;
    const code = newCode();
    const hash = await sha256Hex(normaliseCode(code));
    // Codes gone past their expiry for a day are no longer worth a "used" answer.
    this.sql.exec('DELETE FROM codes WHERE expires_at < ?', now - 86_400_000);
    this.sql.exec('DELETE FROM codes WHERE link = ?', link);
    this.sql.exec('INSERT INTO codes (hash, link, expires_at, used_at) VALUES (?, ?, ?, NULL)', hash, link, now + ttl);
    return json({ code, expiresAt: now + ttl });
  }

  async codeClaim(code: string): Promise<Response> {
    const norm = normaliseCode(code);
    if (norm.length !== CODE_CHARS) return refuse(404, 'code_unknown', 'unknown code');
    const hash = await sha256Hex(norm);
    const now = deps.now();
    const row = this.sql
      .exec<{ link: string; expires_at: number; used_at: number | null }>('SELECT link, expires_at, used_at FROM codes WHERE hash = ?', hash)
      .toArray()[0];
    if (!row) return refuse(404, 'code_unknown', 'unknown code');
    if (row.used_at !== null) return refuse(410, 'code_used', 'code already used');
    if (row.expires_at <= now) return refuse(410, 'code_expired', 'code expired');
    this.sql.exec('UPDATE codes SET used_at = ? WHERE hash = ?', now, hash);
    return json({ museLinkId: row.link });
  }

  forget(link: string): Response {
    if (!link) return refuse(400, 'bad_request', 'museLinkId is required');
    const had = this.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM vms WHERE link = ?', link).one().n > 0;

    this.sql.exec('DELETE FROM vms WHERE link = ?', link);
    this.sql.exec('DELETE FROM codes WHERE link = ?', link);
    return json({ removed: had });
  }
}
