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
import { useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame, type ThreeEvent } from "@react-three/fiber";
import { CameraControls, MeshReflectorMaterial, Sparkles, Trail } from "@react-three/drei";
import { Bloom, EffectComposer, Vignette } from "@react-three/postprocessing";
import {
  AdditiveBlending,
  CanvasTexture,
  Color,
  ExtrudeGeometry,
  MeshStandardMaterial,
  Shape,
  type Group,
  type Material,
  type Mesh,
  type Points,
  type SpriteMaterial,
} from "three";

type GL = any;

const SEA = "#04070d";
const GRID_C = "#22d3ee";

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
  c.width = wide ? 512 : 96;
  c.height = 96;
  const ctx = c.getContext("2d")!;
  ctx.font = "700 52px system-ui, sans-serif";
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

/* ---------- fire: flames + smoke + embers, one animated bundle ---------- */

function FireFx({
  position,
  scale = 1,
  light = false,
}: {
  position: [number, number, number];
  scale?: number;
  light?: boolean;
}) {
  const g = useRef<Group>(null);
  const flames = useRef<(GL | null)[]>([]);
  const smokes = useRef<(GL | null)[]>([]);
  const embers = useRef<Points>(null);
  const lightRef = useRef<GL>(null);
  const seed = useMemo(() => Math.random() * 100, []);
  const emberGeo = useMemo(() => {
    const n = 12;
    const pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      pos[i * 3] = (Math.random() - 0.5) * 0.3;
      pos[i * 3 + 1] = Math.random() * 1.1;
      pos[i * 3 + 2] = (Math.random() - 0.5) * 0.3;
    }
    return { pos, n };
  }, []);
  useFrame((state) => {
    const t = state.clock.elapsedTime + seed;
    flames.current.forEach((s, i) => {
      if (!s) return;
      const f = 0.82 + 0.28 * Math.sin(t * 11 + i * 2.4) * Math.sin(t * 5.3 + i);
      s.scale.set(0.55 * scale * f * (1 - i * 0.16), (0.95 - i * 0.2) * scale * (0.9 + 0.25 * Math.sin(t * 9 + i * 1.7)), 1);
      (s.material as SpriteMaterial).opacity = 0.85 - i * 0.22;
    });
    smokes.current.forEach((s, i) => {
      if (!s) return;
      const p = (t * 0.16 + i / smokes.current.length + seed) % 1;
      s.position.set(Math.sin(p * 5 + i) * 0.14 + p * 0.5, 0.55 + p * 1.7 * scale, Math.cos(p * 4 + i) * 0.1);
      const sc = (0.5 + p * 1.5) * scale;
      s.scale.set(sc, sc, 1);
      (s.material as SpriteMaterial).opacity = 0.42 * (1 - p) * Math.min(1, p * 6);
    });
    if (embers.current) {
      const arr = (embers.current.geometry.attributes.position as GL).array as Float32Array;
      for (let i = 0; i < emberGeo.n; i++) {
        const ix = i * 3, iy = i * 3 + 1, iz = i * 3 + 2;
        arr[iy] = (arr[iy] ?? 0) + 0.011 + (i % 3) * 0.004;
        arr[ix] = (arr[ix] ?? 0) + Math.sin(t * 3 + i * 2.1) * 0.0016;
        if ((arr[iy] ?? 0) > 1.25 * scale) {
          arr[iy] = 0.05;
          arr[ix] = (Math.random() - 0.5) * 0.3;
          arr[iz] = (Math.random() - 0.5) * 0.3;
        }
      }
      (embers.current.geometry.attributes.position as GL).needsUpdate = true;
    }
    if (lightRef.current) lightRef.current.intensity = 5.2 + Math.sin(t * 13.7) * 1.5 + Math.sin(t * 31.3) * 0.9;
  });
  const tex = glowTexture();
  return (
    <group ref={g} position={position}>
      {[0, 1, 2].map((i) => (
        <sprite key={"f" + i} ref={(r) => (flames.current[i] = r)} position={[0, 0.34 * scale - i * 0.04, 0]}>
          <spriteMaterial map={tex} color={i === 0 ? "#ffd9a0" : i === 1 ? "#ff9a3c" : "#ff5a1f"} blending={AdditiveBlending} depthWrite={false} transparent opacity={0.8} />
        </sprite>
      ))}
      {[0, 1, 2, 3].map((i) => (
        <sprite key={"s" + i} ref={(r) => (smokes.current[i] = r)}>
          <spriteMaterial map={tex} color="#23272c" depthWrite={false} transparent opacity={0.3} />
        </sprite>
      ))}
      <points ref={embers}>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[emberGeo.pos, 3]} />
        </bufferGeometry>
        <pointsMaterial size={0.05} map={tex} color="#ffb066" blending={AdditiveBlending} depthWrite={false} transparent opacity={0.9} sizeAttenuation />
      </points>
      {light ? <pointLight ref={lightRef} position={[0, 0.7, 0]} color="#ff8a3c" intensity={5} distance={4.5} decay={2} /> : null}
    </group>
  );
}

/* A soft pool of firelight on the water under a fire. */
function GlowDisc({ position, radius = 0.62, opacity = 0.33 }: { position: [number, number, number]; radius?: number; opacity?: number }) {
  return (
    <mesh position={position} rotation={[-Math.PI / 2, 0, 0]}>
      <circleGeometry args={[radius, 24]} />
      <meshBasicMaterial map={glowTexture()} color="#ff7a26" blending={AdditiveBlending} depthWrite={false} transparent opacity={opacity} />
    </mesh>
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

const HULL_ALIVE = new Color("#4b5966");
const HULL_CHAR = new Color("#131518");
const DECK_ALIVE = new Color("#3a4550");
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
  useFrame((state, dt) => {
    const grp = group.current;
    if (!grp) return;
    const t = state.clock.elapsedTime;
    const target = sunk ? 1 : 0;
    if (wreckAt !== undefined && sunk) {
      /* wreckAt is a performance.now() wall stamp taken when the
         sinking first appeared in state: settle over ~2.4 s. */
      const p = Math.min(1, Math.max(0, (performance.now() - wreckAt) / 2400));
      wreck.current = p * p * (3 - 2 * p);
    } else {
      wreck.current += (target - wreck.current) * Math.min(1, dt * 2);
    }
    const wk = wreck.current;
    const bob = 1 - wk;
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

function MissMarker({ x, z }: { x: number; z: number }) {
  return (
    <group position={[x, 0.05, z]}>
      <mesh rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[0.15, 0.21, 24]} />
        <meshBasicMaterial color="#a9c6de" transparent opacity={0.55} depthWrite={false} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.002, 0]}>
        <circleGeometry args={[0.05, 12]} />
        <meshBasicMaterial color="#a9c6de" transparent opacity={0.5} depthWrite={false} />
      </mesh>
    </group>
  );
}

function LastShotRing({ x, z }: { x: number; z: number }) {
  const r = useRef<Mesh>(null);
  useFrame((state) => {
    if (!r.current) return;
    const p = 1 + Math.sin(state.clock.elapsedTime * 3.2) * 0.1;
    r.current.scale.set(p, p, p);
    (r.current.material as Material & { opacity: number }).opacity = 0.65 + Math.sin(state.clock.elapsedTime * 3.2) * 0.2;
  });
  return (
    <mesh ref={r} position={[x, 0.07, z]} rotation={[-Math.PI / 2, 0, 0]}>
      <ringGeometry args={[0.34, 0.42, 32]} />
      <meshBasicMaterial map={glowTexture()} color="#ffb066" blending={AdditiveBlending} depthWrite={false} transparent opacity={0.7} />
    </mesh>
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
  useFrame(({ clock }) => {
    const t = clock.elapsedTime;
    if (bandMat.current) bandMat.current.opacity = 0.14 + 0.08 * (0.5 + 0.5 * Math.sin(t * 2.2));
    if (sweep.current) {
      const p = ((t % 2.8) / 2.8) * (span + 2) - (span / 2 + 1);
      if (isRow) sweep.current.position.x = tile.cx + p;
      else sweep.current.position.z = p;
    }
  });
  if (!(idx >= 0 && idx < span)) return null;
  const bandPos: [number, number, number] = isRow
    ? [tile.cx, 0.07, idx - (h - 1) / 2]
    : [tile.cx + idx - (w - 1) / 2, 0.07, 0];
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
      <sprite position={[bandPos[0], 1.2, bandPos[2]]} scale={[3.6, 0.68, 1]}>
        <spriteMaterial map={textTexture("SONAR · " + String(sonar.label).toUpperCase(), "#67e8f9", true)} depthWrite={false} transparent opacity={0.95} />
      </sprite>
    </group>
  );
}

/* ---------- one ocean tile: grid hologram, labels, ships, fires ---------- */

type ShipT = { key: string; size: number; variant: number; sunk: boolean; cells: string[]; hits: string[] };
type TileT = {
  name: string;
  hex: string;
  cx: number;
  ships: ShipT[];
  water: { label: string; result: string }[];
  canFire: boolean;
};

function GridHolo({ tile, w, h }: { tile: TileT; w: number; h: number }) {
  const lines = useMemo(() => {
    const pts: number[] = [];
    for (let i = 0; i <= w; i++) pts.push(tile.cx + i - w / 2, 0.06, -h / 2, tile.cx + i - w / 2, 0.06, h / 2);
    for (let j = 0; j <= h; j++) pts.push(tile.cx - w / 2, 0.06, j - h / 2, tile.cx + w / 2, 0.06, j - h / 2);
    return new Float32Array(pts);
  }, [tile.cx, w, h]);
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
        <mesh key={i} position={[b.p[0], b.p[1], b.p[2]]}>
          <boxGeometry args={[b.s[0], b.s[1], b.s[2]]} />
          <meshStandardMaterial color="#0b0e12" emissive={tile.hex} emissiveIntensity={1.5} toneMapped={false} />
        </mesh>
      ))}
      {/* coordinate labels: letters along the near edge, numbers along the west edge */}
      {Array.from({ length: w }, (_, i) => (
        <sprite key={"L" + i} position={[tile.cx + i - (w - 1) / 2, 0.12, h / 2 + 0.62]} scale={[0.52, 0.52, 1]}>
          <spriteMaterial map={textTexture(String.fromCharCode(65 + i), "#9fd8ef")} depthWrite={false} transparent opacity={0.9} />
        </sprite>
      ))}
      {Array.from({ length: h }, (_, j) => (
        <sprite key={"N" + j} position={[tile.cx - w / 2 - 0.62, 0.12, j - (h - 1) / 2]} scale={[0.52, 0.52, 1]}>
          <spriteMaterial map={textTexture(String(j + 1), "#9fd8ef")} depthWrite={false} transparent opacity={0.9} />
        </sprite>
      ))}
      <sprite position={[tile.cx, 0.12, -h / 2 - 0.72]} scale={[4.8, 0.9, 1]}>
        <spriteMaterial map={textTexture(tile.name + "'s waters", tile.hex, true)} depthWrite={false} transparent opacity={0.95} />
      </sprite>
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
    const meP = players.filter((p: GL) => p.name === me)[0] || players[0] || { name: me, hex: "#22d3ee" };
    const foeP = players.filter((p: GL) => p.name !== me)[0] || players[1] || { name: "?", hex: "#fb923c" };
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
      { name: meP.name, hex: meP.hex, cx: cxOf(0), ships: mkShips(you.fleet || [], (s) => !!s.sunk), water: ownWater, canFire: false },
      {
        name: foeP.name,
        hex: foeP.hex,
        cx: cxOf(1),
        ships: mkShips(you.sunk_ships || [], () => true),
        water: foeWater,
        canFire: !!(g.status === "running" && g.phase === "play" && you.your_turn),
      },
    ];
  }
  return (g.boards || []).map((b: GL, i: number) => {
    const sunkCells = new Set<string>();
    (b.sunk_ships || []).forEach((s: GL) => s.cells.forEach((c: string) => sunkCells.add(c)));
    const water = Object.keys(b.incoming || {})
      .filter((c) => !sunkCells.has(c))
      .map((c) => ({ label: c, result: b.incoming[c] }));
    return { name: b.name, hex: b.hex, cx: cxOf(i), ships: mkShips(b.sunk_ships || [], () => true), water, canFire: false };
  });
}

/* Drifting patches of moonlight on the water - cheap ocean life. */
function LightPatch({ seed }: { seed: number }) {
  const m = useRef<Mesh>(null);
  useFrame((s) => {
    if (!m.current) return;
    m.current.position.x = Math.sin(s.clock.elapsedTime * 0.03 + seed) * 15;
    m.current.position.z = Math.cos(s.clock.elapsedTime * 0.021 + seed * 2.3) * 5;
  });
  return (
    <mesh ref={m} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.02, 0]}>
      <planeGeometry args={[30, 15]} />
      <meshBasicMaterial map={glowTexture()} color="#2e5a7d" blending={AdditiveBlending} depthWrite={false} transparent opacity={0.1} />
    </mesh>
  );
}

/* ---------- the scene ---------- */

function Scene({ g, me, onFire, cd }: { g: GL; me: string; onFire?: (label: string) => void; cd: number }) {
  const w = g.w || 10;
  const h = g.h || 10;
  const tiles = useMemo(() => buildTiles(g, me), [g, me]);
  const sonar = g && g.sonar && g.phase === "play" && g.status === "running" ? g.sonar : null;
  const world = useRef<Group>(null);
  const [hover, setHover] = useState<string | null>(null);
  const downAt = useRef<{ x: number; y: number } | null>(null);

  /* Wrecks that appear while the view is open settle and burn in;
     wrecks already there at mount are settled. */
  const wreckKeys = tiles.flatMap((t, ti) => t.ships.filter((s) => s.sunk).map((s) => ti + ":" + s.key));
  const seenWrecks = useRef<Set<string>>(new Set(wreckKeys));
  const [freshWrecks, setFreshWrecks] = useState<Record<string, number>>({});

  /* Shot animations replay off last_move diffs (never on mount). */
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
      const ti = tiles.findIndex((t) => t.name !== lm.by);
      const tt = ti >= 0 ? tiles[ti] : undefined;
      if (tt) {
        const loc = cellLocal(lm.cell, w, h);
        setAnim({ id: lmKey, x: tt.cx + loc.x, z: loc.z, result: lm.result, sunk: lm.sunk });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [g]);

  const foeTile = tiles.filter((t) => t.canFire)[0];
  const foeShotCells = useMemo(() => {
    const s = new Set<string>();
    if (foeTile) {
      foeTile.water.forEach((m) => s.add(m.label));
      foeTile.ships.forEach((sh) => sh.cells.forEach((c) => s.add(c)));
    }
    return s;
  }, [foeTile]);
  const cellFromPoint = (p: { x: number; z: number }): string | null => {
    if (!foeTile) return null;
    const col = Math.round(p.x - foeTile.cx + (w - 1) / 2);
    const row = Math.round(p.z + (h - 1) / 2);
    if (col < 0 || col >= w || row < 0 || row >= h) return null;
    const label = String.fromCharCode(65 + col) + (row + 1);
    return foeShotCells.has(label) ? null : label;
  };
  const evXY = (e: ThreeEvent<PointerEvent>): { x: number; y: number } => {
    const n = (e as GL).nativeEvent || e;
    return { x: n.clientX || 0, y: n.clientY || 0 };
  };

  const lightBudget = { n: 0 };
  const lmTileIdx = lm ? tiles.findIndex((t) => t.name !== lm.by) : -1;

  return (
    <>
      <fog attach="fog" args={[SEA, cd * 1.9, cd * 4.2]} />
      <color attach="background" args={[SEA]} />
      <hemisphereLight args={["#8fb8d8", "#0a0f14", 0.85]} />
      <directionalLight position={[14, 20, 8]} intensity={1.45} color="#cfe6ff" />
      <directionalLight position={[-12, 9, -10]} intensity={0.4} color="#7fa8cc" />
      <ambientLight intensity={0.3} />
      <CameraControls makeDefault minDistance={7} maxDistance={80} maxPolarAngle={1.38} />
      <group ref={world}>
        {/* one reflective sea under both tiles */}
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 0]}>
          <planeGeometry args={[130, 130]} />
          <MeshReflectorMaterial
            blur={[280, 60]}
            resolution={1024}
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
        </mesh>
        <LightPatch seed={1.7} />
        <LightPatch seed={4.9} />
        {tiles.map((tile, ti) => {
          const shipEls: GL[] = [];
          const fireEls: GL[] = [];
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
                wreckAt={freshWrecks[ti + ":" + s.key]}
                center={center}
                vertical={vertical}
              />
            );
            if (s.sunk) {
              fireEls.push(<GlowDisc key={"gd" + s.key} position={[center.x, 0.03, center.z]} radius={s.size * 0.42} opacity={0.2} />);
              const idxs = s.size >= 4 ? [0, Math.floor(s.cells.length / 2), s.cells.length - 1] : [0, s.cells.length - 1];
              idxs.forEach((ci, fi) => {
                const cell = s.cells[ci];
                if (!cell) return;
                const loc = cellLocal(cell, w, h);
                const useLight = lightBudget.n < 3 && fi === 0;
                if (fi === 0) lightBudget.n++;
                fireEls.push(
                  <FireFx key={"wf" + s.key + ci} position={[tile.cx + loc.x, 0.42, loc.z]} scale={1.05} light={useLight} />
                );
              });
            } else {
              s.hits.forEach((c) => {
                const loc = cellLocal(c, w, h);
                fireEls.push(<FireFx key={"hf" + s.key + c} position={[tile.cx + loc.x, 0.5, loc.z]} scale={0.8} />);
              });
            }
          });
          return (
            <group key={tile.name + ti}>
              <GridHolo tile={tile} w={w} h={h} />
              {sonar && tile.name !== sonar.for ? <SonarBand tile={tile} w={w} h={h} sonar={sonar} /> : null}
              {shipEls}
              {fireEls}
              {tile.water.map((m) => {
                const loc = cellLocal(m.label, w, h);
                return m.result === "hit" ? (
                  <group key={m.label}>
                    <FireFx position={[tile.cx + loc.x, 0.14, loc.z]} scale={0.85} />
                    <GlowDisc position={[tile.cx + loc.x, 0.035, loc.z]} radius={0.6} />
                  </group>
                ) : (
                  <MissMarker key={m.label} x={tile.cx + loc.x} z={loc.z} />
                );
              })}
              {lm && lmTileIdx === ti ? (
                <LastShotRing x={tile.cx + cellLocal(lm.cell, w, h).x} z={cellLocal(lm.cell, w, h).z} />
              ) : null}
            </group>
          );
        })}
        {/* tap-to-fire surface over the enemy tile */}
        {foeTile ? (
          <mesh
            position={[foeTile.cx, 0.08, 0]}
            rotation={[-Math.PI / 2, 0, 0]}
            onPointerMove={(e) => {
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
              if (Math.hypot(p.x - d.x, p.y - d.y) > 6) return;
              const label = cellFromPoint(e.point);
              if (label && onFire) onFire(label);
            }}
            onPointerLeave={() => setHover(null)}
          >
            <planeGeometry args={[w, h]} />
            <meshBasicMaterial transparent opacity={0} depthWrite={false} />
          </mesh>
        ) : null}
        {foeTile && hover
          ? (() => {
              const loc = cellLocal(hover, w, h);
              return (
                <group position={[foeTile.cx + loc.x, 0.07, loc.z]}>
                  <mesh rotation={[-Math.PI / 2, 0, 0]}>
                    <ringGeometry args={[0.36, 0.44, 32]} />
                    <meshBasicMaterial map={glowTexture()} color="#ff5a3c" blending={AdditiveBlending} depthWrite={false} transparent opacity={0.9} />
                  </mesh>
                  <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.01, 0]}>
                    <planeGeometry args={[0.92, 0.92]} />
                    <meshBasicMaterial color="#ff5a3c" transparent opacity={0.14} depthWrite={false} />
                  </mesh>
                </group>
              );
            })()
          : null}
        {anim ? <ShotFx anim={anim} world={world} onDone={() => setAnim(null)} /> : null}
      </group>
      <Sparkles count={50} scale={[30, 4, 14]} position={[0, 2.4, 0]} size={1.5} speed={0.22} opacity={0.45} color="#7dd3fc" />
      <EffectComposer multisampling={2}>
        <>
          <Bloom mipmapBlur intensity={1.15} luminanceThreshold={0.72} luminanceSmoothing={0.3} />
          <Vignette offset={0.2} darkness={0.55} />
        </>
      </EffectComposer>
    </>
  );
}

export default function BsArena3D({
  g,
  me,
  aspect,
  onFire,
}: {
  g: GL;
  me: string;
  aspect?: number;
  onFire?: (label: string) => void;
}) {
  const w = g.w || 10;
  const span = 2 * w + 4;
  /* Frame by host aspect, not by a portrait/landscape guess: the
     two-tile span fits the horizontal fov when the camera distance
     scales as 1/aspect (anchored on the verified desktop framing,
     aspect 1.44 at cd ~22). A wide-but-short host (a phone with the
     shortened BS host) needs the same pullback as a portrait one. */
  const aspectV = aspect ?? 1.44;
  const narrow = aspectV < 1.3;
  const cd = Math.min(40, Math.max(19, (span * 1.34) / Math.max(0.7, aspectV)));
  return (
    <Canvas
      dpr={[1, 1.75]}
      camera={{ position: [0, cd * 0.76, cd * 0.65], fov: narrow ? 56 : 46, near: 0.1, far: 600 }}
      gl={{ antialias: true }}
    >
      <Scene g={g} me={me} onFire={onFire} cd={cd} />
    </Canvas>
  );
}
