import type { BattleshipPlayer, BattleshipState, BattleshipYou } from "@chat/contract";
import type { GameStatus, TurnLine } from "../registry";
import { finalScore, recordLine, tickLen, winnerFirst } from "../shared/render";

// The status hooks for Battleship (GameStatus in registry.ts):
// what the app says about a match's state in this game's words. Each is
// optional; a game without one gets the default where the hook is called.

export const battleshipStatus: GameStatus<BattleshipState> = {
  finalScore(g: BattleshipState): string {
    return winnerFirst(g).map((p: BattleshipPlayer) => p.sunk || 0).join("–");
  },

  recordLine(g: BattleshipState): string {
    const hits = winnerFirst(g).map((p: BattleshipPlayer) => p.hits || 0).join("–");
    return "Final · " + finalScore(g) + " ships · " + hits + " hits · " + (g.turn || 0) + " turns";
  },

  metaText(g: BattleshipState): string {
    const line = (g.players || []).map((p: BattleshipPlayer) => p.name + " " + (p.afloat != null ? p.afloat : 5) + " afloat").join(" · ");
    if (g.status === "finished" || g.status === "cancelled") return recordLine(g);
    if (g.status === "lobby") {
      const waiting = (g.players || []).filter((p: BattleshipPlayer) => !p.accepted).map((p: BattleshipPlayer) => p.name);
      return "Lobby · waiting on " + (waiting.join(", ") || "no one") + " · " + tickLen(g.turn_seconds || 3600) + " per turn" + (g.variant && g.variant !== "classic" ? " · " + g.variant : "");
    }
    if (g.phase === "setup") return "Placing fleets · " + tickLen(g.turn_seconds || 3600) + " per turn";
    return "Turn " + g.turn + " · " + (g.turn_of ? g.turn_of + " to fire" : "") + " · " + line;
  },

  stateLine(g: BattleshipState): string {
    const ps = g.players || [];
    const head = g.phase === "setup" ? "Placing fleets" : "Turn " + g.turn + (g.turn_of ? " · " + g.turn_of + " to fire" : "");
    return head + " · " + ps.map((p: BattleshipPlayer) => p.name + " " + (p.afloat != null ? p.afloat : 5) + " afloat").join(" · ");
  },

  waitingOn(g: BattleshipState): string[] {
    const ps: BattleshipPlayer[] = g.players || [];
    return g.phase === "setup" ? ps.filter((p) => !p.placed).map((p) => p.name) : g.turn_of ? [g.turn_of] : [];
  },

  youLabel(g: BattleshipState): string {
    return g.phase === "setup" ? "Place your fleet" : "Your shot";
  },

  lengthLine(g: BattleshipState): string {
    return (g.turn || 0) + " turns";
  },

  signature(g: BattleshipState): string | null {
    const lm = g.last_move;
    return ["bs", g.status, g.phase || "", g.turn || 0, lm ? lm.by + lm.cell + (lm.sunk || "") : ""].join("|");
  },

  turnLine(g: BattleshipState, me: string): TurnLine {
    const you: Partial<BattleshipYou> = g.you || {};
    const players: BattleshipPlayer[] = g.players || [];
    // Name who the game is really waiting on: the first other seat was
    // named before, so in a free-for-all the banner blamed Ada while it
    // was Bob's shot, or Bob still placing.
    const rivals = players.filter((p: BattleshipPlayer) => p.name !== me && !p.eliminated);
    let text = "";
    let sub = "";
    let mine = false;
    if (g.phase === "setup") {
      if (you.playing && !you.fleet) {
        mine = true;
        text = "Place your fleet";
      } else if (you.playing) {
        const placing = rivals.filter((p: BattleshipPlayer) => !p.placed).map((p: BattleshipPlayer) => p.name);
        text = "Fleet placed · waiting on " + (placing.join(", ") || "the first shot");
      }
      else text = players.map((p: BattleshipPlayer) => p.name + (p.placed ? " placed ✓" : " placing…")).join(" · ");
    } else if (you.playing && you.your_turn) {
      mine = true;
      text =
        g.variant === "salvo" && g.salvo_left != null
          ? "Your salvo · " + g.salvo_left + " shot" + (g.salvo_left === 1 ? "" : "s") + " left"
          : "Your shot · turn " + g.turn;
      // the stakes only once they are real: your own missed turns. What a
      // third miss does follows the engine: with one rival left it is a
      // forfeit, with more you are eliminated and the sea fights on, and
      // if every rival has missed two as well the match ends with no winner.
      const misses = g.misses || {};
      const missed = misses[me] || 0;
      const ffa = rivals.length > 1;
      const allSilent = rivals.length > 0 && rivals.every((p: BattleshipPlayer) => (misses[p.name] || 0) >= 2);
      if (missed >= 2) sub = "You've missed " + missed + " turns in a row - one more " + (allSilent ? "ends the match with no winner." : ffa ? "and you're eliminated." : "forfeits the match.");
      else if (missed === 1) sub = "You missed a turn - three in a row " + (ffa ? "eliminates you." : "forfeits the match.");
    } else if (you.playing) text = "Waiting on " + (g.turn_of ? g.turn_of + "'s shot" : "the next shot") + " · turn " + g.turn;
    else text = (g.turn_of ? g.turn_of + " to fire · " : "") + "turn " + g.turn;
    return { text, sub, mine };
  },

  clockSeconds(g: BattleshipState): number {
    return g.turn_seconds || 3600;
  },

  awaiting(g: BattleshipState, mine: BattleshipPlayer, me: string): boolean {
    return g.phase === "setup" ? !mine.placed : g.turn_of === me;
  },

  mover(g: BattleshipState): string | null | undefined {
    return g.last_move ? g.last_move.by || null : undefined;
  },
};
