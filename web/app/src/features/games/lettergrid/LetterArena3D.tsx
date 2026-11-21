/* Letter Grid in 3D (2026-11-20): the tile garden.

   The world: a square of ivory letter tiles on an obsidian plinth under
   a deep teal night, a warm lamp from the viewer's side. A claimed tile
   takes its owner's colour and a halo beneath it (the second channel:
   the owner's first two letters ride in the tile's corner, so colour never stands
   alone). Your word in progress lifts its tiles and runs a white ribbon
   through them; tap tiles to trace one (the page's input does the same).
   Your sealed word shows to you alone as a faint ribbon.

   A round's reveal plays on the juice clock: each player's word draws in
   as a ribbon of light in their colour, lowest score first, the tiles it
   passes rising in turn; when it lands, the cells it claimed flip to its
   owner with a burst, a contested cell sparks white, a shared word draws
   grey. The last round of the match adds the ceremony from the viewer's
   seat. Catch-up: the rounds seen are remembered per game (localStorage)
   and the latest unseen round replays on open (a tap skips); reduced
   motion lands it at once with its title and sound. */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { CameraControls } from "@react-three/drei";
import { CanvasTexture, Color, CurvePath, LineCurve3, Object3D, SRGBColorSpace, TubeGeometry, Vector3, type InstancedMesh, type Mesh } from "three";
import { ArenaFrame, FirstFrame, Framer, Ticker, TouchControls, fitHome, goHome, useQuality, useReducedMotion, type Ctl, type Home } from "../three/arena3d";
import { ArenaPost, ImpactLayer, Intro, JuiceProvider, JuiceRig, SoundToggle, useFirstVisit, useJuice, useJuiceStore, type Impact } from "../three/juice";
import { Burst, LightPillar, Shockwave, SkyDome, type SkySpec } from "../three/atmos";
import { BUZZ } from "../three/sfx";

// One empty list for matches without players or rounds yet, so the memos
// below keep their inputs from one render to the next.
const NO_ITEMS: never[] = [];

const LG_SKY: SkySpec = {
  top: "#020509",
  mid: "#05141a",
  horizon: "#0f3a3f",
  ground: "#020406",
  glow: "#2dd4bf",
  glowAmt: 0.35,
  stars: 0.14,
};

const GAP = 1.08;
const TILE = 0.92;
const TILE_H = 0.34;
const PHONE_BELOW = 560;
const WORD_GAP = 0.85; // seconds between words in a reveal
const DRAW = 0.55; // seconds a ribbon takes to draw in
const IVORY = "#fbf5e6";

type Seat = { name: string; hex: string; you: boolean };
type Word = { by: string; word: string; path: number[][]; points: number; claimed: number[]; contested: number[]; dup: boolean };

const cx = (c: number, n: number) => (c - (n - 1) / 2) * GAP;
const cz = (r: number, n: number) => (r - (n - 1) / 2) * GAP;

/* ---------- letters: one canvas texture per letter and ink ---------- */

const letterCache = new Map<string, CanvasTexture>();
function letterTex(ch: string, ink: string, glow: string | null, corner: string): CanvasTexture {
  const key = ch + "|" + ink + "|" + (glow || "") + "|" + corner;
  const hit = letterCache.get(key);
  if (hit) return hit;
  const c = document.createElement("canvas");
  c.width = 128;
  c.height = 128;
  const x = c.getContext("2d");
  if (x) {
    x.textAlign = "center";
    x.textBaseline = "middle";
    x.font = "800 84px Georgia, 'Times New Roman', serif";
    if (glow) {
      x.shadowColor = glow;
      x.shadowBlur = 14;
    }
    x.fillStyle = ink;
    x.fillText(ch, 64, 70);
    if (corner) {
      x.shadowBlur = 0;
      x.font = "800 22px system-ui, -apple-system, Segoe UI, sans-serif";
      x.textAlign = "right";
      x.fillStyle = ink;
      x.globalAlpha = 0.85;
      x.fillText(corner, 118, 20);
    }
  }
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  t.anisotropy = 4;
  letterCache.set(key, t);
  return t;
}

/* ---------- the plinth ---------- */

let poolCache: CanvasTexture | null = null;
function poolTex(): CanvasTexture {
  if (poolCache) return poolCache;
  const c = document.createElement("canvas");
  c.width = 256;
  c.height = 256;
  const x = c.getContext("2d");
  if (x) {
    const gr = x.createRadialGradient(128, 128, 10, 128, 128, 128);
    gr.addColorStop(0, "rgba(45, 212, 191, 0.32)");
    gr.addColorStop(0.45, "rgba(20, 110, 110, 0.14)");
    gr.addColorStop(1, "rgba(0, 0, 0, 0)");
    x.fillStyle = gr;
    x.fillRect(0, 0, 256, 256);
  }
  poolCache = new CanvasTexture(c);
  poolCache.colorSpace = SRGBColorSpace;
  return poolCache;
}

function Plinth({ n, still }: { n: number; still: boolean }) {
  const j = useJuice();
  const rim = useRef<any>(null);
  useFrame(() => {
    if (rim.current) rim.current.emissiveIntensity = 0.5 + (still ? 0 : 0.12 * Math.sin(j.t * 0.9));
  });
  const S = n * GAP + 0.5;
  return (
    <group>
      <mesh position={[0, -0.12, 0]}>
        <boxGeometry args={[S, 0.24, S]} />
        <meshStandardMaterial color="#0b1114" metalness={0.55} roughness={0.32} />
      </mesh>
      <mesh position={[0, -0.005, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[S * 0.71, S * 0.72, 4, 1, Math.PI / 4]} />
        <meshStandardMaterial ref={rim} color="#0b1114" emissive="#2dd4bf" emissiveIntensity={0.55} toneMapped={false} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.25, 0]}>
        <planeGeometry args={[300, 300]} />
        <meshStandardMaterial color="#03070a" metalness={0.8} roughness={0.3} />
      </mesh>
      {/* a pool of teal light under the plinth, so the board sits somewhere */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.24, 0]} raycast={() => null}>
        <planeGeometry args={[S * 3.2, S * 3.2]} />
        <meshBasicMaterial map={poolTex()} transparent depthWrite={false} toneMapped={false} />
      </mesh>
    </group>
  );
}

/* ---------- the tiles ---------- */

/* Every tile in one instanced draw (colour per tile: ivory, or its
   owner's), the halos under claimed tiles in another, and one letter
   plane per tile. Lifts ease toward their targets on the juice clock:
   the draft's tiles stand up, a word in a reveal pops the tiles it
   passes as its ribbon reaches them. */
function Tiles({
  grid,
  owners,
  seats,
  draft,
  pulses,
  still,
  onCell,
}: {
  grid: string[];
  owners: (string | null)[];
  seats: Seat[];
  draft: Set<number>;
  pulses: { k: number; at: number }[];
  still: boolean;
  onCell?: (r: number, c: number) => void;
}) {
  const n = grid.length;
  const tiles = useRef<InstancedMesh>(null);
  const halos = useRef<InstancedMesh>(null);
  const letters = useRef<(Mesh | null)[]>([]);
  const j = useJuice();
  const o = useMemo(() => new Object3D(), []);
  const col = useMemo(() => new Color(), []);
  const lift = useRef<number[]>(new Array(n * n).fill(0));
  const lastT = useRef<number | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const hexOf = useMemo(() => {
    const m: Record<string, string> = {};
    seats.forEach((s) => (m[s.name] = s.hex));
    return m;
  }, [seats]);
  const dirty = useRef(true);
  useEffect(() => {
    dirty.current = true;
  }, [owners, draft, pulses, hover, seats]);
  useFrame((state) => {
    const a = tiles.current;
    const h = halos.current;
    if (!a || !h) return;
    const dt = lastT.current == null ? 0 : Math.min(0.1, Math.max(0, j.t - lastT.current));
    lastT.current = j.t;
    let moving = false;
    let nh = 0;
    for (let r = 0; r < n; r++)
      for (let c = 0; c < n; c++) {
        const k = r * n + c;
        let target = draft.has(k) ? 0.2 : 0;
        for (const p of pulses) {
          const t = j.t - p.at;
          if (p.k === k && t >= 0 && t < 0.5) target = Math.max(target, 0.32 * Math.sin((Math.PI * t) / 0.5));
        }
        const cur = lift.current[k]!;
        const next = still ? target : cur + (target - cur) * (1 - Math.exp(-dt * 14));
        if (Math.abs(next - target) > 0.002) moving = true;
        lift.current[k] = Math.abs(next - target) <= 0.002 ? target : next;
        const y = TILE_H / 2 + lift.current[k]!;
        o.position.set(cx(c, n), y, cz(r, n));
        o.rotation.set(0, 0, 0);
        o.scale.set(1, 1, 1);
        o.updateMatrix();
        a.setMatrixAt(k, o.matrix);
        const owner = owners[k];
        if (owner) col.set(hexOf[owner] || "#94a3b8").multiplyScalar(0.85);
        else col.set(IVORY);
        if (draft.has(k)) col.lerp(new Color("#ffffff"), 0.55).multiplyScalar(1.15);
        else if (hover === k) col.multiplyScalar(1.12);
        a.setColorAt(k, col);
        const lp = letters.current[k];
        if (lp) lp.position.y = TILE_H + lift.current[k]! + 0.004;
        if (owner) {
          o.position.set(cx(c, n), 0.012, cz(r, n));
          o.rotation.set(-Math.PI / 2, 0, 0);
          o.updateMatrix();
          h.setMatrixAt(nh, o.matrix);
          col.set(hexOf[owner] || "#94a3b8").multiplyScalar(1.6);
          h.setColorAt(nh, col);
          nh++;
        }
      }
    h.count = nh;
    a.instanceMatrix.needsUpdate = true;
    h.instanceMatrix.needsUpdate = true;
    if (a.instanceColor) a.instanceColor.needsUpdate = true;
    if (h.instanceColor) h.instanceColor.needsUpdate = true;
    const pulsing = pulses.some((p) => j.t - p.at < 0.55 && j.t - p.at > -1);
    if (moving || pulsing || dirty.current) state.invalidate();
    dirty.current = false;
  });
  const cells = Array.from({ length: n * n }, (_, k) => k);
  return (
    <group>
      <instancedMesh
        ref={tiles}
        args={[undefined, undefined, n * n]}
        frustumCulled={false}
        onClick={
          onCell
            ? (e) => {
                e.stopPropagation();
                const k = e.instanceId;
                if (k != null) onCell(Math.floor(k / n), k % n);
              }
            : undefined
        }
        onPointerMove={
          onCell
            ? (e) => {
                if (e.pointerType === "mouse" && e.instanceId != null) setHover(e.instanceId);
              }
            : undefined
        }
        onPointerOut={() => setHover(null)}
      >
        <boxGeometry args={[TILE, TILE_H, TILE]} />
        <meshStandardMaterial roughness={0.55} metalness={0.05} />
      </instancedMesh>
      <instancedMesh ref={halos} args={[undefined, undefined, n * n]} frustumCulled={false}>
        <planeGeometry args={[TILE * 1.35, TILE * 1.35]} />
        <meshBasicMaterial transparent opacity={0.55} depthWrite={false} toneMapped={false} />
      </instancedMesh>
      {cells.map((k) => {
        const r = Math.floor(k / n);
        const c = k % n;
        const owner = owners[k];
        const ch = (grid[r]![c] || "").toUpperCase();
        const tex = owner ? letterTex(ch, "#ffffff", hexOf[owner] || null, owner.slice(0, 2)) : letterTex(ch, "#1f1a12", null, "");
        return (
          <mesh
            key={k}
            ref={(m) => {
              letters.current[k] = m;
            }}
            position={[cx(c, n), TILE_H + 0.004, cz(r, n)]}
            rotation={[-Math.PI / 2, 0, 0]}
            raycast={() => null}
          >
            <planeGeometry args={[TILE * 0.9, TILE * 0.9]} />
            <meshBasicMaterial map={tex} transparent depthWrite={false} toneMapped={!owner} />
          </mesh>
        );
      })}
    </group>
  );
}

/* ---------- ribbons ---------- */

/* A word's path as a tube of light over its tiles. prog (0-1) draws it
   in from the first letter: the tube's index buffer runs along its
   length, so a prefix of it is a prefix of the path. */
function Ribbon({ path, n, hex, y, prog, opacity = 0.95, radius = 0.05 }: { path: number[][]; n: number; hex: string; y: number; prog: number; opacity?: number; radius?: number }) {
  const geo = useMemo(() => {
    const curve = new CurvePath<Vector3>();
    const pts = path.map(([r, c]) => new Vector3(cx(c!, n), y, cz(r!, n)));
    if (pts.length < 2) pts.push(pts[0]!.clone().add(new Vector3(0.001, 0, 0)));
    for (let i = 1; i < pts.length; i++) curve.add(new LineCurve3(pts[i - 1]!, pts[i]!));
    return new TubeGeometry(curve, Math.max(8, (pts.length - 1) * 10), radius, 6, false);
  }, [path, n, y, radius]);
  useEffect(() => () => geo.dispose(), [geo]);
  const segs = Math.max(8, (path.length - 1) * 10);
  const count = Math.floor(Math.min(1, Math.max(0, prog)) * segs) * 6 * 6;
  useEffect(() => {
    geo.setDrawRange(0, count);
  }, [geo, count]);
  const color = useMemo(() => new Color(hex).multiplyScalar(2.2), [hex]);
  return (
    <mesh geometry={geo} raycast={() => null}>
      <meshBasicMaterial color={color} transparent opacity={opacity} toneMapped={false} depthWrite={false} />
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

/* Drives a playing reveal: each word's draw progress, and its landing. */
function Beats({ t0, words, onProg, onLand, onDone }: { t0: number; words: Word[]; onProg: (p: number[]) => void; onLand: (i: number) => void; onDone: () => void }) {
  const j = useJuice();
  const fired = useRef(new Set<string>());
  const last = useRef("");
  useFrame((state) => {
    const t = j.t - t0;
    state.invalidate();
    const p = words.map((_, i) => Math.min(1, Math.max(0, (t - 0.4 - i * WORD_GAP) / DRAW)));
    const key = p.map((x) => Math.round(x * 40)).join(",");
    if (key !== last.current) {
      last.current = key;
      onProg(p);
    }
    words.forEach((_, i) => {
      if (p[i]! >= 1 && !fired.current.has("l" + i)) {
        fired.current.add("l" + i);
        onLand(i);
      }
    });
    if (t >= 0.4 + words.length * WORD_GAP + 0.6 && !fired.current.has("done")) {
      fired.current.add("done");
      onDone();
    }
  });
  return null;
}

/* ---------- impacts from the viewer's seat ---------- */

function wordImpact(w: Word, seats: Seat[]): Impact {
  const you = seats.find((s) => s.you);
  const mine = !!you && w.by === you.name;
  if (w.dup) return { trauma: 0.05, sound: "lock" };
  if (w.claimed.length >= 3) return { trauma: mine ? 0.3 : 0.18, stop: mine ? 90 : 40, pulse: 0.4, sound: "ping", buzz: mine ? BUZZ.scored : undefined };
  return { trauma: mine ? 0.15 : 0.08, sound: "ping", buzz: mine ? BUZZ.commit : undefined };
}

function roundImpact(g: any, n: number, words: Word[], seats: Seat[], last: boolean): Impact | null {
  const you = seats.find((s) => s.you);
  if (last) {
    if (g.draw) return { trauma: 0.2, stop: 80, sound: "whoosh", title: { big: "DRAW", small: "A tie at the top", tone: "neutral" } };
    if (g.winner && you && g.winner === you.name) return { trauma: 0.8, stop: 250, slow: 0.8, pulse: 1, buzz: BUZZ.wonMatch, sound: ["clash", "win"], title: { big: "VICTORY", small: "Top of the grid after " + n + " rounds", tone: "good" } };
    if (g.winner && you && seats.some((s) => s.you)) return { trauma: 0.7, stop: 220, slow: 0.6, pulse: 0.8, buzz: BUZZ.lostMatch, sound: ["clash", "lose"], title: { big: "DEFEAT", small: g.winner + " takes the grid", tone: "bad" } };
    if (g.winner) return { trauma: 0.5, stop: 160, slow: 0.5, pulse: 0.8, sound: ["clash", "win"], title: { big: String(g.winner).toUpperCase() + " WINS", small: "After " + n + " rounds", tone: "neutral" } };
    return null;
  }
  if (!you) return null;
  const mine = words.find((w) => w.by === you.name);
  const top = words.reduce((m, w) => Math.max(m, w.points), 0);
  if (!mine) return { trauma: 0.15, buzz: BUZZ.hitYou, title: { big: "NO WORD", small: "Round " + n + " went by", tone: "bad" } };
  if (mine.points >= top && words.length > 1) return { trauma: 0.25, pulse: 0.5, buzz: BUZZ.scored, title: { big: "+" + mine.points, small: mine.word.toUpperCase() + " - the round's best", tone: "good" } };
  return { title: { big: "+" + mine.points, small: mine.word.toUpperCase(), tone: "neutral" } };
}

/* ---------- what the viewer has seen ---------- */

function seenKey(id: unknown): string {
  let path = "";
  try {
    path = location.pathname;
  } catch {
    path = "";
  }
  return "ac-lg-seen:" + path + ":" + String(id);
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

function wordsOf(round: any): Word[] {
  if (!round) return [];
  const out: Word[] = Object.keys(round.words || {}).map((by) => {
    const w = round.words[by];
    return { by, word: String(w.word || ""), path: w.path || [], points: (round.points || {})[by] || 0, claimed: w.claimed || [], contested: w.contested || [], dup: !!w.dup };
  });
  // lowest first: the round's best word lands last
  return out.sort((a, b) => a.points - b.points || (a.by < b.by ? -1 : 1));
}

/* ---------- the arena ---------- */

export default function LetterArena3D({
  g,
  me = "",
  aspect,
  onReady,
  registerCommit,
  draft,
  onCell,
}: {
  g: any;
  me?: string;
  aspect?: number;
  onReady?: () => void;
  registerCommit?: (fn: (() => void) | null) => void;
  draft?: { word: string; path: number[][] | null } | null;
  onCell?: (r: number, c: number) => void;
}) {
  const still = useReducedMotion();
  const q = useQuality(still);
  const juice = useJuiceStore(still);
  const firstVisit = useFirstVisit("lg:" + String((g && g.id) || ""));
  const [ready, setReady] = useState(false);
  const ctl = useRef<Ctl | null>(null);
  const homeRef = useRef<Home | null>(null);
  const [hostW, setHostW] = useState(() => (aspect && aspect < 1.4 ? 390 : 760));
  const meL = me.toLowerCase();
  const grid: string[] = (g && g.grid) || [];
  const n = grid.length || 5;
  const players: any[] = (g && g.players) || NO_ITEMS;
  const rounds: any[] = (g && g.rounds) || NO_ITEMS;
  const finished = !!g && g.status === "finished";
  const seats: Seat[] = useMemo(() => players.map((p: any) => ({ name: String(p.name), hex: String(p.hex || "#2dd4bf"), you: String(p.name).toLowerCase() === meL })), [players, meL]);

  const [init] = useState(() => {
    const R = rounds.length;
    const seen = readSeen(g && g.id);
    if (seen == null || !R || seen >= R) return { shown: R };
    return { shown: R - 1 };
  });
  const [shown, setShown] = useState(init.shown);
  const [playing, setPlaying] = useState<{ n: number; t0: number | null } | null>(null);
  const [go, setGo] = useState(false);
  const [prog, setProg] = useState<number[]>([]);
  const [landed, setLanded] = useState(0);
  const [pulses, setPulses] = useState<{ k: number; at: number }[]>([]);
  const [fx, setFx] = useState<{ id: number; at: [number, number, number]; hex: string; small: boolean }[]>([]);
  const fxId = useRef(0);
  const [ceremony, setCeremony] = useState(0);
  const [say, setSay] = useState("");
  // the path steps already pulsed in the playing reveal
  const pulseSeen = useRef(new Set<number>());

  useEffect(() => {
    if (!ready || go) return;
    const t = setTimeout(() => setGo(true), firstVisit && !still ? 2400 : 300);
    return () => clearTimeout(t);
  }, [ready, go, firstVisit, still]);

  const isLast = (k: number) => finished && k === rounds.length;
  const sayRound = (k: number) => {
    const ws = wordsOf(rounds[k - 1]);
    return "Round " + k + ": " + (ws.length ? ws.slice().reverse().map((w) => w.by + " " + w.word.toUpperCase() + " +" + w.points).join(", ") : "no words") + "." + (isLast(k) ? (g.winner ? " " + g.winner + " wins the grid." : " A tie at the top.") : "");
  };
  const finish = (k: number, quiet: boolean) => {
    setPlaying(null);
    setProg([]);
    setLanded(0);
    setShown(k);
    const imp = roundImpact(g, k, wordsOf(rounds[k - 1]), seats, isLast(k));
    if (imp) juice.hit(quiet ? { ...imp, trauma: 0, stop: 0, slow: 0, pulse: 0 } : imp);
    setSay(sayRound(k));
    if (isLast(k) && g.winner) setCeremony((c) => c + 1);
  };

  useEffect(() => {
    if (!go || playing) return;
    const R = rounds.length;
    if (R <= shown) return;
    if (R - shown > 1) setShown(R - 1);
    if (still) finish(R, false);
    else setPlaying({ n: R, t0: null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [go, playing, rounds.length, shown, still]);

  useEffect(() => {
    writeSeen(g && g.id, shown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown]);

  const skip = () => {
    if (playing) finish(playing.n, true);
  };

  // your send: a click and a buzz at the tap, before the request
  useEffect(() => {
    if (!registerCommit) return;
    registerCommit(() => juice.hit({ sound: "lock", buzz: BUZZ.commit }));
    return () => registerCommit(null);
  }, [registerCommit, juice]);

  // the claims on show: the server's, minus those made in rounds not yet
  // revealed - and, while a round plays, its words' claims as they land
  const playWords = useMemo(() => (playing ? wordsOf(rounds[playing.n - 1]) : []), [playing, rounds]);
  const owners: (string | null)[] = useMemo(() => {
    const out: (string | null)[] = ((g && g.claims) || []).slice();
    const hiddenFrom = playing ? playing.n : shown + 1;
    for (let k = hiddenFrom; k <= rounds.length; k++) {
      const rd = rounds[k - 1];
      for (const by of Object.keys((rd && rd.words) || {})) for (const cell of rd.words[by].claimed || []) out[cell] = null;
    }
    if (playing) playWords.slice(0, landed).forEach((w) => w.claimed.forEach((cell) => (out[cell] = w.by)));
    return out;
  }, [g, rounds, shown, playing, playWords, landed]);

  const canPlay = !!(g && g.status === "running" && g.you && g.you.playing && !g.you.out && onCell);
  const draftSet = useMemo(() => {
    const s = new Set<number>();
    if (draft && draft.path) draft.path.forEach(([r, c]) => s.add(r! * n + c!));
    return s;
  }, [draft, n]);
  const queued = g && g.you && g.you.queued && (!draft || !draft.path) ? g.you.queued : null;
  const lastWords = useMemo(() => (playing ? [] : wordsOf(rounds[shown - 1])), [playing, rounds, shown]);
  const hexOf = (name: string) => (seats.find((s) => s.name === name) || { hex: "#94a3b8" }).hex;

  const home = (a: number, width: number) => {
    const phone = width < PHONE_BELOW;
    const S = n * GAP + 0.8;
    return fitHome(S, S, phone ? 64 : 56, phone ? 46 : 38, a, phone ? 1.02 : 1.06);
  };
  const first = home(aspect || 1.6, hostW);
  const claimedCount = owners.filter(Boolean).length;
  const label =
    "Letter Grid arena, 3D view: a " +
    n +
    "x" +
    n +
    " grid of letters. " +
    seats
      .map((s) => {
        const p = players.find((x: any) => x.name === s.name) || {};
        return s.name + (s.you ? " (you)" : "") + " " + (p.score || 0) + " points, " + (p.cells || 0) + " cells";
      })
      .join("; ") +
    ". " +
    (g.status === "running" ? "Round " + g.round + " of " + g.rounds_total + ". " : finished ? (g.winner ? g.winner + " won. " : "A tie at the top. ") : "") +
    claimedCount +
    " cells claimed.";
  const intro = firstVisit ? { title: "Letter Grid", sub: seats.map((s) => s.name).join(" · ") || "Trace a word, claim the cells", color: "#2dd4bf" } : null;
  const ribbonY = (i: number) => TILE_H + 0.32 + i * 0.05;
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
                Round {playing.n} · tap to skip
              </div>
            ) : null}
            <div className="sr-only" aria-live="polite">
              {say}
            </div>
          </>
        }
      >
        <Canvas role="img" aria-label={label} frameloop="demand" dpr={q.dpr} gl={{ antialias: false, powerPreference: "high-performance" }} camera={{ position: first.pos, fov: first.fov, near: 0.1, far: 800 }}>
          <FirstFrame
            onReady={() => {
              setReady(true);
              if (onReady) onReady();
            }}
          />
          <Ticker fps={q.ambientFps} />
          <JuiceRig ctl={ctl} reach={0.7} />
          <color attach="background" args={["#020509"]} />
          <fog attach="fog" args={["#05141a", 22, 80]} />
          <SkyDome spec={LG_SKY} />
          <hemisphereLight args={["#f2fffb", "#06100f", 0.85]} />
          <directionalLight position={[3, 10, 7]} intensity={1.25} color="#fff1dc" />
          <Plinth n={n} still={still} />
          {grid.length ? <Tiles grid={grid} owners={owners} seats={seats} draft={draftSet} pulses={pulses} still={still} onCell={canPlay ? onCell : undefined} /> : null}
          {lastWords.map((w, i) => (
            <Ribbon key={"lw" + shown + w.by} path={w.path} n={n} hex={w.dup ? "#94a3b8" : hexOf(w.by)} y={ribbonY(i)} prog={1} opacity={0.26} radius={0.028} />
          ))}
          {playWords.map((w, i) => (
            <Ribbon key={"pw" + (playing ? playing.n : 0) + w.by} path={w.path} n={n} hex={w.dup ? "#94a3b8" : hexOf(w.by)} y={ribbonY(i)} prog={prog[i] || 0} />
          ))}
          {draft && draft.path && draft.path.length ? <Ribbon key={"draft" + draft.path.map((p) => p.join(".")).join("-")} path={draft.path} n={n} hex="#ffffff" y={TILE_H + 0.45} prog={1} opacity={0.9} radius={0.055} /> : null}
          {queued && queued.path ? <Ribbon key={"q" + queued.word} path={queued.path} n={n} hex="#e2f4fd" y={TILE_H + 0.45} prog={1} opacity={0.3} radius={0.04} /> : null}
          {playing && playing.t0 == null ? <ClockStart key={"c" + playing.n} onStart={(t) => setPlaying((p) => (p && p.t0 == null ? { ...p, t0: t } : p))} /> : null}
          {playing && playing.t0 != null ? (
            <Beats
              key={"b" + playing.n}
              t0={playing.t0}
              words={playWords}
              onProg={(p) => {
                setProg(p);
                // the tiles rise as the ribbon reaches them
                const at = juice.t;
                const add: { k: number; at: number }[] = [];
                p.forEach((x, i) => {
                  const w = playWords[i]!;
                  const upto = Math.floor(x * (w.path.length - 1) + 1e-6);
                  for (let s = 0; s <= upto; s++) {
                    const [r, c] = w.path[s]!;
                    const k = r! * n + c!;
                    const id = i * 100 + s;
                    if (!pulseSeen.current.has(id)) {
                      pulseSeen.current.add(id);
                      add.push({ k, at });
                    }
                  }
                });
                if (add.length) setPulses((l) => [...l.filter((x) => at - x.at < 0.6), ...add]);
              }}
              onLand={(i) => {
                const w = playWords[i]!;
                setLanded(i + 1);
                juice.hit(wordImpact(w, seats));
                if (!q.lite) {
                  w.claimed.forEach((cell) => setFx((l) => [...l.slice(-10), { id: ++fxId.current, at: [cx(cell % n, n), TILE_H + 0.2, cz(Math.floor(cell / n), n)], hex: hexOf(w.by), small: false }]));
                  w.contested.forEach((cell) => setFx((l) => [...l.slice(-10), { id: ++fxId.current, at: [cx(cell % n, n), TILE_H + 0.2, cz(Math.floor(cell / n), n)], hex: "#ffffff", small: true }]));
                }
              }}
              onDone={() => {
                pulseSeen.current = new Set();
                finish(playing.n, false);
              }}
            />
          ) : null}
          {fx.map((f) => (
            <Burst key={f.id} at={f.at} hex={f.hex} box={[0.7, 0.3, 0.7]} count={f.small ? 10 : 18} power={f.small ? 0.9 : 1.3} piece={0.06} dur={0.9} onDone={() => setFx((l) => l.filter((x) => x.id !== f.id))} />
          ))}
          {ceremony && g.winner && !still ? (
            <group key={"cer" + ceremony}>
              <LightPillar at={[0, 0, 0]} hex={hexOf(g.winner)} height={14} width={0.9} />
              <Shockwave at={[0, 0.02, 0]} hex={hexOf(g.winner)} radius={12} dur={1.2} />
            </group>
          ) : null}
          <CameraControls ref={ctl} makeDefault minDistance={4} maxDistance={40} maxPolarAngle={Math.PI / 2.1} />
          <TouchControls ctl={ctl} />
          <Framer home={home} ctl={ctl} homeRef={homeRef} />
          <Intro ctl={ctl} homeRef={homeRef} enabled={!!intro && !still} ready={ready} />
          <ArenaPost q={q} bloom={0.9} threshold={0.95} vignette={0.5} />
        </Canvas>
      </ArenaFrame>
    </JuiceProvider>
  );
}
