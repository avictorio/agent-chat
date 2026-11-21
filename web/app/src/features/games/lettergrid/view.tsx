import { el } from "../../../lib/index";
import type { LetterGridMove, LetterGridPlayer, LetterGridState } from "@chat/contract";
import { gameMetaText, winnerBanner } from "../shared/render";
import { lgDir, lgLastRound, lgTap, type LgDraft } from "./lettergrid";
import { LetterGridReveal, LetterGridScores, LetterGridTopWords, LetterGridWordPanel, LetterGridYours } from "./LetterGridPanels";
import type { GameViewCtx } from "../shared/viewctx";

/* Letter Grid (2026-11-20, 3D only): the grid first (tap tiles to trace
   a word), then the word panel, the scores, your words, and the last
   round's words. The panels are React (LetterGridPanels.tsx, mounted
   with ctx.panel). The draft is not the word panel's own state: the
   scene edits it too (a tap on a tile), so it lives on gameView, where a
   poll never wipes it, and a change from either side renders the panel
   and repaints the scene, never the whole view, so the field keeps
   focus. A sent word clears the draft once the server shows it sealed. */
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
  // emptying the wrap detaches the word field: note it to refocus
  const act = document.activeElement;
  const hadFocus = act instanceof HTMLInputElement && act.classList.contains("lg-word") && gv.wrap.contains(act);
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
  const send = (d: LgDraft) => {
    if (ctx.gameView !== gv) return;
    if (gv.r3dCommit) gv.r3dCommit();
    void ctx.sendMove(g.id, lgDir(d), note);
  };
  const wordPanel = () => ctx.panel("word", <LetterGridWordPanel g={g} draft={gv.lgDraft!} onDraft={setDraft} onSend={send} />);
  const paintScene = () => {
    const d = gv.lgDraft;
    ctx.paint3d("lettergrid", g, h, {
      draft: d && d.path ? { word: d.word, path: d.path } : null,
      onCell: canPlay
        ? (r: number, c: number) => {
            if (ctx.gameView !== gv || !gv.lgDraft) return;
            setDraft(lgTap(g, gv.lgDraft, r, c));
          }
        : undefined,
    });
  };
  // typing in the panel and a tap in the scene both land here
  function setDraft(d: LgDraft) {
    if (ctx.gameView !== gv) return;
    gv.lgDraft = d;
    wordPanel();
    paintScene();
  }
  paintScene();
  if (canPlay) {
    const hint = ctx.arenaHint("lettergrid", "Trace a word through touching tiles - diagonals count. Cells nobody has used yet are yours for a bonus point each.");
    if (hint) wrap.appendChild(hint);
    wrap.appendChild(wordPanel());
    const f = wrap.querySelector(".lg-word") as HTMLInputElement | null;
    if (f) {
      // a repaint spells the word in capitals, as the panel it used to
      // rebuild did
      f.value = f.value.toUpperCase();
      if (hadFocus) f.focus();
    }
    note.textContent = queued ? "Sealed until everyone has a word in - send another to change it." : "Your word stays secret until the round resolves.";
    wrap.appendChild(note);
  } else if (g.status === "running" && !you.playing) {
    note.textContent = "Spectating - the words are revealed together when each round resolves.";
    wrap.appendChild(note);
  }
  wrap.appendChild(ctx.panel("scores", <LetterGridScores g={g} me={me} />));
  if (you.playing && (you.queued || (you.played || []).length)) wrap.appendChild(ctx.panel("yours", <LetterGridYours g={g} />));
  const last = lgLastRound(g);
  if (last) wrap.appendChild(ctx.panel("reveal", <LetterGridReveal g={g} round={last} me={me} />));
  if (g.status === "finished" && (g.top_words || []).length) wrap.appendChild(ctx.panel("top", <LetterGridTopWords g={g} />));
}
