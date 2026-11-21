import type { GameStatus, TurnLine } from "../registry";
import { finalScore, type GL, recordLine, tickLen } from "../shared/render";

// The status hooks for Sketch & Guess (GameStatus in registry.ts):
// what the app says about a match's state in this game's words. Each is
// optional; a game without one gets the default where the hook is called.

export const sketchStatus: GameStatus = {
  finalScore(g: GL): string {
    return (g.players || []).slice().sort((a: GL, b: GL) => (b.score || 0) - (a.score || 0)).map((p: GL) => p.score || 0).join("–");
  },

  recordLine(g: GL): string {
    const n = (g.rounds && g.rounds.length) || g.rounds_total || 0;
    return "Final · " + finalScore(g) + " · " + n + (n === 1 ? " drawing" : " drawings");
  },

  metaText(g: GL): string {
    if (g.status === "finished" || g.status === "cancelled") return recordLine(g);
    if (g.status === "lobby") {
      const waiting = (g.players || []).filter((p: GL) => !p.accepted).map((p: GL) => p.name);
      return "Lobby · waiting on " + (waiting.join(", ") || "no one") + " · " + (g.rounds_total || 0) + " drawings";
    }
    return "Round " + g.round + " of " + g.rounds_total + " · " + (g.artist || "?") + (g.phase === "draw" ? " drawing" : " drew") + " · " + tickLen(g.phase === "guess" ? g.guess_seconds || 600 : g.draw_seconds || 3600) + (g.phase === "guess" ? " to guess" : " to draw");
  },

  stateLine(g: GL): string {
    const ps = g.players || [];
    return "Round " + (g.round || 1) + " of " + (g.rounds_total || "?") + (g.artist ? " · " + g.artist + (g.phase === "draw" ? " drawing" : g.phase === "judging" ? " · judging" : " drew") : "") + " · " + ps.slice().sort((a: GL, b: GL) => (b.score || 0) - (a.score || 0)).map((p: GL) => p.name + " " + (p.score || 0)).join(" · ");
  },

  waitingOn(g: GL): string[] {
    const ps: GL[] = g.players || [];
    return g.phase === "draw" ? (g.artist ? [g.artist] : []) : g.phase === "guess" ? ps.filter((p) => p.name !== g.artist && !p.committed).map((p) => p.name) : [];
  },

  youLabel(g: GL): string {
    return g.phase === "draw" ? "Your drawing" : "Your guess";
  },

  lengthLine(g: GL): string {
    return ((g.rounds && g.rounds.length) || g.rounds_total || 0) + " drawings";
  },

  signature(g: GL): string | null {
    return ["sg", g.status, g.round || 0, g.phase || "", (g.rounds || []).length].join("|");
  },

  turnLine(g: GL, me: string): TurnLine {
    const you = g.you || {};
    const players: GL[] = g.players || [];
    let text = "";
    let sub = "";
    let mine = false;
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
    return { text, sub, mine };
  },

  clockSeconds(g: GL): number {
    return g.phase === "guess" ? g.guess_seconds || 600 : g.draw_seconds || 3600;
  },

  awaiting(g: GL, mine: GL, me: string): boolean {
    return g.phase === "draw" ? g.artist === me : g.phase === "guess" ? g.artist !== me && !mine.committed : false;
  },

  mover(g: GL): string | null | undefined {
    return g.status === "running" ? g.artist || null : undefined;
  },
};
