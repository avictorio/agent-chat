import { useCallback, useRef, useState, type RefObject } from "react";
import {
  ApiError,
  type BoardData,
  type Constitution,
  type Decision,
  type Digest,
  type MembersResponse,
  type Question,
  type RoomState,
  type Stake,
} from "@chat/shared";
import { toast } from "../lib";

// The board + roster data layer, colocated with the board: the
// six-endpoint load, the members projection (kinds, avatars,
// voices, names), the room_state application with its off-chat
// reload debounce, and the editing gate that holds board refreshes
// while a form is open. RoomShell composes it into BoardApi.

export interface MembersData {
  kinds: Record<string, string>;
  avatars: Record<string, string>;
  voices: Record<string, string>;
  names: string[];
  nameKinds: Record<string, string>;
  inviteOnly: boolean;
  activeCount: number;
}

export const EMPTY_MEMBERS: MembersData = {
  kinds: { claude: "agent" },
  avatars: {},
  voices: {},
  names: ["claude"],
  nameKinds: { claude: "agent" },
  inviteOnly: false,
  activeCount: 0,
};

export function useBoardData(opts: {
  client: import("@chat/shared").RoomClient;
  tabRef: RefObject<string>;
  deny: (e: ApiError) => void;
  deniedRef: RefObject<boolean>;
}) {
  const { client, tabRef, deny, deniedRef } = opts;
  const [rs, setRs] = useState<RoomState | null>(null);
  const [members, setMembers] = useState<MembersData>(EMPTY_MEMBERS);
  const [membersVersion, setMembersVersion] = useState(0);
  const [boardData, setBoardData] = useState<BoardData | null>(null);
  const [boardView, setBoardView] = useState<BoardData | null>(null);
  const rsKeyRef = useRef("");
  const membersKeyRef = useRef("");
  const boardDataRef = useRef<BoardData | null>(null);
  const editingCountRef = useRef(0);
  const pendingBoardRef = useRef(false);
  const boardTimerRef = useRef<number>(0);
  const voicesRef = useRef<Record<string, string>>({});
  voicesRef.current = members.voices;

  const applyState = useCallback((s: RoomState | null | undefined) => {
    if (!s || typeof s !== "object") return;
    const k = JSON.stringify(s);
    if (k === rsKeyRef.current) return;
    const first = rsKeyRef.current === "";
    rsKeyRef.current = k;
    setRs(s);
    if (!first && tabRef.current !== "chat") {
      window.clearTimeout(boardTimerRef.current);
      boardTimerRef.current = window.setTimeout(() => void loadAllRef.current(), 700);
    }
  }, []);

  const editingDelta = useCallback((d: number) => {
    editingCountRef.current += d;
    if (editingCountRef.current <= 0) {
      editingCountRef.current = 0;
      if (pendingBoardRef.current) {
        pendingBoardRef.current = false;
        setBoardView(boardDataRef.current);
      }
    }
  }, []);

  const applyMembersData = useCallback((d: MembersResponse) => {
    const kinds: Record<string, string> = {};
      const avs: Record<string, string> = {};
      const vcs: Record<string, string> = {};
      (d.members || []).forEach((mb) => {
        const key = mb.name.toLowerCase();
        if (mb.kind) kinds[key] = mb.kind;
        if (mb.avatar && (mb.status !== "revoked" || !avs[key])) avs[key] = mb.avatar;
        if (mb.voice && mb.voice.voice_id) vcs[key] = mb.voice.voice_id;
      });
      const names: string[] = [];
      const nameKinds: Record<string, string> = {};
      (d.members || []).forEach((x) => {
        if (x.status === "revoked") return;
        names.push(x.name);
        nameKinds[x.name.toLowerCase()] = x.kind;
      });
      if (!names.some((n) => n.toLowerCase() === "claude")) {
        names.push("claude");
        nameKinds.claude = "agent";
      }
      names.sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : 1));
      const activeCount = (d.members || []).filter((x) => x.status === "active").length;
      const key = JSON.stringify([kinds, avs, vcs, names, d.invite_only, activeCount]);
      if (key === membersKeyRef.current) return;
      membersKeyRef.current = key;
      setMembers({
        kinds,
        avatars: avs,
        voices: vcs,
        names,
        nameKinds,
        inviteOnly: !!d.invite_only,
        activeCount,
      });
    setMembersVersion((v) => v + 1);
  }, []);

  const loadMembers = useCallback(async () => {
    try {
      applyMembersData(await client.members());
    } catch {
      // members are decorative to the feed; the next stream members
      // frame retries the fetch
    }
  }, [client, applyMembersData]);

  const loadAll = useCallback(async () => {
    try {
      const [con, dc, q, sk, dg, mb] = await Promise.all([
        client.api<{ constitution: Constitution | null; history: Constitution[] }>("/constitution?history=1"),
        client.api<{ decisions: Decision[] }>("/decisions"),
        client.api<{ questions: Question[]; resolved: Question[] }>("/questions"),
        client.api<{ stakes: Stake[]; done: Stake[] }>("/stakes"),
        client.api<{ digests: Digest[] }>("/digests?limit=20"),
        client.api<MembersResponse>("/members"),
      ]);
      const data: BoardData = { con, dc: dc.decisions, q, sk, dg: dg.digests, mb };
      boardDataRef.current = data;
      setBoardData(data);
      applyMembersData(mb);
      if (editingCountRef.current > 0) pendingBoardRef.current = true;
      else setBoardView(data);
    } catch (e) {
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
        deny(e);
        return;
      }
      if (!deniedRef.current) toast("Couldn't load the room board: " + (e as Error).message, true);
    }
  }, [client, deny, applyMembersData]);
  const loadAllRef = useRef(loadAll);
  loadAllRef.current = loadAll;

  return {
    rs,
    members,
    membersVersion,
    voicesRef,
    boardData,
    boardView,
    applyState,
    editingDelta,
    loadAll,
    loadAllRef,
    loadMembers,
  };
}
