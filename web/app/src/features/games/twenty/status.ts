import type { GameStatus, TurnLine } from "../registry";
import { finalScore, recordLine, tickLen } from "../shared/render";
import type { TwentyPlayer, TwentyState, TwentyYou } from "@chat/contract";

// The status hooks for Twenty Questions (GameStatus in registry.ts):
// what the app says about a match's state in this game's words. Each is
// optional; a game without one gets the default where the hook is called.

export const twentyStatus: GameStatus = {
  finalScore(g: TwentyState): string {
    return (g.players || []).slice().sort((a: TwentyPlayer, b: TwentyPlayer) => (b.score || 0) - (a.score || 0)).map((p: TwentyPlayer) => p.score || 0).join("–");
  },

  recordLine(g: TwentyState): string {
    const n = (g.rounds && g.rounds.length) || g.rounds_total || 0;
    return "Final · " + finalScore(g) + " · " + n + (n === 1 ? " round" : " rounds");
  },

  metaText(g: TwentyState): string {
    if (g.status === "finished" || g.status === "cancelled") return recordLine(g);
    if (g.status === "lobby") {
      const waiting = (g.players || []).filter((p: TwentyPlayer) => !p.accepted).map((p: TwentyPlayer) => p.name);
      return "Lobby · waiting on " + (waiting.join(", ") || "no one") + " · " + (g.rounds_total || 0) + " rounds";
    }
    return "Round " + g.round + " of " + g.rounds_total + " · " + tickLen(g.round_seconds || 3600) + " a move · " + (g.mode === "table" ? "the table asks together" : "head to head");
  },

  stateLine(g: TwentyState): string {
    return "Round " + (g.round || 1) + " of " + (g.rounds_total || "?") + (g.answerer ? " · " + g.answerer + (g.phase === "secret" ? " choosing" : " answering · " + (g.asked || 0) + "/20") : "");
  },

  waitingOn(g: TwentyState): string[] {
    const ps: TwentyPlayer[] = g.players || [];
    return g.phase === "ask" ? ps.filter((p) => p.name !== g.answerer).map((p) => p.name) : g.answerer ? [g.answerer] : [];
  },

  youLabel(g: TwentyState): string {
    return g.phase === "secret" ? "Your secret" : g.phase === "answer" ? "Your answer" : "Your question";
  },

  lengthLine(g: TwentyState): string {
    return ((g.rounds && g.rounds.length) || g.rounds_total || 0) + " rounds";
  },

  signature(g: TwentyState): string | null {
    return ["tq", g.status, g.round || 0, g.phase || "", g.asked || 0].join("|");
  },

  turnLine(g: TwentyState, me: string): TurnLine {
    const you: Partial<TwentyYou> = g.you || {};
    let text = "";
    let sub = "";
    let mine = false;
    const left = (g.remaining != null ? g.remaining : 20) + " of 20 left";
    if (you.playing && you.answerer) {
      if (g.phase === "secret") {
        mine = true;
        text = "Your turn to answer · choose a secret";
        sub = "If the clock runs out, one is drawn for you.";
      } else if (g.phase === "answer") {
        mine = true;
        text = (g.pending ? g.pending.by : "Someone") + (g.pending && g.pending.kind === "guess" ? " guesses" : " asks") + " · answer";
        sub = "If the clock runs out on a question, you forfeit the round.";
      } else text = "You hold the secret · waiting for a question · " + left;
    } else if (g.phase === "secret") text = (g.answerer || "The answerer") + " is choosing a secret · round " + g.round + " of " + g.rounds_total;
    else if (g.phase === "answer") text = "Waiting on " + g.answerer + "'s answer · " + left;
    else if (you.playing) {
      mine = true;
      text = "Ask " + g.answerer + " a question · " + left;
      sub = g.mode === "table" ? "Anyone at the table may ask - one question at a time." : "A yes/no question, or a guess.";
    } else text = "Questions for " + g.answerer + " · " + left;
    return { text, sub, mine };
  },

  clockSeconds(g: TwentyState): number {
    return g.round_seconds || 3600;
  },

  awaiting(g: TwentyState, mine: TwentyPlayer, me: string): boolean {
    return g.phase === "ask" ? g.answerer !== me : g.answerer === me;
  },

  mover(g: TwentyState): string | null | undefined {
    return g.status === "running" ? g.answerer || null : undefined;
  },
};
