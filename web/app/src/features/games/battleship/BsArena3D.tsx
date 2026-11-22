/* Battleship 3D arena (2026-11-12, Direction C + A's ocean motion,
   approved by Anthony from the mock-up page): a night tactical scene -
   two glowing-grid ocean tiles on dark reflective water, procedural
   steel warships with real silhouettes, bombs that visibly drop, and
   damage that persists: hit cells burn, sunk ships stay on the board
   as charred, listing, burning wreckage. A free-for-all (2026-11-20)
   lays its 3-6 oceans out in rows (bsLayout); the shot's target is the
   ocean picked.

   The scene is a pure function of the same per-viewer game state the
   2D arena consumes (you.fleet / you.shots / you.sunk_ships for a
   captain, g.boards for a spectator). The secrecy contract is the
   server's: un-hit enemy hulls are never in the state, so they can
   never render. Shot animations replay from last_move diffs and are
   presentation only. Mounted by games.ts through a dynamic import so
   three.js stays in the lazy chunk. */
import { createContext, useContext, useEffect, useEffectEvent, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactElement, type RefObject } from "react";
import { Canvas, useFrame, useThree, type ThreeEvent } from "@react-three/fiber";
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
} from "../three/arena3d";
import { ArenaPost, ImpactLayer, Intro, JuiceProvider, JuiceRig, SoundToggle, useFirstVisit, useJuice, useJuiceStore, type Impact } from "../three/juice";
import { Burst, LightPillar, Shockwave, SkyDome, type SkySpec } from "../three/atmos";
import { BUZZ, sfx } from "../three/sfx";
import { NO_MIRROR, OCEAN_Y, Ocean, OceanStore, oceanHeight, type OceanLook } from "./ocean";
import { ShipBody, newDamage, shipGeometry, shipMaterials } from "./ships";
import { FireSystem, type FireSpec } from "../three/fire";

/* The water, for anything that floats on it (ships ride the swell the
   shader draws; shells send ripples across it). */
const OceanCtx = createContext<OceanStore | null>(null);
const NOMIR = { [NO_MIRROR]: true };
import { CameraControls, Sparkles, Trail } from "@react-three/drei";
import {
  AdditiveBlending,
  CanvasTexture,
  Color,
  Euler,
  MeshStandardMaterial,
  Object3D,
  Plane,
  Quaternion,
  Vector3,
  type Group,
  type InstancedMesh,
  type Material,
  type Mesh,
  type Sprite,
  type SpriteMaterial,
} from "three";
import type {
  BattleshipBoard,
  BattleshipMove,
  BattleshipPlayer,
  BattleshipShip,
  BattleshipShot,
  BattleshipSonar,
  BattleshipState,
  BattleshipSunkShip,
  BattleshipTarget,
} from "@chat/contract";
import { useStable } from "../../../lib/useStable";

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
/* A hull's cells from its bow: lying H(orizontal) or V(ertical); null
   when it runs off the board. */
function shipCells(start: string, dir: string, size: number, w: number, h: number): string[] | null {
  const { col, row } = labelXY(start);
  const cells: string[] = [];
  for (let i = 0; i < size; i++) {
    const x = dir === "H" ? col + i : col;
    const y = dir === "H" ? row : row + i;
    if (x < 0 || y < 0 || x > w - 1 || y > h - 1) return null;
    cells.push(String.fromCharCode(65 + x) + (y + 1));
  }
  return cells;
}
/* Fleet placement (2026-11-20): the hull being placed. */
export type Placing = {
  placed: { start: string; dir: string; size: number }[];
  orient: string;
  next: number;
  onPlace: (label: string) => void;
  onRotate: () => void;
  onUndo: () => void;
};
/* The swell the ships ride (A's ocean motion, kept gentle so the board reads). */
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
   instanced draw. Fire itself lives in fire.tsx (GPU particles: three
   draws for every fire on the board); glows, misses and footprints are
   instanced quads here. Reduced motion freezes all of it. */

type GlowSpec = { x: number; y: number; z: number; r: number; a: number };
type Spot = { x: number; z: number; hex?: string };

/* Cells already fired at on an ocean, and what they are. */
function takenOf(t: TileT | undefined): Map<string, string> {
  const m = new Map<string, string>();
  if (t) {
    t.water.forEach((x) => m.set(x.label, x.result === "hit" ? "a hit" : "a miss"));
    t.ships.forEach((s) => s.cells.forEach((c) => m.set(c, "a sunk ship")));
  }
  return m;
}

const _o = new Object3D();
const _c = new Color();
const FLAT = new Quaternion().setFromEuler(new Euler(-Math.PI / 2, 0, 0));

/* Pools of firelight on the water under fires (additive: each pool's
   old opacity is folded into its colour). */
function GlowField({ glows }: { glows: GlowSpec[] }) {
  const ref = useRef<InstancedMesh>(null);
  const n = glows.length;
  // the same pools on a re-render keep their identity: no rewrite
  const list = useStable(glows, glows.map((g) => g.x.toFixed(2) + "," + g.z.toFixed(2) + "," + g.r + "," + g.a).join("|"));
  useLayoutEffect(() => {
    const m = ref.current;
    if (!m) return;
    list.forEach((g, i) => {
      _o.position.set(g.x, g.y, g.z);
      _o.quaternion.copy(FLAT);
      _o.scale.set(g.r, g.r, 1);
      _o.updateMatrix();
      m.setMatrixAt(i, _o.matrix);
      m.setColorAt(i, _c.set("#ff7a26").multiplyScalar(g.a));
    });
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
  }, [list]);
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
  const list = useStable(spots, spots.map((p) => p.x.toFixed(2) + "," + p.z.toFixed(2) + (p.hex || "")).join("|"));
  useLayoutEffect(() => {
    const m = ref.current;
    if (!m) return;
    list.forEach((p, i) => {
      _o.position.set(p.x, y, p.z);
      _o.quaternion.copy(FLAT);
      _o.scale.set(1, 1, 1);
      _o.updateMatrix();
      m.setMatrixAt(i, _o.matrix);
      if (p.hex) m.setColorAt(i, _c.set(p.hex));
    });
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
  }, [list, y]);
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

/* ---------- ships (ships.tsx builds them) ---------- */

/* One ship on the water. wreckAt: performance.now() stamp from when the
   sinking first appeared in state (it goes down over ~3.2 s); a ship
   already sunk when the view opened rests as a wreck at once. hitXs:
   where along the hull (local x, bow +x) shells struck - each a scorched
   hole with a glowing rim; every hit also sits the ship a little lower
   and lists it a little further.

   How each class dies: a carrier or battleship breaks in two - the bow
   and stern rise as the halves part and settle, cut by a clipping plane
   at the break (two bodies, each clipped to its half); a cruiser or
   destroyer capsizes onto its side, red bottom up; a submarine goes
   down until only its sail breaks the surface. The wreck stays where it
   died: the board is the record. */
function ShipModel({
  size,
  variant,
  hex,
  sunk,
  wreckAt,
  center,
  vertical,
  hitXs,
}: {
  size: number;
  variant: number;
  hex: string;
  sunk: boolean;
  wreckAt?: number;
  center: { x: number; z: number };
  vertical: boolean;
  hitXs: number[];
}) {
  const group = useRef<Group>(null);
  const pivotF = useRef<Group>(null);
  const childF = useRef<Group>(null);
  const pivotA = useRef<Group>(null);
  const childA = useRef<Group>(null);
  const geo = useMemo(() => shipGeometry(size, variant), [size, variant]);
  const split = size >= 4 && !geo.sub;
  const bx = geo.L * 0.06;
  const planeF = useMemo(() => new Plane(new Vector3(1, 0, 0), 1e4), []);
  const planeA = useMemo(() => new Plane(new Vector3(-1, 0, 0), 1e4), []);
  const dmg = useMemo(() => newDamage(), []);
  const mats = useMemo(() => shipMaterials(geo, hex, dmg, split ? [planeF] : undefined), [geo, hex, dmg, split, planeF]);
  const matsAft = useMemo(() => (split ? shipMaterials(geo, hex, dmg, [planeA]) : null), [geo, hex, dmg, split, planeA]);
  const radarSpin = useRef(0);
  const wreck = useRef(sunk && wreckAt === undefined ? 1 : 0);
  const listSign = useMemo(() => (hash01(center.x + ":" + center.z) > 0.5 ? 1 : -1), [center]);
  const seed = useMemo(() => hash01(center.x + "/" + center.z) * 6, [center]);
  const still = useContext(Still);
  const ocean = useContext(OceanCtx);
  const j = useJuice();
  const gl = useThree((st) => st.gl);
  useEffect(() => {
    gl.localClippingEnabled = true;
  }, [gl]);
  useEffect(() => {
    // the break itself is a burn too
    const xs = split && sunk ? [...hitXs.slice(0, 5), bx] : hitXs.slice(0, 6);
    xs.forEach((x, i) => (dmg.uHitX.value[i] = x));
    dmg.uHitN.value = xs.length;
  }, [hitXs, dmg, split, sunk, bx]);
  const hitFrac = Math.min(1, hitXs.length / size);
  const _n = useMemo(() => new Vector3(), []);
  const _p = useMemo(() => new Vector3(), []);
  const _q = useMemo(() => new Quaternion(), []);
  useFrame((state, dt) => {
    const grp = group.current;
    if (!grp) return;
    const target = sunk ? 1 : 0;
    if (still) {
      wreck.current = target;
    } else if (wreckAt !== undefined && sunk) {
      const p = Math.min(1, Math.max(0, (performance.now() - wreckAt) / 3200));
      wreck.current = p * p * (3 - 2 * p);
      if (p < 1) state.invalidate();
    } else {
      wreck.current += (target - wreck.current) * Math.min(1, dt * 2);
    }
    const wk = wreck.current;
    const bob = still ? 0 : 1 - wk * 0.7;
    /* Ride the water the shader draws: height at the hull's centre,
       pitch from the slope along its length, roll from the slope
       across it (Euler YXZ: yaw, then roll about the keel, then
       pitch). Damage sits it lower and lists it. */
    const o = oceanHeight(center.x, center.z, still ? 7.3 : j.t, ocean ? ocean.calms : []);
    const along = vertical ? -o.gz : o.gx;
    const across = vertical ? o.gx : o.gz;
    const hurt = hitFrac * (1 - wk);
    let sinkY = 0;
    let roll = 0;
    let pitch = 0;
    if (split) sinkY = -0.24 * wk;
    else if (geo.sub) {
      sinkY = -0.2 * wk;
      pitch = -0.12 * wk;
    } else {
      // capsize: over onto the side, floating low
      sinkY = -0.06 * wk;
      roll = listSign * 1.25 * wk;
    }
    grp.position.set(center.x, OCEAN_Y + (o.h - OCEAN_Y) * bob - 0.035 * hurt + sinkY, center.z);
    grp.rotation.order = "YXZ";
    grp.rotation.set(
      -Math.atan(across) * 0.8 * bob + listSign * 0.07 * hurt + roll + (split ? listSign * 0.1 * wk : 0),
      vertical ? Math.PI / 2 : 0,
      Math.atan(along) * 0.8 * bob + pitch
    );
    if (split && pivotF.current && childF.current) {
      // the halves part at the break and tip: bow up, stern up
      pivotF.current.position.set(bx + 0.14 * wk, 0, 0);
      pivotF.current.rotation.set(0, 0, 0.42 * wk);
      childF.current.position.set(-bx, 0, 0);
      if (pivotA.current && childA.current) {
        pivotA.current.position.set(bx - 0.14 * wk, 0, 0);
        pivotA.current.rotation.set(0, 0, -0.32 * wk);
        childA.current.position.set(-bx, 0, 0);
      }
      grp.updateMatrixWorld(true);
      if (wk > 0.001) {
        // each half keeps its side of the break (planes in world space)
        childF.current.getWorldQuaternion(_q);
        _n.set(1, 0, 0).applyQuaternion(_q);
        _p.set(bx, 0, 0);
        childF.current.localToWorld(_p);
        planeF.setFromNormalAndCoplanarPoint(_n, _p);
        if (childA.current) {
          childA.current.getWorldQuaternion(_q);
          _n.set(-1, 0, 0).applyQuaternion(_q);
          _p.set(bx, 0, 0);
          childA.current.localToWorld(_p);
          planeA.setFromNormalAndCoplanarPoint(_n, _p);
        }
      } else {
        planeF.set(_n.set(1, 0, 0), 1e4);
      }
    }
    radarSpin.current = still || wk > 0.5 ? seed : j.t * 1.4 + seed;
    dmg.uTime.value = j.t;
    dmg.uChar.value = wk;
    mats.rim.emissiveIntensity = 2.2 * (1 - wk) + 0.04;
    mats.lights.opacity = 1 - wk;
    mats.lights.transparent = wk > 0;
    if (matsAft) matsAft.rim.emissiveIntensity = mats.rim.emissiveIntensity;
  });
  return (
    <group ref={group} position={[center.x, 0, center.z]}>
      <group ref={pivotF}>
        <group ref={childF}>
          <ShipBody geo={geo} mats={mats} still={still} radarSpin={radarSpin} foam={!sunk} />
        </group>
      </group>
      {split && sunk && matsAft ? (
        <group ref={pivotA}>
          <group ref={childA}>
            <ShipBody geo={geo} mats={matsAft} still={still} radarSpin={radarSpin} foam={false} />
          </group>
        </group>
      ) : null}
    </group>
  );
}

/* Debris around the wrecks: planks and plating bobbing on the swell and
   drifting a little, one instanced draw for every wreck on the board. */
type Debris = { x: number; z: number; s: number; r: number; k: string };
function DebrisField({ pieces }: { pieces: Debris[] }) {
  const ref = useRef<InstancedMesh>(null);
  const still = useContext(Still);
  const ocean = useContext(OceanCtx);
  const j = useJuice();
  const n = pieces.length;
  useLayoutEffect(() => {
    const m = ref.current;
    if (!m) return;
    pieces.forEach((p, i) => m.setColorAt(i, _c.set(hash01(p.k + "c") > 0.5 ? "#3a2c22" : "#2a2f35")));
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
  }, [pieces]);
  useFrame(() => {
    const m = ref.current;
    if (!m) return;
    const t = still ? 7.3 : j.t;
    pieces.forEach((p, i) => {
      const dx = still ? 0 : Math.sin(t * 0.07 + p.r * 6) * 0.08;
      const dz = still ? 0 : Math.cos(t * 0.05 + p.r * 4) * 0.06;
      const o = oceanHeight(p.x + dx, p.z + dz, t, ocean ? ocean.calms : []);
      _o.position.set(p.x + dx, o.h + 0.006, p.z + dz);
      _o.rotation.set(o.gz * 0.8, p.r * 6 + (still ? 0 : t * 0.04 * (p.r - 0.5)), -o.gx * 0.8);
      _o.scale.set(p.s, 0.025, p.s * 0.32);
      _o.updateMatrix();
      m.setMatrixAt(i, _o.matrix);
    });
    m.instanceMatrix.needsUpdate = true;
  });
  if (!n) return null;
  return (
    <instancedMesh key={"d" + n} ref={ref} args={[undefined, undefined, n]} frustumCulled={false}>
      <boxGeometry args={[1, 1, 1]} />
      <meshStandardMaterial roughness={0.9} metalness={0.1} />
    </instancedMesh>
  );
}

/* ---------- shot effects: the bomb drops, then the burst ---------- */

type Anim = { id: string; x: number; z: number; result: string; sunk: number | null; impact: Impact; sink: Sink | null };
type Sink = { id: string; at: [number, number, number]; box: [number, number, number] };

/* A ship going down: fire and debris thrown up, a ring racing out
   over the water, a column of flame. On the juice clock. */
function SinkFx({ sink, lite, onDone }: { sink: Sink; lite: boolean; onDone: () => void }) {
  return (
    <group>
      <Burst at={sink.at} hex="#ff8a3c" box={sink.box} count={lite ? 46 : 90} power={2.3} piece={0.12} dur={1.9} onDone={onDone} />
      <Shockwave at={[sink.at[0], 0.06, sink.at[2]]} hex="#9fdcff" radius={6} dur={1.2} />
      <LightPillar at={sink.at} hex="#ff6a1f" height={7} width={0.8} dur={1.3} />
    </group>
  );
}

const SHIP_NAME = (size: number, variant: number) =>
  size === 5 ? "carrier" : size === 4 ? "battleship" : size === 3 ? (variant === 0 ? "cruiser" : "destroyer") : size === 2 ? "patrol boat" : size + "-ship";

function ShotFx({ anim, onImpact, onDone }: { anim: Anim; onImpact: () => void; onDone: () => void }) {
  const j = useJuice();
  const impacted = useRef(false);
  const bomb = useRef<Group>(null);
  const burst = useRef<Group>(null);
  const parts = useRef<(Mesh | Sprite | null)[]>([]);
  const ring = useRef<Mesh>(null);
  const flash = useRef<Sprite>(null);
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
  useFrame((state, delta) => {
    if (!done.current) state.invalidate();
    // The juice clock: the burst freezes in a hit-stop and crawls in
    // slow motion with the rest of the world.
    const t = j.t;
    const dt = Math.min(delta, 0.1) * j.scale;
    if (start.current === null) start.current = t;
    const el = t - start.current;
    const hit = anim.result === "hit";
    if (el >= FALL && !impacted.current) {
      impacted.current = true;
      onImpact();
    }
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
    }
    if (bp >= 1 && !done.current) {
      done.current = true;
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
function SonarBand({ tile, w, h, sonar }: { tile: TileT; w: number; h: number; sonar: BattleshipSonar }) {
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

/* ---------- placement: the next hull as a hologram ---------- */

/* Where the next hull would lie from a bow cell: a translucent hull and
   its footprint, cyan when it fits and red when it runs off the board or
   over a hull already down (drawn past the edge, so you see why). */
function GhostHull({ tile, w, h, bow, size, orient, valid }: { tile: TileT; w: number; h: number; bow: string; size: number; orient: string; valid: boolean }) {
  const { col, row } = labelXY(bow);
  const vertical = orient === "V";
  const x = tile.cx + col + (vertical ? 0 : (size - 1) / 2) - (w - 1) / 2;
  const z = tile.cz + row + (vertical ? (size - 1) / 2 : 0) - (h - 1) / 2;
  const c = valid ? "#5eead4" : "#f87171";
  const len = size - 0.12;
  const still = useContext(Still);
  const hull = useRef<MeshStandardMaterial>(null);
  useFrame(({ clock }) => {
    if (hull.current) hull.current.opacity = still ? 0.42 : 0.34 + 0.1 * Math.sin(clock.elapsedTime * 4);
  });
  return (
    <group position={[x, 0, z]} userData={NOMIR}>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.075, 0]} renderOrder={6}>
        <planeGeometry args={[vertical ? 0.94 : len + 0.06, vertical ? len + 0.06 : 0.94]} />
        <meshBasicMaterial color={c} transparent opacity={0.24} depthWrite={false} toneMapped={false} />
      </mesh>
      <mesh position={[0, 0.3, 0]} renderOrder={7}>
        <boxGeometry args={[vertical ? 0.5 : len - 0.2, 0.36, vertical ? len - 0.2 : 0.5]} />
        <meshStandardMaterial ref={hull} color={c} emissive={c} emissiveIntensity={0.9} transparent opacity={0.38} depthWrite={false} toneMapped={false} />
      </mesh>
    </group>
  );
}

/* ---------- one ocean tile: grid hologram, labels, ships, fires ---------- */

/* A ship as buildTiles reads it from the state: one of your own (with
   its hits and sunk flag) or a sunk one (size and cells only). */
type ShipView = BattleshipSunkShip & Partial<Pick<BattleshipShip, "hits" | "sunk">>;
type ShipT = { key: string; size: number; variant: number; sunk: boolean; cells: string[]; hits: string[] };
type TileT = {
  name: string;
  /* What the tile's heading says: "Your waters" for a captain's own
     ocean, "<name>'s waters - tap to fire" for the enemy's on their
     turn, "<name>'s waters" otherwise. */
  title: string;
  hex: string;
  /* The ocean's centre: a two-captain match lays its two side by side
     (cz 0); a free-for-all lays 3-6 in rows (see bsLayout). */
  cx: number;
  cz: number;
  ships: ShipT[];
  water: { label: string; result: string }[];
  canFire: boolean;
  /* A free-for-all captain whose last ship sank: a wreck chart, never a
     target. */
  wreck?: boolean;
  /* The viewer's own ocean (a captain's), never fired at. */
  own?: boolean;
};

/* Where each ocean sits (2026-11-20, the free-for-all scene): two side
   by side as always; three or four in a 2x2 (three: two in front, one
   centred behind), five or six in rows of three; the first ocean - a
   captain's own waters - front left, the gaps wide enough for each
   tile's row numbers and its title. */
const FFA_GAP_X = 4;
const FFA_GAP_Z = 4;
function bsLayout(n: number, w: number, h: number): { at: { cx: number; cz: number }[]; spanW: number; spanD: number } {
  if (n <= 2) return { at: [{ cx: -(w / 2 + 2), cz: 0 }, { cx: w / 2 + 2, cz: 0 }].slice(0, Math.max(1, n)), spanW: 2 * w + 4, spanD: h };
  const cols = n <= 4 ? 2 : 3;
  const rows = Math.ceil(n / cols);
  const at: { cx: number; cz: number }[] = [];
  for (let i = 0; i < n; i++) {
    const r = Math.floor(i / cols);
    const inRow = Math.min(cols, n - r * cols);
    const k = i - r * cols;
    at.push({ cx: (k - (inRow - 1) / 2) * (w + FFA_GAP_X), cz: ((rows - 1) / 2 - r) * (h + FFA_GAP_Z) });
  }
  return { at, spanW: cols * w + (cols - 1) * FFA_GAP_X, spanD: rows * h + (rows - 1) * FFA_GAP_Z };
}

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
  // a wreck chart's frame goes ash grey: nobody fires there any more
  const frameMat = useMemo(
    () => new MeshStandardMaterial({ color: "#0b0e12", emissive: new Color(tile.wreck ? "#6b7280" : tile.hex), emissiveIntensity: 1.5, toneMapped: false }),
    [tile.hex, tile.wreck]
  );
  useEffect(() => () => frameMat.dispose(), [frameMat]);
  useFrame(({ clock }) => {
    frameMat.emissiveIntensity = tile.canFire ? (still ? 3.2 : 2.6 + 0.9 * Math.sin(clock.elapsedTime * 3)) : tile.wreck ? 0.7 : 1.5;
  });
  return (
    <group position={[0, 0, tile.cz]}>
      <lineSegments>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[lines, 3]} />
        </bufferGeometry>
        <lineBasicMaterial color={tile.wreck ? "#94a3b8" : GRID_C} transparent opacity={tile.wreck ? 0.2 : 0.34} />
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
      <Label text={tile.title} color={tile.wreck ? "#94a3b8" : tile.hex} position={[tile.cx, 0.12, -h / 2 - 1.5]} height={0.9} wide />
    </group>
  );
}

/* ---------- derive the oceans from the per-viewer state ---------- */

function buildTiles(g: BattleshipState, me: string): TileT[] {
  const w = g.w || 10;
  const h = g.h || 10;
  const mkShips = (list: ShipView[], sunkOf: (s: ShipView) => boolean): ShipT[] => {
    const seenSize: Record<number, number> = {};
    return (list || []).map((s: ShipView) => {
      const v = seenSize[s.size] || 0;
      seenSize[s.size] = v + 1;
      return { key: s.cells.join("."), size: s.size, variant: v, sunk: sunkOf(s), cells: s.cells, hits: s.hits || [] };
    });
  };
  // open water that took fire: every shot except those inside a sunk hull
  const waterOf = (shots: Record<string, string>, hulls: BattleshipSunkShip[]): { label: string; result: string }[] => {
    const inHull = new Set<string>();
    (hulls || []).forEach((s: BattleshipSunkShip) => s.cells.forEach((c: string) => inHull.add(c)));
    return Object.keys(shots || {})
      .filter((c) => !inHull.has(c))
      .map((c) => ({ label: c, result: String(shots[c]) }));
  };
  const place = (list: Omit<TileT, "cx" | "cz">[]): TileT[] => {
    const lay = bsLayout(list.length, w, h);
    return list.map((t, i) => {
      const at = lay.at[i] || lay.at[0] || { cx: 0, cz: 0 };
      return { ...t, cx: at.cx, cz: at.cz };
    });
  };
  const you = g.you || { playing: false };
  if (you.playing) {
    const players = g.players || [];
    // The server matches names case-insensitively; so does the scene.
    const isMe = (p: BattleshipPlayer) => String(p.name).toLowerCase() === String(me).toLowerCase();
    const meP = players.filter(isMe)[0] || players[0] || { name: me, hex: "#22d3ee" };
    const turn = !!(g.status === "running" && g.phase === "play" && you.your_turn && !you.eliminated);
    const own: Omit<TileT, "cx" | "cz"> = {
      name: meP.name,
      title: "Your waters" + (you.eliminated ? " — wreck" : ""),
      hex: meP.hex,
      ships: mkShips(you.fleet || [], (s) => !!s.sunk),
      water: waterOf(you.incoming || {}, you.fleet || []),
      canFire: false,
      wreck: !!you.eliminated,
      own: true,
    };
    // A free-for-all: one ocean per rival, each showing YOUR shots there
    // (the server keeps a captain's record per target).
    if (Array.isArray(you.targets) && players.length > 2) {
      return place([
        own,
        ...you.targets.map((t: BattleshipTarget) => {
          const fire = turn && !t.eliminated;
          return {
            name: t.name,
            title: t.name + "'s waters" + (t.eliminated ? " — wreck" : fire ? " · tap to fire" : ""),
            hex: t.hex,
            ships: mkShips(t.sunk_ships || [], () => true),
            water: waterOf(t.shots || {}, t.sunk_ships || []),
            canFire: fire,
            wreck: !!t.eliminated,
          };
        }),
      ]);
    }
    const foeP = players.filter((p: BattleshipPlayer) => p !== meP)[0] || players[1] || { name: "?", hex: "#fb923c" };
    return place([
      own,
      {
        name: foeP.name,
        title: foeP.name + "'s waters" + (turn ? " · tap to fire" : ""),
        hex: foeP.hex,
        ships: mkShips(you.sunk_ships || [], () => true),
        water: waterOf(you.shots || {}, you.sunk_ships || []),
        canFire: turn,
      },
    ]);
  }
  return place(
    (g.boards || []).map((b: BattleshipBoard) => ({
      name: b.name,
      title: b.name + "'s waters" + (b.eliminated ? " — wreck" : ""),
      hex: b.hex,
      ships: mkShips(b.sunk_ships || [], () => true),
      water: waterOf(b.incoming || {}, b.sunk_ships || []),
      canFire: false,
      wreck: !!b.eliminated,
    }))
  );
}

/* Drifting patches of moonlight on the water - cheap ocean life. */
/* ---------- the scene ---------- */

/* The Battleship world (2026-11-13, dusk since the owner found the
   night fleet too dark - lit from behind, the hulls read as
   silhouettes): the sun just setting low on the far left horizon, the
   sky peach at the horizon through lavender to deep blue overhead, the
   first stars. The fog is the horizon's colour, so the far sea melts
   into the sky; the water reflects the dusk (desktop: a mirror of the
   scene) with a golden glitter path toward the sun. */
const BS_SUN: [number, number, number] = [-0.62, 0.11, -0.78];
const BS_HAZE = "#e3a27e";
const BS_FOG = BS_HAZE;
const BS_SKY: SkySpec = {
  top: "#18224a",
  mid: "#5a5b97",
  horizon: "#e89a6a",
  ground: "#2a2433",
  glow: "#ff8a4c",
  glowAmt: 0.32,
  stars: 0.03,
  aurora: 0,
  moon: { dir: BS_SUN, size: 0.052, color: "#ffd7a0" },
};
const BS_OCEAN: OceanLook = {
  deep: "#13253a",
  scatter: "#3b6d84",
  horizon: "#e89a6a",
  mid: "#5a5b97",
  top: "#18224a",
  glow: "#ff8a4c",
  auroraA: "#000000",
  auroraB: "#000000",
  aurora: 0,
  moonDir: BS_SUN,
  moon: "#ffcf8f",
};

/* How hard a shot lands, by who fired and who was hit (the five-tier
   ladder in .claude/skills/immersive-3d-games): a miss is a splash; a
   hit is a medium beat - heavier when it is your ship; a sinking is a
   large one with a title card; the shot that ends the match adds slow
   motion. "You hit them" and "you were hit" never share a buzz. */
/* out: a free-for-all captain's last ship just sank, the match going on
   without them - decisive for that captain (the viewer losing it gets
   the full loss), large for everyone else. */
/* Whose ocean a shot landed in: the server's record names the target;
   a two-captain record without one means the shooter's rival. */
function shotTarget(lm: BattleshipMove, g: BattleshipState): string {
  if (lm && lm.target) return String(lm.target);
  return ((g.players || []) as BattleshipPlayer[]).map((p) => String(p.name)).filter((n) => n !== (lm && lm.by))[0] || "";
}

function shotImpact(lm: BattleshipMove, me: string, target: string, shipName: string, final: boolean, out?: boolean): Impact {
  const meL = (me || "").toLowerCase();
  const mine = String(lm.by || "").toLowerCase() === meL;
  const atMe = target.toLowerCase() === meL;
  if (lm.result !== "hit") return { sound: "splash", trauma: atMe ? 0.12 : 0.06, buzz: atMe ? BUZZ.nearMiss : undefined };
  if (!lm.sunk)
    return atMe
      ? { trauma: 0.45, stop: 110, pulse: 0.6, flash: "#ff4a3c", flashA: 0.22, buzz: BUZZ.hitYou, sound: "boom" }
      : { trauma: mine ? 0.35 : 0.25, stop: mine ? 100 : 70, pulse: 0.55, buzz: mine ? BUZZ.scored : undefined, sound: "boom" };
  if (out && !final) {
    if (atMe)
      return { trauma: 0.85, stop: 260, slow: 1, pulse: 1, flash: "#ff3344", flashA: 0.45, buzz: BUZZ.lostMatch, sound: "bigboom", title: { big: "Your fleet is gone", small: "Sunk by " + lm.by + " · the sea fights on", tone: "bad" } };
    if (mine)
      return { trauma: 0.7, stop: 220, pulse: 1, flash: "#ffd36b", flashA: 0.32, buzz: BUZZ.sankTheirs, sound: "bigboom", title: { big: target + " is out", small: "Their last ship - yours", tone: "good" } };
    return { trauma: 0.55, stop: 200, pulse: 0.9, sound: "bigboom", title: { big: target + " is out", small: lm.by + " sank their last ship", tone: "neutral" } };
  }
  const slow = final ? { slow: 1, stop: 260 } : {};
  if (atMe)
    return {
      trauma: 0.85,
      stop: 240,
      slow: 0.8,
      pulse: 1,
      flash: "#ff3344",
      flashA: 0.45,
      buzz: final ? BUZZ.lostMatch : BUZZ.lostOne,
      sound: "bigboom",
      title: { big: "Your " + shipName + " is down", small: "Sunk by " + lm.by, tone: "bad" },
      ...slow,
    };
  if (mine)
    return {
      trauma: 0.6,
      stop: 200,
      pulse: 0.9,
      flash: "#ffd36b",
      flashA: 0.3,
      buzz: final ? BUZZ.wonMatch : BUZZ.sankTheirs,
      sound: "bigboom",
      title: { big: shipName + " sunk", small: target + "'s fleet is burning", tone: "good" },
      ...slow,
    };
  return { trauma: 0.5, stop: 180, pulse: 0.8, sound: "bigboom", title: { big: target + "'s " + shipName + " sunk", tone: "neutral" }, ...slow };
}

function Scene({
  g,
  placing,
  tiles,
  allTiles,
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
  me,
  intro,
  ready,
}: {
  me: string;
  intro: boolean;
  ready: boolean;
  g: BattleshipState;
  /* fleet placement: the next hull (0 once the fleet is down) */
  placing?: { size: number; orient: string; occupied: Set<string> } | null;
  tiles: TileT[];
  // every ocean, shown or not (a phone shows one at a time)
  allTiles: TileT[];
  foeName: string | null;
  onFire?: (label: string, target: string) => void;
  onAim?: (label: string, target: string) => void;
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
  /* Fire heat by strike recency, from the ordered shot record: the
     latest hit on a board burns at full heat and each older hit steps
     down, so by endgame only the freshest few fires blaze and the rest
     sit at embers - the board stays readable (room feedback, 2026-11-16:
     Matheo and Jen could not see the squares through the fire). A cell
     with no recorded shot keeps full heat. */
  const heatAt = (() => {
    const m = new Map<string, number>();
    const shots = (g.shots || []) as BattleshipShot[];
    const names = ((g.players || []) as BattleshipPlayer[]).map((p) => String(p.name).toLowerCase());
    if (shots.length) {
      const perBoard = new Map<string, string[]>();
      for (const s of shots) {
        if (!s || s.result !== "hit") continue;
        // the board it landed on: the record's target (a free-for-all
        // always names one), else the shooter's one rival
        const owner = s.target ? String(s.target).toLowerCase() : names.length === 2 ? names.find((n) => n !== String(s.by).toLowerCase()) : undefined;
        if (!owner) continue;
        const arr = perBoard.get(owner) || [];
        arr.push(String(s.cell));
        perBoard.set(owner, arr);
      }
      perBoard.forEach((cells, owner) => {
        cells.forEach((cell, i) => {
          m.set(owner + "|" + cell, Math.max(0, 1 - (cells.length - 1 - i) * 0.22));
        });
      });
    }
    return (tileName: string, cell: string): number => m.get(tileName.toLowerCase() + "|" + cell) ?? 1;
  })();
  const world = useRef<Group>(null);
  const [hover, setHover] = useState<{ t: string; c: string } | null>(null);
  const downAt = useRef<{ x: number; y: number } | null>(null);

  /* Wrecks that appear while the view is open settle and burn in;
     wrecks already there at mount are settled. Keyed by ocean name,
     not position: on a phone the shown ocean swaps, and a wreck must
     not replay its sinking when its ocean comes back into view. */
  // from every ocean, not just the shown one: an ocean swapped into view
  // must not take its old wrecks for new sinkings
  const wreckKeys = allTiles.flatMap((t) => t.ships.filter((s) => s.sunk).map((s) => t.name + ":" + s.key));
  const seenWrecks = useRef<Set<string>>(new Set(wreckKeys));
  const [freshWrecks, setFreshWrecks] = useState<Record<string, number>>({});

  /* Shot animations replay off last_move diffs (never on mount, and
     never under reduced motion - the bomb drop and the camera shake
     are exactly what that setting asks to skip). */
  const lm = g.last_move as BattleshipMove | null;
  const lmKey = lm ? lm.turn + ":" + lm.by + ":" + lm.cell : "";
  const seenLm = useRef<string | null>(null);
  const seenStatus = useRef<string | null>(null);
  // Every shot in flight gets its own ShotFx (keyed by shot): a salvo's
  // next shell can land a second after the last, and sharing one
  // instance carried the old shot's timeline over and lost an impact.
  const [anims, setAnims] = useState<Anim[]>([]);
  const [sinks, setSinks] = useState<Sink[]>([]);
  const juice = useJuice();
  const ocean = useMemo(() => new OceanStore(), []);
  // calm water over each shown board (and its labels)
  ocean.calms = tiles.map((t) => ({ x: t.cx, z: t.cz, hw: w / 2 + 0.7, hh: h / 2 + 0.7 }));

  // A new game state stages its effects: fresh wrecks start to burn, a
  // new shot flies (or lands at once under reduced motion), a finish
  // gets its title. Reads the rest of the scene as it is now.
  const onGame = useEffectEvent((game: BattleshipState, boards: TileT[]) => {
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
    const status = String(game.status || "");
    if (seenLm.current === null) {
      seenLm.current = lmKey;
      seenStatus.current = status;
      return;
    }
    const ended = status === "finished" && seenStatus.current !== "finished";
    seenStatus.current = status;
    let shot = false;
    if (lmKey && lmKey !== seenLm.current) {
      seenLm.current = lmKey;
      shot = true;
      const target = shotTarget(lm!, game);
      const tt = boards.filter((t) => t.name === target)[0];
      const ship = tt && lm!.sunk ? tt.ships.filter((sh) => sh.cells.includes(lm!.cell))[0] : undefined;
      // a free-for-all captain knocked out by this shot
      const out = !!(lm!.sunk && ((game.eliminated || []) as string[]).some((n) => String(n).toLowerCase() === target.toLowerCase()));
      const imp = shotImpact(lm!, me, target, ship ? SHIP_NAME(ship.size, ship.variant) : lm!.sunk ? SHIP_NAME(lm!.sunk, 0) : "", ended, out);
      let sink: Sink | null = null;
      if (tt && ship) {
        const pts = ship.cells.map((c) => cellLocal(c, w, h));
        const xs = pts.map((p) => p.x);
        const zs = pts.map((p) => p.z);
        const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
        const cz = (Math.min(...zs) + Math.max(...zs)) / 2;
        sink = { id: lmKey, at: [tt.cx + cx, 0.1, tt.cz + cz], box: [Math.max(...xs) - Math.min(...xs) + 0.7, 0.7, Math.max(...zs) - Math.min(...zs) + 0.7] };
      }
      if (tt && !still) {
        const loc = cellLocal(lm!.cell, w, h);
        sfx("whistle");
        const next: Anim = { id: lmKey, x: tt.cx + loc.x, z: tt.cz + loc.z, result: lm!.result, sunk: lm!.sunk, impact: imp, sink };
        setAnims((l) => [...l.filter((a) => a.id !== next.id).slice(-5), next]);
      } else juice.hit(imp);
    }
    if (ended) {
      const winner = String(game.winner || "");
      const meL = (me || "").toLowerCase();
      const delay = shot && !still ? 2600 : 0;
      const players = (game.players || []).map((p: BattleshipPlayer) => String(p.name).toLowerCase());
      if (winner && winner.toLowerCase() === meL)
        juice.hit({ sound: "win", soundDelay: delay / 1000, title: { big: "Victory", small: "Enemy fleet destroyed", tone: "good" }, titleDelay: delay });
      else if (winner && players.includes(meL))
        juice.hit({ sound: "lose", soundDelay: delay / 1000, title: { big: "Fleet lost", small: winner + " wins", tone: "bad" }, titleDelay: delay });
      else if (winner) juice.hit({ sound: "win", soundDelay: delay / 1000, title: { big: winner + " wins", small: "Fleet destroyed", tone: "neutral" }, titleDelay: delay });
    }
  });
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- a new game state from the server stages the shot, the sinking and the fresh wrecks
    onGame(g, tiles);
  }, [g, tiles]);

  /* The ocean a captain aims at - the enemy's (a free-for-all: the
     rival last aimed at or fired on), on or off their turn (Enter or
     the Fire button only fires on their turn). */
  const aimTile = foeName ? tiles.filter((t) => t.name === foeName)[0] : undefined;
  /* Where a pointer picks a cell: on desktop every ocean you may fire
     at now (a click fires there); on touch every rival ocean that is
     not a wreck (a tap aims there, the Fire button fires). */
  /* Placing a fleet, your own ocean is the one to pick a bow cell on. */
  const pickTiles = placing
    ? tiles.filter((t) => t.own && placing.size > 0)
    : tiles.filter((t) => (aimMode ? !t.own && !t.wreck && !!onAim : t.canFire));
  const cellFromPoint = (tile: TileT, p: { x: number; z: number }): string | null => {
    const col = Math.round(p.x - tile.cx + (w - 1) / 2);
    const row = Math.round(p.z - tile.cz + (h - 1) / 2);
    if (col < 0 || col >= w || row < 0 || row >= h) return null;
    const label = String.fromCharCode(65 + col) + (row + 1);
    if (placing) return label;
    if (tile.water.some((m) => m.label === label) || tile.ships.some((sh) => sh.cells.includes(label))) return null;
    return label;
  };
  const evXY = (e: ThreeEvent<PointerEvent>): { x: number; y: number } => {
    const n = e.nativeEvent || e;
    return { x: n.clientX || 0, y: n.clientY || 0 };
  };

  const lmTile = lm ? tiles.filter((t) => t.name === shotTarget(lm, g))[0] : undefined;
  const hoverTile = hover ? pickTiles.filter((t) => t.name === hover.t)[0] : undefined;
  const ringAt = placing ? null : !aimMode && hover && hoverTile ? { tile: hoverTile, label: hover.c } : aimTile && aim ? { tile: aimTile, label: aim } : null;
  /* the hull being placed, at the hovered cell (desktop) or the aimed one */
  const ownTile = placing ? tiles.filter((t) => t.own)[0] : undefined;
  const ghostAt = placing && placing.size > 0 && ownTile ? (!aimMode && hover ? hover.c : aim) : null;
  const ghostCells = ghostAt && placing ? shipCells(ghostAt, placing.orient, placing.size, w, h) : null;
  const ghostOk = !!(ghostCells && placing && ghostCells.every((c) => !placing.occupied.has(c)));
  const ringHot = !!(ringAt && ringAt.tile.canFire);

  return (
    <>
      <FirstFrame onReady={onReady} />
      <Ticker fps={q.ambientFps} />
      <JuiceRig ctl={ctl} />
      {/* the fog takes the sky's colour at the horizon (its glow included),
          so the far sea melts into the sky with no dark seam */}
      <fog attach="fog" args={[BS_HAZE, cd * 1.9, cd * 4.6]} />
      <color attach="background" args={[BS_FOG]} />
      <SkyDome spec={BS_SKY} />
      {/* dusk light: a cool sky over warm-tinted water, the low sun's
          warm light raking in from the far left (rim light on the
          hulls), and a soft front fill so the ships read as painted
          steel from the player's side, not as silhouettes */}
      <hemisphereLight args={["#b8c4ee", "#3b3142", 1.25]} />
      <directionalLight position={[BS_SUN[0] * 30, BS_SUN[1] * 30 + 2, BS_SUN[2] * 30]} intensity={2.2} color="#ffb47a" />
      <directionalLight position={[14, 16, 12]} intensity={0.9} color="#dfe6ff" />
      <ambientLight intensity={0.35} />
      <CameraControls ref={ctl} makeDefault minDistance={6} maxDistance={80} maxPolarAngle={1.38} />
      <TouchControls ctl={ctl} />
      <Framer home={home} ctl={ctl} homeRef={homeRef} />
      <Intro ctl={ctl} homeRef={homeRef} enabled={intro && !still} ready={ready} />
      <group ref={world}>
        {/* the sea: real waves, calm over the boards (ocean.tsx) */}
        <Ocean store={ocean} look={BS_OCEAN} lite={q.lite} still={still} />
        {(() => {
          /* Effects are gathered across the shown oceans and drawn
             batched (FireSystem, GlowField, FlatField): one draw per
             kind instead of one per fire, pool, marker or cell. */
          const fires: FireSpec[] = [];
          const glows: GlowSpec[] = [];
          const misses: Spot[] = [];
          const feet: Spot[] = [];
          const slicks: { x: number; z: number; r: number; s: number }[] = [];
          const debris: Debris[] = [];
          let lights = 0;
          const groups = tiles.map((tile) => {
            const shipEls: ReactElement[] = [];
            tile.ships.forEach((s) => {
              const c0 = s.cells[0] ?? "A1";
              const cN = s.cells[s.cells.length - 1] ?? c0;
              const first = cellLocal(c0, w, h);
              const last = cellLocal(cN, w, h);
              const center = { x: tile.cx + (first.x + last.x) / 2, z: tile.cz + (first.z + last.z) / 2 };
              const vertical = c0[0] === cN[0] && s.cells.length > 1;
              // where along the hull each shell struck (local x, bow +x)
              const localX = (c: string) => {
                const l = cellLocal(c, w, h);
                return vertical ? -(tile.cz + l.z - center.z) : tile.cx + l.x - center.x;
              };
              const deckY = shipGeometry(s.size, s.variant).D;
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
                  hitXs={s.sunk ? s.cells.map(localX) : s.hits.map(localX)}
                />
              );
              if (!s.sunk) {
                /* A live ship is always the viewer's own (the server
                   never sends an un-sunk enemy hull): a faint footprint
                   in the captain's colour under each of its cells keeps
                   the fleet findable, as the 2D board's tinted cells do. */
                s.cells.forEach((c) => {
                  const loc = cellLocal(c, w, h);
                  feet.push({ x: tile.cx + loc.x, z: tile.cz + loc.z, hex: tile.hex });
                });
                // flames lick up out of each hole, spread along the hull
                const dir: [number, number] = vertical ? [0, 1] : [1, 0];
                s.hits.forEach((c) => {
                  const loc = cellLocal(c, w, h);
                  fires.push({ key: tile.name + ":h:" + c, x: tile.cx + loc.x, y: deckY - 0.04, z: tile.cz + loc.z, scale: 0.8, light: false, spread: 0.3, dir, kind: "ship", heat: heatAt(tile.name, c) });
                });
                // a holed hull bleeds oil
                if (s.hits.length) slicks.push({ x: center.x, z: center.z, r: 0.25 + 0.15 * s.hits.length, s: 0.7 });
              } else {
                glows.push({ x: center.x, y: 0.03, z: center.z, r: s.size * 0.42, a: 0.2 });
                slicks.push({ x: center.x, z: center.z, r: 0.45 + s.size * 0.22, s: 0.9 });
                for (let k = 0; k < 6 + s.size; k++) {
                  const key = s.key + ":" + k;
                  const along = (hash01(key + "a") - 0.5) * (s.size + 1.2);
                  const off = (hash01(key + "b") - 0.5) * 1.5;
                  debris.push({
                    x: center.x + (vertical ? off : along),
                    z: center.z + (vertical ? along : off),
                    s: 0.08 + hash01(key + "s") * 0.14,
                    r: hash01(key + "r"),
                    k: key,
                  });
                }
                const idxs = s.size >= 4 ? [0, Math.floor(s.cells.length / 2), s.cells.length - 1] : [0, s.cells.length - 1];
                // the wreck burns at the heat of its sinking shot - the
                // most recent strike on that hull
                const wreckHeat = Math.max(...s.cells.map((cc) => heatAt(tile.name, cc)));
                idxs.forEach((ci, fi) => {
                  const cell = s.cells[ci];
                  if (!cell) return;
                  const loc = cellLocal(cell, w, h);
                  const light = lights < 3 && fi === 0;
                  if (fi === 0) lights++;
                  // burning on the water around the wreck, not in the air
                  fires.push({
                    key: tile.name + ":w:" + s.key + ":" + ci,
                    x: tile.cx + loc.x,
                    y: 0.06,
                    z: tile.cz + loc.z,
                    scale: 1.05,
                    light,
                    spread: 0.45,
                    dir: vertical ? [0, 1] : [1, 0],
                    kind: "wreck",
                    heat: wreckHeat,
                  });
                });
              }
            });
            tile.water.forEach((m) => {
              const loc = cellLocal(m.label, w, h);
              const x = tile.cx + loc.x;
              const z = tile.cz + loc.z;
              if (m.result === "hit") {
                // burning oil on the water where an unseen hull was holed
                fires.push({ key: tile.name + ":x:" + m.label, x, y: 0.05, z, scale: 0.85, light: false, spread: 0.26, kind: "water", heat: heatAt(tile.name, m.label) });
                glows.push({ x, y: 0.035, z, r: 0.6, a: 0.33 });
                slicks.push({ x, z, r: 0.32, s: 0.55 });
              } else misses.push({ x, z });
            });
            return (
              <group key={tile.name}>
                <group userData={NOMIR}>
                  <GridHolo tile={tile} w={w} h={h} />
                  {/* the ping marks the rival it names (a free-for-all's
                      leader), else every ocean but the pinged captain's */}
                  {sonar && (sonar.target ? tile.name === sonar.target : tile.name !== sonar.for) ? (
                    <group position={[0, 0, tile.cz]}>
                      <SonarBand tile={tile} w={w} h={h} sonar={sonar} />
                    </group>
                  ) : null}
                  {lm && lmTile === tile ? (
                    <LastShotRing x={tile.cx + cellLocal(lm.cell, w, h).x} z={tile.cz + cellLocal(lm.cell, w, h).z} />
                  ) : null}
                </group>
                {shipEls}
              </group>
            );
          });
          return (
            <OceanCtx.Provider value={ocean}>
              <group userData={NOMIR}>
                {/* a faint tint in the captain's colour under their own hulls
                    (the lit rims on the ships carry identity now; a strong
                    tint read as orange slabs under every hull) */}
                <FlatField spots={feet} y={0.045} geometry="cell" opacity={0.07} />
                <GlowField glows={glows} />
                <FlatField spots={misses} y={0.05} geometry="ring" color="#a9c6de" opacity={0.55} />
                <FlatField spots={misses} y={0.052} geometry="dot" color="#a9c6de" opacity={0.5} />
              </group>
              {groups}
              <FireSystem fires={fires} lite={q.lite} still={still} />
              <DebrisField pieces={debris} />
              {(() => {
                // oil on the water: the biggest slicks win the ten slots
                ocean.setSlicks(slicks.sort((a, b) => b.r * b.s - a.r * a.s).slice(0, 10));
                return null;
              })()}
            </OceanCtx.Provider>
          );
        })()}
        {/* a pick surface over each ocean you can aim at: a click fires
            on desktop; on touch a tap aims and the Fire button fires */}
        {pickTiles.map((pt) => (
          <mesh
            key={"pick:" + pt.name}
            userData={NOMIR}
            position={[pt.cx, 0.08, pt.cz]}
            rotation={[-Math.PI / 2, 0, 0]}
            onPointerMove={(e) => {
              if (aimMode) return;
              const label = cellFromPoint(pt, e.point);
              const was = hover ? hover.t + ":" + hover.c : "";
              if ((label ? pt.name + ":" + label : "") !== was) setHover(label ? { t: pt.name, c: label } : null);
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
              const label = cellFromPoint(pt, e.point);
              if (!label) return;
              if (aimMode) {
                if (onAim) onAim(label, pt.name);
              } else if (onFire) onFire(label, pt.name);
            }}
            onPointerLeave={() => setHover((hv) => (hv && hv.t === pt.name ? null : hv))}
          >
            <planeGeometry args={[w, h]} />
            <meshBasicMaterial transparent opacity={0} depthWrite={false} />
          </mesh>
        ))}
        {ringAt
          ? (() => {
              const loc = cellLocal(ringAt.label, w, h);
              const c = ringHot ? "#ff5a3c" : "#9fd8ef";
              return (
                <group position={[ringAt.tile.cx + loc.x, 0.07, ringAt.tile.cz + loc.z]} userData={NOMIR}>
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
        {ghostAt && ownTile && placing ? (
          <GhostHull tile={ownTile} w={w} h={h} bow={ghostAt} size={placing.size} orient={placing.orient} valid={ghostOk} />
        ) : null}
        {pending && aimTile
          ? (() => {
              const loc = cellLocal(pending, w, h);
              return <PendingMark x={aimTile.cx + loc.x} z={aimTile.cz + loc.z} />;
            })()
          : null}
        {!still
          ? anims.map((anim) => (
              <ShotFx
                key={anim.id}
                anim={anim}
                onImpact={() => {
                  juice.hit(anim.impact);
                  ocean.ripple(anim.x, anim.z, anim.result === "hit" ? 0.7 : 1);
                  const sk = anim.sink;
                  if (sk) {
                    setSinks((l) => (l.some((x) => x.id === sk.id) ? l : [...l, sk]));
                    // a ship going down heaves the water around it
                    ocean.ripple(sk.at[0], sk.at[2], 1.5);
                  }
                }}
                onDone={() => setAnims((l) => l.filter((x) => x.id !== anim.id))}
              />
            ))
          : null}
        {sinks.map((sk) => (
          <SinkFx key={sk.id} sink={sk} lite={q.lite} onDone={() => setSinks((l) => l.filter((x) => x.id !== sk.id))} />
        ))}
      </group>
      <Sparkles count={50} scale={[Math.max(30, bsLayout(allTiles.length, w, h).spanW + 6), 4, Math.max(14, bsLayout(allTiles.length, w, h).spanD + 4)]} position={[0, 2.4, 0]} size={1.5} speed={still ? 0 : 0.22} opacity={0.45} color="#7dd3fc" />
      <ArenaPost q={q} bloom={1.15} threshold={0.72} smoothing={0.3} vignette={0.55} />
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
function bsHome(w: number, h: number, aspect: number, single: boolean, n = 2): Home {
  if (single) {
    // Looking a little past the centre toward the near edge lifts the
    // ocean on screen, clearing the bottom strip where the Fire button
    // and the tap tip sit, so they do not cover the column letters.
    const f = fitHome(w + 1.4, h + 3.6, 62, 48, aspect, 1.03);
    const tz = 1.1;
    return { pos: [f.pos[0], f.pos[1], f.pos[2] + tz], fov: f.fov, tz };
  }
  if (n > 2) {
    // A free-for-all's rows: steeper, so the back row's cells don't
    // flatten to slivers, and fitted to the whole spread with labels.
    const lay = bsLayout(n, w, h);
    return fitHome(lay.spanW + 2.8, lay.spanD + 3.4, n <= 4 ? 51 : 54, aspect < 1.3 ? 56 : 46, aspect, 1.04);
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
  placing,
}: {
  g: BattleshipState;
  me: string;
  aspect?: number;
  /* target: the rival's name in a free-for-all (the shot goes out as
     "Name:Cell"); undefined for two captains */
  onFire?: (label: string, target?: string) => void;
  onReady?: () => void;
  /* fleet placement: your ocean alone, the next hull as a hologram */
  placing?: Placing;
}) {
  const still = useReducedMotion();
  const q = useQuality(still);
  const juice = useJuiceStore(still);
  const firstVisit = useFirstVisit("bs:" + String(g.id || ""));
  const [ready, setReady] = useState(false);
  const aimMode = q.lite;
  const w = g.w || 10;
  const h = g.h || 10;
  /* Placing a fleet: your ocean alone, the hulls laid so far on it. */
  const tiles = useMemo((): TileT[] => {
    if (!placing) return buildTiles(g, me);
    const meP = ((g.players || []) as BattleshipPlayer[]).filter((p) => String(p.name).toLowerCase() === String(me).toLowerCase())[0] || { name: me, hex: "#22d3ee" };
    const seen: Record<number, number> = {};
    const ships: ShipT[] = placing.placed.map((p) => {
      const cells = shipCells(p.start, p.dir, p.size, w, h) || [];
      const v = seen[p.size] || 0;
      seen[p.size] = v + 1;
      return { key: cells.join("."), size: p.size, variant: v, sunk: false, cells, hits: [] };
    });
    return [{ name: meP.name, title: placing.next ? "Your waters · place your fleet" : "Your waters · fleet ready", hex: meP.hex, cx: 0, cz: 0, ships, water: [], canFire: false, own: true }];
  }, [g, me, placing, w, h]);
  const occupied = useMemo(() => new Set(tiles.flatMap((t) => (placing ? t.ships.flatMap((s) => s.cells) : []))), [tiles, placing]);
  const ffa = tiles.length > 2;
  const player = !!(g.you && g.you.playing);
  /* The oceans a captain can aim at (two captains: the one rival; a
     free-for-all: every rival not yet a wreck) and the one aimed at
     now - the last rival picked, else the first. */
  const rivals = useMemo(() => (player ? tiles.filter((t) => !t.own && !t.wreck) : []), [tiles, player]);
  const [target, setTarget] = useState<string | null>(null);
  const foe = rivals.filter((t) => t.name === target)[0] || rivals[0];
  const canFire = !!(foe && foe.canFire);
  const taken = useMemo(() => takenOf(foe), [foe]);
  const [aim, setAim] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [say, setSay] = useState("");
  const ctl = useRef<Ctl | null>(null);
  const homeRef = useRef<Home | null>(null);

  /* The host's live size: a phone-width host shows one ocean. */
  const [hostW, setHostW] = useState(() => (aspect && aspect < 1.2 ? 390 : 700));
  const single = hostW < SINGLE_BELOW || !!placing;
  /* Which ocean a single view shows: the one you're aiming at on your
     turn, yours while you wait; a spectator sees the ocean the last
     shot landed in. A tap on the switch overrides that until the turn
     changes. */
  const lm = g.last_move as BattleshipMove | null;
  const lastShotIdx = lm ? Math.max(0, tiles.findIndex((t) => t.name === shotTarget(lm, g))) : 0;
  const foeIdx = foe ? Math.max(0, tiles.indexOf(foe)) : 1;
  /* A new shot holds the view on the ocean it landed in for a few
     seconds - you watch your shell land (or theirs hit you) before the
     view swaps to whichever ocean the turn needs. Derived during
     render, so the scene sees the right ocean on the shot's frame. */
  const lmK = lm ? lm.turn + ":" + lm.by + ":" + lm.cell : "";
  const [prevLm, setPrevLm] = useState(lmK);
  // the ocean a new shot holds the view on, and which shot (a second
  // shot into the same ocean restarts the hold)
  const [landing, setLanding] = useState<{ idx: number; shot: string } | null>(null);
  const [manualIdx, setManualIdx] = useState<number | null>(null);
  if (prevLm !== lmK) {
    setPrevLm(lmK);
    if (lmK) {
      setLanding({ idx: lastShotIdx, shot: lmK });
      // a new shot ends a manual peek: the view goes where the shell lands
      // (a spectator's choice used to stick for the rest of the view)
      setManualIdx(null);
    }
  }
  useEffect(() => {
    if (landing === null) return;
    // long enough for the shell, a sinking and its slow motion
    const t = setTimeout(() => setLanding(null), 4600);
    return () => clearTimeout(t);
  }, [landing]);
  const autoIdx = landing !== null ? landing.idx : player ? (canFire ? foeIdx : 0) : lastShotIdx;
  // the turn moving on ends a manual peek too
  const [prevFire, setPrevFire] = useState(canFire);
  if (prevFire !== canFire) {
    setPrevFire(canFire);
    setManualIdx(null);
  }
  // the landing hold wins over a manual pick: the shot must be seen
  const shownIdx = Math.min(tiles.length - 1, landing !== null ? landing.idx : manualIdx ?? autoIdx);
  const shownTile = tiles[shownIdx];
  const shown = useMemo(() => {
    if (!single) return tiles;
    const t = tiles[shownIdx];
    // Nudged right so the ocean plus its row-number column (west of
    // it) sits centred under the camera.
    return t ? [{ ...t, cx: 0.45, cz: 0 }] : [];
  }, [tiles, single, shownIdx]);
  // a single view's Fire button and tip belong to the ocean you aim at
  const foeShown = !single || !!(shownTile && foe && shownTile.name === foe.name);

  const home = (a: number, width: number) => bsHome(w, h, a, width < SINGLE_BELOW || !!placing, tiles.length);
  const first = home(aspect ?? 1.44, hostW);
  const cd = Math.hypot(first.pos[1], first.pos[2]);

  /* The in-flight marker clears when the shot lands in state, when
     the turn moves on, or after 10 s (a refused shot changes nothing
     in state; its error shows in the arena's note). */
  if (pending && (taken.has(pending) || !canFire)) setPending(null);
  useEffect(() => {
    if (!pending) return;
    const t = setTimeout(() => setPending(null), 10000);
    return () => clearTimeout(t);
  }, [pending]);

  /* Spoken updates for screen readers: each new shot, and the start
     of your turn. Nothing is announced for the state at open. */
  const [heard, setHeard] = useState({ lm: lmK, turn: canFire });
  if (heard.lm !== lmK || heard.turn !== canFire) {
    const parts: string[] = [];
    if (lm && lmK && lmK !== heard.lm)
      parts.push(
        lm.by + " fired at " + (ffa ? shotTarget(lm, g) + "'s " : "") + lm.cell + ": " + (lm.result === "hit" ? (lm.sunk ? "hit, and a " + lm.sunk + "-ship sank" : "hit") : "miss") + "."
      );
    if (canFire && !heard.turn) parts.push("Your shot.");
    setHeard({ lm: lmK, turn: canFire });
    if (parts.length) setSay(parts.join(" "));
  }

  const where = (t: TileT | undefined, label: string) => (ffa && t ? t.name + "'s " : "") + label;
  const describe = (label: string, t: TileT | undefined) => {
    const tk = t === foe ? taken : takenOf(t);
    return where(t, label) + ", " + (tk.has(label) ? "already " + tk.get(label) : "open water") + (canFire ? "" : ", not your turn") + ".";
  };
  const tileNamed = (name?: string) => (name ? rivals.filter((t) => t.name === name)[0] : foe);
  const orientWord = (o: string) => (o === "V" ? "vertical" : "horizontal");
  /* Placement: what the next hull would do from a bow cell. */
  const describePlace = (label: string) => {
    if (!placing || !placing.next) return "Fleet complete - send it with Place this fleet.";
    const cells = shipCells(label, placing.orient, placing.next, w, h);
    const what = "your " + placing.next + "-ship, " + orientWord(placing.orient);
    if (!cells) return label + ": " + what + ", runs off the board.";
    if (cells.some((c) => occupied.has(c))) return label + ": " + what + ", overlaps a hull already down.";
    return label + ": " + what + ", fits.";
  };
  const placeAt = (label: string) => {
    if (!placing) return;
    if (!placing.next) {
      setSay("Fleet complete - send it with Place this fleet.");
      return;
    }
    const cells = shipCells(label, placing.orient, placing.next, w, h);
    const ok = !!(cells && cells.every((c) => !occupied.has(c)));
    setSay(ok ? "Placed your " + placing.next + "-ship at " + label + ", " + orientWord(placing.orient) + "." : describePlace(label));
    if (ok && aimMode) setAim(null);
    placing.onPlace(label);
  };
  const fire = (label: string, name?: string) => {
    if (placing) {
      placeAt(label);
      return;
    }
    const t = tileNamed(name);
    if (!canFire || !onFire || !t || !t.canFire) {
      setSay("Not your turn yet.");
      return;
    }
    const tk = t === foe ? taken : takenOf(t);
    if (tk.has(label)) {
      setSay(where(t, label) + " is already " + tk.get(label) + ".");
      return;
    }
    setTarget(t.name);
    setPending(label);
    if (aimMode) setAim(null);
    setSay("Firing at " + where(t, label) + ".");
    onFire(label, ffa ? t.name : undefined);
  };
  const aimAt = (label: string, name?: string) => {
    if (placing) {
      setAim(label);
      setSay(describePlace(label));
      return;
    }
    const t = tileNamed(name);
    if (!t) return;
    if (t !== foe) setTarget(t.name);
    setAim(label);
    setSay(describe(label, t));
  };
  /* Keyboard play: arrow keys move an aim marker over the enemy
     ocean (row 1 is the far edge, as on screen), Enter or Space
     fires at it. In a free-for-all an arrow past the left or right
     edge crosses to the previous or next rival. In a single-ocean
     view the aimed ocean comes up. */
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const k = e.key;
    if (placing) {
      if (k === "r" || k === "R") {
        e.preventDefault();
        setSay("The next hull lies " + orientWord(placing.orient === "H" ? "V" : "H") + ".");
        placing.onRotate();
        return;
      }
      if (k === "Backspace" || k === "Delete") {
        e.preventDefault();
        if (placing.placed.length) setSay("Took your " + placing.placed[placing.placed.length - 1]!.size + "-ship back.");
        placing.onUndo();
        return;
      }
      const cur = aim ? labelXY(aim) : { col: Math.floor((w - 1) / 2), row: Math.floor((h - 1) / 2) };
      let col = cur.col;
      let row = cur.row;
      if (k === "ArrowLeft") col--;
      else if (k === "ArrowRight") col++;
      else if (k === "ArrowUp") row--;
      else if (k === "ArrowDown") row++;
      else if (k === "Enter" || k === " ") {
        e.preventDefault();
        const label = String.fromCharCode(65 + col) + (row + 1);
        if (aim) placeAt(label);
        else aimAt(label);
        return;
      } else return;
      e.preventDefault();
      col = Math.max(0, Math.min(w - 1, col));
      row = Math.max(0, Math.min(h - 1, row));
      aimAt(String.fromCharCode(65 + col) + (row + 1));
      return;
    }
    if (!foe) return;
    const cur = aim ? labelXY(aim) : { col: Math.floor((w - 1) / 2), row: Math.floor((h - 1) / 2) };
    let col = cur.col;
    let row = cur.row;
    let tName = foe.name;
    const cross = (d: number) => {
      const i = rivals.indexOf(foe);
      tName = rivals[(i + d + rivals.length) % rivals.length]!.name;
    };
    if (k === "ArrowLeft") {
      if (ffa && col <= 0 && rivals.length > 1) {
        cross(-1);
        col = w - 1;
      } else col--;
    } else if (k === "ArrowRight") {
      if (ffa && col >= w - 1 && rivals.length > 1) {
        cross(1);
        col = 0;
      } else col++;
    } else if (k === "ArrowUp") row--;
    else if (k === "ArrowDown") row++;
    else if (k === "Enter" || k === " ") {
      e.preventDefault();
      if (single) setManualIdx(foeIdx);
      const label = String.fromCharCode(65 + col) + (row + 1);
      if (aim) fire(label);
      else aimAt(label);
      return;
    } else return;
    e.preventDefault();
    if (single) setManualIdx(Math.max(0, tiles.findIndex((t) => t.name === tName)));
    col = Math.max(0, Math.min(w - 1, col));
    row = Math.max(0, Math.min(h - 1, row));
    aimAt(String.fromCharCode(65 + col) + (row + 1), tName);
  };

  /* Show ocean i; picking a live rival's ocean makes it your target. */
  const pickOcean = (i: number) => {
    setManualIdx(i);
    const t = tiles[i];
    if (player && t && !t.own && !t.wreck && foe && t.name !== foe.name) {
      setTarget(t.name);
      setAim(null);
    }
  };
  /* Leaving for the frame's own buttons (Fire, Place, the ocean switch)
     keeps the aim; leaving the arena drops it. A repaint of the page
     detaches the scene and hands focus straight back (games.ts
     bsScene), so the check waits a tick: focus that came back is not
     a leave. */
  const blurOut = (frame: HTMLElement, to: Node | null) => {
    if (to && frame.contains(to)) return;
    setTimeout(() => {
      if (!frame.contains(document.activeElement)) setAim(null);
    }, 0);
  };
  const names = tiles.map((t) => t.name);
  const spectatorLabel =
    "Battleship, 3D view of " + (names.length > 2 ? names.slice(0, -1).map((n) => n + "'s").join(", ") + " and " + names[names.length - 1] + "'s" : names.map((n) => n + "'s").join(" and ")) + " waters.";
  const intro = firstVisit ? { title: ffa ? "Battleship free-for-all" : "Battleship", sub: names.join(ffa ? " · " : " vs ") || "Fleets at sea", color: "#2dd4bf" } : null;
  const overlay = (
    <>
      {single && tiles.length > 2 && shownTile ? (
        /* 3-6 oceans: one compact cycler (a pill each ran under the
           frame's tools on a phone) */
        <div className="arena3d-swap arena3d-cycle" role="group" aria-label="Which ocean to show">
          <button type="button" aria-label="Previous ocean" onClick={() => pickOcean((shownIdx - 1 + tiles.length) % tiles.length)}>
            ‹
          </button>
          <span className={"arena3d-cycle-name" + (shownTile.wreck ? " wreck" : "")} aria-live="polite">
            <span className="arena3d-swap-dot" style={{ background: shownTile.wreck ? "#6b7280" : shownTile.hex }} />
            {shownTile.own ? "Yours" : shownTile.name}
            <span className="arena3d-cycle-n">
              {shownIdx + 1}/{tiles.length}
            </span>
          </span>
          <button type="button" aria-label="Next ocean" onClick={() => pickOcean((shownIdx + 1) % tiles.length)}>
            ›
          </button>
        </div>
      ) : single && tiles.length > 1 ? (
        <div className="arena3d-swap" role="group" aria-label="Which ocean to show">
          {tiles.map((t, i) => (
            <button key={t.name} type="button" aria-pressed={i === shownIdx} className={i === shownIdx ? "on" : ""} onClick={() => pickOcean(i)}>
              <span className="arena3d-swap-dot" style={{ background: t.hex }} />
              {player ? (i === 0 ? "Yours" : t.name + "'s") : t.name + "'s"}
              {player && i === 1 && canFire ? " · fire" : ""}
            </button>
          ))}
        </div>
      ) : null}
      {placing && aimMode && placing.next && aim ? (
        <button type="button" className="arena3d-fire arena3d-place" onClick={() => placeAt(aim)}>
          Place {placing.next}-ship at {aim}
        </button>
      ) : null}
      {placing && aimMode && placing.next && !aim ? <div className="arena3d-tip">Tap a cell for the bow</div> : null}
      {aimMode && canFire && aim && !taken.has(aim) && foeShown ? (
        <button type="button" className="arena3d-fire" onClick={() => fire(aim)}>
          Fire at {where(foe, aim)}
        </button>
      ) : null}
      {aimMode && canFire && !aim && !pending && (!single || !!(shownTile && shownTile.canFire)) ? (
        <div className="arena3d-tip">{ffa && !single ? "Tap a rival's cell to aim" : "Tap a cell to aim"}</div>
      ) : null}
      {foe || placing ? (
        <div className="sr-only" aria-live="polite">
          {say}
        </div>
      ) : null}
      <ImpactLayer juice={juice} intro={intro} ready={ready} />
    </>
  );
  return (
    <JuiceProvider juice={juice}>
    <ArenaFrame
      onReset={() => goHome(ctl, homeRef.current || first, !still)}
      onSize={(width) => setHostW(width)}
      overlay={overlay}
      tools={<SoundToggle />}
      frameProps={
        placing
          ? {
              tabIndex: 0,
              role: "application",
              "aria-label":
                "Battleship, 3D view. Your waters - place your fleet: arrow keys move the next hull's bow, R rotates it, Enter places it, Backspace takes the last one back.",
              onKeyDown: onKey,
              onBlur: (e) => blurOut(e.currentTarget, e.relatedTarget as Node | null),
            }
          : foe
          ? {
              tabIndex: 0,
              role: "application",
              "aria-label":
                "Battleship, 3D view. " +
                foe.name +
                "'s waters: arrow keys aim, Enter fires." +
                (ffa && rivals.length > 1 ? " Arrow past the left or right edge for the next rival." : ""),
              onKeyDown: onKey,
              onBlur: (e) => blurOut(e.currentTarget, e.relatedTarget as Node | null),
            }
          : undefined
      }
    >
      <Canvas
        role={foe || placing ? undefined : "img"}
        aria-label={foe || placing ? undefined : spectatorLabel}
        frameloop="demand"
        dpr={q.dpr}
        camera={{ position: first.pos, fov: first.fov, near: 0.1, far: 600 }}
        gl={{ antialias: !q.lite }}
      >
        <Still.Provider value={still}>
          <Scene
            g={g}
            placing={placing ? { size: placing.next, orient: placing.orient, occupied } : null}
            tiles={shown}
            allTiles={tiles}
            foeName={foe ? foe.name : null}
            onFire={foe || placing ? fire : undefined}
            onAim={foe || placing ? aimAt : undefined}
            aimMode={aimMode}
            cd={cd}
            aim={aim}
            pending={pending}
            ctl={ctl}
            home={home}
            homeRef={homeRef}
            onReady={() => {
              setReady(true);
              if (onReady) onReady();
            }}
            q={q}
            me={me}
            intro={!!intro}
            ready={ready}
          />
        </Still.Provider>
      </Canvas>
    </ArenaFrame>
    </JuiceProvider>
  );
}
