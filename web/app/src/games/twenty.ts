import { el } from "../lib";
import type { GL } from "./render";

/* Twenty Questions in the page (2026-11-20), under the 3D candle ring:
   the answerer's controls (choose a secret; answer the waiting question),
   the questioners' (ask or guess), the budget, the public Q/A log, the
   scores, the last round's reveal, the history and the chat card. The
   secret shows only to the answerer until the round ends. */

const hexOf = (g: GL, n: string) => (((g && g.players) || []).find((p: GL) => p.name === n) || { hex: "#94a3b8" }).hex;

export function tqLastRound(g: GL): GL | null {
  const rs: GL[] = (g && g.rounds) || [];
  return rs.length ? rs[rs.length - 1] : g && g.last_round ? g.last_round : null;
}

/* The answerer: choose a secret (or draw one), then answer what waits. */
export function tqAnswerer(g: GL, onSend: (dir: string) => void): HTMLElement {
  const you = g.you || {};
  const wrap = el("div", "tq-panel" + (g.phase !== "ask" ? " your-move" : ""));
  if (g.phase === "secret") {
    wrap.appendChild(el("div", "tq-title", "You're the answerer - choose a secret"));
    wrap.appendChild(el("div", "tq-help", "A noun phrase: a thing, a place, a person, an idea. Hidden until the round ends."));
    const row = el("div", "tq-row");
    const inp = el("input", "tq-input") as HTMLInputElement;
    inp.maxLength = 60;
    inp.placeholder = "e.g. a lighthouse";
    inp.setAttribute("aria-label", "Your secret");
    row.appendChild(inp);
    const go = el("button", "duel-btn tq-go", "Hold this secret") as HTMLButtonElement;
    go.type = "button";
    go.disabled = true;
    inp.addEventListener("input", () => (go.disabled = !inp.value.trim()));
    inp.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && inp.value.trim()) onSend(inp.value.trim());
    });
    go.addEventListener("click", () => {
      if (inp.value.trim()) onSend(inp.value.trim());
    });
    row.appendChild(go);
    wrap.appendChild(row);
    const rnd = el("button", "duel-btn quiet sm tq-random", "Draw one at random") as HTMLButtonElement;
    rnd.type = "button";
    rnd.addEventListener("click", () => onSend("random"));
    wrap.appendChild(rnd);
    return wrap;
  }
  wrap.appendChild(el("div", "tq-secret", "Your secret: " + (you.secret || "")));
  const p = g.pending;
  if (g.phase === "answer" && p) {
    const guess = p.kind === "guess";
    wrap.appendChild(el("div", "tq-title", (guess ? p.by + " guesses:" : p.by + " asks:")));
    wrap.appendChild(el("div", "tq-q", guess ? "“" + p.q + "”" : p.q));
    const note = el("input", "tq-input tq-note") as HTMLInputElement;
    note.maxLength = 80;
    note.placeholder = "A note, if you like (flavour, never a hint)";
    note.setAttribute("aria-label", "A note with your answer");
    wrap.appendChild(note);
    const acts = el("div", "tq-acts");
    const btn = (label: string, word: string, cls: string) => {
      const b = el("button", "duel-btn " + cls, label) as HTMLButtonElement;
      b.type = "button";
      b.addEventListener("click", () => onSend(word + (note.value.trim() && word !== "unanswerable" ? " - " + note.value.trim() : "")));
      acts.appendChild(b);
    };
    if (guess) {
      btn("Right", "right", "tq-yes");
      btn("Wrong", "wrong", "tq-no");
    } else {
      btn("Yes", "yes", "tq-yes");
      btn("No", "no", "tq-no");
      btn("Unanswerable", "unanswerable", "quiet sm tq-flag");
    }
    wrap.appendChild(acts);
  } else wrap.appendChild(el("div", "tq-help", "Waiting for a question."));
  return wrap;
}

/* A questioner: ask a yes/no question, or guess. */
export function tqAsker(g: GL, draft: { text: string }, onSend: (dir: string) => void): HTMLElement {
  const wrap = el("div", "tq-panel your-move");
  wrap.appendChild(el("div", "tq-title", "Ask " + g.answerer + " a yes/no question - or guess"));
  const inp = el("input", "tq-input") as HTMLInputElement;
  inp.maxLength = 160;
  inp.placeholder = "Is it alive?";
  inp.value = draft.text;
  inp.setAttribute("aria-label", "Your question or guess");
  wrap.appendChild(inp);
  const acts = el("div", "tq-acts");
  const ask = el("button", "duel-btn tq-go", "Ask") as HTMLButtonElement;
  ask.type = "button";
  const guess = el("button", "duel-btn quiet tq-guess", "Guess it") as HTMLButtonElement;
  guess.type = "button";
  const sync = () => {
    draft.text = inp.value;
    ask.disabled = guess.disabled = !inp.value.trim();
  };
  inp.addEventListener("input", sync);
  inp.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && inp.value.trim()) onSend(inp.value.trim());
  });
  sync();
  ask.addEventListener("click", () => inp.value.trim() && onSend(inp.value.trim()));
  guess.addEventListener("click", () => inp.value.trim() && onSend("guess: " + inp.value.trim().replace(/^is it\s+/i, "").replace(/\?$/, "")));
  acts.appendChild(el("span", "tq-help", (g.remaining || 0) + " of 20 left · a guess costs one too"));
  acts.appendChild(guess);
  acts.appendChild(ask);
  wrap.appendChild(acts);
  return wrap;
}

/* The budget: twenty pips, spent ones lit by their answer. */
export function tqBudget(g: GL): HTMLElement {
  const box = el("div", "tq-budget");
  box.setAttribute("aria-label", (g.asked || 0) + " of 20 questions asked");
  const spent = ((g.qa || []) as GL[]).filter((x) => !x.flagged && x.a);
  for (let i = 0; i < 20; i++) {
    const e = spent[i];
    box.appendChild(el("span", "tq-pip" + (e ? " " + (e.a === "yes" || e.a === "right" ? "yes" : "no") : "")));
  }
  return box;
}

/* The public Q/A log. */
export function tqLog(g: GL): HTMLElement {
  const box = el("div", "tq-log");
  const qa: GL[] = g.qa || [];
  if (!qa.length) {
    box.appendChild(el("div", "tq-log-empty", g.phase === "secret" ? (g.answerer || "The answerer") + " is choosing a secret." : "No questions yet."));
    return box;
  }
  let k = 0;
  qa.forEach((x) => {
    const row = el("div", "tq-qa" + (x.flagged ? " flagged" : "") + (x.kind === "guess" ? " guess" : ""));
    row.appendChild(el("span", "tq-qa-n", x.flagged ? "–" : String(++k)));
    const who = el("span", "tq-qa-by", x.by);
    who.style.color = hexOf(g, x.by);
    row.appendChild(who);
    row.appendChild(el("span", "tq-qa-q", (x.kind === "guess" ? "Guess: " : "") + x.q));
    const a = x.flagged ? "unanswerable" : x.a ? x.a.toUpperCase() : "…";
    row.appendChild(el("span", "tq-qa-a " + (x.a === "yes" || x.a === "right" ? "yes" : x.a ? "no" : ""), a + (x.note ? " · " + x.note : "")));
    box.appendChild(row);
  });
  return box;
}

export function tqScores(g: GL, me?: string, compact?: boolean): HTMLElement {
  const box = el("div", "tq-scores" + (compact ? " compact" : ""));
  const ps: GL[] = ((g.players || []) as GL[]).slice().sort((a, b) => (b.score || 0) - (a.score || 0));
  ps.forEach((p) => {
    const row = el("div", "tq-srow" + (me && p.name === me ? " mine" : "") + (g.status === "running" && g.answerer === p.name ? " answerer" : ""));
    const d = el("span", "hist-dot");
    d.style.background = p.hex;
    row.appendChild(d);
    row.appendChild(el("span", "tq-name", p.name + (me && p.name === me ? " (you)" : "")));
    if (!compact && g.status === "running" && g.answerer === p.name) row.appendChild(el("span", "tq-st", "answering"));
    row.appendChild(el("span", "tq-pts", String(p.score || 0)));
    box.appendChild(row);
  });
  return box;
}

/* The last round: the secret, how it ended, the points. */
export function tqReveal(g: GL, r: GL | null): HTMLElement {
  const box = el("div", "tq-reveal");
  if (!r) {
    box.appendChild(el("div", "tq-log-empty", "No secret has been revealed yet."));
    return box;
  }
  const head = el("div", "tq-reveal-head");
  head.appendChild(el("span", "", "Round " + r.n + " · " + r.answerer + "'s secret was "));
  head.appendChild(el("span", "tq-reveal-secret", "“" + r.secret + "”" + (r.drawn ? " (drawn)" : "")));
  box.appendChild(head);
  const how =
    r.how === "guessed" ? r.guessed_by + " named it after " + r.asked + (r.asked === 1 ? " question" : " questions") : r.how === "forfeit" ? r.answerer + " went silent and forfeit the round" : r.how === "idle" ? "The table stopped asking - " + r.answerer + " takes it" : "Twenty questions spent - " + r.answerer + " takes it";
  box.appendChild(el("div", "tq-reveal-how", how));
  const pts = Object.keys(r.points || {})
    .filter((n) => r.points[n])
    .map((n) => n + " +" + r.points[n]);
  if (pts.length) box.appendChild(el("div", "tq-reveal-pts", pts.join(" · ")));
  return box;
}

export function tqHistoryRows(g: GL, row: (idx: string) => HTMLElement, who: (p: GL) => HTMLElement, list: HTMLElement): number {
  let n = 0;
  const players: GL[] = g.players || [];
  const byName = (nm: string): GL => players.find((p) => p.name === nm) || { name: nm, hex: "#94a3b8" };
  ((g.rounds || []) as GL[]).forEach((r: GL) => {
    n++;
    const rw = row("Round " + r.n);
    const seg = el("span", "hist-seg");
    seg.appendChild(who(byName(r.answerer)));
    seg.appendChild(el("span", "hist-act", "“" + r.secret + "”"));
    rw.appendChild(seg);
    rw.appendChild(el("span", "hist-pill " + (r.how === "guessed" ? "win" : "tie"), r.how === "guessed" ? r.guessed_by + " in " + r.asked : r.answerer + " held"));
    list.appendChild(rw);
  });
  return n;
}

export function tqCardBoard(g: GL, me?: string): HTMLElement {
  const wrap = el("div", "tq-card");
  const line =
    g.status === "running" && g.answerer
      ? "Round " + g.round + " of " + g.rounds_total + " · " + g.answerer + (g.phase === "secret" ? " is choosing a secret" : " answers · " + (g.asked || 0) + " of 20 asked")
      : g.status === "finished"
        ? "Finished · " + (g.rounds_total || 0) + " rounds"
        : (g.rounds_total || 0) + " rounds";
  wrap.appendChild(el("div", "tq-card-line", line));
  wrap.appendChild(tqScores(g, me, true));
  return wrap;
}
