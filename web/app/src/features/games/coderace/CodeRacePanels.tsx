import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactElement } from "react";
import type { CodeRaceFeedback, CodeRaceGuess, CodeRacePlayer, CodeRaceRound, CodeRaceState } from "@chat/contract";
import { crWhat } from "../shared/render";
import { crPalette, crStatus, TILE_LABEL, type Pal } from "./coderace";

/* Code Race's panels: the race board (the lanes, for devices without
   WebGL), the secret once the race is over, the guess input and the
   chat card. The view (view.tsx) mounts them with ctx.panel, keying the
   input by round, so the guess being made is its own state: a poll or a
   rival's guess never wipes it, and it starts over each round. The word
   box starts from the draft when it mounts and reports every keystroke
   back. Uncontrolled field: see docs/agents/games.md, Panels. */

/* A peg in its colour (its letter inside, for colour-blind eyes), or an
   empty slot. Keyed by colour where it can change, so a cleared slot
   keeps no empty style. */
function Peg({ pal, k }: { pal: Pal; k: string | null }) {
  const c = k ? pal.find((x) => x.k === k) : null;
  if (!c) return <span className={"cr-peg" + (k ? "" : " empty")}></span>;
  return (
    <span className="cr-peg" style={{ "--peg": c.hex } as CSSProperties} title={c.name} aria-label={c.name}>
      {c.k}
    </span>
  );
}

/* Feedback for one guess. Colors: [black, white] as dots and rings in a
   little block. Words: the tile colours (with letters when we have the
   guess). The History rows draw the same with crFeedbackEl. */
function CrFeedback({ g, fb, guess }: { g: CodeRaceState; fb: CodeRaceFeedback; guess?: string | null }) {
  if (g.mode === "words") {
    const s = String(fb || "");
    const tiles: ReactElement[] = [];
    for (let i = 0; i < (g.length || s.length); i++) {
      const f = s[i] || ".";
      const letter = guess ? String(guess[i] || "").toUpperCase() : "";
      tiles.push(
        <span key={i} className={"cr-tile " + (f === "G" ? "g" : f === "Y" ? "y" : "n")} aria-label={(guess ? letter + ": " : "") + TILE_LABEL[f]}>
          {letter}
        </span>
      );
    }
    return <span className="cr-tiles">{tiles}</span>;
  }
  // colors mode: fb is the [black, white] pair
  const b = (fb && (fb as [number, number])[0]) || 0;
  const w = (fb && (fb as [number, number])[1]) || 0;
  const pips: ReactElement[] = [];
  for (let i = 0; i < (g.length || 4); i++) pips.push(<span key={i} className={"cr-pip" + (i < b ? " hit" : i < b + w ? " near" : "")}></span>);
  return (
    // the classic block: 2 x 2 for four pegs, 3 across for five or six
    <span className="cr-pips" aria-label={b + " right place, " + w + " right colour wrong place"} title={b + " right place · " + w + " right colour, wrong place"} style={{ "--pc": String(Math.ceil((g.length || 4) / 2)) } as CSSProperties}>
      {pips}
    </span>
  );
}

/* One guess row: the guess (pegs or tiles) and its feedback. */
function GuessRow({ g, n, guess, fb, sealed, cracked }: { g: CodeRaceState; n: number; guess: string | null; fb: CodeRaceFeedback | null; sealed?: boolean; cracked?: boolean }) {
  let body;
  if (g.mode === "words") {
    if (fb) body = <CrFeedback g={g} fb={fb} guess={guess} />;
    else {
      const tiles: ReactElement[] = [];
      for (let i = 0; i < (g.length || 5); i++)
        tiles.push(
          <span key={i} className="cr-tile open">
            {guess ? String(guess[i] || "").toUpperCase() : ""}
          </span>
        );
      body = <span className="cr-tiles">{tiles}</span>;
    }
  } else {
    const pal = crPalette(g);
    const pegs: ReactElement[] = [];
    for (let i = 0; i < (g.length || 4); i++) pegs.push(guess ? <Peg key={i + ":" + (guess[i] || "")} pal={pal} k={guess[i] || null} /> : <span key={i} className="cr-peg hidden"></span>);
    body = (
      <>
        <span className="cr-pegs">{pegs}</span>
        {fb ? <CrFeedback g={g} fb={fb} /> : null}
      </>
    );
  }
  return (
    <div className={"cr-row" + (sealed ? " sealed" : "") + (cracked ? " cracked" : "")}>
      <span className="cr-n">{String(n)}</span>
      {body}
      {sealed ? <span className="cr-sealed">sealed</span> : null}
    </div>
  );
}

/* The secret, once the race is over (the view mounts it then). */
export function CodeRaceSecret({ g }: { g: CodeRaceState }) {
  if (!g || g.secret == null) return null;
  return (
    <div className="cr-secret">
      <span className="cr-secret-label">{g.mode === "words" ? "The word" : "The code"}</span>
      {g.mode === "words" ? (
        <span className="cr-tiles">
          {String(g.secret)
            .split("")
            .map((c, i) => (
              <span key={i} className="cr-tile g">
                {c.toUpperCase()}
              </span>
            ))}
        </span>
      ) : (
        <span className="cr-pegs">
          {(g.secret as string[]).map((k, i) => (
            <Peg key={i + ":" + k} pal={crPalette(g)} k={k} />
          ))}
        </span>
      )}
    </div>
  );
}

/* A racer's lane: name, status, and their rounds. Yours carries your
   guesses (and the sealed one for this round); a rival's carries only
   feedback while the race runs. */
function Lane({ g, p, me, compact, place }: { g: CodeRaceState; p: CodeRacePlayer; me?: string; compact?: boolean; place?: number }) {
  const mine = !!(me && p.name === me);
  const rows: ReactElement[] = [];
  (g.rounds || []).forEach((r: CodeRaceRound) => {
    const x = (r.guesses || {})[p.name];
    if (!x) return;
    rows.push(<GuessRow key={r.n} g={g} n={r.n} guess={x.guess || null} fb={x.fb} cracked={(r.solved || []).indexOf(p.name) >= 0} />);
  });
  if (mine && g.status === "running" && g.you && g.you.queued) rows.push(<GuessRow key="sealed" g={g} n={g.round} guess={g.you.queued} fb={null} sealed />);
  return (
    <div className={"cr-lane" + (mine ? " mine" : "") + (p.solved ? " solved" : "") + (p.out ? " out" : "") + (compact ? " compact" : "")} style={{ "--who": p.hex || "#94a3b8" } as CSSProperties}>
      <div className="cr-lane-head">
        {place ? <span className="cr-place">{place === 1 ? "🏆" : "#" + place}</span> : null}
        <span className="hist-dot" style={{ background: p.hex }}></span>
        <span className="cr-lane-name">{p.name + (mine ? " (you)" : "")}</span>
        <span className="cr-lane-st">{crStatus(g, p)}</span>
      </div>
      <div className="cr-rows">{rows.length ? rows : <div className="cr-none">{g.status === "running" ? "No guesses yet" : "No guesses"}</div>}</div>
    </div>
  );
}

/* The board: the viewer's lane first, then the rivals (in place order
   once the race is over). */
export function CodeRaceBoard({ g, me, compact }: { g: CodeRaceState; me?: string; compact?: boolean }) {
  let ps: CodeRacePlayer[] = ((g && g.players) || []).slice();
  const places: string[] | null = Array.isArray(g.places) ? g.places : null;
  if (places) ps.sort((a, b) => places.indexOf(a.name) - places.indexOf(b.name));
  else if (me) ps = ps.filter((p) => p.name === me).concat(ps.filter((p) => p.name !== me));
  return (
    <div className={"cr-board" + (compact ? " compact" : "")}>
      {ps.map((p) => (
        <Lane key={p.name} g={g} p={p} me={me} compact={compact} place={places ? places.indexOf(p.name) + 1 : undefined} />
      ))}
    </div>
  );
}

/* The guess input. Colors: tap a colour to fill the next slot, tap a
   slot to clear it; Random and Clear; Guess once every slot is set.
   Words: type the word (the server checks it is in the list). The draft
   starts from the guess you sent; the view keys the panel by round. */
export function CodeRaceInput({ g, onCommit }: { g: CodeRaceState; onCommit: (v: string) => void }) {
  const queued: string | null = (g.you && g.you.queued) || null;
  const [draft, setDraft] = useState(() => queued || "");
  const len = g.length || (g.mode === "words" ? 5 : 4);
  const same = !!queued && queued.toLowerCase() === draft.toLowerCase();
  const goLabel = same ? "Guessed ✓" : queued ? "Change guess" : "Guess";
  const box = useRef<HTMLInputElement>(null);
  const [seed] = useState(draft);
  useLayoutEffect(() => {
    if (box.current) box.current.value = seed.toUpperCase();
  }, [seed]);
  const head = (
    <div className="cr-input-head">
      <span className="cr-input-title">{queued ? "Your guess is in" : "Your guess · round " + g.round}</span>
      {g.mode !== "words" ? <span className="cr-legend">{"● right place  ○ right colour"}</span> : null}
    </div>
  );
  if (g.mode === "words") {
    const clean = (v: string) => v.replace(/[^a-z]/gi, "").slice(0, len).toLowerCase();
    const off = draft.length !== len || same;
    return (
      <div className={"cr-input" + (queued ? "" : " your-move")}>
        {head}
        <div className="cr-word-row">
          <input
            ref={box}
            className="cr-word"
            type="text"
            maxLength={len}
            size={len}
            placeholder={"?".repeat(len)}
            autoComplete="off"
            spellCheck={false}
            autoCapitalize="characters"
            aria-label={"Your " + len + "-letter guess"}
            onInput={(e) => setDraft(clean(e.currentTarget.value))}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !off) {
                e.preventDefault();
                onCommit(clean(e.currentTarget.value));
              }
            }}
          />
          <button type="button" className="duel-btn cr-go" disabled={off} onClick={() => onCommit(clean(box.current ? box.current.value : draft))}>
            {goLabel}
          </button>
        </div>
      </div>
    );
  }
  const pal = crPalette(g);
  const keys = draft.toUpperCase().split("").slice(0, len);
  const slots: ReactElement[] = [];
  for (let n = 0; n < len; n++) {
    const i = n;
    const k = keys[i] || null;
    slots.push(
      <button
        key={i}
        type="button"
        className="cr-slot"
        aria-label={"Slot " + (i + 1) + ": " + (k ? (pal.find((c) => c.k === k) || { name: k }).name + " - tap to clear" : "empty")}
        disabled={!k}
        onClick={() => {
          const next = keys.slice();
          next.splice(i, 1);
          setDraft(next.join(""));
        }}
      >
        <Peg key={k || ""} pal={pal} k={k} />
      </button>
    );
  }
  const random = () => Array.from({ length: len }, () => (pal[Math.floor(Math.random() * pal.length)] || { k: "R" }).k).join("");
  return (
    <div className={"cr-input" + (queued ? "" : " your-move")}>
      {head}
      <div className="cr-slots">{slots}</div>
      <div className="cr-palette">
        {pal.map((c) => (
          <button key={c.k} type="button" className="cr-color" style={{ "--peg": c.hex } as CSSProperties} title={c.name} aria-label={"Add " + c.name} disabled={keys.length >= len} onClick={() => setDraft((keys.join("") + c.k).slice(0, len))}>
            {c.k}
          </button>
        ))}
      </div>
      <div className="cr-acts">
        <button type="button" className="duel-btn quiet sm" onClick={() => setDraft(random())}>
          Random
        </button>
        <button type="button" className="duel-btn quiet sm" onClick={() => setDraft("")}>
          Clear
        </button>
        <button type="button" className="duel-btn cr-go" disabled={keys.length !== len || same} onClick={() => onCommit(keys.join(""))}>
          {goLabel}
        </button>
      </div>
    </div>
  );
}

/* The card: the race as compact lanes (latest feedback per racer), and
   the secret once it's over. */
export function CodeRaceCard({ g, me }: { g: CodeRaceState; me: string }) {
  let ps: CodeRacePlayer[] = ((g && g.players) || []).slice();
  const places: string[] | null = Array.isArray(g.places) ? g.places : null;
  if (places) ps.sort((a, b) => places.indexOf(a.name) - places.indexOf(b.name));
  return (
    <div className="cr-card">
      <div className="cr-card-cap">{crWhat(g) + (g.status === "running" ? " · round " + g.round + " of " + (g.max_rounds || "?") : "")}</div>
      <CodeRaceSecret g={g} />
      <div className="cr-card-list">
        {ps.map((p) => {
          let last = null as CodeRaceGuess | null;
          (g.rounds || []).forEach((r) => {
            const x = (r.guesses || {})[p.name];
            if (x) last = x;
          });
          return (
            <div key={p.name} className={"cr-card-row" + (p.solved ? " solved" : "") + (p.out ? " out" : "")}>
              <span className="hist-dot" style={{ background: p.hex }}></span>
              <span className="cr-card-name">{p.name + (me && p.name === me ? " (you)" : "")}</span>
              {last ? <CrFeedback g={g} fb={last.fb} guess={last.guess || null} /> : null}
              <span className="cr-card-st">{crStatus(g, p)}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
