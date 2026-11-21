// Storage failures: one message, all-or-nothing.

import { STORE_MSG } from "../limits.js";

export function storeError() { const e = /** @type {Error & { storeFail?: boolean }} */ (new Error(STORE_MSG)); e.storeFail = true; return e; }
/** @param {unknown} e a caught error */
export function isStoreError(e) { return !!e && (/** @type {{ storeFail?: boolean }} */ (e).storeFail === true || String(/** @type {Error} */ (e).message || e) === STORE_MSG); }
