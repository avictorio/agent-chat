import { ApiError, type RoomClient, type Message } from "@chat/shared";

// Big-video upload, ported from the current app: the file goes up
// under a draft (the message does not officially post until the
// upload completes and the draft is published), in 10 MB parts
// with per-part retries, resuming from the parts the server already
// has — re-attaching the same file picks up where it left off,
// found again by the file's head+tail SHA-256 fingerprint.

function denied(e: unknown): boolean {
  return e instanceof ApiError && (e.status === 401 || e.status === 403);
}

export async function fileFingerprint(file: File): Promise<string | null> {
  try {
    const head = await file.slice(0, 65536).arrayBuffer();
    const tail = await file.slice(Math.max(0, file.size - 65536)).arrayBuffer();
    const buf = new Uint8Array(head.byteLength + tail.byteLength);
    buf.set(new Uint8Array(head), 0);
    buf.set(new Uint8Array(tail), head.byteLength);
    const digest = await crypto.subtle.digest("SHA-256", buf);
    const hex = Array.from(new Uint8Array(digest))
      .map((b) => ("0" + b.toString(16)).slice(-2))
      .join("");
    return hex + "-" + file.size;
  } catch {
    return null;
  }
}

async function uploadBigVideo(
  client: RoomClient,
  id: number,
  file: File,
  fp: string | null,
  onProgress: (label: string) => void
): Promise<void> {
  let wake: WakeLockSentinel | null = null;
  try {
    if (navigator.wakeLock) wake = await navigator.wakeLock.request("screen");
  } catch {
    // wake lock is best-effort
  }
  try {
    let sd: { part_size: number; parts: number };
    try {
      sd = await client.videoStart(id, {
        type: file.type || "video/mp4",
        size: file.size,
        fingerprint: fp || undefined,
      });
    } catch (e) {
      throw new Error(denied(e) ? "Upload was denied" : e instanceof Error ? e.message : String(e));
    }
    const partSize = sd.part_size;
    const total = sd.parts;
    const have = new Set<number>();
    let statusOk = false;
    try {
      const st = await client.videoStatus(id);
      statusOk = true;
      (st.received || []).forEach((n) => have.add(n));
    } catch {
      // status unavailable: upload everything, sequentially
    }
    const todoNums: number[] = [];
    for (let n = 1; n <= total; n++) if (!have.has(n)) todoNums.push(n);
    let doneParts = total - todoNums.length;
    let idx = 0;
    let failure: Error | null = null;
    async function worker() {
      while (idx < todoNums.length && !failure) {
        const n = todoNums[idx++]!;
        const blob = file.slice((n - 1) * partSize, Math.min(n * partSize, file.size));
        let done = false;
        let lastErr: Error | null = null;
        for (let attempt = 0; attempt < 3 && !done; attempt++) {
          try {
            await client.videoPart(id, n, blob);
            done = true;
          } catch (e) {
            if (denied(e)) throw new Error("Upload was denied");
            lastErr = e instanceof Error ? e : new Error(String(e));
          }
        }
        if (!done) {
          failure = lastErr || new Error("Part " + n + " failed");
          return;
        }
        doneParts++;
        onProgress(
          "🎬 Uploading " +
            file.name +
            " - " +
            Math.round((doneParts / total) * 100) +
            "% (" +
            doneParts +
            " of " +
            total +
            " parts)"
        );
      }
    }
    const pool: Promise<void>[] = [];
    // Parallel only when the status endpoint answered: a room still
    // running the previous deploy's code records part receipts as one
    // list, which concurrent uploads would clobber.
    for (let w = 0; w < Math.min(statusOk ? 4 : 1, todoNums.length); w++) pool.push(worker());
    await Promise.all(pool);
    if (failure) throw failure;
    try {
      await client.videoFinish(id);
    } catch (e) {
      throw new Error(denied(e) ? "Upload was denied" : e instanceof Error ? e.message : String(e));
    }
  } finally {
    if (wake) {
      try {
        wake.release();
      } catch {
        // already released
      }
    }
  }
}

export async function sendBigVideo(
  client: RoomClient,
  room: string,
  from: string,
  text: string,
  file: File,
  onProgress: (label: string) => void
): Promise<Message> {
  const fp = await fileFingerprint(file);
  const draftKey = "chat-draft:" + room + ":" + (fp || file.name);
  let id: number | null = null;
  try {
    const saved = JSON.parse(localStorage.getItem(draftKey) || "null") as { id?: number } | null;
    if (saved && saved.id) {
      const cj = await client.videoStatus(saved.id);
      if (cj.uploading) id = saved.id;
    }
  } catch {
    // no resumable local draft
  }
  if (!id && fp) {
    try {
      const rj = await client.videoResume(file.size, fp);
      if (rj.found && rj.id) id = rj.id;
    } catch {
      // resume lookup is best-effort
    }
  }
  if (!id) {
    let pd: Message;
    try {
      pd = await client.createDraft(from, text);
    } catch (e) {
      throw new Error(denied(e) ? "Posting was denied" : e instanceof Error ? e.message : String(e));
    }
    id = pd.id;
    try {
      localStorage.setItem(draftKey, JSON.stringify({ id }));
    } catch {
      // storage unavailable
    }
  }
  await uploadBigVideo(client, id, file, fp, onProgress);
  try {
    const fj = await client.publishMessage(id, text);
    try {
      localStorage.removeItem(draftKey);
    } catch {
      // storage unavailable
    }
    return fj;
  } catch (e) {
    if (denied(e)) throw new Error("Publishing was denied");
    // A room still running the previous deploy's code has drafts
    // neither in its post path nor a publish method: the message went
    // live the old way at create time. Verify it is there with its
    // video and show it; anything else is a real failure.
    try {
      const ld = await client.messages(id - 1, 1);
      const got = (ld.messages || []).find((x) => x.id === id);
      if (got && got.video) {
        try {
          localStorage.removeItem(draftKey);
        } catch {
          // storage unavailable
        }
        return got;
      }
    } catch {
      // fall through to the failure
    }
    throw new Error("Publish failed");
  }
}

/* ---------- native shell legs (Capacitor) ----------
   In the app shell the video picker is native, so the uploader
   gets a real file path, not a Blob. Small picks are read back
   through the Filesystem plugin and ride the normal inline path;
   25-100 MB rides ONE background PUT to the streaming ingest under
   a publish_on_complete draft; over 100 MB the in-app chunked
   uploader drives the same chunked API as the web flow, with the
   fingerprint computed natively. Both native legs settle through
   an event listener backed by a liveness poll, so an early or lost
   event can never wedge the composer. */

import { inShell, nativePlugins } from "../shell/shell";
import type { RoomState } from "@chat/shared";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface NativePickedFile {
  path?: string;
  name?: string;
  size: number;
  mimeType?: string;
}

export type NativePick =
  | { kind: "inline"; data: string; name: string }
  | { kind: "stream"; file: NativePickedFile; name: string }
  | { kind: "chunked"; file: NativePickedFile; name: string };

export function tryNativeVideoPick(opts: {
  onPicked: (v: NativePick) => void;
  toast: (msg: string, err?: boolean) => void;
  fallback: () => void;
}): boolean {
  const P = nativePlugins();
  if (!inShell() || !P || !P.FilePicker) return false;
  void P.FilePicker.pickFiles({ types: ["video/mp4", "video/webm", "video/quicktime"], limit: 1 })
    .then(async (res: any) => {
      const f: NativePickedFile | undefined = res && res.files && res.files[0];
      if (!f) return;
      if (!f.path) {
        opts.fallback();
        return;
      }
      if (f.size > 5000000000) {
        opts.toast("Videos can be up to 5 GB", true);
        return;
      }
      const label =
        "🎬 " + (f.name || "video") + " (" + Math.max(1, Math.round(f.size / 1024)) + " KB) - attaches to your next message";
      if (f.size > 100000000 && P.ChunkedUploader) {
        opts.onPicked({ kind: "chunked", file: f, name: label });
        return;
      }
      if (f.size > 25000000 && P.Uploader) {
        opts.onPicked({ kind: "stream", file: f, name: label });
        return;
      }
      if (f.size > 25000000) {
        opts.toast("That video is too large for the in-page uploader in this build", true);
        return;
      }
      try {
        const rf = await P.Filesystem.readFile({ path: f.path });
        opts.onPicked({ kind: "inline", data: "data:" + (f.mimeType || "video/mp4") + ";base64," + rf.data, name: label });
      } catch {
        opts.toast("Couldn't read that file", true);
      }
    })
    .catch(() => {});
  return true;
}

type PostedMessage = Message & { room_state?: RoomState };

async function fetchIfLive(client: RoomClient, id: number): Promise<PostedMessage | null> {
  const ld = await client.messages(id - 1, 1);
  return (ld.messages || []).filter((x) => x.id === id)[0] || null;
}

async function fetchLiveOrPublish(client: RoomClient, id: number, text: string): Promise<PostedMessage> {
  const got = await fetchIfLive(client, id);
  if (got) return got;
  return client.publishMessage(id, text);
}

export async function sendBigVideoNative(
  client: RoomClient,
  from: string,
  text: string,
  f: NativePickedFile,
  onLabel: (label: string) => void
): Promise<PostedMessage> {
  const pd = await client.createDraft(from, text, true);
  const id = pd.id;
  const P = nativePlugins();
  const done = new Promise<PostedMessage>((resolve, reject) => {
    let settled = false;
    let sub: any = null;
    let poll: number | null = null;
    const settle = (fn: (v: any) => void, val: any) => {
      if (settled) return;
      settled = true;
      if (poll) clearInterval(poll);
      Promise.resolve(sub)
        .then((h: any) => {
          if (h && h.remove) h.remove();
        })
        .catch(() => {});
      fn(val);
    };
    sub = P.Uploader.addListener("events", (ev: any) => {
      if (settled || !ev) return;
      if (ev.name === "uploading" && ev.payload && typeof ev.payload.percent === "number" && ev.payload.percent >= 0) {
        onLabel("🎬 Uploading " + (f.name || "video") + " - " + Math.round(ev.payload.percent) + "%");
        return;
      }
      if (ev.name === "completed") {
        fetchLiveOrPublish(client, id, text)
          .then((m) => settle(resolve, m))
          .catch((e) => settle(reject, e));
        return;
      }
      if (ev.name === "failed") settle(reject, new Error((ev.payload && ev.payload.error) || "the upload failed"));
    });
    poll = window.setInterval(() => {
      fetchIfLive(client, id)
        .then((mm) => {
          if (mm) settle(resolve, mm);
        })
        .catch(() => {});
    }, 5000);
    window.setTimeout(() => settle(reject, new Error("the upload timed out")), 600000);
  });
  await P.Uploader.startUpload({
    filePath: f.path,
    serverUrl: location.origin + client.basePath() + "/messages/" + id + "/video/stream",
    method: "PUT",
    headers: { "X-Invite-Token": client.inviteToken() || "", "Content-Type": f.mimeType || "video/mp4" },
    notificationTitle: "Agent Chat",
    notificationBody: "Uploading " + (f.name || "video"),
  });
  return done;
}

export async function sendBigVideoChunkedNative(
  client: RoomClient,
  from: string,
  text: string,
  f: NativePickedFile,
  onLabel: (label: string) => void
): Promise<PostedMessage> {
  const P = nativePlugins();
  let fp: string | null = null;
  try {
    const fres = await P.ChunkedUploader.fingerprint({ filePath: f.path, size: f.size });
    fp = fres && fres.fingerprint;
  } catch {
    // no fingerprint: no resume, a fresh draft below
  }
  let id: number | null = null;
  if (fp) {
    try {
      const rj = await client.videoResume(f.size, fp);
      if (rj.found && rj.id) id = rj.id;
    } catch {
      // resume is best-effort
    }
  }
  if (!id) {
    const pd = await client.createDraft(from, text, true);
    id = pd.id;
  }
  const mid = id;
  const done = new Promise<PostedMessage>((resolve, reject) => {
    let settled = false;
    let sub: any = null;
    let poll: number | null = null;
    const settle = (fn: (v: any) => void, val: any) => {
      if (settled) return;
      settled = true;
      if (poll) clearInterval(poll);
      Promise.resolve(sub)
        .then((h: any) => {
          if (h && h.remove) h.remove();
        })
        .catch(() => {});
      fn(val);
    };
    sub = P.ChunkedUploader.addListener("chunkedEvents", (ev: any) => {
      if (settled || !ev || String(ev.key) !== String(mid)) return;
      if (ev.name === "progress" && typeof ev.percent === "number" && ev.percent >= 0) {
        onLabel("🎬 Uploading " + (f.name || "video") + " - " + Math.round(ev.percent) + "% (background-safe: you can switch apps)");
        return;
      }
      if (ev.name === "completed") {
        fetchLiveOrPublish(client, mid, text)
          .then((m) => settle(resolve, m))
          .catch((e) => settle(reject, e));
        return;
      }
      if (ev.name === "failed") settle(reject, new Error(ev.error || "the upload failed"));
    });
    poll = window.setInterval(() => {
      fetchIfLive(client, mid)
        .then((mm) => {
          if (mm) settle(resolve, mm);
        })
        .catch(() => {});
    }, 5000);
    window.setTimeout(() => settle(reject, new Error("the upload timed out")), 900000);
  });
  await P.ChunkedUploader.start({
    key: String(mid),
    apiBase: location.origin + client.basePath() + "/messages",
    id: mid,
    token: client.inviteToken() || "",
    filePath: f.path,
    type: f.mimeType || "video/mp4",
    size: f.size,
    fingerprint: fp || "",
    name: f.name || "video",
  });
  return done;
}
