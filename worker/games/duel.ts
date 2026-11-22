// Duel: rock-paper-scissors, first to N, simultaneous throws.

import { clockWords, seatAccepted } from "./shared.js";
import type { DuelH2H, DuelRound, DuelState, DuelThrow, GameLogLine } from "@chat/contract";
import type { GmRow, Room } from "../room/Room.js";
import type { GameRow } from "../room/games.js";
import type { GameEngineOf } from "./engine.js";
import type { Body } from "../lib/http.js";

/** A duellist's seat. */
export type DuelSeat = { name: string, color: string, hex: string };
/** The Duel's stored match state (g.st; the API's DuelState is built from
 *  it). pending holds the round's secret throws and pending_at when each
 *  came in (missing on duels from before it was kept); rounds are the
 *  resolved rounds, as the API sends them. */
export type DuelSt = {
  type: "duel",
  best_of: number,
  target: number,
  round_seconds: number,
  round: number,
  deadline: number | null,
  lobby_deadline: number,
  accepted: Record<string, boolean>,
  players: DuelSeat[],
  score: Record<string, number>,
  rounds: DuelRound[],
  pending: Record<string, DuelThrow>,
  pending_at?: Record<string, number>,
  log: GameLogLine[],
  winner: string | null,
  announced: boolean,
  declined_by?: string,
  ended?: number,
};
/** A duel: its gm row with the state typed. */
export type DuelGame = Omit<GameRow, "st"> & { st: DuelSt };

// The default round deadline. It is the anti-stall clock, not a play
// clock (a round normally ends the moment both throws are in): an agent's
// wake-to-act cycle runs one to two minutes, so a shorter round 1 could
// end a duel before a woken player ever threw.
const DUEL_ROUND_DEFAULT = 180;

export const DuelMethods = {
  /* ---------- games: Duel (rock-paper-scissors) ----------
     Player rules: rules() below. Secrecy: a throw is secret until its
     round resolves - no view of the state (summary, full state, stream
     frame) ever carries a pending throw, only that it exists. The round
     deadline runs on the room's game alarm, like Light Cycles' tick. */
  duelBeats(a: DuelThrow, b: DuelThrow) {
    return (a === "rock" && b === "scissors") || (a === "scissors" && b === "paper") || (a === "paper" && b === "rock");
  },

  duelSummary(g: DuelGame): DuelState {
    const st = g.st;
    return {
      id: g.id, type: "duel", status: g.status, created_by: g.created_by, card_msg: g.card_msg,
      round: st.round, best_of: st.best_of, target: st.target, round_seconds: st.round_seconds, deadline: st.deadline, lobby_deadline: g.status === "lobby" ? (st.lobby_deadline || null) : null,
      score: st.score, winner: st.winner || null, declined_by: st.declined_by || null,
      players: st.players.map((p) => ({ name: p.name, color: p.color, hex: p.hex, wins: st.score[p.name] || 0, accepted: st.accepted ? !!st.accepted[p.name] : true, thrown: !!st.pending[p.name] })),
    };
  },

  // The pair's finished-duel record in this room, this match included
  // when it is over: the result means more next to the rivalry.
  duelH2H(st: DuelSt): DuelH2H | null {
    const pair = st.players.map((p) => p.name).sort().join("|");
    const tally: Record<string, number> = {};
    let total = 0;
    for (const r of this.sql.exec<Pick<GmRow, "state">>("SELECT state FROM gm WHERE status = 'finished'").toArray()) {
      try {
        // any finished match's state, of any game, until the checks below
        const s = JSON.parse(r.state || "{}");
        if (s.type !== "duel" || !s.winner || !Array.isArray(s.players)) continue;
        if (s.players.map((p: DuelSeat) => p.name).sort().join("|") !== pair) continue;
        tally[s.winner] = (tally[s.winner] || 0) + 1;
        total++;
      } catch { /* a row that does not parse is not a duel */ }
    }
    return total ? { tally: tally, total: total } : null;
  },

  /** @param who the viewer */
  duelStateFull(g: DuelGame, who: string | null | undefined): DuelState {
    const out = this.duelSummary(g);
    const st = g.st;
    out.rounds = st.rounds;
    out.h2h = this.duelH2H(st);
    out.log = st.log.slice(-24);
    out.awaiting = g.status === "running" ? st.players.filter((p) => !st.pending[p.name]).map((p) => p.name) : [];
    out.awaiting_accept = g.status === "lobby" ? st.players.filter((p) => !(st.accepted || {})[p.name]).map((p) => p.name) : [];
    const me = st.players.find((p) => p.name.toLowerCase() === String(who || "").toLowerCase());
    // Your own throw is yours to see; the rival's stays hidden until the round resolves.
    out.you = me ? { playing: true, accepted: st.accepted ? !!st.accepted[me.name] : true, queued: st.pending[me.name] || null, legal_moves: g.status === "running" ? ["rock", "paper", "scissors"] : [] } : { playing: false };
    return out;
  },

  // One round's resolution: both throws in (played), or a deadline forfeit
  // for the player who never threw. Ties score nobody and play moves on.
  resolveDuelRound(g: DuelGame) {
    const st = g.st;
    const n = st.round;
    const at = Date.now();
    const a = st.players[0], b = st.players[1];
    const ta = st.pending[a.name], tb = st.pending[b.name];
    let winner: string | null = null;
    let note = "";
    if (ta && tb) {
      if (ta !== tb) winner = this.duelBeats(ta, tb) ? a.name : b.name;
      note = a.name + " " + ta + " vs " + b.name + " " + tb + (winner ? " - " + winner + " takes the round." : " - level, no score.");
    } else if (ta || tb) {
      winner = ta ? a.name : b.name;
      note = winner + " takes the round by forfeit - " + (ta ? b.name : a.name) + " never threw.";
    }
    const entry: DuelRound = { n: n, throws: {}, winner: winner, at: at, throws_at: {} };
    if (ta) { entry.throws[a.name] = ta; entry.throws_at[a.name] = (st.pending_at || {})[a.name] || null; }
    if (tb) { entry.throws[b.name] = tb; entry.throws_at[b.name] = (st.pending_at || {})[b.name] || null; }
    st.rounds.push(entry);
    if (winner) st.score[winner] = (st.score[winner] || 0) + 1;
    st.log.push({ tick: n, text: "Round " + n + ": " + note + " Score " + a.name + " " + (st.score[a.name] || 0) + " - " + (st.score[b.name] || 0) + " " + b.name + "." });
    st.pending = {};
    st.pending_at = {};
    st.round += 1;
    if (winner && st.score[winner] >= st.target) {
      g.status = "finished";
      st.winner = winner;
      st.log.push({ tick: st.round, text: winner + " takes the duel." });
    } else {
      st.deadline = at + st.round_seconds * 1000;
    }
  },

  // The duel's clock: at the deadline, a lone throw wins its round by
  // forfeit; a round with no throws at all ends the match where it stands
  // (the score leader, if any, takes it) - a duel never ticks forever.
  advanceDuel(g: DuelGame | null, room: string) {
    if (!g || g.status !== "running") return;
    // a running duel always has its round deadline
    if (Date.now() < (g.st.deadline as number)) return;
    const st = g.st;
    const thrown = st.players.filter((p) => st.pending[p.name]).length;
    if (thrown === 0) {
      if (st.round === 1) {
        // An unthrown round 1 means the match never really started:
        // call it off (cancelled, no result on anyone's record) rather
        // than record a phantom 0-0 finish.
        g.status = "cancelled";
        st.log.push({ tick: st.round, text: "Round 1 went unthrown - the duel is called off." });
        this.saveGame(g);
        this.postSystem("Duel match #" + g.id + " is off - round 1 went unthrown.", room);
        this.afterGameChange(g, room, "Referee");
        return;
      }
      g.status = "finished";
      const a = st.players[0], b = st.players[1];
      const sa = st.score[a.name] || 0, sb = st.score[b.name] || 0;
      st.winner = sa === sb ? null : (sa > sb ? a.name : b.name);
      st.log.push({ tick: st.round, text: "Round " + st.round + " went unthrown - the duel ends where it stands." });
      this.saveGame(g);
      this.afterGameChange(g, room, "Referee");
      return;
    }
    this.resolveDuelRound(g);
    this.saveGame(g);
    this.afterGameChange(g, room, "Referee");
  },

  // The Referee's result post for a duel (duelEngine.result).
  duelResultText(g: DuelGame) {
    const a = g.st.players[0], b = g.st.players[1];
    const sa = g.st.score[a.name] || 0, sb = g.st.score[b.name] || 0;
    const forfeits = g.st.rounds.filter((rd) => g.st.players.some((p) => !(rd.throws || {})[p.name])).length;
    return "Duel match #" + g.id + " is over - " + (g.st.winner ? g.st.winner + " takes the duel " + Math.max(sa, sb) + "-" + Math.min(sa, sb) + " over " + (g.st.winner === a.name ? b.name : a.name) + "." : "no winner; the score stood " + a.name + " " + sa + " - " + sb + " " + b.name + ".") + " Rounds played: " + g.st.rounds.length + (forfeits ? " (" + forfeits + " by forfeit)" : "") + ".";
  },

  /** @param opts the create's options (best_of, tick_seconds, lobby_seconds) */
  async createDuel(creator: string, playersIn: unknown[], opts: Body, room: string) {
    if (!Array.isArray(playersIn) || playersIn.length !== 2) return { status: 400, error: "a duel needs exactly 2 players" };
    const resolved = this.gamePlayers(playersIn);
    if (resolved.error) return resolved;
    const names = resolved.names as string[]; // gamePlayers sets names whenever it sets no error
    let bestOf = Math.floor(Number(opts && opts.best_of) || 5);
    bestOf = Math.min(9, Math.max(1, bestOf));
    const target = Math.floor(bestOf / 2) + 1;
    // tick_seconds is the round deadline here (default and why: DUEL_ROUND_DEFAULT)
    let roundSeconds = Math.floor(Number(opts && opts.tick_seconds) || 0);
    if (!roundSeconds) roundSeconds = DUEL_ROUND_DEFAULT;
    roundSeconds = Math.min(86400, Math.max(30, roundSeconds));
    const colors = this.gameColors();
    const players = names.map((n, i) => ({ name: n, color: colors[i].color, hex: colors[i].hex }));
    const score: Record<string, number> = {};
    for (const n of names) score[n] = 0;
    const st: DuelSt = {
      type: "duel", best_of: bestOf, target: target, round_seconds: roundSeconds, round: 1,
      deadline: null, lobby_deadline: Date.now() + this.lobbySeconds(opts) * 1000, accepted: this.lobbyAccepted(creator, names), players: players, score: score,
      rounds: [], pending: {}, pending_at: {},
      log: [{ tick: 0, text: "Duel created by " + creator + " - " + names.join(" vs ") + ", first to " + target + ". The clock starts when both players accept." }],
      winner: null, announced: false,
    };
    const ins = this.sql.exec<Pick<GmRow, "id">>("INSERT INTO gm (status, created, created_by, state) VALUES ('lobby', ?, ?, ?) RETURNING id", Date.now(), creator, JSON.stringify(st)).one();
    const g = this.gameRowOf<DuelSt>(ins.id, "duel")!; // the row just inserted
    const label = players.map((p) => p.name + " (" + p.color + ")").join(" vs ");
    const cardText = "Duel match #" + g.id + " - " + label + ". Rock-paper-scissors, first to " + target + ". Round clock: " + (roundSeconds >= 3600 ? Math.round(roundSeconds / 3600) + " h" : Math.max(1, Math.round(roundSeconds / 60)) + " min") + ". Lobby open - the match starts when both players accept; tap the card to take your seat.";
    const msg = await this.postGameCard(creator, cardText, g.id, room);
    this.sql.exec("UPDATE gm SET card_msg = ? WHERE id = ?", msg.id, g.id);
    g.card_msg = msg.id;
    this.broadcastGame(g, room, creator);
    await this.armGameAlarm();
    return { status: 201, game: this.duelStateFull(g, creator) };
  },

  // A duel throw (the moves endpoint's dir carries it: rock, paper or
  // scissors). You may change your throw until the round resolves; the
  // rival sees only that you have thrown, never what.
  /** @param thr the throw, as sent */
  async duelMove(g: DuelGame, who: string, thr: unknown, room: string) {
    const st = g.st;
    const me = st.players.find((p) => p.name.toLowerCase() === String(who || "").toLowerCase());
    if (!me) return { status: 403, error: "You are not a player in this duel" };
    const t = String(thr || "").toLowerCase();
    if (["rock", "paper", "scissors"].indexOf(t) < 0) return { status: 400, error: "throw must be one of rock, paper, scissors", legal_moves: ["rock", "paper", "scissors"] };
    st.pending[me.name] = (t as DuelThrow); // one of the three, checked above
    if (!st.pending_at) st.pending_at = {};
    st.pending_at[me.name] = Date.now();
    let resolved = false;
    if (st.players.every((p) => st.pending[p.name])) {
      this.resolveDuelRound(g);
      resolved = true;
    }
    this.saveGame(g);
    // Same cadence as Light Cycles: a frame per throw (from the thrower,
    // targets who still owes), and the round-opening frame speaks as
    // the Referee.
    if (resolved) this.afterGameChange(g, room, "Referee");
    else this.broadcastGame(g, room, who);
    await this.armGameAlarm();
    return { status: 200, game: this.duelStateFull(g, who), resolved: resolved };
  },
} satisfies ThisType<Room>;

export const duelEngine = {
  name: "Duel",
  turnWord: "round",
  logTick: (st: DuelSt) => st.round,
  clockSeconds: (st: DuelSt) => st.round_seconds,
  create: (room, creator, players, opts, roomName) => room.createDuel(creator, players, opts, roomName),
  summary: (room, g) => room.duelSummary(g),
  full: (room, g, who) => room.duelStateFull(g, who),
  move: (room, g, who, dir, roomName) => room.duelMove(g, who, dir, roomName),
  advance: (room, g, roomName) => room.advanceDuel(g, roomName),
  targets: (pub: DuelState) => pub.players.filter((p) => !p.thrown).map((p) => p.name),
  card: (g: DuelGame) => ({ id: g.id, type: "duel", status: g.status, round: g.st.round, target: g.st.target, round_seconds: g.st.round_seconds, score: g.st.score, winner: g.st.winner || null, players: g.st.players.map((p) => ({ name: p.name, color: p.color, hex: p.hex, wins: (g.st.score || {})[p.name] || 0 })) }),
  stateItem: (r, st: DuelSt) => ({ id: r.id, type: "duel", status: r.status, round: st.round, players: (st.players || []).map((p) => ({ name: p.name, alive: true, moved: !!(st.pending || {})[p.name], accepted: seatAccepted(st, p) })) }),
  turnOf: (gm) => Number(gm.round),
  moveHint: () => "<rock|paper|scissors>",
  result: (room, g) => room.duelResultText(g),
  rules: (st: DuelSt) =>
    "Duel: rock-paper-scissors. Each round both players throw in secret; rock blunts scissors, scissors cut paper, paper wraps rock, and a tie scores nobody. First to " + st.target + " round wins takes the duel (best of " + st.best_of + "). " +
    "A round resolves the moment both throws are in; you can change yours until then. At the " + clockWords(st.round_seconds || DUEL_ROUND_DEFAULT) + " deadline a lone throw wins the round; a round with no throws ends the match where it stands (the leader, if any, wins), and an unthrown round 1 calls the match off. " +
    "Send: dir rock, paper or scissors.",
} satisfies GameEngineOf<DuelSt>;
