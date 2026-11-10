// Speech-recognition types and the two environment facts both
// speech features need: the recognition constructor (vendor
// prefixed on some browsers) and phrase mode (mobile Safari and
// Android Chrome end recognition after each phrase, so sessions
// restart per phrase and never run continuous).

export interface SRAlternative {
  transcript: string;
}
export interface SRResultItem {
  isFinal: boolean;
  [index: number]: SRAlternative;
}
export interface SREvent {
  results: ArrayLike<SRResultItem>;
}
export interface SRInstance {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((e: SREvent) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
export type SRCtor = new () => SRInstance;

let srCache: SRCtor | null | undefined;
export function getSR(): SRCtor | null {
  if (srCache === undefined) {
    const w = window as unknown as { SpeechRecognition?: SRCtor; webkitSpeechRecognition?: SRCtor };
    srCache = w.SpeechRecognition || w.webkitSpeechRecognition || null;
  }
  return srCache;
}

let pmCache: boolean | null = null;
export function phraseMode(): boolean {
  if (pmCache === null) {
    const ua = navigator.userAgent || "";
    pmCache = /Android|iPhone|iPad|iPod/i.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  }
  return pmCache;
}
