import { ApiError, type Message, type RoomClient, type UploadKind } from "@chat/shared";

// Resumable uploads for every kind of attachment (the server's upload
// engine: see UPLOADING FILES in GET /api). A message with a big
// attachment - or a general file of any type - goes up under a draft:
// it does not officially post until every upload has finished and the
// draft is published. Each file goes up in parts the server plans (8-90
// MiB, all equal but the last), several at once, each retried on its
// own with backoff. Progress is counted in bytes, so the label can say
// how much is left and how long it should take. An interrupted upload
// is found again by the file's fingerprint (a SHA-256 of its head and
// tail plus its size): re-attaching the same file resumes it, keeping
// every part the server already holds.

export interface UpItem {
  kind: UploadKind;
  blob: Blob;
  name: string;
  type: string;
  transcript?: string | null;
}

export interface UpState {
  label: string;
  sent: number;
  total: number;
  /** bytes per second, smoothed */
  rate: number;
  /** seconds left, when the rate is known */
  eta: number | null;
  /** why the upload is paused, when it is */
  waiting: string | null;
}

export class UploadCancelled extends Error {
  constructor() {
    super("Upload cancelled");
  }
}

function denied(e: unknown): boolean {
  return e instanceof ApiError && (e.status === 401 || e.status === 403);
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function fmtBytes(n: number): string {
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return Math.max(1, Math.round(n / 1024)) + " KB";
  if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 1 : 0).replace(/\.0$/, "") + " MB";
  return (n / (1024 * 1024 * 1024)).toFixed(2).replace(/\.?0+$/, "") + " GB";
}

export function fmtEta(s: number): string {
  if (s < 50) return "less than a minute left";
  if (s < 90 * 60) return "about " + Math.max(1, Math.round(s / 60)) + " min left";
  const h = s / 3600;
  return "about " + (h < 10 ? h.toFixed(1).replace(/\.0$/, "") : Math.round(h)) + " h left";
}

export async function fileFingerprint(file: Blob): Promise<string | null> {
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

// The kind a file's first bytes say it is, by the server's own rules
// (sniffImage / sniffAudio / sniffVideo): what can be shown in place.
// Anything else still uploads, as a general file to download.
export async function sniffKind(file: Blob): Promise<"image" | "audio" | "video" | null> {
  let b: Uint8Array;
  try {
    b = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  } catch {
    return null;
  }
  const at = (i: number, s: string) => s.split("").every((c, k) => b[i + k] === c.charCodeAt(0));
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image";
  if (b[0] === 0x89 && at(1, "PNG")) return "image";
  if (at(0, "GIF8")) return "image";
  if (at(0, "RIFF") && at(8, "WEBP")) return "image";
  if (at(4, "ftyp") && (at(8, "avif") || at(8, "avis"))) return "image";
  if (at(0, "RIFF") && at(8, "WAVE")) return "audio";
  if (at(0, "ID3") || (b[0] === 0xff && ((b[1] ?? 0) & 0xe0) === 0xe0)) return "audio";
  if (at(0, "OggS")) return "audio";
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) {
    // WebM / Matroska: audio or video by what the picker said it was
    return (file.type || "").startsWith("audio/") ? "audio" : "video";
  }
  if (at(4, "ftyp")) {
    if (at(8, "M4A ") || at(8, "M4B ") || (file.type || "").startsWith("audio/")) return "audio";
    return "video";
  }
  return null;
}

// A data: URL (an inline-sized pick, or a recording) back to bytes.
export function dataUrlBlob(data: string, fallbackType: string): Blob {
  const m = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(data);
  if (!m) return new Blob([], { type: fallbackType });
  const type = m[1] || fallbackType;
  if (!m[2]) return new Blob([decodeURIComponent(m[3]!)], { type });
  const bin = atob(m[3]!);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type });
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new UploadCancelled());
    const t = window.setTimeout(done, ms);
    function done() {
      signal.removeEventListener("abort", stop);
      resolve();
    }
    function stop() {
      window.clearTimeout(t);
      reject(new UploadCancelled());
    }
    signal.addEventListener("abort", stop, { once: true });
  });
}

// Offline: wait for the connection to come back, however long it takes.
function untilOnline(signal: AbortSignal): Promise<void> {
  if (navigator.onLine !== false) return Promise.resolve();
  return new Promise((resolve, reject) => {
    function on() {
      signal.removeEventListener("abort", stop);
      resolve();
    }
    function stop() {
      window.removeEventListener("online", on);
      reject(new UploadCancelled());
    }
    window.addEventListener("online", on, { once: true });
    signal.addEventListener("abort", stop, { once: true });
  });
}

class PartError extends Error {
  readonly status: number;
  readonly retry: boolean;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    // Network trouble, timeouts, rate limits and server-side failures
    // are worth another try; a refusal (wrong length, wrong kind, the
    // session gone, no access) is not.
    this.retry = status === 0 || status === 408 || status === 429 || status >= 500;
  }
}

// One part, sent with XMLHttpRequest for its upload progress events
// (fetch has none for request bodies), to the site's /part route or, for
// a direct upload, to the part's presigned storage address. onLoaded
// gets the bytes sent so far for this attempt.
function sendPart(
  url: string,
  headers: Record<string, string>,
  blob: Blob,
  onLoaded: (bytes: number) => void,
  signal: AbortSignal
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new UploadCancelled());
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    for (const k of Object.keys(headers)) xhr.setRequestHeader(k, headers[k]!);
    // a stalled part (no progress at all) is abandoned and retried
    xhr.timeout = 0;
    let last = Date.now();
    const watchdog = window.setInterval(() => {
      if (Date.now() - last > 90000) xhr.abort();
    }, 5000);
    const stop = () => xhr.abort();
    signal.addEventListener("abort", stop, { once: true });
    const end = () => {
      window.clearInterval(watchdog);
      signal.removeEventListener("abort", stop);
    };
    xhr.upload.onprogress = (e) => {
      last = Date.now();
      onLoaded(e.loaded);
    };
    xhr.onload = () => {
      end();
      if (xhr.status >= 200 && xhr.status < 300) return resolve();
      let msg = "HTTP " + xhr.status;
      try {
        const j = JSON.parse(xhr.responseText) as { error?: string };
        if (j && j.error) msg = j.error;
      } catch {
        // not JSON: storage answers in XML
        const code = /<Code>([^<]*)<\/Code>/.exec(xhr.responseText || "");
        if (code) msg = code[1]!;
      }
      reject(new PartError(xhr.status, msg));
    };
    xhr.onerror = () => {
      end();
      reject(new PartError(0, "The connection dropped"));
    };
    xhr.onabort = () => {
      end();
      reject(signal.aborted ? new UploadCancelled() : new PartError(0, "The connection stalled"));
    };
    xhr.send(blob);
  });
}

interface Meter {
  add: (bytes: number) => void;
  setWaiting: (why: string | null) => void;
}

const OFFLINE = "Offline - the upload picks up when you're back online";

// A control call (start, status, finish, publish) that rides out the same
// trouble a part does: offline waits for the connection, a network error
// or a server-side failure is retried with backoff, and a refusal (4xx)
// is the caller's to read.
async function net<T>(fn: () => Promise<T>, signal: AbortSignal, meter: Meter | null): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    if (signal.aborted) throw new UploadCancelled();
    if (navigator.onLine === false) {
      if (meter) meter.setWaiting(OFFLINE);
      await untilOnline(signal);
      if (meter) meter.setWaiting(null);
    }
    try {
      return await fn();
    } catch (e) {
      if (signal.aborted) throw new UploadCancelled();
      const transient = !(e instanceof ApiError) || e.status >= 500 || e.status === 429 || e.status === 408;
      if (!transient) throw e;
      if (navigator.onLine === false) {
        attempt--;
        continue;
      }
      if (attempt >= 7) throw e;
      const delay = Math.min(30000, 1000 * 2 ** attempt) * (0.6 + Math.random() * 0.4);
      if (meter) meter.setWaiting("Connection trouble - retrying in " + Math.max(1, Math.round(delay / 1000)) + " s");
      await sleep(delay, signal);
      if (meter) meter.setWaiting(null);
    }
  }
}

async function uploadItem(
  client: RoomClient,
  id: number,
  item: UpItem,
  fp: string | null,
  meter: Meter,
  signal: AbortSignal
): Promise<void> {
  const { kind, blob } = item;
  let plan: { part_size: number; parts: number; received: number[]; direct?: boolean };
  try {
    plan = await net(
      () =>
        client.uploadStart(id, kind, {
          size: blob.size,
          type: blob.type || item.type || undefined,
          name: item.name,
          fingerprint: fp || undefined,
          // straight to storage when the site offers it: bigger parts,
          // no trip through the Worker, no 943 GB ceiling
          direct: true,
        }),
      signal,
      meter
    );
  } catch (e) {
    if (e instanceof UploadCancelled) throw e;
    throw new Error(denied(e) ? "Upload was denied" : errText(e));
  }
  const ps = plan.part_size;
  const partBlob = (n: number) => blob.slice((n - 1) * ps, Math.min(n * ps, blob.size));
  const have = new Set(plan.received || []);
  for (const n of have) meter.add(partBlob(n).size);
  const direct = !!plan.direct;

  // A direct upload's parts go to presigned storage addresses, signed a
  // batch at a time and re-signed when one is near its expiry (or storage
  // turns it away as expired).
  const signed = new Map<number, { url: string; exp: number }>();
  const fresh = (n: number) => {
    const c = signed.get(n);
    return !!c && c.exp - Date.now() > 5 * 60 * 1000;
  };
  // one signing call at a time: parallel parts wait for the batch in flight
  let signing: Promise<void> | null = null;
  const target = async (n: number, ahead: number[]): Promise<{ url: string; headers: Record<string, string> }> => {
    if (!direct) return client.partRequest(id, kind, n);
    for (let round = 0; !fresh(n) && round < 4; round++) {
      if (signing) {
        await signing.catch(() => {});
        continue;
      }
      const batch = [n, ...ahead.filter((x) => x !== n && !fresh(x))].slice(0, 25);
      const p = (async () => {
        const r = await net(() => client.uploadSign(id, kind, batch), signal, meter);
        const exp = Date.parse(r.expires_at) || Date.now() + 3600 * 1000;
        for (const k of Object.keys(r.urls)) signed.set(Number(k), { url: r.urls[k]!, exp });
      })();
      signing = p;
      try {
        await p;
      } finally {
        if (signing === p) signing = null;
      }
    }
    const c = signed.get(n);
    if (!c) throw new PartError(0, "No storage address for part " + n);
    return { url: c.url, headers: {} };
  };

  const sendAll = async (nums: number[]) => {
    let idx = 0;
    let failure: Error | null = null;
    const worker = async () => {
      while (idx < nums.length && !failure) {
        const n = nums[idx++]!;
        const part = partBlob(n);
        for (let attempt = 0; ; attempt++) {
          if (failure) return;
          // Offline: wait for the connection, however long that takes.
          if (navigator.onLine === false) {
            meter.setWaiting(OFFLINE);
            try {
              await untilOnline(signal);
            } catch (c) {
              failure = c as Error;
              return;
            }
            meter.setWaiting(null);
          }
          let sent = 0;
          try {
            const t = await target(n, nums.slice(idx));
            await sendPart(t.url, t.headers, part, (b) => {
              meter.add(b - sent);
              sent = b;
            }, signal);
            meter.add(part.size - sent);
            break;
          } catch (e) {
            meter.add(-sent);
            if (e instanceof UploadCancelled) {
              failure = e;
              return;
            }
            if (denied(e)) {
              // the site itself refused (signing): no access any more
              failure = new Error("Upload was denied");
              return;
            }
            const pe = e instanceof PartError ? e : e instanceof ApiError ? new PartError(e.status, e.message) : new PartError(0, errText(e));
            // Storage turning a signed address away means it expired (or
            // the clock drifted): sign it again and retry.
            if (direct && pe.status === 403) signed.delete(n);
            else if (pe.status === 401 || pe.status === 403) {
              failure = new Error("Upload was denied");
              return;
            }
            // dropped because the connection went: no attempt is spent
            if (navigator.onLine === false) {
              attempt--;
              continue;
            }
            if ((!pe.retry && !(direct && pe.status === 403)) || attempt >= 9) {
              failure = new Error("Part " + n + " failed: " + pe.message);
              return;
            }
            const delay = Math.min(30000, 1000 * 2 ** attempt) * (0.6 + Math.random() * 0.4);
            meter.setWaiting("Connection trouble - retrying in " + Math.max(1, Math.round(delay / 1000)) + " s");
            try {
              await sleep(delay, signal);
            } catch (c) {
              failure = c as Error;
              return;
            }
            meter.setWaiting(null);
          }
        }
      }
    };
    // Several parts at once keeps a fast connection full; fewer when the
    // parts are big. (A part streams from the file on disk, so width costs
    // retries, not memory.)
    const width = Math.min(ps <= 16 * 1024 * 1024 ? 4 : 3, nums.length);
    await Promise.all(Array.from({ length: width }, worker));
    if (failure) throw failure;
  };

  const todo: number[] = [];
  for (let n = 1; n <= plan.parts; n++) if (!have.has(n)) todo.push(n);
  await sendAll(todo);
  // finish checks every part arrived; any it names as missing go again
  for (let round = 0; ; round++) {
    try {
      await net(() => client.uploadFinish(id, kind, kind === "audio" && item.transcript ? { transcript: item.transcript } : undefined), signal, meter);
      return;
    } catch (e) {
      if (e instanceof UploadCancelled) throw e;
      if (denied(e)) throw new Error("Upload was denied");
      let missing: number[] = [];
      if (e instanceof ApiError && e.status === 409) {
        const st = await net(() => client.uploadStatus(id, kind), signal, meter).catch(() => null);
        // an earlier finish landed and only its answer was lost
        if (st && st.complete) return;
        const got = new Set((st && st.received) || []);
        for (let n = 1; n <= plan.parts; n++) if (!got.has(n)) missing.push(n);
      }
      if (!missing.length || round >= 2) throw new Error(errText(e));
      for (const n of missing) meter.add(-partBlob(n).size);
      await sendAll(missing);
    }
  }
}

// Interrupted uploads this browser knows about, per room, so the
// composer can say "re-attach X to resume" after a reload.
export interface PendingUpload {
  key: string;
  id: number;
  names: string[];
  total: number;
  kinds: UploadKind[];
  ts: number;
}

function pendingKey(room: string): string {
  return "chat-upl:" + room;
}

export function pendingUploads(room: string): PendingUpload[] {
  try {
    const v = JSON.parse(localStorage.getItem(pendingKey(room)) || "[]") as PendingUpload[];
    return Array.isArray(v) ? v.filter((x) => x && x.id && Date.now() - x.ts < 7 * 86400000) : [];
  } catch {
    return [];
  }
}

function savePending(room: string, list: PendingUpload[]): void {
  try {
    if (list.length) localStorage.setItem(pendingKey(room), JSON.stringify(list));
    else localStorage.removeItem(pendingKey(room));
  } catch {
    // storage unavailable
  }
}

function rememberPending(room: string, p: PendingUpload): void {
  savePending(room, [p, ...pendingUploads(room).filter((x) => x.key !== p.key && x.id !== p.id)].slice(0, 5));
}

export function forgetPending(room: string, id: number): void {
  savePending(room, pendingUploads(room).filter((x) => x.id !== id));
}

// Throw an interrupted upload away: its sessions, its draft, its note.
export async function discardPending(client: RoomClient, room: string, p: PendingUpload): Promise<void> {
  for (const k of p.kinds) await client.uploadAbort(p.id, k).catch(() => {});
  await client.deleteMessage(p.id).catch(() => {});
  forgetPending(room, p.id);
  try {
    localStorage.removeItem(p.key);
  } catch {
    // storage unavailable
  }
}

export async function sendWithUploads(
  client: RoomClient,
  room: string,
  from: string,
  text: string,
  items: UpItem[],
  onState: (s: UpState) => void,
  signal: AbortSignal
): Promise<Message> {
  const total = items.reduce((a, it) => a + it.blob.size, 0);
  const label =
    items.length === 1 ? items[0]!.name : items.length + " files (" + items.map((it) => it.name).join(", ") + ")";
  let sent = 0;
  let waiting: string | null = null;
  // the rate is smoothed over the last few seconds of samples
  const samples: { t: number; b: number }[] = [];
  let rate = 0;
  let lastEmit = 0;
  const emit = (force?: boolean) => {
    const now = Date.now();
    if (!force && now - lastEmit < 250) return;
    lastEmit = now;
    samples.push({ t: now, b: sent });
    while (samples.length > 2 && now - samples[0]!.t > 8000) samples.shift();
    const first = samples[0]!;
    if (now - first.t > 1500) rate = Math.max(0, (sent - first.b) / ((now - first.t) / 1000));
    const left = Math.max(0, total - sent);
    onState({ label, sent: Math.min(sent, total), total, rate, eta: rate > 0 ? left / rate : null, waiting });
  };
  const meter: Meter = {
    add: (b) => {
      sent += b;
      emit();
    },
    setWaiting: (why) => {
      waiting = why;
      emit(true);
    },
  };
  emit(true);

  let wake: WakeLockSentinel | null = null;
  try {
    if (navigator.wakeLock) wake = await navigator.wakeLock.request("screen");
  } catch {
    // the wake lock is best-effort
  }
  const fps = await Promise.all(items.map((it) => fileFingerprint(it.blob)));
  const draftKey = "chat-draft:" + room + ":" + items.map((it, i) => fps[i] || it.name + "-" + it.blob.size).join("+");
  let id: number | null = null;
  try {
    // 1. this browser started this exact set before
    try {
      const saved = JSON.parse(localStorage.getItem(draftKey) || "null") as { id?: number } | null;
      if (saved && saved.id) {
        const st = await client.uploadStatus(saved.id, items[0]!.kind);
        if (st.uploading || st.complete) id = saved.id;
      }
    } catch {
      // no resumable local draft
    }
    // 2. the server knows this file (another tab, another device)
    if (!id && items.length === 1 && fps[0]) {
      try {
        const rj = await client.uploadResume(items[0]!.blob.size, fps[0], items[0]!.kind);
        if (rj.found && rj.id) id = rj.id;
      } catch {
        // the lookup is best-effort
      }
    }
    if (!id) {
      let pd: Message;
      try {
        pd = await net(() => client.createDraft(from, text), signal, meter);
      } catch (e) {
        if (e instanceof UploadCancelled) throw e;
        throw new Error(denied(e) ? "Posting was denied" : errText(e));
      }
      id = pd.id;
      try {
        localStorage.setItem(draftKey, JSON.stringify({ id }));
      } catch {
        // storage unavailable
      }
    }
    rememberPending(room, { key: draftKey, id, names: items.map((it) => it.name), total, kinds: items.map((it) => it.kind), ts: Date.now() });
    for (let i = 0; i < items.length; i++) {
      const it = items[i]!;
      const st = await net(() => client.uploadStatus(id!, it.kind), signal, meter).catch((e) => {
        if (e instanceof UploadCancelled) throw e;
        return null;
      });
      if (st && st.complete) {
        meter.add(it.blob.size);
        continue;
      }
      await uploadItem(client, id, it, fps[i] || null, meter, signal);
    }
    emit(true);
    let live: Message | null = null;
    try {
      live = await net(() => client.publishMessage(id!, text), signal, meter);
    } catch (e) {
      if (e instanceof UploadCancelled) throw e;
      if (denied(e)) throw new Error("Publishing was denied");
      // 409: already live - an earlier publish landed and only its answer
      // was lost. Read the message back instead.
      if (e instanceof ApiError && e.status === 409) {
        const ld = await client.messages(id - 1, 5).catch(() => null);
        live = (ld && (ld.messages || []).find((x) => x.id === id)) || null;
      }
      if (!live) throw new Error("Publish failed: " + errText(e));
    }
    forgetPending(room, id);
    try {
      localStorage.removeItem(draftKey);
    } catch {
      // storage unavailable
    }
    return live;
  } catch (e) {
    // A cancel throws the whole attempt away: nothing half-sent lingers.
    if (e instanceof UploadCancelled && id) {
      await discardPending(client, room, { key: draftKey, id, names: [], total, kinds: items.map((it) => it.kind), ts: 0 });
    }
    throw e;
  } finally {
    if (wake) {
      try {
        await wake.release();
      } catch {
        // already released
      }
    }
  }
}
