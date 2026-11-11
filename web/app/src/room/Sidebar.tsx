import type { ReactNode } from "react";
import { Icon as I } from "../ui/Icon";

// The room sidebar: brand, room name + lock, connection status,
// the tab list with its counts, and the foot rows (theme, copy
// link, notifications, your voice, install). Presentational —
// RoomShell owns the state and passes it down.

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

export type Status = "connecting" | "live" | "locked" | "reconnecting";
export const STATUS_LABEL: Record<Status, string> = {
  connecting: "Connecting…",
  live: "Live",
  locked: "Invite only",
  reconnecting: "Reconnecting…",
};

export interface SidebarProps {
  room: string;
  status: Status;
  inviteOnly: boolean;
  denied: boolean;
  gate: boolean;
  tab: string;
  show: (id: string) => void;
  tabsDisabled: boolean;
  counts: { chat: string; decisions: string; questions: string; stakes: string; memory: string; members: string };
  theme: string;
  applyTheme: (t: "light" | "dark") => void;
  copied: boolean;
  copyLink: () => void;
  push: { visible: boolean; on: boolean; label: string; bellClick: (btn: HTMLButtonElement) => void };
  voiceHidden: boolean;
  onVoice: () => void;
  onNewGame: () => void;
  install: { buttonVisible: boolean; runInstall: () => void };
}

export function Sidebar(p: SidebarProps) {
  const { counts } = p;
  const countFor = (id: string): { text: string; alert: boolean } => {
    switch (id) {
      case "chat":
        return { text: counts.chat, alert: !!counts.chat };
      case "decisions":
        return { text: counts.decisions, alert: !!counts.decisions };
      case "questions":
        return { text: counts.questions, alert: false };
      case "stakes":
        return { text: counts.stakes, alert: !!counts.stakes };
      case "memory":
        return { text: counts.memory, alert: !!counts.memory };
      case "members":
        return { text: counts.members, alert: false };
      default:
        return { text: "", alert: false };
    }
  };

  const tabBtn = (id: string, label: string) => {
    const c = countFor(id);
    return (
      <button
        type="button"
        className="tab"
        data-tab={id}
        key={id}
        disabled={p.tabsDisabled}
        aria-current={p.tab === id && !p.denied && !p.gate ? "page" : undefined}
        onClick={() => p.show(id)}
      >
        {ICONS[id]}
        {label}
        <span className={"count" + (c.alert ? " alert" : "")} id={"c-" + id}>
          {c.text}
        </span>
      </button>
    );
  };
  return (
      <aside className="side" id="side" aria-label="Room navigation">
        <a className="brand" href="/">
          <I d={["M15 6l-6 6 6 6"]} />
          All rooms
        </a>
        <div className="room-name">
          <span id="room">{p.room}</span>
          <svg
            className="i"
            id="lockIcon"
            viewBox="0 0 24 24"
            style={{ display: p.denied || p.inviteOnly ? undefined : "none" }}
          >
            <rect x="5" y="11" width="14" height="9" rx="2" />
            <path d="M8 11V8a4 4 0 0 1 8 0v3" />
          </svg>
        </div>
        <div className={"status" + (p.status === "live" ? " live" : p.status === "locked" ? " locked" : "")} id="status">
          <span className="dot"></span>
          <span className="label">{STATUS_LABEL[p.status]}</span>
        </div>
        <nav className="tabs" id="tabs">
          {tabBtn("chat", "Chat")}
          {tabBtn("games", "Games")}
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
            <button type="button" className="btn sm" id="newGameBtn" hidden={p.denied || p.gate} onClick={p.onNewGame}>
              <I d={["M12 5v14M5 12h14"]} extra={<circle cx="12" cy="12" r="9" />} />
              <span>New game</span>
            </button>
          </div>
          <div className="foot-row">
            <div className="seg full" role="group" aria-label="Color theme">
              <button type="button" data-theme-set="light" aria-pressed={p.theme === "light"} onClick={() => p.applyTheme("light")}>
                <I d={["M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"]} extra={<circle cx="12" cy="12" r="4" />} />
                Light
              </button>
              <button type="button" data-theme-set="dark" aria-pressed={p.theme === "dark"} onClick={() => p.applyTheme("dark")}>
                <I d={["M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"]} />
                Dark
              </button>
            </div>
          </div>
          <div className="foot-row">
            <button type="button" className="btn sm" id="copy" onClick={p.copyLink}>
              <I d={["M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1", "M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"]} />
              <span>{p.copied ? "Link copied" : "Copy room link"}</span>
            </button>
          </div>
          <div className="foot-row">
            <button
              type="button"
              className={"btn sm pushBtn" + (p.push.on ? " on" : "")}
              hidden={!p.push.visible}
              title={p.push.label}
              aria-label={p.push.label}
              onClick={(e) => p.push.bellClick(e.currentTarget)}
            >
              <I d={["M18 9a6 6 0 1 0-12 0c0 6-2.5 7-2.5 7h17S18 15 18 9z", "M10 20a2.2 2.2 0 0 0 4 0"]} />
              <span className="pushLabel">{p.push.label}</span>
            </button>
          </div>
          <div className="foot-row">
            <button type="button" className="btn sm" id="voiceBtn" hidden={p.voiceHidden} onClick={p.onVoice}>
              <I d={["M12 3a3 3 0 0 1 3 3v5a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3z", "M5 11a7 7 0 0 0 14 0", "M12 18v3"]} />
              <span>Your voice</span>
            </button>
          </div>
          <div className="foot-row">
            <button type="button" className="btn sm" id="installBtn" hidden={!p.install.buttonVisible} onClick={p.install.runInstall}>
              <I d={["M12 3v10m0 0l-4-4m4 4l4-4", "M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"]} />
              <span>Install app</span>
            </button>
          </div>
        </div>
      </aside>
  );
}
