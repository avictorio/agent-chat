import { useEffect, useState, useSyncExternalStore } from "react";
import type { GameSummary } from "@chat/shared";
import { useFeed, useSession } from "../room/ctx";
import { formatLeft, recordLine, type GL } from "./render";
import { WinnerBanner } from "./WinnerBanner";
import { chimeMuted, setChimeMuted } from "./chime";

// Standings with motion, from the finished list (newest first): each
// player's current streak, and their rank before the kind's most
// recent match, so the panel can show ▲/▼ movement. Same comparator
// as the server's record: wins, then fewest losses, then name.
function standingsMotion(games: GameSummary[] | null) {
  const streaks: Record<string, Record<string, { kind: "W" | "L"; n: number }>> = {};
  const prevRanks: Record<string, Record<string, number>> = {};
  if (!games) return { streaks, prevRanks };
  const kinds = ["battleship", "duel", "lightcycles"];
  kinds.forEach((t) => {
    const fin = games
      .filter((g) => g.type === t && g.status === "finished" && g.winner)
      .sort((a, b) => (b.id || 0) - (a.id || 0));
    if (!fin.length) return;
    const st: Record<string, { kind: "W" | "L"; n: number }> = {};
    fin.forEach((g) => {
      (g.players || []).forEach((p) => {
        if (st[p.name]) return;
        st[p.name] = { kind: g.winner === p.name ? "W" : "L", n: 0 };
      });
    });
    // Count consecutive same results from the newest match backwards.
    const counted: Record<string, boolean> = {};
    fin.forEach((g) => {
      (g.players || []).forEach((p) => {
        if (counted[p.name]) return;
        const s = st[p.name];
        if (!s) return;
        if ((g.winner === p.name ? "W" : "L") === s.kind) s.n++;
        else counted[p.name] = true;
      });
    });
    streaks[t] = st;
    const tally: Record<string, { name: string; w: number; l: number }> = {};
    fin.slice(1).forEach((g) => {
      (g.players || []).forEach((p) => {
        const row = tally[p.name] || (tally[p.name] = { name: p.name, w: 0, l: 0 });
        if (p.name === g.winner) row.w++;
        else row.l++;
      });
    });
    const sorted = Object.values(tally).sort((a, b) => b.w - a.w || a.l - b.l || (a.name < b.name ? -1 : 1));
    const pr: Record<string, number> = {};
    sorted.forEach((r, i) => {
      pr[r.name] = i + 1;
    });
    prevRanks[t] = pr;
  });
  return { streaks, prevRanks };
}

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

/* The Games tab as a to-do list (2026-11-13): matches waiting on YOU
   come first, soonest deadline first, each with what it wants ("Your
   throw") and the time left; then the ones waiting on others; then the
   record and the history. Who a match waits on is the list's `targets`
   (the server's collapsed awaited set), else the full state's awaiting
   lists. The countdowns tick with the arena's turn clock (games.ts). */
function waitingOn(g: GL): string[] {
  if (Array.isArray(g.targets)) return g.targets;
  // No targets (an older payload): derive them the way the server does
  // (gameTargets in src/worker.js).
  const ps: GL[] = g.players || [];
  if (g.status === "lobby") return ps.filter((p) => !p.accepted).map((p) => p.name);
  if (g.status !== "running") return [];
  if (g.type === "duel") return ps.filter((p) => !p.thrown).map((p) => p.name);
  if (g.type === "battleship") return g.phase === "setup" ? ps.filter((p) => !p.placed).map((p) => p.name) : g.turn_of ? [g.turn_of] : [];
  return ps.filter((p) => p.alive && !p.moved).map((p) => p.name);
}
const deadlineOf = (g: GL): number | null => (g.status === "lobby" ? g.lobby_deadline || null : g.deadline || null);
const durOf = (g: GL): number =>
  g.status === "lobby"
    ? 3600e3
    : 1000 * (g.type === "duel" ? g.round_seconds || 180 : g.type === "battleship" ? g.turn_seconds || 3600 : g.tick_seconds || 120);
function youLabel(g: GL): string {
  if (g.status === "lobby") return "Your invite";
  if (g.type === "duel") return "Your throw";
  if (g.type === "battleship") return g.phase === "setup" ? "Place your fleet" : "Your shot";
  return "Your move";
}

export function GamesView({ active, onNewGame }: { active: boolean; onNewGame: () => void }) {
  const { client } = useSession();
  const store = useFeed().games;
  const version = useSyncExternalStore(store.subscribe, store.getVersion);
  const [games, setGames] = useState<GameSummary[] | null>(null);
  const [record, setRecord] = useState<RecordTable>({});
  const [err, setErr] = useState("");
  const [muted, setMuted] = useState(() => chimeMuted());

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
  const me = store.meName().toLowerCase();
  const isMine = (g: GameSummary) => !!me && waitingOn(g as GL).some((n) => String(n).toLowerCase() === me);
  const byDeadline = (a: GameSummary, b: GameSummary) => (deadlineOf(a as GL) || Infinity) - (deadlineOf(b as GL) || Infinity);
  const mineLive = live.filter(isMine).sort(byDeadline);
  const otherLive = live.filter((g) => !isMine(g)).sort(byDeadline);
  const { streaks, prevRanks } = standingsMotion(games);

  const row = (g: GameSummary) => {
    const isLive = g.status === "lobby" || g.status === "running";
    const players = g.players || [];
    return (
      <div className={"gm-row kind-" + g.type} key={g.id} onClick={() => store.openGame(g.id, g.type)}>
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
          <>
            <span className="gm-state">{stateLine(g as GL)}</span>
            {(() => {
              const mine = isMine(g);
              const dl = deadlineOf(g as GL);
              const others = waitingOn(g as GL).filter((n) => String(n).toLowerCase() !== me);
              return (
                <span
                  className={"gm-due" + (mine ? " mine" : "")}
                  data-turn-deadline={dl || undefined}
                  data-turn-dur={dl ? durOf(g as GL) : undefined}
                >
                  {mine ? <span className="gm-you">{youLabel(g as GL)}</span> : others.length ? <span className="gm-wait">Waiting on {others.join(", ")}</span> : null}
                  {dl ? <span className="turn-left">{dl > Date.now() ? formatLeft(dl - Date.now()) + " left" : "time's up"}</span> : null}
                </span>
              );
            })()}
          </>
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
        <button
          type="button"
          className="btn quiet gm-bell"
          aria-pressed={muted}
          title={muted ? "Your-move chime is off — tap to turn it on" : "Your-move chime is on — tap to mute it"}
          onClick={() => {
            const m = !muted;
            setMuted(m);
            setChimeMuted(m);
          }}
        >
          {muted ? "🔕" : "🔔"}
        </button>
        <button type="button" className="btn primary" onClick={onNewGame}>
          New game
        </button>
      </div>
      {games === null && !err ? <p className="gm-note">Loading the matches…</p> : null}
      {err ? <p className="gm-note">{err}</p> : null}
      {games !== null && games.length === 0 ? <p className="gm-note">No matches yet. Start one with the New game button.</p> : null}
      {mineLive.length ? (
        <>
          <div className="gm-sec mine">Your move · {mineLive.length}</div>
          {mineLive.map(row)}
        </>
      ) : null}
      {otherLive.length ? (
        <>
          <div className="gm-sec">{mineLive.length ? "Waiting on others" : "Live now"}</div>
          {otherLive.map(row)}
        </>
      ) : null}
      {Object.keys(record).length ? (
        <>
          <div className="gm-sec">Room record</div>
          <div className="gm-rec">
            {(["battleship", "duel", "lightcycles"] as const).map((t) =>
              record[t] && record[t].length ? (
                <div className="gm-rec-kind" key={t}>
                  <div className="gm-rec-title">{KIND[t]}</div>
                  {record[t].map((r, ri) => {
                    const st = (streaks[t] || {})[r.name];
                    const prev = (prevRanks[t] || {})[r.name];
                    const delta = prev ? prev - (ri + 1) : 0;
                    return (
                      <div className="gm-rec-row" key={r.name}>
                        <span className="gm-dot" style={{ background: r.hex }} />
                        <span className="gm-rec-name">{r.name}</span>
                        <span className="gm-rec-wl">
                          {r.w}–{r.l}
                        </span>
                        <span className="gm-rec-pct">{Math.round((100 * r.w) / Math.max(1, r.w + r.l)) + "%"}</span>
                        {st && st.n >= 2 ? (
                          <span className={"gm-rec-streak" + (st.kind === "W" ? " hot" : "")}>
                            {st.kind === "W" ? "🔥 " : ""}
                            {st.kind}
                            {st.n}
                          </span>
                        ) : null}
                        {delta !== 0 ? (
                          <span className={"gm-rec-move " + (delta > 0 ? "up" : "down")}>
                            {delta > 0 ? "▲" + delta : "▼" + -delta}
                          </span>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              ) : null
            )}
          </div>
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
