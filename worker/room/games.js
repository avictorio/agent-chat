// Room methods: the game machinery every game shares - rows, lobby and accept,
// clocks and the alarm's work, simultaneous rounds and turns, cards, listing,
// the ladder. Each game's own rules are in games/<game>.js.

import { GAME_ALIASES, GAME_ENGINES, gameEngine } from "../games/engine.js";
import { streamWants } from "./state.js";
import { LOBBY_DEFAULT_SECONDS } from "../limits.js";

export const GameMachineryMethods = {
  /* ---------- games: Light Cycles ----------
     Turn-based Tron: simultaneous moves resolved in ticks. A tick resolves when
     every living player has moved, or when its clock expires (a miss sends the
     bike straight). The deadline is real: a Durable Object alarm is kept armed
     at the nearest running match's deadline and resolves what is due when it
     fires, so a match keeps its cadence even while nobody is looking. Game
     calls still catch up anything overdue when they touch a match, and the
     deadline arithmetic (deadline += tick) keeps cadence honest regardless.
     State is one JSON row per match in gm; m.game_id links the card message;
     st.move_log records per tick and rider the direction, its source
     (submitted / clock default), and when a submitted move arrived. */
  gameColors() {
    return [
      { color: "cyan", hex: "#22d3ee" },
      { color: "orange", hex: "#fb923c" },
      { color: "pink", hex: "#f472b6" },
      { color: "lime", hex: "#a3e635" },
      { color: "violet", hex: "#a78bfa" },
      { color: "yellow", hex: "#facc15" },
    ];
  },

  gameRow(id) {
    const r = this.sql.exec("SELECT * FROM gm WHERE id = ?", id).toArray()[0];
    if (!r) return null;
    let st = null;
    try { st = JSON.parse(r.state || "{}"); } catch (e) {}
    return { id: r.id, status: r.status, created: r.created, created_by: r.created_by, card_msg: r.card_msg, st: st };
  },

  saveGame(g) {
    // The narrative log is a mirror of the structured record (ticks /
    // rounds), which is never trimmed; keep the log itself bounded so a
    // marathon match cannot grow the stored state without limit.
    if (g.st && Array.isArray(g.st.log) && g.st.log.length > 240) g.st.log = g.st.log.slice(-200);
    // When a match ends (finished or called off), stamp the moment once:
    // the Games tab files its history by the day a match ended.
    if (g.st && (g.status === "finished" || g.status === "cancelled") && !g.st.ended) g.st.ended = Date.now();
    this.sql.exec("UPDATE gm SET status = ?, state = ? WHERE id = ?", g.status, JSON.stringify(g.st), g.id);
  },

  // Resolve a proposed player list to canonical member names (case-
  // insensitive), or the 400 to answer with. Shared by both games so the
  // membership rules - and their wording - can never drift apart.
  gamePlayers(playersIn) {
    const members = this.sql.exec("SELECT name FROM inv WHERE used IS NOT NULL AND revoked IS NULL").toArray().map((r) => r.name);
    const byLower = new Map(members.map((n) => [n.toLowerCase(), n]));
    const names = [];
    for (const p of playersIn) {
      if (this.isReservedName(p)) return { status: 400, error: "\"Referee\" is a reserved name - it belongs to the room's game official and cannot play." };
      const canon = byLower.get(String(p || "").trim().toLowerCase());
      if (!canon) return { status: 400, error: String(p) + " is not a member of this room" };
      if (names.indexOf(canon) >= 0) return { status: 400, error: canon + " is listed twice" };
      names.push(canon);
    }
    return { names: names };
  },

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

  // The public summary and the per-viewer full state of any match: each
  // game's engine (GAME_ENGINES) supplies its own.
  gameSummary(g) {
    return gameEngine(g.st).summary(this, g);
  },

  // The full state carries how_to_play (2026-11-19): the match's rules in
  // a few lines with its own settings, so an agent reading get_game never
  // needs the rulebook - and one holding a stale tool list still gets them.
  gameStateFull(g, who) {
    const eng = gameEngine(g.st);
    const out = eng.full(this, g, who);
    if (out && eng.rules) out.how_to_play = eng.rules(g.st);
    return out;
  },

  /* ---------- games: simultaneous rounds (2026-11-19) ----------
     The shared machinery for games where every player moves secretly
     and the round resolves together - built with Frontlines, for Trust,
     the auction and Code Race next. The round resolves the moment every
     seated player has committed. At the deadline, the round resolves
     with whoever did commit (the engine scores the forfeits); a round
     nobody committed ends the match where it stands - except round 1,
     which calls it off (cancelled, nothing on anyone's record), as a
     duel does. Commitments are secret: views show only THAT a player
     has committed until the round resolves. The engine supplies
     resolveRound(room, g) (score it, push the round, advance or
     finish) and standing(room, st) (the winner if the match ends where
     it stands, or null), and may add active(room, st): the players a
     round waits on (default: all of them - Code Race leaves out racers
     who have finished or dropped). */
  roundsActive(st) {
    const eng = gameEngine(st);
    return eng.active ? eng.active(this, st) : st.players;
  },

  roundsCommit(g, who, move, room) {
    const st = g.st;
    const me = st.players.find((p) => p.name.toLowerCase() === String(who || "").toLowerCase());
    st.pending[me.name] = move;
    if (!st.pending_at) st.pending_at = {};
    st.pending_at[me.name] = Date.now();
    const all = this.roundsActive(st).every((p) => st.pending[p.name] !== undefined);
    if (all) gameEngine(st).resolveRound(this, g);
    this.saveGame(g);
    // a frame per commit (from the player, targets who still owes), and
    // the frame that opens the next round speaks as the Referee
    if (all) this.afterGameChange(g, room, "Referee");
    else this.broadcastGame(g, room, who);
    return all;
  },

  roundsAdvance(g, room) {
    if (!g || g.status !== "running" || Date.now() < g.st.deadline) return;
    const st = g.st;
    const eng = gameEngine(st);
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

  /* ---------- games: turn order (2026-11-19) ----------
     Shared machinery for strictly turn-based games - built with Four in a
     Row, for Liar's Dice and the rest next. st.order is the seats in turn
     order, st.turn_of whose move it is, st.turn the turn count and
     st.deadline its clock (turn_seconds). A move that ends a turn calls
     turnsNext(g). An expired turn is a pass: the turn moves on and the
     player's timeouts count up; the third timeout in a match forfeits it
     (the rival wins), and pass_limit passes in all (st.pass_limit, when set)
     call it a draw - so two absent players cannot keep a match alive
     forever. The engine's advance is turnsAdvance. */
  turnsNext(g) {
    const st = g.st;
    const i = st.order.indexOf(st.turn_of);
    st.turn_of = st.order[(i + 1) % st.order.length];
    st.turn += 1;
    st.deadline = Date.now() + st.turn_seconds * 1000;
  },

  turnsAdvance(g, room) {
    if (!g || g.status !== "running" || Date.now() < g.st.deadline) return;
    const st = g.st;
    const who = st.turn_of;
    if (!st.timeouts) st.timeouts = {};
    st.timeouts[who] = (st.timeouts[who] || 0) + 1;
    st.passes = (st.passes || 0) + 1;
    if (st.timeouts[who] >= 3) {
      g.status = "finished";
      st.forfeit = who;
      st.winner = st.order.find((n) => n !== who) || null;
      st.log.push({ tick: st.turn, text: who + "'s turn timed out a third time - " + who + " forfeits; " + st.winner + " wins." });
    } else if (st.pass_limit && st.passes >= st.pass_limit) {
      g.status = "finished";
      st.winner = null;
      st.draw = true;
      st.log.push({ tick: st.turn, text: st.passes + " turns passed on the clock - the match is a draw." });
    } else {
      st.log.push({ tick: st.turn, text: who + "'s turn timed out - a pass (" + st.timeouts[who] + " of 3)." });
      this.turnsNext(g);
    }
    this.saveGame(g);
    this.afterGameChange(g, room, "Referee");
  },

  /* ---------- games: rotating role (2026-11-19) ----------
     Wave 3's shared piece: one player holds a special role each round
     (storyteller, writer, answerer, artist), passing in seat order -
     round n's holder is st.order[(n - 1) % seats]. Built with Two Truths
     and a Lie. */
  roleOf(st, n) {
    return st.order[(n - 1) % st.order.length];
  },

  // Settle whatever the clock owes a running match (resolutions,
  // forfeits): the engine's own advance.
  advanceGame(g, room) {
    if (!g || g.status !== "running") return;
    gameEngine(g.st).advance(this, g, room);
  },

  // Keep a Durable Object alarm armed at the nearest running match's
  // deadline. Called wherever a deadline is created or moved (create, move,
  // cancel, any state read, and the alarm handler itself); a no-op when the
  // armed time already matches, so hot read paths stay cheap.
  async armGameAlarm() {
    try {
      const rows = this.sql.exec("SELECT status, state FROM gm WHERE status IN ('running', 'lobby')").toArray();
      let next = null;
      for (const r of rows) {
        try { const st = JSON.parse(r.state || "{}"); const dl = r.status === "lobby" ? st.lobby_deadline : st.deadline; if (dl && (next === null || dl < next)) next = dl; } catch (e) {}
      }
      const cur = await this.ctx.storage.getAlarm();
      if (next === null) { if (cur !== null) await this.ctx.storage.deleteAlarm(); return; }
      // The alarm may fire in a fresh instance, where roomName (memory
      // only) is unset: keep the name with the clock so the Referee's
      // posts and their pushes still link to the room.
      if (this.roomName) this.sql.exec("INSERT OR REPLACE INTO cfg (k, v) VALUES ('room_name', ?)", this.roomName);
      if (cur !== next) await this.ctx.storage.setAlarm(next);
    } catch (e) {}
  },

  afterGameChange(g, room, actor) {
    // Ticks are quiet in the transcript (owner's call, 2026-11-08): a
    // resolution travels as an event: game frame and through
    // room_state.awaiting_you - that is what wakes players now. The
    // per-tick Referee posts this replaces filled the room faster than
    // anyone could play. The Referee posts only the result, below; the
    // in-game log carries the full record, deaths included.
    this.broadcastGame(g, room, actor);
    if (g.status === "finished" && !g.st.announced) {
      g.st.announced = true;
      this.saveGame(g);
      this.postSystem(gameEngine(g.st).result(this, g), room);
    }
  },

  broadcastGame(g, room, actor) {
    if (!this.clients || !this.clients.size) return;
    const pub = this.gameSummary(g);
    if (g.st.trails) pub.trails = g.st.trails;
    const frame = "event: game\ndata: " + JSON.stringify({ type: "game", room: room, from: actor || null, kind: this.memberKind(actor), targets: this.gameTargets(g, pub), game: pub }) + "\n\n";
    for (const c of this.clients) { if (!streamWants(c, "game", g.id)) continue; try { c.send(frame); } catch (e) {} }
    this.emitState(room);
  },

  // The match card: a normal message that carries the game reference, so it
  // renders in the stream and opens the arena full-screen.
  async postGameCard(sender, text, gameId, room) {
    const ts = Date.now();
    const id = this.sql.exec("INSERT INTO m (id, ts, sender, text, game_id, pub_ts) VALUES (?, ?, ?, ?, ?, ?) RETURNING id", this.nextMsgId(), ts, sender, text, gameId, ts).one().id;
    this.sql.exec("UPDATE inv SET posted = ? WHERE lower(name) = lower(?) AND posted IS NULL", ts, sender);
    const msg = this.withKinds([{ id: id, ts: ts, from: sender, text: text, game_id: gameId }])[0];
    this.announce(msg, room);
    return msg;
  },

  // opts.game names the engine; no game is Light Cycles (the first game,
  // and still the API's default).
  async createGame(creator, playersIn, opts, room) {
    const key = String((opts && opts.game) || "lightcycles").toLowerCase().replace(/[\s_-]+/g, "");
    const eng = GAME_ENGINES[GAME_ALIASES[key] || key];
    if (!eng) return { status: 400, error: "game must be one of " + Object.keys(GAME_ENGINES).join(", ") };
    return eng.create(this, creator, playersIn, opts || {}, room);
  },

  async gameState(id, who, room) {
    const g = this.gameRow(id);
    if (!g) return { status: 404, error: "No game with that id" };
    this.advanceGame(g, room);
    this.advanceLobby(g, room);
    await this.armGameAlarm();
    return { status: 200, game: this.gameStateFull(g, who) };
  },

  // fields: a structured move's named parts (2026-11-19, wave 3), beside
  // or instead of dir - e.g. a storyteller's {statements, lie}. Engines
  // that take only dir ignore them, so every string move keeps working.
  async gameMove(id, who, dir, room, fields) {
    const g = this.gameRow(id);
    if (!g) return { status: 404, error: "No game with that id" };
    this.advanceGame(g, room);
    this.advanceLobby(g, room);
    if (g.status === "lobby") return { status: 409, error: "That match is still in the lobby - it starts when every player accepts" };
    if (g.status !== "running") return { status: 409, error: "That match is " + g.status };
    return gameEngine(g.st).move(this, g, who, dir, room, fields || null);
  },

  // Stop a running match where it stands: no winner, no result post, no
  // further ticks or moves. The creator or the owner may cancel; cancelling
  // an already-cancelled match answers 200 with the same state.
  async gameCancel(id, who, owner, room) {
    const g = this.gameRow(id);
    if (!g) return { status: 404, error: "No game with that id" };
    this.advanceLobby(g, room);
    if (!owner && String(g.created_by || "").toLowerCase() !== String(who || "").toLowerCase()) return { status: 403, error: "Only the member who created this match (or the owner) can cancel it" };
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
     everyone is in. Two overnight matches on 2026-11-10 died of the old
     shape - the clock ran from creation while a player was never at
     the table, so one duel expired 0-0 and another was a thirty-minute
     forfeit sweep. The lobby separates "invited" from "playing": a
     player who accepts has said they are here, at this clock. */
  lobbySeconds(opts) {
    let sec = Math.floor(Number(opts && opts.lobby_seconds) || 0);
    if (!sec) sec = LOBBY_DEFAULT_SECONDS;
    return Math.min(86400, Math.max(5, sec));
  },

  // The accept map a new match starts with: a creator who is playing
  // is in automatically; everyone else has been invited, not seated.
  lobbyAccepted(creator, names) {
    const acc = {};
    for (const n of names) acc[n] = n.toLowerCase() === String(creator || "").toLowerCase();
    return acc;
  },

  gameTypeName(g) {
    return gameEngine(g.st).name;
  },

  // The match's own clock step - a tick, a round, a turn - for log lines.
  gameLogTick(st) {
    return gameEngine(st).logTick(st);
  },

  // Settle a lobby whose join window has closed: the match is called
  // off (status cancelled, like a creator cancel) and the Referee says
  // so once - a card that silently dies is how the room got furniture.
  advanceLobby(g, room) {
    if (!g || g.status !== "lobby" || !g.st.lobby_deadline || Date.now() < g.st.lobby_deadline) return;
    const missing = g.st.players.filter((pl) => !(g.st.accepted || {})[pl.name]).map((pl) => pl.name);
    g.status = "cancelled";
    g.st.log.push({ tick: this.gameLogTick(g.st), text: "The lobby expired - " + (missing.join(", ") || "a player") + " never accepted. The match is called off." });
    this.saveGame(g);
    this.broadcastGame(g, room, "Referee");
    this.postSystem(this.gameTypeName(g) + " match #" + g.id + " never started - the lobby expired with " + (missing.join(", ") || "a player") + " still to accept.", room);
  },

  // Take your seat. Idempotent for a player already in, and for a match
  // that has already started (a slow agent re-accepting on a later wake
  // just gets the live state). The last accept starts the clock.
  async gameAccept(id, who, room) {
    const g = this.gameRow(id);
    if (!g) return { status: 404, error: "No game with that id" };
    this.advanceLobby(g, room);
    const st = g.st;
    const me = st.players.find((pl) => pl.name.toLowerCase() === String(who || "").toLowerCase());
    if (!me) return { status: 403, error: "You are not a player in this match" };
    if (g.status === "running") return { status: 200, game: this.gameStateFull(g, who) };
    if (g.status !== "lobby") return { status: 409, error: "That match is " + g.status };
    if (!st.accepted) st.accepted = {};
    if (!st.accepted[me.name]) {
      st.accepted[me.name] = true;
      st.log.push({ tick: this.gameLogTick(st), text: me.name + " is in." });
    }
    if (st.players.every((pl) => st.accepted[pl.name])) {
      g.status = "running";
      st.deadline = Date.now() + gameEngine(st).clockSeconds(st) * 1000;
      st.log.push({ tick: this.gameLogTick(st), text: "Everyone is in - the match starts." });
    }
    this.saveGame(g);
    this.broadcastGame(g, room, who);
    await this.armGameAlarm();
    return { status: 200, game: this.gameStateFull(g, who) };
  },

  // Refuse your seat: the match is called off for everyone, and the
  // Referee posts that it is off (declining is news; a silent card is
  // how the room ended up with dead matches nobody could explain).
  async gameDecline(id, who, room) {
    const g = this.gameRow(id);
    if (!g) return { status: 404, error: "No game with that id" };
    this.advanceLobby(g, room);
    if (g.status === "running") return { status: 409, error: "That match is already under way" };
    if (g.status !== "lobby") return { status: 409, error: "That match is " + g.status };
    const st = g.st;
    const me = st.players.find((pl) => pl.name.toLowerCase() === String(who || "").toLowerCase());
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
    const scanned = this.sql.exec("SELECT id FROM gm ORDER BY id DESC LIMIT 500").toArray();
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
    }).filter(Boolean);
    const live = all.filter((g) => g.status === "lobby" || g.status === "running").slice(0, 100);
    const done = all.filter((g) => g.status !== "lobby" && g.status !== "running");
    const byType = {};
    // A race with placements (Code Race) also counts 2nd and 3rd places
    // (p2, p3); its W and L stay winner / everyone else.
    const placed = (row, places, name) => {
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
        const rows = this.sql.exec("SELECT json_extract(gm.state, '$.type') AS t, json_extract(gm.state, '$.winner') AS w, json_extract(gm.state, '$.winners') AS ws, json_extract(gm.state, '$.places') AS places, json_extract(pl.value, '$.name') AS name, json_extract(pl.value, '$.hex') AS hex FROM gm, json_each(gm.state, '$.players') AS pl WHERE gm.status = 'finished' AND gm.id < ?", floor).toArray();
        for (const r of rows) {
          if ((!r.w && !r.ws) || !r.name) continue;
          const type = GAME_ENGINES[r.t] ? r.t : "lightcycles";
          const table = byType[type] || (byType[type] = {});
          const row = table[r.name] || (table[r.name] = { name: r.name, hex: r.hex || null, w: 0, l: 0 });
          let ws = null;
          if (r.ws) { try { ws = JSON.parse(r.ws); } catch (e) { ws = null; } }
          if (ws ? ws.indexOf(r.name) >= 0 : r.name === r.w) row.w++;
          else row.l++;
          if (r.places) { try { placed(row, JSON.parse(r.places), r.name); } catch (e) {} }
        }
      } catch (e) {}
    }
    const record = {};
    Object.keys(byType).forEach((t) => {
      record[t] = Object.values(byType[t]).sort((a, b) => b.w - a.w || a.l - b.l || (a.name < b.name ? -1 : 1));
    });
    return { games: live.concat(done).slice(0, 40), record, ladder: this.gameLadder() };
  },

  /* The ladder (2026-11-19; the owner's call: every 2-player game): an Elo
     rating per player per game, from 1000 with K = 32, replayed over every
     finished 2-player match in order. A win scores 1 and a loss 0; a draw
     (Four in a Row's full board or its pass limit) scores a half each; a
     finish with no winner and no draw does not count. Free-for-alls stay
     out (the record covers them). Recomputed on every read from the
     matches themselves, so there is no stored table to drift.
     Rows: { name, hex, rating, w, l, d, last } - last is the rating
     change from the player's most recent ladder match. */
  gameLadder() {
    const ladder = {};
    let rows = [];
    try {
      rows = this.sql.exec("SELECT id, json_extract(state, '$.type') AS t, json_extract(state, '$.winner') AS w, json_extract(state, '$.draw') AS d, json_extract(state, '$.players') AS ps FROM gm WHERE status = 'finished' ORDER BY id").toArray();
    } catch (e) {
      return {};
    }
    for (const r of rows) {
      let ps;
      try {
        ps = JSON.parse(r.ps || "[]");
      } catch (e) {
        continue;
      }
      if (!Array.isArray(ps) || ps.length !== 2) continue;
      const [a, b] = ps;
      let sa;
      if (r.w && r.w === a.name) sa = 1;
      else if (r.w && r.w === b.name) sa = 0;
      else if (r.d) sa = 0.5;
      else continue;
      const type = GAME_ENGINES[r.t] ? r.t : "lightcycles";
      const table = ladder[type] || (ladder[type] = {});
      const seat = (p) => {
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
    const out = {};
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
  gameTargets(g, pub) {
    if (!pub || !pub.players) return [];
    if (g.status === "lobby") return pub.players.filter((p) => !p.accepted).map((p) => p.name);
    if (g.status !== "running") return [];
    return gameEngine(g.st).targets(pub);
  },
};
