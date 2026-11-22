import { el } from "../../../lib/index";
import type { LetterGridPlayer, LetterGridRound, LetterGridState } from "@chat/contract";
import type { HistRow, HistWho } from "../shared/history";

/* Letter Grid: the word being made (the draft, shared by the word panel
   and the scene), tracing a word on the grid, a tap on a tile, the move
   text and the history. The scoreboard, the word panel, the last
   round's words and the chat card are React (LetterGridPanels.tsx). The
   grid itself is the 3D scene - the card keeps a small flat thumbnail,
   like every card. Words are sealed until the round resolves (the
   server sends only your own, in you.queued). */

export type LgDraft = { round: number; word: string; path: number[][] | null; tapped: boolean };

export const lgLabel = (r: number, c: number) => String.fromCharCode(65 + c) + (r + 1);

export function lgLastRound(g: LetterGridState): LetterGridRound | null {
  const rs: LetterGridRound[] = (g && g.rounds) || [];
  return rs.length ? rs[rs.length - 1]! : null;
}

const touches = (a: number[], b: number[]) => Math.abs(a[0]! - b[0]!) <= 1 && Math.abs(a[1]! - b[1]!) <= 1;

/* Every way to trace `word` (up to cap), in the server's search order, so
   the best pick below is the path the server would take. */
function paths(grid: string[], word: string, cap: number): number[][][] {
  const n = grid.length;
  const out: number[][][] = [];
  const path: number[][] = [];
  const seen = new Array(n * n).fill(false);
  const walk = (r: number, c: number, i: number) => {
    if (out.length >= cap || grid[r]![c] !== word[i]) return;
    seen[r * n + c] = true;
    path.push([r, c]);
    if (i === word.length - 1) out.push(path.slice());
    else
      for (let dr = -1; dr <= 1; dr++)
        for (let dc = -1; dc <= 1; dc++) {
          const rr = r + dr,
            cc = c + dc;
          if ((dr || dc) && rr >= 0 && cc >= 0 && rr < n && cc < n && !seen[rr * n + cc]) walk(rr, cc, i + 1);
        }
    seen[r * n + c] = false;
    path.pop();
  };
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) walk(r, c, 0);
  return out;
}

/* The path that claims the most free cells, as the claims stand (the
   server's rule for a word sent without one), or null. */
export function lgTrace(g: LetterGridState, word: string): number[][] | null {
  const grid: string[] = g.grid || [];
  if (!word || !grid.length) return null;
  const n = grid.length;
  const claims: (string | null)[] = g.claims || [];
  const all = paths(grid, word, 64);
  if (!all.length) return null;
  const free = (p: number[][]) => p.filter(([r, c]) => !claims[r! * n + c!]).length;
  return all.reduce((a, b) => (free(b) > free(a) ? b : a));
}

/* A tap on a tile: extend the path when it touches the last cell and is
   unused, step back when it is the last cell, or start over there. */
export function lgTap(g: LetterGridState, d: LgDraft, r: number, c: number): LgDraft {
  const grid: string[] = g.grid || [];
  const cur = d.path && d.tapped ? d.path : [];
  const last = cur[cur.length - 1];
  let next: number[][];
  if (last && last[0] === r && last[1] === c) next = cur.slice(0, -1);
  else if (last && touches(last, [r, c]) && !cur.some(([a, b]) => a === r && b === c)) next = cur.concat([[r, c]]);
  else next = [[r, c]];
  const word = next.map(([a, b]) => grid[a!]![b!]).join("");
  return { round: d.round, word: word, path: next.length ? next : null, tapped: next.length > 0 };
}

/* The move text: the word and its cells. */
export function lgDir(d: LgDraft): string {
  return d.word + (d.path ? " " + d.path.map(([r, c]) => lgLabel(r!, c!)).join(" ") : "");
}

export function lgHistoryRows(g: LetterGridState, row: HistRow, who: HistWho, list: HTMLElement): number {
  let n = 0;
  const players: LetterGridPlayer[] = g.players || [];
  (g.rounds || []).forEach((r: LetterGridRound) => {
    n++;
    const rw = row("Round " + r.n);
    players.forEach((p: LetterGridPlayer) => {
      const w = (r.words || {})[p.name];
      const missed = (r.missed || []).indexOf(p.name) >= 0;
      if (!w && !missed) return;
      const seg = el("span", "hist-seg");
      seg.appendChild(who(p));
      seg.appendChild(el("span", "hist-act", w ? String(w.word).toUpperCase() + " +" + ((r.points || {})[p.name] || 0) + (w.dup ? " (shared)" : w.bonus ? " · ▦" + w.bonus : "") : "no word"));
      rw.appendChild(seg);
    });
    list.appendChild(rw);
  });
  return n;
}
