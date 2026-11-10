import { useEffect, useRef, useState } from "react";
import type { MemberKind, Message } from "@chat/shared";
import { md } from "./markdown";
import { canSpeak, type Speaker } from "../room/speak";
import { RxChips, type RxApi } from "./reactions";
import { MediaBlocks } from "./media";
import type { GameStore } from "../games/games";
import { same } from "../lib";
import type { ViewerApi } from "../shell/viewer";

// The message feed, ported from the current app's msgNode/renderAll:
// day separators, 5-minute same-sender grouping with gutter timestamps,
// colored names, kind tags, the You tag, and the footer with the listen
// button. Media, YouTube and game cards join in M5/M6; reaction chips
// in M4 (the rx-row ships empty until then, as the frame did in M2).


const HUES = [212, 152, 24, 276, 340, 44, 188, 112, 0, 248, 300, 168];
export function hue(s: string): number {
  let h = 2166136261;
  const str = String(s || "").toLowerCase();
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return HUES[(h >>> 0) % HUES.length]!;
}
export function nameColor(n: string): string {
  return "hsl(" + hue(n) + " 55% var(--l))";
}
export function initials(n: string): string {
  const parts = String(n || "?")
    .trim()
    .split(/[\s._-]+/)
    .filter(Boolean);
  const s =
    parts.length > 1
      ? parts[0]!.charAt(0) + parts[1]!.charAt(0)
      : String(n || "?").slice(0, 2);
  return s.toUpperCase();
}
export function clock(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}
const DAY = 86400000;
function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}
export function dayLabel(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const diff = Math.round((startOfDay(now) - startOfDay(d)) / DAY);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  const o: Intl.DateTimeFormatOptions = { weekday: "long", month: "long", day: "numeric" };
  if (d.getFullYear() !== now.getFullYear()) o.year = "numeric";
  return d.toLocaleDateString([], o);
}

export interface FeedCtx {
  memberSet: Set<string>;
  membersVersion: number;
  avatars: Record<string, string>;
  invite: string;
  kindOf: (name: string) => MemberKind | null;
  voiceOf: (name: string) => string | null;
  meName: string;
  speaker: Speaker;
  speakingId: number | null;
  rx: RxApi;
  rxTargetId: number | null;
  onAvatar: (name: string) => void;
  openViewer: ViewerApi["open"];
  games: GameStore;
}

export function senderKind(m: Message, ctx: FeedCtx): MemberKind | null {
  if (same(m.from, "claude")) return "agent";
  return ctx.kindOf(m.from) || (m.kind === "human" || m.kind === "agent" ? m.kind : null);
}

export interface AvatarProps {
  avatars: Record<string, string>;
  invite: string;
  onAvatar: (name: string) => void;
  xl?: boolean;
}

export function Avatar({ name, ctx }: { name: string; ctx: AvatarProps }) {
  const [imgDead, setImgDead] = useState(false);
  const open = () => ctx.onAvatar(name);
  const key = (e: { key: string; preventDefault(): void }) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); }
  };
  if (same(name, "claude")) {
    return (
      <div className={"avatar bot" + (ctx.xl ? " xl" : "")} data-name={name} tabIndex={0} role="button" aria-label={"View " + name + "'s picture"} onClick={open} onKeyDown={key}>
        <svg viewBox="0 0 24 24">
          <path d="M12 2.5l2.1 6.4 6.4 2.1-6.4 2.1L12 19.5l-2.1-6.4L3.5 11l6.4-2.1z" />
          <path d="M19 15.5l.9 2.6 2.6.9-2.6.9-.9 2.6-.9-2.6-2.6-.9 2.6-.9z" />
        </svg>
      </div>
    );
  }
  const src = ctx.avatars[String(name || "").toLowerCase()];
  if (src && !imgDead) {
    const full = src + (ctx.invite ? (src.indexOf("?") >= 0 ? "&" : "?") + "invite=" + encodeURIComponent(ctx.invite) : "");
    return (
      <div className={"avatar img" + (ctx.xl ? " xl" : "")} data-name={name} tabIndex={0} role="button" aria-label={"View " + name + "'s picture"} onClick={open} onKeyDown={key}>
        <img src={full} alt="" decoding="async" onError={() => setImgDead(true)} />
      </div>
    );
  }
  return (
    <div
      className={"avatar" + (ctx.xl ? " xl" : "")}
      data-name={name}
      tabIndex={0}
      role="button"
      aria-label={"View " + name + "'s picture"}
      style={{ background: "hsl(" + hue(name) + " 42% 44%)" }}
      onClick={open}
      onKeyDown={key}
    >
      {initials(name)}
    </div>
  );
}

export function KindTag({ kind }: { kind: string }) {
  return <span className={"tag k-" + kind}>{kind === "human" ? "Human" : "Agent"}</span>;
}

function MdText({ text, ctx }: { text: string; ctx: FeedCtx }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const version = ctx.membersVersion;
  const memberSetRef = useRef(ctx.memberSet);
  memberSetRef.current = ctx.memberSet;
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    node.textContent = "";
    node.appendChild(md(text, memberSetRef.current));
  }, [text, version]);
  return <div className="text" ref={ref}></div>;
}

const SPEAK_PATHS = (
  <>
    <path d="M4 9v6h4l5 4V5L8 9z" />
    <path d="M16.5 9a4 4 0 0 1 0 6M19 6.5a7.5 7.5 0 0 1 0 11" />
  </>
);
const STOP_PATHS = <rect x="7" y="7" width="10" height="10" rx="1.5" />;

export function MsgRow({ m, prev, ctx }: { m: Message; prev: Message | null; ctx: FeedCtx }) {
  const newDay = !prev || dayLabel(prev.ts) !== dayLabel(m.ts);
  const cont = !newDay && !!prev && same(prev.from, m.from) && m.ts - prev.ts < 5 * 60000;
  const kind = senderKind(m, ctx);
  const mine = !!ctx.meName && same(m.from, ctx.meName);
  const speaking = ctx.speakingId === m.id;
  const showSpeak = canSpeak || !!ctx.voiceOf(m.from);
  return (
    <>
      {newDay && (
        <div className="day-sep" role="separator">
          {dayLabel(m.ts)}
        </div>
      )}
      <div
        className={
          "msg" +
          (cont ? " cont" : "") +
          (kind === "human" ? " human" : "") +
          (ctx.rxTargetId === m.id ? " rx-target" : "")
        }
        data-id={m.id}
      >
        <div className="gutter">
          {cont ? (
            <time title={new Date(m.ts).toLocaleString()}>{clock(m.ts)}</time>
          ) : (
            <Avatar name={m.from} ctx={ctx} />
          )}
        </div>
        <div className="msg-body">
          {!cont && (
            <div className="msg-head">
              <span className="who" style={{ color: nameColor(m.from) }}>
                {m.from}
              </span>
              {same(m.from, "claude") ? (
                <span className="tag k-agent">Bot</span>
              ) : kind ? (
                <KindTag kind={kind} />
              ) : null}
              {mine && <span className="tag">You</span>}
              <time className="when" title={new Date(m.ts).toLocaleString()}>
                {clock(m.ts)}
              </time>
            </div>
          )}
          <MdText text={m.text || ""} ctx={ctx} />
          <MediaBlocks m={m} token={ctx.invite} memberSet={ctx.memberSet} openViewer={ctx.openViewer} games={ctx.games} />
          <div className="msg-foot">
            <div className="rx-row">
              <RxChips m={m} me={ctx.meName} api={ctx.rx} />
            </div>
            <div className="msg-actions">
              <button
                type="button"
                className="react-btn"
                aria-label="Add a reaction"
                title="React"
                onClick={(e) => {
                  const row = e.currentTarget.closest(".msg") as HTMLElement | null;
                  if (row) ctx.rx.openBar(m, row);
                }}
              >
                <svg className="i" viewBox="0 0 24 24">
                  <circle cx="12" cy="12" r="8.2" />
                  <path d="M9.2 10.2h.01M14.8 10.2h.01M8.8 13.6c.8 1.1 1.9 1.7 3.2 1.7s2.4-.6 3.2-1.7" />
                  <path d="M19.5 15.5v5M17 18h5" />
                </svg>
              </button>
              {showSpeak && (
                <button
                  type="button"
                  className={"speak" + (speaking ? " on" : "")}
                  data-id={m.id}
                  aria-label={speaking ? "Stop reading aloud" : "Read this message aloud"}
                  title={speaking ? "Stop" : "Listen"}
                  onClick={() => ctx.speaker.speak(m)}
                >
                  <svg className="i" viewBox="0 0 24 24">
                    {speaking ? STOP_PATHS : SPEAK_PATHS}
                  </svg>
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

export function atBottom(list: HTMLElement): boolean {
  return list.scrollHeight - list.scrollTop - list.clientHeight < 80;
}

// The scrollable feed: rows plus the jump-to-latest pill. Scroll
// pinning for the initial settle lives in RoomShell (it owns the
// stream); this component owns the list element and its handlers.
export function ChatFeed({
  messages,
  ctx,
  jumpVisible,
  setJumpVisible,
  onSettleKill,
  listRef,
  holdProps,
}: {
  messages: Message[];
  ctx: FeedCtx;
  jumpVisible: boolean;
  setJumpVisible: (v: boolean) => void;
  onSettleKill: () => void;
  listRef: React.RefObject<HTMLDivElement | null>;
  holdProps: Record<string, (e: never) => void>;
}) {
  return (
    <div
      className="msgs"
      id="list"
      ref={listRef}
      {...(holdProps as React.HTMLAttributes<HTMLDivElement>)}
      onScroll={(e) => {
        if (atBottom(e.currentTarget)) setJumpVisible(false);
      }}
      onWheel={onSettleKill}
      onTouchMove={onSettleKill}
    >
      <div className="msgs-inner" id="msgs">
        {messages.length === 0 ? (
          <div className="chat-empty">No messages yet. Start the conversation below.</div>
        ) : (
          messages.map((m, i) => (
            <MsgRow key={m.id} m={m} prev={i > 0 ? messages[i - 1]! : null} ctx={ctx} />
          ))
        )}
      </div>
      <div className="jump-wrap">
        <button
          type="button"
          className="btn sm jump"
          id="jump"
          hidden={!jumpVisible}
          onClick={(e) => {
            const list = e.currentTarget.closest(".msgs") as HTMLElement | null;
            if (list) list.scrollTop = list.scrollHeight;
            setJumpVisible(false);
          }}
        >
          New messages ↓
        </button>
      </div>
    </div>
  );
}
