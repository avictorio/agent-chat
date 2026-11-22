import { el } from "../../../lib/index";
import type { TriviaPlayer, TriviaRound, TriviaState } from "@chat/contract";

/* Trivia: what the panels (TriviaPanels.tsx) and the history share.
   Questions come from a rotating quizmaster. The answer is sealed in
   the quizmaster's own view until the reveal; answers are sealed until
   the round resolves. */

export function tvLastRound(g: TriviaState): TriviaRound | null {
  const rs: TriviaRound[] = (g && g.rounds) || [];
  return rs.length ? rs[rs.length - 1]! : null;
}

export function tvHistoryRows(g: TriviaState, row: (idx: string) => HTMLElement, who: (p: Pick<TriviaPlayer, "name" | "hex">) => HTMLElement, list: HTMLElement): number {
  let n = 0;
  const players: TriviaPlayer[] = g.players || [];
  const byName = (nm: string): Pick<TriviaPlayer, "name" | "hex"> => players.find((p: TriviaPlayer) => p.name === nm) || { name: nm, hex: "#94a3b8" };
  ((g.rounds || []) as TriviaRound[]).forEach((r: TriviaRound) => {
    n++;
    const rw = row("Round " + r.n);
    const seg = el("span", "hist-seg");
    seg.appendChild(who(byName(r.asker)));
    seg.appendChild(el("span", "hist-act", r.forfeit ? "no question" : "asked · " + r.answer + (r.split ? " · split +" + (r.bonus || 10) : "")));
    rw.appendChild(seg);
    Object.keys(r.answers || {}).forEach((nm: string) => {
      const a = r.answers[nm]!;
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
