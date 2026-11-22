// The service worker (Web Push, the install prompt) is registered from
// both pages.

export function registerServiceWorker(): void {
  try {
    if ("serviceWorker" in navigator) {
      void navigator.serviceWorker.register("/sw.js").catch(() => {});
    }
  } catch {
    // no service worker support
  }
}
