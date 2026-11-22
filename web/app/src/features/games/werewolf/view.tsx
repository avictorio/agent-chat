import { el } from "../../../lib/index";
import type { WerewolfPlayer, WerewolfState } from "@chat/contract";
import { gameMetaText, winnerBanner } from "../shared/render";
import { wwActionVerb } from "./werewolf";
import { WerewolfAction, WerewolfEvents, WerewolfPlayers, WerewolfRole, WerewolfTalk } from "./WerewolfPanels";
import type { GameViewCtx } from "../shared/viewctx";

/* Werewolf: the village, then your role, your night action or day vote,
   the discussion panel (town square; the den for wolves), the timeline
   and the villagers. The panels are React (WerewolfPanels.tsx, mounted
   with ctx.panel): the discussion panel keeps its drafts across
   repaints, and a repaint gives the focus back to the field you were
   typing in. */
export function renderWerewolfView(ctx: GameViewCtx, g: WerewolfState, force?: boolean) {
  if (!ctx.gameView) return;
  const gv = ctx.gameView;
  const me = ctx.opts.meName();
  const you = g.you || { playing: false };
  const key = [g.status, g.phase || "", g.night, g.day, (g.players || []).map((p: WerewolfPlayer) => (p.accepted ? 1 : 0) + "" + (p.alive ? 1 : 0) + (p.voted ? 1 : 0) + (p.role || "")).join(","), JSON.stringify(g.votes || null), (g.talk || []).length, (g.den || []).length, (g.events || []).length, ctx.youSig(g), you.role || "", you.act || "", you.vote || "", (you.checks || []).length, JSON.stringify(you.pack_picks || null), gv.tab || "game"].join("|");
  if (!ctx.claimRender(key, force)) return;
  const wrap = gv.wrap;
  // emptying the wrap detaches the panels, field and all: note it to refocus
  const act = document.activeElement;
  const typing = act instanceof HTMLInputElement && wrap.contains(act) ? act : null;
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
  const h = ctx.host3d("werewolf");
  wrap.appendChild(h.host);
  ctx.paint3d("werewolf", g, h);
  const send = (dir: string) => {
    if (ctx.gameView !== gv) return;
    if (gv.r3dCommit && !/^(say|den):/.test(dir)) gv.r3dCommit();
    void ctx.sendMove(g.id, dir, note);
  };
  if (you.playing) wrap.appendChild(ctx.panel("role", <WerewolfRole g={g} />));
  if (wwActionVerb(g)) {
    const hint = ctx.arenaHint("werewolf", "Lying is legal for everyone. Watch who pushes a vote, and who goes quiet.");
    if (hint) wrap.appendChild(hint);
    wrap.appendChild(ctx.panel("action", <WerewolfAction g={g} me={me} onSend={send} />));
  }
  wrap.appendChild(ctx.panel("talk", <WerewolfTalk g={g} onSay={send} />));
  wrap.appendChild(ctx.panel("events", <WerewolfEvents g={g} />));
  wrap.appendChild(ctx.panel("players", <WerewolfPlayers g={g} me={me} />));
  if (g.status === "running" && !you.playing) note.textContent = "Spectating - you see what the village sees: no roles until the dead are counted.";
  if (note.textContent) wrap.appendChild(note);
  if (typing && typing.isConnected && document.activeElement !== typing) typing.focus({ preventScroll: true });
}
