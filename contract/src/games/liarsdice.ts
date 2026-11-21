// Liar's Dice (worker/games/liarsdice.ts: ldSummary, ldStateFull, ldMove,
// ldEndRound, ldAdvance; turns by turnsNext in worker/room/games.ts):
// hidden cups of dice, rising bids on the whole table, call liar.

import type { GamePlayerBase, GameStateBase, GameYouBase } from "./common";

/** A player at the table (ldSummary's players). */
export interface LiarsDicePlayer extends GamePlayerBase {
  accepted: boolean;
  /** Dice left in their cup. */
  dice: number;
  /** Out of dice (or timed out three turns in a row). */
  out: boolean;
  /** Turns timed out in a row (three put them out). */
  timeouts: number;
}

/** A bid (ldMove): at least qty dice on the table show face. */
export interface LiarsDiceBid {
  by: string;
  qty: number;
  face: number;
  at: number;
}

/** A call of liar (ldMove): who called it, on which bid. */
export interface LiarsDiceCall {
  by: string;
  bid: LiarsDiceBid;
}

/** A closed round (ldEndRound, with ldMove's or ldAdvance's reason). */
export interface LiarsDiceRound {
  n: number;
  /** Every cup still in the round, opened (sorted). */
  cups: Record<string, number[]>;
  /** The round's bids, in order. */
  bids: LiarsDiceBid[];
  /** "call": someone called liar; "timeout": the turn ran out (a die
   *  lost); "forfeit": a third timeout in a row (out). */
  reason: "call" | "timeout" | "forfeit";
  /** Call rounds only. */
  call?: LiarsDiceCall;
  /** Call rounds only: the called face and how many dice counted for it. */
  face?: number;
  count?: number;
  /** Call rounds only: whether the bid held (then the caller loses). */
  stands?: boolean;
  /** Who lost a die (or their seat). */
  loser: string;
  /** Whether the loser is out. */
  out: boolean;
  /** The loser's dice left. */
  dice_left: number;
  at: number;
}

/** The viewer's block (ldStateFull's you). */
export interface LiarsDiceYou extends GameYouBase {
  /** Your cup (sorted); empty once the match is over. */
  dice?: number[];
  out?: boolean;
  your_turn?: boolean;
  timeouts?: number;
}

export interface LiarsDiceState extends GameStateBase<"liarsdice"> {
  turn: number;
  round: number;
  /** Whose move it is; null unless running. */
  turn_of: string | null;
  turn_seconds: number;
  /** Dice per cup at the start. */
  dice_each: number;
  /** A 1 counts as every face (bids name faces 2-6). */
  ones_wild: boolean;
  /** Dice left on the whole table. */
  dice_total: number;
  /** The seats still in, in turn order. */
  order: string[];
  /** The standing bid this round, or null. */
  bid: LiarsDiceBid | null;
  /** This round's bids so far. */
  bids: LiarsDiceBid[];
  /** The latest closed round, or null. */
  last_round: LiarsDiceRound | null;
  /** Always false: a match ends with one player left. */
  draw: boolean;
  /** The finishing order, set when the match ends. */
  places: string[] | null;
  /** Who timed out of the match (the first to), or null. */
  forfeit: string | null;
  players: LiarsDicePlayer[];
  rounds?: LiarsDiceRound[];
  you?: LiarsDiceYou;
}
