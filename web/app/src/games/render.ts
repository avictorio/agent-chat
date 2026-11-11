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

// The standard finished-match presentation, shared by the feed
// card, the arena and the Games tab so a result reads the same
// everywhere: a gold winner banner (trophy + name + final score)
// and a record line in one shape per kind.

export function winnerOf(g: GL): GL | null {
  if (!g || !g.winner) return null;
  return (g.players || []).find((p: GL) => p.name === g.winner) || null;
}

function winnerFirst(g: GL): GL[] {
  return (g.players || []).slice().sort((a: GL, b: GL) => (b.name === g.winner ? 1 : 0) - (a.name === g.winner ? 1 : 0));
}

// Final score, winner first: duel round wins, battleship ships sunk.
export function finalScore(g: GL): string {
  if (!g) return "";
  if (g.type === "duel") {
    const sc = g.score || {};
    const wins = (p: GL) => (sc[p.name] != null ? sc[p.name] : p.wins || 0);
    return winnerFirst(g).map(wins).join("–");
  }
  if (g.type === "battleship") return winnerFirst(g).map((p: GL) => p.sunk || 0).join("–");
  return "";
}

export function recordLine(g: GL): string {
  if (!g) return "";
  if (g.status === "cancelled") return "Called off" + (g.declined_by ? " · " + g.declined_by + " declined" : "");
  if (g.status !== "finished") return "";
  if (g.type === "battleship") {
    const hits = winnerFirst(g).map((p: GL) => p.hits || 0).join("–");
    return "Final · " + finalScore(g) + " ships · " + hits + " hits · " + (g.turn || 0) + " turns";
  }
  if (g.type === "duel") return "Final · " + finalScore(g) + " · " + (g.round || 0) + " rounds";
  return "Final · tick " + (g.tick || 0);
}

// The winner banner as a DOM node for the imperative surfaces
// (card boards, arenas). The React surfaces (Games tab, card
// footer) mirror this markup in WinnerBanner.tsx.
export function winnerBanner(g: GL): HTMLElement | null {
  if (!g || (g.status !== "finished" && g.status !== "cancelled")) return null;
  const b = el("div", "game-winner");
  if (g.status === "cancelled") {
    b.classList.add("off");
    b.appendChild(el("span", "gw-text", "Called off"));
    return b;
  }
  const w = winnerOf(g);
  if (!w) {
    b.classList.add("off");
    b.appendChild(el("span", "gw-text", "No winner"));
    return b;
  }
  // Arena surfaces get the ceremony: the arena re-renders on every
  // update, so the banner is (re)built at the finish moment and the
  // entrance plays then. Called-off and no-winner banners stay off.
  b.classList.add("ceremony");
  if (w.hex) b.style.setProperty("--win-c", w.hex);
  b.appendChild(el("span", "gw-trophy", "🏆"));
  b.appendChild(el("span", "gw-name", w.name));
  b.appendChild(el("span", "gw-text", "wins"));
  const score = finalScore(g);
  if (score) b.appendChild(el("span", "gw-score", score));
  const burst = el("span", "gw-burst");
  burst.setAttribute("aria-hidden", "true");
  for (let i = 0; i < 10; i++) burst.appendChild(el("i", ""));
  b.appendChild(burst);
  return b;
}

export function gameMetaText(g: GL): string {
  if (!g) return "";
  if (g.type === "battleship") {
    const line = (g.players || []).map((p: GL) => p.name + " " + (p.afloat != null ? p.afloat : 5) + " afloat").join(" · ");
    if (g.status === "finished" || g.status === "cancelled") return recordLine(g);
    if (g.status === "lobby") {
      const waiting = (g.players || []).filter((p: GL) => !p.accepted).map((p: GL) => p.name);
      return "Lobby · waiting on " + (waiting.join(", ") || "no one") + " · turn " + tickLen(g.turn_seconds || 3600) + (g.variant && g.variant !== "classic" ? " · " + g.variant : "");
    }
    if (g.phase === "setup") return "Placing fleets · turn " + tickLen(g.turn_seconds || 3600);
    return "Turn " + g.turn + " · " + (g.turn_of ? g.turn_of + " to fire" : "") + " · " + line;
  }
  if (g.type === "duel") {
    const sc = g.score || {};
    const dline = (g.players || [])
      .map((p: GL) => p.name + " " + (sc[p.name] != null ? sc[p.name] : p.wins || 0))
      .join(" · ");
    if (g.status === "finished" || g.status === "cancelled") return recordLine(g);
    if (g.status === "lobby") {
      const waiting = (g.players || []).filter((p: GL) => !p.accepted).map((p: GL) => p.name);
      return "Lobby · waiting on " + (waiting.join(", ") || "no one") + " · first to " + g.target;
    }
    return "Round " + g.round + " · first to " + g.target + " · ties replay · round " + tickLen(g.round_seconds || 600);
  }
  if (g.status === "finished" || g.status === "cancelled") return recordLine(g);
  if (g.status === "lobby") {
    const waiting = (g.players || []).filter((p: GL) => !p.accepted).map((p: GL) => p.name);
    return "Lobby · waiting on " + (waiting.join(", ") || "no one") + (g.mode === "async" ? " · async · resolves on everyone's move" : " · tick " + tickLen(g.tick_seconds || 120));
  }
  const alive = (g.players || []).filter((p: GL) => p.alive).length;
  let meta = "Tick " + g.tick + " · " + alive + " riding · " + (g.mode === "async" ? "async" : "tick " + tickLen(g.tick_seconds || 900));
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
  // The last trail cell per rider: the growth point, and for a dead
  // rider the end of the wreck.
  const lastCell: Record<number, GL> = {};
  (g.trails || []).forEach((c: GL) => {
    lastCell[c[2]] = c;
  });
  (g.players || []).forEach((p: GL, i: number) => {
    // A wreck sits dimmer than a live trail - the board remembers
    // the crash without competing with the riders still moving.
    const op = p.alive ? "0.45" : "0.25";
    (byColor[i] || []).forEach((c: GL) => {
      s += '<rect x="' + c[0] + '" y="' + c[1] + '" width="1" height="1" fill="' + p.hex + '" opacity="' + op + '"/>';
    });
    const lc = lastCell[i];
    if (lc) {
      if (p.alive) {
        // The newest segment draws itself in: a line from the previous
        // cell to the growth point, stroke-dashoffset over 250 ms, so
        // the trail visibly extends instead of appearing whole.
        const cells = byColor[i] || [];
        if (cells.length >= 2) {
          const a = cells[cells.length - 2];
          if (Math.abs(a[0] - lc[0]) + Math.abs(a[1] - lc[1]) === 1)
            s += '<line class="lc-draw" x1="' + (a[0] + 0.5) + '" y1="' + (a[1] + 0.5) + '" x2="' + (lc[0] + 0.5) + '" y2="' + (lc[1] + 0.5) + '" stroke="' + p.hex + '" stroke-width="0.62" stroke-linecap="round" pathLength="1"/>';
        }
        // The growth point sparks white and settles each render, so
        // the trail visibly extends tick over tick.
        s += '<rect class="lc-new" x="' + lc[0] + '" y="' + lc[1] + '" width="1" height="1" fill="#ffffff" opacity="0"/>';
      } else {
        // A permanent crash mark where the wreck ends.
        s +=
          '<path d="M' + (lc[0] + 0.18) + " " + (lc[1] + 0.18) + "L" + (lc[0] + 0.82) + " " + (lc[1] + 0.82) + "M" + (lc[0] + 0.82) + " " + (lc[1] + 0.18) + "L" + (lc[0] + 0.18) + " " + (lc[1] + 0.82) + '" stroke="' + p.hex + '" stroke-width="0.13" fill="none"/>';
      }
    }
  });
  (g.players || []).forEach((p: GL) => {
    if (p.alive && typeof p.x === "number")
      s += '<rect class="lc-head" x="' + p.x + '" y="' + p.y + '" width="1" height="1" fill="' + p.hex + '" stroke="#e0faff" stroke-width="0.14"/>';
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

// Reading the opponent is the duel's second game: per player, the
// throw mix over the match's rounds plus the clearest habit the
// record supports (switching after a loss, staying after a win).
// Lines appear only once a player has thrown at least three times.
export function duelTendencies(g: GL): { name: string; hex: string; line: string }[] {
  const rounds = (g.rounds || []).filter((r: GL) => r.throws);
  const out: { name: string; hex: string; line: string }[] = [];
  (g.players || []).forEach((p: GL) => {
    const counts: Record<string, number> = { rock: 0, paper: 0, scissors: 0 };
    let n = 0;
    let lossOpp = 0, lossSwitch = 0, winOpp = 0, winStay = 0;
    for (let i = 0; i < rounds.length; i++) {
      const t = rounds[i].throws[p.name];
      if (!t || !(t in counts)) continue;
      counts[t] = (counts[t] || 0) + 1;
      n++;
      if (i > 0) {
        const prev = rounds[i - 1];
        const pt = prev.throws ? prev.throws[p.name] : null;
        if (pt && prev.winner && prev.winner !== p.name) {
          lossOpp++;
          if (t !== pt) lossSwitch++;
        } else if (pt && prev.winner === p.name) {
          winOpp++;
          if (t === pt) winStay++;
        }
      }
    }
    if (n < 3) return;
    const mix = ["rock", "paper", "scissors"]
      .filter((k) => (counts[k] || 0) > 0)
      .sort((a, b) => (counts[b] || 0) - (counts[a] || 0))
      .map((k) => k + " " + Math.round(((counts[k] || 0) / n) * 100) + "%")
      .join(" · ");
    let habit = "";
    if (lossOpp >= 2 && lossSwitch === lossOpp) habit = " · always switches after a loss";
    else if (lossOpp >= 2 && lossSwitch === 0) habit = " · never switches after a loss";
    else if (winOpp >= 2 && winStay === winOpp) habit = " · always rides a win";
    else if (winOpp >= 2 && winStay === 0) habit = " · never repeats a win";
    out.push({ name: p.name, hex: p.hex, line: mix + habit });
  });
  return out;
}

// Consecutive round wins counting back from the latest round;
// a tie or a loss ends the run. Two or more is a streak worth
// showing - streaks are the room's mythology.
export function duelStreak(g: GL, name: string): number {
  const rounds = g.rounds || [];
  let n = 0;
  for (let i = rounds.length - 1; i >= 0; i--) {
    if (rounds[i].winner === name) n++;
    else break;
  }
  return n;
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
    const streak = duelStreak(g, p.name);
    if (streak >= 2) row.appendChild(el("span", "duel-streak", "🔥" + streak));
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
    const fo = el("div", "duel-faceoff-line ribbon-in");
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

export function bsLabel(x: number, y: number): string {
  return String.fromCharCode(65 + x) + (y + 1);
}

export function bsCellXY(label: string): [number, number] {
  return [label.charCodeAt(0) - 65, parseInt(label.slice(1), 10) - 1];
}

// The latest shot, in words: "Ada fires A6 · HIT · Henry's 4-ship is
// sunk". Empty until somebody has fired.
export function lastMoveText(g: GL): string {
  const lm = g && g.last_move;
  if (!lm) return "";
  let t = lm.by + " fires " + lm.cell + " · " + (lm.result === "hit" ? "HIT" : "miss");
  if (lm.sunk) {
    const foe = (g.players || []).filter((p: GL) => p.name !== lm.by)[0];
    t += " · " + (foe ? foe.name + "'s " : "a ") + lm.sunk + "-ship is sunk";
  }
  return t;
}

// One captain's public waters as a tiny SVG for the feed card: every
// shot that has landed on them, sunk hulls filled dark red. The last
// shot fired at this board wears a white ring.
export function bsMiniSvg(board: GL, lastMove: GL, w?: number, h?: number): string {
  const bw = w || 10, bh = h || 10;
  let s = '<svg class="bs-mini-svg" viewBox="0 0 ' + bw + " " + bh + '" role="img" aria-label="' + board.name + ' waters">';
  s += '<rect x="0" y="0" width="' + bw + '" height="' + bh + '" fill="#04060d"/>';
  (board.sunk_ships || []).forEach((sh: GL) => {
    // The ship the last shot just sank flashes once, so a spectator
    // sees the sinking happen instead of finding it already sunk.
    const fresh = !!(lastMove && lastMove.sunk && lastMove.by !== board.name && sh.cells.indexOf(lastMove.cell) >= 0);
    sh.cells.forEach((c: string) => {
      const xy = bsCellXY(c);
      s += '<rect x="' + xy[0] + '" y="' + xy[1] + '" width="1" height="1" fill="#991b1b"' + (fresh ? ' class="bs-mini-new"' : "") + "/>";
    });
  });
  Object.keys(board.incoming || {}).forEach((c) => {
    const xy = bsCellXY(c);
    if (board.incoming[c] === "miss")
      s += '<circle cx="' + (xy[0] + 0.5) + '" cy="' + (xy[1] + 0.5) + '" r="0.16" fill="rgba(186,230,253,.65)"/>';
    else s += '<circle cx="' + (xy[0] + 0.5) + '" cy="' + (xy[1] + 0.5) + '" r="0.3" fill="#fb923c"/>';
  });
  if (lastMove && lastMove.by !== board.name) {
    const xy = bsCellXY(lastMove.cell);
    s += '<circle cx="' + (xy[0] + 0.5) + '" cy="' + (xy[1] + 0.5) + '" r="0.46" fill="none" stroke="#ffffff" stroke-width="0.09"/>';
  }
  s += "</svg>";
  return s;
}

// The pair of mini boards the card shows once the shooting starts,
// so the battle plays out in the feed, not only in the arena.
export function bsMiniBoards(g: GL): HTMLElement | null {
  if (!g.boards || !g.boards.length) return null;
  if (!(g.phase === "play" || g.status === "finished")) return null;
  const wrap = el("div", "bs-minis");
  g.boards.forEach((b: GL) => {
    const side = el("div", "bs-mini");
    side.appendChild(el("div", "bs-mini-name", b.name));
    const holder = el("div", "");
    holder.innerHTML = bsMiniSvg(b, g.last_move, g.w, g.h);
    side.appendChild(holder);
    wrap.appendChild(side);
  });
  return wrap;
}

// The battleship card body: a scoreboard, not the boards themselves -
// fleet positions are secret, so the feed shows counts and whose
// turn it is. The boards live in the arena, and only for the player
// they belong to.
export function battleshipBoard(g: GL): HTMLElement {
  const wrap = el("div", "duel-board");
  (g.players || []).forEach((p: GL) => {
    const row = el("div", "duel-row");
    const dot = el("span", "lc-dot");
    dot.style.background = p.hex;
    row.appendChild(dot);
    row.appendChild(el("span", "duel-name", p.name));
    const stats = el("span", "duel-state", (p.afloat != null ? p.afloat : 5) + " afloat · " + (p.hits || 0) + " hits · " + (p.sunk || 0) + " sunk");
    stats.style.marginLeft = "8px";
    row.appendChild(stats);
    const bd = (g.boards || []).filter((b: GL) => b.name === p.name)[0];
    if (bd) {
      const strip = fleetStrip(p.hex, (bd.sunk_ships || []).map((s: GL) => s.size), 6, g.fleet_sizes);
      strip.style.marginLeft = "auto";
      row.appendChild(strip);
    }
    wrap.appendChild(row);
  });
  let state = "";
  if (g.status === "lobby") state = (g.players || []).map((p: GL) => p.name + (p.accepted ? " in ✓" : " invited…")).join(" · ");
  else if (g.status === "running" && g.phase === "setup") state = (g.players || []).map((p: GL) => p.name + (p.placed ? " placed ✓" : " placing…")).join(" · ");
  else if (g.status === "running") state = "Turn " + g.turn + " · " + (g.turn_of ? g.turn_of + " to fire" : "");
  else if (g.status === "finished") state = recordLine(g);
  if (state) wrap.appendChild(el("div", "duel-stateline", state));
  const lmText = lastMoveText(g);
  if (lmText && (g.phase === "play" || g.status === "finished")) wrap.appendChild(el("div", "duel-stateline bs-lastline ribbon-in", "Last shot · " + lmText));
  const minis = bsMiniBoards(g);
  if (minis) wrap.appendChild(minis);
  if (g.you && g.you.playing && g.status === "running") {
    if (g.phase === "setup" && !(g.you.fleet && g.you.fleet.length)) wrap.appendChild(el("span", "duel-pill your-throw", "PLACE YOUR FLEET"));
    else if (g.phase === "play" && g.you.your_turn) wrap.appendChild(el("span", "duel-pill your-throw", "YOUR SHOT"));
  }
  return wrap;
}

// The fleet as a strip of hull silhouettes, longest first: an afloat
// hull wears its captain's color, a sunk one sits dark and low.
// sunkSizes lists the sizes already on the ocean floor.
export function fleetStrip(hex: string, sunkSizes: number[], unit?: number, sizes?: number[]): HTMLElement {
  const strip = el("div", "bs-strip");
  const left = sunkSizes.slice();
  (sizes && sizes.length ? sizes : [5, 4, 3, 3, 2]).forEach((size) => {
    const i = left.indexOf(size);
    const sunk = i >= 0;
    if (sunk) left.splice(i, 1);
    const hull = el("span", "bs-hull" + (sunk ? " sunk" : ""));
    hull.style.width = size * (unit || 8) + "px";
    if (!sunk) hull.style.background = hex;
    hull.title = "a " + size + "-ship" + (sunk ? " (sunk)" : "");
    strip.appendChild(hull);
  });
  return strip;
}

// One 10x10 board as a DOM grid inside a coordinate frame (A-J
// across, 1-10 down). states maps a cell label ("C5") to
// "ship" | "hit" | "miss" | "sunk"; shipHex colors ship cells. When
// onFire is given, unfired cells are buttons that report their label.
// ships (optional) groups cells into hulls so a ship reads as one
// tapered shape - bow at its first cell, stern at its last - instead
// of a row of squares.
export function bsGrid(states: Record<string, string>, shipHex: string, onFire: ((label: string) => void) | null, ships?: GL[], verb?: string, dims?: GL): HTMLElement {
  const bw = (dims && dims.w) || 10, bh = (dims && dims.h) || 10;
  const seg: Record<string, string> = {};
  (ships || []).forEach((s: GL) => {
    const cells: string[] = s.cells || [];
    if (cells.length < 2) return;
    const horiz = (cells[0] || "").slice(1) === (cells[1] || "").slice(1);
    cells.forEach((c, i) => {
      seg[c] = (horiz ? "seg-h" : "seg-v") + (i === 0 ? " seg-start" : i === cells.length - 1 ? " seg-end" : " seg-mid");
    });
  });
  const grid = el("div", "bs-grid");
  grid.style.gridTemplateColumns = "repeat(" + bw + ", 1fr)";
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      const label = bsLabel(x, y);
      const st = states[label] || "";
      const cell = el(onFire && !st ? "button" : "div", "bs-cell " + st + (seg[label] ? " " + seg[label] : "")) as HTMLElement;
      if (st === "ship" || st === "hit") cell.style.backgroundColor = shipHex;
      if (st === "hit") cell.textContent = "✕";
      if (st === "sunk") cell.textContent = "✕";
      if (st === "miss") cell.textContent = "·";
      if (onFire && !st) {
        const b = cell as HTMLButtonElement;
        b.type = "button";
        b.setAttribute("aria-label", (verb || "Fire at ") + label);
        b.addEventListener("click", () => {
          // A shot gets an anticipation beat: the cell dips while the
          // shot is in flight, before the stream brings the result.
          if (!verb || verb.indexOf("Fire") === 0) b.classList.add("bs-aim");
          onFire(label);
        });
      }
      grid.appendChild(cell);
    }
  }
  const frame = el("div", "bs-frame");
  frame.appendChild(el("div", ""));
  const ax = el("div", "bs-axis-x");
  ax.style.gridTemplateColumns = "repeat(" + bw + ", 1fr)";
  for (let x = 0; x < bw; x++) ax.appendChild(el("span", "", String.fromCharCode(65 + x)));
  frame.appendChild(ax);
  const ay = el("div", "bs-axis-y");
  ay.style.gridTemplateRows = "repeat(" + bh + ", 1fr)";
  for (let y = 0; y < bh; y++) ay.appendChild(el("span", "", String(y + 1)));
  frame.appendChild(ay);
  frame.appendChild(grid);
  return frame;
}

export function duelScoreLine(g: GL): string {
  const sc = g.score || {};
  return (g.players || []).map((p: GL) => p.name + " " + (sc[p.name] != null ? sc[p.name] : p.wins || 0)).join(" · ");
}
