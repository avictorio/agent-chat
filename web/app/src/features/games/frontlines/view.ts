import { el } from "../../../lib/index";
import { gameMetaText, type GL, winnerBanner } from "../shared/render";
import { flField, flLastRound, flPlanner } from "./frontlines";
import type { GameViewCtx } from "../shared/viewctx";

/* Frontlines (2026-11-19): the field (the last resolved round, or the
   open field), the turn banner, and for a commander the planner. The
   planner's draft lives on gameView so a poll or the rival's commit
   never wipes a half-made plan; it resets when a new round opens. */
export function renderFrontlinesView(ctx: GameViewCtx, g: GL, force?: boolean) {
  if (!ctx.gameView) return;
  const gv = ctx.gameView;
  const you = g.you || { playing: false };
  const queued: number[] | null = Array.isArray(you.queued) ? you.queued : null;
  if (!gv.flDraft || gv.flDraft.round !== g.round) {
    gv.flDraft = { round: g.round, vals: queued ? queued.slice() : [0, 0, 0, 0, 0] };
  }
  const key = [
    g.status,
    g.round,
    (g.players || []).map((p: GL) => (p.wins || 0) + "" + (p.committed ? 1 : 0) + (p.accepted ? 1 : 0)).join(""),
    queued ? queued.join("/") : "",
    gv.flDraft.vals.join("/"),
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
  // the scene plays the last resolved round (its numbers on the hills
  // and in its caption); the score and the planner follow under it
  const h = ctx.host3d("frontlines");
  wrap.appendChild(h.host);
  ctx.paint3d("frontlines", g, h);
  const score = el("div", "fl-score");
  (g.players || []).forEach((p: GL, i: number) => {
    if (i) score.appendChild(el("span", "fl-vs", "vs"));
    const s = el("span", "fl-score-p");
    const d = el("span", "hist-dot");
    d.style.background = p.hex;
    s.appendChild(d);
    s.appendChild(el("span", "fl-score-name", p.name));
    s.appendChild(el("span", "fl-score-n", String(p.wins || 0)));
    if (g.status === "running") s.appendChild(el("span", "fl-score-st", p.committed ? "committed ✓" : "planning…"));
    score.appendChild(s);
  });
  wrap.appendChild(score);
  const field = flField(g, { me: ctx.opts.meName() });
  const last = flLastRound(g);
  const fieldCap = el("div", "fl-cap", last ? "Round " + last.n + " in numbers" : g.status === "running" ? "Round " + g.round + " · splits stay hidden until both are in" : "");
  if (g.status === "running" && you.playing) {
    const hint = ctx.arenaHint("frontlines", "Put your troops where you think your rival won't. Hold 3 of the 5 hills to take the round.");
    if (hint) wrap.appendChild(hint);
    wrap.appendChild(
      flPlanner(
        g,
        gv.flDraft.vals,
        (v) => {
          if (ctx.gameView !== gv) return;
          gv.flDraft = { round: g.round, vals: v };
          renderFrontlinesView(ctx, g, true);
        },
        (v) => {
          // the scene seals and sounds the lock-in at once, before the request
          if (gv.r3dCommit) gv.r3dCommit();
          void ctx.sendMove(g.id, v.join(","), note);
        }
      )
    );
    note.textContent = queued
      ? "Locked in: " + queued.join("/") + ". You can change it until your rival commits too."
      : "Your split stays hidden until your rival has committed too.";
    wrap.appendChild(note);
  } else if (g.status === "running") {
    note.textContent = "Spectating - splits stay hidden until each round resolves.";
    wrap.appendChild(note);
  }
  // The scene carries the round in numbers (counts on each hill, the
  // result in its caption); the field is for devices without WebGL.
  if (!ctx.webglOk()) {
    wrap.appendChild(fieldCap);
    wrap.appendChild(field);
  }
}
