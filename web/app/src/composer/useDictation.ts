import { useRef, useState } from "react";
import { flushSync } from "react-dom";
import { getSR, phraseMode, type SREvent, type SRInstance } from "./speech";

// Dictation: a speech-recognition session writing into the
// composer textarea (see ./speech for the environment facts).
// Phrase-mode browsers get short restarted sessions; continuous
// browsers get one. The mic button's state flips synchronously
// (flushSync) exactly where the current app toggles its class.

export function useDictation(opts: {
  textRef: React.RefObject<HTMLTextAreaElement | null>;
  grow: () => void;
}) {
  const { textRef, grow } = opts;
  const SR = getSR();
  const PHRASE_MODE = phraseMode();

  const [micOn, setMicOn] = useState(false);
  const recRef = useRef<SRInstance | null>(null);
  const listeningRef = useRef(false);
  const dictBaseRef = useRef("");
  const emptyRunsRef = useRef(0);

  const sessionText = (e: SREvent): string => {
    let fin = "";
    let interim = "";
    for (let i = 0; i < e.results.length; i++) {
      const t = e.results[i]![0]?.transcript || "";
      if (e.results[i]!.isFinal) fin += (fin && !/^\s/.test(t) ? " " : "") + t;
      else interim += (interim && !/^\s/.test(t) ? " " : "") + t;
    }
    return (fin + (fin && interim && !/^\s/.test(interim) ? " " : "") + interim)
      .replace(/\s+/g, " ")
      .trim();
  };
  const setMic = (on: boolean) => {
    listeningRef.current = on;
    setMicOn(on);
  };
  const startSession = () => {
    if (!SR) return;
    const r = new SR();
    let heard = false;
    r.lang = navigator.language || "en-US";
    r.continuous = !PHRASE_MODE;
    r.interimResults = true;
    const textEl = textRef.current;
    dictBaseRef.current = textEl ? textEl.value : "";
    if (dictBaseRef.current && !/\s$/.test(dictBaseRef.current)) dictBaseRef.current += " ";
    r.onresult = (e) => {
      const t = sessionText(e);
      if (t) {
        heard = true;
        if (textRef.current) {
          textRef.current.value = dictBaseRef.current + t;
          grow();
        }
      }
    };
    r.onerror = (e) => {
      if (e.error === "no-speech" || e.error === "aborted") return;
      flushSync(() => setMic(false));
      if (e.error === "not-allowed" || e.error === "service-not-allowed")
        import("../lib").then(({ toast }) =>
          toast("Microphone access is blocked. Allow it in your browser's site settings to dictate.", true)
        );
      else
        import("../lib").then(({ toast }) => toast("Dictation stopped (" + e.error + ")", true));
    };
    r.onend = () => {
      if (recRef.current !== r) return;
      recRef.current = null;
      emptyRunsRef.current = heard ? 0 : emptyRunsRef.current + 1;
      if (listeningRef.current && PHRASE_MODE && emptyRunsRef.current < 3) {
        try {
          startSession();
          return;
        } catch {
          // fall through to stopping
        }
      }
      // flushSync: the current app toggles the mic class synchronously
      // in onend, and anything reading the button in the same task (the
      // parity scenarios do) must see the stopped state immediately.
      flushSync(() => setMic(false));
    };
    r.start();
    recRef.current = r;
  };
  const stopDictation = (discard: boolean) => {
    setMic(false);
    const rec = recRef.current;
    if (!rec) return;
    if (discard) {
      rec.onresult = null;
      try {
        rec.abort();
      } catch {
        // already stopped
      }
    } else {
      try {
        rec.stop();
      } catch {
        // already stopped
      }
    }
  };
  const micClick = () => {
    if (listeningRef.current || recRef.current) {
      stopDictation(false);
      return;
    }
    setMic(true);
    emptyRunsRef.current = 0;
    try {
      startSession();
      if (!PHRASE_MODE) textRef.current?.focus();
    } catch (e) {
      setMic(false);
      import("../lib").then(({ toast }) =>
        toast("Couldn't start dictation: " + (e instanceof Error ? e.message : String(e)), true)
      );
    }
  };
  // Typing over a live session stops it (the text stays).
  const stopOnType = (key: string) => {
    if (recRef.current && (key.length === 1 || key === "Backspace" || key === "Delete")) stopDictation(false);
  };
  return { supported: !!SR, micOn, micClick, stopDictation, stopOnType };
}
