// Liar's Dice: hidden dice, rising bids, call liar; ones are wild.

import { clockWords, seatAccepted } from "./shared.js";
import type { GameLogLine, LiarsDiceBid, LiarsDiceRound, LiarsDiceState } from "@chat/contract";
import type { GmRow, Room } from "../room/Room.js";
import type { GameRow } from "../room/games.js";
import type { GameEngineOf } from "./engine.js";
import { randInt } from "../lib/random.js";

/** A seat as createLiarsDice stores it (st.players). */
export type LdSeat = { name: string, color: string, hex: string };
/** Liar's Dice's stored match state (g.st): what createLiarsDice builds and
 *  the moves and the clock change. ldSummary and ldStateFull turn it into
 *  the contract's LiarsDiceState. order is the seats still in, count and
 *  cups every seat's dice (an empty cup once out), bid and bids the round
 *  in play, rounds the closed ones (stored as the API shows them). */
export type LdStored = {
  type: "liarsdice", turn_seconds: number, turn: number, round: number, order: string[], turn_of: string | null,
  dice_each: number, ones_wild: boolean, count: Record<string, number>, cups: Record<string, number[]>,
  bid: LiarsDiceBid | null, bids: LiarsDiceBid[], rounds: LiarsDiceRound[], out: string[], timeouts: Record<string, number>,
  deadline: number | null, lobby_deadline: number, accepted: Record<string, boolean>, players: LdSeat[], log: GameLogLine[],
  winner: string | null, places: string[] | null, forfeit: string | null, announced: boolean,
  declined_by?: string, ended?: number
};
/** A Liar's Dice match: its row, with the state typed. */
export type LdGame = Omit<GameRow, "st"> & { st: LdStored };

export const LiarsDiceMethods = {
  // Liar's Dice in tests: set the cups (each must keep its die count) and/or
  // expire the turn clock so the next read runs the timeout.
  /** @param cups name -> faces, from the request's JSON */
  setTestLiarsDice(id: number, cups: Record<string, unknown> | null | undefined, expire: boolean) {
    if (!this.env || !this.env.TEST_HOOKS) return { error: "Not found" };
    const g = this.gameRowOf<LdStored>(id, "liarsdice");
    if (!g) return { error: "No Liar's Dice match with that id" };
    if (cups && typeof cups === "object") {
      for (const n of Object.keys(cups)) {
        if (!g.st.cups[n] || !Array.isArray(cups[n]) || cups[n].length !== g.st.cups[n].length) return { error: "cups must keep each player's die count" };
        g.st.cups[n] = cups[n].map((d) => Math.min(6, Math.max(1, Math.floor(Number(d) || 1))));
      }
    }
    if (expire) g.st.deadline = Date.now() - 1;
    this.saveGame(g);
    return { ok: true };
  },

  /* ---------- games: Liar's Dice ----------
     Player rules: rules() below. Secrecy: a view shows only your own cup
     and the cups of rounds a liar call opened. On the turn-order helper, with
     its own clock (ldAdvance): every timeout costs a die, so a match
     always ends. st.order holds the seats still in, so turnsNext skips
     the eliminated. */
  ldRoll(n: number) {
    const out = [];
    while (out.length < n) {
      const a = new Uint8Array(n * 2);
      crypto.getRandomValues(a);
      for (const x of a) if (x < 252 && out.length < n) out.push((x % 6) + 1);
    }
    return out;
  },

  ldTotal(st: LdStored) {
    return st.order.reduce((s, n) => s + (st.count[n] || 0), 0);
  },

  ldFaceWord(f: number, plural: boolean) {
    const w = ["", "one", "two", "three", "four", "five", "six"][f] || String(f);
    return plural ? (f === 6 ? "sixes" : w + "s") : w;
  },

  ldBidText(b: Pick<LiarsDiceBid, "qty" | "face">) {
    return b.qty + " " + this.ldFaceWord(b.face, b.qty !== 1);
  },

  // How many dice on the table show face (ones count too when wild).
  ldCount(st: LdStored, face: number) {
    let n = 0;
    for (const nm of st.order) for (const d of st.cups[nm] || []) if (d === face || (st.ones_wild && d === 1 && face !== 1)) n++;
    return n;
  },

  // The lowest legal raise for each face, then liar when there is a bid.
  ldLegal(st: LdStored) {
    const total = this.ldTotal(st);
    const out = [];
    const b = st.bid;
    for (let f = st.ones_wild ? 2 : 1; f <= 6; f++) {
      const q = !b ? 1 : f > b.face ? b.qty : b.qty + 1;
      if (q <= total) out.push(q + "x" + f);
    }
    if (b) out.push("liar");
    return out;
  },

  // dir: "liar" (or call / challenge), or a bid: 3x4, 3 4, "3 fours".
  ldParse(raw: unknown): { call: true } | { call?: undefined, qty: number, face: number } | null {
    const s = String(raw || "").trim().toLowerCase().replace(/^bid\s*:?\s*/, "");
    if (/^(liar|call|challenge|call liar)!?$/.test(s)) return { call: true };
    const words: Record<string, number> = { ones: 1, one: 1, twos: 2, two: 2, threes: 3, three: 3, fours: 4, four: 4, fives: 5, five: 5, sixes: 6, six: 6 };
    const nums: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };
    let m = s.match(/^(\d{1,2})\s*(?:x|×|\*)\s*([1-6])s?$/);
    if (m) return { qty: Number(m[1]), face: Number(m[2]) };
    // 3 4s, 3 fours, three 4s, three fours
    m = s.match(/^(\d{1,2}|[a-z]+)\s+([1-6]|[a-z]+)'?s?$/);
    if (m) {
      const qty = /^\d+$/.test(m[1]) ? Number(m[1]) : nums[m[1]];
      const face = /^[1-6]$/.test(m[2]) ? Number(m[2]) : words[m[2]] || words[m[2] + "s"];
      if (qty && face) return { qty: qty, face: face };
    }
    return null;
  },

  ldShow(st: LdStored, nm: string) {
    return (st.cups[nm] || []).slice().sort((a, b) => a - b);
  },

  // A closed round as a view shows it. Only a liar call opens the cups: a
  // round a timeout or forfeit closed stores none, and one stored before
  // that rule shows its cups only once the match is over (they let
  // rivals see whether the last bid was a bluff no one paid to call).
  ldShownRound(g: LdGame, r: LiarsDiceRound): LiarsDiceRound {
    if (r.reason === "call" || g.status === "finished" || !Object.keys(r.cups || {}).length) return r;
    const held: Record<string, number> = {};
    for (const n of Object.keys(r.cups)) held[n] = r.cups[n].length;
    return Object.assign({}, r, { cups: {}, held: r.held || held });
  },

  ldSummary(g: LdGame): LiarsDiceState {
    const st = g.st;
    const last = st.rounds.length ? this.ldShownRound(g, st.rounds[st.rounds.length - 1]) : null;
    return {
      id: g.id, type: "liarsdice", status: g.status, created_by: g.created_by, card_msg: g.card_msg,
      turn: st.turn, round: st.round, turn_of: g.status === "running" ? st.turn_of : null, turn_seconds: st.turn_seconds, deadline: st.deadline, lobby_deadline: g.status === "lobby" ? (st.lobby_deadline || null) : null,
      dice_each: st.dice_each, ones_wild: !!st.ones_wild, dice_total: this.ldTotal(st), order: st.order, bid: st.bid || null, bids: st.bids, last_round: last,
      winner: st.winner || null, draw: false, places: st.places || null, forfeit: st.forfeit || null, declined_by: st.declined_by || null,
      players: st.players.map((p) => ({ name: p.name, color: p.color, hex: p.hex, accepted: st.accepted ? !!st.accepted[p.name] : true, dice: st.count[p.name] || 0, out: st.order.indexOf(p.name) < 0, timeouts: (st.timeouts || {})[p.name] || 0 })),
    };
  },

  ldStateFull(g: LdGame, who: string | null | undefined): LiarsDiceState {
    const out = this.ldSummary(g);
    const st = g.st;
    out.rounds = st.rounds.map((r) => this.ldShownRound(g, r));
    out.log = st.log.slice(-24);
    out.awaiting = g.status === "running" && st.turn_of ? [st.turn_of] : [];
    out.awaiting_accept = g.status === "lobby" ? st.players.filter((p) => !(st.accepted || {})[p.name]).map((p) => p.name) : [];
    const me = st.players.find((p) => p.name.toLowerCase() === String(who || "").toLowerCase());
    if (me) {
      const mine = g.status === "running" && st.turn_of === me.name;
      out.you = { playing: true, accepted: st.accepted ? !!st.accepted[me.name] : true, dice: g.status === "finished" ? [] : this.ldShow(st, me.name), out: st.order.indexOf(me.name) < 0, your_turn: mine, timeouts: (st.timeouts || {})[me.name] || 0, legal_moves: mine ? this.ldLegal(st) : [] };
    } else out.you = { playing: false };
    return out;
  },

  /** @param opts the create's options (request JSON) */
  async createLiarsDice(creator: string, playersIn: unknown[], opts: Record<string, unknown>, room: string) {
    if (!Array.isArray(playersIn) || playersIn.length < 2 || playersIn.length > 6) return { status: 400, error: "Liar's Dice needs 2 to 6 players" };
    const resolved = this.gamePlayers(playersIn);
    if (resolved.error) return resolved;
    // seats in a random order; the first seat opens
    const names = (resolved.names as string[]).slice(); // gamePlayers sets names whenever it sets no error
    for (let i = names.length - 1; i > 0; i--) {
      const j = randInt(i + 1);
      [names[i], names[j]] = [names[j], names[i]];
    }
    let turnSeconds = Math.floor(Number(opts.tick_seconds) || 0);
    if (!turnSeconds) turnSeconds = 3600;
    turnSeconds = Math.min(86400, Math.max(30, turnSeconds));
    const each = Math.min(6, Math.max(2, Math.floor(Number(opts.dice) || 5)));
    const wild = opts.ones_wild === undefined || opts.ones_wild === null ? true : !(opts.ones_wild === false || opts.ones_wild === "false" || opts.ones_wild === 0);
    const colors = this.gameColors();
    const players = (resolved.names as string[]).map((n, i) => ({ name: n, color: colors[i].color, hex: colors[i].hex }));
    const count: Record<string, number> = {};
    const cups: Record<string, number[]> = {};
    names.forEach((n) => {
      count[n] = each;
      cups[n] = this.ldRoll(each);
    });
    const st: LdStored = {
      type: "liarsdice", turn_seconds: turnSeconds, turn: 1, round: 1, order: names.slice(), turn_of: names[0],
      dice_each: each, ones_wild: wild, count: count, cups: cups, bid: null, bids: [], rounds: [], out: [], timeouts: {},
      deadline: null, lobby_deadline: Date.now() + this.lobbySeconds(opts) * 1000, accepted: this.lobbyAccepted(creator, resolved.names), players: players,
      log: [{ tick: 0, text: "Liar's Dice created by " + creator + " - " + names.join(", ") + " in seat order, " + each + " dice each, ones " + (wild ? "wild" : "not wild") + "; " + names[0] + " opens. The clock starts when everyone accepts." }],
      winner: null, places: null, forfeit: null, announced: false,
    };
    const ins = this.sql.exec<Pick<GmRow, "id">>("INSERT INTO gm (status, created, created_by, state) VALUES ('lobby', ?, ?, ?) RETURNING id", Date.now(), creator, JSON.stringify(st)).one();
    const g = this.gameRowOf<LdStored>(ins.id, "liarsdice")!; // the row just inserted
    const label = players.map((p) => p.name + " (" + p.color + ")").join(", ");
    const cardText = "Liar's Dice #" + g.id + " - " + label + ". " + each + " hidden dice each" + (wild ? ", ones wild" : "") + ": raise the bid or call liar; the last one with dice wins. " + names[0] + " opens. Turn clock: " + clockWords(turnSeconds) + ". Lobby open - the match starts when everyone accepts; tap the card to take your seat.";
    const msg = await this.postGameCard(creator, cardText, g.id, room);
    this.sql.exec("UPDATE gm SET card_msg = ? WHERE id = ?", msg.id, g.id);
    g.card_msg = msg.id;
    this.broadcastGame(g, room, creator);
    await this.armGameAlarm();
    return { status: 201, game: this.ldStateFull(g, creator) };
  },

  // A player leaves the table: out of order, onto the out list.
  ldEliminate(st: LdStored, nm: string) {
    const i = st.order.indexOf(nm);
    if (i < 0) return;
    st.order.splice(i, 1);
    st.count[nm] = 0;
    st.out.push(nm);
  },

  // Close the round: record it (every cup opened on a liar call; on a
  // timeout or forfeit only how many dice each seat held), take the
  // loser's die (or their seat), then finish or deal the next round.
  /** @param rec how the round closed */
  ldEndRound(g: LdGame, rec: Pick<LiarsDiceRound, "reason" | "call" | "face" | "count" | "stands">, loser: string, eliminate: boolean) {
    const st = g.st;
    const cups: Record<string, number[]> = {};
    const held: Record<string, number> = {};
    st.order.forEach((n) => {
      held[n] = (st.cups[n] || []).length;
      // Nobody called, so nothing is opened: storing every cup here let
      // rivals, spectators and the games list read a bluff that a
      // timeout, not a call, ended.
      if (rec.reason === "call") cups[n] = this.ldShow(st, n);
    });
    const seat = st.order.indexOf(loser);
    if (eliminate) this.ldEliminate(st, loser);
    else {
      st.count[loser] = Math.max(0, (st.count[loser] || 0) - 1);
      if (!st.count[loser]) this.ldEliminate(st, loser);
    }
    const isOut = st.order.indexOf(loser) < 0;
    st.rounds.push(Object.assign({ n: st.round, cups: cups, held: held, bids: st.bids.slice(), loser: loser, out: isOut, dice_left: st.count[loser] || 0, at: Date.now() }, rec));
    if (st.order.length <= 1) {
      g.status = "finished";
      st.winner = st.order[0] || null;
      st.places = (st.winner ? [st.winner] : []).concat(st.out.slice().reverse());
      st.turn_of = null;
      st.deadline = null;
      st.bid = null;
      st.log.push({ tick: st.turn, text: st.winner + " is the last with dice - " + st.winner + " wins." });
      return;
    }
    // the loser opens the next round, or the seat after theirs
    const opener = isOut ? st.order[seat % st.order.length] : loser;
    st.round += 1;
    st.turn += 1;
    st.bid = null;
    st.bids = [];
    st.order.forEach((n) => (st.cups[n] = this.ldRoll(st.count[n])));
    st.out.forEach((n) => (st.cups[n] = []));
    st.turn_of = opener;
    st.deadline = Date.now() + st.turn_seconds * 1000;
  },

  async ldMove(g: LdGame, who: string, raw: unknown, room: string) {
    const st = g.st;
    const me = st.players.find((p) => p.name.toLowerCase() === String(who || "").toLowerCase());
    if (!me) return { status: 403, error: "You are not a player in this match" };
    if (st.order.indexOf(me.name) < 0) return { status: 409, error: "You are out of this match" };
    if (st.turn_of !== me.name) return { status: 409, error: "It's " + st.turn_of + "'s turn" };
    const mv = this.ldParse(raw);
    if (!mv) return { status: 400, error: "dir is a bid like 3x4 (at least three 4s on the table), or liar", legal_moves: this.ldLegal(st) };
    st.timeouts[me.name] = 0;
    if (mv.call) {
      const b = st.bid;
      if (!b) return { status: 400, error: "There is no bid to call yet - open with a bid like 1x" + (st.ones_wild ? 2 : 1), legal_moves: this.ldLegal(st) };
      const count = this.ldCount(st, b.face);
      const stands = count >= b.qty;
      const loser = stands ? me.name : b.by;
      st.log.push({ tick: st.turn, text: me.name + " calls liar on " + b.by + "'s " + this.ldBidText(b) + " - the table shows " + count + ": " + loser + " loses a die." });
      this.ldEndRound(g, { reason: "call", call: { by: me.name, bid: b }, face: b.face, count: count, stands: stands }, loser, false);
    } else {
      const total = this.ldTotal(st);
      if (st.ones_wild && mv.face === 1) return { status: 400, error: "Ones are wild in this match - bid on faces 2 to 6", legal_moves: this.ldLegal(st) };
      if (mv.qty < 1 || mv.qty > total) return { status: 400, error: "A bid counts 1 to " + total + " dice (all the dice on the table)", legal_moves: this.ldLegal(st) };
      const b = st.bid;
      if (b && !(mv.qty > b.qty || (mv.qty === b.qty && mv.face > b.face))) return { status: 400, error: "A raise must beat " + this.ldBidText(b) + ": more dice, or the same count of a higher face", legal_moves: this.ldLegal(st) };
      st.bid = { by: me.name, qty: mv.qty, face: mv.face, at: Date.now() };
      st.bids.push(st.bid);
      st.log.push({ tick: st.turn, text: me.name + " bids " + this.ldBidText(st.bid) + "." });
      this.turnsNext(g);
    }
    this.saveGame(g);
    this.afterGameChange(g, room, me.name);
    await this.armGameAlarm();
    return { status: 200, game: this.ldStateFull(g, who), resolved: !!mv.call };
  },

  // An expired turn costs that player a die and starts a new round; the
  // third in a row puts them out.
  ldAdvance(g: LdGame | null, room: string) {
    if (!g || g.status !== "running" || Date.now() < (g.st.deadline as number)) return; // a running match's clock is set
    const st = g.st;
    const who = st.turn_of as string; // a running match always has a turn
    st.timeouts[who] = (st.timeouts[who] || 0) + 1;
    const gone = st.timeouts[who] >= 3;
    st.log.push({ tick: st.turn, text: gone ? who + "'s turn timed out a third time in a row - " + who + " is out." : who + "'s turn timed out - " + who + " loses a die (" + st.timeouts[who] + " of 3 in a row)." });
    if (gone && !st.forfeit) st.forfeit = who;
    this.ldEndRound(g, { reason: gone ? "forfeit" : "timeout" }, who, gone);
    this.saveGame(g);
    this.afterGameChange(g, room, "Referee");
  },

  ldResultText(g: LdGame) {
    const st = g.st;
    const w = st.winner as string; // a finished match always has one (the last seat with dice)
    const rest = (st.places || []).slice(1);
    const how = st.rounds.filter((r) => r.out).map((r) => r.loser + " (round " + r.n + (r.reason === "forfeit" ? ", timed out" : "") + ")");
    return "Liar's Dice #" + g.id + " is over - " + w + " wins with " + (st.count[w] || 0) + (st.count[w] === 1 ? " die" : " dice") + " left after " + st.rounds.length + " rounds." + (rest.length ? " Out in order: " + how.join(", ") + "." : "");
  },
} satisfies ThisType<Room>;

export const liarsdiceEngine = {
  name: "Liar's Dice",
  turnWord: "turn",
  logTick: (st: LdStored) => st.turn,
  clockSeconds: (st: LdStored) => st.turn_seconds,
  create: (room, creator, players, opts, roomName) => room.createLiarsDice(creator, players, opts, roomName),
  summary: (room, g) => room.ldSummary(g),
  full: (room, g, who) => room.ldStateFull(g, who),
  move: (room, g, who, dir, roomName) => room.ldMove(g, who, dir, roomName),
  advance: (room, g, roomName) => room.ldAdvance(g, roomName),
  targets: (pub: LiarsDiceState) => (pub.status === "running" && pub.turn_of ? [pub.turn_of] : []),
  card: (g: LdGame) => ({ id: g.id, type: "liarsdice", status: g.status, round: g.st.round, turn_of: g.status === "running" ? g.st.turn_of : null, bid: g.st.bid || null, winner: g.st.winner || null, draw: false, players: g.st.players.map((p) => ({ name: p.name, color: p.color, hex: p.hex, dice: (g.st.count || {})[p.name] || 0 })) }),
  stateItem: (r, st: LdStored) => ({ id: r.id, type: "liarsdice", status: r.status, turn: st.turn, players: (st.players || []).map((p) => ({ name: p.name, alive: ((st.count || {})[p.name] || 0) > 0, moved: r.status !== "running" || st.turn_of !== p.name, accepted: seatAccepted(st, p) })) }),
  turnOf: (gm) => Number(gm.turn),
  moveHint: () => "<a bid like 3x4 (at least three 4s on the table), or liar>",
  result: (room, g) => room.ldResultText(g),
  rules: (st: LdStored) =>
    "Liar's Dice: everyone has a cup of dice (" + st.dice_each + " each to start) that only they can see - your own are in you.dice. Turns go round the table (" + st.order.join(", ") + "). " +
    "On your turn, raise the bid or call liar. A bid says at least N dice on the whole table show face F; a raise is more dice, or the same count of a higher face. " +
    (st.ones_wild ? "Ones are wild: a 1 counts as every face, so bids name faces 2 to 6. " : "Ones are not wild: every face counts only itself. ") +
    "Calling liar opens every cup (nothing else does): if the table holds at least the bid, the caller loses a die; if not, the bidder does. The loser opens the next round and everyone rolls again. No dice left and you are out; the last player with dice wins. " +
    "Each turn has " + clockWords(st.turn_seconds || 3600) + "; a turn that runs out costs you a die (a new round starts), and three timeouts in a row put you out. " +
    "Send: dir as a bid, NxF (e.g. 3x4: at least three 4s), or liar; you.legal_moves lists the lowest raise for each face, and liar.",
} satisfies GameEngineOf<LdStored>;
