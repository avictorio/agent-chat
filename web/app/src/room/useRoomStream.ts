import { useEffect, useRef } from "react";
import {
  ApiError,
  type Message,
  type RoomClient,
  type RoomState,
} from "@chat/shared";
import { store } from "../lib";
import type { useMessages } from "../feed/useMessages";
import type { useBoardData } from "../board/useBoardData";
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
  onAgentGate: (g: { name: string; block: string }) => void;
  deny: (e: ApiError) => void;
  deniedRef: { current: boolean };
  closeRef: { current: () => void };
}) {
  const { client, room, token, feed, board, gamesRef, speaker, setStatus, onYou, onAgentGate, deny, deniedRef, closeRef } = opts;
  const esRef = useRef<EventSource | null>(null);
  const membersTimerRef = useRef<number>(0);
  closeRef.current = () => esRef.current?.close();

  // Initial load + stream, mirroring the current app's start().
  useEffect(() => {
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
    const stream = () => {
      esRef.current?.close();
      if (deniedRef.current || cancelled) return;
      const url =
        "/api/rooms/" +
        encodeURIComponent(room) +
        "/stream?after=" +
        (feed.lastRef.current ?? 0) +
        (token ? "&invite=" + encodeURIComponent(token) : "");
      const es = new EventSource(url);
      esRef.current = es;
      es.onopen = () => {
        setStatus("live");
        window.dispatchEvent(new Event("ac-stream-open"));
      };
      es.addEventListener("members", () => {
        window.clearTimeout(membersTimerRef.current);
        membersTimerRef.current = window.setTimeout(() => void board.loadAllRef.current(), 300);
      });
      es.addEventListener("reaction", (e) => {
        try {
          const d = JSON.parse((e as MessageEvent).data) as {
            id: number;
            reactions?: Record<string, string[]>;
          };
          feed.setMessages((arr) =>
            arr.map((m) => (m.id === d.id ? { ...m, reactions: d.reactions || {} } : m))
          );
        } catch {
          // malformed frame: ignore
        }
      });
      es.addEventListener("game", (e) => {
        try {
          const d = JSON.parse((e as MessageEvent).data) as { game?: unknown };
          if (d.game) gamesRef.current?.onFrame(d.game);
        } catch {
          // malformed frame: ignore
        }
      });
      es.addEventListener("message", (e) => {
        try {
          const m = JSON.parse((e as MessageEvent).data) as Message & { room_state?: RoomState };
          if (m.room_state) board.applyState(m.room_state);
          feed.addMsg(m);
          if (feed.lastRef.current === null || m.id > feed.lastRef.current) feed.lastRef.current = m.id;
        } catch {
          // malformed frame: ignore
        }
      });
      es.onerror = () => {
        if (!deniedRef.current) setStatus("reconnecting");
        if (es.readyState === EventSource.CLOSED) {
          window.setTimeout(() => {
            if (!cancelled) void recheck();
          }, 3000);
        }
      };
    };
    streamRefLocal.fn = stream;

    (async () => {
      setStatus("connecting");
      while (!cancelled && feed.lastRef.current === null && !deniedRef.current) {
        try {
          const d = await client.messages(undefined, 200);
          if (cancelled) return;
          if (d.you) onYou(d.you);
          if (d.you_kind === "agent" && d.you && !store("ac:agent-app:" + room)) {
            onAgentGate({
              name: d.you,
              block:
                d.agent_onboarding ||
                "You are invited to the Agent Chat room \"" +
                  room +
                  "\" as the agent \"" +
                  d.you +
                  "\".\nConnect over MCP (Model Context Protocol), the room's agent surface:\n  Endpoint: POST " +
                  location.origin +
                  "/api/rooms/" +
                  room +
                  "/mcp\n  Header: X-Invite-Token: " +
                  token +
                  "\nSend initialize, then tools/list for the room's tools (messages, reactions, the board, games, voice, fetch, uploads). Call whoami and get_room_state first.",
            });
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
      esRef.current?.close();
      feed.endSettle();
      speaker.stopAll();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, room]);
}
