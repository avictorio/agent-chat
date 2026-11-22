/* Four in a Row in 3D (2026-11-19): the glass board.

   The world: a tall board of glass rings standing over a dark mirror
   lake, a rose dusk behind it. Discs are glowing coins in each player's
   colour - X solid, O ringed (the second channel beside colour). On your
   turn the columns answer the pointer: a ghost disc hangs over the column
   you point at, and a tap drops it (the page's 1-7 buttons do the same).

   A move plays on the juice clock: the disc falls from above the board
   into its cell and settles with a small bounce and a click. The match's
   last move adds the ceremony: the winning four light up, a beam runs
   through them, a burst at each, the title from the viewer's seat; a
   draw gets a quiet one. Catch-up: the moves seen are remembered per game
   (localStorage) and the latest unseen move drops in on open (a tap
   skips); reduced motion places it at once with its title and sound. */
import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { CameraControls } from "@react-three/drei";
import { Color, Object3D, type InstancedMesh, type Mesh, type MeshStandardMaterial } from "three";
import { ArenaFrame, FirstFrame, Framer, Ticker, TouchControls, goHome, useQuality, useReducedMotion, type Ctl, type Home } from "../three/arena3d";
import { ArenaPost, ImpactLayer, Intro, JuiceProvider, JuiceRig, SoundToggle, useFirstVisit, useJuice, useJuiceStore, type Impact } from "../three/juice";
import { Burst, LightPillar, Shockwave, SkyDome, type SkySpec } from "../three/atmos";
import { BUZZ } from "../three/sfx";
import type { FourInARowMove, FourInARowPlayer, FourInARowState } from "@chat/contract";
import { useOnChange } from "../../../lib/useOnChange";

// One empty list for matches without players or rounds yet, so the memos
// below keep their inputs from one render to the next.
const NO_ITEMS: never[] = [];

const C4_SKY: SkySpec = {
  top: "#05030b",
  mid: "#140818",
  horizon: "#4a1430",
  ground: "#040208",
  glow: "#fb7185",
  glowAmt: 0.4,
  stars: 0.08,
};

const COLS = 7;
const ROWS = 6;
const CELL = 1;
const R_DISC = 0.4;
const BOARD_Y0 = 0.9; // the bottom row's centre
const PHONE_BELOW = 560;
const FALL = 0.55; // seconds a disc takes to fall in
const DROP_FROM = ROWS + 1.6; // rows above the bottom where it starts

type Seat = { name: string; hex: string; piece: "X" | "O"; you: boolean };
type Disc = { col: number; row: number; piece: "X" | "O"; n: number };

const cellX = (col: number) => (col - (COLS + 1) / 2) * CELL;
const cellY = (row: number) => BOARD_Y0 + (row - 1) * CELL;

/* ---------- the board ---------- */

function Board({ still }: { still: boolean }) {
  const rings = useRef<InstancedMesh>(null);
  const j = useJuice();
  const mat = useRef<MeshStandardMaterial>(null);
  useEffect(() => {
    const m = rings.current;
    if (!m) return;
    const o = new Object3D();
    let i = 0;
    for (let c = 1; c <= COLS; c++)
      for (let r = 1; r <= ROWS; r++) {
        o.position.set(cellX(c), cellY(r), 0);
        o.updateMatrix();
        m.setMatrixAt(i++, o.matrix);
      }
    m.instanceMatrix.needsUpdate = true;
  }, []);
  useFrame(() => {
    if (mat.current) mat.current.emissiveIntensity = 0.38 + (still ? 0 : 0.08 * Math.sin(j.t * 1.1));
  });
  const w = COLS * CELL + 0.5;
  const h = ROWS * CELL + 0.5;
  return (
    <group>
      {/* the glass slab behind the rings */}
      <mesh position={[0, BOARD_Y0 + (ROWS - 1) / 2, -0.12]}>
        <boxGeometry args={[w, h, 0.08]} />
        <meshStandardMaterial color="#1a0f24" transparent opacity={0.55} metalness={0.2} roughness={0.15} emissive="#3b0d24" emissiveIntensity={0.25} />
      </mesh>
      <instancedMesh ref={rings} args={[undefined, undefined, COLS * ROWS]}>
        <torusGeometry args={[0.46, 0.05, 8, 32]} />
        <meshStandardMaterial ref={mat} color="#2a1324" emissive="#fb7185" emissiveIntensity={0.55} toneMapped={false} />
      </instancedMesh>
      {/* the frame: two posts and a base */}
      {[-1, 1].map((s) => (
        <mesh key={s} position={[s * (w / 2 + 0.12), (BOARD_Y0 + ROWS * CELL) / 2 - 0.2, 0]}>
          <boxGeometry args={[0.18, ROWS * CELL + 1.3, 0.4]} />
          <meshStandardMaterial color="#120a1a" metalness={0.6} roughness={0.35} emissive="#fb7185" emissiveIntensity={0.08} />
        </mesh>
      ))}
      <mesh position={[0, -0.05, 0]}>
        <boxGeometry args={[w + 1.2, 0.18, 1.4]} />
        <meshStandardMaterial color="#120a1a" metalness={0.6} roughness={0.35} emissive="#fb7185" emissiveIntensity={0.1} />
      </mesh>
    </group>
  );
}

/* The lake: a dark mirror-ish floor (a glossy plane; the bloom does the rest). */
function Lake() {
  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.15, 0]}>
      <planeGeometry args={[300, 300]} />
      <meshStandardMaterial color="#07040b" metalness={0.85} roughness={0.22} />
    </mesh>
  );
}

/* Every settled disc in two instanced draws per player (solid face, and
   the O ring), plus the falling one animated on the juice clock. */
function Discs({ discs, seats, fall, still, winCells, winT }: { discs: Disc[]; seats: Seat[]; fall: { disc: Disc; t0: number | null } | null; still: boolean; winCells: Set<string>; winT: number }) {
  const solid = useRef<InstancedMesh>(null);
  const rings = useRef<InstancedMesh>(null);
  const j = useJuice();
  const o = useMemo(() => new Object3D(), []);
  const c = useMemo(() => new Color(), []);
  const cols = useMemo(() => ({ X: new Color(pieceHex(seats, "X")), O: new Color(pieceHex(seats, "O")) }), [seats]);
  const settled = useRef(false);
  useOnChange([discs, fall, winT, still], () => {
    settled.current = false;
  });
  useFrame((state) => {
    const a = solid.current;
    const b = rings.current;
    if (!a || !b) return;
    const falling = fall && fall.t0 != null && !still;
    const t = falling ? j.t - (fall!.t0 as number) : Infinity;
    const glow = winCells.size && winT > 0 ? Math.min(1, winT) : 0;
    if (settled.current && !falling && !(glow > 0 && glow < 1)) return;
    let na = 0;
    let nb = 0;
    const put = (d: Disc, y: number) => {
      o.position.set(cellX(d.col), y, 0.02);
      o.rotation.set(Math.PI / 2, 0, 0);
      o.scale.set(1, 1, 1);
      o.updateMatrix();
      a.setMatrixAt(na, o.matrix);
      const won = winCells.has(d.col + ":" + d.row);
      c.copy(cols[d.piece]).multiplyScalar(won ? 1.2 + 1.6 * glow : 1.05);
      a.setColorAt(na, c);
      na++;
      if (d.piece === "O") {
        o.position.z = 0.075;
        o.rotation.set(0, 0, 0);
        o.scale.setScalar(1);
        o.updateMatrix();
        b.setMatrixAt(nb, o.matrix);
        nb++;
      }
    };
    discs.forEach((d) => put(d, cellY(d.row)));
    if (fall && fall.disc) {
      const d = fall.disc;
      const end = cellY(d.row);
      if (!falling || t >= FALL + 0.25) put(d, end);
      else if (t >= 0) {
        const start = cellY(DROP_FROM);
        let y: number;
        if (t < FALL) {
          const k = t / FALL;
          y = start + (end - start) * k * k; // falls, accelerating
        } else {
          const k = (t - FALL) / 0.25; // a small bounce
          y = end + 0.18 * Math.sin(Math.PI * k) * (1 - k);
        }
        put(d, y);
      }
    }
    a.count = na;
    b.count = nb;
    a.instanceMatrix.needsUpdate = true;
    b.instanceMatrix.needsUpdate = true;
    if (a.instanceColor) a.instanceColor.needsUpdate = true;
    if (falling && t < FALL + 0.3) state.invalidate();
    else if (glow > 0 && glow < 1) state.invalidate();
    else settled.current = true;
  });
  return (
    <>
      <instancedMesh ref={solid} args={[undefined, undefined, COLS * ROWS + 1]} frustumCulled={false}>
        <cylinderGeometry args={[R_DISC, R_DISC, 0.16, 32]} />
        <meshBasicMaterial toneMapped={false} />
      </instancedMesh>
      <instancedMesh ref={rings} args={[undefined, undefined, COLS * ROWS + 1]} frustumCulled={false}>
        <torusGeometry args={[R_DISC * 0.55, 0.06, 8, 28]} />
        <meshBasicMaterial color="#0b0610" />
      </instancedMesh>
    </>
  );
}

/* The beam through the winning four. */
function WinBeam({ line, hex, t }: { line: number[][]; hex: string; t: number }) {
  const ref = useRef<Mesh>(null);
  const a = line[0]!;
  const b = line[line.length - 1]!;
  const x0 = cellX(a[0]!), y0 = cellY(a[1]!), x1 = cellX(b[0]!), y1 = cellY(b[1]!);
  const len = Math.hypot(x1 - x0, y1 - y0) + 0.9;
  const ang = Math.atan2(y1 - y0, x1 - x0);
  const k = Math.min(1, Math.max(0, t));
  const col = useMemo(() => new Color(hex).multiplyScalar(2.4), [hex]);
  return (
    <mesh ref={ref} position={[(x0 + x1) / 2, (y0 + y1) / 2, 0.16]} rotation={[0, 0, ang]} scale={[Math.max(0.001, k), 1, 1]}>
      <boxGeometry args={[len, 0.09, 0.04]} />
      <meshBasicMaterial color={col} toneMapped={false} transparent opacity={0.9} />
    </mesh>
  );
}

/* Your turn: a hit box per column; pointing shows a ghost disc over it,
   a tap drops. */
function Columns({ open, hex, onDrop }: { open: Set<number>; hex: string; onDrop: (col: number) => void }) {
  const [hover, setHover] = useState<number | null>(null);
  const col = useMemo(() => new Color(hex).multiplyScalar(0.9), [hex]);
  return (
    <group>
      {Array.from({ length: COLS }, (_, i) => {
        const c = i + 1;
        return (
          <mesh
            key={c}
            position={[cellX(c), BOARD_Y0 + (ROWS - 1) / 2 + 0.6, 0.3]}
            onPointerOver={(e) => {
              e.stopPropagation();
              setHover(c);
            }}
            onPointerOut={() => setHover((h) => (h === c ? null : h))}
            onClick={(e) => {
              e.stopPropagation();
              if (open.has(c)) onDrop(c);
            }}
          >
            <boxGeometry args={[CELL * 0.98, ROWS * CELL + 1.6, 0.2]} />
            <meshBasicMaterial transparent opacity={0} depthWrite={false} />
          </mesh>
        );
      })}
      {hover != null && open.has(hover) ? (
        <mesh position={[cellX(hover), cellY(ROWS + 1) + 0.15, 0.02]} rotation={[Math.PI / 2, 0, 0]}>
          <cylinderGeometry args={[R_DISC, R_DISC, 0.16, 32]} />
          <meshBasicMaterial color={col} transparent opacity={0.55} toneMapped={false} />
        </mesh>
      ) : null}
    </group>
  );
}

/* ---------- the reveal's clock ---------- */

function ClockStart({ onStart }: { onStart: (t: number) => void }) {
  const j = useJuice();
  const done = useRef(false);
  useFrame((state) => {
    if (done.current) return;
    done.current = true;
    onStart(j.t);
    state.invalidate();
  });
  return null;
}

function Beats({ t0, last, onLand, onDone }: { t0: number; last: boolean; onLand: () => void; onDone: () => void }) {
  const j = useJuice();
  const fired = useRef(new Set<string>());
  useFrame((state) => {
    const t = j.t - t0;
    state.invalidate();
    if (t >= FALL && !fired.current.has("land")) {
      fired.current.add("land");
      onLand();
    }
    if (t >= FALL + (last ? 1.4 : 0.35) && !fired.current.has("done")) {
      fired.current.add("done");
      onDone();
    }
  });
  return null;
}

/* The winning four's glow, eased in on the juice clock. */
function WinClock({ on, still, onValue }: { on: boolean; still: boolean; onValue: (v: number) => void }) {
  const j = useJuice();
  const t0 = useRef<number | null>(null);
  const last = useRef(-1);
  useFrame((state) => {
    let v = 0;
    if (on) {
      if (still) v = 1;
      else {
        if (t0.current == null) t0.current = j.t;
        v = Math.min(1, (j.t - t0.current) / 0.9);
        if (v < 1) state.invalidate();
      }
    } else t0.current = null;
    const q = Math.round(v * 30) / 30;
    if (q !== last.current) {
      last.current = q;
      onValue(q);
    }
  });
  return null;
}

/* ---------- impacts from the viewer's seat ---------- */

function landImpact(g: FourInARowState, mv: FourInARowMove, seats: Seat[], last: boolean): Impact {
  const you = seats.find((s) => s.you);
  const mine = !!you && mv.by === you.name;
  if (last) {
    // The match can also end on the clock after the last drop: a third
    // timeout forfeits it, or the pass limit draws it. Then this drop did
    // not decide it, and the title says what did.
    const full = (g.board || []).every((row) => row.indexOf(".") < 0);
    if (g.draw && !full) return { trauma: 0.2, stop: 80, sound: "whoosh", title: { big: "DRAW", small: "The turns ran out on the clock", tone: "neutral" } };
    if (g.winner && g.forfeit) {
      if (you && g.winner === you.name) return { trauma: 0.5, stop: 150, pulse: 0.8, buzz: BUZZ.wonMatch, sound: "win", title: { big: "VICTORY", small: g.forfeit + " timed out three times", tone: "good" } };
      if (you && g.forfeit === you.name) return { trauma: 0.5, stop: 150, pulse: 0.6, buzz: BUZZ.lostMatch, sound: "lose", title: { big: "DEFEAT", small: "You timed out three times", tone: "bad" } };
      return { trauma: 0.3, stop: 120, pulse: 0.6, buzz: BUZZ.scored, sound: "win", title: { big: g.winner.toUpperCase() + " WINS", small: "By forfeit: " + g.forfeit + " timed out", tone: "neutral" } };
    }
    if (g.draw) return { trauma: 0.2, stop: 80, sound: "whoosh", title: { big: "DRAW", small: "The board is full", tone: "neutral" } };
    if (g.winner && you && g.winner === you.name) return { trauma: 0.8, stop: 250, slow: 0.8, pulse: 1, buzz: BUZZ.wonMatch, sound: ["clash", "win"], title: { big: "VICTORY", small: "Four in a row on move " + mv.n, tone: "good" } };
    if (g.winner && you) return { trauma: 0.8, stop: 250, slow: 0.8, pulse: 0.8, buzz: BUZZ.lostMatch, sound: ["clash", "lose"], title: { big: "DEFEAT", small: g.winner + " connects four on move " + mv.n, tone: "bad" } };
    if (g.winner) return { trauma: 0.6, stop: 200, slow: 0.6, pulse: 0.8, buzz: BUZZ.scored, sound: ["clash", "win"], title: { big: g.winner.toUpperCase() + " WINS", small: "Four in a row on move " + mv.n, tone: "neutral" } };
  }
  // an ordinary landing: a click; the rival's disc on your board also nudges
  if (you && !mine) return { trauma: 0.12, stop: 40, sound: "lock", buzz: BUZZ.commit };
  return { trauma: 0.08, sound: "lock" };
}

/* ---------- what the viewer has seen ---------- */

function seenKey(id: unknown): string {
  let path = "";
  try {
    path = location.pathname;
  } catch {
    path = "";
  }
  return "ac-c4-seen:" + path + ":" + String(id);
}
function readSeen(id: unknown): number | null {
  try {
    const v = localStorage.getItem(seenKey(id));
    return v == null ? null : Number(v) || 0;
  } catch {
    return null;
  }
}
/** the piece a player drops (X when the seat is unknown) */
function pieceIn(seats: Seat[], name: string): "X" | "O" {
  return (seats.find((s) => s.name === name) || { piece: "X" as const }).piece;
}
/** a piece's colour: its seat's, else the default for X or O */
function pieceHex(seats: Seat[], p: "X" | "O"): string {
  return (seats.find((s) => s.piece === p) || { hex: p === "X" ? "#fb923c" : "#22d3ee" }).hex;
}
function writeSeen(id: unknown, n: number) {
  try {
    localStorage.setItem(seenKey(id), String(n));
  } catch {
    // storage unavailable: the next open just won't replay
  }
}

/* Home: the whole board, the frame and a strip of lake, the rose horizon
   behind. */
function c4Home(aspect: number, width: number): Home {
  const phone = width < PHONE_BELOW;
  const vfov = aspect < 1 ? 52 : 42;
  const tv = Math.tan((vfov * Math.PI) / 360);
  const th = tv * Math.max(0.45, aspect);
  const halfW = (COLS * CELL) / 2 + 0.9;
  const halfH = (ROWS * CELL + 2.2) / 2;
  const d = Math.max(halfW / (th * 0.92), halfH / (tv * 0.9));
  const el = ((phone ? 8 : 10) * Math.PI) / 180;
  const cy = BOARD_Y0 + (ROWS - 1) / 2 + 0.5;
  // the view runs through the board's centre; the look-at point sits where
  // that line meets the floor (far behind the board)
  return { pos: [0, cy + d * Math.sin(el), d * Math.cos(el)], fov: vfov, tz: -cy / Math.tan(el) };
}

/* ---------- the arena ---------- */

export default function FourArena3D({
  g,
  me = "",
  aspect,
  onReady,
  registerCommit,
  onDrop,
}: {
  g: FourInARowState;
  me?: string;
  aspect?: number;
  onReady?: () => void;
  registerCommit?: (fn: (() => void) | null) => void;
  onDrop?: (col: number) => void;
}) {
  const still = useReducedMotion();
  const q = useQuality(still);
  const juice = useJuiceStore(still);
  const firstVisit = useFirstVisit("c4:" + String((g && g.id) || ""));
  const [ready, setReady] = useState(false);
  const ctl = useRef<Ctl | null>(null);
  const homeRef = useRef<Home | null>(null);
  const [hostW, setHostW] = useState(() => (aspect && aspect < 1.4 ? 390 : 760));
  const meL = me.toLowerCase();
  const players: FourInARowPlayer[] = (g && g.players) || NO_ITEMS;
  const moves: FourInARowMove[] = (g && g.moves) || NO_ITEMS;
  const finished = !!g && g.status === "finished";
  const seats: Seat[] = useMemo(
    () => players.map((p: FourInARowPlayer) => ({ name: String(p.name), hex: String(p.hex || "#fb7185"), piece: p.piece === "O" ? "O" : "X", you: String(p.name).toLowerCase() === meL })),
    [players, meL]
  );
  const pieceOf = (name: string) => pieceIn(seats, name);

  const [init] = useState(() => {
    const n = moves.length;
    const seen = readSeen(g && g.id);
    if (seen == null || !n || seen >= n) return { shown: n };
    return { shown: n - 1 };
  });
  const [shown, setShown] = useState(init.shown);
  const [playing, setPlaying] = useState<{ n: number; t0: number | null } | null>(null);
  const [go, setGo] = useState(false);
  const [fx, setFx] = useState<{ id: number; at: [number, number, number]; hex: string }[]>([]);
  const fxId = useRef(0);
  const [ceremony, setCeremony] = useState(0);
  const [winT, setWinT] = useState(0);
  const [say, setSay] = useState("");

  useEffect(() => {
    if (!ready || go) return;
    const t = setTimeout(() => setGo(true), firstVisit && !still ? 2400 : 300);
    return () => clearTimeout(t);
  }, [ready, go, firstVisit, still]);

  const isLast = (n: number) => finished && n === moves.length;
  const sayMove = (mv: FourInARowMove, last: boolean) =>
    mv.by + " drops in column " + mv.col + "." + (last ? (g.draw ? ((g.board || []).every((row) => row.indexOf(".") < 0) ? " The board is full - a draw." : " Then the turns ran out on the clock - a draw.") : g.winner ? (g.forfeit ? " Then " + g.forfeit + " timed out a third time - " + g.winner + " wins by forfeit." : " " + g.winner + " connects four and wins.") : "") : "");
  const land = (n: number, quiet: boolean) => {
    const mv = moves[n - 1];
    setPlaying(null);
    setShown(n);
    if (!mv) return;
    const imp = landImpact(g, mv, seats, isLast(n));
    juice.hit(quiet ? { ...imp, trauma: 0, stop: 0, slow: 0, pulse: 0 } : imp);
    setSay(sayMove(mv, isLast(n)));
    if (isLast(n) && g.winner) setCeremony((c) => c + 1);
  };

  const onLand = useEffectEvent(land);
  useEffect(() => {
    if (!go || playing) return;
    const n = moves.length;
    if (n <= shown) return;
    // several moves behind (a live gap): place all but the latest, drop that one
    // oxlint-disable-next-line react/set-state-in-effect -- new rounds from the server step the replay: a live gap places all but the latest at once
    if (n - shown > 1) setShown(n - 1);
    if (still) onLand(n, false);
    else setPlaying({ n, t0: null });
  }, [go, playing, moves.length, shown, still]);

  const seenId = g && g.id;
  useEffect(() => {
    writeSeen(seenId, shown);
  }, [seenId, shown]);

  const skip = () => {
    if (playing) land(playing.n, true);
  };

  // your drop: a click and a buzz at the tap, before the request
  useEffect(() => {
    if (!registerCommit) return;
    registerCommit(() => juice.hit({ sound: "lock", buzz: BUZZ.commit }));
    return () => registerCommit(null);
  }, [registerCommit, juice]);

  const settledN = playing ? playing.n - 1 : shown;
  const discs: Disc[] = useMemo(
    () => moves.slice(0, settledN).map((m: FourInARowMove) => ({ col: m.col, row: m.row, piece: pieceIn(seats, m.by), n: m.n })),
    [moves, settledN, seats]
  );
  const fallMove = playing ? moves[playing.n - 1] : null;
  const fall = fallMove ? { disc: { col: fallMove.col, row: fallMove.row, piece: pieceOf(fallMove.by), n: fallMove.n }, t0: playing!.t0 } : null;
  const showWin = finished && !!g.line && shown === moves.length && !playing;
  const winCells = useMemo(() => new Set<string>(showWin ? (g.line as number[][]).map((c) => c[0] + ":" + c[1]) : []), [showWin, g]);
  const winner = seats.find((s) => s.name === g.winner) || null;
  const you = seats.find((s) => s.you) || null;
  const myTurn = !!(g && g.status === "running" && you && g.turn_of === you.name && !playing);
  const open = useMemo(() => {
    const s = new Set<number>();
    ((g && g.you && g.you.legal_moves) || []).forEach((c: string) => s.add(Number(c)));
    return s;
  }, [g]);
  const home = (a: number, width: number) => c4Home(a, width);
  const first = home(aspect || 1.6, hostW);
  const label =
    "Four in a Row arena, 3D view: " +
    seats.map((s) => s.name + (s.you ? " (you)" : "") + " plays " + (s.piece === "X" ? "solid" : "ringed") + " discs").join("; ") +
    ". " +
    (g.status === "running" ? (g.turn_of ? g.turn_of + " to move, turn " + g.turn + "." : "") : finished ? (g.draw ? "A draw." : g.winner ? g.winner + " won." : "") : "") +
    " " +
    moves.length +
    " discs on the board.";
  const intro = firstVisit ? { title: "Four in a Row", sub: seats.map((s) => s.name).join(" vs ") || "Drop, connect, win", color: "#fb7185" } : null;
  return (
    <JuiceProvider juice={juice}>
      <ArenaFrame
        onReset={() => goHome(ctl, homeRef.current || first, !still)}
        onSize={(width) => setHostW(width)}
        tools={<SoundToggle />}
        frameProps={{
          onPointerDown: (e) => {
            if (playing && !(e.target as HTMLElement).closest("button")) skip();
          },
        }}
        overlay={
          <>
            <ImpactLayer juice={juice} intro={intro} ready={ready} />
            {playing && fallMove ? (
              <div className="duel-catchup" aria-hidden="true">
                Move {fallMove.n} · tap to skip
              </div>
            ) : null}
            <div className="sr-only" aria-live="polite">
              {say}
            </div>
          </>
        }
      >
        <Canvas
          role="img"
          aria-label={label}
          frameloop="demand"
          dpr={q.dpr}
          gl={{ antialias: false, powerPreference: "high-performance" }}
          camera={{ position: first.pos, fov: first.fov, near: 0.1, far: 800 }}
        >
          <FirstFrame
            onReady={() => {
              setReady(true);
              if (onReady) onReady();
            }}
          />
          <Ticker fps={q.ambientFps} />
          <JuiceRig ctl={ctl} reach={0.7} />
          <color attach="background" args={["#05030b"]} />
          <fog attach="fog" args={["#16081a", 18, 70]} />
          <SkyDome spec={C4_SKY} />
          <hemisphereLight args={["#fde2e8", "#08040c", 0.6]} />
          <directionalLight position={[-4, 9, 10]} intensity={1.1} color="#ffe4e6" />
          <Lake />
          <Board still={still} />
          <Discs discs={discs} seats={seats} fall={fall} still={still} winCells={winCells} winT={winT} />
          <WinClock on={showWin} still={still} onValue={setWinT} />
          {showWin && winner && g.line ? <WinBeam line={g.line} hex={winner.hex} t={winT} /> : null}
          {myTurn && onDrop && you ? <Columns open={open} hex={you.hex} onDrop={onDrop} /> : null}
          {playing && fallMove && playing.t0 == null ? <ClockStart key={"c" + playing.n} onStart={(t) => setPlaying((p) => (p && p.t0 == null ? { ...p, t0: t } : p))} /> : null}
          {playing && fallMove && playing.t0 != null ? (
            <Beats
              key={"b" + playing.n}
              t0={playing.t0}
              last={isLast(playing.n)}
              onLand={() => {
                const last = isLast(playing.n);
                juice.hit(landImpact(g, fallMove, seats, last));
                setSay(sayMove(fallMove, last));
                if (last && g.winner && g.line && !q.lite) {
                  const hex = (winner || { hex: "#fb7185" }).hex;
                  (g.line as number[][]).forEach((c) => setFx((l) => [...l.slice(-6), { id: ++fxId.current, at: [cellX(c[0]!), cellY(c[1]!), 0.2], hex }]));
                }
              }}
              onDone={() => {
                const last = isLast(playing.n);
                setPlaying(null);
                setShown(playing.n);
                if (last && g.winner) setCeremony((c) => c + 1);
              }}
            />
          ) : null}
          {fx.map((f) => (
            <Burst key={f.id} at={f.at} hex={f.hex} box={[0.6, 0.6, 0.3]} count={q.lite ? 16 : 28} power={1.5} piece={0.07} dur={1} onDone={() => setFx((l) => l.filter((x) => x.id !== f.id))} />
          ))}
          {ceremony && winner && !still ? (
            <group key={"cer" + ceremony}>
              <LightPillar at={[0, 0, 0.6]} hex={winner.hex} height={14} width={0.9} />
              <Shockwave at={[0, -0.05, 0.6]} hex={winner.hex} radius={14} dur={1.2} />
            </group>
          ) : null}
          <CameraControls ref={ctl} makeDefault minDistance={5} maxDistance={40} maxPolarAngle={Math.PI / 2.05} />
          <TouchControls ctl={ctl} />
          <Framer home={home} ctl={ctl} homeRef={homeRef} />
          <Intro ctl={ctl} homeRef={homeRef} enabled={!!intro && !still} ready={ready} />
          <ArenaPost q={q} bloom={1.0} threshold={0.95} vignette={0.55} />
        </Canvas>
      </ArenaFrame>
    </JuiceProvider>
  );
}
