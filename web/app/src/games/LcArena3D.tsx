import { useMemo, useRef } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { CameraControls, MeshReflectorMaterial, Sparkles } from "@react-three/drei";
import { Bloom, EffectComposer, Vignette } from "@react-three/postprocessing";
import { Color } from "three";
import type * as THREE from "three";
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
} from "./arena3d";

// Light Cycles in 3D — the R3F spike (2026-11-12). Renders the same
// full game state the 2D SVG board consumes (GET /games/:id):
// g.w / g.h, g.trails as [x, y, playerIndex] cells in growth order,
// g.players[i] = { name, hex, alive, x, y }. Trails become thin,
// translucent light ribbons on a reflective floor — continuous
// walls a tire's width thick and a wheel tall, with a bright core
// line along the top edge, pouring out of the back of each light
// cycle; a wreck's ribbon fades and its last cell carries a crash
// mark, mirroring the 2D board. Loaded lazily by games.ts, so
// three.js ships in its own chunk.

/* eslint-disable @typescript-eslint/no-explicit-any */

// A light cycle built from primitives, in the rider's colour:
// hubless glowing wheel rings, a dark glossy hull, and a crouched
// rider with lit suit stripes. Modelled facing +X; the group yaws
// to the rider's heading with damped turns, and the wheels spin.
// Placement (review, 2026-11-12): the bike must never reach past its
// own cell, or open cells ahead read as taken and riders a cell apart
// look crashed. The newest trail cell IS the head cell (as on the 2D
// board), so the nose ends inside the head cell and the body lies
// back over the trail just laid; the ribbon is trimmed to end under
// the rear wheel, so the light still pours out of the back.
const HEADING_YAW: Record<string, number> = { right: 0, up: Math.PI / 2, down: -Math.PI / 2, left: Math.PI };
const BIKE_SCALE = 1.1;
const BIKE_NOSE = 1.06; // front wheel rim, in model units
const BIKE_SHIFT = 0.45 - BIKE_NOSE * BIKE_SCALE; // nose at +0.45 of the head cell
const RIBBON_TRIM = 1.3; // ribbon ends this far behind the head cell's centre

function LightCycle({ x, z, hex, dir, still }: { x: number; z: number; hex: string; dir: string; still: boolean }) {
  const group = useRef<THREE.Group>(null!);
  const wheels = useRef<(THREE.Mesh | null)[]>([]);
  const target = HEADING_YAW[dir] ?? 0;
  useFrame((state, delta) => {
    if (!group.current) return;
    if (still) {
      group.current.rotation.y = target;
      return;
    }
    // Shortest-arc damped turn toward the current heading; a turn in
    // progress asks for every frame (the ambient ticker is slower).
    let diff = target - group.current.rotation.y;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    group.current.rotation.y += diff * Math.min(1, delta * 7);
    if (Math.abs(diff) > 0.003) state.invalidate();
    const spin = delta * 5.2;
    wheels.current.forEach((w) => {
      if (w) w.rotation.z -= spin;
    });
  });
  const suit = { color: "#171e2a", roughness: 0.5, metalness: 0.35, emissive: hex, emissiveIntensity: 0.32 } as const;
  const chrome = { color: "#0a0d13", roughness: 0.32, metalness: 0.75 } as const;
  return (
    <group position={[x, 0, z]}>
      <group ref={group} rotation-y={target}>
        <group position={[BIKE_SHIFT, 0, 0]} scale={BIKE_SCALE}>
          {/* wheels: glowing hubless rings over dark discs */}
          {[0.72, -0.72].map((wx, i) => (
            <group key={i} position={[wx, 0.36, 0]}>
              <mesh
                ref={(m) => {
                  wheels.current[i] = m;
                }}
              >
                <torusGeometry args={[0.34, 0.05, 12, 36]} />
                <meshStandardMaterial color="#05070a" emissive={hex} emissiveIntensity={2.6} toneMapped={false} />
              </mesh>
              <mesh rotation-x={Math.PI / 2}>
                <cylinderGeometry args={[0.26, 0.26, 0.07, 24]} />
                <meshStandardMaterial {...chrome} />
              </mesh>
            </group>
          ))}
          {/* hull + fairing mass, faintly lit in the rider's colour */}
          <mesh position={[0, 0.52, 0]} rotation-z={Math.PI / 2} scale={[1, 1, 0.62]}>
            <capsuleGeometry args={[0.17, 0.95, 6, 14]} />
            <meshStandardMaterial color="#141a26" roughness={0.3} metalness={0.85} />
          </mesh>
          <mesh position={[0.02, 0.58, 0]} scale={[1.45, 0.4, 0.27]}>
            <sphereGeometry args={[0.5, 20, 14]} />
            <meshStandardMaterial color="#10151f" roughness={0.35} metalness={0.7} emissive={hex} emissiveIntensity={0.22} />
          </mesh>
          {[0.115, -0.115].map((lz, i) => (
            <mesh key={i} position={[0, 0.56, lz]}>
              <boxGeometry args={[0.95, 0.035, 0.018]} />
              <meshStandardMaterial color="#05070a" emissive={hex} emissiveIntensity={2.6} toneMapped={false} />
            </mesh>
          ))}
          {/* rider: crouched torso, lit stripes, helmet with a light band */}
          <group position={[-0.08, 0.86, 0]} rotation-z={-0.85}>
            <mesh>
              <capsuleGeometry args={[0.19, 0.52, 6, 14]} />
              <meshStandardMaterial {...suit} />
            </mesh>
            {[0.13, -0.13].map((lz, i) => (
              <mesh key={i} position={[0.02, 0.02, lz]}>
                <capsuleGeometry args={[0.02, 0.46, 4, 8]} />
                <meshStandardMaterial color="#05070a" emissive={hex} emissiveIntensity={2.6} toneMapped={false} />
              </mesh>
            ))}
          </group>
          <group position={[0.3, 1.06, 0]}>
            <mesh>
              <sphereGeometry args={[0.175, 20, 16]} />
              <meshStandardMaterial {...suit} />
            </mesh>
            <mesh rotation-x={Math.PI / 2}>
              <torusGeometry args={[0.168, 0.02, 8, 28]} />
              <meshStandardMaterial color="#05070a" emissive={hex} emissiveIntensity={2.8} toneMapped={false} />
            </mesh>
          </group>
        </group>
        <pointLight color={hex} intensity={22} distance={11} decay={2} position={[BIKE_SHIFT, 1.6, 0]} />
      </group>
    </group>
  );
}

// A trail, as ribbon runs: each maximal straight stretch of cells
// becomes ONE continuous wall segment (no per-cell blocks), with a
// small overhang so corners merge into clean joints. The ribbon is
// a tire's width thick (0.18) and a wheel tall (1.0), translucent,
// with a bright core strip along its top edge. trimHead shortens the
// final run from its head end (a live rider's bike covers it).
type Run = { cx: number; cz: number; len: number; axis: "x" | "z" };

function trailRuns(cells: number[][], wx: (x: number) => number, wz: (y: number) => number, trimHead: number): Run[] {
  if (!cells.length) return [];
  const runs: Run[] = [];
  const emit = (s: number, e: number, last: boolean) => {
    const a = cells[s]!;
    const b = cells[e]!;
    const ax = wx(a[0] ?? 0);
    const az = wz(a[1] ?? 0);
    let bx = wx(b[0] ?? 0);
    let bz = wz(b[1] ?? 0);
    const axis: "x" | "z" = bx !== ax ? "x" : "z";
    if (last && trimHead > 0) {
      const span = Math.abs(bx - ax) + Math.abs(bz - az);
      // A rider still on its spawn cell has no ribbon to show yet.
      if (span === 0) return;
      const t = Math.min(trimHead, span);
      if (axis === "x") bx -= Math.sign(bx - ax) * t;
      else bz -= Math.sign(bz - az) * t;
    }
    runs.push({ cx: (ax + bx) / 2, cz: (az + bz) / 2, len: Math.abs(bx - ax) + Math.abs(bz - az) + 0.24, axis });
  };
  if (cells.length === 1) {
    emit(0, 0, true);
    return runs;
  }
  let s = 0;
  let pdx = Math.sign((cells[1]![0] ?? 0) - (cells[0]![0] ?? 0));
  let pdy = Math.sign((cells[1]![1] ?? 0) - (cells[0]![1] ?? 0));
  for (let k = 2; k < cells.length; k++) {
    const dx = Math.sign((cells[k]![0] ?? 0) - (cells[k - 1]![0] ?? 0));
    const dy = Math.sign((cells[k]![1] ?? 0) - (cells[k - 1]![1] ?? 0));
    if (dx !== pdx || dy !== pdy) {
      emit(s, k - 1, false);
      s = k - 1;
      pdx = dx;
      pdy = dy;
    }
  }
  emit(s, cells.length - 1, true);
  return runs;
}

// A wreck keeps its hue and fades (opacity), as on the 2D board -
// dimming the emissive drifted pink to maroon and orange to brown,
// away from the rider's chip colour.
function Ribbon({ runs, hex, alive }: { runs: Run[]; hex: string; alive: boolean }) {
  const core = new Color(hex).lerp(new Color("#ffffff"), 0.45);
  return (
    <group>
      {runs.map((r, j) => (
        <group key={j} position={[r.cx, 0, r.cz]}>
          <mesh position={[0, 0.5, 0]}>
            <boxGeometry args={r.axis === "x" ? [r.len, 1, 0.18] : [0.18, 1, r.len]} />
            <meshStandardMaterial
              color="#04060a"
              emissive={hex}
              emissiveIntensity={alive ? 1.15 : 0.95}
              transparent
              opacity={alive ? 0.8 : 0.3}
              depthWrite={alive}
              toneMapped={false}
            />
          </mesh>
          <mesh position={[0, 0.955, 0]}>
            <boxGeometry args={r.axis === "x" ? [r.len, 0.09, 0.22] : [0.22, 0.09, r.len]} />
            <meshStandardMaterial
              color="#04060a"
              emissive={core}
              emissiveIntensity={alive ? 3.4 : 1.5}
              transparent
              opacity={alive ? 0.95 : 0.4}
              depthWrite={alive}
              toneMapped={false}
            />
          </mesh>
        </group>
      ))}
    </group>
  );
}

// Where a rider crashed: the 2D board's ✕, on the floor of the
// wreck's last cell, in the rider's colour lifted toward white.
function CrashMark({ x, z, hex }: { x: number; z: number; hex: string }) {
  const c = useMemo(() => new Color(hex).lerp(new Color("#ffffff"), 0.35), [hex]);
  return (
    <group position={[x, 0.05, z]}>
      {[1, -1].map((s) => (
        <mesh key={s} rotation-y={(s * Math.PI) / 4}>
          <boxGeometry args={[1.05, 0.06, 0.14]} />
          <meshStandardMaterial color="#04060a" emissive={c} emissiveIntensity={2.4} toneMapped={false} />
        </mesh>
      ))}
    </group>
  );
}

// The floor grid, drawn as exact cell-edge lines. drei's <Grid> puts
// its lines on whole numbers from its centre, which runs them through
// cell centres on odd-sized boards (the server allows any width
// 12-40 and height 10-30). Sections every 5 cells from the board's
// corner; the edge - a wall, and deadly - is drawn brighter.
function BoardGrid({ w, h }: { w: number; h: number }) {
  const { cells, sections, edge } = useMemo(() => {
    const c: number[] = [];
    const s: number[] = [];
    for (let i = 1; i < w; i++) (i % 5 === 0 ? s : c).push(i - w / 2, 0.01, -h / 2, i - w / 2, 0.01, h / 2);
    for (let j = 1; j < h; j++) (j % 5 === 0 ? s : c).push(-w / 2, 0.01, j - h / 2, w / 2, 0.01, j - h / 2);
    const e = [
      -w / 2, 0.012, -h / 2, w / 2, 0.012, -h / 2,
      w / 2, 0.012, -h / 2, w / 2, 0.012, h / 2,
      w / 2, 0.012, h / 2, -w / 2, 0.012, h / 2,
      -w / 2, 0.012, h / 2, -w / 2, 0.012, -h / 2,
    ];
    return { cells: new Float32Array(c), sections: new Float32Array(s), edge: new Float32Array(e) };
  }, [w, h]);
  return (
    <group key={w + "x" + h}>
      <lineSegments>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[cells, 3]} />
        </bufferGeometry>
        <lineBasicMaterial color="#16283a" />
      </lineSegments>
      <lineSegments>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[sections, 3]} />
        </bufferGeometry>
        <lineBasicMaterial color="#2b4d63" />
      </lineSegments>
      <lineSegments>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[edge, 3]} />
        </bufferGeometry>
        <lineBasicMaterial color="#4f8fb0" />
      </lineSegments>
    </group>
  );
}

// The home framing for a host of this shape. A portrait host (a
// phone) has a much narrower horizontal field of view at the same
// vertical fov, so widen the lens and pull back or the board's edges
// fall out of frame.
function lcHome(w: number, h: number, aspect: number, width: number): Home {
  // A phone-width host is short (styles.css) and the board must fill
  // it: a steeper camera fitted to the board, so cells read as cells
  // and the steering pad stays on screen below.
  if (width < 560) return fitHome(w + 1, h + 1, 60, 46, aspect, 1.05);
  const dist = Math.max(w, h);
  const narrow = aspect < 1;
  const cd = dist * (narrow ? 1.22 : 1);
  return { pos: [0, cd * 0.74, cd * 0.9], fov: narrow ? 60 : 40 };
}

export default function LcArena3D({ g, aspect, onReady }: { g: any; aspect?: number; onReady?: () => void }) {
  const still = useReducedMotion();
  const q = useQuality(still);
  const ctl = useRef<Ctl | null>(null);
  const homeRef = useRef<Home | null>(null);
  const w = (g && g.w) || 30;
  const h = (g && g.h) || 22;
  const players: any[] = (g && g.players) || [];
  const byPlayer: number[][][] = players.map(() => []);
  ((g && g.trails) || []).forEach((c: number[]) => {
    const arr = byPlayer[c[2] ?? -1];
    if (arr) arr.push(c);
  });
  const wx = (x: number) => x - (w - 1) / 2;
  const wz = (y: number) => y - (h - 1) / 2;
  const dist = Math.max(w, h);
  const home = (a: number, width: number) => lcHome(w, h, a, width);
  const first = home(aspect || 1.4, 9999);
  const label =
    "Light Cycles board, 3D view: " +
    (players.map((p) => p.name + (p.alive ? " riding" : " out")).join(", ") || "no riders") +
    ".";
  return (
    <ArenaFrame onReset={() => goHome(ctl, homeRef.current || first, !still)}>
      <Canvas
        role="img"
        aria-label={label}
        frameloop="demand"
        dpr={q.dpr}
        gl={{ antialias: false, powerPreference: "high-performance" }}
        camera={{ position: first.pos, fov: first.fov, near: 0.1, far: 500 }}
      >
        <FirstFrame onReady={onReady} />
        <Ticker fps={q.ambientFps} />
        <color attach="background" args={["#04060d"]} />
        <fog attach="fog" args={["#04060d", dist * 2.1, dist * 4.4]} />
        <ambientLight intensity={0.7} />
        <directionalLight position={[w / 2, 18, h / 3]} intensity={0.55} color="#bfe9ff" />

        {/* The floor: dark glass over the grid - reflective on
            desktop; a plain dark floor on touch devices, where the
            reflection (a second render of the scene) costs most. */}
        <mesh rotation-x={-Math.PI / 2} position={[0, -0.02, 0]}>
          <planeGeometry args={[w + 16, h + 16]} />
          {q.lite ? (
            <meshStandardMaterial color="#05080f" roughness={0.55} metalness={0.4} />
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
            color="#04060d"
            metalness={0.5}
            mirror={0.7}
          />
          )}
        </mesh>
        <BoardGrid w={w} h={h} />

        {/* Trails: continuous light ribbons, one per rider. */}
        {players.map((p, i) => {
          const live = !!p.alive && typeof p.x === "number";
          const runs = trailRuns(byPlayer[i] || [], wx, wz, live ? RIBBON_TRIM : 0);
          if (!runs.length) return null;
          return <Ribbon key={String(g.id) + ":" + i} runs={runs} hex={p.hex} alive={!!p.alive} />;
        })}

        {/* Crash marks where wrecks end. */}
        {players.map((p, i) => {
          if (p.alive) return null;
          const cells = byPlayer[i] || [];
          const last = cells[cells.length - 1];
          if (!last) return null;
          return <CrashMark key={"x" + i} x={wx(last[0] ?? 0)} z={wz(last[1] ?? 0)} hex={p.hex} />;
        })}

        {/* Live riders, on actual light cycles. Heading comes from
            the state when it carries one, else from the last two
            trail cells. */}
        {players.map((p, i) => {
          if (!p.alive || typeof p.x !== "number") return null;
          let dir = typeof p.dir === "string" ? p.dir : "";
          const cells = byPlayer[i] || [];
          if (!(dir in HEADING_YAW) && cells.length >= 2) {
            const a = cells[cells.length - 2]!;
            const b = cells[cells.length - 1]!;
            const dx = (b[0] ?? 0) - (a[0] ?? 0);
            const dy = (b[1] ?? 0) - (a[1] ?? 0);
            dir = dx > 0 ? "right" : dx < 0 ? "left" : dy > 0 ? "down" : "up";
          }
          return (
            <LightCycle key={"h" + i} x={wx(p.x)} z={wz(p.y)} hex={p.hex} dir={dir in HEADING_YAW ? dir : "right"} still={still} />
          );
        })}

        <Sparkles count={70} scale={[w + 8, 5, h + 8]} position={[0, 2.6, 0]} size={2.2} speed={still ? 0 : 0.25} opacity={0.55} color="#7dd3fc" />

        <CameraControls ref={ctl} makeDefault minDistance={7} maxDistance={140} maxPolarAngle={Math.PI / 2.15} />
        <TouchControls ctl={ctl} />
        <Framer home={home} ctl={ctl} homeRef={homeRef} />

        <EffectComposer multisampling={q.msaa}>
          <>
            <Bloom mipmapBlur intensity={1.25} luminanceThreshold={1} luminanceSmoothing={0.25} />
            <Vignette offset={0.2} darkness={0.58} />
          </>
        </EffectComposer>
      </Canvas>
    </ArenaFrame>
  );
}
