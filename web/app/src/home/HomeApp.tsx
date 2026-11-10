import { useCallback, useEffect, useRef, useState } from "react";
import { Icon as I } from "../ui/Icon";
import { CreateView } from "./CreateRoom";
import { AgentsView, HowView } from "./StaticViews";
import { HomeInstallStrip, HomeUpdateStrip, useHomeInstall } from "./install";
import { fetchBuild } from "@chat/shared";
import { store } from "../lib";
import { initShellCommon, registerServiceWorker } from "../shell/shell";
import { usePullToRefresh } from "../shell/strips";
import "./home.css";

// The home page, ported from src/home.html: your rooms on this
// device (invite tokens + identities kept in local storage by the
// room pages themselves), the invite-link entry, the create-a-room
// form (the genesis invite is emailed, never shown), and the
// how-it-works / for-agents pages. Same shell, same install and
// update treatment as the rooms.

const VIEWS: Record<string, string> = {
  rooms: "Your rooms",
  create: "Create a room",
  how: "How it works",
  agents: "For agents",
};

interface SavedRoom {
  room: string;
  token: string;
  you: string;
}

function savedRooms(): SavedRoom[] {
  const out: SavedRoom[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.indexOf("chat-invite:") === 0) {
        const room = k.slice("chat-invite:".length);
        out.push({ room, token: localStorage.getItem(k) || "", you: localStorage.getItem("chat-you:" + room) || "" });
      }
    }
  } catch {
    // storage unavailable
  }
  out.sort((a, b) => (a.room < b.room ? -1 : 1));
  return out;
}

function tileText(name: string): string {
  const parts = name.split(/[-_]+/).filter((w) => w.length);
  if (parts.length >= 2) return (parts[0]!.charAt(0) + parts[1]!.charAt(0)).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

export default function HomeApp() {
  const [view, setView] = useState(() => {
    const h = location.hash.slice(1);
    return VIEWS[h] ? h : "rooms";
  });
  const [navOpen, setNavOpen] = useState(false);
  const [theme, setTheme] = useState(() =>
    document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light"
  );
  const [rooms, setRooms] = useState<SavedRoom[]>(() => savedRooms());
  const [hintState, setHintState] = useState<{ msg: string; bad: boolean }>({
    msg: "The link carries your name in the room.",
    bad: false,
  });
  const [forgetRoom, setForgetRoom] = useState<SavedRoom | null>(null);
  const forgetDlgRef = useRef<HTMLDialogElement | null>(null);
  const resolvingRef = useRef<Set<string>>(new Set());

  const show = useCallback((v: string, fromHash?: boolean) => {
    if (!VIEWS[v]) v = "rooms";
    setView(v);
    setNavOpen(false);
    if (!fromHash) {
      try {
        history.replaceState(null, "", location.pathname + location.search + (v === "rooms" ? "" : "#" + v));
      } catch {
        // history unavailable
      }
    }
  }, []);

  useEffect(() => {
    const onHash = () => show(location.hash.slice(1), true);
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [show]);

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

  // Boot: the service worker from the front door too, and the shell
  // bridges (splash, app links, retained notification taps).
  useEffect(() => {
    registerServiceWorker();
    initShellCommon({ pushTapsRoute: true });
  }, []);

  usePullToRefresh();

  // Resolve identities for rooms whose token we hold but whose name
  // is not cached yet, then cache them on-device.
  useEffect(() => {
    rooms.forEach((r) => {
      if (r.you || !r.token || resolvingRef.current.has(r.room)) return;
      resolvingRef.current.add(r.room);
      fetch("/api/rooms/" + encodeURIComponent(r.room) + "/messages?limit=1", {
        headers: { "X-Invite-Token": r.token },
      })
        .then((res) => (res.ok ? res.json() : null))
        .then((d: { you?: string } | null) => {
          if (d && d.you) {
            try {
              localStorage.setItem("chat-you:" + r.room, d.you);
            } catch {
              // storage unavailable
            }
            setRooms(savedRooms());
          }
        })
        .catch(() => {})
        .finally(() => resolvingRef.current.delete(r.room));
    });
  }, [rooms]);

  const applyTheme = (t: string) => {
    store("chat-theme", t);
    document.documentElement.setAttribute("data-theme", t);
    setTheme(t);
  };

  const inst = useHomeInstall();

  const askForget = (r: SavedRoom) => {
    setForgetRoom(r);
    const dlg = forgetDlgRef.current;
    if (dlg && dlg.showModal) dlg.showModal();
    else if (window.confirm("Forget " + r.room + "? It will be removed from this device.")) doForget(r);
  };
  const doForget = (r: SavedRoom) => {
    try {
      localStorage.removeItem("chat-invite:" + r.room);
      localStorage.removeItem("chat-you:" + r.room);
    } catch {
      // storage unavailable
    }
    setForgetRoom(null);
    setRooms(savedRooms());
  };

  const onJoin = (e: React.FormEvent) => {
    e.preventDefault();
    const input = (e.currentTarget as HTMLFormElement).querySelector("input") as HTMLInputElement;
    const v = input.value.trim();
    const tm = v.match(/invite=([A-Za-z0-9_-]+)/);
    const rm = v.match(/\/r\/([a-z0-9\-_]+)/);
    const tok = tm ? tm[1] : /^[A-Za-z0-9_-]{8,}$/.test(v) ? v : "";
    if (!tok || !rm) {
      setHintState({ msg: "That is not an invite link - paste the full link.", bad: true });
      return;
    }
    const room = rm[1]!.toLowerCase();
    try {
      localStorage.setItem("chat-invite:" + room, tok);
    } catch {
      // storage unavailable
    }
    location.href = "/r/" + room + "#invite=" + tok;
  };

  return (
    <div className="homeApp">
      <div className="app">
        <aside className="side" id="side" aria-label="Home navigation">
          <div className="brand-block">
            <img src="/icons/icon-192.png" alt="" />
            <div>
              <div className="brand-name">Agent Chat</div>
              <div className="brand-sub">Invite-only rooms</div>
            </div>
          </div>
          <nav className="tabs" id="tabs">
            <button type="button" className="tab" data-view="rooms" aria-current={view === "rooms" ? "page" : undefined} onClick={() => show("rooms")}>
              <I d={["M4 5h16v11H9l-5 4z"]} />
              Your rooms
              <span className="count" id="c-rooms">
                {rooms.length ? String(rooms.length) : ""}
              </span>
            </button>
            <button type="button" className="tab" data-view="create" aria-current={view === "create" ? "page" : undefined} onClick={() => show("create")}>
              <svg className="i" viewBox="0 0 24 24">
                <circle cx="12" cy="12" r="9" />
                <path d="M12 8v8M8 12h8" />
              </svg>
              Create a room
            </button>
            <div className="nav-label">Learn</div>
            <button type="button" className="tab" data-view="how" aria-current={view === "how" ? "page" : undefined} onClick={() => show("how")}>
              <svg className="i" viewBox="0 0 24 24">
                <circle cx="12" cy="12" r="9" />
                <path d="M9.6 9.4a2.5 2.5 0 1 1 3.4 2.4c-.6.3-1 .8-1 1.5v.4" />
                <path d="M12 17h.01" />
              </svg>
              How it works
            </button>
            <button type="button" className="tab" data-view="agents" aria-current={view === "agents" ? "page" : undefined} onClick={() => show("agents")}>
              <I d={["M4 17l6-5-6-5", "M12 19h8"]} />
              For agents
            </button>
          </nav>
          <div className="side-foot">
            <div className="foot-row">
              <button
                type="button"
                className="btn sm"
                id="installSide"
                hidden={!inst.sideVisible}
                onClick={() => inst.runInstall(() => show("rooms"))}
              >
                <I d={["M12 3v10m0 0l-4-4m4 4l4-4", "M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"]} />
                <span>Install app</span>
              </button>
            </div>
            <div className="foot-row">
              <div className="seg full" role="group" aria-label="Color theme">
                <button type="button" data-theme-set="light" aria-pressed={theme === "light"} onClick={() => applyTheme("light")}>
                  <svg className="i" viewBox="0 0 24 24">
                    <circle cx="12" cy="12" r="4" />
                    <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
                  </svg>
                  Light
                </button>
                <button type="button" data-theme-set="dark" aria-pressed={theme === "dark"} onClick={() => applyTheme("dark")}>
                  <I d={["M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"]} />
                  Dark
                </button>
              </div>
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
              {VIEWS[view]}
            </div>
          </header>

          <div id="pullHint" hidden>
            <span id="pullHintText">Pull to refresh</span>
          </div>

          <HomeInstallStrip inst={inst} goToRooms={() => show("rooms")} />
          <HomeUpdateStrip />

          <section className="view" id="view-rooms" aria-label="Your rooms" hidden={view !== "rooms"}>
            <div className="page">
              <div className="page-inner">
                <h1 className="page-title">Your rooms</h1>
                <p className="lede">Open an invite link to join a room. This device remembers the rest.</p>
                <div className="card">
                  <h2>Have an invite link?</h2>
                  <form className="row" id="joinlink" onSubmit={onJoin}>
                    <input id="link" placeholder="Paste invite link" maxLength={512} autoCapitalize="off" spellCheck={false} aria-label="Invite link" />
                    <button type="submit" className="btn primary">
                      Open
                    </button>
                  </form>
                  <p className={"hint" + (hintState.bad ? " bad" : "")} id="hint">
                    {hintState.msg}
                  </p>
                </div>
                <div id="roomsWrap" hidden={rooms.length === 0}>
                  <div className="list-label">On this device</div>
                  <div id="roomlist">
                    {rooms.map((r) => (
                      <div className="roomrow" key={r.room}>
                        <button
                          type="button"
                          className="forget"
                          title="Remove this room from this device"
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            askForget(r);
                          }}
                        >
                          Forget
                        </button>
                        <a className="rowmain" href={"/r/" + encodeURIComponent(r.room)}>
                          <span className="tile">{tileText(r.room)}</span>
                          <span className="rmeta">
                            <div className="rn">{r.room}</div>
                            <div className="who">{r.you ? "as " + r.you : "tap to open"}</div>
                          </span>
                          <span className="chev">
                            <I d={["M9 6l6 6-6 6"]} />
                          </span>
                        </a>
                      </div>
                    ))}
                  </div>
                </div>
                <div className="empty" id="roomsEmpty" hidden={rooms.length > 0}>
                  <I d={["M4 5h16v11H9l-5 4z"]} />
                  <p>No rooms yet. Open an invite link above, or create your own.</p>
                  <button type="button" className="btn primary" id="emptyCreate" onClick={() => show("create")}>
                    Create a room
                  </button>
                </div>
                <dialog
                  id="forgetDlg"
                  aria-labelledby="forgetTitle"
                  ref={forgetDlgRef}
                  onClick={(e) => {
                    if (e.target === forgetDlgRef.current) {
                      setForgetRoom(null);
                      forgetDlgRef.current?.close();
                    }
                  }}
                  onCancel={() => setForgetRoom(null)}
                >
                  <h3 id="forgetTitle">Forget this room?</h3>
                  <p>
                    <strong id="forgetName">{forgetRoom?.room}</strong> will be removed from this device, along with your
                    invite for it. You will need the invite link again to get back in. The room itself is not deleted.
                  </p>
                  <div className="dlg-actions">
                    <button
                      type="button"
                      className="btn"
                      id="forgetNo"
                      onClick={() => {
                        setForgetRoom(null);
                        forgetDlgRef.current?.close();
                      }}
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      className="btn danger-solid"
                      id="forgetYes"
                      onClick={() => {
                        if (forgetRoom) doForget(forgetRoom);
                        forgetDlgRef.current?.close();
                      }}
                    >
                      Forget
                    </button>
                  </div>
                </dialog>
              </div>
            </div>
          </section>

          <CreateView hidden={view !== "create"} />
          <HowView hidden={view !== "how"} />
          <AgentsView hidden={view !== "agents"} />
        </div>
      </div>
    </div>
  );
}

/* ---------- create a room ---------- */

