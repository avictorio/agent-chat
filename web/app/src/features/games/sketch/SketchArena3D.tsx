/* Sketch & Guess in 3D: the night gallery.

   The world: a gallery wall of deep teal under a warm ceiling glow, a big
   gilt frame in the middle holding the round's drawing (the image, as a
   texture), a brass title plate above it, and a stand per player in front -
   a name plate with the score (the second channel beside colour) and, at
   the reveal, a card with the guess. While the artist draws, the frame
   holds a blank canvas with a slow shimmer and the artist's name; the
   artist's stand is lit by a spotlight. A lamp over a stand says a guess
   is sealed in, never what it is.

   The reveal plays on the juice clock: the plaque turns over to the
   prompt; then each guess card flips in seat order - green for a right
   guess (the Referee's calls marked), red for a wrong one, grey for none
   - and the artist's card shows what the drawing earned. A drawing nobody
   got gets its roast as the title. The last round adds the ceremony from
   the viewer's seat. Catch-up: the rounds seen are remembered per game
   (localStorage) and the latest unseen round replays on open (a tap
   skips); reduced motion lands it at once. */
import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { CameraControls } from "@react-three/drei";
import { CanvasTexture, Color, SRGBColorSpace, TextureLoader, type MeshBasicMaterial, type MeshStandardMaterial, type Texture } from "three";
import { ArenaFrame, FirstFrame, Framer, Ticker, TouchControls, goHome, useQuality, useReducedMotion, type Ctl, type Home } from "../three/arena3d";
import { ArenaPost, ImpactLayer, Intro, JuiceProvider, JuiceRig, SoundToggle, useFirstVisit, useJuice, useJuiceStore, type Impact } from "../three/juice";
import { Burst, LightPillar, Shockwave, SkyDome, type SkySpec } from "../three/atmos";
import { BUZZ } from "../three/sfx";
import type { SketchPlayer, SketchRound, SketchState } from "@chat/contract";

// One empty list for matches without players or rounds yet, so the memos
// below keep their inputs from one render to the next.
const NO_ITEMS: never[] = [];

const SG_SKY: SkySpec = {
  top: "#020708",
  mid: "#06171a",
  horizon: "#164e52",
  ground: "#020405",
  glow: "#fbbf24",
  glowAmt: 0.25,
  stars: 0.04,
};

const PHONE_BELOW = 560;
const GAP = 2.0;
const STAND_W = 1.3;
const STAND_H = 0.95;
const FRAME = { w: 5.2, h: 3.9, y: 3.0, z: -2.4 };
const FLIP = 0.75; // seconds between guess cards in a reveal
const RIGHT = "#4ade80";
const WRONG = "#f87171";

type Seat = { name: string; hex: string; you: boolean };

const standX = (i: number, n: number) => (i - (n - 1) / 2) * GAP;
const standZ = (i: number, n: number) => 1.9 - 0.08 * standX(i, n) * standX(i, n);

/* ---------- canvas text ---------- */

function textTex(lines: { text: string; font: string; color: string }[], w: number, h: number, bg: string | null, border: string | null): CanvasTexture {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const x = c.getContext("2d");
  if (x) {
    if (bg) {
      x.fillStyle = bg;
      x.fillRect(0, 0, w, h);
    }
    if (border) {
      x.strokeStyle = border;
      x.lineWidth = 6;
      x.strokeRect(4, 4, w - 8, h - 8);
    }
    x.textAlign = "center";
    x.textBaseline = "middle";
    const step = h / (lines.length + 1);
    lines.forEach((l, i) => {
      x.font = l.font;
      let size = parseInt((l.font.match(/(\d+)px/) || ["", "30"])[1]!, 10);
      while (x.measureText(l.text).width > w - 30 && size > 14) {
        size -= 2;
        x.font = l.font.replace(/\d+px/, size + "px");
      }
      x.fillStyle = l.color;
      x.fillText(l.text, w / 2, step * (i + 1));
    });
  }
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/* ---------- the room ---------- */

function Gallery({ still }: { still: boolean }) {
  const j = useJuice();
  const glow = useRef<MeshStandardMaterial>(null);
  useFrame(() => {
    if (glow.current) glow.current.emissiveIntensity = 0.5 + (still ? 0 : 0.08 * Math.sin(j.t * 0.7));
  });
  return (
    <group>
      {/* the floor: dark oak, a little gloss */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 0]}>
        <planeGeometry args={[60, 60]} />
        <meshStandardMaterial color="#1c120b" metalness={0.15} roughness={0.55} />
      </mesh>
      {/* the wall */}
      <mesh position={[0, 4, FRAME.z - 0.25]}>
        <planeGeometry args={[40, 8]} />
        <meshStandardMaterial color="#0d2a2e" roughness={0.9} />
      </mesh>
      {/* the picture rail glow along the top of the wall */}
      <mesh position={[0, 7.4, FRAME.z - 0.2]}>
        <boxGeometry args={[40, 0.06, 0.06]} />
        <meshStandardMaterial ref={glow} color="#0d2a2e" emissive="#fbbf24" emissiveIntensity={0.5} toneMapped={false} />
      </mesh>
    </group>
  );
}

/* The frame: gilt edges, the drawing (or a blank canvas with a shimmer
   while the artist works), the plaque under it. */
function Frame({ image, blank, plaque, still }: { image: Texture | null; blank: CanvasTexture; plaque: CanvasTexture; still: boolean }) {
  const j = useJuice();
  const shimmer = useRef<MeshBasicMaterial>(null);
  useFrame((state) => {
    if (shimmer.current && !image) {
      shimmer.current.opacity = still ? 0.12 : 0.1 + 0.08 * (0.5 + 0.5 * Math.sin(j.t * 1.6));
      if (!still) state.invalidate();
    }
  });
  const gilt = "#d6a840";
  const fw = FRAME.w + 0.4;
  const fh = FRAME.h + 0.4;
  return (
    <group position={[0, FRAME.y, FRAME.z]}>
      {[
        [0, fh / 2, fw, 0.22],
        [0, -fh / 2, fw, 0.22],
        [-fw / 2, 0, 0.22, fh + 0.22],
        [fw / 2, 0, 0.22, fh + 0.22],
      ].map(([x, y, w, h], i) => (
        <mesh key={i} position={[x!, y!, 0.06]}>
          <boxGeometry args={[w!, h!, 0.16]} />
          <meshStandardMaterial color={gilt} metalness={0.45} roughness={0.35} emissive="#5a3d0a" emissiveIntensity={0.35} />
        </mesh>
      ))}
      <mesh>
        <planeGeometry args={[FRAME.w, FRAME.h]} />
        <meshBasicMaterial map={image || blank} toneMapped={false} />
      </mesh>
      {!image ? (
        <mesh position={[0, 0, 0.01]}>
          <planeGeometry args={[FRAME.w, FRAME.h]} />
          <meshBasicMaterial ref={shimmer} color={new Color("#fde68a")} transparent opacity={0.12} depthWrite={false} />
        </mesh>
      ) : null}
      {/* the title plate above the frame: below it, the stands' cards
          would cover it from the camera's low angle */}
      <mesh position={[0, fh / 2 + 0.42, 0.04]}>
        <planeGeometry args={[3.2, 0.52]} />
        <meshBasicMaterial map={plaque} toneMapped={false} />
      </mesh>
    </group>
  );
}

/* One stand: a post, the name plate with the score, the sealed lamp, the
   card at the reveal, the artist's spotlight. */
function Stand({ seat, i, n, score, artist, sealed, card }: { seat: Seat; i: number; n: number; score: number; artist: boolean; sealed: boolean; card: { text: string; sub: string; tone: string } | null }) {
  const x = standX(i, n);
  const z = standZ(i, n);
  const plate = useMemo(() => textTex([{ text: seat.name + (seat.you ? " (you)" : ""), font: "800 38px system-ui, sans-serif", color: seat.hex }, { text: score + (score === 1 ? " pt" : " pts") + (artist ? " · artist" : ""), font: "700 26px system-ui, sans-serif", color: "#e7e5e4" }], 256, 104, "#0b0907", seat.hex), [seat.name, seat.you, seat.hex, score, artist]);
  useEffect(() => () => plate.dispose(), [plate]);
  const ctex = useMemo(() => (card ? textTex([{ text: card.text, font: "800 34px system-ui, sans-serif", color: "#fafaf9" }, { text: card.sub, font: "900 34px system-ui, sans-serif", color: card.tone }], 320, 150, "#0b0907", card.tone) : null), [card]);
  useEffect(() => () => ctex?.dispose(), [ctex]);
  return (
    <group position={[x, 0, z]}>
      <mesh position={[0, STAND_H / 2, 0]}>
        <boxGeometry args={[0.16, STAND_H, 0.16]} />
        <meshStandardMaterial color="#2a1d12" metalness={0.3} roughness={0.5} />
      </mesh>
      <mesh position={[0, 0.02, 0]}>
        <cylinderGeometry args={[0.42, 0.48, 0.04, 24]} />
        <meshStandardMaterial color="#2a1d12" metalness={0.3} roughness={0.5} />
      </mesh>
      <mesh position={[0, STAND_H + 0.27, 0.02]} rotation={[-0.25, 0, 0]}>
        <planeGeometry args={[STAND_W, STAND_W * 0.4]} />
        <meshBasicMaterial map={plate} toneMapped={false} />
      </mesh>
      {sealed && !card ? (
        <mesh position={[0.55, STAND_H + 0.62, 0]}>
          <sphereGeometry args={[0.08, 16, 12]} />
          <meshBasicMaterial color={new Color("#facc15").multiplyScalar(2.2)} toneMapped={false} />
        </mesh>
      ) : null}
      {ctex ? (
        <mesh position={[0, STAND_H + 1.15, 0.05]}>
          <planeGeometry args={[1.75, 0.82]} />
          <meshBasicMaterial map={ctex} toneMapped={false} />
        </mesh>
      ) : null}
      {artist ? (
        <mesh position={[0, 3.0, 0]} raycast={() => null}>
          <coneGeometry args={[0.95, 6, 32, 1, true]} />
          <meshBasicMaterial color={new Color("#fde68a").multiplyScalar(0.5)} transparent opacity={0.06} depthWrite={false} toneMapped={false} />
        </mesh>
      ) : null}
    </group>
  );
}

/* The drawing as a texture: loaded from its signed URL, kept per URL. */
function useImage(url: string | null): Texture | null {
  const [tex, setTex] = useState<{ url: string; t: Texture } | null>(null);
  useEffect(() => {
    if (!url) return;
    let alive = true;
    new TextureLoader().load(
      url,
      (t) => {
        t.colorSpace = SRGBColorSpace;
        t.anisotropy = 4;
        if (alive) setTex({ url, t });
        else t.dispose();
      },
      undefined,
      () => {
        // a failed load leaves the blank canvas; the page has the image too
      }
    );
    return () => {
      alive = false;
    };
  }, [url]);
  useEffect(() => () => tex?.t.dispose(), [tex]);
  return tex && tex.url === url ? tex.t : null;
}

/* ---------- the reveal's clock ---------- */

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

function Beats({ t0, count, onBeat, onDone }: { t0: number; count: number; onBeat: (k: number) => void; onDone: () => void }) {
  const j = useJuice();
  const fired = useRef(new Set<number>());
  useFrame((state) => {
    const t = j.t - t0;
    state.invalidate();
    for (let k = 0; k <= count; k++) {
      const at = k === 0 ? 0.4 : 1.1 + (k - 1) * FLIP;
      if (t >= at && !fired.current.has(k)) {
        fired.current.add(k);
        onBeat(k);
      }
    }
    if (t >= 1.1 + count * FLIP + 0.9 && !fired.current.has(-1)) {
      fired.current.add(-1);
      onDone();
    }
  });
  return null;
}

/* ---------- impacts from the viewer's seat ---------- */

function roundImpact(g: SketchState, round: SketchRound | undefined, seats: Seat[], last: boolean): Impact | null {
  const you = seats.find((s) => s.you);
  if (last) {
    if (g.draw) return { trauma: 0.2, stop: 80, sound: "whoosh", title: { big: "DRAW", small: "A tie at the top", tone: "neutral" } };
    if (g.winner && you && g.winner === you.name) return { trauma: 0.8, stop: 250, slow: 0.8, pulse: 1, buzz: BUZZ.wonMatch, sound: ["clash", "win"], title: { big: "VICTORY", small: "The gallery is yours", tone: "good" } };
    if (g.winner && you) return { trauma: 0.7, stop: 220, slow: 0.6, pulse: 0.8, buzz: BUZZ.lostMatch, sound: ["clash", "lose"], title: { big: "DEFEAT", small: g.winner + " takes the gallery", tone: "bad" } };
    if (g.winner) return { trauma: 0.5, stop: 160, slow: 0.5, pulse: 0.8, sound: ["clash", "win"], title: { big: String(g.winner).toUpperCase() + " WINS", small: "Top of the gallery", tone: "neutral" } };
    return null;
  }
  if (!round || round.forfeit) return { title: { big: "NO DRAWING", small: round ? "It was: " + round.prompt : "", tone: "neutral" } };
  if (!round.right.length) return { trauma: 0.15, sound: "lose", title: { big: "NOBODY GOT IT", small: round.roast || "It was: " + round.prompt, tone: "neutral" } };
  if (!you) return null;
  if (round.artist === you.name) {
    const p = (round.points || {})[you.name] || 0;
    return { trauma: 0.2, pulse: 0.4, buzz: BUZZ.scored, title: { big: "+" + p, small: round.right.length + (round.right.length === 1 ? " player got your drawing" : " players got your drawing"), tone: "good" } };
  }
  const x = (round.guesses || {})[you.name];
  if (!x) return { title: { big: "NO GUESS", small: "It was: " + round.prompt, tone: "neutral" } };
  return x.right ? { title: { big: "+2", small: "It was " + round.prompt, tone: "good" } } : { title: { big: "MISSED", small: "It was " + round.prompt, tone: "bad" } };
}

/* ---------- what the viewer has seen ---------- */

function seenKey(id: unknown): string {
  let path = "";
  try {
    path = location.pathname;
  } catch {
    path = "";
  }
  return "ac-sg-seen:" + path + ":" + String(id);
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

/* Home: the frame and the row of stands. */
function sgHome(aspect: number, width: number, n: number): Home {
  const phone = width < PHONE_BELOW;
  const vfov = aspect < 1 ? 50 : 40;
  const tv = Math.tan((vfov * Math.PI) / 360);
  const th = tv * Math.max(0.45, aspect);
  const halfW = Math.max(FRAME.w / 2 + 0.6, ((n - 1) * GAP) / 2 + STAND_W);
  const halfH = (FRAME.y + FRAME.h / 2 + 1.0) / 2;
  const d = Math.max(halfW / (th * 0.98), halfH / (tv * 0.92)) * 0.95 + 0.6;
  const el = ((phone ? 14 : 11) * Math.PI) / 180;
  const cy = halfH;
  return { pos: [0, cy + d * Math.sin(el), 1.6 + d * Math.cos(el)], fov: vfov, tz: -cy / Math.tan(el) + 1.6 };
}

/* ---------- the arena ---------- */

export default function SketchArena3D({ g, me = "", aspect, onReady, registerCommit }: { g: SketchState; me?: string; aspect?: number; onReady?: () => void; registerCommit?: (fn: (() => void) | null) => void }) {
  const still = useReducedMotion();
  const q = useQuality(still);
  const juice = useJuiceStore(still);
  const firstVisit = useFirstVisit("sg:" + String((g && g.id) || ""));
  const [ready, setReady] = useState(false);
  const ctl = useRef<Ctl | null>(null);
  const homeRef = useRef<Home | null>(null);
  const [hostW, setHostW] = useState(() => (aspect && aspect < 1.4 ? 390 : 760));
  const meL = me.toLowerCase();
  const players: SketchPlayer[] = (g && g.players) || NO_ITEMS;
  const rounds: SketchRound[] = (g && g.rounds) || NO_ITEMS;
  const finished = !!g && g.status === "finished";
  const seats: Seat[] = useMemo(() => players.map((p: SketchPlayer) => ({ name: String(p.name), hex: String(p.hex || "#fbbf24"), you: String(p.name).toLowerCase() === meL })), [players, meL]);
  const n = seats.length || 3;

  const [init] = useState(() => {
    const R = rounds.length;
    const seen = readSeen(g && g.id);
    if (seen == null || !R || seen >= R) return { shown: R };
    return { shown: R - 1 };
  });
  const [shown, setShown] = useState(init.shown);
  const [playing, setPlaying] = useState<{ n: number; t0: number | null } | null>(null);
  const [beat, setBeat] = useState(-1);
  const [go, setGo] = useState(false);
  const [fx, setFx] = useState<{ id: number; at: [number, number, number]; hex: string }[]>([]);
  const fxId = useRef(0);
  const [ceremony, setCeremony] = useState(0);
  const [say, setSay] = useState("");

  useEffect(() => {
    if (!ready || go) return;
    const t = setTimeout(() => setGo(true), firstVisit && !still ? 2400 : 300);
    return () => clearTimeout(t);
  }, [ready, go, firstVisit, still]);

  const isLast = (k: number) => finished && k === rounds.length;
  const cardOrder = (rd: SketchRound | null | undefined): string[] => (rd ? seats.map((s) => s.name).filter((nm) => nm !== rd.artist) : []);
  const sayRound = (k: number) => {
    const rd = rounds[k - 1];
    if (!rd) return "";
    if (rd.forfeit) return "Round " + k + ": " + rd.artist + " didn't draw. It was " + rd.prompt + ".";
    return "Round " + k + ": it was " + rd.prompt + ". " + (rd.right.length ? rd.right.join(", ") + " got it." : "Nobody got it." + (rd.roast ? " " + rd.roast : "")) + (isLast(k) ? (g.winner ? " " + g.winner + " wins." : " A tie at the top.") : "");
  };
  const finish = (k: number, quiet: boolean) => {
    setPlaying(null);
    setBeat(-1);
    setShown(k);
    const imp = roundImpact(g, rounds[k - 1], seats, isLast(k));
    if (imp) juice.hit(quiet ? { ...imp, trauma: 0, stop: 0, slow: 0, pulse: 0 } : imp);
    setSay(sayRound(k));
    if (isLast(k) && g.winner) setCeremony((c) => c + 1);
  };

  const onFinish = useEffectEvent(finish);
  useEffect(() => {
    if (!go || playing) return;
    const R = rounds.length;
    if (R <= shown) return;
    // oxlint-disable-next-line react/set-state-in-effect -- new rounds from the server step the replay: a live gap places all but the latest at once
    if (R - shown > 1) setShown(R - 1);
    const rd = rounds[R - 1];
    if (still || (rd && rd.forfeit)) onFinish(R, false);
    else setPlaying({ n: R, t0: null });
  }, [go, playing, rounds, shown, still]);

  const seenId = g && g.id;
  useEffect(() => {
    writeSeen(seenId, shown);
  }, [seenId, shown]);

  const skip = () => {
    if (playing) finish(playing.n, true);
  };

  useEffect(() => {
    if (!registerCommit) return;
    registerCommit(() => juice.hit({ sound: "lock", buzz: BUZZ.commit }));
    return () => registerCommit(null);
  }, [registerCommit, juice]);

  const playRound = playing ? rounds[playing.n - 1] : null;
  const order = cardOrder(playRound);
  // the round on show: the one playing, else (between rounds) the live
  // drawing, else the last one shown
  const lastShown = rounds[shown - 1] || null;
  const live = g.status === "running" && !playing;
  const imageUrl = playRound && playRound.image ? playRound.image.url : live && g.image ? g.image.url : !live && lastShown && lastShown.image ? lastShown.image.url : null;
  const image = useImage(imageUrl);
  const blank = useMemo(
    () =>
      textTex(
        [
          { text: live && g.phase === "draw" ? (g.artist || "The artist") + " is drawing…" : live && g.phase === "judging" ? "The Referee is judging…" : finished ? "Fin." : "", font: "italic 700 44px Georgia, serif", color: "#57534e" },
        ],
        640,
        480,
        "#f5f1e8",
        null
      ),
    [live, g.phase, g.artist, finished]
  );
  useEffect(() => () => blank.dispose(), [blank]);
  const plaqueText = playRound ? (beat >= 0 ? playRound.prompt : "Untitled · by " + playRound.artist) : live ? (g.phase === "draw" ? "In progress · " + (g.artist || "") : "Untitled · by " + (g.artist || "")) : lastShown ? lastShown.prompt : "Sketch & Guess";
  const plaque = useMemo(() => textTex([{ text: plaqueText, font: "700 40px Georgia, serif", color: "#1c1917" }], 600, 100, "#c9a227", "#7a5b12"), [plaqueText]);
  useEffect(() => () => plaque.dispose(), [plaque]);

  const scores: Record<string, number> = useMemo(() => {
    const out: Record<string, number> = {};
    seats.forEach((s) => (out[s.name] = 0));
    const upto = playing ? playing.n - 1 : rounds.length;
    rounds.slice(0, upto).forEach((r: SketchRound) => Object.keys(r.points || {}).forEach((nm) => (out[nm] = (out[nm] || 0) + r.points[nm]!)));
    if (playRound) {
      order.slice(0, Math.max(0, beat)).forEach((nm) => (out[nm] = (out[nm] || 0) + ((playRound.points || {})[nm] || 0)));
      if (beat > order.length) out[playRound.artist] = (out[playRound.artist] || 0) + ((playRound.points || {})[playRound.artist] || 0);
    }
    return out;
  }, [playing, rounds, seats, playRound, order, beat]);

  const cards: Record<string, { text: string; sub: string; tone: string } | null> = {};
  if (playRound) {
    order.forEach((nm, i) => {
      if (beat < i + 1) return;
      const x = (playRound.guesses || {})[nm];
      cards[nm] = x ? { text: "“" + x.guess + "”", sub: x.right ? (x.how === "referee" ? "+2 · the Referee's call" : "+2") : "✗", tone: x.right ? RIGHT : WRONG } : { text: "no guess", sub: "0", tone: "#94a3b8" };
    });
    if (beat > order.length) cards[playRound.artist] = { text: "the artist", sub: "+" + ((playRound.points || {})[playRound.artist] || 0), tone: "#fbbf24" };
  }
  const artist = playRound ? playRound.artist : live ? g.artist : null;
  const sealed = (nm: string) => live && g.phase === "guess" && nm !== g.artist && !!(players.find((p: SketchPlayer) => p.name === nm) || {}).committed;

  const home = (a: number, width: number) => sgHome(a, width, n);
  const first = home(aspect || 1.6, hostW);
  const label =
    "Sketch & Guess arena, 3D view: " +
    seats.map((s) => s.name + (s.you ? " (you)" : "") + " " + (scores[s.name] || 0) + " points").join("; ") +
    ". " +
    (g.status === "running" ? "Round " + g.round + " of " + g.rounds_total + ", " + (g.artist || "?") + (g.phase === "draw" ? " is drawing." : g.phase === "guess" ? "'s drawing is up." : " - the Referee is judging.") : finished ? (g.winner ? g.winner + " won." : "A tie at the top.") : "");
  const intro = firstVisit ? { title: "Sketch & Guess", sub: seats.map((s) => s.name).join(" · ") || "Draw it, name it", color: "#fbbf24" } : null;
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
            {playing ? (
              <div className="duel-catchup" aria-hidden="true">
                Round {playing.n} · tap to skip
              </div>
            ) : null}
            <div className="sr-only" aria-live="polite">
              {say}
            </div>
          </>
        }
      >
        <Canvas role="img" aria-label={label} frameloop="demand" dpr={q.dpr} gl={{ antialias: false, powerPreference: "high-performance" }} camera={{ position: first.pos, fov: first.fov, near: 0.1, far: 800 }}>
          <FirstFrame
            onReady={() => {
              setReady(true);
              if (onReady) onReady();
            }}
          />
          <Ticker fps={q.ambientFps} />
          <JuiceRig ctl={ctl} reach={0.7} />
          <color attach="background" args={["#020708"]} />
          <fog attach="fog" args={["#06171a", 20, 70]} />
          <SkyDome spec={SG_SKY} />
          <hemisphereLight args={["#fff7ed", "#1c120b", 0.7]} />
          <directionalLight position={[0, 9, 8]} intensity={1.2} color="#ffedd5" />
          <spotLight position={[0, 8, 3]} angle={0.45} penumbra={0.6} intensity={30} distance={20} color="#fde68a" />
          <Gallery still={still} />
          <Frame image={image} blank={blank} plaque={plaque} still={still} />
          {seats.map((s, i) => (
            <Stand key={s.name} seat={s} i={i} n={n} score={scores[s.name] || 0} artist={!!artist && artist === s.name} sealed={sealed(s.name)} card={cards[s.name] || null} />
          ))}
          {playing && playing.t0 == null ? <ClockStart key={"c" + playing.n} onStart={(t) => setPlaying((p) => (p && p.t0 == null ? { ...p, t0: t } : p))} /> : null}
          {playing && playing.t0 != null && playRound ? (
            <Beats
              key={"b" + playing.n}
              t0={playing.t0}
              count={order.length + 1}
              onBeat={(k) => {
                setBeat(k);
                if (k === 0) {
                  juice.hit({ trauma: 0.05, sound: "charge" });
                  return;
                }
                const nm = k <= order.length ? order[k - 1]! : playRound.artist;
                const i = seats.findIndex((s) => s.name === nm);
                const mine = i >= 0 && seats[i]!.you;
                if (k <= order.length) {
                  const x = (playRound.guesses || {})[nm];
                  juice.hit(x ? (x.right ? { trauma: mine ? 0.25 : 0.1, sound: "ping", buzz: mine ? BUZZ.scored : undefined } : { trauma: mine ? 0.3 : 0.08, sound: "buzzer", buzz: mine ? BUZZ.hitYou : undefined }) : { sound: "lock" });
                  if (x && x.right && !q.lite && i >= 0) setFx((l) => [...l.slice(-6), { id: ++fxId.current, at: [standX(i, n), STAND_H + 0.9, standZ(i, n)], hex: seats[i]!.hex }]);
                } else juice.hit({ trauma: 0.1, sound: playRound.right.length ? "win" : "lose" });
              }}
              onDone={() => finish(playing.n, false)}
            />
          ) : null}
          {fx.map((f) => (
            <Burst key={f.id} at={f.at} hex={f.hex} box={[0.7, 0.4, 0.7]} count={18} power={1.4} piece={0.07} dur={1} onDone={() => setFx((l) => l.filter((x) => x.id !== f.id))} />
          ))}
          {ceremony && g.winner && !still ? (
            <group key={"cer" + ceremony}>
              <LightPillar at={[standX(Math.max(0, seats.findIndex((s) => s.name === g.winner)), n), 0, standZ(Math.max(0, seats.findIndex((s) => s.name === g.winner)), n)]} hex={(seats.find((s) => s.name === g.winner) || { hex: "#fbbf24" }).hex} height={14} width={0.9} />
              <Shockwave at={[0, 0.02, 0.8]} hex={(seats.find((s) => s.name === g.winner) || { hex: "#fbbf24" }).hex} radius={9} dur={1.2} />
            </group>
          ) : null}
          <CameraControls ref={ctl} makeDefault minDistance={5} maxDistance={40} maxPolarAngle={Math.PI / 2.05} />
          <TouchControls ctl={ctl} />
          <Framer home={home} ctl={ctl} homeRef={homeRef} />
          <Intro ctl={ctl} homeRef={homeRef} enabled={!!intro && !still} ready={ready} />
          <ArenaPost q={q} bloom={0.85} threshold={0.95} vignette={0.55} />
        </Canvas>
      </ArenaFrame>
    </JuiceProvider>
  );
}
