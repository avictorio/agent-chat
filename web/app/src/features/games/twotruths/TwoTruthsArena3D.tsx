/* Two Truths and a Lie in 3D (2026-11-19): the campfire.

   The world: a clearing at night under stars, a campfire in a ring of
   stones (Battleship's shader fire), the players on log seats round it
   (you nearest the camera), each with a lantern in their colour. Three
   cards hang over the fire: face down while the storyteller writes, the
   statements once they are up. The storyteller's lantern burns tall; a
   voter's lights when they have voted - never which card (votes are
   sealed until the reveal).

   A resolved round plays on the juice clock: every vote flies from its
   seat to its card as an ember, then the lie card catches and burns away
   while the truths glow gold, and the points rise over the seats. The
   last round adds the winner's pillar. Catch-up, tap to skip and reduced
   motion as in the other arenas. The page under the scene carries the
   writing form, the votes, the scores and the full reveal. */
import { useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { CameraControls } from "@react-three/drei";
import { CanvasTexture, Color, SRGBColorSpace, type Group, type Mesh, type MeshStandardMaterial } from "three";
import { ArenaFrame, FirstFrame, Framer, Ticker, TouchControls, goHome, useQuality, useReducedMotion, type Ctl, type Home } from "../three/arena3d";
import { ArenaPost, ImpactLayer, Intro, JuiceProvider, JuiceRig, SoundToggle, useFirstVisit, useJuice, useJuiceStore, type Impact } from "../three/juice";
import { Burst, LightPillar, Shockwave, SkyDome, type SkySpec } from "../three/atmos";
import { FireSystem } from "../three/fire";
import { BUZZ, sfx } from "../three/sfx";
import type { TwoTruthsPlayer, TwoTruthsRound, TwoTruthsState } from "@chat/contract";

// One empty list for matches without players or rounds yet, so the memos
// below keep their inputs from one render to the next.
const NO_ITEMS: never[] = [];

const TT_SKY: SkySpec = {
  top: "#02030a",
  mid: "#060a1c",
  horizon: "#14183a",
  ground: "#020306",
  glow: "#fb923c",
  glowAmt: 0.12,
  stars: 0.7,
};

const PHONE_BELOW = 560;
const SEAT_R = 2.7;
const CARD_Y = 2.4;
const CARD_W = 1.78;
const CARD_H = 1.18;
const CARD_GAP = 0.1;
const CARD_Z = 0.25;
const ANTIC = 0.35;
const FLY = 0.9;

type Seat = { name: string; hex: string; you: boolean; x: number; z: number; a: number };

const smooth = (a: number, b: number, t: number) => {
  const x = Math.min(1, Math.max(0, (t - a) / (b - a)));
  return x * x * (3 - 2 * x);
};

/* ---------- textures ---------- */

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

// floating points: gold on a dark pill, readable over a card or the sky
const pillCache = new Map<string, CanvasTexture>();
function pillTex(text: string): CanvasTexture {
  const hit = pillCache.get(text);
  if (hit) return hit;
  const c = document.createElement("canvas");
  c.width = 200;
  c.height = 110;
  const x = c.getContext("2d");
  if (x) {
    x.fillStyle = "rgba(12,8,4,0.88)";
    x.beginPath();
    x.roundRect(10, 10, 180, 90, 45);
    x.fill();
    x.strokeStyle = "#f59e0b";
    x.lineWidth = 5;
    x.stroke();
    x.fillStyle = "#fde68a";
    x.font = "900 64px system-ui, sans-serif";
    x.textAlign = "center";
    x.textBaseline = "middle";
    x.fillText(text, 100, 58);
  }
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  pillCache.set(text, t);
  return t;
}

// a card: parchment with its number and the statement, wrapped; or the
// back (while the storyteller writes)
const cardCache = new Map<string, CanvasTexture>();
function cardTex(n: number, text: string | null, mark: "" | "lie" | "true"): CanvasTexture {
  const key = n + "|" + (text || "") + "|" + mark;
  const hit = cardCache.get(key);
  if (hit) return hit;
  const W = 600;
  const H = 400;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const x = c.getContext("2d");
  if (x) {
    if (text == null) {
      x.fillStyle = "#2b1d12";
      x.fillRect(0, 0, W, H);
      x.strokeStyle = "#a16207";
      x.lineWidth = 10;
      x.strokeRect(14, 14, W - 28, H - 28);
      x.fillStyle = "#fbbf24";
      x.font = "800 150px system-ui, sans-serif";
      x.textAlign = "center";
      x.textBaseline = "middle";
      x.fillText("?", W / 2, H / 2 + 6);
    } else {
      x.fillStyle = mark === "lie" ? "#fed7aa" : mark === "true" ? "#fef9c3" : "#f5ead2";
      x.fillRect(0, 0, W, H);
      x.strokeStyle = mark === "lie" ? "#c2410c" : mark === "true" ? "#ca8a04" : "#a16207";
      x.lineWidth = 10;
      x.strokeRect(10, 10, W - 20, H - 20);
      x.fillStyle = "#7c2d12";
      x.font = "900 58px system-ui, sans-serif";
      x.textAlign = "left";
      x.textBaseline = "top";
      x.fillText(String(n), 32, 22);
      if (mark) {
        x.textAlign = "right";
        x.font = "900 40px system-ui, sans-serif";
        x.fillStyle = mark === "lie" ? "#c2410c" : "#a16207";
        x.fillText(mark === "lie" ? "LIE" : "TRUE", W - 32, 30);
      }
      // wrap the statement into the card
      x.fillStyle = "#1c1917";
      x.textAlign = "center";
      let size = 50;
      let lines: string[] = [];
      for (; size >= 28; size -= 4) {
        x.font = "700 " + size + "px system-ui, sans-serif";
        lines = [];
        let cur = "";
        for (const w of text.split(" ")) {
          const t = cur ? cur + " " + w : w;
          if (x.measureText(t).width > W - 80 && cur) {
            lines.push(cur);
            cur = w;
          } else cur = t;
        }
        if (cur) lines.push(cur);
        if (lines.length * size * 1.2 <= H - 120) break;
      }
      const top = 100 + (H - 120 - lines.length * size * 1.2) / 2;
      lines.forEach((l, i) => x.fillText(l, W / 2, top + i * size * 1.2 + size * 0.5));
    }
  }
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  cardCache.set(key, t);
  return t;
}

/* ---------- the clearing ---------- */

function Clearing() {
  const stones = useMemo(() => Array.from({ length: 11 }, (_, i) => (i / 11) * Math.PI * 2), []);
  return (
    <group>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.01, 0]}>
        <circleGeometry args={[60, 64]} />
        <meshStandardMaterial color="#0b120c" roughness={0.95} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.002, 0]}>
        <circleGeometry args={[4.4, 64]} />
        <meshStandardMaterial color="#1a140d" roughness={1} />
      </mesh>
      {stones.map((a, i) => (
        <mesh key={i} position={[Math.cos(a) * 0.78, 0.09, Math.sin(a) * 0.78]} scale={[1, 0.7, 1]}>
          <dodecahedronGeometry args={[0.15, 0]} />
          <meshStandardMaterial color="#57534e" roughness={0.9} flatShading />
        </mesh>
      ))}
      {[0, 1, 2].map((i) => (
        <mesh key={"log" + i} position={[0, 0.1, 0]} rotation={[0, (i * Math.PI) / 3, Math.PI / 2]}>
          <cylinderGeometry args={[0.07, 0.08, 0.9, 8]} />
          <meshStandardMaterial color="#3f2a17" roughness={0.9} />
        </mesh>
      ))}
    </group>
  );
}

/* A seat: a log, a lantern in the player's colour (lit once they have
   voted; tall and bright for the storyteller). */
function SeatMark({ s, lit, teller, still }: { s: Seat; lit: boolean; teller: boolean; still: boolean }) {
  const lamp = useRef<MeshStandardMaterial>(null);
  const beam = useRef<Mesh>(null);
  const ring = useRef<Mesh>(null);
  const j = useJuice();
  useFrame(() => {
    if (lamp.current) lamp.current.emissiveIntensity = teller ? 2.4 + (still ? 0 : 0.5 * Math.sin(j.t * 3)) : lit ? 1.8 : 0.35 + (still ? 0 : 0.1 * Math.sin(j.t * 1.5 + s.x));
    // a beam would cross the fire from your seat: a ring on the ground instead
    if (beam.current) beam.current.visible = teller && !s.you;
    if (ring.current) ring.current.visible = teller && s.you;
  });
  return (
    <group position={[s.x, 0, s.z]}>
      <mesh position={[0, 0.16, 0]} rotation={[0, -s.a + Math.PI / 2, Math.PI / 2]}>
        <cylinderGeometry args={[0.16, 0.18, 0.9, 10]} />
        <meshStandardMaterial color="#4a3220" roughness={0.9} />
      </mesh>
      <mesh position={[0, 0.62, 0]}>
        <sphereGeometry args={[0.13, 16, 12]} />
        <meshStandardMaterial ref={lamp} color="#000" emissive={s.hex} emissiveIntensity={0.4} toneMapped={false} />
      </mesh>
      <mesh ref={ring} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.01, 0]}>
        <ringGeometry args={[0.5, 0.6, 40]} />
        <meshBasicMaterial color={new Color(s.hex).multiplyScalar(1.8)} toneMapped={false} transparent opacity={0.9} />
      </mesh>
      <mesh ref={beam} position={[0, 1.35, 0]}>
        <cylinderGeometry args={[0.025, 0.025, 1.3, 6]} />
        <meshBasicMaterial color={new Color(s.hex).multiplyScalar(2)} toneMapped={false} transparent opacity={0.8} />
      </mesh>
    </group>
  );
}

/* A statement card over the fire. `burn` (0..1) curls the lie away;
   `glow` lights a truth. */
function Card({ i, text, mark, burn, glow, faceDown, still }: { i: number; text: string | null; mark: "" | "lie" | "true"; burn: number; glow: number; faceDown: boolean; still: boolean }) {
  const g = useRef<Group>(null);
  const mat = useRef<MeshStandardMaterial>(null);
  const j = useJuice();
  const x = (i - 1) * (CARD_W + CARD_GAP);
  useFrame(() => {
    const o = g.current;
    if (!o) return;
    const bob = still ? 0 : Math.sin(j.t * 1.1 + i * 2) * 0.05;
    o.position.set(x, CARD_Y + bob + burn * 0.4, CARD_Z - Math.abs(i - 1) * 0.22);
    o.rotation.set(-0.18, (1 - i) * 0.16, burn * 0.5 * (i - 1 || 1));
    o.scale.setScalar(Math.max(0.001, 1 - burn));
    if (mat.current) mat.current.emissiveIntensity = 0.12 + glow * 0.55 + burn * 1.2;
  });
  const map = useMemo(() => cardTex(i + 1, faceDown ? null : text, mark), [i, text, mark, faceDown]);
  return (
    <group ref={g}>
      <mesh>
        <planeGeometry args={[CARD_W, CARD_H]} />
        <meshStandardMaterial ref={mat} map={map} emissiveMap={map} emissive={burn > 0 ? "#f97316" : "#ffffff"} emissiveIntensity={0.12} roughness={0.85} side={2} toneMapped={false} />
      </mesh>
    </group>
  );
}

/* A vote in flight: an ember from the voter's seat to their card. */
function Ember({ from, to, hex, k }: { from: [number, number, number]; to: [number, number, number]; hex: string; k: number }) {
  const ref = useRef<Mesh>(null);
  useFrame(() => {
    const o = ref.current;
    if (!o) return;
    const e = k * k * (3 - 2 * k);
    o.position.set(from[0] + (to[0] - from[0]) * e, from[1] + (to[1] - from[1]) * e + Math.sin(Math.PI * e) * 1.0, from[2] + (to[2] - from[2]) * e);
    o.visible = k > 0;
  });
  const col = useMemo(() => new Color(hex).multiplyScalar(2.2), [hex]);
  return (
    <mesh ref={ref}>
      <sphereGeometry args={[0.09, 12, 10]} />
      <meshBasicMaterial color={col} toneMapped={false} />
    </mesh>
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

function Beats({ t0, beats, doneAt, onT, onBeat, onDone }: { t0: number; beats: [string, number][]; doneAt: number; onT: (t: number) => void; onBeat: (k: string) => void; onDone: () => void }) {
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
    beats.forEach(([k, at]) => {
      if (t >= at && !fired.current.has(k)) {
        fired.current.add(k);
        onBeat(k);
      }
    });
    if (t >= doneAt && !fired.current.has("done")) {
      fired.current.add("done");
      onDone();
    }
  });
  return null;
}

/* ---------- impacts from the viewer's seat ---------- */

function roundImpact(r: TwoTruthsRound, me: string): Impact {
  if (r.forfeit) {
    if (r.teller === me) return { trauma: 0.3, stop: 90, buzz: BUZZ.hitYou, sound: "buzzer", title: { big: "FORFEIT", small: "Your writing time ran out", tone: "bad" } };
    return { trauma: 0.1, sound: "whoosh", title: { big: "FORFEIT", small: r.teller + " ran out of time to write", tone: "neutral" } };
  }
  const lie = r.lie;
  if (r.teller === me) {
    if (r.fooled > 0) return { trauma: 0.3, stop: 90, pulse: 0.5, buzz: BUZZ.scored, sound: ["shatter", "win"], title: { big: "FOOLED " + r.fooled, small: "Your lie got past " + r.fooled + " · +" + (r.points[me] || 0), tone: "good" } };
    if ((r.right || []).length) return { trauma: 0.4, stop: 110, buzz: BUZZ.hitYou, sound: ["shatter", "lose"], title: { big: "BUSTED", small: r.note || "Everyone saw through it", tone: "bad" } };
    return { trauma: 0.1, sound: "whoosh", title: { big: "NO VOTES", small: "Nobody voted on your statements", tone: "neutral" } };
  }
  const v = (r.votes || {})[me];
  if (v === undefined) return { trauma: 0.2, stop: 70, sound: "shatter", title: { big: "LIE #" + lie, small: (r.right || []).length ? (r.right || []).join(", ") + " spotted it" : r.teller + " fooled everyone", tone: "neutral" } };
  if (v === lie) return { trauma: 0.3, stop: 90, pulse: 0.5, buzz: BUZZ.scored, sound: ["shatter", "win"], title: { big: "SPOTTED IT", small: "#" + lie + " was the lie · +2", tone: "good" } };
  if (v == null) return { trauma: 0.15, sound: "shatter", title: { big: "NO VOTE", small: "#" + lie + " was the lie", tone: "neutral" } };
  return { trauma: 0.35, stop: 100, buzz: BUZZ.hitYou, sound: ["shatter", "lose"], title: { big: "FOOLED", small: "#" + lie + " was the lie - you picked #" + v, tone: "bad" } };
}

function finalImpact(g: TwoTruthsState, me: string): Impact {
  const w = g.winner as string | null;
  const pts = (n: string) => (((g.players || []).find((p: TwoTruthsPlayer) => p.name === n) || {}) as Partial<TwoTruthsPlayer>).score || 0;
  const line = (g.places || []).map((n: string) => n + " " + pts(n)).join(" · ");
  if (!w) return { trauma: 0.3, stop: 120, sound: "whoosh", title: { big: "A TIE", small: line, tone: "neutral" } };
  if (me && me === w) return { trauma: 0.8, stop: 250, slow: 0.8, pulse: 1, buzz: BUZZ.wonMatch, sound: ["clash", "win"], title: { big: "VICTORY", small: line, tone: "good" } };
  if (me && (g.players || []).some((p: TwoTruthsPlayer) => p.name === me)) {
    const place = (g.places || []).indexOf(me) + 1;
    if (place === 2) return { trauma: 0.4, stop: 150, buzz: BUZZ.scored, sound: "win", title: { big: "#2", small: w + " tells the best tales · " + line, tone: "neutral" } };
    return { trauma: 0.8, stop: 250, slow: 0.8, pulse: 0.8, buzz: BUZZ.lostMatch, sound: ["clash", "lose"], title: { big: "DEFEAT", small: w + " wins · " + line, tone: "bad" } };
  }
  return { trauma: 0.6, stop: 200, slow: 0.6, pulse: 0.8, buzz: BUZZ.scored, sound: ["clash", "win"], title: { big: w.toUpperCase() + " WINS", small: line, tone: "neutral" } };
}

function sayRound(r: TwoTruthsRound): string {
  if (!r) return "";
  if (r.forfeit) return "Round " + r.n + ": " + r.teller + " ran out of time to write; the round is forfeit.";
  const lie = (r.statements || [])[r.lie! - 1] || "";
  return "Round " + r.n + ": " + r.teller + "'s lie was number " + r.lie + ", " + lie + ". " + ((r.right || []).length ? (r.right || []).join(", ") + " spotted it" : "Nobody spotted it") + "; " + r.teller + " fooled " + r.fooled + ".";
}

/* ---------- what the viewer has seen ---------- */

function seenKey(id: unknown): string {
  let path = "";
  try {
    path = location.pathname;
  } catch {
    path = "";
  }
  return "ac-tt-seen:" + path + ":" + String(id);
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

/* Home: the cards, the fire and every seat with its plate; the pitch
   centres the content's vertical extent at each distance. */
function ttHome(aspect: number, width: number): Home {
  const phone = width < PHONE_BELOW;
  const vfov = aspect < 1 ? 56 : 46;
  const tv = Math.tan((vfov * Math.PI) / 360);
  const th = tv * Math.max(0.45, aspect);
  const el = ((phone ? 30 : 24) * Math.PI) / 180;
  const half = 1.5 * CARD_W + CARD_GAP;
  const pts: [number, number, number][] = [
    [-half, CARD_Y + CARD_H / 2 + 0.15, CARD_Z - 0.22],
    [half, CARD_Y + CARD_H / 2 + 0.15, CARD_Z - 0.22],
    [-SEAT_R - 0.6, 0, 0],
    [SEAT_R + 0.6, 0, 0],
    [0, 0, -SEAT_R],
    [0, phone ? -0.55 : -0.4, SEAT_R + 0.9],
  ];
  const fz = 0.6;
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

/* ---------- the arena ---------- */

export default function TwoTruthsArena3D({
  g,
  me = "",
  aspect,
  onReady,
  registerCommit,
}: {
  g: TwoTruthsState | null;
  me?: string;
  aspect?: number;
  onReady?: () => void;
  registerCommit?: (fn: (() => void) | null) => void;
}) {
  const still = useReducedMotion();
  const q = useQuality(still);
  const juice = useJuiceStore(still);
  const firstVisit = useFirstVisit("tt:" + String((g && g.id) || ""));
  const [ready, setReady] = useState(false);
  const ctl = useRef<Ctl | null>(null);
  const homeRef = useRef<Home | null>(null);
  const [hostW, setHostW] = useState(() => (aspect && aspect < 1.4 ? 390 : 760));
  const meL = me.toLowerCase();
  const players: TwoTruthsPlayer[] = (g && g.players) || NO_ITEMS;
  const rounds: TwoTruthsRound[] = (g && g.rounds) || NO_ITEMS;
  const finished = !!g && g.status === "finished";
  const running = !!g && g.status === "running";
  const meName = ((players.find((p) => String(p.name).toLowerCase() === meL) || {}) as Partial<TwoTruthsPlayer>).name || "";
  const big = hostW < PHONE_BELOW;

  // seats in turn order round the fire, you nearest the camera
  const seats: Seat[] = useMemo(() => {
    const order: string[] = (g && g.order) || [];
    const list = players.slice().sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name));
    const n = list.length;
    const mine = list.findIndex((p) => String(p.name).toLowerCase() === meL);
    return list.map((p: TwoTruthsPlayer, i: number) => {
      const a = Math.PI / 2 + ((i - (mine >= 0 ? mine : 0)) / Math.max(1, n)) * Math.PI * 2;
      return { name: String(p.name), hex: String(p.hex || "#fb923c"), you: String(p.name).toLowerCase() === meL, x: Math.cos(a) * SEAT_R, z: Math.sin(a) * SEAT_R, a };
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
  const [fx, setFx] = useState<{ id: number; at: [number, number, number]; hex: string }[]>([]);
  const fxId = useRef(0);
  const [ceremony, setCeremony] = useState(0);
  const [say, setSay] = useState("");

  useEffect(() => {
    if (!ready || go) return;
    const t = setTimeout(() => setGo(true), firstVisit && !still ? 2600 : 400);
    return () => clearTimeout(t);
  }, [ready, go, firstVisit, still]);

  const isLast = (n: number) => finished && n === rounds.length;
  const land = (n: number, quiet: boolean) => {
    const r = rounds[n - 1];
    setPlaying(null);
    setShown(n);
    if (!r) return;
    const imp = isLast(n) ? finalImpact(g!, meName) : roundImpact(r, meName);
    juice.hit(quiet ? { ...imp, trauma: 0, stop: 0, slow: 0, pulse: 0 } : imp);
    setSay(sayRound(r));
    if (isLast(n) && g!.winner) setCeremony((c) => c + 1);
  };

  useEffect(() => {
    if (!go || playing) return;
    const n = rounds.length;
    if (n <= shown) return;
    if (still) land(n, false);
    else {
      setRt(0);
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

  // a rival's vote lands (sealed): a soft ping; the statements going up: a whoosh
  const sig = running ? (g.phase || "") + ":" + players.filter((p) => p.committed).map((p) => p.name).join(",") : "";
  const prevSig = useRef<string | null>(null);
  useEffect(() => {
    const prev = prevSig.current;
    prevSig.current = sig;
    if (prev == null || !ready || prev === sig) return;
    if (prev.split(":")[0] === "write" && sig.split(":")[0] === "vote") sfx("whoosh");
    else juice.hit({ sound: "ping" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig, ready]);

  const r = playing ? rounds[playing.n - 1] : null;
  const voters = r && !r.forfeit ? Object.keys(r.votes || {}).filter((n) => r.votes[n] != null) : [];
  const flyAt = ANTIC + 0.1;
  const burnAt = flyAt + FLY + 0.45;
  const ptsAt = burnAt + 0.8;
  const doneAt = (r && r.forfeit ? 1.4 : ptsAt + 1.2) + (playing && isLast(playing.n) ? 1.6 : 0);
  const burn = r && !r.forfeit ? smooth(burnAt, burnAt + 0.6, rt) : 0;
  const glowK = r && !r.forfeit ? smooth(burnAt, burnAt + 0.4, rt) : 0;

  // the cards as the scene shows them
  const cards = (i: number): { text: string | null; mark: "" | "lie" | "true"; faceDown: boolean } => {
    if (r) {
      if (r.forfeit) return { text: null, mark: "", faceDown: true };
      const revealed = rt >= burnAt;
      return { text: (r.statements || [])[i] || "", mark: revealed ? (i + 1 === r.lie ? "lie" : "true") : "", faceDown: false };
    }
    if (running && g.phase === "vote") {
      const ss = g.statements || (g.you && g.you.statements) || [];
      const yl = g.you && g.you.teller ? g.you.lie : 0;
      return { text: ss[i] || "", mark: yl === i + 1 ? "lie" : "", faceDown: false };
    }
    if (finished && rounds.length) {
      const last = rounds[rounds.length - 1]!;
      if (!last.forfeit) return { text: (last.statements || [])[i] || "", mark: i + 1 === last.lie ? "lie" : "true", faceDown: false };
    }
    return { text: null, mark: "", faceDown: true };
  };
  const cardPos = (i: number): [number, number, number] => [(i - 1) * (CARD_W + CARD_GAP), CARD_Y - CARD_H / 2 - 0.05, CARD_Z - Math.abs(i - 1) * 0.22];

  // scores as shown: before the playing round's points land, the old totals
  const scoreOf = (name: string) => {
    let s = 0;
    const upto = playing ? (rt >= ptsAt ? playing.n : playing.n - 1) : rounds.length;
    rounds.slice(0, upto).forEach((x) => (s += (x.points || {})[name] || 0));
    return s;
  };
  const tellerNow = r ? r.teller : running ? g.teller : null;
  const champion = finished && g.winner ? seats.find((s) => s.name === g.winner) || null : null;
  const home = (a: number, width: number) => ttHome(a, width);
  const first = home(aspect || 1.6, hostW);
  const label =
    "Two Truths and a Lie, 3D view: " +
    (running ? (g.phase === "write" ? g.teller + " is writing round " + g.round + "'s statements. " : g.teller + "'s statements are up; " + players.filter((p) => p.committed).length + " voted. ") : "") +
    seats.map((s) => s.name + (s.you ? " (you)" : "") + " " + scoreOf(s.name)).join("; ") +
    ".";
  const intro = firstVisit ? { title: "Two Truths and a Lie", sub: seats.map((s) => s.name).join(" · ") || "Spot the lie", color: "#fb923c" } : null;
  const beats: [string, number][] = r && !r.forfeit ? [["fly", flyAt], ["land", flyAt + FLY], ["burn", burnAt], ["pts", ptsAt]] : [["burn", 0.5]];
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
          <color attach="background" args={["#02030a"]} />
          <fog attach="fog" args={["#060a1c", 16, 55]} />
          <SkyDome spec={TT_SKY} />
          <hemisphereLight args={["#93c5fd", "#0a0604", 0.35]} />
          <directionalLight position={[-4, 6, 6]} intensity={0.35} color="#c7d2fe" />
          <pointLight position={[0, 1.2, 0]} intensity={14} distance={9} decay={1.6} color="#fb923c" />
          <Clearing />
          <FireSystem fires={[{ key: "camp", x: 0, y: 0.12, z: 0, scale: 0.85, light: false, kind: "ship", heat: 1 }]} lite={q.lite} still={still} />
          {[0, 1, 2].map((i) => {
            const c = cards(i);
            const isLie = !!r && !r.forfeit && i + 1 === r.lie;
            return <Card key={i} i={i} text={c.text} mark={c.mark} faceDown={c.faceDown} burn={isLie ? burn : 0} glow={r && !r.forfeit && !isLie ? glowK : 0} still={still} />;
          })}
          {seats.map((s) => {
            const p = (players.find((x) => x.name === s.name) || {}) as Partial<TwoTruthsPlayer>;
            const ox = Math.cos(s.a);
            const oz = Math.sin(s.a);
            const teller = tellerNow === s.name;
            return (
              <group key={s.name}>
                <SeatMark s={s} lit={running && !r && !!p.committed && g.phase === "vote"} teller={teller && (running || !!r)} still={still} />
                <sprite position={s.you ? [s.x + ox * 0.75, 0.05, s.z + oz * 0.75] : [s.x, big ? 0.78 : 0.98, s.z]} scale={big ? [2.6, 1.04, 1] : [2.0, 0.8, 1]} renderOrder={5}>
                  <spriteMaterial
                    map={textTex([
                      { text: s.name + (s.you ? " (you)" : ""), color: s.hex, size: 42 },
                      { text: scoreOf(s.name) + " pts" + (teller && (running || r) ? " · telling" : ""), color: teller ? "#fde68a" : "rgba(254,243,199,0.9)", size: 32 },
                    ])}
                    transparent
                    depthWrite={false}
                    depthTest={false}
                  />
                </sprite>
                {r && !r.forfeit && rt >= ptsAt && (r.points || {})[s.name] ? (
                  <sprite position={s.you ? [s.x, 1.0 + Math.min(0.35, (rt - ptsAt) * 0.5), s.z] : [s.x, (big ? 1.32 : 1.5) + Math.min(0.25, (rt - ptsAt) * 0.4), s.z]} scale={[0.8, 0.44, 1]} renderOrder={6}>
                    <spriteMaterial map={pillTex("+" + r.points[s.name])} transparent depthWrite={false} depthTest={false} />
                  </sprite>
                ) : null}
              </group>
            );
          })}
          {r && !r.forfeit
            ? voters.map((n) => {
                const s = seats.find((x) => x.name === n);
                if (!s) return null;
                const v = r.votes[n] as number;
                const k = smooth(flyAt, flyAt + FLY, rt);
                const to = cardPos(v - 1);
                const spread = (voters.indexOf(n) - (voters.length - 1) / 2) * 0.22;
                return <Ember key={"e" + n} from={[s.x, 0.62, s.z]} to={[to[0] + spread, to[1], to[2] + 0.05]} hex={s.hex} k={k} />;
              })
            : null}
          {playing && r && playing.t0 == null ? <ClockStart key={"c" + playing.n} onStart={(t) => setPlaying((p) => (p && p.t0 == null ? { ...p, t0: t } : p))} /> : null}
          {playing && r && playing.t0 != null ? (
            <Beats
              key={"b" + playing.n}
              t0={playing.t0}
              beats={beats}
              doneAt={doneAt}
              onT={setRt}
              onBeat={(k) => {
                if (k === "fly") sfx("whoosh");
                else if (k === "land") sfx("ping");
                else if (k === "burn") {
                  juice.hit(roundImpact(r, meName));
                  setSay(sayRound(r));
                  if (!r.forfeit && !q.lite) {
                    const at = cardPos(r.lie! - 1);
                    setFx((l) => [...l.slice(-4), { id: ++fxId.current, at: [at[0], CARD_Y, at[2]], hex: "#f97316" }]);
                  }
                } else if (k === "pts" && isLast(playing.n)) {
                  setTimeout(() => {
                    juice.hit(finalImpact(g!, meName));
                    if (g!.winner) setCeremony((c) => c + 1);
                  }, 700);
                }
              }}
              onDone={() => {
                setPlaying(null);
                setShown(playing.n);
              }}
            />
          ) : null}
          {fx.map((f) => (
            <Burst key={f.id} at={f.at} hex={f.hex} box={[1.4, 0.9, 0.1]} count={q.lite ? 24 : 50} power={1.6} piece={0.06} dur={1.2} onDone={() => setFx((l) => l.filter((x) => x.id !== f.id))} />
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
