import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent } from "react";
import type { GameSummary } from "@chat/shared";
import { useFeed, useSession } from "../room/ctx";
import { finalScore, formatLeft, type GL } from "./render";
import { chimeMuted, setChimeMuted } from "./chime";
import { pressable } from "../lib";
import { GAMES, GameFacts, GameIcon, HowToPlay, accentStyle } from "./catalog";

// Standings with motion, from the finished list (newest first): each
// player's current streak, and their rank before the kind's most
// recent match, so the panel can show ▲/▼ movement. Same comparator
// as the server's record: wins, then fewest losses, then name.
function standingsMotion(games: GameSummary[] | null) {
  const streaks: Record<string, Record<string, { kind: "W" | "L"; n: number }>> = {};
  const prevRanks: Record<string, Record<string, number>> = {};
  if (!games) return { streaks, prevRanks };
  const kinds = GAMES.map((d) => d.id);
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
// filterable by game) and Standings (the room record). Start a match
// lives in the Live tab; the your-move chime toggle sits in the header. A tap on a row opens
// the arena; the list refreshes whenever the store hears about a game.

// game names come from the catalog (./catalog)
const KIND: Record<string, string> = Object.fromEntries(GAMES.map((d) => [d.id, d.name]));

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
  if (g.type === "duel" || g.type === "frontlines") return "Round " + (g.round || 1) + " · " + ps.map((p: GL) => p.name + " " + (p.wins || 0)).join(" · ");
  if (g.type === "fourinarow") return "Turn " + (g.turn || 1) + (g.turn_of ? " · " + g.turn_of + " to move" : "");
  if (g.type === "werewolf") return (g.phase === "night" ? "Night " + (g.night || 1) + " · the village sleeps" : "Day " + (g.day || 1) + " · voting") + " · " + ps.filter((p: GL) => p.alive).length + " alive";
  if (g.type === "twenty") return "Round " + (g.round || 1) + " of " + (g.rounds_total || "?") + (g.answerer ? " · " + g.answerer + (g.phase === "secret" ? " choosing" : " answering · " + (g.asked || 0) + "/20") : "");
  if (g.type === "corpse") return g.phase === "vote" ? "Revealed · " + (g.segments || 0) + " segments · voting" : "Turn " + (g.turn || 1) + " of " + (g.turns_total || "?") + (g.turn_of ? " · " + g.turn_of + " writing" : "");
  if (g.type === "twotruths") return "Round " + (g.round || 1) + " of " + (g.rounds_total || "?") + (g.teller ? " · " + g.teller + (g.phase === "write" ? " writing" : " told") : "") + " · " + ps.slice().sort((a: GL, b: GL) => (b.score || 0) - (a.score || 0)).map((p: GL) => p.name + " " + (p.score || 0)).join(" · ");
  if (g.type === "liarsdice") return "Round " + (g.round || 1) + (g.turn_of ? " · " + g.turn_of + " to bid" : "") + " · " + ps.filter((p: GL) => !p.out).map((p: GL) => p.name + " " + (p.dice || 0)).join(" · ");
  if (g.type === "auction") return "Lot " + (g.round || 1) + " of " + (g.lots_total || "?") + " · " + ps.slice().sort((a: GL, b: GL) => (b.won || 0) - (a.won || 0)).map((p: GL) => p.name + " " + (p.won || 0)).join(" · ");
  if (g.type === "trust") return "Round " + (g.round || 1) + " · " + ps.slice().sort((a: GL, b: GL) => (b.score || 0) - (a.score || 0)).map((p: GL) => p.name + " " + (p.score || 0)).join(" · ");
  if (g.type === "coderace") {
    const cracked = ps.filter((p: GL) => p.solved).map((p: GL) => p.name);
    return "Round " + (g.round || 1) + " of " + (g.max_rounds || "?") + " · " + (cracked.length ? cracked.join(", ") + " cracked it" : "nobody has cracked it");
  }
  const alive = ps.filter((p: GL) => p.alive).length;
  return "Tick " + (g.tick || 0) + " · " + alive + " still riding";
}

type RecordTable = Record<string, Array<{ name: string; hex: string; w: number; l: number; p2?: number; p3?: number }>>;
type LadderTable = Record<string, Array<{ name: string; hex: string | null; rating: number; w: number; l: number; d: number; last: number }>>;
type StandRow = { name: string; hex: string; w: number; l: number; d: number; p2?: number; p3?: number; rating: number | null; last: number };

/* One game's standings (2026-11-19): with a ladder, rated players first by
   Elo rating (their all-time W-L beside it, from the record), then anyone
   only seen in free-for-alls, unrated; without one, the record as is. */
function standRows(rec: RecordTable[string] | undefined, lad: LadderTable[string] | undefined): StandRow[] {
  const recBy: Record<string, RecordTable[string][number]> = {};
  (rec || []).forEach((r) => (recBy[r.name] = r));
  const out: StandRow[] = [];
  const seen = new Set<string>();
  (lad || []).forEach((x) => {
    const r = recBy[x.name];
    seen.add(x.name);
    out.push({ name: x.name, hex: (r && r.hex) || x.hex || "#94a3b8", w: r ? r.w : x.w, l: r ? r.l : x.l, d: x.d, p2: r && r.p2, p3: r && r.p3, rating: x.rating, last: x.last });
  });
  (rec || []).forEach((r) => {
    if (!seen.has(r.name)) out.push({ name: r.name, hex: r.hex, w: r.w, l: r.l, d: 0, p2: r.p2, p3: r.p3, rating: null, last: 0 });
  });
  return out;
}

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
  if (g.type === "frontlines") return ps.filter((p) => !p.committed).map((p) => p.name);
  if (g.type === "coderace") return ps.filter((p) => !p.committed && !p.solved && !p.out).map((p) => p.name);
  if (g.type === "fourinarow" || g.type === "liarsdice") return g.turn_of ? [g.turn_of] : [];
  if (g.type === "werewolf") return g.phase === "day" ? ps.filter((p) => p.alive && !p.voted).map((p) => p.name) : [];
  if (g.type === "twenty") return g.phase === "ask" ? ps.filter((p) => p.name !== g.answerer).map((p) => p.name) : g.answerer ? [g.answerer] : [];
  if (g.type === "corpse") return g.phase === "write" ? (g.turn_of ? [g.turn_of] : []) : ps.filter((p) => !p.committed).map((p) => p.name);
  if (g.type === "twotruths") return g.phase === "write" ? (g.teller ? [g.teller] : []) : ps.filter((p) => p.name !== g.teller && !p.committed).map((p) => p.name);
  if (g.type === "trust") return ps.filter((p) => !p.committed && !p.out).map((p) => p.name);
  if (g.type === "auction") return ps.filter((p) => !p.committed && (p.budget || 0) > 0).map((p) => p.name);
  if (g.type === "battleship") return g.phase === "setup" ? ps.filter((p) => !p.placed).map((p) => p.name) : g.turn_of ? [g.turn_of] : [];
  return ps.filter((p) => p.alive && !p.moved).map((p) => p.name);
}
const deadlineOf = (g: GL): number | null => (g.status === "lobby" ? g.lobby_deadline || null : g.deadline || null);
const durOf = (g: GL): number =>
  g.status === "lobby"
    ? 3600e3
    : 1000 * (g.type === "duel" || g.type === "frontlines" || g.type === "trust" || g.type === "auction" ? g.round_seconds || 180 : g.type === "coderace" || g.type === "twotruths" || g.type === "twenty" ? g.round_seconds || 3600 : g.type === "corpse" ? g.turn_seconds || 86400 : g.type === "werewolf" ? g.phase_seconds || 86400 : g.type === "battleship" || g.type === "fourinarow" || g.type === "liarsdice" ? g.turn_seconds || 3600 : g.tick_seconds || 120);
function youLabel(g: GL): string {
  if (g.status === "lobby") return "Your invite";
  if (g.type === "duel") return "Your throw";
  if (g.type === "frontlines") return "Your split";
  if (g.type === "coderace") return "Your guess";
  if (g.type === "fourinarow") return "Your move";
  if (g.type === "trust") return "Your choices";
  if (g.type === "auction" || g.type === "liarsdice") return "Your bid";
  if (g.type === "twotruths") return g.phase === "write" ? "Your story" : "Your vote";
  if (g.type === "corpse") return g.phase === "write" ? "Your segment" : "Your favourite";
  if (g.type === "werewolf") return g.phase === "night" ? "Your night move" : "Your vote";
  if (g.type === "twenty") return g.phase === "secret" ? "Your secret" : g.phase === "answer" ? "Your answer" : "Your question";
  if (g.type === "battleship") return g.phase === "setup" ? "Place your fleet" : "Your shot";
  return "Your move";
}

type Tab = "live" | "history" | "standings" | "guide";
const TABS: Tab[] = ["live", "history", "standings", "guide"];
const TAB_LABEL: Record<Tab, string> = { live: "Live", history: "History", standings: "Standings", guide: "Guide" };
const TAB_KEY = "ac-games-tab";
const PAGE = 20;

function savedTab(): Tab {
  try {
    const v = localStorage.getItem(TAB_KEY);
    return v === "history" || v === "standings" || v === "guide" ? v : "live";
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
  if (g.type === "frontlines" || g.type === "coderace" || g.type === "trust") return ((g.rounds && g.rounds.length) || Math.max(0, (g.round || 1) - 1)) + " rounds";
  if (g.type === "fourinarow") return ((g.last_move && g.last_move.n) || 0) + " moves";
  if (g.type === "auction") return ((g.rounds && g.rounds.length) || g.lots_total || 0) + " lots";
  if (g.type === "corpse") return (g.segments || 0) + " segments";
  if (g.type === "twenty") return ((g.rounds && g.rounds.length) || g.rounds_total || 0) + " rounds";
  if (g.type === "werewolf") return (g.day || g.night || 0) + " days";
  if (g.type === "liarsdice" || g.type === "twotruths") return ((g.rounds && g.rounds.length) || g.round || 0) + " rounds";
  return (g.tick || 0) + " ticks";
}

/* The your-move chime toggle (2026-11-19). It was a bell, which read
   as the app's notifications; a speaker says sound. What it does is
   one hover or long-press away: a tooltip on hover (desktop), keyboard
   focus, or a hold on touch (the hold does not toggle), and a tap
   confirms the new state for a moment ("Chime off"). */
const SPEAKER = "M11 5 6 9H3v6h3l5 4V5z";
const WAVES = ["M15.5 8.5a5 5 0 0 1 0 7", "M18.5 5.5a9 9 0 0 1 0 13"];
const MUTED = ["M16 9.5l5 5", "M21 9.5l-5 5"];

function ChimeToggle() {
  const [muted, setMuted] = useState(() => chimeMuted());
  const [tip, setTip] = useState<"" | "hint" | "on" | "off">("");
  const hoverT = useRef(0);
  const holdT = useRef(0);
  const hideT = useRef(0);
  const held = useRef(false);
  useEffect(
    () => () => {
      window.clearTimeout(hoverT.current);
      window.clearTimeout(holdT.current);
      window.clearTimeout(hideT.current);
    },
    []
  );
  const show = (k: "hint" | "on" | "off", ms?: number) => {
    window.clearTimeout(hideT.current);
    setTip(k);
    if (ms) hideT.current = window.setTimeout(() => setTip(""), ms);
  };
  const hide = () => {
    window.clearTimeout(hoverT.current);
    window.clearTimeout(holdT.current);
    setTip("");
  };
  const text =
    tip === "on"
      ? "Chime on"
      : tip === "off"
        ? "Chime off"
        : muted
          ? "Your-move chime is off. Tap to hear a short sound when a match is waiting on you."
          : "Your-move chime: a short sound plays when a match is waiting on you. Tap to mute it.";
  return (
    <span className="gm-chime">
      <button
        type="button"
        className={"btn quiet gm-chime-btn" + (muted ? " off" : "")}
        aria-pressed={!muted}
        aria-label="Your-move chime"
        aria-describedby="gm-chime-tip"
        onMouseEnter={() => {
          hoverT.current = window.setTimeout(() => show("hint"), 350);
        }}
        onMouseLeave={hide}
        onFocus={(e) => {
          if (e.currentTarget.matches(":focus-visible")) show("hint");
        }}
        onBlur={hide}
        onPointerDown={(e) => {
          if (e.pointerType === "mouse") return;
          held.current = false;
          holdT.current = window.setTimeout(() => {
            held.current = true;
            show("hint", 4000);
          }, 450);
        }}
        onPointerUp={() => window.clearTimeout(holdT.current)}
        onPointerCancel={() => window.clearTimeout(holdT.current)}
        onContextMenu={(e) => e.preventDefault()}
        onClick={() => {
          // a hold shows what the button does; only a tap toggles
          if (held.current) {
            held.current = false;
            return;
          }
          const m = !muted;
          setMuted(m);
          setChimeMuted(m);
          show(m ? "off" : "on", 1600);
        }}
      >
        <svg className="i" viewBox="0 0 24 24" aria-hidden="true">
          <path d={SPEAKER} />
          {(muted ? MUTED : WAVES).map((d) => (
            <path key={d} d={d} />
          ))}
        </svg>
      </button>
      <span id="gm-chime-tip" role="tooltip" className={"gm-tip" + (tip ? " on" : "")}>
        {text}
      </span>
    </span>
  );
}

export function GamesView({ active, onNewGame }: { active: boolean; onNewGame: (game?: string) => void }) {
  const { client } = useSession();
  const store = useFeed().games;
  const version = useSyncExternalStore(store.subscribe, store.getVersion);
  const [games, setGames] = useState<GameSummary[] | null>(null);
  const [record, setRecord] = useState<RecordTable>({});
  const [ladder, setLadder] = useState<LadderTable>({});
  const [err, setErr] = useState("");
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
  const tabRefs = useRef<Record<Tab, HTMLButtonElement | null>>({ live: null, history: null, standings: null, guide: null });

  // /games scans up to 500 matches on the server: the first open loads at
  // once, later store changes (a burst of frames, a poll) coalesce into
  // one reload a beat later.
  const listedRef = useRef(false);
  useEffect(() => {
    if (!active) return;
    let dead = false;
    const t = window.setTimeout(
      () => {
        client.listGames().then(
          (r) => {
            if (!dead) {
              listedRef.current = true;
              setGames(r.games || []);
              setRecord(r.record || {});
              setLadder(r.ladder || {});
              setErr("");
            }
          },
          () => {
            if (!dead) setErr("Could not load the matches. Try again in a moment.");
          }
        );
      },
      listedRef.current ? 1200 : 0
    );
    return () => {
      dead = true;
      window.clearTimeout(t);
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
  const kindsDone = GAMES.map((d) => d.id).filter((t) => done.some((g) => g.type === t));
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
      <div className={"gm-row kind-" + g.type} key={g.id} {...pressable(() => store.openGame(g.id, g.type), "Open " + (KIND[g.type] || g.type) + " #" + g.id)}>
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

  const standings = Object.keys(record).length || Object.keys(ladder).length ? (
    <div className="gm-rec">
      {GAMES.map((d) => d.id).map((t) => {
        const rows = standRows(record[t], ladder[t]);
        if (!rows.length) return null;
        const rated = !!(ladder[t] && ladder[t].length);
        return (
          <div className="gm-rec-kind" key={t}>
            <div className="gm-rec-title">
              {KIND[t]}
              {rated ? <span className="gm-rec-sub">Elo ladder · 2-player matches</span> : null}
            </div>
            {rows.map((r, ri) => {
              const st = (streaks[t] || {})[r.name];
              const prev = (prevRanks[t] || {})[r.name];
              const delta = !rated && prev ? prev - (ri + 1) : 0;
              return (
                <div className={"gm-rec-row" + (rated && r.rating == null ? " unrated" : "")} key={r.name}>
                  <span className="gm-dot" style={{ background: r.hex }} />
                  <span className="gm-rec-name">{r.name}</span>
                  {rated ? (
                    <span className="gm-rec-elo" title={r.rating == null ? "Free-for-alls only - no ladder rating yet" : "Elo rating"}>
                      {r.rating == null ? "–" : r.rating}
                      {r.rating != null && r.last ? <span className={"gm-rec-last " + (r.last > 0 ? "up" : "down")}>{(r.last > 0 ? "+" : "−") + Math.abs(r.last)}</span> : null}
                    </span>
                  ) : null}
                  <span className="gm-rec-wl">
                    {r.w}–{r.l}
                    {r.d ? "–" + r.d : ""}
                  </span>
                  <span className="gm-rec-pct">{Math.round((100 * r.w) / Math.max(1, r.w + r.l + r.d)) + "%"}</span>
                  {r.p2 || r.p3 ? (
                    <span className="gm-rec-places" title="2nd and 3rd places">
                      {(r.p2 ? "2nd ×" + r.p2 : "") + (r.p2 && r.p3 ? " · " : "") + (r.p3 ? "3rd ×" + r.p3 : "")}
                    </span>
                  ) : null}
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
        );
      })}
    </div>
  ) : null;

  return (
    <div className="gm-wrap">
      <div className="gm-head">
        <h2 className="gm-title">Games</h2>
        <ChimeToggle />
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
      {tab === "guide" ? (
        <div className="gm-panel gm-panel-guide" role="tabpanel" id="gm-panel-guide" aria-labelledby="gm-tab-guide">
          <p className="gm-note gm-guide-intro">Every game you can play here: what it is, how it plays, and how well it suits agents. Open one for the rules.</p>
          {GAMES.map((d) => (
            <details className="gm-guide" key={d.id} data-game={d.id} style={accentStyle(d)}>
              <summary>
                <span className="ng-game-ic">
                  <GameIcon def={d} />
                </span>
                <span className="ng-game-body">
                  <span className="ng-game-name">{d.name}</span>
                  <span className="ng-game-pitch">{d.pitch}</span>
                  <GameFacts def={d} />
                </span>
              </summary>
              <div className="gm-guide-body">
                <HowToPlay def={d} />
                <button type="button" className="btn primary sm" onClick={() => onNewGame(d.id)}>
                  Start {d.name}
                </button>
              </div>
            </details>
          ))}
        </div>
      ) : null}
      {tab !== "guide" && games === null && !err ? <p className="gm-note">Loading the matches…</p> : null}
      {tab !== "guide" && err ? <p className="gm-note">{err}</p> : null}
      {tab !== "guide" && games !== null ? (
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
                <div className="gm-start">
                  <button type="button" className="btn primary gm-start-btn" onClick={() => onNewGame()}>
                    Start a match
                  </button>
                </div>
              </>
            ) : (
              <div className="gm-empty">
                <p>Nothing live right now.</p>
                <button type="button" className="btn primary gm-start-btn" onClick={() => onNewGame()}>
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
