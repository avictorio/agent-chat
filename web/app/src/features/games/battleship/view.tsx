import type { BattleshipPlayer, BattleshipShip, BattleshipState, BattleshipSunkShip, BattleshipTarget } from "@chat/contract";
import { el } from "../../../lib/index";
import { gameMetaText, winnerBanner } from "../shared/render";
import type { GameViewCtx } from "../shared/viewctx";
import { BattleshipScores, BsAim, BsBanner, BsFfaBoards, BsPlaceGrid, BsPlacePad, BsSonar, BsStrips, BsWarnings, BsWatchBoards, bsWarned } from "./BattleshipPanels";

/* Battleship: the 3D scene with the page's panels around it - the
   scoreboard (spectators, placement), the last shot's banner, the fleet
   strips, the placement buttons, the sonar line and the warnings, and
   without WebGL the flat boards. The panels are React
   (BattleshipPanels.tsx, mounted with ctx.panel). The fleet being placed
   stays here (bsDrafts) and goes to the scene as gameView.bsPlace, with
   the fire hook as gameView.bsFire: the scene places and fires through
   them, so each hull laid repaints the view and the scene together. */

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
function bsIsNewMove(g: BattleshipState): boolean {
  const lm = g && g.last_move;
  if (!lm) return false;
  const seen = bsSeenMove.get(g.id) || 0;
  if (lm.turn > seen) {
    bsSeenMove.set(g.id, lm.turn);
    return true;
  }
  return false;
}

export function renderBattleshipView(ctx: GameViewCtx, g: BattleshipState, force?: boolean) {
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
    (g.players || []).map((p: BattleshipPlayer) => (p.accepted ? 1 : 0) + "" + (p.placed ? 1 : 0) + "" + (p.shots || 0) + "" + (p.afloat || 0) + "" + (p.eliminated ? 1 : 0)).join("") +
    "|" +
    (you.fleet ? "fleet" : "") +
    "|" +
    (you.shots ? Object.keys(you.shots).length : 0) +
    "|" +
    (you.targets ? you.targets.map((t: BattleshipTarget) => Object.keys(t.shots || {}).length + "/" + (t.afloat || 0) + (t.eliminated ? "x" : "")).join(",") : "") +
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
  const me = players.filter((p: BattleshipPlayer) => p.name === myName)[0];
  const opp = players.filter((p: BattleshipPlayer) => p.name !== myName)[0];
  const freshMove = bsIsNewMove(g);
  if (!(you.playing && me && opp && g.phase === "setup" && !you.fleet)) bsDrafts.delete(g.id);
  if (ctx.gameView) ctx.gameView.bsPlace = null;
  if (!you.playing || !me || !opp) {
    // The arena shows both oceans full size below (the 3D scene or
    // the flat boards), so the scoreboard's mini boards only repeat
    // them - and on a phone they push the real boards below the fold.
    // The feed card keeps them.
    wrap.appendChild(
      ctx.panel(
        "scores",
        <div className="lc-board-big">
          <BattleshipScores g={g} minis={false} />
        </div>
      )
    );
    if (g.boards && g.boards.length && (g.phase === "play" || g.status === "finished")) {
      if (g.last_move) wrap.appendChild(ctx.panel("banner", <BsBanner g={g} fresh={freshMove} />));
      if (ctx.gameView) ctx.gameView.bsFire = null;
      // Every match gets the scene (a free-for-all lays its 3-6 oceans
      // in rows); without WebGL the scene is a note, so the boards
      // follow it.
      ctx.bsScene(g, wrap);
      if (ctx.flat()) wrap.appendChild(ctx.panel("watch", <BsWatchBoards g={g} fresh={freshMove} />));
      note.textContent = "Spectating - every shot is public; un-hit ships stay hidden.";
    } else {
      ctx.dropBs3d();
      note.textContent = "Spectating - fleets stay hidden; the boards are for their captains.";
    }
    wrap.appendChild(note);
  } else if (g.phase === "setup" && !you.fleet) {
    // Fleet placement: your ocean in the scene, the next hull a
    // hologram where it would lie - a click (a tap, then Place) lays
    // it. The buttons stay in the page; without WebGL the grid below is
    // the way to place.
    wrap.appendChild(
      ctx.panel(
        "scores",
        <div className="lc-board-big">
          <BattleshipScores g={g} />
        </div>
      )
    );
    let draft = bsDrafts.get(g.id);
    if (!draft) {
      draft = { placed: [], orient: "H" };
      bsDrafts.set(g.id, draft);
    }
    const FLEET: number[] = g.fleet_sizes && g.fleet_sizes.length ? g.fleet_sizes : [5, 4, 3, 3, 2];
    const placedCells = new Set<string>();
    const ships: { size: number; cells: string[] }[] = [];
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
    const random = () => {
      bsDrafts.delete(g.id);
      void ctx.sendMove(g.id, "random", note);
    };
    const go = () => {
      if (!draft) return;
      const spec = draft.placed.map((p) => p.start + p.dir).join(",");
      bsDrafts.delete(g.id);
      void ctx.sendMove(g.id, spec, note);
    };
    if (ctx.gameView) ctx.gameView.bsPlace = { placed: draft.placed.slice(), orient: draft.orient, next: nextSize, onPlace: tryPlace, onRotate: rotate, onUndo: undoLast };
    ctx.bsScene(g, wrap);
    if (ctx.flat()) wrap.appendChild(ctx.panel("place-grid", <BsPlaceGrid g={g} hex={me.hex} states={states} ships={ships} onPlace={tryPlace} />));
    wrap.appendChild(ctx.panel("place", <BsPlacePad next={nextSize} orient={draft.orient} onRotate={rotate} onUndo={undoLast} onRandom={random} onGo={go} />));
    if (!note.textContent)
      note.textContent = !ctx.flat()
        ? "Click (or tap, then Place) a cell in your waters to lay the next hull's bow there - the hologram shows where it lies; R rotates, Backspace takes it back. Your fleet stays secret until the shooting starts."
        : "Tap a cell to lay the next hull's bow there. Your fleet stays secret until the shooting starts.";
    wrap.appendChild(note);
  } else if (players.length > 2) {
    // Free-for-all: your own waters plus one ocean per rival, each
    // showing YOUR shots at that captain - the ocean you tap is the
    // target, and the shot goes out as "Name:Cell". Eliminated
    // captains are wreck charts (no fire). Without WebGL the flat
    // boards below are the aim.
    const canFire = g.status === "running" && g.phase === "play" && you.your_turn && !you.eliminated;
    if (ctx.gameView) ctx.gameView.bsFire = canFire ? (label: string, target?: string) => { void ctx.sendMove(g.id, (target ? target + ":" : "") + label, note); } : null;
    if (g.last_move) wrap.appendChild(ctx.panel("banner", <BsBanner g={g} fresh={freshMove} />));
    ctx.bsScene(
      g,
      wrap,
      ctx.panel(
        "strips",
        <BsStrips
          g={g}
          fleets={[
            { label: "Your fleet" + (you.eliminated ? " — wreck" : ""), hex: me.hex, sunk: (you.fleet || []).filter((s: BattleshipShip) => s.sunk).map((s: BattleshipShip) => s.size) },
            ...(you.targets || []).map((t: BattleshipTarget) => ({ label: t.name + (t.eliminated ? " — wreck" : ""), hex: t.hex, sunk: (t.sunk_ships || []).map((s: BattleshipSunkShip) => s.size) })),
          ]}
        />
      )
    );
    const flat = ctx.flat();
    const fire = (dir: string) => {
      void ctx.sendMove(g.id, dir, note);
    };
    if (flat) wrap.appendChild(ctx.panel("ffa", <BsFfaBoards g={g} me={me} canFire={!!canFire} fresh={freshMove} onFire={fire} />));
    if (g.sonar && g.phase === "play" && g.status === "running") wrap.appendChild(ctx.panel("sonar", <BsSonar g={g} ffa />));
    if (g.status === "running" && g.phase === "play") {
      if (bsWarned(g)) wrap.appendChild(ctx.panel("warn", <BsWarnings g={g} ffa />));
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
    if (g.last_move) wrap.appendChild(ctx.panel("banner", <BsBanner g={g} fresh={freshMove} />));
    if (ctx.gameView) ctx.gameView.bsFire = canFire ? (label: string) => { void ctx.sendMove(g.id, label, note); } : null;
    // In 3D the fleet strips (sizes still afloat) sit under the scene:
    // the flat boards that carry them are not built.
    ctx.bsScene(
      g,
      wrap,
      ctx.panel(
        "strips",
        <BsStrips
          g={g}
          fleets={[
            { label: "Your fleet", hex: me.hex, sunk: (you.fleet || []).filter((s: BattleshipShip) => s.sunk).map((s: BattleshipShip) => s.size) },
            { label: opp.name + "'s fleet", hex: opp.hex, sunk: (you.sunk_ships || []).map((s: BattleshipSunkShip) => s.size) },
          ]}
        />
      )
    );
    // No WebGL: the scene is a note, and their waters are the only
    // way to aim - a plain grid of your shots, a tap fires
    if (ctx.flat()) {
      const fire = (label: string) => {
        void ctx.sendMove(g.id, label, note);
      };
      wrap.appendChild(ctx.panel("aim", <BsAim g={g} opp={opp} canFire={!!canFire} fresh={freshMove} onFire={fire} />));
    }
    // whose shot it is, and the turn clock, are the turn banner's
    if (g.sonar && g.phase === "play" && g.status === "running") wrap.appendChild(ctx.panel("sonar", <BsSonar g={g} />));
    if (g.status === "running" && g.phase === "play") {
      if (bsWarned(g)) wrap.appendChild(ctx.panel("warn", <BsWarnings g={g} />));
      if (you.playing) {
        const hint = !ctx.flat()
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
