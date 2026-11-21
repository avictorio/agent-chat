import { el } from "../../../lib/index";
import type { GL } from "../shared/render";

/* Frontlines in the DOM (2026-11-19): the field as a board (card and
   arena), the troop planner a commander fills in, and the round
   history. The server rules: five hills A-E, 100 troops a round, each
   hill to the bigger army, the round to more hills held (or, valued
   hills, more points). A split is secret until the round resolves, so
   the field shows the last RESOLVED round, plus only your own pending
   split - never a rival's. */

export const FL_HILLS = 5;
export const FL_TROOPS = 100;
const LETTERS = ["A", "B", "C", "D", "E"];

export function flLastRound(g: GL): GL | null {
  const rs: GL[] = (g && g.rounds) || [];
  return rs.length ? rs[rs.length - 1] : null;
}

function hexOf(g: GL, name: string | null | undefined): string {
  const p = ((g && g.players) || []).filter((x: GL) => x.name === name)[0];
  return (p && p.hex) || "#94a3b8";
}

/* The field: one column per hill. A resolved round shows both armies as
   bars (longest bar = 100 troops), the hill's winner flagged in their
   colour, a level hill marked level. Before any round has resolved it
   shows the empty field (and, for the viewer, their own sealed split). */
export function flField(g: GL, opts?: { compact?: boolean; round?: GL | null; me?: string }): HTMLElement {
  const compact = !!(opts && opts.compact);
  const round = opts && opts.round !== undefined ? opts.round : flLastRound(g);
  const players: GL[] = (g && g.players) || [];
  const values: number[] | null = round && round.values ? round.values : g && g.variant === "valued" ? g.values || null : null;
  const mine = g && g.you && g.you.playing && Array.isArray(g.you.queued) ? (g.you.queued as number[]) : null;
  const field = el("div", "fl-field" + (compact ? " compact" : ""));
  field.setAttribute("role", "group");
  field.setAttribute("aria-label", round ? "Round " + round.n + " on the field" : "The field");
  for (let i = 0; i < FL_HILLS; i++) {
    const hill = el("div", "fl-hill");
    const head = el("div", "fl-hill-head");
    head.appendChild(el("span", "fl-hill-name", LETTERS[i]));
    if (values) head.appendChild(el("span", "fl-hill-val", values[i] + (values[i] === 1 ? " pt" : " pts")));
    hill.appendChild(head);
    const owner = round && round.hills ? round.hills[i] : undefined;
    if (round && round.hills) {
      players.forEach((p: GL) => {
        const n = ((round.alloc || {})[p.name] || [])[i] || 0;
        const bar = el("div", "fl-bar" + (owner === p.name ? " won" : ""));
        const fill = el("span", "fl-fill");
        fill.style.width = Math.max(n ? 4 : 0, n) + "%";
        fill.style.background = p.hex;
        bar.appendChild(fill);
        bar.appendChild(el("span", "fl-n", String(n)));
        bar.title = p.name + ": " + n + " troops";
        hill.appendChild(bar);
      });
      const flag = el("div", "fl-flag" + (owner ? "" : " level"), owner ? (compact ? "" : owner) : "level");
      if (owner) {
        flag.style.setProperty("--flag-c", hexOf(g, owner));
        flag.setAttribute("aria-label", "taken by " + owner);
      }
      hill.appendChild(flag);
      if (owner) hill.style.setProperty("--hill-c", hexOf(g, owner));
      hill.classList.add(owner ? "taken" : "level");
    } else if (mine) {
      // your own sealed split (the rival's is never on this page)
      const bar = el("div", "fl-bar mine");
      const fill = el("span", "fl-fill");
      fill.style.width = (mine[i] || 0) + "%";
      fill.style.background = hexOf(g, opts && opts.me);
      bar.appendChild(fill);
      bar.appendChild(el("span", "fl-n", String(mine[i] || 0)));
      hill.appendChild(bar);
      hill.appendChild(el("div", "fl-flag sealed", "sealed"));
    } else hill.appendChild(el("div", "fl-flag open", "?"));
    field.appendChild(hill);
  }
  if (round && round.hills && !compact) {
    const sum = el("div", "fl-sum");
    players.forEach((p: GL) => {
      const s = el("span", "fl-sum-p");
      s.style.color = p.hex;
      const k = values ? (round.points || {})[p.name] || 0 : (round.held || {})[p.name] || 0;
      s.textContent = p.name + " " + k + (values ? " pts" : k === 1 ? " hill" : " hills");
      sum.appendChild(s);
    });
    sum.appendChild(el("span", "fl-sum-v", round.winner ? round.winner + " takes round " + round.n : round.forfeit ? "" : "Round " + round.n + " is level"));
    if (round.forfeit) sum.appendChild(el("span", "fl-sum-v", round.winner + " takes round " + round.n + " by forfeit"));
    field.appendChild(sum);
  }
  return field;
}

/* The planner: a row per hill (minus, the number, plus, a bar), what is
   left to place, Even / Random / Clear, and Lock in once the split adds
   up to 100. The draft lives with the caller so a repaint (a poll, the
   rival committing) never wipes a half-made plan. */
export function flPlanner(
  g: GL,
  draft: number[],
  onDraft: (v: number[]) => void,
  onCommit: (v: number[]) => void
): HTMLElement {
  const wrap = el("div", "fl-plan" + (g.you && g.you.queued ? "" : " your-move"));
  const queued: number[] | null = Array.isArray(g.you && g.you.queued) ? g.you.queued : null;
  const values: number[] | null = g.variant === "valued" ? g.values || null : null;
  const total = draft.reduce((a, b) => a + b, 0);
  const left = FL_TROOPS - total;
  const head = el("div", "fl-plan-head");
  head.appendChild(el("span", "fl-plan-title", queued ? "Your split is in" : "Split your " + FL_TROOPS + " troops"));
  const lefty = el("span", "fl-left" + (left === 0 ? " ok" : left < 0 ? " over" : ""), left === 0 ? "All " + FL_TROOPS + " placed" : left > 0 ? left + " left to place" : -left + " too many");
  lefty.setAttribute("aria-live", "polite");
  head.appendChild(lefty);
  wrap.appendChild(head);
  const set = (i: number, v: number) => {
    const next = draft.slice();
    next[i] = Math.max(0, Math.min(FL_TROOPS, Math.round(v) || 0));
    onDraft(next);
  };
  for (let i = 0; i < FL_HILLS; i++) {
    const cur = draft[i] ?? 0;
    const row = el("div", "fl-row");
    const lab = el("span", "fl-row-name", LETTERS[i]);
    if (values) lab.appendChild(el("span", "fl-hill-val", values[i] + (values[i] === 1 ? " pt" : " pts")));
    row.appendChild(lab);

    const minus = el("button", "fl-step", "−") as HTMLButtonElement;
    minus.type = "button";
    minus.setAttribute("aria-label", "5 fewer on hill " + LETTERS[i]);
    minus.disabled = cur <= 0;
    minus.addEventListener("click", () => set(i, cur - 5));
    row.appendChild(minus);
    const inp = el("input", "fl-num") as HTMLInputElement;
    inp.type = "number";
    inp.inputMode = "numeric";
    inp.min = "0";
    inp.max = String(FL_TROOPS);
    inp.value = String(cur);
    inp.setAttribute("aria-label", "Troops on hill " + LETTERS[i]);
    inp.addEventListener("change", () => set(i, Number(inp.value)));
    row.appendChild(inp);
    const plus = el("button", "fl-step", "+") as HTMLButtonElement;
    plus.type = "button";
    plus.setAttribute("aria-label", "5 more on hill " + LETTERS[i]);
    plus.disabled = left <= 0;
    plus.addEventListener("click", () => set(i, cur + Math.min(5, Math.max(0, left))));
    row.appendChild(plus);
    const bar = el("span", "fl-row-bar");
    const fill = el("span", "fl-fill");
    fill.style.width = Math.min(100, cur) + "%";
    bar.appendChild(fill);
    row.appendChild(bar);
    wrap.appendChild(row);
  }
  const acts = el("div", "fl-acts");
  const quick = (label: string, fn: () => number[]) => {
    const b = el("button", "duel-btn quiet sm", label) as HTMLButtonElement;
    b.type = "button";
    b.addEventListener("click", () => onDraft(fn()));
    acts.appendChild(b);
  };
  quick("Even", () => [20, 20, 20, 20, 20]);
  quick("Random", () => {
    const w = Array.from({ length: FL_HILLS }, () => Math.random() + 0.05);
    const t = w.reduce((a, b) => a + b, 0);
    const out = w.map((x) => Math.floor((x / t) * FL_TROOPS));
    let r = FL_TROOPS - out.reduce((a, b) => a + b, 0);
    for (let k = 0; r > 0; k = (k + 1) % FL_HILLS, r--) out[k]!++;
    return out;
  });
  quick("Clear", () => [0, 0, 0, 0, 0]);
  const same = !!queued && queued.join(",") === draft.join(",");
  const go = el("button", "duel-btn fl-go", same ? "Locked in ✓" : queued ? "Update split" : "Lock in") as HTMLButtonElement;
  go.type = "button";
  go.disabled = left !== 0 || same;
  go.addEventListener("click", () => onCommit(draft.slice()));
  acts.appendChild(go);
  wrap.appendChild(acts);
  return wrap;
}

/* History: one row per round - both splits, the hills each took, the
   round's winner. */
export function flHistoryRows(g: GL, row: (idx: string) => HTMLElement, who: (p: GL) => HTMLElement, list: HTMLElement): number {
  let n = 0;
  const players: GL[] = g.players || [];
  ((g.rounds || []) as GL[]).forEach((r: GL) => {
    n++;
    const rw = row("Round " + r.n);
    players.forEach((p: GL) => {
      const seg = el("span", "hist-seg");
      seg.appendChild(who(p));
      const a = (r.alloc || {})[p.name];
      const held = (r.held || {})[p.name];
      seg.appendChild(el("span", "hist-act", a ? a.join("/") + (held != null ? " · " + held + (held === 1 ? " hill" : " hills") : "") : "— no split"));
      rw.appendChild(seg);
    });
    if (r.winner) {
      const pill = el("span", "hist-pill win", r.winner + (r.forfeit ? " by forfeit" : " takes it"));
      pill.style.borderColor = hexOf(g, r.winner);
      pill.style.color = hexOf(g, r.winner);
      rw.appendChild(pill);
    } else rw.appendChild(el("span", "hist-pill tie", "Level"));
    list.appendChild(rw);
  });
  return n;
}

/* Frontlines on a card: the score line and the last resolved round on a
   compact field (hills tinted by who took them). */
export function flCardBoard(g: GL): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "fl-card";
  const top = document.createElement("div");
  top.className = "fl-card-score";
  (g.players || []).forEach((p: GL, i: number) => {
    if (i) top.appendChild(document.createTextNode(" – "));
    const s = document.createElement("span");
    s.style.color = p.hex;
    s.textContent = p.name + " " + (p.wins || 0);
    top.appendChild(s);
  });
  wrap.appendChild(top);
  const last = flLastRound(g);
  wrap.appendChild(flField(g, { compact: true, round: last }));
  const cap = document.createElement("div");
  cap.className = "fl-card-cap";
  cap.textContent = last ? "Round " + last.n + (last.winner ? " to " + last.winner : " level") : g.status === "running" ? "Round " + g.round + " · splits sealed" : "";
  wrap.appendChild(cap);
  return wrap;
}
