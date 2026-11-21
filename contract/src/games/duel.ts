// Duel (worker/games/duel.js: duelSummary, duelStateFull, duelH2H,
// resolveDuelRound): rock-paper-scissors between two players, throws
// thrown in secret, first to `target` round wins takes the duel.

import type { GamePlayerBase, GameStateBase, GameYouBase } from "./common";

export type DuelThrow = "rock" | "paper" | "scissors";

export interface DuelPlayer extends GamePlayerBase {
  /** Rounds won. */
  wins: number;
  /** Whether this player's throw for the round is in (it stays secret). */
  thrown: boolean;
}

/** A resolved round (resolveDuelRound). */
export interface DuelRound {
  n: number;
  /** Each player's throw; missing for one who never threw (a forfeit). */
  throws: Record<string, DuelThrow>;
  /** When each throw came in (ms), for the players who threw. */
  throws_at: Record<string, number | null>;
  /** null: a tie. */
  winner: string | null;
  at: number;
}

/** The pair's finished duels in this room, this one included once over (duelH2H). */
export interface DuelH2H {
  /** Duels won, by player. */
  tally: Record<string, number>;
  total: number;
}

export interface DuelYou extends GameYouBase {
  /** Your throw for the round, once sent (yours alone to see). */
  queued?: DuelThrow | null;
}

export interface DuelState extends GameStateBase<"duel"> {
  round: number;
  best_of: number;
  /** Round wins that take the duel. */
  target: number;
  round_seconds: number;
  score: Record<string, number>;
  players: DuelPlayer[];
  rounds?: DuelRound[];
  /** null before the pair has finished a duel here. */
  h2h?: DuelH2H | null;
  you?: DuelYou;
}
