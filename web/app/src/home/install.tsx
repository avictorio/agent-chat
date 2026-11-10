import { useEffect, useRef, useState } from "react";
import { fetchBuild } from "@chat/shared";
import { inShell, isStandaloneApp, store } from "../lib";
import { Icon as I } from "../ui/Icon";

// The home page's install affordances and update strip: same
// dismissal keys and build check as the room shell's, with the
// home page's own wiring (the strip also lives in the sidebar).

interface BIPEvent extends Event {
  prompt: () => void;
  userChoice?: Promise<unknown>;
}

export function useHomeInstall() {
  const [deferred, setDeferred] = useState<BIPEvent | null>(null);
  const [dismissed, setDismissed] = useState(() => {
    try {
      return Date.now() - (+(localStorage.getItem("ac:install-hide-2") || 0) || 0) < 30 * 864e5;
    } catch {
      return false;
    }
  });
  const [steps, setSteps] = useState(" - one tap, no browser chrome");
  const isStandalone =
    (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) ||
    (window.navigator as unknown as { standalone?: boolean }).standalone === true;
  const inShellHome = (() => {
    try {
      const w = window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } };
      return !!(w.Capacitor && w.Capacitor.isNativePlatform && w.Capacitor.isNativePlatform());
    } catch {
      return false;
    }
  })();
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent || "");

  useEffect(() => {
    const onBIP = (e: Event) => {
      e.preventDefault();
      setDeferred(e as BIPEvent);
    };
    const onInstalled = () => {
      setDeferred(null);
      try {
        localStorage.setItem("ac:install-hide-2", String(Date.now()));
      } catch {
        // storage unavailable
      }
      setDismissed(true);
    };
    window.addEventListener("beforeinstallprompt", onBIP);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onBIP);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  const base = !isStandalone && !inShellHome && !dismissed;
  const runInstall = (goRooms: () => void) => {
    if (deferred) {
      const pr = deferred;
      setDeferred(null);
      pr.prompt();
      if (pr.userChoice) pr.userChoice.then(() => {});
      return;
    }
    setSteps(
      isIOS
        ? " - on iPhone: tap the Share button, then Add to Home Screen, then Add"
        : " - open your browser menu and choose Install app (or Add to Home screen)"
    );
    goRooms();
  };
  const dismiss = () => {
    try {
      localStorage.setItem("ac:install-hide-2", String(Date.now()));
    } catch {
      // storage unavailable
    }
    setDismissed(true);
  };
  return { base, sideVisible: base && (!!deferred || isIOS), steps, runInstall, dismiss };
}

export function HomeInstallStrip({
  inst,
  goToRooms,
}: {
  inst: ReturnType<typeof useHomeInstall>;
  goToRooms: () => void;
}) {
  return (
    <div className="install-strip" id="installBar" hidden={!inst.base}>
      <img src="/icons/icon-192.png" alt="" width={28} height={28} />
      <span className="ib-text">
        <strong>Install Agent Chat</strong>
        <span id="installSteps">{inst.steps}</span>
      </span>
      <button type="button" className="btn sm primary" id="installGo" onClick={() => inst.runInstall(goToRooms)}>
        Install
      </button>
      <button type="button" className="btn sm quiet" id="installHide" aria-label="Dismiss install banner" onClick={inst.dismiss}>
        ✕
      </button>
    </div>
  );
}

export function HomeUpdateStrip() {
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
  return (
    <div className="install-strip update-strip" id="updateStrip" hidden={!visible}>
      <span className="ib-text">
        <strong>New version available</strong> - this page is behind the latest update
      </span>
      <button type="button" className="btn sm primary" id="updateRefresh" onClick={() => location.reload()}>
        Refresh
      </button>
      <button
        type="button"
        className="btn sm quiet"
        id="updateDismiss"
        aria-label="Dismiss update banner"
        onClick={() => {
          setVisible(false);
          if (latest.current) store("ac:build-dismissed", latest.current);
        }}
      >
        ✕
      </button>
    </div>
  );
}
