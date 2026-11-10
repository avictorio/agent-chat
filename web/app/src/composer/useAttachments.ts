import { useRef, useState } from "react";
import { toast } from "../lib";
import type { NativePickedFile } from "./uploads";

// The composer's pending attachments: one clip, one image, one
// page/doc, one video (inline data URL, a big File for the chunked
// engine, or a native-shell pick). The file handlers enforce the
// current app's caps and compose its chip labels.

export interface PendingClip {
  data: string;
  name: string;
  label: string;
  transcript?: string | null;
}
export interface PendingImage {
  data: string;
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
  native?: NativePickedFile;
  nativeChunked?: NativePickedFile;
  name: string;
}

export function kb(n: number): string {
  return Math.max(1, Math.round(n / 1024)) + " KB";
}

export function useAttachments() {
  const imgFileRef = useRef<HTMLInputElement | null>(null);
  const clipFileRef = useRef<HTMLInputElement | null>(null);
  const artFileRef = useRef<HTMLInputElement | null>(null);
  const vidFileRef = useRef<HTMLInputElement | null>(null);
  const [clip, setClip] = useState<PendingClip | null>(null);
  const clipRef = useRef<PendingClip | null>(null);
  clipRef.current = clip;
  const [image, setImage] = useState<PendingImage | null>(null);
  const [art, setArt] = useState<PendingArt | null>(null);
  const [video, setVideo] = useState<PendingVideo | null>(null);
  const [vidProgress, setVidProgress] = useState<string | null>(null);

  const readAs = (f: File, mode: "data" | "text"): Promise<string> =>
    new Promise((resolve, reject) => {
      const rd = new FileReader();
      rd.onload = () => resolve(String(rd.result));
      rd.onerror = () => reject(new Error("read failed"));
      if (mode === "data") rd.readAsDataURL(f);
      else rd.readAsText(f);
    });

  const onClipFile = async (f: File | null) => {
    if (!f) return;
    if (f.size > 5000000) {
      toast("Audio clips can be up to 5 MB", true);
      return;
    }
    try {
      const data = await readAs(f, "data");
      setClip({
        data,
        name: f.name,
        label: "🎙 " + f.name + " (" + kb(f.size) + ") - attaches to your next message",
      });
    } catch {
      toast("Couldn't read that file", true);
    }
  };
  const onImgFile = async (f: File | null) => {
    if (!f) return;
    if (f.size > 5000000) {
      toast("Images can be up to 5 MB", true);
      return;
    }
    try {
      const data = await readAs(f, "data");
      setImage({ data, name: f.name + " (" + kb(f.size) + ") - attaches to your next message" });
    } catch {
      toast("Couldn't read that file", true);
    }
  };
  const onArtFile = async (f: File | null) => {
    if (!f) return;
    const isHtml = /\.html?$/i.test(f.name) || f.type === "text/html";
    const isMd = /\.md$|\.markdown$/i.test(f.name) || f.type === "text/markdown";
    if (!isHtml && !isMd) {
      toast("Attach an .html page or a .md document", true);
      return;
    }
    const cap = isHtml ? 2000000 : 1000000;
    if (f.size > cap) {
      toast(isHtml ? "HTML pages can be up to 2 MB" : "Documents can be up to 1 MB", true);
      return;
    }
    try {
      const content = await readAs(f, "text");
      setArt({
        kind: isHtml ? "html" : "doc",
        name: f.name,
        content,
        label: (isHtml ? "🗔 " : "📄 ") + f.name + " (" + kb(f.size) + ") - attaches to your next message",
      });
    } catch {
      toast("Couldn't read that file", true);
    }
  };
  const onVidFile = async (f: File | null) => {
    if (!f) return;
    if (f.size > 5000000000) {
      toast("Videos can be up to 5 GB", true);
      return;
    }
    const label = "🎬 " + f.name + " (" + kb(f.size) + ") - attaches to your next message";
    if (f.size > 25000000) {
      setVideo({ file: f, big: true, name: label });
      return;
    }
    try {
      const data = await readAs(f, "data");
      setVideo({ data, name: label });
    } catch {
      toast("Couldn't read that file", true);
    }
  };
  return {
    clip, clipRef, setClip,
    image, setImage,
    art, setArt,
    video, setVideo,
    vidProgress, setVidProgress,
    imgFileRef, clipFileRef, artFileRef, vidFileRef,
    onClipFile, onImgFile, onArtFile, onVidFile,
  };
}
