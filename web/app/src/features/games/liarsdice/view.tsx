import { ldLastRound } from "./liarsdice";
import { LiarsBidder, LiarsBidNow, LiarsCup, LiarsRound, LiarsTable } from "./LiarsDicePanels";
import { el } from "../../../lib/index";
import { gameMetaText, winnerBanner } from "../shared/render";
import type { GameViewCtx } from "../shared/viewctx";
import type { LiarsDicePlayer, LiarsDiceState } from "@chat/contract";

/* Liar's Dice: the standing bid, your cup, the bid builder on your
   turn, the table, and the last round with every cup opened. The panels
   are React (LiarsDicePanels.tsx, mounted with ctx.panel): the bid
   builder keeps its own draft across repaints, keyed by turn. */
export function renderLiarsView(ctx: GameViewCtx, g: LiarsDiceState, force?: boolean) {
  if (!ctx.gameView) return;
  const gv = ctx.gameView;
  const me = ctx.opts.meName();
  const you = g.you || { playing: false };
  const myTurn = g.status === "running" && you.playing && you.your_turn;
  const key = [g.status, g.turn, g.round, g.turn_of || "", g.bid ? g.bid.qty + "x" + g.bid.face + g.bid.by : "", (g.players || []).map((p: LiarsDicePlayer) => (p.accepted ? 1 : 0) + "" + (p.dice || 0) + (p.out ? 1 : 0) + (p.timeouts || 0)).join(""), ((you.dice || []) as number[]).join(""), (g.rounds || []).length, ctx.youSig(g), gv.tab || "game"].join("|");
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
  const h = ctx.host3d("liarsdice");
  wrap.appendChild(h.host);
  ctx.paint3d("liarsdice", g, h);
  wrap.appendChild(ctx.panel("now", <LiarsBidNow g={g} />));
  // The scene shows your dice face up and each seat's dice, turn and
  // latest bid on its plate; the cup and the table are for devices
  // without WebGL.
  const flatLd = !ctx.webglOk();
  if (flatLd && g.status === "running" && you.playing && !you.out && (you.dice || []).length) wrap.appendChild(ctx.panel("cup", <LiarsCup g={g} />));
  if (myTurn) {
    const hint = ctx.arenaHint("liarsdice", "Raise the count, or the face at the same count - or call liar if you think the table can't hold the bid.");
    if (hint) wrap.appendChild(hint);
    const bid = (dir: string) => {
      if (ctx.gameView !== gv) return;
      if (gv.r3dCommit) gv.r3dCommit();
      void ctx.sendMove(g.id, dir, note);
    };
    wrap.appendChild(ctx.panel("bidder", <LiarsBidder key={g.turn} g={g} onBid={bid} onLiar={() => bid("liar")} />));
  }
  if (flatLd) wrap.appendChild(ctx.panel("table", <LiarsTable g={g} me={me} />));
  wrap.appendChild(ctx.panel("round", <LiarsRound g={g} round={ldLastRound(g)} />));
  if (g.status === "running" && !you.playing) note.textContent = "Spectating - every cup stays hidden until someone calls liar.";
  else if (g.status === "running" && you.playing && you.out) note.textContent = "You're out of dice - watch the rest play it out.";
  else if (g.status === "running" && you.playing && !myTurn) note.textContent = "Not your turn. You'll get a nudge when the bid comes round to you.";
  if (note.textContent) wrap.appendChild(note);
}
