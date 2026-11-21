import type { FourInARowPlayer, FourInARowState } from "@chat/contract";
import { el } from "../../../lib/index";
import { gameMetaText, winnerBanner } from "../shared/render";
import { FourDrops, FourSeats } from "./FourInARowPanels";
import type { GameViewCtx } from "../shared/viewctx";

/* Four in a Row (2026-11-19): who plays which disc, then the board -
   on your turn the column heads are the drop buttons. A drop goes out
   at once; the turn passes when the server answers. The seats and the
   drop row are React (FourInARowPanels.tsx, mounted with ctx.panel). */
export function renderFourView(ctx: GameViewCtx, g: FourInARowState, force?: boolean) {
  if (!ctx.gameView) return;
  const gv = ctx.gameView;
  const me = ctx.opts.meName();
  const you = g.you || { playing: false };
  const key = [g.status, g.turn, g.turn_of || "", (g.board || []).join("/"), (g.players || []).map((p: FourInARowPlayer) => (p.accepted ? 1 : 0) + "" + (p.timeouts || 0)).join(""), ctx.youSig(g), gv.tab || "game"].join("|");
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
  const myTurn = g.status === "running" && you.playing && you.your_turn;
  const drop = (col: number) => {
    if (ctx.gameView !== gv) return;
    if (gv.r3dCommit) gv.r3dCommit();
    void ctx.sendMove(g.id, String(col), note);
  };
  // the scene is the board (its columns take a tap too); the seats and
  // the 1-7 drop buttons stay in the page under it
  const h = ctx.host3d("fourinarow");
  wrap.appendChild(h.host);
  ctx.paint3d("fourinarow", g, h, myTurn ? { onDrop: drop } : {});
  wrap.appendChild(ctx.panel("seats", <FourSeats g={g} me={me} />));
  if (myTurn) {
    const hint = ctx.arenaHint("fourinarow", "Tap a column on the board (or a number) to drop your disc.");
    if (hint) wrap.appendChild(hint);
    wrap.appendChild(ctx.panel("drops", <FourDrops open={you.legal_moves || []} onDrop={drop} />));
  }
  if (g.status === "running" && !you.playing) note.textContent = "Spectating - the board updates as each disc drops.";
  else if (g.status === "running" && you.playing && !myTurn) note.textContent = "Your rival is thinking. You'll get a nudge when it's your turn.";
  if (note.textContent) wrap.appendChild(note);
}
