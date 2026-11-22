/* A number per match object, for keying a chat card's board. A board
   keyed by it is built afresh for each new match object, which is what
   replays its entrance animations (Battleship's last-shot ribbon and a
   sinking's flash, a Light Cycles trail's draw-in and the head's
   spark) when the match moves. */
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
