// Sketch & Guess (worker/games/sketch.ts: sgSummary, sgStateFull,
// sgRoundOut, sgResolve, sgAdvance): each round a rotating artist draws a
// secret prompt; everyone else guesses what it shows, and the Referee
// (Claude) rules on close calls.

import type { GamePlayerBase, GameYouBase, RotatingRoundsStateBase } from "./common";

/** A seat (sgSummary's players). */
export interface SketchPlayer extends GamePlayerBase {
  score: number;
  /** Exact guesses so far (the first tiebreak). */
  exact: number;
  /** Guess phase: whether this player's guess is in (it stays sealed). Other phases of a running match: true for all but the artist. */
  committed: boolean;
}

/** A round's drawing, served at a signed URL (sgImageUrl). */
export interface SketchImage {
  /** Null only if the room's name is unknown to the server. */
  url: string | null;
  /** image/png, image/jpeg, image/gif or image/webp. */
  type: string;
}

/** One guess in a resolved round (sgResolve). */
export interface SketchGuess {
  guess: string;
  right: boolean;
  /** Equal to the prompt once folded (not merely one letter off). */
  exact: boolean;
  /** match: the text match decided; referee: Claude did. */
  how: "match" | "referee";
  at: number;
  /** Milliseconds from the drawing going up to the guess. */
  ms: number;
}

/** A resolved round (sgResolve) or a forfeit (sgAdvance: no drawing in time), with its image (sgRoundOut). */
export interface SketchRound {
  n: number;
  artist: string;
  prompt: string;
  /** Each guesser's guess; none for one who sent nothing. */
  guesses: Record<string, SketchGuess>;
  right: string[];
  missed: string[];
  points: Record<string, number>;
  /** referee: Claude judged the close calls; match: the text match alone; null on a forfeit. */
  judge: "referee" | "match" | null;
  /** Why Claude did not judge (daily_cap, stalled, an API error, bad_verdict: an answer naming a guess it was not sent), else null. */
  judge_note: string | null;
  /** When nobody got it: Claude's roast, or a stock one; else null. */
  roast: string | null;
  forfeit: boolean;
  at: number;
  image: SketchImage | null;
}

/** The viewer's block (sgStateFull); a spectator gets only `playing`. */
export interface SketchYou extends GameYouBase {
  /** Players: whether you are this round's artist (running only). */
  artist?: boolean;
  /** The artist only: the secret prompt. */
  prompt?: string | null;
  /** A guesser in the guess phase: your sealed guess, or null. */
  queued?: string | null;
}

/** sgSummary, plus sgStateFull's rounds, log, awaiting and you. */
export interface SketchState extends RotatingRoundsStateBase<"sketch"> {
  /** draw: the artist is drawing; guess: guesses come in; judging: the Referee is ruling. Null unless running. */
  phase: "draw" | "guess" | "judging" | null;
  /** This round's artist; null unless running. */
  artist: string | null;
  /** This round's drawing once it is up; null unless running. */
  image: SketchImage | null;
  draw_seconds: number;
  guess_seconds: number;
  last_round: SketchRound | null;
  players: SketchPlayer[];
  rounds?: SketchRound[];
  you?: SketchYou;
}
