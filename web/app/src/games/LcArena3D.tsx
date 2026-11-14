import { useEffect, useMemo, useRef, useState, type MutableRefObject, type RefObject } from "react";
import { Canvas, useFrame, useThree, type ThreeEvent } from "@react-three/fiber";
import { CameraControls, MeshReflectorMaterial } from "@react-three/drei";
import { AdditiveBlending, Color, DoubleSide, ShaderMaterial, Vector3, type Group, type Mesh, type PointLight } from "three";
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
import { ArenaPost, ImpactLayer, Intro, JuiceProvider, JuiceRig, SoundToggle, useFirstVisit, useJuice, useJuiceStore, type Juice } from "./juice";
import { Burst, HorizonGrid, LightPillar, Shockwave, SkyDome, type SkySpec } from "./atmos";
import { BUZZ, sfx } from "./sfx";
import { CYCLE_NOSE, CYCLE_REAR_WHEEL, CYCLE_WHEEL_R, CycleModel, EdgeWall, GridFloor, MAX_RIDERS, Ridges, TrailSystem, poolTexture, type TrailUniforms } from "./cycles";
import { DV, impactAt, nearMisses, options, poseAt, riders, seenTick, setSeenTick, territory, type Dir, type Rider } from "./lcmodel";

/* Light Cycles in 3D (2026-11-13: the race).

   The arena renders GET /games/:id - the trails in growth order, the
   riders, the viewer's options - and, because every rider's path can
   be rebuilt from the trails (lcmodel.ts), it plays the game as a race
   instead of redrawing a board:

   - the sprint: when a tick resolves, every rider rides its new cell
     together (~0.6 s on the juice clock), trails pouring out behind;
   - the catch-up: ticks the viewer missed since last time replay
     fast-forwarded (up to 12), slowing for crashes, with Skip;
   - crashes: the bike races into what it hit, the camera closes in,
     time slows at the impact and the bike derezzes where it struck;
     head-ons get their own staging; a rider skimming a wall throws
     sparks; the winner's trail lights up end to end;
   - play aids: the viewer's options marked on the floor (safe, or a
     magenta X), the queued turn as a lit arrow, tap a marker to steer,
     moved/deciding tags over every rider, a fuse ring in the last
     quarter of the tick;
   - extras: Zones (each cell tinted by the rider who reaches it first)
     and a chase camera.

   The look follows Tron: Legacy (cycles.tsx). Loaded lazily by
   games.ts, so three.js ships in its own chunk. */

/* eslint-disable @typescript-eslint/no-explicit-any */

const BIKE_SCALE = 0.9;
/* The nose ends 0.45 of a cell ahead of the bike's cell centre: never
   past its own cell, or open cells ahead read as taken. */
const BIKE_SHIFT = 0.45 - CYCLE_NOSE * BIKE_SCALE;
/* The trail pours out from behind the rear wheel: it ends this far
   behind the bike's cell centre. */
const TRIM = -(BIKE_SHIFT + CYCLE_REAR_WHEEL * BIKE_SCALE) + CYCLE_WHEEL_R * BIKE_SCALE * 0.8;
const YAW: Record<Dir, number> = { right: 0, up: Math.PI / 2, down: -Math.PI / 2, left: Math.PI };
const SPRINT = 0.62; // s of juice clock for a live tick
const FAST = 0.24; // a tick in the catch-up
const CRASH_TICK = 1.45; // a tick with a crash in it, live or caught up
const CATCH_MAX = 12;
const DANGER = "#ff2d95"; // the reserved accent: deadly

/* The home framing for a host of this shape. A phone-width host is
   short and the board must fill it: a steeper camera fitted to the
   board, so cells read as cells. Wider hosts sit lower, so the trails
   stand up as walls and the haze shows beyond the far edge. */
function lcHome(w: number, h: number, aspect: number, width: number): Home {
  if (width < 560) return fitHome(w + 1, h + 1, 58, 46, aspect, 1.05);
  if (aspect < 1) return fitHome(w + 2, h + 2, 46, 56, aspect, 1.03);
  return fitHome(w + 2, h + 2, 36, 42, aspect, 1.02);
}

/* Tron: Legacy's Grid: a black world, a cold haze on the horizon, the
   faintest stars; far ridgelines lit along their crests. */
const LC_FOG = "#061019";
const LC_SKY: SkySpec = {
  top: "#000104",
  mid: "#02050d",
  horizon: "#0a1a28",
  ground: "#010204",
  glow: "#1aa3ff",
  glowAmt: 0.16,
  stars: 0.045,
  aurora: 0.06,
  auroraA: "#22d3ee",
  auroraB: "#1e3a8a",
};

type Fx = { id: string; kind: "derez" | "spark"; at: [number, number, number]; hex: string; mine?: boolean };

/* The race clock: the float tick on show (T) chasing the server's tick
   (target), and what has already fired. */
class Race {
  T = 0;
  target = 0;
  fast = false;
  startAt = 0;
  played = false;
  fired = new Set<string>();
  list: Rider[] = [];
  g: any = null;
  live: number[] = new Array(MAX_RIDERS).fill(1);
  waveAt: number[] = new Array(MAX_RIDERS).fill(-1);
  push: null | { until: number; pos: [number, number, number]; tgt: [number, number, number] } = null;
  chase: number | null = null;
  /* a replay of a finished match from the start line */
  replay = false;
  replayDur = 0.3;
  run = 0;
  lastZap = 0;
}

function wrapPi(a: number): number {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}
function smooth(a: number, b: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/* A rider's heading through a turn, and the lean into it. */
function heading(p: ReturnType<typeof poseAt>): { yaw: number; roll: number } {
  const yaw = YAW[p.dir];
  if (p.dir === p.prev || p.f <= 0 || p.f >= 1) return { yaw, roll: 0 };
  const a = YAW[p.prev];
  const d = wrapPi(yaw - a);
  const q = smooth(0, 0.42, p.f);
  return { yaw: a + d * q, roll: -Math.sin(q * Math.PI) * 0.3 * Math.sign(d) };
}

/* ---------- the director: plays the race, fires its moments ---------- */

function Director({
  race,
  wx,
  wz,
  ctl,
  still,
  u,
  addFx,
  say,
  onCatch,
  onChaseLost,
  onReplayEnd,
  progress,
  bar,
}: {
  race: MutableRefObject<Race>;
  wx: (x: number) => number;
  wz: (y: number) => number;
  ctl: RefObject<Ctl | null>;
  still: boolean;
  u: TrailUniforms;
  addFx: (f: Fx[]) => void;
  say: (s: string) => void;
  onCatch: (c: { from: number; to: number } | null) => void;
  onChaseLost: () => void;
  onReplayEnd: () => void;
  progress: RefObject<HTMLSpanElement | null>;
  bar: RefObject<HTMLSpanElement | null>;
}) {
  const j = useJuice();
  const lastJ = useRef(j.t);
  const chaseYaw = useRef<number | null>(null);
  const world = (r: Rider, T: number): [number, number, number] => {
    const p = poseAt(r, T);
    const f = DV[p.dir];
    return [wx(p.x) + f[0] * BIKE_SHIFT * 0.6, 0.5, wz(p.y) + f[1] * BIKE_SHIFT * 0.6];
  };

  const crash = (r: Rider) => {
    const R = race.current;
    const out = r.out!;
    const at = world(r, impactAt(r)! - 1e-4);
    const fx: Fx[] = [{ id: R.run + "x" + r.i + ":" + out.tick, kind: "derez", at, hex: r.hex, mine: r.me }];
    const group = out.kind === "headon" ? [r.i, ...out.with].sort() : [r.i];
    // a head-on is staged once, by its lowest rider
    if (out.kind === "headon" && group[0] !== r.i) {
      addFx(fx);
      return;
    }
    const names = group.map((i) => R.list[i]!.name);
    const mineIn = group.some((i) => R.list[i]!.me);
    if (out.kind === "taken") {
      j.hit({
        pulse: 0.3,
        sound: "derez",
        buzz: r.me && !R.replay ? BUZZ.lostOne : undefined,
        title: { big: r.me ? "Timed out" : r.name + " timed out", small: "Three ticks without a move", tone: r.me ? "bad" : "neutral", hex: r.me ? undefined : r.hex },
      });
      say(r.me ? "You were taken out for missing three ticks." : r.name + " was taken out for missing three ticks.");
    } else if (out.kind === "headon") {
      j.hit({
        trauma: mineIn ? 0.9 : 0.6,
        stop: 240,
        slow: mineIn ? 1 : 0.6,
        pulse: 1,
        flash: "#ffffff",
        flashA: 0.45,
        buzz: mineIn && !R.replay ? BUZZ.lostOne : undefined,
        sound: mineIn ? ["derez", "lose"] : ["derez", "clash"],
        title: { big: "Head-on", small: names.join(" and ") + " derezzed", tone: mineIn ? "bad" : "neutral" },
      });
      say("Head-on: " + names.join(" and ") + " crashed into each other.");
    } else if (r.me) {
      j.hit({
        trauma: 0.9,
        stop: 230,
        slow: 1,
        pulse: 1,
        flash: r.hex,
        flashA: 0.55,
        buzz: R.replay ? undefined : BUZZ.lostOne,
        sound: ["derez", "lose"],
        title: { big: "Derezzed", small: out.kind === "wall" ? "You hit the edge of the grid" : "You're out of the race", tone: "bad" },
      });
      say("You crashed - you're out.");
    } else {
      j.hit({ trauma: 0.45, stop: 170, slow: 0.35, pulse: 0.7, sound: "derez", title: { big: r.name + " derezzed", tone: "neutral", hex: r.hex } });
      say(r.name + " crashed" + (out.kind === "wall" ? " into the edge of the grid." : "."));
    }
    group.forEach((i) => {
      if (i !== r.i) {
        const o = R.list[i]!;
        fx.push({ id: R.run + "x" + o.i + ":" + out.tick, kind: "derez", at: world(o, impactAt(o)! - 1e-4), hex: o.hex, mine: o.me });
      }
    });
    addFx(fx);
    if (R.push) R.push.until = performance.now() + 1900;
  };

  const finish = () => {
    const R = race.current;
    const g = R.g;
    const winner = g && g.winner ? String(g.winner) : "";
    const wr = R.list.find((r) => r.name === winner);
    const anyCrash = R.list.some((r) => r.out && r.out.tick === R.target);
    const delay = anyCrash ? 1500 : 0;
    const meIn = R.list.some((r) => r.me);
    if (wr && wr.me) {
      j.hit({ pulse: 0.8, buzz: R.replay ? undefined : BUZZ.wonMatch, sound: "win", soundDelay: delay / 1000, title: { big: "Victory", small: "Last rider standing", tone: "good" }, titleDelay: delay });
      say("You won the match.");
    } else if (wr) {
      const iLost = meIn && !R.list.find((r) => r.me && r.out && r.out.tick === R.target);
      j.hit({
        title: { big: wr.name + " wins", small: meIn ? "Better luck next race" : undefined, tone: meIn ? "bad" : "neutral", hex: meIn ? undefined : wr.hex },
        titleDelay: delay,
        sound: meIn ? "lose" : "win",
        soundDelay: delay / 1000,
        buzz: iLost && !R.replay ? BUZZ.lostMatch : undefined,
      });
      say(wr.name + " won the match.");
    } else {
      j.hit({ title: { big: "Draw", small: "No rider survived", tone: "neutral" }, titleDelay: delay });
      say("The match ended in a draw.");
    }
    if (wr) R.waveAt[wr.i] = j.t + delay / 1000;
  };

  /* Close in on a crash as its tick starts; the impact sets when to
     return (the camera goes back to wherever the viewer had it). */
  const pushIn = (k: number) => {
    const R = race.current;
    const c = ctl.current;
    if (!c || still || R.chase !== null) return;
    const hit = R.list.filter((r) => r.out && r.out.kind !== "taken" && r.out.tick === k);
    if (!hit.length) return;
    let fx = 0, fz = 0;
    hit.forEach((r) => {
      const p = world(r, impactAt(r)!);
      fx += p[0] / hit.length;
      fz += p[2] / hit.length;
    });
    const pos = c.getPosition(new Vector3());
    const tgt = c.getTarget(new Vector3());
    const dx = pos.x - fx, dy = pos.y, dz = pos.z - fz;
    const d = Math.hypot(dx, dy, dz) || 1;
    const k2 = Math.max(9, d * 0.42) / d;
    if (!R.push) R.push = { until: 0, pos: [pos.x, pos.y, pos.z], tgt: [tgt.x, tgt.y, tgt.z] };
    void c.setLookAt(fx + dx * k2, Math.max(3.2, dy * k2 * 0.8), fz + dz * k2, fx, 0.3, fz, true);
  };

  useFrame((state, delta) => {
    const R = race.current;
    const now = performance.now();
    const dJ = Math.max(0, j.t - lastJ.current);
    lastJ.current = j.t;
    if (R.push && R.push.until && now > R.push.until) {
      const c = ctl.current;
      if (c) void c.setLookAt(...R.push.pos, ...R.push.tgt, true);
      R.push = null;
    }
    if (R.T < R.target && now >= R.startAt) {
      const prev = R.T;
      // (a replay the viewer asked for plays even under reduced motion,
      // without the camera moves, slow motion or sparks)
      if (still && !R.replay) R.T = R.target;
      else {
        const k = Math.floor(R.T) + 1;
        const crashing = R.list.some((r) => r.out && r.out.kind !== "taken" && r.out.tick === k);
        const dur = crashing ? CRASH_TICK : R.replay ? R.replayDur : R.fast && R.target - R.T > 1.0001 ? FAST : SPRINT;
        R.T = Math.min(R.target, R.T + dJ / dur);
      }
      R.played = true;
      const cur = R.T;
      // ticks starting: the whoosh, and the close-in on a crash
      for (let m = Math.floor(prev) + 1; m <= Math.ceil(cur) && m <= R.target; m++) {
        if (prev < m - 1 + 1e-6 && cur >= m - 1) {
          if (!R.fired.has("t" + m)) {
            R.fired.add("t" + m);
            if (!still && !R.replay && !(R.fast && R.target - (m - 1) > 1)) sfx("whoosh");
            pushIn(m);
          }
        }
      }
      // impacts
      R.list.forEach((r) => {
        const at = impactAt(r);
        if (at === null || R.fired.has("x" + r.i)) return;
        if (prev < at && cur >= at) {
          R.fired.add("x" + r.i);
          crash(r);
        }
      });
      // ticks completed: near misses (live play only - not the fast
      // catch-up, where they would rattle past)
      for (let m = Math.floor(prev) + 1; m <= Math.floor(cur); m++) {
        if (still || (!R.replay && R.fast && R.target - m > 0)) continue;
        const g = R.g;
        const nm = nearMisses(R.list, m, (g && g.w) || 30, (g && g.h) || 22);
        if (nm.length) {
          const fx: Fx[] = nm.map((n) => {
            const v = DV[n.side];
            return { id: R.run + "s" + n.i + ":" + m, kind: "spark", at: [wx(n.x) + v[0] * 0.5, 0.35, wz(n.y) + v[1] * 0.5], hex: R.list[n.i]!.hex };
          });
          addFx(fx);
          // a replay races past: one zap at most every half second
          if (!R.replay || now - R.lastZap > 450) {
            sfx("zap");
            R.lastZap = now;
          }
          j.hit({ pulse: 0.15 });
        }
      }
      if (R.replay) {
        if (progress.current) progress.current.textContent = "Tick " + Math.min(R.target, Math.floor(cur)) + " of " + R.target;
        if (bar.current) bar.current.style.width = ((100 * cur) / Math.max(1, R.target)).toFixed(1) + "%";
      }
      if (cur >= R.target) {
        R.fast = false;
        onCatch(null);
        if (R.g) setSeenTick(R.g.id, R.target);
        if (R.g && R.g.status === "finished" && !R.fired.has("fin")) {
          R.fired.add("fin");
          finish();
        }
        if (R.replay) {
          R.replay = false;
          onReplayEnd();
        }
      }
      state.invalidate();
    } else if (R.T < R.target) state.invalidate();
    // the trails: heads, wreck fades, the winner's wave
    const dt = Math.min(delta, 0.1);
    R.list.forEach((r) => {
      if (r.i >= MAX_RIDERS) return;
      const p = poseAt(r, R.T);
      u.head[r.i] = p.shown ? p.s - TRIM : r.cells.length + 1;
      const want = p.shown || r.alive ? 1 : 0;
      R.live[r.i] = still ? want : R.live[r.i]! + (want - R.live[r.i]!) * Math.min(1, dt * 2.5);
      if (Math.abs(R.live[r.i]! - want) > 0.004) state.invalidate();
      u.live[r.i] = R.live[r.i]!;
      const w0 = R.waveAt[r.i]!;
      if (w0 >= 0 && j.t >= w0) {
        const e = j.t - w0;
        const len = r.cells.length;
        u.wave[r.i] = e * Math.max(14, len / 1.4) - 3;
        u.flare[r.i] = 0.6 * Math.max(0, 1 - e / 3.5);
        if (u.wave[r.i]! > len + 6 && u.flare[r.i] === 0) R.waveAt[r.i] = -1;
        state.invalidate();
      } else {
        u.wave[r.i] = -99;
        u.flare[r.i] = 0;
      }
    });
    // the chase camera: behind the chosen rider, looking down its line
    if (R.chase !== null) {
      const r = R.list[R.chase];
      const c = ctl.current;
      const p = r ? poseAt(r, R.T) : null;
      if (!r || !p || !p.shown) {
        onChaseLost();
      } else if (c) {
        const h = heading(p).yaw;
        const cy = chaseYaw.current === null ? h : chaseYaw.current + wrapPi(h - chaseYaw.current) * Math.min(1, dt * 3);
        chaseYaw.current = cy;
        const fx = Math.cos(cy), fz = -Math.sin(cy);
        const bx = wx(p.x) + fx * BIKE_SHIFT, bz = wz(p.y) + fz * BIKE_SHIFT;
        void c.setLookAt(bx - fx * 5.4, 2.3, bz - fz * 5.4, bx + fx * 5, 0.7, bz + fz * 5, true);
      }
    } else chaseYaw.current = null;
  });
  return null;
}

/* ---------- riders ---------- */

function Bike({
  r,
  race,
  wx,
  wz,
  still,
}: {
  r: Rider;
  race: MutableRefObject<Race>;
  wx: (x: number) => number;
  wz: (y: number) => number;
  still: boolean;
}) {
  const grp = useRef<Group>(null);
  const lean = useRef<Group>(null);
  const wheels = useRef<(Mesh | null)[]>([]);
  const light = useRef<PointLight>(null);
  const pool = useRef<Mesh>(null);
  const spin = useRef(0);
  const poolCol = useMemo(() => new Color(r.hex).multiplyScalar(0.55), [r.hex]);
  useFrame((_, delta) => {
    const R = race.current;
    const rr = R.list[r.i];
    const g = grp.current;
    if (!rr || !g) return;
    const p = poseAt(rr, R.T);
    g.visible = p.shown;
    if (light.current) light.current.intensity = p.shown ? 11 : 0;
    if (!p.shown) return;
    g.position.set(wx(p.x), 0, wz(p.y));
    const hd = heading(p);
    g.rotation.y = hd.yaw;
    if (lean.current) lean.current.rotation.x = hd.roll;
    const moving = R.T < R.target && p.f > 0 && p.f < 1;
    if (!still) spin.current += Math.min(delta, 0.1) * (moving ? 18 : 1.1);
    wheels.current.forEach((w) => {
      if (w) w.rotation.z = -spin.current;
    });
    if (pool.current) pool.current.scale.x = moving ? 3.9 : 2.7;
  });
  return (
    <group ref={grp}>
      <group position={[BIKE_SHIFT, 0, 0]} scale={BIKE_SCALE}>
        <CycleModel hex={r.hex} wheels={wheels} lean={lean} />
      </group>
      <mesh ref={pool} position={[BIKE_SHIFT - 0.35, 0.016, 0]} rotation-x={-Math.PI / 2} scale={[2.7, 1.5, 1]} renderOrder={-1}>
        <planeGeometry args={[1, 1]} />
        <meshBasicMaterial map={poolTexture()} color={poolCol} transparent depthWrite={false} blending={AdditiveBlending} toneMapped={false} />
      </mesh>
      {/* kept mounted after a crash (at 0): removing a light recompiles
          every material, a stall right on the derez */}
      <pointLight ref={light} color={r.hex} intensity={11} distance={9} decay={2} position={[BIKE_SHIFT, 1.5, 0]} />
    </group>
  );
}

/* Rider tags: DOM pills (name, or "You", and moved ✓ / deciding …)
   over the cycles, in a layer over the canvas. Each frame projects a
   point high above each bike and pushes overlapping tags apart, so
   riders side by side stay readable and the tags never sit on the
   cells just ahead of a bike (where the option markers are). */
function TagTracker({ race, wx, wz, els }: { race: MutableRefObject<Race>; wx: (x: number) => number; wz: (y: number) => number; els: MutableRefObject<(HTMLDivElement | null)[]> }) {
  const camera = useThree((st) => st.camera);
  const size = useThree((st) => st.size);
  const v = useMemo(() => new Vector3(), []);
  useFrame(() => {
    const R = race.current;
    const boxes: { el: HTMLDivElement; x: number; y: number; w: number; h: number }[] = [];
    R.list.forEach((r) => {
      const el = els.current[r.i];
      if (!el) return;
      const p = poseAt(r, R.T);
      if (!p.shown) {
        el.style.opacity = "0";
        return;
      }
      const f = DV[p.dir];
      v.set(wx(p.x) + f[0] * BIKE_SHIFT, 2.5, wz(p.y) + f[1] * BIKE_SHIFT).project(camera);
      if (v.z > 1 || v.z < -1) {
        el.style.opacity = "0";
        return;
      }
      const w = el.offsetWidth || 50;
      const h = el.offsetHeight || 18;
      boxes.push({ el, x: ((v.x + 1) / 2) * size.width - w / 2, y: ((1 - v.y) / 2) * size.height - h, w, h });
    });
    // lowest first; anything overlapping a placed tag moves up past it
    boxes.sort((a, b) => b.y - a.y);
    const placed: typeof boxes = [];
    boxes.forEach((b) => {
      for (let guard = 0; guard < 6; guard++) {
        const hit = placed.find((o) => b.x < o.x + o.w + 3 && o.x < b.x + b.w + 3 && b.y < o.y + o.h + 2 && o.y < b.y + b.h + 2);
        if (!hit) break;
        b.y = hit.y - b.h - 3;
      }
      placed.push(b);
      b.el.style.opacity = "1";
      b.el.style.transform = "translate(" + Math.round(b.x) + "px," + Math.round(b.y) + "px)";
    });
  });
  return null;
}

/* The viewer's options for this tick, on the floor: a chevron for each
   safe heading, a magenta X for a deadly one, the queued turn lit and
   joined to the bike by an arrow. Tapping one steers. Shown only when
   the race is at rest on the present tick. */
function Options({
  opts,
  hex,
  from,
  race,
  wx,
  wz,
  onSteer,
}: {
  opts: ReturnType<typeof options>;
  hex: string;
  from: [number, number] | null;
  race: MutableRefObject<Race>;
  wx: (x: number) => number;
  wz: (y: number) => number;
  onSteer?: (dir: Dir) => void;
}) {
  const j = useJuice();
  const grp = useRef<Group>(null);
  const qref = useRef<Group>(null);
  const lit = useMemo(() => new Color(hex).multiplyScalar(2.2), [hex]);
  const dim = useMemo(() => new Color(hex).multiplyScalar(1.1), [hex]);
  const bad = useMemo(() => new Color(DANGER).multiplyScalar(1.7), []);
  useFrame(() => {
    const R = race.current;
    if (grp.current) grp.current.visible = R.T >= R.target;
    if (qref.current) {
      const s = 1 + 0.08 * Math.sin(j.t * 4);
      qref.current.scale.set(s, 1, s);
    }
  });
  if (!opts.length || !from) return null;
  return (
    <group ref={grp}>
      {opts.map((o) => {
        const v = DV[o.dir];
        const yaw = YAW[o.dir];
        const steer = (e: ThreeEvent<MouseEvent>) => {
          if (e.delta > 8 || !onSteer) return;
          e.stopPropagation();
          onSteer(o.dir);
        };
        return (
          <group key={o.dir} position={[wx(o.x), 1.12, wz(o.y)]}>
            {/* a generous, invisible tap target at the marker */}
            <mesh rotation-x={-Math.PI / 2} onClick={steer}>
              <planeGeometry args={[1.25, 1.25]} />
              <meshBasicMaterial transparent opacity={0} depthWrite={false} />
            </mesh>
            {o.safe ? (
              <group ref={o.queued ? qref : undefined} rotation-y={yaw}>
                {[1, -1].map((s) => (
                  <mesh key={s} position={[0.03, 0, s * 0.2]} rotation-y={s * 0.75} renderOrder={12}>
                    <boxGeometry args={[0.62, 0.03, 0.12]} />
                    <meshBasicMaterial color={o.queued ? lit : dim} transparent opacity={o.queued ? 1 : 0.75} toneMapped={false} depthTest={false} />
                  </mesh>
                ))}
              </group>
            ) : (
              <group rotation-y={Math.PI / 4}>
                {[0, Math.PI / 2].map((a) => (
                  <mesh key={a} rotation-y={a} renderOrder={12}>
                    <boxGeometry args={[0.78, 0.03, 0.12]} />
                    <meshBasicMaterial color={bad} transparent opacity={o.queued ? 1 : 0.75} toneMapped={false} depthTest={false} />
                  </mesh>
                ))}
              </group>
            )}
            {o.queued ? (
              /* the lit path from the bike's cell into the chosen one */
              <mesh position={[-v[0] * 0.55, -0.01, -v[1] * 0.55]} rotation-y={yaw} renderOrder={11}>
                <boxGeometry args={[0.8, 0.02, 0.1]} />
                <meshBasicMaterial color={o.safe ? lit : bad} transparent opacity={0.8} toneMapped={false} depthTest={false} />
              </mesh>
            ) : null}
          </group>
        );
      })}
    </group>
  );
}

/* The fuse: a ring round the viewer's bike that burns down over the
   last quarter of the tick, hot and pulsing in its last moments if no
   move is in. */
const FUSE_V = /* glsl */ `
varying vec2 vP;
void main() {
  vP = position.xy;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;
const FUSE_F = /* glsl */ `
uniform float uFrac;
uniform float uHot;
uniform float uTime;
uniform vec3 uCol;
varying vec2 vP;
void main() {
  float r = length(vP);
  float ring = smoothstep(0.9, 0.94, r) * (1.0 - smoothstep(1.02, 1.06, r));
  float a = fract(atan(vP.x, vP.y) / 6.28318 + 1.0);
  if (a > uFrac || ring < 0.01) discard;
  vec3 c = mix(uCol * 1.8, vec3(1.0, 0.35, 0.7) * 2.2, uHot * (0.6 + 0.4 * sin(uTime * 9.0)));
  gl_FragColor = vec4(c, ring * 0.9);
}`;

function Fuse({ g, at, hex, race }: { g: any; at: [number, number] | null; hex: string; race: MutableRefObject<Race> }) {
  const j = useJuice();
  const mesh = useRef<Mesh>(null);
  const mat = useMemo(
    () =>
      new ShaderMaterial({
        vertexShader: FUSE_V,
        fragmentShader: FUSE_F,
        transparent: true,
        depthWrite: false,
        blending: AdditiveBlending,
        uniforms: { uFrac: { value: 1 }, uHot: { value: 0 }, uTime: { value: 0 }, uCol: { value: new Color(hex) } },
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );
  useEffect(() => () => mat.dispose(), [mat]);
  const deadline = Number((g && g.deadline) || 0);
  const span = Number((g && g.tick_seconds) || 120) * 1000;
  const queued = !!(g && g.you && g.you.queued);
  // the ring burns in real time: ask for a frame a second even when
  // the ambient ticker is off (reduced motion)
  useEffect(() => {
    const t = setInterval(() => {
      const left = deadline - Date.now();
      if (left > 0 && left < span * 0.25) j.invalidate?.();
    }, 1000);
    return () => clearInterval(t);
  }, [deadline, span, j]);
  useFrame(() => {
    const R = race.current;
    const left = deadline - Date.now();
    const frac = left / (span * 0.25);
    const on = !!at && deadline > 0 && R.T >= R.target && left > 0 && frac < 1;
    if (mesh.current) mesh.current.visible = on;
    mat.uniforms.uFrac!.value = Math.max(0, Math.min(1, frac));
    mat.uniforms.uHot!.value = !queued && frac < 0.32 ? 1 : 0;
    mat.uniforms.uTime!.value = j.t;
  });
  if (!at) return null;
  return (
    <mesh ref={mesh} material={mat} position={[at[0], 0.04, at[1]]} rotation-x={-Math.PI / 2} renderOrder={3}>
      <planeGeometry args={[2.3, 2.3]} />
    </mesh>
  );
}

function FxLayer({ fx, lite, done }: { fx: Fx[]; lite: boolean; done: (id: string) => void }) {
  return (
    <>
      {fx.map((f) =>
        f.kind === "derez" ? (
          <group key={f.id}>
            <Burst at={f.at} hex={f.hex} count={lite ? 48 : 90} box={[1.9, 1.0, 0.6]} power={f.mine ? 3.2 : 2.6} dur={1.8} onDone={() => done(f.id)} />
            <Shockwave at={[f.at[0], 0.04, f.at[2]]} hex={f.hex} radius={f.mine ? 11 : 7} dur={1.1} />
            <LightPillar at={f.at} hex={f.hex} height={f.mine ? 22 : 14} dur={1.7} />
          </group>
        ) : (
          <Burst key={f.id} at={f.at} hex="#e8f7ff" count={lite ? 10 : 18} box={[0.25, 0.3, 0.25]} power={1.5} piece={0.035} dur={0.55} rise={0.5} onDone={() => done(f.id)} />
        )
      )}
    </>
  );
}

export default function LcArena3D({
  g,
  me = "",
  aspect,
  onReady,
  onSteer,
}: {
  g: any;
  me?: string;
  aspect?: number;
  onReady?: () => void;
  onSteer?: (dir: string) => void;
}) {
  const still = useReducedMotion();
  const q = useQuality(still);
  const juice = useJuiceStore(still);
  const id = (g && g.id) || "";
  const firstVisit = useFirstVisit("lc:" + String(id));
  const [ready, setReady] = useState(false);
  const ctl = useRef<Ctl | null>(null);
  const homeRef = useRef<Home | null>(null);
  const w = (g && g.w) || 30;
  const h = (g && g.h) || 22;
  const tick = Number((g && g.tick) || 0);
  const list = useMemo(() => riders(g, me), [g, me]);
  const wx = useMemo(() => (x: number) => x - (w - 1) / 2, [w]);
  const wz = useMemo(() => (y: number) => y - (h - 1) / 2, [h]);
  const home = (a: number, width: number) => lcHome(w, h, a, width);
  const first = home(aspect || 1.4, 9999);
  const dist = Math.max(w, h);

  /* the race: on first sight, open where the viewer last left this
     match and replay the rest; later states extend it */
  const race = useRef<Race>(new Race());
  // a different match in the same view (a rematch) starts a new race
  if (race.current.g && String(race.current.g.id) !== String(id)) race.current = new Race();
  const R = race.current;
  if (!R.g) {
    const seen = seenTick(id);
    R.target = tick;
    R.T = seen === null || still || !(seen < tick) ? tick : Math.max(seen, tick - CATCH_MAX);
    R.fast = R.target - R.T > 1;
  } else if (tick > R.target) {
    R.target = tick;
    if (R.target - R.T > 1.0001) R.fast = true;
  } else if (tick < R.target) {
    R.T = R.target = tick;
  }
  R.list = list;
  R.g = g;
  const [catching, setCatching] = useState<{ from: number; to: number } | null>(null);
  useEffect(() => {
    if (!ready) return;
    const Rr = race.current;
    Rr.startAt = performance.now() + (firstVisit && !still ? 2700 : 450);
    if (Rr.T < Rr.target - 1) setCatching({ from: Math.floor(Rr.T), to: Rr.target });
    else if (Rr.T >= Rr.target) setSeenTick(id, Rr.target);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);
  useEffect(() => {
    const Rr = race.current;
    if (ready && Rr.target - Rr.T > 1.0001) setCatching({ from: Math.floor(Rr.T), to: Rr.target });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick]);
  const skip = () => {
    const Rr = race.current;
    list.forEach((r) => {
      const at = impactAt(r);
      if (at !== null && at <= Rr.target) Rr.fired.add("x" + r.i);
    });
    for (let m = Math.floor(Rr.T) + 1; m <= Rr.target; m++) Rr.fired.add("t" + m);
    // land a hair short of the present: the next frame steps onto it,
    // so a finished match still names its winner
    Rr.T = Math.max(Rr.T, Rr.target - 1e-4);
    Rr.fast = false;
    if (Rr.push && ctl.current) {
      void ctl.current.setLookAt(...Rr.push.pos, ...Rr.push.tgt, true);
      Rr.push = null;
    }
    setSeenTick(id, Rr.target);
    setCatching(null);
    juice.invalidate?.();
  };

  /* Replay a finished race from the start line: the clock rewinds to
     tick 0 and the whole match plays again (~16 s plus its crashes,
     whatever its length), staged as it happened, ending on the winner. */
  const [replaying, setReplaying] = useState(false);
  const progressEl = useRef<HTMLSpanElement>(null);
  const barEl = useRef<HTMLSpanElement>(null);
  const startReplay = () => {
    const Rr = race.current;
    if (Rr.push && ctl.current) {
      void ctl.current.setLookAt(...Rr.push.pos, ...Rr.push.tgt, false);
      Rr.push = null;
    }
    Rr.fired.clear();
    Rr.waveAt.fill(-1);
    Rr.live.fill(1);
    Rr.run++;
    Rr.T = 0;
    Rr.target = tick;
    Rr.fast = false;
    Rr.replay = true;
    Rr.replayDur = Math.min(0.4, Math.max(0.14, 16 / Math.max(1, tick)));
    Rr.startAt = performance.now() + 500;
    setFx([]);
    setCatching(null);
    setReplaying(true);
    setSaid("Replaying the race from the start.");
    if (chase === null) goHome(ctl, homeRef.current || first, !still);
    sfx("whoosh");
    juice.invalidate?.();
  };

  const [fx, setFx] = useState<Fx[]>([]);
  const tagEls = useRef<(HTMLDivElement | null)[]>([]);
  const [said, setSaid] = useState("");
  const u = useRef<TrailUniforms>({ head: new Array(MAX_RIDERS).fill(0), live: new Array(MAX_RIDERS).fill(1), wave: new Array(MAX_RIDERS).fill(-99), flare: new Array(MAX_RIDERS).fill(0) });

  /* zones and the chase camera */
  const [zones, setZones] = useState(false);
  const own = useMemo(() => (zones ? territory(list, w, h) : null), [zones, list, w, h]);
  const [chase, setChase] = useState<number | null>(null);
  R.chase = chase;
  const meR = list.find((r) => r.me);
  const onGrid = () => list.filter((r) => poseAt(r, race.current.T).shown).map((r) => r.i);
  const nextChase = () => {
    const order = onGrid();
    if (meR && order.indexOf(meR.i) >= 0) order.sort((a, b) => (a === meR.i ? -1 : b === meR.i ? 1 : 0));
    if (!order.length) return null;
    if (chase === null) return order[0]!;
    const k = order.indexOf(chase);
    return k < 0 || k === order.length - 1 ? null : order[k + 1]!;
  };
  const chaseName = chase !== null ? (list[chase] ? (list[chase]!.me ? "You" : list[chase]!.name) : "") : "";

  const opts = useMemo(() => options(g, meR, list), [g, meR, list]);
  const meCell: [number, number] | null = meR && meR.alive && meR.cells.length ? [wx(meR.cells[meR.cells.length - 1]![0]), wz(meR.cells[meR.cells.length - 1]![1])] : null;
  const steer = onSteer
    ? (d: Dir) => {
        sfx("lock");
        onSteer(d);
      }
    : undefined;

  const status = (p: any): string => {
    if (!g || replaying) return "";
    if (g.status === "lobby") return p.accepted ? "✓" : "…";
    if (g.status === "running" && p.alive) return p.moved ? "✓" : "…";
    if (g.status === "finished" && g.winner === p.name) return "★";
    return "";
  };
  const players: any[] = (g && g.players) || [];
  const label =
    "Light Cycles board, 3D view: " + (players.map((p) => p.name + (p.alive ? " riding" : " out")).join(", ") || "no riders") + ".";
  const intro = firstVisit ? { title: "Light Cycles", sub: players.map((p) => p.name).join(" · ") || "The grid is live", color: "#22d3ee" } : null;

  return (
    <JuiceProvider juice={juice}>
      <ArenaFrame
        onReset={() => {
          setChase(null);
          goHome(ctl, homeRef.current || first, !still);
        }}
        tools={
          <>
            <SoundToggle />
            <button
              type="button"
              className={"arena3d-reset arena3d-toggle" + (zones ? " on" : "")}
              aria-pressed={zones}
              title="Zones: tint each open cell by the rider who can reach it first"
              onClick={() => setZones((z) => !z)}
            >
              Zones
            </button>
            {list.some((r) => r.alive) || replaying ? (
              <button
                type="button"
                className={"arena3d-reset arena3d-toggle" + (chase !== null ? " on" : "")}
                aria-pressed={chase !== null}
                title="Chase camera: ride behind a cycle. Tap again for the next rider."
                onClick={() => {
                  const n = nextChase();
                  setChase(n);
                  if (n === null) goHome(ctl, homeRef.current || first, !still);
                }}
              >
                {chase !== null ? "Chase: " + chaseName : "Chase"}
              </button>
            ) : null}
          </>
        }
        overlay={
          <>
            <ImpactLayer juice={juice} intro={intro} ready={ready} />
            {replaying ? (
              <div className="lc-catchup lc-replay" role="status">
                <span className="lc-replay-txt">
                  ▶ Replay · <span ref={progressEl}>Tick 0 of {tick}</span>
                </span>
                <span className="lc-replay-bar">
                  <span ref={barEl} />
                </span>
                <button type="button" onClick={skip}>
                  End
                </button>
              </div>
            ) : g && g.status === "finished" && ready && !catching ? (
              <button type="button" className="lc-replay-btn" onClick={startReplay} title="Watch the whole race again from the start line">
                ▶ Replay race
              </button>
            ) : null}
            {catching ? (
              <div className="lc-catchup" role="status">
                <span>
                  Replaying ticks {catching.from + 1}–{catching.to}
                </span>
                <button type="button" onClick={skip}>
                  Skip
                </button>
              </div>
            ) : null}
            {g && g.status !== "lobby" ? (
              <div className="lc-tags" aria-hidden="true">
                {list.map((r) => {
                  const st = status(players[r.i] || {});
                  return (
                    <div
                      key={r.i}
                      ref={(el) => {
                        tagEls.current[r.i] = el;
                      }}
                      className={"lc-tag" + (r.me ? " me" : "")}
                      style={{ ["--tc" as any]: r.hex, opacity: 0 }}
                    >
                      {r.me ? "You" : r.name}
                      {st ? <span className="lc-tag-st">{st}</span> : null}
                    </div>
                  );
                })}
              </div>
            ) : null}
            <div className="sr-only" aria-live="polite">
              {said}
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
          camera={{ position: first.pos, fov: first.fov, near: 0.1, far: 900 }}
        >
          <FirstFrame
            onReady={() => {
              setReady(true);
              if (onReady) onReady();
            }}
          />
          <Ticker fps={q.ambientFps} />
          <JuiceRig ctl={ctl} />
          <Director
            race={race}
            wx={wx}
            wz={wz}
            ctl={ctl}
            still={still}
            u={u.current}
            addFx={(f) => setFx((l) => [...l, ...f.filter((x) => !l.some((y) => y.id === x.id))])}
            say={setSaid}
            onCatch={(c) => setCatching(c)}
            onChaseLost={() => {
              // the chased cycle went out: ride with the next one on the
              // grid, or come home when none is left
              const order = onGrid();
              if (order.length) setChase(order[0]!);
              else {
                setChase(null);
                goHome(ctl, homeRef.current || first, !still);
              }
            }}
            onReplayEnd={() => setReplaying(false)}
            progress={progressEl}
            bar={barEl}
          />
          <color attach="background" args={[LC_FOG]} />
          <fog attach="fog" args={[LC_FOG, dist * 1.5, dist * 4.4]} />
          <SkyDome spec={LC_SKY} />
          <Ridges />
          <ambientLight intensity={0.55} />
          <directionalLight position={[w / 3, 16, h / 2]} intensity={0.9} color="#cfeaff" />
          <hemisphereLight args={["#8fb8d8", "#05070a", 0.35]} />

          {/* The floor: black glass. A true mirror on desktop (the
              cycles and their light shine in it, as in the film); a
              glossy black floor that catches the riders' lights on
              touch devices, where a second render costs most. */}
          <mesh rotation-x={-Math.PI / 2} position={[0, -0.02, 0]}>
            <planeGeometry args={[420, 420]} />
            {q.lite ? (
              <meshStandardMaterial color="#020305" roughness={0.28} metalness={0.75} />
            ) : (
              <MeshReflectorMaterial
                blur={[220, 50]}
                resolution={512}
                mixBlur={0.75}
                mixStrength={7}
                roughness={0.42}
                depthScale={1.0}
                minDepthThreshold={0.4}
                maxDepthThreshold={1.4}
                color="#020304"
                metalness={0.6}
                mirror={0.85}
              />
            )}
          </mesh>
          <HorizonGrid half={[w / 2, h / 2]} off={[(w / 2) % 1, (h / 2) % 1]} cell={2} a="#0d3550" b="#1a6a96" fade={34} line={0.12} y={-0.01} />
          <GridFloor w={w} h={h} own={own} hexes={list.map((r) => r.hex)} terr={zones && !replaying ? 1 : 0} />
          <EdgeWall w={w} h={h} />

          <TrailSystem list={list} wx={wx} wz={wz} u={u.current} />
          <TagTracker race={race} wx={wx} wz={wz} els={tagEls} />

          {list.map((r) => (
            <Bike key={"b" + r.i} r={r} race={race} wx={wx} wz={wz} still={still} />
          ))}

          {/* where wrecks went out: the 2D board's ✕ on the floor */}
          {list.map((r) => {
            if (!r.out || r.alive) return null;
            const c = r.cells[r.cells.length - 1];
            if (!c) return null;
            return <CrashMark key={"x" + r.i} race={race} r={r} x={wx(c[0])} z={wz(c[1])} hex={r.hex} />;
          })}

          {meR ? <Options opts={opts} hex={meR.hex} from={meCell} race={race} wx={wx} wz={wz} onSteer={steer} /> : null}
          {meR && g && g.status === "running" ? <Fuse g={g} at={meCell} hex={meR.hex} race={race} /> : null}

          <FxLayer fx={fx} lite={q.lite} done={(fid) => setFx((l) => l.filter((x) => x.id !== fid))} />

          <CameraControls ref={ctl} makeDefault minDistance={4} maxDistance={150} maxPolarAngle={Math.PI / 2.1} />
          <TouchControls ctl={ctl} />
          <Framer home={home} ctl={ctl} homeRef={homeRef} />
          <Intro ctl={ctl} homeRef={homeRef} enabled={!!intro && !still} ready={ready} />

          <ArenaPost q={q} bloom={1.2} threshold={1} vignette={0.6} />
        </Canvas>
      </ArenaFrame>
    </JuiceProvider>
  );
}

/* Where a rider went out: the 2D board's ✕, in the rider's colour
   lifted toward white - shown once its derez has played. */
function CrashMark({ race, r, x, z, hex }: { race: MutableRefObject<Race>; r: Rider; x: number; z: number; hex: string }) {
  const grp = useRef<Group>(null);
  const c = useMemo(() => new Color(hex).lerp(new Color("#ffffff"), 0.35).multiplyScalar(2.2), [hex]);
  useFrame(() => {
    const R = race.current;
    const at = impactAt(r);
    if (grp.current) grp.current.visible = at === null || R.T >= at;
  });
  return (
    <group ref={grp} position={[x, 0.05, z]}>
      {[1, -1].map((s) => (
        <mesh key={s} rotation-y={(s * Math.PI) / 4}>
          <boxGeometry args={[1.0, 0.05, 0.12]} />
          <meshBasicMaterial color={c} toneMapped={false} side={DoubleSide} />
        </mesh>
      ))}
    </group>
  );
}
