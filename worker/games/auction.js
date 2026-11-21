// Auction: sealed bids on a season of lots.

import AU_LOTS_TXT from "../data/auction-lots.txt";
import { clockWords, seatAccepted } from "./shared.js";
/** @typedef {import("../room/games.js").GameRow} GameRow */

// The auction's lots (content as data, worker/data/auction-lots.txt): one
// per line, # comments; parsed on first use.
/** @type {string[] | null} */
export let auLotsCache = null;
export function auLots() {
  if (!auLotsCache) auLotsCache = String(AU_LOTS_TXT).split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  return auLotsCache;
}

/** @satisfies {ThisType<import("../room/Room.js").Room>} */
export const AuctionMethods = {
  /* ---------- games: Sealed-bid auction (2026-11-19) ----------
     Ada's spec: a season of lots (worker/data/auction-lots.txt, flavour only -
     every lot is worth one point). Each player starts with the same public
     budget. One lot per round: everyone sends one sealed bid, 0 up to
     what they have left, or pass; the highest bid wins the lot and pays it
     (first price), losing bids cost nothing. A tie at the top goes to the
     tied bidder who has spent less so far, then to the earlier bid. A lot
     nobody bids on goes unsold. A missed round is a pass. Most lots wins;
     budget left breaks a tie; still tied, no winner (a draw for two).
     Rides the simultaneous-rounds machinery, waiting only on bidders with
     budget left. */
  auActive(st) {
    return st.players.filter((p) => st.prog[p.name].budget > 0);
  },

  /** @returns {import("@chat/contract").AuctionState} */
  auSummary(g) {
    const st = g.st;
    const lotNow = g.status === "running" ? st.lots[st.round - 1] || null : null;
    return {
      id: g.id, type: "auction", status: g.status, created_by: g.created_by, card_msg: g.card_msg,
      round: st.round, lots_total: st.lots.length, lot: lotNow, budget: st.budget, round_seconds: st.round_seconds, deadline: st.deadline, lobby_deadline: g.status === "lobby" ? (st.lobby_deadline || null) : null,
      winner: st.winner || null, draw: !!st.draw, places: st.places || null, declined_by: st.declined_by || null,
      players: st.players.map((p) => {
        const pr = st.prog[p.name] || {};
        return { name: p.name, color: p.color, hex: p.hex, accepted: st.accepted ? !!st.accepted[p.name] : true, committed: st.pending[p.name] !== undefined, budget: pr.budget, spent: pr.spent || 0, won: pr.won || 0 };
      }),
    };
  },

  /** @returns {import("@chat/contract").AuctionState} */
  auStateFull(g, who) {
    const out = this.auSummary(g);
    const st = g.st;
    out.rounds = st.rounds;
    out.log = st.log.slice(-24);
    const active = g.status === "running" ? this.auActive(st) : [];
    out.awaiting = active.filter((p) => st.pending[p.name] === undefined).map((p) => p.name);
    out.awaiting_accept = g.status === "lobby" ? st.players.filter((p) => !(st.accepted || {})[p.name]).map((p) => p.name) : [];
    const me = st.players.find((p) => p.name.toLowerCase() === String(who || "").toLowerCase());
    if (me) {
      const pr = st.prog[me.name];
      const bidding = g.status === "running" && pr.budget > 0;
      const q = st.pending[me.name];
      out.you = {
        playing: true, accepted: st.accepted ? !!st.accepted[me.name] : true, queued: q === undefined ? null : q, budget: pr.budget,
        legal_moves: bidding ? ["a whole number from 0 to " + pr.budget, "pass"] : [],
      };
    } else out.you = { playing: false };
    return out;
  },

  async createAuction(creator, playersIn, opts, room) {
    if (!Array.isArray(playersIn) || playersIn.length < 2 || playersIn.length > 6) return { status: 400, error: "An auction needs 2 to 6 players" };
    const resolved = this.gamePlayers(playersIn);
    if (resolved.error) return resolved;
    const names = /** @type {string[]} */ (resolved.names); // gamePlayers sets names whenever it sets no error
    const clamp = (v, lo, hi, def) => { const n = Math.floor(Number(v)); return Number.isFinite(n) && n > 0 ? Math.min(hi, Math.max(lo, n)) : def; };
    const pool = auLots();
    const nLots = clamp(opts.lots, 3, Math.min(20, pool.length), 10);
    const budget = clamp(opts.budget, 10, 1000, 100);
    const roundSeconds = clamp(opts.tick_seconds, 30, 86400, 180);
    const deck = pool.slice();
    for (let i = deck.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); const t = deck[i]; deck[i] = deck[j]; deck[j] = t; }
    const colors = this.gameColors();
    const players = names.map((n, i) => ({ name: n, color: colors[i].color, hex: colors[i].hex }));
    const prog = {};
    for (const n of names) prog[n] = { budget: budget, spent: 0, won: 0 };
    const st = {
      type: "auction", lots: deck.slice(0, nLots), budget: budget, round_seconds: roundSeconds, round: 1,
      deadline: null, lobby_deadline: Date.now() + this.lobbySeconds(opts) * 1000, accepted: this.lobbyAccepted(creator, names), players: players, prog: prog,
      rounds: [], pending: {}, pending_at: {}, places: null,
      log: [{ tick: 0, text: "Auction created by " + creator + " - " + names.join(", ") + ", " + nLots + " lots, " + budget + " each to spend. The clock starts when everyone accepts." }],
      winner: null, draw: false, announced: false,
    };
    const ins = this.sql.exec("INSERT INTO gm (status, created, created_by, state) VALUES ('lobby', ?, ?, ?) RETURNING id", Date.now(), creator, JSON.stringify(st)).one();
    const g = /** @type {GameRow} */ (this.gameRow(ins.id)); // the row just inserted
    const label = players.map((p) => p.name + " (" + p.color + ")").join(", ");
    const cardText = "Auction #" + g.id + " - " + label + ". " + nLots + " lots, one sealed bid each per lot; the highest bid wins it and pays. Everyone starts with " + budget + ". Most lots wins. Round clock: " + clockWords(roundSeconds) + ". Lobby open - the auction starts when everyone accepts; tap the card to take your seat.";
    const msg = await this.postGameCard(creator, cardText, g.id, room);
    this.sql.exec("UPDATE gm SET card_msg = ? WHERE id = ?", msg.id, g.id);
    g.card_msg = msg.id;
    this.broadcastGame(g, room, creator);
    await this.armGameAlarm();
    return { status: 201, game: this.auStateFull(g, creator) };
  },

  async auMove(g, who, raw, room) {
    const st = g.st;
    const me = st.players.find((p) => p.name.toLowerCase() === String(who || "").toLowerCase());
    if (!me) return { status: 403, error: "You are not a player in this auction" };
    const pr = st.prog[me.name];
    if (pr.budget <= 0) return { status: 400, error: "You have no budget left - you sit the rest of the auction out" };
    const s = String(raw || "").trim().toLowerCase().replace(/^(bid)\s*:?\s*/, "");
    let bid;
    if (s === "pass" || s === "0") bid = 0;
    else if (/^\d+$/.test(s)) bid = Number(s);
    else return { status: 400, error: "a bid is a whole number from 0 to " + pr.budget + ", or pass", legal_moves: ["0", String(pr.budget), "pass"] };
    if (bid > pr.budget) return { status: 400, error: "you have " + pr.budget + " left - you bid " + bid, legal_moves: ["0", String(pr.budget), "pass"] };
    const resolved = this.roundsCommit(g, who, bid, room);
    await this.armGameAlarm();
    return { status: 200, game: this.auStateFull(g, who), resolved: resolved };
  },

  auResolveRound(g) {
    const st = g.st;
    const n = st.round;
    const at = Date.now();
    const lot = st.lots[n - 1];
    /** @type {import("@chat/contract").AuctionRound} */
    const entry = { n: n, at: at, lot: lot, bids: {}, winner: null, price: 0, tie: null, missed: [] };
    for (const p of st.players) {
      const pr = st.prog[p.name];
      if (pr.budget <= 0) continue;
      const b = st.pending[p.name];
      if (b === undefined) { entry.missed.push(p.name); entry.bids[p.name] = 0; }
      else entry.bids[p.name] = b;
    }
    const names = Object.keys(entry.bids).filter((nm) => entry.bids[nm] > 0);
    if (names.length) {
      const top = Math.max(...names.map((nm) => entry.bids[nm]));
      let tied = names.filter((nm) => entry.bids[nm] === top);
      if (tied.length > 1) {
        const minSpent = Math.min(...tied.map((nm) => st.prog[nm].spent));
        const fewer = tied.filter((nm) => st.prog[nm].spent === minSpent);
        if (fewer.length < tied.length) entry.tie = "spent less";
        tied = fewer;
        if (tied.length > 1) {
          const at2 = (nm) => (st.pending_at || {})[nm] || Infinity;
          tied.sort((a, b) => at2(a) - at2(b));
          entry.tie = "bid first";
        }
      }
      const w = tied[0];
      entry.winner = w;
      entry.price = top;
      st.prog[w].budget -= top;
      st.prog[w].spent += top;
      st.prog[w].won += 1;
    }
    st.rounds.push(entry);
    st.log.push({ tick: n, text: "Lot " + n + " (" + lot + "): " + (entry.winner ? entry.winner + " wins it for " + entry.price + (entry.tie ? " (a tie at the top - " + entry.tie + ")" : "") + "." : "unsold - nobody bid.") });
    st.pending = {};
    st.pending_at = {};
    if (n >= st.lots.length || !this.auActive(st).length) {
      g.status = "finished";
      st.winner = this.auStanding(st);
      st.log.push({ tick: n, text: "The auction is over. " + (st.winner ? st.winner + " takes the season." : "A tie - no winner.") });
    } else {
      st.round += 1;
      st.deadline = at + st.round_seconds * 1000;
    }
  },

  auStanding(st) {
    st.places = st.players.map((p) => p.name).sort((a, b) => st.prog[b].won - st.prog[a].won || st.prog[b].budget - st.prog[a].budget || (a < b ? -1 : 1));
    const [x, y] = st.places;
    const tied = !!y && st.prog[x].won === st.prog[y].won && st.prog[x].budget === st.prog[y].budget;
    st.draw = tied;
    return tied ? null : x;
  },

  auResultText(g) {
    const st = g.st;
    if (!st.places) this.auStanding(st);
    const lines = st.places.map((nm) => nm + " " + st.prog[nm].won + (st.prog[nm].won === 1 ? " lot" : " lots") + " (" + st.prog[nm].budget + " left)").join(", ");
    const sold = st.rounds.filter((r) => r.winner);
    const top = sold.slice().sort((a, b) => b.price - a.price)[0];
    return "Auction #" + g.id + " is over - " + (st.winner ? st.winner + " takes the season with " + st.prog[st.winner].won + " lots." : "a tie at the top, no winner.") + " " + lines + "." + (top ? " Top price: \"" + top.lot + "\" went to " + top.winner + " for " + top.price + "." : "");
  },
};

export const auctionEngine = {
  name: "Auction",
  turnWord: "lot",
  logTick: (st) => st.round,
  clockSeconds: (st) => st.round_seconds,
  create: (room, creator, players, opts, roomName) => room.createAuction(creator, players, opts, roomName),
  summary: (room, g) => room.auSummary(g),
  full: (room, g, who) => room.auStateFull(g, who),
  move: (room, g, who, dir, roomName) => room.auMove(g, who, dir, roomName),
  advance: (room, g, roomName) => room.roundsAdvance(g, roomName),
  resolveRound: (room, g) => room.auResolveRound(g),
  standing: (room, st) => room.auStanding(st),
  active: (room, st) => room.auActive(st),
  targets: (pub) => pub.players.filter((p) => !p.committed && p.budget > 0).map((p) => p.name),
  card: (g) => ({ id: g.id, type: "auction", status: g.status, round: g.st.round, lots_total: g.st.lots.length, lot: g.status === "running" ? g.st.lots[g.st.round - 1] : null, winner: g.st.winner || null, draw: !!g.st.draw, players: g.st.players.map((p) => { const pr = (g.st.prog || {})[p.name] || {}; return { name: p.name, color: p.color, hex: p.hex, budget: pr.budget, won: pr.won || 0 }; }) }),
  stateItem: (r, st) => ({ id: r.id, type: "auction", status: r.status, round: st.round, players: (st.players || []).map((p) => { const pr = (st.prog || {})[p.name] || {}; return { name: p.name, alive: (pr.budget || 0) > 0, moved: (st.pending || {})[p.name] !== undefined || (pr.budget || 0) <= 0, accepted: seatAccepted(st, p) }; }) }),
  turnOf: (gm) => gm.round,
  moveHint: () => "<a whole number from 0 to your budget left, or pass>",
  result: (room, g) => room.auResultText(g),
  rules: (st) =>
    "Sealed-bid auction: " + st.lots.length + " lots, one per round, every lot worth the same one point (the names are flavour). Everyone starts with " + st.budget + " to spend, and budgets are public. " +
    "Each round everyone sends one sealed bid, a whole number from 0 up to what they have left, or pass; the highest bid wins the lot and pays it, losing bids cost nothing. A tie at the top goes to whoever has spent less so far, then to the earlier bid; a lot nobody bids on goes unsold. " +
    "Most lots wins; budget left breaks a tie. A round resolves when everyone with budget left has bid, or at the " + clockWords(st.round_seconds || 180) + " deadline - a missed round is a pass. Send dir as the number (e.g. 15) or pass; you can change it until the round resolves.",
};
