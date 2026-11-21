import type { GL } from "./shared/render";
import { battleshipBoard, duelBoard } from "./shared/render";
import type { HistoryRows } from "./shared/history";
import type { GameViewRenderer } from "./shared/viewctx";
import { auCardBoard, auHistoryRows } from "./auction/auction";
import { renderAuctionView } from "./auction/view";
import { auctionStatus } from "./auction/status";
import { bsHistoryRows } from "./battleship/history";
import { renderBattleshipView } from "./battleship/view";
import { battleshipStatus } from "./battleship/status";
import { crCardBoard, crHistoryRows } from "./coderace/coderace";
import { renderCodeRaceView } from "./coderace/view";
import { coderaceStatus } from "./coderace/status";
import { ecCardBoard, ecHistoryRows } from "./corpse/corpse";
import { renderCorpseView } from "./corpse/view";
import { corpseStatus } from "./corpse/status";
import { duelHistoryRows } from "./duel/history";
import { renderDuelView } from "./duel/view";
import { duelStatus } from "./duel/status";
import { c4Board, c4HistoryRows } from "./fourinarow/fourinarow";
import { renderFourView } from "./fourinarow/view";
import { fourinarowStatus } from "./fourinarow/status";
import { flCardBoard, flHistoryRows } from "./frontlines/frontlines";
import { renderFrontlinesView } from "./frontlines/view";
import { frontlinesStatus } from "./frontlines/status";
import { lgCardBoard, lgHistoryRows } from "./lettergrid/lettergrid";
import { renderLetterView } from "./lettergrid/view";
import { lettergridStatus } from "./lettergrid/status";
import { ldCardBoard, ldHistoryRows } from "./liarsdice/liarsdice";
import { renderLiarsView } from "./liarsdice/view";
import { liarsdiceStatus } from "./liarsdice/status";
import { paintLightCyclesCard } from "./lightcycles/card";
import { lcHistoryCount, lcHistoryRows } from "./lightcycles/history";
import { renderLightCyclesView } from "./lightcycles/view";
import { sgCardBoard, sgHistoryRows } from "./sketch/sketch";
import { renderSketchView } from "./sketch/view";
import { sketchStatus } from "./sketch/status";
import { tvCardBoard, tvHistoryRows } from "./trivia/trivia";
import { renderTriviaView } from "./trivia/view";
import { triviaStatus } from "./trivia/status";
import { trCardBoard, trHistoryRows } from "./trust/trust";
import { renderTrustView } from "./trust/view";
import { trustStatus } from "./trust/status";
import { tqCardBoard, tqHistoryRows } from "./twenty/twenty";
import { renderTwentyView } from "./twenty/view";
import { twentyStatus } from "./twenty/status";
import { ttCardBoard, ttHistoryRows } from "./twotruths/twotruths";
import { renderTwoTruthsView } from "./twotruths/view";
import { twotruthsStatus } from "./twotruths/status";
import { wwCardBoard, wwHistoryRows } from "./werewolf/werewolf";
import { renderWerewolfView } from "./werewolf/view";
import { werewolfStatus } from "./werewolf/status";

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
} & GameStatus;

/** What the app says about a match's state, in the game's own words: each
 * game's <game>/status.ts. Every hook is optional; where one is called,
 * a game without it (Light Cycles, a match without a type) gets the
 * default written there. */
export interface GameStatus {
  /** The final score, winner first ("3–1"); default none (shared/render.ts finalScore). */
  finalScore?(g: GL): string;
  /** A finished match's record line ("Final · 3–1 · 5 rounds"); default the tick (recordLine). */
  recordLine?(g: GL): string;
  /** The card's meta line in every state (gameMetaText). */
  metaText?(g: GL): string;
  /** The Games tab's line for a running match (GamesView.tsx stateLine). */
  stateLine?(g: GL): string;
  /** Who a running match waits on, when the list carries no targets (waitingOn). */
  waitingOn?(g: GL): string[];
  /** What a match waiting on you wants ("Your throw"; youLabel). */
  youLabel?(g: GL): string;
  /** How long a finished match ran, in its own unit (lengthLine). */
  lengthLine?(g: GL): string;
  /** The card's "the match moved" fingerprint (shared/gamecard.tsx gameSignature). */
  signature?(g: GL): string | null;
  /** The running clock's length in seconds; default Light Cycles' tick (shared/render.ts clockSeconds). */
  clockSeconds?(g: GL): number;
  /** Whether a running match waits on me, from my seat (`mine`); the title
   * badge and the chime count these (games.ts awaitingCount). Default: a
   * Light Cycles rider still alive who has not moved. */
  awaiting?(g: GL, mine: GL, me: string): boolean;
  /** Who made the latest move, for the card's pulse colour: a name, null for
   * nobody, or undefined for "no mover of its own" - then a finished
   * match's winner (shared/gamecard.tsx gameMoverHex). */
  mover?(g: GL): string | null | undefined;
  /** The arena's turn banner for a running match, as seen by me (games.ts turnBanner). */
  turnLine?(g: GL, me: string): TurnLine;
}

/** A turn banner's words: the line, the stakes under it, and whether it is me who is up. */
export type TurnLine = { text: string; sub?: string; mine?: boolean };

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
    ...auctionStatus,
  },
  battleship: {
    view: renderBattleshipView,
    card: (b, g) => fill(b, battleshipBoard(g)),
    history: bsHistoryRows,
    historyCount: count("log"),
    ...battleshipStatus,
  },
  coderace: {
    view: renderCodeRaceView,
    card: (b, g, me) => fill(b, crCardBoard(g, me)),
    history: crHistoryRows,
    historyCount: rounds,
    ...coderaceStatus,
  },
  corpse: {
    view: renderCorpseView,
    card: (b, g, me) => fill(b, ecCardBoard(g, me)),
    history: ecHistoryRows,
    historyCount: count("beats"),
    ...corpseStatus,
  },
  duel: {
    view: renderDuelView,
    card: (b, g) => fill(b, duelBoard(g)),
    history: duelHistoryRows,
    historyCount: rounds,
    ...duelStatus,
  },
  fourinarow: {
    view: renderFourView,
    card: (b, g) => fill(b, c4Board(g, { compact: true })),
    history: c4HistoryRows,
    historyCount: count("moves"),
    ...fourinarowStatus,
  },
  frontlines: {
    view: renderFrontlinesView,
    card: (b, g) => fill(b, flCardBoard(g)),
    history: flHistoryRows,
    historyCount: rounds,
    ...frontlinesStatus,
  },
  lettergrid: {
    view: renderLetterView,
    card: (b, g, me) => fill(b, lgCardBoard(g, me)),
    history: lgHistoryRows,
    historyCount: rounds,
    ...lettergridStatus,
  },
  liarsdice: {
    view: renderLiarsView,
    card: (b, g, me) => fill(b, ldCardBoard(g, me)),
    history: ldHistoryRows,
    historyCount: rounds,
    ...liarsdiceStatus,
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
    ...sketchStatus,
  },
  trivia: {
    view: renderTriviaView,
    card: (b, g, me) => fill(b, tvCardBoard(g, me)),
    history: tvHistoryRows,
    historyCount: rounds,
    ...triviaStatus,
  },
  trust: {
    view: renderTrustView,
    card: (b, g, me) => fill(b, trCardBoard(g, me)),
    history: trHistoryRows,
    historyCount: rounds,
    ...trustStatus,
  },
  twenty: {
    view: renderTwentyView,
    card: (b, g, me) => fill(b, tqCardBoard(g, me)),
    history: tqHistoryRows,
    historyCount: rounds,
    ...twentyStatus,
  },
  twotruths: {
    view: renderTwoTruthsView,
    card: (b, g, me) => fill(b, ttCardBoard(g, me)),
    history: ttHistoryRows,
    historyCount: rounds,
    ...twotruthsStatus,
  },
  werewolf: {
    view: renderWerewolfView,
    card: (b, g, me) => fill(b, wwCardBoard(g, me)),
    history: wwHistoryRows,
    historyCount: count("events"),
    ...werewolfStatus,
  },
};
