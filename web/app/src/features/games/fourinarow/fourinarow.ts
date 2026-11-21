import type { FourInARowMove, FourInARowPlayer, FourInARowState } from "@chat/contract";
import { el } from "../../../lib/index";

/* Four in a Row (2026-11-19): the board's size and the move history.
   The seats, the drop row a player taps on their turn and the card's
   board are React (FourInARowPanels.tsx). */

export const C4_COLS = 7;
export const C4_ROWS = 6;

/* History: a row per move. */
export function c4HistoryRows(g: FourInARowState, row: (idx: string) => HTMLElement, who: (p: { name: string; hex: string }) => HTMLElement, list: HTMLElement): number {
  let n = 0;
  const players: FourInARowPlayer[] = g.players || [];
  (g.moves || []).forEach((m: FourInARowMove) => {
    n++;
    const rw = row("Move " + m.n);
    const p = players.find((x) => x.name === m.by) || { name: m.by, hex: "#94a3b8" };
    const seg = el("span", "hist-seg");
    seg.appendChild(who(p));
    seg.appendChild(el("span", "hist-act", "column " + m.col));
    rw.appendChild(seg);
    const isLast = n === (g.moves || []).length;
    // a forfeit is won on the clock after the last move, not by it
    if (isLast && g.status === "finished" && g.winner === m.by && !g.forfeit) {
      const pill = el("span", "hist-pill win", "four in a row");
      pill.style.borderColor = p.hex;
      pill.style.color = p.hex;
      rw.appendChild(pill);
    }
    list.appendChild(rw);
  });
  return n;
}
