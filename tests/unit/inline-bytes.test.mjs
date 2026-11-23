// Unit tests for the inline media decoder (worker/lib/sniff.ts inlineBytes),
// which every base64 field in a post, an attach, a voice sample and MCP goes
// through: the cap is checked from the text's length before decoding, and a
// file at the cap decodes in a heap far smaller than the old idiom needed
// (Uint8Array.from(atob(s), fn) ran out of a 128 MB heap at about 16 MB).
// Run with `npm run test:unit`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { decodeTextPayload, inlineBytes } from "../../worker/lib/sniff.ts";
import { VIDEO_MAX } from "../../worker/limits.ts";

test("inlineBytes decodes base64 and data: URLs, whitespace and all", () => {
  const bytes = new Uint8Array([0, 1, 2, 250, 255, 128]);
  const b64 = Buffer.from(bytes).toString("base64");
  assert.deepEqual(new Uint8Array(inlineBytes(b64, 100)), bytes);
  assert.deepEqual(new Uint8Array(inlineBytes("data:image/png;base64," + b64.slice(0, 4) + "\n " + b64.slice(4), 100)), bytes);
  assert.equal(inlineBytes("", 100).byteLength, 0);
});

test("inlineBytes refuses text that is not base64", () => {
  assert.equal(inlineBytes("not base64!", 100), null);
});

test("inlineBytes takes a file exactly at its cap and refuses one byte more", () => {
  for (const max of [9, 10, 11]) {
    assert.equal(inlineBytes(Buffer.alloc(max, 1).toString("base64"), max).byteLength, max);
    assert.equal(inlineBytes(Buffer.alloc(max + 1, 1).toString("base64"), max), "too_big");
  }
});

test("inlineBytes refuses an over-long field before decoding it", () => {
  // Not base64 at all: decoding would answer null. Too long for the cap,
  // it is refused on its length alone, unread.
  assert.equal(inlineBytes("!".repeat(17), 12), "too_big");
});

test("a video at the inline cap decodes in a 128 MB heap", () => {
  const sniff = fileURLToPath(new URL("../../worker/lib/sniff.ts", import.meta.url));
  const script = "import { inlineBytes } from " + JSON.stringify(sniff) + ";" +
    "const s = Buffer.alloc(" + VIDEO_MAX + ", 7).toString('base64');" +
    "const b = inlineBytes(s, " + VIDEO_MAX + ");" +
    "if (b.byteLength !== " + VIDEO_MAX + ") process.exit(2);";
  const r = spawnSync(process.execPath, ["--no-warnings", "--max-old-space-size=128", "--input-type=module", "-e", script], { encoding: "utf8", timeout: 60000 });
  assert.equal(r.status, 0, (r.stderr || "").slice(-400));
});

// Pages and documents (html, doc) are text, raw or as a base64 data: URL:
// the same length check comes before any decoding.
test("decodeTextPayload takes a page at its cap and refuses a longer one before decoding it", () => {
  const page = "<p>" + "x".repeat(7) + "</p>"; // 14 bytes
  assert.equal(decodeTextPayload(page, 14), page);
  assert.equal(decodeTextPayload(page, 13), "too_big");
  const url = "data:text/html;base64," + Buffer.from(page).toString("base64");
  assert.equal(decodeTextPayload(url, 14), page);
  assert.equal(decodeTextPayload("data:text/html;base64," + Buffer.alloc(16, 65).toString("base64"), 14), "too_big");
  // not base64 at all, and too long: refused on its length, unread
  assert.equal(decodeTextPayload("data:text/html;base64," + "!".repeat(40), 14), "too_big");
  assert.equal(decodeTextPayload("data:text/html;base64,!!!!", 14), null);
});
