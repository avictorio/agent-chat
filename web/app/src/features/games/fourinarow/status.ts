import type { GameStatus, TurnLine } from "../registry";
import { type GL, recordLine, tickLen } from "../shared/render";

// The status hooks for Four in a Row (GameStatus in registry.ts):
// what the app says about a match's state in this game's words. Each is
// optional; a game without one gets the default where the hook is called.

export const fourinarowStatus: GameStatus = {
  finalScore(g: GL): string {
    // a forfeit was not won on the last move: say how it was won
    return g.winner && g.moves ? (g.forfeit ? "by forfeit" : "move " + g.moves.length) : "";
  },

  recordLine(g: GL): string {
    const n = (g.moves && g.moves.length) || (g.last_move ? g.last_move.n : 0);
    return (g.draw ? "Draw" : g.forfeit ? "Won by forfeit" : "Four in a row") + " · " + n + (n === 1 ? " move" : " moves");
  },

  metaText(g: GL): string {
    if (g.status === "finished" || g.status === "cancelled") return recordLine(g);
    if (g.status === "lobby") {
      const waiting = (g.players || []).filter((p: GL) => !p.accepted).map((p: GL) => p.name);
      return "Lobby · waiting on " + (waiting.join(", ") || "no one") + " · " + (g.first ? g.first + " moves first · " : "") + tickLen(g.turn_seconds || 3600) + " per turn";
    }
    return "Turn " + g.turn + (g.turn_of ? " · " + g.turn_of + " to move" : "") + " · " + tickLen(g.turn_seconds || 3600) + " per turn";
  },

  stateLine(g: GL): string {
    return "Turn " + (g.turn || 1) + (g.turn_of ? " · " + g.turn_of + " to move" : "");
  },

  waitingOn(g: GL): string[] {
    return g.turn_of ? [g.turn_of] : [];
  },

  youLabel(g: GL): string {
    return "Your move";
  },

  lengthLine(g: GL): string {
    return ((g.last_move && g.last_move.n) || 0) + " moves";
  },

  signature(g: GL): string | null {
    return ["c4", g.status, g.turn || 0, (g.board || []).join("")].join("|");
  },

  turnLine(g: GL, me: string): TurnLine {
    const you = g.you || {};
    let text = "";
    let sub = "";
    let mine = false;
    if (you.playing && you.your_turn) {
      mine = true;
      text = "Your move · turn " + g.turn;
      const to = you.timeouts || 0;
      sub = to >= 2 ? "You've timed out twice - one more forfeits the match." : to === 1 ? "You timed out once - three timeouts forfeit the match." : "Tap a column to drop your disc.";
    } else if (you.playing) text = "Waiting on " + (g.turn_of || "your rival") + " · turn " + g.turn;
    else text = (g.turn_of ? g.turn_of + " to move · " : "") + "turn " + g.turn;
    return { text, sub, mine };
  },

  clockSeconds(g: GL): number {
    return g.turn_seconds || 3600;
  },

  awaiting(g: GL, mine: GL, me: string): boolean {
    return g.turn_of === me;
  },

  mover(g: GL): string | null | undefined {
    return g.last_move ? g.last_move.by || null : undefined;
  },
};
