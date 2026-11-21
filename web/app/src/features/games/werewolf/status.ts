import type { GameStatus, TurnLine } from "../registry";
import type { WerewolfPlayer, WerewolfState, WerewolfYou } from "@chat/contract";
import { recordLine, sideWin, tickLen } from "../shared/render";
import { wwVerb } from "./werewolf";

// The status hooks for Werewolf (GameStatus in registry.ts):
// what the app says about a match's state in this game's words. Each is
// optional; a game without one gets the default where the hook is called.

export const werewolfStatus: GameStatus = {
  finalScore(g: WerewolfState): string {
    return "";
  },

  recordLine(g: WerewolfState): string {
    const t = sideWin(g);
    return (t ? t.text : "Over") + " · " + ((g.events || []).length || 0) + " dawns and votes";
  },

  metaText(g: WerewolfState): string {
    if (g.status === "finished" || g.status === "cancelled") return recordLine(g);
    const rip = g.roles_in_play || {};
    const cast = (rip.werewolf || 0) + (rip.werewolf === 1 ? " werewolf" : " werewolves") + ", a seer" + (rip.guardian ? ", a guardian" : "") + ", " + (rip.villager || 0) + " villagers";
    if (g.status === "lobby") {
      const waiting = (g.players || []).filter((p: WerewolfPlayer) => !p.accepted).map((p: WerewolfPlayer) => p.name);
      return "Lobby · waiting on " + (waiting.join(", ") || "no one") + " · " + cast;
    }
    return (g.phase === "night" ? "Night " + g.night : "Day " + g.day) + " · " + (g.alive_count || 0) + " alive · " + cast + " · " + tickLen(g.phase_seconds || 86400) + " a phase";
  },

  stateLine(g: WerewolfState): string {
    const ps = g.players || [];
    return (g.phase === "night" ? "Night " + (g.night || 1) + " · the village sleeps" : "Day " + (g.day || 1) + " · voting") + " · " + ps.filter((p: WerewolfPlayer) => p.alive).length + " alive";
  },

  waitingOn(g: WerewolfState): string[] {
    const ps: WerewolfPlayer[] = g.players || [];
    return g.phase === "day" ? ps.filter((p) => p.alive && !p.voted).map((p) => p.name) : [];
  },

  youLabel(g: WerewolfState): string {
    return g.phase === "night" ? "Your night move" : "Your vote";
  },

  lengthLine(g: WerewolfState): string {
    return (g.day || g.night || 0) + " days";
  },

  signature(g: WerewolfState): string | null {
    return ["ww", g.status, g.phase || "", g.night || 0, g.day || 0, (g.players || []).filter((p: WerewolfPlayer) => p.alive).length].join("|");
  },

  turnLine(g: WerewolfState, me: string): TurnLine {
    const you: Partial<WerewolfYou> = g.you || {};
    const players: WerewolfPlayer[] = g.players || [];
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
      const waiting = players.filter((p: WerewolfPlayer) => p.alive && !p.voted && p.name !== me).map((p: WerewolfPlayer) => p.name);
      if (you.playing && you.vote == null) {
        mine = true;
        text = "Day " + g.day + " · talk it out, then vote";
        sub = "Votes are public and can change until the day closes.";
      } else text = (you.playing ? "Your vote is in · " : "Day " + g.day + " · ") + (waiting.length ? "waiting on " + waiting.join(", ") : "closing…");
    }
    return { text, sub, mine };
  },

  clockSeconds(g: WerewolfState): number {
    return g.phase_seconds || 86400;
  },

  awaiting(g: WerewolfState, mine: WerewolfPlayer, me: string): boolean {
    const y: Partial<WerewolfYou> = g.you || {};
    return mine.alive && (g.phase === "day" ? !mine.voted : !!wwVerb(y.role) && !y.act);
  },
};
