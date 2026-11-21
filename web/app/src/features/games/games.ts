import type { Placing as BsPlacing } from "./battleship/BsArena3D";
import type { RoomClient } from "@chat/contract";
import { createElement, type ComponentType } from "react";
import { createRoot, type Root } from "react-dom/client";
import { el, toast } from "../../lib/index";
import { matchTitle } from "./shared/catalog";
import { flField, flHistoryRows, flLastRound, flPlanner } from "./frontlines/frontlines";
import { crBoard, crHistoryRows, crInput, crSecretEl } from "./coderace/coderace";
import { c4Board, c4HistoryRows, c4Seats } from "./fourinarow/fourinarow";
import { trGrid, trHistoryRows, trLastRound, trPlanner, trScores, type TrDraft } from "./trust/trust";
import { auBid, auHistoryRows, auLastRound, auLot, auPlayers, auResult } from "./auction/auction";
import { ldBidNow, ldBidder, ldCounts, ldCup, ldHistoryRows, ldLastRound, ldRound, ldTable } from "./liarsdice/liarsdice";
import { ttHistoryRows, ttLastRound, ttReveal, ttScores, ttStatements, ttWriter, type TtDraft } from "./twotruths/twotruths";
import { ecHistoryRows, ecStory, ecStrip, ecWriter, ecWriters } from "./corpse/corpse";
import { tqAnswerer, tqAsker, tqBudget, tqHistoryRows, tqLastRound, tqLog, tqReveal, tqScores } from "./twenty/twenty";
import { wwAction, wwEvents, wwHistoryRows, wwPlayers, wwRoleCard, wwTalk, wwVerb } from "./werewolf/werewolf";
import { sgArtistPanel, sgGuessForm, sgHistoryRows, sgLastRound, sgMakePad, sgReveal, sgScores, type SgPad } from "./sketch/sketch";
import { tvAnswerForm, tvAskForm, tvHistoryRows, tvJudgeForm, tvLastRound, tvQuestion, tvReveal, tvScores, type TvAnsDraft, type TvAskDraft } from "./trivia/trivia";
import { lgDir, lgHistoryRows, lgLastRound, lgPanel, lgReveal, lgScores, lgTap, lgTopWords, lgYours, type LgDraft, type LgPanel } from "./lettergrid/lettergrid";
import {
  battleshipBoard,
  bsGrid,
  duelBoard,
  duelScoreLine,
  duelTendencies,
  fleetStrip,
  gameMetaText,
  lastMoveText,
  roundVerdict,
  setClockBar,
  setTurnClock,
  formatLeft,
  winnerBanner,
  THROW_BEATS,
  THROW_EMOJI,
  type GL,
} from "./shared/render";
import type { ViewerApi } from "../shell/viewer";
import type { Arena3dProps, GameStoreOptions, GameView, GameViewCtx, Host3d, Kind3d } from "./shared/viewctx";
import { GAME_VIEWS } from "./registry";


// Games: the chat cards and the arena views for all sixteen games. Both
// render from game state (GET /games/:id, kept fresh by stream "game"
// frames and slow polls). Cards are React components subscribed to this
// store; an arena view is native DOM inside the viewer around a lazy 3D
// scene, and its controls call the moves endpoint with the viewer's own
// invite. Without WebGL the flat panels the scenes replaced come back.


/* ---------- the store ---------- */

export interface GameStore {
  cache: Map<number, GL>;
  subscribe(fn: () => void): () => void;
  getVersion(): number;
  fetch(id: number): Promise<void>;
  onFrame(game: GL): void;
  openGame(id: number, type?: string): void;
  viewerClosed(): void;
  respond(id: number, accept: boolean): Promise<void>;
  rematch(g: GL): Promise<void>;
  awaitingCount(): number;
  meName(): string;
}

export function createGameStore(opts: GameStoreOptions): GameStore {
  const { client } = opts;
  const cache = new Map<number, GL>();
  const listeners = new Set<() => void>();
  let version = 0;
  const notify = () => {
    version++;
    listeners.forEach((fn) => fn());
  };

  let gameView: GameView | null = null;
  let gameViewTimer = 0;
  // the scene element that had focus before a Battleship repaint
  let bsRefocus: HTMLElement | null = null;
  let gameRenderKey = "";
  // What each game's arena renderer (<game>/view.ts) gets from the store.
  const ctx: GameViewCtx = {
    get gameView() {
      return gameView;
    },
    opts,
    claimRender(key, force) {
      if (!force && key === gameRenderKey) return false;
      gameRenderKey = key;
      return true;
    },
    arenaHint,
    arenaTabs,
    bsScene,
    bsStrips3d,
    dropBs3d,
    dropLc3d,
    paintLc3d,
    rememberBsFocus,
    drop3d,
    dropDuel3d,
    historyList,
    host3d,
    lobbyPanel,
    makeHost3d,
    paint3d,
    paintDuel3d,
    resultRow,
    sendMove,
    turnBanner,
    webglOk,
    youSig,
  };

  // Teach by playing: one dismissible hint line per arena, shown on
  // first views only (the dismissal persists per kind).
  function arenaHint(key: string, text: string): HTMLElement | null {
    try {
      if (localStorage.getItem("ac-hint-" + key) === "1") return null;
    } catch {
      return null;
    }
    const h = el("div", "arena-hint");
    h.appendChild(el("span", "", text));
    const x = el("button", "arena-hint-x", "✕") as HTMLButtonElement;
    x.type = "button";
    x.setAttribute("aria-label", "Dismiss hint");
    x.addEventListener("click", () => {
      try {
        localStorage.setItem("ac-hint-" + key, "1");
      } catch {
        // storage unavailable: the hint just comes back next time
      }
      h.remove();
    });
    h.appendChild(x);
    return h;
  }

  /* The turn banner (2026-11-13): every running arena opens with one
     line that says who is up - "Your shot", "Ada is in · your throw
     decides the round", "Waiting on Henry" - the time left as a
     countdown (not a clock time), a bar that stays calm until the
     last quarter and then burns, and what happens when the clock runs
     out, when it is you it will happen to. Each game used to say this
     in its own place and words (Light Cycles as a clock time in the
     meta line, Battleship not at all). The text keeps the
     duel-statusline class the suite reads. */
  function turnBanner(g: GL): HTMLElement | null {
    if (!g || g.status !== "running") return null;
    const me = opts.meName();
    const you = g.you || {};
    const players: GL[] = g.players || [];
    const opp = players.filter((p: GL) => p.name !== me)[0];
    let text = "";
    let sub = "";
    let mine = false;
    let dur = 0;
    let prefix = "";
    if (g.type === "duel") {
      dur = (g.round_seconds || 180) * 1000;
      if (you.playing && opp) {
        if (you.queued) text = "You're in · waiting on " + opp.name;
        else {
          mine = true;
          text = opp.thrown ? opp.name + " is in · your throw decides the round" : "Your throw · round " + g.round;
          sub = "If the clock runs out, a lone throw takes the round.";
        }
      } else text = players.map((p: GL) => p.name + (p.thrown ? " locked ✓" : " thinking…")).join(" · ");
    } else if (g.type === "frontlines") {
      dur = (g.round_seconds || 180) * 1000;
      if (you.playing && opp) {
        if (you.queued) text = "Your split is in · waiting on " + opp.name;
        else {
          mine = true;
          text = opp.committed ? opp.name + " has committed · your split decides round " + g.round : "Your split · round " + g.round;
          sub = "If the clock runs out, a lone split takes the round.";
        }
      } else text = players.map((p: GL) => p.name + (p.committed ? " committed ✓" : " planning…")).join(" · ");
    } else if (g.type === "auction") {
      dur = (g.round_seconds || 180) * 1000;
      const waiting = players.filter((p: GL) => !p.committed && (p.budget || 0) > 0 && p.name !== me).map((p: GL) => p.name);
      if (you.playing && (you.budget || 0) <= 0) text = "You've spent out · " + (waiting.length ? "waiting on " + waiting.join(", ") : "resolving…");
      else if (you.playing && you.queued != null) text = "Your bid is in · " + (waiting.length ? "waiting on " + waiting.join(", ") : "resolving…");
      else if (you.playing) {
        mine = true;
        text = "Your bid · lot " + g.round + " of " + g.lots_total;
        sub = "If the clock runs out, you pass on this lot.";
      } else text = "Lot " + g.round + " · " + (waiting.length ? "waiting on " + waiting.join(", ") : "resolving…");
    } else if (g.type === "trust") {
      dur = (g.round_seconds || 180) * 1000;
      const waiting = players.filter((p: GL) => !p.committed && !p.out && p.name !== me).map((p: GL) => p.name);
      if (you.playing && you.out) text = "You're out of this match" + (waiting.length ? " · waiting on " + waiting.join(", ") : "");
      else if (you.playing && you.queued) text = "Your choices are in · " + (waiting.length ? "waiting on " + waiting.join(", ") : "resolving…");
      else if (you.playing) {
        mine = true;
        text = "Your choices · round " + g.round;
        sub = "If the clock runs out, you defect on everyone this round.";
      } else text = "Round " + g.round + " · " + (waiting.length ? "waiting on " + waiting.join(", ") : "resolving…");
    } else if (g.type === "sketch") {
      dur = (g.phase === "guess" ? g.guess_seconds || 600 : g.draw_seconds || 3600) * 1000;
      const waiting = players.filter((p: GL) => !p.committed && p.name !== g.artist && p.name !== me).map((p: GL) => p.name);
      if (g.phase === "judging") text = "The Referee is judging the guesses…";
      else if (you.playing && you.artist) {
        if (g.phase === "draw") {
          mine = true;
          text = "You're the artist · draw your prompt";
          sub = "If the clock runs out, you forfeit the round.";
        } else text = "Your drawing is up · " + (waiting.length ? "waiting on " + waiting.join(", ") : "closing…");
      } else if (g.phase === "draw") text = (g.artist || "The artist") + " is drawing · round " + g.round + " of " + g.rounds_total;
      else if (you.playing && you.queued) text = "Your guess is in · " + (waiting.length ? "waiting on " + waiting.join(", ") : "closing…");
      else if (you.playing) {
        mine = true;
        text = "Guess " + (g.artist || "the artist") + "'s drawing · round " + g.round + " of " + g.rounds_total;
        sub = "If the clock runs out, you score nothing this round.";
      } else text = "Round " + g.round + " · " + (waiting.length ? "waiting on " + waiting.join(", ") : "closing…");
    } else if (g.type === "trivia") {
      dur = (g.round_seconds || 3600) * 1000;
      const waiting = players.filter((p: GL) => !p.committed && p.name !== g.asker && p.name !== me).map((p: GL) => p.name);
      if (you.playing && you.asker) {
        if (g.phase === "ask") {
          mine = true;
          text = "You're the quizmaster · ask a question";
          sub = "If the clock runs out, you forfeit the round.";
        } else if (g.phase === "judge") {
          mine = true;
          text = "Judge the answers the match missed";
          sub = "If the clock runs out, the reveal counts them wrong.";
        } else text = "Your question is up · " + (waiting.length ? "waiting on " + waiting.join(", ") : "closing…");
      } else if (g.phase === "ask") text = (g.asker || "The quizmaster") + " is writing a question · round " + g.round + " of " + g.rounds_total;
      else if (g.phase === "judge") text = (g.asker || "The quizmaster") + " is judging the answers";
      else if (you.playing && you.queued) text = "Your answer is in · " + (waiting.length ? "waiting on " + waiting.join(", ") : "closing…");
      else if (you.playing) {
        mine = true;
        text = "Your answer · round " + g.round + " of " + g.rounds_total;
        sub = "If the clock runs out, you score nothing (and lose nothing).";
      } else text = "Round " + g.round + " · " + (waiting.length ? "waiting on " + waiting.join(", ") : "closing…");
    } else if (g.type === "lettergrid") {
      dur = (g.round_seconds || 3600) * 1000;
      const waiting = players.filter((p: GL) => !p.committed && !p.out && p.name !== me).map((p: GL) => p.name);
      if (you.playing && you.out) text = "You're out of this match" + (waiting.length ? " · waiting on " + waiting.join(", ") : "");
      else if (you.playing && you.queued) text = "Your word is in · " + (waiting.length ? "waiting on " + waiting.join(", ") : "resolving…");
      else if (you.playing) {
        mine = true;
        text = "Your word · round " + g.round + " of " + g.rounds_total;
        sub = "If the clock runs out, you score nothing this round.";
      } else text = "Round " + g.round + " · " + (waiting.length ? "waiting on " + waiting.join(", ") : "resolving…");
    } else if (g.type === "werewolf") {
      dur = (g.phase_seconds || 86400) * 1000;
      const verb = wwVerb(you.role);
      if (you.playing && you.alive === false) text = "You're out · " + (g.phase === "night" ? "night " + g.night : "day " + g.day) + " · watching";
      else if (g.phase === "night") {
        if (you.playing && verb && !you.act) {
          mine = true;
          text = "Night " + g.night + " · your move: " + verb;
          sub = "The night ends when every role has acted, or at the clock.";
        } else text = "Night " + g.night + " · the village sleeps";
      } else {
        const waiting = players.filter((p: GL) => p.alive && !p.voted && p.name !== me).map((p: GL) => p.name);
        if (you.playing && you.vote == null) {
          mine = true;
          text = "Day " + g.day + " · talk it out, then vote";
          sub = "Votes are public and can change until the day closes.";
        } else text = (you.playing ? "Your vote is in · " : "Day " + g.day + " · ") + (waiting.length ? "waiting on " + waiting.join(", ") : "closing…");
      }
    } else if (g.type === "twenty") {
      dur = (g.round_seconds || 3600) * 1000;
      const left = (g.remaining != null ? g.remaining : 20) + " of 20 left";
      if (you.playing && you.answerer) {
        if (g.phase === "secret") {
          mine = true;
          text = "Your turn to answer · choose a secret";
          sub = "If the clock runs out, one is drawn for you.";
        } else if (g.phase === "answer") {
          mine = true;
          text = (g.pending ? g.pending.by : "Someone") + (g.pending && g.pending.kind === "guess" ? " guesses" : " asks") + " · answer";
          sub = "If the clock runs out on a question, you forfeit the round.";
        } else text = "You hold the secret · waiting for a question · " + left;
      } else if (g.phase === "secret") text = (g.answerer || "The answerer") + " is choosing a secret · round " + g.round + " of " + g.rounds_total;
      else if (g.phase === "answer") text = "Waiting on " + g.answerer + "'s answer · " + left;
      else if (you.playing) {
        mine = true;
        text = "Ask " + g.answerer + " a question · " + left;
        sub = g.mode === "table" ? "Anyone at the table may ask - one question at a time." : "A yes/no question, or a guess.";
      } else text = "Questions for " + g.answerer + " · " + left;
    } else if (g.type === "corpse") {
      dur = (g.turn_seconds || 86400) * 1000;
      if (g.phase === "write") {
        if (you.playing && you.writer) {
          mine = true;
          text = "Your turn to write · turn " + g.turn + " of " + g.turns_total;
          sub = "You see only the segment before yours. If the clock runs out, your turn is a silent beat.";
        } else text = (g.turn_of || "Someone") + " is writing · turn " + g.turn + " of " + g.turns_total;
      } else {
        const waiting = players.filter((p: GL) => !p.committed && p.name !== me).map((p: GL) => p.name);
        if (you.playing && you.vote != null) text = "Your favourite is in · " + (waiting.length ? "waiting on " + waiting.join(", ") : "counting…");
        else if (you.playing) {
          mine = true;
          text = "The story is revealed · pick a favourite";
          sub = "Any segment but your own.";
        } else text = "The story is revealed · voting";
      }
    } else if (g.type === "twotruths") {
      dur = (g.round_seconds || 3600) * 1000;
      if (g.phase === "write") {
        if (you.playing && you.teller) {
          mine = true;
          text = "Your turn to tell · round " + g.round + " of " + g.rounds_total;
          sub = "Two truths and a lie about you. If the clock runs out, you forfeit the round.";
        } else text = (g.teller || "The storyteller") + " is writing · round " + g.round + " of " + g.rounds_total;
      } else {
        const waiting = players.filter((p: GL) => p.name !== g.teller && !p.committed && p.name !== me).map((p: GL) => p.name);
        const rest = waiting.length ? "waiting on " + waiting.join(", ") : "revealing…";
        if (you.playing && you.teller) text = "Your statements are up · " + rest;
        else if (you.playing && you.vote != null) text = "Your vote is in · " + rest;
        else if (you.playing) {
          mine = true;
          text = "Spot the lie · " + g.teller + "'s statements";
          sub = "If the clock runs out, you score nothing this round.";
        } else text = "Voting on " + g.teller + "'s statements · " + rest;
      }
    } else if (g.type === "liarsdice") {
      dur = (g.turn_seconds || 3600) * 1000;
      if (you.playing && you.out) text = "You're out of this match" + (g.turn_of ? " · " + g.turn_of + " to bid" : "");
      else if (you.playing && you.your_turn) {
        mine = true;
        text = (g.bid ? "Raise or call liar" : "Open the bidding") + " · round " + g.round;
        const to = you.timeouts || 0;
        sub = to >= 2 ? "You've timed out twice in a row - one more and you're out." : "If the clock runs out, you lose a die.";
      } else if (you.playing) text = "Waiting on " + (g.turn_of || "the table") + " · round " + g.round;
      else text = (g.turn_of ? g.turn_of + " to bid · " : "") + "round " + g.round;
    } else if (g.type === "fourinarow") {
      dur = (g.turn_seconds || 3600) * 1000;
      if (you.playing && you.your_turn) {
        mine = true;
        text = "Your move · turn " + g.turn;
        const to = you.timeouts || 0;
        sub = to >= 2 ? "You've timed out twice - one more forfeits the match." : to === 1 ? "You timed out once - three timeouts forfeit the match." : "Tap a column to drop your disc.";
      } else if (you.playing) text = "Waiting on " + (g.turn_of || "your rival") + " · turn " + g.turn;
      else text = (g.turn_of ? g.turn_of + " to move · " : "") + "turn " + g.turn;
    } else if (g.type === "coderace") {
      dur = (g.round_seconds || 3600) * 1000;
      const waiting = players.filter((p: GL) => !p.committed && !p.solved && !p.out && p.name !== me).map((p: GL) => p.name);
      if (you.playing && you.solved) text = "You cracked it in round " + you.solved + (waiting.length ? " · waiting on " + waiting.join(", ") : "");
      else if (you.playing && you.out) text = "You're out of this race" + (waiting.length ? " · waiting on " + waiting.join(", ") : "");
      else if (you.playing && you.queued) text = "Your guess is in · " + (waiting.length ? "waiting on " + waiting.join(", ") : "resolving…");
      else if (you.playing) {
        mine = true;
        text = "Your guess · round " + g.round + " of " + (g.max_rounds || "?");
        sub = waiting.length ? "The round resolves when every racer still racing has guessed." : "Everyone else is in · your guess resolves the round.";
        const missed = (g.rounds || []).slice(-2).filter((r: GL) => (r.missed || []).indexOf(me) >= 0).length;
        if (missed >= 2) sub = "You've missed two rounds in a row - miss this one and you're out.";
      } else text = "Round " + g.round + " · " + (waiting.length ? "waiting on " + waiting.join(", ") : "resolving…");
    } else if (g.type === "battleship") {
      dur = (g.turn_seconds || 3600) * 1000;
      if (g.phase === "setup") {
        if (you.playing && !you.fleet) {
          mine = true;
          text = "Place your fleet";
        } else if (you.playing) text = "Fleet placed · waiting on " + (opp ? opp.name : "your rival");
        else text = players.map((p: GL) => p.name + (p.placed ? " placed ✓" : " placing…")).join(" · ");
      } else if (you.playing && you.your_turn) {
        mine = true;
        text =
          g.variant === "salvo" && g.salvo_left != null
            ? "Your salvo · " + g.salvo_left + " shot" + (g.salvo_left === 1 ? "" : "s") + " left"
            : "Your shot · turn " + g.turn;
        // the stakes only once they are real: your own missed turns
        const missed = (g.misses || {})[me] || 0;
        if (missed >= 2) sub = "You've missed " + missed + " turns in a row - one more forfeits the match.";
        else if (missed === 1) sub = "You missed a turn - three in a row forfeits the match.";
      } else if (you.playing) text = "Waiting on " + (opp ? opp.name + "'s shot" : "the next shot") + " · turn " + g.turn;
      else text = (g.turn_of ? g.turn_of + " to fire · " : "") + "turn " + g.turn;
    } else {
      dur = (g.tick_seconds || 120) * 1000;
      const waiting = players.filter((p: GL) => p.alive && !p.moved && p.name !== me).map((p: GL) => p.name);
      if (g.mode === "async") prefix = "cap in ";
      if (you.playing && you.alive && !you.queued) {
        mine = true;
        text = "Your move · tick " + g.tick;
        sub = g.mode === "async" ? "The tick resolves the moment every rider has moved." : "Miss the tick and your cycle rides straight on.";
      } else if (you.playing && you.alive) text = "You're set · waiting on " + (waiting.join(", ") || "the tick");
      else text = waiting.length ? "Waiting on " + waiting.join(", ") : "Tick " + g.tick + " is resolving…";
    }
    const b = el("div", "turn-banner" + (mine ? " mine" : ""));
    b.setAttribute("role", "status");
    const top = el("div", "turn-top");
    top.appendChild(el("span", "turn-text duel-statusline", text));
    if (g.deadline) top.appendChild(el("span", "turn-left", ""));
    b.appendChild(top);
    if (g.deadline && dur) {
      const bar = el("div", "turn-bar");
      bar.appendChild(el("div", ""));
      b.appendChild(bar);
      b.setAttribute("data-turn-deadline", String(g.deadline));
      b.setAttribute("data-turn-dur", String(dur));
      if (prefix) b.setAttribute("data-turn-prefix", prefix);
      setTurnClock(b);
    }
    if (sub) b.appendChild(el("div", "turn-sub", sub));
    return b;
  }

  /* A finished (or called-off) match puts Rematch beside the result,
     at the top, not below the board where a phone never scrolled. */
  function resultRow(g: GL): HTMLElement | null {
    if (g.status !== "finished" && g.status !== "cancelled") return null;
    const box = el("div", "result-row");
    const n = el("div", "lc-note", "");
    box.appendChild(rematchRow(g, n));
    box.appendChild(n);
    return box;
  }

  function rematchRow(g: GL, note: HTMLElement): HTMLElement {
    const row = el("div", "duel-pad");
    // Rematch is offered to everyone for a finished or called-off
    // match (the Nov 11 standardization); sendRematch's in-flight
    // guard is what keeps a double tap from opening two lobbies.
    const b = el("button", "duel-btn", "Rematch");
    b.type = "button";
    b.addEventListener("click", () => {
      b.disabled = true;
      void sendRematch(g, note);
    });
    row.appendChild(b);
    if (!note.textContent) note.textContent = "Match over - run it back with the same settings.";
    return row;
  }

  const rematchInFlight = new Set<number>();

  async function sendRematch(g: GL, note: HTMLElement | null) {
    // One guard for every rematch surface (arena row, card, games
    // list): a double tap used to open two lobbies. Rematch itself
    // stays open to everyone - any member can run back a finished
    // or called-off match with its original players.
    if (rematchInFlight.has(g.id)) return;
    rematchInFlight.add(g.id);
    const body: Record<string, unknown> = { players: (g.players || []).map((p: GL) => p.name) };
    if (g.type === "duel") {
      body.game = "duel";
      body.best_of = g.best_of;
      body.tick_seconds = g.round_seconds;
    } else if (g.type === "frontlines") {
      body.game = "frontlines";
      body.best_of = g.best_of;
      body.tick_seconds = g.round_seconds;
      if (g.variant && g.variant !== "classic") body.variant = g.variant;
    } else if (g.type === "auction") {
      body.game = "auction";
      body.lots = g.lots_total;
      body.budget = g.budget;
      body.tick_seconds = g.round_seconds;
    } else if (g.type === "trust") {
      body.game = "trust";
      body.rounds = g.rounds_about;
      body.tick_seconds = g.round_seconds;
    } else if (g.type === "fourinarow") {
      body.game = "fourinarow";
      body.tick_seconds = g.turn_seconds;
    } else if (g.type === "sketch") {
      body.game = "sketch";
      body.rotations = g.rotations || 1;
      body.draw_seconds = g.draw_seconds;
      body.guess_seconds = g.guess_seconds;
    } else if (g.type === "trivia") {
      body.game = "trivia";
      body.rotations = g.rotations || 1;
      body.tick_seconds = g.round_seconds;
    } else if (g.type === "lettergrid") {
      body.game = "lettergrid";
      body.rounds = g.rounds_total;
      body.size = g.size;
      body.min_length = g.min_len;
      body.tick_seconds = g.round_seconds;
    } else if (g.type === "werewolf") {
      body.game = "werewolf";
      body.tick_seconds = g.phase_seconds;
    } else if (g.type === "twenty") {
      body.game = "twenty";
      body.rotations = g.rotations || 1;
      body.tick_seconds = g.round_seconds;
    } else if (g.type === "corpse") {
      body.game = "corpse";
      body.rotations = g.rotations || 3;
      body.variant = g.variant || "straight";
      if (g.genre) body.genre = g.genre;
      body.tick_seconds = g.turn_seconds;
    } else if (g.type === "twotruths") {
      body.game = "twotruths";
      body.rotations = g.rotations || 1;
      body.tick_seconds = g.round_seconds;
    } else if (g.type === "liarsdice") {
      body.game = "liarsdice";
      body.dice = g.dice_each;
      body.ones_wild = !!g.ones_wild;
      body.tick_seconds = g.turn_seconds;
    } else if (g.type === "coderace") {
      body.game = "coderace";
      body.mode = g.mode;
      body.length = g.length;
      if (g.colors) body.colors = g.colors;
      body.max_rounds = g.max_rounds;
      body.tick_seconds = g.round_seconds;
    } else if (g.type === "battleship") {
      body.game = "battleship";
      body.tick_seconds = g.turn_seconds;
      if (g.variant && g.variant !== "classic") body.variant = g.variant;
    } else {
      body.tick_seconds = g.tick_seconds;
      if (g.mode) body.mode = g.mode;
      body.w = g.w;
      body.h = g.h;
    }
    if (note) note.textContent = "Setting up the rematch…";
    try {
      const d = await client.createGame(body);
      if (d.game && d.game.id) {
        cache.set(d.game.id, d.game);
        notify();
        openGame(d.game.id, d.game.type);
      } else if (note) {
        note.textContent = "The rematch was refused.";
      } else toast("The rematch was refused.", true);
    } catch (e) {
      // cards and the Games tab have no note line: say it in a toast
      const msg = e instanceof Error && e.message ? e.message : "The rematch did not reach the referee.";
      if (note) note.textContent = "The rematch did not reach the referee.";
      else toast(msg, true);
    } finally {
      rematchInFlight.delete(g.id);
    }
  }

  // Lobby answers: accept takes your seat (the last accept starts the
  // match), decline calls the match off for everyone. The response is
  // the new state, so the card and the arena repaint from it directly.
  async function respond(id: number, accept: boolean, note: HTMLElement | null) {
    if (note) note.textContent = accept ? "Taking your seat…" : "Declining…";
    try {
      const d = accept ? await client.acceptGame(id) : await client.declineGame(id);
      if (d.game) {
        cache.set(id, d.game);
        notify();
        renderGameView(d.game, true);
      } else if (note) {
        note.textContent = "The referee refused that.";
      } else toast("The referee refused that.", true);
    } catch (e) {
      const msg = e instanceof Error && e.message ? e.message : "That did not reach the referee.";
      if (note) note.textContent = msg;
      else toast(msg, true);
      // the lobby may have expired or been decided meanwhile: show what is true now
      void fetchGame(id);
    }
  }

  // The lobby panel, shared by both arenas: who is in, who is still
  // owed an answer, and - for an invited player who has not answered -
  // the Accept / Decline buttons. The clock has not started; nothing
  // here is urgent except honesty about who is actually at the table.
  function lobbyPanel(g: GL, note: HTMLElement): HTMLElement {
    const wrap = el("div", "lobby-panel");
    const waiting = (g.players || []).filter((p: GL) => !p.accepted).map((p: GL) => p.name);
    const mine = !!(g.you && g.you.playing);
    let line: string;
    if (mine && !g.you.accepted)
      line = "You've been invited to this match. Accept to take your seat - the clock starts when everyone is in.";
    else if (mine) line = "You're in. Waiting on " + waiting.join(", ") + ".";
    else line = "Lobby - waiting on " + waiting.join(", ") + " to accept.";
    if (g.lobby_deadline) {
      const left = g.lobby_deadline - Date.now();
      line += left > 0 ? " The lobby closes in " + formatLeft(left) + "." : " The lobby is closing.";
    }
    wrap.appendChild(el("div", "duel-statusline", line));
    if (mine && !g.you.accepted) {
      const row = el("div", "duel-pad");
      const acc = el("button", "duel-btn", "Accept");
      acc.type = "button";
      acc.addEventListener("click", () => {
        void respond(g.id, true, note);
      });
      const dec = el("button", "duel-btn quiet", "Decline");
      dec.type = "button";
      dec.addEventListener("click", () => {
        void respond(g.id, false, note);
      });
      row.appendChild(acc);
      row.appendChild(dec);
      wrap.appendChild(row);
    }
    return wrap;
  }

  async function sendMove(id: number, dir: string, note: HTMLElement | null, label?: string) {
    if (note) note.textContent = label || "Queuing " + dir + "…";
    try {
      const d = await client.submitMove(id, dir);
      if (d.game) {
        cache.set(id, d.game);
        notify();
        renderGameView(d.game, true);
      } else if (note) {
        note.textContent = "That move was refused.";
      }
    } catch (e) {
      if (note) note.textContent = e instanceof Error ? e.message : "The move did not reach the referee.";
    }
  }

  // The standard game history: every arena carries the same two
  // tabs - Game and History - and the History tab renders one row
  // grammar for every kind: an index chip (Turn/Round/Tick N), the
  // actors as color-dot chips, their action, and an outcome pill.
  // Battleship rows come from the log's structured shot entries,
  // duel rows from rounds, cycles rows from the move log grouped
  // by tick; narrative log lines ride along as note rows.
  const DIR_ARROW: Record<string, string> = { up: "↑", down: "↓", left: "←", right: "→" };

  function histCount(g: GL): number {
    if (g.type === "duel" || g.type === "frontlines" || g.type === "coderace" || g.type === "trust" || g.type === "auction" || g.type === "liarsdice" || g.type === "twotruths" || g.type === "twenty" || g.type === "lettergrid" || g.type === "trivia" || g.type === "sketch") return (g.rounds || []).length;
    if (g.type === "battleship") return (g.log || []).length;
    if (g.type === "fourinarow") return (g.moves || []).length;
    if (g.type === "corpse") return (g.beats || []).length;
    if (g.type === "werewolf") return (g.events || []).length;
    const ticks = new Set(((g.move_log || []) as GL[]).map((m: GL) => m.tick));
    return ticks.size;
  }

  function arenaTabs(g: GL): HTMLElement {
    const tabs = el("div", "arena-tabs");
    const cur = (gameView && gameView.tab) || "game";
    const defs: [string, string][] = [
      ["game", "Game"],
      ["history", "History · " + histCount(g)],
    ];
    defs.forEach(([id, label]) => {
      const b = el("button", "arena-tab" + (cur === id ? " on" : ""), label);
      b.type = "button";
      b.addEventListener("click", () => {
        if (!gameView || (gameView.tab || "game") === id) return;
        gameView.tab = id;
        const cg = cache.get(g.id);
        if (cg) renderGameView(cg, true);
      });
      tabs.appendChild(b);
    });
    return tabs;
  }

  function histWho(p: GL): HTMLElement {
    const s = el("span", "hist-who");
    const d = el("span", "hist-dot");
    d.style.background = (p && p.hex) || "#94a3b8";
    s.appendChild(d);
    s.appendChild(document.createTextNode((p && p.name) || "?"));
    return s;
  }

  function historyList(g: GL): HTMLElement {
    const list = el("div", "hist-list");
    const players = g.players || [];
    const byName = (n: string): GL => players.filter((p: GL) => p.name === n)[0] || { name: n, hex: "#94a3b8" };
    const row = (idx: string): HTMLElement => {
      const r = el("div", "hist-row");
      r.appendChild(el("span", "hist-idx", idx));
      return r;
    };
    let n = 0;
    if (g.type === "frontlines") {
      n = flHistoryRows(g, row, histWho, list);
    } else if (g.type === "coderace") {
      n = crHistoryRows(g, row, histWho, list);
    } else if (g.type === "fourinarow") {
      n = c4HistoryRows(g, row, histWho, list);
    } else if (g.type === "trust") {
      n = trHistoryRows(g, row, histWho, list);
    } else if (g.type === "auction") {
      n = auHistoryRows(g, row, histWho, list);
    } else if (g.type === "liarsdice") {
      n = ldHistoryRows(g, row, histWho, list);
    } else if (g.type === "twotruths") {
      n = ttHistoryRows(g, row, histWho, list);
    } else if (g.type === "corpse") {
      n = ecHistoryRows(g, row, histWho, list);
    } else if (g.type === "twenty") {
      n = tqHistoryRows(g, row, histWho, list);
    } else if (g.type === "werewolf") {
      n = wwHistoryRows(g, row, histWho, list);
    } else if (g.type === "lettergrid") {
      n = lgHistoryRows(g, row, histWho, list);
    } else if (g.type === "trivia") {
      n = tvHistoryRows(g, row, histWho, list);
    } else if (g.type === "sketch") {
      n = sgHistoryRows(g, row, histWho, list);
    } else if (g.type === "duel") {
      (g.rounds || []).forEach((r: GL) => {
        n++;
        const rw = row("Round " + r.n);
        players.forEach((p: GL) => {
          const seg = el("span", "hist-seg");
          seg.appendChild(histWho(p));
          const t = (r.throws || {})[p.name];
          seg.appendChild(el("span", "hist-act", t ? (THROW_EMOJI[t] || "") + " " + t : "— no throw"));
          rw.appendChild(seg);
        });
        if (r.winner) {
          const pill = el("span", "hist-pill win", r.winner + " takes it");
          pill.style.borderColor = byName(r.winner).hex;
          pill.style.color = byName(r.winner).hex;
          rw.appendChild(pill);
        } else rw.appendChild(el("span", "hist-pill tie", "Tie"));
        list.appendChild(rw);
      });
    } else if (g.type === "battleship") {
      (g.log || []).forEach((ln: GL) => {
        n++;
        if (ln.by) {
          const rw = row("Turn " + ln.tick);
          const seg = el("span", "hist-seg");
          seg.appendChild(histWho(byName(ln.by)));
          seg.appendChild(el("span", "hist-act", "fires"));
          rw.appendChild(seg);
          rw.appendChild(el("span", "hist-cell", ln.cell || ""));
          if (ln.sunk) rw.appendChild(el("span", "hist-pill sunk", "Sunk · " + ln.sunk));
          else if (ln.result === "hit") rw.appendChild(el("span", "hist-pill hit", "Hit"));
          else rw.appendChild(el("span", "hist-pill miss", "Miss"));
          list.appendChild(rw);
        } else {
          const rw = row("Turn " + ln.tick);
          rw.appendChild(el("span", "hist-note", ln.text || ""));
          list.appendChild(rw);
        }
      });
    } else {
      const byTick = new Map<number, GL[]>();
      (g.move_log || []).forEach((m: GL) => {
        if (!byTick.has(m.tick)) byTick.set(m.tick, []);
        (byTick.get(m.tick) as GL[]).push(m);
      });
      const notes = new Map<number, string[]>();
      (g.log || []).forEach((ln: GL) => {
        if (/^Tick \d+:/.test(ln.text || "")) return;
        if (!notes.has(ln.tick)) notes.set(ln.tick, []);
        (notes.get(ln.tick) as string[]).push(ln.text || "");
      });
      const ticks = Array.from(new Set([...byTick.keys(), ...notes.keys()])).sort((a, b) => a - b);
      ticks.forEach((t) => {
        const moves = byTick.get(t) || [];
        if (moves.length) {
          n++;
          const rw = row("Tick " + t);
          moves.forEach((m: GL) => {
            const seg = el("span", "hist-seg");
            seg.appendChild(histWho(byName(m.name)));
            seg.appendChild(el("span", "hist-act", (DIR_ARROW[m.dir] || "") + " " + (m.dir || "")));
            if (!m.submitted) seg.appendChild(el("span", "hist-src", "clock"));
            rw.appendChild(seg);
          });
          list.appendChild(rw);
        }
        (notes.get(t) || []).forEach((txt) => {
          n++;
          const rw = row("Tick " + t);
          rw.appendChild(el("span", "hist-note", txt));
          list.appendChild(rw);
        });
      });
    }
    if (!n) list.appendChild(el("div", "hist-empty", "No history yet - the record writes itself as the match plays."));
    return list;
  }

  // A compact signature of the per-viewer block. The arena render
  // keys include it: without it, a refetch that changed only the
  // viewer's own state (spectator -> player, your turn arriving)
  // never repainted, and the arena could sit on "Spectating".
  function youSig(g: GL): string {
    const y = g.you;
    if (!y) return "-";
    return [y.playing ? 1 : 0, y.queued || "", y.alive === false ? 0 : 1, y.your_turn ? 1 : 0, y.phase || ""].join(",");
  }



  /* The games' 3D views, lazy-loaded like the Duel's: one host per open
     arena, kept across repaints; the scene shows the last round and plays
     new ones in, the inputs and the numbers stay in the page. The arena
     view is 3D only (2026-11-20, the owner's call: the 2D views and the
     2D/3D toggles are retired); a device without WebGL gets a note and
     plays with the controls under it. */
  const KIND3D: Record<string, Kind3d> = {
    frontlines: { cls: "fl-3d-host", load: () => import("./frontlines/FrontlinesArena3D"), comp: null },
    coderace: { cls: "cr-3d-host", load: () => import("./coderace/CodeRaceArena3D"), comp: null },
    fourinarow: { cls: "c4-3d-host", load: () => import("./fourinarow/FourArena3D"), comp: null },
    trust: { cls: "tr-3d-host", load: () => import("./trust/TrustArena3D"), comp: null },
    auction: { cls: "au-3d-host", load: () => import("./auction/AuctionArena3D"), comp: null },
    twotruths: { cls: "tt-3d-host", load: () => import("./twotruths/TwoTruthsArena3D"), comp: null },
    corpse: { cls: "ec-3d-host", load: () => import("./corpse/CorpseArena3D"), comp: null },
    twenty: { cls: "tq-3d-host", load: () => import("./twenty/TwentyArena3D"), comp: null },
    werewolf: { cls: "ww-3d-host", load: () => import("./werewolf/WerewolfArena3D"), comp: null },
    lettergrid: { cls: "lg-3d-host", load: () => import("./lettergrid/LetterArena3D"), comp: null },
    trivia: { cls: "tv-3d-host", load: () => import("./trivia/TriviaArena3D"), comp: null },
    sketch: { cls: "sg-3d-host", load: () => import("./sketch/SketchArena3D"), comp: null },
    liarsdice: { cls: "ld-3d-host", load: () => import("./liarsdice/LiarsArena3D"), comp: null },
  };
  function load3d(kind: string) {
    const k = KIND3D[kind]!;
    if (!k.comp)
      k.comp = k
        .load()
        .then((m) => m.default)
        .catch((e) => {
          k.comp = null;
          throw e;
        });
    return k.comp;
  }
  function drop3d() {
    const gv = gameView;
    if (gv && gv.r3d) {
      const m = gv.r3d;
      gv.r3d = null;
      gv.r3dCommit = null;
      m.root.unmount();
    }
  }
  // the open arena's host (made on first use), already in the page order
  function host3d(kind: string): Host3d {
    const gv = gameView!;
    if (!gv.r3d) gv.r3d = makeHost3d("lc-board-big lc-3d-host " + KIND3D[kind]!.cls);
    return gv.r3d;
  }
  function paint3d(kind: string, g: GL, h: Host3d, extra?: Partial<Arena3dProps>) {
    const gv = gameView;
    if (!gv || h.failed) return;
    const seq = (gv.r3dSeq = (gv.r3dSeq || 0) + 1);
    const current = () => !!gameView && gameView === gv && gv.r3dSeq === seq && gv.r3d === h;
    load3d(kind).then(
      (Comp) => {
        if (!current() || h.failed) return;
        h.root.render(
          createElement(Comp, {
            g,
            me: opts.meName(),
            aspect: h.host.clientWidth / Math.max(1, h.host.clientHeight),
            onReady: () => ready3d(h),
            registerCommit: (fn: (() => void) | null) => {
              if (gameView === gv) gv.r3dCommit = fn;
            },
            ...(extra || {}),
          })
        );
      },
      (err) => {
        if (current()) fail3d(h, err);
      }
    );
  }












  /* ---- The 3D arenas ----
     Every arena is a 3D scene (react-three-fiber; the 2D views and
     the 2D/3D toggles were retired 2026-11-20). Each scene module is
     a dynamic import, so three.js ships in lazy chunks that load only
     when an arena opens. The React root lives on the gameView object:
     renderGameView clears and rebuilds the wrap on every state change,
     and re-appending the same host element keeps the canvas (and the
     camera) alive across repaints. */
  /* The 3D host (2026-11-12): a mount for the scene's React root plus
     a status layer over it - "Loading the 3D arena…" until the scene
     draws its first frame, or what went wrong with a Reload button.
     There is no 2D fallback by design (3D is the arena view): a
     failure says so and offers the reload that cures the usual cause
     - a deploy deleted the hashed chunk this page was built against.
     A WebGL failure reaches onUncaughtError (R3F rethrows it into the
     tree) instead of surfacing as an uncaught page error over a blank
     box. A failed host stops repainting until it is rebuilt. */
  function makeHost3d(cls: string): Host3d {
    const host = el("div", cls);
    const mount = el("div", "arena3d-mount");
    const status = el("div", "arena3d-status");
    status.setAttribute("role", "status");
    host.appendChild(mount);
    host.appendChild(status);
    const h: Host3d = { root: null as unknown as Root, host, status, failed: false };
    h.root = createRoot(mount, { onUncaughtError: (err) => fail3d(h, err) });
    status.textContent = "Loading the 3D arena…";
    // no WebGL at all: say so at once (no scene will ever draw, and a
    // reload will not help) - the game plays on with the controls below
    if (!webglOk()) {
      h.failed = true;
      host.classList.add("no-3d");
      status.textContent = "3D isn't available on this device - play with the controls below.";
    }
    return h;
  }
  let webglKnown: boolean | null = null;
  function webglOk(): boolean {
    if (webglKnown != null) return webglKnown;
    try {
      const c = document.createElement("canvas");
      webglKnown = !!(c.getContext("webgl2") || c.getContext("webgl"));
    } catch {
      webglKnown = false;
    }
    return webglKnown;
  }
  function ready3d(h: Host3d) {
    if (!h.failed) h.status.hidden = true;
  }
  function fail3d(h: Host3d, err: unknown) {
    h.failed = true;
    const msg = String((err && (err as Error).message) || err || "");
    if (/webgl/i.test(msg)) {
      h.host.classList.add("no-3d");
      h.status.textContent = "3D isn't available on this device - play with the controls below.";
      h.status.hidden = false;
      return;
    }
    const text = /import|module|fetch|load/i.test(msg) ? "The 3D arena didn't load - the site was probably just updated." : "The 3D arena hit an error.";
    h.status.textContent = "";
    h.status.appendChild(el("div", "", text));
    const b = el("button", "btn sm", "Reload") as HTMLButtonElement;
    b.type = "button";
    b.addEventListener("click", () => location.reload());
    h.status.appendChild(b);
    h.status.hidden = false;
  }

  let lc3dComp: Promise<ComponentType<{ g: GL; me?: string; aspect?: number; onReady?: () => void; onSteer?: (dir: string) => void }>> | null = null;
  function loadLc3d() {
    // A failed import is not remembered: the next paint tries again.
    if (!lc3dComp)
      lc3dComp = import("./lightcycles/LcArena3D")
        .then((m) => m.default)
        .catch((e) => {
          lc3dComp = null;
          throw e;
        });
    return lc3dComp;
  }
  function dropLc3d() {
    const gv = gameView;
    if (gv && gv.lc3d) {
      const m = gv.lc3d;
      gv.lc3d = null;
      m.root.unmount();
    }
  }
  function paintLc3d(g: GL, h: Host3d) {
    const gv = gameView;
    if (!gv || h.failed) return;
    const seq = (gv.lc3dSeq = (gv.lc3dSeq || 0) + 1);
    // A newer paint, a closed viewer or a toggle-off supersedes us.
    const current = () => !!gameView && gameView === gv && gv.lc3dSeq === seq && gv.lc3d === h;
    loadLc3d().then(
      (Comp) => {
        if (!current() || h.failed) return;
        h.root.render(
          createElement(Comp, {
            g,
            me: opts.meName(),
            aspect: h.host.clientWidth / Math.max(1, h.host.clientHeight),
            onReady: () => ready3d(h),
            // tap a marker on the board to steer, as on the pad
            onSteer:
              g.you && g.you.playing && g.you.alive && g.status === "running"
                ? (dir: string) => {
                    void sendMove(g.id, dir, gv.wrap.querySelector(".lc-note") as HTMLElement | null);
                  }
                : undefined,
          })
        );
      },
      (err) => {
        if (current()) fail3d(h, err);
      }
    );
  }

  /* ---- Battleship 3D board (R3F, 2026-11-12) ----
     Same bridge pattern as the Light Cycles scene: ./BsArena3D is a
     dynamic import (three.js stays in the lazy chunk), and the React
     root lives on gameView so re-appending the host keeps the canvas
     alive across repaints. The component receives the per-viewer state
     plus a fire callback wired to sendMove. */
  let bs3dComp: Promise<
    ComponentType<{ g: GL; me: string; aspect?: number; onFire?: (label: string, target?: string) => void; onReady?: () => void; placing?: BsPlacing }>
  > | null = null;
  function loadBs3d() {
    // A failed import is not remembered: the next paint tries again.
    if (!bs3dComp)
      bs3dComp = import("./battleship/BsArena3D")
        .then((m) => m.default)
        .catch((e) => {
          bs3dComp = null;
          throw e;
        });
    return bs3dComp;
  }
  function dropBs3d() {
    const gv = gameView;
    if (gv && gv.bs3d) {
      const m = gv.bs3d;
      gv.bs3d = null;
      gv.bsFire = null;
      gv.bsPlace = null;
      m.root.unmount();
    }
  }
  function paintBs3d(g: GL, h: Host3d) {
    const gv = gameView;
    if (!gv || h.failed) return;
    const seq = (gv.bs3dSeq = (gv.bs3dSeq || 0) + 1);
    // A newer paint, a closed viewer or a toggle-off supersedes us.
    const current = () => !!gameView && gameView === gv && gv.bs3dSeq === seq && gv.bs3d === h;
    loadBs3d().then(
      (Comp) => {
        if (!current() || h.failed) return;
        h.root.render(
          createElement(Comp, {
            g,
            me: opts.meName(),
            aspect: h.host.clientWidth / Math.max(1, h.host.clientHeight),
            onFire: (label: string, target?: string) => {
              if (gameView && gameView.bsFire) gameView.bsFire(label, target);
            },
            placing: gv.bsPlace || undefined,
            onReady: () => ready3d(h),
          })
        );
      },
      (err) => {
        if (current()) fail3d(h, err);
      }
    );
  }
  /* The fleet strips under the scene: each captain's sizes still afloat. */
  function bsStrips3d(g: GL, fleets: { label: string; hex: string; sunk: number[] }[]): HTMLElement {
    const strips = el("div", "bs-strips3d");
    fleets.forEach((f) => {
      const item = el("div", "bs-strip3d");
      item.appendChild(el("span", "bs-strip3d-label", f.label));
      item.appendChild(fleetStrip(f.hex, f.sunk, undefined, g.fleet_sizes));
      strips.appendChild(item);
    });
    return strips;
  }
  // Battleship: remember the focused element inside the scene before the
  // wrap is emptied (bsScene hands focus back to it).
  function rememberBsFocus() {
    const act = document.activeElement;
    bsRefocus = gameView && gameView.bs3d && act instanceof HTMLElement && gameView.bs3d.host.contains(act) ? act : null;
  }
  /* The scene (two captains side by side, a free-for-all in rows),
     with what follows it right under it. */
  function bsScene(g: GL, wrap: HTMLElement, under?: HTMLElement) {
    if (!gameView) return;
    if (!gameView.bs3d) gameView.bs3d = makeHost3d("lc-board-big lc-3d-host bs-3d-host");
    wrap.appendChild(gameView.bs3d.host);
    if (bsRefocus && bsRefocus.isConnected) {
      try {
        bsRefocus.focus({ preventScroll: true });
      } catch {
        // focus is a nicety
      }
    }
    bsRefocus = null;
    if (under) wrap.appendChild(under);
    paintBs3d(g, gameView.bs3d);
  }

  /* ---- Duel 3D arena (2026-11-13) ----
     Same bridge as the other two: ./DuelArena3D is a dynamic import,
     and the React root lives on gameView so repaints keep the canvas. The scene replaces the two DOM duel
     sides; the throw pad, the verdict banner and the scoreboard stay
     in the page - the scene shows, the page acts. */
  let duel3dComp: Promise<
    ComponentType<{ g: GL; me?: string; aspect?: number; onReady?: () => void; registerCommit?: (fn: ((t: string) => void) | null) => void }>
  > | null = null;
  function loadDuel3d() {
    if (!duel3dComp)
      duel3dComp = import("./duel/DuelArena3D")
        .then((m) => m.default)
        .catch((e) => {
          duel3dComp = null;
          throw e;
        });
    return duel3dComp;
  }
  function dropDuel3d() {
    const gv = gameView;
    if (gv && gv.duel3d) {
      const m = gv.duel3d;
      gv.duel3d = null;
      gv.duelCommit = null;
      m.root.unmount();
    }
  }
  function paintDuel3d(g: GL, h: Host3d) {
    const gv = gameView;
    if (!gv || h.failed) return;
    const seq = (gv.duel3dSeq = (gv.duel3dSeq || 0) + 1);
    const current = () => !!gameView && gameView === gv && gv.duel3dSeq === seq && gv.duel3d === h;
    loadDuel3d().then(
      (Comp) => {
        if (!current() || h.failed) return;
        h.root.render(
          createElement(Comp, {
            g,
            me: opts.meName(),
            aspect: h.host.clientWidth / Math.max(1, h.host.clientHeight),
            onReady: () => ready3d(h),
            // the scene seals a tapped throw at once, before the request
            registerCommit: (fn: ((t: string) => void) | null) => {
              if (gameView === gv) gv.duelCommit = fn;
            },
          })
        );
      },
      (err) => {
        if (current()) fail3d(h, err);
      }
    );
  }

  function renderGameView(g: GL, force?: boolean) {
    if (!gameView || gameView.id !== g.id) return;
    // Each game's arena view, from the registry (registry.ts); a match
    // from before the type field is Light Cycles, the first game.
    (GAME_VIEWS[g.type] || GAME_VIEWS.lightcycles)!(ctx, g, force);
  }


  // One request per match at a time: a frame burst (Light Cycles ticks)
  // or the poll landing mid-fetch rides the request already out.
  const fetching = new Map<number, Promise<void>>();
  function fetchGame(id: number): Promise<void> {
    const cur = fetching.get(id);
    if (cur) return cur;
    const p = (async () => {
      try {
        const d = await client.game(id);
        if (!d.game) return;
        const prev = cache.get(id);
        cache.set(id, d.game);
        // listeners (cards, the Games tab's /games reload, the title
        // badge) only hear about real changes, not every poll
        if (!prev || prev.__frameOnly || JSON.stringify(prev) !== JSON.stringify(d.game)) notify();
        if (gameView && gameView.id === id) renderGameView(d.game);
      } catch {
        // a failed refresh keeps the last known state
      } finally {
        fetching.delete(id);
      }
    })();
    fetching.set(id, p);
    return p;
  }

  function openGame(id: number, type?: string) {
    dropLc3d();
    dropBs3d();
    dropDuel3d();
    drop3d();
    gameRenderKey = "";
    const kind = type || cache.get(id)?.type;
    opts.openViewer(
      matchTitle(kind || "lightcycles", id),
      (vb) => {
        const wrap = el("div", "lc-arena" + (kind ? " kind-" + kind : ""));
        wrap.appendChild(el("div", "lc-meta", "Loading the arena…"));
        vb.appendChild(wrap);
        gameView = { id, wrap };
        void fetchGame(id);
      },
      null,
      { onHelp: opts.showHelp ? () => opts.showHelp!(kind || cache.get(id)?.type || "lightcycles") : undefined }
    );
    if (gameViewTimer) clearInterval(gameViewTimer);
    gameViewTimer = window.setInterval(() => {
      if (gameView) void fetchGame(gameView.id);
    }, 8000);
  }

  // Round-clock bars drain on a 1s ticker, in cards and arena alike.
  window.setInterval(() => {
    document.querySelectorAll("[data-duel-deadline]").forEach((b) => setClockBar(b as HTMLElement));
    document.querySelectorAll("[data-turn-deadline]").forEach((b) => setTurnClock(b as HTMLElement));
  }, 1000);
  // Cards stay fresh on a slow poll, like the current app. A finished
  // or called-off match never changes again, so only live ones (and
  // entries known only from a frame) are polled.
  window.setInterval(() => {
    if (document.hidden) return;
    cache.forEach((g, id) => {
      if (g.__frameOnly || g.status === "lobby" || g.status === "running") void fetchGame(id);
    });
  }, 20000);

  return {
    cache,
    subscribe(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    getVersion: () => version,
    fetch: fetchGame,
    onFrame(game: GL) {
      if (!game || !game.id) return;
      if (game.trails || game.type === "duel" || game.type === "battleship" || game.type === "frontlines" || game.type === "coderace" || game.type === "fourinarow" || game.type === "trust" || game.type === "lettergrid" || game.type === "trivia" || game.type === "sketch" || game.type === "auction" || game.type === "liarsdice" || game.type === "twotruths" || game.type === "corpse" || game.type === "twenty" || game.type === "werewolf") {
        // A frame carries the public summary, not the full state.
        // Merge it over the cached entry instead of replacing it:
        // replacing wiped the per-viewer fields (you, rounds, log)
        // the cards and arenas render from, so a live update could
        // show the wrong "your move" state until the next poll.
        // The merge keeps the cached per-viewer fields (you, rounds,
        // log), which the frame cannot update: for a match you play in,
        // and for one known only from this frame (its card message may
        // land after it), fetch the full state right away so "your
        // move" and Accept/Decline are never stale.
        const prev = cache.get(game.id);
        cache.set(game.id, prev ? Object.assign({}, prev, game) : Object.assign({ __frameOnly: true }, game));
        notify();
        const me = (opts.meName() || "").toLowerCase();
        const playing = !!me && (game.players || []).some((p: GL) => String(p.name || "").toLowerCase() === me);
        if (!prev || prev.__frameOnly || playing) {
          void fetchGame(game.id);
          return;
        }
      }
      if (gameView && gameView.id === game.id) void fetchGame(game.id);
    },
    openGame,
    respond: (id: number, accept: boolean) => respond(id, accept, null),
    rematch: (g: GL) => sendRematch(g, null),
    // Matches waiting on the signed-in member right now: a lobby seat
    // unaccepted, a duel throw unmade, a fleet unplaced, a shot
    // untaken, a tick unridden. Drives the title badge + chime.
    meName() {
      return opts.meName() || "";
    },
    awaitingCount() {
      const me = opts.meName();
      if (!me) return 0;
      let n = 0;
      cache.forEach((g) => {
        const mine = (g.players || []).find((p: GL) => p.name === me);
        if (!mine) return;
        if (g.status === "lobby") {
          if (!mine.accepted) n++;
          return;
        }
        if (g.status !== "running") return;
        if (g.type === "duel") {
          if (!mine.thrown) n++;
        } else if (g.type === "frontlines") {
          if (!mine.committed) n++;
        } else if (g.type === "coderace") {
          if (!mine.committed && !mine.solved && !mine.out) n++;
        } else if (g.type === "fourinarow" || g.type === "liarsdice") {
          if (g.turn_of === me) n++;
        } else if (g.type === "twotruths") {
          if (g.phase === "write" ? g.teller === me : g.teller !== me && !mine.committed) n++;
        } else if (g.type === "corpse") {
          if (g.phase === "write" ? g.turn_of === me : !mine.committed) n++;
        } else if (g.type === "twenty") {
          if (g.phase === "ask" ? g.answerer !== me : g.answerer === me) n++;
        } else if (g.type === "trivia") {
          if (g.phase === "answer" ? g.asker !== me && !mine.committed : g.asker === me) n++;
        } else if (g.type === "sketch") {
          if (g.phase === "draw" ? g.artist === me : g.phase === "guess" ? g.artist !== me && !mine.committed : false) n++;
        } else if (g.type === "werewolf") {
          const y = g.you || {};
          if (mine.alive && (g.phase === "day" ? !mine.voted : !!wwVerb(y.role) && !y.act)) n++;
        } else if (g.type === "trust" || g.type === "lettergrid") {
          if (!mine.committed && !mine.out) n++;
        } else if (g.type === "auction") {
          if (!mine.committed && (mine.budget || 0) > 0) n++;
        } else if (g.type === "battleship") {
          if (g.phase === "setup" ? !mine.placed : g.turn_of === me) n++;
        } else if (mine.alive && !mine.moved) n++;
      });
      return n;
    },
    viewerClosed() {
      dropLc3d();
      dropBs3d();
      dropDuel3d();
      drop3d();
      if (gameViewTimer) {
        clearInterval(gameViewTimer);
        gameViewTimer = 0;
      }
      gameView = null;
    },
  };
}
