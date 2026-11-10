import { useCallback, useEffect, useRef, useState } from "react";
import type { RoomClient } from "@chat/shared";
import { inShell, nativePlugins } from "./shell";

// Phone notifications, ported from the current app: Web Push in the
// browser (service worker + the room's subscription registry, with
// the quiet re-register when the room has lost a subscription), and
// the Capacitor push plugin inside the native shell (device-token
// registry, same modes, same discipline). The bell cycles a small
// menu: Every message / @Mentions only / Off. The chosen mode is
// kept in localStorage under the same key on both paths.

/* eslint-disable @typescript-eslint/no-explicit-any */

type PushState = "off" | "on" | "blocked" | "install";
type PushMode = "all" | "mentions";

function iosNeedsInstall(): boolean {
  const nav = navigator.userAgent || "";
  const ios = /iPhone|iPad|iPod/i.test(nav) || (/Macintosh/.test(nav) && navigator.maxTouchPoints > 1);
  if (!ios) return false;
  const standalone =
    (window.navigator as any).standalone === true ||
    (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches);
  return !standalone;
}

function pushSupported(): boolean {
  return !inShell() && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

function b64ToBytes(text: string): Uint8Array {
  let t = String(text).replace(/-/g, "+").replace(/_/g, "/");
  while (t.length % 4) t += "=";
  return Uint8Array.from(atob(t), (c) => c.charCodeAt(0));
}

export interface PushApi {
  visible: boolean;
  on: boolean;
  label: string;
  bellClick: (anchor: HTMLElement) => void;
  menuNode: React.ReactNode;
}

export function usePush(client: RoomClient, toast: (msg: string, err?: boolean) => void): PushApi {
  const [state, setState] = useState<PushState>("off");
  const [mode, setMode] = useState<PushMode>("all");
  const [visible, setVisible] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const shellTokenRef = useRef<string | null>(null);
  const shellWiredRef = useRef(false);
  const modeKey = "chat-push-mode:" + client.basePath();

  const paint = useCallback((s: PushState, m: PushMode) => {
    setState(s);
    setMode(m);
    setVisible(inShell() || pushSupported() || iosNeedsInstall());
  }, []);

  const shellPlatform = (): string => {
    try {
      const w = window as any;
      return w.Capacitor.getPlatform() === "ios" ? "ios" : "android";
    } catch {
      return "android";
    }
  };

  const wireShellPush = useCallback(() => {
    if (shellWiredRef.current || !inShell()) return;
    shellWiredRef.current = true;
    const P = nativePlugins() && nativePlugins().PushNotifications;
    if (!P) return;
    void P.addListener("registration", (t: any) => {
      shellTokenRef.current = t.value;
      try {
        localStorage.setItem("ac:devtoken", t.value);
      } catch {
        // storage unavailable
      }
      let want: string | null = null;
      try {
        want = localStorage.getItem(modeKey);
      } catch {
        // same
      }
      if (want === "all" || want === "mentions") {
        void client.pushDevice("register", { token: t.value, platform: shellPlatform(), mode: want }).catch(() => {});
      }
    });
    void P.addListener("registrationError", () => {});
    void P.addListener("pushNotificationActionPerformed", (a: any) => {
      const url = a && a.notification && a.notification.data && a.notification.data.url;
      if (url) location.assign(url);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client]);

  const paintShellPushState = useCallback(async () => {
    wireShellPush();
    let want: string | null = null;
    try {
      want = localStorage.getItem(modeKey);
    } catch {
      // storage unavailable
    }
    if (want !== "all" && want !== "mentions") {
      paint("off", modeRef.current);
      return;
    }
    const P = nativePlugins() && nativePlugins().PushNotifications;
    try {
      if (P) await P.register();
    } catch {
      // registration is best-effort here
    }
    let tok = shellTokenRef.current;
    try {
      tok = tok || localStorage.getItem("ac:devtoken");
    } catch {
      // same
    }
    if (tok) {
      try {
        const sd = await client.pushDevice("status", { token: tok });
        if (sd.registered) {
          paint("on", (sd.mode as PushMode) || "all");
          return;
        }
        await client.pushDevice("register", { token: tok, platform: shellPlatform(), mode: want });
      } catch {
        // fall through to the optimistic state
      }
    }
    paint("on", want as PushMode);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, paint, wireShellPush]);

  const paintPushState = useCallback(async () => {
    if (inShell()) {
      await paintShellPushState();
      return;
    }
    if (!pushSupported()) {
      paint(iosNeedsInstall() ? "install" : "off", modeRef.current);
      return;
    }
    if (Notification.permission === "denied") {
      paint("blocked", modeRef.current);
      return;
    }
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = reg ? await reg.pushManager.getSubscription() : null;
      let m = modeRef.current;
      if (sub) {
        // The bell may only say "on" when pushes will actually
        // arrive: check the room still holds this subscription, and
        // quietly re-register if it lost it.
        try {
          const sd = await client.pushStatus(sub.endpoint);
          if (sd.registered) m = (sd.mode as PushMode) || "all";
          else {
            let saved: PushMode = "all";
            try {
              saved = localStorage.getItem(modeKey) === "mentions" ? "mentions" : "all";
            } catch {
              // storage unavailable
            }
            m = saved;
            await client.pushSubscribe(sub.toJSON(), saved);
          }
        } catch {
          // status check is best-effort
        }
      }
      paint(sub ? "on" : "off", m);
    } catch {
      paint("off", modeRef.current);
    }
  }, [client, modeKey, paint, paintShellPushState]);

  const shellPushOn = useCallback(
    async (m: PushMode) => {
      const P = nativePlugins() && nativePlugins().PushNotifications;
      const perm = await P.requestPermissions();
      if (!perm || perm.receive !== "granted") {
        toast("Notifications are blocked for the app - allow them in your phone's app settings.", true);
        return;
      }
      try {
        localStorage.setItem(modeKey, m);
      } catch {
        // storage unavailable
      }
      await P.register();
      let tok = shellTokenRef.current;
      try {
        tok = tok || localStorage.getItem("ac:devtoken");
      } catch {
        // same
      }
      if (tok) await client.pushDevice("register", { token: tok, platform: shellPlatform(), mode: m });
      paint("on", m);
      toast(m === "mentions" ? "Mentions only - you'll be buzzed when someone @-mentions you." : "Notifications on for this device.");
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [client, modeKey, paint, toast]
  );

  const shellPushOff = useCallback(async () => {
    try {
      localStorage.removeItem(modeKey);
    } catch {
      // storage unavailable
    }
    let tok = shellTokenRef.current;
    try {
      tok = tok || localStorage.getItem("ac:devtoken");
    } catch {
      // same
    }
    if (tok) await client.pushDevice("unregister", { token: tok }).catch(() => {});
    paint("off", modeRef.current);
    toast("Notifications off for this device.");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, modeKey, paint, toast]);

  const pushOn = useCallback(
    async (m: PushMode) => {
      if (inShell()) {
        await shellPushOn(m);
        return;
      }
      const perm = await Notification.requestPermission();
      if (perm !== "granted") {
        void paintPushState();
        if (perm === "denied") toast("Notifications are blocked for this site in your browser settings.", true);
        return;
      }
      const reg = await navigator.serviceWorker.ready;
      let sub = await reg.pushManager.getSubscription();
      if (!sub) {
        const kr = await fetch("/api/push/key");
        const kd = (await kr.json()) as { key: string };
        sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: b64ToBytes(kd.key) as BufferSource,
        });
      }
      await client.pushSubscribe(sub.toJSON(), m);
      try {
        localStorage.setItem(modeKey, m);
      } catch {
        // storage unavailable
      }
      toast(m === "mentions" ? "Mentions only - you'll be buzzed when someone @-mentions you." : "Notifications on for this device.");
      void paintPushState();
    },
    [client, modeKey, paintPushState, shellPushOn, toast]
  );

  const pushOff = useCallback(async () => {
    if (inShell()) {
      await shellPushOff();
      return;
    }
    const reg = await navigator.serviceWorker.getRegistration("/");
    const sub = reg ? await reg.pushManager.getSubscription() : null;
    if (sub) {
      await client.pushUnsubscribe(sub.endpoint).catch(() => {});
      await sub.unsubscribe().catch(() => {});
    }
    toast("Notifications off for this device.");
    void paintPushState();
  }, [client, paintPushState, shellPushOff, toast]);

  // Boot: register the service worker and paint the initial state,
  // exactly where the current app does it.
  useEffect(() => {
    if ("serviceWorker" in navigator && !inShell()) {
      void navigator.serviceWorker.register("/sw.js").catch(() => {});
      void paintPushState();
      const onVis = () => {
        if (!document.hidden) void paintPushState();
      };
      document.addEventListener("visibilitychange", onVis);
      return () => document.removeEventListener("visibilitychange", onVis);
    }
    if (iosNeedsInstall()) {
      paint("install", "all");
      return;
    }
    if (inShell()) {
      wireShellPush();
      void paintShellPushState();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const choose = useCallback(
    async (m: PushMode | "off") => {
      setMenu(null);
      try {
        if (m === "off") {
          if (stateRef.current === "on") await pushOff();
        } else await pushOn(m);
      } catch (e) {
        toast("Couldn't change notifications: " + (e instanceof Error ? e.message : String(e)), true);
      }
    },
    [pushOff, pushOn, toast]
  );

  const bellClick = useCallback(
    (anchor: HTMLElement) => {
      if (stateRef.current === "blocked") {
        toast("Notifications are blocked for this site - allow them in your browser or phone settings for this site.", true);
        return;
      }
      if (stateRef.current === "install" || (!pushSupported() && iosNeedsInstall())) {
        toast(
          "On iPhone, notifications need the installed app: tap Share, then Add to Home Screen. Open Agent Chat from the new icon and tap the bell there.",
          true
        );
        return;
      }
      setMenu((cur) => {
        if (cur) return null;
        const r = anchor.getBoundingClientRect();
        const w = 190;
        const h = 132;
        const left = Math.max(6, Math.min(r.left, window.innerWidth - w - 6));
        let top = r.top - h - 6;
        if (top < 6) top = r.bottom + 6;
        return { x: left, y: top };
      });
    },
    [toast]
  );

  // Menu dismissal: outside click and Escape, like the current app.
  useEffect(() => {
    if (!menu) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest && (t.closest(".pushMenu") || t.closest(".pushBtn"))) return;
      setMenu(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenu(null);
    };
    document.addEventListener("click", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("click", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  const label =
    state === "off"
      ? "Notifications off"
      : state === "on"
        ? mode === "mentions"
          ? "Mentions only"
          : "Notifications on"
        : state === "blocked"
          ? "Notifications blocked"
          : "Notifications - setup";

  const menuNode = menu ? (
    <div className="pushMenu" style={{ left: menu.x + "px", top: menu.y + "px" }}>
      <button
        type="button"
        data-mode="all"
        className={state === "on" && mode === "all" ? "cur" : ""}
        onClick={() => void choose("all")}
      >
        Every message
      </button>
      <button
        type="button"
        data-mode="mentions"
        className={state === "on" && mode === "mentions" ? "cur" : ""}
        onClick={() => void choose("mentions")}
      >
        @Mentions only
      </button>
      <button type="button" data-mode="off" className={state !== "on" ? "cur" : ""} onClick={() => void choose("off")}>
        Off
      </button>
    </div>
  ) : null;

  return { visible, on: state === "on", label, bellClick, menuNode };
}
