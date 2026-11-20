import { el } from "../../../lib/index";
import type { GL } from "../shared/render";

/* Exquisite Corpse in the page (2026-11-20), under the 3D desk: your turn
   (the fold - only the segment before yours - and your segment), the
   turn strip (who wrote, who missed; never what), the revealed story
   with its authors and the favourite vote, the writers, the history and
   the chat card. Nothing of the text is shown before the reveal except a
   writer's own tail. */

export const EC_MAX = 400;
const hexOf = (g: GL, n: string) => (((g && g.players) || []).find((p: GL) => p.name === n) || { hex: "#94a3b8" }).hex;

export function ecSentences(text: string): number {
  return String(text)
    .split(/(?<=[.!?…])["'”’)\]]*\s+/)
    .filter((x) => /[A-Za-z0-9]/.test(x)).length;
}

/* Your turn: the fold and the form. The draft lives with the caller and
   is kept in place as you type (a repaint would drop the focus). */
export function ecWriter(g: GL, draft: { turn: number; text: string }, onSend: (text: string) => void): HTMLElement {
  const you = g.you || {};
  const wrap = el("div", "ec-writer your-move");
  wrap.appendChild(el("div", "ec-writer-title", "Your turn - carry the story on"));
  const fold = el("div", "ec-fold");
  fold.appendChild(el("div", "ec-fold-k", g.segments ? "The segment before yours (the rest is folded away):" : "The seed line:"));
  fold.appendChild(el("div", "ec-fold-text", you.tail || ""));
  wrap.appendChild(fold);
  if (g.genre) wrap.appendChild(el("div", "ec-rule", "Genre: " + g.genre));
  if (you.constraint) wrap.appendChild(el("div", "ec-rule", "Your secret constraint: " + you.constraint));
  const ta = el("textarea", "ec-input") as HTMLTextAreaElement;
  ta.rows = 3;
  ta.maxLength = EC_MAX;
  ta.placeholder = "One to three sentences…";
  ta.value = draft.text;
  ta.setAttribute("aria-label", "Your segment");
  wrap.appendChild(ta);
  const acts = el("div", "ec-acts");
  const count = el("span", "ec-count", "");
  acts.appendChild(count);
  const go = el("button", "duel-btn ec-go", "Add to the story") as HTMLButtonElement;
  go.type = "button";
  const check = () => {
    const t = ta.value.trim();
    const n = t ? ecSentences(t) : 0;
    count.textContent = (n === 1 ? "1 sentence" : n + " sentences") + " · " + ta.value.length + "/" + EC_MAX;
    count.classList.toggle("over", n > 3);
    go.disabled = !t || n > 3;
  };
  ta.addEventListener("input", () => {
    draft.text = ta.value;
    check();
  });
  check();
  go.addEventListener("click", () => {
    const t = ta.value.trim();
    if (t && ecSentences(t) <= 3) onSend(t);
  });
  acts.appendChild(go);
  wrap.appendChild(acts);
  return wrap;
}

/* The turn strip: a chip per turn - written (the author's colour), a
   silent beat (dashed), the turn now (pulsing), the ones to come. */
export function ecStrip(g: GL): HTMLElement {
  const box = el("div", "ec-strip");
  const beats: GL[] = g.beats || [];
  const total = g.turns_total || 0;
  box.setAttribute("aria-label", beats.filter((b) => b.wrote).length + " segments written of " + total + " turns");
  for (let t = 1; t <= total; t++) {
    const b = beats.find((x) => x.turn === t);
    const now = g.status === "running" && g.phase === "write" && g.turn === t;
    const c = el("span", "ec-beat" + (b ? (b.wrote ? " wrote" : " silent") : now ? " now" : ""));
    if (b && b.wrote) c.style.background = hexOf(g, b.by);
    if (now && g.turn_of) c.style.borderColor = hexOf(g, g.turn_of);
    c.title = b ? b.by + (b.wrote ? " wrote" : " missed the turn") : now ? g.turn_of + " is writing" : "to come";
    box.appendChild(c);
  }
  return box;
}

/* The revealed story: the seed, then every segment with its author (and
   constraint card), the favourite vote, and at the end the votes and
   the honours. */
export function ecStory(g: GL, onVote?: (n: number) => void): HTMLElement {
  const you = g.you || {};
  const box = el("div", "ec-story" + (onVote ? " your-move" : ""));
  if (g.seed) box.appendChild(el("div", "ec-seed", g.seed));
  const honours: number[] = g.honours || [];
  ((g.story || []) as GL[]).forEach((s) => {
    const mine = s.by === you.name || (you.segments || []).indexOf(s.n) >= 0;
    const voted = you.vote === s.n;
    const best = honours.indexOf(s.n) >= 0;
    const seg = el("div", "ec-seg" + (voted ? " voted" : "") + (best ? " best" : ""));
    const head = el("div", "ec-seg-head");
    head.appendChild(el("span", "ec-seg-n", String(s.n)));
    const who = el("span", "ec-seg-by", s.by);
    who.style.color = hexOf(g, s.by);
    head.appendChild(who);
    const card = (g.constraints || {})[s.by];
    if (card) head.appendChild(el("span", "ec-seg-card", card));
    const n = (g.votes || {})[s.n];
    if (n) head.appendChild(el("span", "ec-seg-votes", (best ? "★ " : "") + n + (n === 1 ? " vote" : " votes")));
    seg.appendChild(head);
    seg.appendChild(el("div", "ec-seg-text", s.text));
    if (onVote && !mine) {
      const b = el("button", "duel-btn quiet sm ec-vote", voted ? "Your favourite ✓" : "Favourite") as HTMLButtonElement;
      b.type = "button";
      b.setAttribute("aria-pressed", voted ? "true" : "false");
      b.addEventListener("click", () => onVote(s.n));
      seg.appendChild(b);
    }
    box.appendChild(seg);
  });
  return box;
}

/* The writers: segments written, who is writing, who is out, who voted. */
export function ecWriters(g: GL, me?: string, compact?: boolean): HTMLElement {
  const box = el("div", "ec-writers" + (compact ? " compact" : ""));
  const order: string[] = g.order || [];
  const ps: GL[] = ((g.players || []) as GL[]).slice().sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name));
  ps.forEach((p) => {
    const row = el("div", "ec-row" + (me && p.name === me ? " mine" : "") + (g.status === "running" && g.turn_of === p.name ? " turn" : "") + (p.out ? " out" : ""));
    const d = el("span", "hist-dot");
    d.style.background = p.hex;
    row.appendChild(d);
    row.appendChild(el("span", "ec-name", p.name + (me && p.name === me ? " (you)" : "")));
    let st = p.out ? "out of the rotation" : "";
    if (!st && g.status === "running") {
      if (g.phase === "write" && g.turn_of === p.name) st = "writing…";
      else if (g.phase === "vote") st = p.committed ? "voted ✓" : "reading…";
    }
    if (!st && g.status === "finished" && p.votes) st = "★ " + p.votes;
    if (st && !compact) row.appendChild(el("span", "ec-st", st));
    row.appendChild(el("span", "ec-segs", (p.segments || 0) + (p.segments === 1 ? " segment" : " segments")));
    box.appendChild(row);
  });
  return box;
}

/* History: a row per turn - who wrote (and, once revealed, what), or a
   silent beat. */
export function ecHistoryRows(g: GL, row: (idx: string) => HTMLElement, who: (p: GL) => HTMLElement, list: HTMLElement): number {
  let n = 0;
  const players: GL[] = g.players || [];
  const byName = (nm: string): GL => players.find((p) => p.name === nm) || { name: nm, hex: "#94a3b8" };
  const story: GL[] = g.story || [];
  let k = 0;
  ((g.beats || []) as GL[]).forEach((b: GL) => {
    n++;
    const rw = row("Turn " + b.turn);
    const seg = el("span", "hist-seg");
    seg.appendChild(who(byName(b.by)));
    if (b.wrote) {
      const s = story[k++];
      seg.appendChild(el("span", "hist-act", s ? "“" + (s.text.length > 80 ? s.text.slice(0, 77) + "…" : s.text) + "”" : "wrote a segment (hidden until the reveal)"));
    } else seg.appendChild(el("span", "hist-act", "a silent beat"));
    rw.appendChild(seg);
    list.appendChild(rw);
  });
  return n;
}

/* The card: where the story is, and the writers. */
export function ecCardBoard(g: GL, me?: string): HTMLElement {
  const wrap = el("div", "ec-card");
  let line = "";
  if (g.status === "running" && g.phase === "write") line = "Turn " + g.turn + " of " + g.turns_total + " · " + g.turn_of + " is writing";
  else if (g.status === "running") line = "The story is revealed · vote for a favourite";
  else if (g.status === "finished") line = "Finished · " + (g.segments || 0) + " segments";
  else line = (g.turns_total || 0) + " turns";
  wrap.appendChild(el("div", "ec-card-line", line + (g.genre ? " · " + g.genre : "")));
  wrap.appendChild(ecWriters(g, me, true));
  return wrap;
}
