import type { GameStatus, TurnLine } from "../registry";
import { finalScore, type GL, recordLine, tickLen, winnerFirst } from "../shared/render";

// The status hooks for Battleship (GameStatus in registry.ts):
// what the app says about a match's state in this game's words. Each is
// optional; a game without one gets the default where the hook is called.

export const battleshipStatus: GameStatus = {
  finalScore(g: GL): string {
    return winnerFirst(g).map((p: GL) => p.sunk || 0).join("–");
  },

  recordLine(g: GL): string {
    const hits = winnerFirst(g).map((p: GL) => p.hits || 0).join("–");
    return "Final · " + finalScore(g) + " ships · " + hits + " hits · " + (g.turn || 0) + " turns";
  },

  metaText(g: GL): string {
    const line = (g.players || []).map((p: GL) => p.name + " " + (p.afloat != null ? p.afloat : 5) + " afloat").join(" · ");
    if (g.status === "finished" || g.status === "cancelled") return recordLine(g);
    if (g.status === "lobby") {
      const waiting = (g.players || []).filter((p: GL) => !p.accepted).map((p: GL) => p.name);
      return "Lobby · waiting on " + (waiting.join(", ") || "no one") + " · " + tickLen(g.turn_seconds || 3600) + " per turn" + (g.variant && g.variant !== "classic" ? " · " + g.variant : "");
    }
    if (g.phase === "setup") return "Placing fleets · " + tickLen(g.turn_seconds || 3600) + " per turn";
    return "Turn " + g.turn + " · " + (g.turn_of ? g.turn_of + " to fire" : "") + " · " + line;
  },

  stateLine(g: GL): string {
    const ps = g.players || [];
    const head = g.phase === "setup" ? "Placing fleets" : "Turn " + g.turn + (g.turn_of ? " · " + g.turn_of + " to fire" : "");
    return head + " · " + ps.map((p: GL) => p.name + " " + (p.afloat != null ? p.afloat : 5) + " afloat").join(" · ");
  },

  waitingOn(g: GL): string[] {
    const ps: GL[] = g.players || [];
    return g.phase === "setup" ? ps.filter((p) => !p.placed).map((p) => p.name) : g.turn_of ? [g.turn_of] : [];
  },

  youLabel(g: GL): string {
    return g.phase === "setup" ? "Place your fleet" : "Your shot";
  },

  lengthLine(g: GL): string {
    return (g.turn || 0) + " turns";
  },

  signature(g: GL): string | null {
    const lm = g.last_move;
    return ["bs", g.status, g.phase || "", g.turn || 0, lm ? lm.by + lm.cell + (lm.sunk || "") : ""].join("|");
  },

  turnLine(g: GL, me: string): TurnLine {
    const you = g.you || {};
    const players: GL[] = g.players || [];
    const opp = players.filter((p: GL) => p.name !== me)[0];
    let text = "";
    let sub = "";
    let mine = false;
    if (g.phase === "setup") {
      if (you.playing && !you.fleet) {
        mine = true;
        text = "Place your fleet";
      } else if (you.playing) text = "Fleet placed · waiting on " + (opp ? opp.name : "your rival");
      else text = players.map((p: GL) => p.name + (p.placed ? " placed ✓" : " placing…")).join(" · ");
    } else if (you.playing && you.your_turn) {
      mine = true;
      text =
        g.variant === "salvo" && g.salvo_left != null
          ? "Your salvo · " + g.salvo_left + " shot" + (g.salvo_left === 1 ? "" : "s") + " left"
          : "Your shot · turn " + g.turn;
      // the stakes only once they are real: your own missed turns
      const missed = (g.misses || {})[me] || 0;
      if (missed >= 2) sub = "You've missed " + missed + " turns in a row - one more forfeits the match.";
      else if (missed === 1) sub = "You missed a turn - three in a row forfeits the match.";
    } else if (you.playing) text = "Waiting on " + (opp ? opp.name + "'s shot" : "the next shot") + " · turn " + g.turn;
    else text = (g.turn_of ? g.turn_of + " to fire · " : "") + "turn " + g.turn;
    return { text, sub, mine };
  },

  clockSeconds(g: GL): number {
    return g.turn_seconds || 3600;
  },

  awaiting(g: GL, mine: GL, me: string): boolean {
    return g.phase === "setup" ? !mine.placed : g.turn_of === me;
  },

  mover(g: GL): string | null | undefined {
    return g.last_move ? g.last_move.by || null : undefined;
  },
};
