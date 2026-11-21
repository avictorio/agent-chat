import type { GameStatus, TurnLine } from "../registry";
import { recordLine, tickLen, winnerOf } from "../shared/render";
import type { LiarsDicePlayer, LiarsDiceState, LiarsDiceYou } from "@chat/contract";

// The status hooks for Liar's Dice (GameStatus in registry.ts):
// what the app says about a match's state in this game's words. Each is
// optional; a game without one gets the default where the hook is called.

export const liarsdiceStatus: GameStatus<LiarsDiceState> = {
  finalScore(g: LiarsDiceState): string {
    const w = winnerOf(g);
    return w ? (w.dice || 0) + (w.dice === 1 ? " die left" : " dice left") : "";
  },

  recordLine(g: LiarsDiceState): string {
    const n = (g.rounds && g.rounds.length) || g.round || 0;
    return "Last with dice" + (g.forfeit ? " · " + g.forfeit + " timed out" : "") + " · " + n + (n === 1 ? " round" : " rounds");
  },

  metaText(g: LiarsDiceState): string {
    if (g.status === "finished" || g.status === "cancelled") return recordLine(g);
    if (g.status === "lobby") {
      const waiting = (g.players || []).filter((p: LiarsDicePlayer) => !p.accepted).map((p: LiarsDicePlayer) => p.name);
      return "Lobby · waiting on " + (waiting.join(", ") || "no one") + " · " + (g.dice_each || 5) + " dice each · ones " + (g.ones_wild ? "wild" : "not wild");
    }
    return "Round " + g.round + " · " + (g.dice_total || 0) + " dice on the table · " + tickLen(g.turn_seconds || 3600) + " per turn";
  },

  stateLine(g: LiarsDiceState): string {
    const ps = g.players || [];
    return "Round " + (g.round || 1) + (g.turn_of ? " · " + g.turn_of + " to bid" : "") + " · " + ps.filter((p: LiarsDicePlayer) => !p.out).map((p: LiarsDicePlayer) => p.name + " " + (p.dice || 0)).join(" · ");
  },

  waitingOn(g: LiarsDiceState): string[] {
    return g.turn_of ? [g.turn_of] : [];
  },

  youLabel(g: LiarsDiceState): string {
    return "Your bid";
  },

  lengthLine(g: LiarsDiceState): string {
    return ((g.rounds && g.rounds.length) || g.round || 0) + " rounds";
  },

  signature(g: LiarsDiceState): string | null {
    return ["ld", g.status, g.turn || 0, g.round || 0, g.bid ? g.bid.qty + "x" + g.bid.face : ""].join("|");
  },

  turnLine(g: LiarsDiceState, me: string): TurnLine {
    const you: Partial<LiarsDiceYou> = g.you || {};
    let text = "";
    let sub = "";
    let mine = false;
    if (you.playing && you.out) text = "You're out of this match" + (g.turn_of ? " · " + g.turn_of + " to bid" : "");
    else if (you.playing && you.your_turn) {
      mine = true;
      text = (g.bid ? "Raise or call liar" : "Open the bidding") + " · round " + g.round;
      const to = you.timeouts || 0;
      sub = to >= 2 ? "You've timed out twice in a row - one more and you're out." : "If the clock runs out, you lose a die.";
    } else if (you.playing) text = "Waiting on " + (g.turn_of || "the table") + " · round " + g.round;
    else text = (g.turn_of ? g.turn_of + " to bid · " : "") + "round " + g.round;
    return { text, sub, mine };
  },

  clockSeconds(g: LiarsDiceState): number {
    return g.turn_seconds || 3600;
  },

  awaiting(g: LiarsDiceState, mine: LiarsDicePlayer, me: string): boolean {
    return g.turn_of === me;
  },

  mover(g: LiarsDiceState): string | null | undefined {
    return g.status !== "finished" ? (g.bid ? g.bid.by : g.last_round ? g.last_round.loser : null) || null : undefined;
  },
};
