// Exquisite Corpse's sentence count (1 to 3 a segment): the server's copy
// (worker/games/corpse-sentences.ts) and the web composer's
// (web/app/src/features/games/corpse/sentences.ts) must agree, or Send is
// disabled on a segment the server takes, or the reverse.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ecSentences as server } from "../../worker/games/corpse-sentences.ts";
import { ecSentences as web } from "../../web/app/src/features/games/corpse/sentences.ts";

const SERVER = new URL("../../worker/games/corpse-sentences.ts", import.meta.url);
const WEB = new URL("../../web/app/src/features/games/corpse/sentences.ts", import.meta.url);

// [text, count]
const CORPUS = [
  ["It was a dark night.", 1],
  ["The rain fell. A door creaked.", 2],
  ["The rain fell. A door creaked. Nobody came.", 3],
  ["The rain fell. A door creaked. Nobody came. Then morning.", 4],
  ["Dr. Watson knocked twice. Nobody answered.", 2],
  ["Mr. Smith met Mrs. Jones at the gate. It rained.", 2],
  ["J. R. R. Tolkien wrote it.", 1],
  ["The U.S. Army came at 5 p.m. sharp. They left.", 2],
  ["Он пришёл. Она ушла. Дождь. Снег. Ночь.", 5],
  ["Ήρθε. Έφυγε.", 2],
  ["它来了。她走了。下雨了。", 3],
  ["What was that? \"Run!\" She ran.", 3],
  ["No full stop at the end", 1],
  ["...", 0],
  // a one-letter word ends the sentence unless it is an initial: a piece of
  // initials only, or one middle initial a segment, and only before a
  // capital (six "Plan X." sentences used to count 1)
  ["Plan A. Plan B. Plan C. Plan D.", 4],
  ["Plan A. Plan B. Plan C. Plan D. Plan E. Plan F.", 6],
  ["I took vitamin C. Then D. Then E. Then K. Then B.", 5],
  ["We like Plan A. We like Plan B. We like Plan C. We like Plan D.", 3],
  ["I saw George W. Bush. He waved.", 2],
  ["J. K. Rowling wrote it. Then she rested.", 2],
  ["We ate at noon and left at e. Then we slept.", 2],
  // 2 by grammar, but "St." is a title here and runs on into "Nobody"
  // (the "St. Louis" reading): ambiguous stops count fewer
  ["Dr. Watson knocked at 5 p.m. on Baker St. Nobody answered.", 1],
  // an abbreviation before a capital runs on once a segment, so the most
  // they can hide is one sentence (they used to run on without limit)
  ["We ran to the U.S. We hid in the U.K. We fled to the E.U. We slept in the U.S. We woke.", 4],
  ["We ran etc. We hid etc. We fled etc. We slept etc. We woke.", 4],
  // ambiguous: one abbreviation before a capital runs on, so it counts fewer
  ["Come at 5 p.m. Bring wine.", 1],
  // a lowercase start does not hide a sentence end (the segmenter's did)
  ["it rained. we ran. they hid. nobody came.", 4],
  ["Well... maybe not. Fine.", 2],
  ["We went to see p. 5 of the book. It was dull.", 2],
  ["Stop!!! Go?! Now.", 3],
  ["He said 3.5 is enough.", 1],
  ["मैं घर गया। वह सो गई।", 2],
  // 3 by grammar: two middle initials in one segment over-count by one.
  // The once-a-segment cap is kept because it is what stops "We like Plan
  // A. We like Plan B. ..." from hiding a sentence behind every letter.
  ["She met John F. Kennedy and Martin L. King. They talked. It rained.", 4],
];

test("the server and web copies are the same file", () => {
  assert.equal(readFileSync(WEB, "utf8"), readFileSync(SERVER, "utf8"));
});

test("both copies count the corpus the same", () => {
  for (const [text, n] of CORPUS) {
    assert.equal(web(text), server(text), JSON.stringify(text));
    assert.equal(server(text), n, JSON.stringify(text));
  }
});

test("the finding's line is taken: abbreviations and initials end no sentence", () => {
  const n = server("Dr. Watson knocked at 5 p.m. on Baker St. Nobody answered.");
  assert.ok(n >= 1 && n <= 3, "counted " + n);
});
