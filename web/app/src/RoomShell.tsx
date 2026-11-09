import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ApiError, RoomClient, type Message } from "@chat/shared";
import { onToast, store, toast } from "./lib";
import { InstallStrip, UpdateStrip, useInstall, usePullToRefresh } from "./strips";
import { AgentGateView, BoardPages, ChatView, LockedView } from "./views";

// The room shell, ported from the current app (PARITY.md M2 / section
// A): fixed layout, sidebar/drawer, top bar, identity, themes, access
// states. The message stream and board data arrive in later milestones.

const TABS: Record<string, string> = {
  chat: "Chat",
  constitution: "Constitution",
  decisions: "Decisions",
  questions: "Open questions",
  stakes: "Stakes",
  memory: "Memory",
  members: "Members",
};

function I({ d, extra }: { d: string[]; extra?: ReactNode }) {
  return (
    <svg className="i" viewBox="0 0 24 24">
      {extra}
      {d.map((p, i) => (
        <path key={i} d={p} />
      ))}
    </svg>
  );
}
const ICONS: Record<string, ReactNode> = {
  chat: <I d={["M4 5h16v11H9l-5 4z"]} />,
  constitution: <I d={["M7 3h8l4 4v14H7z", "M15 3v4h4", "M10 12h6M10 16h6"]} />,
  decisions: (
    <I
      d={["M8 12.5l2.8 2.8L16.5 9"]}
      extra={<circle cx="12" cy="12" r="9" />}
    />
  ),
  questions: (
    <I
      d={["M9.6 9.4a2.5 2.5 0 1 1 3.4 2.4c-.6.3-1 .8-1 1.5v.4", "M12 17h.01"]}
      extra={<circle cx="12" cy="12" r="9" />}
    />
  ),
  stakes: <I d={["M4 10h16M9 3v4M15 3v4"]} extra={<rect x="4" y="5" width="16" height="15" rx="2" />} />,
  memory: <I d={["M5 4.5A1.5 1.5 0 0 1 6.5 3H19v15H6.5A1.5 1.5 0 0 0 5 19.5z", "M5 19.5A1.5 1.5 0 0 0 6.5 21H19v-3"]} />,
  members: (
    <I
      d={["M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6", "M16 4.6a3.5 3.5 0 0 1 0 6.8", "M21 20c0-2.6-1.6-4.8-3.8-5.6"]}
      extra={<circle cx="9" cy="8" r="3.5" />}
    />
  ),
};

type Status = "connecting" | "live" | "locked" | "reconnecting";
const STATUS_LABEL: Record<Status, string> = {
  connecting: "Connecting…",
  live: "Live",
  locked: "Invite only",
  reconnecting: "Reconnecting…",
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
  const [you, setYou] = useState<string | null>(null);
  const [savedName, setSavedName] = useState<string>(() => store("chat-name") || "");
  const [lockedText, setLockedText] = useState<string | null>(null);
  const [gate, setGate] = useState<{ name: string; block: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const inst = useInstall();
  usePullToRefresh();

  const denied = lockedText !== null;
  const tabsDisabled = denied || gate !== null;
  const client = useMemo(() => new RoomClient(room, takeInvite(room) || null), [room]);

  useEffect(() => {
    document.title = "Chat Room";
  }, []);

  useEffect(() => {
    document.body.classList.toggle("nav-open", navOpen);
    return () => document.body.classList.remove("nav-open");
  }, [navOpen]);

  useEffect(() => {
    let live = true;
    client
      .messages()
      .then((d) => {
        if (!live) return;
        setMessages(d.messages);
        if (d.you) {
          setYou(d.you);
          store("chat-you:" + room, d.you);
        }
        setStatus("live");
        if (d.you_kind === "agent" && d.you && !store("ac:agent-app:" + room)) {
          setGate({
            name: d.you,
            block:
              d.agent_onboarding ||
              "Endpoint: POST " +
                location.origin +
                "/api/rooms/" +
                encodeURIComponent(room) +
                "/mcp\nHeader: X-Invite-Token: " +
                (store("chat-invite:" + room) || "") +
                "\nSend initialize, then tools/list for the room's tools.",
          });
        }
      })
      .catch((e: unknown) => {
        if (!live) return;
        if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
          setStatus("locked");
          const rest = String(e.message || "").replace(/^This room is invite-only\.\s*/i, "").trim();
          setLockedText(rest);
        } else {
          setStatus("reconnecting");
        }
      });
    return () => {
      live = false;
    };
  }, [client, room]);

  const show = (t: string, fromHash = false) => {
    const next = TABS[t] ? t : "chat";
    setTab(next);
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

  const displayName = you || savedName;
  const titleTab = denied ? "Invite only" : gate ? "Agent setup" : TABS[tab] || "Chat";

  const tabBtn = (id: string, label: string) => (
    <button
      type="button"
      className="tab"
      data-tab={id}
      key={id}
      disabled={tabsDisabled}
      aria-current={tab === id && !denied && !gate ? "page" : undefined}
      onClick={() => show(id)}
    >
      {ICONS[id]}
      {label}
      <span className="count" id={"c-" + id}></span>
    </button>
  );

  return (
    <div className="app">
      <aside className="side" id="side" aria-label="Room navigation">
        <a className="brand" href="/">
          <I d={["M15 6l-6 6 6 6"]} />
          All rooms
        </a>
        <div className="room-name">
          <span id="room">{room}</span>
          <svg className="i" id="lockIcon" viewBox="0 0 24 24" style={{ display: denied ? undefined : "none" }}>
            <rect x="5" y="11" width="14" height="9" rx="2" />
            <path d="M8 11V8a4 4 0 0 1 8 0v3" />
          </svg>
        </div>
        <div className={"status" + (status === "live" ? " live" : status === "locked" ? " locked" : "")} id="status">
          <span className="dot"></span>
          <span className="label">{STATUS_LABEL[status]}</span>
        </div>
        <nav className="tabs" id="tabs">
          {tabBtn("chat", "Chat")}
          <div className="nav-label">Room board</div>
          {tabBtn("constitution", "Constitution")}
          {tabBtn("decisions", "Decisions")}
          {tabBtn("questions", "Open questions")}
          {tabBtn("stakes", "Stakes")}
          {tabBtn("memory", "Memory")}
          <div className="nav-label">People</div>
          {tabBtn("members", "Members")}
        </nav>
        <div className="side-foot">
          <div className="foot-row">
            <div className="seg full" role="group" aria-label="Color theme">
              <button type="button" data-theme-set="light" aria-pressed={theme === "light"} onClick={() => applyTheme("light")}>
                <I d={["M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"]} extra={<circle cx="12" cy="12" r="4" />} />
                Light
              </button>
              <button type="button" data-theme-set="dark" aria-pressed={theme === "dark"} onClick={() => applyTheme("dark")}>
                <I d={["M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"]} />
                Dark
              </button>
            </div>
          </div>
          <div className="foot-row">
            <button type="button" className="btn sm" id="copy" onClick={copyLink}>
              <I d={["M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1", "M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"]} />
              <span>{copied ? "Link copied" : "Copy room link"}</span>
            </button>
          </div>
          <div className="foot-row">
            <button type="button" className="btn sm" id="installBtn" hidden={!inst.buttonVisible} onClick={inst.runInstall}>
              <I d={["M12 3v10m0 0l-4-4m4 4l4-4", "M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"]} />
              <span>Install app</span>
            </button>
          </div>
        </div>
      </aside>
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
          <span className="count" id="topCount"></span>
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
        <ChatView
          messages={messages}
          name={displayName}
          hidden={denied || gate !== null || tab !== "chat"}
          onName={(n) => {
            store("chat-name", n);
            setSavedName(n);
          }}
        />
        <BoardPages tab={denied || gate ? "" : tab} canInvite={!!you} />
      </div>
      <ToastHost />
    </div>
  );
}
