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

/* Any match, read field by field: the shared game code's view (the store,
   the chat card, the Games tab), which reads whatever fields a match has,
   with fallbacks. Every field some game sends is here, typed as the union
   of what the games send under that name (required when every game
   always sends it, optional otherwise); arrays, records and dictionaries are widened
   the same way, element by element. Every <Game>State is assignable to it.
   A game's own code uses its precise <Game>State instead. */
type Prim = string | number | boolean | null | undefined;
type KeysOf<U> = U extends unknown ? keyof U : never;
type ValueAt<U, K extends PropertyKey> = U extends unknown ? (K extends keyof U ? U[K] : never) : never;
type ElementOf<A> = A extends readonly (infer E)[] ? E : never;
type Arr<T> = Extract<T, readonly unknown[]>;
type Obj<T> = Exclude<Extract<T, object>, readonly unknown[]>;
/* the dictionaries among a union of objects (Record<string, X>) */
type Dict<T> = T extends unknown ? (string extends keyof T ? T : never) : never;
/* the keys some member lacks or has optional */
type LooseKeys<U, K extends PropertyKey> = U extends unknown ? (K extends keyof U ? ({} extends Pick<U, K> ? K : never) : K) : never;
type FirmKeys<U> = Exclude<KeysOf<U>, LooseKeys<U, KeysOf<U>>>;
type WideRecord<U> = { [K in Extract<FirmKeys<U>, string>]: Wide<ValueAt<U, K>> } & {
  [K in Exclude<KeysOf<U>, FirmKeys<U>>]?: Wide<ValueAt<U, K>>;
};
export type Wide<T> =
  | Extract<T, Prim>
  | ([Arr<T>] extends [never] ? never : Wide<ElementOf<Arr<T>>>[])
  | ([Dict<Obj<T>>] extends [never] ? never : { [key: string]: Wide<ValueAt<Dict<Obj<T>>, string>> })
  | ([Exclude<Obj<T>, Dict<Obj<T>>>] extends [never] ? never : WideRecord<Exclude<Obj<T>, Dict<Obj<T>>>>);
export type AnyGameState = Wide<GameState>;

/** A match in the Games list (GET /games): its summary without Battleship's
 *  boards, plus who it waits on and when it began and (once over) ended. */
export type GameListItem = (GameState extends infer S ? (S extends unknown ? Omit<S, "boards"> : never) : never) & {
  targets: string[];
  created?: number;
  ended?: number | null;
};
