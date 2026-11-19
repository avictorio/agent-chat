import { el } from "../lib";
import type { GL } from "./render";

/* The sealed-bid auction in the DOM (2026-11-19): the lot under the
   hammer, the bidders (budget left, lots won, who has bid), your bid,
   the last lot's result and the history. Pending bids are secret (the
   server sends only your own); resolved lots show every bid. */

export function auLastRound(g: GL): GL | null {
  const rs: GL[] = (g && g.rounds) || [];
  return rs.length ? rs[rs.length - 1] : null;
}

/* The lot under the hammer (or, once it's over, the season's end). */
export function auLot(g: GL): HTMLElement {
  const box = el("div", "au-lot");
  if (g.status === "running" && g.lot) {
    box.appendChild(el("div", "au-lot-n", "Lot " + g.round + " of " + g.lots_total));
    box.appendChild(el("div", "au-lot-name", "“" + g.lot + "”"));
  } else box.appendChild(el("div", "au-lot-n", g.status === "finished" ? "The season is over · " + (g.rounds || []).length + " lots" : g.lots_total + " lots"));
  return box;
}

export function auStatus(g: GL, p: GL): string {
  if (g.status !== "running") return "";
  if ((p.budget || 0) <= 0) return "spent out";
  return p.committed ? "bid ✓" : "thinking…";
}

/* The bidders: budget left as a bar, lots won, who has bid. */
export function auPlayers(g: GL, me?: string, compact?: boolean): HTMLElement {
  const box = el("div", "au-players" + (compact ? " compact" : ""));
  const ps: GL[] = ((g && g.players) || []).slice().sort((a: GL, b: GL) => (b.won || 0) - (a.won || 0) || (b.budget || 0) - (a.budget || 0));
  ps.forEach((p: GL) => {
    const row = el("div", "au-row" + (me && p.name === me ? " mine" : ""));
    const d = el("span", "hist-dot");
    d.style.background = p.hex;
    row.appendChild(d);
    row.appendChild(el("span", "au-name", p.name + (me && p.name === me ? " (you)" : "")));
    const bar = el("span", "au-budget");
    bar.title = (p.budget || 0) + " of " + g.budget + " left";
    const fill = el("span", "au-budget-fill");
    fill.style.width = Math.round((100 * (p.budget || 0)) / Math.max(1, g.budget || 100)) + "%";
    fill.style.background = p.hex;
    bar.appendChild(fill);
    row.appendChild(bar);
    row.appendChild(el("span", "au-left", String(p.budget || 0)));
    row.appendChild(el("span", "au-won", "🏷 " + (p.won || 0)));
    const st = auStatus(g, p);
    if (st && !compact) row.appendChild(el("span", "au-st", st));
    box.appendChild(row);
  });
  return box;
}

/* Your bid: a number box with steps, quick amounts, and Bid. The draft
   lives with the caller so a repaint never wipes it. */
export function auBid(g: GL, draft: number, onDraft: (v: number) => void, onCommit: (v: number) => void): HTMLElement {
  const you = g.you || {};
  const max = you.budget || 0;
  const queued: number | null = you.queued == null ? null : Number(you.queued);
  const wrap = el("div", "au-bid" + (queued == null ? " your-move" : ""));
  wrap.appendChild(el("div", "au-bid-title", queued == null ? "Your sealed bid" : "Your bid is in: " + (queued ? queued : "pass")));
  const row = el("div", "au-bid-row");
  const set = (v: number) => onDraft(Math.max(0, Math.min(max, Math.round(v) || 0)));
  const minus = el("button", "fl-step", "−") as HTMLButtonElement;
  minus.type = "button";
  minus.setAttribute("aria-label", "5 less");
  minus.disabled = draft <= 0;
  minus.addEventListener("click", () => set(draft - 5));
  row.appendChild(minus);
  const inp = el("input", "au-num") as HTMLInputElement;
  inp.type = "number";
  inp.inputMode = "numeric";
  inp.min = "0";
  inp.max = String(max);
  inp.value = String(draft);
  inp.setAttribute("aria-label", "Your bid, 0 to " + max);
  inp.addEventListener("change", () => set(Number(inp.value)));
  row.appendChild(inp);
  const plus = el("button", "fl-step", "+") as HTMLButtonElement;
  plus.type = "button";
  plus.setAttribute("aria-label", "5 more");
  plus.disabled = draft >= max;
  plus.addEventListener("click", () => set(draft + 5));
  row.appendChild(plus);
  row.appendChild(el("span", "au-of", "of " + max));
  wrap.appendChild(row);
  const acts = el("div", "au-acts");
  const quick = (label: string, v: number) => {
    const b = el("button", "duel-btn quiet sm", label) as HTMLButtonElement;
    b.type = "button";
    b.disabled = v > max;
    b.addEventListener("click", () => set(v));
    acts.appendChild(b);
  };
  quick("Pass", 0);
  if (max >= 10) quick("10", 10);
  if (max >= 25) quick("25", 25);
  if (max > 1) quick("Half", Math.floor(max / 2));
  quick("All in", max);
  const same = queued != null && queued === draft;
  const go = el("button", "duel-btn au-go", same ? "Bid in ✓" : draft ? "Bid " + draft : "Pass") as HTMLButtonElement;
  go.type = "button";
  go.disabled = same;
  go.addEventListener("click", () => onCommit(draft));
  acts.appendChild(go);
  wrap.appendChild(acts);
  return wrap;
}

/* The last lot's result: who won it and for how much, and every bid. */
export function auResult(g: GL, round: GL | null): HTMLElement {
  const box = el("div", "au-result");
  if (!round) {
    box.appendChild(el("div", "au-result-empty", "No lot has sold yet - bids are opened together."));
    return box;
  }
  const hexOf = (n: string) => (((g && g.players) || []).find((p: GL) => p.name === n) || { hex: "#94a3b8" }).hex;
  const head = el("div", "au-result-head");
  head.appendChild(el("span", "au-result-lot", "Lot " + round.n + ": “" + round.lot + "”"));
  const verdict = el("span", "au-result-v", round.winner ? round.winner + " · " + round.price : "unsold");
  if (round.winner) verdict.style.color = hexOf(round.winner);
  head.appendChild(verdict);
  box.appendChild(head);
  const bids = Object.keys(round.bids || {}).map((n) => [n, round.bids[n] as number] as [string, number]);
  bids.sort((a, b) => b[1] - a[1]);
  const top = Math.max(1, ...bids.map((b) => b[1]));
  bids.forEach(([n, b]) => {
    const row = el("div", "au-bidrow" + (n === round.winner ? " won" : ""));
    const name = el("span", "au-bidname", n);
    name.style.color = hexOf(n);
    row.appendChild(name);
    const bar = el("span", "au-bidbar");
    const fill = el("span", "au-bidfill");
    fill.style.width = Math.round((100 * b) / top) + "%";
    fill.style.background = hexOf(n);
    bar.appendChild(fill);
    row.appendChild(bar);
    row.appendChild(el("span", "au-bidn", (round.missed || []).indexOf(n) >= 0 ? "no bid" : b ? String(b) : "pass"));
    box.appendChild(row);
  });
  if (round.tie) box.appendChild(el("div", "au-tie", "A tie at the top - it went to the one who " + round.tie + "."));
  return box;
}

/* History: a row per lot - its winner and price, every bid. */
export function auHistoryRows(g: GL, row: (idx: string) => HTMLElement, who: (p: GL) => HTMLElement, list: HTMLElement): number {
  let n = 0;
  const players: GL[] = g.players || [];
  ((g.rounds || []) as GL[]).forEach((r: GL) => {
    n++;
    const rw = row("Lot " + r.n);
    rw.appendChild(el("span", "hist-act au-hist-lot", "“" + r.lot + "”"));
    players.forEach((p: GL) => {
      if ((r.bids || {})[p.name] === undefined) return;
      const seg = el("span", "hist-seg");
      seg.appendChild(who(p));
      seg.appendChild(el("span", "hist-act", r.bids[p.name] ? String(r.bids[p.name]) : "pass"));
      rw.appendChild(seg);
    });
    if (r.winner) {
      const p = players.find((x) => x.name === r.winner) || { hex: "#94a3b8" };
      const pill = el("span", "hist-pill win", r.winner + " · " + r.price);
      pill.style.borderColor = p.hex;
      pill.style.color = p.hex;
      rw.appendChild(pill);
    } else rw.appendChild(el("span", "hist-pill tie", "Unsold"));
    list.appendChild(rw);
  });
  return n;
}

/* The card: the lot under the hammer and the bidders. */
export function auCardBoard(g: GL, me?: string): HTMLElement {
  const wrap = el("div", "au-card");
  wrap.appendChild(auLot(g));
  wrap.appendChild(auPlayers(g, me, true));
  return wrap;
}
