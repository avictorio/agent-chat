// Light Cycles: turn-based Tron; every rider moves at once each tick.
// A tick resolves when every living rider has moved, or when its clock
// expires (a miss sends the bike straight). st.move_log records per tick
// and rider the direction, its source (submitted / clock default), and
// when a submitted move arrived. The clocks and the alarm are the shared
// machinery in room/games.js.

import { clockWords, seatAccepted } from "./shared.js";

export const LightCyclesMethods = {
  // A rider's legal moves: any direction but straight back.
  legalMoves(p) {
    const rev = { up: "down", down: "up", left: "right", right: "left" };
    return ["up", "down", "left", "right"].filter((d) => d !== rev[p.dir]);
  },

  // The subset of legal moves that does not crash on this tick as the
  // board stands: the target cell is in bounds and holds no trail and
  // no rider's head. (Another rider steering into the same cell can
  // still kill you - that is the game, not a wall.)
  safeMoves(st, p) {
    const dirs = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };
    const occ = new Set(st.trails.map((c) => c[0] + "," + c[1]));
    for (const q of st.players) if (q.alive) occ.add(q.x + "," + q.y);
    return this.legalMoves(p).filter((d) => {
      const v = dirs[d];
      const x = p.x + v[0], y = p.y + v[1];
      return x >= 0 && y >= 0 && x < st.w && y < st.h && !occ.has(x + "," + y);
    });
  },

  lcSummary(g) {
    const st = g.st;
    return {
      id: g.id, type: "lightcycles", status: g.status, created_by: g.created_by, card_msg: g.card_msg,
      w: st.w, h: st.h, tick: st.tick, tick_seconds: st.tick_seconds, mode: st.mode || "live", deadline: st.deadline,
      winner: st.winner || null, record_keeper: st.record_keeper || null, declined_by: st.declined_by || null, moves: st.move_stats || {}, lobby_deadline: g.status === "lobby" ? (st.lobby_deadline || null) : null,
      players: st.players.map((p) => ({ name: p.name, color: p.color, hex: p.hex, dir: p.dir, alive: p.alive, x: p.x, y: p.y, moved: !!st.pending[p.name], accepted: st.accepted ? !!st.accepted[p.name] : true })),
    };
  },

  lcStateFull(g, who) {
    const out = this.lcSummary(g);
    const st = g.st;
    out.trails = st.trails;
    out.log = st.log.slice(-80);
    out.move_log = st.move_log || [];
    out.awaiting = g.status === "running" ? st.players.filter((p) => p.alive && !st.pending[p.name]).map((p) => p.name) : [];
    out.awaiting_accept = g.status === "lobby" ? st.players.filter((p) => !(st.accepted || {})[p.name]).map((p) => p.name) : [];
    const me = st.players.find((p) => p.name.toLowerCase() === String(who || "").toLowerCase());
    out.you = me ? { playing: true, accepted: st.accepted ? !!st.accepted[me.name] : true, alive: me.alive, dir: me.dir, queued: st.pending[me.name] || null, legal_moves: g.status === "running" && me.alive ? this.legalMoves(me) : [], safe_moves: g.status === "running" && me.alive ? this.safeMoves(st, me) : [] } : { playing: false };
    return out;
  },

  advanceLightCycles(g, room) {
    let changed = false;
    let guard = 0;
    while (g.status === "running" && Date.now() >= g.st.deadline && guard < 500) {
      guard++;
      this.resolveTick(g);
      changed = true;
      if (g.status === "running") g.st.deadline += g.st.tick_seconds * 1000;
    }
    if (changed) {
      this.saveGame(g);
      this.afterGameChange(g, room, "Referee");
    }
  },

  lcResultText(g) {
    const ms = g.st.move_stats || {};
    const mparts = g.st.players.map((p) => { const s = ms[p.name]; return s ? p.name + " " + s.submitted + "/" + (s.submitted + s.defaulted) : null; }).filter(Boolean);
    return "Light Cycles match #" + g.id + " is over - " + (g.st.winner ? g.st.winner + " takes the grid." : "no survivors; the grid keeps itself.") + (g.st.record_keeper ? " " + g.st.record_keeper + " kept the record." : "") + (mparts.length ? " Moves submitted: " + mparts.join(", ") + "." : "");
  },

  async createLightCycles(creator, playersIn, opts, room) {
    if (!Array.isArray(playersIn) || playersIn.length < 2 || playersIn.length > 4) return { status: 400, error: "players must list 2 to 4 room members" };
    const resolved = this.gamePlayers(playersIn);
    if (resolved.error) return resolved;
    const names = resolved.names;
    // Async mode (2026-11-11, the design review's headline fix): the tick
    // resolves the moment every living rider has submitted - lcMove
    // already resolves on the last rider in - and tick_seconds is only the
    // anti-stall cap for a rider who vanishes, defaulting to an hour. Live
    // mode keeps the fixed clock: default 120s (owner's call, 2026-11-08,
    // replacing the 900/3600 weekday/weekend scheme) - a hook-woken agent's
    // full wake-to-act cycle runs one to two minutes, so anything shorter
    // is mostly played by the clock.
    const mode = opts && String(opts.mode || "").toLowerCase() === "async" ? "async" : "live";
    let tickSeconds = Math.floor(Number(opts && opts.tick_seconds) || 0);
    if (!tickSeconds) tickSeconds = mode === "async" ? 3600 : 120;
    tickSeconds = Math.min(86400, Math.max(30, tickSeconds));
    const lobbySecs = this.lobbySeconds(opts);
    // A 2-rider grid defaults smaller (24x18): on 30x22 the first contact
    // lands late and the opening is a long walk (design review, 2026-11-11).
    const gridDef = names.length === 2 ? { w: 24, h: 18 } : { w: 30, h: 22 };
    const w = Math.min(40, Math.max(12, Math.floor(Number(opts && opts.w) || gridDef.w)));
    const h = Math.min(30, Math.max(10, Math.floor(Number(opts && opts.h) || gridDef.h)));
    const colors = this.gameColors();
    const spawns = [
      { x: Math.floor(w * 0.25), y: Math.floor(h * 0.5), dir: "right" },
      { x: Math.floor(w * 0.75), y: Math.floor(h * 0.5), dir: "left" },
      { x: Math.floor(w * 0.5), y: Math.floor(h * 0.25), dir: "down" },
      { x: Math.floor(w * 0.5), y: Math.floor(h * 0.75), dir: "up" },
    ];
    const players = names.map((n, i) => ({ name: n, color: colors[i].color, hex: colors[i].hex, dir: spawns[i].dir, alive: true, x: spawns[i].x, y: spawns[i].y }));
    const st = {
      type: "lightcycles", w: w, h: h, tick_seconds: tickSeconds, mode: mode, tick: 0,
      deadline: null, lobby_deadline: Date.now() + lobbySecs * 1000, accepted: this.lobbyAccepted(creator, names), players: players,
      trails: players.map((p, i) => [p.x, p.y, i]), pending: {}, pending_at: {}, move_stats: {}, move_log: [],
      log: [{ tick: 0, text: "Match created by " + creator + " - " + names.join(", ") + " invited to the grid. The clock starts when everyone accepts." }],
      record_keeper: null, winner: null, announced: false,
    };
    const ins = this.sql.exec("INSERT INTO gm (status, created, created_by, state) VALUES ('lobby', ?, ?, ?) RETURNING id", Date.now(), creator, JSON.stringify(st)).one();
    const g = this.gameRow(ins.id);
    const label = players.map((p) => p.name + " (" + p.color + ")").join(" vs ");
    const cardText = "Light Cycles match #" + g.id + " - " + label + ". " + (mode === "async" ? "Async: ticks resolve the moment every rider has moved; stall cap " + (tickSeconds >= 3600 ? Math.round(tickSeconds / 3600) + " h" : Math.round(tickSeconds / 60) + " min") + "." : "Tick: " + (tickSeconds >= 3600 ? Math.round(tickSeconds / 3600) + " h" : Math.round(tickSeconds / 60) + " min") + ".") + " Lobby open - the match starts when every player accepts; tap the card to take your seat.";
    const msg = await this.postGameCard(creator, cardText, g.id, room);
    this.sql.exec("UPDATE gm SET card_msg = ? WHERE id = ?", msg.id, g.id);
    g.card_msg = msg.id;
    this.broadcastGame(g, room, creator);
    await this.armGameAlarm();
    return { status: 201, game: this.gameStateFull(g, creator) };
  },

  // A Light Cycles move: queue a direction for the coming tick.
  async lcMove(g, who, dir, room) {
    const st = g.st;
    const me = st.players.find((p) => p.name.toLowerCase() === String(who || "").toLowerCase());
    if (!me) return { status: 403, error: "You are not a player in this match" };
    if (!me.alive) return { status: 409, error: "You are out - the record is yours to keep now" };
    const d = String(dir || "").toLowerCase();
    const rev = { up: "down", down: "up", left: "right", right: "left" };
    if (["up", "down", "left", "right"].indexOf(d) < 0) return { status: 400, error: "dir must be one of up, down, left, right", legal_moves: this.legalMoves(me) };
    if (d === rev[me.dir]) return { status: 400, error: "You cannot reverse (" + me.dir + " -> " + d + ")", legal_moves: this.legalMoves(me) };
    st.pending[me.name] = d;
    if (!st.pending_at) st.pending_at = {};
    st.pending_at[me.name] = Date.now();
    let resolved = false;
    if (!st.players.some((p) => p.alive && !st.pending[p.name])) {
      this.resolveTick(g);
      resolved = true;
      if (g.status === "running") st.deadline = Date.now() + st.tick_seconds * 1000;
      this.saveGame(g);
      // A resolution opens the next tick, and that frame speaks as the
      // Referee: the round belongs to no single rider.
      this.afterGameChange(g, room, "Referee");
    } else {
      this.saveGame(g);
      // A frame per submission (handoff, 2026-11-11): the summary's
      // targets shrink the moment a move lands, so the stream says so
      // too - watchers read any gap between the two as staleness.
      this.broadcastGame(g, room, who);
    }
    await this.armGameAlarm();
    return { status: 200, game: this.gameStateFull(g, who), resolved: resolved };
  },
};

export const lightcyclesEngine = {
  name: "Light Cycles",
  turnWord: "tick",
  logTick: (st) => st.tick,
  clockSeconds: (st) => st.tick_seconds,
  create: (room, creator, players, opts, roomName) => room.createLightCycles(creator, players, opts, roomName),
  summary: (room, g) => room.lcSummary(g),
  full: (room, g, who) => room.lcStateFull(g, who),
  move: (room, g, who, dir, roomName) => room.lcMove(g, who, dir, roomName),
  advance: (room, g, roomName) => room.advanceLightCycles(g, roomName),
  targets: (pub) => pub.players.filter((p) => p.alive && !p.moved).map((p) => p.name),
  card: (g) => ({ id: g.id, type: "lightcycles", status: g.status, tick: g.st.tick, tick_seconds: g.st.tick_seconds, winner: g.st.winner || null, players: g.st.players.map((p) => ({ name: p.name, color: p.color, hex: p.hex, alive: p.alive })) }),
  stateItem: (r, st) => ({ id: r.id, type: "lightcycles", status: r.status, tick: st.tick, players: (st.players || []).map((p) => ({ name: p.name, alive: p.alive, moved: !!(st.pending || {})[p.name], accepted: seatAccepted(st, p) })) }),
  turnOf: (gm) => gm.tick,
  moveHint: () => "<up|down|left|right>",
  result: (room, g) => room.lcResultText(g),
  rules: (st) =>
    "Light Cycles: every rider moves at once each tick - up, down, left or right, never straight back. Bikes leave permanent trails; hitting a wall, any trail or another bike head-on takes you out. The last rider on the grid wins. " +
    (st.mode === "async"
      ? "A tick resolves the moment every living rider has moved (the " + clockWords(st.tick_seconds || 3600) + " clock is only a cap). "
      : "Each tick lasts " + clockWords(st.tick_seconds || 120) + " (it resolves early once every living rider has moved); a rider who hasn't moved rides straight on. ") +
    "Three ticks in a row carried by the clock take you out, so move every tick. Send dir up, down, left or right; you.legal_moves lists your turns and you.safe_moves the ones that don't crash this tick.",
};

export const LightCyclesTickMethods = {
  // One simultaneous resolution. Deaths: wall, any occupied cell (trails and
  // current heads alike - heads become trail), or a shared target cell.
  resolveTick(g) {
    const st = g.st;
    const resolvedAt = Date.now();
    const dirs = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };
    const rev = { up: "down", down: "up", left: "right", right: "left" };
    const occ = new Set(st.trails.map((c) => c[0] + "," + c[1]));
    for (const p of st.players) if (p.alive) occ.add(p.x + "," + p.y);
    const nexts = new Map();
    const attribution = [];
    for (const p of st.players) {
      if (!p.alive) continue;
      const want = st.pending[p.name];
      p.dir = want && dirs[want] && want !== rev[p.dir] ? want : p.dir;
      const v = dirs[p.dir];
      nexts.set(p.name, [p.x + v[0], p.y + v[1]]);
      // Instrumentation: whether this tick's direction was the player's own
      // submitted move or the clock carrying them straight. Without it, a
      // resolved tick cannot be told apart from a played one after the fact.
      attribution.push({ name: p.name, dir: p.dir, submitted: !!want, at: want ? (st.pending_at || {})[p.name] || null : null });
    }
    const targets = new Map();
    for (const cell of nexts.values()) { const k = cell[0] + "," + cell[1]; targets.set(k, (targets.get(k) || 0) + 1); }
    const deaths = [];
    for (const p of st.players) {
      if (!p.alive) continue;
      const cell = nexts.get(p.name);
      const k = cell[0] + "," + cell[1];
      if (cell[0] < 0 || cell[1] < 0 || cell[0] >= st.w || cell[1] >= st.h || occ.has(k) || targets.get(k) > 1) deaths.push(p);
    }
    for (const p of st.players) {
      if (!p.alive || deaths.indexOf(p) >= 0) continue;
      const cell = nexts.get(p.name);
      p.x = cell[0];
      p.y = cell[1];
      st.trails.push([p.x, p.y, st.players.indexOf(p)]);
    }
    st.tick += 1;
    st.pending = {};
    st.pending_at = {};
    if (!st.move_stats) st.move_stats = {};
    if (!st.move_log) st.move_log = [];
    for (const a of attribution) {
      const s = st.move_stats[a.name] || (st.move_stats[a.name] = { submitted: 0, defaulted: 0 });
      if (a.submitted) s.submitted++; else s.defaulted++;
      // The latency record: when a played move actually arrived, and when
      // the tick resolved. A night of matches is its own dataset - without
      // these stamps the log had to be correlated against room posts by hand.
      st.move_log.push({ tick: st.tick, name: a.name, dir: a.dir, submitted: a.submitted, at: a.at, resolved_at: resolvedAt });
    }
    st.log.push({ tick: st.tick, text: "Tick " + st.tick + ": " + attribution.map((a) => a.name + " " + a.dir + (a.submitted ? " (submitted)" : " (clock default)")).join("; ") + "." });
    // Has anyone gone out before this tick? (Older matches carry no flag:
    // a rider already down, or a credited keeper, says the same.)
    const firstOutDecided = !!st.first_out_decided || !!st.record_keeper || st.players.some((p) => !p.alive);
    const outs = deaths.slice();
    for (const p of deaths) {
      p.alive = false;
      st.log.push({ tick: st.tick, text: p.name + " is out at tick " + st.tick + " - the trail holds at (" + p.x + ", " + p.y + ")." });
    }
    // Absence rule (2026-11-12): a rider the clock carries for three
    // ticks in a row is taken out. Without it an async match with one
    // absent rider burns the full stall cap on every tick - some 19
    // hours on the 2-player grid - riding straight the whole way.
    // It never decides a match the tick's own deaths already ended.
    if (!st.absent_streak) st.absent_streak = {};
    for (const a of attribution) st.absent_streak[a.name] = a.submitted ? 0 : (st.absent_streak[a.name] || 0) + 1;
    if (st.players.filter((p) => p.alive).length > 1) {
      for (const p of st.players) {
        if (p.alive && (st.absent_streak[p.name] || 0) >= 3) {
          p.alive = false;
          outs.push(p);
          st.log.push({ tick: st.tick, text: p.name + " is taken out - three ticks in a row without a submitted move." });
        }
      }
    }
    // The record keeper is the first rider out, crash or absence alike.
    // The first tick with any out decides it for good: one rider out
    // keeps the record, several out together leave it with nobody (a
    // later crash used to be credited after a pile-up - sweep, 2026-11-19).
    if (!firstOutDecided && outs.length) {
      st.first_out_decided = true;
      if (outs.length === 1) st.record_keeper = outs[0].name;
    }
    const alive = st.players.filter((p) => p.alive);
    if (alive.length <= 1) {
      g.status = "finished";
      st.winner = alive.length ? alive[0].name : null;
      st.log.push({ tick: st.tick, text: alive.length ? alive[0].name + " takes the grid." : "No survivors - the grid keeps itself." });
    }
  },
};
