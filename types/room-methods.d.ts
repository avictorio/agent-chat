// For checking the Worker (npm run check: tsconfig.worker.json).
// Not deployed: wrangler uploads worker/ only.

import type { FourInARowMethods } from "../worker/games/fourinarow.js";
import type { TrustMethods } from "../worker/games/trust.js";
import type { AuctionMethods } from "../worker/games/auction.js";
import type { FrontlinesMethods } from "../worker/games/frontlines.js";
import type { CodeRaceMethods } from "../worker/games/coderace.js";
import type { LiarsDiceMethods } from "../worker/games/liarsdice.js";
import type { TwoTruthsMethods } from "../worker/games/twotruths.js";
import type { TriviaMethods } from "../worker/games/trivia.js";
import type { SketchMethods } from "../worker/games/sketch.js";
import type { CorpseMethods } from "../worker/games/corpse.js";
import type { WerewolfMethods } from "../worker/games/werewolf.js";
import type { TwentyMethods } from "../worker/games/twenty.js";
import type { LetterGridMethods } from "../worker/games/lettergrid.js";
import type { DuelMethods } from "../worker/games/duel.js";
import type { LightCyclesMethods, LightCyclesTickMethods } from "../worker/games/lightcycles.js";
import type { BattleshipMethods } from "../worker/games/battleship.js";
import type { MemberMethods } from "../worker/room/members.js";
import type { VoiceMethods } from "../worker/room/voices.js";
import type { MediaMethods } from "../worker/room/media.js";
import type { UploadMethods } from "../worker/room/uploads.js";
import type { PushMethods } from "../worker/room/push.js";
import type { BoardMethods } from "../worker/room/board.js";
import type { StateMethods } from "../worker/room/state.js";
import type { MessageMethods } from "../worker/room/messages.js";
import type { GameMachineryMethods } from "../worker/room/games.js";
import type { TestHookMethods } from "../worker/room/test-hooks.js";
import type { Room } from "../worker/room/Room.js";

// Room's methods live in one object per area, installed on the class with
// Object.assign at the end of room/Room.ts; this tells the checker so.
declare module "../worker/room/Room.js" {
  interface Room extends Omit<typeof FourInARowMethods &
    typeof TrustMethods &
    typeof AuctionMethods &
    typeof FrontlinesMethods &
    typeof CodeRaceMethods &
    typeof LiarsDiceMethods &
    typeof TwoTruthsMethods &
    typeof TriviaMethods &
    typeof SketchMethods &
    typeof CorpseMethods &
    typeof WerewolfMethods &
    typeof TwentyMethods &
    typeof LetterGridMethods &
    typeof DuelMethods &
    typeof LightCyclesMethods &
    typeof LightCyclesTickMethods &
    typeof BattleshipMethods &
    typeof MemberMethods &
    typeof VoiceMethods &
    typeof MediaMethods &
    typeof UploadMethods &
    typeof PushMethods &
    typeof BoardMethods &
    typeof StateMethods &
    typeof MessageMethods &
    typeof GameMachineryMethods &
    typeof TestHookMethods, never> {
    // In-memory locks the method objects set on the instance (not storage).
    /** Sketch & Guess matches whose Referee is judging right now (sgJudgeNow). */
    sgJudging?: Set<number>;
    /** Upload sessions ("msg:kind") with a finish in flight (uploadFinish). */
    _finishing?: Set<string>;
  }
}

// A Durable Object stub: an RPC proxy whose methods are the Room's, each
// answering with a promise of what the method returns.
type Promised<F> = F extends (...args: infer A) => infer R ? (...args: A) => Promise<Awaited<R>> : never;
declare global {
  type DurableObjectStub = {
    [K in keyof Room as K extends "fetch" ? never : Room[K] extends (...args: never[]) => unknown ? K : never]: Promised<Room[K]>;
  } & {
    /** a stub's fetch takes a URL or a Request, like the global one */
    fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  };
}
