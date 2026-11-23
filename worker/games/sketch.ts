// Sketch & Guess: a rotating artist draws a secret prompt, everyone guesses; Claude referees close calls.

import SG_PROMPTS_TXT from "../data/sketch-prompts.txt";
import { clockWords, gameRev, sameMove, seatAccepted, tvMatchKind } from "./shared.js";
import { sgClaudeJudge } from "../platform/claude.js";
import type { GameLogLine, GameStatus, SketchRound, SketchState, SketchYou } from "@chat/contract";
import type { CfgRow, GmRow, Room } from "../room/Room.js";
import type { GameRow } from "../room/games.js";
import type { GameEngineOf } from "./engine.js";
import { randInt } from "../lib/random.js";
import { goneError } from "../lib/errors.js";

// How long a round may sit in judging before the text match decides it.
const SG_JUDGE_STALL_MS = 120000;

/** A seat as createSketch stores it (st.players). */
export type SgSeat = { name: string, color: string, hex: string };
/** The round's secret prompt, and when its drawing went up (null until then). */
export type SgCur = { prompt: string, posted: number | null };
/** A sealed guess. */
export type SgSealed = { guess: string, at: number };
/** A round's stored drawing: its R2 key, content type and size (the image
 *  route serves it; sgRoundOut and sgSummary give its signed URL). */
export type SgImageMeta = { key: string, type: string, bytes: number };
/** A round as stored; sgRoundOut adds its image. */
export type SgRound = Omit<SketchRound, "image">;
/** The Referee's answer by seat (sgVerdictByName from sgClaudeJudge, or
 *  the test hook's stand-in): the seats it judged right and a roast, or
 *  why it did not judge. */
export type SgVerdict = { error: string } | { error?: undefined, right: Record<string, boolean>, roast: string, model: string };
/** Sketch & Guess's stored match state (g.st): what createSketch builds
 *  and the moves, the clock and the Referee change. sgSummary and
 *  sgStateFull turn it into the contract's SketchState. artist, phase and
 *  cur are null once the match is over; deck is the match's prompts, one
 *  a round; guesses are the sealed guesses, images the drawings by round
 *  number, judge_at when judging began; forfeits counts the run of rounds
 *  with no drawing. */
export type SgStored = {
  type: "sketch", draw_seconds: number, guess_seconds: number, rotations: number, rounds_total: number, round: number, order: string[],
  artist: string | null, phase: "draw" | "guess" | "judging" | null, deck: string[], cur: SgCur | null,
  guesses: Record<string, SgSealed>, images: Record<string, SgImageMeta>, judge_at: number | null, rounds: SgRound[], forfeits: number,
  deadline: number | null, lobby_deadline: number, accepted: Record<string, boolean>, players: SgSeat[], log: GameLogLine[],
  winner: string | null, places: string[] | null, draw: boolean, announced: boolean, declined_by?: string, ended?: number
};
/** A Sketch & Guess match: its row, with the state typed. */
export type SgGame = Omit<GameRow, "st"> & { st: SgStored };

// Sketch & Guess: the prompt deck (worker/data/sketch-prompts.txt),
// the image limits, and the Referee's judge.
export const SG_IMAGE_MAX = 1500000;
// The image as text: base64 of SG_IMAGE_MAX bytes, its data: label and
// the JSON a dir may wrap it in.
export const SG_IMAGE_TEXT_MAX = Math.ceil((SG_IMAGE_MAX * 4) / 3) + 200;
// The longest dir a drawing may come in: the image as text, with room for
// a line break every 76 characters written as JSON escapes ("\r\n", four
// characters), since sgDecodeImage drops them before it judges the size.
export const SG_DIR_MAX = SG_IMAGE_TEXT_MAX + Math.ceil((SG_IMAGE_TEXT_MAX * 4) / 76);
export const SG_GUESS_MAX = 80;
/** How long the draw clock holds off while a drawing that arrived in time is being stored. */
export const SG_STORE_GRACE_MS = 30000;
export const SG_JUDGE_DAILY = 200;
export const SG_ROASTS = [
  "The prompt was \"{p}\". The drawing has entered witness protection.",
  "Nobody saw \"{p}\" in that. Somewhere, an art teacher sighs.",
  "\"{p}\" - a bold interpretation, and a lonely one.",
  "It was \"{p}\". {a} drew it with total confidence, which counts for something.",
];
export let sgDeckCache: string[] | null = null;
export function sgDeck() {
  if (sgDeckCache) return sgDeckCache;
  sgDeckCache = String(SG_PROMPTS_TXT).split("\n").map((l) => l.trim()).filter((l) => l && l[0] !== "#");
  return sgDeckCache;
}
// A move's part from dir. The call room_state.awaiting_you hands out puts
// JSON in dir - {"image": ...} for the artist, {"guess": ...} for the
// rest - so dir that opens with { is read as JSON, as Trivia and Letter
// Grid read theirs. It used to be read as text: a guess was stored as the
// JSON itself and never matched the prompt, and the drawing was refused.
// Null when dir is not JSON; the JSON's part stands in for the named field.
export function sgFromDir(raw: unknown, key: "image" | "guess"): { value: string | null } | { error: string } | null {
  const s = String(raw == null ? "" : raw).trim();
  if (s[0] !== "{") return null;
  let o: Record<string, unknown>;
  try { o = JSON.parse(s); } catch (e) { return { error: "dir looked like JSON but did not parse: " + (e as Error).message }; }
  const v = o && o[key];
  return { value: typeof v === "string" ? v : null };
}
// An image move: a data URL (or bare base64) of a PNG, JPEG, GIF or WebP,
// checked by its magic bytes, not its label. Whitespace is dropped before
// the size is judged; too large an image is refused with status 413.
export function sgDecodeImage(raw: unknown): { bytes: Uint8Array, type: string, error?: undefined, status?: undefined } | { error: string, status: number } {
  // the whole text, label included: moveFields keeps one character past
  // SG_IMAGE_TEXT_MAX of a longer image, and that must not decode
  let s = String(raw || "").replace(/\s+/g, "");
  if (s.length > SG_IMAGE_TEXT_MAX) return { status: 413, error: "The image can be up to " + Math.round(SG_IMAGE_MAX / 1000) + " KB" };
  const m = s.match(/^data:([a-z0-9.+/-]+);base64,/i);
  if (m) s = s.slice(m[0].length);
  if (!s || !/^[A-Za-z0-9+/=_-]+$/.test(s)) return { status: 400, error: "image is a data URL (data:image/png;base64,...) or base64 of a PNG, JPEG, GIF or WebP" };
  if (s.length > Math.ceil((SG_IMAGE_MAX * 4) / 3) + 8) return { status: 413, error: "The image can be up to " + Math.round(SG_IMAGE_MAX / 1000) + " KB" };
  let bin;
  try { bin = atob(s.replace(/-/g, "+").replace(/_/g, "/")); } catch { return { status: 400, error: "image is not valid base64" }; }
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  if (bytes.length > SG_IMAGE_MAX) return { status: 413, error: "The image can be up to " + Math.round(SG_IMAGE_MAX / 1000) + " KB" };
  const b = (i: number) => bytes[i];
  let type: string | null = null;
  if (b(0) === 0x89 && b(1) === 0x50 && b(2) === 0x4e && b(3) === 0x47) type = "image/png";
  else if (b(0) === 0xff && b(1) === 0xd8 && b(2) === 0xff) type = "image/jpeg";
  else if (b(0) === 0x47 && b(1) === 0x49 && b(2) === 0x46 && b(3) === 0x38) type = "image/gif";
  else if (b(0) === 0x52 && b(1) === 0x49 && b(2) === 0x46 && b(3) === 0x46 && b(8) === 0x57 && b(9) === 0x45 && b(10) === 0x42 && b(11) === 0x50) type = "image/webp";
  if (!type) return { status: 400, error: "The image must be a PNG, JPEG, GIF or WebP" };
  return { bytes: bytes, type: type };
}

// The Referee's answer keyed by seat name again. Claude is sent opaque ids
// (g1, g2, ... in a shuffled order) in place of the players' names, so no
// name a member chose reaches it, and a guess cannot tell it which seat to
// favour by name. Its verdicts used to be keyed by whatever names came
// back and were taken unchecked. The answer is taken only when it holds
// exactly one verdict for each id this round sent and none for any other
// id; anything else voids the whole answer, and the text match decides.
// Only the right verdicts used to come back, so an id answered twice went
// unseen and one left out was simply scored wrong.
/** @param ids the ids sent, to the seats' names */
export function sgVerdictByName(answer: Awaited<ReturnType<typeof sgClaudeJudge>>, ids: Record<string, string>): SgVerdict {
  if (answer.error !== undefined) return answer;
  const right: Record<string, boolean> = {};
  const seen = new Set<string>();
  for (const v of answer.verdicts) {
    if (!Object.prototype.hasOwnProperty.call(ids, v.id) || seen.has(v.id)) return { error: "bad_verdict" };
    seen.add(v.id);
    if (v.right) right[ids[v.id]] = true;
  }
  if (seen.size !== Object.keys(ids).length) return { error: "bad_verdict" };
  return { right: right, roast: answer.roast, model: answer.model };
}
// The longest roast from Claude the round shows: about the 20 words it is
// asked for, which fits the panel's line and the arena's title.
export const SG_ROAST_MAX = 140;
// Claude's roast, as the round shows it: one line of plain text, cut at a
// word to SG_ROAST_MAX. It is shown to every member and read by agents as
// the Referee's line, and a guess could ask Claude to write it: one with a
// link in it, or nothing left once cleaned, gives way to a built-in roast
// (null).
export function sgCleanRoast(raw: unknown): string | null {
  // control and bidi characters, then every run of whitespace (a newline too) as one space
  // oxlint-disable-next-line no-control-regex -- matching control characters is the point
  let s = String(raw == null ? "" : raw).replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, " ").replace(/\s+/g, " ").trim();
  if (!s || /:\/\/|\bwww\.|\b[a-z0-9-]+\.(?:com|net|org|io|ai|co|ly|gg|xyz|cloud|app|dev)\b/i.test(s)) return null;
  if (s.length > SG_ROAST_MAX) {
    const cut = s.slice(0, SG_ROAST_MAX - 3);
    const sp = cut.lastIndexOf(" ");
    s = (sp > SG_ROAST_MAX / 2 ? cut.slice(0, sp) : cut).replace(/[\s,;:.-]+$/, "") + "...";
  }
  return s;
}

export const SketchMethods = {
  /* ---------- games: Sketch & Guess ----------
     Player rules: rules() below. Prompts come from the deck
     (worker/data/sketch-prompts.txt), no repeats in a match; the image is
     generated or drawn on the web app's sketch pad. It is stored in R2
     and served at a signed URL, and shows in the card and the arena, not
     in chat (results only, the house rule). Judging: a guess equal to the
     prompt once folded (or one letter off) is right on its own; the rest
     go to the Referee - Claude, one call a round (sgClaudeJudge) - which
     also writes the roast when nobody got it. Without Claude (no key, the
     daily cap, any error) the text match stands alone. */
  sgGuessers(st: SgStored) {
    return st.players.filter((p) => p.name !== st.artist);
  },

  // Each seat's score, exact guesses, right guesses and their average
  // time (ms; 0 with none - the count of right guesses is compared first,
  // so a seat with none never wins on it).
  sgTally(st: SgStored) {
    const t: Record<string, { score: number, exact: number, right: number, ms: number }> = {};
    for (const p of st.players) t[p.name] = { score: 0, exact: 0, right: 0, ms: 0 };
    for (const r of st.rounds) {
      for (const n of Object.keys(r.points || {})) t[n].score += r.points[n];
      for (const n of Object.keys(r.guesses || {})) {
        const x = r.guesses[n];
        if (x.right) {
          if (x.exact) t[n].exact += 1;
          t[n].right += 1;
          t[n].ms += Math.max(0, x.ms || 0);
        }
      }
    }
    for (const n of Object.keys(t)) if (t[n].right) t[n].ms = t[n].ms / t[n].right;
    return t;
  },

  /** @param n the round */
  /** @param g the match (only its id is read) */
  sgImageUrl(g: { id: number }, n: number) {
    return this.roomName ? "/api/rooms/" + this.roomName + "/games/" + g.id + "/sketch/" + n + this.mediaQuery(g.id + "." + n, "sketch") : null;
  },

  sgRoundOut(g: SgGame, r: SgRound): SketchRound {
    return Object.assign({}, r, { image: (g.st.images || {})[r.n] ? { url: this.sgImageUrl(g, r.n), type: g.st.images[r.n].type } : null });
  },

  // The image of round n, for the image route: public once posted.
  /** @param n the round */
  sketchImage(gid: number, n: number): SgImageMeta | null {
    const g = this.gameRowOf<SgStored>(gid, "sketch");
    if (!g) return null;
    return (g.st.images || {})[n] || null;
  },

  sgSummary(g: SgGame): SketchState {
    const st = g.st;
    const t = this.sgTally(st);
    const live = g.status === "running";
    const img = live && st.phase !== "draw" && (st.images || {})[st.round] ? { url: this.sgImageUrl(g, st.round), type: st.images[st.round].type } : null;
    return {
      id: g.id, type: "sketch", status: g.status, created_by: g.created_by, card_msg: g.card_msg, rev: gameRev(g.st),
      round: st.round, rounds_total: st.rounds_total, rotations: st.rotations, phase: live ? st.phase : null, artist: live ? st.artist : null, image: img,
      draw_seconds: st.draw_seconds, guess_seconds: st.guess_seconds, deadline: st.deadline, lobby_deadline: g.status === "lobby" ? (st.lobby_deadline || null) : null, order: st.order,
      last_round: st.rounds.length ? this.sgRoundOut(g, st.rounds[st.rounds.length - 1]) : null,
      winner: st.winner || null, draw: !!st.draw, places: st.places || null, declined_by: st.declined_by || null,
      players: st.players.map((p) => ({ name: p.name, color: p.color, hex: p.hex, accepted: st.accepted ? !!st.accepted[p.name] : true, score: t[p.name].score, exact: t[p.name].exact, committed: live && st.phase === "guess" ? st.guesses[p.name] !== undefined : live && p.name !== st.artist })),
    };
  },

  sgStateFull(g: SgGame, who: string | null | undefined): SketchState {
    const out = this.sgSummary(g);
    const st = g.st;
    out.rounds = st.rounds.map((r) => this.sgRoundOut(g, r));
    out.log = st.log.slice(-24);
    const live = g.status === "running";
    out.awaiting = !live ? [] : st.phase === "draw" ? [st.artist as string] : st.phase === "guess" ? this.sgGuessers(st).filter((p) => st.guesses[p.name] === undefined).map((p) => p.name) : [];
    out.awaiting_accept = g.status === "lobby" ? st.players.filter((p) => !(st.accepted || {})[p.name]).map((p) => p.name) : [];
    const me = st.players.find((p) => p.name.toLowerCase() === String(who || "").toLowerCase());
    if (!me) {
      out.you = { playing: false };
      return out;
    }
    const artist = live && st.artist === me.name;
    const you: SketchYou = { playing: true, accepted: st.accepted ? !!st.accepted[me.name] : true, artist: artist, legal_moves: [] };
    if (artist) {
      you.prompt = st.cur ? st.cur.prompt : null;
      if (st.phase === "draw") you.legal_moves = ['{"image": "data:image/png;base64,<your drawing>"}'];
    } else if (live && st.phase === "guess") {
      you.queued = st.guesses[me.name] ? st.guesses[me.name].guess : null;
      you.legal_moves = ['{"guess": "<what the drawing shows>"}'];
    }
    out.you = you;
    return out;
  },

  /** @param opts the create's options (request JSON) */
  async createSketch(creator: string, playersIn: unknown[], opts: Record<string, unknown>, room: string) {
    if (!Array.isArray(playersIn) || playersIn.length < 3 || playersIn.length > 6) return { status: 400, error: "Sketch & Guess needs 3 to 6 players" };
    const resolved = this.gamePlayers(playersIn);
    if (resolved.error) return resolved;
    const names = (resolved.names as string[]).slice(); // gamePlayers sets names whenever it sets no error
    for (let i = names.length - 1; i > 0; i--) {
      const j = randInt(i + 1);
      [names[i], names[j]] = [names[j], names[i]];
    }
    const clamp: (v: unknown, lo: number, hi: number, def: number) => number = (v, lo, hi, def): number => { const n = Math.floor(Number(v)); return Number.isFinite(n) && n > 0 ? Math.min(hi, Math.max(lo, n)) : def; };
    const rotations = clamp(opts.rotations, 1, 3, Math.max(1, Math.min(3, Math.round(6 / names.length))));
    const drawSeconds = clamp(opts.draw_seconds !== undefined ? opts.draw_seconds : opts.tick_seconds, 60, 86400, 3600);
    const guessSeconds = clamp(opts.guess_seconds, 30, 86400, 600);
    const total = names.length * rotations;
    const deck = sgDeck().slice();
    for (let i = deck.length - 1; i > 0; i--) {
      const j = randInt(i + 1);
      [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    const colors = this.gameColors();
    const players = (resolved.names as string[]).map((n, i) => ({ name: n, color: colors[i].color, hex: colors[i].hex }));
    const st: SgStored = {
      type: "sketch", draw_seconds: drawSeconds, guess_seconds: guessSeconds, rotations: rotations, rounds_total: total, round: 1, order: names, artist: names[0], phase: "draw",
      deck: deck.slice(0, total), cur: { prompt: deck[0], posted: null }, guesses: {}, images: {}, judge_at: null, rounds: [], forfeits: 0,
      deadline: null, lobby_deadline: Date.now() + this.lobbySeconds(opts) * 1000, accepted: this.lobbyAccepted(creator, resolved.names), players: players,
      log: [{ tick: 0, text: "Sketch & Guess created by " + creator + " - artists in this order: " + names.join(", ") + (rotations > 1 ? ", " + rotations + " times round" : "") + ". The clock starts when everyone accepts." }],
      winner: null, places: null, draw: false, announced: false,
    };
    const ins = this.sql.exec<Pick<GmRow, "id">>("INSERT INTO gm (status, created, created_by, state) VALUES ('lobby', ?, ?, ?) RETURNING id", Date.now(), creator, JSON.stringify(st)).one();
    const g = this.gameRowOf<SgStored>(ins.id, "sketch")!; // the row just inserted
    const label = players.map((p) => p.name + " (" + p.color + ")").join(", ");
    const cardText = "Sketch & Guess #" + g.id + " - " + label + ". Each round an artist draws a secret prompt; everyone else guesses what it shows. " + names[0] + " draws first. Clock: " + clockWords(drawSeconds) + " to draw, " + clockWords(guessSeconds) + " to guess. Lobby open - the game starts when everyone accepts; tap the card to take your seat.";
    const msg = await this.postGameCard(creator, cardText, g.id, room);
    this.sql.exec("UPDATE gm SET card_msg = ? WHERE id = ?", msg.id, g.id);
    g.card_msg = msg.id;
    this.broadcastGame(g, room, creator);
    await this.armGameAlarm();
    return { status: 201, game: this.sgStateFull(g, creator) };
  },

  async sgMove(g: SgGame, who: string, raw: unknown, room: string, fields: Record<string, unknown> | null | undefined) {
    // match ids start again at 1 in a room created again under the name:
    // after an await, a move from a deleted room stops (Room.fence)
    const gen = this.gen;
    const st = g.st;
    const me = st.players.find((p) => p.name.toLowerCase() === String(who || "").toLowerCase());
    if (!me) return { status: 403, error: "You are not a player in this game" };
    if (st.phase === "judging") return { status: 409, error: "The Referee is judging this round's guesses - the reveal is a moment away" };
    if (st.phase === "draw") {
      if (me.name !== st.artist) return { status: 409, error: st.artist + " is drawing - you guess once the drawing is up" };
      const d = fields && typeof fields.image === "string" ? { value: fields.image } : sgFromDir(raw, "image");
      if (d && "error" in d) return { status: 400, error: d.error };
      const src = d ? d.value : /^\s*data:/.test(String(raw || "")) ? raw : null;
      if (!src) return { status: 400, error: "As the artist, send image: your drawing of the prompt (you.prompt) as a data URL - data:image/png;base64,... - a PNG, JPEG, GIF or WebP up to " + Math.round(SG_IMAGE_MAX / 1000) + " KB", legal_moves: ['{"image": "data:image/png;base64,<your drawing>"}'] };
      const img = sgDecodeImage(src);
      if (img.error !== undefined) return { status: img.status, error: img.error };
      if (!this.env || !this.env.MEDIA) return { status: 503, error: "Image storage is not available right now" };
      const rnd = Array.from(crypto.getRandomValues(new Uint8Array(6))).map((b) => ("0" + b.toString(16)).slice(-2)).join("");
      const key = "games/" + room + "/" + g.id + "/r" + st.round + "-" + rnd + "." + img.type.split("/")[1];
      // The drawing is here, in time: the clock must not run out while it
      // is being stored. It used to, and a drawing sent seconds before
      // the deadline was forfeited (two in a row call the match off).
      if (st.deadline && st.deadline - Date.now() < SG_STORE_GRACE_MS) {
        st.deadline = Date.now() + SG_STORE_GRACE_MS;
        this.saveGame(g);
      }
      try { await this.env.MEDIA.put(key, img.bytes, { httpMetadata: { contentType: img.type } }); } catch { return { status: 503, error: "The image could not be stored - try again" }; }
      if (!this.alive(gen)) {
        try { await this.env.MEDIA.delete(key); } catch { /* nobody's object either way: the room's delete has run */ }
        throw goneError();
      }
      // the state may have moved while the image was stored
      const g2 = this.gameRowOf<SgStored>(g.id, "sketch");
      if (!g2 || g2.status !== "running" || g2.st.phase !== "draw" || g2.st.round !== st.round) {
        // This request stored the object and nothing will point at it: a
        // draw sent twice, or overtaken by its clock, used to leave a
        // drawing in the bucket that no delete path, the room's included,
        // ever found. It is this request's own key, so nobody else's.
        try { await this.env.MEDIA.delete(key); } catch { /* the 409 stands either way */ }
        return { status: 409, error: "The round moved on while your drawing was uploading" };
      }
      const s2 = g2.st;
      if (!s2.images) s2.images = {};
      s2.images[s2.round] = { key: key, type: img.type, bytes: img.bytes.length };
      (s2.cur as SgCur).posted = Date.now(); // a draw phase has its prompt
      s2.phase = "guess";
      s2.guesses = {};
      s2.deadline = Date.now() + s2.guess_seconds * 1000;
      s2.log.push({ tick: s2.round, text: me.name + "'s drawing is up - guess what it shows." });
      this.saveGame(g2);
      this.afterGameChange(g2, room, me.name);
      await this.armGameAlarm();
      return { status: 200, game: this.sgStateFull(g2, who), resolved: false };
    }
    if (me.name === st.artist) return { status: 409, error: "You are the artist this round - the others are guessing your drawing" };
    const d = fields && typeof fields.guess === "string" ? { value: fields.guess } : sgFromDir(raw, "guess");
    if (d && "error" in d) return { status: 400, error: d.error };
    const s = String(d ? d.value || "" : raw == null ? "" : raw).replace(/^\s*guess\s*:\s*/i, "").replace(/\s+/g, " ").trim();
    if (!s) return { status: 400, error: "Send guess: what the drawing shows", legal_moves: ['{"guess": "<what the drawing shows>"}'] };
    if (s.length > SG_GUESS_MAX) return { status: 400, error: "A guess can be up to " + SG_GUESS_MAX + " characters" };
    if (sameMove(st.guesses[me.name]?.guess, s)) return { status: 200, game: this.sgStateFull(g, who), resolved: false };
    st.guesses[me.name] = { guess: s, at: Date.now() };
    const all = this.sgGuessers(st).every((p) => st.guesses[p.name] !== undefined);
    if (!all) {
      this.saveGame(g);
      this.broadcastGame(g, room, me.name);
      await this.armGameAlarm();
      return { status: 200, game: this.sgStateFull(g, who), resolved: false };
    }
    this.sgClose(g);
    this.saveGame(g);
    await this.sgJudgeNow(g.id, room);
    this.fence(gen);
    const g3 = this.gameRowOf<SgStored>(g.id, "sketch");
    // the row this move saved, unless the room was destroyed during the
    // Referee's call
    if (!g3) return { status: 404, error: "No game with that id" };
    await this.armGameAlarm();
    return { status: 200, game: this.sgStateFull(g3, who), resolved: true };
  },

  // The guesses are in (or the clock ran out): judging starts. The judge
  // itself runs async - from the move that closed the guesses, or from the
  // alarm (advanceAsync) - so a read only flips the phase and leaves the
  // judging to the alarm, a second away.
  sgClose(g: SgGame) {
    const st = g.st;
    st.phase = "judging";
    st.judge_at = Date.now();
    st.deadline = Date.now() + 1000;
  },

  // Folded equal (or one letter off) to the prompt: right on its own.
  // Trivia's match, so a number in a prompt gets no leeway there either.
  // Runs once the drawing is up, so cur is set.
  sgAuto(st: SgStored) {
    const out: Record<string, "exact" | "near" | null> = {};
    const p = (st.cur as SgCur).prompt;
    for (const n of Object.keys(st.guesses)) out[n] = tvMatchKind(st.guesses[n].guess, [p]);
    return out;
  },

  async sgJudgeNow(gid: number, room: string) {
    if (!this.sgJudging) this.sgJudging = new Set();
    if (this.sgJudging.has(gid)) return;
    const g0 = this.gameRowOf<SgStored>(gid, "sketch");
    if (!g0 || g0.status !== "running" || g0.st.phase !== "judging") return;
    // destroy() starts a fresh set: this judge's entry stays in its own
    // room's, so it neither holds up nor clears a judge in a room created since
    const judging = this.sgJudging;
    judging.add(gid);
    const gen = this.gen;
    try {
      const st0 = g0.st;
      const n = st0.round;
      const auto = this.sgAuto(st0);
      const names = Object.keys(st0.guesses);
      const pending = names.filter((x) => !auto[x]);
      // shuffled, so an id says nothing about who guessed first
      for (let i = pending.length - 1; i > 0; i--) {
        const j = randInt(i + 1);
        [pending[i], pending[j]] = [pending[j], pending[i]];
      }
      /** the ids Claude is sent, to the seats' names (sgVerdictByName) */
      const ids: Record<string, string> = {};
      pending.forEach((x, i) => { ids["g" + (i + 1)] = x; });
      const anyRight = names.some((x) => auto[x]);
      let verdict: SgVerdict | null = null;
      if (pending.length) {
        // while Claude thinks, the clock sits past the judge's own timeout,
        // so the alarm does not fire again and again meanwhile
        st0.deadline = Date.now() + 45000;
        this.saveGame(g0);
        // the test hook's verdict names seats; Claude's names the ids
        const hook = this.sgTestJudge();
        if (hook) verdict = hook;
        else if (this.sgJudgeBudget()) verdict = sgVerdictByName(await sgClaudeJudge(this.env, (st0.cur as SgCur).prompt, Object.keys(ids).map((id) => ({ id: id, guess: st0.guesses[ids[id]].guess })), !anyRight), ids); // judging: the drawing is up
        else verdict = { error: "daily_cap" };
      }
      // the round may have moved on while the Referee thought, or the room
      // gone: one created again since has its own match under this id
      if (!this.alive(gen)) return;
      const g = this.gameRowOf<SgStored>(gid, "sketch");
      if (!g || g.status !== "running" || g.st.phase !== "judging" || g.st.round !== n) return;
      this.sgResolve(g, auto, verdict);
      this.saveGame(g);
      this.afterGameChange(g, room, "Referee");
    } finally {
      judging.delete(gid);
    }
  },

  // The room's daily allowance of Referee calls (counted when spent).
  sgJudgeBudget() {
    const day = new Date().toISOString().slice(0, 10);
    const r = this.sql.exec<Pick<CfgRow, "v">>("SELECT v FROM cfg WHERE k = 'sg_judge_day'").toArray()[0];
    const [d, c] = String((r && r.v) || "").split(":");
    const used = d === day ? parseInt(c, 10) || 0 : 0;
    if (used >= SG_JUDGE_DAILY) return false;
    this.sql.exec("INSERT OR REPLACE INTO cfg (k, v) VALUES ('sg_judge_day', ?)", day + ":" + (used + 1));
    return true;
  },

  // Tests: a verdict laid by the test hook stands in for Claude, once.
  sgTestJudge(): SgVerdict | null {
    if (!this.env || !this.env.TEST_HOOKS) return null;
    const r = this.sql.exec<Pick<CfgRow, "v">>("SELECT v FROM cfg WHERE k = 'test_sg_judge'").toArray()[0];
    if (!r) return null;
    this.sql.exec("DELETE FROM cfg WHERE k = 'test_sg_judge'");
    try {
      const o = JSON.parse(r.v); // the test's verdict JSON, as setTestSketchJudge stored it
      if (o.error) return { error: String(o.error) };
      const right: Record<string, boolean> = {};
      for (const n of o.right || []) right[n] = true;
      return { right: right, roast: String(o.roast || ""), model: "test" };
    } catch {
      return null;
    }
  },

  /** @param verdict { right: [names], roast } or { error }, from the request's JSON */
  setTestSketchJudge(verdict: unknown) {
    if (!this.env || !this.env.TEST_HOOKS) return { error: "Not found" };
    this.sql.exec("INSERT OR REPLACE INTO cfg (k, v) VALUES ('test_sg_judge', ?)", JSON.stringify(verdict || {}));
    return { ok: true };
  },

  /**
   * @param auto sgAuto's verdicts
   * @param verdict the Referee's, if it was asked
   */
  sgResolve(g: SgGame, auto: Record<string, "exact" | "near" | null>, verdict: SgVerdict | null) {
    // it runs once the guessing has begun: the round has its artist and prompt
    const st = g.st as SgStored & { artist: string, cur: SgCur };
    /** the verdict, when it came back without an error */
    const good = verdict && verdict.error === undefined ? verdict : null;
    const ok = !!good;
    /** The round as stored; sgRoundOut adds its image. */
    const rec: Omit<SketchRound, "image"> = { n: st.round, artist: st.artist, prompt: st.cur.prompt, guesses: {}, right: [], missed: [], points: {}, judge: ok ? "referee" : "match", judge_note: verdict && verdict.error ? verdict.error : null, roast: null, forfeit: false, at: Date.now() };
    for (const p of this.sgGuessers(st)) {
      const x = st.guesses[p.name];
      if (!x) {
        rec.missed.push(p.name);
        continue;
      }
      const a = auto[p.name];
      const byRef = !a && !!good && !!good.right[p.name];
      const right = !!a || byRef;
      rec.guesses[p.name] = { guess: x.guess, right: right, exact: a === "exact", how: a ? "match" : ok ? "referee" : "match", at: x.at, ms: Math.max(0, x.at - (st.cur.posted || x.at)) };
      if (right) {
        rec.right.push(p.name);
        rec.points[p.name] = 2;
      }
    }
    rec.points[st.artist] = Math.min(2, rec.right.length);
    if (!rec.right.length) rec.roast = (good && sgCleanRoast(good.roast)) || SG_ROASTS[st.round % SG_ROASTS.length].replace(/\{p\}/g, st.cur.prompt).replace(/\{a\}/g, st.artist);
    st.rounds.push(rec);
    st.log.push({ tick: st.round, text: "Round " + st.round + ": it was " + st.cur.prompt + ". " + (rec.right.length ? rec.right.join(", ") + " got it" : "Nobody got it") + "; " + st.artist + " +" + rec.points[st.artist] + "." });
    st.forfeits = 0;
    this.sgNext(g);
  },

  sgNext(g: SgGame) {
    const st = g.st;
    st.guesses = {};
    st.judge_at = null;
    const played = st.rounds.some((r) => !r.forfeit && Object.keys(r.guesses || {}).length);
    if (st.forfeits >= 2 || st.round >= st.rounds_total) {
      if (!played) {
        g.status = "cancelled";
        st.log.push({ tick: st.round, text: "Nothing was drawn and guessed - the game is called off." });
        return;
      }
      g.status = "finished";
      st.winner = this.sgStanding(st);
      st.phase = null;
      st.artist = null;
      st.cur = null;
      st.deadline = null;
      st.log.push({ tick: st.round, text: (st.forfeits >= 2 ? "Two forfeits in a row - the game ends where it stands. " : "") + (st.winner ? st.winner + " wins." : "A tie at the top - no winner.") });
      return;
    }
    st.round += 1;
    st.artist = this.roleOf(st, st.round);
    st.phase = "draw";
    st.cur = { prompt: st.deck[st.round - 1] || sgDeck()[randInt(sgDeck().length)], posted: null };
    st.deadline = Date.now() + st.draw_seconds * 1000;
  },

  sgAdvance(g: SgGame | null, room: string) {
    if (!g || g.status !== "running") return;
    const st = g.st;
    if (st.phase === "judging") {
      // the judge never ran (the instance went away mid-call): the text
      // match decides
      if (Date.now() - (st.judge_at || 0) > SG_JUDGE_STALL_MS) {
        this.sgResolve(g, this.sgAuto(st), { error: "stalled" });
        this.saveGame(g);
        this.afterGameChange(g, room, "Referee");
      }
      return;
    }
    if (Date.now() < (st.deadline as number)) return; // a running match's clock is set
    if (st.phase === "draw") {
      // a draw phase has its artist and prompt
      st.rounds.push({ n: st.round, artist: st.artist as string, prompt: (st.cur as SgCur).prompt, guesses: {}, right: [], missed: [], points: {}, judge: null, judge_note: null, roast: null, forfeit: true, at: Date.now() });
      st.log.push({ tick: st.round, text: st.artist + " ran out of time to draw - round " + st.round + " is forfeit. The prompt was " + (st.cur as SgCur).prompt + "." });
      st.forfeits += 1;
      this.sgNext(g);
    } else if (Object.keys(st.guesses).length) this.sgClose(g);
    else this.sgResolve(g, {}, null);
    this.saveGame(g);
    // sgNext may have called it off (the check above narrowed status to running)
    if ((g.status as GameStatus) === "cancelled") this.postSystem("Sketch & Guess #" + g.id + " is off - nothing was drawn and guessed.", room);
    this.afterGameChange(g, room, "Referee");
  },

  // The alarm's path: the clock work, then the judge when it is due.
  // advanceGame and the catch here count a throw for the alarm's backoff
  // (gameClockFailed), so a judge that keeps failing is retried later each
  // time, not in a tight loop; only a judge that went through clears the
  // count (the judging phase's sync advance does nothing, so it does not)
  async sgAdvanceAsync(g: SgGame, room: string) {
    this.advanceGame(g, room);
    const g2 = this.gameRowOf<SgStored>(g.id, "sketch");
    if (!g2 || g2.status !== "running" || g2.st.phase !== "judging") return;
    try {
      await this.sgJudgeNow(g2.id, room);
    } catch (e) {
      // the backoff doubles to 30, 60, 120 s: without the cap a judge that
      // kept failing held the round past its stall fallback, to about 210 s
      this.gameClockFailed(g2.id, (g2.st.judge_at || 0) + SG_JUDGE_STALL_MS + 1000);
      throw e;
    }
    this.gameClockOk(g2.id);
  },

  // Ties go to more exact guesses, then more right guesses, then the
  // quicker right guesses on average. The times used to be summed alone,
  // so every extra right guess counted against a player, and one who
  // scored only as the artist (0 ms) beat one with two quick right guesses.
  sgStanding(st: SgStored) {
    const t = this.sgTally(st);
    st.places = st.players.map((p) => p.name).sort((a, b) => t[b].score - t[a].score || t[b].exact - t[a].exact || t[b].right - t[a].right || t[a].ms - t[b].ms || (a < b ? -1 : 1));
    const [x, y] = st.places;
    const tied = !!y && t[x].score === t[y].score && t[x].exact === t[y].exact && t[x].right === t[y].right && t[x].ms === t[y].ms;
    st.draw = tied;
    return tied ? null : x;
  },

  sgResultText(g: SgGame) {
    const st = g.st;
    if (!st.places) st.winner = this.sgStanding(st);
    const t = this.sgTally(st);
    const lines = (st.places as string[]).map((n) => n + " " + t[n].score).join(", "); // sgStanding sets places
    const best = st.rounds.filter((r) => !r.forfeit).sort((a, b) => b.right.length - a.right.length)[0];
    return "Sketch & Guess #" + g.id + " is over - " + (st.winner ? st.winner + " wins with " + t[st.winner].score + " points." : "a tie at the top, no winner.") + " " + lines + "." + (best && best.right.length ? " Most guessed: " + best.artist + "'s " + best.prompt + " (" + best.right.length + (best.right.length === 1 ? " got it)." : " got it).") : "");
  },
} satisfies ThisType<Room>;

export const sketchEngine = {
  name: "Sketch & Guess",
  turnWord: "round",
  logTick: (st: SgStored) => st.round,
  dirMax: SG_DIR_MAX,
  clockSeconds: (st: SgStored) => (st.phase === "guess" ? st.guess_seconds : st.draw_seconds),
  create: (room, creator, players, opts, roomName) => room.createSketch(creator, players, opts, roomName),
  summary: (room, g) => room.sgSummary(g),
  // the last drawing's link is signed to expire (mediaQuery), and an alarm
  // in a fresh instance has no room name to mint it with: mint it again
  relist: (room, pub) => {
    const lr = (pub as SketchState).last_round;
    if (lr && lr.image) lr.image.url = room.sgImageUrl(pub, lr.n);
  },
  full: (room, g, who) => room.sgStateFull(g, who),
  move: (room, g, who, dir, roomName, fields) => room.sgMove(g, who, dir, roomName, fields),
  advance: (room, g, roomName) => room.sgAdvance(g, roomName),
  // the alarm awaits this one: the Referee's judge is an API call
  advanceAsync: (room, g, roomName) => room.sgAdvanceAsync(g, roomName),
  // pub is sgSummary's state
  targets: (pub: SketchState) => (pub.status !== "running" ? [] : pub.phase === "draw" ? (pub.artist ? [pub.artist] : []) : pub.phase === "guess" ? (pub.players || []).filter((p) => p.name !== pub.artist && !p.committed).map((p) => p.name) : []),
  card: (g: SgGame) => {
    const t: Record<string, number> = {};
    for (const p of g.st.players) t[p.name] = 0;
    for (const r of g.st.rounds) for (const n of Object.keys(r.points || {})) t[n] += r.points[n];
    return { id: g.id, type: "sketch", status: g.status, round: g.st.round, rounds_total: g.st.rounds_total, phase: g.status === "running" ? g.st.phase : null, artist: g.status === "running" ? g.st.artist : null, winner: g.st.winner || null, draw: !!g.st.draw, players: g.st.players.map((p) => ({ name: p.name, color: p.color, hex: p.hex, score: t[p.name] || 0 })) };
  },
  stateItem: (r, st: SgStored) => ({ id: r.id, type: "sketch", status: r.status, phase: st.phase, artist: st.artist, turn: (st.round || 0) * 3 + (st.phase === "guess" ? 1 : st.phase === "judging" ? 2 : 0), players: (st.players || []).map((p) => ({ name: p.name, alive: true, moved: r.status !== "running" || (st.phase === "draw" ? p.name !== st.artist : st.phase === "guess" ? p.name === st.artist || (st.guesses || {})[p.name] !== undefined : true), accepted: seatAccepted(st, p) })) }),
  turnOf: (gm) => Number(gm.turn),
  moveHint: (gm, name) => (gm.artist === name ? '{"image": "data:image/png;base64,<your drawing of you.prompt>"}' : '{"guess": "<what the drawing shows>"}'),
  result: (room, g) => room.sgResultText(g),
  rules: (st: SgStored) =>
    "Sketch & Guess: each round one player is the artist (in this order: " + st.order.join(", ") + (st.rotations > 1 ? ", " + st.rotations + " times round" : "") + ", " + st.rounds_total + " rounds) and gets a secret prompt in you.prompt. " +
    "The artist draws it - generate an image or draw one - with no letters or words in it: the picture has to do the work. " +
    "Then everyone else sends one sealed guess, changeable until the guesses close. A guess that matches the prompt is right on its own; the Referee (Claude) rules on close calls - same meaning counts. " +
    "A right guess scores 2; the artist scores 1 per right guesser, at most 2 - so draw something guessable but not trivial. If nobody gets it, the prompt is revealed with a roast. " +
    "The artist has " + clockWords(st.draw_seconds || 3600) + " to draw (missing it forfeits the round; two forfeits in a row end the game); guessers have " + clockWords(st.guess_seconds || 600) + " once the drawing is up. Highest total wins; ties go to more exact guesses, then more right guesses, then quicker right guesses on average. " +
    "Send: as the artist, image as a data URL (data:image/png;base64,...; PNG, JPEG, GIF or WebP up to " + Math.round(SG_IMAGE_MAX / 1000) + " KB); as a guesser, guess (or dir).",
} satisfies GameEngineOf<SgStored>;
