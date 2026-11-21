import { useState, type CSSProperties, type ReactNode } from "react";
import type { BattleshipBoard, BattleshipMove, BattleshipPlayer, BattleshipShip, BattleshipState, BattleshipSunkShip, BattleshipTarget, BattleshipYou } from "@chat/contract";
import { recordLine } from "../shared/render";
import { cardKey } from "../shared/cardkey";

/* Battleship's panels (2026-11-21, React): the scoreboard (the chat card,
   and the arena's for spectators and placement), the last shot's banner,
   the fleet strips under the scene, the flat boards a device without
   WebGL plays on (a spectator's, a free-for-all's, two captains' aiming
   grid, the placement grid), the placement buttons, the sonar line and
   the missed-turn warnings. The view (view.tsx) mounts them with
   ctx.panel. They hold no draft: the fleet being placed and the fire
   hook are shared with the 3D scene, so they stay with the view (bsDrafts,
   gameView.bsPlace and bsFire), and each placement step repaints both. */

function bsLabel(x: number, y: number): string {
  return String.fromCharCode(65 + x) + (y + 1);
}

function bsCellXY(label: string): [number, number] {
  return [label.charCodeAt(0) - 65, parseInt(label.slice(1), 10) - 1];
}

// The latest shot, in words: "Ada fires A6 · HIT · Henry's 4-ship is
// sunk". Empty until somebody has fired.
function lastMoveText(g: BattleshipState): string {
  const lm = g && g.last_move;
  if (!lm) return "";
  let t = lm.by + " fires " + lm.cell + " · " + (lm.result === "hit" ? "HIT" : "miss");
  if (lm.sunk) {
    const foe = lm.target
      ? (g.players || []).filter((p: BattleshipPlayer) => p.name === lm.target)[0]
      : (g.players || []).filter((p: BattleshipPlayer) => p.name !== lm.by)[0];
    t += " · " + (foe ? foe.name + "'s " : "a ") + lm.sunk + "-ship is sunk";
  }
  return t;
}

/* Text going into an SVG string (an attribute or element body) must be
   escaped: member names are free text. */
function escHtml(v: unknown): string {
  return String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

// One captain's public waters as a tiny SVG for the feed card: every
// shot that has landed on them, sunk hulls filled dark red. The last
// shot fired at this board wears a white ring.
function bsMiniSvg(board: BattleshipBoard, lastMove: BattleshipMove | null, w?: number, h?: number): string {
  const bw = w || 10, bh = h || 10;
  let s = '<svg class="bs-mini-svg" viewBox="0 0 ' + bw + " " + bh + '" role="img" aria-label="' + escHtml(board.name) + ' waters">';
  s += '<rect x="0" y="0" width="' + bw + '" height="' + bh + '" fill="#04060d"/>';
  (board.sunk_ships || []).forEach((sh: BattleshipSunkShip) => {
    // The ship the last shot just sank flashes once, so a spectator
    // sees the sinking happen instead of finding it already sunk.
    const fresh = !!(lastMove && lastMove.sunk && lastMove.by !== board.name && sh.cells.indexOf(lastMove.cell) >= 0);
    sh.cells.forEach((c: string) => {
      const xy = bsCellXY(c);
      s += '<rect x="' + xy[0] + '" y="' + xy[1] + '" width="1" height="1" fill="#991b1b"' + (fresh ? ' class="bs-mini-new"' : "") + "/>";
    });
  });
  Object.keys(board.incoming || {}).forEach((c) => {
    const xy = bsCellXY(c);
    if (board.incoming[c] === "miss")
      s += '<circle cx="' + (xy[0] + 0.5) + '" cy="' + (xy[1] + 0.5) + '" r="0.16" fill="rgba(186,230,253,.65)"/>';
    else s += '<circle cx="' + (xy[0] + 0.5) + '" cy="' + (xy[1] + 0.5) + '" r="0.3" fill="#fb923c"/>';
  });
  if (lastMove && lastMove.by !== board.name && (!lastMove.target || lastMove.target === board.name)) {
    const xy = bsCellXY(lastMove.cell);
    s += '<circle cx="' + (xy[0] + 0.5) + '" cy="' + (xy[1] + 0.5) + '" r="0.46" fill="none" stroke="#ffffff" stroke-width="0.09"/>';
  }
  s += "</svg>";
  return s;
}

/* The fleet as a strip of hull silhouettes, longest first: an afloat
   hull wears its captain's color, a sunk one sits dark and low. sunk
   lists the sizes already on the ocean floor. */
export function FleetStrip({ hex, sunk, unit, sizes, style }: { hex: string; sunk: number[]; unit?: number; sizes?: number[]; style?: CSSProperties }) {
  const left = sunk.slice();
  return (
    <div className="bs-strip" style={style}>
      {(sizes && sizes.length ? sizes : [5, 4, 3, 3, 2]).map((size: number, i: number) => {
        const j = left.indexOf(size);
        const down = j >= 0;
        if (down) left.splice(j, 1);
        const w = size * (unit || 8) + "px";
        // keyed by its state: a hull that sinks is made afresh
        return <span key={i + (down ? "s" : "")} className={"bs-hull" + (down ? " sunk" : "")} style={down ? { width: w } : { width: w, background: hex }} title={"a " + size + "-ship" + (down ? " (sunk)" : "")}></span>;
      })}
    </div>
  );
}

/* The pair (or more) of mini boards the card shows once the shooting
   starts, so the battle plays out in the feed, not only in the arena.
   Each SVG goes into its holder as the string it always was. */
function BsMiniBoards({ g }: { g: BattleshipState }) {
  if (!g.boards || !g.boards.length) return null;
  if (!(g.phase === "play" || g.status === "finished")) return null;
  return (
    <div className="bs-minis">
      {g.boards.map((b: BattleshipBoard) => (
        <div key={b.name} className="bs-mini">
          <div className="bs-mini-name">{b.name}</div>
          <div dangerouslySetInnerHTML={{ __html: bsMiniSvg(b, g.last_move, g.w, g.h) }}></div>
        </div>
      ))}
    </div>
  );
}

/* The scoreboard: counts and whose turn it is, not the boards - fleet
   positions are secret, so the feed shows counts. The boards live in the
   arena, and only for the player they belong to. The arena's leaves the
   mini boards out (the oceans are right below it). */
export function BattleshipScores({ g, minis = true }: { g: BattleshipState; minis?: boolean }) {
  let state = "";
  if (g.status === "lobby") state = (g.players || []).map((p: BattleshipPlayer) => p.name + (p.accepted ? " in ✓" : " invited…")).join(" · ");
  else if (g.status === "running" && g.phase === "setup") state = (g.players || []).map((p: BattleshipPlayer) => p.name + (p.placed ? " placed ✓" : " placing…")).join(" · ");
  else if (g.status === "running") state = "Turn " + g.turn + " · " + (g.turn_of ? g.turn_of + " to fire" : "");
  else if (g.status === "finished") state = recordLine(g);
  const lmText = lastMoveText(g);
  let pill = "";
  if (g.you && g.you.playing && g.status === "running") {
    if (g.phase === "setup" && !(g.you.fleet && g.you.fleet.length)) pill = "PLACE YOUR FLEET";
    else if (g.phase === "play" && g.you.your_turn) pill = "YOUR SHOT";
  }
  return (
    <div className="duel-board">
      {(g.players || []).map((p: BattleshipPlayer) => {
        const bd = (g.boards || []).filter((b: BattleshipBoard) => b.name === p.name)[0];
        return (
          <div key={p.name} className="duel-row">
            <span className="lc-dot" style={{ background: p.hex }}></span>
            <span className="duel-name">{p.name}</span>
            <span className="duel-state" style={{ marginLeft: "8px" }}>
              {(p.afloat != null ? p.afloat : 5) + " afloat · " + (p.hits || 0) + " hits · " + (p.sunk || 0) + " sunk" + (p.eliminated ? " · 💀 eliminated" : "")}
            </span>
            {bd ? <FleetStrip hex={p.hex} sunk={(bd.sunk_ships || []).map((s: BattleshipSunkShip) => s.size)} unit={6} sizes={g.fleet_sizes} style={{ marginLeft: "auto" }} /> : null}
          </div>
        );
      })}
      {state ? <div className="duel-stateline">{state}</div> : null}
      {lmText && (g.phase === "play" || g.status === "finished") ? <div className="duel-stateline bs-lastline ribbon-in">{"Last shot · " + lmText}</div> : null}
      {minis ? <BsMiniBoards g={g} /> : null}
      {pill ? <span className="duel-pill your-throw">{pill}</span> : null}
    </div>
  );
}

/* The card: the scoreboard, built afresh for each new match object
   (cardKey), as the painter did, so the last-shot ribbon and a sinking's
   flash replay on each update. */
export function BattleshipCard({ g }: { g: BattleshipState; me: string }) {
  return <BattleshipScores key={cardKey(g)} g={g} />;
}

/* The arena banner announcing the last shot, duel-verdict style; fresh
   (first sight of the shot) plays its entrance. Keyed by turn, so each
   shot's banner is made afresh (a miss keeps no empty style from the
   last sinking's border). */
export function BsBanner({ g, fresh }: { g: BattleshipState; fresh: boolean }) {
  const lm = g && g.last_move;
  if (!lm) return null;
  return (
    <div key={lm.turn} className={"duel-verdict bs-verdict" + (lm.result === "hit" ? "" : " clash") + (fresh ? " reveal-in" : "")} style={lm.sunk ? { borderColor: "#f97316" } : undefined}>
      <span className="v-icons">{lm.result === "hit" ? "💥" : "💦"}</span>
      <span>{lastMoveText(g)}</span>
    </div>
  );
}

/* The fleet strips under the scene: each captain's sizes still afloat. */
export function BsStrips({ g, fleets }: { g: BattleshipState; fleets: { label: string; hex: string; sunk: number[] }[] }) {
  return (
    <div className="bs-strips3d">
      {fleets.map((f, i: number) => (
        <div key={i} className="bs-strip3d">
          <span className="bs-strip3d-label">{f.label}</span>
          <FleetStrip hex={f.hex} sunk={f.sunk} sizes={g.fleet_sizes} />
        </div>
      ))}
    </div>
  );
}

/* Extra classes per cell: the last shot's ring and burst, a sinking. */
type Marks = Record<string, string[]>;

// The last shot rings (and, on first sight, bursts or splashes on) its
// cell in the waters of the captain it hit - in a free-for-all only that
// captain's, the shot names its target. On first sight of a sinking the
// ship it finished (among ships) flashes and settles into the wreck.
function shotMarks(g: BattleshipState, owner: string, fresh: boolean, ships: BattleshipSunkShip[] | null): Marks {
  const marks: Marks = {};
  const lm = g && g.last_move;
  if (!lm || lm.by === owner) return marks;
  const add = (c: string, cls: string) => {
    (marks[c] = marks[c] || []).push(cls);
  };
  if (!lm.target || lm.target === owner) {
    add(lm.cell, "bs-last");
    if (fresh) add(lm.cell, lm.result === "hit" ? "bs-boom" : "bs-splash");
  }
  if (ships && fresh && lm.sunk) {
    const ship = ships.filter((s: BattleshipSunkShip) => s.size === lm.sunk && (s.cells || []).indexOf(lm.cell) >= 0)[0];
    if (ship) ship.cells.forEach((c: string) => add(c, "bs-sinking"));
  }
  return marks;
}

/* One board as a grid inside a coordinate frame (A-J across, 1-10 down;
   8x8 in skirmish). states maps a cell label ("C5") to "ship" | "hit" |
   "miss" | "sunk"; hex colours ship cells. With onFire, unfired cells are
   buttons that report their label; a fired one dips (bs-aim) while the
   shot is in flight, until the next repaint brings new states. ships
   (optional) groups cells into hulls so a ship reads as one tapered
   shape - bow at its first cell, stern at its last. A cell is keyed by
   its state, so one that changes is made afresh (no empty style left
   when a hit hull sinks). */
export function BsGrid({
  states,
  hex,
  onFire,
  ships,
  verb,
  dims,
  marks,
}: {
  states: Record<string, string>;
  hex: string;
  onFire: ((label: string) => void) | null;
  ships?: { cells: string[] }[];
  verb?: string;
  dims?: { w?: number; h?: number };
  marks?: Marks;
}) {
  const [aim, setAim] = useState<{ label: string; states: Record<string, string> } | null>(null);
  const aimed = aim && aim.states === states ? aim.label : null;
  const bw = (dims && dims.w) || 10, bh = (dims && dims.h) || 10;
  const seg: Record<string, string> = {};
  (ships || []).forEach((s: { cells: string[] }) => {
    const cells: string[] = s.cells || [];
    if (cells.length < 2) return;
    const horiz = (cells[0] || "").slice(1) === (cells[1] || "").slice(1);
    cells.forEach((c, i) => {
      seg[c] = (horiz ? "seg-h" : "seg-v") + (i === 0 ? " seg-start" : i === cells.length - 1 ? " seg-end" : " seg-mid");
    });
  });
  const shoot = onFire;
  const cells: ReactNode[] = [];
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      const label = bsLabel(x, y);
      const st = states[label] || "";
      const base = "bs-cell " + st + (seg[label] ? " " + seg[label] : "");
      const extra = ((marks && marks[label]) || []).concat(shoot && !st && label === aimed ? ["bs-aim"] : []);
      // the marks were added to the class list, which drops stray spaces
      const cls = extra.length ? base.split(" ").filter(Boolean).concat(extra).join(" ") : base;
      if (shoot && !st)
        cells.push(
          <button
            key={label}
            type="button"
            className={cls}
            aria-label={(verb || "Fire at ") + label}
            onClick={() => {
              // A shot gets an anticipation beat: the cell dips while the
              // shot is in flight, before the stream brings the result.
              if (!verb || verb.indexOf("Fire") === 0) setAim({ label, states });
              shoot(label);
            }}
          ></button>
        );
      else
        cells.push(
          <div key={label + "|" + st} className={cls} style={st === "ship" || st === "hit" ? { backgroundColor: hex } : undefined}>
            {st === "hit" || st === "sunk" ? "✕" : st === "miss" ? "·" : null}
          </div>
        );
    }
  }
  const cols = "repeat(" + bw + ", 1fr)";
  return (
    <div className="bs-frame">
      <div></div>
      <div className="bs-axis-x" style={{ gridTemplateColumns: cols }}>
        {Array.from({ length: bw }, (_, x: number) => (
          <span key={x}>{String.fromCharCode(65 + x)}</span>
        ))}
      </div>
      <div className="bs-axis-y" style={{ gridTemplateRows: "repeat(" + bh + ", 1fr)" }}>
        {Array.from({ length: bh }, (_, y: number) => (
          <span key={y}>{String(y + 1)}</span>
        ))}
      </div>
      <div className="bs-grid" style={{ gridTemplateColumns: cols }}>
        {cells}
      </div>
    </div>
  );
}

/* The fire some waters took, sunk hulls marked. */
function hitStates(shots: Record<string, string> | undefined, sunk: BattleshipSunkShip[] | undefined): Record<string, string> {
  const states: Record<string, string> = {};
  Object.keys(shots || {}).forEach((c) => {
    states[c] = shots![c]!;
  });
  (sunk || []).forEach((s: BattleshipSunkShip) => {
    s.cells.forEach((c: string) => {
      states[c] = "sunk";
    });
  });
  return states;
}

/* A spectator without WebGL: every captain's public waters (a wreck
   chart for one who is out), no fire. */
export function BsWatchBoards({ g, fresh }: { g: BattleshipState; fresh: boolean }) {
  return (
    <div className="bs-boards">
      {(g.boards || []).map((b: BattleshipBoard) => (
        <div key={b.name} className={"bs-side" + (b.eliminated ? " bs-wreck" : "")}>
          <div className="bs-title">{b.name + "'s waters" + (b.eliminated ? " — wreck" : "")}</div>
          <FleetStrip hex={b.hex} sunk={(b.sunk_ships || []).map((s: BattleshipSunkShip) => s.size)} sizes={g.fleet_sizes} />
          <BsGrid states={hitStates(b.incoming, b.sunk_ships)} hex={b.hex} onFire={null} ships={b.sunk_ships || []} dims={g} marks={shotMarks(g, b.name, fresh, b.sunk_ships || [])} />
        </div>
      ))}
    </div>
  );
}

/* A free-for-all without WebGL: your waters, then one board per rival
   showing your shots at that captain; a tap on a live rival's board fires
   at them ("Name:Cell"); a wreck chart takes no fire. */
export function BsFfaBoards({ g, me, canFire, fresh, onFire }: { g: BattleshipState; me: BattleshipPlayer; canFire: boolean; fresh: boolean; onFire: (dir: string) => void }) {
  const you: Partial<BattleshipYou> = g.you || {};
  const own: Record<string, string> = {};
  (you.fleet || []).forEach((s: BattleshipShip) => {
    s.cells.forEach((c: string) => {
      own[c] = s.hits.indexOf(c) >= 0 ? (s.sunk ? "sunk" : "hit") : "ship";
    });
  });
  Object.keys(you.incoming || {}).forEach((c) => {
    if (!own[c]) own[c] = "miss";
  });
  return (
    <div className="bs-boards">
      <div className="bs-side">
        <div className="bs-title">{"Your waters" + (you.eliminated ? " — wreck" : "")}</div>
        <FleetStrip hex={me.hex} sunk={(you.fleet || []).filter((s: BattleshipShip) => s.sunk).map((s: BattleshipShip) => s.size)} sizes={g.fleet_sizes} />
        <BsGrid states={own} hex={me.hex} onFire={null} ships={you.fleet || []} dims={g} marks={shotMarks(g, me.name, fresh, you.fleet || [])} />
      </div>
      {(you.targets || []).map((t: BattleshipTarget) => (
        <div key={t.name} className={"bs-side" + (t.eliminated ? " bs-wreck" : "")}>
          <div className="bs-title">{t.name + "'s waters" + (t.eliminated ? " — wreck" : canFire ? " - tap a cell to fire" : "")}</div>
          <FleetStrip hex={t.hex} sunk={(t.sunk_ships || []).map((s: BattleshipSunkShip) => s.size)} sizes={g.fleet_sizes} />
          <BsGrid
            states={hitStates(t.shots, t.sunk_ships)}
            hex={t.hex}
            onFire={canFire && !t.eliminated ? (label: string) => onFire(t.name + ":" + label) : null}
            ships={t.sunk_ships || []}
            dims={g}
            marks={shotMarks(g, t.name, fresh, t.sunk_ships || [])}
          />
        </div>
      ))}
    </div>
  );
}

/* Two captains without WebGL: their waters as the aiming grid (your
   shots; a tap fires on your turn). */
export function BsAim({ g, opp, canFire, fresh, onFire }: { g: BattleshipState; opp: BattleshipPlayer; canFire: boolean; fresh: boolean; onFire: (label: string) => void }) {
  const you: Partial<BattleshipYou> = g.you || {};
  return (
    <div className="bs-side bs-aim">
      <div className="bs-title">{opp.name + "'s waters" + (canFire ? " - tap a cell to fire" : "")}</div>
      <BsGrid states={hitStates(you.shots, you.sunk_ships)} hex={opp.hex} onFire={canFire ? onFire : null} ships={you.sunk_ships || []} dims={g} marks={shotMarks(g, opp.name, fresh, null)} />
    </div>
  );
}

/* Placing a fleet without WebGL: your waters, a tap lays the next hull's
   bow. */
export function BsPlaceGrid({ g, hex, states, ships, onPlace }: { g: BattleshipState; hex: string; states: Record<string, string>; ships: { size: number; cells: string[] }[]; onPlace: (label: string) => void }) {
  return (
    <div className="bs-boards">
      <div className="bs-side">
        <div className="bs-title">Your waters - place your fleet</div>
        <BsGrid states={states} hex={hex} onFire={onPlace} ships={ships} verb="Place at " dims={g} />
      </div>
    </div>
  );
}

/* The placement line and its buttons: the next hull and how it lies,
   Rotate, Undo, Random, and Place this fleet once it is complete. */
export function BsPlacePad({ next, orient, onRotate, onUndo, onRandom, onGo }: { next: number; orient: string; onRotate: () => void; onUndo: () => void; onRandom: () => void; onGo: () => void }) {
  return (
    <>
      <div className="duel-statusline">
        {next ? "Next hull: your " + next + "-ship, lying " + (orient === "H" ? "horizontal" : "vertical") + " from the cell you tap." : "Fleet complete - send it when it looks right."}
      </div>
      <div className="duel-pad">
        <button type="button" className="duel-btn" onClick={onRotate}>
          Rotate hull
        </button>
        <button type="button" className="duel-btn quiet" onClick={onUndo}>
          Undo last hull
        </button>
        <button type="button" className="duel-btn quiet" onClick={onRandom}>
          Place randomly instead
        </button>
        {!next ? (
          <button type="button" className="duel-btn" onClick={onGo}>
            Place this fleet
          </button>
        ) : null}
      </div>
    </>
  );
}

/* The endgame sonar ping: a free-for-all names the leader it hunts. */
export function BsSonar({ g, ffa }: { g: BattleshipState; ffa?: boolean }) {
  const s = g.sonar;
  if (!s) return null;
  return (
    <div className="bs-sonar">
      {ffa && s.target
        ? "📡 Sonar for " + s.for + ": a hull cell of " + s.target + "'s fleet - the leader - sits in " + s.label + "."
        : "📡 Sonar for " + s.for + ": a hull cell of the last ship sits in " + s.label + "."}
    </div>
  );
}

/* Whether any captain has let a turn run out (so BsWarnings has a line). */
export function bsWarned(g: BattleshipState): boolean {
  return (g.players || []).some((p: BattleshipPlayer) => ((g.misses || {})[p.name] || 0) >= 1);
}

/* A line per captain who let turns run out: three in a row eliminate
   (a free-for-all) or forfeit the match (two captains). */
export function BsWarnings({ g, ffa }: { g: BattleshipState; ffa?: boolean }) {
  return (
    <>
      {(g.players || []).map((p: BattleshipPlayer) => {
        const m = (g.misses || {})[p.name] || 0;
        if (m >= 2)
          return (
            <div key={p.name} className="bs-warn">
              {"⚠ " + p.name + " has missed " + m + (ffa ? " turns in a row — one more and they're eliminated." : " turns in a row — one more forfeits the match.")}
            </div>
          );
        if (m === 1)
          return (
            <div key={p.name} className="bs-warn soft">
              {p.name + (ffa ? " has missed a turn — three in a row eliminates them." : " has missed a turn — three in a row forfeits the match.")}
            </div>
          );
        return null;
      })}
    </>
  );
}
