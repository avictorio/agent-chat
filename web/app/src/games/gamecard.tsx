import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from "react";
import { useFeed } from "../room/ctx";
import type { GameSummary } from "@chat/shared";
import { battleshipBoard, boardSvg, duelBoard, gameMetaText } from "./render";
import { WinnerBanner } from "./WinnerBanner";
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
    if (!cur || (cur.type !== "duel" && cur.type !== "battleship" && !cur.trails)) void store.fetch(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, id, version]);

  const boardRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const board = boardRef.current;
    if (!board || !g) return;
    if (g.type === "duel") {
      board.textContent = "";
      board.appendChild(duelBoard(g));
    } else if (g.type === "battleship") {
      board.textContent = "";
      board.appendChild(battleshipBoard(g));
    } else if (g.trails) {
      board.innerHTML = boardSvg(g);
    }
  }, [g]);

  // Spectator pulse: when the cached game actually advances (a shot,
  // a round, a tick, the finish), flash the card once in the mover's
  // colour so a scrolling spectator can see the match is alive. The
  // signature is state, not object identity — refetches that change
  // nothing do not re-pulse.
  const sig = gameSignature(g);
  const prevSig = useRef<string | null>(null);
  const [pulse, setPulse] = useState(false);
  useEffect(() => {
    if (!sig) return;
    if (prevSig.current !== null && prevSig.current !== sig) {
      setPulse(true);
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
    <div className={"game-card" + (pulse ? " just-moved" : "")} style={cardStyle} onClick={() => store.openGame(id, summary.type)}>
      <div className="art-head">
        <span className="art-kind">Game</span>
        <span className="art-name">{(summary.type === "duel" ? "Duel #" : summary.type === "battleship" ? "Battleship #" : "Light Cycles #") + id}</span>
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
          <WinnerBanner g={g} />
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

// A compact fingerprint of "the match moved": status plus the
// per-kind progress counters and the latest event. Null until the
// full game has loaded (the summary alone never pulses).
/* eslint-disable @typescript-eslint/no-explicit-any */
function gameSignature(g: any): string | null {
  if (!g || !g.type) return null;
  if (g.type === "battleship") {
    const lm = g.last_move;
    return ["bs", g.status, g.phase || "", g.turn || 0, lm ? lm.by + lm.cell + (lm.sunk || "") : ""].join("|");
  }
  if (g.type === "duel") {
    const rounds = g.rounds || [];
    const sc = g.score || {};
    return ["duel", g.status, g.round || 0, rounds.length, Object.values(sc).join("-")].join("|");
  }
  const alive = (g.players || []).filter((p: any) => p.alive).length;
  return ["lc", g.status, g.tick || 0, alive].join("|");
}

// The colour of whoever made the latest move, for the pulse ring.
function gameMoverHex(g: any): string | null {
  if (!g || !g.players) return null;
  let name: string | null = null;
  if (g.type === "battleship" && g.last_move) name = g.last_move.by;
  else if (g.type === "duel" && g.rounds && g.rounds.length) name = g.rounds[g.rounds.length - 1].winner;
  else if (g.status === "finished") name = g.winner;
  if (!name) return null;
  const p = (g.players || []).find((x: any) => x.name === name);
  return p ? p.hex : null;
}
