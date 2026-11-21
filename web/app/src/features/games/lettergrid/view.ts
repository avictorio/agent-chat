import { el } from "../../../lib/index";
import type { LetterGridMove, LetterGridPlayer, LetterGridState } from "@chat/contract";
import { gameMetaText, winnerBanner } from "../shared/render";
import { lgDir, lgLastRound, lgPanel, lgReveal, lgScores, lgTap, lgTopWords, lgYours } from "./lettergrid";
import type { GameViewCtx } from "../shared/viewctx";

/* Letter Grid (2026-11-20, 3D only): the grid first (tap tiles to trace
   a word), then the word panel, the scores, your words, and the last
   round's words. The draft lives on gameView so a poll never wipes it;
   typing updates the panel in place and repaints only the scene, so
   the field keeps focus. A sent word clears the draft once the server
   shows it sealed. */
export function renderLetterView(ctx: GameViewCtx, g: LetterGridState, force?: boolean) {
  if (!ctx.gameView) return;
  const gv = ctx.gameView;
  const me = ctx.opts.meName();
  const you = g.you || { playing: false };
  const queued: LetterGridMove | null = you.queued || null;
  if (!gv.lgDraft || gv.lgDraft.round !== g.round) gv.lgDraft = { round: g.round, word: "", path: null, tapped: false };
  if (queued && gv.lgDraft.word && gv.lgDraft.word === queued.word) gv.lgDraft = { round: g.round, word: "", path: null, tapped: false };
  const key = [
    g.status,
    g.round,
    (g.rounds || []).length,
    (g.players || []).map((p: LetterGridPlayer) => (p.committed ? 1 : 0) + "" + (p.out ? 1 : 0) + (p.accepted ? 1 : 0) + ":" + (p.score || 0)).join(","),
    JSON.stringify(queued || {}),
    ctx.youSig(g),
    gv.tab || "game",
  ].join("|");
  if (!ctx.claimRender(key, force)) return;
  const hadFocus = !!(gv.lgPanel && document.activeElement === gv.lgPanel.input);
  gv.lgPanel = null;
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
  const canPlay = g.status === "running" && you.playing && !you.out;
  const h = ctx.host3d("lettergrid");
  wrap.appendChild(h.host);
  const paintScene = () => {
    const d = gv.lgDraft;
    ctx.paint3d("lettergrid", g, h, {
      draft: d && d.path ? { word: d.word, path: d.path } : null,
      onCell: canPlay
        ? (r: number, c: number) => {
            if (ctx.gameView !== gv || !gv.lgDraft) return;
            gv.lgDraft = lgTap(g, gv.lgDraft, r, c);
            if (gv.lgPanel) gv.lgPanel.setDraft(gv.lgDraft);
            paintScene();
          }
        : undefined,
    });
  };
  paintScene();
  if (canPlay) {
    const hint = ctx.arenaHint("lettergrid", "Trace a word through touching tiles - diagonals count. Cells nobody has used yet are yours for a bonus point each.");
    if (hint) wrap.appendChild(hint);
    const panel = lgPanel(
      g,
      gv.lgDraft,
      (d) => {
        if (ctx.gameView !== gv) return;
        gv.lgDraft = d;
        paintScene();
      },
      (d) => {
        if (ctx.gameView !== gv) return;
        if (gv.r3dCommit) gv.r3dCommit();
        void ctx.sendMove(g.id, lgDir(d), note);
      }
    );
    gv.lgPanel = panel;
    wrap.appendChild(panel.el);
    if (hadFocus) panel.input.focus();
    note.textContent = queued ? "Sealed until everyone has a word in - send another to change it." : "Your word stays secret until the round resolves.";
    wrap.appendChild(note);
  } else if (g.status === "running" && !you.playing) {
    note.textContent = "Spectating - the words are revealed together when each round resolves.";
    wrap.appendChild(note);
  }
  wrap.appendChild(lgScores(g, me));
  const yours = lgYours(g);
  if (yours) wrap.appendChild(yours);
  const rv = lgReveal(g, lgLastRound(g), me);
  if (rv) wrap.appendChild(rv);
  if (g.status === "finished") {
    const top = lgTopWords(g);
    if (top) wrap.appendChild(top);
  }
}
