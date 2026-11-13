/* World atmosphere for the 3D arenas (2026-11-13): a procedural sky
   dome, an endless floor grid, and the transient effects (bursts,
   shockwaves, light pillars) the big moments use.

   Each arena is its own world, so entering one should feel like
   arriving somewhere: the sky is one draw (a shader on a big sphere,
   no textures), carries the world's palette - a horizon glow the fog
   melts into, stars, slow aurora curtains, a striped synthwave sun,
   or a turning nebula - and moves slowly enough to read as alive
   without pulling the eye from the board. Reduced motion freezes it
   (uTime stops advancing).

   The transient effects run on the juice clock (juice.tsx), so they
   freeze in a hit-stop and crawl in slow motion with everything else,
   and request frames while they run (frameloop "demand"). */
import { useLayoutEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { AdditiveBlending, BackSide, CanvasTexture, Color, DoubleSide, Group, InstancedMesh, Mesh, Object3D, ShaderMaterial, Vector3, type MeshBasicMaterial } from "three";
import { useJuice } from "./juice";

export type SkySpec = {
  top: string;
  mid: string;
  horizon: string;
  ground: string;
  glow: string;
  glowAmt?: number;
  stars?: number; // 0..~0.12: share of sky cells holding a star
  aurora?: number;
  auroraA?: string;
  auroraB?: string;
  swirl?: number;
  sun?: { size: number; az: number; el: number; a: string; b: string };
  /* a soft moon disc with a halo, in a world direction (the Battleship
     water's glitter path comes from the same direction) */
  moon?: { dir: [number, number, number]; size: number; color: string };
};

const SKY_V = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position = p.xyww;
}`;

const SKY_F = /* glsl */ `
uniform float uTime;
uniform vec3 uTop, uMid, uHorizon, uGround, uGlow, uAuroraA, uAuroraB, uSunA, uSunB;
uniform float uGlowAmt, uStars, uAurora, uSwirl, uSunSize, uSunAz, uSunEl, uMoonSize;
uniform vec3 uMoonDir, uMoonCol;
varying vec3 vDir;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float fbm(vec2 p) {
  float a = 0.5, s = 0.0;
  for (int i = 0; i < 4; i++) { s += a * noise(p); p *= 2.03; a *= 0.5; }
  return s;
}
void main() {
  vec3 d = normalize(vDir);
  float el = d.y;
  float az = atan(d.x, d.z);
  vec3 col = el > 0.0 ? mix(uHorizon, uMid, smoothstep(0.0, 0.28, el)) : mix(uHorizon, uGround, smoothstep(0.0, 0.1, -el));
  col = mix(col, uTop, smoothstep(0.28, 0.95, el));
  col += uGlow * exp(-abs(el) * 11.0) * uGlowAmt;
  if (uStars > 0.0 && el > 0.015) {
    // stars on a 3D lattice over the sphere: no seam where azimuth wraps
    vec3 sp = d * 90.0;
    vec3 cell = floor(sp);
    vec3 f = fract(sp) - 0.5;
    float h = hash(cell.xy + cell.z * 17.31);
    vec3 jit = (vec3(hash(cell.xy + 3.1 + cell.z), hash(cell.yz + 7.7), hash(cell.zx + 1.3)) - 0.5) * 0.6;
    float star = step(1.0 - uStars, h) * smoothstep(0.12, 0.0, length(f - jit));
    float tw = 0.55 + 0.45 * sin(uTime * (0.8 + h * 3.0) + h * 50.0);
    col += vec3(0.8, 0.9, 1.0) * star * tw * smoothstep(0.015, 0.22, el) * (0.6 + 1.2 * fract(h * 13.0));
  }
  if (uAurora > 0.0) {
    float band = smoothstep(0.04, 0.2, el) * (1.0 - smoothstep(0.28, 0.72, el));
    vec2 hz = d.xz / max(0.2, length(d.xz));
    float n = fbm(hz * 2.2 + vec2(uTime * 0.025, el * 2.5 - uTime * 0.04));
    float curtain = pow(0.5 + 0.5 * sin(az * 7.0 + n * 7.0 + uTime * 0.12), 2.5);
    float rays = 0.55 + 0.45 * noise(hz * 45.0 + vec2(uTime * 0.3, el * 2.0));
    vec3 ac = mix(uAuroraA, uAuroraB, clamp(smoothstep(0.08, 0.5, el) + 0.35 * sin(az * 2.0 + uTime * 0.06), 0.0, 1.0));
    col += ac * band * curtain * rays * uAurora;
  }
  if (uSwirl > 0.0) {
    // a nebula turning about the zenith: domain-warped noise over the
    // sky's projection onto the ground plane (seamless all round)
    vec2 q = d.xz / (0.35 + max(el, -0.25));
    float a = uTime * 0.025;
    q = mat2(cos(a), -sin(a), sin(a), cos(a)) * q;
    float w = fbm(q * 0.7 + uTime * 0.015);
    float n1 = fbm(q * 1.5 + w * 1.8);
    float n2 = fbm(q * 2.6 - 9.0 + w);
    vec3 nc = mix(uAuroraA, uAuroraB, smoothstep(0.3, 0.7, n2));
    col += nc * pow(n1, 2.4) * uSwirl * 1.6 * smoothstep(-0.2, 0.3, el);
  }
  if (uSunSize > 0.0) {
    vec3 sd = normalize(vec3(sin(uSunAz) * cos(uSunEl), sin(uSunEl), cos(uSunAz) * cos(uSunEl)));
    float a = acos(clamp(dot(d, sd), -1.0, 1.0));
    float disc = smoothstep(uSunSize, uSunSize * 0.985, a);
    float yy = (el - uSunEl) / uSunSize;
    float cut = yy < 0.15 ? step(fract(yy * 5.0 + uTime * 0.08), 0.18 + 0.55 * clamp(-yy + 0.15, 0.0, 1.0)) : 0.0;
    vec3 sc = mix(uSunB, uSunA, smoothstep(-1.0, 1.0, yy));
    col = mix(col, sc * 1.6, disc * (1.0 - cut) * step(-0.02, el));
    col += uSunB * exp(-a * 5.0 / max(0.01, uSunSize * 4.0)) * 0.35;
  }
  if (uMoonSize > 0.0) {
    float ma = acos(clamp(dot(d, normalize(uMoonDir)), -1.0, 1.0));
    float disc = smoothstep(uMoonSize, uMoonSize * 0.86, ma);
    // a little mottling on the face, then the halo
    float face = 0.86 + 0.14 * sin(d.x * 140.0) * sin(d.y * 120.0 + 1.3);
    col = mix(col, uMoonCol * 1.7 * face, disc);
    col += uMoonCol * (exp(-ma / (uMoonSize * 2.2)) * 0.32 + exp(-ma * 5.0) * 0.08);
  }
  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}`;

export function SkyDome({ spec, radius = 300 }: { spec: SkySpec; radius?: number }) {
  const j = useJuice();
  const mat = useMemo(
    () =>
      new ShaderMaterial({
        vertexShader: SKY_V,
        fragmentShader: SKY_F,
        side: BackSide,
        depthWrite: false,
        fog: false,
        uniforms: {
          uTime: { value: 0 },
          uTop: { value: new Color() },
          uMid: { value: new Color() },
          uHorizon: { value: new Color() },
          uGround: { value: new Color() },
          uGlow: { value: new Color() },
          uAuroraA: { value: new Color() },
          uAuroraB: { value: new Color() },
          uSunA: { value: new Color() },
          uSunB: { value: new Color() },
          uGlowAmt: { value: 0 },
          uStars: { value: 0 },
          uAurora: { value: 0 },
          uSwirl: { value: 0 },
          uSunSize: { value: 0 },
          uSunAz: { value: 0 },
          uSunEl: { value: 0 },
          uMoonSize: { value: 0 },
          uMoonDir: { value: new Vector3(0, 1, 0) },
          uMoonCol: { value: new Color() },
        },
      }),
    []
  );
  useLayoutEffect(() => {
    const u = mat.uniforms as Record<string, { value: Color | number }>;
    const c = (k: string, v: string) => (u[k]!.value as Color).set(v);
    c("uTop", spec.top);
    c("uMid", spec.mid);
    c("uHorizon", spec.horizon);
    c("uGround", spec.ground);
    c("uGlow", spec.glow);
    c("uAuroraA", spec.auroraA || "#000000");
    c("uAuroraB", spec.auroraB || "#000000");
    c("uSunA", spec.sun ? spec.sun.a : "#000000");
    c("uSunB", spec.sun ? spec.sun.b : "#000000");
    u.uGlowAmt!.value = spec.glowAmt ?? 0.6;
    u.uStars!.value = spec.stars ?? 0;
    u.uAurora!.value = spec.aurora ?? 0;
    u.uSwirl!.value = spec.swirl ?? 0;
    u.uSunSize!.value = spec.sun ? spec.sun.size : 0;
    u.uSunAz!.value = spec.sun ? spec.sun.az : 0;
    u.uSunEl!.value = spec.sun ? spec.sun.el : 0;
    u.uMoonSize!.value = spec.moon ? spec.moon.size : 0;
    if (spec.moon) {
      (u.uMoonDir!.value as unknown as Vector3).set(...spec.moon.dir).normalize();
      c("uMoonCol", spec.moon.color);
    }
  }, [mat, spec]);
  useFrame(() => {
    // Sky time follows the juice clock: a slow-motion beat slows the
    // whole world, not just the effect.
    if (!j.still) (mat.uniforms.uTime as { value: number }).value = j.t;
  });
  return (
    <mesh material={mat} renderOrder={-10} frustumCulled={false}>
      <sphereGeometry args={[radius, 48, 24]} />
    </mesh>
  );
}

/* An endless neon grid beyond the arena floor, fading into the
   horizon, with a slow pulse rolling outward from the centre. */
const GRID_V = /* glsl */ `
varying vec3 vW;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vW = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;
const GRID_F = /* glsl */ `
uniform float uTime, uCell, uFade, uHole, uLine;
uniform vec2 uHalf, uOff;
uniform vec3 uA, uB;
varying vec3 vW;
void main() {
  vec2 p = (vW.xz - uOff) / uCell;
  vec2 g = abs(fract(p - 0.5) - 0.5) / fwidth(p);
  float line = 1.0 - min(min(g.x, g.y), 1.0);
  float r = length(vW.xz);
  float fade = exp(-r / uFade);
  vec2 q = abs(vW.xz) - uHalf;
  float outside = smoothstep(0.0, 2.0, max(q.x, q.y));
  float pulse = smoothstep(6.0, 0.0, abs(r - mod(uTime * 9.0, 140.0))) * 0.9;
  vec3 c = mix(uA, uB, 0.5 + 0.5 * sin(r * 0.05 - uTime * 0.2));
  gl_FragColor = vec4(c * line * (uLine + pulse) * fade * mix(uHole, 1.0, outside), 1.0);
  #include <colorspace_fragment>
}`;

export function HorizonGrid({
  half,
  off = [0, 0],
  cell = 2,
  a,
  b,
  fade = 55,
  hole = 0,
  line = 0.55,
  y = 0,
}: {
  half: [number, number];
  off?: [number, number];
  cell?: number;
  a: string;
  b: string;
  fade?: number;
  hole?: number;
  line?: number;
  /* the floor's height: the grid lies just over it */
  y?: number;
}) {
  const j = useJuice();
  const mat = useMemo(
    () =>
      new ShaderMaterial({
        vertexShader: GRID_V,
        fragmentShader: GRID_F,
        transparent: true,
        depthWrite: false,
        blending: AdditiveBlending,
        uniforms: {
          uTime: { value: 0 },
          uCell: { value: cell },
          uFade: { value: fade },
          uHole: { value: hole },
          uHalf: { value: half },
          uOff: { value: off },
          uLine: { value: line },
          uA: { value: new Color(a) },
          uB: { value: new Color(b) },
        },
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );
  useLayoutEffect(() => {
    mat.uniforms.uHalf!.value = half;
    mat.uniforms.uOff!.value = off;
    mat.uniforms.uCell!.value = cell;
    (mat.uniforms.uA!.value as Color).set(a);
    (mat.uniforms.uB!.value as Color).set(b);
  }, [mat, half[0], half[1], off[0], off[1], cell, a, b]);
  useFrame(() => {
    if (!j.still) mat.uniforms.uTime!.value = j.t;
  });
  return (
    <mesh material={mat} rotation-x={-Math.PI / 2} position={[0, y, 0]} renderOrder={-5}>
      <planeGeometry args={[420, 420]} />
    </mesh>
  );
}

/* ---------- transient effects ---------- */

const _o = new Object3D();

type BurstProps = {
  at: [number, number, number];
  hex: string;
  /* the volume the pieces start in, and how hard they fly */
  box?: [number, number, number];
  count?: number;
  power?: number;
  piece?: number;
  dur?: number;
  rise?: number;
  onDone?: () => void;
};

/* Derez: an object coming apart into glowing voxels that fly, tumble,
   shrink and go out. One instanced draw. */
export function Burst({ at, hex, box = [1.6, 0.8, 0.5], count = 70, power = 2.6, piece = 0.11, dur = 1.7, rise = 1, onDone }: BurstProps) {
  const j = useJuice();
  const ref = useRef<InstancedMesh>(null);
  const t0 = useRef<number | null>(null);
  const done = useRef(false);
  const parts = useMemo(
    () =>
      Array.from({ length: count }, () => {
        const p = [(Math.random() - 0.5) * box[0], Math.random() * box[1], (Math.random() - 0.5) * box[2]] as const;
        const len = Math.hypot(p[0], p[2]) || 1;
        const sp = power * (0.35 + Math.random() * 0.9);
        return {
          p,
          v: [(p[0] / len) * sp + (Math.random() - 0.5) * sp, (0.6 + Math.random() * 1.6) * rise * power * 0.6, (p[2] / len) * sp + (Math.random() - 0.5) * sp] as const,
          s: piece * (0.6 + Math.random() * 0.9),
          r: [Math.random() * 6, Math.random() * 6] as const,
          life: 0.55 + Math.random() * 0.45,
        };
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );
  const color = useMemo(() => new Color(hex).multiplyScalar(2.6), [hex]);
  useFrame((state) => {
    const m = ref.current;
    if (!m || done.current) return;
    if (t0.current === null) t0.current = j.t;
    const e = (j.t - t0.current) / dur;
    if (e >= 1) {
      done.current = true;
      m.visible = false;
      if (onDone) onDone();
      return;
    }
    const tt = e * dur;
    parts.forEach((pt, i) => {
      const k = Math.min(1, e / pt.life);
      const sc = pt.s * (1 - k) * (k < 0.06 ? k / 0.06 : 1);
      _o.position.set(at[0] + pt.p[0] + pt.v[0] * tt, Math.max(0.02, at[1] + pt.p[1] + pt.v[1] * tt - 2.2 * tt * tt), at[2] + pt.p[2] + pt.v[2] * tt);
      _o.rotation.set(pt.r[0] * tt * 2, pt.r[1] * tt * 2, 0);
      _o.scale.setScalar(Math.max(0.0001, sc));
      _o.updateMatrix();
      m.setMatrixAt(i, _o.matrix);
    });
    m.instanceMatrix.needsUpdate = true;
    state.invalidate();
  });
  return (
    <instancedMesh ref={ref} args={[undefined, undefined, count]} frustumCulled={false}>
      <boxGeometry args={[1, 1, 1]} />
      <meshBasicMaterial color={color} toneMapped={false} />
    </instancedMesh>
  );
}

/* A ring of light racing out over the floor. */
export function Shockwave({ at, hex, radius = 6, dur = 0.9, width = 0.12 }: { at: [number, number, number]; hex: string; radius?: number; dur?: number; width?: number }) {
  const j = useJuice();
  const ref = useRef<Mesh>(null);
  const t0 = useRef<number | null>(null);
  const color = useMemo(() => new Color(hex).multiplyScalar(2.2), [hex]);
  useFrame((state) => {
    const m = ref.current;
    if (!m) return;
    if (t0.current === null) t0.current = j.t;
    const e = (j.t - t0.current) / dur;
    if (e >= 1) {
      m.visible = false;
      return;
    }
    const k = 1 - (1 - e) ** 3;
    const r = 0.2 + k * radius;
    m.scale.set(r, r, r);
    (m.material as MeshBasicMaterial).opacity = (1 - e) ** 1.5;
    state.invalidate();
  });
  return (
    <mesh ref={ref} position={at} rotation-x={-Math.PI / 2} renderOrder={6}>
      <ringGeometry args={[1 - width, 1, 64]} />
      <meshBasicMaterial color={color} transparent opacity={1} blending={AdditiveBlending} depthWrite={false} side={DoubleSide} toneMapped={false} />
    </mesh>
  );
}

/* Bright at the foot, gone at the top: a light column's falloff. */
let fadeTex: CanvasTexture | null = null;
function fadeTexture(): CanvasTexture {
  if (fadeTex) return fadeTex;
  const c = document.createElement("canvas");
  c.width = 4;
  c.height = 128;
  const x = c.getContext("2d");
  if (x) {
    const gr = x.createLinearGradient(0, 128, 0, 0);
    gr.addColorStop(0, "rgba(255,255,255,1)");
    gr.addColorStop(0.25, "rgba(255,255,255,0.55)");
    gr.addColorStop(1, "rgba(255,255,255,0)");
    x.fillStyle = gr;
    x.fillRect(0, 0, 4, 128);
  }
  fadeTex = new CanvasTexture(c);
  return fadeTex;
}

/* A column of light: where a rider fell, where a duel was won. It
   shoots up from the floor, then widens and fades. */
export function LightPillar({ at, hex, height = 14, dur = 1.6, width = 0.5 }: { at: [number, number, number]; hex: string; height?: number; dur?: number; width?: number }) {
  const j = useJuice();
  const grp = useRef<Group>(null);
  const ref = useRef<Mesh>(null);
  const t0 = useRef<number | null>(null);
  const color = useMemo(() => new Color(hex).multiplyScalar(1.8), [hex]);
  useFrame((state) => {
    const g = grp.current;
    const m = ref.current;
    if (!g || !m) return;
    if (t0.current === null) t0.current = j.t;
    const e = (j.t - t0.current) / dur;
    if (e >= 1) {
      g.visible = false;
      return;
    }
    const grow = Math.max(0.001, Math.min(1, e / 0.12));
    g.scale.set(1 + e * 0.6, grow, 1 + e * 0.6);
    (m.material as MeshBasicMaterial).opacity = e < 0.12 ? 0.9 : 0.9 * (1 - (e - 0.12) / 0.88) ** 2;
    state.invalidate();
  });
  return (
    <group ref={grp} position={at} scale={[1, 0.001, 1]}>
      <mesh ref={ref} position={[0, height / 2, 0]} renderOrder={7}>
        <cylinderGeometry args={[width, width * 0.6, height, 24, 1, true]} />
        <meshBasicMaterial map={fadeTexture()} color={color} transparent opacity={0.9} blending={AdditiveBlending} depthWrite={false} side={DoubleSide} toneMapped={false} />
      </mesh>
    </group>
  );
}
