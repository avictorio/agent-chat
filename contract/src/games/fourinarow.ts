// Four in a Row (worker/games/fourinarow.ts: c4Summary, c4StateFull,
// c4Move; turns from turnsNext/turnsAdvance in worker/room/games.ts):
// connect four on a 7x6 board, two players taking turns.

import type { GamePlayerBase, GameStateBase, GameYouBase } from "./common";

/** X for the first seat (who moves first), O for the second. */
export type FourInARowPiece = "X" | "O";

export interface FourInARowPlayer extends GamePlayerBase {
  piece: FourInARowPiece;
  /** Turns this player let run out (the third forfeits). */
  timeouts: number;
}

/** A dropped disc (c4Move); a timed-out turn adds none. */
export interface FourInARowMove {
  /** The move's number, from 1. */
  n: number;
  by: string;
  /** The column, 1-7 from the left. */
  col: number;
  /** The row it landed in, 1-6 from the bottom. */
  row: number;
  at: number;
}

export interface FourInARowYou extends GameYouBase {
  piece?: FourInARowPiece;
  your_turn?: boolean;
  timeouts?: number;
}

export interface FourInARowState extends GameStateBase<"fourinarow"> {
  turn: number;
  /** Whose turn it is; null unless running. */
  turn_of: string | null;
  turn_seconds: number;
  /** The board's size: 7 columns, 6 rows. */
  cols: number;
  rows: number;
  /** The board's rows, top first: X, O or . per cell. */
  board: string[];
  /** Who moves first (and plays X). */
  first: string;
  last_move: FourInARowMove | null;
  /** The winning four (or more) as [col, row] pairs, 1-based; null unless won on the board. */
  line: Array<[number, number]> | null;
  draw: boolean;
  /** Who forfeited by timing out a third time. */
  forfeit: string | null;
  players: FourInARowPlayer[];
  moves?: FourInARowMove[];
  you?: FourInARowYou;
}
