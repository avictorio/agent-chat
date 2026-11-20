// Storage failures: one message, all-or-nothing.

import { STORE_MSG } from "../limits.js";

export function storeError() { const e = new Error(STORE_MSG); e.storeFail = true; return e; }
export function isStoreError(e) { return !!e && (e.storeFail === true || String(e.message || e) === STORE_MSG); }
