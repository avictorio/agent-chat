// Unit tests for Trust's home framing on a phone
// (web/app/src/features/games/trust/trframe.ts): with 7 or 8 seats every
// name plate must land whole inside the frame, clear of the frame's
// controls, and read at one size. The camera and the projection are
// three.js's own, so the check does not reuse the framing's own maths.
// Run with `npm run test:unit`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PerspectiveCamera, Vector3 } from "../../web/node_modules/three/build/three.module.js";
import { PLATE_BIG, PLATE_PX, plateK, tableR, trHome } from "../../web/app/src/features/games/trust/trframe.ts";

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
    const [w, h] = k ? [PLATE_PX[0] * k, PLATE_PX[1] * k].map((v) => (v * H) / (2 * tv)) : PLATE_BIG.map((v) => (v * H) / (2 * tv * depth));
    return { l: x - w / 2, r: x + w / 2, t: y - h / 2, b: y + h / 2, h };
  });
}

// The frame's controls in a phone frame (games.css): Move bottom-left
// (left 8, bottom 10, 40 tall, about 86 wide), Reset view and the sound
// toggle top-right (top 8, 34 tall, about 130 wide), the caption top-left
// (up to three lines at this width: about 62 tall).
const hits = (a, b) => a.l < b.r && a.r > b.l && a.t < b.b && a.b > b.t;

for (const n of [7, 8]) {
  for (const W of [362, 332]) {
    test(`Trust with ${n} seats in a ${W} x 310 phone frame: every plate whole, clear of the controls, one size`, () => {
      const H = 310;
      const move = { l: 8, r: 94, t: H - 50, b: H - 10 };
      const tools = { l: W - 138, r: W - 8, t: 8, b: 42 };
      const caption = { l: 8, r: W - 182, t: 8, b: 70 };
      const ps = plates(n, W, H);
      ps.forEach((p, i) => {
        const at = `seat ${i} ${JSON.stringify(p)}`;
        assert.ok(p.l >= 0 && p.r <= W && p.t >= 0 && p.b <= H, "inside the frame: " + at);
        assert.ok(!hits(p, move), "clear of Move: " + at);
        assert.ok(!hits(p, tools), "clear of Reset view and the sound toggle: " + at);
        assert.ok(!hits(p, caption), "clear of the caption: " + at);
      });
      // the far plates read as well as the viewer's own
      assert.ok(Math.min(...ps.map((p) => p.h)) >= 34, "every plate at least 34 px tall: " + ps.map((p) => Math.round(p.h)));
    });
  }
}
