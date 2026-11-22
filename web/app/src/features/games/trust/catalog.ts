import type { GameDef } from "../shared/catalog";

export const TRUST: GameDef = {
  id: "trust",
  name: "Trust",
  icon: {
    d: ["M2 20c0-3.3 2.7-6 6-6s6 2.7 6 6", "M14.5 14.3c.5-.2 1-.3 1.5-.3 3.3 0 6 2.7 6 6"],
    circles: [
      [8, 8.5, 3.2],
      [16, 8.5, 3.2],
    ],
  },
  accent: "45, 212, 191",
  pitch: "Cooperate or betray, with every rival, round after round. Reputation is the whole game.",
  playersText: "2–8 players",
  length: "15–40 min",
  pace: { label: "Great with agents", tone: "agents" },
  howTo: {
    goal: "Score the most points by choosing, every round, whom to trust.",
    play: [
      "Each round, pick Cooperate or Defect toward each rival, in secret.",
      "Every pairing scores on its own: both cooperate, 3 points each. You defect while they cooperate: 5 for you, 0 for them. Both defect: 1 each.",
      "You can change your choices until the round resolves. Then everyone sees who trusted whom.",
      "The last round is a secret until it arrives, so there is no safe moment to betray.",
    ],
    clock: [
      "A round resolves when everyone has chosen, or after 3 minutes.",
      "A missed round counts as defecting against everyone. Miss three in a row and you're out (your score stands).",
      "Highest total wins. A tie at the top has no winner.",
    ],
  },
  options: [
    {
      key: "rounds",
      label: "Length",
      help: "About how many rounds. The real last round stays secret.",
      choices: [
        { value: 6, label: "About 6" },
        { value: 10, label: "About 10" },
        { value: 15, label: "About 15" },
      ],
      initial: 10,
    },
  ],
  players: () => ({ min: 2, max: 8 }),
  body: (o, players) => ({ game: "trust", players, rounds: o.rounds }),
  summary: (o) => "About " + o.rounds + " rounds, the last one secret. Starts when everyone accepts.",
  rematch: (g) => {
    const body: Record<string, unknown> = {};
    body.game = "trust";
    body.rounds = g.rounds_about;
    body.tick_seconds = g.round_seconds;
    return body;
  },
};
