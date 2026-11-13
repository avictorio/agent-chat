/* Shared pieces of the 3D arenas (Light Cycles, Battleship).

   - useReducedMotion: the viewer's prefers-reduced-motion setting,
     live. Scenes freeze decorative motion (flicker, pulses, bob,
     sparkles, camera shake) and skip shot animations under it.
   - useQuality: the render budget. Scenes render on demand
     (frameloop "demand"); a Ticker paces ambient animation (fires,
     sparkles, wheels) at 30 fps, 24 on touch devices, and not at all
     under reduced motion - a still scene then costs nothing between
     changes. Transient animations (a shot, a wreck settling, a bike
     turning) request every frame while they run. Touch devices also
     skip the reflective floor (it draws the scene twice), the
     composer's MSAA, and render at a lower pixel-ratio cap.
   - FirstFrame: calls onReady once every shader is compiled and a
     frame has been drawn, so games.ts can lift the loading layer.
   - Framer: R3F applies the Canvas camera props once, at creation,
     so a host that changes shape (a phone rotating) kept the first
     framing and could clip the board. Framer re-applies the home
     framing when the host's shape moves it by more than a little.
   - TouchControls: one finger scrolls the page (the canvas is
     touch-action pan-y, see styles.css) and taps the board; two
     fingers pinch to zoom and turn the view.
   - ArenaFrame: the box around a Canvas. The mouse wheel scrolls the
     page unless Ctrl or Cmd is held (then the scene zooms - a
     trackpad pinch arrives as Ctrl+wheel), a Reset view button
     returns the camera home, and scenes can lay controls over it. */
import { useEffect, useRef, useState, type ComponentRef, type HTMLAttributes, type ReactNode, type RefObject } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import type { CameraControls } from "@react-three/drei";
import type { PerspectiveCamera } from "three";

export type Ctl = ComponentRef<typeof CameraControls>;
/* tz: the look-at point's z (default 0, the board's centre); a
   positive tz lifts the board on screen. */
export type Home = { pos: [number, number, number]; fov: number; tz?: number };
export type Quality = { lite: boolean; dpr: [number, number]; ambientFps: number; msaa: number };

const RM = "(prefers-reduced-motion: reduce)";
const COARSE = "(pointer: coarse)";

function matches(q: string): boolean {
  try {
    return !!(window.matchMedia && window.matchMedia(q).matches);
  } catch {
    return false;
  }
}

function useMedia(q: string): boolean {
  const [on, setOn] = useState(() => matches(q));
  useEffect(() => {
    let mq: MediaQueryList | null = null;
    try {
      mq = window.matchMedia ? window.matchMedia(q) : null;
    } catch {
      mq = null;
    }
    if (!mq) return;
    const m = mq;
    const fn = () => setOn(m.matches);
    m.addEventListener("change", fn);
    return () => m.removeEventListener("change", fn);
  }, [q]);
  return on;
}

export function useReducedMotion(): boolean {
  return useMedia(RM);
}

/* A touch-first device (a phone or tablet): aim-then-fire input and
   the lighter render budget. */
export function useCoarsePointer(): boolean {
  return useMedia(COARSE);
}

export function useQuality(still: boolean): Quality {
  const lite = useCoarsePointer();
  return { lite, dpr: lite ? [1, 1.5] : [1, 1.75], ambientFps: still ? 0 : lite ? 24 : 30, msaa: lite ? 0 : 2 };
}

/* Paces ambient animation under frameloop "demand". */
export function Ticker({ fps }: { fps: number }) {
  const invalidate = useThree((s) => s.invalidate);
  useEffect(() => {
    if (!fps) return;
    let raf = 0;
    let last = 0;
    const loop = (t: number) => {
      raf = requestAnimationFrame(loop);
      if (t - last >= 1000 / fps - 2) {
        last = t;
        invalidate();
      }
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [fps, invalidate]);
  return null;
}

export function FirstFrame({ onReady }: { onReady?: () => void }) {
  const done = useRef(false);
  useFrame((state) => {
    if (done.current) return;
    done.current = true;
    // three.js skips objects whose shaders are still compiling (with
    // KHR_parallel_shader_compile), so the first frames can be empty:
    // once compileAsync says every program is built, draw a frame
    // (on demand - nothing else may ask for one) and report after it.
    const after = () => {
      state.invalidate();
      if (onReady) requestAnimationFrame(() => requestAnimationFrame(() => onReady()));
    };
    const gl = state.gl as unknown as { compileAsync?: (s: unknown, c: unknown) => Promise<unknown> };
    if (typeof gl.compileAsync === "function") gl.compileAsync(state.scene, state.camera).then(after, after);
    else after();
  });
  return null;
}

/* The home framing that fits a board of spanW x spanD world units,
   seen from elevDeg above the horizon with a vfovDeg lens, into a
   host of this aspect. Perspective makes the near edge the widest,
   so width is fitted at the near edge's distance. */
export function fitHome(spanW: number, spanD: number, elevDeg: number, vfovDeg: number, aspect: number, margin: number): Home {
  const el = (elevDeg * Math.PI) / 180;
  const tv = Math.tan((vfovDeg * Math.PI) / 360);
  const th = tv * Math.max(0.3, aspect);
  const nearPull = (spanD / 2) * Math.cos(el);
  const dW = spanW / 2 / th + nearPull;
  const dD = (spanD * Math.sin(el)) / 2 / tv + nearPull;
  const d = Math.max(dW, dD) * margin;
  return { pos: [0, d * Math.sin(el), d * Math.cos(el)], fov: vfovDeg };
}

export function Framer({
  home,
  ctl,
  homeRef,
}: {
  home: (aspect: number, width: number) => Home;
  ctl: RefObject<Ctl | null>;
  homeRef: { current: Home | null };
}) {
  const size = useThree((s) => s.size);
  const camera = useThree((s) => s.camera) as PerspectiveCamera;
  const invalidate = useThree((s) => s.invalidate);
  useEffect(() => {
    if (!size.width || !size.height) return;
    const next = home(size.width / size.height, size.width);
    const prev = homeRef.current;
    if (prev) {
      const dist = (p: Home) => Math.hypot(p.pos[0], p.pos[1], p.pos[2]);
      // A small change (a scrollbar, a keyboard nudging the viewport)
      // must not yank the camera away from wherever the viewer put it.
      const same = Math.abs(dist(next) - dist(prev)) / dist(prev) < 0.08 && next.fov === prev.fov;
      const sameAngle = Math.abs(Math.atan2(next.pos[1], next.pos[2]) - Math.atan2(prev.pos[1], prev.pos[2])) < 0.05;
      if (same && sameAngle && (next.tz || 0) === (prev.tz || 0)) return;
    }
    homeRef.current = next;
    camera.fov = next.fov;
    camera.updateProjectionMatrix();
    if (ctl.current) void ctl.current.setLookAt(next.pos[0], next.pos[1], next.pos[2], 0, 0, next.tz || 0, false);
    invalidate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [size.width, size.height]);
  return null;
}

/* One finger never orbits (it scrolls the page or taps the board);
   two fingers pinch to zoom and twist/drag to turn the view. The
   mouse keeps its drag-to-orbit. */
export function TouchControls({ ctl }: { ctl: RefObject<Ctl | null> }) {
  useEffect(() => {
    const c = ctl.current as unknown as { touches: { one: number; two: number; three: number }; constructor: { ACTION: Record<string, number> } } | null;
    if (!c) return;
    const A = c.constructor.ACTION;
    c.touches.one = A.NONE ?? 0;
    c.touches.two = A.TOUCH_DOLLY_ROTATE ?? c.touches.two;
    c.touches.three = A.NONE ?? 0;
  }, [ctl]);
  return null;
}

export function ArenaFrame({
  children,
  onReset,
  onSize,
  overlay,
  frameProps,
}: {
  children: ReactNode;
  onReset: () => void;
  onSize?: (width: number, height: number) => void;
  overlay?: ReactNode;
  frameProps?: HTMLAttributes<HTMLDivElement>;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const sizeCb = useRef(onSize);
  sizeCb.current = onSize;
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    // Capture phase on the frame runs before the camera controls'
    // listener on the canvas; stopping it there lets the page scroll.
    const guard = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) e.stopPropagation();
    };
    node.addEventListener("wheel", guard, { capture: true, passive: true });
    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver((entries) => {
        const r = entries[0] && entries[0].contentRect;
        if (r && r.width && r.height && sizeCb.current) sizeCb.current(r.width, r.height);
      });
      ro.observe(node);
    }
    return () => {
      node.removeEventListener("wheel", guard, { capture: true });
      if (ro) ro.disconnect();
    };
  }, []);
  return (
    <div ref={ref} className="arena3d-frame" {...frameProps}>
      {children}
      {overlay}
      <button
        type="button"
        className="arena3d-reset"
        onClick={onReset}
        title="Return the camera to its starting view. Hold Ctrl or Cmd and scroll to zoom; on a touch screen, use two fingers."
      >
        Reset view
      </button>
    </div>
  );
}

/* Point the camera controls back at the home framing. */
export function goHome(ctl: RefObject<Ctl | null>, home: Home, smooth: boolean) {
  if (ctl.current) void ctl.current.setLookAt(home.pos[0], home.pos[1], home.pos[2], 0, 0, home.tz || 0, smooth);
}
