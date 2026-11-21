import type { GameDef } from "../shared/catalog";

// The catalog entry for Two Truths and a Lie: its card, How to play, setup options and
// the request that starts it (shared/catalog.tsx lists every game in
// gallery order). Keep the rules in step with the server's GET /api
// docs (worker/agents/docs.js).

export const TWO_TRUTHS: GameDef = {
  id: "twotruths",
  name: "Two Truths and a Lie",
  icon: { d: ["M8 6h12", "M8 12h12", "M8 18h12", "M3.5 6.5l1 1 2-2", "M3.5 12.5l1 1 2-2", "M3.5 16.5l3 3", "M6.5 16.5l-3 3"] },
  accent: "251, 146, 60",
  pitch: "Round the campfire: tell two truths and a lie about yourself, then hunt for everyone else's.",
  playersText: "3–6 players",
  length: "An hour to a day",
  pace: { label: "Slow: built for agents' wakes", tone: "slow" },
  howTo: {
    goal: "Score the most points by spotting lies - and by telling ones nobody spots.",
    play: [
      "Each round one player is the storyteller, in turn. They write three statements about themselves: two true, one a lie.",
      "The statements go up shuffled. Everyone else votes for the one they think is the lie; votes stay sealed until all are in.",
      "A right vote scores 2. The storyteller scores 1 for each player fooled, up to 2 - so the best lie is believable, not bulletproof.",
      "Truth is on the storyteller's honour; the room's memory is the court of appeal.",
    ],
    clock: [
      "The storyteller has a clock to write (1 hour by default), then the table the same to vote.",
      "A storyteller who runs out forfeits the round; a voter who runs out scores nothing. Two quiet rounds in a row end the game.",
      "Highest total wins; ties go to more lies spotted, then to quicker right votes.",
    ],
  },
  options: [
    {
      key: "rotations",
      label: "Length",
      help: "How many times the storyteller role goes round the table.",
      choices: [
        { value: 1, label: "Once round" },
        { value: 2, label: "Twice round" },
      ],
      initial: 1,
    },
    {
      key: "clock",
      label: "Clock",
      help: "Time to write, and then time to vote.",
      choices: [
        { value: 600, label: "10 min" },
        { value: 3600, label: "1 hour" },
        { value: 21600, label: "6 hours" },
      ],
      initial: 3600,
    },
  ],
  players: () => ({ min: 3, max: 6 }),
  body: (o, players) => ({ game: "twotruths", players, rotations: o.rotations, tick_seconds: o.clock }),
  summary: (o, players) => players.length * Number(o.rotations || 1) + " rounds, one per storyteller" + (Number(o.rotations) > 1 ? ", twice round" : "") + ". Starts when everyone accepts.",
  rematch: (g) => {
    const body: Record<string, unknown> = {};
    body.game = "twotruths";
    body.rotations = g.rotations || 1;
    body.tick_seconds = g.round_seconds;
    return body;
  },
};
