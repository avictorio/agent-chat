import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import type { FrontlinesPlayer, FrontlinesRound, FrontlinesState } from "@chat/contract";
import { FL_HILLS, FL_LETTERS, FL_TROOPS, flHex, flLastRound } from "./frontlines";

/* Frontlines' panels: the score line, the field as a board (card and
   arena), the troop planner a commander fills in, and the chat card.
   The view (view.tsx) mounts them with ctx.panel, so the planner's
   draft is its own state and survives the view's repaints (a poll, the
   rival committing); the view keys it by round, so it starts over when
   a new round opens. A split is secret until the round resolves, so the
   field shows the last RESOLVED round, plus only your own pending split
   - never a rival's. */

/* The score: each commander's rounds won, and (while the match runs)
   whether they have committed. */
export function FrontlinesScore({ g }: { g: FrontlinesState }) {
  return (
    <div className="fl-score">
      {(g.players || []).map((p: FrontlinesPlayer, i: number) => (
        <Fragment key={p.name}>
          {i ? <span className="fl-vs">vs</span> : null}
          <span className="fl-score-p">
            <span className="hist-dot" style={{ background: p.hex }}></span>
            <span className="fl-score-name">{p.name}</span>
            <span className="fl-score-n">{String(p.wins || 0)}</span>
            {g.status === "running" ? <span className="fl-score-st">{p.committed ? "committed ✓" : "planning…"}</span> : null}
          </span>
        </Fragment>
      ))}
    </div>
  );
}

/* The field: one column per hill. A resolved round shows both armies as
   bars (longest bar = 100 troops), the hill's winner flagged in their
   colour, a level hill marked level. Before any round has resolved it
   shows the empty field (and, for the viewer, their own sealed split). */
export function FrontlinesField({ g, compact, round: given, me }: { g: FrontlinesState; compact?: boolean; round?: FrontlinesRound | null; me?: string }) {
  const round = given !== undefined ? given : flLastRound(g);
  const players: FrontlinesPlayer[] = (g && g.players) || [];
  const values: number[] | null = round && round.values ? round.values : g && g.variant === "valued" ? g.values || null : null;
  const mine = g && g.you && g.you.playing && Array.isArray(g.you.queued) ? (g.you.queued as number[]) : null;
  const hills: number[] = [];
  for (let i = 0; i < FL_HILLS; i++) hills.push(i);
  return (
    <div className={"fl-field" + (compact ? " compact" : "")} role="group" aria-label={round ? "Round " + round.n + " on the field" : "The field"}>
      {hills.map((i) => {
        const head = (
          <div className="fl-hill-head">
            <span className="fl-hill-name">{FL_LETTERS[i]}</span>
            {values ? <span className="fl-hill-val">{values[i] + (values[i] === 1 ? " pt" : " pts")}</span> : null}
          </div>
        );
        if (round && round.hills) {
          const owner = round.hills[i];
          return (
            <div key={i} className={"fl-hill " + (owner ? "taken" : "level")} style={owner ? ({ "--hill-c": flHex(g, owner) } as CSSProperties) : undefined}>
              {head}
              {players.map((p: FrontlinesPlayer) => {
                const n = ((round.alloc || {})[p.name] || [])[i] || 0;
                return (
                  <div key={p.name} className={"fl-bar" + (owner === p.name ? " won" : "")} title={p.name + ": " + n + " troops"}>
                    <span className="fl-fill" style={{ width: Math.max(n ? 4 : 0, n) + "%", background: p.hex }}></span>
                    <span className="fl-n">{String(n)}</span>
                  </div>
                );
              })}
              <div className={"fl-flag" + (owner ? "" : " level")} style={owner ? ({ "--flag-c": flHex(g, owner) } as CSSProperties) : undefined} aria-label={owner ? "taken by " + owner : undefined}>
                {owner ? (compact ? "" : owner) : "level"}
              </div>
            </div>
          );
        }
        if (mine) {
          // your own sealed split (the rival's is never on this page)
          return (
            <div key={i} className="fl-hill">
              {head}
              <div className="fl-bar mine">
                <span className="fl-fill" style={{ width: (mine[i] || 0) + "%", background: flHex(g, me) }}></span>
                <span className="fl-n">{String(mine[i] || 0)}</span>
              </div>
              <div className="fl-flag sealed">sealed</div>
            </div>
          );
        }
        return (
          <div key={i} className="fl-hill">
            {head}
            <div className="fl-flag open">?</div>
          </div>
        );
      })}
      {round && round.hills && !compact ? (
        <div className="fl-sum">
          {players.map((p: FrontlinesPlayer) => {
            const k = values ? (round.points || {})[p.name] || 0 : (round.held || {})[p.name] || 0;
            return (
              <span key={p.name} className="fl-sum-p" style={{ color: p.hex }}>
                {p.name + " " + k + (values ? " pts" : k === 1 ? " hill" : " hills")}
              </span>
            );
          })}
          <span className="fl-sum-v">{round.winner ? round.winner + " takes round " + round.n : round.forfeit ? "" : "Round " + round.n + " is level"}</span>
          {round.forfeit ? <span className="fl-sum-v">{round.winner + " takes round " + round.n + " by forfeit"}</span> : null}
        </div>
      ) : null}
    </div>
  );
}

/* A hill's number field. Its value follows the draft on every render;
   what you type counts when the field commits (change). Uncontrolled
   field: see docs/agents/games.md, Panels. */
function TroopField({ i, cur, onSet }: { i: number; cur: number; onSet: (i: number, v: number) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => {
    const n = ref.current;
    if (n && n.value !== String(cur)) n.value = String(cur);
  });
  useEffect(() => {
    const n = ref.current;
    if (!n) return;
    const commit = () => onSet(i, Number(n.value));
    n.addEventListener("change", commit);
    return () => n.removeEventListener("change", commit);
  }, [i, onSet]);
  return <input ref={ref} className="fl-num" type="number" inputMode="numeric" min="0" max={String(FL_TROOPS)} aria-label={"Troops on hill " + FL_LETTERS[i]} />;
}

/* The planner: a row per hill (minus, the number, plus, a bar), what is
   left to place, Even / Random / Clear, and Lock in once the split adds
   up to 100. The draft starts from the split you sent. */
export function FrontlinesPlanner({ g, onCommit }: { g: FrontlinesState; onCommit: (v: number[]) => void }) {
  const queued: number[] | null = Array.isArray(g.you && g.you.queued) ? g.you!.queued! : null;
  const [draft, setDraft] = useState<number[]>(() => (queued ? queued.slice() : [0, 0, 0, 0, 0]));
  const values: number[] | null = g.variant === "valued" ? g.values || null : null;
  const total = draft.reduce((a, b) => a + b, 0);
  const left = FL_TROOPS - total;
  const set = useCallback(
    (i: number, v: number) =>
      setDraft((d) => {
        const next = d.slice();
        next[i] = Math.max(0, Math.min(FL_TROOPS, Math.round(v) || 0));
        return next;
      }),
    []
  );
  const random = () => {
    const w = Array.from({ length: FL_HILLS }, () => Math.random() + 0.05);
    const t = w.reduce((a, b) => a + b, 0);
    const out = w.map((x) => Math.floor((x / t) * FL_TROOPS));
    let r = FL_TROOPS - out.reduce((a, b) => a + b, 0);
    for (let k = 0; r > 0; k = (k + 1) % FL_HILLS, r--) out[k]!++;
    return out;
  };
  const same = !!queued && queued.join(",") === draft.join(",");
  const hills: number[] = [];
  for (let i = 0; i < FL_HILLS; i++) hills.push(i);
  return (
    <div className={"fl-plan" + (g.you && g.you.queued ? "" : " your-move")}>
      <div className="fl-plan-head">
        <span className="fl-plan-title">{queued ? "Your split is in" : "Split your " + FL_TROOPS + " troops"}</span>
        <span className={"fl-left" + (left === 0 ? " ok" : left < 0 ? " over" : "")} aria-live="polite">
          {left === 0 ? "All " + FL_TROOPS + " placed" : left > 0 ? left + " left to place" : -left + " too many"}
        </span>
      </div>
      {hills.map((i) => {
        const cur = draft[i] ?? 0;
        return (
          <div key={i} className="fl-row">
            <span className="fl-row-name">
              {FL_LETTERS[i]}
              {values ? <span className="fl-hill-val">{values[i] + (values[i] === 1 ? " pt" : " pts")}</span> : null}
            </span>
            <button type="button" className="fl-step" aria-label={"5 fewer on hill " + FL_LETTERS[i]} disabled={cur <= 0} onClick={() => set(i, cur - 5)}>
              −
            </button>
            <TroopField i={i} cur={cur} onSet={set} />
            <button type="button" className="fl-step" aria-label={"5 more on hill " + FL_LETTERS[i]} disabled={left <= 0} onClick={() => set(i, cur + Math.min(5, Math.max(0, left)))}>
              +
            </button>
            <span className="fl-row-bar">
              <span className="fl-fill" style={{ width: Math.min(100, cur) + "%" }}></span>
            </span>
          </div>
        );
      })}
      <div className="fl-acts">
        <button type="button" className="duel-btn quiet sm" onClick={() => setDraft([20, 20, 20, 20, 20])}>
          Even
        </button>
        <button type="button" className="duel-btn quiet sm" onClick={() => setDraft(random())}>
          Random
        </button>
        <button type="button" className="duel-btn quiet sm" onClick={() => setDraft([0, 0, 0, 0, 0])}>
          Clear
        </button>
        <button type="button" className="duel-btn fl-go" disabled={left !== 0 || same} onClick={() => onCommit(draft.slice())}>
          {same ? "Locked in ✓" : queued ? "Update split" : "Lock in"}
        </button>
      </div>
    </div>
  );
}

/* Frontlines on a card: the score line and the last resolved round on a
   compact field (hills tinted by who took them). */
export function FrontlinesCard({ g }: { g: FrontlinesState; me: string }) {
  const last = flLastRound(g);
  return (
    <div className="fl-card">
      <div className="fl-card-score">
        {(g.players || []).map((p: FrontlinesPlayer, i: number) => (
          <Fragment key={p.name}>
            {i ? " – " : null}
            <span style={{ color: p.hex }}>{p.name + " " + (p.wins || 0)}</span>
          </Fragment>
        ))}
      </div>
      <FrontlinesField g={g} compact round={last} />
      <div className="fl-card-cap">{last ? "Round " + last.n + (last.winner ? " to " + last.winner : " level") : g.status === "running" ? "Round " + g.round + " · splits sealed" : ""}</div>
    </div>
  );
}
