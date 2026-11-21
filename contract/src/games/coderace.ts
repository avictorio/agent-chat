// Code Race (worker/games/coderace.ts: crSummary, crStateFull,
// crResolveRound, crFeedback): everyone cracks the same secret at once,
// one sealed guess a round - a code of coloured pegs, or a word.

import type { GamePlayerBase, GameStateBase, GameYouBase } from "./common";

/** One colour a code is drawn from (CR_PALETTE). */
export interface CodeRaceColor {
  /** The key letter a guess uses (R, G, B, ...). */
  k: string;
  name: string;
  hex: string;
}

/** A guess's score (crFeedback): in colors mode [black, white] (right
 *  place, right colour elsewhere); in words mode a mark per letter, G
 *  (right place), Y (in the word, elsewhere) or . (not in it), e.g. "GY..G". */
export type CodeRaceFeedback = [number, number] | string;

/** A racer (crSummary's players). */
export interface CodeRacePlayer extends GamePlayerBase {
  accepted: boolean;
  /** Whether this racer's guess for the round is in (it stays secret). */
  committed: boolean;
  /** The round this racer cracked it in, or null. */
  solved: number | null;
  /** Dropped after three missed rounds in a row. */
  out: boolean;
  /** Guesses sent so far. */
  guesses: number;
  /** The closest guess so far (crScore's close: greens or black pegs x10,
   *  plus yellows or white pegs). */
  best: number;
}

/** A guess in a resolved round, as this viewer may see it (crStateFull): a
 *  rival's carries only its feedback while the race runs. */
export interface CodeRaceGuess {
  /** The guess: the word, or the code's key letters ("RGBY"). Your own, or
   *  everyone's once the race is over. */
  guess?: string;
  fb: CodeRaceFeedback;
  /** When it was sent (with guess). */
  at?: number;
}

/** A resolved round (crResolveRound). */
export interface CodeRaceRound {
  n: number;
  at: number;
  /** The round's guesses by racer; one who sent none is missing. */
  guesses: Record<string, CodeRaceGuess>;
  /** Who cracked it this round. */
  solved: string[];
  /** Racers still racing who sent no guess. */
  missed: string[];
  /** Who was dropped this round (a third missed round in a row). */
  dropped: string[];
}

/** The viewer's block (crStateFull's you). */
export interface CodeRaceYou extends GameYouBase {
  /** Your guess for the round, once sent (the word or the key letters). */
  queued?: string | null;
  /** The round you cracked it in. */
  solved?: number | null;
  out?: boolean;
}

export interface CodeRaceState extends GameStateBase<"coderace"> {
  round: number;
  max_rounds: number;
  round_seconds: number;
  mode: "colors" | "words";
  /** Pegs in the code, or letters in the word. */
  length: number;
  /** How many colours a code is drawn from; null in words mode. */
  colors: number | null;
  /** Those colours; null in words mode. */
  palette: CodeRaceColor[] | null;
  /** The finishing order, set when the race ends. */
  places: string[] | null;
  /** The secret once the race is over (the word, or the code's key letters
   *  one per item); null before. */
  secret: string | string[] | null;
  players: CodeRacePlayer[];
  rounds?: CodeRaceRound[];
  you?: CodeRaceYou;
}
