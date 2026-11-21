// Trivia (worker/games/trivia.js: tvSummary, tvStateFull, tvResolve,
// tvAdvance): each round a rotating quizmaster asks a question of their
// own; everyone else answers it and wagers on being right.

import type { GamePlayerBase, GameYouBase, RotatingRoundsStateBase } from "./common";

/** A seat (tvSummary's players). */
export interface TriviaPlayer extends GamePlayerBase {
  /** Points held; everyone starts with `start` (100). */
  balance: number;
  /** Answers right and wrong so far. */
  right: number;
  wrong: number;
  /** Answer phase: whether this player's answer is in (it stays sealed). Other phases of a running match: true for all but the quizmaster. */
  committed: boolean;
}

/** One answer in a resolved round (tvResolve). */
export interface TriviaAnswer {
  answer: string;
  /** The wager as it counted (capped by the balance). */
  wager: number;
  right: boolean;
  /** Right on the quizmaster's call, not the text match. */
  judged: boolean;
  at: number;
}

/** A resolved round (tvResolve), or a forfeit (tvAdvance: the quizmaster ran out of time to ask). */
export interface TriviaRound {
  n: number;
  asker: string;
  /** Null on a forfeit, as is answer. */
  question: string | null;
  answer: string | null;
  /** The other ways to say the answer, given with the question. */
  accept: string[];
  /** Each answerer's answer; none for one who sent nothing. */
  answers: Record<string, TriviaAnswer>;
  right: string[];
  wrong: string[];
  /** Answerers who sent nothing. */
  missed: string[];
  /** Each answerer's swing and the quizmaster's bonus; empty on a forfeit. */
  deltas: Record<string, number>;
  /** The table split (someone right, someone wrong): the quizmaster scores the bonus. */
  split: boolean;
  bonus: number;
  /** Every balance after the round. */
  totals: Record<string, number>;
  forfeit: boolean;
  at: number;
}

/** Your sealed answer (tvStateFull's you.queued). */
export interface TriviaQueued {
  answer: string;
  wager: number;
  at: number;
}

/** An answer the text match did not take, for the quizmaster to judge (tvStateFull). */
export interface TriviaToJudge {
  name: string;
  answer: string;
  /** Already accepted by the quizmaster. */
  accepted: boolean;
}

/** The viewer's block (tvStateFull); a spectator gets only `playing`. */
export interface TriviaYou extends GameYouBase {
  /** Players: whether you are this round's quizmaster (running only). */
  asker?: boolean;
  /** Players: your balance. */
  balance?: number;
  /** Players: the most you may wager now (the cap, or your balance if lower). */
  max_wager?: number;
  /** The quizmaster, once the question is in: its sealed answer and variants. */
  answer?: string;
  accept?: string[];
  /** The quizmaster in the judge phase: the answers to rule on. */
  to_judge?: TriviaToJudge[];
  /** An answerer in the answer phase: your sealed answer, or null. */
  queued?: TriviaQueued | null;
}

/** tvSummary, plus tvStateFull's rounds, log, awaiting and you. */
export interface TriviaState extends RotatingRoundsStateBase<"trivia"> {
  /** ask: the quizmaster writes; answer: answers and wagers come in; judge: the quizmaster rules on answers the match missed. Null unless running. */
  phase: "ask" | "answer" | "judge" | null;
  /** This round's quizmaster; null unless running. */
  asker: string | null;
  /** The question once asked; null unless running. */
  question: string | null;
  round_seconds: number;
  /** The starting balance (100). */
  start: number;
  /** The wager cap (25). */
  max_wager: number;
  /** The quizmaster's bonus when the table splits (10). */
  split_bonus: number;
  last_round: TriviaRound | null;
  players: TriviaPlayer[];
  rounds?: TriviaRound[];
  you?: TriviaYou;
}
