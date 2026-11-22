import { useEffect, useRef, useState } from "react";
import { toast } from "../../lib/index";
import { fmtBytes, sniffKind } from "./uploads";
import { useLatest } from "../../lib/useLatest";

// The composer's pending attachments: one clip, one image, one video,
// one page/doc and one general file per message (the server keeps one
// attachment of each kind on a message). Small images, clips and
// videos ride inline in the post as data URLs; anything bigger, and
// every general file, keeps its File and goes up through the resumable
// upload engine (uploads.ts) - there is no size cap here beyond the
// server's. A pick is routed by what its bytes
// are, not by the button it came through: a photo type the chat can't
// show (HEIC, SVG...) still attaches, as a file to download.

export const INLINE_MAX = { image: 5000000, audio: 5000000, video: 25000000 };

export interface PendingClip {
  data?: string;
  blob?: Blob;
  name: string;
  label: string;
  transcript?: string | null;
}
export interface PendingImage {
  data?: string;
  file?: File;
  thumb: string;
  big?: boolean;
  name: string;
}
export interface PendingArt {
  kind: "html" | "doc";
  name: string;
  content: string;
  label: string;
}
export interface PendingVideo {
  data?: string;
  file?: File;
  big?: boolean;
  name: string;
}
export interface PendingFile {
  file: File;
  label: string;
}

export function kb(n: number): string {
  return fmtBytes(n);
}

const later = " - attaches to your next message";

export function useAttachments() {
  const imgFileRef = useRef<HTMLInputElement | null>(null);
  const clipFileRef = useRef<HTMLInputElement | null>(null);
  const artFileRef = useRef<HTMLInputElement | null>(null);
  const vidFileRef = useRef<HTMLInputElement | null>(null);
  const anyFileRef = useRef<HTMLInputElement | null>(null);
  const [clip, setClip] = useState<PendingClip | null>(null);
  const clipRef = useLatest(clip);
  const [image, setImage] = useState<PendingImage | null>(null);
  const [art, setArt] = useState<PendingArt | null>(null);
  const [video, setVideo] = useState<PendingVideo | null>(null);
  const [fileAtt, setFileAtt] = useState<PendingFile | null>(null);

  // A big image previews from an object URL (no copy of its bytes in a
  // data URL); let it go when the image is sent or removed.
  const thumb = image ? image.thumb : null;
  useEffect(() => {
    return () => {
      if (thumb && thumb.startsWith("blob:")) URL.revokeObjectURL(thumb);
    };
  }, [thumb]);

  const readAs = (f: Blob, mode: "data" | "text"): Promise<string> =>
    new Promise((resolve, reject) => {
      const rd = new FileReader();
      rd.onload = () => resolve(String(rd.result));
      rd.onerror = () => reject(new Error("read failed"));
      if (mode === "data") rd.readAsDataURL(f);
      else rd.readAsText(f);
    });

  const asFile = (f: File, note?: string) => {
    if (note) toast(note);
    setFileAtt({ file: f, label: "📎 " + f.name + " (" + fmtBytes(f.size) + ")" + later });
  };

  const takeImage = async (f: File) => {
    const label = f.name + " (" + fmtBytes(f.size) + ")" + later;
    if (f.size > INLINE_MAX.image) {
      setImage({ file: f, big: true, thumb: URL.createObjectURL(f), name: label });
      return;
    }
    try {
      const data = await readAs(f, "data");
      setImage({ data, file: f, thumb: data, name: label });
    } catch {
      toast("Couldn't read that file", true);
    }
  };
  const takeClip = async (f: File) => {
    const label = "🎙 " + f.name + " (" + fmtBytes(f.size) + ")" + later;
    if (f.size > INLINE_MAX.audio) {
      setClip({ blob: f, name: f.name, label });
      return;
    }
    try {
      const data = await readAs(f, "data");
      setClip({ data, blob: f, name: f.name, label });
    } catch {
      toast("Couldn't read that file", true);
    }
  };
  const takeVideo = async (f: File) => {
    const label = "🎬 " + f.name + " (" + fmtBytes(f.size) + ")" + later;
    if (f.size > INLINE_MAX.video) {
      setVideo({ file: f, big: true, name: label });
      return;
    }
    try {
      const data = await readAs(f, "data");
      setVideo({ data, file: f, name: label });
    } catch {
      toast("Couldn't read that file", true);
    }
  };

  const onImgFile = async (f: File | null) => {
    if (!f) return;
    if ((await sniffKind(f)) !== "image") return asFile(f, "That image type can't be shown in the chat - it attaches as a file to download");
    await takeImage(f);
  };
  const onClipFile = async (f: File | null) => {
    if (!f) return;
    if ((await sniffKind(f)) !== "audio") return asFile(f, "That audio type can't be played in the chat - it attaches as a file to download");
    await takeClip(f);
  };
  const onVidFile = async (f: File | null) => {
    if (!f) return;
    if ((await sniffKind(f)) !== "video") return asFile(f, "That video type can't be played in the chat - it attaches as a file to download");
    await takeVideo(f);
  };
  const onArtFile = async (f: File | null) => {
    if (!f) return;
    const isHtml = /\.html?$/i.test(f.name) || f.type === "text/html";
    const isMd = /\.md$|\.markdown$/i.test(f.name) || f.type === "text/markdown";
    if (!isHtml && !isMd) return asFile(f, "Not a page or Markdown document - it attaches as a file to download");
    const cap = isHtml ? 2000000 : 1000000;
    if (f.size > cap)
      return asFile(f, (isHtml ? "Pages over 2 MB" : "Documents over 1 MB") + " can't be previewed - it attaches as a file to download");
    try {
      const content = await readAs(f, "text");
      setArt({
        kind: isHtml ? "html" : "doc",
        name: f.name,
        content,
        label: (isHtml ? "🗔 " : "📄 ") + f.name + " (" + fmtBytes(f.size) + ")" + later,
      });
    } catch {
      toast("Couldn't read that file", true);
    }
  };
  // The paperclip: any file at all. A photo, clip or video the chat can
  // show goes in its own slot (when that slot is free); the rest is a
  // file to download.
  const onAnyFile = async (f: File | null) => {
    if (!f) return;
    const k = await sniffKind(f);
    if (k === "image" && !image) return takeImage(f);
    if (k === "video" && !video) return takeVideo(f);
    if (k === "audio" && !clip) return takeClip(f);
    if (fileAtt) toast("One file per message: " + f.name + " replaces " + fileAtt.file.name);
    asFile(f);
  };
  return {
    clip, clipRef, setClip,
    image, setImage,
    art, setArt,
    video, setVideo,
    fileAtt, setFileAtt,
    imgFileRef, clipFileRef, artFileRef, vidFileRef, anyFileRef,
    onClipFile, onImgFile, onArtFile, onVidFile, onAnyFile,
  };
}
