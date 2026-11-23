// Small shared helpers: a forgiving localStorage wrapper (private modes
// throw) and a toast bus so any component can surface a message through
// the one toast element the shell renders.

export function store(k: string): string | null;
export function store(k: string, v: string | null): void;
export function store(k: string, v?: string | null): string | null | void {
  try {
    if (v === undefined) return localStorage.getItem(k);
    if (v === null) localStorage.removeItem(k);
    else localStorage.setItem(k, v);
  } catch {
    // storage unavailable: reads miss, writes vanish
  }
  return null;
}

export function isStandaloneApp(): boolean {
  return (
    (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) ||
    (window.navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

// The Enter that confirms an IME conversion (Japanese, Chinese, Korean
// typing) ends the composition; it is not a send. macOS Chrome reports it
// as key "Enter" with isComposing set, Safari with keyCode 229. Fields
// that acted on it sent the unconverted text as a move, and the composer's
// mention menu picked a member.
export function isImeKey(e: { nativeEvent: KeyboardEvent; keyCode: number }): boolean {
  return e.nativeEvent.isComposing || e.keyCode === 229;
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

/** Props that make a clickable card or row reachable and usable from
 *  the keyboard: focusable, announced as a button, Enter/Space opens.
 *  Keys pressed inside a nested control (a <video>, a link) are left
 *  to it. */
export function pressable(onActivate: () => void, label?: string) {
  return {
    role: "button",
    tabIndex: 0,
    "aria-label": label,
    onClick: onActivate,
    onKeyDown: (e: { key: string; target: EventTarget; currentTarget: EventTarget; preventDefault(): void }) => {
      if (e.target !== e.currentTarget) return;
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        onActivate();
      }
    },
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
