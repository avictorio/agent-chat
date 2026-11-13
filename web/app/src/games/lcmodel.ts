/* Light Cycles, as a timeline (2026-11-13).

   The server keeps every rider's trail in growth order and resolves a
   tick for everyone at once (worker.js resolveTick): each live rider
   moves one cell; a rider whose target is off the grid, already
   taken (a trail, or any rider's head) or shared with another rider
   is out, and does NOT move - its trail ends where it stood. So a
   rider's path is fully known from the trails: cells[k] is where it
   stood after tick k (cells[0] is its spawn), and a crashed rider's
   last cell plus its final heading (p.dir, set before deaths are
   counted) names the cell it died trying to reach.

   That makes every past tick replayable, which the arena uses for the
   sprint (each tick's move plays as motion, not a teleport), the
   catch-up (ticks the viewer missed, fast-forwarded) and the crash
   staging (the bike races into the wall it hit). Positions are in
   grid units (x right, y down, as the 2D board); the arena maps them
   to world space. Nothing here touches three.js. */

export type Dir = "up" | "down" | "left" | "right";
export const DV: Record<Dir, [number, number]> = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };
const isDir = (d: unknown): d is Dir => d === "up" || d === "down" || d === "left" || d === "right";

export type OutKind = "wall" | "trail" | "headon" | "taken";
export type Rider = {
  i: number;
  name: string;
  hex: string;
  alive: boolean;
  me: boolean;
  /* cells[k]: where the rider stood after tick k0 + k (k0 is 0 in a
     real match: every rider spawns at tick 0 and lays one cell a tick) */
  cells: [number, number][];
  k0: number;
  /* the heading it rode (alive) or died on (out) */
  dir: Dir;
  out: null | {
    /* the tick on which it went out */
    tick: number;
    kind: OutKind;
    /* the cell it tried to reach (crashes) */
    target: [number, number];
    /* how far past its last cell's centre the bike gets before the
       impact, in cells */
    reach: number;
    /* head-on partners */
    with: number[];
  };
};

/* How far a crashing bike travels before it strikes: the nose sits
   0.45 of a cell ahead of the bike's cell centre (LcArena3D), so an
   edge wall half a cell away is hit almost at once, a trail through
   the next cell's centre after ~0.45, and two riders racing for one
   cell meet in its middle. */
const REACH: Record<OutKind, number> = { wall: 0.06, trail: 0.42, headon: 0.5, taken: 0 };

export function riders(g: any, me: string): Rider[] {
  const players: any[] = (g && g.players) || [];
  const w = (g && g.w) || 30;
  const h = (g && g.h) || 22;
  const tick = Number((g && g.tick) || 0);
  const meKey = String(me || "").toLowerCase();
  const cellsOf: [number, number][][] = players.map(() => []);
  ((g && g.trails) || []).forEach((c: number[]) => {
    const arr = cellsOf[c[2] ?? -1];
    if (arr) arr.push([c[0] ?? 0, c[1] ?? 0]);
  });
  const logs: any[] = (g && g.log) || [];
  // the server's own record of a rider going out: "<name> is out at
  // tick N" (a crash) or "<name> is taken out" (three missed ticks),
  // each logged with the tick it happened on
  const logTick = (name: string, phrase: string): number | null => {
    for (const l of logs) {
      if (typeof l.text === "string" && l.text.indexOf(name + phrase) === 0) {
        const n = Number(l.tick) || parseInt(l.text.slice((name + phrase).length), 10);
        return n > 0 ? n : null;
      }
    }
    return null;
  };
  const list: Rider[] = players.map((p, i) => {
    let cells = cellsOf[i] || [];
    if (!cells.length && typeof p.x === "number") cells = [[p.x, p.y]];
    const last = cells[cells.length - 1] || [0, 0];
    let dir: Dir = isDir(p.dir) ? p.dir : "right";
    if (!isDir(p.dir) && cells.length >= 2) {
      const a = cells[cells.length - 2]!;
      dir = last[0] > a[0] ? "right" : last[0] < a[0] ? "left" : last[1] > a[1] ? "down" : "up";
    }
    const r: Rider = { i, name: String(p.name), hex: String(p.hex || "#22d3ee"), alive: !!p.alive, me: !!meKey && String(p.name).toLowerCase() === meKey, cells, k0: 0, dir, out: null };
    const n = cells.length;
    if (p.alive || !g || g.status === "lobby") {
      // a live rider's newest cell is the present tick
      r.k0 = Math.max(0, tick - (n - 1));
    } else if (n) {
      const takenAt = logTick(r.name, " is taken out");
      if (takenAt !== null) {
        // it rode its last tick, then the clock took it out
        const t = Math.min(tick, takenAt);
        r.out = { tick: t, kind: "taken", target: last, reach: 0, with: [] };
        r.k0 = Math.max(0, t - (n - 1));
      } else {
        const v = DV[dir];
        const target: [number, number] = [last[0] + v[0], last[1] + v[1]];
        const off = target[0] < 0 || target[1] < 0 || target[0] >= w || target[1] >= h;
        const kind: OutKind = off ? "wall" : "trail";
        // the crash tick: the server's log line, or (a real match) the
        // tick after its last cell
        const t = Math.min(tick, Math.max(1, logTick(r.name, " is out at tick ") ?? n));
        r.out = { tick: t, kind, target, reach: REACH[kind], with: [] };
        r.k0 = Math.max(0, t - n);
      }
    }
    return r;
  });
  // head-ons: two riders out on the same tick who raced for one cell,
  // or swapped cells through each other
  list.forEach((a) => {
    if (!a.out || a.out.kind === "taken") return;
    list.forEach((b) => {
      if (b === a || !b.out || b.out.kind === "taken" || b.out.tick !== a.out!.tick) return;
      const al = a.cells[a.cells.length - 1]!;
      const bl = b.cells[b.cells.length - 1]!;
      const same = a.out!.target[0] === b.out!.target[0] && a.out!.target[1] === b.out!.target[1];
      const swap = a.out!.target[0] === bl[0] && a.out!.target[1] === bl[1] && b.out!.target[0] === al[0] && b.out!.target[1] === al[1];
      if (same || swap) {
        a.out!.kind = "headon";
        a.out!.reach = same ? REACH.headon : 0.06;
        if (a.out!.with.indexOf(b.i) < 0) a.out!.with.push(b.i);
      }
    });
  });
  return list;
}

/* The tick a rider's last move belongs to: an alive rider rides
   through the current tick; an out rider's story ends at its out tick. */
export function lastTick(r: Rider): number {
  return r.out ? r.out.tick : r.k0 + r.cells.length - 1;
}

/* When (in float ticks) a crashing rider strikes: during its out tick,
   after it covers its reach. Taken-out riders go at the end of their
   last tick. */
export function impactAt(r: Rider): number | null {
  if (!r.out) return null;
  if (r.out.kind === "taken") return r.out.tick;
  // the out tick moves from cells[tick-1]; a crash fraction of 1 is a
  // whole cell, so the strike lands `reach` into it
  return r.out.tick - 1 + Math.max(0.06, r.out.reach);
}

export type Pose = {
  x: number;
  y: number;
  /* heading as a grid vector, and the previous one (for the turn) */
  dir: Dir;
  prev: Dir;
  /* 0..1 through the tick being played */
  f: number;
  /* the bike is on the grid (not yet derezzed) */
  shown: boolean;
  /* arc length of the path so far, in cells (the trail's head) */
  s: number;
};

function headingOf(cells: [number, number][], k: number, fallback: Dir): Dir {
  const a = cells[k - 1];
  const b = cells[k];
  if (!a || !b) return fallback;
  return b[0] > a[0] ? "right" : b[0] < a[0] ? "left" : b[1] > a[1] ? "down" : b[1] < a[1] ? "up" : fallback;
}

/* Where a rider is at float tick T. Everything inside runs on the
   rider's own cell index (T - k0); impacts are in match ticks. */
export function poseAt(r: Rider, T: number): Pose {
  const cells = r.cells;
  const n = cells.length;
  const lastK = n - 1;
  const t = Math.max(0, T - r.k0);
  const k = Math.floor(t);
  const f = t - k;
  if (!n) return { x: 0, y: 0, dir: r.dir, prev: r.dir, f: 0, shown: false, s: 0 };
  if (k < lastK) {
    const a = cells[k]!;
    const b = cells[k + 1]!;
    const dir = headingOf(cells, k + 1, r.dir);
    const prev = k >= 1 ? headingOf(cells, k, dir) : dir;
    return { x: a[0] + (b[0] - a[0]) * f, y: a[1] + (b[1] - a[1]) * f, dir, prev, f, shown: true, s: k + f };
  }
  const end = cells[lastK]!;
  const before = lastK >= 1 ? headingOf(cells, lastK, r.dir) : r.dir;
  if (r.out && r.out.kind !== "taken") {
    // the out tick: race toward the target, stop at the impact
    const hit = impactAt(r)! - r.k0;
    const into = Math.min(t, hit) - lastK;
    const v = DV[r.dir];
    const g = Math.max(0, into);
    return { x: end[0] + v[0] * g, y: end[1] + v[1] * g, dir: r.dir, prev: before, f: into > 0 ? into : 0, shown: t < hit, s: lastK + g };
  }
  if (r.out && r.out.kind === "taken") {
    return { x: end[0], y: end[1], dir: before, prev: before, f: 0, shown: t < r.out.tick - r.k0, s: lastK };
  }
  // alive and waiting on the next tick: parked in its cell, facing on
  return { x: end[0], y: end[1], dir: r.alive ? r.dir : before, prev: before, f: 0, shown: r.alive, s: lastK };
}

/* Sides of a heading, for near misses. */
const SIDES: Record<Dir, [Dir, Dir]> = { up: ["left", "right"], down: ["right", "left"], left: ["down", "up"], right: ["up", "down"] };

/* Near misses on tick k: a rider who reached its new cell with a wall
   or trail right alongside (it skimmed it). Returns [rider, side]. */
export function nearMisses(list: Rider[], m: number, w: number, h: number): { i: number; side: Dir; x: number; y: number }[] {
  const taken = new Map<string, number>();
  list.forEach((r) => r.cells.forEach((c, j) => {
    if (j + r.k0 <= m) taken.set(c[0] + "," + c[1], 1);
  }));
  const out: { i: number; side: Dir; x: number; y: number }[] = [];
  list.forEach((r) => {
    const k = m - r.k0;
    if (r.cells.length <= k || k < 1) return;
    const c = r.cells[k]!;
    const d = headingOf(r.cells, k, r.dir);
    for (const side of SIDES[d]) {
      const v = DV[side];
      const x = c[0] + v[0];
      const y = c[1] + v[1];
      const wall = x < 0 || y < 0 || x >= w || y >= h;
      // the cell beside must have been taken before this tick (not a
      // trail laid by the rider itself on this move)
      const key = x + "," + y;
      if (wall || taken.has(key)) {
        const mine = r.cells[k - 1] && r.cells[k - 1]![0] === x && r.cells[k - 1]![1] === y;
        if (!mine) {
          out.push({ i: r.i, side, x: c[0], y: c[1] });
          break;
        }
      }
    }
  });
  return out;
}

/* Territory: which rider reaches each free cell first if everyone
   rode straight for it (a multi-source flood from the live heads;
   ties stay neutral). -1 = taken or neutral. */
export function territory(list: Rider[], w: number, h: number): Int8Array {
  const own = new Int8Array(w * h).fill(-1);
  const dist = new Int32Array(w * h).fill(1 << 30);
  const blocked = new Uint8Array(w * h);
  list.forEach((r) => r.cells.forEach((c) => {
    if (c[0] >= 0 && c[1] >= 0 && c[0] < w && c[1] < h) blocked[c[1] * w + c[0]] = 1;
  }));
  let frontier: number[] = [];
  list.forEach((r) => {
    if (!r.alive || !r.cells.length) return;
    const c = r.cells[r.cells.length - 1]!;
    const idx = c[1] * w + c[0];
    dist[idx] = 0;
    own[idx] = r.i;
    frontier.push(idx);
  });
  let d = 0;
  while (frontier.length) {
    d++;
    const next: number[] = [];
    for (const idx of frontier) {
      const o = own[idx]!;
      if (o < 0) continue;
      const x = idx % w;
      const y = (idx - x) / w;
      const nb = [x > 0 ? idx - 1 : -1, x < w - 1 ? idx + 1 : -1, y > 0 ? idx - w : -1, y < h - 1 ? idx + w : -1];
      for (const n of nb) {
        if (n < 0 || blocked[n]) continue;
        if (dist[n]! > d) {
          dist[n] = d;
          own[n] = o;
          next.push(n);
        } else if (dist[n] === d && own[n] !== o) own[n] = -2; // contested
      }
    }
    frontier = next;
  }
  for (let i = 0; i < own.length; i++) if (blocked[i] || own[i]! < -1) own[i] = -1;
  return own;
}

/* The viewer's options this tick: each legal heading's target cell,
   and whether the server counts it safe. */
export function options(g: any, r: Rider | undefined, list?: Rider[]): { dir: Dir; x: number; y: number; safe: boolean; queued: boolean }[] {
  const you = g && g.you;
  if (!r || !r.alive || !you || !you.playing || !you.alive || !g || g.status !== "running") return [];
  const legal: string[] = you.legal_moves || [];
  const c = r.cells[r.cells.length - 1];
  if (!c) return [];
  // the server's verdict when it sent one; else the same test it runs:
  // in bounds and not a trail or a rider's head
  let safe: string[] | null = Array.isArray(you.safe_moves) ? you.safe_moves : null;
  if (!safe) {
    const w = g.w || 30, h = g.h || 22;
    const taken = new Set<string>();
    (list || [r]).forEach((q) => q.cells.forEach((cc) => taken.add(cc[0] + "," + cc[1])));
    safe = legal.filter((d) => {
      if (!isDir(d)) return false;
      const x = c[0] + DV[d][0], y = c[1] + DV[d][1];
      return x >= 0 && y >= 0 && x < w && y < h && !taken.has(x + "," + y);
    });
  }
  const ok = safe;
  return legal.filter(isDir).map((d) => ({ dir: d, x: c[0] + DV[d][0], y: c[1] + DV[d][1], safe: ok.indexOf(d) >= 0, queued: you.queued === d }));
}

/* Where the viewer last left this match: the catch-up replays from
   here. Per page path and game, in localStorage. */
const SEEN = "ac-lc-seen:";
export function seenTick(id: unknown): number | null {
  try {
    const v = localStorage.getItem(SEEN + location.pathname + ":" + String(id));
    return v === null ? null : Number(v);
  } catch {
    return null;
  }
}
export function setSeenTick(id: unknown, tick: number): void {
  try {
    localStorage.setItem(SEEN + location.pathname + ":" + String(id), String(tick));
  } catch {
    // storage unavailable: the next visit simply opens on the present
  }
}
