// Storage failures: one message, all-or-nothing.

import { STORE_MSG } from "../limits.js";

export function storeError() { const e = new Error(STORE_MSG) as Error & { storeFail?: boolean }; e.storeFail = true; return e; }
/** @param e a caught error */
export function isStoreError(e: unknown) { return !!e && ((e as { storeFail?: boolean }).storeFail === true || String((e as Error).message || e) === STORE_MSG); }
