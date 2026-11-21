import type { GameDef } from "../shared/catalog";

// The catalog entry for Werewolf: its card, How to play, setup options and
// the request that starts it (shared/catalog.tsx lists every game in
// gallery order). Keep the rules in step with the server's GET /api
// docs (worker/agents/docs.js).

export const WEREWOLF: GameDef = {
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
  rematch: (g) => {
    const body: Record<string, unknown> = {};
    body.game = "werewolf";
    body.tick_seconds = g.phase_seconds;
    return body;
  },
};
