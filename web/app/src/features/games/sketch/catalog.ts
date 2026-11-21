import type { GameDef } from "../shared/catalog";

// The catalog entry for Sketch & Guess: its card, How to play, setup options and
// the request that starts it (shared/catalog.tsx lists every game in
// gallery order). Keep the rules in step with the server's GET /api
// docs (worker/agents/docs.ts).

export const SKETCH: GameDef = {
  id: "sketch",
  name: "Sketch & Guess",
  icon: { d: ["M4 20l4-1 10-10-3-3L5 16z", "M14 7l3 3", "M4 20h16"] },
  accent: "251, 191, 36",
  pitch: "One player draws a secret prompt; everyone else guesses. Claude referees the close calls.",
  playersText: "3–6 players",
  length: "An hour to a day",
  pace: { label: "Great with agents", tone: "agents" },
  howTo: {
    goal: "Score the most by guessing drawings - and by drawing your prompts so others can guess them.",
    play: [
      "Each round one player is the artist and gets a secret prompt. They draw it on the sketch pad, or send an image they made - no letters or words.",
      "Everyone else sends one sealed guess. A guess that names the prompt is right; the Referee (Claude) rules on close calls.",
      "A right guess scores 2. The artist scores 1 for each player who gets it, up to 2 - so draw something guessable but not trivial.",
      "If nobody gets it, the prompt is revealed with a gentle roast.",
    ],
    clock: [
      "The artist has 1 hour to draw (missing it forfeits the round); guessers have 10 minutes once the drawing is up.",
      "The artist role goes round the table; highest total wins.",
    ],
  },
  options: [
    {
      key: "rotations",
      label: "Length",
      help: "How many times the artist role goes round.",
      choices: [
        { value: 1, label: "Once round" },
        { value: 2, label: "Twice round" },
      ],
      initial: 1,
    },
    {
      key: "guess",
      label: "Guess clock",
      help: "Time to guess once a drawing is up.",
      choices: [
        { value: 120, label: "2 min" },
        { value: 600, label: "10 min" },
        { value: 3600, label: "1 hour" },
      ],
      initial: 600,
    },
  ],
  players: () => ({ min: 3, max: 6 }),
  body: (o, players) => ({ game: "sketch", players, rotations: o.rotations, guess_seconds: o.guess }),
  summary: (o, players) => players.length * Number(o.rotations || 1) + " drawings, one artist each. Starts when everyone accepts.",
  rematch: (g) => {
    const body: Record<string, unknown> = {};
    body.game = "sketch";
    body.rotations = g.rotations || 1;
    body.draw_seconds = g.draw_seconds;
    body.guess_seconds = g.guess_seconds;
    return body;
  },
};
