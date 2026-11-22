/* Werewolf in 3D (2026-11-20): the village square.

   The world: a ring of cottages round a square with a bonfire, under a
   big moon by night (blue, cold, quiet) and a warm sky by day. Every
   player is a figure in their colour in a circle round the fire, you
   nearest the camera; the dead lie where they fell, their role card
   turned up over them. Your own role shows only to you (a badge over
   your figure); a werewolf also sees the pack's eyes glow, and every
   role holder sees a ring under tonight's pick - nobody else does.

   By day the votes are public: a line from each voter to their pick in
   the voter's colour, a count over each name. Each new dawn or vote
   plays on the juice clock: the victim falls and their role card flips
   up, with the title from the viewer's seat; the last one adds the
   winners' pillars. Catch-up, tap to skip and reduced motion as in the
   other arenas; the talk, the votes and the timeline live in the page
   under the scene. */
import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { CameraControls } from "@react-three/drei";
import {
  BufferGeometry,
  CanvasTexture,
  Color,
  Float32BufferAttribute,
  SRGBColorSpace,
  type Group,
} from "three";
import { ArenaFrame, FirstFrame, Framer, Ticker, TouchControls, goHome, useQuality, useReducedMotion, type Ctl, type Home } from "../three/arena3d";
import { ArenaPost, ImpactLayer, Intro, JuiceProvider, JuiceRig, SoundToggle, useFirstVisit, useJuice, useJuiceStore, type Impact } from "../three/juice";
import { Burst, LightPillar, SkyDome, type SkySpec } from "../three/atmos";
import { FireSystem } from "../three/fire";
import { BUZZ, sfx } from "../three/sfx";
import type { WerewolfEvent, WerewolfPlayer, WerewolfState, WerewolfYou } from "@chat/contract";

// One empty list for matches without players or rounds yet, so the memos
// below keep their inputs from one render to the next.
const NO_ITEMS: never[] = [];

const NIGHT_SKY: SkySpec = { top: "#01030c", mid: "#050b22", horizon: "#13204a", ground: "#020308", glow: "#93c5fd", glowAmt: 0.1, stars: 0.9 };
const DAY_SKY: SkySpec = { top: "#1e3a8a", mid: "#3b6fb6", horizon: "#f6c28b", ground: "#1a1408", glow: "#fde68a", glowAmt: 0.35, stars: 0 };

const PHONE_BELOW = 560;
const RING_R = 3.1;
const HOUSE_R = 6.4;
type RoleInfo = { name: string; icon: string; hex: string };
const VILLAGER: RoleInfo = { name: "Villager", icon: "🏡", hex: "#fde68a" };
const ROLE: Record<string, RoleInfo> = {
  werewolf: { name: "Werewolf", icon: "🐺", hex: "#f87171" },
  seer: { name: "Seer", icon: "🔮", hex: "#c4b5fd" },
  guardian: { name: "Guardian", icon: "🛡️", hex: "#93c5fd" },
  villager: VILLAGER,
};
const roleInfo = (r?: string | null): RoleInfo => (r && ROLE[r]) || VILLAGER;
const PICK_HEX: Record<string, string> = { kill: "#ef4444", check: "#a78bfa", guard: "#60a5fa" };

type Seat = { name: string; hex: string; you: boolean; x: number; z: number; a: number };

const smooth = (a: number, b: number, t: number) => {
  const x = Math.min(1, Math.max(0, (t - a) / (b - a)));
  return x * x * (3 - 2 * x);
};

const texCache = new Map<string, CanvasTexture>();
function textTex(lines: { text: string; color: string; size: number }[], w = 320, h = 128): CanvasTexture {
  const key = w + "x" + h + ":" + lines.map((l) => l.text + "|" + l.color + "|" + l.size).join("/");
  const hit = texCache.get(key);
  if (hit) return hit;
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const x = c.getContext("2d");
  if (x) {
    x.textAlign = "center";
    x.textBaseline = "middle";
    x.shadowColor = "rgba(0,0,0,0.85)";
    x.shadowBlur = 8;
    const total = lines.reduce((s, l) => s + l.size * 1.15, 0);
    let y = h / 2 - total / 2;
    lines.forEach((l) => {
      x.font = "800 " + l.size + "px system-ui, -apple-system, Segoe UI, sans-serif";
      x.fillStyle = l.color;
      let t = l.text;
      while (x.measureText(t).width > w - 16 && t.length > 4) t = t.slice(0, -2);
      if (t !== l.text) t = t.slice(0, -1) + "…";
      y += (l.size * 1.15) / 2;
      x.fillText(t, w / 2, y);
      y += (l.size * 1.15) / 2;
    });
  }
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  texCache.set(key, t);
  return t;
}

/* ---------- the village ---------- */

function Village({ night }: { night: boolean }) {
  // the cottages stand on the far side of the square - none between the
  // camera and the villagers
  const houses = useMemo(() => Array.from({ length: 7 }, (_, i) => Math.PI - 0.25 + (i / 6) * (Math.PI + 0.5)), []);
  return (
    <group>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.01, 0]}>
        <circleGeometry args={[60, 64]} />
        <meshStandardMaterial color={night ? "#0c1410" : "#3f5a2a"} roughness={0.95} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.003, 0]}>
        <circleGeometry args={[RING_R + 1.2, 64]} />
        <meshStandardMaterial color={night ? "#1c1a17" : "#8a7a5c"} roughness={0.9} />
      </mesh>
      {houses.map((a, i) => (
        <group key={i} position={[Math.cos(a) * HOUSE_R, 0, Math.sin(a) * HOUSE_R]} rotation={[0, -a + Math.PI / 2, 0]}>
          <mesh position={[0, 0.6, 0]}>
            <boxGeometry args={[1.5, 1.2, 1.2]} />
            <meshStandardMaterial color={night ? "#3a3530" : "#d6c7a8"} roughness={0.85} />
          </mesh>
          <mesh position={[0, 1.55, 0]} rotation={[0, Math.PI / 4, 0]}>
            <coneGeometry args={[1.15, 0.8, 4]} />
            <meshStandardMaterial color={night ? "#3a1f17" : "#9a3b2a"} roughness={0.8} />
          </mesh>
          {/* a lit window at night */}
          <mesh position={[0, 0.65, 0.61]}>
            <planeGeometry args={[0.32, 0.32]} />
            <meshBasicMaterial color={night ? new Color("#fbbf24").multiplyScalar(i % 3 ? 1.4 : 0.15) : new Color("#1e293b")} toneMapped={false} />
          </mesh>
        </group>
      ))}
      {[0, 1, 2].map((i) => (
        <mesh key={"log" + i} position={[0, 0.08, 0]} rotation={[0, (i * Math.PI) / 3, Math.PI / 2]}>
          <cylinderGeometry args={[0.06, 0.07, 0.75, 8]} />
          <meshStandardMaterial color="#3f2a17" roughness={0.9} />
        </mesh>
      ))}
    </group>
  );
}

/* A villager: a body and a head in their colour; `fall` (0..1) lays
   them down; `eyes` glows red for the pack (only in a wolf's view). */
function Figure({ s, fall, dead, eyes, still }: { s: Seat; fall: number; dead: boolean; eyes: boolean; still: boolean }) {
  const g = useRef<Group>(null);
  const j = useJuice();
  const col = useMemo(() => (dead ? new Color("#52525b") : new Color(s.hex)), [s.hex, dead]);
  useFrame(() => {
    const o = g.current;
    if (!o) return;
    const sway = still || dead ? 0 : Math.sin(j.t * 1.2 + s.x) * 0.03;
    o.rotation.set(0, -s.a - Math.PI / 2, 0);
    o.rotateX(-fall * (Math.PI / 2 - 0.05));
    o.position.set(s.x, sway * 0.5 + fall * 0.18, s.z);
  });
  return (
    <group ref={g}>
      <mesh position={[0, 0.45, 0]}>
        <capsuleGeometry args={[0.2, 0.5, 6, 12]} />
        <meshStandardMaterial color={col} roughness={0.6} emissive={col} emissiveIntensity={dead ? 0 : 0.18} />
      </mesh>
      <mesh position={[0, 1.02, 0]}>
        <sphereGeometry args={[0.18, 16, 12]} />
        <meshStandardMaterial color={dead ? "#71717a" : "#f5deb3"} roughness={0.7} />
      </mesh>
      {eyes && !dead ? (
        <group position={[0, 1.05, 0.15]}>
          <mesh position={[-0.06, 0, 0]}>
            <sphereGeometry args={[0.03, 8, 6]} />
            <meshBasicMaterial color={new Color("#ef4444").multiplyScalar(3)} toneMapped={false} />
          </mesh>
          <mesh position={[0.06, 0, 0]}>
            <sphereGeometry args={[0.03, 8, 6]} />
            <meshBasicMaterial color={new Color("#ef4444").multiplyScalar(3)} toneMapped={false} />
          </mesh>
        </group>
      ) : null}
    </group>
  );
}

/* The day's votes: a line from each voter to their pick. */
function VoteLines({ votes, seatOf }: { votes: Record<string, string>; seatOf: (n: string) => Seat | undefined }) {
  const geo = useMemo(() => {
    const pos: number[] = [];
    const col: number[] = [];
    for (const v of Object.keys(votes)) {
      const a = seatOf(v);
      const b = seatOf(votes[v] || "");
      if (!a || !b || a === b) continue;
      const c = new Color(a.hex).multiplyScalar(1.6);
      // a gentle arc in a few segments
      const N = 8;
      for (let i = 0; i < N; i++) {
        for (const k of [i / N, (i + 1) / N]) {
          pos.push(a.x + (b.x - a.x) * k, 1.0 + Math.sin(Math.PI * k) * 0.7, a.z + (b.z - a.z) * k);
          col.push(c.r, c.g, c.b);
        }
      }
    }
    const g = new BufferGeometry();
    g.setAttribute("position", new Float32BufferAttribute(pos, 3));
    g.setAttribute("color", new Float32BufferAttribute(col, 3));
    return g;
  }, [votes, seatOf]);
  return (
    <lineSegments geometry={geo}>
      <lineBasicMaterial vertexColors toneMapped={false} transparent opacity={0.9} />
    </lineSegments>
  );
}

/* ---------- the clock for an event ---------- */

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

function Clock({ t0, doneAt, beats, onT, onBeat, onDone }: { t0: number; doneAt: number; beats: [string, number][]; onT: (t: number) => void; onBeat: (k: string) => void; onDone: () => void }) {
  const j = useJuice();
  const fired = useRef(new Set<string>());
  const last = useRef(-1);
  useFrame((state) => {
    const t = j.t - t0;
    state.invalidate();
    const q = Math.round(t * 30) / 30;
    if (q !== last.current) {
      last.current = q;
      onT(t);
    }
    beats.forEach(([k, at]) => {
      if (t >= at && !fired.current.has(k)) {
        fired.current.add(k);
        onBeat(k);
      }
    });
    if (t >= doneAt && !fired.current.has("done")) {
      fired.current.add("done");
      onDone();
    }
  });
  return null;
}

/* ---------- impacts from the viewer's seat ---------- */

function eventImpact(e: WerewolfEvent, me: string, myRole: string | null): Impact {
  const role = roleInfo(e.role);
  const wolf = myRole === "werewolf";
  if (e.kind === "death") {
    if (e.who === me) return { trauma: 0.7, stop: 220, slow: 0.5, buzz: BUZZ.lostOne, sound: ["smash", "lose"], title: { big: "YOU WERE TAKEN", small: "The wolves came for you in the night", tone: "bad" } };
    if (wolf) return { trauma: 0.4, stop: 120, buzz: BUZZ.scored, sound: ["smash"], title: { big: "THE HUNT", small: e.who + " is gone - a " + role.name.toLowerCase(), tone: "good" } };
    return { trauma: 0.45, stop: 140, buzz: me ? BUZZ.hitYou : undefined, sound: ["smash", "shatter"], title: { big: "TAKEN", small: e.who + " was killed in the night - a " + role.name.toLowerCase(), tone: me ? "bad" : "neutral" } };
  }
  if (e.kind === "saved") return { trauma: 0.2, stop: 80, sound: ["clash"], title: { big: "SURVIVED", small: "Someone was attacked in the night and lived", tone: wolf ? "bad" : "good" } };
  if (e.kind === "quiet") return { trauma: 0, sound: "whoosh", title: { big: "DAWN", small: "The night passed quietly", tone: "neutral" } };
  if (e.kind === "eliminated") {
    if (e.who === me) return { trauma: 0.7, stop: 220, slow: 0.5, buzz: BUZZ.lostOne, sound: ["smash", "lose"], title: { big: "VOTED OUT", small: "The village turned on you", tone: "bad" } };
    const caughtWolf = e.role === "werewolf";
    if (wolf) return { trauma: 0.45, stop: 140, buzz: caughtWolf ? BUZZ.hitYou : BUZZ.scored, sound: ["smash"], title: { big: caughtWolf ? "THE PACK SHRINKS" : "VOTED OUT", small: e.who + " - a " + role.name.toLowerCase(), tone: caughtWolf ? "bad" : "good" } };
    return { trauma: 0.45, stop: 140, buzz: me && caughtWolf ? BUZZ.scored : undefined, sound: ["smash"], title: { big: caughtWolf ? "A WOLF!" : "VOTED OUT", small: e.who + " - a " + role.name.toLowerCase(), tone: me ? (caughtWolf ? "good" : "bad") : "neutral" } };
  }
  return { trauma: 0, sound: "whoosh", title: { big: "NO ONE", small: e.kind === "tie" ? "A tied vote - nobody was voted out" : "Nobody voted", tone: "neutral" } };
}

function endImpact(g: WerewolfState, me: string): Impact {
  const side = g.side === "wolves" ? "THE WOLVES WIN" : "THE VILLAGE WINS";
  const playing = me && (g.players || []).some((p: WerewolfPlayer) => p.name === me);
  if (playing && (g.winners || []).indexOf(me) >= 0) return { trauma: 0.8, stop: 250, slow: 0.8, pulse: 1, buzz: BUZZ.wonMatch, sound: ["clash", "win"], title: { big: "VICTORY", small: side.toLowerCase().replace(/^\w/, (c) => c.toUpperCase()), tone: "good" } };
  if (playing) return { trauma: 0.8, stop: 250, slow: 0.8, pulse: 0.8, buzz: BUZZ.lostMatch, sound: ["clash", "lose"], title: { big: "DEFEAT", small: side.toLowerCase().replace(/^\w/, (c) => c.toUpperCase()), tone: "bad" } };
  return { trauma: 0.6, stop: 200, slow: 0.6, pulse: 0.8, sound: ["clash", "win"], title: { big: side, small: (g.winners || []).join(" · "), tone: "neutral" } };
}

function sayEvent(e: WerewolfEvent): string {
  if (!e) return "";
  if (e.kind === "death") return "Dawn " + e.night + ": " + e.who + " was killed in the night, a " + e.role + ".";
  if (e.kind === "saved") return "Dawn " + e.night + ": someone was attacked and survived.";
  if (e.kind === "quiet") return "Dawn " + e.night + ": a quiet night.";
  if (e.kind === "eliminated") return "Day " + e.day + ": the village voted out " + e.who + ", a " + e.role + ".";
  return "Day " + e.day + ": nobody was voted out.";
}

/* ---------- what the viewer has seen ---------- */

function seenKey(id: unknown): string {
  let path = "";
  try {
    path = location.pathname;
  } catch {
    path = "";
  }
  return "ac-ww-seen:" + path + ":" + String(id);
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

function wwHome(aspect: number, width: number): Home {
  const phone = width < PHONE_BELOW;
  const vfov = aspect < 1 ? 56 : 46;
  const tv = Math.tan((vfov * Math.PI) / 360);
  const th = tv * Math.max(0.45, aspect);
  const el = ((phone ? 38 : 30) * Math.PI) / 180;
  const pts: [number, number, number][] = [
    [-RING_R - 0.9, 0, 0],
    [RING_R + 0.9, 0, 0],
    [0, 2.2, -RING_R],
    [0, phone ? -0.55 : -0.4, RING_R + 0.9],
  ];
  const fz = 0.4;
  const at = (d: number) => {
    const cy = d * Math.sin(el);
    const cz = fz + d * Math.cos(el);
    const angs = pts.map(([, y, z]) => Math.atan2(cy - y, cz - z));
    return { cy, cz, pitch: (Math.max(...angs) + Math.min(...angs)) / 2 - 0.06 * Math.atan(tv) };
  };
  const fits = (d: number) => {
    const { cy, cz, pitch } = at(d);
    const dy = -Math.sin(pitch);
    const dz = -Math.cos(pitch);
    return pts.every(([x, y, z]) => {
      const vy = y - cy;
      const vz = z - cz;
      const zc = vy * dy + vz * dz;
      if (zc <= 0.1) return false;
      const yc = vy * -dz + vz * dy;
      const v = yc / (zc * tv);
      return Math.abs(x / (zc * th)) <= 0.95 && v <= 0.84 && v >= -0.95;
    });
  };
  let lo = 2;
  let hi = 60;
  for (let k = 0; k < 28; k++) {
    const mid = (lo + hi) / 2;
    if (fits(mid)) hi = mid;
    else lo = mid;
  }
  const { cy, cz, pitch } = at(hi);
  return { pos: [0, cy, cz], fov: vfov, tz: cz - cy / Math.tan(pitch) };
}

/* ---------- the arena ---------- */

export default function WerewolfArena3D({
  g,
  me = "",
  aspect,
  onReady,
  registerCommit,
}: {
  g: WerewolfState;
  me?: string;
  aspect?: number;
  onReady?: () => void;
  registerCommit?: (fn: (() => void) | null) => void;
}) {
  const still = useReducedMotion();
  const q = useQuality(still);
  const juice = useJuiceStore(still);
  const firstVisit = useFirstVisit("ww:" + String((g && g.id) || ""));
  const [ready, setReady] = useState(false);
  const ctl = useRef<Ctl | null>(null);
  const homeRef = useRef<Home | null>(null);
  const [hostW, setHostW] = useState(() => (aspect && aspect < 1.4 ? 390 : 760));
  const meL = me.toLowerCase();
  const players: WerewolfPlayer[] = (g && g.players) || NO_ITEMS;
  const events: WerewolfEvent[] = (g && g.events) || NO_ITEMS;
  const finished = !!g && g.status === "finished";
  const running = !!g && g.status === "running";
  const you = ((g && g.you) || {}) as Partial<WerewolfYou>;
  const meName = ((players.find((p) => String(p.name).toLowerCase() === meL) || {}) as Partial<WerewolfPlayer>).name || "";
  const myRole: string | null = you.playing ? you.role || null : null;
  const big = hostW < PHONE_BELOW;

  const seats: Seat[] = useMemo(() => {
    const order: string[] = (g && g.order) || [];
    const list = players.slice().sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name));
    const n = list.length;
    const mine = list.findIndex((p) => String(p.name).toLowerCase() === meL);
    return list.map((p: WerewolfPlayer, i: number) => {
      const a = Math.PI / 2 + ((i - (mine >= 0 ? mine : 0)) / Math.max(1, n)) * Math.PI * 2;
      return { name: String(p.name), hex: String(p.hex || "#a3a3a3"), you: String(p.name).toLowerCase() === meL, x: Math.cos(a) * RING_R, z: Math.sin(a) * RING_R, a };
    });
  }, [players, meL, g]);
  const seatMap = useMemo(() => new Map(seats.map((s) => [s.name, s])), [seats]);
  const seatOf = useMemo(() => (n: string) => seatMap.get(n), [seatMap]);

  const [init] = useState(() => {
    const n = events.length;
    const seen = readSeen(g && g.id);
    if (seen == null || !n || seen >= n) return { shown: n };
    return { shown: n - 1 };
  });
  const [shown, setShown] = useState(init.shown);
  const [playing, setPlaying] = useState<{ n: number; t0: number | null } | null>(null);
  const [go, setGo] = useState(false);
  const [rt, setRt] = useState(0);
  const [fx, setFx] = useState<{ id: number; at: [number, number, number]; hex: string }[]>([]);
  const fxId = useRef(0);
  const [ceremony, setCeremony] = useState(0);
  const [say, setSay] = useState("");

  useEffect(() => {
    if (!ready || go) return;
    const t = setTimeout(() => setGo(true), firstVisit && !still ? 2600 : 400);
    return () => clearTimeout(t);
  }, [ready, go, firstVisit, still]);

  const isLast = (n: number) => finished && n === events.length;
  const land = (n: number, quiet: boolean) => {
    const e = events[n - 1];
    setPlaying(null);
    setShown(n);
    if (!e) return;
    const imp = isLast(n) ? endImpact(g, meName) : eventImpact(e, meName, myRole);
    juice.hit(quiet ? { ...imp, trauma: 0, stop: 0, slow: 0, pulse: 0 } : imp);
    setSay(sayEvent(e));
    if (isLast(n)) setCeremony((c) => c + 1);
  };

  const onLand = useEffectEvent(land);
  useEffect(() => {
    if (!go || playing) return;
    const n = events.length;
    if (n <= shown) return;
    // oxlint-disable-next-line react/set-state-in-effect -- new rounds from the server step the replay: reduced motion lands one at once, with its title, sound and buzz
    if (still) onLand(n, false);
    else {
      setRt(0);
      setPlaying({ n, t0: null });
    }
  }, [go, playing, events.length, shown, still]);

  const seenId = g && g.id;
  useEffect(() => {
    writeSeen(seenId, shown);
  }, [seenId, shown]);

  const skip = () => {
    if (playing) land(playing.n, true);
  };

  useEffect(() => {
    if (!registerCommit) return;
    registerCommit(() => juice.hit({ sound: "lock", buzz: BUZZ.commit }));
    return () => registerCommit(null);
  }, [registerCommit, juice]);

  // a public vote or a line of town talk: a soft ping
  const sig = running ? (g.phase || "") + ":" + Object.keys(g.votes || {}).length + ":" + (g.talk || []).length : "";
  const prevSig = useRef<string | null>(null);
  useEffect(() => {
    const p = prevSig.current;
    prevSig.current = sig;
    if (p == null || !ready || p === sig) return;
    juice.hit({ sound: "ping" });
  }, [sig, ready, juice]);

  const ev = playing ? events[playing.n - 1] : null;
  const fallAt = 0.6;
  const doneAt = (ev && ev.who ? fallAt + 2.4 : 1.8) + (playing && isLast(playing.n) ? 2.0 : 0);
  // who lies dead as the scene shows it: everyone the shown events took
  const deadNow = useMemo(() => {
    const upto = playing ? playing.n - 1 : shown;
    const out = new Set<string>();
    events.slice(0, upto).forEach((e) => e.who && out.add(e.who));
    return out;
  }, [events, shown, playing]);
  const roleOf = (n: string) => ((players.find((p) => p.name === n) || {}) as Partial<WerewolfPlayer>).role || (ev && ev.who === n ? ev.role : null);
  // the scene's time of day: the event's (a dawn is morning, a vote is
  // dusk), else the live phase
  const night = ev ? !!ev.night && rt < fallAt : running ? g.phase === "night" : false;
  const pickTarget = running && !ev && g.phase === "night" && you.act ? you.act : null;
  const pickHex = PICK_HEX[myRole === "werewolf" ? "kill" : myRole === "seer" ? "check" : "guard"] || "#ef4444";
  const winners = finished ? seats.filter((s) => (g.winners || []).indexOf(s.name) >= 0 && !deadNow.has(s.name)).slice(0, 4) : [];
  const tally: Record<string, number> = {};
  if (running && !ev && g.phase === "day") for (const v of Object.values(g.votes || {}) as string[]) tally[v] = (tally[v] || 0) + 1;
  const home = (a: number, width: number) => wwHome(a, width);
  const first = home(aspect || 1.6, hostW);
  const alive = players.filter((p) => p.alive).length;
  const label =
    "Werewolf, 3D view: " +
    (running ? (g.phase === "night" ? "night " + g.night + ", the village sleeps. " : "day " + g.day + ", " + alive + " alive, " + Object.keys(g.votes || {}).length + " voted. ") : finished ? (g.side === "wolves" ? "the wolves won. " : "the village won. ") : "") +
    seats.map((s) => s.name + (s.you ? " (you)" : "") + (deadNow.has(s.name) || !((players.find((p) => p.name === s.name) || {}) as Partial<WerewolfPlayer>).alive ? " (dead" + (roleOf(s.name) ? ", " + roleOf(s.name) : "") + ")" : "")).join(", ") +
    ".";
  const intro = firstVisit ? { title: "Werewolf", sub: seats.map((s) => s.name).join(" · ") || "Night falls", color: "#93c5fd" } : null;
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
            {playing && ev ? (
              <div className="duel-catchup" aria-hidden="true">
                {ev.night ? "Dawn " + ev.night : "Day " + ev.day} · tap to skip
              </div>
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
          <color attach="background" args={[night ? "#01030c" : "#3b6fb6"]} />
          <fog attach="fog" args={[night ? "#050b22" : "#c9b48a", 16, 60]} />
          <SkyDome spec={night ? NIGHT_SKY : DAY_SKY} />
          <hemisphereLight args={[night ? "#93c5fd" : "#fff7ed", night ? "#020308" : "#3a2f1a", night ? 0.35 : 0.9]} />
          <directionalLight position={[-6, 9, 5]} intensity={night ? 0.45 : 1.5} color={night ? "#bfdbfe" : "#fff1d6"} />
          <pointLight position={[0, 1.2, 0]} intensity={night ? 10 : 3} distance={8} decay={1.6} color="#fb923c" />
          {night ? (
            <mesh position={[-14, 18, -30]}>
              <sphereGeometry args={[3.2, 32, 24]} />
              <meshBasicMaterial color={new Color("#e0e7ff").multiplyScalar(1.6)} toneMapped={false} />
            </mesh>
          ) : null}
          <Village night={night} />
          <FireSystem fires={[{ key: "bonfire", x: 0, y: 0.1, z: 0, scale: 0.6, light: false, kind: "ship", heat: night ? 1 : 0.6 }]} lite={q.lite} still={still} />
          {seats.map((s) => {
            const p = (players.find((x) => x.name === s.name) || {}) as Partial<WerewolfPlayer>;
            const isVictim = !!ev && ev.who === s.name;
            const dead = deadNow.has(s.name) || (!ev && !p.alive) || (isVictim && rt >= fallAt);
            const fall = isVictim ? smooth(fallAt, fallAt + 0.7, rt) : dead ? 1 : 0;
            const role = dead ? roleOf(s.name) : null;
            const mineRole = s.you && myRole && !dead ? roleInfo(myRole) : null;
            const packEyes = myRole === "werewolf" && (p.name === meName || (you.pack || []).indexOf(s.name) >= 0);
            const ox = Math.cos(s.a);
            const oz = Math.sin(s.a);
            return (
              <group key={s.name}>
                <Figure s={s} fall={fall} dead={dead && fall > 0.95} eyes={packEyes} still={still} />
                {pickTarget === s.name ? (
                  <mesh rotation={[-Math.PI / 2, 0, 0]} position={[s.x, 0.01, s.z]}>
                    <ringGeometry args={[0.38, 0.48, 40]} />
                    <meshBasicMaterial color={new Color(pickHex).multiplyScalar(1.8)} toneMapped={false} />
                  </mesh>
                ) : null}
                <sprite position={s.you ? [s.x + ox * 0.8, 0.05, s.z + oz * 0.8] : [s.x, 1.55, s.z]} scale={big ? [2.6, 1.04, 1] : [1.9, 0.76, 1]} renderOrder={5}>
                  <spriteMaterial
                    map={textTex([
                      { text: s.name + (s.you ? " (you)" : ""), color: dead ? "#a1a1aa" : s.hex, size: 42 },
                      {
                        text: role ? roleInfo(role).icon + " " + roleInfo(role).name : mineRole ? mineRole.icon + " you're the " + mineRole.name.toLowerCase() : tally[s.name] ? tally[s.name] + (tally[s.name] === 1 ? " vote" : " votes") : running && g.phase === "day" && p.voted ? "voted" : "",
                        color: role ? roleInfo(role).hex : mineRole ? mineRole.hex : "#fde68a",
                        size: 30,
                      },
                    ])}
                    transparent
                    depthWrite={false}
                    depthTest={false}
                  />
                </sprite>
              </group>
            );
          })}
          {running && !ev && g.phase === "day" && g.votes ? <VoteLines votes={g.votes} seatOf={seatOf} /> : null}
          {playing && ev && playing.t0 == null ? <ClockStart key={"c" + playing.n} onStart={(t) => setPlaying((p) => (p && p.t0 == null ? { ...p, t0: t } : p))} /> : null}
          {playing && ev && playing.t0 != null ? (
            <Clock
              key={"k" + playing.n}
              t0={playing.t0}
              doneAt={doneAt}
              beats={[["dawn", 0.2], ["fall", fallAt], ["title", fallAt + 0.5]]}
              onT={setRt}
              onBeat={(k) => {
                if (k === "dawn") sfx(ev.night ? "enter" : "beat");
                else if (k === "fall" && ev.who && !q.lite) {
                  const s = seatOf(ev.who);
                  if (s) setFx((l) => [...l.slice(-3), { id: ++fxId.current, at: [s.x, 0.6, s.z], hex: ev.kind === "death" ? "#ef4444" : "#fde68a" }]);
                } else if (k === "title") {
                  juice.hit(eventImpact(ev, meName, myRole));
                  setSay(sayEvent(ev));
                  if (isLast(playing.n)) {
                    setTimeout(() => {
                      juice.hit(endImpact(g, meName));
                      setCeremony((c) => c + 1);
                    }, 1500);
                  }
                }
              }}
              onDone={() => {
                setPlaying(null);
                setShown(playing.n);
              }}
            />
          ) : null}
          {fx.map((f) => (
            <Burst key={f.id} at={f.at} hex={f.hex} box={[0.4, 0.8, 0.4]} count={q.lite ? 18 : 36} power={1.5} piece={0.05} dur={1} onDone={() => setFx((l) => l.filter((x) => x.id !== f.id))} />
          ))}
          {ceremony && !still
            ? winners.map((w) => (
                <group key={"cer" + ceremony + w.name}>
                  <LightPillar at={[w.x, 0, w.z]} hex={g.side === "wolves" ? "#ef4444" : w.hex} height={10} width={0.5} />
                </group>
              ))
            : null}
          <CameraControls ref={ctl} makeDefault minDistance={4} maxDistance={40} maxPolarAngle={Math.PI / 2.1} />
          <TouchControls ctl={ctl} />
          <Framer home={home} ctl={ctl} homeRef={homeRef} />
          <Intro ctl={ctl} homeRef={homeRef} enabled={!!intro && !still} ready={ready} />
          <ArenaPost q={q} bloom={0.9} threshold={0.95} vignette={0.6} />
        </Canvas>
      </ArenaFrame>
    </JuiceProvider>
  );
}
