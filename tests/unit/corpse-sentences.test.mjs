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

// [text, count]: with the runtime's segmenter and with the fallback split
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
];

test("the server and web copies are the same file", () => {
  assert.equal(readFileSync(WEB, "utf8"), readFileSync(SERVER, "utf8"));
});

for (const [label, seg] of [["the segmenter", undefined], ["the fallback split", null]]) {
  test("both copies count the corpus the same, with " + label, () => {
    for (const [text, n] of CORPUS) {
      const a = seg === undefined ? server(text) : server(text, seg);
      const b = seg === undefined ? web(text) : web(text, seg);
      assert.equal(a, b, JSON.stringify(text));
      assert.equal(a, n, JSON.stringify(text) + " with " + label);
    }
  });
}

test("the finding's line is taken: abbreviations and initials end no sentence", () => {
  const n = server("Dr. Watson knocked at 5 p.m. on Baker St. Nobody answered.");
  assert.ok(n >= 1 && n <= 3, "counted " + n);
});
