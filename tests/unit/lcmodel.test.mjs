// Unit tests for the web app's Light Cycles timeline model
// (web/app/src/features/games/lightcycles/lcmodel.ts): rebuilding riders
// from a match state, poses at any float tick, impacts, head-ons, near
// misses, territory and the viewer's options. Run with `npm run test:unit`
// (Node strips the TypeScript types; no build step).
import { test } from "node:test";
import assert from "node:assert/strict";
import { riders, poseAt, impactAt, nearMisses, territory, options } from "../../web/app/src/features/games/lightcycles/lcmodel.ts";

// A small match: trails are [x, y, riderIndex] in growth order.
function match(over = {}) {
  return {
    status: "running", w: 6, h: 4, tick: 2,
    players: [
      { name: "Ada", hex: "#22d3ee", alive: true, dir: "right", x: 2, y: 1 },
      { name: "Rex", hex: "#fb923c", alive: true, dir: "left", x: 3, y: 2 },
    ],
    trails: [[0, 1, 0], [1, 1, 0], [2, 1, 0], [5, 2, 1], [4, 2, 1], [3, 2, 1]],
    log: [], move_log: [],
    ...over,
  };
}

test("riders: paths from the trails, the viewer marked, live riders end at the present tick", () => {
  const list = riders(match(), "ada");
  assert.equal(list.length, 2);
  assert.deepEqual(list[0].cells, [[0, 1], [1, 1], [2, 1]]);
  assert.equal(list[0].me, true);
  assert.equal(list[1].me, false);
  assert.equal(list[0].k0, 0); // tick 2, three cells: spawned at tick 0
  assert.equal(list[0].out, null);
});

test("riders: a crash into the edge is a wall, on the tick the log names", () => {
  const g = match({
    tick: 3,
    players: [{ name: "Ada", alive: false, dir: "right" }, { name: "Rex", alive: true, dir: "down" }],
    w: 3,
    trails: [[0, 0, 0], [1, 0, 0], [2, 0, 0], [0, 2, 1], [0, 3, 1]],
    log: [{ tick: 3, text: "Ada is out at tick 3 (hit the wall)." }],
  });
  const [ada] = riders(g, "Rex");
  assert.equal(ada.out.kind, "wall");
  assert.equal(ada.out.tick, 3);
  assert.deepEqual(ada.out.target, [3, 0]);
  assert.equal(ada.k0, 0);
});

test("riders: a crash inside the grid is a trail hit", () => {
  const g = match({
    tick: 2,
    players: [{ name: "Ada", alive: false, dir: "down" }, { name: "Rex", alive: true, dir: "left" }],
    trails: [[1, 0, 0], [1, 1, 0], [3, 2, 1], [2, 2, 1], [1, 2, 1]],
    log: [{ tick: 2, text: "Ada is out at tick 2." }],
  });
  const [ada] = riders(g, "");
  assert.equal(ada.out.kind, "trail");
  assert.deepEqual(ada.out.target, [1, 2]);
});

test("riders: two riders racing for one cell are a head-on, each naming the other", () => {
  const g = match({
    tick: 2,
    players: [{ name: "Ada", alive: false, dir: "right" }, { name: "Rex", alive: false, dir: "left" }],
    trails: [[0, 1, 0], [1, 1, 0], [4, 1, 1], [3, 1, 1]],
    log: [{ tick: 2, text: "Ada is out at tick 2." }, { tick: 2, text: "Rex is out at tick 2." }],
  });
  const [ada, rex] = riders(g, "");
  assert.equal(ada.out.kind, "headon");
  assert.equal(rex.out.kind, "headon");
  assert.deepEqual(ada.out.with, [1]);
  assert.deepEqual(rex.out.with, [0]);
  assert.equal(ada.out.reach, 0.5); // they meet in the middle of the cell
});

test("riders: riders swapping cells through each other are a head-on too", () => {
  const g = match({
    tick: 2,
    players: [{ name: "Ada", alive: false, dir: "right" }, { name: "Rex", alive: false, dir: "left" }],
    trails: [[1, 1, 0], [2, 1, 0], [4, 1, 1], [3, 1, 1]],
    log: [{ tick: 2, text: "Ada is out at tick 2." }, { tick: 2, text: "Rex is out at tick 2." }],
  });
  const [ada] = riders(g, "");
  assert.equal(ada.out.kind, "headon");
  assert.equal(ada.out.reach, 0.06);
});

test("riders: a rider the clock took out rode its last tick", () => {
  const g = match({
    tick: 4,
    players: [{ name: "Ada", alive: false, dir: "right" }, { name: "Rex", alive: true, dir: "left" }],
    trails: [[0, 1, 0], [1, 1, 0], [2, 1, 0], [5, 2, 1], [4, 2, 1], [3, 2, 1], [2, 2, 1], [1, 2, 1]],
    log: [{ tick: 3, text: "Ada is taken out (missed three ticks)." }],
  });
  const [ada] = riders(g, "");
  assert.equal(ada.out.kind, "taken");
  assert.equal(ada.out.tick, 3);
  assert.equal(impactAt(ada), 3);
});

test("poseAt: a live rider moves between cells as the tick plays, then parks", () => {
  const [ada] = riders(match(), "Ada");
  const mid = poseAt(ada, 1.5);
  assert.equal(mid.x, 1.5);
  assert.equal(mid.y, 1);
  assert.equal(mid.dir, "right");
  assert.equal(mid.shown, true);
  assert.equal(mid.s, 1.5);
  const parked = poseAt(ada, 5);
  assert.deepEqual([parked.x, parked.y, parked.shown], [2, 1, true]);
});

test("poseAt and impactAt: a crashing bike runs into the wall and is gone after the impact", () => {
  const g = match({
    tick: 3, w: 3,
    players: [{ name: "Ada", alive: false, dir: "right" }, { name: "Rex", alive: true, dir: "down" }],
    trails: [[0, 0, 0], [1, 0, 0], [2, 0, 0], [0, 2, 1], [0, 3, 1]],
    log: [{ tick: 3, text: "Ada is out at tick 3." }],
  });
  const [ada] = riders(g, "");
  const hit = impactAt(ada);
  assert.ok(hit > 2 && hit < 3, "the impact lands inside the out tick: " + hit);
  assert.equal(poseAt(ada, hit - 0.01).shown, true);
  assert.equal(poseAt(ada, hit + 0.01).shown, false);
  assert.ok(poseAt(ada, 2.9).x <= 2 + 0.06 + 1e-9, "the bike stops at the wall");
});

test("nearMisses: a rider that reached a cell with the wall right beside it skimmed it", () => {
  const g = match({
    w: 6, h: 3, tick: 2,
    players: [{ name: "Ada", alive: true, dir: "right" }],
    trails: [[0, 0, 0], [1, 0, 0], [2, 0, 0]],
  });
  const list = riders(g, "");
  const hits = nearMisses(list, 2, 6, 3);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].side, "up");
  assert.deepEqual([hits[0].x, hits[0].y], [2, 0]);
});

test("territory: each free cell goes to the rider who reaches it first; ties stay neutral", () => {
  const g = match({
    w: 5, h: 1, tick: 0,
    players: [{ name: "Ada", alive: true, dir: "right" }, { name: "Rex", alive: true, dir: "left" }],
    trails: [[0, 0, 0], [4, 0, 1]],
  });
  const own = Array.from(territory(riders(g, ""), 5, 1));
  // heads are taken (-1); cell 1 is Ada's, cell 3 Rex's, the middle a tie
  assert.deepEqual(own, [-1, 0, -1, 1, -1]);
});

test("options: the server's safe_moves when sent, the same test client-side otherwise", () => {
  const base = match({ you: { playing: true, alive: true, legal_moves: ["up", "down", "right"], queued: "up" } });
  const list = riders(base, "Ada");
  const ada = list[0];
  const local = options(base, ada, list);
  assert.deepEqual(local.map((o) => o.dir + ":" + o.safe), ["up:true", "down:true", "right:true"]);
  assert.equal(local.find((o) => o.dir === "up").queued, true);
  const told = options({ ...base, you: { ...base.you, safe_moves: ["down"] } }, ada, list);
  assert.deepEqual(told.map((o) => o.dir + ":" + o.safe), ["up:false", "down:true", "right:false"]);
  assert.deepEqual(options({ ...base, status: "finished" }, ada, list), []);
});
