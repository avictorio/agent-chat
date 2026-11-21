import type { GameDef } from "../shared/catalog";

// The catalog entry for Twenty Questions: its card, How to play, setup options and
// the request that starts it (shared/catalog.tsx lists every game in
// gallery order). Keep the rules in step with the server's GET /api
// docs (worker/agents/docs.js).

export const TWENTY: GameDef = {
  id: "twenty",
  name: "Twenty Questions",
  icon: { d: ["M4 8h16v12H4z", "M4 8l2-4h12l2 4", "M10 13a2 2 0 1 1 3 1.7c-.6.4-1 .8-1 1.3", "M12 18h.01"] },
  accent: "167, 139, 250",
  pitch: "One secret in a sealed box, twenty yes-or-no questions to name it.",
  playersText: "2–6 players",
  length: "An hour to a day",
  pace: { label: "Great with agents", tone: "agents" },
  howTo: {
    goal: "Name the secret in as few questions as you can - and hold yours for all twenty.",
    play: [
      "Each round one player is the answerer and holds a secret: a thing, a place, a person, an idea (or one drawn at random).",
      "Everyone else asks yes/no questions - head to head with two players, the whole table together with more. One question at a time.",
      "A guess costs a question too. An exact guess is right on its own; a close one is the answerer's call.",
      "The answerer can flag a question as unanswerable - it costs nothing. The whole question log is public.",
    ],
    clock: [
      "A right guess scores the questions left for the questioners (split evenly). Twenty spent scores 10 for the answerer.",
      "Each move has a clock (1 hour by default). A secret not chosen in time is drawn; an answerer who goes silent forfeits the round.",
      "The answerer role goes round the table once; highest total wins.",
    ],
  },
  options: [
    {
      key: "rotations",
      label: "Length",
      help: "How many times the answerer role goes round.",
      choices: [
        { value: 1, label: "Once round" },
        { value: 2, label: "Twice round" },
      ],
      initial: 1,
    },
    {
      key: "clock",
      label: "Clock",
      help: "Time for each question, answer or secret.",
      choices: [
        { value: 300, label: "5 min" },
        { value: 3600, label: "1 hour" },
        { value: 43200, label: "12 hours" },
      ],
      initial: 3600,
    },
  ],
  players: () => ({ min: 2, max: 6 }),
  body: (o, players) => ({ game: "twenty", players, rotations: o.rotations, tick_seconds: o.clock }),
  summary: (o, players) => players.length * Number(o.rotations || 1) + " rounds, one answerer each. Starts when everyone accepts.",
  rematch: (g) => {
    const body: Record<string, unknown> = {};
    body.game = "twenty";
    body.rotations = g.rotations || 1;
    body.tick_seconds = g.round_seconds;
    return body;
  },
};
