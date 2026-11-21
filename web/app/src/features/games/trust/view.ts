import { el } from "../../../lib/index";
import { gameMetaText, type GL, winnerBanner } from "../shared/render";
import { trGrid, trLastRound, trPlanner, trScores, type TrDraft } from "./trust";
import type { GameViewCtx } from "../shared/viewctx";

/* Trust (2026-11-19): the scoreboard, your choices (a Cooperate /
   Defect pair per rival), then the last round's who-trusted-whom grid.
   The draft lives on gameView so a poll never wipes it; it resets each
   round. */
export function renderTrustView(ctx: GameViewCtx, g: GL, force?: boolean) {
  if (!ctx.gameView) return;
  const gv = ctx.gameView;
  const me = ctx.opts.meName();
  const you = g.you || { playing: false };
  const queued: TrDraft | null = you.queued || null;
  if (!gv.trDraft || gv.trDraft.round !== g.round) gv.trDraft = { round: g.round, d: queued ? Object.assign({}, queued) : {} };
  const key = [
    g.status,
    g.round,
    (g.rounds || []).length,
    (g.players || []).map((p: GL) => (p.committed ? 1 : 0) + "" + (p.out ? 1 : 0) + (p.accepted ? 1 : 0) + ":" + (p.score || 0)).join(","),
    JSON.stringify(queued || {}),
    JSON.stringify(gv.trDraft.d),
    ctx.youSig(g),
    gv.tab || "game",
  ].join("|");
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
  // the table comes first; the scores and choices follow
  const h = ctx.host3d("trust");
  wrap.appendChild(h.host);
  ctx.paint3d("trust", g, h);
  wrap.appendChild(trScores(g, me));
  if (g.status === "running" && you.playing && !you.out) {
    const hint = ctx.arenaHint("trust", "Every pairing scores on its own: both cooperate 3 each, a betrayal 5 to 0, both defect 1 each. The last round is a secret.");
    if (hint) wrap.appendChild(hint);
    wrap.appendChild(
      trPlanner(
        g,
        gv.trDraft.d,
        (d) => {
          if (ctx.gameView !== gv) return;
          gv.trDraft = { round: g.round, d };
          renderTrustView(ctx, g, true);
        },
        (dir) => {
          if (ctx.gameView !== gv) return;
          if (gv.r3dCommit) gv.r3dCommit();
          void ctx.sendMove(g.id, dir, note);
        }
      )
    );
    note.textContent = queued ? "You can change your choices until the round resolves." : "Your choices stay secret until everyone has chosen.";
    wrap.appendChild(note);
  } else if (g.status === "running" && !you.playing) {
    note.textContent = "Spectating - choices are revealed together when each round resolves.";
    wrap.appendChild(note);
  }
  // The table's threads are the grid (teal trusts, red defects, the key
  // in the frame's caption, each seat's points on its plate); the grid
  // is for devices without WebGL.
  if (!ctx.webglOk()) {
    const last = trLastRound(g);
    wrap.appendChild(el("div", "fl-cap", last ? "Round " + last.n + " · who trusted whom" : ""));
    wrap.appendChild(trGrid(g, last, me));
  }
}
