import type { GameStatus, TurnLine } from "../registry";
import type { LetterGridPlayer, LetterGridState, LetterGridYou } from "@chat/contract";
import { finalScore, recordLine, tickLen } from "../shared/render";

// The status hooks for Letter Grid (GameStatus in registry.ts):
// what the app says about a match's state in this game's words. Each is
// optional; a game without one gets the default where the hook is called.

export const lettergridStatus: GameStatus = {
  finalScore(g: LetterGridState): string {
    return (g.players || []).slice().sort((a: LetterGridPlayer, b: LetterGridPlayer) => (b.score || 0) - (a.score || 0)).map((p: LetterGridPlayer) => p.score || 0).join("–");
  },

  recordLine(g: LetterGridState): string {
    const n = (g.rounds && g.rounds.length) || g.rounds_total || 0;
    return "Final · " + finalScore(g) + " · " + n + (n === 1 ? " round" : " rounds");
  },

  metaText(g: LetterGridState): string {
    if (g.status === "finished" || g.status === "cancelled") return recordLine(g);
    const shape = (g.size || 5) + "x" + (g.size || 5) + " grid";
    if (g.status === "lobby") {
      const waiting = (g.players || []).filter((p: LetterGridPlayer) => !p.accepted).map((p: LetterGridPlayer) => p.name);
      return "Lobby · waiting on " + (waiting.join(", ") || "no one") + " · " + shape + " · " + (g.rounds_total || 8) + " rounds";
    }
    return "Round " + g.round + " of " + g.rounds_total + " · " + shape + " · " + tickLen(g.round_seconds || 3600) + " per round";
  },

  stateLine(g: LetterGridState): string {
    const ps = g.players || [];
    return "Round " + (g.round || 1) + " of " + (g.rounds_total || "?") + " · " + ps.slice().sort((a: LetterGridPlayer, b: LetterGridPlayer) => (b.score || 0) - (a.score || 0)).map((p: LetterGridPlayer) => p.name + " " + (p.score || 0)).join(" · ");
  },

  waitingOn(g: LetterGridState): string[] {
    const ps: LetterGridPlayer[] = g.players || [];
    return ps.filter((p) => !p.committed && !p.out).map((p) => p.name);
  },

  youLabel(g: LetterGridState): string {
    return "Your word";
  },

  lengthLine(g: LetterGridState): string {
    return ((g.rounds && g.rounds.length) || Math.max(0, (g.round || 1) - 1)) + " rounds";
  },

  signature(g: LetterGridState): string | null {
    return ["lg", g.status, g.round || 0, (g.rounds || []).length].join("|");
  },

  turnLine(g: LetterGridState, me: string): TurnLine {
    const you: Partial<LetterGridYou> = g.you || {};
    const players: LetterGridPlayer[] = g.players || [];
    let text = "";
    let sub = "";
    let mine = false;
    const waiting = players.filter((p: LetterGridPlayer) => !p.committed && !p.out && p.name !== me).map((p: LetterGridPlayer) => p.name);
    if (you.playing && you.out) text = "You're out of this match" + (waiting.length ? " · waiting on " + waiting.join(", ") : "");
    else if (you.playing && you.queued) text = "Your word is in · " + (waiting.length ? "waiting on " + waiting.join(", ") : "resolving…");
    else if (you.playing) {
      mine = true;
      text = "Your word · round " + g.round + " of " + g.rounds_total;
      sub = "If the clock runs out, you score nothing this round.";
    } else text = "Round " + g.round + " · " + (waiting.length ? "waiting on " + waiting.join(", ") : "resolving…");
    return { text, sub, mine };
  },

  clockSeconds(g: LetterGridState): number {
    return g.round_seconds || 3600;
  },

  awaiting(g: LetterGridState, mine: LetterGridPlayer, me: string): boolean {
    return !mine.committed && !mine.out;
  },
};
