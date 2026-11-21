import { el } from "../../../lib/index";
import { battleshipBoard, bsGrid, fleetStrip, gameMetaText, type GL, lastMoveText, winnerBanner } from "../shared/render";
import type { GameViewCtx } from "../shared/viewctx";

// Battleship impact dressing: the newest shot (by turn) is animated
// once per match - later repaints keep only its white ring. The map
// remembers which turn each match last celebrated.
const bsSeenMove = new Map<number, number>();

// Tap-to-place drafts, kept outside the render so a state refresh
// mid-placement does not lift the hulls already laid.
const bsDrafts = new Map<number, { placed: { start: string; dir: string; size: number }[]; orient: string }>();

// The cells a hull would occupy from a bow cell, or null when it
// would run off the board.
function bsShipCells(start: string, dir: string, size: number, bw?: number, bh?: number): string[] | null {
  const x0 = start.charCodeAt(0) - 65;
  const y0 = parseInt(start.slice(1), 10) - 1;
  const cells: string[] = [];
  for (let i = 0; i < size; i++) {
    const x = dir === "H" ? x0 + i : x0;
    const y = dir === "H" ? y0 : y0 + i;
    if (x > (bw || 10) - 1 || y > (bh || 10) - 1) return null;
    cells.push(String.fromCharCode(65 + x) + (y + 1));
  }
  return cells;
}
function bsIsNewMove(g: GL): boolean {
  const lm = g && g.last_move;
  if (!lm) return false;
  const seen = bsSeenMove.get(g.id) || 0;
  if (lm.turn > seen) {
    bsSeenMove.set(g.id, lm.turn);
    return true;
  }
  return false;
}

function bsInnerGrid(frame: HTMLElement): HTMLElement | null {
  if (frame.classList.contains("bs-grid")) return frame;
  return frame.querySelector(".bs-grid");
}

function bsCellAt(frame: HTMLElement, label: string): HTMLElement | null {
  const inner = bsInnerGrid(frame);
  if (!inner) return null;
  // The column count rides in the grid's inline style (repeat(N, 1fr),
  // set by the board builder from the match's w). The old fixed 10
  // landed every marker past row 1 on the wrong cell in skirmish,
  // whose boards are 8 wide.
  const m = /repeat\((\d+)/.exec(inner.style.gridTemplateColumns || "");
  const w = m && m[1] ? parseInt(m[1], 10) : 10;
  const idx = label.charCodeAt(0) - 65 + (parseInt(label.slice(1), 10) - 1) * w;
  return (inner.children[idx] as HTMLElement) || null;
}

// Ring (and, on first sight, burst or splash) the cell the last shot
// landed on, in the grid of the captain whose waters took it.
function markLastShot(grid: HTMLElement, g: GL, ownerName: string, fresh: boolean) {
  const lm = g && g.last_move;
  if (!lm || lm.by === ownerName) return;
  // In a free-for-all the shot names its target: ring it only on
  // that captain's board, not on every rival's.
  if (lm.target && lm.target !== ownerName) return;
  const cell = bsCellAt(grid, lm.cell);
  if (!cell) return;
  cell.classList.add("bs-last");
  if (fresh) cell.classList.add(lm.result === "hit" ? "bs-boom" : "bs-splash");
}

// On first sight of a sinking, play the sinking on the ship the last
// shot just finished: its cells flash and settle into the wreck.
function markSinking(grid: HTMLElement, ships: GL[], g: GL, ownerName: string, fresh: boolean) {
  const lm = g && g.last_move;
  if (!fresh || !lm || !lm.sunk || lm.by === ownerName) return;
  const ship = (ships || []).filter((s: GL) => s.size === lm.sunk && (s.cells || []).indexOf(lm.cell) >= 0)[0];
  if (!ship) return;
  ship.cells.forEach((c: string) => {
    const cell = bsCellAt(grid, c);
    if (cell) cell.classList.add("bs-sinking");
  });
}

// The arena banner announcing the last shot, duel-verdict style.
function bsBanner(g: GL, fresh: boolean): HTMLElement | null {
  const lm = g && g.last_move;
  if (!lm) return null;
  const b = el("div", "duel-verdict bs-verdict" + (lm.result === "hit" ? "" : " clash"));
  b.appendChild(el("span", "v-icons", lm.result === "hit" ? "💥" : "💦"));
  b.appendChild(el("span", "", lastMoveText(g)));
  if (lm.sunk) b.style.borderColor = "#f97316";
  if (fresh) b.classList.add("reveal-in");
  return b;
}

export function renderBattleshipView(ctx: GameViewCtx, g: GL, force?: boolean) {
  if (!ctx.gameView) return;
  const you = g.you || { playing: false };
  const key =
    g.status +
    "|" +
    (g.phase || "") +
    "|" +
    g.turn +
    "|" +
    (g.turn_of || "") +
    "|" +
    (g.players || []).map((p: GL) => (p.accepted ? 1 : 0) + "" + (p.placed ? 1 : 0) + "" + (p.shots || 0) + "" + (p.afloat || 0) + "" + (p.eliminated ? 1 : 0)).join("") +
    "|" +
    (you.fleet ? "fleet" : "") +
    "|" +
    (you.shots ? Object.keys(you.shots).length : 0) +
    "|" +
    (you.targets ? you.targets.map((t: GL) => Object.keys(t.shots || {}).length + "/" + (t.afloat || 0) + (t.eliminated ? "x" : "")).join(",") : "") +
    "|" +
    ctx.youSig(g) +
    "|" +
    (g.salvo_left == null ? "" : g.salvo_left) +
    "|" +
    (g.sonar ? g.sonar.turn : "") +
    "|" +
    (g.last_move ? g.last_move.turn : "") +
    "|" +
    ((ctx.gameView && ctx.gameView.tab) || "game");
  if (!ctx.claimRender(key, force)) return;
  const wrap = ctx.gameView.wrap;
  // Emptying the wrap detaches the scene: remember a focused scene
  // (keyboard aim or placement) so bsScene can hand focus back.
  ctx.rememberBsFocus();
  wrap.textContent = "";
  wrap.appendChild(el("div", "lc-meta", gameMetaText(g)));
  const wb = winnerBanner(g);
  if (wb) wrap.appendChild(wb);
  const rr = ctx.resultRow(g);
  if (rr) wrap.appendChild(rr);
  const tb = ctx.turnBanner(g);
  if (tb) wrap.appendChild(tb);
  wrap.appendChild(ctx.arenaTabs(g));
  const note = el("div", "lc-note", "");
  if (ctx.gameView.tab === "history") {
    ctx.dropBs3d();
    wrap.appendChild(ctx.historyList(g));
    return;
  }
  if (g.status === "lobby") {
    ctx.dropBs3d();
    wrap.appendChild(ctx.lobbyPanel(g, note));
    wrap.appendChild(note);
    return;
  }
  const players = g.players || [];
  const myName = ctx.opts.meName();
  const me = players.filter((p: GL) => p.name === myName)[0];
  const opp = players.filter((p: GL) => p.name !== myName)[0];
  const freshMove = bsIsNewMove(g);
  if (!(you.playing && me && opp && g.phase === "setup" && !you.fleet)) bsDrafts.delete(g.id);
  if (ctx.gameView) ctx.gameView.bsPlace = null;
  if (!you.playing || !me || !opp) {
    const big = el("div", "lc-board-big");
    const board = battleshipBoard(g);
    // The arena shows both oceans full size below (the 3D scene or
    // the 2D boards), so the scoreboard's mini boards only repeat
    // them - and on a phone they pushed the real boards below the
    // fold. The feed card keeps them.
    if (g.boards && g.boards.length && (g.phase === "play" || g.status === "finished")) {
      const minis = board.querySelector(".bs-minis");
      if (minis) minis.remove();
    }
    big.appendChild(board);
    wrap.appendChild(big);
    if (g.boards && g.boards.length && (g.phase === "play" || g.status === "finished")) {
      const banner = bsBanner(g, freshMove);
      if (banner) wrap.appendChild(banner);
      if (ctx.gameView) ctx.gameView.bsFire = null;
      // Every match gets the scene (a free-for-all lays its 3-6 oceans
      // in rows); without WebGL the scene is a note, so the boards
      // follow it.
      ctx.bsScene(g, wrap);
      const boards = el("div", "bs-boards");
      if (!ctx.webglOk()) g.boards.forEach((b: GL) => {
        const states: Record<string, string> = {};
        Object.keys(b.incoming || {}).forEach((c) => {
          states[c] = b.incoming[c];
        });
        (b.sunk_ships || []).forEach((s: GL) => {
          s.cells.forEach((c: string) => {
            states[c] = "sunk";
          });
        });
        const side = el("div", "bs-side" + (b.eliminated ? " bs-wreck" : ""));
        side.appendChild(el("div", "bs-title", b.name + "'s waters" + (b.eliminated ? " — wreck" : "")));
        side.appendChild(fleetStrip(b.hex, (b.sunk_ships || []).map((s: GL) => s.size), undefined, g.fleet_sizes));
        const grid = bsGrid(states, b.hex, null, b.sunk_ships || [], undefined, g);
        markLastShot(grid, g, b.name, freshMove);
        markSinking(grid, b.sunk_ships || [], g, b.name, freshMove);
        side.appendChild(grid);
        boards.appendChild(side);
      });
      if (boards.childElementCount) wrap.appendChild(boards);
      note.textContent = "Spectating - every shot is public; un-hit ships stay hidden.";
    } else {
      ctx.dropBs3d();
      note.textContent = "Spectating - fleets stay hidden; the boards are for their captains.";
    }
    wrap.appendChild(note);
  } else if (g.phase === "setup" && !you.fleet) {
    // Fleet placement (in 3D since 2026-11-20): your ocean in the
    // scene, the next hull a hologram where it would lie - a click (a
    // tap, then Place) lays it. The buttons stay in the page; without
    // WebGL the grid below is the way to place.
    const big = el("div", "lc-board-big");
    big.appendChild(battleshipBoard(g));
    wrap.appendChild(big);
    let draft = bsDrafts.get(g.id);
    if (!draft) {
      draft = { placed: [], orient: "H" };
      bsDrafts.set(g.id, draft);
    }
    const FLEET: number[] = g.fleet_sizes && g.fleet_sizes.length ? g.fleet_sizes : [5, 4, 3, 3, 2];
    const placedCells = new Set<string>();
    const ships: GL[] = [];
    draft.placed.forEach((p) => {
      const cells = bsShipCells(p.start, p.dir, p.size, g.w, g.h) || [];
      cells.forEach((c) => placedCells.add(c));
      ships.push({ size: p.size, cells });
    });
    const states: Record<string, string> = {};
    placedCells.forEach((c) => {
      states[c] = "ship";
    });
    const nextSize = FLEET[draft.placed.length] || 0;
    const tryPlace = (label: string) => {
      if (!nextSize || !draft) return;
      const cells = bsShipCells(label, draft.orient, nextSize, g.w, g.h);
      if (!cells) {
        note.textContent = "That hull runs off the board from " + label + " - start it closer to the middle, or rotate it.";
        return;
      }
      if (cells.some((c) => placedCells.has(c))) {
        note.textContent = "That hull overlaps one already down - give it clear water.";
        return;
      }
      draft.placed.push({ start: label, dir: draft.orient, size: nextSize });
      note.textContent = "";
      renderBattleshipView(ctx, g, true);
    };
    const rotate = () => {
      if (!draft) return;
      draft.orient = draft.orient === "H" ? "V" : "H";
      renderBattleshipView(ctx, g, true);
    };
    const undoLast = () => {
      if (!draft || !draft.placed.length) return;
      draft.placed.pop();
      renderBattleshipView(ctx, g, true);
    };
    if (ctx.gameView) ctx.gameView.bsPlace = { placed: draft.placed.slice(), orient: draft.orient, next: nextSize, onPlace: tryPlace, onRotate: rotate, onUndo: undoLast };
    ctx.bsScene(g, wrap);
    if (!ctx.webglOk()) {
      const boards = el("div", "bs-boards");
      const side = el("div", "bs-side");
      side.appendChild(el("div", "bs-title", "Your waters - place your fleet"));
      side.appendChild(bsGrid(states, me.hex, tryPlace, ships, "Place at ", g));
      boards.appendChild(side);
      wrap.appendChild(boards);
    }
    wrap.appendChild(
      el(
        "div",
        "duel-statusline",
        nextSize
          ? "Next hull: your " + nextSize + "-ship, lying " + (draft.orient === "H" ? "horizontal" : "vertical") + " from the cell you tap."
          : "Fleet complete - send it when it looks right."
      )
    );
    const row = el("div", "duel-pad");
    const rot = el("button", "duel-btn", "Rotate hull");
    rot.type = "button";
    rot.addEventListener("click", rotate);
    row.appendChild(rot);
    const undo = el("button", "duel-btn quiet", "Undo last hull");
    undo.type = "button";
    undo.addEventListener("click", undoLast);
    row.appendChild(undo);
    const rnd = el("button", "duel-btn quiet", "Place randomly instead");
    rnd.type = "button";
    rnd.addEventListener("click", () => {
      bsDrafts.delete(g.id);
      void ctx.sendMove(g.id, "random", note);
    });
    row.appendChild(rnd);
    if (!nextSize) {
      const go = el("button", "duel-btn", "Place this fleet");
      go.type = "button";
      go.addEventListener("click", () => {
        if (!draft) return;
        const spec = draft.placed.map((p) => p.start + p.dir).join(",");
        bsDrafts.delete(g.id);
        void ctx.sendMove(g.id, spec, note);
      });
      row.appendChild(go);
    }
    wrap.appendChild(row);
    if (!note.textContent)
      note.textContent = ctx.webglOk()
        ? "Click (or tap, then Place) a cell in your waters to lay the next hull's bow there - the hologram shows where it lies; R rotates, Backspace takes it back. Your fleet stays secret until the shooting starts."
        : "Tap a cell to lay the next hull's bow there. Your fleet stays secret until the shooting starts.";
    wrap.appendChild(note);
  } else if (players.length > 2) {
    // Free-for-all (2026-11-17; in 3D since 2026-11-20): your own
    // waters plus one ocean per rival, each showing YOUR shots at
    // that captain - the ocean you tap is the target, and the shot
    // goes out as "Name:Cell". Eliminated captains are wreck charts
    // (no fire). Without WebGL the 2D boards below are the aim.
    const canFire = g.status === "running" && g.phase === "play" && you.your_turn && !you.eliminated;
    if (ctx.gameView) ctx.gameView.bsFire = canFire ? (label: string, target?: string) => { void ctx.sendMove(g.id, (target ? target + ":" : "") + label, note); } : null;
    const banner = bsBanner(g, freshMove);
    if (banner) wrap.appendChild(banner);
    ctx.bsScene(
      g,
      wrap,
      ctx.bsStrips3d(g, [
        { label: "Your fleet" + (you.eliminated ? " — wreck" : ""), hex: me.hex, sunk: (you.fleet || []).filter((s: GL) => s.sunk).map((s: GL) => s.size) },
        ...(you.targets || []).map((t: GL) => ({ label: t.name + (t.eliminated ? " — wreck" : ""), hex: t.hex, sunk: (t.sunk_ships || []).map((s: GL) => s.size) })),
      ])
    );
    const boards = el("div", "bs-boards");
    const ownStates: Record<string, string> = {};
    (you.fleet || []).forEach((s: GL) => {
      s.cells.forEach((c: string) => {
        ownStates[c] = s.hits.indexOf(c) >= 0 ? (s.sunk ? "sunk" : "hit") : "ship";
      });
    });
    Object.keys(you.incoming || {}).forEach((c) => {
      if (!ownStates[c]) ownStates[c] = "miss";
    });
    const flat = !ctx.webglOk();
    const ownWrap = el("div", "bs-side");
    ownWrap.appendChild(el("div", "bs-title", "Your waters" + (you.eliminated ? " — wreck" : "")));
    ownWrap.appendChild(fleetStrip(me.hex, (you.fleet || []).filter((s: GL) => s.sunk).map((s: GL) => s.size), undefined, g.fleet_sizes));
    const ownGrid = bsGrid(ownStates, me.hex, null, you.fleet || [], undefined, g);
    markLastShot(ownGrid, g, myName, freshMove);
    markSinking(ownGrid, you.fleet || [], g, myName, freshMove);
    ownWrap.appendChild(ownGrid);
    if (flat) boards.appendChild(ownWrap);
    if (flat) (you.targets || []).forEach((t: GL) => {
      const tStates: Record<string, string> = {};
      Object.keys(t.shots || {}).forEach((c) => {
        tStates[c] = t.shots[c];
      });
      (t.sunk_ships || []).forEach((s: GL) => {
        s.cells.forEach((c: string) => {
          tStates[c] = "sunk";
        });
      });
      const tWrap = el("div", "bs-side" + (t.eliminated ? " bs-wreck" : ""));
      tWrap.appendChild(
        el("div", "bs-title", t.name + "'s waters" + (t.eliminated ? " — wreck" : canFire ? " - tap a cell to fire" : ""))
      );
      tWrap.appendChild(fleetStrip(t.hex, (t.sunk_ships || []).map((s: GL) => s.size), undefined, g.fleet_sizes));
      const tGrid = bsGrid(
        tStates,
        t.hex,
        canFire && !t.eliminated ? (label) => { void ctx.sendMove(g.id, t.name + ":" + label, note); } : null,
        t.sunk_ships || [],
        undefined,
        g
      );
      markLastShot(tGrid, g, t.name, freshMove);
      markSinking(tGrid, t.sunk_ships || [], g, t.name, freshMove);
      tWrap.appendChild(tGrid);
      boards.appendChild(tWrap);
    });
    if (boards.childElementCount) wrap.appendChild(boards);
    if (g.sonar && g.phase === "play" && g.status === "running")
      wrap.appendChild(
        el(
          "div",
          "bs-sonar",
          g.sonar.target
            ? "📡 Sonar for " + g.sonar.for + ": a hull cell of " + g.sonar.target + "'s fleet - the leader - sits in " + g.sonar.label + "."
            : "📡 Sonar for " + g.sonar.for + ": a hull cell of the last ship sits in " + g.sonar.label + "."
        )
      );
    if (g.status === "running" && g.phase === "play") {
      (g.players || []).forEach((p: GL) => {
        const m = (g.misses || {})[p.name] || 0;
        if (m >= 2) wrap.appendChild(el("div", "bs-warn", "⚠ " + p.name + " has missed " + m + " turns in a row — one more and they're eliminated."));
        else if (m === 1) wrap.appendChild(el("div", "bs-warn soft", p.name + " has missed a turn — three in a row eliminates them."));
      });
      if (you.eliminated) note.textContent = "You are eliminated — your fleet is a wreck chart now. The sea fights on without you.";
      else if (you.playing) {
        const hint = flat
          ? ctx.arenaHint("bs-play-ffa", "Tap a cell on a rival's board to fire at that captain — ✕ is a hit, · is a miss, dark hulls are sunk. Wreck boards can't be fired at.")
          : ctx.arenaHint(
              "bs-play-ffa-3d",
              "Tap a cell in any rival's waters to fire at that captain (or arrow keys to aim - past an edge for the next rival - and Enter to fire). Grey wreck charts can't be fired at."
            );
        if (hint) wrap.appendChild(hint);
      }
    }
    wrap.appendChild(note);
  } else {
    const canFire = g.status === "running" && g.phase === "play" && you.your_turn;
    const banner = bsBanner(g, freshMove);
    if (banner) wrap.appendChild(banner);
    if (ctx.gameView) ctx.gameView.bsFire = canFire ? (label: string) => { void ctx.sendMove(g.id, label, note); } : null;
    // In 3D the fleet strips (sizes still afloat) sit under the scene:
    // the 2D boards that carry them are not built.
    ctx.bsScene(
      g,
      wrap,
      ctx.bsStrips3d(g, [
        { label: "Your fleet", hex: me.hex, sunk: (you.fleet || []).filter((s: GL) => s.sunk).map((s: GL) => s.size) },
        { label: opp.name + "'s fleet", hex: opp.hex, sunk: (you.sunk_ships || []).map((s: GL) => s.size) },
      ])
    );
    // No WebGL: the scene is a note, and their waters are the only
    // way to aim - a plain grid of your shots, a tap fires
    if (!ctx.webglOk()) {
      const oppStates: Record<string, string> = {};
      Object.keys(you.shots || {}).forEach((c) => {
        oppStates[c] = you.shots[c];
      });
      (you.sunk_ships || []).forEach((s: GL) => {
        s.cells.forEach((c: string) => {
          oppStates[c] = "sunk";
        });
      });
      const aim = el("div", "bs-side bs-aim");
      aim.appendChild(el("div", "bs-title", opp.name + "'s waters" + (canFire ? " - tap a cell to fire" : "")));
      const oppGrid = bsGrid(oppStates, opp.hex, canFire ? (label) => { void ctx.sendMove(g.id, label, note); } : null, you.sunk_ships || [], undefined, g);
      markLastShot(oppGrid, g, opp.name, freshMove);
      aim.appendChild(oppGrid);
      wrap.appendChild(aim);
    }
    // whose shot it is, and the turn clock, are the turn banner's
    if (g.sonar && g.phase === "play" && g.status === "running")
      wrap.appendChild(el("div", "bs-sonar", "📡 Sonar for " + g.sonar.for + ": a hull cell of the last ship sits in " + g.sonar.label + "."));
    if (g.status === "running" && g.phase === "play") {
      (g.players || []).forEach((p: GL) => {
        const m = (g.misses || {})[p.name] || 0;
        if (m >= 2) wrap.appendChild(el("div", "bs-warn", "⚠ " + p.name + " has missed " + m + " turns in a row — one more forfeits the match."));
        else if (m === 1) wrap.appendChild(el("div", "bs-warn soft", p.name + " has missed a turn — three in a row forfeits the match."));
      });
      if (you.playing) {
        const hint = ctx.webglOk()
          ? ctx.arenaHint(
              "bs-play-3d",
              "Tap a cell in their waters to fire (or arrow keys to aim, Enter to fire) — flames are hits, rings are misses, burning wrecks are sunk."
            )
          : ctx.arenaHint("bs-play", "Tap a cell to fire — ✕ is a hit, · is a miss, dark hulls are sunk.");
        if (hint) wrap.appendChild(hint);
      }
    }
    wrap.appendChild(note);
  }
}
