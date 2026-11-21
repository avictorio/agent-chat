// Frontlines (worker/games/frontlines.ts: flSummary, flStateFull,
// flResolveRound): two generals split their troops over five hills each
// round; the bigger force takes a hill.

import type { GamePlayerBase, GameStateBase, GameYouBase } from "./common";

export interface FrontlinesPlayer extends GamePlayerBase {
  /** Rounds won. */
  wins: number;
  /** Whether this player's split for the round is in (it stays secret). */
  committed: boolean;
}

/** A resolved round. */
export interface FrontlinesRound {
  n: number;
  /** Each general's split, hill A-E; missing for one who forfeited. */
  alloc: Record<string, number[]>;
  alloc_at: Record<string, number | null>;
  /** Who took each hill (null: a tie); null when the round was a forfeit. */
  hills: Array<string | null> | null;
  held: Record<string, number>;
  points: Record<string, number>;
  /** The hills' values in the valued variant, else null. */
  values: number[] | null;
  winner: string | null;
  forfeit: string | null;
  at: number;
}

export interface FrontlinesYou extends GameYouBase {
  /** Your split for the round, once sent. */
  queued?: number[] | null;
}

export interface FrontlinesState extends GameStateBase<"frontlines"> {
  round: number;
  best_of: number;
  target: number;
  round_seconds: number;
  variant: "classic" | "valued";
  /** The number of hills (5). */
  hills: number;
  /** Troops per round (100). */
  troops: number;
  /** The current round's hill values in the valued variant. */
  values: number[] | null;
  score: Record<string, number>;
  players: FrontlinesPlayer[];
  rounds?: FrontlinesRound[];
  you?: FrontlinesYou;
}
