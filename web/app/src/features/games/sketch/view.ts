import { el } from "../../../lib/index";
import { gameMetaText, type GL, winnerBanner } from "../shared/render";
import { sgArtistPanel, sgGuessForm, sgLastRound, sgMakePad, sgReveal, sgScores } from "./sketch";
import type { GameViewCtx } from "../shared/viewctx";

/* Sketch & Guess (2026-11-20, 3D only): the gallery first, then your
   part - the artist's prompt and sketch pad (or an image of their own),
   or the guess form - the scores and the last round's reveal. The pad
   lives on gameView for the round, so a poll never wipes a half-drawn
   picture; the guess draft too, and typing never rebuilds the view. */
export function renderSketchView(ctx: GameViewCtx, g: GL, force?: boolean) {
  if (!ctx.gameView) return;
  const gv = ctx.gameView;
  const me = ctx.opts.meName();
  const you = g.you || { playing: false };
  const gkey = g.round + ":" + (g.phase || "");
  if (!gv.sgGuess || gv.sgGuess.key !== gkey) gv.sgGuess = { key: gkey, d: you.queued || "" };
  if (!gv.sgPad || gv.sgPad.round !== g.round) gv.sgPad = null;
  const key = [
    g.status,
    g.round,
    g.phase || "",
    (g.image && g.image.url) || "",
    (g.rounds || []).length,
    (g.players || []).map((p: GL) => (p.committed ? 1 : 0) + "" + (p.accepted ? 1 : 0) + ":" + (p.score || 0)).join(","),
    String(you.queued || ""),
    ctx.youSig(g),
    gv.tab || "game",
  ].join("|");
  if (!ctx.claimRender(key, force)) return;
  const act = document.activeElement as HTMLElement | null;
  const hadFocus = !!(act && gv.wrap.contains(act) && act.classList.contains("sg-in"));
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
  const h = ctx.host3d("sketch");
  wrap.appendChild(h.host);
  ctx.paint3d("sketch", g, h);
  if (g.status === "running" && you.playing) {
    if (you.artist && g.phase === "draw") {
      if (!gv.sgPad) gv.sgPad = sgMakePad(g.round);
      const hint = ctx.arenaHint("sketch-draw", "Draw your secret prompt - no letters or words. Guessable but not trivial: you score for each player who gets it, up to 2.");
      if (hint) wrap.appendChild(hint);
      wrap.appendChild(
        sgArtistPanel(
          g,
          gv.sgPad,
          (image) => {
            if (ctx.gameView !== gv) return;
            if (gv.r3dCommit) gv.r3dCommit();
            void ctx.sendMove(g.id, image, note, "Sending your drawing…");
          },
          (msg) => {
            note.textContent = msg;
          }
        )
      );
    } else if (!you.artist && g.phase === "guess") {
      const hint = ctx.arenaHint("sketch-guess", "Name what the drawing shows. Close counts - the Referee rules on near misses.");
      if (hint) wrap.appendChild(hint);
      wrap.appendChild(
        sgGuessForm(
          g,
          gv.sgGuess.d,
          (s) => {
            if (ctx.gameView === gv && gv.sgGuess) gv.sgGuess.d = s;
          },
          (s) => {
            if (ctx.gameView !== gv) return;
            if (gv.r3dCommit) gv.r3dCommit();
            void ctx.sendMove(g.id, s, note, "Sealing your guess…");
          }
        )
      );
      if (hadFocus) {
        const f = wrap.querySelector(".sg-in") as HTMLElement | null;
        if (f) f.focus();
      }
    } else if (you.artist && g.phase === "guess") note.textContent = "Your prompt: " + (you.prompt || "?") + " - the others are guessing.";
    wrap.appendChild(note);
  } else if (g.status === "running") {
    note.textContent = "Spectating - the prompt is revealed when each round ends.";
    wrap.appendChild(note);
  }
  wrap.appendChild(sgScores(g, me));
  const rv = sgReveal(g, sgLastRound(g), me);
  if (rv) wrap.appendChild(rv);
}
