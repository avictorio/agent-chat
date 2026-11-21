import type { GameStatus, TurnLine } from "../registry";
import { finalScore, type GL, recordLine, tickLen } from "../shared/render";

// The status hooks for Trivia (GameStatus in registry.ts):
// what the app says about a match's state in this game's words. Each is
// optional; a game without one gets the default where the hook is called.

export const triviaStatus: GameStatus = {
  finalScore(g: GL): string {
    return (g.players || []).slice().sort((a: GL, b: GL) => (b.balance || 0) - (a.balance || 0)).map((p: GL) => p.balance || 0).join("–");
  },

  recordLine(g: GL): string {
    const n = (g.rounds && g.rounds.length) || g.rounds_total || 0;
    return "Final · " + finalScore(g) + " points · " + n + (n === 1 ? " question" : " questions");
  },

  metaText(g: GL): string {
    if (g.status === "finished" || g.status === "cancelled") return recordLine(g);
    if (g.status === "lobby") {
      const waiting = (g.players || []).filter((p: GL) => !p.accepted).map((p: GL) => p.name);
      return "Lobby · waiting on " + (waiting.join(", ") || "no one") + " · " + (g.rounds_total || 0) + " questions";
    }
    return "Round " + g.round + " of " + g.rounds_total + " · " + (g.asker || "?") + " asks · " + tickLen(g.round_seconds || 3600) + " a phase";
  },

  stateLine(g: GL): string {
    const ps = g.players || [];
    return "Round " + (g.round || 1) + " of " + (g.rounds_total || "?") + (g.asker ? " · " + g.asker + (g.phase === "ask" ? " writing" : g.phase === "judge" ? " judging" : " asked") : "") + " · " + ps.slice().sort((a: GL, b: GL) => (b.balance || 0) - (a.balance || 0)).map((p: GL) => p.name + " " + (p.balance != null ? p.balance : 100)).join(" · ");
  },

  waitingOn(g: GL): string[] {
    const ps: GL[] = g.players || [];
    return g.phase === "answer" ? ps.filter((p) => p.name !== g.asker && !p.committed).map((p) => p.name) : g.asker ? [g.asker] : [];
  },

  youLabel(g: GL): string {
    return g.phase === "ask" ? "Your question" : g.phase === "judge" ? "Your ruling" : "Your answer";
  },

  lengthLine(g: GL): string {
    return ((g.rounds && g.rounds.length) || g.rounds_total || 0) + " questions";
  },

  signature(g: GL): string | null {
    return ["tv", g.status, g.round || 0, g.phase || "", (g.rounds || []).length].join("|");
  },

  turnLine(g: GL, me: string): TurnLine {
    const you = g.you || {};
    const players: GL[] = g.players || [];
    let text = "";
    let sub = "";
    let mine = false;
    const waiting = players.filter((p: GL) => !p.committed && p.name !== g.asker && p.name !== me).map((p: GL) => p.name);
    if (you.playing && you.asker) {
      if (g.phase === "ask") {
        mine = true;
        text = "You're the quizmaster · ask a question";
        sub = "If the clock runs out, you forfeit the round.";
      } else if (g.phase === "judge") {
        mine = true;
        text = "Judge the answers the match missed";
        sub = "If the clock runs out, the reveal counts them wrong.";
      } else text = "Your question is up · " + (waiting.length ? "waiting on " + waiting.join(", ") : "closing…");
    } else if (g.phase === "ask") text = (g.asker || "The quizmaster") + " is writing a question · round " + g.round + " of " + g.rounds_total;
    else if (g.phase === "judge") text = (g.asker || "The quizmaster") + " is judging the answers";
    else if (you.playing && you.queued) text = "Your answer is in · " + (waiting.length ? "waiting on " + waiting.join(", ") : "closing…");
    else if (you.playing) {
      mine = true;
      text = "Your answer · round " + g.round + " of " + g.rounds_total;
      sub = "If the clock runs out, you score nothing (and lose nothing).";
    } else text = "Round " + g.round + " · " + (waiting.length ? "waiting on " + waiting.join(", ") : "closing…");
    return { text, sub, mine };
  },

  clockSeconds(g: GL): number {
    return g.round_seconds || 3600;
  },

  awaiting(g: GL, mine: GL, me: string): boolean {
    return g.phase === "answer" ? g.asker !== me && !mine.committed : g.asker === me;
  },

  mover(g: GL): string | null | undefined {
    return g.status === "running" ? g.asker || null : undefined;
  },
};
