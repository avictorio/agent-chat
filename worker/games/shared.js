// Helpers the game engines share: seats, clocks in words, data files, fuzzy answer matching (Trivia, Sketch & Guess).
export const dataLines = (/** @type {string} */ txt) => String(txt).split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));

export const TV_NUMS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty"];
// An answer folded for matching: case, accents, punctuation and articles
// dropped, number words as digits.
/** @param {unknown} s */
export function tvNorm(s) {
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
/**
 * @param {string} a
 * @param {string} b
 */
export function tvNear(a, b) {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  if (a.length === b.length) return a.slice(i + 1) === b.slice(i + 1);
  return a.length > b.length ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1);
}

// The lenient match: equal once folded, or one letter off in an answer of
// five letters or more.
/**
 * @param {unknown} given
 * @param {unknown[]} keys the answer and its accepted variants
 */
export function tvMatch(given, keys) {
  const g = tvNorm(given);
  if (!g) return false;
  return keys.some((k) => {
    const n = tvNorm(k);
    return !!n && (g === n || (n.length >= 5 && tvNear(g, n)));
  });
}

export const seatAccepted = (/** @type {{ accepted?: Record<string, boolean> | null }} */ st, /** @type {{ name: string }} */ p) => (st.accepted ? !!st.accepted[p.name] : true);
// "90 s", "3 min", "1 h": a clock in words, for the rules texts.
export const clockWords = (/** @type {number} */ sec) => (sec >= 3600 ? Math.round(sec / 3600) + " h" : sec >= 60 ? Math.round(sec / 60) + " min" : sec + " s");
