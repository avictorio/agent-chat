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
/** A string as one single-quoted POSIX shell word: nothing inside single
 *  quotes is expanded, so $(...), backticks and \ arrive as text. Control
 *  characters are dropped (a newline has no place in a one-line value). */
export function shellQuote(s: string) {
  return "'" + stripControlChars(s).replace(/'/g, "'\\''") + "'";
}
/** Member-written text (the purpose, every name) on one line: each run of
 *  whitespace or control characters (C0, DEL, and C1 with NEL, which \s
 *  does not match and a member name may hold) becomes one space. */
// oxlint-disable-next-line no-control-regex -- matching control characters is the point
export const ONE_LINE = /[\s\x00-\x1f\x7f-\x9f]+/g;
export const oneLine = (s: string) => String(s).replace(ONE_LINE, " ").trim();

/** What quotedBody() writes as an escape: a backslash, a double quote, the
 *  characters that read as a double quotation mark (curly, low, reversed,
 *  primes, the Hebrew gershayim, ornaments, CJK and full-width marks,
 *  the ditto mark) and every invisible format character (general category
 *  Cf: zero-width space, bidi marks and overrides, soft hyphen, tags) but
 *  the two joiners, U+200C and U+200D, that scripts and emoji need. */
const NAME_ESCAPED = /[\\"\u201c\u201d\u201e\u201f\u2033\u2036\u02ba\u02dd\u02ee\u05f4\u275d\u275e\u301d\u301e\u301f\uff02\u3003\u2e42]|(?![\u200c\u200d])\p{Cf}/gu;
/** A member's name, already on one line (oneLine), as the body of the
 *  double quotes a text prints it in inside its own sentences (the start
 *  page, the invite note, the wake recipe): a JSON string's body, \ as
 *  \\, " as \", and each character of NAME_ESCAPED as \uXXXX (UTF-16
 *  units, lower-case hex: a surrogate pair above U+FFFF). A name is written
 *  by whoever made the invite: printed as it is, a quotation mark in it, or
 *  one that looks like one, could seem to end the quotes and the rest read
 *  as the text's own words, and a bidi override could reorder what a reader
 *  sees. memberNameProblem refuses only the straight double quote, and only
 *  in new names: older names may hold one. An ordinary name prints as it
 *  is. For a template that has its own quote marks around the name. */
export function quotedBody(name: string) {
  return name.replace(NAME_ESCAPED, (ch) => {
    if (ch === "\\" || ch === "\"") return "\\" + ch;
    let out = "";
    for (let i = 0; i < ch.length; i++) out += "\\u" + ch.charCodeAt(i).toString(16).padStart(4, "0");
    return out;
  });
}
/** quotedBody in its double quotes: JSON.parse of the whole gives the name back. */
export function quoted(name: string) {
  return "\"" + quotedBody(name) + "\"";
}

// Object.prototype's member names, folded (memberNameProblem).
export const RESERVED_KEYS = new Set(Object.getOwnPropertyNames(Object.prototype).map((k) => k.toLowerCase()));

// Member names: free text, but never markup or game syntax. A name
// reaches HTML-built strings, game moves ("Ada:C5", volleys split on
// commas) and push titles, so new names may not carry those characters.
// Older names keep working; the web app escapes them anyway.
/** Between the two names of a seat pair's key (gr.pair). A name cannot
 *  hold a control character (memberNameProblem), so two different pairs
 *  never share a key; joined with "|", which a name may contain, the pair
 *  ("a|b", "c") read as ("a", "b|c") and their duel records were counted
 *  together. The schema step that fills gr writes the same character as
 *  char(31). */
export const PAIR_SEP = "\u001f";

export function memberNameProblem(name: string) {
  if (hasControlChar(name) || /[<>"'&`]/.test(name)) return "Names can't contain < > \" ' & ` or control characters";
  // Half of a character (a lone surrogate) is stored as U+FFFD, so the
  // stored name would differ from the one checked here: see cleanName.
  if (/\p{Cs}|\uFFFD/u.test(name)) return "That name has a broken character in it - type it again";
  if (/[,:]/.test(name)) return "Names can't contain a comma or a colon (they separate targets in game moves)";
  // Names key plain objects all over the game state (scores, moves, votes):
  // one that is also an Object.prototype member ("__proto__", "toString")
  // would read inherited values, or swap an object's prototype.
  if (RESERVED_KEYS.has(nameFold(name))) return "That name is reserved - pick another";
  return null;
}

/**
 * A member name as typed, made storable: every run of whitespace becomes
 * one space, and the name is cut to MAX_NAME without splitting a
 * character.
 *
 * Why both. The cut used to count UTF-16 units, so it could leave half an
 * emoji at the end; storage turned that half into U+FFFD, and the stored
 * name no longer equalled the string that had been checked for
 * uniqueness. A second invite under the same typed name then went
 * through - two invites, one name, one seat in every match, each reading
 * the other's hand. And a name with a doubled or no-break space was one
 * no game move could target (the engines collapse whitespace in a move),
 * beside a single-spaced twin that every such move landed on.
 */
export function cleanName(raw: string | null | undefined): string {
  // NFC first, so the name checked (memberNameProblem) is the name stored:
  // invite() composes it, and U+1FEF composes to a backtick - a character
  // the check refuses, stored after passing it.
  const text = String(raw || "").normalize("NFC").replace(/\s+/g, " ").trim();
  let out = "";
  for (const ch of text) {
    if (out.length + ch.length > MAX_NAME) break;
    out += ch;
  }
  return out.trim();
}

// Two names are the same member when they fold the same way. SQLite's
// lower() folds ASCII only, so "José" and "JOSÉ" could both get invites
// while every JS check treats them as one person; fold in JS instead, with
// NFKC so look-alike forms (full-width letters, composed vs decomposed) match.
export function nameFold(name: string | null | undefined) {
  return String(name || "").normalize("NFKC").toLowerCase();
}

// Whether two strings name the same member: the one test the room uses
// (scripts/check-worker.js refuses a new toLowerCase() or SQL lower() in
// worker/room). Names used to be compared three ways - this fold, JS
// toLowerCase and SQL lower(), which folds ASCII only - so a member named
// "Émile" or "Иван" matched no invite in SQL and read as a system actor
// (kind non_interactive, the Referee's) on every message.
export function sameName(a: string | null | undefined, b: string | null | undefined) {
  return nameFold(a) === nameFold(b);
}

// The key a member's stored rows are filed under: their voice (mv.name),
// their push registrations (push.member) and their avatar's path in R2.
// The rows already stored were written under a plain toLowerCase, so the
// key stays that; it files rows, and never decides who is who (sameName).
export function nameKey(name: string | null | undefined) {
  return String(name || "").toLowerCase();
}

// Whether two names are equal once A-Z are lower-cased and nothing else:
// SQLite's lower(), which every name test used before sameName. Avatars
// still pick their invite rows this way (avatarMatch, room/members.ts),
// since a set or clear deletes the R2 picture of every row it reaches: by
// sameName, "Émile" clearing hers would delete the picture stored on a
// revoked "émile" row, which the room never deleted before, and widening
// what is deleted is the owner's call.
export function sqlLowerSame(a: string | null | undefined, b: string | null | undefined) {
  const low = (s: string | null | undefined) => String(s || "").replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
  return low(a) === low(b);
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

// A page's title and text. Every step is one pass: the three regexes this
// replaced (the title, script/style/svg/head blocks, any tag) each rescanned
// to the end of the page from every opening that had no close, so a page of
// a million "<" took 17 s of Worker CPU and held every other request on the
// isolate meanwhile (the fetch's timer cannot stop a synchronous loop). An
// opener with no close now ends the search for its kind: a later one has
// none either.
/** @param max the most of the page converted (the fetch reads no more) */
export function htmlToText(html: string, max: number) {
  if (html.length > max) html = html.slice(0, max);
  let t = "";
  const to = /<title\b/i.exec(html);
  if (to) {
    const open = html.indexOf(">", to.index);
    const close = open < 0 ? null : findFrom(html, /<\/title>/gi, open + 1);
    if (close) t = html.slice(open + 1, close.index);
  }
  let s = dropBlocks(html)
    .replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|li|h[1-6]|tr|section|article)>/gi, "\n");
  s = dropTags(s);
  const dec = function (x: string) { return x.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#39;/g, "'").replace(/&#(\d+);/g, function (m0: string, n: string) { return String.fromCharCode(+n); }); };
  s = dec(s).replace(/[ \t\f\v\r]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return { title: dec(t).replace(/\s+/g, " ").trim(), text: s };
}

/** the first match of a global regex at or after from */
function findFrom(s: string, re: RegExp, from: number) {
  re.lastIndex = from;
  return re.exec(s);
}

// script, style, noscript, svg and head elements, whole, each as one space.
// An opener with no close is left to dropTags, as a tag.
function dropBlocks(html: string) {
  const opener = /<(script|style|noscript|svg|head)\b/gi;
  /** names with no close left after some opener: none further on either */
  const dead = new Set<string>();
  let out = "", at = 0, m;
  while ((m = opener.exec(html))) {
    const name = m[1].toLowerCase();
    if (dead.has(name)) continue;
    const close = findFrom(html, new RegExp("</" + name + ">", "gi"), m.index + m[0].length);
    if (!close) { dead.add(name); continue; }
    out += html.slice(at, m.index) + " ";
    at = close.index + close[0].length;
    opener.lastIndex = at;
  }
  return out + html.slice(at);
}

// Every other tag (a "<", at least one character, the next ">") as one
// space. Once a "<" has no ">" after it, no later one has: the rest is text.
function dropTags(s: string) {
  let out = "", at = 0;
  for (;;) {
    const lt = s.indexOf("<", at);
    if (lt < 0) break;
    const gt = s.indexOf(">", lt + 1);
    if (gt < 0) break;
    if (gt === lt + 1) { out += s.slice(at, gt + 1); at = gt + 1; continue; }
    out += s.slice(at, lt) + " ";
    at = gt + 1;
  }
  return out + s.slice(at);
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
/** A message's placeholder: isPlaceholder, except an autolink - a URI in
 *  angle brackets (<https://...>, <mailto:...>: a scheme, a colon, no
 *  spaces) or an address (<ada@example.com>) - which is a real message an
 *  agent posts on its own, not a blank left in a template. */
export function isPlaceholderMessage(s: unknown) {
  const t = String(s || "").trim();
  return isPlaceholder(t) && !/^<(?:[a-z][a-z0-9+.-]{1,31}:[^\s<>]*|[^\s<>@]+@[^\s<>@]+)>$/i.test(t);
}
/** The refusal of a message from an agent's invite whose whole text is a
 *  placeholder (isPlaceholderMessage): a template sent as written, which
 *  would post "<your words>" into the room. A person's text is never refused
 *  for it. */
export const PLACEHOLDER_TEXT = "\"text\" is still a placeholder. Replace the <...> with your own words.";
/** The refusal of a post from an agent's invite whose client_msg_id is one
 *  placeholder (isPlaceholderMessage): a template's "<a new id for each
 *  post>" kept as written would make every later post with it a repeat of
 *  the first, answered 200 and posting nothing. */
export const PLACEHOLDER_CID = "\"client_msg_id\" is still a placeholder. Replace the <...> with a new id for this post.";

export function escHtml(x: unknown) {
  return String(x).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function clamp(n: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, n));
}
