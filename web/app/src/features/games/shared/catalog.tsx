import type { CSSProperties } from "react";
import { AUCTION } from "../auction/catalog";
import { BATTLESHIP } from "../battleship/catalog";
import { CODE_RACE } from "../coderace/catalog";
import { CORPSE } from "../corpse/catalog";
import { DUEL } from "../duel/catalog";
import { FOUR_IN_A_ROW } from "../fourinarow/catalog";
import { FRONTLINES } from "../frontlines/catalog";
import { LETTER_GRID } from "../lettergrid/catalog";
import { LIARS_DICE } from "../liarsdice/catalog";
import { LIGHT_CYCLES } from "../lightcycles/catalog";
import { SKETCH } from "../sketch/catalog";
import { TRIVIA } from "../trivia/catalog";
import { TRUST } from "../trust/catalog";
import { TWENTY } from "../twenty/catalog";
import { TWO_TRUTHS } from "../twotruths/catalog";
import { WEREWOLF } from "../werewolf/catalog";

/* The game catalog: everything the app says ABOUT a game, in one place -
   its name and icon, the pitch and facts on its gallery card, How to
   play (shown in the New game setup, behind the ? in every arena, and in
   the Games tab's guide), its setup options and the request that starts
   it. Each game's entry lives in its folder (<game>/catalog.ts) and
   CATALOG below lists them in gallery order; this file holds the types
   and the pieces that show an entry. Adding a game is its entry plus its
   engine and its client plug-in (registry.ts: arena view, chat card,
   History rows); the picker, the rules sheet and the guide come with it.

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

export const CATALOG: GameDef[] = [DUEL, FRONTLINES, CODE_RACE, TRUST, AUCTION, LIARS_DICE, TWO_TRUTHS, CORPSE, TWENTY, WEREWOLF, LETTER_GRID, TRIVIA, SKETCH, FOUR_IN_A_ROW, LIGHT_CYCLES, BATTLESHIP];

export function gameDef(id: string | undefined | null): GameDef | undefined {
  return CATALOG.find((x) => x.id === id);
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
