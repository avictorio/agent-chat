import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Icon as I } from "../ui/Icon";
import {
  ApiError,
  RoomClient,
  type MemberKind,
  type Message,
} from "@chat/shared";
import { onToast, same, store, toast } from "../lib";
import { InstallStrip, UpdateStrip, useInstall, usePullToRefresh } from "../shell/strips";
import { ToastHost } from "../shell/ToastHost";
import { AgentGateView, LockedView } from "./views";
import { TABS, useTabs } from "./useTabs";
import { useMessages } from "../feed/useMessages";
import { useBoardData } from "../board/useBoardData";
import { useRoomStream } from "./useRoomStream";
import { Sidebar, STATUS_LABEL, type Status } from "./Sidebar";
import {
  BoardApiContext,
  FeedContext,
  MembersContext,
  SessionContext,
  type FeedValue,
  type MembersValue,
  type SessionValue,
} from "./ctx";
import { ChatFeed, atBottom } from "../feed/feed";
import { Composer } from "../composer/composer";
import { Speaker } from "./speak";
import { BoardSections } from "../board/board";
import { GamesView } from "../games/GamesView";
import type { BoardApi } from "../board/shared";
import { AvatarDialog, usePhotoUpload } from "../board/avatar";
import { useViewerHost } from "../shell/viewer";
import { VoiceDialog, type VoiceDialogHandle } from "./voice";
import { NewGameDialog, type NewGameDialogHandle } from "../games/NewGameDialog";
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

export function RoomShell({ room }: { room: string }) {
  const clearUnreadRef = useRef<() => void>(() => {});
  const tabs = useTabs({ onChat: () => clearUnreadRef.current() });
  const { tab, tabRef } = tabs;
  const show = (t: string, fromHash = false) => {
    setNavOpen(false);
    tabs.show(t, fromHash);
  };
  const [navOpen, setNavOpen] = useState(false);
  const [theme, setTheme] = useState<string>(
    () => document.documentElement.getAttribute("data-theme") || "light"
  );
  const [status, setStatus] = useState<Status>("connecting");
  const [speakingId, setSpeakingId] = useState<number | null>(null);
  const [nameState, setNameState] = useState<{ value: string; locked: boolean }>(() => ({
    value: store("chat-you:" + room) || store("chat-name") || "",
    locked: !!store("chat-you:" + room),
  }));
  const nameStateRef = useRef(nameState.value);
  nameStateRef.current = nameState.value;
  const [lockedText, setLockedText] = useState<string | null>(null);
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

  const nameRef = useRef(nameState.value);
  nameRef.current = nameState.value;
  const deniedRef = useRef(false);
  const streamCloseRef = useRef<() => void>(() => {});

  useEffect(() => {
    document.title = room + " · chat";
  }, [room]);

  useEffect(() => {
    document.body.classList.toggle("nav-open", navOpen);
    return () => document.body.classList.remove("nav-open");
  }, [navOpen]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setNavOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const deny = useCallback((e: ApiError) => {
    deniedRef.current = true;
    setStatus("locked");
    setLockedText(String(e.message || "").replace(/^This room is invite-only\.\s*/i, "").trim());
    streamCloseRef.current();
  }, []);
  const board = useBoardData({ client, tabRef, deny, deniedRef });

  const feed = useMessages({ tabRef, nameRef, applyState: board.applyState });
  clearUnreadRef.current = feed.clearUnread;
  const { messages, unread, jumpVisible, setJumpVisible, listRef } = feed;

  const speakerRef = useRef<Speaker | null>(null);
  if (!speakerRef.current) {
    speakerRef.current = new Speaker({
      room,
      invite: token,
      voiceOf: (n) => board.voicesRef.current[String(n || "").toLowerCase()] || null,
    });
    speakerRef.current.onChange = (id) => setSpeakingId(id);
  }
  const speaker = speakerRef.current;

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
    getMessage: (id) => feed.messagesRef.current.find((m) => m.id === id),
    setMessages: (fn) => feed.setMessages(fn),
    listRef,
    denied,
  });

  const photo = usePhotoUpload({
    putAvatar: (blob) => client.putAvatar(blob),
    loadAll: board.loadAll,
  });

  useRoomStream({
    client,
    room,
    token,
    feed,
    board,
    gamesRef,
    speaker,
    setStatus,
    onYou: (you) => {
      setNameState({ value: you, locked: true });
      store("chat-you:" + room, you);
    },
    onAgentGate: (g) => setGate(g),
    deny,
    deniedRef,
    closeRef: streamCloseRef,
  });

  const counts = useMemo(() => {
    const chat = unread ? (unread > 99 ? "99+" : String(unread)) : "";
    const top = tab !== "chat" && unread ? String(unread) : "";
    if (board.boardData) {
      const active = board.boardData.mb.members.filter((x) => x.status === "active").map((x) => x.name);
      const dcN = board.boardData.dc.filter((x) => {
        const signers = x.signers || [];
        const missing = active.filter((a) => !signers.some((sg) => same(sg, a)));
        return !active.length || missing.length > 0;
      }).length;
      const soon = board.boardData.sk.stakes.filter((x) => {
        const n = daysAway(x.date);
        return n !== null && n <= 7;
      }).length;
      return {
        chat,
        decisions: dcN ? String(dcN) : "",
        questions: board.boardData.q.questions.length ? String(board.boardData.q.questions.length) : "",
        stakes: soon ? String(soon) : "",
        memory:
          board.rs && board.rs.memory && board.rs.memory.awaiting_digest_from && same(board.rs.memory.awaiting_digest_from, nameState.value)
            ? "Due"
            : "",
        members: board.boardData.mb.invite_only ? String(active.length) : "",
        top,
      };
    }
    const section = (k: "open_questions" | "decisions_awaiting_signatures" | "stakes_due") => {
      if (!board.rs) return "";
      const a = board.rs[k] as unknown[] | undefined;
      const more = (board.rs as unknown as Record<string, number>)[k + "_more"] || 0;
      return a ? String(a.length + more) : "";
    };
    return {
      chat,
      decisions: section("decisions_awaiting_signatures"),
      questions: section("open_questions"),
      stakes: section("stakes_due"),
      memory:
        board.rs && board.rs.memory && board.rs.memory.awaiting_digest_from && same(board.rs.memory.awaiting_digest_from, nameState.value)
          ? "Due"
          : "",
      members: board.members.inviteOnly ? String(board.members.activeCount) : "",
      top,
    };
  }, [board.boardData, board.rs, unread, board.members, tab, nameState.value]);

  const memberSet = useMemo(
    () => new Set([...board.members.names.map((n) => n.toLowerCase()), "claude"]),
    [board.members]
  );
  // Context values (room/ctx.tsx): session, members, feed. Each is
  // memoized on its own inputs so consumers re-render with the
  // slice they read, not with every shell state change.
  const sessionValue: SessionValue = useMemo(
    () => ({
      client,
      room,
      token,
      meName: nameState.value,
      nameLocked: nameState.locked,
      status,
    }),
    [client, room, token, nameState, status]
  );
  const membersValue: MembersValue = useMemo(
    () => ({
      names: board.members.names,
      kinds: board.members.kinds,
      nameKinds: board.members.nameKinds,
      voices: board.members.voices,
      avatars: board.members.avatars,
      inviteOnly: board.members.inviteOnly,
      memberSet,
      membersVersion: board.membersVersion,
      kindOf: (n) => (board.members.kinds[String(n || "").toLowerCase()] as MemberKind | undefined) ?? null,
      voiceOf: (n) => board.members.voices[String(n || "").toLowerCase()] || null,
    }),
    [board.members, memberSet, board.membersVersion]
  );
  const feedValue: FeedValue = useMemo(
    () => ({
      speaker,
      speakingId,
      rx: rx.api,
      rxTargetId: rx.targetId,
      onAvatar: (n) => setAvatarName(n),
      openViewer: viewerHost.api.open,
      games,
    }),
    [speaker, speakingId, rx.api, rx.targetId, viewerHost.api, games]
  );

  const boardApi: BoardApi = useMemo(
    () => ({
      board: board.boardView,
      api: (path, method, body) => client.api(path, method, body),
      putAvatar: (blob) => client.putAvatar(blob),
      who,
      loadAll: board.loadAll,
      meName: nameState.value,
      isMember: nameState.locked,
      editingDelta: board.editingDelta,
      openAvatar: (n) => setAvatarName(n),
      invite: token,
      rs: board.rs,
    }),
    [board.boardView, client, who, board.loadAll, nameState.value, nameState.locked, board.editingDelta, token, board.rs]
  );

  const voiceRef = useRef<VoiceDialogHandle | null>(null);
  const newGameRef = useRef<NewGameDialogHandle | null>(null);

  const onCommitName = useCallback((v: string) => {
    store("chat-name", v);
    setNameState((s) => ({ value: v, locked: s.locked }));
  }, []);

  const titleTab = denied ? "Invite only" : gate ? "Agent setup" : TABS[tab] || "Chat";

  return (
    <SessionContext.Provider value={sessionValue}>
    <MembersContext.Provider value={membersValue}>
    <FeedContext.Provider value={feedValue}>
    <BoardApiContext.Provider value={boardApi}>
    <div className="app">
      <Sidebar
        room={room}
        status={status}
        inviteOnly={board.members.inviteOnly}
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
            jumpVisible={jumpVisible}
            setJumpVisible={setJumpVisible}
            onSettleKill={feed.endSettle}
            listRef={listRef}
            holdProps={rx.holdProps}
          />
          <Composer onCommitName={onCommitName} onPosted={feed.onPosted} denied={denied} />
        </section>
        <section className="view" id="view-games" hidden={denied || gate !== null || tab !== "games"}>
          <GamesView
            active={!denied && !gate && tab === "games"}
            onNewGame={() => {
              setNavOpen(false);
              newGameRef.current?.open();
            }}
          />
        </section>
        <BoardSections tab={denied || gate ? "" : tab} photo={photo} />
      </div>
      {viewerHost.node}
      <AvatarDialog name={avatarName} mb={board.boardData?.mb ?? null} invite={token} onClose={() => setAvatarName(null)} />
      <VoiceDialog ref={voiceRef} />
      <NewGameDialog ref={newGameRef} />
      {rx.popovers}
      {photo.el}
      {push.menuNode}
      <ToastHost />
    </div>
    </BoardApiContext.Provider>
    </FeedContext.Provider>
    </MembersContext.Provider>
    </SessionContext.Provider>
  );
}
