import type { GameDef } from "../shared/catalog";

export const LIGHT_CYCLES: GameDef = {
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
