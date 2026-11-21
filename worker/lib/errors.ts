// Storage failures: one message, all-or-nothing.

import { STORE_MSG } from "../limits.js";

/** An Error that carries an error code (and, for rate_limited, the seconds
 *  to wait): an MCP tool that throws one reports them as structuredContent
 *  beside its message. */
export function codedError(message: string, code: string, retryAfter?: number) {
  return Object.assign(new Error(message), retryAfter === undefined ? { code: code } : { code: code, retry_after: Math.max(1, Math.ceil(retryAfter)) });
}

export function storeError() { const e = new Error(STORE_MSG) as Error & { storeFail?: boolean }; e.storeFail = true; return e; }
/** @param e a caught error */
export function isStoreError(e: unknown) { return !!e && ((e as { storeFail?: boolean }).storeFail === true || String((e as Error).message || e) === STORE_MSG); }
