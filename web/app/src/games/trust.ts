import { el } from "../lib";
import type { GL } from "./render";

/* Trust in the DOM (2026-11-19): the scoreboard, the choices you make
   (one Cooperate / Defect pair per rival), the round's who-trusted-whom
   grid, and the history. Every pairing scores on its own: both C 3
   each, D against C 5 to 0, both D 1 each. Pending choices are secret
   (the server sends only your own); resolved rounds are public. C and
   D carry a word and a mark as well as a colour. */

export type TrDraft = Record<string, "C" | "D">;

const MARK = { C: "✓", D: "✗" } as const;

export function trLastRound(g: GL): GL | null {
  const rs: GL[] = (g && g.rounds) || [];
  return rs.length ? rs[rs.length - 1] : null;
}

function rate(p: GL): string {
  return p.coop == null ? "–" : Math.round(p.coop * 100) + "%";
}

export function trStatus(g: GL, p: GL): string {
  if (p.out) return "out";
  if (g.status === "running") return p.committed ? "chosen ✓" : "thinking…";
  return "";
}

/* The scoreboard, highest first, with each player's share of C given. */
export function trScores(g: GL, me?: string, compact?: boolean): HTMLElement {
  const box = el("div", "tr-scores" + (compact ? " compact" : ""));
  const ps: GL[] = ((g && g.players) || []).slice().sort((a: GL, b: GL) => (b.score || 0) - (a.score || 0) || (a.name < b.name ? -1 : 1));
  ps.forEach((p: GL, i: number) => {
    const row = el("div", "tr-row" + (p.out ? " out" : "") + (me && p.name === me ? " mine" : ""));
    row.style.setProperty("--who", p.hex || "#94a3b8");
    row.appendChild(el("span", "tr-rank", String(i + 1)));
    const d = el("span", "hist-dot");
    d.style.background = p.hex;
    row.appendChild(d);
    row.appendChild(el("span", "tr-name", p.name + (me && p.name === me ? " (you)" : "")));
    if (!compact) {
      const bar = el("span", "tr-coop");
      bar.title = "Cooperated " + rate(p) + " of the time";
      const fill = el("span", "tr-coop-fill");
      fill.style.width = (p.coop == null ? 0 : Math.round(p.coop * 100)) + "%";
      bar.appendChild(fill);
      row.appendChild(bar);
      row.appendChild(el("span", "tr-coop-n", "🤝 " + rate(p)));
    }
    const st = trStatus(g, p);
    if (st) row.appendChild(el("span", "tr-st", st));
    row.appendChild(el("span", "tr-score", String(p.score || 0)));
    box.appendChild(row);
  });
  return box;
}

/* Who trusted whom in one round: rows choose, columns receive. */
export function trGrid(g: GL, round: GL | null, me?: string): HTMLElement {
  const wrap = el("div", "tr-grid-wrap");
  if (!round) {
    wrap.appendChild(el("div", "tr-grid-empty", "No round has resolved yet - choices are revealed together."));
    return wrap;
  }
  const names: string[] = ((g && g.players) || []).map((p: GL) => p.name).filter((n: string) => (round.moves || {})[n]);
  const hexOf = (n: string) => (((g && g.players) || []).find((p: GL) => p.name === n) || { hex: "#94a3b8" }).hex;
  const t = el("table", "tr-grid");
  t.setAttribute("aria-label", "Round " + round.n + ": who cooperated with whom");
  const head = el("tr", "");
  head.appendChild(el("th", "tr-corner", "→"));
  names.forEach((n) => {
    const th = el("th", "tr-col", n);
    th.style.color = hexOf(n);
    head.appendChild(th);
  });
  head.appendChild(el("th", "tr-pts-h", "+pts"));
  t.appendChild(head);
  names.forEach((from) => {
    const tr = el("tr", me && from === me ? "mine" : "");
    const th = el("th", "tr-from", from);
    th.style.color = hexOf(from);
    tr.appendChild(th);
    names.forEach((to) => {
      if (to === from) {
        tr.appendChild(el("td", "tr-self", ""));
        return;
      }
      const c = ((round.moves || {})[from] || {})[to] as "C" | "D" | undefined;
      const missed = (round.missed || []).indexOf(from) >= 0;
      const td = el("td", "tr-cell " + (c === "C" ? "c" : "d") + (missed ? " missed" : ""), c ? MARK[c] : "");
      td.title = from + (c === "C" ? " cooperated with " : " defected on ") + to + (missed ? " (no choice sent)" : "");
      td.setAttribute("aria-label", td.title);
      tr.appendChild(td);
    });
    tr.appendChild(el("td", "tr-pts", "+" + ((round.points || {})[from] || 0)));
    t.appendChild(tr);
  });
  wrap.appendChild(t);
  return wrap;
}

/* Your choices: a Cooperate / Defect pair per rival, the quick fills,
   and Lock in once every rival has one. The draft lives with the caller
   so a repaint never wipes it. */
export function trPlanner(g: GL, draft: TrDraft, onDraft: (d: TrDraft) => void, onCommit: (dir: string) => void): HTMLElement {
  const you = g.you || {};
  const rivals: string[] = you.rivals || [];
  const queued: TrDraft | null = you.queued || null;
  const wrap = el("div", "tr-plan" + (queued ? "" : " your-move"));
  const head = el("div", "tr-plan-head");
  head.appendChild(el("span", "tr-plan-title", queued ? "Your choices are in" : "Round " + g.round + " · whom do you trust?"));
  wrap.appendChild(head);
  rivals.forEach((n) => {
    const row = el("div", "tr-choice");
    const p = ((g && g.players) || []).find((x: GL) => x.name === n) || { hex: "#94a3b8" };
    const name = el("span", "tr-choice-name", n);
    name.style.color = p.hex;
    row.appendChild(name);
    (["C", "D"] as const).forEach((v) => {
      const b = el("button", "tr-pick " + v.toLowerCase() + (draft[n] === v ? " on" : ""), v === "C" ? "🤝 Cooperate" : "🗡 Defect") as HTMLButtonElement;
      b.type = "button";
      b.setAttribute("aria-pressed", draft[n] === v ? "true" : "false");
      b.addEventListener("click", () => onDraft(Object.assign({}, draft, { [n]: v })));
      row.appendChild(b);
    });
    wrap.appendChild(row);
  });
  const acts = el("div", "tr-acts");
  const quick = (label: string, v: "C" | "D") => {
    const b = el("button", "duel-btn quiet sm", label) as HTMLButtonElement;
    b.type = "button";
    b.addEventListener("click", () => {
      const d: TrDraft = {};
      rivals.forEach((n) => (d[n] = v));
      onDraft(d);
    });
    acts.appendChild(b);
  };
  if (rivals.length > 1) {
    quick("Trust everyone", "C");
    quick("Defect on everyone", "D");
  }
  const full = rivals.length > 0 && rivals.every((n) => draft[n]);
  const same = !!queued && rivals.every((n) => queued[n] === draft[n]);
  const go = el("button", "duel-btn tr-go", same ? "Locked in ✓" : queued ? "Change choices" : "Lock in") as HTMLButtonElement;
  go.type = "button";
  go.disabled = !full || same;
  go.addEventListener("click", () => onCommit(rivals.map((n) => n + ":" + draft[n]).join(", ")));
  acts.appendChild(go);
  wrap.appendChild(acts);
  return wrap;
}

/* History: a row per round - each player's points and how many rivals
   they trusted. */
export function trHistoryRows(g: GL, row: (idx: string) => HTMLElement, who: (p: GL) => HTMLElement, list: HTMLElement): number {
  let n = 0;
  const players: GL[] = g.players || [];
  ((g.rounds || []) as GL[]).forEach((r: GL) => {
    n++;
    const rw = row("Round " + r.n);
    players.forEach((p: GL) => {
      const mv = (r.moves || {})[p.name];
      if (!mv) return;
      const seg = el("span", "hist-seg");
      seg.appendChild(who(p));
      const vals = Object.values(mv) as string[];
      const cs = vals.filter((v) => v === "C").length;
      const missed = (r.missed || []).indexOf(p.name) >= 0;
      seg.appendChild(el("span", "hist-act", "+" + ((r.points || {})[p.name] || 0) + " · " + (missed ? "no choice" : "🤝" + cs + "/" + vals.length)));
      rw.appendChild(seg);
    });
    list.appendChild(rw);
  });
  return n;
}

/* The card: the scores and the last round in one line. */
export function trCardBoard(g: GL, me?: string): HTMLElement {
  const wrap = el("div", "tr-card");
  wrap.appendChild(trScores(g, me, true));
  const last = trLastRound(g);
  let cap = "";
  if (last) {
    const all = Object.values(last.moves || {}).flatMap((m) => Object.values(m as GL) as string[]);
    const cs = all.filter((v) => v === "C").length;
    cap = "Round " + last.n + ": " + cs + " of " + all.length + " choices were trust";
  } else if (g.status === "running") cap = "Round " + g.round + " · choices sealed";
  if (cap) wrap.appendChild(el("div", "tr-card-cap", cap));
  return wrap;
}
