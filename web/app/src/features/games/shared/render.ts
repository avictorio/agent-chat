import { el } from "../../../lib/index";
import { GAMES } from "../registry";

// Pure game rendering, shared by the feed cards and the arena:
// the meta line, the winner banner and the record line (each game's
// status hooks hold its own words), and the draining round-clock bar's
// ticker step. No state lives here — the store (./games) owns the cache
// and the arena views; each game's panels are its own (<game>/*Panels.tsx).

// GL is the shared code's view of a match: this file, the store
// (games.ts), the registry, the chat card and the Games tab handle every
// game. It is the contract's AnyGameState: every field some game sends,
// typed as the union of what the games send under that name, so the shared
// code reads whatever a match has, with fallbacks, and still gets its field
// names and types checked. Each game's own code - its status hooks, view,
// history rows, card board and 3D arena - takes its precise state type from
// @chat/contract (<Game>State; GameState is their union), and the registry
// checks each game's plug-in against it.
import type { AnyGameState, CodeRaceState } from "@chat/contract";
export type GL = AnyGameState;
/** A seat in any match. */
export type GLPlayer = NonNullable<GL["players"]>[number];
/** What any match tells its viewer about their own seat. */
export type GLYou = NonNullable<GL["you"]>;

export function tickLen(ts: number): string {
  return ts >= 3600 ? Math.round(ts / 3600) + " h" : Math.max(1, Math.round(ts / 60)) + " min";
}

// The standard finished-match presentation, shared by the feed
// card, the arena and the Games tab so a result reads the same
// everywhere: a gold winner banner (trophy + name + final score)
// and a record line in one shape per kind. The per-game parts are the
// games' status hooks (GameStatus in ../registry); the functions here
// call them and hold the defaults.

// A team's win (Werewolf): "The village wins" / "The wolves win".
export function sideWin(g: GL): { icon: string; text: string; hex: string } | null {
  if (!g || g.status !== "finished" || !g.side) return null;
  return g.side === "wolves" ? { icon: "🐺", text: "The wolves win", hex: "#ef4444" } : { icon: "🏡", text: "The village wins", hex: "#fbbf24" };
}

/** The winner's seat, in the match's own player type. */
export function winnerOf<P extends { name: string }>(g: { winner?: string | null; players?: P[] }): P | null {
  if (!g || !g.winner) return null;
  return (g.players || []).find((p: P) => p.name === g.winner) || null;
}

export function winnerFirst<P extends { name: string }>(g: { winner?: string | null; players?: P[] }): P[] {
  return (g.players || []).slice().sort((a: P, b: P) => (b.name === g.winner ? 1 : 0) - (a.name === g.winner ? 1 : 0));
}

// Final score, winner first, in each game's own unit (its finalScore hook in
// <game>/status.ts: Duel round wins, Battleship ships sunk...); none by default.
export function finalScore(g: GL): string {
  if (!g) return "";
  const own = GAMES[g.type]?.finalScore;
  if (own) return own(g);
  return "";
}

export function recordLine(g: GL): string {
  if (!g) return "";
  if (g.status === "cancelled") return "Called off" + (g.declined_by ? " · " + g.declined_by + " declined" : "");
  if (g.status !== "finished") return "";
  const own = GAMES[g.type]?.recordLine;
  if (own) return own(g);
  return "Final · tick " + (g.tick || 0);
}

// The winner banner as a DOM node for the imperative surfaces
// (card boards, arenas). The React surfaces (Games tab, card
// footer) mirror this markup in WinnerBanner.tsx.
export function winnerBanner(g: GL): HTMLElement | null {
  if (!g || (g.status !== "finished" && g.status !== "cancelled")) return null;
  const b = el("div", "game-winner");
  if (g.status === "cancelled") {
    b.classList.add("off");
    b.appendChild(el("span", "gw-text", "Called off"));
    return b;
  }
  const team = sideWin(g);
  if (team) {
    b.classList.add("ceremony");
    b.style.setProperty("--win-c", team.hex);
    b.appendChild(el("span", "gw-trophy", team.icon));
    b.appendChild(el("span", "gw-name", team.text));
    return b;
  }
  const w = winnerOf(g);
  if (!w) {
    b.classList.add("off");
    b.appendChild(el("span", "gw-text", "No winner"));
    return b;
  }
  // Arena surfaces get the ceremony: the arena re-renders on every
  // update, so the banner is (re)built at the finish moment and the
  // entrance plays then. Called-off and no-winner banners stay off.
  b.classList.add("ceremony");
  if (w.hex) b.style.setProperty("--win-c", w.hex);
  b.appendChild(el("span", "gw-trophy", "🏆"));
  b.appendChild(el("span", "gw-name", w.name));
  b.appendChild(el("span", "gw-text", "wins"));
  const score = finalScore(g);
  if (score) b.appendChild(el("span", "gw-score", score));
  const burst = el("span", "gw-burst");
  burst.setAttribute("aria-hidden", "true");
  for (let i = 0; i < 10; i++) burst.appendChild(el("i", ""));
  b.appendChild(burst);
  return b;
}

// The length of a running match's clock - a turn, a round or a phase - in
// seconds: the turn banner's bar and the Games tab's countdowns. Light
// Cycles' tick by default.
export function clockSeconds(g: GL): number {
  const own = GAMES[g.type]?.clockSeconds;
  if (own) return own(g);
  return g.tick_seconds || 120;
}

// "4 pegs · 6 colours" or "5-letter word": a Code Race's secret, in brief.
export function crWhat(g: CodeRaceState): string {
  return g.mode === "words" ? (g.length || 5) + "-letter word" : (g.length || 4) + " pegs · " + (g.colors || 6) + " colours";
}

export function gameMetaText(g: GL): string {
  if (!g) return "";
  const own = GAMES[g.type]?.metaText;
  if (own) return own(g);
  if (g.status === "finished" || g.status === "cancelled") return recordLine(g);
  if (g.status === "lobby") {
    const waiting = (g.players || []).filter((p: GLPlayer) => !p.accepted).map((p: GLPlayer) => p.name);
    return "Lobby · waiting on " + (waiting.join(", ") || "no one") + (g.mode === "async" ? " · async · resolves on everyone's move" : " · " + tickLen(g.tick_seconds || 120) + " ticks");
  }
  const alive = (g.players || []).filter((p: GLPlayer) => p.alive).length;
  // "your move" is the card's pill and the arena's turn banner now: at
  // the end of this line it was the part a phone clipped off.
  return "Tick " + g.tick + " · " + alive + " riding · " + (g.mode === "async" ? "async" : tickLen(g.tick_seconds || 120) + " ticks");
}

/* Time left, in words a glance can take: "1 h 05 min", "12 min",
   "4:07" under ten minutes. */
export function formatLeft(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  if (s >= 3600) {
    const m = Math.floor((s % 3600) / 60);
    return Math.floor(s / 3600) + " h" + (m ? " " + ("0" + m).slice(-2) + " min" : "");
  }
  if (s >= 600) return Math.round(s / 60) + " min";
  return Math.floor(s / 60) + ":" + ("0" + (s % 60)).slice(-2);
}

/* The turn banner's clock (games.ts turnBanner): the countdown text
   and a bar that stays calm until the last quarter, then burns. Kept
   current by the 1 s ticker that also drives the duel clock bars. */
export function setTurnClock(b: HTMLElement) {
  const dl = +(b.getAttribute("data-turn-deadline") || 0);
  const dur = +(b.getAttribute("data-turn-dur") || 1);
  const left = Math.max(0, dl - Date.now());
  const pct = Math.max(0, Math.min(100, (left / dur) * 100));
  const fill = b.querySelector(".turn-bar > div") as HTMLElement | null;
  if (fill) fill.style.width = pct + "%";
  b.classList.toggle("hot", left > 0 && pct < 25);
  const lab = b.querySelector(".turn-left");
  if (lab) lab.textContent = left > 0 ? (b.getAttribute("data-turn-prefix") || "") + formatLeft(left) + " left" : "time's up";
}

export function setClockBar(bar: HTMLElement) {
  const dl = +(bar.getAttribute("data-duel-deadline") || 0);
  const dur = +(bar.getAttribute("data-duel-dur") || 1);
  const left = Math.max(0, dl - Date.now());
  const pct = Math.max(0, Math.min(100, (left / dur) * 100));
  if (bar.firstChild) (bar.firstChild as HTMLElement).style.width = pct + "%";
  bar.classList.toggle("low", pct < 20 && left > 0);
}
