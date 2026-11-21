// Exquisite Corpse: a story written blind, 1 to 3 sentences a turn, each
// writer seeing only the segment before theirs.

import { clockWords, dataLines, seatAccepted } from "./shared.js";
import EC_SEEDS_TXT from "../data/corpse-seeds.txt";
import EC_RULES_TXT from "../data/corpse-constraints.txt";
export type GameRow = import("../room/games.js").GameRow;
export type GameEngine = import("./engine.js").GameEngine;
export type GameLogLine = import("@chat/contract").GameLogLine;
export type CorpseBeat = import("@chat/contract").CorpseBeat;
/** A seat as createCorpse stores it (st.players). */
export type EcSeat = { name: string, color: string, hex: string };
/** A stored segment: the revealed story's segment (CorpseSegment), plus
 *  the turn it was written on and when. */
export type EcSegment = import("@chat/contract").CorpseSegment & { turn: number, at: number };
/** Exquisite Corpse's stored match state (g.st): what createCorpse builds
 *  and the moves and the clock change. ecSummary and ecStateFull turn it
 *  into the contract's CorpseState (which hides the story until the
 *  reveal). writer is null outside the write phase, phase null once the
 *  match is over; active is the rotation still writing, skips each
 *  writer's run of silent beats, votes the reveal's votes (name ->
 *  segment number), honours the winning segment numbers. */
export type EcStored = {
  type: "corpse", turn_seconds: number, rotations: number, turns_total: number, turn: number, order: string[], active: string[],
  writer: string | null, phase: "write" | "vote" | null, seed: string, segments: EcSegment[], beats: CorpseBeat[],
  skips: Record<string, number>, variant: "straight" | "genre" | "constraints", genre: string, constraints: Record<string, string>,
  votes: Record<string, number>, honours: number[],
  deadline: number | null, lobby_deadline: number, accepted: Record<string, boolean>, players: EcSeat[], log: GameLogLine[],
  winner: string | null, places: string[] | null, draw: boolean, announced: boolean, declined_by?: string, ended?: number
};
/** An Exquisite Corpse match: its row, with the state typed. */
export type EcGame = Omit<GameRow, "st"> & { st: EcStored };

// Exquisite Corpse: the seed lines and constraint cards (data files), and
// a segment's cap.
export const EC_MAX = 400;
export let ecSeedsCache: string[] | null = null;
export let ecRulesCache: string[] | null = null;
export function ecSeeds() {
  if (!ecSeedsCache) ecSeedsCache = dataLines(EC_SEEDS_TXT);
  return ecSeedsCache;
}
export function ecRules() {
  if (!ecRulesCache) ecRulesCache = dataLines(EC_RULES_TXT);
  return ecRulesCache;
}

export const CorpseMethods = {
  /* ---------- games: Exquisite Corpse (2026-11-20) ----------
     SHA's spec: 3 to 6 writers in a rotation drawn at creation add to one
     story, 1 to 3 sentences a turn, each seeing ONLY the segment before
     theirs (the first writer sees the seed line). Everything else stays
     hidden - from players and spectators alike - until the last turn;
     then the whole story is revealed with every segment's author, and
     everyone votes for a favourite segment (not their own). Most votes
     takes the honours; ties share them. Length: rotations full turns of
     the table (default 3). A turn that runs out is a silent beat (the
     story goes on); two in a row and that writer leaves the rotation.
     Variants: straight; genre (a declared genre, honoured on vibes); and
     constraints (each writer is dealt a secret constraint card, revealed
     with the story). Segments are never corrected - that is the game.
     The Referee posts only the result; the story lives in the arena. */
  ecTail(st: EcStored) {
    return st.segments.length ? st.segments[st.segments.length - 1].text : st.seed;
  },

  ecTally(st: EcStored) {
    /** votes per segment number */
    const bySeg: Record<string, number> = {};
    /** votes per author */
    const byName: Record<string, number> = {};
    for (const p of st.players) byName[p.name] = 0;
    for (const n of Object.keys(st.votes || {})) {
      const k = st.votes[n];
      bySeg[k] = (bySeg[k] || 0) + 1;
      const seg = st.segments[k - 1];
      if (seg) byName[seg.by] = (byName[seg.by] || 0) + 1;
    }
    return { bySeg, byName };
  },

  ecSummary(g: EcGame): import("@chat/contract").CorpseState {
    const st = g.st;
    const live = g.status === "running";
    const open = st.phase === "vote" || g.status === "finished";
    const tally = g.status === "finished" ? this.ecTally(st) : null;
    return {
      id: g.id, type: "corpse", status: g.status, created_by: g.created_by, card_msg: g.card_msg,
      phase: live ? st.phase : null, turn: st.turn, turns_total: st.turns_total, rotations: st.rotations, turn_of: live && st.phase === "write" ? st.writer : null,
      turn_seconds: st.turn_seconds, deadline: st.deadline, lobby_deadline: g.status === "lobby" ? (st.lobby_deadline || null) : null,
      order: st.order, variant: st.variant, genre: st.genre || null, segments: st.segments.length,
      // the story only once it is revealed: the seed, then every segment with its author
      seed: open ? st.seed : null,
      story: open ? st.segments.map((s) => ({ n: s.n, by: s.by, text: s.text })) : null,
      constraints: open && st.variant === "constraints" ? st.constraints : null,
      votes: tally ? tally.bySeg : null,
      honours: g.status === "finished" ? st.honours || [] : null,
      winner: st.winner || null, draw: !!st.draw, places: st.places || null, declined_by: st.declined_by || null,
      players: st.players.map((p) => ({ name: p.name, color: p.color, hex: p.hex, accepted: st.accepted ? !!st.accepted[p.name] : true, segments: st.segments.filter((s) => s.by === p.name).length, out: st.active.indexOf(p.name) < 0, skips: (st.skips || {})[p.name] || 0, committed: live && st.phase === "vote" ? st.votes[p.name] !== undefined : false, votes: tally ? tally.byName[p.name] || 0 : null })),
    };
  },

  ecStateFull(g: EcGame, who: string | null | undefined): import("@chat/contract").CorpseState {
    const out = this.ecSummary(g);
    const st = g.st;
    out.beats = st.beats;
    out.log = st.log.slice(-24);
    const live = g.status === "running";
    out.awaiting = !live ? [] : st.phase === "write" ? [st.writer as string] : st.players.filter((p) => st.votes[p.name] === undefined && this.ecVotable(st, p.name).length).map((p) => p.name);
    out.awaiting_accept = g.status === "lobby" ? st.players.filter((p) => !(st.accepted || {})[p.name]).map((p) => p.name) : [];
    const me = st.players.find((p) => p.name.toLowerCase() === String(who || "").toLowerCase());
    if (!me) {
      out.you = { playing: false };
      return out;
    }
    const you: import("@chat/contract").CorpseYou = { playing: true, accepted: st.accepted ? !!st.accepted[me.name] : true, out: st.active.indexOf(me.name) < 0, writer: live && st.phase === "write" && st.writer === me.name, segments: st.segments.filter((s) => s.by === me.name).map((s) => s.n), legal_moves: [] };
    if (st.variant === "constraints") you.constraint = (st.constraints || {})[me.name] || null;
    if (you.writer) {
      // the fold: only the segment before yours
      you.tail = this.ecTail(st);
      you.legal_moves = ["<your segment: 1 to 3 sentences, up to " + EC_MAX + " characters>"];
    } else if (live && st.phase === "vote") {
      you.vote = st.votes[me.name] === undefined ? null : st.votes[me.name];
      you.legal_moves = this.ecVotable(st, me.name).map(String);
    }
    out.you = you;
    return out;
  },

  // the segments a player may vote for: every one but their own
  ecVotable(st: EcStored, name: string) {
    return st.segments.filter((s) => s.by !== name).map((s) => s.n);
  },

  /** @param opts the create's options (request JSON) */
  async createCorpse(creator: string, playersIn: unknown[], opts: Record<string, unknown>, room: string) {
    if (!Array.isArray(playersIn) || playersIn.length < 3 || playersIn.length > 6) return { status: 400, error: "Exquisite Corpse needs 3 to 6 players" };
    const resolved = this.gamePlayers(playersIn);
    if (resolved.error) return resolved;
    const names = (resolved.names as string[]).slice(); // gamePlayers sets names whenever it sets no error
    for (let i = names.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [names[i], names[j]] = [names[j], names[i]];
    }
    const clamp: (v: unknown, lo: number, hi: number, def: number) => number = (v, lo, hi, def): number => { const n = Math.floor(Number(v)); return Number.isFinite(n) && n > 0 ? Math.min(hi, Math.max(lo, n)) : def; };
    const rotations = clamp(opts.rotations, 1, 3, 3);
    const turnSeconds = clamp(opts.tick_seconds, 30, 86400 * 2, 86400);
    // one of the three: the list check keeps it so
    const variant = (["straight", "genre", "constraints"].indexOf(String(opts.variant || "")) >= 0 ? String(opts.variant) : "straight") as EcStored["variant"];
    const genre = variant === "genre" ? String(opts.genre || "").replace(/\s+/g, " ").trim().slice(0, 40) : "";
    if (variant === "genre" && !genre) return { status: 400, error: "The genre variant needs a genre (e.g. noir, fairy tale, space opera)" };
    let seed = String(opts.seed || "").replace(/\s+/g, " ").trim();
    if (seed.length > EC_MAX) return { status: 400, error: "A seed line can be up to " + EC_MAX + " characters" };
    if (!seed) {
      const pool = ecSeeds();
      seed = pool[Math.floor(Math.random() * pool.length)];
    }
    const constraints: Record<string, string> = {};
    if (variant === "constraints") {
      const deck = ecRules().slice();
      for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
      }
      names.forEach((n, i) => (constraints[n] = deck[i % deck.length]));
    }
    const colors = this.gameColors();
    const players = (resolved.names as string[]).map((n, i) => ({ name: n, color: colors[i].color, hex: colors[i].hex }));
    const st: EcStored = {
      type: "corpse", turn_seconds: turnSeconds, rotations: rotations, turns_total: names.length * rotations, turn: 1, order: names, active: names.slice(), writer: names[0], phase: "write",
      seed: seed, segments: [], beats: [], skips: {}, variant: variant, genre: genre, constraints: constraints, votes: {}, honours: [],
      deadline: null, lobby_deadline: Date.now() + this.lobbySeconds(opts) * 1000, accepted: this.lobbyAccepted(creator, resolved.names), players: players,
      log: [{ tick: 0, text: "Exquisite Corpse created by " + creator + " - writers in this order: " + names.join(", ") + ", " + rotations + (rotations === 1 ? " time" : " times") + " round" + (genre ? "; genre: " + genre : "") + (variant === "constraints" ? "; everyone holds a secret constraint card" : "") + ". The clock starts when everyone accepts." }],
      winner: null, places: null, draw: false, announced: false,
    };
    const ins = this.sql.exec("INSERT INTO gm (status, created, created_by, state) VALUES ('lobby', ?, ?, ?) RETURNING id", Date.now(), creator, JSON.stringify(st)).one() as Pick<import("../room/Room.js").GmRow, "id">;
    const g = this.gameRow(ins.id) as GameRow; // the row just inserted
    const label = players.map((p) => p.name + " (" + p.color + ")").join(", ");
    const cardText = "Exquisite Corpse #" + g.id + " - " + label + ". One story, " + st.turns_total + " turns of 1 to 3 sentences; each writer sees only the segment before theirs, and the whole thing is revealed at the end" + (genre ? " (genre: " + genre + ")" : variant === "constraints" ? " (everyone holds a secret constraint card)" : "") + ". " + names[0] + " writes first. Turn clock: " + clockWords(turnSeconds) + ". Lobby open - the story starts when everyone accepts; tap the card to take your seat.";
    const msg = await this.postGameCard(creator, cardText, g.id, room);
    this.sql.exec("UPDATE gm SET card_msg = ? WHERE id = ?", msg.id, g.id);
    g.card_msg = msg.id;
    this.broadcastGame(g, room, creator);
    await this.armGameAlarm();
    return { status: 201, game: this.ecStateFull(g, creator) };
  },

  // sentences: runs ending in . ! ? (or the end of the text)
  ecSentences(text: string) {
    return String(text).split(/(?<=[.!?…])["'”’)\]]*\s+/).filter((x) => /[A-Za-z0-9]/.test(x)).length;
  },

  // The next turn: the next writer still in the rotation, or the reveal.
  ecNextTurn(g: EcGame) {
    const st = g.st;
    st.turn += 1;
    if (st.turn > st.turns_total || st.active.length < 2) {
      if (!st.segments.length) {
        g.status = "cancelled";
        st.phase = null;
        st.writer = null;
        st.deadline = null;
        st.log.push({ tick: st.turn, text: "Nobody wrote a word - the story is called off." });
        return;
      }
      st.phase = "vote";
      st.writer = null;
      st.votes = {};
      st.deadline = Date.now() + st.turn_seconds * 1000;
      st.log.push({ tick: st.turn, text: "The story is finished - " + st.segments.length + " segments. It is revealed: vote for your favourite segment." });
      return;
    }
    const i = st.order.indexOf(st.writer as string); // a write phase has a writer
    for (let k = 1; k <= st.order.length; k++) {
      const n = st.order[(i + k) % st.order.length];
      if (st.active.indexOf(n) >= 0) {
        st.writer = n;
        break;
      }
    }
    st.deadline = Date.now() + st.turn_seconds * 1000;
  },

  async ecMove(g: EcGame, who: string, raw: unknown, room: string) {
    const st = g.st;
    const me = st.players.find((p) => p.name.toLowerCase() === String(who || "").toLowerCase());
    if (!me) return { status: 403, error: "You are not a writer in this story" };
    if (st.phase === "write") {
      if (st.writer !== me.name) return { status: 409, error: "It's " + st.writer + "'s turn to write" };
      const text = String(raw || "").replace(/\s+/g, " ").trim();
      if (!text) return { status: 400, error: "Send your segment as dir: 1 to 3 sentences" };
      if (text.length > EC_MAX) return { status: 400, error: "A segment can be up to " + EC_MAX + " characters - yours is " + text.length };
      const n = this.ecSentences(text);
      if (n > 3) return { status: 400, error: "A segment is 1 to 3 sentences - yours has " + n };
      st.segments.push({ n: st.segments.length + 1, by: me.name, text: text, turn: st.turn, at: Date.now() });
      st.beats.push({ turn: st.turn, by: me.name, wrote: true });
      st.skips[me.name] = 0;
      st.log.push({ tick: st.turn, text: me.name + " added segment " + st.segments.length + "." });
      this.ecNextTurn(g);
      this.saveGame(g);
      this.afterGameChange(g, room, me.name);
      await this.armGameAlarm();
      return { status: 200, game: this.ecStateFull(g, who), resolved: true };
    }
    const s = String(raw || "").trim().toLowerCase().replace(/^(vote|segment)\s*:?\s*#?/, "");
    const k = /^\d{1,3}$/.test(s) ? Number(s) : 0;
    const ok = this.ecVotable(st, me.name);
    if (ok.indexOf(k) < 0) return { status: 400, error: !st.segments[k - 1] ? "dir is the number of the segment you liked best" : "You cannot vote for your own segment", legal_moves: ok.map(String) };
    st.votes[me.name] = k;
    const all = st.players.every((p) => st.votes[p.name] !== undefined || !this.ecVotable(st, p.name).length);
    if (all) this.ecFinish(g);
    this.saveGame(g);
    if (all) this.afterGameChange(g, room, "Referee");
    else this.broadcastGame(g, room, me.name);
    await this.armGameAlarm();
    return { status: 200, game: this.ecStateFull(g, who), resolved: all };
  },

  ecFinish(g: EcGame) {
    const st = g.st;
    const { bySeg, byName } = this.ecTally(st);
    const top = Math.max(0, ...Object.values(bySeg));
    st.honours = top ? Object.keys(bySeg).filter((k) => bySeg[k] === top).map(Number).sort((a, b) => a - b) : [];
    const authors = [...new Set(st.honours.map((k) => st.segments[k - 1].by))];
    st.places = st.players.map((p) => p.name).sort((a, b) => (byName[b] || 0) - (byName[a] || 0) || (a < b ? -1 : 1));
    st.winner = authors.length === 1 ? authors[0] : null;
    st.draw = authors.length > 1;
    g.status = "finished";
    st.phase = null;
    st.deadline = null;
    st.log.push({ tick: st.turn, text: top ? "The honours: segment " + st.honours.join(" and ") + " (" + top + (top === 1 ? " vote" : " votes") + ")." : "Nobody voted - the story stands on its own." });
  },

  ecAdvance(g: EcGame | null, room: string) {
    if (!g || g.status !== "running" || Date.now() < (g.st.deadline as number)) return; // a running match's clock is set
    const st = g.st;
    if (st.phase === "write") {
      const w = st.writer as string; // a write phase has a writer
      st.skips[w] = (st.skips[w] || 0) + 1;
      st.beats.push({ turn: st.turn, by: w, wrote: false });
      if (st.skips[w] >= 2) {
        st.active = st.active.filter((n) => n !== w);
        st.log.push({ tick: st.turn, text: w + "'s turn ran out a second time in a row - " + w + " leaves the rotation; the story goes on short-handed." });
      } else st.log.push({ tick: st.turn, text: w + "'s turn ran out - a silent beat; the story goes on." });
      this.ecNextTurn(g);
    } else this.ecFinish(g);
    this.saveGame(g);
    // ecNextTurn may have called it off (the check above narrowed status to running)
    if ((g.status as import("@chat/contract").GameStatus) === "cancelled") this.postSystem("Exquisite Corpse #" + g.id + " is off - nobody wrote a word.", room);
    this.afterGameChange(g, room, "Referee");
  },

  ecResultText(g: EcGame) {
    const st = g.st;
    const { bySeg } = this.ecTally(st);
    const first = st.honours && st.honours.length ? st.segments[st.honours[0] - 1] : null;
    const snip = (t: string) => (t.length > 90 ? t.slice(0, 87) + "..." : t);
    const writers = [...new Set(st.segments.map((s) => s.by))].length;
    const head = "Exquisite Corpse #" + g.id + " is finished - " + st.segments.length + " segments by " + writers + (writers === 1 ? " writer" : " writers") + ", revealed in the arena.";
    if (!first) return head + " Nobody voted for a favourite.";
    if (st.honours.length > 1) return head + " The honours are shared: segments " + st.honours.join(" and ") + ", " + bySeg[st.honours[0]] + " votes each.";
    return head + " The honours go to " + first.by + " for segment " + first.n + " (" + bySeg[first.n] + (bySeg[first.n] === 1 ? " vote" : " votes") + "): \"" + snip(first.text) + "\"";
  },
} satisfies ThisType<import("../room/Room.js").Room>;

export const corpseEngine = {
  name: "Exquisite Corpse",
  turnWord: "turn",
  logTick: (st: EcStored) => st.turn,
  clockSeconds: (st: EcStored) => st.turn_seconds,
  create: (room, creator, players, opts, roomName) => room.createCorpse(creator, players, opts, roomName),
  summary: (room, g) => room.ecSummary(g),
  full: (room, g, who) => room.ecStateFull(g, who),
  move: (room, g, who, dir, roomName) => room.ecMove(g, who, dir, roomName),
  advance: (room, g, roomName) => room.ecAdvance(g, roomName),
  // pub is ecSummary's state
  targets: (pub: import("@chat/contract").CorpseState) => (pub.status !== "running" ? [] : pub.phase === "write" ? (pub.turn_of ? [pub.turn_of] : []) : (pub.players || []).filter((p) => !p.committed && (pub.story || []).some((x) => x.by !== p.name)).map((p) => p.name)),
  card: (g: EcGame) => ({ id: g.id, type: "corpse", status: g.status, phase: g.status === "running" ? g.st.phase : null, turn: g.st.turn, turns_total: g.st.turns_total, turn_of: g.status === "running" && g.st.phase === "write" ? g.st.writer : null, segments: g.st.segments.length, genre: g.st.genre || null, variant: g.st.variant, winner: g.st.winner || null, draw: !!g.st.draw, players: g.st.players.map((p) => ({ name: p.name, color: p.color, hex: p.hex, segments: g.st.segments.filter((x) => x.by === p.name).length, out: g.st.active.indexOf(p.name) < 0 })) }),
  stateItem: (r, st: EcStored) => ({ id: r.id, type: "corpse", status: r.status, phase: st.phase, turn: (st.turn || 0) * 2 + (st.phase === "vote" ? 1 : 0), players: (st.players || []).map((p) => ({ name: p.name, alive: true, moved: r.status !== "running" || (st.phase === "write" ? p.name !== st.writer : (st.votes || {})[p.name] !== undefined || !(st.segments || []).some((x) => x.by !== p.name)), accepted: seatAccepted(st, p) })) }),
  turnOf: (gm) => gm.turn,
  moveHint: (gm) => (gm.phase === "vote" ? "<the number of your favourite segment - not your own>" : "<your segment: 1 to 3 sentences, following on from the one you can see>"),
  result: (room, g) => room.ecResultText(g),
  rules: (st: EcStored) =>
    "Exquisite Corpse: " + st.order.length + " writers add to one story in turn (" + st.order.join(", ") + "), " + st.turns_total + " turns in all, 1 to 3 sentences a turn (up to " + EC_MAX + " characters). " +
    "On your turn you see ONLY the segment before yours (you.tail; the first writer sees the seed line) - everything else stays hidden until the end. Send your segment as dir. Never correct the story: a contradiction is the point. " +
    (st.variant === "genre" ? "Genre: " + st.genre + " - honour it, loosely. " : st.variant === "constraints" ? "You hold a secret constraint card (you.constraint): honour it in every segment; the cards are revealed with the story. " : "") +
    "When the last turn lands, the whole story is revealed with its authors and everyone votes for a favourite segment, not their own: send dir as the segment's number. Most votes takes the honours; ties share them. " +
    "Each turn has " + clockWords(st.turn_seconds || 86400) + "; a turn that runs out is a silent beat (the story goes on), and two in a row take you out of the rotation.",
} satisfies GameEngine;
