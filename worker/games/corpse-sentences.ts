// Exquisite Corpse's sentence count, for its 1-to-3 rule. Two identical
// copies: worker/games/corpse-sentences.ts (the server refuses past 3) and
// web/app/src/features/games/corpse/sentences.ts (the composer counts as
// you type and disables Send past 3). They must agree, or the composer
// blocks a segment the server would take, or the reverse:
// tests/unit/corpse-sentences.test.mjs checks the two files are the same
// and the counts on a fixed corpus.
//
// The count used to split after every . ! ? and keep only pieces with a
// Latin letter or digit: "Dr. Watson knocked at 5 p.m. on Baker St.
// Nobody answered." counted 4 and was refused, "J. R. R. Tolkien wrote
// it." counted 4, and five Russian sentences counted 0. Now the runtime's
// sentence segmenter splits (any script), a piece that ends on a known
// abbreviation or an initial runs on into the next, and any letter or
// digit counts. Where a full stop is ambiguous ("Baker St. Nobody") it
// counts fewer: a segment is capped by length too.
//
// A one-letter word before a full stop is an initial only in two shapes,
// and only before a capital: a piece of nothing but initials ("J. R. R.
// Tolkien", "J. K. Rowling"), or one capital after a capitalised word that
// does not open its piece ("I saw George W. Bush"), the second at most
// once a segment. An earlier version let every piece that ended on a
// one-letter word run on, so "Plan A. Plan B. Plan C. Plan D. Plan E.
// Plan F." and "I took vitamin C. Then D. Then E." counted 1 and a writer
// could send six sentences; now the most the middle-initial shape can
// hide is one.

// Words that end in a full stop without ending the sentence.
const EC_ABBREVIATIONS = new Set([
  "mr", "mrs", "ms", "mx", "dr", "prof", "sr", "jr", "st", "mt", "ft", "rev", "fr", "gen", "col", "capt", "lt", "sgt", "gov", "sen", "rep", "hon",
  "vs", "etc", "approx", "dept", "est", "inc", "ltd", "co", "corp", "ave", "rd", "blvd", "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "sept", "oct", "nov", "dec",
]);

type SentenceSplitter = { segment(text: string): Iterable<{ segment: string }> };

let splitter: SentenceSplitter | null | undefined;
function sentenceSplitter(): SentenceSplitter | null {
  if (splitter === undefined) {
    try {
      splitter = typeof Intl !== "undefined" && typeof Intl.Segmenter === "function" ? new Intl.Segmenter("en", { granularity: "sentence" }) : null;
    } catch {
      // a runtime without sentence data: the split below
      splitter = null;
    }
  }
  return splitter;
}

/** @param seg the splitter to use; null is the fallback split (tests) */
export function ecSentences(text: string, seg: SentenceSplitter | null = sentenceSplitter()): number {
  const s = String(text);
  // without a segmenter: after . ! ? or an ellipsis (and any closing
  // quote or bracket) and a space, or right after a CJK full stop
  const pieces = seg ? Array.from(seg.segment(s), (x) => x.segment) : s.split(/(?<=[.!?…])["'”’)\]]*\s+|(?<=[。！？])/);
  let n = 0;
  let runsOn = false;
  let middleInitialUsed = false;
  for (let i = 0; i < pieces.length; i++) {
    const t = (pieces[i] ?? "").trim();
    if (!/[\p{L}\p{N}]/u.test(t)) continue;
    if (!runsOn) n++;
    const words = t.split(/\s+/);
    const last = words[words.length - 1] || "";
    runsOn = false;
    if (/^\p{Lu}\.$/u.test(last)) {
      // "J." or the "W." of "George W. Bush": the sentence goes on only
      // into a piece that starts with a capital
      const next = pieces.slice(i + 1).find((p) => /[\p{L}\p{N}]/u.test(p)) || "";
      if (/^["'“‘([]*\p{Lu}/u.test(next.trim())) {
        const before = words.slice(0, -1);
        if (before.every((w) => /^\p{Lu}\.$/u.test(w))) runsOn = true;
        else if (!middleInitialUsed && before.length >= 2 && /^\p{Lu}/u.test(before[before.length - 1] ?? "")) {
          runsOn = true;
          middleInitialUsed = true;
        }
      }
    } else {
      // "U.S." "p.m." or "Dr." - the sentence goes on in the next piece
      runsOn = /^(\p{L}\.){2,}$/u.test(last) || (last.endsWith(".") && EC_ABBREVIATIONS.has(last.slice(0, -1).toLowerCase()));
    }
  }
  return n;
}
