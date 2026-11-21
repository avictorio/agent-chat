import type { ComponentType, ReactNode } from "react";
import type { Root } from "react-dom/client";
import type { BattleshipState, DuelState, LightCyclesState, RoomClient } from "@chat/contract";
import type { ViewerApi } from "../../shell/viewer";
import type { GL } from "./render";
import type { LgDraft } from "../lettergrid/lettergrid";
import type { SgPad } from "../sketch/sketch";

// The game store's arena-view contract: what a game's
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

/* A 3D arena's props: its match (its game's state S) and the hooks a scene may take. */
export type Arena3dProps<S = GL> = { g: S; me?: string; aspect?: number; onReady?: () => void; registerCommit?: (fn: (() => void) | null) => void; onDrop?: (col: number) => void; draft?: { word: string; path: number[][] | null } | null; onCell?: (r: number, c: number) => void };
/* A game's 3D arena in the store's table: its host class and its lazily
   loaded scene, whichever game's (each takes its own state; paint3d hands
   it the match its kind was picked by). */
export type Kind3d = { cls: string; load: () => Promise<{ default: ComponentType<Arena3dProps<never>> }>; comp: Promise<ComponentType<Arena3dProps<never>>> | null };

/* The open arena view: the match it shows, its wrapper, and what each
   game keeps across repaints (drafts, 3D hosts, hooks into the scene). */
export type GameView = {
  id: number;
  wrap: HTMLElement;
  // the game's React panels (ctx.panel): one root per slot
  panels?: Record<string, { host: HTMLElement; root: Root }>;
  lastRounds?: number;
  tab?: string;
  lc3d?: Host3d | null;
  lc3dSeq?: number;
  bs3d?: Host3d | null;
  bs3dSeq?: number;
  duel3d?: Host3d | null;
  duel3dSeq?: number;
  duelCommit?: ((t: string) => void) | null;
  // a rounds game's 3D view (Frontlines, Code Race): its host, the paint
  // sequence, and the scene's seal-my-move-now hook
  r3d?: Host3d | null;
  r3dSeq?: number;
  r3dCommit?: (() => void) | null;
  // Letter Grid: the word being made, shared by the word panel and the
  // scene (a tap on a tile traces it); kept across repaints, reset each round
  lgDraft?: LgDraft | null;
  // Sketch & Guess: the pad's drawing for the round (its panel draws it)
  sgPad?: SgPad | null;
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

/* What a renderer may use from the store. */
export interface GameViewCtx {
  /** The open arena view, or null once it closed. */
  readonly gameView: GameView | null;
  readonly opts: GameStoreOptions;
  /** A game panel as React: node rendered (synchronously) into the slot's
   * root, which lives as long as the open view, so the panel keeps its
   * state (a draft) across repaints; returns its host to append. */
  panel(slot: string, node: ReactNode): HTMLElement;
  /** True when key differs from the last render's (or force): paint. */
  claimRender(key: string, force?: boolean): boolean;
  arenaHint(key: string, text: string): HTMLElement | null;
  arenaTabs(g: GL): HTMLElement;
  bsScene(g: BattleshipState, wrap: HTMLElement, under?: HTMLElement): void;
  dropBs3d(): void;
  dropLc3d(): void;
  paintLc3d(g: LightCyclesState, h: Host3d): void;
  rememberBsFocus(): void;
  drop3d(): void;
  dropDuel3d(): void;
  historyList(g: GL): HTMLElement;
  host3d(kind: string): Host3d;
  lobbyPanel(g: GL, note: HTMLElement): HTMLElement;
  makeHost3d(cls: string): Host3d;
  paint3d(kind: string, g: GL, h: Host3d, extra?: Partial<Omit<Arena3dProps, "g">>): void;
  paintDuel3d(g: DuelState, h: Host3d): void;
  resultRow(g: GL): HTMLElement | null;
  sendMove(id: number, dir: string, note: HTMLElement | null, label?: string): Promise<void>;
  turnBanner(g: GL): HTMLElement | null;
  webglOk(): boolean;
  youSig(g: GL): string;
}
