import { el } from "../../../lib/index";
import type { GL } from "../shared/render";

/* Trivia in the DOM (2026-11-20): the scoreboard (balances), the
   quizmaster's question form, the answer-and-wager form, the judge panel,
   the last round's reveal, the history and the chat card. Questions come
   from a rotating quizmaster (the owner's call). The answer is sealed in
   the quizmaster's own view until the reveal; answers are sealed until
   the round resolves. Forms keep their drafts on the caller's side and
   never rebuild while you type, so a poll cannot steal focus. */

export type TvAskDraft = { q: string; a: string; acc: string };
export type TvAnsDraft = { a: string; w: number };

export function tvLastRound(g: GL): GL | null {
  const rs: GL[] = (g && g.rounds) || [];
  return rs.length ? rs[rs.length - 1] : null;
}

function status(g: GL, p: GL): string {
  if (g.status !== "running") return "";
  if (p.name === g.asker) return g.phase === "judge" ? "judging…" : g.phase === "ask" ? "asking…" : "quizmaster";
  if (g.phase === "answer") return p.committed ? "answered ✓" : "thinking…";
  return "";
}

/* The scoreboard, highest balance first, with right answers. */
export function tvScores(g: GL, me?: string, compact?: boolean): HTMLElement {
  const box = el("div", "tv-scores" + (compact ? " compact" : ""));
  const ps: GL[] = ((g && g.players) || []).slice().sort((a: GL, b: GL) => (b.balance || 0) - (a.balance || 0) || (b.right || 0) - (a.right || 0) || (a.name < b.name ? -1 : 1));
  ps.forEach((p: GL, i: number) => {
    const row = el("div", "tv-row" + (me && p.name === me ? " mine" : "") + (p.name === g.asker ? " asker" : ""));
    row.style.setProperty("--who", p.hex || "#94a3b8");
    row.appendChild(el("span", "tv-rank", String(i + 1)));
    const d = el("span", "hist-dot");
    d.style.background = p.hex;
    row.appendChild(d);
    row.appendChild(el("span", "tv-name", p.name + (me && p.name === me ? " (you)" : "")));
    if (!compact) row.appendChild(el("span", "tv-right", "✓ " + (p.right || 0)));
    const st = compact ? (p.name === g.asker && g.status === "running" ? "🎤" : "") : status(g, p);
    if (st) row.appendChild(el("span", "tv-st", st));
    row.appendChild(el("span", "tv-bal", String(p.balance != null ? p.balance : 100)));
    box.appendChild(row);
  });
  return box;
}

/* The question as it stands this round (also shown in the scene). */
export function tvQuestion(g: GL): HTMLElement | null {
  if (g.status !== "running") return null;
  const box = el("div", "tv-q");
  const who = (g.players || []).find((p: GL) => p.name === g.asker);
  const tag = el("div", "tv-q-tag", "Round " + g.round + " of " + g.rounds_total + " · " + (g.asker || "?") + " asks");
  if (who) tag.style.setProperty("--who", who.hex);
  box.appendChild(tag);
  box.appendChild(el("div", "tv-q-text" + (g.question ? "" : " waiting"), g.question || (g.asker || "The quizmaster") + " is writing a question…"));
  return box;
}

/* The quizmaster's form: question, answer, other accepted answers. */
export function tvAskForm(draft: TvAskDraft, onDraft: (d: TvAskDraft) => void, onSend: (dir: string) => void): HTMLElement {
  const box = el("div", "tv-form tv-ask");
  box.appendChild(el("div", "tv-form-title", "Your question"));
  const q = el("textarea", "tv-in tv-in-q") as HTMLTextAreaElement;
  q.rows = 2;
  q.maxLength = 200;
  q.placeholder = "Ask something about you, the room, anything";
  q.setAttribute("aria-label", "Your question");
  q.value = draft.q;
  const a = el("input", "tv-in tv-in-a") as HTMLInputElement;
  a.type = "text";
  a.maxLength = 60;
  a.placeholder = "The answer (sealed until the reveal)";
  a.setAttribute("aria-label", "The answer");
  a.value = draft.a;
  const acc = el("input", "tv-in tv-in-acc") as HTMLInputElement;
  acc.type = "text";
  acc.maxLength = 200;
  acc.placeholder = "Other answers that count, separated by |  (optional)";
  acc.setAttribute("aria-label", "Other accepted answers");
  acc.value = draft.acc;
  const send = el("button", "btn tv-send", "Ask") as HTMLButtonElement;
  send.type = "button";
  const sync = () => {
    const d = { q: q.value, a: a.value, acc: acc.value };
    send.disabled = !d.q.trim() || !d.a.trim();
    onDraft(d);
  };
  [q, a, acc].forEach((x) => x.addEventListener("input", sync));
  send.disabled = !draft.q.trim() || !draft.a.trim();
  send.addEventListener("click", () => {
    if (send.disabled) return;
    const variants = acc.value.split("|").map((x) => x.trim()).filter(Boolean);
    onSend(JSON.stringify({ question: q.value.trim(), answer: a.value.trim(), accept: variants }));
  });
  box.appendChild(q);
  box.appendChild(a);
  box.appendChild(acc);
  const hint = el("div", "tv-hint", "Ask something answerable but not easy: you score 10 if some get it right and some don't.");
  box.appendChild(hint);
  const row = el("div", "tv-row-end");
  row.appendChild(send);
  box.appendChild(row);
  return box;
}

/* An answer and a wager: the stake as a slider and steps of 5. */
export function tvAnswerForm(g: GL, draft: TvAnsDraft, onDraft: (d: TvAnsDraft) => void, onSend: (dir: string) => void): HTMLElement {
  const you = g.you || {};
  const max: number = you.max_wager != null ? you.max_wager : 25;
  const box = el("div", "tv-form tv-answer");
  box.appendChild(el("div", "tv-form-title", you.queued ? "Your answer is in - change it until the round resolves" : "Your answer"));
  const a = el("input", "tv-in tv-in-a") as HTMLInputElement;
  a.type = "text";
  a.maxLength = 60;
  a.placeholder = "Your answer";
  a.setAttribute("aria-label", "Your answer");
  a.value = draft.a;
  box.appendChild(a);
  const wrow = el("div", "tv-wager");
  const lab = el("span", "tv-wager-lab", "");
  const range = el("input", "tv-range") as HTMLInputElement;
  range.type = "range";
  range.min = "0";
  range.max = String(max);
  range.step = "1";
  range.value = String(Math.min(max, draft.w));
  range.setAttribute("aria-label", "Your wager");
  const stake = el("span", "tv-stake", "");
  wrow.appendChild(lab);
  wrow.appendChild(range);
  wrow.appendChild(stake);
  box.appendChild(wrow);
  const quick = el("div", "tv-quick");
  [0, 5, 10, 15, 20, 25].filter((v) => v <= max).forEach((v) => {
    const b = el("button", "tv-chip-btn", String(v)) as HTMLButtonElement;
    b.type = "button";
    b.addEventListener("click", () => {
      range.value = String(v);
      sync();
    });
    quick.appendChild(b);
  });
  box.appendChild(quick);
  const send = el("button", "btn tv-send", you.queued ? "Change" : "Lock in") as HTMLButtonElement;
  send.type = "button";
  const paint = () => {
    const w = Number(range.value) || 0;
    lab.textContent = "Wager";
    stake.textContent = w + " of " + max;
    send.disabled = !a.value.trim();
  };
  const sync = () => {
    paint();
    onDraft({ a: a.value, w: Number(range.value) || 0 });
  };
  a.addEventListener("input", sync);
  range.addEventListener("input", sync);
  a.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !send.disabled) {
      e.preventDefault();
      send.click();
    }
  });
  send.addEventListener("click", () => {
    if (send.disabled) return;
    onSend(JSON.stringify({ answer: a.value.trim(), wager: Number(range.value) || 0 }));
  });
  paint();
  const row = el("div", "tv-row-end");
  row.appendChild(send);
  box.appendChild(row);
  if (you.queued) box.appendChild(el("div", "tv-hint", "Sealed: " + you.queued.answer + " · wager " + you.queued.wager));
  return box;
}

/* The quizmaster's ruling on answers the match missed. */
export function tvJudgeForm(g: GL, onSend: (dir: string) => void): HTMLElement {
  const you = g.you || {};
  const box = el("div", "tv-form tv-judge");
  box.appendChild(el("div", "tv-form-title", "Judge these answers - the answer is " + (you.answer || "?")));
  ((you.to_judge || []) as GL[]).forEach((x: GL) => {
    const row = el("div", "tv-judge-row" + (x.accepted ? " ok" : ""));
    row.appendChild(el("span", "tv-judge-name", x.name));
    row.appendChild(el("span", "tv-judge-ans", "“" + x.answer + "”"));
    const b = el("button", "btn sm tv-accept", x.accepted ? "Counted ✓" : "Count it") as HTMLButtonElement;
    b.type = "button";
    b.disabled = !!x.accepted;
    b.setAttribute("aria-label", "Count " + x.name + "'s answer as right");
    b.addEventListener("click", () => onSend("accept " + x.name));
    row.appendChild(b);
    box.appendChild(row);
  });
  const done = el("button", "btn tv-send", "Reveal") as HTMLButtonElement;
  done.type = "button";
  done.addEventListener("click", () => onSend("done"));
  const row = el("div", "tv-row-end");
  row.appendChild(done);
  box.appendChild(row);
  box.appendChild(el("div", "tv-hint", "Anything you don't count is wrong. On your honour."));
  return box;
}

/* One round's reveal: the question, the answer, each answer with its
   wager and the swing, and the quizmaster's split bonus. */
export function tvReveal(g: GL, round: GL | null, me?: string): HTMLElement | null {
  if (!round) return null;
  const box = el("div", "tv-reveal");
  const players: GL[] = g.players || [];
  const hexOf = (n: string) => (players.find((p: GL) => p.name === n) || { hex: "#94a3b8" }).hex;
  box.appendChild(el("div", "fl-cap", "Round " + round.n + " · " + round.asker + " asked"));
  if (round.forfeit) {
    box.appendChild(el("div", "tv-rv-q", round.asker + " ran out of time - no question this round."));
    return box;
  }
  box.appendChild(el("div", "tv-rv-q", round.question));
  box.appendChild(el("div", "tv-rv-a", "Answer: " + round.answer + ((round.accept || []).length ? " (also: " + round.accept.join(", ") + ")" : "")));
  const names = Object.keys(round.answers || {}).concat(round.missed || []);
  names.forEach((n: string) => {
    const a = (round.answers || {})[n];
    const row = el("div", "tv-rv" + (a ? (a.right ? " right" : " wrong") : " missed") + (me && n === me ? " mine" : ""));
    row.style.setProperty("--who", hexOf(n));
    const d = el("span", "hist-dot");
    d.style.background = hexOf(n);
    row.appendChild(d);
    row.appendChild(el("span", "tv-rv-name", n));
    row.appendChild(el("span", "tv-rv-ans", a ? "“" + a.answer + "”" + (a.judged ? " (judged right)" : "") : "no answer"));
    const delta = (round.deltas || {})[n] || 0;
    row.appendChild(el("span", "tv-rv-delta", a ? (delta > 0 ? "+" + delta : delta < 0 ? "−" + -delta : "0") : "0"));
    box.appendChild(row);
  });
  if (round.split) {
    const row = el("div", "tv-rv split");
    row.style.setProperty("--who", hexOf(round.asker));
    row.appendChild(el("span", "tv-rv-name", round.asker));
    row.appendChild(el("span", "tv-rv-ans", "split the table"));
    row.appendChild(el("span", "tv-rv-delta", "+" + (round.bonus || 10)));
    box.appendChild(row);
  }
  return box;
}

export function tvHistoryRows(g: GL, row: (idx: string) => HTMLElement, who: (p: GL) => HTMLElement, list: HTMLElement): number {
  let n = 0;
  const players: GL[] = g.players || [];
  const byName = (nm: string): GL => players.find((p: GL) => p.name === nm) || { name: nm, hex: "#94a3b8" };
  ((g.rounds || []) as GL[]).forEach((r: GL) => {
    n++;
    const rw = row("Round " + r.n);
    const seg = el("span", "hist-seg");
    seg.appendChild(who(byName(r.asker)));
    seg.appendChild(el("span", "hist-act", r.forfeit ? "no question" : "asked · " + r.answer + (r.split ? " · split +" + (r.bonus || 10) : "")));
    rw.appendChild(seg);
    Object.keys(r.answers || {}).forEach((nm: string) => {
      const a = r.answers[nm];
      const s2 = el("span", "hist-seg");
      s2.appendChild(who(byName(nm)));
      const d = (r.deltas || {})[nm] || 0;
      s2.appendChild(el("span", "hist-act", (a.right ? "✓ " : "✗ ") + (d > 0 ? "+" + d : d < 0 ? "−" + -d : "0")));
      rw.appendChild(s2);
    });
    list.appendChild(rw);
  });
  return n;
}

/* The card: the question (or the last answer) and the balances. */
export function tvCardBoard(g: GL, me?: string): HTMLElement {
  const wrap = el("div", "tv-card");
  let cap = "";
  if (g.status === "running") cap = g.question ? "“" + g.question + "” - " + g.asker + " asks" : (g.asker || "The quizmaster") + " is writing a question";
  else {
    const last = tvLastRound(g);
    if (last && !last.forfeit) cap = "Last: “" + last.question + "” - " + last.answer;
  }
  if (cap) wrap.appendChild(el("div", "tv-card-q", cap));
  wrap.appendChild(tvScores(g, me, true));
  return wrap;
}
