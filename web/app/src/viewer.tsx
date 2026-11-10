import { useCallback, useEffect, useMemo, useRef, useState } from "react";

// The full-screen viewer, ported from the current app: opening pushes
// a history entry, so the browser (or Android) back button closes the
// viewer and restores the chat, exactly like the back chevron does.
// The body is filled imperatively by the opener's build function (the
// content is DOM — rendered markdown, iframes, images).

export type ViewerBuild = (body: HTMLElement) => void;

export interface ViewerApi {
  open(title: string, build: ViewerBuild, dlUrl: string | null): void;
}

export function useViewerHost(): { api: ViewerApi; node: React.ReactNode } {
  const [v, setV] = useState<{ title: string; dl: string | null } | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const buildRef = useRef<ViewerBuild | null>(null);
  const openRef = useRef(false);
  const pushedRef = useRef(false);

  const close = useCallback((fromPop: boolean) => {
    if (!openRef.current) return;
    openRef.current = false;
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
  }, []);

  const api = useMemo<ViewerApi>(
    () => ({
      open(title, build, dl) {
        buildRef.current = build;
        openRef.current = true;
        pushedRef.current = false;
        setV({ title, dl });
        try {
          history.pushState({ agentChatViewer: 1 }, "");
          pushedRef.current = true;
        } catch {
          // history unavailable: the chevron still closes
        }
      },
    }),
    []
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

  const node = (
    <div id="viewer" hidden={!v} role="dialog" aria-modal="true">
      <div className="viewer-head">
        <button
          type="button"
          className="viewer-back"
          id="viewerBack"
          aria-label="Back to the room"
          onClick={() => close(false)}
        >
          ‹
        </button>
        <span className="viewer-title" id="viewerTitle">
          {v ? v.title : ""}
        </span>
        <span className="sp"></span>
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
