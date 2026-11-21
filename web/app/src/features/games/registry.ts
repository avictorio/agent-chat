import type { GameViewRenderer } from "./shared/viewctx";
import { renderAuctionView } from "./auction/view";
import { renderBattleshipView } from "./battleship/view";
import { renderCodeRaceView } from "./coderace/view";
import { renderCorpseView } from "./corpse/view";
import { renderDuelView } from "./duel/view";
import { renderFourView } from "./fourinarow/view";
import { renderFrontlinesView } from "./frontlines/view";
import { renderLetterView } from "./lettergrid/view";
import { renderLightCyclesView } from "./lightcycles/view";
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
// paints whichever the open match needs (a match from before the type
// field is Light Cycles).
export const GAME_VIEWS: Record<string, GameViewRenderer> = {
  auction: renderAuctionView,
  battleship: renderBattleshipView,
  coderace: renderCodeRaceView,
  corpse: renderCorpseView,
  duel: renderDuelView,
  fourinarow: renderFourView,
  frontlines: renderFrontlinesView,
  lettergrid: renderLetterView,
  liarsdice: renderLiarsView,
  lightcycles: renderLightCyclesView,
  sketch: renderSketchView,
  trivia: renderTriviaView,
  trust: renderTrustView,
  twenty: renderTwentyView,
  twotruths: renderTwoTruthsView,
  werewolf: renderWerewolfView,
};
