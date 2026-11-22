import { Fragment, type CSSProperties, type ReactElement } from "react";
import type { FourInARowPlayer, FourInARowState } from "@chat/contract";
import { C4_COLS, C4_ROWS } from "./fourinarow";

/* Four in a Row's panels (2026-11-21, React): who plays which disc, the
   1-7 drop buttons under the scene on your turn, and the chat card's
   small board. The view (view.tsx) mounts the first two with ctx.panel.
   The server's board is 6 strings, top row first: X (the first seat),
   O (the second) or . for empty; `line` is the winning cells as
   [col, row], 1-based from the bottom left. Discs carry the player's
   colour plus a second channel - X discs are solid, O discs are ringed -
   so the board reads without colour too. */

function seatHex(g: FourInARowState, piece: string): string {
  const p = ((g && g.players) || []).find((x: FourInARowPlayer) => x.piece === piece);
  return (p && p.hex) || (piece === "X" ? "#22d3ee" : "#fb923c");
}

function seatName(g: FourInARowState, piece: string): string {
  const p = ((g && g.players) || []).find((x: FourInARowPlayer) => x.piece === piece);
  return (p && p.name) || piece;
}

/* Who plays which disc, and whose turn it is. */
export function FourSeats({ g, me }: { g: FourInARowState; me?: string }) {
  return (
    <div className="c4-seats">
      {((g && g.players) || []).map((p: FourInARowPlayer, i: number) => (
        <Fragment key={p.name}>
          {i ? <span className="fl-vs">vs</span> : null}
          <span className={"c4-seat" + (g.status === "running" && g.turn_of === p.name ? " up" : "")}>
            <span className={"c4-disc mini " + (p.piece === "X" ? "x" : "o")} style={{ "--disc": p.hex } as CSSProperties}></span>
            <span className="c4-seat-name">{p.name + (me && p.name === me ? " (you)" : "")}</span>
            {p.timeouts ? <span className="c4-seat-to">{p.timeouts + (p.timeouts === 1 ? " timeout" : " timeouts")}</span> : null}
          </span>
        </Fragment>
      ))}
    </div>
  );
}

/* Your turn: the column heads as drop buttons (the scene is the board;
   its columns take a tap too). open lists the columns with room. */
export function FourDrops({ open, onDrop }: { open: string[]; onDrop: (col: number) => void }) {
  const room = new Set(open);
  const heads: ReactElement[] = [];
  for (let n = 1; n <= C4_COLS; n++) {
    const c = n;
    const full = !room.has(String(c));
    heads.push(
      <button key={c} type="button" className="c4-drop" disabled={full} aria-label={"Drop in column " + c + (full ? " (full)" : "")} onClick={() => onDrop(c)}>
        {String(c)}
      </button>
    );
  }
  return (
    <div className="c4-under">
      <div className="c4-wrap">
        <div className="c4-heads">{heads}</div>
      </div>
    </div>
  );
}

/* The card: the board, small. */
export function FourInARowCard({ g }: { g: FourInARowState; me: string }) {
  const board: string[] = (g && g.board) || Array(C4_ROWS).fill(".".repeat(C4_COLS));
  const line = new Set(((g && g.line) || []).map((cr: number[]) => cr[0] + ":" + cr[1]));
  const last = g && g.last_move ? g.last_move.col + ":" + g.last_move.row : "";
  const cells: ReactElement[] = [];
  board.forEach((rowStr, i) => {
    const row = C4_ROWS - i; // 1 = bottom
    for (let c = 1; c <= C4_COLS; c++) {
      const v = rowStr[c - 1] || ".";
      const at = c + ":" + row;
      cells.push(
        v !== "." ? (
          <div key={at} className="c4-cell" role="gridcell" aria-label={"Column " + c + ", row " + row + ": " + seatName(g, v)}>
            <span className={"c4-disc " + (v === "X" ? "x" : "o") + (line.has(at) ? " win" : "") + (last === at ? " last" : "")} style={{ "--disc": seatHex(g, v) } as CSSProperties}></span>
          </div>
        ) : (
          <div key={at} className="c4-cell" role="gridcell" aria-label={"Column " + c + ", row " + row + ": empty"}></div>
        )
      );
    }
  });
  return (
    <div className="c4-wrap compact">
      <div className="c4-grid" role="grid" aria-label="Four in a Row board, 7 columns by 6 rows">
        {cells}
      </div>
    </div>
  );
}
