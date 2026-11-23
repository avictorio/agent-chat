import { useLayoutEffect, useRef, type CSSProperties, type ReactElement, type ReactNode } from "react";
import type { LetterGridPlayer, LetterGridRound, LetterGridState, LetterGridYou } from "@chat/contract";
import { lgLabel, lgLastRound, lgTrace, type LgDraft } from "./lettergrid";

/* Letter Grid's panels: the scoreboard, the word panel under the scene,
   your words, the last round's words, the grid's longest words at the
   end and the chat card. The view (view.tsx) mounts them with
   ctx.panel. The word being made is not the panel's own state: the
   scene edits it too (a tap on a tile traces it), so it stays on the
   open view (gameView.lgDraft) and the view renders the panel again
   whenever it changes, from either side. */

function status(g: LetterGridState, p: LetterGridPlayer): string {
  if (p.out) return "out";
  if (g.status === "running") return p.committed ? "word in ✓" : "thinking…";
  return "";
}

/* The scoreboard, highest first: cells claimed beside the score. */
export function LetterGridScores({ g, me, compact }: { g: LetterGridState; me?: string; compact?: boolean }) {
  const ps: LetterGridPlayer[] = ((g && g.players) || []).slice().sort((a: LetterGridPlayer, b: LetterGridPlayer) => (b.score || 0) - (a.score || 0) || (b.cells || 0) - (a.cells || 0) || (a.name < b.name ? -1 : 1));
  return (
    <div className={"lg-scores" + (compact ? " compact" : "")}>
      {ps.map((p: LetterGridPlayer, i: number) => {
        const mine = !!me && p.name === me;
        const st = compact ? "" : status(g, p);
        return (
          <div key={p.name} className={"lg-row" + (p.out ? " out" : "") + (mine ? " mine" : "")} style={{ "--who": p.hex || "#94a3b8" } as CSSProperties}>
            <span className="lg-rank">{String(i + 1)}</span>
            <span className="hist-dot" style={{ background: p.hex }}></span>
            <span className="lg-name">{p.name + (mine ? " (you)" : "")}</span>
            <span className="lg-cells" title={(p.cells || 0) + " cells claimed"}>
              {"▦ " + (p.cells || 0)}
            </span>
            {st ? <span className="lg-st">{st}</span> : null}
            <span className="lg-score">{String(p.score || 0)}</span>
          </div>
        );
      })}
    </div>
  );
}

/* The word panel: an input (typing traces the best path), the path as
   cells, what it would score, Send and Clear. Typing and Clear report
   the new draft (onDraft), and the view renders the panel again with
   it, as it does after a tap in the scene. The field follows the draft
   only when they differ, so typing keeps its caret. Uncontrolled field:
   see docs/agents/games.md, Panels. */
export function LetterGridWordPanel({ g, draft, onDraft, onSend }: { g: LetterGridState; draft: LgDraft; onDraft: (d: LgDraft) => void; onSend: (d: LgDraft) => void }) {
  const n: number = g.size || 5;
  const min: number = g.min_len || 3;
  const claims: (string | null)[] = g.claims || [];
  const played: string[] = (g.you && g.you.played) || [];
  const input = useRef<HTMLInputElement>(null);
  const w = draft.word;
  // the field spells the draft (a tap in the scene, Clear, a stray
  // character typed), on every render
  useLayoutEffect(() => {
    const f = input.current;
    if (f && f.value.toLowerCase() !== w) f.value = w.toUpperCase();
  });
  let ok = false;
  let why: ReactNode = null;
  if (!w) why = <span className="lg-hint">{"Letters must touch in order - across, up, down or diagonal - each tile once. " + min + "+ letters."}</span>;
  else if (!draft.path) why = <span className="lg-bad">{w.toUpperCase() + " can't be traced on this grid"}</span>;
  else if (w.length < min) why = <span className="lg-hint">{"At least " + min + " letters"}</span>;
  else if (played.indexOf(w) >= 0) why = <span className="lg-bad">{"You've played " + w.toUpperCase() + " already"}</span>;
  else ok = true;
  const path = draft.path;
  const free = path ? path.filter(([r, c]) => !claims[r! * n + c!]).length : 0;
  return (
    <div className="lg-panel">
      <div className="lg-word-row">
        <input
          ref={input}
          className="lg-word"
          type="text"
          placeholder="Type a word, or tap the tiles"
          maxLength={n * n}
          autoComplete="off"
          spellCheck={false}
          autoCapitalize="characters"
          aria-label="Your word"
          onInput={(e) => {
            const v = e.currentTarget.value.toLowerCase().replace(/[^a-z]/g, "");
            onDraft({ round: draft.round, word: v, path: v ? lgTrace(g, v) : null, tapped: false });
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && ok) {
              e.preventDefault();
              onSend(draft);
            }
          }}
        />
        <button
          type="button"
          className="btn lg-send"
          disabled={!ok}
          onClick={() => {
            if (ok) onSend(draft);
          }}
        >
          Send
        </button>
        <button type="button" className="btn sm lg-clear" onClick={() => onDraft({ round: draft.round, word: "", path: null, tapped: false })}>
          Clear
        </button>
      </div>
      <div className="lg-trace" aria-live="polite">
        {why}
        {path && w ? (
          <span className="lg-cellrow">
            {path.map(([r, c], i) => (
              <span key={i} className={"lg-cell" + (claims[r! * n + c!] ? " taken" : " free")}>
                {(w[i] || "").toUpperCase() + " " + lgLabel(r!, c!)}
              </span>
            ))}
          </span>
        ) : null}
        {ok ? <span className="lg-preview">{"+" + w.length + (free ? " · +" + free + (free === 1 ? " cell" : " cells") + " if nobody else takes " + (free === 1 ? "it" : "them") : "")}</span> : null}
      </div>
    </div>
  );
}

/* Your sealed word, and the words you've played (the view mounts it
   when there is either). */
export function LetterGridYours({ g }: { g: LetterGridState }) {
  const you: Partial<LetterGridYou> = g.you || {};
  const played: string[] = you.played || [];
  return (
    <div className="lg-yours">
      {you.queued ? <div className="lg-queued">{"Your word is in: " + String(you.queued.word).toUpperCase() + " - you can change it until the round resolves."}</div> : null}
      {played.length ? (
        <div className="lg-played">
          <span className="lg-played-cap">Played:</span>
          {played.map((pw, i) => (
            <span key={i} className="lg-chip">
              {pw.toUpperCase()}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/* One round's words, best first: the word, its points, and what happened
   to its cells. */
export function LetterGridReveal({ g, round, me }: { g: LetterGridState; round: LetterGridRound; me?: string }) {
  const players: LetterGridPlayer[] = g.players || [];
  const names = players.map((p: LetterGridPlayer) => p.name).filter((nm: string) => (round.words || {})[nm] || (round.missed || []).indexOf(nm) >= 0);
  names.sort((a: string, b: string) => ((round.points || {})[b] || 0) - ((round.points || {})[a] || 0) || (a < b ? -1 : 1));
  return (
    <div className="lg-reveal">
      <div className="fl-cap">{"Round " + round.n + " · the words"}</div>
      {names.map((nm: string) => {
        const p = players.find((x: LetterGridPlayer) => x.name === nm) || { name: nm, hex: "#94a3b8" };
        const w = (round.words || {})[nm];
        const notes: string[] = [];
        if (w) {
          if (w.dup) notes.push("shared word - no claims");
          else if (w.bonus) notes.push("+" + w.bonus + (w.bonus === 1 ? " cell" : " cells"));
          if ((w.contested || []).length) notes.push((w.contested.length === 1 ? "1 cell" : w.contested.length + " cells") + " contested");
        }
        return (
          <div key={nm} className={"lg-rv" + (me && nm === me ? " mine" : "")} style={{ "--who": p.hex || "#94a3b8" } as CSSProperties}>
            <span className="hist-dot" style={{ background: p.hex }}></span>
            <span className="lg-rv-name">{nm}</span>
            {!w ? (
              <>
                <span className="lg-rv-word none">no word</span>
                <span className="lg-rv-pts">+0</span>
              </>
            ) : (
              <>
                <span className="lg-rv-word">{String(w.word).toUpperCase()}</span>
                {notes.length ? <span className="lg-rv-note">{notes.join(" · ")}</span> : null}
                <span className="lg-rv-pts">{"+" + ((round.points || {})[nm] || 0)}</span>
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}

/* The end: the grid's longest words, which nobody may have found (the
   view mounts it when there are any). */
export function LetterGridTopWords({ g }: { g: LetterGridState }) {
  const top: string[] = g.top_words || [];
  return (
    <div className="lg-top">
      <span className="lg-played-cap">{"The grid's longest words:"}</span>
      {top.slice(0, 6).map((tw, i) => (
        <span key={i} className="lg-chip">
          {tw.toUpperCase()}
        </span>
      ))}
      {g.word_count ? <span className="lg-played-cap">{"(" + g.word_count + " words in all)"}</span> : null}
    </div>
  );
}

/* The grid as flat tiles, claims in their owner's colour: the card's
   small grid, and without 3D the arena's board, where a tap on a tile
   traces the word (onTap) and the draft's path is lit. */
export function LetterGridTiles({ g, path, onTap, big }: { g: LetterGridState; path?: number[][] | null; onTap?: (r: number, c: number) => void; big?: boolean }) {
  const grid: string[] = g.grid || [];
  const n = grid.length;
  const claims: (string | null)[] = g.claims || [];
  const hexOf: Record<string, string> = {};
  (g.players || []).forEach((p: LetterGridPlayer) => (hexOf[p.name] = p.hex));
  const on = new Set((path || []).map(([r, c]) => r! * n + c!));
  const cells: ReactElement[] = [];
  for (let r = 0; r < n; r++)
    for (let c = 0; c < n; c++) {
      const owner = claims[r * n + c];
      const letter = (grid[r]![c] || "").toUpperCase();
      const cls = "lg-mini-cell" + (owner ? " owned" : "") + (on.has(r * n + c) ? " on" : "");
      const style = owner ? ({ "--who": hexOf[owner] || "#94a3b8" } as CSSProperties) : undefined;
      const rr = r;
      const cc = c;
      // keyed by owner too: a cell's style comes with its claim
      cells.push(
        onTap ? (
          <button key={r * n + c + ":" + (owner || "")} type="button" className={cls} style={style} aria-label={letter + " at " + lgLabel(r, c) + (owner ? ", claimed by " + owner : "")} aria-pressed={on.has(r * n + c)} onClick={() => onTap(rr, cc)}>
            {letter}
          </button>
        ) : (
          <span key={r * n + c + ":" + (owner || "")} className={cls} style={style}>
            {letter}
          </span>
        )
      );
    }
  if (!n) return null;
  return (
    <div className={"lg-mini" + (big ? " big" : "")} style={{ gridTemplateColumns: "repeat(" + n + ", 1fr)" }}>
      {cells}
    </div>
  );
}

/* The card: a small flat grid, the scores, and the last round's best
   word. */
export function LetterGridCard({ g, me }: { g: LetterGridState; me: string }) {
  const last = lgLastRound(g);
  let cap = "";
  if (last) {
    const best = Object.keys(last.words || {}).sort((a, b) => ((last.points || {})[b] || 0) - ((last.points || {})[a] || 0))[0];
    if (best) cap = "Round " + last.n + ": " + String(last.words[best]!.word).toUpperCase() + " (" + best + ", +" + ((last.points || {})[best] || 0) + ")";
  } else if (g.status === "running") cap = "Round " + g.round + " · words sealed";
  return (
    <div className="lg-card">
      <LetterGridTiles g={g} />
      <div className="lg-card-side">
        <LetterGridScores g={g} me={me} compact />
        {cap ? <div className="lg-card-cap">{cap}</div> : null}
      </div>
    </div>
  );
}
