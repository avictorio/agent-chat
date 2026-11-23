// Exquisite Corpse's sentence count, for its 1-to-3 rule. Two identical
// copies: worker/games/corpse-sentences.ts (the server refuses past 3) and
// web/app/src/features/games/corpse/sentences.ts (the composer counts as
// you type and disables Send past 3). They must agree, or the composer
// blocks a segment the server would take, or the reverse:
// tests/unit/corpse-sentences.test.mjs checks the two files are the same
// and the counts on a fixed corpus.
//
// One code path, the same plain rules in every runtime. An earlier version
// split with Intl.Segmenter where the runtime had one and a regular
// expression where not; the two disagreed ("see p. 5 of the book" was one
// sentence or two), browsers and the Worker can ship different sentence
// data, and the segmenter never split before a lowercase letter, so "it
// rained. we ran. they hid." counted 1.
//
// The rule:
// 1. Split after a run of stops (. ! ? and the ellipsis, and other
//    scripts' stops) and any closing quotes or brackets, when whitespace
//    or the end follows; "3.5" and "e.g.x" do not split. CJK stops split
//    with no space after them.
// 2. A piece counts when it holds a letter or a digit of any script.
// 3. A piece that ends in one full stop runs on into the next counted
//    piece only in these cases:
//    a. Initials, before a capital: a piece of nothing but initials
//       ("J. R. R. Tolkien"), or one capital after a capitalised word that
//       does not open its piece ("I saw George W. Bush"), the second shape
//       once a segment. Every one-letter word used to run on, and "Plan A.
//       Plan B. ... Plan F." counted 1.
//    b. A title (Dr. Mr. St. ...) always.
//    c. Another abbreviation ("U.S.", "p.m.", "etc.", "approx.") before a
//       lowercase letter or a digit ("at 5 p.m. on Baker"); before anything
//       else once a segment ("the U.S. Army"). They used to run on without
//       limit, and "We ran to the U.S. We hid in the U.K. ..." counted 1.
//    d. A lowercase one-letter word before a lowercase letter or a digit
//       ("see p. 5").
//    A piece ending in an ellipsis runs on before a lowercase letter
//    ("Well... maybe not."), and so does one that ends inside closing
//    quotes or brackets ('"Run!" she shouted.' is one sentence). Every
//    other stop ends a sentence. Where a stop is ambiguous ("Come at 5 p.m.
//    Bring wine.") this counts fewer: a segment is capped by length too.
// Opening quotes and brackets are not part of a word: '"Dr. Watson," she
// said.' opens on a title all the same. A story game is full of speech,
// and with the quote left on, the title was not seen and the line counted
// one sentence more.

const STOPS = ".!?…։।॥؟۔።";
const CJK_STOPS = "。！？";
const CLOSERS = "\"'”’»)\\]}」』";
const CLOSED = new RegExp("[" + CLOSERS + "]$", "u");
const OPENERS = /^["'“‘„«([{¿¡「『]+/u;
const PIECE = new RegExp("[^]*?(?:[" + STOPS + "]+[" + CLOSERS + "]*(?=\\s|$)|[" + CJK_STOPS + "]+[" + CLOSERS + "]*|$)", "gu");

// Titles before a name: they always run on.
const EC_TITLES = new Set(["mr", "mrs", "ms", "mx", "dr", "prof", "st", "mt", "ft", "rev", "fr", "gen", "col", "capt", "lt", "sgt", "gov", "sen", "rep", "hon"]);
// Other words that end in a full stop without always ending the sentence.
const EC_ABBREVIATIONS = new Set([
  "sr", "jr", "vs", "etc", "approx", "dept", "est", "inc", "ltd", "co", "corp", "ave", "rd", "blvd",
  "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "sept", "oct", "nov", "dec",
]);

const INITIAL = /^\p{Lu}\.$/u;

export function ecSentences(text: string): number {
  const pieces = Array.from(String(text).matchAll(PIECE), (m) => m[0].trim()).filter((p) => /[\p{L}\p{N}]/u.test(p));
  let n = 0;
  let runsOn = false;
  let middleInitialUsed = false;
  let abbreviationUsed = false;
  for (let i = 0; i < pieces.length; i++) {
    const t = pieces[i] ?? "";
    if (!runsOn) n++;
    runsOn = false;
    // how the next piece starts, past opening quotes and brackets
    const next = (pieces[i + 1] ?? "").replace(OPENERS, "");
    const nextCapital = /^\p{Lu}/u.test(next);
    const nextLower = /^[\p{Ll}\p{N}]/u.test(next);
    if (/(?:\.\.\.|…)$/u.test(t) || CLOSED.test(t)) {
      runsOn = /^\p{Ll}/u.test(next);
      continue;
    }
    if (!/[^.]\.$/u.test(t)) continue;
    const words = t.split(/\s+/).map((w) => w.replace(OPENERS, ""));
    const last = words[words.length - 1] || "";
    const word = last.slice(0, -1).toLowerCase();
    if (INITIAL.test(last)) {
      if (!nextCapital) continue;
      const before = words.slice(0, -1);
      if (before.every((w) => INITIAL.test(w))) runsOn = true;
      else if (!middleInitialUsed && before.length >= 2 && /^\p{Lu}/u.test(before[before.length - 1] ?? "")) {
        runsOn = true;
        middleInitialUsed = true;
      }
    } else if (EC_TITLES.has(word)) {
      runsOn = true;
    } else if (/^(\p{L}\.){2,}$/u.test(last) || EC_ABBREVIATIONS.has(word)) {
      if (nextLower) runsOn = true;
      else if (!abbreviationUsed) {
        runsOn = true;
        abbreviationUsed = true;
      }
    } else if (/^\p{Ll}\.$/u.test(last)) {
      runsOn = nextLower;
    }
  }
  return n;
}
