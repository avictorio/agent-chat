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
/* eslint-disable @typescript-eslint/no-explicit-any */
function gameSignature(g: any): string | null {
  if (!g || !g.type) return null;
  if (g.type === "battleship") {
    const lm = g.last_move;
    return ["bs", g.status, g.phase || "", g.turn || 0, lm ? lm.by + lm.cell + (lm.sunk || "") : ""].join("|");
  }
  if (g.type === "fourinarow") return ["c4", g.status, g.turn || 0, (g.board || []).join("")].join("|");
  if (g.type === "trust") return ["tr", g.status, g.round || 0, (g.rounds || []).length].join("|");
  if (g.type === "lettergrid") return ["lg", g.status, g.round || 0, (g.rounds || []).length].join("|");
  if (g.type === "trivia") return ["tv", g.status, g.round || 0, g.phase || "", (g.rounds || []).length].join("|");
  if (g.type === "sketch") return ["sg", g.status, g.round || 0, g.phase || "", (g.rounds || []).length].join("|");
  if (g.type === "auction") return ["au", g.status, g.round || 0, (g.rounds || []).length].join("|");
  if (g.type === "werewolf") return ["ww", g.status, g.phase || "", g.night || 0, g.day || 0, (g.players || []).filter((p: any) => p.alive).length].join("|");
  if (g.type === "twenty") return ["tq", g.status, g.round || 0, g.phase || "", g.asked || 0].join("|");
  if (g.type === "corpse") return ["ec", g.status, g.phase || "", g.turn || 0, g.segments || 0, (g.players || []).filter((p: any) => p.committed).length].join("|");
  if (g.type === "twotruths") return ["tt", g.status, g.round || 0, g.phase || "", (g.players || []).map((p: any) => p.score || 0).join("-")].join("|");
  if (g.type === "liarsdice") return ["ld", g.status, g.turn || 0, g.round || 0, g.bid ? g.bid.qty + "x" + g.bid.face : ""].join("|");
  if (g.type === "coderace") {
    const solved = (g.players || []).filter((p: any) => p.solved).length;
    return ["cr", g.status, g.round || 0, (g.rounds || []).length, solved].join("|");
  }
  if (g.type === "duel" || g.type === "frontlines") {
    const rounds = g.rounds || [];
    const sc = g.score || {};
    return [g.type, g.status, g.round || 0, rounds.length, Object.values(sc).join("-")].join("|");
  }
  const alive = (g.players || []).filter((p: any) => p.alive).length;
  return ["lc", g.status, g.tick || 0, alive].join("|");
}

// The colour of whoever made the latest move, for the pulse ring.
function gameMoverHex(g: any): string | null {
  if (!g || !g.players) return null;
  let name: string | null = null;
  if (g.type === "battleship" && g.last_move) name = g.last_move.by;
  else if ((g.type === "duel" || g.type === "frontlines") && g.rounds && g.rounds.length) name = g.rounds[g.rounds.length - 1].winner;
  else if (g.type === "coderace" && g.rounds && g.rounds.length) name = (g.rounds[g.rounds.length - 1].solved || [])[0] || null;
  else if (g.type === "fourinarow" && g.last_move) name = g.last_move.by;
  else if (g.type === "auction" && g.rounds && g.rounds.length) name = g.rounds[g.rounds.length - 1].winner;
  else if (g.type === "twotruths" && g.status === "running") name = g.teller;
  else if (g.type === "corpse" && g.status === "running") name = g.turn_of;
  else if (g.type === "twenty" && g.status === "running") name = g.answerer;
  else if (g.type === "trivia" && g.status === "running") name = g.asker;
  else if (g.type === "sketch" && g.status === "running") name = g.artist;
  else if (g.type === "liarsdice" && g.status !== "finished") name = g.bid ? g.bid.by : g.last_round ? g.last_round.loser : null;
  else if (g.status === "finished") name = g.winner;
  if (!name) return null;
  const p = (g.players || []).find((x: any) => x.name === name);
  return p ? p.hex : null;
}

