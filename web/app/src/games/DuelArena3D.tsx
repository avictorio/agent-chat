/* The Duel in 3D (2026-11-13): rock-paper-scissors as a ceremony.

   The world: a glass stage floating in a turning nebula. Each duellist
   stands as a pedestal with an orb of their colour above it - dim and
   breathing while they think, ringed and bright once they have thrown
   (the throw itself stays hidden; your own orb shows yours, faintly).
   Score pips light along the stage in front of each pedestal, and a
   chip per round runs along the front rim in the winner's colour: the
   pattern record that makes RPS a game of reading your rival.

   A new round in state plays the four beats (lock is already shown):
     prime   0-0.75 s  both orbs rise and charge; a rising tone
     flip    0.75 s    the orbs burst open on the same frame, revealing
                       both throws as glowing glyphs
     clash   1.5 s     the glyphs fly together and collide: hit-stop,
                       shockwave, sparks; the loser's glyph shatters
                       (a tie throws both back)
     verdict 2.4 s     title card, the pip lights, the live region speaks
   The round that ends the match adds slow motion at the clash and a KO:
   the loser's orb and pedestal blow apart and a pillar of light stands
   over the winner. Losing YOUR duel lands on every channel - shake,
   red flash, buzz, sound, title - because it should be felt.

   Reduced motion: no flight, no shake; the result shows at once with
   the title card, sound and buzz. The throw pad and the verdict banner
   stay in the DOM (games.ts): the scene shows, the page acts. */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { CameraControls, Sparkles } from "@react-three/drei";
import { AdditiveBlending, BufferGeometry, CanvasTexture, Color, DodecahedronGeometry, DoubleSide, EdgesGeometry, PlaneGeometry, type Group, type Mesh, type MeshStandardMaterial, type Sprite } from "three";
import { ArenaFrame, FirstFrame, Framer, Ticker, TouchControls, goHome, useQuality, useReducedMotion, type Ctl, type Home } from "./arena3d";
import { ArenaPost, ImpactLayer, Intro, JuiceProvider, JuiceRig, SoundToggle, useFirstVisit, useJuice, useJuiceStore, type Impact, type Juice } from "./juice";
import { Burst, LightPillar, Shockwave, SkyDome, type SkySpec } from "./atmos";
import { BUZZ, sfx } from "./sfx";

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

/* Beat times, seconds of juice time. */
const PRIME = 0.75;
const FACE = 1.2;
const CLASH = 1.5;
const RESOLVE = 2.4;
const KO = 2.75;
const DONE = 3.6;

const easeOutBack = (x: number) => 1 + 2.4 * (x - 1) ** 3 + 1.4 * (x - 1) ** 2;
const easeInCubic = (x: number) => x * x * x;
const easeOutCubic = (x: number) => 1 - (1 - x) ** 3;
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

function bright(hex: string, k: number): Color {
  return new Color(hex).multiplyScalar(k);
}

/* ---------- text labels ---------- */

function labelTexture(text: string, color: string, sub?: string): { tex: CanvasTexture; aspect: number } {
  const c = document.createElement("canvas");
  const ctx = c.getContext("2d")!;
  const font = "800 64px system-ui, -apple-system, Segoe UI, sans-serif";
  ctx.font = font;
  const w1 = ctx.measureText(text).width;
  ctx.font = "700 36px system-ui, -apple-system, Segoe UI, sans-serif";
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
    x.font = "700 36px system-ui, -apple-system, Segoe UI, sans-serif";
    x.shadowBlur = 8;
    x.fillStyle = color;
    x.fillText(sub, c.width / 2, 106);
  }
  const tex = new CanvasTexture(c);
  return { tex, aspect: c.width / c.height };
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

/* ---------- the throw glyphs ---------- */

function Edges({ geometry, color }: { geometry: BufferGeometry; color: Color }) {
  const edges = useMemo(() => new EdgesGeometry(geometry, 20), [geometry]);
  return (
    <lineSegments geometry={edges}>
      <lineBasicMaterial color={color} toneMapped={false} />
    </lineSegments>
  );
}

function useMats(hex: string) {
  return useMemo(() => ({ edge: bright(hex, 2.4), core: new Color(hex) }), [hex]);
}

function Rock({ hex }: { hex: string }) {
  const m = useMats(hex);
  const geo = useMemo(() => new DodecahedronGeometry(0.44, 0), []);
  return (
    <group rotation={[0.4, 0.3, 0.2]}>
      <mesh geometry={geo}>
        <meshStandardMaterial color="#141820" emissive={m.core} emissiveIntensity={0.55} roughness={0.35} metalness={0.4} flatShading />
      </mesh>
      <Edges geometry={geo} color={m.edge} />
    </group>
  );
}

function Paper({ hex }: { hex: string }) {
  const m = useMats(hex);
  const geo = useMemo(() => {
    const g = new PlaneGeometry(0.66, 0.86, 8, 8);
    const p = g.attributes.position!;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i);
      const y = p.getY(i);
      p.setZ(i, 0.22 * (x / 0.33) ** 2 - 0.06 * Math.sin(y * 4));
    }
    g.computeVertexNormals();
    return g;
  }, []);
  const outline = useMemo(() => new PlaneGeometry(0.66, 0.86, 1, 1), []);
  return (
    <group rotation={[0.15, 0.4, -0.12]}>
      <mesh geometry={geo}>
        <meshStandardMaterial color="#eef2ff" emissive={m.core} emissiveIntensity={0.7} roughness={0.6} side={DoubleSide} />
      </mesh>
      <group position={[0, 0, 0.01]}>
        <Edges geometry={outline} color={m.edge} />
      </group>
    </group>
  );
}

function Scissors({ hex }: { hex: string }) {
  const m = useMats(hex);
  const blade = (s: number) => (
    <group rotation={[0, 0, s * 0.42]}>
      <mesh position={[0.2, 0, s * 0.01]}>
        <boxGeometry args={[0.72, 0.075, 0.03]} />
        <meshStandardMaterial color="#d9e1ea" emissive={m.core} emissiveIntensity={0.5} metalness={0.8} roughness={0.2} />
      </mesh>
      <mesh position={[-0.3, 0, s * 0.01]} rotation={[0, 0, 0]}>
        <torusGeometry args={[0.12, 0.03, 8, 24]} />
        <meshStandardMaterial color="#111" emissive={m.edge} emissiveIntensity={1} toneMapped={false} />
      </mesh>
    </group>
  );
  return (
    <group rotation={[0, 0, Math.PI / 2]} scale={1.05}>
      {blade(1)}
      {blade(-1)}
      <mesh position={[0, 0, 0.03]}>
        <sphereGeometry args={[0.035, 10, 10]} />
        <meshBasicMaterial color={m.edge} toneMapped={false} />
      </mesh>
    </group>
  );
}

function Glyph({ kind, hex }: { kind: string; hex: string }) {
  if (kind === "rock") return <Rock hex={hex} />;
  if (kind === "paper") return <Paper hex={hex} />;
  if (kind === "scissors") return <Scissors hex={hex} />;
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
  own: string | null; // your own queued throw (only on your side)
  last: string | null; // last round's throw
  out: boolean; // lost the match
  champ: boolean; // won the match
};

/* A reveal in progress: its start on the juice clock (null when no
   reveal runs). Orbs and glyphs read it to place themselves. */
type RevealRef = { t0: number | null; round: any | null };

function Duellist({ side, target, rv, still }: { side: Side; target: number; rv: RefObject<RevealRef>; still: boolean }) {
  const j = useJuice();
  const orb = useRef<Group>(null);
  const orbMat = useRef<MeshStandardMaterial>(null);
  const ring = useRef<Mesh>(null);
  const halo = useRef<Sprite>(null);
  const lockAt = useRef<number | null>(null);
  const wasLocked = useRef(side.locked);
  useEffect(() => {
    if (side.locked && !wasLocked.current) lockAt.current = j.t;
    wasLocked.current = side.locked;
  }, [side.locked, j]);
  const col = useMemo(() => new Color(side.hex), [side.hex]);
  useFrame((state) => {
    const g = orb.current;
    const mat = orbMat.current;
    if (!g || !mat) return;
    const T = j.t;
    const r = rv.current;
    const e = r && r.t0 !== null ? T - r.t0 : -1;
    let rise = 0;
    let scale = 1;
    let glowK = side.locked ? 1.5 : 0.35 + (still ? 0 : 0.15 * Math.sin(T * 2.1 + side.x));
    if (e >= 0) {
      // prime: rise and charge; flip: burst (scale out); back after
      if (e < PRIME) {
        rise = 0.55 * easeOutCubic(e / PRIME);
        glowK = 1.5 + 2.5 * (e / PRIME);
        scale = 1 + 0.12 * Math.sin(e * 40) * (e / PRIME);
      } else if (e < DONE - 0.5) {
        scale = 0.0001;
      } else {
        scale = easeOutBack(clamp01((e - (DONE - 0.5)) / 0.5));
      }
      state.invalidate();
    }
    if (side.out) {
      glowK = 0.08;
      if (e >= 0 && e > KO) scale = 0.0001;
    }
    if (side.champ) glowK = 2.2 + (still ? 0 : 0.4 * Math.sin(T * 3));
    // a lock-in pops the orb
    if (lockAt.current !== null) {
      const le = T - lockAt.current;
      if (le < 0.5) {
        scale *= 1 + 0.25 * Math.sin((le / 0.5) * Math.PI);
        glowK += 2 * (1 - le / 0.5);
        state.invalidate();
      } else lockAt.current = null;
    }
    g.position.y = ORB_Y + rise + (still ? 0 : 0.06 * Math.sin(T * 1.3 + side.x));
    g.scale.setScalar(scale);
    mat.emissiveIntensity = glowK;
    if (ring.current) {
      ring.current.visible = side.locked || side.champ;
      ring.current.rotation.z = still ? 0.6 : T * 1.6;
      ring.current.rotation.x = Math.PI / 2 + (still ? 0.3 : 0.35 * Math.sin(T * 0.9));
    }
    if (halo.current) halo.current.material.opacity = Math.min(1, 0.18 + glowK * 0.16);
  });
  const pips = Array.from({ length: target }, (_, k) => k);
  return (
    <group position={[side.x, 0, 0]}>
      {/* pedestal */}
      <mesh position={[0, STAGE_Y + 0.15 + 0.5, 0]}>
        <cylinderGeometry args={[0.8, 1.05, 1, 6]} />
        <meshStandardMaterial color="#0b0e16" metalness={0.75} roughness={0.3} emissive={side.out ? "#000" : side.hex} emissiveIntensity={side.out ? 0 : 0.07} />
      </mesh>
      <mesh position={[0, STAGE_Y + 1.16, 0]} rotation-x={Math.PI / 2}>
        <torusGeometry args={[0.82, 0.035, 8, 48]} />
        <meshBasicMaterial color={side.out ? new Color("#3a3f4a") : bright(side.hex, 2)} toneMapped={false} />
      </mesh>
      {/* orb */}
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
        {/* your own locked throw, faintly inside your orb */}
        {side.own ? (
          <group scale={0.55}>
            <Glyph kind={side.own} hex="#ffffff" />
          </group>
        ) : null}
      </group>
      <Label
        text={side.name}
        sub={side.champ ? "Winner" : side.out ? "Defeated" : side.locked ? "Locked in" : "Thinking…"}
        color={side.hex}
        position={[0, ORB_Y + 1.25, 0]}
        height={0.62}
      />
      {/* score pips on the stage, in front of the pedestal */}
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

/* Last round's throws, hovering small beside each orb between reveals. */
function LastThrows({ sides, rv }: { sides: Side[]; rv: RefObject<RevealRef> }) {
  const j = useJuice();
  const ref = useRef<Group>(null);
  useFrame(() => {
    if (!ref.current) return;
    const r = rv.current;
    const e = r && r.t0 !== null ? j.t - r.t0 : -1;
    ref.current.visible = e < 0;
    ref.current.rotation.y = 0;
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

/* ---------- the reveal ---------- */

type Beat = "prime" | "flip" | "clash" | "ko" | "done";

function Reveal({
  round,
  sides,
  final,
  rv,
  juice,
  me,
  matchLine,
  onBeat,
  onDone,
}: {
  round: any;
  sides: Side[];
  final: { winner: string } | null;
  rv: RefObject<RevealRef>;
  juice: Juice;
  me: string;
  matchLine: string;
  onBeat: (b: "resolved" | "ko") => void;
  onDone: () => void;
}) {
  const j = useJuice();
  const a = useRef<Group>(null);
  const b = useRef<Group>(null);
  const [beat, setBeat] = useState<Beat>("prime");
  const fired = useRef<Set<Beat>>(new Set());
  const [L, R] = sides as [Side, Side];
  const tL = (round.throws || {})[L.name] || null;
  const tR = (round.throws || {})[R.name] || null;
  const winner: string | null = round.winner || null;
  const tie = !winner;
  const winL = winner === L.name;
  const meL = me.toLowerCase();
  const mine = sides.some((s) => s.name.toLowerCase() === meL);
  const iWon = !!winner && winner.toLowerCase() === meL;
  const loser = tie ? null : winL ? R : L;
  const won = tie ? null : winL ? L : R;
  useEffect(() => {
    if (rv.current) rv.current.t0 = j.t;
    sfx("charge");
    return () => {
      if (rv.current) rv.current.t0 = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const once = (k: Beat, fn: () => void) => {
    if (fired.current.has(k)) return;
    fired.current.add(k);
    fn();
  };
  useFrame((state) => {
    const r = rv.current;
    if (!r || r.t0 === null) return;
    const e = j.t - r.t0;
    state.invalidate();
    if (e >= PRIME) once("flip", () => {
      setBeat("flip");
      juice.hit({ pulse: 0.35, sound: "lock" });
    });
    if (e >= CLASH) once("clash", () => {
      setBeat("clash");
      const big = !!final;
      if (tie) juice.hit({ trauma: 0.25, stop: 90, pulse: 0.5, sound: "clash", buzz: mine ? BUZZ.scored : undefined });
      else if (mine && !iWon)
        juice.hit({ trauma: 0.5, stop: big ? 220 : 140, slow: big ? 0.9 : 0, pulse: 0.75, flash: "#ff3344", flashA: 0.22, sound: ["clash", "shatter"], buzz: BUZZ.hitYou });
      else juice.hit({ trauma: mine ? 0.32 : 0.25, stop: big ? 220 : 120, slow: big ? 0.9 : 0, pulse: 0.7, sound: ["clash", "shatter"], buzz: mine ? BUZZ.scored : undefined });
    });
    if (e >= RESOLVE) once("done" as Beat, () => {
      const n = round.n || "";
      const title = tie
        ? { big: "Clash", small: "Round " + n + " · tie", tone: "neutral" as const }
        : mine
          ? iWon
            ? { big: "Round " + n + " yours", small: matchLine, tone: "good" as const }
            : { big: "Round " + n + " to " + winner, small: matchLine, tone: "bad" as const }
          : { big: "Round " + n + " · " + winner, small: matchLine, tone: "neutral" as const, hex: won ? won.hex : undefined };
      if (!final) juice.hit({ title });
      onBeat("resolved");
    });
    if (final && e >= KO) once("ko", () => {
      setBeat("ko");
      onBeat("ko");
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
          title: { big: "Defeated", small: fw + " wins the duel · " + matchLine, tone: "bad" },
        });
      else if (mine)
        juice.hit({ trauma: 0.5, pulse: 0.9, flash: "#ffd36b", flashA: 0.35, buzz: BUZZ.wonMatch, sound: ["bigboom", "win"], title: { big: "Victory", small: "You win the duel · " + matchLine, tone: "good" } });
      else juice.hit({ trauma: 0.45, pulse: 0.8, sound: ["bigboom", "win"], title: { big: fw + " wins", small: matchLine, tone: "neutral", hex: won ? won.hex : undefined } });
    });
    if (e >= (final ? DONE + 0.8 : DONE)) {
      if (rv.current) rv.current.t0 = null;
      onDone();
      return;
    }
    // glyph flight
    const place = (g: Group | null, s: Side, dirSign: number, isWinner: boolean) => {
      if (!g) return;
      const home = s.x;
      let x = home;
      let y = ORB_Y + 0.55;
      let sc = 0.0001;
      if (e >= PRIME) {
        if (e < FACE) {
          sc = easeOutBack(clamp01((e - PRIME) / 0.35));
        } else if (e < CLASH) {
          const p = easeInCubic((e - FACE) / (CLASH - FACE));
          sc = 1;
          x = home + (-dirSign * 0.45 - home) * p;
          y = ORB_Y + 0.55 + 0.1 * p;
        } else if (tie) {
          const p = easeOutCubic(clamp01((e - CLASH) / (RESOLVE - CLASH)));
          x = -dirSign * 0.45 + (home * 0.6 + dirSign * 0.45) * p;
          sc = 1 - p;
        } else if (isWinner) {
          const p = clamp01((e - CLASH) / (RESOLVE - CLASH));
          // punch through, then drift home and settle over its orb
          const through = -dirSign * 0.45 - dirSign * 1.3 * Math.sin(p * Math.PI * 0.5);
          x = p < 0.5 ? through : through + (home - through) * easeOutCubic((p - 0.5) / 0.5);
          sc = 1 + 0.25 * Math.sin(p * Math.PI);
          if (e > RESOLVE) {
            x = home;
            sc = 1;
          }
        } else sc = 0.0001; // shattered
      }
      g.position.set(x, y, 0.15);
      g.scale.setScalar(Math.max(0.0001, sc * 1.35));
      g.rotation.y = j.still ? 0 : (e - PRIME) * 1.2 * dirSign;
    };
    place(a.current, L, -1, winL);
    place(b.current, R, 1, !tie && !winL);
  });
  const atL: [number, number, number] = [L.x, ORB_Y + 0.55, 0];
  const atR: [number, number, number] = [R.x, ORB_Y + 0.55, 0];
  const mid: [number, number, number] = [0, ORB_Y + 0.6, 0.15];
  return (
    <group>
      <group ref={a} scale={0.0001}>
        {tL ? <Glyph kind={tL} hex={L.hex} /> : null}
      </group>
      <group ref={b} scale={0.0001}>
        {tR ? <Glyph kind={tR} hex={R.hex} /> : null}
      </group>
      {beat !== "prime" ? (
        <>
          <Burst at={atL} hex={L.hex} box={[0.8, 0.8, 0.8]} count={26} power={1.4} piece={0.07} dur={0.8} />
          <Burst at={atR} hex={R.hex} box={[0.8, 0.8, 0.8]} count={26} power={1.4} piece={0.07} dur={0.8} />
        </>
      ) : null}
      {beat === "clash" || beat === "ko" ? (
        <>
          <Shockwave at={[0, STAGE_Y + 0.17, 0.15]} hex={won ? won.hex : "#e2e8f0"} radius={5.5} dur={1} />
          <Burst at={mid} hex={won ? won.hex : "#e2e8f0"} box={[0.3, 0.3, 0.3]} count={40} power={2.6} piece={0.06} dur={1.1} rise={0.6} />
          {loser ? <Burst at={[-(loser.x > 0 ? -0.45 : 0.45), ORB_Y + 0.6, 0.15]} hex={loser.hex} box={[0.7, 0.8, 0.4]} count={46} power={2} piece={0.09} dur={1.4} /> : null}
        </>
      ) : null}
      {beat === "ko" && final ? (
        <>
          {loser ? <Burst at={[loser.x, STAGE_Y + 0.6, 0]} hex={loser.hex} box={[1.8, 2.2, 1.8]} count={110} power={3.2} piece={0.13} dur={2.2} /> : null}
          {won ? <LightPillar at={[won.x, STAGE_Y + 0.15, 0]} hex={won.hex} height={16} width={0.9} dur={2.4} /> : null}
          {loser ? <Shockwave at={[loser.x, STAGE_Y + 0.17, 0]} hex={loser.hex} radius={9} dur={1.4} width={0.08} /> : null}
        </>
      ) : null}
    </group>
  );
}

/* ---------- the stage ---------- */

function Stage({ rounds, sides, still }: { rounds: any[]; sides: Side[]; still: boolean }) {
  const j = useJuice();
  const runes = useRef<Group>(null);
  useFrame(() => {
    if (runes.current && !still) runes.current.rotation.y = j.t * 0.08;
  });
  const hexOf = (name: string | null) => (name ? (sides.find((s) => s.name === name) || { hex: "#e2e8f0" }).hex : "#e2e8f0");
  const n = rounds.length;
  return (
    <group>
      <mesh position={[0, STAGE_Y, 0]}>
        <cylinderGeometry args={[STAGE_R, STAGE_R * 0.92, 0.3, 64]} />
        <meshStandardMaterial color="#070912" metalness={0.7} roughness={0.25} />
      </mesh>
      <mesh position={[0, STAGE_Y + 0.155, 0]} rotation-x={-Math.PI / 2}>
        <ringGeometry args={[STAGE_R - 0.06, STAGE_R, 96]} />
        <meshBasicMaterial color={bright("#a78bfa", 1.6)} toneMapped={false} />
      </mesh>
      <group ref={runes} position={[0, STAGE_Y + 0.16, 0]}>
        <mesh rotation-x={-Math.PI / 2}>
          <ringGeometry args={[2.05, 2.12, 6, 1]} />
          <meshBasicMaterial color={bright("#22d3ee", 0.9)} transparent opacity={0.7} toneMapped={false} />
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
      {/* the light under the stage: it floats */}
      <mesh position={[0, STAGE_Y - 0.6, 0]} rotation-x={-Math.PI / 2}>
        <circleGeometry args={[STAGE_R * 1.5, 48]} />
        <meshBasicMaterial map={glow()} color="#7c3aed" transparent opacity={0.55} blending={AdditiveBlending} depthWrite={false} />
      </mesh>
      {/* one chip per round on the front rim, in the winner's colour */}
      {rounds.map((r, i) => (
        <mesh key={i} position={[(i - (n - 1) / 2) * 0.46, STAGE_Y + 0.17, 3.4]} rotation-x={-Math.PI / 2}>
          <circleGeometry args={[0.15, 24]} />
          <meshBasicMaterial color={r.winner ? bright(hexOf(r.winner), 2) : new Color("#cbd5e1")} toneMapped={false} />
        </mesh>
      ))}
    </group>
  );
}

/* ---------- camera ---------- */

/* Low and close enough to feel the stage, far enough that both
   pedestals, the pips and the round chips stay in frame; the horizon
   and the nebula fill the top of the view. */
function duelHome(aspect: number): Home {
  const vfov = aspect < 1 ? 52 : 42;
  const half = Math.tan(((vfov / 2) * Math.PI) / 180);
  const d = Math.max(12.5, 6.3 / (half * Math.max(0.5, aspect)), 3.4 / half);
  const el = (14 * Math.PI) / 180;
  return { pos: [0, d * Math.sin(el), d * Math.cos(el)], fov: vfov };
}

/* ---------- the arena ---------- */

export default function DuelArena3D({ g, me = "", aspect, onReady }: { g: any; me?: string; aspect?: number; onReady?: () => void }) {
  const still = useReducedMotion();
  const q = useQuality(still);
  const juice = useJuiceStore(still);
  const firstVisit = useFirstVisit("duel:" + String((g && g.id) || ""));
  const [ready, setReady] = useState(false);
  const ctl = useRef<Ctl | null>(null);
  const homeRef = useRef<Home | null>(null);
  const rv = useRef<RevealRef>({ t0: null, round: null });
  const players: any[] = (g && g.players) || [];
  const rounds: any[] = (g && g.rounds) || [];
  const target = (g && g.target) || 3;
  const meL = me.toLowerCase();
  const finished = g && g.status === "finished";
  const winner = finished && g.winner ? String(g.winner) : "";
  // You stand on the left; spectators see the order the match lists.
  const ordered = useMemo(() => {
    const list = players.slice(0, 2);
    if (list.length === 2 && String(list[1].name).toLowerCase() === meL) list.reverse();
    return list;
  }, [players, meL]);
  /* While a round is being revealed, the scene must not give it away:
     its pip, its chip and the match result (Winner / Defeated, the dark
     orb) arrive with the verdict and the KO beats, not with the state. */
  const [reveal, setReveal] = useState<{ round: any; final: { winner: string } | null } | null>(null);
  const [beat, setBeat] = useState<"none" | "resolved" | "ko">("none");
  const hideRound = !!reveal && beat === "none";
  const hideEnd = !!reveal && !!reveal.final && beat !== "ko";
  const shownRounds = hideRound ? rounds.slice(0, -1) : rounds;
  const last = rounds[rounds.length - 1] || null;
  const sides: Side[] = ordered.map((p, i) => {
    const you = String(p.name).toLowerCase() === meL && !!(g.you && g.you.playing);
    const wonThis = hideRound && reveal && reveal.round.winner === p.name ? 1 : 0;
    return {
      name: p.name,
      hex: p.hex || (i ? "#fb923c" : "#22d3ee"),
      x: i === 0 ? -SIDE_X : SIDE_X,
      you,
      wins: (p.wins || 0) - wonThis,
      locked: hideRound || (g.status === "running" && (!!p.thrown || (you && !!(g.you && g.you.queued)))),
      own: you && g.status === "running" && g.you && g.you.queued ? g.you.queued : null,
      last: last && last.throws ? last.throws[p.name] || null : null,
      out: !hideEnd && !!winner && p.name !== winner,
      champ: !hideEnd && !!winner && p.name === winner,
    };
  });
  // the real score (sides may be holding back a round being revealed)
  const scoreLine = ordered.map((p) => p.wins || 0).join("–");

  /* A new round in state plays the reveal (never the state at open). */
  const seen = useRef<number | null>(null);
  const [say, setSay] = useState("");
  useEffect(() => {
    const n = rounds.length;
    if (seen.current === null) {
      seen.current = n;
      return;
    }
    if (n <= seen.current) {
      seen.current = n;
      return;
    }
    seen.current = n;
    const r = rounds[n - 1];
    const final = finished && winner ? { winner } : null;
    const names = sides.map((s) => (s.you ? "you" : s.name));
    const throwsTxt = sides.map((s, i) => names[i] + " threw " + ((r.throws || {})[s.name] || "nothing")).join(", ");
    const verdict = r.winner ? (String(r.winner).toLowerCase() === meL ? "You win the round" : r.winner + " wins the round") : "A tie";
    setSay("Round " + (r.n || n) + ": " + throwsTxt + ". " + verdict + ". Score " + scoreLine + "." + (final ? " " + (final.winner.toLowerCase() === meL ? "You win the duel." : final.winner + " wins the duel.") : ""));
    if (still) {
      // No flight: the verdict lands at once, on sound, buzz and title.
      const mine = sides.some((s) => s.you);
      const iWon = !!r.winner && String(r.winner).toLowerCase() === meL;
      const imp: Impact = final
        ? { sound: iWon || !mine ? "win" : "lose", buzz: mine ? (iWon ? BUZZ.wonMatch : BUZZ.lostMatch) : undefined, title: { big: iWon ? "Victory" : mine ? "Defeated" : final.winner + " wins", small: scoreLine, tone: iWon ? "good" : mine ? "bad" : "neutral" } }
        : { sound: "clash", buzz: mine ? (iWon ? BUZZ.scored : BUZZ.hitYou) : undefined, title: { big: r.winner ? "Round " + (r.n || n) + " · " + r.winner : "Clash", small: scoreLine, tone: !r.winner ? "neutral" : iWon ? "good" : mine ? "bad" : "neutral" } };
      juice.hit(imp);
      return;
    }
    setBeat("none");
    setReveal({ round: r, final });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rounds.length, finished]);

  /* A rival locking in, seen live: a click and a pop. */
  const lockSig = sides.map((s) => (s.locked ? 1 : 0)).join("");
  const prevLock = useRef(lockSig);
  useEffect(() => {
    if (prevLock.current !== lockSig && /1/.test(lockSig) && lockSig > prevLock.current) sfx("lock");
    prevLock.current = lockSig;
  }, [lockSig]);

  const home = (a: number) => duelHome(a);
  const first = home(aspect || 1.5);
  const label =
    "Duel arena, 3D view: " +
    sides.map((s) => s.name + (s.you ? " (you)" : "") + " " + s.wins + (s.champ ? ", winner" : s.locked ? ", locked in" : "")).join(" versus ") +
    ". First to " +
    target +
    ".";
  const intro = firstVisit ? { title: "Duel", sub: sides.map((s) => s.name).join(" vs ") || "Rock · Paper · Scissors", color: "#a78bfa" } : null;
  return (
    <JuiceProvider juice={juice}>
      <ArenaFrame
        onReset={() => goHome(ctl, homeRef.current || first, !still)}
        tools={<SoundToggle />}
        overlay={
          <>
            <ImpactLayer juice={juice} intro={intro} ready={ready} />
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
          <Stage rounds={shownRounds} sides={sides} still={still} />
          {sides.map((s) => (
            <Duellist key={s.name} side={s} target={target} rv={rv} still={still} />
          ))}
          {sides.length === 2 ? <LastThrows sides={sides} rv={rv} /> : null}
          {reveal && sides.length === 2 ? (
            <Reveal
              key={(reveal.round.n || 0) + ":" + rounds.length}
              round={reveal.round}
              sides={sides}
              final={reveal.final}
              rv={rv}
              juice={juice}
              me={me}
              matchLine={scoreLine}
              onBeat={setBeat}
              onDone={() => {
                setReveal(null);
                setBeat("none");
              }}
            />
          ) : null}
          <Sparkles count={q.lite ? 40 : 80} scale={[16, 7, 12]} position={[0, 0.5, 0]} size={2} speed={still ? 0 : 0.2} opacity={0.5} color="#c4b5fd" />
          <CameraControls ref={ctl} makeDefault minDistance={5} maxDistance={40} maxPolarAngle={Math.PI / 1.95} />
          <TouchControls ctl={ctl} />
          <Framer home={(a) => home(a)} ctl={ctl} homeRef={homeRef} />
          <Intro ctl={ctl} homeRef={homeRef} enabled={!!intro && !still} ready={ready} />
          <ArenaPost q={q} bloom={1.3} threshold={0.9} vignette={0.62} />
        </Canvas>
      </ArenaFrame>
    </JuiceProvider>
  );
}
