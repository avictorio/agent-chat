// The service worker (Web Push, the install prompt) is registered from
// both pages. (The Capacitor shell's bridges lived here until the
// Android app was removed, 2026-11-20.)

export function registerServiceWorker(): void {
  try {
    if ("serviceWorker" in navigator) {
      void navigator.serviceWorker.register("/sw.js").catch(() => {});
    }
  } catch {
    // no service worker support
  }
}
