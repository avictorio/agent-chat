// Battleship (worker/games/battleship.js: battleshipSummary,
// battleshipStateFull, bsPublicBoards, bsApplyShot, bsBeginTurn): hidden
// fleets, one shot a turn (a volley in salvo); two captains, or a
// free-for-all of 3-6. Cells are labels like "C5" (column letter, row
// number from 1); un-hit enemy hulls never leave the server.

import type { GameLogLine, GamePlayerBase, GameStateBase, GameYouBase } from "./common";

export type BattleshipShotResult = "hit" | "miss";

export interface BattleshipPlayer extends GamePlayerBase {
  /** Whether this captain's fleet is down. */
  placed: boolean;
  /** Shots fired, and how many hit. */
  shots: number;
  hits: number;
  /** Rival ships this captain has sunk. */
  sunk: number;
  /** Own ships still afloat. */
  afloat: number;
  /** Free-for-all: out, their board a public wreck chart. */
  eliminated: boolean;
}

/** A sunk ship, as anyone may see it. */
export interface BattleshipSunkShip {
  size: number;
  cells: string[];
}

/** One of your own ships (you.fleet). */
export interface BattleshipShip extends BattleshipSunkShip {
  /** Its cells that took a hit. */
  hits: string[];
  sunk: boolean;
}

/** What anyone may see of a captain's waters (bsPublicBoards). */
export interface BattleshipBoard {
  name: string;
  hex: string;
  /** The fire these waters took, by cell. */
  incoming: Record<string, BattleshipShotResult>;
  sunk_ships: BattleshipSunkShip[];
  eliminated: boolean;
}

/** A fired shot (bsApplyShot): last_move is the latest. */
export interface BattleshipMove {
  by: string;
  /** Whose waters it hit; missing on records from before the free-for-all (2026-11-17), where it is the shooter's one rival. */
  target?: string;
  cell: string;
  result: BattleshipShotResult;
  /** The size of the ship it sank, else null. */
  sunk: number | null;
  turn: number;
}

/** A shot in the full record (shots), with its time. */
export interface BattleshipShot extends BattleshipMove {
  at: number;
}

/** A log line; a shot's line also carries the shot (the History reads it). */
export interface BattleshipLogLine extends GameLogLine {
  by?: string;
  target?: string;
  cell?: string;
  result?: BattleshipShotResult;
  sunk?: number | null;
}

/** The endgame sonar ping (bsBeginTurn, bsBeginTurnFfa): a row or column of the hunted waters holding an un-hit hull cell. */
export interface BattleshipSonar {
  turn: number;
  /** The shooter it pings for. */
  for: string;
  /** Free-for-all: the leader being hunted (two captains: the shooter's rival). */
  target?: string;
  axis: "row" | "column";
  /** "row 4" or "column C". */
  label: string;
}

/** Free-for-all: your record against one rival (you.targets). */
export interface BattleshipTarget {
  name: string;
  hex: string;
  eliminated: boolean;
  afloat: number;
  /** Your shots at their waters, by cell. */
  shots: Record<string, BattleshipShotResult>;
  /** Their ships you have seen sink. */
  sunk_ships: BattleshipSunkShip[];
}

export interface BattleshipYou extends GameYouBase {
  phase?: "setup" | "play" | null;
  your_turn?: boolean;
  eliminated?: boolean;
  /** Your fleet, once placed. */
  fleet?: BattleshipShip[] | null;
  /** Two captains: your shots at the rival's waters, by cell (empty in a free-for-all: see targets). */
  shots?: Record<string, BattleshipShotResult>;
  /** The fire your own waters took, by cell. */
  incoming?: Record<string, BattleshipShotResult>;
  /** Two captains: the rival's ships you have sunk. */
  sunk_ships?: BattleshipSunkShip[];
  /** Two captains: the rival's ships still afloat; null in a free-for-all. */
  opponent_afloat?: number | null;
  /** Free-for-all only: your record against each rival. */
  targets?: BattleshipTarget[];
}

export interface BattleshipState extends GameStateBase<"battleship"> {
  /** Fleets going down, or firing; null unless running. */
  phase: "setup" | "play" | null;
  turn: number;
  /** Who fires; null unless running in the play phase. */
  turn_of: string | null;
  /** The board's size: 10x10, or 8x8 in skirmish. */
  w: number;
  h: number;
  variant: "classic" | "salvo" | "skirmish";
  fleet_sizes: number[];
  /** Salvo: shots left this turn; else null. */
  salvo_left: number | null;
  sonar: BattleshipSonar | null;
  /** Turns each captain let run out in a row (three forfeit). */
  misses: Record<string, number>;
  turn_seconds: number;
  last_move: BattleshipMove | null;
  boards: BattleshipBoard[];
  /** Free-for-all: the captains out, in order. */
  eliminated: string[];
  players: BattleshipPlayer[];
  log?: BattleshipLogLine[];
  /** Every shot fired, oldest first. */
  shots?: BattleshipShot[];
  you?: BattleshipYou;
}
