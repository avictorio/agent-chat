import { useState, type ReactNode } from "react";
import type { TwentyPlayer, TwentyQuestion, TwentyRound, TwentyState, TwentyYou } from "@chat/contract";

/* Twenty Questions' panels, under the 3D candle ring: the answerer's
   controls (choose a secret; answer the waiting question), the
   questioners' (ask or guess), the budget, the public Q/A log, the
   scores, the last round's reveal and the chat card. The view
   (view.tsx) mounts them with ctx.panel, so what you are typing is the
   panel's own state and survives the view's repaints; the boxes keep it
   in place (uncontrolled fields: see docs/agents/games.md, Panels). The
   secret shows only to the answerer until the round ends. */

const hexOf = (g: TwentyState, n: string) => (((g && g.players) || []).find((p: TwentyPlayer) => p.name === n) || { hex: "#94a3b8" }).hex;

/* The answerer: choose a secret (or draw one), then answer what waits.
   The view keys it by round, question and phase, so the boxes start
   empty for each secret and each question. */
export function TwentyAnswerer({ g, onSend }: { g: TwentyState; onSend: (dir: string) => void }) {
  const you: Partial<TwentyYou> = g.you || {};
  const [secret, setSecret] = useState("");
  const [note, setNote] = useState("");
  const cls = "tq-panel" + (g.phase !== "ask" ? " your-move" : "");
  if (g.phase === "secret") {
    const s = secret.trim();
    return (
      <div className={cls}>
        <div className="tq-title">{"You're the answerer - choose a secret"}</div>
        <div className="tq-help">A noun phrase: a thing, a place, a person, an idea. Hidden until the round ends.</div>
        <div className="tq-row">
          <input
            className="tq-input"
            maxLength={60}
            placeholder="e.g. a lighthouse"
            aria-label="Your secret"
            onChange={(e) => setSecret(e.target.value)}
            onKeyDown={(e) => {
              const v = e.currentTarget.value.trim();
              if (e.key === "Enter" && v) onSend(v);
            }}
          />
          <button
            type="button"
            className="duel-btn tq-go"
            disabled={!s}
            onClick={() => {
              if (s) onSend(s);
            }}
          >
            Hold this secret
          </button>
        </div>
        <button type="button" className="duel-btn quiet sm tq-random" onClick={() => onSend("random")}>
          Draw one at random
        </button>
      </div>
    );
  }
  const p = g.pending;
  let ask: ReactNode = <div className="tq-help">Waiting for a question.</div>;
  if (g.phase === "answer" && p) {
    const guess = p.kind === "guess";
    const answer = (word: string) => onSend(word + (note.trim() && word !== "unanswerable" ? " - " + note.trim() : ""));
    const btns: [string, string, string][] = guess
      ? [
          ["Right", "right", "tq-yes"],
          ["Wrong", "wrong", "tq-no"],
        ]
      : [
          ["Yes", "yes", "tq-yes"],
          ["No", "no", "tq-no"],
          ["Unanswerable", "unanswerable", "quiet sm tq-flag"],
        ];
    ask = (
      <>
        <div className="tq-title">{guess ? p.by + " guesses:" : p.by + " asks:"}</div>
        <div className="tq-q">{guess ? "“" + p.q + "”" : p.q}</div>
        <input className="tq-input tq-note" maxLength={80} placeholder="A note, if you like (flavour, never a hint)" aria-label="A note with your answer" onChange={(e) => setNote(e.target.value)} />
        <div className="tq-acts">
          {btns.map(([label, word, c]) => (
            <button key={word} type="button" className={"duel-btn " + c} onClick={() => answer(word)}>
              {label}
            </button>
          ))}
        </div>
      </>
    );
  }
  return (
    <div className={cls}>
      <div className="tq-secret">{"Your secret: " + (you.secret || "")}</div>
      {ask}
    </div>
  );
}

/* A questioner: ask a yes/no question, or guess. The view keys it by
   round and questions asked, so the draft starts over when a question
   is spent. */
export function TwentyAsker({ g, onSend }: { g: TwentyState; onSend: (dir: string) => void }) {
  const [text, setText] = useState("");
  const t = text.trim();
  // Ask and Enter always send a question: the engine reads a move that
  // starts with "guess" as a guess, so "Guessing it's big?" sent bare
  // spent a guess on "ing it's big?". The engine strips "ask: ";
  // guessing is the Guess it button's job.
  const ask = (q: string) => onSend("ask: " + q);
  return (
    <div className="tq-panel your-move">
      <div className="tq-title">{"Ask " + g.answerer + " a yes/no question - or guess"}</div>
      <input
        className="tq-input"
        maxLength={160}
        placeholder="Is it alive?"
        aria-label="Your question or guess"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          const v = e.currentTarget.value.trim();
          if (e.key === "Enter" && v) ask(v);
        }}
      />
      <div className="tq-acts">
        <span className="tq-help">{(g.remaining || 0) + " of 20 left · a guess costs one too"}</span>
        <button
          type="button"
          className="duel-btn quiet tq-guess"
          disabled={!t}
          onClick={() => {
            if (t) onSend("guess: " + t.replace(/^is it\s+/i, "").replace(/\?$/, ""));
          }}
        >
          Guess it
        </button>
        <button
          type="button"
          className="duel-btn tq-go"
          disabled={!t}
          onClick={() => {
            if (t) ask(t);
          }}
        >
          Ask
        </button>
      </div>
    </div>
  );
}

/* The budget: twenty pips, spent ones lit by their answer. */
export function TwentyBudget({ g }: { g: TwentyState }) {
  const spent = ((g.qa || []) as TwentyQuestion[]).filter((x) => !x.flagged && x.a);
  const pips: ReactNode[] = [];
  for (let i = 0; i < 20; i++) {
    const e = spent[i];
    pips.push(<span key={i} className={"tq-pip" + (e ? " " + (e.a === "yes" || e.a === "right" ? "yes" : "no") : "")}></span>);
  }
  return (
    <div className="tq-budget" aria-label={(g.asked || 0) + " of 20 questions asked"}>
      {pips}
    </div>
  );
}

/* The public Q/A log. */
export function TwentyLog({ g }: { g: TwentyState }) {
  const qa: TwentyQuestion[] = g.qa || [];
  if (!qa.length) {
    return (
      <div className="tq-log">
        <div className="tq-log-empty">{g.phase === "secret" ? (g.answerer || "The answerer") + " is choosing a secret." : "No questions yet."}</div>
      </div>
    );
  }
  // each answered entry's number (flagged ones get none), worked out before rendering
  const nums: (number | null)[] = [];
  let k = 0;
  for (const x of qa) nums.push(x.flagged ? null : ++k);
  return (
    <div className="tq-log">
      {qa.map((x, i) => {
        const a = x.flagged ? "unanswerable" : x.a ? x.a.toUpperCase() : "…";
        return (
          <div key={i} className={"tq-qa" + (x.flagged ? " flagged" : "") + (x.kind === "guess" ? " guess" : "")}>
            <span className="tq-qa-n">{nums[i] === null ? "–" : String(nums[i])}</span>
            <span className="tq-qa-by" style={{ color: hexOf(g, x.by) }}>
              {x.by}
            </span>
            <span className="tq-qa-q">{(x.kind === "guess" ? "Guess: " : "") + x.q}</span>
            <span className={"tq-qa-a " + (x.a === "yes" || x.a === "right" ? "yes" : x.a ? "no" : "")}>{a + (x.note ? " · " + x.note : "")}</span>
          </div>
        );
      })}
    </div>
  );
}

export function TwentyScores({ g, me, compact }: { g: TwentyState; me?: string; compact?: boolean }) {
  const ps: TwentyPlayer[] = ((g.players || []) as TwentyPlayer[]).slice().sort((a, b) => (b.score || 0) - (a.score || 0));
  return (
    <div className={"tq-scores" + (compact ? " compact" : "")}>
      {ps.map((p) => {
        const mine = !!me && p.name === me;
        const answering = g.status === "running" && g.answerer === p.name;
        return (
          <div key={p.name} className={"tq-srow" + (mine ? " mine" : "") + (answering ? " answerer" : "")}>
            <span className="hist-dot" style={{ background: p.hex }}></span>
            <span className="tq-name">{p.name + (mine ? " (you)" : "")}</span>
            {!compact && answering ? <span className="tq-st">answering</span> : null}
            <span className="tq-pts">{String(p.score || 0)}</span>
          </div>
        );
      })}
    </div>
  );
}

/* The last round: the secret, how it ended, the points. */
export function TwentyReveal({ r }: { r: TwentyRound | null }) {
  if (!r) {
    return (
      <div className="tq-reveal">
        <div className="tq-log-empty">No secret has been revealed yet.</div>
      </div>
    );
  }
  const how =
    r.how === "guessed" ? r.guessed_by + " named it after " + r.asked + (r.asked === 1 ? " question" : " questions") : r.how === "forfeit" ? r.answerer + " went silent and forfeit the round" : r.how === "idle" ? "The table stopped asking - " + r.answerer + " takes it" : "Twenty questions spent - " + r.answerer + " takes it";
  const pts = Object.keys(r.points || {})
    .filter((n) => r.points[n])
    .map((n) => n + " +" + r.points[n]);
  return (
    <div className="tq-reveal">
      <div className="tq-reveal-head">
        <span>{"Round " + r.n + " · " + r.answerer + "'s secret was "}</span>
        <span className="tq-reveal-secret">{"“" + r.secret + "”" + (r.drawn ? " (drawn)" : "")}</span>
      </div>
      <div className="tq-reveal-how">{how}</div>
      {pts.length ? <div className="tq-reveal-pts">{pts.join(" · ")}</div> : null}
    </div>
  );
}

/* The card: who answers and how far the round is, and the scores. */
export function TwentyCard({ g, me }: { g: TwentyState; me: string }) {
  const line =
    g.status === "running" && g.answerer
      ? "Round " + g.round + " of " + g.rounds_total + " · " + g.answerer + (g.phase === "secret" ? " is choosing a secret" : " answers · " + (g.asked || 0) + " of 20 asked")
      : g.status === "finished"
        ? "Finished · " + (g.rounds_total || 0) + " rounds"
        : (g.rounds_total || 0) + " rounds";
  return (
    <div className="tq-card">
      <div className="tq-card-line">{line}</div>
      <TwentyScores g={g} me={me} compact />
    </div>
  );
}
