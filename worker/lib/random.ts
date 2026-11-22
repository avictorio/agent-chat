// Chance for the games and anything else a player must not be able to
// predict.
//
// Math.random is not that. V8's generator is rebuilt from a handful of its
// outputs, and one isolate serves many rooms: a draw the game shows a
// player (Code Race's "random" guess prints several) gave them those
// outputs, and from them the next hidden draw in any match - Trust's last
// round, Werewolf's roles, a secret word, a shuffled deck. So nothing in
// worker/ calls Math.random (scripts/check-worker.js refuses it); every
// draw comes from the system's generator through these.

const word = new Uint32Array(1);

/** A whole number from 0 up to, not including, n; each equally likely. 0 when n is not at least 1. */
export function randInt(n: number): number {
  const size = Math.floor(n);
  if (!(size >= 1)) return 0;
  if (size > 0x100000000) throw new RangeError("randInt: more than 2^32 choices");
  // the values past the last whole multiple of `size` would favour the low numbers: draw again
  const limit = 0x100000000 - (0x100000000 % size);
  for (;;) {
    crypto.getRandomValues(word);
    if (word[0] < limit) return word[0] % size;
  }
}

/** A number from 0 up to, not including, 1. */
export function randFloat(): number {
  const two = crypto.getRandomValues(new Uint32Array(2));
  // 53 bits, all a double holds: 21 from one word above 32 from the other
  return ((two[0] >>> 11) * 0x100000000 + two[1]) / 0x20000000000000;
}

/** True half the time. */
export function coin(): boolean {
  return randInt(2) === 1;
}
