import type { GameStatus, TurnLine } from "../registry";
import { finalScore, type GL, recordLine, tickLen, winnerFirst } from "../shared/render";

// The status hooks for Duel (GameStatus in registry.ts):
// what the app says about a match's state in this game's words. Each is
// optional; a game without one gets the default where the hook is called.

export const duelStatus: GameStatus = {
  finalScore(g: GL): string {
    const sc = g.score || {};
    const wins = (p: GL) => (sc[p.name] != null ? sc[p.name] : p.wins || 0);
    return winnerFirst(g).map(wins).join("–");
  },

  recordLine(g: GL): string {
    return "Final · " + finalScore(g) + " · " + (g.round || 0) + " rounds";
  },

  metaText(g: GL): string {
    if (g.status === "finished" || g.status === "cancelled") return recordLine(g);
    if (g.status === "lobby") {
      const waiting = (g.players || []).filter((p: GL) => !p.accepted).map((p: GL) => p.name);
      return "Lobby · waiting on " + (waiting.join(", ") || "no one") + " · first to " + g.target;
    }
    // 180 s is the server's default round deadline (since 2026-11-12)
    return "Round " + g.round + " · first to " + g.target + " · ties replay · " + tickLen(g.round_seconds || 180) + " per round";
  },

  stateLine(g: GL): string {
    const ps = g.players || [];
    return "Round " + (g.round || 1) + " · " + ps.map((p: GL) => p.name + " " + (p.wins || 0)).join(" · ");
  },

  waitingOn(g: GL): string[] {
    const ps: GL[] = g.players || [];
    return ps.filter((p) => !p.thrown).map((p) => p.name);
  },

  youLabel(g: GL): string {
    return "Your throw";
  },

  lengthLine(g: GL): string {
    return (g.round || 0) + " rounds";
  },

  signature(g: GL): string | null {
    const rounds = g.rounds || [];
    const sc = g.score || {};
    return [g.type, g.status, g.round || 0, rounds.length, Object.values(sc).join("-")].join("|");
  },

  turnLine(g: GL, me: string): TurnLine {
    const you = g.you || {};
    const players: GL[] = g.players || [];
    const opp = players.filter((p: GL) => p.name !== me)[0];
    let text = "";
    let sub = "";
    let mine = false;
    if (you.playing && opp) {
      if (you.queued) text = "You're in · waiting on " + opp.name;
      else {
        mine = true;
        text = opp.thrown ? opp.name + " is in · your throw decides the round" : "Your throw · round " + g.round;
        sub = "If the clock runs out, a lone throw takes the round.";
      }
    } else text = players.map((p: GL) => p.name + (p.thrown ? " locked ✓" : " thinking…")).join(" · ");
    return { text, sub, mine };
  },

  clockSeconds(g: GL): number {
    return g.round_seconds || 180;
  },

  awaiting(g: GL, mine: GL, me: string): boolean {
    return !mine.thrown;
  },

  mover(g: GL): string | null | undefined {
    return g.rounds && g.rounds.length ? g.rounds[g.rounds.length - 1].winner || null : undefined;
  },
};
