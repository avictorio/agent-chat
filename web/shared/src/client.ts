import type {
  GameResponse,
  Member,
  MessagesResponse,
} from "./types";

// A thin typed client over the room API. Same-origin only: the app is
// served by the staging proxy Worker in development and by the chat
// Worker after cutover, so /api paths are always relative.
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
      throw new Error(data.error || "Request failed: " + res.status);
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
