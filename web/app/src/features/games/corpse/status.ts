import type { GameStatus, TurnLine } from "../registry";
import { recordLine, tickLen, winnerOf } from "../shared/render";
import type { CorpsePlayer, CorpseState, CorpseYou } from "@chat/contract";

// The status hooks for Exquisite Corpse (GameStatus in registry.ts):
// what the app says about a match's state in this game's words. Each is
// optional; a game without one gets the default where the hook is called.

export const corpseStatus: GameStatus<CorpseState> = {
  finalScore(g: CorpseState): string {
    const w: CorpsePlayer | null = winnerOf(g);
    return w && w.votes ? "★ " + w.votes : "";
  },

  recordLine(g: CorpseState): string {
    const n = g.segments || (g.story || []).length;
    return ((g.honours || []).length > 1 ? "Shared honours" : (g.honours || []).length ? "The honours" : "No favourite") + " · " + n + (n === 1 ? " segment" : " segments");
  },

  metaText(g: CorpseState): string {
    if (g.status === "finished" || g.status === "cancelled") return recordLine(g);
    if (g.status === "lobby") {
      const waiting = (g.players || []).filter((p: CorpsePlayer) => !p.accepted).map((p: CorpsePlayer) => p.name);
      return "Lobby · waiting on " + (waiting.join(", ") || "no one") + " · " + (g.turns_total || 0) + " turns" + (g.genre ? " · " + g.genre : "");
    }
    if (g.phase === "vote") return "The story is revealed · " + (g.segments || 0) + " segments · vote for a favourite";
    return "Turn " + g.turn + " of " + g.turns_total + " · " + tickLen(g.turn_seconds || 86400) + " per turn" + (g.genre ? " · " + g.genre : "");
  },

  stateLine(g: CorpseState): string {
    return g.phase === "vote" ? "Revealed · " + (g.segments || 0) + " segments · voting" : "Turn " + (g.turn || 1) + " of " + (g.turns_total || "?") + (g.turn_of ? " · " + g.turn_of + " writing" : "");
  },

  waitingOn(g: CorpseState): string[] {
    const ps: CorpsePlayer[] = g.players || [];
    return g.phase === "write" ? (g.turn_of ? [g.turn_of] : []) : ps.filter((p) => !p.committed).map((p) => p.name);
  },

  youLabel(g: CorpseState): string {
    return g.phase === "write" ? "Your segment" : "Your favourite";
  },

  lengthLine(g: CorpseState): string {
    return (g.segments || 0) + " segments";
  },

  signature(g: CorpseState): string | null {
    return ["ec", g.status, g.phase || "", g.turn || 0, g.segments || 0, (g.players || []).filter((p: CorpsePlayer) => p.committed).length].join("|");
  },

  turnLine(g: CorpseState, me: string): TurnLine {
    const you: Partial<CorpseYou> = g.you || {};
    const players: CorpsePlayer[] = g.players || [];
    let text = "";
    let sub = "";
    let mine = false;
    if (g.phase === "write") {
      if (you.playing && you.writer) {
        mine = true;
        text = "Your turn to write · turn " + g.turn + " of " + g.turns_total;
        sub = "You see only the segment before yours. If the clock runs out, your turn is a silent beat.";
      } else text = (g.turn_of || "Someone") + " is writing · turn " + g.turn + " of " + g.turns_total;
    } else {
      const waiting = players.filter((p: CorpsePlayer) => !p.committed && p.name !== me).map((p: CorpsePlayer) => p.name);
      if (you.playing && you.vote != null) text = "Your favourite is in · " + (waiting.length ? "waiting on " + waiting.join(", ") : "counting…");
      else if (you.playing) {
        mine = true;
        text = "The story is revealed · pick a favourite";
        sub = "Any segment but your own.";
      } else text = "The story is revealed · voting";
    }
    return { text, sub, mine };
  },

  clockSeconds(g: CorpseState): number {
    return g.turn_seconds || 86400;
  },

  awaiting(g: CorpseState, mine: CorpsePlayer, me: string): boolean {
    return g.phase === "write" ? g.turn_of === me : !mine.committed;
  },

  mover(g: CorpseState): string | null | undefined {
    return g.status === "running" ? g.turn_of || null : undefined;
  },
};
