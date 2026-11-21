// Exquisite Corpse (worker/games/corpse.js: ecSummary, ecStateFull,
// ecMove, ecAdvance, ecFinish): writers add to one story in turn, each
// seeing only the segment before theirs; the story is revealed at the
// end and everyone votes for a favourite segment.

import type { GamePlayerBase, GameYouBase, RotatingStateBase } from "./common";

/** A seat (ecSummary's players). */
export interface CorpsePlayer extends GamePlayerBase {
  /** Segments written so far. */
  segments: number;
  /** Out of the rotation: two turns in a row ran out. */
  out: boolean;
  /** Turns in a row that ran out (writing resets it). */
  skips: number;
  /** Vote phase: whether this player's vote is in; false otherwise. */
  committed: boolean;
  /** Once finished: the votes this player's segments drew; else null. */
  votes: number | null;
}

/** A segment of the revealed story (ecSummary's story). */
export interface CorpseSegment {
  /** Its number, from 1. */
  n: number;
  by: string;
  text: string;
}

/** One turn of the story: a segment written, or a silent beat (ecMove, ecAdvance). */
export interface CorpseBeat {
  turn: number;
  by: string;
  wrote: boolean;
}

/** The viewer's block (ecStateFull); a spectator gets only `playing`. */
export interface CorpseYou extends GameYouBase {
  /** Players: out of the rotation. */
  out?: boolean;
  /** Players: whether it is your turn to write. */
  writer?: boolean;
  /** Players: the numbers of your own segments. */
  segments?: number[];
  /** The constraints variant: your secret constraint card. */
  constraint?: string | null;
  /** The writer only: the one segment you may read (the seed line for the first turn). */
  tail?: string;
  /** The vote phase: the segment you voted for, or null. */
  vote?: number | null;
  /** (not sent by the server: ecStateFull's you has no name; the story view's
   *  own-segment check reads it, and `segments` already covers that case.) */
  name?: string;
}

/** ecSummary, plus ecStateFull's beats, log, awaiting and you. */
export interface CorpseState extends RotatingStateBase<"corpse"> {
  /** write: a writer's turn; vote: the story is revealed and votes come in. Null unless running. */
  phase: "write" | "vote" | null;
  /** The turn now, from 1 (past turns_total once the story is done). */
  turn: number;
  turns_total: number;
  /** Who writes now; null outside a running write phase. */
  turn_of: string | null;
  turn_seconds: number;
  variant: "straight" | "genre" | "constraints";
  genre: string | null;
  /** How many segments are written (their text stays hidden until the reveal). */
  segments: number;
  /** The seed line, once revealed (the vote phase, or finished); else null. */
  seed: string | null;
  /** The whole story with its authors, once revealed; else null. */
  story: CorpseSegment[] | null;
  /** The constraints variant, once revealed: each writer's card. */
  constraints: Record<string, string> | null;
  /** Once finished: votes per segment number. */
  votes: Record<string, number> | null;
  /** Once finished: the segment numbers that took the honours (most votes; ties share). */
  honours: number[] | null;
  /** The honours are shared between writers (finished, no winner). */
  draw: boolean;
  /** Final standings by votes drawn, once finished. */
  places: string[] | null;
  players: CorpsePlayer[];
  /** Every turn so far, written or silent (full state only). */
  beats?: CorpseBeat[];
  you?: CorpseYou;
}
