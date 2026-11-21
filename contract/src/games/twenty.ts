// Twenty Questions (worker/games/twenty.ts: tqSummary, tqStateFull,
// tqMove, tqEndRound): each round a rotating answerer holds a secret and
// the others get twenty yes-or-no questions to name it.

import type { GamePlayerBase, GameYouBase, RotatingRoundsStateBase } from "./common";

/** A seat (tqSummary's players). */
export interface TwentyPlayer extends GamePlayerBase {
  /** Points over the finished rounds. */
  score: number;
  /** Questions this player asked this round (flagged ones not counted). */
  asked: number;
}

/** One question or guess in a round's public Q/A log (tqMove). */
export interface TwentyQuestion {
  /** Its number in the round, from 1 (flagged ones included). */
  n: number;
  by: string;
  /** q: a yes/no question; guess: "guess: X". */
  kind: "q" | "guess";
  q: string;
  /** yes / no for a question, right / wrong for a guess; null while it waits, or once flagged. */
  a: "yes" | "no" | "right" | "wrong" | null;
  /** The answerer's note after a dash, if any. */
  note: string | null;
  /** Flagged as unanswerable: it costs nothing. */
  flagged: boolean;
  /** Present (true) on an exact guess, right on its own. */
  auto?: boolean;
  at: number;
}

/** A finished round (tqEndRound). */
export interface TwentyRound {
  n: number;
  answerer: string;
  secret: string;
  /** Drawn from the deck ("random", or the clock ran out) rather than chosen. */
  drawn: boolean;
  qa: TwentyQuestion[];
  /** Questions spent, guesses included (flagged ones not). */
  asked: number;
  /** Who scored. */
  side: "answerer" | "questioners";
  /** guessed: named; budget: twenty spent; forfeit: the answerer went silent; idle: three clocks with no question. */
  how: "guessed" | "budget" | "forfeit" | "idle";
  guessed_by: string | null;
  points: Record<string, number>;
  at: number;
}

/** The viewer's block (tqStateFull); a spectator gets only `playing`. */
export interface TwentyYou extends GameYouBase {
  /** Players: whether you answer this round (running only). */
  answerer?: boolean;
  /** The answerer only: your secret, null until chosen. */
  secret?: string | null;
}

/** tqSummary, plus tqStateFull's rounds, log, awaiting and you. */
export interface TwentyState extends RotatingRoundsStateBase<"twenty"> {
  /** secret: the answerer is choosing; ask: the table may ask; answer: a question waits. Null unless running. */
  phase: "secret" | "ask" | "answer" | null;
  /** This round's answerer; null unless running. */
  answerer: string | null;
  round_seconds: number;
  /** Questions a round (20). */
  budget: number;
  /** Questions spent this round. */
  asked: number;
  remaining: number;
  /** duel with two players, table with more. */
  mode: "duel" | "table";
  /** This round's questions and guesses so far (the last round's once finished). */
  qa: TwentyQuestion[];
  /** The question waiting on the answerer, if any. */
  pending: TwentyQuestion | null;
  last_round: TwentyRound | null;
  players: TwentyPlayer[];
  rounds?: TwentyRound[];
  you?: TwentyYou;
}
