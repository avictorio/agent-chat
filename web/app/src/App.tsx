import { useEffect, useState } from "react";
import { RoomClient, type Message } from "@chat/shared";

// M1 skeleton: proves the wiring end to end — invite fragment handling and
// the on-device identity store (same keys as the current app), a typed API
// fetch through @chat/shared, and a plain render. Every real surface is
// built milestone by milestone against PARITY.md; this is not the design.

function roomFromPath(): string | null {
  const m = window.location.pathname.match(/^\/r\/([^/]+)/);
  return m ? decodeURIComponent(m[1] ?? "") : null;
}

function takeInvite(room: string): string | null {
  const hash = new URLSearchParams(window.location.hash.slice(1));
  const fromHash = hash.get("invite");
  if (fromHash) {
    try {
      localStorage.setItem("chat-invite:" + room, fromHash);
    } catch {
      // storage unavailable; the in-memory token still works this session
    }
    window.history.replaceState(null, "", window.location.pathname);
    return fromHash;
  }
  try {
    return localStorage.getItem("chat-invite:" + room);
  } catch {
    return null;
  }
}

function RoomSkeleton({ room }: { room: string }) {
  const [messages, setMessages] = useState<Message[] | null>(null);
  const [you, setYou] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const client = new RoomClient(room, takeInvite(room));
    let live = true;
    client
      .messages()
      .then((d) => {
        if (!live) return;
        setMessages(d.messages);
        setYou(d.you ?? null);
        if (d.you) {
          try {
            localStorage.setItem("chat-you:" + room, d.you);
          } catch {
            // identity cache is best-effort
          }
        }
      })
      .catch((e: unknown) => {
        if (live) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      live = false;
    };
  }, [room]);

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="side-room">{room}</div>
        <div className="side-note">React rewrite — skeleton</div>
      </aside>
      <main className="main">
        <header className="topbar">{room}</header>
        <div className="feed">
          {error ? <p className="feed-error">{error}</p> : null}
          {messages === null && !error ? <p className="feed-note">Loading…</p> : null}
          {(messages ?? []).map((msg) => (
            <div className="msg" key={msg.id}>
              <span className="msg-from">{msg.from}</span>
              <span className="msg-text">{msg.text ?? ""}</span>
            </div>
          ))}
          {you ? <p className="feed-note">Posting as {you}</p> : null}
        </div>
      </main>
    </div>
  );
}

function HomeSkeleton() {
  const [rooms] = useState<string[]>(() => {
    const out: string[] = [];
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith("chat-invite:")) out.push(k.slice("chat-invite:".length));
      }
    } catch {
      // no storage, no rooms
    }
    return out.sort();
  });
  return (
    <div className="app">
      <main className="main">
        <header className="topbar">Your rooms</header>
        <div className="feed">
          {rooms.length === 0 ? (
            <p className="feed-note">No rooms on this device yet. Open an invite link to join one.</p>
          ) : (
            rooms.map((r) => (
              <p key={r}>
                <a href={"/r/" + encodeURIComponent(r)}>{r}</a>
              </p>
            ))
          )}
        </div>
      </main>
    </div>
  );
}

export function App() {
  const room = roomFromPath();
  return room ? <RoomSkeleton room={room} /> : <HomeSkeleton />;
}
