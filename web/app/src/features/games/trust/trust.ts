import { el } from "../../../lib/index";
import type { TrustPlayer, TrustRound, TrustState } from "@chat/contract";

/* Trust: what the panels (TrustPanels.tsx) and the history share. Every
   pairing scores on its own: both C 3 each, D against C 5 to 0, both D
   1 each. Pending choices are secret (the server sends only your own);
   resolved rounds are public. */

export type TrDraft = Record<string, "C" | "D">;

export function trLastRound(g: TrustState): TrustRound | null {
  const rs: TrustRound[] = (g && g.rounds) || [];
  return rs.length ? rs[rs.length - 1]! : null;
}

export function trStatus(g: TrustState, p: TrustPlayer): string {
  if (p.out) return "out";
  if (g.status === "running") return p.committed ? "chosen ✓" : "thinking…";
  return "";
}

/* History: a row per round - each player's points and how many rivals
   they trusted. */
export function trHistoryRows(g: TrustState, row: (idx: string) => HTMLElement, who: (p: TrustPlayer) => HTMLElement, list: HTMLElement): number {
  let n = 0;
  const players: TrustPlayer[] = g.players || [];
  (g.rounds || []).forEach((r: TrustRound) => {
    n++;
    const rw = row("Round " + r.n);
    players.forEach((p: TrustPlayer) => {
      const mv = (r.moves || {})[p.name];
      if (!mv) return;
      const seg = el("span", "hist-seg");
      seg.appendChild(who(p));
      const vals = Object.values(mv) as string[];
      const cs = vals.filter((v) => v === "C").length;
      const missed = (r.missed || []).indexOf(p.name) >= 0;
      seg.appendChild(el("span", "hist-act", "+" + ((r.points || {})[p.name] || 0) + " · " + (missed ? "no choice" : "🤝" + cs + "/" + vals.length)));
      rw.appendChild(seg);
    });
    list.appendChild(rw);
  });
  return n;
}
