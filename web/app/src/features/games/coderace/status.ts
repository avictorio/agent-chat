import type { GameStatus, TurnLine } from "../registry";
import { crWhat, recordLine, tickLen, winnerOf } from "../shared/render";
import type { CodeRacePlayer, CodeRaceRound, CodeRaceState, CodeRaceYou } from "@chat/contract";

// The status hooks for Code Race (GameStatus in registry.ts):
// what the app says about a match's state in this game's words. Each is
// optional; a game without one gets the default where the hook is called.

export const coderaceStatus: GameStatus<CodeRaceState> = {
  finalScore(g: CodeRaceState): string {
    const w = winnerOf(g);
    return w && w.solved ? "round " + w.solved : "";
  },

  recordLine(g: CodeRaceState): string {
    const n = (g.rounds && g.rounds.length) || 0;
    const w = winnerOf(g);
    return (w ? "Cracked in round " + w.solved : "Not cracked") + " · " + n + (n === 1 ? " round" : " rounds") + " · " + crWhat(g);
  },

  metaText(g: CodeRaceState): string {
    if (g.status === "finished" || g.status === "cancelled") return recordLine(g);
    if (g.status === "lobby") {
      const waiting = (g.players || []).filter((p: CodeRacePlayer) => !p.accepted).map((p: CodeRacePlayer) => p.name);
      return "Lobby · waiting on " + (waiting.join(", ") || "no one") + " · " + crWhat(g);
    }
    const cracked = (g.players || []).filter((p: CodeRacePlayer) => p.solved).length;
    return "Round " + g.round + " of " + (g.max_rounds || "?") + " · " + crWhat(g) + (cracked ? " · " + cracked + " cracked it" : "") + " · " + tickLen(g.round_seconds || 3600) + " per round";
  },

  stateLine(g: CodeRaceState): string {
    const ps = g.players || [];
    const cracked = ps.filter((p: CodeRacePlayer) => p.solved).map((p: CodeRacePlayer) => p.name);
    return "Round " + (g.round || 1) + " of " + (g.max_rounds || "?") + " · " + (cracked.length ? cracked.join(", ") + " cracked it" : "nobody has cracked it");
  },

  waitingOn(g: CodeRaceState): string[] {
    const ps: CodeRacePlayer[] = g.players || [];
    return ps.filter((p) => !p.committed && !p.solved && !p.out).map((p) => p.name);
  },

  youLabel(): string {
    return "Your guess";
  },

  lengthLine(g: CodeRaceState): string {
    return ((g.rounds && g.rounds.length) || Math.max(0, (g.round || 1) - 1)) + " rounds";
  },

  signature(g: CodeRaceState): string | null {
    const solved = (g.players || []).filter((p: CodeRacePlayer) => p.solved).length;
    return ["cr", g.status, g.round || 0, (g.rounds || []).length, solved].join("|");
  },

  turnLine(g: CodeRaceState, me: string): TurnLine {
    const you: Partial<CodeRaceYou> = g.you || {};
    const players: CodeRacePlayer[] = g.players || [];
    let text = "";
    let sub = "";
    let mine = false;
    const waiting = players.filter((p: CodeRacePlayer) => !p.committed && !p.solved && !p.out && p.name !== me).map((p: CodeRacePlayer) => p.name);
    if (you.playing && you.solved) text = "You cracked it in round " + you.solved + (waiting.length ? " · waiting on " + waiting.join(", ") : "");
    else if (you.playing && you.out) text = "You're out of this race" + (waiting.length ? " · waiting on " + waiting.join(", ") : "");
    else if (you.playing && you.queued) text = "Your guess is in · " + (waiting.length ? "waiting on " + waiting.join(", ") : "resolving…");
    else if (you.playing) {
      mine = true;
      text = "Your guess · round " + g.round + " of " + (g.max_rounds || "?");
      sub = waiting.length ? "The round resolves when every racer still racing has guessed." : "Everyone else is in · your guess resolves the round.";
      const missed = (g.rounds || []).slice(-2).filter((r: CodeRaceRound) => (r.missed || []).indexOf(me) >= 0).length;
      if (missed >= 2) sub = "You've missed two rounds in a row - miss this one and you're out.";
    } else text = "Round " + g.round + " · " + (waiting.length ? "waiting on " + waiting.join(", ") : "resolving…");
    return { text, sub, mine };
  },

  clockSeconds(g: CodeRaceState): number {
    return g.round_seconds || 3600;
  },

  awaiting(g: CodeRaceState, mine: CodeRacePlayer): boolean {
    return !mine.committed && !mine.solved && !mine.out;
  },

  mover(g: CodeRaceState): string | null | undefined {
    return g.rounds && g.rounds.length ? (g.rounds[g.rounds.length - 1]!.solved || [])[0] || null : undefined;
  },
};
