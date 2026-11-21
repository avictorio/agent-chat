import { el } from "../../../lib/index";
import { gameMetaText, winnerBanner } from "../shared/render";
import { tqLastRound } from "./twenty";
import { TwentyAnswerer, TwentyAsker, TwentyBudget, TwentyLog, TwentyReveal, TwentyScores } from "./TwentyPanels";
import type { GameViewCtx } from "../shared/viewctx";
import type { TwentyPlayer, TwentyQuestion, TwentyState, TwentyYou } from "@chat/contract";

/* Twenty Questions: the box and candles (3D only), then the answerer's
   or the questioner's controls, the budget, the Q/A log, the scores
   and the last reveal. The panels are React (TwentyPanels.tsx, mounted
   with ctx.panel): the question box keeps its own draft across repaints,
   keyed by round and questions asked. */
export function renderTwentyView(ctx: GameViewCtx, g: TwentyState, force?: boolean) {
  if (!ctx.gameView) return;
  const gv = ctx.gameView;
  const me = ctx.opts.meName();
  const you: TwentyYou = g.you || { playing: false };
  const key = [g.status, g.round, g.phase || "", g.answerer || "", g.asked || 0, (g.qa || []).map((x: TwentyQuestion) => (x.a || "") + (x.flagged ? "f" : "")).join(","), (g.players || []).map((p: TwentyPlayer) => (p.accepted ? 1 : 0) + "" + (p.score || 0)).join(","), ctx.youSig(g), you.secret || "", (g.rounds || []).length, gv.tab || "game"].join("|");
  if (!ctx.claimRender(key, force)) return;
  const wrap = gv.wrap;
  wrap.textContent = "";
  wrap.appendChild(el("div", "lc-meta", gameMetaText(g)));
  const wb = winnerBanner(g);
  if (wb) wrap.appendChild(wb);
  const rr = ctx.resultRow(g);
  if (rr) wrap.appendChild(rr);
  const tb = ctx.turnBanner(g);
  if (tb) wrap.appendChild(tb);
  wrap.appendChild(ctx.arenaTabs(g));
  if (gv.tab === "history") {
    ctx.drop3d();
    wrap.appendChild(ctx.historyList(g));
    return;
  }
  const note = el("div", "lc-note", "");
  if (g.status === "lobby") {
    ctx.drop3d();
    wrap.appendChild(ctx.lobbyPanel(g, note));
    wrap.appendChild(note);
    return;
  }
  const h = ctx.host3d("twenty");
  wrap.appendChild(h.host);
  ctx.paint3d("twenty", g, h);
  const send = (dir: string) => {
    if (ctx.gameView !== gv) return;
    if (gv.r3dCommit) gv.r3dCommit();
    void ctx.sendMove(g.id, dir, note);
  };
  const dkey = g.round + ":" + (g.asked || 0);
  if (g.status === "running" && you.playing && you.answerer) wrap.appendChild(ctx.panel("answerer", <TwentyAnswerer key={dkey + ":" + (g.phase || "")} g={g} onSend={send} />));
  else if (g.status === "running" && you.playing && g.phase === "ask") {
    const hint = ctx.arenaHint("twenty", "Halve the possibilities each time: is it alive, is it bigger than a breadbox, is it made by people?");
    if (hint) wrap.appendChild(hint);
    wrap.appendChild(ctx.panel("asker", <TwentyAsker key={dkey} g={g} onSend={send} />));
  }
  if (g.status === "running" && g.phase !== "secret") wrap.appendChild(ctx.panel("budget", <TwentyBudget g={g} />));
  if (g.status === "running") wrap.appendChild(ctx.panel("log", <TwentyLog g={g} />));
  wrap.appendChild(ctx.panel("scores", <TwentyScores g={g} me={me} />));
  wrap.appendChild(ctx.panel("reveal", <TwentyReveal r={tqLastRound(g)} />));
  if (g.status === "running" && !you.playing) note.textContent = "Spectating - the secret stays in the box until the round ends.";
  if (note.textContent) wrap.appendChild(note);
}
