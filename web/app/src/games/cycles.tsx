/* Light Cycles, the pieces (2026-11-13): the bike, the trails, the
   floor and the edge of the world. The look follows Tron: Legacy (the
   owner's reference): a glossy black cycle whose wheels are rings of
   light, a rider lying flat along it, trails that are walls of light
   with a white-hot top edge pouring out of the rear wheel, a black
   mirror floor with a pale grid. LcArena3D poses and stages them. */
import { useEffect, useLayoutEffect, useMemo, useRef, type MutableRefObject, type RefObject } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import {
  AdditiveBlending,
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  CapsuleGeometry,
  Color,
  CylinderGeometry,
  Euler,
  Matrix4,
  Quaternion,
  RingGeometry,
  SphereGeometry,
  TorusGeometry,
  Vector3,
  DataTexture,
  DoubleSide,
  ExtrudeGeometry,
  NearestFilter,
  PMREMGenerator,
  RGBAFormat,
  ShaderMaterial,
  Shape,
  SRGBColorSpace,
  type Group,
  type Texture,
  type Mesh,
} from "three";
import { useJuice } from "./juice";
import type { Rider } from "./lcmodel";

/* ---------- the light cycle ---------- */

/* Model units: facing +X, ground at y 0, about 2.3 long. */
export const CYCLE_NOSE = 1.23;
export const CYCLE_REAR_WHEEL = -0.62;
export const CYCLE_WHEEL_R = 0.4;
const WHEEL_X = 0.62;
const WHEEL_R = 0.4;

/* The shell: one extruded side profile - a fender hooding each wheel
   and a bridge between them - bevelled so it reads glossy and round. */
function shellGeometry(): ExtrudeGeometry {
  const s = new Shape();
  const R = 0.56;
  const r = 0.375;
  const C1: [number, number] = [-WHEEL_X, WHEEL_R];
  const C2: [number, number] = [WHEEL_X, WHEEL_R];
  const deg = Math.PI / 180;
  // outer edge: the rear fender from low behind the wheel over its top...
  s.moveTo(C1[0] + Math.cos(205 * deg) * R, C1[1] + Math.sin(205 * deg) * R);
  s.absarc(C1[0], C1[1], R, 205 * deg, 55 * deg, true);
  // ...a low swell over the rider's bay...
  s.quadraticCurveTo(0, WHEEL_R + 0.66, C2[0] + Math.cos(125 * deg) * R, C2[1] + Math.sin(125 * deg) * R);
  // ...the front fender over its wheel and down to the nose
  s.absarc(C2[0], C2[1], R, 125 * deg, -25 * deg, true);
  // inner edge: back up around the front wheel, along the belly, and
  // over the rear wheel to close
  s.lineTo(C2[0] + Math.cos(-25 * deg) * r, C2[1] + Math.sin(-25 * deg) * r);
  s.absarc(C2[0], C2[1], r, -25 * deg, 160 * deg, false);
  s.quadraticCurveTo(0, WHEEL_R + 0.02, C1[0] + Math.cos(20 * deg) * r, C1[1] + Math.sin(20 * deg) * r);
  s.absarc(C1[0], C1[1], r, 20 * deg, 205 * deg, false);
  s.closePath();
  const g = new ExtrudeGeometry(s, { depth: 0.3, bevelEnabled: true, bevelThickness: 0.07, bevelSize: 0.05, bevelSegments: 4, curveSegments: 24 });
  g.translate(0, 0, -0.15);
  return g;
}


function glow(hex: string, k = 1): Color {
  return new Color(hex).multiplyScalar(k);
}

/* A tiny studio for reflections (three's RoomEnvironment, built from
   boxes - no download), prefiltered once and shared: without it the
   glossy black shell has nothing to reflect and reads as a hole. Only
   the cycles use it; the world stays black. */
let envTex: Texture | null = null;
function useStudio(): Texture | null {
  const gl = useThree((st) => st.gl);
  return useMemo(() => {
    if (envTex) return envTex;
    try {
      const pm = new PMREMGenerator(gl);
      envTex = pm.fromScene(new RoomEnvironment(), 0.04).texture;
      pm.dispose();
    } catch {
      envTex = null;
    }
    return envTex;
  }, [gl]);
}

/* The cycle's parts, merged once into one geometry per material (a
   cycle is 6 draws, not 35): the dark gloss (shell, wheel drums,
   rider), the grey hubs, the bright light (rims, fender arcs, helmet
   band), the softer light (inner rings, suit lines), and a notch per
   wheel that spins so the motion shows. */
type CycleGeo = { dark: BufferGeometry; hub: BufferGeometry; lit: BufferGeometry; soft: BufferGeometry; notch: BufferGeometry };
let cycleGeo: CycleGeo | null = null;
function placed(geo: BufferGeometry, pos: [number, number, number], rot: [number, number, number] = [0, 0, 0]): BufferGeometry {
  const g = geo.index ? geo.toNonIndexed() : geo;
  if (g !== geo) geo.dispose();
  g.applyMatrix4(new Matrix4().compose(new Vector3(...pos), new Quaternion().setFromEuler(new Euler(...rot)), new Vector3(1, 1, 1)));
  return g;
}
function cycleGeometries(): CycleGeo {
  if (cycleGeo) return cycleGeo;
  const dark: BufferGeometry[] = [];
  const hub: BufferGeometry[] = [];
  const lit: BufferGeometry[] = [];
  const soft: BufferGeometry[] = [];
  const deg = Math.PI / 180;
  const H = Math.PI / 2;
  for (const x of [WHEEL_X, -WHEEL_X]) {
    dark.push(placed(new CylinderGeometry(0.36, 0.36, 0.24, 36), [x, WHEEL_R, 0], [H, 0, 0]));
    for (const z of [0.125, -0.125]) {
      const sg = Math.sign(z);
      lit.push(placed(new TorusGeometry(0.39, 0.026, 8, 48), [x, WHEEL_R, z]));
      hub.push(placed(new CylinderGeometry(0.2, 0.2, 0.02, 28), [x, WHEEL_R, z + sg * 0.008], [H, 0, 0]));
      soft.push(placed(new TorusGeometry(0.215, 0.01, 6, 32), [x, WHEEL_R, z + sg * 0.02]));
    }
    // the light carries on round the fender's flanks, so each wheel
    // reads as one whole circle
    lit.push(placed(new RingGeometry(0.375, 0.405, 40, 1, 8 * deg, 164 * deg), [x, WHEEL_R, 0.226]));
    lit.push(placed(new RingGeometry(0.375, 0.405, 40, 1, 8 * deg, 164 * deg), [x, WHEEL_R, -0.226], [0, Math.PI, 0]));
  }
  dark.push(placed(shellGeometry(), [0, 0, 0]));
  // the rider, flat along the cycle: torso, helmet, arms, legs
  const y0 = 0.06;
  dark.push(placed(new CapsuleGeometry(0.15, 0.52, 6, 12), [0.02, 1.0 + y0, 0], [0, 0, -H + 0.16]));
  for (const z of [0.125, -0.125]) soft.push(placed(new CapsuleGeometry(0.014, 0.6, 4, 6), [0.02, 1.01 + y0, z], [0, 0, -H + 0.16]));
  dark.push(placed(new SphereGeometry(0.15, 18, 14), [0.52, 0.98 + y0, 0]));
  lit.push(placed(new TorusGeometry(0.152, 0.012, 6, 28, Math.PI), [0.52, 0.98 + y0, 0], [0, H, 0]));
  for (const z of [0.13, -0.13]) {
    dark.push(placed(new CapsuleGeometry(0.05, 0.3, 4, 8), [0.5, 0.82 + y0, z], [0, 0, 0.62]));
    dark.push(placed(new CapsuleGeometry(0.065, 0.42, 4, 8), [-0.52, 0.85 + y0, z], [0, 0, -1.0]));
    soft.push(placed(new CapsuleGeometry(0.011, 0.44, 4, 6), [-0.52, 0.85 + y0, z * 1.12], [0, 0, -1.0]));
  }
  const notch = [placed(new BoxGeometry(0.1, 0.025, 0.01), [0.29, 0, 0.135]), placed(new BoxGeometry(0.1, 0.025, 0.01), [0.29, 0, -0.135])];
  const merge = (l: BufferGeometry[]) => {
    const m = mergeGeometries(l, false)!;
    l.forEach((g) => g.dispose());
    return m;
  };
  cycleGeo = { dark: merge(dark), hub: merge(hub), lit: merge(lit), soft: merge(soft), notch: merge(notch) };
  return cycleGeo;
}

/* One cycle. Wheel spin, lean and heading come from the parent via
   the refs it passes (poses are timeline-driven). */
export function CycleModel({ hex, wheels, lean }: { hex: string; wheels: MutableRefObject<(Mesh | null)[]>; lean: RefObject<Group | null> }) {
  const G = useMemo(() => cycleGeometries(), []);
  const env = useStudio();
  const lit = useMemo(() => glow(hex, 3.4), [hex]);
  const soft = useMemo(() => glow(hex, 1.7), [hex]);
  return (
    <group ref={lean}>
      <mesh geometry={G.dark}>
        <meshStandardMaterial color="#06080c" metalness={0.9} roughness={0.16} envMap={env} envMapIntensity={0.9} />
      </mesh>
      <mesh geometry={G.hub}>
        <meshStandardMaterial color="#5a636e" metalness={0.95} roughness={0.28} envMap={env} envMapIntensity={1.1} />
      </mesh>
      <mesh geometry={G.lit}>
        <meshBasicMaterial color={lit} toneMapped={false} side={DoubleSide} />
      </mesh>
      <mesh geometry={G.soft}>
        <meshBasicMaterial color={soft} toneMapped={false} />
      </mesh>
      {[WHEEL_X, -WHEEL_X].map((x, i) => (
        <mesh
          key={i}
          ref={(m) => {
            wheels.current[i] = m;
          }}
          geometry={G.notch}
          position={[x, WHEEL_R, 0]}
        >
          <meshBasicMaterial color={soft} toneMapped={false} />
        </mesh>
      ))}
    </group>
  );
}

/* A soft pool of the rider's light on the floor (additive). */
let poolTex: CanvasTexture | null = null;
export function poolTexture(): CanvasTexture {
  if (poolTex) return poolTex;
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const x = c.getContext("2d")!;
  const g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.35, "rgba(255,255,255,0.45)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  x.fillStyle = g;
  x.fillRect(0, 0, 64, 64);
  poolTex = new CanvasTexture(c);
  poolTex.colorSpace = SRGBColorSpace;
  return poolTex;
}

/* ---------- trails ---------- */

/* Every rider's trail in one draw: each straight run is a thin wall
   (a box without a floor), its vertices carrying the run's arc length
   along the rider's path (aS, in cells), the height fraction (aV) and
   the rider (aR). The shader hides everything past the rider's head
   (uHead) - so the trail grows smoothly as the bike sprints, and the
   catch-up can rewind it - and lights it: a white-hot top edge, a
   bright foot line, a glassy body, pulses of energy running toward
   the bike, hot near the head and cooling with age. A wreck's trail
   stays (the server keeps it as a wall) but dims and wavers. */
export const MAX_RIDERS = 4;
const TRAIL_H = 0.92;
const TRAIL_T = 0.075;
const EXT = 0.09;

export function trailGeometry(list: Rider[], wx: (x: number) => number, wz: (y: number) => number): BufferGeometry {
  const pos: number[] = [];
  const aS: number[] = [];
  const aV: number[] = [];
  const aR: number[] = [];
  const quad = (p: number[][], s: number[], v: number[], r: number) => {
    // two triangles: 0 1 2, 0 2 3
    [0, 1, 2, 0, 2, 3].forEach((k) => {
      pos.push(p[k]![0]!, p[k]![1]!, p[k]![2]!);
      aS.push(s[k]!);
      aV.push(v[k]!);
      aR.push(r);
    });
  };
  list.forEach((r) => {
    const c = r.cells;
    if (c.length < 2) return;
    let s0 = 0;
    for (let k = 1; k <= c.length - 1; k++) {
      const last = k === c.length - 1;
      const dx = Math.sign(c[k]![0] - c[k - 1]![0]);
      const dy = Math.sign(c[k]![1] - c[k - 1]![1]);
      const nx = last ? 0 : Math.sign(c[k + 1]![0] - c[k]![0]);
      const ny = last ? 0 : Math.sign(c[k + 1]![1] - c[k]![1]);
      if (!last && nx === dx && ny === dy) continue;
      // a run from cell s0 to cell k
      const a = c[s0]!;
      const b = c[k]!;
      const ax = wx(a[0]), az = wz(a[1]), bx = wx(b[0]), bz = wz(b[1]);
      const len = Math.hypot(bx - ax, bz - az) || 1;
      const ux = (bx - ax) / len, uz = (bz - az) / len;
      const px = -uz * TRAIL_T, pz = ux * TRAIL_T;
      const A = [ax - ux * EXT, az - uz * EXT];
      const B = [bx + ux * EXT, bz + uz * EXT];
      const sA = s0 - EXT, sB = k + EXT;
      const H = TRAIL_H;
      // flanks
      for (const sg of [1, -1]) {
        quad(
          [
            [A[0]! + px * sg, 0, A[1]! + pz * sg],
            [B[0]! + px * sg, 0, B[1]! + pz * sg],
            [B[0]! + px * sg, H, B[1]! + pz * sg],
            [A[0]! + px * sg, H, A[1]! + pz * sg],
          ],
          [sA, sB, sB, sA],
          [0, 0, 1, 1],
          r.i
        );
      }
      // the top (v 1.5: the shader's "top face")
      quad(
        [
          [A[0]! + px, H, A[1]! + pz],
          [B[0]! + px, H, B[1]! + pz],
          [B[0]! - px, H, B[1]! - pz],
          [A[0]! - px, H, A[1]! - pz],
        ],
        [sA, sB, sB, sA],
        [1.5, 1.5, 1.5, 1.5],
        r.i
      );
      // end caps
      for (const [E, sE] of [[A, sA], [B, sB]] as [number[], number][]) {
        quad(
          [
            [E[0]! + px, 0, E[1]! + pz],
            [E[0]! - px, 0, E[1]! - pz],
            [E[0]! - px, H, E[1]! - pz],
            [E[0]! + px, H, E[1]! + pz],
          ],
          [sE, sE, sE, sE],
          [0, 0, 1, 1],
          r.i
        );
      }
      s0 = k;
    }
  });
  const g = new BufferGeometry();
  g.setAttribute("position", new BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute("aS", new BufferAttribute(new Float32Array(aS), 1));
  g.setAttribute("aV", new BufferAttribute(new Float32Array(aV), 1));
  g.setAttribute("aR", new BufferAttribute(new Float32Array(aR), 1));
  g.computeBoundingSphere();
  return g;
}

const TRAIL_V = /* glsl */ `
attribute float aS;
attribute float aV;
attribute float aR;
varying float vS;
varying float vV;
varying float vR;
varying vec3 vW;
void main() {
  vS = aS;
  vV = aV;
  vR = aR;
  vec4 w = modelMatrix * vec4(position, 1.0);
  vW = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;

const TRAIL_F = /* glsl */ `
uniform float uTime;
uniform vec3 uCol[${MAX_RIDERS}];
uniform float uHead[${MAX_RIDERS}];
uniform float uLive[${MAX_RIDERS}];
uniform float uWave[${MAX_RIDERS}];
uniform float uFlare[${MAX_RIDERS}];
varying float vS;
varying float vV;
varying float vR;
varying vec3 vW;
void main() {
  int r = int(vR + 0.5);
  float head = 0.0, live = 0.0, wave = -99.0, flare = 0.0;
  vec3 col = vec3(1.0);
  for (int i = 0; i < ${MAX_RIDERS}; i++) {
    if (i == r) { head = uHead[i]; live = uLive[i]; wave = uWave[i]; flare = uFlare[i]; col = uCol[i]; }
  }
  if (vS > head) discard;
  float topFace = step(1.25, vV);
  float v = min(vV, 1.0);
  float age = head - vS;
  float fresh = exp(-age / 6.0);
  float topEdge = max(topFace, smoothstep(0.84, 0.97, v));
  float foot = 1.0 - smoothstep(0.0, 0.08, v);
  float body = 0.32 + 0.38 * (1.0 - v);
  // energy running up the trail toward the bike
  float flow = pow(0.5 + 0.5 * sin((vS - uTime * 2.6) * 1.15), 10.0);
  // the winner's wave: a bright front running tail to head
  float wv = exp(-pow((vS - wave) * 0.7, 2.0));
  // saturate the rider's colour: a light wall, not a pastel slab
  vec3 sat = pow(col, vec3(1.7)) * 1.25;
  float I = body * (1.25 + 1.0 * fresh) * (0.75 + 0.5 * v) + foot * 1.4 + flow * 0.8 * live + wv * 3.0;
  vec3 c = sat * I * (1.0 + flare);
  // the top edge burns white-hot near the bike, coloured further back
  c += mix(sat * 1.6, vec3(1.0), 0.25 + 0.5 * fresh) * topEdge * (1.6 + 1.4 * fresh) * (1.0 + flare);
  // a wreck's trail: still a wall, dimmed, wavering slowly
  float dead = 1.0 - live;
  float waver = 0.42 + 0.1 * sin(uTime * 1.7 + floor(vS) * 2.3);
  c *= mix(1.0, waver, dead);
  float a = mix(0.78, 0.45, dead) + topEdge * 0.2;
  gl_FragColor = vec4(c, clamp(a, 0.0, 1.0));
}`;

export type TrailUniforms = { head: number[]; live: number[]; wave: number[]; flare: number[] };

export function TrailSystem({ list, wx, wz, u }: { list: Rider[]; wx: (x: number) => number; wz: (y: number) => number; u: TrailUniforms }) {
  const j = useJuice();
  const sig = list.map((r) => r.i + ":" + r.cells.length).join("|") + "|" + wx(0) + "," + wz(0);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const geo = useMemo(() => trailGeometry(list, wx, wz), [sig]);
  useEffect(() => () => geo.dispose(), [geo]);
  const mat = useMemo(
    () =>
      new ShaderMaterial({
        vertexShader: TRAIL_V,
        fragmentShader: TRAIL_F,
        transparent: true,
        side: DoubleSide,
        uniforms: {
          uTime: { value: 0 },
          uCol: { value: Array.from({ length: MAX_RIDERS }, () => new Color("#22d3ee")) },
          uHead: { value: new Array(MAX_RIDERS).fill(0) },
          uLive: { value: new Array(MAX_RIDERS).fill(1) },
          uWave: { value: new Array(MAX_RIDERS).fill(-99) },
          uFlare: { value: new Array(MAX_RIDERS).fill(0) },
        },
      }),
    []
  );
  useEffect(() => () => mat.dispose(), [mat]);
  useLayoutEffect(() => {
    const cols = mat.uniforms.uCol!.value as Color[];
    list.forEach((r) => {
      if (r.i < MAX_RIDERS) cols[r.i]!.set(r.hex);
    });
  }, [mat, list]);
  useFrame(() => {
    mat.uniforms.uTime!.value = j.still ? 0 : j.t;
    for (let i = 0; i < MAX_RIDERS; i++) {
      (mat.uniforms.uHead!.value as number[])[i] = u.head[i] ?? 0;
      (mat.uniforms.uLive!.value as number[])[i] = u.live[i] ?? 1;
      (mat.uniforms.uWave!.value as number[])[i] = u.wave[i] ?? -99;
      (mat.uniforms.uFlare!.value as number[])[i] = u.flare[i] ?? 0;
    }
  });
  return <mesh geometry={geo} material={mat} frustumCulled={false} renderOrder={2} />;
}

/* ---------- the floor ---------- */

/* The board's grid as one additive shader over the mirror floor:
   exact cell-edge lines (every 5th a section line), the deadly edge
   brightest, packets of light running along some lines (data flow),
   and, when shown, each cell tinted by the rider who can reach it
   first (territory). */
const GRID_V = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const GRID_F = /* glsl */ `
uniform vec2 uSize;
uniform float uTime;
uniform float uTerr;
uniform sampler2D uOwn;
varying vec2 vUv;
float hash(float n) { return fract(sin(n * 91.3458) * 47453.5453); }
float lineAA(float x, float wpx) {
  float d = abs(fract(x - 0.5) - 0.5) / max(fwidth(x), 1e-4);
  return 1.0 - smoothstep(wpx - 0.5, wpx + 0.5, d);
}
void main() {
  vec2 p = vec2(vUv.x * uSize.x, (1.0 - vUv.y) * uSize.y);
  float minor = max(lineAA(p.x, 0.45), lineAA(p.y, 0.45));
  float major = max(lineAA(p.x / 5.0, 0.55), lineAA(p.y / 5.0, 0.55));
  // the edge: a wall, and deadly
  vec2 e = min(p, uSize - p) / max(fwidth(p), vec2(1e-4));
  float edge = 1.0 - smoothstep(1.2, 2.6, min(e.x, e.y));
  // data packets on every other line
  float ix = floor(p.x + 0.5), iy = floor(p.y + 0.5);
  float onX = lineAA(p.x, 0.9), onY = lineAA(p.y, 0.9);
  float hx = hash(ix + 3.1), hy = hash(iy + 17.7);
  float px = fract(hx * 7.0 + uTime * (0.05 + 0.06 * hx) * (hx > 0.5 ? 1.0 : -1.0)) * (uSize.y + 8.0) - 4.0;
  float py = fract(hy * 5.0 + uTime * (0.05 + 0.06 * hy) * (hy > 0.5 ? 1.0 : -1.0)) * (uSize.x + 8.0) - 4.0;
  float pulse = onX * step(0.55, hx) * exp(-pow((p.y - px) * 1.1, 2.0)) + onY * step(0.55, hy) * exp(-pow((p.x - py) * 1.1, 2.0));
  vec3 c = vec3(0.3, 0.52, 0.66) * minor * 0.085 + vec3(0.42, 0.7, 0.86) * major * 0.15 + vec3(0.55, 0.88, 1.0) * edge * 0.75 + vec3(0.3, 0.8, 1.0) * pulse * 0.32;
  // territory
  vec4 own = texture2D(uOwn, vec2((floor(p.x) + 0.5) / uSize.x, (floor(p.y) + 0.5) / uSize.y));
  c += own.rgb * own.a * uTerr * 0.14;
  gl_FragColor = vec4(c, 1.0);
}`;

export function GridFloor({ w, h, own, hexes, terr }: { w: number; h: number; own: Int8Array | null; hexes: string[]; terr: number }) {
  const j = useJuice();
  const tex = useMemo(() => {
    const t = new DataTexture(new Uint8Array(w * h * 4), w, h, RGBAFormat);
    t.magFilter = NearestFilter;
    t.minFilter = NearestFilter;
    t.needsUpdate = true;
    return t;
  }, [w, h]);
  useEffect(() => () => tex.dispose(), [tex]);
  const mat = useMemo(
    () =>
      new ShaderMaterial({
        vertexShader: GRID_V,
        fragmentShader: GRID_F,
        transparent: true,
        depthWrite: false,
        blending: AdditiveBlending,
        uniforms: { uSize: { value: [w, h] }, uTime: { value: 0 }, uTerr: { value: 0 }, uOwn: { value: tex } },
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );
  useEffect(() => () => mat.dispose(), [mat]);
  useLayoutEffect(() => {
    mat.uniforms.uSize!.value = [w, h];
    mat.uniforms.uOwn!.value = tex;
    const d = tex.image.data as Uint8Array;
    d.fill(0);
    if (own) {
      const cols = hexes.map((x) => new Color(x));
      for (let i = 0; i < w * h; i++) {
        const o = own[i]!;
        if (o < 0 || !cols[o]) continue;
        const c = cols[o]!;
        d[i * 4] = Math.round(c.r * 255);
        d[i * 4 + 1] = Math.round(c.g * 255);
        d[i * 4 + 2] = Math.round(c.b * 255);
        d[i * 4 + 3] = 255;
      }
    }
    tex.needsUpdate = true;
  }, [mat, tex, w, h, own, hexes.join(",")]);
  const terrRef = useRef(0);
  useFrame((state, delta) => {
    mat.uniforms.uTime!.value = j.still ? 0 : j.t;
    // territory fades in and out rather than snapping
    const want = terr;
    const cur = terrRef.current;
    if (Math.abs(want - cur) > 0.002) {
      terrRef.current = cur + (want - cur) * Math.min(1, delta * 6);
      state.invalidate();
    } else terrRef.current = want;
    mat.uniforms.uTerr!.value = terrRef.current;
  });
  return (
    <mesh material={mat} rotation-x={-Math.PI / 2} position={[0, 0.012, 0]} renderOrder={-2}>
      <planeGeometry args={[w, h]} />
    </mesh>
  );
}

/* The edge of the grid is a wall: a low curtain of light rising from
   the boundary line and fading upward, with slow scanlines. */
const EDGE_V = /* glsl */ `
attribute float aU;
varying float vH;
varying float vU;
void main() {
  vH = uv.y;
  vU = aU;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;
const EDGE_F = /* glsl */ `
uniform float uTime;
varying float vH;
varying float vU;
void main() {
  float fade = pow(1.0 - vH, 2.4);
  float scan = 0.75 + 0.25 * sin(vH * 40.0 - uTime * 3.0);
  float runner = pow(0.5 + 0.5 * sin(vU * 0.35 - uTime * 1.4), 24.0);
  vec3 c = vec3(0.4, 0.75, 1.0) * fade * scan * 0.22 + vec3(0.7, 0.95, 1.0) * runner * fade * 0.7;
  gl_FragColor = vec4(c, 1.0);
}`;

export function EdgeWall({ w, h, height = 0.75 }: { w: number; h: number; height?: number }) {
  const j = useJuice();
  const geo = useMemo(() => {
    const W = w / 2, D = h / 2;
    const corners: [number, number][] = [[-W, -D], [W, -D], [W, D], [-W, D]];
    const pos: number[] = [];
    const uv: number[] = [];
    const au: number[] = [];
    let run = 0;
    for (let k = 0; k < 4; k++) {
      const a = corners[k]!, b = corners[(k + 1) % 4]!;
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const v = [
        [a[0], 0, a[1], 0, run], [b[0], 0, b[1], 0, run + len], [b[0], height, b[1], 1, run + len],
        [a[0], 0, a[1], 0, run], [b[0], height, b[1], 1, run + len], [a[0], height, a[1], 1, run],
      ];
      v.forEach((q) => {
        pos.push(q[0]!, q[1]!, q[2]!);
        uv.push(0, q[3]!);
        au.push(q[4]!);
      });
      run += len;
    }
    const g = new BufferGeometry();
    g.setAttribute("position", new BufferAttribute(new Float32Array(pos), 3));
    g.setAttribute("uv", new BufferAttribute(new Float32Array(uv), 2));
    g.setAttribute("aU", new BufferAttribute(new Float32Array(au), 1));
    return g;
  }, [w, h, height]);
  useEffect(() => () => geo.dispose(), [geo]);
  const mat = useMemo(
    () => new ShaderMaterial({ vertexShader: EDGE_V, fragmentShader: EDGE_F, transparent: true, depthWrite: false, blending: AdditiveBlending, side: DoubleSide, uniforms: { uTime: { value: 0 } } }),
    []
  );
  useEffect(() => () => mat.dispose(), [mat]);
  useFrame(() => {
    mat.uniforms.uTime!.value = j.still ? 0 : j.t;
  });
  return <mesh geometry={geo} material={mat} renderOrder={1} />;
}

/* Far ridgelines all round the horizon: a dark mass with a thin lit
   crest, seen in the low views (the entry flight, the chase camera,
   crash close-ups). Two draws. */
export function Ridges({ radius = 175 }: { radius?: number }) {
  const { fill, crest } = useMemo(() => {
    const N = 160;
    const hgt: number[] = [];
    for (let i = 0; i < N; i++) {
      const a = (i / N) * Math.PI * 2;
      const n = Math.sin(a * 3 + 1.3) * 0.5 + Math.sin(a * 7.1 + 0.4) * 0.3 + Math.sin(a * 17.3) * 0.15 + Math.sin(a * 41.7 + 2.1) * 0.06;
      hgt.push(9 + 11 * (0.5 + 0.5 * n) + (i % 3 === 0 ? 2.5 : 0));
    }
    const fp: number[] = [];
    const cp: number[] = [];
    for (let i = 0; i < N; i++) {
      const a0 = (i / N) * Math.PI * 2, a1 = ((i + 1) / N) * Math.PI * 2;
      const h0 = hgt[i]!, h1 = hgt[(i + 1) % N]!;
      const x0 = Math.cos(a0) * radius, z0 = Math.sin(a0) * radius, x1 = Math.cos(a1) * radius, z1 = Math.sin(a1) * radius;
      fp.push(x0, -1, z0, x1, -1, z1, x1, h1, z1, x0, -1, z0, x1, h1, z1, x0, h0, z0);
      cp.push(x0, h0, z0, x1, h1, z1);
    }
    const f = new BufferGeometry();
    f.setAttribute("position", new BufferAttribute(new Float32Array(fp), 3));
    const c = new BufferGeometry();
    c.setAttribute("position", new BufferAttribute(new Float32Array(cp), 3));
    return { fill: f, crest: c };
  }, [radius]);
  useEffect(
    () => () => {
      fill.dispose();
      crest.dispose();
    },
    [fill, crest]
  );
  return (
    <group>
      <mesh geometry={fill} renderOrder={-8}>
        <meshBasicMaterial color="#03070d" side={DoubleSide} fog={false} />
      </mesh>
      <lineSegments geometry={crest} renderOrder={-7}>
        <lineBasicMaterial color="#2c7fae" fog={false} transparent opacity={0.85} />
      </lineSegments>
    </group>
  );
}
