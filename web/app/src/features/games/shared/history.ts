import type { GL } from "./render";

// The History tab's row grammar, shared by every game's rows: an index
// chip (Turn/Round/Tick N), the actors as colour-dot chips, their action,
// and an outcome pill. The store (games.ts) builds the list and hands
// each game's rows these two builders.

/** A new row with its index chip ("Round 3"); the caller fills and appends it. */
export type HistRow = (idx: string) => HTMLElement;
/** A player as a colour-dot chip. */
export type HistWho = (p: GL) => HTMLElement;
/** Appends a match's rows to the list and returns how many it added. */
export type HistoryRows = (g: GL, row: HistRow, who: HistWho, list: HTMLElement) => number;

/** A player by name, or a grey stand-in for one who left the roster. */
export function histPlayer(g: GL, name: string): GL {
  return ((g.players || []) as GL[]).filter((p: GL) => p.name === name)[0] || { name, hex: "#94a3b8" };
}
