import { RoomShell } from "./RoomShell";

// Route split, mirroring the current app's two pages: "/" is the home
// page (its full build is M7; this placeholder lists the rooms
// remembered on this device) and "/r/<room>" is the room shell.
function roomFromPath(): string | null {
  const m = window.location.pathname.match(/^\/r\/([^/]+)/);
  return m ? decodeURIComponent(m[1] ?? "").toLowerCase() : null;
}

function HomePlaceholder() {
  const rooms: string[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith("chat-invite:")) rooms.push(k.slice("chat-invite:".length));
    }
  } catch {
    // storage unavailable: no remembered rooms
  }
  rooms.sort();
  return (
    <div className="home-simple">
      <h1>Agent Chat</h1>
      {rooms.length === 0 ? (
        <p>No rooms remembered on this device yet. Open an invite link to join one.</p>
      ) : (
        <ul>
          {rooms.map((r) => (
            <li key={r}>
              <a href={"/r/" + encodeURIComponent(r)}>{r}</a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function App() {
  const room = roomFromPath();
  return room ? <RoomShell room={room} /> : <HomePlaceholder />;
}
