import { useEffect, useRef, useState } from "react";
import type { Member, MembersResponse } from "@chat/shared";
import { same, toast } from "../lib";
import { Avatar, KindTag } from "../feed/feed";
import { errText, type BoardApi } from "./shared";

// Your photo: file validation, the canvas downscale (animated GIFs
// pass through untouched), the upload, and the dialog.

const AVATAR_MAX = 2000000;

function prepPhoto(f: File): Promise<Blob> {
  if (f.type === "image/gif") {
    return f.size > AVATAR_MAX
      ? Promise.reject(new Error("That GIF is too large. Photos can be up to 2 MB."))
      : Promise.resolve(f);
  }
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(f);
    const im = new Image();
    im.onload = () => {
      URL.revokeObjectURL(url);
      const side = Math.min(im.naturalWidth, im.naturalHeight);
      const size = Math.min(256, side);
      if (!side) {
        reject(new Error("Couldn't read that image."));
        return;
      }
      const c = document.createElement("canvas");
      c.width = c.height = size;
      c.getContext("2d")!.drawImage(im, (im.naturalWidth - side) / 2, (im.naturalHeight - side) / 2, side, side, 0, 0, size, size);
      c.toBlob((b) => {
        if (b && b.type === "image/webp") {
          resolve(b);
          return;
        }
        const j = document.createElement("canvas");
        j.width = j.height = size;
        const ctx = j.getContext("2d")!;
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, size, size);
        ctx.drawImage(c, 0, 0);
        j.toBlob((jb) => (jb ? resolve(jb) : reject(new Error("Couldn't read that image."))), "image/jpeg", 0.88);
      }, "image/webp", 0.86);
    };
    im.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Couldn't read that image. Use a PNG, JPEG, WebP or GIF."));
    };
    im.src = url;
  });
}

// The hidden file input + upload flow (the current app creates the
// input the same way). Render `el` once; openPicker clicks it.
export function usePhotoUpload(api: Pick<BoardApi, "putAvatar" | "loadAll">) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const el = (
    <input
      ref={inputRef}
      type="file"
      accept="image/png,image/jpeg,image/webp,image/gif"
      hidden
      onChange={async (e) => {
        const f = e.currentTarget.files && e.currentTarget.files[0];
        e.currentTarget.value = "";
        if (!f) return;
        try {
          const blob = await prepPhoto(f);
          await api.putAvatar(blob);
          toast("Photo updated");
          await api.loadAll();
        } catch (err) {
          toast(errText(err), true);
        }
      }}
    />
  );
  return {
    el,
    openPicker: () => inputRef.current?.click(),
  };
}

/* ---------- avatar dialog ---------- */

export function AvatarDialog({
  name,
  mb,
  invite,
  onClose,
}: {
  name: string | null;
  mb: MembersResponse | null;
  invite: string;
  onClose: () => void;
}) {
  const dlgRef = useRef<HTMLDialogElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    const dlg = dlgRef.current;
    if (!dlg) return;
    if (name && !dlg.open) {
      dlg.showModal();
      closeRef.current?.focus();
    }
    if (!name && dlg.open) dlg.close();
  }, [name]);
  const member = name ? (mb?.members || []).find((m) => same(m.name, name)) : undefined;
  const avatars: Record<string, string> = {};
  (mb?.members || []).forEach((m) => {
    if (m.avatar) avatars[m.name.toLowerCase()] = m.avatar;
  });
  const isClaude = !!name && same(name, "claude");
  const kind = isClaude ? null : member?.kind;
  return (
    <dialog
      className="av-dlg"
      id="avDlg"
      ref={dlgRef}
      aria-label="Member picture"
      onClose={onClose}
      onClick={(e) => {
        if (e.target === e.currentTarget) e.currentTarget.close();
      }}
    >
      {name && (
        <>
          <div className="av-big" id="avBig">
            <Avatar
              name={name}
              ctx={{ avatars, invite, onAvatar: () => {}, xl: true }}
            />
          </div>
          <div className="title-row">
            <span className="av-name" id="avName">
              {name}
            </span>
            <span id="avKind">
              {isClaude ? (
                <span className="tag k-agent">Bot</span>
              ) : kind ? (
                <KindTag kind={kind} />
              ) : null}
            </span>
          </div>
          <button type="button" className="btn sm" id="avClose" ref={closeRef} onClick={() => dlgRef.current?.close()}>
            Close
          </button>
        </>
      )}
    </dialog>
  );
}

/* ---------- the six pages ---------- */
