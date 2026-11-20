import type { RoomClient } from "@chat/shared";
import { createElement, type ComponentType } from "react";
import { createRoot, type Root } from "react-dom/client";
import { el, toast } from "../lib";
import { matchTitle } from "./catalog";
import { FL_HILLS, flField, flHistoryRows, flLastRound, flPlanner } from "./frontlines";
import { crBoard, crHistoryRows, crInput, crSecretEl } from "./coderace";
import { c4Board, c4HistoryRows, c4Seats } from "./fourinarow";
import { trGrid, trHistoryRows, trLastRound, trPlanner, trScores, type TrDraft } from "./trust";
import { auBid, auHistoryRows, auLastRound, auLot, auPlayers, auResult } from "./auction";
import { ldBidNow, ldBidder, ldCounts, ldCup, ldHistoryRows, ldLastRound, ldRound, ldTable } from "./liarsdice";
import { ttHistoryRows, ttLastRound, ttReveal, ttScores, ttStatements, ttWriter, type TtDraft } from "./twotruths";
import { ecHistoryRows, ecStory, ecStrip, ecWriter, ecWriters } from "./corpse";
import { tqAnswerer, tqAsker, tqBudget, tqHistoryRows, tqLastRound, tqLog, tqReveal, tqScores } from "./twenty";
import { wwAction, wwEvents, wwHistoryRows, wwPlayers, wwRoleCard, wwTalk, wwVerb } from "./werewolf";
import { lgDir, lgHistoryRows, lgLastRound, lgPanel, lgReveal, lgScores, lgTap, lgTopWords, lgYours, type LgDraft, type LgPanel } from "./lettergrid";
import {
  battleshipBoard,
  bsGrid,
  clockBar,
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
} from "./render";
import type { ViewerApi } from "../shell/viewer";

/* A 3D arena's host element, its React root and its status layer
   (see makeHost3d). */
type Host3d = { root: Root; host: HTMLElement; status: HTMLElement; failed: boolean };

// Games — Light Cycles and Duel — ported from the current app. The
// card board and the arena render from game state (GET /games/:id,
// kept fresh by stream "game" frames and slow polls). Cards are
// React components subscribed to this store; the arena is native
// DOM inside the viewer, exactly like the current app — the pad
// calls the moves endpoint with the viewer's own invite. The board
// itself is display-only SVG.

/* eslint-disable @typescript-eslint/no-explicit-any */

// Battleship impact dressing: the newest shot (by turn) is animated
// once per match - later repaints keep only its white ring. The map
// remembers which turn each match last celebrated.
const bsSeenMove = new Map<number, number>();

// Tap-to-place drafts, kept outside the render so a state refresh
// mid-placement does not lift the hulls already laid.
const bsDrafts = new Map<number, { placed: { start: string; dir: string; size: number }[]; orient: string }>();

// The cells a hull would occupy from a bow cell, or null when it
// would run off the board.
function bsShipCells(start: string, dir: string, size: number, bw?: number, bh?: number): string[] | null {
  const x0 = start.charCodeAt(0) - 65;
  const y0 = parseInt(start.slice(1), 10) - 1;
  const cells: string[] = [];
  for (let i = 0; i < size; i++) {
    const x = dir === "H" ? x0 + i : x0;
    const y = dir === "H" ? y0 : y0 + i;
    if (x > (bw || 10) - 1 || y > (bh || 10) - 1) return null;
    cells.push(String.fromCharCode(65 + x) + (y + 1));
  }
  return cells;
}
function bsIsNewMove(g: GL): boolean {
  const lm = g && g.last_move;
  if (!lm) return false;
  const seen = bsSeenMove.get(g.id) || 0;
  if (lm.turn > seen) {
    bsSeenMove.set(g.id, lm.turn);
    return true;
  }
  return false;
}

function bsInnerGrid(frame: HTMLElement): HTMLElement | null {
  if (frame.classList.contains("bs-grid")) return frame;
  return frame.querySelector(".bs-grid");
}

function bsCellAt(frame: HTMLElement, label: string): HTMLElement | null {
  const inner = bsInnerGrid(frame);
  if (!inner) return null;
  // The column count rides in the grid's inline style (repeat(N, 1fr),
  // set by the board builder from the match's w). The old fixed 10
  // landed every marker past row 1 on the wrong cell in skirmish,
  // whose boards are 8 wide.
  const m = /repeat\((\d+)/.exec(inner.style.gridTemplateColumns || "");
  const w = m && m[1] ? parseInt(m[1], 10) : 10;
  const idx = label.charCodeAt(0) - 65 + (parseInt(label.slice(1), 10) - 1) * w;
  return (inner.children[idx] as HTMLElement) || null;
}

// Ring (and, on first sight, burst or splash) the cell the last shot
// landed on, in the grid of the captain whose waters took it.
function markLastShot(grid: HTMLElement, g: GL, ownerName: string, fresh: boolean) {
  const lm = g && g.last_move;
  if (!lm || lm.by === ownerName) return;
  // In a free-for-all the shot names its target: ring it only on
  // that captain's board, not on every rival's.
  if (lm.target && lm.target !== ownerName) return;
  const cell = bsCellAt(grid, lm.cell);
  if (!cell) return;
  cell.classList.add("bs-last");
  if (fresh) cell.classList.add(lm.result === "hit" ? "bs-boom" : "bs-splash");
}

// On first sight of a sinking, play the sinking on the ship the last
// shot just finished: its cells flash and settle into the wreck.
function markSinking(grid: HTMLElement, ships: GL[], g: GL, ownerName: string, fresh: boolean) {
  const lm = g && g.last_move;
  if (!fresh || !lm || !lm.sunk || lm.by === ownerName) return;
  const ship = (ships || []).filter((s: GL) => s.size === lm.sunk && (s.cells || []).indexOf(lm.cell) >= 0)[0];
  if (!ship) return;
  ship.cells.forEach((c: string) => {
    const cell = bsCellAt(grid, c);
    if (cell) cell.classList.add("bs-sinking");
  });
}

// The arena banner announcing the last shot, duel-verdict style.
function bsBanner(g: GL, fresh: boolean): HTMLElement | null {
  const lm = g && g.last_move;
  if (!lm) return null;
  const b = el("div", "duel-verdict bs-verdict" + (lm.result === "hit" ? "" : " clash"));
  b.appendChild(el("span", "v-icons", lm.result === "hit" ? "💥" : "💦"));
  b.appendChild(el("span", "", lastMoveText(g)));
  if (lm.sunk) b.style.borderColor = "#f97316";
  if (fresh) b.classList.add("reveal-in");
  return b;
}

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

export function createGameStore(opts: {
  client: RoomClient;
  meName: () => string;
  openViewer: ViewerApi["open"];
  // the ? in the arena header: How to play for this game
  showHelp?: (game: string) => void;
}): GameStore {
  const { client } = opts;
  const cache = new Map<number, GL>();
  const listeners = new Set<() => void>();
  let version = 0;
  const notify = () => {
    version++;
    listeners.forEach((fn) => fn());
  };

  let gameView: {
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
    lgPanel?: LgPanel | null;
    bsFire?: ((label: string) => void) | null;
  } | null = null;
  let gameViewTimer = 0;
  let gameRenderKey = "";

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

  async function sendMove(id: number, dir: string, note: HTMLElement | null) {
    if (note) note.textContent = "Queuing " + dir + "…";
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
    if (g.type === "duel" || g.type === "frontlines" || g.type === "coderace" || g.type === "trust" || g.type === "auction" || g.type === "liarsdice" || g.type === "twotruths" || g.type === "twenty" || g.type === "lettergrid") return (g.rounds || []).length;
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

  function renderDuelView(g: GL, force?: boolean) {
    if (!gameView) return;
    const key =
      g.status +
      "|" +
      g.round +
      "|" +
      (g.players || []).map((p: GL) => (p.wins || 0) + (p.thrown ? 1 : 0) + (p.accepted ? 1 : 0)).join("") +
      "|" +
      ((g.you && g.you.queued) || "") +
      "|" +
      youSig(g) +
      "|" +
      ((gameView && gameView.tab) || "game");
    if (!force && key === gameRenderKey) return;
    gameRenderKey = key;
    const wrap = gameView.wrap;
    wrap.textContent = "";
    wrap.appendChild(el("div", "lc-meta", gameMetaText(g)));
    const wb = winnerBanner(g);
    if (wb) wrap.appendChild(wb);
    const rr = resultRow(g);
    if (rr) wrap.appendChild(rr);
    const tb = turnBanner(g);
    if (tb) wrap.appendChild(tb);
    if (g.status === "finished" && g.h2h && g.h2h.tally) {
      const h2hline = (g.players || []).map((p: GL) => p.name + " " + (g.h2h.tally[p.name] || 0)).join(" · ");
      wrap.appendChild(el("div", "duel-h2h", "Head-to-head in this room — " + h2hline));
    }
    wrap.appendChild(arenaTabs(g));
    if (gameView.tab === "history") {
      dropDuel3d();
      wrap.appendChild(historyList(g));
      return;
    }
    const players0 = g.players || [];
    const in3d = players0.length === 2 && g.status !== "lobby";
    // In 3D the status line and the throw pad sit right under the scene
    // (the action next to the view - on a phone the pad must stay on
    // screen); the scoreboard and the rest follow.
    let slot: HTMLElement | null = null;
    if (in3d) {
      if (!gameView.duel3d) gameView.duel3d = makeHost3d("lc-board-big lc-3d-host duel-3d-host");
      wrap.appendChild(gameView.duel3d.host);
      paintDuel3d(g, gameView.duel3d);
      slot = el("div", "duel-slot");
      wrap.appendChild(slot);
    } else dropDuel3d();
    const put = (n: HTMLElement) => (slot || wrap).appendChild(n);
    const big = el("div", "lc-board-big" + (in3d ? " duel-board-under" : ""));
    big.appendChild(duelBoard(g, true));
    wrap.appendChild(big);
    const tends = duelTendencies(g);
    if (tends.length) {
      const tw = el("div", "duel-tend");
      tends.forEach((t) => {
        const row = el("div", "duel-tend-row");
        const nm = el("span", "duel-tend-name", t.name);
        nm.style.color = t.hex;
        row.appendChild(nm);
        row.appendChild(el("span", "", t.line));
        tw.appendChild(row);
      });
      wrap.appendChild(tw);
    }
    const note = el("div", "lc-note", "");
    const players = g.players || [];
    const rounds = g.rounds || [];
    if (g.status === "lobby") {
      wrap.appendChild(lobbyPanel(g, note));
      wrap.appendChild(note);
    }
    if (g.status === "running" && players.length === 2) {
      // who's up and the round clock are the turn banner's, at the top
      if (g.you && g.you.playing) {
        const hint = arenaHint("duel", "Pick a throw — it stays hidden until both lock in.");
        if (hint) wrap.appendChild(hint);
      }
    }
    if (rounds.length) {
      const last = rounds[rounds.length - 1];
      const v = roundVerdict(last, players);
      const banner = el("div", "duel-verdict" + (v.tie ? " clash" : ""));
      const iconsWrap = el("span", "v-icons");
      players.forEach((p: GL) => {
        const t = (last.throws || {})[p.name];
        const cls = v.tie ? "tie" : last.winner === p.name ? "winner" : "loser";
        iconsWrap.appendChild(el("span", "v-icon " + cls, t ? THROW_EMOJI[t] || "" : "—"));
      });
      banner.appendChild(iconsWrap);
      banner.appendChild(el("span", "", v.text + " · " + duelScoreLine(g)));
      if (!v.tie && last.winner) {
        const wp = players.filter((p: GL) => p.name === last.winner)[0];
        if (wp) banner.style.borderColor = wp.hex;
      }
      if (gameView.lastRounds != null && rounds.length > gameView.lastRounds) {
        banner.classList.add("reveal-in");
        iconsWrap.classList.add("flip");
      }
      wrap.appendChild(banner);
    }
    gameView.lastRounds = rounds.length;
    if (g.you && g.you.playing && g.status === "running") {
      const pad = el("div", "duel-pad2" + (!g.you.queued ? " your-move" : ""));
      ["rock", "paper", "scissors"].forEach((t) => {
        const b = el("button", "duel-tile" + (g.you.queued === t ? " queued" : ""));
        b.type = "button";
        b.appendChild(el("span", "t-icon", THROW_EMOJI[t] || ""));
        b.appendChild(el("span", "t-name", t));
        b.appendChild(el("span", "t-beats", THROW_BEATS[t] || ""));
        b.appendChild(el("span", "t-lock", g.you.queued === t ? "LOCKED" : ""));
        b.addEventListener("click", () => {
          if (gameView && gameView.duelCommit) gameView.duelCommit(t);
          void sendMove(g.id, t, note);
        });
        pad.appendChild(b);
      });
      put(pad);
      note.textContent = g.you.queued
        ? "Thrown: " + g.you.queued + " - tap another to change it before the round resolves."
        : "Your throw: pick one. It stays hidden until your rival has thrown too.";
      put(note);
    } else if (g.status === "running") {
      note.textContent = "Spectating - throws stay hidden until each round resolves.";
      wrap.appendChild(note);
    }
  }

  /* Frontlines (2026-11-19): the field (the last resolved round, or the
     open field), the turn banner, and for a commander the planner. The
     planner's draft lives on gameView so a poll or the rival's commit
     never wipes a half-made plan; it resets when a new round opens. */
  function renderFrontlinesView(g: GL, force?: boolean) {
    if (!gameView) return;
    const gv = gameView;
    const you = g.you || { playing: false };
    const queued: number[] | null = Array.isArray(you.queued) ? you.queued : null;
    if (!gv.flDraft || gv.flDraft.round !== g.round) {
      gv.flDraft = { round: g.round, vals: queued ? queued.slice() : [0, 0, 0, 0, 0] };
    }
    const key = [
      g.status,
      g.round,
      (g.players || []).map((p: GL) => (p.wins || 0) + "" + (p.committed ? 1 : 0) + (p.accepted ? 1 : 0)).join(""),
      queued ? queued.join("/") : "",
      gv.flDraft.vals.join("/"),
      youSig(g),
      gv.tab || "game",
    ].join("|");
    if (!force && key === gameRenderKey) return;
    gameRenderKey = key;
    const wrap = gv.wrap;
    wrap.textContent = "";
    wrap.appendChild(el("div", "lc-meta", gameMetaText(g)));
    const wb = winnerBanner(g);
    if (wb) wrap.appendChild(wb);
    const rr = resultRow(g);
    if (rr) wrap.appendChild(rr);
    const tb = turnBanner(g);
    if (tb) wrap.appendChild(tb);
    wrap.appendChild(arenaTabs(g));
    if (gv.tab === "history") {
      drop3d();
      wrap.appendChild(historyList(g));
      return;
    }
    const note = el("div", "lc-note", "");
    if (g.status === "lobby") {
      drop3d();
      wrap.appendChild(lobbyPanel(g, note));
      wrap.appendChild(note);
      return;
    }
    // the scene plays the last resolved round; the score, the planner and
    // the round in numbers follow under it
    const h = host3d("frontlines");
    wrap.appendChild(h.host);
    paint3d("frontlines", g, h);
    const score = el("div", "fl-score");
    (g.players || []).forEach((p: GL, i: number) => {
      if (i) score.appendChild(el("span", "fl-vs", "vs"));
      const s = el("span", "fl-score-p");
      const d = el("span", "hist-dot");
      d.style.background = p.hex;
      s.appendChild(d);
      s.appendChild(el("span", "fl-score-name", p.name));
      s.appendChild(el("span", "fl-score-n", String(p.wins || 0)));
      if (g.status === "running") s.appendChild(el("span", "fl-score-st", p.committed ? "committed ✓" : "planning…"));
      score.appendChild(s);
    });
    wrap.appendChild(score);
    const field = flField(g, { me: opts.meName() });
    const last = flLastRound(g);
    const fieldCap = el("div", "fl-cap", last ? "Round " + last.n + " in numbers" : g.status === "running" ? "Round " + g.round + " · splits stay hidden until both are in" : "");
    if (g.status === "running" && you.playing) {
      const hint = arenaHint("frontlines", "Put your troops where you think your rival won't. Hold 3 of the 5 hills to take the round.");
      if (hint) wrap.appendChild(hint);
      wrap.appendChild(
        flPlanner(
          g,
          gv.flDraft.vals,
          (v) => {
            if (gameView !== gv) return;
            gv.flDraft = { round: g.round, vals: v };
            renderFrontlinesView(g, true);
          },
          (v) => {
            // the scene seals and sounds the lock-in at once, before the request
            if (gv.r3dCommit) gv.r3dCommit();
            void sendMove(g.id, v.join(","), note);
          }
        )
      );
      note.textContent = queued
        ? "Locked in: " + queued.join("/") + ". You can change it until your rival commits too."
        : "Your split stays hidden until your rival has committed too.";
      wrap.appendChild(note);
    } else if (g.status === "running") {
      note.textContent = "Spectating - splits stay hidden until each round resolves.";
      wrap.appendChild(note);
    }
    wrap.appendChild(fieldCap);
    wrap.appendChild(field);
  }

  /* The games' 3D views, lazy-loaded like the Duel's: one host per open
     arena, kept across repaints; the scene shows the last round and plays
     new ones in, the inputs and the numbers stay in the page. The arena
     view is 3D only (2026-11-20, the owner's call: the 2D views and the
     2D/3D toggles are retired); a device without WebGL gets a note and
     plays with the controls under it. */
  type Arena3dProps = { g: GL; me?: string; aspect?: number; onReady?: () => void; registerCommit?: (fn: (() => void) | null) => void; onDrop?: (col: number) => void; draft?: { word: string; path: number[][] | null } | null; onCell?: (r: number, c: number) => void };
  type Kind3d = { cls: string; load: () => Promise<{ default: ComponentType<Arena3dProps> }>; comp: Promise<ComponentType<Arena3dProps>> | null };
  const KIND3D: Record<string, Kind3d> = {
    frontlines: { cls: "fl-3d-host", load: () => import("./FrontlinesArena3D"), comp: null },
    coderace: { cls: "cr-3d-host", load: () => import("./CodeRaceArena3D"), comp: null },
    fourinarow: { cls: "c4-3d-host", load: () => import("./FourArena3D"), comp: null },
    trust: { cls: "tr-3d-host", load: () => import("./TrustArena3D"), comp: null },
    auction: { cls: "au-3d-host", load: () => import("./AuctionArena3D"), comp: null },
    twotruths: { cls: "tt-3d-host", load: () => import("./TwoTruthsArena3D"), comp: null },
    corpse: { cls: "ec-3d-host", load: () => import("./CorpseArena3D"), comp: null },
    twenty: { cls: "tq-3d-host", load: () => import("./TwentyArena3D"), comp: null },
    werewolf: { cls: "ww-3d-host", load: () => import("./WerewolfArena3D"), comp: null },
    lettergrid: { cls: "lg-3d-host", load: () => import("./LetterArena3D"), comp: null },
    liarsdice: { cls: "ld-3d-host", load: () => import("./LiarsArena3D"), comp: null },
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
  /* Code Race (2026-11-19): the race board (your lane with your guesses,
     then each rival's feedback), the secret once it's over, and for a
     racer still racing the guess input. The draft lives on gameView so a
     poll or a rival's guess never wipes it; it resets each round. */
  function renderCodeRaceView(g: GL, force?: boolean) {
    if (!gameView) return;
    const gv = gameView;
    const me = opts.meName();
    const you = g.you || { playing: false };
    const queued: string | null = you.queued || null;
    if (!gv.crDraft || gv.crDraft.round !== g.round) gv.crDraft = { round: g.round, v: queued || "" };
    const key = [
      g.status,
      g.round,
      (g.rounds || []).length,
      (g.players || []).map((p: GL) => (p.committed ? 1 : 0) + "" + (p.solved || 0) + (p.out ? 1 : 0) + (p.accepted ? 1 : 0)).join(""),
      queued || "",
      g.mode === "words" ? "" : gv.crDraft.v,
      youSig(g),
      gv.tab || "game",
    ].join("|");
    if (!force && key === gameRenderKey) return;
    gameRenderKey = key;
    // a repaint while typing a word keeps the field's focus
    const typing = document.activeElement && (document.activeElement as HTMLElement).classList.contains("cr-word");
    const wrap = gv.wrap;
    wrap.textContent = "";
    wrap.appendChild(el("div", "lc-meta", gameMetaText(g)));
    const wb = winnerBanner(g);
    if (wb) wrap.appendChild(wb);
    const rr = resultRow(g);
    if (rr) wrap.appendChild(rr);
    const tb = turnBanner(g);
    if (tb) wrap.appendChild(tb);
    wrap.appendChild(arenaTabs(g));
    if (gv.tab === "history") {
      drop3d();
      wrap.appendChild(historyList(g));
      return;
    }
    const note = el("div", "lc-note", "");
    if (g.status === "lobby") {
      drop3d();
      wrap.appendChild(lobbyPanel(g, note));
      wrap.appendChild(note);
      return;
    }
    // the vault comes first, the input right under it
    const h = host3d("coderace");
    wrap.appendChild(h.host);
    paint3d("coderace", g, h);
    const sec = crSecretEl(g);
    if (sec) wrap.appendChild(sec);
    const racing = g.status === "running" && you.playing && !you.solved && !you.out;
    if (racing) {
      const hint = arenaHint(
        "coderace",
        g.mode === "words"
          ? "Everyone is cracking the same word. You see rivals' colours, never their letters."
          : "Everyone is cracking the same code. You see rivals' pegs, never their colours."
      );
      if (hint) wrap.appendChild(hint);
      wrap.appendChild(
        crInput(
          g,
          gv.crDraft.v,
          (v) => {
            if (gameView !== gv) return;
            gv.crDraft = { round: g.round, v };
            renderCodeRaceView(g, true);
          },
          (v) => {
            if (gameView !== gv) return;
            gv.crDraft = { round: g.round, v };
            // the scene seals and sounds the guess at once, before the request
            if (gv.r3dCommit) gv.r3dCommit();
            void sendMove(g.id, g.mode === "words" ? v : v.split("").join(" "), note);
          },
          (v) => {
            if (gameView === gv) gv.crDraft = { round: g.round, v };
          }
        )
      );
      note.textContent = queued
        ? "You can change your guess until the round resolves."
        : g.mode === "words"
          ? "Any real " + (g.length || 5) + "-letter word. Rivals see only your colours until the race ends."
          : "Rivals see only your pegs until the race ends.";
      wrap.appendChild(note);
    } else if (g.status === "running" && !you.playing) {
      note.textContent = "Spectating - guesses stay hidden until the race ends; feedback shows each round.";
      wrap.appendChild(note);
    }
    wrap.appendChild(crBoard(g, { me }));
    if (typing) {
      const f = wrap.querySelector(".cr-word") as HTMLInputElement | null;
      if (f) {
        f.focus();
        const n = f.value.length;
        f.setSelectionRange(n, n);
      }
    }
  }

  /* The auction (2026-11-19): the lot under the hammer, the bidders, your
     sealed bid, then the last lot's result. The draft lives on gameView
     so a poll never wipes it; it resets each lot. */
  function renderAuctionView(g: GL, force?: boolean) {
    if (!gameView) return;
    const gv = gameView;
    const me = opts.meName();
    const you = g.you || { playing: false };
    const queued: number | null = you.queued == null ? null : Number(you.queued);
    if (!gv.auDraft || gv.auDraft.round !== g.round) gv.auDraft = { round: g.round, v: queued != null ? queued : 0 };
    const key = [
      g.status,
      g.round,
      (g.rounds || []).length,
      (g.players || []).map((p: GL) => (p.committed ? 1 : 0) + "" + (p.accepted ? 1 : 0) + ":" + (p.budget || 0) + ":" + (p.won || 0)).join(","),
      queued == null ? "" : queued,
      gv.auDraft.v,
      youSig(g),
      gv.tab || "game",
    ].join("|");
    if (!force && key === gameRenderKey) return;
    gameRenderKey = key;
    const wrap = gv.wrap;
    wrap.textContent = "";
    wrap.appendChild(el("div", "lc-meta", gameMetaText(g)));
    const wb = winnerBanner(g);
    if (wb) wrap.appendChild(wb);
    const rr = resultRow(g);
    if (rr) wrap.appendChild(rr);
    const tb = turnBanner(g);
    if (tb) wrap.appendChild(tb);
    wrap.appendChild(arenaTabs(g));
    if (gv.tab === "history") {
      drop3d();
      wrap.appendChild(historyList(g));
      return;
    }
    const note = el("div", "lc-note", "");
    if (g.status === "lobby") {
      drop3d();
      wrap.appendChild(lobbyPanel(g, note));
      wrap.appendChild(note);
      return;
    }
    const h = host3d("auction");
    wrap.appendChild(h.host);
    paint3d("auction", g, h);
    wrap.appendChild(auLot(g));
    if (g.status === "running" && you.playing && (you.budget || 0) > 0) {
      const hint = arenaHint("auction", "Every lot is worth the same. Bid low on the ones others want; save for the ones they don't.");
      if (hint) wrap.appendChild(hint);
      wrap.appendChild(
        auBid(
          g,
          gv.auDraft.v,
          (v) => {
            if (gameView !== gv) return;
            gv.auDraft = { round: g.round, v };
            renderAuctionView(g, true);
          },
          (v) => {
            if (gameView !== gv) return;
            gv.auDraft = { round: g.round, v };
            if (gv.r3dCommit) gv.r3dCommit();
            void sendMove(g.id, v ? String(v) : "pass", note);
          }
        )
      );
      note.textContent = queued != null ? "You can change your bid until the lot resolves." : "Bids are sealed until everyone has bid.";
      wrap.appendChild(note);
    } else if (g.status === "running" && !you.playing) {
      note.textContent = "Spectating - bids are opened together when each lot resolves.";
      wrap.appendChild(note);
    }
    wrap.appendChild(auPlayers(g, me));
    const last = auLastRound(g);
    wrap.appendChild(auResult(g, last));
  }

  /* Trust (2026-11-19): the scoreboard, your choices (a Cooperate /
     Defect pair per rival), then the last round's who-trusted-whom grid.
     The draft lives on gameView so a poll never wipes it; it resets each
     round. */
  function renderTrustView(g: GL, force?: boolean) {
    if (!gameView) return;
    const gv = gameView;
    const me = opts.meName();
    const you = g.you || { playing: false };
    const queued: TrDraft | null = you.queued || null;
    if (!gv.trDraft || gv.trDraft.round !== g.round) gv.trDraft = { round: g.round, d: queued ? Object.assign({}, queued) : {} };
    const key = [
      g.status,
      g.round,
      (g.rounds || []).length,
      (g.players || []).map((p: GL) => (p.committed ? 1 : 0) + "" + (p.out ? 1 : 0) + (p.accepted ? 1 : 0) + ":" + (p.score || 0)).join(","),
      JSON.stringify(queued || {}),
      JSON.stringify(gv.trDraft.d),
      youSig(g),
      gv.tab || "game",
    ].join("|");
    if (!force && key === gameRenderKey) return;
    gameRenderKey = key;
    const wrap = gv.wrap;
    wrap.textContent = "";
    wrap.appendChild(el("div", "lc-meta", gameMetaText(g)));
    const wb = winnerBanner(g);
    if (wb) wrap.appendChild(wb);
    const rr = resultRow(g);
    if (rr) wrap.appendChild(rr);
    const tb = turnBanner(g);
    if (tb) wrap.appendChild(tb);
    wrap.appendChild(arenaTabs(g));
    if (gv.tab === "history") {
      drop3d();
      wrap.appendChild(historyList(g));
      return;
    }
    const note = el("div", "lc-note", "");
    if (g.status === "lobby") {
      drop3d();
      wrap.appendChild(lobbyPanel(g, note));
      wrap.appendChild(note);
      return;
    }
    // the table comes first; the scores, choices and grid follow
    const h = host3d("trust");
    wrap.appendChild(h.host);
    paint3d("trust", g, h);
    wrap.appendChild(trScores(g, me));
    if (g.status === "running" && you.playing && !you.out) {
      const hint = arenaHint("trust", "Every pairing scores on its own: both cooperate 3 each, a betrayal 5 to 0, both defect 1 each. The last round is a secret.");
      if (hint) wrap.appendChild(hint);
      wrap.appendChild(
        trPlanner(
          g,
          gv.trDraft.d,
          (d) => {
            if (gameView !== gv) return;
            gv.trDraft = { round: g.round, d };
            renderTrustView(g, true);
          },
          (dir) => {
            if (gameView !== gv) return;
            if (gv.r3dCommit) gv.r3dCommit();
            void sendMove(g.id, dir, note);
          }
        )
      );
      note.textContent = queued ? "You can change your choices until the round resolves." : "Your choices stay secret until everyone has chosen.";
      wrap.appendChild(note);
    } else if (g.status === "running" && !you.playing) {
      note.textContent = "Spectating - choices are revealed together when each round resolves.";
      wrap.appendChild(note);
    }
    const last = trLastRound(g);
    wrap.appendChild(el("div", "fl-cap", last ? "Round " + last.n + " · who trusted whom" : ""));
    wrap.appendChild(trGrid(g, last, me));
  }

  /* Letter Grid (2026-11-20, 3D only): the grid first (tap tiles to trace
     a word), then the word panel, the scores, your words, and the last
     round's words. The draft lives on gameView so a poll never wipes it;
     typing updates the panel in place and repaints only the scene, so
     the field keeps focus. A sent word clears the draft once the server
     shows it sealed. */
  function renderLetterView(g: GL, force?: boolean) {
    if (!gameView) return;
    const gv = gameView;
    const me = opts.meName();
    const you = g.you || { playing: false };
    const queued: GL = you.queued || null;
    if (!gv.lgDraft || gv.lgDraft.round !== g.round) gv.lgDraft = { round: g.round, word: "", path: null, tapped: false };
    if (queued && gv.lgDraft.word && gv.lgDraft.word === queued.word) gv.lgDraft = { round: g.round, word: "", path: null, tapped: false };
    const key = [
      g.status,
      g.round,
      (g.rounds || []).length,
      (g.players || []).map((p: GL) => (p.committed ? 1 : 0) + "" + (p.out ? 1 : 0) + (p.accepted ? 1 : 0) + ":" + (p.score || 0)).join(","),
      JSON.stringify(queued || {}),
      youSig(g),
      gv.tab || "game",
    ].join("|");
    if (!force && key === gameRenderKey) return;
    gameRenderKey = key;
    const hadFocus = !!(gv.lgPanel && document.activeElement === gv.lgPanel.input);
    gv.lgPanel = null;
    const wrap = gv.wrap;
    wrap.textContent = "";
    wrap.appendChild(el("div", "lc-meta", gameMetaText(g)));
    const wb = winnerBanner(g);
    if (wb) wrap.appendChild(wb);
    const rr = resultRow(g);
    if (rr) wrap.appendChild(rr);
    const tb = turnBanner(g);
    if (tb) wrap.appendChild(tb);
    wrap.appendChild(arenaTabs(g));
    if (gv.tab === "history") {
      drop3d();
      wrap.appendChild(historyList(g));
      return;
    }
    const note = el("div", "lc-note", "");
    if (g.status === "lobby") {
      drop3d();
      wrap.appendChild(lobbyPanel(g, note));
      wrap.appendChild(note);
      return;
    }
    const canPlay = g.status === "running" && you.playing && !you.out;
    const h = host3d("lettergrid");
    wrap.appendChild(h.host);
    const paintScene = () => {
      const d = gv.lgDraft;
      paint3d("lettergrid", g, h, {
        draft: d && d.path ? { word: d.word, path: d.path } : null,
        onCell: canPlay
          ? (r: number, c: number) => {
              if (gameView !== gv || !gv.lgDraft) return;
              gv.lgDraft = lgTap(g, gv.lgDraft, r, c);
              if (gv.lgPanel) gv.lgPanel.setDraft(gv.lgDraft);
              paintScene();
            }
          : undefined,
      });
    };
    paintScene();
    if (canPlay) {
      const hint = arenaHint("lettergrid", "Trace a word through touching tiles - diagonals count. Cells nobody has used yet are yours for a bonus point each.");
      if (hint) wrap.appendChild(hint);
      const panel = lgPanel(
        g,
        gv.lgDraft,
        (d) => {
          if (gameView !== gv) return;
          gv.lgDraft = d;
          paintScene();
        },
        (d) => {
          if (gameView !== gv) return;
          if (gv.r3dCommit) gv.r3dCommit();
          void sendMove(g.id, lgDir(d), note);
        }
      );
      gv.lgPanel = panel;
      wrap.appendChild(panel.el);
      if (hadFocus) panel.input.focus();
      note.textContent = queued ? "Sealed until everyone has a word in - send another to change it." : "Your word stays secret until the round resolves.";
      wrap.appendChild(note);
    } else if (g.status === "running" && !you.playing) {
      note.textContent = "Spectating - the words are revealed together when each round resolves.";
      wrap.appendChild(note);
    }
    wrap.appendChild(lgScores(g, me));
    const yours = lgYours(g);
    if (yours) wrap.appendChild(yours);
    const rv = lgReveal(g, lgLastRound(g), me);
    if (rv) wrap.appendChild(rv);
    if (g.status === "finished") {
      const top = lgTopWords(g);
      if (top) wrap.appendChild(top);
    }
  }

  /* Four in a Row (2026-11-19): who plays which disc, then the board -
     on your turn the column heads are the drop buttons. A drop goes out
     at once; the turn passes when the server answers. */
  function renderFourView(g: GL, force?: boolean) {
    if (!gameView) return;
    const gv = gameView;
    const me = opts.meName();
    const you = g.you || { playing: false };
    const key = [g.status, g.turn, g.turn_of || "", (g.board || []).join("/"), (g.players || []).map((p: GL) => (p.accepted ? 1 : 0) + "" + (p.timeouts || 0)).join(""), youSig(g), gv.tab || "game"].join("|");
    if (!force && key === gameRenderKey) return;
    gameRenderKey = key;
    const wrap = gv.wrap;
    wrap.textContent = "";
    wrap.appendChild(el("div", "lc-meta", gameMetaText(g)));
    const wb = winnerBanner(g);
    if (wb) wrap.appendChild(wb);
    const rr = resultRow(g);
    if (rr) wrap.appendChild(rr);
    const tb = turnBanner(g);
    if (tb) wrap.appendChild(tb);
    wrap.appendChild(arenaTabs(g));
    if (gv.tab === "history") {
      drop3d();
      wrap.appendChild(historyList(g));
      return;
    }
    const note = el("div", "lc-note", "");
    if (g.status === "lobby") {
      drop3d();
      wrap.appendChild(lobbyPanel(g, note));
      wrap.appendChild(note);
      return;
    }
    const myTurn = g.status === "running" && you.playing && you.your_turn;
    const drop = (col: number) => {
      if (gameView !== gv) return;
      if (gv.r3dCommit) gv.r3dCommit();
      void sendMove(g.id, String(col), note);
    };
    // the scene is the board (its columns take a tap too); the seats and
    // the 1-7 drop buttons stay in the page under it
    const h = host3d("fourinarow");
    wrap.appendChild(h.host);
    paint3d("fourinarow", g, h, myTurn ? { onDrop: drop } : {});
    wrap.appendChild(c4Seats(g, me));
    if (myTurn) {
      const hint = arenaHint("fourinarow", "Tap a column on the board (or a number) to drop your disc.");
      if (hint) wrap.appendChild(hint);
      const under = el("div", "c4-under");
      under.appendChild(c4Board(g, { open: you.legal_moves || [], onDrop: drop, headsOnly: true }));
      wrap.appendChild(under);
    }
    if (g.status === "running" && !you.playing) note.textContent = "Spectating - the board updates as each disc drops.";
    else if (g.status === "running" && you.playing && !myTurn) note.textContent = "Your rival is thinking. You'll get a nudge when it's your turn.";
    if (note.textContent) wrap.appendChild(note);
  }

  /* Liar's Dice: the standing bid, your cup, the bid builder on your
     turn, the table, and the last round with every cup opened. */
  function renderLiarsView(g: GL, force?: boolean) {
    if (!gameView) return;
    const gv = gameView;
    const me = opts.meName();
    const you = g.you || { playing: false };
    const myTurn = g.status === "running" && you.playing && you.your_turn;
    const total = g.dice_total || 0;
    const wild = !!g.ones_wild;
    const lowFace = wild ? 2 : 1;
    if (myTurn && (!gv.ldDraft || gv.ldDraft.turn !== g.turn)) {
      // start from the classic raise (one more of the same face), or, to
      // open, one of the face you hold most of
      const b = g.bid;
      let qty = 1;
      let face = lowFace;
      if (b && b.qty + 1 <= total) {
        qty = b.qty + 1;
        face = b.face;
      } else if (b) {
        qty = b.qty;
        face = Math.min(6, b.face + 1);
      } else {
        let best = -1;
        for (let f = lowFace; f <= 6; f++) {
          const k = ((you.dice || []) as number[]).filter((d) => ldCounts(d, f, wild)).length;
          if (k > best) {
            best = k;
            face = f;
          }
        }
        qty = Math.max(1, best);
      }
      gv.ldDraft = { turn: g.turn, qty: Math.max(1, Math.min(total, qty)), face };
    }
    const dr = gv.ldDraft;
    const key = [g.status, g.turn, g.round, g.turn_of || "", g.bid ? g.bid.qty + "x" + g.bid.face + g.bid.by : "", (g.players || []).map((p: GL) => (p.accepted ? 1 : 0) + "" + (p.dice || 0) + (p.out ? 1 : 0) + (p.timeouts || 0)).join(""), ((you.dice || []) as number[]).join(""), (g.rounds || []).length, youSig(g), gv.tab || "game", dr ? dr.qty + "x" + dr.face : ""].join("|");
    if (!force && key === gameRenderKey) return;
    gameRenderKey = key;
    const wrap = gv.wrap;
    wrap.textContent = "";
    wrap.appendChild(el("div", "lc-meta", gameMetaText(g)));
    const wb = winnerBanner(g);
    if (wb) wrap.appendChild(wb);
    const rr = resultRow(g);
    if (rr) wrap.appendChild(rr);
    const tb = turnBanner(g);
    if (tb) wrap.appendChild(tb);
    wrap.appendChild(arenaTabs(g));
    if (gv.tab === "history") {
      drop3d();
      wrap.appendChild(historyList(g));
      return;
    }
    const note = el("div", "lc-note", "");
    if (g.status === "lobby") {
      drop3d();
      wrap.appendChild(lobbyPanel(g, note));
      wrap.appendChild(note);
      return;
    }
    const h = host3d("liarsdice");
    wrap.appendChild(h.host);
    paint3d("liarsdice", g, h);
    wrap.appendChild(ldBidNow(g));
    if (g.status === "running" && you.playing && !you.out && (you.dice || []).length) wrap.appendChild(ldCup(g));
    if (myTurn && dr) {
      const hint = arenaHint("liarsdice", "Raise the count, or the face at the same count - or call liar if you think the table can't hold the bid.");
      if (hint) wrap.appendChild(hint);
      wrap.appendChild(
        ldBidder(
          g,
          dr,
          (d) => {
            if (gameView !== gv) return;
            gv.ldDraft = { turn: g.turn, qty: d.qty, face: d.face };
            renderLiarsView(g, true);
          },
          (dir) => {
            if (gameView !== gv) return;
            if (gv.r3dCommit) gv.r3dCommit();
            void sendMove(g.id, dir, note);
          },
          () => {
            if (gameView !== gv) return;
            if (gv.r3dCommit) gv.r3dCommit();
            void sendMove(g.id, "liar", note);
          }
        )
      );
    }
    wrap.appendChild(ldTable(g, me));
    wrap.appendChild(ldRound(g, ldLastRound(g)));
    if (g.status === "running" && !you.playing) note.textContent = "Spectating - every cup stays hidden until someone calls liar.";
    else if (g.status === "running" && you.playing && you.out) note.textContent = "You're out of dice - watch the rest play it out.";
    else if (g.status === "running" && you.playing && !myTurn) note.textContent = "Not your turn. You'll get a nudge when the bid comes round to you.";
    if (note.textContent) wrap.appendChild(note);
  }

  /* Two Truths and a Lie: the campfire (3D only), then the storyteller's
     form or the statements to vote on, the scores and the last reveal. */
  function renderTwoTruthsView(g: GL, force?: boolean) {
    if (!gameView) return;
    const gv = gameView;
    const me = opts.meName();
    const you = g.you || { playing: false };
    const writing = g.status === "running" && g.phase === "write" && you.playing && you.teller;
    if (writing && (!gv.ttDraft || gv.ttDraft.round !== g.round)) gv.ttDraft = { round: g.round, s: ["", "", ""], lie: 0 };
    const dr = gv.ttDraft;
    const key = [g.status, g.round, g.phase || "", g.teller || "", (g.players || []).map((p: GL) => (p.accepted ? 1 : 0) + "" + (p.committed ? 1 : 0) + (p.score || 0)).join(","), (g.statements || []).join("|"), youSig(g), you.vote == null ? "" : you.vote, you.lie || "", (g.rounds || []).length, gv.tab || "game", writing && dr ? dr.lie : ""].join("|");
    if (!force && key === gameRenderKey) return;
    gameRenderKey = key;
    const wrap = gv.wrap;
    wrap.textContent = "";
    wrap.appendChild(el("div", "lc-meta", gameMetaText(g)));
    const wb = winnerBanner(g);
    if (wb) wrap.appendChild(wb);
    const rr = resultRow(g);
    if (rr) wrap.appendChild(rr);
    const tb = turnBanner(g);
    if (tb) wrap.appendChild(tb);
    wrap.appendChild(arenaTabs(g));
    if (gv.tab === "history") {
      drop3d();
      wrap.appendChild(historyList(g));
      return;
    }
    const note = el("div", "lc-note", "");
    if (g.status === "lobby") {
      drop3d();
      wrap.appendChild(lobbyPanel(g, note));
      wrap.appendChild(note);
      return;
    }
    const h = host3d("twotruths");
    wrap.appendChild(h.host);
    paint3d("twotruths", g, h);
    if (writing && dr) {
      const hint = arenaHint("twotruths", "The best lies are almost true. The table sees your three statements shuffled.");
      if (hint) wrap.appendChild(hint);
      wrap.appendChild(
        ttWriter(
          g,
          dr,
          (d) => {
            if (gameView !== gv) return;
            gv.ttDraft = d;
            renderTwoTruthsView(g, true);
          },
          (d) => {
            if (gameView !== gv) return;
            gv.ttDraft = d;
            if (gv.r3dCommit) gv.r3dCommit();
            void sendMove(g.id, JSON.stringify({ statements: d.s.map((x) => x.trim()), lie: d.lie }), note);
          }
        )
      );
    } else if (g.status === "running" && g.phase === "vote") {
      const canVote = you.playing && !you.teller;
      wrap.appendChild(
        ttStatements(
          g,
          canVote
            ? (n) => {
                if (gameView !== gv) return;
                if (gv.r3dCommit) gv.r3dCommit();
                void sendMove(g.id, String(n), note);
              }
            : undefined
        )
      );
    }
    wrap.appendChild(ttScores(g, me));
    wrap.appendChild(ttReveal(g, ttLastRound(g)));
    if (g.status === "running" && !you.playing) note.textContent = "Spectating - the lie stays secret until the votes are in.";
    else if (g.status === "running" && g.phase === "write" && !you.teller) note.textContent = g.teller + " is writing. You'll get a nudge when the statements are up.";
    if (note.textContent) wrap.appendChild(note);
  }

  /* Exquisite Corpse: the desk (3D only), then your turn (the fold and
     your segment), the turn strip, the story once revealed (with the
     favourite vote), and the writers. */
  function renderCorpseView(g: GL, force?: boolean) {
    if (!gameView) return;
    const gv = gameView;
    const me = opts.meName();
    const you = g.you || { playing: false };
    const writing = g.status === "running" && g.phase === "write" && you.playing && you.writer;
    if (writing && (!gv.ecDraft || gv.ecDraft.turn !== g.turn)) gv.ecDraft = { turn: g.turn, text: "" };
    const key = [g.status, g.phase || "", g.turn, g.turn_of || "", g.segments || 0, (g.players || []).map((p: GL) => (p.accepted ? 1 : 0) + "" + (p.committed ? 1 : 0) + (p.out ? 1 : 0) + (p.skips || 0) + "." + (p.segments || 0)).join(","), (you.tail || "").length, youSig(g), you.vote == null ? "" : you.vote, (g.story || []).length, (g.honours || []).join("-"), (g.beats || []).length, gv.tab || "game"].join("|");
    if (!force && key === gameRenderKey) return;
    gameRenderKey = key;
    const wrap = gv.wrap;
    wrap.textContent = "";
    wrap.appendChild(el("div", "lc-meta", gameMetaText(g)));
    const wb = winnerBanner(g);
    if (wb) wrap.appendChild(wb);
    const rr = resultRow(g);
    if (rr) wrap.appendChild(rr);
    const tb = turnBanner(g);
    if (tb) wrap.appendChild(tb);
    wrap.appendChild(arenaTabs(g));
    if (gv.tab === "history") {
      drop3d();
      wrap.appendChild(historyList(g));
      return;
    }
    const note = el("div", "lc-note", "");
    if (g.status === "lobby") {
      drop3d();
      wrap.appendChild(lobbyPanel(g, note));
      wrap.appendChild(note);
      return;
    }
    const h = host3d("corpse");
    wrap.appendChild(h.host);
    paint3d("corpse", g, h);
    if (writing && gv.ecDraft) {
      const hint = arenaHint("corpse", "Carry on from the one segment you can see - contradictions are part of the fun. Nobody corrects anything.");
      if (hint) wrap.appendChild(hint);
      wrap.appendChild(
        ecWriter(g, gv.ecDraft, (text) => {
          if (gameView !== gv) return;
          if (gv.r3dCommit) gv.r3dCommit();
          void sendMove(g.id, text, note);
        })
      );
    }
    wrap.appendChild(ecStrip(g));
    if (g.story) {
      const canVote = g.status === "running" && g.phase === "vote" && you.playing;
      wrap.appendChild(
        ecStory(
          g,
          canVote
            ? (n) => {
                if (gameView !== gv) return;
                if (gv.r3dCommit) gv.r3dCommit();
                void sendMove(g.id, String(n), note);
              }
            : undefined
        )
      );
    }
    wrap.appendChild(ecWriters(g, me));
    if (g.status === "running" && g.phase === "write" && !writing) note.textContent = (you.playing ? "The story stays folded until the last turn - " : "Spectating - the story stays folded until the last turn. ") + (you.playing ? "you'll get a nudge when it's yours." : "");
    if (note.textContent) wrap.appendChild(note);
  }

  /* Twenty Questions: the box and candles (3D only), then the answerer's
     or the questioner's controls, the budget, the Q/A log, the scores
     and the last reveal. */
  function renderTwentyView(g: GL, force?: boolean) {
    if (!gameView) return;
    const gv = gameView;
    const me = opts.meName();
    const you = g.you || { playing: false };
    const dkey = g.round + ":" + (g.asked || 0);
    if (!gv.tqDraft || gv.tqDraft.key !== dkey) gv.tqDraft = { key: dkey, text: "" };
    const key = [g.status, g.round, g.phase || "", g.answerer || "", g.asked || 0, (g.qa || []).map((x: GL) => (x.a || "") + (x.flagged ? "f" : "")).join(","), (g.players || []).map((p: GL) => (p.accepted ? 1 : 0) + "" + (p.score || 0)).join(","), youSig(g), you.secret || "", (g.rounds || []).length, gv.tab || "game"].join("|");
    if (!force && key === gameRenderKey) return;
    gameRenderKey = key;
    const wrap = gv.wrap;
    wrap.textContent = "";
    wrap.appendChild(el("div", "lc-meta", gameMetaText(g)));
    const wb = winnerBanner(g);
    if (wb) wrap.appendChild(wb);
    const rr = resultRow(g);
    if (rr) wrap.appendChild(rr);
    const tb = turnBanner(g);
    if (tb) wrap.appendChild(tb);
    wrap.appendChild(arenaTabs(g));
    if (gv.tab === "history") {
      drop3d();
      wrap.appendChild(historyList(g));
      return;
    }
    const note = el("div", "lc-note", "");
    if (g.status === "lobby") {
      drop3d();
      wrap.appendChild(lobbyPanel(g, note));
      wrap.appendChild(note);
      return;
    }
    const h = host3d("twenty");
    wrap.appendChild(h.host);
    paint3d("twenty", g, h);
    const send = (dir: string) => {
      if (gameView !== gv) return;
      if (gv.r3dCommit) gv.r3dCommit();
      void sendMove(g.id, dir, note);
    };
    if (g.status === "running" && you.playing && you.answerer) wrap.appendChild(tqAnswerer(g, send));
    else if (g.status === "running" && you.playing && g.phase === "ask" && gv.tqDraft) {
      const hint = arenaHint("twenty", "Halve the possibilities each time: is it alive, is it bigger than a breadbox, is it made by people?");
      if (hint) wrap.appendChild(hint);
      wrap.appendChild(tqAsker(g, gv.tqDraft, send));
    }
    if (g.status === "running" && g.phase !== "secret") wrap.appendChild(tqBudget(g));
    if (g.status === "running") wrap.appendChild(tqLog(g));
    wrap.appendChild(tqScores(g, me));
    wrap.appendChild(tqReveal(g, tqLastRound(g)));
    if (g.status === "running" && !you.playing) note.textContent = "Spectating - the secret stays in the box until the round ends.";
    if (note.textContent) wrap.appendChild(note);
  }

  /* Werewolf: the village (3D only), then your role, your night action
     or day vote, the discussion panel (town square; the den for wolves),
     the timeline and the villagers. */
  function renderWerewolfView(g: GL, force?: boolean) {
    if (!gameView) return;
    const gv = gameView;
    const me = opts.meName();
    const you = g.you || { playing: false };
    if (!gv.wwDraft) gv.wwDraft = { town: "", den: "" };
    const key = [g.status, g.phase || "", g.night, g.day, (g.players || []).map((p: GL) => (p.accepted ? 1 : 0) + "" + (p.alive ? 1 : 0) + (p.voted ? 1 : 0) + (p.role || "")).join(","), JSON.stringify(g.votes || null), (g.talk || []).length, (g.den || []).length, (g.events || []).length, youSig(g), you.role || "", you.act || "", you.vote || "", (you.checks || []).length, JSON.stringify(you.pack_picks || null), gv.tab || "game"].join("|");
    if (!force && key === gameRenderKey) return;
    gameRenderKey = key;
    const wrap = gv.wrap;
    wrap.textContent = "";
    wrap.appendChild(el("div", "lc-meta", gameMetaText(g)));
    const wb = winnerBanner(g);
    if (wb) wrap.appendChild(wb);
    const rr = resultRow(g);
    if (rr) wrap.appendChild(rr);
    const tb = turnBanner(g);
    if (tb) wrap.appendChild(tb);
    wrap.appendChild(arenaTabs(g));
    if (gv.tab === "history") {
      drop3d();
      wrap.appendChild(historyList(g));
      return;
    }
    const note = el("div", "lc-note", "");
    if (g.status === "lobby") {
      drop3d();
      wrap.appendChild(lobbyPanel(g, note));
      wrap.appendChild(note);
      return;
    }
    const h = host3d("werewolf");
    wrap.appendChild(h.host);
    paint3d("werewolf", g, h);
    const send = (dir: string) => {
      if (gameView !== gv) return;
      if (gv.r3dCommit && !/^(say|den):/.test(dir)) gv.r3dCommit();
      void sendMove(g.id, dir, note);
    };
    if (you.playing) wrap.appendChild(wwRoleCard(g));
    const act = wwAction(g, me, send);
    if (act) {
      const hint = arenaHint("werewolf", "Lying is legal for everyone. Watch who pushes a vote, and who goes quiet.");
      if (hint) wrap.appendChild(hint);
      wrap.appendChild(act);
    }
    wrap.appendChild(wwTalk(g, gv.wwDraft, send));
    wrap.appendChild(wwEvents(g));
    wrap.appendChild(wwPlayers(g, me));
    if (g.status === "running" && !you.playing) note.textContent = "Spectating - you see what the village sees: no roles until the dead are counted.";
    if (note.textContent) wrap.appendChild(note);
  }

  function renderBattleshipView(g: GL, force?: boolean) {
    if (!gameView) return;
    const you = g.you || { playing: false };
    const key =
      g.status +
      "|" +
      (g.phase || "") +
      "|" +
      g.turn +
      "|" +
      (g.turn_of || "") +
      "|" +
      (g.players || []).map((p: GL) => (p.accepted ? 1 : 0) + "" + (p.placed ? 1 : 0) + "" + (p.shots || 0) + "" + (p.afloat || 0) + "" + (p.eliminated ? 1 : 0)).join("") +
      "|" +
      (you.fleet ? "fleet" : "") +
      "|" +
      (you.shots ? Object.keys(you.shots).length : 0) +
      "|" +
      (you.targets ? you.targets.map((t: GL) => Object.keys(t.shots || {}).length + "/" + (t.afloat || 0) + (t.eliminated ? "x" : "")).join(",") : "") +
      "|" +
      youSig(g) +
      "|" +
      (g.salvo_left == null ? "" : g.salvo_left) +
      "|" +
      (g.sonar ? g.sonar.turn : "") +
      "|" +
      (g.last_move ? g.last_move.turn : "") +
      "|" +
      ((gameView && gameView.tab) || "game");
    if (!force && key === gameRenderKey) return;
    gameRenderKey = key;
    const wrap = gameView.wrap;
    wrap.textContent = "";
    wrap.appendChild(el("div", "lc-meta", gameMetaText(g)));
    const wb = winnerBanner(g);
    if (wb) wrap.appendChild(wb);
    const rr = resultRow(g);
    if (rr) wrap.appendChild(rr);
    const tb = turnBanner(g);
    if (tb) wrap.appendChild(tb);
    wrap.appendChild(arenaTabs(g));
    const note = el("div", "lc-note", "");
    if (gameView.tab === "history") {
      dropBs3d();
      wrap.appendChild(historyList(g));
      return;
    }
    if (g.status === "lobby") {
      dropBs3d();
      wrap.appendChild(lobbyPanel(g, note));
      wrap.appendChild(note);
      return;
    }
    const players = g.players || [];
    const myName = opts.meName();
    const me = players.filter((p: GL) => p.name === myName)[0];
    const opp = players.filter((p: GL) => p.name !== myName)[0];
    const freshMove = bsIsNewMove(g);
    if (!(you.playing && me && opp && g.phase === "setup" && !you.fleet)) bsDrafts.delete(g.id);
    if (!you.playing || !me || !opp) {
      const big = el("div", "lc-board-big");
      const board = battleshipBoard(g);
      // The arena shows both oceans full size below (the 3D scene or
      // the 2D boards), so the scoreboard's mini boards only repeat
      // them - and on a phone they pushed the real boards below the
      // fold. The feed card keeps them.
      if (g.boards && g.boards.length && (g.phase === "play" || g.status === "finished")) {
        const minis = board.querySelector(".bs-minis");
        if (minis) minis.remove();
      }
      big.appendChild(board);
      wrap.appendChild(big);
      if (g.boards && g.boards.length && (g.phase === "play" || g.status === "finished")) {
        const banner = bsBanner(g, freshMove);
        if (banner) wrap.appendChild(banner);
        if (gameView) gameView.bsFire = null;
        // The 3D arena is a two-board scene: a free-for-all (3+
        // captains) spectates on the boards below - its only view. Two
        // captains get the scene; without WebGL the scene is a note, so
        // the boards follow it.
        if (players.length > 2) dropBs3d();
        else bsScene(g, wrap);
        const boards = el("div", "bs-boards");
        if (players.length > 2 || !webglOk()) g.boards.forEach((b: GL) => {
          const states: Record<string, string> = {};
          Object.keys(b.incoming || {}).forEach((c) => {
            states[c] = b.incoming[c];
          });
          (b.sunk_ships || []).forEach((s: GL) => {
            s.cells.forEach((c: string) => {
              states[c] = "sunk";
            });
          });
          const side = el("div", "bs-side" + (b.eliminated ? " bs-wreck" : ""));
          side.appendChild(el("div", "bs-title", b.name + "'s waters" + (b.eliminated ? " — wreck" : "")));
          side.appendChild(fleetStrip(b.hex, (b.sunk_ships || []).map((s: GL) => s.size), undefined, g.fleet_sizes));
          const grid = bsGrid(states, b.hex, null, b.sunk_ships || [], undefined, g);
          markLastShot(grid, g, b.name, freshMove);
          markSinking(grid, b.sunk_ships || [], g, b.name, freshMove);
          side.appendChild(grid);
          boards.appendChild(side);
        });
        if (boards.childElementCount) wrap.appendChild(boards);
        note.textContent = "Spectating - every shot is public; un-hit ships stay hidden.";
      } else {
        dropBs3d();
        note.textContent = "Spectating - fleets stay hidden; the boards are for their captains.";
      }
      wrap.appendChild(note);
    } else if (g.phase === "setup" && !you.fleet) {
      dropBs3d();
      const big = el("div", "lc-board-big");
      big.appendChild(battleshipBoard(g));
      wrap.appendChild(big);
      let draft = bsDrafts.get(g.id);
      if (!draft) {
        draft = { placed: [], orient: "H" };
        bsDrafts.set(g.id, draft);
      }
      const FLEET: number[] = g.fleet_sizes && g.fleet_sizes.length ? g.fleet_sizes : [5, 4, 3, 3, 2];
      const placedCells = new Set<string>();
      const ships: GL[] = [];
      draft.placed.forEach((p) => {
        const cells = bsShipCells(p.start, p.dir, p.size, g.w, g.h) || [];
        cells.forEach((c) => placedCells.add(c));
        ships.push({ size: p.size, cells });
      });
      const states: Record<string, string> = {};
      placedCells.forEach((c) => {
        states[c] = "ship";
      });
      const nextSize = FLEET[draft.placed.length] || 0;
      const tryPlace = (label: string) => {
        if (!nextSize || !draft) return;
        const cells = bsShipCells(label, draft.orient, nextSize, g.w, g.h);
        if (!cells) {
          note.textContent = "That hull runs off the board from " + label + " - start it closer to the middle, or rotate it.";
          return;
        }
        if (cells.some((c) => placedCells.has(c))) {
          note.textContent = "That hull overlaps one already down - give it clear water.";
          return;
        }
        draft.placed.push({ start: label, dir: draft.orient, size: nextSize });
        note.textContent = "";
        renderBattleshipView(g, true);
      };
      const boards = el("div", "bs-boards");
      const side = el("div", "bs-side");
      side.appendChild(el("div", "bs-title", "Your waters - place your fleet"));
      side.appendChild(bsGrid(states, me.hex, tryPlace, ships, "Place at ", g));
      boards.appendChild(side);
      wrap.appendChild(boards);
      wrap.appendChild(
        el(
          "div",
          "duel-statusline",
          nextSize
            ? "Next hull: your " + nextSize + "-ship, lying " + (draft.orient === "H" ? "horizontal" : "vertical") + " from the cell you tap."
            : "Fleet complete - send it when it looks right."
        )
      );
      const row = el("div", "duel-pad");
      const rot = el("button", "duel-btn", "Rotate hull");
      rot.type = "button";
      rot.addEventListener("click", () => {
        if (!draft) return;
        draft.orient = draft.orient === "H" ? "V" : "H";
        renderBattleshipView(g, true);
      });
      row.appendChild(rot);
      const undo = el("button", "duel-btn quiet", "Undo last hull");
      undo.type = "button";
      undo.addEventListener("click", () => {
        if (!draft || !draft.placed.length) return;
        draft.placed.pop();
        renderBattleshipView(g, true);
      });
      row.appendChild(undo);
      const rnd = el("button", "duel-btn quiet", "Place randomly instead");
      rnd.type = "button";
      rnd.addEventListener("click", () => {
        bsDrafts.delete(g.id);
        void sendMove(g.id, "random", note);
      });
      row.appendChild(rnd);
      if (!nextSize) {
        const go = el("button", "duel-btn", "Place this fleet");
        go.type = "button";
        go.addEventListener("click", () => {
          if (!draft) return;
          const spec = draft.placed.map((p) => p.start + p.dir).join(",");
          bsDrafts.delete(g.id);
          void sendMove(g.id, spec, note);
        });
        row.appendChild(go);
      }
      wrap.appendChild(row);
      if (!note.textContent) note.textContent = "Tap a cell to lay the next hull's bow there. Your fleet stays secret until the shooting starts.";
      wrap.appendChild(note);
    } else if (players.length > 2) {
      // Free-for-all (2026-11-17): your own waters plus one board
      // per rival, each showing YOUR shots at that captain - the
      // board you tap is the target, and the shot goes out as
      // "Name:Cell". Eliminated captains render as wreck charts
      // (no fire). The 3D arena is two-board only, so FFA never
      // routes there: this branch is always the 2D boards.
      dropBs3d();
      if (gameView) gameView.bsFire = null;
      const boards = el("div", "bs-boards");
      const ownStates: Record<string, string> = {};
      (you.fleet || []).forEach((s: GL) => {
        s.cells.forEach((c: string) => {
          ownStates[c] = s.hits.indexOf(c) >= 0 ? (s.sunk ? "sunk" : "hit") : "ship";
        });
      });
      Object.keys(you.incoming || {}).forEach((c) => {
        if (!ownStates[c]) ownStates[c] = "miss";
      });
      const ownWrap = el("div", "bs-side");
      ownWrap.appendChild(el("div", "bs-title", "Your waters" + (you.eliminated ? " — wreck" : "")));
      ownWrap.appendChild(fleetStrip(me.hex, (you.fleet || []).filter((s: GL) => s.sunk).map((s: GL) => s.size), undefined, g.fleet_sizes));
      const ownGrid = bsGrid(ownStates, me.hex, null, you.fleet || [], undefined, g);
      markLastShot(ownGrid, g, myName, freshMove);
      markSinking(ownGrid, you.fleet || [], g, myName, freshMove);
      ownWrap.appendChild(ownGrid);
      boards.appendChild(ownWrap);
      const canFire = g.status === "running" && g.phase === "play" && you.your_turn && !you.eliminated;
      (you.targets || []).forEach((t: GL) => {
        const tStates: Record<string, string> = {};
        Object.keys(t.shots || {}).forEach((c) => {
          tStates[c] = t.shots[c];
        });
        (t.sunk_ships || []).forEach((s: GL) => {
          s.cells.forEach((c: string) => {
            tStates[c] = "sunk";
          });
        });
        const tWrap = el("div", "bs-side" + (t.eliminated ? " bs-wreck" : ""));
        tWrap.appendChild(
          el("div", "bs-title", t.name + "'s waters" + (t.eliminated ? " — wreck" : canFire ? " - tap a cell to fire" : ""))
        );
        tWrap.appendChild(fleetStrip(t.hex, (t.sunk_ships || []).map((s: GL) => s.size), undefined, g.fleet_sizes));
        const tGrid = bsGrid(
          tStates,
          t.hex,
          canFire && !t.eliminated ? (label) => { void sendMove(g.id, t.name + ":" + label, note); } : null,
          t.sunk_ships || [],
          undefined,
          g
        );
        markLastShot(tGrid, g, t.name, freshMove);
        markSinking(tGrid, t.sunk_ships || [], g, t.name, freshMove);
        tWrap.appendChild(tGrid);
        boards.appendChild(tWrap);
      });
      const banner = bsBanner(g, freshMove);
      if (banner) wrap.appendChild(banner);
      wrap.appendChild(boards);
      if (g.sonar && g.phase === "play" && g.status === "running")
        wrap.appendChild(
          el(
            "div",
            "bs-sonar",
            g.sonar.target
              ? "📡 Sonar for " + g.sonar.for + ": a hull cell of " + g.sonar.target + "'s fleet - the leader - sits in " + g.sonar.label + "."
              : "📡 Sonar for " + g.sonar.for + ": a hull cell of the last ship sits in " + g.sonar.label + "."
          )
        );
      if (g.status === "running" && g.phase === "play") {
        (g.players || []).forEach((p: GL) => {
          const m = (g.misses || {})[p.name] || 0;
          if (m >= 2) wrap.appendChild(el("div", "bs-warn", "⚠ " + p.name + " has missed " + m + " turns in a row — one more and they're eliminated."));
          else if (m === 1) wrap.appendChild(el("div", "bs-warn soft", p.name + " has missed a turn — three in a row eliminates them."));
        });
        if (you.eliminated) note.textContent = "You are eliminated — your fleet is a wreck chart now. The sea fights on without you.";
        else if (you.playing) {
          const hint = arenaHint("bs-play-ffa", "Tap a cell on a rival's board to fire at that captain — ✕ is a hit, · is a miss, dark hulls are sunk. Wreck boards can't be fired at.");
          if (hint) wrap.appendChild(hint);
        }
      }
      wrap.appendChild(note);
    } else {
      const canFire = g.status === "running" && g.phase === "play" && you.your_turn;
      const banner = bsBanner(g, freshMove);
      if (banner) wrap.appendChild(banner);
      if (gameView) gameView.bsFire = canFire ? (label: string) => { void sendMove(g.id, label, note); } : null;
      // In 3D the fleet strips (sizes still afloat) sit under the scene:
      // the 2D boards that carry them are not built.
      const strips = el("div", "bs-strips3d");
      [
        { label: "Your fleet", hex: me.hex, sunk: (you.fleet || []).filter((s: GL) => s.sunk).map((s: GL) => s.size) },
        { label: opp.name + "'s fleet", hex: opp.hex, sunk: (you.sunk_ships || []).map((s: GL) => s.size) },
      ].forEach((f) => {
        const item = el("div", "bs-strip3d");
        item.appendChild(el("span", "bs-strip3d-label", f.label));
        item.appendChild(fleetStrip(f.hex, f.sunk, undefined, g.fleet_sizes));
        strips.appendChild(item);
      });
      bsScene(g, wrap, strips);
      // No WebGL: the scene is a note, and their waters are the only
      // way to aim - a plain grid of your shots, a tap fires
      if (!webglOk()) {
        const oppStates: Record<string, string> = {};
        Object.keys(you.shots || {}).forEach((c) => {
          oppStates[c] = you.shots[c];
        });
        (you.sunk_ships || []).forEach((s: GL) => {
          s.cells.forEach((c: string) => {
            oppStates[c] = "sunk";
          });
        });
        const aim = el("div", "bs-side bs-aim");
        aim.appendChild(el("div", "bs-title", opp.name + "'s waters" + (canFire ? " - tap a cell to fire" : "")));
        const oppGrid = bsGrid(oppStates, opp.hex, canFire ? (label) => { void sendMove(g.id, label, note); } : null, you.sunk_ships || [], undefined, g);
        markLastShot(oppGrid, g, opp.name, freshMove);
        aim.appendChild(oppGrid);
        wrap.appendChild(aim);
      }
      // whose shot it is, and the turn clock, are the turn banner's
      if (g.sonar && g.phase === "play" && g.status === "running")
        wrap.appendChild(el("div", "bs-sonar", "📡 Sonar for " + g.sonar.for + ": a hull cell of the last ship sits in " + g.sonar.label + "."));
      if (g.status === "running" && g.phase === "play") {
        (g.players || []).forEach((p: GL) => {
          const m = (g.misses || {})[p.name] || 0;
          if (m >= 2) wrap.appendChild(el("div", "bs-warn", "⚠ " + p.name + " has missed " + m + " turns in a row — one more forfeits the match."));
          else if (m === 1) wrap.appendChild(el("div", "bs-warn soft", p.name + " has missed a turn — three in a row forfeits the match."));
        });
        if (you.playing) {
          const hint = webglOk()
            ? arenaHint(
                "bs-play-3d",
                "Tap a cell in their waters to fire (or arrow keys to aim, Enter to fire) — flames are hits, rings are misses, burning wrecks are sunk."
              )
            : arenaHint("bs-play", "Tap a cell to fire — ✕ is a hit, · is a miss, dark hulls are sunk.");
          if (hint) wrap.appendChild(hint);
        }
      }
      wrap.appendChild(note);
    }
  }

  /* ---- Light Cycles 3D board (R3F spike, 2026-11-12) ----
     The arena's board can render as a 3D scene (./LcArena3D,
     react-three-fiber) instead of the SVG. The scene module is a
     dynamic import, so three.js ships in a lazy chunk that loads
     only when a viewer flips the toggle; the preference persists
     per device and defaults to 3D (a stored "0" is an explicit
     opt-out and is respected). The React root lives on the
     gameView object: renderGameView clears and rebuilds the wrap
     on every state change, and re-appending the same host element
     keeps the canvas (and the camera) alive across repaints. */
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
      lc3dComp = import("./LcArena3D")
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
     dynamic import (three.js stays in the lazy chunk), the preference
     persists per device and defaults to 3D (a stored "0" is an
     explicit opt-out and is respected), and the React root lives
     on gameView so re-appending the host keeps the canvas alive
     across repaints. The component receives the same per-viewer state
     as the 2D boards plus a fire callback wired to sendMove. */
  let bs3dComp: Promise<
    ComponentType<{ g: GL; me: string; aspect?: number; onFire?: (label: string) => void; onReady?: () => void }>
  > | null = null;
  function loadBs3d() {
    // A failed import is not remembered: the next paint tries again.
    if (!bs3dComp)
      bs3dComp = import("./BsArena3D")
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
            onFire: (label: string) => {
              if (gameView && gameView.bsFire) gameView.bsFire(label);
            },
            onReady: () => ready3d(h),
          })
        );
      },
      (err) => {
        if (current()) fail3d(h, err);
      }
    );
  }
  /* The two-captain scene, with what follows it right under it. */
  function bsScene(g: GL, wrap: HTMLElement, under?: HTMLElement) {
    if (!gameView) return;
    if (!gameView.bs3d) gameView.bs3d = makeHost3d("lc-board-big lc-3d-host bs-3d-host");
    wrap.appendChild(gameView.bs3d.host);
    if (under) wrap.appendChild(under);
    paintBs3d(g, gameView.bs3d);
  }

  /* ---- Duel 3D arena (2026-11-13) ----
     Same bridge as the other two: ./DuelArena3D is a dynamic import,
     the preference persists per device and defaults to 3D (a stored
     "0" is an explicit opt-out), and the React root lives on gameView
     so repaints keep the canvas. The scene replaces the two DOM duel
     sides; the throw pad, the verdict banner and the scoreboard stay
     in the page - the scene shows, the page acts. */
  let duel3dComp: Promise<
    ComponentType<{ g: GL; me?: string; aspect?: number; onReady?: () => void; registerCommit?: (fn: ((t: string) => void) | null) => void }>
  > | null = null;
  function loadDuel3d() {
    if (!duel3dComp)
      duel3dComp = import("./DuelArena3D")
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
    if (g.type === "duel") {
      renderDuelView(g, force);
      return;
    }
    if (g.type === "battleship") {
      renderBattleshipView(g, force);
      return;
    }
    if (g.type === "frontlines") {
      renderFrontlinesView(g, force);
      return;
    }
    if (g.type === "coderace") {
      renderCodeRaceView(g, force);
      return;
    }
    if (g.type === "fourinarow") {
      renderFourView(g, force);
      return;
    }
    if (g.type === "trust") {
      renderTrustView(g, force);
      return;
    }
    if (g.type === "lettergrid") {
      renderLetterView(g, force);
      return;
    }
    if (g.type === "auction") {
      renderAuctionView(g, force);
      return;
    }
    if (g.type === "liarsdice") {
      renderLiarsView(g, force);
      return;
    }
    if (g.type === "twotruths") {
      renderTwoTruthsView(g, force);
      return;
    }
    if (g.type === "corpse") {
      renderCorpseView(g, force);
      return;
    }
    if (g.type === "twenty") {
      renderTwentyView(g, force);
      return;
    }
    if (g.type === "werewolf") {
      renderWerewolfView(g, force);
      return;
    }
    const key =
      g.status +
      "|" +
      g.tick +
      "|" +
      ((g.you && g.you.queued) || "") +
      "|" +
      youSig(g) +
      "|" +
      (g.players || []).map((p: GL) => (p.alive ? 1 : 0) + (p.moved ? 1 : 0) + (p.accepted ? 1 : 0)).join("") +
      "|" +
      ((gameView && gameView.tab) || "game");
    if (!force && key === gameRenderKey) return;
    gameRenderKey = key;
    const wrap = gameView.wrap;
    wrap.textContent = "";
    wrap.appendChild(el("div", "lc-meta", gameMetaText(g)));
    const wb = winnerBanner(g);
    if (wb) wrap.appendChild(wb);
    const rr = resultRow(g);
    if (rr) wrap.appendChild(rr);
    const tb = turnBanner(g);
    if (tb) wrap.appendChild(tb);
    wrap.appendChild(arenaTabs(g));
    if (gameView.tab === "history") {
      dropLc3d();
      wrap.appendChild(historyList(g));
      return;
    }
    if (!gameView.lc3d) gameView.lc3d = makeHost3d("lc-board-big lc-3d-host");
    wrap.appendChild(gameView.lc3d.host);
    paintLc3d(g, gameView.lc3d);
    const chips = el("div", "lc-players");
    (g.players || []).forEach((p: GL) => {
      const chip = el("span", "lc-chip" + (p.alive ? "" : " out"));
      const dot = el("span", "lc-dot");
      dot.style.background = p.hex;
      chip.appendChild(dot);
      const state =
        g.status === "lobby"
          ? p.accepted
            ? " · in ✓"
            : " · invited…"
          : g.status === "running"
            ? p.moved
              ? " · moved ✓"
              : " · deciding…"
            : "";
      chip.appendChild(document.createTextNode(p.name + (p.alive ? state : " · out")));
      chips.appendChild(chip);
    });
    wrap.appendChild(chips);
    const note = el("div", "lc-note", "");
    if (g.status === "lobby") {
      wrap.appendChild(lobbyPanel(g, note));
      wrap.appendChild(note);
    }
    if (g.you && g.you.playing && g.status === "running" && g.you.alive) {
      const pad = el("div", "lc-pad");
      const dirs: [string, string, number, number][] = [
        ["up", "↑", 1, 0],
        ["left", "←", 0, 1],
        ["right", "→", 2, 1],
        ["down", "↓", 1, 2],
      ];
      dirs.forEach((dd) => {
        const b = el("button", "lc-btn" + (g.you.queued === dd[0] ? " queued" : ""), dd[1]);
        b.type = "button";
        b.style.gridColumn = String(dd[2] + 1);
        b.style.gridRow = String(dd[3] + 1);
        b.setAttribute("aria-label", "Steer " + dd[0]);
        if ((g.you.legal_moves || []).indexOf(dd[0]) < 0) b.disabled = true;
        b.addEventListener("click", () => {
          void sendMove(g.id, dd[0], note);
        });
        pad.appendChild(b);
      });
      wrap.appendChild(pad);
      const onBoard = " (or tap a marker on the board)";
      note.textContent = g.you.queued
        ? "Queued: " + g.you.queued + " - tap another direction" + onBoard + " to change it before the tick resolves."
        : g.mode === "async"
          ? "Your move: pick a direction" + onBoard + " — the tick resolves the moment every rider has one in."
          : "Your move: pick a direction" + onBoard + " before the tick closes.";
      wrap.appendChild(note);
    } else if (g.you && g.you.playing && g.status === "running") {
      note.textContent = "You are out - the record is yours to keep.";
      wrap.appendChild(note);
    } else if (g.status === "running") {
      note.textContent = "Spectating - the riders steer by API and by pad.";
      wrap.appendChild(note);
    }
    if (g.record_keeper) wrap.appendChild(el("div", "lc-note", "Record keeper: " + g.record_keeper));
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
      if (game.trails || game.type === "duel" || game.type === "battleship" || game.type === "frontlines" || game.type === "coderace" || game.type === "fourinarow" || game.type === "trust" || game.type === "lettergrid" || game.type === "auction" || game.type === "liarsdice" || game.type === "twotruths" || game.type === "corpse" || game.type === "twenty" || game.type === "werewolf") {
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
