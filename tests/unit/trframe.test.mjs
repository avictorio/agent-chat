// Unit tests for Trust's home framing
// (web/app/src/features/games/trust/trframe.ts): with 2 to 8 seats, on a
// phone and on a desktop, every name plate must land whole inside the
// frame, its score line included, clear of the frame's controls; a crowded
// phone table's plates must read at one size. The camera and the projection are
// three.js's own, so the check does not reuse the framing's own maths.
// Run with `npm run test:unit`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PerspectiveCamera, Vector3 } from "../../web/node_modules/three/build/three.module.js";
import { PHONE_BELOW, PLATE, PLATE_BIG, PLATE_PX, plateK, tableR, trHome } from "../../web/app/src/features/games/trust/trframe.ts";

// Seats as TrustArena3D places them: the viewer at the front (+z).
function seats(n) {
  const R = tableR(n);
  return Array.from({ length: n }, (_, k) => {
    const a = Math.PI / 2 + (k * 2 * Math.PI) / n;
    return { x: Math.cos(a) * R, z: Math.sin(a) * R };
  });
}

// Each plate's box in px (y down) in a W x H frame, from the home the
// framing picks. A plate is a sprite 0.55 up, 1.28 x the seat's place
// (SeatMark): PLATE_PX on screen when plateK says so, else world-sized.
function plates(n, W, H) {
  const home = trHome(W / H, W, seats(n));
  const cam = new PerspectiveCamera(home.fov, W / H, 0.1, 800);
  cam.position.set(...home.pos);
  cam.lookAt(0, 0, home.tz || 0);
  cam.updateMatrixWorld();
  const k = plateK(W, H, n);
  const tv = Math.tan((cam.fov * Math.PI) / 360);
  return seats(n).map((s) => {
    const c = new Vector3(s.x * 1.28, 0.55, s.z * 1.28);
    const depth = -c.clone().applyMatrix4(cam.matrixWorldInverse).z;
    const p = c.clone().project(cam);
    const x = ((p.x + 1) / 2) * W;
    const y = ((1 - p.y) / 2) * H;
    // a sprite without size attenuation is scale * H / (2 tan(fov/2)) px
    // tall; with it, scale / depth of that
    const [w, h] = k ? [PLATE_PX[0] * k, PLATE_PX[1] * k].map((v) => (v * H) / (2 * tv)) : (W < PHONE_BELOW ? PLATE_BIG : PLATE).map((v) => (v * H) / (2 * tv * depth));
    return { l: x - w / 2, r: x + w / 2, t: y - h / 2, b: y + h / 2, h };
  });
}

// The frame's controls (games.css): Move bottom-left (left 8, bottom 10, 40
// tall, about 86 wide; touch screens only, and a touch screen can be wide),
// Reset view and the sound toggle top-right (top 8, 34 tall, about 130
// wide), the caption top-left (up to three lines on a phone, about 62 tall;
// one line of about 275 px on a desktop).
const hits = (a, b) => a.l < b.r && a.r > b.l && a.t < b.b && a.b > b.t;

// The whole sprite counts as the plate (its score line ends about 10 px
// above the sprite's bottom on a phone), with SPARE px more to the edge:
// the viewer's own "8 (+0) · you" used to run off the bottom.
const SPARE = 2;
const FRAMES = [[362, 310], [332, 310], [692, 396]];
for (let n = 2; n <= 8; n++) {
  for (const [W, H] of FRAMES) {
    test(`Trust with ${n} seats in a ${W} x ${H} frame: every plate whole, clear of the controls`, () => {
      const phone = W < PHONE_BELOW;
      const move = { l: 8, r: 94, t: H - 50, b: H - 10 };
      const tools = { l: W - 138, r: W - 8, t: 8, b: 42 };
      const caption = phone ? { l: 8, r: W - 182, t: 8, b: 70 } : { l: 8, r: 284, t: 8, b: 38 };
      const ps = plates(n, W, H);
      ps.forEach((p, i) => {
        const at = `seat ${i} ${JSON.stringify(p)}`;
        assert.ok(p.l >= SPARE && p.r <= W - SPARE && p.t >= SPARE && p.b <= H - SPARE, "inside the frame: " + at);
        assert.ok(!hits(p, move), "clear of Move: " + at);
        assert.ok(!hits(p, tools), "clear of Reset view and the sound toggle: " + at);
        assert.ok(!hits(p, caption), "clear of the caption: " + at);
      });
      // a crowded phone table: the far plates read as well as the viewer's own
      if (phone && n >= 7) assert.ok(Math.min(...ps.map((p) => p.h)) >= 34, "every plate at least 34 px tall: " + ps.map((p) => Math.round(p.h)));
    });
  }
}
