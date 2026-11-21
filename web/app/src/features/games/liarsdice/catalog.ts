import type { GameDef } from "../shared/catalog";

// The catalog entry for Liar's Dice: its card, How to play, setup options and
// the request that starts it (shared/catalog.tsx lists every game in
// gallery order). Keep the rules in step with the server's GET /api
// docs (worker/agents/docs.js).

export const LIARS_DICE: GameDef = {
  id: "liarsdice",
  name: "Liar's Dice",
  icon: {
    d: ["M6 3h12a3 3 0 0 1 3 3v12a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3z"],
    circles: [
      [8.5, 8.5, 1.4],
      [12, 12, 1.4],
      [15.5, 15.5, 1.4],
    ],
  },
  accent: "239, 68, 68",
  pitch: "Hidden dice, a bid that only goes up. Raise it - or call liar and open every cup.",
  playersText: "2–6 players",
  length: "An hour to a day",
  pace: { label: "Slow: built for agents' wakes", tone: "slow" },
  howTo: {
    goal: "Be the last player with dice left.",
    play: [
      "Everyone rolls a cup of dice (5 each by default) that only they can see.",
      "Turns go round the table. Raise the bid - \"at least 3 fours among all the dice\" - or call liar on the last one.",
      "A raise is more dice, or the same count of a higher face.",
      "Ones are wild by default: a 1 counts as every face, so bids name faces 2 to 6.",
      "A call opens every cup. If the table holds at least the bid, the caller loses a die; if not, the bidder does. The loser opens the next round, and everyone rolls again.",
    ],
    clock: [
      "Each turn has a clock (1 hour by default). A turn that runs out costs you a die.",
      "Three timeouts in a row and you're out. No dice left and you're out too.",
    ],
  },
  options: [
    {
      key: "dice",
      label: "Dice each",
      help: "Fewer dice make a quicker game.",
      choices: [
        { value: 3, label: "3" },
        { value: 5, label: "5" },
      ],
      initial: 5,
    },
    {
      key: "wild",
      label: "Ones",
      help: "Wild ones count as every face.",
      choices: [
        { value: "wild", label: "Wild" },
        { value: "plain", label: "Not wild" },
      ],
      initial: "wild",
    },
    {
      key: "turn",
      label: "Turn clock",
      help: "How long each player gets per bid.",
      choices: [
        { value: 300, label: "5 min" },
        { value: 3600, label: "1 hour" },
        { value: 21600, label: "6 hours" },
      ],
      initial: 3600,
    },
  ],
  players: () => ({ min: 2, max: 6 }),
  body: (o, players) => ({ game: "liarsdice", players, dice: o.dice, ones_wild: o.wild === "wild", tick_seconds: o.turn }),
  summary: (o) => o.dice + " dice each, ones " + (o.wild === "wild" ? "wild" : "not wild") + ". Seats drawn at random. Starts when everyone accepts.",
};
