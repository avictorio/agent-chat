/* Trivia in 3D (2026-11-20): the quiz stage.

   The world: a glossy black stage under a violet night, a big screen at
   the back carrying the question (the quizmaster's name over it), and a
   podium per player in a shallow arc, each lit along its edges in the
   player's colour with a name plate (the second channel beside colour)
   and a stack of chips on top - one chip per 10 points of balance. The
   quizmaster's podium stands in a spotlight. A lamp over each podium
   shows that an answer is sealed in, never what it is.

   The reveal plays on the juice clock: the screen turns over to the
   answer; then each answer card flips in turn - green and a rising stack
   for a right answer, red and a falling one for a wrong one, grey for no
   answer - and a split table pays the quizmaster in gold. The last round
   adds the ceremony from the viewer's seat. Catch-up: the rounds seen are
   remembered per game (localStorage) and the latest unseen round replays
   on open (a tap skips); reduced motion lands it at once. */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { CameraControls } from "@react-three/drei";
import { CanvasTexture, Color, Object3D, SRGBColorSpace, type InstancedMesh } from "three";
import { ArenaFrame, FirstFrame, Framer, Ticker, TouchControls, goHome, useQuality, useReducedMotion, type Ctl, type Home } from "../three/arena3d";
import { ArenaPost, ImpactLayer, Intro, JuiceProvider, JuiceRig, SoundToggle, useFirstVisit, useJuice, useJuiceStore, type Impact } from "../three/juice";
import { Burst, LightPillar, Shockwave, SkyDome, type SkySpec } from "../three/atmos";
import { BUZZ } from "../three/sfx";

// One empty list for matches without players or rounds yet, so the memos
// below keep their inputs from one render to the next.
const NO_ITEMS: never[] = [];

const TV_SKY: SkySpec = {
  top: "#05020d",
  mid: "#12062a",
  horizon: "#3b1068",
  ground: "#030108",
  glow: "#c084fc",
  glowAmt: 0.45,
  stars: 0.1,
};

const PHONE_BELOW = 560;
const GAP = 2.05;
const POD_W = 1.4;
const POD_H = 1.05;
const POD_D = 0.9;
const CHIP_H = 0.07;
const CHIP_R = 0.3;
const MAX_CHIPS = 25;
const SCREEN = { w: 7.6, h: 3.2, y: 3.45, z: -2.6 };
const FLIP = 0.75; // seconds between answer cards in a reveal
const RIGHT = "#4ade80";
const WRONG = "#f87171";

type Seat = { name: string; hex: string; you: boolean };

const podX = (i: number, n: number) => (i - (n - 1) / 2) * GAP;
const podZ = (i: number, n: number) => 1.9 - 0.08 * podX(i, n) * podX(i, n);

/* ---------- canvas text ---------- */

function wrap(x: CanvasRenderingContext2D, text: string, maxW: number): string[] {
  const words = text.split(/\s+/);
  const out: string[] = [];
  let line = "";
  for (const w of words) {
    const t = line ? line + " " + w : w;
    if (x.measureText(t).width > maxW && line) {
      out.push(line);
      line = w;
    } else line = t;
  }
  if (line) out.push(line);
  return out;
}

function screenTex(head: string, body: string, foot: string, accent: string): CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 1024;
  c.height = 428;
  const x = c.getContext("2d");
  if (x) {
    x.fillStyle = "#0b0418";
    x.fillRect(0, 0, 1024, 428);
    x.strokeStyle = accent;
    x.lineWidth = 6;
    x.strokeRect(8, 8, 1008, 412);
    x.textAlign = "center";
    x.textBaseline = "middle";
    x.font = "800 30px system-ui, -apple-system, Segoe UI, sans-serif";
    x.fillStyle = accent;
    x.fillText(head.toUpperCase(), 512, 46);
    let size = 58;
    let lines: string[] = [];
    for (; size >= 26; size -= 4) {
      x.font = "700 " + size + "px Georgia, 'Times New Roman', serif";
      lines = wrap(x, body, 920);
      if (lines.length * size * 1.18 <= 280) break;
    }
    x.fillStyle = "#f5f3ff";
    const top = 222 - ((lines.length - 1) * size * 1.18) / 2;
    lines.forEach((l, i) => x.fillText(l, 512, top + i * size * 1.18));
    if (foot) {
      x.font = "800 34px system-ui, -apple-system, Segoe UI, sans-serif";
      x.fillStyle = accent;
      x.fillText(foot, 512, 388);
    }
  }
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

function plateTex(name: string, sub: string, hex: string): CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 256;
  c.height = 96;
  const x = c.getContext("2d");
  if (x) {
    x.fillStyle = "#07030f";
    x.fillRect(0, 0, 256, 96);
    x.textAlign = "center";
    x.textBaseline = "middle";
    x.font = "800 38px system-ui, -apple-system, Segoe UI, sans-serif";
    x.fillStyle = hex;
    x.fillText(name.length > 11 ? name.slice(0, 10) + "…" : name, 128, 36);
    x.font = "700 26px system-ui, -apple-system, Segoe UI, sans-serif";
    x.fillStyle = "#e9d5ff";
    x.fillText(sub, 128, 76);
  }
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  return t;
}

function cardTex(text: string, sub: string, tone: string): CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 320;
  c.height = 150;
  const x = c.getContext("2d");
  if (x) {
    x.fillStyle = "#0b0418";
    x.fillRect(0, 0, 320, 150);
    x.strokeStyle = tone;
    x.lineWidth = 6;
    x.strokeRect(4, 4, 312, 142);
    x.textAlign = "center";
    x.textBaseline = "middle";
    let size = 40;
    for (; size > 18; size -= 2) {
      x.font = "800 " + size + "px system-ui, -apple-system, Segoe UI, sans-serif";
      if (x.measureText(text).width <= 290) break;
    }
    x.fillStyle = "#faf5ff";
    x.fillText(text, 160, sub ? 58 : 75);
    if (sub) {
      x.font = "900 36px system-ui, -apple-system, Segoe UI, sans-serif";
      x.fillStyle = tone;
      x.fillText(sub, 160, 112);
    }
  }
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  return t;
}

/* ---------- the stage ---------- */

function Stage({ still }: { still: boolean }) {
  const j = useJuice();
  const ring = useRef<any>(null);
  useFrame(() => {
    if (ring.current) ring.current.emissiveIntensity = 0.9 + (still ? 0 : 0.25 * Math.sin(j.t * 1.3));
  });
  return (
    <group>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 0]}>
        <circleGeometry args={[9, 64]} />
        <meshStandardMaterial color="#08040f" metalness={0.75} roughness={0.22} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.01, 0]}>
        <ringGeometry args={[8.7, 8.85, 96]} />
        <meshStandardMaterial ref={ring} color="#08040f" emissive="#c084fc" emissiveIntensity={0.9} toneMapped={false} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.02, 0]}>
        <planeGeometry args={[300, 300]} />
        <meshStandardMaterial color="#030108" metalness={0.6} roughness={0.5} />
      </mesh>
    </group>
  );
}

/* The big screen: the question, or the answer at the reveal. */
function Screen({ tex }: { tex: CanvasTexture }) {
  useEffect(() => () => tex.dispose(), [tex]);
  return (
    <group position={[0, SCREEN.y, SCREEN.z]}>
      <mesh position={[0, 0, -0.06]}>
        <boxGeometry args={[SCREEN.w + 0.3, SCREEN.h + 0.3, 0.1]} />
        <meshStandardMaterial color="#120826" metalness={0.5} roughness={0.4} emissive="#7c3aed" emissiveIntensity={0.25} />
      </mesh>
      <mesh>
        <planeGeometry args={[SCREEN.w, SCREEN.h]} />
        <meshBasicMaterial map={tex} toneMapped={false} />
      </mesh>
      {/* the screen's two legs */}
      {[-1, 1].map((s) => (
        <mesh key={s} position={[s * (SCREEN.w / 2 - 0.4), -SCREEN.h / 2 - (SCREEN.y - SCREEN.h / 2) / 2, -0.1]}>
          <boxGeometry args={[0.18, SCREEN.y - SCREEN.h / 2, 0.18]} />
          <meshStandardMaterial color="#120826" metalness={0.6} roughness={0.35} />
        </mesh>
      ))}
    </group>
  );
}

/* One podium: body, colour edge, name plate, the sealed lamp, the answer
   card (shown at the reveal), the quizmaster's spotlight. */
function Podium({ seat, i, n, sub, asker, sealed, card, flash }: { seat: Seat; i: number; n: number; sub: string; asker: boolean; sealed: boolean; card: { text: string; sub: string; tone: string } | null; flash: string | null }) {
  const x = podX(i, n);
  const z = podZ(i, n);
  const plate = useMemo(() => plateTex(seat.name + (seat.you ? " (you)" : ""), sub, seat.hex), [seat.name, seat.you, sub, seat.hex]);
  useEffect(() => () => plate.dispose(), [plate]);
  const ctex = useMemo(() => (card ? cardTex(card.text, card.sub, card.tone) : null), [card]);
  useEffect(() => () => ctex?.dispose(), [ctex]);
  const edge = useMemo(() => new Color(flash || seat.hex).multiplyScalar(flash ? 2.2 : 1.4), [flash, seat.hex]);
  return (
    <group position={[x, 0, z]}>
      <mesh position={[0, POD_H / 2, 0]}>
        <boxGeometry args={[POD_W, POD_H, POD_D]} />
        <meshStandardMaterial color="#110a1e" metalness={0.45} roughness={0.35} />
      </mesh>
      {/* the colour edge along the top and down the front corners */}
      <mesh position={[0, POD_H + 0.02, POD_D / 2 - 0.02]}>
        <boxGeometry args={[POD_W + 0.04, 0.05, 0.05]} />
        <meshBasicMaterial color={edge} toneMapped={false} />
      </mesh>
      {[-1, 1].map((s) => (
        <mesh key={s} position={[s * (POD_W / 2), POD_H / 2, POD_D / 2 - 0.02]}>
          <boxGeometry args={[0.05, POD_H, 0.05]} />
          <meshBasicMaterial color={edge} toneMapped={false} />
        </mesh>
      ))}
      <mesh position={[0, POD_H * 0.52, POD_D / 2 + 0.005]}>
        <planeGeometry args={[POD_W * 0.9, POD_W * 0.34]} />
        <meshBasicMaterial map={plate} toneMapped={false} />
      </mesh>
      {sealed && !card ? (
        <mesh position={[0.5, POD_H + 0.16, 0.25]}>
          <sphereGeometry args={[0.09, 16, 12]} />
          <meshBasicMaterial color={new Color("#facc15").multiplyScalar(2.2)} toneMapped={false} />
        </mesh>
      ) : null}
      {ctex ? (
        <mesh position={[0, POD_H + 1.5, 0.1]}>
          <planeGeometry args={[1.85, 0.87]} />
          <meshBasicMaterial map={ctex} toneMapped={false} />
        </mesh>
      ) : null}
      {asker ? (
        <mesh position={[0, 3.2, 0]} raycast={() => null}>
          <coneGeometry args={[1.05, 6.4, 32, 1, true]} />
          <meshBasicMaterial color={new Color("#fde68a").multiplyScalar(0.5)} transparent opacity={0.09} depthWrite={false} toneMapped={false} />
        </mesh>
      ) : null}
    </group>
  );
}

/* Every chip stack in one instanced draw: chips[i] for podium i, eased on
   the juice clock toward their targets. */
function Chips({ seats, chips, still }: { seats: Seat[]; chips: number[]; still: boolean }) {
  const ref = useRef<InstancedMesh>(null);
  const j = useJuice();
  const o = useMemo(() => new Object3D(), []);
  const col = useMemo(() => new Color(), []);
  const cur = useRef<number[]>(chips.slice());
  const lastT = useRef<number | null>(null);
  const dirty = useRef(true);
  useEffect(() => {
    dirty.current = true;
  }, [chips, seats]);
  useFrame((state) => {
    const m = ref.current;
    if (!m) return;
    const dt = lastT.current == null ? 0 : Math.min(0.1, Math.max(0, j.t - lastT.current));
    lastT.current = j.t;
    let moving = false;
    let k = 0;
    const n = seats.length;
    seats.forEach((s, i) => {
      const target = chips[i] || 0;
      const c0 = cur.current[i] == null ? target : cur.current[i]!;
      const c1 = still ? target : c0 + (target - c0) * (1 - Math.exp(-dt * 5));
      cur.current[i] = Math.abs(c1 - target) < 0.02 ? target : c1;
      if (cur.current[i] !== target) moving = true;
      const shown = Math.min(MAX_CHIPS, Math.round(cur.current[i]!));
      for (let h = 0; h < shown; h++) {
        o.position.set(podX(i, n) - 0.22 + (h % 2) * 0.03, POD_H + CHIP_H / 2 + h * CHIP_H, podZ(i, n) - 0.05);
        o.rotation.set(0, 0, 0);
        o.updateMatrix();
        m.setMatrixAt(k, o.matrix);
        col.set(s.hex).multiplyScalar(h % 5 === 4 ? 1.5 : 1.0);
        m.setColorAt(k, col);
        k++;
      }
    });
    m.count = k;
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
    if (moving || dirty.current) state.invalidate();
    dirty.current = false;
  });
  return (
    <instancedMesh ref={ref} args={[undefined, undefined, 6 * MAX_CHIPS]} frustumCulled={false}>
      <cylinderGeometry args={[CHIP_R, CHIP_R, CHIP_H * 0.86, 24]} />
      <meshStandardMaterial metalness={0.3} roughness={0.35} emissive="#1b0b33" emissiveIntensity={0.4} />
    </instancedMesh>
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

/* Beat 0: the answer on the screen; beats 1..k: each card; then the split
   and the end. */
function Beats({ t0, count, onBeat, onDone }: { t0: number; count: number; onBeat: (k: number) => void; onDone: () => void }) {
  const j = useJuice();
  const fired = useRef(new Set<number>());
  useFrame((state) => {
    const t = j.t - t0;
    state.invalidate();
    for (let k = 0; k <= count + 1; k++) {
      const at = k === 0 ? 0.3 : 1.0 + (k - 1) * FLIP;
      if (t >= at && !fired.current.has(k)) {
        fired.current.add(k);
        onBeat(k);
      }
    }
    if (t >= 1.0 + count * FLIP + 0.9 && !fired.current.has(-1)) {
      fired.current.add(-1);
      onDone();
    }
  });
  return null;
}

/* ---------- impacts from the viewer's seat ---------- */

function cardImpact(right: boolean | null, mine: boolean): Impact {
  if (right == null) return { trauma: 0.04, sound: "lock" };
  if (right) return { trauma: mine ? 0.25 : 0.1, stop: mine ? 80 : 0, sound: "ping", buzz: mine ? BUZZ.scored : undefined };
  return { trauma: mine ? 0.35 : 0.1, stop: mine ? 90 : 0, sound: "buzzer", buzz: mine ? BUZZ.hitYou : undefined };
}

function roundImpact(g: any, round: any, seats: Seat[], last: boolean): Impact | null {
  const you = seats.find((s) => s.you);
  if (last) {
    if (g.draw) return { trauma: 0.2, stop: 80, sound: "whoosh", title: { big: "DRAW", small: "A tie at the top", tone: "neutral" } };
    if (g.winner && you && g.winner === you.name) return { trauma: 0.8, stop: 250, slow: 0.8, pulse: 1, buzz: BUZZ.wonMatch, sound: ["clash", "win"], title: { big: "VICTORY", small: "Top of the board", tone: "good" } };
    if (g.winner && you) return { trauma: 0.7, stop: 220, slow: 0.6, pulse: 0.8, buzz: BUZZ.lostMatch, sound: ["clash", "lose"], title: { big: "DEFEAT", small: g.winner + " takes the night", tone: "bad" } };
    if (g.winner) return { trauma: 0.5, stop: 160, slow: 0.5, pulse: 0.8, sound: ["clash", "win"], title: { big: String(g.winner).toUpperCase() + " WINS", small: "Top of the board", tone: "neutral" } };
    return null;
  }
  if (!you || !round || round.forfeit) return null;
  if (round.asker === you.name) return round.split ? { trauma: 0.2, pulse: 0.4, buzz: BUZZ.scored, title: { big: "+" + (round.bonus || 10), small: "Your question split the table", tone: "good" } } : { title: { big: "NO SPLIT", small: "Everyone " + (round.wrong.length ? "missed it" : round.right.length ? "got it" : "passed"), tone: "neutral" } };
  const a = (round.answers || {})[you.name];
  if (!a) return { title: { big: "NO ANSWER", small: "Round " + round.n, tone: "neutral" } };
  const d = (round.deltas || {})[you.name] || 0;
  return a.right ? { title: { big: "+" + d, small: "Right: " + round.answer, tone: "good" } } : { title: { big: d < 0 ? "−" + -d : "0", small: "It was " + round.answer, tone: "bad" } };
}

/* ---------- what the viewer has seen ---------- */

function seenKey(id: unknown): string {
  let path = "";
  try {
    path = location.pathname;
  } catch {
    path = "";
  }
  return "ac-tv-seen:" + path + ":" + String(id);
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

/* Home: the whole row of podiums and the screen above them. */
function tvHome(aspect: number, width: number, n: number): Home {
  const phone = width < PHONE_BELOW;
  const vfov = aspect < 1 ? 50 : 40;
  const tv = Math.tan((vfov * Math.PI) / 360);
  const th = tv * Math.max(0.45, aspect);
  const halfW = Math.max(SCREEN.w / 2 + 0.2, ((n - 1) * GAP) / 2 + POD_W);
  const halfH = (SCREEN.y + SCREEN.h / 2 + 0.3) / 2;
  // the podiums stand in front of the screen, so a little inside its
  // width still frames them all
  const d = Math.max(halfW / (th * 0.98), halfH / (tv * 0.92)) * 0.94 + 0.6;
  const el = ((phone ? 16 : 13) * Math.PI) / 180;
  const cy = halfH;
  return { pos: [0, cy + d * Math.sin(el), 1.4 + d * Math.cos(el)], fov: vfov, tz: -cy / Math.tan(el) + 1.4 };
}

/* ---------- the arena ---------- */

export default function TriviaArena3D({ g, me = "", aspect, onReady, registerCommit }: { g: any; me?: string; aspect?: number; onReady?: () => void; registerCommit?: (fn: (() => void) | null) => void }) {
  const still = useReducedMotion();
  const q = useQuality(still);
  const juice = useJuiceStore(still);
  const firstVisit = useFirstVisit("tv:" + String((g && g.id) || ""));
  const [ready, setReady] = useState(false);
  const ctl = useRef<Ctl | null>(null);
  const homeRef = useRef<Home | null>(null);
  const [hostW, setHostW] = useState(() => (aspect && aspect < 1.4 ? 390 : 760));
  const meL = me.toLowerCase();
  const players: any[] = (g && g.players) || NO_ITEMS;
  const rounds: any[] = (g && g.rounds) || NO_ITEMS;
  const finished = !!g && g.status === "finished";
  const seats: Seat[] = useMemo(() => players.map((p: any) => ({ name: String(p.name), hex: String(p.hex || "#c084fc"), you: String(p.name).toLowerCase() === meL })), [players, meL]);
  const n = seats.length || 2;

  const [init] = useState(() => {
    const R = rounds.length;
    const seen = readSeen(g && g.id);
    if (seen == null || !R || seen >= R) return { shown: R };
    return { shown: R - 1 };
  });
  const [shown, setShown] = useState(init.shown);
  const [playing, setPlaying] = useState<{ n: number; t0: number | null } | null>(null);
  const [beat, setBeat] = useState(-1);
  const [go, setGo] = useState(false);
  const [fx, setFx] = useState<{ id: number; at: [number, number, number]; hex: string }[]>([]);
  const fxId = useRef(0);
  const [ceremony, setCeremony] = useState(0);
  const [say, setSay] = useState("");

  useEffect(() => {
    if (!ready || go) return;
    const t = setTimeout(() => setGo(true), firstVisit && !still ? 2400 : 300);
    return () => clearTimeout(t);
  }, [ready, go, firstVisit, still]);

  const isLast = (k: number) => finished && k === rounds.length;
  // the answerers of a round, in seat order (the reveal's card order)
  const cardOrder = (rd: any): string[] => (rd ? seats.map((s) => s.name).filter((nm) => nm !== rd.asker) : []);
  const sayRound = (k: number) => {
    const rd = rounds[k - 1];
    if (!rd) return "";
    if (rd.forfeit) return "Round " + k + ": " + rd.asker + " ran out of time to ask.";
    return "Round " + k + ": the answer was " + rd.answer + ". " + (rd.right.length ? rd.right.join(", ") + " got it" : "Nobody got it") + (rd.split ? "; " + rd.asker + " split the table" : "") + "." + (isLast(k) ? (g.winner ? " " + g.winner + " wins." : " A tie at the top.") : "");
  };
  const finish = (k: number, quiet: boolean) => {
    setPlaying(null);
    setBeat(-1);
    setShown(k);
    const imp = roundImpact(g, rounds[k - 1], seats, isLast(k));
    if (imp) juice.hit(quiet ? { ...imp, trauma: 0, stop: 0, slow: 0, pulse: 0 } : imp);
    setSay(sayRound(k));
    if (isLast(k) && g.winner) setCeremony((c) => c + 1);
  };

  useEffect(() => {
    if (!go || playing) return;
    const R = rounds.length;
    if (R <= shown) return;
    if (R - shown > 1) setShown(R - 1);
    const rd = rounds[R - 1];
    if (still || (rd && rd.forfeit)) finish(R, false);
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

  const playRound = playing ? rounds[playing.n - 1] : null;
  const order = cardOrder(playRound);
  // balances on show: the round before the one playing, then each card's
  // swing as it flips
  const balances: Record<string, number> = useMemo(() => {
    const out: Record<string, number> = {};
    const base = playing ? (playing.n >= 2 ? rounds[playing.n - 2] : null) : rounds[shown - 1];
    seats.forEach((s) => {
      const p = players.find((x: any) => x.name === s.name) || {};
      out[s.name] = base && base.totals ? base.totals[s.name] : playing || shown < rounds.length ? 100 : p.balance != null ? p.balance : 100;
    });
    if (!playing && shown === rounds.length) seats.forEach((s) => {
      const p = players.find((x: any) => x.name === s.name) || {};
      if (p.balance != null) out[s.name] = p.balance;
    });
    if (playRound) {
      order.slice(0, Math.max(0, beat)).forEach((nm) => (out[nm] = (out[nm] || 0) + ((playRound.deltas || {})[nm] || 0)));
      if (beat > order.length && playRound.split) out[playRound.asker] = (out[playRound.asker] || 0) + (playRound.bonus || 10);
    }
    return out;
  }, [playing, rounds, shown, seats, players, playRound, order, beat]);
  const chips = seats.map((s) => Math.max(0, Math.round((balances[s.name] || 0) / 10)));

  // the screen
  const asker = playRound ? playRound.asker : g.status === "running" ? g.asker : null;
  const accent = (seats.find((s) => s.name === asker) || { hex: "#c084fc" }).hex;
  const screen = useMemo(() => {
    if (playRound && beat >= 0) return screenTex("Round " + playRound.n + " · " + playRound.asker + " asked", playRound.question || "", "ANSWER: " + String(playRound.answer || "").toUpperCase(), "#facc15");
    if (playRound) return screenTex("Round " + playRound.n + " · " + playRound.asker + " asks", playRound.question || "", "", accent);
    if (g.status === "running") return screenTex("Round " + g.round + " of " + g.rounds_total + " · " + (g.asker || "") + " asks", g.question || (g.asker || "The quizmaster") + " is writing a question…", g.phase === "judge" ? "JUDGING…" : "", accent);
    const last = rounds[rounds.length - 1];
    if (finished) return screenTex("Final", g.winner ? g.winner + " wins" : "A tie at the top", last && !last.forfeit ? "LAST ANSWER: " + String(last.answer).toUpperCase() : "", "#facc15");
    return screenTex("Trivia", "Waiting for everyone to take their seat", "", accent);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playRound, beat >= 0, g.status, g.round, g.question, g.asker, g.phase, finished, g.winner, accent]);

  const cards: Record<string, { text: string; sub: string; tone: string } | null> = {};
  if (playRound) {
    order.forEach((nm, i) => {
      if (beat < i + 1) return;
      const a = (playRound.answers || {})[nm];
      const d = (playRound.deltas || {})[nm] || 0;
      cards[nm] = a ? { text: "“" + a.answer + "”", sub: d > 0 ? "+" + d : d < 0 ? "−" + -d : "0", tone: a.right ? RIGHT : WRONG } : { text: "no answer", sub: "0", tone: "#94a3b8" };
    });
    if (beat > order.length && playRound.split) cards[playRound.asker] = { text: "split!", sub: "+" + (playRound.bonus || 10), tone: "#facc15" };
  }
  const flashOf = (nm: string): string | null => {
    const c = cards[nm];
    return c ? c.tone : null;
  };
  const live = g.status === "running" && !playing;
  const sealed = (nm: string) => live && g.phase === "answer" && nm !== g.asker && !!(players.find((p: any) => p.name === nm) || {}).committed;

  const home = (a: number, width: number) => tvHome(a, width, n);
  const first = home(aspect || 1.6, hostW);
  const label =
    "Trivia arena, 3D view: " +
    seats.map((s) => s.name + (s.you ? " (you)" : "") + " " + (balances[s.name] != null ? balances[s.name] : 100) + " points").join("; ") +
    ". " +
    (g.status === "running" ? "Round " + g.round + " of " + g.rounds_total + ", " + (g.asker || "?") + " asks" + (g.question ? ": " + g.question : "") + "." : finished ? (g.winner ? g.winner + " won." : "A tie at the top.") : "");
  const intro = firstVisit ? { title: "Trivia", sub: seats.map((s) => s.name).join(" · ") || "Ask one, bet on the rest", color: "#c084fc" } : null;
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
          <color attach="background" args={["#05020d"]} />
          <fog attach="fog" args={["#12062a", 22, 80]} />
          <SkyDome spec={TV_SKY} />
          <hemisphereLight args={["#f3e8ff", "#05020d", 0.7]} />
          <directionalLight position={[2, 9, 9]} intensity={1.15} color="#fff1f2" />
          <Stage still={still} />
          <Screen tex={screen} />
          {seats.map((s, i) => (
            <Podium key={s.name} seat={s} i={i} n={n} sub={(balances[s.name] != null ? balances[s.name] : 100) + " pts"} asker={!!asker && asker === s.name} sealed={sealed(s.name)} card={cards[s.name] || null} flash={flashOf(s.name)} />
          ))}
          <Chips seats={seats} chips={chips} still={still} />
          {playing && playing.t0 == null ? <ClockStart key={"c" + playing.n} onStart={(t) => setPlaying((p) => (p && p.t0 == null ? { ...p, t0: t } : p))} /> : null}
          {playing && playing.t0 != null && playRound ? (
            <Beats
              key={"b" + playing.n}
              t0={playing.t0}
              count={order.length + (playRound.split ? 1 : 0)}
              onBeat={(k) => {
                setBeat(k);
                if (k === 0) {
                  juice.hit({ trauma: 0.05, sound: "charge" });
                  return;
                }
                const i = seats.findIndex((s) => s.name === (k <= order.length ? order[k - 1] : playRound.asker));
                const nm = k <= order.length ? order[k - 1]! : playRound.asker;
                const a = (playRound.answers || {})[nm];
                const mine = !!seats[i] && seats[i]!.you;
                if (k <= order.length) juice.hit(cardImpact(a ? !!a.right : null, mine));
                else juice.hit({ trauma: 0.1, sound: "win" });
                if (!q.lite && i >= 0 && (k > order.length || (a && a.right))) setFx((l) => [...l.slice(-6), { id: ++fxId.current, at: [podX(i, n), POD_H + 0.6, podZ(i, n)], hex: k > order.length ? "#facc15" : seats[i]!.hex }]);
              }}
              onDone={() => finish(playing.n, false)}
            />
          ) : null}
          {fx.map((f) => (
            <Burst key={f.id} at={f.at} hex={f.hex} box={[0.7, 0.4, 0.7]} count={18} power={1.4} piece={0.07} dur={1} onDone={() => setFx((l) => l.filter((x) => x.id !== f.id))} />
          ))}
          {ceremony && g.winner && !still ? (
            <group key={"cer" + ceremony}>
              <LightPillar at={[podX(Math.max(0, seats.findIndex((s) => s.name === g.winner)), n), 0, podZ(Math.max(0, seats.findIndex((s) => s.name === g.winner)), n)]} hex={(seats.find((s) => s.name === g.winner) || { hex: "#c084fc" }).hex} height={14} width={0.9} />
              <Shockwave at={[0, 0.02, 0.5]} hex={(seats.find((s) => s.name === g.winner) || { hex: "#c084fc" }).hex} radius={9} dur={1.2} />
            </group>
          ) : null}
          <CameraControls ref={ctl} makeDefault minDistance={5} maxDistance={40} maxPolarAngle={Math.PI / 2.05} />
          <TouchControls ctl={ctl} />
          <Framer home={home} ctl={ctl} homeRef={homeRef} />
          <Intro ctl={ctl} homeRef={homeRef} enabled={!!intro && !still} ready={ready} />
          <ArenaPost q={q} bloom={0.9} threshold={0.95} vignette={0.55} />
        </Canvas>
      </ArenaFrame>
    </JuiceProvider>
  );
}

