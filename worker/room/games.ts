// Room methods: the game machinery every game shares - rows, lobby and accept,
// clocks and the alarm's work, simultaneous rounds and turns, cards, listing,
// the ladder. Each game's own rules are in games/<game>.ts.

import { GAME_ALIASES, GAME_ENGINES, gameEngine } from "../games/engine.js";
import { streamWants } from "./state.js";
import { GAME_STATE_SOFT_MAX, LOBBY_DEFAULT_SECONDS, MOVE_DIR_MAX } from "../limits.js";
import type { GameLogLine, GameStatus } from "@chat/contract";
import type { CfgRow, GmRow, InvRow, MsgRow, Room } from "./Room.js";
import type { GameEngine, GamePub, GameRowOf } from "../games/engine.js";
import { warn } from "../lib/log.js";
import type { Body } from "../lib/http.js";
import { RESERVED_KEYS, nameFold } from "../lib/text.js";
import { gameRev, sameMove } from "../games/shared.js";

// A seat's name keys plain objects in every engine's state (roles, scores,
// votes, moves). A legacy member named "__proto__" (new names cannot be:
// memberNameProblem) made roles[name] = r swap the object's prototype
// instead, so that seat's Werewolf role was never stored and the public
// roles_in_play showed which role was missing. Such names cannot be seated
// (RESERVED_KEYS, the set memberNameProblem refuses).

/** The engine of a game on the simultaneous-rounds machinery, which
 *  supplies resolveRound and standing. */
export type RoundsEngine = GameEngine & Required<Pick<GameEngine, "resolveRound" | "standing">>;
/** A player's row in the room record (listGames): wins, losses and, in a
 *  race with placements, 2nd and 3rd places. */
export type RecordRow = { name: string, hex: string | null, w: number, l: number, p2?: number, p3?: number };
/** A player's row on the ladder (gameLadder), before rounding. */
export type LadderRow = { name: string, hex: string | null, rating: number, w: number, l: number, d: number, last: number };
/** What every stored match state has, whatever its game: the fields the
 *  shared machinery reads. Each game's module types the rest of its own
 *  state (TvStored, BsSt and the like), and those types fit this one. */
export type StoredBase = {
  type?: string,
  players: Array<{ name: string }>,
  log: GameLogLine[],
  deadline?: number | null,
  lobby_deadline?: number | null,
  accepted?: Record<string, boolean>,
  winner?: string | null,
  draw?: boolean,
  forfeit?: string | null,
  ended?: number | null,
  announced?: boolean,
  declined_by?: string,
  /** The match's revision: saveGame adds one on every stored change. A
   *  match stored before it existed has none and reads as 0. */
  rev?: number,
  [field: string]: unknown,
};
/** The simultaneous-rounds games' share of their state (roundsCommit,
 *  roundsAdvance): the round, its clock and the secret commitments. */
export type RoundsStored = StoredBase & { round: number, deadline: number | null, pending: Record<string, unknown>, pending_at?: Record<string, number> };
/** The turn-order games' share (turnsNext, turnsAdvance): the seats in
 *  order, whose turn it is, the turn count and clock, the timeouts. */
export type TurnsStored = StoredBase & { order: string[], turn_of: string | null, turn: number, turn_seconds: number, deadline: number | null, timeouts?: Record<string, number>, passes?: number };
/** A match as gameRow reads it: its gm row, with the state parsed.
 *  fullLog is not stored (saveGame writes only status and st): it is set
 *  on a call that asked for the whole move record (REST ?log=full, MCP
 *  get_game full_log), and an engine that windows its record (Light
 *  Cycles' move_log) reads it when it builds the full state. */
export type GameRow = { id: number, status: GameStatus, created: number, created_by: string, card_msg: number | null, st: StoredBase, fullLog?: boolean };

// A match whose clock work throws (an engine bug, a state that no longer
// fits its row) is retried after CLOCK_RETRY_MIN, doubling on each failure
// in a row up to CLOCK_RETRY_MAX. The alarm used to re-arm at the same past
// deadline, so it fired again at once, forever: a log line, a billed
// invocation and a billed alarm write each time, until the room was
// deleted. No alarm is ever armed less than ALARM_LEAD_MIN ahead.
const CLOCK_RETRY_MIN = 30000;
const CLOCK_RETRY_MAX = 3600000;
const ALARM_LEAD_MIN = 1000;

export const GameMachineryMethods = {
  /* ---------- shared rows and clocks ----------
     State is one JSON row per match in gm; m.game_id links the match's card
     message. Deadlines are real: a Durable Object alarm is kept armed at the
     nearest running match's deadline and resolves what is due when it
     fires, so a match keeps its cadence even while nobody is looking. Game
     calls still catch up anything overdue when they touch a match. A clock
     settles one step per catch-up (a tick, a turn, a round) and the next
     step's window opens from now: a late clock never resolves several
     steps back to back, which once charged players absences for windows
     that had already closed before anyone saw them open. */
  // One colour per seat, so there are as many as the largest game seats
  // (Werewolf's 9). With six, a Werewolf of 7 to 9 and a Trust of 7 or 8
  // answered 500 (the seventh seat read a colour that was not there). Like
  // the first six, each is at least 7:1 on the arenas' dark ground (--gbg).
  // A seat colour must never be one an arena uses to mean something: the
  // last three were first blue and red, which are exactly Werewolf's guard
  // pick and werewolf role and Trust's "red = defected", so the eighth
  // player of a Trust was drawn as a defector. White, sand and blush stand
  // apart from the first six by lightness for colour-blind eyes, and from
  // the roles, picks and outcomes (no red, rose, teal or green);
  // tests/unit/seat-colors.test.mjs holds them to that.
  gameColors() {
    return [
      { color: "cyan", hex: "#22d3ee" },
      { color: "orange", hex: "#fb923c" },
      { color: "pink", hex: "#f472b6" },
      { color: "lime", hex: "#a3e635" },
      { color: "violet", hex: "#a78bfa" },
      { color: "yellow", hex: "#facc15" },
      { color: "white", hex: "#f8fafc" },
      { color: "sand", hex: "#d9b98c" },
      { color: "blush", hex: "#fbcfe8" },
    ];
  },

  gameRow(id: number): GameRow | null {
    const r = this.sql.exec<GmRow>("SELECT * FROM gm WHERE id = ?", id).toArray()[0];
    if (!r) return null;
    // the match state: every write is JSON.stringify of a state its game
    // built (so the stored text has the StoredBase fields); a row whose
    // state does not parse is unreadable, and counts as no match
    let st: StoredBase;
    try { st = JSON.parse(r.state || "{}") as StoredBase; } catch { warn("game.state.parse", null, { room: this.roomName, id }); return null; }
    return { id: r.id, status: r.status, created: r.created, created_by: r.created_by, card_msg: r.card_msg, st: st };
  },

  /** A match of one game: its row with the state as that game's type, or
   *  null when there is no such match or it is another game's (the type
   *  is checked, so the state's shape follows from it). */
  gameRowOf<S extends StoredBase>(id: number, type: string): GameRowOf<S> | null {
    const g = this.gameRow(id);
    return g && g.st && g.st.type === type ? (g as GameRowOf<S>) : null;
  },

  saveGame(g: GameRow) {
    // The narrative log is a mirror of the structured record (ticks /
    // rounds), which is never trimmed; keep the log itself bounded so a
    // marathon match cannot grow the stored state without limit.
    if (g.st && Array.isArray(g.st.log) && g.st.log.length > 240) g.st.log = g.st.log.slice(-200);
    // When a match ends (finished or called off), stamp the moment once:
    // the Games tab files its history by the day a match ended.
    if (g.st && (g.status === "finished" || g.status === "cancelled") && !g.st.ended) g.st.ended = Date.now();
    // The revision every summary and full state carries (each engine's
    // summary builder sends gameRev), so a reader can
    // tell which of two copies is newer. Without it the web app let a slow
    // read's answer, made before the rival's move, overwrite the frame of
    // that move: the arena showed the old turn until its next poll. It
    // lives in the state, not a column, so no schema step was needed.
    if (g.st) g.st.rev = gameRev(g.st) + 1;
    this.sql.exec("UPDATE gm SET status = ?, state = ? WHERE id = ?", g.status, JSON.stringify(g.st), g.id);
    this.gameSaves = (this.gameSaves || 0) + 1;
  },

  // Resolve a proposed player list to canonical member names (case-
  // insensitive), or the refusal to answer with. Shared by both games so the
  // membership rules - and their wording - can never drift apart.
  /** @param playersIn the names a create asked for */
  gamePlayers(playersIn: unknown[]) {
    const members = this.sql.exec<Pick<InvRow, "name">>("SELECT name FROM inv WHERE used IS NOT NULL AND revoked IS NULL").toArray().map((r) => r.name);
    const byLower = new Map(members.map((n) => [n.toLowerCase(), n]));
    const names = [];
    for (const p of playersIn) {
      if (this.isReservedName(p)) return { status: 400, error: "\"Referee\" is a reserved name - it belongs to the room's game official and cannot play." };
      const canon = byLower.get(String(p || "").trim().toLowerCase());
      if (!canon) return { status: 400, error: String(p) + " is not a member of this room" };
      if (RESERVED_KEYS.has(nameFold(canon))) return { status: 409, error: canon + " cannot play: the name is reserved for the games' own bookkeeping - the owner can invite them again under another name" };
      if (names.indexOf(canon) >= 0) return { status: 400, error: canon + " is listed twice" };
      names.push(canon);
    }
    return { names: names };
  },

  // The public summary and the per-viewer full state of any match: each
  // game's engine (GAME_ENGINES) supplies its own.
  gameSummary(g: GameRow): GamePub {
    return gameEngine(g.st).summary(this, g);
  },

  // The full state carries how_to_play: the match's rules in a few lines
  // with its own settings, so an agent reading get_game never needs the
  // rulebook - and one holding a stale tool list still gets them.
  gameStateFull(g: GameRow, who: string | null | undefined): GamePub {
    const eng = gameEngine(g.st);
    const out = eng.full(this, g, who);
    if (out && eng.rules) out.how_to_play = eng.rules(g.st);
    return out;
  },

  /* ---------- games: simultaneous rounds ----------
     The shared machinery for games where every player moves secretly
     and the round resolves together. The round resolves the moment every
     seated player has committed. At the deadline it resolves with
     whoever did commit, and the engine scores the forfeits. A round
     nobody committed ends the match where it stands; in round 1 that
     calls it off (cancelled, nothing on anyone's record), as a duel does.
     Commitments are secret: views show only THAT a player has committed
     until the round resolves. The engine supplies resolveRound(room, g),
     which scores the round, pushes it and advances or finishes, and
     standing(room, st): the winner if the match ends where it stands, or
     null. It may add active(room, st), the players a round waits on. By
     default that is all of them; Code Race leaves out racers who have
     finished or dropped. */
  /** @param st the match state */
  roundsActive(st: StoredBase): Array<{ name: string }> {
    const eng = gameEngine(st);
    return eng.active ? eng.active(this, st) : st.players;
  },

  /** @param who a seated player */
  roundsCommit(g: GameRowOf<RoundsStored>, who: string, move: unknown, room: string) {
    const st = g.st;
    const me = st.players.find((p) => p.name.toLowerCase() === String(who || "").toLowerCase());
    // the engines commit only for a seated player
    if (!me) return false;
    // an unchanged re-send keeps its time and sends no frame (sameMove)
    if (sameMove(st.pending[me.name], move)) return false;
    st.pending[me.name] = move;
    if (!st.pending_at) st.pending_at = {};
    st.pending_at[me.name] = Date.now();
    const all = this.roundsActive(st).every((p) => st.pending[p.name] !== undefined);
    if (all) (gameEngine(st) as RoundsEngine).resolveRound(this, g);
    this.saveGame(g);
    // a frame per commit (from the player, targets who still owes), and
    // the frame that opens the next round speaks as the Referee
    if (all) this.afterGameChange(g, room, "Referee");
    else this.broadcastGame(g, room, who);
    return all;
  },

  roundsAdvance(g: GameRowOf<RoundsStored> | null, room: string) {
    if (!g || g.status !== "running" || Date.now() < (g.st.deadline || 0)) return;
    const st = g.st;
    const eng = gameEngine(st) as RoundsEngine;
    const committed = this.roundsActive(st).filter((p) => st.pending[p.name] !== undefined).length;
    if (committed === 0) {
      if (st.round === 1) {
        g.status = "cancelled";
        st.log.push({ tick: st.round, text: "Round 1 went by with no moves - the match is called off." });
        this.saveGame(g);
        this.postSystem(eng.name + " match #" + g.id + " is off - round 1 went by with no moves.", room);
        this.afterGameChange(g, room, "Referee");
        return;
      }
      g.status = "finished";
      st.winner = eng.standing(this, st);
      st.log.push({ tick: st.round, text: "Round " + st.round + " went by with no moves - the match ends where it stands." });
      this.saveGame(g);
      this.afterGameChange(g, room, "Referee");
      return;
    }
    eng.resolveRound(this, g);
    this.saveGame(g);
    this.afterGameChange(g, room, "Referee");
  },

  /* ---------- games: turn order ----------
     Shared machinery for strictly turn-based games. st.order is the
     seats in turn order, st.turn_of whose move it is, st.turn the turn
     count and st.deadline its clock (turn_seconds). A move that ends a
     turn calls turnsNext(g). An expired turn is a pass: the turn moves on
     and the player's timeouts count up. The third timeout in a match
     forfeits it (the rival wins), so two absent players cannot keep a
     match alive forever. A pass_limit draw (20 passes in all) was checked
     after that forfeit and so could never happen with two seats: it is
     gone from the code and the rules, and a stored pass_limit is ignored.
     The engine's advance is turnsAdvance. */
  turnsNext(g: GameRowOf<TurnsStored>) {
    const st = g.st;
    // no one's turn (-1) hands it to the first seat
    const i = st.turn_of === null ? -1 : st.order.indexOf(st.turn_of);
    st.turn_of = st.order[(i + 1) % st.order.length] ?? null;
    st.turn += 1;
    st.deadline = Date.now() + st.turn_seconds * 1000;
  },

  turnsAdvance(g: GameRowOf<TurnsStored> | null, room: string) {
    if (!g || g.status !== "running" || Date.now() < (g.st.deadline || 0)) return;
    const st = g.st;
    // a turn is always someone's while the clock runs; String() is for the type
    const who = String(st.turn_of);
    const timeouts = st.timeouts || (st.timeouts = {});
    timeouts[who] = (timeouts[who] || 0) + 1;
    st.passes = (st.passes || 0) + 1;
    if (timeouts[who] >= 3) {
      g.status = "finished";
      st.forfeit = who;
      st.winner = st.order.find((n: string) => n !== who) || null;
      st.log.push({ tick: st.turn, text: who + "'s turn timed out a third time - " + who + " forfeits; " + st.winner + " wins." });
    } else {
      st.log.push({ tick: st.turn, text: who + "'s turn timed out - a pass (" + timeouts[who] + " of 3)." });
      this.turnsNext(g);
    }
    this.saveGame(g);
    this.afterGameChange(g, room, "Referee");
  },

  /* ---------- games: rotating role ----------
     One player holds a special role each round (storyteller, writer,
     answerer, artist), passing in seat order: round n's holder is
     st.order[(n - 1) % seats]. */
  /**
   * @param st the match state
   * @param n the round
   */
  roleOf(st: { order: string[] }, n: number): string {
    return st.order[(n - 1) % st.order.length];
  },

  // Settle whatever the clock owes a running match (resolutions,
  // forfeits): the engine's own advance. A throw is counted for the
  // alarm's backoff (gameClockFailed) and passed on. Only an advance that
  // saved something clears the count: one that had nothing to do proves
  // nothing. Sketch & Guess's judging phase is such a no-op (its judge is
  // the async part), and clearing there set a judge that kept failing back
  // to its first failure every time, so its retry never doubled.
  advanceGame(g: GameRow | null, room: string) {
    if (!g || g.status !== "running") return;
    const saves = this.gameSaves || 0;
    try {
      gameEngine(g.st).advance(this, g, room);
    } catch (e) {
      this.gameClockFailed(g.id);
      throw e;
    }
    if ((this.gameSaves || 0) !== saves) this.gameClockOk(g.id);
  },

  /* The clock failures, by match id: how many in a row and the earliest
     the alarm tries that match again. Kept in cfg ('gm_clock_fail') so
     the doubling survives a fresh instance (an idle room's instance is
     evicted between alarms minutes apart), and read once per instance;
     gen ties the copy to the room it was read in, since a room deleted
     and created again starts its match ids at 1. */
  gameClockFails(): Record<string, { n: number, retry: number }> {
    if (this.clockFails && this.clockFails.gen === this.gen) return this.clockFails.map;
    let map: Record<string, { n: number, retry: number }> = {};
    try {
      const r = this.sql.exec<Pick<CfgRow, "v">>("SELECT v FROM cfg WHERE k = 'gm_clock_fail'").toArray()[0];
      if (r) map = JSON.parse(String(r.v)) || {};
    } catch (e) {
      warn("game.clock.read", e, { room: this.roomName });
    }
    this.clockFails = { gen: this.gen, map };
    return map;
  },

  gameClockSave(map: Record<string, { n: number, retry: number }>) {
    try {
      if (Object.keys(map).length) this.sql.exec("INSERT OR REPLACE INTO cfg (k, v) VALUES ('gm_clock_fail', ?)", JSON.stringify(map));
      else this.sql.exec("DELETE FROM cfg WHERE k = 'gm_clock_fail'");
    } catch (e) {
      // the in-memory copy still backs the alarm off in this instance
      warn("game.clock.save", e, { room: this.roomName });
    }
  },

  /** @param until a time the retry must not pass while it is still ahead:
   *  the match's own fallback, which the backoff would otherwise delay */
  gameClockFailed(id: number, until?: number) {
    const map = this.gameClockFails();
    const n = (map[id] ? map[id].n : 0) + 1;
    let retry = Date.now() + Math.min(CLOCK_RETRY_MAX, CLOCK_RETRY_MIN * 2 ** (n - 1));
    if (until && until > Date.now()) retry = Math.min(retry, until);
    map[id] = { n, retry };
    this.gameClockSave(map);
  },

  gameClockOk(id: number) {
    const map = this.gameClockFails();
    if (!map[id]) return;
    delete map[id];
    this.gameClockSave(map);
  },

  // Keep a Durable Object alarm armed at the nearest running match's
  // deadline. Called wherever a deadline is created or moved (create, move,
  // cancel, any state read, and the alarm handler itself); a no-op when the
  // armed time already matches, so hot read paths stay cheap.
  async armGameAlarm() {
    try {
      const rows = this.sql.exec<Pick<GmRow, "id" | "status" | "state">>("SELECT id, status, state FROM gm WHERE status IN ('running', 'lobby')").toArray();
      const fails = this.gameClockFails();
      /** the nearest deadline */
      let next: number | null = null;
      for (const r of rows) {
        try {
          const st = JSON.parse(r.state || "{}");
          let dl = r.status === "lobby" ? st.lobby_deadline : st.deadline;
          // a match whose clock work failed waits out its backoff
          const f = fails[r.id];
          if (dl && f && f.retry > dl) dl = f.retry;
          if (dl && (next === null || dl < next)) next = dl;
        } catch { warn("game.state.parse", null, { room: this.roomName, id: r.id }); }
      }
      // a match that ended (a cancel, a finish by a move) drops its count
      const live = new Set(rows.map((r) => String(r.id)));
      const ended = Object.keys(fails).filter((k) => !live.has(k));
      if (ended.length) { for (const k of ended) delete fails[k]; this.gameClockSave(fails); }
      const cur = await this.ctx.storage.getAlarm();
      if (next === null) { if (cur !== null) await this.ctx.storage.deleteAlarm(); return; }
      // A deadline already past (one no catch-up has settled yet) is armed
      // a moment ahead, never in the past: a past alarm fires at once.
      next = Math.max(next, Date.now() + ALARM_LEAD_MIN);
      // The alarm may fire in a fresh instance, where roomName (memory
      // only) is unset: keep the name with the clock so the Referee's
      // posts and their pushes still link to the room.
      if (this.roomName) this.sql.exec("INSERT OR REPLACE INTO cfg (k, v) VALUES ('room_name', ?)", this.roomName);
      if (cur !== next) await this.ctx.storage.setAlarm(next);
    } catch (e) {
      // a match may now miss its deadline until the next read or move re-arms
      warn("alarm.arm", e, { room: this.roomName });
    }
  },

  afterGameChange(g: GameRow, room: string, actor: string | null | undefined) {
    // Ticks are quiet in the transcript: a resolution travels as an
    // event: game frame and through room_state.awaiting_you, which is
    // what wakes players. A Referee post per tick would fill the room
    // faster than anyone could play, so the Referee posts only the
    // result, below; the in-game log carries the full record, deaths
    // included.
    this.broadcastGame(g, room, actor);
    if (g.status === "finished" && !g.st.announced) {
      g.st.announced = true;
      this.saveGame(g);
      this.postSystem(gameEngine(g.st).result(this, g), room);
    }
  },

  broadcastGame(g: GameRow, room: string | null | undefined, actor: string | null | undefined) {
    if (!this.clients || !this.clients.size) return;
    const pub = this.gameSummary(g);
    if (g.st.trails) pub.trails = g.st.trails;
    const frame = "event: game\ndata: " + JSON.stringify({ type: "game", room: room, from: actor || null, kind: this.memberKind(actor), targets: this.gameTargets(g, pub), game: pub }) + "\n\n";
    for (const c of this.clients) { if (!streamWants(c, "game", g.id)) continue; try { c.send(frame); } catch { /* a subscriber that already went away */ } }
    this.emitState(room);
  },

  // The match card: a normal message that carries the game reference, so it
  // renders in the stream and opens the arena full-screen.
  async postGameCard(sender: string, text: string, gameId: number, room: string) {
    const ts = Date.now();
    const id = this.sql.exec<Pick<MsgRow, "id">>("INSERT INTO m (id, ts, sender, text, game_id, pub_ts) VALUES (?, ?, ?, ?, ?, ?) RETURNING id", this.nextMsgId(), ts, sender, text, gameId, ts).one().id;
    this.trimHistory();
    this.sql.exec("UPDATE inv SET posted = ? WHERE lower(name) = lower(?) AND posted IS NULL", ts, sender);
    const msg = this.withKinds([{ id: id, ts: ts, from: sender, text: text, game_id: gameId }])[0];
    this.announce(msg, room);
    return msg;
  },

  /** @param opts the create's options: game names the engine, and no
   *  game is Light Cycles (the API's default) */
  async createGame(creator: string, playersIn: unknown[], opts: Body | null | undefined, room: string) {
    // A match's state names its game in "type", so "type" is the natural
    // guess for the create field too. It was never read: {"type": "duel"}
    // made a Light Cycles match with a 201 (the schema upgrade test, meant
    // to carry a duel across, checked a Light Cycles lobby because of it).
    if (opts && opts.type != null && opts.game == null) return { status: 400, error: "the field is \"game\", not \"type\": game must be one of " + Object.keys(GAME_ENGINES).join(", ") };
    const key = String((opts && opts.game) || "lightcycles").toLowerCase().replace(/[\s_-]+/g, "");
    // an unknown spelling is no entry: the check below answers it
    const eng = (GAME_ENGINES as Record<string, GameEngine | undefined>)[(GAME_ALIASES as Record<string, string>)[key] || key];
    if (!eng) return { status: 400, error: "game must be one of " + Object.keys(GAME_ENGINES).join(", ") };
    return eng.create(this, creator, playersIn, opts || {}, room);
  },

  // fullLog, here and on the calls below that answer with the state: the
  // caller asked for the whole move record (GameRow).
  async gameState(id: number, who: string | null | undefined, room: string, fullLog = false) {
    const g = this.gameRow(id);
    if (!g) return { status: 404, error: "No game with that id" };
    g.fullLog = fullLog;
    this.advanceGame(g, room);
    this.advanceLobby(g, room);
    await this.armGameAlarm();
    return { status: 200, game: this.gameStateFull(g, who) };
  },

  // fields: a structured move's named parts, beside or instead of dir -
  // e.g. a storyteller's {statements, lie}. Engines that take only dir
  // ignore them, so every string move keeps working.
  // turn, optional: the step the mover decided on (awaiting_you's turn,
  // the engine's turnOf). A move used to land on whatever turn was
  // current, so a copy re-sent or delayed past the rival's reply became
  // the mover's next move: a second disc, a second liar call, a "yes"
  // ruling on the next guess. With turn, a stale move answers 409 and the
  // state as it is now; without it a move is read as before.
  async gameMove(id: number, who: string, dir: unknown, room: string, fields?: Record<string, unknown> | null, fullLog = false, turn?: unknown) {
    const g = this.gameRow(id);
    if (!g) return { status: 404, error: "No game with that id" };
    // Every engine reads dir as text. An object or a list used to reach it
    // through String(): Exquisite Corpse stored "[object Object]" as a
    // writer's segment, and a list of sentences as one comma-joined line,
    // both with a 200 and the turn spent. A list in Battleship (a fleet or
    // a salvo) and Frontlines (troops) was joined the same way and happened
    // to work; it is refused too, so dir has one rule in every game, and the
    // refusal says to send the parts in one string. Structured moves have
    // their own named fields (moveFields).
    if (dir !== null && typeof dir === "object") return { status: 400, error: "dir is your move as text: send one string (or a number where the move is one), not " + (Array.isArray(dir) ? "a list - put all its parts in that one string" : "an object") + ", in the format how_to_play shows; structured moves use named fields" };
    // Refused before any engine reads it: a long dir once held the room
    // for seconds in a parser's backtracking regex (MOVE_DIR_MAX).
    const max = gameEngine(g.st).dirMax || MOVE_DIR_MAX;
    if (dir != null && String(dir).length > max) return { status: 413, error: "A move's dir can be up to " + max + " characters" };
    g.fullLog = fullLog;
    this.advanceGame(g, room);
    this.advanceLobby(g, room);
    if (g.status === "lobby") return { status: 409, error: "That match is still in the lobby - it starts when every player accepts" };
    if (g.status !== "running") return { status: 409, error: "That match is " + g.status };
    // the stored size in bytes (UTF-8), as the row limit counts it
    const bytes = this.sql.exec<{ n: number }>("SELECT length(CAST(state AS BLOB)) AS n FROM gm WHERE id = ?", id).toArray()[0];
    if (bytes && bytes.n > GAME_STATE_SOFT_MAX) {
      await this.armGameAlarm();
      return { status: 409, error: "This match's record is full: it takes no more moves. Its clock still plays it out, and its creator or the owner can cancel it", game: this.gameStateFull(g, who) };
    }
    const eng = gameEngine(g.st);
    if (turn !== undefined && turn !== null) {
      if (typeof turn !== "number" && typeof turn !== "string") return { status: 400, error: "turn is the match's turn number, as room_state.awaiting_you gives it" };
      const now = eng.turnOf(eng.stateItem({ id: g.id, status: g.status }, g.st));
      if (String(turn).trim() !== String(now)) {
        await this.armGameAlarm();
        return { status: 409, error: "The match has moved on: it is at turn " + now + ", not " + String(turn).slice(0, 20) + " - read the state and decide again", turn: now, game: this.gameStateFull(g, who) };
      }
    }
    // A move that saves the match clears its clock-failure count: the
    // failure was about the state before it. A count left by an engine that
    // kept throwing could hold a retry up to an hour ahead, and the alarm
    // waited for it past the earlier deadline this move set. The engine
    // armed the alarm already, so arm again once the count is gone.
    const saves = this.gameSaves || 0;
    const res = await eng.move(this, g, who, dir, room, fields || null);
    if ((this.gameSaves || 0) !== saves && this.gameClockFails()[g.id]) {
      this.gameClockOk(g.id);
      await this.armGameAlarm();
    }
    return res;
  },

  // Stop a running match where it stands: no winner, no result post, no
  // further ticks or moves. The creator or the owner may cancel; cancelling
  // an already-cancelled match answers 200 with the same state.
  async gameCancel(id: number, who: string | null | undefined, owner: boolean, room: string, fullLog = false) {
    let g = this.gameRow(id);
    if (!g) return { status: 404, error: "No game with that id" };
    g.fullLog = fullLog;
    this.advanceLobby(g, room);
    if (!owner && String(g.created_by || "").toLowerCase() !== String(who || "").toLowerCase()) return { status: 403, error: "Only the member who created this match (or the owner) can cancel it" };
    // Settle what the clock owes first, as a read or a move does. Without
    // it a cancel sent after the deadline, before the alarm ran, stored a
    // match the clock had already decided (a duel won by the only throw)
    // as called off: no winner, no result post, nothing on the record.
    // A match whose clock work throws must still be cancellable, so the
    // cancel then goes ahead on the row as stored.
    try {
      this.advanceGame(g, room);
    } catch (e) {
      warn("game.cancel.advance", e, { room: this.roomName, id });
      const fresh = this.gameRow(id);
      if (!fresh) return { status: 404, error: "No game with that id" };
      fresh.fullLog = fullLog;
      g = fresh;
    }
    if (g.status === "finished") return { status: 409, error: "That match is already finished" };
    if (g.status === "running" || g.status === "lobby") {
      g.status = "cancelled";
      const t = this.gameLogTick(g.st);
      g.st.log.push({ tick: t, text: "Match cancelled by " + who + " at " + gameEngine(g.st).turnWord + " " + t + "." });
      this.saveGame(g);
      this.broadcastGame(g, room, who);
    }
    await this.armGameAlarm();
    return { status: 200, game: this.gameStateFull(g, who) };
  },

  /* ---------- games: the lobby ----------
     A match is created into a lobby, not into play: invited players
     accept (or decline) their seat, and the clock starts only when
     everyone is in. A clock that ran from creation would run while a
     player was never at the table, so a match could expire 0-0 or end
     in a forfeit sweep. The lobby separates "invited" from "playing": a
     player who accepts has said they are here, at this clock. */
  lobbySeconds(opts: Body | null | undefined) {
    let sec = Math.floor(Number(opts && opts.lobby_seconds) || 0);
    if (!sec) sec = LOBBY_DEFAULT_SECONDS;
    return Math.min(86400, Math.max(5, sec));
  },

  // The accept map a new match starts with: a creator who is playing
  // is in automatically; everyone else has been invited, not seated.
  /**
   * @param names the seats: gamePlayers' names, set whenever
   *   it answers no error (a check its callers' types cannot narrow on)
   */
  lobbyAccepted(creator: string | null | undefined, names: string[] | undefined) {
    const acc: Record<string, boolean> = {};
    for (const n of names as string[]) acc[n] = n.toLowerCase() === String(creator || "").toLowerCase();
    return acc;
  },

  gameTypeName(g: GameRow) {
    return gameEngine(g.st).name;
  },

  // The match's own clock step - a tick, a round, a turn - for log lines.
  /** @param st the match state */
  gameLogTick(st: StoredBase) {
    return gameEngine(st).logTick(st);
  },

  // Settle a lobby whose join window has closed: the match is called
  // off (status cancelled, like a creator cancel) and the Referee says
  // so once: a card that silently dies is dead furniture in the room.
  advanceLobby(g: GameRow | null, room: string) {
    if (!g || g.status !== "lobby" || !g.st.lobby_deadline || Date.now() < g.st.lobby_deadline) return;
    try {
      this.lobbyExpire(g, room);
    } catch (e) {
      this.gameClockFailed(g.id);
      throw e;
    }
    this.gameClockOk(g.id);
  },

  lobbyExpire(g: GameRow, room: string) {
    const missing = g.st.players.filter((pl: { name: string }) => !(g.st.accepted || {})[pl.name]).map((pl: { name: string }) => pl.name);
    g.status = "cancelled";
    g.st.log.push({ tick: this.gameLogTick(g.st), text: "The lobby expired - " + (missing.join(", ") || "a player") + " never accepted. The match is called off." });
    this.saveGame(g);
    this.broadcastGame(g, room, "Referee");
    this.postSystem(this.gameTypeName(g) + " match #" + g.id + " never started - the lobby expired with " + (missing.join(", ") || "a player") + " still to accept.", room);
  },

  // Take your seat. Idempotent for a player already in, and for a match
  // that has already started (a slow agent re-accepting on a later wake
  // just gets the live state). The last accept starts the clock.
  async gameAccept(id: number, who: string | null | undefined, room: string, fullLog = false) {
    const g = this.gameRow(id);
    if (!g) return { status: 404, error: "No game with that id" };
    g.fullLog = fullLog;
    this.advanceLobby(g, room);
    // a re-accept of a running match answers its state, so settle the
    // clock first as a read does: it used to answer a turn the deadline
    // had already ended, and leave the alarm as it was
    this.advanceGame(g, room);
    const st = g.st;
    const me = st.players.find((pl: { name: string }) => pl.name.toLowerCase() === String(who || "").toLowerCase());
    if (!me) return { status: 403, error: "You are not a player in this match" };
    if (g.status === "running") {
      await this.armGameAlarm();
      return { status: 200, game: this.gameStateFull(g, who) };
    }
    if (g.status !== "lobby") return { status: 409, error: "That match is " + g.status };
    const accepted = st.accepted || (st.accepted = {});
    if (!accepted[me.name]) {
      accepted[me.name] = true;
      st.log.push({ tick: this.gameLogTick(st), text: me.name + " is in." });
    }
    if (st.players.every((pl) => accepted[pl.name])) {
      g.status = "running";
      st.deadline = Date.now() + gameEngine(st).clockSeconds(st) * 1000;
      st.log.push({ tick: this.gameLogTick(st), text: "Everyone is in - the match starts." });
    }
    // a save clears the match's clock-failure count (see gameMove)
    this.gameClockOk(g.id);
    this.saveGame(g);
    this.broadcastGame(g, room, who);
    await this.armGameAlarm();
    return { status: 200, game: this.gameStateFull(g, who) };
  },

  // Refuse your seat: the match is called off for everyone, and the
  // Referee posts that it is off: declining is news, and a silent card
  // leaves a dead match nobody can explain.
  async gameDecline(id: number, who: string | null | undefined, room: string, fullLog = false) {
    const g = this.gameRow(id);
    if (!g) return { status: 404, error: "No game with that id" };
    g.fullLog = fullLog;
    this.advanceLobby(g, room);
    if (g.status === "running") return { status: 409, error: "That match is already under way" };
    if (g.status !== "lobby") return { status: 409, error: "That match is " + g.status };
    const st = g.st;
    const me = st.players.find((pl: { name: string }) => pl.name.toLowerCase() === String(who || "").toLowerCase());
    if (!me) return { status: 403, error: "You are not a player in this match" };
    g.status = "cancelled";
    st.declined_by = me.name;
    st.log.push({ tick: this.gameLogTick(st), text: me.name + " declined the seat - the match is called off." });
    this.saveGame(g);
    this.broadcastGame(g, room, who);
    this.postSystem(this.gameTypeName(g) + " match #" + g.id + " is off - " + me.name + " declined the seat.", room);
    await this.armGameAlarm();
    return { status: 200, game: this.gameStateFull(g, who) };
  },

  // The games list: every match still live (lobby or running),
  // however old, then the most recent finished ones - a busy room's
  // history fills the tail but never pushes a live match off it.
  // Boards are stripped (they are the arena's payload, not a list's).
  // The same scan builds the room record: all-time wins and losses
  // per player per game type, over every finished match (a winner
  // takes a W, the other finishers an L; undecided finishes and
  // called-off matches count for nothing).
  listGames() {
    const scanned = this.sql.exec<Pick<GmRow, "id">>("SELECT id FROM gm ORDER BY id DESC LIMIT 500").toArray();
    // filter(Boolean) drops the rows that did not parse
    const all = scanned.map((r) => {
      const g = this.gameRow(r.id);
      if (!g || !g.st) return null;
      const s = this.gameSummary(g);
      if (s) {
        // The collapsed targets, same derivation as the game frames:
        // who this match is waiting on, readable without opening it.
        s.targets = this.gameTargets(g, s);
        if (s.boards) delete s.boards;
        // When it began and (once over) when it ended, for the history's
        // day groups. Matches that ended before the stamp existed carry
        // ended null and file under the day they began.
        s.created = g.created;
        s.ended = (g.st && g.st.ended) || null;
      }
      return s;
    }).filter(Boolean) as GamePub[];
    const live = all.filter((g) => g.status === "lobby" || g.status === "running").slice(0, 100);
    const done = all.filter((g) => g.status !== "lobby" && g.status !== "running");
    /** by game type, then player name */
    const byType: Record<string, Record<string, RecordRow>> = {};
    // A race with placements (Code Race) also counts 2nd and 3rd places
    // (p2, p3); its W and L stay winner / everyone else.
    const placed = (row: RecordRow, places: unknown, name: string) => {
      const k = Array.isArray(places) ? places.indexOf(name) : -1;
      if (k === 1) row.p2 = (row.p2 || 0) + 1;
      else if (k === 2) row.p3 = (row.p3 || 0) + 1;
    };
    done.forEach((g) => {
      // a team win (Werewolf: winners) counts for everyone on the side
      if (g.status !== "finished" || (!g.winner && !(g.winners && g.winners.length))) return;
      const table = byType[g.type] || (byType[g.type] = {});
      (g.players || []).forEach((p) => {
        const row = table[p.name] || (table[p.name] = { name: p.name, hex: p.hex, w: 0, l: 0 });
        if (g.winners ? g.winners.indexOf(p.name) >= 0 : p.name === g.winner) row.w++;
        else row.l++;
        placed(row, g.places, p.name);
      });
    });
    // Matches older than the 500-row window still count toward the
    // record (it promises every finished match): a light SQL pass reads
    // just type, winner and player names, never the boards.
    if (scanned.length === 500) {
      const floor = scanned[scanned.length - 1].id;
      try {
        // ws and places come back as JSON text (json_extract of a list)
        const rows = this.sql.exec<{ t: string | null, w: string | null, ws: string | null, places: string | null, name: string | null, hex: string | null }>("SELECT json_extract(gm.state, '$.type') AS t, json_extract(gm.state, '$.winner') AS w, json_extract(gm.state, '$.winners') AS ws, json_extract(gm.state, '$.places') AS places, json_extract(pl.value, '$.name') AS name, json_extract(pl.value, '$.hex') AS hex FROM gm, json_each(gm.state, '$.players') AS pl WHERE gm.status = 'finished' AND gm.id < ?", floor).toArray();
        for (const r of rows) {
          if ((!r.w && !r.ws) || !r.name) continue;
          const type = (GAME_ENGINES as Record<string, unknown>)[r.t as string] ? (r.t as string) : "lightcycles";
          const table = byType[type] || (byType[type] = {});
          const row = table[r.name] || (table[r.name] = { name: r.name, hex: r.hex || null, w: 0, l: 0 });
          let ws: string[] | null = null;
          if (r.ws) { try { ws = JSON.parse(r.ws); } catch { ws = null; } }
          if (ws ? ws.indexOf(r.name) >= 0 : r.name === r.w) row.w++;
          else row.l++;
          if (r.places) { try { placed(row, JSON.parse(r.places), r.name); } catch { warn("standings.places", null, { room: this.roomName }); } }
        }
      } catch (e) {
        warn("standings.scan", e, { room: this.roomName });
      }
    }
    /** by game type, best first */
    const record: Record<string, RecordRow[]> = {};
    Object.keys(byType).forEach((t) => {
      record[t] = Object.values(byType[t]).sort((a, b) => b.w - a.w || a.l - b.l || (a.name < b.name ? -1 : 1));
    });
    return { games: live.concat(done).slice(0, 40), record, ladder: this.gameLadder() };
  },

  /* The ladder: an Elo rating per player per game, from 1000 with K = 32,
     replayed over every finished 2-player match in order. A win scores 1
     and a loss 0; a draw (Four in a Row's full board)
     scores a half each; a finish with no winner and no draw does not
     count. Free-for-alls stay out (the record covers them). Recomputed on
     every read from the matches themselves, so there is no stored table
     to drift.
     Rows: { name, hex, rating, w, l, d, last } - last is the rating
     change from the player's most recent ladder match. */
  gameLadder() {
    /** by game type, then player name */
    const ladder: Record<string, Record<string, LadderRow>> = {};
    /** ps: the players as JSON text */
    type FinishedRow = { id: number, t: string | null, w: string | null, d: number | null, ps: string | null };
    let rows: Array<FinishedRow> = [];
    try {
      rows = this.sql.exec<FinishedRow>("SELECT id, json_extract(state, '$.type') AS t, json_extract(state, '$.winner') AS w, json_extract(state, '$.draw') AS d, json_extract(state, '$.players') AS ps FROM gm WHERE status = 'finished' ORDER BY id").toArray();
    } catch {
      return {};
    }
    for (const r of rows) {
      let ps;
      try {
        ps = JSON.parse(r.ps || "[]");
      } catch {
        continue;
      }
      if (!Array.isArray(ps) || ps.length !== 2) continue;
      const [a, b] = ps;
      let sa;
      if (r.w && r.w === a.name) sa = 1;
      else if (r.w && r.w === b.name) sa = 0;
      else if (r.d) sa = 0.5;
      else continue;
      const type = (GAME_ENGINES as Record<string, unknown>)[r.t as string] ? (r.t as string) : "lightcycles";
      const table = ladder[type] || (ladder[type] = {});
      const seat = (p: { name: string, hex?: string }) => {
        const x = table[p.name] || (table[p.name] = { name: p.name, hex: null, rating: 1000, w: 0, l: 0, d: 0, last: 0 });
        if (p.hex) x.hex = p.hex;
        return x;
      };
      const ra = seat(a), rb = seat(b);
      const ea = 1 / (1 + Math.pow(10, (rb.rating - ra.rating) / 400));
      const da = 32 * (sa - ea);
      ra.rating += da;
      rb.rating -= da;
      ra.last = da;
      rb.last = -da;
      if (sa === 1) { ra.w++; rb.l++; }
      else if (sa === 0) { ra.l++; rb.w++; }
      else { ra.d++; rb.d++; }
    }
    /** by game type, best first */
    const out: Record<string, Array<Omit<LadderRow, "rating" | "last"> & { rating: number, last: number }>> = {};
    Object.keys(ladder).forEach((t) => {
      out[t] = Object.values(ladder[t])
        .map((x) => ({ name: x.name, hex: x.hex, rating: Math.round(x.rating), w: x.w, l: x.l, d: x.d, last: Math.round(x.last) }))
        .sort((x, y) => y.rating - x.rating || (x.name < y.name ? -1 : 1));
    });
    return out;
  },

  // Who a game frame is waiting on, from the public summary alone: the
  // unaccepted in a lobby; in play, the players yet to move (battleship:
  // yet to place in setup, the shooter in play). Nobody once it ends.
  /** @param pub its summary */
  gameTargets(g: GameRow, pub: GamePub | null): string[] {
    if (!pub || !pub.players) return [];
    if (g.status === "lobby") return pub.players.filter((p) => !p.accepted).map((p) => p.name);
    if (g.status !== "running") return [];
    return gameEngine(g.st).targets(pub);
  },
} satisfies ThisType<Room>;
