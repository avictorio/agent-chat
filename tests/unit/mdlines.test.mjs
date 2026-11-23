// The Markdown line tests must give the answers the old regular
// expressions gave on ordinary lines, and must not slow down on hostile
// ones: a message is rendered in every open page of its room.
import test from "node:test";
import assert from "node:assert/strict";
import { fenceOf, headingOf, isRule, isTableSep, linkLength, MD_LINK_URL, plainText } from "../../web/app/src/features/feed/mdlines.ts";

// What the renderer used before (each is cubic or quadratic on some line).
const OLD = {
  heading: /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/,
  fence: /^\s*(`{3,}|~{3,})\s*([\w+.#-]*)\s*$/,
  rule: /^\s{0,3}([-*_])(\s*\1){2,}\s*$/,
  tableSep: /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/,
};
const oldPlainText = (s) => String(s || "")
  .replace(/^[ \t]*(`{3,}|~{3,}).*$/gm, "")
  .replace(/^[ \t]*\|?[ \t:|-]*-[ \t:|-]*\|?[ \t]*$/gm, "")
  .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d{1,9}[.)])\s+/gm, "")
  .replace(/\[([^\]\n]+)\]\(([^)\s]+)[^)]*\)/g, "$1")
  .replace(/https?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]]/g, "a link")
  .replace(/(\*\*|__|~~|`)/g, "")
  .replace(/(^|\s)[*_]([^*_\n]+)[*_](?=\s|[.,;:!?]|$)/gm, "$1$2")
  .replace(/^[ \t]*\|[ \t]*|[ \t]*\|[ \t]*$/gm, "")
  .replace(/[ \t]*\|[ \t]*/g, ", ");

/** Short lines from the characters Markdown cares about, the same every run. */
function* corpus(n) {
  const alphabet = [" ", " ", " ", "\t", "#", "#", "-", "-", "*", "_", "|", "|", ":", "`", "`", "~", ">", "a", "b", "1", ".", "+", ")"];
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let i = 0; i < n; i++) {
    let s = "";
    const len = Math.floor(rnd() * 22);
    for (let k = 0; k < len; k++) s += alphabet[Math.floor(rnd() * alphabet.length)];
    yield s;
  }
}
/** Lines built from whole Markdown tokens, so fences, rules and table lines turn up often. */
function* tokenLines(n) {
  const tokens = ["```", "~~~", "````", "---", "***", "___", "--", "-", "*", "_", "|", "|", ":--", "--:", ":-:", " ", " ", "  ", "\t", "js", "a", "#", "## ", ":"];
  let seed = 987;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let i = 0; i < n; i++) {
    let s = "";
    const len = 1 + Math.floor(rnd() * 6);
    for (let k = 0; k < len; k++) s += tokens[Math.floor(rnd() * tokens.length)];
    yield s;
  }
}
const WRITTEN = [
  "# Title", "## Title ##", "###### deep", "####### seven is no heading", "#no space", "# ", "#", "# C#", "   # three in", "    # four in",
  "# a # b", "#\ttab", "# trailing   ", "# closed #   ", "# ###", "```", "```js", "~~~", "``` js ", "```js```", "````", "``", "   ```ts", "``` a b",
  "---", "***", "___", "- - -", "-- -", "--", "- * -", "   ---", "    ---", "-\t-\t-", "| a | b |", "|---|---|", "| --- | :---: | ---: |", "---|---",
  "--- | ---", "|---||---|", "| - | - |", ":--", "|", "||", "", "   ", "-", "plain words", "a | b",
];

test("the line tests agree with the old expressions on ordinary lines", () => {
  let n = 0, headings = 0, fences = 0, rules = 0, seps = 0;
  for (const line of [...WRITTEN, ...corpus(60000), ...tokenLines(40000)]) {
    n++;
    const oh = OLD.heading.exec(line), h = headingOf(line);
    assert.deepEqual(h, oh ? { level: oh[1].length, text: oh[2] } : null, "heading " + JSON.stringify(line));
    const of = OLD.fence.exec(line);
    assert.equal(fenceOf(line), of ? of[1] : null, "fence " + JSON.stringify(line));
    assert.equal(isRule(line), OLD.rule.test(line), "rule " + JSON.stringify(line));
    assert.equal(isTableSep(line), OLD.tableSep.test(line), "table separator " + JSON.stringify(line));
    headings += h ? 1 : 0; fences += of ? 1 : 0; rules += OLD.rule.test(line) ? 1 : 0; seps += OLD.tableSep.test(line) ? 1 : 0;
  }
  // the corpus must really exercise each kind, or agreement means nothing
  assert.ok(headings > 500 && fences > 500 && rules > 500 && seps > 500, JSON.stringify({ n, headings, fences, rules, seps }));
});

test("plainText still reads ordinary Markdown the same way", () => {
  const samples = [
    "# Title\nSome **bold** and _soft_ words, `code`, ~~gone~~.",
    "A [link](https://example.com/a) and a bare https://example.com/b, done.",
    "[with title](https://example.com \"the title\") after",
    "| a | b |\n|---|---|\n| 1 | 2 |",
    "```js\nconst x = 1;\n```\nafter the block",
    "- one\n- two\n1. three\n> quoted",
    "---\ntext\n- - -\n: | -",
    "snake_case and 2 * 3 * 4 stay",
    "| a |\n|b\nc|\n||\n|\n a | b \n  |  x  |  y  |  ",
    ...[...corpus(4000)].map((l, i, all) => l + "\n" + all[(i + 7) % all.length]),
    ...[...tokenLines(4000)].map((l, i, all) => l + "\n" + all[(i + 3) % all.length]),
  ];
  for (const s of samples) assert.equal(plainText(s), oldPlainText(s), JSON.stringify(s));
});

/** Runs fn and fails if it took longer than `ms`. */
function quick(label, ms, fn) {
  const t = performance.now();
  const out = fn();
  const took = performance.now() - t;
  assert.ok(took < ms, label + " took " + Math.round(took) + " ms");
  return out;
}

test("a hostile line costs no more than its length", () => {
  const N = 1000000, sp = " ".repeat(N);
  // the line that froze the room: the old heading pattern needs about a minute for 8,000 characters
  assert.deepEqual(quick("heading", 300, () => headingOf("# a" + sp + "b")), { level: 1, text: "a" + sp + "b" });
  assert.deepEqual(quick("heading of hashes", 300, () => headingOf("# " + "#".repeat(N) + " x")), { level: 1, text: "#".repeat(N) + " x" });
  assert.equal(quick("fence", 300, () => fenceOf("```" + sp + "x y")), null);
  assert.equal(quick("fence of spaces", 300, () => fenceOf(sp + "x")), null);
  assert.equal(quick("rule", 300, () => isRule("- " + sp + "- x")), false);
  assert.equal(quick("rule of dashes", 300, () => isRule("-" + " -".repeat(N / 2))), true);
  assert.equal(quick("table separator", 300, () => isTableSep("|" + sp + "|" + sp + "x")), false);
  assert.equal(quick("table separator of dashes", 300, () => isTableSep("--".repeat(N / 4) + ":x")), false);
  assert.equal(quick("table separator of cells", 600, () => isTableSep("|---".repeat(N / 4) + "|")), true);
});

test("text for reading aloud costs no more than its length either", () => {
  const N = 200000;
  quick("brackets", 500, () => plainText("[".repeat(N)));
  quick("half links", 500, () => plainText("[a](x".repeat(N / 5)));
  quick("unclosed link", 500, () => plainText("[a](" + "x".repeat(N)));
  quick("dashes and pipes", 500, () => plainText("- |".repeat(N / 3) + "x"));
  quick("spaces", 500, () => plainText(" ".repeat(N) + "x\n" + "\t".repeat(N) + "|"));
  quick("stars", 500, () => plainText("*a ".repeat(N / 3)));
});

// Addresses with parentheses (Wikipedia's Mercury_(planet)) were cut at the
// ")" in chat and on the board, and opened a missing page.
const W = "https://en.wikipedia.org/wiki/";
/** The [text](url) arm as the renderer builds it (markdown.ts). */
const LINK = new RegExp("\\[([^[\\]\\n]+)\\]\\((" + MD_LINK_URL + ")(?:\\s+\"[^\"\\n]*\")?\\)");

test("an address keeps parentheses that close inside it", () => {
  const cases = [
    [W + "Mercury_(planet)", W + "Mercury_(planet)"],
    [W + "Mercury_(planet).", W + "Mercury_(planet)"],
    [W + "Mercury_(planet)),", W + "Mercury_(planet)"],
    ["https://example.com/a)", "https://example.com/a"],
    ["https://example.com/a).", "https://example.com/a"],
    ["https://example.com/b_(c)_d", "https://example.com/b_(c)_d"],
    ["https://example.com/x?y=1!", "https://example.com/x?y=1"],
    ["https://example.com/]", "https://example.com/"],
    ["www.example.com/x_(y))", "www.example.com/x_(y)"],
    ["https://.", ""],
    ["https://", ""],
    ["www.", ""],
  ];
  for (const [run, want] of cases) assert.equal(run.slice(0, linkLength(run)), want, JSON.stringify(run));
  assert.deepEqual(LINK.exec("[Mercury](" + W + "Mercury_(planet)) after").slice(1, 3), ["Mercury", W + "Mercury_(planet)"]);
  assert.deepEqual(LINK.exec("[a](https://x.org/a \"title\")").slice(1, 3), ["a", "https://x.org/a"]);
  assert.equal(plainText("See [Mercury](" + W + "Mercury_(planet)) and " + W + "Venus_(planet)."), "See Mercury and a link.");
  assert.equal(plainText("(see https://example.com/a)"), "(see a link)");
});

test("the link patterns cost no more than their length either", () => {
  const N = 200000;
  quick("open parens", 500, () => plainText("[a](" + "(".repeat(N)));
  quick("open pairs", 500, () => plainText("[a](" + "(x".repeat(N / 2)));
  quick("closed pairs, never closed", 500, () => plainText("[a](" + "(x)".repeat(N / 3)));
  quick("half links with pairs", 500, () => plainText("[a](x(y)".repeat(N / 8)));
  quick("bare address of closers", 500, () => plainText("https://" + ")".repeat(N) + "x"));
  quick("bare address of dots", 500, () => plainText("https://x" + ".".repeat(N)));
  quick("linkLength", 300, () => linkLength("https://" + "(".repeat(N) + ")".repeat(N) + ".)".repeat(N)));
  const line = "[a](" + "(x".repeat(4000);
  quick("the link arm on one message line", 300, () => LINK.exec(line));
});
