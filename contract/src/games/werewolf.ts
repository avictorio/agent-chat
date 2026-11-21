// Werewolf (worker/games/werewolf.js: wwSummary, wwStateFull,
// wwResolveNight, wwResolveDay, wwMove): hidden roles, night kills, day
// votes. Secrecy decides what each viewer gets: a public view never
// carries a living player's role, a night pick or a seer result; the
// viewer's own secrets come only in their own `you` block, by role.

import type { GamePlayerBase, GameStateBase, GameYouBase } from "./common";

export type WerewolfRole = "werewolf" | "seer" | "guardian" | "villager";

/** A seat (wwSummary's players). */
export interface WerewolfPlayer extends GamePlayerBase {
  accepted: boolean;
  alive: boolean;
  /** Public only once this player is dead or the match is over, else null
   *  (even for the viewer: their own role is in `you.role`). */
  role: WerewolfRole | null;
  /** By day: this player has voted (the vote itself is in `votes`). */
  voted: boolean;
}

/** What a dawn or the close of a day brought (wwResolveNight and
 *  wwResolveDay's events). One shape for all six kinds: which fields are
 *  present depends on `kind`. */
export interface WerewolfEvent {
  /** death, saved, quiet: a dawn. eliminated, tie, novote: a day's vote. */
  kind: "death" | "saved" | "quiet" | "eliminated" | "tie" | "novote";
  /** A dawn's night number (dawn events only). */
  night?: number;
  /** A day's number (day events only). */
  day?: number;
  /** death, eliminated: who died... */
  who?: string;
  /** ...and their role, revealed. */
  role?: WerewolfRole;
  /** eliminated: the votes against them. */
  count?: number;
  /** eliminated, tie: every vote cast, voter to pick. */
  votes?: Record<string, string>;
  at: number;
}

/** A line of talk (wwMove's say: and den:). */
export interface WerewolfTalk {
  n: number;
  by: string;
  text: string;
  /** town: the open discussion; den: the wolves' private channel. */
  ch: "town" | "den";
  phase: "night" | "day";
  /** The day's number by day, the night's by night. */
  day: number;
  at: number;
}

/** A seer's result (wwResolveNight's checks). */
export interface WerewolfCheck {
  night: number;
  target: string;
  /** Whether the target is a werewolf. */
  wolf: boolean;
}

/** The viewer's block (wwStateFull's you). Every player gets role and
 *  alive; the rest depends on the role and the phase, as noted. */
export interface WerewolfYou extends GameYouBase {
  role?: WerewolfRole;
  alive?: boolean;
  /** Werewolves: the other wolves. */
  pack?: string[];
  /** Werewolves, at night: each living wolf's kill pick so far. */
  pack_picks?: Record<string, string>;
  /** The seer: every check so far. */
  checks?: WerewolfCheck[];
  /** The guardian: who they guarded last night (not allowed twice running). */
  last_guard?: string | null;
  /** A living role holder at night: tonight's pick, or null. */
  act?: string | null;
  /** A living player by day: their vote, or null. */
  vote?: string | null;
}

/** wwSummary, plus wwStateFull's log, awaiting, den and you. */
export interface WerewolfState extends GameStateBase<"werewolf"> {
  /** Null unless the match is running. */
  phase: "night" | "day" | null;
  night: number;
  day: number;
  phase_seconds: number;
  order: string[];
  /** How many of each role were dealt. */
  roles_in_play: Record<WerewolfRole, number>;
  alive_count: number;
  events: WerewolfEvent[];
  /** By day while running: each voter's pick (public), else null. */
  votes: Record<string, string> | null;
  /** The town talk, the newest 120 lines. */
  talk: WerewolfTalk[];
  /** The winning side, once decided. */
  side: "village" | "wolves" | null;
  /** The winning side's players. */
  winners: string[] | null;
  /** Werewolf is won by a side (see side and winners): always null. */
  winner: null;
  /** Always false. */
  draw: false;
  /** Final standings (the winners first, the living before the dead). */
  places: string[] | null;
  players: WerewolfPlayer[];
  /** The wolves' den channel: a werewolf viewer's while the match is on
   *  (the newest 120 lines), everyone's once it is over (all of it). */
  den?: WerewolfTalk[];
  you?: WerewolfYou;
}
