import type { BattleshipLogLine, BattleshipMove, BattleshipState } from "@chat/contract";
import { el } from "../../../lib/index";
import { histPlayer, type HistRow, type HistWho } from "../shared/history";

/** One History row: a shot, or a narrative note, on its turn. */
type BsEntry = { turn: number; shot?: BattleshipMove; note?: string };

/* The match's record as History rows. The state carries every shot
 * (shots, never trimmed) but only the last lines of the narrative log,
 * whose shot lines are the record's last shots. So the shots older than
 * the log come from the record, then the log follows in its own order,
 * notes and all. A match with no shot record (from before it) reads its
 * log alone, as it always did. */
function bsEntries(g: BattleshipState): BsEntry[] {
  const log: BattleshipLogLine[] = g.log || [];
  const shots = g.shots || [];
  const older = Math.max(0, shots.length - log.filter((ln) => ln.by).length);
  const out: BsEntry[] = shots.slice(0, older).map((s) => ({ turn: s.turn, shot: s }));
  log.forEach((ln) => {
    if (ln.by) out.push({ turn: ln.tick, shot: { by: ln.by, target: ln.target, cell: ln.cell || "", result: ln.result || "miss", sunk: ln.sunk ?? null, turn: ln.tick } });
    else out.push({ turn: ln.tick, note: ln.text || "" });
  });
  return out;
}

/** Battleship's History rows: each shot (who, the cell, hit, miss or sunk)
 * and the narrative lines as notes. */
export function bsHistoryRows(g: BattleshipState, row: HistRow, who: HistWho, list: HTMLElement): number {
  const entries = bsEntries(g);
  entries.forEach((e) => {
    const rw = row("Turn " + e.turn);
    const s = e.shot;
    if (s) {
      const seg = el("span", "hist-seg");
      seg.appendChild(who(histPlayer(g, s.by)));
      seg.appendChild(el("span", "hist-act", "fires"));
      rw.appendChild(seg);
      rw.appendChild(el("span", "hist-cell", s.cell || ""));
      if (s.sunk) rw.appendChild(el("span", "hist-pill sunk", "Sunk · " + s.sunk));
      else if (s.result === "hit") rw.appendChild(el("span", "hist-pill hit", "Hit"));
      else rw.appendChild(el("span", "hist-pill miss", "Miss"));
    } else {
      rw.appendChild(el("span", "hist-note", e.note || ""));
    }
    list.appendChild(rw);
  });
  return entries.length;
}

/** The History tab's count: its rows, shots and notes. */
export function bsHistoryCount(g: BattleshipState): number {
  return bsEntries(g).length;
}
