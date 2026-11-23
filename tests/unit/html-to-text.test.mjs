// The fetch tool's HTML to text (worker/lib/text.ts, htmlToText). Its three
// regexes rescanned to the end of the page from every opening with no
// close: a page of a million "<" (1 KB gzipped) took 17 s of Worker CPU,
// and every other request on the isolate waited. Each step is one pass now.
import test from "node:test";
import assert from "node:assert/strict";
import { htmlToText } from "../../worker/lib/text.ts";
import { FETCH_MAX_BYTES } from "../../worker/platform/webfetch.ts";

test("a page of unclosed openings converts in a moment (the auditor's pages)", () => {
  const pages = [
    ["<", "<".repeat(FETCH_MAX_BYTES)],
    ["<svg>", "<svg>".repeat(FETCH_MAX_BYTES / 5)],
    ["<title>", "<title>".repeat(Math.floor(FETCH_MAX_BYTES / 7))],
    ["<script>", "<script>".repeat(FETCH_MAX_BYTES / 8)],
    ["<head <style", "<head <style".repeat(Math.floor(FETCH_MAX_BYTES / 12))],
  ];
  for (const [label, page] of pages) {
    const t0 = performance.now();
    htmlToText(page, FETCH_MAX_BYTES);
    const ms = performance.now() - t0;
    // linear: tens of milliseconds here; the regexes took seconds at a fifth of this size
    assert.ok(ms < 2000, label + " took " + Math.round(ms) + " ms");
  }
});

test("the conversion reads no more than it is given leave to", () => {
  const r = htmlToText("<p>" + "a".repeat(50) + "</p>tail", 20);
  assert.equal(r.text, "a".repeat(17));
});

test("pages convert as before", () => {
  const page = "<html><head><title>Hi &amp; bye</title><style>p{}</style></head><body><h1>Head</h1><p>One<br>two</p>" +
    "<script>x()</script><div>Three &lt;3</div><svg><path/></svg><ul><li>a</li><li>b</li></ul>tail</body></html>";
  assert.deepEqual(htmlToText(page, FETCH_MAX_BYTES), { title: "Hi & bye", text: "Head\nOne\ntwo\nThree <3\na\nb\ntail" });
  assert.deepEqual(htmlToText("<SCRIPT>a</SCRIPT>b<Style>c</STYLE>d", 100), { title: "", text: "b d" });
  assert.deepEqual(htmlToText("<title a=1>T</title><title>U</title>", 100).title, "T");
  // an opener with no close is a tag; the text after it stays
  assert.deepEqual(htmlToText("<p>open <script>no close", 100), { title: "", text: "open no close" });
  assert.deepEqual(htmlToText("<title>no close", 100), { title: "", text: "no close" });
  // a "<" with no ">" after it is text, as is "<>"
  assert.equal(htmlToText("a < b", 100).text, "a < b");
  assert.equal(htmlToText("x<>y", 100).text, "x<>y");
  // <header> is not <head>: the old pattern took everything up to a </head>
  assert.equal(htmlToText("<header>H</header><p>P</p></head>", 100).text, "H P");
});
