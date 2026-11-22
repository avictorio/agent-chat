/* The auction in 3D: the auction house.

   The world: a dark hall in indigo and gold; in the middle a pedestal
   under a spotlight holds the lot - a slowly turning gem, its name
   above. The bidders stand on an arc facing it (you nearest the camera,
   a spectator sees the match's order): each with a stack of gold coins
   for the budget left (one coin a tenth of the starting budget), a
   paddle, a name plate and a row of small gems for the lots won.

   A resolved lot plays on the juice clock: the paddles rise one at a
   time from the lowest bid to the highest, each showing its number (a
   pass stays down); then the gavel - "SOLD to Ada for 35" - the gem
   flies from the pedestal to the winner's row and their coins drop away
   by the price; an unsold lot just fades. The last lot adds the winner's
   pillar and shockwave. Catch-up, tap-to-skip and reduced motion as in
   the other rounds arenas. Bids are sealed until a lot resolves; the
   scene never shows a pending one. */
import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { CameraControls } from "@react-three/drei";
import { CanvasTexture, Color, Object3D, SRGBColorSpace, type Group, type InstancedMesh, type MeshStandardMaterial } from "three";
import { ArenaFrame, FirstFrame, Framer, Ticker, TouchControls, goHome, useQuality, useReducedMotion, type Ctl, type Home } from "../three/arena3d";
import { ArenaPost, ImpactLayer, Intro, JuiceProvider, JuiceRig, SoundToggle, useFirstVisit, useJuice, useJuiceStore, type Impact } from "../three/juice";
import { Burst, LightPillar, Shockwave, SkyDome, type SkySpec } from "../three/atmos";
import { BUZZ, sfx } from "../three/sfx";
import type { AuctionPlayer, AuctionRound, AuctionState } from "@chat/contract";

// One empty list for matches without players or rounds yet, so the memos
// below keep their inputs from one render to the next.
const NO_ITEMS: never[] = [];

const AU_SKY: SkySpec = {
  top: "#03030a",
  mid: "#0a0a1e",
  horizon: "#1e1b4b",
  ground: "#030308",
  glow: "#fbbf24",
  glowAmt: 0.22,
  stars: 0.05,
};

const PHONE_BELOW = 560;
const GEM_Y = 2.0;
const COIN_H = 0.075;
const COINS = 10;
const GOLD = new Color("#fbbf24").multiplyScalar(1.4);
const ANTIC = 0.45;
const RAISE = 0.42; // between paddles
const UP = 0.3; // a paddle's rise

type Bidder = { name: string; hex: string; you: boolean; x: number; z: number; committed: boolean };

const smooth = (a: number, b: number, t: number) => {
  const x = Math.min(1, Math.max(0, (t - a) / (b - a)));
  return x * x * (3 - 2 * x);
};

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

/* ---------- the hall ---------- */

function Hall() {
  return (
    <group>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.01, 0]}>
        <planeGeometry args={[200, 200]} />
        <meshStandardMaterial color="#0a0816" roughness={0.6} metalness={0.3} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.005, 0]}>
        <ringGeometry args={[4.2, 4.3, 96]} />
        <meshBasicMaterial color={new Color("#818cf8").multiplyScalar(1.2)} toneMapped={false} />
      </mesh>
      {/* the pedestal: a slim column, gold trim, the gem floats above */}
      <mesh position={[0, 0.06, 0]}>
        <cylinderGeometry args={[0.62, 0.7, 0.12, 40]} />
        <meshStandardMaterial color="#2e3048" metalness={0.3} roughness={0.4} />
      </mesh>
      <mesh position={[0, 0.74, 0]}>
        <cylinderGeometry args={[0.3, 0.38, 1.24, 32]} />
        <meshStandardMaterial color="#6b6f99" metalness={0.2} roughness={0.45} emissive="#312e81" emissiveIntensity={0.4} />
      </mesh>
      <mesh position={[0, 1.39, 0]} rotation={[Math.PI / 2, 0, 0]}>
        <torusGeometry args={[0.36, 0.045, 10, 40]} />
        <meshStandardMaterial color="#000" emissive={GOLD} emissiveIntensity={1.0} toneMapped={false} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.015, 0]}>
        <circleGeometry args={[1.3, 48]} />
        <meshBasicMaterial color="#fbbf24" transparent opacity={0.08} depthWrite={false} />
      </mesh>
    </group>
  );
}

/* The lot on the pedestal: a turning gem, its name above. `fly`
   carries it to the winner (0..1) or fades it (unsold). */
function Lot({ name, fly, to, unsold, still, big }: { name: string | null; fly: number; to: [number, number, number] | null; unsold: boolean; still: boolean; big: boolean }) {
  const g = useRef<Group>(null);
  const mat = useRef<MeshStandardMaterial>(null);
  const j = useJuice();
  useFrame(() => {
    const o = g.current;
    if (!o) return;
    const k = fly;
    const tx = to ? to[0] : 0, ty = to ? to[1] : GEM_Y, tz = to ? to[2] : 0;
    o.position.set(tx * k, GEM_Y + (ty - GEM_Y) * k + Math.sin(Math.PI * k) * 1.2, tz * k);
    o.rotation.y = still ? 0.4 : j.t * 0.6;
    const s = unsold ? 1 - k : 1 - 0.65 * k;
    o.scale.setScalar(Math.max(0.001, s));
    if (mat.current) mat.current.emissiveIntensity = 0.9 + (still ? 0 : 0.25 * Math.sin(j.t * 2));
  });
  if (!name) return null;
  return (
    <group>
      <group ref={g}>
        <mesh>
          <icosahedronGeometry args={[0.42, 0]} />
          <meshStandardMaterial ref={mat} color="#fde68a" emissive="#f59e0b" emissiveIntensity={0.9} metalness={0.3} roughness={0.2} flatShading toneMapped={false} />
        </mesh>
      </group>
      {fly < 0.05 ? (
        <sprite position={[0, GEM_Y + 1.05, 0]} scale={big ? [4.6, 1.15, 1] : [3.6, 0.9, 1]} renderOrder={5}>
          <spriteMaterial map={textTex([{ text: "“" + name + "”", color: "#fde68a", size: 34 }], 640, 160)} transparent depthWrite={false} depthTest={false} />
        </sprite>
      ) : null}
    </group>
  );
}

/* Every bidder's coins in one instanced draw: a column per bidder, a coin
   per tenth of the starting budget still left (the top coin scaled for
   the remainder). */
function Coins({ bidders, budgets, budget0 }: { bidders: Bidder[]; budgets: Record<string, number>; budget0: number }) {
  const ref = useRef<InstancedMesh>(null);
  useEffect(() => {
    const m = ref.current;
    if (!m) return;
    const o = new Object3D();
    let n = 0;
    const per = Math.max(1, budget0 / COINS);
    bidders.forEach((b) => {
      const left = Math.max(0, budgets[b.name] ?? budget0);
      const full = Math.floor(left / per);
      const part = left / per - full;
      const count = full + (part > 0.05 ? 1 : 0);
      for (let i = 0; i < count; i++) {
        const s = i === full ? part : 1;
        // a little jitter so the column reads as a stack of coins
        o.position.set(b.x + 0.55 + Math.sin(i * 2.3) * 0.022, 0.04 + i * COIN_H, b.z + 0.1 + Math.cos(i * 1.7) * 0.022);
        o.scale.set(1, Math.max(0.05, s), 1);
        o.updateMatrix();
        m.setMatrixAt(n++, o.matrix);
      }
    });
    m.count = n;
    m.instanceMatrix.needsUpdate = true;
  }, [bidders, budgets, budget0]);
  return (
    <instancedMesh ref={ref} args={[undefined, undefined, 6 * (COINS + 1)]} frustumCulled={false}>
      <cylinderGeometry args={[0.2, 0.2, COIN_H * 0.78, 20]} />
      <meshStandardMaterial color="#b45309" emissive={GOLD} emissiveIntensity={0.55} metalness={0.8} roughness={0.3} />
    </instancedMesh>
  );
}

/* Lots won: small gems in a row beside each bidder. */
function Won({ bidders, won }: { bidders: Bidder[]; won: Record<string, number> }) {
  const ref = useRef<InstancedMesh>(null);
  useEffect(() => {
    const m = ref.current;
    if (!m) return;
    const o = new Object3D();
    let n = 0;
    bidders.forEach((b) => {
      const k = Math.min(20, won[b.name] || 0);
      for (let i = 0; i < k; i++) {
        o.position.set(b.x - 0.55 - (i % 4) * 0.22, 0.1 + Math.floor(i / 4) * 0.22, b.z + 0.1);
        o.rotation.set(0, i * 0.7, 0);
        o.updateMatrix();
        m.setMatrixAt(n++, o.matrix);
      }
    });
    m.count = n;
    m.instanceMatrix.needsUpdate = true;
  }, [bidders, won]);
  return (
    <instancedMesh ref={ref} args={[undefined, undefined, 6 * 20]} frustumCulled={false}>
      <icosahedronGeometry args={[0.12, 0]} />
      <meshStandardMaterial color="#fde68a" emissive="#f59e0b" emissiveIntensity={1.1} flatShading toneMapped={false} />
    </instancedMesh>
  );
}

/* A bidder: a plinth, a ring in their colour (lit when they have bid),
   a paddle that rises with the bid on it, a name plate. */
function BidderMark({ b, lit, raise, bid, budget, won, champ, big, still }: { b: Bidder; lit: boolean; raise: number; bid: number | null; budget: number; won: number; champ: boolean; big: boolean; still: boolean }) {
  const ring = useRef<MeshStandardMaterial>(null);
  const paddle = useRef<Group>(null);
  const j = useJuice();
  useFrame(() => {
    if (ring.current) ring.current.emissiveIntensity = lit || champ ? 1.5 : 0.4 + (still ? 0 : 0.12 * Math.sin(j.t * 2 + b.x));
    if (paddle.current) paddle.current.position.y = 0.55 + 0.65 * raise;
  });
  return (
    <group position={[b.x, 0, b.z]}>
      <mesh position={[0, 0.2, 0]}>
        <cylinderGeometry args={[0.38, 0.45, 0.4, 24]} />
        <meshStandardMaterial color="#141130" metalness={0.5} roughness={0.4} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.41, 0]}>
        <ringGeometry args={[0.26, 0.37, 32]} />
        <meshStandardMaterial ref={ring} color="#000" emissive={b.hex} emissiveIntensity={0.5} toneMapped={false} />
      </mesh>
      <group ref={paddle} position={[0, 0.55, 0]}>
        <mesh position={[0, 0.25, 0]}>
          <cylinderGeometry args={[0.03, 0.03, 0.5, 8]} />
          <meshStandardMaterial color="#e5e7eb" />
        </mesh>
        <mesh position={[0, 0.72, 0]}>
          <boxGeometry args={[0.62, 0.48, 0.05]} />
          <meshStandardMaterial color="#000" emissive={b.hex} emissiveIntensity={raise > 0.05 ? 1.2 : 0.35} toneMapped={false} />
        </mesh>
        {raise > 0.05 && bid != null ? (
          <sprite position={[0, 0.72, 0.06]} scale={[0.6, 0.45, 1]} renderOrder={6}>
            <spriteMaterial map={textTex([{ text: bid ? String(bid) : "pass", color: "#ffffff", size: bid ? 78 : 52 }], 160, 120)} transparent depthWrite={false} depthTest={false} />
          </sprite>
        ) : null}
      </group>
      <sprite position={[0, 0.2, 0.85]} scale={big ? [2.3, 0.92, 1] : [1.7, 0.68, 1]} renderOrder={5}>
        <spriteMaterial map={textTex([{ text: b.name, color: b.hex, size: 44 }, champ ? { text: "★ winner · " + won + (won === 1 ? " lot" : " lots"), color: "#fde68a", size: 32 } : { text: budget + " left" + (b.you ? " · you" : ""), color: "rgba(224,231,255,0.92)", size: 32 }])} transparent depthWrite={false} depthTest={false} />
      </sprite>
    </group>
  );
}

/* ---------- the reveal's clock and beats ---------- */

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

/* Drives the reveal's numbers (each paddle's raise, the gem's flight)
   from juice time and fires the beats once each. */
function Beats({
  t0,
  steps,
  hammerAt,
  holdAfter,
  onT,
  onStep,
  onHammer,
  onDone,
}: {
  t0: number;
  steps: number;
  hammerAt: number;
  holdAfter: number;
  onT: (t: number) => void;
  onStep: (i: number) => void;
  onHammer: () => void;
  onDone: () => void;
}) {
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
    for (let i = 0; i < steps; i++) {
      if (t >= ANTIC + i * RAISE && !fired.current.has("s" + i)) {
        fired.current.add("s" + i);
        onStep(i);
      }
    }
    if (t >= hammerAt && !fired.current.has("h")) {
      fired.current.add("h");
      onHammer();
    }
    if (t >= hammerAt + holdAfter && !fired.current.has("d")) {
      fired.current.add("d");
      onDone();
    }
  });
  return null;
}

/* ---------- impacts from the viewer's seat ---------- */

function lotImpact(r: AuctionRound, bidders: Bidder[]): Impact {
  const you = bidders.find((b) => b.you);
  if (!r.winner) return { trauma: 0.1, sound: "whoosh", title: { big: "UNSOLD", small: "Nobody bid on lot " + r.n, tone: "neutral" } };
  const how = r.tie ? " (a tie - " + r.tie + ")" : "";
  if (you && r.winner === you.name) return { trauma: 0.3, stop: 90, pulse: 0.5, buzz: BUZZ.scored, sound: ["smash", "win"], title: { big: "SOLD", small: "to you for " + r.price + how, tone: "good" } };
  const mine = you ? (r.bids || {})[you.name] : 0;
  if (you && (mine as number) > 0) return { trauma: 0.3, stop: 100, buzz: BUZZ.hitYou, sound: "smash", title: { big: "OUTBID", small: r.winner + " took it for " + r.price + how, tone: "bad" } };
  return { trauma: 0.2, stop: 70, sound: "smash", title: { big: "SOLD", small: "to " + r.winner + " for " + r.price + how, tone: "neutral" } };
}

function finalImpact(g: AuctionState, bidders: Bidder[]): Impact {
  const you = bidders.find((b) => b.you);
  const w = g.winner as string | null;
  const line = (g.places || []).map((n: string) => n + " " + (((g.players || []).find((p: AuctionPlayer) => p.name === n) || {}).won || 0)).join(" · ");
  if (!w) return { trauma: 0.3, stop: 120, sound: "whoosh", title: { big: "A TIE", small: line, tone: "neutral" } };
  if (you && you.name === w) return { trauma: 0.8, stop: 250, slow: 0.8, pulse: 1, buzz: BUZZ.wonMatch, sound: ["clash", "win"], title: { big: "VICTORY", small: "Most lots · " + line, tone: "good" } };
  if (you) {
    const place = (g.places || []).indexOf(you.name) + 1;
    if (place === 2 && bidders.length > 2) return { trauma: 0.4, stop: 150, buzz: BUZZ.scored, sound: "win", title: { big: "#2", small: w + " takes the season · " + line, tone: "neutral" } };
    return { trauma: 0.8, stop: 250, slow: 0.8, pulse: 0.8, buzz: BUZZ.lostMatch, sound: ["clash", "lose"], title: { big: "DEFEAT", small: w + " takes the season · " + line, tone: "bad" } };
  }
  return { trauma: 0.6, stop: 200, slow: 0.6, pulse: 0.8, buzz: BUZZ.scored, sound: ["clash", "win"], title: { big: w.toUpperCase() + " WINS", small: line, tone: "neutral" } };
}

function sayLot(r: AuctionRound): string {
  if (!r) return "";
  const bids = Object.keys(r.bids || {}).map((n) => n + " " + (r.bids[n] || "pass")).join(", ");
  return "Lot " + r.n + ", " + r.lot + ": " + (r.winner ? "sold to " + r.winner + " for " + r.price : "unsold") + ". Bids: " + bids + ".";
}

/* ---------- what the viewer has seen ---------- */

function seenKey(id: unknown): string {
  let path = "";
  try {
    path = location.pathname;
  } catch {
    path = "";
  }
  return "ac-au-seen:" + path + ":" + String(id);
}
function readSeen(id: unknown): number | null {
  try {
    const v = localStorage.getItem(seenKey(id));
    return v == null ? null : Number(v) || 0;
  } catch {
    return null;
  }
}
/** Budgets and lots won as the scene shows them: after `upto` lots. */
function tally(rounds: AuctionRound[], bidders: Bidder[], budget0: number, upto: number) {
  const budgets: Record<string, number> = {};
  const won: Record<string, number> = {};
  bidders.forEach((b) => {
    budgets[b.name] = budget0;
    won[b.name] = 0;
  });
  rounds.slice(0, upto).forEach((r) => {
    if (r.winner) {
      budgets[r.winner] = (budgets[r.winner] ?? budget0) - r.price;
      won[r.winner] = (won[r.winner] || 0) + 1;
    }
  });
  return { budgets, won };
}
function writeSeen(id: unknown, n: number) {
  try {
    localStorage.setItem(seenKey(id), String(n));
  } catch {
    // storage unavailable: the next open just won't replay
  }
}

/* Home: the lot and its name, every bidder with a raised paddle and
   the name plate. The camera orbits a point between the pedestal and
   the bidders, and for each distance the pitch centres the content's
   vertical extent, so the scene fills the frame instead of sitting low
   under a band of sky; the distance is the closest that fits. */
function auHome(aspect: number, width: number, bidders: Bidder[]): Home {
  const phone = width < PHONE_BELOW;
  const vfov = aspect < 1 ? 56 : 46;
  const tv = Math.tan((vfov * Math.PI) / 360);
  const th = tv * Math.max(0.45, aspect);
  const el = ((phone ? 38 : 32) * Math.PI) / 180;
  const plateW = phone ? 1.2 : 0.9;
  const pts: [number, number, number][] = [
    [0, GEM_Y + 1.7, 0],
    [phone ? -2.3 : -1.8, GEM_Y + 1.2, 0],
    [phone ? 2.3 : 1.8, GEM_Y + 1.2, 0],
  ];
  bidders.forEach((b) => pts.push([b.x - plateW, -0.3, b.z + 0.85], [b.x + plateW, -0.3, b.z + 0.85], [b.x, 2.2, b.z], [b.x - 1.25, 0, b.z]));
  const fy = 0.9;
  const fz = 1.2;
  const at = (d: number) => {
    const cy = fy + d * Math.sin(el);
    const cz = fz + d * Math.cos(el);
    const angs = pts.map(([, y, z]) => Math.atan2(cy - y, cz - z));
    // centred, then nudged up a little: the frame's buttons sit on its top edge
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

/* ---------- the arena ---------- */

export default function AuctionArena3D({
  g,
  me = "",
  aspect,
  onReady,
  registerCommit,
}: {
  g: AuctionState;
  me?: string;
  aspect?: number;
  onReady?: () => void;
  registerCommit?: (fn: (() => void) | null) => void;
}) {
  const still = useReducedMotion();
  const q = useQuality(still);
  const juice = useJuiceStore(still);
  const firstVisit = useFirstVisit("au:" + String((g && g.id) || ""));
  const [ready, setReady] = useState(false);
  const ctl = useRef<Ctl | null>(null);
  const homeRef = useRef<Home | null>(null);
  const [hostW, setHostW] = useState(() => (aspect && aspect < 1.4 ? 390 : 760));
  const meL = me.toLowerCase();
  const players: AuctionPlayer[] = (g && g.players) || NO_ITEMS;
  const rounds: AuctionRound[] = (g && g.rounds) || NO_ITEMS;
  const finished = !!g && g.status === "finished";
  const running = !!g && g.status === "running";
  const budget0 = (g && g.budget) || 100;

  // You stand nearest the camera; the rest fan out on an arc.
  const bidders: Bidder[] = useMemo(() => {
    const list = players.slice();
    const mine = list.findIndex((p) => String(p.name).toLowerCase() === meL);
    let order = list;
    if (mine >= 0) {
      const others = list.filter((_, i) => i !== mine);
      const mid = Math.floor(list.length / 2);
      order = others.slice(0, mid).concat([list[mine]!], others.slice(mid));
    }
    const n = order.length;
    const span = Math.min(Math.PI * 0.95, 0.5 * n);
    return order.map((p: AuctionPlayer, i: number) => {
      const a = Math.PI / 2 + (n > 1 ? (i / (n - 1) - 0.5) * span : 0);
      return { name: String(p.name), hex: String(p.hex || "#818cf8"), you: String(p.name).toLowerCase() === meL, x: Math.cos(a) * 3.6 * -1, z: Math.sin(a) * 3.6 - 0.6, committed: !!p.committed };
    });
  }, [players, meL]);

  const [init] = useState(() => {
    const n = rounds.length;
    const seen = readSeen(g && g.id);
    if (seen == null || !n || seen >= n) return { shown: n };
    return { shown: n - 1 };
  });
  const [shown, setShown] = useState(init.shown);
  const [playing, setPlaying] = useState<{ n: number; t0: number | null } | null>(null);
  const [go, setGo] = useState(false);
  const [rt, setRt] = useState(0); // the reveal's time, for paddles and the gem
  const [hammered, setHammered] = useState(false);
  const [fx, setFx] = useState<{ id: number; at: [number, number, number]; hex: string }[]>([]);
  const fxId = useRef(0);
  const [ceremony, setCeremony] = useState(0);
  const [say, setSay] = useState("");
  const [sealed, setSealed] = useState<number | null>(null);

  useEffect(() => {
    if (!ready || go) return;
    const t = setTimeout(() => setGo(true), firstVisit && !still ? 2600 : 400);
    return () => clearTimeout(t);
  }, [ready, go, firstVisit, still]);

  const isLast = (n: number) => finished && n === rounds.length;
  const land = (n: number, quiet: boolean) => {
    const r = rounds[n - 1];
    setPlaying(null);
    setHammered(false);
    setShown(n);
    if (!r) return;
    const imp = isLast(n) ? finalImpact(g, bidders) : lotImpact(r, bidders);
    juice.hit(quiet ? { ...imp, trauma: 0, stop: 0, slow: 0, pulse: 0 } : imp);
    setSay(sayLot(r));
    if (isLast(n) && g.winner) setCeremony((c) => c + 1);
  };

  const onLand = useEffectEvent(land);
  useEffect(() => {
    if (!go || playing) return;
    const n = rounds.length;
    if (n <= shown) return;
    // oxlint-disable-next-line react/set-state-in-effect -- new rounds from the server step the replay: reduced motion lands one at once, with its title, sound and buzz
    if (still) onLand(n, false);
    else {
      setRt(0);
      setHammered(false);
      setPlaying({ n, t0: null });
    }
  }, [go, playing, rounds.length, shown, still]);

  const seenId = g && g.id;
  useEffect(() => {
    writeSeen(seenId, shown);
  }, [seenId, shown]);

  const skip = () => {
    if (playing) land(playing.n, true);
  };

  const roundNo = g ? g.round : null;
  useEffect(() => {
    if (!registerCommit) return;
    registerCommit(() => {
      setSealed(roundNo);
      juice.hit({ sound: "lock", buzz: BUZZ.commit });
    });
    return () => registerCommit(null);
  }, [registerCommit, juice, roundNo]);
  const prevCommit = useRef<Record<string, boolean> | null>(null);
  useEffect(() => {
    const now: Record<string, boolean> = {};
    bidders.forEach((b) => (now[b.name] = b.committed));
    const prev = prevCommit.current;
    prevCommit.current = now;
    if (!prev || !ready) return;
    bidders.forEach((b) => {
      if (!b.you && b.committed && !prev[b.name]) juice.hit({ sound: "ping" });
    });
  }, [bidders, ready, juice]);

  const settledN = playing ? (hammered ? playing.n : playing.n - 1) : shown;
  const { budgets, won } = useMemo(() => tally(rounds, bidders, budget0, settledN), [settledN, rounds, bidders, budget0]);
  const playingRound = playing ? rounds[playing.n - 1] : null;
  // the reveal order: lowest bid first, passes never rise
  const order = useMemo(() => {
    if (!playingRound) return [] as string[];
    return Object.keys(playingRound.bids || {})
      .filter((n) => playingRound.bids[n]! > 0)
      .sort((a, b) => playingRound.bids[a]! - playingRound.bids[b]!);
  }, [playingRound]);
  const hammerAt = ANTIC + Math.max(0, order.length - 1) * RAISE + UP + 0.45;
  const raiseOf = (name: string) => {
    if (!playingRound) return 0;
    const i = order.indexOf(name);
    if (i < 0) return 0;
    const at = ANTIC + i * RAISE;
    const up = smooth(at, at + UP, rt);
    const down = smooth(hammerAt + 0.9, hammerAt + 1.3, rt);
    return up * (1 - down);
  };
  const fly = playingRound && hammered ? smooth(hammerAt, hammerAt + 0.8, rt) : 0;
  const winnerB = playingRound && playingRound.winner ? bidders.find((b) => b.name === playingRound.winner) || null : null;
  const lotName = playingRound ? playingRound.lot : running ? g.lot : null;
  const champion = finished && g.winner ? bidders.find((b) => b.name === g.winner) || null : null;
  const home = (a: number, width: number) => auHome(a, width, bidders);
  const first = home(aspect || 1.6, hostW);
  const label =
    "Auction arena, 3D view: " +
    (lotName ? "the lot is " + lotName + ". " : "") +
    bidders.map((b) => b.name + (b.you ? " (you)" : "") + " " + budgets[b.name] + " left, " + won[b.name] + " won" + (running ? (b.committed ? ", bid in" : ", thinking") : "")).join("; ") +
    ".";
  const intro = firstVisit ? { title: "Auction", sub: bidders.map((b) => b.name).join(" · ") || "One sealed bid", color: "#818cf8" } : null;
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
            {playing && playingRound ? (
              <div className="duel-catchup" aria-hidden="true">
                Lot {playingRound.n} · tap to skip
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
          <JuiceRig ctl={ctl} reach={0.8} />
          <color attach="background" args={["#03030a"]} />
          <fog attach="fog" args={["#0a0a1e", 20, 70]} />
          <SkyDome spec={AU_SKY} />
          <hemisphereLight args={["#e0e7ff", "#05040c", 0.5]} />
          <directionalLight position={[-4, 9, 8]} intensity={0.9} color="#fef3c7" />
          <spotLight position={[0, 7, 1]} angle={0.42} penumbra={0.6} intensity={30} distance={14} color="#fde68a" />
          <Hall />
          <Lot name={lotName} fly={fly} to={winnerB ? [winnerB.x - 0.55, 0.35, winnerB.z + 0.1] : null} unsold={!!playingRound && !playingRound.winner && hammered} still={still} big={hostW < PHONE_BELOW} />
          <Coins bidders={bidders} budgets={budgets} budget0={budget0} />
          <Won bidders={bidders} won={won} />
          {bidders.map((b) => (
            <BidderMark
              key={b.name}
              b={b}
              lit={running && !playing && (b.committed || (b.you && sealed === g.round))}
              raise={raiseOf(b.name)}
              bid={playingRound ? (playingRound.bids || {})[b.name] ?? null : null}
              budget={budgets[b.name] ?? budget0}
              won={won[b.name] || 0}
              champ={!playing && !!champion && champion.name === b.name}
              big={hostW < PHONE_BELOW}
              still={still}
            />
          ))}
          {playing && playingRound && playing.t0 == null ? <ClockStart key={"c" + playing.n} onStart={(t) => setPlaying((p) => (p && p.t0 == null ? { ...p, t0: t } : p))} /> : null}
          {playing && playingRound && playing.t0 != null ? (
            <Beats
              key={"b" + playing.n}
              t0={playing.t0}
              steps={order.length}
              hammerAt={hammerAt}
              holdAfter={isLast(playing.n) ? 2.0 : 1.4}
              onT={setRt}
              onStep={() => sfx("beat")}
              onHammer={() => {
                setHammered(true);
                const last = isLast(playing.n);
                juice.hit(lotImpact(playingRound, bidders));
                setSay(sayLot(playingRound));
                if (winnerB && !q.lite) setFx((l) => [...l.slice(-4), { id: ++fxId.current, at: [0, GEM_Y, 0], hex: "#fbbf24" }]);
                if (last) {
                  setTimeout(() => {
                    juice.hit(finalImpact(g, bidders));
                    if (g.winner) setCeremony((c) => c + 1);
                  }, 900);
                }
              }}
              onDone={() => {
                setPlaying(null);
                setHammered(false);
                setShown(playing.n);
              }}
            />
          ) : null}
          {fx.map((f) => (
            <Burst key={f.id} at={f.at} hex={f.hex} box={[0.5, 0.5, 0.5]} count={q.lite ? 16 : 30} power={1.6} piece={0.07} dur={1} onDone={() => setFx((l) => l.filter((x) => x.id !== f.id))} />
          ))}
          {ceremony && champion && !still ? (
            <group key={"cer" + ceremony}>
              <LightPillar at={[champion.x, 0, champion.z]} hex={champion.hex} height={12} width={0.7} />
              <Shockwave at={[0, 0.05, 0]} hex={champion.hex} radius={12} dur={1.2} />
            </group>
          ) : null}
          <CameraControls ref={ctl} makeDefault minDistance={4} maxDistance={40} maxPolarAngle={Math.PI / 2.1} />
          <TouchControls ctl={ctl} />
          <Framer home={home} ctl={ctl} homeRef={homeRef} />
          <Intro ctl={ctl} homeRef={homeRef} enabled={!!intro && !still} ready={ready} />
          <ArenaPost q={q} bloom={1.0} threshold={0.95} vignette={0.6} />
        </Canvas>
      </ArenaFrame>
    </JuiceProvider>
  );
}
