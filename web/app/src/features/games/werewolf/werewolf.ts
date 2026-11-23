import { el } from "../../../lib/index";
import type { WerewolfEvent, WerewolfPlayer, WerewolfState, WerewolfTalk, WerewolfYou } from "@chat/contract";
import type { HistRow, HistWho } from "../shared/history";

/* Werewolf: what the panels (WerewolfPanels.tsx) and the history share
   - the roles, the verbs, the timeline's words. The day's talk lives in
   the game, not the room chat; wolves also have their den. Roles stay
   secret: only your own view carries your role, your pack, your checks. */

// The server sends only the newest lines of town talk and of the den,
// so once a channel is full its length stops changing: a key on the
// length froze the square at that point for every viewer who did not
// move. The newest line (when, who, its number) changes with each one.
export function talkSig(lines: WerewolfTalk[] | null | undefined): string {
  const list = lines || [];
  const last = list[list.length - 1];
  return list.length + (last ? ":" + last.at + ":" + last.by + ":" + last.n : "");
}

type RoleInfo = { name: string; icon: string; blurb: string };
const VILLAGER: RoleInfo = { name: "Villager", icon: "🏡", blurb: "You sleep at night. By day, find the wolves and vote them out." };
export const WW_ROLE: Record<string, RoleInfo> = {
  werewolf: { name: "Werewolf", icon: "🐺", blurb: "Each night your pack picks someone to kill. By day, blend in." },
  seer: { name: "Seer", icon: "🔮", blurb: "Each night you learn whether one player is a werewolf." },
  guardian: { name: "Guardian", icon: "🛡️", blurb: "Each night you protect one player - never the same one twice running." },
  villager: VILLAGER,
};
export function wwRole(r?: string | null): RoleInfo {
  return (r && WW_ROLE[r]) || VILLAGER;
}
export const WW_TALK_MAX = 400;

export function wwVerb(role: string | undefined): string | null {
  return role === "werewolf" ? "kill" : role === "seer" ? "check" : role === "guardian" ? "guard" : null;
}

/* The verb of your move right now - tonight's by role, or today's
   vote - or null when you have none (the panel's and the view's test). */
export function wwActionVerb(g: WerewolfState): string | null {
  const you: Partial<WerewolfYou> = g.you || {};
  if (g.status !== "running" || !you.playing || you.alive === false) return null;
  return g.phase === "night" ? wwVerb(you.role) : "vote";
}

export function wwEventText(e: WerewolfEvent): string {
  if (e.kind === "death") return "Dawn " + e.night + ": " + e.who + " was killed in the night - " + wwRole(e.role).name.toLowerCase() + ".";
  if (e.kind === "saved") return "Dawn " + e.night + ": someone was attacked and survived.";
  if (e.kind === "quiet") return "Dawn " + e.night + ": the night passed quietly.";
  if (e.kind === "eliminated") return "Day " + e.day + ": the village voted out " + e.who + " (" + e.count + ") - " + wwRole(e.role).name.toLowerCase() + ".";
  if (e.kind === "tie") return "Day " + e.day + ": a tied vote - nobody was voted out.";
  return "Day " + e.day + ": nobody voted.";
}

export function wwHistoryRows(g: WerewolfState, row: HistRow, who: HistWho, list: HTMLElement): number {
  let n = 0;
  const players: WerewolfPlayer[] = g.players || [];
  const byName = (nm: string): Pick<WerewolfPlayer, "name" | "hex"> => players.find((p) => p.name === nm) || { name: nm, hex: "#94a3b8" };
  (g.events || []).forEach((e: WerewolfEvent) => {
    n++;
    const rw = row(e.night ? "Night " + e.night : "Day " + e.day);
    if (e.who) {
      const seg = el("span", "hist-seg");
      seg.appendChild(who(byName(e.who)));
      seg.appendChild(el("span", "hist-act", (e.kind === "death" ? "killed - " : "voted out - ") + wwRole(e.role).name.toLowerCase()));
      rw.appendChild(seg);
    } else rw.appendChild(el("span", "hist-act", e.kind === "saved" ? "someone survived an attack" : e.kind === "quiet" ? "a quiet night" : e.kind === "tie" ? "a tied vote" : "no votes"));
    list.appendChild(rw);
  });
  return n;
}

export function wwSideText(g: WerewolfState): string {
  return g.side === "wolves" ? "The wolves win" : g.side === "village" ? "The village wins" : "";
}
