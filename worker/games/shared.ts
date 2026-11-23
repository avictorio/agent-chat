// Helpers the game engines share: seats, clocks in words, data files, fuzzy answer matching (Trivia, Sketch & Guess).
export const dataLines = (txt: string) => String(txt).split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));

export const TV_NUMS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty"];
// The words of an answer, folded: case and (unless keepAccents) Latin
// accents dropped, every script's letters and digits kept, punctuation a
// word break. The fold once kept only a-z and 0-9, so "東京", "Москва"
// or "π" folded to nothing and could match no answer (every answer went
// to the quizmaster), and a Twenty Questions guess "avô" won against
// "avó". Only the combining accents U+0300-036F go: other scripts' marks
// (a Japanese voicing mark, a Devanagari vowel sign) change the word, so
// they are put back with NFC and kept. Signs that change an answer stay
// as words of their own: + # % < > and a minus in front of a number.
// They used to be word breaks, so "C++" matched "C#" and "-40" matched
// "40".
const FOLD_WORD = /(?:(?<![\p{L}\p{M}\p{N}])[-\u2212](?=\p{N}))?[\p{L}\p{M}\p{N}]+|[+#%<>]+/gu;
export function foldWords(s: unknown, keepAccents = false) {
  const t = String(s == null ? "" : s).normalize("NFKD");
  const folded = (keepAccents ? t : t.replace(/[\u0300-\u036f]/g, "")).normalize("NFC").toLowerCase();
  return (folded.match(FOLD_WORD) || []).map((w) => w.replace("\u2212", "-"));
}
// The answer as typed, for one with no letters or digits at all (an
// emoji): compared exactly, case and spacing aside.
export const foldRaw = (s: unknown) => String(s == null ? "" : s).normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
const TV_ARTICLES = ["the", "a", "an"];
// An answer folded for matching: foldWords, articles dropped, number
// words as digits. An answer that is only an article ("A" on a multiple
// choice) keeps it.
export function tvNorm(s: unknown) {
  const words = foldWords(s);
  const kept = words.filter((w) => !TV_ARTICLES.includes(w));
  return (kept.length ? kept : words).map((w) => { const i = TV_NUMS.indexOf(w); return i >= 0 ? String(i) : w; }).join(" ");
}
// At most one letter added, dropped or changed.
export function tvNear(a: string, b: string) {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  if (a.length === b.length) return a.slice(i + 1) === b.slice(i + 1);
  return a.length > b.length ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1);
}

// The lenient match: "exact" when equal once folded, "near" when one
// letter off in an answer of five letters or more, else null. A key with
// nothing to fold (an emoji) is compared as typed. No leeway once a
// number or a sign is in play: one character off there is another answer
// (2,000,000 for 1,000,000, July 5 for July 4), and it was scored right.
const TV_EXACT_ONLY = /[\p{N}+#%<>]/u;
/** @param keys the answer and its accepted variants */
export function tvMatchKind(given: unknown, keys: unknown[]): "exact" | "near" | null {
  const g = tvNorm(given);
  const raw = foldRaw(given);
  let near = false;
  for (const k of keys) {
    const n = tvNorm(k);
    if (!n) {
      if (raw && raw === foldRaw(k)) return "exact";
      continue;
    }
    if (!g) continue;
    if (g === n) return "exact";
    if (n.length >= 5 && !TV_EXACT_ONLY.test(n) && !TV_EXACT_ONLY.test(g) && tvNear(g, n)) near = true;
  }
  return near ? "near" : null;
}
export const tvMatch = (given: unknown, keys: unknown[]) => tvMatchKind(given, keys) !== null;

/**
 * "Ada:D", "paris @ 10": the text before a separator and the one word
 * after it, or null. The split is at the earliest separator (one of seps,
 * at index first or later) that has exactly one word after it, spaces
 * around it allowed: what /^(.+?)\s*[:=]\s*(\S+)$/ matched. It is done
 * by hand in a few passes because those regexes backtracked in quadratic
 * time, and one move of a letter, 60,000 spaces and a letter held the
 * whole room for most of a second.
 */
export function splitLastWord(s: string, seps: string, first: number): [string, string] | null {
  const ws = (ch: string) => /\s/.test(ch);
  let e = s.length;
  while (e > 0 && ws(s[e - 1])) e--;
  // the last word starts at t; p is the last character before the gap ahead of it
  let t = e;
  while (t > 0 && !ws(s[t - 1])) t--;
  let p = t - 1;
  while (p >= 0 && ws(s[p])) p--;
  let at = -1;
  if (p >= first && seps.indexOf(s[p]) >= 0) at = p;
  else for (let i = Math.max(t, first); i < e - 1; i++) if (seps.indexOf(s[i]) >= 0) { at = i; break; }
  return at < 0 ? null : [s.slice(0, at), s.slice(at + 1, e).trim()];
}

export const seatAccepted = (st: { accepted?: Record<string, boolean> | null }, p: { name: string }) => (st.accepted ? !!st.accepted[p.name] : true);
// "90 s", "3 min", "1 h": a clock in words, for the rules texts.
export const clockWords = (sec: number) => (sec >= 3600 ? Math.round(sec / 3600) + " h" : sec >= 60 ? Math.round(sec / 60) + " min" : sec + " s");

// A sealed move sent again unchanged (a retry after a lost reply, a second
// wake, a looping agent) is a no-op: no save, no frame, its time kept.
// The frame named the sender to every viewer on each copy, and the new
// time put the sender last in the tie-breaks that go to the earlier move
// (Auction's bid, Code Race's solve, Two Truths' and Sketch's quicker
// ties). The stored move is always this round's - a round that resolves
// clears it - so a repeat can never be mistaken for the next round's move.
export const sameMove = (stored: unknown, move: unknown) => stored !== undefined && stored !== null && JSON.stringify(stored) === JSON.stringify(move);
