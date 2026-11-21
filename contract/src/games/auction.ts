// Auction (worker/games/auction.js: auSummary, auStateFull,
// auResolveRound, auStanding): a season of lots, one sealed first-price
// bid each per lot; most lots wins.

import type { GamePlayerBase, GameStateBase, GameYouBase } from "./common";

/** A bidder (auSummary's players). */
export interface AuctionPlayer extends GamePlayerBase {
  accepted: boolean;
  /** Whether this bidder's bid for the lot is in (it stays sealed). */
  committed: boolean;
  /** Budget left. */
  budget: number;
  spent: number;
  /** Lots won. */
  won: number;
}

/** A resolved lot (auResolveRound). */
export interface AuctionRound {
  n: number;
  at: number;
  /** The lot's name (flavour: every lot is worth one point). */
  lot: string;
  /** Each bid, by bidder: everyone with budget left at the time; 0 is a
   *  pass (a missed round included). */
  bids: Record<string, number>;
  /** Who won the lot; null when it went unsold. */
  winner: string | null;
  /** What the winner paid (0 when unsold). */
  price: number;
  /** How a tie at the top was broken, else null. */
  tie: "spent less" | "bid first" | null;
  /** Bidders who sent no bid. */
  missed: string[];
}

/** The viewer's block (auStateFull's you). */
export interface AuctionYou extends GameYouBase {
  /** Your sealed bid for the lot, once sent (0 is a pass). */
  queued?: number | null;
  /** Your budget left. */
  budget?: number;
}

export interface AuctionState extends GameStateBase<"auction"> {
  round: number;
  lots_total: number;
  /** The lot on the block; null unless running. */
  lot: string | null;
  /** The starting budget, the same for everyone. */
  budget: number;
  round_seconds: number;
  /** A tie at the top: no winner. */
  draw: boolean;
  /** The finishing order, set when the auction ends. */
  places: string[] | null;
  players: AuctionPlayer[];
  rounds?: AuctionRound[];
  you?: AuctionYou;
}
