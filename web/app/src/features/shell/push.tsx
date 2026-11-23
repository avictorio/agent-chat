import { useCallback, useEffect, useState } from "react";
import { ApiError, RoomClient } from "@chat/contract";
import { useLatest } from "../../lib/useLatest";

// Phone notifications: Web Push (service worker + the room's
// subscription registry, with the quiet re-register when the room has
// lost a subscription). The bell cycles a small menu: Every message /
// @Mentions only / Off. The chosen mode is kept in localStorage.

type PushState = "off" | "on" | "blocked" | "install";
type PushMode = "all" | "mentions";

function iosNeedsInstall(): boolean {
  const nav = navigator.userAgent || "";
  const ios = /iPhone|iPad|iPod/i.test(nav) || (/Macintosh/.test(nav) && navigator.maxTouchPoints > 1);
  if (!ios) return false;
  // iOS Safari's own flag for a home-screen app (not in the DOM types)
  const standalone =
    (window.navigator as Navigator & { standalone?: boolean }).standalone === true ||
    (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches);
  return !standalone;
}

function pushSupported(): boolean {
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

function b64ToBytes(text: string): Uint8Array {
  let t = String(text).replace(/-/g, "+").replace(/_/g, "/");
  while (t.length % 4) t += "=";
  return Uint8Array.from(atob(t), (c) => c.charCodeAt(0));
}

function savedMode(key: string): PushMode | null {
  try {
    const s = localStorage.getItem(key);
    return s === "all" || s === "mentions" ? s : null;
  } catch {
    return null;
  }
}

async function subscribeBrowser(reg: ServiceWorkerRegistration): Promise<PushSubscription> {
  const kr = await fetch("/api/push/key");
  const kd = (await kr.json()) as { key: string };
  return reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: b64ToBytes(kd.key) as BufferSource,
  });
}

/** Forget on Home: drop this device's registration in the room while the
 *  invite that the server asks for is still on the device. Forget used to
 *  delete only the invite, so the room kept notifying whoever held the
 *  device and nothing on it could stop that any more. Resolves when the
 *  room will not notify this device; throws when that is not certain. */
export async function forgetRoomPush(room: string, token: string): Promise<void> {
  if (!pushSupported()) return;
  const reg = await navigator.serviceWorker.getRegistration("/");
  const sub = reg ? await reg.pushManager.getSubscription() : null;
  try {
    if (sub) await new RoomClient(room, token || null).pushUnsubscribe(sub.endpoint);
  } catch (e) {
    // a revoked invite (its registrations went with it), a token the room
    // never knew, or a deleted room: nothing there notifies this device
    if (!(e instanceof ApiError && (e.status === 401 || e.status === 403 || e.status === 404))) throw e;
  }
}

export interface PushApi {
  visible: boolean;
  on: boolean;
  label: string;
  bellClick: (anchor: HTMLElement) => void;
  menuNode: React.ReactNode;
}

export function usePush(client: RoomClient, toast: (msg: string, err?: boolean) => void): PushApi {
  // painted from the support rule up front (the async pass refines it);
  // gating the bell on serviceWorker.ready leaves it missing forever
  // when registration fails
  const [state, setState] = useState<PushState>(() => (iosNeedsInstall() ? "install" : "off"));
  const [mode, setMode] = useState<PushMode>("all");
  const [visible, setVisible] = useState(() => pushSupported() || iosNeedsInstall());
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const stateRef = useLatest(state);
  const modeRef = useLatest(mode);
  const modeKey = "chat-push-mode:" + client.basePath();
  const inviteKey = "chat-invite:" + client.room;

  const paint = useCallback((s: PushState, m: PushMode) => {
    setState(s);
    setMode(m);
    setVisible(pushSupported() || iosNeedsInstall());
  }, []);

  const paintPushState = useCallback(async () => {
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
      let sub = reg ? await reg.pushManager.getSubscription() : null;
      if (!sub && reg && savedMode(modeKey) && Notification.permission === "granted") {
        // The browser dropped or replaced its subscription (Chrome rarely
        // fires pushsubscriptionchange, and the service worker could not
        // re-register rooms anyway: it holds no invites). This room was
        // turned on here and permission still stands, so subscribe again
        // quietly; the status check below re-registers the room. Before,
        // the bell showed Off and the room stayed silent.
        sub = await subscribeBrowser(reg).catch(() => null);
      }
      let m = modeRef.current;
      let on = false;
      if (sub) {
        // One browser subscription serves every room on this device, so
        // its existence says nothing about THIS room. The bell says "on"
        // when the room holds the subscription; a room that lost it is
        // quietly re-registered only if this room was turned on here
        // (its saved mode) - never just because another room was.
        try {
          const sd = await client.pushStatus(sub.endpoint);
          // The saved mode is read after the status answer, not before:
          // Off in another tab clears it before it unsubscribes, and a
          // mode read before the await re-registered the room just
          // turned off there.
          const wanted = savedMode(modeKey);
          if (sd.registered) {
            m = (sd.mode as PushMode) || "all";
            on = true;
          } else if (wanted) {
            m = wanted;
            await client.pushSubscribe(sub.toJSON(), wanted);
            on = true;
          }
        } catch {
          // status check is best-effort: trust the saved choice
          const wanted = savedMode(modeKey);
          if (wanted) {
            m = wanted;
            on = true;
          }
        }
      }
      paint(on ? "on" : "off", m);
    } catch {
      paint("off", modeRef.current);
    }
  }, [client, modeKey, paint, modeRef]);

  const pushOn = useCallback(
    async (m: PushMode) => {
      const perm = await Notification.requestPermission();
      if (perm !== "granted") {
        void paintPushState();
        if (perm === "denied") toast("Notifications are blocked for this site in your browser settings.", true);
        return;
      }
      const reg = await navigator.serviceWorker.ready;
      const sub = (await reg.pushManager.getSubscription()) || (await subscribeBrowser(reg));
      await client.pushSubscribe(sub.toJSON(), m);
      try {
        localStorage.setItem(modeKey, m);
      } catch {
        // storage unavailable
      }
      toast(m === "mentions" ? "Mentions only - you'll be buzzed when someone @-mentions you." : "Notifications on for this device.");
      void paintPushState();
    },
    [client, modeKey, paintPushState, toast]
  );

  const pushOff = useCallback(async () => {
    // The saved mode goes before the server call, so another tab's
    // quiet re-register (which reads it after its status check) cannot
    // undo this Off; it comes back if the server refuses.
    const saved = savedMode(modeKey);
    try {
      localStorage.removeItem(modeKey);
    } catch {
      // storage unavailable
    }
    // Off is per room: drop this room's registration and keep the
    // browser subscription, which other rooms on this device still use.
    const reg = await navigator.serviceWorker.getRegistration("/");
    const sub = reg ? await reg.pushManager.getSubscription() : null;
    if (sub) {
      try {
        await client.pushUnsubscribe(sub.endpoint);
      } catch (e) {
        // A refused Off used to toast success while the room went on
        // notifying this device: keep the bell on and say it failed.
        try {
          if (saved) localStorage.setItem(modeKey, saved);
        } catch {
          // storage unavailable
        }
        void paintPushState();
        throw e;
      }
    }
    toast("Notifications off for this room on this device.");
    void paintPushState();
  }, [client, modeKey, paintPushState, toast]);

  // Boot: register the service worker, then refine the painted state
  // (and again whenever the page comes back into view).
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    void navigator.serviceWorker.register("/sw.js").catch(() => {});
    // oxlint-disable-next-line react/set-state-in-effect -- syncs the browser's push permission and subscription (an external system) into state
    void paintPushState();
    const onVis = () => {
      if (!document.hidden) void paintPushState();
    };
    // Another tab of this room turned the bell on or off, or Home forgot
    // the room. Forget clears the mode before its unsubscribe, so the
    // repaint that change sets off can hear "registered" from the server
    // and paint the bell on; the invite goes only after the unsubscribe
    // succeeded, and repainting then leaves the bell saying off.
    const onStore = (e: StorageEvent) => {
      if (e.key === null || e.key === modeKey || e.key === inviteKey) void paintPushState();
    };
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("storage", onStore);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("storage", onStore);
    };
  }, [paintPushState, modeKey, inviteKey]);

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
    [pushOff, pushOn, toast, stateRef]
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
    [toast, stateRef]
  );

  // Menu dismissal: outside click and Escape.
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
