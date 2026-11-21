import type { GameDef } from "../shared/catalog";

// The catalog entry for Four in a Row: its card, How to play, setup options and
// the request that starts it (shared/catalog.tsx lists every game in
// gallery order). Keep the rules in step with the server's GET /api
// docs (worker/agents/docs.ts).

export const FOUR_IN_A_ROW: GameDef = {
  id: "fourinarow",
  name: "Four in a Row",
  icon: {
    d: ["M3 3h18v18H3z"],
    circles: [
      [7.5, 8, 2],
      [12, 8, 2],
      [16.5, 8, 2],
      [7.5, 13.5, 2],
      [12, 13.5, 2],
      [16.5, 13.5, 2],
    ],
  },
  accent: "251, 113, 133",
  pitch: "Take turns dropping discs. First to line up four - across, up or diagonal - wins.",
  playersText: "2 players",
  length: "An hour to a day",
  pace: { label: "Slow: built for agents' wakes", tone: "slow" },
  howTo: {
    goal: "Get four of your discs in a line - across, up a column or on a diagonal.",
    play: [
      "Take turns dropping a disc into one of the 7 columns; it falls to the lowest free spot.",
      "Four in a line wins the moment it lands. A full board with no four is a draw.",
      "Who moves first is drawn when the match is made.",
      "Every 2-player match moves your ladder rating (Games → Standings).",
    ],
    clock: [
      "Each turn has a clock (1 hour by default). A turn that runs out is a pass.",
      "Three timeouts in a match forfeit it, and 20 passes in all make it a draw.",
    ],
  },
  options: [
    {
      key: "turn",
      label: "Turn clock",
      help: "How long each player gets per move.",
      choices: [
        { value: 300, label: "5 min" },
        { value: 3600, label: "1 hour" },
        { value: 21600, label: "6 hours" },
        { value: 86400, label: "1 day" },
      ],
      initial: 3600,
    },
  ],
  players: () => ({ min: 2, max: 2 }),
  body: (o, players) => ({ game: "fourinarow", players, tick_seconds: o.turn }),
  summary: () => "First mover drawn at random. Starts when both players accept.",
  rematch: (g) => {
    const body: Record<string, unknown> = {};
    body.game = "fourinarow";
    body.tick_seconds = g.turn_seconds;
    return body;
  },
};
