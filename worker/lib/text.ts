// Small text and number helpers.

export const MAX_NAME = 40;

// C0 control characters and DEL: names and file names never carry them.
// oxlint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
export function hasControlChar(s: string) {
  return CONTROL_CHARS.test(s);
}
export function stripControlChars(s: string) {
  return s.replace(new RegExp(CONTROL_CHARS.source, "g"), "");
}

// Object.prototype's member names, folded (memberNameProblem).
const RESERVED_KEYS = new Set(Object.getOwnPropertyNames(Object.prototype).map((k) => k.toLowerCase()));

// Member names (2026-11-19 sweep): free text, but never markup or game
// syntax. A name reaches HTML-built strings, game moves ("Ada:C5", volleys
// split on commas) and push titles, so new names may not carry those
// characters. Older names keep working; the web app escapes them anyway.
export function memberNameProblem(name: string) {
  if (hasControlChar(name) || /[<>"'&`]/.test(name)) return "Names can't contain < > \" ' & ` or control characters";
  if (/[,:]/.test(name)) return "Names can't contain a comma or a colon (they separate targets in game moves)";
  // Names key plain objects all over the game state (scores, moves, votes):
  // one that is also an Object.prototype member ("__proto__", "toString")
  // would read inherited values, or swap an object's prototype.
  if (RESERVED_KEYS.has(nameFold(name))) return "That name is reserved - pick another";
  return null;
}

// Two names are the same member when they fold the same way. SQLite's
// lower() folds ASCII only, so "José" and "JOSÉ" could both get invites
// while every JS check treats them as one person; fold in JS instead, with
// NFKC so look-alike forms (full-width letters, composed vs decomposed) match.
export function nameFold(name: string | null | undefined) {
  return String(name || "").normalize("NFKC").toLowerCase();
}

/**
 * @param fromDay YYYY-MM-DD
 * @param toDay YYYY-MM-DD
 */
export function daysBetween(fromDay: string, toDay: string) {
  const utc = (s: string) => { const p = s.split("-"); return Date.UTC(+p[0], +p[1] - 1, +p[2]); };
  return Math.round((utc(toDay) - utc(fromDay)) / 86400e3);
}

export function clipText(s: string, n: number) {
  if (s.length <= n) return s;
  return s.slice(0, n - 3).replace(/[\ud800-\udbff]$/, "") + "...";
}

// Puts up to n entries of list at o[key], with o[key + "_more"] counting the rest.
export function capped(o: object, key: string, list: unknown[], n: number) {
  (o as Record<string, unknown>)[key] = list.slice(0, n);
  if (list.length > n) (o as Record<string, unknown>)[key + "_more"] = list.length - n;
}

export function htmlToText(html: string) {
  const t = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || "";
  let s = html.replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|li|h[1-6]|tr|section|article)>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  const dec = function (x: string) { return x.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#39;/g, "'").replace(/&#(\d+);/g, function (m0: string, n: string) { return String.fromCharCode(+n); }); };
  s = dec(s).replace(/[ \t\f\v\r]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return { title: dec(t).replace(/\s+/g, " ").trim(), text: s };
}

// Does this message @-mention this member name? Word-bounded, case-insensitive.
export function mentionsName(text: string | null | undefined, name: string | null | undefined) {
  const t = String(text || "");
  const n = String(name || "").trim();
  if (!t || !n) return false;
  const esc = n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp("(^|[^A-Za-z0-9_])@" + esc + "(?![A-Za-z0-9_])", "i").test(t);
}

// Strip the Markdown that would sound like noise read aloud, and cap the length
// (a speak request is one synthesis, billed per character).
export function speakableText(text: unknown) {
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
export function isPlaceholder(s: unknown) {
  return /^<[^<>]*>$/.test(String(s || "").trim());
}

export function escHtml(x: unknown) {
  return String(x).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function clamp(n: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, n));
}
