/* The Duel in 3D (2026-11-13): rock-paper-scissors as a ceremony.

   The world: a glass stage floating in a turning nebula. Each duellist
   stands as a pedestal with an orb of their colour above it - dim and
   breathing while they think, ringed and bright once they have thrown
   (the throw stays hidden; your own orb shows yours, faintly). Score
   pips light in front of each pedestal, and a hologram plaque at the
   front of the stage keeps the round record - both throws per round,
   the winner's lit: the pattern that makes RPS a game of reading your
   rival (on a phone it is the record, since the scoreboard is hidden).

   A resolved round plays as a reveal (Reveal, timed by planFor):
     count-in  four beats at 110 BPM - "Rock, Paper, Scissors, Shoot!" -
               the orbs pump on each beat, the camera leans in
     flip      on "Shoot!" both orbs burst on the same frame, showing both
               throws as glyphs with their names under them
     contact   the glyphs meet and the matchup plays out: scissors snip
               the paper in two, paper wraps the rock and snuffs it, rock
               smashes the scissors; a tie throws both back. Each has its
               own sound. Hit-stop, shake and buzz scale with who you are
     verdict   the title card; the pip and the record update only now, so
               nothing gives the round away early
     KO        the round that ends the match: the loser's orb and pedestal
               blow apart, a pillar of light rises over the winner
   A forfeit (the round clock ran out on one player) plays as one: the
   empty orb flickers and dies on a buzzer, "No throw" under it, and the
   one thrown glyph strikes it.

   Catch-up: rounds resolve when an agent finally throws, often after
   the viewer left. The last round seen is remembered per game
   (localStorage); on opening, what was missed replays - earlier rounds
   quick, the latest in full, the KO if the match ended meanwhile. A tap
   skips to the latest verdict. Live rounds queue the same way.

   Commit: tapping a throw in the page (games.ts) calls registerCommit's
   function at once - the glyph seals into your orb with a click and a
   buzz before the server answers.

   Match point: when either player is one round from the match, the stage
   rim burns hot, the count-in leans in further and the verdict says so.

   Reduced motion: no flights, count-in or shake; each result lands at
   once on its title card, sound and buzz. The throw pad, the verdict
   banner and the scoreboard stay in the DOM: the scene shows, the page
   acts. */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { CameraControls, Sparkles } from "@react-three/drei";
import {
  AdditiveBlending,
  BufferGeometry,
  CanvasTexture,
  Color,
  DoubleSide,
  EdgesGeometry,
  IcosahedronGeometry,
  PlaneGeometry,
  type Group,
  type LineBasicMaterial,
  type Mesh,
  type MeshBasicMaterial,
  type MeshStandardMaterial,
  type Sprite,
} from "three";
import { ArenaFrame, FirstFrame, Framer, Ticker, TouchControls, goHome, useQuality, useReducedMotion, type Ctl, type Home } from "./arena3d";
import { ArenaPost, ImpactLayer, Intro, JuiceProvider, JuiceRig, SoundToggle, useFirstVisit, useJuice, useJuiceStore, type Impact, type Juice } from "./juice";
import { Burst, LightPillar, Shockwave, SkyDome, type SkySpec } from "./atmos";
import { BUZZ, sfx, type SfxName } from "./sfx";

const DUEL_SKY: SkySpec = {
  top: "#020108",
  mid: "#0a0520",
  horizon: "#1a0b2e",
  ground: "#030208",
  glow: "#7c3aed",
  glowAmt: 0.45,
  stars: 0.08,
  swirl: 0.9,
  auroraA: "#7c3aed",
  auroraB: "#06b6d4",
};

const SIDE_X = 3.6;
const STAGE_Y = -1.55;
const ORB_Y = 0.2;
const STAGE_R = 6.2;
const GLYPH_Y = ORB_Y + 0.55;
const HOT = "#ff2d95";
const PHONE_BELOW = 560;

/* ---------- timing ---------- */

const BEAT = 60 / 110;
const WORDS = ["Rock", "Paper", "Scissors", "Shoot!"];
type Mode = "full" | "quick";
type Plan = { flip: number; face: number; contact: number; verdict: number; ko: number; done: number; countIn: boolean };

function planFor(mode: Mode, forfeit: boolean, final: boolean): Plan {
  const full = mode === "full";
  // a forfeit has no count-in: the clock runs out instead
  const flip = forfeit ? (full ? 0.95 : 0.3) : full ? BEAT * 3 : 0.12;
  const face = flip + (full ? 0.45 : 0.18);
  const contact = face + (full ? 0.38 : 0.25);
  const verdict = contact + (full ? 0.9 : 0.5);
  const ko = verdict + 0.35;
  const done = final ? ko + 1.7 : verdict + (full ? 0.85 : 0.4);
  return { flip, face, contact, verdict, ko, done, countIn: full && !forfeit };
}

const easeOutBack = (x: number) => 1 + 2.4 * (x - 1) ** 3 + 1.4 * (x - 1) ** 2;
const easeInCubic = (x: number) => x * x * x;
const easeOutCubic = (x: number) => 1 - (1 - x) ** 3;
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
/* A short bump (0..1..0) starting at t0 and lasting len. */
const bump = (e: number, t0: number, len: number) => (e >= t0 && e < t0 + len ? Math.sin(((e - t0) / len) * Math.PI) : 0);

function bright(hex: string, k: number): Color {
  return new Color(hex).multiplyScalar(k);
}

const BEATS: Record<string, string> = { rock: "scissors", paper: "rock", scissors: "paper" };
const VERB: Record<string, string> = { rock: "crushes", paper: "covers", scissors: "cut" };
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/* ---------- text labels ---------- */

function labelTexture(text: string, color: string, sub?: string): { tex: CanvasTexture; aspect: number } {
  const c = document.createElement("canvas");
  const ctx = c.getContext("2d")!;
  const font = "800 64px system-ui, -apple-system, Segoe UI, sans-serif";
  const subFont = "700 36px system-ui, -apple-system, Segoe UI, sans-serif";
  ctx.font = font;
  const w1 = ctx.measureText(text).width;
  ctx.font = subFont;
  const w2 = sub ? ctx.measureText(sub).width : 0;
  c.width = Math.ceil(Math.max(w1, w2) + 48);
  c.height = sub ? 130 : 88;
  const x = c.getContext("2d")!;
  x.textAlign = "center";
  x.textBaseline = "middle";
  x.font = font;
  x.shadowColor = color;
  x.shadowBlur = 18;
  x.fillStyle = "#ffffff";
  x.fillText(text, c.width / 2, 44);
  if (sub) {
    x.font = subFont;
    x.shadowBlur = 8;
    x.fillStyle = color;
    x.fillText(sub, c.width / 2, 106);
  }
  return { tex: new CanvasTexture(c), aspect: c.width / c.height };
}

function Label({ text, sub, color, position, height }: { text: string; sub?: string; color: string; position: [number, number, number]; height: number }) {
  const { tex, aspect } = useMemo(() => labelTexture(text, color, sub), [text, sub, color]);
  useEffect(() => () => tex.dispose(), [tex]);
  return (
    <sprite position={position} scale={[height * aspect, height, 1]} renderOrder={9}>
      <spriteMaterial map={tex} transparent depthTest={false} depthWrite={false} toneMapped={false} />
    </sprite>
  );
}

/* ---------- the throw glyphs ----------
   Each glyph reads a small effect state the reveal drives:
     cut    scissors: blades snapping shut (0 open .. 1 closed)
     split  paper torn in two / scissors broken apart (0..1)
     wrap   paper folding round a rock; the rock shrinking inside (0..1)
     dim    the loser's light going out (0..1)
     fade   opacity out (0..1) */
type Fx = { cut: number; split: number; wrap: number; dim: number; fade: number };
const newFx = (): Fx => ({ cut: 0, split: 0, wrap: 0, dim: 0, fade: 0 });

function Edges({ geometry, color, onMat }: { geometry: BufferGeometry; color: Color; onMat?: (m: LineBasicMaterial | null) => void }) {
  const edges = useMemo(() => new EdgesGeometry(geometry, 25), [geometry]);
  return (
    <lineSegments geometry={edges}>
      <lineBasicMaterial ref={onMat} color={color} transparent toneMapped={false} />
    </lineSegments>
  );
}

/* A rough boulder (a gem, before: rock against rock looked like two
   gems): an icosahedron pushed in and out by a fixed lumpy field. */
let boulder: IcosahedronGeometry | null = null;
function boulderGeometry(): IcosahedronGeometry {
  if (boulder) return boulder;
  const g = new IcosahedronGeometry(0.44, 1);
  const p = g.attributes.position!;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const y = p.getY(i);
    const z = p.getZ(i);
    const k = 1 + 0.16 * Math.sin(x * 9.1 + 1.3) * Math.sin(y * 8.3 + 0.4) + 0.1 * Math.sin(z * 11.7 + 2.1) - 0.12 * Math.max(0, y / 0.44);
    p.setXYZ(i, x * k * 1.08, y * k * 0.86, z * k);
  }
  g.computeVertexNormals();
  boulder = g;
  return g;
}

function Rock({ hex, fx }: { hex: string; fx: Fx }) {
  const grp = useRef<Group>(null);
  const mat = useRef<MeshStandardMaterial>(null);
  const line = useRef<LineBasicMaterial>(null);
  const geo = boulderGeometry();
  const core = useMemo(() => new Color(hex), [hex]);
  const edge = useMemo(() => bright(hex, 2.4), [hex]);
  useFrame(() => {
    if (grp.current) grp.current.scale.setScalar(Math.max(0.0001, (1 - 0.55 * fx.wrap) * (1 - fx.fade)));
    if (mat.current) mat.current.emissiveIntensity = 0.6 * (1 - 0.85 * fx.dim);
    if (line.current) line.current.opacity = 1 - Math.max(fx.dim * 0.8, fx.fade);
  });
  return (
    <group ref={grp} rotation={[0.35, 0.5, 0.15]}>
      <mesh geometry={geo}>
        <meshStandardMaterial ref={mat} color="#2a2420" emissive={core} emissiveIntensity={0.6} roughness={0.85} metalness={0.05} flatShading />
      </mesh>
      <Edges
        geometry={geo}
        color={edge}
        onMat={(m) => {
          line.current = m;
        }}
      />
    </group>
  );
}

/* Paper, as two halves joined at the middle: they tear apart when
   scissors win, and fold round a rock when paper does. */
function Paper({ hex, fx }: { hex: string; fx: Fx }) {
  const halves = useMemo(() => {
    const mk = (side: number) => {
      const g = new PlaneGeometry(0.34, 0.88, 4, 8);
      g.translate(side * 0.17, 0, 0);
      const p = g.attributes.position!;
      for (let i = 0; i < p.count; i++) {
        const x = p.getX(i);
        const y = p.getY(i);
        p.setZ(i, 0.2 * (x / 0.34) ** 2 - 0.05 * Math.sin(y * 4));
      }
      g.computeVertexNormals();
      return g;
    };
    return [mk(-1), mk(1)] as const;
  }, []);
  const outline = useMemo(() => {
    const mk = (side: number) => {
      const g = new PlaneGeometry(0.34, 0.88, 1, 1);
      g.translate(side * 0.17, 0, 0.012);
      return g;
    };
    return [mk(-1), mk(1)] as const;
  }, []);
  const core = useMemo(() => new Color(hex), [hex]);
  const edge = useMemo(() => bright(hex, 2.4), [hex]);
  const L = useRef<Group>(null);
  const R = useRef<Group>(null);
  const mats = useRef<(MeshStandardMaterial | null)[]>([]);
  const lines = useRef<(LineBasicMaterial | null)[]>([]);
  useFrame(() => {
    const s = fx.split;
    const w = fx.wrap;
    [L.current, R.current].forEach((g, i) => {
      if (!g) return;
      const side = i === 0 ? -1 : 1;
      g.position.set(side * s * 0.55, -s * 0.5, 0);
      g.rotation.set(0, -side * w * 1.35, side * s * 0.9);
    });
    const op = 1 - Math.max(fx.fade, s * s);
    mats.current.forEach((m) => {
      if (m) {
        m.opacity = op;
        m.emissiveIntensity = 0.7 * (1 - 0.8 * fx.dim);
      }
    });
    lines.current.forEach((m) => {
      if (m) m.opacity = op;
    });
  });
  return (
    <group rotation={[0.12, 0.35, -0.1]}>
      {[L, R].map((ref, i) => (
        <group key={i} ref={ref}>
          <mesh geometry={halves[i]}>
            <meshStandardMaterial
              ref={(m) => {
                mats.current[i] = m;
              }}
              color="#eef2ff"
              emissive={core}
              emissiveIntensity={0.7}
              roughness={0.6}
              side={DoubleSide}
              transparent
            />
          </mesh>
          <Edges
            geometry={outline[i]!}
            color={edge}
            onMat={(m) => {
              lines.current[i] = m;
            }}
          />
        </group>
      ))}
    </group>
  );
}

function Scissors({ hex, fx }: { hex: string; fx: Fx }) {
  const edge = useMemo(() => bright(hex, 2.4), [hex]);
  const core = useMemo(() => new Color(hex), [hex]);
  const blades = useRef<(Group | null)[]>([]);
  const mats = useRef<(MeshStandardMaterial | MeshBasicMaterial | null)[]>([]);
  useFrame(() => {
    blades.current.forEach((b, i) => {
      if (!b) return;
      const s = i === 0 ? 1 : -1;
      const open = 0.44 * (1 - fx.cut);
      b.rotation.set(0, 0, s * (open + fx.split * 2.4));
      b.position.set(s * fx.split * 0.7, -fx.split * 0.5, 0);
    });
    const op = 1 - Math.max(fx.fade, fx.split * fx.split);
    mats.current.forEach((m) => {
      if (m) m.opacity = op;
    });
  });
  const reg = (k: number) => (m: MeshStandardMaterial | MeshBasicMaterial | null) => {
    mats.current[k] = m;
  };
  return (
    <group rotation={[0, 0, Math.PI / 2]} scale={1.05}>
      {[1, -1].map((s, i) => (
        <group
          key={s}
          ref={(g) => {
            blades.current[i] = g;
          }}
        >
          <mesh position={[0.2, 0, s * 0.012]}>
            <boxGeometry args={[0.74, 0.08, 0.03]} />
            <meshStandardMaterial ref={reg(i * 2)} color="#d9e1ea" emissive={core} emissiveIntensity={0.5} metalness={0.8} roughness={0.2} transparent />
          </mesh>
          <mesh position={[-0.3, 0, s * 0.012]}>
            <torusGeometry args={[0.13, 0.032, 8, 24]} />
            <meshBasicMaterial ref={reg(i * 2 + 1)} color={edge} toneMapped={false} transparent />
          </mesh>
        </group>
      ))}
    </group>
  );
}

function Glyph({ kind, hex, fx }: { kind: string; hex: string; fx?: Fx }) {
  const f = useMemo(() => fx || newFx(), [fx]);
  if (kind === "rock") return <Rock hex={hex} fx={f} />;
  if (kind === "paper") return <Paper hex={hex} fx={f} />;
  if (kind === "scissors") return <Scissors hex={hex} fx={f} />;
  return null;
}

/* ---------- glow sprite ---------- */

let glowTex: CanvasTexture | null = null;
function glow(): CanvasTexture {
  if (glowTex) return glowTex;
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const x = c.getContext("2d")!;
  const g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.35, "rgba(255,255,255,0.35)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  x.fillStyle = g;
  x.fillRect(0, 0, 64, 64);
  glowTex = new CanvasTexture(c);
  return glowTex;
}

/* ---------- a duellist: pedestal, orb, pips ---------- */

type Side = {
  name: string;
  hex: string;
  x: number;
  you: boolean;
  wins: number;
  locked: boolean;
  own: string | null; // your own throw this round (only on your side)
  last: string | null; // the last shown round's throw
  out: boolean; // lost the match (shown)
  champ: boolean; // won the match (shown)
  sub: string; // the state under the name
};

/* The reveal in progress, read every frame by orbs and glyphs: its
   start on the juice clock (null when none runs), its timing, and the
   side that never threw (a forfeit). */
type RevealRef = { t0: number | null; plan: Plan | null; absent: string | null };

function Duellist({ side, target, rv, still }: { side: Side; target: number; rv: RefObject<RevealRef>; still: boolean }) {
  const j = useJuice();
  const orb = useRef<Group>(null);
  const orbMat = useRef<MeshStandardMaterial>(null);
  const ring = useRef<Mesh>(null);
  const halo = useRef<Sprite>(null);
  const seal = useRef<Group>(null);
  const lockAt = useRef<number | null>(null);
  const sealAt = useRef<number | null>(null);
  const wasLocked = useRef(side.locked);
  const wasOwn = useRef(side.own);
  useEffect(() => {
    if (side.locked && !wasLocked.current) lockAt.current = j.t;
    wasLocked.current = side.locked;
  }, [side.locked, j]);
  /* Your throw sealing into your orb - on the tap, not the server's
     answer (a changed throw seals again). */
  useEffect(() => {
    if (side.own && side.own !== wasOwn.current && !still) {
      sealAt.current = j.t;
      lockAt.current = j.t + 0.32;
    }
    wasOwn.current = side.own;
  }, [side.own, j, still]);
  const col = useMemo(() => new Color(side.hex), [side.hex]);
  useFrame((state) => {
    const g = orb.current;
    const mat = orbMat.current;
    if (!g || !mat) return;
    const T = j.t;
    const r = rv.current;
    const plan = r && r.plan;
    const e = r && r.t0 !== null && plan ? T - r.t0 : -1;
    const absent = e >= 0 && !!r && r.absent === side.name;
    let rise = 0;
    let sx = 1;
    let sy = 1;
    let glowK = side.locked ? 1.5 : 0.35 + (still ? 0 : 0.15 * Math.sin(T * 2.1 + side.x));
    if (e >= 0 && plan) {
      state.invalidate();
      if (absent) {
        // the clock runs out on an empty orb: it flickers, then dies
        glowK = e < 0.6 ? (Math.sin(e * 55) > 0 ? 0.9 : 0.1) : 0.04;
        if (e >= plan.contact && e < plan.contact + 0.3) sx = sy = 1 + 0.18 * bump(e, plan.contact, 0.3);
      } else if (e < plan.flip) {
        // the count-in: rise, charge, and pump on every beat
        const k = e / plan.flip;
        rise = 0.5 * easeOutCubic(k);
        glowK = 1.5 + 2.5 * k;
        if (plan.countIn) {
          let p = 0;
          for (let b = 0; b < 3; b++) p = Math.max(p, bump(e, b * BEAT, 0.2));
          sy = 1 - 0.22 * p;
          sx = 1 + 0.12 * p;
          glowK += 1.5 * p;
        }
      } else if (e < plan.done - 0.5) {
        sx = sy = 0.0001; // burst open: the glyph is out
      } else {
        sx = sy = easeOutBack(clamp01((e - (plan.done - 0.5)) / 0.5));
      }
    }
    if (side.out) {
      glowK = 0.08;
      if (e >= 0 && plan && e > plan.ko) sx = sy = 0.0001;
    }
    if (side.champ) glowK = 2.2 + (still ? 0 : 0.4 * Math.sin(T * 3));
    if (lockAt.current !== null) {
      const le = T - lockAt.current;
      if (le >= 0 && le < 0.5) {
        const k = 1 + 0.25 * Math.sin((le / 0.5) * Math.PI);
        sx *= k;
        sy *= k;
        glowK += 2 * (1 - le / 0.5);
      }
      if (le >= 0.5) lockAt.current = null;
      else state.invalidate();
    }
    g.position.y = ORB_Y + rise + (still ? 0 : 0.06 * Math.sin(T * 1.3 + side.x));
    g.scale.set(sx, sy, sx);
    mat.emissiveIntensity = glowK;
    if (ring.current) {
      ring.current.visible = (side.locked && !absent) || side.champ;
      ring.current.rotation.z = still ? 0.6 : T * 1.6;
      ring.current.rotation.x = Math.PI / 2 + (still ? 0.3 : 0.35 * Math.sin(T * 0.9));
    }
    if (halo.current) halo.current.material.opacity = Math.min(1, 0.18 + glowK * 0.16);
    // the seal: your glyph flies up from the front into the orb
    const sg = seal.current;
    if (sg) {
      if (sealAt.current !== null) {
        const p = clamp01((T - sealAt.current) / 0.32);
        const q = easeInCubic(p);
        sg.position.set(0, lerp(-1.4, 0, q), lerp(2.4, 0, q));
        sg.scale.setScalar(lerp(1.5, 0.55, q));
        if (p >= 1) sealAt.current = null;
        state.invalidate();
      } else {
        sg.position.set(0, 0, 0);
        sg.scale.setScalar(0.55);
      }
    }
  });
  const pips = Array.from({ length: target }, (_, k) => k);
  return (
    <group position={[side.x, 0, 0]}>
      <mesh position={[0, STAGE_Y + 0.15 + 0.5, 0]}>
        <cylinderGeometry args={[0.8, 1.05, 1, 6]} />
        <meshStandardMaterial color="#0b0e16" metalness={0.75} roughness={0.3} emissive={side.out ? "#000" : side.hex} emissiveIntensity={side.out ? 0 : 0.07} />
      </mesh>
      <mesh position={[0, STAGE_Y + 1.16, 0]} rotation-x={Math.PI / 2}>
        <torusGeometry args={[0.82, 0.035, 8, 48]} />
        <meshBasicMaterial color={side.out ? new Color("#3a3f4a") : bright(side.hex, 2)} toneMapped={false} />
      </mesh>
      <group ref={orb} position={[0, ORB_Y, 0]}>
        <mesh>
          <sphereGeometry args={[0.5, 40, 28]} />
          <meshStandardMaterial ref={orbMat} color="#0a0c12" emissive={col} emissiveIntensity={0.4} roughness={0.15} metalness={0.3} transparent opacity={0.92} />
        </mesh>
        <mesh ref={ring} rotation-x={Math.PI / 2}>
          <torusGeometry args={[0.72, 0.03, 8, 64]} />
          <meshBasicMaterial color={bright(side.hex, 2.2)} toneMapped={false} />
        </mesh>
        <sprite ref={halo} scale={[2.6, 2.6, 1]}>
          <spriteMaterial map={glow()} color={side.hex} blending={AdditiveBlending} depthWrite={false} transparent opacity={0.3} />
        </sprite>
        {side.own ? (
          <group ref={seal} scale={0.55}>
            <Glyph kind={side.own} hex="#ffffff" />
          </group>
        ) : null}
      </group>
      <Label text={side.name} sub={side.sub} color={side.hex} position={[0, ORB_Y + 1.25, 0]} height={0.62} />
      {pips.map((k) => {
        const lit = side.wins > k;
        return (
          <mesh key={k} position={[(k - (target - 1) / 2) * 0.36, STAGE_Y + 0.2, 1.45]}>
            <sphereGeometry args={[0.1, 16, 12]} />
            <meshBasicMaterial color={lit ? bright(side.hex, 2.4) : new Color("#1c2230")} toneMapped={false} />
          </mesh>
        );
      })}
    </group>
  );
}

/* Last shown round's throws, small beside each orb between reveals. */
function LastThrows({ sides, rv }: { sides: Side[]; rv: RefObject<RevealRef> }) {
  const ref = useRef<Group>(null);
  useFrame(() => {
    if (!ref.current) return;
    const r = rv.current;
    ref.current.visible = !(r && r.t0 !== null);
  });
  return (
    <group ref={ref}>
      {sides.map((s) =>
        s.last ? (
          <group key={s.name} position={[s.x + (s.x < 0 ? 1.3 : -1.3), ORB_Y + 0.3, 0.4]} scale={0.72}>
            <Spin>
              <Glyph kind={s.last} hex={s.hex} />
            </Spin>
          </group>
        ) : null
      )}
    </group>
  );
}

function Spin({ children, speed = 0.6 }: { children: ReactNode; speed?: number }) {
  const j = useJuice();
  const ref = useRef<Group>(null);
  useFrame(() => {
    if (ref.current && !j.still) ref.current.rotation.y = j.t * speed;
  });
  return <group ref={ref}>{children}</group>;
}

/* ---------- the round record ----------
   A hologram plaque at the front of the stage: one column per shown
   round, the left duellist's throw over the right's, in their colours;
   the winner's throw lit with an underline, the loser's dimmed, a tie
   both half-lit, a missing throw a dash. Pictograms drawn on a canvas,
   so they read the same on every device. */
function drawThrow(x: CanvasRenderingContext2D, kind: string | null, cx: number, cy: number, r: number, color: string) {
  x.save();
  x.translate(cx, cy);
  x.strokeStyle = color;
  x.fillStyle = color;
  x.lineWidth = r * 0.16;
  x.lineJoin = "round";
  x.lineCap = "round";
  if (kind === "rock") {
    const pts = [1, 0.82, 0.95, 0.78, 1, 0.86, 0.92, 0.8];
    x.beginPath();
    pts.forEach((k, i) => {
      const a = (i / pts.length) * Math.PI * 2 - Math.PI / 2;
      const px = Math.cos(a) * r * k;
      const py = Math.sin(a) * r * k * 0.85;
      if (i) x.lineTo(px, py);
      else x.moveTo(px, py);
    });
    x.closePath();
    x.fill();
  } else if (kind === "paper") {
    const w = r * 1.25;
    const h = r * 1.6;
    x.beginPath();
    x.moveTo(-w / 2, -h / 2);
    x.lineTo(w / 2 - r * 0.4, -h / 2);
    x.lineTo(w / 2, -h / 2 + r * 0.4);
    x.lineTo(w / 2, h / 2);
    x.lineTo(-w / 2, h / 2);
    x.closePath();
    x.stroke();
    for (let k = 0; k < 3; k++) {
      x.beginPath();
      x.moveTo(-w / 2 + r * 0.25, -h / 6 + k * r * 0.4);
      x.lineTo(w / 2 - r * 0.25, -h / 6 + k * r * 0.4);
      x.stroke();
    }
  } else if (kind === "scissors") {
    x.beginPath();
    x.moveTo(-r * 0.75, -r);
    x.lineTo(r * 0.35, r * 0.3);
    x.moveTo(r * 0.75, -r);
    x.lineTo(-r * 0.35, r * 0.3);
    x.stroke();
    [-1, 1].forEach((s) => {
      x.beginPath();
      x.arc(s * r * 0.48, r * 0.66, r * 0.3, 0, Math.PI * 2);
      x.stroke();
    });
  } else {
    x.beginPath();
    x.moveTo(-r * 0.6, 0);
    x.lineTo(r * 0.6, 0);
    x.stroke();
  }
  x.restore();
}

function Record({ rounds, sides, phone }: { rounds: any[]; sides: Side[]; phone: boolean }) {
  const [L, R] = sides as [Side, Side];
  const sig = rounds.map((r) => (r.throws ? (r.throws[L.name] || "-") + (r.throws[R.name] || "-") : "--") + (r.winner || "=")).join("|") + L.hex + R.hex;
  const tex = useMemo(() => {
    const n = Math.max(1, rounds.length);
    const cw = 72;
    const ch = 140;
    const c = document.createElement("canvas");
    c.width = cw * n;
    c.height = ch;
    const x = c.getContext("2d")!;
    rounds.forEach((r, i) => {
      const cx = i * cw + cw / 2;
      const rows: [Side, number][] = [
        [L, 36],
        [R, 100],
      ];
      rows.forEach(([s, cy]) => {
        const t = (r.throws || {})[s.name] || null;
        const won = r.winner === s.name;
        const tie = !r.winner;
        x.globalAlpha = won ? 1 : tie ? 0.6 : 0.3;
        drawThrow(x, t, cx, cy, 20, s.hex);
        if (won) {
          x.globalAlpha = 1;
          x.fillStyle = s.hex;
          x.fillRect(cx - 18, cy + 25, 36, 4);
        }
      });
      x.globalAlpha = 0.25;
      x.fillStyle = "#c4b5fd";
      if (i) x.fillRect(i * cw, 14, 2, ch - 28);
    });
    const t = new CanvasTexture(c);
    return { t, n };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig]);
  useEffect(() => () => tex.t.dispose(), [tex]);
  if (!rounds.length || sides.length < 2) return null;
  const cell = phone ? 0.62 : 0.5;
  const w = cell * tex.n;
  const h = (cell * 140) / 72;
  return (
    <mesh position={[0, STAGE_Y + 0.25 + h / 2, phone ? 3.2 : 3.7]} rotation-x={-0.32}>
      <planeGeometry args={[w, h]} />
      <meshBasicMaterial map={tex.t} transparent blending={AdditiveBlending} depthWrite={false} toneMapped={false} color={new Color(1.6, 1.6, 1.6)} />
    </mesh>
  );
}

/* ---------- the reveal ---------- */

type Item = { idx: number; round: any; mode: Mode; final: { winner: string } | null; skip?: boolean };
type Mark = "flip" | "contact" | "verdict" | "ko";

function Reveal({
  item,
  sides,
  rv,
  juice,
  me,
  scoreAfter,
  matchPoint,
  matchPointAfter,
  glyphScale,
  ctl,
  homeRef,
  onVerdict,
  onKo,
  onDone,
}: {
  item: Item;
  sides: Side[];
  rv: RefObject<RevealRef>;
  juice: Juice;
  me: string;
  scoreAfter: string;
  matchPoint: boolean;
  matchPointAfter: boolean;
  glyphScale: number;
  ctl: RefObject<Ctl | null>;
  homeRef: { current: Home | null };
  onVerdict: () => void;
  onKo: () => void;
  onDone: () => void;
}) {
  const j = useJuice();
  const round = item.round;
  const final = item.final;
  const [L, R] = sides as [Side, Side];
  const tL: string | null = (round.throws || {})[L.name] || null;
  const tR: string | null = (round.throws || {})[R.name] || null;
  const forfeit = !tL !== !tR;
  const absentSide = forfeit ? (tL ? R : L) : null;
  const winner: string | null = round.winner || null;
  const tie = !winner;
  const winL = winner === L.name;
  const won = tie ? null : winL ? L : R;
  const lost = tie ? null : winL ? R : L;
  const wThrow = won ? (won === L ? tL : tR) : null;
  const lThrow = lost ? (lost === L ? tL : tR) : null;
  const meL = me.toLowerCase();
  const mine = sides.some((s) => s.name.toLowerCase() === meL);
  const iWon = !!winner && winner.toLowerCase() === meL;
  const full = item.mode === "full";
  const plan = useMemo(() => planFor(item.mode, forfeit, !!final), [item.mode, forfeit, final]);
  const fxL = useMemo(newFx, []);
  const fxR = useMemo(newFx, []);
  const a = useRef<Group>(null);
  const b = useRef<Group>(null);
  const [beat, setBeat] = useState<"count" | "flip" | "contact" | "ko">("count");
  const fired = useRef<Set<string>>(new Set());
  const pushed = useRef(false);
  const once = (k: string, fn: () => void) => {
    if (fired.current.has(k)) return;
    fired.current.add(k);
    fn();
  };

  /* The camera leans in for the count-in (further at match point) and
     settles back at the verdict - only if the viewer left it at home. */
  const lean = (k: number) => {
    const c = ctl.current as (Ctl & { smoothTime: number }) | null;
    const h = homeRef.current;
    if (!c || !h || j.still) return;
    void c.setLookAt(h.pos[0] * k, h.pos[1] * k, h.pos[2] * k, 0, 0, h.tz || 0, true);
  };
  const atHome = () => {
    const c = ctl.current as unknown as { camera: { position: { x: number; y: number; z: number } } } | null;
    const h = homeRef.current;
    if (!c || !h) return false;
    const p = c.camera.position;
    const d = Math.hypot(p.x - h.pos[0], p.y - h.pos[1], p.z - h.pos[2]);
    return d < 0.12 * Math.hypot(h.pos[0], h.pos[1], h.pos[2]);
  };

  useEffect(() => {
    if (!rv.current) return;
    rv.current.plan = plan;
    rv.current.absent = absentSide ? absentSide.name : null;
    if (item.skip) {
      // straight to the verdict: the flight's beats are spent silently
      ["count", "flip", "contact"].forEach((k) => fired.current.add(k));
      setBeat("contact");
      rv.current.t0 = j.t - plan.verdict;
    } else {
      rv.current.t0 = j.t;
      if (plan.countIn && atHome()) {
        pushed.current = true;
        lean(matchPoint ? 0.8 : 0.88);
      }
    }
    return () => {
      if (rv.current) {
        rv.current.t0 = null;
        rv.current.plan = null;
        rv.current.absent = null;
      }
      if (pushed.current) {
        const h = homeRef.current;
        if (h) goHome(ctl, h, !j.still);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* Skips arriving mid-reveal (a tap) jump to the verdict. */
  useEffect(() => {
    if (!item.skip || !rv.current || rv.current.t0 === null) return;
    const e = j.t - rv.current.t0;
    if (e < plan.verdict) {
      ["count", "flip", "contact"].forEach((k) => fired.current.add(k));
      setBeat("contact");
      rv.current.t0 = j.t - plan.verdict;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.skip]);

  const matchupSound = (): SfxName[] => {
    if (forfeit) return ["smash"];
    if (tie) return ["clash"];
    if (wThrow === "scissors") return ["snip"];
    if (wThrow === "paper") return ["wrap"];
    return ["smash", "shatter"];
  };

  useFrame((state) => {
    const r = rv.current;
    if (!r || r.t0 === null) return;
    const e = j.t - r.t0;
    state.invalidate();

    // the count-in (full mode): a word and a drum on every beat
    if (plan.countIn) {
      for (let k = 0; k < 3; k++)
        if (e >= k * BEAT)
          once("w" + k, () => {
            juice.word(WORDS[k]!, matchPoint ? HOT : undefined);
            sfx("beat");
          });
    }
    if (forfeit && full && e >= 0.6) once("time", () => juice.word("Time!", "#94a3b8"));
    if (forfeit && e >= (full ? 0.6 : 0)) once("buzzer", () => sfx("buzzer"));
    if (e >= plan.flip)
      once("flip", () => {
        setBeat("flip");
        if (plan.countIn) {
          juice.word(WORDS[3]!, matchPoint ? HOT : undefined);
          juice.hit({ pulse: 0.4, sound: "shoot" });
        } else juice.hit({ pulse: full ? 0.3 : 0.15, sound: full ? "lock" : undefined });
      });
    if (e >= plan.contact)
      once("contact", () => {
        setBeat("contact");
        const sound = matchupSound();
        if (wThrow === "scissors") sfx("tear", 0.12);
        const big = !!final;
        if (!full) juice.hit({ pulse: 0.3, sound, trauma: 0.1 });
        else if (tie) juice.hit({ trauma: 0.2, stop: 80, pulse: 0.45, sound });
        else if (mine && !iWon)
          juice.hit({
            trauma: big ? 0.7 : 0.5,
            stop: big ? 220 : 140,
            slow: big ? 0.9 : 0,
            pulse: 0.75,
            flash: "#ff3344",
            flashA: 0.22,
            sound,
            buzz: BUZZ.hitYou,
          });
        else if (mine) juice.hit({ trauma: 0.32, stop: big ? 220 : 120, slow: big ? 0.9 : 0, pulse: 0.7, sound, buzz: BUZZ.scored });
        else juice.hit({ trauma: 0.25, stop: big ? 200 : 110, slow: big ? 0.8 : 0, pulse: 0.6, sound });
      });
    if (e >= plan.verdict)
      once("verdict", () => {
        onVerdict();
        if (pushed.current) {
          pushed.current = false;
          const h = homeRef.current;
          if (h) goHome(ctl, h, !j.still);
        }
        if (final) return; // the KO carries the card
        const n = round.n || item.idx + 1;
        const how = forfeit ? "forfeit - " + (absentSide ? (absentSide.name.toLowerCase() === meL ? "you didn't throw in time" : absentSide.name + " never threw") : "") : tie ? cap(tL || "") + " meets " + (tL || "") : cap(wThrow || "") + " " + VERB[wThrow || ""] + " " + (lThrow || "");
        const small = how + " · " + scoreAfter + (matchPointAfter ? " · match point" : "");
        const title = tie
          ? { big: "Clash", small: "Round " + n + " · " + how, tone: "neutral" as const }
          : mine
            ? iWon
              ? { big: "Round " + n + " yours", small, tone: "good" as const }
              : { big: "Round " + n + " to " + winner, small, tone: "bad" as const }
            : { big: "Round " + n + " · " + winner, small, tone: "neutral" as const, hex: won ? won.hex : undefined };
        if (full || item.skip) juice.hit({ title });
      });
    if (final && e >= plan.ko)
      once("ko", () => {
        setBeat("ko");
        onKo();
        const fw = final.winner;
        if (mine && fw.toLowerCase() !== meL)
          juice.hit({
            trauma: 1,
            stop: 200,
            pulse: 1,
            flash: "#ff2244",
            flashA: 0.5,
            buzz: BUZZ.lostMatch,
            sound: ["bigboom", "lose"],
            title: { big: "Defeated", small: fw + " wins the duel · " + scoreAfter, tone: "bad" },
          });
        else if (mine)
          juice.hit({ trauma: 0.5, pulse: 0.9, flash: "#ffd36b", flashA: 0.35, buzz: BUZZ.wonMatch, sound: ["bigboom", "win"], title: { big: "Victory", small: "You win the duel · " + scoreAfter, tone: "good" } });
        else juice.hit({ trauma: 0.45, pulse: 0.8, sound: ["bigboom", "win"], title: { big: fw + " wins", small: scoreAfter, tone: "neutral", hex: won ? won.hex : undefined } });
      });
    if (e >= plan.done) {
      once("done", () => onDone());
      return;
    }

    /* The glyphs. Home: hovering where the orb was. They face off,
       fly together, and the matchup plays out after contact. */
    const after = e - plan.contact;
    const settle = clamp01((e - (plan.contact + 0.45)) / Math.max(0.1, plan.verdict - plan.contact - 0.45));
    const place = (g: Group | null, s: Side, t: string | null, fx: Fx, dir: number) => {
      if (!g) return;
      const home = s.x;
      let x = home;
      let y = GLYPH_Y;
      let sc = 0.0001;
      fx.cut = 0;
      fx.split = 0;
      fx.wrap = 0;
      fx.dim = 0;
      fx.fade = 0;
      if (!t || e < plan.flip) {
        g.scale.setScalar(0.0001);
        return;
      }
      const isW = won === s;
      const meet = -dir * 0.48; // contact point, just short of centre
      if (e < plan.face) sc = easeOutBack(clamp01((e - plan.flip) / 0.3));
      else if (e < plan.contact) {
        const p = easeInCubic((e - plan.face) / (plan.contact - plan.face));
        sc = 1;
        if (forfeit && absentSide) {
          // the lone glyph strikes the empty orb
          x = lerp(home, absentSide.x + dir * 0.7, p);
          y = GLYPH_Y + 0.5 * Math.sin(p * Math.PI);
        } else {
          x = lerp(home, meet, p);
          // rock arcs high to come down on the scissors
          if (t === "rock" && isW && lThrow === "scissors") y = GLYPH_Y + 0.9 * Math.sin(p * Math.PI * 0.9);
        }
      } else if (forfeit && absentSide) {
        sc = 1;
        const back = easeOutCubic(settle);
        x = lerp(absentSide.x + dir * 0.7, home, back);
      } else if (tie) {
        const p = easeOutCubic(clamp01(after / 0.7));
        x = lerp(meet, home * 0.6, p);
        sc = 1;
        fx.fade = clamp01((after - 0.35) / 0.4);
      } else if (isW) {
        sc = 1;
        if (t === "scissors") {
          // two quick snips at the paper, then home
          fx.cut = Math.max(bump(after, 0, 0.16), bump(after, 0.18, 0.16));
          x = lerp(meet - dir * 0.15, home, easeOutCubic(settle));
        } else if (t === "paper") {
          // slide over the rock and fold round it, then open and go home
          const over = clamp01(after / 0.18);
          fx.wrap = after < 0.5 ? clamp01(after / 0.25) : 1 - clamp01((after - 0.5) / 0.2);
          x = settle > 0 ? lerp(-meet, home, easeOutCubic(settle)) : lerp(meet, -meet, over);
          y = GLYPH_Y + 0.02;
        } else {
          // the rock lands, bounces once, and goes home
          x = lerp(meet - dir * 0.2, home, easeOutCubic(settle));
          y = GLYPH_Y + 0.45 * bump(after, 0.05, 0.35);
        }
      } else {
        // the loser
        sc = 1;
        x = meet;
        fx.dim = clamp01(after / 0.25);
        if (t === "paper") fx.split = clamp01((after - 0.1) / 0.45);
        else if (t === "rock") {
          fx.wrap = clamp01(after / 0.3);
          fx.fade = clamp01((after - 0.45) / 0.15);
        } else fx.split = clamp01(after / 0.35);
      }
      g.position.set(x, y, 0.15);
      g.scale.setScalar(Math.max(0.0001, sc * glyphScale));
      g.rotation.y = j.still ? 0 : (e - plan.flip) * 0.9 * dir;
    };
    place(a.current, L, tL, fxL, -1);
    place(b.current, R, tR, fxR, 1);
  });

  const word = (s: Side, t: string | null) => (t ? t.toUpperCase() : s === absentSide ? "NO THROW" : "");
  const mid: [number, number, number] = [0, GLYPH_Y + 0.05, 0.15];
  const lostAt: [number, number, number] = lost ? [lost === L ? -0.48 : 0.48, GLYPH_Y, 0.15] : mid;
  const lh = 0.42 * Math.max(1, glyphScale / 1.35);
  return (
    <group>
      <group ref={a} scale={0.0001}>
        {tL ? <Glyph kind={tL} hex={L.hex} fx={fxL} /> : null}
      </group>
      <group ref={b} scale={0.0001}>
        {tR ? <Glyph kind={tR} hex={R.hex} fx={fxR} /> : null}
      </group>
      {beat !== "count" && full ? (
        <>
          {[L, R].map((s) =>
            word(s, s === L ? tL : tR) ? (
              <Label key={s.name} text={word(s, s === L ? tL : tR)} color={s === absentSide ? "#94a3b8" : s.hex} position={[s.x * 0.86, ORB_Y - 0.15, 0.6]} height={lh} />
            ) : null
          )}
        </>
      ) : null}
      {beat !== "count" && !item.skip ? (
        <>
          {tL ? <Burst at={[L.x, GLYPH_Y, 0]} hex={L.hex} box={[0.8, 0.8, 0.8]} count={full ? 26 : 12} power={1.4} piece={0.07} dur={0.8} /> : null}
          {tR ? <Burst at={[R.x, GLYPH_Y, 0]} hex={R.hex} box={[0.8, 0.8, 0.8]} count={full ? 26 : 12} power={1.4} piece={0.07} dur={0.8} /> : null}
        </>
      ) : null}
      {(beat === "contact" || beat === "ko") && !item.skip ? (
        forfeit && absentSide ? (
          <>
            <Burst at={[absentSide.x, ORB_Y, 0]} hex={absentSide.hex} box={[0.9, 0.9, 0.9]} count={full ? 40 : 16} power={2} piece={0.08} dur={1.1} />
            <Shockwave at={[absentSide.x, STAGE_Y + 0.17, 0]} hex={won ? won.hex : "#e2e8f0"} radius={3.5} dur={0.8} />
          </>
        ) : (
          <>
            <Shockwave at={[0, STAGE_Y + 0.17, 0.15]} hex={won ? won.hex : "#e2e8f0"} radius={full ? 5.5 : 3} dur={1} />
            <Burst at={mid} hex={won ? won.hex : "#e2e8f0"} box={[0.3, 0.3, 0.3]} count={full ? 36 : 14} power={2.4} piece={0.06} dur={1} rise={0.6} />
            {lost && lThrow === "scissors" ? <Burst at={lostAt} hex={lost.hex} box={[0.6, 0.3, 0.3]} count={full ? 40 : 16} power={2.2} piece={0.08} dur={1.2} /> : null}
          </>
        )
      ) : null}
      {beat === "ko" && final ? (
        <>
          {lost ? <Burst at={[lost.x, STAGE_Y + 0.6, 0]} hex={lost.hex} box={[1.8, 2.2, 1.8]} count={110} power={3.2} piece={0.13} dur={2.2} /> : null}
          {won ? <LightPillar at={[won.x, STAGE_Y + 0.15, 0]} hex={won.hex} height={16} width={0.9} dur={2.4} /> : null}
          {lost ? <Shockwave at={[lost.x, STAGE_Y + 0.17, 0]} hex={lost.hex} radius={9} dur={1.4} width={0.08} /> : null}
        </>
      ) : null}
    </group>
  );
}

/* ---------- the stage ---------- */

function Stage({ still, hot }: { still: boolean; hot: boolean }) {
  const j = useJuice();
  const runes = useRef<Group>(null);
  const rim = useRef<MeshBasicMaterial>(null);
  const cool = useMemo(() => bright("#a78bfa", 1.6), []);
  const fire = useMemo(() => bright(HOT, 1.9), []);
  useFrame(() => {
    if (runes.current && !still) runes.current.rotation.y = j.t * (hot ? 0.2 : 0.08);
    if (rim.current) {
      // match point: the rim burns hot, breathing at ~1 Hz
      if (hot) rim.current.color.copy(fire).multiplyScalar(still ? 1 : 0.8 + 0.35 * Math.sin(j.t * 6.3));
      else rim.current.color.copy(cool);
    }
  });
  return (
    <group>
      <mesh position={[0, STAGE_Y, 0]}>
        <cylinderGeometry args={[STAGE_R, STAGE_R * 0.92, 0.3, 64]} />
        <meshStandardMaterial color="#070912" metalness={0.7} roughness={0.25} />
      </mesh>
      <mesh position={[0, STAGE_Y + 0.155, 0]} rotation-x={-Math.PI / 2}>
        <ringGeometry args={[STAGE_R - (hot ? 0.12 : 0.06), STAGE_R, 96]} />
        <meshBasicMaterial ref={rim} color={cool} toneMapped={false} />
      </mesh>
      <group ref={runes} position={[0, STAGE_Y + 0.16, 0]}>
        <mesh rotation-x={-Math.PI / 2}>
          <ringGeometry args={[2.05, 2.12, 6, 1]} />
          <meshBasicMaterial color={bright(hot ? HOT : "#22d3ee", 0.9)} transparent opacity={0.7} toneMapped={false} />
        </mesh>
        <mesh rotation-x={-Math.PI / 2} rotation-z={Math.PI / 6}>
          <ringGeometry args={[2.05, 2.12, 6, 1]} />
          <meshBasicMaterial color={bright("#a78bfa", 0.9)} transparent opacity={0.7} toneMapped={false} />
        </mesh>
        <mesh rotation-x={-Math.PI / 2}>
          <ringGeometry args={[4.6, 4.64, 96]} />
          <meshBasicMaterial color={bright("#a78bfa", 0.6)} transparent opacity={0.6} toneMapped={false} />
        </mesh>
      </group>
      <mesh position={[0, STAGE_Y - 0.6, 0]} rotation-x={-Math.PI / 2}>
        <circleGeometry args={[STAGE_R * 1.5, 48]} />
        <meshBasicMaterial map={glow()} color={hot ? "#be185d" : "#7c3aed"} transparent opacity={0.55} blending={AdditiveBlending} depthWrite={false} />
      </mesh>
    </group>
  );
}

/* ---------- camera ---------- */

/* Low and close enough to feel the stage, far enough that both
   pedestals, the pips and the record stay in frame; the horizon and
   the nebula fill the top. On a phone the stage's outer rim may crop:
   the duellists and their throws are what must read at 390 px. */
function duelHome(aspect: number, width: number): Home {
  const vfov = aspect < 1 ? 52 : 42;
  const half = Math.tan(((vfov / 2) * Math.PI) / 180);
  const phone = width < PHONE_BELOW;
  const d = phone ? Math.max(9.6, 5.5 / (half * Math.max(0.5, aspect))) : Math.max(12.5, 6.3 / (half * Math.max(0.5, aspect)), 3.4 / half);
  const el = ((phone ? 15 : 14) * Math.PI) / 180;
  return { pos: [0, d * Math.sin(el), d * Math.cos(el)], fov: vfov };
}

/* ---------- what the viewer has seen ---------- */

type Seen = { n: number; end: boolean };
function seenKey(id: unknown): string {
  let path = "";
  try {
    path = location.pathname;
  } catch {
    path = "";
  }
  return "ac-duel-seen:" + path + ":" + String(id);
}
function readSeen(id: unknown): Seen | null {
  try {
    const v = localStorage.getItem(seenKey(id));
    if (!v) return null;
    const o = JSON.parse(v);
    return typeof o.n === "number" ? { n: o.n, end: !!o.end } : null;
  } catch {
    return null;
  }
}
function writeSeen(id: unknown, s: Seen) {
  try {
    localStorage.setItem(seenKey(id), JSON.stringify(s));
  } catch {
    // storage unavailable: the next open just won't replay
  }
}

/* ---------- the arena ---------- */

export default function DuelArena3D({
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
  registerCommit?: (fn: ((t: string) => void) | null) => void;
}) {
  const still = useReducedMotion();
  const q = useQuality(still);
  const juice = useJuiceStore(still);
  const firstVisit = useFirstVisit("duel:" + String((g && g.id) || ""));
  const [ready, setReady] = useState(false);
  const ctl = useRef<Ctl | null>(null);
  const homeRef = useRef<Home | null>(null);
  const rv = useRef<RevealRef>({ t0: null, plan: null, absent: null });
  const players: any[] = (g && g.players) || [];
  const rounds: any[] = (g && g.rounds) || [];
  const target = (g && g.target) || 3;
  const meL = me.toLowerCase();
  const finished = !!g && g.status === "finished";
  const winner = finished && g.winner ? String(g.winner) : "";
  const [hostW, setHostW] = useState(() => (aspect && aspect < 1.4 ? 390 : 700));
  const phone = hostW < PHONE_BELOW;

  // You stand on the left; spectators see the order the match lists.
  const ordered = useMemo(() => {
    const list = players.slice(0, 2);
    if (list.length === 2 && String(list[1].name).toLowerCase() === meL) list.reverse();
    return list;
  }, [players, meL]);
  const youPlaying = !!(g && g.you && g.you.playing);

  /* The queue of reveals, and how much of the match the scene shows:
     `shown` rounds have their verdict on screen; `endShown` says the
     match result (Winner / Defeated) is out. At open, rounds the viewer
     never saw are queued (the latest in full, at most three). */
  const [init] = useState(() => {
    const n = rounds.length;
    const seen = readSeen(g && g.id);
    const none = { shown: n, end: true, queue: [] as Item[], catchup: 0 };
    if (still || !seen || !n) return none;
    let from = Math.min(seen.n, n);
    const missedEnd = finished && !seen.end;
    if (from >= n && !missedEnd) return none;
    if (from >= n) from = n - 1;
    from = Math.max(from, n - 3);
    const queue: Item[] = [];
    for (let i = from; i < n; i++)
      queue.push({ idx: i, round: rounds[i], mode: i === n - 1 ? "full" : "quick", final: i === n - 1 && finished && winner ? { winner } : null });
    return { shown: from, end: !finished, queue, catchup: queue.length };
  });
  const [queue, setQueue] = useState<Item[]>(init.queue);
  const [shown, setShown] = useState(init.shown);
  const [endShown, setEndShown] = useState(init.end);
  const [catchup, setCatchup] = useState(init.catchup);
  const [go, setGo] = useState(false);
  const current = go ? queue[0] || null : null;

  // Replays start once the scene is up (after the entry flight).
  useEffect(() => {
    if (!ready || go) return;
    const t = setTimeout(() => setGo(true), firstVisit && !still ? 2700 : 600);
    return () => clearTimeout(t);
  }, [ready, go, firstVisit, still]);

  // Remember what this viewer has seen.
  useEffect(() => {
    writeSeen(g && g.id, { n: shown, end: endShown && finished });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown, endShown, finished]);

  /* Your throw, sealed the moment you tap it (games.ts calls this
     before the request); the server's answer replaces it. */
  const [pending, setPending] = useState<{ t: string; at: number; round: number } | null>(null);
  useEffect(() => {
    if (!registerCommit) return;
    registerCommit((t: string) => {
      setPending({ t, at: Date.now(), round: rounds.length });
      juice.hit({ sound: "lock", buzz: BUZZ.commit, pulse: 0.2 });
    });
    return () => registerCommit(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [registerCommit, juice, rounds.length]);
  const queued: string | null = (g && g.you && g.you.queued) || null;
  useEffect(() => {
    if (!pending) return;
    if (queued === pending.t || rounds.length !== pending.round) {
      setPending(null);
      return;
    }
    const t = setTimeout(() => setPending(null), 8000);
    return () => clearTimeout(t);
  }, [pending, queued, rounds.length]);

  const revealing = !!current;
  const shownRounds = rounds.slice(0, shown);
  const lastShown = shownRounds[shownRounds.length - 1] || null;
  const winsIn = (list: any[], name: string) => list.filter((r) => r.winner === name).length;
  const sides: Side[] = ordered.map((p, i) => {
    const you = String(p.name).toLowerCase() === meL && youPlaying;
    const wins = shown === rounds.length ? p.wins || 0 : winsIn(shownRounds, p.name);
    const thrownIn = current ? !!(current.round.throws || {})[p.name] : false;
    const running = g.status === "running";
    const own = you && running && !current ? pending?.t || queued : null;
    const locked = current ? thrownIn : running && (!!p.thrown || !!own);
    const out = endShown && !!winner && p.name !== winner;
    const champ = endShown && !!winner && p.name === winner;
    return {
      name: p.name,
      hex: p.hex || (i ? "#fb923c" : "#22d3ee"),
      x: i === 0 ? -SIDE_X : SIDE_X,
      you,
      wins,
      locked,
      own,
      last: lastShown && lastShown.throws ? lastShown.throws[p.name] || null : null,
      out,
      champ,
      sub: champ ? "Winner" : out ? "Defeated" : current ? (thrownIn ? "Locked in" : "No throw") : locked ? "Locked in" : running ? "Thinking…" : "",
    };
  });
  const scoreOf = (list: any[]) => ordered.map((p) => winsIn(list, p.name)).join("–");
  const realScore = ordered.map((p) => p.wins || 0).join("–");
  const mpOf = (list: any[]) => ordered.some((p) => winsIn(list, p.name) === target - 1);
  const matchPointNow = !endShown || g.status === "running" ? sides.some((s) => s.wins === target - 1) : false;

  /* New rounds while open queue up like the catch-up; the newest plays
     in full. A match that ends without a new round (nobody threw in
     time) says so at once. */
  const prev = useRef({ n: rounds.length, finished });
  const [say, setSay] = useState("");
  useEffect(() => {
    const n = rounds.length;
    const was = prev.current;
    prev.current = { n, finished };
    if (n > was.n) {
      const r = rounds[n - 1];
      const final = finished && winner ? { winner } : null;
      const names = sides.map((s) => (s.you ? "you" : s.name));
      const throwsTxt = sides
        .map((s, i) => {
          const t = (r.throws || {})[s.name];
          return t ? names[i] + " threw " + t : names[i] + (s.you ? " didn't throw in time" : " never threw");
        })
        .join(", ");
      const verdict = r.winner ? (String(r.winner).toLowerCase() === meL ? "You win the round" : r.winner + " wins the round") : "A tie";
      setSay(
        "Round " + (r.n || n) + ": " + throwsTxt + ". " + verdict + ". Score " + realScore + "." + (final ? " " + (final.winner.toLowerCase() === meL ? "You win the duel." : final.winner + " wins the duel.") : "")
      );
      if (still) {
        const mine = sides.some((s) => s.you);
        const iWon = !!r.winner && String(r.winner).toLowerCase() === meL;
        const imp: Impact = final
          ? {
              sound: iWon || !mine ? "win" : "lose",
              buzz: mine ? (iWon ? BUZZ.wonMatch : BUZZ.lostMatch) : undefined,
              title: { big: iWon ? "Victory" : mine ? "Defeated" : final.winner + " wins", small: realScore, tone: iWon ? "good" : mine ? "bad" : "neutral" },
            }
          : {
              sound: "clash",
              buzz: mine ? (iWon ? BUZZ.scored : BUZZ.hitYou) : undefined,
              title: { big: r.winner ? "Round " + (r.n || n) + " · " + r.winner : "Clash", small: realScore, tone: !r.winner ? "neutral" : iWon ? "good" : mine ? "bad" : "neutral" },
            };
        juice.hit(imp);
        setShown(n);
        setEndShown(true);
        return;
      }
      const items: Item[] = [];
      for (let i = was.n; i < n; i++) items.push({ idx: i, round: rounds[i], mode: i === n - 1 ? "full" : "quick", final: i === n - 1 ? final : null });
      if (final) setEndShown(false);
      setQueue((qq) => [...qq, ...items]);
      return;
    }
    if (finished && !was.finished) {
      setEndShown(true);
      juice.hit({ title: winner ? { big: winner + " wins", small: "Nobody threw in time · " + realScore, tone: winner.toLowerCase() === meL ? "good" : "neutral" } : { big: "Match over", small: "Nobody threw in time", tone: "neutral" } });
      setSay("The match is over" + (winner ? ": " + winner + " wins." : "."));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rounds.length, finished]);

  /* A rival locking in, seen live: a click and a pop (your own lock
     already clicked on the tap). */
  const rivalSig = sides.map((s) => (!s.you && s.locked && !current ? 1 : 0)).join("");
  const prevRival = useRef(rivalSig);
  useEffect(() => {
    if (rivalSig !== prevRival.current && rivalSig.split("1").length > prevRival.current.split("1").length) sfx("lock");
    prevRival.current = rivalSig;
  }, [rivalSig]);

  /* A tap during reveals skips to the newest verdict. */
  const skip = () => {
    if (!queue.length) return;
    const lastItem = queue[queue.length - 1]!;
    if (queue.length > 1) setShown(lastItem.idx);
    setQueue([{ ...lastItem, skip: true }]);
    setGo(true);
  };

  const home = (a: number, width: number) => duelHome(a, width);
  const first = home(aspect || 1.5, hostW);
  const label =
    "Duel arena, 3D view: " +
    sides.map((s) => s.name + (s.you ? " (you)" : "") + " " + s.wins + (s.champ ? ", winner" : s.locked ? ", locked in" : "")).join(" versus ") +
    ". First to " +
    target +
    ".";
  const intro = firstVisit ? { title: "Duel", sub: sides.map((s) => s.name).join(" vs ") || "Rock · Paper · Scissors", color: "#a78bfa" } : null;
  const glyphScale = phone ? 1.7 : 1.35;
  const curPos = current && catchup > 1 ? Math.max(1, catchup - queue.length + 1) : 0;
  return (
    <JuiceProvider juice={juice}>
      <ArenaFrame
        onReset={() => goHome(ctl, homeRef.current || first, !still)}
        onSize={(width) => setHostW(width)}
        tools={<SoundToggle />}
        frameProps={{
          onPointerDown: (e) => {
            if (revealing && !(e.target as HTMLElement).closest("button")) skip();
          },
        }}
        overlay={
          <>
            <ImpactLayer juice={juice} intro={intro} ready={ready} />
            {curPos ? (
              <div className="duel-catchup" aria-hidden="true">
                Missed rounds · {curPos} of {catchup} · tap to skip
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
          <color attach="background" args={["#0b0618"]} />
          <SkyDome spec={DUEL_SKY} />
          <ambientLight intensity={0.45} />
          <directionalLight position={[3, 8, 6]} intensity={0.9} color="#e9d5ff" />
          <pointLight position={[0, 3.2, 2.5]} intensity={18} distance={14} decay={2} color="#c4b5fd" />
          <Stage still={still} hot={matchPointNow && !(endShown && finished)} />
          {sides.map((s) => (
            <Duellist key={s.name} side={s} target={target} rv={rv} still={still} />
          ))}
          {sides.length === 2 ? <LastThrows sides={sides} rv={rv} /> : null}
          {sides.length === 2 ? <Record rounds={shownRounds} sides={sides} phone={phone} /> : null}
          {current && sides.length === 2 ? (
            <Reveal
              key={current.idx + (current.skip ? ":s" : "")}
              item={current}
              sides={sides}
              rv={rv}
              juice={juice}
              me={me}
              scoreAfter={current.idx === rounds.length - 1 ? realScore : scoreOf(rounds.slice(0, current.idx + 1))}
              matchPoint={mpOf(rounds.slice(0, current.idx))}
              matchPointAfter={!current.final && mpOf(rounds.slice(0, current.idx + 1))}
              glyphScale={glyphScale}
              ctl={ctl}
              homeRef={homeRef}
              onVerdict={() => setShown((s) => Math.max(s, current.idx + 1))}
              onKo={() => setEndShown(true)}
              onDone={() => {
                setShown((s) => Math.max(s, current.idx + 1));
                if (current.final) setEndShown(true);
                setQueue((qq) => qq.slice(1));
              }}
            />
          ) : null}
          <Sparkles count={q.lite ? 40 : 80} scale={[16, 7, 12]} position={[0, 0.5, 0]} size={2} speed={still ? 0 : 0.2} opacity={0.5} color="#c4b5fd" />
          <CameraControls ref={ctl} makeDefault minDistance={5} maxDistance={40} maxPolarAngle={Math.PI / 1.95} />
          <TouchControls ctl={ctl} />
          <Framer home={home} ctl={ctl} homeRef={homeRef} />
          <Intro ctl={ctl} homeRef={homeRef} enabled={!!intro && !still} ready={ready} />
          <ArenaPost q={q} bloom={1.3} threshold={0.9} vignette={0.62} />
        </Canvas>
      </ArenaFrame>
    </JuiceProvider>
  );
}
