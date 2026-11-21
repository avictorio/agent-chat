import type { ComponentType } from "react";
import type { Root } from "react-dom/client";
import type { RoomClient } from "@chat/contract";
import type { ViewerApi } from "../../shell/viewer";
import type { GL } from "./render";
import type { TrDraft } from "../trust/trust";
import type { TtDraft } from "../twotruths/twotruths";
import type { LgDraft, LgPanel } from "../lettergrid/lettergrid";
import type { TvAnsDraft, TvAskDraft } from "../trivia/trivia";
import type { SgPad } from "../sketch/sketch";

// The game store's arena-view contract (REFACTOR.md 5.2): what a game's
// view renderer (<game>/view.ts) gets from the store in games.ts, so each
// game's arena lives in its own folder instead of inside createGameStore.

export type GameStoreOptions = {
  client: RoomClient;
  meName: () => string;
  openViewer: ViewerApi["open"];
  // the ? in the arena header: How to play for this game
  showHelp?: (game: string) => void;
};

/* A 3D arena's host element, its React root and its status layer
   (see makeHost3d). */
export type Host3d = { root: Root; host: HTMLElement; status: HTMLElement; failed: boolean };

export type Arena3dProps = { g: GL; me?: string; aspect?: number; onReady?: () => void; registerCommit?: (fn: (() => void) | null) => void; onDrop?: (col: number) => void; draft?: { word: string; path: number[][] | null } | null; onCell?: (r: number, c: number) => void };
export type Kind3d = { cls: string; load: () => Promise<{ default: ComponentType<Arena3dProps> }>; comp: Promise<ComponentType<Arena3dProps>> | null };

/* The open arena view: the match it shows, its wrapper, and what each
   game keeps across repaints (drafts, 3D hosts, hooks into the scene). */
export type GameView = {
  id: number;
  wrap: HTMLElement;
  lastRounds?: number;
  tab?: string;
  lc3d?: Host3d | null;
  lc3dSeq?: number;
  bs3d?: Host3d | null;
  bs3dSeq?: number;
  duel3d?: Host3d | null;
  duel3dSeq?: number;
  duelCommit?: ((t: string) => void) | null;
  // Frontlines: the split being planned (kept across repaints) and the
  // number of rounds already shown (a new one plays its reveal)
  flDraft?: { round: number; vals: number[] } | null;
  // a rounds game's 3D view (Frontlines, Code Race): its host, the paint
  // sequence, and the scene's seal-my-move-now hook
  r3d?: Host3d | null;
  r3dSeq?: number;
  r3dCommit?: (() => void) | null;
  // Code Race: the guess being made (kept across repaints, reset each round)
  crDraft?: { round: number; v: string } | null;
  // Trust: the choices being made (kept across repaints, reset each round)
  trDraft?: { round: number; d: TrDraft } | null;
  // Auction: the bid being made (kept across repaints, reset each lot)
  auDraft?: { round: number; v: number } | null;
  ldDraft?: { turn: number; qty: number; face: number } | null;
  ttDraft?: TtDraft | null;
  ecDraft?: { turn: number; text: string } | null;
  tqDraft?: { key: string; text: string } | null;
  wwDraft?: { town: string; den: string } | null;
  lgDraft?: LgDraft | null;
  tvAsk?: { key: string; d: TvAskDraft } | null;
  tvAns?: { key: string; d: TvAnsDraft } | null;
  sgPad?: SgPad | null;
  sgGuess?: { key: string; d: string } | null;
  lgPanel?: LgPanel | null;
  // target: the rival in a free-for-all (the shot goes out "Name:Cell")
  bsFire?: ((label: string, target?: string) => void) | null;
  // fleet placement in the scene: the draft and its actions
  bsPlace?: {
    placed: { start: string; dir: string; size: number }[];
    orient: string;
    next: number;
    onPlace: (label: string) => void;
    onRotate: () => void;
    onUndo: () => void;
  } | null;
};

/* A game's arena view renderer: paints g into ctx.gameView (when it is
   still the open view), skipping the work when nothing it shows changed
   unless force. */
export type GameViewRenderer = (ctx: GameViewCtx, g: GL, force?: boolean) => void;

/* What a renderer may use from the store. */
export interface GameViewCtx {
  /** The open arena view, or null once it closed. */
  readonly gameView: GameView | null;
  readonly opts: GameStoreOptions;
  /** True when key differs from the last render's (or force): paint. */
  claimRender(key: string, force?: boolean): boolean;
  arenaHint(key: string, text: string): HTMLElement | null;
  arenaTabs(g: GL): HTMLElement;
  drop3d(): void;
  dropDuel3d(): void;
  historyList(g: GL): HTMLElement;
  host3d(kind: string): Host3d;
  lobbyPanel(g: GL, note: HTMLElement): HTMLElement;
  makeHost3d(cls: string): Host3d;
  paint3d(kind: string, g: GL, h: Host3d, extra?: Partial<Arena3dProps>): void;
  paintDuel3d(g: GL, h: Host3d): void;
  resultRow(g: GL): HTMLElement | null;
  sendMove(id: number, dir: string, note: HTMLElement | null, label?: string): Promise<void>;
  turnBanner(g: GL): HTMLElement | null;
  webglOk(): boolean;
  youSig(g: GL): string;
}
