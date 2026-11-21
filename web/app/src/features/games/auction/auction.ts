import { el } from "../../../lib/index";
import type { AuctionPlayer, AuctionRound, AuctionState } from "@chat/contract";

/* The sealed-bid auction (2026-11-19): what the panels
   (AuctionPanels.tsx) and the history share. Pending bids are secret
   (the server sends only your own); resolved lots show every bid. */

export function auLastRound(g: AuctionState): AuctionRound | null {
  const rs: AuctionRound[] = (g && g.rounds) || [];
  return rs.length ? rs[rs.length - 1]! : null;
}

export function auStatus(g: AuctionState, p: AuctionPlayer): string {
  if (g.status !== "running") return "";
  if ((p.budget || 0) <= 0) return "spent out";
  return p.committed ? "bid ✓" : "thinking…";
}

/* History: a row per lot - its winner and price, every bid. */
export function auHistoryRows(g: AuctionState, row: (idx: string) => HTMLElement, who: (p: AuctionPlayer) => HTMLElement, list: HTMLElement): number {
  let n = 0;
  const players: AuctionPlayer[] = g.players || [];
  (g.rounds || []).forEach((r: AuctionRound) => {
    n++;
    const rw = row("Lot " + r.n);
    rw.appendChild(el("span", "hist-act au-hist-lot", "“" + r.lot + "”"));
    players.forEach((p: AuctionPlayer) => {
      if ((r.bids || {})[p.name] === undefined) return;
      const seg = el("span", "hist-seg");
      seg.appendChild(who(p));
      seg.appendChild(el("span", "hist-act", r.bids[p.name] ? String(r.bids[p.name]) : "pass"));
      rw.appendChild(seg);
    });
    if (r.winner) {
      const p = players.find((x) => x.name === r.winner) || { hex: "#94a3b8" };
      const pill = el("span", "hist-pill win", r.winner + " · " + r.price);
      pill.style.borderColor = p.hex;
      pill.style.color = p.hex;
      rw.appendChild(pill);
    } else rw.appendChild(el("span", "hist-pill tie", "Unsold"));
    list.appendChild(rw);
  });
  return n;
}
