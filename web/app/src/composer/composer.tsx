import { useEffect, useRef, useState } from "react";
import { Icon as I } from "../ui/Icon";
import { useDictation } from "./useDictation";
import { useAttachments } from "./useAttachments";
import { useRecorder } from "./useRecorder";
import { flushSync } from "react-dom";
import type { Message, RoomClient, RoomState } from "@chat/shared";
import { toast } from "../lib";
import {
  sendBigVideo,
  sendBigVideoChunkedNative,
  sendBigVideoNative,
  tryNativeVideoPick,
  type NativePickedFile,
} from "./uploads";

// The composer, ported from the current app: name handling, the
// mention highlight overlay and autocomplete menu, dictation (one-
// phrase mode on phones, continuous on desktop), the send flow, and
// attachments — an audio clip, an image, a video (small ones inline,
// big ones up under a draft in resumable parts), an HTML page or a
// Markdown document, plus the voice-message recorder. A message does
// not officially post until its media upload completes.

export interface ComposerProps {
  name: string;
  nameLocked: boolean;
  onCommitName: (v: string) => void;
  client: RoomClient;
  room: string;
  onPosted: (m: Message & { room_state?: RoomState }) => void;
  memberNames: string[];
  memberKinds: Record<string, string>;
  denied: boolean;
}

function escHTML(t: string): string {
  return t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}


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

  const dict = useDictation({ textRef, grow });
  const { micOn, micClick, stopDictation } = dict;

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

  const att = useAttachments();
  const {
    clip, clipRef, setClip, image, setImage, art, setArt, video, setVideo,
    vidProgress, setVidProgress, imgFileRef, clipFileRef, artFileRef, vidFileRef,
    onClipFile, onImgFile, onArtFile, onVidFile,
  } = att;
  const rec = useRecorder({ textRef, grow, clipRef, setClip, stopDictation });
  const { recActive, recLabel, recClick } = rec;
  const clipChipText = recActive ? recLabel : clip ? clip.label : "";

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
    let text = textEl ? textEl.value : "";
    if (!text.trim() && !clip && !image && !video && !art) return;
    if (!text.trim())
      text = clip
        ? "🎙️ Audio message"
        : video
          ? "🎬 Video message"
          : image
            ? "🖼️ Image"
            : art!.kind === "html"
              ? "🗔 Page: " + art!.name
              : "📄 " + art!.name;
    if (from !== committed) p.onCommitName(from);
    setChanging(false);
    setSending(true);
    setErr(null);
    try {
      // A big video goes up first, under a draft: the message does
      // not officially post until the upload completes and the draft
      // is published. Nothing is cleared up front: if the upload
      // fails, the caption is still in the composer and any other
      // attachment stays armed, so a retry sends what was written.
      if (video && video.big) {
        const bigFile = video.file;
        const bigNative = video.native || null;
        const bigChunked = video.nativeChunked || null;
        try {
          const live = bigChunked
            ? await sendBigVideoChunkedNative(p.client, from, text, bigChunked, (label) => setVidProgress(label))
            : bigNative
              ? await sendBigVideoNative(p.client, from, text, bigNative, (label) => setVidProgress(label))
              : await sendBigVideo(p.client, p.room, from, text, bigFile!, (label) => setVidProgress(label));
          if (textEl) textEl.value = "";
          grow();
          setVideo(null);
          setVidProgress(null);
          // A big-video send carries only the video and the caption:
          // any clip, image or page stays armed for the next message.
          // Never let that be silent, and never discard them either.
          if (clip || image || art)
            toast("Video sent. Your other attachment is still in the composer - send again to post it, or remove it.");
          p.onPosted(live);
        } catch (uerr) {
          const msg = uerr instanceof Error ? uerr.message : String(uerr);
          toast(
            bigChunked
              ? "Video upload failed: " + msg + " - re-attach the same file to resume"
              : bigNative
                ? "Video upload failed: " + msg
                : "Video upload interrupted: " + msg + " - re-attach the same file to resume",
            true
          );
        }
        return;
      }
      const payload: Record<string, unknown> = { from, text };
      if (clip) payload.audio = clip.data;
      if (clip && clip.transcript) payload.transcript = clip.transcript;
      if (image) payload.image = image.data;
      if (video && video.data) payload.video = video.data;
      if (art && art.kind === "html") {
        payload.html = art.content;
        payload.html_name = art.name;
      }
      if (art && art.kind === "doc") {
        payload.doc = art.content;
        payload.doc_name = art.name;
      }
      const d = await p.client.postPayload(payload);
      if (textEl) textEl.value = "";
      grow();
      setClip(null);
      setImage(null);
      setVideo(null);
      setVidProgress(null);
      setArt(null);
      p.onPosted(d);
    } catch (err) {
      setErr("Couldn't send: " + (err instanceof Error ? err.message : String(err)));
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
            <div className="attach-row" id="attachRow" hidden={!image}>
              <span id="imgChip" className="clip-chip">
                <img id="imgThumb" className="img-thumb" alt="" src={image ? image.data : undefined} />
                <span id="imgName">{image ? image.name : ""}</span>{" "}
                <button type="button" className="linkbtn" id="imgRemove" onClick={() => setImage(null)}>
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
                  dict.stopOnType(e.key);
                }}
              />
            </div>
            <div className="compose-tools">
              <button id="imgBtn" className="btn quiet icon-btn" type="button" aria-label="Attach an image" title="Attach an image" onClick={() => imgFileRef.current?.click()}>
                <I d={["M21 16l-5-5-9.5 9.5"]} extra={<><rect x="3" y="5" width="18" height="14" rx="2" /><circle cx="9" cy="10" r="1.6" /></>} />
              </button>
              <input
                id="imgFile"
                type="file"
                accept="image/*"
                hidden
                ref={imgFileRef}
                onChange={(e) => {
                  const f = e.target.files && e.target.files[0];
                  e.target.value = "";
                  void onImgFile(f || null);
                }}
              />
              <button id="clip" className="btn quiet icon-btn" type="button" aria-label="Attach an audio clip" title="Attach an audio clip" onClick={() => clipFileRef.current?.click()}>
                <I d={["M9 18V6l10-2v11"]} extra={<><circle cx="6.5" cy="18" r="2.5" /><circle cx="16.5" cy="15" r="2.5" /></>} />
              </button>
              <input
                id="clipFile"
                type="file"
                accept="audio/*"
                hidden
                ref={clipFileRef}
                onChange={(e) => {
                  const f = e.target.files && e.target.files[0];
                  e.target.value = "";
                  void onClipFile(f || null);
                }}
              />
              <button id="vidBtn" className="btn quiet icon-btn" type="button" aria-label="Attach a video" title="Attach a video" onClick={() => {
                if (
                  !tryNativeVideoPick({
                    onPicked: (v) => {
                      if (v.kind === "inline") setVideo({ data: v.data, name: v.name });
                      else if (v.kind === "stream") setVideo({ native: v.file, big: true, name: v.name });
                      else setVideo({ nativeChunked: v.file, big: true, name: v.name });
                    },
                    toast,
                    fallback: () => vidFileRef.current?.click(),
                  })
                )
                  vidFileRef.current?.click();
              }}>
                <I d={["M15 10l6-3v10l-6-3"]} extra={<rect x="3" y="6" width="12" height="12" rx="2" />} />
              </button>
              <input
                id="vidFile"
                type="file"
                accept="video/*"
                hidden
                ref={vidFileRef}
                onChange={(e) => {
                  const f = e.target.files && e.target.files[0];
                  e.target.value = "";
                  void onVidFile(f || null);
                }}
              />
              <button id="artBtn" className="btn quiet icon-btn" type="button" aria-label="Attach a page or document" title="Attach an HTML page or Markdown document" onClick={() => artFileRef.current?.click()}>
                <I d={["M6 2h9l5 5v15H6z", "M14 2v6h6"]} />
              </button>
              <input
                id="artFile"
                type="file"
                accept=".html,.htm,.md,.markdown,text/html,text/markdown"
                hidden
                ref={artFileRef}
                onChange={(e) => {
                  const f = e.target.files && e.target.files[0];
                  e.target.value = "";
                  void onArtFile(f || null);
                }}
              />
              <button
                id="rec"
                className={"btn quiet icon-btn" + (recActive ? " recording" : "")}
                type="button"
                aria-label="Record a voice message"
                title={recActive ? "Stop recording" : "Record a voice message"}
                hidden={!rec.supported}
                onClick={() => void recClick()}
              >
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
                hidden={!dict.supported}
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
          <span id="clipChip" className="clip-chip" hidden={!clip && !recActive}>
            <span id="clipName">{clipChipText}</span>{" "}
            <button
              type="button"
              className="linkbtn"
              id="clipRemove"
              onClick={() => {
                if (rec.discardIfRecording()) return;
                setClip(null);
              }}
            >
              Remove
            </button>
          </span>
          <span id="vidChip" className="clip-chip" hidden={!video}>
            <span id="vidName">{vidProgress || (video ? video.name : "")}</span>{" "}
            <button
              type="button"
              className="linkbtn"
              id="vidRemove"
              onClick={() => {
                setVideo(null);
                setVidProgress(null);
              }}
            >
              Remove
            </button>
          </span>
          <span id="artChip" className="clip-chip" hidden={!art}>
            <span id="artName">{art ? art.label : ""}</span>{" "}
            <button type="button" className="linkbtn" id="artRemove" onClick={() => setArt(null)}>
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
