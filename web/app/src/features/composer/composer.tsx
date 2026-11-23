import { useEffect, useRef, useState } from "react";
import { Icon as I } from "../../ui/Icon";
import { useDictation } from "./useDictation";
import { useAttachments, type PendingArt, type PendingClip, type PendingFile, type PendingImage, type PendingVideo } from "./useAttachments";
import { useMembers, useSession } from "../room/ctx";
import { useRecorder } from "./useRecorder";
import type { Message, RoomState } from "@chat/contract";
import { isImeKey, toast } from "../../lib/index";
import {
  UploadAlreadyPosted,
  UploadCancelled,
  dataUrlBlob,
  discardPending,
  fmtBytes,
  fmtEta,
  pendingUploads,
  sendWithUploads,
  type PendingUpload,
  type UpItem,
  type UpState,
} from "./uploads";
import { IconButton, LinkButton } from "../../ui/Button";
import { useLatest } from "../../lib/useLatest";

// The composer: name handling, the mention highlight overlay and
// autocomplete menu, dictation (one-phrase mode on phones, continuous
// on desktop), the send flow, and attachments — an audio clip, an
// image, a video, a file of any type
// and size, an HTML page or a Markdown document, plus the voice-message
// recorder. Small media rides inline in the post; anything bigger, and
// every general file, goes up first under a draft in resumable parts
// (uploads.ts), with live progress and a Cancel - the message does not
// officially post until every upload has completed.

export interface ComposerProps {
  onCommitName: (v: string) => void;
  onPosted: (m: Message & { room_state?: RoomState }) => void;
  denied: boolean;
}

function escHTML(t: string): string {
  return t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

interface InFlight {
  clip: PendingClip | null;
  image: PendingImage | null;
  video: PendingVideo | null;
  fileAtt: PendingFile | null;
  art: PendingArt | null;
}

export function Composer(p: ComposerProps) {
  const session = useSession();
  const membersCtx = useMembers();
  const name = session.meName;
  const nameLocked = session.nameLocked;
  const client = session.client;
  const room = session.room;
  const memberNames = membersCtx.names;
  const memberKinds = membersCtx.nameKinds;
  const formRef = useRef<HTMLFormElement | null>(null);
  const nameRef = useRef<HTMLInputElement | null>(null);
  const textRef = useRef<HTMLTextAreaElement | null>(null);
  const hlRef = useRef<HTMLDivElement | null>(null);
  const [draft, setDraft] = useState(name);
  const [changing, setChanging] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [mm, setMm] = useState<{ items: string[]; index: number; start: number; left: number; bottom: number } | null>(null);
  const mmRef = useLatest(mm);

  const committed = name;
  const showInput = !nameLocked && (changing || !committed);
  const showAsLine = !!committed && !(changing && !nameLocked);

  // a new committed name resets the draft (state adjusted during render,
  // not in an effect: no extra paint with the stale draft)
  const [draftFor, setDraftFor] = useState(name);
  if (draftFor !== name) {
    setDraftFor(name);
    setDraft(name);
  }

  // ---- mention highlight overlay ----
  const mentionRegex = () => {
    const alts = [...memberNames]
      .sort((a, b) => b.length - a.length)
      .map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    return new RegExp("(^|[^A-Za-z0-9_])@(" + alts.join("|") + ")(?![A-Za-z0-9_])", "gi");
  };
  const syncHL = () => {
    const textEl = textRef.current;
    const hlInner = hlRef.current;
    if (!textEl || !hlInner) return;
    const text = textEl.value;
    if (memberNames.length) {
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
    memberNames.forEach((n) => {
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

  // What the send under way carries. A send can take minutes (a big
  // upload), and the composer stays open for the next message meanwhile:
  // a slot cleared after the send only if it still holds what was sent,
  // and its Remove hidden only while that is so. Clearing every slot
  // wiped a photo or recording picked for the next message, unsent, and
  // a Remove during the upload hid an item the send then posted anyway.
  const [inFlight, setInFlight] = useState<InFlight | null>(null);
  const att = useAttachments(inFlight ? inFlight.fileAtt : null);
  const {
    clip, clipRef, setClip, image, setImage, art, setArt, video, setVideo, fileAtt, setFileAtt,
    imgFileRef, clipFileRef, artFileRef, vidFileRef, anyFileRef,
    onClipFile, onImgFile, onArtFile, onVidFile, onAnyFile,
  } = att;
  // ---- resumable uploads: live progress, Cancel, and what was interrupted ----
  const [up, setUp] = useState<UpState | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const [interrupted, setInterrupted] = useState<PendingUpload[]>(() => pendingUploads(room));
  const [interruptedFor, setInterruptedFor] = useState(room);
  if (interruptedFor !== room) {
    setInterruptedFor(room);
    setInterrupted(pendingUploads(room));
  }
  // Leaving the page mid-upload loses the browser's hold on the file:
  // ask first (the parts already sent are kept either way).
  const uploading = !!up;
  useEffect(() => {
    if (!uploading) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [uploading]);
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
  // Ctrl+Enter submits through requestSubmit, which ignores the disabled
  // Send button: this ref is the real in-flight guard.
  const sendingRef = useRef(false);
  // After a send, clear only what was sent: text typed while a long
  // upload ran stays in the composer.
  const clearSent = (textEl: HTMLTextAreaElement | null, typed: string) => {
    if (!textEl) return;
    const v = textEl.value;
    textEl.value = v === typed ? "" : typed && v.startsWith(typed) ? v.slice(typed.length).replace(/^\s+/, "") : v;
  };
  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (sendingRef.current) return;
    stopDictation(true);
    const textEl = textRef.current;
    const from = nameLocked ? committed : draft.trim() || committed;
    if (!from) {
      setChanging(true);
      setErr("Add your name first, so people know who's talking.");
      nameRef.current?.focus();
      return;
    }
    let text = textEl ? textEl.value : "";
    const typed = text;
    if (!text.trim() && !clip && !image && !video && !art && !fileAtt) return;
    if (!text.trim())
      text = clip
        ? "🎙️ Audio message"
        : video
          ? "🎬 Video message"
          : image
            ? "🖼️ Image"
            : fileAtt
              ? "📎 " + fileAtt.file.name
              : art!.kind === "html"
                ? "🗔 Page: " + art!.name
                : "📄 " + art!.name;
    if (from !== committed) p.onCommitName(from);
    setChanging(false);
    sendingRef.current = true;
    setSending(true);
    setErr(null);
    const viaUploads = !!(fileAtt || (image && image.big) || (clip && !clip.data) || (video && video.big));
    // a page or document can't ride a draft: an upload send leaves it be
    const sent: InFlight = { clip, image, video, fileAtt, art: viaUploads ? null : art };
    setInFlight(sent);
    // only what this send carried: a slot picked again meanwhile keeps
    // its new item for the next message
    const clearSlots = () => {
      setClip((c) => (c === sent.clip ? null : c));
      setImage((c) => (c === sent.image ? null : c));
      setVideo((c) => (c === sent.video ? null : c));
      setFileAtt((c) => (c === sent.fileAtt ? null : c));
      setArt((c) => (c && c === sent.art ? null : c));
    };
    try {
      // Anything past the inline caps, and any general file, goes up
      // first under a draft: the message does not officially post until
      // every upload completes and the draft is published. The image,
      // clip and video in the same message ride along through the same
      // engine. Nothing is cleared up front: if an upload fails, the
      // caption and every attachment stay armed, and sending again
      // resumes where it stopped (the parts already sent are kept).
      if (viaUploads) {
        const items: UpItem[] = [];
        if (image) {
          const b = image.file || dataUrlBlob(image.data || "", "image/png");
          items.push({ kind: "image", blob: b, name: image.file ? image.file.name : "image", type: b.type });
        }
        if (clip) {
          const b = clip.blob || dataUrlBlob(clip.data || "", "audio/webm");
          items.push({ kind: "audio", blob: b, name: clip.name, type: b.type, transcript: clip.transcript || null });
        }
        if (video) {
          const b = video.file || dataUrlBlob(video.data || "", "video/mp4");
          items.push({ kind: "video", blob: b, name: video.file ? video.file.name : "video", type: b.type });
        }
        if (fileAtt) items.push({ kind: "file", blob: fileAtt.file, name: fileAtt.file.name, type: fileAtt.file.type });
        const ctl = new AbortController();
        abortRef.current = ctl;
        const clearUploaded = () => {
          clearSent(textEl, typed);
          grow();
          clearSlots();
        };
        try {
          const live = await sendWithUploads(client, room, from, text, items, setUp, ctl.signal);
          clearUploaded();
          // A page or document can't ride a draft: it stays armed for
          // the next message. Never let that be silent.
          if (art) toast("Sent. Your page or document is still in the composer - send again to post it, or remove it.");
          p.onPosted(live);
        } catch (uerr) {
          // Cancelled after the publish had landed: the message is live and
          // stays, so what it carried leaves the composer as on a send.
          if (uerr instanceof UploadAlreadyPosted) {
            clearUploaded();
            toast("Too late to cancel - the message was already posted");
          } else if (uerr instanceof UploadCancelled) toast("Upload cancelled - nothing was posted");
          else {
            const msg = uerr instanceof Error ? uerr.message : String(uerr);
            toast("Upload interrupted: " + msg + ". Send again to pick up where it stopped.", true);
          }
        } finally {
          abortRef.current = null;
          setUp(null);
          setInterrupted(pendingUploads(room));
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
      const d = await client.postPayload(payload);
      clearSent(textEl, typed);
      grow();
      clearSlots();
      p.onPosted(d);
    } catch (sendErr) {
      setErr("Couldn't send: " + (sendErr instanceof Error ? sendErr.message : String(sendErr)));
    } finally {
      sendingRef.current = false;
      setInFlight(null);
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
            readOnly={nameLocked}
            title={nameLocked ? "Set by your invite link" : undefined}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !isImeKey(e)) {
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
            {up ? (
              <div className="upl" id="uplCard" role="status" aria-live="polite">
                <div className="upl-row">
                  <span className="upl-name">Uploading {up.label}</span>
                  <LinkButton type="button" id="uplCancel" onClick={() => abortRef.current?.abort()}>
                    Cancel
                  </LinkButton>
                </div>
                <div className="upl-bar" aria-hidden="true">
                  <span style={{ width: (up.total ? Math.min(100, (up.sent / up.total) * 100) : 0) + "%" }}></span>
                </div>
                <div className={"upl-meta" + (up.waiting ? " wait" : "")} id="uplMeta">
                  {up.waiting ||
                    Math.floor(up.total ? (up.sent / up.total) * 100 : 0) +
                      "% · " +
                      fmtBytes(up.sent) +
                      " of " +
                      fmtBytes(up.total) +
                      (up.rate > 0 ? " · " + fmtBytes(up.rate) + "/s" : "") +
                      (up.eta != null && up.sent < up.total ? " · " + fmtEta(up.eta) : "")}
                </div>
              </div>
            ) : null}
            <div className="attach-row" id="attachRow" hidden={!image}>
              <span id="imgChip" className="clip-chip">
                <img id="imgThumb" className="img-thumb" alt="" src={image ? image.thumb : undefined} />
                <span id="imgName">{image ? image.name : ""}</span>{" "}
                <LinkButton type="button" id="imgRemove" hidden={!!image && !!inFlight && image === inFlight.image} onClick={() => setImage(null)}>
                  Remove
                </LinkButton>
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
                  // keys while an IME composes are its own (arrows move
                  // through its candidates, Enter confirms), and
                  // Ctrl/Cmd+Enter is send: the menu took both before
                  if (isImeKey(e) || (e.key === "Enter" && (e.ctrlKey || e.metaKey))) return;
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
                  if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && !isImeKey(e)) {
                    e.preventDefault();
                    formRef.current?.requestSubmit();
                  }
                  dict.stopOnType(e.key);
                }}
              />
            </div>
            <div className="compose-tools">
              <IconButton id="imgBtn" variant="quiet" type="button" label="Attach an image" title="Attach an image" onClick={() => imgFileRef.current?.click()}>
                <I d={["M21 16l-5-5-9.5 9.5"]} extra={<><rect x="3" y="5" width="18" height="14" rx="2" /><circle cx="9" cy="10" r="1.6" /></>} />
              </IconButton>
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
              <IconButton id="clip" variant="quiet" type="button" label="Attach an audio clip" title="Attach an audio clip" onClick={() => clipFileRef.current?.click()}>
                <I d={["M9 18V6l10-2v11"]} extra={<><circle cx="6.5" cy="18" r="2.5" /><circle cx="16.5" cy="15" r="2.5" /></>} />
              </IconButton>
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
              <IconButton id="vidBtn" variant="quiet" type="button" label="Attach a video" title="Attach a video" onClick={() => vidFileRef.current?.click()}>
                <I d={["M15 10l6-3v10l-6-3"]} extra={<rect x="3" y="6" width="12" height="12" rx="2" />} />
              </IconButton>
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
              <IconButton id="fileBtn" variant="quiet" type="button" label="Attach a file" title="Attach a file (any type, any size)" onClick={() => anyFileRef.current?.click()}>
                <I d={["M21 11.5l-8.6 8.6a5 5 0 0 1-7.1-7.1l8.6-8.6a3.4 3.4 0 0 1 4.8 4.8l-8.6 8.6a1.7 1.7 0 0 1-2.4-2.4l7.9-7.9"]} />
              </IconButton>
              <input
                id="anyFile"
                type="file"
                hidden
                ref={anyFileRef}
                onChange={(e) => {
                  const f = e.target.files && e.target.files[0];
                  e.target.value = "";
                  void onAnyFile(f || null);
                }}
              />
              <IconButton id="artBtn" variant="quiet" type="button" label="Attach a page or document" title="Attach an HTML page or Markdown document" onClick={() => artFileRef.current?.click()}>
                <I d={["M6 2h9l5 5v15H6z", "M14 2v6h6"]} />
              </IconButton>
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
              <IconButton
                id="rec"
                variant="quiet"
                className={recActive ? "recording" : undefined}
                type="button"
                label="Record a voice message"
                title={recActive ? "Stop recording" : "Record a voice message"}
                hidden={!rec.supported}
                onClick={() => void recClick()}
              >
                <svg className="i" viewBox="0 0 24 24">
                  <circle cx="12" cy="12" r="8" />
                  <circle cx="12" cy="12" r="3.5" fill="currentColor" stroke="none" />
                </svg>
              </IconButton>
              <IconButton
                id="mic"
                variant="quiet"
                className={micOn ? "on" : undefined}
                type="button"
                label={micOn ? "Stop dictation" : "Dictate a message"}
                title={micOn ? "Listening… click to stop" : "Dictate a message"}
                aria-pressed={micOn}
                hidden={!dict.supported}
                onClick={micClick}
              >
                <I d={["M5 11a7 7 0 0 0 14 0M12 18v3"]} extra={<rect x="9" y="3" width="6" height="11" rx="3" />} />
              </IconButton>
              <span className="tools-spacer"></span>
              <IconButton id="send" variant="primary" type="submit" label="Send" title="Send" disabled={sending}>
                <I d={["M21 3L10 14", "M21 3l-7 18-4-7-7-4z"]} />
              </IconButton>
            </div>
          </div>
        </div>
        <div className="composer-meta">
          <span id="asLine" hidden={!showAsLine} title={nameLocked ? "Set by your invite link" : undefined}>
            Posting as <strong id="asName">{committed}</strong>{" "}
            <LinkButton
              type="button"
             
              id="asChange"
              hidden={nameLocked}
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
            </LinkButton>
          </span>
          <span id="clipChip" className="clip-chip" hidden={!clip && !recActive}>
            <span id="clipName">{clipChipText}</span>{" "}
            <LinkButton
              type="button"
             
              id="clipRemove"
              hidden={!recActive && !!clip && !!inFlight && clip === inFlight.clip}
              onClick={() => {
                if (rec.discardIfRecording()) return;
                setClip(null);
              }}
            >
              Remove
            </LinkButton>
          </span>
          <span id="vidChip" className="clip-chip" hidden={!video}>
            <span id="vidName">{video ? video.name : ""}</span>{" "}
            <LinkButton type="button" id="vidRemove" hidden={!!video && !!inFlight && video === inFlight.video} onClick={() => setVideo(null)}>
              Remove
            </LinkButton>
          </span>
          <span id="fileChip" className="clip-chip" hidden={!fileAtt}>
            <span id="fileName">{fileAtt ? fileAtt.label : ""}</span>{" "}
            <LinkButton type="button" id="fileRemove" hidden={!!fileAtt && !!inFlight && fileAtt === inFlight.fileAtt} onClick={() => setFileAtt(null)}>
              Remove
            </LinkButton>
          </span>
          {!up && interrupted.length ? (
            <span id="uplResume" className="clip-chip warn-chip">
              <span>
                {interrupted[0]!.names.join(", ") || "An upload"} didn't finish uploading - attach the same file and send to pick up where it stopped
              </span>{" "}
              <LinkButton
                type="button"
               
                id="uplDiscard"
                onClick={() => {
                  const it = interrupted[0]!;
                  void discardPending(client, room, it).then((r) => {
                    // another tab or device finished and posted it
                    if (r === "posted") toast((it.names.join(", ") || "That upload") + " was already posted - it stays in the chat");
                    setInterrupted(pendingUploads(room));
                  });
                }}
              >
                Discard
              </LinkButton>
            </span>
          ) : null}
          <span id="artChip" className="clip-chip" hidden={!art}>
            <span id="artName">{art ? art.label : ""}</span>{" "}
            <LinkButton type="button" id="artRemove" hidden={!!art && !!inFlight && art === inFlight.art} onClick={() => setArt(null)}>
              Remove
            </LinkButton>
          </span>
          <span className="hint">Ctrl+Enter to send · Enter for a new line</span>
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
              <span className="mmKind">{memberKinds[n.toLowerCase()] || ""}</span>
            </button>
          ))}
        </div>
      )}
    </>
  );
}
