import { Fragment, type ReactNode } from "react";
import type { LightCyclesDir, LightCyclesPlayer, LightCyclesState, LightCyclesTrail, LightCyclesYou } from "@chat/contract";
import { cardKey } from "../shared/cardkey";

/* Light Cycles' panels: the riders, the steering pad on your move, the
   record keeper and the chat card (the board as an SVG of the trails,
   and its foot). The view (view.tsx) mounts the first three with
   ctx.panel; the pad's taps call the view's move callback, as a tap on
   a heading marker in the scene does. */

/* The riders: each one's colour, name and state this tick. */
export function LcRiders({ g }: { g: LightCyclesState }) {
  return (
    <div className="lc-players">
      {(g.players || []).map((p: LightCyclesPlayer) => {
        const state = g.status === "lobby" ? (p.accepted ? " · in ✓" : " · invited…") : g.status === "running" ? (p.moved ? " · moved ✓" : " · deciding…") : "";
        return (
          <span key={p.name} className={"lc-chip" + (p.alive ? "" : " out")}>
            <span className="lc-dot" style={{ background: p.hex }}></span>
            {p.name + (p.alive ? state : " · out")}
          </span>
        );
      })}
    </div>
  );
}

const PAD: [LightCyclesDir, string, number, number][] = [
  ["up", "↑", 1, 0],
  ["left", "←", 0, 1],
  ["right", "→", 2, 1],
  ["down", "↓", 1, 2],
];

/* The steering pad: four headings in a cross, your queued one marked, the
   way back (and any other illegal heading) disabled. */
export function LcPad({ g, onSteer }: { g: LightCyclesState; onSteer: (dir: LightCyclesDir) => void }) {
  const you: LightCyclesYou = g.you || { playing: false };
  return (
    <div className="lc-pad">
      {PAD.map(([dir, arrow, col, row]) => (
        <button
          key={dir}
          type="button"
          className={"lc-btn" + (you.queued === dir ? " queued" : "")}
          style={{ gridColumn: String(col + 1), gridRow: String(row + 1) }}
          aria-label={"Steer " + dir}
          disabled={(you.legal_moves || []).indexOf(dir) < 0}
          onClick={() => onSteer(dir)}
        >
          {arrow}
        </button>
      ))}
    </div>
  );
}

/* The first rider out keeps the record. */
export function LcRecordKeeper({ name }: { name: string }) {
  return <div className="lc-note">{"Record keeper: " + name}</div>;
}

/* The board as an SVG: the grid, each rider's trail (a wreck dimmer than
   a live trail), the newest segment drawing itself in and the growth
   point sparking white on a live rider, a crash mark where a wreck ends,
   and the live riders' heads. */
function LcBoard({ g }: { g: LightCyclesState }) {
  let grid = "";
  for (let x = 1; x < g.w; x++) grid += "M" + x + " 0V" + g.h;
  for (let y = 1; y < g.h; y++) grid += "M0 " + y + "H" + g.w;
  const byColor: Record<number, LightCyclesTrail[]> = {};
  (g.trails || []).forEach((c: LightCyclesTrail) => {
    (byColor[c[2]] = byColor[c[2]] || []).push(c);
  });
  // The last trail cell per rider: the growth point, and for a dead
  // rider the end of the wreck.
  const lastCell: Record<number, LightCyclesTrail> = {};
  (g.trails || []).forEach((c: LightCyclesTrail) => {
    lastCell[c[2]] = c;
  });
  const marks: ReactNode[] = [];
  (g.players || []).forEach((p: LightCyclesPlayer, i: number) => {
    const op = p.alive ? "0.45" : "0.25";
    (byColor[i] || []).forEach((c: LightCyclesTrail, k: number) => {
      marks.push(<rect key={"t" + i + "-" + k} x={c[0]} y={c[1]} width="1" height="1" fill={p.hex} opacity={op} />);
    });
    const lc = lastCell[i];
    if (!lc) return;
    if (p.alive) {
      // The newest segment draws itself in (stroke-dashoffset over 250
      // ms), so the trail visibly extends instead of appearing whole.
      const cells = byColor[i] || [];
      if (cells.length >= 2) {
        const a = cells[cells.length - 2]!;
        if (Math.abs(a[0] - lc[0]) + Math.abs(a[1] - lc[1]) === 1)
          marks.push(<line key={"d" + i} className="lc-draw" x1={a[0] + 0.5} y1={a[1] + 0.5} x2={lc[0] + 0.5} y2={lc[1] + 0.5} stroke={p.hex} strokeWidth="0.62" strokeLinecap="round" pathLength="1" />);
      }
      // The growth point sparks white and settles.
      marks.push(<rect key={"n" + i} className="lc-new" x={lc[0]} y={lc[1]} width="1" height="1" fill="#ffffff" opacity="0" />);
    } else {
      // A permanent crash mark where the wreck ends.
      const d = "M" + (lc[0] + 0.18) + " " + (lc[1] + 0.18) + "L" + (lc[0] + 0.82) + " " + (lc[1] + 0.82) + "M" + (lc[0] + 0.82) + " " + (lc[1] + 0.18) + "L" + (lc[0] + 0.18) + " " + (lc[1] + 0.82);
      marks.push(<path key={"x" + i} d={d} stroke={p.hex} strokeWidth="0.13" fill="none" />);
    }
  });
  (g.players || []).forEach((p: LightCyclesPlayer, i: number) => {
    if (p.alive && typeof p.x === "number") marks.push(<rect key={"h" + i} className="lc-head" x={p.x} y={p.y} width="1" height="1" fill={p.hex} stroke="#e0faff" strokeWidth="0.14" />);
  });
  return (
    <svg className="lc-svg" viewBox={"0 0 " + g.w + " " + g.h} preserveAspectRatio="xMidYMid meet" role="img" aria-label="Light Cycles board">
      <rect x="0" y="0" width={g.w} height={g.h} fill="#04060d" />
      <path d={grid} stroke="rgba(56,189,248,0.07)" strokeWidth="0.04" fill="none" />
      {marks}
    </svg>
  );
}

/* Under the board: whose trail is whose and, for a rider who still owes
   the tick, the same YOUR MOVE pill the Duel and Battleship cards carry
   (at the end of the meta line, a phone clips it). */
const ARROW: Record<string, string> = { up: "↑", down: "↓", left: "←", right: "→" };
function LcCardFoot({ g }: { g: LightCyclesState }) {
  const you = g.you;
  return (
    <div className="lc-card-foot">
      <div className="lc-card-key">
        {(g.players || []).map((p: LightCyclesPlayer) => (
          <span key={p.name} className={"lc-card-rider" + (p.alive || g.status === "lobby" ? "" : " out")}>
            <span className="lc-dot" style={{ background: p.hex }}></span>
            {p.name}
          </span>
        ))}
      </div>
      {you && you.playing && you.alive && g.status === "running" ? (
        <span className={"duel-pill " + (you.queued ? "locked" : "your-throw")}>{you.queued ? "✓ LOCKED · " + (ARROW[you.queued] || you.queued) : "YOUR MOVE"}</span>
      ) : null}
    </div>
  );
}

/* The card: the board and its foot, only for a match with trails. Built
   afresh for each new match object (cardKey), so the draw-in and the
   spark replay on each update. */
export function LightCyclesCard({ g }: { g: LightCyclesState; me: string }) {
  if (!g.trails) return null;
  return (
    <Fragment key={cardKey(g)}>
      <LcBoard g={g} />
      <LcCardFoot g={g} />
    </Fragment>
  );
}
