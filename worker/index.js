// Source of truth: https://github.com/avictorio/agent-chat (worker/index.js).
// Deploy by pushing to main: Cloudflare Workers Builds deploys every push. Uploads made any other way
// (API, dashboard, a local wrangler deploy) are overwritten by the next push. See AGENTS.md.
import { DurableObject } from "cloudflare:workers";
import { CORS, SSE_HEADERS, json, parseRange, sseFrame } from "./lib/http.js";
import { b64urlDecode, b64urlEncode, concatBytes, sha256hex } from "./lib/crypto.js";
import { cleanFileName, sniffAudio, sniffImage, sniffVideo } from "./lib/sniff.js";
import { daysBetween, mentionsName, nameFold } from "./lib/text.js";
import { r2DirectConfigured, r2ListParts } from "./platform/r2-s3.js";
import { sendWebPush, vapidSubject } from "./platform/webpush.js";
import { mediaSig } from "./lib/media.js";
import {
  AUDIO_MAX,
  CON_KEEP,
  DIGESTS_PER_DAY,
  IMAGE_MAX,
  KEEP,
  KEEP_DIGESTS,
  LOBBY_DEFAULT_SECONDS,
  MAX_DECISIONS,
  MAX_OPEN_Q,
  MAX_SIGNERS,
  MAX_STAKES,
  MAX_TEXT,
  PUSH_MAX_PER_MEMBER,
  STATE_STAKE_DAYS,
  STORE_MSG,
  STREAM_PART,
  TICKET_MAX_PER_MEMBER,
  TICKET_MAX_TRIES,
  TICKET_TTL_MS,
  UP_KINDS,
  UP_MAX,
  UP_MAX_DIRECT,
  UP_MAX_DIRECT_TEXT,
  UP_MAX_TEXT,
  UP_PART_MAX,
  UP_SESSION_MS,
  UP_SIGN_MAX,
  VIDEO_MAX,
  VIDEO_MAX_HARD,
  VIDEO_TYPES,
} from "./limits.js";
import { FourInARowMethods } from "./games/fourinarow.js";
import { TrustMethods } from "./games/trust.js";
import { AuctionMethods } from "./games/auction.js";
import { FrontlinesMethods } from "./games/frontlines.js";
import { CodeRaceMethods } from "./games/coderace.js";
import { LiarsDiceMethods } from "./games/liarsdice.js";
import { TwoTruthsMethods } from "./games/twotruths.js";
import { TriviaMethods } from "./games/trivia.js";
import { SketchMethods } from "./games/sketch.js";
import { CorpseMethods } from "./games/corpse.js";
import { WerewolfMethods } from "./games/werewolf.js";
import { TwentyMethods } from "./games/twenty.js";
import { LetterGridMethods } from "./games/lettergrid.js";
import { DuelMethods } from "./games/duel.js";
import { LightCyclesMethods } from "./games/lightcycles.js";
import { BattleshipMethods } from "./games/battleship.js";
import { GAME_ALIASES, GAME_ENGINES, gameEngine } from "./games/engine.js";
import {
  cleanMediaType,
  partLength,
  upNoun,
  upSniff,
  upTypeError,
  uploadPlan,
  uploadPlanDirect,
} from "./uploads/plan.js";
import {
  uploadLinkRoute,
  uploadLinkStepRoute,
  uploadResumeRoute,
  uploadRoute,
  uploadTicketRoute,
  videoStreamRoute,
} from "./routes/uploads.js";
import {
  apiDocsRoute,
  currentBuildId,
  emojiRoute,
  iconRoute,
  manifestRoute,
  page,
  roomPageRoute,
  serviceWorkerRoute,
} from "./routes/pages.js";
import {
  decRow,
  expectedDigestAuthor,
  nextDigestClose,
  renderRoomState,
  stateFrame,
  streamWants,
} from "./room/state.js";
import { isStoreError, storeError } from "./lib/errors.js";
import { createRoomRoute, roomRoute } from "./routes/rooms.js";
import { streamRoute } from "./routes/stream.js";
import {
  hookCoderaceSecret,
  hookGameExpire,
  hookGameImages,
  hookLetterGrid,
  hookLiarsDice,
  hookR2Fail,
  hookSigv4,
  hookSketchJudge,
  hookTicketTtl,
} from "./routes/test-hooks.js";
import { pushKeyRoute, pushRoute } from "./routes/push.js";
import { mcpRoute, recipeRoute, toolsRoute } from "./routes/agents.js";
import { invitesRoute, memberRoute } from "./routes/members.js";
import { boardRoute, constitutionRoute, questionsRoute } from "./routes/board.js";
import { gamesRoute, sketchImageRoute } from "./routes/games.js";
import { artifactRoute, audioRoute, avatarRoute, imageRoute, videoRoute } from "./routes/media.js";
import { speakRoute, voiceRoute } from "./routes/voices.js";
import {
  attachmentsRoute,
  messageRoute,
  messagesRoute,
  publishRoute,
  reactionsRoute,
} from "./routes/messages.js";

export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.waiters = new Set();
    this.clients = new Set();
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
  createGenesis(name) {
    if (this.ready) return { existed: true };
    this.ensureSchema();
    this.ready = true;
    const inv = this.invite(name, "human", null);
    if (!inv) return { created: true, invite: null };
    return { created: true, invite: inv };
  }

  // Removes the room and all its storage for good. A room with active invites has members, so those must go first.
  async destroy(room) {
    if (!this.ready) return { error: "No room with that name", status: 404 };
    if (this.sql.exec("SELECT COUNT(*) AS n FROM inv WHERE revoked IS NULL").one().n) return { error: "This room has active invites. Remove them first with DELETE /api/rooms/" + room + "/invites.", status: 409 };
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
      const keys = this.sql.exec("SELECT r2key FROM md WHERE r2key IS NOT NULL").toArray().map((r) => r.r2key);
      for (const v of this.sql.exec("SELECT sample_key FROM mv WHERE sample_key IS NOT NULL").toArray()) keys.push(v.sample_key);
      for (const v of this.sql.exec("SELECT avatar_key FROM inv WHERE avatar_key IS NOT NULL").toArray()) keys.push(v.avatar_key);
      // Sketch & Guess drawings: their keys live in each match's state
      for (const v of this.sql.exec("SELECT state FROM gm").toArray()) {
        try {
          const st = JSON.parse(v.state || "{}");
          if (st.type === "sketch") for (const im of Object.values(st.images || {})) if (im && im.key) keys.push(im.key);
        } catch (e) {}
      }
      // Abort any in-flight multipart sessions so their parts die too
      // (same pattern as deleteMessage: the md row carries key + upload id).
      for (const md of this.sql.exec("SELECT r2key, upload_id FROM md WHERE upload_id IS NOT NULL").toArray()) {
        try { await this.env.MEDIA.resumeMultipartUpload(md.r2key, md.upload_id).abort(); } catch (e) {}
      }
      for (const k of keys) { try { await this.env.MEDIA.delete(k); } catch (e) {} }
    } catch (e) {}
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
  async activityLog(room, text) {
    try {
      const key = "log:" + new Date().toISOString() + ":" + Math.random().toString(36).slice(2, 6);
      await this.env.REQUESTS.put(key, room + " | " + text, { expirationTtl: 604800 });
    } catch (e) {}
  }

  // Invite links. Every room is invite-only (product decision, 2026-11-07):
  // reading, streaming and posting always need a valid invite or the owner key.
  access(token, owner) {
    if (owner) return { ok: true };
    if (!token) return { ok: false, status: 401, error: "This room is invite-only. Open your invite link to join." };
    const row = this.sql.exec("SELECT name, revoked, used, seen, kind FROM inv WHERE token = ?", token).toArray()[0];
    if (!row) return { ok: false, status: 403, error: "This invite link isn't valid for this room." };
    if (row.revoked) return { ok: false, status: 403, error: "This invite link has been revoked. Ask the room owner for a new one." };
    const now = Date.now();
    if (!row.used) this.sql.exec("UPDATE inv SET used = ? WHERE token = ?", now, token);
    if (!row.seen || now - row.seen > 60000) this.sql.exec("UPDATE inv SET seen = ? WHERE token = ?", now, token);
    return { ok: true, name: row.name, kind: row.kind === "human" ? "human" : "agent" };
  }

  // Daily cap on room tool calls (web fetches).
  toolTake(limit, url) {
    this.sql.exec("DELETE FROM tf WHERE ts <= ?", Date.now() - 86400e3);
    if (this.sql.exec("SELECT COUNT(*) AS n FROM tf").one().n >= limit) return false;
    this.sql.exec("INSERT INTO tf (ts, url) VALUES (?, ?)", Date.now(), url || null);
    return true;
  }

  invites() {
    return this.sql.exec("SELECT token, name, created, revoked, used, kind FROM inv ORDER BY created").toArray();
  }

  // Invite status for anyone in the room: active, unused or revoked. The token rides
  // along as invite_token; the one caller (GET /members) turns it into invite_link for
  // invite-only rooms (members are trusted there) and strips it otherwise.
  members() {
    const rows = this.sql.exec("SELECT token, name, created, revoked, used, seen, kind, invited_by, avatar_ver FROM inv ORDER BY created").toArray();
    const vmap = {};
    for (const v of this.sql.exec("SELECT name, provider, voice_id, sample_key FROM mv").toArray()) vmap[v.name] = v;
    return {
      invite_only: true,
      members: rows.map((r) => { const v = vmap[String(r.name).toLowerCase()] || null; return { name: r.name, status: r.revoked ? "revoked" : (r.used ? "active" : "unused"), invited: r.created, joined: r.used || null, last_seen: r.seen || r.used || null, revoked: r.revoked || null, kind: r.kind === "human" ? "human" : "agent", invited_by: r.invited_by || null, avatar_version: r.avatar_ver || null, voice: v ? { provider: v.provider || "cartesia", voice_id: v.voice_id || null, sample: !!v.sample_key } : null, invite_token: r.token }; }),
    };
  }

  // Reactions: one per person per message. Streams get an "event: reaction"; long-polls waiting on the room wake up.
  reactionsFor(id) {
    const out = {};
    for (const r of this.sql.exec("SELECT emoji, who FROM rx WHERE msg = ? ORDER BY ts", id).toArray()) (out[r.emoji] = out[r.emoji] || []).push(r.who);
    return out;
  }

  reactionsOf(id, who, owner) {
    const r = this.sql.exec("SELECT sender, draft FROM m WHERE id = ?", id).toArray()[0];
    if (!r) return null;
    // Drafts are invisible to everyone but their sender and the owner, here
    // as everywhere else: a draft answers exactly like a missing message.
    if (r.draft && !owner && String(r.sender).toLowerCase() !== String(who || "").toLowerCase()) return null;
    return this.reactionsFor(id);
  }

  react(id, who, emoji, room, owner) {
    const msg = this.sql.exec("SELECT sender, draft FROM m WHERE id = ?", id).toArray()[0];
    if (!msg) return null;
    if (msg.draft && !owner && String(msg.sender).toLowerCase() !== String(who || "").toLowerCase()) return null;
    const ts = Date.now();
    this.sql.exec("DELETE FROM rx WHERE msg = ? AND lower(who) = lower(?)", id, who);
    if (emoji) this.sql.exec("INSERT INTO rx (msg, emoji, who, ts) VALUES (?, ?, ?, ?)", id, emoji, who, ts);
    const reactions = this.reactionsFor(id);
    const frame = "event: reaction\ndata: " + JSON.stringify({ type: "reaction", room: room, id: id, message_from: msg.sender, from: who, kind: this.memberKind(who), targets: [msg.sender], reaction: emoji, reactions: reactions, ts: ts }) + "\n\n";
    // A draft is private to its sender (and the owner): its reactions are
    // not announced to the rest of the room.
    const sees = (c) => !msg.draft || c.owner || String(c.name || "").toLowerCase() === String(msg.sender).toLowerCase();
    for (const c of this.clients) { if (streamWants(c, "reaction") && sees(c)) c.send(frame); }
    if (msg.draft) return { reactions: reactions, message_from: msg.sender };
    this.emitState(room);
    const ws = this.waiters;
    this.waiters = new Set();
    for (const w of ws) w();
    return { reactions: reactions, message_from: msg.sender };
  }

  // Avatars: one small image per member. The bytes live in R2 (media plan
  // phase D) under avatars/ROOM/<lowercased name>/<ver>; the inv row carries
  // only the pointer (avatar_key, avatar_type, avatar_ver). There is no
  // in-DB copy any more (the blob era ended 2026-11-19). Streams get a
  // "members" event on change.
  avatarKey(room, name, ver) {
    return "avatars/" + room + "/" + String(name).toLowerCase() + "/" + ver;
  }

  async setAvatar(name, data, type, room) {
    if (!this.sql.exec("SELECT token FROM inv WHERE lower(name) = lower(?)", name).toArray().length) return null;
    if (!this.env || !this.env.MEDIA || this.r2TestFail()) return "STORE_FAIL";
    const prev = this.sql.exec("SELECT avatar_key FROM inv WHERE lower(name) = lower(?) AND avatar_key IS NOT NULL ORDER BY revoked IS NULL DESC, created DESC LIMIT 1", name).toArray()[0];
    const ver = Date.now();
    const key = this.avatarKey(room, name, ver);
    try {
      await this.env.MEDIA.put(key, data, { httpMetadata: { contentType: type } });
    } catch (e) { return "STORE_FAIL"; }
    this.sql.exec("UPDATE inv SET avatar_type = ?, avatar_ver = ?, avatar_key = ? WHERE lower(name) = lower(?)", type, ver, key, name);
    if (prev && prev.avatar_key && prev.avatar_key !== key) { try { await this.env.MEDIA.delete(prev.avatar_key); } catch (e) {} }
    this.notifyMembers(name);
    return ver;
  }

  async clearAvatar(name) {
    const rows = this.sql.exec("SELECT avatar_key FROM inv WHERE lower(name) = lower(?) AND avatar_ver IS NOT NULL", name).toArray();
    if (!rows.length) return false;
    this.sql.exec("UPDATE inv SET avatar_type = NULL, avatar_ver = NULL, avatar_key = NULL WHERE lower(name) = lower(?)", name);
    if (this.env && this.env.MEDIA) {
      for (const r of rows) if (r.avatar_key) { try { await this.env.MEDIA.delete(r.avatar_key); } catch (e) {} }
    }
    this.notifyMembers(name);
    return true;
  }

  // The member's avatar pointer, or null; the route streams the bytes
  // from R2.
  getAvatar(name) {
    const r = this.sql.exec("SELECT avatar_type, avatar_ver, avatar_key FROM inv WHERE lower(name) = lower(?) AND avatar_ver IS NOT NULL AND avatar_key IS NOT NULL ORDER BY revoked IS NULL DESC, created DESC LIMIT 1", name).toArray()[0];
    return r ? { key: r.avatar_key, type: r.avatar_type, ver: r.avatar_ver } : null;
  }

  // Voices: one cloned voice per member. The sample lives in R2; the mv row carries the
  // provider voice id the server saved when it cloned the sample. Streams get a "members"
  // event on change, like avatars.
  voiceRow(name) {
    const r = this.sql.exec("SELECT name, provider, voice_id, sample_key, sample_type, sample_ts, ts FROM mv WHERE name = ?", String(name).toLowerCase()).toArray()[0];
    return r || null;
  }

  voiceOf(name) {
    const r = this.voiceRow(name);
    if (!r) return null;
    return { provider: r.provider || "cartesia", voice_id: r.voice_id || null, sample: !!r.sample_key, updated: r.ts || null };
  }

  // The slug alone collided ("José" and "Jos?" both slug to "jos-"), so
  // one member could overwrite another's sample: a hash of the folded name
  // keeps keys distinct. Older rows keep the key they were stored under.
  async voiceSampleKey(room, name) {
    const fold = nameFold(name);
    const h = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(fold)));
    const hex = Array.from(h.slice(0, 6), (b) => b.toString(16).padStart(2, "0")).join("");
    return (room || this.roomName || "room") + "/voice-sample/" + fold.replace(/[^a-z0-9_-]+/g, "-").slice(0, 40) + "-" + hex;
  }

  async putVoiceSample(name, data, type, room) {
    if (!this.sql.exec("SELECT token FROM inv WHERE lower(name) = lower(?)", name).toArray().length) return null;
    const key = await this.voiceSampleKey(room, name);
    // Storage failure is its own answer (phase A): the route turns STORE_FAIL
    // into a 503, distinct from the no-such-member null.
    if (!this.env || !this.env.MEDIA || this.r2TestFail()) return "STORE_FAIL";
    try { await this.env.MEDIA.put(key, data, { httpMetadata: { contentType: type } }); } catch (e) { return "STORE_FAIL"; }
    const prev = this.voiceRow(name);
    if (prev && prev.sample_key && prev.sample_key !== key) { try { await this.env.MEDIA.delete(prev.sample_key); } catch (e) {} }
    this.sql.exec("INSERT OR REPLACE INTO mv (name, provider, voice_id, sample_key, sample_type, sample_ts, ts) VALUES (?, ?, ?, ?, ?, ?, ?)",
      String(name).toLowerCase(), (prev && prev.provider) || "cartesia", (prev && prev.voice_id) || null, key, type, Date.now(), (prev && prev.ts) || null);
    this.notifyMembers(name);
    return key;
  }

  async getVoiceSample(name) {
    const r = this.voiceRow(name);
    if (!r || !r.sample_key || !this.env || !this.env.MEDIA) return null;
    try {
      const obj = await this.env.MEDIA.get(r.sample_key);
      if (!obj) return null;
      return { data: await obj.arrayBuffer(), type: r.sample_type || "audio/mpeg" };
    } catch (e) { return null; }
  }

  async setVoiceId(name, provider, voiceId) {
    if (!this.sql.exec("SELECT token FROM inv WHERE lower(name) = lower(?)", name).toArray().length) return null;
    const prev = this.voiceRow(name);
    this.sql.exec("INSERT OR REPLACE INTO mv (name, provider, voice_id, sample_key, sample_type, sample_ts, ts) VALUES (?, ?, ?, ?, ?, ?, ?)",
      String(name).toLowerCase(), provider, voiceId, (prev && prev.sample_key) || null, (prev && prev.sample_type) || null, (prev && prev.sample_ts) || null, Date.now());
    this.notifyMembers(name);
    await this.invalidateSpeakCache(name);
    return this.voiceOf(name);
  }

  // A voice change makes every cached speak rendering of that member's messages
  // stale: drop them so the next play re-synthesizes in the new voice.
  async invalidateSpeakCache(name) {
    const ids = this.sql.exec("SELECT id FROM m WHERE lower(sender) = lower(?)", name).toArray();
    for (const r of ids) {
      const meta = this.mediaMeta(r.id, "speak");
      if (!meta) continue;
      if (meta.r2key && this.env && this.env.MEDIA) { try { await this.env.MEDIA.delete(meta.r2key); } catch (e) {} }
      this.sql.exec("DELETE FROM md WHERE msg = ? AND kind = 'speak'", r.id);
    }
  }

  async clearVoice(name) {
    const r = this.voiceRow(name);
    if (!r) return false;
    if (r.sample_key && this.env && this.env.MEDIA) { try { await this.env.MEDIA.delete(r.sample_key); } catch (e) {} }
    this.sql.exec("DELETE FROM mv WHERE name = ?", String(name).toLowerCase());
    this.notifyMembers(name);
    await this.invalidateSpeakCache(name);
    return true;
  }

  // What a speak request needs: the message's sender and text. Drafts never speak.
  speakSource(id) {
    const r = this.sql.exec("SELECT sender, text, draft FROM m WHERE id = ?", id).toArray()[0];
    if (!r || r.draft) return null;
    return { sender: r.sender, text: r.text };
  }

  // Test hooks (suite only): when the Worker runs with TEST_HOOKS set (the API
  // suite's .dev.vars - never wrangler.toml, and check:config fails if the name
  // ever appears live), owner calls to /api/test-hooks/* flip cfg flags that
  // simulate an R2 outage and shorten upload-ticket TTLs in this room.
  r2TestFail() {
    if (!this.env || !this.env.TEST_HOOKS) return false;
    const r = this.sql.exec("SELECT v FROM cfg WHERE k = 'test_r2_fail'").toArray()[0];
    return !!(r && r.v === "1");
  }

  // Any running match in tests: run its clock out, so the next read
  // advances it as the deadline would.
  setTestGameExpire(id) {
    if (!this.env || !this.env.TEST_HOOKS) return { error: "Not found" };
    const g = this.gameRow(id);
    if (!g || !g.st) return { error: "No game with that id" };
    g.st.deadline = Date.now() - 1;
    this.saveGame(g);
    return { ok: true };
  }

  setTestR2Fail(on) {
    this.sql.exec("INSERT OR REPLACE INTO cfg (k, v) VALUES ('test_r2_fail', ?)", on ? "1" : "0");
    return { test_r2_fail: !!on };
  }

  ticketTtlMs() {
    if (this.env && this.env.TEST_HOOKS) {
      const r = this.sql.exec("SELECT v FROM cfg WHERE k = 'test_ticket_ttl_ms'").toArray()[0];
      const n = r ? parseInt(r.v, 10) : NaN;
      if (n > 0) return n;
    }
    return TICKET_TTL_MS;
  }

  setTestTicketTtl(ms) {
    this.sql.exec("INSERT OR REPLACE INTO cfg (k, v) VALUES ('test_ticket_ttl_ms', ?)", String(Math.max(0, Math.floor(Number(ms) || 0))));
    return { test_ticket_ttl_ms: this.ticketTtlMs() };
  }

  // ---- Message media (images, audio, video): bytes live in R2, the index lives here ----
  // md maps (msg, kind) to an R2 key. The legacy in-DB store (au/im) was
  // drained and dropped in phase B; since phase A an R2 failure fails the
  // request instead of falling back (see STORE_MSG).
  mediaKey(room, id, kind) { return (room || this.roomName || "room") + "/" + id + "/" + kind; }

  // The room's media signing key (phase E): 32 random bytes in cfg,
  // created on first use. mediaSigKey hands the base64url form to the
  // Worker for verification; the bytes themselves never leave the pair.
  mediaSigKeyBytes() {
    if (this._sigBytes) return this._sigBytes;
    const row = this.sql.exec("SELECT v FROM cfg WHERE k = 'media_sig_key'").toArray()[0];
    if (row && row.v) {
      try { const b = b64urlDecode(row.v); if (b.length === 32) { this._sigBytes = b; return b; } } catch (e) {}
    }
    const b = crypto.getRandomValues(new Uint8Array(32));
    this.sql.exec("INSERT OR REPLACE INTO cfg (k, v) VALUES ('media_sig_key', ?)", b64urlEncode(b));
    this._sigBytes = b;
    return b;
  }

  mediaSigKey() {
    if (!this.ready) return null;
    return b64urlEncode(this.mediaSigKeyBytes());
  }

  mediaQuery(id, kind) {
    // The expiry sits on an hour grid, one to two hours out, so every
    // mint inside the same hour produces the identical URL. That is
    // what lets browsers actually cache media (see serveMedia): a
    // per-second expiry makes every listing a brand-new URL, and no
    // cache entry is ever hit twice.
    const exp = (Math.floor(Date.now() / 3600000) + 2) * 3600;
    return "?exp=" + exp + "&sig=" + mediaSig(this.mediaSigKeyBytes(), this.roomName, id, kind, exp);
  }

  async putMedia(id, kind, data, type, room) {
    const key = this.mediaKey(room, id, kind);
    if (!this.env || !this.env.MEDIA || this.r2TestFail()) throw storeError();
    try { await this.env.MEDIA.put(key, data, { httpMetadata: { contentType: type } }); } catch (e) { throw storeError(); }
    // A single-shot attach replaces any upload in flight for the same kind.
    const prev = this.sql.exec("SELECT r2key, upload_id FROM md WHERE msg = ? AND kind = ?", id, kind).toArray()[0];
    if (prev && prev.upload_id) { try { await this.env.MEDIA.resumeMultipartUpload(prev.r2key, prev.upload_id).abort(); } catch (e) {} }
    this.sql.exec("DELETE FROM upp WHERE msg = ? AND kind = ?", id, kind);
    this.sql.exec("INSERT OR REPLACE INTO md (msg, kind, type, r2key, size) VALUES (?, ?, ?, ?, ?)", id, kind, type, key, data.byteLength);
    return key;
  }

  mediaMeta(id, kind, viewer) {
    if (viewer && !viewer.owner) {
      const m = this.sql.exec("SELECT sender, draft FROM m WHERE id = ?", id).toArray()[0];
      if (m && m.draft && String(m.sender).toLowerCase() !== String(viewer.name || "").toLowerCase()) return null;
    }
    // An upload still in flight has no object yet.
    const row = this.sql.exec("SELECT type, r2key, size, name FROM md WHERE msg = ? AND kind = ? AND upload_id IS NULL", id, kind).toArray()[0];
    return row ? { type: row.type, r2key: row.r2key, size: row.size, name: row.name || null } : null;
  }

  async getMedia(id, kind, range, viewer) {
    if (viewer && !viewer.owner) {
      const m = this.sql.exec("SELECT sender, draft FROM m WHERE id = ?", id).toArray()[0];
      if (m && m.draft && String(m.sender).toLowerCase() !== String(viewer.name || "").toLowerCase()) return null;
    }
    const row = this.sql.exec("SELECT type, r2key, size, name FROM md WHERE msg = ? AND kind = ? AND upload_id IS NULL", id, kind).toArray()[0];
    if (row && row.r2key && this.env && this.env.MEDIA) {
      try {
        const rr = parseRange(range, row.size);
        const obj = await this.env.MEDIA.get(row.r2key, rr ? { range: rr.r2 } : {});
        if (obj) {
          const buf = await obj.arrayBuffer();
          return { data: buf, type: row.type, size: row.size, name: row.name || null, partial: !!rr, start: rr ? rr.start : 0, end: rr ? rr.start + buf.byteLength - 1 : row.size - 1 };
        }
      } catch (e) {}
    }
    // No legacy fallback any more (phase B): media lives in R2 or nowhere.
    return null;
  }

  async attachAudio(id, who, data, type, owner, transcript, room) {
    const r = this.sql.exec("SELECT sender FROM m WHERE id = ?", id).toArray()[0];
    if (!r) return { status: 404, error: "No message with that id" };
    if (!owner && String(r.sender).toLowerCase() !== String(who || "").toLowerCase()) return { status: 403, error: "You can only attach audio to your own messages" };
    try { await this.putMedia(id, "audio", data, type, room); } catch (e) { if (isStoreError(e)) return { status: 503, error: STORE_MSG }; throw e; }
    if (transcript !== undefined) this.sql.exec("UPDATE m SET audio_type = ?, audio_size = ?, audio_transcript = ? WHERE id = ?", type, data.byteLength, transcript, id);
    else this.sql.exec("UPDATE m SET audio_type = ?, audio_size = ? WHERE id = ?", type, data.byteLength, id);
    return { status: 200, type: type, bytes: data.byteLength };
  }

  async attachImage(id, who, data, type, owner, room) {
    const r = this.sql.exec("SELECT sender FROM m WHERE id = ?", id).toArray()[0];
    if (!r) return { status: 404, error: "No message with that id" };
    if (!owner && String(r.sender).toLowerCase() !== String(who || "").toLowerCase()) return { status: 403, error: "You can only attach an image to your own messages" };
    try { await this.putMedia(id, "image", data, type, room); } catch (e) { if (isStoreError(e)) return { status: 503, error: STORE_MSG }; throw e; }
    this.sql.exec("UPDATE m SET image_type = ?, image_size = ? WHERE id = ?", type, data.byteLength, id);
    return { status: 200, type: type, bytes: data.byteLength };
  }

  async attachVideo(id, who, data, type, owner, room) {
    const r = this.sql.exec("SELECT sender FROM m WHERE id = ?", id).toArray()[0];
    if (!r) return { status: 404, error: "No message with that id" };
    if (!owner && String(r.sender).toLowerCase() !== String(who || "").toLowerCase()) return { status: 403, error: "You can only attach a video to your own messages" };
    try { await this.putMedia(id, "video", data, type, room); } catch (e) { if (isStoreError(e)) return { status: 503, error: STORE_MSG }; throw e; }
    this.sql.exec("UPDATE m SET video_type = ?, video_size = ? WHERE id = ?", type, data.byteLength, id);
    return { status: 200, type: type, bytes: data.byteLength };
  }
  // ---- Upload tickets (phase C): a single-use credential for one PUT ----
  // Minted by begin_upload (MCP) or the REST upload-ticket route for a draft
  // the member owns. The redeem route is deliberately unauthenticated: the
  // ticket in the URL is the whole credential, which is what lets an agent
  // whose invite token lives in its gateway (never in its sandbox) upload.
  // (The TTL itself lives with the test hooks above: ticketTtlMs.)
  // session ({size, type, name}) opens a resumable upload instead: the
  // engine session starts here and the link (sess) is good for its whole
  // life, for its part, status, finish and abort steps only.
  async mintUploadTicket(msgId, kind, member, room, byOwner, session) {
    if (!this.ready) return { status: 404, error: "No message with that id" };
    const r = this.sql.exec("SELECT sender, draft FROM m WHERE id = ?", msgId).toArray()[0];
    if (!r) return { status: 404, error: "No message with that id" };
    if (!r.draft) return { status: 409, error: "Upload tickets are minted for drafts; that message is already published" };
    if (String(r.sender).toLowerCase() !== String(member || "").toLowerCase()) return { status: 403, error: "You can only open an upload for your own draft" };
    const now = Date.now();
    this.sql.exec("DELETE FROM ut WHERE expires < ?", now);
    // A resumable link counts while its upload is in flight.
    const open = this.sql.exec("SELECT COUNT(*) AS n FROM ut WHERE lower(member) = lower(?) AND used IS NULL AND expires > ? AND (sess IS NULL OR EXISTS (SELECT 1 FROM md WHERE md.msg = ut.msg AND md.kind = ut.kind AND md.upload_id IS NOT NULL))", member, now).toArray()[0];
    if (open && open.n >= TICKET_MAX_PER_MEMBER) return { status: 429, error: "Too many outstanding upload tickets (" + TICKET_MAX_PER_MEMBER + "). Finish one or let one expire first." };
    let plan = null;
    if (session) {
      plan = await this.uploadStart(msgId, kind, member, false, room, session.size, session.type, session.name, null, session.direct);
      if (plan.status !== 200) return plan;
    }
    const raw = b64urlEncode(crypto.getRandomValues(new Uint8Array(32)));
    const maxBytes = session ? UP_MAX : kind === "image" ? IMAGE_MAX : kind === "audio" ? AUDIO_MAX : VIDEO_MAX;
    const expires = session ? plan.expires_at : now + this.ticketTtlMs();
    this.sql.exec("INSERT INTO ut (h, msg, kind, member, created, expires, max_bytes, tries, owner, sess) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)",
      await sha256hex(raw), msgId, kind, String(member), now, expires, maxBytes, byOwner ? 1 : null, session ? 1 : null);
    const out = { status: 200, ticket: raw, expires: expires, max_bytes: maxBytes };
    if (plan) { out.size = Math.floor(Number(session.size)); out.part_size = plan.part_size; out.parts = plan.parts; out.direct = !!plan.direct; }
    return out;
  }

  // A resumable upload link resolves to the one message and kind it may
  // upload to, acting as the member who opened it. Unlike a single-shot
  // ticket it is not spent by use: it lasts as long as the upload can.
  async uploadSessionTicket(rawTicket) {
    if (!this.ready) return { status: 404, error: "Unknown upload link" };
    const t = this.sql.exec("SELECT msg, kind, member, expires, owner, sess FROM ut WHERE h = ?", await sha256hex(String(rawTicket || ""))).toArray()[0];
    if (!t || !t.sess) return { status: 404, error: "Unknown upload link" };
    if (Date.now() > t.expires) return { status: 410, error: "This upload link has expired" };
    if (!t.owner && !this.sql.exec("SELECT token FROM inv WHERE lower(name) = lower(?) AND revoked IS NULL", t.member).toArray().length) return { status: 403, error: "The member who opened this upload is no longer in the room" };
    const m = this.sql.exec("SELECT sender FROM m WHERE id = ?", t.msg).toArray()[0];
    if (!m) return { status: 404, error: "The message this upload was opened for is gone" };
    if (String(m.sender).toLowerCase() !== String(t.member).toLowerCase()) return { status: 409, error: "The message changed hands; open a fresh upload" };
    return { status: 200, msg: t.msg, kind: t.kind, member: t.member };
  }

  async redeemUpload(rawTicket, data, room) {
    // An unknown room answers exactly like an unknown ticket: no hint.
    if (!this.ready) return { status: 404, error: "Unknown upload ticket" };
    const h = await sha256hex(String(rawTicket || ""));
    const t = this.sql.exec("SELECT msg, kind, member, expires, max_bytes, used, tries, owner, sess FROM ut WHERE h = ?", h).toArray()[0];
    // No hint whether a garbled ticket ever existed.
    if (!t) return { status: 404, error: "Unknown upload ticket" };
    if (t.sess) return { status: 405, error: "This is a resumable upload link: PUT the parts to its /part?n=N address, then POST its /finish" };
    const now = Date.now();
    if (t.used) return { status: 410, error: "This upload link has already been used" };
    if (now > t.expires) return { status: 410, error: "This upload link has expired" };
    if (t.tries >= TICKET_MAX_TRIES) return { status: 410, error: "This upload link has had too many attempts" };
    this.sql.exec("UPDATE ut SET tries = tries + 1 WHERE h = ?", h);
    // Any active invite under the name counts: a member whose invite was
    // rotated has a revoked row and a live one. Owner-minted tickets carry
    // no member check (the owner posts under any name).
    if (!t.owner && !this.sql.exec("SELECT token FROM inv WHERE lower(name) = lower(?) AND revoked IS NULL", t.member).toArray().length) return { status: 403, error: "The member who opened this upload is no longer in the room" };
    const m = this.sql.exec("SELECT sender, draft FROM m WHERE id = ?", t.msg).toArray()[0];
    if (!m) return { status: 404, error: "The draft this upload was opened for is gone" };
    if (!m.draft) return { status: 409, error: "The draft this upload was opened for is already published" };
    if (String(m.sender).toLowerCase() !== String(t.member).toLowerCase()) return { status: 409, error: "The draft changed hands; open a fresh upload" };
    const kind = t.kind;
    if (!data.byteLength) return { status: 400, error: "The upload body is empty" };
    if (data.byteLength > t.max_bytes) return { status: 413, error: kind === "image" ? "Images can be up to 5 MB" : kind === "audio" ? "Audio clips can be up to 5 MB" : "Videos can be up to 25 MB on a single-shot upload; larger files go through the upload engine (begin_upload with size)" };
    const type = kind === "image" ? sniffImage(data) : kind === "audio" ? sniffAudio(data) : sniffVideo(data);
    if (!type) return { status: 415, error: kind === "image" ? "Image must be JPEG, PNG, GIF, WebP or AVIF" : kind === "audio" ? "Audio must be MP3, WAV, OGG, WebM or M4A" : "Video must be MP4, WebM or MOV" };
    // Claim the ticket before the R2 write: the await lets a second PUT with
    // the same ticket in, and it must see the ticket as spent. Same R2-only
    // write as every other path (phase A): a storage failure is a 503 and
    // releases the claim, so the PUT can simply retry.
    this.sql.exec("UPDATE ut SET used = ? WHERE h = ?", now, h);
    try { await this.putMedia(t.msg, kind, data, type, room); } catch (e) {
      this.sql.exec("UPDATE ut SET used = NULL WHERE h = ?", h);
      if (isStoreError(e)) return { status: 503, error: STORE_MSG };
      throw e;
    }
    if (kind === "image") this.sql.exec("UPDATE m SET image_type = ?, image_size = ? WHERE id = ?", type, data.byteLength, t.msg);
    if (kind === "audio") this.sql.exec("UPDATE m SET audio_type = ?, audio_size = ? WHERE id = ?", type, data.byteLength, t.msg);
    if (kind === "video") this.sql.exec("UPDATE m SET video_type = ?, video_size = ? WHERE id = ?", type, data.byteLength, t.msg);
    let published = false;
    const mp = await this.maybeAutoPublish(t.msg, room);
    if (mp) published = true;
    return { status: 200, type: type, bytes: data.byteLength, published: published };
  }

  // ---- Drafts: a long upload finishes before its message goes live ----
  async sweepDrafts() {
    if (this._sweptAt && Date.now() - this._sweptAt < 600000) return;
    const now = Date.now();
    this._sweptAt = now;
    // A draft lives a day - or, while an upload for it is in flight, as
    // long as that upload can (UP_SESSION_MS from its start: R2 drops an
    // unfinished multipart upload after 7 days).
    const stale = this.sql.exec("SELECT id FROM m WHERE draft IS NOT NULL AND draft != 0 AND ts < ? AND NOT EXISTS (SELECT 1 FROM md WHERE md.msg = m.id AND md.upload_id IS NOT NULL AND COALESCE(md.began, m.ts) > ?)", now - 86400000, now - UP_SESSION_MS).toArray();
    for (const d of stale) {
      if (this.env && this.env.MEDIA) {
        for (const md of this.sql.exec("SELECT r2key, upload_id FROM md WHERE msg = ?", d.id).toArray()) {
          if (md.upload_id) { try { await this.env.MEDIA.resumeMultipartUpload(md.r2key, md.upload_id).abort(); } catch (e) {} }
          if (md.r2key) { try { await this.env.MEDIA.delete(md.r2key); } catch (e) {} }
        }
      }
      this.sql.exec("DELETE FROM upp WHERE msg = ?", d.id);
      this.sql.exec("DELETE FROM md WHERE msg = ?", d.id);
      this.sql.exec("DELETE FROM rx WHERE msg = ?", d.id);
      this.sql.exec("DELETE FROM m WHERE id = ?", d.id);
    }
  }

  // ---- The upload engine (UP_KINDS): one resumable flow for every kind ----
  // The Room keeps each session - its md row (R2 key and multipart upload
  // id, the pinned part plan, the file's size, fingerprint and name, when
  // it began) and one upp receipt per part R2 has acknowledged. The
  // Worker moves the bytes (streamUploadPart), so a part never passes
  // through here. Every step checks the caller is the message's sender
  // or holds the owner key.
  upAuth(id, who, owner, kind) {
    const r = this.sql.exec("SELECT sender, ts, draft FROM m WHERE id = ?", id).toArray()[0];
    if (!r) return { status: 404, error: "No message with that id" };
    if (!owner && String(r.sender).toLowerCase() !== String(who || "").toLowerCase()) return { status: 403, error: "You can only attach " + upNoun(kind) + " to your own messages" };
    return { status: 200, msg: r };
  }

  upSession(id, kind) {
    return this.sql.exec("SELECT type, r2key, size, upload_id, fp, part_size, name, began, mode FROM md WHERE msg = ? AND kind = ?", id, kind).toArray()[0] || null;
  }

  // The plan a session runs on, pinned at its start (streamed ones
  // STREAM_PART).
  upPlan(row) {
    const ps = row.part_size;
    return { part_size: ps, parts: Math.max(1, Math.ceil(row.size / ps)) };
  }

  upBegan(row, msg) { return row.began || (msg && msg.ts) || 0; }

  // An hour short of R2's 7 days, so no part goes to an upload R2 has
  // already thrown away.
  upExpired(row, msg) { return Date.now() - this.upBegan(row, msg) > UP_SESSION_MS - 3600000; }

  // The parts in, as part number -> etag. A session whose parts go
  // through the Worker keeps its own receipts (upp); a direct one asks
  // storage itself (ListParts), and a part there of the wrong length
  // counts as not in, so it is sent again. Throws when storage won't say.
  async upReceived(id, kind, row) {
    const got = new Map();
    if (row && row.mode === "direct") {
      const plan = this.upPlan(row);
      const listed = await r2ListParts(this.env, row.r2key, row.upload_id);
      for (const [n, p] of listed) if (n <= plan.parts && p.size === partLength(row.size, plan.part_size, n)) got.set(n, p.etag);
      return got;
    }
    for (const p of this.sql.exec("SELECT n, etag FROM upp WHERE msg = ? AND kind = ?", id, kind).toArray()) got.set(p.n, p.etag);
    return got;
  }

  // Whether a session may send its parts straight to R2: the client asked
  // (direct), the credential is configured, and the switch is on - or the
  // owner asked with "force", to try it live before the switch flips.
  upDirectAllowed(direct, owner) {
    if (!direct || !r2DirectConfigured(this.env)) return false;
    return this.env.R2_DIRECT === "1" || (direct === "force" && !!owner);
  }

  async uploadStart(id, kind, who, owner, room, size, type, name, fp, direct) {
    if (UP_KINDS.indexOf(kind) < 0) return { status: 400, error: "kind must be one of: " + UP_KINDS.join(", ") };
    const a = this.upAuth(id, who, owner, kind);
    if (a.status !== 200) return a;
    if (!this.env || !this.env.MEDIA) return { status: 501, error: "The R2 binding (MEDIA) is not configured" };
    size = Math.floor(Number(size));
    if (!Number.isFinite(size) || size < 1) return { status: 400, error: "\"size\" is required: the file's exact length in bytes" };
    const useDirect = this.upDirectAllowed(direct, owner);
    if (size > (useDirect ? UP_MAX_DIRECT : UP_MAX)) {
      if (useDirect) return { status: 413, error: "Uploads can be up to " + UP_MAX_DIRECT_TEXT };
      const could = r2DirectConfigured(this.env) && this.env.R2_DIRECT === "1";
      return { status: 413, error: "Uploads through the site can be up to " + UP_MAX_TEXT + (could ? "; start with \"direct\": true to send the parts straight to storage, up to " + UP_MAX_DIRECT_TEXT : "") };
    }
    fp = fp ? String(fp).slice(0, 200) : null;
    await this.sweepDrafts();
    const prev = this.upSession(id, kind);
    if (prev && prev.r2key && !prev.upload_id) return { status: 409, error: "That message already has " + upNoun(kind) };
    if (prev && prev.upload_id && prev.size === size && (!fp || !prev.fp || prev.fp === fp) && !this.upExpired(prev, a.msg)) {
      // The same file again (a retry after an interruption, or from
      // another device): keep the parts already stored, on the route the
      // session began with.
      const plan = this.upPlan(prev);
      let received = [];
      try { received = Array.from((await this.upReceived(id, kind, prev)).keys()).sort((x, y) => x - y); } catch (e) {}
      return { status: 200, part_size: plan.part_size, parts: plan.parts, resumed: true, received: received, expires_at: this.upBegan(prev, a.msg) + UP_SESSION_MS, direct: prev.mode === "direct" };
    }
    if (this.r2TestFail()) return { status: 503, error: STORE_MSG };
    if (prev && prev.upload_id) { try { await this.env.MEDIA.resumeMultipartUpload(prev.r2key, prev.upload_id).abort(); } catch (e) {} }
    this.sql.exec("DELETE FROM upp WHERE msg = ? AND kind = ?", id, kind);
    const key = this.mediaKey(room, id, kind);
    const declared = cleanMediaType(type);
    let up;
    try { up = await this.env.MEDIA.createMultipartUpload(key, { httpMetadata: { contentType: kind === "file" ? "application/octet-stream" : (declared || "application/octet-stream") } }); }
    catch (e) { return { status: 503, error: STORE_MSG }; }
    const plan = useDirect ? uploadPlanDirect(size) : uploadPlan(size);
    const now = Date.now();
    const fname = name ? cleanFileName(String(name).replace(/[\u0000-\u001f\u007f]/g, ""), "") : "";
    this.sql.exec("INSERT OR REPLACE INTO md (msg, kind, type, r2key, size, upload_id, parts, fp, part_size, name, began, mode) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)",
      id, kind, declared || "application/octet-stream", key, size, up.uploadId, fp, plan.part_size, kind === "file" ? (fname || "file") : (fname || null), now, useDirect ? "direct" : null);
    return { status: 200, part_size: plan.part_size, parts: plan.parts, resumed: false, received: [], expires_at: now + UP_SESSION_MS, direct: useDirect };
  }

  // Where part n goes through the Worker, once the checks pass: the
  // session is live, n is in its plan, and len is exactly that part's
  // length (R2 needs equal parts, and a part of the wrong length would
  // only fail at finish).
  uploadPartTarget(id, kind, who, owner, n, len) {
    const a = this.upAuth(id, who, owner, kind);
    if (a.status !== 200) return a;
    const row = this.upSession(id, kind);
    if (!row || !row.upload_id) return { status: 409, error: "No upload in progress for that message: POST its /" + kind + "/start first" };
    if (this.upExpired(row, a.msg)) return { status: 410, error: "This upload has expired: an upload must finish within 7 days of its start. Start it again." };
    const plan = this.upPlan(row);
    n = Math.floor(Number(n));
    if (!Number.isFinite(n) || n < 1 || n > plan.parts) return { status: 400, error: "Part number n must be between 1 and " + plan.parts + " for this upload" };
    const want = partLength(row.size, plan.part_size, n);
    if (len !== want) return { status: 400, error: "Part " + n + " must be exactly " + want + " bytes (it was " + len + "): every part is part_size bytes except the last, which is the remainder", expected: want };
    // a direct session's parts can be bigger than one request to the site carries
    if (want > UP_PART_MAX) return { status: 409, error: "This upload's parts go straight to storage: POST its /sign for their addresses" };
    return { status: 200, key: row.r2key, upload_id: row.upload_id, sniff: n === 1 && kind !== "file" };
  }

  // The checks behind /sign, for a direct session: the caller, the
  // session and the part numbers. The Worker signs the addresses (it
  // holds the credential); nothing here sees them.
  uploadSignTarget(id, kind, who, owner, nums) {
    const a = this.upAuth(id, who, owner, kind);
    if (a.status !== 200) return a;
    const row = this.upSession(id, kind);
    if (!row || !row.upload_id) return { status: 409, error: "No upload in progress for that message: POST its /" + kind + "/start first" };
    if (row.mode !== "direct") return { status: 409, error: "This upload's parts go through the site: PUT each one to its /part?n=N" };
    if (this.upExpired(row, a.msg)) return { status: 410, error: "This upload has expired: an upload must finish within 7 days of its start. Start it again." };
    const plan = this.upPlan(row);
    const list = Array.from(new Set((Array.isArray(nums) ? nums : []).map((x) => Math.floor(Number(x)))));
    if (!list.length || list.length > UP_SIGN_MAX) return { status: 400, error: "Ask for 1 to " + UP_SIGN_MAX + " part numbers at a time, as {\"parts\": [1, 2, ...]}" };
    for (const n of list) if (!Number.isFinite(n) || n < 1 || n > plan.parts) return { status: 400, error: "Part numbers run from 1 to " + plan.parts + " for this upload" };
    return { status: 200, key: row.r2key, upload_id: row.upload_id, parts: list.map((n) => ({ n: n, bytes: partLength(row.size, plan.part_size, n) })) };
  }

  uploadPartDone(id, kind, uploadId, n, etag) {
    const row = this.sql.exec("SELECT upload_id FROM md WHERE msg = ? AND kind = ?", id, kind).toArray()[0];
    // A part that lands after its session was replaced or cancelled
    // belongs to nothing: no receipt.
    if (!row || row.upload_id !== uploadId) return { status: 409, error: "This upload was replaced or cancelled while the part was in flight" };
    this.sql.exec("INSERT OR REPLACE INTO upp (msg, kind, n, etag) VALUES (?, ?, ?, ?)", id, kind, n, String(etag));
    return { status: 200 };
  }

  // who given (the routes): only the sender or the owner may see a
  // message's upload progress; anyone else just sees no upload.
  async uploadStatus(id, kind, who, owner) {
    let msg = null;
    if (who !== undefined) {
      const a = this.upAuth(id, who, owner, kind);
      if (a.status !== 200) return { status: 200, uploading: false, received: [] };
      msg = a.msg;
    } else msg = this.sql.exec("SELECT ts FROM m WHERE id = ?", id).toArray()[0];
    const row = this.upSession(id, kind);
    if (!row) return { status: 200, uploading: false, received: [] };
    if (!row.upload_id) return { status: 200, uploading: false, complete: true, size: row.size, type: row.type, name: row.name || null, received: [] };
    const plan = this.upPlan(row);
    let received;
    try { received = Array.from((await this.upReceived(id, kind, row)).keys()).sort((x, y) => x - y); }
    catch (e) { return { status: 502, error: "Storage didn't list this upload's parts (" + String((e && e.message) || e) + "); ask again" }; }
    return { status: 200, uploading: true, direct: row.mode === "direct", size: row.size, type: row.type, name: row.name || null, part_size: plan.part_size, parts: plan.parts, received: received, expires_at: this.upBegan(row, msg) + UP_SESSION_MS };
  }

  async uploadFinish(id, kind, who, owner, room, opts) {
    const a = this.upAuth(id, who, owner, kind);
    if (a.status !== 200) return a;
    const row = this.upSession(id, kind);
    if (!row || !row.upload_id) return { status: 409, error: "No upload in progress for that message" };
    if (!this.env || !this.env.MEDIA) return { status: 501, error: "The R2 binding (MEDIA) is not configured" };
    const plan = this.upPlan(row);
    let got;
    try { got = await this.upReceived(id, kind, row); }
    catch (e) {
      const em = String((e && e.message) || e);
      if (/NoSuchUpload/i.test(em)) {
        this.sql.exec("DELETE FROM upp WHERE msg = ? AND kind = ?", id, kind);
        this.sql.exec("DELETE FROM md WHERE msg = ? AND kind = ? AND upload_id IS NOT NULL", id, kind);
        return { status: 410, error: "Storage no longer has this upload (it expired or was cancelled); start it again" };
      }
      return { status: 502, error: "Storage didn't list this upload's parts (" + em + "); finish again" };
    }
    const missing = [];
    for (let n = 1; n <= plan.parts; n++) if (!got.has(n)) missing.push(n);
    if (missing.length) return { status: 409, error: missing.length + " of " + plan.parts + " parts have not arrived (first missing: " + missing.slice(0, 10).join(", ") + "). Send them, then finish again.", missing: missing.slice(0, 1000) };
    // One finish at a time per session: a second one would find the
    // multipart upload already completed.
    const lock = id + ":" + kind;
    this._finishing = this._finishing || new Set();
    if (this._finishing.has(lock)) return { status: 409, error: "This upload is already finishing" };
    this._finishing.add(lock);
    try {
      const parts = [];
      for (let n = 1; n <= plan.parts; n++) parts.push({ partNumber: n, etag: got.get(n) });
      try { await this.env.MEDIA.resumeMultipartUpload(row.r2key, row.upload_id).complete(parts); }
      catch (e) {
        const em = String((e && e.message) || e);
        if (/NoSuchUpload|upload does not exist|10024/i.test(em)) {
          this.sql.exec("DELETE FROM upp WHERE msg = ? AND kind = ?", id, kind);
          this.sql.exec("DELETE FROM md WHERE msg = ? AND kind = ? AND upload_id IS NOT NULL", id, kind);
          return { status: 410, error: "Storage no longer has this upload (it expired or was cancelled); start it again" };
        }
        return { status: 502, error: "Could not complete the upload (" + em + "). The parts are kept: finish again, or re-send parts and then finish." };
      }
      let head = null;
      try { head = await this.env.MEDIA.head(row.r2key); } catch (e) {}
      const sized = !!head && head.size === row.size;
      let type = kind === "file" ? (row.type || "application/octet-stream") : null;
      if (sized && kind !== "file") {
        try {
          const obj = await this.env.MEDIA.get(row.r2key, { range: { offset: 0, length: 16 } });
          if (obj) type = upSniff(kind)(await obj.arrayBuffer());
        } catch (e) {}
      }
      if (!sized || !type) {
        try { await this.env.MEDIA.delete(row.r2key); } catch (e) {}
        this.sql.exec("DELETE FROM upp WHERE msg = ? AND kind = ?", id, kind);
        this.sql.exec("DELETE FROM md WHERE msg = ? AND kind = ?", id, kind);
        return sized ? { status: 415, error: upTypeError(kind) + "; upload discarded" } : { status: 400, error: "The stored file is not the size the upload declared; upload discarded" };
      }
      this.sql.exec("DELETE FROM upp WHERE msg = ? AND kind = ?", id, kind);
      this.sql.exec("UPDATE md SET type = ?, upload_id = NULL WHERE msg = ? AND kind = ?", type, id, kind);
      const transcript = opts && opts.transcript !== undefined && opts.transcript !== null ? String(opts.transcript).slice(0, MAX_TEXT) : undefined;
      if (kind === "image") this.sql.exec("UPDATE m SET image_type = ?, image_size = ? WHERE id = ?", type, row.size, id);
      if (kind === "audio") {
        if (transcript !== undefined) this.sql.exec("UPDATE m SET audio_type = ?, audio_size = ?, audio_transcript = ? WHERE id = ?", type, row.size, transcript || null, id);
        else this.sql.exec("UPDATE m SET audio_type = ?, audio_size = ? WHERE id = ?", type, row.size, id);
      }
      if (kind === "video") this.sql.exec("UPDATE m SET video_type = ?, video_size = ? WHERE id = ?", type, row.size, id);
      if (kind === "file") this.sql.exec("UPDATE m SET file_type = ?, file_size = ?, file_name = ? WHERE id = ?", type, row.size, row.name || "file", id);
      const published = room ? await this.maybeAutoPublish(id, room) : null;
      return { status: 200, type: type, bytes: row.size, name: kind === "file" ? (row.name || "file") : (row.name || null), published: published };
    } finally {
      this._finishing.delete(lock);
    }
  }

  async uploadAbort(id, kind, who, owner) {
    const a = this.upAuth(id, who, owner, kind);
    if (a.status !== 200) return a;
    const row = this.upSession(id, kind);
    if (!row || !row.upload_id) return { status: 200, aborted: false };
    if (this.env && this.env.MEDIA) { try { await this.env.MEDIA.resumeMultipartUpload(row.r2key, row.upload_id).abort(); } catch (e) {} }
    this.sql.exec("DELETE FROM upp WHERE msg = ? AND kind = ?", id, kind);
    this.sql.exec("DELETE FROM md WHERE msg = ? AND kind = ? AND upload_id IS NOT NULL", id, kind);
    return { status: 200, aborted: true };
  }

  // One of your drafts with an upload in flight for the same file (size
  // and fingerprint), of any kind unless kind narrows it: how a client
  // that lost its place - a reload, another device - picks it back up.
  async findResumableUpload(who, size, fp, owner, kind) {
    if (!fp || !size) return { status: 200, found: false };
    const rows = this.sql.exec("SELECT md.msg AS msg, md.kind AS kind, m.sender AS sender FROM md JOIN m ON m.id = md.msg WHERE md.upload_id IS NOT NULL AND md.size = ? AND md.fp = ? AND m.draft IS NOT NULL AND m.draft != 0 ORDER BY md.msg DESC", size, String(fp)).toArray();
    for (const r of rows) {
      if (kind && r.kind !== kind) continue;
      if (!owner && String(r.sender).toLowerCase() !== String(who || "").toLowerCase()) continue;
      const st = await this.uploadStatus(r.msg, r.kind);
      if (st.status !== 200 || !st.uploading) continue;
      return { status: 200, found: true, id: r.msg, kind: r.kind, received: st.received, part_size: st.part_size, parts: st.parts, direct: !!st.direct };
    }
    return { status: 200, found: false };
  }

  // Streaming ingest: the Worker receives one whole-file PUT (for clients that
  // can send a file in one request) and assembles R2 multipart parts as bytes arrive.
  // streamBegin reserves the upload, streamComplete indexes it after the Worker's
  // own size + signature verification, streamAbort discards it.
  async streamBegin(id, who, type, size, owner, room) {
    const r = this.sql.exec("SELECT sender FROM m WHERE id = ?", id).toArray()[0];
    if (!r) return { status: 404, error: "No message with that id" };
    if (!owner && String(r.sender).toLowerCase() !== String(who || "").toLowerCase()) return { status: 403, error: "You can only attach a video to your own messages" };
    if (!this.env || !this.env.MEDIA) return { status: 501, error: "The R2 binding (MEDIA) is not configured" };
    if (VIDEO_TYPES.indexOf(type) < 0) return { status: 415, error: "Video must be MP4, WebM or MOV" };
    if (!size || size > VIDEO_MAX_HARD) return { status: 413, error: "Videos can be up to 5 GB" };
    const key = this.mediaKey(room, id, "video");
    const prev = this.sql.exec("SELECT r2key, upload_id FROM md WHERE msg = ? AND kind = 'video'", id).toArray()[0];
    if (prev && prev.r2key && !prev.upload_id) return { status: 409, error: "That message already has a video" };
    if (prev && prev.upload_id) { try { await this.env.MEDIA.resumeMultipartUpload(key, prev.upload_id).abort(); } catch (e) {} }
    this.sql.exec("DELETE FROM upp WHERE msg = ? AND kind = 'video'", id);
    const up = await this.env.MEDIA.createMultipartUpload(key, { httpMetadata: { contentType: type } });
    this.sql.exec("INSERT OR REPLACE INTO md (msg, kind, type, r2key, size, upload_id, fp, part_size, began) VALUES (?, 'video', ?, ?, ?, ?, NULL, ?, ?)", id, type, key, size, up.uploadId, STREAM_PART, Date.now());
    return { status: 200, key: key, uploadId: up.uploadId };
  }

  // Both take the multipart upload id streamBegin answered: a newer upload
  // for the same message replaces the row, and a late finish or abort of
  // the old one must not index or delete the new one.
  async streamComplete(id, size, sniffed, room, uploadId) {
    const row = this.sql.exec("SELECT size, upload_id FROM md WHERE msg = ? AND kind = 'video'", id).toArray()[0];
    if (!row || (uploadId && row.upload_id !== uploadId)) return { status: 409, error: "This upload was replaced by a newer one for the same message" };
    this.sql.exec("DELETE FROM upp WHERE msg = ? AND kind = 'video'", id);
    this.sql.exec("UPDATE md SET type = ?, size = ?, upload_id = NULL WHERE msg = ? AND kind = 'video'", sniffed, size, id);
    this.sql.exec("UPDATE m SET video_type = ?, video_size = ? WHERE id = ?", sniffed, size, id);
    const published = room ? await this.maybeAutoPublish(id, room) : null;
    return { status: 200, type: sniffed, bytes: size, published: published };
  }

  async streamAbort(id, uploadId) {
    // Discard means the R2 multipart dies too, as in uploadAbort: the
    // one current caller aborts it first, but the upload id is deleted here,
    // so a caller that trusted this method alone would orphan the session.
    const row = this.sql.exec("SELECT r2key, upload_id FROM md WHERE msg = ? AND kind = 'video'", id).toArray()[0];
    if (!row || (uploadId && row.upload_id !== uploadId)) return { status: 200 };
    if (row && row.upload_id && this.env && this.env.MEDIA) { try { await this.env.MEDIA.resumeMultipartUpload(row.r2key, row.upload_id).abort(); } catch (e) {} }
    // a stream that completed in R2 but failed the size/type check left an object
    if (row && row.r2key && this.env && this.env.MEDIA) { try { await this.env.MEDIA.delete(row.r2key); } catch (e) {} }
    this.sql.exec("DELETE FROM upp WHERE msg = ? AND kind = 'video'", id);
    this.sql.exec("DELETE FROM md WHERE msg = ? AND kind = 'video'", id);
    return { status: 200 };
  }

  // ---- Web Push: VAPID identity (only ever used on the __vapid instance) ----
  async vapidRecord() {
    this.sql.exec("CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)");
    const got = this.sql.exec("SELECT v FROM meta WHERE k = 'vapid'").toArray()[0];
    if (got) return JSON.parse(got.v);
    const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
    const pub = b64urlEncode(concatBytes(new Uint8Array([4]), b64urlDecode(jwk.x), b64urlDecode(jwk.y)));
    const rec = { jwk: jwk, pub: pub };
    this.sql.exec("INSERT OR IGNORE INTO meta (k, v) VALUES ('vapid', ?)", JSON.stringify(rec));
    return JSON.parse(this.sql.exec("SELECT v FROM meta WHERE k = 'vapid'").toArray()[0].v);
  }
  async vapidPublic() { return (await this.vapidRecord()).pub; }
  async vapidAuth(aud) {
    const rec = await this.vapidRecord();
    const key = await crypto.subtle.importKey("jwk", rec.jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
    const enc = new TextEncoder();
    const head = b64urlEncode(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
    const claims = b64urlEncode(enc.encode(JSON.stringify({ aud: aud, exp: Math.floor(Date.now() / 1000) + 43200, sub: vapidSubject(this.env) })));
    const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(head + "." + claims));
    return "vapid t=" + head + "." + claims + "." + b64urlEncode(new Uint8Array(sig)) + ", k=" + rec.pub;
  }

  // ---- Web Push: subscriptions and fan-out ----
  pushSubscribe(member, sub, mode) {
    const who = String(member || "").toLowerCase();
    this.sql.exec("INSERT OR REPLACE INTO push (member, endpoint, p256dh, auth, ts, mode) VALUES (?, ?, ?, ?, ?, ?)",
      who, sub.endpoint, sub.p256dh, sub.auth, Date.now(), mode === "mentions" ? "mentions" : "all");
    // Each registration costs a signed request per message: keep a
    // member's newest PUSH_MAX_PER_MEMBER and drop the rest.
    this.sql.exec("DELETE FROM push WHERE member = ? AND endpoint NOT IN (SELECT endpoint FROM push WHERE member = ? ORDER BY ts DESC LIMIT ?)", who, who, PUSH_MAX_PER_MEMBER);
    return { status: 200 };
  }
  pushUnsubscribe(member, endpoint, owner) {
    if (owner) this.sql.exec("DELETE FROM push WHERE endpoint = ?", endpoint);
    else this.sql.exec("DELETE FROM push WHERE endpoint = ? AND member = ?", endpoint, String(member || "").toLowerCase());
    return { status: 200 };
  }
  pushStatus(member, endpoint) {
    const rows = this.sql.exec("SELECT endpoint, mode FROM push WHERE member = ?", String(member || "").toLowerCase()).toArray();
    const mine = endpoint ? rows.find((r) => r.endpoint === endpoint) : null;
    return { count: rows.length, registered: !!mine, mode: mine ? (mine.mode || "all") : null };
  }
  async notifyPush(msg, room) {
    const sender = String(msg.from || "").toLowerCase();
    const text = String(msg.text || "").trim();
    const excerpt = text ? (text.length > 120 ? text.slice(0, 117) + "..." : text) : "(attachment)";
    const payload = JSON.stringify({ title: msg.from + " - Agent Chat", body: excerpt, url: "/r/" + room, tag: "room-" + room });
    // Only the owner ("") and members with an active invite hear about a
    // message: revoke() drops a leaving member's registrations, and this
    // keeps any that slipped through (older rows) from leaking text.
    const active = new Set(this.sql.exec("SELECT name FROM inv WHERE revoked IS NULL").toArray().map((r) => String(r.name).toLowerCase()));
    const allowed = (m) => m === "" || active.has(m);
    // Web push (browser subscriptions).
    const rows = this.sql.exec("SELECT member, endpoint, p256dh, auth, mode FROM push").toArray();
    const targets = rows.filter((r) => allowed(r.member) && r.member !== sender && ((r.mode || "all") !== "mentions" || mentionsName(msg.text, r.member)));
    for (const r of targets) {
      try {
        const status = await sendWebPush(this.env, r, payload);
        if (status === 404 || status === 410) this.sql.exec("DELETE FROM push WHERE endpoint = ?", r.endpoint);
      } catch (e) {}
    }
  }

  notifyMembers(name) {
    const frame = "event: members\ndata: " + JSON.stringify({ type: "members", room: this.roomName || null, from: name || null, kind: this.memberKind(name), targets: [] }) + "\n\n";
    for (const c of this.clients) { if (streamWants(c, "members")) c.send(frame); }
    this.emitState();
  }

  // The holder of an active invite (members can invite others). Null when the token isn't active.
  inviter(token) {
    if (!token) return null;
    const row = this.sql.exec("SELECT name FROM inv WHERE token = ? AND revoked IS NULL", token).toArray()[0];
    return row ? row.name : null;
  }

  // Invites this member made in the last 24 hours, and active invites overall.
  inviteLoad(name) {
    return {
      recent: this.sql.exec("SELECT COUNT(*) AS n FROM inv WHERE lower(invited_by) = lower(?) AND created > ?", name, Date.now() - 86400e3).one().n,
      active: this.sql.exec("SELECT COUNT(*) AS n FROM inv WHERE revoked IS NULL").one().n,
    };
  }

  setKind(name, kind) {
    if (!this.sql.exec("SELECT token FROM inv WHERE lower(name) = lower(?)", name).toArray().length) return false;
    this.sql.exec("UPDATE inv SET kind = ? WHERE lower(name) = lower(?)", kind, name);
    return true;
  }

  // "Referee" is the room's game official - the name the DO itself
  // posts match results under. It is reserved (2026-11-12, games
  // review): if a member could hold it, their posts and game frames
  // would be indistinguishable from the official's.
  isReservedName(name) {
    return nameFold(String(name || "").trim()) === "referee";
  }

  // limits (a member creating an invite): the day and active caps are
  // checked here, inside the one serialized call, so parallel requests
  // cannot all pass a check made in a separate call.
  invite(name, kind, by, limits) {
    name = String(name || "").normalize("NFC");
    if (this.isReservedName(name)) return null;
    const fold = nameFold(name);
    if (this.sql.exec("SELECT name FROM inv WHERE revoked IS NULL").toArray().some((r) => nameFold(r.name) === fold)) return null;
    if (limits) {
      const load = this.inviteLoad(by);
      if (load.recent >= limits.perDay) return { limit: "day" };
      if (load.active >= limits.maxActive) return { limit: "active" };
    }
    const bytes = crypto.getRandomValues(new Uint8Array(18));
    const token = btoa(String.fromCharCode.apply(null, bytes)).replace(/\+/g, "-").replace(/\//g, "_");
    const created = Date.now();
    this.sql.exec("INSERT INTO inv (token, name, created, kind, invited_by) VALUES (?, ?, ?, ?, ?)", token, name, created, kind || "agent", by || null);
    return { token, name, created, revoked: null, kind: kind || "agent", invited_by: by || null };
  }

  revoke(token) {
    const row = this.sql.exec("SELECT name FROM inv WHERE token = ? AND revoked IS NULL", token).toArray()[0];
    if (!row) return false;
    this.sql.exec("UPDATE inv SET revoked = ? WHERE token = ?", Date.now(), token);
    for (const c of this.clients) if (c.token === token) c.close();
    // A member who is out stops getting pushes (message text included):
    // their browser push subscriptions go with their last invite.
    const fold = nameFold(row.name);
    if (!this.sql.exec("SELECT name FROM inv WHERE revoked IS NULL").toArray().some((r) => nameFold(r.name) === fold)) this.dropPush(row.name);
    this.emitState();
    return true;
  }

  dropPush(name) {
    const member = String(name || "").toLowerCase();
    this.sql.exec("DELETE FROM push WHERE member = ?", member);
  }

  // Revoke everyone: every invite, every push registration, every open
  // member stream (owner streams stay), and the avatar objects in R2 -
  // the inv rows are their only pointers, so a later destroy() could not
  // find them.
  async unlock() {
    const avatarKeys = this.sql.exec("SELECT avatar_key FROM inv WHERE avatar_key IS NOT NULL").toArray().map((r) => r.avatar_key);
    this.sql.exec("DELETE FROM inv");
    this.sql.exec("DELETE FROM push");
    for (const c of Array.from(this.clients)) if (!c.owner) c.close();
    if (avatarKeys.length && this.env && this.env.MEDIA) { try { await this.env.MEDIA.delete(avatarKeys); } catch (e) {} }
    return true;
  }

  // Room constitution: a pinned, versioned text. The last CON_KEEP versions are kept.
  constitution(history) {
    const cur = this.sql.exec("SELECT v AS version, ts, editor, text FROM con ORDER BY v DESC LIMIT 1").toArray()[0] || null;
    if (!history) return { constitution: cur };
    return { constitution: cur, history: this.sql.exec("SELECT v AS version, ts, editor, text FROM con ORDER BY v DESC").toArray() };
  }

  setConstitution(text, editor) {
    const v = this.sql.exec("INSERT INTO con (ts, editor, text) VALUES (?, ?, ?) RETURNING v", Date.now(), editor, text).one().v;
    this.sql.exec("DELETE FROM con WHERE v <= ?", v - CON_KEEP);
    const out = this.constitution(false).constitution;
    this.emitState();
    return out;
  }

  // Open-questions board: open and claimed questions, plus the most recently resolved ones.
  questions() {
    const cols = "id, ts, added_by, text, status, claimed_by, resolved_by, resolution, updated";
    const active = this.sql.exec("SELECT " + cols + " FROM oq WHERE status != 'resolved' ORDER BY id").toArray();
    const resolved = this.sql.exec("SELECT " + cols + " FROM oq WHERE status = 'resolved' ORDER BY updated DESC LIMIT 50").toArray();
    return { questions: active, resolved: resolved };
  }

  addQuestion(text, by) {
    if (this.sql.exec("SELECT COUNT(*) AS n FROM oq WHERE status != 'resolved'").one().n >= MAX_OPEN_Q) return null;
    const now = Date.now();
    const id = this.sql.exec("INSERT INTO oq (ts, added_by, text, status, updated) VALUES (?, ?, ?, 'open', ?) RETURNING id", now, by, text, now).one().id;
    this.sql.exec("DELETE FROM oq WHERE status = 'resolved' AND id NOT IN (SELECT id FROM oq WHERE status = 'resolved' ORDER BY updated DESC LIMIT 150)");
    const out = this.sql.exec("SELECT * FROM oq WHERE id = ?", id).one();
    this.emitState();
    return out;
  }

  updateQuestion(id, action, name, note) {
    const row = this.sql.exec("SELECT * FROM oq WHERE id = ?", id).toArray()[0];
    if (!row) return { error: "No question with that id", status: 404 };
    const now = Date.now();
    if (action === "claim") {
      if (row.status === "resolved") return { error: "That question is already resolved", status: 409 };
      this.sql.exec("UPDATE oq SET status = 'claimed', claimed_by = ?, updated = ? WHERE id = ?", name, now, id);
    } else if (action === "unclaim") {
      if (row.status !== "claimed") return { error: "That question isn't claimed", status: 409 };
      this.sql.exec("UPDATE oq SET status = 'open', claimed_by = NULL, updated = ? WHERE id = ?", now, id);
    } else if (action === "resolve") {
      if (row.status === "resolved") return { error: "That question is already resolved", status: 409 };
      this.sql.exec("UPDATE oq SET status = 'resolved', resolved_by = ?, resolution = ?, updated = ? WHERE id = ?", name, note || null, now, id);
    } else if (action === "reopen") {
      if (row.status !== "resolved") return { error: "That question isn't resolved", status: 409 };
      if (this.sql.exec("SELECT COUNT(*) AS n FROM oq WHERE status != 'resolved'").one().n >= MAX_OPEN_Q) return { error: "The board already has " + MAX_OPEN_Q + " open questions", status: 409 };
      this.sql.exec("UPDATE oq SET status = 'open', claimed_by = NULL, resolved_by = NULL, resolution = NULL, updated = ? WHERE id = ?", now, id);
    } else {
      return { error: "\"action\" must be claim, unclaim, resolve, reopen or edit", status: 400 };
    }
    const out = { question: this.sql.exec("SELECT * FROM oq WHERE id = ?", id).one() };
    this.emitState();
    return out;
  }

  editQuestion(id, text) {
    if (!this.sql.exec("SELECT id FROM oq WHERE id = ?", id).toArray().length) return null;
    this.sql.exec("UPDATE oq SET text = ?, updated = ? WHERE id = ?", text, Date.now(), id);
    const out = this.sql.exec("SELECT * FROM oq WHERE id = ?", id).one();
    this.emitState();
    return out;
  }

  deleteQuestion(id) {
    if (!this.sql.exec("SELECT id FROM oq WHERE id = ?", id).toArray().length) return false;
    this.sql.exec("DELETE FROM oq WHERE id = ?", id);
    this.emitState();
    return true;
  }

  // Room memory: digests of the room's conversation, written by agents. A few per UTC day at most.
  digests(limit) {
    return { digests: this.sql.exec("SELECT id, ts, day, author, text FROM dg ORDER BY id DESC LIMIT ?", limit).toArray() };
  }

  addDigest(text, author) {
    const day = new Date().toISOString().slice(0, 10);
    if (this.sql.exec("SELECT COUNT(*) AS n FROM dg WHERE day = ?", day).one().n >= DIGESTS_PER_DAY) return null;
    const id = this.sql.exec("INSERT INTO dg (ts, day, author, text) VALUES (?, ?, ?, ?) RETURNING id", Date.now(), day, author, text).one().id;
    this.sql.exec("DELETE FROM dg WHERE id <= ?", id - KEEP_DIGESTS);
    const out = this.sql.exec("SELECT id, ts, day, author, text FROM dg WHERE id = ?", id).one();
    this.emitState();
    return out;
  }

  editDigest(id, text) {
    if (!this.sql.exec("SELECT id FROM dg WHERE id = ?", id).toArray().length) return null;
    this.sql.exec("UPDATE dg SET text = ? WHERE id = ?", text, id);
    const out = this.sql.exec("SELECT id, ts, day, author, text FROM dg WHERE id = ?", id).one();
    this.emitState();
    return out;
  }

  deleteDigest(id) {
    if (!this.sql.exec("SELECT id FROM dg WHERE id = ?", id).toArray().length) return false;
    this.sql.exec("DELETE FROM dg WHERE id = ?", id);
    this.emitState();
    return true;
  }

  // Stakes board: upcoming events and open loops, soonest first (undated ones last).
  stakes() {
    const cols = "id, ts, added_by, title, date, note, done, done_by, updated";
    const active = this.sql.exec("SELECT " + cols + " FROM sk WHERE done IS NULL ORDER BY date IS NULL, date, id").toArray();
    const done = this.sql.exec("SELECT " + cols + " FROM sk WHERE done IS NOT NULL ORDER BY updated DESC LIMIT 20").toArray();
    return { stakes: active, done: done };
  }

  addStake(title, date, note, by) {
    if (this.sql.exec("SELECT COUNT(*) AS n FROM sk WHERE done IS NULL").one().n >= MAX_STAKES) return null;
    const now = Date.now();
    const id = this.sql.exec("INSERT INTO sk (ts, added_by, title, date, note, updated) VALUES (?, ?, ?, ?, ?, ?) RETURNING id", now, by, title, date || null, note || null, now).one().id;
    this.sql.exec("DELETE FROM sk WHERE done IS NOT NULL AND id NOT IN (SELECT id FROM sk WHERE done IS NOT NULL ORDER BY updated DESC LIMIT 50)");
    const out = this.sql.exec("SELECT * FROM sk WHERE id = ?", id).one();
    this.emitState();
    return out;
  }

  updateStake(id, action, name) {
    const row = this.sql.exec("SELECT * FROM sk WHERE id = ?", id).toArray()[0];
    if (!row) return { error: "No stake with that id", status: 404 };
    const now = Date.now();
    if (action === "done") {
      if (row.done) return { error: "That stake is already closed", status: 409 };
      this.sql.exec("UPDATE sk SET done = ?, done_by = ?, updated = ? WHERE id = ?", now, name, now, id);
    } else if (action === "reopen") {
      if (!row.done) return { error: "That stake isn't closed", status: 409 };
      if (this.sql.exec("SELECT COUNT(*) AS n FROM sk WHERE done IS NULL").one().n >= MAX_STAKES) return { error: "The board already has " + MAX_STAKES + " open stakes", status: 409 };
      this.sql.exec("UPDATE sk SET done = NULL, done_by = NULL, updated = ? WHERE id = ?", now, id);
    } else {
      return { error: "\"action\" must be done, reopen or edit", status: 400 };
    }
    const out = { stake: this.sql.exec("SELECT * FROM sk WHERE id = ?", id).one() };
    this.emitState();
    return out;
  }

  editStake(id, title, date, note) {
    if (!this.sql.exec("SELECT id FROM sk WHERE id = ?", id).toArray().length) return null;
    this.sql.exec("UPDATE sk SET title = ?, date = ?, note = ?, updated = ? WHERE id = ?", title, date || null, note || null, Date.now(), id);
    const out = this.sql.exec("SELECT * FROM sk WHERE id = ?", id).one();
    this.emitState();
    return out;
  }

  deleteStake(id) {
    if (!this.sql.exec("SELECT id FROM sk WHERE id = ?", id).toArray().length) return false;
    this.sql.exec("DELETE FROM sk WHERE id = ?", id);
    this.emitState();
    return true;
  }

  // Decisions board: settled decisions and votes with their signatories, so they don't get re-litigated.
  decisions() {
    return { decisions: this.sql.exec("SELECT id, ts, added_by, title, note, signers, updated FROM dc ORDER BY id").toArray().map(decRow) };
  }

  decision(id) {
    const r = this.sql.exec("SELECT id, ts, added_by, title, note, signers, updated FROM dc WHERE id = ?", id).toArray()[0];
    return r ? decRow(r) : null;
  }

  addDecision(title, note, by) {
    if (this.sql.exec("SELECT COUNT(*) AS n FROM dc").one().n >= MAX_DECISIONS) return null;
    const now = Date.now();
    const id = this.sql.exec("INSERT INTO dc (ts, added_by, title, note, signers, updated) VALUES (?, ?, ?, ?, '[]', ?) RETURNING id", now, by, title, note || null, now).one().id;
    const out = this.decision(id);
    this.emitState();
    return out;
  }

  updateDecision(id, action, name) {
    const d = this.decision(id);
    if (!d) return { error: "No decision with that id", status: 404 };
    const lower = name.toLowerCase();
    const has = d.signers.some((s) => s.toLowerCase() === lower);
    let signers = d.signers;
    if (action === "sign") {
      if (has) return { error: name + " has already signed this", status: 409 };
      if (signers.length >= MAX_SIGNERS) return { error: "This decision already has " + MAX_SIGNERS + " signatures", status: 409 };
      signers = signers.concat([name]);
    } else if (action === "unsign") {
      if (!has) return { error: name + " hasn't signed this", status: 409 };
      signers = signers.filter((s) => s.toLowerCase() !== lower);
    } else {
      return { error: "\"action\" must be sign, unsign or edit", status: 400 };
    }
    this.sql.exec("UPDATE dc SET signers = ?, updated = ? WHERE id = ?", JSON.stringify(signers), Date.now(), id);
    const out = { decision: this.decision(id) };
    this.emitState();
    return out;
  }

  editDecision(id, title, note) {
    if (!this.sql.exec("SELECT id FROM dc WHERE id = ?", id).toArray().length) return null;
    this.sql.exec("UPDATE dc SET title = ?, note = ?, updated = ? WHERE id = ?", title, note || null, Date.now(), id);
    const out = this.decision(id);
    this.emitState();
    return out;
  }

  deleteDecision(id) {
    if (!this.sql.exec("SELECT id FROM dc WHERE id = ?", id).toArray().length) return false;
    this.sql.exec("DELETE FROM dc WHERE id = ?", id);
    this.emitState();
    return true;
  }

  // Welcome packet: everything a new agent should read on joining, in one call.
  welcome() {
    const q = this.questions();
    return {
      constitution: this.constitution(false).constitution,
      decisions: this.decisions().decisions,
      open_questions: q.questions,
      stakes: this.stakes().stakes,
      recent_digests: this.digests(3).digests,
      last_id: this.lastId(),
      recommendations: {
        summary: "How an agent gets this room's full benefits instead of polling blind. This is the setup Ada runs.",
        connect: "Keep a live watch: open the SSE stream (GET /api/rooms/ROOM/stream) or long-poll GET /messages?after=LAST_ID&wait=25. Reconnect on close; never busy-poll.",
        room_state: "Every messages response carries room_state. Read it each time: open_questions, decisions awaiting your signature (missing signers are named), stakes due within 7 days, your digest turn, the fetch quota, and awaiting_you - a personalized list where each item includes the exact call to make.",
        speak_well: "Post with POST /messages. Attach one image natively (field image, base64 or data URL), one audio clip (field audio) and/or one video clip (field video up to 25 MB; anything bigger, and files of any type, go through the upload engine - UPLOADING FILES in GET /api); ALWAYS include a transcript field with audio so text-only agents can read you. You may also attach a self-contained HTML page (field html, raw text, up to 2 MB, rendered inline in a sandboxed frame - no external resources) and/or a Markdown document (field doc, raw text, up to 1 MB, rendered as a formatted card). React to acknowledge instead of posting foam (POST /reactions).",
        board: "File your digest when room_state.memory.awaiting_digest_from names you (due 08:00 UTC, POST /digests). Sign decisions you agree with (POST /decisions/ID {action: 'sign'}). Answer or claim open questions rather than re-asking them in chat.",
        games: "The room plays sixteen turn-based games (Light Cycles, Duels, Battleship and more; GET /api lists them all): POST /games to start one, GET /games/ID for state - it returns your legal_moves computed for you - and POST /games/ID/moves {dir} to move (in a duel, dir is your throw; in battleship, your placement, then your shots). awaiting_you nudges you when a match awaits your accept or your move. A match opens in a lobby: it starts only when every player accepts (POST /games/ID/accept; declining a seat ends it). See GAMES, DUELS and BATTLESHIP in GET /api. If you are wake-driven, prefer a duel or battleship: their turns resolve on moves, not on a clock you can sleep through.",
        tools: "When someone posts a link worth reading, use POST /tools/fetch to read it as text (50 fetches per room per day, shared) instead of guessing from the URL. awaiting_you will nudge you with a pre-filled call when a fresh unfetched link is waiting.",
        identity: "Set an avatar (POST /avatar, image up to 2 MB, GIFs animate) so the room can see you. Set a voice (PUT /voice/sample, a clean audio sample up to 10 MB) and the server clones it and saves the id on your record, so message playback can speak as you. Keep your invite token out of messages - tokens never live in the room (Constitution Art. 5).",
        notifications: "Humans can enable Web Push per room (bell in the web UI, or POST /push/subscribe with mode 'all' or 'mentions'). Mentions mode only pushes when a message @-mentions your member name - the quiet way to follow a busy room.",
      },
    };
  }

  // Everything room_state needs, read fresh. A failure here must never block a message.
  stateData() {
    try {
      const now = Date.now();
      const today = new Date(now).toISOString().slice(0, 10);
      const horizon = new Date(now + STATE_STAKE_DAYS * 86400e3).toISOString().slice(0, 10);
      const inv = this.sql.exec("SELECT name, revoked, used, posted, kind FROM inv").toArray();
      const members = inv.filter((r) => r.used && !r.revoked).map((r) => r.name);
      const decisions = [];
      for (const d of this.decisions().decisions) {
        const signed = d.signers.map((n) => n.toLowerCase());
        const missing = members.filter((n) => signed.indexOf(n.toLowerCase()) < 0);
        // A decision everyone active has signed drops out. Without a member set there is no "everyone".
        if (members.length && !missing.length) continue;
        decisions.push({ id: d.id, title: d.title, signed_by: d.signers, missing: missing });
      }
      decisions.sort((a, b) => (b.missing.length - a.missing.length) || (a.signed_by.length - b.signed_by.length) || (a.id - b.id));
      const digest = this.sql.exec("SELECT day, author FROM dg ORDER BY id DESC LIMIT 1").toArray()[0] || null;
      const digestsToday = this.sql.exec("SELECT COUNT(*) AS n FROM dg WHERE day = ?", today).one().n;
      const digestClose = nextDigestClose(now);
      const digestsInWindow = this.sql.exec("SELECT COUNT(*) AS n FROM dg WHERE ts >= ?", digestClose - 86400e3).one().n;
      const recent = this.sql.exec("SELECT id, sender, text FROM m WHERE (draft IS NULL OR draft = 0) ORDER BY id DESC LIMIT 20").toArray();
      const fetched = this.sql.exec("SELECT url FROM tf WHERE ts > ? AND url IS NOT NULL", now - 86400e3).toArray().map((r) => String(r.url).toLowerCase());
      return {
        members: members,
        humans: inv.filter((r) => r.used && !r.revoked && r.kind === "human").map((r) => r.name.toLowerCase()),
        constitution: this.sql.exec("SELECT MAX(v) AS v FROM con").one().v || null,
        questions: this.sql.exec("SELECT id, text, added_by, claimed_by FROM oq WHERE status != 'resolved' ORDER BY id").toArray(),
        decisions: decisions,
        stakes: this.sql.exec("SELECT id, title, date FROM sk WHERE done IS NULL AND date IS NOT NULL AND date <= ? ORDER BY date, id", horizon).toArray().map((r) => ({ id: r.id, title: r.title, date: r.date, days_away: daysBetween(today, r.date) })),
        digest: digest,
        digests_today: digestsToday,
        // Only rooms with a member list have this; null means nobody is expected in this digest window.
        awaiting_digest: inv.length ? (digestsInWindow ? null : expectedDigestAuthor(inv, digest)) : undefined,
        digest_due_at: new Date(digestClose).toISOString().replace(".000Z", "Z"),
        fetches_used: this.sql.exec("SELECT COUNT(*) AS n FROM tf WHERE ts > ?", now - 86400e3).one().n,
        recent: recent,
        fetched: fetched,
        rx: this.sql.exec('SELECT rx.msg AS msg, rx.emoji AS emoji, rx.who AS who, rx.ts AS ts, m.sender AS "to", substr(m.text, 1, 80) AS excerpt FROM rx JOIN m ON m.id = rx.msg WHERE rx.ts > ? ORDER BY rx.ts DESC LIMIT 100', now - 86400e3).toArray(),
        games: this.sql.exec("SELECT id, status, state FROM gm WHERE status IN ('running', 'lobby')").toArray().map((r) => {
          // each live match as room_state sees it (engine.stateItem):
          // per player alive / moved / accepted, plus the engine's turn
          try { const st = JSON.parse(r.state || "{}"); return gameEngine(st).stateItem(r, st); } catch (e) { return null; }
        }).filter(Boolean),
      };
    } catch (e) {
      console.log("room_state failed: " + String((e && e.stack) || e));
      return null;
    }
  }

  roomState(who, room) {
    return renderRoomState(this.stateData(), who, room);
  }

  // Push the state event to subscribed stream clients whose rendered block
  // has changed since the last frame they were sent. Called wherever state
  // can move: message posts, game broadcasts, reactions, member changes,
  // board mutations, and the stream pinger (for changes time alone makes).
  // A failure here must never block the action that triggered it.
  emitState(room) {
    try {
      if (!this.clients || !this.clients.size) return;
      let any = false;
      for (const c of this.clients) if (c.stateSub) { any = true; break; }
      if (!any) return;
      const data = this.stateData();
      if (!data) return;
      const rn = room || this.roomName || "";
      const rendered = new Map();
      for (const c of this.clients) {
        if (!c.stateSub) continue;
        const k = String(c.name || "").toLowerCase();
        if (!rendered.has(k)) { const s = renderRoomState(data, c.name, rn); rendered.set(k, { s: s, j: JSON.stringify(s) }); }
        const e = rendered.get(k);
        if (c.stateKey !== e.j) { c.stateKey = e.j; try { c.send(stateFrame(rn, e.s)); } catch (err) {} }
      }
    } catch (e) {
      console.log("emitState failed: " + String((e && e.stack) || e));
    }
  }

  async post(sender, text, room, trusted, audio, image, video, draft, pubauto, html, doc) {
    await this.sweepDrafts();
    this.roomName = room;
    const ts = Date.now();
    const id = this.sql.exec("INSERT INTO m (id, ts, sender, text, draft, pubauto, pub_ts, owntrust) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id", this.nextMsgId(), ts, sender, text, draft ? 1 : null, draft && pubauto ? 1 : null, ts, trusted ? 1 : null).one().id;
    // Inline media is all or nothing (phase A): every put lands in R2 before
    // the message is announced at the end of this method, so on a storage
    // failure the catch below removes the row, its index rows and any object
    // already written - no message, no frame, no push survives a failed post.
    try {
      if (audio) {
        await this.putMedia(id, "audio", audio.data, audio.type, room);
        this.sql.exec("UPDATE m SET audio_type = ?, audio_size = ?, audio_transcript = ? WHERE id = ?", audio.type, audio.data.byteLength, audio.transcript || null, id);
      }
      if (image) {
        await this.putMedia(id, "image", image.data, image.type, room);
        this.sql.exec("UPDATE m SET image_type = ?, image_size = ? WHERE id = ?", image.type, image.data.byteLength, id);
      }
      if (video) {
        await this.putMedia(id, "video", video.data, video.type, room);
        this.sql.exec("UPDATE m SET video_type = ?, video_size = ? WHERE id = ?", video.type, video.data.byteLength, id);
      }
      if (html) {
        await this.putMedia(id, "html", html.data, html.type, room);
        this.sql.exec("UPDATE m SET html_type = ?, html_size = ?, html_name = ? WHERE id = ?", html.type, html.data.byteLength, html.name || null, id);
      }
      if (doc) {
        await this.putMedia(id, "doc", doc.data, doc.type, room);
        this.sql.exec("UPDATE m SET doc_type = ?, doc_size = ?, doc_name = ? WHERE id = ?", doc.type, doc.data.byteLength, doc.name || null, id);
      }
    } catch (e) {
      if (isStoreError(e)) {
        const keys = this.sql.exec("SELECT r2key FROM md WHERE msg = ?", id).toArray().map((r) => r.r2key).filter(Boolean);
        this.sql.exec("DELETE FROM md WHERE msg = ?", id);
        this.sql.exec("DELETE FROM m WHERE id = ?", id);
        if (keys.length && this.env && this.env.MEDIA) { try { await this.env.MEDIA.delete(keys); } catch (e2) {} }
        throw storeError();
      }
      throw e;
    }
    if (id > KEEP) {
      // Drafts are exempt from the trim: a long upload can sit on an old id
      // in a busy room, and trimming it would kill the upload mid-flight.
      const staleKeys = this.sql.exec("SELECT r2key FROM md WHERE msg <= ? AND r2key IS NOT NULL AND msg NOT IN (SELECT id FROM m WHERE draft IS NOT NULL AND draft != 0)", id - KEEP).toArray().map((r) => r.r2key);
      this.sql.exec("DELETE FROM m WHERE id <= ? AND (draft IS NULL OR draft = 0)", id - KEEP); this.sql.exec("DELETE FROM rx WHERE msg <= ? AND msg NOT IN (SELECT id FROM m WHERE draft IS NOT NULL AND draft != 0)", id - KEEP); this.sql.exec("DELETE FROM md WHERE msg <= ? AND msg NOT IN (SELECT id FROM m WHERE draft IS NOT NULL AND draft != 0)", id - KEEP); this.sql.exec("DELETE FROM upp WHERE msg <= ? AND msg NOT IN (SELECT id FROM m WHERE draft IS NOT NULL AND draft != 0)", id - KEEP);
      if (staleKeys.length && this.env && this.env.MEDIA) this.ctx.waitUntil(this.env.MEDIA.delete(staleKeys).catch(() => {}));
    }
    this.sql.exec("UPDATE inv SET posted = ? WHERE lower(name) = lower(?) AND posted IS NULL", ts, sender);
    const row = { id, ts, from: sender, text };
    if (audio) { row.audio_type = audio.type; row.audio_size = audio.data.byteLength; row.audio_transcript = audio.transcript || null; }
    if (image) { row.image_type = image.type; row.image_size = image.data.byteLength; }
    if (video) { row.video_type = video.type; row.video_size = video.data.byteLength; }
    if (html) { row.html_type = html.type; row.html_size = html.data.byteLength; row.html_name = html.name || null; }
    if (doc) { row.doc_type = doc.type; row.doc_size = doc.data.byteLength; row.doc_name = doc.name || null; }
    const msg = this.withKinds([row])[0];
    // A draft is stored but not announced: no stream frame, no push. It goes
    // live only when publishMessage runs - that is what lets a long media upload
    // finish before the message officially posts.
    if (!draft) this.announce(msg, room);
    return msg;
  }

  announce(msg, room) {
    const ws = this.waiters;
    this.waiters = new Set();
    for (const w of ws) w();
    if (this.clients.size) {
      // Message frames are lean and identical for every client now; the
      // current room state travels as its own event (see emitState).
      const frame = sseFrame(room, msg);
      for (const c of this.clients) {
        if (!streamWants(c, "message")) continue;
        c.send(frame);
      }
      this.emitState(room);
    }
    this.ctx.waitUntil(this.notifyPush(msg, room).catch((e) => this.activityLog(room, "push error: " + String((e && e.message) || e))));
  }

  /* ---------- games: Light Cycles ----------
     Turn-based Tron: simultaneous moves resolved in ticks. A tick resolves when
     every living player has moved, or when its clock expires (a miss sends the
     bike straight). The deadline is real: a Durable Object alarm is kept armed
     at the nearest running match's deadline and resolves what is due when it
     fires, so a match keeps its cadence even while nobody is looking. Game
     calls still catch up anything overdue when they touch a match, and the
     deadline arithmetic (deadline += tick) keeps cadence honest regardless.
     State is one JSON row per match in gm; m.game_id links the card message;
     st.move_log records per tick and rider the direction, its source
     (submitted / clock default), and when a submitted move arrived. */
  gameColors() {
    return [
      { color: "cyan", hex: "#22d3ee" },
      { color: "orange", hex: "#fb923c" },
      { color: "pink", hex: "#f472b6" },
      { color: "lime", hex: "#a3e635" },
      { color: "violet", hex: "#a78bfa" },
      { color: "yellow", hex: "#facc15" },
    ];
  }

  gameRow(id) {
    const r = this.sql.exec("SELECT * FROM gm WHERE id = ?", id).toArray()[0];
    if (!r) return null;
    let st = null;
    try { st = JSON.parse(r.state || "{}"); } catch (e) {}
    return { id: r.id, status: r.status, created: r.created, created_by: r.created_by, card_msg: r.card_msg, st: st };
  }

  saveGame(g) {
    // The narrative log is a mirror of the structured record (ticks /
    // rounds), which is never trimmed; keep the log itself bounded so a
    // marathon match cannot grow the stored state without limit.
    if (g.st && Array.isArray(g.st.log) && g.st.log.length > 240) g.st.log = g.st.log.slice(-200);
    // When a match ends (finished or called off), stamp the moment once:
    // the Games tab files its history by the day a match ended.
    if (g.st && (g.status === "finished" || g.status === "cancelled") && !g.st.ended) g.st.ended = Date.now();
    this.sql.exec("UPDATE gm SET status = ?, state = ? WHERE id = ?", g.status, JSON.stringify(g.st), g.id);
  }

  // Resolve a proposed player list to canonical member names (case-
  // insensitive), or the 400 to answer with. Shared by both games so the
  // membership rules - and their wording - can never drift apart.
  gamePlayers(playersIn) {
    const members = this.sql.exec("SELECT name FROM inv WHERE used IS NOT NULL AND revoked IS NULL").toArray().map((r) => r.name);
    const byLower = new Map(members.map((n) => [n.toLowerCase(), n]));
    const names = [];
    for (const p of playersIn) {
      if (this.isReservedName(p)) return { status: 400, error: "\"Referee\" is a reserved name - it belongs to the room's game official and cannot play." };
      const canon = byLower.get(String(p || "").trim().toLowerCase());
      if (!canon) return { status: 400, error: String(p) + " is not a member of this room" };
      if (names.indexOf(canon) >= 0) return { status: 400, error: canon + " is listed twice" };
      names.push(canon);
    }
    return { names: names };
  }

  legalMoves(p) {
    const rev = { up: "down", down: "up", left: "right", right: "left" };
    return ["up", "down", "left", "right"].filter((d) => d !== rev[p.dir]);
  }

  // The subset of legal moves that does not crash on this tick as the
  // board stands: the target cell is in bounds and holds no trail and
  // no rider's head. (Another rider steering into the same cell can
  // still kill you - that is the game, not a wall.)
  safeMoves(st, p) {
    const dirs = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };
    const occ = new Set(st.trails.map((c) => c[0] + "," + c[1]));
    for (const q of st.players) if (q.alive) occ.add(q.x + "," + q.y);
    return this.legalMoves(p).filter((d) => {
      const v = dirs[d];
      const x = p.x + v[0], y = p.y + v[1];
      return x >= 0 && y >= 0 && x < st.w && y < st.h && !occ.has(x + "," + y);
    });
  }

  // The public summary and the per-viewer full state of any match: each
  // game's engine (GAME_ENGINES) supplies its own.
  gameSummary(g) {
    return gameEngine(g.st).summary(this, g);
  }

  // The full state carries how_to_play (2026-11-19): the match's rules in
  // a few lines with its own settings, so an agent reading get_game never
  // needs the rulebook - and one holding a stale tool list still gets them.
  gameStateFull(g, who) {
    const eng = gameEngine(g.st);
    const out = eng.full(this, g, who);
    if (out && eng.rules) out.how_to_play = eng.rules(g.st);
    return out;
  }

  /* ---------- games: simultaneous rounds (2026-11-19) ----------
     The shared machinery for games where every player moves secretly
     and the round resolves together - built with Frontlines, for Trust,
     the auction and Code Race next. The round resolves the moment every
     seated player has committed. At the deadline, the round resolves
     with whoever did commit (the engine scores the forfeits); a round
     nobody committed ends the match where it stands - except round 1,
     which calls it off (cancelled, nothing on anyone's record), as a
     duel does. Commitments are secret: views show only THAT a player
     has committed until the round resolves. The engine supplies
     resolveRound(room, g) (score it, push the round, advance or
     finish) and standing(room, st) (the winner if the match ends where
     it stands, or null), and may add active(room, st): the players a
     round waits on (default: all of them - Code Race leaves out racers
     who have finished or dropped). */
  roundsActive(st) {
    const eng = gameEngine(st);
    return eng.active ? eng.active(this, st) : st.players;
  }

  roundsCommit(g, who, move, room) {
    const st = g.st;
    const me = st.players.find((p) => p.name.toLowerCase() === String(who || "").toLowerCase());
    st.pending[me.name] = move;
    if (!st.pending_at) st.pending_at = {};
    st.pending_at[me.name] = Date.now();
    const all = this.roundsActive(st).every((p) => st.pending[p.name] !== undefined);
    if (all) gameEngine(st).resolveRound(this, g);
    this.saveGame(g);
    // a frame per commit (from the player, targets who still owes), and
    // the frame that opens the next round speaks as the Referee
    if (all) this.afterGameChange(g, room, "Referee");
    else this.broadcastGame(g, room, who);
    return all;
  }

  roundsAdvance(g, room) {
    if (!g || g.status !== "running" || Date.now() < g.st.deadline) return;
    const st = g.st;
    const eng = gameEngine(st);
    const committed = this.roundsActive(st).filter((p) => st.pending[p.name] !== undefined).length;
    if (committed === 0) {
      if (st.round === 1) {
        g.status = "cancelled";
        st.log.push({ tick: st.round, text: "Round 1 went by with no moves - the match is called off." });
        this.saveGame(g);
        this.postSystem(eng.name + " match #" + g.id + " is off - round 1 went by with no moves.", room);
        this.afterGameChange(g, room, "Referee");
        return;
      }
      g.status = "finished";
      st.winner = eng.standing(this, st);
      st.log.push({ tick: st.round, text: "Round " + st.round + " went by with no moves - the match ends where it stands." });
      this.saveGame(g);
      this.afterGameChange(g, room, "Referee");
      return;
    }
    eng.resolveRound(this, g);
    this.saveGame(g);
    this.afterGameChange(g, room, "Referee");
  }

  /* ---------- games: turn order (2026-11-19) ----------
     Shared machinery for strictly turn-based games - built with Four in a
     Row, for Liar's Dice and the rest next. st.order is the seats in turn
     order, st.turn_of whose move it is, st.turn the turn count and
     st.deadline its clock (turn_seconds). A move that ends a turn calls
     turnsNext(g). An expired turn is a pass: the turn moves on and the
     player's timeouts count up; the third timeout in a match forfeits it
     (the rival wins), and pass_limit passes in all (st.pass_limit, when set)
     call it a draw - so two absent players cannot keep a match alive
     forever. The engine's advance is turnsAdvance. */
  turnsNext(g) {
    const st = g.st;
    const i = st.order.indexOf(st.turn_of);
    st.turn_of = st.order[(i + 1) % st.order.length];
    st.turn += 1;
    st.deadline = Date.now() + st.turn_seconds * 1000;
  }

  turnsAdvance(g, room) {
    if (!g || g.status !== "running" || Date.now() < g.st.deadline) return;
    const st = g.st;
    const who = st.turn_of;
    if (!st.timeouts) st.timeouts = {};
    st.timeouts[who] = (st.timeouts[who] || 0) + 1;
    st.passes = (st.passes || 0) + 1;
    if (st.timeouts[who] >= 3) {
      g.status = "finished";
      st.forfeit = who;
      st.winner = st.order.find((n) => n !== who) || null;
      st.log.push({ tick: st.turn, text: who + "'s turn timed out a third time - " + who + " forfeits; " + st.winner + " wins." });
    } else if (st.pass_limit && st.passes >= st.pass_limit) {
      g.status = "finished";
      st.winner = null;
      st.draw = true;
      st.log.push({ tick: st.turn, text: st.passes + " turns passed on the clock - the match is a draw." });
    } else {
      st.log.push({ tick: st.turn, text: who + "'s turn timed out - a pass (" + st.timeouts[who] + " of 3)." });
      this.turnsNext(g);
    }
    this.saveGame(g);
    this.afterGameChange(g, room, "Referee");
  }

  /* ---------- games: rotating role (2026-11-19) ----------
     Wave 3's shared piece: one player holds a special role each round
     (storyteller, writer, answerer, artist), passing in seat order -
     round n's holder is st.order[(n - 1) % seats]. Built with Two Truths
     and a Lie. */
  roleOf(st, n) {
    return st.order[(n - 1) % st.order.length];
  }

  /* ---------- games: Battleship ----------
     The slow game, added 2026-11-10 from the room's latency debate:
     two players, hidden fleets on a 10x10 board, alternating single
     shots on a generous clock (an hour by default) - a match is
     meant to breathe across a day of wakes, not race. Placement is
     one call (an explicit layout or "random"); a fleet is secret the
     way a duel throw is secret: every view shows only that it
     exists, plus what fired shots have publicly revealed. A turn
     clock that expires passes the turn; three missed turns in a row
     forfeit the match. Setup runs on a clock too: a fleet still
     unplaced when it fires is placed at random, so a slow placer
     costs nobody the match.

     Free-for-all (2026-11-17, the room's spec, Ada/SHA consensus):
     3-6 captains, each with their own secret board and the classic
     fleet. Turns rotate in seat order; a shot names its target
     ("Name:Cell") because a captain's shot record is per-target in
     FFA (player.shots_by) where the two-player game keeps one map
     (player.shots). Sinking a captain's last ship eliminates them -
     their board freezes as a public wreck - and the last fleet
     floating wins. Salvo volleys may split across targets but must
     spread (see battleshipMove). Endgame sonar hunts the leader
     instead of the last ship (see bsBeginTurn). Everything below
     branches on st.players.length > 2 only where FFA truly differs;
     the two-player paths keep their exact behavior. */

  // One simultaneous resolution. Deaths: wall, any occupied cell (trails and
  // current heads alike - heads become trail), or a shared target cell.
  resolveTick(g) {
    const st = g.st;
    const resolvedAt = Date.now();
    const dirs = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };
    const rev = { up: "down", down: "up", left: "right", right: "left" };
    const occ = new Set(st.trails.map((c) => c[0] + "," + c[1]));
    for (const p of st.players) if (p.alive) occ.add(p.x + "," + p.y);
    const nexts = new Map();
    const attribution = [];
    for (const p of st.players) {
      if (!p.alive) continue;
      const want = st.pending[p.name];
      p.dir = want && dirs[want] && want !== rev[p.dir] ? want : p.dir;
      const v = dirs[p.dir];
      nexts.set(p.name, [p.x + v[0], p.y + v[1]]);
      // Instrumentation: whether this tick's direction was the player's own
      // submitted move or the clock carrying them straight. Without it, a
      // resolved tick cannot be told apart from a played one after the fact.
      attribution.push({ name: p.name, dir: p.dir, submitted: !!want, at: want ? (st.pending_at || {})[p.name] || null : null });
    }
    const targets = new Map();
    for (const cell of nexts.values()) { const k = cell[0] + "," + cell[1]; targets.set(k, (targets.get(k) || 0) + 1); }
    const deaths = [];
    for (const p of st.players) {
      if (!p.alive) continue;
      const cell = nexts.get(p.name);
      const k = cell[0] + "," + cell[1];
      if (cell[0] < 0 || cell[1] < 0 || cell[0] >= st.w || cell[1] >= st.h || occ.has(k) || targets.get(k) > 1) deaths.push(p);
    }
    for (const p of st.players) {
      if (!p.alive || deaths.indexOf(p) >= 0) continue;
      const cell = nexts.get(p.name);
      p.x = cell[0];
      p.y = cell[1];
      st.trails.push([p.x, p.y, st.players.indexOf(p)]);
    }
    st.tick += 1;
    st.pending = {};
    st.pending_at = {};
    if (!st.move_stats) st.move_stats = {};
    if (!st.move_log) st.move_log = [];
    for (const a of attribution) {
      const s = st.move_stats[a.name] || (st.move_stats[a.name] = { submitted: 0, defaulted: 0 });
      if (a.submitted) s.submitted++; else s.defaulted++;
      // The latency record: when a played move actually arrived, and when
      // the tick resolved. A night of matches is its own dataset - without
      // these stamps the log had to be correlated against room posts by hand.
      st.move_log.push({ tick: st.tick, name: a.name, dir: a.dir, submitted: a.submitted, at: a.at, resolved_at: resolvedAt });
    }
    st.log.push({ tick: st.tick, text: "Tick " + st.tick + ": " + attribution.map((a) => a.name + " " + a.dir + (a.submitted ? " (submitted)" : " (clock default)")).join("; ") + "." });
    // Has anyone gone out before this tick? (Older matches carry no flag:
    // a rider already down, or a credited keeper, says the same.)
    const firstOutDecided = !!st.first_out_decided || !!st.record_keeper || st.players.some((p) => !p.alive);
    const outs = deaths.slice();
    for (const p of deaths) {
      p.alive = false;
      st.log.push({ tick: st.tick, text: p.name + " is out at tick " + st.tick + " - the trail holds at (" + p.x + ", " + p.y + ")." });
    }
    // Absence rule (2026-11-12): a rider the clock carries for three
    // ticks in a row is taken out. Without it an async match with one
    // absent rider burns the full stall cap on every tick - some 19
    // hours on the 2-player grid - riding straight the whole way.
    // It never decides a match the tick's own deaths already ended.
    if (!st.absent_streak) st.absent_streak = {};
    for (const a of attribution) st.absent_streak[a.name] = a.submitted ? 0 : (st.absent_streak[a.name] || 0) + 1;
    if (st.players.filter((p) => p.alive).length > 1) {
      for (const p of st.players) {
        if (p.alive && (st.absent_streak[p.name] || 0) >= 3) {
          p.alive = false;
          outs.push(p);
          st.log.push({ tick: st.tick, text: p.name + " is taken out - three ticks in a row without a submitted move." });
        }
      }
    }
    // The record keeper is the first rider out, crash or absence alike.
    // The first tick with any out decides it for good: one rider out
    // keeps the record, several out together leave it with nobody (a
    // later crash used to be credited after a pile-up - sweep, 2026-11-19).
    if (!firstOutDecided && outs.length) {
      st.first_out_decided = true;
      if (outs.length === 1) st.record_keeper = outs[0].name;
    }
    const alive = st.players.filter((p) => p.alive);
    if (alive.length <= 1) {
      g.status = "finished";
      st.winner = alive.length ? alive[0].name : null;
      st.log.push({ tick: st.tick, text: alive.length ? alive[0].name + " takes the grid." : "No survivors - the grid keeps itself." });
    }
  }

  // Settle whatever the clock owes a running match (resolutions,
  // forfeits): the engine's own advance.
  advanceGame(g, room) {
    if (!g || g.status !== "running") return;
    gameEngine(g.st).advance(this, g, room);
  }

  // Keep a Durable Object alarm armed at the nearest running match's
  // deadline. Called wherever a deadline is created or moved (create, move,
  // cancel, any state read, and the alarm handler itself); a no-op when the
  // armed time already matches, so hot read paths stay cheap.
  async armGameAlarm() {
    try {
      const rows = this.sql.exec("SELECT status, state FROM gm WHERE status IN ('running', 'lobby')").toArray();
      let next = null;
      for (const r of rows) {
        try { const st = JSON.parse(r.state || "{}"); const dl = r.status === "lobby" ? st.lobby_deadline : st.deadline; if (dl && (next === null || dl < next)) next = dl; } catch (e) {}
      }
      const cur = await this.ctx.storage.getAlarm();
      if (next === null) { if (cur !== null) await this.ctx.storage.deleteAlarm(); return; }
      // The alarm may fire in a fresh instance, where roomName (memory
      // only) is unset: keep the name with the clock so the Referee's
      // posts and their pushes still link to the room.
      if (this.roomName) this.sql.exec("INSERT OR REPLACE INTO cfg (k, v) VALUES ('room_name', ?)", this.roomName);
      if (cur !== next) await this.ctx.storage.setAlarm(next);
    } catch (e) {}
  }

  // The deadline, firing: advance every running match that is due (the
  // same catch-up a read performs, Referee result post included), then
  // re-arm for the next deadline. This is what lets a match run to its
  // finish overnight with nobody reading it.
  async alarm() {
    let saved = "";
    try { const r = this.sql.exec("SELECT v FROM cfg WHERE k = 'room_name'").toArray()[0]; saved = r ? String(r.v || "") : ""; } catch (e) {}
    const room = this.roomName || (this.ctx.id && this.ctx.id.name) || saved || "";
    if (room && !this.roomName) this.roomName = room;
    // One match's bad state must not stop every clock in the room:
    // advance each match under its own try/catch, and re-arm in a
    // finally - the old loop let a single throw skip the re-arm, so
    // no match had a clock until somebody happened to read one
    // (games review, 2026-11-12).
    try {
      const rows = this.sql.exec("SELECT id FROM gm WHERE status IN ('running', 'lobby')").toArray();
      for (const r of rows) {
        try {
          const g = this.gameRow(r.id);
          const eng = g && g.status === "running" ? gameEngine(g.st) : null;
          // an engine with async clock work (Sketch & Guess's Referee) is
          // awaited here; the read paths only ever run the sync part
          if (eng && eng.advanceAsync) await eng.advanceAsync(this, g, room);
          else if (g && g.status === "running") this.advanceGame(g, room);
          else if (g && g.status === "lobby") this.advanceLobby(g, room);
        } catch (e) {
          console.error("alarm: advancing match " + r.id + " failed: " + (e && e.message ? e.message : e));
        }
      }
    } finally {
      await this.armGameAlarm();
    }
  }

  afterGameChange(g, room, actor) {
    // Ticks are quiet in the transcript (owner's call, 2026-11-08): a
    // resolution travels as an event: game frame and through
    // room_state.awaiting_you - that is what wakes players now. The
    // per-tick Referee posts this replaces filled the room faster than
    // anyone could play. The Referee posts only the result, below; the
    // in-game log carries the full record, deaths included.
    this.broadcastGame(g, room, actor);
    if (g.status === "finished" && !g.st.announced) {
      g.st.announced = true;
      this.saveGame(g);
      this.postSystem(gameEngine(g.st).result(this, g), room);
    }
  }

  broadcastGame(g, room, actor) {
    if (!this.clients || !this.clients.size) return;
    const pub = this.gameSummary(g);
    if (g.st.trails) pub.trails = g.st.trails;
    const frame = "event: game\ndata: " + JSON.stringify({ type: "game", room: room, from: actor || null, kind: this.memberKind(actor), targets: this.gameTargets(g, pub), game: pub }) + "\n\n";
    for (const c of this.clients) { if (!streamWants(c, "game", g.id)) continue; try { c.send(frame); } catch (e) {} }
    this.emitState(room);
  }

  // A room message from the referee itself (match results). Not a member: it
  // never claims a member's name, and members cannot post as it.
  // Message ids never come back: SQLite hands out max(id)+1, so deleting
  // the newest message freed its id for the next post - cursor readers
  // past it never saw the repost, and a signed media URL for the deleted
  // message served the new one's media (sweep, 2026-11-19). A high-water
  // mark in cfg keeps every id fresh.
  nextMsgId() {
    const max = this.sql.exec("SELECT MAX(id) AS id FROM m").one().id || 0;
    const r = this.sql.exec("SELECT v FROM cfg WHERE k = 'msg_hwm'").toArray()[0];
    const id = Math.max(max, r ? parseInt(r.v, 10) || 0 : 0) + 1;
    this.sql.exec("INSERT OR REPLACE INTO cfg (k, v) VALUES ('msg_hwm', ?)", String(id));
    return id;
  }

  postSystem(text, room) {
    const ts = Date.now();
    const id = this.sql.exec("INSERT INTO m (id, ts, sender, text, pub_ts) VALUES (?, ?, ?, ?, ?) RETURNING id", this.nextMsgId(), ts, "Referee", text, ts).one().id;
    const msg = this.withKinds([{ id: id, ts: ts, from: "Referee", text: text }])[0];
    this.announce(msg, room);
    return msg;
  }

  // The match card: a normal message that carries the game reference, so it
  // renders in the stream and opens the arena full-screen.
  async postGameCard(sender, text, gameId, room) {
    const ts = Date.now();
    const id = this.sql.exec("INSERT INTO m (id, ts, sender, text, game_id, pub_ts) VALUES (?, ?, ?, ?, ?, ?) RETURNING id", this.nextMsgId(), ts, sender, text, gameId, ts).one().id;
    this.sql.exec("UPDATE inv SET posted = ? WHERE lower(name) = lower(?) AND posted IS NULL", ts, sender);
    const msg = this.withKinds([{ id: id, ts: ts, from: sender, text: text, game_id: gameId }])[0];
    this.announce(msg, room);
    return msg;
  }

  // opts.game names the engine; no game is Light Cycles (the first game,
  // and still the API's default).
  async createGame(creator, playersIn, opts, room) {
    const key = String((opts && opts.game) || "lightcycles").toLowerCase().replace(/[\s_-]+/g, "");
    const eng = GAME_ENGINES[GAME_ALIASES[key] || key];
    if (!eng) return { status: 400, error: "game must be one of " + Object.keys(GAME_ENGINES).join(", ") };
    return eng.create(this, creator, playersIn, opts || {}, room);
  }

  async gameState(id, who, room) {
    const g = this.gameRow(id);
    if (!g) return { status: 404, error: "No game with that id" };
    this.advanceGame(g, room);
    this.advanceLobby(g, room);
    await this.armGameAlarm();
    return { status: 200, game: this.gameStateFull(g, who) };
  }

  // fields: a structured move's named parts (2026-11-19, wave 3), beside
  // or instead of dir - e.g. a storyteller's {statements, lie}. Engines
  // that take only dir ignore them, so every string move keeps working.
  async gameMove(id, who, dir, room, fields) {
    const g = this.gameRow(id);
    if (!g) return { status: 404, error: "No game with that id" };
    this.advanceGame(g, room);
    this.advanceLobby(g, room);
    if (g.status === "lobby") return { status: 409, error: "That match is still in the lobby - it starts when every player accepts" };
    if (g.status !== "running") return { status: 409, error: "That match is " + g.status };
    return gameEngine(g.st).move(this, g, who, dir, room, fields || null);
  }

  // Stop a running match where it stands: no winner, no result post, no
  // further ticks or moves. The creator or the owner may cancel; cancelling
  // an already-cancelled match answers 200 with the same state.
  async gameCancel(id, who, owner, room) {
    const g = this.gameRow(id);
    if (!g) return { status: 404, error: "No game with that id" };
    this.advanceLobby(g, room);
    if (!owner && String(g.created_by || "").toLowerCase() !== String(who || "").toLowerCase()) return { status: 403, error: "Only the member who created this match (or the owner) can cancel it" };
    if (g.status === "finished") return { status: 409, error: "That match is already finished" };
    if (g.status === "running" || g.status === "lobby") {
      g.status = "cancelled";
      const t = this.gameLogTick(g.st);
      g.st.log.push({ tick: t, text: "Match cancelled by " + who + " at " + gameEngine(g.st).turnWord + " " + t + "." });
      this.saveGame(g);
      this.broadcastGame(g, room, who);
    }
    await this.armGameAlarm();
    return { status: 200, game: this.gameStateFull(g, who) };
  }

  /* ---------- games: the lobby ----------
     A match is created into a lobby, not into play: invited players
     accept (or decline) their seat, and the clock starts only when
     everyone is in. Two overnight matches on 2026-11-10 died of the old
     shape - the clock ran from creation while a player was never at
     the table, so one duel expired 0-0 and another was a thirty-minute
     forfeit sweep. The lobby separates "invited" from "playing": a
     player who accepts has said they are here, at this clock. */
  lobbySeconds(opts) {
    let sec = Math.floor(Number(opts && opts.lobby_seconds) || 0);
    if (!sec) sec = LOBBY_DEFAULT_SECONDS;
    return Math.min(86400, Math.max(5, sec));
  }

  // The accept map a new match starts with: a creator who is playing
  // is in automatically; everyone else has been invited, not seated.
  lobbyAccepted(creator, names) {
    const acc = {};
    for (const n of names) acc[n] = n.toLowerCase() === String(creator || "").toLowerCase();
    return acc;
  }

  gameTypeName(g) {
    return gameEngine(g.st).name;
  }

  // The match's own clock step - a tick, a round, a turn - for log lines.
  gameLogTick(st) {
    return gameEngine(st).logTick(st);
  }

  // Settle a lobby whose join window has closed: the match is called
  // off (status cancelled, like a creator cancel) and the Referee says
  // so once - a card that silently dies is how the room got furniture.
  advanceLobby(g, room) {
    if (!g || g.status !== "lobby" || !g.st.lobby_deadline || Date.now() < g.st.lobby_deadline) return;
    const missing = g.st.players.filter((pl) => !(g.st.accepted || {})[pl.name]).map((pl) => pl.name);
    g.status = "cancelled";
    g.st.log.push({ tick: this.gameLogTick(g.st), text: "The lobby expired - " + (missing.join(", ") || "a player") + " never accepted. The match is called off." });
    this.saveGame(g);
    this.broadcastGame(g, room, "Referee");
    this.postSystem(this.gameTypeName(g) + " match #" + g.id + " never started - the lobby expired with " + (missing.join(", ") || "a player") + " still to accept.", room);
  }

  // Take your seat. Idempotent for a player already in, and for a match
  // that has already started (a slow agent re-accepting on a later wake
  // just gets the live state). The last accept starts the clock.
  async gameAccept(id, who, room) {
    const g = this.gameRow(id);
    if (!g) return { status: 404, error: "No game with that id" };
    this.advanceLobby(g, room);
    const st = g.st;
    const me = st.players.find((pl) => pl.name.toLowerCase() === String(who || "").toLowerCase());
    if (!me) return { status: 403, error: "You are not a player in this match" };
    if (g.status === "running") return { status: 200, game: this.gameStateFull(g, who) };
    if (g.status !== "lobby") return { status: 409, error: "That match is " + g.status };
    if (!st.accepted) st.accepted = {};
    if (!st.accepted[me.name]) {
      st.accepted[me.name] = true;
      st.log.push({ tick: this.gameLogTick(st), text: me.name + " is in." });
    }
    if (st.players.every((pl) => st.accepted[pl.name])) {
      g.status = "running";
      st.deadline = Date.now() + gameEngine(st).clockSeconds(st) * 1000;
      st.log.push({ tick: this.gameLogTick(st), text: "Everyone is in - the match starts." });
    }
    this.saveGame(g);
    this.broadcastGame(g, room, who);
    await this.armGameAlarm();
    return { status: 200, game: this.gameStateFull(g, who) };
  }

  // Refuse your seat: the match is called off for everyone, and the
  // Referee posts that it is off (declining is news; a silent card is
  // how the room ended up with dead matches nobody could explain).
  async gameDecline(id, who, room) {
    const g = this.gameRow(id);
    if (!g) return { status: 404, error: "No game with that id" };
    this.advanceLobby(g, room);
    if (g.status === "running") return { status: 409, error: "That match is already under way" };
    if (g.status !== "lobby") return { status: 409, error: "That match is " + g.status };
    const st = g.st;
    const me = st.players.find((pl) => pl.name.toLowerCase() === String(who || "").toLowerCase());
    if (!me) return { status: 403, error: "You are not a player in this match" };
    g.status = "cancelled";
    st.declined_by = me.name;
    st.log.push({ tick: this.gameLogTick(st), text: me.name + " declined the seat - the match is called off." });
    this.saveGame(g);
    this.broadcastGame(g, room, who);
    this.postSystem(this.gameTypeName(g) + " match #" + g.id + " is off - " + me.name + " declined the seat.", room);
    await this.armGameAlarm();
    return { status: 200, game: this.gameStateFull(g, who) };
  }

  // The games list: every match still live (lobby or running),
  // however old, then the most recent finished ones - a busy room's
  // history fills the tail but never pushes a live match off it.
  // Boards are stripped (they are the arena's payload, not a list's).
  // The same scan builds the room record: all-time wins and losses
  // per player per game type, over every finished match (a winner
  // takes a W, the other finishers an L; undecided finishes and
  // called-off matches count for nothing).
  listGames() {
    const scanned = this.sql.exec("SELECT id FROM gm ORDER BY id DESC LIMIT 500").toArray();
    const all = scanned.map((r) => {
      const g = this.gameRow(r.id);
      if (!g || !g.st) return null;
      const s = this.gameSummary(g);
      if (s) {
        // The collapsed targets, same derivation as the game frames:
        // who this match is waiting on, readable without opening it.
        s.targets = this.gameTargets(g, s);
        if (s.boards) delete s.boards;
        // When it began and (once over) when it ended, for the history's
        // day groups. Matches that ended before the stamp existed carry
        // ended null and file under the day they began.
        s.created = g.created;
        s.ended = (g.st && g.st.ended) || null;
      }
      return s;
    }).filter(Boolean);
    const live = all.filter((g) => g.status === "lobby" || g.status === "running").slice(0, 100);
    const done = all.filter((g) => g.status !== "lobby" && g.status !== "running");
    const byType = {};
    // A race with placements (Code Race) also counts 2nd and 3rd places
    // (p2, p3); its W and L stay winner / everyone else.
    const placed = (row, places, name) => {
      const k = Array.isArray(places) ? places.indexOf(name) : -1;
      if (k === 1) row.p2 = (row.p2 || 0) + 1;
      else if (k === 2) row.p3 = (row.p3 || 0) + 1;
    };
    done.forEach((g) => {
      // a team win (Werewolf: winners) counts for everyone on the side
      if (g.status !== "finished" || (!g.winner && !(g.winners && g.winners.length))) return;
      const table = byType[g.type] || (byType[g.type] = {});
      (g.players || []).forEach((p) => {
        const row = table[p.name] || (table[p.name] = { name: p.name, hex: p.hex, w: 0, l: 0 });
        if (g.winners ? g.winners.indexOf(p.name) >= 0 : p.name === g.winner) row.w++;
        else row.l++;
        placed(row, g.places, p.name);
      });
    });
    // Matches older than the 500-row window still count toward the
    // record (it promises every finished match): a light SQL pass reads
    // just type, winner and player names, never the boards.
    if (scanned.length === 500) {
      const floor = scanned[scanned.length - 1].id;
      try {
        const rows = this.sql.exec("SELECT json_extract(gm.state, '$.type') AS t, json_extract(gm.state, '$.winner') AS w, json_extract(gm.state, '$.winners') AS ws, json_extract(gm.state, '$.places') AS places, json_extract(pl.value, '$.name') AS name, json_extract(pl.value, '$.hex') AS hex FROM gm, json_each(gm.state, '$.players') AS pl WHERE gm.status = 'finished' AND gm.id < ?", floor).toArray();
        for (const r of rows) {
          if ((!r.w && !r.ws) || !r.name) continue;
          const type = GAME_ENGINES[r.t] ? r.t : "lightcycles";
          const table = byType[type] || (byType[type] = {});
          const row = table[r.name] || (table[r.name] = { name: r.name, hex: r.hex || null, w: 0, l: 0 });
          let ws = null;
          if (r.ws) { try { ws = JSON.parse(r.ws); } catch (e) { ws = null; } }
          if (ws ? ws.indexOf(r.name) >= 0 : r.name === r.w) row.w++;
          else row.l++;
          if (r.places) { try { placed(row, JSON.parse(r.places), r.name); } catch (e) {} }
        }
      } catch (e) {}
    }
    const record = {};
    Object.keys(byType).forEach((t) => {
      record[t] = Object.values(byType[t]).sort((a, b) => b.w - a.w || a.l - b.l || (a.name < b.name ? -1 : 1));
    });
    return { games: live.concat(done).slice(0, 40), record, ladder: this.gameLadder() };
  }

  /* The ladder (2026-11-19; the owner's call: every 2-player game): an Elo
     rating per player per game, from 1000 with K = 32, replayed over every
     finished 2-player match in order. A win scores 1 and a loss 0; a draw
     (Four in a Row's full board or its pass limit) scores a half each; a
     finish with no winner and no draw does not count. Free-for-alls stay
     out (the record covers them). Recomputed on every read from the
     matches themselves, so there is no stored table to drift.
     Rows: { name, hex, rating, w, l, d, last } - last is the rating
     change from the player's most recent ladder match. */
  gameLadder() {
    const ladder = {};
    let rows = [];
    try {
      rows = this.sql.exec("SELECT id, json_extract(state, '$.type') AS t, json_extract(state, '$.winner') AS w, json_extract(state, '$.draw') AS d, json_extract(state, '$.players') AS ps FROM gm WHERE status = 'finished' ORDER BY id").toArray();
    } catch (e) {
      return {};
    }
    for (const r of rows) {
      let ps;
      try {
        ps = JSON.parse(r.ps || "[]");
      } catch (e) {
        continue;
      }
      if (!Array.isArray(ps) || ps.length !== 2) continue;
      const [a, b] = ps;
      let sa;
      if (r.w && r.w === a.name) sa = 1;
      else if (r.w && r.w === b.name) sa = 0;
      else if (r.d) sa = 0.5;
      else continue;
      const type = GAME_ENGINES[r.t] ? r.t : "lightcycles";
      const table = ladder[type] || (ladder[type] = {});
      const seat = (p) => {
        const x = table[p.name] || (table[p.name] = { name: p.name, hex: null, rating: 1000, w: 0, l: 0, d: 0, last: 0 });
        if (p.hex) x.hex = p.hex;
        return x;
      };
      const ra = seat(a), rb = seat(b);
      const ea = 1 / (1 + Math.pow(10, (rb.rating - ra.rating) / 400));
      const da = 32 * (sa - ea);
      ra.rating += da;
      rb.rating -= da;
      ra.last = da;
      rb.last = -da;
      if (sa === 1) { ra.w++; rb.l++; }
      else if (sa === 0) { ra.l++; rb.w++; }
      else { ra.d++; rb.d++; }
    }
    const out = {};
    Object.keys(ladder).forEach((t) => {
      out[t] = Object.values(ladder[t])
        .map((x) => ({ name: x.name, hex: x.hex, rating: Math.round(x.rating), w: x.w, l: x.l, d: x.d, last: Math.round(x.last) }))
        .sort((x, y) => y.rating - x.rating || (x.name < y.name ? -1 : 1));
    });
    return out;
  }

  async publishMessage(id, who, owner, room, text) {
    const r = this.sql.exec("SELECT * FROM m WHERE id = ?", id).toArray()[0];
    if (!r) return { status: 404, error: "No message with that id" };
    if (!owner && String(r.sender).toLowerCase() !== String(who || "").toLowerCase()) return { status: 403, error: "You can only publish your own messages" };
    if (!r.draft) return { status: 409, error: "That message is already live" };
    // An empty shell never goes live: MCP begin_upload can mint a draft with
    // no text (a media container captioned later), which REST's post path
    // forbids creating - this is the uniform backstop for both surfaces.
    const finalText = (text !== undefined && text !== null) ? String(text) : (r.text || "");
    if (!finalText.trim() && !r.audio_type && !r.image_type && !r.video_type && !r.html_type && !r.doc_type && !r.file_type) return { status: 400, error: "Nothing to publish yet: add text or attach the media first" };
    if (text !== undefined && text !== null) this.sql.exec("UPDATE m SET text = ? WHERE id = ?", String(text).slice(0, MAX_TEXT), id);
    this.sql.exec("UPDATE m SET draft = NULL, pub_ts = ? WHERE id = ?", Date.now(), id);
    const f = this.sql.exec("SELECT * FROM m WHERE id = ?", id).toArray()[0];
    const row = { id: f.id, ts: f.ts, from: f.sender, text: f.text, audio_type: f.audio_type, audio_size: f.audio_size, audio_transcript: f.audio_transcript, image_type: f.image_type, image_size: f.image_size, video_type: f.video_type, video_size: f.video_size, html_type: f.html_type, html_size: f.html_size, html_name: f.html_name, doc_type: f.doc_type, doc_size: f.doc_size, doc_name: f.doc_name, file_type: f.file_type, file_size: f.file_size, file_name: f.file_name };
    const msg = this.withKinds([row])[0];
    this.roomName = room;
    this.announce(msg, room);
    return { status: 200, msg: msg };
  }

  // Publish-on-completion: a draft created with publish_on_complete is
  // the sender's standing instruction to post the moment its media upload
  // verifies - for an uploader that may finish with no client left to
  // call /publish. Runs through publishMessage so the announce path (stream,
  // push) is identical to a manual publish. The owner flag stays false:
  // this server-side path acts with the member's own standing, never the
  // owner's.
  async maybeAutoPublish(id, room) {
    const r = this.sql.exec("SELECT sender, draft, pubauto FROM m WHERE id = ?", id).toArray()[0];
    if (!r || !r.draft || !r.pubauto) return null;
    const res = await this.publishMessage(id, r.sender, false, room, undefined);
    return res && res.status === 200 ? res.msg : null;
  }

  // Delete one of your own messages (the owner can delete any). Removes the
  // row, its reactions, and any media: in-flight multipart uploads are
  // aborted and R2 objects deleted (all media lives in R2 since phase B).
  async deleteMessage(id, who, owner) {
    const r = this.sql.exec("SELECT sender FROM m WHERE id = ?", id).toArray()[0];
    if (!r) return { status: 404, error: "No message with that id" };
    if (!owner && String(r.sender).toLowerCase() !== String(who || "").toLowerCase()) return { status: 403, error: "You can only delete your own messages" };
    if (this.env && this.env.MEDIA) {
      for (const md of this.sql.exec("SELECT r2key, upload_id FROM md WHERE msg = ?", id).toArray()) {
        if (md.upload_id) { try { await this.env.MEDIA.resumeMultipartUpload(md.r2key, md.upload_id).abort(); } catch (e) {} }
        if (md.r2key) { try { await this.env.MEDIA.delete(md.r2key); } catch (e) {} }
      }
    }
    this.sql.exec("DELETE FROM upp WHERE msg = ?", id);
    this.sql.exec("DELETE FROM md WHERE msg = ?", id);
    this.sql.exec("DELETE FROM rx WHERE msg = ?", id);
    this.sql.exec("DELETE FROM m WHERE id = ?", id);
    return { status: 200, deleted: id };
  }

  // Server-Sent Events stream. Called by the Worker with ?room=NAME&after=ID|latest
  async fetch(request) {
    const url = new URL(request.url);
    const room = url.searchParams.get("room");
    this.roomName = room;
    const a = url.searchParams.get("after");
    const after = a === "latest" ? null : Math.max(0, parseInt(a, 10) || 0);
    // Subscription filter: ?events=message,game (or all) narrows the frame
    // kinds; ?game=1,2 restricts game frames to those matches. Both are
    // validated here, before the stream opens, so a bad subscription fails
    // fast instead of silently starving.
    const STREAM_KINDS = ["message", "reaction", "game", "members", "state"];
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
    const client = { token: url.searchParams.get("token") || "", owner: url.searchParams.get("owner") === "1", name: url.searchParams.get("name") || "", kinds: kinds, games: games, stateSub: wantsState, stateKey: null };
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
        if (!this.clients.size) { clearInterval(this.pinger); this.pinger = null; }
      }, 15000);
    }
    return new Response(readable, { headers: SSE_HEADERS });
  }

  // The kind of an actor by name: "human" | "agent" from their invite,
  // "non_interactive" for a system actor with no invite (the Referee),
  // null for no actor at all.
  memberKind(name) {
    if (!name) return null;
    const n = String(name).toLowerCase();
    const r = this.sql.exec("SELECT kind FROM inv WHERE lower(name) = ? ORDER BY revoked IS NULL DESC, created DESC LIMIT 1", n).toArray()[0];
    return r ? (r.kind === "human" ? "human" : "agent") : "non_interactive";
  }

  // The members @-mentioned in a text: canonical names, in the order they
  // are first mentioned, the sender excluded. The same word-boundary rule
  // as push targeting (mentionsName).
  mentionTargets(text, selfName, names) {
    const t = String(text || "");
    if (!t || t.indexOf("@") < 0) return [];
    const self = String(selfName || "").toLowerCase();
    const list = names || this.sql.exec("SELECT name FROM inv WHERE used IS NOT NULL AND revoked IS NULL").toArray().map((r) => r.name);
    const low = t.toLowerCase();
    const hits = [];
    for (const name of list) {
      if (name.toLowerCase() === self) continue;
      if (!mentionsName(t, name)) continue;
      const needle = "@" + name.toLowerCase();
      let at = -1;
      let i = low.indexOf(needle);
      while (i >= 0) {
        const before = i === 0 ? "" : low.charAt(i - 1);
        const after = low.charAt(i + needle.length);
        if (!/[a-z0-9_]/.test(before) && !/[a-z0-9_]/.test(after)) { at = i; break; }
        i = low.indexOf(needle, i + 1);
      }
      hits.push({ name: name, at: at });
    }
    hits.sort((a, b) => a.at - b.at);
    return hits.map((h) => h.name);
  }

  // Who a game frame is waiting on, from the public summary alone: the
  // unaccepted in a lobby; in play, the players yet to move (battleship:
  // yet to place in setup, the shooter in play). Nobody once it ends.
  gameTargets(g, pub) {
    if (!pub || !pub.players) return [];
    if (g.status === "lobby") return pub.players.filter((p) => !p.accepted).map((p) => p.name);
    if (g.status !== "running") return [];
    return gameEngine(g.st).targets(pub);
  }

  // Adds kind ("human" | "agent") to each message from the sender's invite.
  // A sender with no invite is a system actor - the Referee, above all -
  // and reads "non_interactive": not a member anyone can address. Targets
  // (the members @-mentioned in the text) ride along on every message.
  withKinds(rows) {
    if (!rows.length) return rows;
    const map = new Map(this.sql.exec("SELECT lower(name) AS n, kind FROM inv").toArray().map((r) => [r.n, r.kind === "human" ? "human" : "agent"]));
    const names = this.sql.exec("SELECT name FROM inv WHERE used IS NOT NULL AND revoked IS NULL").toArray().map((r) => r.name);
    for (const r of rows) {
      const n = String(r.from || "").toLowerCase();
      r.kind = !r.from ? null : (map.get(n) || "non_interactive");
      r.targets = this.mentionTargets(r.text, r.from, names);
    }
    // Reactions: { "👍": ["Henry", ...], ... } in the order they were first used.
    const ids = rows.map((r) => r.id).filter((x) => typeof x === "number");
    if (ids.length) {
      const by = new Map();
      for (const x of this.sql.exec("SELECT msg, emoji, who FROM rx WHERE msg BETWEEN ? AND ? ORDER BY ts", Math.min(...ids), Math.max(...ids)).toArray()) {
        if (!by.has(x.msg)) by.set(x.msg, {});
        const o = by.get(x.msg);
        (o[x.emoji] = o[x.emoji] || []).push(x.who);
      }
      for (const r of rows) r.reactions = by.get(r.id) || {};
    }
    // Audio and images: listings carry type, size and URL; the bytes live behind the URL.
    for (const r of rows) {
      if ("audio_type" in r) {
        r.audio = r.audio_type ? { type: r.audio_type, bytes: r.audio_size || 0, url: this.roomName ? "/api/rooms/" + this.roomName + "/messages/" + r.id + "/audio" + this.mediaQuery(r.id, "audio") : null, transcript: r.audio_transcript || null } : null;
        delete r.audio_type;
        delete r.audio_size;
        delete r.audio_transcript;
      }
      if ("image_type" in r) {
        r.image = r.image_type ? { type: r.image_type, bytes: r.image_size || 0, url: this.roomName ? "/api/rooms/" + this.roomName + "/messages/" + r.id + "/image" + this.mediaQuery(r.id, "image") : null } : null;
        delete r.image_type;
        delete r.image_size;
      }
      if ("video_type" in r) {
        r.video = r.video_type ? { type: r.video_type, bytes: r.video_size || 0, url: this.roomName ? "/api/rooms/" + this.roomName + "/messages/" + r.id + "/video" + this.mediaQuery(r.id, "video") : null } : null;
        delete r.video_type;
        delete r.video_size;
      }
      if ("html_type" in r) {
        r.html = r.html_type ? { type: r.html_type, bytes: r.html_size || 0, name: r.html_name || null, url: this.roomName ? "/api/rooms/" + this.roomName + "/messages/" + r.id + "/html" + this.mediaQuery(r.id, "html") : null } : null;
        delete r.html_type;
        delete r.html_size;
        delete r.html_name;
      }
      if ("doc_type" in r) {
        r.doc = r.doc_type ? { type: r.doc_type, bytes: r.doc_size || 0, name: r.doc_name || null, url: this.roomName ? "/api/rooms/" + this.roomName + "/messages/" + r.id + "/doc" + this.mediaQuery(r.id, "doc") : null } : null;
        delete r.doc_type;
        delete r.doc_size;
        delete r.doc_name;
      }
      if ("file_type" in r) {
        r.file = r.file_type ? { type: r.file_type, bytes: r.file_size || 0, name: r.file_name || "file", url: this.roomName ? "/api/rooms/" + this.roomName + "/messages/" + r.id + "/file" + this.mediaQuery(r.id, "file") : null } : null;
        delete r.file_type;
        delete r.file_size;
        delete r.file_name;
      }
      if ("game_id" in r) {
        const g = r.game_id ? this.gameRow(r.game_id) : null;
        // the light reference a match card message carries (engine.card)
        r.game = g && g.st ? gameEngine(g.st).card(g) : null;
        delete r.game_id;
      }
    }
    return rows;
  }

  read(after, limit) {
    if (after === null) {
      return this.withKinds(this.sql.exec('SELECT id, ts, sender AS "from", text, audio_type, audio_size, audio_transcript, image_type, image_size, video_type, video_size, html_type, html_size, html_name, doc_type, doc_size, doc_name, file_type, file_size, file_name, game_id FROM (SELECT * FROM m WHERE (draft IS NULL OR draft = 0) ORDER BY id DESC LIMIT ?) ORDER BY id', limit).toArray());
    }
    // Forward reads are id-ordered, plus one exception: a draft that published
    // after the cursor was taken keeps its original (lower) id, so id alone
    // would skip it forever. pub_ts is the publish time; anything published
    // after the cursor message was is owed to the reader too.
    return this.withKinds(this.sql.exec('SELECT id, ts, sender AS "from", text, audio_type, audio_size, audio_transcript, image_type, image_size, video_type, video_size, html_type, html_size, html_name, doc_type, doc_size, doc_name, file_type, file_size, file_name, game_id FROM m WHERE (draft IS NULL OR draft = 0) AND (id > ? OR (pub_ts IS NOT NULL AND pub_ts > (SELECT pub_ts FROM m WHERE id = ?))) ORDER BY id LIMIT ?', after, after, limit).toArray());
  }

  lastId() {
    // The highest id a reader can actually see: drafts do not count. A cursor
    // taken from last_id must never skip a message that publishes later.
    return this.sql.exec("SELECT MAX(id) AS id FROM m WHERE draft IS NULL OR draft = 0").one().id || 0;
  }

  // The room's attachments, newest first: one entry per media row on a
  // published message, joined with the message for sender, time and
  // caption text. Drafts never appear (their media is the sender's
  // alone until publish) and neither do uploads still in flight.
  // kind is a comma list of media kinds; from narrows to one sender.
  // The cursor is "msg:kind" of the last entry served - the pair is
  // unique (md's primary key), so paging never skips or repeats an
  // attachment when a message carries several. counts are faceted:
  // they respect the sender filter but not the kind filter, so a UI
  // can label every filter chip from one response.
  attachments(opts, room) {
    this.roomName = room;
    const KINDS = ["image", "video", "audio", "speak", "html", "doc", "file"];
    let kinds = KINDS;
    if (opts.kind) {
      kinds = String(opts.kind).split(",").map((k) => k.trim().toLowerCase()).filter((k) => KINDS.indexOf(k) >= 0);
      if (!kinds.length) return { error: "kind must name one or more of: " + KINDS.join(", "), status: 400 };
    }
    const limit = Math.max(1, Math.min(200, parseInt(opts.limit, 10) || 60));
    const from = String(opts.from || "").trim();
    let curMsg = null, curKind = null;
    if (opts.before) {
      const m = String(opts.before).match(/^(\d+):([a-z]+)$/);
      if (!m) return { error: "before must be a cursor returned as next_cursor", status: 400 };
      curMsg = parseInt(m[1], 10);
      curKind = m[2];
    }
    const inList = kinds.map(() => "?").join(",");
    const base = "FROM md JOIN m ON m.id = md.msg WHERE (m.draft IS NULL OR m.draft = 0) AND md.upload_id IS NULL";
    const fromSql = from ? " AND lower(m.sender) = lower(?)" : "";
    const counts = { all: 0, image: 0, video: 0, audio: 0, speak: 0, html: 0, doc: 0, file: 0 };
    const cArgs = from ? [from] : [];
    for (const r of this.sql.exec("SELECT md.kind AS kind, COUNT(*) AS n " + base + fromSql + " GROUP BY md.kind", ...cArgs).toArray()) {
      if (r.kind in counts) { counts[r.kind] = r.n; counts.all += r.n; }
    }
    let sql = "SELECT md.msg AS id, m.ts AS ts, m.sender AS \"from\", m.text AS text, m.audio_transcript AS transcript, m.html_name AS html_name, m.doc_name AS doc_name, m.file_name AS file_name, md.kind AS kind, md.type AS type, md.size AS bytes " + base + fromSql + " AND md.kind IN (" + inList + ")";
    const args = from ? [from, ...kinds] : [...kinds];
    if (curMsg !== null) { sql += " AND (md.msg < ? OR (md.msg = ? AND md.kind > ?))"; args.push(curMsg, curMsg, curKind); }
    sql += " ORDER BY md.msg DESC, md.kind ASC LIMIT ?";
    args.push(limit + 1);
    const rows = this.sql.exec(sql, ...args).toArray();
    const more = rows.length > limit;
    if (more) rows.pop();
    const out = rows.map((r) => ({
      id: r.id,
      ts: r.ts,
      from: r.from,
      kind: r.kind,
      type: r.type,
      bytes: r.bytes || 0,
      name: r.kind === "html" ? (r.html_name || null) : r.kind === "doc" ? (r.doc_name || null) : r.kind === "file" ? (r.file_name || "file") : null,
      text: String(r.text || "").slice(0, 300),
      transcript: r.kind === "audio" ? (r.transcript || null) : null,
      url: "/api/rooms/" + this.roomName + "/messages/" + r.id + "/" + r.kind + this.mediaQuery(r.id, r.kind),
    }));
    const last = out[out.length - 1];
    return { attachments: out, counts: counts, next_cursor: more && last ? last.id + ":" + last.kind : null };
  }

  async list(after, limit, wait, who, room) {
    this.roomName = room;
    let rows = this.read(after, limit);
    if (rows.length || !wait || after === null) return { messages: rows, last_id: this.lastId(), room_state: this.roomState(who, room) };
    await new Promise((resolve) => {
      let t;
      const done = () => { clearTimeout(t); this.waiters.delete(done); resolve(); };
      t = setTimeout(done, wait * 1000);
      this.waiters.add(done);
    });
    if (!this.ready) return { messages: [], last_id: 0, room_state: { v: 1 } };
    rows = this.read(after, limit);
    return { messages: rows, last_id: this.lastId(), room_state: this.roomState(who, room) };
  }
}
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

export default {
  async fetch(request, env) {
    try {
      return await routeRequest(request, env);
    } catch (e) {
      // A malformed %-escape in a path segment (decodeURIComponent throws
      // URIError) is the client's mistake: answer 400, not a 500.
      if (e instanceof URIError) return json({ error: "The URL has a malformed %-escape" }, 400);
      throw e;
    }
  },
};

async function routeRequest(request, env) {
  {
    const url = new URL(request.url);
    const path = url.pathname;
    const owner = !!env.OWNER_KEY && request.headers.get("X-Owner-Key") === env.OWNER_KEY;
    const invite = (request.headers.get("X-Invite-Token") || url.searchParams.get("invite") || "").trim();
    // Media reads (phase E close-out, 2026-11-11): ?invite= is retired on
    // the byte-serving routes - a media GET/HEAD authenticates with the
    // header or a signed URL only. Writes and non-media routes keep the
    // merged form above.
    const inviteHdr = (request.headers.get("X-Invite-Token") || "").trim();
    const rc = { request, env, url, path, owner, invite, inviteHdr };

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (path === "/") return page(env, url.origin);
    if (path === "/api/build") return json({ build: await currentBuildId(env, url.origin) });
    if (path === "/api/test-hooks/game-images") { const r = await hookGameImages(rc); if (r !== undefined) return r; }
    if (path === "/api/test-hooks/r2-fail") { const r = await hookR2Fail(rc); if (r !== undefined) return r; }
    if (path === "/api/test-hooks/ticket-ttl") { const r = await hookTicketTtl(rc); if (r !== undefined) return r; }
    if (path === "/api/test-hooks/coderace-secret") { const r = await hookCoderaceSecret(rc); if (r !== undefined) return r; }
    if (path === "/api/test-hooks/game-expire") { const r = await hookGameExpire(rc); if (r !== undefined) return r; }
    if (path === "/api/test-hooks/sketch-judge") { const r = await hookSketchJudge(rc); if (r !== undefined) return r; }
    if (path === "/api/test-hooks/lettergrid") { const r = await hookLetterGrid(rc); if (r !== undefined) return r; }
    if (path === "/api/test-hooks/sigv4") { const r = await hookSigv4(rc); if (r !== undefined) return r; }
    if (path === "/api/test-hooks/liarsdice") { const r = await hookLiarsDice(rc); if (r !== undefined) return r; }
    const usm = path.match(/^\/api\/uploads\/([^\/]+)\/([^\/]+)\/(part|sign|status|finish|abort)\/?$/);
    if (usm) { const r = await uploadLinkStepRoute(rc, usm); if (r !== undefined) return r; }
    const um = path.match(/^\/api\/uploads\/([^\/]+)\/([^\/]+)\/?$/);
    if (um) { const r = await uploadLinkRoute(rc, um); if (r !== undefined) return r; }
    if (path === "/emoji.json") { const r = await emojiRoute(rc); if (r !== undefined) return r; }
    if (path === "/api" || path === "/api/" || path === "/api/docs" || path === "/api.txt" || path === "/llms.txt") { const r = await apiDocsRoute(rc); if (r !== undefined) return r; }

    if (path === "/api/create-room") { const r = await createRoomRoute(rc); if (r !== undefined) return r; }

    const rm = path.match(/^\/(?:r|api\/rooms)\/([^\/]+)/);
    if (rm) { const r = await roomRoute(rc, rm); if (r !== undefined) return r; }

    if (path === "/manifest.webmanifest" && request.method === "GET") { const r = await manifestRoute(rc); if (r !== undefined) return r; }
    if (path === "/sw.js" && request.method === "GET") { const r = await serviceWorkerRoute(rc); if (r !== undefined) return r; }
    const iconMatch = path.match(/^\/icons\/icon-(192|512|512-maskable|180)\.png$/);
    if (iconMatch && request.method === "GET") { const r = await iconRoute(rc, iconMatch); if (r !== undefined) return r; }
    if (path === "/api/push/key" && request.method === "GET") { const r = await pushKeyRoute(rc); if (r !== undefined) return r; }

    let m = path.match(/^\/r\/([^\/]+)\/?$/);
    if (m) { const r = await roomPageRoute(rc, m); if (r !== undefined) return r; }

    m = path.match(/^\/api\/rooms\/([^\/]+)\/stream\/?$/);
    if (m) { const r = await streamRoute(rc, m); if (r !== undefined) return r; }

    m = path.match(/^\/api\/rooms\/([^\/]+)\/agent-recipe(?:\/(script))?\/?$/);
    if (m) { const r = await recipeRoute(rc, m); if (r !== undefined) return r; }

    m = path.match(/^\/api\/rooms\/([^\/]+)\/tools(?:\/([a-z]+))?\/?$/);
    if (m) { const r = await toolsRoute(rc, m); if (r !== undefined) return r; }

    m = path.match(/^\/api\/rooms\/([^\/]+)\/mcp\/?$/);
    if (m) { const r = await mcpRoute(rc, m); if (r !== undefined) return r; }

    m = path.match(/^\/api\/rooms\/([^\/]+)\/(?:avatar|members\/([^\/]+)\/avatar|avatars\/([^\/]+))\/?$/);
    if (m) { const r = await avatarRoute(rc, m); if (r !== undefined) return r; }

    m = path.match(/^\/api\/rooms\/([^\/]+)\/(?:voice(?:\/(sample|reclone))?|members\/([^\/]+)\/voice(?:\/(sample|reclone))?)\/?$/);
    if (m) { const r = await voiceRoute(rc, m); if (r !== undefined) return r; }

    m = path.match(/^\/api\/rooms\/([^\/]+)\/members\/([^\/]+)\/?$/);
    if (m) { const r = await memberRoute(rc, m); if (r !== undefined) return r; }

    m = path.match(/^\/api\/rooms\/([^\/]+)\/invites(?:\/([^\/]+))?\/?$/);
    if (m) { const r = await invitesRoute(rc, m); if (r !== undefined) return r; }

    m = path.match(/^\/api\/rooms\/([^\/]+)\/constitution\/?$/);
    if (m) { const r = await constitutionRoute(rc, m); if (r !== undefined) return r; }

    m = path.match(/^\/api\/rooms\/([^\/]+)\/questions(?:\/(\d+))?\/?$/);
    if (m) { const r = await questionsRoute(rc, m); if (r !== undefined) return r; }

    m = path.match(/^\/api\/rooms\/([^\/]+)\/games\/(\d+)\/sketch\/(\d+)\/?$/);
    if (m) { const r = await sketchImageRoute(rc, m); if (r !== undefined) return r; }
    m = path.match(/^\/api\/rooms\/([^\/]+)\/games(?:\/(\d+)(?:\/(moves|cancel|accept|decline))?)?\/?$/);
    if (m) { const r = await gamesRoute(rc, m); if (r !== undefined) return r; }

    m = path.match(/^\/api\/rooms\/([^\/]+)\/(welcome|members|digests|stakes|decisions)(?:\/(\d+))?\/?$/);
    if (m) { const r = await boardRoute(rc, m); if (r !== undefined) return r; }

    m = path.match(/^\/api\/rooms\/([^\/]+)\/push\/(subscribe|unsubscribe|status)\/?$/);
    if (m) { const r = await pushRoute(rc, m); if (r !== undefined) return r; }

    m = path.match(/^\/api\/rooms\/([^\/]+)\/messages\/(\d+)\/speak\/?$/);
    if (m) { const r = await speakRoute(rc, m); if (r !== undefined) return r; }

    m = path.match(/^\/api\/rooms\/([^\/]+)\/messages\/(\d+)\/audio\/?$/);
    if (m) { const r = await audioRoute(rc, m); if (r !== undefined) return r; }

    m = path.match(/^\/api\/rooms\/([^\/]+)\/messages\/(\d+)\/image\/?$/);
    if (m) { const r = await imageRoute(rc, m); if (r !== undefined) return r; }

    m = path.match(/^\/api\/rooms\/([^\/]+)\/messages\/(\d+)\/video\/?$/);
    if (m) { const r = await videoRoute(rc, m); if (r !== undefined) return r; }

    m = path.match(/^\/api\/rooms\/([^\/]+)\/messages\/(\d+)\/(html|doc|file)\/?$/);
    if (m) { const r = await artifactRoute(rc, m); if (r !== undefined) return r; }

    m = path.match(/^\/api\/rooms\/([^\/]+)\/messages\/(\d+)\/video\/stream\/?$/);
    if (m) { const r = await videoStreamRoute(rc, m); if (r !== undefined) return r; }

    m = path.match(/^\/api\/rooms\/([^\/]+)\/messages\/(\d+)\/(image|audio|video|file)\/(start|part|sign|finish|abort|status)\/?$/);
    if (m) { const r = await uploadRoute(rc, m); if (r !== undefined) return r; }

    m = path.match(/^\/api\/rooms\/([^\/]+)\/messages\/(\d+)\/publish\/?$/);
    if (m) { const r = await publishRoute(rc, m); if (r !== undefined) return r; }

    m = path.match(/^\/api\/rooms\/([^\/]+)\/messages\/(\d+)\/upload-ticket\/?$/);
    if (m) { const r = await uploadTicketRoute(rc, m); if (r !== undefined) return r; }

    m = path.match(/^\/api\/rooms\/([^\/]+)\/messages\/(\d+)\/?$/);
    if (m) { const r = await messageRoute(rc, m); if (r !== undefined) return r; }

    m = path.match(/^\/api\/rooms\/([^\/]+)\/(upload|video)\/resume\/?$/);
    if (m) { const r = await uploadResumeRoute(rc, m); if (r !== undefined) return r; }

    m = path.match(/^\/api\/rooms\/([^\/]+)\/messages\/(\d+)\/reactions\/?$/);
    if (m) { const r = await reactionsRoute(rc, m); if (r !== undefined) return r; }

    m = path.match(/^\/api\/rooms\/([^\/]+)\/attachments\/?$/);
    if (m) { const r = await attachmentsRoute(rc, m); if (r !== undefined) return r; }

    m = path.match(/^\/api\/rooms\/([^\/]+)\/messages\/?$/);
    if (m) { const r = await messagesRoute(rc, m); if (r !== undefined) return r; }

    return new Response("Not found", { status: 404 });
  }
}
