import { el } from "../../../lib/index";
import type { GL } from "../shared/render";

/* Liar's Dice in the DOM (2026-11-19): dice drawn with pips, the standing
   bid, your own cup, the bid builder (count, face, Bid or Liar), the
   table (dice left per seat, whose turn), the last round with every cup
   opened, the history and the card. Cups are secret: the server sends
   only your own (you.dice) and the cups of closed rounds. */

// pip positions per face on a 3x3 grid, [row, column]
const PIPS: Record<number, [number, number][]> = {
  1: [[2, 2]],
  2: [[1, 3], [3, 1]],
  3: [[1, 3], [2, 2], [3, 1]],
  4: [[1, 1], [1, 3], [3, 1], [3, 3]],
  5: [[1, 1], [1, 3], [2, 2], [3, 1], [3, 3]],
  6: [[1, 1], [1, 3], [2, 1], [2, 3], [3, 1], [3, 3]],
};
const WORD = ["", "one", "two", "three", "four", "five", "six"];

export function ldFaceWord(f: number, plural: boolean): string {
  const w = WORD[f] || String(f);
  return plural ? (f === 6 ? "sixes" : w + "s") : w;
}

export function ldBidText(b: GL): string {
  return b.qty + " " + ldFaceWord(b.face, b.qty !== 1);
}

export function ldDie(face: number, cls?: string): HTMLElement {
  const d = el("span", "ld-die" + (cls ? " " + cls : ""));
  d.setAttribute("role", "img");
  d.setAttribute("aria-label", String(face));
  (PIPS[face] || []).forEach(([r, c]) => {
    const p = el("i", "");
    p.style.gridRow = String(r);
    p.style.gridColumn = String(c);
    d.appendChild(p);
  });
  return d;
}

// does a die count toward a bid on this face?
export function ldCounts(d: number, face: number, wild: boolean): boolean {
  return d === face || (wild && d === 1 && face !== 1);
}

export function ldLastRound(g: GL): GL | null {
  const rs: GL[] = (g && g.rounds) || [];
  return rs.length ? rs[rs.length - 1] : g && g.last_round ? g.last_round : null;
}

/* The standing bid (or who opens), and the dice on the table. */
export function ldBidNow(g: GL): HTMLElement {
  const box = el("div", "ld-now");
  if (g.status === "finished") {
    box.appendChild(el("div", "ld-now-k", "The table is cleared · " + ((g.rounds || []).length || g.round || 0) + " rounds"));
    return box;
  }
  const b = g.bid;
  if (b) {
    box.appendChild(el("div", "ld-now-k", "Standing bid · round " + g.round));
    const line = el("div", "ld-now-bid");
    line.appendChild(el("span", "ld-now-q", b.qty + " ×"));
    line.appendChild(ldDie(b.face, "big"));
    const who = el("span", "ld-now-by", "by " + b.by);
    const p = ((g.players || []) as GL[]).find((x) => x.name === b.by);
    if (p) who.style.color = p.hex;
    line.appendChild(who);
    box.appendChild(line);
    box.appendChild(el("div", "ld-now-sub", "At least " + ldBidText(b) + " among all " + g.dice_total + " dice" + (g.ones_wild && b.face !== 1 ? " - ones count as " + ldFaceWord(b.face, true) : "") + "."));
  } else {
    box.appendChild(el("div", "ld-now-k", "Round " + (g.round || 1)));
    box.appendChild(el("div", "ld-now-open", g.status === "running" && g.turn_of ? g.turn_of + " opens the bidding" : "No bid yet"));
    box.appendChild(el("div", "ld-now-sub", (g.dice_total || 0) + " dice on the table" + (g.ones_wild ? " · ones are wild" : "")));
  }
  return box;
}

/* Your cup: your own dice (ones marked wild when they are). */
export function ldCup(g: GL): HTMLElement {
  const you = g.you || {};
  const box = el("div", "ld-cup");
  box.appendChild(el("div", "ld-cup-k", "Your cup"));
  const row = el("div", "ld-cup-dice");
  ((you.dice || []) as number[]).forEach((d) => row.appendChild(ldDie(d, g.ones_wild && d === 1 ? "wild" : "")));
  box.appendChild(row);
  if (g.ones_wild && (you.dice || []).indexOf(1) >= 0) box.appendChild(el("div", "ld-cup-note", "Your ones are wild - they count toward any face."));
  return box;
}

/* The bid builder: a count, a face, and Bid - or Liar! when there is a
   bid to call. The draft lives with the caller so a repaint keeps it. */
export function ldBidder(g: GL, draft: { qty: number; face: number }, onDraft: (d: { qty: number; face: number }) => void, onBid: (dir: string) => void, onLiar: () => void): HTMLElement {
  const wild = !!g.ones_wild;
  const total = g.dice_total || 0;
  const b = g.bid;
  const wrap = el("div", "ld-bidder your-move");
  wrap.appendChild(el("div", "ld-bidder-title", b ? "Raise - or call liar" : "Open the bidding"));
  const row = el("div", "ld-bid-row");
  const set = (qty: number, face: number) => onDraft({ qty: Math.max(1, Math.min(total, qty)), face });
  const minus = el("button", "fl-step", "−") as HTMLButtonElement;
  minus.type = "button";
  minus.setAttribute("aria-label", "One fewer die");
  minus.disabled = draft.qty <= 1;
  minus.addEventListener("click", () => set(draft.qty - 1, draft.face));
  row.appendChild(minus);
  row.appendChild(el("span", "ld-qty", String(draft.qty)));
  const plus = el("button", "fl-step", "+") as HTMLButtonElement;
  plus.type = "button";
  plus.setAttribute("aria-label", "One more die");
  plus.disabled = draft.qty >= total;
  plus.addEventListener("click", () => set(draft.qty + 1, draft.face));
  row.appendChild(plus);
  row.appendChild(el("span", "ld-x", "×"));
  const faces = el("div", "ld-faces");
  faces.setAttribute("role", "radiogroup");
  faces.setAttribute("aria-label", "Face");
  for (let f = wild ? 2 : 1; f <= 6; f++) {
    const fb = el("button", "ld-face" + (draft.face === f ? " on" : "")) as HTMLButtonElement;
    fb.type = "button";
    fb.setAttribute("role", "radio");
    fb.setAttribute("aria-checked", draft.face === f ? "true" : "false");
    fb.setAttribute("aria-label", ldFaceWord(f, true));
    fb.appendChild(ldDie(f));
    fb.addEventListener("click", () => set(draft.qty, f));
    faces.appendChild(fb);
  }
  row.appendChild(faces);
  wrap.appendChild(row);
  // the odds, from your own cup: what you hold, and the rest at random
  const mine = ((g.you && g.you.dice) || []) as number[];
  const held = mine.filter((d) => ldCounts(d, draft.face, wild)).length;
  const unknown = Math.max(0, total - mine.length);
  const expect = held + unknown * (wild && draft.face !== 1 ? 1 / 3 : 1 / 6);
  wrap.appendChild(el("div", "ld-odds", "You hold " + held + " · about " + (Math.round(expect * 10) / 10) + " expected among all " + total));
  const beats = !b || draft.qty > b.qty || (draft.qty === b.qty && draft.face > b.face);
  const acts = el("div", "ld-acts");
  const go = el("button", "duel-btn ld-go", "Bid " + ldBidText(draft)) as HTMLButtonElement;
  go.type = "button";
  go.disabled = !beats;
  if (!beats && b) go.title = "A raise must beat " + ldBidText(b) + ": more dice, or the same count of a higher face";
  go.addEventListener("click", () => onBid(draft.qty + "x" + draft.face));
  acts.appendChild(go);
  if (b) {
    const liar = el("button", "duel-btn ld-liar", "Liar!") as HTMLButtonElement;
    liar.type = "button";
    liar.title = "Call liar on " + b.by + "'s " + ldBidText(b);
    liar.addEventListener("click", () => onLiar());
    acts.appendChild(liar);
  }
  wrap.appendChild(acts);
  if (!beats && b) wrap.appendChild(el("div", "ld-why", "Beat " + ldBidText(b) + ": more dice, or the same count of a higher face."));
  return wrap;
}

/* The table: every seat in turn order, dice left, whose turn, their bid
   this round; the players who are out at the end. */
export function ldTable(g: GL, me?: string, compact?: boolean): HTMLElement {
  const box = el("div", "ld-table" + (compact ? " compact" : ""));
  const order: string[] = g.order || [];
  const ps: GL[] = ((g.players || []) as GL[]).slice().sort((a, b) => {
    const ia = order.indexOf(a.name);
    const ib = order.indexOf(b.name);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
  const each = g.dice_each || 5;
  ps.forEach((p) => {
    const turn = g.status === "running" && g.turn_of === p.name;
    const row = el("div", "ld-seat" + (turn ? " turn" : "") + (p.out ? " out" : "") + (me && p.name === me ? " mine" : ""));
    const d = el("span", "hist-dot");
    d.style.background = p.hex;
    row.appendChild(d);
    row.appendChild(el("span", "ld-name", p.name + (me && p.name === me ? " (you)" : "")));
    const cups = el("span", "ld-left");
    cups.setAttribute("aria-label", (p.dice || 0) + " dice left");
    for (let i = 0; i < each; i++) {
      const c = el("i", i < (p.dice || 0) ? "" : "lost");
      if (i < (p.dice || 0)) c.style.background = p.hex;
      cups.appendChild(c);
    }
    row.appendChild(cups);
    const mineBids = ((g.bids || []) as GL[]).filter((x) => x.by === p.name);
    const st = p.out ? "out" : turn ? (compact ? "to bid" : "thinking…") : mineBids.length ? ldBidText(mineBids[mineBids.length - 1]) : "";
    if (st) row.appendChild(el("span", "ld-st", st));
    box.appendChild(row);
  });
  return box;
}

/* A closed round: what happened, the verdict, and every cup opened with
   the dice that counted lit. */
export function ldRound(g: GL, r: GL | null): HTMLElement {
  const box = el("div", "ld-reveal");
  if (!r) {
    box.appendChild(el("div", "ld-reveal-empty", "No cup has been opened yet - a call of liar opens them all."));
    return box;
  }
  const hexOf = (n: string) => (((g && g.players) || []).find((p: GL) => p.name === n) || { hex: "#94a3b8" }).hex;
  const head = el("div", "ld-reveal-head");
  const call = r.call || null;
  if (r.reason === "call" && call) head.appendChild(el("span", "ld-reveal-what", "Round " + r.n + ": " + call.by + " called liar on " + call.bid.by + "'s " + ldBidText(call.bid)));
  else if (r.reason === "forfeit") head.appendChild(el("span", "ld-reveal-what", "Round " + r.n + ": " + r.loser + " timed out a third time in a row"));
  else head.appendChild(el("span", "ld-reveal-what", "Round " + r.n + ": " + r.loser + "'s turn ran out"));
  box.appendChild(head);
  const v = el("div", "ld-verdict" + (r.reason === "call" ? (r.stands ? " stands" : " lie") : ""));
  if (r.reason === "call" && call) v.appendChild(el("span", "", "The table showed " + r.count + " · " + (r.stands ? "the bid stands" : "the bid was a lie") + " · "));
  const lose = el("span", "ld-loser", r.loser + (r.out ? " is out" : " loses a die (" + r.dice_left + " left)"));
  lose.style.color = hexOf(r.loser);
  v.appendChild(lose);
  box.appendChild(v);
  const face = call ? call.bid.face : 0;
  Object.keys(r.cups || {}).forEach((n) => {
    const row = el("div", "ld-open-row");
    const name = el("span", "ld-open-name", n);
    name.style.color = hexOf(n);
    row.appendChild(name);
    const dice = el("span", "ld-open-dice");
    ((r.cups[n] || []) as number[]).forEach((d) => dice.appendChild(ldDie(d, face ? (ldCounts(d, face, !!g.ones_wild) ? "hit" : "dim") : "")));
    row.appendChild(dice);
    box.appendChild(row);
  });
  return box;
}

/* History: a row per closed round - the bids, the call, who lost a die. */
export function ldHistoryRows(g: GL, row: (idx: string) => HTMLElement, who: (p: GL) => HTMLElement, list: HTMLElement): number {
  let n = 0;
  const players: GL[] = g.players || [];
  const byName = (nm: string): GL => players.find((p) => p.name === nm) || { name: nm, hex: "#94a3b8" };
  ((g.rounds || []) as GL[]).forEach((r: GL) => {
    n++;
    const rw = row("Round " + r.n);
    const bids: GL[] = r.bids || [];
    if (bids.length) {
      const seg = el("span", "hist-seg");
      seg.appendChild(el("span", "hist-act", bids.map((b) => b.by + " " + b.qty + "×" + b.face).join(" → ")));
      rw.appendChild(seg);
    }
    if (r.reason === "call" && r.call) {
      const seg = el("span", "hist-seg");
      seg.appendChild(who(byName(r.call.by)));
      seg.appendChild(el("span", "hist-act", "liar! · " + r.count + " showed"));
      rw.appendChild(seg);
    } else rw.appendChild(el("span", "hist-act", r.reason === "forfeit" ? "timed out 3 in a row" : "turn ran out"));
    const p = byName(r.loser);
    const pill = el("span", "hist-pill " + (r.out ? "tie" : "win"), r.loser + (r.out ? " out" : " −1"));
    pill.style.borderColor = p.hex;
    pill.style.color = p.hex;
    rw.appendChild(pill);
    list.appendChild(rw);
  });
  return n;
}

/* The card: the standing bid and the table. */
export function ldCardBoard(g: GL, me?: string): HTMLElement {
  const wrap = el("div", "ld-card");
  wrap.appendChild(ldBidNow(g));
  wrap.appendChild(ldTable(g, me, true));
  return wrap;
}
