import type { RoomClient } from "@chat/shared";
import type { ViewerApi } from "./viewer";

// Games — Light Cycles and Duel — ported from the current app. The
// card board and the arena render from game state (GET /games/:id,
// kept fresh by stream "game" frames and slow polls). Cards are
// React components subscribed to this store; the arena is native
// DOM inside the viewer, exactly like the current app — the pad
// calls the moves endpoint with the viewer's own invite. The board
// itself is display-only SVG.

// Game payloads are richer than the shared summary types (heads,
// record keeper, per-round detail), so the store works untyped.
/* eslint-disable @typescript-eslint/no-explicit-any */
type GL = any;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined && text !== null) e.textContent = text;
  return e;
}

export function tickLen(ts: number): string {
  return ts >= 3600 ? Math.round(ts / 3600) + " h" : Math.max(1, Math.round(ts / 60)) + " min";
}

export function gameMetaText(g: GL): string {
  if (!g) return "";
  if (g.type === "duel") {
    const sc = g.score || {};
    const dline = (g.players || [])
      .map((p: GL) => p.name + " " + (sc[p.name] != null ? sc[p.name] : p.wins || 0))
      .join(" · ");
    if (g.status === "finished") return "Final · " + dline + (g.winner ? " · " + g.winner + " takes the duel" : " · no winner");
    if (g.status === "cancelled") return "Cancelled · " + dline;
    return "Round " + g.round + " · first to " + g.target + " · round " + tickLen(g.round_seconds || 600);
  }
  if (g.status === "finished") return "Final · tick " + g.tick + (g.winner ? " · " + g.winner + " takes the grid" : " · no survivors");
  if (g.status === "cancelled") return "Cancelled · tick " + g.tick;
  const alive = (g.players || []).filter((p: GL) => p.alive).length;
  let meta = "Tick " + g.tick + " · " + alive + " riding · tick " + tickLen(g.tick_seconds || 900);
  if (g.you && g.you.playing && g.you.alive && !g.you.queued) meta += " · your move";
  return meta;
}

export function boardSvg(g: GL): string {
  let s =
    '<svg class="lc-svg" viewBox="0 0 ' + g.w + " " + g.h + '" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Light Cycles board">';
  s += '<rect x="0" y="0" width="' + g.w + '" height="' + g.h + '" fill="#04060d"/>';
  let grid = "";
  for (let x = 1; x < g.w; x++) grid += "M" + x + " 0V" + g.h;
  for (let y = 1; y < g.h; y++) grid += "M0 " + y + "H" + g.w;
  s += '<path d="' + grid + '" stroke="rgba(56,189,248,0.07)" stroke-width="0.04" fill="none"/>';
  const byColor: Record<number, GL[]> = {};
  (g.trails || []).forEach((c: GL) => {
    (byColor[c[2]] = byColor[c[2]] || []).push(c);
  });
  (g.players || []).forEach((p: GL, i: number) => {
    (byColor[i] || []).forEach((c: GL) => {
      s += '<rect x="' + c[0] + '" y="' + c[1] + '" width="1" height="1" fill="' + p.hex + '" opacity="0.45"/>';
    });
  });
  (g.players || []).forEach((p: GL) => {
    if (p.alive && typeof p.x === "number")
      s += '<rect x="' + p.x + '" y="' + p.y + '" width="1" height="1" fill="' + p.hex + '" stroke="#e0faff" stroke-width="0.14"/>';
  });
  s += "</svg>";
  return s;
}

export const THROW_EMOJI: Record<string, string> = { rock: "🪨", paper: "📄", scissors: "✂️" };
export const THROW_BEATS: Record<string, string> = { rock: "crushes scissors", paper: "covers rock", scissors: "cut paper" };
const THROW_VERB: Record<string, string> = { rock: "crushes", paper: "covers", scissors: "cut" };

function capThrow(t: string): string {
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : "";
}

export function roundVerdict(r: GL, players: GL[]): { tie: boolean; text: string } {
  const t0 = (r.throws || {})[players[0].name];
  const t1 = (r.throws || {})[players[1].name];
  if (!r.winner) {
    if (t0 && t0 === t1) return { tie: true, text: "CLASH · identical throws, no score" };
    return { tie: true, text: "Level · no score" };
  }
  const loser = players.filter((p: GL) => p.name !== r.winner)[0];
  const tw = (r.throws || {})[r.winner];
  const tl = loser ? (r.throws || {})[loser.name] : null;
  if (!tw || !tl) return { tie: false, text: r.winner + " takes it by forfeit" };
  return { tie: false, text: capThrow(tw) + " " + (THROW_VERB[tw] || "beats") + " " + tl + " · " + r.winner + " takes it" };
}

function setClockBar(bar: HTMLElement) {
  const dl = +(bar.getAttribute("data-duel-deadline") || 0);
  const dur = +(bar.getAttribute("data-duel-dur") || 1);
  const left = Math.max(0, dl - Date.now());
  const pct = Math.max(0, Math.min(100, (left / dur) * 100));
  if (bar.firstChild) (bar.firstChild as HTMLElement).style.width = pct + "%";
  bar.classList.toggle("low", pct < 20 && left > 0);
  const wrap = bar.parentElement;
  const lab = wrap ? wrap.querySelector(".duel-clocklabel") : null;
  if (lab) {
    const s = Math.ceil(left / 1000);
    lab.textContent =
      left > 0 ? Math.floor(s / 60) + ":" + ("0" + (s % 60)).slice(-2) + " left in the round" : "round closing…";
  }
}

function clockBar(g: GL, withLabel: boolean): HTMLElement {
  const w = el("div", "duel-clockwrap");
  const bar = el("div", "duel-clockbar");
  bar.setAttribute("data-duel-deadline", String(g.deadline));
  bar.setAttribute("data-duel-dur", String((g.round_seconds || 600) * 1000));
  bar.appendChild(el("div", ""));
  w.appendChild(bar);
  if (withLabel) w.appendChild(el("div", "duel-clocklabel duel-stateline", ""));
  setClockBar(bar);
  return w;
}

export function duelBoard(g: GL): HTMLElement {
  const wrap = el("div", "duel-board");
  const sc = g.score || {};
  (g.players || []).forEach((p: GL) => {
    const row = el("div", "duel-row");
    const dot = el("span", "lc-dot");
    dot.style.background = p.hex;
    row.appendChild(dot);
    row.appendChild(el("span", "duel-name", p.name));
    let pips = "";
    for (let i = 0; i < (g.target || 0); i++) pips += i < (p.wins || 0) ? "●" : "○";
    const pipEl = el("span", "duel-pips", pips);
    pipEl.style.color = p.hex;
    row.appendChild(pipEl);
    const score = el("span", "duel-score", String(sc[p.name] != null ? sc[p.name] : p.wins || 0));
    score.style.color = p.hex;
    row.appendChild(score);
    wrap.appendChild(row);
  });
  if (g.status === "running") {
    const states = (g.players || []).map((p: GL) => p.name + (p.thrown ? " locked ✓" : " thinking…")).join(" · ");
    wrap.appendChild(el("div", "duel-stateline", states));
  }
  const rounds = g.rounds || [];
  if (rounds.length) {
    const last = rounds[rounds.length - 1];
    const v = roundVerdict(last, g.players || []);
    const fo = el("div", "duel-faceoff-line");
    const icons = (g.players || [])
      .map((p: GL) => {
        const t = (last.throws || {})[p.name];
        return t ? THROW_EMOJI[t] || "" : "—";
      })
      .join(" ");
    fo.appendChild(el("span", "fo-icons", icons));
    fo.appendChild(el("span", "", v.text));
    wrap.appendChild(fo);
  }
  if (g.you && g.you.playing && g.status === "running") {
    if (g.you.queued) wrap.appendChild(el("span", "duel-pill locked", "✓ LOCKED · " + g.you.queued));
    else wrap.appendChild(el("span", "duel-pill your-throw", "YOUR THROW"));
  }
  if (g.status === "running" && g.deadline) wrap.appendChild(clockBar(g, false));
  return wrap;
}

function duelScoreLine(g: GL): string {
  const sc = g.score || {};
  return (g.players || []).map((p: GL) => p.name + " " + (sc[p.name] != null ? sc[p.name] : p.wins || 0)).join(" · ");
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
      (g.players || []).map((p: GL) => (p.wins || 0) + (p.thrown ? 1 : 0)).join("") +
      "|" +
      ((g.you && g.you.queued) || "");
    if (!force && key === gameRenderKey) return;
    gameRenderKey = key;
    const wrap = gameView.wrap;
    wrap.textContent = "";
    wrap.appendChild(el("div", "lc-meta", gameMetaText(g)));
    const big = el("div", "lc-board-big");
    big.appendChild(duelBoard(g));
    wrap.appendChild(big);
    const note = el("div", "lc-note", "");
    const players = g.players || [];
    const rounds = g.rounds || [];
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
      if (g.status === "finished") {
        const fin = el("span", "", g.winner ? g.winner + " takes the duel" : "No winner");
        fin.style.display = "block";
        fin.style.fontWeight = "800";
        fin.style.marginTop = "4px";
        banner.appendChild(fin);
      }
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
    if (g.status !== "running" && g.you && g.you.playing) {
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

  function renderGameView(g: GL, force?: boolean) {
    if (!gameView || gameView.id !== g.id) return;
    if (g.type === "duel") {
      renderDuelView(g, force);
      return;
    }
    const key =
      g.status +
      "|" +
      g.tick +
      "|" +
      ((g.you && g.you.queued) || "") +
      "|" +
      (g.players || []).map((p: GL) => (p.alive ? 1 : 0) + (p.moved ? 1 : 0)).join("");
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
    const big = el("div", "lc-board-big");
    big.innerHTML = boardSvg(g);
    wrap.appendChild(big);
    const chips = el("div", "lc-players");
    (g.players || []).forEach((p: GL) => {
      const chip = el("span", "lc-chip" + (p.alive ? "" : " out"));
      const dot = el("span", "lc-dot");
      dot.style.background = p.hex;
      chip.appendChild(dot);
      chip.appendChild(
        document.createTextNode(p.name + (p.alive ? (g.status === "running" ? (p.moved ? " · moved ✓" : " · deciding…") : "") : " · out"))
      );
      chips.appendChild(chip);
    });
    wrap.appendChild(chips);
    const note = el("div", "lc-note", "");
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
    if (g.status !== "running" && g.you && g.you.playing) {
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
    const isDuel = type ? type === "duel" : cache.get(id)?.type === "duel";
    opts.openViewer(
      (isDuel ? "Duel #" : "Light Cycles #") + id,
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
      if (game.trails || game.type === "duel") {
        cache.set(game.id, game);
        notify();
      }
      if (gameView && gameView.id === game.id) void fetchGame(game.id);
    },
    openGame,
    viewerClosed() {
      if (gameViewTimer) {
        clearInterval(gameViewTimer);
        gameViewTimer = 0;
      }
      gameView = null;
    },
  };
}
