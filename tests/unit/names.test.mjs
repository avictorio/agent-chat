// Member names as stored (worker/lib/text.ts): the string checked for
// uniqueness must be the string the database keeps, or two invites end
// up under one name - one seat in every match.
import test from "node:test";
import assert from "node:assert/strict";
import { MAX_NAME, cleanName, memberNameProblem, nameFold } from "../../worker/lib/text.ts";

test("cleanName never cuts through a character", () => {
  const long = "a".repeat(MAX_NAME - 1) + "\u{1F600}tail";
  const cut = cleanName(long);
  assert.equal(cut, "a".repeat(MAX_NAME - 1), "the emoji that does not fit is left out whole");
  assert.ok(cut.isWellFormed());
  assert.equal(cleanName("a".repeat(MAX_NAME - 2) + "\u{1F600}x"), "a".repeat(MAX_NAME - 2) + "\u{1F600}", "one that fits stays");
  assert.equal(cleanName("b".repeat(MAX_NAME + 5)).length, MAX_NAME);
  // what storage does to the string must change nothing
  for (const s of [long, "\u{1F468}‍\u{1F469}‍\u{1F467}".repeat(9), "é".repeat(30)]) {
    const c = cleanName(s);
    assert.equal(new TextDecoder().decode(new TextEncoder().encode(c)), c);
    assert.ok(c.length <= MAX_NAME);
  }
});

test("cleanName makes every run of whitespace one space", () => {
  assert.equal(cleanName("  Ann   Lee "), "Ann Lee");
  assert.equal(cleanName("Ann Lee"), "Ann Lee");
  assert.equal(cleanName("Ann\t\n Lee"), "Ann Lee");
  assert.equal(cleanName("Ann　 Lee"), "Ann Lee");
  assert.equal(cleanName("x".repeat(MAX_NAME - 1) + " y"), "x".repeat(MAX_NAME - 1), "no space left hanging at the cut");
  assert.equal(cleanName(null), "");
  assert.equal(cleanName("   "), "");
});

test("a name with half a character is refused", () => {
  assert.ok(memberNameProblem("abc\uD83D"), "a lone high surrogate");
  assert.ok(memberNameProblem("\uDE00abc"), "a lone low surrogate");
  assert.ok(memberNameProblem("abc�"), "the replacement character storage would write");
  assert.equal(memberNameProblem("abc\u{1F600}"), null, "a whole emoji is fine");
  assert.equal(memberNameProblem("José 李"), null);
});

test("the lunate sigmas fold apart but lower-case alike (why invite() checks both)", () => {
  const upper = "Ϲarol", lower = "ϲarol";
  assert.notEqual(nameFold(upper), nameFold(lower));
  assert.equal(upper.toLowerCase(), lower.toLowerCase());
});
