import { useLayoutEffect, useReducer, useRef, useState, type CSSProperties, type PointerEvent, type RefObject } from "react";
import type { SketchPlayer, SketchRound, SketchState, SketchYou } from "@chat/contract";
import { PAD_COLORS, PAD_H, PAD_SIZES, PAD_W, sgLastRound, type SgPad, type Stroke } from "./sketch";

/* Sketch & Guess's panels (2026-11-21, React): the scoreboard, the
   artist's prompt and sketch pad (or an image of their own), the guess
   form, the last round's reveal and the chat card. The view (view.tsx)
   mounts them with ctx.panel. The guess keeps its draft as its own state
   (keyed by round and phase); the field is uncontrolled (a value prop
   would add a value attribute the old markup never had), starts from the
   draft when it mounts and reports every keystroke. The pad draws the
   SgPad the view keeps on gameView for the round: its strokes and pen
   live there, as before, and the canvas stays the same element across
   repaints, so a poll never wipes a half-drawn picture. */

function status(g: SketchState, p: SketchPlayer): string {
  if (g.status !== "running") return "";
  if (p.name === g.artist) return g.phase === "draw" ? "drawing…" : "artist";
  if (g.phase === "guess") return p.committed ? "guessed ✓" : "thinking…";
  if (g.phase === "judging") return "…";
  return "";
}

/* The scoreboard, highest first (the card's compact one marks the artist). */
export function SketchScores({ g, me, compact }: { g: SketchState; me?: string; compact?: boolean }) {
  const ps: SketchPlayer[] = ((g && g.players) || []).slice().sort((a: SketchPlayer, b: SketchPlayer) => (b.score || 0) - (a.score || 0) || (a.name < b.name ? -1 : 1));
  return (
    <div className={"sg-scores" + (compact ? " compact" : "")}>
      {ps.map((p: SketchPlayer, i: number) => {
        const mine = !!me && p.name === me;
        const st = compact ? (p.name === g.artist && g.status === "running" ? "🎨" : "") : status(g, p);
        return (
          <div key={p.name} className={"sg-row" + (mine ? " mine" : "")} style={{ "--who": p.hex || "#94a3b8" } as CSSProperties}>
            <span className="sg-rank">{String(i + 1)}</span>
            <span className="hist-dot" style={{ background: p.hex }}></span>
            <span className="sg-name">{p.name + (mine ? " (you)" : "")}</span>
            {st ? <span className="sg-st">{st}</span> : null}
            <span className="sg-score">{String(p.score || 0)}</span>
          </div>
        );
      })}
    </div>
  );
}

/* The pad's page: white, then every stroke in order. */
function paintPad(canvas: HTMLCanvasElement | null, strokes: Stroke[]) {
  const ctx = canvas && canvas.getContext("2d");
  if (!ctx) return;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, PAD_W, PAD_H);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const s of strokes) {
    ctx.strokeStyle = s.color;
    ctx.lineWidth = s.size;
    ctx.beginPath();
    ctx.moveTo(s.pts[0]!, s.pts[1]!);
    if (s.pts.length === 2) ctx.lineTo(s.pts[0]! + 0.01, s.pts[1]!);
    for (let i = 2; i < s.pts.length; i += 2) ctx.lineTo(s.pts[i]!, s.pts[i + 1]!);
    ctx.stroke();
  }
}

/* The pad: a white page, a pen in eight colours and three sizes, an
   eraser, undo and clear. Pointer events cover mouse, pen and touch; the
   canvas takes touch-action: none (CSS) so a stroke never scrolls the
   page. Strokes and the pen are the pad's (gameView's); a pen change
   repaints the tools. */
function SketchPad({ pad, canvas }: { pad: SgPad; canvas: RefObject<HTMLCanvasElement | null> }) {
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  const cur = useRef<Stroke | null>(null);
  // the strokes kept for the round are drawn when the canvas mounts
  useLayoutEffect(() => paintPad(canvas.current, pad.strokes), [canvas, pad]);
  const at = (e: PointerEvent<HTMLCanvasElement>): [number, number] => {
    const r = e.currentTarget.getBoundingClientRect();
    return [((e.clientX - r.left) / Math.max(1, r.width)) * PAD_W, ((e.clientY - r.top) / Math.max(1, r.height)) * PAD_H];
  };
  const end = () => {
    cur.current = null;
  };
  return (
    <div className="sg-pad">
      <canvas
        ref={canvas}
        className="sg-canvas"
        width={PAD_W}
        height={PAD_H}
        aria-label="Sketch pad"
        onPointerDown={(e) => {
          e.preventDefault();
          e.currentTarget.setPointerCapture(e.pointerId);
          const [x, y] = at(e);
          cur.current = { color: pad.erasing ? "#ffffff" : pad.color, size: pad.erasing ? Math.max(pad.size, 22) : pad.size, pts: [x, y] };
          pad.strokes.push(cur.current);
          paintPad(e.currentTarget, pad.strokes);
        }}
        onPointerMove={(e) => {
          if (!cur.current) return;
          const [x, y] = at(e);
          cur.current.pts.push(x, y);
          paintPad(e.currentTarget, pad.strokes);
        }}
        onPointerUp={end}
        onPointerCancel={end}
      ></canvas>
      <div className="sg-tools">
        {PAD_COLORS.map((c) => (
          <button
            key={c}
            type="button"
            className={"sg-swatch" + (c === pad.color ? " on" : "")}
            style={{ background: c }}
            aria-label={"Pen colour " + c}
            onClick={() => {
              pad.color = c;
              pad.erasing = false;
              redraw();
            }}
          ></button>
        ))}
        {PAD_SIZES.map((s) => {
          const d = Math.max(4, Math.round(s * 0.8)) + "px";
          return (
            <button
              key={s}
              type="button"
              className={"sg-size" + (s === pad.size ? " on" : "")}
              aria-label={"Pen size " + s}
              onClick={() => {
                pad.size = s;
                redraw();
              }}
            >
              <span className="sg-size-dot" style={{ height: d, width: d }}></span>
            </button>
          );
        })}
        <button
          type="button"
          className={"btn sm sg-tool" + (pad.erasing ? " on" : "")}
          onClick={() => {
            pad.erasing = !pad.erasing;
            redraw();
          }}
        >
          Eraser
        </button>
        <button
          type="button"
          className="btn sm sg-tool"
          onClick={() => {
            pad.strokes.pop();
            paintPad(canvas.current, pad.strokes);
          }}
        >
          Undo
        </button>
        <button
          type="button"
          className="btn sm sg-tool"
          onClick={() => {
            pad.strokes.length = 0;
            paintPad(canvas.current, pad.strokes);
          }}
        >
          Clear
        </button>
      </div>
    </div>
  );
}

/* The artist's panel: the secret prompt, the pad, and an image of your
   own as the other way in. The view keys it by round. */
export function SketchArtist({ g, pad, onSend, onError }: { g: SketchState; pad: SgPad; onSend: (image: string) => void; onError: (msg: string) => void }) {
  const you: Partial<SketchYou> = g.you || {};
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const file = useRef<HTMLInputElement | null>(null);
  return (
    <div className="sg-form sg-artist">
      <div className="sg-prompt">
        <span className="sg-prompt-cap">Your prompt (secret)</span>
        <span className="sg-prompt-text">{you.prompt || "?"}</span>
      </div>
      <div className="sg-hint">Draw it - no letters or words. Guessable but not too easy: you score 1 for each player who gets it, up to 2.</div>
      <SketchPad pad={pad} canvas={canvas} />
      <div className="sg-row-end">
        <input
          ref={file}
          className="sg-file"
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp"
          hidden
          onChange={(e) => {
            const input = e.currentTarget;
            const f = input.files && input.files[0];
            if (!f) return;
            if (f.size > 1500000) {
              onError("That image is over 1.5 MB - try a smaller one.");
              return;
            }
            const rd = new FileReader();
            rd.onload = () => onSend(String(rd.result || ""));
            rd.onerror = () => onError("Couldn't read that file.");
            rd.readAsDataURL(f);
          }}
        />
        <button type="button" className="btn sm sg-upload" onClick={() => file.current && file.current.click()}>
          Use an image…
        </button>
        <button
          type="button"
          className="btn sg-send"
          onClick={() => {
            if (!pad.strokes.length) {
              onError("Draw something first (or use an image).");
              return;
            }
            if (canvas.current) onSend(canvas.current.toDataURL("image/png"));
          }}
        >
          Send drawing
        </button>
      </div>
    </div>
  );
}

/* The guess form: one line, changeable until the guesses close. The view
   keys it by round and phase; the draft starts from your sealed guess. */
export function SketchGuess({ g, onSend }: { g: SketchState; onSend: (s: string) => void }) {
  const you: Partial<SketchYou> = g.you || {};
  const [d, setD] = useState(() => you.queued || "");
  const box = useRef<HTMLInputElement>(null);
  // the field's first value, set once when it mounts
  const [seed] = useState(d);
  useLayoutEffect(() => {
    if (box.current) box.current.value = seed;
  }, [seed]);
  const off = !d.trim();
  return (
    <div className="sg-form sg-guess">
      <div className="sg-form-title">{you.queued ? "Your guess is in - change it until the guesses close" : "What does the drawing show?"}</div>
      <div className="sg-guess-row">
        <input
          ref={box}
          className="sg-in"
          type="text"
          maxLength={80}
          placeholder="Your guess"
          aria-label="Your guess"
          onInput={(e) => setD(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !off) {
              e.preventDefault();
              onSend(e.currentTarget.value.trim());
            }
          }}
        />
        <button
          type="button"
          className="btn sg-send"
          disabled={off}
          onClick={() => {
            if (!off) onSend(d.trim());
          }}
        >
          {you.queued ? "Change" : "Guess"}
        </button>
      </div>
      {you.queued ? <div className="sg-hint">{"Sealed: " + you.queued}</div> : null}
    </div>
  );
}

/* One round's reveal: the prompt, each guess and who judged it. Keyed by
   round, so each round's reveal is made afresh. */
export function SketchReveal({ g, round, me }: { g: SketchState; round: SketchRound; me?: string }) {
  const players: SketchPlayer[] = g.players || [];
  const hexOf = (n: string) => (players.find((p: SketchPlayer) => p.name === n) || { hex: "#94a3b8" }).hex;
  return (
    <div key={round.n} className="sg-reveal">
      <div className="fl-cap">{"Round " + round.n + " · " + round.artist + " drew"}</div>
      {round.image && round.image.url ? <img className="sg-rv-img" src={round.image.url} alt={round.artist + "'s drawing for round " + round.n} loading="lazy" /> : null}
      <div className="sg-rv-prompt">{(round.forfeit ? "No drawing - the prompt was: " : "It was: ") + round.prompt}</div>
      {Object.keys(round.guesses || {}).map((n: string) => {
        const x = round.guesses[n]!;
        return (
          <div key={n} className={"sg-rv " + (x.right ? "right" : "wrong") + (me && n === me ? " mine" : "")}>
            <span className="hist-dot" style={{ background: hexOf(n) }}></span>
            <span className="sg-rv-name">{n}</span>
            <span className="sg-rv-guess">{"“" + x.guess + "”" + (x.right && x.how === "referee" ? " · the Referee's call" : "")}</span>
            <span className="sg-rv-pts">{x.right ? "+2" : "0"}</span>
          </div>
        );
      })}
      {(round.missed || []).map((n: string) => (
        <div key={n} className="sg-rv missed">
          <span className="hist-dot" style={{ background: hexOf(n) }}></span>
          <span className="sg-rv-name">{n}</span>
          <span className="sg-rv-guess">no guess</span>
          <span className="sg-rv-pts">0</span>
        </div>
      ))}
      {!round.forfeit ? (
        <div className="sg-rv artist">
          <span className="hist-dot" style={{ background: hexOf(round.artist) }}></span>
          <span className="sg-rv-name">{round.artist}</span>
          <span className="sg-rv-guess">the artist</span>
          <span className="sg-rv-pts">{"+" + ((round.points || {})[round.artist] || 0)}</span>
        </div>
      ) : null}
      {round.roast ? <div className="sg-roast">{round.roast}</div> : null}
      {round.judge === "match" && round.judge_note && round.judge_note !== "no_key" ? <div className="sg-hint">The Referee couldn't be reached this round - plain matching only.</div> : null}
    </div>
  );
}

/* The card: the current drawing (or the last one) and the scores. The
   image is keyed by its address, so a new drawing is a new image. */
export function SketchCard({ g, me }: { g: SketchState; me: string }) {
  const last = sgLastRound(g);
  const img = g.image && g.image.url ? g.image.url : last && last.image ? last.image.url : null;
  let cap = "";
  if (g.status === "running") cap = g.phase === "draw" ? (g.artist || "The artist") + " is drawing" : g.phase === "guess" ? "Guess " + (g.artist || "the artist") + "'s drawing" : "The Referee is judging";
  else if (last && !last.forfeit) cap = "Last: " + last.prompt;
  return (
    <div className="sg-card">
      {img ? <img key={img} className="sg-card-img" src={img} alt="The drawing" loading="lazy" /> : null}
      <div className="sg-card-side">
        {cap ? <div className="sg-card-cap">{cap}</div> : null}
        <SketchScores g={g} me={me} compact />
      </div>
    </div>
  );
}
