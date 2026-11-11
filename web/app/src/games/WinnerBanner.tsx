import { finalScore, winnerOf, type GL } from "./render";

// The standard winner banner, React edition - the feed card's
// footer and the Games tab rows render this; the imperative
// surfaces use winnerBanner() from render.ts. Same markup, same
// words: trophy + the winner's name in their color + the score.
export function WinnerBanner({ g }: { g: GL }) {
  if (!g || (g.status !== "finished" && g.status !== "cancelled")) return null;
  if (g.status === "cancelled")
    return (
      <div className="game-winner off">
        <span className="gw-text">Called off</span>
      </div>
    );
  const w = winnerOf(g);
  if (!w)
    return (
      <div className="game-winner off">
        <span className="gw-text">No winner</span>
      </div>
    );
  const score = finalScore(g);
  return (
    <div className="game-winner">
      <span className="gw-trophy">🏆</span>
      <span className="gw-name">{w.name}</span>
      <span className="gw-text">wins</span>
      {score ? <span className="gw-score">{score}</span> : null}
    </div>
  );
}
