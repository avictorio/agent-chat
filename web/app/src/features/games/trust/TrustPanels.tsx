import { useState, type CSSProperties } from "react";
import type { TrustPlayer, TrustRound, TrustState, TrustYou } from "@chat/contract";
import { trLastRound, trStatus, type TrDraft } from "./trust";

/* Trust's panels (2026-11-21, React): the scoreboard, the choices you
   make (a Cooperate / Defect pair per rival), the round's
   who-trusted-whom grid and the chat card. The view (view.tsx) mounts
   them with ctx.panel, so the planner's draft is its own state and
   survives the view's repaints. C and D carry a word and a mark as well
   as a colour. */

const MARK = { C: "✓", D: "✗" } as const;

function rate(p: TrustPlayer): string {
  return p.coop == null ? "–" : Math.round(p.coop * 100) + "%";
}

/* The scoreboard, highest first, with each player's share of C given. */
export function TrustScores({ g, me, compact }: { g: TrustState; me?: string; compact?: boolean }) {
  const ps: TrustPlayer[] = ((g && g.players) || []).slice().sort((a: TrustPlayer, b: TrustPlayer) => (b.score || 0) - (a.score || 0) || (a.name < b.name ? -1 : 1));
  return (
    <div className={"tr-scores" + (compact ? " compact" : "")}>
      {ps.map((p: TrustPlayer, i: number) => {
        const mine = !!me && p.name === me;
        const st = trStatus(g, p);
        return (
          <div key={p.name} className={"tr-row" + (p.out ? " out" : "") + (mine ? " mine" : "")} style={{ "--who": p.hex || "#94a3b8" } as CSSProperties}>
            <span className="tr-rank">{String(i + 1)}</span>
            <span className="hist-dot" style={{ background: p.hex }}></span>
            <span className="tr-name">{p.name + (mine ? " (you)" : "")}</span>
            {!compact ? (
              <>
                <span className="tr-coop" title={"Cooperated " + rate(p) + " of the time"}>
                  <span className="tr-coop-fill" style={{ width: (p.coop == null ? 0 : Math.round(p.coop * 100)) + "%" }}></span>
                </span>
                <span className="tr-coop-n">{"🤝 " + rate(p)}</span>
              </>
            ) : null}
            {st ? <span className="tr-st">{st}</span> : null}
            <span className="tr-score">{String(p.score || 0)}</span>
          </div>
        );
      })}
    </div>
  );
}

/* Who trusted whom in one round: rows choose, columns receive. */
export function TrustGrid({ g, round, me }: { g: TrustState; round: TrustRound | null; me?: string }) {
  if (!round) {
    return (
      <div className="tr-grid-wrap">
        <div className="tr-grid-empty">No round has resolved yet - choices are revealed together.</div>
      </div>
    );
  }
  const players: TrustPlayer[] = (g && g.players) || [];
  const names = players.map((p) => p.name).filter((n) => (round.moves || {})[n]);
  const hexOf = (n: string) => (players.find((p) => p.name === n) || { hex: "#94a3b8" }).hex;
  return (
    <div className="tr-grid-wrap">
      <table className="tr-grid" aria-label={"Round " + round.n + ": who cooperated with whom"}>
        <thead>
          <tr>
            <th className="tr-corner">→</th>
            {names.map((n) => (
              <th key={n} className="tr-col" style={{ color: hexOf(n) }}>
                {n}
              </th>
            ))}
            <th className="tr-pts-h">+pts</th>
          </tr>
        </thead>
        <tbody>
          {names.map((from) => (
            <tr key={from} className={me && from === me ? "mine" : undefined}>
              <th className="tr-from" style={{ color: hexOf(from) }}>
                {from}
              </th>
              {names.map((to) => {
                if (to === from) return <td key={to} className="tr-self"></td>;
                const c = ((round.moves || {})[from] || {})[to];
                const missed = (round.missed || []).indexOf(from) >= 0;
                const title = from + (c === "C" ? " cooperated with " : " defected on ") + to + (missed ? " (no choice sent)" : "");
                return (
                  <td key={to} className={"tr-cell " + (c === "C" ? "c" : "d") + (missed ? " missed" : "")} title={title} aria-label={title}>
                    {c ? MARK[c] : ""}
                  </td>
                );
              })}
              <td className="tr-pts">{"+" + ((round.points || {})[from] || 0)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* Your choices: a Cooperate / Defect pair per rival, the quick fills,
   and Lock in once every rival has one. The draft starts from what you
   sent; the view keys the planner by round, so it starts over each
   round. */
export function TrustPlanner({ g, onCommit }: { g: TrustState; onCommit: (dir: string) => void }) {
  const you: Partial<TrustYou> = g.you || {};
  const rivals: string[] = you.rivals || [];
  const queued: TrDraft | null = you.queued || null;
  const [draft, setDraft] = useState<TrDraft>(() => (queued ? Object.assign({}, queued) : {}));
  const full = rivals.length > 0 && rivals.every((n) => draft[n]);
  const same = !!queued && rivals.every((n) => queued[n] === draft[n]);
  const fillAll = (v: "C" | "D") => {
    const d: TrDraft = {};
    rivals.forEach((n) => (d[n] = v));
    setDraft(d);
  };
  return (
    <div className={"tr-plan" + (queued ? "" : " your-move")}>
      <div className="tr-plan-head">
        <span className="tr-plan-title">{queued ? "Your choices are in" : "Round " + g.round + " · whom do you trust?"}</span>
      </div>
      {rivals.map((n) => {
        const p = ((g && g.players) || []).find((x: TrustPlayer) => x.name === n) || { hex: "#94a3b8" };
        return (
          <div key={n} className="tr-choice">
            <span className="tr-choice-name" style={{ color: p.hex }}>
              {n}
            </span>
            {(["C", "D"] as const).map((v) => (
              <button key={v} type="button" className={"tr-pick " + v.toLowerCase() + (draft[n] === v ? " on" : "")} aria-pressed={draft[n] === v ? "true" : "false"} onClick={() => setDraft(Object.assign({}, draft, { [n]: v }))}>
                {v === "C" ? "🤝 Cooperate" : "🗡 Defect"}
              </button>
            ))}
          </div>
        );
      })}
      <div className="tr-acts">
        {rivals.length > 1 ? (
          <>
            <button type="button" className="duel-btn quiet sm" onClick={() => fillAll("C")}>
              Trust everyone
            </button>
            <button type="button" className="duel-btn quiet sm" onClick={() => fillAll("D")}>
              Defect on everyone
            </button>
          </>
        ) : null}
        <button type="button" className="duel-btn tr-go" disabled={!full || same} onClick={() => onCommit(rivals.map((n) => n + ":" + draft[n]).join(", "))}>
          {same ? "Locked in ✓" : queued ? "Change choices" : "Lock in"}
        </button>
      </div>
    </div>
  );
}

/* The card: the scores and the last round in one line. */
export function TrustCard({ g, me }: { g: TrustState; me: string }) {
  const last = trLastRound(g);
  let cap = "";
  if (last) {
    const all = Object.values(last.moves || {}).flatMap((m) => Object.values(m) as string[]);
    const cs = all.filter((v) => v === "C").length;
    cap = "Round " + last.n + ": " + cs + " of " + all.length + " choices were trust";
  } else if (g.status === "running") cap = "Round " + g.round + " · choices sealed";
  return (
    <div className="tr-card">
      <TrustScores g={g} me={me} compact />
      {cap ? <div className="tr-card-cap">{cap}</div> : null}
    </div>
  );
}
