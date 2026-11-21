import { useState } from "react";
import type { LiarsDicePlayer, LiarsDiceRound, LiarsDiceState, LiarsDiceYou } from "@chat/contract";
import { ldBidText, ldCounts, ldFaceWord } from "./liarsdice";

/* Liar's Dice's panels (2026-11-21, React): dice drawn with pips, the
   standing bid, your own cup, the bid builder (count, face, Bid or
   Liar), the table (dice left per seat, whose turn), the last round with
   every cup opened, and the chat card. The view (view.tsx) mounts them
   with ctx.panel, so the bid builder's draft is its own state and
   survives the view's repaints; the view keys it by turn, so it starts
   over on each of your turns. Cups are secret: the server sends only
   your own (you.dice) and the cups of closed rounds. */

// pip positions per face on a 3x3 grid, [row, column]
const PIPS: Record<number, [number, number][]> = {
  1: [[2, 2]],
  2: [[1, 3], [3, 1]],
  3: [[1, 3], [2, 2], [3, 1]],
  4: [[1, 1], [1, 3], [3, 1], [3, 3]],
  5: [[1, 1], [1, 3], [2, 2], [3, 1], [3, 3]],
  6: [[1, 1], [1, 3], [2, 1], [2, 3], [3, 1], [3, 3]],
};

type Draft = { qty: number; face: number };

export function LiarsDie({ face, cls }: { face: number; cls?: string }) {
  return (
    <span className={"ld-die" + (cls ? " " + cls : "")} role="img" aria-label={String(face)}>
      {(PIPS[face] || []).map(([r, c], i) => (
        <i key={i} style={{ gridRow: String(r), gridColumn: String(c) }}></i>
      ))}
    </span>
  );
}

/* The standing bid (or who opens), and the dice on the table. */
export function LiarsBidNow({ g }: { g: LiarsDiceState }) {
  if (g.status === "finished") {
    return (
      <div className="ld-now">
        <div className="ld-now-k">{"The table is cleared · " + ((g.rounds || []).length || g.round || 0) + " rounds"}</div>
      </div>
    );
  }
  const b = g.bid;
  if (b) {
    const p = (g.players || []).find((x) => x.name === b.by);
    return (
      <div className="ld-now">
        <div className="ld-now-k">{"Standing bid · round " + g.round}</div>
        <div className="ld-now-bid">
          <span className="ld-now-q">{b.qty + " ×"}</span>
          <LiarsDie face={b.face} cls="big" />
          <span className="ld-now-by" style={p ? { color: p.hex } : undefined}>
            {"by " + b.by}
          </span>
        </div>
        <div className="ld-now-sub">{"At least " + ldBidText(b) + " among all " + g.dice_total + " dice" + (g.ones_wild && b.face !== 1 ? " - ones count as " + ldFaceWord(b.face, true) : "") + "."}</div>
      </div>
    );
  }
  return (
    <div className="ld-now">
      <div className="ld-now-k">{"Round " + (g.round || 1)}</div>
      <div className="ld-now-open">{g.status === "running" && g.turn_of ? g.turn_of + " opens the bidding" : "No bid yet"}</div>
      <div className="ld-now-sub">{(g.dice_total || 0) + " dice on the table" + (g.ones_wild ? " · ones are wild" : "")}</div>
    </div>
  );
}

/* Your cup: your own dice (ones marked wild when they are). */
export function LiarsCup({ g }: { g: LiarsDiceState }) {
  const you: Partial<LiarsDiceYou> = g.you || {};
  const dice = (you.dice || []) as number[];
  return (
    <div className="ld-cup">
      <div className="ld-cup-k">Your cup</div>
      <div className="ld-cup-dice">
        {dice.map((d, i) => (
          <LiarsDie key={i} face={d} cls={g.ones_wild && d === 1 ? "wild" : ""} />
        ))}
      </div>
      {g.ones_wild && dice.indexOf(1) >= 0 ? <div className="ld-cup-note">Your ones are wild - they count toward any face.</div> : null}
    </div>
  );
}

/* Where the builder starts: the classic raise (one more of the same
   face), or, to open, one of the face you hold most of. */
function firstDraft(g: LiarsDiceState): Draft {
  const you: Partial<LiarsDiceYou> = g.you || {};
  const total = g.dice_total || 0;
  const wild = !!g.ones_wild;
  const lowFace = wild ? 2 : 1;
  const b = g.bid;
  let qty = 1;
  let face = lowFace;
  if (b && b.qty + 1 <= total) {
    qty = b.qty + 1;
    face = b.face;
  } else if (b) {
    qty = b.qty;
    face = Math.min(6, b.face + 1);
  } else {
    let best = -1;
    for (let f = lowFace; f <= 6; f++) {
      const k = ((you.dice || []) as number[]).filter((d) => ldCounts(d, f, wild)).length;
      if (k > best) {
        best = k;
        face = f;
      }
    }
    qty = Math.max(1, best);
  }
  return { qty: Math.max(1, Math.min(total, qty)), face };
}

/* The bid builder: a count, a face, and Bid - or Liar! when there is a
   bid to call. */
export function LiarsBidder({ g, onBid, onLiar }: { g: LiarsDiceState; onBid: (dir: string) => void; onLiar: () => void }) {
  const [draft, setDraft] = useState<Draft>(() => firstDraft(g));
  const wild = !!g.ones_wild;
  const total = g.dice_total || 0;
  const b = g.bid;
  const set = (qty: number, face: number) => setDraft({ qty: Math.max(1, Math.min(total, qty)), face });
  const faces: number[] = [];
  for (let f = wild ? 2 : 1; f <= 6; f++) faces.push(f);
  // the odds, from your own cup: what you hold, and the rest at random
  const mine = ((g.you && g.you.dice) || []) as number[];
  const held = mine.filter((d) => ldCounts(d, draft.face, wild)).length;
  const unknown = Math.max(0, total - mine.length);
  const expect = held + unknown * (wild && draft.face !== 1 ? 1 / 3 : 1 / 6);
  const beats = !b || draft.qty > b.qty || (draft.qty === b.qty && draft.face > b.face);
  return (
    <div className="ld-bidder your-move">
      <div className="ld-bidder-title">{b ? "Raise - or call liar" : "Open the bidding"}</div>
      <div className="ld-bid-row">
        <button type="button" className="fl-step" aria-label="One fewer die" disabled={draft.qty <= 1} onClick={() => set(draft.qty - 1, draft.face)}>
          −
        </button>
        <span className="ld-qty">{String(draft.qty)}</span>
        <button type="button" className="fl-step" aria-label="One more die" disabled={draft.qty >= total} onClick={() => set(draft.qty + 1, draft.face)}>
          +
        </button>
        <span className="ld-x">×</span>
        <div className="ld-faces" role="radiogroup" aria-label="Face">
          {faces.map((f) => (
            <button key={f} type="button" className={"ld-face" + (draft.face === f ? " on" : "")} role="radio" aria-checked={draft.face === f ? "true" : "false"} aria-label={ldFaceWord(f, true)} onClick={() => set(draft.qty, f)}>
              <LiarsDie face={f} />
            </button>
          ))}
        </div>
      </div>
      <div className="ld-odds">{"You hold " + held + " · about " + (Math.round(expect * 10) / 10) + " expected among all " + total}</div>
      <div className="ld-acts">
        <button type="button" className="duel-btn ld-go" disabled={!beats} title={!beats && b ? "A raise must beat " + ldBidText(b) + ": more dice, or the same count of a higher face" : undefined} onClick={() => onBid(draft.qty + "x" + draft.face)}>
          {"Bid " + ldBidText(draft)}
        </button>
        {b ? (
          <button type="button" className="duel-btn ld-liar" title={"Call liar on " + b.by + "'s " + ldBidText(b)} onClick={() => onLiar()}>
            Liar!
          </button>
        ) : null}
      </div>
      {!beats && b ? <div className="ld-why">{"Beat " + ldBidText(b) + ": more dice, or the same count of a higher face."}</div> : null}
    </div>
  );
}

/* The table: every seat in turn order, dice left, whose turn, their bid
   this round; the players who are out at the end. */
export function LiarsTable({ g, me, compact }: { g: LiarsDiceState; me?: string; compact?: boolean }) {
  const order: string[] = g.order || [];
  const ps: LiarsDicePlayer[] = (g.players || []).slice().sort((a, b) => {
    const ia = order.indexOf(a.name);
    const ib = order.indexOf(b.name);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
  const each = g.dice_each || 5;
  return (
    <div className={"ld-table" + (compact ? " compact" : "")}>
      {ps.map((p) => {
        const turn = g.status === "running" && g.turn_of === p.name;
        const mine = !!me && p.name === me;
        const left = p.dice || 0;
        const mineBids = (g.bids || []).filter((x) => x.by === p.name);
        const st = p.out ? "out" : turn ? (compact ? "to bid" : "thinking…") : mineBids.length ? ldBidText(mineBids[mineBids.length - 1]!) : "";
        const cups: number[] = [];
        for (let i = 0; i < each; i++) cups.push(i);
        return (
          <div key={p.name} className={"ld-seat" + (turn ? " turn" : "") + (p.out ? " out" : "") + (mine ? " mine" : "")}>
            <span className="hist-dot" style={{ background: p.hex }}></span>
            <span className="ld-name">{p.name + (mine ? " (you)" : "")}</span>
            <span className="ld-left" aria-label={left + " dice left"}>
              {cups.map((i) => (i < left ? <i key={i} style={{ background: p.hex }}></i> : <i key={i} className="lost"></i>))}
            </span>
            {st ? <span className="ld-st">{st}</span> : null}
          </div>
        );
      })}
    </div>
  );
}

/* A closed round: what happened, the verdict, and every cup opened with
   the dice that counted lit. */
export function LiarsRound({ g, round: r }: { g: LiarsDiceState; round: LiarsDiceRound | null }) {
  if (!r) {
    return (
      <div className="ld-reveal">
        <div className="ld-reveal-empty">No cup has been opened yet - a call of liar opens them all.</div>
      </div>
    );
  }
  const hexOf = (n: string) => (((g && g.players) || []).find((p: LiarsDicePlayer) => p.name === n) || { hex: "#94a3b8" }).hex;
  const call = r.call || null;
  const what = r.reason === "call" && call ? "Round " + r.n + ": " + call.by + " called liar on " + call.bid.by + "'s " + ldBidText(call.bid) : r.reason === "forfeit" ? "Round " + r.n + ": " + r.loser + " timed out a third time in a row" : "Round " + r.n + ": " + r.loser + "'s turn ran out";
  const face = call ? call.bid.face : 0;
  return (
    <div className="ld-reveal">
      <div className="ld-reveal-head">
        <span className="ld-reveal-what">{what}</span>
      </div>
      <div className={"ld-verdict" + (r.reason === "call" ? (r.stands ? " stands" : " lie") : "")}>
        {r.reason === "call" && call ? <span>{"The table showed " + r.count + " · " + (r.stands ? "the bid stands" : "the bid was a lie") + " · "}</span> : null}
        <span className="ld-loser" style={{ color: hexOf(r.loser) }}>
          {r.loser + (r.out ? " is out" : " loses a die (" + r.dice_left + " left)")}
        </span>
      </div>
      {Object.keys(r.cups || {}).map((n) => (
        <div key={n} className="ld-open-row">
          <span className="ld-open-name" style={{ color: hexOf(n) }}>
            {n}
          </span>
          <span className="ld-open-dice">
            {((r.cups[n] || []) as number[]).map((d, i) => (
              <LiarsDie key={i} face={d} cls={face ? (ldCounts(d, face, !!g.ones_wild) ? "hit" : "dim") : ""} />
            ))}
          </span>
        </div>
      ))}
    </div>
  );
}

/* The card: the standing bid and the table. */
export function LiarsDiceCard({ g, me }: { g: LiarsDiceState; me: string }) {
  return (
    <div className="ld-card">
      <LiarsBidNow g={g} />
      <LiarsTable g={g} me={me} compact />
    </div>
  );
}
