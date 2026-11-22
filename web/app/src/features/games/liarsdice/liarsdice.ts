import { el } from "../../../lib/index";
import type { LiarsDiceBid, LiarsDicePlayer, LiarsDiceRound, LiarsDiceState } from "@chat/contract";

/* Liar's Dice: what the panels (LiarsDicePanels.tsx) and the history
   share - the words for faces and bids, and which dice count. Cups are
   secret: the server sends only your own (you.dice) and the cups of
   closed rounds. */

const WORD = ["", "one", "two", "three", "four", "five", "six"];

export function ldFaceWord(f: number, plural: boolean): string {
  const w = WORD[f] || String(f);
  return plural ? (f === 6 ? "sixes" : w + "s") : w;
}

// a bid, or the bid builder's draft
export function ldBidText(b: Pick<LiarsDiceBid, "qty" | "face">): string {
  return b.qty + " " + ldFaceWord(b.face, b.qty !== 1);
}

// does a die count toward a bid on this face?
export function ldCounts(d: number, face: number, wild: boolean): boolean {
  return d === face || (wild && d === 1 && face !== 1);
}

export function ldLastRound(g: LiarsDiceState): LiarsDiceRound | null {
  const rs: LiarsDiceRound[] = (g && g.rounds) || [];
  return rs.length ? rs[rs.length - 1]! : g && g.last_round ? g.last_round : null;
}

/* History: a row per closed round - the bids, the call, who lost a die. */
export function ldHistoryRows(g: LiarsDiceState, row: (idx: string) => HTMLElement, who: (p: Pick<LiarsDicePlayer, "name" | "hex">) => HTMLElement, list: HTMLElement): number {
  let n = 0;
  const players: LiarsDicePlayer[] = g.players || [];
  // a seat, or a grey stand-in for one who left the roster
  const byName = (nm: string): Pick<LiarsDicePlayer, "name" | "hex"> => players.find((p) => p.name === nm) || { name: nm, hex: "#94a3b8" };
  (g.rounds || []).forEach((r: LiarsDiceRound) => {
    n++;
    const rw = row("Round " + r.n);
    const bids: LiarsDiceBid[] = r.bids || [];
    if (bids.length) {
      const seg = el("span", "hist-seg");
      seg.appendChild(el("span", "hist-act", bids.map((b) => b.by + " " + b.qty + "×" + b.face).join(" → ")));
      rw.appendChild(seg);
    }
    if (r.reason === "call" && r.call) {
      const seg = el("span", "hist-seg");
      seg.appendChild(who(byName(r.call.by)));
      seg.appendChild(el("span", "hist-act", "liar! · " + r.count + " showed"));
      rw.appendChild(seg);
    } else rw.appendChild(el("span", "hist-act", r.reason === "forfeit" ? "timed out 3 in a row" : "turn ran out"));
    const p = byName(r.loser);
    const pill = el("span", "hist-pill " + (r.out ? "tie" : "win"), r.loser + (r.out ? " out" : " −1"));
    pill.style.borderColor = p.hex;
    pill.style.color = p.hex;
    rw.appendChild(pill);
    list.appendChild(rw);
  });
  return n;
}
