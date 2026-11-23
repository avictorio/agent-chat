// Twenty Questions: a rotating answerer keeps a secret, everyone asks yes/no questions.

import { clockWords, dataLines, foldRaw, foldWords, seatAccepted } from "./shared.js";
import TQ_SECRETS_TXT from "../data/twenty-secrets.txt";
import type { GameLogLine, TwentyQuestion, TwentyRound, TwentyState, TwentyYou } from "@chat/contract";
import type { GmRow, Room } from "../room/Room.js";
import type { GameRow } from "../room/games.js";
import type { GameEngineOf } from "./engine.js";
import { randInt } from "../lib/random.js";

/** A seat as createTwenty stores it (st.players). */
export type TqSeat = { name: string, color: string, hex: string };
/** Twenty Questions' stored match state (g.st): what createTwenty builds
 *  and the moves and the clock change. tqSummary and tqStateFull turn it
 *  into the contract's TwentyState. answerer stays the last one once the
 *  match is over (phase is null then); secret is null until chosen or
 *  drawn; qa is this round's log (stored as the API shows it) and pending
 *  the number of the question waiting on an answer (see tqPending). */
export type TqStored = {
  type: "twenty", round_seconds: number, rotations: number, rounds_total: number, round: number, order: string[],
  answerer: string, phase: "secret" | "ask" | "answer" | null, secret: string | null, drawn: boolean, qa: TwentyQuestion[],
  pending: { n: number } | null, asked: number, idle: number, rounds: TwentyRound[],
  deadline: number | null, lobby_deadline: number, accepted: Record<string, boolean>, players: TqSeat[], log: GameLogLine[],
  winner: string | null, places: string[] | null, draw: boolean, announced: boolean, declined_by?: string, ended?: number
};
/** A Twenty Questions match: its row, with the state typed. */
export type TqGame = Omit<GameRow, "st"> & { st: TqStored };

// Twenty Questions: the drawn secrets (a data file), the budget and caps.
export const TQ_BUDGET = 20;
export const TQ_Q_MAX = 160;
export const TQ_SECRET_MAX = 60;
export let tqSecretsCache: string[] | null = null;
export function tqSecrets() {
  if (!tqSecretsCache) tqSecretsCache = dataLines(TQ_SECRETS_TXT);
  return tqSecretsCache;
}
// "A Lighthouse!" and "lighthouse" name the same secret. An exact guess
// wins on its own, with no say for the answerer, so accents count here:
// "avô" (grandfather) is not "avó" (grandmother). An ASCII-only fold made
// both "av", so the wrong guess won the round. A close guess is the
// answerer's call. A secret with no letters or digits (an emoji) is
// compared as typed.
const TQ_FILLER = ["a", "an", "the", "it", "is", "its"];
export function tqNorm(s: unknown) {
  const words = foldWords(s, true);
  if (!words.length) return foldRaw(s);
  const kept = words.filter((w) => !TQ_FILLER.includes(w));
  return (kept.length ? kept : words).join(" ");
}

export const TwentyMethods = {
  /* ---------- games: Twenty Questions ----------
     Player rules: rules() below. Secrecy: the secret reaches only the
     answerer (you.secret) until the round ends; "random" draws one from
     worker/data/twenty-secrets.txt. The answerer role passes in seat
     order (roleOf). A close guess is the answerer's call, on their
     honour - the public Q/A log and the revealed secret are the court of
     appeal. The questioners' share of the questions left is rounded
     down. */
  tqQuestioners(st: TqStored) {
    return st.players.filter((p) => p.name !== st.answerer).map((p) => p.name);
  },

  tqTotals(st: TqStored) {
    const t: Record<string, number> = {};
    for (const p of st.players) t[p.name] = 0;
    for (const r of st.rounds) for (const n of Object.keys(r.points || {})) t[n] += r.points[n];
    return t;
  },

  tqSummary(g: TqGame): TwentyState {
    const st = g.st;
    const live = g.status === "running";
    const t = this.tqTotals(st);
    return {
      id: g.id, type: "twenty", status: g.status, created_by: g.created_by, card_msg: g.card_msg,
      round: st.round, rounds_total: st.rounds_total, rotations: st.rotations, phase: live ? st.phase : null, answerer: live ? st.answerer : null,
      round_seconds: st.round_seconds, deadline: st.deadline, lobby_deadline: g.status === "lobby" ? (st.lobby_deadline || null) : null, order: st.order,
      budget: TQ_BUDGET, asked: st.asked, remaining: TQ_BUDGET - st.asked, mode: st.players.length === 2 ? "duel" : "table",
      qa: st.qa, pending: this.tqPending(st),
      last_round: st.rounds.length ? st.rounds[st.rounds.length - 1] : null,
      winner: st.winner || null, draw: !!st.draw, places: st.places || null, declined_by: st.declined_by || null,
      players: st.players.map((p) => ({ name: p.name, color: p.color, hex: p.hex, accepted: st.accepted ? !!st.accepted[p.name] : true, score: t[p.name] || 0, asked: st.qa.filter((x) => x.by === p.name && !x.flagged).length })),
    };
  },

  tqStateFull(g: TqGame, who: string | null | undefined): TwentyState {
    const out = this.tqSummary(g);
    const st = g.st;
    out.rounds = st.rounds;
    out.log = st.log.slice(-24);
    const live = g.status === "running";
    out.awaiting = !live ? [] : st.phase === "ask" ? this.tqQuestioners(st) : [st.answerer];
    out.awaiting_accept = g.status === "lobby" ? st.players.filter((p) => !(st.accepted || {})[p.name]).map((p) => p.name) : [];
    const me = st.players.find((p) => p.name.toLowerCase() === String(who || "").toLowerCase());
    if (!me) {
      out.you = { playing: false };
      return out;
    }
    const you: TwentyYou = { playing: true, accepted: st.accepted ? !!st.accepted[me.name] : true, answerer: live && st.answerer === me.name, legal_moves: [] };
    if (you.answerer) {
      you.secret = st.secret || null;
      const pend = this.tqPending(st);
      you.legal_moves = st.phase === "secret" ? ["<your secret: a noun phrase>", "random"] : st.phase === "answer" ? (pend && pend.kind === "guess" ? ["right", "wrong"] : ["yes", "no", "unanswerable"]) : [];
    } else if (live && st.phase === "ask") you.legal_moves = ["<a yes/no question>", "guess: <your answer>"];
    out.you = you;
    return out;
  },

  /** @param opts the create's options (request JSON) */
  async createTwenty(creator: string, playersIn: unknown[], opts: Record<string, unknown>, room: string) {
    if (!Array.isArray(playersIn) || playersIn.length < 2 || playersIn.length > 6) return { status: 400, error: "Twenty Questions needs 2 to 6 players" };
    const resolved = this.gamePlayers(playersIn);
    if (resolved.error) return resolved;
    const names = (resolved.names as string[]).slice(); // gamePlayers sets names whenever it sets no error
    for (let i = names.length - 1; i > 0; i--) {
      const j = randInt(i + 1);
      [names[i], names[j]] = [names[j], names[i]];
    }
    const clamp: (v: unknown, lo: number, hi: number, def: number) => number = (v, lo, hi, def): number => { const n = Math.floor(Number(v)); return Number.isFinite(n) && n > 0 ? Math.min(hi, Math.max(lo, n)) : def; };
    const rotations = clamp(opts.rotations, 1, 3, 1);
    const roundSeconds = clamp(opts.tick_seconds, 30, 86400, 3600);
    const colors = this.gameColors();
    const players = (resolved.names as string[]).map((n, i) => ({ name: n, color: colors[i].color, hex: colors[i].hex }));
    const st: TqStored = {
      type: "twenty", round_seconds: roundSeconds, rotations: rotations, rounds_total: names.length * rotations, round: 1, order: names, answerer: names[0], phase: "secret",
      secret: null, drawn: false, qa: [], pending: null, asked: 0, idle: 0, rounds: [],
      deadline: null, lobby_deadline: Date.now() + this.lobbySeconds(opts) * 1000, accepted: this.lobbyAccepted(creator, resolved.names), players: players,
      log: [{ tick: 0, text: "Twenty Questions created by " + creator + " - answerers in this order: " + names.join(", ") + (rotations > 1 ? ", " + rotations + " times round" : "") + ". The clock starts when everyone accepts." }],
      winner: null, places: null, draw: false, announced: false,
    };
    const ins = this.sql.exec<Pick<GmRow, "id">>("INSERT INTO gm (status, created, created_by, state) VALUES ('lobby', ?, ?, ?) RETURNING id", Date.now(), creator, JSON.stringify(st)).one();
    const g = this.gameRowOf<TqStored>(ins.id, "twenty")!; // the row just inserted
    const label = players.map((p) => p.name + " (" + p.color + ")").join(", ");
    const cardText = "Twenty Questions #" + g.id + " - " + label + ". Each round one player holds a secret and " + (names.length === 2 ? "the other" : "the rest of the table") + " gets twenty yes-or-no questions to name it. " + names[0] + " answers first. Clock: " + clockWords(roundSeconds) + " a move. Lobby open - the game starts when everyone accepts; tap the card to take your seat.";
    const msg = await this.postGameCard(creator, cardText, g.id, room);
    this.sql.exec("UPDATE gm SET card_msg = ? WHERE id = ?", msg.id, g.id);
    g.card_msg = msg.id;
    this.broadcastGame(g, room, creator);
    await this.armGameAlarm();
    return { status: 201, game: this.tqStateFull(g, creator) };
  },

  // the question waiting on an answer (st.pending keeps only its number:
  // a saved state reloads as fresh objects, so a second reference would
  // drift from the log)
  tqPending(st: TqStored) {
    return st.pending ? st.qa.find((x) => x.n === (st.pending as { n: number }).n) || null : null;
  },

  tqDraw(st: TqStored) {
    const pool = tqSecrets();
    st.secret = pool[randInt(pool.length)];
    st.drawn = true;
  },

  // the ask phase opens (again): a fresh clock for the table
  tqOpen(st: TqStored) {
    st.phase = "ask";
    st.pending = null;
    st.deadline = Date.now() + st.round_seconds * 1000;
  },

  // Close the round: score it, then the next answerer or the end.
  /** @param guessedBy who named it (guessed) */
  tqEndRound(g: TqGame, how: TwentyRound["how"], guessedBy?: string) {
    const st = g.st;
    const qs = this.tqQuestioners(st);
    const points: Record<string, number> = {};
    let side: TwentyRound["side"] = "answerer";
    if (how === "guessed" || how === "forfeit") {
      side = "questioners";
      const left = Math.max(0, TQ_BUDGET - st.asked);
      const each = Math.floor(left / Math.max(1, qs.length));
      qs.forEach((n) => (points[n] = each));
    } else points[st.answerer] = 10;
    // a round ends only after its secret is chosen or drawn
    st.rounds.push({ n: st.round, answerer: st.answerer, secret: st.secret as string, drawn: !!st.drawn, qa: st.qa, asked: st.asked, side: side, how: how, guessed_by: guessedBy || null, points: points, at: Date.now() });
    st.log.push({ tick: st.round, text: "Round " + st.round + ": the secret was \"" + st.secret + "\" - " + (how === "guessed" ? guessedBy + " named it with " + (TQ_BUDGET - st.asked) + " questions left" : how === "forfeit" ? st.answerer + " went silent and forfeits the round" : how === "idle" ? "the table stopped asking; " + st.answerer + " takes it" : "twenty questions spent; " + st.answerer + " takes it") + "." });
    if (st.round >= st.rounds_total) {
      g.status = "finished";
      st.phase = null;
      st.pending = null;
      st.deadline = null;
      st.winner = this.tqStanding(st);
      st.log.push({ tick: st.round, text: st.winner ? st.winner + " wins." : "A tie at the top - no winner." });
      return;
    }
    st.round += 1;
    st.answerer = this.roleOf(st, st.round);
    st.phase = "secret";
    st.secret = null;
    st.drawn = false;
    st.qa = [];
    st.pending = null;
    st.asked = 0;
    st.idle = 0;
    st.deadline = Date.now() + st.round_seconds * 1000;
  },

  tqStanding(st: TqStored) {
    const t = this.tqTotals(st);
    st.places = st.players.map((p) => p.name).sort((a, b) => t[b] - t[a] || (a < b ? -1 : 1));
    const [x, y] = st.places;
    st.draw = !!y && t[x] === t[y];
    return st.draw ? null : x;
  },

  async tqMove(g: TqGame, who: string, raw: unknown, room: string) {
    const st = g.st;
    const me = st.players.find((p) => p.name.toLowerCase() === String(who || "").toLowerCase());
    if (!me) return { status: 403, error: "You are not a player in this game" };
    const text = String(raw || "").replace(/\s+/g, " ").trim();
    const done = async (resolved: boolean) => {
      this.saveGame(g);
      this.afterGameChange(g, room, me.name);
      await this.armGameAlarm();
      return { status: 200, game: this.tqStateFull(g, who), resolved: resolved };
    };
    if (st.answerer === me.name) {
      if (st.phase === "secret") {
        if (!text) return { status: 400, error: "Send your secret (a noun phrase), or random to draw one", legal_moves: ["random"] };
        if (/^random$/i.test(text)) this.tqDraw(st);
        else {
          if (text.length > TQ_SECRET_MAX) return { status: 400, error: "A secret can be up to " + TQ_SECRET_MAX + " characters" };
          st.secret = text;
          st.drawn = false;
        }
        st.log.push({ tick: st.round, text: me.name + " holds a secret - start asking." });
        this.tqOpen(st);
        return done(false);
      }
      if (st.phase !== "answer") return { status: 409, error: "Waiting for a question - you answer once one is asked" };
      const s = text.toLowerCase().replace(/[.!]+$/, "");
      const m = s.match(/^(yes|no|right|wrong|correct|unanswerable|flag)\b\s*[-:,]?\s*(.*)$/);
      const p = this.tqPending(st);
      if (!p) return { status: 409, error: "No question is waiting" };
      if (!m) return { status: 400, error: p.kind === "guess" ? "Answer the guess: right or wrong" : "Answer yes or no (or unanswerable, which costs the asker nothing)", legal_moves: p.kind === "guess" ? ["right", "wrong"] : ["yes", "no", "unanswerable"] };
      const word = m[1] === "correct" ? "right" : m[1] === "flag" ? "unanswerable" : m[1];
      const note = text.slice(m[1].length).replace(/^\s*[-:,]?\s*/, "").slice(0, 80) || null;
      if (word === "unanswerable") {
        p.flagged = true;
        p.a = null;
        st.log.push({ tick: st.round, text: me.name + " flagged " + p.by + "'s question as unanswerable - it costs nothing; ask again." });
        this.tqOpen(st);
        return done(false);
      }
      const isGuess = p.kind === "guess";
      const yes = word === "yes" || word === "right";
      p.a = isGuess ? (yes ? "right" : "wrong") : yes ? "yes" : "no";
      p.note = note;
      st.asked += 1;
      st.idle = 0;
      if (isGuess && yes) {
        this.tqEndRound(g, "guessed", p.by);
        return done(true);
      }
      if (st.asked >= TQ_BUDGET) {
        this.tqEndRound(g, "budget");
        return done(true);
      }
      this.tqOpen(st);
      return done(false);
    }
    // a questioner
    if (st.phase === "secret") return { status: 409, error: st.answerer + " is choosing a secret" };
    if (st.phase === "answer") return { status: 409, error: "A question is waiting on " + st.answerer + "'s answer" };
    // only "guess: X" (or "guess - X") is a guess - "is it alive?" is an
    // ordinary question. The word must end and the separator is required:
    // without both, "Guessing it is bigger than a breadbox?" was stored as
    // the guess "ing it is bigger...", and a "yes" to it ended the round.
    // A hyphen counts only with a space on each side: right after the word
    // it joins a word, and "Guess-timate: is it heavy?" was read as a guess.
    const gm = text.match(/^guess(?:\s*:|\s+-\s)\s*(.+)$/i);
    const isGuess = !!gm;
    const body = gm ? gm[1].trim() : text.replace(/^(ask|question)\s*[:-]\s*/i, "");
    if (!body) return { status: 400, error: "Ask a yes/no question, or guess: <your answer>", legal_moves: ["<a yes/no question>", "guess: <your answer>"] };
    if (body.length > TQ_Q_MAX) return { status: 400, error: "A question can be up to " + TQ_Q_MAX + " characters" };
    const entry: TwentyQuestion = { n: st.qa.length + 1, by: me.name, kind: isGuess ? "guess" : "q", q: body, a: null, note: null, flagged: false, at: Date.now() };
    st.qa.push(entry);
    // an exact guess is right on its own
    if (isGuess && tqNorm(body) && tqNorm(body) === tqNorm(st.secret)) {
      entry.a = "right";
      entry.auto = true;
      st.asked += 1;
      this.tqEndRound(g, "guessed", me.name);
      return done(true);
    }
    st.pending = { n: entry.n };
    st.phase = "answer";
    st.deadline = Date.now() + st.round_seconds * 1000;
    st.log.push({ tick: st.round, text: me.name + (isGuess ? " guesses" : " asks") + " (question " + (st.asked + 1) + " of " + TQ_BUDGET + ")." });
    return done(false);
  },

  tqAdvance(g: TqGame | null, room: string) {
    if (!g || g.status !== "running" || Date.now() < (g.st.deadline as number)) return; // a running match's clock is set
    const st = g.st;
    if (st.phase === "secret") {
      this.tqDraw(st);
      st.log.push({ tick: st.round, text: st.answerer + " ran out of time to choose - a secret was drawn for them." });
      this.tqOpen(st);
    } else if (st.phase === "answer") {
      st.log.push({ tick: st.round, text: st.answerer + " went silent on a question - the round is forfeit." });
      this.tqEndRound(g, "forfeit");
    } else {
      st.idle += 1;
      if (st.idle >= 3) this.tqEndRound(g, "idle");
      else {
        st.log.push({ tick: st.round, text: "Nobody asked for a whole clock (" + st.idle + " of 3) - the round waits; anyone may ask." });
        this.tqOpen(st);
      }
    }
    this.saveGame(g);
    this.afterGameChange(g, room, "Referee");
  },

  tqResultText(g: TqGame) {
    const st = g.st;
    if (!st.places) st.winner = this.tqStanding(st);
    const t = this.tqTotals(st);
    const lines = (st.places as string[]).map((n) => n + " " + t[n]).join(", "); // tqStanding sets places
    const quick = st.rounds.filter((r) => r.how === "guessed").sort((a, b) => a.asked - b.asked)[0];
    return "Twenty Questions #" + g.id + " is over - " + (st.winner ? st.winner + " wins with " + t[st.winner] + " points." : "a tie at the top, no winner.") + " " + lines + "." + (quick ? " Quickest: \"" + quick.secret + "\" named by " + quick.guessed_by + " in " + quick.asked + "." : "");
  },
} satisfies ThisType<Room>;

export const twentyEngine = {
  name: "Twenty Questions",
  turnWord: "round",
  logTick: (st: TqStored) => st.round,
  clockSeconds: (st: TqStored) => st.round_seconds,
  create: (room, creator, players, opts, roomName) => room.createTwenty(creator, players, opts, roomName),
  summary: (room, g) => room.tqSummary(g),
  full: (room, g, who) => room.tqStateFull(g, who),
  move: (room, g, who, dir, roomName) => room.tqMove(g, who, dir, roomName),
  advance: (room, g, roomName) => room.tqAdvance(g, roomName),
  targets: (pub: TwentyState) => (pub.status !== "running" ? [] : pub.phase === "ask" ? (pub.players || []).filter((p) => p.name !== pub.answerer).map((p) => p.name) : pub.answerer ? [pub.answerer] : []),
  card: (g: TqGame) => {
    const t: Record<string, number> = {};
    for (const p of g.st.players) t[p.name] = 0;
    for (const r of g.st.rounds) for (const n of Object.keys(r.points || {})) t[n] += r.points[n];
    return { id: g.id, type: "twenty", status: g.status, round: g.st.round, rounds_total: g.st.rounds_total, phase: g.status === "running" ? g.st.phase : null, answerer: g.status === "running" ? g.st.answerer : null, asked: g.st.asked, budget: TQ_BUDGET, winner: g.st.winner || null, draw: !!g.st.draw, players: g.st.players.map((p) => ({ name: p.name, color: p.color, hex: p.hex, score: t[p.name] || 0 })) };
  },
  stateItem: (r, st: TqStored) => ({ id: r.id, type: "twenty", status: r.status, phase: st.phase, answerer: st.answerer, turn: (st.round || 0) * 100 + (st.asked || 0) * 2 + (st.phase === "answer" ? 1 : 0), players: (st.players || []).map((p) => ({ name: p.name, alive: true, moved: r.status !== "running" || (st.phase === "ask" ? p.name === st.answerer : p.name !== st.answerer), accepted: seatAccepted(st, p) })) }),
  turnOf: (gm) => Number(gm.turn),
  moveHint: (gm, name) => (gm.answerer === name ? (gm.phase === "secret" ? "<your secret: a noun phrase, or random>" : "<yes or no; a guess: right or wrong; or unanswerable>") : "<a yes/no question, or guess: your answer>"),
  result: (room, g) => room.tqResultText(g),
  rules: (st: TqStored) =>
    "Twenty Questions: each round one player is the answerer (in this order: " + st.order.join(", ") + (st.rotations > 1 ? ", " + st.rotations + " times round" : "") + ") and holds a secret - a noun phrase they choose, or one drawn at random - hidden until the round ends. " +
    (st.players.length === 2 ? "The other player questions. " : "Everyone else questions together: any of you may ask when no question is waiting. ") +
    "Twenty questions a round, guesses included; the whole Q/A log is public. An exact guess is right on its own, a close one is the answerer's call, and a question flagged unanswerable costs nothing. " +
    "A right guess scores the questions left for the questioners, split evenly; twenty spent scores 10 for the answerer. Each move has " + clockWords(st.round_seconds || 3600) + ": a secret not chosen in time is drawn, a silent answerer forfeits the round (the questioners score as if they had guessed), and three clocks with no question hand the round to the answerer. Highest total wins. " +
    "Send: as the answerer, dir is first your secret (or random), then yes or no to each question (right or wrong to a guess, or unanswerable), with an optional note after a dash; as a questioner, dir is a yes/no question, or guess: <answer>.",
} satisfies GameEngineOf<TqStored>;
