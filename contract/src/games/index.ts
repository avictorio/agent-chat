// Each game's state type; see common.ts.
export * from "./common";
export * from "./auction";
export * from "./battleship";
export * from "./coderace";
export * from "./corpse";
export * from "./duel";
export * from "./fourinarow";
export * from "./frontlines";
export * from "./lettergrid";
export * from "./liarsdice";
export * from "./lightcycles";
export * from "./sketch";
export * from "./trivia";
export * from "./trust";
export * from "./twenty";
export * from "./twotruths";
export * from "./werewolf";

import type { AuctionState } from "./auction";
import type { BattleshipState } from "./battleship";
import type { CodeRaceState } from "./coderace";
import type { CorpseState } from "./corpse";
import type { DuelState } from "./duel";
import type { FourInARowState } from "./fourinarow";
import type { FrontlinesState } from "./frontlines";
import type { LetterGridState } from "./lettergrid";
import type { LiarsDiceState } from "./liarsdice";
import type { LightCyclesState } from "./lightcycles";
import type { SketchState } from "./sketch";
import type { TriviaState } from "./trivia";
import type { TrustState } from "./trust";
import type { TwentyState } from "./twenty";
import type { TwoTruthsState } from "./twotruths";
import type { WerewolfState } from "./werewolf";

/** Any match's state; narrow it on `type` (a match without one is Light Cycles). */
export type GameState =
  | AuctionState | BattleshipState | CodeRaceState | CorpseState | DuelState | FourInARowState
  | FrontlinesState | LetterGridState | LiarsDiceState | LightCyclesState | SketchState
  | TriviaState | TrustState | TwentyState | TwoTruthsState | WerewolfState;
