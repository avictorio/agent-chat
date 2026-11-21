import { el } from "../../../lib/index";
import { gameMetaText, winnerBanner } from "../shared/render";
import { tvAnswerForm, tvAskForm, tvJudgeForm, tvLastRound, tvQuestion, tvReveal, tvScores } from "./trivia";
import type { GameViewCtx } from "../shared/viewctx";
import type { TriviaPlayer, TriviaState, TriviaYou } from "@chat/contract";

/* Trivia (2026-11-20, 3D only): the stage first, then the question,
   your form (the quizmaster's question, an answer and a wager, or the
   judge panel), the scores and the last round's reveal. Drafts live on
   gameView keyed by round and phase, and typing never rebuilds the
   view, so a poll cannot steal focus; a rebuild restores the focused
   field. */
export function renderTriviaView(ctx: GameViewCtx, g: TriviaState, force?: boolean) {
  if (!ctx.gameView) return;
  const gv = ctx.gameView;
  const me = ctx.opts.meName();
  const you: TriviaYou = g.you || { playing: false };
  const dkey = g.round + ":" + (g.phase || "");
  if (!gv.tvAsk || gv.tvAsk.key !== dkey) gv.tvAsk = { key: dkey, d: { q: "", a: "", acc: "" } };
  if (!gv.tvAns || gv.tvAns.key !== dkey) gv.tvAns = { key: dkey, d: you.queued ? { a: you.queued.answer, w: you.queued.wager } : { a: "", w: Math.min(10, you.max_wager != null ? you.max_wager : 10) } };
  const key = [
    g.status,
    g.round,
    g.phase || "",
    g.question || "",
    (g.rounds || []).length,
    (g.players || []).map((p: TriviaPlayer) => (p.committed ? 1 : 0) + "" + (p.accepted ? 1 : 0) + ":" + (p.balance || 0)).join(","),
    JSON.stringify(you.queued || {}),
    JSON.stringify(you.to_judge || []),
    ctx.youSig(g),
    gv.tab || "game",
  ].join("|");
  if (!ctx.claimRender(key, force)) return;
  const act = document.activeElement as HTMLElement | null;
  const focusCls = act && gv.wrap.contains(act) && act.classList.contains("tv-in") ? Array.from(act.classList).find((c) => /^tv-in-/.test(c)) || null : null;
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
  const h = ctx.host3d("trivia");
  wrap.appendChild(h.host);
  ctx.paint3d("trivia", g, h);
  const qb = tvQuestion(g);
  if (qb) wrap.appendChild(qb);
  const send = (dir: string) => {
    if (ctx.gameView !== gv) return;
    if (gv.r3dCommit) gv.r3dCommit();
    void ctx.sendMove(g.id, dir, note);
  };
  if (g.status === "running" && you.playing) {
    if (you.asker && g.phase === "ask") {
      const hint = ctx.arenaHint("trivia-ask", "Ask about you, the room, anything you know the answer to. A question some get and some miss pays you 10.");
      if (hint) wrap.appendChild(hint);
      wrap.appendChild(tvAskForm(gv.tvAsk.d, (d) => { if (ctx.gameView === gv && gv.tvAsk) gv.tvAsk.d = d; }, send));
    } else if (you.asker && g.phase === "judge") wrap.appendChild(tvJudgeForm(g, send));
    else if (!you.asker && g.phase === "answer") {
      const hint = ctx.arenaHint("trivia", "Bet what you're sure of: a right answer wins your wager, a wrong one loses it. No answer costs nothing.");
      if (hint) wrap.appendChild(hint);
      wrap.appendChild(tvAnswerForm(g, gv.tvAns.d, (d) => { if (ctx.gameView === gv && gv.tvAns) gv.tvAns.d = d; }, send));
    } else if (you.asker && g.phase === "answer") note.textContent = "Your answer: " + (you.answer || "?") + ((you.accept || []).length ? " (also: " + you.accept!.join(", ") + ")" : "") + " - sealed until the reveal.";
    wrap.appendChild(note);
    if (focusCls) {
      const f = wrap.querySelector("." + focusCls) as HTMLElement | null;
      if (f) f.focus();
    }
  } else if (g.status === "running") {
    note.textContent = "Spectating - answers and wagers are revealed together when each round resolves.";
    wrap.appendChild(note);
  }
  wrap.appendChild(tvScores(g, me));
  const rv = tvReveal(g, tvLastRound(g), me);
  if (rv) wrap.appendChild(rv);
}
