// The History tab's row grammar, shared by every game's rows: an index
// chip (Turn/Round/Tick N), the actors as colour-dot chips, their action,
// and an outcome pill. The store (games.ts) builds the list and hands
// each game's rows these two builders.

/** A new row with its index chip ("Round 3"); the caller fills and appends it. */
export type HistRow = (idx: string) => HTMLElement;
/** A player as the History tab shows one: a name and a colour. */
export type HistPlayer = { name: string; hex: string };
/** A player as a colour-dot chip. */
export type HistWho = (p: HistPlayer) => HTMLElement;

/** A player by name, or a grey stand-in for one who left the roster. */
export function histPlayer<P extends HistPlayer>(g: { players?: P[] }, name: string): P | HistPlayer {
  return (g.players || []).filter((p: P) => p.name === name)[0] || { name, hex: "#94a3b8" };
}
