/* Exquisite Corpse in 3D: the writing desk.

   The world: a dark study, a wide desk lit by one candle. The story is a
   pile of folded pages in the middle - one page per segment, its edge in
   the author's ink, every face turned down; on your turn the top page
   lies face up with the one segment you may read. An inkwell and quill
   per writer stand along the near edge: lit and pulsing for the writer
   now, dark for one out of the rotation, steady once they have voted.

   The reveal deals the pile out across the desk, page by page, face up:
   the seed, then every segment with its author. At the end the favourite
   votes drop onto the pages as gold stars and the honours page lights,
   with the winner's pillar. Catch-up, tap to skip and reduced motion as
   in the other arenas; the full text lives in the page under the scene. */
import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { CameraControls } from "@react-three/drei";
import { CanvasTexture, Color, SRGBColorSpace, type Group, type MeshStandardMaterial } from "three";
import { ArenaFrame, FirstFrame, Framer, Ticker, TouchControls, goHome, useQuality, useReducedMotion, type Ctl, type Home } from "../three/arena3d";
import { ArenaPost, ImpactLayer, Intro, JuiceProvider, JuiceRig, SoundToggle, useFirstVisit, useJuice, useJuiceStore, type Impact } from "../three/juice";
import { LightPillar, SkyDome, type SkySpec } from "../three/atmos";
import { FireSystem } from "../three/fire";
import { BUZZ, sfx } from "../three/sfx";
import type { CorpseBeat, CorpsePlayer, CorpseSegment, CorpseState } from "@chat/contract";

// One empty list for matches without players or rounds yet, so the memos
// below keep their inputs from one render to the next.
const NO_ITEMS: never[] = [];

const EC_SKY: SkySpec = {
  top: "#030202",
  mid: "#080504",
  horizon: "#150c07",
  ground: "#030202",
  glow: "#f59e0b",
  glowAmt: 0.08,
  stars: 0,
};

const PHONE_BELOW = 560;
const PW = 1.6;
const PH = 1.12;
const GAP = 0.14;
const DEAL = 0.22; // between pages
const dealAt = (i: number) => 0.4 + i * DEAL;
const FLIGHT = 0.55;
/** a writer's ink colour, from the players list */
const hexIn = (players: CorpsePlayer[], n: string) => (players.find((p) => p.name === n) || {}).hex || "#94a3b8";

type Seat = { name: string; hex: string; you: boolean; x: number; z: number };

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

// a page: parchment, a header in the author's ink, the text wrapped to
// fit; or its back (folded away)
const pageCache = new Map<string, CanvasTexture>();
function pageTex(head: string, hex: string, text: string | null, italic: boolean): CanvasTexture {
  const key = head + "|" + hex + "|" + (text || "") + "|" + italic;
  const hit = pageCache.get(key);
  if (hit) return hit;
  const W = 640;
  const H = 448;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const x = c.getContext("2d");
  if (x) {
    x.fillStyle = text == null ? "#cbbd9c" : "#f3e9d2";
    x.fillRect(0, 0, W, H);
    x.fillStyle = hex;
    x.fillRect(0, 0, W, 14);
    if (text == null) {
      // the back: fold creases and a blot of the author's ink
      x.strokeStyle = "rgba(90,70,40,0.35)";
      x.lineWidth = 4;
      for (const yy of [H / 3, (2 * H) / 3]) {
        x.beginPath();
        x.moveTo(20, yy);
        x.lineTo(W - 20, yy);
        x.stroke();
      }
      x.fillStyle = hex;
      x.globalAlpha = 0.55;
      x.beginPath();
      x.arc(W - 70, H - 70, 26, 0, Math.PI * 2);
      x.fill();
      x.globalAlpha = 1;
    } else {
      x.fillStyle = hex;
      x.font = "900 40px system-ui, sans-serif";
      x.textAlign = "left";
      x.textBaseline = "top";
      x.fillText(head, 28, 30);
      x.fillStyle = "#1c1917";
      x.textAlign = "center";
      let size = 36;
      let lines: string[] = [];
      for (; size >= 20; size -= 2) {
        x.font = (italic ? "italic " : "") + "600 " + size + "px Georgia, 'Times New Roman', serif";
        lines = [];
        let cur = "";
        for (const w of text.split(" ")) {
          const t = cur ? cur + " " + w : w;
          if (x.measureText(t).width > W - 70 && cur) {
            lines.push(cur);
            cur = w;
          } else cur = t;
        }
        if (cur) lines.push(cur);
        if (lines.length * size * 1.25 <= H - 110) break;
      }
      const top = 92 + (H - 110 - lines.length * size * 1.25) / 2;
      lines.forEach((l, i) => x.fillText(l, W / 2, top + i * size * 1.25 + size * 0.55));
    }
  }
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  pageCache.set(key, t);
  return t;
}

/* ---------- pieces ---------- */

function Desk({ w, d }: { w: number; d: number }) {
  return (
    <group>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -1.2, 0]}>
        <planeGeometry args={[200, 200]} />
        <meshStandardMaterial color="#070403" roughness={1} />
      </mesh>
      <mesh position={[0, -0.12, 0]}>
        <boxGeometry args={[w, 0.24, d]} />
        <meshStandardMaterial color="#3b2414" roughness={0.55} metalness={0.05} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.002, 0]}>
        <planeGeometry args={[w - 0.5, d - 0.5]} />
        <meshStandardMaterial color="#14301f" roughness={0.95} />
      </mesh>
    </group>
  );
}

function Candle({ x, z, lite, still }: { x: number; z: number; lite: boolean; still: boolean }) {
  return (
    <group>
      <mesh position={[x, 0.32, z]}>
        <cylinderGeometry args={[0.11, 0.12, 0.64, 16]} />
        <meshStandardMaterial color="#f5f0e1" roughness={0.6} emissive="#fbbf24" emissiveIntensity={0.08} />
      </mesh>
      <FireSystem fires={[{ key: "candle", x, y: 0.66, z, scale: 0.16, light: false, kind: "ship", heat: 1 }]} lite={lite} still={still} />
    </group>
  );
}

/* A writer's inkwell and quill: lit and pulsing while they write, dark
   when out, steady once they have voted. */
function Inkwell({ s, writing, voted, out, still }: { s: Seat; writing: boolean; voted: boolean; out: boolean; still: boolean }) {
  const ink = useRef<MeshStandardMaterial>(null);
  const j = useJuice();
  useFrame(() => {
    if (ink.current) ink.current.emissiveIntensity = out ? 0.05 : writing ? 1.6 + (still ? 0 : 0.7 * Math.sin(j.t * 4)) : voted ? 1.4 : 0.3;
  });
  return (
    <group position={[s.x, 0, s.z]}>
      <mesh position={[0, 0.14, 0]}>
        <cylinderGeometry args={[0.16, 0.2, 0.28, 18]} />
        <meshStandardMaterial color="#111" roughness={0.3} metalness={0.4} />
      </mesh>
      <mesh position={[0, 0.29, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <circleGeometry args={[0.12, 18]} />
        <meshStandardMaterial ref={ink} color="#000" emissive={out ? "#444" : s.hex} emissiveIntensity={0.3} toneMapped={false} />
      </mesh>
      <mesh position={[0.08, 0.55, -0.05]} rotation={[0.35, 0, -0.35]}>
        <coneGeometry args={[0.05, 0.75, 6]} />
        <meshStandardMaterial color={out ? "#555" : "#e7e5e4"} roughness={0.8} />
      </mesh>
    </group>
  );
}

type PageSpec = { key: string; head: string; hex: string; text: string | null; italic: boolean; from: [number, number, number]; to: [number, number, number]; k: number; glow: number; stars: number };

function Page({ p, still }: { p: PageSpec; still: boolean }) {
  const g = useRef<Group>(null);
  const mat = useRef<MeshStandardMaterial>(null);
  const j = useJuice();
  useFrame(() => {
    const o = g.current;
    if (!o) return;
    const e = p.k * p.k * (3 - 2 * p.k);
    o.position.set(p.from[0] + (p.to[0] - p.from[0]) * e, p.from[1] + (p.to[1] - p.from[1]) * e + Math.sin(Math.PI * e) * 0.9, p.from[2] + (p.to[2] - p.from[2]) * e);
    // face down in the pile, flipping face up on the way
    o.rotation.set(-Math.PI / 2 + (1 - e) * Math.PI, 0, 0);
    if (mat.current) mat.current.emissiveIntensity = 0.06 + p.glow * (0.18 + (still ? 0 : 0.05 * Math.sin(j.t * 3)));
  });
  const map = useMemo(() => pageTex(p.head, p.hex, p.text, p.italic), [p.head, p.hex, p.text, p.italic]);
  return (
    <group ref={g}>
      <mesh>
        <planeGeometry args={[PW, PH]} />
        <meshStandardMaterial ref={mat} map={map} emissiveMap={map} emissive="#ffffff" emissiveIntensity={0.06} roughness={0.9} side={2} toneMapped={false} />
      </mesh>
      {p.glow ? (
        <mesh position={[0, 0, -0.005]}>
          <planeGeometry args={[PW + 0.16, PH + 0.16]} />
          <meshBasicMaterial color={new Color("#f59e0b").multiplyScalar(1.6)} toneMapped={false} side={2} />
        </mesh>
      ) : null}
      {Array.from({ length: Math.min(6, p.stars) }, (_, i) => (
        <mesh key={i} position={[PW / 2 - 0.22 - i * 0.28, PH / 2 - 0.22, 0.08]}>
          <icosahedronGeometry args={[0.13, 0]} />
          <meshStandardMaterial color="#000" emissive={new Color("#fbbf24").multiplyScalar(1.6)} emissiveIntensity={1.4} toneMapped={false} flatShading />
        </mesh>
      ))}
    </group>
  );
}

/* The pile before the reveal: a stack of folded pages, edges in each
   author's ink; on your turn the top page lies face up with your tail. */
function Pile({ g, tail, hexOf, still }: { g: CorpseState | null; tail: string | null; hexOf: (n: string) => string; still: boolean }) {
  const beats: CorpseBeat[] = ((g && g.beats) || []).filter((b: CorpseBeat) => b.wrote);
  const top = useRef<Group>(null);
  const j = useJuice();
  const held = tail != null;
  useFrame(() => {
    const o = top.current;
    if (!o) return;
    const base = 0.02 + beats.length * 0.025 + 0.02;
    // your tail rises off the pile and tips toward you, large enough to read
    o.position.set(0, held ? 0.75 + (still ? 0 : Math.sin(j.t * 1.3) * 0.03) : base, held ? 0.6 : 0);
    o.rotation.set(held ? -Math.PI / 2 + 0.85 : -Math.PI / 2, 0, 0);
    o.scale.setScalar(held ? 1.9 : 1);
  });
  return (
    <group>
      {beats.map((b, i) => (
        <mesh key={i} position={[(i % 3) * 0.03 - 0.03, 0.012 + i * 0.025, (i % 2) * 0.03]} rotation={[0, (i % 5) * 0.03 - 0.06, 0]}>
          <boxGeometry args={[PW, 0.02, PH]} />
          <meshStandardMaterial color={new Color(hexOf(b.by)).lerp(new Color("#cbbd9c"), 0.55)} roughness={0.9} />
        </mesh>
      ))}
      <group ref={top} position={[0, 0.02 + beats.length * 0.025 + 0.02, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <mesh>
          <planeGeometry args={[PW, PH]} />
          <meshStandardMaterial map={pageTex(tail != null ? (g!.segments ? "The segment before yours" : "The seed line") : "", tail != null ? "#b45309" : "#7c5c34", tail, tail != null && !g!.segments)} roughness={0.9} toneMapped={false} />
        </mesh>
      </group>
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

function Clock({ t0, doneAt, beats, onT, onBeat, onDone }: { t0: number; doneAt: number; beats: [string, number][]; onT: (t: number) => void; onBeat: (k: string) => void; onDone: () => void }) {
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

/* ---------- impacts ---------- */

function revealImpact(g: CorpseState): Impact {
  const writers = new Set(((g.story || []) as CorpseSegment[]).map((s) => s.by)).size;
  return { trauma: 0.2, stop: 80, pulse: 0.5, sound: ["whoosh", "win"], title: { big: "THE STORY", small: (g.story || []).length + " segments by " + writers + (writers === 1 ? " writer" : " writers") + " - vote for a favourite", tone: "neutral" } };
}

function honoursImpact(g: CorpseState, me: string): Impact {
  const hs: number[] = g.honours || [];
  const story: CorpseSegment[] = g.story || [];
  const authors = [...new Set(hs.map((k) => (story[k - 1] || {}).by).filter(Boolean))] as string[];
  if (!hs.length) return { trauma: 0.2, stop: 80, sound: "whoosh", title: { big: "THE END", small: "Nobody voted for a favourite", tone: "neutral" } };
  const n = (g.votes || {})[hs[0] as number] || 0;
  if (me && authors.indexOf(me) >= 0) return { trauma: 0.7, stop: 220, slow: 0.6, pulse: 1, buzz: BUZZ.wonMatch, sound: ["clash", "win"], title: { big: authors.length > 1 ? "SHARED HONOURS" : "THE HONOURS", small: "Your segment " + hs.filter((k) => (story[k - 1] || {}).by === me).join(" and ") + " · " + n + (n === 1 ? " vote" : " votes"), tone: "good" } };
  return { trauma: 0.5, stop: 180, slow: 0.5, pulse: 0.8, buzz: BUZZ.scored, sound: ["clash", "win"], title: { big: authors.length > 1 ? "SHARED HONOURS" : "★ " + (authors[0] || "").toUpperCase(), small: "Segment " + hs.join(" and ") + " · " + n + (n === 1 ? " vote" : " votes"), tone: "neutral" } };
}

/* ---------- what the viewer has seen ---------- */

function seenKey(id: unknown): string {
  let path = "";
  try {
    path = location.pathname;
  } catch {
    path = "";
  }
  return "ac-ec-seen:" + path + ":" + String(id);
}
function readSeen(id: unknown): string | null {
  try {
    return localStorage.getItem(seenKey(id));
  } catch {
    return null;
  }
}
function writeSeen(id: unknown, v: string) {
  try {
    localStorage.setItem(seenKey(id), v);
  } catch {
    // storage unavailable: the next open just won't replay
  }
}

/* The grid the story is dealt into: the seed then every segment. */
function layout(count: number, phone: boolean): { cols: number; rows: number; w: number; d: number; spot: (i: number) => [number, number, number] } {
  const cols = Math.max(2, Math.min(phone ? 3 : 5, Math.ceil(Math.sqrt(count * 1.6))));
  const rows = Math.max(1, Math.ceil(count / cols));
  const w = cols * (PW + GAP) + 0.9;
  const d = rows * (PH + GAP) + 1.9;
  const spot = (i: number): [number, number, number] => {
    const c = i % cols;
    const r = Math.floor(i / cols);
    return [(c - (cols - 1) / 2) * (PW + GAP), 0.02 + i * 0.0005, (r - (rows - 1) / 2) * (PH + GAP) - 0.45];
  };
  return { cols, rows, w, d, spot };
}

function ecHome(aspect: number, width: number, count: number): Home {
  const phone = width < PHONE_BELOW;
  const L = layout(count, phone);
  const vfov = aspect < 1 ? 56 : 46;
  const tv = Math.tan((vfov * Math.PI) / 360);
  const th = tv * Math.max(0.45, aspect);
  const el = ((phone ? 62 : 56) * Math.PI) / 180;
  const pts: [number, number, number][] = [
    [-L.w / 2, 0, -L.d / 2],
    [L.w / 2, 0, -L.d / 2],
    [-L.w / 2, 0, L.d / 2 + 0.3],
    [L.w / 2, 0, L.d / 2 + 0.3],
    [0, 1.0, 0],
  ];
  const at = (d: number) => {
    const cy = d * Math.sin(el);
    const cz = d * Math.cos(el);
    const angs = pts.map(([, y, z]) => Math.atan2(cy - y, cz - z));
    return { cy, cz, pitch: (Math.max(...angs) + Math.min(...angs)) / 2 - 0.05 * Math.atan(tv) };
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
      return Math.abs(x / (zc * th)) <= 0.96 && v <= 0.86 && v >= -0.96;
    });
  };
  let lo = 2;
  let hi = 80;
  for (let k = 0; k < 28; k++) {
    const mid = (lo + hi) / 2;
    if (fits(mid)) hi = mid;
    else lo = mid;
  }
  const { cy, cz, pitch } = at(hi);
  return { pos: [0, cy, cz], fov: vfov, tz: cz - cy / Math.tan(pitch) };
}

/* ---------- the arena ---------- */

export default function CorpseArena3D({
  g,
  me = "",
  aspect,
  onReady,
  registerCommit,
}: {
  g: CorpseState;
  me?: string;
  aspect?: number;
  onReady?: () => void;
  registerCommit?: (fn: (() => void) | null) => void;
}) {
  const still = useReducedMotion();
  const q = useQuality(still);
  const juice = useJuiceStore(still);
  const firstVisit = useFirstVisit("ec:" + String((g && g.id) || ""));
  const [ready, setReady] = useState(false);
  const ctl = useRef<Ctl | null>(null);
  const homeRef = useRef<Home | null>(null);
  const [hostW, setHostW] = useState(() => (aspect && aspect < 1.4 ? 390 : 760));
  const meL = me.toLowerCase();
  const players: CorpsePlayer[] = (g && g.players) || NO_ITEMS;
  const finished = !!g && g.status === "finished";
  const running = !!g && g.status === "running";
  const revealed = !!g && !!g.story;
  const phone = hostW < PHONE_BELOW;
  const meName = (players.find((p) => String(p.name).toLowerCase() === meL) || {}).name || "";
  const hexOf = (n: string) => hexIn(players, n);
  const total = ((g && g.turns_total) || 3) + 1;
  const L = layout(revealed ? (g.story || []).length + 1 : total, phone);

  // writers' inkwells along the near edge, in rotation order
  const seats: Seat[] = useMemo(() => {
    const order: string[] = (g && g.order) || [];
    const list = players.slice().sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name));
    const n = list.length;
    const span = Math.min(L.w - 1.2, n * 1.5);
    return list.map((p: CorpsePlayer, i: number) => ({ name: String(p.name), hex: String(p.hex || "#a16207"), you: String(p.name).toLowerCase() === meL, x: n > 1 ? (i / (n - 1) - 0.5) * span : 0, z: L.d / 2 - 0.55 }));
  }, [players, meL, g, L.w, L.d]);

  // what still has to play: the deal (on reveal) and the honours (at the end)
  // a first open shows the story as it stands; later opens replay what
  // the viewer has not seen yet
  const [init] = useState(() => {
    const seen = readSeen(g && g.id);
    if (seen == null) return { dealt: revealed, honoured: finished };
    return { dealt: seen.indexOf("r") >= 0, honoured: seen.indexOf("f") >= 0 };
  });
  const [dealt, setDealt] = useState(init.dealt);
  const [honoured, setHonoured] = useState(init.honoured);
  const [playing, setPlaying] = useState<{ kind: "deal" | "honours"; t0: number | null } | null>(null);
  const [go, setGo] = useState(false);
  const [rt, setRt] = useState(0);
  const [ceremony, setCeremony] = useState(0);
  const [say, setSay] = useState("");

  useEffect(() => {
    if (!ready || go) return;
    const t = setTimeout(() => setGo(true), firstVisit && !still ? 2600 : 400);
    return () => clearTimeout(t);
  }, [ready, go, firstVisit, still]);

  const seenId = g && g.id;
  useEffect(() => {
    writeSeen(seenId, (dealt ? "r" : "") + (honoured ? "f" : ""));
  }, [seenId, dealt, honoured]);

  const story: CorpseSegment[] = (g && g.story) || NO_ITEMS;
  const dealDone = dealAt(story.length + 1) + FLIGHT + 0.6;
  const starsAt = 0.5;
  const honoursDone = starsAt + 1.4 + 2.2;

  const land = (kind: "deal" | "honours") => {
    setPlaying(null);
    if (kind === "deal") {
      setDealt(true);
      juice.hit(revealImpact(g));
      setSay("The story is revealed: " + story.length + " segments.");
    } else {
      setHonoured(true);
      juice.hit(honoursImpact(g, meName));
      setSay(g.honours && g.honours.length ? "The honours go to segment " + g.honours.join(" and ") + "." : "Nobody voted.");
      if (g.winner) setCeremony((c) => c + 1);
    }
  };

  const onLand = useEffectEvent(land);
  useEffect(() => {
    if (!go || playing) return;
    if (revealed && !dealt) {
      // oxlint-disable-next-line react/set-state-in-effect -- new rounds from the server step the replay: reduced motion lands one at once, with its title, sound and buzz
      if (still) onLand("deal");
      else {
        setRt(0);
        setPlaying({ kind: "deal", t0: null });
      }
      return;
    }
    if (finished && dealt && !honoured) {
      if (still) onLand("honours");
      else {
        setRt(0);
        setPlaying({ kind: "honours", t0: null });
      }
    }
  }, [go, playing, revealed, finished, dealt, honoured, still]);

  const skip = () => {
    if (playing) land(playing.kind);
  };

  useEffect(() => {
    if (!registerCommit) return;
    registerCommit(() => juice.hit({ sound: "lock", buzz: BUZZ.commit }));
    return () => registerCommit(null);
  }, [registerCommit, juice]);

  // a rival's segment lands on the pile; a sealed vote comes in
  const sig = running ? (g.phase || "") + ":" + (g.segments || 0) + ":" + players.filter((p) => p.committed).length : "";
  const prevSig = useRef<string | null>(null);
  useEffect(() => {
    const prev = prevSig.current;
    prevSig.current = sig;
    if (prev == null || !ready || prev === sig) return;
    juice.hit({ sound: "ping" });
  }, [sig, ready, juice]);

  // the pages, dealt out (or still in the pile)
  const pages: PageSpec[] = useMemo(() => {
    if (!revealed) return [];
    const pile: [number, number, number] = [0, 0.4, 0];
    const all = [{ head: "The seed", hex: "#7c5c34", text: g.seed || "", italic: true, by: null as string | null, n: 0 }].concat(story.map((s) => ({ head: s.n + " · " + s.by, hex: hexIn(players, s.by), text: s.text, italic: false, by: s.by, n: s.n })));
    const hs: number[] = g.honours || [];
    return all.map((p, i) => {
      const k = !dealt && playing && playing.kind === "deal" ? smooth(dealAt(i), dealAt(i) + FLIGHT, rt) : dealt ? 1 : 0;
      const showStars = finished && (honoured || (playing && playing.kind === "honours" && rt >= starsAt + 0.15 * i));
      const best = p.n > 0 && hs.indexOf(p.n) >= 0 && (honoured || (playing && playing.kind === "honours" && rt >= starsAt + 1.4));
      return { key: "p" + i, head: p.head, hex: p.hex, text: p.text, italic: p.italic, from: pile, to: L.spot(i), k, glow: best ? 1 : 0, stars: showStars && p.n ? (g.votes || {})[p.n] || 0 : 0 };
    });
  }, [revealed, story, players, dealt, playing, rt, finished, honoured, g, L]);

  const tail = running && g.you && g.you.writer ? g.you.tail || "" : null;
  const champion = finished && g.winner ? seats.find((s) => s.name === g.winner) || null : null;
  const bestPage = finished && (g.honours || []).length ? L.spot(g.honours![0]!) : null;
  const home = (a: number, width: number) => ecHome(a, width, revealed ? story.length + 1 : total);
  const first = home(aspect || 1.6, hostW);
  const label =
    "Exquisite Corpse, 3D view: " +
    (running && g.phase === "write" ? "turn " + g.turn + " of " + g.turns_total + ", " + g.turn_of + " is writing; " + (g.segments || 0) + " segments in the pile, folded away. " : revealed ? "the story is revealed, " + story.length + " segments. " : "") +
    seats.map((s) => s.name + (s.you ? " (you)" : "")).join(", ") +
    ".";
  const intro = firstVisit ? { title: "Exquisite Corpse", sub: seats.map((s) => s.name).join(" · ") || "One story, folded", color: "#f59e0b" } : null;
  const beats: [string, number][] = playing && playing.kind === "deal" ? [["start", 0.3]] : [["stars", starsAt], ["best", starsAt + 1.4]];
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
            {playing ? (
              <div className="duel-catchup" aria-hidden="true">
                {playing.kind === "deal" ? "The reveal" : "The honours"} · tap to skip
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
          <color attach="background" args={["#030202"]} />
          <fog attach="fog" args={["#080504", 20, 70]} />
          <SkyDome spec={EC_SKY} />
          <hemisphereLight args={["#fde68a", "#0a0604", 0.45]} />
          <directionalLight position={[-3, 9, 5]} intensity={0.55} color="#fff7ed" />
          <pointLight position={[L.w / 2 - 0.6, 1.4, -L.d / 2 + 0.6]} intensity={10} distance={14} decay={1.4} color="#fbbf24" />
          <Desk w={L.w} d={L.d} />
          <Candle x={L.w / 2 - 0.6} z={-L.d / 2 + 0.6} lite={q.lite} still={still} />
          {!revealed || (!dealt && !playing) ? <Pile g={g} tail={tail} hexOf={hexOf} still={still} /> : null}
          {revealed && (dealt || playing) ? pages.map((p) => <Page key={p.key} p={p} still={still} />) : null}
          {seats.map((s) => {
            const p: Partial<CorpsePlayer> = players.find((x) => x.name === s.name) || {};
            return (
              <group key={s.name}>
                <Inkwell s={s} writing={running && g.phase === "write" && g.turn_of === s.name} voted={running && g.phase === "vote" && !!p.committed} out={!!p.out} still={still} />
                <sprite position={[s.x, 0.05, s.z + 0.55]} scale={phone ? [2.4, 0.96, 1] : [1.8, 0.72, 1]} renderOrder={5}>
                  <spriteMaterial
                    map={textTex([
                      { text: s.name + (s.you ? " (you)" : ""), color: s.hex, size: 42 },
                      { text: p.out ? "out" : running && g.phase === "write" && g.turn_of === s.name ? "writing…" : (p.segments || 0) + (p.segments === 1 ? " segment" : " segments") + (finished && p.votes ? " · ★" + p.votes : ""), color: "rgba(254,243,199,0.92)", size: 30 },
                    ])}
                    transparent
                    depthWrite={false}
                    depthTest={false}
                  />
                </sprite>
              </group>
            );
          })}
          {playing && playing.t0 == null ? <ClockStart key={"c" + playing.kind} onStart={(t) => setPlaying((p) => (p && p.t0 == null ? { ...p, t0: t } : p))} /> : null}
          {playing && playing.t0 != null ? (
            <Clock
              key={"k" + playing.kind}
              t0={playing.t0}
              doneAt={playing.kind === "deal" ? dealDone : honoursDone}
              beats={beats}
              onT={setRt}
              onBeat={(k) => {
                if (k === "start") sfx("whoosh");
                else if (k === "stars") sfx("beat");
                else if (k === "best") {
                  juice.hit(honoursImpact(g, meName));
                  if (g.winner) setCeremony((c) => c + 1);
                }
              }}
              onDone={() => {
                const kind = playing.kind;
                setPlaying(null);
                if (kind === "deal") {
                  setDealt(true);
                  juice.hit(revealImpact(g));
                  setSay("The story is revealed: " + story.length + " segments.");
                } else setHonoured(true);
              }}
            />
          ) : null}
          {ceremony && champion && bestPage && !still ? (
            <group key={"cer" + ceremony}>
              <LightPillar at={[bestPage[0], 0, bestPage[2]]} hex={champion.hex} height={10} width={0.9} />
            </group>
          ) : null}
          <CameraControls ref={ctl} makeDefault minDistance={4} maxDistance={60} maxPolarAngle={Math.PI / 2.1} />
          <TouchControls ctl={ctl} />
          <Framer home={home} ctl={ctl} homeRef={homeRef} />
          <Intro ctl={ctl} homeRef={homeRef} enabled={!!intro && !still} ready={ready} />
          <ArenaPost q={q} bloom={0.8} threshold={0.95} vignette={0.6} />
        </Canvas>
      </ArenaFrame>
    </JuiceProvider>
  );
}
