// The games' draws (worker/lib/random.ts) come from the system's generator
// and favour no outcome. Math.random's next values can be worked out from
// the ones a game shows a player; scripts/check-worker.js keeps it out of
// worker/ altogether.
import test from "node:test";
import assert from "node:assert/strict";
import { coin, randFloat, randInt } from "../../worker/lib/random.ts";

test("randInt stays in range and favours no value", () => {
  for (const n of [1, 2, 3, 6, 7, 10, 52, 1000]) {
    const seen = new Array(n).fill(0);
    const draws = n * 3000;
    for (let i = 0; i < draws; i++) {
      const v = randInt(n);
      assert.ok(Number.isInteger(v) && v >= 0 && v < n, n + " gave " + v);
      seen[v]++;
    }
    // each count within 6 standard deviations of its share
    const mean = draws / n, sd = Math.sqrt(draws * (1 / n) * (1 - 1 / n));
    for (const c of seen) assert.ok(Math.abs(c - mean) <= 6 * sd + 1, n + ": a value came up " + c + " times of " + draws);
  }
  assert.equal(randInt(0), 0);
  assert.equal(randInt(-3), 0);
  assert.equal(randInt(NaN), 0);
  assert.equal(randInt(1.9), 0);
});

test("randInt draws again instead of folding the uneven tail onto the low numbers", () => {
  const real = crypto.getRandomValues;
  // with 3 choices the last whole multiple is 4294967295: only 4294967295 itself must be thrown away
  const feed = [0xffffffff, 0xffffffff, 0xfffffffe, 5];
  let asked = 0;
  crypto.getRandomValues = (a) => { a[0] = feed[asked++]; return a; };
  try {
    assert.equal(randInt(3), 0xfffffffe % 3);
    assert.equal(asked, 3, "the two values past the limit were drawn again");
    assert.equal(randInt(3), 2);
  } finally { crypto.getRandomValues = real; }
});

test("randFloat is in [0, 1) and coin lands both ways", () => {
  let lo = 1, hi = 0, heads = 0;
  for (let i = 0; i < 20000; i++) {
    const f = randFloat();
    assert.ok(f >= 0 && f < 1);
    lo = Math.min(lo, f); hi = Math.max(hi, f);
    heads += coin() ? 1 : 0;
  }
  assert.ok(lo < 0.01 && hi > 0.99, "spread " + lo + " to " + hi);
  assert.ok(heads > 9400 && heads < 10600, heads + " heads of 20000");
  const real = crypto.getRandomValues;
  crypto.getRandomValues = (a) => a.fill(0xffffffff);
  try { assert.ok(randFloat() < 1, "the largest draw is still under 1"); } finally { crypto.getRandomValues = real; }
});
