/* Trust's home framing (TrustArena3D.tsx), kept free of three.js and
   React so tests/unit/trframe.test.mjs can check it: where the camera
   sits so every seat and plate is in the frame, and how big a crowded
   phone table's plates are. */
import type { Home } from "../three/arena3d";

/* A seat as the framing needs it: its place on the floor. */
export type SeatXZ = { x: number; z: number };

export const PHONE_BELOW = 560;

export function tableR(n: number) {
  return n <= 3 ? 2.6 : n <= 5 ? 3.1 : 3.6;
}

// a plate's size in world units, on a phone (big) and wider
export const PLATE_BIG: [number, number] = [2.4, 0.96];
export const PLATE: [number, number] = [1.7, 0.68];
// From this many seats a phone's table is crowded (trHomeCrowded): each
// plate is PLATE_PX on screen whatever its depth, so the far ones read
// as well as the near ones.
export const CROWDED = 7;
export const PLATE_PX: [number, number] = [92, 37];
export const trFov = (aspect: number) => (aspect < 1 ? 56 : 46);
// Without size attenuation a sprite's scale is its size at a distance of
// 1, so n px of a frame h px high is n * plateK; 0 = world-sized plates.
// (Move-mode zoom then leaves the plates as they are.)
export function plateK(width: number, height: number, n: number): number {
  if (width >= PHONE_BELOW || n < CROWDED || !height) return 0;
  return (2 * Math.tan((trFov(width / height) * Math.PI) / 360)) / height;
}

/* Home: every seat and its plate in frame, the aurora in a band across
   the top: the camera looks at the table from elF above it, the view
   pitched a little shallower so the sky shows, then backs off until each
   seat ring and each plate fits whole in the frame, clear of its
   controls. It used to fit a point near each plate's top instead, so the
   viewer's own plate, nearest the camera and lowest on screen, ran off
   the bottom: "8 (+0) · you" was cut with 3 seats on a phone and sat on
   the edge with 8 on a desktop. The pitch is searched with the distance
   (a few degrees either way), so the table stays as large as the plates
   allow. */
export function trHome(aspect: number, width: number, seats: SeatXZ[]): Home {
  const phone = width < PHONE_BELOW;
  if (phone && seats.length >= CROWDED) return trHomeCrowded(aspect, width, seats);
  const vfov = trFov(aspect);
  const tv = Math.tan((vfov * Math.PI) / 360);
  const th = tv * Math.max(0.45, aspect);
  const W = width || 640;
  const H = W / Math.max(0.3, aspect);
  const DEG = Math.PI / 180;
  const elF = (phone ? 34 : 28) * DEG;
  // a little shallower than the look at the table: a thin band of aurora
  const pitch0 = elF - 8 * DEG;
  const [pw, ph] = phone ? PLATE_BIG : PLATE;
  const ring = seats.length ? seats.map((st) => [st.x * 1.12, 0, st.z * 1.12] as const) : [[3, 0, 3] as const, [-3, 0, -3] as const];
  const plates = seats.map((st) => [st.x * 1.28, 0.55, st.z * 1.28] as const);
  const keep = frameControls(W, H);
  const EDGE = 4;
  const fy = 0.6;
  const fits = (d: number, pitch: number) => {
    const cy = fy + d * Math.sin(elF);
    const cz = d * Math.cos(elF);
    const sp = Math.sin(pitch);
    const cp = Math.cos(pitch);
    // a point in px (y down) and its depth; null behind the camera
    const px = (x: number, y: number, z: number) => {
      const vy = y - cy;
      const vz = z - cz;
      const zc = -vy * sp - vz * cp;
      if (zc <= 0.1) return null;
      const yc = vy * cp - vz * sp;
      return [(x / (zc * th) + 1) * 0.5 * W, (1 - yc / (zc * tv)) * 0.5 * H, zc] as const;
    };
    const ringsIn = ring.every(([x, y, z]) => {
      const p = px(x, y, z);
      return !!p && p[0] >= EDGE && p[0] <= W - EDGE && p[1] >= EDGE && p[1] <= H - EDGE;
    });
    return (
      ringsIn &&
      plates.every(([x, y, z]) => {
        const p = px(x, y, z);
        if (!p) return false;
        // a world-sized sprite: its half size in px at this depth
        const hw = (pw / (2 * p[2] * th)) * 0.5 * W;
        const hh = (ph / (2 * p[2] * tv)) * 0.5 * H;
        const b = { l: p[0] - hw, r: p[0] + hw, t: p[1] - hh, b: p[1] + hh };
        return b.l >= EDGE && b.r <= W - EDGE && b.t >= EDGE && b.b <= H - EDGE && !keep.some((k) => b.l < k.r && b.r > k.l && b.t < k.b && b.b > k.t);
      })
    );
  };
  const pitches: number[] = [];
  for (let k = -3; k <= 3; k++) pitches.push(pitch0 + k * DEG);
  // the pitches that fit at d, nearest the usual pitch first
  const fitting = (d: number) => pitches.filter((p) => fits(d, p)).sort((a, b) => Math.abs(a - pitch0) - Math.abs(b - pitch0));
  let lo = 3;
  let hi = 60;
  for (let k = 0; k < 28; k++) {
    const mid = (lo + hi) / 2;
    if (fitting(mid).length) hi = mid;
    else lo = mid;
  }
  const pitch = fitting(hi)[0] ?? pitch0;
  const cy = fy + hi * Math.sin(elF);
  const cz = hi * Math.cos(elF);
  return { pos: [0, cy, cz], fov: vfov, tz: cz - cy / Math.tan(pitch) };
}

/* The frame's controls in px (y down), as games.css places them: the
   caption top-left (up to three lines on a phone, one wider), Reset view
   and the sound toggle top-right, Move bottom-left (touch screens only,
   but a touch screen can be wide). A plate kept clear of these reads. */
function frameControls(W: number, H: number) {
  const phone = W < PHONE_BELOW;
  return [
    { l: 0, r: phone ? W - 180 : 320, t: 0, b: phone ? 74 : 44 },
    { l: W - 142, r: W, t: 0, b: 46 },
    { l: 0, r: 100, t: H - 58, b: H },
  ];
}

/* Home for a crowded table (CROWDED seats or more) on a phone. The rule
   above fits a point near each plate's top and the seat ring, not the
   plates themselves, and knows nothing of the frame's controls: with 7 or
   8 seats in a 310 px frame a side seat's plate sat under the Move button,
   the viewer's own score line ran off the bottom, and the far plates
   shrank to specks behind the shallow view. Here the camera looks down
   steeper, every plate is PLATE_PX on screen (plateK), and each is fitted
   whole inside the frame, below the caption and the tools across the top
   and clear of the Move button in the bottom-left corner. The pitch is
   searched with the distance, so the table sits in whatever band those
   leave; the closest such view also spreads the plates furthest apart. */
export function trHomeCrowded(aspect: number, width: number, seats: SeatXZ[]): Home {
  const vfov = trFov(aspect);
  const tv = Math.tan((vfov * Math.PI) / 360);
  const th = tv * Math.max(0.45, aspect);
  const W = width;
  const H = width / Math.max(0.3, aspect);
  // px kept clear: the caption and tools band along the top (the caption
  // wraps to three lines at this width), the Move button bottom-left
  const TOP = 74;
  const EDGE = 4;
  const MOVE_W = 100;
  const MOVE_H = 58;
  const elF = (52 * Math.PI) / 180;
  const fy = 0.6;
  // the seat rings' outer edges, and each plate's centre as SeatMark places it
  const rings = seats.map((st) => [st.x * 1.12, 0, st.z * 1.12] as const);
  const plates = seats.map((st) => [st.x * 1.28, 0.55, st.z * 1.28] as const);
  const fits = (d: number, pitch: number) => {
    const cy = fy + d * Math.sin(elF);
    const cz = d * Math.cos(elF);
    const sp = Math.sin(pitch);
    const cp = Math.cos(pitch);
    // a point in px, y down; null behind the camera
    const px = (x: number, y: number, z: number) => {
      const vy = y - cy;
      const vz = z - cz;
      const zc = -vy * sp - vz * cp;
      if (zc <= 0.1) return null;
      const yc = vy * cp - vz * sp;
      return [(x / (zc * th) + 1) * 0.5 * W, (1 - yc / (zc * tv)) * 0.5 * H] as const;
    };
    const ringsIn = rings.every(([x, y, z]) => {
      const p = px(x, y, z);
      return !!p && p[0] >= EDGE && p[0] <= W - EDGE && p[1] >= EDGE && p[1] <= H - EDGE;
    });
    return (
      ringsIn &&
      plates.every(([x, y, z]) => {
        const p = px(x, y, z);
        if (!p) return false;
        const l = p[0] - PLATE_PX[0] / 2;
        const r = p[0] + PLATE_PX[0] / 2;
        const t = p[1] - PLATE_PX[1] / 2;
        const bt = p[1] + PLATE_PX[1] / 2;
        return l >= EDGE && r <= W - EDGE && t >= TOP && bt <= H - EDGE && !(l < MOVE_W && bt > H - MOVE_H);
      })
    );
  };
  const DEG = Math.PI / 180;
  const pitches: number[] = [];
  for (let k = -16; k <= 16; k++) if (elF + k * DEG > 10 * DEG) pitches.push(elF + k * DEG);
  const fitting = (d: number) => pitches.filter((p) => fits(d, p));
  let lo = 3;
  let hi = 60;
  for (let k = 0; k < 28; k++) {
    const mid = (lo + hi) / 2;
    if (fitting(mid).length) hi = mid;
    else lo = mid;
  }
  const ok = fitting(hi);
  const pitch = ok.length ? ok[Math.floor(ok.length / 2)]! : elF;
  const cy = fy + hi * Math.sin(elF);
  const cz = hi * Math.cos(elF);
  return { pos: [0, cy, cz], fov: vfov, tz: cz - cy / Math.tan(pitch) };
}
