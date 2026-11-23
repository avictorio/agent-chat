import type { DuelPlayer, DuelState } from "@chat/contract";
import { el } from "../../../lib/index";
import { gameMetaText, winnerBanner } from "../shared/render";
import { duelTendencies } from "./duel";
import { DuelPad, DuelScoreboard, DuelTendencies, DuelVerdict } from "./DuelPanels";
import type { GameViewCtx } from "../shared/viewctx";

/* The Duel: the scene (two players), the scoreboard where there is no
   scene, the tendency lines, the last round's verdict and the throw pad.
   The panels are React (DuelPanels.tsx, mounted with ctx.panel). */
export function renderDuelView(ctx: GameViewCtx, g: DuelState, force?: boolean) {
  if (!ctx.gameView) return;
  const key =
    g.status +
    "|" +
    g.round +
    "|" +
    (g.players || []).map((p: DuelPlayer) => (p.wins || 0) + ":" + (p.thrown ? 1 : 0) + (p.accepted ? 1 : 0)).join(",") +
    "|" +
    ((g.you && g.you.queued) || "") +
    "|" +
    ctx.youSig(g) +
    "|" +
    ((ctx.gameView && ctx.gameView.tab) || "game");
  if (!ctx.claimRender(key, force)) return;
  const wrap = ctx.gameView.wrap;
  wrap.textContent = "";
  wrap.appendChild(el("div", "lc-meta", gameMetaText(g)));
  const wb = winnerBanner(g);
  if (wb) wrap.appendChild(wb);
  const rr = ctx.resultRow(g);
  if (rr) wrap.appendChild(rr);
  const tb = ctx.turnBanner(g);
  if (tb) wrap.appendChild(tb);
  if (g.status === "finished" && g.h2h && g.h2h.tally) {
    const h2hline = (g.players || []).map((p: DuelPlayer) => p.name + " " + (g.h2h!.tally[p.name] || 0)).join(" · ");
    wrap.appendChild(el("div", "duel-h2h", "Head-to-head in this room — " + h2hline));
  }
  wrap.appendChild(ctx.arenaTabs(g));
  if (ctx.gameView.tab === "history") {
    ctx.dropDuel3d();
    wrap.appendChild(ctx.historyList(g));
    return;
  }
  const players0 = g.players || [];
  const in3d = players0.length === 2 && g.status !== "lobby";
  // In 3D the status line and the throw pad sit right under the scene
  // (the action next to the view - on a phone the pad must stay on
  // screen); the scoreboard and the rest follow.
  let slot: HTMLElement | null = null;
  if (in3d) {
    if (!ctx.gameView.duel3d) ctx.gameView.duel3d = ctx.makeHost3d("lc-board-big lc-3d-host duel-3d-host");
    wrap.appendChild(ctx.gameView.duel3d.host);
    ctx.paintDuel3d(g, ctx.gameView.duel3d);
    slot = el("div", "duel-slot");
    wrap.appendChild(slot);
  } else ctx.dropDuel3d();
  const put = (n: HTMLElement) => (slot || wrap).appendChild(n);
  // The scene's name plates carry the score (win pips, a streak's
  // flame) and its record the rounds, so the scoreboard is for the
  // lobby and for devices without WebGL.
  if (!in3d || ctx.flat()) wrap.appendChild(ctx.panel("board", <DuelScoreboard g={g} under={in3d} />));
  const tends = duelTendencies(g);
  if (tends.length) wrap.appendChild(ctx.panel("tend", <DuelTendencies tends={tends} />));
  const note = el("div", "lc-note", "");
  const players = g.players || [];
  const rounds = g.rounds || [];
  if (g.status === "lobby") {
    wrap.appendChild(ctx.lobbyPanel(g, note));
    wrap.appendChild(note);
  }
  if (g.status === "running" && players.length === 2) {
    // who's up and the round clock are the turn banner's, at the top
    if (g.you && g.you.playing) {
      const hint = ctx.arenaHint("duel", "Pick a throw — it stays hidden until both lock in.");
      if (hint) wrap.appendChild(hint);
    }
  }
  if (rounds.length) {
    // the throws flip in on the repaint that brings a new round
    const reveal = ctx.gameView.lastRounds != null && rounds.length > ctx.gameView.lastRounds;
    wrap.appendChild(ctx.panel("verdict", <DuelVerdict key={rounds.length} g={g} reveal={reveal} />));
  }
  ctx.gameView.lastRounds = rounds.length;
  if (g.you && g.you.playing && g.status === "running") {
    const onThrow = (t: string) => {
      if (ctx.gameView && ctx.gameView.duelCommit) ctx.gameView.duelCommit(t);
      void ctx.sendMove(g.id, t, note);
    };
    put(ctx.panel("pad", <DuelPad g={g} onThrow={onThrow} />));
    note.textContent = g.you.queued
      ? "Thrown: " + g.you.queued + " - tap another to change it before the round resolves."
      : "Your throw: pick one. It stays hidden until your rival has thrown too.";
    put(note);
  } else if (g.status === "running") {
    note.textContent = "Spectating - throws stay hidden until each round resolves.";
    wrap.appendChild(note);
  }
}
