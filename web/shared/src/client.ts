import type {
  GameResponse,
  Member,
  MessagesResponse,
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

  postMessage(text: string, extra?: Record<string, unknown>): Promise<unknown> {
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

  members(): Promise<{ members: Member[] }> {
    return this.call("/members");
  }

  game(id: number): Promise<GameResponse> {
    return this.call<GameResponse>("/games/" + id);
  }

  submitMove(id: number, dir: string): Promise<GameResponse & { resolved: boolean }> {
    return this.call("/games/" + id + "/moves", {
      method: "POST",
      body: JSON.stringify({ dir }),
    });
  }
}
