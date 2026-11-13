/* Battleship fire (2026-11-13): fire that burns, not candles.

   The old fires were three stacked glow sprites per cell, flickering in
   place - every one the same symmetric teardrop. Real fire aboard a ship
   is a crowd of short-lived flame tongues licking up from the burning
   stretch of hull, white-yellow at the root, orange, then red as they
   cool and thin out, under a dark plume of smoke that billows, widens
   and leans downwind, lit orange from below; sparks ride the plume.

   Everything here runs in the vertex and fragment shaders from a time
   uniform and per-particle seeds (no per-frame CPU work besides the
   light flicker), in three draws for every fire on the board: flames
   (additive), smoke (alpha), sparks (additive). Time is the juice clock
   (frozen in a hit-stop, slowed in slow motion); reduced motion holds a
   single frame. A fire spreads along `dir` (the hull's axis) by
   `spread`; `kind` picks its character: a ship's hole (tall), oil on
   the water (low, wide), a wreck (big, smoky). */
import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import {
  AdditiveBlending,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  PlaneGeometry,
  ShaderMaterial,
  Vector3,
  type PointLight,
} from "three";
import { useJuice } from "./juice";

export type FireKind = "ship" | "water" | "wreck";
export type FireSpec = {
  key: string;
  x: number;
  y: number;
  z: number;
  scale: number;
  light: boolean;
  spread?: number;
  dir?: [number, number];
  kind?: FireKind;
};

const KIND_ID: Record<FireKind, number> = { ship: 0, water: 1, wreck: 2 };

const COMMON = /* glsl */ `
uniform float uTime;
uniform vec3 uWind;
attribute vec3 aBase;
attribute vec2 aDir;
attribute vec4 aP; // seed, phase, spread, scale
attribute float aKind;
varying vec2 vUv;
varying float vLife;
varying float vSeed;
float h(float s, float k) { return fract(sin(s * 91.7 + k * 47.3) * 43758.5453); }
vec3 startAt(float seed, float across) {
  float a = (h(seed, 2.0) - 0.5) * 2.0 * aP.z;
  float b = (h(seed, 3.0) - 0.5) * across;
  return aBase + vec3(aDir.x, 0.0, aDir.y) * a + vec3(-aDir.y, 0.0, aDir.x) * b;
}
vec3 billboard(vec3 p, vec2 q) {
  vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  return p + right * q.x + up * q.y;
}`;

const NOISE = /* glsl */ `
// sine-free hash: stays random at large inputs and on mediump GPUs
float hash2(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash2(i), hash2(i + vec2(1.0, 0.0)), u.x), mix(hash2(i + vec2(0.0, 1.0)), hash2(i + vec2(1.0, 1.0)), u.x), u.y);
}`;

/* Flames: sheets of fire anchored in the burning stretch, each living
   a second or so - growing in, licking up, leaning downwind, burning
   out - staggered so the fire renews itself. The shape comes from the
   fragment shader, not the quad: fractal noise scrolls up through a
   flame envelope (wide at the foot, a point at the top) and the result
   is coloured by intensity, the way fire is: red at the ragged edges,
   orange, yellow at the heart, tips tearing off as the noise thins
   them. Overlapping sheets add up, so a big fire burns hotter. */
const FLAME_V = /* glsl */ `
${COMMON}
void main() {
  float seed = aP.x;
  float sc = aP.w;
  float life = fract(uTime / (0.85 + 0.75 * h(seed, 1.0)) + aP.y);
  float water = aKind > 0.5 && aKind < 1.5 ? 1.0 : 0.0;
  vec3 p = startAt(seed, 0.22 * sc);
  p.y += life * 0.16 * sc;
  p += uWind * life * 0.2 * sc;
  float w = sc * (0.32 + 0.24 * h(seed, 5.0)) * mix(1.0, 1.4, water);
  float tall = w * mix(1.55, 1.05, water) * (0.7 + 0.55 * sin(min(life * 1.4, 1.0) * 3.14159 * 0.5 + life * 1.2));
  float up = position.y + 0.5; // 0 at the foot, 1 at the tip
  vec3 wp = billboard(p, vec2(position.x * w, up * tall));
  wp += uWind * up * up * tall * 0.4; // the tip leans downwind
  vUv = uv;
  vLife = life;
  vSeed = seed;
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}`;

const FLAME_F = /* glsl */ `
uniform float uTime;
varying vec2 vUv;
varying float vLife;
varying float vSeed;
${NOISE}
float fbm(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 3; i++) { s += a * vnoise(p); p = p * 2.03 + 1.7; a *= 0.5; }
  return s;
}
void main() {
  vec2 uv = vUv;
  float t = uTime;
  float y = uv.y;
  // turbulence racing up the flame (the quad is tall, so it runs at a
  // higher frequency up than across, or it stretches into blades)
  float n = smoothstep(0.25, 0.75, fbm(vec2(uv.x * 4.0 + vSeed * 3.1, y * 4.6 - t * 3.3 + vSeed)));
  float sway = vnoise(vec2(vSeed * 5.0, y * 1.5 - t * 1.4)) - 0.5;
  float x = uv.x - 0.5 + sway * 0.16 * y;
  // the silhouette: full at the foot, a rounded belly, a point at the
  // top - and the turbulence nibbles its edge at every height, so no
  // two moments share an outline (max |x| stays under 0.45: the quad's
  // sides never cut it)
  float wdt = 0.27 * pow(max(1.0 - y, 0.0), 0.55) * (0.6 + 0.75 * n);
  float env = (1.0 - smoothstep(wdt * 0.45, wdt, abs(x))) * smoothstep(0.0, 0.1, y);
  // heat: hottest low in the middle; higher up, where the turbulence
  // thins it, the flame tears into licks and loose tips
  float I = env * (1.05 - y * 0.5) * (0.55 + 0.8 * n) - y * 0.3;
  I *= smoothstep(0.0, 0.12, vLife) * (1.0 - smoothstep(0.5, 1.0, vLife));
  I = clamp(I * 1.6, 0.0, 1.0);
  // linear light, by intensity: dull red, orange, yellow (overlapping
  // sheets add, so a fire's heart builds toward white on its own)
  vec3 col = I < 0.4 ? mix(vec3(0.3, 0.02, 0.0), vec3(1.0, 0.22, 0.015) * 1.1, I / 0.4)
                     : mix(vec3(1.0, 0.22, 0.015) * 1.1, vec3(1.0, 0.56, 0.16) * 1.5, (I - 0.4) / 0.6);
  gl_FragColor = vec4(col, smoothstep(0.1, 0.4, I) * 0.55);
}`;

/* Smoke: four to five seconds a puff, a widening plume leaning
   downwind, turning slowly; fire-lit at the root, dark grey above,
   thinner and lighter as it rises and catches the sky. */
const SMOKE_V = /* glsl */ `
${COMMON}
varying float vKind;
void main() {
  float seed = aP.x;
  float sc = aP.w;
  float life = fract(uTime / (3.6 + 1.6 * h(seed, 1.0)) + aP.y);
  float wreck = aKind > 1.5 ? 1.0 : 0.0;
  vec3 p = startAt(seed, 0.25 * sc);
  float water = aKind > 0.5 && aKind < 1.5 ? 1.0 : 0.0;
  float rise = sc * mix(mix(2.7, 3.5, wreck), 1.9, water);
  p.y += 0.22 * sc + life * rise;
  p += uWind * pow(life, 1.4) * 2.3 * sc;
  p.x += sin(uTime * 0.9 + seed * 5.0) * 0.12 * life * sc;
  p.z += cos(uTime * 0.7 + seed * 3.0) * 0.1 * life * sc;
  float size = sc * mix(0.32, 1.45, pow(life, 0.7)) * (0.8 + 0.45 * h(seed, 5.0)) * mix(1.0, 1.2, wreck);
  float ang = seed * 6.2831 + life * 1.3;
  vec2 q = vec2(cos(ang) * position.x - sin(ang) * position.y, sin(ang) * position.x + cos(ang) * position.y) * size;
  vec3 wp = billboard(p, q);
  vUv = uv;
  vLife = life;
  vSeed = seed;
  vKind = aKind;
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}`;

const SMOKE_F = /* glsl */ `
uniform float uTime;
uniform float uSmoke;
varying vec2 vUv;
varying float vLife;
varying float vSeed;
varying float vKind;
${NOISE}
void main() {
  float n = vnoise(vUv * 3.0 + vSeed * 5.0 + vec2(0.0, -uTime * 0.18)) * 0.6 + vnoise(vUv * 6.5 - vSeed * 3.0) * 0.4;
  float d = length(vUv - 0.5);
  float puff = smoothstep(0.48, 0.16, d + (n - 0.5) * 0.4);
  float l = vLife;
  // linear light: near-black oil smoke, fire-lit at the root, greying
  // and catching the dusk as it thins
  vec3 lit = vec3(0.32, 0.1, 0.025);
  vec3 dark = vec3(0.018, 0.016, 0.017);
  vec3 top = vec3(0.075, 0.06, 0.07);
  vec3 col = l < 0.16 ? mix(lit, dark, l / 0.16) : mix(dark, top, (l - 0.16) / 0.84);
  // dense over the fire, thinning as it climbs; oil burning on the
  // water (an unseen hull) smokes lighter so the board stays readable
  float k = vKind > 1.5 ? 1.0 : vKind > 0.5 ? 0.6 : 0.92;
  float alpha = puff * smoothstep(0.0, 0.06, l) * (1.0 - smoothstep(0.35, 1.0, l)) * uSmoke * k;
  gl_FragColor = vec4(col, alpha);
}`;

/* Sparks riding the plume: tiny, bright, flickering. */
const SPARK_V = /* glsl */ `
${COMMON}
void main() {
  float seed = aP.x;
  float sc = aP.w;
  float life = fract(uTime / (1.3 + 0.9 * h(seed, 1.0)) + aP.y);
  vec3 p = startAt(seed, 0.3 * sc);
  p.y += 0.1 * sc + life * sc * (1.2 + 1.2 * h(seed, 4.0));
  p += uWind * life * 1.2 * sc;
  p.x += sin(uTime * 4.0 + seed * 11.0) * 0.12 * life * sc;
  p.z += cos(uTime * 3.3 + seed * 7.0) * 0.12 * life * sc;
  float size = 0.03 * sc * (1.0 - life) * (0.6 + 0.8 * h(seed, 6.0));
  vec3 wp = billboard(p, position.xy * size);
  vUv = uv;
  vLife = life;
  vSeed = seed;
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}`;

const SPARK_F = /* glsl */ `
uniform float uTime;
varying vec2 vUv;
varying float vLife;
varying float vSeed;
void main() {
  float d = length(vUv - 0.5);
  float a = smoothstep(0.5, 0.0, d) * (0.6 + 0.4 * sin(uTime * 23.0 + vSeed * 40.0));
  gl_FragColor = vec4(vec3(1.0, 0.6, 0.25) * 3.0, a * (1.0 - vLife));
}`;

/* A fire's seeds come from its key, so its flames keep their rhythm
   when other fires start or go out around it. */
function keySeed(key: string, salt: number): number {
  let n = 2166136261 ^ salt;
  for (let i = 0; i < key.length; i++) n = Math.imul(n ^ key.charCodeAt(i), 16777619);
  return (n >>> 0) / 4294967296;
}

function particles(fires: FireSpec[], per: (f: FireSpec) => number, salt: number): InstancedBufferGeometry {
  const quad = new PlaneGeometry(1, 1);
  const g = new InstancedBufferGeometry();
  g.index = quad.index;
  g.setAttribute("position", quad.attributes.position!);
  g.setAttribute("uv", quad.attributes.uv!);
  const total = fires.reduce((sum, f) => sum + per(f), 0);
  const n = Math.max(1, total);
  const base = new Float32Array(n * 3);
  const dir = new Float32Array(n * 2);
  const p = new Float32Array(n * 4);
  const kind = new Float32Array(n);
  let j = 0;
  fires.forEach((f) => {
    const d = f.dir || [1, 0];
    const count = per(f);
    const s0 = keySeed(f.key, salt);
    for (let k = 0; k < count; k++, j++) {
      base.set([f.x, f.y, f.z], j * 3);
      dir.set(d, j * 2);
      const seed = (s0 * 7.31 + k * 0.618034) % 1;
      // phases spread evenly through the cycle, so the fire never gutters
      p.set([seed * 10, k / count + s0 * 0.13, f.spread ?? 0.2, f.scale], j * 4);
      kind[j] = KIND_ID[f.kind || "ship"];
    }
  });
  g.setAttribute("aBase", new InstancedBufferAttribute(base, 3));
  g.setAttribute("aDir", new InstancedBufferAttribute(dir, 2));
  g.setAttribute("aP", new InstancedBufferAttribute(p, 4));
  g.setAttribute("aKind", new InstancedBufferAttribute(kind, 1));
  g.instanceCount = total;
  return g;
}

const WIND = new Vector3(0.55, 0, -0.22);

export function FireSystem({ fires, lite, still }: { fires: FireSpec[]; lite: boolean; still: boolean }) {
  const j = useJuice();
  // stable across re-renders that do not change the fires
  const sig = fires.map((f) => f.key + "@" + f.x.toFixed(2) + "," + f.y.toFixed(2) + "," + f.z.toFixed(2) + (f.kind || "")).join("|");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const list = useMemo(() => fires, [sig]);
  /* Particles per fire. Burning oil over an unseen hull - the most
     numerous fire late in a game - smokes at half rate: big smoke
     quads are most of the fill cost, and the board stays readable. */
  const per = lite ? { flame: 7, smoke: 7, spark: 6 } : { flame: 10, smoke: 12, spark: 10 };
  const smokeFor = (f: FireSpec) => (f.kind === "water" ? Math.ceil(per.smoke / 2) : per.smoke);
  const geos = useMemo(
    () => ({ flame: particles(list, () => per.flame, 1), smoke: particles(list, smokeFor, 2), spark: particles(list, () => per.spark, 3) }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [list, lite]
  );
  useEffect(
    () => () => {
      geos.flame.dispose();
      geos.smoke.dispose();
      geos.spark.dispose();
    },
    [geos]
  );
  const mats = useMemo(() => {
    const uni = () => ({ uTime: { value: 0 }, uWind: { value: WIND }, uSmoke: { value: 1 } });
    return {
      flame: new ShaderMaterial({ vertexShader: FLAME_V, fragmentShader: FLAME_F, uniforms: uni(), transparent: true, depthWrite: false, blending: AdditiveBlending }),
      smoke: new ShaderMaterial({ vertexShader: SMOKE_V, fragmentShader: SMOKE_F, uniforms: uni(), transparent: true, depthWrite: false }),
      spark: new ShaderMaterial({ vertexShader: SPARK_V, fragmentShader: SPARK_F, uniforms: uni(), transparent: true, depthWrite: false, blending: AdditiveBlending }),
    };
  }, []);
  useEffect(
    () => () => {
      mats.flame.dispose();
      mats.smoke.dispose();
      mats.spark.dispose();
    },
    [mats]
  );
  const lit = list.map((f, i) => (f.light ? i : -1)).filter((i) => i >= 0);
  const lights = useRef<(PointLight | null)[]>([]);
  useFrame(() => {
    const t = still ? 3.7 : j.t;
    mats.flame.uniforms.uTime!.value = t;
    mats.smoke.uniforms.uTime!.value = t;
    mats.spark.uniforms.uTime!.value = t;
    lit.forEach((fi, li) => {
      const L = lights.current[li];
      if (!L) return;
      const s = (fi + 1) * 1.7;
      L.intensity = still ? 5.2 : 5.2 + Math.sin(t * 13.7 + s) * 1.6 + Math.sin(t * 31.3 + s * 2) * 1.0;
    });
  });
  if (!list.length) return null;
  return (
    <group>
      <mesh geometry={geos.smoke} material={mats.smoke} frustumCulled={false} renderOrder={3} />
      <mesh geometry={geos.flame} material={mats.flame} frustumCulled={false} renderOrder={4} />
      <mesh geometry={geos.spark} material={mats.spark} frustumCulled={false} renderOrder={5} />
      {lit.map((fi, li) => {
        const f = list[fi]!;
        return (
          <pointLight
            key={f.key}
            ref={(r) => {
              lights.current[li] = r;
            }}
            position={[f.x, f.y + 0.55, f.z]}
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
