// Light Cycles (worker/games/lightcycles.js: lcSummary, lcStateFull,
// resolveTick): turn-based Tron; every rider moves at once each tick and
// leaves a permanent trail.

import type { GamePlayerBase, GameStateBase, GameYouBase } from "./common";

export type LightCyclesDir = "up" | "down" | "left" | "right";

/** A rider (lcSummary's players). Cells are x right, y down, from 0. */
export interface LightCyclesPlayer extends GamePlayerBase {
  accepted: boolean;
  /** The heading it rides, or the one it went out on. */
  dir: LightCyclesDir;
  alive: boolean;
  /** The bike's cell. */
  x: number;
  y: number;
  /** Whether this rider's move for the tick is in (which way stays secret). */
  moved: boolean;
}

/** A trail cell, [x, y, the rider's index in players]; the list is in
 *  growth order (each rider's spawn first, then one cell a tick). */
export type LightCyclesTrail = [number, number, number];

/** One rider's move on one resolved tick (resolveTick's move_log). */
export interface LightCyclesMove {
  tick: number;
  name: string;
  dir: LightCyclesDir;
  /** False when the clock carried the rider straight on. */
  submitted: boolean;
  /** When a submitted move arrived; null for a clock default. */
  at: number | null;
  resolved_at: number;
}

/** A rider's moves sent vs. carried by the clock (resolveTick's move_stats). */
export interface LightCyclesMoveStats {
  submitted: number;
  defaulted: number;
}

/** The viewer's block (lcStateFull's you). */
export interface LightCyclesYou extends GameYouBase {
  alive?: boolean;
  dir?: LightCyclesDir;
  /** Your move for the coming tick, once sent. */
  queued?: LightCyclesDir | null;
  /** Any heading but straight back (empty unless running and alive). */
  legal_moves?: LightCyclesDir[];
  /** The legal moves that don't crash this tick as the board stands. */
  safe_moves?: LightCyclesDir[];
}

/** lcSummary, plus lcStateFull's trails, log, move_log, awaiting and you.
 *  `type` may be missing: Light Cycles is the oldest game, matches stored
 *  before the type field have none, and the server reads a missing type
 *  as Light Cycles (gameEngine in worker/games/engine.js). lcSummary
 *  itself always sends "lightcycles"; a client treats the two alike. */
export interface LightCyclesState extends Omit<GameStateBase<"lightcycles">, "type"> {
  type?: "lightcycles";
  /** The grid's size in cells. */
  w: number;
  h: number;
  /** Ticks resolved so far. */
  tick: number;
  tick_seconds: number;
  /** live: a fixed clock each tick; async: a tick resolves once every
   *  rider has moved, the clock only a stall cap. */
  mode: "live" | "async";
  /** The first rider out (null when nobody yet, or several went at once). */
  record_keeper: string | null;
  /** Per rider. */
  moves: Record<string, LightCyclesMoveStats>;
  players: LightCyclesPlayer[];
  trails?: LightCyclesTrail[];
  /** Every rider's move on every tick, kept whole (the log is the last 80
   *  lines). */
  move_log?: LightCyclesMove[];
  you?: LightCyclesYou;
}
