// The Room Durable Object: one per room, SQLite-backed. The class holds the
// core (schema, lifecycle, access, fetch, the alarm); every other area's
// methods live in their own module and are installed on the class at the end
// of this file. The Worker's main module re-exports the class.

import { DurableObject } from "cloudflare:workers";
import { gameEngine } from "../games/engine.js";
import { renderRoomState, stateFrame } from "./state.js";
import { GENESIS_PENDING_MS, STREAM_PING_MS } from "../limits.js";
import { SSE_HEADERS, json } from "../lib/http.js";
import { GONE_MSG, goneError } from "../lib/errors.js";
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
import { BOARD_TABLES, BoardMethods } from "./board.js";
import { StateMethods } from "./state.js";
import { MessageMethods } from "./messages.js";
import { GameMachineryMethods } from "./games.js";
import { MuseMethods } from "./muse.js";
import type { MuseHookView } from "./muse.js";
import { AgentMethods, isIdentity } from "./agent.js";
import { TestHookMethods, withR2Delay } from "./test-hooks.js";
import type { AwaitingItem, GameStatus, QuestionStatus } from "@chat/contract";
import type { GameRow } from "./games.js";
import type { UpFinish } from "./uploads.js";
import { LINK_REFUSED, mediaLinkOk, type MediaLink } from "../lib/media.js";
import { warn } from "../lib/log.js";
import { nameFold } from "../lib/text.js";

/* ---------- storage rows ----------
   One type per table: the columns ensureSchema creates. A column is
   nullable where the code can leave it NULL (a later ALTER, an optional
   field, a state such as revoked); columns every write fills are not.
   A query casts its rows to its table's row, or to a Pick of it for a
   column list, once. */
/** m: one message (draft until published). */
export type MsgRow = { id: number, ts: number, sender: string, text: string, draft: number | null, pubauto: number | null, pub_ts: number | null, owntrust: number | null, seq: number | null,
  audio_type: string | null, audio_size: number | null, audio_transcript: string | null, image_type: string | null, image_size: number | null,
  video_type: string | null, video_size: number | null, html_type: string | null, html_size: number | null, html_name: string | null,
  doc_type: string | null, doc_size: number | null, doc_name: string | null, file_type: string | null, file_size: number | null, file_name: string | null,
  game_id: number | null };
/** mdel: a live message's delete, under its own delivery number (schema step 5). */
export type MdelRow = { dn: number, id: number, ts: number, who: string | null };
/** pcid: a post's client_msg_id (sender lowercased), the message it made,
 *  and whether that post asked to be a draft. */
export type PcidRow = { sender: string, cid: string, msg: number, ts: number, draft: number | null };
/** rx: one member's reaction to a message. */
export type RxRow = { msg: number, emoji: string, who: string, ts: number };
/** inv: an invite, and the member it names. left_ts: when the member left
 *  by itself with this invite (schema step 9; null for any other revoke). */
export type InvRow = { token: string, name: string, created: number, revoked: number | null, used: number | null, seen: number | null, kind: string | null,
  invited_by: string | null, posted: number | null, avatar_type: string | null, avatar_ver: number | null, avatar_key: string | null, left_ts: number | null };
/** cfg: a room setting (every write stores a string). */
/** What the invite lookup reads from an inv row. */
export type InviteCols = Pick<InvRow, "name" | "revoked" | "used" | "seen" | "kind" | "invited_by" | "created" | "posted" | "left_ts">;
/** The refusal of a token whose member left the room with it (403
 *  invite_revoked, as any revoked token: only the sentence differs). */
export const LEFT_MSG = "You left this room with this invite, so it will not work again. A member of the room can invite you anew.";
/** A refused credential: the status, its code and its sentence. */
export type Refusal = { ok: false, status: number, code: string, error: string };
export type InviteLookup = { ok: true, row: InviteCols } | Refusal;
/** The refusal for a request that sent no token: the same everywhere, so
 *  a route can give it without asking the room (MCP's tokenless ping and
 *  initialize, routes/agents.ts). */
export function inviteMissing(): Refusal {
  return { ok: false, status: 401, code: "invite_missing", error: "This room is invite-only. Open your invite link to join." };
}
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
/** What the start page is built from (startView): the preview, and for an
 *  opened invite the member's own posted flag, hook, room_state.awaiting_you
 *  (with its _more count) and what others posted since its latest post. */
export type StartView = InvitePreview & {
  posted: boolean,
  hook: MuseHookView | null,
  awaiting: AwaitingItem[],
  awaiting_more: number,
  since: { after: number, count: number, for_you: number } | null,
};
export type CfgRow = { k: string, v: string };
/** tf: one tool fetch. */
export type TfRow = { ts: number, url: string | null };
/** md: one message's media of one kind - an R2 object, or an upload in
 *  flight while upload_id is set (part_size, fp, began and mode belong to
 *  the upload engine's sessions). */
export type MdRow = { msg: number, kind: string, type: string, r2key: string, size: number, at: number | null, upload_id: string | null, parts: string | null, fp: string | null,
  part_size: number | null, name: string | null, began: number | null, mode: string | null };
/** upp: a part R2 has acknowledged, for an upload in flight. */
export type UppRow = { msg: number, kind: string, n: number, etag: string };
/** ut: an upload ticket (only its SHA-256, h, is kept). */
export type UtRow = { h: string, msg: number, kind: string, member: string, created: number, expires: number, max_bytes: number, used: number | null,
  tries: number, owner: number | null, sess: number | null };
/** push: a member's Web Push subscription. */
export type PushRow = { member: string, endpoint: string, p256dh: string, auth: string, ts: number, mode: string | null,
  fails: number | null, fail_ts: number | null, rest_ts: number | null };
/** mv: a member's voice (name lowercased). */
export type MvRow = { name: string, provider: string | null, voice_id: string | null, sample_key: string | null, sample_type: string | null,
  sample_ts: number | null, ts: number | null };
/** gm: a match of any game; state is its JSON. */
export type GmRow = { id: number, status: GameStatus, created: number, created_by: string, card_msg: number | null, state: string };
/** gr: an ended match's result (schema step 6), what the games list, the
 *  record, the ladder and Duel's head-to-head read in place of the state.
 *  type is the state's as stored (a match from before types carries null:
 *  read it as Light Cycles); winners, places and players are JSON lists
 *  (players: {name, hex}); pair names the two seats (in seat order,
 *  joined with PAIR_SEP) of a 2-seat match; pub is the match's games-list entry, null on
 *  a row the step backfilled until the list first shows it. */
export type GrRow = { id: number, type: string | null, status: GameStatus, ended: number | null, winner: string | null, winners: string | null,
  draw: number | null, places: string | null, players: string, pair: string | null, pub: string | null };
/** con: a constitution version. */
export type ConRow = { v: number, ts: number, editor: string, text: string };
/** oq: an open question. */
export type OqRow = { id: number, ts: number, added_by: string, text: string, status: QuestionStatus, claimed_by: string | null,
  resolved_by: string | null, resolution: string | null, updated: number };
/** dg: a digest. */
/** updated: the last write (schema step 5; null on a digest from before it, read as ts). */
export type DgRow = { id: number, ts: number, day: string, author: string, text: string, updated: number | null };
/** sk: a stake. */
export type SkRow = { id: number, ts: number, added_by: string, title: string, date: string | null, note: string | null, done: number | null,
  done_by: string | null, updated: number };
/** dc: a decision; signers is a JSON list of names. */
export type DcRow = { id: number, ts: number, added_by: string, title: string, note: string | null, signers: string, updated: number };
/** A COUNT(*) AS n query's row. */
export type CountRow = { n: number };
/** ak: an agent key's identity (room/agent.ts), one row in an object no
 *  room name reaches: when it was made, its list's version (one more per
 *  write, compared on every swap), client (empty for an agent key) and the
 *  list of its rooms, sealed (lib/agentkey.ts). */
export type AkRow = { k: number, created: number, ver: number, client: string | null, ring: string };
/** aks: one credential of an identity (a slot): its kind, the verifier of
 *  its secret, the data key wrapped under it, when it was made; expires,
 *  used, bind and next stay empty for an agent key. */
export type AksRow = { slot: string, kind: string, verifier: string, wrapped: string | null, created: number, expires: number | null, used: number | null, bind: string | null, next: string | null };
/** aq: one creation counter of agent keys (AGENT_QUOTA_ROOM): its key (a
 *  network's or a room's hash, or the site's, and the window), the window,
 *  the count. */
export type AqRow = { k: string, w: string, n: number };
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
  if (addColumn(sql, "inv", "posted", "INTEGER")) sql.exec("UPDATE inv SET posted = (SELECT MIN(ts) FROM m WHERE lower(m.sender) = lower(inv.name) AND m.ts >= inv.created)"); // lowercase-ok: a step that has run, kept as it ran
}

// Step 2. md.at: when a media row was last written (an attach, a
// finished upload) - the draft sweep counts a draft's day from it. And an
// index for the live-match lookup that every room_state build and alarm
// re-arm makes: without it each one read the whole match table, which is
// never trimmed.
function schemaMediaStampAndLiveMatches(sql: SqlStorage) {
  addColumn(sql, "md", "at", "INTEGER");
  sql.exec("CREATE INDEX IF NOT EXISTS gm_status ON gm (status)");
}

// Step 3. m.seq: the message's delivery number, when it is not its id.
// Forward reads (after=N) and the stream's "id:" lines go by it. A message
// that goes live later than its id was taken (a published draft, a post
// held while its media was stored) or is sent again because media landed
// on it takes a fresh number from the id counter (nextMsgId), so a reader
// whose cursor passed its id still gets it, once. NULL means the id, so
// existing rows need no backfill. Reads used to compare pub_ts against the
// cursor message's, which handed a late-published draft back on every
// read from the newest cursor and lost it when the cursor message was
// deleted.
function schemaDeliveryNumber(sql: SqlStorage) {
  addColumn(sql, "m", "seq", "INTEGER");
}

// Step 4. push.fails, push.fail_ts and push.rest_ts: how many sends in a
// row have failed, when the first of them did, and the time before which
// the fan-out sends nothing to the row (all NULL once a send gets
// through). A subscription that keeps failing rests (PUSH_FAIL_MAX,
// PUSH_FAIL_MS, PUSH_REST_MS in limits.ts); only a 404 or 410 used to end
// one, so a junk registration cost a send on every post forever. Rows
// over the bounds subscribe now refuses are kept: the fan-out and push
// status filter them out in SQL instead.
function schemaPushFailures(sql: SqlStorage) {
  addColumn(sql, "push", "fails", "INTEGER");
  addColumn(sql, "push", "fail_ts", "INTEGER");
  addColumn(sql, "push", "rest_ts", "INTEGER");
}

// Step 5. mdel, pcid and dg.updated. mdel: a live message that was deleted, under a delivery number
// of its own from the id counter, so the stream can replay the delete to
// a reader whose cursor is below it (a "delete" frame), in order with the
// messages. A delete used to reach nobody: every open feed kept the
// message, and its dead media, until a reload. The newest KEEP are kept
// (trimDeletes); cfg msg_forgot is the highest delivery number of
// anything the room no longer holds, a trimmed message or a dropped
// delete, and a replay from below it starts with a "gap" frame. Nothing
// is backfilled: deletes from before this step were never recorded.
//
// And pcid: the client_msg_id a post carried, per sender, and the message
// it made (CLIENT_MSG_ID_KEEP and CLIENT_MSG_ID_MS bound it), so a post
// sent again after its answer was lost gets the first one back instead
// of posting twice. It is stored, not held in memory, so a restart of the
// room between the two sends does not forget it. Starts empty.
//
// And dg.updated: when a digest was last written, the stamp an edit
// names (base_updated) so it cannot save over a newer edit unseen, as the
// other board tables' updated already allowed. Left null on older
// digests; reads take ts in its place (DG_COLS in room/board.ts).
function schemaDeletesAndPostIds(sql: SqlStorage) {
  sql.exec("CREATE TABLE IF NOT EXISTS mdel (dn INTEGER PRIMARY KEY, id INTEGER NOT NULL, ts INTEGER NOT NULL, who TEXT)");
  sql.exec("CREATE TABLE IF NOT EXISTS pcid (sender TEXT NOT NULL, cid TEXT NOT NULL, msg INTEGER NOT NULL, ts INTEGER NOT NULL, draft INTEGER, PRIMARY KEY (sender, cid))");
  addColumn(sql, "dg", "updated", "INTEGER");
}

// Step 6. gr: one row per ended match (finished or called off), with
// what the games list, the record, the ladder and Duel's head-to-head
// read (GrRow). Each of those used to re-read the whole match history and
// parse every stored state on every call - a games list in a room of
// 1,500 matches took 211 ms and a Duel throw held 54 MB - on the room's
// one thread, and gm is never trimmed. saveGame writes the row in the
// turn a match ends and keeps it in step after. The backfill is one SQL
// pass over the ended matches already stored, reading the state with
// json_extract (a state that is not valid JSON is skipped, as gameRow
// skips it); pub, the list entry, needs each game's own summary code, so
// it stays null here and the list fills it the first time it shows the
// match (listGames). gm keeps every row as it was.
function schemaMatchResults(sql: SqlStorage) {
  sql.exec("CREATE TABLE IF NOT EXISTS gr (id INTEGER PRIMARY KEY, type TEXT, status TEXT NOT NULL, ended INTEGER, winner TEXT, winners TEXT, draw INTEGER, places TEXT, players TEXT NOT NULL, pair TEXT, pub TEXT)");
  sql.exec("CREATE INDEX IF NOT EXISTS gr_pair ON gr (pair)");
  sql.exec("INSERT OR IGNORE INTO gr (id, type, status, ended, winner, winners, draw, places, players, pair) SELECT id, json_extract(state, '$.type'), status, json_extract(state, '$.ended'), json_extract(state, '$.winner'), json_extract(state, '$.winners'), json_extract(state, '$.draw'), json_extract(state, '$.places'), " +
    "(SELECT json_group_array(json_object('name', json_extract(p.value, '$.name'), 'hex', json_extract(p.value, '$.hex'))) FROM json_each(gm.state, '$.players') AS p), " +
    "CASE WHEN json_type(state, '$.players') = 'array' AND json_array_length(state, '$.players') = 2 THEN json_extract(state, '$.players[0].name') || char(31) || json_extract(state, '$.players[1].name') END " +
    "FROM gm WHERE status NOT IN ('lobby', 'running') AND json_valid(state)");
}

// Step 7. mh and mq: Muse delivery hooks (room/muse.ts, MhRow and MqRow).
// mh is one row per member with a hook, keyed by the folded name; mq the
// items waiting for each hook, numbered by one room-wide counter
// (AUTOINCREMENT, so a number is never handed out twice, even after the
// newest row is delivered and deleted) that the hook's cursor follows.
// Both start empty.
function schemaMuseHooks(sql: SqlStorage) {
  sql.exec("CREATE TABLE IF NOT EXISTS mh (member TEXT PRIMARY KEY, name TEXT NOT NULL, room TEXT NOT NULL, link TEXT NOT NULL, routing TEXT NOT NULL, enabled INTEGER NOT NULL, muted INTEGER NOT NULL, cursor INTEGER NOT NULL DEFAULT 0, last_at INTEGER, due_at INTEGER, fails INTEGER NOT NULL DEFAULT 0, skipped INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL, updated INTEGER NOT NULL, off_reason TEXT)");
  sql.exec("CREATE TABLE IF NOT EXISTS mq (n INTEGER PRIMARY KEY AUTOINCREMENT, member TEXT NOT NULL, kind TEXT NOT NULL, at INTEGER NOT NULL, data TEXT NOT NULL)");
  sql.exec("CREATE INDEX IF NOT EXISTS mq_member ON mq (member, n)");
}

// Step 8. Webhook hooks (room/muse.ts): an mh row's kind, "muse" (link is
// the Muse link) or "webhook" (url and secret; link and routing empty);
// and every hook's last answer: last_status (0 when nothing answered) and
// last_error. Existing rows are Muse hooks.
function schemaWebhookHooks(sql: SqlStorage) {
  addColumn(sql, "mh", "kind", "TEXT NOT NULL DEFAULT 'muse'");
  addColumn(sql, "mh", "url", "TEXT");
  addColumn(sql, "mh", "secret", "TEXT");
  addColumn(sql, "mh", "last_status", "INTEGER");
  addColumn(sql, "mh", "last_error", "TEXT");
}

// Step 9. inv.left_ts: when a member left the room by itself (POST
// .../leave, MemberMethods.leave), set on the invite it left with in the
// call that revokes it; the members list and the owner's invite list carry
// it as left. Null on every other row, a revoke through the owner's API
// included, so older rows need no backfill.
function schemaLeft(sql: SqlStorage) {
  addColumn(sql, "inv", "left_ts", "INTEGER");
}

/** The schema steps, in order (see above). */
const SCHEMA_STEPS: Array<(sql: SqlStorage) => void> = [schemaBaseline, schemaMediaStampAndLiveMatches, schemaDeliveryNumber, schemaPushFailures, schemaDeletesAndPostIds, schemaMatchResults, schemaMuseHooks, schemaWebhookHooks, schemaLeft];

/** Every table a member or the owner writes, inv aside: one row in any of
 *  them and a pending room is not untouched (Room.genesisUntouched). A new
 *  table of that kind belongs here too. */
export const GENESIS_EMPTY_TABLES = ["m", "rx", "md", "upp", "ut", "mdel", "pcid", "push", "mv", "tf", "gm", "gr", "con", "oq", "dg", "sk", "dc", "mh", "mq"];

/** cfg "genesis" (Room.genesisPending). */
type GenesisMark = { at: number, token: string, prior: string[], hwm: number, rev: number };

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
  /** when this identity's whats_waiting last ran (room/agent.ts agentGlanceTake): memory only */
  declare agentGlanceAt?: number;
  /** True while destroy() is deleting the room's storage. */
  destroying = false;
  /** How many times destroy() has begun in this instance's life: the
   *  room a call began in, as fence() and alive() compare it. In memory is
   *  enough: the calls it fences die with the instance. */
  gen = 0;
  /** Upload links being minted right now, by folded member name (room/uploads.ts, mintUploadTicket). */
  utMinting: Map<string, number> = new Map();
  /** The writer of each message's media kind holding its turn, by "msg:kind" (room/media.ts, withMediaLock). */
  mediaLocks: Map<string, Promise<void>> = new Map();
  /** The finish in flight per upload session ("msg:kind"), whose answer a finish sent again shares (room/uploads.ts, uploadFinish). */
  _finishing: Map<string, Promise<UpFinish>> = new Map();
  /** True while museDeliver is sending (room/muse.ts): one run of wakes per room. */
  museBusy = false;
  /** Messages whose post is still storing its inline files (room/messages.ts, postKeyed). Nothing publishes or sweeps one of these: published
   *  between two puts, it went out with half its files, and a later put's failure then deleted a live message with no delete frame. */
  storing: Set<number> = new Set();

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

  // A call that waits on storage (or on anything else) lets other calls
  // run, a room delete among them, and nothing used to stop it carrying on
  // afterwards: a post whose picture was still uploading then indexed and
  // announced it in a room created again under the same name, or failed
  // with its object left in the bucket for good. Such a call reads gen as
  // it starts and asks here after each wait; once the room it began in is
  // gone - deleted, whether or not created again - it writes nothing more,
  // deletes what it stored itself, and stops with goneError (410).
  /** @param gen this.gen as the call began */
  alive(gen: number) {
    return this.ready && this.gen === gen;
  }

  /** Throws goneError unless the room the call began in is still here (alive). */
  fence(gen: number) {
    if (!this.alive(gen)) throw goneError();
  }

  // An object that holds an agent key's identity (room/agent.ts) is never
  // made a room, nor a room's object an identity (agentMake refuses).
  create() {
    if (this.ready || this.destroying || isIdentity(this.sql)) return false;
    this.ensureSchema();
    this.ready = true;
    return true;
  }

  // ---- Public creation (routes/rooms.ts createRoomRoute) ----
  // A room public creation makes is pending until its genesis mail is
  // accepted (confirmGenesis) or its invite is first opened (access):
  // cfg "genesis" holds when it was made and the invite's token. The
  // Worker used to make the room, wait on the mail and roll back with
  // calls of its own, with nothing in the room saying it was not done: a
  // caller who went away mid-mail left a room whose only invite nobody
  // received, and a second creator was told "already exists" for a room
  // then rolled back. Rooms from before this mark never carry it.

  /** The pending genesis: when it was made, its invite's token, the
   *  tokens of the genesis invites it replaced (start-overs), and the
   *  message and board counters as it was made; null once confirmed (or
   *  for any other room). */
  genesisPending(): GenesisMark | null {
    if (!this.ready) return null;
    const r = this.sql.exec<Pick<CfgRow, "v">>("SELECT v FROM cfg WHERE k = 'genesis'").toArray()[0];
    if (!r) return null;
    // unreadable: as old as can be, and touched (genesisUntouched), since nothing tells what came after it
    try { const g = JSON.parse(r.v); return { at: Number(g.at) || 0, token: String(g.token || ""), prior: Array.isArray(g.prior) ? g.prior.map(String) : [], hwm: Number(g.hwm) || 0, rev: Number(g.rev) || 0 }; } catch { return { at: 0, token: "", prior: [], hwm: -1, rev: -1 }; }
  }

  private markGenesis(token: string, prior: string[]) {
    this.sql.exec("INSERT OR REPLACE INTO cfg (k, v) VALUES ('genesis', ?)", JSON.stringify({ at: Date.now(), token: token, prior: prior, hwm: this.msgHwm(), rev: this.boardRev() }));
  }

  // Whether a pending room is still as its genesis made it: its only
  // invite row the unopened genesis invite (beside the revoked ones of
  // earlier start-overs), and nothing written anywhere else. An unopened
  // genesis invite alone used to count as an empty room, but a confirm
  // that failed after the mail went out (or a Worker that died between
  // the two) leaves a room pending for good while its owner, who has the
  // owner key, invites people who post: a stranger then started that
  // room over into the members' messages, and a failed mail of theirs
  // destroyed it. A row in any table a member or the owner writes counts,
  // and so does a message or board counter past where it stood at the
  // genesis (an item written and deleted since). When in doubt, touched.
  genesisUntouched(g: GenesisMark): boolean {
    if (!g.token) return false;
    const own = new Set([g.token].concat(g.prior));
    const rows = this.sql.exec<Pick<InvRow, "token" | "revoked" | "used" | "posted" | "avatar_key">>("SELECT token, revoked, used, posted, avatar_key FROM inv").toArray();
    if (!rows.some((r) => r.token === g.token)) return false;
    // the genesis invite active, the earlier ones revoked, none opened or dressed
    for (const r of rows) if (!own.has(r.token) || r.used || r.posted || r.avatar_key || (r.token === g.token) === !!r.revoked) return false;
    for (const t of GENESIS_EMPTY_TABLES) if (this.sql.exec("SELECT 1 FROM " + t + " LIMIT 1").toArray().length) return false;
    // a clone taken (cloneTake), or a clone's delete still owed since the
    // genesis (voiceDelPend; those rows outlive a room delete)
    if (this.sql.exec("SELECT 1 FROM cfg WHERE substr(k, 1, 6) = 'clone:' OR (substr(k, 1, 10) = 'voice-del:' AND CAST(v AS INTEGER) >= ?) LIMIT 1", g.at).toArray().length) return false;
    return this.msgHwm() === g.hwm && this.boardRev() === g.rev;
  }

  // What a public creator of this name meets: free, taken, or pending -
  // made less than GENESIS_PENDING_MS ago with its mail not yet accepted
  // (try again in retry_after seconds). A pending room older than that
  // counts as free only while untouched (genesisUntouched): createGenesis
  // starts it over. A stale room that is touched is an ordinary room, the
  // owner's: its mark goes and it is taken.
  genesisCheck(): { state: "free" } | { state: "taken" } | { state: "pending", retry_after: number } {
    // a room that is being deleted is not free yet: see destroy()
    if (this.destroying) return { state: "taken" };
    if (!this.ready) return { state: "free" };
    const g = this.genesisPending();
    if (!g) return { state: "taken" };
    const age = Date.now() - g.at;
    if (age < GENESIS_PENDING_MS) return { state: "pending", retry_after: Math.max(1, Math.ceil((GENESIS_PENDING_MS - age) / 1000)) };
    if (this.genesisUntouched(g)) return { state: "free" };
    this.sql.exec("DELETE FROM cfg WHERE k = 'genesis'");
    return { state: "taken" };
  }

  // Public creation's critical section: create the room and mint the
  // creator's genesis invite as ONE call. Durable Object calls are
  // serialized, so two racing creates for the same name cannot interleave -
  // the loser is told the room existed (or is pending) and must not roll
  // anything back (with a separate check and create, a loser could
  // destroy the winner's room). A stale untouched room starts over: its
  // unopened invite is revoked and a new one made for this creator, the
  // replacement the Worker's rollback made when a mail failed, with the
  // row kept. Nothing changes before the start-over is sure to succeed:
  // the old invite used to be revoked and the mark dropped before the
  // name was checked, so a refused request still killed the first
  // creator's link.
  createGenesis(name: string): { existed: true } | { pending: true, retry_after: number } | { created: true, invite: { token: string } | null } {
    if (isIdentity(this.sql)) return { existed: true };
    const c = this.genesisCheck();
    if (c.state === "taken") return { existed: true };
    if (c.state === "pending") return { pending: true, retry_after: c.retry_after };
    const stale = this.ready ? this.genesisPending() : null;
    if (stale) {
      if (this.isReservedName(name) || this.nameHeld(name, stale.token)) return { existed: true };
      this.revoke(stale.token);
    } else {
      this.ensureSchema();
      this.ready = true;
    }
    const inv = this.invite(name, "human", null);
    // no inviter and no limits here: anything but the new invite means the name was refused
    const token = inv && "token" in inv && inv.token ? inv.token : null;
    if (token) this.markGenesis(token, stale ? stale.prior.concat(stale.token) : []);
    // Not reachable while invite() refuses only what was checked above.
    // Should it ever refuse for another reason, the route rolls the room
    // back (created with no invite): a stale room that got this far is
    // untouched, so that deletes nothing anyone wrote and frees the name.
    else if (stale) this.sql.exec("DELETE FROM cfg WHERE k = 'genesis'");
    return { created: true, invite: token ? { token: token } : null };
  }

  /** The genesis mail went out: the room is the creator's for good. Only
   *  for the genesis this creator made (a start-over has its own token). */
  confirmGenesis(token: string): boolean {
    const g = this.genesisPending();
    if (!g || g.token !== token) return false;
    this.sql.exec("DELETE FROM cfg WHERE k = 'genesis'");
    return true;
  }

  // The genesis mail failed: the room goes, as it was never there - its
  // invite revoked and its storage deleted, as the Worker's rollback did.
  // Only while it is still this creator's unopened genesis, untouched
  // (genesisUntouched): a creator who started the room over meanwhile, or
  // opened the invite, keeps it. A room someone wrote in is never deleted
  // here: only this creator's invite is revoked and the mark dropped,
  // which leaves an ordinary room.
  async abandonGenesis(token: string, room: string): Promise<boolean> {
    const g = this.genesisPending();
    if (!g || g.token !== token) return false;
    const opened = this.sql.exec<Pick<InvRow, "used">>("SELECT used FROM inv WHERE token = ?", token).toArray()[0];
    if (opened && opened.used) return false;
    if (!this.genesisUntouched(g)) {
      this.revoke(token);
      this.sql.exec("DELETE FROM cfg WHERE k = 'genesis'");
      return false;
    }
    await this.revokeAll();
    const gone = await this.destroy(room);
    return !!gone.deleted;
  }

  // ---- Public creation's caps, on the CREATE_QUOTA_ROOM object only ----
  // Every cap of one creation is checked and its place taken in this one
  // call, so a burst arriving together cannot all pass (KV's separate read
  // and write let 60 parallel creations through caps of 3, 5 and 30). A
  // place is taken before the room is made and given back
  // (createRelease) when the creation then makes nothing: a taken name, a
  // pending one, a refused mail. Rows of past days are dropped as the
  // next day's first creation comes in: they are counters, nothing else.
  /** @param caps each counter's key (a day in it) and its cap
   *  @returns whether a place was taken in every one */
  createReserve(caps: Array<[string, number]>, day: string): boolean {
    this.sql.exec("CREATE TABLE IF NOT EXISTS cq (k TEXT PRIMARY KEY, day TEXT NOT NULL, n INTEGER NOT NULL)");
    this.sql.exec("DELETE FROM cq WHERE day < ?", day);
    for (const [k, max] of caps) {
      const r = this.sql.exec<{ n: number }>("SELECT n FROM cq WHERE k = ?", k).toArray()[0];
      if ((r ? r.n : 0) >= max) return false;
    }
    for (const [k] of caps) this.sql.exec("INSERT INTO cq (k, day, n) VALUES (?, ?, 1) ON CONFLICT(k) DO UPDATE SET n = n + 1", k, day);
    return true;
  }

  createRelease(keys: string[]): void {
    this.sql.exec("CREATE TABLE IF NOT EXISTS cq (k TEXT PRIMARY KEY, day TEXT NOT NULL, n INTEGER NOT NULL)");
    for (const k of keys) this.sql.exec("UPDATE cq SET n = MAX(0, n - 1) WHERE k = ?", k);
  }

  // Removes the room and all its storage for good. A room with active invites has members, so those must go first.
  /** @param why the activity log's line: who deleted the room */
  async destroy(room: string, why = "room deleted with the owner key"): Promise<{ deleted?: boolean, error?: string, status?: number }> {
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
    this.gen++;
    try {
      return await this.destroyNow(room, why);
    } finally {
      this.destroying = false;
    }
  }

  private async destroyNow(room: string, why: string) {
    await this.activityLog(room, why);
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
    // The id counter outlives the room: storage wipes cfg with the rest,
    // and a room created again under the name used to hand out 1, 2, 3
    // again - the same ids and so the same media keys (ROOM/ID/KIND) as
    // the old room's. A call still in flight from the old room then acted
    // on the new room's message of that id (a delete removed it), and an
    // old signed link served the new room's file. This number is kept,
    // and nothing of the room's content.
    let hwm = 0;
    try { hwm = this.msgHwm(); } catch (e) { warn("room.destroy.hwm", e, { room }); }
    // The board's id marks too (nextBoardId): a sign call held from the old
    // room must not land on the new room's decision of that id.
    const boardMarks: CfgRow[] = [];
    for (const t of BOARD_TABLES) { try { const n = this.boardHwm(t); if (n) boardMarks.push({ k: t + "_hwm", v: String(n) }); } catch (e) { warn("room.destroy.boardhwm", e, { room, table: t }); } }
    // And board_rev (boardRev): a client that saw it at 7 in the old room
    // must see the new room's first board write as a change too.
    try { const n = this.boardRev(); if (n) boardMarks.push({ k: "board_rev", v: String(n) }); } catch (e) { warn("room.destroy.boardrev", e, { room }); }
    // Kept too: the ids of clones members asked to delete that Cartesia
    // has not confirmed (room/voices.ts, voiceDelPend). The room delete
    // tries them (routes/rooms.ts); one Cartesia refused then would be
    // lost with the room while the clone lives on.
    let voiceDels: CfgRow[] = [];
    try { voiceDels = this.sql.exec<CfgRow>("SELECT k, v FROM cfg WHERE substr(k, 1, 10) = 'voice-del:'").toArray(); } catch (e) { warn("room.destroy.voicedel", e, { room }); }
    await this.ctx.storage.deleteAll();
    if (hwm || voiceDels.length || boardMarks.length) this.sql.exec("CREATE TABLE IF NOT EXISTS cfg (k TEXT PRIMARY KEY, v TEXT)");
    if (hwm) this.sql.exec("INSERT OR REPLACE INTO cfg (k, v) VALUES ('msg_hwm', ?)", String(hwm));
    // every number up to it belonged to the old room: a stream resuming
    // from one of them is told its history is gone (a "gap" frame)
    if (hwm) this.sql.exec("INSERT OR REPLACE INTO cfg (k, v) VALUES ('msg_forgot', ?)", String(hwm));
    for (const d of voiceDels.concat(boardMarks)) this.sql.exec("INSERT OR REPLACE INTO cfg (k, v) VALUES (?, ?)", d.k, d.v);
    // A stream or long poll that slipped in during the awaits above
    // (fetch refuses one now, but this is the last word) goes too.
    for (const c of Array.from(this.clients)) c.close();
    const late = this.waiters;
    this.waiters = new Set();
    for (const w of late) w();
    // In-memory caches of what was just deleted: a room recreated under the
    // same name in this instance's lifetime must not sign with the old key
    // or skip its draft sweep.
    this._sigBytes = null;
    this._sweptAt = 0;
    this.sgJudging = new Set();
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
    if (!token) return inviteMissing();
    // A room with no storage (never created, or deleted: by the owner, or
    // by its last member's leave) has no invite table. The room routes
    // answer such a name 404 before they ask (roomRoute), but index.ts's
    // settleRoomBody looks first, for any request with a body, and the
    // query threw ("no such table: inv"): a 500 for the holder of an
    // invite to a deleted room. Asked after a route's check, the room
    // was deleted meanwhile.
    if (!this.ready && !this.sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'inv'").toArray().length) return { ok: false, status: 410, code: "room_deleted", error: GONE_MSG };
    const row = this.sql.exec<InviteCols>("SELECT name, revoked, used, seen, kind, invited_by, created, posted, left_ts FROM inv WHERE token = ?", token).toArray()[0];
    if (!row) return { ok: false, status: 403, code: "invite_invalid", error: "This invite link isn't valid for this room." };
    // a member who left by itself (MemberMethods.leave) is told that, under the same code
    if (row.revoked && row.left_ts) return { ok: false, status: 403, code: "invite_revoked", error: LEFT_MSG };
    if (row.revoked) return { ok: false, status: 403, code: "invite_revoked", error: "This invite link has been revoked. Ask whoever gave it to you for a new one." };
    return { ok: true, row: row };
  }

  // Look at an invite without opening it (GET /invite, MCP get_invite):
  // the same lookup and refusals as access(), but nothing is marked used or
  // seen - previewing is not joining, and it never counts as presence.
  // startView shares its body (previewOf).
  previewInvite(token: string | null | undefined): Refusal | InvitePreview {
    const l = this.lookupInvite(token);
    if (!l.ok) return l;
    return this.previewOf(l.row);
  }

  // The start page's view (GET /api/rooms/ROOM and MCP get_start_page,
  // agents/start.ts): the preview and, once the invite is open, what the
  // member's own reads already show it - its posted flag, its hook, its
  // room_state.awaiting_you and what others posted since its latest post.
  // Reads only: no access(), so it opens nothing and marks nothing seen,
  // and an unused invite sees exactly what the preview shows.
  startView(token: string | null | undefined, room: string): Refusal | StartView {
    const l = this.lookupInvite(token);
    if (!l.ok) return l;
    const pv = this.previewOf(l.row);
    if (!l.row.used) return { ...pv, posted: false, hook: null, awaiting: [], awaiting_more: 0, since: null };
    const name = l.row.name;
    const h = this.museRow(nameFold(name));
    const st = this.roomState(name, room);
    const posted = !!l.row.posted;
    return { ...pv, posted, hook: h ? this.museView(h) : null, awaiting: st.awaiting_you || [], awaiting_more: st.awaiting_you_more || 0, since: posted ? this.sinceLastPost(name) : null };
  }

  /** The preview of an invite row the lookup found. */
  private previewOf(r: InviteCols): InvitePreview {
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
  // A media read may instead carry a signed link (link): it is checked
  // here, against the key the room has now, so a link from before a delete
  // opens nothing in a room created again (lib/media.ts says more).
  access(token: string | null | undefined, owner: boolean, link?: MediaLink): Access | Refusal {
    if (owner) return { ok: true };
    const l = this.lookupInvite(token);
    if (!l.ok && link) {
      if (this.ready && mediaLinkOk(this.mediaSigKeyBytes(), link)) return { ok: true };
      return { ok: false, status: 403, code: LINK_REFUSED, error: "This media link is invalid or has expired" };
    }
    if (!l.ok) return l;
    const row = l.row;
    const now = Date.now();
    if (!row.used) this.sql.exec("UPDATE inv SET used = ? WHERE token = ?", now, token);
    // A pending genesis whose invite is opened has reached its creator,
    // whatever became of the mail's answer (confirmGenesis).
    if (!row.used && token) this.confirmGenesis(token);
    if (!row.seen || now - row.seen > 60000) this.sql.exec("UPDATE inv SET seen = ? WHERE token = ?", now, token);
    // first open: the member's status goes from unused to active for everyone
    if (!row.used) this.notifyMembers(row.name);
    // who invited them and when, and when they joined (this call, the first time)
    return { ok: true, name: row.name, kind: row.kind === "human" ? "human" : "agent", invited_by: row.invited_by || null, invited: row.created, joined: row.used || now, posted: !!row.posted };
  }

  // The deadline, firing: advance every running match that is due (the
  // same catch-up a read performs, Referee result post included), then
  // send the Muse and webhook wakes that are due, then re-arm for the next
  // of both. This is what lets a match run to its finish overnight with
  // nobody reading it.
  //
  // The clocks go first: a wake waits on someone else's server, and when
  // the wakes went first, one after another, a slow Muse held every match
  // deadline due in the same run for as long as its wakes took. Each step
  // runs under its own try/catch, so a failure in one never stops the
  // other, and the re-arm is in a finally.
  async alarm() {
    // a room deleted with its alarm still set has nothing left to advance
    if (!this.ready) return;
    const gen = this.gen;
    let saved = "";
    try { const r = this.sql.exec<Pick<CfgRow, "v">>("SELECT v FROM cfg WHERE k = 'room_name'").toArray()[0]; saved = r ? String(r.v || "") : ""; } catch (e) { warn("alarm.name", e); }
    const room: string = this.roomName || (this.ctx.id && this.ctx.id.name) || saved || "";
    if (room && !this.roomName) this.roomName = room;
    try {
      try { await this.advanceClocks(gen, room); } catch (e) { warn("alarm.clocks", e, { room }); }
      // Muse wakes that are due (room/muse.ts): they get an allowance of
      // their own per run and leave what is still due to the next one
      try { await this.museDeliver(); } catch (e) { warn("muse.deliver", e, { room }); }
    } finally {
      if (this.alive(gen)) await this.armGameAlarm();
    }
  }

  /** The alarm's first step: every running match and lobby whose clock is
   *  due, advanced. One match's bad state must not stop every clock in the
   *  room: each is advanced under its own try/catch, so a single throw
   *  cannot leave every match without a clock until somebody happens to
   *  read one. */
  async advanceClocks(gen: number, room: string) {
    const rows = this.sql.exec<Pick<GmRow, "id">>("SELECT id FROM gm WHERE status IN ('running', 'lobby')").toArray();
    for (const r of rows) {
      // deleted during an earlier match's await: these ids are not the
      // ones read above any more (a room created since starts at 1)
      if (!this.alive(gen)) break;
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
  }

  // Server-Sent Events stream. Called by the Worker with ?room=NAME&after=ID|latest
  // and the caller's invite in X-Invite-Token
  async fetch(request: Request) {
    // A stream opened while the room is being deleted (the route checked
    // that it existed a moment before) registered after destroy's close
    // loop, and an owner's one then carried on into a room created again
    // under the name. A deleted room has no stream.
    if (!this.ready) return json({ error: GONE_MSG, code: "room_deleted" }, 410);
    const url = new URL(request.url);
    const room = url.searchParams.get("room") as string; // the stream route always sends room=
    this.roomName = room;
    const a = url.searchParams.get("after");
    const after = a === "latest" ? null : Math.max(0, parseInt(a as string, 10) || 0); // the stream route always sends after=
    // Subscription filter: ?events=message,game (or all) narrows the frame
    // kinds; ?game=1,2 restricts game frames to those matches. Both are
    // validated here, before the stream opens, so a bad subscription fails
    // fast instead of silently starving.
    const STREAM_KINDS = ["message", "reaction", "game", "members", "state", "delete", "gap"];
    let kinds: Set<string> | null = null;
    const evRaw = (url.searchParams.get("events") || "").trim().toLowerCase(); // lowercase-ok: event names
    // state is opt-in only: naming it anywhere in events= subscribes, and
    // "all" (or no events= at all) does not - see the note at streamWants.
    const wantsState = evRaw.split(",").map((x) => x.trim()).indexOf("state") >= 0;
    if (evRaw) {
      kinds = new Set();
      for (const part of evRaw.split(",")) {
        const k = part.trim();
        if (!k) continue;
        if (k === "all") { kinds = null; break; }
        if (STREAM_KINDS.indexOf(k) < 0) return new Response(JSON.stringify({ error: "unknown stream event kind: " + k + " (valid: " + STREAM_KINDS.join(", ") + ", all)" }), { status: 400, headers: { "Content-Type": "application/json" } });
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
    // in a header, out of the logged URL (routes/stream.ts)
    const token = request.headers.get("X-Invite-Token") || "";
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
    if (after !== null) this.replay(client, room, after);
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
      }, STREAM_PING_MS);
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
Object.assign(Room.prototype, MuseMethods);
Object.assign(Room.prototype, TestHookMethods);
Object.assign(Room.prototype, AgentMethods);
