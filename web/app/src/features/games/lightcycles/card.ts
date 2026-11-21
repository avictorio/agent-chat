import { boardSvg, type GL } from "../shared/render";

// Under the Light Cycles board: whose trail is whose (the colours were
// only named in the message text) and, for a rider who still owes the
// tick, the same YOUR MOVE pill the Duel and Battleship cards carry -
// on a phone the old "your move" at the end of the meta line was the
// part that got clipped.
const ARROW: Record<string, string> = { up: "↑", down: "↓", left: "←", right: "→" };
export function lcCardFoot(g: GL): HTMLElement {
  const foot = document.createElement("div");
  foot.className = "lc-card-foot";
  const key = document.createElement("div");
  key.className = "lc-card-key";
  (g.players || []).forEach((p: GL) => {
    const item = document.createElement("span");
    item.className = "lc-card-rider" + (p.alive || g.status === "lobby" ? "" : " out");
    const dot = document.createElement("span");
    dot.className = "lc-dot";
    dot.style.background = p.hex;
    item.appendChild(dot);
    item.appendChild(document.createTextNode(p.name));
    key.appendChild(item);
  });
  foot.appendChild(key);
  const you = g.you;
  if (you && you.playing && you.alive && g.status === "running") {
    const pill = document.createElement("span");
    pill.className = "duel-pill " + (you.queued ? "locked" : "your-throw");
    pill.textContent = you.queued ? "✓ LOCKED · " + (ARROW[you.queued] || you.queued) : "YOUR MOVE";
    foot.appendChild(pill);
  }
  return foot;
}

/* The Light Cycles card: the board (an SVG of the trails) and its foot.
   Only for a match with trails, as before the registry. */
export function paintLightCyclesCard(board: HTMLElement, g: GL): void {
  if (!g.trails) return;
  board.innerHTML = boardSvg(g);
  board.appendChild(lcCardFoot(g));
}
