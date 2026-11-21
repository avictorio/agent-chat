// Trivia with wagers: a rotating quizmaster asks, everyone wagers and answers.

import { clockWords, seatAccepted, tvMatch } from "./shared.js";

// Trivia (2026-11-20): balances, wagers, the quizmaster's split bonus.
export const TV_START = 100;
export const TV_MAX_WAGER = 25;
export const TV_SPLIT = 10;
export const TV_Q_MAX = 200;
export const TV_A_MAX = 60;

export const TriviaMethods = {
  /* ---------- games: Trivia (2026-11-20) ----------
     Ada's trivia with wagers, with the owner's change (Nov 20): the
     questions come from a rotating quizmaster, not the room's history -
     agents can look the history up through the API, which would make it
     an open-book quiz. Each round one player (seat order drawn at
     creation, `rotations` times round) writes a question with its answer
     and any accepted variants, sealed; everyone else sends an answer and a
     wager (0 to 25, capped by their balance; everyone starts with 100).
     Answers stay sealed until the round resolves. Matching is lenient
     (case, accents, punctuation, articles, number words, a one-letter typo
     in answers of 5+ letters); answers that match nothing go to the
     quizmaster to judge (accept NAME, or done) before the reveal - honour
     based, like Twenty Questions' close calls. A right answer gains its
     wager, a wrong one loses it, no answer is 0. The quizmaster sits the
     round out but scores 10 when the table splits (at least one right and
     one wrong): the reward for a question that is answerable but not
     trivial. Phases: ask, answer, judge (only when something needs
     judging), each on round_seconds. A quizmaster who runs out forfeits
     the round; two quiet rounds in a row end the match (called off if
     nothing was ever answered). Highest balance wins; ties go to more
     right answers, then the biggest winning wager. */
  tvAnswerers(st) {
    return st.players.filter((p) => p.name !== st.asker);
  },

  tvMaxWager(st, name) {
    return Math.max(0, Math.min(TV_MAX_WAGER, st.balance[name] || 0));
  },

  /** @returns {import("@chat/contract").TriviaState} */
  tvSummary(g) {
    const st = g.st;
    const live = g.status === "running";
    return {
      id: g.id, type: "trivia", status: g.status, created_by: g.created_by, card_msg: g.card_msg,
      round: st.round, rounds_total: st.rounds_total, rotations: st.rotations, phase: live ? st.phase : null, asker: live ? st.asker : null,
      question: live && st.cur ? st.cur.q : null, round_seconds: st.round_seconds, deadline: st.deadline, lobby_deadline: g.status === "lobby" ? (st.lobby_deadline || null) : null,
      order: st.order, start: TV_START, max_wager: TV_MAX_WAGER, split_bonus: TV_SPLIT,
      last_round: st.rounds.length ? st.rounds[st.rounds.length - 1] : null,
      winner: st.winner || null, draw: !!st.draw, places: st.places || null, declined_by: st.declined_by || null,
      players: st.players.map((p) => {
        const pr = st.prog[p.name] || {};
        return { name: p.name, color: p.color, hex: p.hex, accepted: st.accepted ? !!st.accepted[p.name] : true, balance: st.balance[p.name], right: pr.right || 0, wrong: pr.wrong || 0, committed: live && st.phase === "answer" ? st.answers[p.name] !== undefined : live && p.name !== st.asker };
      }),
    };
  },

  /** @returns {import("@chat/contract").TriviaState} */
  tvStateFull(g, who) {
    const out = this.tvSummary(g);
    const st = g.st;
    out.rounds = st.rounds;
    out.log = st.log.slice(-24);
    const live = g.status === "running";
    out.awaiting = !live ? [] : st.phase === "answer" ? this.tvAnswerers(st).filter((p) => st.answers[p.name] === undefined).map((p) => p.name) : [st.asker];
    out.awaiting_accept = g.status === "lobby" ? st.players.filter((p) => !(st.accepted || {})[p.name]).map((p) => p.name) : [];
    const me = st.players.find((p) => p.name.toLowerCase() === String(who || "").toLowerCase());
    if (!me) {
      out.you = { playing: false };
      return out;
    }
    const asker = live && st.asker === me.name;
    /** @type {import("@chat/contract").TriviaYou} */
    const you = { playing: true, accepted: st.accepted ? !!st.accepted[me.name] : true, asker: asker, balance: st.balance[me.name], max_wager: this.tvMaxWager(st, me.name), legal_moves: [] };
    if (asker) {
      if (st.cur) {
        you.answer = st.cur.answer;
        you.accept = st.cur.accept;
      }
      if (st.phase === "ask") you.legal_moves = ['{"question": "<your question>", "answer": "<the answer>", "accept": ["<another way to say it>"]}'];
      if (st.phase === "judge") {
        you.to_judge = /** @type {import("@chat/contract").TriviaToJudge[]} */ (this.tvUnmatched(st).map((n) => ({ name: n, answer: st.answers[n].answer, accepted: !!st.judged[n] })));
        you.legal_moves = you.to_judge.filter((x) => !x.accepted).map((x) => "accept " + x.name).concat(["done"]);
      }
    } else if (live && st.phase === "answer") {
      you.queued = st.answers[me.name] || null;
      you.legal_moves = ['{"answer": "<your answer>", "wager": <0-' + you.max_wager + '>}'];
    }
    out.you = you;
    return out;
  },

  async createTrivia(creator, playersIn, opts, room) {
    if (!Array.isArray(playersIn) || playersIn.length < 2 || playersIn.length > 6) return { status: 400, error: "Trivia needs 2 to 6 players" };
    const resolved = this.gamePlayers(playersIn);
    if (resolved.error) return resolved;
    const names = resolved.names.slice();
    for (let i = names.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [names[i], names[j]] = [names[j], names[i]];
    }
    const clamp = (v, lo, hi, def) => { const n = Math.floor(Number(v)); return Number.isFinite(n) && n > 0 ? Math.min(hi, Math.max(lo, n)) : def; };
    // about eight questions by default, every player asking equally often
    const rotations = clamp(opts.rotations, 1, 4, Math.max(1, Math.min(4, Math.round(8 / names.length))));
    const roundSeconds = clamp(opts.tick_seconds, 30, 86400, 3600);
    const colors = this.gameColors();
    const players = resolved.names.map((n, i) => ({ name: n, color: colors[i].color, hex: colors[i].hex }));
    const balance = {};
    const prog = {};
    for (const n of names) {
      balance[n] = TV_START;
      prog[n] = { right: 0, wrong: 0, best: 0 };
    }
    const st = {
      type: "trivia", round_seconds: roundSeconds, rotations: rotations, rounds_total: names.length * rotations, round: 1, order: names, asker: names[0], phase: "ask",
      cur: null, answers: {}, judged: {}, phase_at: null, rounds: [], quiet: 0, balance: balance, prog: prog,
      deadline: null, lobby_deadline: Date.now() + this.lobbySeconds(opts) * 1000, accepted: this.lobbyAccepted(creator, resolved.names), players: players,
      log: [{ tick: 0, text: "Trivia created by " + creator + " - quizmasters in this order: " + names.join(", ") + (rotations > 1 ? ", " + rotations + " times round" : "") + ". The clock starts when everyone accepts." }],
      winner: null, places: null, draw: false, announced: false,
    };
    const ins = this.sql.exec("INSERT INTO gm (status, created, created_by, state) VALUES ('lobby', ?, ?, ?) RETURNING id", Date.now(), creator, JSON.stringify(st)).one();
    const g = this.gameRow(ins.id);
    const label = players.map((p) => p.name + " (" + p.color + ")").join(", ");
    const cardText = "Trivia #" + g.id + " - " + label + ". Each round a quizmaster asks a question of their own; everyone else answers and wagers up to " + TV_MAX_WAGER + " of their " + TV_START + " points. " + names[0] + " asks first. Clock: " + clockWords(roundSeconds) + " a phase. Lobby open - the game starts when everyone accepts; tap the card to take your seat.";
    const msg = await this.postGameCard(creator, cardText, g.id, room);
    this.sql.exec("UPDATE gm SET card_msg = ? WHERE id = ?", msg.id, g.id);
    g.card_msg = msg.id;
    this.broadcastGame(g, room, creator);
    await this.armGameAlarm();
    return { status: 201, game: this.tvStateFull(g, creator) };
  },

  // The quizmaster's question: fields {question, answer, accept}, the same
  // as JSON in dir, or "Question? = answer | variant | variant".
  tvParseQuestion(raw, fields) {
    let o = fields && typeof fields.question === "string" ? fields : null;
    const s = String(raw == null ? "" : raw).trim();
    if (!o && s[0] === "{") {
      try { o = JSON.parse(s); } catch (e) { return { error: "dir looked like JSON but did not parse: " + /** @type {Error} */ (e).message }; }
    }
    if (!o && s.indexOf("=") > 0) {
      const at = s.lastIndexOf("=");
      const alts = s.slice(at + 1).split("|").map((x) => x.trim()).filter(Boolean);
      o = { question: s.slice(0, at), answer: alts[0], accept: alts.slice(1) };
    }
    if (!o || typeof o.question !== "string") return { error: "As quizmaster, send question and answer (and accept: other ways to say it), or dir as: Question? = answer | variant" };
    const q = o.question.replace(/\s+/g, " ").trim();
    const a = String(o.answer == null ? "" : o.answer).replace(/\s+/g, " ").trim();
    if (!q) return { error: "The question cannot be empty" };
    if (q.length > TV_Q_MAX) return { error: "A question can be up to " + TV_Q_MAX + " characters" };
    if (!a) return { error: "Send the answer too - it stays sealed until the reveal" };
    if (a.length > TV_A_MAX) return { error: "An answer can be up to " + TV_A_MAX + " characters" };
    const acc = (Array.isArray(o.accept) ? o.accept : typeof o.accept === "string" ? o.accept.split("|") : []).map((x) => String(x == null ? "" : x).replace(/\s+/g, " ").trim()).filter((x) => x && x.length <= TV_A_MAX).slice(0, 5);
    return { q: q, answer: a, accept: acc };
  },

  // An answer and its wager: fields {answer, wager}, JSON in dir, or
  // "answer @ wager" (no wager is 0).
  tvParseAnswer(st, me, raw, fields) {
    let o = fields && typeof fields.answer === "string" ? fields : null;
    const s = String(raw == null ? "" : raw).trim();
    if (!o && s[0] === "{") {
      try { o = JSON.parse(s); } catch (e) { return { error: "dir looked like JSON but did not parse: " + /** @type {Error} */ (e).message }; }
    }
    if (!o) {
      const m = s.match(/^(.*?)\s*@\s*(\S+)\s*$/);
      o = m ? { answer: m[1], wager: m[2] } : { answer: s, wager: 0 };
    }
    const a = String(o.answer == null ? "" : o.answer).replace(/\s+/g, " ").trim();
    if (!a) return { error: "Send an answer (and a wager: answer @ 10)" };
    if (a.length > TV_A_MAX) return { error: "An answer can be up to " + TV_A_MAX + " characters" };
    const max = this.tvMaxWager(st, me.name);
    const w = o.wager == null || o.wager === "" ? 0 : Number(o.wager);
    if (!Number.isInteger(w) || w < 0) return { error: "The wager is a whole number from 0 to " + max };
    if (w > max) return { error: "You can wager at most " + max + (max < TV_MAX_WAGER ? " (your balance)" : "") };
    return { answer: a, wager: w };
  },

  // Answers the lenient match did not take, for the quizmaster to judge.
  tvUnmatched(st) {
    if (!st.cur) return [];
    const keys = [st.cur.answer].concat(st.cur.accept || []);
    return this.tvAnswerers(st).map((p) => p.name).filter((n) => st.answers[n] && !tvMatch(st.answers[n].answer, keys));
  },

  async tvMove(g, who, raw, room, fields) {
    const st = g.st;
    const me = st.players.find((p) => p.name.toLowerCase() === String(who || "").toLowerCase());
    if (!me) return { status: 403, error: "You are not a player in this game" };
    if (st.phase === "ask") {
      if (me.name !== st.asker) return { status: 409, error: st.asker + " is writing this round's question - you answer once it is up" };
      const p = this.tvParseQuestion(raw, fields);
      if (p.error) return { status: 400, error: p.error, legal_moves: ['{"question": "<your question>", "answer": "<the answer>"}'] };
      st.cur = { q: p.q, answer: p.answer, accept: p.accept, at: Date.now() };
      st.phase = "answer";
      st.answers = {};
      st.judged = {};
      st.phase_at = Date.now();
      st.deadline = Date.now() + st.round_seconds * 1000;
      st.log.push({ tick: st.round, text: me.name + " asks: " + p.q });
      this.saveGame(g);
      this.afterGameChange(g, room, me.name);
      await this.armGameAlarm();
      return { status: 200, game: this.tvStateFull(g, who), resolved: false };
    }
    if (st.phase === "judge") {
      if (me.name !== st.asker) return { status: 409, error: st.asker + " is judging the answers that did not match - the reveal follows" };
      const s = String(raw == null ? "" : raw).trim();
      const open = this.tvUnmatched(st);
      let done = /^(done|none|reveal|no|reject(\s+all)?)$/i.test(s);
      if (!done) {
        const m = s.match(/^accept\s+(.+)$/i);
        if (!m) return { status: 400, error: "As quizmaster, accept the answers you count as right (accept NAME, or accept all), then done", legal_moves: open.map((n) => "accept " + n).concat(["done"]) };
        const names = /^all$/i.test(m[1].trim()) ? open : m[1].split(/[,;]+|\s+and\s+/).map((x) => x.trim()).filter(Boolean);
        for (const x of names) {
          const n = open.find((y) => y.toLowerCase() === x.toLowerCase());
          if (!n) return { status: 400, error: "\"" + x + "\" has no answer waiting to be judged - waiting: " + (open.join(", ") || "none"), legal_moves: open.map((y) => "accept " + y).concat(["done"]) };
          st.judged[n] = true;
        }
        done = open.every((n) => st.judged[n]);
      }
      if (done) this.tvResolve(g);
      this.saveGame(g);
      if (done) this.afterGameChange(g, room, "Referee");
      else this.broadcastGame(g, room, me.name);
      await this.armGameAlarm();
      return { status: 200, game: this.tvStateFull(g, who), resolved: done };
    }
    if (me.name === st.asker) return { status: 409, error: "You are the quizmaster this round - the others are answering your question" };
    const a = this.tvParseAnswer(st, me, raw, fields);
    if (a.error) return { status: 400, error: a.error, legal_moves: ['{"answer": "<your answer>", "wager": <0-' + this.tvMaxWager(st, me.name) + '>}'] };
    st.answers[me.name] = { answer: a.answer, wager: a.wager, at: Date.now() };
    const all = this.tvAnswerers(st).every((p) => st.answers[p.name] !== undefined);
    if (all) this.tvClose(g);
    this.saveGame(g);
    if (all) this.afterGameChange(g, room, "Referee");
    else this.broadcastGame(g, room, me.name);
    await this.armGameAlarm();
    return { status: 200, game: this.tvStateFull(g, who), resolved: all && st.phase !== "judge" };
  },

  // Answers are in (or the clock ran out): the quizmaster judges what the
  // match did not take, or the round resolves.
  tvClose(g) {
    const st = g.st;
    const open = this.tvUnmatched(st);
    if (open.length) {
      st.phase = "judge";
      st.judged = {};
      st.deadline = Date.now() + st.round_seconds * 1000;
      st.log.push({ tick: st.round, text: "The answers are in - " + st.asker + " is judging " + open.length + (open.length === 1 ? " answer" : " answers") + " the match did not take." });
    } else this.tvResolve(g);
  },

  tvResolve(g) {
    const st = g.st;
    const keys = [st.cur.answer].concat(st.cur.accept || []);
    /** @type {import("@chat/contract").TriviaRound} */
    const rec = { n: st.round, asker: st.asker, question: st.cur.q, answer: st.cur.answer, accept: st.cur.accept || [], answers: {}, right: [], wrong: [], missed: [], deltas: {}, split: false, bonus: 0, totals: {}, forfeit: false, at: Date.now() };
    for (const p of this.tvAnswerers(st)) {
      const n = p.name;
      const a = st.answers[n];
      if (!a) {
        rec.missed.push(n);
        rec.deltas[n] = 0;
        continue;
      }
      const auto = tvMatch(a.answer, keys);
      const ok = auto || !!st.judged[n];
      const w = Math.min(a.wager, st.balance[n]);
      const d = ok ? w : -w;
      st.balance[n] += d;
      rec.deltas[n] = d;
      rec.answers[n] = { answer: a.answer, wager: w, right: ok, judged: ok && !auto, at: a.at };
      if (ok) {
        rec.right.push(n);
        st.prog[n].right += 1;
        st.prog[n].best = Math.max(st.prog[n].best, w);
      } else {
        rec.wrong.push(n);
        st.prog[n].wrong += 1;
      }
    }
    if (rec.right.length && rec.wrong.length) {
      rec.split = true;
      rec.bonus = TV_SPLIT;
      st.balance[st.asker] += TV_SPLIT;
    }
    rec.deltas[st.asker] = rec.bonus;
    st.players.forEach((p) => (rec.totals[p.name] = st.balance[p.name]));
    st.rounds.push(rec);
    const cast = rec.right.length + rec.wrong.length;
    st.log.push({ tick: st.round, text: "Round " + st.round + ": the answer was " + st.cur.answer + ". " + (rec.right.length ? rec.right.join(", ") + " got it" : "Nobody got it") + (rec.split ? "; the table split - " + st.asker + " +" + TV_SPLIT : "") + "." });
    st.quiet = cast ? 0 : st.quiet + 1;
    this.tvNext(g);
  },

  tvNext(g) {
    const st = g.st;
    st.cur = null;
    st.answers = {};
    st.judged = {};
    const played = st.rounds.some((r) => !r.forfeit && r.right.length + r.wrong.length > 0);
    if (st.quiet >= 2 || st.round >= st.rounds_total) {
      if (!played) {
        g.status = "cancelled";
        st.log.push({ tick: st.round, text: "Two quiet rounds and nothing answered - the game is called off." });
        return;
      }
      g.status = "finished";
      st.winner = this.tvStanding(st);
      st.phase = null;
      st.asker = null;
      st.deadline = null;
      st.log.push({ tick: st.round, text: (st.quiet >= 2 ? "Two quiet rounds in a row - the game ends where it stands. " : "") + (st.winner ? st.winner + " wins." : "A tie at the top - no winner.") });
      return;
    }
    st.round += 1;
    st.asker = this.roleOf(st, st.round);
    st.phase = "ask";
    st.phase_at = Date.now();
    st.deadline = Date.now() + st.round_seconds * 1000;
  },

  tvAdvance(g, room) {
    if (!g || g.status !== "running" || Date.now() < g.st.deadline) return;
    const st = g.st;
    if (st.phase === "ask") {
      st.rounds.push({ n: st.round, asker: st.asker, question: null, answer: null, accept: [], answers: {}, right: [], wrong: [], missed: [], deltas: {}, split: false, bonus: 0, totals: Object.assign({}, st.balance), forfeit: true, at: Date.now() });
      st.log.push({ tick: st.round, text: st.asker + " ran out of time to ask - round " + st.round + " is forfeit." });
      st.quiet += 1;
      this.tvNext(g);
    } else if (st.phase === "answer") this.tvClose(g);
    else this.tvResolve(g);
    this.saveGame(g);
    if (g.status === "cancelled") this.postSystem("Trivia #" + g.id + " is off - two quiet rounds and nothing answered.", room);
    this.afterGameChange(g, room, "Referee");
  },

  tvStanding(st) {
    const P = (n) => st.prog[n];
    st.places = st.players.map((p) => p.name).sort((a, b) => st.balance[b] - st.balance[a] || P(b).right - P(a).right || P(b).best - P(a).best || (a < b ? -1 : 1));
    const [x, y] = st.places;
    const tied = !!y && st.balance[x] === st.balance[y] && P(x).right === P(y).right && P(x).best === P(y).best;
    st.draw = tied;
    return tied ? null : x;
  },

  tvResultText(g) {
    const st = g.st;
    if (!st.places) st.winner = this.tvStanding(st);
    const lines = st.places.map((n) => n + " " + st.balance[n]).join(", ");
    const splits = {};
    st.rounds.forEach((r) => { if (r.split) splits[r.asker] = (splits[r.asker] || 0) + 1; });
    const qm = Object.keys(splits).sort((a, b) => splits[b] - splits[a])[0];
    return "Trivia #" + g.id + " is over - " + (st.winner ? st.winner + " wins with " + st.balance[st.winner] + " points." : "a tie at the top, no winner.") + " " + lines + "." + (qm ? " Best quizmaster: " + qm + " (split the table " + splits[qm] + (splits[qm] === 1 ? " time)." : " times).") : "");
  },
};

export const triviaEngine = {
  name: "Trivia",
  turnWord: "round",
  logTick: (st) => st.round,
  clockSeconds: (st) => st.round_seconds,
  create: (room, creator, players, opts, roomName) => room.createTrivia(creator, players, opts, roomName),
  summary: (room, g) => room.tvSummary(g),
  full: (room, g, who) => room.tvStateFull(g, who),
  move: (room, g, who, dir, roomName, fields) => room.tvMove(g, who, dir, roomName, fields),
  advance: (room, g, roomName) => room.tvAdvance(g, roomName),
  targets: (pub) => (pub.status !== "running" ? [] : pub.phase === "answer" ? (pub.players || []).filter((p) => p.name !== pub.asker && !p.committed).map((p) => p.name) : pub.asker ? [pub.asker] : []),
  card: (g) => ({ id: g.id, type: "trivia", status: g.status, round: g.st.round, rounds_total: g.st.rounds_total, phase: g.status === "running" ? g.st.phase : null, asker: g.status === "running" ? g.st.asker : null, question: g.status === "running" && g.st.cur ? g.st.cur.q : null, winner: g.st.winner || null, draw: !!g.st.draw, players: g.st.players.map((p) => ({ name: p.name, color: p.color, hex: p.hex, balance: g.st.balance[p.name] })) }),
  stateItem: (r, st) => ({ id: r.id, type: "trivia", status: r.status, phase: st.phase, asker: st.asker, turn: (st.round || 0) * 3 + (st.phase === "answer" ? 1 : st.phase === "judge" ? 2 : 0), max_wager: TV_MAX_WAGER, players: (st.players || []).map((p) => ({ name: p.name, alive: true, moved: r.status !== "running" || (st.phase === "answer" ? p.name === st.asker || (st.answers || {})[p.name] !== undefined : p.name !== st.asker), accepted: seatAccepted(st, p) })) }),
  turnOf: (gm) => gm.turn,
  moveHint: (gm, name) => (gm.asker === name ? (gm.phase === "judge" ? "<accept NAME for each answer you count as right, then done>" : '{"question": "<your question>", "answer": "<the answer>", "accept": ["<another way to say it>"]}') : '{"answer": "<your answer>", "wager": <0-' + (gm.max_wager || TV_MAX_WAGER) + ">}"),
  result: (room, g) => room.tvResultText(g),
  rules: (st) =>
    "Trivia: each round one player is the quizmaster (in this order: " + st.order.join(", ") + (st.rotations > 1 ? ", " + st.rotations + " times round" : "") + ", " + st.rounds_total + " rounds) and asks a question of their own - about themselves, the room, anything - with its answer, sealed: send question, answer and optionally accept (other ways to say it), or dir as Question? = answer | variant. " +
    "Everyone else sends an answer and a wager, 0 to " + TV_MAX_WAGER + " (no more than you have; everyone starts with " + TV_START + "): send answer and wager, or dir as answer @ wager. Answers are sealed until the round resolves. A right answer gains its wager, a wrong one loses it, no answer is 0. " +
    "Matching is lenient - case, punctuation, articles, number words and a one-letter typo don't matter - and anything it misses goes to the quizmaster to judge (accept NAME, then done), on their honour. The quizmaster sits the round out but scores " + TV_SPLIT + " when the table splits (someone right, someone wrong), so ask something answerable but not easy. " +
    "Each phase has " + clockWords(st.round_seconds || 3600) + ": a quizmaster who runs out forfeits the round; two quiet rounds in a row end the game. Highest balance wins; ties go to more right answers, then the biggest winning wager.",
};
