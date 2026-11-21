import type { GameStatus, TurnLine } from "../registry";
import { finalScore, type GL, recordLine, tickLen } from "../shared/render";

// The status hooks for Two Truths and a Lie (GameStatus in registry.ts):
// what the app says about a match's state in this game's words. Each is
// optional; a game without one gets the default where the hook is called.

export const twotruthsStatus: GameStatus = {
  finalScore(g: GL): string {
    return (g.players || []).slice().sort((a: GL, b: GL) => (b.score || 0) - (a.score || 0)).map((p: GL) => p.score || 0).join("–");
  },

  recordLine(g: GL): string {
    const n = (g.rounds && g.rounds.length) || g.round || 0;
    return "Final · " + finalScore(g) + " · " + n + (n === 1 ? " round" : " rounds");
  },

  metaText(g: GL): string {
    if (g.status === "finished" || g.status === "cancelled") return recordLine(g);
    if (g.status === "lobby") {
      const waiting = (g.players || []).filter((p: GL) => !p.accepted).map((p: GL) => p.name);
      return "Lobby · waiting on " + (waiting.join(", ") || "no one") + " · " + (g.rounds_total || 0) + " rounds";
    }
    return "Round " + g.round + " of " + g.rounds_total + " · " + tickLen(g.round_seconds || 3600) + " to write, the same to vote";
  },

  stateLine(g: GL): string {
    const ps = g.players || [];
    return "Round " + (g.round || 1) + " of " + (g.rounds_total || "?") + (g.teller ? " · " + g.teller + (g.phase === "write" ? " writing" : " told") : "") + " · " + ps.slice().sort((a: GL, b: GL) => (b.score || 0) - (a.score || 0)).map((p: GL) => p.name + " " + (p.score || 0)).join(" · ");
  },

  waitingOn(g: GL): string[] {
    const ps: GL[] = g.players || [];
    return g.phase === "write" ? (g.teller ? [g.teller] : []) : ps.filter((p) => p.name !== g.teller && !p.committed).map((p) => p.name);
  },

  youLabel(g: GL): string {
    return g.phase === "write" ? "Your story" : "Your vote";
  },

  lengthLine(g: GL): string {
    return ((g.rounds && g.rounds.length) || g.round || 0) + " rounds";
  },

  signature(g: GL): string | null {
    return ["tt", g.status, g.round || 0, g.phase || "", (g.players || []).map((p: GL) => p.score || 0).join("-")].join("|");
  },

  turnLine(g: GL, me: string): TurnLine {
    const you = g.you || {};
    const players: GL[] = g.players || [];
    let text = "";
    let sub = "";
    let mine = false;
    if (g.phase === "write") {
      if (you.playing && you.teller) {
        mine = true;
        text = "Your turn to tell · round " + g.round + " of " + g.rounds_total;
        sub = "Two truths and a lie about you. If the clock runs out, you forfeit the round.";
      } else text = (g.teller || "The storyteller") + " is writing · round " + g.round + " of " + g.rounds_total;
    } else {
      const waiting = players.filter((p: GL) => p.name !== g.teller && !p.committed && p.name !== me).map((p: GL) => p.name);
      const rest = waiting.length ? "waiting on " + waiting.join(", ") : "revealing…";
      if (you.playing && you.teller) text = "Your statements are up · " + rest;
      else if (you.playing && you.vote != null) text = "Your vote is in · " + rest;
      else if (you.playing) {
        mine = true;
        text = "Spot the lie · " + g.teller + "'s statements";
        sub = "If the clock runs out, you score nothing this round.";
      } else text = "Voting on " + g.teller + "'s statements · " + rest;
    }
    return { text, sub, mine };
  },

  clockSeconds(g: GL): number {
    return g.round_seconds || 3600;
  },

  awaiting(g: GL, mine: GL, me: string): boolean {
    return g.phase === "write" ? g.teller === me : g.teller !== me && !mine.committed;
  },

  mover(g: GL): string | null | undefined {
    return g.status === "running" ? g.teller || null : undefined;
  },
};
