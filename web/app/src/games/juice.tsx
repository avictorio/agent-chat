/* The impact layer ("juice") shared by the 3D arenas (2026-11-13).

   A moment that matters - your ship sinks, your rider derezzes, your
   duel is lost - must land on every channel at once, scaled to how
   much it matters (see .claude/skills/immersive-3d-games):

   - trauma: camera shake. Trauma (0..1) is added per hit and decays
     linearly; the shake is trauma squared, driven by smooth noise,
     applied as a CameraControls focal offset (drei's CameraShake
     fights CameraControls, so it is not used). Small hits barely
     move; a fatal one rattles.
   - stop / slow: hit-stop (time frozen for ~100-250 ms) and slow
     motion (a quarter speed, easing back). Effects that should feel
     it advance on useJuice().t instead of the R3F clock.
   - pulse: a post-processing kick - bloom swells and the edges
     split into chromatic fringes - that decays in ~0.6 s.
   - flash and title: a full-frame colour flash (at most 3 a second,
     WCAG 2.3.1) and a title card ("DEREZZED", "SUNK") over the
     canvas, drawn by ImpactLayer in the DOM.
   - buzz and sound: vibration (Android web) and synthesized sound
     (sfx.ts), behind the arena's sound toggle.

   Reduced motion keeps the information and drops the motion: no
   shake, no hit-stop or slow motion, no pulse; flashes become soft
   fades; title cards fade without scaling; sound and vibration stay.

   Under frameloop "demand" nothing renders unless asked, so every
   channel invalidates while it runs. */
import { createContext, useContext, useEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { Bloom, ChromaticAberration, EffectComposer, Noise, ToneMapping, Vignette } from "@react-three/postprocessing";
import { BlendFunction, ToneMappingMode, type BloomEffect, type ChromaticAberrationEffect } from "postprocessing";
import { Vector2 } from "three";
import type { Ctl, Quality } from "./arena3d";
import { buzz, setSfxMuted, sfx, sfxMuted, type SfxName } from "./sfx";

export type Title = { big: string; small?: string; tone?: "good" | "bad" | "neutral"; hex?: string };
export type Impact = {
  trauma?: number;
  stop?: number; // ms
  slow?: number; // s
  pulse?: number;
  flash?: string;
  flashA?: number;
  buzz?: number | readonly number[];
  sound?: SfxName | SfxName[];
  soundDelay?: number;
  title?: Title;
  titleDelay?: number;
};

const SLOW = 0.25;

export class Juice {
  still = false;
  trauma = 0;
  pulse = 0;
  stopUntil = 0;
  slowFrom = 0;
  slowUntil = 0;
  t = 0;
  scale = 1;
  flashes: number[] = [];
  invalidate: (() => void) | null = null;
  onFlash: ((color: string, a: number) => void) | null = null;
  onTitle: ((t: Title) => void) | null = null;

  hit(i: Impact): void {
    const now = performance.now();
    if (!this.still) {
      if (i.trauma) this.trauma = Math.min(1, this.trauma + i.trauma);
      if (i.stop) this.stopUntil = Math.max(this.stopUntil, now + i.stop);
      if (i.slow) {
        this.slowFrom = Math.max(now, this.stopUntil);
        this.slowUntil = Math.max(this.slowUntil, this.slowFrom + i.slow * 1000);
      }
      if (i.pulse) this.pulse = Math.max(this.pulse, i.pulse);
    }
    if (i.flash) this.flash(i.flash, i.flashA ?? 0.5);
    if (i.buzz) buzz(i.buzz);
    if (i.sound) sfx(i.sound, i.soundDelay || 0);
    if (i.title) {
      const t = i.title;
      if (i.titleDelay) setTimeout(() => this.onTitle && this.onTitle(t), i.titleDelay);
      else if (this.onTitle) this.onTitle(t);
    }
    if (this.invalidate) this.invalidate();
  }

  flash(color: string, a: number): void {
    const now = performance.now();
    this.flashes = this.flashes.filter((t) => now - t < 1000);
    if (this.flashes.length >= 3) return; // WCAG 2.3.1: no more than three a second
    this.flashes.push(now);
    if (this.onFlash) this.onFlash(color, this.still ? a * 0.5 : a);
  }

  /* The time scale now: 0 in a hit-stop, SLOW in slow motion easing
     back to 1 over its last 40 %. */
  scaleAt(now: number): number {
    if (now < this.stopUntil) return 0;
    if (now < this.slowUntil) {
      const span = this.slowUntil - this.slowFrom;
      const p = span > 0 ? (now - this.slowFrom) / span : 1;
      return p < 0.6 ? SLOW : SLOW + (1 - SLOW) * ((p - 0.6) / 0.4) ** 2;
    }
    return 1;
  }
}

const JuiceCtx = createContext<Juice | null>(null);

export function useJuiceStore(still: boolean): Juice {
  const ref = useRef<Juice | null>(null);
  if (!ref.current) ref.current = new Juice();
  ref.current.still = still;
  return ref.current;
}

/* True the first time this page session opens this game (the entry
   sequence plays once, not on every repaint or revisit). */
export function useFirstVisit(key: string): boolean {
  const [first] = useState(() => {
    try {
      const k = "ac-intro:" + key;
      if (sessionStorage.getItem(k)) return false;
      sessionStorage.setItem(k, "1");
      return true;
    } catch {
      return false;
    }
  });
  return first;
}

export function JuiceProvider({ juice, children }: { juice: Juice; children: ReactNode }) {
  return <JuiceCtx.Provider value={juice}>{children}</JuiceCtx.Provider>;
}

export function useJuice(): Juice {
  const j = useContext(JuiceCtx);
  if (!j) throw new Error("useJuice outside JuiceProvider");
  return j;
}

/* Smooth 1D value noise in [-1, 1]. */
function vnoise(x: number, seed: number): number {
  const i = Math.floor(x);
  const f = x - i;
  const h = (n: number) => {
    const s = Math.sin((n + seed * 17.13) * 127.1) * 43758.5453;
    return (s - Math.floor(s)) * 2 - 1;
  };
  const u = f * f * (3 - 2 * f);
  return h(i) * (1 - u) + h(i + 1) * u;
}

/* In the Canvas: advances the juice clock, shakes the camera, and
   keeps frames coming while any channel runs. Max shake scales with
   the camera's distance, so it reads the same on every board. */
export function JuiceRig({ ctl, reach = 1 }: { ctl: RefObject<Ctl | null>; reach?: number }) {
  const j = useJuice();
  const invalidate = useThree((s) => s.invalidate);
  const camera = useThree((s) => s.camera);
  const shaking = useRef(false);
  useEffect(() => {
    j.invalidate = invalidate;
    return () => {
      j.invalidate = null;
    };
  }, [j, invalidate]);
  useFrame((_, delta) => {
    const now = performance.now();
    const dt = Math.min(delta, 0.1);
    j.scale = j.scaleAt(now);
    j.t += dt * j.scale;
    let busy = j.scale < 1 || now < j.slowUntil;
    if (j.pulse > 0) {
      j.pulse = Math.max(0, j.pulse - dt * 1.7);
      busy = true;
    }
    const c = ctl.current;
    if (j.trauma > 0 && !j.still) {
      j.trauma = Math.max(0, j.trauma - dt * 1.1);
      const s = j.trauma * j.trauma;
      const d = camera.position.length();
      const amp = s * d * 0.035 * reach;
      const T = now / 1000;
      if (c) void c.setFocalOffset(amp * vnoise(T * 22, 1), amp * 0.8 * vnoise(T * 22, 2), 0, false);
      shaking.current = true;
      busy = true;
    } else if (shaking.current) {
      shaking.current = false;
      j.trauma = 0;
      if (c) void c.setFocalOffset(0, 0, 0, false);
      busy = true;
    }
    if (busy) invalidate();
  });
  return null;
}

/* The arenas' shared post stack: bloom, chromatic fringes, a fine
   film grain, vignette and tone mapping (last - the composer renders
   linear HDR and tone maps nothing on its own). Bloom intensity and
   the fringes swell with juice.pulse. Touch devices skip the grain. */
export function ArenaPost({
  q,
  bloom,
  threshold,
  smoothing = 0.25,
  vignette = 0.58,
  fringe = 0.0006,
}: {
  q: Quality;
  bloom: number;
  threshold: number;
  smoothing?: number;
  vignette?: number;
  fringe?: number;
}) {
  const j = useJuice();
  const bl = useRef<BloomEffect>(null);
  const ca = useRef<ChromaticAberrationEffect>(null);
  const [offset] = useState(() => new Vector2(fringe, fringe));
  useFrame(() => {
    const p = j.still ? 0 : j.pulse;
    if (bl.current) bl.current.intensity = bloom * (1 + p * 1.4);
    if (ca.current) {
      const o = fringe + p * 0.006;
      ca.current.offset.set(o, o * 0.6);
    }
  });
  return (
    <EffectComposer multisampling={q.msaa}>
      <>
        <Bloom ref={bl} mipmapBlur intensity={bloom} luminanceThreshold={threshold} luminanceSmoothing={smoothing} />
        <ChromaticAberration ref={ca} offset={offset} radialModulation modulationOffset={0.35} />
        {q.lite ? <></> : <Noise premultiply blendFunction={BlendFunction.SCREEN} opacity={0.18} />}
        <Vignette offset={0.2} darkness={vignette} />
        <ToneMapping mode={ToneMappingMode.NEUTRAL} />
      </>
    </EffectComposer>
  );
}

/* Over the canvas (DOM): the impact flash and the title cards. */
export type IntroCard = { title: string; sub?: string; color: string };
export function ImpactLayer({ juice, intro, ready }: { juice: Juice; intro?: IntroCard | null; ready?: boolean }) {
  const flashRef = useRef<HTMLDivElement>(null);
  const irisRef = useRef<HTMLDivElement>(null);
  const [irisOn, setIrisOn] = useState(!!intro);
  /* The iris: the world's colour covers the canvas until the scene is
     ready, then opens from the centre (fades, under reduced motion)
     and the world's name comes up. */
  useEffect(() => {
    if (!intro || !ready) return;
    const el = irisRef.current;
    const t = setTimeout(() => juice.onTitle && juice.onTitle({ big: intro.title, small: intro.sub, tone: "neutral", hex: intro.color }), 350);
    if (!el) return () => clearTimeout(t);
    let anim: Animation | null = null;
    try {
      const hole = el.firstElementChild as HTMLElement | null;
      anim =
        juice.still || !hole
          ? el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 700, easing: "ease-out", fill: "forwards" })
          : hole.animate([{ width: "0px", height: "0px" }, { width: "300vmax", height: "300vmax" }], {
              duration: 1300,
              easing: "cubic-bezier(.55,0,.35,1)",
              fill: "forwards",
            });
    } catch {
      anim = null;
    }
    if (anim) anim.onfinish = () => setIrisOn(false);
    else setIrisOn(false);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);
  const [card, setCard] = useState<(Title & { k: number }) | null>(null);
  useEffect(() => {
    juice.onFlash = (color, a) => {
      const el = flashRef.current;
      if (!el) return;
      el.style.background = "radial-gradient(ellipse at center, " + color + " 0%, " + color + " 35%, transparent 85%)";
      try {
        el.animate([{ opacity: a }, { opacity: 0 }], { duration: juice.still ? 600 : 420, easing: "cubic-bezier(.2,.7,.3,1)" });
      } catch {
        // no Web Animations: skip the flash
      }
    };
    let k = 0;
    juice.onTitle = (t) => setCard({ ...t, k: ++k });
    return () => {
      juice.onFlash = null;
      juice.onTitle = null;
    };
  }, [juice]);
  useEffect(() => {
    if (!card) return;
    const t = setTimeout(() => setCard(null), 2300);
    return () => clearTimeout(t);
  }, [card]);
  return (
    <div className="impact-layer" aria-hidden="true">
      {intro && irisOn ? (
        <div ref={irisRef} className="impact-iris">
          <div className="impact-iris-hole" style={{ "--ic": intro.color } as CSSProperties} />
        </div>
      ) : null}
      <div ref={flashRef} className="impact-flash" />
      {card ? (
        <div
          key={card.k}
          className={"impact-title " + (card.tone || "neutral") + (juice.still ? " calm" : "")}
          style={card.hex ? ({ "--tc": card.hex } as CSSProperties) : undefined}
        >
          <div className="impact-big">{card.big}</div>
          {card.small ? <div className="impact-small">{card.small}</div> : null}
        </div>
      ) : null}
    </div>
  );
}

/* The arena's sound (and vibration) toggle, beside Reset view. */
export function SoundToggle() {
  const [off, setOff] = useState(() => sfxMuted());
  return (
    <button
      type="button"
      className="arena3d-sound"
      aria-pressed={!off}
      title={off ? "Sound and vibration are off - tap to turn them on" : "Sound and vibration are on - tap to turn them off"}
      onClick={() => {
        const m = !off;
        setSfxMuted(m);
        setOff(m);
        if (!m) sfx("lock");
      }}
    >
      {off ? "🔇" : "🔊"}
      <span className="sr-only">{off ? "Sound off" : "Sound on"}</span>
    </button>
  );
}

/* Entering the world: the first time a viewer opens a game in this
   page session (firstVisit), the camera starts low with the horizon
   and sky in view, swung round, then cranes up to its home framing once the scene
   is ready - while ImpactLayer's iris opens and the world's name
   comes up. Placed after Framer, so home is known. Reduced motion:
   no flight (the iris just fades). */
export function Intro({
  ctl,
  homeRef,
  enabled,
  ready,
}: {
  ctl: RefObject<Ctl | null>;
  homeRef: { current: { pos: [number, number, number]; fov: number; tz?: number } | null };
  enabled: boolean;
  ready: boolean;
}) {
  // 0 not started, 1 at the start pose, 2 holding/flying, 3 home
  const phase = useRef(0);
  const timer = useRef(0);
  const smooth = useRef<number | null>(null);
  const gl = useThree((s) => s.gl);
  const camera = useThree((s) => s.camera);
  // Framer sets home on the first measured frame; place the camera at
  // the start of the flight on the first frame home is known - before
  // the iris opens, so the viewer never sees the jump.
  useFrame(() => {
    if (!enabled || phase.current) return;
    const c = ctl.current;
    const h = homeRef.current;
    if (!c || !h) return;
    phase.current = 1;
    const [x, y, z] = h.pos;
    const d = Math.hypot(x, y, z);
    // Start low over the far floor, the horizon and sky in view, then
    // crane up and round to the board.
    const az = 0.28;
    const far = d * 1.5;
    const el = 0.1;
    void c.setLookAt(far * Math.cos(el) * Math.sin(az), far * Math.sin(el), far * Math.cos(el) * Math.cos(az), 0, 0, h.tz || 0, false);
    if (ready) go();
  });
  /* Hold the horizon while the iris opens and the world's name comes
     up (~0.9 s), then crane to the board. */
  const go = () => {
    if (phase.current !== 1) return;
    phase.current = 2;
    timer.current = window.setTimeout(() => {
      const c = ctl.current as (Ctl & { smoothTime: number }) | null;
      const h = homeRef.current;
      if (!c || !h || phase.current !== 2) return;
      smooth.current = c.smoothTime;
      c.smoothTime = 0.7;
      void c.setLookAt(h.pos[0], h.pos[1], h.pos[2], 0, 0, h.tz || 0, true).then(() => {
        if (phase.current === 2) {
          phase.current = 3;
          if (smooth.current !== null) c.smoothTime = smooth.current;
        }
      });
    }, 900);
  };
  useEffect(() => {
    if (ready) go();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);
  /* A touch or click skips the entry: the camera snaps home before the
     scene handles the press, so a tap during the flight lands where
     the viewer aimed. (A capture listener on the canvas runs before
     R3F's handlers on its parent.) */
  useEffect(() => {
    if (!enabled) return;
    const el = gl.domElement;
    const skip = () => {
      if (phase.current === 0 || phase.current === 3) return;
      phase.current = 3;
      clearTimeout(timer.current);
      const c = ctl.current as (Ctl & { smoothTime: number; update: (d: number) => boolean }) | null;
      const h = homeRef.current;
      if (!c || !h) return;
      if (smooth.current !== null) c.smoothTime = smooth.current;
      void c.setLookAt(h.pos[0], h.pos[1], h.pos[2], 0, 0, h.tz || 0, false);
      c.update(0);
      camera.updateMatrixWorld();
    };
    el.addEventListener("pointerdown", skip, true);
    return () => {
      el.removeEventListener("pointerdown", skip, true);
      clearTimeout(timer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, gl, camera]);
  return null;
}
