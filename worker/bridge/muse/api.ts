// Derived from facebookincubator/muse-gadget-sdk at commit e17081a
// (linux/src/musegadget/muse_api.py: api_root, fetch_vms_with_status).
// Copyright (c) Meta Platforms, Inc. and affiliates. Licensed under the Apache
// License, Version 2.0; see LICENSE-muse-gadget-sdk and NOTICE. Modified:
// ported from Python to JavaScript, then TypeScript; token refresh is not ported.

import { errName } from './errors.js';

export const API_BASE = 'https://api.muse.ai';
export const FETCH_PATH = '/fetch_vms';
export const FETCH_TIMEOUT_MS = 15_000;
export const DEFAULT_USER_AGENT = 'musegadget/0.1.0 (Cloudflare Workers) JavaScript';

/** Where the SDK port logs; messages carry no secrets. */
export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  debug(message: string): void;
}

/** One leased VM, as fetchVmsWithStatus() returns it. */
export interface MuseVm {
  vm_url: string;
  vm_auth_token: string;
  vm_name: string | undefined;
  vm_id: string | undefined;
  is_default: boolean;
}

export interface FetchVmsOptions {
  root?: string;
  fetch?: typeof fetch;
  userAgent?: string;
  timeoutMs?: number;
  logger?: Logger;
}

/** The /fetch_vms body as Muse documents it; its shape is checked as it is read. */
interface FetchVmsBody {
  error_title?: string;
  backend_error_code?: string | number;
  vm_list?: VmListEntry[];
}

interface VmListEntry {
  vm_ws_url?: string;
  vm_url?: string;
  vm_auth_token?: string;
  vm_name?: string;
  vm_id?: string;
  default?: boolean;
}

const silentLogger: Logger = { info() {}, warn() {}, error() {}, debug() {} };

/** The URL that API paths are appended to: apiUrlV2, or the Muse API. */
export function apiRoot(apiUrlV2 = ''): string {
  return (apiUrlV2 || API_BASE).replace(/\/+$/, '');
}

/**
 * Leased VMs for the device access token, plus the HTTP status if one arrived.
 *
 * Returns {vms, status}; status is null when no HTTP response was obtained
 * (transport failure, worth retrying). 401 means the device token was
 * rejected. Each VM: {vm_url, vm_auth_token, vm_name, vm_id, is_default},
 * where vm_url is the entry's vm_ws_url or, failing that, its vm_url. Entries
 * without a URL or token are skipped.
 *
 * accessToken is the device access token (never logged).
 */
export async function fetchVmsWithStatus(
  accessToken: string,
  options: FetchVmsOptions = {},
): Promise<{ vms: MuseVm[]; status: number | null }> {
  const {
    root = apiRoot(),
    fetch: fetchImpl = globalThis.fetch,
    userAgent = DEFAULT_USER_AGENT,
    timeoutMs = FETCH_TIMEOUT_MS,
    logger = silentLogger,
  } = options;

  let status: number;
  let data: unknown;
  try {
    const resp = await fetchImpl(root + FETCH_PATH, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'X-API-Version': '1.0.0',
        'User-Agent': userAgent,
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    status = resp.status;
    if (status >= 400) {
      // urllib raises HTTPError here; the body is not read.
      try {
        await resp.body?.cancel();
      } catch {
        // ignore
      }
      logger.error(`VM fetch failed: HTTP ${status}`);
      return { vms: [], status };
    }
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(await resp.arrayBuffer());
    data = JSON.parse(text);
  } catch (err) {
    // Network error, timeout, bad UTF-8 or bad JSON. Only the error type is logged.
    logger.error(`VM fetch failed: ${errName(err)}`);
    return { vms: [], status: null };
  }

  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    logger.error(`VM fetch: unexpected response type ${Array.isArray(data) ? 'list' : typeof data}`);
    return { vms: [], status };
  }
  const body = data as FetchVmsBody; // a JSON object (checked above), from Muse
  if (body.error_title || body.backend_error_code) {
    logger.error(`VM fetch error: ${body.error_title || ''} ${body.backend_error_code || ''}`);
    return { vms: [], status };
  }
  const vmList = body.vm_list;
  if (!Array.isArray(vmList)) {
    logger.error('VM fetch: missing vm_list');
    return { vms: [], status };
  }

  const vms: MuseVm[] = [];

  for (const entry of vmList) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const vmUrl = entry.vm_ws_url || entry.vm_url;
    const vmToken = entry.vm_auth_token;
    if (vmUrl && vmToken) {
      vms.push({
        vm_url: vmUrl,
        vm_auth_token: vmToken,
        vm_name: 'vm_name' in entry ? entry.vm_name : '',
        vm_id: 'vm_id' in entry ? entry.vm_id : '',
        is_default: Boolean('default' in entry ? entry.default : false),
      });
    }
  }
  logger.info(`VM fetch: ${vms.length} VMs`);
  return { vms, status };
}
