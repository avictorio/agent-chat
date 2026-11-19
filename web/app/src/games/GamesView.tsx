import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent } from "react";
import type { GameSummary } from "@chat/shared";
import { useFeed, useSession } from "../room/ctx";
import { finalScore, formatLeft, type GL } from "./render";
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

// The Games tab (2026-11-19): three tabs - Live (opens by default, and
// whenever a match waits on you; matches waiting on YOU first), History
// (every match that ended, as compact rows filed by the day it ended,
// filterable by game) and Standings (the room record). The New game
// button and the chime toggle sit above the tabs. A tap on a row opens
// the arena; the list refreshes whenever the store hears about a game.

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

type Tab = "live" | "history" | "standings";
const TABS: Tab[] = ["live", "history", "standings"];
const TAB_LABEL: Record<Tab, string> = { live: "Live", history: "History", standings: "Standings" };
const TAB_KEY = "ac-games-tab";
const PAGE = 20;

function savedTab(): Tab {
  try {
    const v = localStorage.getItem(TAB_KEY);
    return v === "history" || v === "standings" ? v : "live";
  } catch {
    return "live";
  }
}

/* When a past match ended (older matches: when it began). */
const endedAt = (g: GL): number => Number(g.ended || g.created || 0);

/* The history's day groups: Today, Yesterday, This week, then months. */
function dayGroup(t: number, now: Date): string {
  if (!t) return "Earlier";
  const d = new Date(t);
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(now) - day(d)) / 86400e3);
  if (diff <= 0) return "Today";
  if (diff === 1) return "Yesterday";
  if (diff < 7) return "This week";
  return d.toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

/* A row's time: the clock today and yesterday, the weekday this week,
   the date before that. */
function whenLabel(t: number, group: string): string {
  if (!t) return "";
  const d = new Date(t);
  if (group === "Today" || group === "Yesterday") return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (group === "This week") return d.toLocaleDateString(undefined, { weekday: "short" });
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/* How long a finished match ran, in its own unit. */
function lengthLine(g: GL): string {
  if (g.type === "battleship") return (g.turn || 0) + " turns";
  if (g.type === "duel") return (g.round || 0) + " rounds";
  return (g.tick || 0) + " ticks";
}

export function GamesView({ active, onNewGame }: { active: boolean; onNewGame: () => void }) {
  const { client } = useSession();
  const store = useFeed().games;
  const version = useSyncExternalStore(store.subscribe, store.getVersion);
  const [games, setGames] = useState<GameSummary[] | null>(null);
  const [record, setRecord] = useState<RecordTable>({});
  const [err, setErr] = useState("");
  const [muted, setMuted] = useState(() => chimeMuted());
  const [tab, setTab] = useState<Tab>(() => savedTab());
  // an explicit pick holds for the browser session (a trip to an arena
  // and back keeps it); a new visit opens Live if something waits on you
  const picked = useRef(((): boolean => {
    try {
      return sessionStorage.getItem(TAB_KEY) === "1";
    } catch {
      return false;
    }
  })());
  const [kind, setKind] = useState<string>("all");
  const [shown, setShown] = useState(PAGE);
  const tabRefs = useRef<Record<Tab, HTMLButtonElement | null>>({ live: null, history: null, standings: null });

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

  /* Something waiting on you always opens Live (unless you picked a tab
     here): what needs you is never behind a tap. */
  useEffect(() => {
    if (!picked.current && mineLive.length && tab !== "live") setTab("live");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mineLive.length]);
  const pick = (t: Tab, focus?: boolean) => {
    picked.current = true;
    setTab(t);
    try {
      localStorage.setItem(TAB_KEY, t);
      sessionStorage.setItem(TAB_KEY, "1");
    } catch {
      // storage unavailable: the tab still switches for this visit
    }
    if (focus) tabRefs.current[t]?.focus();
  };
  const onTabKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    const i = TABS.indexOf(tab);
    const next = e.key === "ArrowRight" ? TABS[(i + 1) % TABS.length] : e.key === "ArrowLeft" ? TABS[(i + TABS.length - 1) % TABS.length] : e.key === "Home" ? TABS[0] : e.key === "End" ? TABS[TABS.length - 1] : null;
    if (next) {
      e.preventDefault();
      pick(next, true);
    }
  };

  // history: newest ending first, filtered by game
  const kindsDone = (["battleship", "duel", "lightcycles"] as const).filter((t) => done.some((g) => g.type === t));
  const filtered = useMemo(
    () => done.filter((g) => kind === "all" || g.type === kind).sort((a, b) => endedAt(b as GL) - endedAt(a as GL) || (b.id || 0) - (a.id || 0)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [games, kind]
  );
  useEffect(() => setShown(PAGE), [kind]);

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
        <span className="gm-state">{stateLine(g as GL)}</span>
        {(() => {
          const mine = isMine(g);
          const dl = deadlineOf(g as GL);
          const others = waitingOn(g as GL).filter((n) => String(n).toLowerCase() !== me);
          return (
            <span className={"gm-due" + (mine ? " mine" : "")} data-turn-deadline={dl || undefined} data-turn-dur={dl ? durOf(g as GL) : undefined}>
              {mine ? <span className="gm-you">{youLabel(g as GL)}</span> : others.length ? <span className="gm-wait">Waiting on {others.join(", ")}</span> : null}
              {dl ? <span className="turn-left">{dl > Date.now() ? formatLeft(dl - Date.now()) + " left" : "time's up"}</span> : null}
            </span>
          );
        })()}
      </div>
    );
  };

  /* A past match in two short lines: who won, the game, the score; then
     the rest of the field, how long it ran and when. Your own result is
     marked. The row opens the arena; Rematch sits beside it. */
  const hrow = (g: GameSummary, group: string) => {
    const gl = g as GL;
    const players = g.players || [];
    const w = players.find((p) => p.name === g.winner);
    const others = players.filter((p) => p.name !== g.winner).map((p) => p.name);
    const mineP = players.find((p) => String(p.name).toLowerCase() === me);
    const off = g.status === "cancelled";
    const score = off ? "" : finalScore(gl);
    const kindName = (KIND[g.type] || g.type) + " #" + g.id;
    const result = off ? "Called off" : w ? w.name + " won" : "No winner";
    const label = kindName + ": " + result + (score ? " " + score : "") + (others.length && !off ? ", against " + others.join(", ") : "") + ". Open the arena.";
    return (
      <div className={"gm-hrow kind-" + g.type} key={g.id}>
        <button type="button" className="gm-hrow-open" aria-label={label} onClick={() => store.openGame(g.id, g.type)}>
          <span className="gm-hrow-l1">
            {off ? (
              <span className="gm-hrow-who off">Called off</span>
            ) : w ? (
              <span className="gm-hrow-who">
                <span aria-hidden="true">🏆</span> <span className="gm-dot" style={{ background: w.hex }} /> {w.name}
              </span>
            ) : (
              <span className="gm-hrow-who off">No winner</span>
            )}
            <span className="gm-hrow-game">{kindName}</span>
            {score ? <span className="gm-hrow-score">{score}</span> : null}
          </span>
          <span className="gm-hrow-l2">
            {mineP && !off && w ? <span className={"gm-hrow-me " + (w === mineP ? "won" : "lost")}>{w === mineP ? "Won" : "Lost"}</span> : null}
            <span className="gm-hrow-meta">
              {off
                ? gl.declined_by
                  ? gl.declined_by + " declined"
                  : players.map((p) => p.name).join(" · ")
                : (others.length ? "vs " + others.join(", ") + " · " : "") + lengthLine(gl)}
            </span>
            <span className="gm-hrow-when">{whenLabel(endedAt(gl), group)}</span>
          </span>
        </button>
        <button
          type="button"
          className="gm-rematch gm-hrow-rematch"
          aria-label={"Rematch " + kindName}
          onClick={() => {
            void store.rematch(gl);
          }}
        >
          Rematch
        </button>
      </div>
    );
  };

  const now = new Date();
  const page = filtered.slice(0, shown);
  const groups: { name: string; items: GameSummary[] }[] = [];
  page.forEach((g) => {
    const name = dayGroup(endedAt(g as GL), now);
    const last = groups[groups.length - 1];
    if (last && last.name === name) last.items.push(g);
    else groups.push({ name, items: [g] });
  });

  const standings = Object.keys(record).length ? (
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
                  {delta !== 0 ? <span className={"gm-rec-move " + (delta > 0 ? "up" : "down")}>{delta > 0 ? "▲" + delta : "▼" + -delta}</span> : null}
                </div>
              );
            })}
          </div>
        ) : null
      )}
    </div>
  ) : null;

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
      <div className="gm-tabbar">
      <div className="gm-tabs" role="tablist" aria-label="Games">
        {TABS.map((t) => (
          <button
            key={t}
            ref={(el) => {
              tabRefs.current[t] = el;
            }}
            type="button"
            role="tab"
            id={"gm-tab-" + t}
            aria-selected={tab === t}
            aria-controls={"gm-panel-" + t}
            tabIndex={tab === t ? 0 : -1}
            className={"gm-tab" + (tab === t ? " on" : "")}
            onClick={() => pick(t)}
            onKeyDown={onTabKey}
          >
            {TAB_LABEL[t]}
            {t === "live" && mineLive.length ? (
              <span className="gm-tab-badge" aria-label={mineLive.length + " waiting on you"}>
                {mineLive.length}
              </span>
            ) : t === "live" && live.length ? (
              <span className="gm-tab-n">{live.length}</span>
            ) : t === "history" && done.length ? (
              <span className="gm-tab-n">{done.length}</span>
            ) : null}
          </button>
        ))}
      </div>
      </div>
      {games === null && !err ? <p className="gm-note">Loading the matches…</p> : null}
      {err ? <p className="gm-note">{err}</p> : null}
      {games !== null ? (
        <div className={"gm-panel gm-panel-" + tab} role="tabpanel" id={"gm-panel-" + tab} aria-labelledby={"gm-tab-" + tab}>
          {tab === "live" ? (
            live.length ? (
              <>
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
              </>
            ) : (
              <div className="gm-empty">
                <p>Nothing live right now.</p>
                <button type="button" className="btn primary" onClick={onNewGame}>
                  Start a match
                </button>
                {done.length ? (
                  <button type="button" className="btn quiet" onClick={() => pick("history")}>
                    Browse history
                  </button>
                ) : null}
              </div>
            )
          ) : tab === "history" ? (
            done.length ? (
              <>
                {kindsDone.length > 1 ? (
                  <div className="gm-chips" role="group" aria-label="Show matches of">
                    {(["all", ...kindsDone] as string[]).map((k) => (
                      <button key={k} type="button" className={"gm-chip" + (kind === k ? " on" : "")} aria-pressed={kind === k} onClick={() => setKind(k)}>
                        {k === "all" ? "All" : KIND[k]}
                        <span className="gm-chip-n">{k === "all" ? done.length : done.filter((g) => g.type === k).length}</span>
                      </button>
                    ))}
                  </div>
                ) : null}
                {groups.map((gr) => (
                  <section className="gm-day" key={gr.name} aria-label={gr.name}>
                    <div className="gm-sec">{gr.name}</div>
                    <div className="gm-hlist">{gr.items.map((g) => hrow(g, gr.name))}</div>
                  </section>
                ))}
                {filtered.length > shown ? (
                  <button type="button" className="btn quiet gm-more" onClick={() => setShown((n) => n + PAGE)}>
                    Show more · {filtered.length - shown} older
                  </button>
                ) : null}
              </>
            ) : (
              <p className="gm-note">No finished matches yet. They appear here, newest first, once a match ends.</p>
            )
          ) : standings ? (
            standings
          ) : (
            <p className="gm-note">The room record appears after the first finished match.</p>
          )}
        </div>
      ) : null}
    </div>
  );
}
