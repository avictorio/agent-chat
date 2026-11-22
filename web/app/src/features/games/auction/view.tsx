import { el } from "../../../lib/index";
import { gameMetaText, winnerBanner } from "../shared/render";
import { auLastRound } from "./auction";
import { AuctionBid, AuctionLot, AuctionPlayers, AuctionResult } from "./AuctionPanels";
import type { GameViewCtx } from "../shared/viewctx";
import type { AuctionPlayer, AuctionState } from "@chat/contract";

/* The auction: the lot under the hammer, the bidders, your sealed bid,
   then the last lot's result. The panels are React (AuctionPanels.tsx,
   mounted with ctx.panel): the bid keeps its own draft across repaints,
   keyed by lot. */
export function renderAuctionView(ctx: GameViewCtx, g: AuctionState, force?: boolean) {
  if (!ctx.gameView) return;
  const gv = ctx.gameView;
  const me = ctx.opts.meName();
  const you = g.you || { playing: false };
  const queued: number | null = you.queued == null ? null : Number(you.queued);
  const key = [
    g.status,
    g.round,
    (g.rounds || []).length,
    (g.players || []).map((p: AuctionPlayer) => (p.committed ? 1 : 0) + "" + (p.accepted ? 1 : 0) + ":" + (p.budget || 0) + ":" + (p.won || 0)).join(","),
    queued == null ? "" : queued,
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
  const h = ctx.host3d("auction");
  wrap.appendChild(h.host);
  ctx.paint3d("auction", g, h);
  wrap.appendChild(ctx.panel("lot", <AuctionLot g={g} />));
  if (g.status === "running" && you.playing && (you.budget || 0) > 0) {
    const hint = ctx.arenaHint("auction", "Every lot is worth the same. Bid low on the ones others want; save for the ones they don't.");
    if (hint) wrap.appendChild(hint);
    const commit = (v: number) => {
      if (ctx.gameView !== gv) return;
      if (gv.r3dCommit) gv.r3dCommit();
      void ctx.sendMove(g.id, v ? String(v) : "pass", note);
    };
    wrap.appendChild(ctx.panel("bid", <AuctionBid key={g.round} g={g} onCommit={commit} />));
    note.textContent = queued != null ? "You can change your bid until the lot resolves." : "Bids are sealed until everyone has bid.";
    wrap.appendChild(note);
  } else if (g.status === "running" && !you.playing) {
    note.textContent = "Spectating - bids are opened together when each lot resolves.";
    wrap.appendChild(note);
  }
  wrap.appendChild(ctx.panel("players", <AuctionPlayers g={g} me={me} />));
  const last = auLastRound(g);
  wrap.appendChild(ctx.panel("result", <AuctionResult g={g} round={last} />));
}
