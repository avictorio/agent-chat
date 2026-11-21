import type { DuelPlayer, DuelState, DuelYou } from "@chat/contract";
import type { GameStatus, TurnLine } from "../registry";
import { finalScore, recordLine, tickLen, winnerFirst } from "../shared/render";

// The status hooks for Duel (GameStatus in registry.ts):
// what the app says about a match's state in this game's words. Each is
// optional; a game without one gets the default where the hook is called.

export const duelStatus: GameStatus<DuelState> = {
  finalScore(g: DuelState): string {
    const sc = g.score || {};
    const wins = (p: DuelPlayer) => (sc[p.name] != null ? sc[p.name] : p.wins || 0);
    return winnerFirst(g).map(wins).join("–");
  },

  recordLine(g: DuelState): string {
    return "Final · " + finalScore(g) + " · " + (g.round || 0) + " rounds";
  },

  metaText(g: DuelState): string {
    if (g.status === "finished" || g.status === "cancelled") return recordLine(g);
    if (g.status === "lobby") {
      const waiting = (g.players || []).filter((p: DuelPlayer) => !p.accepted).map((p: DuelPlayer) => p.name);
      return "Lobby · waiting on " + (waiting.join(", ") || "no one") + " · first to " + g.target;
    }
    // 180 s is the server's default round deadline (since 2026-11-12)
    return "Round " + g.round + " · first to " + g.target + " · ties replay · " + tickLen(g.round_seconds || 180) + " per round";
  },

  stateLine(g: DuelState): string {
    const ps = g.players || [];
    return "Round " + (g.round || 1) + " · " + ps.map((p: DuelPlayer) => p.name + " " + (p.wins || 0)).join(" · ");
  },

  waitingOn(g: DuelState): string[] {
    const ps: DuelPlayer[] = g.players || [];
    return ps.filter((p) => !p.thrown).map((p) => p.name);
  },

  youLabel(g: DuelState): string {
    return "Your throw";
  },

  lengthLine(g: DuelState): string {
    return (g.round || 0) + " rounds";
  },

  signature(g: DuelState): string | null {
    const rounds = g.rounds || [];
    const sc = g.score || {};
    return [g.type, g.status, g.round || 0, rounds.length, Object.values(sc).join("-")].join("|");
  },

  turnLine(g: DuelState, me: string): TurnLine {
    const you: Partial<DuelYou> = g.you || {};
    const players: DuelPlayer[] = g.players || [];
    const opp = players.filter((p: DuelPlayer) => p.name !== me)[0];
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
    } else text = players.map((p: DuelPlayer) => p.name + (p.thrown ? " locked ✓" : " thinking…")).join(" · ");
    return { text, sub, mine };
  },

  clockSeconds(g: DuelState): number {
    return g.round_seconds || 180;
  },

  awaiting(g: DuelState, mine: DuelPlayer, me: string): boolean {
    return !mine.thrown;
  },

  mover(g: DuelState): string | null | undefined {
    return g.rounds && g.rounds.length ? g.rounds[g.rounds.length - 1]!.winner || null : undefined;
  },
};
