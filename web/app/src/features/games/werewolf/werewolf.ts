import { el } from "../../../lib/index";
import type { GL } from "../shared/render";

/* Werewolf in the page (2026-11-20), under the 3D village: your role,
   your night action or your day vote, the discussion panel (the owner's
   call: the day's talk lives in the game, not the room chat; wolves also
   have their den), the timeline of dawns and votes, the villagers, the
   history and the chat card. Roles stay secret: only your own view
   carries your role, your pack, your checks. */

type RoleInfo = { name: string; icon: string; blurb: string };
const VILLAGER: RoleInfo = { name: "Villager", icon: "🏡", blurb: "You sleep at night. By day, find the wolves and vote them out." };
export const WW_ROLE: Record<string, RoleInfo> = {
  werewolf: { name: "Werewolf", icon: "🐺", blurb: "Each night your pack picks someone to kill. By day, blend in." },
  seer: { name: "Seer", icon: "🔮", blurb: "Each night you learn whether one player is a werewolf." },
  guardian: { name: "Guardian", icon: "🛡️", blurb: "Each night you protect one player - never the same one twice running." },
  villager: VILLAGER,
};
export function wwRole(r?: string | null): RoleInfo {
  return (r && WW_ROLE[r]) || VILLAGER;
}
export const WW_TALK_MAX = 400;
const hexOf = (g: GL, n: string) => (((g && g.players) || []).find((p: GL) => p.name === n) || { hex: "#94a3b8" }).hex;
const VERB_LABEL: Record<string, string> = { kill: "Kill", check: "Check", guard: "Guard", vote: "Vote out" };

export function wwVerb(role: string | undefined): string | null {
  return role === "werewolf" ? "kill" : role === "seer" ? "check" : role === "guardian" ? "guard" : null;
}

/* Your role card: who you are, your pack, what you have learned. */
export function wwRoleCard(g: GL): HTMLElement {
  const you = g.you || {};
  const r = wwRole(you.role);
  const box = el("div", "ww-role" + (you.role === "werewolf" ? " wolf" : "") + (you.alive === false ? " dead" : ""));
  box.appendChild(el("span", "ww-role-icon", r.icon));
  const body = el("div", "ww-role-body");
  body.appendChild(el("div", "ww-role-name", (you.alive === false ? "You were the " : "You are the ") + r.name));
  body.appendChild(el("div", "ww-role-blurb", you.alive === false ? "You're out - you can watch, but not speak or act." : r.blurb));
  if (you.pack && you.pack.length) body.appendChild(el("div", "ww-role-extra", "Your pack: " + you.pack.join(", ")));
  if (you.checks && you.checks.length) body.appendChild(el("div", "ww-role-extra", "Your checks: " + you.checks.map((c: GL) => c.target + (c.wolf ? " is a werewolf" : " is not a werewolf") + " (night " + c.night + ")").join(" · ")));
  if (you.role === "guardian" && you.last_guard) body.appendChild(el("div", "ww-role-extra", "Last night you guarded " + you.last_guard + " - not them again tonight."));
  box.appendChild(body);
  return box;
}

/* Your move: tonight's target (by role), or today's vote with the public
   tallies. */
export function wwAction(g: GL, me: string, onSend: (dir: string) => void): HTMLElement | null {
  const you = g.you || {};
  if (g.status !== "running" || !you.playing || you.alive === false) return null;
  const night = g.phase === "night";
  const verb = night ? wwVerb(you.role) : "vote";
  if (!verb) return null;
  const options: string[] = (you.legal_moves || []).map((m: string) => m.replace(/^\w+\s+/, ""));
  const mine = night ? you.act : you.vote;
  const box = el("div", "ww-action your-move");
  box.appendChild(el("div", "ww-action-title", night ? (verb === "kill" ? "Tonight, your pack kills…" : verb === "check" ? "Tonight, you look into…" : "Tonight, you protect…") : "Today, the village votes out…"));
  const tally: Record<string, number> = {};
  if (!night) for (const v of Object.values(g.votes || {}) as string[]) tally[v] = (tally[v] || 0) + 1;
  const pack = (you.pack_picks || {}) as Record<string, string>;
  const row = el("div", "ww-targets");
  options.forEach((n) => {
    const b = el("button", "ww-target" + (mine === n ? " on" : "")) as HTMLButtonElement;
    b.type = "button";
    b.setAttribute("aria-pressed", mine === n ? "true" : "false");
    const dot = el("span", "hist-dot");
    dot.style.background = hexOf(g, n);
    b.appendChild(dot);
    b.appendChild(el("span", "ww-target-name", n + (n === me ? " (you)" : "")));
    const extra = night ? Object.keys(pack).filter((w) => pack[w] === n && w !== me) : [];
    if (!night && tally[n]) b.appendChild(el("span", "ww-target-n", String(tally[n])));
    if (extra.length) b.appendChild(el("span", "ww-target-pack", extra.join(", ") + " too"));
    b.setAttribute("aria-label", (VERB_LABEL[verb] || "Pick") + " " + n);
    b.addEventListener("click", () => onSend(verb + " " + n));
    row.appendChild(b);
  });
  box.appendChild(row);
  box.appendChild(el("div", "ww-action-help", night ? (mine ? "Your choice is in - you can change it until dawn." : "Pick one. The night ends when every role has acted.") : mine ? "Your vote is in - you can change it until the day closes." : "Votes are public. The day closes when everyone living has voted."));
  return box;
}

/* The discussion panel: the town square (everyone by day; the dead and
   spectators read), and for wolves the den. */
export function wwTalk(g: GL, draft: { town: string; den: string }, onSay: (dir: string) => void): HTMLElement {
  const you = g.you || {};
  const wolf = you.role === "werewolf";
  const alive = you.playing && you.alive !== false && g.status === "running";
  const box = el("div", "ww-talk");
  const section = (title: string, lines: GL[], ch: "town" | "den") => {
    const sec = el("div", "ww-talk-sec" + (ch === "den" ? " den" : ""));
    sec.appendChild(el("div", "ww-talk-title", title));
    const list = el("div", "ww-talk-list");
    if (!lines.length) list.appendChild(el("div", "ww-talk-empty", ch === "den" ? "The pack has said nothing yet." : "Nobody has spoken yet."));
    lines.slice(-60).forEach((t) => {
      const row = el("div", "ww-line");
      const who = el("span", "ww-line-by", t.by);
      who.style.color = hexOf(g, t.by);
      row.appendChild(who);
      row.appendChild(el("span", "ww-line-text", t.text));
      row.appendChild(el("span", "ww-line-when", (t.phase === "night" ? "night " : "day ") + t.day));
      list.appendChild(row);
    });
    sec.appendChild(list);
    const canTown = ch === "town" && alive && g.phase === "day";
    const canDen = ch === "den" && alive && wolf;
    if (canTown || canDen) {
      const form = el("div", "ww-talk-form");
      const inp = el("input", "ww-talk-input") as HTMLInputElement;
      inp.maxLength = WW_TALK_MAX;
      inp.placeholder = ch === "den" ? "Whisper to the pack…" : "Say something to the village…";
      inp.value = draft[ch];
      inp.setAttribute("aria-label", ch === "den" ? "Message to the pack" : "Message to the village");
      const send = () => {
        const t = inp.value.trim();
        if (!t) return;
        draft[ch] = "";
        onSay((ch === "den" ? "den: " : "say: ") + t);
      };
      inp.addEventListener("input", () => (draft[ch] = inp.value));
      inp.addEventListener("keydown", (e) => {
        if (e.key === "Enter") send();
      });
      form.appendChild(inp);
      const b = el("button", "duel-btn sm ww-say", ch === "den" ? "Whisper" : "Say") as HTMLButtonElement;
      b.type = "button";
      b.addEventListener("click", send);
      form.appendChild(b);
      sec.appendChild(form);
    } else if (ch === "town" && alive && g.phase === "night") sec.appendChild(el("div", "ww-talk-empty", "The village sleeps - talk resumes at dawn."));
    box.appendChild(sec);
  };
  section("The village square", (g.talk || []) as GL[], "town");
  if (wolf || (g.status !== "running" && (g.den || []).length)) section(wolf && g.status === "running" ? "The den (only your pack hears this)" : "The den (revealed)", (g.den || []) as GL[], "den");
  return box;
}

/* The timeline: every dawn and every vote. */
export function wwEvents(g: GL): HTMLElement {
  const box = el("div", "ww-events");
  const evs: GL[] = g.events || [];
  if (!evs.length) {
    box.appendChild(el("div", "ww-talk-empty", g.status === "running" ? "The first night has fallen." : "Nothing has happened yet."));
    return box;
  }
  evs.forEach((e) => box.appendChild(wwEventRow(g, e)));
  return box;
}

export function wwEventText(e: GL): string {
  if (e.kind === "death") return "Dawn " + e.night + ": " + e.who + " was killed in the night - " + wwRole(e.role).name.toLowerCase() + ".";
  if (e.kind === "saved") return "Dawn " + e.night + ": someone was attacked and survived.";
  if (e.kind === "quiet") return "Dawn " + e.night + ": the night passed quietly.";
  if (e.kind === "eliminated") return "Day " + e.day + ": the village voted out " + e.who + " (" + e.count + ") - " + wwRole(e.role).name.toLowerCase() + ".";
  if (e.kind === "tie") return "Day " + e.day + ": a tied vote - nobody was voted out.";
  return "Day " + e.day + ": nobody voted.";
}

function wwEventRow(g: GL, e: GL): HTMLElement {
  const row = el("div", "ww-ev " + e.kind);
  row.appendChild(el("span", "ww-ev-icon", e.kind === "death" ? "🌙" : e.kind === "saved" ? "🛡️" : e.kind === "quiet" ? "🌙" : e.kind === "eliminated" ? "⚖️" : "☀️"));
  row.appendChild(el("span", "ww-ev-text", wwEventText(e)));
  if (e.who) row.querySelector(".ww-ev-text")!.setAttribute("data-hex", hexOf(g, e.who));
  return row;
}

/* The villagers: alive or dead (and, once dead, what they were). */
export function wwPlayers(g: GL, me?: string, compact?: boolean): HTMLElement {
  const box = el("div", "ww-players" + (compact ? " compact" : ""));
  const order: string[] = g.order || [];
  const ps: GL[] = ((g.players || []) as GL[]).slice().sort((a, b) => (b.alive ? 1 : 0) - (a.alive ? 1 : 0) || order.indexOf(a.name) - order.indexOf(b.name));
  ps.forEach((p) => {
    const row = el("div", "ww-prow" + (p.alive ? "" : " dead") + (me && p.name === me ? " mine" : "") + ((g.winners || []).indexOf(p.name) >= 0 ? " won" : ""));
    const d = el("span", "hist-dot");
    d.style.background = p.hex;
    row.appendChild(d);
    row.appendChild(el("span", "ww-pname", p.name + (me && p.name === me ? " (you)" : "")));
    if (p.role) row.appendChild(el("span", "ww-prole", wwRole(p.role).icon + " " + wwRole(p.role).name));
    else if (!compact && g.status === "running" && g.phase === "day") row.appendChild(el("span", "ww-pst", p.voted ? "voted ✓" : "thinking…"));
    box.appendChild(row);
  });
  return box;
}

export function wwHistoryRows(g: GL, row: (idx: string) => HTMLElement, who: (p: GL) => HTMLElement, list: HTMLElement): number {
  let n = 0;
  const players: GL[] = g.players || [];
  const byName = (nm: string): GL => players.find((p) => p.name === nm) || { name: nm, hex: "#94a3b8" };
  ((g.events || []) as GL[]).forEach((e: GL) => {
    n++;
    const rw = row(e.night ? "Night " + e.night : "Day " + e.day);
    if (e.who) {
      const seg = el("span", "hist-seg");
      seg.appendChild(who(byName(e.who)));
      seg.appendChild(el("span", "hist-act", (e.kind === "death" ? "killed - " : "voted out - ") + wwRole(e.role).name.toLowerCase()));
      rw.appendChild(seg);
    } else rw.appendChild(el("span", "hist-act", e.kind === "saved" ? "someone survived an attack" : e.kind === "quiet" ? "a quiet night" : e.kind === "tie" ? "a tied vote" : "no votes"));
    list.appendChild(rw);
  });
  return n;
}

export function wwSideText(g: GL): string {
  return g.side === "wolves" ? "The wolves win" : g.side === "village" ? "The village wins" : "";
}

export function wwCardBoard(g: GL, me?: string): HTMLElement {
  const wrap = el("div", "ww-card");
  const alive = ((g.players || []) as GL[]).filter((p) => p.alive).length;
  const line = g.status === "running" ? (g.phase === "night" ? "Night " + g.night + " · the village sleeps" : "Day " + g.day + " · " + alive + " alive · talking and voting") : g.status === "finished" ? wwSideText(g) : (g.players || []).length + " players";
  wrap.appendChild(el("div", "ww-card-line" + (g.phase === "night" ? " night" : ""), line));
  wrap.appendChild(wwPlayers(g, me, true));
  return wrap;
}
