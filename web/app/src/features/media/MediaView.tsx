import { useCallback, useEffect, useRef, useState } from "react";
import type { Attachment } from "@chat/shared";
import { useFeed, useMembers, useSession } from "../room/ctx";
import { rel } from "../../lib/dates";
import { loadDoc } from "../feed/media";
import { md } from "../feed/markdown";
import { Icon as I } from "../../ui/Icon";
import { fmtBytes as fmtSize } from "../composer/uploads";

// The room's attachments as a browsable shelf: every photo, video,
// clip and file shared in the room, newest first, filterable by
// kind and sender, each opening in the room's full-screen viewer
// with a jump back to the message it belongs to. The data is the
// /attachments listing (the same one the MCP list_attachments tool
// serves agents); paging rides its cursor.

type Group = "all" | "image" | "video" | "audio" | "files";
const GROUPS: { id: Group; label: string; kind?: string }[] = [
  { id: "all", label: "All" },
  { id: "image", label: "Photos", kind: "image" },
  { id: "video", label: "Videos", kind: "video" },
  { id: "audio", label: "Audio", kind: "audio,speak" },
  { id: "files", label: "Files", kind: "html,doc,file" },
];

function fmtBytes(n: number): string {
  return n ? fmtSize(n) : "";
}

function groupCount(counts: Record<string, number> | null, g: Group): number {
  if (!counts) return 0;
  if (g === "all") return counts.all || 0;
  if (g === "image") return counts.image || 0;
  if (g === "video") return counts.video || 0;
  if (g === "audio") return (counts.audio || 0) + (counts.speak || 0);
  return (counts.html || 0) + (counts.doc || 0) + (counts.file || 0);
}

const KIND_LABEL: Record<Attachment["kind"], string> = {
  image: "Photo",
  video: "Video",
  audio: "Audio",
  speak: "Voice",
  html: "Page",
  doc: "Doc",
  file: "File",
};

// The citation form agents resolve: permanent message id + kind.
export function refOf(a: Attachment): string {
  return "msg " + a.id + " · " + a.kind;
}

export function MediaView({ active, onJump }: { active: boolean; onJump: (id: number) => void }) {
  const { client } = useSession();
  const { names, memberSet } = useMembers();
  const { openViewer, closeViewer } = useFeed();
  const [group, setGroup] = useState<Group>("all");
  const [sender, setSender] = useState("");
  const [items, setItems] = useState<Attachment[]>([]);
  const [counts, setCounts] = useState<Record<string, number> | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // A callback ref: the sentinel unmounts on an empty result and comes
  // back later, and the observer must follow the element it watches.
  const [sentinel, setSentinel] = useState<HTMLDivElement | null>(null);
  const stateRef = useRef({ group, sender, cursor, loading });
  stateRef.current = { group, sender, cursor, loading };
  // Each listing request takes a number; only the newest one may land,
  // so a filter tap mid-load replaces the load instead of being dropped.
  const seqRef = useRef(0);
  const lastFetchRef = useRef(0);
  const memberSetRef = useRef(memberSet);
  memberSetRef.current = memberSet;

  const fetchPage = useCallback(
    async (before: string | null, replace: boolean) => {
      const st = stateRef.current;
      // a next page waits for whatever is loading; a fresh listing wins
      if (!replace && st.loading) return;
      const seq = ++seqRef.current;
      stateRef.current = { ...st, loading: true };
      setLoading(true);
      setError(null);
      try {
        const g = GROUPS.find((x) => x.id === st.group);
        const d = await client.attachments({
          kind: g && g.kind ? g.kind : undefined,
          from: st.sender || undefined,
          before: before || undefined,
          limit: 60,
        });
        if (seq !== seqRef.current) return;
        lastFetchRef.current = Date.now();
        setCounts(d.counts as unknown as Record<string, number>);
        setCursor(d.next_cursor);
        setItems((prev) => (replace ? d.attachments : [...prev, ...d.attachments]));
        setLoaded(true);
      } catch (e) {
        if (seq === seqRef.current) setError(e instanceof Error ? e.message : "Couldn't load attachments.");
      } finally {
        if (seq === seqRef.current) setLoading(false);
      }
    },
    [client]
  );

  // First load on activation; a quiet refresh when the shelf is
  // reopened after a while (new shares land here, not in a stream).
  useEffect(() => {
    if (!active) return;
    if (!loaded || Date.now() - lastFetchRef.current > 30000) void fetchPage(null, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  // Filter changes restart the listing - but only once the shelf has
  // been opened, so entering a room never fetches it speculatively.
  const firstFilterRun = useRef(true);
  useEffect(() => {
    if (firstFilterRun.current) {
      firstFilterRun.current = false;
      return;
    }
    if (loaded || active) void fetchPage(null, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [group, sender]);

  // Infinite scroll: the sentinel sits after the grid.
  useEffect(() => {
    const root = scrollRef.current;
    const el = sentinel;
    if (!root || !el || !window.IntersectionObserver) return;
    const io = new IntersectionObserver(
      (es) => {
        if (es.some((e) => e.isIntersecting)) {
          const st = stateRef.current;
          if (st.cursor && !st.loading) void fetchPage(st.cursor, false);
        }
      },
      { root, rootMargin: "400px" }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [fetchPage, sentinel]);

  const openItem = (a: Attachment) => {
    const when = new Date(a.ts).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    openViewer(
      KIND_LABEL[a.kind] + " · " + a.from,
      (vb) => {
        if (a.kind === "image") {
          const img = document.createElement("img");
          img.className = "viewer-img";
          img.src = a.url;
          img.alt = a.text || "Attached image";
          vb.appendChild(img);
        } else if (a.kind === "video") {
          const v = document.createElement("video");
          v.className = "viewer-img";
          v.src = a.url;
          v.controls = true;
          v.autoplay = true;
          v.playsInline = true;
          vb.appendChild(v);
        } else if (a.kind === "audio" || a.kind === "speak") {
          const wrap = document.createElement("div");
          wrap.className = "media-audio-view";
          const au = document.createElement("audio");
          au.src = a.url;
          au.controls = true;
          au.autoplay = true;
          wrap.appendChild(au);
          vb.appendChild(wrap);
        } else if (a.kind === "file") {
          // a general file is never opened in the page: a card, and the download
          const card = document.createElement("div");
          card.className = "viewer-file";
          const nm = document.createElement("div");
          nm.className = "viewer-file-name";
          nm.textContent = a.name || "file";
          const sz = document.createElement("div");
          sz.className = "viewer-file-meta";
          sz.textContent = fmtBytes(a.bytes) + (a.type && a.type !== "application/octet-stream" ? " · " + a.type : "");
          const dl = document.createElement("a");
          dl.className = "btn primary";
          dl.href = a.url;
          dl.setAttribute("download", a.name || "file");
          dl.textContent = "Download";
          card.append(nm, sz, dl);
          vb.appendChild(card);
        } else if (a.kind === "html") {
          const f = document.createElement("iframe");
          f.className = "viewer-frame";
          f.src = a.url;
          f.title = a.name || "Shared page";
          f.setAttribute("sandbox", "allow-scripts");
          vb.appendChild(f);
        } else {
          const d = document.createElement("div");
          d.className = "viewer-doc";
          const p0 = document.createElement("p");
          p0.className = "md-p";
          p0.textContent = "Loading document…";
          d.appendChild(p0);
          vb.appendChild(d);
          loadDoc(a.id, a.url)
            .then((text) => {
              d.textContent = "";
              d.appendChild(md(text, memberSetRef.current));
            })
            .catch(() => {
              d.textContent = "";
              const p = document.createElement("p");
              p.className = "md-p";
              p.textContent = "Couldn't load the document - use Download to read it.";
              d.appendChild(p);
            });
        }
        const cap = document.createElement("div");
        cap.className = "media-cap";
        const meta = document.createElement("div");
        meta.className = "media-cap-meta";
        meta.textContent = a.from + " · " + when + (a.bytes ? " · " + fmtBytes(a.bytes) : "");
        cap.appendChild(meta);
        const body = a.kind === "audio" && a.transcript ? a.transcript : a.text;
        if (body) {
          const t = document.createElement("p");
          t.className = "media-cap-text";
          t.textContent = body;
          cap.appendChild(t);
        }
        const refRow = document.createElement("div");
        refRow.className = "media-cap-ref";
        const code = document.createElement("code");
        code.textContent = refOf(a);
        refRow.appendChild(code);
        const copyBtn = document.createElement("button");
        copyBtn.type = "button";
        copyBtn.className = "btn sm";
        copyBtn.textContent = "Copy reference";
        copyBtn.addEventListener("click", () => {
          const done = (label: string) => {
            copyBtn.textContent = label;
            window.setTimeout(() => {
              copyBtn.textContent = "Copy reference";
            }, 1600);
          };
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(refOf(a)).then(
              () => done("Copied"),
              () => done("Copy failed")
            );
          } else {
            // No clipboard API (older webview): select the text so a
            // long-press copy still gets the exact citation.
            const range = document.createRange();
            range.selectNodeContents(code);
            const sel = window.getSelection();
            if (sel) {
              sel.removeAllRanges();
              sel.addRange(range);
            }
            done("Selected");
          }
        });
        refRow.appendChild(copyBtn);
        cap.appendChild(refRow);
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "btn sm media-jump";
        btn.textContent = "View in chat";
        btn.addEventListener("click", () => {
          closeViewer();
          onJump(a.id);
        });
        cap.appendChild(btn);
        vb.appendChild(cap);
      },
      a.url
    );
  };

  return (
    <div className="media-view">
      <div className="media-bar">
        <div className="seg" role="group" aria-label="Kind of attachment">
          {GROUPS.map((g) => (
            <button
              key={g.id}
              type="button"
              aria-pressed={group === g.id}
              onClick={() => setGroup(g.id)}
            >
              {g.label}
              {counts ? <span className="media-n">{groupCount(counts, g.id)}</span> : null}
            </button>
          ))}
        </div>
        <span className="sp"></span>
        <select
          className="media-from"
          aria-label="Shared by"
          value={sender}
          onChange={(e) => setSender(e.target.value)}
        >
          <option value="">Everyone</option>
          {names.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      </div>
      <div className="media-scroll" ref={scrollRef}>
        {error && !items.length ? (
          <div className="media-note">
            <p>{error}</p>
            <button type="button" className="btn" onClick={() => void fetchPage(null, true)}>
              Try again
            </button>
          </div>
        ) : loaded && !items.length && !loading ? (
          <div className="media-note">
            <p>
              {counts && counts.all === 0 && !sender
                ? "Nothing shared yet. Photos, videos, clips and files posted in chat will collect here."
                : "Nothing matches this filter yet."}
            </p>
          </div>
        ) : (
          <>
            <div className="media-grid">
              {items.map((a) => (
                <button
                  key={a.id + ":" + a.kind}
                  type="button"
                  className="media-tile"
                  onClick={() => openItem(a)}
                  aria-label={KIND_LABEL[a.kind] + " from " + a.from + ", " + rel(a.ts)}
                >
                  <span className="media-thumb">
                    {a.kind === "image" ? (
                      <img src={a.url} alt="" loading="lazy" />
                    ) : a.kind === "video" ? (
                      <>
                        <video src={a.url} preload="metadata" muted playsInline />
                        <span className="media-play" aria-hidden="true">
                          <I d={["M8 5v14l11-7z"]} />
                        </span>
                      </>
                    ) : a.kind === "audio" || a.kind === "speak" ? (
                      <span className="media-glyph" aria-hidden="true">
                        <I d={["M4 10v4h3l5 4V6l-5 4H4z", "M15.5 9.5a4 4 0 0 1 0 5", "M18 7a7.5 7.5 0 0 1 0 10"]} />
                      </span>
                    ) : (
                      <span className="media-glyph" aria-hidden="true">
                        <I d={["M7 3h7l4 4v14H7z", "M14 3v4h4", "M10 12h5M10 16h5"]} />
                      </span>
                    )}
                    <span className="media-kind">{KIND_LABEL[a.kind]}</span>
                  </span>
                  <span className="media-meta">
                    <span className="media-from-name">{a.kind === "html" || a.kind === "doc" || a.kind === "file" ? a.name || a.from : a.from}</span>
                    <span className="media-when">{rel(a.ts)}</span>
                  </span>
                  {(a.kind === "html" || a.kind === "doc" || a.kind === "file" || a.kind === "audio") && (a.name || a.transcript || a.text) ? (
                    <span className="media-sub">{a.kind === "doc" || a.kind === "html" || a.kind === "file" ? a.from + " · " + fmtBytes(a.bytes) : a.transcript || a.text}</span>
                  ) : null}
                  <span className="media-ref">{refOf(a)}</span>
                </button>
              ))}
            </div>
            <div ref={setSentinel} className="media-sentinel" aria-hidden="true"></div>
            {loading ? <p className="media-note-sm">Loading…</p> : null}
            {loaded && !cursor && items.length > 0 ? <p className="media-note-sm">That's everything the room has kept.</p> : null}
          </>
        )}
      </div>
    </div>
  );
}
