import { el } from "../../../lib/index";
import { gameMetaText, type GL, winnerBanner } from "../shared/render";
import type { GameViewCtx } from "../shared/viewctx";

/* Light Cycles: the board (3D), the riders, the steering pad on your
   move. */
export function renderLightCyclesView(ctx: GameViewCtx, g: GL, force?: boolean) {
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
    (g.players || []).map((p: GL) => (p.alive ? 1 : 0) + (p.moved ? 1 : 0) + (p.accepted ? 1 : 0)).join("") +
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
  const chips = el("div", "lc-players");
  (g.players || []).forEach((p: GL) => {
    const chip = el("span", "lc-chip" + (p.alive ? "" : " out"));
    const dot = el("span", "lc-dot");
    dot.style.background = p.hex;
    chip.appendChild(dot);
    const state =
      g.status === "lobby"
        ? p.accepted
          ? " · in ✓"
          : " · invited…"
        : g.status === "running"
          ? p.moved
            ? " · moved ✓"
            : " · deciding…"
          : "";
    chip.appendChild(document.createTextNode(p.name + (p.alive ? state : " · out")));
    chips.appendChild(chip);
  });
  wrap.appendChild(chips);
  const note = el("div", "lc-note", "");
  if (g.status === "lobby") {
    wrap.appendChild(ctx.lobbyPanel(g, note));
    wrap.appendChild(note);
  }
  if (g.you && g.you.playing && g.status === "running" && g.you.alive) {
    const pad = el("div", "lc-pad");
    const dirs: [string, string, number, number][] = [
      ["up", "↑", 1, 0],
      ["left", "←", 0, 1],
      ["right", "→", 2, 1],
      ["down", "↓", 1, 2],
    ];
    dirs.forEach((dd) => {
      const b = el("button", "lc-btn" + (g.you.queued === dd[0] ? " queued" : ""), dd[1]);
      b.type = "button";
      b.style.gridColumn = String(dd[2] + 1);
      b.style.gridRow = String(dd[3] + 1);
      b.setAttribute("aria-label", "Steer " + dd[0]);
      if ((g.you.legal_moves || []).indexOf(dd[0]) < 0) b.disabled = true;
      b.addEventListener("click", () => {
        void ctx.sendMove(g.id, dd[0], note);
      });
      pad.appendChild(b);
    });
    wrap.appendChild(pad);
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
  if (g.record_keeper) wrap.appendChild(el("div", "lc-note", "Record keeper: " + g.record_keeper));
}
