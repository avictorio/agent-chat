import { el } from "../../../lib/index";
import type { LightCyclesDir, LightCyclesPlayer, LightCyclesState } from "@chat/contract";
import { gameMetaText, winnerBanner } from "../shared/render";
import type { GameViewCtx } from "../shared/viewctx";
import { LcPad, LcRecordKeeper, LcRiders } from "./LightCyclesPanels";

/* Light Cycles: the board (3D), the riders, the steering pad on your
   move. The panels are React (LightCyclesPanels.tsx, mounted with
   ctx.panel); a tap on the pad, like a tap on a heading marker in the
   scene, sends the move. */
export function renderLightCyclesView(ctx: GameViewCtx, g: LightCyclesState, force?: boolean) {
  if (!ctx.gameView) return;
  const key =
    g.status +
    "|" +
    g.tick +
    "|" +
    ((g.you && g.you.queued) || "") +
    "|" +
    ctx.youSig(g) +
    "|" +
    (g.players || []).map((p: LightCyclesPlayer) => (p.alive ? 1 : 0) + (p.moved ? 1 : 0) + (p.accepted ? 1 : 0)).join("") +
    "|" +
    ((ctx.gameView && ctx.gameView.tab) || "game");
  if (!ctx.claimRender(key, force)) return;
  const wrap = ctx.gameView.wrap;
  wrap.textContent = "";
  wrap.appendChild(el("div", "lc-meta", gameMetaText(g)));
  const wb = winnerBanner(g);
  if (wb) wrap.appendChild(wb);
  const rr = ctx.resultRow(g);
  if (rr) wrap.appendChild(rr);
  const tb = ctx.turnBanner(g);
  if (tb) wrap.appendChild(tb);
  wrap.appendChild(ctx.arenaTabs(g));
  if (ctx.gameView.tab === "history") {
    ctx.dropLc3d();
    wrap.appendChild(ctx.historyList(g));
    return;
  }
  if (!ctx.gameView.lc3d) ctx.gameView.lc3d = ctx.makeHost3d("lc-board-big lc-3d-host");
  wrap.appendChild(ctx.gameView.lc3d.host);
  ctx.paintLc3d(g, ctx.gameView.lc3d);
  wrap.appendChild(ctx.panel("riders", <LcRiders g={g} />));
  const note = el("div", "lc-note", "");
  if (g.status === "lobby") {
    wrap.appendChild(ctx.lobbyPanel(g, note));
    wrap.appendChild(note);
  }
  if (g.you && g.you.playing && g.status === "running" && g.you.alive) {
    const steer = (dir: LightCyclesDir) => {
      void ctx.sendMove(g.id, dir, note);
    };
    wrap.appendChild(ctx.panel("pad", <LcPad g={g} onSteer={steer} />));
    const onBoard = " (or tap a marker on the board)";
    note.textContent = g.you.queued
      ? "Queued: " + g.you.queued + " - tap another direction" + onBoard + " to change it before the tick resolves."
      : g.mode === "async"
        ? "Your move: pick a direction" + onBoard + " — the tick resolves the moment every rider has one in."
        : "Your move: pick a direction" + onBoard + " before the tick closes.";
    wrap.appendChild(note);
  } else if (g.you && g.you.playing && g.status === "running") {
    note.textContent = "You are out - the record is yours to keep.";
    wrap.appendChild(note);
  } else if (g.status === "running") {
    note.textContent = "Spectating - the riders steer by API and by pad.";
    wrap.appendChild(note);
  }
  if (g.record_keeper) wrap.appendChild(ctx.panel("keeper", <LcRecordKeeper name={g.record_keeper} />));
}
