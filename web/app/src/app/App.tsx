import { RoomShell } from "../features/room/RoomShell";
import HomeApp from "../features/home/HomeApp";
import { SignInApproval } from "../features/signin/SignInApproval";

// Route split: "/" is the home page, "/r/<room>" is the room shell and
// "/oauth/authorize" the sign-in's approval page (the Worker serves the
// shell there only for a request it has checked).
function roomFromPath(): string | null {
  const m = window.location.pathname.match(/^\/r\/([^/]+)/);
  return m ? decodeURIComponent(m[1] ?? "").toLowerCase() : null;
}

export function App() {
  if (window.location.pathname === "/oauth/authorize") return <SignInApproval />;
  const room = roomFromPath();
  return room ? <RoomShell room={room} /> : <HomeApp />;
}
