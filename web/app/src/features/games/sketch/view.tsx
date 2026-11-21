import { el } from "../../../lib/index";
import { gameMetaText, winnerBanner } from "../shared/render";
import { sgLastRound, sgNewPad } from "./sketch";
import { SketchArtist, SketchGuess, SketchReveal, SketchScores } from "./SketchPanels";
import type { GameViewCtx } from "../shared/viewctx";
import type { SketchPlayer, SketchState, SketchYou } from "@chat/contract";

/* Sketch & Guess (2026-11-20, 3D only): the gallery first, then your
   part - the artist's prompt and sketch pad (or an image of their own),
   or the guess form - the scores and the last round's reveal. The panels
   are React (SketchPanels.tsx, mounted with ctx.panel). The pad's
   drawing lives on gameView for the round (gv.sgPad), so a poll never
   wipes a half-drawn picture; the guess keeps its own draft, keyed by
   round and phase, and typing never rebuilds the view. A rebuild hands
   focus back to the guess field. */
export function renderSketchView(ctx: GameViewCtx, g: SketchState, force?: boolean) {
  if (!ctx.gameView) return;
  const gv = ctx.gameView;
  const me = ctx.opts.meName();
  const you: SketchYou = g.you || { playing: false };
  const gkey = g.round + ":" + (g.phase || "");
  if (!gv.sgPad || gv.sgPad.round !== g.round) gv.sgPad = null;
  const key = [
    g.status,
    g.round,
    g.phase || "",
    (g.image && g.image.url) || "",
    (g.rounds || []).length,
    (g.players || []).map((p: SketchPlayer) => (p.committed ? 1 : 0) + "" + (p.accepted ? 1 : 0) + ":" + (p.score || 0)).join(","),
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
      if (!gv.sgPad) gv.sgPad = sgNewPad(g.round);
      const hint = ctx.arenaHint("sketch-draw", "Draw your secret prompt - no letters or words. Guessable but not trivial: you score for each player who gets it, up to 2.");
      if (hint) wrap.appendChild(hint);
      const send = (image: string) => {
        if (ctx.gameView !== gv) return;
        if (gv.r3dCommit) gv.r3dCommit();
        void ctx.sendMove(g.id, image, note, "Sending your drawing…");
      };
      const oops = (msg: string) => {
        note.textContent = msg;
      };
      wrap.appendChild(ctx.panel("artist", <SketchArtist key={g.round} g={g} pad={gv.sgPad} onSend={send} onError={oops} />));
    } else if (!you.artist && g.phase === "guess") {
      const hint = ctx.arenaHint("sketch-guess", "Name what the drawing shows. Close counts - the Referee rules on near misses.");
      if (hint) wrap.appendChild(hint);
      const send = (s: string) => {
        if (ctx.gameView !== gv) return;
        if (gv.r3dCommit) gv.r3dCommit();
        void ctx.sendMove(g.id, s, note, "Sealing your guess…");
      };
      wrap.appendChild(ctx.panel("guess", <SketchGuess key={gkey} g={g} onSend={send} />));
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
  wrap.appendChild(ctx.panel("scores", <SketchScores g={g} me={me} />));
  const last = sgLastRound(g);
  if (last) wrap.appendChild(ctx.panel("reveal", <SketchReveal g={g} round={last} me={me} />));
}
