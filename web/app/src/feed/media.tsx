import { useEffect, useRef, useState } from "react";
import { useFeed, useMembers, useSession } from "../room/ctx";
import type { Message } from "@chat/shared";
import { md } from "./markdown";
import type { ViewerApi } from "../shell/viewer";
import { GameCardBlock } from "../games/gamecard";
import type { GameStore } from "../games/games";

// Message media, ported from the current app's msgNode: YouTube link
// cards under the text, then image, video, audio, the HTML page card
// (inert sandboxed preview) and the Markdown document card (rendered
// preview). Cards are previews only — no links or buttons on them;
// tapping opens the full-screen viewer.

export function withInvite(url: string, token: string): string {
  return token ? url + (url.indexOf("?") >= 0 ? "&" : "?") + "invite=" + encodeURIComponent(token) : url;
}

/* ---------- YouTube link cards ---------- */

// The video id is pulled from a strict host + 11-char-id match, and
// the embed URL is built from the id alone, never from the pasted URL.
export function ytId(u: string): string | null {
  const m =
    /^(?:https?:\/\/)?(?:[a-z]+\.)?youtube\.com\/(?:watch\?(?:[^#\s]*&)?v=|shorts\/|embed\/|live\/|v\/)([A-Za-z0-9_-]{11})/.exec(u) ||
    /^(?:https?:\/\/)?youtu\.be\/([A-Za-z0-9_-]{11})/.exec(u) ||
    /^(?:https?:\/\/)?(?:[a-z]+\.)?youtube-nocookie\.com\/embed\/([A-Za-z0-9_-]{11})/.exec(u);
  return m ? m[1]! : null;
}

export function ytLinks(text: string): { id: string; url: string }[] {
  const out: { id: string; url: string }[] = [];
  const seen = new Set<string>();
  const urls = String(text || "").match(/https?:\/\/[^\s<>\[\]()]+/g) || [];
  for (let i = 0; i < urls.length && out.length < 2; i++) {
    const id = ytId(urls[i]!.replace(/[.,;:!?]+$/, ""));
    if (id && !seen.has(id)) {
      seen.add(id);
      out.push({ id, url: urls[i]! });
    }
  }
  return out;
}

const ytTitleCache = new Map<string, string>();

function YtCard({ id, openViewer }: { id: string; openViewer: ViewerApi["open"] }) {
  const [title, setTitle] = useState<string | null>(() => ytTitleCache.get(id) || null);
  useEffect(() => {
    if (ytTitleCache.has(id)) return;
    let live = true;
    fetch(
      "https://www.youtube.com/oembed?url=" +
        encodeURIComponent("https://www.youtube.com/watch?v=" + id) +
        "&format=json"
    )
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { title?: string } | null) => {
        if (j && j.title) {
          ytTitleCache.set(id, j.title);
          if (live) setTitle(j.title);
        }
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [id]);
  const name = title || "Watch on YouTube";
  return (
    <div
      className="yt-card"
      onClick={() =>
        openViewer(
          ytTitleCache.get(id) || "YouTube",
          (vb) => {
            const vf = document.createElement("iframe");
            vf.className = "viewer-frame yt-frame";
            vf.src = "https://www.youtube-nocookie.com/embed/" + id + "?autoplay=1&rel=0";
            vf.title = ytTitleCache.get(id) || "YouTube video";
            vf.setAttribute("allow", "autoplay; encrypted-media; picture-in-picture; fullscreen");
            vf.setAttribute("allowfullscreen", "");
            vb.appendChild(vf);
          },
          null
        )
      }
    >
      <div className="art-head">
        <span className="art-kind">YouTube</span>
        <span className="art-name" title={title || undefined}>
          {name}
        </span>
        <span className="sp"></span>
        <span className="art-go">›</span>
      </div>
      <div className="yt-thumbwrap">
        <img
          className="yt-thumb"
          src={"https://i.ytimg.com/vi/" + id + "/hqdefault.jpg"}
          alt="Video thumbnail"
          loading="lazy"
        />
        <div className="yt-play">▶</div>
      </div>
    </div>
  );
}

/* ---------- Markdown documents ---------- */

const docCache = new Map<number, Promise<string>>();

export function loadDoc(id: number, url: string): Promise<string> {
  let p = docCache.get(id);
  if (!p) {
    p = fetch(url, { cache: "no-store" }).then((r) => {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.text();
    });
    docCache.set(id, p);
    p.catch(() => docCache.delete(id));
  }
  return p;
}

function fillDoc(el: HTMLElement, id: number, url: string, memberSet: Set<string>, errText: string) {
  el.textContent = "";
  const p0 = document.createElement("p");
  p0.className = "md-p";
  p0.textContent = "Loading document…";
  el.appendChild(p0);
  loadDoc(id, url)
    .then((text) => {
      el.textContent = "";
      el.appendChild(md(text, memberSet));
    })
    .catch(() => {
      el.textContent = "";
      const p = document.createElement("p");
      p.className = "md-p";
      p.textContent = errText;
      el.appendChild(p);
    });
}

function DocBody({ id, url, memberSet }: { id: number; url: string; memberSet: Set<string> }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const memberSetRef = useRef(memberSet);
  memberSetRef.current = memberSet;
  useEffect(() => {
    if (ref.current) fillDoc(ref.current, id, url, memberSetRef.current, "Couldn't load the document - tap to try again.");
  }, [id, url]);
  return <div className="doc-body" ref={ref}></div>;
}

/* ---------- the media block under a message's text ---------- */

export function MediaBlocks({ m }: { m: Message }) {
  const { token } = useSession();
  const { memberSet } = useMembers();
  const { openViewer, games } = useFeed();
  const yts = ytLinks(m.text || "");
  if (!yts.length && !m.image && !m.video && !m.audio && !m.html && !m.doc && !m.game) return null;
  const memberSetRef = useRef(memberSet);
  memberSetRef.current = memberSet;
  return (
    <>
      {yts.map((yt) => (
        <YtCard key={yt.id} id={yt.id} openViewer={openViewer} />
      ))}
      {m.image && m.image.url && (
        <img
          className="msg-img"
          src={withInvite(m.image.url, token)}
          alt="Attached image"
          loading="lazy"
          onClick={() => {
            const iurl = withInvite(m.image!.url, token);
            openViewer(
              "Image",
              (vb) => {
                const vi = document.createElement("img");
                vi.className = "viewer-img";
                vi.src = iurl;
                vi.alt = "Attached image";
                vb.appendChild(vi);
              },
              null
            );
          }}
        />
      )}
      {m.video && m.video.url && (
        <video className="msg-video" controls preload="metadata" src={withInvite(m.video.url, token)} />
      )}
      {m.audio && m.audio.url && <audio controls preload="none" src={withInvite(m.audio.url, token)} />}
      {m.html && m.html.url && (
        <div
          className="art-card"
          onClick={() => {
            const hurl = withInvite(m.html!.url, token);
            openViewer(
              m.html!.name || "Page",
              (vb) => {
                const vf = document.createElement("iframe");
                vf.className = "viewer-frame";
                vf.src = hurl;
                vf.title = m.html!.name || "Shared page";
                vf.setAttribute("sandbox", "allow-scripts");
                vb.appendChild(vf);
              },
              null
            );
          }}
        >
          <div className="art-head">
            <span className="art-kind">Page</span>
            <span className="art-name">{m.html.name || "Page"}</span>
            <span className="art-size">{Math.max(1, Math.round((m.html.bytes || 0) / 1024))} KB</span>
            <span className="sp"></span>
            <span className="art-go">›</span>
          </div>
          <iframe
            className="art-frame"
            src={withInvite(m.html.url, token)}
            loading="lazy"
            title={m.html.name || "Shared page"}
            sandbox="allow-scripts"
          />
        </div>
      )}
      {m.doc && m.doc.url && (
        <div
          className="doc-card"
          onClick={() => {
            const durl = withInvite(m.doc!.url, token);
            openViewer(
              m.doc!.name || "Document.md",
              (vb) => {
                const vd = document.createElement("div");
                vd.className = "viewer-doc";
                vb.appendChild(vd);
                fillDoc(vd, m.id, durl, memberSetRef.current, "Couldn't load the document - use Download to read it.");
              },
              withInvite(m.doc!.url, token)
            );
          }}
        >
          <div className="doc-head">
            <span className="art-kind">Doc</span>
            <span className="art-name">{m.doc.name || "Document.md"}</span>
            <span className="art-size">{Math.max(1, Math.round((m.doc.bytes || 0) / 1024))} KB</span>
            <span className="sp"></span>
            <span className="art-go">›</span>
          </div>
          <DocBody id={m.id} url={withInvite(m.doc.url, token)} memberSet={memberSet} />
        </div>
      )}
      {m.game && m.game.id ? <GameCardBlock summary={m.game} /> : null}
    </>
  );
}
