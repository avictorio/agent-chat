// Small shared helpers for the app, mirroring the current app's
// conventions: a forgiving localStorage wrapper (private modes throw)
// and a toast bus so any component can surface a message through the
// one toast element the shell renders.

export function store(k: string): string | null;
export function store(k: string, v: string | null): void;
export function store(k: string, v?: string | null): string | null | void {
  try {
    if (v === undefined) return localStorage.getItem(k);
    if (v === null) localStorage.removeItem(k);
    else localStorage.setItem(k, v);
  } catch {
    // storage unavailable: reads miss, writes vanish — same as the old app
  }
  return null;
}

// True inside the Capacitor shell (its bridge injects window.Capacitor).
export function inShell(): boolean {
  return typeof (window as unknown as { Capacitor?: unknown }).Capacitor !== "undefined";
}

export function isStandaloneApp(): boolean {
  return (
    (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) ||
    (window.navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

export const isIOSDevice = /iphone|ipad|ipod/i.test(navigator.userAgent || "");

// --- toast bus -------------------------------------------------------------
type ToastMsg = { text: string; bad: boolean; n: number };
let toastListener: ((m: ToastMsg) => void) | null = null;
let toastSeq = 0;

export function toast(text: string, bad = false): void {
  toastSeq += 1;
  if (toastListener) toastListener({ text, bad, n: toastSeq });
}

export function onToast(fn: (m: ToastMsg) => void): () => void {
  toastListener = fn;
  return () => {
    if (toastListener === fn) toastListener = null;
  };
}

/** Create an element with a class and optional text (the DOM builder
 *  the markdown renderer and the game views share). */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined && text !== null) e.textContent = text;
  return e;
}

/** Case-insensitive name equality (member names compare loosely). */
export function same(a: string | null | undefined, b: string | null | undefined): boolean {
  return !!a && !!b && a.toLowerCase() === b.toLowerCase();
}
