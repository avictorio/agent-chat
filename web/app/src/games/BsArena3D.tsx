/* Battleship 3D arena (2026-11-12, Direction C + A's ocean motion,
   approved by Anthony from the mock-up page): a night tactical scene -
   two glowing-grid ocean tiles on dark reflective water, procedural
   steel warships with real silhouettes, bombs that visibly drop, and
   damage that persists: hit cells burn, sunk ships stay on the board
   as charred, listing, burning wreckage.

   The scene is a pure function of the same per-viewer game state the
   2D arena consumes (you.fleet / you.shots / you.sunk_ships for a
   captain, g.boards for a spectator). The secrecy contract is the
   server's: un-hit enemy hulls are never in the state, so they can
   never render. Shot animations replay from last_move diffs and are
   presentation only. Mounted by games.ts through a dynamic import so
   three.js stays in the lazy chunk. */
import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { Canvas, useFrame, type ThreeEvent } from "@react-three/fiber";
import {
  ArenaFrame,
  FirstFrame,
  Framer,
  Ticker,
  TouchControls,
  fitHome,
  goHome,
  useQuality,
  useReducedMotion,
  type Ctl,
  type Home,
  type Quality,
} from "./arena3d";
import { CameraControls, MeshReflectorMaterial, Sparkles, Trail } from "@react-three/drei";
import { Bloom, EffectComposer, Vignette } from "@react-three/postprocessing";
import {
  AdditiveBlending,
  CanvasTexture,
  Color,
  Euler,
  ExtrudeGeometry,
  MeshStandardMaterial,
  Object3D,
  Quaternion,
  Shape,
  type BufferAttribute,
  type Group,
  type InstancedMesh,
  type Material,
  type Mesh,
  type PointLight,
  type Points,
  type SpriteMaterial,
} from "three";

type GL = any;

const SEA = "#04070d";
const GRID_C = "#22d3ee";

/* prefers-reduced-motion, provided inside the Canvas: under it the
   scene freezes decorative motion (flame flicker, the flickering
   firelight, pulses, the swell, drifting light, sparkles) and skips
   the bomb-drop and camera-shake shot animation entirely. */
const Still = createContext(false);

/* ---------- small helpers ---------- */

function labelXY(label: string): { col: number; row: number } {
  const col = label.charCodeAt(0) - 65;
  const row = parseInt(label.slice(1), 10) - 1;
  return { col, row };
}
/* Local world coords of a cell centre inside a tile (tile centred at 0,0). */
function cellLocal(label: string, w: number, h: number): { x: number; z: number } {
  const { col, row } = labelXY(label);
  return { x: col - (w - 1) / 2, z: row - (h - 1) / 2 };
}
/* The swell the ships ride (A's ocean motion, kept gentle so the board reads). */
function waveH(x: number, z: number, t: number): number {
  return (
    0.055 * Math.sin(0.55 * x + 0.9 * t) +
    0.045 * Math.sin(0.7 * z - 0.7 * t) +
    0.03 * Math.sin(0.35 * (x + z) + 0.5 * t)
  );
}
function hash01(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) n = (n * 31 + s.charCodeAt(i)) >>> 0;
  return (n % 997) / 997;
}

/* ---------- procedural textures ---------- */

let radialTex: CanvasTexture | null = null;
function glowTexture(): CanvasTexture {
  if (radialTex) return radialTex;
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const ctx = c.getContext("2d")!;
  const gr = ctx.createRadialGradient(64, 64, 2, 64, 64, 64);
  gr.addColorStop(0, "rgba(255,255,255,1)");
  gr.addColorStop(0.35, "rgba(255,255,255,0.55)");
  gr.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = gr;
  ctx.fillRect(0, 0, 128, 128);
  radialTex = new CanvasTexture(c);
  return radialTex;
}
const textTexCache = new Map<string, CanvasTexture>();
function textTexture(text: string, color: string, wide?: boolean): CanvasTexture {
  const key = text + "|" + color + "|" + (wide ? "w" : "");
  const hit = textTexCache.get(key);
  if (hit) return hit;
  const c = document.createElement("canvas");
  const font = "700 52px system-ui, sans-serif";
  let width = 96;
  if (wide) {
    // Wide labels size to their text, so a longer title ("Ada's
    // waters - tap to fire") is not clipped; sprites scale by aspect.
    const m = c.getContext("2d")!;
    m.font = font;
    width = Math.max(192, Math.ceil(m.measureText(text).width + 48));
  }
  c.width = width;
  c.height = 96;
  const ctx = c.getContext("2d")!;
  ctx.font = font;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.shadowColor = color;
  ctx.shadowBlur = 12;
  ctx.fillStyle = color;
  ctx.fillText(text, c.width / 2, 50);
  const tex = new CanvasTexture(c);
  textTexCache.set(key, tex);
  return tex;
}
/* Sprite scale for a text texture at a given world height. */
function textScale(tex: CanvasTexture, height: number): [number, number, number] {
  const img = tex.image as { width: number; height: number };
  return [height * (img.width / img.height), height, 1];
}

/* ---------- batched effects (2026-11-13) ----------
   A late game spent ~760 draw calls a frame, mostly on effects: every
   fire was 3 flame sprites, smoke sprites and an ember cloud; every
   miss two meshes; every glow pool and fleet footprint a mesh - and
   the reflective sea draws the whole scene twice. Each kind is now ONE
   instanced draw: flames and smoke as camera-facing quads (billboards,
   like the sprites they replace), embers as one point cloud. The look
   and the motion are the same; reduced motion freezes it as before. */

type FireSpec = { key: string; x: number; y: number; z: number; scale: number; light: boolean };
type GlowSpec = { x: number; y: number; z: number; r: number; a: number };
type Spot = { x: number; z: number; hex?: string };

const _o = new Object3D();
const _c = new Color();
/* Additive blending adds colour x alpha, so each flame layer's old
   sprite opacity is folded into its colour. */
const FLAME_C = ["#ffd9a0", "#ff9a3c", "#ff5a1f"].map((c, i) => new Color(c).multiplyScalar(0.85 - i * 0.22));
const SMOKE_C = new Color("#23272c");
const SEA_C = new Color(SEA);
const EMBERS = 12;
const FLAT = new Quaternion().setFromEuler(new Euler(-Math.PI / 2, 0, 0));

function FireField({ fires }: { fires: FireSpec[] }) {
  const still = useContext(Still);
  // Stable across re-renders that do not change the fires (a hover
  // re-renders the scene; the embers must not restart).
  const sig = fires.map((f) => f.key + "@" + f.x.toFixed(2) + "," + f.z.toFixed(2)).join("|");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const list = useMemo(() => fires, [sig]);
  const n = list.length;
  const flames = useRef<InstancedMesh>(null);
  const smokes = useRef<InstancedMesh>(null);
  const embers = useRef<Points>(null);
  const lightRefs = useRef<(PointLight | null)[]>([]);
  const seeds = useMemo(() => list.map((f) => hash01(f.key) * 100), [list]);
  const ember = useMemo(() => {
    const rel = new Float32Array(Math.max(1, n) * EMBERS * 3);
    const abs = new Float32Array(rel.length);
    for (let i = 0; i < n; i++) {
      const f = list[i]!;
      for (let k = 0; k < EMBERS; k++) {
        const b = (i * EMBERS + k) * 3;
        rel[b] = (Math.random() - 0.5) * 0.3;
        rel[b + 1] = Math.random() * 1.1;
        rel[b + 2] = (Math.random() - 0.5) * 0.3;
        abs[b] = f.x + (rel[b] ?? 0);
        abs[b + 1] = f.y + (rel[b + 1] ?? 0);
        abs[b + 2] = f.z + (rel[b + 2] ?? 0);
      }
    }
    return { rel, abs };
  }, [n, list]);
  useLayoutEffect(() => {
    const fm = flames.current;
    if (fm) {
      for (let i = 0; i < n; i++) for (let j = 0; j < 3; j++) fm.setColorAt(i * 3 + j, FLAME_C[j]!);
      if (fm.instanceColor) fm.instanceColor.needsUpdate = true;
    }
    const sm = smokes.current;
    if (sm) {
      for (let i = 0; i < n * 2; i++) sm.setColorAt(i, SMOKE_C);
      if (sm.instanceColor) sm.instanceColor.needsUpdate = true;
    }
  }, [n, list]);
  const lit = list.map((f, i) => (f.light ? i : -1)).filter((i) => i >= 0);
  useFrame((state, delta) => {
    const fm = flames.current;
    const sm = smokes.current;
    const em = embers.current;
    if (!fm || !sm || !em) return;
    const q = state.camera.quaternion;
    const T = state.clock.elapsedTime;
    for (let i = 0; i < n; i++) {
      const f = list[i]!;
      const s = f.scale;
      const t = T + (seeds[i] ?? 0);
      for (let j = 0; j < 3; j++) {
        const fl = still ? 1 : 0.82 + 0.28 * Math.sin(t * 11 + j * 2.4) * Math.sin(t * 5.3 + j);
        const hy = still ? 1 : 0.9 + 0.25 * Math.sin(t * 9 + j * 1.7);
        _o.position.set(f.x, f.y + 0.34 * s - j * 0.04, f.z);
        _o.quaternion.copy(q);
        _o.scale.set(0.55 * s * fl * (1 - j * 0.16), (0.95 - j * 0.2) * s * hy, 1);
        _o.updateMatrix();
        fm.setMatrixAt(i * 3 + j, _o.matrix);
      }
      for (let j = 0; j < 2; j++) {
        const p = still ? 0.2 + j * 0.35 : (t * 0.16 + j / 2 + (seeds[i] ?? 0)) % 1;
        _o.position.set(f.x + Math.sin(p * 5 + j) * 0.14 + p * 0.5, f.y + 0.55 + p * 1.7 * s, f.z + Math.cos(p * 4 + j) * 0.1);
        _o.quaternion.copy(q);
        const sc = (0.5 + p * 1.5) * s;
        _o.scale.set(sc, sc, 1);
        _o.updateMatrix();
        sm.setMatrixAt(i * 2 + j, _o.matrix);
        // Smoke fades in fast and out slowly. Instances share one
        // opacity, so the fade runs through colour, toward the sea.
        _c.copy(SEA_C).lerp(SMOKE_C, (1 - p) * Math.min(1, p * 6));
        sm.setColorAt(i * 2 + j, _c);
      }
    }
    fm.instanceMatrix.needsUpdate = true;
    sm.instanceMatrix.needsUpdate = true;
    if (sm.instanceColor) sm.instanceColor.needsUpdate = true;
    em.visible = !still;
    if (!still) {
      // Rates were per frame at 60 fps; scale by the real step so the
      // embers rise at the same speed under the slower ambient ticker.
      const step = Math.min(3, delta * 60);
      const { rel, abs } = ember;
      for (let i = 0; i < n; i++) {
        const f = list[i]!;
        const t = T + (seeds[i] ?? 0);
        for (let k = 0; k < EMBERS; k++) {
          const b = (i * EMBERS + k) * 3;
          rel[b + 1] = (rel[b + 1] ?? 0) + (0.011 + (k % 3) * 0.004) * step;
          rel[b] = (rel[b] ?? 0) + Math.sin(t * 3 + k * 2.1) * 0.0016 * step;
          if ((rel[b + 1] ?? 0) > 1.25 * f.scale) {
            rel[b + 1] = 0.05;
            rel[b] = (Math.random() - 0.5) * 0.3;
            rel[b + 2] = (Math.random() - 0.5) * 0.3;
          }
          abs[b] = f.x + (rel[b] ?? 0);
          abs[b + 1] = f.y + (rel[b + 1] ?? 0);
          abs[b + 2] = f.z + (rel[b + 2] ?? 0);
        }
      }
      (em.geometry.attributes.position as BufferAttribute).needsUpdate = true;
    }
    lit.forEach((fi, li) => {
      const L = lightRefs.current[li];
      if (!L) return;
      const t = T + (seeds[fi] ?? 0);
      L.intensity = still ? 5.2 : 5.2 + Math.sin(t * 13.7) * 1.5 + Math.sin(t * 31.3) * 0.9;
    });
  });
  if (!n) return null;
  const tex = glowTexture();
  return (
    <group>
      <instancedMesh key={"f" + n} ref={flames} args={[undefined, undefined, n * 3]} frustumCulled={false}>
        <planeGeometry args={[1, 1]} />
        <meshBasicMaterial map={tex} blending={AdditiveBlending} depthWrite={false} transparent />
      </instancedMesh>
      <instancedMesh key={"s" + n} ref={smokes} args={[undefined, undefined, n * 2]} frustumCulled={false}>
        <planeGeometry args={[1, 1]} />
        <meshBasicMaterial map={tex} depthWrite={false} transparent opacity={0.42} />
      </instancedMesh>
      <points key={"e" + n} ref={embers} frustumCulled={false}>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[ember.abs, 3]} />
        </bufferGeometry>
        <pointsMaterial size={0.05} map={tex} color="#ffb066" blending={AdditiveBlending} depthWrite={false} transparent opacity={0.9} sizeAttenuation />
      </points>
      {lit.map((fi, li) => {
        const f = list[fi]!;
        return (
          <pointLight
            key={f.key}
            ref={(r) => {
              lightRefs.current[li] = r;
            }}
            position={[f.x, f.y + 0.7, f.z]}
            color="#ff8a3c"
            intensity={5}
            distance={4.5}
            decay={2}
          />
        );
      })}
    </group>
  );
}

/* Pools of firelight on the water under fires (additive: each pool's
   old opacity is folded into its colour). */
function GlowField({ glows }: { glows: GlowSpec[] }) {
  const ref = useRef<InstancedMesh>(null);
  const n = glows.length;
  const sig = glows.map((g) => g.x.toFixed(2) + "," + g.z.toFixed(2) + "," + g.r + "," + g.a).join("|");
  useLayoutEffect(() => {
    const m = ref.current;
    if (!m) return;
    glows.forEach((g, i) => {
      _o.position.set(g.x, g.y, g.z);
      _o.quaternion.copy(FLAT);
      _o.scale.set(g.r, g.r, 1);
      _o.updateMatrix();
      m.setMatrixAt(i, _o.matrix);
      m.setColorAt(i, _c.set("#ff7a26").multiplyScalar(g.a));
    });
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig]);
  if (!n) return null;
  return (
    <instancedMesh key={"g" + n} ref={ref} args={[undefined, undefined, n]} frustumCulled={false}>
      <circleGeometry args={[1, 24]} />
      <meshBasicMaterial map={glowTexture()} blending={AdditiveBlending} depthWrite={false} transparent />
    </instancedMesh>
  );
}

/* Flat instanced markers on the water: one draw for every cell. */
function FlatField({
  spots,
  y,
  geometry,
  color,
  opacity,
}: {
  spots: Spot[];
  y: number;
  geometry: "ring" | "dot" | "cell";
  color?: string;
  opacity: number;
}) {
  const ref = useRef<InstancedMesh>(null);
  const n = spots.length;
  const sig = spots.map((p) => p.x.toFixed(2) + "," + p.z.toFixed(2) + (p.hex || "")).join("|");
  useLayoutEffect(() => {
    const m = ref.current;
    if (!m) return;
    spots.forEach((p, i) => {
      _o.position.set(p.x, y, p.z);
      _o.quaternion.copy(FLAT);
      _o.scale.set(1, 1, 1);
      _o.updateMatrix();
      m.setMatrixAt(i, _o.matrix);
      if (p.hex) m.setColorAt(i, _c.set(p.hex));
    });
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig, y]);
  if (!n) return null;
  return (
    <instancedMesh key={geometry + n} ref={ref} args={[undefined, undefined, n]} frustumCulled={false}>
      {geometry === "ring" ? (
        <ringGeometry args={[0.15, 0.21, 24]} />
      ) : geometry === "dot" ? (
        <circleGeometry args={[0.05, 12]} />
      ) : (
        <planeGeometry args={[0.9, 0.9]} />
      )}
      <meshBasicMaterial color={color || "#ffffff"} transparent opacity={opacity} depthWrite={false} />
    </instancedMesh>
  );
}

/* ---------- ships: procedural hulls with class silhouettes ---------- */

function hullGeometry(len: number, beam: number): ExtrudeGeometry {
  const s = new Shape();
  const hl = len / 2, hb = beam / 2;
  s.moveTo(-hl, -hb);
  s.lineTo(hl - len * 0.24, -hb);
  s.lineTo(hl, 0);
  s.lineTo(hl - len * 0.24, hb);
  s.lineTo(-hl, hb);
  s.closePath();
  const geo = new ExtrudeGeometry(s, { depth: 0.3, bevelEnabled: true, bevelThickness: 0.05, bevelSize: 0.045, bevelSegments: 1 });
  geo.rotateX(Math.PI / 2);
  geo.translate(0, 0.36, 0);
  return geo;
}

/* Live steel is lighter than it first shipped (#4b5966): against the
   night water it measured about 1.2:1, and a captain could barely
   find their own fleet. The captain-colour footprint under live
   ships (Scene) carries the rest. */
const HULL_ALIVE = new Color("#7b8b99");
const HULL_CHAR = new Color("#131518");
const DECK_ALIVE = new Color("#5d6a76");
const DECK_CHAR = new Color("#101114");

function Turret({ x, flip }: { x: number; flip?: boolean }) {
  return (
    <group position={[x, 0.44, 0]} rotation={[0, flip ? Math.PI : 0, 0]}>
      <mesh>
        <cylinderGeometry args={[0.17, 0.19, 0.15, 10]} />
        <meshStandardMaterial color="#4c5a68" metalness={0.55} roughness={0.5} />
      </mesh>
      <mesh position={[0.24, 0.03, 0]}>
        <boxGeometry args={[0.46, 0.05, 0.06]} />
        <meshStandardMaterial color="#4c5a68" metalness={0.55} roughness={0.5} />
      </mesh>
    </group>
  );
}

/* One ship. wreckAt: performance.now() stamp from when the sinking
   first appeared in state, or undefined when the ship was already a
   wreck when the view opened (settled pose, no animation) / afloat. */
function ShipModel({
  size,
  variant,
  hex,
  sunk,
  wreckAt,
  center,
  vertical,
}: {
  size: number;
  variant: number;
  hex: string;
  sunk: boolean;
  wreckAt?: number;
  center: { x: number; z: number };
  vertical: boolean;
}) {
  const group = useRef<Group>(null);
  const hullMat = useRef<MeshStandardMaterial>(null);
  const deckMat = useRef<MeshStandardMaterial>(null);
  const accentMatObj = useMemo(
    () => new MeshStandardMaterial({ color: "#0b0e12", emissive: new Color(hex), emissiveIntensity: 2.3, toneMapped: false }),
    [hex]
  );
  const wreck = useRef(sunk && wreckAt === undefined ? 1 : 0);
  const listSign = useMemo(() => (hash01(center.x + ":" + center.z) > 0.5 ? 1 : -1), [center]);
  const listAmt = useMemo(() => 0.2 + hash01(center.z + ":" + center.x) * 0.1, [center]);
  const len = size * 0.94;
  const beam = size === 5 ? 0.88 : size === 2 ? 0.48 : 0.66;
  const hullGeo = useMemo(() => (size === 2 ? null : hullGeometry(len, beam)), [len, beam, size]);
  const still = useContext(Still);
  useFrame((state, dt) => {
    const grp = group.current;
    if (!grp) return;
    const t = state.clock.elapsedTime;
    const target = sunk ? 1 : 0;
    if (still) {
      wreck.current = target;
    } else if (wreckAt !== undefined && sunk) {
      /* wreckAt is a performance.now() wall stamp taken when the
         sinking first appeared in state: settle over ~2.4 s. */
      const p = Math.min(1, Math.max(0, (performance.now() - wreckAt) / 2400));
      wreck.current = p * p * (3 - 2 * p);
      if (p < 1) state.invalidate();
    } else {
      wreck.current += (target - wreck.current) * Math.min(1, dt * 2);
    }
    const wk = wreck.current;
    const bob = still ? 0 : 1 - wk;
    grp.position.set(center.x, waveH(center.x, center.z, t) * 0.8 * bob - wk * 0.17, center.z);
    grp.rotation.set(
      Math.sin(0.5 * center.z + 0.8 * t) * 0.014 * bob,
      vertical ? Math.PI / 2 : 0,
      listSign * listAmt * wk + Math.sin(0.45 * center.x + 0.6 * t) * 0.012 * bob
    );
    if (hullMat.current) {
      hullMat.current.color.copy(HULL_ALIVE).lerp(HULL_CHAR, wk);
      hullMat.current.roughness = 0.48 + wk * 0.47;
    }
    if (deckMat.current) deckMat.current.color.copy(DECK_ALIVE).lerp(DECK_CHAR, wk);
    accentMatObj.emissiveIntensity = 2.3 * (1 - wk) + 0.1;
  });
  const steel: GL = { metalness: 0.55, roughness: 0.5 };
  return (
    <group ref={group} position={[center.x, 0, center.z]}>
      {size === 2 ? (
        /* submarine, surfaced: low capsule hull + sail */
        <group>
          <mesh position={[0, 0.1, 0]} rotation={[0, 0, Math.PI / 2]}>
            <capsuleGeometry args={[0.21, len * 0.62, 4, 10]} />
            <meshStandardMaterial ref={hullMat} color="#4b5966" {...steel} />
          </mesh>
          <mesh position={[0.1, 0.32, 0]}>
            <boxGeometry args={[0.4, 0.26, 0.17]} />
            <meshStandardMaterial ref={deckMat} color="#2c343d" {...steel} />
          </mesh>
        </group>
      ) : (
        <group>
          <mesh geometry={hullGeo!}>
            <meshStandardMaterial ref={hullMat} color="#4b5966" {...steel} />
          </mesh>
          {/* lit rails in the captain's colour along both hull edges:
              rim light, not a plate - a full-width strip reads as a
              glowing surfboard under the ship */}
          {[-1, 1].map((s) => (
            <mesh key={s} position={[-len * 0.1, 0.3, s * (beam / 2 + 0.02)]} material={accentMatObj}>
              <boxGeometry args={[len * 0.64, 0.04, 0.045]} />
            </mesh>
          ))}
          {size === 5 ? (
            <group>
              <mesh position={[0, 0.42, 0]}>
                <boxGeometry args={[len * 0.97, 0.05, beam * 1.04]} />
                <meshStandardMaterial ref={deckMat} color="#2c343d" {...steel} />
              </mesh>
              <mesh position={[-len * 0.1, 0.62, -beam * 0.38]}>
                <boxGeometry args={[0.52, 0.36, 0.3]} />
                <meshStandardMaterial color="#4c5a68" {...steel} />
              </mesh>
              <mesh position={[-len * 0.1, 0.86, -beam * 0.38]}>
                <boxGeometry args={[0.08, 0.16, 0.08]} />
                <meshStandardMaterial color="#4c5a68" {...steel} />
              </mesh>
              <mesh position={[-len * 0.1, 0.68, -beam * 0.38]}>
                <boxGeometry args={[0.54, 0.05, 0.32]} />
                <meshStandardMaterial color="#0b0e12" emissive="#ffd9a0" emissiveIntensity={1.7} toneMapped={false} />
              </mesh>
            </group>
          ) : size === 4 ? (
            <group>
              <Turret x={len * 0.27} />
              <Turret x={-len * 0.27} flip />
              <mesh position={[0, 0.58, 0]}>
                <boxGeometry args={[0.55, 0.32, 0.42]} />
                <meshStandardMaterial ref={deckMat} color="#2c343d" {...steel} />
              </mesh>
              <mesh position={[-0.05, 0.86, 0]}>
                <boxGeometry args={[0.34, 0.26, 0.28]} />
                <meshStandardMaterial color="#4c5a68" {...steel} />
              </mesh>
              <mesh position={[0.02, 0.66, 0]}>
                <boxGeometry args={[0.57, 0.05, 0.44]} />
                <meshStandardMaterial color="#0b0e12" emissive="#ffd9a0" emissiveIntensity={1.7} toneMapped={false} />
              </mesh>
            </group>
          ) : variant === 0 ? (
            /* cruiser (the first 3) */
            <group>
              <Turret x={len * 0.26} />
              <mesh position={[-len * 0.12, 0.55, 0]}>
                <cylinderGeometry args={[0.11, 0.13, 0.34, 10]} />
                <meshStandardMaterial ref={deckMat} color="#2c343d" {...steel} />
              </mesh>
              <mesh position={[len * 0.02, 0.6, 0]}>
                <boxGeometry args={[0.3, 0.24, 0.3]} />
                <meshStandardMaterial color="#4c5a68" {...steel} />
              </mesh>
            </group>
          ) : (
            /* destroyer (the second 3) + any other size */
            <group>
              <Turret x={len * 0.24} />
              <mesh position={[-len * 0.05, 0.52, 0]}>
                <cylinderGeometry args={[0.09, 0.11, 0.28, 10]} />
                <meshStandardMaterial ref={deckMat} color="#2c343d" {...steel} />
              </mesh>
              <mesh position={[-len * 0.28, 0.5, 0]}>
                <cylinderGeometry args={[0.08, 0.1, 0.24, 10]} />
                <meshStandardMaterial color="#4c5a68" {...steel} />
              </mesh>
            </group>
          )}
        </group>
      )}
    </group>
  );
}

/* ---------- shot effects: the bomb drops, then the burst ---------- */

type Anim = { id: string; x: number; z: number; result: string; sunk: number | null };

function ShotFx({ anim, world, onDone }: { anim: Anim; world: GL; onDone: () => void }) {
  const bomb = useRef<Group>(null);
  const burst = useRef<Group>(null);
  const parts = useRef<(GL | null)[]>([]);
  const ring = useRef<Mesh>(null);
  const flash = useRef<GL>(null);
  const done = useRef(false);
  const start = useRef<number | null>(null);
  const vels = useMemo(() => {
    const hit = anim.result === "hit";
    const n = hit ? 16 : 14;
    return Array.from({ length: n }, (_, i) => {
      const a = (i / n) * Math.PI * 2 + hash01(anim.id + i) * 0.8;
      const r = hit ? 0.5 + hash01(anim.id + "r" + i) * 1.5 : 0.25 + hash01(anim.id + "r" + i) * 0.7;
      return {
        vx: Math.cos(a) * r,
        vz: Math.sin(a) * r,
        vy: hit ? 2 + hash01(anim.id + "u" + i) * 2.6 : 2.6 + hash01(anim.id + "u" + i) * 2.2,
        spin: hash01(anim.id + "s" + i) * 6 - 3,
      };
    });
  }, [anim]);
  const FALL = 0.85;
  const BURST = anim.result === "hit" ? 1.7 : 1.25;
  useFrame((state, dt) => {
    if (!done.current) state.invalidate();
    const t = state.clock.elapsedTime;
    if (start.current === null) start.current = t;
    const el = t - start.current;
    const hit = anim.result === "hit";
    if (el < FALL) {
      const p = el / FALL;
      if (bomb.current) {
        bomb.current.visible = true;
        bomb.current.position.set(anim.x, 9.5 * (1 - p * p) + 0.2, anim.z);
        bomb.current.rotation.z = 0.5;
      }
      if (burst.current) burst.current.visible = false;
      return;
    }
    if (bomb.current) bomb.current.visible = false;
    const bp = Math.min(1, (el - FALL) / BURST);
    if (burst.current) {
      burst.current.visible = true;
      parts.current.forEach((m, i) => {
        if (!m) return;
        const v = vels[i];
        if (!v) return;
        const bt = bp * BURST;
        m.position.set(anim.x + v.vx * bt, Math.max(0.06, v.vy * bt - (hit ? 3.4 : 4.6) * bt * bt * 0.5), anim.z + v.vz * bt);
        m.rotation.x += v.spin * dt;
        m.rotation.z += v.spin * 0.7 * dt;
        const sc = hit ? 0.16 + bp * 0.1 : 0.13;
        m.scale.set(sc, sc, sc);
        (m.material as Material & { opacity: number }).opacity = (hit ? 0.95 : 0.8) * (1 - bp * bp);
      });
      if (ring.current) {
        const rs = 0.3 + bp * (hit ? 2 : 1.5);
        ring.current.scale.set(rs, rs, rs);
        (ring.current.material as Material & { opacity: number }).opacity = 0.75 * (1 - bp);
      }
      if (flash.current) {
        const fp = Math.min(1, bp * 3.2);
        const fs = 0.6 + fp * 2.4;
        flash.current.scale.set(fs, fs, 1);
        (flash.current.material as SpriteMaterial).opacity = hit ? (1 - fp) * 0.95 : 0;
        flash.current.position.set(anim.x, 0.7, anim.z);
      }
      if (world && world.current) {
        if (hit && bp < 0.22) {
          const k = (1 - bp / 0.22) * 0.055;
          world.current.position.set((hash01(anim.id + Math.floor(t * 40)) - 0.5) * 2 * k, 0, (hash01(anim.id + "z" + Math.floor(t * 40)) - 0.5) * 2 * k);
        } else world.current.position.set(0, 0, 0);
      }
    }
    if (bp >= 1 && !done.current) {
      done.current = true;
      if (world && world.current) world.current.position.set(0, 0, 0);
      onDone();
    }
  });
  const tex = glowTexture();
  const hit = anim.result === "hit";
  return (
    <group>
      <group ref={bomb}>
        <Trail width={1.5} length={2.4} color="#ffb066" attenuation={(w) => w * w}>
          <group>
            <mesh rotation={[0, 0, 0.5]}>
              <capsuleGeometry args={[0.085, 0.3, 3, 8]} />
              <meshStandardMaterial color="#1c2126" metalness={0.7} roughness={0.35} />
            </mesh>
            <mesh position={[0.14, -0.14, 0]}>
              <sphereGeometry args={[0.05, 8, 8]} />
              <meshBasicMaterial color="#ffc98a" toneMapped={false} />
            </mesh>
          </group>
        </Trail>
      </group>
      <group ref={burst} visible={false}>
        {vels.map((_, i) =>
          hit && i >= 10 ? (
            <mesh key={i} ref={(r) => (parts.current[i] = r)}>
              <boxGeometry args={[1, 1, 1]} />
              <meshBasicMaterial color="#2a2e33" transparent />
            </mesh>
          ) : (
            <sprite key={i} ref={(r) => (parts.current[i] = r)}>
              <spriteMaterial map={tex} color={hit ? (i % 3 === 0 ? "#ffd9a0" : "#ff7a26") : "#dff2ff"} blending={AdditiveBlending} depthWrite={false} transparent opacity={0.9} />
            </sprite>
          )
        )}
        <mesh ref={ring} position={[anim.x, 0.07, anim.z]} rotation={[-Math.PI / 2, 0, 0]}>
          <ringGeometry args={[0.42, 0.5, 40]} />
          <meshBasicMaterial map={tex} color={hit ? "#ff9a3c" : "#bfe3ff"} blending={AdditiveBlending} depthWrite={false} transparent opacity={0.7} />
        </mesh>
        <sprite ref={flash}>
          <spriteMaterial map={tex} color="#fff1cf" blending={AdditiveBlending} depthWrite={false} transparent opacity={0} />
        </sprite>
      </group>
    </group>
  );
}

/* ---------- markers ---------- */

/* The last shot's cell. White, like the 2D board's outline: an orange
   ring vanished into the fire glow whenever the shot was a hit. */
function LastShotRing({ x, z }: { x: number; z: number }) {
  const r = useRef<Mesh>(null);
  const still = useContext(Still);
  useFrame((state) => {
    if (!r.current) return;
    const s = still ? 0 : Math.sin(state.clock.elapsedTime * 3.2);
    const p = 1 + s * 0.08;
    r.current.scale.set(p, p, p);
    (r.current.material as Material & { opacity: number }).opacity = 0.85 + s * 0.12;
  });
  // Drawn over everything: a hit lands on a ship, and the hull used to
  // hide the ring at exactly the moment it mattered.
  return (
    <mesh ref={r} position={[x, 0.09, z]} rotation={[-Math.PI / 2, 0, 0]} renderOrder={8}>
      <ringGeometry args={[0.36, 0.47, 32]} />
      <meshBasicMaterial color="#ffffff" toneMapped={false} depthWrite={false} depthTest={false} transparent opacity={0.85} />
    </mesh>
  );
}

/* A shot in flight: shown on the tapped cell from the tap until the
   server's answer lands, so a slow round trip does not invite a
   second tap (in a salvo, a second shot). */
function PendingMark({ x, z }: { x: number; z: number }) {
  const r = useRef<Group>(null);
  const still = useContext(Still);
  useFrame((state) => {
    if (!r.current || still) return;
    r.current.rotation.y = state.clock.elapsedTime * 1.6;
  });
  return (
    <group ref={r} position={[x, 0.1, z]}>
      {[0, 1, 2, 3].map((i) => (
        <mesh key={i} rotation={[-Math.PI / 2, 0, (i * Math.PI) / 2]} position={[Math.cos((i * Math.PI) / 2) * 0.3, 0, -Math.sin((i * Math.PI) / 2) * 0.3]}>
          <planeGeometry args={[0.2, 0.06]} />
          <meshBasicMaterial color="#ffffff" toneMapped={false} depthWrite={false} transparent opacity={0.95} />
        </mesh>
      ))}
    </group>
  );
}

/* The endgame sonar ping (state: g.sonar = {for, axis, label}) names
   a row or column of the hunted captain's waters holding an un-hit
   cell of their last ship. In the scene it is a translucent cyan band
   across that row/column on the hunted tile, a bright sweep line
   travelling its length, and a floating label - presentation only,
   the same public information the 2D arena prints as a text line. */
function SonarBand({ tile, w, h, sonar }: { tile: TileT; w: number; h: number; sonar: GL }) {
  const bandMat = useRef<MeshStandardMaterial>(null);
  const sweep = useRef<Group>(null);
  const isRow = sonar.axis === "row";
  const idx = isRow ? parseInt(String(sonar.label).slice(4), 10) - 1 : String(sonar.label).charCodeAt(7) - 65;
  const span = isRow ? w : h;
  const still = useContext(Still);
  useFrame(({ clock }) => {
    const t = clock.elapsedTime;
    if (bandMat.current) bandMat.current.opacity = still ? 0.2 : 0.14 + 0.08 * (0.5 + 0.5 * Math.sin(t * 2.2));
    if (sweep.current) {
      sweep.current.visible = !still;
      const p = ((t % 2.8) / 2.8) * (span + 2) - (span / 2 + 1);
      if (isRow) sweep.current.position.x = tile.cx + p;
      else sweep.current.position.z = p;
    }
  });
  if (!(idx >= 0 && idx < span)) return null;
  const bandPos: [number, number, number] = isRow
    ? [tile.cx, 0.07, idx - (h - 1) / 2]
    : [tile.cx + idx - (w - 1) / 2, 0.07, 0];
  /* The label lies low at the band's end, outside the tile: floating
     above the band it projected onto the row behind it. A row's
     label sits in the gap between the two oceans (east of the left
     tile, west of the right one); a column's sits past the near
     edge's letters. */
  const tex = textTexture("SONAR · " + String(sonar.label).toUpperCase(), "#67e8f9", true);
  const sc = textScale(tex, 0.62);
  // The right tile's row numbers also sit in the gap (on its west
  // edge), so its label stops short of them.
  const labelPos: [number, number, number] = isRow
    ? [tile.cx < 0 ? tile.cx + w / 2 + 0.25 + sc[0] / 2 : tile.cx - w / 2 - 1.0 - sc[0] / 2, 0.22, bandPos[2]]
    : [bandPos[0], 0.22, h / 2 + 1.55];
  return (
    <group>
      <mesh position={bandPos}>
        <boxGeometry args={isRow ? [w, 0.02, 1] : [1, 0.02, h]} />
        <meshStandardMaterial ref={bandMat} color="#164e63" emissive="#22d3ee" emissiveIntensity={1.15} toneMapped={false} transparent opacity={0.18} depthWrite={false} />
      </mesh>
      <group position={bandPos} ref={sweep}>
        <mesh position={[0, 0.015, 0]}>
          <boxGeometry args={isRow ? [0.07, 0.03, 1] : [1, 0.03, 0.07]} />
          <meshBasicMaterial color="#a5f3fc" toneMapped={false} transparent opacity={0.9} depthWrite={false} />
        </mesh>
      </group>
      <sprite position={labelPos} scale={sc} renderOrder={10}>
        <spriteMaterial map={tex} depthWrite={false} depthTest={false} transparent opacity={0.95} />
      </sprite>
    </group>
  );
}

/* ---------- one ocean tile: grid hologram, labels, ships, fires ---------- */

type ShipT = { key: string; size: number; variant: number; sunk: boolean; cells: string[]; hits: string[] };
type TileT = {
  name: string;
  /* What the tile's heading says: "Your waters" for a captain's own
     ocean, "<name>'s waters - tap to fire" for the enemy's on their
     turn, "<name>'s waters" otherwise. */
  title: string;
  hex: string;
  cx: number;
  ships: ShipT[];
  water: { label: string; result: string }[];
  canFire: boolean;
};

/* Coordinate labels and titles draw over everything (no depth test):
   a ship near the edge used to hide its row's number. */
function Label({ text, color, position, height, wide }: { text: string; color: string; position: [number, number, number]; height: number; wide?: boolean }) {
  const tex = textTexture(text, color, wide);
  return (
    <sprite position={position} scale={wide ? textScale(tex, height) : [height, height, 1]} renderOrder={10}>
      <spriteMaterial map={tex} depthWrite={false} depthTest={false} transparent opacity={0.92} />
    </sprite>
  );
}

function GridHolo({ tile, w, h }: { tile: TileT; w: number; h: number }) {
  const lines = useMemo(() => {
    const pts: number[] = [];
    for (let i = 0; i <= w; i++) pts.push(tile.cx + i - w / 2, 0.06, -h / 2, tile.cx + i - w / 2, 0.06, h / 2);
    for (let j = 0; j <= h; j++) pts.push(tile.cx - w / 2, 0.06, j - h / 2, tile.cx + w / 2, 0.06, j - h / 2);
    return new Float32Array(pts);
  }, [tile.cx, w, h]);
  /* The enemy ocean's frame brightens (and, motion allowing, breathes)
     while it is your turn to fire there - the scene's turn cue. */
  const still = useContext(Still);
  const frameMat = useMemo(
    () => new MeshStandardMaterial({ color: "#0b0e12", emissive: new Color(tile.hex), emissiveIntensity: 1.5, toneMapped: false }),
    [tile.hex]
  );
  useFrame(({ clock }) => {
    frameMat.emissiveIntensity = tile.canFire ? (still ? 3.2 : 2.6 + 0.9 * Math.sin(clock.elapsedTime * 3)) : 1.5;
  });
  return (
    <group>
      <lineSegments>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[lines, 3]} />
        </bufferGeometry>
        <lineBasicMaterial color={GRID_C} transparent opacity={0.34} />
      </lineSegments>
      {/* border frame in the captain's colour */}
      {[
        { p: [tile.cx, 0.05, -h / 2] as const, s: [w + 0.12, 0.035, 0.06] as const },
        { p: [tile.cx, 0.05, h / 2] as const, s: [w + 0.12, 0.035, 0.06] as const },
        { p: [tile.cx - w / 2, 0.05, 0] as const, s: [0.06, 0.035, h + 0.12] as const },
        { p: [tile.cx + w / 2, 0.05, 0] as const, s: [0.06, 0.035, h + 0.12] as const },
      ].map((b, i) => (
        <mesh key={i} position={[b.p[0], b.p[1], b.p[2]]} material={frameMat}>
          <boxGeometry args={[b.s[0], b.s[1], b.s[2]]} />
        </mesh>
      ))}
      {/* Coordinates: letters along the near AND far edges (in
          perspective a near-edge letter alone sat under the wrong
          column of far rows), numbers along the west edge. */}
      {Array.from({ length: w }, (_, i) => (
        <group key={"L" + i}>
          <Label text={String.fromCharCode(65 + i)} color="#9fd8ef" position={[tile.cx + i - (w - 1) / 2, 0.12, h / 2 + 0.62]} height={0.52} />
          <Label text={String.fromCharCode(65 + i)} color="#9fd8ef" position={[tile.cx + i - (w - 1) / 2, 0.12, -h / 2 - 0.55]} height={0.46} />
        </group>
      ))}
      {Array.from({ length: h }, (_, j) => (
        <Label key={"N" + j} text={String(j + 1)} color="#9fd8ef" position={[tile.cx - w / 2 - 0.62, 0.12, j - (h - 1) / 2]} height={0.52} />
      ))}
      <Label text={tile.title} color={tile.hex} position={[tile.cx, 0.12, -h / 2 - 1.5]} height={0.9} wide />
    </group>
  );
}

/* ---------- derive the two tiles from the per-viewer state ---------- */

function buildTiles(g: GL, me: string): TileT[] {
  const w = g.w || 10;
  const cxOf = (i: number) => (i === 0 ? -(w / 2 + 2) : w / 2 + 2);
  const mkShips = (list: GL[], sunkOf: (s: GL) => boolean): ShipT[] => {
    const seenSize: Record<number, number> = {};
    return (list || []).map((s: GL) => {
      const v = seenSize[s.size] || 0;
      seenSize[s.size] = v + 1;
      return { key: s.cells.join("."), size: s.size, variant: v, sunk: sunkOf(s), cells: s.cells, hits: s.hits || [] };
    });
  };
  const you = g.you || { playing: false };
  if (you.playing) {
    const players = g.players || [];
    // The server matches names case-insensitively; so does the scene.
    const isMe = (p: GL) => String(p.name).toLowerCase() === String(me).toLowerCase();
    const meP = players.filter(isMe)[0] || players[0] || { name: me, hex: "#22d3ee" };
    const foeP = players.filter((p: GL) => p !== meP)[0] || players[1] || { name: "?", hex: "#fb923c" };
    const canFire = !!(g.status === "running" && g.phase === "play" && you.your_turn);
    const fleetCells = new Set<string>();
    (you.fleet || []).forEach((s: GL) => s.cells.forEach((c: string) => fleetCells.add(c)));
    const ownWater = Object.keys(you.incoming || {})
      .filter((c) => !fleetCells.has(c))
      .map((c) => ({ label: c, result: you.incoming[c] }));
    const sunkCells = new Set<string>();
    (you.sunk_ships || []).forEach((s: GL) => s.cells.forEach((c: string) => sunkCells.add(c)));
    const foeWater = Object.keys(you.shots || {})
      .filter((c) => !sunkCells.has(c))
      .map((c) => ({ label: c, result: you.shots[c] }));
    return [
      {
        name: meP.name,
        title: "Your waters",
        hex: meP.hex,
        cx: cxOf(0),
        ships: mkShips(you.fleet || [], (s) => !!s.sunk),
        water: ownWater,
        canFire: false,
      },
      {
        name: foeP.name,
        title: foeP.name + "'s waters" + (canFire ? " · tap to fire" : ""),
        hex: foeP.hex,
        cx: cxOf(1),
        ships: mkShips(you.sunk_ships || [], () => true),
        water: foeWater,
        canFire,
      },
    ];
  }
  return (g.boards || []).map((b: GL, i: number) => {
    const sunkCells = new Set<string>();
    (b.sunk_ships || []).forEach((s: GL) => s.cells.forEach((c: string) => sunkCells.add(c)));
    const water = Object.keys(b.incoming || {})
      .filter((c) => !sunkCells.has(c))
      .map((c) => ({ label: c, result: b.incoming[c] }));
    return {
      name: b.name,
      title: b.name + "'s waters",
      hex: b.hex,
      cx: cxOf(i),
      ships: mkShips(b.sunk_ships || [], () => true),
      water,
      canFire: false,
    };
  });
}

/* Drifting patches of moonlight on the water - cheap ocean life. */
function LightPatch({ seed }: { seed: number }) {
  const m = useRef<Mesh>(null);
  const still = useContext(Still);
  useFrame((s) => {
    if (!m.current) return;
    const t = still ? 0 : s.clock.elapsedTime;
    m.current.position.x = Math.sin(t * 0.03 + seed) * 15;
    m.current.position.z = Math.cos(t * 0.021 + seed * 2.3) * 5;
  });
  return (
    <mesh ref={m} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.02, 0]}>
      <planeGeometry args={[30, 15]} />
      <meshBasicMaterial map={glowTexture()} color="#2e5a7d" blending={AdditiveBlending} depthWrite={false} transparent opacity={0.1} />
    </mesh>
  );
}

/* ---------- the scene ---------- */

function Scene({
  g,
  tiles,
  foeName,
  onFire,
  onAim,
  aimMode,
  cd,
  aim,
  pending,
  ctl,
  home,
  homeRef,
  onReady,
  q,
}: {
  g: GL;
  tiles: TileT[];
  foeName: string | null;
  onFire?: (label: string) => void;
  onAim?: (label: string) => void;
  aimMode: boolean;
  cd: number;
  aim: string | null;
  pending: string | null;
  ctl: RefObject<Ctl | null>;
  home: (aspect: number, width: number) => Home;
  homeRef: { current: Home | null };
  onReady?: () => void;
  q: Quality;
}) {
  const still = useContext(Still);
  const w = g.w || 10;
  const h = g.h || 10;
  const sonar = g && g.sonar && g.phase === "play" && g.status === "running" ? g.sonar : null;
  const world = useRef<Group>(null);
  const [hover, setHover] = useState<string | null>(null);
  const downAt = useRef<{ x: number; y: number } | null>(null);

  /* Wrecks that appear while the view is open settle and burn in;
     wrecks already there at mount are settled. Keyed by ocean name,
     not position: on a phone the shown ocean swaps, and a wreck must
     not replay its sinking when its ocean comes back into view. */
  const wreckKeys = tiles.flatMap((t) => t.ships.filter((s) => s.sunk).map((s) => t.name + ":" + s.key));
  const seenWrecks = useRef<Set<string>>(new Set(wreckKeys));
  const [freshWrecks, setFreshWrecks] = useState<Record<string, number>>({});

  /* Shot animations replay off last_move diffs (never on mount, and
     never under reduced motion - the bomb drop and the camera shake
     are exactly what that setting asks to skip). */
  const lm = g.last_move as GL;
  const lmKey = lm ? lm.turn + ":" + lm.by + ":" + lm.cell : "";
  const seenLm = useRef<string | null>(null);
  const [anim, setAnim] = useState<Anim | null>(null);

  useEffect(() => {
    const fresh: Record<string, number> = {};
    let any = false;
    wreckKeys.forEach((k) => {
      if (!seenWrecks.current.has(k)) {
        seenWrecks.current.add(k);
        fresh[k] = performance.now();
        any = true;
      }
    });
    if (any) setFreshWrecks((f) => ({ ...f, ...fresh }));
    if (seenLm.current === null) {
      seenLm.current = lmKey;
      return;
    }
    if (lmKey && lmKey !== seenLm.current) {
      seenLm.current = lmKey;
      const tt = tiles.filter((t) => t.name !== lm.by)[0];
      if (tt && !still) {
        const loc = cellLocal(lm.cell, w, h);
        setAnim({ id: lmKey, x: tt.cx + loc.x, z: loc.z, result: lm.result, sunk: lm.sunk });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [g, tiles]);

  const foeTile = tiles.filter((t) => t.canFire)[0];
  /* The ocean a captain aims at - the enemy's, on or off their turn
     (Enter or the Fire button only fires on their turn). */
  const aimTile = foeName ? tiles.filter((t) => t.name === foeName)[0] : undefined;
  const pickTile = aimMode ? aimTile : foeTile;
  const shotCells = useMemo(() => {
    const s = new Set<string>();
    if (pickTile) {
      pickTile.water.forEach((m) => s.add(m.label));
      pickTile.ships.forEach((sh) => sh.cells.forEach((c) => s.add(c)));
    }
    return s;
  }, [pickTile]);
  const cellFromPoint = (p: { x: number; z: number }): string | null => {
    if (!pickTile) return null;
    const col = Math.round(p.x - pickTile.cx + (w - 1) / 2);
    const row = Math.round(p.z + (h - 1) / 2);
    if (col < 0 || col >= w || row < 0 || row >= h) return null;
    const label = String.fromCharCode(65 + col) + (row + 1);
    return shotCells.has(label) ? null : label;
  };
  const evXY = (e: ThreeEvent<PointerEvent>): { x: number; y: number } => {
    const n = (e as GL).nativeEvent || e;
    return { x: n.clientX || 0, y: n.clientY || 0 };
  };

  const lmTile = lm ? tiles.filter((t) => t.name !== lm.by)[0] : undefined;
  const ringAt = !aimMode && foeTile && hover ? { tile: foeTile, label: hover } : aimTile && aim ? { tile: aimTile, label: aim } : null;
  const ringHot = !!(ringAt && ringAt.tile.canFire);

  return (
    <>
      <FirstFrame onReady={onReady} />
      <Ticker fps={q.ambientFps} />
      <fog attach="fog" args={[SEA, cd * 1.9, cd * 4.2]} />
      <color attach="background" args={[SEA]} />
      <hemisphereLight args={["#8fb8d8", "#0a0f14", 0.85]} />
      <directionalLight position={[14, 20, 8]} intensity={1.45} color="#cfe6ff" />
      <directionalLight position={[-12, 9, -10]} intensity={0.4} color="#7fa8cc" />
      <ambientLight intensity={0.3} />
      <CameraControls ref={ctl} makeDefault minDistance={6} maxDistance={80} maxPolarAngle={1.38} />
      <TouchControls ctl={ctl} />
      <Framer home={home} ctl={ctl} homeRef={homeRef} />
      <group ref={world}>
        {/* one sea under the tiles: reflective on desktop; plain on
            touch devices, where the reflection (a second render of the
            whole scene) costs most */}
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 0]}>
          <planeGeometry args={[130, 130]} />
          {q.lite ? (
            <meshStandardMaterial color="#070d16" roughness={0.6} metalness={0.5} />
          ) : (
            <MeshReflectorMaterial
              blur={[280, 60]}
              resolution={512}
              mixBlur={0.9}
              mixStrength={9}
              roughness={0.6}
              depthScale={1.1}
              minDepthThreshold={0.4}
              maxDepthThreshold={1.4}
              color="#070d16"
              metalness={0.6}
              mirror={0.7}
            />
          )}
        </mesh>
        <LightPatch seed={1.7} />
        <LightPatch seed={4.9} />
        {(() => {
          /* Effects are gathered across the shown oceans and drawn
             batched (FireField, GlowField, FlatField): one draw per
             kind instead of one per fire, pool, marker or cell. */
          const fires: FireSpec[] = [];
          const glows: GlowSpec[] = [];
          const misses: Spot[] = [];
          const feet: Spot[] = [];
          let lights = 0;
          const groups = tiles.map((tile) => {
            const shipEls: GL[] = [];
            tile.ships.forEach((s) => {
              const c0 = s.cells[0] ?? "A1";
              const cN = s.cells[s.cells.length - 1] ?? c0;
              const first = cellLocal(c0, w, h);
              const last = cellLocal(cN, w, h);
              const center = { x: tile.cx + (first.x + last.x) / 2, z: (first.z + last.z) / 2 };
              const vertical = c0[0] === cN[0] && s.cells.length > 1;
              shipEls.push(
                <ShipModel
                  key={s.key}
                  size={s.size}
                  variant={s.variant}
                  hex={tile.hex}
                  sunk={s.sunk}
                  wreckAt={freshWrecks[tile.name + ":" + s.key]}
                  center={center}
                  vertical={vertical}
                />
              );
              if (!s.sunk) {
                /* A live ship is always the viewer's own (the server
                   never sends an un-sunk enemy hull): a faint footprint
                   in the captain's colour under each of its cells keeps
                   the fleet findable, as the 2D board's tinted cells do. */
                s.cells.forEach((c) => {
                  const loc = cellLocal(c, w, h);
                  feet.push({ x: tile.cx + loc.x, z: loc.z, hex: tile.hex });
                });
                s.hits.forEach((c) => {
                  const loc = cellLocal(c, w, h);
                  fires.push({ key: tile.name + ":h:" + c, x: tile.cx + loc.x, y: 0.5, z: loc.z, scale: 0.8, light: false });
                });
              } else {
                glows.push({ x: center.x, y: 0.03, z: center.z, r: s.size * 0.42, a: 0.2 });
                const idxs = s.size >= 4 ? [0, Math.floor(s.cells.length / 2), s.cells.length - 1] : [0, s.cells.length - 1];
                idxs.forEach((ci, fi) => {
                  const cell = s.cells[ci];
                  if (!cell) return;
                  const loc = cellLocal(cell, w, h);
                  const light = lights < 3 && fi === 0;
                  if (fi === 0) lights++;
                  fires.push({ key: tile.name + ":w:" + s.key + ":" + ci, x: tile.cx + loc.x, y: 0.42, z: loc.z, scale: 1.05, light });
                });
              }
            });
            tile.water.forEach((m) => {
              const loc = cellLocal(m.label, w, h);
              const x = tile.cx + loc.x;
              if (m.result === "hit") {
                fires.push({ key: tile.name + ":x:" + m.label, x, y: 0.14, z: loc.z, scale: 0.85, light: false });
                glows.push({ x, y: 0.035, z: loc.z, r: 0.6, a: 0.33 });
              } else misses.push({ x, z: loc.z });
            });
            return (
              <group key={tile.name}>
                <GridHolo tile={tile} w={w} h={h} />
                {sonar && tile.name !== sonar.for ? <SonarBand tile={tile} w={w} h={h} sonar={sonar} /> : null}
                {shipEls}
                {lm && lmTile === tile ? (
                  <LastShotRing x={tile.cx + cellLocal(lm.cell, w, h).x} z={cellLocal(lm.cell, w, h).z} />
                ) : null}
              </group>
            );
          });
          return (
            <>
              <FlatField spots={feet} y={0.045} geometry="cell" opacity={0.24} />
              {groups}
              <GlowField glows={glows} />
              <FlatField spots={misses} y={0.05} geometry="ring" color="#a9c6de" opacity={0.55} />
              <FlatField spots={misses} y={0.052} geometry="dot" color="#a9c6de" opacity={0.5} />
              <FireField fires={fires} />
            </>
          );
        })()}
        {/* the pick surface over the enemy tile: a click fires on
            desktop; on touch a tap aims and the Fire button fires */}
        {pickTile ? (
          <mesh
            position={[pickTile.cx, 0.08, 0]}
            rotation={[-Math.PI / 2, 0, 0]}
            onPointerMove={(e) => {
              if (aimMode) return;
              const label = cellFromPoint(e.point);
              if (label !== hover) setHover(label);
            }}
            onPointerDown={(e) => {
              downAt.current = evXY(e);
            }}
            onPointerUp={(e) => {
              const d = downAt.current;
              downAt.current = null;
              if (!d) return;
              const p = evXY(e);
              if (Math.hypot(p.x - d.x, p.y - d.y) > 8) return;
              const label = cellFromPoint(e.point);
              if (!label) return;
              if (aimMode) {
                if (onAim) onAim(label);
              } else if (onFire) onFire(label);
            }}
            onPointerLeave={() => setHover(null)}
          >
            <planeGeometry args={[w, h]} />
            <meshBasicMaterial transparent opacity={0} depthWrite={false} />
          </mesh>
        ) : null}
        {ringAt
          ? (() => {
              const loc = cellLocal(ringAt.label, w, h);
              const c = ringHot ? "#ff5a3c" : "#9fd8ef";
              return (
                <group position={[ringAt.tile.cx + loc.x, 0.07, loc.z]}>
                  <mesh rotation={[-Math.PI / 2, 0, 0]} renderOrder={6}>
                    <ringGeometry args={[0.36, 0.46, 32]} />
                    <meshBasicMaterial color={c} toneMapped={false} depthWrite={false} depthTest={false} transparent opacity={0.95} />
                  </mesh>
                  <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.01, 0]}>
                    <planeGeometry args={[0.92, 0.92]} />
                    <meshBasicMaterial color={c} transparent opacity={0.18} depthWrite={false} />
                  </mesh>
                </group>
              );
            })()
          : null}
        {pending && aimTile
          ? (() => {
              const loc = cellLocal(pending, w, h);
              return <PendingMark x={aimTile.cx + loc.x} z={loc.z} />;
            })()
          : null}
        {anim && !still ? <ShotFx anim={anim} world={world} onDone={() => setAnim(null)} /> : null}
      </group>
      <Sparkles count={50} scale={[30, 4, 14]} position={[0, 2.4, 0]} size={1.5} speed={still ? 0 : 0.22} opacity={0.45} color="#7dd3fc" />
      <EffectComposer multisampling={q.msaa}>
        <>
          <Bloom mipmapBlur intensity={1.15} luminanceThreshold={0.72} luminanceSmoothing={0.3} />
          <Vignette offset={0.2} darkness={0.55} />
        </>
      </EffectComposer>
    </>
  );
}

/* Frame by host aspect, not by a portrait/landscape guess: the
   two-tile span fits the horizontal fov when the camera distance
   scales as 1/aspect. About 10% further back than first shipped
   (1.48 vs 1.34 per unit span): perspective makes the near edge the
   widest, and the near rows' outer columns were cropped.
   A phone-width host shows ONE ocean (see BsArena3D), framed from a
   steeper angle and fitted to the tile with its labels, so cells are
   big enough to tap (about 30 px on a 390 px phone, against 8-12 px
   for two oceans side by side). */
function bsHome(w: number, h: number, aspect: number, single: boolean): Home {
  if (single) {
    // Looking a little past the centre toward the near edge lifts the
    // ocean on screen, clearing the bottom strip where the Fire button
    // and the tap tip sit, so they do not cover the column letters.
    const f = fitHome(w + 1.4, h + 3.6, 62, 48, aspect, 1.03);
    const tz = 1.1;
    return { pos: [f.pos[0], f.pos[1], f.pos[2] + tz], fov: f.fov, tz };
  }
  const span = 2 * w + 4;
  const cd = Math.min(44, Math.max(21, (span * 1.48) / Math.max(0.7, aspect)));
  return { pos: [0, cd * 0.76, cd * 0.65], fov: aspect < 1.3 ? 56 : 46 };
}
const SINGLE_BELOW = 560; // host width in CSS px

export default function BsArena3D({
  g,
  me,
  aspect,
  onFire,
  onReady,
}: {
  g: GL;
  me: string;
  aspect?: number;
  onFire?: (label: string) => void;
  onReady?: () => void;
}) {
  const still = useReducedMotion();
  const q = useQuality(still);
  const aimMode = q.lite;
  const w = g.w || 10;
  const h = g.h || 10;
  const tiles = useMemo(() => buildTiles(g, me), [g, me]);
  const player = !!(g.you && g.you.playing);
  const foe = player ? tiles[1] : undefined;
  const canFire = !!(foe && foe.canFire);
  /* Cells already fired at on the enemy ocean, and what they are. */
  const taken = useMemo(() => {
    const m = new Map<string, string>();
    if (foe) {
      foe.water.forEach((x) => m.set(x.label, x.result === "hit" ? "a hit" : "a miss"));
      foe.ships.forEach((s) => s.cells.forEach((c) => m.set(c, "a sunk ship")));
    }
    return m;
  }, [foe]);
  const [aim, setAim] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [say, setSay] = useState("");
  const ctl = useRef<Ctl | null>(null);
  const homeRef = useRef<Home | null>(null);

  /* The host's live size: a phone-width host shows one ocean. */
  const [hostW, setHostW] = useState(() => (aspect && aspect < 1.2 ? 390 : 700));
  const single = hostW < SINGLE_BELOW;
  /* Which ocean a single view shows: the enemy's on your turn, yours
     while you wait; a spectator sees the ocean the last shot landed
     in. A tap on the switch overrides that until the turn changes. */
  const lm = g.last_move as GL;
  const lastShotIdx = lm ? Math.max(0, tiles.findIndex((t) => t.name !== lm.by)) : 0;
  const autoIdx = player ? (canFire ? 1 : 0) : lastShotIdx;
  const [manualIdx, setManualIdx] = useState<number | null>(null);
  useEffect(() => {
    setManualIdx(null);
  }, [canFire]);
  const shownIdx = Math.min(tiles.length - 1, manualIdx ?? autoIdx);
  const shown = useMemo(() => {
    if (!single) return tiles;
    const t = tiles[shownIdx];
    // Nudged right so the ocean plus its row-number column (west of
    // it) sits centred under the camera.
    return t ? [{ ...t, cx: 0.45 }] : [];
  }, [tiles, single, shownIdx]);

  const home = (a: number, width: number) => bsHome(w, h, a, width < SINGLE_BELOW);
  const first = home(aspect ?? 1.44, hostW);
  const cd = Math.hypot(first.pos[1], first.pos[2]);

  /* The in-flight marker clears when the shot lands in state, when
     the turn moves on, or after 10 s (a refused shot changes nothing
     in state; its error shows in the arena's note). */
  useEffect(() => {
    if (pending && (taken.has(pending) || !canFire)) setPending(null);
  }, [taken, canFire, pending]);
  useEffect(() => {
    if (!pending) return;
    const t = setTimeout(() => setPending(null), 10000);
    return () => clearTimeout(t);
  }, [pending]);

  /* Spoken updates for screen readers: each new shot, and the start
     of your turn. Nothing is announced for the state at open. */
  const lmKey = lm ? lm.turn + ":" + lm.by + ":" + lm.cell : "";
  const seen = useRef<{ lm: string; turn: boolean } | null>(null);
  useEffect(() => {
    if (!seen.current) {
      seen.current = { lm: lmKey, turn: canFire };
      return;
    }
    const parts: string[] = [];
    if (lm && lmKey && lmKey !== seen.current.lm)
      parts.push(lm.by + " fired at " + lm.cell + ": " + (lm.result === "hit" ? (lm.sunk ? "hit, and a " + lm.sunk + "-ship sank" : "hit") : "miss") + ".");
    if (canFire && !seen.current.turn) parts.push("Your shot.");
    seen.current = { lm: lmKey, turn: canFire };
    if (parts.length) setSay(parts.join(" "));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lmKey, canFire]);

  const describe = (label: string) =>
    label + ", " + (taken.has(label) ? "already " + taken.get(label) : "open water") + (canFire ? "" : ", not your turn") + ".";
  const fire = (label: string) => {
    if (!canFire || !onFire) {
      setSay("Not your turn yet.");
      return;
    }
    if (taken.has(label)) {
      setSay(label + " is already " + taken.get(label) + ".");
      return;
    }
    setPending(label);
    if (aimMode) setAim(null);
    setSay("Firing at " + label + ".");
    onFire(label);
  };
  const aimAt = (label: string) => {
    setAim(label);
    setSay(describe(label));
  };
  /* Keyboard play: arrow keys move an aim marker over the enemy
     ocean (row 1 is the far edge, as on screen), Enter or Space
     fires at it. In a single-ocean view the enemy ocean comes up. */
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!foe) return;
    const k = e.key;
    const cur = aim ? labelXY(aim) : { col: Math.floor((w - 1) / 2), row: Math.floor((h - 1) / 2) };
    let col = cur.col;
    let row = cur.row;
    if (k === "ArrowLeft") col--;
    else if (k === "ArrowRight") col++;
    else if (k === "ArrowUp") row--;
    else if (k === "ArrowDown") row++;
    else if (k === "Enter" || k === " ") {
      e.preventDefault();
      if (single) setManualIdx(1);
      const label = String.fromCharCode(65 + col) + (row + 1);
      if (aim) fire(label);
      else aimAt(label);
      return;
    } else return;
    e.preventDefault();
    if (single) setManualIdx(1);
    col = Math.max(0, Math.min(w - 1, col));
    row = Math.max(0, Math.min(h - 1, row));
    aimAt(String.fromCharCode(65 + col) + (row + 1));
  };

  const spectatorLabel = "Battleship, 3D view of " + tiles.map((t) => t.name + "'s").join(" and ") + " waters.";
  const overlay = (
    <>
      {single && tiles.length > 1 ? (
        <div className="arena3d-swap" role="group" aria-label="Which ocean to show">
          {tiles.map((t, i) => (
            <button
              key={t.name}
              type="button"
              aria-pressed={i === shownIdx}
              className={i === shownIdx ? "on" : ""}
              onClick={() => setManualIdx(i)}
            >
              <span className="arena3d-swap-dot" style={{ background: t.hex }} />
              {player ? (i === 0 ? "Yours" : t.name + "'s") : t.name + "'s"}
              {player && i === 1 && canFire ? " · fire" : ""}
            </button>
          ))}
        </div>
      ) : null}
      {aimMode && canFire && aim && !taken.has(aim) && (!single || shownIdx === 1) ? (
        <button type="button" className="arena3d-fire" onClick={() => fire(aim)}>
          Fire at {aim}
        </button>
      ) : null}
      {aimMode && canFire && !aim && !pending && (!single || shownIdx === 1) ? (
        <div className="arena3d-tip">Tap a cell to aim</div>
      ) : null}
      {foe ? (
        <div className="sr-only" aria-live="polite">
          {say}
        </div>
      ) : null}
    </>
  );
  return (
    <ArenaFrame
      onReset={() => goHome(ctl, homeRef.current || first, !still)}
      onSize={(width) => setHostW(width)}
      overlay={overlay}
      frameProps={
        foe
          ? {
              tabIndex: 0,
              role: "application",
              "aria-label": "Battleship, 3D view. " + foe.name + "'s waters: arrow keys aim, Enter fires.",
              onKeyDown: onKey,
              onBlur: (e) => {
                // Leaving for the frame's own buttons (Fire, the ocean
                // switch) keeps the aim; leaving the arena drops it.
                if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setAim(null);
              },
            }
          : undefined
      }
    >
      <Canvas
        role={foe ? undefined : "img"}
        aria-label={foe ? undefined : spectatorLabel}
        frameloop="demand"
        dpr={q.dpr}
        camera={{ position: first.pos, fov: first.fov, near: 0.1, far: 600 }}
        gl={{ antialias: !q.lite }}
      >
        <Still.Provider value={still}>
          <Scene
            g={g}
            tiles={shown}
            foeName={foe ? foe.name : null}
            onFire={foe ? fire : undefined}
            onAim={foe ? aimAt : undefined}
            aimMode={aimMode}
            cd={cd}
            aim={aim}
            pending={pending}
            ctl={ctl}
            home={home}
            homeRef={homeRef}
            onReady={onReady}
            q={q}
          />
        </Still.Provider>
      </Canvas>
    </ArenaFrame>
  );
}
