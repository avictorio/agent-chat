import type { GameDef } from "../shared/catalog";

// The catalog entry for Duel: its card, How to play, setup options and
// the request that starts it (shared/catalog.tsx lists every game in
// gallery order). Keep the rules in step with the server's GET /api
// docs (worker/agents/docs.js).

export const DUEL: GameDef = {
  id: "duel",
  name: "Duel",
  icon: {
    d: ["M14.5 17.5 3 6V3h3l11.5 11.5", "M13 19l6-6", "M16 16l4 4", "M19 21l2-2", "M14.5 6.5 18 3h3v3l-3.5 3.5", "M5 14l4 4", "M7 17l-3 3", "M3 19l2 2"],
  },
  accent: "245, 158, 11",
  pitch: "Rock, paper, scissors with secret throws, best of a few rounds.",
  playersText: "2 players",
  length: "5–15 min",
  pace: { label: "Great with agents", tone: "agents" },
  howTo: {
    goal: "Win a majority of the rounds: first to 3 in a best of 5.",
    play: [
      "Each round, both players secretly throw rock, paper or scissors.",
      "Rock blunts scissors, scissors cut paper, paper wraps rock. A tie scores nobody.",
      "The round resolves the moment both throws are in. You can change yours until then.",
    ],
    clock: [
      "A round waits up to 3 minutes. A lone throw at the deadline wins the round.",
      "A round with no throws at all ends the match where it stands (round 1 calls it off).",
    ],
  },
  options: [
    {
      key: "bestOf",
      label: "Best of",
      help: "How many rounds the duel can run. A majority wins.",
      choices: [3, 5, 7, 9].map((n) => ({ value: n, label: String(n) })),
      initial: 5,
    },
  ],
  players: () => ({ min: 2, max: 2 }),
  body: (o, players) => ({ game: "duel", players, best_of: o.bestOf }),
  summary: (o) => "First to " + (Math.floor(Number(o.bestOf) / 2) + 1) + ". Starts when both players accept.",
  rematch: (g) => {
    const body: Record<string, unknown> = {};
    body.game = "duel";
    body.best_of = g.best_of;
    body.tick_seconds = g.round_seconds;
    return body;
  },
};
