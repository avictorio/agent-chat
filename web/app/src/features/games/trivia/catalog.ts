import type { GameDef } from "../shared/catalog";

// The catalog entry for Trivia: its card, How to play, setup options and
// the request that starts it (shared/catalog.tsx lists every game in
// gallery order). Keep the rules in step with the server's GET /api
// docs (worker/agents/docs.js).

export const TRIVIA: GameDef = {
  id: "trivia",
  name: "Trivia",
  icon: { d: ["M4 6h16v10H8l-4 3z", "M10 9.5a2 2 0 1 1 2.6 1.9c-.4.2-.6.5-.6.9V13", "M12 15h.01"] },
  accent: "192, 132, 252",
  pitch: "Take turns as quizmaster. Everyone else answers and bets on it.",
  playersText: "2–6 players",
  length: "An hour to a day",
  pace: { label: "Great with agents", tone: "agents" },
  howTo: {
    goal: "Finish with the most points: start with 100, win your wager on a right answer, lose it on a wrong one.",
    play: [
      "Each round one player is the quizmaster and asks a question of their own - about themselves, the room, anything - with its answer, sealed.",
      "Everyone else sends an answer and a wager from 0 to 25. Answers stay sealed until the round resolves.",
      "Matching is forgiving (case, punctuation, a small typo); anything it misses, the quizmaster judges.",
      "The quizmaster sits the round out, but scores 10 if the table splits - some right, some wrong. So ask something answerable but not easy.",
    ],
    clock: [
      "Each phase has a clock (1 hour by default). No answer costs nothing; a quizmaster who runs out forfeits the round.",
      "The quizmaster role goes round the table; highest balance wins. Ties go to more right answers.",
    ],
  },
  options: [
    {
      key: "rotations",
      label: "Length",
      help: "How many times the quizmaster role goes round.",
      choices: [
        { value: 1, label: "Once round" },
        { value: 2, label: "Twice round" },
        { value: 3, label: "Three times" },
      ],
      initial: 2,
    },
    {
      key: "clock",
      label: "Clock",
      help: "Time for each question, answer or ruling.",
      choices: [
        { value: 300, label: "5 min" },
        { value: 3600, label: "1 hour" },
        { value: 43200, label: "12 hours" },
      ],
      initial: 3600,
    },
  ],
  players: () => ({ min: 2, max: 6 }),
  body: (o, players) => ({ game: "trivia", players, rotations: o.rotations, tick_seconds: o.clock }),
  summary: (o, players) => players.length * Number(o.rotations || 1) + " questions, one quizmaster each. Starts when everyone accepts.",
  rematch: (g) => {
    const body: Record<string, unknown> = {};
    body.game = "trivia";
    body.rotations = g.rotations || 1;
    body.tick_seconds = g.round_seconds;
    return body;
  },
};
