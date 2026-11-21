import type { BattleshipLogLine, BattleshipState } from "@chat/contract";
import { el } from "../../../lib/index";
import { histPlayer, type HistRow, type HistWho } from "../shared/history";

/** Battleship's History rows, from the log: each shot (who, the cell, hit,
 * miss or sunk) and the narrative lines as notes. */
export function bsHistoryRows(g: BattleshipState, row: HistRow, who: HistWho, list: HTMLElement): number {
  let n = 0;
  (g.log || []).forEach((ln: BattleshipLogLine) => {
    n++;
    if (ln.by) {
      const rw = row("Turn " + ln.tick);
      const seg = el("span", "hist-seg");
      seg.appendChild(who(histPlayer(g, ln.by)));
      seg.appendChild(el("span", "hist-act", "fires"));
      rw.appendChild(seg);
      rw.appendChild(el("span", "hist-cell", ln.cell || ""));
      if (ln.sunk) rw.appendChild(el("span", "hist-pill sunk", "Sunk · " + ln.sunk));
      else if (ln.result === "hit") rw.appendChild(el("span", "hist-pill hit", "Hit"));
      else rw.appendChild(el("span", "hist-pill miss", "Miss"));
      list.appendChild(rw);
    } else {
      const rw = row("Turn " + ln.tick);
      rw.appendChild(el("span", "hist-note", ln.text || ""));
      list.appendChild(rw);
    }
  });
  return n;
}
