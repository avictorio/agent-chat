import { el } from "../../lib";
import type { GL } from "../shared/render";

/* Four in a Row in the DOM (2026-11-19): the board (card and arena),
   the drop row a player taps on their turn, and the move history. The
   server's board is 6 strings, top row first: X (the first seat), O (the
   second) or . for empty; `line` is the winning cells as [col, row],
   1-based from the bottom left. Discs carry the player's colour plus a
   second channel - X discs are solid, O discs are ringed - so the board
   reads without colour too. */

export const C4_COLS = 7;
export const C4_ROWS = 6;

function seatHex(g: GL, piece: string): string {
  const p = ((g && g.players) || []).find((x: GL) => x.piece === piece);
  return (p && p.hex) || (piece === "X" ? "#22d3ee" : "#fb923c");
}

function seatName(g: GL, piece: string): string {
  const p = ((g && g.players) || []).find((x: GL) => x.piece === piece);
  return (p && p.name) || piece;
}

/* The board. opts.onDrop makes the column heads buttons (your turn);
   opts.compact draws the card's small board. */
export function c4Board(g: GL, opts?: { compact?: boolean; onDrop?: (col: number) => void; open?: string[]; headsOnly?: boolean }): HTMLElement {
  const compact = !!(opts && opts.compact);
  const wrap = el("div", "c4-wrap" + (compact ? " compact" : ""));
  const board: string[] = (g && g.board) || Array(C4_ROWS).fill(".".repeat(C4_COLS));
  const line = new Set(((g && g.line) || []).map((cr: number[]) => cr[0] + ":" + cr[1]));
  const last = g && g.last_move ? g.last_move.col + ":" + g.last_move.row : "";
  if (opts && opts.onDrop) {
    const heads = el("div", "c4-heads");
    const open = new Set(opts.open || []);
    for (let c = 1; c <= C4_COLS; c++) {
      const b = el("button", "c4-drop", String(c)) as HTMLButtonElement;
      b.type = "button";
      b.disabled = !open.has(String(c));
      b.setAttribute("aria-label", "Drop in column " + c + (b.disabled ? " (full)" : ""));
      const cc = c;
      b.addEventListener("click", () => opts.onDrop && opts.onDrop(cc));
      heads.appendChild(b);
    }
    wrap.appendChild(heads);
  }
  // in 3D the scene is the board: the page keeps only the drop buttons
  if (opts && opts.headsOnly) return wrap;
  const grid = el("div", "c4-grid");
  grid.setAttribute("role", "grid");
  grid.setAttribute("aria-label", "Four in a Row board, 7 columns by 6 rows");
  board.forEach((rowStr, i) => {
    const row = C4_ROWS - i; // 1 = bottom
    for (let c = 1; c <= C4_COLS; c++) {
      const v = rowStr[c - 1] || ".";
      const cell = el("div", "c4-cell");
      cell.setAttribute("role", "gridcell");
      if (v !== ".") {
        const disc = el("span", "c4-disc " + (v === "X" ? "x" : "o") + (line.has(c + ":" + row) ? " win" : "") + (last === c + ":" + row ? " last" : ""));
        disc.style.setProperty("--disc", seatHex(g, v));
        cell.appendChild(disc);
        cell.setAttribute("aria-label", "Column " + c + ", row " + row + ": " + seatName(g, v));
      } else cell.setAttribute("aria-label", "Column " + c + ", row " + row + ": empty");
      grid.appendChild(cell);
    }
  });
  wrap.appendChild(grid);
  return wrap;
}

/* Who plays which disc, and whose turn it is. */
export function c4Seats(g: GL, me?: string): HTMLElement {
  const row = el("div", "c4-seats");
  ((g && g.players) || []).forEach((p: GL, i: number) => {
    if (i) row.appendChild(el("span", "fl-vs", "vs"));
    const s = el("span", "c4-seat" + (g.status === "running" && g.turn_of === p.name ? " up" : ""));
    const d = el("span", "c4-disc mini " + (p.piece === "X" ? "x" : "o"));
    d.style.setProperty("--disc", p.hex);
    s.appendChild(d);
    s.appendChild(el("span", "c4-seat-name", p.name + (me && p.name === me ? " (you)" : "")));
    if (p.timeouts) s.appendChild(el("span", "c4-seat-to", p.timeouts + (p.timeouts === 1 ? " timeout" : " timeouts")));
    row.appendChild(s);
  });
  return row;
}

/* History: a row per move. */
export function c4HistoryRows(g: GL, row: (idx: string) => HTMLElement, who: (p: GL) => HTMLElement, list: HTMLElement): number {
  let n = 0;
  const players: GL[] = g.players || [];
  ((g.moves || []) as GL[]).forEach((m: GL) => {
    n++;
    const rw = row("Move " + m.n);
    const p = players.find((x) => x.name === m.by) || { name: m.by, hex: "#94a3b8" };
    const seg = el("span", "hist-seg");
    seg.appendChild(who(p));
    seg.appendChild(el("span", "hist-act", "column " + m.col));
    rw.appendChild(seg);
    const isLast = n === (g.moves || []).length;
    if (isLast && g.status === "finished" && g.winner === m.by) {
      const pill = el("span", "hist-pill win", "four in a row");
      pill.style.borderColor = p.hex;
      pill.style.color = p.hex;
      rw.appendChild(pill);
    }
    list.appendChild(rw);
  });
  return n;
}
