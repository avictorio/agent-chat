// Code Race: crack the code (Mastermind with words), simultaneous rounds.

import CR_WORDS_TXT from "../data/coderace-words.txt";
import { clockWords, seatAccepted } from "./shared.js";
export type GameRow = import("../room/games.js").GameRow;
export type GameEngine = import("./engine.js").GameEngine;
export type CodeRaceFeedback = import("@chat/contract").CodeRaceFeedback;
/** A racer's seat. */
export type CrSeat = { name: string, color: string, hex: string };
/** A racer's progress: the round they cracked it in and when, out (three
 *  missed rounds in a row), missed rounds in a row, guesses sent, marks
 *  across them and their closest guess (crScore). */
export type CrProg = { solved: number | null, solved_at: number | null, out: boolean, missed: number, guesses: number, marks: number, best: number };
/** A resolved round as stored: each guess keeps its word as g (crStateFull
 *  renames it guess, for whoever may see it). */
export type CrRound = Omit<import("@chat/contract").CodeRaceRound, "guesses"> & { guesses: Record<string, { g: string, fb: CodeRaceFeedback, at: number }> };
/** Code Race's stored match state (g.st; the API's CodeRaceState is built
 *  from it), but for mode and colors (CrSt). secret is the word, or the
 *  code's key letters ("RGBY"). pending holds each racer's guess for the
 *  round and pending_at when it came in (roundsCommit in room/games.ts). */
export type CrStBase = {
  type: "coderace",
  length: number,
  max_rounds: number,
  round_seconds: number,
  round: number,
  secret: string,
  deadline: number | null,
  lobby_deadline: number,
  accepted: Record<string, boolean>,
  players: CrSeat[],
  prog: Record<string, CrProg>,
  rounds: CrRound[],
  pending: Record<string, string>,
  pending_at: Record<string, number>,
  places: string[] | null,
  log: import("@chat/contract").GameLogLine[],
  winner: string | null,
  announced: boolean,
  declined_by?: string,
  ended?: number,
};
/** Code Race's stored match state: colors (how many colours a code is
 *  drawn from) is set in colors mode only. */
export type CrSt = CrStBase & ({ mode: "words", colors: null } | { mode: "colors", colors: number });
/** A Code Race match: its gm row with the state typed. */
export type CrGame = Omit<GameRow, "st"> & { st: CrSt };

// Code Race: the colours a code is drawn from (the first `colors` of
// them), and a sample word per length for hints.
export const CR_PALETTE = [
  { k: "R", name: "red", hex: "#ef4444" }, { k: "G", name: "green", hex: "#22c55e" }, { k: "B", name: "blue", hex: "#3b82f6" },
  { k: "Y", name: "yellow", hex: "#facc15" }, { k: "O", name: "orange", hex: "#f97316" }, { k: "P", name: "purple", hex: "#a855f7" },
  { k: "C", name: "cyan", hex: "#22d3ee" }, { k: "W", name: "white", hex: "#f1f5f9" },
];
export const CR_EXAMPLE: Record<number, string> = { 4: "lamp", 5: "crane", 6: "planet" };

// The word lists (content as data, worker/data/coderace-words.txt), parsed
// on first use: answersN are the secrets, guessesN every word a guess
// may be.
export type CrWordList = { answers: string[], guesses: Set<string> };
export let crWordsCache: Record<number, CrWordList> | null = null;
export function crWords() {
  if (crWordsCache) return crWordsCache;
  const out: Record<number, CrWordList> = {};
  for (const line of String(CR_WORDS_TXT).split("\n")) {
    const m = line.match(/^(answers|guesses)(\d+) (.*)$/);
    if (!m) continue;
    const L = Number(m[2]);
    if (!out[L]) out[L] = { answers: [], guesses: new Set() };
    if (m[1] === "answers") out[L].answers = m[3].trim().split(/\s+/);
    else out[L].guesses = new Set(m[3].trim().split(/\s+/));
  }
  for (const L in out) for (const w of out[L].answers) out[L].guesses.add(w);
  crWordsCache = out;
  return out;
}

export const CodeRaceMethods = {
  // A Code Race's secret, set by the API suite so a race can be solved
  // on purpose (TEST_HOOKS only, like the other setTest* hooks).
  setTestCrSecret(id: number, secret: unknown) {
    if (!this.env || !this.env.TEST_HOOKS) return { error: "Not found" };
    const g = this.gameRow(id);
    if (!g || !g.st || g.st.type !== "coderace") return { error: "No Code Race with that id" };
    g.st.secret = g.st.mode === "words" ? String(secret || "").toLowerCase() : String(secret || "").toUpperCase().replace(/[^A-Z]/g, "");
    this.saveGame(g);
    return { ok: true };
  },

  /* ---------- games: Code Race (2026-11-19) ----------
     Everyone cracks the same secret at once. Colors mode: a code of
     `length` pegs from `colors` colours (repeats allowed); a guess
     scores black pegs (right colour, right place) and white pegs (right
     colour, wrong place). Words mode: a secret word; each letter of a
     guess scores G (right place), Y (in the word, elsewhere) or . (not
     in it), with the classic rule for repeated letters; guesses must be
     words from the list (worker/data/coderace-words.txt). One guess per
     round per racer, secret until the round resolves - and a RIVAL's
     guess stays hidden for the whole match: views show only its
     feedback, so nobody races on someone else's clues (the owner's
     call, 2026-11-19). The end reveals every guess and the secret.
     Rounds ride the simultaneous-rounds machinery and wait only on
     racers still racing. Three missed rounds in a row drop a racer.
     The race ends when nobody is left racing, when only one racer is
     left and someone has already cracked it (their place is settled),
     or at the round cap. Places: solvers first, by the round they
     cracked it, then most marks across their guesses (pegs, or greens),
     then the earliest solving guess; then the rest by their closest
     guess, dropped racers last. Nobody cracking it means no winner. */
  crActive(st: CrSt) {
    return st.players.filter((p) => { const pr = st.prog[p.name]; return !pr.solved && !pr.out; });
  },

  /**
   * A move's guess (the word, or the code's key letters), or the error to
   * answer with.
   * @param raw the guess, as sent
   */
  crParse(st: CrSt, raw: unknown): string | { error: string } {
    const s = String(raw || "").trim().toLowerCase().replace(/^(guess|try)\s*:?\s*/, "");
    if (st.mode === "words") {
      const w = s.replace(/[^a-z]/g, "");
      if (w.length !== st.length) return { error: "a guess is one " + st.length + "-letter word (\"" + (s || "nothing") + "\" has " + w.length + " letters)" };
      const words = crWords()[st.length];
      if (!words || !words.guesses.has(w)) return { error: "\"" + w + "\" is not in the word list - try another " + st.length + "-letter word" };
      return w;
    }
    const pal = CR_PALETTE.slice(0, st.colors);
    if (s === "random") return Array.from({ length: st.length }, () => pal[Math.floor(Math.random() * pal.length)].k).join("");
    const byName: Record<string, string> = {};
    pal.forEach((c) => { byName[c.name] = c.k; byName[c.k.toLowerCase()] = c.k; });
    let toks = s.split(/[^a-z]+/).filter(Boolean);
    // "rgby" in one piece reads as initials
    if (toks.length === 1 && toks[0].length === st.length && !byName[toks[0]]) toks = toks[0].split("");
    const keys = toks.map((t) => byName[t]);
    const bad = toks.filter((t, i) => !keys[i]);
    if (bad.length) return { error: "\"" + bad[0] + "\" is not a colour in this race - use " + pal.map((c) => c.k + " (" + c.name + ")").join(", ") };
    if (keys.length !== st.length) return { error: "a guess is " + st.length + " colours in order, e.g. " + pal.slice(0, st.length).map((c) => c.k).join(" ") + " (you sent " + keys.length + ")" };
    return keys.join("");
  },

  // Colors: [black, white]. Words: "GY..G".
  crFeedback(st: CrSt, guess: string): CodeRaceFeedback {
    const sec = st.secret;
    if (st.mode === "words") {
      const out = Array(sec.length).fill(".");
      const left: Record<string, number> = {};
      for (let i = 0; i < sec.length; i++) {
        if (guess[i] === sec[i]) out[i] = "G";
        else left[sec[i]] = (left[sec[i]] || 0) + 1;
      }
      for (let i = 0; i < sec.length; i++) {
        if (out[i] !== "G" && left[guess[i]] > 0) { out[i] = "Y"; left[guess[i]]--; }
      }
      return out.join("");
    }
    let black = 0;
    const cs: Record<string, number> = {}, cg: Record<string, number> = {};
    for (let i = 0; i < sec.length; i++) {
      if (guess[i] === sec[i]) black++;
      cs[sec[i]] = (cs[sec[i]] || 0) + 1;
      cg[guess[i]] = (cg[guess[i]] || 0) + 1;
    }
    let both = 0;
    for (const k in cg) both += Math.min(cg[k], cs[k] || 0);
    return [black, both - black];
  },

  crCracked(st: CrSt, fb: CodeRaceFeedback) {
    return st.mode === "words" ? fb === "G".repeat(st.length) : fb[0] === st.length;
  },
  // a guess's closeness (for the unsolved order) and its marks (for the
  // solvers' tie-break): pegs, or greens then yellows
  // (fb is the marks string in words mode, the [black, white] pair in colors)
  crScore(st: CrSt, fb: CodeRaceFeedback) {
    if (st.mode === "words") { const gr = (fb as string).split("G").length - 1; const ye = (fb as string).split("Y").length - 1; return { close: gr * 10 + ye, marks: gr }; }
    return { close: (fb as [number, number])[0] * 10 + (fb as [number, number])[1], marks: (fb as [number, number])[0] + (fb as [number, number])[1] };
  },

  crShow(st: CrSt, guess: string) {
    return st.mode === "words" ? String(guess).toUpperCase() : String(guess).split("").join(" ");
  },

  crPlaces(st: CrSt) {
    const rows = st.players.map((p) => ({ name: p.name, pr: st.prog[p.name] }));
    rows.sort((a, b) => {
      const sa = a.pr.solved, sb = b.pr.solved;
      if (sa && sb) return sa - sb || (b.pr.marks || 0) - (a.pr.marks || 0) || (a.pr.solved_at || 0) - (b.pr.solved_at || 0);
      if (sa) return -1;
      if (sb) return 1;
      if (!!a.pr.out !== !!b.pr.out) return a.pr.out ? 1 : -1;
      return (b.pr.best || 0) - (a.pr.best || 0) || (b.pr.marks || 0) - (a.pr.marks || 0) || (a.name < b.name ? -1 : 1);
    });
    return rows.map((r) => r.name);
  },

  // The places are settled when the race ends; the winner is the first
  // place only if they cracked it.
  crStanding(st: CrSt) {
    st.places = this.crPlaces(st);
    const top = st.places[0];
    return top && st.prog[top].solved ? top : null;
  },

  crSummary(g: CrGame): import("@chat/contract").CodeRaceState {
    const st = g.st;
    const over = g.status !== "running" && g.status !== "lobby";
    const out: import("@chat/contract").CodeRaceState = {
      id: g.id, type: "coderace", status: g.status, created_by: g.created_by, card_msg: g.card_msg,
      round: st.round, max_rounds: st.max_rounds, round_seconds: st.round_seconds, deadline: st.deadline, lobby_deadline: g.status === "lobby" ? (st.lobby_deadline || null) : null,
      mode: st.mode, length: st.length, colors: st.mode === "colors" ? st.colors : null,
      palette: st.mode === "colors" ? CR_PALETTE.slice(0, st.colors).map((c) => ({ k: c.k, name: c.name, hex: c.hex })) : null,
      winner: st.winner || null, declined_by: st.declined_by || null, places: st.places || null,
      secret: over && st.secret ? (st.mode === "words" ? st.secret : st.secret.split("")) : null,
      players: st.players.map((p) => {
        const pr = st.prog[p.name] || {};
        return { name: p.name, color: p.color, hex: p.hex, accepted: st.accepted ? !!st.accepted[p.name] : true, committed: st.pending[p.name] !== undefined, solved: pr.solved || null, out: !!pr.out, guesses: pr.guesses || 0, best: pr.best || 0 };
      }),
    };
    return out;
  },

  // Rounds as this viewer may see them: your own guesses in full, a
  // rival's only as feedback while the race runs; everything once over.
  /** @param who the viewer */
  crStateFull(g: CrGame, who: string | null | undefined): import("@chat/contract").CodeRaceState {
    const out = this.crSummary(g);
    const st = g.st;
    const me = st.players.find((p) => p.name.toLowerCase() === String(who || "").toLowerCase());
    const open = g.status !== "running" && g.status !== "lobby";
    out.rounds = st.rounds.map((r) => {
      const gs: Record<string, import("@chat/contract").CodeRaceGuess> = {};
      for (const name in r.guesses) {
        const x = r.guesses[name];
        gs[name] = open || (me && me.name === name) ? { guess: x.g, fb: x.fb, at: x.at } : { fb: x.fb };
      }
      return { n: r.n, at: r.at, guesses: gs, solved: r.solved, missed: r.missed, dropped: r.dropped };
    });
    out.log = st.log.slice(-24);
    const active = g.status === "running" ? this.crActive(st) : [];
    out.awaiting = active.filter((p) => st.pending[p.name] === undefined).map((p) => p.name);
    out.awaiting_accept = g.status === "lobby" ? st.players.filter((p) => !(st.accepted || {})[p.name]).map((p) => p.name) : [];
    if (me) {
      const pr = st.prog[me.name];
      const racing = g.status === "running" && !pr.solved && !pr.out;
      out.you = {
        playing: true, accepted: st.accepted ? !!st.accepted[me.name] : true, queued: st.pending[me.name] || null, solved: pr.solved || null, out: !!pr.out,
        legal_moves: racing ? (st.mode === "words" ? ["one " + st.length + "-letter word from the word list, e.g. " + CR_EXAMPLE[st.length]] : [st.length + " colours in order from " + CR_PALETTE.slice(0, st.colors).map((c) => c.k).join(" ") + ", e.g. " + CR_PALETTE.slice(0, st.length).map((c) => c.k).join(" "), "random"]) : [],
      };
    } else out.you = { playing: false };
    return out;
  },

  /** @param opts the create's options (mode, length, colors, max_rounds, tick_seconds, lobby_seconds) */
  async createCodeRace(creator: string, playersIn: unknown[], opts: Record<string, any>, room: string) {
    if (!Array.isArray(playersIn) || playersIn.length < 2 || playersIn.length > 6) return { status: 400, error: "Code Race needs 2 to 6 players" };
    const modeIn = String(opts.mode || "colors").toLowerCase();
    if (modeIn !== "colors" && modeIn !== "words") return { status: 400, error: "mode must be colors or words" };
    const resolved = this.gamePlayers(playersIn);
    if (resolved.error) return resolved;
    const names = resolved.names as string[]; // gamePlayers sets names whenever it sets no error
    const words = modeIn === "words";
    const clamp = (v: unknown, lo: number, hi: number, def: number) => { const n = Math.floor(Number(v)); return Number.isFinite(n) && n > 0 ? Math.min(hi, Math.max(lo, n)) : def; };
    const length = words ? clamp(opts.length, 4, 6, 5) : clamp(opts.length, 3, 6, 4);
    const ncolors = words ? null : clamp(opts.colors, 4, CR_PALETTE.length, 6);
    const maxRounds = words ? clamp(opts.max_rounds, 4, 12, 6) : clamp(opts.max_rounds, 4, 16, 10);
    const roundSeconds = clamp(opts.tick_seconds, 30, 86400, 3600);
    let secret;
    if (words) {
      const list = crWords()[length].answers;
      secret = list[Math.floor(Math.random() * list.length)];
    } else secret = Array.from({ length: length }, () => CR_PALETTE[Math.floor(Math.random() * (ncolors as number))].k).join(""); // colors mode: ncolors is set
    const colors = this.gameColors();
    const players = names.map((n, i) => ({ name: n, color: colors[i].color, hex: colors[i].hex }));
    const prog: Record<string, CrProg> = {};
    for (const n of names) prog[n] = { solved: null, solved_at: null, out: false, missed: 0, guesses: 0, marks: 0, best: 0 };
    const what = words ? "the same secret " + length + "-letter word" : "the same secret code: " + length + " pegs from " + ncolors + " colours";
    // a CrSt: ncolors is null exactly in words mode
    const st: CrStBase & { mode: CrSt["mode"], colors: number | null } = {
      type: "coderace", mode: words ? "words" : "colors", length: length, colors: ncolors, max_rounds: maxRounds, round_seconds: roundSeconds, round: 1, secret: secret,
      deadline: null, lobby_deadline: Date.now() + this.lobbySeconds(opts) * 1000, accepted: this.lobbyAccepted(creator, names), players: players, prog: prog,
      rounds: [], pending: {}, pending_at: {}, places: null,
      log: [{ tick: 0, text: "Code Race created by " + creator + " - " + names.join(", ") + " race to crack " + what + ", up to " + maxRounds + " rounds. The clock starts when everyone accepts." }],
      winner: null, announced: false,
    };
    const ins = this.sql.exec("INSERT INTO gm (status, created, created_by, state) VALUES ('lobby', ?, ?, ?) RETURNING id", Date.now(), creator, JSON.stringify(st)).one();
    const g = this.gameRow(ins.id) as GameRow; // the row just inserted
    const label = players.map((p) => p.name + " (" + p.color + ")").join(", ");
    const clock = roundSeconds >= 3600 ? Math.round(roundSeconds / 3600) + " h" : Math.max(1, Math.round(roundSeconds / 60)) + " min";
    const cardText = "Code Race match #" + g.id + " - " + label + ". Everyone cracks " + what + ", one guess a round, up to " + maxRounds + " rounds. Round clock: " + clock + ". Lobby open - the race starts when everyone accepts; tap the card to take your seat.";
    const msg = await this.postGameCard(creator, cardText, g.id, room);
    this.sql.exec("UPDATE gm SET card_msg = ? WHERE id = ?", msg.id, g.id);
    g.card_msg = msg.id;
    this.broadcastGame(g, room, creator);
    await this.armGameAlarm();
    return { status: 201, game: this.crStateFull(g, creator) };
  },

  /** @param raw the guess, as sent */
  async crMove(g: CrGame, who: string, raw: unknown, room: string) {
    const st = g.st;
    const me = st.players.find((p) => p.name.toLowerCase() === String(who || "").toLowerCase());
    if (!me) return { status: 403, error: "You are not a player in this match" };
    const pr = st.prog[me.name];
    if (pr.solved) return { status: 400, error: "You cracked it in round " + pr.solved + " - the race goes on without you now" };
    if (pr.out) return { status: 400, error: "You are out of this race (three missed rounds in a row)" };
    const guess = this.crParse(st, raw) as (string & { error?: undefined }) | { error: string }; // the code, or { error } (a string has no error)
    if (guess.error) return { status: 400, error: guess.error, legal_moves: st.mode === "words" ? [CR_EXAMPLE[st.length]] : [CR_PALETTE.slice(0, st.length).map((c) => c.k).join(" "), "random"] };
    const resolved = this.roundsCommit(g, who, guess, room);
    await this.armGameAlarm();
    return { status: 200, game: this.crStateFull(g, who), resolved: resolved };
  },

  crResolveRound(g: CrGame) {
    const st = g.st;
    const n = st.round;
    const at = Date.now();
    const entry: CrRound = { n: n, at: at, guesses: {}, solved: [], missed: [], dropped: [] };
    for (const p of this.crActive(st)) {
      const pr = st.prog[p.name];
      const guess = st.pending[p.name];
      if (guess === undefined) {
        pr.missed = (pr.missed || 0) + 1;
        entry.missed.push(p.name);
        if (pr.missed >= 3) { pr.out = true; entry.dropped.push(p.name); }
        continue;
      }
      pr.missed = 0;
      const fb = this.crFeedback(st, guess);
      const ga = (st.pending_at || {})[p.name] || at;
      entry.guesses[p.name] = { g: guess, fb: fb, at: ga };
      const sc = this.crScore(st, fb);
      pr.guesses = (pr.guesses || 0) + 1;
      pr.marks = (pr.marks || 0) + sc.marks;
      pr.best = Math.max(pr.best || 0, sc.close);
      if (this.crCracked(st, fb)) { pr.solved = n; pr.solved_at = ga; entry.solved.push(p.name); }
    }
    st.rounds.push(entry);
    const bits = [];
    if (entry.solved.length) bits.push(entry.solved.join(" and ") + (entry.solved.length > 1 ? " crack" : " cracks") + " it");
    const others = Object.keys(entry.guesses).filter((x) => entry.solved.indexOf(x) < 0);
    if (others.length) bits.push(others.length + (others.length > 1 ? " guesses miss" : " guess misses"));
    if (entry.missed.length) bits.push(entry.missed.join(", ") + " sent no guess" + (entry.dropped.length ? " (" + entry.dropped.join(", ") + " out after three missed rounds)" : ""));
    st.log.push({ tick: n, text: "Round " + n + ": " + (bits.join("; ") || "no guesses") + "." });
    st.pending = {};
    st.pending_at = {};
    const left = this.crActive(st);
    const anySolved = st.players.some((p) => st.prog[p.name].solved);
    if (!left.length || (left.length === 1 && anySolved) || n >= st.max_rounds) {
      g.status = "finished";
      st.winner = this.crStanding(st);
      st.log.push({ tick: n, text: st.winner ? st.winner + " wins the race." : "Nobody cracked it - the " + (st.mode === "words" ? "word" : "code") + " holds." });
    } else {
      st.round += 1;
      st.deadline = at + st.round_seconds * 1000;
    }
  },

  crResultText(g: CrGame) {
    const st = g.st;
    if (!st.places) st.places = this.crPlaces(st);
    const what = st.mode === "words" ? "word" : "code";
    const placeLine = st.places.map((name, i) => {
      const pr = st.prog[name];
      const how = pr.solved ? "round " + pr.solved : pr.out ? "dropped out" : "not cracked";
      return (i + 1) + ". " + name + " (" + how + ")";
    }).join(", ");
    const head = st.winner ? st.winner + " cracked the " + what + " first, in round " + st.prog[st.winner].solved + "." : "nobody cracked the " + what + " in " + st.rounds.length + (st.rounds.length === 1 ? " round." : " rounds.");
    return "Code Race match #" + g.id + " is over - " + head + " Places: " + placeLine + ". The " + what + " was " + this.crShow(st, st.secret) + ".";
  },
} satisfies ThisType<import("../room/Room.js").Room>;

export const coderaceEngine = {
  name: "Code Race",
  turnWord: "round",
  logTick: (st: CrSt) => st.round,
  clockSeconds: (st: CrSt) => st.round_seconds,
  create: (room, creator, players, opts, roomName) => room.createCodeRace(creator, players, opts, roomName),
  summary: (room, g) => room.crSummary(g),
  full: (room, g, who) => room.crStateFull(g, who),
  move: (room, g, who, dir, roomName) => room.crMove(g, who, dir, roomName),
  advance: (room, g, roomName) => room.roundsAdvance(g, roomName),
  // the simultaneous-rounds hooks: a round waits only on racers still racing
  resolveRound: (room, g) => room.crResolveRound(g),
  standing: (room, st: CrSt) => room.crStanding(st),
  active: (room, st: CrSt) => room.crActive(st),
  targets: (pub: import("@chat/contract").CodeRaceState) => pub.players.filter((p) => !p.committed && !p.solved && !p.out).map((p) => p.name),
  card: (g: CrGame) => ({ id: g.id, type: "coderace", status: g.status, round: g.st.round, max_rounds: g.st.max_rounds, mode: g.st.mode, length: g.st.length, colors: g.st.colors, winner: g.st.winner || null, players: g.st.players.map((p) => { const pr = (g.st.prog || {})[p.name] || {}; return { name: p.name, color: p.color, hex: p.hex, solved: pr.solved || null, out: !!pr.out, guesses: pr.guesses || 0 }; }) }),
  stateItem: (r, st: CrSt) => ({ id: r.id, type: "coderace", status: r.status, round: st.round, mode: st.mode, length: st.length, colors: st.colors, players: (st.players || []).map((p) => { const pr = (st.prog || {})[p.name] || {}; return { name: p.name, alive: !pr.out, moved: (st.pending || {})[p.name] !== undefined || !!pr.solved || !!pr.out, accepted: seatAccepted(st, p) }; }) }),
  turnOf: (gm) => gm.round,
  moveHint: (gm) => (gm.mode === "words" ? "<a " + (gm.length || 5) + "-letter word, e.g. " + CR_EXAMPLE[gm.length || 5] + ">" : "<" + (gm.length || 4) + " colours from " + CR_PALETTE.slice(0, gm.colors || 6).map((c) => c.k).join(" ") + ", e.g. " + CR_PALETTE.slice(0, gm.length || 4).map((c) => c.k).join(" ") + ">"),
  result: (room, g) => room.crResultText(g),
  rules: (st: CrSt) =>
    (st.mode === "words"
      ? "Code Race (Words): every racer cracks the same secret " + st.length + "-letter word. A guess must be a word from the list; each letter scores G (right letter, right place), Y (in the word, elsewhere) or . (not in it), and a repeated letter counts only as often as the word holds it. "
      : "Code Race (Colors): every racer cracks the same secret code of " + st.length + " pegs from " + st.colors + " colours (" + CR_PALETTE.slice(0, st.colors).map((c) => c.k + " " + c.name).join(", ") + "), repeats allowed. Each guess scores black pegs (right colour, right place) and white pegs (right colour, wrong place): fb is [black, white]. ") +
    "One secret guess per round each; you see rivals' feedback, never their guesses, until the race ends. Crack it in the fewest rounds (up to " + st.max_rounds + "). A round resolves when everyone still racing has guessed, or at the " + clockWords(st.round_seconds || 3600) + " deadline; three missed rounds in a row drop you. " +
    (st.mode === "words" ? "Send dir as one word, e.g. " + CR_EXAMPLE[st.length] + "." : "Send dir as the colours in order, e.g. " + CR_PALETTE.slice(0, st.length).map((c) => c.k).join(" ") + " (or random)."),
} satisfies GameEngine;
