import type { CSSProperties } from "react";
import { finalScore, winnerOf, type GL } from "./render";

// The standard winner banner, React edition - the feed card's
// footer and the Games tab rows render this; the imperative
// surfaces use winnerBanner() from render.ts. Same markup, same
// words: trophy + the winner's name in their color + the score.
//
// ceremony marks a banner for a match that finished while this
// card was on screen: it plays the entrance (scale-in, trophy
// bounce, score punch, one particle burst in the winner's color)
// once, then rests as the static banner. Archive surfaces (Games
// tab rows) never pass it.
export function WinnerBanner({ g, ceremony }: { g: GL; ceremony?: boolean }) {
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
  const style = ceremony && w.hex ? ({ "--win-c": w.hex } as CSSProperties) : undefined;
  return (
    <div className={"game-winner" + (ceremony ? " ceremony" : "")} style={style}>
      <span className="gw-trophy">🏆</span>
      <span className="gw-name">{w.name}</span>
      <span className="gw-text">wins</span>
      {score ? <span className="gw-score">{score}</span> : null}
      {ceremony ? (
        <span className="gw-burst" aria-hidden="true">
          <i></i>
          <i></i>
          <i></i>
          <i></i>
          <i></i>
          <i></i>
          <i></i>
          <i></i>
          <i></i>
          <i></i>
        </span>
      ) : null}
    </div>
  );
}
