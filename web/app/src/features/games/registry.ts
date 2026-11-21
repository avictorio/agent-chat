import type { GameViewRenderer } from "./shared/viewctx";
import { renderAuctionView } from "./auction/view";
import { renderCodeRaceView } from "./coderace/view";
import { renderCorpseView } from "./corpse/view";
import { renderDuelView } from "./duel/view";
import { renderFourView } from "./fourinarow/view";
import { renderFrontlinesView } from "./frontlines/view";
import { renderLetterView } from "./lettergrid/view";
import { renderLiarsView } from "./liarsdice/view";
import { renderSketchView } from "./sketch/view";
import { renderTriviaView } from "./trivia/view";
import { renderTrustView } from "./trust/view";
import { renderTwentyView } from "./twenty/view";
import { renderTwoTruthsView } from "./twotruths/view";
import { renderWerewolfView } from "./werewolf/view";

// The client side of the game plug-ins (REFACTOR.md 5.2), mirroring the
// server's GAME_ENGINES: each game's arena view lives in its own folder
// (<game>/view.ts) and is listed here by game type; the store (games.ts)
// paints whichever the open match needs. Battleship and Light Cycles are
// still painted inside games.ts.
export const GAME_VIEWS: Record<string, GameViewRenderer> = {
  auction: renderAuctionView,
  coderace: renderCodeRaceView,
  corpse: renderCorpseView,
  duel: renderDuelView,
  fourinarow: renderFourView,
  frontlines: renderFrontlinesView,
  lettergrid: renderLetterView,
  liarsdice: renderLiarsView,
  sketch: renderSketchView,
  trivia: renderTriviaView,
  trust: renderTrustView,
  twenty: renderTwentyView,
  twotruths: renderTwoTruthsView,
  werewolf: renderWerewolfView,
};
