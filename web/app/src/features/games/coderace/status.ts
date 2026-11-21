import type { GameStatus, TurnLine } from "../registry";
import { crWhat, type GL, recordLine, tickLen, winnerOf } from "../shared/render";

// The status hooks for Code Race (GameStatus in registry.ts):
// what the app says about a match's state in this game's words. Each is
// optional; a game without one gets the default where the hook is called.

export const coderaceStatus: GameStatus = {
  finalScore(g: GL): string {
    const w = winnerOf(g);
    return w && w.solved ? "round " + w.solved : "";
  },

  recordLine(g: GL): string {
    const n = (g.rounds && g.rounds.length) || 0;
    const w = winnerOf(g);
    return (w ? "Cracked in round " + w.solved : "Not cracked") + " · " + n + (n === 1 ? " round" : " rounds") + " · " + crWhat(g);
  },

  metaText(g: GL): string {
    if (g.status === "finished" || g.status === "cancelled") return recordLine(g);
    if (g.status === "lobby") {
      const waiting = (g.players || []).filter((p: GL) => !p.accepted).map((p: GL) => p.name);
      return "Lobby · waiting on " + (waiting.join(", ") || "no one") + " · " + crWhat(g);
    }
    const cracked = (g.players || []).filter((p: GL) => p.solved).length;
    return "Round " + g.round + " of " + (g.max_rounds || "?") + " · " + crWhat(g) + (cracked ? " · " + cracked + " cracked it" : "") + " · " + tickLen(g.round_seconds || 3600) + " per round";
  },

  stateLine(g: GL): string {
    const ps = g.players || [];
    const cracked = ps.filter((p: GL) => p.solved).map((p: GL) => p.name);
    return "Round " + (g.round || 1) + " of " + (g.max_rounds || "?") + " · " + (cracked.length ? cracked.join(", ") + " cracked it" : "nobody has cracked it");
  },

  waitingOn(g: GL): string[] {
    const ps: GL[] = g.players || [];
    return ps.filter((p) => !p.committed && !p.solved && !p.out).map((p) => p.name);
  },

  youLabel(g: GL): string {
    return "Your guess";
  },

  lengthLine(g: GL): string {
    return ((g.rounds && g.rounds.length) || Math.max(0, (g.round || 1) - 1)) + " rounds";
  },

  signature(g: GL): string | null {
    const solved = (g.players || []).filter((p: GL) => p.solved).length;
    return ["cr", g.status, g.round || 0, (g.rounds || []).length, solved].join("|");
  },

  turnLine(g: GL, me: string): TurnLine {
    const you = g.you || {};
    const players: GL[] = g.players || [];
    let text = "";
    let sub = "";
    let mine = false;
    const waiting = players.filter((p: GL) => !p.committed && !p.solved && !p.out && p.name !== me).map((p: GL) => p.name);
    if (you.playing && you.solved) text = "You cracked it in round " + you.solved + (waiting.length ? " · waiting on " + waiting.join(", ") : "");
    else if (you.playing && you.out) text = "You're out of this race" + (waiting.length ? " · waiting on " + waiting.join(", ") : "");
    else if (you.playing && you.queued) text = "Your guess is in · " + (waiting.length ? "waiting on " + waiting.join(", ") : "resolving…");
    else if (you.playing) {
      mine = true;
      text = "Your guess · round " + g.round + " of " + (g.max_rounds || "?");
      sub = waiting.length ? "The round resolves when every racer still racing has guessed." : "Everyone else is in · your guess resolves the round.";
      const missed = (g.rounds || []).slice(-2).filter((r: GL) => (r.missed || []).indexOf(me) >= 0).length;
      if (missed >= 2) sub = "You've missed two rounds in a row - miss this one and you're out.";
    } else text = "Round " + g.round + " · " + (waiting.length ? "waiting on " + waiting.join(", ") : "resolving…");
    return { text, sub, mine };
  },

  clockSeconds(g: GL): number {
    return g.round_seconds || 3600;
  },

  awaiting(g: GL, mine: GL, me: string): boolean {
    return !mine.committed && !mine.solved && !mine.out;
  },

  mover(g: GL): string | null | undefined {
    return g.rounds && g.rounds.length ? (g.rounds[g.rounds.length - 1].solved || [])[0] || null : undefined;
  },
};
