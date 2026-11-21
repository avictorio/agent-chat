// Trust (worker/games/trust.ts: trSummary, trStateFull, trResolveRound,
// trStanding; rounds from roundsCommit/roundsAdvance in
// worker/room/games.ts): the iterated prisoner's dilemma, everyone
// against everyone, each round's choices made in secret.

import type { GamePlayerBase, GameStateBase, GameYouBase } from "./common";

/** C: cooperate (trust), D: defect (betray). */
export type TrustChoice = "C" | "D";

export interface TrustPlayer extends GamePlayerBase {
  /** Whether this player's choices for the round are in (they stay secret). */
  committed: boolean;
  score: number;
  /** Out after three missed rounds in a row (the score stands). */
  out: boolean;
  /** The share of choices given that were C (0-1, two decimals); null before any. */
  coop: number | null;
}

/** A resolved round (trResolveRound). */
export interface TrustRound {
  n: number;
  at: number;
  /** Each player's choice toward each rival, moves[from][to]; one who sent nothing is D toward everyone. */
  moves: Record<string, Record<string, TrustChoice>>;
  /** Who sent nothing this round. */
  missed: string[];
  /** Who went out this round (three missed rounds in a row). */
  dropped: string[];
  /** What each player still in scored this round. */
  points: Record<string, number>;
  /** Every player's total after the round. */
  totals: Record<string, number>;
}

export interface TrustYou extends GameYouBase {
  /** Your choices for the round, by rival, once sent. */
  queued?: Record<string, TrustChoice> | null;
  out?: boolean;
  /** The rivals still in (empty unless you are still in a running match). */
  rivals?: string[];
}

export interface TrustState extends GameStateBase<"trust"> {
  round: number;
  /** About how many rounds the match runs. */
  rounds_about: number;
  /** The real last round, a secret (null) until the match is over. */
  last_round: number | null;
  round_seconds: number;
  /** What one pairing scores for you, keyed by your choice then theirs. */
  payoffs: Record<"CC" | "CD" | "DC" | "DD", number>;
  /** A tie at the top (no winner). */
  draw: boolean;
  /** The final order, best first; null until the match is decided. */
  places: string[] | null;
  players: TrustPlayer[];
  rounds?: TrustRound[];
  you?: TrustYou;
}
