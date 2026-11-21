import type { GameStatus, TurnLine } from "../registry";
import { finalScore, type GL, recordLine, tickLen } from "../shared/render";

// The status hooks for Trust (GameStatus in registry.ts):
// what the app says about a match's state in this game's words. Each is
// optional; a game without one gets the default where the hook is called.

export const trustStatus: GameStatus = {
  finalScore(g: GL): string {
    return (g.players || []).slice().sort((a: GL, b: GL) => (b.score || 0) - (a.score || 0)).map((p: GL) => p.score || 0).join("–");
  },

  recordLine(g: GL): string {
    const n = (g.rounds && g.rounds.length) || g.last_round || Math.max(0, (g.round || 1) - 1);
    return "Final · " + finalScore(g) + " · " + n + (n === 1 ? " round" : " rounds");
  },

  metaText(g: GL): string {
    if (g.status === "finished" || g.status === "cancelled") return recordLine(g);
    if (g.status === "lobby") {
      const waiting = (g.players || []).filter((p: GL) => !p.accepted).map((p: GL) => p.name);
      return "Lobby · waiting on " + (waiting.join(", ") || "no one") + " · about " + (g.rounds_about || 10) + " rounds";
    }
    return "Round " + g.round + " of about " + (g.rounds_about || 10) + " · " + tickLen(g.round_seconds || 180) + " per round";
  },

  stateLine(g: GL): string {
    const ps = g.players || [];
    return "Round " + (g.round || 1) + " · " + ps.slice().sort((a: GL, b: GL) => (b.score || 0) - (a.score || 0)).map((p: GL) => p.name + " " + (p.score || 0)).join(" · ");
  },

  waitingOn(g: GL): string[] {
    const ps: GL[] = g.players || [];
    return ps.filter((p) => !p.committed && !p.out).map((p) => p.name);
  },

  youLabel(g: GL): string {
    return "Your choices";
  },

  lengthLine(g: GL): string {
    return ((g.rounds && g.rounds.length) || Math.max(0, (g.round || 1) - 1)) + " rounds";
  },

  signature(g: GL): string | null {
    return ["tr", g.status, g.round || 0, (g.rounds || []).length].join("|");
  },

  turnLine(g: GL, me: string): TurnLine {
    const you = g.you || {};
    const players: GL[] = g.players || [];
    let text = "";
    let sub = "";
    let mine = false;
    const waiting = players.filter((p: GL) => !p.committed && !p.out && p.name !== me).map((p: GL) => p.name);
    if (you.playing && you.out) text = "You're out of this match" + (waiting.length ? " · waiting on " + waiting.join(", ") : "");
    else if (you.playing && you.queued) text = "Your choices are in · " + (waiting.length ? "waiting on " + waiting.join(", ") : "resolving…");
    else if (you.playing) {
      mine = true;
      text = "Your choices · round " + g.round;
      sub = "If the clock runs out, you defect on everyone this round.";
    } else text = "Round " + g.round + " · " + (waiting.length ? "waiting on " + waiting.join(", ") : "resolving…");
    return { text, sub, mine };
  },

  clockSeconds(g: GL): number {
    return g.round_seconds || 180;
  },

  awaiting(g: GL, mine: GL, me: string): boolean {
    return !mine.committed && !mine.out;
  },
};
