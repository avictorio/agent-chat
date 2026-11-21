// Frontlines: split troops across hills, simultaneous rounds.

import { clockWords, seatAccepted } from "./shared.js";

// Frontlines: the hills on the field and the troops each round.
export const FL_HILLS = 5;
export const FL_TROOPS = 100;

export const FrontlinesMethods = {
  /* ---------- games: Frontlines (2026-11-19) ----------
     Two commanders, five hills, a hundred troops each round. Both split
     their troops in secret; each hill goes to the bigger army (a level
     hill goes to nobody) and the round to whoever holds more hills - or,
     in the Valued hills variant, more hill points (each round's values,
     a shuffle of 1, 1, 2, 2, 3, are public before anyone commits). A
     level round scores nobody. First to a majority of best_of rounds
     takes the field. Rides the shared simultaneous-rounds machinery (roundsCommit and
     roundsAdvance in room/games.js): a
     lone commitment at the deadline wins its round by forfeit. */
  flParse(raw) {
    const s = String(raw || "").trim().toLowerCase();
    if (s === "random") return this.flRandom();
    if (s === "even") return [20, 20, 20, 20, 20];
    const parts = s.replace(/^(deploy|send|split)\s*:?\s*/, "").split(/[\s,;]+/).filter(Boolean);
    if (parts.length !== FL_HILLS) return { error: "send " + FL_HILLS + " numbers, one per hill A-E, e.g. 30,20,20,15,15 (or \"even\" / \"random\")" };
    const nums = parts.map((x) => (/^\d+$/.test(x) ? Number(x) : NaN));
    if (nums.some((n) => !Number.isFinite(n))) return { error: "troops are whole numbers, 0 or more, e.g. 30,20,20,15,15" };
    const sum = nums.reduce((a, b) => a + b, 0);
    if (sum !== FL_TROOPS) return { error: "the five numbers must add up to exactly " + FL_TROOPS + " (yours add up to " + sum + ")" };
    return nums;
  },

  flRandom() {
    const w = Array.from({ length: FL_HILLS }, () => Math.random() + 0.05);
    const tot = w.reduce((a, b) => a + b, 0);
    const out = w.map((x) => Math.floor((x / tot) * FL_TROOPS));
    let left = FL_TROOPS - out.reduce((a, b) => a + b, 0);
    for (let i = 0; left > 0; i = (i + 1) % FL_HILLS, left--) out[i]++;
    return out;
  },

  flValues() {
    const v = [1, 1, 2, 2, 3];
    for (let i = v.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); const t = v[i]; v[i] = v[j]; v[j] = t; }
    return v;
  },

  flSummary(g) {
    const st = g.st;
    return {
      id: g.id, type: "frontlines", status: g.status, created_by: g.created_by, card_msg: g.card_msg,
      round: st.round, best_of: st.best_of, target: st.target, round_seconds: st.round_seconds, deadline: st.deadline, lobby_deadline: g.status === "lobby" ? (st.lobby_deadline || null) : null,
      variant: st.variant, hills: FL_HILLS, troops: FL_TROOPS, values: st.variant === "valued" ? st.values : null,
      score: st.score, winner: st.winner || null, declined_by: st.declined_by || null,
      players: st.players.map((p) => ({ name: p.name, color: p.color, hex: p.hex, wins: st.score[p.name] || 0, accepted: st.accepted ? !!st.accepted[p.name] : true, committed: st.pending[p.name] !== undefined })),
    };
  },

  flStateFull(g, who) {
    const out = this.flSummary(g);
    const st = g.st;
    out.rounds = st.rounds;
    out.log = st.log.slice(-24);
    out.awaiting = g.status === "running" ? st.players.filter((p) => st.pending[p.name] === undefined).map((p) => p.name) : [];
    out.awaiting_accept = g.status === "lobby" ? st.players.filter((p) => !(st.accepted || {})[p.name]).map((p) => p.name) : [];
    const me = st.players.find((p) => p.name.toLowerCase() === String(who || "").toLowerCase());
    // your own split is yours to see; the rival's stays hidden until the round resolves
    out.you = me
      ? { playing: true, accepted: st.accepted ? !!st.accepted[me.name] : true, queued: st.pending[me.name] || null, legal_moves: g.status === "running" ? ["five whole numbers adding up to " + FL_TROOPS + ", one per hill A-E, e.g. 30,20,20,15,15", "even", "random"] : [] }
      : { playing: false };
    return out;
  },

  async createFrontlines(creator, playersIn, opts, room) {
    if (!Array.isArray(playersIn) || playersIn.length !== 2) return { status: 400, error: "Frontlines needs exactly 2 players" };
    const resolved = this.gamePlayers(playersIn);
    if (resolved.error) return resolved;
    const names = resolved.names;
    const bestOf = Math.min(9, Math.max(1, Math.floor(Number(opts.best_of) || 5)));
    const target = Math.floor(bestOf / 2) + 1;
    const variant = String(opts.variant || "classic").toLowerCase() === "valued" ? "valued" : "classic";
    let roundSeconds = Math.floor(Number(opts.tick_seconds) || 0);
    if (!roundSeconds) roundSeconds = 180;
    roundSeconds = Math.min(86400, Math.max(30, roundSeconds));
    const colors = this.gameColors();
    const players = names.map((n, i) => ({ name: n, color: colors[i].color, hex: colors[i].hex }));
    const score = {};
    for (const n of names) score[n] = 0;
    const st = {
      type: "frontlines", best_of: bestOf, target: target, round_seconds: roundSeconds, round: 1, variant: variant,
      values: variant === "valued" ? this.flValues() : null,
      deadline: null, lobby_deadline: Date.now() + this.lobbySeconds(opts) * 1000, accepted: this.lobbyAccepted(creator, names), players: players, score: score,
      rounds: [], pending: {}, pending_at: {},
      log: [{ tick: 0, text: "Frontlines created by " + creator + " - " + names.join(" vs ") + ", first to " + target + (variant === "valued" ? ", valued hills" : "") + ". The clock starts when both commanders accept." }],
      winner: null, announced: false,
    };
    const ins = this.sql.exec("INSERT INTO gm (status, created, created_by, state) VALUES ('lobby', ?, ?, ?) RETURNING id", Date.now(), creator, JSON.stringify(st)).one();
    const g = this.gameRow(ins.id);
    const label = players.map((p) => p.name + " (" + p.color + ")").join(" vs ");
    const clock = roundSeconds >= 3600 ? Math.round(roundSeconds / 3600) + " h" : Math.max(1, Math.round(roundSeconds / 60)) + " min";
    const cardText = "Frontlines match #" + g.id + " - " + label + ". Split " + FL_TROOPS + " troops across " + FL_HILLS + " hills in secret, first to " + target + (variant === "valued" ? " (valued hills)" : "") + ". Round clock: " + clock + ". Lobby open - the match starts when both players accept; tap the card to take your seat.";
    const msg = await this.postGameCard(creator, cardText, g.id, room);
    this.sql.exec("UPDATE gm SET card_msg = ? WHERE id = ?", msg.id, g.id);
    g.card_msg = msg.id;
    this.broadcastGame(g, room, creator);
    await this.armGameAlarm();
    return { status: 201, game: this.flStateFull(g, creator) };
  },

  async flMove(g, who, raw, room) {
    const st = g.st;
    const me = st.players.find((p) => p.name.toLowerCase() === String(who || "").toLowerCase());
    if (!me) return { status: 403, error: "You are not a player in this match" };
    const alloc = /** @type {any} */ (this.flParse(raw)); // the troops per hill, or { error }
    if (alloc.error) return { status: 400, error: alloc.error, legal_moves: ["30,20,20,15,15", "even", "random"] };
    const resolved = this.roundsCommit(g, who, alloc, room);
    await this.armGameAlarm();
    return { status: 200, game: this.flStateFull(g, who), resolved: resolved };
  },

  // One round: hill by hill, the bigger army takes it; the round goes to
  // more hills held (classic) or more hill points (valued). A lone
  // commitment (the deadline came) wins the round by forfeit.
  flResolveRound(g) {
    const st = g.st;
    const n = st.round;
    const at = Date.now();
    const [a, b] = st.players;
    const xa = st.pending[a.name], xb = st.pending[b.name];
    const entry = { n: n, alloc: {}, alloc_at: {}, hills: null, held: {}, points: {}, values: st.values || null, winner: null, forfeit: null, at: at };
    if (xa) { entry.alloc[a.name] = xa; entry.alloc_at[a.name] = (st.pending_at || {})[a.name] || null; }
    if (xb) { entry.alloc[b.name] = xb; entry.alloc_at[b.name] = (st.pending_at || {})[b.name] || null; }
    let note;
    if (xa && xb) {
      entry.hills = xa.map((ta, i) => (ta > xb[i] ? a.name : xb[i] > ta ? b.name : null));
      for (const p of [a, b]) {
        entry.held[p.name] = entry.hills.filter((h) => h === p.name).length;
        entry.points[p.name] = entry.hills.reduce((s, h, i) => s + (h === p.name ? (st.values ? st.values[i] : 1) : 0), 0);
      }
      const ka = entry.points[a.name], kb = entry.points[b.name];
      entry.winner = ka > kb ? a.name : kb > ka ? b.name : null;
      note = a.name + " " + xa.join("/") + " vs " + b.name + " " + xb.join("/") + " - " + (st.values ? "points " + ka + "-" + kb : "hills " + ka + "-" + kb) + (entry.winner ? ", " + entry.winner + " takes the round." : ", level, no score.");
    } else {
      entry.winner = xa ? a.name : b.name;
      entry.forfeit = xa ? b.name : a.name;
      note = entry.winner + " takes the round by forfeit - " + entry.forfeit + " never committed.";
    }
    st.rounds.push(entry);
    if (entry.winner) st.score[entry.winner] = (st.score[entry.winner] || 0) + 1;
    st.log.push({ tick: n, text: "Round " + n + ": " + note + " Score " + a.name + " " + (st.score[a.name] || 0) + " - " + (st.score[b.name] || 0) + " " + b.name + "." });
    st.pending = {};
    st.pending_at = {};
    st.round += 1;
    if (entry.winner && st.score[entry.winner] >= st.target) {
      g.status = "finished";
      st.winner = entry.winner;
      st.log.push({ tick: st.round, text: entry.winner + " takes the field." });
    } else {
      if (st.variant === "valued") st.values = this.flValues();
      st.deadline = at + st.round_seconds * 1000;
    }
  },

  flStanding(st) {
    const [a, b] = st.players;
    const sa = st.score[a.name] || 0, sb = st.score[b.name] || 0;
    return sa === sb ? null : sa > sb ? a.name : b.name;
  },

  flResultText(g) {
    const st = g.st;
    const [a, b] = st.players;
    const sa = st.score[a.name] || 0, sb = st.score[b.name] || 0;
    const forfeits = st.rounds.filter((r) => r.forfeit).length;
    const hillsOf = (p) => st.rounds.reduce((s, r) => s + ((r.held || {})[p.name] || 0), 0);
    return "Frontlines match #" + g.id + " is over - " + (st.winner ? st.winner + " takes the field " + Math.max(sa, sb) + "-" + Math.min(sa, sb) + " over " + (st.winner === a.name ? b.name : a.name) + "." : "no winner; the score stood " + a.name + " " + sa + " - " + sb + " " + b.name + ".") + " Rounds played: " + st.rounds.length + (forfeits ? " (" + forfeits + " by forfeit)" : "") + ". Hills taken: " + a.name + " " + hillsOf(a) + ", " + b.name + " " + hillsOf(b) + ".";
  },
};

export const frontlinesEngine = {
  name: "Frontlines",
  turnWord: "round",
  logTick: (st) => st.round,
  clockSeconds: (st) => st.round_seconds,
  create: (room, creator, players, opts, roomName) => room.createFrontlines(creator, players, opts, roomName),
  summary: (room, g) => room.flSummary(g),
  full: (room, g, who) => room.flStateFull(g, who),
  move: (room, g, who, dir, roomName) => room.flMove(g, who, dir, roomName),
  advance: (room, g, roomName) => room.roundsAdvance(g, roomName),
  // the simultaneous-rounds hooks
  resolveRound: (room, g) => room.flResolveRound(g),
  standing: (room, st) => room.flStanding(st),
  targets: (pub) => pub.players.filter((p) => !p.committed).map((p) => p.name),
  card: (g) => ({ id: g.id, type: "frontlines", status: g.status, round: g.st.round, target: g.st.target, round_seconds: g.st.round_seconds, variant: g.st.variant, score: g.st.score, winner: g.st.winner || null, players: g.st.players.map((p) => ({ name: p.name, color: p.color, hex: p.hex, wins: (g.st.score || {})[p.name] || 0 })) }),
  stateItem: (r, st) => ({ id: r.id, type: "frontlines", status: r.status, round: st.round, players: (st.players || []).map((p) => ({ name: p.name, alive: true, moved: (st.pending || {})[p.name] !== undefined, accepted: seatAccepted(st, p) })) }),
  turnOf: (gm) => gm.round,
  moveHint: () => "<" + FL_HILLS + " whole numbers adding up to " + FL_TROOPS + ", one per hill A-E, e.g. 30,20,20,15,15>",
  result: (room, g) => room.flResultText(g),
  rules: (st) =>
    "Frontlines: each round both commanders secretly split " + FL_TROOPS + " troops across " + FL_HILLS + " hills, A to E. When both splits are in, each hill goes to the bigger army (a tie on a hill takes nobody) and the round to whoever holds " +
    (st.variant === "valued" ? "more hill points - the hills carry point values, public each round (this round: " + (st.values || []).join(", ") + " for A-E)" : "more hills") +
    "; a level round scores nobody. First to " + st.target + " rounds wins (best of " + st.best_of + "). You can change your split until the round resolves; at the " + clockWords(st.round_seconds || 180) + " deadline a lone split wins the round. Send dir as five whole numbers adding up to " + FL_TROOPS + ", one per hill, e.g. 30,20,20,15,15 (or even / random).",
};
