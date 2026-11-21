import { ldBidder, ldBidNow, ldCounts, ldCup, ldLastRound, ldRound, ldTable } from "./liarsdice";
import { el } from "../../../lib/index";
import { gameMetaText, type GL, winnerBanner } from "../shared/render";
import type { GameViewCtx } from "../shared/viewctx";

/* Liar's Dice: the standing bid, your cup, the bid builder on your
   turn, the table, and the last round with every cup opened. */
export function renderLiarsView(ctx: GameViewCtx, g: GL, force?: boolean) {
  if (!ctx.gameView) return;
  const gv = ctx.gameView;
  const me = ctx.opts.meName();
  const you = g.you || { playing: false };
  const myTurn = g.status === "running" && you.playing && you.your_turn;
  const total = g.dice_total || 0;
  const wild = !!g.ones_wild;
  const lowFace = wild ? 2 : 1;
  if (myTurn && (!gv.ldDraft || gv.ldDraft.turn !== g.turn)) {
    // start from the classic raise (one more of the same face), or, to
    // open, one of the face you hold most of
    const b = g.bid;
    let qty = 1;
    let face = lowFace;
    if (b && b.qty + 1 <= total) {
      qty = b.qty + 1;
      face = b.face;
    } else if (b) {
      qty = b.qty;
      face = Math.min(6, b.face + 1);
    } else {
      let best = -1;
      for (let f = lowFace; f <= 6; f++) {
        const k = ((you.dice || []) as number[]).filter((d) => ldCounts(d, f, wild)).length;
        if (k > best) {
          best = k;
          face = f;
        }
      }
      qty = Math.max(1, best);
    }
    gv.ldDraft = { turn: g.turn, qty: Math.max(1, Math.min(total, qty)), face };
  }
  const dr = gv.ldDraft;
  const key = [g.status, g.turn, g.round, g.turn_of || "", g.bid ? g.bid.qty + "x" + g.bid.face + g.bid.by : "", (g.players || []).map((p: GL) => (p.accepted ? 1 : 0) + "" + (p.dice || 0) + (p.out ? 1 : 0) + (p.timeouts || 0)).join(""), ((you.dice || []) as number[]).join(""), (g.rounds || []).length, ctx.youSig(g), gv.tab || "game", dr ? dr.qty + "x" + dr.face : ""].join("|");
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
  wrap.appendChild(ldBidNow(g));
  // The scene shows your dice face up and each seat's dice, turn and
  // latest bid on its plate; the cup and the table are for devices
  // without WebGL.
  const flatLd = !ctx.webglOk();
  if (flatLd && g.status === "running" && you.playing && !you.out && (you.dice || []).length) wrap.appendChild(ldCup(g));
  if (myTurn && dr) {
    const hint = ctx.arenaHint("liarsdice", "Raise the count, or the face at the same count - or call liar if you think the table can't hold the bid.");
    if (hint) wrap.appendChild(hint);
    wrap.appendChild(
      ldBidder(
        g,
        dr,
        (d) => {
          if (ctx.gameView !== gv) return;
          gv.ldDraft = { turn: g.turn, qty: d.qty, face: d.face };
          renderLiarsView(ctx, g, true);
        },
        (dir) => {
          if (ctx.gameView !== gv) return;
          if (gv.r3dCommit) gv.r3dCommit();
          void ctx.sendMove(g.id, dir, note);
        },
        () => {
          if (ctx.gameView !== gv) return;
          if (gv.r3dCommit) gv.r3dCommit();
          void ctx.sendMove(g.id, "liar", note);
        }
      )
    );
  }
  if (flatLd) wrap.appendChild(ldTable(g, me));
  wrap.appendChild(ldRound(g, ldLastRound(g)));
  if (g.status === "running" && !you.playing) note.textContent = "Spectating - every cup stays hidden until someone calls liar.";
  else if (g.status === "running" && you.playing && you.out) note.textContent = "You're out of dice - watch the rest play it out.";
  else if (g.status === "running" && you.playing && !myTurn) note.textContent = "Not your turn. You'll get a nudge when the bid comes round to you.";
  if (note.textContent) wrap.appendChild(note);
}
