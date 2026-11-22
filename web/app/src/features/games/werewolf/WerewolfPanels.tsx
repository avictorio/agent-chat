import { useLayoutEffect, useRef, useState } from "react";
import type { WerewolfCheck, WerewolfEvent, WerewolfPlayer, WerewolfState, WerewolfTalk as WerewolfLine, WerewolfYou } from "@chat/contract";
import { WW_TALK_MAX, wwActionVerb, wwEventText, wwRole, wwSideText } from "./werewolf";

/* Werewolf's panels, under the 3D village: your role, your night action
   or day vote, the discussion panel (the town square; wolves also have
   their den), the timeline, the villagers and the chat card. The view
   (view.tsx) mounts them with ctx.panel, so the discussion panel's
   drafts are its own state and survive the view's repaints. Roles stay
   secret: only your own view carries your role, your pack, your checks. */

const hexOf = (g: WerewolfState, n: string) => (((g && g.players) || []).find((p: WerewolfPlayer) => p.name === n) || { hex: "#94a3b8" }).hex;
const VERB_LABEL: Record<string, string> = { kill: "Kill", check: "Check", guard: "Guard", vote: "Vote out" };

/* Your role card: who you are, your pack, what you have learned. */
export function WerewolfRole({ g }: { g: WerewolfState }) {
  const you: Partial<WerewolfYou> = g.you || {};
  const r = wwRole(you.role);
  return (
    <div className={"ww-role" + (you.role === "werewolf" ? " wolf" : "") + (you.alive === false ? " dead" : "")}>
      <span className="ww-role-icon">{r.icon}</span>
      <div className="ww-role-body">
        <div className="ww-role-name">{(you.alive === false ? "You were the " : "You are the ") + r.name}</div>
        <div className="ww-role-blurb">{you.alive === false ? "You're out - you can watch, but not speak or act." : r.blurb}</div>
        {you.pack && you.pack.length ? <div className="ww-role-extra">{"Your pack: " + you.pack.join(", ")}</div> : null}
        {you.checks && you.checks.length ? <div className="ww-role-extra">{"Your checks: " + you.checks.map((c: WerewolfCheck) => c.target + (c.wolf ? " is a werewolf" : " is not a werewolf") + " (night " + c.night + ")").join(" · ")}</div> : null}
        {you.role === "guardian" && you.last_guard ? <div className="ww-role-extra">{"Last night you guarded " + you.last_guard + " - not them again tonight."}</div> : null}
      </div>
    </div>
  );
}

/* Your move: tonight's target (by role), or today's vote with the public
   tallies. The view mounts it only when wwActionVerb(g) has a verb. */
export function WerewolfAction({ g, me, onSend }: { g: WerewolfState; me: string; onSend: (dir: string) => void }) {
  const you: Partial<WerewolfYou> = g.you || {};
  const verb = wwActionVerb(g);
  if (!verb) return null;
  const night = g.phase === "night";
  const options: string[] = (you.legal_moves || []).map((m: string) => m.replace(/^\w+\s+/, ""));
  const mine = night ? you.act : you.vote;
  const tally: Record<string, number> = {};
  if (!night) for (const v of Object.values(g.votes || {}) as string[]) tally[v] = (tally[v] || 0) + 1;
  const pack = (you.pack_picks || {}) as Record<string, string>;
  return (
    <div className="ww-action your-move">
      <div className="ww-action-title">{night ? (verb === "kill" ? "Tonight, your pack kills…" : verb === "check" ? "Tonight, you look into…" : "Tonight, you protect…") : "Today, the village votes out…"}</div>
      <div className="ww-targets">
        {options.map((n) => {
          const extra = night ? Object.keys(pack).filter((w) => pack[w] === n && w !== me) : [];
          return (
            <button key={n} type="button" className={"ww-target" + (mine === n ? " on" : "")} aria-pressed={mine === n ? "true" : "false"} aria-label={(VERB_LABEL[verb] || "Pick") + " " + n} onClick={() => onSend(verb + " " + n)}>
              <span className="hist-dot" style={{ background: hexOf(g, n) }}></span>
              <span className="ww-target-name">{n + (n === me ? " (you)" : "")}</span>
              {!night && tally[n] ? <span className="ww-target-n">{String(tally[n])}</span> : null}
              {extra.length ? <span className="ww-target-pack">{extra.join(", ") + " too"}</span> : null}
            </button>
          );
        })}
      </div>
      <div className="ww-action-help">{night ? (mine ? "Your choice is in - you can change it until dawn." : "Pick one. The night ends when every role has acted.") : mine ? "Your vote is in - you can change it until the day closes." : "Votes are public. The day closes when everyone living has voted."}</div>
    </div>
  );
}

type Channel = "town" | "den";

/* A line to the village or the pack. The field starts from the draft
   when it mounts and reports each keystroke back. Uncontrolled field:
   see docs/agents/games.md, Panels. */
function TalkForm({ ch, draft, onDraft, onSay }: { ch: Channel; draft: string; onDraft: (v: string) => void; onSay: (dir: string) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const [seed] = useState(draft);
  useLayoutEffect(() => {
    if (ref.current) ref.current.value = seed;
  }, [seed]);
  const send = () => {
    const inp = ref.current;
    if (!inp) return;
    const t = inp.value.trim();
    if (!t) return;
    inp.value = "";
    onDraft("");
    onSay((ch === "den" ? "den: " : "say: ") + t);
  };
  return (
    <div className="ww-talk-form">
      <input
        ref={ref}
        className="ww-talk-input"
        maxLength={WW_TALK_MAX}
        placeholder={ch === "den" ? "Whisper to the pack…" : "Say something to the village…"}
        aria-label={ch === "den" ? "Message to the pack" : "Message to the village"}
        onInput={(e) => onDraft(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") send();
        }}
      />
      <button type="button" className="duel-btn sm ww-say" onClick={send}>
        {ch === "den" ? "Whisper" : "Say"}
      </button>
    </div>
  );
}

/* The discussion panel: the town square (everyone by day; the dead and
   spectators read), and for wolves the den. The drafts are this panel's
   state, kept for as long as the match is open. */
export function WerewolfTalk({ g, onSay }: { g: WerewolfState; onSay: (dir: string) => void }) {
  const [draft, setDraft] = useState<Record<Channel, string>>({ town: "", den: "" });
  const you: Partial<WerewolfYou> = g.you || {};
  const wolf = you.role === "werewolf";
  const alive = you.playing && you.alive !== false && g.status === "running";
  const section = (title: string, lines: WerewolfLine[], ch: Channel) => {
    const canTown = ch === "town" && alive && g.phase === "day";
    const canDen = ch === "den" && alive && wolf;
    return (
      <div key={ch} className={"ww-talk-sec" + (ch === "den" ? " den" : "")}>
        <div className="ww-talk-title">{title}</div>
        <div className="ww-talk-list">
          {!lines.length ? <div className="ww-talk-empty">{ch === "den" ? "The pack has said nothing yet." : "Nobody has spoken yet."}</div> : null}
          {lines.slice(-60).map((t, i) => (
            <div key={i} className="ww-line">
              <span className="ww-line-by" style={{ color: hexOf(g, t.by) }}>
                {t.by}
              </span>
              <span className="ww-line-text">{t.text}</span>
              <span className="ww-line-when">{(t.phase === "night" ? "night " : "day ") + t.day}</span>
            </div>
          ))}
        </div>
        {canTown || canDen ? (
          <TalkForm ch={ch} draft={draft[ch]} onDraft={(v) => setDraft((d) => Object.assign({}, d, { [ch]: v }))} onSay={onSay} />
        ) : ch === "town" && alive && g.phase === "night" ? (
          <div className="ww-talk-empty">The village sleeps - talk resumes at dawn.</div>
        ) : null}
      </div>
    );
  };
  return (
    <div className="ww-talk">
      {section("The village square", g.talk || [], "town")}
      {wolf || (g.status !== "running" && (g.den || []).length) ? section(wolf && g.status === "running" ? "The den (only your pack hears this)" : "The den (revealed)", g.den || [], "den") : null}
    </div>
  );
}

/* The timeline: every dawn and every vote. */
export function WerewolfEvents({ g }: { g: WerewolfState }) {
  const evs: WerewolfEvent[] = g.events || [];
  if (!evs.length) {
    return (
      <div className="ww-events">
        <div className="ww-talk-empty">{g.status === "running" ? "The first night has fallen." : "Nothing has happened yet."}</div>
      </div>
    );
  }
  return (
    <div className="ww-events">
      {evs.map((e, i) => (
        <div key={i} className={"ww-ev " + e.kind}>
          <span className="ww-ev-icon">{e.kind === "death" ? "🌙" : e.kind === "saved" ? "🛡️" : e.kind === "quiet" ? "🌙" : e.kind === "eliminated" ? "⚖️" : "☀️"}</span>
          <span className="ww-ev-text" data-hex={e.who ? hexOf(g, e.who) : undefined}>
            {wwEventText(e)}
          </span>
        </div>
      ))}
    </div>
  );
}

/* The villagers: alive or dead (and, once dead, what they were). */
export function WerewolfPlayers({ g, me, compact }: { g: WerewolfState; me?: string; compact?: boolean }) {
  const order: string[] = g.order || [];
  const ps: WerewolfPlayer[] = (g.players || []).slice().sort((a, b) => (b.alive ? 1 : 0) - (a.alive ? 1 : 0) || order.indexOf(a.name) - order.indexOf(b.name));
  return (
    <div className={"ww-players" + (compact ? " compact" : "")}>
      {ps.map((p) => {
        const mine = !!me && p.name === me;
        return (
          <div key={p.name} className={"ww-prow" + (p.alive ? "" : " dead") + (mine ? " mine" : "") + ((g.winners || []).indexOf(p.name) >= 0 ? " won" : "")}>
            <span className="hist-dot" style={{ background: p.hex }}></span>
            <span className="ww-pname">{p.name + (mine ? " (you)" : "")}</span>
            {p.role ? (
              <span className="ww-prole">{wwRole(p.role).icon + " " + wwRole(p.role).name}</span>
            ) : !compact && g.status === "running" && g.phase === "day" ? (
              <span className="ww-pst">{p.voted ? "voted ✓" : "thinking…"}</span>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

/* The card: the phase in one line and the villagers. */
export function WerewolfCard({ g, me }: { g: WerewolfState; me: string }) {
  const alive = (g.players || []).filter((p) => p.alive).length;
  const line = g.status === "running" ? (g.phase === "night" ? "Night " + g.night + " · the village sleeps" : "Day " + g.day + " · " + alive + " alive · talking and voting") : g.status === "finished" ? wwSideText(g) : (g.players || []).length + " players";
  return (
    <div className="ww-card">
      <div className={"ww-card-line" + (g.phase === "night" ? " night" : "")}>{line}</div>
      <WerewolfPlayers g={g} me={me} compact />
    </div>
  );
}
