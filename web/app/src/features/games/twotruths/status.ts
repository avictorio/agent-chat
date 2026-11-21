import type { GameStatus, TurnLine } from "../registry";
import type { TwoTruthsPlayer, TwoTruthsState, TwoTruthsYou } from "@chat/contract";
import { finalScore, recordLine, tickLen } from "../shared/render";

// The status hooks for Two Truths and a Lie (GameStatus in registry.ts):
// what the app says about a match's state in this game's words. Each is
// optional; a game without one gets the default where the hook is called.

export const twotruthsStatus: GameStatus = {
  finalScore(g: TwoTruthsState): string {
    return (g.players || []).slice().sort((a: TwoTruthsPlayer, b: TwoTruthsPlayer) => (b.score || 0) - (a.score || 0)).map((p: TwoTruthsPlayer) => p.score || 0).join("–");
  },

  recordLine(g: TwoTruthsState): string {
    const n = (g.rounds && g.rounds.length) || g.round || 0;
    return "Final · " + finalScore(g) + " · " + n + (n === 1 ? " round" : " rounds");
  },

  metaText(g: TwoTruthsState): string {
    if (g.status === "finished" || g.status === "cancelled") return recordLine(g);
    if (g.status === "lobby") {
      const waiting = (g.players || []).filter((p: TwoTruthsPlayer) => !p.accepted).map((p: TwoTruthsPlayer) => p.name);
      return "Lobby · waiting on " + (waiting.join(", ") || "no one") + " · " + (g.rounds_total || 0) + " rounds";
    }
    return "Round " + g.round + " of " + g.rounds_total + " · " + tickLen(g.round_seconds || 3600) + " to write, the same to vote";
  },

  stateLine(g: TwoTruthsState): string {
    const ps = g.players || [];
    return "Round " + (g.round || 1) + " of " + (g.rounds_total || "?") + (g.teller ? " · " + g.teller + (g.phase === "write" ? " writing" : " told") : "") + " · " + ps.slice().sort((a: TwoTruthsPlayer, b: TwoTruthsPlayer) => (b.score || 0) - (a.score || 0)).map((p: TwoTruthsPlayer) => p.name + " " + (p.score || 0)).join(" · ");
  },

  waitingOn(g: TwoTruthsState): string[] {
    const ps: TwoTruthsPlayer[] = g.players || [];
    return g.phase === "write" ? (g.teller ? [g.teller] : []) : ps.filter((p) => p.name !== g.teller && !p.committed).map((p) => p.name);
  },

  youLabel(g: TwoTruthsState): string {
    return g.phase === "write" ? "Your story" : "Your vote";
  },

  lengthLine(g: TwoTruthsState): string {
    return ((g.rounds && g.rounds.length) || g.round || 0) + " rounds";
  },

  signature(g: TwoTruthsState): string | null {
    return ["tt", g.status, g.round || 0, g.phase || "", (g.players || []).map((p: TwoTruthsPlayer) => p.score || 0).join("-")].join("|");
  },

  turnLine(g: TwoTruthsState, me: string): TurnLine {
    const you: Partial<TwoTruthsYou> = g.you || {};
    const players: TwoTruthsPlayer[] = g.players || [];
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
      const waiting = players.filter((p: TwoTruthsPlayer) => p.name !== g.teller && !p.committed && p.name !== me).map((p: TwoTruthsPlayer) => p.name);
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

  clockSeconds(g: TwoTruthsState): number {
    return g.round_seconds || 3600;
  },

  awaiting(g: TwoTruthsState, mine: TwoTruthsPlayer, me: string): boolean {
    return g.phase === "write" ? g.teller === me : g.teller !== me && !mine.committed;
  },

  mover(g: TwoTruthsState): string | null | undefined {
    return g.status === "running" ? g.teller || null : undefined;
  },
};
