import { el } from "../../lib";
import type { GL } from "../shared/render";

/* Code Race in the DOM (2026-11-19): the race board (card and arena),
   the guess input and the round history. Everyone races on the same
   secret; a racer sees their own guesses in full and a rival's only as
   feedback until the race ends (the server already strips what this
   viewer may not see - the board just draws what it gets).

   Colors: a guess is a row of pegs; its feedback is filled dots (right
   colour, right place: the classic black peg) and rings (right colour,
   wrong place: the white peg). Words: a guess is a row of letter tiles,
   green (right place), yellow (in the word elsewhere) or grey. A rival's
   rows are the same tiles with no letters in them. */

export type Pal = { k: string; name: string; hex: string }[];

const TILE_LABEL: Record<string, string> = { G: "right place", Y: "in the word", ".": "not in it" };

export function crPalette(g: GL): Pal {
  return (g && g.palette) || [];
}

function pegEl(pal: Pal, k: string | null, cls = ""): HTMLElement {
  const p = el("span", "cr-peg" + (k ? "" : " empty") + (cls ? " " + cls : ""));
  const c = k ? pal.find((x) => x.k === k) : null;
  if (c) {
    p.style.setProperty("--peg", c.hex);
    p.title = c.name;
    p.setAttribute("aria-label", c.name);
    p.textContent = c.k;
  }
  return p;
}

/* Feedback for one guess. Colors: [black, white] as dots and rings in a
   little block. Words: the tile colours (with letters when we have the
   guess). */
export function crFeedbackEl(g: GL, fb: GL, guess?: string | null): HTMLElement {
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
  const b = (fb && fb[0]) || 0;
  const w = (fb && fb[1]) || 0;
  const box = el("span", "cr-pips");
  box.setAttribute("aria-label", b + " right place, " + w + " right colour wrong place");
  box.title = b + " right place · " + w + " right colour, wrong place";
  // the classic block: 2 x 2 for four pegs, 3 across for five or six
  box.style.setProperty("--pc", String(Math.ceil((g.length || 4) / 2)));
  for (let i = 0; i < (g.length || 4); i++) box.appendChild(el("span", "cr-pip" + (i < b ? " hit" : i < b + w ? " near" : "")));
  return box;
}

/* One guess row: the guess (pegs or tiles) and its feedback. */
function guessRow(g: GL, n: number | string, guess: string | null, fb: GL | null, opts?: { sealed?: boolean; cracked?: boolean }): HTMLElement {
  const row = el("div", "cr-row" + (opts && opts.sealed ? " sealed" : "") + (opts && opts.cracked ? " cracked" : ""));
  row.appendChild(el("span", "cr-n", String(n)));
  if (g.mode === "words") {
    if (fb) row.appendChild(crFeedbackEl(g, fb, guess));
    else {
      const tiles = el("span", "cr-tiles");
      for (let i = 0; i < (g.length || 5); i++) tiles.appendChild(el("span", "cr-tile open", guess ? String(guess[i] || "").toUpperCase() : ""));
      row.appendChild(tiles);
    }
  } else {
    const pal = crPalette(g);
    const pegs = el("span", "cr-pegs");
    if (guess) for (let i = 0; i < (g.length || 4); i++) pegs.appendChild(pegEl(pal, guess[i] || null));
    else for (let i = 0; i < (g.length || 4); i++) pegs.appendChild(el("span", "cr-peg hidden"));
    row.appendChild(pegs);
    if (fb) row.appendChild(crFeedbackEl(g, fb));
  }
  if (opts && opts.sealed) row.appendChild(el("span", "cr-sealed", "sealed"));
  return row;
}

export function crStatus(g: GL, p: GL): string {
  if (p.solved) return "cracked it · round " + p.solved;
  if (p.out) return "out";
  if (g.status === "running") return p.committed ? "guessed ✓" : "thinking…";
  if (g.status === "finished") return "didn't crack it";
  return "";
}

/* The secret, once the race is over. */
export function crSecretEl(g: GL): HTMLElement | null {
  if (!g || g.secret == null) return null;
  const box = el("div", "cr-secret");
  box.appendChild(el("span", "cr-secret-label", g.mode === "words" ? "The word" : "The code"));
  if (g.mode === "words") {
    const tiles = el("span", "cr-tiles");
    String(g.secret)
      .split("")
      .forEach((c) => tiles.appendChild(el("span", "cr-tile g", c.toUpperCase())));
    box.appendChild(tiles);
  } else {
    const pegs = el("span", "cr-pegs");
    (g.secret as string[]).forEach((k) => pegs.appendChild(pegEl(crPalette(g), k)));
    box.appendChild(pegs);
  }
  return box;
}

/* A racer's lane: name, status, and their rounds. Yours carries your
   guesses (and the sealed one for this round); a rival's carries only
   feedback while the race runs. */
export function crLane(g: GL, p: GL, opts?: { me?: string; compact?: boolean; place?: number }): HTMLElement {
  const mine = !!(opts && opts.me && p.name === opts.me);
  const compact = !!(opts && opts.compact);
  const lane = el("div", "cr-lane" + (mine ? " mine" : "") + (p.solved ? " solved" : "") + (p.out ? " out" : "") + (compact ? " compact" : ""));
  lane.style.setProperty("--who", p.hex || "#94a3b8");
  const head = el("div", "cr-lane-head");
  if (opts && opts.place) head.appendChild(el("span", "cr-place", opts.place === 1 ? "🏆" : "#" + opts.place));
  const dot = el("span", "hist-dot");
  dot.style.background = p.hex;
  head.appendChild(dot);
  head.appendChild(el("span", "cr-lane-name", p.name + (mine ? " (you)" : "")));
  head.appendChild(el("span", "cr-lane-st", crStatus(g, p)));
  lane.appendChild(head);
  const rows = el("div", "cr-rows");
  ((g.rounds || []) as GL[]).forEach((r: GL) => {
    const x = (r.guesses || {})[p.name];
    if (!x) return;
    rows.appendChild(guessRow(g, r.n, x.guess || null, x.fb, { cracked: (r.solved || []).indexOf(p.name) >= 0 }));
  });
  if (mine && g.status === "running" && g.you && g.you.queued) rows.appendChild(guessRow(g, g.round, g.you.queued, null, { sealed: true }));
  if (!rows.childNodes.length) rows.appendChild(el("div", "cr-none", g.status === "running" ? "No guesses yet" : "No guesses"));
  lane.appendChild(rows);
  return lane;
}

/* The board: the viewer's lane first, then the rivals (in place order
   once the race is over). */
export function crBoard(g: GL, opts?: { me?: string; compact?: boolean }): HTMLElement {
  const board = el("div", "cr-board" + (opts && opts.compact ? " compact" : ""));
  const me = opts && opts.me;
  let ps: GL[] = ((g && g.players) || []).slice();
  const places: string[] | null = Array.isArray(g.places) ? g.places : null;
  if (places) ps.sort((a, b) => places.indexOf(a.name) - places.indexOf(b.name));
  else if (me) ps = ps.filter((p) => p.name === me).concat(ps.filter((p) => p.name !== me));
  ps.forEach((p) => board.appendChild(crLane(g, p, { me, compact: opts && opts.compact, place: places ? places.indexOf(p.name) + 1 : undefined })));
  return board;
}

/* The guess input. Colors: tap a colour to fill the next slot, tap a
   slot to clear it; Random and Clear; Guess once every slot is set.
   Words: type the word (the server checks it is in the list). The draft
   lives with the caller so a repaint never wipes it. */
export function crInput(g: GL, draft: string, onDraft: (v: string) => void, onCommit: (v: string) => void, onType?: (v: string) => void): HTMLElement {
  const wrap = el("div", "cr-input" + (g.you && g.you.queued ? "" : " your-move"));
  const queued: string | null = (g.you && g.you.queued) || null;
  const len = g.length || (g.mode === "words" ? 5 : 4);
  const head = el("div", "cr-input-head");
  head.appendChild(el("span", "cr-input-title", queued ? "Your guess is in" : "Your guess · round " + g.round));
  if (g.mode !== "words") head.appendChild(el("span", "cr-legend", "● right place  ○ right colour"));
  wrap.appendChild(head);
  const same = !!queued && queued.toLowerCase() === draft.toLowerCase();
  const go = el("button", "duel-btn cr-go", same ? "Guessed ✓" : queued ? "Change guess" : "Guess") as HTMLButtonElement;
  go.type = "button";
  if (g.mode === "words") {
    const row = el("div", "cr-word-row");
    const inp = el("input", "cr-word") as HTMLInputElement;
    inp.type = "text";
    inp.maxLength = len;
    inp.size = len;
    inp.value = draft.toUpperCase();
    inp.placeholder = "?".repeat(len);
    inp.autocomplete = "off";
    inp.spellcheck = false;
    inp.setAttribute("autocapitalize", "characters");
    inp.setAttribute("aria-label", "Your " + len + "-letter guess");
    inp.addEventListener("input", () => {
      const v = inp.value.replace(/[^a-z]/gi, "").slice(0, len).toLowerCase();
      // keep typing smooth: the draft is saved without a repaint (a
      // repaint would rebuild the field); only the button follows
      if (onType) onType(v);
      go.disabled = v.length !== len || (!!queued && queued === v);
      go.textContent = queued && queued === v ? "Guessed ✓" : queued ? "Change guess" : "Guess";
    });
    inp.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !go.disabled) {
        e.preventDefault();
        onCommit(inp.value.replace(/[^a-z]/gi, "").slice(0, len).toLowerCase());
      }
    });
    row.appendChild(inp);
    go.disabled = draft.length !== len || same;
    go.addEventListener("click", () => onCommit(inp.value.replace(/[^a-z]/gi, "").slice(0, len).toLowerCase()));
    row.appendChild(go);
    wrap.appendChild(row);
    return wrap;
  }
  const pal = crPalette(g);
  const keys = draft.toUpperCase().split("").slice(0, len);
  const slots = el("div", "cr-slots");
  for (let i = 0; i < len; i++) {
    const k = keys[i] || null;
    const b = el("button", "cr-slot") as HTMLButtonElement;
    b.type = "button";
    b.appendChild(pegEl(pal, k));
    b.setAttribute("aria-label", "Slot " + (i + 1) + ": " + (k ? (pal.find((c) => c.k === k) || { name: k }).name + " - tap to clear" : "empty"));
    b.disabled = !k;
    b.addEventListener("click", () => {
      const next = keys.slice();
      next.splice(i, 1);
      onDraft(next.join(""));
    });
    slots.appendChild(b);
  }
  wrap.appendChild(slots);
  const palRow = el("div", "cr-palette");
  pal.forEach((c) => {
    const b = el("button", "cr-color") as HTMLButtonElement;
    b.type = "button";
    b.style.setProperty("--peg", c.hex);
    b.textContent = c.k;
    b.title = c.name;
    b.setAttribute("aria-label", "Add " + c.name);
    b.disabled = keys.length >= len;
    b.addEventListener("click", () => onDraft((keys.join("") + c.k).slice(0, len)));
    palRow.appendChild(b);
  });
  wrap.appendChild(palRow);
  const acts = el("div", "cr-acts");
  const quick = (label: string, fn: () => string) => {
    const b = el("button", "duel-btn quiet sm", label) as HTMLButtonElement;
    b.type = "button";
    b.addEventListener("click", () => onDraft(fn()));
    acts.appendChild(b);
  };
  quick("Random", () => Array.from({ length: len }, () => (pal[Math.floor(Math.random() * pal.length)] || { k: "R" }).k).join(""));
  quick("Clear", () => "");
  go.disabled = keys.length !== len || same;
  go.addEventListener("click", () => onCommit(keys.join("")));
  acts.appendChild(go);
  wrap.appendChild(acts);
  return wrap;
}

/* History: a row per round - each racer's feedback (and guess, when the
   viewer may see it), who cracked it. */
export function crHistoryRows(g: GL, row: (idx: string) => HTMLElement, who: (p: GL) => HTMLElement, list: HTMLElement): number {
  let n = 0;
  const players: GL[] = g.players || [];
  ((g.rounds || []) as GL[]).forEach((r: GL) => {
    n++;
    const rw = row("Round " + r.n);
    players.forEach((p: GL) => {
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

/* The card: the race as compact lanes (latest feedback per racer), and
   the secret once it's over. */
export function crCardBoard(g: GL, me?: string): HTMLElement {
  const wrap = el("div", "cr-card");
  const what = g.mode === "words" ? (g.length || 5) + "-letter word" : (g.length || 4) + " pegs · " + (g.colors || 6) + " colours";
  wrap.appendChild(el("div", "cr-card-cap", what + (g.status === "running" ? " · round " + g.round + " of " + (g.max_rounds || "?") : "")));
  const s = crSecretEl(g);
  if (s) wrap.appendChild(s);
  const list = el("div", "cr-card-list");
  let ps: GL[] = ((g && g.players) || []).slice();
  const places: string[] | null = Array.isArray(g.places) ? g.places : null;
  if (places) ps.sort((a, b) => places.indexOf(a.name) - places.indexOf(b.name));
  ps.forEach((p) => {
    const line = el("div", "cr-card-row" + (p.solved ? " solved" : "") + (p.out ? " out" : ""));
    const dot = el("span", "hist-dot");
    dot.style.background = p.hex;
    line.appendChild(dot);
    line.appendChild(el("span", "cr-card-name", p.name + (me && p.name === me ? " (you)" : "")));
    let last: GL = null;
    ((g.rounds || []) as GL[]).forEach((r) => {
      const x = (r.guesses || {})[p.name];
      if (x) last = x;
    });
    if (last) line.appendChild(crFeedbackEl(g, last.fb, last.guess || null));
    line.appendChild(el("span", "cr-card-st", crStatus(g, p)));
    list.appendChild(line);
  });
  wrap.appendChild(list);
  return wrap;
}
