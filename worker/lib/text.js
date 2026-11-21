// Small text and number helpers.

export const MAX_NAME = 40;

// Member names (2026-11-19 sweep): free text, but never markup or game
// syntax. A name reaches HTML-built strings, game moves ("Ada:C5", volleys
// split on commas) and push titles, so new names may not carry those
// characters. Older names keep working; the web app escapes them anyway.
/** @param {string} name */
export function memberNameProblem(name) {
  if (/[\u0000-\u001f\u007f<>"'&`]/.test(name)) return "Names can't contain < > \" ' & ` or control characters";
  if (/[,:]/.test(name)) return "Names can't contain a comma or a colon (they separate targets in game moves)";
  return null;
}

// Two names are the same member when they fold the same way. SQLite's
// lower() folds ASCII only, so "José" and "JOSÉ" could both get invites
// while every JS check treats them as one person; fold in JS instead, with
// NFKC so look-alike forms (full-width letters, composed vs decomposed) match.
/** @param {string | null | undefined} name */
export function nameFold(name) {
  return String(name || "").normalize("NFKC").toLowerCase();
}

/**
 * @param {string} fromDay YYYY-MM-DD
 * @param {string} toDay YYYY-MM-DD
 */
export function daysBetween(fromDay, toDay) {
  const utc = (/** @type {string} */ s) => { const p = s.split("-"); return Date.UTC(+p[0], +p[1] - 1, +p[2]); };
  return Math.round((utc(toDay) - utc(fromDay)) / 86400e3);
}

/**
 * @param {string} s
 * @param {number} n
 */
export function clipText(s, n) {
  if (s.length <= n) return s;
  return s.slice(0, n - 3).replace(/[\ud800-\udbff]$/, "") + "...";
}

// Puts up to n entries of list at o[key], with o[key + "_more"] counting the rest.
/**
 * @param {object} o
 * @param {string} key
 * @param {unknown[]} list
 * @param {number} n
 */
export function capped(o, key, list, n) {
  /** @type {Record<string, unknown>} */ (o)[key] = list.slice(0, n);
  if (list.length > n) /** @type {Record<string, unknown>} */ (o)[key + "_more"] = list.length - n;
}

/** @param {string} html */
export function htmlToText(html) {
  const t = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || "";
  let s = html.replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|li|h[1-6]|tr|section|article)>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  const dec = function (/** @type {string} */ x) { return x.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#39;/g, "'").replace(/&#(\d+);/g, function (/** @type {string} */ m0, /** @type {string} */ n) { return String.fromCharCode(+n); }); };
  s = dec(s).replace(/[ \t\f\v\r]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return { title: dec(t).replace(/\s+/g, " ").trim(), text: s };
}

// Does this message @-mention this member name? Word-bounded, case-insensitive.
/**
 * @param {string | null | undefined} text
 * @param {string | null | undefined} name
 */
export function mentionsName(text, name) {
  const t = String(text || "");
  const n = String(name || "").trim();
  if (!t || !n) return false;
  const esc = n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp("(^|[^A-Za-z0-9_])@" + esc + "(?![A-Za-z0-9_])", "i").test(t);
}

// Strip the Markdown that would sound like noise read aloud, and cap the length
// (a speak request is one synthesis, billed per character).
/** @param {unknown} text */
export function speakableText(text) {
  var t = String(text || "");
  t = t.replace(/```[\s\S]*?```/g, " ");
  t = t.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");
  t = t.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
  t = t.replace(/`([^`]*)`/g, "$1");
  t = t.replace(/[*_#>~|]/g, " ");
  t = t.replace(/\s+/g, " ").trim();
  return t.slice(0, 1500);
}

// True for an unedited blank from a room_state call: the whole text is one <...> with no other tags in it.
/** @param {unknown} s */
export function isPlaceholder(s) {
  return /^<[^<>]*>$/.test(String(s || "").trim());
}

/** @param {unknown} x */
export function escHtml(x) {
  return String(x).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * @param {number} n
 * @param {number} lo
 * @param {number} hi
 */
export function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}
