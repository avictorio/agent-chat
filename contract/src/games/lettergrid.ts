// Letter Grid (worker/games/lettergrid.js: lgSummary, lgStateFull,
// lgResolveRound, lgParse): everyone traces one secret word a round through
// the same grid of letters; a word scores its letters plus every free cell
// it claims first.

import type { GamePlayerBase, GameStateBase, GameYouBase } from "./common";

/** A cell as [row, col], counted from 0. */
export type LetterGridCell = [number, number];

/** A seat (lgSummary's players). */
export interface LetterGridPlayer extends GamePlayerBase {
  accepted: boolean;
  /** Whether this player's word for the round is in (it stays sealed). */
  committed: boolean;
  score: number;
  /** Cells claimed so far. */
  cells: number;
  /** Their longest word so far. */
  longest: string | null;
  /** Out after three missed rounds in a row (the score stands). */
  out: boolean;
}

/** A word as a round played it (lgResolveRound's words). */
export interface LetterGridWord {
  word: string;
  path: LetterGridCell[];
  /** Points for the letters (the word's length). */
  letters: number;
  /** Points for the cells it claimed (one each). */
  bonus: number;
  /** The cells it claimed, as indexes row * size + col. */
  claimed: number[];
  /** Free cells another word also took first this round (they stay free). */
  contested: number[];
  /** The same word from two players: letters only, no claims. */
  dup: boolean;
  /** When it was sent. */
  at: number;
}

/** A resolved round (lgResolveRound's entry). */
export interface LetterGridRound {
  n: number;
  at: number;
  /** Each player's word by name; missing for one who sent none. */
  words: Record<string, LetterGridWord>;
  /** Who sent no word. */
  missed: string[];
  /** Who went out this round (a third missed round in a row). */
  dropped: string[];
  points: Record<string, number>;
  /** Everyone's total after the round. */
  totals: Record<string, number>;
}

/** A sealed word (lgParse's result, held until the round resolves). */
export interface LetterGridMove {
  word: string;
  path: LetterGridCell[];
}

/** The viewer's block (lgStateFull's you). */
export interface LetterGridYou extends GameYouBase {
  /** Your word for the round, once sent. */
  queued?: LetterGridMove | null;
  out?: boolean;
  /** Your words so far (your own cannot repeat). */
  played?: string[];
}

/** lgSummary, plus lgStateFull's rounds, log, awaiting and you. */
export interface LetterGridState extends GameStateBase<"lettergrid"> {
  round: number;
  rounds_total: number;
  round_seconds: number;
  /** Rows and columns (4 to 6). */
  size: number;
  /** The fewest letters a word may have. */
  min_len: number;
  /** The rows of letters (lowercase), top first. */
  grid: string[];
  /** Each cell's owner, row by row (index row * size + col); null while free. */
  claims: Array<string | null>;
  /** How many dictionary words the grid holds. */
  word_count: number;
  /** The grid's longest words, once the match is over; else null. */
  top_words: string[] | null;
  draw: boolean;
  places: string[] | null;
  players: LetterGridPlayer[];
  rounds?: LetterGridRound[];
  you?: LetterGridYou;
}
