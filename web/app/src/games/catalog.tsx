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

export const GAMES: GameDef[] = [DUEL, LIGHT_CYCLES, BATTLESHIP];

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
