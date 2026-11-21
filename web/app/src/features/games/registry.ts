import type { GL } from "./shared/render";
import { battleshipBoard, duelBoard } from "./shared/render";
import type { HistoryRows } from "./shared/history";
import type { GameViewRenderer } from "./shared/viewctx";
import { auCardBoard, auHistoryRows } from "./auction/auction";
import { renderAuctionView } from "./auction/view";
import { bsHistoryRows } from "./battleship/history";
import { renderBattleshipView } from "./battleship/view";
import { crCardBoard, crHistoryRows } from "./coderace/coderace";
import { renderCodeRaceView } from "./coderace/view";
import { ecCardBoard, ecHistoryRows } from "./corpse/corpse";
import { renderCorpseView } from "./corpse/view";
import { duelHistoryRows } from "./duel/history";
import { renderDuelView } from "./duel/view";
import { c4Board, c4HistoryRows } from "./fourinarow/fourinarow";
import { renderFourView } from "./fourinarow/view";
import { flCardBoard, flHistoryRows } from "./frontlines/frontlines";
import { renderFrontlinesView } from "./frontlines/view";
import { lgCardBoard, lgHistoryRows } from "./lettergrid/lettergrid";
import { renderLetterView } from "./lettergrid/view";
import { ldCardBoard, ldHistoryRows } from "./liarsdice/liarsdice";
import { renderLiarsView } from "./liarsdice/view";
import { paintLightCyclesCard } from "./lightcycles/card";
import { lcHistoryCount, lcHistoryRows } from "./lightcycles/history";
import { renderLightCyclesView } from "./lightcycles/view";
import { sgCardBoard, sgHistoryRows } from "./sketch/sketch";
import { renderSketchView } from "./sketch/view";
import { tvCardBoard, tvHistoryRows } from "./trivia/trivia";
import { renderTriviaView } from "./trivia/view";
import { trCardBoard, trHistoryRows } from "./trust/trust";
import { renderTrustView } from "./trust/view";
import { tqCardBoard, tqHistoryRows } from "./twenty/twenty";
import { renderTwentyView } from "./twenty/view";
import { ttCardBoard, ttHistoryRows } from "./twotruths/twotruths";
import { renderTwoTruthsView } from "./twotruths/view";
import { wwCardBoard, wwHistoryRows } from "./werewolf/werewolf";
import { renderWerewolfView } from "./werewolf/view";

// The client side of the game plug-ins (REFACTOR.md 5.2), mirroring the
// server's GAME_ENGINES: one entry per game type, each pointing into the
// game's own folder. The store (games.ts) paints the open match's arena
// view; the chat card (shared/gamecard.tsx) paints its board. A match from
// before the type field is Light Cycles, as on the server.

/** Paints a match's board into its chat card (board is emptied first). */
export type GameCardPainter = (board: HTMLElement, g: GL, me: string) => void;
export type GamePlugin = {
  /** The open match's arena view. */
  view: GameViewRenderer;
  /** The board in the match's chat card. */
  card: GameCardPainter;
  /** The History tab's rows. */
  history: HistoryRows;
  /** The number on the History tab. */
  historyCount: (g: GL) => number;
};

const fill = (board: HTMLElement, el: HTMLElement) => {
  board.textContent = "";
  board.appendChild(el);
};
const count = (key: string) => (g: GL) => (g[key] || []).length;
const rounds = count("rounds");

export const GAMES: Record<string, GamePlugin> = {
  auction: {
    view: renderAuctionView,
    card: (b, g, me) => fill(b, auCardBoard(g, me)),
    history: auHistoryRows,
    historyCount: rounds,
  },
  battleship: {
    view: renderBattleshipView,
    card: (b, g) => fill(b, battleshipBoard(g)),
    history: bsHistoryRows,
    historyCount: count("log"),
  },
  coderace: {
    view: renderCodeRaceView,
    card: (b, g, me) => fill(b, crCardBoard(g, me)),
    history: crHistoryRows,
    historyCount: rounds,
  },
  corpse: {
    view: renderCorpseView,
    card: (b, g, me) => fill(b, ecCardBoard(g, me)),
    history: ecHistoryRows,
    historyCount: count("beats"),
  },
  duel: {
    view: renderDuelView,
    card: (b, g) => fill(b, duelBoard(g)),
    history: duelHistoryRows,
    historyCount: rounds,
  },
  fourinarow: {
    view: renderFourView,
    card: (b, g) => fill(b, c4Board(g, { compact: true })),
    history: c4HistoryRows,
    historyCount: count("moves"),
  },
  frontlines: {
    view: renderFrontlinesView,
    card: (b, g) => fill(b, flCardBoard(g)),
    history: flHistoryRows,
    historyCount: rounds,
  },
  lettergrid: {
    view: renderLetterView,
    card: (b, g, me) => fill(b, lgCardBoard(g, me)),
    history: lgHistoryRows,
    historyCount: rounds,
  },
  liarsdice: {
    view: renderLiarsView,
    card: (b, g, me) => fill(b, ldCardBoard(g, me)),
    history: ldHistoryRows,
    historyCount: rounds,
  },
  lightcycles: {
    view: renderLightCyclesView,
    card: (b, g) => paintLightCyclesCard(b, g),
    history: lcHistoryRows,
    historyCount: lcHistoryCount,
  },
  sketch: {
    view: renderSketchView,
    card: (b, g, me) => fill(b, sgCardBoard(g, me)),
    history: sgHistoryRows,
    historyCount: rounds,
  },
  trivia: {
    view: renderTriviaView,
    card: (b, g, me) => fill(b, tvCardBoard(g, me)),
    history: tvHistoryRows,
    historyCount: rounds,
  },
  trust: {
    view: renderTrustView,
    card: (b, g, me) => fill(b, trCardBoard(g, me)),
    history: trHistoryRows,
    historyCount: rounds,
  },
  twenty: {
    view: renderTwentyView,
    card: (b, g, me) => fill(b, tqCardBoard(g, me)),
    history: tqHistoryRows,
    historyCount: rounds,
  },
  twotruths: {
    view: renderTwoTruthsView,
    card: (b, g, me) => fill(b, ttCardBoard(g, me)),
    history: ttHistoryRows,
    historyCount: rounds,
  },
  werewolf: {
    view: renderWerewolfView,
    card: (b, g, me) => fill(b, wwCardBoard(g, me)),
    history: wwHistoryRows,
    historyCount: count("events"),
  },
};
