import type {
  AttachmentsResponse,
  GameResponse,
  Member,
  Message,
  MessagesResponse,
  VoiceState,
  VoiceUploadResult,
} from "./types";
import type { GameListItem } from "./games";

// A thin typed client over the room API. Same-origin only: the chat
// Worker serves the app, so /api paths are always relative.

// A failed API call: carries the HTTP status and the server's own error
// text, so callers can drive the access states (401/403 → locked view)
// and surface real messages instead of inventing their own.
export type GameRecordRow = { name: string; hex: string; w: number; l: number; p2?: number; p3?: number };
export type GameLadderRow = { name: string; hex: string | null; rating: number; w: number; l: number; d: number; last: number };

export type UploadKind = "image" | "audio" | "video" | "file";

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

  attachments(opts?: { kind?: string; from?: string; before?: string; limit?: number }): Promise<AttachmentsResponse> {
    const q = new URLSearchParams();
    if (opts?.kind) q.set("kind", opts.kind);
    if (opts?.from) q.set("from", opts.from);
    if (opts?.before) q.set("before", opts.before);
    if (opts?.limit != null) q.set("limit", String(opts.limit));
    const s = q.toString();
    return this.call<AttachmentsResponse>("/attachments" + (s ? "?" + s : ""));
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
  async createDraft(from: string, text: string): Promise<Message & { room_state?: import("./types").RoomState }> {
    return this.postPayload({ from, text, draft: true });
  }

  // ---- The upload engine: one resumable flow for every kind ----
  // start pins a part plan, parts go up as raw PUTs (the composer sends
  // them with XMLHttpRequest for byte progress: see partRequest), finish
  // assembles and attaches. See UPLOADING FILES in GET /api.

  /** Find one of my drafts with this file's upload in flight (size + fingerprint). */
  uploadResume(
    size: number,
    fingerprint: string,
    kind?: UploadKind
  ): Promise<{ found?: boolean; id?: number | null; kind?: UploadKind | null; received?: number[] }> {
    return this.call("/upload/resume", {
      method: "POST",
      body: JSON.stringify(kind ? { size, fingerprint, kind } : { size, fingerprint }),
    });
  }

  uploadStart(
    id: number,
    kind: UploadKind,
    body: { size: number; type?: string; name?: string; fingerprint?: string; direct?: boolean }
  ): Promise<{ part_size: number; parts: number; resumed: boolean; received: number[]; expires_at: string; direct?: boolean }> {
    return this.call("/messages/" + id + "/" + kind + "/start", { method: "POST", body: JSON.stringify(body) });
  }

  uploadStatus(
    id: number,
    kind: UploadKind
  ): Promise<{ uploading: boolean; complete?: boolean; direct?: boolean; received: number[]; part_size?: number | null; parts?: number | null }> {
    return this.call("/messages/" + id + "/" + kind + "/status");
  }

  /** Storage addresses for a direct upload's parts (presigned PUTs, about an hour each). */
  uploadSign(
    id: number,
    kind: UploadKind,
    parts: number[]
  ): Promise<{ urls: Record<string, string>; expires_at: string }> {
    return this.call("/messages/" + id + "/" + kind + "/sign", { method: "POST", body: JSON.stringify({ parts }) });
  }

  uploadFinish(
    id: number,
    kind: UploadKind,
    extra?: { transcript?: string | null }
  ): Promise<{ published?: boolean } & Record<string, unknown>> {
    return this.call("/messages/" + id + "/" + kind + "/finish", { method: "POST", body: JSON.stringify(extra || {}) });
  }

  uploadAbort(id: number, kind: UploadKind): Promise<unknown> {
    return this.call("/messages/" + id + "/" + kind + "/abort", { method: "POST", body: "{}" });
  }

  /** Where part n goes, with the headers it needs (sent by the caller, for progress events). */
  partRequest(id: number, kind: UploadKind, n: number): { url: string; headers: Record<string, string> } {
    const headers: Record<string, string> = { "Content-Type": "application/octet-stream" };
    if (this.token) headers["X-Invite-Token"] = this.token;
    return {
      url: "/api/rooms/" + encodeURIComponent(this.room) + "/messages/" + id + "/" + kind + "/part?n=" + n,
      headers,
    };
  }

  deleteMessage(id: number): Promise<unknown> {
    return this.call("/messages/" + id, { method: "DELETE" });
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

  // record: all-time W/L per game (Code Race rows add p2/p3); ladder: an
  // Elo rating per player per game over 2-player matches (2026-11-19)
  listGames(): Promise<{ games: GameListItem[]; record?: Record<string, GameRecordRow[]>; ladder?: Record<string, GameLadderRow[]> }> {
    return this.call<{ games: GameListItem[]; record?: Record<string, GameRecordRow[]>; ladder?: Record<string, GameLadderRow[]> }>("/games");
  }

  /** The room API base path. */
  basePath(): string {
    return "/api/rooms/" + this.room;
  }

  pushStatus(endpoint: string): Promise<{ registered?: boolean; mode?: string }> {
    return this.call("/push/status?endpoint=" + encodeURIComponent(endpoint));
  }

  pushSubscribe(subscription: unknown, mode: string): Promise<unknown> {
    return this.call("/push/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subscription, mode }),
    });
  }

  pushUnsubscribe(endpoint: string): Promise<unknown> {
    return this.call("/push/unsubscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint }),
    });
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

  acceptGame(id: number): Promise<GameResponse> {
    return this.call("/games/" + id + "/accept", {
      method: "POST",
      body: "{}",
    });
  }

  declineGame(id: number): Promise<GameResponse> {
    return this.call("/games/" + id + "/decline", {
      method: "POST",
      body: "{}",
    });
  }
}
