import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { AuctionPlayer, AuctionRound, AuctionState, AuctionYou } from "@chat/contract";
import { auStatus } from "./auction";

/* The auction's panels: the lot under the hammer, the bidders (budget
   left, lots won, who has bid), your sealed bid, the last lot's result
   and the chat card. The view (view.tsx) mounts them with ctx.panel, so
   the bid's draft is its own state and survives the view's repaints.
   Pending bids are secret (the server sends only your own); resolved
   lots show every bid. */

/* The lot under the hammer (or, once it's over, the season's end). */
export function AuctionLot({ g }: { g: AuctionState }) {
  return (
    <div className="au-lot">
      {g.status === "running" && g.lot ? (
        <>
          <div className="au-lot-n">{"Lot " + g.round + " of " + g.lots_total}</div>
          <div className="au-lot-name">{"“" + g.lot + "”"}</div>
        </>
      ) : (
        <div className="au-lot-n">{g.status === "finished" ? "The season is over · " + (g.rounds || []).length + " lots" : g.lots_total + " lots"}</div>
      )}
    </div>
  );
}

/* The bidders: budget left as a bar, lots won, who has bid. */
export function AuctionPlayers({ g, me, compact }: { g: AuctionState; me?: string; compact?: boolean }) {
  const ps: AuctionPlayer[] = ((g && g.players) || []).slice().sort((a: AuctionPlayer, b: AuctionPlayer) => (b.won || 0) - (a.won || 0) || (b.budget || 0) - (a.budget || 0));
  return (
    <div className={"au-players" + (compact ? " compact" : "")}>
      {ps.map((p: AuctionPlayer) => {
        const mine = !!me && p.name === me;
        const st = auStatus(g, p);
        return (
          <div key={p.name} className={"au-row" + (mine ? " mine" : "")}>
            <span className="hist-dot" style={{ background: p.hex }}></span>
            <span className="au-name">{p.name + (mine ? " (you)" : "")}</span>
            <span className="au-budget" title={(p.budget || 0) + " of " + g.budget + " left"}>
              <span className="au-budget-fill" style={{ width: Math.round((100 * (p.budget || 0)) / Math.max(1, g.budget || 100)) + "%", background: p.hex }}></span>
            </span>
            <span className="au-left">{String(p.budget || 0)}</span>
            <span className="au-won">{"🏷 " + (p.won || 0)}</span>
            {st && !compact ? <span className="au-st">{st}</span> : null}
          </div>
        );
      })}
    </div>
  );
}

/* Your bid: a number box with steps, quick amounts, and Bid. The draft
   starts from the bid you sent; the view keys the panel by lot, so it
   starts over each lot. The box shows the draft as its value property
   and takes what you type on change (blur, Enter, the spinner), not per
   keystroke. Uncontrolled field: see docs/agents/games.md, Panels. */
export function AuctionBid({ g, onCommit }: { g: AuctionState; onCommit: (v: number) => void }) {
  const you: Partial<AuctionYou> = g.you || {};
  const max = you.budget || 0;
  const queued: number | null = you.queued == null ? null : Number(you.queued);
  const [draft, setDraft] = useState<number>(() => (queued != null ? queued : 0));
  const box = useRef<HTMLInputElement | null>(null);
  useLayoutEffect(() => {
    if (box.current) box.current.value = String(draft);
  }, [draft]);
  useEffect(() => {
    const inp = box.current;
    if (!inp) return;
    const onChange = () => {
      const v = Math.max(0, Math.min(max, Math.round(Number(inp.value)) || 0));
      inp.value = String(v);
      setDraft(v);
    };
    inp.addEventListener("change", onChange);
    return () => inp.removeEventListener("change", onChange);
  }, [max]);
  const set = (v: number) => setDraft(Math.max(0, Math.min(max, Math.round(v) || 0)));
  const quick: [string, number][] = [["Pass", 0]];
  if (max >= 10) quick.push(["10", 10]);
  if (max >= 25) quick.push(["25", 25]);
  if (max > 1) quick.push(["Half", Math.floor(max / 2)]);
  quick.push(["All in", max]);
  const same = queued != null && queued === draft;
  return (
    <div className={"au-bid" + (queued == null ? " your-move" : "")}>
      <div className="au-bid-title">{queued == null ? "Your sealed bid" : "Your bid is in: " + (queued ? queued : "pass")}</div>
      <div className="au-bid-row">
        <button type="button" className="fl-step" aria-label="5 less" disabled={draft <= 0} onClick={() => set(draft - 5)}>
          −
        </button>
        <input ref={box} className="au-num" type="number" inputMode="numeric" min="0" max={String(max)} aria-label={"Your bid, 0 to " + max} />
        <button type="button" className="fl-step" aria-label="5 more" disabled={draft >= max} onClick={() => set(draft + 5)}>
          +
        </button>
        <span className="au-of">{"of " + max}</span>
      </div>
      <div className="au-acts">
        {quick.map(([label, v]) => (
          <button key={label} type="button" className="duel-btn quiet sm" disabled={v > max} onClick={() => set(v)}>
            {label}
          </button>
        ))}
        <button type="button" className="duel-btn au-go" disabled={same} onClick={() => onCommit(draft)}>
          {same ? "Bid in ✓" : draft ? "Bid " + draft : "Pass"}
        </button>
      </div>
    </div>
  );
}

/* The last lot's result: who won it and for how much, and every bid.
   Keyed by lot, so each lot's result is made afresh (an unsold lot's
   verdict keeps no empty style from the last one's winner). */
export function AuctionResult({ g, round }: { g: AuctionState; round: AuctionRound | null }) {
  if (!round) {
    return (
      <div className="au-result">
        <div className="au-result-empty">No lot has sold yet - bids are opened together.</div>
      </div>
    );
  }
  const hexOf = (n: string) => (((g && g.players) || []).find((p: AuctionPlayer) => p.name === n) || { hex: "#94a3b8" }).hex;
  const bids = Object.keys(round.bids || {}).map((n) => [n, round.bids[n] as number] as [string, number]);
  bids.sort((a, b) => b[1] - a[1]);
  const top = Math.max(1, ...bids.map((b) => b[1]));
  return (
    <div key={round.n} className="au-result">
      <div className="au-result-head">
        <span className="au-result-lot">{"Lot " + round.n + ": “" + round.lot + "”"}</span>
        <span className="au-result-v" style={round.winner ? { color: hexOf(round.winner) } : undefined}>
          {round.winner ? round.winner + " · " + round.price : "unsold"}
        </span>
      </div>
      {bids.map(([n, b]) => (
        <div key={n} className={"au-bidrow" + (n === round.winner ? " won" : "")}>
          <span className="au-bidname" style={{ color: hexOf(n) }}>
            {n}
          </span>
          <span className="au-bidbar">
            <span className="au-bidfill" style={{ width: Math.round((100 * b) / top) + "%", background: hexOf(n) }}></span>
          </span>
          <span className="au-bidn">{(round.missed || []).indexOf(n) >= 0 ? "no bid" : b ? String(b) : "pass"}</span>
        </div>
      ))}
      {round.tie ? <div className="au-tie">{"A tie at the top - it went to the one who " + round.tie + "."}</div> : null}
    </div>
  );
}

/* The card: the lot under the hammer and the bidders. */
export function AuctionCard({ g, me }: { g: AuctionState; me: string }) {
  return (
    <div className="au-card">
      <AuctionLot g={g} />
      <AuctionPlayers g={g} me={me} compact />
    </div>
  );
}
