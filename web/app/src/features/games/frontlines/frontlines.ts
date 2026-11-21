import type { FrontlinesPlayer, FrontlinesRound, FrontlinesState } from "@chat/contract";
import { el } from "../../../lib/index";

/* Frontlines (2026-11-19): what the panels (FrontlinesPanels.tsx) and
   the history share. The server rules: five hills A-E, 100 troops a
   round, each hill to the bigger army, the round to more hills held
   (or, valued hills, more points). A split is secret until the round
   resolves. */

export const FL_HILLS = 5;
export const FL_TROOPS = 100;
export const FL_LETTERS = ["A", "B", "C", "D", "E"];

export function flLastRound(g: FrontlinesState): FrontlinesRound | null {
  const rs: FrontlinesRound[] = (g && g.rounds) || [];
  return rs.length ? rs[rs.length - 1]! : null;
}

export function flHex(g: FrontlinesState, name: string | null | undefined): string {
  const p = ((g && g.players) || []).filter((x: FrontlinesPlayer) => x.name === name)[0];
  return (p && p.hex) || "#94a3b8";
}

/* History: one row per round - both splits, the hills each took, the
   round's winner. */
export function flHistoryRows(g: FrontlinesState, row: (idx: string) => HTMLElement, who: (p: FrontlinesPlayer) => HTMLElement, list: HTMLElement): number {
  let n = 0;
  const players: FrontlinesPlayer[] = g.players || [];
  (g.rounds || []).forEach((r: FrontlinesRound) => {
    n++;
    const rw = row("Round " + r.n);
    players.forEach((p: FrontlinesPlayer) => {
      const seg = el("span", "hist-seg");
      seg.appendChild(who(p));
      const a = (r.alloc || {})[p.name];
      const held = (r.held || {})[p.name];
      seg.appendChild(el("span", "hist-act", a ? a.join("/") + (held != null ? " · " + held + (held === 1 ? " hill" : " hills") : "") : "— no split"));
      rw.appendChild(seg);
    });
    if (r.winner) {
      const pill = el("span", "hist-pill win", r.winner + (r.forfeit ? " by forfeit" : " takes it"));
      pill.style.borderColor = flHex(g, r.winner);
      pill.style.color = flHex(g, r.winner);
      rw.appendChild(pill);
    } else rw.appendChild(el("span", "hist-pill tie", "Level"));
    list.appendChild(rw);
  });
  return n;
}
