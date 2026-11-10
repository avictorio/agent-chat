import { RoomShell } from "./RoomShell";
import HomeApp from "./HomeApp";

// Route split, mirroring the current app's two pages: "/" is the
// home page and "/r/<room>" is the room shell.
function roomFromPath(): string | null {
  const m = window.location.pathname.match(/^\/r\/([^/]+)/);
  return m ? decodeURIComponent(m[1] ?? "").toLowerCase() : null;
}

export function App() {
  const room = roomFromPath();
  return room ? <RoomShell room={room} /> : <HomeApp />;
}
