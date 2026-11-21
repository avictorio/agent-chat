/* Twenty Questions in 3D (2026-11-20): the sealed box.

   The world: a dark round hall, a box on a pedestal in the middle - the
   secret, sealed, a "?" turning over it - and twenty candles in a ring
   round it: the budget. Every answered question snuffs a candle and
   leaves an ember, green for yes and red for no; a question flagged as
   unanswerable costs no candle. The next candle flickers while a
   question waits. The players stand round the outside, the answerer
   behind the box facing the table, each with a lantern in their colour.

   A round's end plays on the juice clock: the lid flies up, light pours
   out and the secret rises out of the box; the titles come from the
   viewer's seat (you named it, you were found out, you held it, you were
   stumped). The candles relight for the next round. Catch-up, tap to skip
   and reduced motion as in the other arenas; the Q/A log lives in the
   page under the scene. */
import { useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { CameraControls } from "@react-three/drei";
import { CanvasTexture, Color, SRGBColorSpace, type Group, type Mesh, type MeshStandardMaterial } from "three";
import { ArenaFrame, FirstFrame, Framer, Ticker, TouchControls, goHome, useQuality, useReducedMotion, type Ctl, type Home } from "../three/arena3d";
import { ArenaPost, ImpactLayer, Intro, JuiceProvider, JuiceRig, SoundToggle, useFirstVisit, useJuice, useJuiceStore, type Impact } from "../three/juice";
import { Burst, LightPillar, Shockwave, SkyDome, type SkySpec } from "../three/atmos";
import { BUZZ, sfx } from "../three/sfx";
import type { TwentyPlayer, TwentyQuestion, TwentyRound, TwentyState } from "@chat/contract";

// One empty list for matches without players or rounds yet, so the memos
// below keep their inputs from one render to the next.
const NO_ITEMS: never[] = [];

const TQ_SKY: SkySpec = {
  top: "#04020a",
  mid: "#0b0618",
  horizon: "#1f1035",
  ground: "#030208",
  glow: "#a78bfa",
  glowAmt: 0.14,
  stars: 0.2,
};

const PHONE_BELOW = 560;
const RING_R = 2.0;
const SEAT_R = 3.5;
const BOX = 0.75;
const BOX_Y = 0.85;
const YES = new Color("#4ade80").multiplyScalar(2);
const NO = new Color("#f87171").multiplyScalar(2);
const FLAME = new Color("#fbbf24").multiplyScalar(2.2);

type Seat = { name: string; hex: string; you: boolean; x: number; z: number };

const smooth = (a: number, b: number, t: number) => {
  const x = Math.min(1, Math.max(0, (t - a) / (b - a)));
  return x * x * (3 - 2 * x);
};

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

/* ---------- pieces ---------- */

function Hall() {
  return (
    <group>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.01, 0]}>
        <circleGeometry args={[60, 64]} />
        <meshStandardMaterial color="#0a0812" roughness={0.9} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.003, 0]}>
        <circleGeometry args={[RING_R + 0.5, 64]} />
        <meshStandardMaterial color="#1a1528" roughness={0.7} metalness={0.2} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.006, 0]}>
        <ringGeometry args={[RING_R + 0.46, RING_R + 0.52, 96]} />
        <meshBasicMaterial color={new Color("#a78bfa").multiplyScalar(1.3)} toneMapped={false} />
      </mesh>
      <mesh position={[0, 0.22, 0]}>
        <cylinderGeometry args={[0.55, 0.65, 0.44, 32]} />
        <meshStandardMaterial color="#2e2545" roughness={0.5} metalness={0.3} />
      </mesh>
    </group>
  );
}

/* The box: a lid that flies up (open 0..1), seams that glow. */
function Box({ open, still }: { open: number; still: boolean }) {
  const lid = useRef<Group>(null);
  const seam = useRef<MeshStandardMaterial>(null);
  const j = useJuice();
  useFrame(() => {
    if (lid.current) {
      lid.current.position.y = BOX / 2 + 0.06 + open * 1.4;
      lid.current.rotation.set(-open * 0.9, open * 1.2, 0);
    }
    if (seam.current) seam.current.emissiveIntensity = 0.8 + open * 2.5 + (still ? 0 : 0.25 * Math.sin(j.t * 2));
  });
  return (
    <group position={[0, BOX_Y - BOX / 2, 0]}>
      <mesh position={[0, BOX / 2 - 0.03, 0]}>
        <boxGeometry args={[BOX, BOX - 0.06, BOX]} />
        <meshStandardMaterial color="#8a5a2e" roughness={0.45} metalness={0.15} emissive="#3b1f0c" emissiveIntensity={0.35} />
      </mesh>
      {/* gold corner posts so the box reads against the dark */}
      {[-1, 1].flatMap((sx) => [-1, 1].map((sz) => (
        <mesh key={sx + "," + sz} position={[(sx * BOX) / 2, BOX / 2 - 0.03, (sz * BOX) / 2]}>
          <boxGeometry args={[0.05, BOX - 0.04, 0.05]} />
          <meshStandardMaterial color="#000" emissive={new Color("#fbbf24").multiplyScalar(1.2)} emissiveIntensity={0.9} toneMapped={false} />
        </mesh>
      )))}
      <mesh position={[0, BOX - 0.04, 0]}>
        <boxGeometry args={[BOX + 0.02, 0.04, BOX + 0.02]} />
        <meshStandardMaterial ref={seam} color="#000" emissive={new Color("#c4b5fd").multiplyScalar(1.4)} emissiveIntensity={1.2} toneMapped={false} />
      </mesh>
      <group ref={lid} position={[0, BOX / 2 + 0.06, 0]}>
        <mesh position={[0, BOX / 2 - 0.02, 0]}>
          <boxGeometry args={[BOX + 0.06, 0.12, BOX + 0.06]} />
          <meshStandardMaterial color="#9a6634" roughness={0.4} metalness={0.15} emissive="#3b1f0c" emissiveIntensity={0.35} />
        </mesh>
      </group>
    </group>
  );
}

/* The ring of twenty candles. state[i]: "lit" | "yes" | "no"; `next` is
   the candle a waiting question will spend (it flickers). */
function Candles({ state, next, snuffAt, still }: { state: ("lit" | "yes" | "no")[]; next: number; snuffAt: number[]; still: boolean }) {
  const flames = useRef<(Mesh | null)[]>([]);
  const j = useJuice();
  useFrame((st) => {
    let busy = false;
    for (let i = 0; i < 20; i++) {
      const f = flames.current[i];
      if (!f) continue;
      const lit = state[i] === "lit";
      const at = snuffAt[i];
      const since = at != null ? j.t - at : 99;
      // a snuffed flame shrinks out over 0.4 s
      const k = lit ? 1 : since < 0.4 ? 1 - since / 0.4 : 0;
      if (!lit && since < 0.45) busy = true;
      const flick = still ? 1 : i === next ? 0.75 + 0.35 * Math.abs(Math.sin(j.t * 13 + i)) : 0.9 + 0.1 * Math.sin(j.t * 7 + i * 1.7);
      f.scale.set(k * (0.9 + 0.1 * flick), Math.max(0.001, k * flick), k * (0.9 + 0.1 * flick));
      f.visible = k > 0.01;
    }
    if (busy) st.invalidate();
  });
  return (
    <group>
      {Array.from({ length: 20 }, (_, i) => {
        const a = (i / 20) * Math.PI * 2 + Math.PI / 2;
        const x = Math.cos(a) * RING_R;
        const z = Math.sin(a) * RING_R;
        const s = state[i];
        return (
          <group key={i} position={[x, 0, z]}>
            <mesh position={[0, 0.16, 0]}>
              <cylinderGeometry args={[0.06, 0.07, 0.32, 10]} />
              <meshStandardMaterial color="#efe6d2" roughness={0.6} />
            </mesh>
            <mesh ref={(m) => (flames.current[i] = m)} position={[0, 0.42, 0]}>
              <coneGeometry args={[0.045, 0.16, 8]} />
              <meshBasicMaterial color={FLAME} toneMapped={false} />
            </mesh>
            {s !== "lit" ? (
              <mesh position={[0, 0.35, 0]}>
                <sphereGeometry args={[0.04, 8, 6]} />
                <meshBasicMaterial color={s === "yes" ? YES : NO} toneMapped={false} />
              </mesh>
            ) : null}
          </group>
        );
      })}
    </group>
  );
}

function Lantern({ s, lit, answerer, still }: { s: Seat; lit: boolean; answerer: boolean; still: boolean }) {
  const lamp = useRef<MeshStandardMaterial>(null);
  const j = useJuice();
  useFrame(() => {
    if (lamp.current) lamp.current.emissiveIntensity = answerer ? 2.2 + (still ? 0 : 0.4 * Math.sin(j.t * 2.5)) : lit ? 2.0 : 0.45 + (still ? 0 : 0.1 * Math.sin(j.t * 1.4 + s.x));
  });
  return (
    <group position={[s.x, 0, s.z]}>
      <mesh position={[0, 0.4, 0]}>
        <cylinderGeometry args={[0.05, 0.05, 0.8, 8]} />
        <meshStandardMaterial color="#2a2438" roughness={0.6} />
      </mesh>
      <mesh position={[0, 0.88, 0]}>
        <sphereGeometry args={answerer ? [0.2, 18, 14] : [0.14, 16, 12]} />
        <meshStandardMaterial ref={lamp} color="#000" emissive={s.hex} emissiveIntensity={0.45} toneMapped={false} />
      </mesh>
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

/* ---------- impacts from the viewer's seat ---------- */

function roundImpact(r: TwentyRound, me: string): Impact {
  const pts = (r.points || {})[me] || 0;
  const named = r.how === "guessed" || r.how === "forfeit";
  const secret = "“" + r.secret + "”";
  if (r.answerer === me) {
    if (named) return { trauma: 0.4, stop: 110, buzz: BUZZ.hitYou, sound: ["shatter", "lose"], title: { big: r.how === "forfeit" ? "FORFEIT" : "FOUND OUT", small: r.how === "forfeit" ? "You went silent on a question" : r.guessed_by + " named " + secret + " in " + r.asked, tone: "bad" } };
    return { trauma: 0.3, stop: 90, pulse: 0.5, buzz: BUZZ.scored, sound: ["clash", "win"], title: { big: "HELD", small: secret + " survived · +" + pts, tone: "good" } };
  }
  if (me && (r.points || {})[me] !== undefined) {
    if (r.guessed_by === me) return { trauma: 0.4, stop: 110, pulse: 0.6, buzz: BUZZ.scored, sound: ["clash", "win"], title: { big: "YOU NAMED IT", small: secret + " in " + r.asked + " · +" + pts, tone: "good" } };
    if (named) return { trauma: 0.3, stop: 90, pulse: 0.5, buzz: BUZZ.scored, sound: ["clash", "win"], title: { big: "NAMED", small: (r.guessed_by ? r.guessed_by + " got " : "It was ") + secret + " · +" + pts, tone: "good" } };
  }
  if (me && r.answerer !== me && !named) return { trauma: 0.35, stop: 100, buzz: BUZZ.hitYou, sound: ["shatter", "lose"], title: { big: "STUMPED", small: "It was " + secret, tone: "bad" } };
  return { trauma: 0.2, stop: 70, sound: ["clash"], title: { big: "IT WAS", small: secret, tone: "neutral" } };
}

function finalImpact(g: TwentyState, me: string): Impact {
  const w = g.winner as string | null;
  const pts = (n: string) => ((g.players || []).find((p: TwentyPlayer) => p.name === n) || {}).score || 0;
  const line = (g.places || []).map((n: string) => n + " " + pts(n)).join(" · ");
  if (!w) return { trauma: 0.3, stop: 120, sound: "whoosh", title: { big: "A TIE", small: line, tone: "neutral" } };
  if (me && me === w) return { trauma: 0.8, stop: 250, slow: 0.8, pulse: 1, buzz: BUZZ.wonMatch, sound: ["clash", "win"], title: { big: "VICTORY", small: line, tone: "good" } };
  if (me && (g.players || []).some((p: TwentyPlayer) => p.name === me)) {
    const place = (g.places || []).indexOf(me) + 1;
    if (place === 2 && (g.players || []).length > 2) return { trauma: 0.4, stop: 150, buzz: BUZZ.scored, sound: "win", title: { big: "#2", small: line, tone: "neutral" } };
    return { trauma: 0.8, stop: 250, slow: 0.8, pulse: 0.8, buzz: BUZZ.lostMatch, sound: ["clash", "lose"], title: { big: "DEFEAT", small: w + " wins · " + line, tone: "bad" } };
  }
  return { trauma: 0.6, stop: 200, slow: 0.6, pulse: 0.8, buzz: BUZZ.scored, sound: ["clash", "win"], title: { big: w.toUpperCase() + " WINS", small: line, tone: "neutral" } };
}

function sayRound(r: TwentyRound): string {
  if (!r) return "";
  return "Round " + r.n + ": the secret was " + r.secret + ". " + (r.how === "guessed" ? r.guessed_by + " named it after " + r.asked + " questions." : r.how === "forfeit" ? r.answerer + " went silent and forfeit the round." : r.answerer + " held it.");
}

/* ---------- what the viewer has seen ---------- */

function seenKey(id: unknown): string {
  let path = "";
  try {
    path = location.pathname;
  } catch {
    path = "";
  }
  return "ac-tq-seen:" + path + ":" + String(id);
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

function tqHome(aspect: number, width: number): Home {
  const phone = width < PHONE_BELOW;
  const vfov = aspect < 1 ? 56 : 46;
  const tv = Math.tan((vfov * Math.PI) / 360);
  const th = tv * Math.max(0.45, aspect);
  const el = ((phone ? 40 : 34) * Math.PI) / 180;
  const pts: [number, number, number][] = [
    [0, BOX_Y + 1.9, 0],
    [-SEAT_R - 0.15, 0, 0.6],
    [SEAT_R + 0.15, 0, 0.6],
    [0, 1.2, -SEAT_R],
    [0, phone ? -0.55 : -0.4, SEAT_R + 0.8],
  ];
  const fz = 0.4;
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

// the candles as a round's log leaves them
function candleState(qa: TwentyQuestion[]): ("lit" | "yes" | "no")[] {
  const out: ("lit" | "yes" | "no")[] = Array.from({ length: 20 }, () => "lit" as const);
  let i = 0;
  (qa || []).forEach((x) => {
    if (x.flagged || !x.a || i >= 20) return;
    out[i++] = x.a === "yes" || x.a === "right" ? "yes" : "no";
  });
  return out;
}

/* ---------- the arena ---------- */

export default function TwentyArena3D({
  g,
  me = "",
  aspect,
  onReady,
  registerCommit,
}: {
  g: TwentyState;
  me?: string;
  aspect?: number;
  onReady?: () => void;
  registerCommit?: (fn: (() => void) | null) => void;
}) {
  const still = useReducedMotion();
  const q = useQuality(still);
  const juice = useJuiceStore(still);
  const firstVisit = useFirstVisit("tq:" + String((g && g.id) || ""));
  const [ready, setReady] = useState(false);
  const ctl = useRef<Ctl | null>(null);
  const homeRef = useRef<Home | null>(null);
  const [hostW, setHostW] = useState(() => (aspect && aspect < 1.4 ? 390 : 760));
  const meL = me.toLowerCase();
  const players: TwentyPlayer[] = (g && g.players) || NO_ITEMS;
  const rounds: TwentyRound[] = (g && g.rounds) || NO_ITEMS;
  const finished = !!g && g.status === "finished";
  const running = !!g && g.status === "running";
  const meName = (players.find((p) => String(p.name).toLowerCase() === meL) || {}).name || "";
  const big = hostW < PHONE_BELOW;

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
  const [fx, setFx] = useState<{ id: number }[]>([]);
  const fxId = useRef(0);
  const [ceremony, setCeremony] = useState(0);
  const [say, setSay] = useState("");
  const snuffAt = useRef<number[]>([]);

  // the round being shown: the one playing, else the live one
  const r = playing ? rounds[playing.n - 1] : null;
  const answerer = r ? r.answerer : running ? g.answerer : null;

  // seats: the answerer behind the box (far side), the rest round the front
  const seats: Seat[] = useMemo(() => {
    const order: string[] = (g && g.order) || [];
    const list = players.slice().sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name));
    const others = list.filter((p) => p.name !== answerer);
    const n = others.length;
    const span = Math.min(Math.PI * 1.05, 0.62 * Math.max(1, n));
    const out: Seat[] = others.map((p: TwentyPlayer, i: number) => {
      const a = Math.PI / 2 + (n > 1 ? (i / (n - 1) - 0.5) * span : 0);
      return { name: String(p.name), hex: String(p.hex || "#a78bfa"), you: String(p.name).toLowerCase() === meL, x: Math.cos(a) * SEAT_R, z: Math.sin(a) * SEAT_R };
    });
    const ans = list.find((p) => p.name === answerer);
    if (ans) out.push({ name: String(ans.name), hex: String(ans.hex || "#a78bfa"), you: String(ans.name).toLowerCase() === meL, x: 0, z: -SEAT_R + 0.4 });
    return out;
  }, [players, meL, g, answerer]);

  useEffect(() => {
    if (!ready || go) return;
    const t = setTimeout(() => setGo(true), firstVisit && !still ? 2600 : 400);
    return () => clearTimeout(t);
  }, [ready, go, firstVisit, still]);

  const isLast = (n: number) => finished && n === rounds.length;
  const land = (n: number, quiet: boolean) => {
    const rr = rounds[n - 1];
    setPlaying(null);
    setShown(n);
    if (!rr) return;
    const imp = isLast(n) ? finalImpact(g, meName) : roundImpact(rr, meName);
    juice.hit(quiet ? { ...imp, trauma: 0, stop: 0, slow: 0, pulse: 0 } : imp);
    setSay(sayRound(rr));
    if (isLast(n) && g.winner) setCeremony((c) => c + 1);
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

  // live: a new answer snuffs a candle and pops YES / NO; a new question
  // pings; the secret going in whooshes
  const liveQa: TwentyQuestion[] = (running && g.qa) || [];
  const answered = liveQa.filter((x) => !x.flagged && x.a);
  const sig = running ? g.round + ":" + (g.phase || "") + ":" + liveQa.length + ":" + answered.length : "";
  const prev = useRef<{ sig: string; answered: number; round: number } | null>(null);
  const j0 = juice;
  useEffect(() => {
    const p = prev.current;
    prev.current = { sig, answered: answered.length, round: running ? g.round : 0 };
    if (!p || !ready || p.sig === sig) return;
    if (running && p.round === g.round && answered.length > p.answered) {
      const last = answered[answered.length - 1]!;
      const yes = last.a === "yes" || last.a === "right";
      snuffAt.current[answered.length - 1] = j0.t;
      j0.word(last.a!.toUpperCase(), yes ? "#4ade80" : "#f87171");
      j0.hit({ sound: yes ? "ping" : "snip", buzz: last.by === meName ? BUZZ.commit : undefined });
    } else if (running && g.phase === "answer") j0.hit({ sound: "beat" });
    else if (running && g.phase === "ask" && p.sig.split(":")[1] === "secret") sfx("whoosh");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig, ready]);

  const state = r ? candleState(r.qa) : running ? candleState(g.qa) : finished && rounds.length ? candleState(rounds[rounds.length - 1]!.qa) : candleState([]);
  const next = running && !r && g.phase === "answer" ? Math.min(19, (g.asked || 0)) : -1;
  const openAt = 0.5;
  const open = r ? smooth(openAt, openAt + 0.7, rt) : finished && rounds.length ? 1 : 0;
  const doneAt = openAt + 3.0 + (playing && isLast(playing.n) ? 1.4 : 0);
  const secretShown = r ? (rt >= openAt + 0.4 ? r.secret : null) : finished && rounds.length ? rounds[rounds.length - 1]!.secret : null;
  const askerNow = running && !r && g.phase === "answer" && g.pending ? g.pending.by : null;
  const champion = finished && g.winner ? seats.find((s) => s.name === g.winner) || null : null;
  const home = (a: number, width: number) => tqHome(a, width);
  const first = home(aspect || 1.6, hostW);
  const label =
    "Twenty Questions, 3D view: " +
    (running ? (g.phase === "secret" ? g.answerer + " is choosing a secret. " : g.answerer + " holds a secret; " + (g.asked || 0) + " of 20 questions asked" + (askerNow ? ", " + askerNow + "'s question is waiting" : "") + ". ") : "") +
    players.map((p) => p.name + (String(p.name).toLowerCase() === meL ? " (you)" : "") + " " + (p.score || 0)).join("; ") +
    ".";
  const intro = firstVisit ? { title: "Twenty Questions", sub: players.map((p) => p.name).join(" · ") || "One secret", color: "#a78bfa" } : null;
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
          <color attach="background" args={["#04020a"]} />
          <fog attach="fog" args={["#0b0618", 18, 60]} />
          <SkyDome spec={TQ_SKY} />
          <hemisphereLight args={["#ddd6fe", "#05030a", 0.45]} />
          <directionalLight position={[-3, 8, 6]} intensity={0.55} color="#ede9fe" />
          <pointLight position={[0, 2.4, 1.6]} intensity={9} distance={9} decay={1.5} color="#fde68a" />
          <spotLight position={[0, 7, 0.5]} angle={0.4} penumbra={0.6} intensity={22} distance={12} color="#ddd6fe" />
          <Hall />
          <Box open={open} still={still} />
          {!secretShown && (running || !!r) ? (
            <sprite position={[0, BOX_Y + 0.8, 0.2]} scale={[0.6, 0.6, 1]} renderOrder={5}>
              <spriteMaterial map={textTex([{ text: "?", color: "#c4b5fd", size: 110 }], 128, 128)} transparent depthWrite={false} depthTest={false} />
            </sprite>
          ) : null}
          {secretShown ? (
            <sprite position={[0, BOX_Y + 0.9 + (r ? smooth(openAt + 0.4, openAt + 1.4, rt) * 0.7 : 0.7), 0]} scale={big ? [4.2, 1.05, 1] : [3.6, 0.9, 1]} renderOrder={6}>
              <spriteMaterial map={textTex([{ text: "“" + secretShown + "”", color: "#fde68a", size: 46 }], 600, 150)} transparent depthWrite={false} depthTest={false} />
            </sprite>
          ) : null}
          <Candles state={state} next={next} snuffAt={snuffAt.current} still={still} />
          {seats.map((s) => {
            const p: Partial<TwentyPlayer> = players.find((x) => x.name === s.name) || {};
            const isAns = s.name === answerer;
            return (
              <group key={s.name}>
                <Lantern s={s} lit={askerNow === s.name} answerer={isAns && (running || !!r)} still={still} />
                <sprite position={s.you && !isAns ? [s.x, 0.05, s.z + 0.75] : [s.x, 1.4, s.z]} scale={big ? [2.6, 1.04, 1] : [1.9, 0.76, 1]} renderOrder={5}>
                  <spriteMaterial
                    map={textTex([
                      { text: s.name + (s.you ? " (you)" : ""), color: s.hex, size: 42 },
                      { text: (p.score || 0) + " pts" + (isAns && (running || r) ? " · answering" : askerNow === s.name ? " · asking" : ""), color: isAns ? "#ddd6fe" : "rgba(237,233,254,0.92)", size: 30 },
                    ])}
                    transparent
                    depthWrite={false}
                    depthTest={false}
                  />
                </sprite>
              </group>
            );
          })}
          {playing && r && playing.t0 == null ? <ClockStart key={"c" + playing.n} onStart={(t) => setPlaying((p) => (p && p.t0 == null ? { ...p, t0: t } : p))} /> : null}
          {playing && r && playing.t0 != null ? (
            <Clock
              key={"k" + playing.n}
              t0={playing.t0}
              doneAt={doneAt}
              beats={[["open", openAt], ["title", openAt + 0.5]]}
              onT={setRt}
              onBeat={(k) => {
                if (k === "open") {
                  sfx("whoosh");
                  if (!q.lite) setFx((l) => [...l.slice(-3), { id: ++fxId.current }]);
                } else if (k === "title") {
                  juice.hit(roundImpact(r, meName));
                  setSay(sayRound(r));
                  if (isLast(playing.n)) {
                    setTimeout(() => {
                      juice.hit(finalImpact(g, meName));
                      if (g.winner) setCeremony((c) => c + 1);
                    }, 1400);
                  }
                }
              }}
              onDone={() => {
                setPlaying(null);
                setShown(playing.n);
              }}
            />
          ) : null}
          {fx.map((f) => (
            <Burst key={f.id} at={[0, BOX_Y + 0.3, 0]} hex="#fde68a" box={[0.6, 0.4, 0.6]} count={q.lite ? 20 : 44} power={1.8} piece={0.06} dur={1.2} onDone={() => setFx((l) => l.filter((x) => x.id !== f.id))} />
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
          <ArenaPost q={q} bloom={0.9} threshold={0.95} vignette={0.6} />
        </Canvas>
      </ArenaFrame>
    </JuiceProvider>
  );
}
