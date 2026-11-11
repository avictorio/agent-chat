import { useEffect, useState, useSyncExternalStore } from "react";
import type { GameSummary } from "@chat/shared";
import { useFeed, useSession } from "../room/ctx";
import { recordLine, type GL } from "./render";
import { WinnerBanner } from "./WinnerBanner";

// The Games tab: the room's matches without scrolling the chat -
// live ones first, then the finished history as a standard record
// (winner banner + record line + rematch, the same presentation as
// the feed card and the arena). The New game button lives here
// now. A tap on a row opens the arena; the list refreshes whenever
// the store hears about a game.

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
  if (g.type === "battleship") {
    const head = g.phase === "setup" ? "Placing fleets" : "Turn " + g.turn + (g.turn_of ? " · " + g.turn_of + " to fire" : "");
    return head + " · " + ps.map((p: GL) => p.name + " " + (p.afloat != null ? p.afloat : 5) + " afloat").join(" · ");
  }
  if (g.type === "duel") return "Round " + (g.round || 1) + " · " + ps.map((p: GL) => p.name + " " + (p.wins || 0)).join(" · ");
  const alive = ps.filter((p: GL) => p.alive).length;
  return "Tick " + (g.tick || 0) + " · " + alive + " still riding";
}

type RecordTable = Record<string, Array<{ name: string; hex: string; w: number; l: number }>>;

export function GamesView({ active, onNewGame }: { active: boolean; onNewGame: () => void }) {
  const { client } = useSession();
  const store = useFeed().games;
  const version = useSyncExternalStore(store.subscribe, store.getVersion);
  const [games, setGames] = useState<GameSummary[] | null>(null);
  const [record, setRecord] = useState<RecordTable>({});
  const [err, setErr] = useState("");

  useEffect(() => {
    if (!active) return;
    let dead = false;
    client.listGames().then(
      (r) => {
        if (!dead) {
          setGames(r.games || []);
          setRecord(r.record || {});
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
      <div className="gm-row" key={g.id} onClick={() => store.openGame(g.id, g.type)}>
        <span className="gm-top">
          {isLive ? <span className="gm-live" /> : null}
          <span className="gm-kind">{(KIND[g.type] || g.type) + " #" + g.id}</span>
        </span>
        <span className="gm-players">
          {players.map((p, i) => (
            <span className="gm-pl" key={p.name}>
              {i > 0 ? <span className="gm-vs">{players.length === 2 ? " vs " : " · "}</span> : null}
              <span className="gm-dot" style={{ background: p.hex }} /> {p.name}
            </span>
          ))}
        </span>
        {isLive ? (
          <span className="gm-state">{stateLine(g as GL)}</span>
        ) : (
          <>
            <WinnerBanner g={g as GL} />
            <span className="gm-state">{recordLine(g as GL)}</span>
            <button
              type="button"
              className="gm-rematch"
              onClick={(e) => {
                e.stopPropagation();
                void store.rematch(g as GL);
              }}
            >
              Rematch
            </button>
          </>
        )}
      </div>
    );
  };

  return (
    <div className="gm-wrap">
      <div className="gm-head">
        <h2 className="gm-title">Games</h2>
        <button type="button" className="btn primary" onClick={onNewGame}>
          New game
        </button>
      </div>
      {games === null && !err ? <p className="gm-note">Loading the matches…</p> : null}
      {err ? <p className="gm-note">{err}</p> : null}
      {Object.keys(record).length ? (
        <>
          <div className="gm-sec">Room record</div>
          <div className="gm-rec">
            {(["battleship", "duel", "lightcycles"] as const).map((t) =>
              record[t] && record[t].length ? (
                <div className="gm-rec-kind" key={t}>
                  <div className="gm-rec-title">{KIND[t]}</div>
                  {record[t].map((r) => (
                    <div className="gm-rec-row" key={r.name}>
                      <span className="gm-dot" style={{ background: r.hex }} />
                      <span className="gm-rec-name">{r.name}</span>
                      <span className="gm-rec-wl">
                        {r.w}–{r.l}
                      </span>
                      <span className="gm-rec-pct">{Math.round((100 * r.w) / Math.max(1, r.w + r.l)) + "%"}</span>
                    </div>
                  ))}
                </div>
              ) : null
            )}
          </div>
        </>
      ) : null}
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
