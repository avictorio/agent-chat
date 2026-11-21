import { useLayoutEffect, useRef } from "react";
import type { DuelPlayer, DuelState } from "@chat/contract";
import { setClockBar } from "../shared/render";
import { duelScoreLine, duelStreak, roundVerdict, THROW_BEATS, THROW_EMOJI } from "./duel";

/* The Duel's panels (2026-11-21, React; the scoreboard came from
   shared/render.ts): the scoreboard (the chat card, and in the arena the
   lobby's and the no-WebGL view's), the tendency lines, the last round's
   verdict and the throw pad. The view (view.tsx) mounts the arena's with
   ctx.panel. */

/* The round clock under the card's scoreboard: it starts where the clock
   stands, and the 1 s ticker in games.ts (setClockBar on every
   [data-duel-deadline]) keeps it draining. */
function DuelClockBar({ g }: { g: DuelState }) {
  const bar = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (bar.current) setClockBar(bar.current);
  });
  return (
    <div className="duel-clockwrap">
      <div ref={bar} className="duel-clockbar" data-duel-deadline={String(g.deadline)} data-duel-dur={String((g.round_seconds || 600) * 1000)}>
        <div></div>
      </div>
    </div>
  );
}

/* The scoreboard: a row per player (win pips, the score, a streak's
   flame). The card adds the state line, the last round's face-off, your
   throw's pill and the round clock; slim (the arena) is just the rows,
   since the arena composes its own status line, verdict and clock around
   it, so nothing shows twice. */
function DuelBoard({ g, slim }: { g: DuelState; slim?: boolean }) {
  const sc = g.score || {};
  const players: DuelPlayer[] = g.players || [];
  const rounds = g.rounds || [];
  const last = rounds.length ? rounds[rounds.length - 1]! : null;
  let state = "";
  if (!slim && g.status === "running") state = players.map((p: DuelPlayer) => p.name + (p.thrown ? " locked ✓" : " thinking…")).join(" · ");
  else if (!slim && g.status === "lobby") state = players.map((p: DuelPlayer) => p.name + (p.accepted ? " in ✓" : " invited…")).join(" · ");
  return (
    <div className="duel-board">
      {players.map((p: DuelPlayer) => {
        let pips = "";
        for (let i = 0; i < (g.target || 0); i++) pips += i < (p.wins || 0) ? "●" : "○";
        const streak = duelStreak(g, p.name);
        return (
          <div key={p.name} className="duel-row">
            <span className="lc-dot" style={{ background: p.hex }}></span>
            <span className="duel-name">{p.name}</span>
            <span className="duel-pips" style={{ color: p.hex }}>
              {pips}
            </span>
            <span className="duel-score" style={{ color: p.hex }}>
              {String(sc[p.name] != null ? sc[p.name] : p.wins || 0)}
            </span>
            {streak >= 2 ? <span className="duel-streak">{"🔥" + streak}</span> : null}
          </div>
        );
      })}
      {state ? <div className="duel-stateline">{state}</div> : null}
      {last && !slim ? (
        // keyed by round: the ribbon comes in with each new verdict
        <div key={last.n} className="duel-faceoff-line ribbon-in">
          <span className="fo-icons">
            {players
              .map((p: DuelPlayer) => {
                const t = (last.throws || {})[p.name];
                return t ? THROW_EMOJI[t] || "" : "—";
              })
              .join(" ")}
          </span>
          <span>{roundVerdict(last, players).text}</span>
        </div>
      ) : null}
      {!slim && g.you && g.you.playing && g.status === "running" ? (
        g.you.queued ? <span className="duel-pill locked">{"✓ LOCKED · " + g.you.queued}</span> : <span className="duel-pill your-throw">YOUR THROW</span>
      ) : null}
      {!slim && g.status === "running" && g.deadline ? <DuelClockBar g={g} /> : null}
    </div>
  );
}

/* The arena's scoreboard (the lobby's, and the no-WebGL view's: in 3D
   the scene's name plates carry the score). */
export function DuelScoreboard({ g, under }: { g: DuelState; under?: boolean }) {
  return (
    <div className={"lc-board-big" + (under ? " duel-board-under" : "")}>
      <DuelBoard g={g} slim />
    </div>
  );
}

/* Each player's throw mix and clearest habit (duelTendencies). */
export function DuelTendencies({ tends }: { tends: { name: string; hex: string; line: string }[] }) {
  return (
    <div className="duel-tend">
      {tends.map((t) => (
        <div key={t.name} className="duel-tend-row">
          <span className="duel-tend-name" style={{ color: t.hex }}>
            {t.name}
          </span>
          <span>{t.line}</span>
        </div>
      ))}
    </div>
  );
}

/* The last round's verdict: both throws (flipping in when the round has
   just resolved, reveal) and what happened, with the score. The view
   keys it by round, so a level round's banner keeps no empty style from
   a won one's border. */
export function DuelVerdict({ g, reveal }: { g: DuelState; reveal: boolean }) {
  const players: DuelPlayer[] = g.players || [];
  const rounds = g.rounds || [];
  const last = rounds[rounds.length - 1]!;
  const v = roundVerdict(last, players);
  const wp = !v.tie && last.winner ? players.filter((p: DuelPlayer) => p.name === last.winner)[0] : undefined;
  return (
    <div className={"duel-verdict" + (v.tie ? " clash" : "") + (reveal ? " reveal-in" : "")} style={wp ? { borderColor: wp.hex } : undefined}>
      <span className={"v-icons" + (reveal ? " flip" : "")}>
        {players.map((p: DuelPlayer) => {
          const t = (last.throws || {})[p.name];
          const cls = v.tie ? "tie" : last.winner === p.name ? "winner" : "loser";
          return (
            <span key={p.name} className={"v-icon " + cls}>
              {t ? THROW_EMOJI[t] || "" : "—"}
            </span>
          );
        })}
      </span>
      <span>{v.text + " · " + duelScoreLine(g)}</span>
    </div>
  );
}

/* The throw pad: rock, paper, scissors, each with what it beats; the
   throw you sent wears LOCKED (tap another to change it). */
export function DuelPad({ g, onThrow }: { g: DuelState; onThrow: (t: string) => void }) {
  const queued = (g.you && g.you.queued) || null;
  return (
    <div className={"duel-pad2" + (!queued ? " your-move" : "")}>
      {["rock", "paper", "scissors"].map((t) => (
        <button key={t} type="button" className={"duel-tile" + (queued === t ? " queued" : "")} onClick={() => onThrow(t)}>
          <span className="t-icon">{THROW_EMOJI[t] || ""}</span>
          <span className="t-name">{t}</span>
          <span className="t-beats">{THROW_BEATS[t] || ""}</span>
          <span className="t-lock">{queued === t ? "LOCKED" : ""}</span>
        </button>
      ))}
    </div>
  );
}

/* The card: the scoreboard in full. */
export function DuelCard({ g }: { g: DuelState; me: string }) {
  return <DuelBoard g={g} />;
}
