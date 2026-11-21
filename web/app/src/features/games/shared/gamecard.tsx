import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from "react";
import { useFeed } from "../../room/ctx";
import type { GameSummary } from "@chat/contract";
import { gameMetaText } from "./render";
import type { GL } from "./render";
import { WinnerBanner } from "./WinnerBanner";
import { pressable } from "../../../lib/index";
import { matchTitle } from "./catalog";
import { GAMES } from "../registry";

// The game card in the feed: header (kind, name, live meta line) and
// the board — the Light Cycles SVG or the Duel scoreboard — rendered
// from the store's cached game, fetching it on first sight like the
// current app. Tapping opens the arena in the viewer.

export function GameCardBlock({ summary }: { summary: GameSummary }) {
  const store = useFeed().games;
  const version = useSyncExternalStore(store.subscribe, store.getVersion);
  const id = summary.id;
  const g = store.cache.get(id) || null;

  useEffect(() => {
    if (!isLoaded(store.cache.get(id))) void store.fetch(id);
  }, [store, id, version]);

  const boardRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const board = boardRef.current;
    if (!board || !g) return;
    // Each game's card board, from the registry (registry.ts); a match
    // without a type is Light Cycles (its painter wants trails).
    const plugin = GAMES[g.type] || GAMES.lightcycles;
    if (plugin) plugin.card(board, g, store.meName());
  }, [g, store]);

  // Spectator pulse: when the cached game actually advances (a shot,
  // a round, a tick, the finish), flash the card once in the mover's
  // colour so a scrolling spectator can see the match is alive. The
  // signature is state, not object identity — refetches that change
  // nothing do not re-pulse.
  const sig = gameSignature(g);
  const prevSig = useRef<string | null>(null);
  const [pulse, setPulse] = useState(false);
  const [freshWin, setFreshWin] = useState(false);
  useEffect(() => {
    if (!sig) return;
    if (prevSig.current !== null && prevSig.current !== sig) {
      setPulse(true);
      // The banner gets its ceremony only when the finish itself
      // happened while this card was on screen.
      if (prevSig.current.split("|")[1] !== "finished" && sig.split("|")[1] === "finished") setFreshWin(true);
      const t = setTimeout(() => setPulse(false), 1400);
      prevSig.current = sig;
      return () => clearTimeout(t);
    }
    prevSig.current = sig;
  }, [sig]);

  const moverHex = gameMoverHex(g);
  const cardStyle = moverHex ? ({ "--move-c": moverHex } as CSSProperties) : undefined;
  const meta = gameMetaText(g || summary);
  return (
    <div className={"game-card kind-" + summary.type + (pulse ? " just-moved" : "")} style={cardStyle} {...pressable(() => store.openGame(id, summary.type), "Open " + matchTitle(summary.type, id))}>
      <div className="art-head">
        <span className="art-kind">Game</span>
        <span className="art-name">{matchTitle(summary.type, id)}</span>
        <span className="art-size">{meta}</span>
        <span className="sp"></span>
        {g && g.status === "running" ? <span className="gm-live" title="Live now"></span> : null}
        <span className="art-go">›</span>
      </div>
      <div className="game-board" ref={boardRef}>
        {!g && <p className="md-p">Loading the grid…</p>}
      </div>
      {g && (g.status === "finished" || g.status === "cancelled") ? (
        <div className="game-result">
          <WinnerBanner g={g} ceremony={freshWin} />
          <div className="duel-pad">
            <button
              type="button"
              className="duel-btn"
              onClick={(e) => {
                e.stopPropagation();
                void store.rematch(g);
              }}
            >
              Rematch
            </button>
          </div>
        </div>
      ) : null}
      {g && g.status === "lobby" && g.you && g.you.playing && !g.you.accepted ? (
        <div className="game-lobby-actions">
          <button
            type="button"
            className="duel-btn"
            onClick={(e) => {
              e.stopPropagation();
              void store.respond(id, true);
            }}
          >
            Accept
          </button>
          <button
            type="button"
            className="duel-btn quiet"
            onClick={(e) => {
              e.stopPropagation();
              void store.respond(id, false);
            }}
          >
            Decline
          </button>
        </div>
      ) : null}
    </div>
  );
}

// Whether the cache holds the whole match: any registered game but Light
// Cycles counts once cached; Light Cycles (and a match without a known
// type) needs its trails, which the summary lacks.
function isLoaded(g: GL | undefined): boolean {
  if (!g) return false;
  if (g.type && g.type !== "lightcycles" && GAMES[g.type]) return true;
  return !!g.trails;
}

// A compact fingerprint of "the match moved": status plus the
// per-kind progress counters and the latest event. Null until the
// full game has loaded (the summary alone never pulses).
function gameSignature(g: GL): string | null {
  if (!g || !g.type) return null;
  const own = GAMES[g.type]?.signature;
  if (own) return own(g);
  const alive = (g.players || []).filter((p: GL) => p.alive).length;
  return ["lc", g.status, g.tick || 0, alive].join("|");
}

// The colour of whoever made the latest move, for the pulse ring.
function gameMoverHex(g: GL): string | null {
  if (!g || !g.players) return null;
  // the game's own mover (registry.ts); without one, a finished match's winner
  const own = GAMES[g.type]?.mover;
  const moved = own ? own(g) : undefined;
  const name: string | null = moved !== undefined ? moved : g.status === "finished" ? g.winner : null;
  if (!name) return null;
  const p = (g.players || []).find((x: GL) => x.name === name);
  return p ? p.hex : null;
}

