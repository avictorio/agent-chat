import { createContext, useContext } from "react";
import type { MemberKind, RoomClient } from "@chat/shared";
import type { Speaker } from "./speak";
import type { Status } from "./Sidebar";
import type { RxApi } from "../feed/reactions";
import type { ViewerApi } from "../shell/viewer";
import type { GameStore } from "../games/games";
import type { BoardApi } from "../board/shared";

// Room state, shared through context instead of prop drilling.
// Four focused contexts, split by how often they change, so a
// consumer re-renders with the slice it actually reads:
//
//   Session — who and where: the client, the room, your identity.
//     Set once at join; changes only on a lock or reconnect.
//   Members — the roster and everything derived from it (avatars,
//     kinds, voices, the mention set). Changes on roster loads.
//   Feed — the live feed's collaborators: read-aloud, reactions,
//     the viewer, the games store. Changes as those change.
//   BoardApi — the board's action surface (data + calls + gates).
//
// RoomShell owns the state and provides the values; deep
// components (a game card inside a message inside the feed) read
// what they need directly. The games store itself stays an
// external store behind useSyncExternalStore — context only
// carries the reference to it.

export interface SessionValue {
  client: RoomClient;
  room: string;
  token: string;
  meName: string;
  nameLocked: boolean;
  status: Status;
}

export interface MembersValue {
  names: string[];
  kinds: Record<string, string>;
  nameKinds: Record<string, string>;
  voices: Record<string, string>;
  avatars: Record<string, string>;
  inviteOnly: boolean;
  memberSet: Set<string>;
  membersVersion: number;
  kindOf: (name: string) => MemberKind | null;
  voiceOf: (name: string) => string | null;
}

export interface FeedValue {
  speaker: Speaker;
  speakingId: number | null;
  rx: RxApi;
  rxTargetId: number | null;
  onAvatar: (name: string) => void;
  openViewer: ViewerApi["open"];
  games: GameStore;
}

export const SessionContext = createContext<SessionValue | null>(null);
export const MembersContext = createContext<MembersValue | null>(null);
export const FeedContext = createContext<FeedValue | null>(null);
export const BoardApiContext = createContext<BoardApi | null>(null);

function need<T>(v: T | null, hook: string): T {
  if (!v) throw new Error(hook + " used outside the room tree");
  return v;
}

export function useSession(): SessionValue {
  return need(useContext(SessionContext), "useSession");
}
export function useMembers(): MembersValue {
  return need(useContext(MembersContext), "useMembers");
}
export function useFeed(): FeedValue {
  return need(useContext(FeedContext), "useFeed");
}
export function useBoardApi(): BoardApi {
  return need(useContext(BoardApiContext), "useBoardApi");
}
