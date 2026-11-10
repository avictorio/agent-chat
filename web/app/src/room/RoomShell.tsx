import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Icon as I } from "../ui/Icon";
import {
  ApiError,
  RoomClient,
  type BoardData,
  type Constitution,
  type Decision,
  type Digest,
  type MemberKind,
  type MembersResponse,
  type Message,
  type Question,
  type RoomState,
  type Stake,
} from "@chat/shared";
import { onToast, same, store, toast } from "../lib";
import { InstallStrip, UpdateStrip, useInstall, usePullToRefresh } from "../shell/strips";
import { AgentGateView, LockedView } from "./views";
import { Sidebar, STATUS_LABEL, type Status } from "./Sidebar";
import { ChatFeed, atBottom, type FeedCtx } from "../feed/feed";
import { Composer } from "../composer/composer";
import { Speaker } from "./speak";
import { BoardSections } from "../board/board";
import type { BoardApi } from "../board/shared";
import { AvatarDialog, usePhotoUpload } from "../board/avatar";
import { useViewerHost } from "../shell/viewer";
import { VoiceDialog, type VoiceDialogHandle } from "./voice";
import { createGameStore, type GameStore } from "../games/games";
import { usePush } from "../shell/push";
import { initShellCommon } from "../shell/shell";
import { useReactions } from "../feed/reactions";
import { daysAway } from "../dates";

// The room shell, ported from the current app (PARITY.md sections A
// and B/C/D): fixed layout, sidebar/drawer, top bar, identity, themes,
// access states — and the live message core: the initial load with
// its retry loop, the SSE stream with recheck-on-close, add()
// semantics (dedupe, richer-copy swap, unread, stick/jump), the
// room_state counts, and the members fetch behind kinds, avatars,
// voices and mentions.

const TABS: Record<string, string> = {
  chat: "Chat",
  constitution: "Constitution",
  decisions: "Decisions",
  questions: "Open questions",
  stakes: "Stakes",
  memory: "Memory",
  members: "Members",
};

function ToastHost() {
  const [t, setT] = useState<{ text: string; bad: boolean; n: number } | null>(null);
  useEffect(() => onToast((m) => setT(m)), []);
  useEffect(() => {
    if (!t) return;
    const id = window.setTimeout(() => setT(null), t.bad ? 6000 : 2600);
    return () => window.clearTimeout(id);
  }, [t]);
  if (!t) return <div className="toast" id="toast" role="status" aria-live="polite" hidden></div>;
  return (
    <div className={"toast" + (t.bad ? " bad" : "")} id="toast" role="status" aria-live="polite">
      {t.text}
    </div>
  );
}

export function takeInvite(room: string): string {
  const invKey = "chat-invite:" + room;
  const hm = location.hash.match(/(?:^#|&)invite=([A-Za-z0-9_-]+)/);
  if (hm && hm[1]) {
    store(invKey, hm[1]);
    try {
      history.replaceState(null, "", location.pathname + location.search);
    } catch {
      // history unavailable: the fragment stays, harmless
    }
    return hm[1];
  }
  return store(invKey) || "";
}

interface MembersData {
  kinds: Record<string, string>;
  avatars: Record<string, string>;
  voices: Record<string, string>;
  names: string[];
  nameKinds: Record<string, string>;
  inviteOnly: boolean;
  activeCount: number;
}
const EMPTY_MEMBERS: MembersData = {
  kinds: { claude: "agent" },
  avatars: {},
  voices: {},
  names: ["claude"],
  nameKinds: { claude: "agent" },
  inviteOnly: false,
  activeCount: 0,
};

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function RoomShell({ room }: { room: string }) {
  const [tab, setTab] = useState<string>(() => {
    const h = location.hash.slice(1);
    return TABS[h] ? h : "chat";
  });
  const [navOpen, setNavOpen] = useState(false);
  const [theme, setTheme] = useState<string>(
    () => document.documentElement.getAttribute("data-theme") || "light"
  );
  const [status, setStatus] = useState<Status>("connecting");
  const [messages, setMessages] = useState<Message[]>([]);
  const [rs, setRs] = useState<RoomState | null>(null);
  const [unread, setUnread] = useState(0);
  const [jumpVisible, setJumpVisible] = useState(false);
  const [speakingId, setSpeakingId] = useState<number | null>(null);
  const [members, setMembers] = useState<MembersData>(EMPTY_MEMBERS);
  const [membersVersion, setMembersVersion] = useState(0);
  const [nameState, setNameState] = useState<{ value: string; locked: boolean }>(() => ({
    value: store("chat-you:" + room) || store("chat-name") || "",
    locked: !!store("chat-you:" + room),
  }));
  const nameStateRef = useRef(nameState.value);
  nameStateRef.current = nameState.value;
  const [lockedText, setLockedText] = useState<string | null>(null);
  const [boardData, setBoardData] = useState<BoardData | null>(null);
  const [boardView, setBoardView] = useState<BoardData | null>(null);
  const [avatarName, setAvatarName] = useState<string | null>(null);
  const [gate, setGate] = useState<{ name: string; block: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const inst = useInstall();
  usePullToRefresh();

  const denied = lockedText !== null;
  const tabsDisabled = denied || gate !== null;
  const { client, token } = useMemo(() => {
    const t = takeInvite(room);
    return { client: new RoomClient(room, t || null), token: t };
  }, [room]);

  const tabRef = useRef(tab);
  tabRef.current = tab;
  const nameRef = useRef(nameState.value);
  nameRef.current = nameState.value;
  const deniedRef = useRef(false);
  const seenRef = useRef<Set<number>>(new Set());
  const lastRef = useRef<number | null>(null);
  const rsKeyRef = useRef("");
  const listRef = useRef<HTMLDivElement | null>(null);
  const esRef = useRef<EventSource | null>(null);
  const membersTimerRef = useRef<number>(0);
  const membersKeyRef = useRef("");
  const pendingStickRef = useRef(false);
  const pendingJumpRef = useRef(false);
  const initialSettleRef = useRef(false);
  const settleRef = useRef<{ ro: ResizeObserver | null; timer: number }>({ ro: null, timer: 0 });
  const voicesRef = useRef<Record<string, string>>({});
  voicesRef.current = members.voices;
  const messagesRef = useRef<Message[]>([]);
  messagesRef.current = messages;
  const boardDataRef = useRef<BoardData | null>(null);
  const editingCountRef = useRef(0);
  const pendingBoardRef = useRef(false);
  const boardTimerRef = useRef<number>(0);

  const speakerRef = useRef<Speaker | null>(null);
  if (!speakerRef.current) {
    speakerRef.current = new Speaker({
      room,
      invite: token,
      voiceOf: (n) => voicesRef.current[String(n || "").toLowerCase()] || null,
    });
    speakerRef.current.onChange = (id) => setSpeakingId(id);
  }
  const speaker = speakerRef.current;

  useEffect(() => {
    document.title = room + " · chat";
  }, [room]);

  useEffect(() => {
    document.body.classList.toggle("nav-open", navOpen);
    return () => document.body.classList.remove("nav-open");
  }, [navOpen]);

  const endSettle = useCallback(() => {
    if (settleRef.current.ro) {
      settleRef.current.ro.disconnect();
      settleRef.current.ro = null;
    }
    if (settleRef.current.timer) {
      clearTimeout(settleRef.current.timer);
      settleRef.current.timer = 0;
    }
  }, []);
  const beginSettle = useCallback(() => {
    endSettle();
    if (!window.ResizeObserver) return;
    const list = listRef.current;
    const inner = list?.querySelector("#msgs");
    if (!list || !inner) return;
    const until = Date.now() + 5000;
    const ro = new ResizeObserver(() => {
      if (Date.now() > until) {
        endSettle();
        return;
      }
      list.scrollTop = list.scrollHeight;
    });
    ro.observe(inner);
    settleRef.current.ro = ro;
    settleRef.current.timer = window.setTimeout(endSettle, 5100);
  }, [endSettle]);

  const deny = useCallback((e: ApiError) => {
    deniedRef.current = true;
    setStatus("locked");
    setLockedText(String(e.message || "").replace(/^This room is invite-only\.\s*/i, "").trim());
    esRef.current?.close();
  }, []);

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

  const addMsg = useCallback((m: Message) => {
    if (!m) return;
    if (seenRef.current.has(m.id)) {
      // A richer copy of a message already on screen (its media arrived
      // when the upload published): swap it in instead of dropping it.
      setMessages((arr) => {
        const i = arr.findIndex((x) => x.id === m.id);
        if (i < 0) return arr;
        const old = arr[i]!;
        const richer =
          (m.video && !old.video) ||
          (m.image && !old.image) ||
          (m.audio && !old.audio) ||
          (m.html && !old.html) ||
          (m.doc && !old.doc) ||
          (m.text || "") !== (old.text || "");
        if (!richer) return arr;
        const next = [...arr];
        next[i] = m;
        return next;
      });
      return;
    }
    seenRef.current.add(m.id);
    const list = listRef.current;
    const stick = list ? atBottom(list) : true;
    const mine = !!nameRef.current && same(m.from, nameRef.current);
    if (stick || mine) pendingStickRef.current = true;
    else if (tabRef.current === "chat") pendingJumpRef.current = true;
    if (lastRef.current !== null && tabRef.current !== "chat" && !mine) setUnread((u) => u + 1);
    setMessages((arr) => {
      const prev = arr[arr.length - 1];
      let next: Message[];
      if (!prev || m.id > prev.id) next = [...arr, m];
      else next = [...arr, m].sort((a, b) => a.id - b.id);
      if (next.length > 1200) next = next.slice(-1000);
      return next;
    });
  }, []);

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    if (initialSettleRef.current) {
      initialSettleRef.current = false;
      list.scrollTop = list.scrollHeight;
      beginSettle();
      return;
    }
    if (pendingStickRef.current) {
      pendingStickRef.current = false;
      list.scrollTop = list.scrollHeight;
    } else if (pendingJumpRef.current) {
      pendingJumpRef.current = false;
      setJumpVisible(true);
    }
  }, [messages, beginSettle]);

  const who = useCallback((): string | null => {
    const n = (nameRef.current || "").trim();
    if (n) return n;
    const v = window.prompt("What name should others see for you in this room?") || "";
    const t = v.trim();
    if (!t) return null;
    store("chat-name", t);
    setNameState((st) => ({ value: t, locked: st.locked }));
    return t;
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

  // Initial load + stream, mirroring the current app's start().
  useEffect(() => {
    let cancelled = false;
    const streamRefLocal: { fn: () => void } = { fn: () => {} };
    const recheck = async () => {
      try {
        await client.messages(lastRef.current ?? undefined, 1);
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
        (lastRef.current ?? 0) +
        (token ? "&invite=" + encodeURIComponent(token) : "");
      const es = new EventSource(url);
      esRef.current = es;
      es.onopen = () => {
        setStatus("live");
        window.dispatchEvent(new Event("ac-stream-open"));
      };
      es.addEventListener("members", () => {
        window.clearTimeout(membersTimerRef.current);
        membersTimerRef.current = window.setTimeout(() => void loadAllRef.current(), 300);
      });
      es.addEventListener("reaction", (e) => {
        try {
          const d = JSON.parse((e as MessageEvent).data) as {
            id: number;
            reactions?: Record<string, string[]>;
          };
          setMessages((arr) =>
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
          if (m.room_state) applyState(m.room_state);
          addMsg(m);
          if (lastRef.current === null || m.id > lastRef.current) lastRef.current = m.id;
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
      while (!cancelled && lastRef.current === null && !deniedRef.current) {
        try {
          const d = await client.messages(undefined, 200);
          if (cancelled) return;
          if (d.you) {
            setNameState({ value: d.you, locked: true });
            store("chat-you:" + room, d.you);
          }
          if (d.you_kind === "agent" && d.you && !store("ac:agent-app:" + room)) {
            setGate({
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
          if (d.room_state) applyState(d.room_state);
          const sorted = [...d.messages].sort((a, b) => a.id - b.id);
          sorted.forEach((m) => seenRef.current.add(m.id));
          initialSettleRef.current = true;
          setMessages(sorted);
          lastRef.current = d.last_id;
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
        void loadMembers();
        void loadAllRef.current();
      }
    })();

    return () => {
      cancelled = true;
      esRef.current?.close();
      endSettle();
      speaker.stopAll();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, room]);

  const show = (t: string, fromHash = false) => {
    const next = TABS[t] ? t : "chat";
    setTab(next);
    if (next === "chat") setUnread(0);
    setNavOpen(false);
    if (!fromHash) {
      try {
        history.replaceState(
          null,
          "",
          location.pathname + location.search + (next === "chat" ? "" : "#" + next)
        );
      } catch {
        // history unavailable: the tab still switched
      }
    }
  };

  useEffect(() => {
    const onHash = () => show(location.hash.slice(1), true);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setNavOpen(false);
    };
    window.addEventListener("hashchange", onHash);
    document.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("hashchange", onHash);
      document.removeEventListener("keydown", onKey);
    };
  }, []);

  const applyTheme = (t: string) => {
    store("chat-theme", t);
    document.documentElement.setAttribute("data-theme", t);
    setTheme(t);
  };

  const copyLink = () => {
    const url = location.origin + location.pathname;
    try {
      navigator.clipboard.writeText(url).then(
        () => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1600);
        },
        () => toast("Couldn't copy. The link is " + url)
      );
    } catch {
      toast("The link is " + url);
    }
  };

  const viewerCloseRef = useRef<(() => void) | null>(null);
  const viewerHost = useViewerHost({ onCloseRef: viewerCloseRef });
  const gamesRef = useRef<GameStore | null>(null);
  if (!gamesRef.current) {
    gamesRef.current = createGameStore({
      client,
      meName: () => nameStateRef.current,
      openViewer: viewerHost.api.open,
    });
    viewerCloseRef.current = () => gamesRef.current?.viewerClosed();
  }
  const games = gamesRef.current;
  const push = usePush(client, toast);
  useEffect(() => {
    initShellCommon();
  }, []);
  const rx = useReactions({
    client,
    who,
    meName: nameState.value,
    getMessage: (id) => messagesRef.current.find((m) => m.id === id),
    setMessages: (fn) => setMessages(fn),
    listRef,
    denied,
  });

  const photo = usePhotoUpload({
    putAvatar: (blob) => client.putAvatar(blob),
    loadAll,
  });

  const counts = useMemo(() => {
    const chat = unread ? (unread > 99 ? "99+" : String(unread)) : "";
    const top = tab !== "chat" && unread ? String(unread) : "";
    if (boardData) {
      const active = boardData.mb.members.filter((x) => x.status === "active").map((x) => x.name);
      const dcN = boardData.dc.filter((x) => {
        const signers = x.signers || [];
        const missing = active.filter((a) => !signers.some((sg) => same(sg, a)));
        return !signers.length || missing.length > 0;
      }).length;
      const soon = boardData.sk.stakes.filter((x) => {
        const n = daysAway(x.date);
        return n !== null && n <= 30;
      }).length;
      const overdue = boardData.sk.stakes.some((x) => {
        const n = daysAway(x.date);
        return n !== null && n < 0;
      });
      return {
        chat,
        decisions: dcN ? String(dcN) : "",
        questions: boardData.q.questions.length ? String(boardData.q.questions.length) : "",
        stakes: soon ? String(soon) + (overdue ? "!" : "") : "",
        memory:
          rs && rs.memory && rs.memory.awaiting_digest_from && same(rs.memory.awaiting_digest_from, nameState.value)
            ? "Due"
            : "",
        members: boardData.mb.invite_only ? String(active.length) : "",
        top,
      };
    }
    const section = (k: "open_questions" | "decisions_awaiting_signatures" | "stakes_due") => {
      if (!rs) return "";
      const a = rs[k] as unknown[] | undefined;
      const more = (rs as unknown as Record<string, number>)[k + "_more"] || 0;
      return a ? String(a.length + more) : "";
    };
    return {
      chat,
      decisions: section("decisions_awaiting_signatures"),
      questions: section("open_questions"),
      stakes: section("stakes_due"),
      memory:
        rs && rs.memory && rs.memory.awaiting_digest_from && same(rs.memory.awaiting_digest_from, nameState.value)
          ? "Due"
          : "",
      members: members.inviteOnly ? String(members.activeCount) : "",
      top,
    };
  }, [boardData, rs, unread, members, tab, nameState.value]);

  const memberSet = useMemo(
    () => new Set([...members.names.map((n) => n.toLowerCase()), "claude"]),
    [members]
  );
  const feedCtx: FeedCtx = useMemo(
    () => ({
      memberSet,
      membersVersion,
      avatars: members.avatars,
      invite: token,
      kindOf: (n) => (members.kinds[String(n || "").toLowerCase()] as MemberKind | undefined) ?? null,
      voiceOf: (n) => members.voices[String(n || "").toLowerCase()] || null,
      meName: nameState.value,
      speaker,
      speakingId,
      rx: rx.api,
      rxTargetId: rx.targetId,
      onAvatar: (n) => setAvatarName(n),
      openViewer: viewerHost.api.open,
      games,
    }),
    [memberSet, members, membersVersion, token, nameState.value, speaker, speakingId, rx.api, rx.targetId, viewerHost.api, games]
  );

  const boardApi: BoardApi = useMemo(
    () => ({
      board: boardView,
      api: (path, method, body) => client.api(path, method, body),
      putAvatar: (blob) => client.putAvatar(blob),
      who,
      loadAll,
      meName: nameState.value,
      isMember: nameState.locked,
      editingDelta,
      openAvatar: (n) => setAvatarName(n),
      invite: token,
      rs,
    }),
    [boardView, client, who, loadAll, nameState.value, nameState.locked, editingDelta, token, rs]
  );

  const voiceRef = useRef<VoiceDialogHandle | null>(null);
  const onPosted = useCallback(
    (m: Message & { room_state?: RoomState }) => {
      if (m.room_state) applyState(m.room_state);
      addMsg(m);
      const list = listRef.current;
      if (list) list.scrollTop = list.scrollHeight;
    },
    [applyState, addMsg]
  );

  const onCommitName = useCallback((v: string) => {
    store("chat-name", v);
    setNameState((s) => ({ value: v, locked: s.locked }));
  }, []);

  const titleTab = denied ? "Invite only" : gate ? "Agent setup" : TABS[tab] || "Chat";

  return (
    <div className="app">
      <Sidebar
        room={room}
        status={status}
        inviteOnly={members.inviteOnly}
        denied={denied}
        gate={!!gate}
        tab={tab}
        show={show}
        tabsDisabled={tabsDisabled}
        counts={counts}
        theme={theme}
        applyTheme={applyTheme}
        copied={copied}
        copyLink={copyLink}
        push={push}
        voiceHidden={!token}
        onVoice={() => voiceRef.current?.open()}
        install={inst}
      />
      <div className="scrim" id="scrim" onClick={() => setNavOpen(false)}></div>

      <div className="main">
        <header className="topbar">
          <button
            type="button"
            className="btn quiet"
            id="menu"
            aria-label="Open navigation"
            aria-controls="side"
            aria-expanded={navOpen}
            onClick={() => setNavOpen(!navOpen)}
          >
            <I d={["M4 7h16M4 12h16M4 17h16"]} />
          </button>
          <div className="title" id="topTitle">
            {room} <span>· {titleTab}</span>
          </div>
          <span className={"count" + (counts.top ? " alert" : "")} id="topCount">
            {counts.top}
          </span>
          <button
            type="button"
            className={"btn quiet icon-btn pushBtn" + (push.on ? " on" : "")}
            aria-label={push.label}
            title={push.label}
            hidden={!push.visible}
            onClick={(e) => push.bellClick(e.currentTarget)}
          >
            <I d={["M18 9a6 6 0 1 0-12 0c0 6-2.5 7-2.5 7h17S18 15 18 9z", "M10 20a2.2 2.2 0 0 0 4 0"]} />
          </button>
          <span className={"topdot" + (status === "live" ? " live" : status === "locked" ? " locked" : "")} id="topDot" title={STATUS_LABEL[status]}></span>
        </header>

        <div id="pullHint" hidden>
          <span id="pullHintText">Pull to refresh</span>
        </div>

        <InstallStrip visible={inst.stripVisible} hint={inst.hint} onInstall={inst.runInstall} onDismiss={inst.dismiss} dlgRef={inst.dlgRef} />
        <UpdateStrip />

        <LockedView text={lockedText || ""} hidden={!denied} />
        <AgentGateView
          name={gate?.name ?? ""}
          block={gate?.block ?? ""}
          hidden={!gate}
          onEscape={() => {
            store("ac:agent-app:" + room, "1");
            setGate(null);
            show("chat");
          }}
        />
        <section className="view" id="view-chat" hidden={denied || gate !== null || tab !== "chat"}>
          <ChatFeed
            messages={messages}
            ctx={feedCtx}
            jumpVisible={jumpVisible}
            setJumpVisible={setJumpVisible}
            onSettleKill={endSettle}
            listRef={listRef}
            holdProps={rx.holdProps}
          />
          <Composer
            name={nameState.value}
            nameLocked={nameState.locked}
            onCommitName={onCommitName}
            client={client}
            room={room}
            onPosted={onPosted}
            memberNames={members.names}
            memberKinds={members.nameKinds}
            denied={denied}
          />
        </section>
        <BoardSections tab={denied || gate ? "" : tab} api={boardApi} photo={photo} />
      </div>
      {viewerHost.node}
      <AvatarDialog name={avatarName} mb={boardData?.mb ?? null} invite={token} onClose={() => setAvatarName(null)} />
      <VoiceDialog ref={voiceRef} client={client} hasToken={!!token} />
      {rx.popovers}
      {photo.el}
      {push.menuNode}
      <ToastHost />
    </div>
  );
}
