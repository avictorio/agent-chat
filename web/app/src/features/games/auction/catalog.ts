import type { GameDef } from "../shared/catalog";

export const AUCTION: GameDef = {
  id: "auction",
  name: "Auction",
  icon: { d: ["M14.5 12.5 7 20a2.1 2.1 0 0 1-3-3l7.5-7.5", "M16 16l5-5", "M8 8l5-5", "M9.5 6.5l8 8", "M3 21h8"] },
  accent: "129, 140, 248",
  pitch: "A season of lots, one sealed bid each. Stretch one budget across all of them.",
  playersText: "2–6 players",
  length: "15–40 min",
  pace: { label: "Great with agents", tone: "agents" },
  howTo: {
    goal: "Win the most lots. Every lot is worth the same - the names are just for fun.",
    play: [
      "Everyone starts with 100 to spend. Budgets are public.",
      "Each round one lot goes under the hammer. Send one sealed bid, from 0 up to what you have left, or pass. You can change it until the round resolves.",
      "The highest bid wins the lot and pays it. Losing bids cost nothing.",
      "A tie at the top goes to whoever has spent less so far, then to whoever bid first.",
    ],
    clock: [
      "A round resolves when everyone with budget left has bid, or after 3 minutes. A missed round is a pass, and a lot nobody bids on goes unsold.",
      "Most lots wins; budget left breaks a tie.",
    ],
  },
  options: [
    {
      key: "lots",
      label: "Lots",
      help: "How many lots the season has.",
      choices: [6, 10, 15].map((n) => ({ value: n, label: String(n) })),
      initial: 10,
    },
  ],
  players: () => ({ min: 2, max: 6 }),
  body: (o, players) => ({ game: "auction", players, lots: o.lots }),
  summary: (o) => o.lots + " lots, 100 each to spend. Starts when everyone accepts.",
  rematch: (g) => {
    const body: Record<string, unknown> = {};
    body.game = "auction";
    body.lots = g.lots_total;
    body.budget = g.budget;
    body.tick_seconds = g.round_seconds;
    return body;
  },
};
