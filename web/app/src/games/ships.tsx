/* Battleship hulls (2026-11-13): warships built in code, no model
   files.

   - The hull is lofted: stations along the length, each a section that
     is round in the bilge below the waterline and flares outward above
     it toward the bow; the deck line (sheer) rises at the bow and a
     little at the stern; the stern ends in a transom. Local axes: +x is
     the bow, y is up from the waterline, z is across.
   - Paint and decks are drawn on canvases once: steel plating with
     strakes, frames and rust streaks, a black boot-top band at the
     waterline and anti-fouling red below it (it shows in the troughs
     and when a ship lists); teak decks for the big-gun ships, grey
     non-skid for the destroyer, a flight deck with its markings for the
     carrier.
   - Each class has its silhouette: carrier (flight deck, island,
     parked aircraft), battleship (three twin turrets, tower, funnels),
     cruiser, destroyer (gun, bridge, launcher, helicopter deck),
     submarine (low hull, sail, planes, rudder). Parts that share a
     material are merged, so a ship is about eight draws: hull, deck,
     steel, dark fittings, lights, team rim, radar, waterline foam.
   - Night details: lit bridge windows, red port and green starboard
     running lights, a white masthead light, a turning radar.
   - Damage hooks (BsArena3D drives them): uHitX lists where along the
     hull shells struck - a scorched hole with a glowing, flickering rim
     at each - and uChar chars the whole ship as it is lost. The
     materials share one patched shader program. */
import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import {
  AdditiveBlending,
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  CapsuleGeometry,
  Color,
  CylinderGeometry,
  DoubleSide,
  Float32BufferAttribute,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  RepeatWrapping,
  SRGBColorSpace,
  SphereGeometry,
  type Material,
  type Mesh,
  type Plane,
} from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

/* ---------- hull lofting ---------- */

type HullSpec = { L: number; B: number; D: number; T: number; full?: boolean };

export type Hull = {
  hull: BufferGeometry;
  deck: BufferGeometry;
  deckAt: (x: number) => number;
  beamAt: (x: number) => number;
};

const V_LO = -0.14;
const V_SPAN = 0.66; // texture v: y from V_LO up to V_LO + V_SPAN

function loftHull({ L, B, D, T, full }: HullSpec): Hull {
  const NS = 34;
  const below = 6;
  const above = 4;
  const half = (u: number) => {
    // transom at the stern, parallel midbody, a fine entry to the bow
    const start = full ? 0.62 : 0.56;
    if (u < 0.1) return 0.84 + 0.16 * (u / 0.1);
    if (u < start) return 1;
    const k = (u - start) / (1 - start);
    return Math.pow(Math.max(0, 1 - k * k), full ? 0.45 : 0.6);
  };
  const sheer = (u: number) => D * (1 + 0.5 * Math.pow(Math.max(0, (u - 0.62) / 0.38), 2) + 0.08 * Math.pow(Math.max(0, (0.14 - u) / 0.14), 2));
  const keel = (u: number) => T * (u > 0.82 ? 1 - 0.7 * ((u - 0.82) / 0.18) : 1);
  const flare = (u: number) => 0.03 + 0.16 * Math.max(0, (u - 0.6) / 0.4);
  const xAt = (u: number) => -L / 2 + u * L;

  // one section, port deck edge -> keel -> starboard deck edge
  const section = (u: number) => {
    const b = Math.max(0.002, (B / 2) * half(u));
    const d = sheer(u);
    const k = keel(u);
    const side: [number, number][] = [];
    for (let i = above; i >= 1; i--) {
      const y = (d * i) / above;
      side.push([y, b * (1 + flare(u) * (y / d))]);
    }
    for (let i = 0; i < below; i++) {
      const s = i / below;
      const y = -k * s;
      side.push([y, b * Math.pow(Math.max(0, 1 - Math.pow(s, 2.4)), 1 / 2.4)]);
    }
    side.push([-k, 0]);
    const pts: [number, number, number][] = [];
    side.forEach(([y, w]) => pts.push([xAt(u), y, -w]));
    for (let i = side.length - 2; i >= 0; i--) {
      const [y, w] = side[i]!;
      pts.push([xAt(u), y, w]);
    }
    return pts;
  };

  const rings: [number, number, number][][] = [];
  for (let s = 0; s <= NS; s++) rings.push(section(s / NS));
  const P = rings[0]!.length;
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  rings.forEach((ring) =>
    ring.forEach(([x, y, z]) => {
      pos.push(x, y, z);
      uv.push((x + L / 2) / L, (y - V_LO) / V_SPAN);
    })
  );
  for (let s = 0; s < NS; s++)
    for (let p = 0; p < P - 1; p++) {
      const a = s * P + p;
      const b = a + 1;
      const c = a + P;
      const d = c + 1;
      idx.push(a, b, c, b, d, c);
    }
  // transom: a fan over the stern section
  const base = pos.length / 3;
  const sx = rings[0]![0]![0];
  const cy = (rings[0]![0]![1] + rings[0]![Math.floor(P / 2)]![1]) / 2;
  pos.push(sx, cy, 0);
  uv.push(0, (cy - V_LO) / V_SPAN);
  for (let p = 0; p < P - 1; p++) idx.push(base, p + 1, p);
  const hull = new BufferGeometry();
  hull.setAttribute("position", new Float32BufferAttribute(pos, 3));
  hull.setAttribute("uv", new Float32BufferAttribute(uv, 2));
  hull.setIndex(idx);
  hull.computeVertexNormals();

  // the deck: a strip between the deck edges, following the sheer
  const dpos: number[] = [];
  const duv: number[] = [];
  const didx: number[] = [];
  for (let s = 0; s <= NS; s++) {
    const r = rings[s]!;
    const pL = r[0]!;
    const pR = r[P - 1]!;
    dpos.push(pL[0], pL[1], pL[2], pR[0], pR[1], pR[2]);
    duv.push(s / NS, 0.5 + pL[2] / B, s / NS, 0.5 + pR[2] / B);
    if (s < NS) {
      const a = s * 2;
      didx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
  }
  const deck = new BufferGeometry();
  deck.setAttribute("position", new Float32BufferAttribute(dpos, 3));
  deck.setAttribute("uv", new Float32BufferAttribute(duv, 2));
  deck.setIndex(didx);
  deck.computeVertexNormals();
  const uOf = (x: number) => Math.min(1, Math.max(0, (x + L / 2) / L));
  return { hull, deck, deckAt: (x) => sheer(uOf(x)), beamAt: (x) => (B / 2) * half(uOf(x)) * (1 + flare(uOf(x))) };
}

/* ---------- painted surfaces (canvas, once) ---------- */

function canvasTex(w: number, h: number, draw: (x: CanvasRenderingContext2D) => void): CanvasTexture {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const x = c.getContext("2d")!;
  draw(x);
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

let rnd = 7;
const rand = () => {
  rnd = (rnd * 16807) % 2147483647;
  return rnd / 2147483647;
};

const TEX: Record<string, CanvasTexture> = {};
function hullTexture(): CanvasTexture {
  if (TEX.hull) return TEX.hull;
  TEX.hull = canvasTex(1024, 256, (x) => {
    const H = 256;
    const vy = (y: number) => (1 - (y - V_LO) / V_SPAN) * H; // waterline-relative y -> canvas row
    const g = x.createLinearGradient(0, 0, 0, vy(0));
    g.addColorStop(0, "#d3d9de");
    g.addColorStop(1, "#a7b1ba");
    x.fillStyle = g;
    x.fillRect(0, 0, 1024, vy(0));
    // plating: strakes and frames
    x.globalAlpha = 0.09;
    x.fillStyle = "#1d252c";
    for (let r = 14; r < vy(0); r += 26) x.fillRect(0, r, 1024, 1.5);
    for (let c = 0; c < 1024; c += 38) x.fillRect(c, 0, 1, vy(0));
    // rust streaks running down from the deck edge and the scuppers
    for (let i = 0; i < 90; i++) {
      x.globalAlpha = 0.05 + rand() * 0.12;
      x.fillStyle = rand() > 0.5 ? "#5a3b28" : "#2b2a28";
      const cx = rand() * 1024;
      x.fillRect(cx, rand() * 12, 1 + rand() * 3, 20 + rand() * 80);
    }
    x.globalAlpha = 1;
    // boot-top (black) at the waterline, anti-fouling red below
    x.fillStyle = "#151719";
    x.fillRect(0, vy(0.035), 1024, vy(-0.02) - vy(0.035));
    x.fillStyle = "#6f1f1c";
    x.fillRect(0, vy(-0.02), 1024, H - vy(-0.02));
    x.globalAlpha = 0.25;
    x.fillStyle = "#000";
    for (let c = 0; c < 1024; c += 38) x.fillRect(c, vy(-0.02), 1, H);
    x.globalAlpha = 1;
  });
  return TEX.hull;
}

function deckTexture(kind: "teak" | "grey" | "flight" | "sub"): CanvasTexture {
  if (TEX[kind]) return TEX[kind]!;
  const t = canvasTex(1024, 256, (x) => {
    if (kind === "teak") {
      x.fillStyle = "#b0916b";
      x.fillRect(0, 0, 1024, 256);
      for (let r = 0; r < 256; r += 9) {
        x.fillStyle = r % 18 ? "#a2845f" : "#bb9c74";
        x.globalAlpha = 0.5;
        x.fillRect(0, r, 1024, 8);
        x.globalAlpha = 0.6;
        x.fillStyle = "#5a4836";
        x.fillRect(0, r + 8, 1024, 1);
        for (let c = rand() * 120; c < 1024; c += 90 + rand() * 80) x.fillRect(c, r, 1, 8);
      }
      x.globalAlpha = 1;
    } else if (kind === "grey" || kind === "sub") {
      x.fillStyle = kind === "sub" ? "#3f474f" : "#7d868e";
      x.fillRect(0, 0, 1024, 256);
      for (let i = 0; i < 4000; i++) {
        x.globalAlpha = 0.08;
        x.fillStyle = rand() > 0.5 ? "#000" : "#fff";
        x.fillRect(rand() * 1024, rand() * 256, 2, 2);
      }
      if (kind === "grey") {
        // helicopter deck at the stern
        x.globalAlpha = 0.85;
        x.strokeStyle = "#e9e3c8";
        x.lineWidth = 5;
        x.beginPath();
        x.arc(110, 128, 70, 0, Math.PI * 2);
        x.stroke();
        x.font = "bold 90px sans-serif";
        x.fillStyle = "#e9e3c8";
        x.textAlign = "center";
        x.textBaseline = "middle";
        x.fillText("H", 110, 132);
      }
      x.globalAlpha = 1;
    } else {
      // the flight deck: dark non-skid, centreline, edge lines, the
      // angled landing area and its markings
      x.fillStyle = "#4b5259";
      x.fillRect(0, 0, 1024, 256);
      for (let i = 0; i < 5000; i++) {
        x.globalAlpha = 0.07;
        x.fillStyle = rand() > 0.5 ? "#000" : "#fff";
        x.fillRect(rand() * 1024, rand() * 256, 2, 2);
      }
      x.globalAlpha = 0.9;
      x.fillStyle = "#e8e4d6";
      for (let c = 520; c < 1000; c += 34) x.fillRect(c, 126, 20, 4);
      x.save();
      x.translate(60, 150);
      x.rotate(-0.16);
      x.strokeStyle = "#e8e4d6";
      x.lineWidth = 3;
      x.setLineDash([22, 14]);
      x.strokeRect(0, -70, 560, 120);
      x.setLineDash([]);
      for (let c = 20; c < 540; c += 40) x.fillRect(c, -12, 22, 4);
      x.restore();
      x.fillStyle = "#e3c04a";
      for (let c = 0; c < 1024; c += 26) {
        x.fillRect(c, 10, 14, 3);
        x.fillRect(c, 243, 14, 3);
      }
      x.font = "bold 70px sans-serif";
      x.fillStyle = "#e8e4d6";
      x.textAlign = "center";
      x.save();
      x.translate(930, 128);
      x.rotate(Math.PI / 2);
      x.fillText("76", 0, 25);
      x.restore();
      x.globalAlpha = 1;
    }
  });
  if (kind !== "flight") t.wrapS = RepeatWrapping;
  TEX[kind] = t;
  return t;
}

function foamTexture(): CanvasTexture {
  if (TEX.foam) return TEX.foam;
  TEX.foam = canvasTex(256, 128, (x) => {
    const img = x.createImageData(256, 128);
    for (let j = 0; j < 128; j++)
      for (let i = 0; i < 256; i++) {
        const u = (i / 255) * 2 - 1;
        const v = (j / 127) * 2 - 1;
        const r = Math.sqrt(u * u + v * v);
        // a ring hugging the hull outline, broken by noise, longer wake aft
        const ring = Math.exp(-Math.pow((r - 0.72) / 0.13, 2)) + (u < 0 ? Math.exp(-Math.pow(v / 0.35, 2)) * Math.max(0, -u - 0.5) * 0.9 : 0);
        const n = 0.55 + 0.45 * Math.sin(i * 0.9 + Math.sin(j * 0.7) * 3) * Math.sin(j * 1.3 + i * 0.21);
        const a = Math.min(1, ring * n) * 255;
        const k = (j * 256 + i) * 4;
        img.data[k] = img.data[k + 1] = img.data[k + 2] = 255;
        img.data[k + 3] = a;
      }
    x.putImageData(img, 0, 0);
  });
  return TEX.foam;
}

/* ---------- parts, merged per material ---------- */

class Parts {
  steel: BufferGeometry[] = [];
  dark: BufferGeometry[] = [];
  rim: BufferGeometry[] = [];
  lights: BufferGeometry[] = [];
  box(list: BufferGeometry[], w: number, h: number, d: number, x: number, y: number, z: number, ry = 0, rz = 0) {
    const g = new BoxGeometry(w, h, d);
    if (rz) g.rotateZ(rz);
    if (ry) g.rotateY(ry);
    g.translate(x, y + h / 2, z);
    list.push(g);
  }
  cyl(list: BufferGeometry[], rt: number, rb: number, h: number, x: number, y: number, z: number, rz = 0, seg = 12) {
    const g = new CylinderGeometry(rt, rb, h, seg);
    g.translate(0, h / 2, 0);
    if (rz) g.rotateZ(rz);
    g.translate(x, y, z);
    list.push(g);
  }
  /* A barrel along +x (or -x) from (x, y, z), slightly elevated. */
  barrel(x: number, y: number, z: number, len: number, dir: number, r = 0.016) {
    const g = new CylinderGeometry(r * 0.8, r, len, 8);
    g.rotateZ(-dir * (Math.PI / 2 - 0.06));
    g.translate(x + (dir * len) / 2, y, z);
    this.dark.push(g);
  }
  light(x: number, y: number, z: number, color: [number, number, number], s = 0.022) {
    const g = new SphereGeometry(s, 6, 4);
    g.translate(x, y, z);
    const n = g.attributes.position!.count;
    const c = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) c.set(color, i * 3);
    g.setAttribute("color", new BufferAttribute(c, 3));
    this.lights.push(g);
  }
  windows(x: number, y: number, z0: number, z1: number, n: number, facing: number) {
    for (let i = 0; i < n; i++) {
      const z = z0 + ((z1 - z0) * (i + 0.5)) / n;
      const g = new BoxGeometry(0.008, 0.018, ((z1 - z0) / n) * 0.6);
      g.translate(x + facing * 0.002, y, z);
      const cnt = g.attributes.position!.count;
      const c = new Float32Array(cnt * 3);
      for (let k = 0; k < cnt; k++) c.set([1.9, 1.5, 0.85], k * 3);
      g.setAttribute("color", new BufferAttribute(c, 3));
      this.lights.push(g);
    }
  }
}

function merged(list: BufferGeometry[]): BufferGeometry | null {
  if (!list.length) return null;
  const g = mergeGeometries(list.map((x) => (x.index ? x : x)));
  list.forEach((x) => x.dispose());
  return g;
}

type Turret = { x: number; dir: number; y: number; big: number; guns: number };

export type ShipGeo = {
  L: number;
  B: number;
  D: number;
  deckKind: "teak" | "grey" | "flight" | "sub";
  hull: BufferGeometry | null;
  deck: BufferGeometry | null;
  steel: BufferGeometry | null;
  dark: BufferGeometry | null;
  rim: BufferGeometry | null;
  lights: BufferGeometry | null;
  radar: { x: number; y: number; z: number; len: number } | null;
  sub: boolean;
};

const CACHE = new Map<string, ShipGeo>();

/* The geometry for one class (cached: ships of a class share it). */
export function shipGeometry(size: number, variant: number): ShipGeo {
  const key = size + ":" + variant;
  const hit = CACHE.get(key);
  if (hit) return hit;
  const p = new Parts();
  let out: ShipGeo;
  if (size === 2) {
    // submarine, surfaced: low cigar hull, sail with planes, rudder
    const L = size * 0.94;
    const hull = new CapsuleGeometry(0.17, L * 0.7, 6, 14);
    hull.rotateZ(Math.PI / 2);
    hull.scale(1, 0.8, 1);
    hull.translate(0, -0.05, 0);
    p.box(p.steel, 0.32, 0.17, 0.11, L * 0.12, 0.07, 0);
    p.box(p.steel, 0.2, 0.02, 0.32, L * 0.14, 0.18, 0);
    p.box(p.steel, 0.05, 0.16, 0.012, -L * 0.44, 0.0, 0);
    p.box(p.dark, 0.012, 0.12, 0.012, L * 0.1, 0.24, 0);
    p.box(p.rim, L * 0.6, 0.012, 0.016, -L * 0.04, 0.085, 0);
    p.light(L * 0.12, 0.38, 0, [2.2, 2.2, 2.1], 0.018);
    p.light(L * 0.24, 0.26, -0.06, [2.4, 0.2, 0.2], 0.016);
    p.light(L * 0.24, 0.26, 0.06, [0.2, 2.4, 0.4], 0.016);
    out = { L, B: 0.34, D: 0.09, deckKind: "sub", hull, deck: null, steel: merged(p.steel), dark: merged(p.dark), rim: merged(p.rim), lights: merged(p.lights), radar: null, sub: true };
  } else {
    const L = size * 0.94;
    const carrier = size === 5;
    const battleship = size === 4;
    const cruiser = size === 3 && variant === 0;
    const B = carrier ? 0.74 : battleship ? 0.66 : cruiser ? 0.56 : 0.5;
    const D = carrier ? 0.24 : battleship ? 0.2 : 0.17;
    const h = loftHull({ L, B, D, T: 0.12, full: carrier });
    const X = (u: number) => -L / 2 + u * L;
    const dy = (x: number) => h.deckAt(x);
    // team rim: thin lit lines along both deck edges, midships
    for (const s of [-1, 1]) {
      const g = new BoxGeometry(L * 0.62, 0.02, 0.02);
      g.translate(-L * 0.06, D + 0.005, s * (h.beamAt(-L * 0.06) + 0.006));
      p.rim.push(g);
    }
    let radar: ShipGeo["radar"] = null;
    const turret = (t: Turret) => {
      const y = t.y;
      p.cyl(p.steel, 0.12 * t.big, 0.13 * t.big, 0.05, t.x, y, 0, 0, 16);
      p.box(p.steel, 0.26 * t.big, 0.09 * t.big, 0.22 * t.big, t.x - t.dir * 0.02, y + 0.04, 0);
      for (let k = 0; k < t.guns; k++) {
        const z = (k - (t.guns - 1) / 2) * 0.06 * t.big;
        p.barrel(t.x + t.dir * 0.1 * t.big, y + 0.085 * t.big, z, 0.36 * t.big, t.dir, 0.017 * t.big);
      }
    };
    if (carrier) {
      // flight deck slab overhanging the hull, island to starboard
      const fd = new PlaneGeometry(L * 0.98, 1.02);
      fd.rotateX(-Math.PI / 2);
      fd.translate(0, D * 1.32 + 0.045, -0.04);
      p.box(p.steel, L * 0.98, 0.04, 1.02, 0, D * 1.32, -0.04);
      const ix = X(0.56);
      const iz = 0.36;
      const top = D * 1.32 + 0.045;
      p.box(p.steel, 0.52, 0.2, 0.14, ix, top, iz);
      p.box(p.steel, 0.36, 0.1, 0.17, ix + 0.05, top + 0.2, iz);
      p.windows(ix + 0.23, top + 0.25, iz - 0.07, iz + 0.07, 5, 1);
      p.box(p.dark, 0.14, 0.12, 0.1, ix - 0.14, top + 0.2, iz);
      p.cyl(p.steel, 0.01, 0.014, 0.34, ix + 0.04, top + 0.3, iz, 0, 6);
      radar = { x: ix + 0.04, y: top + 0.6, z: iz, len: 0.2 };
      p.light(ix + 0.04, top + 0.66, iz, [2.2, 2.2, 2.1], 0.018);
      p.light(ix + 0.24, top + 0.3, iz - 0.1, [2.4, 0.2, 0.2]);
      p.light(ix + 0.24, top + 0.3, iz + 0.1, [0.2, 2.4, 0.4]);
      // parked aircraft along the deck
      for (const [u, z, r] of [
        [0.82, -0.3, 0.6],
        [0.75, -0.32, 0.6],
        [0.14, 0.24, -0.3],
        [0.22, 0.28, -0.3],
        [0.3, 0.3, -0.3],
      ] as [number, number, number][]) {
        const ax = X(u);
        p.box(p.steel, 0.2, 0.025, 0.035, ax, top, z, r);
        p.box(p.steel, 0.07, 0.012, 0.18, ax - 0.02, top + 0.012, z, r);
        p.box(p.steel, 0.04, 0.05, 0.008, ax - 0.09, top + 0.01, z, r);
      }
      out = { L, B, D, deckKind: "flight", hull: h.hull, deck: fd, steel: null, dark: null, rim: null, lights: null, radar, sub: false };
    } else {
      out = { L, B, D, deckKind: battleship || cruiser ? "teak" : "grey", hull: h.hull, deck: h.deck, steel: null, dark: null, rim: null, lights: null, radar: null, sub: false };
      // superstructure block: stacked decks, bridge with windows,
      // mast, funnels; turrets fore and aft
      const sx = X(battleship ? 0.48 : cruiser ? 0.5 : 0.58);
      const base = dy(sx);
      const w0 = battleship ? 0.42 : cruiser ? 0.34 : 0.3;
      p.box(p.steel, battleship ? 0.7 : 0.5, 0.11, w0, sx, base, 0);
      p.box(p.steel, battleship ? 0.46 : 0.34, 0.1, w0 * 0.8, sx + 0.04, base + 0.11, 0);
      const by = base + 0.21;
      p.box(p.steel, 0.2, 0.09, w0 * 1.05, sx + 0.12, by, 0);
      p.windows(sx + 0.221, by + 0.055, -w0 * 0.45, w0 * 0.45, 6, 1);
      if (battleship) {
        p.box(p.steel, 0.16, 0.24, 0.16, sx + 0.06, by + 0.09, 0);
        p.box(p.steel, 0.22, 0.05, 0.2, sx + 0.06, by + 0.33, 0);
      }
      const mastTop = by + (battleship ? 0.75 : 0.55);
      p.cyl(p.steel, 0.009, 0.013, mastTop - by, sx + 0.02, by + 0.09, 0, 0, 6);
      p.box(p.steel, 0.012, 0.012, 0.22, sx + 0.02, mastTop - 0.12, 0);
      radar = { x: sx + 0.02, y: mastTop - 0.05, z: 0, len: battleship ? 0.2 : 0.16 };
      p.light(sx + 0.02, mastTop + 0.02, 0, [2.2, 2.2, 2.1], 0.018);
      p.light(sx + 0.15, by + 0.06, -w0 * 0.55, [2.4, 0.2, 0.2]);
      p.light(sx + 0.15, by + 0.06, w0 * 0.55, [0.2, 2.4, 0.4]);
      // funnels, raked, with dark caps
      const funnels = battleship ? [X(0.38), X(0.32)] : [X(cruiser ? 0.4 : 0.47)];
      funnels.forEach((fx) => {
        const fy = dy(fx) + 0.1;
        p.cyl(p.steel, 0.055, 0.07, battleship ? 0.24 : 0.2, fx, fy, 0, 0.12, 14);
        p.cyl(p.dark, 0.058, 0.058, 0.025, fx - 0.03, fy + (battleship ? 0.235 : 0.195), 0, 0.12, 14);
      });
      if (battleship) {
        turret({ x: X(0.76), dir: 1, y: dy(X(0.76)), big: 1, guns: 2 });
        turret({ x: X(0.65), dir: 1, y: dy(X(0.65)) + 0.07, big: 1, guns: 2 });
        p.cyl(p.steel, 0.1, 0.11, 0.07, X(0.65), dy(X(0.65)), 0, 0, 14);
        turret({ x: X(0.2), dir: -1, y: dy(X(0.2)), big: 1, guns: 2 });
        // secondary mounts along the sides
        for (const u of [0.4, 0.58])
          for (const s of [-1, 1]) {
            p.box(p.steel, 0.09, 0.05, 0.07, X(u), dy(X(u)), s * 0.22);
            p.barrel(X(u) + 0.03, dy(X(u)) + 0.03, s * 0.22, 0.12, 1, 0.008);
          }
      } else if (cruiser) {
        turret({ x: X(0.76), dir: 1, y: dy(X(0.76)), big: 0.8, guns: 2 });
        turret({ x: X(0.2), dir: -1, y: dy(X(0.2)), big: 0.8, guns: 2 });
      } else {
        // destroyer: one gun forward, a launcher aft of the funnel
        turret({ x: X(0.8), dir: 1, y: dy(X(0.8)), big: 0.6, guns: 1 });
        p.box(p.dark, 0.26, 0.05, 0.2, X(0.32), dy(X(0.32)), 0);
        for (let i = 0; i < 4; i++)
          for (let k = 0; k < 3; k++) p.box(p.steel, 0.045, 0.012, 0.045, X(0.32) - 0.09 + i * 0.06, dy(X(0.32)) + 0.05, -0.06 + k * 0.06);
      }
    }
    out.steel = merged(p.steel);
    out.dark = merged(p.dark);
    out.rim = merged(p.rim);
    out.lights = merged(p.lights);
  }
  CACHE.set(key, out);
  return out;
}

/* ---------- damage: one patched program for every ship material ---------- */

export type Damage = {
  uHitX: { value: Float32Array };
  uHitN: { value: number };
  uChar: { value: number };
  uTime: { value: number };
};

export function newDamage(): Damage {
  return { uHitX: { value: new Float32Array(6) }, uHitN: { value: 0 }, uChar: { value: 0 }, uTime: { value: 0 } };
}

function patch(m: MeshStandardMaterial, dmg: Damage, deckY: number) {
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uHitX = dmg.uHitX;
    sh.uniforms.uHitN = dmg.uHitN;
    sh.uniforms.uChar = dmg.uChar;
    sh.uniforms.uTime = dmg.uTime;
    sh.uniforms.uDeckY = { value: deckY };
    sh.vertexShader = sh.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vLoc;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvLoc = position;");
    sh.fragmentShader = sh.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
varying vec3 vLoc;
uniform float uHitX[6];
uniform int uHitN;
uniform float uChar;
uniform float uTime;
uniform float uDeckY;
float scorchN(vec3 p) { return 0.5 + 0.5 * sin(p.x * 31.0 + sin(p.y * 23.0) * 2.0) * sin(p.z * 27.0 + p.y * 11.0); }`
      )
      .replace(
        "#include <map_fragment>",
        `#include <map_fragment>
float burn = 0.0;
float hole = 0.0;
float ember = 0.0;
for (int i = 0; i < 6; i++) {
  if (i >= uHitN) break;
  float d = abs(vLoc.x - uHitX[i]);
  float n = scorchN(vLoc);
  float r = 0.36 + 0.14 * n;
  burn = max(burn, smoothstep(r, r * 0.25, d));
  // a hole torn in the side above the waterline, its rim glowing
  float side = step(0.02, vLoc.y) * step(vLoc.y, uDeckY * 1.05);
  float hd = length(vec2(d * 1.4, (vLoc.y - uDeckY * 0.55) * 2.2));
  hole = max(hole, side * smoothstep(0.13 + 0.03 * n, 0.08, hd));
  ember = max(ember, side * (smoothstep(0.2, 0.12, hd) - smoothstep(0.12, 0.08, hd)));
}
diffuseColor.rgb *= 1.0 - 0.82 * burn;
diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.012, 0.01, 0.01), max(hole, uChar * 0.86));`
      )
      .replace(
        "#include <emissivemap_fragment>",
        `#include <emissivemap_fragment>
float flick = 0.65 + 0.35 * sin(uTime * 11.0 + vLoc.x * 9.0) * sin(uTime * 7.3 + vLoc.y * 13.0);
totalEmissiveRadiance += vec3(2.4, 0.75, 0.18) * ember * flick * (1.0 - uChar * 0.7);`
      );
  };
  m.customProgramCacheKey = () => "bs-ship-dmg";
}

export type ShipMats = { hull: MeshStandardMaterial; deck: MeshStandardMaterial; steel: MeshStandardMaterial; dark: MeshStandardMaterial; rim: MeshStandardMaterial; lights: MeshBasicMaterial; foam: MeshBasicMaterial };

/* clip: the plane a broken-in-two hull is cut at (a ship that can break
   carries it from the start, far away, so the shader never recompiles
   mid-sinking); hull and deck draw both faces so the break shows the
   inside of the hull, not a hole through it. */
export function shipMaterials(geo: ShipGeo, hex: string, dmg: Damage, clip?: Plane[]): ShipMats {
  // painted steel: barely metallic (metal with nothing to reflect rendered dark)
  const hull = new MeshStandardMaterial({ map: geo.sub ? null : hullTexture(), color: geo.sub ? "#4b5560" : "#ffffff", metalness: 0.12, roughness: 0.62, side: DoubleSide });
  const deck = new MeshStandardMaterial({ map: deckTexture(geo.deckKind), metalness: 0.05, roughness: 0.85, side: DoubleSide });
  const steel = new MeshStandardMaterial({ color: geo.sub ? "#5c6670" : "#bcc5cd", metalness: 0.12, roughness: 0.58 });
  const dark = new MeshStandardMaterial({ color: "#424b54", metalness: 0.2, roughness: 0.5 });
  [hull, deck, steel, dark].forEach((m) => patch(m, dmg, geo.D));
  const rim = new MeshStandardMaterial({ color: "#0b0e12", emissive: new Color(hex), emissiveIntensity: 2.2, toneMapped: false });
  const lights = new MeshBasicMaterial({ vertexColors: true, toneMapped: false });
  const foam = new MeshBasicMaterial({ map: foamTexture(), transparent: true, opacity: 0.32, blending: AdditiveBlending, depthWrite: false, side: DoubleSide, color: "#cfe6f2" });
  if (clip) [hull, deck, steel, dark, rim, lights].forEach((m) => (m.clippingPlanes = clip));
  return { hull, deck, steel, dark, rim, lights, foam };
}

/* The visible ship: hull, deck, fittings, lights, radar and foam, as a
   group the caller positions (it floats and dies there). */
export function ShipBody({ geo, mats, still, radarSpin, foam: showFoam = true }: { geo: ShipGeo; mats: ShipMats; still: boolean; radarSpin: { current: number }; foam?: boolean }) {
  const radar = useRef<Mesh>(null);
  const foam = useRef<Mesh>(null);
  useEffect(
    () => () => {
      Object.values(mats).forEach((m: Material) => m.dispose());
    },
    [mats]
  );
  useFrame(() => {
    if (radar.current && !still) radar.current.rotation.y = radarSpin.current;
    if (foam.current && !still) (foam.current.material as MeshBasicMaterial).opacity = 0.26 + 0.08 * Math.sin(radarSpin.current * 0.7);
  });
  const foamGeo = useMemo(() => {
    const g = new PlaneGeometry(geo.L * 1.22, geo.B * 2.6);
    g.rotateX(-Math.PI / 2);
    return g;
  }, [geo]);
  return (
    <group>
      {geo.hull ? <mesh geometry={geo.hull} material={mats.hull} /> : null}
      {geo.deck ? <mesh geometry={geo.deck} material={mats.deck} /> : null}
      {geo.steel ? <mesh geometry={geo.steel} material={mats.steel} /> : null}
      {geo.dark ? <mesh geometry={geo.dark} material={mats.dark} /> : null}
      {geo.rim ? <mesh geometry={geo.rim} material={mats.rim} /> : null}
      {geo.lights ? <mesh geometry={geo.lights} material={mats.lights} /> : null}
      {geo.radar ? (
        <mesh ref={radar} position={[geo.radar.x, geo.radar.y, geo.radar.z]} material={mats.dark}>
          <boxGeometry args={[0.025, 0.035, geo.radar.len]} />
        </mesh>
      ) : null}
      {showFoam ? <mesh ref={foam} geometry={foamGeo} material={mats.foam} position={[0, 0.012, 0]} renderOrder={2} /> : null}
    </group>
  );
}

