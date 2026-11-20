/* Liar's Dice in 3D (2026-11-19): the den.

   The world: a round crimson felt table under one warm lamp, a dark room
   around it. Every player has a leather cup in their colour at the table's
   edge (you nearest the camera); a rival's cup stays down over their
   dice - the server never sends them - while yours lies tipped beside
   your dice, face up, for your eyes only. The standing bid floats over the
   middle: a big die showing the face, the count beside it, the bidder's
   name under it. A new bid flips the die and lights the bidder's seat.

   A closed round plays on the juice clock: every cup lifts, then the dice
   that count toward the called face light one at a time while the count
   climbs; the verdict lands (the bid stands, or it was a lie), the
   loser's die shatters, the cups come down and shake for the next roll.
   A turn that ran out skips the reveal: the die just shatters. The last
   round adds the winner's pillar and shockwave. Catch-up, tap to skip and
   reduced motion as in the other arenas. */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { CameraControls } from "@react-three/drei";
import { BoxGeometry, CanvasTexture, Color, Euler, Object3D, Quaternion, SRGBColorSpace, Vector3, type Group, type InstancedMesh, type MeshStandardMaterial } from "three";
import { ArenaFrame, FirstFrame, Framer, Ticker, TouchControls, goHome, useQuality, useReducedMotion, type Ctl, type Home } from "../three/arena3d";
import { ArenaPost, ImpactLayer, Intro, JuiceProvider, JuiceRig, SoundToggle, useFirstVisit, useJuice, useJuiceStore, type Impact } from "../three/juice";
import { Burst, LightPillar, Shockwave, SkyDome, type SkySpec } from "../three/atmos";
import { BUZZ, sfx } from "../three/sfx";

const LD_SKY: SkySpec = {
  top: "#040203",
  mid: "#0d0506",
  horizon: "#26090d",
  ground: "#040203",
  glow: "#f59e0b",
  glowAmt: 0.14,
  stars: 0,
};

const PHONE_BELOW = 560;
const AX = new Vector3();
const TABLE_R = 3.3;
const SEAT_R = 2.45;
const DIE = 0.19;
const BID_Y = 1.35;
const ANTIC = 0.25;
const LIFT = 0.5; // the cups' rise
const MAX_DICE = 6 * 6 + 1;

type Seat = { name: string; hex: string; you: boolean; x: number; z: number; a: number };

const smooth = (a: number, b: number, t: number) => {
  const x = Math.min(1, Math.max(0, (t - a) / (b - a)));
  return x * x * (3 - 2 * x);
};
const WORD = ["", "one", "two", "three", "four", "five", "six"];
const faceWord = (f: number, plural: boolean) => (plural ? (f === 6 ? "sixes" : (WORD[f] || f) + "s") : WORD[f] || String(f));
const bidText = (b: any) => b.qty + " " + faceWord(b.face, b.qty !== 1);
const counts = (d: number, face: number, wild: boolean) => d === face || (wild && d === 1 && face !== 1);

/* ---------- the dice: one atlas, one geometry, one instanced draw ---------- */

// pips per face on a 3x3 grid, [row, col]
const PIPS: Record<number, [number, number][]> = {
  1: [[1, 1]],
  2: [[0, 2], [2, 0]],
  3: [[0, 2], [1, 1], [2, 0]],
  4: [[0, 0], [0, 2], [2, 0], [2, 2]],
  5: [[0, 0], [0, 2], [1, 1], [2, 0], [2, 2]],
  6: [[0, 0], [0, 2], [1, 0], [1, 2], [2, 0], [2, 2]],
};
let atlas: CanvasTexture | null = null;
function diceAtlas(): CanvasTexture {
  if (atlas) return atlas;
  const S = 128;
  const c = document.createElement("canvas");
  c.width = S * 3;
  c.height = S * 2;
  const x = c.getContext("2d");
  if (x) {
    for (let f = 1; f <= 6; f++) {
      const col = (f - 1) % 3;
      const row = Math.floor((f - 1) / 3);
      const ox = col * S;
      const oy = row * S;
      x.fillStyle = "#f5f1e8";
      x.fillRect(ox, oy, S, S);
      x.strokeStyle = "rgba(0,0,0,0.25)";
      x.lineWidth = 6;
      x.strokeRect(ox + 3, oy + 3, S - 6, S - 6);
      x.fillStyle = f === 1 ? "#b91c1c" : "#111827";
      (PIPS[f] || []).forEach(([r, cc]) => {
        x.beginPath();
        x.arc(ox + S * (0.25 + cc * 0.25), oy + S * (0.25 + r * 0.25), f === 1 ? S * 0.12 : S * 0.09, 0, Math.PI * 2);
        x.fill();
      });
    }
  }
  atlas = new CanvasTexture(c);
  atlas.colorSpace = SRGBColorSpace;
  return atlas;
}
// BoxGeometry faces are +x, -x, +y, -y, +z, -z; opposite faces sum to 7
const SIDE_VALUE = [3, 4, 1, 6, 2, 5];
let dieGeo: BoxGeometry | null = null;
function diceGeometry(): BoxGeometry {
  if (dieGeo) return dieGeo;
  const g = new BoxGeometry(1, 1, 1);
  const uv = g.getAttribute("uv");
  for (let side = 0; side < 6; side++) {
    const v = (SIDE_VALUE[side] || 1) - 1;
    const col = v % 3;
    const row = Math.floor(v / 3);
    for (let k = 0; k < 4; k++) {
      const i = side * 4 + k;
      // canvas rows run down; texture v runs up
      uv.setXY(i, (col + uv.getX(i)) / 3, 1 - (row + 1 - uv.getY(i)) / 2);
    }
  }
  uv.needsUpdate = true;
  dieGeo = g;
  return g;
}
// the rotation that puts face f on top
function faceUp(f: number, spin: number): [number, number, number] {
  switch (f) {
    case 6:
      return [Math.PI, spin, 0];
    case 2:
      return [-Math.PI / 2, 0, spin];
    case 5:
      return [Math.PI / 2, 0, spin];
    case 3:
      return [spin, 0, Math.PI / 2];
    case 4:
      return [spin, 0, -Math.PI / 2];
    default:
      return [0, spin, 0];
  }
}

// tilt: turn the top face toward the camera, about the (horizontal) axis
type DieSpec = { x: number; y: number; z: number; f: number; s: number; spin: number; tint: "plain" | "hit" | "dim" | "wild"; tilt?: { axis: [number, number, number]; by: number } };
const TINTS: Record<DieSpec["tint"], Color> = {
  plain: new Color(1, 1, 1),
  hit: new Color(2.2, 0.75, 0.7),
  dim: new Color(0.35, 0.33, 0.33),
  wild: new Color(1.25, 1.05, 0.55),
};

function Dice({ list }: { list: DieSpec[] }) {
  const ref = useRef<InstancedMesh>(null);
  const geo = useMemo(() => diceGeometry(), []);
  const map = useMemo(() => diceAtlas(), []);
  useEffect(() => {
    const m = ref.current;
    if (!m) return;
    const o = new Object3D();
    const qt = new Quaternion();
    const qf = new Quaternion();
    const ax = new Vector3();
    list.slice(0, MAX_DICE).forEach((d, i) => {
      o.position.set(d.x, d.y, d.z);
      const [rx, ry, rz] = faceUp(d.f, d.spin);
      qf.setFromEuler(new Euler(rx, ry, rz));
      if (d.tilt) {
        qt.setFromAxisAngle(ax.set(...d.tilt.axis).normalize(), d.tilt.by);
        o.quaternion.copy(qt.multiply(qf));
      } else o.quaternion.copy(qf);
      o.scale.setScalar(d.s);
      o.updateMatrix();
      m.setMatrixAt(i, o.matrix);
      m.setColorAt(i, TINTS[d.tint]);
    });
    m.count = Math.min(MAX_DICE, list.length);
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
  }, [list]);
  return (
    <instancedMesh ref={ref} args={[geo, undefined, MAX_DICE]} frustumCulled={false}>
      <meshStandardMaterial map={map} roughness={0.45} metalness={0.05} toneMapped={false} />
    </instancedMesh>
  );
}

/* ---------- labels ---------- */

const texCache = new Map<string, CanvasTexture>();
function textTex(lines: { text: string; color: string; size: number }[], w = 320, h = 128): CanvasTexture {
  const key = w + "x" + h + ":" + lines.map((l) => l.text + "|" + l.color + "|" + l.size).join("/");
  const hit = texCache.get(key);
  if (hit) return hit;
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const x = c.getContext("2d");
  if (x) {
    x.textAlign = "center";
    x.textBaseline = "middle";
    x.shadowColor = "rgba(0,0,0,0.85)";
    x.shadowBlur = 8;
    const total = lines.reduce((s, l) => s + l.size * 1.15, 0);
    let y = h / 2 - total / 2;
    lines.forEach((l) => {
      x.font = "800 " + l.size + "px system-ui, -apple-system, Segoe UI, sans-serif";
      x.fillStyle = l.color;
      let t = l.text;
      while (x.measureText(t).width > w - 16 && t.length > 4) t = t.slice(0, -2);
      if (t !== l.text) t = t.slice(0, -1) + "…";
      y += (l.size * 1.15) / 2;
      x.fillText(t, w / 2, y);
      y += (l.size * 1.15) / 2;
    });
  }
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  texCache.set(key, t);
  return t;
}

/* ---------- the table ---------- */

function Table() {
  return (
    <group>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.9, 0]}>
        <planeGeometry args={[200, 200]} />
        <meshStandardMaterial color="#0b0606" roughness={0.8} />
      </mesh>
      <mesh position={[0, -0.45, 0]}>
        <cylinderGeometry args={[TABLE_R, TABLE_R * 0.92, 0.9, 64]} />
        <meshStandardMaterial color="#2a1208" roughness={0.6} metalness={0.15} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.002, 0]}>
        <circleGeometry args={[TABLE_R - 0.12, 64]} />
        <meshStandardMaterial color="#5c1019" roughness={0.95} />
      </mesh>
      <mesh rotation={[Math.PI / 2, 0, 0]} position={[0, 0.02, 0]}>
        <torusGeometry args={[TABLE_R - 0.06, 0.07, 10, 96]} />
        <meshStandardMaterial color="#3b1a0c" roughness={0.4} metalness={0.3} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.006, 0]}>
        <ringGeometry args={[1.2, 1.24, 64]} />
        <meshBasicMaterial color={new Color("#f59e0b").multiplyScalar(0.9)} toneMapped={false} transparent opacity={0.55} />
      </mesh>
    </group>
  );
}

/* A leather cup: open end down. `lift` raises and tilts it (0..1);
   `tipped` lays it on its side beside the dice (your own cup). */
function Cup({ seat, lift, tipped, turn, out, shake, still, aside = 0.62 }: { seat: Seat; lift: number; tipped: boolean; turn: boolean; out: boolean; shake: number; still: boolean; aside?: number }) {
  const g = useRef<Group>(null);
  const ring = useRef<MeshStandardMaterial>(null);
  const j = useJuice();
  // tangent (along the table edge) and outward directions
  const tx = -Math.sin(seat.a);
  const tz = Math.cos(seat.a);
  useFrame(() => {
    const o = g.current;
    if (!o) return;
    const wob = shake > 0 && !still ? Math.sin(j.t * 38) * 0.12 * shake : 0;
    if (tipped || out) {
      o.position.set(seat.x + tx * aside, 0.2, seat.z + tz * aside);
      o.rotation.set(0, -seat.a, Math.PI / 2.2);
    } else {
      // lifted, a cup slides aside along the table's edge and tips away,
      // so it never stands between the camera and the dice
      o.position.set(seat.x + tx * (wob * 0.4 + lift * 1.05), 0.31 + lift * 0.55, seat.z + tz * lift * 1.05);
      o.quaternion.setFromAxisAngle(AX.set(Math.cos(seat.a), 0, Math.sin(seat.a)), lift * 0.55 + wob);
    }
    if (ring.current) ring.current.emissiveIntensity = turn ? 1.2 + (still ? 0 : 0.6 * Math.sin(j.t * 4)) : 0.25;
  });
  const col = useMemo(() => new Color(seat.hex).multiplyScalar(0.45), [seat.hex]);
  return (
    <group>
      <group ref={g}>
        <mesh>
          <cylinderGeometry args={[0.32, 0.42, 0.62, 28, 1, true]} />
          <meshStandardMaterial color={out ? "#2a2a2a" : col} roughness={0.7} side={2} />
        </mesh>
        <mesh position={[0, 0.31, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <circleGeometry args={[0.32, 28]} />
          <meshStandardMaterial color={out ? "#2a2a2a" : col} roughness={0.7} />
        </mesh>
        <mesh position={[0, -0.24, 0]} rotation={[Math.PI / 2, 0, 0]}>
          <torusGeometry args={[0.41, 0.025, 8, 32]} />
          <meshStandardMaterial color="#000" emissive={seat.hex} emissiveIntensity={0.5} toneMapped={false} />
        </mesh>
      </group>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[seat.x, 0.008, seat.z]}>
        <ringGeometry args={[0.5, 0.58, 40]} />
        <meshStandardMaterial ref={ring} color="#000" emissive={seat.hex} emissiveIntensity={0.25} toneMapped={false} />
      </mesh>
    </group>
  );
}

/* Where a seat's dice sit: two rows of three under the cup; your own
   face up in one row, nearer the table's edge. */
const MINE = 1.6; // your dice, scaled
const REVEAL = 1.4; // every cup's dice, opened
function dieSpot(seat: Seat, i: number, mine: boolean, n = 5, scale = MINE): [number, number, number] {
  const tx = -Math.sin(seat.a);
  const tz = Math.cos(seat.a);
  const ox = Math.cos(seat.a);
  const oz = Math.sin(seat.a);
  if (mine) {
    const gap = DIE * scale * 1.3;
    const k = (n - 1) / 2 - i; // left to right as you face the table
    return [seat.x + tx * k * gap + ox * 0.3, (DIE * scale) / 2 + 0.005, seat.z + tz * k * gap + oz * 0.3];
  }
  const gap = DIE * 1.12;
  const col = (i % 3) - 1;
  const row = Math.floor(i / 3) - 0.5;
  return [seat.x + tx * col * gap + ox * row * gap, DIE / 2 + 0.005, seat.z + tz * col * gap + oz * row * gap];
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

type Plan = { lifted: boolean; hits: number; step: number; countAt: number; verdictAt: number; breakAt: number; downAt: number; doneAt: number };
function planOf(r: any, wild: boolean, last: boolean): Plan {
  const lifted = r.reason === "call" && !!r.call;
  let hits = 0;
  if (lifted) {
    const f = r.call.bid.face;
    Object.keys(r.cups || {}).forEach((n) => ((r.cups[n] || []) as number[]).forEach((d) => (hits += counts(d, f, wild) ? 1 : 0)));
  }
  const step = Math.min(0.26, 1.8 / Math.max(1, hits));
  const countAt = ANTIC + (lifted ? LIFT + 0.25 : 0);
  const verdictAt = countAt + hits * step + (lifted ? 0.3 : 0);
  const breakAt = verdictAt + 0.45;
  const downAt = breakAt + (lifted ? 0.9 : 0.4);
  return { lifted, hits, step, countAt, verdictAt, breakAt, downAt, doneAt: downAt + (last ? 1.6 : 0.6) };
}

function Beats({ t0, plan, onT, onBeat, onDone }: { t0: number; plan: Plan; onT: (t: number) => void; onBeat: (k: string) => void; onDone: () => void }) {
  const j = useJuice();
  const fired = useRef(new Set<string>());
  const last = useRef(-1);
  useFrame((state) => {
    const t = j.t - t0;
    state.invalidate();
    const q = Math.round(t * 30) / 30;
    if (q !== last.current) {
      last.current = q;
      onT(t);
    }
    const once = (k: string, at: number) => {
      if (t >= at && !fired.current.has(k)) {
        fired.current.add(k);
        onBeat(k);
      }
    };
    if (plan.lifted) once("lift", ANTIC);
    for (let i = 0; i < plan.hits; i++) once("h" + i, plan.countAt + i * plan.step);
    once("verdict", plan.verdictAt);
    once("break", plan.breakAt);
    once("down", plan.downAt);
    if (t >= plan.doneAt && !fired.current.has("done")) {
      fired.current.add("done");
      onDone();
    }
  });
  return null;
}

/* ---------- impacts from the viewer's seat ---------- */

function roundImpact(r: any, me: string): Impact {
  const lost = r.loser === me;
  const out = !!r.out;
  if (r.reason !== "call" || !r.call) {
    if (lost) return { trauma: 0.4, stop: 110, buzz: out ? BUZZ.lostOne : BUZZ.hitYou, sound: ["buzzer", "shatter"], title: { big: out ? "OUT" : "TIME", small: "Your turn ran out - you lose a die", tone: "bad" } };
    return { trauma: 0.15, sound: "shatter", title: { big: "TIME", small: r.loser + "'s turn ran out - " + (out ? r.loser + " is out" : "they lose a die"), tone: "neutral" } };
  }
  const bid = r.call.bid;
  const what = "Liar on " + bid.by + "'s " + bidText(bid) + " - the table showed " + r.count;
  const caller = r.call.by === me;
  const bidder = bid.by === me;
  if (lost) return { trauma: out ? 0.6 : 0.4, stop: out ? 180 : 120, buzz: out ? BUZZ.lostOne : BUZZ.hitYou, sound: ["smash", "shatter"], title: { big: out ? "OUT" : caller ? "WRONG CALL" : "CAUGHT", small: what, tone: "bad" } };
  if (caller) return { trauma: 0.3, stop: 90, pulse: 0.5, buzz: BUZZ.scored, sound: ["smash", "win"], title: { big: "LIAR!", small: what + " - " + r.loser + (out ? " is out" : " loses a die"), tone: "good" } };
  if (bidder) return { trauma: 0.3, stop: 90, pulse: 0.5, buzz: BUZZ.scored, sound: ["smash", "win"], title: { big: "IT STANDS", small: what + " - " + r.loser + (out ? " is out" : " loses a die"), tone: "good" } };
  return { trauma: 0.2, stop: 70, sound: ["smash", "shatter"], title: { big: r.stands ? "IT STANDS" : "LIAR!", small: what + " - " + r.loser + (out ? " is out" : " loses a die"), tone: "neutral" } };
}

function finalImpact(g: any, me: string, many: boolean): Impact {
  const w = g.winner as string | null;
  const line = (g.places || []).join(" · ");
  if (!w) return { trauma: 0.3, stop: 120, sound: "whoosh", title: { big: "OVER", small: line, tone: "neutral" } };
  if (me && me === w) return { trauma: 0.8, stop: 250, slow: 0.8, pulse: 1, buzz: BUZZ.wonMatch, sound: ["clash", "win"], title: { big: "VICTORY", small: "Last with dice · " + line, tone: "good" } };
  if (me && (g.players || []).some((p: any) => p.name === me)) {
    const place = (g.places || []).indexOf(me) + 1;
    if (place === 2 && many) return { trauma: 0.4, stop: 150, buzz: BUZZ.scored, sound: "win", title: { big: "#2", small: w + " is the last with dice · " + line, tone: "neutral" } };
    return { trauma: 0.8, stop: 250, slow: 0.8, pulse: 0.8, buzz: BUZZ.lostMatch, sound: ["clash", "lose"], title: { big: "DEFEAT", small: w + " is the last with dice", tone: "bad" } };
  }
  return { trauma: 0.6, stop: 200, slow: 0.6, pulse: 0.8, buzz: BUZZ.scored, sound: ["clash", "win"], title: { big: w.toUpperCase() + " WINS", small: line, tone: "neutral" } };
}

function sayRound(r: any): string {
  if (!r) return "";
  if (r.reason !== "call" || !r.call) return "Round " + r.n + ": " + r.loser + "'s turn ran out; " + r.loser + (r.out ? " is out." : " loses a die.");
  return "Round " + r.n + ": " + r.call.by + " called liar on " + r.call.bid.by + "'s " + bidText(r.call.bid) + ". The table showed " + r.count + "; " + r.loser + (r.out ? " is out." : " loses a die.");
}

/* ---------- what the viewer has seen ---------- */

function seenKey(id: unknown): string {
  let path = "";
  try {
    path = location.pathname;
  } catch {
    path = "";
  }
  return "ac-ld-seen:" + path + ":" + String(id);
}
function readSeen(id: unknown): number | null {
  try {
    const v = localStorage.getItem(seenKey(id));
    return v == null ? null : Number(v) || 0;
  } catch {
    return null;
  }
}
function writeSeen(id: unknown, n: number) {
  try {
    localStorage.setItem(seenKey(id), String(n));
  } catch {
    // storage unavailable: the next open just won't replay
  }
}

/* Home: the whole table and the bid over it; the pitch centres the
   content's vertical extent for each distance, the distance is the
   closest that fits. */
function ldHome(aspect: number, width: number): Home {
  const phone = width < PHONE_BELOW;
  const vfov = aspect < 1 ? 56 : 46;
  const tv = Math.tan((vfov * Math.PI) / 360);
  const th = tv * Math.max(0.45, aspect);
  const el = ((phone ? 44 : 38) * Math.PI) / 180;
  const pts: [number, number, number][] = [
    [0, BID_Y + 0.9, 0],
    [-TABLE_R, 0, 0],
    [TABLE_R, 0, 0],
    [0, 0, -TABLE_R],
    [0, -0.2, TABLE_R + 0.15],
    [0, phone ? -0.6 : -0.45, SEAT_R + 1.0],
    [-TABLE_R * 0.7, 0, TABLE_R * 0.7],
    [TABLE_R * 0.7, 0, TABLE_R * 0.7],
  ];
  const fz = 0.3;
  const at = (d: number) => {
    const cy = d * Math.sin(el);
    const cz = fz + d * Math.cos(el);
    const angs = pts.map(([, y, z]) => Math.atan2(cy - y, cz - z));
    return { cy, cz, pitch: (Math.max(...angs) + Math.min(...angs)) / 2 - 0.06 * Math.atan(tv) };
  };
  const fits = (d: number) => {
    const { cy, cz, pitch } = at(d);
    const dy = -Math.sin(pitch);
    const dz = -Math.cos(pitch);
    return pts.every(([x, y, z]) => {
      const vy = y - cy;
      const vz = z - cz;
      const zc = vy * dy + vz * dz;
      if (zc <= 0.1) return false;
      const yc = vy * -dz + vz * dy;
      const v = yc / (zc * tv);
      return Math.abs(x / (zc * th)) <= 0.95 && v <= 0.84 && v >= -0.95;
    });
  };
  let lo = 2;
  let hi = 60;
  for (let k = 0; k < 28; k++) {
    const mid = (lo + hi) / 2;
    if (fits(mid)) hi = mid;
    else lo = mid;
  }
  const { cy, cz, pitch } = at(hi);
  return { pos: [0, cy, cz], fov: vfov, tz: cz - cy / Math.tan(pitch) };
}

/* The standing bid over the table: a big die (it flips when the bid
   changes), the count, and who bid it. */
function BidMark({ bid, opener, big, still, over }: { bid: any; opener: string | null; big: boolean; still: boolean; over?: string }) {
  // tip the top face toward the camera's elevation
  const tilt = big ? 0.8 : 0.9;
  const g = useRef<Group>(null);
  const j = useJuice();
  const flipAt = useRef<number | null>(null);
  const sig = bid ? bid.qty + "x" + bid.face + bid.by : "";
  useEffect(() => {
    flipAt.current = null;
  }, [sig]);
  useFrame((state) => {
    const o = g.current;
    if (!o) return;
    if (flipAt.current == null) flipAt.current = j.t;
    const k = still ? 1 : smooth(0, 0.55, j.t - flipAt.current);
    if (k < 1) state.invalidate();
    const [rx, ry, rz] = faceUp(bid ? bid.face : 1, 0);
    const inner = o.children[0];
    if (inner) inner.rotation.set(rx, ry, rz);
    o.rotation.set(tilt + (1 - k) * Math.PI * 2, still ? 0 : Math.sin(j.t * 0.8) * 0.22, 0);
    o.position.y = BID_Y + (1 - k) * 0.5;
  });
  const geo = useMemo(() => diceGeometry(), []);
  const map = useMemo(() => diceAtlas(), []);
  if (!bid) {
    return (
      <sprite position={[0, BID_Y, 0]} scale={big ? [3.6, 0.9, 1] : [3, 0.75, 1]} renderOrder={5}>
        <spriteMaterial map={textTex([{ text: over || (opener ? opener + " opens" : "No bid yet"), color: "#fde68a", size: 40 }], 480, 120)} transparent depthWrite={false} depthTest={false} />
      </sprite>
    );
  }
  return (
    <group>
      <group ref={g} position={[0.35, BID_Y, 0]}>
        <group>
          <mesh geometry={geo} scale={0.62}>
            <meshStandardMaterial map={map} roughness={0.4} toneMapped={false} emissive="#fff7ed" emissiveIntensity={0.12} />
          </mesh>
        </group>
      </group>
      <sprite position={[-0.55, BID_Y, 0]} scale={[1.1, 0.75, 1]} renderOrder={5}>
        <spriteMaterial map={textTex([{ text: bid.qty + " ×", color: "#ffffff", size: 78 }], 200, 136)} transparent depthWrite={false} depthTest={false} />
      </sprite>
      <sprite position={[0, BID_Y - 0.62, 0]} scale={big ? [2.6, 0.62, 1] : [2.1, 0.5, 1]} renderOrder={5}>
        <spriteMaterial map={textTex([{ text: "by " + bid.by, color: "#fecaca", size: 38 }], 400, 96)} transparent depthWrite={false} depthTest={false} />
      </sprite>
    </group>
  );
}

/* ---------- the arena ---------- */

export default function LiarsArena3D({
  g,
  me = "",
  aspect,
  onReady,
  registerCommit,
}: {
  g: any;
  me?: string;
  aspect?: number;
  onReady?: () => void;
  registerCommit?: (fn: (() => void) | null) => void;
}) {
  const still = useReducedMotion();
  const q = useQuality(still);
  const juice = useJuiceStore(still);
  const firstVisit = useFirstVisit("ld:" + String((g && g.id) || ""));
  const [ready, setReady] = useState(false);
  const ctl = useRef<Ctl | null>(null);
  const homeRef = useRef<Home | null>(null);
  const [hostW, setHostW] = useState(() => (aspect && aspect < 1.4 ? 390 : 760));
  const meL = me.toLowerCase();
  const players: any[] = (g && g.players) || [];
  const rounds: any[] = (g && g.rounds) || [];
  const finished = !!g && g.status === "finished";
  const running = !!g && g.status === "running";
  const wild = !!(g && g.ones_wild);
  const meName = (players.find((p) => String(p.name).toLowerCase() === meL) || {}).name || "";
  const big = hostW < PHONE_BELOW;

  // seats round the table in turn order, you nearest the camera
  const seats: Seat[] = useMemo(() => {
    const order: string[] = (g && g.order) || [];
    const list = players.slice().sort((a, b) => {
      const ia = order.indexOf(a.name);
      const ib = order.indexOf(b.name);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });
    const n = list.length;
    const mine = list.findIndex((p) => String(p.name).toLowerCase() === meL);
    return list.map((p: any, i: number) => {
      const a = Math.PI / 2 + ((i - (mine >= 0 ? mine : 0)) / Math.max(1, n)) * Math.PI * 2;
      return { name: String(p.name), hex: String(p.hex || "#ef4444"), you: String(p.name).toLowerCase() === meL, x: Math.cos(a) * SEAT_R, z: Math.sin(a) * SEAT_R, a };
    });
  }, [players, meL, g]);

  const [init] = useState(() => {
    const n = rounds.length;
    const seen = readSeen(g && g.id);
    if (seen == null || !n || seen >= n) return { shown: n };
    return { shown: n - 1 };
  });
  const [shown, setShown] = useState(init.shown);
  const [playing, setPlaying] = useState<{ n: number; t0: number | null } | null>(null);
  const [go, setGo] = useState(false);
  const [rt, setRt] = useState(0);
  const [lit, setLit] = useState(0);
  const [broke, setBroke] = useState(false);
  const [fx, setFx] = useState<{ id: number; at: [number, number, number]; hex: string }[]>([]);
  const fxId = useRef(0);
  const [ceremony, setCeremony] = useState(0);
  const [say, setSay] = useState("");
  const [shakeUntil, setShakeUntil] = useState(0);

  useEffect(() => {
    if (!ready || go) return;
    const t = setTimeout(() => setGo(true), firstVisit && !still ? 2600 : 400);
    return () => clearTimeout(t);
  }, [ready, go, firstVisit, still]);

  const isLast = (n: number) => finished && n === rounds.length;
  const land = (n: number, quiet: boolean) => {
    const r = rounds[n - 1];
    setPlaying(null);
    setLit(0);
    setBroke(false);
    setShown(n);
    if (!r) return;
    const imp = isLast(n) ? finalImpact(g, meName, players.length > 2) : roundImpact(r, meName);
    juice.hit(quiet ? { ...imp, trauma: 0, stop: 0, slow: 0, pulse: 0 } : imp);
    setSay(sayRound(r));
    if (isLast(n) && g.winner) setCeremony((c) => c + 1);
  };

  useEffect(() => {
    if (!go || playing) return;
    const n = rounds.length;
    if (n <= shown) return;
    if (still) land(n, false);
    else {
      setRt(0);
      setLit(0);
      setBroke(false);
      setPlaying({ n, t0: null });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [go, playing, rounds.length, shown, still]);

  useEffect(() => {
    writeSeen(g && g.id, shown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown]);

  const skip = () => {
    if (playing) land(playing.n, true);
  };

  useEffect(() => {
    if (!registerCommit) return;
    registerCommit(() => juice.hit({ sound: "lock", buzz: BUZZ.commit }));
    return () => registerCommit(null);
  }, [registerCommit, juice]);

  // a rival's new bid: a soft ping (the die flips on its own)
  const bidSig = g && g.bid ? g.bid.qty + "x" + g.bid.face + g.bid.by : "";
  const prevBid = useRef<string | null>(null);
  useEffect(() => {
    const prev = prevBid.current;
    prevBid.current = bidSig;
    if (prev == null || !ready || !bidSig || prev === bidSig) return;
    if (g.bid.by !== meName) juice.hit({ sound: "ping" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bidSig, ready]);

  const r = playing ? rounds[playing.n - 1] : null;
  const plan = useMemo(() => (r ? planOf(r, wild, isLast(playing!.n)) : null), [r, wild]); // eslint-disable-line react-hooks/exhaustive-deps
  const lift = r && plan && plan.lifted ? smooth(ANTIC, ANTIC + LIFT, rt) * (1 - smooth(plan.downAt, plan.downAt + 0.45, rt)) : 0;

  // dice counts as the scene shows them: the round's cups while it plays
  // (until the loser's die breaks), the live counts otherwise
  const countOf = (name: string): number => {
    if (r) {
      const n0 = ((r.cups || {})[name] || []).length;
      return broke && name === r.loser ? Math.max(0, n0 - 1) : n0;
    }
    return ((players.find((p) => p.name === name) || {}).dice as number) || 0;
  };
  const outOf = (name: string): boolean => {
    if (r) return countOf(name) === 0;
    return !!(players.find((p) => p.name === name) || {}).out;
  };

  const diceList: DieSpec[] = useMemo(() => {
    const list: DieSpec[] = [];
    if (r) {
      const face = r.call ? r.call.bid.face : 0;
      let hitIdx = 0;
      seats.forEach((s) => {
        const cup: number[] = (r.cups || {})[s.name] || [];
        const n = countOf(s.name);
        cup.slice(0, n).forEach((d, i) => {
          const [x, y, z] = dieSpot(s, i, true, cup.length, REVEAL);
          let tint: DieSpec["tint"] = "plain";
          if (face) {
            if (counts(d, face, wild)) tint = hitIdx++ < lit ? "hit" : "plain";
            else tint = lit > 0 ? "dim" : "plain";
          }
          list.push({ x, y: y + DIE * REVEAL * 0.2, z, f: d, s: DIE * REVEAL, spin: 0, tint, tilt: { axis: [1, 0, 0], by: 0.75 } });
        });
      });
    } else if (running && g.you && g.you.playing && !g.you.out) {
      const s = seats.find((x) => x.you);
      const mine = (g.you.dice || []) as number[];
      if (s) mine.forEach((d, i) => {
        const [x, y, z] = dieSpot(s, i, true, mine.length);
        // lean each die's top toward the camera (about the table's edge)
        list.push({ x, y: y + DIE * MINE * 0.2, z, f: d, s: DIE * MINE, spin: 0, tint: wild && d === 1 ? "wild" : "plain", tilt: { axis: [-Math.sin(s.a), 0, Math.cos(s.a)], by: -0.75 } });
      });
    }
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [r, seats, lit, broke, running, g, wild]);

  const shownBid = r ? (r.call ? r.call.bid : null) : running ? g.bid : null;
  const opener = !r && running && !g.bid ? g.turn_of : null;
  const countNow = r && plan ? Math.min(lit, plan.hits) : 0;
  const champion = finished && g.winner ? seats.find((s) => s.name === g.winner) || null : null;
  const home = (a: number, width: number) => ldHome(a, width);
  const first = home(aspect || 1.6, hostW);
  /* A seat's latest bid this round (the page's table listed it; the seat
     plate carries it now). */
  const lastBidOf = (name: string): any => {
    if (!running || r) return null;
    const mine = ((g.bids || []) as any[]).filter((b) => b && b.by === name);
    return mine.length ? mine[mine.length - 1] : null;
  };
  const myDice: number[] = running && g.you && g.you.playing && !g.you.out ? ((g.you.dice || []) as number[]) : [];
  const wildNote = !!(running && !r && g.ones_wild && myDice.indexOf(1) >= 0);
  const label =
    "Liar's Dice table, 3D view: " +
    (myDice.length ? "your cup holds " + myDice.join(", ") + (wildNote ? " (your ones are wild)" : "") + (running ? "; " : ". ") : "") +
    (running ? (g.bid ? "the standing bid is " + bidText(g.bid) + " by " + g.bid.by + ". " : (g.turn_of || "someone") + " opens round " + g.round + ". ") : "") +
    seats.map((s) => s.name + (s.you ? " (you)" : "") + " " + countOf(s.name) + (countOf(s.name) === 1 ? " die" : " dice") + (outOf(s.name) ? ", out" : running && g.turn_of === s.name ? ", to bid" : "")).join("; ") +
    ".";
  const intro = firstVisit ? { title: "Liar's Dice", sub: seats.map((s) => s.name).join(" · ") || "Raise or call", color: "#ef4444" } : null;
  const shake = shakeUntil > 0 ? 1 : 0;
  useEffect(() => {
    if (!shakeUntil) return;
    const t = setTimeout(() => setShakeUntil(0), 650);
    return () => clearTimeout(t);
  }, [shakeUntil]);
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
            {playing && r ? (
              <div className="duel-catchup" aria-hidden="true">
                Round {r.n} · tap to skip
              </div>
            ) : wildNote ? (
              <div className="arena3d-caption ld-caption">Your ones are wild - they count toward any face.</div>
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
          <JuiceRig ctl={ctl} reach={0.8} />
          <color attach="background" args={["#040203"]} />
          <fog attach="fog" args={["#0d0506", 18, 60]} />
          <SkyDome spec={LD_SKY} />
          <hemisphereLight args={["#ffe4c4", "#0a0404", 0.45]} />
          <directionalLight position={[-3, 8, 6]} intensity={0.7} color="#ffedd5" />
          <spotLight position={[0, 8, 0.6]} angle={0.5} penumbra={0.7} intensity={45} distance={16} color="#ffd8a8" />
          <Table />
          {seats.map((s) => (
            <Cup key={s.name} seat={s} aside={s.you ? ((((g.you && g.you.dice) || []).length || 5) / 2) * DIE * MINE * 1.3 + 0.5 : 0.62} lift={s.you && !r ? 0 : lift} tipped={s.you && !r && running && !outOf(s.name)} turn={running && !r && g.turn_of === s.name} out={outOf(s.name)} shake={shake} still={still} />
          ))}
          <Dice list={diceList} />
          {seats.map((s) => {
            const n = countOf(s.name);
            const out = outOf(s.name);
            const ox = Math.cos(s.a);
            const oz = Math.sin(s.a);
            const turn = running && !r && g.turn_of === s.name;
            return (
              <sprite key={"p" + s.name} position={s.you ? [s.x + ox * 1.0, 0.05, s.z + oz * 1.0] : [s.x, 1.15, s.z]} scale={big ? [2.6, 1.04, 1] : s.you ? [1.8, 0.72, 1] : [2.1, 0.84, 1]} renderOrder={5}>
                <spriteMaterial
                  map={textTex([
                    { text: s.name + (s.you ? " (you)" : ""), color: s.hex, size: 42 },
                    { text: out ? "out" : n + (n === 1 ? " die" : " dice") + (turn ? " · to bid" : lastBidOf(s.name) ? " · bid " + bidText(lastBidOf(s.name)) : ""), color: turn ? "#fde68a" : "rgba(254,226,226,0.92)", size: 32 },
                  ])}
                  transparent
                  depthWrite={false}
                  depthTest={false}
                />
              </sprite>
            );
          })}
          {r && plan && plan.lifted ? (
            <group>
              <BidMark bid={shownBid} opener={null} big={big} still={still} />
              {lit > 0 ? (
                <sprite position={[0, BID_Y + 0.85, 0]} scale={big ? [2.6, 0.9, 1] : [2.1, 0.72, 1]} renderOrder={6}>
                  <spriteMaterial map={textTex([{ text: countNow + " of " + r.call.bid.qty, color: rt >= plan.verdictAt ? (r.stands ? "#86efac" : "#fca5a5") : "#ffffff", size: 64 }], 360, 124)} transparent depthWrite={false} depthTest={false} />
                </sprite>
              ) : null}
            </group>
          ) : (
            <BidMark bid={shownBid} opener={opener} big={big} still={still} over={finished ? (g.winner ? "★ " + g.winner + " wins" : "Game over") : undefined} />
          )}
          {playing && r && playing.t0 == null ? <ClockStart key={"c" + playing.n} onStart={(t) => setPlaying((p) => (p && p.t0 == null ? { ...p, t0: t } : p))} /> : null}
          {playing && r && plan && playing.t0 != null ? (
            <Beats
              key={"b" + playing.n}
              t0={playing.t0}
              plan={plan}
              onT={setRt}
              onBeat={(k) => {
                if (k === "lift") sfx("whoosh");
                else if (k[0] === "h") {
                  setLit((n) => n + 1);
                  sfx("beat");
                } else if (k === "verdict") {
                  juice.hit(roundImpact(r, meName));
                  setSay(sayRound(r));
                } else if (k === "break") {
                  setBroke(true);
                  const s = seats.find((x) => x.name === r.loser);
                  const n0 = ((r.cups || {})[r.loser] || []).length;
                  if (s && n0 > 0 && !q.lite) {
                    const at = dieSpot(s, n0 - 1, true, n0, REVEAL);
                    setFx((l) => [...l.slice(-4), { id: ++fxId.current, at, hex: s.hex }]);
                  }
                } else if (k === "down") {
                  if (isLast(playing.n)) {
                    juice.hit(finalImpact(g, meName, players.length > 2));
                    if (g.winner) setCeremony((c) => c + 1);
                  } else setShakeUntil(Date.now());
                }
              }}
              onDone={() => {
                setPlaying(null);
                setLit(0);
                setBroke(false);
                setShown(playing.n);
              }}
            />
          ) : null}
          {fx.map((f) => (
            <Burst key={f.id} at={f.at} hex={f.hex} box={[0.25, 0.25, 0.25]} count={q.lite ? 14 : 26} power={1.4} piece={0.05} dur={0.9} onDone={() => setFx((l) => l.filter((x) => x.id !== f.id))} />
          ))}
          {ceremony && champion && !still ? (
            <group key={"cer" + ceremony}>
              <LightPillar at={[champion.x, 0, champion.z]} hex={champion.hex} height={12} width={0.7} />
              <Shockwave at={[0, 0.05, 0]} hex={champion.hex} radius={10} dur={1.2} />
            </group>
          ) : null}
          <CameraControls ref={ctl} makeDefault minDistance={4} maxDistance={40} maxPolarAngle={Math.PI / 2.1} />
          <TouchControls ctl={ctl} />
          <Framer home={home} ctl={ctl} homeRef={homeRef} />
          <Intro ctl={ctl} homeRef={homeRef} enabled={!!intro && !still} ready={ready} />
          <ArenaPost q={q} bloom={0.9} threshold={0.95} vignette={0.65} />
        </Canvas>
      </ArenaFrame>
    </JuiceProvider>
  );
}
