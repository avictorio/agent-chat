import type { RoomClient } from "@chat/shared";
import { el } from "../lib";
import {
  battleshipBoard,
  boardSvg,
  bsGrid,
  clockBar,
  duelBoard,
  duelScoreLine,
  fleetStrip,
  gameMetaText,
  lastMoveText,
  roundVerdict,
  setClockBar,
  winnerBanner,
  THROW_BEATS,
  THROW_EMOJI,
  type GL,
} from "./render";
import type { ViewerApi } from "../shell/viewer";

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
function bsShipCells(start: string, dir: string, size: number): string[] | null {
  const x0 = start.charCodeAt(0) - 65;
  const y0 = parseInt(start.slice(1), 10) - 1;
  const cells: string[] = [];
  for (let i = 0; i < size; i++) {
    const x = dir === "H" ? x0 + i : x0;
    const y = dir === "H" ? y0 : y0 + i;
    if (x > 9 || y > 9) return null;
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
  const idx = label.charCodeAt(0) - 65 + (parseInt(label.slice(1), 10) - 1) * 10;
  return (inner.children[idx] as HTMLElement) || null;
}

// Ring (and, on first sight, burst or splash) the cell the last shot
// landed on, in the grid of the captain whose waters took it.
function markLastShot(grid: HTMLElement, g: GL, ownerName: string, fresh: boolean) {
  const lm = g && g.last_move;
  if (!lm || lm.by === ownerName) return;
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
}

export function createGameStore(opts: {
  client: RoomClient;
  meName: () => string;
  openViewer: ViewerApi["open"];
}): GameStore {
  const { client } = opts;
  const cache = new Map<number, GL>();
  const listeners = new Set<() => void>();
  let version = 0;
  const notify = () => {
    version++;
    listeners.forEach((fn) => fn());
  };

  let gameView: { id: number; wrap: HTMLElement; lastRounds?: number } | null = null;
  let gameViewTimer = 0;
  let gameRenderKey = "";

  function duelSide(p: GL, g: GL): HTMLElement {
    const side = el("div", "duel-side");
    side.style.borderColor = p.hex;
    const myName = opts.meName();
    const isViewer = !!(g.you && g.you.playing && myName && p.name === myName);
    let icon = "…";
    let state = "THINKING";
    let hidden = false;
    if (isViewer && g.you.queued) {
      icon = THROW_EMOJI[g.you.queued] || "?";
      state = "LOCKED";
    } else if (p.thrown) {
      icon = "❓";
      state = "LOCKED";
      hidden = true;
    }
    const name = el("div", "side-name", p.name + (isViewer ? " (you)" : ""));
    name.style.color = p.hex;
    side.appendChild(name);
    const th = el("div", "side-throw", icon);
    if (hidden) side.classList.add("hidden-throw");
    side.appendChild(th);
    side.appendChild(el("div", "side-state", state));
    return side;
  }

  function rematchRow(g: GL, note: HTMLElement): HTMLElement {
    const row = el("div", "duel-pad");
    const b = el("button", "duel-btn", "Rematch");
    b.type = "button";
    b.addEventListener("click", () => {
      void sendRematch(g, note);
    });
    row.appendChild(b);
    if (!note.textContent) note.textContent = "Match over - run it back with the same settings.";
    return row;
  }

  async function sendRematch(g: GL, note: HTMLElement | null) {
    const body: Record<string, unknown> = { players: (g.players || []).map((p: GL) => p.name) };
    if (g.type === "duel") {
      body.game = "duel";
      body.best_of = g.best_of;
      body.tick_seconds = g.round_seconds;
    } else if (g.type === "battleship") {
      body.game = "battleship";
      body.tick_seconds = g.turn_seconds;
    } else {
      body.tick_seconds = g.tick_seconds;
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
      }
    } catch {
      if (note) note.textContent = "The rematch did not reach the referee.";
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
      }
    } catch (e) {
      if (note) note.textContent = e instanceof Error ? e.message : "That did not reach the referee.";
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
    if (g.lobby_deadline) line += " The lobby closes at " + new Date(g.lobby_deadline).toLocaleTimeString() + ".";
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

  function renderDuelView(g: GL, force?: boolean) {
    if (!gameView) return;
    const key =
      g.status +
      "|" +
      g.round +
      "|" +
      (g.players || []).map((p: GL) => (p.wins || 0) + (p.thrown ? 1 : 0) + (p.accepted ? 1 : 0)).join("") +
      "|" +
      ((g.you && g.you.queued) || "");
    if (!force && key === gameRenderKey) return;
    gameRenderKey = key;
    const wrap = gameView.wrap;
    wrap.textContent = "";
    wrap.appendChild(el("div", "lc-meta", gameMetaText(g)));
    const wb = winnerBanner(g);
    if (wb) wrap.appendChild(wb);
    const big = el("div", "lc-board-big");
    big.appendChild(duelBoard(g));
    wrap.appendChild(big);
    const note = el("div", "lc-note", "");
    const players = g.players || [];
    const rounds = g.rounds || [];
    if (g.status === "lobby") {
      wrap.appendChild(lobbyPanel(g, note));
      wrap.appendChild(note);
    }
    if (g.status === "running" && players.length === 2) {
      const arena = el("div", "duel-arena");
      arena.appendChild(duelSide(players[0], g));
      arena.appendChild(el("div", "duel-vs", "VS"));
      arena.appendChild(duelSide(players[1], g));
      wrap.appendChild(arena);
      if (g.deadline) wrap.appendChild(clockBar(g, true));
      const myName2 = opts.meName();
      const opp = players.filter((p: GL) => p.name !== myName2)[0];
      let status = "";
      if (g.you && g.you.playing && opp) {
        if (g.you.queued) status = "You're in · waiting on " + opp.name;
        else if (opp.thrown) status = opp.name + " is in · your throw decides the round";
        else status = "Round " + g.round + " · throws stay hidden until both are in";
      } else {
        status = players.map((p: GL) => p.name + (p.thrown ? " locked" : " thinking…")).join(" · ");
      }
      wrap.appendChild(el("div", "duel-statusline", status));
    }
    if (rounds.length) {
      const last = rounds[rounds.length - 1];
      const v = roundVerdict(last, players);
      const banner = el("div", "duel-verdict" + (v.tie ? " clash" : ""));
      const icons = players
        .map((p: GL) => {
          const t = (last.throws || {})[p.name];
          return t ? THROW_EMOJI[t] || "" : "—";
        })
        .join(" ");
      banner.appendChild(el("span", "v-icons", icons));
      banner.appendChild(el("span", "", v.text + " · " + duelScoreLine(g)));
      if (!v.tie && last.winner) {
        const wp = players.filter((p: GL) => p.name === last.winner)[0];
        if (wp) banner.style.borderColor = wp.hex;
      }
      if (gameView.lastRounds != null && rounds.length > gameView.lastRounds) banner.classList.add("reveal-in");
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
          void sendMove(g.id, t, note);
        });
        pad.appendChild(b);
      });
      wrap.appendChild(pad);
      note.textContent = g.you.queued
        ? "Thrown: " + g.you.queued + " - tap another to change it before the round resolves."
        : "Your throw: pick one. It stays hidden until your rival has thrown too.";
      wrap.appendChild(note);
    } else if (g.status === "running") {
      note.textContent = "Spectating - throws stay hidden until each round resolves.";
      wrap.appendChild(note);
    }
    if (g.status === "finished" || g.status === "cancelled") {
      wrap.appendChild(rematchRow(g, note));
      wrap.appendChild(note);
    }
    if (rounds.length) {
      const stripWrap = el("div", "duel-rounds");
      stripWrap.appendChild(el("div", "", "Rounds"));
      const strip = el("div", "duel-strip");
      const detail = el("div", "duel-chip-detail", "");
      const setDetail = (r: GL) => {
        const v2 = roundVerdict(r, players);
        const parts = players.map((p: GL) => {
          const t = (r.throws || {})[p.name];
          return p.name + " " + (t ? (THROW_EMOJI[t] || "") + " " + t : "- no throw");
        });
        detail.textContent = "Round " + r.n + " - " + parts.join(" vs ") + " · " + v2.text;
      };
      rounds.forEach((r: GL) => {
        const chip = el("button", "duel-chip" + (r.winner ? "" : " tie"));
        chip.type = "button";
        chip.appendChild(el("span", "chip-r", "R" + r.n));
        const ic = players
          .map((p: GL) => {
            const t = (r.throws || {})[p.name];
            return t ? THROW_EMOJI[t] || "" : "—";
          })
          .join("");
        chip.appendChild(el("span", "", ic));
        if (r.winner) {
          const wp2 = players.filter((p: GL) => p.name === r.winner)[0];
          if (wp2) {
            chip.style.borderColor = wp2.hex;
            chip.style.background = "linear-gradient(" + wp2.hex + "2e, " + wp2.hex + "2e), #0a1420";
          }
        } else chip.appendChild(el("span", "chip-r", "="));
        chip.addEventListener("click", () => setDetail(r));
        strip.appendChild(chip);
      });
      stripWrap.appendChild(strip);
      setDetail(rounds[rounds.length - 1]);
      stripWrap.appendChild(detail);
      wrap.appendChild(stripWrap);
    }
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
      (g.players || []).map((p: GL) => (p.accepted ? 1 : 0) + "" + (p.placed ? 1 : 0) + "" + (p.shots || 0) + "" + (p.afloat || 0)).join("") +
      "|" +
      (you.fleet ? "fleet" : "") +
      "|" +
      (you.shots ? Object.keys(you.shots).length : 0);
    if (!force && key === gameRenderKey) return;
    gameRenderKey = key;
    const wrap = gameView.wrap;
    wrap.textContent = "";
    wrap.appendChild(el("div", "lc-meta", gameMetaText(g)));
    const wb = winnerBanner(g);
    if (wb) wrap.appendChild(wb);
    const note = el("div", "lc-note", "");
    if (g.status === "lobby") {
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
      big.appendChild(battleshipBoard(g));
      wrap.appendChild(big);
      if (g.boards && g.boards.length && (g.phase === "play" || g.status === "finished")) {
        const banner = bsBanner(g, freshMove);
        if (banner) wrap.appendChild(banner);
        const boards = el("div", "bs-boards");
        g.boards.forEach((b: GL) => {
          const states: Record<string, string> = {};
          Object.keys(b.incoming || {}).forEach((c) => {
            states[c] = b.incoming[c];
          });
          (b.sunk_ships || []).forEach((s: GL) => {
            s.cells.forEach((c: string) => {
              states[c] = "sunk";
            });
          });
          const side = el("div", "bs-side");
          side.appendChild(el("div", "bs-title", b.name + "'s waters"));
          side.appendChild(fleetStrip(b.hex, (b.sunk_ships || []).map((s: GL) => s.size)));
          const grid = bsGrid(states, b.hex, null, b.sunk_ships || []);
          markLastShot(grid, g, b.name, freshMove);
          markSinking(grid, b.sunk_ships || [], g, b.name, freshMove);
          side.appendChild(grid);
          boards.appendChild(side);
        });
        wrap.appendChild(boards);
        note.textContent = "Spectating - every shot is public; un-hit ships stay hidden.";
      } else {
        note.textContent = "Spectating - fleets stay hidden; the boards are for their captains.";
      }
      wrap.appendChild(note);
    } else if (g.phase === "setup" && !you.fleet) {
      const big = el("div", "lc-board-big");
      big.appendChild(battleshipBoard(g));
      wrap.appendChild(big);
      let draft = bsDrafts.get(g.id);
      if (!draft) {
        draft = { placed: [], orient: "H" };
        bsDrafts.set(g.id, draft);
      }
      const FLEET = [5, 4, 3, 3, 2];
      const placedCells = new Set<string>();
      const ships: GL[] = [];
      draft.placed.forEach((p) => {
        const cells = bsShipCells(p.start, p.dir, p.size) || [];
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
        const cells = bsShipCells(label, draft.orient, nextSize);
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
      side.appendChild(bsGrid(states, me.hex, tryPlace, ships, "Place at "));
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
    } else {
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
      ownWrap.appendChild(el("div", "bs-title", "Your waters"));
      ownWrap.appendChild(fleetStrip(me.hex, (you.fleet || []).filter((s: GL) => s.sunk).map((s: GL) => s.size)));
      const ownGrid = bsGrid(ownStates, me.hex, null, you.fleet || []);
      markLastShot(ownGrid, g, myName, freshMove);
      markSinking(ownGrid, you.fleet || [], g, myName, freshMove);
      ownWrap.appendChild(ownGrid);
      boards.appendChild(ownWrap);
      const oppStates: Record<string, string> = {};
      Object.keys(you.shots || {}).forEach((c) => {
        oppStates[c] = you.shots[c];
      });
      (you.sunk_ships || []).forEach((s: GL) => {
        s.cells.forEach((c: string) => {
          oppStates[c] = "sunk";
        });
      });
      const canFire = g.status === "running" && g.phase === "play" && you.your_turn;
      const oppWrap = el("div", "bs-side");
      oppWrap.appendChild(el("div", "bs-title", opp.name + "'s waters" + (canFire ? " - tap a cell to fire" : "")));
      oppWrap.appendChild(fleetStrip(opp.hex, (you.sunk_ships || []).map((s: GL) => s.size)));
      const oppGrid = bsGrid(oppStates, opp.hex, canFire ? (label) => { void sendMove(g.id, label, note); } : null, you.sunk_ships || []);
      markLastShot(oppGrid, g, opp.name, freshMove);
      markSinking(oppGrid, you.sunk_ships || [], g, opp.name, freshMove);
      oppWrap.appendChild(oppGrid);
      boards.appendChild(oppWrap);
      const banner = bsBanner(g, freshMove);
      if (banner) wrap.appendChild(banner);
      wrap.appendChild(boards);
      let status = "";
      if (g.status === "finished" || g.status === "cancelled") status = "";
      else if (g.phase === "setup") status = "Fleet placed - waiting on " + opp.name + " to place theirs.";
      else if (you.your_turn) status = "Your shot - turn " + g.turn + ".";
      else status = "Waiting on " + opp.name + "'s shot - turn " + g.turn + ".";
      if (status) wrap.appendChild(el("div", "duel-statusline", status));
      wrap.appendChild(note);
    }
    if (g.status === "finished" || g.status === "cancelled") {
      wrap.appendChild(rematchRow(g, note));
      wrap.appendChild(note);
    }
    if (g.log && g.log.length) {
      const log = el("div", "lc-log");
      log.appendChild(el("div", "", "The record"));
      g.log.forEach((ln: GL) => {
        log.appendChild(el("div", "", "Turn " + ln.tick + " - " + ln.text));
      });
      wrap.appendChild(log);
    }
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
    const key =
      g.status +
      "|" +
      g.tick +
      "|" +
      ((g.you && g.you.queued) || "") +
      "|" +
      (g.players || []).map((p: GL) => (p.alive ? 1 : 0) + (p.moved ? 1 : 0) + (p.accepted ? 1 : 0)).join("");
    if (!force && key === gameRenderKey) return;
    gameRenderKey = key;
    const wrap = gameView.wrap;
    wrap.textContent = "";
    wrap.appendChild(
      el(
        "div",
        "lc-meta",
        gameMetaText(g) + (g.status === "running" && g.deadline ? " · tick closes " + new Date(g.deadline).toLocaleTimeString() : "")
      )
    );
    const wb = winnerBanner(g);
    if (wb) wrap.appendChild(wb);
    const big = el("div", "lc-board-big");
    big.innerHTML = boardSvg(g);
    wrap.appendChild(big);
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
      note.textContent = g.you.queued
        ? "Queued: " + g.you.queued + " - tap another direction to change it before the tick resolves."
        : "Your move: pick a direction before the tick closes.";
      wrap.appendChild(note);
    } else if (g.you && g.you.playing && g.status === "running") {
      note.textContent = "You are out - the record is yours to keep.";
      wrap.appendChild(note);
    } else if (g.status === "running") {
      note.textContent = "Spectating - the riders steer by API and by pad.";
      wrap.appendChild(note);
    }
    if (g.status === "finished" || g.status === "cancelled") {
      wrap.appendChild(rematchRow(g, note));
      wrap.appendChild(note);
    }
    if (g.record_keeper) wrap.appendChild(el("div", "lc-note", "Record keeper: " + g.record_keeper));
    if (g.log && g.log.length) {
      const log = el("div", "lc-log");
      log.appendChild(el("div", "", "The record"));
      g.log.forEach((ln: GL) => {
        log.appendChild(el("div", "", "Tick " + ln.tick + " - " + ln.text));
      });
      wrap.appendChild(log);
    }
  }

  async function fetchGame(id: number): Promise<void> {
    try {
      const d = await client.game(id);
      if (!d.game) return;
      cache.set(id, d.game);
      notify();
      if (gameView && gameView.id === id) renderGameView(d.game);
    } catch {
      // a failed refresh keeps the last known state
    }
  }

  function openGame(id: number, type?: string) {
    gameRenderKey = "";
    const kind = type || cache.get(id)?.type;
    opts.openViewer(
      (kind === "duel" ? "Duel #" : kind === "battleship" ? "Battleship #" : "Light Cycles #") + id,
      (vb) => {
        const wrap = el("div", "lc-arena");
        wrap.appendChild(el("div", "lc-meta", "Loading the arena…"));
        vb.appendChild(wrap);
        gameView = { id, wrap };
        void fetchGame(id);
      },
      null
    );
    if (gameViewTimer) clearInterval(gameViewTimer);
    gameViewTimer = window.setInterval(() => {
      if (gameView) void fetchGame(gameView.id);
    }, 8000);
  }

  // Round-clock bars drain on a 1s ticker, in cards and arena alike.
  window.setInterval(() => {
    document.querySelectorAll("[data-duel-deadline]").forEach((b) => setClockBar(b as HTMLElement));
  }, 1000);
  // Cards stay fresh on a slow poll, like the current app.
  window.setInterval(() => {
    if (document.hidden) return;
    cache.forEach((_g, id) => {
      void fetchGame(id);
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
      if (game.trails || game.type === "duel" || game.type === "battleship") {
        cache.set(game.id, game);
        notify();
      }
      if (gameView && gameView.id === game.id) void fetchGame(game.id);
    },
    openGame,
    respond: (id: number, accept: boolean) => respond(id, accept, null),
    rematch: (g: GL) => sendRematch(g, null),
    viewerClosed() {
      if (gameViewTimer) {
        clearInterval(gameViewTimer);
        gameViewTimer = 0;
      }
      gameView = null;
    },
  };
}
