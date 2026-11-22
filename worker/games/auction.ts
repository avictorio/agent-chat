// Auction: sealed bids on a season of lots.

import AU_LOTS_TXT from "../data/auction-lots.txt";
import { clockWords, seatAccepted } from "./shared.js";
import type { AuctionRound, AuctionState, GameLogLine } from "@chat/contract";
import type { GmRow, Room } from "../room/Room.js";
import type { GameRow } from "../room/games.js";
import type { GameEngine } from "./engine.js";
import type { Body } from "../lib/http.js";

/** A bidder's seat. */
export type AuSeat = { name: string, color: string, hex: string };
/** A bidder's purse: budget left, spent so far, lots won. */
export type AuProg = { budget: number, spent: number, won: number };
/** The auction's stored match state (g.st; the API's AuctionState is built
 *  from it). pending holds the round's sealed bids (0 is a pass) and
 *  pending_at when each came in (roundsCommit in room/games.ts); rounds are
 *  the resolved lots, as the API sends them. */
export type AuSt = {
  type: "auction",
  lots: string[],
  budget: number,
  round_seconds: number,
  round: number,
  deadline: number | null,
  lobby_deadline: number,
  accepted: Record<string, boolean>,
  players: AuSeat[],
  prog: Record<string, AuProg>,
  rounds: AuctionRound[],
  pending: Record<string, number>,
  pending_at: Record<string, number>,
  places: string[] | null,
  log: GameLogLine[],
  winner: string | null,
  draw: boolean,
  announced: boolean,
  declined_by?: string,
  ended?: number,
};
/** An auction: its gm row with the state typed. */
export type AuGame = Omit<GameRow, "st"> & { st: AuSt };

// The auction's lots (content as data, worker/data/auction-lots.txt): one
// per line, # comments; parsed on first use.
export let auLotsCache: string[] | null = null;
export function auLots() {
  if (!auLotsCache) auLotsCache = String(AU_LOTS_TXT).split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  return auLotsCache;
}

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
  auActive(st: AuSt) {
    return st.players.filter((p) => st.prog[p.name].budget > 0);
  },

  auSummary(g: AuGame): AuctionState {
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

  /** @param who the viewer */
  auStateFull(g: AuGame, who: string | null | undefined): AuctionState {
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

  /** @param opts the create's options (lots, budget, tick_seconds, lobby_seconds) */
  async createAuction(creator: string, playersIn: unknown[], opts: Body, room: string) {
    if (!Array.isArray(playersIn) || playersIn.length < 2 || playersIn.length > 6) return { status: 400, error: "An auction needs 2 to 6 players" };
    const resolved = this.gamePlayers(playersIn);
    if (resolved.error) return resolved;
    const names = resolved.names as string[]; // gamePlayers sets names whenever it sets no error
    const clamp = (v: unknown, lo: number, hi: number, def: number) => { const n = Math.floor(Number(v)); return Number.isFinite(n) && n > 0 ? Math.min(hi, Math.max(lo, n)) : def; };
    const pool = auLots();
    const nLots = clamp(opts.lots, 3, Math.min(20, pool.length), 10);
    const budget = clamp(opts.budget, 10, 1000, 100);
    const roundSeconds = clamp(opts.tick_seconds, 30, 86400, 180);
    const deck = pool.slice();
    for (let i = deck.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); const t = deck[i]; deck[i] = deck[j]; deck[j] = t; }
    const colors = this.gameColors();
    const players = names.map((n, i) => ({ name: n, color: colors[i].color, hex: colors[i].hex }));
    const prog: Record<string, AuProg> = {};
    for (const n of names) prog[n] = { budget: budget, spent: 0, won: 0 };
    const st: AuSt = {
      type: "auction", lots: deck.slice(0, nLots), budget: budget, round_seconds: roundSeconds, round: 1,
      deadline: null, lobby_deadline: Date.now() + this.lobbySeconds(opts) * 1000, accepted: this.lobbyAccepted(creator, names), players: players, prog: prog,
      rounds: [], pending: {}, pending_at: {}, places: null,
      log: [{ tick: 0, text: "Auction created by " + creator + " - " + names.join(", ") + ", " + nLots + " lots, " + budget + " each to spend. The clock starts when everyone accepts." }],
      winner: null, draw: false, announced: false,
    };
    const ins = this.sql.exec<Pick<GmRow, "id">>("INSERT INTO gm (status, created, created_by, state) VALUES ('lobby', ?, ?, ?) RETURNING id", Date.now(), creator, JSON.stringify(st)).one();
    const g = this.gameRow(ins.id) as GameRow; // the row just inserted
    const label = players.map((p) => p.name + " (" + p.color + ")").join(", ");
    const cardText = "Auction #" + g.id + " - " + label + ". " + nLots + " lots, one sealed bid each per lot; the highest bid wins it and pays. Everyone starts with " + budget + ". Most lots wins. Round clock: " + clockWords(roundSeconds) + ". Lobby open - the auction starts when everyone accepts; tap the card to take your seat.";
    const msg = await this.postGameCard(creator, cardText, g.id, room);
    this.sql.exec("UPDATE gm SET card_msg = ? WHERE id = ?", msg.id, g.id);
    g.card_msg = msg.id;
    this.broadcastGame(g, room, creator);
    await this.armGameAlarm();
    return { status: 201, game: this.auStateFull(g, creator) };
  },

  /** @param raw the bid, as sent */
  async auMove(g: AuGame, who: string, raw: unknown, room: string) {
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

  auResolveRound(g: AuGame) {
    const st = g.st;
    const n = st.round;
    const at = Date.now();
    const lot = st.lots[n - 1];
    const entry: AuctionRound = { n: n, at: at, lot: lot, bids: {}, winner: null, price: 0, tie: null, missed: [] };
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
          const at2 = (nm: string) => (st.pending_at || {})[nm] || Infinity;
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

  auStanding(st: AuSt) {
    st.places = st.players.map((p) => p.name).sort((a, b) => st.prog[b].won - st.prog[a].won || st.prog[b].budget - st.prog[a].budget || (a < b ? -1 : 1));
    const [x, y] = st.places;
    const tied = !!y && st.prog[x].won === st.prog[y].won && st.prog[x].budget === st.prog[y].budget;
    st.draw = tied;
    return tied ? null : x;
  },

  auResultText(g: AuGame) {
    const st = g.st;
    if (!st.places) this.auStanding(st);
    // auStanding has just set places if they were unset
    const lines = (st.places as string[]).map((nm) => nm + " " + st.prog[nm].won + (st.prog[nm].won === 1 ? " lot" : " lots") + " (" + st.prog[nm].budget + " left)").join(", ");
    const sold = st.rounds.filter((r) => r.winner);
    const top = sold.slice().sort((a, b) => b.price - a.price)[0];
    return "Auction #" + g.id + " is over - " + (st.winner ? st.winner + " takes the season with " + st.prog[st.winner].won + " lots." : "a tie at the top, no winner.") + " " + lines + "." + (top ? " Top price: \"" + top.lot + "\" went to " + top.winner + " for " + top.price + "." : "");
  },
} satisfies ThisType<Room>;

export const auctionEngine = {
  name: "Auction",
  turnWord: "lot",
  logTick: (st: AuSt) => st.round,
  clockSeconds: (st: AuSt) => st.round_seconds,
  create: (room, creator, players, opts, roomName) => room.createAuction(creator, players, opts, roomName),
  summary: (room, g) => room.auSummary(g),
  full: (room, g, who) => room.auStateFull(g, who),
  move: (room, g, who, dir, roomName) => room.auMove(g, who, dir, roomName),
  advance: (room, g, roomName) => room.roundsAdvance(g, roomName),
  resolveRound: (room, g) => room.auResolveRound(g),
  standing: (room, st: AuSt) => room.auStanding(st),
  active: (room, st: AuSt) => room.auActive(st),
  targets: (pub: AuctionState) => pub.players.filter((p) => !p.committed && p.budget > 0).map((p) => p.name),
  card: (g: AuGame) => ({ id: g.id, type: "auction", status: g.status, round: g.st.round, lots_total: g.st.lots.length, lot: g.status === "running" ? g.st.lots[g.st.round - 1] : null, winner: g.st.winner || null, draw: !!g.st.draw, players: g.st.players.map((p) => { const pr = (g.st.prog || {})[p.name] || {}; return { name: p.name, color: p.color, hex: p.hex, budget: pr.budget, won: pr.won || 0 }; }) }),
  stateItem: (r, st: AuSt) => ({ id: r.id, type: "auction", status: r.status, round: st.round, players: (st.players || []).map((p) => { const pr = (st.prog || {})[p.name] || {}; return { name: p.name, alive: (pr.budget || 0) > 0, moved: (st.pending || {})[p.name] !== undefined || (pr.budget || 0) <= 0, accepted: seatAccepted(st, p) }; }) }),
  turnOf: (gm) => gm.round,
  moveHint: () => "<a whole number from 0 to your budget left, or pass>",
  result: (room, g) => room.auResultText(g),
  rules: (st: AuSt) =>
    "Sealed-bid auction: " + st.lots.length + " lots, one per round, every lot worth the same one point (the names are flavour). Everyone starts with " + st.budget + " to spend, and budgets are public. " +
    "Each round everyone sends one sealed bid, a whole number from 0 up to what they have left, or pass; the highest bid wins the lot and pays it, losing bids cost nothing. A tie at the top goes to whoever has spent less so far, then to the earlier bid; a lot nobody bids on goes unsold. " +
    "Most lots wins; budget left breaks a tie. A round resolves when everyone with budget left has bid, or at the " + clockWords(st.round_seconds || 180) + " deadline - a missed round is a pass. Send dir as the number (e.g. 15) or pass; you can change it until the round resolves.",
} satisfies GameEngine;
