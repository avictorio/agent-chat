import { el } from "../../../lib/index";
import { gameMetaText, type GL, winnerBanner } from "../shared/render";
import { ecStory, ecStrip, ecWriter, ecWriters } from "./corpse";
import type { GameViewCtx } from "../shared/viewctx";

/* Exquisite Corpse: the desk (3D only), then your turn (the fold and
   your segment), the turn strip, the story once revealed (with the
   favourite vote), and the writers. */
export function renderCorpseView(ctx: GameViewCtx, g: GL, force?: boolean) {
  if (!ctx.gameView) return;
  const gv = ctx.gameView;
  const me = ctx.opts.meName();
  const you = g.you || { playing: false };
  const writing = g.status === "running" && g.phase === "write" && you.playing && you.writer;
  if (writing && (!gv.ecDraft || gv.ecDraft.turn !== g.turn)) gv.ecDraft = { turn: g.turn, text: "" };
  const key = [g.status, g.phase || "", g.turn, g.turn_of || "", g.segments || 0, (g.players || []).map((p: GL) => (p.accepted ? 1 : 0) + "" + (p.committed ? 1 : 0) + (p.out ? 1 : 0) + (p.skips || 0) + "." + (p.segments || 0)).join(","), (you.tail || "").length, ctx.youSig(g), you.vote == null ? "" : you.vote, (g.story || []).length, (g.honours || []).join("-"), (g.beats || []).length, gv.tab || "game"].join("|");
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
  const h = ctx.host3d("corpse");
  wrap.appendChild(h.host);
  ctx.paint3d("corpse", g, h);
  if (writing && gv.ecDraft) {
    const hint = ctx.arenaHint("corpse", "Carry on from the one segment you can see - contradictions are part of the fun. Nobody corrects anything.");
    if (hint) wrap.appendChild(hint);
    wrap.appendChild(
      ecWriter(g, gv.ecDraft, (text) => {
        if (ctx.gameView !== gv) return;
        if (gv.r3dCommit) gv.r3dCommit();
        void ctx.sendMove(g.id, text, note);
      })
    );
  }
  wrap.appendChild(ecStrip(g));
  if (g.story) {
    const canVote = g.status === "running" && g.phase === "vote" && you.playing;
    wrap.appendChild(
      ecStory(
        g,
        canVote
          ? (n) => {
              if (ctx.gameView !== gv) return;
              if (gv.r3dCommit) gv.r3dCommit();
              void ctx.sendMove(g.id, String(n), note);
            }
          : undefined
      )
    );
  }
  wrap.appendChild(ecWriters(g, me));
  if (g.status === "running" && g.phase === "write" && !writing) note.textContent = (you.playing ? "The story stays folded until the last turn - " : "Spectating - the story stays folded until the last turn. ") + (you.playing ? "you'll get a nudge when it's yours." : "");
  if (note.textContent) wrap.appendChild(note);
}
