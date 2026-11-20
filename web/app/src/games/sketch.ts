import { el } from "../lib";
import type { GL } from "./render";

/* Sketch & Guess in the DOM (2026-11-20): the scoreboard, the artist's
   prompt and sketch pad (or an image of their own), the guess form, the
   last round's reveal, the history and the chat card. The pad keeps its
   strokes on the caller's side (the pad object lives on gameView for the
   round), so a poll never wipes a half-drawn picture. Images go to the
   server as a PNG data URL; agents send generated images the same way. */

export type SgPad = { round: number; el: HTMLElement; canvas: HTMLCanvasElement; strokes: Stroke[]; dataUrl: () => string; empty: () => boolean };
type Stroke = { color: string; size: number; pts: number[] };

const W = 640;
const H = 480;
const COLORS = ["#111827", "#ef4444", "#f97316", "#facc15", "#22c55e", "#3b82f6", "#a855f7", "#8b5a2b"];
const SIZES = [4, 10, 22];

export function sgLastRound(g: GL): GL | null {
  const rs: GL[] = (g && g.rounds) || [];
  return rs.length ? rs[rs.length - 1] : null;
}

function status(g: GL, p: GL): string {
  if (g.status !== "running") return "";
  if (p.name === g.artist) return g.phase === "draw" ? "drawing…" : "artist";
  if (g.phase === "guess") return p.committed ? "guessed ✓" : "thinking…";
  if (g.phase === "judging") return "…";
  return "";
}

export function sgScores(g: GL, me?: string, compact?: boolean): HTMLElement {
  const box = el("div", "sg-scores" + (compact ? " compact" : ""));
  const ps: GL[] = ((g && g.players) || []).slice().sort((a: GL, b: GL) => (b.score || 0) - (a.score || 0) || (a.name < b.name ? -1 : 1));
  ps.forEach((p: GL, i: number) => {
    const row = el("div", "sg-row" + (me && p.name === me ? " mine" : ""));
    row.style.setProperty("--who", p.hex || "#94a3b8");
    row.appendChild(el("span", "sg-rank", String(i + 1)));
    const d = el("span", "hist-dot");
    d.style.background = p.hex;
    row.appendChild(d);
    row.appendChild(el("span", "sg-name", p.name + (me && p.name === me ? " (you)" : "")));
    const st = compact ? (p.name === g.artist && g.status === "running" ? "🎨" : "") : status(g, p);
    if (st) row.appendChild(el("span", "sg-st", st));
    row.appendChild(el("span", "sg-score", String(p.score || 0)));
    box.appendChild(row);
  });
  return box;
}

/* The pad: a white page, a pen in eight colours and three sizes, an
   eraser, undo and clear. Pointer events cover mouse, pen and touch; the
   canvas takes touch-action: none so a stroke never scrolls the page. */
export function sgMakePad(round: number): SgPad {
  const box = el("div", "sg-pad");
  const canvas = el("canvas", "sg-canvas") as HTMLCanvasElement;
  canvas.width = W;
  canvas.height = H;
  canvas.setAttribute("aria-label", "Sketch pad");
  const ctx = canvas.getContext("2d");
  const strokes: Stroke[] = [];
  let color = COLORS[0]!;
  let size = SIZES[1]!;
  let erasing = false;
  const paint = () => {
    if (!ctx) return;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, W, H);
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
  };
  const at = (e: PointerEvent): [number, number] => {
    const r = canvas.getBoundingClientRect();
    return [((e.clientX - r.left) / Math.max(1, r.width)) * W, ((e.clientY - r.top) / Math.max(1, r.height)) * H];
  };
  let cur: Stroke | null = null;
  canvas.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);
    const [x, y] = at(e);
    cur = { color: erasing ? "#ffffff" : color, size: erasing ? Math.max(size, 22) : size, pts: [x, y] };
    strokes.push(cur);
    paint();
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!cur) return;
    const [x, y] = at(e);
    cur.pts.push(x, y);
    paint();
  });
  const end = () => {
    cur = null;
  };
  canvas.addEventListener("pointerup", end);
  canvas.addEventListener("pointercancel", end);
  const tools = el("div", "sg-tools");
  const swatches: HTMLButtonElement[] = [];
  COLORS.forEach((c) => {
    const b = el("button", "sg-swatch" + (c === color ? " on" : "")) as HTMLButtonElement;
    b.type = "button";
    b.style.background = c;
    b.setAttribute("aria-label", "Pen colour " + c);
    b.addEventListener("click", () => {
      color = c;
      erasing = false;
      swatches.forEach((x) => x.classList.toggle("on", x === b));
      eraser.classList.remove("on");
    });
    swatches.push(b);
    tools.appendChild(b);
  });
  const sizes: HTMLButtonElement[] = [];
  SIZES.forEach((s) => {
    const b = el("button", "sg-size" + (s === size ? " on" : "")) as HTMLButtonElement;
    b.type = "button";
    b.setAttribute("aria-label", "Pen size " + s);
    const dot = el("span", "sg-size-dot");
    dot.style.width = dot.style.height = Math.max(4, Math.round(s * 0.8)) + "px";
    b.appendChild(dot);
    b.addEventListener("click", () => {
      size = s;
      sizes.forEach((x) => x.classList.toggle("on", x === b));
    });
    sizes.push(b);
    tools.appendChild(b);
  });
  const eraser = el("button", "btn sm sg-tool", "Eraser") as HTMLButtonElement;
  eraser.type = "button";
  eraser.addEventListener("click", () => {
    erasing = !erasing;
    eraser.classList.toggle("on", erasing);
  });
  const undo = el("button", "btn sm sg-tool", "Undo") as HTMLButtonElement;
  undo.type = "button";
  undo.addEventListener("click", () => {
    strokes.pop();
    paint();
  });
  const clear = el("button", "btn sm sg-tool", "Clear") as HTMLButtonElement;
  clear.type = "button";
  clear.addEventListener("click", () => {
    strokes.length = 0;
    paint();
  });
  tools.appendChild(eraser);
  tools.appendChild(undo);
  tools.appendChild(clear);
  box.appendChild(canvas);
  box.appendChild(tools);
  paint();
  return { round, el: box, canvas, strokes, dataUrl: () => canvas.toDataURL("image/png"), empty: () => strokes.length === 0 };
}

/* The artist's panel: the secret prompt, the pad, and an image of your
   own as the other way in. */
export function sgArtistPanel(g: GL, pad: SgPad, onSend: (image: string) => void, onError: (msg: string) => void): HTMLElement {
  const you = g.you || {};
  const box = el("div", "sg-form sg-artist");
  const pr = el("div", "sg-prompt");
  pr.appendChild(el("span", "sg-prompt-cap", "Your prompt (secret)"));
  pr.appendChild(el("span", "sg-prompt-text", you.prompt || "?"));
  box.appendChild(pr);
  box.appendChild(el("div", "sg-hint", "Draw it - no letters or words. Guessable but not too easy: you score 1 for each player who gets it, up to 2."));
  box.appendChild(pad.el);
  const row = el("div", "sg-row-end");
  const file = el("input", "sg-file") as HTMLInputElement;
  file.type = "file";
  file.accept = "image/png,image/jpeg,image/gif,image/webp";
  file.hidden = true;
  const up = el("button", "btn sm sg-upload", "Use an image…") as HTMLButtonElement;
  up.type = "button";
  up.addEventListener("click", () => file.click());
  file.addEventListener("change", () => {
    const f = file.files && file.files[0];
    if (!f) return;
    if (f.size > 1500000) {
      onError("That image is over 1.5 MB - try a smaller one.");
      return;
    }
    const rd = new FileReader();
    rd.onload = () => onSend(String(rd.result || ""));
    rd.onerror = () => onError("Couldn't read that file.");
    rd.readAsDataURL(f);
  });
  const send = el("button", "btn sg-send", "Send drawing") as HTMLButtonElement;
  send.type = "button";
  send.addEventListener("click", () => {
    if (pad.empty()) {
      onError("Draw something first (or use an image).");
      return;
    }
    onSend(pad.dataUrl());
  });
  row.appendChild(file);
  row.appendChild(up);
  row.appendChild(send);
  box.appendChild(row);
  return box;
}

/* The guess form: one line, changeable until the guesses close. */
export function sgGuessForm(g: GL, draft: string, onDraft: (s: string) => void, onSend: (s: string) => void): HTMLElement {
  const you = g.you || {};
  const box = el("div", "sg-form sg-guess");
  box.appendChild(el("div", "sg-form-title", you.queued ? "Your guess is in - change it until the guesses close" : "What does the drawing show?"));
  const row = el("div", "sg-guess-row");
  const input = el("input", "sg-in") as HTMLInputElement;
  input.type = "text";
  input.maxLength = 80;
  input.placeholder = "Your guess";
  input.setAttribute("aria-label", "Your guess");
  input.value = draft;
  const send = el("button", "btn sg-send", you.queued ? "Change" : "Guess") as HTMLButtonElement;
  send.type = "button";
  const paint = () => {
    send.disabled = !input.value.trim();
  };
  input.addEventListener("input", () => {
    paint();
    onDraft(input.value);
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !send.disabled) {
      e.preventDefault();
      onSend(input.value.trim());
    }
  });
  send.addEventListener("click", () => {
    if (!send.disabled) onSend(input.value.trim());
  });
  paint();
  row.appendChild(input);
  row.appendChild(send);
  box.appendChild(row);
  if (you.queued) box.appendChild(el("div", "sg-hint", "Sealed: " + you.queued));
  return box;
}

/* One round's reveal: the prompt, each guess and who judged it. */
export function sgReveal(g: GL, round: GL | null, me?: string): HTMLElement | null {
  if (!round) return null;
  const box = el("div", "sg-reveal");
  const players: GL[] = g.players || [];
  const hexOf = (n: string) => (players.find((p: GL) => p.name === n) || { hex: "#94a3b8" }).hex;
  box.appendChild(el("div", "fl-cap", "Round " + round.n + " · " + round.artist + " drew"));
  if (round.image && round.image.url) {
    const img = el("img", "sg-rv-img") as HTMLImageElement;
    img.src = round.image.url;
    img.alt = round.artist + "'s drawing for round " + round.n;
    img.loading = "lazy";
    box.appendChild(img);
  }
  box.appendChild(el("div", "sg-rv-prompt", (round.forfeit ? "No drawing - the prompt was: " : "It was: ") + round.prompt));
  Object.keys(round.guesses || {}).forEach((n: string) => {
    const x = round.guesses[n];
    const row = el("div", "sg-rv " + (x.right ? "right" : "wrong") + (me && n === me ? " mine" : ""));
    const d = el("span", "hist-dot");
    d.style.background = hexOf(n);
    row.appendChild(d);
    row.appendChild(el("span", "sg-rv-name", n));
    row.appendChild(el("span", "sg-rv-guess", "“" + x.guess + "”" + (x.right && x.how === "referee" ? " · the Referee's call" : "")));
    row.appendChild(el("span", "sg-rv-pts", x.right ? "+2" : "0"));
    box.appendChild(row);
  });
  (round.missed || []).forEach((n: string) => {
    const row = el("div", "sg-rv missed");
    const d = el("span", "hist-dot");
    d.style.background = hexOf(n);
    row.appendChild(d);
    row.appendChild(el("span", "sg-rv-name", n));
    row.appendChild(el("span", "sg-rv-guess", "no guess"));
    row.appendChild(el("span", "sg-rv-pts", "0"));
    box.appendChild(row);
  });
  if (!round.forfeit) {
    const row = el("div", "sg-rv artist");
    const d = el("span", "hist-dot");
    d.style.background = hexOf(round.artist);
    row.appendChild(d);
    row.appendChild(el("span", "sg-rv-name", round.artist));
    row.appendChild(el("span", "sg-rv-guess", "the artist"));
    row.appendChild(el("span", "sg-rv-pts", "+" + ((round.points || {})[round.artist] || 0)));
    box.appendChild(row);
  }
  if (round.roast) box.appendChild(el("div", "sg-roast", round.roast));
  if (round.judge === "match" && round.judge_note && round.judge_note !== "no_key") box.appendChild(el("div", "sg-hint", "The Referee couldn't be reached this round - plain matching only."));
  return box;
}

export function sgHistoryRows(g: GL, row: (idx: string) => HTMLElement, who: (p: GL) => HTMLElement, list: HTMLElement): number {
  let n = 0;
  const players: GL[] = g.players || [];
  const byName = (nm: string): GL => players.find((p: GL) => p.name === nm) || { name: nm, hex: "#94a3b8" };
  ((g.rounds || []) as GL[]).forEach((r: GL) => {
    n++;
    const rw = row("Round " + r.n);
    const seg = el("span", "hist-seg");
    seg.appendChild(who(byName(r.artist)));
    seg.appendChild(el("span", "hist-act", (r.forfeit ? "no drawing · " : "drew · ") + r.prompt));
    rw.appendChild(seg);
    Object.keys(r.guesses || {}).forEach((nm: string) => {
      const x = r.guesses[nm];
      const s2 = el("span", "hist-seg");
      s2.appendChild(who(byName(nm)));
      s2.appendChild(el("span", "hist-act", (x.right ? "✓ " : "✗ ") + x.guess));
      rw.appendChild(s2);
    });
    list.appendChild(rw);
  });
  return n;
}

/* The card: the current drawing (or the last one) and the scores. */
export function sgCardBoard(g: GL, me?: string): HTMLElement {
  const wrap = el("div", "sg-card");
  const last = sgLastRound(g);
  const img = g.image && g.image.url ? g.image.url : last && last.image ? last.image.url : null;
  if (img) {
    const im = el("img", "sg-card-img") as HTMLImageElement;
    im.src = img;
    im.alt = "The drawing";
    im.loading = "lazy";
    wrap.appendChild(im);
  }
  const side = el("div", "sg-card-side");
  let cap = "";
  if (g.status === "running") cap = g.phase === "draw" ? (g.artist || "The artist") + " is drawing" : g.phase === "guess" ? "Guess " + (g.artist || "the artist") + "'s drawing" : "The Referee is judging";
  else if (last && !last.forfeit) cap = "Last: " + last.prompt;
  if (cap) side.appendChild(el("div", "sg-card-cap", cap));
  side.appendChild(sgScores(g, me, true));
  wrap.appendChild(side);
  return wrap;
}
