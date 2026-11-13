/* The Battleship ocean (2026-11-13): real water instead of a flat
   mirror.

   - Waves: five travelling sine waves (deep-water speeds) displace one
     big mesh whose vertices crowd near the boards and thin out towards
     the horizon (sinh spacing: one draw from the hulls to the fog).
     Normals are the waves' analytic gradient, plus finer ripples in the
     fragment shader, so the surface sparkles beyond what the mesh
     resolves.
   - Calm boards: inside the two ocean tiles (plus a soft margin) the
     swell drops to 12 %, so the grid, the letters and the hit and miss
     markers stay crisp; open water beyond rolls and foams. Sea level
     sits at OCEAN_Y, under the grid lines (y 0.06) even at a calm crest.
   - Light: the water's colour is a deep body lit from below by the
     crests, mixed with what it reflects by Fresnel - the night sky and
     aurora (an analytic copy of the sky dome's look), or on desktop a
     mirror render of the scene (ships, fires, the sky) rippled by the
     wave normals. A moon low behind the boards lays a glitter path on
     the far water, held off the boards so it never glares over them.
     Crest foam on open water.
   - It answers: ripple(x, z, s) sends a ring packet out from a shell's
     impact (a miss bigger than a hit), up to eight at once.
   - Time is the juice clock (it freezes in a hit-stop and crawls in
     slow motion); reduced motion freezes it entirely.
   - oceanHeight() is the CPU copy of the swell (no ripples), so ships
     ride the same water the shader draws. */
import { useEffect, useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  HalfFloatType,
  Matrix4,
  Mesh,
  PerspectiveCamera,
  Plane,
  ShaderMaterial,
  UniformsLib,
  UniformsUtils,
  Vector2,
  Vector3,
  Vector4,
  WebGLRenderTarget,
  type Object3D,
} from "three";
import { useJuice } from "./juice";

export const OCEAN_Y = -0.03;
const CALM = 0.12; // swell kept inside the boards
const CALM_EDGE = 1.8; // world units over which calm fades to open sea

/* [direction angle, amplitude, wavelength] - deep-water dispersion sets
   each wave's speed; SPEED slows the whole sea to a night swell. */
const WAVES: [number, number, number][] = [
  [0.35, 0.075, 7.5],
  [2.05, 0.05, 4.6],
  [-0.95, 0.034, 3.0],
  [1.25, 0.021, 1.85],
  [-2.45, 0.013, 1.15],
];
const SPEED = 0.55;
const WAVE_U = WAVES.map(([a, amp, len], i) => {
  const k = (2 * Math.PI) / len;
  return { dx: Math.cos(a), dz: Math.sin(a), amp, k, w: Math.sqrt(9.8 * k) * SPEED, ph: i * 1.7 };
});

export type CalmRect = { x: number; z: number; hw: number; hh: number };

function calmAt(x: number, z: number, calms: CalmRect[]): number {
  let c = 0;
  for (const r of calms) {
    const dx = Math.max(Math.abs(x - r.x) - r.hw, 0);
    const dz = Math.max(Math.abs(z - r.z) - r.hh, 0);
    const out = Math.hypot(dx, dz);
    const s = Math.min(1, Math.max(0, out / CALM_EDGE));
    c = Math.max(c, 1 - s * s * (3 - 2 * s));
  }
  return c;
}

/* The swell at a point (no ripples), its gradient, at juice time t. */
export function oceanHeight(x: number, z: number, t: number, calms: CalmRect[]): { h: number; gx: number; gz: number } {
  const a = 1 + (CALM - 1) * calmAt(x, z, calms);
  let h = 0;
  let gx = 0;
  let gz = 0;
  for (const wv of WAVE_U) {
    const ph = wv.k * (wv.dx * x + wv.dz * z) + wv.w * t + wv.ph;
    h += wv.amp * a * Math.sin(ph);
    const c = wv.amp * a * wv.k * Math.cos(ph);
    gx += c * wv.dx;
    gz += c * wv.dz;
  }
  return { h: OCEAN_Y + h, gx, gz };
}

/* What the scene tells the water: where the boards are, and impacts. */
export class OceanStore {
  calms: CalmRect[] = [];
  rip: Vector4[] = Array.from({ length: 8 }, () => new Vector4(0, 0, -99, 0));
  /* oil on the water: (x, z, radius, strength) around damaged and sunk
     hulls, set by the scene each render */
  slicks: Vector4[] = Array.from({ length: 10 }, () => new Vector4(0, 0, 0, 0));
  setSlicks(list: { x: number; z: number; r: number; s: number }[]) {
    this.slicks.forEach((v, i) => {
      const o = list[i];
      if (o) v.set(o.x, o.z, o.r, o.s);
      else v.set(0, 0, 0, 0);
    });
  }
  next = 0;
  t = 0;
  ripple(x: number, z: number, s: number) {
    const v = this.rip[this.next % this.rip.length]!;
    v.set(x, z, this.t, s);
    this.next++;
  }
}

/* One mesh from the boards to the horizon: vertices spaced by sinh, so
   ~0.14 units apart near the centre and metres apart in the fog. */
function oceanGeometry(nx: number, nz: number, extent: number): BufferGeometry {
  const K = 5;
  const map = (u: number) => (Math.sinh(K * u) / Math.sinh(K)) * extent;
  const pos = new Float32Array((nx + 1) * (nz + 1) * 3);
  let p = 0;
  for (let j = 0; j <= nz; j++) {
    const z = map((j / nz) * 2 - 1);
    for (let i = 0; i <= nx; i++) {
      pos[p++] = map((i / nx) * 2 - 1);
      pos[p++] = 0;
      pos[p++] = z;
    }
  }
  const idx = new Uint32Array(nx * nz * 6);
  let q = 0;
  for (let j = 0; j < nz; j++)
    for (let i = 0; i < nx; i++) {
      const a = j * (nx + 1) + i;
      const b = a + 1;
      const c = a + nx + 1;
      const d = c + 1;
      idx[q++] = a;
      idx[q++] = c;
      idx[q++] = b;
      idx[q++] = b;
      idx[q++] = c;
      idx[q++] = d;
    }
  const g = new BufferGeometry();
  g.setAttribute("position", new BufferAttribute(pos, 3));
  g.setIndex(new BufferAttribute(idx, 1));
  return g;
}

const VERT = /* glsl */ `
#include <common>
#include <fog_pars_vertex>
uniform float uTime;
uniform vec4 uCalm[2];
uniform int uCalmN;
uniform vec4 uW[5];
uniform vec2 uWP[5];
uniform vec4 uRip[8];
uniform float uSeaY;
varying vec3 vW;
varying vec3 vN;
varying float vH;
varying float vCalm;
float calmAt(vec2 p) {
  float c = 0.0;
  for (int i = 0; i < 2; i++) {
    if (i >= uCalmN) break;
    vec2 d = abs(p - uCalm[i].xy) - uCalm[i].zw;
    float s = clamp(length(max(d, 0.0)) / ${CALM_EDGE.toFixed(2)}, 0.0, 1.0);
    c = max(c, 1.0 - s * s * (3.0 - 2.0 * s));
  }
  return c;
}
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vec2 p = wp.xz;
  float c = calmAt(p);
  float a = mix(1.0, ${CALM.toFixed(2)}, c);
  float h = 0.0;
  vec2 g = vec2(0.0);
  for (int i = 0; i < 5; i++) {
    float ph = uW[i].w * dot(uW[i].xy, p) + uWP[i].x * uTime + uWP[i].y;
    float A = uW[i].z * a;
    h += A * sin(ph);
    g += A * uW[i].w * cos(ph) * uW[i].xy;
  }
  // impact rings: a packet racing out from each shell, fading
  for (int i = 0; i < 8; i++) {
    float s = uRip[i].w;
    float age = uTime - uRip[i].z;
    if (s <= 0.0 || age < 0.0 || age > 4.5) continue;
    vec2 dv = p - uRip[i].xy;
    float r = length(dv) + 1e-4;
    float env = exp(-pow((r - age * 2.4) / 0.85, 2.0)) * exp(-age * 0.85) * s;
    float ph = r * 5.5 - age * 12.0;
    h += 0.045 * env * sin(ph);
    g += 0.045 * env * 5.5 * cos(ph) * (dv / r);
  }
  wp.y = uSeaY + h;
  vW = wp.xyz;
  vN = normalize(vec3(-g.x, 1.0, -g.y));
  vH = h;
  vCalm = c;
  vec4 mvPosition = viewMatrix * wp;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;

const FRAG = /* glsl */ `
#include <common>
#include <fog_pars_fragment>
uniform float uTime;
uniform vec3 uDeep, uScatter, uHorizon, uMid, uTop, uGlow, uAurA, uAurB, uMoonDir, uMoonCol, uFoamCol;
uniform float uAurora, uUseMirror, uSeaY;
uniform vec4 uSlick[10];
uniform sampler2D uMirror;
uniform mat4 uMirrorMat;
varying vec3 vW;
varying vec3 vN;
varying float vH;
varying float vCalm;
vec2 micro(vec2 p, float t) {
  vec2 g = vec2(0.0);
  g += cos(dot(p, vec2(3.7, 1.9)) + t * 2.3) * vec2(3.7, 1.9);
  g += cos(dot(p, vec2(-2.3, 4.1)) + t * 2.9 + 1.3) * vec2(-2.3, 4.1);
  g += cos(dot(p, vec2(5.9, -3.1)) + t * 3.7 + 2.1) * vec2(5.9, -3.1) * 0.6;
  g += cos(dot(p, vec2(-7.3, -6.1)) + t * 4.4 + 0.4) * vec2(-7.3, -6.1) * 0.4;
  return g * 0.0035;
}
vec3 sky(vec3 r) {
  float el = r.y;
  float az = atan(r.x, r.z);
  vec3 c = mix(uHorizon + uGlow * 0.3, uMid, smoothstep(0.0, 0.3, el));
  c = mix(c, uTop, smoothstep(0.3, 0.9, el));
  float band = smoothstep(0.04, 0.2, el) * (1.0 - smoothstep(0.28, 0.72, el));
  float cur = pow(0.5 + 0.5 * sin(az * 7.0 + uTime * 0.12 + 2.0 * sin(az * 3.0 - uTime * 0.05)), 2.5);
  c += mix(uAurA, uAurB, smoothstep(0.08, 0.5, el)) * band * cur * uAurora;
  return c;
}
float hash2(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash2(i), hash2(i + vec2(1.0, 0.0)), u.x), mix(hash2(i + vec2(0.0, 1.0)), hash2(i + vec2(1.0, 1.0)), u.x), u.y);
}
/* Glitter: finer, faster facets used only for the moon's highlight -
   the swell alone made the glints broad white blotches. */
vec2 sparkle(vec2 p, float t) {
  vec2 g = vec2(0.0);
  g += cos(dot(p, vec2(17.3, 6.1)) + t * 5.1) * vec2(17.3, 6.1);
  g += cos(dot(p, vec2(-9.7, 19.9)) + t * 6.3 + 2.0) * vec2(-9.7, 19.9);
  g += cos(dot(p, vec2(23.1, -14.2)) + t * 7.7 + 4.1) * vec2(23.1, -14.2);
  return g * 0.0042;
}
float oilAt(vec2 p) {
  float o = 0.0;
  for (int i = 0; i < 10; i++) {
    vec4 s = uSlick[i];
    if (s.z <= 0.0) continue;
    vec2 d = p - s.xy;
    // a ragged edge: the radius wanders with the angle and drifts
    float a = atan(d.y, d.x);
    float r = s.z * (0.82 + 0.18 * sin(a * 3.0 + s.x) * sin(a * 5.0 - uTime * 0.05 + s.y));
    o = max(o, s.w * smoothstep(r, r * 0.55, length(d)));
  }
  return o;
}
void main() {
  vec3 V = normalize(cameraPosition - vW);
  // fine detail fades with distance: far away it only aliased into rings
  float near = smoothstep(55.0, 14.0, length(cameraPosition - vW));
  float oil = oilAt(vW.xz);
  near *= 1.0 - 0.8 * oil; // oil flattens the small ripples
  vec2 mg = micro(vW.xz, uTime) * mix(1.0, 0.45, vCalm) * near;
  vec3 N = normalize(vN + vec3(-mg.x, 0.0, -mg.y));
  float NV = max(dot(N, V), 0.0);
  float F = 0.02 + 0.98 * pow(1.0 - NV, 5.0);
  vec3 R = reflect(-V, N);
  R.y = abs(R.y);
  vec3 refl = sky(R);
  if (uUseMirror > 0.5) {
    vec4 pc = uMirrorMat * vec4(vW.x, uSeaY, vW.z, 1.0);
    vec2 uv = clamp(pc.xy / pc.w + N.xz * 0.045, 0.001, 0.999);
    refl = texture2D(uMirror, uv).rgb;
  }
  vec3 L = normalize(uMoonDir);
  vec2 sg = sparkle(vW.xz, uTime) * near;
  vec3 Ns = normalize(N + vec3(-sg.x, 0.0, -sg.y));
  float rl = max(dot(reflect(-V, Ns), L), 0.0);
  float glare = 1.0 - vCalm * 0.92;
  float spec = (pow(rl, 2200.0) * 2.4 + pow(rl, 140.0) * 0.06) * glare;
  float lam = max(dot(N, L), 0.0);
  float crest = clamp(vH / 0.17, 0.0, 1.0);
  vec3 body = uDeep + uScatter * (0.18 + 0.75 * crest) * (0.45 + 0.55 * lam);
  vec3 col = mix(body, refl, clamp(F * 1.15, 0.0, 1.0)) + uMoonCol * spec;
  // oil: a darker, glassier surface with a thin-film rainbow sheen
  float film = vnoise(vW.xz * 3.1 + uTime * 0.03) * 2.0 + F * 4.0 + vH * 20.0;
  vec3 rainbow = 0.5 + 0.5 * cos(6.2832 * (vec3(0.0, 0.33, 0.67) + film));
  col = mix(col, col * 0.5 + rainbow * (0.006 + 0.045 * F), oil * 0.8);
  float foam = smoothstep(0.105, 0.17, vH) * (1.0 - vCalm) * (1.0 - oil);
  // broken, drifting foam (a sine pattern read as rows of chevrons)
  float fn = vnoise(vW.xz * 2.1 + vec2(uTime * 0.13, -uTime * 0.07)) * 0.65 + vnoise(vW.xz * 6.3 - uTime * 0.11) * 0.35;
  foam *= smoothstep(0.38, 0.78, fn);
  col = mix(col, uFoamCol, clamp(foam, 0.0, 1.0) * 0.55);
  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
  #include <fog_fragment>
}`;

export type OceanLook = {
  deep: string;
  scatter: string;
  horizon: string;
  mid: string;
  top: string;
  glow: string;
  auroraA: string;
  auroraB: string;
  aurora: number;
  moonDir: [number, number, number];
  moon: string;
};

/* Things the mirror must not show: the grid hologram, labels, markers
   and rings (their reflections would read as a second, sunken board). */
export const NO_MIRROR = "noMirror";

export function Ocean({ store, look, lite, still }: { store: OceanStore; look: OceanLook; lite: boolean; still: boolean }) {
  const j = useJuice();
  const mesh = useRef<Mesh>(null);
  const { gl, scene, camera, size } = useThree();
  const geo = useMemo(() => (lite ? oceanGeometry(150, 120, 220) : oceanGeometry(230, 180, 220)), [lite]);
  useEffect(() => () => geo.dispose(), [geo]);
  const rt = useMemo(() => (lite ? null : new WebGLRenderTarget(512, 512, { type: HalfFloatType })), [lite]);
  useEffect(() => () => rt?.dispose(), [rt]);
  const mat = useMemo(() => {
    const m = new ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      fog: true,
      uniforms: UniformsUtils.merge([
        UniformsLib.fog,
        {
          uTime: { value: 0 },
          uSeaY: { value: OCEAN_Y },
          uCalm: { value: [new Vector4(), new Vector4()] },
          uCalmN: { value: 0 },
          uW: { value: WAVE_U.map((w) => new Vector4(w.dx, w.dz, w.amp, w.k)) },
          uWP: { value: WAVE_U.map((w) => new Vector2(w.w, w.ph)) },
          uRip: { value: store.rip },
          uDeep: { value: new Color() },
          uScatter: { value: new Color() },
          uHorizon: { value: new Color() },
          uMid: { value: new Color() },
          uTop: { value: new Color() },
          uGlow: { value: new Color() },
          uAurA: { value: new Color() },
          uAurB: { value: new Color() },
          uMoonDir: { value: new Vector3() },
          uMoonCol: { value: new Color() },
          uFoamCol: { value: new Color("#9fb6c4") },
          uAurora: { value: 0 },
          uUseMirror: { value: 0 },
          uMirror: { value: null },
          uMirrorMat: { value: new Matrix4() },
        },
      ]),
    });
    // merge() cloned the arrays: point the ripples and oil back at the store's
    m.uniforms.uRip!.value = store.rip;
    m.uniforms.uSlick = { value: store.slicks };
    return m;
  }, [store]);
  useEffect(() => () => mat.dispose(), [mat]);
  useEffect(() => {
    const u = mat.uniforms;
    (u.uDeep!.value as Color).set(look.deep);
    (u.uScatter!.value as Color).set(look.scatter);
    (u.uHorizon!.value as Color).set(look.horizon);
    (u.uMid!.value as Color).set(look.mid);
    (u.uTop!.value as Color).set(look.top);
    (u.uGlow!.value as Color).set(look.glow);
    (u.uAurA!.value as Color).set(look.auroraA);
    (u.uAurB!.value as Color).set(look.auroraB);
    (u.uMoonCol!.value as Color).set(look.moon).multiplyScalar(1.6);
    (u.uMoonDir!.value as Vector3).set(...look.moonDir).normalize();
    u.uAurora!.value = look.aurora;
  }, [mat, look]);

  /* The mirror (desktop): the scene seen from below the sea plane,
     clipped at the surface (an oblique near plane), into a half-size
     target the water samples with its ripples. Ported from three's
     Reflector for a horizontal plane at the sea level. */
  const mirror = useMemo(
    () => ({
      cam: new PerspectiveCamera(),
      tex: new Matrix4(),
      v: new Vector3(),
      look: new Vector3(),
      target: new Vector3(),
      plane: new Plane(),
      clip: new Vector4(),
      q: new Vector4(),
      n: new Vector3(0, 1, 0),
      p: new Vector3(0, OCEAN_Y, 0),
      hidden: [] as Object3D[],
    }),
    []
  );
  useEffect(() => {
    if (rt) rt.setSize(Math.max(256, Math.floor(size.width * 0.6)), Math.max(256, Math.floor(size.height * 0.6)));
  }, [rt, size.width, size.height]);

  useFrame(() => {
    const m = mesh.current;
    if (!m) return;
    if (!still) store.t = j.t;
    const u = mat.uniforms;
    u.uTime!.value = still ? 7.3 : j.t;
    const calms = store.calms;
    u.uCalmN!.value = Math.min(2, calms.length);
    calms.slice(0, 2).forEach((c, i) => (u.uCalm!.value as Vector4[])[i]!.set(c.x, c.z, c.hw, c.hh));
    if (!rt) {
      u.uUseMirror!.value = 0;
      return;
    }
    const cam = camera as PerspectiveCamera;
    const M = mirror;
    const rc = M.cam;
    // mirror the camera about the sea plane
    M.v.setFromMatrixPosition(cam.matrixWorld);
    const camPos = M.v.clone();
    const view = M.p.clone().sub(camPos);
    view.reflect(M.n).negate().add(M.p);
    M.look.set(0, 0, -1).applyMatrix4(new Matrix4().extractRotation(cam.matrixWorld)).add(camPos);
    M.target.subVectors(M.p, M.look).reflect(M.n).negate().add(M.p);
    rc.position.copy(view);
    rc.up.set(0, 1, 0).applyMatrix4(new Matrix4().extractRotation(cam.matrixWorld)).reflect(M.n);
    rc.lookAt(M.target);
    rc.far = cam.far;
    rc.updateMatrixWorld();
    rc.projectionMatrix.copy(cam.projectionMatrix);
    rc.projectionMatrix.elements[8] *= -1;
    rc.projectionMatrix.elements[12] *= -1;
    M.tex.set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1);
    M.tex.multiply(rc.projectionMatrix).multiply(rc.matrixWorldInverse);
    // oblique clip: nothing under the surface reaches the mirror
    M.plane.setFromNormalAndCoplanarPoint(M.n, M.p).applyMatrix4(rc.matrixWorldInverse);
    M.clip.set(M.plane.normal.x, M.plane.normal.y, M.plane.normal.z, M.plane.constant);
    const pm = rc.projectionMatrix.elements;
    M.q.set((Math.sign(M.clip.x) + pm[8]!) / pm[0]!, (Math.sign(M.clip.y) + pm[9]!) / pm[5]!, -1, (1 + pm[10]!) / pm[14]!);
    M.clip.multiplyScalar(2 / M.clip.dot(M.q));
    pm[2] = M.clip.x;
    pm[6] = M.clip.y;
    pm[10] = M.clip.z + 1 - 0.003;
    pm[14] = M.clip.w;
    // render, without the water itself and the board overlays
    M.hidden.length = 0;
    scene.traverse((o) => {
      if (o.visible && o.userData[NO_MIRROR]) {
        M.hidden.push(o);
        o.visible = false;
      }
    });
    m.visible = false;
    const prev = gl.getRenderTarget();
    const prevXr = gl.xr.enabled;
    gl.xr.enabled = false;
    gl.setRenderTarget(rt);
    gl.clear();
    gl.render(scene, rc);
    gl.setRenderTarget(prev);
    gl.xr.enabled = prevXr;
    m.visible = true;
    M.hidden.forEach((o) => (o.visible = true));
    u.uMirror!.value = rt.texture;
    (u.uMirrorMat!.value as Matrix4).copy(M.tex);
    u.uUseMirror!.value = 1;
  });
  return <mesh ref={mesh} geometry={geo} material={mat} frustumCulled={false} renderOrder={-1} />;
}
