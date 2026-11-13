/* Shared pieces of the 3D arenas (Light Cycles, Battleship).

   - useReducedMotion: the viewer's prefers-reduced-motion setting,
     live. Scenes freeze decorative motion (flicker, pulses, bob,
     sparkles, camera shake) and skip shot animations under it.
   - FirstFrame: calls onReady once the scene has drawn its first
     frame, so games.ts can lift the "Loading the 3D arena" layer.
   - Framer: R3F applies the Canvas camera props once, at creation,
     so a host that changes shape (a phone rotating) kept the first
     framing and could clip the board. Framer re-applies the home
     framing when the host's shape moves it by more than a little.
   - ArenaFrame: the box around a Canvas. The mouse wheel scrolls the
     page unless Ctrl or Cmd is held (then the scene zooms - a
     trackpad pinch arrives as Ctrl+wheel), and a Reset view button
     returns the camera home. */
import { useEffect, useRef, useState, type ComponentRef, type HTMLAttributes, type ReactNode, type RefObject } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import type { CameraControls } from "@react-three/drei";
import type { PerspectiveCamera } from "three";

export type Ctl = ComponentRef<typeof CameraControls>;
export type Home = { pos: [number, number, number]; fov: number };

const RM = "(prefers-reduced-motion: reduce)";

function reducedNow(): boolean {
  try {
    return !!(window.matchMedia && window.matchMedia(RM).matches);
  } catch {
    return false;
  }
}

export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(reducedNow);
  useEffect(() => {
    let mq: MediaQueryList | null = null;
    try {
      mq = window.matchMedia ? window.matchMedia(RM) : null;
    } catch {
      mq = null;
    }
    if (!mq) return;
    const q = mq;
    const on = () => setReduced(q.matches);
    q.addEventListener("change", on);
    return () => q.removeEventListener("change", on);
  }, []);
  return reduced;
}

export function FirstFrame({ onReady }: { onReady?: () => void }) {
  const done = useRef(false);
  useFrame((state) => {
    if (done.current) return;
    done.current = true;
    if (!onReady) return;
    // three.js skips objects whose shaders are still compiling (with
    // KHR_parallel_shader_compile), so the first frames can be empty:
    // report ready once compileAsync says every program is built,
    // then after one more drawn frame.
    const after = () => requestAnimationFrame(() => requestAnimationFrame(() => onReady()));
    const gl = state.gl as unknown as { compileAsync?: (s: unknown, c: unknown) => Promise<unknown> };
    if (typeof gl.compileAsync === "function") gl.compileAsync(state.scene, state.camera).then(after, after);
    else after();
  });
  return null;
}

export function Framer({
  home,
  ctl,
  homeRef,
}: {
  home: (aspect: number) => Home;
  ctl: RefObject<Ctl | null>;
  homeRef: { current: Home | null };
}) {
  const size = useThree((s) => s.size);
  const camera = useThree((s) => s.camera) as PerspectiveCamera;
  useEffect(() => {
    if (!size.width || !size.height) return;
    const next = home(size.width / size.height);
    const prev = homeRef.current;
    if (prev) {
      const dist = (p: Home) => Math.hypot(p.pos[0], p.pos[1], p.pos[2]);
      // A small change (a scrollbar, a keyboard nudging the viewport)
      // must not yank the camera away from wherever the viewer put it.
      if (Math.abs(dist(next) - dist(prev)) / dist(prev) < 0.08 && next.fov === prev.fov) return;
    }
    homeRef.current = next;
    camera.fov = next.fov;
    camera.updateProjectionMatrix();
    if (ctl.current) void ctl.current.setLookAt(next.pos[0], next.pos[1], next.pos[2], 0, 0, 0, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [size.width, size.height]);
  return null;
}

export function ArenaFrame({
  children,
  onReset,
  frameProps,
}: {
  children: ReactNode;
  onReset: () => void;
  frameProps?: HTMLAttributes<HTMLDivElement>;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    // Capture phase on the frame runs before the camera controls'
    // listener on the canvas; stopping it there lets the page scroll.
    const guard = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) e.stopPropagation();
    };
    node.addEventListener("wheel", guard, { capture: true, passive: true });
    return () => node.removeEventListener("wheel", guard, { capture: true });
  }, []);
  return (
    <div ref={ref} className="arena3d-frame" {...frameProps}>
      {children}
      <button
        type="button"
        className="arena3d-reset"
        onClick={onReset}
        title="Return the camera to its starting view. Hold Ctrl or Cmd and scroll to zoom."
      >
        Reset view
      </button>
    </div>
  );
}

/* Point the camera controls back at the home framing. */
export function goHome(ctl: RefObject<Ctl | null>, home: Home, smooth: boolean) {
  if (ctl.current) void ctl.current.setLookAt(home.pos[0], home.pos[1], home.pos[2], 0, 0, 0, smooth);
}
