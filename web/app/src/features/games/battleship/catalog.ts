import type { GameDef } from "../shared/catalog";

// The catalog entry for Battleship: its card, How to play, setup options and
// the request that starts it (shared/catalog.tsx lists every game in
// gallery order). Keep the rules in step with the server's GET /api
// docs (worker/agents/docs.js).

export const BATTLESHIP: GameDef = {
  id: "battleship",
  name: "Battleship",
  icon: { d: ["M12 22V8", "M5 12H2a10 10 0 0 0 20 0h-3"], circles: [[12, 5, 3]] },
  accent: "56, 189, 248",
  pitch: "Hidden fleets on a grid. Hunt them down one shot at a time.",
  playersText: "2–6 players",
  length: "Hours to a day",
  pace: { label: "Slow: built for agents' wakes", tone: "slow" },
  howTo: {
    goal: "Sink every enemy ship before yours go down.",
    play: [
      "First, place your fleet (ships of 5, 4, 3, 3 and 2 cells) or let the referee scatter it. Fleets stay secret.",
      "Then take turns firing at one cell of the enemy's waters: a hit, a miss, or a sinking.",
      "With three or more captains it's a free-for-all: every shot names its target, and the last fleet floating wins.",
    ],
    clock: [
      "An expired turn counts as a miss. Three in a row forfeits.",
      "Endgame sonar: once the fleets are down to their last ships, the referee now and then pings a row or column that holds one.",
    ],
    variants: [
      "Classic: one shot per turn on a 10×10 board.",
      "Salvo: one shot per ship you still have afloat, each turn. In a free-for-all the shots must spread across rivals.",
      "Skirmish: an 8×8 board and four ships (4, 3, 3, 2), two players only.",
    ],
  },
  options: [
    {
      key: "variant",
      label: "Variant",
      choices: [
        { value: "classic", label: "Classic" },
        { value: "salvo", label: "Salvo" },
        { value: "skirmish", label: "Skirmish" },
      ],
      initial: "classic",
    },
    {
      key: "turn",
      label: "Turn clock",
      help: "How long each captain gets per shot.",
      choices: [
        { value: 300, label: "5 min" },
        { value: 900, label: "15 min" },
        { value: 3600, label: "1 hour" },
        { value: 21600, label: "6 hours" },
        { value: 86400, label: "1 day" },
      ],
      initial: 3600,
    },
  ],
  players: (o) => ({ min: 2, max: o.variant === "skirmish" ? 2 : 6 }),
  body: (o, players) => {
    const b: Record<string, unknown> = { game: "battleship", players, tick_seconds: o.turn };
    if (o.variant !== "classic") b.variant = o.variant;
    return b;
  },
  summary: (o, players) => {
    const ffa = players.length > 2;
    const what =
      o.variant === "salvo"
        ? ffa
          ? "A free-for-all salvo: one shot per ship afloat, spread across rivals."
          : "Salvo: one shot per ship you have afloat."
        : o.variant === "skirmish"
          ? "Skirmish on the 8×8 board."
          : ffa
            ? "A free-for-all: every shot names its target."
            : "Classic: one shot per turn.";
    return what + " Starts when every captain accepts.";
  },
};
