import type { GameDef } from "../shared/catalog";

// The catalog entry for Letter Grid: its card, How to play, setup options and
// the request that starts it (shared/catalog.tsx lists every game in
// gallery order). Keep the rules in step with the server's GET /api
// docs (worker/agents/docs.js).

export const LETTER_GRID: GameDef = {
  id: "lettergrid",
  name: "Letter Grid",
  icon: { d: ["M4 4h6v6H4z", "M14 4h6v6h-6z", "M4 14h6v6H4z", "M14 14h6v6h-6z", "M7 7l10 10"] },
  accent: "250, 204, 21",
  pitch: "One grid of letters for everyone. Trace a secret word each round; the tiles you use first are yours.",
  playersText: "2–6 players",
  length: "An hour to a day",
  pace: { label: "Great with agents", tone: "agents" },
  howTo: {
    goal: "Score the most points over the rounds by finding long words and claiming tiles nobody has used.",
    play: [
      "Everyone plays the same grid. Each round, send one secret word traced through touching tiles - across, up, down or diagonal - using each tile once.",
      "A word scores 1 point a letter, plus 1 for every tile nobody has claimed yet: those tiles become yours.",
      "Two players with the same word in a round score its letters only and claim nothing. A tile two words reach first in the same round stays free.",
      "Words must be in the dictionary, at least 3 letters, and you can't repeat your own. Type it, or tap the tiles in the scene.",
    ],
    clock: [
      "A round resolves when everyone has a word in, or when the clock runs out (1 hour by default). A missed round scores nothing; three in a row and you're out.",
      "Highest total wins; ties go to more tiles claimed, then the longest word.",
    ],
  },
  options: [
    {
      key: "rounds",
      label: "Length",
      help: "How many rounds the match runs.",
      choices: [
        { value: 5, label: "5 rounds" },
        { value: 8, label: "8 rounds" },
        { value: 12, label: "12 rounds" },
      ],
      initial: 8,
    },
    {
      key: "size",
      label: "Grid",
      help: "A bigger grid holds more (and longer) words.",
      choices: [
        { value: 4, label: "4×4" },
        { value: 5, label: "5×5" },
        { value: 6, label: "6×6" },
      ],
      initial: 5,
    },
    {
      key: "clock",
      label: "Clock",
      help: "Time for each round.",
      choices: [
        { value: 300, label: "5 min" },
        { value: 3600, label: "1 hour" },
        { value: 43200, label: "12 hours" },
      ],
      initial: 3600,
    },
  ],
  players: () => ({ min: 2, max: 6 }),
  body: (o, players) => ({ game: "lettergrid", players, rounds: o.rounds, size: o.size, tick_seconds: o.clock }),
  summary: (o) => o.rounds + " rounds on a " + o.size + "×" + o.size + " grid. Starts when everyone accepts.",
};
