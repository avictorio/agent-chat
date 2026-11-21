import { useState, type ReactNode } from "react";
import type { TwoTruthsPlayer, TwoTruthsRound, TwoTruthsState, TwoTruthsYou } from "@chat/contract";
import { TT_MAX, type TtDraft } from "./twotruths";

/* Two Truths and a Lie's panels (2026-11-21, React), under the 3D
   campfire: the storyteller's writing form, the statements to vote on,
   the scores, the last round's reveal and the chat card. The view
   (view.tsx) mounts them with ctx.panel, so the form's draft is its own
   state and survives the view's repaints. The lie stays secret until the
   reveal: only the storyteller's own view carries you.lie. */

const hexOf = (g: TwoTruthsState, n: string | null) => (((g && g.players) || []).find((p: TwoTruthsPlayer) => p.name === n) || { hex: "#94a3b8" }).hex;

const HINTS = ["Something true about you…", "Something else true…", "Something believable but false…"] as const;

/* The storyteller's form: three statements, which one is the lie, send.
   The view keys it by round, so the draft starts over each round; the
   boxes keep what you type in place (no value attribute, as before). */
export function TwoTruthsWriter({ onSend }: { onSend: (d: TtDraft) => void }) {
  const [draft, setDraft] = useState<TtDraft>(() => ({ s: ["", "", ""], lie: 0 }));
  const ready = draft.s.every((x) => x.trim()) && draft.lie >= 1 && new Set(draft.s.map((x) => x.trim().toLowerCase())).size === 3;
  const write = (i: 0 | 1 | 2, v: string) =>
    setDraft((d) => {
      const s: TtDraft["s"] = [d.s[0], d.s[1], d.s[2]];
      s[i] = v;
      return { ...d, s };
    });
  return (
    <div className="tt-writer your-move">
      <div className="tt-writer-title">Your turn to tell: two truths and a lie about you</div>
      <div className="tt-writer-rows">
        {([0, 1, 2] as const).map((i) => {
          const lie = draft.lie === i + 1;
          return (
            <div key={i} className={"tt-writer-row" + (lie ? " lie" : "")}>
              <textarea className="tt-input" rows={2} maxLength={TT_MAX} placeholder={HINTS[i]} aria-label={"Statement " + (i + 1)} onChange={(e) => write(i, e.target.value)} />
              <button type="button" className={"tt-lie-pick" + (lie ? " on" : "")} aria-pressed={lie ? "true" : "false"} onClick={() => setDraft((d) => ({ ...d, lie: i + 1 }))}>
                {lie ? "The lie" : "Mark as the lie"}
              </button>
            </div>
          );
        })}
      </div>
      <div className="tt-acts">
        <span className="tt-help">{"They're shown shuffled; only you know which is the lie."}</span>
        <button
          type="button"
          className="duel-btn tt-go"
          disabled={!ready}
          onClick={() => {
            if (ready) onSend(draft);
          }}
        >
          Tell the table
        </button>
      </div>
    </div>
  );
}

/* The three statements this round: voters pick the lie (their vote
   marked); the storyteller sees theirs with the lie marked; spectators
   just read. */
export function TwoTruthsStatements({ g, onVote }: { g: TwoTruthsState; onVote?: (n: number) => void }) {
  const you: Partial<TwoTruthsYou> = g.you || {};
  const ss: string[] = g.statements || you.statements || [];
  const teller = g.teller;
  return (
    <div className={"tt-statements" + (onVote ? " your-move" : "")}>
      <div className="tt-st-head">
        <span className="tt-st-teller" style={{ color: hexOf(g, teller) }}>
          {teller || ""}
        </span>
        <span>{you.teller ? " - your statements (only you can see the lie)" : onVote ? " says… which one is the lie?" : " says…"}</span>
      </div>
      {ss.map((s, i) => {
        const n = i + 1;
        const mine = you.vote === n;
        const isLie = you.teller && you.lie === n;
        const cls = "tt-card" + (mine ? " voted" : "") + (isLie ? " lie" : "");
        const kids: ReactNode = (
          <>
            <span className="tt-card-n">{String(n)}</span>
            <span className="tt-card-text">{s}</span>
            {mine ? <span className="tt-card-tag">your vote: the lie</span> : isLie ? <span className="tt-card-tag">your lie</span> : null}
          </>
        );
        return onVote ? (
          <button key={n} type="button" className={cls} aria-pressed={mine ? "true" : "false"} onClick={() => onVote(n)}>
            {kids}
          </button>
        ) : (
          <div key={n} className={cls}>
            {kids}
          </div>
        );
      })}
    </div>
  );
}

/* Scores: everyone, best first; who is telling and who has voted. */
export function TwoTruthsScores({ g, me, compact }: { g: TwoTruthsState; me?: string; compact?: boolean }) {
  const ps: TwoTruthsPlayer[] = (g.players || []).slice().sort((a, b) => (b.score || 0) - (a.score || 0) || (b.spots || 0) - (a.spots || 0));
  return (
    <div className={"tt-scores" + (compact ? " compact" : "")}>
      {ps.map((p) => {
        const mine = !!me && p.name === me;
        let st = "";
        if (g.status === "running") {
          if (g.teller === p.name) st = g.phase === "write" ? "writing…" : "telling";
          else if (g.phase === "vote") st = p.committed ? "voted ✓" : "thinking…";
        }
        return (
          <div key={p.name} className={"tt-row" + (mine ? " mine" : "") + (g.status === "running" && g.teller === p.name ? " teller" : "")}>
            <span className="hist-dot" style={{ background: p.hex }}></span>
            <span className="tt-name">{p.name + (mine ? " (you)" : "")}</span>
            {st && !compact ? <span className="tt-st">{st}</span> : null}
            <span className="tt-pts">{String(p.score || 0)}</span>
          </div>
        );
      })}
    </div>
  );
}

/* The last round: the statements with the lie marked, who voted where,
   the points, and the roast when everyone saw through it. */
export function TwoTruthsReveal({ g, r }: { g: TwoTruthsState; r: TwoTruthsRound | null }) {
  if (!r) {
    return (
      <div className="tt-reveal">
        <div className="tt-reveal-empty">No lie has been revealed yet.</div>
      </div>
    );
  }
  const head = (
    <div className="tt-reveal-head">
      <span>{"Round " + r.n + " · "}</span>
      <span className="tt-reveal-teller" style={{ color: hexOf(g, r.teller) }}>
        {r.teller}
      </span>
    </div>
  );
  if (r.forfeit) {
    return (
      <div className="tt-reveal">
        {head}
        <div className="tt-reveal-note">{r.teller + " ran out of time to write - the round was forfeit."}</div>
      </div>
    );
  }
  const pts = Object.keys(r.points || {})
    .filter((n) => r.points[n])
    .map((n) => n + " +" + r.points[n]);
  return (
    <div className="tt-reveal">
      {head}
      {(r.statements || []).map((s, i) => {
        const n = i + 1;
        const lie = n === r.lie;
        const voters = Object.keys(r.votes || {}).filter((v) => r.votes[v] === n);
        return (
          <div key={n} className={"tt-rv" + (lie ? " lie" : " truth")}>
            <span className="tt-rv-tag">{lie ? "LIE" : "TRUE"}</span>
            <span className="tt-rv-text">{s}</span>
            <span className="tt-rv-votes">
              {voters.map((v) => (
                <span key={v} className="tt-chip" style={{ borderColor: hexOf(g, v), color: hexOf(g, v) }}>
                  {v}
                </span>
              ))}
            </span>
          </div>
        );
      })}
      <div className="tt-reveal-pts">{(pts.length ? pts.join(" · ") : "No points this round") + ((r.missed || []).length ? " · no vote: " + r.missed.join(", ") : "")}</div>
      {r.note ? <div className="tt-reveal-note">{r.note}</div> : null}
    </div>
  );
}

/* The card: whose turn to tell, and the scores. */
export function TwoTruthsCard({ g, me }: { g: TwoTruthsState; me: string }) {
  const line =
    g.status === "running" && g.teller
      ? "Round " + g.round + " of " + g.rounds_total + " · " + g.teller + (g.phase === "write" ? " is writing" : " told - vote for the lie")
      : g.status === "finished"
        ? "The fire's out · " + (g.rounds_total || 0) + " rounds"
        : (g.rounds_total || 0) + " rounds";
  return (
    <div className="tt-card-board">
      <div className="tt-card-line">{line}</div>
      <TwoTruthsScores g={g} me={me} compact />
    </div>
  );
}
