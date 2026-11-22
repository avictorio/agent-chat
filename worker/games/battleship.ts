// Battleship: hidden fleets, one shot a turn on a slow clock; duels or free-for-all.

import { clockWords, seatAccepted } from "./shared.js";
import type { BattleshipBoard, BattleshipLogLine, BattleshipMove, BattleshipShot, BattleshipShotResult, BattleshipSonar, BattleshipState, BattleshipSunkShip, BattleshipYou } from "@chat/contract";
import type { GmRow, Room } from "../room/Room.js";
import type { GameRow } from "../room/games.js";
import type { GameEngineOf } from "./engine.js";
import type { Body } from "../lib/http.js";

/** A ship as stored: its cells and the ones hit, as board keys ("x,y",
 *  bsKey), and in a free-for-all who fired the shell that sank it. */
export type BsShip = { size: number, cells: string[], hits: string[], sunk_by?: string };
/** A shot record against one board, by key: hit or miss. */
export type BsShotMap = Record<string, BattleshipShotResult>;
/** A captain as stored. fleet is null until placed; shots is the one shot
 *  map of the two-captain game, shots_by the free-for-all's map per target
 *  (bsShotMap); eliminated (free-for-all) is missing on matches from before
 *  it (2026-11-17). */
export type BsCaptain = { name: string, color: string, hex: string, fleet: BsShip[] | null, shots: BsShotMap, shots_by?: Record<string, BsShotMap>, eliminated?: boolean };
/** Battleship's stored match state (g.st; the API's BattleshipState is
 *  built from it). turn_of is null in setup; misses counts each captain's
 *  expired turns in a row. Matches from before the variants (2026-11-11)
 *  have no fleet_sizes or variant (read with their defaults); last_move,
 *  shots, eliminated, own_turns and salvo_turn appear as play adds them. */
export type BsSt = {
  type: "battleship",
  w: number,
  h: number,
  fleet_sizes?: number[],
  variant?: "classic" | "salvo" | "skirmish",
  salvo_left: number | null,
  sonar: BattleshipSonar | null,
  tick_seconds: number,
  turn: number,
  phase: "setup" | "play",
  turn_of: string | null,
  deadline: number | null,
  lobby_deadline: number,
  accepted: Record<string, boolean>,
  players: BsCaptain[],
  misses: Record<string, number>,
  eliminated?: string[],
  log: BattleshipLogLine[],
  last_move?: BattleshipMove,
  shots?: BattleshipShot[],
  own_turns?: Record<string, number>,
  salvo_turn?: { turn: number, rivals: number, targets: string[], fired: number },
  winner: string | null,
  announced: boolean,
  declined_by?: string,
  ended?: number,
};
/** A Battleship match: its gm row with the state typed. */
export type BsGame = Omit<GameRow, "st"> & { st: BsSt };

/* ---------- games: Battleship ----------
   The slow game, added 2026-11-10 from the room's latency debate:
   two players, hidden fleets on a 10x10 board, alternating single
   shots on a generous clock (an hour by default) - a match is
   meant to breathe across a day of wakes, not race. Placement is
   one call (an explicit layout or "random"); a fleet is secret the
   way a duel throw is secret: every view shows only that it
   exists, plus what fired shots have publicly revealed. A turn
   clock that expires passes the turn; three missed turns in a row
   forfeit the match. Setup runs on a clock too: a fleet still
   unplaced when it fires is placed at random, so a slow placer
   costs nobody the match.

   Free-for-all (2026-11-17, the room's spec, Ada/SHA consensus):
   3-6 captains, each with their own secret board and the classic
   fleet. Turns rotate in seat order; a shot names its target
   ("Name:Cell") because a captain's shot record is per-target in
   FFA (player.shots_by) where the two-player game keeps one map
   (player.shots). Sinking a captain's last ship eliminates them -
   their board freezes as a public wreck - and the last fleet
   floating wins. Salvo volleys may split across targets but must
   spread (see battleshipMove). Endgame sonar hunts the leader
   instead of the last ship (see bsBeginTurn). Everything below
   branches on st.players.length > 2 only where FFA truly differs;
   the two-player paths keep their exact behavior. */
export const BattleshipMethods = {
  bsKey(x: number, y: number) { return x + "," + y; },

  /** @param key a board key, "x,y" */
  bsLabel(key: string) {
    const p = String(key).split(",");
    return String.fromCharCode(65 + Number(p[0])) + (Number(p[1]) + 1);
  },

  /** A cell label ("C5") as [x, y], or null. */
  bsParseCell(s: unknown): [number, number] | null {
    const m = /^([a-j])(10|[1-9])$/.exec(String(s || "").toLowerCase().trim());
    if (!m) return null;
    return [m[1].charCodeAt(0) - 97, Number(m[2]) - 1];
  },

  bsFleetSizes(st: BsSt) { return (st && st.fleet_sizes) || [5, 4, 3, 3, 2]; },

  // An FFA shot "Name:Cell" -> { target, cellPart }, or null. Every colon
  // is a candidate split, so a captain whose name holds a colon (older
  // names could) is still reachable; a split whose remainder parses as a
  // cell wins.
  bsTargetOf(st: BsSt, entry: string) {
    let best: { target: BsCaptain, cellPart: string } | null = null;
    for (let ci = entry.indexOf(":"); ci >= 0; ci = entry.indexOf(":", ci + 1)) {
      const tName = entry.slice(0, ci).trim().toLowerCase();
      const p = st.players.find((q) => q.name.toLowerCase() === tName);
      if (!p) continue;
      const cand = { target: p, cellPart: entry.slice(ci + 1).trim() };
      if (this.bsParseCell(cand.cellPart)) return cand;
      if (!best) best = cand;
    }
    return best;
  },

  // A placement example that is valid on this board: one ship per odd
  // row from column A, in fleet order. (The hardcoded classic example
  // named five ships and a cell off the 8x8 skirmish board, so copying
  // it there failed with a 400 - games review, 2026-11-12.)
  bsExample(st: BsSt) {
    return this.bsFleetSizes(st).map((s, i) => "A" + (2 * i + 1) + "H").join(",");
  },

  // A placement is one entry per ship in fleet order (5, 4, 3, 3, 2 on
  // the classic board; 4, 3, 3, 2 on the 8x8 skirmish), each a start
  // cell plus H or V: "A1H,C3V,E5H,G7V,I9H".
  /** @param spec the placement, as sent */
  bsPlacement(spec: unknown, st: BsSt) {
    const sizes = this.bsFleetSizes(st);
    const bw = (st && st.w) || 10, bh = (st && st.h) || 10;
    const parts = String(spec || "").split(",").map((s) => s.trim()).filter(Boolean);
    if (parts.length !== sizes.length) return { error: "place all " + sizes.length + " ships, in fleet order (" + sizes.join(", ") + "): e.g. " + this.bsExample(st) + " - or answer random" };
    const used: Record<string, boolean> = {};
    const fleet: BsShip[] = [];
    for (let i = 0; i < sizes.length; i++) {
      const m = /^([a-j](?:10|[1-9]))([hv])$/.exec(parts[i].toLowerCase());
      if (!m) return { error: "bad placement entry '" + parts[i] + "' - a start cell plus H or V, e.g. A1H" };
      const at = this.bsParseCell(m[1]) as number[]; // m[1] already matched the cell pattern
      const horiz = m[2] === "h";
      const cells = [];
      for (let k = 0; k < sizes[i]; k++) {
        const x = at[0] + (horiz ? k : 0), y = at[1] + (horiz ? 0 : k);
        if (x >= bw || y >= bh) return { error: "the " + sizes[i] + "-ship at " + parts[i].toUpperCase() + " runs off the board" };
        const key = this.bsKey(x, y);
        if (used[key]) return { error: "ships overlap at " + this.bsLabel(key) };
        used[key] = true;
        cells.push(key);
      }
      fleet.push({ size: sizes[i], cells: cells, hits: [] });
    }
    return { fleet: fleet };
  },

  bsRandomFleet(st: BsSt): BsShip[] {
    const sizes = this.bsFleetSizes(st);
    const bw = (st && st.w) || 10, bh = (st && st.h) || 10;
    for (let attempt = 0; attempt < 200; attempt++) {
      const used: Record<string, boolean> = {};
      const fleet: BsShip[] = [];
      let ok = true;
      for (const size of sizes) {
        let placed = false;
        for (let t = 0; t < 100 && !placed; t++) {
          const horiz = Math.random() < 0.5;
          const x = Math.floor(Math.random() * bw), y = Math.floor(Math.random() * bh);
          const cells = [];
          let good = true;
          for (let k = 0; k < size; k++) {
            const cx = x + (horiz ? k : 0), cy = y + (horiz ? 0 : k);
            if (cx >= bw || cy >= bh || used[this.bsKey(cx, cy)]) { good = false; break; }
            cells.push(this.bsKey(cx, cy));
          }
          if (good) { for (const c of cells) used[c] = true; fleet.push({ size: size, cells: cells, hits: [] }); placed = true; }
        }
        if (!placed) { ok = false; break; }
      }
      if (ok) return fleet;
    }
    // Practically unreachable with these fleets; a fixed open layout
    // (one ship per odd row, from column A) beats no fleet at all.
    // (the fixed layout always fits, so it parses)
    return this.bsPlacement(sizes.map((s, i) => "A" + (1 + i * 2) + "H").join(","), st).fleet as BsShip[];
  },

  bsShipAt(player: BsCaptain, key: string) {
    if (!player.fleet) return null;
    for (const ship of player.fleet) if (ship.cells.indexOf(key) >= 0) return ship;
    return null;
  },

  bsAfloat(player: BsCaptain | null | undefined) {
    if (!player || !player.fleet) return 0;
    return player.fleet.filter((s) => s.hits.length < s.size).length;
  },

  // Free-for-all helpers (2026-11-17). A match is FFA when it seats
  // more than two captains; everything else is the original game.
  bsFfa(st: BsSt) { return !!st && (st.players || []).length > 2; },

  bsLiving(st: BsSt) { return (st.players || []).filter((p) => !p.eliminated); },

  // The shot map a player keeps against a target: in the
  // two-player game there is one map (player.shots); in FFA each
  // target has its own (player.shots_by[target]), because the same
  // cell fired at two different boards is two different shots.
  bsShotMap(st: BsSt, player: BsCaptain, targetName: string): BsShotMap {
    if (!this.bsFfa(st)) { if (!player.shots) player.shots = {}; return player.shots; }
    if (!player.shots_by) player.shots_by = {};
    if (!player.shots_by[targetName]) player.shots_by[targetName] = {};
    return player.shots_by[targetName];
  },

  // Every shot a player has fired, as {target, key, result} - the
  // per-player totals the summary reports.
  bsAllShots(st: BsSt, player: BsCaptain) {
    const out: Array<{ target: string | null, key: string, result: BattleshipShotResult }> = [];
    if (!this.bsFfa(st)) {
      const foe = (st.players || []).find((p) => p.name !== player.name);
      for (const k of Object.keys(player.shots || {})) out.push({ target: foe ? foe.name : null, key: k, result: player.shots[k] });
      return out;
    }
    // (a free-for-all captain has shots_by: createBattleship)
    for (const t of Object.keys(player.shots_by || {})) for (const k of Object.keys((player.shots_by as Record<string, BsShotMap>)[t])) out.push({ target: t, key: k, result: (player.shots_by as Record<string, BsShotMap>)[t][k] });
    return out;
  },

  // The next living captain in seat order after a given name
  // (wrapping around), or null when nobody else is afloat.
  bsNextLiving(st: BsSt, afterName: string) {
    const ps = st.players || [];
    const i = ps.findIndex((p) => p.name === afterName);
    for (let k = 1; k <= ps.length; k++) {
      const p = ps[(i + k) % ps.length];
      if (p && !p.eliminated && p.name !== afterName) return p;
    }
    return null;
  },

  // How many rival ships this player has sunk. Two-player: read off
  // the one rival's fleet, as always. FFA: a sinking belongs to the
  // captain whose shell finished the ship (ship.sunk_by, stamped in
  // bsApplyShot) - a hull in FFA waters can take fire from everyone.
  bsSunkBy(g: BsGame, name: string) {
    if (!this.bsFfa(g.st)) {
      const opp = g.st.players.find((p) => p.name !== name);
      if (!opp || !opp.fleet) return 0;
      return opp.fleet.filter((s) => s.hits.length >= s.size).length;
    }
    let n = 0;
    for (const p of g.st.players) {
      if (p.name === name || !p.fleet) continue;
      for (const s of p.fleet) if (s.hits.length >= s.size && s.sunk_by === name) n++;
    }
    return n;
  },

  // A turn begins (first turn, a passed turn, a clock pass): the salvo
  // count resets to the shooter's afloat ships, and the endgame sonar
  // may ping. Sonar is a visible rule, announced at creation: once both
  // captains are down to one ship, every third of the shooter's own
  // turns the referee names a
  // row or column of the waters the shooter is hunting that holds an
  // un-hit hull cell of the last ship - the hunt stays a deduction.
  bsBeginTurn(st: BsSt) {
    const shooter = st.players.find((p) => p.name === st.turn_of);
    st.salvo_left = st.variant === "salvo" && shooter ? this.bsAfloat(shooter) : null;
    st.sonar = null;
    if (this.bsFfa(st)) { this.bsBeginTurnFfa(st, shooter); return; }
    // The cadence counts the SHOOTER's own turns (every third): the
    // old turn % 6 test only ever fired on even turns, and since the
    // first shooter was fixed, that meant only players[1] ever got a
    // ping (games review, 2026-11-12).
    if (!shooter || this.bsAfloat(st.players[0]) !== 1 || this.bsAfloat(st.players[1]) !== 1 || Math.ceil(st.turn / 2) % 3 !== 0) return;
    // two captains, both placed (the play phase)
    const opp = st.players.find((p) => p.name !== shooter.name) as BsCaptain;
    const ship = (opp.fleet as BsShip[]).find((s) => s.hits.length < s.size);
    if (!ship) return;
    const open = ship.cells.filter((c) => ship.hits.indexOf(c) < 0).map((c) => c.split(",").map(Number));
    if (!open.length) return;
    const rows = [...new Set(open.map((c) => c[1]))], cols = [...new Set(open.map((c) => c[0]))];
    // The axis is a coin flip. It used to follow the ship's shape (a
    // one-column ship always drew a row ping), which read the last
    // ship's orientation straight off the ping (games review,
    // 2026-11-12); a random axis stays truthful and says nothing.
    const useRow = Math.random() < 0.5;
    const pick = useRow ? rows[Math.floor(Math.random() * rows.length)] : cols[Math.floor(Math.random() * cols.length)];
    const label = useRow ? "row " + (pick + 1) : "column " + String.fromCharCode(65 + pick);
    st.sonar = { turn: st.turn, for: shooter.name, axis: useRow ? "row" : "column", label: label };
    st.log.push({ tick: st.turn, text: "Sonar ping for " + shooter.name + ": a hull cell of " + opp.name + "'s last ship sits in " + label + " of their waters." });
  },

  // The FFA turn opening: salvo reset (done by the caller) and the
  // endgame sonar, which hunts the LEADER here (SHA's amendment to
  // the room spec, 2026-11-17). The rule, precisely: when any living
  // captain is down to exactly one ship afloat, every 6th of a
  // shooter's own turns the referee publicly pings a row or column
  // (coin flip) holding an un-hit cell of the current leader's
  // fleet. The leader is the living captain - never the shooter,
  // never a one-ship captain - with the most ships afloat; ties go
  // to the earliest seat. So the one-ship captain is never the
  // target of this rule, and when every rival is down to one ship
  // there is no leader to hunt and no ping. The cadence counts the
  // shooter's own turns (st.own_turns), like the two-player rule.
  bsBeginTurnFfa(st: BsSt, shooter: BsCaptain | undefined) {
    if (!shooter || shooter.eliminated) return;
    if (!st.own_turns) st.own_turns = {};
    st.own_turns[shooter.name] = (st.own_turns[shooter.name] || 0) + 1;
    const living = this.bsLiving(st);
    if (!living.some((p) => this.bsAfloat(p) === 1)) return;
    if (st.own_turns[shooter.name] % 6 !== 0) return;
    let leader: BsCaptain | null = null;
    for (const p of living) {
      if (p.name === shooter.name) continue;
      const af = this.bsAfloat(p);
      if (af < 2) continue;
      if (!leader || af > this.bsAfloat(leader)) leader = p;
    }
    if (!leader) return;
    // Ping an un-hit cell drawn from across the leader's whole
    // fleet (the two-player rule reads the last ship; here the hunt
    // is the fleet's shape, not one hull's).
    const open = [];
    for (const s of leader.fleet as BsShip[]) for (const c of s.cells) if (s.hits.indexOf(c) < 0) open.push(c.split(",").map(Number));
    if (!open.length) return;
    const rows = [...new Set(open.map((c) => c[1]))], cols = [...new Set(open.map((c) => c[0]))];
    const useRow = Math.random() < 0.5;
    const pick = useRow ? rows[Math.floor(Math.random() * rows.length)] : cols[Math.floor(Math.random() * cols.length)];
    const label = useRow ? "row " + (pick + 1) : "column " + String.fromCharCode(65 + pick);
    st.sonar = { turn: st.turn, for: shooter.name, target: leader.name, axis: useRow ? "row" : "column", label: label };
    st.log.push({ tick: st.turn, text: "Sonar ping for " + shooter.name + ": a hull cell of " + leader.name + "'s fleet - the leader, " + this.bsAfloat(leader) + " afloat - sits in " + label + " of their waters." });
  },

  // What anyone in the room may see of a battleship board: the fire a
  // captain has taken (the rival's own shot record, already public in
  // the counts) and the ships that are already sunk. Un-hit fleet
  // cells never leave the server - this is the spectator's board.
  bsPublicBoards(g: BsGame): BattleshipBoard[] {
    const st = g.st;
    return st.players.map((p) => {
      const incoming: BsShotMap = {};
      for (const q of st.players) {
        if (q.name === p.name) continue;
        const map = this.bsFfa(st) ? (q.shots_by || {})[p.name] || {} : q.shots || {};
        for (const k of Object.keys(map)) incoming[this.bsLabel(k)] = map[k];
      }
      const sunkShips = [];
      if (p.fleet) for (const s of p.fleet) if (s.hits.length >= s.size) sunkShips.push({ size: s.size, cells: s.cells.map((c) => this.bsLabel(c)) });
      return { name: p.name, hex: p.hex, incoming: incoming, sunk_ships: sunkShips, eliminated: !!p.eliminated };
    });
  },

  battleshipSummary(g: BsGame): BattleshipState {
    const st = g.st;
    return {
      id: g.id, type: "battleship", status: g.status, created_by: g.created_by, card_msg: g.card_msg,
      phase: g.status === "running" ? st.phase : null, turn: st.turn, turn_of: g.status === "running" && st.phase === "play" ? st.turn_of : null,
      w: st.w || 10, h: st.h || 10, variant: st.variant || "classic", fleet_sizes: st.fleet_sizes || [5, 4, 3, 3, 2], salvo_left: st.phase === "play" ? st.salvo_left : null, sonar: st.sonar || null, misses: st.misses || {},
      turn_seconds: st.tick_seconds, deadline: st.deadline, lobby_deadline: g.status === "lobby" ? (st.lobby_deadline || null) : null,
      winner: st.winner || null, declined_by: st.declined_by || null,
      last_move: st.last_move || null, boards: this.bsPublicBoards(g),
      eliminated: st.eliminated || [],
      players: st.players.map((p) => {
        const all = this.bsAllShots(st, p);
        return { name: p.name, color: p.color, hex: p.hex, accepted: st.accepted ? !!st.accepted[p.name] : true, placed: !!p.fleet, shots: all.length, hits: all.filter((s) => s.result === "hit").length, sunk: this.bsSunkBy(g, p.name), afloat: this.bsAfloat(p), eliminated: !!p.eliminated };
      }),
    };
  },

  /** @param who the viewer */
  battleshipStateFull(g: BsGame, who: string | null | undefined): BattleshipState {
    const out = this.battleshipSummary(g);
    const st = g.st;
    const ffa = this.bsFfa(st);
    out.log = st.log.slice(-220);
    out.shots = st.shots || [];
    out.awaiting = g.status !== "running" ? [] : st.phase === "setup" ? st.players.filter((p) => !p.fleet).map((p) => p.name) : [st.turn_of as string]; // set in play
    out.awaiting_accept = g.status === "lobby" ? st.players.filter((p) => !(st.accepted || {})[p.name]).map((p) => p.name) : [];
    const me = st.players.find((p) => p.name.toLowerCase() === String(who || "").toLowerCase());
    if (!me) { out.you = { playing: false }; return out; }
    const opp = st.players.find((p) => p.name !== me.name);
    const you: BattleshipYou & Required<Pick<BattleshipYou, "shots" | "incoming" | "sunk_ships">> = {
      playing: true, accepted: st.accepted ? !!st.accepted[me.name] : true, phase: g.status === "running" ? st.phase : null,
      your_turn: g.status === "running" && st.phase === "play" && st.turn_of === me.name,
      eliminated: !!me.eliminated,
      fleet: me.fleet ? me.fleet.map((s) => ({ size: s.size, cells: s.cells.map((c) => this.bsLabel(c)), hits: s.hits.map((c) => this.bsLabel(c)), sunk: s.hits.length >= s.size })) : null,
      shots: {}, incoming: {}, sunk_ships: [] as BattleshipSunkShip[], opponent_afloat: ffa ? null : this.bsAfloat(opp),
      legal_moves: [] as string[],
    };
    if (ffa) {
      // FFA: your record is per target - one entry per rival with
      // your shots at their waters, the ships of theirs you have
      // seen sink, and how much of their fleet still floats.
      you.targets = st.players.filter((p) => p.name !== me.name).map((t) => {
        const map = (me.shots_by || {})[t.name] || {};
        const shots: BsShotMap = {};
        for (const k of Object.keys(map)) shots[this.bsLabel(k)] = map[k];
        const sunkShips = [];
        if (t.fleet) for (const s of t.fleet) if (s.hits.length >= s.size) sunkShips.push({ size: s.size, cells: s.cells.map((c) => this.bsLabel(c)) });
        return { name: t.name, hex: t.hex, eliminated: !!t.eliminated, afloat: this.bsAfloat(t), shots: shots, sunk_ships: sunkShips };
      });
      // The fire your own waters have taken, from every rival.
      for (const q of st.players) {
        if (q.name === me.name) continue;
        const map = (q.shots_by || {})[me.name] || {};
        for (const k of Object.keys(map)) you.incoming[this.bsLabel(k)] = map[k];
      }
    } else {
      for (const k of Object.keys(me.shots || {})) you.shots[this.bsLabel(k)] = me.shots[k];
      if (opp) for (const k of Object.keys(opp.shots || {})) you.incoming[this.bsLabel(k)] = opp.shots[k];
      if (opp && opp.fleet) for (const s of opp.fleet) if (s.hits.length >= s.size) you.sunk_ships.push({ size: s.size, cells: s.cells.map((c) => this.bsLabel(c)) });
    }
    if (g.status === "running" && st.phase === "setup" && !me.fleet) you.legal_moves = ["place: " + this.bsExample(st) + " (fleet order " + this.bsFleetSizes(st).join(",") + ") or place: random"];
    if (g.status === "running" && st.phase === "play" && you.your_turn && !me.eliminated) {
      // The open cells themselves, as a list a woken player can pick
      // from directly - the old sentence form forced them to
      // reconstruct the board from their shot map first (games
      // review, 2026-11-12). The salvo count rides in salvo_left.
      // FFA entries name their target ("Rex:C5"): the same cell on
      // two different boards is two different legal shots.
      const open = [];
      const targets = ffa ? st.players.filter((p) => p.name !== me.name && !p.eliminated) : [opp];
      for (const t of targets) {
        if (!t) continue;
        const map = ffa ? (me.shots_by || {})[t.name] || {} : me.shots || {};
        for (let y = 0; y < st.h; y++) for (let x = 0; x < st.w; x++) { const k = this.bsKey(x, y); if (!map[k]) open.push(ffa ? t.name + ":" + this.bsLabel(k) : this.bsLabel(k)); }
      }
      you.legal_moves = open;
    }
    out.you = you;
    return out;
  },

  /** @param opts the create's options (variant, tick_seconds, lobby_seconds) */
  async createBattleship(creator: string, playersIn: unknown[], opts: Body, room: string) {
    if (!Array.isArray(playersIn) || playersIn.length < 2 || playersIn.length > 6) return { status: 400, error: "battleship needs 2 to 6 players" };
    const resolved = this.gamePlayers(playersIn);
    if (resolved.error) return resolved;
    const names = resolved.names as string[]; // gamePlayers sets names whenever it sets no error
    const ffa = names.length > 2;
    // tick_seconds is the per-turn clock here, and the setup clock.
    // An hour by default: this game is built for players who wake on
    // other people's schedules (2026-11-10, the room's latency debate).
    let turnSeconds = Math.floor(Number(opts && opts.tick_seconds) || 0);
    if (!turnSeconds) turnSeconds = 3600;
    turnSeconds = Math.min(86400, Math.max(30, turnSeconds));
    // Variants (2026-11-11, the design review's pace package): salvo
    // fires one shot per ship the shooter still has afloat, each turn;
    // skirmish compresses the loop onto an 8x8 board with a 4,3,3,2
    // fleet. Classic is the 10x10 game the room knows.
    const variant = (["salvo", "skirmish"].indexOf(String((opts && opts.variant) || "").toLowerCase()) >= 0 ? String(opts.variant).toLowerCase() : "classic") as "classic" | "salvo" | "skirmish";
    // Skirmish is the compressed two-captain duel; a free-for-all
    // plays the full board (classic or salvo).
    if (ffa && variant === "skirmish") return { status: 400, error: "skirmish is a two-captain variant - a free-for-all (3+ players) plays classic or salvo" };
    const bw = variant === "skirmish" ? 8 : 10;
    const fleetSizes = variant === "skirmish" ? [4, 3, 3, 2] : [5, 4, 3, 3, 2];
    const colors = this.gameColors();
    const players = names.map((n, i) => {
      const p: BsCaptain = { name: n, color: colors[i].color, hex: colors[i].hex, fleet: null, shots: {}, eliminated: false };
      if (ffa) p.shots_by = {};
      return p;
    });
    const st: BsSt = {
      type: "battleship", w: bw, h: bw, fleet_sizes: fleetSizes, variant: variant, salvo_left: null, sonar: null, tick_seconds: turnSeconds, turn: 0, phase: "setup", turn_of: null,
      deadline: null, lobby_deadline: Date.now() + this.lobbySeconds(opts) * 1000, accepted: this.lobbyAccepted(creator, names), players: players,
      misses: {}, eliminated: [], log: [{ tick: 0, text: ffa ? "Battleship free-for-all created by " + creator + " - " + names.join(", ") + ". Fleets are placed once every captain accepts." : "Battleship created by " + creator + " - " + names.join(" vs ") + ". Fleets are placed once both players accept." }],
      winner: null, announced: false,
    };
    const ins = this.sql.exec<Pick<GmRow, "id">>("INSERT INTO gm (status, created, created_by, state) VALUES ('lobby', ?, ?, ?) RETURNING id", Date.now(), creator, JSON.stringify(st)).one();
    const g = this.gameRowOf<BsSt>(ins.id, "battleship")!; // the row just inserted
    const label = players.map((p) => p.name + " (" + p.color + ")").join(ffa ? ", " : " vs ");
    const boardText = variant === "skirmish" ? "Skirmish: 8x8, fleets of four (4, 3, 3, 2)" : variant === "salvo" ? "Salvo: 10x10, fleets of five (5, 4, 3, 3, 2) - each turn fires one shot per ship you still have afloat" : "10x10, fleets of five (5, 4, 3, 3, 2)";
    const cardText = ffa
      ? "Battleship free-for-all #" + g.id + " - " + label + ". " + boardText + " - every captain for themselves: on your turn, fire at any one rival's waters (salvo volleys split across rivals, but must spread). Last fleet floating wins. Turn clock: " + (turnSeconds >= 3600 ? Math.round(turnSeconds / 3600) + " h" : Math.max(1, Math.round(turnSeconds / 60)) + " min") + ". Lobby open - the match starts when every captain accepts; tap the card to take your seat."
      : "Battleship match #" + g.id + " - " + label + ". " + boardText + ". Turn clock: " + (turnSeconds >= 3600 ? Math.round(turnSeconds / 3600) + " h" : Math.max(1, Math.round(turnSeconds / 60)) + " min") + ". Lobby open - the match starts when both players accept; tap the card to take your seat.";
    const msg = await this.postGameCard(creator, cardText, g.id, room);
    this.sql.exec("UPDATE gm SET card_msg = ? WHERE id = ?", msg.id, g.id);
    g.card_msg = msg.id;
    this.broadcastGame(g, room, creator);
    await this.armGameAlarm();
    return { status: 201, game: this.battleshipStateFull(g, creator) };
  },

  // Apply one shot whose cell has already been validated. Records it
  // in the shooter's shot map, the narrative log, last_move, and the
  // untrimmed st.shots record - which carries a timestamp per shot,
  // because the narrative log trims past 240 entries and had no times
  // at all, so match length and turn latency were unmeasurable
  // (games review, 2026-11-12).
  /**
   * @param me the shooter
   * @param opp whose waters the shot lands in
   * @param key the cell's board key
   */
  bsApplyShot(st: BsSt, me: BsCaptain, opp: BsCaptain, key: string) {
    const ship = this.bsShipAt(opp, key);
    const map = this.bsShotMap(st, me, opp.name);
    /** the size of the ship this shot sinks */
    let sunkSize: number | null = null;
    if (ship) {
      map[key] = "hit";
      ship.hits.push(key);
      if (ship.hits.length >= ship.size) { sunkSize = ship.size; ship.sunk_by = me.name; }
    } else {
      map[key] = "miss";
    }
    const at = this.bsFfa(st) ? " at " + opp.name : "";
    const note = sunkSize
      ? me.name + " fires " + this.bsLabel(key) + at + " - hit, and " + opp.name + "'s " + (ship as BsShip).size + "-ship is sunk."
      : me.name + " fires " + this.bsLabel(key) + at + " - " + (ship ? "hit." : "miss.");
    st.last_move = { by: me.name, target: opp.name, cell: this.bsLabel(key), result: ship ? "hit" : "miss", sunk: sunkSize, turn: st.turn };
    st.log.push({ tick: st.turn, text: note, by: me.name, target: opp.name, cell: this.bsLabel(key), result: ship ? "hit" : "miss", sunk: sunkSize });
    if (!st.shots) st.shots = [];
    st.shots.push({ by: me.name, target: opp.name, cell: this.bsLabel(key), result: ship ? "hit" : "miss", sunk: sunkSize, turn: st.turn, at: Date.now() });
    return { won: this.bsAfloat(opp) === 0 };
  },

  // One call per phase: in setup, dir carries the placement (or
  // "random"); in play, it carries the shot ("C5", "fire: C5") - or,
  // in a salvo match, the whole volley as a comma list ("C5,D6,E7").
  // Each shot resolves the moment it lands - there is nothing to queue.
  /** @param raw the placement or the shot(s), as sent */
  async battleshipMove(g: BsGame, who: string, raw: unknown, room: string) {
    const st = g.st;
    const me = st.players.find((p) => p.name.toLowerCase() === String(who || "").toLowerCase());
    if (!me) return { status: 403, error: "You are not a player in this match" };
    // every match seats two or more, so there is always another captain
    const opp = st.players.find((p) => p.name !== me.name) as BsCaptain;
    const s = String(raw || "").trim().toLowerCase();
    if (st.phase === "setup") {
      if (me.fleet) return { status: 409, error: "Your fleet is already placed" };
      let spec = s;
      if (spec.indexOf("place:") === 0) spec = spec.slice(6).trim();
      if (spec.indexOf("place ") === 0) spec = spec.slice(6).trim();
      let fleet: Array<{ size: number, cells: string[], hits: string[] }> | null | undefined = null;
      if (spec === "random" || spec === "auto" || spec === "") {
        fleet = this.bsRandomFleet(st);
      } else {
        const r = this.bsPlacement(spec, st);
        if (r.error) return { status: 400, error: r.error, legal_moves: ["place: " + this.bsExample(st) + " (fleet order " + this.bsFleetSizes(st).join(",") + ") or place: random"] };
        fleet = r.fleet;
      }
      me.fleet = (fleet as BsShip[]); // random, or a placement that parsed
      st.log.push({ tick: st.turn, text: me.name + " has placed their fleet." });
      let resolved = false;
      if (st.players.every((p) => p.fleet)) {
        st.phase = "play";
        // The first shot is a coin flip (2026-11-12): players[0] used
        // to fire first in every match, in an order the creator chose.
        st.turn_of = st.players[Math.floor(Math.random() * st.players.length)].name;
        st.turn = 1;
        st.deadline = Date.now() + st.tick_seconds * 1000;
        st.log.push({ tick: st.turn, text: "Both fleets are down - " + st.turn_of + " fires first." });
        this.bsBeginTurn(st);
        resolved = true;
      }
      this.saveGame(g);
      this.afterGameChange(g, room, who);
      await this.armGameAlarm();
      return { status: 200, game: this.battleshipStateFull(g, who), resolved: resolved };
    }
    if (st.turn_of !== me.name) return { status: 409, error: "It is " + st.turn_of + "'s turn to fire" };
    if (me.eliminated) return { status: 409, error: "You are eliminated - your fleet is a wreck chart now" };
    const ffa = this.bsFfa(st);
    let cell = s;
    // One optional verb, stripped once - and not when the text already
    // starts with a captain's target (a captain named "Fire Ant" is
    // targeted as "Fire Ant:C5"; stripping "fire " made that "ant:C5").
    const verb = /^(fire:|shoot:|fire\s+)\s*/.exec(cell);
    if (verb && !(ffa && this.bsTargetOf(st, cell.split(",")[0].trim()))) cell = cell.slice(verb[0].length).trim();
    // A salvo turn may arrive as ONE call carrying the whole volley
    // ("C5,D6,E7"). Shots after the first never changed the awaited
    // turn, so a wake-driven player was never re-woken for them, and
    // the list form was refused outright (games review, 2026-11-12).
    // The whole list is validated before anything fires.
    // In a free-for-all every entry names its target - "Rex:C5" -
    // because the same cell on two boards is two different shots;
    // a salvo volley may split across targets.
    const cells = cell.split(",").map((c) => c.trim()).filter(Boolean);
    const openHint = [ffa ? "fire: any living rival's open cell as Name:Cell, e.g. fire: " + ((this.bsLiving(st).find((p) => p.name !== me.name) || {}).name || "Rex") + ":C5" : "fire: any cell A1-" + this.bsLabel(this.bsKey(st.w - 1, st.h - 1)) + " you have not fired at yet, e.g. fire: C5"];
    const badCell = { status: 400, error: ffa ? "fire as Name:Cell at a living rival, e.g. Rex:C5" : "fire at a cell, A1 to " + this.bsLabel(this.bsKey(st.w - 1, st.h - 1)) + " - e.g. C5", legal_moves: openHint };
    if (!cells.length) return badCell;
    if (cells.length > 1 && st.variant !== "salvo") return { status: 400, error: "One shot per call in " + (st.variant || "classic") + " - a comma list is a salvo volley (variant salvo only)", legal_moves: openHint };
    const salvoLeft = st.variant === "salvo" ? (st.salvo_left == null ? this.bsAfloat(me) : st.salvo_left) : 1;
    if (cells.length > salvoLeft) return { status: 400, error: cells.length + " shots in one call - you have " + salvoLeft + " left this turn", legal_moves: openHint };
    const entries: Array<{ opp: BsCaptain, key: string }> = [];
    const seen: Record<string, boolean> = {};
    for (const c of cells) {
      let target = opp, cellPart = c;
      if (ffa) {
        const ci = c.indexOf(":");
        if (ci < 0) return { status: 400, error: "in a free-for-all every shot names its target - '" + c + "' should look like Rex:C5", legal_moves: openHint };
        const tt = this.bsTargetOf(st, c);
        if (!tt) return { status: 400, error: "'" + c.slice(0, ci).trim() + "' is not a captain in this match", legal_moves: openHint };
        target = tt.target;
        cellPart = tt.cellPart;
        if (target.name === me.name) return { status: 400, error: "You cannot fire at your own waters", legal_moves: openHint };
        if (target.eliminated) return { status: 400, error: target.name + " is eliminated - their board is a wreck chart, not a target", legal_moves: openHint };
      }
      const at = this.bsParseCell(cellPart);
      if (!at || at[0] >= st.w || at[1] >= st.h) return badCell;
      const key = this.bsKey(at[0], at[1]);
      const map = this.bsShotMap(st, me, target.name);
      if (map[key]) return { status: 400, error: "You have already fired at " + this.bsLabel(key) + (ffa ? " on " + target.name + "'s board" : "") + " (" + map[key] + ")" };
      const seenKey = target.name + "|" + key;
      if (seen[seenKey]) return { status: 400, error: this.bsLabel(key) + " at " + target.name + " appears twice in the volley" };
      seen[seenKey] = true;
      entries.push({ opp: target, key: key });
    }
    // The FFA salvo spread rule (room consensus, 2026-11-17): a
    // volley must name at least min(shells, living rivals) DISTINCT
    // targets - with three or more captains afloat you cannot dump
    // a whole salvo on one board. Extra shells beyond one per
    // required target may go anywhere legal. One living rival (or
    // the two-player game) carries no spread constraint.
    // The rule holds across the whole turn, not per call: a volley sent
    // one shell per call used to pass every check and land on one board
    // (sweep, 2026-11-19). st.salvo_turn keeps the turn's targets and
    // shells so far; rivals is the count afloat when the turn began
    // (a rival sunk mid-turn was a target, so still counts as one).
    let salvoTurn: { turn: number, rivals: number, targets: string[], fired: number } | null = null;
    if (ffa && st.variant === "salvo") {
      const prevTurn = st.salvo_turn && st.salvo_turn.turn === st.turn ? st.salvo_turn : null;
      const rivals = prevTurn ? prevTurn.rivals : this.bsLiving(st).filter((p) => p.name !== me.name).length;
      const distinct = new Set(prevTurn ? prevTurn.targets : []);
      for (const e of entries) distinct.add(e.opp.name);
      const firedAfter = (prevTurn ? prevTurn.fired : 0) + entries.length;
      const need = Math.min(firedAfter, rivals);
      if (distinct.size < need) {
        const hit = prevTurn && prevTurn.targets.length ? " (this turn so far: " + prevTurn.targets.join(", ") + ")" : "";
        return { status: 400, error: "a free-for-all salvo must spread: " + firedAfter + " shells this turn with " + rivals + " rivals afloat must name at least " + need + " different targets - one shell per rival first, extra shells anywhere" + hit, legal_moves: openHint };
      }
      salvoTurn = { turn: st.turn, rivals: rivals, targets: Array.from(distinct), fired: firedAfter };
    }
    if (salvoTurn) st.salvo_turn = salvoTurn;
    let fired = 0;
    let won = false;
    for (const e of entries) {
      // A target eliminated earlier in this same volley is a wreck
      // before the later shells arrive: those shells are spent on
      // water that is no longer a target and are simply lost.
      if (e.opp.eliminated) { fired++; continue; }
      const r = this.bsApplyShot(st, me, e.opp, e.key);
      fired++;
      if (r.won) {
        if (!ffa) { won = true; break; }
        e.opp.eliminated = true;
        if (!st.eliminated) st.eliminated = [];
        st.eliminated.push(e.opp.name);
        st.log.push({ tick: st.turn, text: e.opp.name + "'s last ship is gone - " + e.opp.name + " is eliminated (" + st.eliminated.length + " of " + (st.players.length - 1) + " out). Their board is a wreck chart now." });
        if (this.bsLiving(st).length <= 1) { won = true; break; }
      }
    }
    if (!st.misses) st.misses = {};
    st.misses[me.name] = 0;
    if (won) {
      g.status = "finished";
      st.winner = ffa ? this.bsLiving(st)[0].name : me.name;
      st.log.push({ tick: st.turn, text: ffa ? st.winner + " takes the sea - the last fleet floating." : me.name + " sinks the last ship and takes the sea." });
    } else if (st.variant === "salvo" && (st.salvo_left = (st.salvo_left == null ? this.bsAfloat(me) : st.salvo_left) - fired) > 0) {
      // Salvo: the turn holds until the shooter's shots run out - one
      // per ship they still have afloat, counted at the turn's start.
      // The turn clock does not extend; a salvo is one decision window.
    } else if (ffa) {
      const nxt = this.bsNextLiving(st, me.name);
      st.turn_of = nxt ? nxt.name : me.name;
      st.turn += 1;
      st.deadline = Date.now() + st.tick_seconds * 1000;
      this.bsBeginTurn(st);
    } else {
      st.turn_of = opp.name;
      st.turn += 1;
      st.deadline = Date.now() + st.tick_seconds * 1000;
      this.bsBeginTurn(st);
    }
    this.saveGame(g);
    this.afterGameChange(g, room, who);
    await this.armGameAlarm();
    return { status: 200, game: this.battleshipStateFull(g, who), resolved: true };
  },

  // The battleship clock, in both phases: a setup that expires places
  // the missing fleets at random (placement is busywork - nobody
  // loses a match to it), and a play turn that expires passes to the
  // rival. Three missed turns in a row forfeit the match to the
  // player who is actually at the table. Catch-up anchors each new
  // deadline to the expired one, like Light Cycles, so a long sleep
  // burns the turns it slept through rather than restarting them.
  advanceBattleship(g: BsGame | null, room: string) {
    if (!g || g.status !== "running") return;
    const st = g.st;
    let changed = false;
    let guard = 0;
    while (g.status === "running" && st.deadline && Date.now() >= st.deadline && guard < 64) {
      guard++;
      changed = true;
      if (st.phase === "setup") {
        for (const p of st.players) if (!p.fleet) { p.fleet = this.bsRandomFleet(st); st.log.push({ tick: st.turn, text: p.name + "'s fleet was placed at random - no placement arrived before the clock." }); }
        st.phase = "play";
        st.turn_of = st.players[Math.floor(Math.random() * st.players.length)].name;
        st.turn = 1;
        st.log.push({ tick: st.turn, text: "Both fleets are down - " + st.turn_of + " fires first." });
        this.bsBeginTurn(st);
        st.deadline = st.deadline + st.tick_seconds * 1000;
      } else {
        const cur = st.players.find((p) => p.name === st.turn_of) || st.players[0];
        if (!st.misses) st.misses = {};
        st.misses[cur.name] = (st.misses[cur.name] || 0) + 1;
        if (st.misses[cur.name] >= 3) {
          // Three expired turns in a row - the forfeit counts silent
          // turns, never shot outcomes. What it costs depends on the
          // table: if every other living captain is also at two or
          // more, the match is abandoned, not won; with exactly one
          // rival left standing it is a forfeit win (the two-player
          // rule, unchanged); in a free-for-all with captains still
          // playing, the silent captain is eliminated and the sea
          // fights on without them.
          const others = this.bsLiving(st).filter((p) => p.name !== cur.name);
          if (others.length && others.every((p) => (st.misses[p.name] || 0) >= 2)) {
            g.status = "finished";
            st.winner = null;
            st.log.push({ tick: st.turn, text: this.bsFfa(st)
              ? cur.name + " missed three turns in a row - and every captain still afloat has missed at least two as well. The whole table has abandoned the sea - no winner."
              : cur.name + " missed three turns in a row - but " + others[0].name + " has missed " + st.misses[others[0].name] + " too. Both captains have abandoned the sea - no winner." });
          } else if (others.length === 1) {
            g.status = "finished";
            st.winner = others[0].name;
            st.log.push({ tick: st.turn, text: cur.name + " missed three turns in a row - " + others[0].name + " takes the sea by forfeit." });
          } else {
            cur.eliminated = true;
            if (!st.eliminated) st.eliminated = [];
            st.eliminated.push(cur.name);
            st.log.push({ tick: st.turn, text: cur.name + " missed three turns in a row and is eliminated by forfeit (" + st.eliminated.length + " of " + (st.players.length - 1) + " out). The sea fights on." });
            const nxt = this.bsNextLiving(st, cur.name);
            st.turn_of = nxt ? nxt.name : cur.name;
            st.turn += 1;
            this.bsBeginTurn(st);
            st.deadline = st.deadline + st.tick_seconds * 1000;
          }
        } else {
          const nxt = this.bsFfa(st) ? this.bsNextLiving(st, cur.name) : st.players.find((p) => p.name !== cur.name);
          st.log.push({ tick: st.turn, text: cur.name + " let the turn clock run out (" + st.misses[cur.name] + " missed in a row) - the turn passes." });
          st.turn_of = nxt ? nxt.name : cur.name;
          st.turn += 1;
          this.bsBeginTurn(st);
          st.deadline = st.deadline + st.tick_seconds * 1000;
        }
      }
    }
    if (changed) {
      this.saveGame(g);
      this.afterGameChange(g, room, "Referee");
    }
  },

  battleshipResultText(g: BsGame) {
    if (g.st.players.length > 2) {
      // Free-for-all: name the winner, the elimination order,
      // and every captain's totals.
      const sunkRows = g.st.players.map((p) => p.name + " " + this.bsSunkBy(g, p.name)).join(", ");
      const hitRows = g.st.players.map((p) => p.name + " " + this.bsAllShots(g.st, p).filter((s) => s.result === "hit").length).join(", ");
      const order = (g.st.eliminated || []).slice();
      return "Battleship free-for-all #" + g.id + " is over - " + (g.st.winner ? g.st.winner + " takes the sea, the last fleet floating." : "no winner; the whole table abandoned the sea.") + (order.length ? " Elimination order: " + order.join(", ") + "." : "") + " Ships sunk: " + sunkRows + ". Hits: " + hitRows + ".";
    }
    const ba = g.st.players[0], bb = g.st.players[1];
    const hitsOf = (p: BsCaptain) => Object.values(p.shots || {}).filter((v) => v === "hit").length;
    return "Battleship match #" + g.id + " is over - " + (g.st.winner ? g.st.winner + " takes the sea over " + (g.st.winner === ba.name ? bb.name : ba.name) + "." : "no winner.") + " Ships sunk: " + ba.name + " " + this.bsSunkBy(g, ba.name) + ", " + bb.name + " " + this.bsSunkBy(g, bb.name) + ". Hits: " + ba.name + " " + hitsOf(ba) + ", " + bb.name + " " + hitsOf(bb) + ".";
  },
} satisfies ThisType<Room>;

export const battleshipEngine = {
  name: "Battleship",
  turnWord: "turn",
  logTick: (st: BsSt) => st.turn,
  clockSeconds: (st: BsSt) => st.tick_seconds,
  create: (room, creator, players, opts, roomName) => room.createBattleship(creator, players, opts, roomName),
  summary: (room, g) => room.battleshipSummary(g),
  full: (room, g, who) => room.battleshipStateFull(g, who),
  move: (room, g, who, dir, roomName) => room.battleshipMove(g, who, dir, roomName),
  advance: (room, g, roomName) => room.advanceBattleship(g, roomName),
  targets: (pub: BattleshipState) => (pub.phase === "setup" ? pub.players.filter((p) => !p.placed).map((p) => p.name) : pub.turn_of ? [pub.turn_of] : []),
  card: (g: BsGame) => ({ id: g.id, type: "battleship", status: g.status, phase: g.status === "running" ? g.st.phase : null, turn: g.st.turn, turn_of: g.status === "running" && g.st.phase === "play" ? g.st.turn_of : null, turn_seconds: g.st.tick_seconds, winner: g.st.winner || null, players: g.st.players.map((p) => ({ name: p.name, color: p.color, hex: p.hex })) }),
  stateItem: (r, st: BsSt) => ({ id: r.id, type: "battleship", status: r.status, turn: st.turn, phase: r.status === "running" ? st.phase : null, fleet_sizes: st.fleet_sizes || [5, 4, 3, 3, 2], players: (st.players || []).map((p) => ({ name: p.name, alive: !p.eliminated, moved: r.status !== "running" ? true : p.eliminated ? true : st.phase === "setup" ? !!p.fleet : st.turn_of !== p.name, accepted: seatAccepted(st, p) })) }),
  turnOf: (gm) => Number(gm.turn),
  moveHint: (gm, me) =>
    gm.phase === "setup"
      ? "<place: " + ((gm.fleet_sizes || [5, 4, 3, 3, 2]) as number[]).map((s, i) => "A" + (2 * i + 1) + "H").join(",") + " or random>"
      : gm.players && gm.players.length > 2
        ? "<fire: " + ((gm.players.filter((p) => p.alive && p.name.toLowerCase() !== String(me).toLowerCase())[0] || {}).name || "Rex") + ":C5>"
        : "<fire: C5>",
  result: (room, g) => room.battleshipResultText(g),
  rules: (st: BsSt) => {
    const sizes = st.fleet_sizes || [5, 4, 3, 3, 2];
    const ffa = (st.players || []).length > 2;
    const eg = sizes.map((s, i) => String.fromCharCode(65 + 2 * i) + (2 * i + 1) + (i % 2 ? "V" : "H")).join(",");
    return (
      "Battleship: each captain hides a fleet of ships (" + sizes.join(", ") + " cells long) on a " + (st.w || 10) + "x" + (st.h || 10) + " board, then turns rotate, one shot at one cell per turn: a hit, a miss or a sinking. " +
      (ffa
        ? "This is a free-for-all: every shot names its target as Name:Cell (e.g. Rex:C5); sinking a captain's last ship eliminates them, and the last fleet floating wins. "
        : "Sink every enemy ship to win. ") +
      (st.variant === "salvo" ? "Salvo: each turn you fire one shot per ship you still have afloat; one call may carry the whole volley as a comma list" + (ffa ? ", spread across rivals" : "") + ". " : "") +
      "Placement: dir lists one start cell plus H or V per ship, in fleet order (e.g. " + eg + "), or random. A shot: dir is a cell" + (ffa ? " with its target (Name:C5)" : " (e.g. C5)") + ". Each turn has " + clockWords(st.tick_seconds || 3600) + "; an expired turn counts as a miss, and three in a row forfeit."
    );
  },
} satisfies GameEngineOf<BsSt>;
