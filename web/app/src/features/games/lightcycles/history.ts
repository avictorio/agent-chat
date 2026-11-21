import { el } from "../../../lib/index";
import type { GameLogLine, LightCyclesMove, LightCyclesState } from "@chat/contract";
import { histPlayer, type HistRow, type HistWho } from "../shared/history";

const DIR_ARROW: Record<string, string> = { up: "↑", down: "↓", left: "←", right: "→" };

/** Light Cycles' History rows: the move log grouped by tick (each rider's
 * turn, "clock" when the timer moved them), with the log's narrative lines
 * as notes. */
export function lcHistoryRows(g: LightCyclesState, row: HistRow, who: HistWho, list: HTMLElement): number {
  let n = 0;
  const byTick = new Map<number, LightCyclesMove[]>();
  (g.move_log || []).forEach((m: LightCyclesMove) => {
    if (!byTick.has(m.tick)) byTick.set(m.tick, []);
    (byTick.get(m.tick) as LightCyclesMove[]).push(m);
  });
  const notes = new Map<number, string[]>();
  (g.log || []).forEach((ln: GameLogLine) => {
    if (/^Tick \d+:/.test(ln.text || "")) return;
    if (!notes.has(ln.tick)) notes.set(ln.tick, []);
    (notes.get(ln.tick) as string[]).push(ln.text || "");
  });
  const ticks = Array.from(new Set([...byTick.keys(), ...notes.keys()])).sort((a, b) => a - b);
  ticks.forEach((t) => {
    const moves = byTick.get(t) || [];
    if (moves.length) {
      n++;
      const rw = row("Tick " + t);
      moves.forEach((m: LightCyclesMove) => {
        const seg = el("span", "hist-seg");
        seg.appendChild(who(histPlayer(g, m.name)));
        seg.appendChild(el("span", "hist-act", (DIR_ARROW[m.dir] || "") + " " + (m.dir || "")));
        if (!m.submitted) seg.appendChild(el("span", "hist-src", "clock"));
        rw.appendChild(seg);
      });
      list.appendChild(rw);
    }
    (notes.get(t) || []).forEach((txt) => {
      n++;
      const rw = row("Tick " + t);
      rw.appendChild(el("span", "hist-note", txt));
      list.appendChild(rw);
    });
  });
  return n;
}

/** The History tab's count: ticks with moves. */
export function lcHistoryCount(g: LightCyclesState): number {
  return new Set((g.move_log || []).map((m: LightCyclesMove) => m.tick)).size;
}
