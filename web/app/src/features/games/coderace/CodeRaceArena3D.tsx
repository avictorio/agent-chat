/* Code Race in 3D (2026-11-19): the vault.

   The world: a violet grid floor running to a striped synthwave sun, and
   at its centre the vault - a cryptex of rings, one per peg (or letter),
   holding the secret everyone is racing for. In front of it stands one
   lock pillar per racer (yours in the middle, nearest), a glass column
   of tumblers showing that racer's latest feedback:
     Colors  a solid white disc per right-place peg, a white ring per
             right-colour-wrong-place peg, dark for the rest (shape is
             the second channel beside brightness)
     Words   a disc per letter, green (right place), amber (in the word
             elsewhere) or dark
   A rival's pillar shows only feedback - never what they guessed - the
   same rule as the page. A ring at each pillar's foot lights when that
   racer has guessed this round.

   A resolved round plays as a reveal on the juice clock:
     spin      every racer who guessed spins their tumblers
     click     tumbler by tumbler, top to bottom, each lands on its new
               state with a click
     crack     a racer who cracked it: their pillar burns full, a pillar
               of light and a burst in their colour
     verdict   the round's title, sound and buzz from the viewer's seat
     open      the race's last round: the vault's rings turn to the
               secret, the winner gets the ceremony
   Catch-up, reduced motion and tap-to-skip work as in Frontlines: the
   latest unseen round replays on open; under reduced motion a round
   lands at once with its title. The guess input and the full record
   stay in the page: the scene shows, the page acts. */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { CameraControls } from "@react-three/drei";
import { CanvasTexture, Color, Object3D, SRGBColorSpace, type Group, type InstancedMesh, type Mesh, type MeshStandardMaterial } from "three";
import { ArenaFrame, FirstFrame, Framer, Ticker, TouchControls, goHome, useQuality, useReducedMotion, type Ctl, type Home } from "../three/arena3d";
import { ArenaPost, ImpactLayer, Intro, JuiceProvider, JuiceRig, SoundToggle, useFirstVisit, useJuice, useJuiceStore, type Impact } from "../three/juice";
import { Burst, HorizonGrid, LightPillar, Shockwave, SkyDome, type SkySpec } from "../three/atmos";
import { BUZZ, sfx } from "../three/sfx";

// One empty list for matches without players or rounds yet, so the memos
// below keep their inputs from one render to the next.
const NO_ITEMS: never[] = [];

const CR_SKY: SkySpec = {
  top: "#020108",
  mid: "#090418",
  horizon: "#2a0b3d",
  ground: "#030108",
  glow: "#a855f7",
  glowAmt: 0.3,
  stars: 0.07,
  // the striped sun sits behind the vault (az pi: the far side)
  sun: { size: 0.22, az: Math.PI, el: 0.07, a: "#f0abfc", b: "#7c3aed" },
};

const PHONE_BELOW = 560;
const VAULT_Z = -5.2;
const VAULT_Y0 = 2.4; // the vault's rings sit on a plinth, above the racers
const VAULT_STEP = 0.5;
const STEP = 0.42; // tumbler spacing
const BASE = 0.45; // first tumbler's height
// the reveal's beats, in seconds of juice time
const SPIN = 0.45;
const CLICK0 = 0.5;
const CLICK_GAP = 0.16;

type Racer = { name: string; hex: string; you: boolean; x: number; z: number; committed: boolean; solved: number | null; out: boolean };
type TState = "hit" | "near" | "g" | "y" | "off";

function states(g: any, fb: any): TState[] {
  const len = g.length || 4;
  if (fb == null) return Array(len).fill("off");
  if (g.mode === "words") return String(fb).split("").slice(0, len).map((c) => (c === "G" ? "g" : c === "Y" ? "y" : "off"));
  const b = fb[0] || 0;
  const w = fb[1] || 0;
  return Array.from({ length: len }, (_, i) => (i < b ? "hit" : i < b + w ? "near" : "off"));
}

/* A racer's latest feedback as of round n (rounds they skipped keep the
   one before), and whether they had cracked it by then. */
function latest(g: any, name: string, upto: number): { fb: any; cracked: boolean } {
  let fb: any = null;
  let cracked = false;
  ((g.rounds || []) as any[]).slice(0, upto).forEach((r) => {
    const x = (r.guesses || {})[name];
    if (x) fb = x.fb;
    if ((r.solved || []).indexOf(name) >= 0) cracked = true;
  });
  return { fb, cracked };
}

const smooth = (a: number, b: number, t: number) => {
  const x = Math.min(1, Math.max(0, (t - a) / (b - a)));
  return x * x * (3 - 2 * x);
};

const IDLE_RING = new Color("#7c3aed");
const COL: Record<TState, Color> = {
  hit: new Color("#f8fafc").multiplyScalar(1.5),
  near: new Color("#f8fafc").multiplyScalar(1.35),
  g: new Color("#22c55e").multiplyScalar(1.7),
  y: new Color("#f59e0b").multiplyScalar(1.6),
  off: new Color("#3b3552"),
};

/* ---------- labels: a canvas sprite per racer ---------- */

const labelCache = new Map<string, CanvasTexture>();
function labelTex(name: string, sub: string, hex: string): CanvasTexture {
  const key = name + "|" + sub + "|" + hex;
  const hit = labelCache.get(key);
  if (hit) return hit;
  const c = document.createElement("canvas");
  c.width = 320;
  c.height = 128;
  const x = c.getContext("2d");
  if (x) {
    x.textAlign = "center";
    x.textBaseline = "middle";
    x.shadowColor = "rgba(0,0,0,0.85)";
    x.shadowBlur = 8;
    x.font = "800 50px system-ui, -apple-system, Segoe UI, sans-serif";
    x.fillStyle = hex;
    x.fillText(name.length > 12 ? name.slice(0, 11) + "…" : name, 160, 46);
    if (sub) {
      x.font = "700 30px system-ui, -apple-system, Segoe UI, sans-serif";
      x.fillStyle = "rgba(233,227,251,0.92)";
      x.fillText(sub, 160, 98);
    }
  }
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  labelCache.set(key, t);
  return t;
}

/* ---------- the ledger: your rounds, in the frame ----------
   (2026-11-20, the page's lanes folded into the arena) The rounds you
   guessed, oldest at the top: each guess (pegs with their key letter,
   or the word's tiles) and its feedback, your sealed guess last and
   dimmed. A panel beside each pillar was tried first and read at 60 px
   on a desktop, so it is a compact board in the frame's top-left (the
   in-frame slot the other games use for their caption), hidden while a
   round replays. A rival's latest feedback is on their tumblers and
   their history in the History tab; the canvas label reads every
   racer's rounds. Rows follow the settled rounds, so a replay never
   spoils its round. */

type LedgerRow = { n: number; guess: string | null; fb: any; cracked: boolean; sealed?: boolean };
const LEDGER_MAX = 8; // rows on the board; earlier ones fold into a "+k earlier" line

function ledgerRows(g: any, name: string, upto: number, sealedGuess: string | null): LedgerRow[] {
  const rows: LedgerRow[] = [];
  ((g.rounds || []) as any[]).slice(0, upto).forEach((r) => {
    const x = (r.guesses || {})[name];
    if (!x) return;
    rows.push({ n: r.n, guess: x.guess || null, fb: x.fb, cracked: (r.solved || []).indexOf(name) >= 0 });
  });
  if (sealedGuess) rows.push({ n: g.round, guess: sealedGuess, fb: null, cracked: false, sealed: true });
  return rows;
}

function LedgerBoard({ g, rows, pal }: { g: any; rows: LedgerRow[]; pal: Record<string, string> }) {
  const len = g.length || 4;
  const words = g.mode === "words";
  const shown = rows.slice(-LEDGER_MAX);
  const earlier = rows.length - shown.length;
  return (
    <div className="arena3d-caption cr-ledger" role="group" aria-label="Your guesses">
      <div className="cr-ledger-h">Your guesses</div>
      {earlier ? <div className="cr-ledger-more">+{earlier} earlier</div> : null}
      {shown.map((r) => {
        const fbs = String(r.fb || "");
        return (
          <div key={r.n + (r.sealed ? "s" : "")} className={"cr-lrow" + (r.sealed ? " sealed" : "") + (r.cracked ? " cracked" : "")}>
            <span className="cr-ln">R{r.n}</span>
            {words ? (
              <span className="cr-ltiles">
                {Array.from({ length: len }, (_, i) => {
                  const f = r.fb == null ? "" : fbs[i] || ".";
                  return (
                    <span key={i} className={"cr-ltile " + (f === "G" ? "g" : f === "Y" ? "y" : r.fb == null ? "open" : "n")}>
                      {r.guess ? String(r.guess[i] || "").toUpperCase() : ""}
                    </span>
                  );
                })}
              </span>
            ) : (
              <>
                <span className="cr-lpegs">
                  {Array.from({ length: len }, (_, i) => {
                    const k = r.guess ? r.guess[i] : null;
                    return (
                      <span key={i} className="cr-lpeg" style={k && pal[k] ? { background: pal[k] } : undefined}>
                        {k || ""}
                      </span>
                    );
                  })}
                </span>
                {r.fb != null ? (
                  <span className="cr-lpips" style={{ gridTemplateColumns: "repeat(" + Math.ceil(len / 2) + ", 7px)" }} aria-label={((r.fb && r.fb[0]) || 0) + " right place, " + ((r.fb && r.fb[1]) || 0) + " right colour"}>
                    {Array.from({ length: len }, (_, i) => {
                      const b = (r.fb && r.fb[0]) || 0;
                      const w = (r.fb && r.fb[1]) || 0;
                      return <span key={i} className={"cr-lpip" + (i < b ? " hit" : i < b + w ? " near" : "")} />;
                    })}
                  </span>
                ) : null}
              </>
            )}
            {r.sealed ? <span className="cr-lsealed">sealed</span> : null}
          </div>
        );
      })}
    </div>
  );
}

/* ---------- the vault ---------- */

function Vault({ g, open, still, pal }: { g: any; open: number; still: boolean; pal: Record<string, string> }) {
  const len = g.length || 4;
  const j = useJuice();
  const rings = useRef<(Group | null)[]>([]);
  const mats = useRef<(MeshStandardMaterial | null)[]>([]);
  const secret: string[] | null = g.secret == null ? null : g.mode === "words" ? String(g.secret).split("") : (g.secret as string[]);
  const ringCols = useMemo(
    () =>
      Array.from({ length: len }, (_, i) => {
        if (!secret) return new Color("#7c3aed");
        return new Color(g.mode === "words" ? "#22c55e" : pal[secret[i] || ""] || "#c084fc");
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [len, secret && secret.join(""), g.mode]
  );
  useFrame((state) => {
    let moving = false;
    for (let i = 0; i < len; i++) {
      const r = rings.current[i];
      const m = mats.current[i];
      if (!r || !m) continue;
      // idle: the rings drift, alternate ways; opening: they spin up and
      // settle facing front, lit in the secret's colours
      const k = smooth(i * 0.12, 0.6 + i * 0.12, open);
      const idle = still ? 0 : j.t * 0.25 * (i % 2 ? -1 : 1) + i;
      r.rotation.y = idle * (1 - k) + k * Math.PI * 2 * (1 - k) * 2;
      // the secret's colours only once the vault opens (no early tell)
      m.emissive.copy(open > 0 ? ringCols[i]! : IDLE_RING);
      m.emissiveIntensity = secret ? 0.3 + 1.5 * k : 0.14 + (still ? 0 : 0.06 * Math.sin(j.t * 1.3 + i));
      if (open > 0 && open < 1.6) moving = true;
    }
    if (moving) state.invalidate();
  });
  const coreH = VAULT_Y0 + len * VAULT_STEP + 0.2;
  return (
    <group position={[0, 0, VAULT_Z]}>
      <mesh position={[0, 0.15, 0]}>
        <cylinderGeometry args={[1.9, 2.2, 0.3, 48]} />
        <meshStandardMaterial color="#120a1f" metalness={0.6} roughness={0.35} emissive="#7c3aed" emissiveIntensity={0.18} />
      </mesh>
      {/* the plinth */}
      <mesh position={[0, (VAULT_Y0 - 0.35) / 2 + 0.3, 0]}>
        <cylinderGeometry args={[0.85, 1.25, VAULT_Y0 - 0.35, 6]} />
        <meshStandardMaterial color="#160c26" metalness={0.5} roughness={0.45} emissive="#4c1d95" emissiveIntensity={0.2} />
      </mesh>
      <mesh position={[0, coreH / 2 + 0.2, 0]}>
        <cylinderGeometry args={[0.55, 0.55, coreH, 32]} />
        <meshStandardMaterial color="#0b0614" metalness={0.8} roughness={0.25} emissive="#c084fc" emissiveIntensity={0.12} />
      </mesh>
      {Array.from({ length: len }, (_, i) => (
        <group key={i} position={[0, VAULT_Y0 + 0.25 + (len - 1 - i) * VAULT_STEP, 0]} ref={(el) => (rings.current[i] = el)}>
          <mesh rotation={[Math.PI / 2, 0, 0]}>
            <torusGeometry args={[0.95, 0.16, 12, 48]} />
            <meshStandardMaterial ref={(el) => (mats.current[i] = el)} color="#241638" metalness={0.5} roughness={0.35} emissive="#7c3aed" emissiveIntensity={0.25} toneMapped={false} />
          </mesh>
          {/* the notch: which way a ring faces */}
          <mesh position={[0, 0, 1.08]}>
            <boxGeometry args={[0.16, 0.24, 0.1]} />
            <meshStandardMaterial color="#e9d5ff" emissive="#e9d5ff" emissiveIntensity={0.6} />
          </mesh>
        </group>
      ))}
      {secret && g.mode === "words"
        ? secret.map((ch, i) => (
            <sprite key={"s" + i} position={[0, VAULT_Y0 + 0.25 + (len - 1 - i) * VAULT_STEP, 1.35]} scale={[0.5 * Math.min(1, open), 0.5 * Math.min(1, open), 1]}>
              <spriteMaterial map={letterTex(ch.toUpperCase())} transparent depthWrite={false} />
            </sprite>
          ))
        : null}
    </group>
  );
}

const letterCache = new Map<string, CanvasTexture>();
function letterTex(ch: string): CanvasTexture {
  const hit = letterCache.get(ch);
  if (hit) return hit;
  const c = document.createElement("canvas");
  c.width = 64;
  c.height = 64;
  const x = c.getContext("2d");
  if (x) {
    x.textAlign = "center";
    x.textBaseline = "middle";
    x.font = "900 50px system-ui, -apple-system, Segoe UI, sans-serif";
    x.fillStyle = "#f0fdf4";
    x.shadowColor = "#22c55e";
    x.shadowBlur = 10;
    x.fillText(ch, 32, 35);
  }
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  letterCache.set(ch, t);
  return t;
}

/* ---------- the lock pillars ---------- */

/* Every racer's tumblers in two instanced draws (discs and rings). Each
   racer's tumblers go from `from` to `to` at the reveal's clicks. */
function Tumblers({
  g,
  racers,
  from,
  to,
  playing,
  t0,
  still,
}: {
  g: any;
  racers: Racer[];
  from: Record<string, TState[]>;
  to: Record<string, TState[]>;
  playing: Record<string, boolean>;
  t0: number | null;
  still: boolean;
}) {
  const discs = useRef<InstancedMesh>(null);
  const rings = useRef<InstancedMesh>(null);
  const j = useJuice();
  // coins and rings face the camera; a spin turns them about the pillar
  const o = useMemo(() => {
    const x = new Object3D();
    x.rotation.order = "YXZ";
    return x;
  }, []);
  const c = useMemo(() => new Color(), []);
  const len = g.length || 4;
  const settled = useRef(false);
  useEffect(() => {
    settled.current = false;
  }, [from, to, t0, racers, still]);
  useFrame((state) => {
    const a = discs.current;
    const b = rings.current;
    if (!a || !b) return;
    const t = t0 == null || still ? Infinity : j.t - t0;
    if (settled.current && t === Infinity) return;
    let na = 0;
    let nb = 0;
    racers.forEach((r) => {
      const fs = from[r.name] || [];
      const ts = to[r.name] || [];
      const spinning = playing[r.name] && t < CLICK0 + len * CLICK_GAP;
      for (let i = 0; i < len; i++) {
        const landAt = CLICK0 + i * CLICK_GAP;
        const landed = t >= landAt;
        const s: TState = landed ? ts[i] || "off" : fs[i] || "off";
        const y = BASE + (len - 1 - i) * STEP; // the code reads top down
        const spin = spinning && !landed ? (t * 14 + i) % (Math.PI * 2) : 0;
        const pop = landed ? 1 + 0.25 * (1 - smooth(landAt, landAt + 0.18, t)) : 1;
        const flick = spinning && !landed ? 0.35 + 0.25 * Math.sin(t * 40 + i * 2) : 1;
        o.position.set(r.x, y, r.z);
        if (s === "near") {
          o.rotation.set(0, spin, 0);
          o.scale.setScalar(pop);
          o.updateMatrix();
          b.setMatrixAt(nb, o.matrix);
          c.copy(COL.near).multiplyScalar(flick);
          b.setColorAt(nb, c);
          nb++;
          // a dark core inside the ring keeps the coin's place
          o.rotation.set(Math.PI / 2, spin, 0);
          o.scale.set(0.55, 1, 0.55);
          o.updateMatrix();
          a.setMatrixAt(na, o.matrix);
          a.setColorAt(na, COL.off);
          na++;
        } else {
          o.rotation.set(Math.PI / 2, spin, 0);
          o.scale.set(pop, 1, pop);
          o.updateMatrix();
          a.setMatrixAt(na, o.matrix);
          c.copy(COL[s]).multiplyScalar(s === "off" ? 1 : flick);
          a.setColorAt(na, c);
          na++;
        }
      }
    });
    a.count = na;
    b.count = nb;
    a.instanceMatrix.needsUpdate = true;
    b.instanceMatrix.needsUpdate = true;
    if (a.instanceColor) a.instanceColor.needsUpdate = true;
    if (b.instanceColor) b.instanceColor.needsUpdate = true;
    if (t === Infinity) settled.current = true;
    else state.invalidate();
  });
  const cap = racers.length * len * 2 + 2;
  return (
    <>
      <instancedMesh ref={discs} args={[undefined, undefined, cap]} frustumCulled={false}>
        <cylinderGeometry args={[0.17, 0.17, 0.07, 28]} />
        <meshBasicMaterial toneMapped={false} />
      </instancedMesh>
      <instancedMesh ref={rings} args={[undefined, undefined, cap]} frustumCulled={false}>
        <torusGeometry args={[0.145, 0.04, 10, 28]} />
        <meshBasicMaterial toneMapped={false} />
      </instancedMesh>
    </>
  );
}

/* A pillar's glass and base: the racer's colour on the foot ring, which
   lights while they have guessed this round (breathes while thinking),
   and burns while they have cracked it. */
function Pillar({ g, r, lit, burn, crackedIn, still }: { g: any; r: Racer; lit: boolean; burn: boolean; crackedIn: number | null; still: boolean }) {
  const len = g.length || 4;
  const h = BASE + len * STEP + 0.05;
  const foot = useRef<MeshStandardMaterial>(null);
  const spine = useRef<Mesh>(null);
  const j = useJuice();
  useFrame(() => {
    const m = foot.current;
    if (!m) return;
    m.emissiveIntensity = burn ? 1.8 : lit ? 1.25 : r.out ? 0.1 : 0.28 + (still ? 0 : 0.12 * Math.sin(j.t * 2 + r.x));
  });
  const st = crackedIn ? "cracked R" + crackedIn : r.out ? "out" : g.status === "running" ? (r.committed ? "guessed ✓" : "thinking…") : "";
  const sub = r.you ? (st ? "you · " + st : "you") : st;
  return (
    <group>
      <mesh position={[r.x, 0.06, r.z]}>
        <cylinderGeometry args={[0.42, 0.48, 0.12, 36]} />
        <meshStandardMaterial ref={foot} color="#0c0816" emissive={r.hex} emissiveIntensity={0.5} toneMapped={false} />
      </mesh>
      {/* the spine the tumblers ride on, and its cap */}
      <mesh ref={spine} position={[r.x, h / 2 + 0.1, r.z - 0.12]}>
        <cylinderGeometry args={[0.045, 0.045, h, 10]} />
        <meshStandardMaterial color="#2a2140" metalness={0.8} roughness={0.3} emissive={r.hex} emissiveIntensity={burn ? 1.4 : 0.15} toneMapped={!burn} />
      </mesh>
      <mesh position={[r.x, h + 0.16, r.z - 0.12]}>
        <sphereGeometry args={[0.1, 16, 10]} />
        <meshStandardMaterial color={r.hex} emissive={r.hex} emissiveIntensity={burn ? 2.4 : 0.6} toneMapped={false} />
      </mesh>
      {/* the nameplate on the floor in front */}
      <sprite position={[r.x, 0.18, r.z + 1.25]} scale={[1.8, 0.72, 1]} renderOrder={5}>
        <spriteMaterial map={labelTex(r.name, sub, r.hex)} transparent depthWrite={false} depthTest={false} />
      </sprite>
    </group>
  );
}

/* ---------- the reveal's clock and beats ---------- */

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

function Beats({
  t0,
  len,
  crackAt,
  verdictAt,
  openAt,
  doneAt,
  onClick,
  onCrack,
  onVerdict,
  onOpen,
  onDone,
}: {
  t0: number;
  len: number;
  crackAt: number;
  verdictAt: number;
  openAt: number | null;
  doneAt: number;
  onClick: (i: number) => void;
  onCrack: () => void;
  onVerdict: () => void;
  onOpen: () => void;
  onDone: () => void;
}) {
  const j = useJuice();
  const fired = useRef(new Set<string>());
  useFrame((state) => {
    const t = j.t - t0;
    state.invalidate();
    const once = (k: string, at: number, fn: () => void) => {
      if (t >= at && !fired.current.has(k)) {
        fired.current.add(k);
        fn();
      }
    };
    if (t < SPIN && !fired.current.has("spin")) {
      fired.current.add("spin");
      sfx("charge");
    }
    for (let i = 0; i < len; i++) once("c" + i, CLICK0 + i * CLICK_GAP, () => onClick(i));
    once("crack", crackAt, onCrack);
    once("v", verdictAt, onVerdict);
    if (openAt != null) once("open", openAt, onOpen);
    once("done", doneAt, onDone);
  });
  return null;
}

/* ---------- impacts from the viewer's seat ---------- */

function crackImpact(solvers: string[], racers: Racer[]): Impact | null {
  if (!solvers.length) return null;
  const you = racers.find((r) => r.you);
  if (you && solvers.indexOf(you.name) >= 0)
    return { trauma: 0.55, stop: 180, pulse: 0.9, buzz: BUZZ.sankTheirs, sound: ["shatter", "win"], title: { big: "CRACKED", small: "You cracked it" + (solvers.length > 1 ? " · with " + solvers.filter((n) => n !== you.name).join(", ") : ""), tone: "good" } };
  if (you && !you.solved)
    return { trauma: 0.4, stop: 120, pulse: 0.5, buzz: BUZZ.hitYou, sound: "shatter", title: { big: "CRACKED", small: solvers.join(" & ") + (solvers.length > 1 ? " crack it" : " cracks it") + " · keep racing", tone: "bad" } };
  return { trauma: 0.25, stop: 80, sound: "shatter", title: { big: "CRACKED", small: solvers.join(" & ") + (solvers.length > 1 ? " crack it" : " cracks it"), tone: "neutral" } };
}

function roundImpact(g: any, round: any, racers: Racer[], prevBest: number): Impact {
  const you = racers.find((r) => r.you);
  const x = you ? (round.guesses || {})[you.name] : null;
  if (you && x) {
    const st = states(g, x.fb);
    const good = st.filter((s) => s === "hit" || s === "g").length;
    const close = st.filter((s) => s === "near" || s === "y").length;
    const small = g.mode === "words" ? good + " green · " + close + " yellow" : good + " right place · " + close + " right colour";
    const better = good * 10 + close > prevBest;
    return { trauma: better ? 0.15 : 0.08, stop: better ? 60 : 0, buzz: better ? BUZZ.commit : undefined, sound: better ? "ping" : "beat", title: { big: "ROUND " + round.n, small: (better ? "Closer · " : "") + small, tone: better ? "good" : "neutral" } };
  }
  if (you && !you.solved && !you.out) return { trauma: 0.1, sound: "buzzer", title: { big: "ROUND " + round.n, small: "No guess from you this round", tone: "bad" } };
  return { sound: "beat", title: { big: "ROUND " + round.n, small: Object.keys(round.guesses || {}).length + " guesses in", tone: "neutral" } };
}

function finalImpact(g: any, racers: Racer[]): Impact {
  const you = racers.find((r) => r.you);
  const places: string[] = g.places || [];
  const winner = g.winner as string | null;
  const what = g.mode === "words" ? "word" : "code";
  if (!winner) return { trauma: 0.3, stop: 120, sound: you ? "lose" : "whoosh", buzz: you ? BUZZ.lostMatch : undefined, title: { big: "THE " + what.toUpperCase() + " HOLDS", small: "Nobody cracked it", tone: you ? "bad" : "neutral" } };
  const wr = racers.find((r) => r.name === winner);
  const how = wr && wr.solved ? " in round " + wr.solved : "";
  if (you && you.name === winner) return { trauma: 0.8, stop: 250, slow: 0.8, pulse: 1, buzz: BUZZ.wonMatch, sound: ["clash", "win"], title: { big: "VICTORY", small: "First to crack the " + what + how, tone: "good" } };
  if (you && you.solved) {
    const place = places.indexOf(you.name) + 1;
    return { trauma: 0.4, stop: 150, pulse: 0.6, buzz: BUZZ.scored, sound: "win", title: { big: "#" + place, small: winner + " cracked it first" + how, tone: "neutral" } };
  }
  if (you) return { trauma: 0.8, stop: 250, slow: 0.8, pulse: 0.8, buzz: BUZZ.lostMatch, sound: ["clash", "lose"], title: { big: "DEFEAT", small: winner + " cracked the " + what + how, tone: "bad" } };
  return { trauma: 0.6, stop: 200, slow: 0.6, pulse: 0.8, buzz: BUZZ.scored, sound: ["clash", "win"], title: { big: winner.toUpperCase() + " WINS", small: "Cracked it" + how, tone: "neutral" } };
}

function sayRound(g: any, round: any, racers: Racer[], over: boolean): string {
  if (!round) return "";
  const parts = racers.map((r) => {
    const x = (round.guesses || {})[r.name];
    if (!x) return r.name + ": no guess";
    const st = states(g, x.fb);
    const good = st.filter((s) => s === "hit" || s === "g").length;
    const close = st.filter((s) => s === "near" || s === "y").length;
    return r.name + ": " + good + (g.mode === "words" ? " green, " : " right place, ") + close + (g.mode === "words" ? " yellow" : " right colour");
  });
  const solved: string[] = round.solved || [];
  return "Round " + round.n + ". " + parts.join("; ") + "." + (solved.length ? " " + solved.join(" and ") + " cracked it." : "") + (over ? (g.winner ? " " + g.winner + " wins the race." : " Nobody cracked it.") : "");
}

/* ---------- what the viewer has seen ---------- */

function seenKey(id: unknown): string {
  let path = "";
  try {
    path = location.pathname;
  } catch {
    path = "";
  }
  return "ac-cr-seen:" + path + ":" + String(id);
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

/* Home: every pillar and its label, the vault behind, a band of sky. The
   camera backs off along a fixed view until all the key points project
   inside the frame. */
function crHome(aspect: number, width: number, racers: Racer[], len: number): Home {
  const phone = width < PHONE_BELOW;
  const vfov = aspect < 1 ? 56 : 46;
  const tv = Math.tan((vfov * Math.PI) / 360);
  const th = tv * Math.max(0.45, aspect);
  const elF = ((phone ? 19 : 16) * Math.PI) / 180;
  const pitch = elF + (1 * Math.PI) / 180;
  const top = BASE + len * STEP + 0.3;
  const fy = 1.7;
  const fz = -1.2;
  const pts: [number, number, number][] = [
    [0, VAULT_Y0 + len * VAULT_STEP + 0.6, VAULT_Z],
    [-2.2, 0, VAULT_Z],
    [2.2, 0, VAULT_Z],
  ];
  racers.forEach((r) => pts.push([r.x - 0.8, 0, r.z + 1.5], [r.x + 0.8, 0, r.z + 1.5], [r.x, top, r.z]));
  const dy = -Math.sin(pitch);
  const dz = -Math.cos(pitch);
  const fits = (d: number) => {
    const cy = fy + d * Math.sin(elF);
    const cz = fz + d * Math.cos(elF);
    return pts.every(([x, y, z]) => {
      const vy = y - cy;
      const vz = z - cz;
      const zc = vy * dy + vz * dz;
      if (zc <= 0.1) return false;
      const yc = vy * -dz + vz * dy;
      return Math.abs(x / (zc * th)) <= 0.82 && Math.abs(yc / (zc * tv)) <= 0.8;
    });
  };
  let lo = 3;
  let hi = 80;
  for (let k = 0; k < 28; k++) {
    const mid = (lo + hi) / 2;
    if (fits(mid)) hi = mid;
    else lo = mid;
  }
  const cy = fy + hi * Math.sin(elF);
  const cz = fz + hi * Math.cos(elF);
  return { pos: [0, cy, cz], fov: vfov, tz: cz - cy / Math.tan(pitch) };
}

/* ---------- the arena ---------- */

export default function CodeRaceArena3D({
  g,
  me = "",
  aspect,
  onReady,
  registerCommit,
}: {
  g: any;
  me?: string;
  aspect?: number;
  onReady?: () => void;
  registerCommit?: (fn: (() => void) | null) => void;
}) {
  const still = useReducedMotion();
  const q = useQuality(still);
  const juice = useJuiceStore(still);
  const firstVisit = useFirstVisit("cr:" + String((g && g.id) || ""));
  const [ready, setReady] = useState(false);
  const ctl = useRef<Ctl | null>(null);
  const homeRef = useRef<Home | null>(null);
  const [hostW, setHostW] = useState(() => (aspect && aspect < 1.4 ? 390 : 760));
  const phone = hostW < PHONE_BELOW;
  const meL = me.toLowerCase();
  const players: any[] = (g && g.players) || NO_ITEMS;
  const rounds: any[] = (g && g.rounds) || NO_ITEMS;
  const finished = !!g && g.status === "finished";
  const running = !!g && g.status === "running";
  const len = (g && g.length) || 4;
  const pal = useMemo(() => {
    const m: Record<string, string> = {};
    ((g && g.palette) || []).forEach((c: any) => (m[c.k] = c.hex));
    return m;
  }, [g]);

  // The viewer's pillar in the middle, nearest; the rest fan out.
  const racers: Racer[] = useMemo(() => {
    const list = players.slice();
    const mine = list.findIndex((p) => String(p.name).toLowerCase() === meL);
    let order = list;
    if (mine >= 0) {
      const others = list.filter((_, i) => i !== mine);
      const mid = Math.floor(list.length / 2);
      order = others.slice(0, mid).concat([list[mine]], others.slice(mid));
    }
    const gap = phone ? 1.75 : 2.15;
    const n = order.length;
    return order.map((p: any, i: number) => {
      const k = i - (n - 1) / 2;
      return {
        name: String(p.name),
        hex: String(p.hex || "#c084fc"),
        you: String(p.name).toLowerCase() === meL,
        x: k * gap,
        z: 1.1 - 0.16 * k * k,
        committed: !!p.committed,
        solved: p.solved || null,
        out: !!p.out,
      };
    });
  }, [players, meL, phone]);

  /* `shown` rounds are settled; `playing` is the round being revealed. */
  const [init] = useState(() => {
    const n = rounds.length;
    const seen = readSeen(g && g.id);
    if (seen == null || !n || seen >= n) return { shown: n };
    return { shown: n - 1 };
  });
  const [shown, setShown] = useState(init.shown);
  const [playing, setPlaying] = useState<{ n: number; t0: number | null } | null>(null);
  const [go, setGo] = useState(false);
  const [open, setOpen] = useState(() => (finished && init.shown >= rounds.length ? 1 : 0));
  const [fx, setFx] = useState<{ id: number; at: [number, number, number]; hex: string; pillar: boolean }[]>([]);
  const fxId = useRef(0);
  const [ceremony, setCeremony] = useState(0);
  const [say, setSay] = useState("");
  const [sealed, setSealed] = useState<number | null>(null);

  useEffect(() => {
    if (!ready || go) return;
    const t = setTimeout(() => setGo(true), firstVisit && !still ? 2700 : 500);
    return () => clearTimeout(t);
  }, [ready, go, firstVisit, still]);

  const bestBefore = (n: number) => {
    const you = racers.find((r) => r.you);
    if (!you) return 0;
    let best = 0;
    rounds.slice(0, n - 1).forEach((r: any) => {
      const x = (r.guesses || {})[you.name];
      if (!x) return;
      const st = states(g, x.fb);
      best = Math.max(best, st.filter((s) => s === "hit" || s === "g").length * 10 + st.filter((s) => s === "near" || s === "y").length);
    });
    return best;
  };
  const isLast = (n: number) => finished && n === rounds.length;
  const land = (n: number, quiet: boolean) => {
    const r = rounds[n - 1];
    setPlaying(null);
    setShown(n);
    if (!r) return;
    const hits: Impact[] = [];
    const ci = crackImpact(r.solved || [], racers);
    if (isLast(n)) hits.push(finalImpact(g, racers));
    else if (ci) hits.push(ci);
    else hits.push(roundImpact(g, r, racers, bestBefore(n)));
    hits.forEach((h) => juice.hit(quiet ? { ...h, trauma: 0, stop: 0, slow: 0, pulse: 0 } : h));
    setSay(sayRound(g, r, racers, isLast(n)));
    if (isLast(n)) {
      setOpen(1);
      setCeremony((c) => c + 1);
    }
  };

  useEffect(() => {
    if (!go || playing) return;
    const n = rounds.length;
    if (n <= shown) {
      if (finished && open < 1 && n === shown) setOpen(1);
      return;
    }
    if (still) land(n, false);
    else setPlaying({ n, t0: null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [go, playing, rounds.length, shown, still]);

  useEffect(() => {
    writeSeen(g && g.id, shown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown]);

  const skip = () => {
    if (playing) land(playing.n, true);
  };

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
    racers.forEach((r) => (now[r.name] = r.committed));
    const prev = prevCommit.current;
    prevCommit.current = now;
    if (!prev || !ready) return;
    racers.forEach((r) => {
      if (!r.you && r.committed && !prev[r.name]) juice.hit({ sound: "ping" });
    });
  }, [racers, ready, juice]);

  // What each pillar shows: settled = the latest feedback as of `shown`;
  // during a reveal, from the round before to the round being played.
  const fieldN = playing ? playing.n : shown;
  const fromN = playing ? playing.n - 1 : shown;
  const fromStates = useMemo(() => {
    const m: Record<string, TState[]> = {};
    racers.forEach((r) => {
      const l = latest(g, r.name, fromN);
      m[r.name] = l.cracked ? Array(len).fill(g.mode === "words" ? "g" : "hit") : states(g, l.fb);
    });
    return m;
  }, [g, racers, fromN, len]);
  const toStates = useMemo(() => {
    const m: Record<string, TState[]> = {};
    racers.forEach((r) => {
      const l = latest(g, r.name, fieldN);
      m[r.name] = states(g, l.fb);
    });
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [g, racers, fieldN, len]);
  const playingRound = playing ? rounds[playing.n - 1] : null;
  const spinning = useMemo(() => {
    const m: Record<string, boolean> = {};
    if (playingRound) Object.keys(playingRound.guesses || {}).forEach((n) => (m[n] = true));
    return m;
  }, [playingRound]);
  const crackedBy = (n: number) => {
    const s = new Set<string>();
    rounds.slice(0, n).forEach((r: any) => (r.solved || []).forEach((x: string) => s.add(x)));
    return s;
  };
  const [burnN, setBurnN] = useState(-1);
  const burnUpto = playing ? (burnN === playing.n ? playing.n : playing.n - 1) : shown;
  const burnSet = crackedBy(burnUpto);
  const crackedIn = (name: string): number | null => {
    for (const r of rounds.slice(0, burnUpto)) if ((r.solved || []).indexOf(name) >= 0) return r.n;
    return null;
  };

  const t0 = playing ? playing.t0 : null;
  const crackAt = CLICK0 + len * CLICK_GAP + 0.25;
  const verdictAt = crackAt + 0.4;
  const last = playing ? isLast(playing.n) : false;
  const openAt = last ? verdictAt + 0.2 : null;
  const doneAt = last ? verdictAt + 2.4 : verdictAt + 0.7;
  const winnerR = finished && g.winner ? racers.find((r) => r.name === g.winner) || null : null;
  /* Each racer's ledger rows (settled rounds, plus your sealed guess). */
  const ledgers = useMemo(() => {
    const m: Record<string, LedgerRow[]> = {};
    racers.forEach((r) => {
      const sealedGuess = r.you && running && !playing && g.you && g.you.queued ? String(g.you.queued) : null;
      m[r.name] = ledgerRows(g, r.name, shown, sealedGuess);
    });
    return m;
  }, [racers, g, shown, running, playing]);
  const myLedger = (racers.find((r) => r.you) && ledgers[racers.find((r) => r.you)!.name]) || [];
  const home = (a: number, width: number) => crHome(a, width, racers, len);
  const first = home(aspect || 1.6, hostW);
  const fbWords = (fb: any) =>
    g.mode === "words"
      ? String(fb || "")
          .split("")
          .map((c) => (c === "G" ? "green" : c === "Y" ? "amber" : "grey"))
          .join(" ")
      : ((fb && fb[0]) || 0) + " right place, " + ((fb && fb[1]) || 0) + " right colour";
  const ledgerSay = racers
    .map((r) => {
      const rows = (ledgers[r.name] || []).filter((x) => !x.sealed);
      if (!rows.length) return "";
      return (r.you ? "Your rounds: " : r.name + "'s rounds: ") + rows.map((x) => x.n + (x.guess ? " " + (g.mode === "words" ? x.guess.toUpperCase() : x.guess.split("").join(" ")) : "") + " - " + fbWords(x.fb)).join("; ");
    })
    .filter(Boolean)
    .join(". ");
  const label =
    "Code Race arena, 3D view: " +
    racers.map((r) => r.name + (r.you ? " (you)" : "") + (r.solved ? ", cracked it in round " + r.solved : r.out ? ", out" : running ? (r.committed ? ", guessed" : ", thinking") : "")).join("; ") +
    (fieldN ? ". On the pillars: round " + fieldN + "." : ".") +
    (ledgerSay ? " " + ledgerSay + "." : "");
  const intro = firstVisit ? { title: "Code Race", sub: racers.map((r) => r.name).join(" · ") || "Crack the code", color: "#c084fc" } : null;

  // the vault opens over ~1.4 s once the race is over (at once when still)
  const [openT, setOpenT] = useState(open);
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
            {playing && playingRound ? (
              <div className="duel-catchup" aria-hidden="true">
                Round {playingRound.n} · tap to skip
              </div>
            ) : myLedger.length ? (
              <LedgerBoard g={g} rows={myLedger} pal={pal} />
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
          <color attach="background" args={["#04020a"]} />
          <fog attach="fog" args={["#12061f", 26, 95]} />
          <SkyDome spec={CR_SKY} />
          <hemisphereLight args={["#e9d5ff", "#07030f", 0.55]} />
          <directionalLight position={[-5, 8, 10]} intensity={1.1} color="#f5d0fe" />
          <HorizonGrid half={[60, 60]} cell={1.5} a="#2e1065" b="#a855f7" fade={40} line={0.55} y={0.002} />
          <OpenClock target={open} still={still} onValue={setOpenT} />
          <Vault g={g} open={openT} still={still} pal={pal} />
          {racers.map((r) => (
            <Pillar key={r.name} g={g} r={r} lit={running && !playing && (r.committed || (r.you && sealed === g.round))} burn={burnSet.has(r.name)} crackedIn={crackedIn(r.name)} still={still} />
          ))}
          <Tumblers g={g} racers={racers} from={playing ? fromStates : toStates} to={toStates} playing={spinning} t0={t0} still={still} />
          {playing && playingRound && t0 == null ? <ClockStart key={"c" + playing.n} onStart={(t) => setPlaying((p) => (p && p.t0 == null ? { ...p, t0: t } : p))} /> : null}
          {playing && playingRound && t0 != null ? (
            <Beats
              key={"b" + playing.n}
              t0={t0}
              len={len}
              crackAt={crackAt}
              verdictAt={verdictAt}
              openAt={openAt}
              doneAt={doneAt}
              onClick={(i) => sfx(i === len - 1 ? "lock" : "snip")}
              onCrack={() => {
                const solvers: string[] = playingRound.solved || [];
                if (!solvers.length) return;
                setBurnN(playing.n);
                solvers.forEach((n) => {
                  const r = racers.find((x) => x.name === n);
                  if (!r) return;
                  setFx((l) => [...l.slice(-6), { id: ++fxId.current, at: [r.x, BASE + len * STEP * 0.5, r.z], hex: r.hex, pillar: true }]);
                });
                if (!last) {
                  const ci = crackImpact(solvers, racers);
                  if (ci) juice.hit(ci);
                }
              }}
              onVerdict={() => {
                setSay(sayRound(g, playingRound, racers, last));
                if (!last && !(playingRound.solved || []).length) juice.hit(roundImpact(g, playingRound, racers, bestBefore(playing.n)));
              }}
              onOpen={() => {
                setOpen(1);
                sfx("charge");
              }}
              onDone={() => {
                if (last) {
                  juice.hit(finalImpact(g, racers));
                  setCeremony((c) => c + 1);
                }
                setPlaying(null);
                setShown(playing.n);
              }}
            />
          ) : null}
          {fx.map((f) => (
            <group key={f.id}>
              <Burst at={f.at} hex={f.hex} box={[0.8, 1.6, 0.8]} count={q.lite ? 24 : 44} power={1.6} piece={0.08} dur={1.1} onDone={() => setFx((l) => l.filter((x) => x.id !== f.id))} />
              {f.pillar && !still ? <LightPillar at={[f.at[0], 0, f.at[2]]} hex={f.hex} height={9} width={0.5} /> : null}
            </group>
          ))}
          {ceremony && winnerR && !still ? (
            <group key={"cer" + ceremony}>
              <LightPillar at={[winnerR.x, 0, winnerR.z]} hex={winnerR.hex} height={14} width={0.75} />
              <Shockwave at={[0, 0.05, VAULT_Z * 0.4]} hex={winnerR.hex} radius={13} dur={1.2} />
            </group>
          ) : null}
          <CameraControls ref={ctl} makeDefault minDistance={4} maxDistance={60} maxPolarAngle={Math.PI / 2.1} />
          <TouchControls ctl={ctl} />
          <Framer home={home} ctl={ctl} homeRef={homeRef} />
          <Intro ctl={ctl} homeRef={homeRef} enabled={!!intro && !still} ready={ready} />
          <ArenaPost q={q} bloom={1.1} threshold={0.95} vignette={0.6} />
        </Canvas>
      </ArenaFrame>
    </JuiceProvider>
  );
}

/* The vault's opening as a value on the juice clock: it eases toward its
   target (0 shut, 1 open) over ~1.4 s, at once under reduced motion. */
function OpenClock({ target, still, onValue }: { target: number; still: boolean; onValue: (v: number) => void }) {
  const j = useJuice();
  const v = useRef(target);
  const last = useRef(-1);
  const t0 = useRef<number | null>(null);
  useFrame((state) => {
    if (still || target === 0) {
      v.current = target;
    } else if (v.current < target) {
      if (t0.current == null) t0.current = j.t;
      v.current = Math.min(target, (j.t - t0.current) / 1.4);
      state.invalidate();
    }
    const q = Math.round(v.current * 40) / 40;
    if (q !== last.current) {
      last.current = q;
      onValue(q);
    }
  });
  return null;
}
