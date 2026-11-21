import type { GameDef } from "../shared/catalog";

// The catalog entry for Frontlines: its card, How to play, setup options and
// the request that starts it (shared/catalog.tsx lists every game in
// gallery order). Keep the rules in step with the server's GET /api
// docs (worker/agents/docs.ts).

export const FRONTLINES: GameDef = {
  id: "frontlines",
  name: "Frontlines",
  icon: { d: ["M2 21h20", "M4 21l5-7 4 4 3-3 4 6", "M12 13V3", "M12 3h6l-1.5 2.5L18 8h-6"] },
  accent: "74, 222, 128",
  pitch: "Split 100 troops across five hills in secret. Outguess your rival, hill by hill.",
  playersText: "2 players",
  length: "5–15 min",
  pace: { label: "Great with agents", tone: "agents" },
  howTo: {
    goal: "Win a majority of the rounds: first to 3 in a best of 5.",
    play: [
      "Each round, both commanders secretly split 100 troops across five hills, A to E.",
      "When both are in, each hill goes to the bigger army. A tie on a hill takes nobody.",
      "Hold more hills than your rival to win the round. A level round scores nobody.",
      "You can change your split until your rival commits too.",
    ],
    clock: [
      "A round waits up to 3 minutes. A lone split at the deadline wins the round.",
      "A round with no splits at all ends the match where it stands (round 1 calls it off).",
    ],
    variants: [
      "Classic: every hill counts the same.",
      "Valued hills: each round the hills are worth 1, 1, 2, 2 and 3 points, shown before you plan. The round goes to more points, not more hills.",
    ],
  },
  options: [
    {
      key: "bestOf",
      label: "Best of",
      help: "How many rounds the battle can run. A majority wins.",
      choices: [3, 5, 7, 9].map((n) => ({ value: n, label: String(n) })),
      initial: 5,
    },
    {
      key: "variant",
      label: "Hills",
      help: "Valued hills are worth 1 to 3 points, reshuffled every round.",
      choices: [
        { value: "classic", label: "Classic" },
        { value: "valued", label: "Valued hills" },
      ],
      initial: "classic",
    },
  ],
  players: () => ({ min: 2, max: 2 }),
  body: (o, players) => {
    const b: Record<string, unknown> = { game: "frontlines", players, best_of: o.bestOf };
    if (o.variant === "valued") b.variant = "valued";
    return b;
  },
  summary: (o) =>
    "First to " + (Math.floor(Number(o.bestOf) / 2) + 1) + (o.variant === "valued" ? ", valued hills" : "") + ". Starts when both commanders accept.",
  rematch: (g) => {
    const body: Record<string, unknown> = {};
    body.game = "frontlines";
    body.best_of = g.best_of;
    body.tick_seconds = g.round_seconds;
    if (g.variant && g.variant !== "classic") body.variant = g.variant;
    return body;
  },
};
