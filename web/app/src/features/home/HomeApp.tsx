import { flushSync } from "react-dom";
import { useCallback, useEffect, useRef, useState } from "react";
import { Icon as I } from "../../ui/Icon";
import { CreateView } from "./CreateRoom";
import { AgentKeysView } from "./AgentKeys";
import { AgentsView, HowView } from "./StaticViews";
import { HomeInstallStrip, HomeUpdateStrip, useHomeInstall } from "./install";
import { forgetRoomKeys, store, storeInvite } from "../../lib/index";
import { registerServiceWorker } from "../shell/shell";
import { forgetRoomPush } from "../shell/push";
import { usePullToRefresh } from "../shell/strips";
import "./home.css";
import { Button } from "../../ui/Button";
import { Count, NavTab } from "../../ui/Nav";
import { Page } from "../../ui/Page";
import { Card } from "../../ui/Card";
import { ErrorBoundary } from "../../ui/ErrorBoundary";
import { ToastHost } from "../shell/ToastHost";
import { RoomClient } from "@chat/contract";

// The home page: your rooms on this device (invite tokens + identities
// kept in local storage by the room pages themselves), the invite-link
// entry, the create-a-room form (the genesis invite is emailed, never shown), the
// Agent keys view (a key for an agent, made from this device's rooms; it is
// rendered only while shown, so leaving it drops any key it held), and the
// how-it-works / for-agents pages. Same shell, same install and
// update treatment as the rooms.

const VIEWS: Record<string, string> = {
  rooms: "Your rooms",
  create: "Create a room",
  keys: "Agent keys",
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
  // Forget waits on the room's server (notifications off for this
  // device); its failure is shown in the dialog
  const [forgetBusy, setForgetBusy] = useState(false);
  const [forgetErr, setForgetErr] = useState("");
  const forgetDlgRef = useRef<HTMLDialogElement | null>(null);
  const askedRef = useRef<Set<string>>(new Set());

  const show = useCallback((v: string, fromHash?: boolean) => {
    if (!VIEWS[v]) v = "rooms";
    // at once: leaving Agent keys takes any key it held out of the page's memory and DOM in this same task
    flushSync(() => setView(v));
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

  // Boot: the service worker from the front door too.
  useEffect(() => {
    registerServiceWorker();
  }, []);

  usePullToRefresh();

  // Resolve identities for rooms whose token we hold but whose name
  // is not cached yet, then cache them on-device. The look (GET /invite)
  // gives the name and opens nothing: a read of the room would open an
  // agent's unused invite before its person chose at the room's gate.
  // Each room is asked once per page load: this effect can run again for
  // a rooms list read before a name just stored was in it, and a room
  // taken out of the set on its answer would be asked a second time.
  useEffect(() => {
    rooms.forEach((r) => {
      if (r.you || !r.token || askedRef.current.has(r.room)) return;
      askedRef.current.add(r.room);
      new RoomClient(r.room, r.token)
        .invitePreview()
        .then((pv) => {
          if (pv.invite && pv.invite.name) {
            store("chat-you:" + r.room, pv.invite.name);
            setRooms(savedRooms());
          }
        })
        .catch(() => {
          // refused or unreachable: the row says "tap to open"
        });
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
    setForgetErr("");
    const dlg = forgetDlgRef.current;
    if (dlg && dlg.showModal) dlg.showModal();
    else if (window.confirm("Forget " + r.room + "? It will be removed from this device.")) {
      // no dialog to show the failure in: ask the same question it would.
      // This path used to skip the unsubscribe, so the room went on
      // notifying the device.
      void doForget(r, false).then((err) => {
        if (
          err &&
          window.confirm(
            "Couldn't turn off this room's notifications on this device. Forget it anyway? They then keep coming until you block notifications for this site."
          )
        )
          void doForget(r, true);
      });
    }
  };
  const closeForget = () => {
    setForgetRoom(null);
    setForgetErr("");
    forgetDlgRef.current?.close();
  };
  // Notifications go off first, while the invite the server asks for is
  // still here; once it is deleted nothing on this device can stop them.
  // If that fails the room stays, unless the person chose Forget anyway.
  // Resolves to the failure's text, or "" once the room is forgotten.
  const doForget = async (r: SavedRoom, anyway: boolean): Promise<string> => {
    if (!anyway) {
      // The bell's saved mode goes before the server call, as bell Off
      // does: a tab with this room open re-registers it quietly when its
      // status check hears "not registered" and still finds a mode. Deleted
      // after the unsubscribe, the mode let that tab sign the device up
      // again, and notifications kept coming after Forget. It comes back if
      // the server refuses and the room stays.
      const modeKey = "chat-push-mode:/api/rooms/" + r.room;
      let saved: string | null = null;
      try {
        saved = localStorage.getItem(modeKey);
        localStorage.removeItem(modeKey);
      } catch {
        // storage unavailable
      }
      setForgetBusy(true);
      try {
        await forgetRoomPush(r.room, r.token);
      } catch (e) {
        try {
          if (saved) localStorage.setItem(modeKey, saved);
        } catch {
          // storage unavailable
        }
        const err =
          (forgetErr ? "Still couldn't" : "Couldn't") +
          " turn off this room's notifications on this device (" +
          (e instanceof Error ? e.message : String(e)) +
          "). Try again, or forget it anyway: they then keep coming until you block notifications for this site.";
        setForgetErr(err);
        return err;
      } finally {
        setForgetBusy(false);
      }
    }
    // everything the device kept for the room
    forgetRoomKeys(r.room);
    closeForget();
    setRooms(savedRooms());
    return "";
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
    storeInvite(room, tok);
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
            <NavTab data-view="rooms" current={view === "rooms"} onClick={() => show("rooms")}>
              <I d={["M4 5h16v11H9l-5 4z"]} />
              Your rooms
              <Count id="c-rooms">{rooms.length ? String(rooms.length) : ""}</Count>
            </NavTab>
            <NavTab data-view="create" current={view === "create"} onClick={() => show("create")}>
              <svg className="i" viewBox="0 0 24 24">
                <circle cx="12" cy="12" r="9" />
                <path d="M12 8v8M8 12h8" />
              </svg>
              Create a room
            </NavTab>
            <NavTab data-view="keys" current={view === "keys"} onClick={() => show("keys")}>
              <svg className="i" viewBox="0 0 24 24">
                <circle cx="8" cy="15" r="4" />
                <path d="M10.8 12.2L19 4M15.5 7.5l2 2M13.5 9.5l2 2" />
              </svg>
              Agent keys
            </NavTab>
            <div className="nav-label">Learn</div>
            <NavTab data-view="how" current={view === "how"} onClick={() => show("how")}>
              <svg className="i" viewBox="0 0 24 24">
                <circle cx="12" cy="12" r="9" />
                <path d="M9.6 9.4a2.5 2.5 0 1 1 3.4 2.4c-.6.3-1 .8-1 1.5v.4" />
                <path d="M12 17h.01" />
              </svg>
              How it works
            </NavTab>
            <NavTab data-view="agents" current={view === "agents"} onClick={() => show("agents")}>
              <I d={["M4 17l6-5-6-5", "M12 19h8"]} />
              For agents
            </NavTab>
          </nav>
          <div className="side-foot">
            <div className="foot-row">
              <Button
                type="button"
                size="sm"
                id="installSide"
                hidden={!inst.sideVisible}
                onClick={() => inst.runInstall(() => show("rooms"))}
              >
                <I d={["M12 3v10m0 0l-4-4m4 4l4-4", "M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"]} />
                <span>Install app</span>
              </Button>
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
            <Button
              type="button"
              variant="quiet"
              id="menu"
              aria-label="Open navigation"
              aria-controls="side"
              aria-expanded={navOpen}
              onClick={() => setNavOpen(!navOpen)}
            >
              <I d={["M4 7h16M4 12h16M4 17h16"]} />
            </Button>
            <div className="title" id="topTitle">
              {VIEWS[view]}
            </div>
          </header>

          <div id="pullHint" hidden>
            <span id="pullHintText">Pull to refresh</span>
          </div>

          <HomeInstallStrip inst={inst} goToRooms={() => show("rooms")} />
          <HomeUpdateStrip />

          <Page id="view-rooms" aria-label="Your rooms" hidden={view !== "rooms"}>
            <h1 className="page-title">Your rooms</h1>
            <p className="lede">Open an invite link to join a room. This device remembers the rest.</p>
            <Card>
              <h2>Have an invite link?</h2>
              <form className="row" id="joinlink" onSubmit={onJoin}>
                <input id="link" placeholder="Paste invite link" maxLength={512} autoCapitalize="off" spellCheck={false} aria-label="Invite link" />
                <Button type="submit" variant="primary">
                  Open
                </Button>
              </form>
              <p className={"hint" + (hintState.bad ? " bad" : "")} id="hint">
                {hintState.msg}
              </p>
            </Card>
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
              <Button type="button" variant="primary" id="emptyCreate" onClick={() => show("create")}>
                Create a room
              </Button>
            </div>
            <dialog
              id="forgetDlg"
              aria-labelledby="forgetTitle"
              ref={forgetDlgRef}
              onClick={(e) => {
                if (e.target === forgetDlgRef.current && !forgetBusy) closeForget();
              }}
              onCancel={() => {
                setForgetRoom(null);
                setForgetErr("");
              }}
            >
              <h3 id="forgetTitle">Forget this room?</h3>
              <p>
                <strong id="forgetName">{forgetRoom?.room}</strong> will be removed from this device, along with your
                invite for it. You will need the invite link again to get back in. The room itself is not deleted.
              </p>
              {forgetErr ? (
                <p className="forget-err" id="forgetErr" role="alert">
                  {forgetErr}
                </p>
              ) : null}
              <div className="dlg-actions">
                <Button type="button" id="forgetNo" disabled={forgetBusy} onClick={closeForget}>
                  Cancel
                </Button>
                {forgetErr ? (
                  <Button
                    type="button"
                    id="forgetRetry"
                    disabled={forgetBusy}
                    onClick={() => {
                      if (forgetRoom) void doForget(forgetRoom, false);
                    }}
                  >
                    {forgetBusy ? "Trying…" : "Try again"}
                  </Button>
                ) : null}
                <Button
                  type="button"
                  className="danger-solid"
                  id="forgetYes"
                  disabled={forgetBusy}
                  onClick={() => {
                    if (forgetRoom) void doForget(forgetRoom, !!forgetErr);
                  }}
                >
                  {forgetErr ? "Forget anyway" : forgetBusy ? "Forgetting…" : "Forget"}
                </Button>
              </div>
            </dialog>
          </Page>

          <CreateView hidden={view !== "create"} />
          {view === "keys" ? (
            <ErrorBoundary label="Agent keys">
              <AgentKeysView rooms={rooms} />
            </ErrorBoundary>
          ) : null}
          <HowView hidden={view !== "how"} />
          <AgentsView hidden={view !== "agents"} />
        </div>
      </div>
      <ToastHost />
    </div>
  );
}

