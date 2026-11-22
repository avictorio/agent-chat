import { useState, type CSSProperties, type ReactNode } from "react";
import type { CorpseBeat, CorpsePlayer, CorpseSegment, CorpseState, CorpseYou } from "@chat/contract";
import { EC_MAX, ecSentences } from "./corpse";

/* Exquisite Corpse's panels, under the 3D desk: your turn (the fold -
   only the segment before yours - and your segment), the turn strip
   (who wrote, who missed; never what), the revealed story with its
   authors and the favourite vote, the writers and the chat card. The
   view (view.tsx) mounts them with ctx.panel, so the segment you are
   writing is the writer's own state and survives the view's repaints.
   Nothing of the text is shown before the reveal except a writer's own
   tail. */

const hexOf = (g: CorpseState, n: string) => (((g && g.players) || []).find((p: CorpsePlayer) => p.name === n) || { hex: "#94a3b8" }).hex;

/* Your turn: the fold and the form. The view keys it by turn, so the
   draft starts over each turn; the box keeps what you type in place.
   Uncontrolled field: see docs/agents/games.md, Panels. */
export function CorpseWriter({ g, onSend }: { g: CorpseState; onSend: (text: string) => void }) {
  const you: Partial<CorpseYou> = g.you || {};
  const [text, setText] = useState("");
  const t = text.trim();
  const n = t ? ecSentences(t) : 0;
  return (
    <div className="ec-writer your-move">
      <div className="ec-writer-title">Your turn - carry the story on</div>
      <div className="ec-fold">
        <div className="ec-fold-k">{g.segments ? "The segment before yours (the rest is folded away):" : "The seed line:"}</div>
        <div className="ec-fold-text">{you.tail || ""}</div>
      </div>
      {g.genre ? <div className="ec-rule">{"Genre: " + g.genre}</div> : null}
      {you.constraint ? <div className="ec-rule">{"Your secret constraint: " + you.constraint}</div> : null}
      <textarea className="ec-input" rows={3} maxLength={EC_MAX} placeholder="One to three sentences…" aria-label="Your segment" onChange={(e) => setText(e.target.value)} />
      <div className="ec-acts">
        <span className={"ec-count" + (n > 3 ? " over" : "")}>{(n === 1 ? "1 sentence" : n + " sentences") + " · " + text.length + "/" + EC_MAX}</span>
        <button
          type="button"
          className="duel-btn ec-go"
          disabled={!t || n > 3}
          onClick={() => {
            if (t && ecSentences(t) <= 3) onSend(t);
          }}
        >
          Add to the story
        </button>
      </div>
    </div>
  );
}

/* The turn strip: a chip per turn - written (the author's colour), a
   silent beat (dashed), the turn now (pulsing), the ones to come. A chip
   is keyed by its state too, so one that changes is made afresh (a
   silent beat keeps no empty style from its turn). */
export function CorpseStrip({ g }: { g: CorpseState }) {
  const beats: CorpseBeat[] = g.beats || [];
  const total = g.turns_total || 0;
  const chips: ReactNode[] = [];
  for (let t = 1; t <= total; t++) {
    const b = beats.find((x) => x.turn === t);
    const now = g.status === "running" && g.phase === "write" && g.turn === t;
    const cls = "ec-beat" + (b ? (b.wrote ? " wrote" : " silent") : now ? " now" : "");
    const style: CSSProperties = {};
    if (b && b.wrote) style.background = hexOf(g, b.by);
    if (now && g.turn_of) style.borderColor = hexOf(g, g.turn_of);
    chips.push(<span key={t + ":" + cls} className={cls} style={style} title={b ? b.by + (b.wrote ? " wrote" : " missed the turn") : now ? g.turn_of + " is writing" : "to come"}></span>);
  }
  return (
    <div className="ec-strip" aria-label={beats.filter((b) => b.wrote).length + " segments written of " + total + " turns"}>
      {chips}
    </div>
  );
}

/* The revealed story: the seed, then every segment with its author (and
   constraint card), the favourite vote, and at the end the votes and
   the honours. */
export function CorpseStory({ g, onVote }: { g: CorpseState; onVote?: (n: number) => void }) {
  const you: Partial<CorpseYou> = g.you || {};
  const honours: number[] = g.honours || [];
  return (
    <div className={"ec-story" + (onVote ? " your-move" : "")}>
      {g.seed ? <div className="ec-seed">{g.seed}</div> : null}
      {((g.story || []) as CorpseSegment[]).map((s) => {
        const mine = (you.segments || []).indexOf(s.n) >= 0;
        const voted = you.vote === s.n;
        const best = honours.indexOf(s.n) >= 0;
        const card = (g.constraints || {})[s.by];
        const n = (g.votes || {})[s.n];
        return (
          <div key={s.n} className={"ec-seg" + (voted ? " voted" : "") + (best ? " best" : "")}>
            <div className="ec-seg-head">
              <span className="ec-seg-n">{String(s.n)}</span>
              <span className="ec-seg-by" style={{ color: hexOf(g, s.by) }}>
                {s.by}
              </span>
              {card ? <span className="ec-seg-card">{card}</span> : null}
              {n ? <span className="ec-seg-votes">{(best ? "★ " : "") + n + (n === 1 ? " vote" : " votes")}</span> : null}
            </div>
            <div className="ec-seg-text">{s.text}</div>
            {onVote && !mine ? (
              <button type="button" className="duel-btn quiet sm ec-vote" aria-pressed={voted ? "true" : "false"} onClick={() => onVote(s.n)}>
                {voted ? "Your favourite ✓" : "Favourite"}
              </button>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

/* The writers: segments written, who is writing, who is out, who voted. */
export function CorpseWriters({ g, me, compact }: { g: CorpseState; me?: string; compact?: boolean }) {
  const order: string[] = g.order || [];
  const ps: CorpsePlayer[] = ((g.players || []) as CorpsePlayer[]).slice().sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name));
  return (
    <div className={"ec-writers" + (compact ? " compact" : "")}>
      {ps.map((p) => {
        const mine = !!me && p.name === me;
        let st = p.out ? "out of the rotation" : "";
        if (!st && g.status === "running") {
          if (g.phase === "write" && g.turn_of === p.name) st = "writing…";
          else if (g.phase === "vote") st = p.committed ? "voted ✓" : "reading…";
        }
        if (!st && g.status === "finished" && p.votes) st = "★ " + p.votes;
        return (
          <div key={p.name} className={"ec-row" + (mine ? " mine" : "") + (g.status === "running" && g.turn_of === p.name ? " turn" : "") + (p.out ? " out" : "")}>
            <span className="hist-dot" style={{ background: p.hex }}></span>
            <span className="ec-name">{p.name + (mine ? " (you)" : "")}</span>
            {st && !compact ? <span className="ec-st">{st}</span> : null}
            <span className="ec-segs">{(p.segments || 0) + (p.segments === 1 ? " segment" : " segments")}</span>
          </div>
        );
      })}
    </div>
  );
}

/* The card: where the story is, and the writers. */
export function CorpseCard({ g, me }: { g: CorpseState; me: string }) {
  let line = "";
  if (g.status === "running" && g.phase === "write") line = "Turn " + g.turn + " of " + g.turns_total + " · " + g.turn_of + " is writing";
  else if (g.status === "running") line = "The story is revealed · vote for a favourite";
  else if (g.status === "finished") line = "Finished · " + (g.segments || 0) + " segments";
  else line = (g.turns_total || 0) + " turns";
  return (
    <div className="ec-card">
      <div className="ec-card-line">{line + (g.genre ? " · " + g.genre : "")}</div>
      <CorpseWriters g={g} me={me} compact />
    </div>
  );
}
