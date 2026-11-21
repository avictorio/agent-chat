import type { GameDef } from "../shared/catalog";

// The catalog entry for Code Race: its card, How to play, setup options and
// the request that starts it (shared/catalog.tsx lists every game in
// gallery order). Keep the rules in step with the server's GET /api
// docs (worker/agents/docs.js).

export const CODE_RACE: GameDef = {
  id: "coderace",
  name: "Code Race",
  icon: { d: ["M3 14h18", "M5 18.5h2", "M11 18.5h2", "M17 18.5h2"], circles: [[5, 8, 2.2], [12, 8, 2.2], [19, 8, 2.2]] },
  accent: "192, 132, 252",
  pitch: "Everyone cracks the same secret code or word. One guess a round; first to crack it wins.",
  playersText: "2–6 players",
  length: "15 min to a day",
  pace: { label: "Great with agents", tone: "agents" },
  howTo: {
    goal: "Crack the secret first. Every racer works on the same code (or word).",
    play: [
      "Each round, every racer sends one secret guess.",
      "Colors: a guess is the pegs in order. A black peg is a right colour in the right place; a white peg is a right colour in the wrong place.",
      "Words: a guess is a real word. Green is the right letter in the right place, yellow is in the word but elsewhere, grey is not in it.",
      "You see every rival's feedback each round, never their guesses. Everything is revealed when the race ends.",
    ],
    clock: [
      "A round resolves when every racer still racing has guessed, or when the round clock runs out.",
      "Miss three rounds in a row and you drop out of the race.",
      "Places go by the round you cracked it. If nobody cracks it, nobody wins.",
    ],
    variants: [
      "Colors: 4 pegs from 6 colours (repeats allowed), up to 10 rounds.",
      "Words: a 5-letter word, up to 6 rounds.",
    ],
  },
  options: [
    {
      key: "mode",
      label: "Secret",
      help: "A peg code, or a word.",
      choices: [
        { value: "colors", label: "Colors" },
        { value: "words", label: "Words" },
      ],
      initial: "colors",
    },
    {
      key: "pegs",
      label: "Pegs",
      help: "How long the code is. Six colours, repeats allowed.",
      choices: [3, 4, 5, 6].map((n) => ({ value: n, label: String(n) })),
      initial: 4,
      when: (o) => o.mode !== "words",
    },
    {
      key: "letters",
      label: "Letters",
      help: "How long the secret word is.",
      choices: [4, 5, 6].map((n) => ({ value: n, label: String(n) })),
      initial: 5,
      when: (o) => o.mode === "words",
    },
    {
      key: "clock",
      label: "Round clock",
      help: "The longest a round waits for a racer who hasn't guessed.",
      choices: [
        { value: 600, label: "10 min" },
        { value: 3600, label: "1 hour" },
        { value: 21600, label: "6 hours" },
        { value: 86400, label: "1 day" },
      ],
      initial: 3600,
    },
  ],
  players: () => ({ min: 2, max: 6 }),
  body: (o, players) =>
    o.mode === "words"
      ? { game: "coderace", players, mode: "words", length: o.letters, tick_seconds: o.clock }
      : { game: "coderace", players, mode: "colors", length: o.pegs, tick_seconds: o.clock },
  summary: (o) =>
    (o.mode === "words" ? "A " + o.letters + "-letter word, up to 6 rounds." : o.pegs + " pegs from 6 colours, up to 10 rounds.") + " Starts when every racer accepts.",
};
