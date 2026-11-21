// The Room Durable Object: one per room, SQLite-backed. The class holds the
// core (schema, lifecycle, access, fetch, the alarm); every other area's
// methods live in their own module and are installed on the class at the end
// of this file. The Worker's main module re-exports the class.

import { DurableObject } from "cloudflare:workers";
import { gameEngine } from "../games/engine.js";
import { renderRoomState, stateFrame, streamWants } from "./state.js";
import { KEEP } from "../limits.js";
import { SSE_HEADERS, sseFrame } from "../lib/http.js";
import { FourInARowMethods } from "../games/fourinarow.js";
import { TrustMethods } from "../games/trust.js";
import { AuctionMethods } from "../games/auction.js";
import { FrontlinesMethods } from "../games/frontlines.js";
import { CodeRaceMethods } from "../games/coderace.js";
import { LiarsDiceMethods } from "../games/liarsdice.js";
import { TwoTruthsMethods } from "../games/twotruths.js";
import { TriviaMethods } from "../games/trivia.js";
import { SketchMethods } from "../games/sketch.js";
import { CorpseMethods } from "../games/corpse.js";
import { WerewolfMethods } from "../games/werewolf.js";
import { TwentyMethods } from "../games/twenty.js";
import { LetterGridMethods } from "../games/lettergrid.js";
import { DuelMethods } from "../games/duel.js";
import { LightCyclesMethods, LightCyclesTickMethods } from "../games/lightcycles.js";
import { BattleshipMethods } from "../games/battleship.js";
import { MemberMethods } from "./members.js";
import { VoiceMethods } from "./voices.js";
import { MediaMethods } from "./media.js";
import { UploadMethods } from "./uploads.js";
import { PushMethods } from "./push.js";
import { BoardMethods } from "./board.js";
import { StateMethods } from "./state.js";
import { MessageMethods } from "./messages.js";
import { GameMachineryMethods } from "./games.js";
import { TestHookMethods } from "./test-hooks.js";

/* ---------- storage rows ----------
   One typedef per table: the columns ensureSchema creates. A column is
   nullable where the code can leave it NULL (a later ALTER, an optional
   field, a state such as revoked); columns every write fills are not.
   A query casts its rows to its table's row, or to a Pick of it for a
   column list, once. */
/** m: one message (draft until published).
 *  @typedef {{ id: number, ts: number, sender: string, text: string, draft: number | null, pubauto: number | null, pub_ts: number | null, owntrust: number | null,
 *    audio_type: string | null, audio_size: number | null, audio_transcript: string | null, image_type: string | null, image_size: number | null,
 *    video_type: string | null, video_size: number | null, html_type: string | null, html_size: number | null, html_name: string | null,
 *    doc_type: string | null, doc_size: number | null, doc_name: string | null, file_type: string | null, file_size: number | null, file_name: string | null,
 *    game_id: number | null }} MsgRow */
/** rx: one member's reaction to a message.
 *  @typedef {{ msg: number, emoji: string, who: string, ts: number }} RxRow */
/** inv: an invite, and the member it names.
 *  @typedef {{ token: string, name: string, created: number, revoked: number | null, used: number | null, seen: number | null, kind: string | null,
 *    invited_by: string | null, posted: number | null, avatar_type: string | null, avatar_ver: number | null, avatar_key: string | null }} InvRow */
/** cfg: a room setting (every write stores a string).
 *  @typedef {{ k: string, v: string }} CfgRow */
/** tf: one tool fetch.
 *  @typedef {{ ts: number, url: string | null }} TfRow */
/** md: one message's media of one kind - an R2 object, or an upload in
 *  flight while upload_id is set (part_size, fp, began and mode belong to
 *  the upload engine's sessions).
 *  @typedef {{ msg: number, kind: string, type: string, r2key: string, size: number, upload_id: string | null, parts: string | null, fp: string | null,
 *    part_size: number | null, name: string | null, began: number | null, mode: string | null }} MdRow */
/** upp: a part R2 has acknowledged, for an upload in flight.
 *  @typedef {{ msg: number, kind: string, n: number, etag: string }} UppRow */
/** ut: an upload ticket (only its SHA-256, h, is kept).
 *  @typedef {{ h: string, msg: number, kind: string, member: string, created: number, expires: number, max_bytes: number, used: number | null,
 *    tries: number, owner: number | null, sess: number | null }} UtRow */
/** push: a member's Web Push subscription.
 *  @typedef {{ member: string, endpoint: string, p256dh: string, auth: string, ts: number, mode: string | null }} PushRow */
/** mv: a member's voice (name lowercased).
 *  @typedef {{ name: string, provider: string | null, voice_id: string | null, sample_key: string | null, sample_type: string | null,
 *    sample_ts: number | null, ts: number | null }} MvRow */
/** gm: a match of any game; state is its JSON.
 *  @typedef {{ id: number, status: import("@chat/contract").GameStatus, created: number, created_by: string, card_msg: number | null, state: string }} GmRow */
/** con: a constitution version.
 *  @typedef {{ v: number, ts: number, editor: string, text: string }} ConRow */
/** oq: an open question.
 *  @typedef {{ id: number, ts: number, added_by: string, text: string, status: import("@chat/contract").QuestionStatus, claimed_by: string | null,
 *    resolved_by: string | null, resolution: string | null, updated: number }} OqRow */
/** dg: a digest.
 *  @typedef {{ id: number, ts: number, day: string, author: string, text: string }} DgRow */
/** sk: a stake.
 *  @typedef {{ id: number, ts: number, added_by: string, title: string, date: string | null, note: string | null, done: number | null,
 *    done_by: string | null, updated: number }} SkRow */
/** dc: a decision; signers is a JSON list of names.
 *  @typedef {{ id: number, ts: number, added_by: string, title: string, note: string | null, signers: string, updated: number }} DcRow */
/** A COUNT(*) AS n query's row.
 *  @typedef {{ n: number }} CountRow */
/** A live stream subscriber (fetch): the filter it asked for, the state
 *  block it was last sent, and how to write to it or end it.
 *  @typedef {{ token: string, owner: boolean, name: string, kinds: Set<string> | null, games: Set<number> | null, stateSub: boolean,
 *    stateKey: string | null, send: (s: string) => void, close: () => void }} StreamClient */

export class Room extends DurableObject {
  /**
   * @param {DurableObjectState} ctx
   * @param {Env} env
   */
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    /** @type {Set<() => void>} long-polls waiting for the next change */
    this.waiters = new Set();
    /** @type {Set<StreamClient>} */
    this.clients = new Set();
    /** @type {number | null} the stream keep-alive interval */
    this.pinger = null;
    // A room has storage only once the owner creates it, so touching an unknown name must not write anything.
    this.ready = this.sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'm'").toArray().length > 0;
    if (this.ready) this.ensureSchema();
  }

  // Creates the room's tables, and adds columns introduced since it was created.
  ensureSchema() {
    this.sql.exec("CREATE TABLE IF NOT EXISTS m (id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, sender TEXT NOT NULL, text TEXT NOT NULL)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS rx (msg INTEGER NOT NULL, emoji TEXT NOT NULL, who TEXT NOT NULL, ts INTEGER NOT NULL)");
    this.sql.exec("CREATE INDEX IF NOT EXISTS rx_msg ON rx (msg)");
    // The in-room Claude bot was retired (2026-11-12); its per-room reply
    // counter table is dropped wherever it still exists.
    this.sql.exec("DROP TABLE IF EXISTS b");
    this.sql.exec("CREATE TABLE IF NOT EXISTS inv (token TEXT PRIMARY KEY, name TEXT NOT NULL, created INTEGER NOT NULL, revoked INTEGER)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS cfg (k TEXT PRIMARY KEY, v TEXT)");
    try { this.sql.exec("ALTER TABLE inv ADD COLUMN seen INTEGER"); } catch (e) {}
    try { this.sql.exec("ALTER TABLE inv ADD COLUMN kind TEXT"); } catch (e) {}
    try { this.sql.exec("ALTER TABLE inv ADD COLUMN invited_by TEXT"); } catch (e) {}
    // Avatars live in R2 only (phase D, finished 2026-11-19: every room was
    // checked and held no blob), so the blob-era column goes wherever it
    // still exists.
    try { this.sql.exec("ALTER TABLE inv DROP COLUMN avatar"); } catch (e) {}
    try { this.sql.exec("ALTER TABLE inv ADD COLUMN avatar_type TEXT"); } catch (e) {}
    try { this.sql.exec("ALTER TABLE inv ADD COLUMN avatar_ver INTEGER"); } catch (e) {}
    try { this.sql.exec("ALTER TABLE inv ADD COLUMN avatar_key TEXT"); } catch (e) {}
    this.sql.exec("CREATE TABLE IF NOT EXISTS tf (ts INTEGER NOT NULL)");
    try { this.sql.exec("ALTER TABLE tf ADD COLUMN url TEXT"); } catch (e) {}
    // The legacy in-DB media stores are gone (media plan phase B, 2026-11-11):
    // every room was drained to R2 through the owner migrate/purge runs before
    // this shipped, so the tables are dropped wherever they still exist.
    this.sql.exec("DROP TABLE IF EXISTS au");
    this.sql.exec("DROP TABLE IF EXISTS im");
    this.sql.exec("CREATE TABLE IF NOT EXISTS md (msg INTEGER NOT NULL, kind TEXT NOT NULL, type TEXT NOT NULL, r2key TEXT, size INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (msg, kind))");
    try { this.sql.exec("ALTER TABLE md ADD COLUMN upload_id TEXT"); } catch (e) {}
    try { this.sql.exec("ALTER TABLE md ADD COLUMN parts TEXT"); } catch (e) {}
    // Upload receipts: one row per part R2 has acknowledged, for every
    // kind (the upload engine). It replaces mdp, the video-only table,
    // whose rows move over the first time a room wakes on this code.
    this.sql.exec("CREATE TABLE IF NOT EXISTS upp (msg INTEGER NOT NULL, kind TEXT NOT NULL, n INTEGER NOT NULL, etag TEXT NOT NULL, PRIMARY KEY (msg, kind, n))");
    if (this.sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'mdp'").toArray().length) {
      this.sql.exec("INSERT OR IGNORE INTO upp (msg, kind, n, etag) SELECT msg, 'video', n, etag FROM mdp");
      this.sql.exec("DROP TABLE mdp");
    }
    // Upload tickets (media plan phase C, 2026-11-11): begin_upload mints a
    // single-use, 15-minute ticket so a client that cannot present the invite
    // token (an agent whose token lives in its gateway) can still PUT bytes.
    // Only the ticket's SHA-256 is stored; the raw ticket exists solely in the
    // begin_upload response and the PUT URL it authorizes.
    this.sql.exec("CREATE TABLE IF NOT EXISTS ut (h TEXT PRIMARY KEY, msg INTEGER NOT NULL, kind TEXT NOT NULL, member TEXT NOT NULL, created INTEGER NOT NULL, expires INTEGER NOT NULL, max_bytes INTEGER NOT NULL, used INTEGER, tries INTEGER NOT NULL DEFAULT 0)");
    // owner: minted with the owner key, for a draft posted under any name
    try { this.sql.exec("ALTER TABLE ut ADD COLUMN owner INTEGER"); } catch (e) {}
    // sess: a resumable upload link (the engine), good for the whole upload
    try { this.sql.exec("ALTER TABLE ut ADD COLUMN sess INTEGER"); } catch (e) {}
    try { this.sql.exec("ALTER TABLE m ADD COLUMN draft INTEGER"); } catch (e) {}
    try { this.sql.exec("ALTER TABLE m ADD COLUMN pubauto INTEGER"); } catch (e) {}
    try { this.sql.exec("ALTER TABLE m ADD COLUMN pub_ts INTEGER"); } catch (e) {}
    // owntrust records whether a post carried the owner key. Nothing reads it
    // since the in-room bot was retired; it stays as provenance.
    try { this.sql.exec("ALTER TABLE m ADD COLUMN owntrust INTEGER"); } catch (e) {}
    try { this.sql.exec("ALTER TABLE md ADD COLUMN fp TEXT"); } catch (e) {}
    try { this.sql.exec("ALTER TABLE md ADD COLUMN part_size INTEGER"); } catch (e) {}
    // The upload engine: the file's name (a file's download name) and when
    // its upload began (R2 keeps an unfinished upload 7 days from then).
    try { this.sql.exec("ALTER TABLE md ADD COLUMN name TEXT"); } catch (e) {}
    try { this.sql.exec("ALTER TABLE md ADD COLUMN began INTEGER"); } catch (e) {}
    // "direct": the session's parts go straight to R2 (Phase 2)
    try { this.sql.exec("ALTER TABLE md ADD COLUMN mode TEXT"); } catch (e) {}
    try { this.sql.exec("ALTER TABLE m ADD COLUMN audio_type TEXT"); } catch (e) {}
    try { this.sql.exec("ALTER TABLE m ADD COLUMN audio_size INTEGER"); } catch (e) {}
    try { this.sql.exec("ALTER TABLE m ADD COLUMN audio_transcript TEXT"); } catch (e) {}
    try { this.sql.exec("ALTER TABLE m ADD COLUMN image_type TEXT"); } catch (e) {}
    try { this.sql.exec("ALTER TABLE m ADD COLUMN image_size INTEGER"); } catch (e) {}
    try { this.sql.exec("ALTER TABLE m ADD COLUMN video_type TEXT"); } catch (e) {}
    try { this.sql.exec("ALTER TABLE m ADD COLUMN video_size INTEGER"); } catch (e) {}
    try { this.sql.exec("ALTER TABLE m ADD COLUMN html_type TEXT"); } catch (e) {}
    try { this.sql.exec("ALTER TABLE m ADD COLUMN html_size INTEGER"); } catch (e) {}
    try { this.sql.exec("ALTER TABLE m ADD COLUMN html_name TEXT"); } catch (e) {}
    try { this.sql.exec("ALTER TABLE m ADD COLUMN doc_type TEXT"); } catch (e) {}
    try { this.sql.exec("ALTER TABLE m ADD COLUMN doc_size INTEGER"); } catch (e) {}
    try { this.sql.exec("ALTER TABLE m ADD COLUMN doc_name TEXT"); } catch (e) {}
    // A general file of any type (the upload engine's kind "file").
    try { this.sql.exec("ALTER TABLE m ADD COLUMN file_type TEXT"); } catch (e) {}
    try { this.sql.exec("ALTER TABLE m ADD COLUMN file_size INTEGER"); } catch (e) {}
    try { this.sql.exec("ALTER TABLE m ADD COLUMN file_name TEXT"); } catch (e) {}
    try { this.sql.exec("ALTER TABLE m ADD COLUMN game_id INTEGER"); } catch (e) {}
    this.sql.exec("CREATE TABLE IF NOT EXISTS push (member TEXT NOT NULL, endpoint TEXT PRIMARY KEY, p256dh TEXT NOT NULL, auth TEXT NOT NULL, ts INTEGER NOT NULL)");
    try { this.sql.exec("ALTER TABLE push ADD COLUMN mode TEXT DEFAULT 'all'"); } catch (e) {}
    // The Android app's device-token table, dropped with the app (2026-11-20).
    this.sql.exec("DROP TABLE IF EXISTS pushdev");
    this.sql.exec("CREATE TABLE IF NOT EXISTS mv (name TEXT PRIMARY KEY, provider TEXT, voice_id TEXT, sample_key TEXT, sample_type TEXT, sample_ts INTEGER, ts INTEGER)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS gm (id INTEGER PRIMARY KEY, status TEXT NOT NULL, created INTEGER NOT NULL, created_by TEXT NOT NULL, card_msg INTEGER, state TEXT NOT NULL)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS con (v INTEGER PRIMARY KEY, ts INTEGER NOT NULL, editor TEXT NOT NULL, text TEXT NOT NULL)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS oq (id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, added_by TEXT NOT NULL, text TEXT NOT NULL, status TEXT NOT NULL, claimed_by TEXT, resolved_by TEXT, resolution TEXT, updated INTEGER NOT NULL)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS dg (id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, day TEXT NOT NULL, author TEXT NOT NULL, text TEXT NOT NULL)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS sk (id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, added_by TEXT NOT NULL, title TEXT NOT NULL, date TEXT, note TEXT, done INTEGER, done_by TEXT, updated INTEGER NOT NULL)");

    this.sql.exec("CREATE TABLE IF NOT EXISTS dc (id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, added_by TEXT NOT NULL, title TEXT NOT NULL, note TEXT, signers TEXT NOT NULL, updated INTEGER NOT NULL)");
    // When each invite was first used (added later; fails harmlessly once the column exists).
    try { this.sql.exec("ALTER TABLE inv ADD COLUMN used INTEGER"); } catch (e) {}
    // When each member first posted as a member. Runs once per room, backfilling from the kept history.
    try {
      this.sql.exec("ALTER TABLE inv ADD COLUMN posted INTEGER");
      this.sql.exec("UPDATE inv SET posted = (SELECT MIN(ts) FROM m WHERE lower(m.sender) = lower(inv.name) AND m.ts >= inv.created)");
    } catch (e) {}
  }

  exists() {
    return this.ready;
  }

  create() {
    if (this.ready) return false;
    this.ensureSchema();
    this.ready = true;
    return true;
  }

  // Public creation's critical section: create the room and mint the
  // creator's genesis invite as ONE call. Durable Object calls are
  // serialized, so two racing creates for the same name cannot interleave -
  // the loser is told the room existed and must not roll anything back
  // (the check-then-create version let a loser destroy the winner's room).
  /** @param {string} name */
  createGenesis(name) {
    if (this.ready) return { existed: true };
    this.ensureSchema();
    this.ready = true;
    const inv = this.invite(name, "human", null);
    if (!inv) return { created: true, invite: null };
    return { created: true, invite: inv };
  }

  // Removes the room and all its storage for good. A room with active invites has members, so those must go first.
  /** @param {string} room */
  async destroy(room) {
    if (!this.ready) return { error: "No room with that name", status: 404 };
    if (/** @type {CountRow} */ (this.sql.exec("SELECT COUNT(*) AS n FROM inv WHERE revoked IS NULL").one()).n) return { error: "This room has active invites. Remove them first with DELETE /api/rooms/" + room + "/invites.", status: 409 };
    await this.activityLog(room, "room deleted with the owner key");
    this.ready = false;
    for (const c of Array.from(this.clients)) c.close();
    if (this.pinger) { clearInterval(this.pinger); this.pinger = null; }
    const ws = this.waiters;
    this.waiters = new Set();
    for (const w of ws) w();
    // Everything in R2 goes too: message media and voice samples. Deleting
    // only the object store would orphan them in the bucket forever, voice
    // samples included, while the API promises the room is gone for good.
    try {
      const keys = /** @type {Pick<MdRow, "r2key">[]} */ (this.sql.exec("SELECT r2key FROM md WHERE r2key IS NOT NULL").toArray()).map((r) => r.r2key);
      for (const v of /** @type {{ sample_key: string }[]} */ (this.sql.exec("SELECT sample_key FROM mv WHERE sample_key IS NOT NULL").toArray())) keys.push(v.sample_key);
      for (const v of /** @type {{ avatar_key: string }[]} */ (this.sql.exec("SELECT avatar_key FROM inv WHERE avatar_key IS NOT NULL").toArray())) keys.push(v.avatar_key);
      // Sketch & Guess drawings: their keys live in each match's state
      for (const v of /** @type {Pick<GmRow, "state">[]} */ (this.sql.exec("SELECT state FROM gm").toArray())) {
        try {
          const st = JSON.parse(v.state || "{}");
          if (st.type === "sketch") for (const im of /** @type {Array<{ key?: string } | null>} */ (Object.values(st.images || {}))) if (im && im.key) keys.push(im.key);
        } catch (e) {}
      }
      // Abort any in-flight multipart sessions so their parts die too
      // (same pattern as deleteMessage: the md row carries key + upload id).
      for (const md of /** @type {{ r2key: string, upload_id: string }[]} */ (this.sql.exec("SELECT r2key, upload_id FROM md WHERE upload_id IS NOT NULL").toArray())) {
        try { await this.env.MEDIA.resumeMultipartUpload(md.r2key, md.upload_id).abort(); } catch (e) {}
      }
      for (const k of keys) { try { await this.env.MEDIA.delete(k); } catch (e) {} }
    } catch (e) {}
    await this.ctx.storage.deleteAll();
    // In-memory caches of what was just deleted: a room recreated under the
    // same name in this instance's lifetime must not sign with the old key
    // or skip its draft sweep.
    /** @type {Uint8Array | null} the media signing key, once read (mediaSigKeyBytes) */
    this._sigBytes = null;
    /** when sweepDrafts last ran */
    this._sweptAt = 0;
    return { deleted: true };
  }

  // Activity log in KV ("log:" keys, kept 7 days), readable through the
  // Cloudflare API: room deletions and push errors.
  /**
   * @param {string | null | undefined} room
   * @param {string} text
   */
  async activityLog(room, text) {
    try {
      const key = "log:" + new Date().toISOString() + ":" + Math.random().toString(36).slice(2, 6);
      await this.env.REQUESTS.put(key, room + " | " + text, { expirationTtl: 604800 });
    } catch (e) {}
  }

  // Access: every room is invite-only (product decision, 2026-11-07):
  // reading, streaming and posting always need a valid invite or the owner key.
  /**
   * @param {string | null | undefined} token
   * @param {boolean} owner
   */
  access(token, owner) {
    if (owner) return { ok: true };
    if (!token) return { ok: false, status: 401, error: "This room is invite-only. Open your invite link to join." };
    const row = /** @type {Pick<InvRow, "name" | "revoked" | "used" | "seen" | "kind">[]} */ (this.sql.exec("SELECT name, revoked, used, seen, kind FROM inv WHERE token = ?", token).toArray())[0];
    if (!row) return { ok: false, status: 403, error: "This invite link isn't valid for this room." };
    if (row.revoked) return { ok: false, status: 403, error: "This invite link has been revoked. Ask the room owner for a new one." };
    const now = Date.now();
    if (!row.used) this.sql.exec("UPDATE inv SET used = ? WHERE token = ?", now, token);
    if (!row.seen || now - row.seen > 60000) this.sql.exec("UPDATE inv SET seen = ? WHERE token = ?", now, token);
    return { ok: true, name: row.name, kind: row.kind === "human" ? "human" : "agent" };
  }

  // The deadline, firing: advance every running match that is due (the
  // same catch-up a read performs, Referee result post included), then
  // re-arm for the next deadline. This is what lets a match run to its
  // finish overnight with nobody reading it.
  async alarm() {
    let saved = "";
    try { const r = /** @type {Pick<CfgRow, "v">[]} */ (this.sql.exec("SELECT v FROM cfg WHERE k = 'room_name'").toArray())[0]; saved = r ? String(r.v || "") : ""; } catch (e) {}
    /** @type {string} */
    const room = this.roomName || (this.ctx.id && this.ctx.id.name) || saved || "";
    if (room && !this.roomName) this.roomName = room;
    // One match's bad state must not stop every clock in the room:
    // advance each match under its own try/catch, and re-arm in a
    // finally - the old loop let a single throw skip the re-arm, so
    // no match had a clock until somebody happened to read one
    // (games review, 2026-11-12).
    try {
      const rows = /** @type {Pick<GmRow, "id">[]} */ (this.sql.exec("SELECT id FROM gm WHERE status IN ('running', 'lobby')").toArray());
      for (const r of rows) {
        try {
          const g = this.gameRow(r.id);
          const eng = g && g.status === "running" ? gameEngine(g.st) : null;
          // an engine with async clock work (Sketch & Guess's Referee) is
          // awaited here; the read paths only ever run the sync part
          // eng is set only for a running match, so g is too
          if (eng && eng.advanceAsync) await eng.advanceAsync(this, /** @type {import("./games.js").GameRow} */ (g), room);
          else if (g && g.status === "running") this.advanceGame(g, room);
          else if (g && g.status === "lobby") this.advanceLobby(g, room);
        } catch (e) {
          console.error("alarm: advancing match " + r.id + " failed: " + (e && /** @type {Error} */ (e).message ? /** @type {Error} */ (e).message : e));
        }
      }
    } finally {
      await this.armGameAlarm();
    }
  }

  // Server-Sent Events stream. Called by the Worker with ?room=NAME&after=ID|latest
  /** @param {Request} request */
  async fetch(request) {
    const url = new URL(request.url);
    const room = /** @type {string} */ (url.searchParams.get("room")); // the stream route always sends room=
    this.roomName = room;
    const a = url.searchParams.get("after");
    const after = a === "latest" ? null : Math.max(0, parseInt(/** @type {string} */ (a), 10) || 0); // the stream route always sends after=
    // Subscription filter: ?events=message,game (or all) narrows the frame
    // kinds; ?game=1,2 restricts game frames to those matches. Both are
    // validated here, before the stream opens, so a bad subscription fails
    // fast instead of silently starving.
    const STREAM_KINDS = ["message", "reaction", "game", "members", "state"];
    /** @type {Set<string> | null} */
    let kinds = null;
    const evRaw = (url.searchParams.get("events") || "").trim().toLowerCase();
    // state is opt-in only: naming it anywhere in events= subscribes, and
    // "all" (or no events= at all) does not - see the note at streamWants.
    const wantsState = evRaw.split(",").map((x) => x.trim()).indexOf("state") >= 0;
    if (evRaw) {
      kinds = new Set();
      for (const part of evRaw.split(",")) {
        const k = part.trim();
        if (!k) continue;
        if (k === "all") { kinds = null; break; }
        if (STREAM_KINDS.indexOf(k) < 0) return new Response(JSON.stringify({ error: "unknown stream event kind: " + k + " (valid: message, reaction, game, members, state, all)" }), { status: 400, headers: { "Content-Type": "application/json" } });
        kinds.add(k);
      }
      if (kinds && !kinds.size) kinds = null;
    }
    /** @type {Set<number> | null} */
    let games = null;
    const gRaw = (url.searchParams.get("game") || "").trim();
    if (gRaw) {
      games = new Set();
      for (const part of gRaw.split(",")) {
        const t = part.trim();
        const n = parseInt(t, 10);
        if (!t || String(n) !== t || n <= 0) return new Response(JSON.stringify({ error: "game must be a comma list of game ids" }), { status: 400, headers: { "Content-Type": "application/json" } });
        games.add(n);
      }
      if (!games.size) games = null;
    }
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const enc = new TextEncoder();
    // send and close are attached next
    const client = /** @type {StreamClient} */ ({ token: url.searchParams.get("token") || "", owner: url.searchParams.get("owner") === "1", name: url.searchParams.get("name") || "", kinds: kinds, games: games, stateSub: wantsState, stateKey: /** @type {string | null} */ (null) });
    client.send = (s) => {
      writer.write(enc.encode(s)).catch(() => this.clients.delete(client));
    };
    client.close = () => {
      this.clients.delete(client);
      writer.close().catch(() => {});
    };
    client.send("retry: 2000\n\n");
    if (after !== null && streamWants(client, "message")) {
      const backlog = this.read(after, KEEP);
      for (const m of backlog) client.send(sseFrame(room, m));
    }
    this.clients.add(client);
    if (client.stateSub) {
      // One initial snapshot, so a fresh subscriber starts current without
      // waiting for the next change; later frames fire only on change.
      const s = renderRoomState(this.stateData(), client.name, room);
      client.stateKey = JSON.stringify(s);
      client.send(stateFrame(room, s));
    }
    if (!this.pinger) {
      this.pinger = setInterval(() => {
        for (const c of this.clients) c.send(": ping\n\n");
        // Time alone moves state (a stake entering its window, the digest
        // deadline passing): re-check on the ping cadence so subscribers
        // see those transitions without any room activity.
        try { this.emitState(); } catch (e) {}
        // this runs only while its interval is set, so pinger holds its id
        if (!this.clients.size) { clearInterval(/** @type {number} */ (this.pinger)); this.pinger = null; }
      }, 15000);
    }
    return new Response(readable, { headers: SSE_HEADERS });
  }

}

// Every other area's methods, installed on the class (games first, as before).
Object.assign(Room.prototype, FourInARowMethods);
Object.assign(Room.prototype, TrustMethods);
Object.assign(Room.prototype, AuctionMethods);
Object.assign(Room.prototype, FrontlinesMethods);
Object.assign(Room.prototype, CodeRaceMethods);
Object.assign(Room.prototype, LiarsDiceMethods);
Object.assign(Room.prototype, TwoTruthsMethods);
Object.assign(Room.prototype, TriviaMethods);
Object.assign(Room.prototype, SketchMethods);
Object.assign(Room.prototype, CorpseMethods);
Object.assign(Room.prototype, WerewolfMethods);
Object.assign(Room.prototype, TwentyMethods);
Object.assign(Room.prototype, LetterGridMethods);
Object.assign(Room.prototype, DuelMethods);
Object.assign(Room.prototype, LightCyclesMethods);
Object.assign(Room.prototype, BattleshipMethods);
Object.assign(Room.prototype, MemberMethods);
Object.assign(Room.prototype, VoiceMethods);
Object.assign(Room.prototype, MediaMethods);
Object.assign(Room.prototype, UploadMethods);
Object.assign(Room.prototype, PushMethods);
Object.assign(Room.prototype, BoardMethods);
Object.assign(Room.prototype, StateMethods);
Object.assign(Room.prototype, MessageMethods);
Object.assign(Room.prototype, LightCyclesTickMethods);
Object.assign(Room.prototype, GameMachineryMethods);
Object.assign(Room.prototype, TestHookMethods);
