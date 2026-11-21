// Werewolf: hidden roles, night kills, day votes, an in-game discussion.

import { clockWords, seatAccepted } from "./shared.js";
/** @typedef {import("../room/games.js").GameRow} GameRow */
/** @typedef {import("./engine.js").GameEngine} GameEngine */
/** @typedef {import("@chat/contract").GameLogLine} GameLogLine */
/** @typedef {import("@chat/contract").WerewolfRole} WerewolfRole */
/** @typedef {import("@chat/contract").WerewolfEvent} WerewolfEvent */
/** @typedef {import("@chat/contract").WerewolfTalk} WerewolfTalk */
/** @typedef {import("@chat/contract").WerewolfCheck} WerewolfCheck */
/** A seat as createWerewolf stores it (st.players).
 *  @typedef {{ name: string, color: string, hex: string }} WwSeat */
/** Werewolf's stored match state (g.st): what createWerewolf builds and
 *  the moves and the clock change. wwSummary and wwStateFull turn it into
 *  the contract's WerewolfState, keeping the secrets (roles, acts, checks,
 *  the den) to the viewers they belong to. roles and alive are per
 *  player; acts is tonight's picks (actor -> target), votes today's
 *  (voter -> target); phase is null once the match is over; winner stays
 *  null (a side wins: side and winners).
 *  @typedef {{
 *    type: "werewolf", phase_seconds: number, order: string[], roles: Record<string, WerewolfRole>, alive: Record<string, boolean>,
 *    phase: "night" | "day" | null, night: number, day: number, acts: Record<string, string>, last_guard: string | null,
 *    checks: WerewolfCheck[], votes: Record<string, string>, talk: WerewolfTalk[], events: WerewolfEvent[], quiet: number, said: number,
 *    deadline: number | null, lobby_deadline: number, accepted: Record<string, boolean>, players: WwSeat[], log: GameLogLine[],
 *    winner: null, winners: string[] | null, side: "village" | "wolves" | null, places: string[] | null, draw: boolean, announced: boolean,
 *    declined_by?: string, ended?: number
 *  }} WwStored */
/** A Werewolf match: its row, with the state typed.
 *  @typedef {Omit<GameRow, "st"> & { st: WwStored }} WwGame */
/** A seat in Werewolf's room_state item (stateItem): the shared fields,
 *  plus the action it owes now.
 *  @typedef {{ name: string, alive: boolean, moved: boolean, accepted: boolean, act: "kill" | "check" | "guard" | "vote" | null }} WwItemSeat */

// Werewolf: a line of talk's cap.
export const WW_TALK_MAX = 400;

/** @satisfies {ThisType<import("../room/Room.js").Room>} */
export const WerewolfMethods = {
  /* ---------- games: Werewolf (2026-11-20) ----------
     SHA's spec (with Claude's Night shift folded in): 5 to 9 players,
     roles dealt in secret - werewolves (1, or 2 from 7 players), a seer,
     and from 9 a guardian; the rest are villagers. Werewolves know each
     other; nobody else knows anything. Night: each werewolf picks a kill
     (a majority of the living pack; a tie kills nobody), the seer checks
     one player (werewolf or not, privately), the guardian protects one
     (never the same player twice running). Resolution: guard, kill,
     check. Dawn: who died, with their role - or that someone was
     attacked and survived, or a quiet night. Day: open discussion in the
     game's own panel (the owner's call: not room chat), and one public
     vote each, changeable until the day closes; the most votes is
     eliminated, role revealed; a tie eliminates nobody. The village wins
     when no werewolf lives; the wolves win when they match the rest.
     Secrecy: roles, night picks and seer results never reach a public
     view; night moves send no frame (a frame names its actor), and the
     public waiting list stays empty at night - role holders are nudged
     privately (room_state). Night ends early once every living role
     holder has acted, a day once every living player has voted. Two
     full silent cycles call the match off. Each phase has
     phase_seconds (default a day). Wolves can also talk in their own
     den channel. */
  /** @param {number} n */
  wwDeal(n) {
    const wolves = n >= 7 ? 2 : 1;
    /** @type {WerewolfRole[]} */
    const deck = [];
    for (let i = 0; i < wolves; i++) deck.push("werewolf");
    deck.push("seer");
    if (n >= 9) deck.push("guardian");
    while (deck.length < n) deck.push("villager");
    return deck;
  },

  /** @param {WwStored} st */
  wwAlive(st) {
    return st.order.filter((n) => st.alive[n]);
  },

  /** @param {WwStored} st */
  wwLivingWolves(st) {
    return this.wwAlive(st).filter((n) => st.roles[n] === "werewolf");
  },

  // the living players with a night action, and its verb
  /**
   * @param {WwStored} st
   * @param {string} name
   */
  wwVerb(st, name) {
    const r = st.roles[name];
    return r === "werewolf" ? "kill" : r === "seer" ? "check" : r === "guardian" ? "guard" : null;
  },

  /** @param {WwStored} st */
  wwNightActors(st) {
    return this.wwAlive(st).filter((n) => this.wwVerb(st, n));
  },

  /** @param {WwStored} st */
  wwRolesInPlay(st) {
    const out = { werewolf: 0, seer: 0, guardian: 0, villager: 0 };
    for (const n of st.order) out[st.roles[n]] = (out[st.roles[n]] || 0) + 1;
    return out;
  },

  /**
   * @param {WwGame} g
   * @returns {import("@chat/contract").WerewolfState}
   */
  wwSummary(g) {
    const st = g.st;
    const live = g.status === "running";
    const over = g.status === "finished" || g.status === "cancelled";
    return {
      id: g.id, type: "werewolf", status: g.status, created_by: g.created_by, card_msg: g.card_msg,
      phase: live ? st.phase : null, night: st.night, day: st.day, phase_seconds: st.phase_seconds, deadline: st.deadline, lobby_deadline: g.status === "lobby" ? (st.lobby_deadline || null) : null,
      order: st.order, roles_in_play: this.wwRolesInPlay(st), alive_count: this.wwAlive(st).length,
      events: st.events, votes: live && st.phase === "day" ? st.votes : null,
      talk: st.talk.filter((t) => t.ch === "town").slice(-120),
      side: st.side || null, winners: st.winners || null, winner: null, draw: false, places: st.places || null, declined_by: st.declined_by || null,
      players: st.players.map((p) => ({ name: p.name, color: p.color, hex: p.hex, accepted: st.accepted ? !!st.accepted[p.name] : true, alive: !!st.alive[p.name], role: over || !st.alive[p.name] ? st.roles[p.name] : null, voted: live && st.phase === "day" ? st.votes[p.name] !== undefined : false })),
    };
  },

  /**
   * @param {WwGame} g
   * @param {string | null | undefined} who
   * @returns {import("@chat/contract").WerewolfState}
   */
  wwStateFull(g, who) {
    const out = this.wwSummary(g);
    const st = g.st;
    out.log = st.log.slice(-30);
    const live = g.status === "running";
    const over = g.status === "finished" || g.status === "cancelled";
    out.awaiting = live && st.phase === "day" ? this.wwAlive(st).filter((n) => st.votes[n] === undefined) : [];
    out.awaiting_accept = g.status === "lobby" ? st.players.filter((p) => !(st.accepted || {})[p.name]).map((p) => p.name) : [];
    if (over) out.den = st.talk.filter((t) => t.ch === "den");
    const me = st.players.find((p) => p.name.toLowerCase() === String(who || "").toLowerCase());
    if (!me) {
      out.you = { playing: false };
      return out;
    }
    const role = st.roles[me.name];
    const alive = !!st.alive[me.name];
    /** @type {import("@chat/contract").WerewolfYou} */
    const you = { playing: true, accepted: st.accepted ? !!st.accepted[me.name] : true, role: role, alive: alive, legal_moves: [] };
    if (role === "werewolf") {
      you.pack = st.order.filter((n) => st.roles[n] === "werewolf" && n !== me.name);
      if (!over) out.den = st.talk.filter((t) => t.ch === "den").slice(-120);
      if (live && st.phase === "night") you.pack_picks = Object.fromEntries(this.wwLivingWolves(st).filter((n) => st.acts[n]).map((n) => [n, st.acts[n]]));
    }
    if (role === "seer") you.checks = st.checks;
    if (role === "guardian") you.last_guard = st.last_guard || null;
    if (live && alive) {
      const verb = this.wwVerb(st, me.name);
      if (st.phase === "night" && verb) {
        you.act = st.acts[me.name] || null;
        you.legal_moves = this.wwNightTargets(st, me.name).map((n) => verb + " " + n);
      } else if (st.phase === "day") {
        you.vote = st.votes[me.name] === undefined ? null : st.votes[me.name];
        you.legal_moves = this.wwAlive(st).map((n) => "vote " + n);
      }
    }
    out.you = you;
    return out;
  },

  // who a night action may name
  /**
   * @param {WwStored} st
   * @param {string} name
   */
  wwNightTargets(st, name) {
    const verb = this.wwVerb(st, name);
    const alive = this.wwAlive(st);
    if (verb === "kill") return alive.filter((n) => st.roles[n] !== "werewolf");
    if (verb === "check") return alive.filter((n) => n !== name);
    if (verb === "guard") return alive.filter((n) => n !== st.last_guard);
    return [];
  },

  /**
   * @param {string} creator
   * @param {unknown[]} playersIn
   * @param {Record<string, unknown>} opts the create's options (request JSON)
   * @param {string} room
   */
  async createWerewolf(creator, playersIn, opts, room) {
    if (!Array.isArray(playersIn) || playersIn.length < 5 || playersIn.length > 9) return { status: 400, error: "Werewolf needs 5 to 9 players" };
    const resolved = this.gamePlayers(playersIn);
    if (resolved.error) return resolved;
    const names = /** @type {string[]} */ (resolved.names).slice(); // gamePlayers sets names whenever it sets no error
    const deck = this.wwDeal(names.length);
    for (let i = deck.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    /** @type {(v: unknown, lo: number, hi: number, def: number) => number} */
    const clamp = (v, lo, hi, def) => { const n = Math.floor(Number(v)); return Number.isFinite(n) && n > 0 ? Math.min(hi, Math.max(lo, n)) : def; };
    const phaseSeconds = clamp(opts.tick_seconds, 60, 86400 * 2, 86400);
    const colors = this.gameColors();
    const players = names.map((n, i) => ({ name: n, color: colors[i].color, hex: colors[i].hex }));
    /** @type {Record<string, WerewolfRole>} */
    const roles = {};
    /** @type {Record<string, boolean>} */
    const alive = {};
    names.forEach((n, i) => {
      roles[n] = deck[i];
      alive[n] = true;
    });
    /** @type {WwStored} */
    const st = {
      type: "werewolf", phase_seconds: phaseSeconds, order: names.slice(), roles: roles, alive: alive, phase: "night", night: 1, day: 0,
      acts: {}, last_guard: null, checks: [], votes: {}, talk: [], events: [], quiet: 0, said: 0,
      deadline: null, lobby_deadline: Date.now() + this.lobbySeconds(opts) * 1000, accepted: this.lobbyAccepted(creator, names), players: players,
      log: [{ tick: 0, text: "Werewolf created by " + creator + " - " + names.length + " players; roles are dealt in secret. The first night falls when everyone accepts." }],
      winner: null, winners: null, side: null, places: null, draw: false, announced: false,
    };
    const ins = /** @type {Pick<import("../room/Room.js").GmRow, "id">} */ (this.sql.exec("INSERT INTO gm (status, created, created_by, state) VALUES ('lobby', ?, ?, ?) RETURNING id", Date.now(), creator, JSON.stringify(st)).one());
    const g = /** @type {GameRow} */ (this.gameRow(ins.id)); // the row just inserted
    const rip = this.wwRolesInPlay(st);
    const label = players.map((p) => p.name + " (" + p.color + ")").join(", ");
    const cardText = "Werewolf #" + g.id + " - " + label + ". " + rip.werewolf + (rip.werewolf === 1 ? " werewolf" : " werewolves") + ", a seer" + (rip.guardian ? ", a guardian" : "") + " and " + rip.villager + " villagers, dealt in secret. Nights the wolves hunt; days the village talks it out in the game and votes. Each phase: " + clockWords(phaseSeconds) + ". Lobby open - the first night falls when everyone accepts; tap the card to take your seat.";
    const msg = await this.postGameCard(creator, cardText, g.id, room);
    this.sql.exec("UPDATE gm SET card_msg = ? WHERE id = ?", msg.id, g.id);
    g.card_msg = msg.id;
    this.broadcastGame(g, room, creator);
    await this.armGameAlarm();
    return { status: 201, game: this.wwStateFull(g, creator) };
  },

  /**
   * @param {WwStored} st
   * @param {unknown} raw
   */
  wwName(st, raw) {
    const s = String(raw || "").trim().toLowerCase();
    return st.order.find((n) => n.toLowerCase() === s) || null;
  },

  // The village wins with no wolf alive; the wolves win at parity.
  /** @param {WwGame} g */
  wwCheckWin(g) {
    const st = g.st;
    const wolves = this.wwLivingWolves(st).length;
    const rest = this.wwAlive(st).length - wolves;
    /** @type {"village" | "wolves" | null} */
    let side = null;
    if (!wolves) side = "village";
    else if (wolves >= rest) side = "wolves";
    if (!side) return false;
    g.status = "finished";
    st.side = side;
    st.winners = st.order.filter((n) => (side === "wolves") === (st.roles[n] === "werewolf"));
    const losers = st.order.filter((n) => /** @type {string[]} */ (st.winners).indexOf(n) < 0); // set just above
    /** @type {(a: string, b: string) => number} */
    const byAlive = (a, b) => (st.alive[b] ? 1 : 0) - (st.alive[a] ? 1 : 0);
    st.places = st.winners.slice().sort(byAlive).concat(losers.slice().sort(byAlive));
    st.phase = null;
    st.deadline = null;
    st.log.push({ tick: st.night, text: side === "village" ? "The last werewolf is gone - the village wins." : "The wolves match the village - the wolves win." });
    return true;
  },

  /** @param {WwGame} g */
  wwResolveNight(g) {
    const st = g.st;
    const acted = this.wwNightActors(st).filter((n) => st.acts[n]).length;
    const guardian = this.wwAlive(st).find((n) => st.roles[n] === "guardian");
    const guard = guardian && st.acts[guardian] ? st.acts[guardian] : null;
    /** @type {Record<string, number>} kills per target */
    const tally = {};
    for (const w of this.wwLivingWolves(st)) if (st.acts[w]) tally[st.acts[w]] = (tally[st.acts[w]] || 0) + 1;
    const top = Math.max(0, ...Object.values(tally));
    const picks = Object.keys(tally).filter((n) => tally[n] === top);
    const victim = top && picks.length === 1 ? picks[0] : null;
    const seer = this.wwAlive(st).find((n) => st.roles[n] === "seer");
    if (seer && st.acts[seer]) st.checks.push({ night: st.night, target: st.acts[seer], wolf: st.roles[st.acts[seer]] === "werewolf" });
    /** @type {Omit<WerewolfEvent, "at"> & { at?: number }} the dawn's event, stamped below */
    let ev;
    if (victim && victim === guard) ev = { night: st.night, kind: "saved" };
    else if (victim) {
      st.alive[victim] = false;
      ev = { night: st.night, kind: "death", who: victim, role: st.roles[victim] };
    } else ev = { night: st.night, kind: "quiet" };
    ev.at = Date.now();
    st.events.push(/** @type {WerewolfEvent} */ (ev));
    st.last_guard = guard;
    st.acts = {};
    st.log.push({ tick: st.night, text: "Dawn of day " + st.night + ": " + (ev.kind === "death" ? ev.who + " was killed in the night - a " + ev.role + "." : ev.kind === "saved" ? "someone was attacked in the night and survived." : "the night passed quietly.") });
    st.quiet = acted ? 0 : st.quiet + 1;
    if (this.wwCheckWin(g)) return;
    if (st.quiet >= 4) return this.wwCallOff(g);
    st.phase = "day";
    st.day = st.night;
    st.votes = {};
    st.said = 0;
    st.deadline = Date.now() + st.phase_seconds * 1000;
  },

  /** @param {WwGame} g */
  wwResolveDay(g) {
    const st = g.st;
    const alive = this.wwAlive(st);
    /** @type {Record<string, number>} votes per target */
    const tally = {};
    for (const n of alive) {
      const t = st.votes[n];
      if (t && st.alive[t]) tally[t] = (tally[t] || 0) + 1;
    }
    const top = Math.max(0, ...Object.values(tally));
    const tops = Object.keys(tally).filter((n) => tally[n] === top);
    /** @type {Omit<WerewolfEvent, "at"> & { at?: number }} the day's event, stamped below */
    let ev;
    if (!top) ev = { day: st.day, kind: "novote" };
    else if (tops.length > 1) ev = { day: st.day, kind: "tie", votes: Object.assign({}, st.votes) };
    else {
      st.alive[tops[0]] = false;
      ev = { day: st.day, kind: "eliminated", who: tops[0], role: st.roles[tops[0]], count: top, votes: Object.assign({}, st.votes) };
    }
    ev.at = Date.now();
    st.events.push(/** @type {WerewolfEvent} */ (ev));
    st.log.push({ tick: st.day, text: "Day " + st.day + " closes: " + (ev.kind === "eliminated" ? "the village votes out " + ev.who + " (" + top + " votes) - a " + ev.role + "." : ev.kind === "tie" ? "a tied vote - nobody is eliminated." : "nobody voted.") });
    st.quiet = top || st.said ? 0 : st.quiet + 1;
    st.votes = {};
    if (this.wwCheckWin(g)) return;
    if (st.quiet >= 4) return this.wwCallOff(g);
    st.phase = "night";
    st.night += 1;
    st.acts = {};
    st.deadline = Date.now() + st.phase_seconds * 1000;
  },

  /** @param {WwGame} g */
  wwCallOff(g) {
    const st = g.st;
    g.status = "cancelled";
    st.phase = null;
    st.deadline = null;
    st.log.push({ tick: st.night, text: "Two full days and nights went by in silence - the match is called off." });
  },

  /**
   * @param {WwGame} g
   * @param {string} who
   * @param {unknown} raw
   * @param {string} room
   */
  async wwMove(g, who, raw, room) {
    const st = g.st;
    const me = st.players.find((p) => p.name.toLowerCase() === String(who || "").toLowerCase());
    if (!me) return { status: 403, error: "You are not a player in this match" };
    if (!st.alive[me.name]) return { status: 409, error: "You are dead - you can watch, but not speak or act" };
    const text = String(raw || "").replace(/\s+/g, " ").trim();
    const isWolf = st.roles[me.name] === "werewolf";
    // talk: say (town by day; the den at night for wolves), den (wolves, any time)
    const talk = text.match(/^(say|den)\s*:\s*(.+)$/i);
    if (talk) {
      const den = talk[1].toLowerCase() === "den" || st.phase === "night";
      if (den && !isWolf) return { status: 409, error: st.phase === "night" ? "The village sleeps - talk resumes at dawn" : "Only the wolves have a den" };
      const body = talk[2].slice(0, WW_TALK_MAX);
      // a running match is always in a phase
      st.talk.push({ n: st.talk.length + 1, by: me.name, text: body, ch: den ? "den" : "town", phase: /** @type {"night" | "day"} */ (st.phase), day: st.phase === "day" ? st.day : st.night, at: Date.now() });
      if (st.talk.length > 600) st.talk = st.talk.slice(-600);
      if (!den) st.said += 1;
      this.saveGame(g);
      // the den is secret: no frame (a frame names its speaker)
      if (!den) this.broadcastGame(g, room, me.name);
      return { status: 200, game: this.wwStateFull(g, who), resolved: false };
    }
    const m = text.match(/^(kill|check|guard|vote)?\s*:?\s*(.+)$/i);
    const target = m ? this.wwName(st, m[2]) : null;
    if (st.phase === "night") {
      const verb = this.wwVerb(st, me.name);
      if (!verb) return { status: 409, error: "The village sleeps - you have nothing to do tonight" };
      if (m && m[1] && m[1].toLowerCase() !== verb) return { status: 400, error: "Tonight you " + verb + ", not " + m[1].toLowerCase(), legal_moves: this.wwNightTargets(st, me.name).map((n) => verb + " " + n) };
      const ok = this.wwNightTargets(st, me.name);
      if (!target || ok.indexOf(target) < 0) return { status: 400, error: verb === "guard" && target === st.last_guard ? "You guarded " + target + " last night - choose someone else" : "Name a living player you may " + verb, legal_moves: ok.map((n) => verb + " " + n) };
      st.acts[me.name] = target;
      const all = this.wwNightActors(st).every((n) => st.acts[n]);
      if (all) this.wwResolveNight(g);
      this.saveGame(g);
      // a night move sends no frame of its own (it would name the actor);
      // the frame that opens the day speaks as the Referee
      if (all) this.afterGameChange(g, room, "Referee");
      await this.armGameAlarm();
      return { status: 200, game: this.wwStateFull(g, who), resolved: all };
    }
    if (m && m[1] && m[1].toLowerCase() !== "vote") return { status: 400, error: "By day there is only the vote", legal_moves: this.wwAlive(st).map((n) => "vote " + n) };
    if (!target || !st.alive[target]) return { status: 400, error: "Vote for a living player (yourself included)", legal_moves: this.wwAlive(st).map((n) => "vote " + n) };
    st.votes[me.name] = target;
    const all = this.wwAlive(st).every((n) => st.votes[n] !== undefined);
    if (all) this.wwResolveDay(g);
    this.saveGame(g);
    if (all) this.afterGameChange(g, room, "Referee");
    else this.broadcastGame(g, room, me.name);
    await this.armGameAlarm();
    return { status: 200, game: this.wwStateFull(g, who), resolved: all };
  },

  /**
   * @param {WwGame | null} g
   * @param {string} room
   */
  wwAdvance(g, room) {
    if (!g || g.status !== "running" || Date.now() < /** @type {number} */ (g.st.deadline)) return; // a running match's clock is set
    if (g.st.phase === "night") this.wwResolveNight(g);
    else this.wwResolveDay(g);
    this.saveGame(g);
    // the resolution may have called it off (the check above narrowed status to running)
    if (/** @type {import("@chat/contract").GameStatus} */ (g.status) === "cancelled") this.postSystem("Werewolf #" + g.id + " is off - two full days and nights went by in silence.", room);
    this.afterGameChange(g, room, "Referee");
  },

  /** @param {WwGame} g */
  wwResultText(g) {
    const st = g.st;
    const wolves = st.order.filter((n) => st.roles[n] === "werewolf");
    const others = st.order.filter((n) => st.roles[n] === "seer" || st.roles[n] === "guardian").map((n) => n + " the " + st.roles[n]);
    const when = st.phase === null && st.events.length ? st.events[st.events.length - 1] : null;
    const at = when ? (when.night ? "dawn of day " + when.night : "day " + when.day) : "the end";
    return "Werewolf #" + g.id + " is over - " + (st.side === "village" ? "the village wins at " + at + ": the " + (wolves.length === 1 ? "werewolf was " : "werewolves were ") + wolves.join(" and ") + "." : "the wolves win at " + at + ": " + wolves.join(" and ") + " outnumber the village.") + (others.length ? " " + others.join(", ") + "." : "");
  },
};

/** @satisfies {GameEngine} */
export const werewolfEngine = {
  name: "Werewolf",
  turnWord: "phase",
  logTick: (/** @type {WwStored} */ st) => st.night,
  clockSeconds: (/** @type {WwStored} */ st) => st.phase_seconds,
  create: (room, creator, players, opts, roomName) => room.createWerewolf(creator, players, opts, roomName),
  summary: (room, g) => room.wwSummary(g),
  full: (room, g, who) => room.wwStateFull(g, who),
  move: (room, g, who, dir, roomName) => room.wwMove(g, who, dir, roomName),
  advance: (room, g, roomName) => room.wwAdvance(g, roomName),
  // public frames never say who is awaited at night (that would point at
  // the role holders); they are nudged privately through room_state
  // pub is wwSummary's state
  targets: (/** @type {import("@chat/contract").WerewolfState} */ pub) => (pub.status === "running" && pub.phase === "day" ? (pub.players || []).filter((p) => p.alive && !p.voted).map((p) => p.name) : []),
  card: (/** @type {WwGame} */ g) => {
    const st = g.st;
    const over = g.status === "finished" || g.status === "cancelled";
    return { id: g.id, type: "werewolf", status: g.status, phase: g.status === "running" ? st.phase : null, night: st.night, day: st.day, side: st.side || null, winners: st.winners || null, winner: null, draw: false, players: st.players.map((p) => ({ name: p.name, color: p.color, hex: p.hex, alive: !!st.alive[p.name], role: over || !st.alive[p.name] ? st.roles[p.name] : null })) };
  },
  // private: only ever rendered into each member's own awaiting_you
  stateItem: (r, /** @type {WwStored} */ st) => ({ id: r.id, type: "werewolf", status: r.status, phase: st.phase, turn: (st.night || 0) * 2 + (st.phase === "day" ? 1 : 0), players: (st.players || []).map((p) => {
    const role = (st.roles || {})[p.name];
    const verb = role === "werewolf" ? "kill" : role === "seer" ? "check" : role === "guardian" ? "guard" : null;
    const alive = !!(st.alive || {})[p.name];
    const moved = r.status !== "running" || (st.phase === "night" ? !verb || !!(st.acts || {})[p.name] : (st.votes || {})[p.name] !== undefined);
    return { name: p.name, alive: alive, moved: moved, act: st.phase === "night" ? verb : "vote", accepted: seatAccepted(st, p) };
  }) }),
  turnOf: (gm) => gm.turn,
  moveHint: (gm, name) => {
    // a seat of this game's stateItem, which carries act
    const me = /** @type {Partial<WwItemSeat>} */ ((gm.players || []).find((p) => p.name === name) || {});
    return "<" + (me.act || "vote") + " NAME - " + (me.act === "kill" ? "your kill for tonight" : me.act === "check" ? "whose side to see" : me.act === "guard" ? "who to protect tonight" : "who the village should vote out") + ">";
  },
  result: (room, g) => room.wwResultText(g),
  rules: (/** @type {WwStored} */ st) => {
    const rip = { werewolf: 0, seer: 0, guardian: 0, villager: 0 };
    for (const n of st.order) rip[st.roles[n]] += 1;
    return "Werewolf: " + st.order.length + " players with secret roles - " + rip.werewolf + (rip.werewolf === 1 ? " werewolf" : " werewolves") + ", a seer" + (rip.guardian ? ", a guardian" : "") + " and " + rip.villager + " villagers; your own is you.role, and werewolves see their pack in you.pack. " +
      "Night: each werewolf sends kill NAME (the pack's majority kills; a tie kills nobody), the seer check NAME (you.checks tells werewolf or not), the guardian guard NAME (not the same player two nights running); villagers sleep. Dawn names the dead and their role. " +
      "Day: talk it out in the game - send say: TEXT (werewolves also have den: TEXT, their private channel, and say: at night goes to the den) - and vote NAME (public, changeable until the day closes; yourself included). The most votes is out, role revealed; a tie removes nobody. " +
      "The village wins when no werewolf lives; the wolves win when they match everyone else. Lying is part of the game. Each phase has " + clockWords(st.phase_seconds || 86400) + "; a night ends early once every role has acted, a day once everyone living has voted. The dead watch but do not speak.";
  },
};
