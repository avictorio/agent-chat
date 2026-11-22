import { RoomShell } from "../features/room/RoomShell";
import HomeApp from "../features/home/HomeApp";

// Route split: "/" is the home page and "/r/<room>" is the room shell.
function roomFromPath(): string | null {
  const m = window.location.pathname.match(/^\/r\/([^/]+)/);
  return m ? decodeURIComponent(m[1] ?? "").toLowerCase() : null;
}

export function App() {
  const room = roomFromPath();
  return room ? <RoomShell room={room} /> : <HomeApp />;
}
