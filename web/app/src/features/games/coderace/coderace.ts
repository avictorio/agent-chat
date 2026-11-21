import { el } from "../../../lib/index";
import type { CodeRaceFeedback, CodeRacePlayer, CodeRaceRound, CodeRaceState } from "@chat/contract";

/* Code Race (2026-11-19): the palette, the racer's status and the
   round history; the race board (card and arena), the secret and the
   guess input are React (CodeRacePanels.tsx). Everyone races on the same
   secret; a racer sees their own guesses in full and a rival's only as
   feedback until the race ends (the server already strips what this
   viewer may not see - the board just draws what it gets).

   Colors: a guess is a row of pegs; its feedback is filled dots (right
   colour, right place: the classic black peg) and rings (right colour,
   wrong place: the white peg). Words: a guess is a row of letter tiles,
   green (right place), yellow (in the word elsewhere) or grey. A rival's
   rows are the same tiles with no letters in them. */

export type Pal = { k: string; name: string; hex: string }[];

export const TILE_LABEL: Record<string, string> = { G: "right place", Y: "in the word", ".": "not in it" };

export function crPalette(g: CodeRaceState): Pal {
  return (g && g.palette) || [];
}

/* Feedback for one guess in a History row (the panels draw it with
   CrFeedback, the same markup). Colors: [black, white] as dots and rings
   in a little block. Words: the tile colours (with letters when we have
   the guess). */
function crFeedbackEl(g: CodeRaceState, fb: CodeRaceFeedback, guess?: string | null): HTMLElement {
  if (g.mode === "words") {
    const row = el("span", "cr-tiles");
    const s = String(fb || "");
    for (let i = 0; i < (g.length || s.length); i++) {
      const f = s[i] || ".";
      const t = el("span", "cr-tile " + (f === "G" ? "g" : f === "Y" ? "y" : "n"), guess ? String(guess[i] || "").toUpperCase() : "");
      t.setAttribute("aria-label", (guess ? String(guess[i] || "").toUpperCase() + ": " : "") + TILE_LABEL[f]);
      row.appendChild(t);
    }
    return row;
  }
  // colors mode: fb is the [black, white] pair
  const b = (fb && (fb as [number, number])[0]) || 0;
  const w = (fb && (fb as [number, number])[1]) || 0;
  const box = el("span", "cr-pips");
  box.setAttribute("aria-label", b + " right place, " + w + " right colour wrong place");
  box.title = b + " right place · " + w + " right colour, wrong place";
  // the classic block: 2 x 2 for four pegs, 3 across for five or six
  box.style.setProperty("--pc", String(Math.ceil((g.length || 4) / 2)));
  for (let i = 0; i < (g.length || 4); i++) box.appendChild(el("span", "cr-pip" + (i < b ? " hit" : i < b + w ? " near" : "")));
  return box;
}

export function crStatus(g: CodeRaceState, p: CodeRacePlayer): string {
  if (p.solved) return "cracked it · round " + p.solved;
  if (p.out) return "out";
  if (g.status === "running") return p.committed ? "guessed ✓" : "thinking…";
  if (g.status === "finished") return "didn't crack it";
  return "";
}

/* History: a row per round - each racer's feedback (and guess, when the
   viewer may see it), who cracked it. */
export function crHistoryRows(g: CodeRaceState, row: (idx: string) => HTMLElement, who: (p: CodeRacePlayer) => HTMLElement, list: HTMLElement): number {
  let n = 0;
  const players: CodeRacePlayer[] = g.players || [];
  (g.rounds || []).forEach((r: CodeRaceRound) => {
    n++;
    const rw = row("Round " + r.n);
    players.forEach((p: CodeRacePlayer) => {
      const x = (r.guesses || {})[p.name];
      if (!x && (r.missed || []).indexOf(p.name) < 0) return;
      const seg = el("span", "hist-seg");
      seg.appendChild(who(p));
      if (x) {
        if (x.guess && g.mode !== "words") seg.appendChild(el("span", "hist-act", String(x.guess).split("").join(" ")));
        seg.appendChild(crFeedbackEl(g, x.fb, x.guess || null));
      } else seg.appendChild(el("span", "hist-act", (r.dropped || []).indexOf(p.name) >= 0 ? "— no guess · out" : "— no guess"));
      rw.appendChild(seg);
    });
    if ((r.solved || []).length) {
      const pill = el("span", "hist-pill win", r.solved.join(" & ") + " cracked it");
      const p0 = players.find((p) => p.name === r.solved[0]);
      if (p0) {
        pill.style.borderColor = p0.hex;
        pill.style.color = p0.hex;
      }
      rw.appendChild(pill);
    }
    list.appendChild(rw);
  });
  return n;
}
