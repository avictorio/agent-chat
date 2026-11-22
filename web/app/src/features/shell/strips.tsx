import { useEffect, useRef, useState, type RefObject } from "react";
import { fetchBuild, fetchChanges, type SiteNotice } from "@chat/contract";
import { isIOSDevice, isStandaloneApp, store } from "../../lib/index";
import { Button } from "../../ui/Button";
import { Dialog } from "../../ui/Dialog";

// The install strip, the update strip, the site notice and
// pull-to-refresh.

// --- install ----------------------------------------------------------------
// One 30-day dismissal key shared by the home banner and the room strip
// (ac:install-hide-2). The strip shows on any not-installed visit; the
// sidebar button waits until a real prompt exists or the device is iOS.
const INSTALL_HIDE_KEY = "ac:install-hide-2";
const THIRTY_DAYS = 30 * 864e5;

type BeforeInstallPromptEvent = Event & {
  prompt: () => void;
  userChoice?: Promise<unknown>;
};

export function useInstall() {
  const [dismissedAt, setDismissedAt] = useState<number>(() => Number(store(INSTALL_HIDE_KEY) || 0));
  const [hasPrompt, setHasPrompt] = useState(false);
  const deferred = useRef<BeforeInstallPromptEvent | null>(null);
  const dlgRef = useRef<HTMLDialogElement | null>(null);
  const [menuHint, setMenuHint] = useState(false);

  // the page's opening time (read once: render code stays pure); a dismissal
  // made since is newer, so it counts as dismissed too
  const [openedAt] = useState(() => Date.now());
  const dismissed = openedAt - dismissedAt < THIRTY_DAYS;
  const base = !isStandaloneApp() && !dismissed;

  useEffect(() => {
    const onPrompt = (e: Event) => {
      e.preventDefault();
      deferred.current = e as BeforeInstallPromptEvent;
      setHasPrompt(true);
    };
    const onInstalled = () => {
      deferred.current = null;
      setHasPrompt(false);
      const now = Date.now();
      store(INSTALL_HIDE_KEY, String(now));
      setDismissedAt(now);
    };
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  const runInstall = () => {
    if (deferred.current) {
      const pr = deferred.current;
      deferred.current = null;
      setHasPrompt(false);
      pr.prompt();
      return;
    }
    if (isIOSDevice) {
      dlgRef.current?.showModal?.();
      return;
    }
    setMenuHint(true);
  };

  const dismiss = () => {
    const now = Date.now();
    store(INSTALL_HIDE_KEY, String(now));
    setDismissedAt(now);
  };

  return {
    stripVisible: base,
    buttonVisible: base && (hasPrompt || isIOSDevice),
    hint: menuHint ? " - open the browser menu and choose Install app" : " - one tap, no browser chrome",
    runInstall,
    dismiss,
    dlgRef,
  };
}

export function InstallStrip({ visible, hint, onInstall, onDismiss, dlgRef }: {
  visible: boolean;
  hint: string;
  onInstall: () => void;
  onDismiss: () => void;
  dlgRef: RefObject<HTMLDialogElement | null>;
}) {
  return (
    <>
      <div className="install-strip" id="installStrip" hidden={!visible}>
        <img src="/icons/icon-192.png" alt="" width="28" height="28" />
        <span className="ist-text">
          <strong>Install Agent Chat</strong>
          <span id="installStripHint">{hint}</span>
        </span>
        <Button type="button" variant="primary" size="sm" id="installGoStrip" onClick={onInstall}>
          Install
        </Button>
        <Button type="button" variant="quiet" size="sm" id="installHideStrip" aria-label="Dismiss install banner" onClick={onDismiss}>
          ✕
        </Button>
      </div>
      <Dialog id="installDlg" aria-labelledby="installTitle" ref={dlgRef}>
        <div className="title-row">
          <span className="av-name" id="installTitle">
            Install Agent Chat
          </span>
        </div>
        <p>Get the app on your home screen: your rooms in one tap, notifications, no browser chrome.</p>
        <p>
          On iPhone: tap the <strong>Share</strong> button in Safari, then <strong>Add to Home Screen</strong>, then{" "}
          <strong>Add</strong>.
        </p>
        <div className="av-actions">
          <Button type="button" size="sm" id="installClose" onClick={() => dlgRef.current?.close()}>
            Close
          </Button>
        </div>
      </Dialog>
    </>
  );
}

// --- update banner ------------------------------------------------------------
// The served page carries a build stamp; GET /api/build reports the
// running deployment's. A mismatch means this page is behind: offer a
// refresh. Checks on load, every 4 minutes, on focus/visibility.
// Dismissal is per build — a further deploy re-shows the banner.
export function UpdateStrip() {
  const [visible, setVisible] = useState(false);
  const latest = useRef("");

  useEffect(() => {
    const meta = document.querySelector('meta[name="build"]');
    const myBuild = meta?.getAttribute("content") || "";
    if (!myBuild || myBuild === "next-dev") return; // unstamped (vite dev)
    let live = true;
    const check = async () => {
      const build = await fetchBuild();
      if (!live || !build) return;
      latest.current = build;
      if (build === myBuild) {
        setVisible(false);
        return;
      }
      if (store("ac:build-dismissed") !== build) setVisible(true);
    };
    void check();
    const iv = window.setInterval(check, 240000);
    const onVis = () => {
      if (!document.hidden) void check();
    };
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("focus", check);
    // It also re-checks whenever the stream (re)connects: the shell
    // dispatches this event from the stream's onopen.
    window.addEventListener("ac-stream-open", check);
    return () => {
      live = false;
      window.clearInterval(iv);
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("focus", check);
      window.removeEventListener("ac-stream-open", check);
    };
  }, []);

  const dismiss = () => {
    setVisible(false);
    if (latest.current) store("ac:build-dismissed", latest.current);
  };

  return (
    <div className="install-strip update-strip" id="updateStrip" hidden={!visible}>
      <span className="ist-text">
        <strong>New version available</strong> - this page is behind the latest update
      </span>
      <Button type="button" variant="primary" size="sm" id="updateRefresh" onClick={() => location.reload()}>
        Refresh
      </Button>
      <Button type="button" variant="quiet" size="sm" id="updateDismiss" aria-label="Dismiss update banner" onClick={dismiss}>
        ✕
      </Button>
    </div>
  );
}

// --- site notice ---------------------------------------------------------------
// The newest notice from the public changes feed (GET /api/changes): a
// deprecation with its date, a new feature. Read once per page load;
// dismissing one remembers its id, so the next notice shows again.
export function NoticeStrip() {
  const [notice, setNotice] = useState<SiteNotice | null>(null);

  useEffect(() => {
    let live = true;
    void fetchChanges().then((feed) => {
      if (!live || !feed) return;
      const newest = feed.notices.slice().sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))[0];
      if (newest && store("ac:notice-dismissed") !== newest.id) setNotice(newest);
    });
    return () => {
      live = false;
    };
  }, []);

  if (!notice) return null;
  const dismiss = () => {
    store("ac:notice-dismissed", notice.id);
    setNotice(null);
  };
  return (
    <div className="install-strip notice-strip" id="noticeStrip" role="status">
      <span className="ist-text">
        <strong>What's new</strong> - {notice.text}
      </span>
      <Button type="button" variant="quiet" size="sm" id="noticeDismiss" aria-label="Dismiss this notice" onClick={dismiss}>
        ✕
      </Button>
    </div>
  );
}

// --- pull-to-refresh ----------------------------------------------------------
// The installed app has no browser chrome, so a downward drag that
// starts on the top bar reloads the page. Past the threshold the hint
// reads "Release to refresh"; a real drag swallows the click it would
// otherwise end with. Direct DOM access by id: drag state churns at
// pointer rate and the elements are singletons.
export function usePullToRefresh() {
  useEffect(() => {
    const pullHint = document.getElementById("pullHint");
    const pullBar = document.querySelector(".topbar");
    const hintText = document.getElementById("pullHintText");
    if (!pullBar || !pullHint || !hintText) return;
    let pStart: number | null = null;
    let pDy = 0;
    let pDragged = false;
    const onDown = (e: Event) => {
      pStart = (e as PointerEvent).clientY;
      pDy = 0;
      pDragged = false;
      pullHint.classList.add("dragging");
    };
    const onMove = (e: Event) => {
      if (pStart === null) return;
      pDy = Math.max(0, (e as PointerEvent).clientY - pStart);
      if (pDy > 6) {
        pDragged = true;
        pullHint.hidden = false;
        pullHint.style.transform = "translate(-50%, " + Math.min(-64 + pDy * 0.9, 6) + "px)";
        hintText.textContent = pDy >= 72 ? "Release to refresh" : "Pull to refresh";
      }
    };
    const onEnd = () => {
      if (pStart === null) return;
      const go = pDy >= 72;
      pStart = null;
      pullHint.classList.remove("dragging");
      if (go) {
        hintText.textContent = "Refreshing…";
        pullHint.style.transform = "translate(-50%, 6px)";
        setTimeout(() => location.reload(), 250);
      } else {
        pullHint.style.transform = "";
        if (pDragged) setTimeout(() => (pullHint.hidden = true), 180);
        else pullHint.hidden = true;
      }
      pDy = 0;
    };
    const onClick = (e: Event) => {
      if (pDragged) {
        e.stopPropagation();
        e.preventDefault();
        pDragged = false;
      }
    };
    pullBar.addEventListener("pointerdown", onDown);
    pullBar.addEventListener("pointermove", onMove);
    pullBar.addEventListener("pointerup", onEnd);
    pullBar.addEventListener("pointercancel", onEnd);
    window.addEventListener("pointerup", onEnd);
    window.addEventListener("pointercancel", onEnd);
    pullBar.addEventListener("click", onClick, true);
    return () => {
      pullBar.removeEventListener("pointerdown", onDown);
      pullBar.removeEventListener("pointermove", onMove);
      pullBar.removeEventListener("pointerup", onEnd);
      pullBar.removeEventListener("pointercancel", onEnd);
      window.removeEventListener("pointerup", onEnd);
      window.removeEventListener("pointercancel", onEnd);
      pullBar.removeEventListener("click", onClick, true);
    };
  }, []);
}
