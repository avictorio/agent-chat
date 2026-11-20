// Letter Grid: everyone hunts words in the same grid each round.

import LG_WORDS_TXT from "../data/lettergrid-words.txt";
import { clockWords, seatAccepted } from "./shared.js";

// Letter Grid (2026-11-20): the dictionary (content as data,
// worker/data/lettergrid-words.txt - sorted, one word a line), parsed on
// first use. lgHasPrefix is a binary search on the sorted list, so a grid
// can be searched without building a trie.
export let lgDictCache = null;
export function lgDict() {
  if (lgDictCache) return lgDictCache;
  const list = [];
  for (const line of String(LG_WORDS_TXT).split("\n")) {
    const w = line.trim();
    if (w && w[0] !== "#") list.push(w);
  }
  lgDictCache = { list: list, set: new Set(list) };
  return lgDictCache;
}
export function lgHasPrefix(p) {
  const L = lgDict().list;
  let lo = 0, hi = L.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (L[mid] < p) lo = mid + 1;
    else hi = mid;
  }
  return lo < L.length && L[lo].startsWith(p);
}
// Tile weights for drawing a grid: Scrabble-like counts, no Q (it would
// need a QU tile), the rare letters kept rare.
export const LG_WEIGHTS = "e12 a9 i9 o8 n6 r6 t6 l4 s4 u4 d4 g3 b2 c2 m2 p2 f2 h2 v2 w2 y2 k1 j1 x1 z1";
export const LG_VOWELS = "aeiou";
// A cell's label: column letter, then row number - A1 is the top left.
export const lgLabel = (r, c) => String.fromCharCode(65 + c) + (r + 1);

export const LetterGridMethods = {
  // Letter Grid in tests: lay a known grid (rows of letters, the match's
  // size), so words and paths are deterministic.
  setTestLetterGrid(id, rows) {
    if (!this.env || !this.env.TEST_HOOKS) return { error: "Not found" };
    const g = this.gameRow(id);
    if (!g || !g.st || g.st.type !== "lettergrid") return { error: "No Letter Grid match with that id" };
    const n = g.st.size;
    if (!Array.isArray(rows) || rows.length !== n || rows.some((r) => !new RegExp("^[a-z]{" + n + "}$").test(String(r).toLowerCase()))) return { error: "rows must be " + n + " strings of " + n + " letters" };
    g.st.grid = rows.map((r) => String(r).toLowerCase());
    const words = this.lgSolve(g.st.grid, g.st.min_len);
    g.st.word_count = words.size;
    g.st.top_words = this.lgTop(words);
    this.saveGame(g);
    return { ok: true, word_count: words.size };
  },

  /* ---------- games: Letter Grid (2026-11-20) ----------
     Henry's letter-grid brawl. One public grid per match (size x size, 4
     to 6; at least one vowel in every row and column; the richest of a
     few draws by how many dictionary words it holds). Each round every
     player sends one word traced through touching cells (diagonals count,
     each cell once per word), at least min_len letters, from the
     dictionary (worker/data/lettergrid-words.txt). Words are checked when
     sent - a bad one is refused and can be sent again (the spec's
     re-submit prompt) - and stay sealed until the round resolves. A word
     scores 1 a letter, plus 1 for each cell it claims: a cell nobody has
     claimed goes to the first player whose word uses it. The same word
     from two players in one round scores letters only and claims nothing.
     Deviations, where the spec is silent: a cell two different words both
     take first in the same round stays free; your own words cannot
     repeat; a word sent without a path takes the path that claims the
     most free cells. Fixed rounds (default 8); highest total wins, then
     most cells claimed, then the longest word, then the earlier
     final-round word. A missed round scores nothing; three in a row take
     a player out (their score stands). Rides the simultaneous-rounds
     machinery, waiting only on players still in. */
  lgActive(st) {
    return st.players.filter((p) => !st.prog[p.name].out);
  },

  lgDraw(size) {
    const bag = [];
    for (const t of LG_WEIGHTS.split(" ")) for (let i = 0; i < Number(t.slice(1)); i++) bag.push(t[0]);
    const vowels = bag.filter((ch) => LG_VOWELS.indexOf(ch) >= 0);
    const pick = (pool) => pool[Math.floor(Math.random() * pool.length)];
    const isV = (ch) => LG_VOWELS.indexOf(ch) >= 0;
    const g = Array.from({ length: size }, () => Array.from({ length: size }, () => pick(bag)));
    for (let r = 0; r < size; r++) if (!g[r].some(isV)) g[r][Math.floor(Math.random() * size)] = pick(vowels);
    // a column with no vowel is all consonants, so any of its cells can
    // turn vowel without costing a row its own
    for (let c = 0; c < size; c++) if (!g.some((row) => isV(row[c]))) g[Math.floor(Math.random() * size)][c] = pick(vowels);
    return g.map((row) => row.join(""));
  },

  // Every dictionary word the grid holds (min_len letters and up).
  lgSolve(grid, minLen) {
    const n = grid.length;
    const D = lgDict().set;
    const found = new Set();
    const seen = new Array(n * n).fill(false);
    const walk = (r, c, pre) => {
      const w = pre + grid[r][c];
      if (!lgHasPrefix(w)) return;
      if (w.length >= minLen && D.has(w)) found.add(w);
      if (w.length >= 16) return;
      seen[r * n + c] = true;
      for (let dr = -1; dr <= 1; dr++)
        for (let dc = -1; dc <= 1; dc++) {
          const rr = r + dr, cc = c + dc;
          if ((dr || dc) && rr >= 0 && cc >= 0 && rr < n && cc < n && !seen[rr * n + cc]) walk(rr, cc, w);
        }
      seen[r * n + c] = false;
    };
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) walk(r, c, "");
    return found;
  },

  // The longest words on a grid, for the end of the match.
  lgTop(words) {
    return Array.from(words).sort((a, b) => b.length - a.length || (a < b ? -1 : 1)).slice(0, 8);
  },

  // Every way to trace `word` on the grid (up to cap), as [row, col] lists.
  lgPaths(grid, word, cap) {
    const n = grid.length;
    const out = [];
    const path = [];
    const seen = new Array(n * n).fill(false);
    const walk = (r, c, i) => {
      if (out.length >= cap || grid[r][c] !== word[i]) return;
      seen[r * n + c] = true;
      path.push([r, c]);
      if (i === word.length - 1) out.push(path.slice());
      else
        for (let dr = -1; dr <= 1; dr++)
          for (let dc = -1; dc <= 1; dc++) {
            const rr = r + dr, cc = c + dc;
            if ((dr || dc) && rr >= 0 && cc >= 0 && rr < n && cc < n && !seen[rr * n + cc]) walk(rr, cc, i + 1);
          }
      seen[r * n + c] = false;
      path.pop();
    };
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) walk(r, c, 0);
    return out;
  },

  // A path as sent: [[row, col], ...] from 0, ["B3", ...] labels, or a
  // string of labels ("B3 C4", "B3-C4").
  lgParsePath(st, raw) {
    const n = st.size;
    const items = typeof raw === "string" ? raw.trim().split(/[\s,;>\-]+/).filter(Boolean) : raw;
    if (!Array.isArray(items) || !items.length) return { error: "path is a list of cells, e.g. [\"A1\", \"B2\", \"C2\"] or [[0, 0], [1, 1], [1, 2]]" };
    const out = [];
    for (const it of items) {
      let r, c;
      if (Array.isArray(it) && it.length === 2) {
        r = Number(it[0]);
        c = Number(it[1]);
      } else {
        const m = String(it).trim().toUpperCase().match(/^([A-Z])(\d{1,2})$/);
        if (!m) return { error: "\"" + String(it).slice(0, 20) + "\" is not a cell - a cell is a column letter and a row number, A1 to " + lgLabel(n - 1, n - 1) };
        c = m[1].charCodeAt(0) - 65;
        r = Number(m[2]) - 1;
      }
      if (!Number.isInteger(r) || !Number.isInteger(c) || r < 0 || c < 0 || r >= n || c >= n) return { error: "a cell off the grid: " + JSON.stringify(it).slice(0, 20) + " (the grid runs A1 to " + lgLabel(n - 1, n - 1) + ")" };
      out.push([r, c]);
    }
    return out;
  },

  lgParse(st, me, raw, fields) {
    let word = fields && typeof fields.word === "string" ? fields.word : null;
    let pathIn = fields && fields.path !== undefined ? fields.path : null;
    if (word === null) {
      const s = String(raw === undefined || raw === null ? "" : raw).trim();
      if (s[0] === "{") {
        let o;
        try { o = JSON.parse(s); } catch (e) { return { error: "dir looks like JSON but does not parse - send {\"word\": \"stone\"} or just the word" }; }
        word = String((o && o.word) || "");
        if (o && o.path !== undefined) pathIn = o.path;
      } else {
        // "stone", or "stone B2 C2 C3 D4 E4" / "stone: B2-C2-..."
        const m = s.match(/^([A-Za-z]+)\s*:?\s*(.*)$/);
        if (!m) return { error: "send one word (letters only), optionally followed by its cells, e.g. stone B2 C2 C3 D4 E4" };
        word = m[1];
        if (m[2].trim()) pathIn = m[2];
      }
    }
    word = String(word).trim().toLowerCase();
    if (!/^[a-z]+$/.test(word)) return { error: "a word is letters only" };
    if (word.length < st.min_len) return { error: "words need at least " + st.min_len + " letters" };
    if (word.length > st.size * st.size) return { error: "that is longer than the grid has cells" };
    if (!lgDict().set.has(word)) return { error: "\"" + word.toUpperCase() + "\" is not in the dictionary - try another" };
    if ((st.prog[me.name].words || []).indexOf(word) >= 0) return { error: "you have played " + word.toUpperCase() + " already - your own words cannot repeat" };
    const n = st.size;
    let path;
    if (pathIn !== null) {
      path = this.lgParsePath(st, pathIn);
      if (path.error) return path;
      if (path.length !== word.length) return { error: "the path has " + path.length + " cells but " + word.toUpperCase() + " has " + word.length + " letters" };
      const used = new Set();
      for (let i = 0; i < path.length; i++) {
        const [r, c] = path[i];
        if (used.has(r * n + c)) return { error: lgLabel(r, c) + " is used twice - each cell once per word" };
        used.add(r * n + c);
        if (st.grid[r][c] !== word[i]) return { error: lgLabel(r, c) + " is " + st.grid[r][c].toUpperCase() + ", not " + word[i].toUpperCase() + " (letter " + (i + 1) + " of " + word.toUpperCase() + ")" };
        if (i && (Math.abs(r - path[i - 1][0]) > 1 || Math.abs(c - path[i - 1][1]) > 1)) return { error: lgLabel(path[i - 1][0], path[i - 1][1]) + " and " + lgLabel(r, c) + " do not touch - each cell must touch the one before (diagonals count)" };
      }
    } else {
      const paths = this.lgPaths(st.grid, word, 64);
      if (!paths.length) return { error: "\"" + word.toUpperCase() + "\" can't be traced on the grid - its letters must touch in order (diagonals count), each cell once" };
      // the path that claims the most free cells, as the claims stand now
      const free = (p) => p.filter(([r, c]) => !st.claims[r * n + c]).length;
      path = paths.reduce((a, b) => (free(b) > free(a) ? b : a));
    }
    return { word: word, path: path };
  },

  lgSummary(g) {
    const st = g.st;
    const over = g.status !== "running" && g.status !== "lobby";
    return {
      id: g.id, type: "lettergrid", status: g.status, created_by: g.created_by, card_msg: g.card_msg,
      round: st.round, rounds_total: st.rounds_total, round_seconds: st.round_seconds, deadline: st.deadline, lobby_deadline: g.status === "lobby" ? (st.lobby_deadline || null) : null,
      size: st.size, min_len: st.min_len, grid: st.grid, claims: st.claims, word_count: st.word_count, top_words: over ? st.top_words : null,
      winner: st.winner || null, draw: !!st.draw, places: st.places || null, declined_by: st.declined_by || null,
      players: st.players.map((p) => {
        const pr = st.prog[p.name] || {};
        return { name: p.name, color: p.color, hex: p.hex, accepted: st.accepted ? !!st.accepted[p.name] : true, committed: st.pending[p.name] !== undefined, score: pr.score || 0, cells: pr.cells || 0, longest: pr.longest || null, out: !!pr.out };
      }),
    };
  },

  lgStateFull(g, who) {
    const out = this.lgSummary(g);
    const st = g.st;
    out.rounds = st.rounds;
    out.log = st.log.slice(-24);
    const active = g.status === "running" ? this.lgActive(st) : [];
    out.awaiting = active.filter((p) => st.pending[p.name] === undefined).map((p) => p.name);
    out.awaiting_accept = g.status === "lobby" ? st.players.filter((p) => !(st.accepted || {})[p.name]).map((p) => p.name) : [];
    const me = st.players.find((p) => p.name.toLowerCase() === String(who || "").toLowerCase());
    if (me) {
      const pr = st.prog[me.name];
      // the words are free-form, so legal_moves stays empty: how_to_play
      // and the move hint carry the format
      out.you = { playing: true, accepted: st.accepted ? !!st.accepted[me.name] : true, queued: st.pending[me.name] || null, out: !!pr.out, played: (pr.words || []).slice(), legal_moves: [] };
    } else out.you = { playing: false };
    return out;
  },

  async createLetterGrid(creator, playersIn, opts, room) {
    if (!Array.isArray(playersIn) || playersIn.length < 2 || playersIn.length > 6) return { status: 400, error: "Letter Grid needs 2 to 6 players" };
    const resolved = this.gamePlayers(playersIn);
    if (resolved.error) return resolved;
    const names = resolved.names;
    const clamp = (v, lo, hi, def) => { const n = Math.floor(Number(v)); return Number.isFinite(n) && n > 0 ? Math.min(hi, Math.max(lo, n)) : def; };
    const size = clamp(opts.size, 4, 6, 5);
    const rounds = clamp(opts.rounds, 3, 20, 8);
    const minLen = clamp(opts.min_length !== undefined ? opts.min_length : opts.min_len, 3, 5, 3);
    const roundSeconds = clamp(opts.tick_seconds, 30, 86400, 3600);
    // the richest of a few draws
    let best = null;
    for (let i = 0; i < 6; i++) {
      const grid = this.lgDraw(size);
      const words = this.lgSolve(grid, minLen);
      if (!best || words.size > best.words.size) best = { grid: grid, words: words };
      if (words.size >= size * size * 6) break;
    }
    const colors = this.gameColors();
    const players = names.map((n, i) => ({ name: n, color: colors[i].color, hex: colors[i].hex }));
    const prog = {};
    for (const n of names) prog[n] = { score: 0, cells: 0, longest: null, words: [], missed: 0, out: false };
    const st = {
      type: "lettergrid", size: size, min_len: minLen, rounds_total: rounds, round_seconds: roundSeconds, round: 1,
      deadline: null, lobby_deadline: Date.now() + this.lobbySeconds(opts) * 1000, accepted: this.lobbyAccepted(creator, names), players: players, prog: prog,
      grid: best.grid, claims: new Array(size * size).fill(null), word_count: best.words.size, top_words: this.lgTop(best.words),
      rounds: [], pending: {}, pending_at: {}, places: null,
      log: [{ tick: 0, text: "Letter Grid created by " + creator + " - " + names.join(", ") + ", a " + size + "x" + size + " grid, " + rounds + " rounds. The clock starts when everyone accepts." }],
      winner: null, draw: false, announced: false,
    };
    const ins = this.sql.exec("INSERT INTO gm (status, created, created_by, state) VALUES ('lobby', ?, ?, ?) RETURNING id", Date.now(), creator, JSON.stringify(st)).one();
    const g = this.gameRow(ins.id);
    const label = players.map((p) => p.name + " (" + p.color + ")").join(", ");
    const cardText = "Letter Grid match #" + g.id + " - " + label + ". One " + size + "x" + size + " grid of letters for everyone; each round, trace one secret word through touching cells (diagonals count). 1 point a letter, plus 1 for every cell you claim first. " + rounds + " rounds; round clock: " + clockWords(roundSeconds) + ". Lobby open - the match starts when everyone accepts; tap the card to take your seat.";
    const msg = await this.postGameCard(creator, cardText, g.id, room);
    this.sql.exec("UPDATE gm SET card_msg = ? WHERE id = ?", msg.id, g.id);
    g.card_msg = msg.id;
    this.broadcastGame(g, room, creator);
    await this.armGameAlarm();
    return { status: 201, game: this.lgStateFull(g, creator) };
  },

  async lgMove(g, who, raw, room, fields) {
    const st = g.st;
    const me = st.players.find((p) => p.name.toLowerCase() === String(who || "").toLowerCase());
    if (!me) return { status: 403, error: "You are not a player in this match" };
    if (st.prog[me.name].out) return { status: 400, error: "You are out of this match (three missed rounds in a row)" };
    const mv = this.lgParse(st, me, raw, fields);
    if (mv.error) return { status: 400, error: mv.error };
    const resolved = this.roundsCommit(g, who, mv, room);
    await this.armGameAlarm();
    return { status: 200, game: this.lgStateFull(g, who), resolved: resolved };
  },

  lgResolveRound(g) {
    const st = g.st;
    const n = st.round;
    const at = Date.now();
    const N = st.size;
    const active = this.lgActive(st);
    const entry = { n: n, at: at, words: {}, missed: [], dropped: [], points: {}, totals: {} };
    const count = {};
    for (const p of active) { const mv = st.pending[p.name]; if (mv) count[mv.word] = (count[mv.word] || 0) + 1; }
    // the free cells each (unduplicated) word would claim this round
    const wants = {};
    for (const p of active) {
      const mv = st.pending[p.name];
      if (!mv || count[mv.word] > 1) continue;
      for (const [r, c] of mv.path) { const k = r * N + c; if (!st.claims[k]) (wants[k] = wants[k] || []).push(p.name); }
    }
    for (const p of active) {
      const pr = st.prog[p.name];
      const mv = st.pending[p.name];
      entry.points[p.name] = 0;
      if (mv === undefined) {
        pr.missed = (pr.missed || 0) + 1;
        entry.missed.push(p.name);
        if (pr.missed >= 3) { pr.out = true; entry.dropped.push(p.name); }
        continue;
      }
      pr.missed = 0;
      const dup = count[mv.word] > 1;
      const keys = mv.path.map(([r, c]) => r * N + c);
      const claimed = dup ? [] : keys.filter((k) => wants[k] && wants[k].length === 1);
      const contested = dup ? [] : keys.filter((k) => wants[k] && wants[k].length > 1);
      const w = { word: mv.word, path: mv.path, letters: mv.word.length, bonus: claimed.length, claimed: claimed, contested: contested, dup: dup, at: (st.pending_at || {})[p.name] || at };
      entry.words[p.name] = w;
      entry.points[p.name] = w.letters + w.bonus;
      pr.score += w.letters + w.bonus;
      pr.cells += w.bonus;
      pr.words.push(mv.word);
      if (!pr.longest || mv.word.length > pr.longest.length) pr.longest = mv.word;
    }
    // claims land once every word is scored
    for (const name of Object.keys(entry.words)) for (const k of entry.words[name].claimed) st.claims[k] = name;
    st.players.forEach((p) => (entry.totals[p.name] = st.prog[p.name].score));
    st.rounds.push(entry);
    const bits = Object.keys(entry.words).map((name) => {
      const w = entry.words[name];
      return name + " " + w.word.toUpperCase() + " +" + (w.letters + w.bonus) + (w.dup ? " (a shared word, no claims)" : w.bonus ? " (" + w.bonus + (w.bonus === 1 ? " cell)" : " cells)") : "");
    });
    st.log.push({ tick: n, text: "Round " + n + ": " + (bits.join("; ") || "no words") + "." + (entry.missed.length ? " " + entry.missed.join(", ") + " sent no word." : "") + (entry.dropped.length ? " " + entry.dropped.join(", ") + " out after three missed rounds." : "") });
    st.pending = {};
    st.pending_at = {};
    if (n >= st.rounds_total || this.lgActive(st).length < Math.min(2, st.players.length)) {
      g.status = "finished";
      st.winner = this.lgStanding(st);
      st.log.push({ tick: n, text: (n >= st.rounds_total ? "That was the last round. " : "Too few players left. ") + (st.winner ? st.winner + " wins." : "A tie at the top - no winner.") });
    } else {
      st.round += 1;
      st.deadline = at + st.round_seconds * 1000;
    }
  },

  // Places by score, then cells claimed, then the longest word, then the
  // earlier final-round word (none counts as latest); the winner only
  // when every tiebreak separates the top two.
  lgStanding(st) {
    const last = st.rounds.length ? st.rounds[st.rounds.length - 1] : null;
    const fin = (nm) => (last && last.words[nm] ? last.words[nm].at : Infinity);
    const P = (nm) => st.prog[nm];
    const cmp = (a, b) => P(b).score - P(a).score || P(b).cells - P(a).cells || (P(b).longest || "").length - (P(a).longest || "").length || (fin(a) === fin(b) ? 0 : fin(a) < fin(b) ? -1 : 1);
    st.places = st.players.map((p) => p.name).sort((a, b) => cmp(a, b) || (a < b ? -1 : 1));
    const tied = st.places.length > 1 && cmp(st.places[0], st.places[1]) === 0;
    st.draw = tied;
    return tied ? null : st.places[0];
  },

  lgResultText(g) {
    const st = g.st;
    if (!st.places) this.lgStanding(st);
    const scores = st.places.map((nm) => nm + " " + st.prog[nm].score + " (" + st.prog[nm].cells + (st.prog[nm].cells === 1 ? " cell)" : " cells)")).join(", ");
    let longest = null;
    for (const nm of st.places) { const w = st.prog[nm].longest; if (w && (!longest || w.length > longest.w.length)) longest = { w: w, nm: nm }; }
    const R = st.rounds.length;
    return "Letter Grid match #" + g.id + " is over after " + R + (R === 1 ? " round" : " rounds") + " - " + (st.winner ? st.winner + " wins with " + st.prog[st.winner].score + " points." : "a tie at the top, no winner.") + " Scores: " + scores + "." + (longest ? " Longest word: " + longest.w.toUpperCase() + " (" + longest.nm + ")." : "") + (st.top_words && st.top_words.length ? " The grid's longest words: " + st.top_words.slice(0, 3).map((w) => w.toUpperCase()).join(", ") + "." : "");
  },
};

export const lettergridEngine = {
  name: "Letter Grid",
  turnWord: "round",
  logTick: (st) => st.round,
  clockSeconds: (st) => st.round_seconds,
  create: (room, creator, players, opts, roomName) => room.createLetterGrid(creator, players, opts, roomName),
  summary: (room, g) => room.lgSummary(g),
  full: (room, g, who) => room.lgStateFull(g, who),
  move: (room, g, who, dir, roomName, fields) => room.lgMove(g, who, dir, roomName, fields),
  advance: (room, g, roomName) => room.roundsAdvance(g, roomName),
  resolveRound: (room, g) => room.lgResolveRound(g),
  standing: (room, st) => room.lgStanding(st),
  active: (room, st) => room.lgActive(st),
  targets: (pub) => pub.players.filter((p) => !p.committed && !p.out).map((p) => p.name),
  card: (g) => ({ id: g.id, type: "lettergrid", status: g.status, round: g.st.round, rounds_total: g.st.rounds_total, size: g.st.size, grid: g.st.grid, claims: g.st.claims, winner: g.st.winner || null, draw: !!g.st.draw, players: g.st.players.map((p) => { const pr = (g.st.prog || {})[p.name] || {}; return { name: p.name, color: p.color, hex: p.hex, score: pr.score || 0, cells: pr.cells || 0, out: !!pr.out }; }) }),
  stateItem: (r, st) => ({ id: r.id, type: "lettergrid", status: r.status, round: st.round, min_len: st.min_len, players: (st.players || []).map((p) => { const pr = (st.prog || {})[p.name] || {}; return { name: p.name, alive: !pr.out, moved: (st.pending || {})[p.name] !== undefined || !!pr.out, accepted: seatAccepted(st, p) }; }) }),
  turnOf: (gm) => gm.round,
  moveHint: (gm) => "<a word of " + (gm.min_len || 3) + "+ letters traced through touching cells (diagonals count) - the word alone, or with its cells, e.g. stone B2 C2 C3 D4 E4>",
  result: (room, g) => room.lgResultText(g),
  rules: (st) =>
    "Letter Grid: everyone plays the same " + st.size + "x" + st.size + " grid of letters (grid lists the rows, top first; a cell is a column letter and a row number, A1 at the top left). " +
    "Each round you send one secret word of at least " + st.min_len + " letters traced through touching cells - across, up, down or diagonal - using each cell once. It must be in the dictionary; a word that isn't, or can't be traced, is refused so you can send another. Your own words cannot repeat. " +
    "Words stay sealed until the round resolves. A word scores 1 point a letter, plus 1 for each cell it claims: a cell nobody has claimed yet goes to the first player whose word uses it (claims lists each cell's owner, row by row). The same word from two players in one round scores letters only and claims nothing, and a cell two words both take first in the same round stays free. " +
    st.rounds_total + " rounds; highest total wins, then most cells claimed, then the longest word, then the earlier final-round word. A round resolves when everyone still in has sent a word, or at the " + clockWords(st.round_seconds || 3600) + " deadline; a missed round scores nothing, and three in a row take you out. " +
    "Send word, and optionally path - the cells in order, as labels like [\"B2\", \"C2\"] or [[row, col], ...] counted from 0 - or dir as the word, optionally followed by its cells (e.g. stone B2 C2 C3 D4 E4). Without a path, the server takes the one that claims the most free cells. You can change your word until the round resolves.",
};
