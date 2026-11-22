// The game engine table: one plug-in object per game (see each games/<game>.js), the spellings createGame accepts, and the structured-move fields.

import { lightcyclesEngine } from "./lightcycles.js";
import { duelEngine } from "./duel.js";
import { battleshipEngine } from "./battleship.js";
import { frontlinesEngine } from "./frontlines.js";
import { coderaceEngine } from "./coderace.js";
import { trustEngine } from "./trust.js";
import { auctionEngine } from "./auction.js";
import { fourinarowEngine } from "./fourinarow.js";
import { liarsdiceEngine } from "./liarsdice.js";
import { twotruthsEngine } from "./twotruths.js";
import { werewolfEngine } from "./werewolf.js";
import { twentyEngine } from "./twenty.js";
import { corpseEngine } from "./corpse.js";
import { lettergridEngine } from "./lettergrid.js";
import { SG_IMAGE_MAX, sketchEngine } from "./sketch.js";
import { triviaEngine } from "./trivia.js";
import type { GameType } from "@chat/contract";
import type { Room } from "../room/Room.js";
import type { GameRow, StoredBase } from "../room/games.js";
import type { GameStateItem } from "../room/state.js";
import type { Body } from "../lib/http.js";

/** A match's public summary or full state as the shared machinery handles
 *  it: the fields every game's state has (GameStateBase in the contract)
 *  plus its game's own, which the machinery passes through untouched (and
 *  to which it adds targets, created, ended, how_to_play). */
export type GamePub = {
  id: number, type: string, status: string,
  players: Array<{ name: string, hex: string, accepted?: boolean }>,
  winner?: string | null, winners?: string[] | null, places?: string[] | null,
  // what the machinery adds on its way out
  how_to_play?: string, trails?: unknown, targets?: string[], boards?: unknown, created?: number, ended?: number | null,
};
/** What a create or a move answers: the status to send, with the match's
 *  full state or the error (and, for a refused move, example moves). */
export type GameReply = { status?: number, error?: string, game?: unknown, legal_moves?: string[], resolved?: boolean };
/** A match row whose state is one game's own stored type. */
export type GameRowOf<S extends StoredBase> = Omit<GameRow, "st"> & { st: S };
/**
 * A game's plug-in: one entry of GAME_ENGINES, as described below, over
 * that game's own stored state S (each module ends its engine with
 * `satisfies GameEngineOf<ItsSt>`). The machinery holds them all as
 * GameEngine (S = StoredBase) and hands each engine only its own matches
 * - gameEngine() picks it by the state's type - which is what lets an
 * engine take a GameRow as its own GameRowOf<S>: the methods below are
 * method signatures, so their parameters compare both ways.
 */
export type GameEngineOf<S extends StoredBase> = {
  name: string,
  turnWord: string,
  logTick(st: S): number,
  clockSeconds(st: S): number,
  create(room: Room, creator: string, players: unknown[], opts: Body, roomName: string): GameReply | Promise<GameReply>,
  summary(room: Room, g: GameRowOf<S>): GamePub,
  full(room: Room, g: GameRowOf<S>, who: string | null | undefined): GamePub,
  move(room: Room, g: GameRowOf<S>, who: string, dir: unknown, roomName: string, fields?: Record<string, unknown> | null): GameReply | Promise<GameReply>,
  advance(room: Room, g: GameRowOf<S>, roomName: string): void,
  advanceAsync?(room: Room, g: GameRowOf<S>, roomName: string): Promise<void>,
  targets(pub: GamePub): string[],
  card(g: GameRowOf<S>): object,
  stateItem(r: { id: number, status: string }, st: S): GameStateItem,
  turnOf(item: GameStateItem): number | string,
  moveHint(item: GameStateItem, me: string): string,
  result(room: Room, g: GameRowOf<S>): string,
  rules(st: S): string,
  resolveRound?(room: Room, g: GameRowOf<S>): void,
  standing?(room: Room, st: S): string | null,
  active?(room: Room, st: S): Array<{ name: string }>,
};
/** An engine as the machinery holds it: over any match. */
export type GameEngine = GameEngineOf<StoredBase>;

/* ---------- game engines (groundwork, 2026-11-19) ----------
   Every game the Room plays is one entry here. The shared machinery -
   lobby and accept, clocks and the alarm, stream frames, room_state
   nudges, chat cards, result posts, cancel, standings - asks the match's
   engine instead of branching on its type. Each game lives in its own
   games/<game>.js: its constants and data, its Room methods (an object
   installed on the class at the end of worker/room/Room.ts) and its
   engine entry, which is listed in GAME_ENGINES here. To add a game:
   write that module, install its methods and list its entry, then the
   docs section, the MCP descriptions and the web catalog
   (web/app/src/games/shared/catalog.tsx) and a folder for its web side
   (web/app/src/games/<game>/).

   An entry:
     name, turnWord     how the game is named, and its clock step in logs
     logTick(st)        the current step number (tick, round, turn)
     clockSeconds(st)   the first deadline once the lobby fills
     create(room, creator, players, opts, roomName)    -> { status, game | error }
     summary(room, g) / full(room, g, who)             public and per-viewer state
     move(room, g, who, dir, roomName)                 -> { status, game | error, legal_moves? }
     advance(room, g, roomName)                        settle what the clock owes
     targets(pub)       who a running match waits on, from its summary
     card(g)            the light reference a match's chat card carries
     stateItem(r, st)   the match as room_state sees it: { id, type, status,
                        <turn field>, players: [{ name, alive, moved, accepted }] }
     turnOf(item)       that item's turn signature (a new value = a new decision)
     moveHint(item, me) the dir placeholder in an awaiting_you call
     result(room, g)    the Referee's result post
     rules(st)          how_to_play: this match's rules in a few lines, with
                        its settings - shown in every full state, so keep it
                        in step with the game's /api section and catalog
   Games on the simultaneous-rounds machinery (roundsCommit/roundsAdvance)
   add resolveRound(room, g) and standing(room, st). */
export const GAME_ENGINES = {
  lightcycles: lightcyclesEngine,
  duel: duelEngine,
  battleship: battleshipEngine,
  frontlines: frontlinesEngine,
  coderace: coderaceEngine,
  trust: trustEngine,
  auction: auctionEngine,
  fourinarow: fourinarowEngine,
  liarsdice: liarsdiceEngine,
  twotruths: twotruthsEngine,
  werewolf: werewolfEngine,
  twenty: twentyEngine,
  corpse: corpseEngine,
  lettergrid: lettergridEngine,
  sketch: sketchEngine,
  trivia: triviaEngine,
};
// A structured move's named parts from a request body or MCP arguments
// (only the known keys, so nothing else rides along), or null.
export function moveFields(src: Body | null | undefined) {
  if (!src || typeof src !== "object") return null;
  const out: Record<string, unknown> = {};
  if (Array.isArray(src.statements)) out.statements = src.statements.slice(0, 5);
  if (src.lie !== undefined && src.lie !== null) out.lie = src.lie;
  if (src.vote !== undefined && src.vote !== null) out.vote = src.vote;
  // Letter Grid: the word and, optionally, its path
  if (typeof src.word === "string") out.word = src.word.slice(0, 40);
  if (Array.isArray(src.path)) out.path = src.path.slice(0, 40);
  else if (typeof src.path === "string") out.path = src.path.slice(0, 200);
  // Trivia: the quizmaster's question, answer and variants; an answer and
  // its wager
  if (typeof src.question === "string") out.question = src.question.slice(0, 400);
  if (typeof src.answer === "string") out.answer = src.answer.slice(0, 120);
  if (Array.isArray(src.accept)) out.accept = src.accept.slice(0, 5).map((x) => String(x == null ? "" : x).slice(0, 120));
  else if (typeof src.accept === "string") out.accept = src.accept.slice(0, 400);
  if (src.wager !== undefined && src.wager !== null) out.wager = src.wager;
  // Sketch & Guess: the artist's image (a data URL) and a guess
  if (typeof src.image === "string") out.image = src.image.slice(0, Math.ceil((SG_IMAGE_MAX * 4) / 3) + 200);
  if (typeof src.guess === "string") out.guess = src.guess.slice(0, 200);
  return Object.keys(out).length ? out : null;
}
// Spellings createGame accepts for an engine key (after lowercasing and
// dropping spaces, dashes and underscores).
export const GAME_ALIASES = { lc: "lightcycles", tron: "lightcycles", rps: "duel", connectfour: "fourinarow", connect4: "fourinarow", c4: "fourinarow", liars: "liarsdice", "liar'sdice": "liarsdice", dice: "liarsdice", bluff: "liarsdice", twotruthsandalie: "twotruths", "2truths": "twotruths", "2truthsandalie": "twotruths", truths: "twotruths", exquisitecorpse: "corpse", ec: "corpse", twentyquestions: "twenty", "20questions": "twenty", "20q": "twenty", wolf: "werewolf", werewolves: "werewolf", mafia: "werewolf", letters: "lettergrid", lettergridbrawl: "lettergrid", grid: "lettergrid", brawl: "lettergrid", wordgrid: "lettergrid", quiz: "trivia", quizmaster: "trivia", triviawithwagers: "trivia", roomloretrivia: "trivia", roomlore: "trivia", sketchandguess: "sketch", "sketch&guess": "sketch", pictionary: "sketch", aipictionary: "sketch", drawing: "sketch" };
// A match's engine, from its state (or a room_state item): matches from
// before the type field are Light Cycles, the first game.
export function gameEngine(st: { type?: string } | null | undefined): GameEngine {
  // every entry implements GameEngine (the contract above); an unknown type is no entry
  return ((st && GAME_ENGINES[st.type as GameType]) || GAME_ENGINES.lightcycles) as GameEngine;
}
