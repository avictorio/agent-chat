import type { DuelPlayer, DuelState } from "@chat/contract";
import { el } from "../../../lib/index";
import { duelBoard, duelScoreLine, duelTendencies, gameMetaText, roundVerdict, THROW_BEATS, THROW_EMOJI, winnerBanner } from "../shared/render";
import type { GameViewCtx } from "../shared/viewctx";

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
  if (!in3d || !ctx.webglOk()) {
    const big = el("div", "lc-board-big" + (in3d ? " duel-board-under" : ""));
    big.appendChild(duelBoard(g, true));
    wrap.appendChild(big);
  }
  const tends = duelTendencies(g);
  if (tends.length) {
    const tw = el("div", "duel-tend");
    tends.forEach((t) => {
      const row = el("div", "duel-tend-row");
      const nm = el("span", "duel-tend-name", t.name);
      nm.style.color = t.hex;
      row.appendChild(nm);
      row.appendChild(el("span", "", t.line));
      tw.appendChild(row);
    });
    wrap.appendChild(tw);
  }
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
    const last = rounds[rounds.length - 1]!;
    const v = roundVerdict(last, players);
    const banner = el("div", "duel-verdict" + (v.tie ? " clash" : ""));
    const iconsWrap = el("span", "v-icons");
    players.forEach((p: DuelPlayer) => {
      const t = (last.throws || {})[p.name];
      const cls = v.tie ? "tie" : last.winner === p.name ? "winner" : "loser";
      iconsWrap.appendChild(el("span", "v-icon " + cls, t ? THROW_EMOJI[t] || "" : "—"));
    });
    banner.appendChild(iconsWrap);
    banner.appendChild(el("span", "", v.text + " · " + duelScoreLine(g)));
    if (!v.tie && last.winner) {
      const wp = players.filter((p: DuelPlayer) => p.name === last.winner)[0];
      if (wp) banner.style.borderColor = wp.hex;
    }
    if (ctx.gameView.lastRounds != null && rounds.length > ctx.gameView.lastRounds) {
      banner.classList.add("reveal-in");
      iconsWrap.classList.add("flip");
    }
    wrap.appendChild(banner);
  }
  ctx.gameView.lastRounds = rounds.length;
  if (g.you && g.you.playing && g.status === "running") {
    const pad = el("div", "duel-pad2" + (!g.you.queued ? " your-move" : ""));
    ["rock", "paper", "scissors"].forEach((t) => {
      const b = el("button", "duel-tile" + (g.you!.queued === t ? " queued" : ""));
      b.type = "button";
      b.appendChild(el("span", "t-icon", THROW_EMOJI[t] || ""));
      b.appendChild(el("span", "t-name", t));
      b.appendChild(el("span", "t-beats", THROW_BEATS[t] || ""));
      b.appendChild(el("span", "t-lock", g.you!.queued === t ? "LOCKED" : ""));
      b.addEventListener("click", () => {
        if (ctx.gameView && ctx.gameView.duelCommit) ctx.gameView.duelCommit(t);
        void ctx.sendMove(g.id, t, note);
      });
      pad.appendChild(b);
    });
    put(pad);
    note.textContent = g.you.queued
      ? "Thrown: " + g.you.queued + " - tap another to change it before the round resolves."
      : "Your throw: pick one. It stays hidden until your rival has thrown too.";
    put(note);
  } else if (g.status === "running") {
    note.textContent = "Spectating - throws stay hidden until each round resolves.";
    wrap.appendChild(note);
  }
}
