import { el } from "../../../lib/index";
import type { GL } from "../shared/render";

/* Two Truths and a Lie in the page (2026-11-19), under the 3D campfire:
   the storyteller's writing form, the statements to vote on, the
   scores, the last round's reveal, the history and the chat card. The
   lie stays secret until the reveal: only the storyteller's own view
   carries you.lie. */

export type TtDraft = { round: number; s: [string, string, string]; lie: number };
export const TT_MAX = 200;

export function ttLastRound(g: GL): GL | null {
  const rs: GL[] = (g && g.rounds) || [];
  return rs.length ? rs[rs.length - 1] : g && g.last_round ? g.last_round : null;
}

const hexOf = (g: GL, n: string) => (((g && g.players) || []).find((p: GL) => p.name === n) || { hex: "#94a3b8" }).hex;

/* The storyteller's form: three statements, which one is the lie, send. */
export function ttWriter(draft: TtDraft, onDraft: (d: TtDraft) => void, onSend: (d: TtDraft) => void): HTMLElement {
  const wrap = el("div", "tt-writer your-move");
  wrap.appendChild(el("div", "tt-writer-title", "Your turn to tell: two truths and a lie about you"));
  const rows = el("div", "tt-writer-rows");
  ([0, 1, 2] as const).forEach((i) => {
    const row = el("div", "tt-writer-row" + (draft.lie === i + 1 ? " lie" : ""));
    const ta = el("textarea", "tt-input") as HTMLTextAreaElement;
    ta.rows = 2;
    ta.maxLength = TT_MAX;
    ta.placeholder = i === 0 ? "Something true about you…" : i === 1 ? "Something else true…" : "Something believable but false…";
    ta.value = draft.s[i];
    ta.setAttribute("aria-label", "Statement " + (i + 1));
    // keep the draft in place - a repaint would rebuild the form and drop
    // the focus as you type or tab to the next statement
    ta.addEventListener("input", () => {
      draft.s[i] = ta.value;
      go.disabled = !ready();
    });
    row.appendChild(ta);
    const pick = el("button", "tt-lie-pick" + (draft.lie === i + 1 ? " on" : ""), draft.lie === i + 1 ? "The lie" : "Mark as the lie") as HTMLButtonElement;
    pick.type = "button";
    pick.setAttribute("aria-pressed", draft.lie === i + 1 ? "true" : "false");
    pick.addEventListener("click", () => onDraft({ ...draft, s: [draft.s[0], draft.s[1], draft.s[2]], lie: i + 1 }));
    row.appendChild(pick);
    rows.appendChild(row);
  });
  wrap.appendChild(rows);
  const ready = () => draft.s.every((x) => x.trim()) && draft.lie >= 1 && new Set(draft.s.map((x) => x.trim().toLowerCase())).size === 3;
  const acts = el("div", "tt-acts");
  acts.appendChild(el("span", "tt-help", "They're shown shuffled; only you know which is the lie."));
  const go = el("button", "duel-btn tt-go", "Tell the table") as HTMLButtonElement;
  go.type = "button";
  go.disabled = !ready();
  go.addEventListener("click", () => {
    if (ready()) onSend({ ...draft, s: [draft.s[0], draft.s[1], draft.s[2]] });
  });
  acts.appendChild(go);
  wrap.appendChild(acts);
  return wrap;
}

/* The three statements this round: voters pick the lie (their vote
   marked); the storyteller sees theirs with the lie marked; spectators
   just read. */
export function ttStatements(g: GL, onVote?: (n: number) => void): HTMLElement {
  const you = g.you || {};
  const ss: string[] = g.statements || you.statements || [];
  const box = el("div", "tt-statements" + (onVote ? " your-move" : ""));
  const teller = g.teller;
  const head = el("div", "tt-st-head");
  const who = el("span", "tt-st-teller", teller || "");
  who.style.color = hexOf(g, teller);
  head.appendChild(who);
  head.appendChild(el("span", "", you.teller ? " - your statements (only you can see the lie)" : onVote ? " says… which one is the lie?" : " says…"));
  box.appendChild(head);
  ss.forEach((s, i) => {
    const n = i + 1;
    const mine = you.vote === n;
    const isLie = you.teller && you.lie === n;
    const b = el(onVote ? "button" : "div", "tt-card" + (mine ? " voted" : "") + (isLie ? " lie" : "")) as HTMLButtonElement;
    if (onVote) {
      b.type = "button";
      b.setAttribute("aria-pressed", mine ? "true" : "false");
      b.addEventListener("click", () => onVote(n));
    }
    b.appendChild(el("span", "tt-card-n", String(n)));
    b.appendChild(el("span", "tt-card-text", s));
    if (mine) b.appendChild(el("span", "tt-card-tag", "your vote: the lie"));
    else if (isLie) b.appendChild(el("span", "tt-card-tag", "your lie"));
    box.appendChild(b);
  });
  return box;
}

/* Scores: everyone, best first; who is telling and who has voted. */
export function ttScores(g: GL, me?: string, compact?: boolean): HTMLElement {
  const box = el("div", "tt-scores" + (compact ? " compact" : ""));
  const ps: GL[] = ((g.players || []) as GL[]).slice().sort((a, b) => (b.score || 0) - (a.score || 0) || (b.spots || 0) - (a.spots || 0));
  ps.forEach((p) => {
    const row = el("div", "tt-row" + (me && p.name === me ? " mine" : "") + (g.status === "running" && g.teller === p.name ? " teller" : ""));
    const d = el("span", "hist-dot");
    d.style.background = p.hex;
    row.appendChild(d);
    row.appendChild(el("span", "tt-name", p.name + (me && p.name === me ? " (you)" : "")));
    let st = "";
    if (g.status === "running") {
      if (g.teller === p.name) st = g.phase === "write" ? "writing…" : "telling";
      else if (g.phase === "vote") st = p.committed ? "voted ✓" : "thinking…";
    }
    if (st && !compact) row.appendChild(el("span", "tt-st", st));
    row.appendChild(el("span", "tt-pts", String(p.score || 0)));
    box.appendChild(row);
  });
  return box;
}

/* The last round: the statements with the lie marked, who voted where,
   the points, and the roast when everyone saw through it. */
export function ttReveal(g: GL, r: GL | null): HTMLElement {
  const box = el("div", "tt-reveal");
  if (!r) {
    box.appendChild(el("div", "tt-reveal-empty", "No lie has been revealed yet."));
    return box;
  }
  const head = el("div", "tt-reveal-head");
  const t = el("span", "tt-reveal-teller", r.teller);
  t.style.color = hexOf(g, r.teller);
  head.appendChild(el("span", "", "Round " + r.n + " · "));
  head.appendChild(t);
  box.appendChild(head);
  if (r.forfeit) {
    box.appendChild(el("div", "tt-reveal-note", r.teller + " ran out of time to write - the round was forfeit."));
    return box;
  }
  ((r.statements || []) as string[]).forEach((s, i) => {
    const n = i + 1;
    const lie = n === r.lie;
    const row = el("div", "tt-rv" + (lie ? " lie" : " truth"));
    row.appendChild(el("span", "tt-rv-tag", lie ? "LIE" : "TRUE"));
    row.appendChild(el("span", "tt-rv-text", s));
    const voters = Object.keys(r.votes || {}).filter((v) => r.votes[v] === n);
    const vs = el("span", "tt-rv-votes");
    voters.forEach((v) => {
      const c = el("span", "tt-chip", v);
      c.style.borderColor = hexOf(g, v);
      c.style.color = hexOf(g, v);
      vs.appendChild(c);
    });
    row.appendChild(vs);
    box.appendChild(row);
  });
  const pts = Object.keys(r.points || {})
    .filter((n) => r.points[n])
    .map((n) => n + " +" + r.points[n]);
  box.appendChild(el("div", "tt-reveal-pts", (pts.length ? pts.join(" · ") : "No points this round") + ((r.missed || []).length ? " · no vote: " + r.missed.join(", ") : "")));
  if (r.note) box.appendChild(el("div", "tt-reveal-note", r.note));
  return box;
}

/* History: a row per round - the storyteller, the lie, who spotted it. */
export function ttHistoryRows(g: GL, row: (idx: string) => HTMLElement, who: (p: GL) => HTMLElement, list: HTMLElement): number {
  let n = 0;
  const players: GL[] = g.players || [];
  const byName = (nm: string): GL => players.find((p) => p.name === nm) || { name: nm, hex: "#94a3b8" };
  ((g.rounds || []) as GL[]).forEach((r: GL) => {
    n++;
    const rw = row("Round " + r.n);
    const seg = el("span", "hist-seg");
    seg.appendChild(who(byName(r.teller)));
    seg.appendChild(el("span", "hist-act", r.forfeit ? "forfeit" : "lie: “" + ((r.statements || [])[r.lie - 1] || "") + "”"));
    rw.appendChild(seg);
    if (!r.forfeit) {
      const pill = el("span", "hist-pill " + (r.right && r.right.length ? "win" : "tie"), r.right && r.right.length ? r.right.join(", ") + " spotted it" : "nobody spotted it");
      rw.appendChild(pill);
    }
    list.appendChild(rw);
  });
  return n;
}

/* The card: whose turn to tell, and the scores. */
export function ttCardBoard(g: GL, me?: string): HTMLElement {
  const wrap = el("div", "tt-card-board");
  const line =
    g.status === "running" && g.teller
      ? "Round " + g.round + " of " + g.rounds_total + " · " + g.teller + (g.phase === "write" ? " is writing" : " told - vote for the lie")
      : g.status === "finished"
        ? "The fire's out · " + (g.rounds_total || 0) + " rounds"
        : (g.rounds_total || 0) + " rounds";
  wrap.appendChild(el("div", "tt-card-line", line));
  wrap.appendChild(ttScores(g, me, true));
  return wrap;
}
