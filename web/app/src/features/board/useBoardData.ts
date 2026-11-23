import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from "react";
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
} from "@chat/contract";
import { toast } from "../../lib/index";
import { useLatest } from "../../lib/useLatest";

// The board + roster data layer, colocated with the board: the
// six-endpoint load, the members projection (kinds, avatars,
// voices, names), the room_state application with its off-chat
// reload debounce, and the editing gate that holds board refreshes
// while a form is open. RoomShell composes it into BoardApi.

/** room_state with board_rev, which the server adds in the same wave
 *  as this client: declared here, optional, until the contract carries it. */
type RoomStateRev = RoomState & { board_rev?: number };

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
  kinds: {},
  avatars: {},
  voices: {},
  names: [],
  nameKinds: {},
  inviteOnly: false,
  activeCount: 0,
};

/* The roster is remembered per room on this device, so a
   reload paints avatars and member tags at once instead of initials
   until /members answers (it rides with five other board calls). The
   server's answer replaces it as soon as it lands. */
const MEMBERS_CACHE = "ac-members:";
function cachedMembers(room: string): MembersData | null {
  try {
    const v = localStorage.getItem(MEMBERS_CACHE + room);
    if (!v) return null;
    const d = JSON.parse(v);
    if (!d || typeof d.avatars !== "object" || typeof d.kinds !== "object" || !Array.isArray(d.names)) return null;
    return { ...EMPTY_MEMBERS, ...d };
  } catch {
    return null;
  }
}
function saveMembers(room: string, m: MembersData): void {
  try {
    localStorage.setItem(MEMBERS_CACHE + room, JSON.stringify(m));
  } catch {
    // storage full or blocked: the next load just waits for /members
  }
}

/* Avatar URLs are signed on an hour grid, so the same picture comes back
   under a new URL every hour. Keep the URL already in use while it is the
   same avatar version and still valid for a while: the browser then
   serves it from cache instead of downloading the picture again. */
function keepAvatarUrl(prev: string | undefined, next: string): string {
  if (!prev || prev === next) return next;
  try {
    const a = new URL(prev, location.href);
    const b = new URL(next, location.href);
    if (a.pathname !== b.pathname || a.searchParams.get("v") !== b.searchParams.get("v")) return next;
    const exp = Number(a.searchParams.get("exp") || 0);
    return !exp || exp > Date.now() / 1000 + 600 ? prev : next;
  } catch {
    return next;
  }
}

export function useBoardData(opts: {
  client: import("@chat/contract").RoomClient;
  tabRef: RefObject<string>;
  deny: (e: ApiError) => void;
  deniedRef: RefObject<boolean>;
}) {
  const { client, tabRef, deny, deniedRef } = opts;
  const [rs, setRs] = useState<RoomState | null>(null);
  const [members, setMembers] = useState<MembersData>(() => cachedMembers(client.room) || EMPTY_MEMBERS);
  const avatarsRef = useRef<Record<string, string>>(members.avatars);
  const [membersVersion, setMembersVersion] = useState(0);
  const [boardData, setBoardData] = useState<BoardData | null>(null);
  const [boardView, setBoardView] = useState<BoardData | null>(null);
  // why the board has never loaded, while it has not: the tabs show it
  // with a Retry instead of an empty page
  const [boardError, setBoardError] = useState<string | null>(null);
  const rsKeyRef = useRef("");
  const boardKeyRef = useRef("");
  const loadedAtRef = useRef(0);
  const loadingRef = useRef(0);
  const membersKeyRef = useRef("");
  const boardDataRef = useRef<BoardData | null>(null);
  const editingCountRef = useRef(0);
  const pendingBoardRef = useRef(false);
  const boardTimerRef = useRef<number>(0);
  const voicesRef = useLatest(members.voices);
  // the latest loadAll (defined further down), for the debounced reload
  const loadAllRef = useRef<() => Promise<void>>(async () => {});

  const applyState = useCallback((s: RoomState | null | undefined) => {
    if (!s || typeof s !== "object") return;
    const k = JSON.stringify(s);
    if (k === rsKeyRef.current) return;
    const first = rsKeyRef.current === "";
    rsKeyRef.current = k;
    setRs(s);
    // Reload the board when its part of the state moved (not on game
    // ticks or reactions, which change room_state constantly). On the
    // chat tab too, more lazily: the sidebar counts read the board, and
    // a board tab opened later must not show (or save over) old data.
    // board_rev goes up on every board write: the lists alone missed an
    // edit to a note, a digest or a resolved question's history, so an
    // open board showed the old text until a reload. A room object from
    // before board_rev (for a few minutes after a deploy) sends none, and
    // the lists still key it; they stay in the key with it too, because a
    // decision's missing signers move with the members, not a board write.
    const bk = JSON.stringify([(s as RoomStateRev).board_rev ?? null, s.constitution_version, s.open_questions, s.decisions_awaiting_signatures, s.stakes_due, s.memory]);
    const boardMoved = bk !== boardKeyRef.current;
    boardKeyRef.current = bk;
    if (!first && boardMoved) {
      window.clearTimeout(boardTimerRef.current);
      boardTimerRef.current = window.setTimeout(() => void loadAllRef.current(), tabRef.current === "chat" ? 3000 : 700);
    }
  }, [tabRef]);

  // Opening a board tab reloads anything older than 15 s, so edits that
  // room_state does not reflect - a stake's note, a resolved question's
  // history - show up too. A board that never loaded (one of the six boot
  // calls failed) loads now: waiting for it to be old left every board
  // tab blank for the rest of the session.
  const refreshIfStale = useCallback(() => {
    if (!loadedAtRef.current) {
      if (!loadingRef.current) void loadAllRef.current();
    } else if (Date.now() - loadedAtRef.current > 15000) void loadAllRef.current();
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
        if (mb.avatar && (mb.status !== "revoked" || !avs[key])) avs[key] = keepAvatarUrl(avatarsRef.current[key], mb.avatar);
        if (mb.voice && mb.voice.voice_id) vcs[key] = mb.voice.voice_id;
      });
      const names: string[] = [];
      const nameKinds: Record<string, string> = {};
      (d.members || []).forEach((x) => {
        if (x.status === "revoked") return;
        names.push(x.name);
        nameKinds[x.name.toLowerCase()] = x.kind;
      });
      names.sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : 1));
      const activeCount = (d.members || []).filter((x) => x.status === "active").length;
      const key = JSON.stringify([kinds, avs, vcs, names, d.invite_only, activeCount]);
      if (key === membersKeyRef.current) return;
      membersKeyRef.current = key;
      avatarsRef.current = avs;
      const next: MembersData = {
        kinds,
        avatars: avs,
        voices: vcs,
        names,
        nameKinds,
        inviteOnly: !!d.invite_only,
        activeCount,
      };
      setMembers(next);
      saveMembers(client.room, next);
    setMembersVersion((v) => v + 1);
  }, [client]);

  const loadMembers = useCallback(async () => {
    try {
      applyMembersData(await client.members());
    } catch {
      // members are decorative to the feed; the next stream members
      // frame retries the fetch
    }
  }, [client, applyMembersData]);

  const loadAll = useCallback(async () => {
    loadingRef.current += 1;
    setBoardError(null);
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
      loadedAtRef.current = Date.now();
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
      if (!deniedRef.current) {
        toast("Couldn't load the room board: " + (e as Error).message, true);
        setBoardError((e as Error).message || "network error");
      }
    } finally {
      loadingRef.current -= 1;
    }
  }, [client, deny, applyMembersData, deniedRef]);
  useLayoutEffect(() => {
    loadAllRef.current = loadAll;
  });

  return {
    rs,
    members,
    membersVersion,
    voicesRef,
    boardData,
    boardView,
    boardError,
    applyState,
    editingDelta,
    loadAll,
    loadAllRef,
    loadMembers,
    refreshIfStale,
  };
}
