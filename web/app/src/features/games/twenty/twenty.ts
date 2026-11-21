import { el } from "../../../lib/index";
import type { TwentyPlayer, TwentyRound, TwentyState } from "@chat/contract";

/* Twenty Questions (2026-11-20): what the panels (TwentyPanels.tsx) and
   the history share. The secret shows only to the answerer until the
   round ends. */

export function tqLastRound(g: TwentyState): TwentyRound | null {
  const rs: TwentyRound[] = (g && g.rounds) || [];
  return rs.length ? rs[rs.length - 1]! : g && g.last_round ? g.last_round : null;
}

export function tqHistoryRows(g: TwentyState, row: (idx: string) => HTMLElement, who: (p: Pick<TwentyPlayer, "name" | "hex">) => HTMLElement, list: HTMLElement): number {
  let n = 0;
  const players: TwentyPlayer[] = g.players || [];
  const byName = (nm: string): Pick<TwentyPlayer, "name" | "hex"> => players.find((p) => p.name === nm) || { name: nm, hex: "#94a3b8" };
  ((g.rounds || []) as TwentyRound[]).forEach((r: TwentyRound) => {
    n++;
    const rw = row("Round " + r.n);
    const seg = el("span", "hist-seg");
    seg.appendChild(who(byName(r.answerer)));
    seg.appendChild(el("span", "hist-act", "“" + r.secret + "”"));
    rw.appendChild(seg);
    rw.appendChild(el("span", "hist-pill " + (r.how === "guessed" ? "win" : "tie"), r.how === "guessed" ? r.guessed_by + " in " + r.asked : r.answerer + " held"));
    list.appendChild(rw);
  });
  return n;
}
