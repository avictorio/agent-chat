import { staleTurn, type BattleshipState, type DuelState, type LightCyclesState } from "@chat/contract";
import type { Placing as BsPlacing } from "./battleship/BsArena3D";
import { createElement, type ComponentType, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { el, toast } from "../../lib/index";
import { gameDef, matchTitle } from "./shared/catalog";
import { clockSeconds, formatLeft, setClockBar, setTurnClock, type GL, type GLPlayer, type GLYou } from "./shared/render";
import type { Arena3dProps, GameStoreOptions, GameView, GameViewCtx, Host3d, Kind3d } from "./shared/viewctx";
import { GAMES } from "./registry";
import type { HistPlayer } from "./shared/history";


// Games: the chat cards and the arena views for all sixteen games. Both
// render from game state (GET /games/:id, kept fresh by stream "game"
// frames and slow polls). Cards are React components subscribed to this
// store; an arena view is native DOM inside the viewer around a lazy 3D
// scene, and its controls call the moves endpoint with the viewer's own
// invite. Without WebGL a note stands in for the scene, and flat panels
// carry what a game cannot play without.


/* ---------- the store ---------- */

/** A cached match; __frameOnly marks one known only from a stream frame
 * (the public summary) until its full state arrives. */
export type CachedGame = GL & { __frameOnly?: boolean };

export interface GameStore {
  cache: Map<number, CachedGame>;
  subscribe(fn: () => void): () => void;
  getVersion(): number;
  fetch(id: number): Promise<void>;
  onFrame(game: GL): void;
  openGame(id: number, type?: string): void;
  viewerClosed(): void;
  respond(id: number, accept: boolean): Promise<void>;
  rematch(g: GL): Promise<void>;
  awaitingCount(): number;
  meName(): string;
}

export function createGameStore(opts: GameStoreOptions): GameStore {
  const { client } = opts;
  const cache = new Map<number, CachedGame>();
  const listeners = new Set<() => void>();
  let version = 0;
  const notify = () => {
    version++;
    listeners.forEach((fn) => fn());
  };

  let gameView: GameView | null = null;
  let gameViewTimer = 0;
  // the scene element that had focus before a Battleship repaint
  let bsRefocus: HTMLElement | null = null;
  let gameRenderKey = "";
  // What each game's arena renderer (<game>/view.tsx) gets from the store.
  const ctx: GameViewCtx = {
    get gameView() {
      return gameView;
    },
    opts,
    panel,
    claimRender(key, force) {
      if (!force && key === gameRenderKey) return false;
      gameRenderKey = key;
      return true;
    },
    arenaHint,
    arenaTabs,
    bsScene,
    dropBs3d,
    dropLc3d,
    paintLc3d,
    rememberBsFocus,
    drop3d,
    dropDuel3d,
    historyList,
    host3d,
    lobbyPanel,
    makeHost3d,
    paint3d,
    paintDuel3d,
    resultRow,
    sendMove,
    turnBanner,
    webglOk,
    flat,
    youSig,
  };

  /* A game's DOM panel as React (ctx.panel): one root per slot, kept on
     the open view across repaints, so a panel keeps its state (a draft)
     while the view rebuilds the wrap around it. The host is display:
     contents, so the panel lays out as a child of the arena. */
  function panel(slot: string, node: ReactNode): HTMLElement {
    const gv = gameView!;
    const panels = gv.panels || (gv.panels = {});
    let p = panels[slot];
    if (!p) {
      const host = el("div", "panel-host");
      p = panels[slot] = { host, root: createRoot(host) };
    }
    const root = p.root;
    flushSync(() => root.render(node));
    return p.host;
  }
  function dropPanels() {
    const gv = gameView;
    if (!gv || !gv.panels) return;
    const ps = gv.panels;
    gv.panels = {};
    Object.values(ps).forEach((p) => p.root.unmount());
  }

  // Teach by playing: one dismissible hint line per arena, shown on
  // first views only (the dismissal persists per kind).
  function arenaHint(key: string, text: string): HTMLElement | null {
    try {
      if (localStorage.getItem("ac-hint-" + key) === "1") return null;
    } catch {
      return null;
    }
    const h = el("div", "arena-hint");
    h.appendChild(el("span", "", text));
    const x = el("button", "arena-hint-x", "✕") as HTMLButtonElement;
    x.type = "button";
    x.setAttribute("aria-label", "Dismiss hint");
    x.addEventListener("click", () => {
      try {
        localStorage.setItem("ac-hint-" + key, "1");
      } catch {
        // storage unavailable: the hint just comes back next time
      }
      h.remove();
    });
    h.appendChild(x);
    return h;
  }

  /* The turn banner: every running arena opens with one
     line that says who is up - "Your shot", "Ada is in · your throw
     decides the round", "Waiting on Henry" - the time left as a
     countdown (not a clock time), a bar that stays calm until the
     last quarter and then burns, and what happens when the clock runs
     out, when it is you it will happen to. The text keeps the
     duel-statusline class the suite reads. */
  function turnBanner(g: GL): HTMLElement | null {
    if (!g || g.status !== "running") return null;
    const me = opts.meName();
    const you: Partial<GLYou> = g.you || {};
    const players: GLPlayer[] = g.players || [];
    let text = "";
    let sub = "";
    let mine = false;
    const dur = clockSeconds(g) * 1000;
    let prefix = "";
    const own = GAMES[g.type]?.turnLine;
    if (own) {
      const line = own(g, me);
      text = line.text;
      sub = line.sub || "";
      mine = !!line.mine;
    } else {
      // Light Cycles, and a match without a type
      const waiting = players.filter((p: GLPlayer) => p.alive && !p.moved && p.name !== me).map((p: GLPlayer) => p.name);
      if (g.mode === "async") prefix = "cap in ";
      if (you.playing && you.alive && !you.queued) {
        mine = true;
        text = "Your move · tick " + g.tick;
        sub = g.mode === "async" ? "The tick resolves the moment every rider has moved." : "Miss the tick and your cycle rides straight on.";
      } else if (you.playing && you.alive) text = "You're set · waiting on " + (waiting.join(", ") || "the tick");
      else text = waiting.length ? "Waiting on " + waiting.join(", ") : "Tick " + g.tick + " is resolving…";
    }
    const b = el("div", "turn-banner" + (mine ? " mine" : ""));
    b.setAttribute("role", "status");
    const top = el("div", "turn-top");
    top.appendChild(el("span", "turn-text duel-statusline", text));
    if (g.deadline) top.appendChild(el("span", "turn-left", ""));
    b.appendChild(top);
    if (g.deadline && dur) {
      const bar = el("div", "turn-bar");
      bar.appendChild(el("div", ""));
      b.appendChild(bar);
      b.setAttribute("data-turn-deadline", String(g.deadline));
      b.setAttribute("data-turn-dur", String(dur));
      if (prefix) b.setAttribute("data-turn-prefix", prefix);
      setTurnClock(b);
    }
    if (sub) b.appendChild(el("div", "turn-sub", sub));
    return b;
  }

  /* A finished (or called-off) match puts Rematch beside the result,
     at the top, not below the board where a phone never scrolled. */
  function resultRow(g: GL): HTMLElement | null {
    if (g.status !== "finished" && g.status !== "cancelled") return null;
    const box = el("div", "result-row");
    const n = el("div", "lc-note", "");
    box.appendChild(rematchRow(g, n));
    box.appendChild(n);
    return box;
  }

  function rematchRow(g: GL, note: HTMLElement): HTMLElement {
    const row = el("div", "duel-pad");
    // Rematch is offered to everyone (see sendRematch).
    const b = el("button", "duel-btn", "Rematch");
    b.type = "button";
    b.addEventListener("click", () => {
      b.disabled = true;
      void sendRematch(g, note);
    });
    row.appendChild(b);
    if (!note.textContent) note.textContent = "Match over - run it back with the same settings.";
    return row;
  }

  const rematchInFlight = new Set<number>();

  async function sendRematch(g: GL, note: HTMLElement | null) {
    // One in-flight guard for every rematch surface (arena row, card,
    // games list), so a double tap never opens two lobbies. Rematch is
    // open to everyone: any member can run back a finished or
    // called-off match with its original players.
    if (rematchInFlight.has(g.id)) return;
    rematchInFlight.add(g.id);
    const body: Record<string, unknown> = { players: (g.players || []).map((p: GLPlayer) => p.name) };
    const own = gameDef(g.type)?.rematch;
    if (own) Object.assign(body, own(g));
    else {
      // Light Cycles, and a match without a type
      body.tick_seconds = g.tick_seconds;
      if (g.mode) body.mode = g.mode;
      body.w = g.w;
      body.h = g.h;
    }
    if (note) note.textContent = "Setting up the rematch…";
    try {
      const d = await client.createGame(body);
      if (d.game && d.game.id) {
        cache.set(d.game.id, d.game);
        notify();
        openGame(d.game.id, d.game.type);
      } else if (note) {
        note.textContent = "The rematch was refused.";
      } else toast("The rematch was refused.", true);
    } catch (e) {
      // cards and the Games tab have no note line: say it in a toast
      const msg = e instanceof Error && e.message ? e.message : "The rematch did not reach the referee.";
      if (note) note.textContent = "The rematch did not reach the referee.";
      else toast(msg, true);
    } finally {
      rematchInFlight.delete(g.id);
    }
  }

  // Lobby answers: accept takes your seat (the last accept starts the
  // match), decline calls the match off for everyone. The response is
  // the new state, so the card and the arena repaint from it directly.
  async function respond(id: number, accept: boolean, note: HTMLElement | null) {
    if (note) note.textContent = accept ? "Taking your seat…" : "Declining…";
    try {
      const d = accept ? await client.acceptGame(id) : await client.declineGame(id);
      if (d.game) {
        cache.set(id, d.game);
        notify();
        renderGameView(d.game, true);
      } else if (note) {
        note.textContent = "The referee refused that.";
      } else toast("The referee refused that.", true);
    } catch (e) {
      const msg = e instanceof Error && e.message ? e.message : "That did not reach the referee.";
      if (note) note.textContent = msg;
      else toast(msg, true);
      // the lobby may have expired or been decided meanwhile: show what is true now
      void fetchGame(id);
    }
  }

  // The lobby panel, shared by both arenas: who is in, who is still
  // owed an answer, and - for an invited player who has not answered -
  // the Accept / Decline buttons. The clock has not started; nothing
  // here is urgent except honesty about who is actually at the table.
  function lobbyPanel(g: GL, note: HTMLElement): HTMLElement {
    const wrap = el("div", "lobby-panel");
    const waiting = (g.players || []).filter((p: GLPlayer) => !p.accepted).map((p: GLPlayer) => p.name);
    const mine = !!(g.you && g.you.playing);
    let line: string;
    if (mine && !g.you!.accepted)
      line = "You've been invited to this match. Accept to take your seat - the clock starts when everyone is in.";
    else if (mine) line = "You're in. Waiting on " + waiting.join(", ") + ".";
    else line = "Lobby - waiting on " + waiting.join(", ") + " to accept.";
    if (g.lobby_deadline) {
      const left = g.lobby_deadline - Date.now();
      line += left > 0 ? " The lobby closes in " + formatLeft(left) + "." : " The lobby is closing.";
    }
    wrap.appendChild(el("div", "duel-statusline", line));
    if (mine && !g.you!.accepted) {
      const row = el("div", "duel-pad");
      const acc = el("button", "duel-btn", "Accept");
      acc.type = "button";
      acc.addEventListener("click", () => {
        void respond(g.id, true, note);
      });
      const dec = el("button", "duel-btn quiet", "Decline");
      dec.type = "button";
      dec.addEventListener("click", () => {
        void respond(g.id, false, note);
      });
      row.appendChild(acc);
      row.appendChild(dec);
      wrap.appendChild(row);
    }
    return wrap;
  }

  // One move per match at a time: a double tap, or a tap while the
  // answer is slow, sent a second copy that landed on the next turn once
  // the rival had answered (a second disc in the same column). A second
  // tap of the same move is dropped. A different move tapped meanwhile
  // is not a copy (a rider steering again, a second line in the Werewolf
  // square): it waits and goes next, with the turn it was tapped on, so
  // one that came too late for its turn is refused, not played on the
  // next.
  type Waiting = { dir: string; note: HTMLElement | null; label: string | undefined; turn: number | string | undefined };
  const moving = new Map<number, { last: string; queue: Waiting[] }>();
  // how long a move's answer may take (sendOne)
  const MOVE_DEADLINE_MS = 30000;
  // A stale-turn refusal's turn, per match, kept while room_state still
  // names the turn that was refused: the board repaints from the answer,
  // but room_state catches up only with the stream (a reconnect, a phone
  // waking), and until then every tap sent the refused turn again.
  const caughtUp = new Map<number, { refused: string; turn: number | string }>();
  function turnToSend(id: number): number | string | undefined {
    const named = opts.turnFor ? opts.turnFor(id) : undefined;
    const c = caughtUp.get(id);
    if (c && named !== undefined && String(named) === c.refused) return c.turn;
    caughtUp.delete(id);
    return named;
  }
  // how.repeat: a repeat is meant, not a double tap. A line of talk is
  // the case: the form has already cleared its draft, so a second "no"
  // dropped as a copy was lost for good.
  async function sendMove(id: number, dir: string, note: HTMLElement | null, label?: string, how?: { repeat?: boolean }) {
    const turn = turnToSend(id);
    const out = moving.get(id);
    if (out) {
      if (out.last !== dir || how?.repeat) {
        out.last = dir;
        out.queue.push({ dir, note, label, turn });
      }
      return;
    }
    const mine = { last: dir, queue: [] as Waiting[] };
    moving.set(id, mine);
    try {
      for (let w: Waiting | undefined = { dir, note, label, turn }; w; w = mine.queue.shift()) {
        // one send that throws (a repaint failing) must not strand the
        // moves queued behind it
        await sendOne(id, w).catch(() => toast("The move did not reach the referee.", true));
      }
    } finally {
      moving.delete(id);
    }
  }
  async function sendOne(id: number, w: Waiting) {
    const { dir, note, label } = w;
    if (note) {
      note.textContent = label || "Queuing " + dir + "…";
      // a note that said a refusal kept its red and role=alert: the next
      // "Queuing" showed red and a screen reader announced it as an alert
      note.classList.remove("move-refused");
      note.removeAttribute("role");
    }
    // Several views add their note to the page only when it has text,
    // and on the mover's own turn it has none: a refusal written there
    // reached nobody, while the scene had already played the move in.
    // In the open arena the refusal goes into the page just above the
    // control that was used: a toast sits at the bottom of the screen,
    // which on a phone is the control row the player needs next (Four
    // in a Row's drop buttons). Off the arena it is a toast.
    const say = (text: string) => {
      if (note && note.isConnected) {
        note.textContent = text;
        return;
      }
      const gv = gameView;
      if (!gv || gv.id !== id) {
        toast(text, true);
        return;
      }
      const n = note || el("div", "lc-note", "");
      n.textContent = text;
      n.classList.add("move-refused");
      n.setAttribute("role", "alert");
      const used = gv.tapped && gv.tapped.parentNode === gv.wrap ? gv.tapped : null;
      const scenes = gv.wrap.querySelectorAll(":scope > .lc-3d-host");
      // a tap on the scene: under it, still above the controls
      if (used && !used.classList.contains("lc-3d-host")) gv.wrap.insertBefore(n, used);
      else if (used || scenes.length) gv.wrap.insertBefore(n, (used || scenes[scenes.length - 1]!).nextSibling);
      else gv.wrap.appendChild(n);
      n.scrollIntoView({ block: "nearest" });
    };
    // A move whose answer never comes (a phone switching networks) held
    // the queue, and so every later move in the match, until a reload.
    // The deadline is long because a Sketch & Guess drawing is a large
    // body on a slow link.
    const ctl = new AbortController();
    const deadline = setTimeout(() => ctl.abort(), MOVE_DEADLINE_MS);
    try {
      const d = await client.submitMove(id, dir, w.turn, ctl.signal);
      if (d.game) {
        cache.set(id, d.game);
        notify();
        renderGameView(d.game, true);
      } else say("That move was refused.");
    } catch (e) {
      // the match moved past the turn this move was meant for: show it
      // as it is now, to decide again. The referee's sentence is written
      // for agents (it names an internal turn number, meaningless to a
      // person in most games), so people get a plain one.
      const stale = staleTurn(e);
      if (stale) {
        if (w.turn !== undefined) caughtUp.set(id, { refused: String(w.turn), turn: stale.turn });
        cache.set(id, stale.game);
        notify();
        renderGameView(stale.game, true);
        say("Too late: the match has moved on. This is how it stands now.");
        return;
      }
      if (ctl.signal.aborted) say("The move did not reach the referee: no answer in 30 seconds. Check the board, then try again.");
      else say(e instanceof Error && e.message ? e.message : "The move did not reach the referee.");
    } finally {
      clearTimeout(deadline);
    }
  }

  // The standard game history: every arena carries the same two
  // tabs - Game and History - and the History tab renders one row
  // grammar for every kind: an index chip (Turn/Round/Tick N), the
  // actors as color-dot chips, their action, and an outcome pill.
  // Each game's rows and count live in its folder (GAMES in
  // registry.ts; the row types in shared/history.ts).

  function histCount(g: GL): number {
    return (GAMES[g.type] || GAMES.lightcycles)!.historyCount(g);
  }


  function arenaTabs(g: GL): HTMLElement {
    const tabs = el("div", "arena-tabs");
    const cur = (gameView && gameView.tab) || "game";
    const defs: [string, string][] = [
      ["game", "Game"],
      ["history", "History · " + histCount(g)],
    ];
    defs.forEach(([id, label]) => {
      const b = el("button", "arena-tab" + (cur === id ? " on" : ""), label);
      b.type = "button";
      b.addEventListener("click", () => {
        if (!gameView || (gameView.tab || "game") === id) return;
        gameView.tab = id;
        const cg = cache.get(g.id);
        if (cg) renderGameView(cg, true);
      });
      tabs.appendChild(b);
    });
    return tabs;
  }

  function histWho(p: HistPlayer): HTMLElement {
    const s = el("span", "hist-who");
    const d = el("span", "hist-dot");
    d.style.background = (p && p.hex) || "#94a3b8";
    s.appendChild(d);
    s.appendChild(document.createTextNode((p && p.name) || "?"));
    return s;
  }

  function historyList(g: GL): HTMLElement {
    const list = el("div", "hist-list");
    const row = (idx: string): HTMLElement => {
      const r = el("div", "hist-row");
      r.appendChild(el("span", "hist-idx", idx));
      return r;
    };
    const n = (GAMES[g.type] || GAMES.lightcycles)!.history(g, row, histWho, list);
    if (!n) list.appendChild(el("div", "hist-empty", "No history yet - the record writes itself as the match plays."));
    return list;
  }

  // A compact signature of the per-viewer block. The arena render
  // keys include it: without it, a refetch that changes only the
  // viewer's own state (spectator -> player, your turn arriving)
  // would not repaint, and the arena could sit on "Spectating".
  function youSig(g: GL): string {
    const y = g.you;
    if (!y) return "-";
    return [y.playing ? 1 : 0, y.queued || "", y.alive === false ? 0 : 1, y.your_turn ? 1 : 0, y.phase || ""].join(",");
  }



  /* The games' 3D views, lazy-loaded like the Duel's: one host per open
     arena, kept across repaints; the scene shows the last round and plays
     new ones in, the inputs and the numbers stay in the page. A device
     without WebGL gets a note and plays with the controls under it. */
  const KIND3D: Record<string, Kind3d> = {
    frontlines: { cls: "fl-3d-host", load: () => import("./frontlines/FrontlinesArena3D"), comp: null },
    coderace: { cls: "cr-3d-host", load: () => import("./coderace/CodeRaceArena3D"), comp: null },
    fourinarow: { cls: "c4-3d-host", load: () => import("./fourinarow/FourArena3D"), comp: null },
    trust: { cls: "tr-3d-host", load: () => import("./trust/TrustArena3D"), comp: null },
    auction: { cls: "au-3d-host", load: () => import("./auction/AuctionArena3D"), comp: null },
    twotruths: { cls: "tt-3d-host", load: () => import("./twotruths/TwoTruthsArena3D"), comp: null },
    corpse: { cls: "ec-3d-host", load: () => import("./corpse/CorpseArena3D"), comp: null },
    twenty: { cls: "tq-3d-host", load: () => import("./twenty/TwentyArena3D"), comp: null },
    werewolf: { cls: "ww-3d-host", load: () => import("./werewolf/WerewolfArena3D"), comp: null },
    lettergrid: { cls: "lg-3d-host", load: () => import("./lettergrid/LetterArena3D"), comp: null },
    trivia: { cls: "tv-3d-host", load: () => import("./trivia/TriviaArena3D"), comp: null },
    sketch: { cls: "sg-3d-host", load: () => import("./sketch/SketchArena3D"), comp: null },
    liarsdice: { cls: "ld-3d-host", load: () => import("./liarsdice/LiarsArena3D"), comp: null },
  };
  function load3d(kind: string) {
    const k = KIND3D[kind]!;
    if (!k.comp)
      k.comp = k
        .load()
        .then((m) => m.default)
        .catch((e) => {
          k.comp = null;
          throw e;
        });
    return k.comp;
  }
  function drop3d() {
    const gv = gameView;
    if (gv && gv.r3d) {
      const m = gv.r3d;
      gv.r3d = null;
      gv.r3dCommit = null;
      m.root.unmount();
    }
  }
  // the open arena's host (made on first use), already in the page order
  function host3d(kind: string): Host3d {
    const gv = gameView!;
    if (!gv.r3d) gv.r3d = makeHost3d("lc-board-big lc-3d-host " + KIND3D[kind]!.cls);
    return gv.r3d;
  }
  function paint3d(kind: string, g: GL, h: Host3d, extra?: Partial<Omit<Arena3dProps, "g">>) {
    const gv = gameView;
    if (!gv || h.failed) return;
    const seq = (gv.r3dSeq = (gv.r3dSeq || 0) + 1);
    const current = () => !!gameView && gameView === gv && gv.r3dSeq === seq && gv.r3d === h;
    load3d(kind).then(
      (Comp) => {
        if (!current() || h.failed) return;
        h.root.render(
          // the kind was picked by this match's type: the scene takes it
          createElement(Comp as ComponentType<Arena3dProps>, {
            g,
            me: opts.meName(),
            aspect: h.host.clientWidth / Math.max(1, h.host.clientHeight),
            onReady: () => ready3d(h),
            registerCommit: (fn: (() => void) | null) => {
              if (gameView === gv) gv.r3dCommit = fn;
            },
            ...(extra || {}),
          })
        );
      },
      (err) => {
        if (current()) fail3d(h, err);
      }
    );
  }












  /* ---- The 3D arenas ----
     Every arena is 3D only: a react-three-fiber scene, with no 2D view
     and no 2D/3D toggle. Each scene module is
     a dynamic import, so three.js ships in lazy chunks that load only
     when an arena opens. The React root lives on the gameView object:
     renderGameView clears and rebuilds the wrap on every state change,
     and re-appending the same host element keeps the canvas (and the
     camera) alive across repaints. */
  /* The 3D host: a mount for the scene's React root plus a status
     layer over it - "Loading the 3D arena…" until the scene draws its
     first frame, or what went wrong with a Reload button. A failure
     says so and offers the reload that cures the usual cause: a deploy
     deleted the hashed chunk this page was built against. A WebGL
     failure reaches onUncaughtError (R3F rethrows it into the tree)
     instead of surfacing as an uncaught page error over a blank box. A
     failed host stops repainting until it is rebuilt. */
  function makeHost3d(cls: string): Host3d {
    const host = el("div", cls);
    const mount = el("div", "arena3d-mount");
    const status = el("div", "arena3d-status");
    status.setAttribute("role", "status");
    host.appendChild(mount);
    host.appendChild(status);
    const h: Host3d = { root: null as unknown as Root, host, status, failed: false };
    h.root = createRoot(mount, { onUncaughtError: (err) => fail3d(h, err) });
    status.textContent = "Loading the 3D arena…";
    // no WebGL at all: say so at once (no scene will ever draw, and a
    // reload will not help) - the game plays on with the controls below
    if (!webglOk()) {
      h.failed = true;
      host.classList.add("no-3d");
      status.textContent = "3D isn't available on this device - play with the controls below.";
    }
    return h;
  }
  let webglKnown: boolean | null = null;
  // WebGL 2 only: three.js dropped WebGL 1, so a browser that offers only
  // that passed a webgl-or-webgl2 probe, then the scene threw - and the
  // views, trusting the probe, left out the flat controls.
  function webglOk(): boolean {
    if (webglKnown != null) return webglKnown;
    try {
      const c = document.createElement("canvas");
      webglKnown = !!c.getContext("webgl2");
    } catch {
      webglKnown = false;
    }
    return webglKnown;
  }
  function ready3d(h: Host3d) {
    if (!h.failed) h.status.hidden = true;
  }
  /* Whether the open arena plays on its flat panels: no WebGL, or its
     scene failed (a WebGL error, a chunk that did not load, a scene that
     threw). The views ask this, not webglOk() alone: a host that failed
     on a device with WebGL said "play with the controls below" over a
     page that had none. */
  function flat(): boolean {
    if (!webglOk()) return true;
    const gv = gameView;
    return !!gv && [gv.r3d, gv.bs3d, gv.lc3d, gv.duel3d].some((h) => !!h && h.failed);
  }
  function fail3d(h: Host3d, err: unknown) {
    const first = !h.failed;
    h.failed = true;
    // the view was built for a working scene: build it again, once, with
    // the flat panels (after this call - it can come from inside React's
    // commit of the scene)
    const gv = gameView;
    if (first && gv && [gv.r3d, gv.bs3d, gv.lc3d, gv.duel3d].indexOf(h) >= 0)
      window.setTimeout(() => {
        const cg = gameView === gv ? cache.get(gv.id) : undefined;
        if (cg) renderGameView(cg, true);
      }, 0);
    const msg = String((err && (err as Error).message) || err || "");
    if (/webgl/i.test(msg)) {
      h.host.classList.add("no-3d");
      h.status.textContent = "3D isn't available on this device - play with the controls below.";
      h.status.hidden = false;
      return;
    }
    const text = /import|module|fetch|load/i.test(msg) ? "The 3D arena didn't load - the site was probably just updated." : "The 3D arena hit an error.";
    h.status.textContent = "";
    h.status.appendChild(el("div", "", text));
    const b = el("button", "btn sm", "Reload") as HTMLButtonElement;
    b.type = "button";
    b.addEventListener("click", () => location.reload());
    h.status.appendChild(b);
    h.status.hidden = false;
  }

  let lc3dComp: Promise<ComponentType<{ g: LightCyclesState; me?: string; aspect?: number; onReady?: () => void; onSteer?: (dir: string) => void }>> | null = null;
  function loadLc3d() {
    // A failed import is not remembered: the next paint tries again.
    if (!lc3dComp)
      lc3dComp = import("./lightcycles/LcArena3D")
        .then((m) => m.default)
        .catch((e) => {
          lc3dComp = null;
          throw e;
        });
    return lc3dComp;
  }
  function dropLc3d() {
    const gv = gameView;
    if (gv && gv.lc3d) {
      const m = gv.lc3d;
      gv.lc3d = null;
      m.root.unmount();
    }
  }
  function paintLc3d(g: LightCyclesState, h: Host3d) {
    const gv = gameView;
    if (!gv || h.failed) return;
    const seq = (gv.lc3dSeq = (gv.lc3dSeq || 0) + 1);
    // A newer paint, a closed viewer or a toggle-off supersedes us.
    const current = () => !!gameView && gameView === gv && gv.lc3dSeq === seq && gv.lc3d === h;
    loadLc3d().then(
      (Comp) => {
        if (!current() || h.failed) return;
        h.root.render(
          createElement(Comp, {
            g,
            me: opts.meName(),
            aspect: h.host.clientWidth / Math.max(1, h.host.clientHeight),
            onReady: () => ready3d(h),
            // tap a marker on the board to steer, as on the pad
            onSteer:
              g.you && g.you.playing && g.you.alive && g.status === "running"
                ? (dir: string) => {
                    void sendMove(g.id, dir, gv.wrap.querySelector(".lc-note") as HTMLElement | null);
                  }
                : undefined,
          })
        );
      },
      (err) => {
        if (current()) fail3d(h, err);
      }
    );
  }

  /* ---- Battleship 3D board (R3F) ----
     Same bridge pattern as the Light Cycles scene: ./BsArena3D is a
     dynamic import (three.js stays in the lazy chunk), and the React
     root lives on gameView so re-appending the host keeps the canvas
     alive across repaints. The component receives the per-viewer state
     plus a fire callback wired to sendMove. */
  let bs3dComp: Promise<
    ComponentType<{ g: BattleshipState; me: string; aspect?: number; onFire?: (label: string, target?: string) => void; onReady?: () => void; placing?: BsPlacing }>
  > | null = null;
  function loadBs3d() {
    // A failed import is not remembered: the next paint tries again.
    if (!bs3dComp)
      bs3dComp = import("./battleship/BsArena3D")
        .then((m) => m.default)
        .catch((e) => {
          bs3dComp = null;
          throw e;
        });
    return bs3dComp;
  }
  function dropBs3d() {
    const gv = gameView;
    if (gv && gv.bs3d) {
      const m = gv.bs3d;
      gv.bs3d = null;
      gv.bsFire = null;
      gv.bsPlace = null;
      m.root.unmount();
    }
  }
  function paintBs3d(g: BattleshipState, h: Host3d) {
    const gv = gameView;
    if (!gv || h.failed) return;
    const seq = (gv.bs3dSeq = (gv.bs3dSeq || 0) + 1);
    // A newer paint, a closed viewer or a toggle-off supersedes us.
    const current = () => !!gameView && gameView === gv && gv.bs3dSeq === seq && gv.bs3d === h;
    loadBs3d().then(
      (Comp) => {
        if (!current() || h.failed) return;
        h.root.render(
          createElement(Comp, {
            g,
            me: opts.meName(),
            aspect: h.host.clientWidth / Math.max(1, h.host.clientHeight),
            onFire: (label: string, target?: string) => {
              if (gameView && gameView.bsFire) gameView.bsFire(label, target);
            },
            placing: gv.bsPlace || undefined,
            onReady: () => ready3d(h),
          })
        );
      },
      (err) => {
        if (current()) fail3d(h, err);
      }
    );
  }
  // Battleship: remember the focused element inside the scene before the
  // wrap is emptied (bsScene hands focus back to it).
  function rememberBsFocus() {
    const act = document.activeElement;
    bsRefocus = gameView && gameView.bs3d && act instanceof HTMLElement && gameView.bs3d.host.contains(act) ? act : null;
  }
  /* The scene (two captains side by side, a free-for-all in rows),
     with what follows it right under it. */
  function bsScene(g: BattleshipState, wrap: HTMLElement, under?: HTMLElement) {
    if (!gameView) return;
    if (!gameView.bs3d) gameView.bs3d = makeHost3d("lc-board-big lc-3d-host bs-3d-host");
    wrap.appendChild(gameView.bs3d.host);
    if (bsRefocus && bsRefocus.isConnected) {
      try {
        bsRefocus.focus({ preventScroll: true });
      } catch {
        // focus is a nicety
      }
    }
    bsRefocus = null;
    if (under) wrap.appendChild(under);
    paintBs3d(g, gameView.bs3d);
  }

  /* ---- Duel 3D arena ----
     Same bridge as the other two: ./DuelArena3D is a dynamic import,
     and the React root lives on gameView so repaints keep the canvas.
     The scene shows the two sides; the throw pad, the verdict banner
     and the scoreboard stay in the page - the scene shows, the page
     acts. */
  let duel3dComp: Promise<
    ComponentType<{ g: DuelState; me?: string; aspect?: number; onReady?: () => void; registerCommit?: (fn: ((t: string) => void) | null) => void }>
  > | null = null;
  function loadDuel3d() {
    if (!duel3dComp)
      duel3dComp = import("./duel/DuelArena3D")
        .then((m) => m.default)
        .catch((e) => {
          duel3dComp = null;
          throw e;
        });
    return duel3dComp;
  }
  function dropDuel3d() {
    const gv = gameView;
    if (gv && gv.duel3d) {
      const m = gv.duel3d;
      gv.duel3d = null;
      gv.duelCommit = null;
      m.root.unmount();
    }
  }
  function paintDuel3d(g: DuelState, h: Host3d) {
    const gv = gameView;
    if (!gv || h.failed) return;
    const seq = (gv.duel3dSeq = (gv.duel3dSeq || 0) + 1);
    const current = () => !!gameView && gameView === gv && gv.duel3dSeq === seq && gv.duel3d === h;
    loadDuel3d().then(
      (Comp) => {
        if (!current() || h.failed) return;
        h.root.render(
          createElement(Comp, {
            g,
            me: opts.meName(),
            aspect: h.host.clientWidth / Math.max(1, h.host.clientHeight),
            onReady: () => ready3d(h),
            // the scene seals a tapped throw at once, before the request
            registerCommit: (fn: ((t: string) => void) | null) => {
              if (gameView === gv) gv.duelCommit = fn;
            },
          })
        );
      },
      (err) => {
        if (current()) fail3d(h, err);
      }
    );
  }

  function renderGameView(g: GL, force?: boolean) {
    if (!gameView || gameView.id !== g.id) return;
    // Each game's arena view, from the registry (registry.ts); a match
    // from before the type field is Light Cycles, the first game.
    (GAMES[g.type] || GAMES.lightcycles)!.view(ctx, g, force);
  }


  // One request per match at a time: a frame burst (Light Cycles ticks)
  // or the poll landing mid-fetch rides the request already out.
  const fetching = new Map<number, Promise<void>>();
  function fetchGame(id: number): Promise<void> {
    const cur = fetching.get(id);
    if (cur) return cur;
    const p = (async () => {
      try {
        const d = await client.game(id);
        if (!d.game) return;
        const prev = cache.get(id);
        cache.set(id, d.game);
        // listeners (cards, the Games tab's /games reload, the title
        // badge) only hear about real changes, not every poll
        if (!prev || prev.__frameOnly || JSON.stringify(prev) !== JSON.stringify(d.game)) notify();
        if (gameView && gameView.id === id) renderGameView(d.game);
      } catch {
        // a failed refresh keeps the last known state
      } finally {
        fetching.delete(id);
      }
    })();
    fetching.set(id, p);
    return p;
  }

  function openGame(id: number, type?: string) {
    dropLc3d();
    dropBs3d();
    dropDuel3d();
    drop3d();
    dropPanels();
    gameRenderKey = "";
    const kind = type || cache.get(id)?.type;
    opts.openViewer(
      matchTitle(kind || "lightcycles", id),
      (vb) => {
        const wrap = el("div", "lc-arena" + (kind ? " kind-" + kind : ""));
        wrap.appendChild(el("div", "lc-meta", "Loading the arena…"));
        vb.appendChild(wrap);
        const gv: GameView = { id, wrap };
        gameView = gv;
        // the arena's child that holds the control last used, so a
        // refused move is said next to it (sendMove); capture runs
        // before the control's own handler sends the move
        wrap.addEventListener(
          "click",
          (e) => {
            let t = e.target as Node | null;
            while (t && t.parentNode !== wrap) t = t.parentNode;
            gv.tapped = t instanceof HTMLElement ? t : null;
          },
          true
        );
        void fetchGame(id);
      },
      null,
      { onHelp: opts.showHelp ? () => opts.showHelp!(kind || cache.get(id)?.type || "lightcycles") : undefined }
    );
    if (gameViewTimer) clearInterval(gameViewTimer);
    gameViewTimer = window.setInterval(() => {
      if (gameView) void fetchGame(gameView.id);
    }, 8000);
  }

  // Round-clock bars drain on a 1s ticker, in cards and arena alike.
  window.setInterval(() => {
    document.querySelectorAll("[data-duel-deadline]").forEach((b) => setClockBar(b as HTMLElement));
    document.querySelectorAll("[data-turn-deadline]").forEach((b) => setTurnClock(b as HTMLElement));
  }, 1000);
  // Cards stay fresh on a slow poll. A finished or called-off match
  // never changes again, so only live ones (and entries known only from
  // a frame) are polled.
  window.setInterval(() => {
    if (document.hidden) return;
    cache.forEach((g, id) => {
      if (g.__frameOnly || g.status === "lobby" || g.status === "running") void fetchGame(id);
    });
  }, 20000);

  return {
    cache,
    subscribe(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    getVersion: () => version,
    fetch: fetchGame,
    onFrame(game: GL) {
      if (!game || !game.id) return;
      // A frame of any registered game; Light Cycles once it carries trails.
      if (game.trails || (game.type !== "lightcycles" && GAMES[game.type])) {
        // A frame carries the public summary, not the full state, so
        // it is merged over the cached entry: replacing it would wipe
        // the per-viewer fields (you, rounds, log) the cards and arenas
        // render from. The frame cannot update those, so for a match
        // you play in, and for one known only from this frame (its card
        // message may land after it), the full state is fetched right
        // away and "your move" and Accept/Decline are never stale.
        const prev = cache.get(game.id);
        cache.set(game.id, prev ? Object.assign({}, prev, game) : Object.assign({ __frameOnly: true }, game));
        notify();
        const me = (opts.meName() || "").toLowerCase();
        const playing = !!me && (game.players || []).some((p: GLPlayer) => String(p.name || "").toLowerCase() === me);
        // The frame that ends a match is fetched once in full, for
        // spectators too: its last round (the face-off, the log, the
        // h2h) is only in the full state, and the card poll skips
        // finished matches, so a spectator's card kept the round before
        // the finish until a reload.
        const ended = !!prev && prev.status !== game.status && (game.status === "finished" || game.status === "cancelled");
        if (!prev || prev.__frameOnly || playing || ended) {
          void fetchGame(game.id);
          return;
        }
      }
      if (gameView && gameView.id === game.id) void fetchGame(game.id);
    },
    openGame,
    respond: (id: number, accept: boolean) => respond(id, accept, null),
    rematch: (g: GL) => sendRematch(g, null),
    // Matches waiting on the signed-in member right now: a lobby seat
    // unaccepted, a duel throw unmade, a fleet unplaced, a shot
    // untaken, a tick unridden. Drives the title badge + chime.
    meName() {
      return opts.meName() || "";
    },
    awaitingCount() {
      const me = opts.meName();
      if (!me) return 0;
      let n = 0;
      cache.forEach((g) => {
        const mine = (g.players || []).find((p: GLPlayer) => p.name === me);
        if (!mine) return;
        if (g.status === "lobby") {
          if (!mine.accepted) n++;
          return;
        }
        if (g.status !== "running") return;
        const own = GAMES[g.type]?.awaiting;
        if (own) {
          if (own(g, mine, me)) n++;
        } else if (mine.alive && !mine.moved) n++;
      });
      return n;
    },
    viewerClosed() {
      dropLc3d();
      dropBs3d();
      dropDuel3d();
      drop3d();
      dropPanels();
      if (gameViewTimer) {
        clearInterval(gameViewTimer);
        gameViewTimer = 0;
      }
      gameView = null;
    },
  };
}
