import { el } from "../../../lib/index";
import type { TwoTruthsPlayer, TwoTruthsRound, TwoTruthsState } from "@chat/contract";
import type { HistRow, HistWho } from "../shared/history";

/* Two Truths and a Lie (2026-11-19): what the panels
   (TwoTruthsPanels.tsx) and the history share. The lie stays secret
   until the reveal: only the storyteller's own view carries you.lie. */

/* The storyteller's draft: three statements and which one is the lie (1-3; 0 before a pick). */
export type TtDraft = { s: [string, string, string]; lie: number };
export const TT_MAX = 200;

export function ttLastRound(g: TwoTruthsState): TwoTruthsRound | null {
  const rs: TwoTruthsRound[] = (g && g.rounds) || [];
  return rs.length ? rs[rs.length - 1]! : g && g.last_round ? g.last_round : null;
}

/* History: a row per round - the storyteller, the lie, who spotted it. */
export function ttHistoryRows(g: TwoTruthsState, row: HistRow, who: HistWho, list: HTMLElement): number {
  let n = 0;
  const players: TwoTruthsPlayer[] = g.players || [];
  const byName = (nm: string): Pick<TwoTruthsPlayer, "name" | "hex"> => players.find((p) => p.name === nm) || { name: nm, hex: "#94a3b8" };
  (g.rounds || []).forEach((r: TwoTruthsRound) => {
    n++;
    const rw = row("Round " + r.n);
    const seg = el("span", "hist-seg");
    seg.appendChild(who(byName(r.teller)));
    seg.appendChild(el("span", "hist-act", r.forfeit ? "forfeit" : "lie: “" + ((r.statements || [])[r.lie! - 1] || "") + "”"));
    rw.appendChild(seg);
    if (!r.forfeit) {
      const pill = el("span", "hist-pill " + (r.right && r.right.length ? "win" : "tie"), r.right && r.right.length ? r.right.join(", ") + " spotted it" : "nobody spotted it");
      rw.appendChild(pill);
    }
    list.appendChild(rw);
  });
  return n;
}
