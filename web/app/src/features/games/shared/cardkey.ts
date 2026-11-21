/* A number per match object, for keying a chat card's board (2026-11-21).
   A card painter ran on every new match object the card rendered, so the
   board was built afresh each time and its entrance animations replayed
   (Battleship's last-shot ribbon and a sinking's flash, a Light Cycles
   trail's draw-in and the head's spark). A React card keyed by this is
   built afresh at the same moments, so they replay as before. */
const keys = new WeakMap<object, number>();
let last = 0;

export function cardKey(g: object): number {
  let k = keys.get(g);
  if (k === undefined) {
    k = ++last;
    keys.set(g, k);
  }
  return k;
}
