import { el } from "../lib";
import type { GL } from "./render";

/* Letter Grid in the DOM (2026-11-20): the scoreboard, the word panel
   under the scene (type a word or tap tiles in the scene; the path is
   traced live and shown as cells), the last round's words, the history
   and the chat card. The grid itself is the 3D scene - the card keeps a
   small flat thumbnail, like every card. Words are sealed until the
   round resolves (the server sends only your own, in you.queued). */

export type LgDraft = { round: number; word: string; path: number[][] | null; tapped: boolean };

export const lgLabel = (r: number, c: number) => String.fromCharCode(65 + c) + (r + 1);

export function lgLastRound(g: GL): GL | null {
  const rs: GL[] = (g && g.rounds) || [];
  return rs.length ? rs[rs.length - 1] : null;
}

const touches = (a: number[], b: number[]) => Math.abs(a[0]! - b[0]!) <= 1 && Math.abs(a[1]! - b[1]!) <= 1;

/* Every way to trace `word` (up to cap), in the server's search order, so
   the best pick below is the path the server would take. */
function paths(grid: string[], word: string, cap: number): number[][][] {
  const n = grid.length;
  const out: number[][][] = [];
  const path: number[][] = [];
  const seen = new Array(n * n).fill(false);
  const walk = (r: number, c: number, i: number) => {
    if (out.length >= cap || grid[r]![c] !== word[i]) return;
    seen[r * n + c] = true;
    path.push([r, c]);
    if (i === word.length - 1) out.push(path.slice());
    else
      for (let dr = -1; dr <= 1; dr++)
        for (let dc = -1; dc <= 1; dc++) {
          const rr = r + dr,
            cc = c + dc;
          if ((dr || dc) && rr >= 0 && cc >= 0 && rr < n && cc < n && !seen[rr * n + cc]) walk(rr, cc, i + 1);
        }
    seen[r * n + c] = false;
    path.pop();
  };
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) walk(r, c, 0);
  return out;
}

/* The path that claims the most free cells, as the claims stand (the
   server's rule for a word sent without one), or null. */
export function lgTrace(g: GL, word: string): number[][] | null {
  const grid: string[] = g.grid || [];
  if (!word || !grid.length) return null;
  const n = grid.length;
  const claims: (string | null)[] = g.claims || [];
  const all = paths(grid, word, 64);
  if (!all.length) return null;
  const free = (p: number[][]) => p.filter(([r, c]) => !claims[r! * n + c!]).length;
  return all.reduce((a, b) => (free(b) > free(a) ? b : a));
}

/* A tap on a tile: extend the path when it touches the last cell and is
   unused, step back when it is the last cell, or start over there. */
export function lgTap(g: GL, d: LgDraft, r: number, c: number): LgDraft {
  const grid: string[] = g.grid || [];
  const cur = d.path && d.tapped ? d.path : [];
  const last = cur[cur.length - 1];
  let next: number[][];
  if (last && last[0] === r && last[1] === c) next = cur.slice(0, -1);
  else if (last && touches(last, [r, c]) && !cur.some(([a, b]) => a === r && b === c)) next = cur.concat([[r, c]]);
  else next = [[r, c]];
  const word = next.map(([a, b]) => grid[a!]![b!]).join("");
  return { round: d.round, word: word, path: next.length ? next : null, tapped: next.length > 0 };
}

/* The move text: the word and its cells. */
export function lgDir(d: LgDraft): string {
  return d.word + (d.path ? " " + d.path.map(([r, c]) => lgLabel(r!, c!)).join(" ") : "");
}

function status(g: GL, p: GL): string {
  if (p.out) return "out";
  if (g.status === "running") return p.committed ? "word in ✓" : "thinking…";
  return "";
}

/* The scoreboard, highest first: cells claimed beside the score. */
export function lgScores(g: GL, me?: string, compact?: boolean): HTMLElement {
  const box = el("div", "lg-scores" + (compact ? " compact" : ""));
  const ps: GL[] = ((g && g.players) || []).slice().sort((a: GL, b: GL) => (b.score || 0) - (a.score || 0) || (b.cells || 0) - (a.cells || 0) || (a.name < b.name ? -1 : 1));
  ps.forEach((p: GL, i: number) => {
    const row = el("div", "lg-row" + (p.out ? " out" : "") + (me && p.name === me ? " mine" : ""));
    row.style.setProperty("--who", p.hex || "#94a3b8");
    row.appendChild(el("span", "lg-rank", String(i + 1)));
    const d = el("span", "hist-dot");
    d.style.background = p.hex;
    row.appendChild(d);
    row.appendChild(el("span", "lg-name", p.name + (me && p.name === me ? " (you)" : "")));
    const cells = el("span", "lg-cells", "▦ " + (p.cells || 0));
    cells.title = (p.cells || 0) + " cells claimed";
    row.appendChild(cells);
    const st = compact ? "" : status(g, p);
    if (st) row.appendChild(el("span", "lg-st", st));
    row.appendChild(el("span", "lg-score", String(p.score || 0)));
    box.appendChild(row);
  });
  return box;
}

/* The word panel: an input (typing traces the best path), the path as
   cells, what it would score, Send and Clear. Typing updates the panel
   in place (no rebuild, so the field keeps focus) and tells the scene
   through onDraft; a tap in the scene comes back through setDraft. */
export type LgPanel = { el: HTMLElement; input: HTMLInputElement; setDraft: (d: LgDraft) => void };
export function lgPanel(g: GL, draft: LgDraft, onDraft: (d: LgDraft) => void, onSend: (d: LgDraft) => void): LgPanel {
  const n: number = g.size || 5;
  const min: number = g.min_len || 3;
  const claims: (string | null)[] = g.claims || [];
  const played: string[] = (g.you && g.you.played) || [];
  const box = el("div", "lg-panel");
  const row = el("div", "lg-word-row");
  const input = el("input", "lg-word") as HTMLInputElement;
  input.type = "text";
  input.placeholder = "Type a word, or tap the tiles";
  input.maxLength = n * n;
  input.autocomplete = "off";
  input.spellcheck = false;
  input.setAttribute("autocapitalize", "characters");
  input.setAttribute("aria-label", "Your word");
  const send = el("button", "btn lg-send", "Send") as HTMLButtonElement;
  send.type = "button";
  const clear = el("button", "btn sm lg-clear", "Clear") as HTMLButtonElement;
  clear.type = "button";
  row.appendChild(input);
  row.appendChild(send);
  row.appendChild(clear);
  box.appendChild(row);
  const trace = el("div", "lg-trace");
  trace.setAttribute("aria-live", "polite");
  box.appendChild(trace);
  let cur = draft;
  const paint = () => {
    const w = cur.word;
    if (input.value.toLowerCase() !== w) input.value = w.toUpperCase();
    trace.textContent = "";
    let ok = false;
    if (!w) trace.appendChild(el("span", "lg-hint", "Letters must touch in order - across, up, down or diagonal - each tile once. " + min + "+ letters."));
    else if (!cur.path) trace.appendChild(el("span", "lg-bad", w.toUpperCase() + " can't be traced on this grid"));
    else if (w.length < min) trace.appendChild(el("span", "lg-hint", "At least " + min + " letters"));
    else if (played.indexOf(w) >= 0) trace.appendChild(el("span", "lg-bad", "You've played " + w.toUpperCase() + " already"));
    else ok = true;
    if (cur.path && w) {
      const cells = el("span", "lg-cellrow");
      cur.path.forEach(([r, c], i) => {
        const k = r! * n + c!;
        const chip = el("span", "lg-cell" + (claims[k] ? " taken" : " free"), (w[i] || "").toUpperCase() + " " + lgLabel(r!, c!));
        cells.appendChild(chip);
      });
      trace.appendChild(cells);
      if (ok) {
        const free = cur.path.filter(([r, c]) => !claims[r! * n + c!]).length;
        trace.appendChild(el("span", "lg-preview", "+" + w.length + (free ? " · +" + free + (free === 1 ? " cell" : " cells") + " if nobody else takes " + (free === 1 ? "it" : "them") : "")));
      }
    }
    send.disabled = !ok;
  };
  input.addEventListener("input", () => {
    const w = input.value.toLowerCase().replace(/[^a-z]/g, "");
    cur = { round: cur.round, word: w, path: w ? lgTrace(g, w) : null, tapped: false };
    paint();
    onDraft(cur);
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !send.disabled) {
      e.preventDefault();
      onSend(cur);
    }
  });
  send.addEventListener("click", () => {
    if (!send.disabled) onSend(cur);
  });
  clear.addEventListener("click", () => {
    cur = { round: cur.round, word: "", path: null, tapped: false };
    paint();
    onDraft(cur);
  });
  paint();
  return {
    el: box,
    input,
    setDraft: (d: LgDraft) => {
      cur = d;
      paint();
    },
  };
}

/* Your sealed word, and the words you've played. */
export function lgYours(g: GL): HTMLElement | null {
  const you = g.you || {};
  const played: string[] = you.played || [];
  if (!you.playing || (!you.queued && !played.length)) return null;
  const box = el("div", "lg-yours");
  if (you.queued) box.appendChild(el("div", "lg-queued", "Your word is in: " + String(you.queued.word).toUpperCase() + " - you can change it until the round resolves."));
  if (played.length) {
    const chips = el("div", "lg-played");
    chips.appendChild(el("span", "lg-played-cap", "Played:"));
    played.forEach((w) => chips.appendChild(el("span", "lg-chip", w.toUpperCase())));
    box.appendChild(chips);
  }
  return box;
}

/* One round's words, best first: the word, its points, and what happened
   to its cells. */
export function lgReveal(g: GL, round: GL | null, me?: string): HTMLElement | null {
  if (!round) return null;
  const box = el("div", "lg-reveal");
  box.appendChild(el("div", "fl-cap", "Round " + round.n + " · the words"));
  const players: GL[] = g.players || [];
  const names = players.map((p: GL) => p.name).filter((nm: string) => (round.words || {})[nm] || (round.missed || []).indexOf(nm) >= 0);
  names.sort((a: string, b: string) => ((round.points || {})[b] || 0) - ((round.points || {})[a] || 0) || (a < b ? -1 : 1));
  names.forEach((nm: string) => {
    const p = players.find((x: GL) => x.name === nm) || { name: nm, hex: "#94a3b8" };
    const w = (round.words || {})[nm];
    const row = el("div", "lg-rv" + (me && nm === me ? " mine" : ""));
    row.style.setProperty("--who", p.hex || "#94a3b8");
    const d = el("span", "hist-dot");
    d.style.background = p.hex;
    row.appendChild(d);
    row.appendChild(el("span", "lg-rv-name", nm));
    if (!w) {
      row.appendChild(el("span", "lg-rv-word none", "no word"));
      row.appendChild(el("span", "lg-rv-pts", "+0"));
    } else {
      row.appendChild(el("span", "lg-rv-word", String(w.word).toUpperCase()));
      const notes: string[] = [];
      if (w.dup) notes.push("shared word - no claims");
      else if (w.bonus) notes.push("+" + w.bonus + (w.bonus === 1 ? " cell" : " cells"));
      if ((w.contested || []).length) notes.push((w.contested.length === 1 ? "1 cell" : w.contested.length + " cells") + " contested");
      if (notes.length) row.appendChild(el("span", "lg-rv-note", notes.join(" · ")));
      row.appendChild(el("span", "lg-rv-pts", "+" + ((round.points || {})[nm] || 0)));
    }
    box.appendChild(row);
  });
  return box;
}

/* The end: the grid's longest words, which nobody may have found. */
export function lgTopWords(g: GL): HTMLElement | null {
  const top: string[] = g.top_words || [];
  if (!top.length) return null;
  const box = el("div", "lg-top");
  box.appendChild(el("span", "lg-played-cap", "The grid's longest words:"));
  top.slice(0, 6).forEach((w) => box.appendChild(el("span", "lg-chip", w.toUpperCase())));
  if (g.word_count) box.appendChild(el("span", "lg-played-cap", "(" + g.word_count + " words in all)"));
  return box;
}

export function lgHistoryRows(g: GL, row: (idx: string) => HTMLElement, who: (p: GL) => HTMLElement, list: HTMLElement): number {
  let n = 0;
  const players: GL[] = g.players || [];
  ((g.rounds || []) as GL[]).forEach((r: GL) => {
    n++;
    const rw = row("Round " + r.n);
    players.forEach((p: GL) => {
      const w = (r.words || {})[p.name];
      const missed = (r.missed || []).indexOf(p.name) >= 0;
      if (!w && !missed) return;
      const seg = el("span", "hist-seg");
      seg.appendChild(who(p));
      seg.appendChild(el("span", "hist-act", w ? String(w.word).toUpperCase() + " +" + ((r.points || {})[p.name] || 0) + (w.dup ? " (shared)" : w.bonus ? " · ▦" + w.bonus : "") : "no word"));
      rw.appendChild(seg);
    });
    list.appendChild(rw);
  });
  return n;
}

/* The card: a small flat grid (claims in their owner's colour), the
   scores, and the last round's best word. */
export function lgCardBoard(g: GL, me?: string): HTMLElement {
  const wrap = el("div", "lg-card");
  const grid: string[] = g.grid || [];
  const n = grid.length;
  const claims: (string | null)[] = g.claims || [];
  const hexOf: Record<string, string> = {};
  (g.players || []).forEach((p: GL) => (hexOf[p.name] = p.hex));
  if (n) {
    const mini = el("div", "lg-mini");
    mini.style.gridTemplateColumns = "repeat(" + n + ", 1fr)";
    for (let r = 0; r < n; r++)
      for (let c = 0; c < n; c++) {
        const owner = claims[r * n + c];
        const cell = el("span", "lg-mini-cell" + (owner ? " owned" : ""), (grid[r]![c] || "").toUpperCase());
        if (owner) cell.style.setProperty("--who", hexOf[owner] || "#94a3b8");
        mini.appendChild(cell);
      }
    wrap.appendChild(mini);
  }
  const side = el("div", "lg-card-side");
  side.appendChild(lgScores(g, me, true));
  const last = lgLastRound(g);
  let cap = "";
  if (last) {
    const best = Object.keys(last.words || {}).sort((a, b) => ((last.points || {})[b] || 0) - ((last.points || {})[a] || 0))[0];
    if (best) cap = "Round " + last.n + ": " + String(last.words[best].word).toUpperCase() + " (" + best + ", +" + ((last.points || {})[best] || 0) + ")";
  } else if (g.status === "running") cap = "Round " + g.round + " · words sealed";
  if (cap) side.appendChild(el("div", "lg-card-cap", cap));
  wrap.appendChild(side);
  return wrap;
}
