import { el } from "../../../lib/index";
import type { SketchPlayer, SketchRound, SketchState } from "@chat/contract";

/* Sketch & Guess outside its panels (2026-11-20; the panels are React
   since 2026-11-21, SketchPanels.tsx): the sketch pad's drawing, the last
   round and the history rows. The pad keeps its strokes (and its pen) in
   an SgPad the view holds on gameView for the round, so a poll never
   wipes a half-drawn picture. Images go to the server as a PNG data URL;
   agents send generated images the same way. */

export type Stroke = { color: string; size: number; pts: number[] };
/* The pad's drawing for one round: its strokes and the pen. */
export type SgPad = { round: number; strokes: Stroke[]; color: string; size: number; erasing: boolean };

export const PAD_W = 640;
export const PAD_H = 480;
export const PAD_COLORS = ["#111827", "#ef4444", "#f97316", "#facc15", "#22c55e", "#3b82f6", "#a855f7", "#8b5a2b"];
export const PAD_SIZES = [4, 10, 22];

/* A blank page and the default pen (the first colour, the middle size). */
export function sgNewPad(round: number): SgPad {
  return { round, strokes: [], color: PAD_COLORS[0]!, size: PAD_SIZES[1]!, erasing: false };
}

export function sgLastRound(g: SketchState): SketchRound | null {
  const rs: SketchRound[] = (g && g.rounds) || [];
  return rs.length ? rs[rs.length - 1]! : null;
}

export function sgHistoryRows(g: SketchState, row: (idx: string) => HTMLElement, who: (p: Pick<SketchPlayer, "name" | "hex">) => HTMLElement, list: HTMLElement): number {
  let n = 0;
  const players: SketchPlayer[] = g.players || [];
  const byName = (nm: string): Pick<SketchPlayer, "name" | "hex"> => players.find((p: SketchPlayer) => p.name === nm) || { name: nm, hex: "#94a3b8" };
  ((g.rounds || []) as SketchRound[]).forEach((r: SketchRound) => {
    n++;
    const rw = row("Round " + r.n);
    const seg = el("span", "hist-seg");
    seg.appendChild(who(byName(r.artist)));
    seg.appendChild(el("span", "hist-act", (r.forfeit ? "no drawing · " : "drew · ") + r.prompt));
    rw.appendChild(seg);
    Object.keys(r.guesses || {}).forEach((nm: string) => {
      const x = r.guesses[nm]!;
      const s2 = el("span", "hist-seg");
      s2.appendChild(who(byName(nm)));
      s2.appendChild(el("span", "hist-act", (x.right ? "✓ " : "✗ ") + x.guess));
      rw.appendChild(s2);
    });
    list.appendChild(rw);
  });
  return n;
}
