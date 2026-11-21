import type { GameStatus, TurnLine } from "../registry";
import { finalScore, type GL, recordLine, tickLen, winnerFirst } from "../shared/render";

// The status hooks for Auction (GameStatus in registry.ts):
// what the app says about a match's state in this game's words. Each is
// optional; a game without one gets the default where the hook is called.

export const auctionStatus: GameStatus = {
  finalScore(g: GL): string {
    return winnerFirst(g).map((p: GL) => p.won || 0).join("–");
  },

  recordLine(g: GL): string {
    const n = (g.rounds && g.rounds.length) || g.lots_total || 0;
    return "Final · " + finalScore(g) + " lots won · " + n + " lots";
  },

  metaText(g: GL): string {
    if (g.status === "finished" || g.status === "cancelled") return recordLine(g);
    if (g.status === "lobby") {
      const waiting = (g.players || []).filter((p: GL) => !p.accepted).map((p: GL) => p.name);
      return "Lobby · waiting on " + (waiting.join(", ") || "no one") + " · " + g.lots_total + " lots · " + g.budget + " each";
    }
    return "Lot " + g.round + " of " + g.lots_total + " · " + tickLen(g.round_seconds || 180) + " per lot";
  },

  stateLine(g: GL): string {
    const ps = g.players || [];
    return "Lot " + (g.round || 1) + " of " + (g.lots_total || "?") + " · " + ps.slice().sort((a: GL, b: GL) => (b.won || 0) - (a.won || 0)).map((p: GL) => p.name + " " + (p.won || 0)).join(" · ");
  },

  waitingOn(g: GL): string[] {
    const ps: GL[] = g.players || [];
    return ps.filter((p) => !p.committed && (p.budget || 0) > 0).map((p) => p.name);
  },

  youLabel(g: GL): string {
    return "Your bid";
  },

  lengthLine(g: GL): string {
    return ((g.rounds && g.rounds.length) || g.lots_total || 0) + " lots";
  },

  signature(g: GL): string | null {
    return ["au", g.status, g.round || 0, (g.rounds || []).length].join("|");
  },

  turnLine(g: GL, me: string): TurnLine {
    const you = g.you || {};
    const players: GL[] = g.players || [];
    let text = "";
    let sub = "";
    let mine = false;
    const waiting = players.filter((p: GL) => !p.committed && (p.budget || 0) > 0 && p.name !== me).map((p: GL) => p.name);
    if (you.playing && (you.budget || 0) <= 0) text = "You've spent out · " + (waiting.length ? "waiting on " + waiting.join(", ") : "resolving…");
    else if (you.playing && you.queued != null) text = "Your bid is in · " + (waiting.length ? "waiting on " + waiting.join(", ") : "resolving…");
    else if (you.playing) {
      mine = true;
      text = "Your bid · lot " + g.round + " of " + g.lots_total;
      sub = "If the clock runs out, you pass on this lot.";
    } else text = "Lot " + g.round + " · " + (waiting.length ? "waiting on " + waiting.join(", ") : "resolving…");
    return { text, sub, mine };
  },

  clockSeconds(g: GL): number {
    return g.round_seconds || 180;
  },

  awaiting(g: GL, mine: GL, me: string): boolean {
    return !mine.committed && (mine.budget || 0) > 0;
  },

  mover(g: GL): string | null | undefined {
    return g.rounds && g.rounds.length ? g.rounds[g.rounds.length - 1].winner || null : undefined;
  },
};
