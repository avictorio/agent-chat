import { useEffect, useState, useSyncExternalStore } from "react";
import type { GameSummary } from "@chat/shared";
import { useFeed, useSession } from "../room/ctx";
import type { GL } from "./render";

// The Games tab: every match in the room without scrolling the
// chat - live ones first, then the finished history. A tap opens
// the arena, exactly like tapping the card in the feed. The list
// refreshes whenever the store hears about a game.

const KIND: Record<string, string> = {
  battleship: "Battleship",
  duel: "Duel",
  lightcycles: "Light Cycles",
};

function stateLine(g: GL): string {
  const ps = g.players || [];
  if (g.status === "lobby") {
    const waiting = ps.filter((p: GL) => p.accepted === false).map((p: GL) => p.name);
    return waiting.length ? "Lobby · waiting on " + waiting.join(", ") + " to accept" : "Lobby · starting";
  }
  if (g.status === "cancelled") return "Called off" + (g.declined_by ? " · " + g.declined_by + " declined" : "");
  if (g.type === "battleship") {
    if (g.status === "finished")
      return (g.winner ? g.winner + " takes the sea" : "No winner") + " · " + ps.map((p: GL) => p.name + " " + (p.hits || 0) + " hits").join(" · ");
    const head = g.phase === "setup" ? "Placing fleets" : "Turn " + g.turn + (g.turn_of ? " · " + g.turn_of + " to fire" : "");
    return head + " · " + ps.map((p: GL) => p.name + " " + (p.afloat != null ? p.afloat : 5) + " afloat").join(" · ");
  }
  if (g.type === "duel") {
    if (g.status === "finished") {
      const scored = ps.slice().sort((a: GL, b: GL) => (b.wins || 0) - (a.wins || 0));
      return (g.winner ? g.winner + " wins " : "No winner · ") + scored.map((p: GL) => p.wins || 0).join("–");
    }
    return "Round " + (g.round || 1) + " · " + ps.map((p: GL) => p.name + " " + (p.wins || 0)).join(" · ");
  }
  const alive = ps.filter((p: GL) => p.alive).length;
  if (g.status === "finished") return (g.winner ? g.winner + " wins" : "No winner") + " · tick " + (g.tick || 0);
  return "Tick " + (g.tick || 0) + " · " + alive + " still riding";
}

export function GamesView({ active }: { active: boolean }) {
  const { client } = useSession();
  const store = useFeed().games;
  const version = useSyncExternalStore(store.subscribe, store.getVersion);
  const [games, setGames] = useState<GameSummary[] | null>(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    if (!active) return;
    let dead = false;
    client.listGames().then(
      (r) => {
        if (!dead) {
          setGames(r.games || []);
          setErr("");
        }
      },
      () => {
        if (!dead) setErr("Could not load the matches. Try again in a moment.");
      }
    );
    return () => {
      dead = true;
    };
  }, [active, client, version]);

  const all = games || [];
  const live = all.filter((g) => g.status === "lobby" || g.status === "running");
  const done = all.filter((g) => g.status !== "lobby" && g.status !== "running");

  const row = (g: GameSummary) => {
    const isLive = g.status === "lobby" || g.status === "running";
    const players = g.players || [];
    return (
      <button type="button" className="gm-row" key={g.id} onClick={() => store.openGame(g.id, g.type)}>
        <span className="gm-top">
          {isLive ? <span className="gm-live" /> : null}
          <span className="gm-kind">
            {(KIND[g.type] || g.type) + " #" + g.id}
          </span>
        </span>
        <span className="gm-players">
          {players.map((p, i) => (
            <span className="gm-pl" key={p.name}>
              {i > 0 ? <span className="gm-vs">{players.length === 2 ? " vs " : " · "}</span> : null}
              <span className="gm-dot" style={{ background: p.hex }} /> {p.name}
            </span>
          ))}
        </span>
        <span className="gm-state">{stateLine(g as GL)}</span>
      </button>
    );
  };

  return (
    <div className="gm-wrap">
      {games === null && !err ? <p className="gm-note">Loading the matches…</p> : null}
      {err ? <p className="gm-note">{err}</p> : null}
      {games !== null && games.length === 0 ? <p className="gm-note">No matches yet. Start one with the New game button.</p> : null}
      {live.length ? (
        <>
          <div className="gm-sec">Live now</div>
          {live.map(row)}
        </>
      ) : null}
      {done.length ? (
        <>
          <div className="gm-sec">Earlier</div>
          {done.map(row)}
        </>
      ) : null}
    </div>
  );
}
