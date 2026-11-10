// Capacitor shell bridges, ported from the current app. Everything
// here is inert on the web: the shell is detected through the
// Capacitor global the native wrapper injects, and every plugin
// call is guarded.

/* eslint-disable @typescript-eslint/no-explicit-any */

export function inShell(): boolean {
  try {
    const w = window as any;
    return !!(w.Capacitor && w.Capacitor.isNativePlatform && w.Capacitor.isNativePlatform());
  } catch {
    return false;
  }
}

export function nativePlugins(): any | null {
  try {
    const w = window as any;
    return (w.Capacitor && w.Capacitor.Plugins) || null;
  } catch {
    return null;
  }
}

// Boot-time shell wiring shared by the room and home pages: dismiss
// the splash once the page is alive, and route app links into the
// room they name. On the home page a retained notification tap also
// routes into its room (the room page wires its own through the
// push module, which re-registers the device token there).
export function initShellCommon(opts?: { pushTapsRoute?: boolean }): void {
  if (!inShell()) return;
  const P = nativePlugins();
  if (!P) return;
  try {
    void P.SplashScreen.hide();
  } catch {
    // no splash plugin in this shell build
  }
  try {
    if (P.App) {
      void P.App.addListener("appUrlOpen", (d: any) => {
        if (d && d.url && d.url.indexOf("https://chat.victorio.cloud/") === 0) location.assign(d.url);
      });
    }
  } catch {
    // listener registration is best-effort
  }
  if (opts && opts.pushTapsRoute) {
    try {
      void P.PushNotifications.addListener("pushNotificationActionPerformed", (a: any) => {
        const url = a && a.notification && a.notification.data && a.notification.data.url;
        if (url) location.assign(url);
      });
    } catch {
      // same
    }
  }
}

// The browser installs register the service worker from both pages;
// the native shell skips it on purpose (it loads the site directly).
export function registerServiceWorker(): void {
  try {
    if ("serviceWorker" in navigator && !inShell()) {
      void navigator.serviceWorker.register("/sw.js").catch(() => {});
    }
  } catch {
    // no service worker support
  }
}
