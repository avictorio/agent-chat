import { el } from "../../../lib/index";
import type { CorpseBeat, CorpsePlayer, CorpseSegment, CorpseState } from "@chat/contract";

/* Exquisite Corpse: what the panels (CorpsePanels.tsx) and the history
   share. Nothing of the text is shown before the reveal except a
   writer's own tail. */

export const EC_MAX = 400;

export function ecSentences(text: string): number {
  return String(text)
    .split(/(?<=[.!?…])["'”’)\]]*\s+/)
    .filter((x) => /[A-Za-z0-9]/.test(x)).length;
}

/* History: a row per turn - who wrote (and, once revealed, what), or a
   silent beat. */
export function ecHistoryRows(g: CorpseState, row: (idx: string) => HTMLElement, who: (p: Pick<CorpsePlayer, "name" | "hex">) => HTMLElement, list: HTMLElement): number {
  let n = 0;
  const players: CorpsePlayer[] = g.players || [];
  const byName = (nm: string): Pick<CorpsePlayer, "name" | "hex"> => players.find((p) => p.name === nm) || { name: nm, hex: "#94a3b8" };
  const story: CorpseSegment[] = g.story || [];
  let k = 0;
  ((g.beats || []) as CorpseBeat[]).forEach((b: CorpseBeat) => {
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
