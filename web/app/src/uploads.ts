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
