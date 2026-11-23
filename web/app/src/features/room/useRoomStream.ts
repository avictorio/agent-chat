import { useEffect, useLayoutEffect, useRef } from "react";
import {
  ApiError,
  type Message,
  type RoomClient,
  type RoomState,
} from "@chat/contract";
import { store } from "../../lib/index";
import { useLatest } from "../../lib/useLatest";
import type { useMessages } from "../feed/useMessages";
import type { useBoardData } from "../board/useBoardData";
import type { GameState } from "@chat/contract";
import type { GameStore } from "../games/games";
import type { Speaker } from "./speak";
import type { Status } from "./Sidebar";

// The room's live connection: the initial load with its retry
// loop, the SSE stream (message / reaction / game / members / state /
// delete / gap frames), the recheck-on-close that re-opens it, and the
// re-sync after a drop. Identity discoveries (your name, the agent gate)
// report back through callbacks; everything else lands in the feed
// and board hooks.

type Feed = ReturnType<typeof useMessages>;
type Board = ReturnType<typeof useBoardData>;

// The server writes a ping comment on every open stream every 15 s (the
// pinger in worker/room/Room.ts). A stream that has said nothing for three
// of those is dead: a phone that slept or changed networks can leave the
// connection half-open, with no error ever reaching the reader, and the
// room said "live" while nothing more arrived until a reload.
const STALL_MS = 45_000;
const STALL_CHECK = 5_000;
// Back in view after more than a ping's silence: the device slept (timers
// stop with it, so the stall check had not run). A tab that was only
// hidden kept reading, so its stream is fresh and is left open.
const WAKE_SILENCE = 25_000;
// Re-syncs after a drop run one at a time and at least this far apart: a
// stream that keeps closing as soon as it opens must not turn every
// reopen into a members read and a page of messages.
const RESYNC_GAP = 15_000;
// The server's largest page, and the rows past those the feed holds that
// a re-read takes along (sent while the stream was down).
const PAGE = 500;
const SLACK = 50;
// The boot read's page: the newest messages by id. A gap frame reads it
// again.
const BOOT_PAGE = 200;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// The agent's setup block, for when the server sent none.
function setupBlock(room: string, token: string, name: string): string {
  return (
    "You are invited to the Agent Chat room \"" +
    room +
    "\" as the agent \"" +
    name +
    "\".\nConnect over MCP (Model Context Protocol), the room's agent surface:\n  Endpoint: POST " +
    location.origin +
    "/api/rooms/" +
    room +
    "/mcp\n  Header: X-Invite-Token: " +
    token +
    "\nSend initialize, then tools/list for the room's tools (messages, reactions, the board, games, voice, fetch, uploads). Call whoami and get_room_state first."
  );
}

export function useRoomStream(opts: {
  client: RoomClient;
  room: string;
  token: string;
  feed: Feed;
  board: Board;
  gamesRef: { current: GameStore | null };
  speaker: Speaker;
  setStatus: (s: Status) => void;
  onYou: (you: string) => void;
  /** show the agent setup view; resolves when the person picks the web app */
  onAgentGate: (g: { name: string; block: string }) => Promise<void>;
  deny: (e: ApiError) => void;
  deniedRef: { current: boolean };
  closeRef: { current: () => void };
  /** a message was deleted: close anything open on its row (the reaction bar) */
  onDeleted?: (id: number) => void;
}) {
  const { client, room, closeRef } = opts;
  const ctrlRef = useRef<AbortController | null>(null);
  const membersTimerRef = useRef<number>(0);
  useLayoutEffect(() => {
    closeRef.current = () => ctrlRef.current?.abort();
  }, [closeRef]);
  const live = useLatest(opts);

  // Initial load + stream. The connection is keyed on the client and
  // the room; the collaborators (feed, board, callbacks) are taken as
  // they are when it opens.
  useEffect(() => {
    const { token, feed, board, gamesRef, speaker, setStatus, onYou, onAgentGate, deny, deniedRef } = live.current;
    const fallbackBlock = (name: string) => setupBlock(room, token, name);
    let cancelled = false;
    const streamRefLocal: { fn: () => void } = { fn: () => {} };
    // The stream being read: when it last said anything, whether it is
    // still being read, and whether it is being dropped as dead (which,
    // unlike an abort on purpose, reconnects).
    type Open = { ctrl: AbortController; at: number; open: boolean; stalled: boolean };
    let cur: Open | null = null;
    // Drop a dead stream: dropped() then reconnects with the stream's own
    // backoff. A stream already ended is waiting for that reconnect, so
    // asking again starts nothing: there is one reopen at a time.
    const reopen = (s: Open) => {
      if (!s.open || cur !== s || cancelled) return;
      s.stalled = true;
      s.ctrl.abort();
    };
    // Reaction, members and game frames are sent live only, and a reconnect
    // replays only the messages after the cursor. After a drop, what changed
    // meanwhile is read again: the members, the reactions of the rows the
    // feed holds, and every match that can still change. Without it a
    // reaction vote or a new avatar from the gap showed only after a reload.
    const rs = { running: false, again: false, at: 0, timer: 0 };
    const resync = () => {
      if (cancelled || deniedRef.current) return;
      if (rs.running) {
        rs.again = true;
        return;
      }
      if (rs.timer) return;
      const wait = rs.at + RESYNC_GAP - Date.now();
      if (wait > 0) {
        rs.timer = window.setTimeout(() => {
          rs.timer = 0;
          resync();
        }, wait);
        return;
      }
      // the stream dropped again while this waited: the next open asks
      if (!cur || !cur.open) return;
      rs.running = true;
      rs.at = Date.now();
      void (async () => {
        try {
          void board.loadMembers();
          gamesRef.current?.refreshLive();
          const held = feed.messagesRef.current.length;
          if (held) {
            const seen = new Set<number>();
            feed.rxTouchedRef.current = seen;
            const d = await client.messages(undefined, Math.min(PAGE, held + SLACK));
            if (!cancelled) feed.syncReactions(d.messages || [], seen);
          }
        } catch (e) {
          if (e instanceof ApiError && (e.status === 401 || e.status === 403)) deny(e);
          // any other failure: the next drop's re-sync reads again
        } finally {
          feed.rxTouchedRef.current = null;
          rs.running = false;
          if (rs.again) {
            rs.again = false;
            resync();
          }
        }
      })();
    };
    // A message deleted on the server (a delete frame, live or replayed
    // after a reconnect): its row leaves the feed, and whatever plays from
    // it stops first, a clip or video in the row and its reading aloud. A
    // row removed while playing went on playing in some browsers, and
    // before delete frames existed the row stayed on every open screen
    // until a reload.
    const dropMessage = (id: number) => {
      const row = feed.listRef.current?.querySelector('.msg[data-id="' + id + '"]');
      row?.querySelectorAll("audio, video").forEach((el) => {
        try {
          (el as HTMLMediaElement).pause();
        } catch {
          /* not playing */
        }
      });
      if (speaker.speakingId === id) speaker.stopAll();
      live.current.onDeleted?.(id);
      feed.removeMsg(id);
    };
    // A gap frame: the stream's cursor was older than what the room still
    // keeps, so deliveries in between are gone for this tab (messages and
    // deletes). What follows it is everything the room has past the
    // cursor; the rows the tab already shows may be out of date. The newest
    // page is read again, as at boot, and the feed marks where its old rows
    // end. Before, a tab that slept past the room's kept history joined the
    // old history straight onto the new with no sign of the hole. A feed
    // with no rows has nothing out of date: the gap is ignored.
    // A gap on the first stream, before any message or delete frame and
    // with the cursor still where the boot read left it, is not a hole:
    // the boot page is the room's newest page, read a moment ago. The
    // server can still send one there, as its forgotten mark can sit above
    // the boot read's last_id (over 1,000 messages posted and deleted after
    // the newest live one). Taken as a hole, every page load drew a false
    // divider and read the page again until somebody posted.
    let bootLast: number | null = null;
    let sinceBoot = false;
    let gapRunning = false;
    const afterGap = async (first: boolean) => {
      if (first && !sinceBoot && bootLast !== null && feed.lastRef.current === bootLast) return;
      if (gapRunning || cancelled || deniedRef.current) return;
      const held = new Set(feed.messagesRef.current.map((m) => m.id));
      if (!held.size) return;
      gapRunning = true;
      let rows: Message[] = [];
      try {
        const d = await client.messages(undefined, BOOT_PAGE);
        rows = d.messages || [];
      } catch (e) {
        if (e instanceof ApiError && (e.status === 401 || e.status === 403)) deny(e);
        // any other failure: the replay after the gap still brings what the
        // room has, and the divider still marks the hole
      } finally {
        gapRunning = false;
      }
      if (!cancelled && !deniedRef.current) feed.mergeAfterGap(rows, held);
    };
    // Whether a stream has been asked for since the initial load: every
    // later open follows a failed or dropped one, and re-syncs. Counting
    // from the first open that answered instead, a stream that failed for
    // a while right after the load came up with no re-sync, though the
    // members, reactions and matches may have changed meanwhile.
    let asked = false;
    const recheck = async () => {
      try {
        await client.messages(feed.lastRef.current ?? undefined, 1);
      } catch (e) {
        if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
          deny(e);
          return;
        }
      }
      if (!cancelled) streamRefLocal.fn();
    };
    // The stream is read with fetch, not EventSource: EventSource
    // cannot send headers, and the invite token goes in the
    // X-Invite-Token header like every other call this client makes,
    // never in a URL. The reader below speaks just enough SSE —
    // event/data framing, the id: line (a message's delivery number) and
    // the server's retry: hint — to carry the seven frame kinds.
    const stream = () => {
      ctrlRef.current?.abort();
      if (deniedRef.current || cancelled) return;
      const ctrl = new AbortController();
      ctrlRef.current = ctrl;
      const s: Open = { ctrl, at: Date.now(), open: true, stalled: false };
      cur = s;
      const later = asked;
      asked = true;
      let retryMs = 3000;
      const onFrame = (kind: string, data: string, eventId: number | null) => {
        try {
          if (kind === "members") {
            window.clearTimeout(membersTimerRef.current);
            membersTimerRef.current = window.setTimeout(() => void board.loadAllRef.current(), 300);
          } else if (kind === "reaction") {
            const d = JSON.parse(data) as {
              id: number;
              reactions?: Record<string, string[]>;
            };
            feed.touchReaction(d.id);
            feed.setMessages((arr) =>
              arr.map((m) => (m.id === d.id ? { ...m, reactions: d.reactions || {} } : m))
            );
          } else if (kind === "game") {
            const d = JSON.parse(data) as { game?: GameState };
            if (d.game) gamesRef.current?.onFrame(d.game);
          } else if (kind === "state") {
            const d = JSON.parse(data) as { room_state?: RoomState };
            if (d.room_state) board.applyState(d.room_state);
          } else if (kind === "delete") {
            sinceBoot = true;
            // The cursor moves past a delete like past a message: a delete
            // frame has its own delivery number, and a reconnect from below
            // it would replay it.
            if (eventId !== null && (feed.lastRef.current === null || eventId > feed.lastRef.current)) feed.lastRef.current = eventId;
            const d = JSON.parse(data) as { id?: number };
            if (typeof d.id === "number") dropMessage(d.id);
          } else if (kind === "gap") {
            void afterGap(!later);
          } else if (kind === "message") {
            sinceBoot = true;
            const m = JSON.parse(data) as Message;
            feed.addMsg(m);
            // The cursor is the frame's delivery number (its id: line), not
            // the message id: a draft published late, or a message sent
            // again when its media landed, carries a number past the newest
            // id. Keeping the highest message id instead, a reconnect asked
            // for what it already had and could replay it after every drop.
            const at = eventId ?? m.id;
            if (feed.lastRef.current === null || at > feed.lastRef.current) feed.lastRef.current = at;
          }
        } catch {
          // malformed frame: ignore
        }
      };
      const dropped = () => {
        s.open = false;
        if ((ctrl.signal.aborted && !s.stalled) || cancelled) return;
        if (!deniedRef.current) setStatus("reconnecting");
        window.setTimeout(() => {
          if (!cancelled && ctrlRef.current === ctrl) void recheck();
        }, retryMs);
      };
      // also covers a connection that never answers
      const watch = window.setInterval(() => {
        if (Date.now() - s.at > STALL_MS) reopen(s);
      }, STALL_CHECK);
      void (async () => {
        try {
          const res = await fetch(
            "/api/rooms/" +
              encodeURIComponent(room) +
              "/stream?after=" +
              (feed.lastRef.current ?? 0) +
              // state is opt-in on the server: naming it here is what subscribes
              // this client to room_state as its own event.
              // delete and gap are asked for by name too: the server sends
              // only the kinds listed.
              "&events=message,reaction,game,members,state,delete,gap",
            {
              headers: {
                Accept: "text/event-stream",
                ...(token ? { "X-Invite-Token": token } : {}),
              },
              signal: ctrl.signal,
            }
          );
          if (!res.ok || !res.body) throw new Error("stream " + res.status);
          s.at = Date.now();
          setStatus("live");
          window.dispatchEvent(new Event("ac-stream-open"));
          if (later) resync();
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buf = "";
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            s.at = Date.now();
            buf += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
            let cut = buf.indexOf("\n\n");
            while (cut >= 0) {
              const block = buf.slice(0, cut);
              buf = buf.slice(cut + 2);
              let kind = "message";
              let eventId: number | null = null;
              const dataLines: string[] = [];
              for (const line of block.split("\n")) {
                if (line.startsWith("event:")) kind = line.slice(6).trim();
                else if (line.startsWith("id:")) {
                  const n = Number(line.slice(3).trim());
                  if (Number.isSafeInteger(n) && n > 0) eventId = n;
                }
                else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
                else if (line.startsWith("retry:")) {
                  const n = Number(line.slice(6).trim());
                  if (Number.isFinite(n) && n >= 0) retryMs = n;
                }
              }
              if (dataLines.length) onFrame(kind, dataLines.join("\n"), eventId);
              else if (kind === "members") onFrame("members", "", null);
              cut = buf.indexOf("\n\n");
            }
          }
        } catch {
          // Aborted on purpose (deny, unmount, a newer stream), dropped as
          // dead, or a network drop; dropped() tells them apart.
        }
        window.clearInterval(watch);
        dropped();
      })();
    };
    streamRefLocal.fn = stream;
    const onVisible = () => {
      if (!document.hidden && cur && Date.now() - cur.at > WAKE_SILENCE) reopen(cur);
    };
    // Back online after a network change: the open connection may be on
    // the old network, half-open, and would only be found dead by the
    // stall check up to STALL_MS later.
    const onOnline = () => {
      if (cur) reopen(cur);
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", onOnline);

    (async () => {
      setStatus("connecting");
      // An agent's invite opened in a browser: show the setup view from the
      // preview (GET /invite), which leaves the invite unopened, and read
      // nothing until the person picks the web app - otherwise the first
      // read would join the room as the agent.
      if (token && !store("ac:agent-app:" + room)) {
        try {
          const pv = await client.invitePreview();
          if (cancelled) return;
          if (pv.invite && pv.invite.kind === "agent") {
            await onAgentGate({ name: pv.invite.name, block: pv.agent_onboarding || fallbackBlock(pv.invite.name) });
            if (cancelled) return;
          }
        } catch (e) {
          if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
            deny(e);
            return;
          }
          // no preview (an older server, a network error): the read below decides
        }
      }
      // oxlint-disable-next-line no-unmodified-loop-condition -- the effect's cleanup sets cancelled; the feed and a refusal set the refs
      while (!cancelled && feed.lastRef.current === null && !deniedRef.current) {
        try {
          const d = await client.messages(undefined, BOOT_PAGE);
          if (cancelled) return;
          if (d.you) onYou(d.you);
          if (d.you_kind === "agent" && d.you && !store("ac:agent-app:" + room)) {
            void onAgentGate({ name: d.you, block: d.agent_onboarding || fallbackBlock(d.you) });
          }
          if (d.room_state) board.applyState(d.room_state);
          const sorted = [...d.messages].sort((a, b) => a.id - b.id);
          feed.loadInitial(sorted, d.last_id);
          bootLast = d.last_id;
        } catch (e) {
          if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
            deny(e);
            return;
          }
          if (cancelled) return;
          setStatus("reconnecting");
          await sleep(3000);
        }
      }
      if (!cancelled && !deniedRef.current) {
        stream();
        void board.loadMembers();
        void board.loadAllRef.current();
      }
    })();

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onOnline);
      window.clearTimeout(rs.timer);
      ctrlRef.current?.abort();
      feed.endSettle();
      speaker.stopAll();
    };
  }, [client, room, live]);
}
