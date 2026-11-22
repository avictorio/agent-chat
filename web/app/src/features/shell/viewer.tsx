import { useCallback, useEffect, useMemo, useRef, useState } from "react";

// The full-screen viewer, ported from the current app: opening pushes
// a history entry, so the browser (or Android) back button closes the
// viewer and restores the chat, exactly like the back chevron does.
// The body is filled imperatively by the opener's build function (the
// content is DOM — rendered markdown, iframes, images).

export type ViewerBuild = (body: HTMLElement) => void;

export interface ViewerApi {
  // extra.onHelp puts a ? (How to play) button in the header - the game
  // arenas pass it so every game's rules are one tap away mid-match
  open(title: string, build: ViewerBuild, dlUrl: string | null, extra?: { onHelp?: () => void }): void;
  // Programmatic close for in-viewer actions that navigate elsewhere
  // (the media shelf's "View in chat"): unlike the back chevron this
  // does NOT pop the pushed history entry - popping would restore
  // the URL the viewer covered, hash and all, and the tab sync would
  // bounce the user back to the view they were leaving. The entry
  // stays; a later back lands on it and the popstate handler no-ops.
  close(): void;
}

export function useViewerHost(opts?: {
  onCloseRef?: React.MutableRefObject<(() => void) | null>;
}): { api: ViewerApi; node: React.ReactNode } {
  const [v, setV] = useState<{ title: string; dl: string | null; onHelp?: () => void } | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const buildRef = useRef<ViewerBuild | null>(null);
  const openRef = useRef(false);
  const pushedRef = useRef(false);
  // a ref the room owns (stable): what to run when the viewer closes
  const onCloseRef = opts && opts.onCloseRef;

  const close = useCallback((fromPop: boolean) => {
    if (!openRef.current) return;
    openRef.current = false;
    if (onCloseRef && onCloseRef.current) onCloseRef.current();
    if (bodyRef.current) bodyRef.current.textContent = "";
    setV(null);
    if (!fromPop && pushedRef.current) {
      pushedRef.current = false;
      try {
        history.back();
      } catch {
        // no history to go back to
      }
    }
  }, [onCloseRef]);

  const api = useMemo<ViewerApi>(
    () => ({
      open(title, build, dl, extra) {
        buildRef.current = build;
        openRef.current = true;
        pushedRef.current = false;
        setV({ title, dl, onHelp: extra && extra.onHelp });
        try {
          history.pushState({ agentChatViewer: 1 }, "");
          pushedRef.current = true;
        } catch {
          // history unavailable: the chevron still closes
        }
      },
      close() {
        if (!openRef.current) return;
        openRef.current = false;
        pushedRef.current = false;
        if (onCloseRef && onCloseRef.current) onCloseRef.current();
        if (bodyRef.current) bodyRef.current.textContent = "";
        setV(null);
      },
    }),
    [onCloseRef]
  );

  useEffect(() => {
    if (v && bodyRef.current && buildRef.current) {
      const b = bodyRef.current;
      b.textContent = "";
      buildRef.current(b);
      b.scrollTop = 0;
    }
  }, [v]);

  useEffect(() => {
    const onPop = () => close(true);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [close]);

  // A dialog takes the focus while it is open (the back button, so
  // Enter or Escape closes it) and hands it back to what opened it.
  // Escape closes, unless something inside already used the key.
  const backRef = useRef<HTMLButtonElement | null>(null);
  const isOpen = !!v;
  useEffect(() => {
    if (!isOpen) return;
    const opener = document.activeElement as HTMLElement | null;
    backRef.current?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      // a dialog open over the viewer (the How to play sheet) takes its
      // own Escape: the viewer stays
      if (e.key === "Escape" && !e.defaultPrevented && !document.querySelector("dialog[open]")) {
        e.preventDefault();
        close(false);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      if (opener && opener.isConnected && opener !== document.body) opener.focus({ preventScroll: true });
    };
  }, [isOpen, close]);

  const node = (
    <div id="viewer" hidden={!v} role="dialog" aria-modal="true" aria-labelledby="viewerTitle">
      <div className="viewer-head">
        <button
          type="button"
          className="viewer-back"
          id="viewerBack"
          ref={backRef}
          aria-label="Back to the room"
          onClick={() => close(false)}
        >
          ‹
        </button>
        <span className="viewer-title" id="viewerTitle">
          {v ? v.title : ""}
        </span>
        <span className="sp"></span>
        {v && v.onHelp ? (
          <button type="button" className="viewer-help" id="viewerHelp" aria-label="How to play" title="How to play" onClick={v.onHelp}>
            ?
          </button>
        ) : null}
        <a
          className="linkbtn"
          id="viewerDl"
          hidden={!v || !v.dl}
          {...(v && v.dl ? { href: v.dl, download: v.title } : {})}
        >
          Download
        </a>
      </div>
      <div className="viewer-body" id="viewerBody" ref={bodyRef}></div>
    </div>
  );
  return { api, node };
}
