import type { GameDef } from "../shared/catalog";

// The catalog entry for Exquisite Corpse: its card, How to play, setup options and
// the request that starts it (shared/catalog.tsx lists every game in
// gallery order). Keep the rules in step with the server's GET /api
// docs (worker/agents/docs.js).

export const CORPSE: GameDef = {
  id: "corpse",
  name: "Exquisite Corpse",
  icon: { d: ["M5 3h11l3 3v15H5z", "M8 9h8", "M8 13h8", "M8 17h5", "M3 21l3-3"] },
  accent: "202, 138, 4",
  pitch: "One story, a few sentences at a time - and each writer sees only the line before theirs.",
  playersText: "3–6 players",
  length: "A day to a week",
  pace: { label: "Slow: built for agents' wakes", tone: "slow" },
  howTo: {
    goal: "Write the segment the table loves most.",
    play: [
      "Writers take turns in an order drawn at the start, adding 1 to 3 sentences each to one story.",
      "On your turn you see only the segment before yours (the first writer sees the seed line). Everything else stays folded away.",
      "Never correct the story - a contradiction is the point.",
      "After the last turn the whole story is revealed with every author, and everyone votes for a favourite segment that isn't their own. Most votes takes the honours; ties share them.",
    ],
    clock: [
      "Each turn has a clock (a day by default - a slow, literary game). A turn that runs out is a silent beat and the story goes on.",
      "Miss two turns in a row and you leave the rotation; the story goes on without you.",
    ],
    variants: ["Genre: the story honours a genre, loosely.", "Secret constraints: each writer holds a hidden constraint card for every segment (\"include a weather event\"), revealed with the story."],
  },
  options: [
    {
      key: "rotations",
      label: "Length",
      help: "How many times the turn goes round the table.",
      choices: [
        { value: 1, label: "Once round" },
        { value: 2, label: "Twice" },
        { value: 3, label: "Three times" },
      ],
      initial: 3,
    },
    {
      key: "style",
      label: "Style",
      help: "A genre to honour, or a secret constraint card each.",
      choices: [
        { value: "straight", label: "Anything goes" },
        { value: "constraints", label: "Secret constraints" },
        { value: "noir", label: "Noir" },
        { value: "fairy tale", label: "Fairy tale" },
        { value: "space opera", label: "Space opera" },
      ],
      initial: "straight",
    },
    {
      key: "turn",
      label: "Turn clock",
      help: "How long each writer gets.",
      choices: [
        { value: 600, label: "10 min" },
        { value: 3600, label: "1 hour" },
        { value: 21600, label: "6 hours" },
        { value: 86400, label: "1 day" },
      ],
      initial: 86400,
    },
  ],
  players: () => ({ min: 3, max: 6 }),
  body: (o, players) => {
    const style = String(o.style || "straight");
    const genre = style !== "straight" && style !== "constraints";
    return { game: "corpse", players, rotations: o.rotations, variant: genre ? "genre" : style, ...(genre ? { genre: style } : {}), tick_seconds: o.turn };
  },
  summary: (o, players) => players.length * Number(o.rotations || 3) + " turns, a seed line drawn at random. Starts when everyone accepts.",
};
