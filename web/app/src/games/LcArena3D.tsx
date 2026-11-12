import { useRef } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { CameraControls, Grid, Instance, Instances, MeshReflectorMaterial, Sparkles } from "@react-three/drei";
import { Bloom, EffectComposer, Vignette } from "@react-three/postprocessing";
import type * as THREE from "three";

// Light Cycles in 3D — the R3F spike (2026-11-12). Renders the same
// full game state the 2D SVG board consumes (GET /games/:id):
// g.w / g.h, g.trails as [x, y, playerIndex] cells in growth order,
// g.players[i] = { name, hex, alive, x, y }. Trails become glowing
// walls on a reflective floor; live heads burn brighter and carry a
// point light each; a wreck's wall dims, mirroring the 2D board's
// opacity language. Loaded lazily by games.ts behind the arena's
// 2D/3D toggle, so three.js ships in its own chunk and the chat app
// pays for it only when a viewer asks for the 3D board.

/* eslint-disable @typescript-eslint/no-explicit-any */

function Head({ x, z, hex }: { x: number; z: number; hex: string }) {
  const ref = useRef<THREE.Mesh>(null!);
  useFrame(({ clock }) => {
    if (!ref.current) return;
    const s = 1 + Math.sin(clock.elapsedTime * 4) * 0.06;
    ref.current.scale.set(s, 1, s);
  });
  return (
    <group position={[x, 0, z]}>
      <mesh ref={ref} position={[0, 0.31, 0]}>
        <boxGeometry args={[0.96, 0.62, 0.96]} />
        <meshStandardMaterial color="#0b0f16" emissive={hex} emissiveIntensity={3} toneMapped={false} />
      </mesh>
      <pointLight color={hex} intensity={16} distance={9} decay={2} position={[0, 1.15, 0]} />
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
      <ambientLight intensity={0.5} />
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
            <boxGeometry args={[0.92, 0.5, 0.92]} />
            <meshStandardMaterial
              color="#04060a"
              emissive={p.hex}
              emissiveIntensity={p.alive ? 2.2 : 0.45}
              toneMapped={false}
            />
            {cells.map((c, j) => (
              <Instance key={j} position={[wx(c[0] ?? 0), 0.25, wz(c[1] ?? 0)]} />
            ))}
          </Instances>
        );
      })}

      {/* Live heads. */}
      {players.map((p, i) =>
        p.alive && typeof p.x === "number" ? <Head key={"h" + i} x={wx(p.x)} z={wz(p.y)} hex={p.hex} /> : null
      )}

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
