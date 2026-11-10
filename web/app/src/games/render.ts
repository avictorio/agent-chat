import { el } from "../lib";

// Pure game rendering, shared by the feed cards and the arena:
// the Light Cycles SVG board, the Duel scoreboard, the meta line,
// round verdicts and the draining round-clock bar. No state lives
// here — the store (./games) owns the cache and the arena views.

// Game payloads are richer than the shared summary types (heads,
// record keeper, per-round detail), so rendering works untyped.
/* eslint-disable @typescript-eslint/no-explicit-any */
export type GL = any;

export function tickLen(ts: number): string {
  return ts >= 3600 ? Math.round(ts / 3600) + " h" : Math.max(1, Math.round(ts / 60)) + " min";
}

export function gameMetaText(g: GL): string {
  if (!g) return "";
  if (g.type === "duel") {
    const sc = g.score || {};
    const dline = (g.players || [])
      .map((p: GL) => p.name + " " + (sc[p.name] != null ? sc[p.name] : p.wins || 0))
      .join(" · ");
    if (g.status === "finished") return "Final · " + dline + (g.winner ? " · " + g.winner + " takes the duel" : " · no winner");
    if (g.status === "cancelled") return "Cancelled · " + dline;
    if (g.status === "lobby") {
      const waiting = (g.players || []).filter((p: GL) => !p.accepted).map((p: GL) => p.name);
      return "Lobby · waiting on " + (waiting.join(", ") || "no one") + " · first to " + g.target;
    }
    return "Round " + g.round + " · first to " + g.target + " · round " + tickLen(g.round_seconds || 600);
  }
  if (g.status === "finished") return "Final · tick " + g.tick + (g.winner ? " · " + g.winner + " takes the grid" : " · no survivors");
  if (g.status === "cancelled") return "Cancelled · tick " + g.tick;
  if (g.status === "lobby") {
    const waiting = (g.players || []).filter((p: GL) => !p.accepted).map((p: GL) => p.name);
    return "Lobby · waiting on " + (waiting.join(", ") || "no one") + " · tick " + tickLen(g.tick_seconds || 120);
  }
  const alive = (g.players || []).filter((p: GL) => p.alive).length;
  let meta = "Tick " + g.tick + " · " + alive + " riding · tick " + tickLen(g.tick_seconds || 900);
  if (g.you && g.you.playing && g.you.alive && !g.you.queued) meta += " · your move";
  return meta;
}

export function boardSvg(g: GL): string {
  let s =
    '<svg class="lc-svg" viewBox="0 0 ' + g.w + " " + g.h + '" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Light Cycles board">';
  s += '<rect x="0" y="0" width="' + g.w + '" height="' + g.h + '" fill="#04060d"/>';
  let grid = "";
  for (let x = 1; x < g.w; x++) grid += "M" + x + " 0V" + g.h;
  for (let y = 1; y < g.h; y++) grid += "M0 " + y + "H" + g.w;
  s += '<path d="' + grid + '" stroke="rgba(56,189,248,0.07)" stroke-width="0.04" fill="none"/>';
  const byColor: Record<number, GL[]> = {};
  (g.trails || []).forEach((c: GL) => {
    (byColor[c[2]] = byColor[c[2]] || []).push(c);
  });
  (g.players || []).forEach((p: GL, i: number) => {
    (byColor[i] || []).forEach((c: GL) => {
      s += '<rect x="' + c[0] + '" y="' + c[1] + '" width="1" height="1" fill="' + p.hex + '" opacity="0.45"/>';
    });
  });
  (g.players || []).forEach((p: GL) => {
    if (p.alive && typeof p.x === "number")
      s += '<rect x="' + p.x + '" y="' + p.y + '" width="1" height="1" fill="' + p.hex + '" stroke="#e0faff" stroke-width="0.14"/>';
  });
  s += "</svg>";
  return s;
}

export const THROW_EMOJI: Record<string, string> = { rock: "🪨", paper: "📄", scissors: "✂️" };
export const THROW_BEATS: Record<string, string> = { rock: "crushes scissors", paper: "covers rock", scissors: "cut paper" };
const THROW_VERB: Record<string, string> = { rock: "crushes", paper: "covers", scissors: "cut" };

function capThrow(t: string): string {
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : "";
}

export function roundVerdict(r: GL, players: GL[]): { tie: boolean; text: string } {
  const t0 = (r.throws || {})[players[0].name];
  const t1 = (r.throws || {})[players[1].name];
  if (!r.winner) {
    if (t0 && t0 === t1) return { tie: true, text: "CLASH · identical throws, no score" };
    return { tie: true, text: "Level · no score" };
  }
  const loser = players.filter((p: GL) => p.name !== r.winner)[0];
  const tw = (r.throws || {})[r.winner];
  const tl = loser ? (r.throws || {})[loser.name] : null;
  if (!tw || !tl) return { tie: false, text: r.winner + " takes it by forfeit" };
  return { tie: false, text: capThrow(tw) + " " + (THROW_VERB[tw] || "beats") + " " + tl + " · " + r.winner + " takes it" };
}

export function setClockBar(bar: HTMLElement) {
  const dl = +(bar.getAttribute("data-duel-deadline") || 0);
  const dur = +(bar.getAttribute("data-duel-dur") || 1);
  const left = Math.max(0, dl - Date.now());
  const pct = Math.max(0, Math.min(100, (left / dur) * 100));
  if (bar.firstChild) (bar.firstChild as HTMLElement).style.width = pct + "%";
  bar.classList.toggle("low", pct < 20 && left > 0);
  const wrap = bar.parentElement;
  const lab = wrap ? wrap.querySelector(".duel-clocklabel") : null;
  if (lab) {
    const s = Math.ceil(left / 1000);
    lab.textContent =
      left > 0 ? Math.floor(s / 60) + ":" + ("0" + (s % 60)).slice(-2) + " left in the round" : "round closing…";
  }
}

export function clockBar(g: GL, withLabel: boolean): HTMLElement {
  const w = el("div", "duel-clockwrap");
  const bar = el("div", "duel-clockbar");
  bar.setAttribute("data-duel-deadline", String(g.deadline));
  bar.setAttribute("data-duel-dur", String((g.round_seconds || 600) * 1000));
  bar.appendChild(el("div", ""));
  w.appendChild(bar);
  if (withLabel) w.appendChild(el("div", "duel-clocklabel duel-stateline", ""));
  setClockBar(bar);
  return w;
}

export function duelBoard(g: GL): HTMLElement {
  const wrap = el("div", "duel-board");
  const sc = g.score || {};
  (g.players || []).forEach((p: GL) => {
    const row = el("div", "duel-row");
    const dot = el("span", "lc-dot");
    dot.style.background = p.hex;
    row.appendChild(dot);
    row.appendChild(el("span", "duel-name", p.name));
    let pips = "";
    for (let i = 0; i < (g.target || 0); i++) pips += i < (p.wins || 0) ? "●" : "○";
    const pipEl = el("span", "duel-pips", pips);
    pipEl.style.color = p.hex;
    row.appendChild(pipEl);
    const score = el("span", "duel-score", String(sc[p.name] != null ? sc[p.name] : p.wins || 0));
    score.style.color = p.hex;
    row.appendChild(score);
    wrap.appendChild(row);
  });
  if (g.status === "running") {
    const states = (g.players || []).map((p: GL) => p.name + (p.thrown ? " locked ✓" : " thinking…")).join(" · ");
    wrap.appendChild(el("div", "duel-stateline", states));
  } else if (g.status === "lobby") {
    const states = (g.players || []).map((p: GL) => p.name + (p.accepted ? " in ✓" : " invited…")).join(" · ");
    wrap.appendChild(el("div", "duel-stateline", states));
  }
  const rounds = g.rounds || [];
  if (rounds.length) {
    const last = rounds[rounds.length - 1];
    const v = roundVerdict(last, g.players || []);
    const fo = el("div", "duel-faceoff-line");
    const icons = (g.players || [])
      .map((p: GL) => {
        const t = (last.throws || {})[p.name];
        return t ? THROW_EMOJI[t] || "" : "—";
      })
      .join(" ");
    fo.appendChild(el("span", "fo-icons", icons));
    fo.appendChild(el("span", "", v.text));
    wrap.appendChild(fo);
  }
  if (g.you && g.you.playing && g.status === "running") {
    if (g.you.queued) wrap.appendChild(el("span", "duel-pill locked", "✓ LOCKED · " + g.you.queued));
    else wrap.appendChild(el("span", "duel-pill your-throw", "YOUR THROW"));
  }
  if (g.status === "running" && g.deadline) wrap.appendChild(clockBar(g, false));
  return wrap;
}

export function duelScoreLine(g: GL): string {
  const sc = g.score || {};
  return (g.players || []).map((p: GL) => p.name + " " + (sc[p.name] != null ? sc[p.name] : p.wins || 0)).join(" · ");
}
