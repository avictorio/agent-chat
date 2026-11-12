import { useRef } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { CameraControls, Grid, Instance, Instances, MeshReflectorMaterial, Sparkles } from "@react-three/drei";
import { Bloom, EffectComposer, Vignette } from "@react-three/postprocessing";
import type * as THREE from "three";

// Light Cycles in 3D — the R3F spike (2026-11-12). Renders the same
// full game state the 2D SVG board consumes (GET /games/:id):
// g.w / g.h, g.trails as [x, y, playerIndex] cells in growth order,
// g.players[i] = { name, hex, alive, x, y }. Trails become glowing
// walls on a reflective floor; each live rider sits on a light
// cycle built from primitives (glowing hubless wheels, lit rider),
// and a wreck's wall dims, mirroring the 2D board's opacity
// language. Loaded lazily by games.ts behind the arena's
// 2D/3D toggle, so three.js ships in its own chunk and the chat app
// pays for it only when a viewer asks for the 3D board.

/* eslint-disable @typescript-eslint/no-explicit-any */

// A light cycle built from primitives, in the rider's colour:
// hubless glowing wheel rings, a dark glossy hull, and a crouched
// rider with lit suit stripes. Modelled facing +X; the group yaws
// to the rider's heading with damped turns, and the wheels spin.
// Length ~2.2 cells, so the bike straddles its head cell and the
// trail cell behind it — it reads as emerging from its own ribbon.
const HEADING_YAW: Record<string, number> = { right: 0, up: Math.PI / 2, down: -Math.PI / 2, left: Math.PI };

function LightCycle({ x, z, hex, dir }: { x: number; z: number; hex: string; dir: string }) {
  const group = useRef<THREE.Group>(null!);
  const wheels = useRef<(THREE.Mesh | null)[]>([]);
  const target = HEADING_YAW[dir] ?? 0;
  useFrame((_, delta) => {
    if (!group.current) return;
    // Shortest-arc damped turn toward the current heading.
    let diff = target - group.current.rotation.y;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    group.current.rotation.y += diff * Math.min(1, delta * 7);
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
        {/* Shifted forward along the heading so the newest trail
            cell sits under the rear wheel: the light stream comes
            out of the back of the bike, like the films. */}
        <group position={[0.95, 0, 0]} scale={1.45}>
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
        <pointLight color={hex} intensity={22} distance={11} decay={2} position={[0.95, 1.6, 0]} />
      </group>
    </group>
  );
}

export default function LcArena3D({ g, aspect }: { g: any; aspect?: number }) {
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
  // A portrait host (a phone) has a much narrower horizontal field
  // of view at the same vertical fov, so widen the lens and pull
  // back or the board's edges fall out of frame.
  const narrow = (aspect || 1.4) < 1;
  const cd = dist * (narrow ? 1.22 : 1);
  return (
    <Canvas
      dpr={[1, 1.75]}
      gl={{ antialias: false, powerPreference: "high-performance" }}
      camera={{ position: [0, cd * 0.74, cd * 0.9], fov: narrow ? 60 : 40, near: 0.1, far: 500 }}
    >
      <color attach="background" args={["#04060d"]} />
      <fog attach="fog" args={["#04060d", dist * 2.1, dist * 4.4]} />
      <ambientLight intensity={0.7} />
      <directionalLight position={[w / 2, 18, h / 3]} intensity={0.55} color="#bfe9ff" />

      {/* The floor: dark glass over the grid. */}
      <mesh rotation-x={-Math.PI / 2} position={[0, -0.02, 0]}>
        <planeGeometry args={[w + 16, h + 16]} />
        <MeshReflectorMaterial
          blur={[280, 60]}
          resolution={1024}
          mixBlur={0.9}
          mixStrength={7}
          roughness={0.92}
          depthScale={1.1}
          minDepthThreshold={0.4}
          maxDepthThreshold={1.4}
          color="#04060d"
          metalness={0.5}
          mirror={0.55}
        />
      </mesh>
      <Grid
        position={[0, 0.01, 0]}
        args={[w, h]}
        cellSize={1}
        cellThickness={0.55}
        cellColor="#123a4d"
        sectionSize={5}
        sectionThickness={1.15}
        sectionColor="#0e7490"
        fadeDistance={dist * 2.1}
        fadeStrength={1.4}
        followCamera={false}
        infiniteGrid={false}
      />

      {/* Trails: one instanced wall run per rider. */}
      {players.map((p, i) => {
        const cells = byPlayer[i] || [];
        if (!cells.length) return null;
        return (
          <Instances key={String(g.id) + ":" + i} limit={Math.max(1, cells.length)} frustumCulled={false}>
            <boxGeometry args={[0.92, 0.72, 0.92]} />
            <meshStandardMaterial
              color="#04060a"
              emissive={p.hex}
              emissiveIntensity={p.alive ? 2.2 : 0.45}
              toneMapped={false}
            />
            {cells.map((c, j) => (
              <Instance key={j} position={[wx(c[0] ?? 0), 0.36, wz(c[1] ?? 0)]} />
            ))}
          </Instances>
        );
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
        return <LightCycle key={"h" + i} x={wx(p.x)} z={wz(p.y)} hex={p.hex} dir={dir in HEADING_YAW ? dir : "right"} />;
      })}

      <Sparkles count={70} scale={[w + 8, 5, h + 8]} position={[0, 2.6, 0]} size={2.2} speed={0.25} opacity={0.55} color="#7dd3fc" />

      <CameraControls makeDefault minDistance={7} maxDistance={140} maxPolarAngle={Math.PI / 2.15} />

      <EffectComposer multisampling={2}>
        <>
          <Bloom mipmapBlur intensity={1.25} luminanceThreshold={1} luminanceSmoothing={0.25} />
          <Vignette offset={0.2} darkness={0.58} />
        </>
      </EffectComposer>
    </Canvas>
  );
}
