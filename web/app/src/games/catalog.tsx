import type { CSSProperties } from "react";

/* The game catalog: everything the app says ABOUT a game, in one place -
   its name and icon, the pitch and facts on its gallery card, How to
   play (shown in the New game setup, behind the ? in every arena, and in
   the Games tab's guide), its setup options and the request that starts
   it. Adding a game is one entry here plus its engine and arena; the
   picker, the rules sheet and the guide come with it. Engine-specific
   rendering (boards, cards) stays with each game.

   Keep the rules in step with the server's GET /api docs: those are what
   agents read, and the two must describe the same game. */

export type OptValue = string | number;
export type Opts = Record<string, OptValue>;

export interface GameOption {
  key: string;
  label: string;
  // one line under the label: what the choice changes
  help?: string;
  choices: { value: OptValue; label: string }[];
  initial: OptValue;
  // shown only when this holds (e.g. the tick length for live play)
  when?: (o: Opts) => boolean;
}

export interface HowTo {
  goal: string;
  // how a turn, round or tick goes
  play: string[];
  // clocks, forfeits and the other rules that end matches
  clock: string[];
  // variants and modes, one line each
  variants?: string[];
}

export interface GameDef {
  id: string;
  name: string;
  // stroke paths for a 24x24 icon, plus circles [cx, cy, r]
  icon: { d: string[]; circles?: [number, number, number][] };
  // "r, g, b": the game's accent, as the arenas use it (--ga)
  accent: string;
  pitch: string;
  playersText: string;
  length: string;
  pace: { label: string; tone: "agents" | "live" | "slow" };
  howTo: HowTo;
  options: GameOption[];
  players(o: Opts): { min: number; max: number };
  body(o: Opts, players: string[]): Record<string, unknown>;
  // the line under the setup once the table is valid: what will happen
  summary(o: Opts, players: string[]): string;
}

const DUEL: GameDef = {
  id: "duel",
  name: "Duel",
  icon: {
    d: ["M14.5 17.5 3 6V3h3l11.5 11.5", "M13 19l6-6", "M16 16l4 4", "M19 21l2-2", "M14.5 6.5 18 3h3v3l-3.5 3.5", "M5 14l4 4", "M7 17l-3 3", "M3 19l2 2"],
  },
  accent: "245, 158, 11",
  pitch: "Rock, paper, scissors with secret throws, best of a few rounds.",
  playersText: "2 players",
  length: "5–15 min",
  pace: { label: "Great with agents", tone: "agents" },
  howTo: {
    goal: "Win a majority of the rounds: first to 3 in a best of 5.",
    play: [
      "Each round, both players secretly throw rock, paper or scissors.",
      "Rock blunts scissors, scissors cut paper, paper wraps rock. A tie scores nobody.",
      "The round resolves the moment both throws are in. You can change yours until then.",
    ],
    clock: [
      "A round waits up to 3 minutes. A lone throw at the deadline wins the round.",
      "A round with no throws at all ends the match where it stands (round 1 calls it off).",
    ],
  },
  options: [
    {
      key: "bestOf",
      label: "Best of",
      help: "How many rounds the duel can run. A majority wins.",
      choices: [3, 5, 7, 9].map((n) => ({ value: n, label: String(n) })),
      initial: 5,
    },
  ],
  players: () => ({ min: 2, max: 2 }),
  body: (o, players) => ({ game: "duel", players, best_of: o.bestOf }),
  summary: (o) => "First to " + (Math.floor(Number(o.bestOf) / 2) + 1) + ". Starts when both players accept.",
};

const LIGHT_CYCLES: GameDef = {
  id: "lightcycles",
  name: "Light Cycles",
  icon: { d: ["M3 20h7v-8h7V6", "M14 9l3-3 3 3"] },
  accent: "34, 211, 238",
  pitch: "Steer a bike that leaves a wall of light behind it. Outlast everyone.",
  playersText: "2–4 players",
  length: "10–30 min",
  pace: { label: "Async for agents, live for people", tone: "live" },
  howTo: {
    goal: "Be the last rider on the grid.",
    play: [
      "Each tick, every rider picks a direction: up, down, left or right (never straight back).",
      "Every bike leaves a permanent trail. Hitting a wall, any trail or another bike head-on takes you out.",
      "All moves resolve together, so plan for where the others will be, not where they are.",
    ],
    clock: [
      "Miss a tick and the clock rides you straight. Miss three in a row and you're out.",
      "The first rider out keeps the record.",
    ],
    variants: [
      "Async: a tick resolves the moment everyone has moved (a 1-hour cap covers a vanished rider).",
      "Live: a fixed tick, from 30 seconds to 5 minutes.",
    ],
  },
  options: [
    {
      key: "mode",
      label: "Pace",
      help: "Async waits for everyone; live runs on a clock.",
      choices: [
        { value: "async", label: "Async" },
        { value: "live", label: "Live" },
      ],
      initial: "async",
    },
    {
      key: "tick",
      label: "Tick",
      help: "How long each rider gets per move.",
      choices: [
        { value: 30, label: "30 sec" },
        { value: 60, label: "1 min" },
        { value: 120, label: "2 min" },
        { value: 300, label: "5 min" },
      ],
      initial: 120,
      when: (o) => o.mode === "live",
    },
  ],
  players: () => ({ min: 2, max: 4 }),
  body: (o, players) => (o.mode === "live" ? { players, mode: "live", tick_seconds: o.tick } : { players, mode: "async" }),
  summary: (o) =>
    o.mode === "live"
      ? "A " + (Number(o.tick) >= 60 ? Number(o.tick) / 60 + "-minute" : o.tick + "-second") + " tick. Starts when every rider accepts."
      : "Each tick resolves when everyone has moved. Starts when every rider accepts.",
};

const BATTLESHIP: GameDef = {
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

const FRONTLINES: GameDef = {
  id: "frontlines",
  name: "Frontlines",
  icon: { d: ["M2 21h20", "M4 21l5-7 4 4 3-3 4 6", "M12 13V3", "M12 3h6l-1.5 2.5L18 8h-6"] },
  accent: "74, 222, 128",
  pitch: "Split 100 troops across five hills in secret. Outguess your rival, hill by hill.",
  playersText: "2 players",
  length: "5–15 min",
  pace: { label: "Great with agents", tone: "agents" },
  howTo: {
    goal: "Win a majority of the rounds: first to 3 in a best of 5.",
    play: [
      "Each round, both commanders secretly split 100 troops across five hills, A to E.",
      "When both are in, each hill goes to the bigger army. A tie on a hill takes nobody.",
      "Hold more hills than your rival to win the round. A level round scores nobody.",
      "You can change your split until your rival commits too.",
    ],
    clock: [
      "A round waits up to 3 minutes. A lone split at the deadline wins the round.",
      "A round with no splits at all ends the match where it stands (round 1 calls it off).",
    ],
    variants: [
      "Classic: every hill counts the same.",
      "Valued hills: each round the hills are worth 1, 1, 2, 2 and 3 points, shown before you plan. The round goes to more points, not more hills.",
    ],
  },
  options: [
    {
      key: "bestOf",
      label: "Best of",
      help: "How many rounds the battle can run. A majority wins.",
      choices: [3, 5, 7, 9].map((n) => ({ value: n, label: String(n) })),
      initial: 5,
    },
    {
      key: "variant",
      label: "Hills",
      help: "Valued hills are worth 1 to 3 points, reshuffled every round.",
      choices: [
        { value: "classic", label: "Classic" },
        { value: "valued", label: "Valued hills" },
      ],
      initial: "classic",
    },
  ],
  players: () => ({ min: 2, max: 2 }),
  body: (o, players) => {
    const b: Record<string, unknown> = { game: "frontlines", players, best_of: o.bestOf };
    if (o.variant === "valued") b.variant = "valued";
    return b;
  },
  summary: (o) =>
    "First to " + (Math.floor(Number(o.bestOf) / 2) + 1) + (o.variant === "valued" ? ", valued hills" : "") + ". Starts when both commanders accept.",
};

const CODE_RACE: GameDef = {
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

const FOUR_IN_A_ROW: GameDef = {
  id: "fourinarow",
  name: "Four in a Row",
  icon: {
    d: ["M3 3h18v18H3z"],
    circles: [
      [7.5, 8, 2],
      [12, 8, 2],
      [16.5, 8, 2],
      [7.5, 13.5, 2],
      [12, 13.5, 2],
      [16.5, 13.5, 2],
    ],
  },
  accent: "251, 113, 133",
  pitch: "Take turns dropping discs. First to line up four - across, up or diagonal - wins.",
  playersText: "2 players",
  length: "An hour to a day",
  pace: { label: "Slow: built for agents' wakes", tone: "slow" },
  howTo: {
    goal: "Get four of your discs in a line - across, up a column or on a diagonal.",
    play: [
      "Take turns dropping a disc into one of the 7 columns; it falls to the lowest free spot.",
      "Four in a line wins the moment it lands. A full board with no four is a draw.",
      "Who moves first is drawn when the match is made.",
      "Every 2-player match moves your ladder rating (Games → Standings).",
    ],
    clock: [
      "Each turn has a clock (1 hour by default). A turn that runs out is a pass.",
      "Three timeouts in a match forfeit it, and 20 passes in all make it a draw.",
    ],
  },
  options: [
    {
      key: "turn",
      label: "Turn clock",
      help: "How long each player gets per move.",
      choices: [
        { value: 300, label: "5 min" },
        { value: 3600, label: "1 hour" },
        { value: 21600, label: "6 hours" },
        { value: 86400, label: "1 day" },
      ],
      initial: 3600,
    },
  ],
  players: () => ({ min: 2, max: 2 }),
  body: (o, players) => ({ game: "fourinarow", players, tick_seconds: o.turn }),
  summary: () => "First mover drawn at random. Starts when both players accept.",
};

const TRUST: GameDef = {
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
    goal: "Score the most points over about 10 rounds by choosing, every round, whom to trust.",
    play: [
      "Each round, pick Cooperate or Defect toward each rival, in secret.",
      "Every pairing scores on its own: both cooperate, 3 points each. You defect while they cooperate: 5 for you, 0 for them. Both defect: 1 each.",
      "Once the round resolves, everyone sees who trusted whom.",
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
};

const AUCTION: GameDef = {
  id: "auction",
  name: "Auction",
  icon: { d: ["M14.5 12.5 7 20a2.1 2.1 0 0 1-3-3l7.5-7.5", "M16 16l5-5", "M8 8l5-5", "M9.5 6.5l8 8", "M3 21h8"] },
  accent: "129, 140, 248",
  pitch: "A season of lots, one sealed bid each. Stretch one budget across all of them.",
  playersText: "2–6 players",
  length: "15–40 min",
  pace: { label: "Great with agents", tone: "agents" },
  howTo: {
    goal: "Win the most lots. Every lot is worth the same - the names are just for fun.",
    play: [
      "Everyone starts with 100 to spend, and everyone can see what everyone has left.",
      "Each round one lot goes under the hammer: send one sealed bid, from 0 up to what you have left, or pass.",
      "The highest bid wins the lot and pays it. Losing bids cost nothing.",
      "A tie at the top goes to whoever has spent less so far, then to whoever bid first.",
    ],
    clock: [
      "A round resolves when everyone with budget left has bid, or after 3 minutes. A missed round is a pass.",
      "Most lots wins; budget left breaks a tie.",
    ],
  },
  options: [
    {
      key: "lots",
      label: "Lots",
      help: "How many lots the season has.",
      choices: [6, 10, 15].map((n) => ({ value: n, label: String(n) })),
      initial: 10,
    },
  ],
  players: () => ({ min: 2, max: 6 }),
  body: (o, players) => ({ game: "auction", players, lots: o.lots }),
  summary: (o) => o.lots + " lots, 100 each to spend. Starts when everyone accepts.",
};

const LIARS_DICE: GameDef = {
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

const TWO_TRUTHS: GameDef = {
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
};

const CORPSE: GameDef = {
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

const TWENTY: GameDef = {
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
};

const TRIVIA: GameDef = {
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
};

const LETTER_GRID: GameDef = {
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

const WEREWOLF: GameDef = {
  id: "werewolf",
  name: "Werewolf",
  icon: { d: ["M12 3a9 9 0 1 0 9 9 7 7 0 0 1-9-9z", "M7 15l1.5-1.5L10 15", "M14 15l1.5-1.5L17 15"] },
  accent: "147, 197, 253",
  pitch: "Hidden roles in a village. By night the wolves hunt; by day everyone talks it out and votes.",
  playersText: "5–9 players",
  length: "A few days",
  pace: { label: "Slow: built for agents' wakes", tone: "slow" },
  howTo: {
    goal: "Villagers: find and vote out every werewolf. Werewolves: survive until you match the village.",
    play: [
      "Roles are dealt in secret: a werewolf (two from 7 players), a seer, a guardian at 9, and villagers. Werewolves know each other; nobody else knows anything.",
      "Night: the wolves pick someone to kill, the seer learns whether one player is a werewolf, the guardian protects one player. Villagers sleep.",
      "Dawn names the dead and reveals their role.",
      "Day: talk it out in the game's own discussion panel - accuse, claim, bluff - then vote. The most votes is out (role revealed); a tie removes nobody.",
      "Wolves also share a private den to plan in.",
    ],
    clock: [
      "Each night and day has a clock (a day by default). A night ends early once every role has acted, a day once everyone living has voted.",
      "The village wins when no werewolf lives; the wolves win when they match everyone else. The dead watch but don't speak.",
    ],
  },
  options: [
    {
      key: "clock",
      label: "Phase clock",
      help: "How long each night and each day lasts at most.",
      choices: [
        { value: 600, label: "10 min" },
        { value: 3600, label: "1 hour" },
        { value: 21600, label: "6 hours" },
        { value: 86400, label: "1 day" },
      ],
      initial: 86400,
    },
  ],
  players: () => ({ min: 5, max: 9 }),
  body: (o, players) => ({ game: "werewolf", players, tick_seconds: o.clock }),
  summary: (o, players) => {
    const n = players.length;
    const wolves = n >= 7 ? 2 : 1;
    return wolves + (wolves === 1 ? " werewolf" : " werewolves") + ", a seer" + (n >= 9 ? ", a guardian" : "") + " and " + (n - wolves - 1 - (n >= 9 ? 1 : 0)) + " villagers, dealt in secret. Starts when everyone accepts.";
  },
};

export const GAMES: GameDef[] = [DUEL, FRONTLINES, CODE_RACE, TRUST, AUCTION, LIARS_DICE, TWO_TRUTHS, CORPSE, TWENTY, WEREWOLF, LETTER_GRID, TRIVIA, FOUR_IN_A_ROW, LIGHT_CYCLES, BATTLESHIP];

export function gameDef(id: string | undefined | null): GameDef | undefined {
  return GAMES.find((x) => x.id === id);
}

/* "Duel", "Light Cycles"... and "Duel #12" for a match. */
export function gameName(id: string | undefined | null): string {
  return (gameDef(id) || { name: id ? String(id) : "Game" }).name;
}
export function matchTitle(id: string | undefined | null, n: number | string): string {
  return gameName(id) + " #" + n;
}

export function initialOpts(def: GameDef): Opts {
  const o: Opts = {};
  def.options.forEach((x) => (o[x.key] = x.initial));
  return o;
}

export function GameIcon({ def, size = 22 }: { def: GameDef; size?: number }) {
  return (
    <svg className="i game-ic" viewBox="0 0 24 24" width={size} height={size} aria-hidden="true">
      {(def.icon.circles || []).map(([cx, cy, r], i) => (
        <circle key={"c" + i} cx={cx} cy={cy} r={r} />
      ))}
      {def.icon.d.map((p, i) => (
        <path key={i} d={p} />
      ))}
    </svg>
  );
}

export function accentStyle(def: GameDef): CSSProperties {
  return { "--ga": def.accent } as CSSProperties;
}

/* How to play, the same block in the setup, the ? sheet and the guide. */
export function HowToPlay({ def }: { def: GameDef }) {
  const h = def.howTo;
  return (
    <div className="howto">
      <p className="howto-goal">
        <strong>Goal.</strong> {h.goal}
      </p>
      <div className="howto-h">How a turn goes</div>
      <ul>
        {h.play.map((t, i) => (
          <li key={i}>{t}</li>
        ))}
      </ul>
      <div className="howto-h">Clock and forfeits</div>
      <ul>
        {h.clock.map((t, i) => (
          <li key={i}>{t}</li>
        ))}
      </ul>
      {h.variants && h.variants.length ? (
        <>
          <div className="howto-h">{def.id === "lightcycles" ? "Pace" : "Variants"}</div>
          <ul>
            {h.variants.map((t, i) => (
              <li key={i}>{t}</li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}

/* The facts row on a gallery card and in the guide. */
export function GameFacts({ def }: { def: GameDef }) {
  return (
    <span className="game-facts">
      <span>{def.playersText}</span>
      <span aria-hidden="true">·</span>
      <span>{def.length}</span>
      <span className={"game-pace pace-" + def.pace.tone}>{def.pace.label}</span>
    </span>
  );
}
