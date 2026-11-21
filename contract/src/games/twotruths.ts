// Two Truths and a Lie (worker/games/twotruths.js: ttSummary, ttStateFull,
// ttResolve, ttAdvance): a rotating storyteller writes three statements,
// one a lie, and everyone else votes for the lie.

import type { GamePlayerBase, GameYouBase, RotatingRoundsStateBase } from "./common";

/** A seat (ttSummary's players). */
export interface TwoTruthsPlayer extends GamePlayerBase {
  accepted: boolean;
  /** Points so far. */
  score: number;
  /** Lies spotted so far. */
  spots: number;
  /** In a vote: this player has voted (which card stays sealed). While the
   *  storyteller writes: true for everyone but the storyteller. */
  committed: boolean;
}

/** A settled round (ttResolve; ttAdvance pushes the forfeit form). */
export interface TwoTruthsRound {
  n: number;
  teller: string;
  /** The three statements as the table saw them; null on a forfeit. */
  statements: string[] | null;
  /** Which statement (1-3) was the lie; null on a forfeit. */
  lie: number | null;
  /** Each voter's pick (1-3), null for one who did not vote. */
  votes: Record<string, number | null>;
  /** Who spotted the lie. */
  right: string[];
  /** How many voters picked a truth. */
  fooled: number;
  points: Record<string, number>;
  /** How long each right voter took, in ms (a tiebreak). */
  vote_ms: Record<string, number>;
  /** Voters who did not vote. */
  missed: string[];
  /** The storyteller ran out of time to write. */
  forfeit: boolean;
  /** A roast when every vote cast found the lie, else null. */
  note: string | null;
  at: number;
}

/** The viewer's block (ttStateFull's you). */
export interface TwoTruthsYou extends GameYouBase {
  /** Whether the viewer tells this round. */
  teller?: boolean;
  /** The storyteller only, once written: their statements, shuffled... */
  statements?: string[];
  /** ...and which of them (1-3) is the lie. */
  lie?: number;
  /** A voter in the vote: their pick so far (1-3), or null. */
  vote?: number | null;
}

/** ttSummary, plus ttStateFull's rounds, log, awaiting and you. */
export interface TwoTruthsState extends RotatingRoundsStateBase<"twotruths"> {
  /** Null unless the match is running. */
  phase: "write" | "vote" | null;
  /** This round's storyteller; null unless the match is running. */
  teller: string | null;
  round_seconds: number;
  /** The statements up for the vote (shuffled), else null. */
  statements: string[] | null;
  last_round: TwoTruthsRound | null;
  players: TwoTruthsPlayer[];
  rounds?: TwoTruthsRound[];
  you?: TwoTruthsYou;
}
