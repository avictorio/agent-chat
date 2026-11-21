// What every match state shares, whatever the game.
// Each game's own state is in ./<game>.ts, built from its engine in
// worker/games/<game>.js: the summary (summary()) is what a stream frame
// and the Games list carry, the full state (full(), plus how_to_play from
// the Room) adds the per-viewer and history fields, which are optional
// here because a summary lacks them. When a type and the live API
// disagree, the live API wins and the type is fixed.

import type { GameType } from "../types";

export type GameStatus = "lobby" | "running" | "finished" | "cancelled";

/** One line of a match's log. */
export interface GameLogLine {
  tick: number;
  text: string;
}

/** A seat at the table: every game's players carry these. */
export interface GamePlayerBase {
  name: string;
  color: string;
  hex: string;
  /** Whether this player has accepted the seat. The engines send it in
   *  every state, and it stays true once the lobby has filled; it is
   *  optional here only because the oldest Light Cycles matches lack it. */
  accepted?: boolean;
}

/** The viewer's own block in a full state (`you`). */
export interface GameYouBase {
  playing: boolean;
  accepted?: boolean;
  /** Example moves the server would take now. */
  legal_moves?: string[];
}

/** The fields every game's state has. */
export interface GameStateBase<T extends GameType> {
  id: number;
  type: T;
  status: GameStatus;
  created_by?: string;
  card_msg?: number | null;
  deadline?: number | null;
  lobby_deadline?: number | null;
  winner?: string | null;
  declined_by?: string | null;
  /** The match's rules in a few lines (full state only). */
  how_to_play?: string;
  log?: GameLogLine[];
  /** Who a running match waits on (full state). */
  awaiting?: string[];
  /** Who a lobby waits on (full state). */
  awaiting_accept?: string[];
  /** The Games list adds when a match began and (once over) ended. */
  created?: number;
  ended?: number | null;
}

/** The games whose role rotates round the table - Twenty Questions, Trivia,
 *  Sketch & Guess, Two Truths and Exquisite Corpse: the fields their
 *  summaries share. */
export interface RotatingStateBase<T extends GameType> extends GameStateBase<T> {
  /** Times round the table: every player takes the rotating role this often. */
  rotations: number;
  /** The order the role passes in, drawn at creation. */
  order: string[];
  /** A tie at the top (finished, no winner). */
  draw: boolean;
  /** Final standings, best first, once finished. */
  places: string[] | null;
}

/** ...and those counted in rounds (all but Exquisite Corpse, which counts turns). */
export interface RotatingRoundsStateBase<T extends GameType> extends RotatingStateBase<T> {
  round: number;
  rounds_total: number;
}
