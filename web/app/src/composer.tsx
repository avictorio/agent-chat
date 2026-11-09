import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";

// The composer, ported from the current app: name handling, the
// mention highlight overlay and autocomplete menu, dictation (one-
// phrase mode on phones, continuous on desktop), and the send flow.
// Attachments (image/clip/video/page chips) land in M5 — the buttons
// and file inputs render now, their change handlers arrive then.

export interface ComposerProps {
  name: string;
  nameLocked: boolean;
  onCommitName: (v: string) => void;
  onPost: (text: string, from: string) => Promise<void>;
  memberNames: string[];
  memberKinds: Record<string, string>;
  denied: boolean;
}

interface SRAlternative {
  transcript: string;
}
interface SRResultItem {
  isFinal: boolean;
  [index: number]: SRAlternative;
}
interface SREvent {
  results: ArrayLike<SRResultItem>;
}
interface SRInstance {
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
type SRCtor = new () => SRInstance;

function escHTML(t: string): string {
  return t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const I = ({ d, extra }: { d: string[]; extra?: React.ReactNode }) => (
  <svg className="i" viewBox="0 0 24 24">
    {extra}
    {d.map((p, i) => (
      <path key={i} d={p} />
    ))}
  </svg>
);

export function Composer(p: ComposerProps) {
  const formRef = useRef<HTMLFormElement | null>(null);
  const nameRef = useRef<HTMLInputElement | null>(null);
  const textRef = useRef<HTMLTextAreaElement | null>(null);
  const hlRef = useRef<HTMLDivElement | null>(null);
  const [draft, setDraft] = useState(p.name);
  const [changing, setChanging] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [mm, setMm] = useState<{ items: string[]; index: number; start: number; left: number; bottom: number } | null>(null);
  const mmRef = useRef(mm);
  mmRef.current = mm;

  const committed = p.name;
  const showInput = !p.nameLocked && (changing || !committed);
  const showAsLine = !!committed && !(changing && !p.nameLocked);

  useEffect(() => {
    setDraft(p.name);
  }, [p.name]);

  // ---- mention highlight overlay ----
  const mentionRegex = () => {
    const alts = [...p.memberNames]
      .sort((a, b) => b.length - a.length)
      .map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    return new RegExp("(^|[^A-Za-z0-9_])@(" + alts.join("|") + ")(?![A-Za-z0-9_])", "gi");
  };
  const syncHL = () => {
    const textEl = textRef.current;
    const hlInner = hlRef.current;
    if (!textEl || !hlInner) return;
    const text = textEl.value;
    if (p.memberNames.length) {
      const re = mentionRegex();
      let out = "";
      let last = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text))) {
        out += escHTML(text.slice(last, m.index)) + escHTML(m[1]!) + '<span class="mn">@' + escHTML(m[2]!) + "</span>";
        last = m.index + m[0].length;
      }
      out += escHTML(text.slice(last));
      if (text.endsWith("\n")) out += " ";
      hlInner.innerHTML = out;
    } else {
      hlInner.textContent = text;
    }
    hlInner.style.transform = "translateY(" + -textEl.scrollTop + "px)";
  };
  const grow = () => {
    const textEl = textRef.current;
    if (!textEl) return;
    textEl.style.height = "auto";
    textEl.style.height = Math.min(textEl.scrollHeight + 2, window.innerHeight * 0.4) + "px";
    syncHL();
  };
  useEffect(() => {
    syncHL();
    const onResize = () => syncHL();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  });

  // ---- dictation ----
  const SRCtorRef = useRef<SRCtor | null | undefined>(undefined);
  if (SRCtorRef.current === undefined) {
    const w = window as unknown as { SpeechRecognition?: SRCtor; webkitSpeechRecognition?: SRCtor };
    SRCtorRef.current = w.SpeechRecognition || w.webkitSpeechRecognition || null;
  }
  const SR = SRCtorRef.current;
  const phraseModeRef = useRef<boolean | null>(null);
  if (phraseModeRef.current === null) {
    const ua = navigator.userAgent || "";
    phraseModeRef.current =
      /Android|iPhone|iPad|iPod/i.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  }
  const PHRASE_MODE = phraseModeRef.current;
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
        import("./lib").then(({ toast }) =>
          toast("Microphone access is blocked. Allow it in your browser's site settings to dictate.", true)
        );
      else
        import("./lib").then(({ toast }) => toast("Dictation stopped (" + e.error + ")", true));
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
  const stopDictationRef = useRef(stopDictation);
  stopDictationRef.current = stopDictation;
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
      import("./lib").then(({ toast }) =>
        toast("Couldn't start dictation: " + (e instanceof Error ? e.message : String(e)), true)
      );
    }
  };

  // ---- mention menu ----
  const mmCandidates = (q: string): string[] => {
    const query = (q || "").toLowerCase();
    const starts: string[] = [];
    const incl: string[] = [];
    p.memberNames.forEach((n) => {
      const ln = n.toLowerCase();
      if (!query || ln.indexOf(query) === 0) starts.push(n);
      else if (ln.indexOf(query) >= 0) incl.push(n);
    });
    return starts.concat(incl).slice(0, 6);
  };
  const mmUpdate = () => {
    const textEl = textRef.current;
    if (!textEl || document.activeElement !== textEl) {
      setMm(null);
      return;
    }
    const pos = textEl.selectionStart || 0;
    const before = textEl.value.slice(0, pos);
    const m = /(^|[^A-Za-z0-9_])@([A-Za-z0-9_-]*)$/.exec(before);
    if (!m) {
      setMm(null);
      return;
    }
    const c = mmCandidates(m[2]!);
    if (!c.length) {
      setMm(null);
      return;
    }
    const r = textEl.getBoundingClientRect();
    setMm({
      items: c,
      index: 0,
      start: pos - m[2]!.length - 1,
      left: Math.max(6, Math.min(r.left + 4, window.innerWidth - 200)),
      bottom: window.innerHeight - r.top + 6,
    });
  };
  const mmPick = (i: number) => {
    const cur = mmRef.current;
    const textEl = textRef.current;
    if (!cur || !textEl) return;
    const n = cur.items[i];
    if (!n) return;
    const pos = textEl.selectionStart || 0;
    const v = textEl.value;
    textEl.value = v.slice(0, cur.start) + "@" + n + " " + v.slice(pos);
    const np = cur.start + n.length + 2;
    textEl.setSelectionRange(np, np);
    setMm(null);
    grow();
    textEl.focus();
  };

  // ---- name ----
  const commitName = () => {
    const n = draft.trim();
    if (!n) return;
    p.onCommitName(n);
    setChanging(false);
  };

  // ---- submit ----
  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    stopDictation(true);
    const textEl = textRef.current;
    const from = p.nameLocked ? committed : draft.trim() || committed;
    if (!from) {
      setChanging(true);
      setErr("Add your name first, so people know who's talking.");
      nameRef.current?.focus();
      return;
    }
    const text = textEl ? textEl.value : "";
    if (!text.trim()) return;
    if (from !== committed) p.onCommitName(from);
    setChanging(false);
    setSending(true);
    setErr(null);
    try {
      await p.onPost(text, from);
      if (textEl) textEl.value = "";
      grow();
    } catch (e2) {
      setErr("Couldn't send: " + (e2 instanceof Error ? e2.message : String(e2)));
    } finally {
      if (!p.denied) {
        setSending(false);
        textRef.current?.focus();
      }
    }
  };

  return (
    <>
      <form className="composer" id="form" autoComplete="off" ref={formRef} onSubmit={onSubmit}>
        <div className="composer-inner">
          <input
            id="name"
            placeholder="Your name"
            maxLength={40}
            aria-label="Your name"
            ref={nameRef}
            hidden={!showInput}
            readOnly={p.nameLocked}
            title={p.nameLocked ? "Set by your invite link" : undefined}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                commitName();
                textRef.current?.focus();
              }
            }}
            onBlur={() => {
              if (draft.trim()) commitName();
            }}
          />
          <div className="compose-box">
            <div className="attach-row" id="attachRow" hidden>
              <span id="imgChip" className="clip-chip">
                <img id="imgThumb" className="img-thumb" alt="" />
                <span id="imgName"></span>{" "}
                <button type="button" className="linkbtn" id="imgRemove">
                  Remove
                </button>
              </span>
            </div>
            <div className="textWrap">
              <div className="hl" aria-hidden="true">
                <div className="hlInner" id="hlInner" ref={hlRef}></div>
              </div>
              <textarea
                id="text"
                rows={2}
                placeholder="Write a message"
                maxLength={8000}
                aria-label="Message"
                ref={textRef}
                onInput={() => {
                  grow();
                  mmUpdate();
                }}
                onClick={mmUpdate}
                onBlur={() => setTimeout(() => setMm(null), 150)}
                onScroll={syncHL}
                onKeyDownCapture={(e) => {
                  const cur = mmRef.current;
                  if (!cur || !cur.items.length) return;
                  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                    e.preventDefault();
                    e.stopPropagation();
                    setMm({
                      ...cur,
                      index: (cur.index + (e.key === "ArrowDown" ? 1 : cur.items.length - 1)) % cur.items.length,
                    });
                  } else if (e.key === "Enter" || e.key === "Tab") {
                    e.preventDefault();
                    e.stopPropagation();
                    mmPick(cur.index);
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    e.stopPropagation();
                    setMm(null);
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    formRef.current?.requestSubmit();
                  }
                  if (recRef.current && (e.key.length === 1 || e.key === "Backspace" || e.key === "Delete"))
                    stopDictation(false);
                }}
              />
            </div>
            <div className="compose-tools">
              <button id="imgBtn" className="btn quiet icon-btn" type="button" aria-label="Attach an image" title="Attach an image">
                <I d={["M21 16l-5-5-9.5 9.5"]} extra={<><rect x="3" y="5" width="18" height="14" rx="2" /><circle cx="9" cy="10" r="1.6" /></>} />
              </button>
              <input id="imgFile" type="file" accept="image/*" hidden />
              <button id="clip" className="btn quiet icon-btn" type="button" aria-label="Attach an audio clip" title="Attach an audio clip">
                <I d={["M9 18V6l10-2v11"]} extra={<><circle cx="6.5" cy="18" r="2.5" /><circle cx="16.5" cy="15" r="2.5" /></>} />
              </button>
              <input id="clipFile" type="file" accept="audio/*" hidden />
              <button id="vidBtn" className="btn quiet icon-btn" type="button" aria-label="Attach a video" title="Attach a video">
                <I d={["M15 10l6-3v10l-6-3"]} extra={<rect x="3" y="6" width="12" height="12" rx="2" />} />
              </button>
              <input id="vidFile" type="file" accept="video/*" hidden />
              <button id="artBtn" className="btn quiet icon-btn" type="button" aria-label="Attach a page or document" title="Attach an HTML page or Markdown document">
                <I d={["M6 2h9l5 5v15H6z", "M14 2v6h6"]} />
              </button>
              <input id="artFile" type="file" accept=".html,.htm,.md,.markdown,text/html,text/markdown" hidden />
              <button id="rec" className="btn quiet icon-btn" type="button" aria-label="Record a voice message" title="Record a voice message" hidden>
                <svg className="i" viewBox="0 0 24 24">
                  <circle cx="12" cy="12" r="8" />
                  <circle cx="12" cy="12" r="3.5" fill="currentColor" stroke="none" />
                </svg>
              </button>
              <button
                id="mic"
                className={"btn quiet icon-btn" + (micOn ? " on" : "")}
                type="button"
                aria-label={micOn ? "Stop dictation" : "Dictate a message"}
                title={micOn ? "Listening… click to stop" : "Dictate a message"}
                aria-pressed={micOn}
                hidden={!SR}
                onClick={micClick}
              >
                <I d={["M5 11a7 7 0 0 0 14 0M12 18v3"]} extra={<rect x="9" y="3" width="6" height="11" rx="3" />} />
              </button>
              <span className="tools-spacer"></span>
              <button id="send" className="btn primary icon-btn" type="submit" aria-label="Send" title="Send" disabled={sending}>
                <I d={["M21 3L10 14", "M21 3l-7 18-4-7-7-4z"]} />
              </button>
            </div>
          </div>
        </div>
        <div className="composer-meta">
          <span id="asLine" hidden={!showAsLine} title={p.nameLocked ? "Set by your invite link" : undefined}>
            Posting as <strong id="asName">{committed}</strong>{" "}
            <button
              type="button"
              className="linkbtn"
              id="asChange"
              hidden={p.nameLocked}
              onClick={() => {
                setDraft(committed);
                setChanging(true);
                setTimeout(() => {
                  nameRef.current?.focus();
                  nameRef.current?.select();
                }, 0);
              }}
            >
              Change
            </button>
          </span>
          <span id="clipChip" className="clip-chip" hidden>
            <span id="clipName"></span>{" "}
            <button type="button" className="linkbtn" id="clipRemove">
              Remove
            </button>
          </span>
          <span id="vidChip" className="clip-chip" hidden>
            <span id="vidName"></span>{" "}
            <button type="button" className="linkbtn" id="vidRemove">
              Remove
            </button>
          </span>
          <span id="artChip" className="clip-chip" hidden>
            <span id="artName"></span>{" "}
            <button type="button" className="linkbtn" id="artRemove">
              Remove
            </button>
          </span>
          <span className="hint">Ctrl+Enter to send · Enter for a new line · mention @claude to ask Claude</span>
        </div>
        <div className="err" id="err" hidden={!err}>
          {err || ""}
        </div>
      </form>
      {mm && (
        <div className="mentionMenu" style={{ left: mm.left + "px", bottom: mm.bottom + "px" }}>
          {mm.items.map((n, i) => (
            <button
              type="button"
              key={n}
              className={i === mm.index ? "cur" : ""}
              onMouseDown={(e) => {
                e.preventDefault();
                mmPick(i);
              }}
            >
              <span>@{n}</span>
              <span className="mmKind">{p.memberKinds[n.toLowerCase()] || ""}</span>
            </button>
          ))}
        </div>
      )}
    </>
  );
}
