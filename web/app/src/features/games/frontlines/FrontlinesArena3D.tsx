/* Frontlines in 3D (2026-11-19): troops over hills at dusk.

   The world: five low hills in a shallow arc on a dark field under a warm
   dusk horizon. Each commander's army stands on their side of every hill
   as a formation of glowing units (one unit per 5 troops): yours on the
   near side, the rival's on the far side (a spectator sees the match's
   order). A front line runs behind each army: dim and breathing while
   that commander plans, lit once they have committed. A split stays
   secret until the round resolves: the scene never shows a pending one.

   A resolved round plays as a reveal (the skill's commit -> anticipate ->
   reveal -> linger arc), every beat a function of juice time:
     deploy    both armies rise out of the ground on every hill
     clash     hill by hill, A to E: both formations push up the slope;
               the smaller army falls in a burst of its colour and the
               winner's banner rises on the crest (a level hill: both
               fall back, no banner)
     verdict   the round's title card, sound and buzz
     finish    the round that ends the match: a pillar of light behind
               the winner's line, a shockwave across the field
   The banners and the standing armies stay on the field until the next
   round lands: the last round is the record a latecomer reads.

   Catch-up: rounds often resolve while the viewer is away. The rounds
   seen are remembered per game (localStorage); on opening, the latest
   unseen round replays in full (earlier ones are in the History tab). A
   tap skips to the verdict.

   Reduced motion: no deploy, push or camera moves; a round lands at
   once with its title card, sound and buzz. The planner, the score and
   the numbers stay in the DOM: the scene shows, the page acts. */
import { useEffect, useEffectEvent, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { CameraControls } from "@react-three/drei";
import { BufferGeometry, CanvasTexture, CatmullRomCurve3, Color, DoubleSide, Float32BufferAttribute, Object3D, SphereGeometry, SRGBColorSpace, TubeGeometry, Vector3, type Group, type InstancedMesh, type MeshStandardMaterial, type Sprite } from "three";
import { ArenaFrame, FirstFrame, Framer, Ticker, TouchControls, goHome, useQuality, useReducedMotion, type Ctl, type Home } from "../three/arena3d";
import { ArenaPost, ImpactLayer, Intro, JuiceProvider, JuiceRig, SoundToggle, useFirstVisit, useJuice, useJuiceStore, type Impact } from "../three/juice";
import { Burst, LightPillar, Shockwave, SkyDome, type SkySpec } from "../three/atmos";
import { BUZZ, sfx } from "../three/sfx";
import type { FrontlinesPlayer, FrontlinesRound, FrontlinesState } from "@chat/contract";
import { useOnChange } from "../../../lib/useOnChange";

// One empty list for matches without players or rounds yet, so the memos
// below keep their inputs from one render to the next.
const NO_ITEMS: never[] = [];

const FL_SKY: SkySpec = {
  top: "#05070f",
  mid: "#151a36",
  horizon: "#8a4424",
  ground: "#050706",
  glow: "#f59e0b",
  glowAmt: 0.42,
  stars: 0.05,
};

const HILLS = 5;
const UNIT = 5; // troops per unit
const MAX_UNITS = 20; // 100 troops
const RX = 1.65;
const RY = 0.9;
const RZ = 1.5;
const BEND = 0.6; // how far the arc's ends come toward the near side
const LINE_OFF = 2.15; // a front line's distance behind its hills
const PITCH = 0.27; // a unit's spacing in its formation
const FIRE = new Color("#ffb04a").multiplyScalar(3);
const UNIT_W = 0.2;
const UNIT_H = 0.4;
const LETTERS = ["A", "B", "C", "D", "E"];
const PHONE_BELOW = 560;
// the reveal's beats, in seconds of juice time
const DEPLOY = 0.6;
const FIRST_CLASH = 0.95;
const CLASH_GAP = 0.55;
const VERDICT = FIRST_CLASH + HILLS * CLASH_GAP + 0.15;

type Side = { name: string; hex: string; you: boolean; committed: boolean; wins: number; sign: 1 | -1 };

function gapOf(phone: boolean) {
  return phone ? 3.4 : 3.9;
}
function arcZ(k: number) {
  return BEND * k * k - 0.9;
}
function hillPos(i: number, phone: boolean): [number, number, number] {
  const k = i - (HILLS - 1) / 2;
  return [k * gapOf(phone), 0, arcZ(k)];
}

function moundY(dx: number, dz: number): number {
  const v = 1 - (dx / RX) ** 2 - (dz / RZ) ** 2;
  return v > 0 ? RY * Math.sqrt(v) : 0;
}

const smooth = (a: number, b: number, t: number) => {
  const x = Math.min(1, Math.max(0, (t - a) / (b - a)));
  return x * x * (3 - 2 * x);
};

/* ---------- hill labels: a sprite per hill, drawn on a canvas ---------- */

const labelCache = new Map<string, CanvasTexture>();
function labelTex(letter: string, val: number | null): CanvasTexture {
  const key = letter + ":" + (val == null ? "" : val);
  const hit = labelCache.get(key);
  if (hit) return hit;
  const c = document.createElement("canvas");
  c.width = 256;
  c.height = 128;
  const x = c.getContext("2d");
  if (x) {
    x.textAlign = "center";
    x.textBaseline = "middle";
    x.shadowColor = "rgba(0,0,0,0.8)";
    x.shadowBlur = 10;
    x.font = "800 76px system-ui, -apple-system, Segoe UI, sans-serif";
    x.fillStyle = "rgba(236,246,252,0.96)";
    x.fillText(letter, val == null ? 128 : 84, 66);
    if (val != null) {
      x.font = "800 44px system-ui, -apple-system, Segoe UI, sans-serif";
      x.fillStyle = "#fde68a";
      x.fillText(val + (val === 1 ? "pt" : "pts"), 172, 70);
    }
  }
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  labelCache.set(key, t);
  return t;
}

/* The round in numbers on each hill (2026-11-20, the page's field
   folded into the scene): each side's troops in its colour, the hill's
   winner bright, a level hill's both dim. */
type Count = { n: number; hex: string; won: boolean };
const countCache = new Map<string, CanvasTexture>();
function countTex(counts: Count[]): CanvasTexture {
  const key = counts.map((c) => c.n + c.hex + (c.won ? "w" : "")).join("|");
  const hit = countCache.get(key);
  if (hit) return hit;
  const c = document.createElement("canvas");
  c.width = 320;
  c.height = 96;
  const x = c.getContext("2d");
  if (x) {
    x.textAlign = "center";
    x.textBaseline = "middle";
    x.shadowColor = "rgba(0,0,0,0.9)";
    x.shadowBlur = 10;
    const slot = 320 / Math.max(1, counts.length);
    counts.forEach((k, i) => {
      x.globalAlpha = k.won ? 1 : 0.62;
      x.font = (k.won ? "900 62px" : "700 54px") + " system-ui, -apple-system, Segoe UI, sans-serif";
      x.fillStyle = k.hex;
      x.fillText(String(k.n), slot * i + slot / 2, 50);
    });
    x.globalAlpha = 0.5;
    x.fillStyle = "#e2e8f0";
    x.font = "700 40px system-ui, -apple-system, Segoe UI, sans-serif";
    if (counts.length === 2) x.fillText("·", 160, 48);
  }
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  countCache.set(key, t);
  return t;
}

/* ---------- the field ---------- */

function Ground({ phone }: { phone: boolean }) {
  const hillGeo = useMemo(() => new SphereGeometry(1, 40, 16, 0, Math.PI * 2, 0, Math.PI / 2), []);
  useEffect(() => () => hillGeo.dispose(), [hillGeo]);
  return (
    <group>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.01, 0]}>
        <planeGeometry args={[400, 400]} />
        <meshStandardMaterial color="#0b100c" roughness={1} metalness={0} />
      </mesh>
      {Array.from({ length: HILLS }, (_, i) => (
        <mesh key={i} geometry={hillGeo} position={hillPos(i, phone)} scale={[RX, RY, RZ]}>
          <meshStandardMaterial color="#34503b" roughness={0.88} metalness={0} />
        </mesh>
      ))}
    </group>
  );
}

/* A hill's ring at its foot, its letter (and value) above, and its banner
   on the crest in the colour of whoever holds it. During a reveal the
   banner rises with the hill's clash; settled, it stands (none on a
   level hill). */
function HillMark({ i, phone, hex, letter, val, t0, still, counts }: { i: number; phone: boolean; hex: string | null; letter: string; val: number | null; t0: number | null; still: boolean; counts: Count[] | null }) {
  const p = hillPos(i, phone);
  const flag = useRef<Group>(null);
  const nums = useRef<Sprite>(null);
  const ring = useRef<MeshStandardMaterial>(null);
  const j = useJuice();
  const c = useMemo(() => new Color(hex || "#64748b"), [hex]);
  const grey = useMemo(() => new Color("#64748b"), []);
  useFrame(() => {
    const t = t0 == null || still ? Infinity : j.t - t0;
    const ti = FIRST_CLASH + i * CLASH_GAP;
    const r = t === Infinity ? 1 : smooth(ti, ti + 0.35, t);
    if (flag.current) {
      flag.current.scale.set(1, Math.max(0.001, r), 1);
      flag.current.visible = !!hex && r > 0.001;
    }
    // the numbers come up with the hill's clash, like its banner
    if (nums.current) nums.current.visible = r > 0.5;
    // the ring keeps the hill's secret until its clash
    if (ring.current) {
      ring.current.emissive.copy(hex && r > 0.02 ? c : grey);
      ring.current.emissiveIntensity = hex ? 0.3 + 0.9 * r : 0.3;
    }
  });
  return (
    <group position={p}>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.02, 0]} scale={[RX * 1.06, RZ * 1.06, 1]}>
        <ringGeometry args={[0.95, 1, 56]} />
        <meshStandardMaterial ref={ring} color="#000" emissive={c} emissiveIntensity={0.35} toneMapped={false} />
      </mesh>
      <group ref={flag} position={[0, RY - 0.03, 0]}>
        <mesh position={[0, 0.6, 0]}>
          <cylinderGeometry args={[0.03, 0.03, 1.2, 6]} />
          <meshStandardMaterial color="#e2e8f0" metalness={0.1} roughness={0.5} />
        </mesh>
        <mesh position={[0.3, 1.02, 0]}>
          <boxGeometry args={[0.58, 0.34, 0.03]} />
          <meshStandardMaterial color="#000" emissive={c} emissiveIntensity={1.5} toneMapped={false} />
        </mesh>
      </group>
      <sprite position={[0, RY + 1.85, 0]} scale={[1.5, 0.75, 1]} renderOrder={5}>
        <spriteMaterial map={labelTex(letter, val)} transparent depthWrite={false} depthTest={false} />
      </sprite>
      {counts ? (
        <sprite ref={nums} position={[0, RY + 1.28, 0]} scale={phone ? [2.3, 0.69, 1] : [1.9, 0.57, 1]} renderOrder={5}>
          <spriteMaterial map={countTex(counts)} transparent depthWrite={false} depthTest={false} />
        </sprite>
      ) : null}
    </group>
  );
}

/* A front line behind each army, following the arc of the hills: lit
   once that commander has committed this round, breathing while they
   plan. */
function FrontLine({ side, phone, lit, still }: { side: Side; phone: boolean; lit: boolean; still: boolean }) {
  const mat = useRef<MeshStandardMaterial>(null);
  const j = useJuice();
  const geo = useMemo(() => {
    const pts: Vector3[] = [];
    for (let k = -2.4; k <= 2.401; k += 0.4) pts.push(new Vector3(k * gapOf(phone), 0.05, arcZ(k) + side.sign * LINE_OFF));
    return new TubeGeometry(new CatmullRomCurve3(pts), 64, 0.045, 6, false);
  }, [phone, side.sign]);
  useEffect(() => () => geo.dispose(), [geo]);
  useFrame(() => {
    const m = mat.current;
    if (!m) return;
    m.emissiveIntensity = lit ? 2.6 : 0.4 + (still ? 0 : 0.22 * Math.sin(j.t * 2.1));
  });
  return (
    <mesh geometry={geo}>
      <meshStandardMaterial ref={mat} color="#000" emissive={side.hex} emissiveIntensity={0.5} toneMapped={false} />
    </mesh>
  );
}

/* One army: every unit on every hill for one side - the standing units
   in one glowing instanced draw, the fallen in one dim one (the losers of
   a hill lie toppled where they stood: the record a latecomer reads). The
   reveal clock (juice.t - t0; settled when t0 is null) drives the deploy,
   the push up the slope and the fall. */
function Army({ side, alloc, hills, phone, t0, still }: { side: Side; alloc: number[] | null; hills: (string | null)[] | null; phone: boolean; t0: number | null; still: boolean }) {
  const up = useRef<InstancedMesh>(null);
  const down = useRef<InstancedMesh>(null);
  const j = useJuice();
  const tmp = useMemo(() => new Object3D(), []);
  const settled = useRef(false);
  useOnChange([alloc, hills, t0, phone, still], () => {
    settled.current = false;
  });
  useFrame((state) => {
    const a = up.current;
    const b = down.current;
    if (!a || !b) return;
    const t = t0 == null || still ? Infinity : j.t - t0;
    if (settled.current && t === Infinity) return;
    let na = 0;
    let nb = 0;
    for (let i = 0; i < HILLS; i++) {
      const units = alloc ? Math.min(MAX_UNITS, Math.round((alloc[i] || 0) / UNIT)) : 0;
      const owner = hills ? hills[i] : null;
      const lost = !!hills && owner != null && owner !== side.name;
      const level = !!hills && owner == null;
      const ti = FIRST_CLASH + i * CLASH_GAP;
      const push = smooth(ti - 0.32, ti, t);
      const after = smooth(ti, ti + 0.35, t);
      const [hx, , hz] = hillPos(i, phone);
      for (let k = 0; k < units; k++) {
        const row = Math.floor(k / 5);
        const col = k % 5;
        const rise = smooth(k * 0.012, DEPLOY + k * 0.012, t);
        const dx = (col - 2) * PITCH;
        let dz = side.sign * (0.45 + row * PITCH);
        dz -= side.sign * 0.2 * push;
        if (level) dz += side.sign * 0.16 * after;
        const fall = lost ? after : 0;
        const gy = moundY(dx, dz);
        if (fall < 1) {
          const s = Math.max(0.0001, rise * (1 - fall));
          tmp.position.set(hx + dx, gy + UNIT_H * 0.5 * s - 0.04 * (1 - rise), hz + dz);
          tmp.rotation.set(fall * 1.2 * side.sign, 0, 0);
          tmp.scale.set(s, s, s);
          tmp.updateMatrix();
          a.setMatrixAt(na++, tmp.matrix);
        }
        if (fall > 0) {
          // toppled, lying back down the slope
          tmp.position.set(hx + dx, gy + 0.07, hz + dz + side.sign * 0.06);
          tmp.rotation.set((Math.PI / 2) * side.sign, 0, (k % 3) * 0.35 - 0.35);
          tmp.scale.set(fall, fall, fall);
          tmp.updateMatrix();
          b.setMatrixAt(nb++, tmp.matrix);
        }
      }
    }
    a.count = na;
    b.count = nb;
    a.instanceMatrix.needsUpdate = true;
    b.instanceMatrix.needsUpdate = true;
    if (t === Infinity) settled.current = true;
    else state.invalidate();
  });
  return (
    <>
      <instancedMesh ref={up} args={[undefined, undefined, HILLS * MAX_UNITS]} frustumCulled={false}>
        <boxGeometry args={[UNIT_W, UNIT_H, UNIT_W]} />
        <meshStandardMaterial color={side.hex} emissive={side.hex} emissiveIntensity={1.15} toneMapped={false} roughness={0.45} />
      </instancedMesh>
      <instancedMesh ref={down} args={[undefined, undefined, HILLS * MAX_UNITS]} frustumCulled={false}>
        <boxGeometry args={[UNIT_W, UNIT_H, UNIT_W]} />
        <meshStandardMaterial color="#2a2f36" emissive={side.hex} emissiveIntensity={0.12} roughness={0.8} />
      </instancedMesh>
    </>
  );
}

/* Each commander's camp behind their front line: a loose row of tents
   with a campfire or two, and low downs fading into the haze beyond -
   the field sits in a country, not a void. */
function Camps({ sides, phone }: { sides: Side[]; phone: boolean }) {
  const tents = useRef<InstancedMesh>(null);
  const fires = useRef<InstancedMesh>(null);
  const downs = useRef<InstancedMesh>(null);
  const layout = useMemo(() => {
    let seed = 11;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const t: { x: number; z: number; r: number; s: number; side: number }[] = [];
    const f: { x: number; z: number }[] = [];
    sides.forEach((sd, si) => {
      for (let n = 0; n < 9; n++) {
        const k = -2.4 + (4.8 * n) / 8 + (rnd() - 0.5) * 0.25;
        // the near camp sits further back: mostly under the frame's edge
        const back = LINE_OFF + (sd.sign > 0 ? 2.6 : 1.3) + rnd() * 1.4;
        t.push({ x: k * gapOf(phone), z: arcZ(k) * 0.6 + sd.sign * back, r: rnd() * Math.PI, s: 0.8 + rnd() * 0.5, side: si });
        if (n % 3 === 1) f.push({ x: k * gapOf(phone) + 0.9, z: arcZ(k) * 0.6 + sd.sign * (back - 0.5) });
      }
    });
    const dn: { x: number; z: number; sx: number; sy: number; sz: number }[] = [];
    for (let n = 0; n < 16; n++) {
      const x = (rnd() - 0.5) * 90;
      const z = -14 - rnd() * 40;
      dn.push({ x, z, sx: 5 + rnd() * 7, sy: 0.8 + rnd() * 1.8, sz: 3 + rnd() * 4 });
    }
    return { t, f, dn };
  }, [sides, phone]);
  useLayoutEffect(() => {
    const o = new Object3D();
    const c = new Color();
    const a = tents.current;
    if (a) {
      layout.t.forEach((p, i) => {
        o.position.set(p.x, 0.3 * p.s, p.z);
        o.rotation.set(0, p.r, 0);
        o.scale.setScalar(p.s);
        o.updateMatrix();
        a.setMatrixAt(i, o.matrix);
        c.set(sides[p.side] ? sides[p.side]!.hex : "#888").multiplyScalar(0.2);
        a.setColorAt(i, c);
      });
      a.count = layout.t.length;
      a.instanceMatrix.needsUpdate = true;
      if (a.instanceColor) a.instanceColor.needsUpdate = true;
    }
    const b = fires.current;
    if (b) {
      layout.f.forEach((p, i) => {
        o.position.set(p.x, 0.1, p.z);
        o.rotation.set(0, 0, 0);
        o.scale.setScalar(1);
        o.updateMatrix();
        b.setMatrixAt(i, o.matrix);
      });
      b.count = layout.f.length;
      b.instanceMatrix.needsUpdate = true;
    }
    const d = downs.current;
    if (d) {
      layout.dn.forEach((p, i) => {
        o.position.set(p.x, 0, p.z);
        o.rotation.set(0, 0, 0);
        o.scale.set(p.sx, p.sy, p.sz);
        o.updateMatrix();
        d.setMatrixAt(i, o.matrix);
      });
      d.count = layout.dn.length;
      d.instanceMatrix.needsUpdate = true;
    }
  }, [layout, sides]);
  const dome = useMemo(() => new SphereGeometry(1, 20, 8, 0, Math.PI * 2, 0, Math.PI / 2), []);
  useEffect(() => () => dome.dispose(), [dome]);
  return (
    <>
      <instancedMesh ref={tents} args={[undefined, undefined, 24]} frustumCulled={false}>
        <coneGeometry args={[0.42, 0.6, 4]} />
        <meshStandardMaterial roughness={0.85} />
      </instancedMesh>
      <instancedMesh ref={fires} args={[undefined, undefined, 8]} frustumCulled={false}>
        <sphereGeometry args={[0.09, 8, 6]} />
        <meshBasicMaterial color={FIRE} toneMapped={false} />
      </instancedMesh>
      <instancedMesh ref={downs} args={[dome, undefined, 16]} frustumCulled={false}>
        <meshStandardMaterial color="#1f1c16" roughness={1} />
      </instancedMesh>
    </>
  );
}

/* Far ridges on the horizon: a dark jagged ring, half lost in the dusk
   haze - the field is somewhere, not a floor in a void. */
function Ridges() {
  const geo = useMemo(() => {
    const n = 160;
    const R = 92;
    const pos: number[] = [];
    const idx: number[] = [];
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const hs: number[] = [];
    for (let i = 0; i <= n; i++) {
      const a = (i / n) * Math.PI * 2;
      const h = 1.6 + 2.6 * Math.abs(Math.sin(a * 3.1 + 0.6)) + 1.6 * Math.abs(Math.sin(a * 7.3)) + 0.9 * rnd();
      hs.push(i === n ? hs[0] || h : h);
    }
    for (let i = 0; i <= n; i++) {
      const a = (i / n) * Math.PI * 2;
      const x = Math.sin(a) * R;
      const z = -Math.cos(a) * R;
      pos.push(x, -0.5, z, x, hs[i] || 3, z);
      if (i < n) {
        const b = i * 2;
        idx.push(b, b + 2, b + 1, b + 1, b + 2, b + 3);
      }
    }
    const g = new BufferGeometry();
    g.setAttribute("position", new Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  }, []);
  useEffect(() => () => geo.dispose(), [geo]);
  return (
    <mesh geometry={geo}>
      <meshBasicMaterial color="#120d10" side={DoubleSide} />
    </mesh>
  );
}

/* The reveal's clock: the first frame after a reveal mounts captures the
   juice time it starts at. */
function ClockStart({ onStart }: { onStart: (t: number) => void }) {
  const j = useJuice();
  const done = useRef(false);
  useFrame((state) => {
    if (done.current) return;
    done.current = true;
    onStart(j.t);
    state.invalidate();
  });
  return null;
}

/* The reveal's beat keeper: fires each hill's clash (a sound, a burst in
   the loser's colour, a light shake) and the verdict, once each, on the
   juice clock; then says it is done. */
function Beats({
  round,
  sides,
  t0,
  verdict,
  holdAfter,
  onHill,
  onVerdict,
  onDone,
}: {
  round: FrontlinesRound;
  sides: Side[];
  t0: number;
  verdict: Impact;
  holdAfter: number;
  onHill: (i: number, hex: string | null) => void;
  onVerdict: () => void;
  onDone: () => void;
}) {
  const j = useJuice();
  const fired = useRef(new Set<string>());
  useFrame((state) => {
    const t = j.t - t0;
    state.invalidate();
    for (let i = 0; i < HILLS; i++) {
      const key = "h" + i;
      if (t >= FIRST_CLASH + i * CLASH_GAP && !fired.current.has(key)) {
        fired.current.add(key);
        const owner = round.hills ? round.hills[i] : null;
        const loser = owner ? sides.find((s) => s.name !== owner) || null : null;
        const lostUnits = loser ? Math.round((((round.alloc || {})[loser.name] || [])[i] || 0) / UNIT) : 0;
        const mine = !!owner && sides.some((s) => s.you && s.name === owner);
        sfx(owner ? "zap" : "whoosh");
        if (owner) j.hit({ trauma: mine ? 0.12 : 0.08, stop: 30 });
        onHill(i, lostUnits > 0 && loser ? loser.hex : null);
      }
    }
    if (t >= VERDICT && !fired.current.has("v")) {
      fired.current.add("v");
      j.hit(verdict);
      onVerdict();
    }
    if (t >= VERDICT + holdAfter && !fired.current.has("done")) {
      fired.current.add("done");
      onDone();
    }
  });
  return null;
}

/* ---------- impacts from the viewer's seat ---------- */

function verdictImpact(round: FrontlinesRound, sides: Side[], final: boolean, matchWinner: string, scoreLine: string): Impact {
  const you = sides.find((s) => s.you);
  const w = round.winner as string | null;
  if (final && matchWinner) {
    if (you && you.name === matchWinner)
      return { trauma: 0.8, stop: 250, slow: 0.8, pulse: 1, buzz: BUZZ.wonMatch, sound: ["clash", "win"], title: { big: "VICTORY", small: "You take the field · " + scoreLine, tone: "good" } };
    if (you) return { trauma: 0.8, stop: 250, slow: 0.8, pulse: 0.8, buzz: BUZZ.lostMatch, sound: ["clash", "lose"], title: { big: "DEFEAT", small: matchWinner + " takes the field · " + scoreLine, tone: "bad" } };
    return { trauma: 0.6, stop: 200, slow: 0.6, pulse: 0.8, buzz: BUZZ.scored, sound: ["clash", "win"], title: { big: matchWinner.toUpperCase() + " WINS", small: scoreLine, tone: "neutral" } };
  }
  const how = round.forfeit ? " by forfeit" : "";
  if (!w) return { trauma: 0.12, stop: 50, sound: "whoosh", title: { big: "LEVEL", small: "Round " + round.n + " · no score · " + scoreLine, tone: "neutral" } };
  if (you && you.name === w) return { trauma: 0.25, stop: 80, pulse: 0.5, buzz: BUZZ.scored, sound: "clash", title: { big: "ROUND " + round.n, small: "Yours" + how + " · " + scoreLine, tone: "good" } };
  if (you) return { trauma: 0.4, stop: 120, pulse: 0.5, buzz: BUZZ.hitYou, sound: "clash", title: { big: "ROUND " + round.n, small: w + " takes it" + how + " · " + scoreLine, tone: "bad" } };
  return { trauma: 0.2, stop: 70, sound: "clash", title: { big: "ROUND " + round.n, small: w + " takes it" + how + " · " + scoreLine, tone: "neutral" } };
}

function sayRound(round: FrontlinesRound, sides: Side[], scoreLine: string): string {
  if (!round) return "";
  const by: Record<string, string[]> = {};
  (round.hills || []).forEach((h: string | null, i: number) => {
    if (h) (by[h] = by[h] || []).push(LETTERS[i] || "");
  });
  const parts = sides.map((s) => s.name + " takes " + ((by[s.name] || []).join(", ") || "no hills"));
  return "Round " + round.n + ": " + parts.join("; ") + ". " + (round.winner ? round.winner + " wins the round" + (round.forfeit ? " by forfeit" : "") : "Level, no score") + ". Score " + scoreLine + ".";
}

/* ---------- what the viewer has seen ---------- */

function seenKey(id: unknown): string {
  let path = "";
  try {
    path = location.pathname;
  } catch {
    path = "";
  }
  return "ac-fl-seen:" + path + ":" + String(id);
}
function readSeen(id: unknown): number | null {
  try {
    const v = localStorage.getItem(seenKey(id));
    return v == null ? null : Number(v) || 0;
  } catch {
    return null;
  }
}
function writeSeen(id: unknown, n: number) {
  try {
    localStorage.setItem(seenKey(id), String(n));
  } catch {
    // storage unavailable: the next open just won't replay
  }
}

/* Home: the whole arc of hills, both front lines and the hill letters in
   frame, a band of dusk sky across the top. The camera looks at the field
   from elF above it (high enough to see over the hills to the far army)
   with the view pitched a little shallower, so the horizon shows; then it
   backs off until every key point of the field projects inside the frame. */
function flHome(aspect: number, width: number): Home {
  const phone = width < PHONE_BELOW;
  const vfov = aspect < 1 ? 56 : 46;
  const tv = Math.tan((vfov * Math.PI) / 360);
  const th = tv * Math.max(0.45, aspect);
  const elF = ((phone ? 32 : 29) * Math.PI) / 180;
  // the horizon sits ~7% under the frame's top edge (when the field allows)
  const pitch = Math.min(elF - 0.05, Math.atan(0.86 * tv));
  const fz = arcZ(0) + 0.9; // the field's middle
  const gap = gapOf(phone);
  const pts: [number, number, number][] = [];
  for (let i = 0; i < HILLS; i++) {
    const [hx, , hz] = hillPos(i, phone);
    pts.push([hx - RX, 0, hz + RZ], [hx + RX, 0, hz + RZ], [hx, RY + 2.3, hz]);
  }
  pts.push([0, 0, arcZ(0) + LINE_OFF], [0, 0, arcZ(0) - LINE_OFF - 0.3]);
  void gap;
  const fy = -Math.sin(pitch);
  const fzN = -Math.cos(pitch);
  const fits = (d: number) => {
    const cy = d * Math.sin(elF);
    const cz = fz + d * Math.cos(elF);
    return pts.every(([x, y, z]) => {
      const vy = y - cy;
      const vz = z - cz;
      const zc = vy * fy + vz * fzN;
      if (zc <= 0.1) return false;
      const yc = vy * -fzN + vz * fy;
      return Math.abs(x / (zc * th)) <= 0.96 && yc / (zc * tv) >= -0.96 && yc / (zc * tv) <= 0.94;
    });
  };
  let lo = 4;
  let hi = 80;
  for (let k = 0; k < 28; k++) {
    const mid = (lo + hi) / 2;
    if (fits(mid)) hi = mid;
    else lo = mid;
  }
  const cy = hi * Math.sin(elF);
  const cz = fz + hi * Math.cos(elF);
  return { pos: [0, cy, cz], fov: vfov, tz: cz - cy / Math.tan(pitch) };
}

/* ---------- the arena ---------- */

export default function FrontlinesArena3D({
  g,
  me = "",
  aspect,
  onReady,
  registerCommit,
}: {
  g: FrontlinesState;
  me?: string;
  aspect?: number;
  onReady?: () => void;
  registerCommit?: (fn: (() => void) | null) => void;
}) {
  const still = useReducedMotion();
  const q = useQuality(still);
  const juice = useJuiceStore(still);
  const firstVisit = useFirstVisit("fl:" + String((g && g.id) || ""));
  const [ready, setReady] = useState(false);
  const ctl = useRef<Ctl | null>(null);
  const homeRef = useRef<Home | null>(null);
  const [hostW, setHostW] = useState(() => (aspect && aspect < 1.4 ? 390 : 760));
  const phone = hostW < PHONE_BELOW;
  const meL = me.toLowerCase();
  const players: FrontlinesPlayer[] = (g && g.players) || NO_ITEMS;
  const rounds: FrontlinesRound[] = (g && g.rounds) || NO_ITEMS;
  const finished = !!g && g.status === "finished";
  const running = !!g && g.status === "running";
  const winner = String((g && g.winner) || "");

  // You hold the near side; spectators see the order the match lists.
  const sides: Side[] = useMemo(() => {
    const list = players.slice(0, 2);
    if (list.length === 2 && String(list[1]!.name).toLowerCase() === meL) list.reverse();
    return list.map((p: FrontlinesPlayer, i: number) => ({
      name: String(p.name),
      hex: String(p.hex || (i ? "#fb923c" : "#22d3ee")),
      you: String(p.name).toLowerCase() === meL,
      committed: !!p.committed,
      wins: p.wins || 0,
      sign: (i === 0 ? 1 : -1) as 1 | -1,
    }));
  }, [players, meL]);

  /* `shown` rounds are settled on the field; `playing` is the round being
     revealed. At open, a round the viewer never saw is replayed (the
     latest only); a first look at a match shows it as it stands. */
  const [init] = useState(() => {
    const n = rounds.length;
    const seen = readSeen(g && g.id);
    // (under reduced motion a missed round still lands with its title)
    if (seen == null || !n || seen >= n) return { shown: n };
    return { shown: n - 1 };
  });
  const [shown, setShown] = useState(init.shown);
  const [playing, setPlaying] = useState<{ n: number; t0: number | null } | null>(null);
  const [go, setGo] = useState(false);
  const [fx, setFx] = useState<{ id: number; at: [number, number, number]; hex: string }[]>([]);
  const fxId = useRef(0);
  const [ceremony, setCeremony] = useState(0);
  const [say, setSay] = useState("");
  // your own lock-in, sealed the moment you tap it (before the request)
  const [sealed, setSealed] = useState<number | null>(null);

  // Replays start once the scene is up (after the entry flight).
  useEffect(() => {
    if (!ready || go) return;
    const t = setTimeout(() => setGo(true), firstVisit && !still ? 2700 : 500);
    return () => clearTimeout(t);
  }, [ready, go, firstVisit, still]);

  const scoreLine = (upto: number) => {
    const sc: Record<string, number> = {};
    rounds.slice(0, upto).forEach((r: FrontlinesRound) => {
      if (r.winner) sc[r.winner] = (sc[r.winner] || 0) + 1;
    });
    return sides.map((s) => s.name + " " + (sc[s.name] || 0)).join(" – ");
  };
  const land = (n: number, quiet: boolean) => {
    const r = rounds[n - 1];
    setPlaying(null);
    setShown(n);
    if (!r) return;
    const fin = finished && n === rounds.length;
    const v = verdictImpact(r, sides, fin, winner, scoreLine(n));
    juice.hit(quiet ? { ...v, trauma: 0, stop: 0, slow: 0, pulse: 0 } : v);
    setSay(sayRound(r, sides, scoreLine(n)));
    if (fin) setCeremony((c) => c + 1);
  };

  const onLand = useEffectEvent(land);
  // A round the field has not shown plays in (one at a time: the latest).
  useEffect(() => {
    if (!go || playing) return;
    const n = rounds.length;
    if (n <= shown) return;
    // oxlint-disable-next-line react/set-state-in-effect -- new rounds from the server step the replay: reduced motion lands one at once, with its title, sound and buzz
    if (still) onLand(n, false);
    else setPlaying({ n, t0: null });
  }, [go, playing, rounds.length, shown, still]);

  // Remember what this viewer has seen.
  const seenId = g && g.id;
  useEffect(() => {
    writeSeen(seenId, shown);
  }, [seenId, shown]);

  const skip = () => {
    if (playing) land(playing.n, true);
  };

  /* Lock-ins: yours is sealed and sounded the moment you tap (games.ts
     calls this before the request); a rival's, seen live, is a soft ping. */
  const roundNo = g ? g.round : null;
  useEffect(() => {
    if (!registerCommit) return;
    registerCommit(() => {
      setSealed(roundNo);
      juice.hit({ sound: "lock", buzz: BUZZ.commit });
    });
    return () => registerCommit(null);
  }, [registerCommit, juice, roundNo]);
  const prevCommit = useRef<Record<string, boolean> | null>(null);
  useEffect(() => {
    const now: Record<string, boolean> = {};
    sides.forEach((s) => (now[s.name] = s.committed));
    const prev = prevCommit.current;
    prevCommit.current = now;
    if (!prev || !ready) return;
    sides.forEach((s) => {
      if (!s.you && s.committed && !prev[s.name]) juice.hit({ sound: "ping" });
    });
  }, [sides, ready, juice]);

  const fieldN = playing ? playing.n : shown;
  const round = fieldN > 0 ? rounds[fieldN - 1] || null : null;
  const t0 = playing ? playing.t0 : null;
  const isFinal = !!round && finished && fieldN === rounds.length;
  const values: number[] | null = round && round.values ? round.values : g && g.variant === "valued" ? g.values || null : null;
  const winnerSide = finished && winner ? sides.find((s) => s.name === winner) || null : null;
  const home = (a: number, width: number) => flHome(a, width);
  const first = home(aspect || 1.6, hostW);
  const label =
    "Frontlines arena, 3D view: " +
    sides.map((s) => s.name + (s.you ? " (you)" : "") + " " + s.wins + (running ? (s.committed ? ", committed" : ", planning") : "")).join(" versus ") +
    (round ? ". On the field: round " + round.n + "." : ". The field is empty.");
  /* What the page's field said under the scene, now in the frame: the
     round shown and how it went, or the round being planned. */
  const caption = (() => {
    if (round && round.hills) {
      const tally = sides
        .map((s) => {
          const k = values ? (round.points || {})[s.name] || 0 : (round.held || {})[s.name] || 0;
          return s.name + " " + k + (values ? " pts" : k === 1 ? " hill" : " hills");
        })
        .join(" · ");
      const v = round.forfeit ? round.winner + " takes it by forfeit" : round.winner ? round.winner + " takes it" : "level";
      return "Round " + round.n + ": " + tally + " — " + v;
    }
    return running ? "Round " + g.round + " · splits stay hidden until both are in" : "";
  })();
  const intro = firstVisit ? { title: "Frontlines", sub: sides.map((s) => s.name).join(" vs ") || "Troops over hills", color: "#4ade80" } : null;
  return (
    <JuiceProvider juice={juice}>
      <ArenaFrame
        onReset={() => goHome(ctl, homeRef.current || first, !still)}
        onSize={(width) => setHostW(width)}
        tools={<SoundToggle />}
        frameProps={{
          onPointerDown: (e) => {
            if (playing && !(e.target as HTMLElement).closest("button")) skip();
          },
        }}
        overlay={
          <>
            <ImpactLayer juice={juice} intro={intro} ready={ready} />
            {playing && round ? (
              <div className="duel-catchup" aria-hidden="true">
                Round {round.n} · tap to skip
              </div>
            ) : caption ? (
              <div className="arena3d-caption fl-caption">{caption}</div>
            ) : null}
            <div className="sr-only" aria-live="polite">
              {say}
            </div>
          </>
        }
      >
        <Canvas
          role="img"
          aria-label={label}
          frameloop="demand"
          dpr={q.dpr}
          gl={{ antialias: false, powerPreference: "high-performance" }}
          camera={{ position: first.pos, fov: first.fov, near: 0.1, far: 800 }}
        >
          <FirstFrame
            onReady={() => {
              setReady(true);
              if (onReady) onReady();
            }}
          />
          <Ticker fps={q.ambientFps} />
          <JuiceRig ctl={ctl} reach={0.8} />
          <color attach="background" args={["#05070d"]} />
          <fog attach="fog" args={["#3a2018", 20, 110]} />
          <SkyDome spec={FL_SKY} />
          <hemisphereLight args={["#fcd9a8", "#0b1310", 0.8]} />
          {/* lit from the viewer's side, warm and low: the hills read as shapes */}
          <directionalLight position={[-6, 9, 12]} intensity={1.5} color="#ffd8a8" />
          <directionalLight position={[8, 4, -10]} intensity={0.35} color="#8ea2ff" />
          <Ground phone={phone} />
          <Ridges />
          <Camps sides={sides} phone={phone} />
          {Array.from({ length: HILLS }, (_, i) => {
            const owner = round && round.hills ? round.hills[i] : null;
            const ownerHex = owner ? (sides.find((s) => s.name === owner) || { hex: "#94a3b8" }).hex : null;
            const counts = round && round.hills ? sides.map((s) => ({ n: ((round.alloc || {})[s.name] || [])[i] || 0, hex: s.hex, won: owner === s.name })) : null;
            return <HillMark key={i} i={i} phone={phone} hex={ownerHex} letter={LETTERS[i] || ""} val={values ? (values[i] ?? null) : null} t0={t0} still={still} counts={counts} />;
          })}
          {running && !playing
            ? sides.map((s) => <FrontLine key={s.name} side={s} phone={phone} lit={s.committed || (s.you && sealed === g.round)} still={still} />)
            : null}
          {sides.map((s) => (
            <Army key={s.name} side={s} alloc={round ? (round.alloc || {})[s.name] || null : null} hills={round ? round.hills || null : null} phone={phone} t0={t0} still={still} />
          ))}
          {playing && round && t0 == null ? <ClockStart key={"c" + playing.n} onStart={(t) => setPlaying((p) => (p && p.t0 == null ? { ...p, t0: t } : p))} /> : null}
          {playing && round && t0 != null ? (
            <Beats
              key={"b" + playing.n}
              round={round}
              sides={sides}
              t0={t0}
              verdict={verdictImpact(round, sides, isFinal, winner, scoreLine(playing.n))}
              holdAfter={isFinal ? 1.6 : 0.6}
              onHill={(i, hex) => {
                if (!hex) return;
                const p = hillPos(i, phone);
                setFx((l) => [...l.slice(q.lite ? -2 : -6), { id: ++fxId.current, at: [p[0], RY * 0.6, p[2]], hex }]);
              }}
              onVerdict={() => {
                setSay(sayRound(round, sides, scoreLine(playing.n)));
                if (isFinal) setCeremony((c) => c + 1);
              }}
              onDone={() => {
                setPlaying(null);
                setShown(playing.n);
              }}
            />
          ) : null}
          {fx.map((f) => (
            <Burst key={f.id} at={f.at} hex={f.hex} box={[1.2, 0.4, 2.4]} count={q.lite ? 24 : 40} power={1.6} piece={0.09} dur={1.1} onDone={() => setFx((l) => l.filter((x) => x.id !== f.id))} />
          ))}
          {ceremony && winnerSide && !still ? (
            <group key={"cer" + ceremony}>
              <LightPillar at={[0, 0, arcZ(0) + winnerSide.sign * (LINE_OFF + 0.4)]} hex={winnerSide.hex} height={12} width={0.7} />
              <Shockwave at={[0, 0.06, -0.3]} hex={winnerSide.hex} radius={15} dur={1.2} />
            </group>
          ) : null}
          <CameraControls ref={ctl} makeDefault minDistance={6} maxDistance={60} maxPolarAngle={Math.PI / 2.15} />
          <TouchControls ctl={ctl} />
          <Framer home={home} ctl={ctl} homeRef={homeRef} />
          <Intro ctl={ctl} homeRef={homeRef} enabled={!!intro && !still} ready={ready} />
          <ArenaPost q={q} bloom={1.1} threshold={0.95} vignette={0.6} />
        </Canvas>
      </ArenaFrame>
    </JuiceProvider>
  );
}
