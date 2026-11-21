// Trust: the iterated prisoner's dilemma, simultaneous rounds.

import { clockWords, seatAccepted } from "./shared.js";

// Trust: what one pairing scores for you, keyed by your choice then
// theirs (C cooperate, D defect) - the classic prisoner's dilemma.
export const TR_PAYOFFS = { CC: 3, CD: 0, DC: 5, DD: 1 };

export const TrustMethods = {
  /* ---------- games: Trust (2026-11-19) ----------
     The iterated prisoner's dilemma, everyone against everyone. Each
     round every player secretly picks C (cooperate) or D (defect) toward
     EACH rival; every pairing then scores on its own: both C, 3 each; a D
     against a C, 5 to the defector and 0 to the trusting one; both D, 1
     each. Choices are public once the round resolves - reputation is the
     game. The match runs about `rounds` rounds: the real last round is
     drawn within two of it at creation and stays hidden until it comes,
     so nobody can plan a safe betrayal at the end. A missed round counts
     as D toward everyone; three in a row take a player out (their score
     stands). Highest total wins; a tie at the top has no winner (two
     players tied is a draw on the ladder). Rides the simultaneous-rounds
     machinery, waiting only on players still in. */
  trActive(st) {
    return st.players.filter((p) => !st.prog[p.name].out);
  },

  trParse(st, me, raw) {
    const rivals = this.trActive(st).filter((p) => p.name !== me.name).map((p) => p.name);
    const word = (w) => (/^(c|co+p(erate)?|trust)$/i.test(w) ? "C" : /^(d|defect|betray|cheat)$/i.test(w) ? "D" : null);
    const out = {};
    /** @type {"C" | "D" | null} */
    let dflt = null;
    const toks = String(raw || "").trim().replace(/^(all|everyone)\s*[:=]?\s*/i, "").split(/[,;\n]+/).map((t) => t.trim()).filter(Boolean);
    if (!toks.length) return { error: "send C or D for everyone, or one per rival, e.g. " + rivals.map((n, i) => n + ":" + (i % 2 ? "D" : "C")).join(", ") };
    for (const tok of toks) {
      const m = tok.match(/^(.+?)\s*[:=]\s*(\S+)$/);
      if (!m) {
        const w = word(tok);
        if (!w) return { error: "\"" + tok + "\" is not C or D (cooperate or defect)" };
        dflt = w;
        continue;
      }
      const name = rivals.find((n) => n.toLowerCase() === m[1].trim().toLowerCase());
      if (!name) return { error: "\"" + m[1].trim() + "\" is not a rival still in this match - rivals: " + rivals.join(", ") };
      const w = word(m[2]);
      if (!w) return { error: "\"" + m[2] + "\" is not C or D (cooperate or defect)" };
      out[name] = w;
    }
    const missing = rivals.filter((n) => !out[n]);
    if (missing.length && !dflt) return { error: "no choice for " + missing.join(", ") + " - send one per rival, or a C or D for everyone else (e.g. C, " + missing[0] + ":D)" };
    missing.forEach((n) => (out[n] = dflt));
    return out;
  },

  /** @returns {import("@chat/contract").TrustState} */
  trSummary(g) {
    const st = g.st;
    const over = g.status !== "running" && g.status !== "lobby";
    return {
      id: g.id, type: "trust", status: g.status, created_by: g.created_by, card_msg: g.card_msg,
      round: st.round, rounds_about: st.rounds_about, last_round: over ? st.last_round : null, round_seconds: st.round_seconds, deadline: st.deadline, lobby_deadline: g.status === "lobby" ? (st.lobby_deadline || null) : null,
      payoffs: TR_PAYOFFS, winner: st.winner || null, draw: !!st.draw, places: st.places || null, declined_by: st.declined_by || null,
      players: st.players.map((p) => {
        const pr = st.prog[p.name] || {};
        return { name: p.name, color: p.color, hex: p.hex, accepted: st.accepted ? !!st.accepted[p.name] : true, committed: st.pending[p.name] !== undefined, score: pr.score || 0, out: !!pr.out, coop: pr.given ? Math.round((100 * (pr.coop || 0)) / pr.given) / 100 : null };
      }),
    };
  },

  /** @returns {import("@chat/contract").TrustState} */
  trStateFull(g, who) {
    const out = this.trSummary(g);
    const st = g.st;
    out.rounds = st.rounds;
    out.log = st.log.slice(-24);
    const active = g.status === "running" ? this.trActive(st) : [];
    out.awaiting = active.filter((p) => st.pending[p.name] === undefined).map((p) => p.name);
    out.awaiting_accept = g.status === "lobby" ? st.players.filter((p) => !(st.accepted || {})[p.name]).map((p) => p.name) : [];
    const me = st.players.find((p) => p.name.toLowerCase() === String(who || "").toLowerCase());
    if (me) {
      const pr = st.prog[me.name];
      const racing = g.status === "running" && !pr.out;
      const rivals = this.trActive(st).filter((p) => p.name !== me.name).map((p) => p.name);
      out.you = {
        playing: true, accepted: st.accepted ? !!st.accepted[me.name] : true, queued: st.pending[me.name] || null, out: !!pr.out, rivals: racing ? rivals : [],
        legal_moves: racing ? ["C", "D"].concat(rivals.length > 1 ? [rivals.map((n, i) => n + ":" + (i % 2 ? "D" : "C")).join(", ")] : []) : [],
      };
    } else out.you = { playing: false };
    return out;
  },

  async createTrust(creator, playersIn, opts, room) {
    if (!Array.isArray(playersIn) || playersIn.length < 2 || playersIn.length > 8) return { status: 400, error: "Trust needs 2 to 8 players" };
    const resolved = this.gamePlayers(playersIn);
    if (resolved.error) return resolved;
    const names = resolved.names;
    const clamp = (v, lo, hi, def) => { const n = Math.floor(Number(v)); return Number.isFinite(n) && n > 0 ? Math.min(hi, Math.max(lo, n)) : def; };
    const about = clamp(opts.rounds, 4, 20, 10);
    // the real last round: within two of `about`, drawn now, hidden until it comes
    const last = Math.max(3, about - 2 + Math.floor(Math.random() * 5));
    const roundSeconds = clamp(opts.tick_seconds, 30, 86400, 180);
    const colors = this.gameColors();
    const players = names.map((n, i) => ({ name: n, color: colors[i].color, hex: colors[i].hex }));
    const prog = {};
    for (const n of names) prog[n] = { score: 0, missed: 0, out: false, coop: 0, given: 0 };
    const st = {
      type: "trust", rounds_about: about, last_round: last, round_seconds: roundSeconds, round: 1,
      deadline: null, lobby_deadline: Date.now() + this.lobbySeconds(opts) * 1000, accepted: this.lobbyAccepted(creator, names), players: players, prog: prog,
      rounds: [], pending: {}, pending_at: {}, places: null,
      log: [{ tick: 0, text: "Trust created by " + creator + " - " + names.join(", ") + ", about " + about + " rounds. The clock starts when everyone accepts." }],
      winner: null, draw: false, announced: false,
    };
    const ins = this.sql.exec("INSERT INTO gm (status, created, created_by, state) VALUES ('lobby', ?, ?, ?) RETURNING id", Date.now(), creator, JSON.stringify(st)).one();
    const g = this.gameRow(ins.id);
    const label = players.map((p) => p.name + " (" + p.color + ")").join(", ");
    const cardText = "Trust match #" + g.id + " - " + label + ". Each round, cooperate or defect with every rival in secret: both cooperate 3 each, a betrayal 5 to 0, both defect 1 each. About " + about + " rounds - the last one is a secret. Round clock: " + clockWords(roundSeconds) + ". Lobby open - the match starts when everyone accepts; tap the card to take your seat.";
    const msg = await this.postGameCard(creator, cardText, g.id, room);
    this.sql.exec("UPDATE gm SET card_msg = ? WHERE id = ?", msg.id, g.id);
    g.card_msg = msg.id;
    this.broadcastGame(g, room, creator);
    await this.armGameAlarm();
    return { status: 201, game: this.trStateFull(g, creator) };
  },

  async trMove(g, who, raw, room) {
    const st = g.st;
    const me = st.players.find((p) => p.name.toLowerCase() === String(who || "").toLowerCase());
    if (!me) return { status: 403, error: "You are not a player in this match" };
    if (st.prog[me.name].out) return { status: 400, error: "You are out of this match (three missed rounds in a row)" };
    const choice = this.trParse(st, me, raw);
    if (choice.error) return { status: 400, error: choice.error, legal_moves: ["C", "D"] };
    const resolved = this.roundsCommit(g, who, choice, room);
    await this.armGameAlarm();
    return { status: 200, game: this.trStateFull(g, who), resolved: resolved };
  },

  trResolveRound(g) {
    const st = g.st;
    const n = st.round;
    const at = Date.now();
    const active = this.trActive(st);
    /** @type {import("@chat/contract").TrustRound} */
    const entry = { n: n, at: at, moves: {}, missed: [], dropped: [], points: {}, totals: {} };
    for (const p of active) {
      const mv = st.pending[p.name];
      const pr = st.prog[p.name];
      if (mv === undefined) {
        // a missed round: D toward everyone
        entry.missed.push(p.name);
        pr.missed = (pr.missed || 0) + 1;
        const all = {};
        active.forEach((q) => { if (q.name !== p.name) all[q.name] = "D"; });
        entry.moves[p.name] = all;
      } else {
        pr.missed = 0;
        entry.moves[p.name] = mv;
      }
      entry.points[p.name] = 0;
    }
    for (let i = 0; i < active.length; i++)
      for (let k = i + 1; k < active.length; k++) {
        const a = active[i].name, b = active[k].name;
        const ab = entry.moves[a][b] || "D", ba = entry.moves[b][a] || "D";
        entry.points[a] += TR_PAYOFFS[ab + ba];
        entry.points[b] += TR_PAYOFFS[ba + ab];
        for (const [x, c] of [[a, ab], [b, ba]]) {
          st.prog[x].given += 1;
          if (c === "C") st.prog[x].coop += 1;
        }
      }
    for (const p of active) {
      const pr = st.prog[p.name];
      pr.score += entry.points[p.name];
      if (pr.missed >= 3) { pr.out = true; entry.dropped.push(p.name); }
    }
    st.players.forEach((p) => (entry.totals[p.name] = st.prog[p.name].score));
    st.rounds.push(entry);
    const pts = active.map((p) => p.name + " +" + entry.points[p.name]).join(", ");
    st.log.push({ tick: n, text: "Round " + n + ": " + pts + "." + (entry.missed.length ? " " + entry.missed.join(", ") + " sent nothing (D to everyone)." : "") + (entry.dropped.length ? " " + entry.dropped.join(", ") + " out after three missed rounds." : "") });
    st.pending = {};
    st.pending_at = {};
    if (n >= st.last_round || this.trActive(st).length < 2) {
      g.status = "finished";
      st.winner = this.trStanding(st);
      st.log.push({ tick: n, text: "That was the last round. " + (st.winner ? st.winner + " wins." : "A tie at the top - no winner.") });
    } else {
      st.round += 1;
      st.deadline = at + st.round_seconds * 1000;
    }
  },

  // Places by score, then the more trusting (a higher share of C given),
  // then name; the winner only when the top score is not shared.
  trStanding(st) {
    const rate = (n) => { const pr = st.prog[n]; return pr.given ? pr.coop / pr.given : 0; };
    st.places = st.players.map((p) => p.name).sort((a, b) => st.prog[b].score - st.prog[a].score || rate(b) - rate(a) || (a < b ? -1 : 1));
    const top = st.places[0];
    const tied = st.places.length > 1 && st.prog[st.places[1]].score === st.prog[top].score;
    st.draw = tied;
    return tied ? null : top;
  },

  trResultText(g) {
    const st = g.st;
    if (!st.places) this.trStanding(st);
    const scores = st.places.map((n) => n + " " + st.prog[n].score).join(", ");
    const rate = (n) => { const pr = st.prog[n]; return pr.given ? pr.coop / pr.given : 0; };
    const kind = st.players.map((p) => p.name).sort((a, b) => rate(b) - rate(a))[0];
    return "Trust match #" + g.id + " is over after " + st.rounds.length + " rounds - " + (st.winner ? st.winner + " wins with " + st.prog[st.winner].score + " points." : "a tie at the top, no winner.") + " Scores: " + scores + ". Most trusting: " + kind + " (cooperated " + Math.round(100 * rate(kind)) + "% of the time).";
  },
};

export const trustEngine = {
  name: "Trust",
  turnWord: "round",
  logTick: (st) => st.round,
  clockSeconds: (st) => st.round_seconds,
  create: (room, creator, players, opts, roomName) => room.createTrust(creator, players, opts, roomName),
  summary: (room, g) => room.trSummary(g),
  full: (room, g, who) => room.trStateFull(g, who),
  move: (room, g, who, dir, roomName) => room.trMove(g, who, dir, roomName),
  advance: (room, g, roomName) => room.roundsAdvance(g, roomName),
  resolveRound: (room, g) => room.trResolveRound(g),
  standing: (room, st) => room.trStanding(st),
  active: (room, st) => room.trActive(st),
  targets: (pub) => pub.players.filter((p) => !p.committed && !p.out).map((p) => p.name),
  card: (g) => ({ id: g.id, type: "trust", status: g.status, round: g.st.round, rounds_about: g.st.rounds_about, winner: g.st.winner || null, draw: !!g.st.draw, players: g.st.players.map((p) => { const pr = (g.st.prog || {})[p.name] || {}; return { name: p.name, color: p.color, hex: p.hex, score: pr.score || 0, out: !!pr.out }; }) }),
  stateItem: (r, st) => ({ id: r.id, type: "trust", status: r.status, round: st.round, players: (st.players || []).map((p) => { const pr = (st.prog || {})[p.name] || {}; return { name: p.name, alive: !pr.out, moved: (st.pending || {})[p.name] !== undefined || !!pr.out, accepted: seatAccepted(st, p) }; }) }),
  turnOf: (gm) => gm.round,
  moveHint: () => "<C or D toward everyone, or one per rival, e.g. C, Ada:D>",
  result: (room, g) => room.trResultText(g),
  rules: (st) =>
    "Trust: each round every player secretly picks C (cooperate) or D (defect) toward EACH rival, and every pairing scores on its own - both C: 3 points each; your D against their C: 5 to you, 0 to them (and the reverse); both D: 1 each. " +
    "Choices are public once the round resolves, so everyone sees who betrayed whom. The match runs about " + st.rounds_about + " rounds; the real last round is a secret until it comes. Highest total wins. " +
    "A round resolves when everyone still in has chosen, or at the " + clockWords(st.round_seconds || 180) + " deadline; a missed round counts as D toward everyone, and three missed rounds in a row take you out. " +
    "Send dir as C or D for everyone (cooperate / defect work too), or one per rival, e.g. Ada:C, Henry:D, or a default plus exceptions, e.g. C, Henry:D. You can change it until the round resolves.",
};
