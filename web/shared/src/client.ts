import type {
  GameResponse,
  Member,
  Message,
  MessagesResponse,
  VoiceState,
  VoiceUploadResult,
} from "./types";

// A thin typed client over the room API. Same-origin only: the app is
// served by the staging proxy Worker in development and by the chat
// Worker after cutover, so /api paths are always relative.

// A failed API call: carries the HTTP status and the server's own error
// text, so callers can drive the access states (401/403 → locked view)
// and surface real messages instead of inventing their own.
export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// GET /api/build — the running deployment's build id, for the update
// banner's comparison against the page's build meta stamp.
export async function fetchBuild(): Promise<string | null> {
  try {
    const res = await fetch("/api/build");
    if (!res.ok) return null;
    const d = (await res.json()) as { build?: string };
    return d.build || null;
  } catch {
    return null;
  }
}

export class RoomClient {
  readonly room: string;
  private token: string | null;

  constructor(room: string, token: string | null) {
    this.room = room;
    this.token = token;
  }

  setToken(token: string | null): void {
    this.token = token;
  }

  private async call<T>(path: string, init?: RequestInit): Promise<T> {
    const headers = new Headers(init?.headers);
    if (this.token) headers.set("X-Invite-Token", this.token);
    if (init?.body && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }
    const res = await fetch("/api/rooms/" + encodeURIComponent(this.room) + path, {
      ...init,
      headers,
    });
    const data = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (!res.ok) {
      throw new ApiError(res.status, data.error || "Request failed: " + res.status);
    }
    return data;
  }

  messages(after?: number, limit?: number): Promise<MessagesResponse> {
    const q = new URLSearchParams();
    if (after != null) q.set("after", String(after));
    if (limit != null) q.set("limit", String(limit));
    const s = q.toString();
    return this.call<MessagesResponse>("/messages" + (s ? "?" + s : ""));
  }

  postMessage(
    text: string,
    extra?: Record<string, unknown>
  ): Promise<import("./types").Message & { room_state?: import("./types").RoomState }> {
    return this.call("/messages", {
      method: "POST",
      body: JSON.stringify({ text, ...extra }),
    });
  }

  react(messageId: number, from: string, reaction: string | null): Promise<unknown> {
    return this.call("/messages/" + messageId + "/reactions", {
      method: "POST",
      body: JSON.stringify({ from, reaction }),
    });
  }

  members(): Promise<{ room: string; invite_only: boolean; members: Member[] }> {
    return this.call("/members");
  }

  // The board's call(): any room endpoint with a JSON body, ApiError on
  // failure carrying the server's error text.
  api<T>(path: string, method?: string, body?: unknown): Promise<T> {
    const init: RequestInit = { method: method || "GET" };
    if (body !== undefined) {
      init.headers = { "Content-Type": "application/json" };
      init.body = JSON.stringify(body);
    }
    return this.call(path, init);
  }

  /** Post a message with an arbitrary payload (media fields included). */
  async postPayload(
    payload: Record<string, unknown>
  ): Promise<Message & { room_state?: import("./types").RoomState }> {
    return this.call("/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  }

  /** Create an unpublished draft message (media attaches to it). */
  async createDraft(
    from: string,
    text: string,
    publishOnComplete = false
  ): Promise<Message & { room_state?: import("./types").RoomState }> {
    const body: Record<string, unknown> = { from, text, draft: true };
    if (publishOnComplete) body.publish_on_complete = true;
    return this.postPayload(body);
  }

  /** Find a resumable chunked-video draft by file size + fingerprint. */
  async videoResume(size: number, fingerprint: string): Promise<{ found?: boolean; id?: number }> {
    return this.call("/video/resume", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ size, fingerprint }),
    });
  }

  async videoStatus(id: number): Promise<{ uploading?: boolean; received?: number[] }> {
    return this.call("/messages/" + id + "/video/status");
  }

  async videoStart(
    id: number,
    body: { type: string; size: number; fingerprint?: string }
  ): Promise<{ part_size: number; parts: number }> {
    return this.call("/messages/" + id + "/video/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async videoPart(id: number, n: number, blob: Blob): Promise<void> {
    await this.call("/messages/" + id + "/video/part?n=" + n, {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream" },
      body: blob,
    });
  }

  async videoFinish(id: number): Promise<void> {
    await this.call("/messages/" + id + "/video/finish", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
  }

  async publishMessage(
    id: number,
    text: string
  ): Promise<Message & { room_state?: import("./types").RoomState }> {
    return this.call("/messages/" + id + "/publish", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
  }

  /** My cloned-voice status. */
  async getVoice(): Promise<{ voice?: VoiceState | null }> {
    return this.call("/voice");
  }

  async deleteVoice(): Promise<{ error?: string }> {
    return this.call("/voice", { method: "DELETE" });
  }

  /** Upload a voice sample (raw audio bytes) for cloning. */
  async putVoiceSample(blob: Blob): Promise<VoiceUploadResult> {
    const headers: Record<string, string> = { "Content-Type": blob.type || "audio/mpeg" };
    if (this.token) headers["X-Invite-Token"] = this.token;
    const res = await fetch("/api/rooms/" + encodeURIComponent(this.room) + "/voice/sample", {
      method: "PUT",
      headers,
      body: blob,
    });
    const data = (await res.json().catch(() => ({}))) as VoiceUploadResult;
    if (!res.ok) throw new ApiError(res.status, data.error || "HTTP " + res.status);
    return data;
  }

  // Avatar upload sends raw image bytes, not JSON.
  async putAvatar(blob: Blob): Promise<unknown> {
    const headers: Record<string, string> = {
      "Content-Type": blob.type || "application/octet-stream",
    };
    if (this.token) headers["X-Invite-Token"] = this.token;
    const res = await fetch("/api/rooms/" + encodeURIComponent(this.room) + "/avatar", {
      method: "PUT",
      headers,
      body: blob,
    });
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) throw new ApiError(res.status, data.error || "HTTP " + res.status);
    return data;
  }

  game(id: number): Promise<GameResponse> {
    return this.call<GameResponse>("/games/" + id);
  }

  createGame(body: Record<string, unknown>): Promise<GameResponse> {
    return this.call<GameResponse>("/games", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  submitMove(id: number, dir: string): Promise<GameResponse & { resolved: boolean }> {
    return this.call("/games/" + id + "/moves", {
      method: "POST",
      body: JSON.stringify({ dir }),
    });
  }
}
