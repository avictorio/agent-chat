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
// loop, the SSE stream (message / reaction / game / members
// frames), and the recheck-on-close that re-opens it. Identity
// discoveries (your name, the agent gate) report back through
// callbacks; everything else lands in the feed and board hooks.

type Feed = ReturnType<typeof useMessages>;
type Board = ReturnType<typeof useBoardData>;

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
    // event/data framing plus the server's retry: hint — to carry the
    // five frame kinds.
    const stream = () => {
      ctrlRef.current?.abort();
      if (deniedRef.current || cancelled) return;
      const ctrl = new AbortController();
      ctrlRef.current = ctrl;
      let retryMs = 3000;
      const onFrame = (kind: string, data: string) => {
        try {
          if (kind === "members") {
            window.clearTimeout(membersTimerRef.current);
            membersTimerRef.current = window.setTimeout(() => void board.loadAllRef.current(), 300);
          } else if (kind === "reaction") {
            const d = JSON.parse(data) as {
              id: number;
              reactions?: Record<string, string[]>;
            };
            feed.setMessages((arr) =>
              arr.map((m) => (m.id === d.id ? { ...m, reactions: d.reactions || {} } : m))
            );
          } else if (kind === "game") {
            const d = JSON.parse(data) as { game?: GameState };
            if (d.game) gamesRef.current?.onFrame(d.game);
          } else if (kind === "state") {
            const d = JSON.parse(data) as { room_state?: RoomState };
            if (d.room_state) board.applyState(d.room_state);
          } else if (kind === "message") {
            const m = JSON.parse(data) as Message;
            feed.addMsg(m);
            if (feed.lastRef.current === null || m.id > feed.lastRef.current) feed.lastRef.current = m.id;
          }
        } catch {
          // malformed frame: ignore
        }
      };
      const dropped = () => {
        if (ctrl.signal.aborted || cancelled) return;
        if (!deniedRef.current) setStatus("reconnecting");
        window.setTimeout(() => {
          if (!cancelled && ctrlRef.current === ctrl) void recheck();
        }, retryMs);
      };
      void (async () => {
        try {
          const res = await fetch(
            "/api/rooms/" +
              encodeURIComponent(room) +
              "/stream?after=" +
              (feed.lastRef.current ?? 0) +
              // state is opt-in on the server: naming it here is what subscribes
              // this client to room_state as its own event.
              "&events=message,reaction,game,members,state",
            {
              headers: {
                Accept: "text/event-stream",
                ...(token ? { "X-Invite-Token": token } : {}),
              },
              signal: ctrl.signal,
            }
          );
          if (!res.ok || !res.body) throw new Error("stream " + res.status);
          setStatus("live");
          window.dispatchEvent(new Event("ac-stream-open"));
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buf = "";
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
            let cut = buf.indexOf("\n\n");
            while (cut >= 0) {
              const block = buf.slice(0, cut);
              buf = buf.slice(cut + 2);
              let kind = "message";
              const dataLines: string[] = [];
              for (const line of block.split("\n")) {
                if (line.startsWith("event:")) kind = line.slice(6).trim();
                else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
                else if (line.startsWith("retry:")) {
                  const n = Number(line.slice(6).trim());
                  if (Number.isFinite(n) && n >= 0) retryMs = n;
                }
              }
              if (dataLines.length) onFrame(kind, dataLines.join("\n"));
              else if (kind === "members") onFrame("members", "");
              cut = buf.indexOf("\n\n");
            }
          }
        } catch {
          // Aborted on purpose (deny, unmount, a newer stream) or a
          // network drop; dropped() tells the two apart.
        }
        dropped();
      })();
    };
    streamRefLocal.fn = stream;

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
          const d = await client.messages(undefined, 200);
          if (cancelled) return;
          if (d.you) onYou(d.you);
          if (d.you_kind === "agent" && d.you && !store("ac:agent-app:" + room)) {
            void onAgentGate({ name: d.you, block: d.agent_onboarding || fallbackBlock(d.you) });
          }
          if (d.room_state) board.applyState(d.room_state);
          const sorted = [...d.messages].sort((a, b) => a.id - b.id);
          feed.loadInitial(sorted, d.last_id);
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
      ctrlRef.current?.abort();
      feed.endSettle();
      speaker.stopAll();
    };
  }, [client, room, live]);
}
