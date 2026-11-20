// Two Truths and a Lie: a rotating teller, everyone else votes.

import { clockWords, seatAccepted } from "./shared.js";

// Two Truths and a Lie: a statement's length cap, and the line a round
// gets when every vote found the lie ({t} = the storyteller).
export const TT_MAX = 200;
export const TT_ROASTS = [
  "Everyone saw through it - {t}'s poker face needs work.",
  "Not one believer. {t} will have to lie harder next time.",
  "A clean sweep for the table; {t}'s secrets stay safe by being obvious.",
  "Unanimous: {t} is a terrible liar. Take it as a compliment.",
];

// Two Truths and a Lie's points per player, for the chat card (no Room to hand).
export function room_ttTally(st) {
  const out = {};
  for (const p of st.players || []) out[p.name] = 0;
  for (const r of st.rounds || []) for (const n of Object.keys(r.points || {})) out[n] = (out[n] || 0) + r.points[n];
  return out;
}

export const TwoTruthsMethods = {
  /* ---------- games: Two Truths and a Lie (2026-11-19) ----------
     Henry's spec: 3 to 6 players, one round per player as storyteller
     (rotations full turns of the table, default 1). The storyteller
     writes three statements about themselves - two true, one a lie -
     privately (a structured move: statements + lie); the Referee
     publishes them shuffled, and everyone else votes for the one they
     think is the lie. Votes are sealed until all are in or the clock
     runs out, then the lie is revealed. A right vote scores 2; the
     storyteller scores 1 per player fooled, at most 2. Truth rests on the
     storyteller's honour - the server only keeps the lie secret until
     the reveal. Phases: write (the storyteller's clock), then vote (one
     clock for everyone else); a storyteller who misses the clock forfeits
     the round, a voter who misses it scores nothing. Two quiet rounds in
     a row (a forfeit, or nobody voted) end the match where it stands -
     called off if nothing was ever played. Highest total wins; ties go
     to more lies spotted, then to quicker right votes. The Referee posts
     only the result; the reveal lives in the card and the arena. */
  ttTally(st) {
    const out = {};
    for (const p of st.players) out[p.name] = { score: 0, spots: 0, ms: 0 };
    for (const r of st.rounds) {
      for (const n of Object.keys(r.points || {})) out[n].score += r.points[n];
      for (const n of r.right || []) {
        out[n].spots += 1;
        out[n].ms += r.vote_ms && r.vote_ms[n] ? r.vote_ms[n] : 0;
      }
    }
    return out;
  },

  ttVoters(st) {
    return st.players.filter((p) => p.name !== st.teller);
  },

  ttSummary(g) {
    const st = g.st;
    const t = this.ttTally(st);
    const live = g.status === "running";
    return {
      id: g.id, type: "twotruths", status: g.status, created_by: g.created_by, card_msg: g.card_msg,
      round: st.round, rounds_total: st.rounds_total, rotations: st.rotations, phase: live ? st.phase : null, teller: live ? st.teller : null,
      round_seconds: st.round_seconds, deadline: st.deadline, lobby_deadline: g.status === "lobby" ? (st.lobby_deadline || null) : null, order: st.order,
      statements: live && st.phase === "vote" && st.cur ? st.cur.shown : null,
      last_round: st.rounds.length ? st.rounds[st.rounds.length - 1] : null,
      winner: st.winner || null, draw: !!st.draw, places: st.places || null, declined_by: st.declined_by || null,
      players: st.players.map((p) => ({ name: p.name, color: p.color, hex: p.hex, accepted: st.accepted ? !!st.accepted[p.name] : true, score: t[p.name].score, spots: t[p.name].spots, committed: live && st.phase === "vote" ? st.votes[p.name] !== undefined : live && st.phase === "write" && p.name !== st.teller })),
    };
  },

  ttStateFull(g, who) {
    const out = this.ttSummary(g);
    const st = g.st;
    out.rounds = st.rounds;
    out.log = st.log.slice(-24);
    const live = g.status === "running";
    out.awaiting = !live ? [] : st.phase === "write" ? [st.teller] : this.ttVoters(st).filter((p) => st.votes[p.name] === undefined).map((p) => p.name);
    out.awaiting_accept = g.status === "lobby" ? st.players.filter((p) => !(st.accepted || {})[p.name]).map((p) => p.name) : [];
    const me = st.players.find((p) => p.name.toLowerCase() === String(who || "").toLowerCase());
    if (!me) {
      out.you = { playing: false };
      return out;
    }
    const you = { playing: true, accepted: st.accepted ? !!st.accepted[me.name] : true, teller: live && st.teller === me.name, legal_moves: [] };
    if (live && st.teller === me.name) {
      // the storyteller sees their own statements, the lie marked
      if (st.cur) {
        you.statements = st.cur.shown;
        you.lie = st.cur.lie;
      } else you.legal_moves = ['{"statements": ["<statement>", "<statement>", "<statement>"], "lie": <1-3>}'];
    } else if (live && st.phase === "vote") {
      you.vote = st.votes[me.name] === undefined ? null : st.votes[me.name];
      you.legal_moves = ["1", "2", "3"];
    }
    out.you = you;
    return out;
  },

  async createTwoTruths(creator, playersIn, opts, room) {
    if (!Array.isArray(playersIn) || playersIn.length < 3 || playersIn.length > 6) return { status: 400, error: "Two Truths and a Lie needs 3 to 6 players" };
    const resolved = this.gamePlayers(playersIn);
    if (resolved.error) return resolved;
    const names = resolved.names.slice();
    for (let i = names.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [names[i], names[j]] = [names[j], names[i]];
    }
    const clamp = (v, lo, hi, def) => { const n = Math.floor(Number(v)); return Number.isFinite(n) && n > 0 ? Math.min(hi, Math.max(lo, n)) : def; };
    const rotations = clamp(opts.rotations, 1, 3, 1);
    const roundSeconds = clamp(opts.tick_seconds, 30, 86400, 3600);
    const colors = this.gameColors();
    const players = resolved.names.map((n, i) => ({ name: n, color: colors[i].color, hex: colors[i].hex }));
    const st = {
      type: "twotruths", round_seconds: roundSeconds, rotations: rotations, rounds_total: names.length * rotations, round: 1, order: names, teller: names[0], phase: "write",
      cur: null, votes: {}, vote_at: {}, phase_at: null, rounds: [], quiet: 0,
      deadline: null, lobby_deadline: Date.now() + this.lobbySeconds(opts) * 1000, accepted: this.lobbyAccepted(creator, resolved.names), players: players,
      log: [{ tick: 0, text: "Two Truths and a Lie created by " + creator + " - storytellers in this order: " + names.join(", ") + (rotations > 1 ? ", " + rotations + " times round" : "") + ". The clock starts when everyone accepts." }],
      winner: null, places: null, draw: false, announced: false,
    };
    const ins = this.sql.exec("INSERT INTO gm (status, created, created_by, state) VALUES ('lobby', ?, ?, ?) RETURNING id", Date.now(), creator, JSON.stringify(st)).one();
    const g = this.gameRow(ins.id);
    const label = players.map((p) => p.name + " (" + p.color + ")").join(", ");
    const cardText = "Two Truths and a Lie #" + g.id + " - " + label + ". Each round a storyteller writes two truths and a lie about themselves; everyone else votes for the lie. " + names[0] + " tells first. Clock: " + clockWords(roundSeconds) + " to write, the same to vote. Lobby open - the game starts when everyone accepts; tap the card to take your seat.";
    const msg = await this.postGameCard(creator, cardText, g.id, room);
    this.sql.exec("UPDATE gm SET card_msg = ? WHERE id = ?", msg.id, g.id);
    g.card_msg = msg.id;
    this.broadcastGame(g, room, creator);
    await this.armGameAlarm();
    return { status: 201, game: this.ttStateFull(g, creator) };
  },

  // The storyteller's statements: fields {statements, lie}, or the same as
  // a JSON string in dir.
  ttParseStatements(raw, fields) {
    let o = fields && fields.statements ? fields : null;
    if (!o && /^\s*\{/.test(String(raw || ""))) {
      try {
        o = JSON.parse(String(raw));
      } catch (e) {
        return { error: "dir looked like JSON but did not parse: " + e.message };
      }
    }
    if (!o || !Array.isArray(o.statements)) return { error: "As storyteller, send statements (three of them) and lie (1, 2 or 3: which one is false)" };
    const ss = o.statements.map((x) => String(x == null ? "" : x).replace(/\s+/g, " ").trim());
    if (ss.length !== 3) return { error: "Send exactly three statements - two true, one a lie" };
    if (ss.some((x) => !x)) return { error: "A statement cannot be empty" };
    if (ss.some((x) => x.length > TT_MAX)) return { error: "A statement can be up to " + TT_MAX + " characters" };
    if (new Set(ss.map((x) => x.toLowerCase())).size < 3) return { error: "The three statements must differ" };
    const lie = Math.floor(Number(o.lie));
    if (!(lie >= 1 && lie <= 3)) return { error: "lie is 1, 2 or 3 - which of your statements is false" };
    return { statements: ss, lie: lie };
  },

  async ttMove(g, who, raw, room, fields) {
    const st = g.st;
    const me = st.players.find((p) => p.name.toLowerCase() === String(who || "").toLowerCase());
    if (!me) return { status: 403, error: "You are not a player in this game" };
    if (st.phase === "write") {
      if (me.name !== st.teller) return { status: 409, error: st.teller + " is writing this round's statements - you vote once they are up" };
      const p = this.ttParseStatements(raw, fields);
      if (p.error) return { status: 400, error: p.error, legal_moves: ['{"statements": ["<statement>", "<statement>", "<statement>"], "lie": <1-3>}'] };
      // shuffle for the table; remember where the lie landed
      const idx = [0, 1, 2];
      for (let i = 2; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [idx[i], idx[j]] = [idx[j], idx[i]];
      }
      const shown = idx.map((i) => p.statements[i]);
      st.cur = { shown: shown, lie: idx.indexOf(p.lie - 1) + 1, at: Date.now() };
      st.phase = "vote";
      st.votes = {};
      st.vote_at = {};
      st.phase_at = Date.now();
      st.deadline = Date.now() + st.round_seconds * 1000;
      st.log.push({ tick: st.round, text: me.name + "'s three statements are up - vote for the lie." });
      this.saveGame(g);
      this.afterGameChange(g, room, me.name);
      await this.armGameAlarm();
      return { status: 200, game: this.ttStateFull(g, who), resolved: false };
    }
    if (me.name === st.teller) return { status: 409, error: "You are the storyteller this round - the others are voting on your statements" };
    const s = String(fields && fields.vote != null ? fields.vote : raw || "").trim().toLowerCase().replace(/^(vote|lie)\s*:?\s*#?/, "");
    if (!/^[1-3]$/.test(s)) return { status: 400, error: "dir is 1, 2 or 3 - the statement you think is the lie", legal_moves: ["1", "2", "3"] };
    st.votes[me.name] = Number(s);
    st.vote_at[me.name] = Date.now();
    const all = this.ttVoters(st).every((p) => st.votes[p.name] !== undefined);
    if (all) this.ttResolve(g);
    this.saveGame(g);
    if (all) this.afterGameChange(g, room, "Referee");
    else this.broadcastGame(g, room, me.name);
    await this.armGameAlarm();
    return { status: 200, game: this.ttStateFull(g, who), resolved: all };
  },

  // The reveal: score the round, then deal the next or finish.
  ttResolve(g) {
    const st = g.st;
    const lie = st.cur.lie;
    const voters = this.ttVoters(st).map((p) => p.name);
    const votes = {};
    const vote_ms = {};
    const right = [];
    const points = {};
    let fooled = 0;
    voters.forEach((n) => {
      const v = st.votes[n] === undefined ? null : st.votes[n];
      votes[n] = v;
      if (v === lie) {
        right.push(n);
        points[n] = 2;
        vote_ms[n] = Math.max(0, (st.vote_at[n] || st.phase_at) - st.phase_at);
      } else if (v != null) fooled++;
    });
    points[st.teller] = Math.min(2, fooled);
    const cast = voters.filter((n) => votes[n] != null).length;
    let note = null;
    if (cast && right.length === cast) note = TT_ROASTS[st.round % TT_ROASTS.length].replace(/\{t\}/g, st.teller);
    st.rounds.push({ n: st.round, teller: st.teller, statements: st.cur.shown, lie: lie, votes: votes, right: right, fooled: fooled, points: points, vote_ms: vote_ms, missed: voters.filter((n) => votes[n] == null), forfeit: false, note: note, at: Date.now() });
    st.log.push({ tick: st.round, text: "Round " + st.round + ": " + st.teller + "'s lie was #" + lie + ". " + (right.length ? right.join(", ") + " spotted it" : "Nobody spotted it") + "; " + st.teller + " fooled " + fooled + "." });
    st.quiet = cast ? 0 : st.quiet + 1;
    this.ttNext(g);
  },

  ttNext(g) {
    const st = g.st;
    st.cur = null;
    st.votes = {};
    st.vote_at = {};
    const played = st.rounds.some((r) => !r.forfeit && Object.keys(r.votes || {}).some((n) => r.votes[n] != null));
    if (st.quiet >= 2 || st.round >= st.rounds_total) {
      if (!played) {
        g.status = "cancelled";
        st.log.push({ tick: st.round, text: "Two quiet rounds and nothing played - the game is called off." });
        return;
      }
      g.status = "finished";
      st.winner = this.ttStanding(st);
      st.phase = null;
      st.teller = null;
      st.deadline = null;
      st.log.push({ tick: st.round, text: (st.quiet >= 2 ? "Two quiet rounds in a row - the game ends where it stands. " : "") + (st.winner ? st.winner + " wins." : "A tie at the top - no winner.") });
      return;
    }
    st.round += 1;
    st.teller = this.roleOf(st, st.round);
    st.phase = "write";
    st.phase_at = Date.now();
    st.deadline = Date.now() + st.round_seconds * 1000;
  },

  ttAdvance(g, room) {
    if (!g || g.status !== "running" || Date.now() < g.st.deadline) return;
    const st = g.st;
    if (st.phase === "write") {
      st.rounds.push({ n: st.round, teller: st.teller, statements: null, lie: null, votes: {}, right: [], fooled: 0, points: {}, vote_ms: {}, missed: [], forfeit: true, note: null, at: Date.now() });
      st.log.push({ tick: st.round, text: st.teller + " ran out of time to write - round " + st.round + " is forfeit." });
      st.quiet += 1;
      this.ttNext(g);
    } else this.ttResolve(g);
    this.saveGame(g);
    if (g.status === "cancelled") this.postSystem("Two Truths and a Lie #" + g.id + " is off - two quiet rounds and nothing played.", room);
    this.afterGameChange(g, room, "Referee");
  },

  ttStanding(st) {
    const t = this.ttTally(st);
    st.places = st.players.map((p) => p.name).sort((a, b) => t[b].score - t[a].score || t[b].spots - t[a].spots || t[a].ms - t[b].ms || (a < b ? -1 : 1));
    const [x, y] = st.places;
    const tied = !!y && t[x].score === t[y].score && t[x].spots === t[y].spots && t[x].ms === t[y].ms;
    st.draw = tied;
    return tied ? null : x;
  },

  ttResultText(g) {
    const st = g.st;
    if (!st.places) st.winner = this.ttStanding(st);
    const t = this.ttTally(st);
    const lines = st.places.map((n) => n + " " + t[n].score).join(", ");
    const best = st.rounds.filter((r) => !r.forfeit).sort((a, b) => b.fooled - a.fooled)[0];
    return "Two Truths and a Lie #" + g.id + " is over - " + (st.winner ? st.winner + " wins with " + t[st.winner].score + " points." : "a tie at the top, no winner.") + " " + lines + "." + (best && best.fooled ? " Best lie: " + best.teller + " fooled " + best.fooled + "." : "");
  },
};

export const twotruthsEngine = {
  name: "Two Truths and a Lie",
  turnWord: "round",
  logTick: (st) => st.round,
  clockSeconds: (st) => st.round_seconds,
  create: (room, creator, players, opts, roomName) => room.createTwoTruths(creator, players, opts, roomName),
  summary: (room, g) => room.ttSummary(g),
  full: (room, g, who) => room.ttStateFull(g, who),
  move: (room, g, who, dir, roomName, fields) => room.ttMove(g, who, dir, roomName, fields),
  advance: (room, g, roomName) => room.ttAdvance(g, roomName),
  targets: (pub) => (pub.status !== "running" ? [] : pub.phase === "write" ? [pub.teller] : (pub.players || []).filter((p) => p.name !== pub.teller && !p.committed).map((p) => p.name)),
  card: (g) => {
    const t = room_ttTally(g.st);
    return { id: g.id, type: "twotruths", status: g.status, round: g.st.round, rounds_total: g.st.rounds_total, phase: g.status === "running" ? g.st.phase : null, teller: g.status === "running" ? g.st.teller : null, winner: g.st.winner || null, draw: !!g.st.draw, players: g.st.players.map((p) => ({ name: p.name, color: p.color, hex: p.hex, score: t[p.name] || 0 })) };
  },
  stateItem: (r, st) => ({ id: r.id, type: "twotruths", status: r.status, round: st.round, phase: st.phase, teller: st.teller, turn: st.round * 2 + (st.phase === "vote" ? 1 : 0), players: (st.players || []).map((p) => ({ name: p.name, alive: true, moved: r.status !== "running" || (st.phase === "write" ? p.name !== st.teller : p.name === st.teller || (st.votes || {})[p.name] !== undefined), accepted: seatAccepted(st, p) })) }),
  turnOf: (gm) => gm.turn,
  moveHint: (gm, name) => (gm.phase === "write" && gm.teller === name ? '{"statements": ["<a truth>", "<a truth>", "<a lie>"], "lie": 3}' : "<1, 2 or 3: the statement you think is the lie>"),
  result: (room, g) => room.ttResultText(g),
  rules: (st) =>
    "Two Truths and a Lie: each round one player is the storyteller (in this order: " + st.order.join(", ") + (st.rotations > 1 ? ", " + st.rotations + " times round" : "") + ", " + st.rounds_total + " rounds). " +
    "The storyteller writes three statements about themselves - two true, one a lie - and says which is the lie: send statements (an array of three) and lie (1, 2 or 3), or the same JSON as dir. The statements are published shuffled; the lie stays secret. " +
    "Everyone else votes for the statement they think is the lie: send dir 1, 2 or 3. Votes are sealed until all are in. A right vote scores 2; the storyteller scores 1 for each player fooled, at most 2. Truth is on the storyteller's honour. " +
    "Each phase has " + clockWords(st.round_seconds || 3600) + ": a storyteller who runs out forfeits the round, a voter who runs out scores nothing; two quiet rounds in a row end the game. Highest total wins; ties go to more lies spotted, then quicker right votes.",
};
