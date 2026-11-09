import { useEffect, useRef, useState, type RefObject } from "react";
import { fetchBuild } from "@chat/shared";
import { inShell, isIOSDevice, isStandaloneApp, store } from "./lib";

// The install strip, the update strip and pull-to-refresh, ported from
// the current app (PARITY.md sections A and M).

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

  const dismissed = Date.now() - dismissedAt < THIRTY_DAYS;
  const base = !isStandaloneApp() && !inShell() && !dismissed;

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

export function InstallStrip(p: {
  visible: boolean;
  hint: string;
  onInstall: () => void;
  onDismiss: () => void;
  dlgRef: RefObject<HTMLDialogElement | null>;
}) {
  return (
    <>
      <div className="install-strip" id="installStrip" hidden={!p.visible}>
        <img src="/icons/icon-192.png" alt="" width="28" height="28" />
        <span className="ist-text">
          <strong>Install Agent Chat</strong>
          <span id="installStripHint">{p.hint}</span>
        </span>
        <button type="button" className="btn sm primary" id="installGoStrip" onClick={p.onInstall}>
          Install
        </button>
        <button type="button" className="btn sm quiet" id="installHideStrip" aria-label="Dismiss install banner" onClick={p.onDismiss}>
          ✕
        </button>
      </div>
      <dialog className="av-dlg" id="installDlg" aria-labelledby="installTitle" ref={p.dlgRef}>
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
          <button type="button" className="btn sm" id="installClose" onClick={() => p.dlgRef.current?.close()}>
            Close
          </button>
        </div>
      </dialog>
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
    if (!myBuild || myBuild === "__BUILD_ID__") return;
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
    return () => {
      live = false;
      window.clearInterval(iv);
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("focus", check);
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
      <button type="button" className="btn sm primary" id="updateRefresh" onClick={() => location.reload()}>
        Refresh
      </button>
      <button type="button" className="btn sm quiet" id="updateDismiss" aria-label="Dismiss update banner" onClick={dismiss}>
        ✕
      </button>
    </div>
  );
}

// --- pull-to-refresh ----------------------------------------------------------
// The installed app has no browser chrome, so a downward drag that
// starts on the top bar reloads the page. Past the threshold the hint
// reads "Release to refresh"; a real drag swallows the click it would
// otherwise end with. Direct DOM access by id, as in the current app:
// drag state churns at pointer rate and the elements are singletons.
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
