import type { GameStatus, TurnLine } from "../registry";
import { type GL, recordLine, sideWin, tickLen } from "../shared/render";
import { wwVerb } from "./werewolf";

// The status hooks for Werewolf (GameStatus in registry.ts):
// what the app says about a match's state in this game's words. Each is
// optional; a game without one gets the default where the hook is called.

export const werewolfStatus: GameStatus = {
  finalScore(g: GL): string {
    return "";
  },

  recordLine(g: GL): string {
    const t = sideWin(g);
    return (t ? t.text : "Over") + " · " + ((g.events || []).length || 0) + " dawns and votes";
  },

  metaText(g: GL): string {
    if (g.status === "finished" || g.status === "cancelled") return recordLine(g);
    const rip = g.roles_in_play || {};
    const cast = (rip.werewolf || 0) + (rip.werewolf === 1 ? " werewolf" : " werewolves") + ", a seer" + (rip.guardian ? ", a guardian" : "") + ", " + (rip.villager || 0) + " villagers";
    if (g.status === "lobby") {
      const waiting = (g.players || []).filter((p: GL) => !p.accepted).map((p: GL) => p.name);
      return "Lobby · waiting on " + (waiting.join(", ") || "no one") + " · " + cast;
    }
    return (g.phase === "night" ? "Night " + g.night : "Day " + g.day) + " · " + (g.alive_count || 0) + " alive · " + cast + " · " + tickLen(g.phase_seconds || 86400) + " a phase";
  },

  stateLine(g: GL): string {
    const ps = g.players || [];
    return (g.phase === "night" ? "Night " + (g.night || 1) + " · the village sleeps" : "Day " + (g.day || 1) + " · voting") + " · " + ps.filter((p: GL) => p.alive).length + " alive";
  },

  waitingOn(g: GL): string[] {
    const ps: GL[] = g.players || [];
    return g.phase === "day" ? ps.filter((p) => p.alive && !p.voted).map((p) => p.name) : [];
  },

  youLabel(g: GL): string {
    return g.phase === "night" ? "Your night move" : "Your vote";
  },

  lengthLine(g: GL): string {
    return (g.day || g.night || 0) + " days";
  },

  signature(g: GL): string | null {
    return ["ww", g.status, g.phase || "", g.night || 0, g.day || 0, (g.players || []).filter((p: GL) => p.alive).length].join("|");
  },

  turnLine(g: GL, me: string): TurnLine {
    const you = g.you || {};
    const players: GL[] = g.players || [];
    let text = "";
    let sub = "";
    let mine = false;
    const verb = wwVerb(you.role);
    if (you.playing && you.alive === false) text = "You're out · " + (g.phase === "night" ? "night " + g.night : "day " + g.day) + " · watching";
    else if (g.phase === "night") {
      if (you.playing && verb && !you.act) {
        mine = true;
        text = "Night " + g.night + " · your move: " + verb;
        sub = "The night ends when every role has acted, or at the clock.";
      } else text = "Night " + g.night + " · the village sleeps";
    } else {
      const waiting = players.filter((p: GL) => p.alive && !p.voted && p.name !== me).map((p: GL) => p.name);
      if (you.playing && you.vote == null) {
        mine = true;
        text = "Day " + g.day + " · talk it out, then vote";
        sub = "Votes are public and can change until the day closes.";
      } else text = (you.playing ? "Your vote is in · " : "Day " + g.day + " · ") + (waiting.length ? "waiting on " + waiting.join(", ") : "closing…");
    }
    return { text, sub, mine };
  },

  clockSeconds(g: GL): number {
    return g.phase_seconds || 86400;
  },

  awaiting(g: GL, mine: GL, me: string): boolean {
    const y = g.you || {};
    return mine.alive && (g.phase === "day" ? !mine.voted : !!wwVerb(y.role) && !y.act);
  },
};
