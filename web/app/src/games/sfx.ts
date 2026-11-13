/* Arena sound effects, synthesized with Web Audio (2026-11-13) - no
   audio files to fetch, decode or cache. Each effect is layered the
   way a game mix builds an impact: a short transient that says WHEN,
   a body that says WHAT, a tail that says HOW BIG.

   Sound plays only after a gesture unlocked the page's AudioContext
   (chime.ts; browsers refuse audio before one) and while the arena
   sound toggle is on ("ac-sfx-muted", default on). iOS keeps web
   audio silent under the ringer switch - which is why the arenas
   never carry meaning in sound alone. Everything is wrapped: a
   failed sound must never break a game.

   The same toggle governs vibration (buzz): navigator.vibrate works
   in Chrome on Android, after a user gesture; iOS Safari has no web
   vibration at all, so there the camera shake and flash carry it. */
import { audioContext } from "./chime";

export type SfxName =
  | "boom"
  | "bigboom"
  | "splash"
  | "whistle"
  | "ping"
  | "derez"
  | "lock"
  | "charge"
  | "clash"
  | "shatter"
  | "win"
  | "lose"
  | "enter";

const KEY = "ac-sfx-muted";

export function sfxMuted(): boolean {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

export function setSfxMuted(m: boolean): void {
  try {
    localStorage.setItem(KEY, m ? "1" : "0");
  } catch {
    // storage unavailable: the toggle holds for this page only
  }
  muted = m;
}

let muted: boolean | null = null;
function isMuted(): boolean {
  if (muted === null) muted = sfxMuted();
  return muted;
}

/* The vibration vocabulary: one meaning per pattern, never reused for
   the opposite outcome, short (.claude/skills/immersive-3d-games).
   Derived starting values - tune on a real Android phone. */
export const BUZZ = {
  nearMiss: 15, // a shot splashed near your fleet
  scored: 25, // you hit them / took the round
  hitYou: [30, 40, 30], // you were hit / lost the round
  sankTheirs: [40, 60, 40], // you sank a ship
  lostOne: [90, 50, 50], // your ship sunk, your rider derezzed
  wonMatch: [60, 80, 120],
  lostMatch: [120, 80, 60], // the win's contour reversed
} as const;

/* Vibration: one meaning per pattern, short. */
export function buzz(pattern: number | readonly number[]): void {
  if (isMuted()) return;
  try {
    const n = navigator as Navigator & { userActivation?: { hasBeenActive: boolean } };
    if (typeof n.vibrate !== "function") return;
    if (n.userActivation && !n.userActivation.hasBeenActive) return;
    n.vibrate(typeof pattern === "number" ? pattern : [...pattern]);
  } catch {
    // no vibration here
  }
}

let master: GainNode | null = null;
let noise: AudioBuffer | null = null;

function out(ac: AudioContext): GainNode {
  if (master && master.context === ac) return master;
  const comp = ac.createDynamicsCompressor();
  comp.threshold.value = -14;
  comp.knee.value = 10;
  comp.ratio.value = 4;
  comp.attack.value = 0.003;
  comp.release.value = 0.25;
  comp.connect(ac.destination);
  master = ac.createGain();
  master.gain.value = 0.55;
  master.connect(comp);
  return master;
}

function noiseBuf(ac: AudioContext): AudioBuffer {
  if (noise && noise.sampleRate === ac.sampleRate) return noise;
  const len = Math.floor(ac.sampleRate * 1.5);
  noise = ac.createBuffer(1, len, ac.sampleRate);
  const d = noise.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  return noise;
}

/* An envelope: silence, attack to peak, exponential decay. */
function env(ac: AudioContext, t: number, peak: number, attack: number, decay: number, dest: AudioNode): GainNode {
  const g = ac.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  g.connect(dest);
  return g;
}

function noiseSrc(ac: AudioContext, t: number, dur: number, dest: AudioNode, offset = Math.random()): AudioBufferSourceNode {
  const s = ac.createBufferSource();
  s.buffer = noiseBuf(ac);
  s.connect(dest);
  s.start(t, offset * 0.4, dur);
  return s;
}

function osc(ac: AudioContext, type: OscillatorType, t: number, dur: number, f0: number, f1: number | null, dest: AudioNode | AudioParam): OscillatorNode {
  const o = ac.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(f0, t);
  if (f1 !== null) o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur);
  if (dest instanceof AudioNode) o.connect(dest);
  else o.connect(dest);
  o.start(t);
  o.stop(t + dur + 0.05);
  return o;
}

function filt(ac: AudioContext, type: BiquadFilterType, f: number, q: number, dest: AudioNode): BiquadFilterNode {
  const b = ac.createBiquadFilter();
  b.type = type;
  b.frequency.value = f;
  b.Q.value = q;
  b.connect(dest);
  return b;
}

function boom(ac: AudioContext, t: number, o: AudioNode, size: number) {
  // transient: a bright click
  const click = env(ac, t, 0.5 * size, 0.002, 0.04, o);
  noiseSrc(ac, t, 0.08, filt(ac, "highpass", 2400, 0.7, click));
  // body: noise through a closing lowpass
  const body = env(ac, t, 0.9 * size, 0.006, 0.55 + 0.5 * size, o);
  const lp = filt(ac, "lowpass", 2200, 0.9, body);
  lp.frequency.setValueAtTime(2200, t);
  lp.frequency.exponentialRampToValueAtTime(140, t + 0.7 + 0.4 * size);
  noiseSrc(ac, t, 1.4, lp);
  // tail: a falling sub thump
  const sub = env(ac, t, 0.8 * size, 0.004, 0.45 + 0.4 * size, o);
  osc(ac, "sine", t, 0.6 + 0.3 * size, 95, 36, sub);
}

function play(name: SfxName, ac: AudioContext, t: number, o: AudioNode) {
  switch (name) {
    case "boom":
      boom(ac, t, o, 0.6);
      break;
    case "bigboom":
      boom(ac, t, o, 1);
      boom(ac, t + 0.16, o, 0.55);
      break;
    case "splash": {
      const a = env(ac, t, 0.38, 0.012, 0.42, o);
      noiseSrc(ac, t, 0.6, filt(ac, "bandpass", 1300, 0.7, a));
      const b = env(ac, t + 0.03, 0.22, 0.03, 0.75, o);
      noiseSrc(ac, t + 0.03, 0.9, filt(ac, "lowpass", 520, 0.6, b));
      break;
    }
    case "whistle": {
      const g = env(ac, t, 0.07, 0.12, 0.7, o);
      osc(ac, "sine", t, 0.85, 1500, 520, g);
      break;
    }
    case "ping": {
      [0, 0.3, 0.6].forEach((d, i) => {
        const g = env(ac, t + d, 0.16 / (1 + i * 1.6), 0.004, 1.1, o);
        osc(ac, "sine", t + d, 1.2, 1180, 1120, g);
      });
      break;
    }
    case "derez": {
      const g = env(ac, t, 0.32, 0.005, 0.75, o);
      const lp = filt(ac, "lowpass", 2600, 2, g);
      lp.frequency.setValueAtTime(2600, t);
      lp.frequency.exponentialRampToValueAtTime(180, t + 0.75);
      osc(ac, "sawtooth", t, 0.8, 880, 48, lp);
      osc(ac, "square", t, 0.6, 440 * 1.01, 30, lp);
      // a digital tremolo: the voice breaking up into bits
      const trem = ac.createGain();
      trem.gain.value = 0.5;
      const lfo = osc(ac, "square", t, 0.8, 34, null, trem.gain);
      lfo.frequency.setValueAtTime(34, t);
      lp.disconnect();
      lp.connect(trem);
      trem.connect(g);
      const c = env(ac, t, 0.3, 0.003, 0.3, o);
      noiseSrc(ac, t, 0.4, filt(ac, "bandpass", 3600, 1.2, c));
      const sub = env(ac, t, 0.5, 0.004, 0.4, o);
      osc(ac, "sine", t, 0.45, 110, 40, sub);
      break;
    }
    case "lock": {
      const c = env(ac, t, 0.16, 0.001, 0.03, o);
      osc(ac, "square", t, 0.04, 2200, null, c);
      const th = env(ac, t + 0.012, 0.3, 0.003, 0.16, o);
      osc(ac, "sine", t + 0.012, 0.2, 260, 150, th);
      break;
    }
    case "charge": {
      const g = env(ac, t, 0.12, 0.45, 0.25, o);
      const lp = filt(ac, "lowpass", 300, 6, g);
      lp.frequency.setValueAtTime(300, t);
      lp.frequency.exponentialRampToValueAtTime(3200, t + 0.55);
      osc(ac, "sawtooth", t, 0.7, 110, 220, lp);
      osc(ac, "sawtooth", t, 0.7, 165.5, 331, lp);
      break;
    }
    case "clash": {
      [420, 1131, 1893, 2654, 3511].forEach((f, i) => {
        const g = env(ac, t, 0.16 / (1 + i * 0.5), 0.002, 1.4 / (1 + i * 0.7), o);
        osc(ac, "sine", t, 1.5, f, null, g);
      });
      const n = env(ac, t, 0.5, 0.002, 0.14, o);
      noiseSrc(ac, t, 0.2, filt(ac, "highpass", 1800, 0.7, n));
      const sub = env(ac, t, 0.55, 0.003, 0.35, o);
      osc(ac, "sine", t, 0.4, 120, 50, sub);
      break;
    }
    case "shatter": {
      for (let i = 0; i < 14; i++) {
        const d = Math.random() * 0.42;
        const g = env(ac, t + d, 0.18 * (1 - d), 0.001, 0.05 + Math.random() * 0.08, o);
        noiseSrc(ac, t + d, 0.15, filt(ac, "bandpass", 2800 + Math.random() * 4200, 6, g));
      }
      break;
    }
    case "win": {
      [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => {
        const g = env(ac, t + i * 0.1, 0.13, 0.006, 0.9 - i * 0.1, o);
        osc(ac, "triangle", t + i * 0.1, 1, f, null, g);
      });
      const s = env(ac, t + 0.3, 0.05, 0.2, 1.2, o);
      osc(ac, "sine", t + 0.3, 1.4, 2093, null, s);
      break;
    }
    case "lose": {
      [392, 311.13, 261.63].forEach((f, i) => {
        const g = env(ac, t + i * 0.22, 0.15, 0.01, 0.9, o);
        osc(ac, "triangle", t + i * 0.22, 1, f, f * 0.985, filt(ac, "lowpass", 1400, 0.5, g));
      });
      break;
    }
    case "enter": {
      const pad = ac.createGain();
      pad.gain.setValueAtTime(0.0001, t);
      pad.gain.exponentialRampToValueAtTime(0.2, t + 1.1);
      pad.gain.exponentialRampToValueAtTime(0.0001, t + 3.2);
      pad.connect(o);
      osc(ac, "sine", t, 3.2, 55, null, pad);
      osc(ac, "sine", t, 3.2, 82.6, null, pad);
      osc(ac, "triangle", t, 3.2, 110.3, null, filt(ac, "lowpass", 500, 0.5, pad));
      const wind = env(ac, t, 0.12, 1, 1.6, o);
      const bp = filt(ac, "bandpass", 300, 1.4, wind);
      bp.frequency.setValueAtTime(300, t);
      bp.frequency.exponentialRampToValueAtTime(1600, t + 1.4);
      noiseSrc(ac, t, 2.8, bp, 0);
      const sh = env(ac, t + 0.7, 0.03, 0.6, 1.6, o);
      osc(ac, "sine", t + 0.7, 2.3, 1760, 1790, sh);
      break;
    }
  }
}

export function sfx(name: SfxName | SfxName[], delay = 0): void {
  if (isMuted()) return;
  const ac = audioContext();
  if (!ac) return;
  try {
    const t = ac.currentTime + 0.01 + delay;
    const o = out(ac);
    (Array.isArray(name) ? name : [name]).forEach((n) => play(n, ac, t, o));
  } catch {
    // a failed sound must never break a game
  }
}
