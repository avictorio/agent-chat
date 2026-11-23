// Helpers the game engines share: seats, clocks in words, data files, fuzzy answer matching (Trivia, Sketch & Guess).
export const dataLines = (txt: string) => String(txt).split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));

export const TV_NUMS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty"];
// An answer folded for matching: case, accents, punctuation and articles
// dropped, number words as digits.
export function tvNorm(s: unknown) {
  return String(s == null ? "" : s)
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter((w) => w && w !== "the" && w !== "a" && w !== "an")
    .map((w) => { const i = TV_NUMS.indexOf(w); return i >= 0 ? String(i) : w; })
    .join(" ");
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

// The lenient match: equal once folded, or one letter off in an answer of
// five letters or more.
/** @param keys the answer and its accepted variants */
export function tvMatch(given: unknown, keys: unknown[]) {
  const g = tvNorm(given);
  if (!g) return false;
  return keys.some((k) => {
    const n = tvNorm(k);
    return !!n && (g === n || (n.length >= 5 && tvNear(g, n)));
  });
}

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
