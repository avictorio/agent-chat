import { el } from "../../../lib/index";
import type { TwoTruthsPlayer, TwoTruthsState } from "@chat/contract";
import { gameMetaText, winnerBanner } from "../shared/render";
import { ttLastRound, type TtDraft } from "./twotruths";
import { TwoTruthsReveal, TwoTruthsScores, TwoTruthsStatements, TwoTruthsWriter } from "./TwoTruthsPanels";
import type { GameViewCtx } from "../shared/viewctx";

/* Two Truths and a Lie: the campfire, then the storyteller's form or
   the statements to vote on, the scores and the last reveal. The panels
   are React (TwoTruthsPanels.tsx, mounted with ctx.panel): the form
   keeps its own draft across repaints, keyed by round. */
export function renderTwoTruthsView(ctx: GameViewCtx, g: TwoTruthsState, force?: boolean) {
  if (!ctx.gameView) return;
  const gv = ctx.gameView;
  const me = ctx.opts.meName();
  const you = g.you || { playing: false };
  const writing = g.status === "running" && g.phase === "write" && you.playing && you.teller;
  const key = [g.status, g.round, g.phase || "", g.teller || "", (g.players || []).map((p: TwoTruthsPlayer) => (p.accepted ? 1 : 0) + "" + (p.committed ? 1 : 0) + (p.score || 0)).join(","), (g.statements || []).join("|"), ctx.youSig(g), you.vote == null ? "" : you.vote, you.lie || "", (g.rounds || []).length, gv.tab || "game"].join("|");
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
  const h = ctx.host3d("twotruths");
  wrap.appendChild(h.host);
  ctx.paint3d("twotruths", g, h);
  if (writing) {
    const hint = ctx.arenaHint("twotruths", "The best lies are almost true. The table sees your three statements shuffled.");
    if (hint) wrap.appendChild(hint);
    const send = (d: TtDraft) => {
      if (ctx.gameView !== gv) return;
      if (gv.r3dCommit) gv.r3dCommit();
      void ctx.sendMove(g.id, JSON.stringify({ statements: d.s.map((x) => x.trim()), lie: d.lie }), note);
    };
    wrap.appendChild(ctx.panel("writer", <TwoTruthsWriter key={g.round} onSend={send} />));
  } else if (g.status === "running" && g.phase === "vote") {
    const canVote = you.playing && !you.teller;
    const vote = canVote
      ? (n: number) => {
          if (ctx.gameView !== gv) return;
          if (gv.r3dCommit) gv.r3dCommit();
          void ctx.sendMove(g.id, String(n), note);
        }
      : undefined;
    wrap.appendChild(ctx.panel("statements", <TwoTruthsStatements g={g} onVote={vote} />));
  }
  wrap.appendChild(ctx.panel("scores", <TwoTruthsScores g={g} me={me} />));
  wrap.appendChild(ctx.panel("reveal", <TwoTruthsReveal g={g} r={ttLastRound(g)} />));
  if (g.status === "running" && !you.playing) note.textContent = "Spectating - the lie stays secret until the votes are in.";
  else if (g.status === "running" && g.phase === "write" && !you.teller) note.textContent = g.teller + " is writing. You'll get a nudge when the statements are up.";
  if (note.textContent) wrap.appendChild(note);
}
