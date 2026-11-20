/* Trust in 3D (2026-11-19): the round table.

   The world: a dark round table on an open plain under an aurora; each
   player sits at a glowing seat around it (you nearest the camera, a
   spectator sees the match's order), a name plate and score above. The
   last round lives on the table as a web of threads: every pairing is
   one line across the table in two halves, each half the choice one
   player made toward the other - teal for trust, red for betrayal. Two
   teal halves are trust kept; teal meeting red is a betrayal (with a
   red burst where they meet); two red halves are mutual defection,
   dim. A seat's ring lights when that player has chosen this round.

   A resolved round plays on the juice clock: the seats pulse, then pair
   by pair the threads grow out from both seats and meet; then the
   scores tick up and the round's title lands from the viewer's seat
   ("Betrayed by Ada", "Trust held", "+8"). The last round adds the
   winner's pillar and shockwave. Catch-up, tap-to-skip and reduced
   motion work as in the other rounds arenas. */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { CameraControls } from "@react-three/drei";
import { CanvasTexture, Color, Object3D, SRGBColorSpace, type InstancedMesh, type MeshStandardMaterial } from "three";
import { ArenaFrame, FirstFrame, Framer, Ticker, TouchControls, goHome, useQuality, useReducedMotion, type Ctl, type Home } from "../three/arena3d";
import { ArenaPost, ImpactLayer, Intro, JuiceProvider, JuiceRig, SoundToggle, useFirstVisit, useJuice, useJuiceStore, type Impact } from "../three/juice";
import { Burst, LightPillar, Shockwave, SkyDome, type SkySpec } from "../three/atmos";
import { BUZZ, sfx } from "../three/sfx";

const TR_SKY: SkySpec = {
  top: "#02050a",
  mid: "#06121a",
  horizon: "#0d2a2c",
  ground: "#020504",
  glow: "#2dd4bf",
  glowAmt: 0.25,
  stars: 0.08,
  aurora: 0.85,
  auroraA: "#2dd4bf",
  auroraB: "#a78bfa",
};

const TABLE_Y = 0.75;
const PHONE_BELOW = 560;
const ANTIC = 0.5;
const GROW = 0.45;
const TRUST = new Color("#2dd4bf").multiplyScalar(2.0);
const BETRAY = new Color("#ef4444").multiplyScalar(2.0);
const DIM_RED = new Color("#7f1d1d").multiplyScalar(1.1);

type Seat = { name: string; hex: string; you: boolean; x: number; z: number; committed: boolean; out: boolean };

const smooth = (a: number, b: number, t: number) => {
  const x = Math.min(1, Math.max(0, (t - a) / (b - a)));
  return x * x * (3 - 2 * x);
};

function tableR(n: number) {
  return n <= 3 ? 2.6 : n <= 5 ? 3.1 : 3.6;
}

/* ---------- labels ---------- */

const labelCache = new Map<string, CanvasTexture>();
function labelTex(name: string, sub: string, hex: string): CanvasTexture {
  const key = name + "|" + sub + "|" + hex;
  const hit = labelCache.get(key);
  if (hit) return hit;
  const c = document.createElement("canvas");
  c.width = 320;
  c.height = 128;
  const x = c.getContext("2d");
  if (x) {
    x.textAlign = "center";
    x.textBaseline = "middle";
    x.shadowColor = "rgba(0,0,0,0.85)";
    x.shadowBlur = 8;
    x.font = "800 46px system-ui, -apple-system, Segoe UI, sans-serif";
    x.fillStyle = hex;
    x.fillText(name.length > 12 ? name.slice(0, 11) + "…" : name, 160, 42);
    x.font = "800 40px system-ui, -apple-system, Segoe UI, sans-serif";
    x.fillStyle = "rgba(223,247,242,0.95)";
    x.fillText(sub, 160, 96);
  }
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  labelCache.set(key, t);
  return t;
}

/* ---------- the table and seats ---------- */

function Table({ n }: { n: number }) {
  const r = tableR(n) - 0.9;
  return (
    <group>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.01, 0]}>
        <planeGeometry args={[300, 300]} />
        <meshStandardMaterial color="#030807" roughness={0.95} />
      </mesh>
      <mesh position={[0, TABLE_Y / 2, 0]}>
        <cylinderGeometry args={[r * 0.3, r * 0.42, TABLE_Y, 32]} />
        <meshStandardMaterial color="#0b1716" metalness={0.4} roughness={0.5} />
      </mesh>
      <mesh position={[0, TABLE_Y, 0]}>
        <cylinderGeometry args={[r, r, 0.08, 64]} />
        <meshStandardMaterial color="#0d1f1d" metalness={0.3} roughness={0.35} emissive="#2dd4bf" emissiveIntensity={0.05} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, TABLE_Y + 0.045, 0]}>
        <ringGeometry args={[r - 0.06, r, 64]} />
        <meshBasicMaterial color={new Color("#2dd4bf").multiplyScalar(1.3)} toneMapped={false} />
      </mesh>
    </group>
  );
}

function SeatMark({ s, lit, pulse, score, gain, still, big }: { s: Seat; lit: boolean; pulse: number; score: number; gain: number | null; still: boolean; big: boolean }) {
  const ring = useRef<MeshStandardMaterial>(null);
  const j = useJuice();
  useFrame(() => {
    const m = ring.current;
    if (!m) return;
    const breathe = still ? 0 : 0.15 * Math.sin(j.t * 2 + s.x);
    m.emissiveIntensity = s.out ? 0.1 : (lit ? 1.6 : 0.45 + breathe) + 1.2 * pulse;
  });
  // the round on the table's points ride the plate (the page's grid had them)
  const sub = String(score) + (gain != null ? " (+" + gain + ")" : "") + (s.you ? " · you" : "") + (s.out ? " · out" : "");
  return (
    <group position={[s.x, 0, s.z]}>
      <mesh position={[0, 0.3, 0]}>
        <cylinderGeometry args={[0.42, 0.5, 0.6, 28]} />
        <meshStandardMaterial color="#0a1413" metalness={0.5} roughness={0.4} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.61, 0]}>
        <ringGeometry args={[0.3, 0.42, 36]} />
        <meshStandardMaterial ref={ring} color="#000" emissive={s.hex} emissiveIntensity={0.5} toneMapped={false} />
      </mesh>
      {/* the plate sits outward from the table, clear of the threads */}
      <sprite position={[s.x * 0.28, 0.55, s.z * 0.28]} scale={big ? [2.4, 0.96, 1] : [1.7, 0.68, 1]} renderOrder={5}>
        <spriteMaterial map={labelTex(s.name, sub, s.hex)} transparent depthWrite={false} depthTest={false} />
      </sprite>
    </group>
  );
}

/* Every half-thread of a round in one instanced draw: from a seat toward
   the middle of its pairing, in the colour of that player's choice. A
   pair's halves grow at that pair's beat (t0 null: all settled). */
function Threads({ seats, round, t0, gap, still }: { seats: Seat[]; round: any; t0: number | null; gap: number; still: boolean }) {
  const ref = useRef<InstancedMesh>(null);
  const j = useJuice();
  const o = useMemo(() => new Object3D(), []);
  const settled = useRef(false);
  useEffect(() => {
    settled.current = false;
  }, [round, t0, seats, still]);
  const pairs = useMemo(() => {
    const out: [Seat, Seat][] = [];
    if (!round) return out;
    for (let i = 0; i < seats.length; i++)
      for (let k = i + 1; k < seats.length; k++) {
        const a = seats[i]!, b = seats[k]!;
        if ((round.moves || {})[a.name] && (round.moves || {})[b.name]) out.push([a, b]);
      }
    return out;
  }, [round, seats]);
  useFrame((state) => {
    const m = ref.current;
    if (!m) return;
    const t = t0 == null || still ? Infinity : j.t - t0;
    if (settled.current && t === Infinity) return;
    let n = 0;
    pairs.forEach(([a, b], pi) => {
      const at = ANTIC + pi * gap;
      const k = smooth(at, at + GROW, t);
      if (k <= 0.001) return;
      const mx = (a.x + b.x) / 2, mz = (a.z + b.z) / 2;
      for (const [from, to] of [[a, b], [b, a]] as [Seat, Seat][]) {
        const c = (round.moves[from.name] || {})[to.name];
        const ex = from.x + (mx - from.x) * k, ez = from.z + (mz - from.z) * k;
        const sx = from.x * 0.86, sz = from.z * 0.86; // start at the table's edge
        const len = Math.hypot(ex - sx, ez - sz);
        o.position.set((sx + ex) / 2, TABLE_Y + 0.12, (sz + ez) / 2);
        o.rotation.set(0, -Math.atan2(ez - sz, ex - sx), 0);
        o.scale.set(Math.max(0.001, len), 1, 1);
        o.updateMatrix();
        m.setMatrixAt(n, o.matrix);
        const both = c === "D" && (round.moves[to.name] || {})[from.name] === "D";
        m.setColorAt(n, c === "C" ? TRUST : both ? DIM_RED : BETRAY);
        n++;
      }
    });
    m.count = n;
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
    if (t === Infinity) settled.current = true;
    else state.invalidate();
  });
  return (
    <instancedMesh ref={ref} args={[undefined, undefined, 8 * 7]} frustumCulled={false}>
      <boxGeometry args={[1, 0.05, 0.07]} />
      <meshBasicMaterial toneMapped={false} />
    </instancedMesh>
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

function Beats({ t0, pairs, gap, holdAfter, onPair, onVerdict, onDone }: { t0: number; pairs: number; gap: number; holdAfter: number; onPair: (i: number) => void; onVerdict: () => void; onDone: () => void }) {
  const j = useJuice();
  const fired = useRef(new Set<string>());
  const verdictAt = ANTIC + Math.max(0, pairs - 1) * gap + GROW + 0.25;
  useFrame((state) => {
    const t = j.t - t0;
    state.invalidate();
    for (let i = 0; i < pairs; i++) {
      if (t >= ANTIC + i * gap + GROW && !fired.current.has("p" + i)) {
        fired.current.add("p" + i);
        onPair(i);
      }
    }
    if (t >= verdictAt && !fired.current.has("v")) {
      fired.current.add("v");
      onVerdict();
    }
    if (t >= verdictAt + holdAfter && !fired.current.has("d")) {
      fired.current.add("d");
      onDone();
    }
  });
  return null;
}

/* ---------- impacts from the viewer's seat ---------- */

function roundImpact(round: any, seats: Seat[]): Impact {
  const you = seats.find((s) => s.you);
  const pts = you ? (round.points || {})[you.name] : null;
  if (you && pts != null && (round.moves || {})[you.name]) {
    const mine = round.moves[you.name] || {};
    const betrayers = Object.keys(round.moves).filter((n) => n !== you.name && (round.moves[n] || {})[you.name] === "D" && mine[n] === "C");
    const kept = Object.keys(mine).filter((n) => mine[n] === "C" && (round.moves[n] || {})[you.name] === "C");
    if (betrayers.length)
      return { trauma: 0.4, stop: 120, pulse: 0.5, buzz: BUZZ.hitYou, sound: "tear", title: { big: "BETRAYED", small: "by " + betrayers.join(" & ") + " · +" + pts + " this round", tone: "bad" } };
    if (kept.length && kept.length === Object.keys(mine).length) return { trauma: 0.15, stop: 60, buzz: BUZZ.scored, sound: "win", title: { big: "TRUST HELD", small: "+" + pts + " this round", tone: "good" } };
    return { trauma: 0.12, stop: 40, sound: "clash", title: { big: "ROUND " + round.n, small: "+" + pts + " this round", tone: "neutral" } };
  }
  const all = Object.values(round.moves || {}).flatMap((m: any) => Object.values(m) as string[]);
  const cs = all.filter((v) => v === "C").length;
  return { trauma: 0.1, sound: "clash", title: { big: "ROUND " + round.n, small: cs + " of " + all.length + " choices were trust", tone: "neutral" } };
}

function finalImpact(g: any, seats: Seat[]): Impact {
  const you = seats.find((s) => s.you);
  const w = g.winner as string | null;
  const scores = (g.places || []).map((n: string) => n + " " + (((g.players || []).find((p: any) => p.name === n) || {}).score || 0)).join(" · ");
  if (!w) return { trauma: 0.3, stop: 120, sound: "whoosh", title: { big: "A TIE AT THE TOP", small: scores, tone: "neutral" } };
  if (you && you.name === w) return { trauma: 0.8, stop: 250, slow: 0.8, pulse: 1, buzz: BUZZ.wonMatch, sound: ["clash", "win"], title: { big: "VICTORY", small: scores, tone: "good" } };
  if (you) {
    const place = (g.places || []).indexOf(you.name) + 1;
    if (place === 2 && seats.length > 2) return { trauma: 0.4, stop: 150, pulse: 0.5, buzz: BUZZ.scored, sound: "win", title: { big: "#2", small: w + " wins · " + scores, tone: "neutral" } };
    return { trauma: 0.8, stop: 250, slow: 0.8, pulse: 0.8, buzz: BUZZ.lostMatch, sound: ["clash", "lose"], title: { big: "DEFEAT", small: w + " wins · " + scores, tone: "bad" } };
  }
  return { trauma: 0.6, stop: 200, slow: 0.6, pulse: 0.8, buzz: BUZZ.scored, sound: ["clash", "win"], title: { big: w.toUpperCase() + " WINS", small: scores, tone: "neutral" } };
}

function sayRound(round: any, seats: Seat[]): string {
  if (!round) return "";
  const parts: string[] = [];
  for (let i = 0; i < seats.length; i++)
    for (let k = i + 1; k < seats.length; k++) {
      const a = seats[i]!.name, b = seats[k]!.name;
      const ab = (round.moves[a] || {})[b], ba = (round.moves[b] || {})[a];
      if (!ab || !ba) continue;
      parts.push(ab === "C" && ba === "C" ? a + " and " + b + " trusted each other" : ab === "D" && ba === "D" ? a + " and " + b + " both defected" : (ab === "D" ? a : b) + " betrayed " + (ab === "D" ? b : a));
    }
  return "Round " + round.n + ": " + parts.join("; ") + ". Points: " + seats.map((s) => s.name + " +" + ((round.points || {})[s.name] || 0)).join(", ") + ".";
}

/* ---------- what the viewer has seen ---------- */

function seenKey(id: unknown): string {
  let path = "";
  try {
    path = location.pathname;
  } catch {
    path = "";
  }
  return "ac-tr-seen:" + path + ":" + String(id);
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

/* Home: every seat and its plate in frame, the aurora in a band across
   the top: the camera looks at the table from elF above it, the view
   pitched a little shallower so the sky shows, then backs off until each
   key point projects inside the frame. */
function trHome(aspect: number, width: number, seats: Seat[]): Home {
  const phone = width < PHONE_BELOW;
  const vfov = aspect < 1 ? 56 : 46;
  const tv = Math.tan((vfov * Math.PI) / 360);
  const th = tv * Math.max(0.45, aspect);
  const elF = ((phone ? 34 : 28) * Math.PI) / 180;
  // a little shallower than the look at the table: a thin band of aurora
  const pitch = elF - (8 * Math.PI) / 180;
  const pts: [number, number, number][] = [];
  seats.forEach((st) => pts.push([st.x * 1.12, 0, st.z * 1.12], [st.x * 1.28, 0.9, st.z * 1.28]));
  if (!pts.length) pts.push([3, 0, 3], [-3, 0, -3]);
  const fy = 0.6;
  const fy2 = -Math.sin(pitch);
  const fz2 = -Math.cos(pitch);
  const fits = (d: number) => {
    const cy = fy + d * Math.sin(elF);
    const cz = d * Math.cos(elF);
    return pts.every(([x, y, z]) => {
      const vy = y - cy;
      const vz = z - cz;
      const zc = vy * fy2 + vz * fz2;
      if (zc <= 0.1) return false;
      const yc = vy * -fz2 + vz * fy2;
      return Math.abs(x / (zc * th)) <= 0.94 && yc / (zc * tv) >= -0.94 && yc / (zc * tv) <= 0.9;
    });
  };
  let lo = 3;
  let hi = 60;
  for (let k = 0; k < 28; k++) {
    const mid = (lo + hi) / 2;
    if (fits(mid)) hi = mid;
    else lo = mid;
  }
  const cy = fy + hi * Math.sin(elF);
  const cz = hi * Math.cos(elF);
  return { pos: [0, cy, cz], fov: vfov, tz: cz - cy / Math.tan(pitch) };
}

/* ---------- the arena ---------- */

export default function TrustArena3D({
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
  const firstVisit = useFirstVisit("tr:" + String((g && g.id) || ""));
  const [ready, setReady] = useState(false);
  const ctl = useRef<Ctl | null>(null);
  const homeRef = useRef<Home | null>(null);
  const [hostW, setHostW] = useState(() => (aspect && aspect < 1.4 ? 390 : 760));
  const meL = me.toLowerCase();
  const players: any[] = (g && g.players) || [];
  const rounds: any[] = (g && g.rounds) || [];
  const finished = !!g && g.status === "finished";
  const running = !!g && g.status === "running";

  // You sit nearest the camera; the rest go round the table.
  const seats: Seat[] = useMemo(() => {
    const n = players.length;
    const mine = players.findIndex((p) => String(p.name).toLowerCase() === meL);
    const start = mine >= 0 ? mine : 0;
    const R = tableR(n);
    return players.map((p: any, i: number) => {
      const k = (i - start + n) % n;
      const a = Math.PI / 2 + (k * 2 * Math.PI) / n; // k = 0 at the front (+z)
      return { name: String(p.name), hex: String(p.hex || "#2dd4bf"), you: String(p.name).toLowerCase() === meL, x: Math.cos(a) * R, z: Math.sin(a) * R, committed: !!p.committed, out: !!p.out };
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
  const [scoredN, setScoredN] = useState(init.shown);
  const [pulse, setPulse] = useState<Record<string, number>>({});
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
    setShown(n);
    setScoredN(n);
    if (!r) return;
    const imp = isLast(n) ? finalImpact(g, seats) : roundImpact(r, seats);
    juice.hit(quiet ? { ...imp, trauma: 0, stop: 0, slow: 0, pulse: 0 } : imp);
    setSay(sayRound(r, seats));
    if (isLast(n) && g.winner) setCeremony((c) => c + 1);
  };

  useEffect(() => {
    if (!go || playing) return;
    const n = rounds.length;
    if (n <= shown) return;
    if (still) land(n, false);
    else setPlaying({ n, t0: null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [go, playing, rounds.length, shown, still]);

  useEffect(() => {
    writeSeen(g && g.id, shown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown]);

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
    seats.forEach((s) => (now[s.name] = s.committed));
    const prev = prevCommit.current;
    prevCommit.current = now;
    if (!prev || !ready) return;
    seats.forEach((s) => {
      if (!s.you && s.committed && !prev[s.name]) juice.hit({ sound: "ping" });
    });
  }, [seats, ready, juice]);

  const fieldN = playing ? playing.n : shown;
  const round = fieldN > 0 ? rounds[fieldN - 1] || null : null;
  const t0 = playing ? playing.t0 : null;
  const pairList = useMemo(() => {
    const out: [string, string][] = [];
    if (!round) return out;
    for (let i = 0; i < seats.length; i++)
      for (let k = i + 1; k < seats.length; k++) if ((round.moves || {})[seats[i]!.name] && (round.moves || {})[seats[k]!.name]) out.push([seats[i]!.name, seats[k]!.name]);
    return out;
  }, [round, seats]);
  const gap = Math.min(0.32, 2.2 / Math.max(1, pairList.length));
  // scores as the scene shows them: the totals after the last scored round
  const scoreOf = (name: string) => {
    if (!scoredN) return 0;
    const r = rounds[scoredN - 1];
    return r ? (r.totals || {})[name] || 0 : 0;
  };
  const winner = finished && g.winner ? seats.find((s) => s.name === g.winner) || null : null;
  const home = (a: number, width: number) => trHome(a, width, seats);
  const first = home(aspect || 1.6, hostW);
  const label =
    "Trust arena, 3D view: " +
    seats.map((s) => s.name + (s.you ? " (you)" : "") + " " + scoreOf(s.name) + (running ? (s.out ? ", out" : s.committed ? ", chosen" : ", thinking") : "")).join("; ") +
    (round ? ". On the table: round " + round.n + "." : ". No round on the table yet.");
  const intro = firstVisit ? { title: "Trust", sub: seats.map((s) => s.name).join(" · ") || "Cooperate or defect", color: "#2dd4bf" } : null;
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
            {playing && round ? (
              <div className="duel-catchup" aria-hidden="true">
                Round {round.n} · tap to skip
              </div>
            ) : round ? (
              <div className="arena3d-caption tr-caption">
                Round {round.n}: <span className="tr-cap-c">teal</span> = cooperated · <span className="tr-cap-d">red</span> = defected
              </div>
            ) : running ? (
              <div className="arena3d-caption tr-caption">Choices are revealed together</div>
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
          <color attach="background" args={["#02050a"]} />
          <fog attach="fog" args={["#06121a", 22, 80]} />
          <SkyDome spec={TR_SKY} />
          <hemisphereLight args={["#ccfbf1", "#020504", 0.55]} />
          <directionalLight position={[-4, 10, 8]} intensity={0.9} color="#e0f2fe" />
          <Table n={seats.length} />
          {seats.map((s) => (
            <SeatMark
              key={s.name}
              s={s}
              lit={running && !playing && (s.committed || (s.you && sealed === g.round))}
              pulse={pulse[s.name] || 0}
              score={scoreOf(s.name)}
              gain={round && !playing && (round.moves || {})[s.name] ? (round.points || {})[s.name] || 0 : null}
              still={still}
              big={hostW < PHONE_BELOW}
            />
          ))}
          <Threads seats={seats} round={round} t0={t0} gap={gap} still={still} />
          {playing && round && t0 == null ? <ClockStart key={"c" + playing.n} onStart={(t) => setPlaying((p) => (p && p.t0 == null ? { ...p, t0: t } : p))} /> : null}
          {playing && round && t0 != null ? (
            <Beats
              key={"b" + playing.n}
              t0={t0}
              pairs={pairList.length}
              gap={gap}
              holdAfter={isLast(playing.n) ? 1.6 : 0.6}
              onPair={(i) => {
                const [a, b] = pairList[i]!;
                const ab = (round.moves[a] || {})[b], ba = (round.moves[b] || {})[a];
                sfx(ab === "C" && ba === "C" ? "ping" : ab !== ba ? "snip" : "beat");
                if (ab !== ba && !q.lite) {
                  const sa = seats.find((s) => s.name === a)!, sb = seats.find((s) => s.name === b)!;
                  setFx((l) => [...l.slice(-6), { id: ++fxId.current, at: [(sa.x + sb.x) / 2, TABLE_Y + 0.15, (sa.z + sb.z) / 2], hex: "#ef4444" }]);
                }
              }}
              onVerdict={() => {
                setScoredN(playing.n);
                const p: Record<string, number> = {};
                seats.forEach((s) => (p[s.name] = 1));
                setPulse(p);
                setTimeout(() => setPulse({}), 500);
                const last = isLast(playing.n);
                juice.hit(last ? finalImpact(g, seats) : roundImpact(round, seats));
                setSay(sayRound(round, seats));
                if (last && g.winner) setCeremony((c) => c + 1);
              }}
              onDone={() => {
                setPlaying(null);
                setShown(playing.n);
              }}
            />
          ) : null}
          {fx.map((f) => (
            <Burst key={f.id} at={f.at} hex={f.hex} box={[0.4, 0.3, 0.4]} count={q.lite ? 14 : 26} power={1.3} piece={0.06} dur={0.9} onDone={() => setFx((l) => l.filter((x) => x.id !== f.id))} />
          ))}
          {ceremony && winner && !still ? (
            <group key={"cer" + ceremony}>
              <LightPillar at={[winner.x, 0, winner.z]} hex={winner.hex} height={12} width={0.7} />
              <Shockwave at={[0, 0.05, 0]} hex={winner.hex} radius={12} dur={1.2} />
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
