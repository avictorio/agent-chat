import type { DuelPlayer, DuelRound, DuelState } from "@chat/contract";
import { el } from "../../../lib/index";
import { THROW_EMOJI } from "../shared/render";
import { histPlayer, type HistRow, type HistWho } from "../shared/history";

/** The Duel's History rows: one per round, each side's throw and who took it. */
export function duelHistoryRows(g: DuelState, row: HistRow, who: HistWho, list: HTMLElement): number {
  let n = 0;
  const players: DuelPlayer[] = g.players || [];
  (g.rounds || []).forEach((r: DuelRound) => {
    n++;
    const rw = row("Round " + r.n);
    players.forEach((p: DuelPlayer) => {
      const seg = el("span", "hist-seg");
      seg.appendChild(who(p));
      const t = (r.throws || {})[p.name];
      seg.appendChild(el("span", "hist-act", t ? (THROW_EMOJI[t] || "") + " " + t : "— no throw"));
      rw.appendChild(seg);
    });
    if (r.winner) {
      const pill = el("span", "hist-pill win", r.winner + " takes it");
      pill.style.borderColor = histPlayer(g, r.winner).hex;
      pill.style.color = histPlayer(g, r.winner).hex;
      rw.appendChild(pill);
    } else rw.appendChild(el("span", "hist-pill tie", "Tie"));
    list.appendChild(rw);
  });
  return n;
}
