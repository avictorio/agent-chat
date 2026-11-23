import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { isImeKey } from "../../../lib/index";
import type { TriviaPlayer, TriviaRound, TriviaState, TriviaToJudge, TriviaYou } from "@chat/contract";
import { tvLastRound } from "./trivia";

/* Trivia's panels: the scoreboard (balances), the question, the
   quizmaster's question form, the answer-and-wager form, the judge
   panel, the last round's reveal and the chat card. The view (view.tsx)
   mounts them with ctx.panel, keying each form by round and phase, so a
   form's draft is its own state and survives the view's repaints. Each
   field starts from the draft when it mounts and reports every
   keystroke back. Uncontrolled fields: see docs/agents/games.md,
   Panels. */

type AskDraft = { q: string; a: string; acc: string };

function status(g: TriviaState, p: TriviaPlayer): string {
  if (g.status !== "running") return "";
  if (p.name === g.asker) return g.phase === "judge" ? "judging…" : g.phase === "ask" ? "asking…" : "quizmaster";
  if (g.phase === "answer") return p.committed ? "answered ✓" : "thinking…";
  return "";
}

/* A field's first value, set once when it mounts. */
function useSeed<T extends HTMLInputElement | HTMLTextAreaElement>(value: string) {
  const ref = useRef<T>(null);
  const [seed] = useState(value);
  useLayoutEffect(() => {
    if (ref.current) ref.current.value = seed;
  }, [seed]);
  return ref;
}

/* The scoreboard, highest balance first, with right answers. */
export function TriviaScores({ g, me, compact }: { g: TriviaState; me?: string; compact?: boolean }) {
  const ps: TriviaPlayer[] = ((g && g.players) || []).slice().sort((a: TriviaPlayer, b: TriviaPlayer) => (b.balance || 0) - (a.balance || 0) || (b.right || 0) - (a.right || 0) || (a.name < b.name ? -1 : 1));
  return (
    <div className={"tv-scores" + (compact ? " compact" : "")}>
      {ps.map((p: TriviaPlayer, i: number) => {
        const mine = !!me && p.name === me;
        const st = compact ? (p.name === g.asker && g.status === "running" ? "🎤" : "") : status(g, p);
        return (
          <div key={p.name} className={"tv-row" + (mine ? " mine" : "") + (p.name === g.asker ? " asker" : "")} style={{ "--who": p.hex || "#94a3b8" } as CSSProperties}>
            <span className="tv-rank">{String(i + 1)}</span>
            <span className="hist-dot" style={{ background: p.hex }}></span>
            <span className="tv-name">{p.name + (mine ? " (you)" : "")}</span>
            {!compact ? <span className="tv-right">{"✓ " + (p.right || 0)}</span> : null}
            {st ? <span className="tv-st">{st}</span> : null}
            <span className="tv-bal">{String(p.balance != null ? p.balance : 100)}</span>
          </div>
        );
      })}
    </div>
  );
}

/* The question as it stands this round (also shown in the scene); the
   view mounts it while the match runs. */
export function TriviaQuestion({ g }: { g: TriviaState }) {
  const who = (g.players || []).find((p: TriviaPlayer) => p.name === g.asker);
  return (
    <div className="tv-q">
      <div className="tv-q-tag" style={who ? ({ "--who": who.hex } as CSSProperties) : undefined}>
        {"Round " + g.round + " of " + g.rounds_total + " · " + (g.asker || "?") + " asks"}
      </div>
      <div className={"tv-q-text" + (g.question ? "" : " waiting")}>{g.question || (g.asker || "The quizmaster") + " is writing a question…"}</div>
    </div>
  );
}

/* The quizmaster's form: question, answer, other accepted answers. */
export function TriviaAskForm({ onSend }: { onSend: (dir: string) => void }) {
  const [d, setD] = useState<AskDraft>({ q: "", a: "", acc: "" });
  const q = useRef<HTMLTextAreaElement>(null);
  const a = useRef<HTMLInputElement>(null);
  const acc = useRef<HTMLInputElement>(null);
  const sync = () => setD({ q: q.current ? q.current.value : "", a: a.current ? a.current.value : "", acc: acc.current ? acc.current.value : "" });
  const off = !d.q.trim() || !d.a.trim();
  return (
    <div className="tv-form tv-ask">
      <div className="tv-form-title">Your question</div>
      <textarea ref={q} className="tv-in tv-in-q" rows={2} maxLength={200} placeholder="Ask something about you, the room, anything" aria-label="Your question" onInput={sync}></textarea>
      <input ref={a} className="tv-in tv-in-a" type="text" maxLength={60} placeholder="The answer (sealed until the reveal)" aria-label="The answer" onInput={sync} />
      <input ref={acc} className="tv-in tv-in-acc" type="text" maxLength={200} placeholder="Other answers that count, separated by |  (optional)" aria-label="Other accepted answers" onInput={sync} />
      <div className="tv-hint">Ask something answerable but not easy: you score 10 if some get it right and some don't.</div>
      <div className="tv-row-end">
        <button
          type="button"
          className="btn tv-send"
          disabled={off}
          onClick={() => {
            if (off) return;
            const variants = d.acc.split("|").map((x) => x.trim()).filter(Boolean);
            onSend(JSON.stringify({ question: d.q.trim(), answer: d.a.trim(), accept: variants }));
          }}
        >
          Ask
        </button>
      </div>
    </div>
  );
}

/* An answer and a wager: the stake as a slider and steps of 5. The
   draft starts from your sealed answer, or a stake of 10. */
export function TriviaAnswerForm({ g, onSend }: { g: TriviaState; onSend: (dir: string) => void }) {
  const you: Partial<TriviaYou> = g.you || {};
  const max: number = you.max_wager != null ? you.max_wager : 25;
  const [ans, setAns] = useState(() => (you.queued ? you.queued.answer : ""));
  const [w, setW] = useState(() => (you.queued ? you.queued.wager : Math.min(10, you.max_wager != null ? you.max_wager : 10)));
  const a = useSeed<HTMLInputElement>(ans);
  const range = useRef<HTMLInputElement>(null);
  const stake = Math.min(max, w);
  // the slider follows the stake (a quick step moves it)
  useLayoutEffect(() => {
    const r = range.current;
    if (r && r.value !== String(stake)) r.value = String(stake);
  }, [stake]);
  const off = !ans.trim();
  const send = () => {
    if (off) return;
    onSend(JSON.stringify({ answer: ans.trim(), wager: stake }));
  };
  return (
    <div className="tv-form tv-answer">
      <div className="tv-form-title">{you.queued ? "Your answer is in - change it until the round resolves" : "Your answer"}</div>
      <input
        ref={a}
        className="tv-in tv-in-a"
        type="text"
        maxLength={60}
        placeholder="Your answer"
        aria-label="Your answer"
        onInput={(e) => setAns(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !off && !isImeKey(e)) {
            e.preventDefault();
            send();
          }
        }}
      />
      <div className="tv-wager">
        <span className="tv-wager-lab">Wager</span>
        <input ref={range} className="tv-range" type="range" min="0" max={String(max)} step="1" aria-label="Your wager" onInput={(e) => setW(Number(e.currentTarget.value) || 0)} />
        <span className="tv-stake">{stake + " of " + max}</span>
      </div>
      <div className="tv-quick">
        {[0, 5, 10, 15, 20, 25]
          .filter((v) => v <= max)
          .map((v) => (
            <button key={v} type="button" className="tv-chip-btn" onClick={() => setW(v)}>
              {String(v)}
            </button>
          ))}
      </div>
      <div className="tv-row-end">
        <button type="button" className="btn tv-send" disabled={off} onClick={send}>
          {you.queued ? "Change" : "Lock in"}
        </button>
      </div>
      {you.queued ? <div className="tv-hint">{"Sealed: " + you.queued.answer + " · wager " + you.queued.wager}</div> : null}
    </div>
  );
}

/* The quizmaster's ruling on answers the match missed, and on close
   matches (one letter off), which count unless the quizmaster rejects
   them. Each row's button toggles the ruling. */
export function TriviaJudgeForm({ g, onSend }: { g: TriviaState; onSend: (dir: string) => void }) {
  const you: Partial<TriviaYou> = g.you || {};
  const list = (you.to_judge || []) as TriviaToJudge[];
  return (
    <div className="tv-form tv-judge">
      <div className="tv-form-title">{"Judge these answers - the answer is " + (you.answer || "?")}</div>
      {list.map((x: TriviaToJudge) => (
        <div key={x.name} className={"tv-judge-row" + (x.accepted ? " ok" : "")}>
          <span className="tv-judge-name">{x.name}</span>
          <span className="tv-judge-ans">{"“" + x.answer + "”"}</span>
          {x.near ? <span className="tv-judge-near">close</span> : null}
          <button
            type="button"
            className="btn sm tv-accept"
            aria-pressed={!!x.accepted}
            aria-label={x.accepted ? "Stop counting " + x.name + "'s answer as right" : "Count " + x.name + "'s answer as right"}
            onClick={() => onSend((x.accepted ? "reject " : "accept ") + x.name)}
          >
            {x.accepted ? "Counted ✓" : "Count it"}
          </button>
        </div>
      ))}
      <div className="tv-row-end">
        <button type="button" className="btn tv-send" onClick={() => onSend("done")}>
          Reveal
        </button>
      </div>
      <div className="tv-hint">{list.some((x) => x.near) ? "A close match counts unless you tap it off. Anything you don't count is wrong. On your honour." : "Anything you don't count is wrong. On your honour."}</div>
    </div>
  );
}

/* One round's reveal: the question, the answer, each answer with its
   wager and the swing, and the quizmaster's split bonus. */
export function TriviaReveal({ g, round, me }: { g: TriviaState; round: TriviaRound; me?: string }) {
  const players: TriviaPlayer[] = g.players || [];
  const hexOf = (n: string) => (players.find((p: TriviaPlayer) => p.name === n) || { hex: "#94a3b8" }).hex;
  const cap = <div className="fl-cap">{"Round " + round.n + " · " + round.asker + " asked"}</div>;
  if (round.forfeit) {
    return (
      <div className="tv-reveal">
        {cap}
        <div className="tv-rv-q">{round.asker + " ran out of time - no question this round."}</div>
      </div>
    );
  }
  const names = Object.keys(round.answers || {}).concat(round.missed || []);
  return (
    <div className="tv-reveal">
      {cap}
      <div className="tv-rv-q">{round.question}</div>
      <div className="tv-rv-a">{"Answer: " + round.answer + ((round.accept || []).length ? " (also: " + round.accept.join(", ") + ")" : "")}</div>
      {names.map((n: string) => {
        const a = (round.answers || {})[n];
        const delta = (round.deltas || {})[n] || 0;
        return (
          <div key={n} className={"tv-rv" + (a ? (a.right ? " right" : " wrong") : " missed") + (me && n === me ? " mine" : "")} style={{ "--who": hexOf(n) } as CSSProperties}>
            <span className="hist-dot" style={{ background: hexOf(n) }}></span>
            <span className="tv-rv-name">{n}</span>
            <span className="tv-rv-ans">{a ? "“" + a.answer + "”" + (a.judged ? " (judged right)" : "") : "no answer"}</span>
            <span className="tv-rv-delta">{a ? (delta > 0 ? "+" + delta : delta < 0 ? "−" + -delta : "0") : "0"}</span>
          </div>
        );
      })}
      {round.split ? (
        <div className="tv-rv split" style={{ "--who": hexOf(round.asker) } as CSSProperties}>
          <span className="tv-rv-name">{round.asker}</span>
          <span className="tv-rv-ans">split the table</span>
          <span className="tv-rv-delta">{"+" + (round.bonus || 10)}</span>
        </div>
      ) : null}
    </div>
  );
}

/* The card: the question (or the last answer) and the balances. */
export function TriviaCard({ g, me }: { g: TriviaState; me: string }) {
  let cap = "";
  if (g.status === "running") cap = g.question ? "“" + g.question + "” - " + g.asker + " asks" : (g.asker || "The quizmaster") + " is writing a question";
  else {
    const last = tvLastRound(g);
    if (last && !last.forfeit) cap = "Last: “" + last.question + "” - " + last.answer;
  }
  return (
    <div className="tv-card">
      {cap ? <div className="tv-card-q">{cap}</div> : null}
      <TriviaScores g={g} me={me} compact />
    </div>
  );
}
