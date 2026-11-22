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
import { TestHookMethods, withR2Delay } from "./test-hooks.js";
import type { GameStatus, QuestionStatus } from "@chat/contract";
import type { GameRow } from "./games.js";
import { warn } from "../lib/log.js";

/* ---------- storage rows ----------
   One type per table: the columns ensureSchema creates. A column is
   nullable where the code can leave it NULL (a later ALTER, an optional
   field, a state such as revoked); columns every write fills are not.
   A query casts its rows to its table's row, or to a Pick of it for a
   column list, once. */
/** m: one message (draft until published). */
export type MsgRow = { id: number, ts: number, sender: string, text: string, draft: number | null, pubauto: number | null, pub_ts: number | null, owntrust: number | null,
  audio_type: string | null, audio_size: number | null, audio_transcript: string | null, image_type: string | null, image_size: number | null,
  video_type: string | null, video_size: number | null, html_type: string | null, html_size: number | null, html_name: string | null,
  doc_type: string | null, doc_size: number | null, doc_name: string | null, file_type: string | null, file_size: number | null, file_name: string | null,
  game_id: number | null };
/** rx: one member's reaction to a message. */
export type RxRow = { msg: number, emoji: string, who: string, ts: number };
/** inv: an invite, and the member it names. */
export type InvRow = { token: string, name: string, created: number, revoked: number | null, used: number | null, seen: number | null, kind: string | null,
  invited_by: string | null, posted: number | null, avatar_type: string | null, avatar_ver: number | null, avatar_key: string | null };
/** cfg: a room setting (every write stores a string). */
/** What the invite lookup reads from an inv row. */
export type InviteCols = Pick<InvRow, "name" | "revoked" | "used" | "seen" | "kind" | "invited_by" | "created" | "posted">;
/** A refused credential: the status, its code and its sentence. */
export type Refusal = { ok: false, status: number, code: string, error: string };
export type InviteLookup = { ok: true, row: InviteCols } | Refusal;
/** Who a credential is: the owner key (no name), or an invite's member. */
export type Access =
  | { ok: true, name?: undefined, kind?: undefined, invited_by?: undefined, invited?: undefined, joined?: undefined, posted?: undefined }
  | { ok: true, name: string, kind: "human" | "agent", invited_by: string | null, invited: number, joined: number, posted: boolean };
/** An invite seen without opening it. status is an open set: unused and
 *  active today, more later. */
export type InvitePreview = {
  ok: true,
  invite: { name: string, kind: "human" | "agent", status: string, invited_by: string | null, invited: number, joined: number | null },
  /** the start of the room's constitution, or null */
  purpose: string | null,
  /** the members who have opened their invites */
  members: { name: string, kind: "human" | "agent" }[],
  opened: boolean,
};
export type CfgRow = { k: string, v: string };
/** tf: one tool fetch. */
export type TfRow = { ts: number, url: string | null };
/** md: one message's media of one kind - an R2 object, or an upload in
 *  flight while upload_id is set (part_size, fp, began and mode belong to
 *  the upload engine's sessions). */
export type MdRow = { msg: number, kind: string, type: string, r2key: string, size: number, upload_id: string | null, parts: string | null, fp: string | null,
  part_size: number | null, name: string | null, began: number | null, mode: string | null };
/** upp: a part R2 has acknowledged, for an upload in flight. */
export type UppRow = { msg: number, kind: string, n: number, etag: string };
/** ut: an upload ticket (only its SHA-256, h, is kept). */
export type UtRow = { h: string, msg: number, kind: string, member: string, created: number, expires: number, max_bytes: number, used: number | null,
  tries: number, owner: number | null, sess: number | null };
/** push: a member's Web Push subscription. */
export type PushRow = { member: string, endpoint: string, p256dh: string, auth: string, ts: number, mode: string | null };
/** mv: a member's voice (name lowercased). */
export type MvRow = { name: string, provider: string | null, voice_id: string | null, sample_key: string | null, sample_type: string | null,
  sample_ts: number | null, ts: number | null };
/** gm: a match of any game; state is its JSON. */
export type GmRow = { id: number, status: GameStatus, created: number, created_by: string, card_msg: number | null, state: string };
/** con: a constitution version. */
export type ConRow = { v: number, ts: number, editor: string, text: string };
/** oq: an open question. */
export type OqRow = { id: number, ts: number, added_by: string, text: string, status: QuestionStatus, claimed_by: string | null,
  resolved_by: string | null, resolution: string | null, updated: number };
/** dg: a digest. */
export type DgRow = { id: number, ts: number, day: string, author: string, text: string };
/** sk: a stake. */
export type SkRow = { id: number, ts: number, added_by: string, title: string, date: string | null, note: string | null, done: number | null,
  done_by: string | null, updated: number };
/** dc: a decision; signers is a JSON list of names. */
export type DcRow = { id: number, ts: number, added_by: string, title: string, note: string | null, signers: string, updated: number };
/** A COUNT(*) AS n query's row. */
export type CountRow = { n: number };
/** A live stream subscriber (fetch): the filter it asked for, the state
 *  block it was last sent, and how to write to it or end it. */
export type StreamClient = { token: string, owner: boolean, name: string, kinds: Set<string> | null, games: Set<number> | null, stateSub: boolean,
  stateKey: string | null, send: (s: string) => void, close: () => void };

/* ---------- the schema, as versioned steps ----------
   Each step runs once per room (Room.ensureSchema counts them in cfg
   "schema_version"). Add a change as a new step at the end; never edit a
   step that has shipped - a room that ran it will not run it again.

   Step 1 is the baseline: the whole schema as it stood when versioning
   began (2026-11-22). Every room built before then had run some older
   version of it on each start, so it brings a room of any older shape to
   today's: each column is added only if missing, each dropped only if
   present (read from PRAGMA table_info, not by letting an ALTER fail). */

/** A table's column names. */
function columnsOf(sql: SqlStorage, table: string): Set<string> {
  return new Set(sql.exec<{ name: string }>("SELECT name FROM pragma_table_info(?)", table).toArray().map((r) => r.name));
}
/** Adds a column unless the table has it; true when it was added. */
function addColumn(sql: SqlStorage, table: string, column: string, decl: string): boolean {
  if (columnsOf(sql, table).has(column)) return false;
  sql.exec("ALTER TABLE " + table + " ADD COLUMN " + column + " " + decl);
  return true;
}
/** Drops a column if the table still has it. */
function dropColumn(sql: SqlStorage, table: string, column: string): void {
  if (columnsOf(sql, table).has(column)) sql.exec("ALTER TABLE " + table + " DROP COLUMN " + column);
}

function schemaBaseline(sql: SqlStorage): void {
  sql.exec("CREATE TABLE IF NOT EXISTS m (id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, sender TEXT NOT NULL, text TEXT NOT NULL)");
  sql.exec("CREATE TABLE IF NOT EXISTS rx (msg INTEGER NOT NULL, emoji TEXT NOT NULL, who TEXT NOT NULL, ts INTEGER NOT NULL)");
  sql.exec("CREATE INDEX IF NOT EXISTS rx_msg ON rx (msg)");
  // The in-room Claude bot is gone; its per-room reply counter table is
  // dropped wherever it still exists.
  sql.exec("DROP TABLE IF EXISTS b");
  sql.exec("CREATE TABLE IF NOT EXISTS inv (token TEXT PRIMARY KEY, name TEXT NOT NULL, created INTEGER NOT NULL, revoked INTEGER)");
  sql.exec("CREATE TABLE IF NOT EXISTS cfg (k TEXT PRIMARY KEY, v TEXT)");
  addColumn(sql, "inv", "seen", "INTEGER");
  addColumn(sql, "inv", "kind", "TEXT");
  addColumn(sql, "inv", "invited_by", "TEXT");
  // Avatars live in R2 only (every room was checked and held no blob), so
  // the blob-era column goes wherever it still exists.
  dropColumn(sql, "inv", "avatar");
  addColumn(sql, "inv", "avatar_type", "TEXT");
  addColumn(sql, "inv", "avatar_ver", "INTEGER");
  addColumn(sql, "inv", "avatar_key", "TEXT");
  sql.exec("CREATE TABLE IF NOT EXISTS tf (ts INTEGER NOT NULL)");
  addColumn(sql, "tf", "url", "TEXT");
  // The in-DB media stores are gone: every room was drained to R2 before
  // this shipped, so the tables are dropped wherever they still exist.
  sql.exec("DROP TABLE IF EXISTS au");
  sql.exec("DROP TABLE IF EXISTS im");
  sql.exec("CREATE TABLE IF NOT EXISTS md (msg INTEGER NOT NULL, kind TEXT NOT NULL, type TEXT NOT NULL, r2key TEXT, size INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (msg, kind))");
  addColumn(sql, "md", "upload_id", "TEXT");
  addColumn(sql, "md", "parts", "TEXT");
  // Upload receipts: one row per part R2 has acknowledged, for every
  // kind (the upload engine). It replaces mdp, the video-only table,
  // whose rows move over the first time a room wakes on this code.
  sql.exec("CREATE TABLE IF NOT EXISTS upp (msg INTEGER NOT NULL, kind TEXT NOT NULL, n INTEGER NOT NULL, etag TEXT NOT NULL, PRIMARY KEY (msg, kind, n))");
  if (sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'mdp'").toArray().length) {
    sql.exec("INSERT OR IGNORE INTO upp (msg, kind, n, etag) SELECT msg, 'video', n, etag FROM mdp");
    sql.exec("DROP TABLE mdp");
  }
  // Upload tickets: begin_upload mints a single-use, 15-minute ticket so a
  // client that cannot present the invite token (an agent whose token lives
  // in its gateway) can still PUT bytes.
  // Only the ticket's SHA-256 is stored; the raw ticket exists solely in the
  // begin_upload response and the PUT URL it authorizes.
  sql.exec("CREATE TABLE IF NOT EXISTS ut (h TEXT PRIMARY KEY, msg INTEGER NOT NULL, kind TEXT NOT NULL, member TEXT NOT NULL, created INTEGER NOT NULL, expires INTEGER NOT NULL, max_bytes INTEGER NOT NULL, used INTEGER, tries INTEGER NOT NULL DEFAULT 0)");
  // owner: minted with the owner key, for a draft posted under any name
  addColumn(sql, "ut", "owner", "INTEGER");
  // sess: a resumable upload link (the engine), good for the whole upload
  addColumn(sql, "ut", "sess", "INTEGER");
  addColumn(sql, "m", "draft", "INTEGER");
  addColumn(sql, "m", "pubauto", "INTEGER");
  addColumn(sql, "m", "pub_ts", "INTEGER");
  // owntrust records whether a post carried the owner key. Nothing reads
  // it; it stays as provenance.
  addColumn(sql, "m", "owntrust", "INTEGER");
  addColumn(sql, "md", "fp", "TEXT");
  addColumn(sql, "md", "part_size", "INTEGER");
  // The upload engine: the file's name (a file's download name) and when
  // its upload began (R2 keeps an unfinished upload 7 days from then).
  addColumn(sql, "md", "name", "TEXT");
  addColumn(sql, "md", "began", "INTEGER");
  // "direct": the session's parts go straight to R2
  addColumn(sql, "md", "mode", "TEXT");
  addColumn(sql, "m", "audio_type", "TEXT");
  addColumn(sql, "m", "audio_size", "INTEGER");
  addColumn(sql, "m", "audio_transcript", "TEXT");
  addColumn(sql, "m", "image_type", "TEXT");
  addColumn(sql, "m", "image_size", "INTEGER");
  addColumn(sql, "m", "video_type", "TEXT");
  addColumn(sql, "m", "video_size", "INTEGER");
  addColumn(sql, "m", "html_type", "TEXT");
  addColumn(sql, "m", "html_size", "INTEGER");
  addColumn(sql, "m", "html_name", "TEXT");
  addColumn(sql, "m", "doc_type", "TEXT");
  addColumn(sql, "m", "doc_size", "INTEGER");
  addColumn(sql, "m", "doc_name", "TEXT");
  // A general file of any type (the upload engine's kind "file").
  addColumn(sql, "m", "file_type", "TEXT");
  addColumn(sql, "m", "file_size", "INTEGER");
  addColumn(sql, "m", "file_name", "TEXT");
  addColumn(sql, "m", "game_id", "INTEGER");
  sql.exec("CREATE TABLE IF NOT EXISTS push (member TEXT NOT NULL, endpoint TEXT PRIMARY KEY, p256dh TEXT NOT NULL, auth TEXT NOT NULL, ts INTEGER NOT NULL)");
  addColumn(sql, "push", "mode", "TEXT DEFAULT 'all'");
  // The Android app's device-token table, dropped with the app.
  sql.exec("DROP TABLE IF EXISTS pushdev");
  sql.exec("CREATE TABLE IF NOT EXISTS mv (name TEXT PRIMARY KEY, provider TEXT, voice_id TEXT, sample_key TEXT, sample_type TEXT, sample_ts INTEGER, ts INTEGER)");
  sql.exec("CREATE TABLE IF NOT EXISTS gm (id INTEGER PRIMARY KEY, status TEXT NOT NULL, created INTEGER NOT NULL, created_by TEXT NOT NULL, card_msg INTEGER, state TEXT NOT NULL)");
  sql.exec("CREATE TABLE IF NOT EXISTS con (v INTEGER PRIMARY KEY, ts INTEGER NOT NULL, editor TEXT NOT NULL, text TEXT NOT NULL)");
  sql.exec("CREATE TABLE IF NOT EXISTS oq (id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, added_by TEXT NOT NULL, text TEXT NOT NULL, status TEXT NOT NULL, claimed_by TEXT, resolved_by TEXT, resolution TEXT, updated INTEGER NOT NULL)");
  sql.exec("CREATE TABLE IF NOT EXISTS dg (id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, day TEXT NOT NULL, author TEXT NOT NULL, text TEXT NOT NULL)");
  sql.exec("CREATE TABLE IF NOT EXISTS sk (id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, added_by TEXT NOT NULL, title TEXT NOT NULL, date TEXT, note TEXT, done INTEGER, done_by TEXT, updated INTEGER NOT NULL)");

  sql.exec("CREATE TABLE IF NOT EXISTS dc (id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, added_by TEXT NOT NULL, title TEXT NOT NULL, note TEXT, signers TEXT NOT NULL, updated INTEGER NOT NULL)");
  // When each invite was first used.
  addColumn(sql, "inv", "used", "INTEGER");
  // When each member first posted as a member: the column, then a
  // backfill from the kept history, once (when the column is new).
  if (addColumn(sql, "inv", "posted", "INTEGER")) sql.exec("UPDATE inv SET posted = (SELECT MIN(ts) FROM m WHERE lower(m.sender) = lower(inv.name) AND m.ts >= inv.created)");
}

/** The schema steps, in order (see above). */
const SCHEMA_STEPS: Array<(sql: SqlStorage) => void> = [schemaBaseline];

export class Room extends DurableObject {
  // The instance's fields: declared only (the constructor and the methods
  // set them), so the class carries no field initializers.
  declare sql: SqlStorage;
  /** long-polls waiting for the next change */
  declare waiters: Set<() => void>;
  declare clients: Set<StreamClient>;
  /** the stream keep-alive interval */
  declare pinger: number | null;
  declare ready: boolean;
  /** the media signing key, once read (mediaSigKeyBytes) */
  declare _sigBytes?: Uint8Array | null;
  /** when sweepDrafts last ran */
  declare _sweptAt?: number;
  declare roomName?: string;
  /** test hook: how long each R2 call waits first (withR2Delay) */
  declare testR2DelayMs?: number;
  /** True while destroy() is deleting the room's storage. */
  destroying = false;
  /** Upload links being minted right now, by folded member name (room/uploads.ts, mintUploadTicket). */
  utMinting: Map<string, number> = new Map();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    if (env.TEST_HOOKS) this.env = withR2Delay(env, () => this.testR2DelayMs || 0);
    this.sql = ctx.storage.sql;
    this.waiters = new Set();
    this.clients = new Set();
    this.pinger = null;
    // A room has storage only once the owner creates it, so touching an unknown name must not write anything.
    this.ready = this.sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'm'").toArray().length > 0;
    if (this.ready) this.ensureSchema();
  }

  // The room's schema, versioned: cfg "schema_version" counts the steps
  // of SCHEMA_STEPS (below the class) this room has run, and a start runs
  // only the ones it has not - each step once, in order, its count written
  // only after it succeeds (a step that fails runs again next start).
  ensureSchema() {
    this.sql.exec("CREATE TABLE IF NOT EXISTS cfg (k TEXT PRIMARY KEY, v TEXT)");
    const row = this.sql.exec<Pick<CfgRow, "v">>("SELECT v FROM cfg WHERE k = 'schema_version'").toArray()[0];
    for (let done = row ? Number(row.v) || 0 : 0; done < SCHEMA_STEPS.length; done++) {
      SCHEMA_STEPS[done]!(this.sql);
      this.sql.exec("INSERT OR REPLACE INTO cfg (k, v) VALUES ('schema_version', ?)", String(done + 1));
    }
  }

  exists() {
    return this.ready;
  }

  create() {
    if (this.ready || this.destroying) return false;
    this.ensureSchema();
    this.ready = true;
    return true;
  }

  // Public creation's critical section: create the room and mint the
  // creator's genesis invite as ONE call. Durable Object calls are
  // serialized, so two racing creates for the same name cannot interleave -
  // the loser is told the room existed and must not roll anything back
  // (with a separate check and create, a loser could destroy the winner's
  // room).
  createGenesis(name: string) {
    // a room that is being deleted is not free yet: see destroy()
    if (this.ready || this.destroying) return { existed: true };
    this.ensureSchema();
    this.ready = true;
    const inv = this.invite(name, "human", null);
    // no inviter and no limits here: anything but the new invite means the name was refused
    return { created: true, invite: inv && "token" in inv && inv.token ? inv : null };
  }

  // Removes the room and all its storage for good. A room with active invites has members, so those must go first.
  async destroy(room: string): Promise<{ deleted?: boolean, error?: string, status?: number }> {
    if (!this.ready) return { error: "No room with that name", status: 404 };
    if (this.sql.exec<CountRow>("SELECT COUNT(*) AS n FROM inv WHERE revoked IS NULL").one().n) return { error: "This room has active invites. Remove them first with DELETE /api/rooms/" + room + "/invites.", status: 409 };
    if (this.destroying) return { error: "This room is being deleted", status: 409 };
    // Deleting takes many awaits (one storage call per media object) and
    // other calls run in between them. Until the last one is done the
    // room is neither there (ready) nor free (destroying): a public
    // create that landed in the middle used to get a genesis invite into
    // the old room's messages, and then lost its tables to deleteAll.
    this.destroying = true;
    this.ready = false;
    try {
      return await this.destroyNow(room);
    } finally {
      this.destroying = false;
    }
  }

  private async destroyNow(room: string) {
    await this.activityLog(room, "room deleted with the owner key");
    for (const c of Array.from(this.clients)) c.close();
    if (this.pinger) { clearInterval(this.pinger); this.pinger = null; }
    const ws = this.waiters;
    this.waiters = new Set();
    for (const w of ws) w();
    // Everything in R2 goes too: message media and voice samples. Deleting
    // only the object store would orphan them in the bucket forever, voice
    // samples included, while the API promises the room is gone for good.
    try {
      const keys = this.sql.exec<Pick<MdRow, "r2key">>("SELECT r2key FROM md WHERE r2key IS NOT NULL").toArray().map((r) => r.r2key);
      for (const v of this.sql.exec<{ sample_key: string }>("SELECT sample_key FROM mv WHERE sample_key IS NOT NULL").toArray()) keys.push(v.sample_key);
      for (const v of this.sql.exec<{ avatar_key: string }>("SELECT avatar_key FROM inv WHERE avatar_key IS NOT NULL").toArray()) keys.push(v.avatar_key);
      // Sketch & Guess drawings: their keys live in each match's state
      for (const v of this.sql.exec<Pick<GmRow, "state">>("SELECT state FROM gm").toArray()) {
        try {
          const st = JSON.parse(v.state || "{}");
          if (st.type === "sketch") for (const im of Object.values(st.images || {}) as Array<{ key?: string } | null>) if (im && im.key) keys.push(im.key);
        } catch {
          // an unreadable match has no drawings to find (gameRow logs it)
        }
      }
      // Abort any in-flight multipart sessions so their parts die too
      // (same pattern as deleteMessage: the md row carries key + upload id).
      for (const md of this.sql.exec<{ r2key: string, upload_id: string }>("SELECT r2key, upload_id FROM md WHERE upload_id IS NOT NULL").toArray()) {
        try { await this.env.MEDIA.resumeMultipartUpload(md.r2key, md.upload_id).abort(); } catch { /* already completed, aborted or expired */ }
      }
      let failed = 0, first: unknown = null;
      for (const k of keys) { try { await this.env.MEDIA.delete(k); } catch (e) { failed++; if (!first) first = e; } }
      if (failed) warn("media.delete", first, { room, failed, of: keys.length });
    } catch (e) {
      warn("room.destroy.media", e, { room });
    }
    await this.ctx.storage.deleteAll();
    // In-memory caches of what was just deleted: a room recreated under the
    // same name in this instance's lifetime must not sign with the old key
    // or skip its draft sweep.
    this._sigBytes = null;
    this._sweptAt = 0;
    return { deleted: true };
  }

  // Activity log in KV ("log:" keys, kept 7 days), readable through the
  // Cloudflare API: room deletions and push errors.
  async activityLog(room: string | null | undefined, text: string) {
    try {
      const key = "log:" + new Date().toISOString() + ":" + crypto.randomUUID().slice(0, 4);
      await this.env.REQUESTS.put(key, room + " | " + text, { expirationTtl: 604800 });
    } catch (e) {
      warn("log.write", e, { room });
    }
  }

  // The invite a token names, or the refusal: the one lookup behind
  // access() (which then marks the invite used and seen) and the invite
  // preview (which marks nothing), so their answers cannot drift. Each
  // refusal carries its code beside the sentence (lib/http.ts deny).
  lookupInvite(token: string | null | undefined): InviteLookup {
    if (!token) return { ok: false, status: 401, code: "invite_missing", error: "This room is invite-only. Open your invite link to join." };
    const row = this.sql.exec<InviteCols>("SELECT name, revoked, used, seen, kind, invited_by, created, posted FROM inv WHERE token = ?", token).toArray()[0];
    if (!row) return { ok: false, status: 403, code: "invite_invalid", error: "This invite link isn't valid for this room." };
    if (row.revoked) return { ok: false, status: 403, code: "invite_revoked", error: "This invite link has been revoked. Ask the room owner for a new one." };
    return { ok: true, row: row };
  }

  // Look at an invite without opening it (GET /invite, MCP get_invite):
  // the same lookup and refusals as access(), but nothing is marked used or
  // seen - previewing is not joining, and it never counts as presence.
  previewInvite(token: string | null | undefined): Refusal | InvitePreview {
    const l = this.lookupInvite(token);
    if (!l.ok) return l;
    const r = l.row;
    const con = this.sql.exec<{ text: string }>("SELECT text FROM con ORDER BY v DESC LIMIT 1").toArray()[0];
    const members = this.sql.exec<Pick<InvRow, "name" | "kind">>("SELECT name, kind FROM inv WHERE revoked IS NULL AND used IS NOT NULL ORDER BY created").toArray()
      .map((m) => ({ name: m.name, kind: (m.kind === "human" ? "human" : "agent") as "human" | "agent" }));
    return {
      ok: true,
      invite: { name: r.name, kind: (r.kind === "human" ? "human" : "agent") as "human" | "agent", status: r.used ? "active" : "unused", invited_by: r.invited_by || null, invited: r.created, joined: r.used || null },
      purpose: con && con.text ? con.text.slice(0, 280) : null,
      members: members,
      opened: !!r.used,
    };
  }

  // Access: every room is invite-only:
  // reading, streaming and posting always need a valid invite or the owner key.
  access(token: string | null | undefined, owner: boolean): Access | Refusal {
    if (owner) return { ok: true };
    const l = this.lookupInvite(token);
    if (!l.ok) return l;
    const row = l.row;
    const now = Date.now();
    if (!row.used) this.sql.exec("UPDATE inv SET used = ? WHERE token = ?", now, token);
    if (!row.seen || now - row.seen > 60000) this.sql.exec("UPDATE inv SET seen = ? WHERE token = ?", now, token);
    // who invited them and when, and when they joined (this call, the first time)
    return { ok: true, name: row.name, kind: row.kind === "human" ? "human" : "agent", invited_by: row.invited_by || null, invited: row.created, joined: row.used || now, posted: !!row.posted };
  }

  // The deadline, firing: advance every running match that is due (the
  // same catch-up a read performs, Referee result post included), then
  // re-arm for the next deadline. This is what lets a match run to its
  // finish overnight with nobody reading it.
  async alarm() {
    let saved = "";
    try { const r = this.sql.exec<Pick<CfgRow, "v">>("SELECT v FROM cfg WHERE k = 'room_name'").toArray()[0]; saved = r ? String(r.v || "") : ""; } catch (e) { warn("alarm.name", e); }
    const room: string = this.roomName || (this.ctx.id && this.ctx.id.name) || saved || "";
    if (room && !this.roomName) this.roomName = room;
    // One match's bad state must not stop every clock in the room:
    // advance each match under its own try/catch, and re-arm in a
    // finally, so a single throw cannot leave every match without a
    // clock until somebody happens to read one.
    try {
      const rows = this.sql.exec<Pick<GmRow, "id">>("SELECT id FROM gm WHERE status IN ('running', 'lobby')").toArray();
      for (const r of rows) {
        try {
          const g = this.gameRow(r.id);
          const eng = g && g.status === "running" ? gameEngine(g.st) : null;
          // an engine with async clock work (Sketch & Guess's Referee) is
          // awaited here; the read paths only ever run the sync part
          // eng is set only for a running match, so g is too
          if (eng && eng.advanceAsync) await eng.advanceAsync(this, g as GameRow, room);
          else if (g && g.status === "running") this.advanceGame(g, room);
          else if (g && g.status === "lobby") this.advanceLobby(g, room);
        } catch (e) {
          console.error("alarm: advancing match " + r.id + " failed: " + (e && (e as Error).message ? (e as Error).message : e));
        }
      }
    } finally {
      await this.armGameAlarm();
    }
  }

  // Server-Sent Events stream. Called by the Worker with ?room=NAME&after=ID|latest
  async fetch(request: Request) {
    const url = new URL(request.url);
    const room = url.searchParams.get("room") as string; // the stream route always sends room=
    this.roomName = room;
    const a = url.searchParams.get("after");
    const after = a === "latest" ? null : Math.max(0, parseInt(a as string, 10) || 0); // the stream route always sends after=
    // Subscription filter: ?events=message,game (or all) narrows the frame
    // kinds; ?game=1,2 restricts game frames to those matches. Both are
    // validated here, before the stream opens, so a bad subscription fails
    // fast instead of silently starving.
    const STREAM_KINDS = ["message", "reaction", "game", "members", "state"];
    let kinds: Set<string> | null = null;
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
    let games: Set<number> | null = null;
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
    // Whose stream this is comes from the invite, looked up here: the
    // route checked it in an earlier call, and a revoke between the two
    // had already closed that invite's streams - this one would have
    // opened after it and stayed open, under a name that can be invited
    // again (its room_state frames are that member's private view).
    const isOwner = url.searchParams.get("owner") === "1";
    const token = url.searchParams.get("token") || "";
    let member = "";
    if (!isOwner) {
      const l = this.lookupInvite(token);
      if (!l.ok) return new Response(JSON.stringify({ error: l.error, code: l.code }), { status: l.status, headers: { "Content-Type": "application/json" } });
      member = l.row.name;
    }
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const enc = new TextEncoder();
    // send and close are attached next
    const client = { token: token, owner: isOwner, name: member, kinds: kinds, games: games, stateSub: wantsState, stateKey: null as string | null } as StreamClient;
    client.send = (s) => {
      writer.write(enc.encode(s)).catch(() => this.clients.delete(client));
    };
    client.close = () => {
      this.clients.delete(client);
      writer.close().catch(() => {}); // the stream may have closed already
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
        // revoke() closes an invite's streams as it happens; this closes
        // one whose invite went some way that did not
        try {
          const live = new Set(this.sql.exec<Pick<InvRow, "token">>("SELECT token FROM inv WHERE revoked IS NULL").toArray().map((r) => r.token));
          for (const c of Array.from(this.clients)) if (!c.owner && !live.has(c.token)) c.close();
        } catch (e) { warn("stream.sweep", e, { room: this.roomName }); }
        for (const c of this.clients) c.send(": ping\n\n");
        // Time alone moves state (a stake entering its window, the digest
        // deadline passing): re-check on the ping cadence so subscribers
        // see those transitions without any room activity.
        try { this.emitState(); } catch (e) { warn("state.emit", e, { room: this.roomName }); }
        // this runs only while its interval is set, so pinger holds its id
        if (!this.clients.size) { clearInterval(this.pinger as number); this.pinger = null; }
      }, 15000);
    }
    return new Response(readable, { headers: SSE_HEADERS });
  }

}

// Every other area's methods, installed on the class (games first).
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
