import { el } from "../../../lib/index";
import { gameMetaText, winnerBanner } from "../shared/render";
import { crBoard, crInput, crSecretEl } from "./coderace";
import type { GameViewCtx } from "../shared/viewctx";
import type { CodeRacePlayer, CodeRaceState } from "@chat/contract";

/* Code Race (2026-11-19): the race board (your lane with your guesses,
   then each rival's feedback), the secret once it's over, and for a
   racer still racing the guess input. The draft lives on gameView so a
   poll or a rival's guess never wipes it; it resets each round. */
export function renderCodeRaceView(ctx: GameViewCtx, g: CodeRaceState, force?: boolean) {
  if (!ctx.gameView) return;
  const gv = ctx.gameView;
  const me = ctx.opts.meName();
  const you = g.you || { playing: false };
  const queued: string | null = you.queued || null;
  if (!gv.crDraft || gv.crDraft.round !== g.round) gv.crDraft = { round: g.round, v: queued || "" };
  const key = [
    g.status,
    g.round,
    (g.rounds || []).length,
    (g.players || []).map((p: CodeRacePlayer) => (p.committed ? 1 : 0) + "" + (p.solved || 0) + (p.out ? 1 : 0) + (p.accepted ? 1 : 0)).join(""),
    queued || "",
    g.mode === "words" ? "" : gv.crDraft.v,
    ctx.youSig(g),
    gv.tab || "game",
  ].join("|");
  if (!ctx.claimRender(key, force)) return;
  // a repaint while typing a word keeps the field's focus
  const typing = document.activeElement && (document.activeElement as HTMLElement).classList.contains("cr-word");
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
  // the vault comes first, the input right under it
  const h = ctx.host3d("coderace");
  wrap.appendChild(h.host);
  ctx.paint3d("coderace", g, h);
  const sec = crSecretEl(g);
  if (sec) wrap.appendChild(sec);
  const racing = g.status === "running" && you.playing && !you.solved && !you.out;
  if (racing) {
    const hint = ctx.arenaHint(
      "coderace",
      g.mode === "words"
        ? "Everyone is cracking the same word. You see rivals' colours, never their letters."
        : "Everyone is cracking the same code. You see rivals' pegs, never their colours."
    );
    if (hint) wrap.appendChild(hint);
    wrap.appendChild(
      crInput(
        g,
        gv.crDraft.v,
        (v) => {
          if (ctx.gameView !== gv) return;
          gv.crDraft = { round: g.round, v };
          renderCodeRaceView(ctx, g, true);
        },
        (v) => {
          if (ctx.gameView !== gv) return;
          gv.crDraft = { round: g.round, v };
          // the scene seals and sounds the guess at once, before the request
          if (gv.r3dCommit) gv.r3dCommit();
          void ctx.sendMove(g.id, g.mode === "words" ? v : v.split("").join(" "), note);
        },
        (v) => {
          if (ctx.gameView === gv) gv.crDraft = { round: g.round, v };
        }
      )
    );
    note.textContent = queued
      ? "You can change your guess until the round resolves."
      : g.mode === "words"
        ? "Any real " + (g.length || 5) + "-letter word. Rivals see only your colours until the race ends."
        : "Rivals see only your pegs until the race ends.";
    wrap.appendChild(note);
  } else if (g.status === "running" && !you.playing) {
    note.textContent = "Spectating - guesses stay hidden until the race ends; feedback shows each round.";
    wrap.appendChild(note);
  }
  // The vault's ledgers carry every racer's rounds (yours with your
  // guesses); the lanes are for devices without WebGL.
  if (!ctx.webglOk()) wrap.appendChild(crBoard(g, { me }));
  if (typing) {
    const f = wrap.querySelector(".cr-word") as HTMLInputElement | null;
    if (f) {
      f.focus();
      const n = f.value.length;
      f.setSelectionRange(n, n);
    }
  }
}
