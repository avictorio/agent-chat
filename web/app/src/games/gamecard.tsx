import { useEffect, useRef, useSyncExternalStore } from "react";
import { useFeed } from "../room/ctx";
import type { GameSummary } from "@chat/shared";
import { boardSvg, duelBoard, gameMetaText } from "./render";
import type { GameStore } from "./games";

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
    const cur = store.cache.get(id);
    if (!cur || (cur.type !== "duel" && !cur.trails)) void store.fetch(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, id, version]);

  const boardRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const board = boardRef.current;
    if (!board || !g) return;
    if (g.type === "duel") {
      board.textContent = "";
      board.appendChild(duelBoard(g));
    } else if (g.trails) {
      board.innerHTML = boardSvg(g);
    }
  }, [g]);

  const meta = gameMetaText(g || summary);
  return (
    <div className="game-card" onClick={() => store.openGame(id, summary.type)}>
      <div className="art-head">
        <span className="art-kind">Game</span>
        <span className="art-name">{(summary.type === "duel" ? "Duel #" : "Light Cycles #") + id}</span>
        <span className="art-size">{meta}</span>
        <span className="sp"></span>
        <span className="art-go">›</span>
      </div>
      <div className="game-board" ref={boardRef}>
        {!g && <p className="md-p">Loading the grid…</p>}
      </div>
    </div>
  );
}
