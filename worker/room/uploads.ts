// Room methods: the resumable upload engine (sessions, parts, direct-to-R2 signing, finish/abort), upload tickets, draft sweeping.

import {
  AUDIO_MAX,
  IMAGE_MAX,
  MAX_TEXT,
  mediaTooBig,
  STORE_MSG,
  STREAM_PART,
  TICKET_MAX_PER_MEMBER,
  TICKET_MAX_TRIES,
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
  VIDEO_STREAM_TOO_BIG,
  VIDEO_TYPES,
} from "../limits.js";
import { b64urlEncode, sha256hex } from "../lib/crypto.js";
import { cleanFileName, sniffAudio, sniffImage, sniffVideo } from "../lib/sniff.js";
import { goneError, isGoneError, isStoreError } from "../lib/errors.js";
import {
  cleanMediaType,
  partLength,
  upDirectOffBig,
  upNoun,
  upSniff,
  upTypeError,
  uploadPlan,
  uploadPlanDirect,
} from "../uploads/plan.js";
import { directUploadsProven } from "../platform/r2-direct-check.js";
import { r2DirectConfigured, r2ListParts } from "../platform/r2-s3.js";
import type { CountRow, MdRow, MsgRow, Room, UppRow, UtRow } from "./Room.js";
import { warn } from "../lib/log.js";
import { nameFold, stripControlChars } from "../lib/text.js";
import { hiddenDraft } from "./media.js";

/** An upload session as the engine reads it (upSession): the md row's
 *  object, upload and plan columns. */
export type UpSession = Pick<MdRow, "type" | "r2key" | "size" | "upload_id" | "fp" | "part_size" | "name" | "began" | "mode">;
/** A direct upload in flight, as a removal found it (directUploadsOf). */
export type DirectSession = { msg: number, kind: string, upload_id: string };
/** A resumable upload asked for with a ticket (mintUploadTicket's
 *  session): the file's size, type and name, and whether its parts go
 *  straight to storage, all as the request sent them. */
export type UploadSessionAsk = { size: number | string | null | undefined, type?: unknown, name?: unknown, direct?: unknown };
/** uploadStart's answer: the part plan, or { status, error }. */
export type UpStart = { status: number, error?: string, part_size?: number, parts?: number, expires_at?: number, direct?: boolean };
/** A started (or resumed) session's plan, as uploadStart answers it. */
export type UpPlan = { status: 200, part_size: number, parts: number, resumed: boolean, received: number[], expires_at: number, direct: boolean };
/** uploadFinish's answer: the stored file, or { status, error } (with
 *  the missing part numbers on a 409 for parts). Shared by a finish sent
 *  again while the first runs. */
export type UpFinish = { status: 200, type: string, bytes: number, name: string | null, published: boolean } | { status: number, error: string, missing?: number[] };
/** What a finish may say about the file it means (all optional): the
 *  size and fingerprint (fp) the client gave at start, and for an upload
 *  link its expiry, which is its session's start plus UP_SESSION_MS. */
export type UpFinishAsk = { transcript?: unknown, size?: number | null, fp?: string | null, expires?: number | null };

export const UploadMethods = {
  // ---- Upload tickets: a single-use credential for one PUT ----
  // Minted by begin_upload (MCP) or the REST upload-ticket route for a draft
  // the member owns. The redeem route is deliberately unauthenticated: the
  // ticket in the URL is the whole credential, which is what lets an agent
  // whose invite token lives in its gateway (never in its sandbox) upload.
  // The TTL comes from ticketTtlMs (room/test-hooks.ts).
  // The upload links a member opened (all members' with null) stop
  // working. The owner's own stay: they are checked against no member.
  /** @param name the member, or null for everyone */
  dropUploadLinks(name: string | null) {
    if (name === null) { this.sql.exec("DELETE FROM ut WHERE owner IS NULL"); return; }
    const fold = nameFold(name);
    for (const r of this.sql.exec<Pick<UtRow, "member">>("SELECT DISTINCT member FROM ut WHERE owner IS NULL").toArray()) {
      if (nameFold(r.member) === fold) this.sql.exec("DELETE FROM ut WHERE member = ? AND owner IS NULL", r.member);
    }
  },

  // The direct uploads in flight of members who are out (revoke,
  // revokeAll), as the removal finds them: taken in the removal's own
  // call, so a session the name's next holder starts afterwards is never
  // among them. Only direct sessions: their part addresses are presigned
  // for UP_SIGN_TTL and nothing but aborting the upload recalls them. A
  // session through the site is shut to the removed holder already (its
  // link went with dropUploadLinks, every step checks the invite), and
  // cancelling it threw away the next holder's partly sent file on a
  // plain link rotation.
  directUploadsOf(names: string[]): DirectSession[] {
    const folds = new Set(names.map((n) => nameFold(n)));
    return this.sql.exec<DirectSession & { sender: string }>("SELECT md.msg AS msg, md.kind AS kind, md.upload_id AS upload_id, m.sender AS sender FROM md JOIN m ON m.id = md.msg WHERE md.upload_id IS NOT NULL AND md.mode = 'direct'").toArray()
      .filter((r) => folds.has(nameFold(r.sender))).map((r) => ({ msg: r.msg, kind: r.kind, upload_id: r.upload_id }));
  },

  // Those sessions end, each in its message and kind's turn and only
  // while the row still holds the same upload: the rows go and storage
  // aborts the upload, which is what makes R2 refuse the addresses. Run
  // after the removal's answer (waitUntil), since a turn can be a long
  // finish. This used to pick the sessions only now, by name, and so
  // cancelled the upload of whoever held the name's new invite. A file
  // already in place stays.
  async abortUploads(sessions: DirectSession[]) {
    const gen = this.gen;
    for (const r of sessions) {
      // deleted meanwhile: its destroy aborted every upload
      if (!this.alive(gen)) return;
      try {
        await this.withMediaLock(r.msg, r.kind, async (live) => {
          const row = this.upSession(r.msg, r.kind);
          if (!row || row.upload_id !== r.upload_id) return;
          if (this.env && this.env.MEDIA) { try { await this.env.MEDIA.resumeMultipartUpload(row.r2key, r.upload_id).abort(); } catch { /* already completed, aborted or expired */ } }
          if (!live()) return;
          this.upDrop(r.msg, r.kind, r.upload_id);
        });
      } catch (e) {
        // the room was deleted meanwhile: its destroy aborts what is left
        if (isGoneError(e)) return;
        warn("upload.abort", e, { room: this.roomName, id: r.msg, kind: r.kind });
      }
    }
  },

  /** @param session opens a resumable upload instead of a single-shot
   *  ticket: the engine session starts here, and its link (sess) is good
   *  for the session's whole life, for its part, status, finish and abort
   *  steps only. */
  /** @param token the caller's invite (not needed with the owner key): see inviteStill (room/members.ts) */
  async mintUploadTicket(msgId: number, kind: string, member: string, room: string, byOwner: boolean, session?: UploadSessionAsk | null, token?: string | null) {
    if (!this.ready) return { status: 404, error: "No message with that id" };
    const gen = this.gen;
    const gone = byOwner ? null : this.inviteStill(token, member);
    if (gone) return gone;
    const r = this.sql.exec<Pick<MsgRow, "sender" | "draft">>("SELECT sender, draft FROM m WHERE id = ?", msgId).toArray()[0];
    if (!r || hiddenDraft(r, member, byOwner)) return { status: 404, error: "No message with that id" };
    if (!r.draft) return { status: 409, error: "Upload tickets are minted for drafts; that message is already published" };
    if (String(r.sender).toLowerCase() !== String(member || "").toLowerCase()) return { status: 403, error: "You can only open an upload for your own draft" };
    const now = Date.now();
    this.sql.exec("DELETE FROM ut WHERE expires < ?", now);
    // A resumable link counts while its upload is in flight.
    const open = this.sql.exec<CountRow>("SELECT COUNT(*) AS n FROM ut WHERE lower(member) = lower(?) AND used IS NULL AND expires > ? AND (sess IS NULL OR EXISTS (SELECT 1 FROM md WHERE md.msg = ut.msg AND md.kind = ut.kind AND md.upload_id IS NOT NULL))", member, now).toArray()[0];
    // Links being minted right now count too: the row is written only
    // after the awaits below, so without this a burst of calls arriving
    // together would each see the same count and all pass the cap.
    const who = nameFold(String(member || ""));
    const minting = this.utMinting.get(who) || 0;
    if (((open && open.n) || 0) + minting >= TICKET_MAX_PER_MEMBER) return { status: 429, code: "limit_reached", error: "Too many outstanding upload tickets (" + TICKET_MAX_PER_MEMBER + "). Finish one or let one expire first." };
    this.utMinting.set(who, minting + 1);
    let plan: UpStart | null = null;
    const raw = b64urlEncode(crypto.getRandomValues(new Uint8Array(32)));
    const maxBytes = session ? UP_MAX : kind === "image" ? IMAGE_MAX : kind === "audio" ? AUDIO_MAX : VIDEO_MAX;
    let expires = now + this.ticketTtlMs();
    try {
      if (session) {
        plan = await this.uploadStart(msgId, kind, member, false, room, session.size, session.type, session.name, null, session.direct);
        // a refused start always says why (uploadStart); the fallback only names the shape
        if (plan.status !== 200) return { ...plan, error: plan.error || "The upload could not start" };
        // a started plan always has its expiry
        expires = plan.expires_at ?? now;
      }
      const h = await sha256hex(raw);
      // no link into a room deleted during the awaits above (Room.fence);
      // its delete ended the session started for it
      this.fence(gen);
      // Asked again here, with no await between the answer and the write:
      // revoke() drops a member's links, so one written after it (the
      // awaits above leave room) would be the one link it missed.
      const revoked = byOwner ? null : this.inviteStill(token, member);
      if (revoked) {
        if (plan) { try { await this.uploadAbort(msgId, kind, member, false); } catch (e) { warn("upload.abort", e, { room }); } }
        return revoked;
      }
      this.sql.exec("INSERT INTO ut (h, msg, kind, member, created, expires, max_bytes, tries, owner, sess) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)",
        h, msgId, kind, String(member), now, expires, maxBytes, byOwner ? 1 : null, session ? 1 : null);
    } finally {
      const left = (this.utMinting.get(who) || 1) - 1;
      if (left > 0) this.utMinting.set(who, left); else this.utMinting.delete(who);
    }
    const out: { status: number, ticket: string, expires: number, max_bytes: number, size?: number, part_size?: number, parts?: number, direct?: boolean } = { status: 200, ticket: raw, expires: expires, max_bytes: maxBytes };
    // plan is set only for a session
    if (plan) { out.size = Math.floor(Number((session as UploadSessionAsk).size)); out.part_size = plan.part_size; out.parts = plan.parts; out.direct = !!plan.direct; }
    return out;
  },

  // A resumable upload link resolves to the one message and kind it may
  // upload to, acting as the member who opened it. Unlike a single-shot
  // ticket it is not spent by use: it lasts as long as the upload can.
  async uploadSessionTicket(rawTicket: unknown) {
    if (!this.ready) return { status: 404, error: "Unknown upload link" };
    const t = this.sql.exec<Pick<UtRow, "msg" | "kind" | "member" | "expires" | "owner" | "sess">>("SELECT msg, kind, member, expires, owner, sess FROM ut WHERE h = ?", await sha256hex(String(rawTicket || ""))).toArray()[0];
    if (!t || !t.sess) return { status: 404, error: "Unknown upload link" };
    if (Date.now() > t.expires) return { status: 410, error: "This upload link has expired" };
    if (!t.owner && !this.sql.exec("SELECT token FROM inv WHERE lower(name) = lower(?) AND revoked IS NULL", t.member).toArray().length) return { status: 403, error: "The member who opened this upload is no longer in the room" };
    const m = this.sql.exec<Pick<MsgRow, "sender">>("SELECT sender FROM m WHERE id = ?", t.msg).toArray()[0];
    if (!m) return { status: 404, error: "The message this upload was opened for is gone" };
    if (String(m.sender).toLowerCase() !== String(t.member).toLowerCase()) return { status: 409, error: "The message changed hands; open a fresh upload" };
    return { status: 200, msg: t.msg, kind: t.kind, member: t.member, expires: t.expires };
  },

  // A single-shot ticket as it stands: the row, or why it cannot be used.
  // An unknown room answers exactly like an unknown ticket, and a garbled
  // ticket like one that never existed: no hint either way.
  async upTicketRow(rawTicket: unknown) {
    if (!this.ready) return { status: 404 as const, error: "Unknown upload ticket" };
    const h = await sha256hex(String(rawTicket || ""));
    const t = this.sql.exec<Pick<UtRow, "msg" | "kind" | "member" | "expires" | "max_bytes" | "used" | "tries" | "owner" | "sess">>("SELECT msg, kind, member, expires, max_bytes, used, tries, owner, sess FROM ut WHERE h = ?", h).toArray()[0];
    if (!t) return { status: 404 as const, error: "Unknown upload ticket" };
    if (t.sess) return { status: 405 as const, error: "This is a resumable upload link: PUT the parts to its /part?n=N address, then POST its /finish" };
    if (t.used) return { status: 410 as const, error: "This upload link has already been used" };
    if (Date.now() > t.expires) return { status: 410 as const, error: "This upload link has expired" };
    if (t.tries >= TICKET_MAX_TRIES) return { status: 410 as const, error: "This upload link has had too many attempts" };
    return { status: 200 as const, h: h, t: t };
  },

  // What the upload route needs before it reads a single-shot PUT's
  // body: whether the ticket can be used at all, and how many bytes it
  // takes. The route used to read the whole body first - anything up to
  // the edge's 100 MB, from anyone, with no ticket at all - and only then
  // ask here. Spends no attempt: redeemUpload checks it all again.
  async uploadTicketLimit(rawTicket: unknown) {
    const r = await this.upTicketRow(rawTicket);
    if (r.status !== 200) return r;
    return { status: 200 as const, kind: r.t.kind, max_bytes: r.t.max_bytes };
  },

  async redeemUpload(rawTicket: unknown, data: ArrayBuffer, room: string) {
    const row = await this.upTicketRow(rawTicket);
    if (row.status !== 200) return row;
    const { h, t } = row;
    const now = Date.now();
    this.sql.exec("UPDATE ut SET tries = tries + 1 WHERE h = ?", h);
    // Any active invite under the name counts: a member whose invite was
    // rotated has a revoked row and a live one. Owner-minted tickets carry
    // no member check (the owner posts under any name).
    if (!t.owner && !this.sql.exec("SELECT token FROM inv WHERE lower(name) = lower(?) AND revoked IS NULL", t.member).toArray().length) return { status: 403, error: "The member who opened this upload is no longer in the room" };
    const m = this.sql.exec<Pick<MsgRow, "sender" | "draft">>("SELECT sender, draft FROM m WHERE id = ?", t.msg).toArray()[0];
    if (!m) return { status: 404, error: "The draft this upload was opened for is gone" };
    if (!m.draft) return { status: 409, error: "The draft this upload was opened for is already published" };
    if (String(m.sender).toLowerCase() !== String(t.member).toLowerCase()) return { status: 409, error: "The draft changed hands; open a fresh upload" };
    const kind = t.kind;
    if (!data.byteLength) return { status: 400, error: "The upload body is empty" };
    if (data.byteLength > t.max_bytes) return { status: 413, error: mediaTooBig(kind as "image" | "audio" | "video", "single-shot") };
    const type = kind === "image" ? sniffImage(data) : kind === "audio" ? sniffAudio(data) : sniffVideo(data);
    if (!type) return { status: 415, error: kind === "image" ? "Image must be JPEG, PNG, GIF, WebP or AVIF" : kind === "audio" ? "Audio must be MP3, WAV, OGG, WebM or M4A" : "Video must be MP4, WebM or MOV" };
    // Claim the ticket before the R2 write: the await lets a second PUT with
    // the same ticket in, and it must see the ticket as spent. A storage
    // failure is a 503, as on every other path, and releases the claim, so
    // the PUT can simply retry.
    this.sql.exec("UPDATE ut SET used = ? WHERE h = ?", now, h);
    try { await this.putMedia(t.msg, kind, data, type, room); } catch (e) {
      // a deleted room has no ticket row to release
      if (isGoneError(e)) throw e;
      this.sql.exec("UPDATE ut SET used = NULL WHERE h = ?", h);
      if (isStoreError(e)) return { status: 503, error: STORE_MSG };
      throw e;
    }
    if (kind === "image") this.sql.exec("UPDATE m SET image_type = ?, image_size = ? WHERE id = ?", type, data.byteLength, t.msg);
    if (kind === "audio") this.sql.exec("UPDATE m SET audio_type = ?, audio_size = ? WHERE id = ?", type, data.byteLength, t.msg);
    if (kind === "video") this.sql.exec("UPDATE m SET video_type = ?, video_size = ? WHERE id = ?", type, data.byteLength, t.msg);
    // published while the bytes were being stored: the room hears of them now
    this.mediaLanded(t.msg, room);
    let published = false;
    const mp = await this.maybeAutoPublish(t.msg, room);
    if (mp) published = true;
    return { status: 200, type: type, bytes: data.byteLength, published: published };
  },

  // ---- Drafts: a long upload finishes before its message goes live ----
  async sweepDrafts() {
    if (this._sweptAt && Date.now() - this._sweptAt < 600000) return;
    // a room deleted during one of the storage calls below has no rows
    // left to sweep, and one created since is not this room
    const gen = this.gen;
    const now = Date.now();
    this._sweptAt = now;
    // A draft lives a day - or, while an upload for it is in flight, as
    // long as that upload can (UP_SESSION_MS from its start: R2 drops an
    // unfinished multipart upload after 7 days).
    // ... and a day from the last file that finished: a long upload can
    // end when the draft is already older than that, and the sweep used to
    // take the draft and the finished file the moment it did - before the
    // publish, or before the message's second file could start.
    const stale = this.sql.exec<Pick<MsgRow, "id">>("SELECT id FROM m WHERE draft IS NOT NULL AND draft != 0 AND ts < ? AND NOT EXISTS (SELECT 1 FROM md WHERE md.msg = m.id AND ((md.upload_id IS NOT NULL AND COALESCE(md.began, m.ts) > ?) OR md.at > ?))", now - 86400000, now - UP_SESSION_MS, now - 86400000).toArray();
    for (const d of stale) {
      // rows first, storage after (see deleteMessage)
      const media = this.sql.exec<Pick<MdRow, "r2key" | "upload_id">>("SELECT r2key, upload_id FROM md WHERE msg = ?", d.id).toArray();
      this.sql.exec("DELETE FROM upp WHERE msg = ?", d.id);
      this.sql.exec("DELETE FROM md WHERE msg = ?", d.id);
      this.sql.exec("DELETE FROM rx WHERE msg = ?", d.id);
      this.sql.exec("DELETE FROM m WHERE id = ?", d.id);
      await this.dropStored(media);
      if (!this.alive(gen)) return;
    }
    // Media whose message is gone: a write that was under way when the
    // message was deleted finishes after it (mediaShown never serves
    // these). A few at a time; the next sweep takes the rest.
    const orphans = this.sql.exec<Pick<MdRow, "msg" | "kind" | "r2key" | "upload_id">>("SELECT msg, kind, r2key, upload_id FROM md WHERE msg NOT IN (SELECT id FROM m) LIMIT 50").toArray();
    for (const o of orphans) {
      this.sql.exec("DELETE FROM upp WHERE msg = ? AND kind = ?", o.msg, o.kind);
      this.sql.exec("DELETE FROM md WHERE msg = ? AND kind = ?", o.msg, o.kind);
    }
    await this.dropStored(orphans);
  },

  // ---- The upload engine (UP_KINDS): one resumable flow for every kind ----
  // The Room keeps each session - its md row (R2 key and multipart upload
  // id, the pinned part plan, the file's size, fingerprint and name, when
  // it began) and one upp receipt per part R2 has acknowledged. The
  // Worker moves the bytes (streamUploadPart), so a part never passes
  // through here. Every step checks the caller is the message's sender
  // or holds the owner key.
  upAuth(id: number, who: string | null | undefined, owner: boolean | undefined, kind: string): { status: 404 | 403, error: string } | { status: 200, msg: Pick<MsgRow, "sender" | "ts" | "draft"> } {
    const r = this.sql.exec<Pick<MsgRow, "sender" | "ts" | "draft">>("SELECT sender, ts, draft FROM m WHERE id = ?", id).toArray()[0];
    if (!r || hiddenDraft(r, who, owner)) return { status: 404, error: "No message with that id" };
    if (!owner && String(r.sender).toLowerCase() !== String(who || "").toLowerCase()) return { status: 403, error: "You can only attach " + upNoun(kind) + " to your own messages" };
    return { status: 200, msg: r };
  },

  upSession(id: number, kind: string): UpSession | null {
    return this.sql.exec<UpSession>("SELECT type, r2key, size, upload_id, fp, part_size, name, began, mode FROM md WHERE msg = ? AND kind = ?", id, kind).toArray()[0] || null;
  },

  // The plan a session runs on, pinned at its start (streamed ones
  // STREAM_PART).
  upPlan(row: UpSession) {
    const ps = row.part_size as number; // a session's plan is pinned at its start
    return { part_size: ps, parts: Math.max(1, Math.ceil(row.size / ps)) };
  },

  /** @param msg the message (its time stands in for a missing start) */
  upBegan(row: Pick<MdRow, "began">, msg: { ts: number } | null | undefined) { return row.began || (msg && msg.ts) || 0; },

  // An hour short of R2's 7 days, so no part goes to an upload R2 has
  // already thrown away.
  upExpired(row: Pick<MdRow, "began">, msg: { ts: number } | null | undefined) { return Date.now() - this.upBegan(row, msg) > UP_SESSION_MS - 3600000; },

  // The parts in, as part number -> etag. A session whose parts go
  // through the Worker keeps its own receipts (upp); a direct one asks
  // storage itself (ListParts), and a part there of the wrong length
  // counts as not in, so it is sent again. Throws when storage won't say.
  async upReceived(id: number, kind: string, row: UpSession | null): Promise<Map<number, string>> {
    /** etag by part number */
    const got: Map<number, string> = new Map();
    if (row && row.mode === "direct") {
      const plan = this.upPlan(row);
      // a direct session is an upload in flight, so it has its upload id
      const listed = await r2ListParts(this.env, row.r2key, row.upload_id as string);
      for (const [n, p] of listed) if (n <= plan.parts && p.size === partLength(row.size, plan.part_size, n)) got.set(n, p.etag);
      return got;
    }
    for (const p of this.sql.exec<Pick<UppRow, "n" | "etag">>("SELECT n, etag FROM upp WHERE msg = ? AND kind = ?", id, kind).toArray()) got.set(p.n, p.etag);
    return got;
  },

  // Whether a session may send its parts straight to R2: the client asked
  // (direct), the credential is configured, the switch is on - or the
  // owner asked with "force", to try it live before the switch flips -
  // and storage has shown that an address's credential can only upload
  // parts of its own object (platform/r2-direct-check.ts). Otherwise the
  // parts go through the site.
  /** @param direct the client's direct: true, or "force" */
  async upDirectAllowed(direct: unknown, owner: boolean) {
    if (!direct || !r2DirectConfigured(this.env)) return false;
    if (this.env.R2_DIRECT !== "1" && !(direct === "force" && !!owner)) return false;
    return directUploadsProven(this.env);
  },

  // Whether the direct path is shut for this caller: R2_DIRECT is off and
  // this is not the owner, who may force it to try it live. Asked of
  // sessions already in flight too: turning the switch off used to stop
  // only new ones, while resumes stayed direct and /sign kept signing.
  upDirectOff(owner: boolean | undefined) {
    return this.env.R2_DIRECT !== "1" && !owner;
  },

  // Whether a session that began direct is still to be sent that way when
  // it is picked up again. Parts that fit one request to the site can go
  // through it as well (PUT /part: storage keeps one list of parts however
  // they arrive), and do while the direct check is not passing or the
  // switch is off, so an upload in flight carries on with the parts it
  // has. Bigger parts have no other way in: their sign waits for the
  // check (with the switch off, upStartNow refuses the resume).
  /** @param partSize the session's part length in bytes */
  async upStaysDirect(mode: string | null | undefined, partSize: number, owner?: boolean) {
    if (mode !== "direct" || this.upDirectOff(owner)) return false;
    return partSize > UP_PART_MAX || directUploadsProven(this.env);
  },

  /**
   * @param size the file's length in bytes, as the request sent it
   * @param fp the file's fingerprint
   */
  async uploadStart(id: number, kind: string, who: string | null | undefined, owner: boolean, room: string, size: number | string | null | undefined, type: unknown, name: unknown, fp: unknown, direct: unknown) {
    if (UP_KINDS.indexOf(kind) < 0) return { status: 400, error: "kind must be one of: " + UP_KINDS.join(", ") };
    const gen = this.gen;
    this.fence(gen);
    // the sweep runs before the message is looked at, never between the look and the write
    await this.sweepDrafts();
    this.fence(gen);
    const a = this.upAuth(id, who, owner, kind);
    if (a.status !== 200) return a;
    if (!this.env || !this.env.MEDIA) return { status: 501, error: "The R2 binding (MEDIA) is not configured" };
    size = Math.floor(Number(size));
    if (!Number.isFinite(size) || size < 1) return { status: 400, error: "\"size\" is required: the file's exact length in bytes" };
    const useDirect = await this.upDirectAllowed(direct, owner);
    this.fence(gen);
    if (size > (useDirect ? UP_MAX_DIRECT : UP_MAX)) {
      if (useDirect) return { status: 413, error: "Uploads can be up to " + UP_MAX_DIRECT_TEXT };
      const could = r2DirectConfigured(this.env) && this.env.R2_DIRECT === "1";
      // asked for direct and did not get it: the direct check is not passing right now
      const hint = !could ? "" : direct ? "; direct uploads, which carry up to " + UP_MAX_DIRECT_TEXT + ", are paused for the moment - try again in a few minutes" : "; start with \"direct\": true to send the parts straight to storage, up to " + UP_MAX_DIRECT_TEXT;
      return { status: 413, error: "Uploads through the site can be up to " + UP_MAX_TEXT + hint };
    }
    const fpv = fp ? String(fp).slice(0, 200) : null;
    const want = size;
    // the direct check above can wait on storage: from here the session
    // is decided and replaced in this message and kind's turn (withMediaLock)
    return this.withMediaLock(id, kind, (live) => this.upStartNow(id, kind, who, owner, room, want, type, name, fpv, useDirect, live));
  },

  /** uploadStart's part that reads and replaces the session, in the turn */
  /** @param live false once the room is deleted (withMediaLock) */
  async upStartNow(id: number, kind: string, who: string | null | undefined, owner: boolean, room: string, size: number, type: unknown, name: unknown, fp: string | null, useDirect: boolean, live: () => boolean): Promise<UpPlan | { status: number, error: string }> {
    const a = this.upAuth(id, who, owner, kind);
    if (a.status !== 200) return a;
    const media = this.env.MEDIA;
    const prev = this.upSession(id, kind);
    if (prev && prev.r2key && !prev.upload_id) return { status: 409, error: "That message already has " + upNoun(kind) };
    if (prev && prev.upload_id && prev.size === size && (!fp || !prev.fp || prev.fp === fp) && !this.upExpired(prev, a.msg)) {
      // The same file again (a retry after an interruption, or from
      // another device): keep the parts already stored, on the route the
      // session began with (upStaysDirect has the one exception).
      const plan = this.upPlan(prev);
      if (prev.mode === "direct" && plan.part_size > UP_PART_MAX && this.upDirectOff(owner)) return { status: 409, error: upDirectOffBig(kind) };
      let received: number[] | null = null;
      try { received = Array.from((await this.upReceived(id, kind, prev)).keys()).sort((x, y) => x - y); }
      catch (e) {
        const em = String((e && (e as Error).message) || e);
        // An answer of "nothing received" sent the client to upload the
        // whole file again over parts storage still had: it asks again.
        if (!/NoSuchUpload/i.test(em)) return { status: 502, error: "Storage didn't list this upload's parts (" + em + "); start again" };
        warn("upload.received", e, { room, id, kind });
        // Or an earlier finish completed it in storage and never recorded
        // so (its instance restarted between the two), and the client,
        // having lost that answer, started instead of finishing: it was
        // sent to upload the whole file again over an object already in
        // place. upFinishNow tells the two apart by the object at the key,
        // as a finish sent again does, and indexes it; the answer is then
        // the one for a file in place.
        const done = await this.upFinishNow(id, kind, who, owner, room, null, live);
        if (done.status === 200) return { status: 409, error: "That message already has " + upNoun(kind) };
        // Storage has dropped it (expired or cancelled): a fresh session
        // below, rather than a resume onto an upload that is gone.
      }
      if (received) return { status: 200, part_size: plan.part_size, parts: plan.parts, resumed: true, received: received, expires_at: this.upBegan(prev, a.msg) + UP_SESSION_MS, direct: await this.upStaysDirect(prev.mode, plan.part_size, owner) };
    }
    if (this.r2TestFail()) return { status: 503, error: STORE_MSG };
    const key = this.mediaKey(room, id, kind);
    const declared = cleanMediaType(type);
    // The new upload is created before the old one is touched: a create
    // that failed used to leave the row on the upload it had just
    // aborted, and the next start resumed that dead upload.
    let up;
    try { up = await media.createMultipartUpload(key, { httpMetadata: { contentType: kind === "file" ? "application/octet-stream" : (declared || "application/octet-stream") } }); }
    catch { return { status: 503, error: STORE_MSG }; }
    // the room, or the message, may have been deleted while storage
    // answered: no session for either
    if (!live()) {
      try { await up.abort(); } catch { /* nothing to end */ }
      throw goneError();
    }
    if (this.upAuth(id, who, owner, kind).status !== 200) {
      try { await up.abort(); } catch { /* nothing to end */ }
      return { status: 404, error: "No message with that id" };
    }
    // The swap is one step, with no await in it: the receipts go with the
    // row they belong to. Cleared before the create, they let a part of
    // the old upload landing during it count in the new one, and finish
    // then failed every time on that part.
    const old = this.upSession(id, kind);
    const plan = useDirect ? uploadPlanDirect(size) : uploadPlan(size);
    const now = Date.now();
    const fname = name ? cleanFileName(stripControlChars(String(name)), "") : "";
    this.sql.exec("DELETE FROM upp WHERE msg = ? AND kind = ?", id, kind);
    this.sql.exec("INSERT OR REPLACE INTO md (msg, kind, type, r2key, size, upload_id, parts, fp, part_size, name, began, mode) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)",
      id, kind, declared || "application/octet-stream", key, size, up.uploadId, fp, plan.part_size, kind === "file" ? (fname || "file") : (fname || null), now, useDirect ? "direct" : null);
    if (old && old.upload_id) { try { await media.resumeMultipartUpload(old.r2key, old.upload_id).abort(); } catch { /* already completed, aborted or expired */ } }
    return { status: 200, part_size: plan.part_size, parts: plan.parts, resumed: false, received: [], expires_at: now + UP_SESSION_MS, direct: useDirect };
  },

  // Where part n goes through the Worker, once the checks pass: the
  // session is live, n is in its plan, and len is exactly that part's
  // length (R2 needs equal parts, and a part of the wrong length would
  // only fail at finish).
  /** @param len the part's length in bytes */
  uploadPartTarget(id: number, kind: string, who: string | null | undefined, owner: boolean, n: number, len: number) {
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
    if (want > UP_PART_MAX) return { status: 409, error: this.upDirectOff(owner) ? upDirectOffBig(kind) : "This upload's parts go straight to storage: POST its /sign for their addresses" };
    return { status: 200, key: row.r2key, upload_id: row.upload_id, sniff: n === 1 && kind !== "file" };
  },

  // The checks behind /sign, for a direct session: the caller, the
  // session and the part numbers. The Worker signs the addresses (it
  // holds the credential); nothing here sees them.
  /** @param nums the part numbers asked for */
  uploadSignTarget(id: number, kind: string, who: string | null | undefined, owner: boolean, nums: unknown) {
    const a = this.upAuth(id, who, owner, kind);
    if (a.status !== 200) return a;
    const row = this.upSession(id, kind);
    if (!row || !row.upload_id) return { status: 409, error: "No upload in progress for that message: POST its /" + kind + "/start first" };
    if (row.mode !== "direct") return { status: 409, error: "This upload's parts go through the site: PUT each one to its /part?n=N" };
    if (this.upExpired(row, a.msg)) return { status: 410, error: "This upload has expired: an upload must finish within 7 days of its start. Start it again." };
    const plan = this.upPlan(row);
    if (this.upDirectOff(owner)) return { status: 409, error: plan.part_size > UP_PART_MAX ? upDirectOffBig(kind) : "Direct uploads are turned off: send this upload's remaining parts through the site (PUT each one to its /part?n=N); the parts already in storage count" };
    const list = Array.from(new Set((Array.isArray(nums) ? nums : []).map((x) => Math.floor(Number(x)))));
    if (!list.length || list.length > UP_SIGN_MAX) return { status: 400, error: "Ask for 1 to " + UP_SIGN_MAX + " part numbers at a time, as {\"parts\": [1, 2, ...]}" };
    for (const n of list) if (!Number.isFinite(n) || n < 1 || n > plan.parts) return { status: 400, error: "Part numbers run from 1 to " + plan.parts + " for this upload" };
    return { status: 200, key: row.r2key, upload_id: row.upload_id, parts: list.map((n) => ({ n: n, bytes: partLength(row.size, plan.part_size, n) })) };
  },

  uploadPartDone(id: number, kind: string, uploadId: string, n: number, etag: string) {
    const row = this.sql.exec<Pick<MdRow, "upload_id">>("SELECT upload_id FROM md WHERE msg = ? AND kind = ?", id, kind).toArray()[0];
    // A part that lands after its session was replaced or cancelled
    // belongs to nothing: no receipt.
    if (!row || row.upload_id !== uploadId) return { status: 409, error: "This upload was replaced or cancelled while the part was in flight" };
    this.sql.exec("INSERT OR REPLACE INTO upp (msg, kind, n, etag) VALUES (?, ?, ?, ?)", id, kind, n, String(etag));
    return { status: 200 };
  },

  /** @param who given by the routes: only the sender (or the owner) sees
   *  progress; anyone else just sees no upload. */
  async uploadStatus(id: number, kind: string, who?: string | null, owner?: boolean) {
    let msg: { ts: number } | null | undefined = null;
    if (who !== undefined) {
      const a = this.upAuth(id, who, owner, kind);
      if (a.status !== 200) return { status: 200, uploading: false, received: [] };
      msg = a.msg;
    } else msg = this.sql.exec<Pick<MsgRow, "ts">>("SELECT ts FROM m WHERE id = ?", id).toArray()[0];
    const row = this.upSession(id, kind);
    if (!row) return { status: 200, uploading: false, received: [] };
    if (!row.upload_id) return { status: 200, uploading: false, complete: true, size: row.size, type: row.type, name: row.name || null, received: [] };
    const plan = this.upPlan(row);
    let received;
    try { received = Array.from((await this.upReceived(id, kind, row)).keys()).sort((x, y) => x - y); }
    catch (e) { return { status: 502, error: "Storage didn't list this upload's parts (" + String((e && (e as Error).message) || e) + "); ask again" }; }
    return { status: 200, uploading: true, direct: row.mode === "direct" && !this.upDirectOff(owner), size: row.size, type: row.type, name: row.name || null, part_size: plan.part_size, parts: plan.parts, received: received, expires_at: this.upBegan(row, msg) + UP_SESSION_MS };
  },

  /** @param room publishes a publish-on-complete draft when given */
  async uploadFinish(id: number, kind: string, who: string | null | undefined, owner: boolean, room: string | null | undefined, opts: UpFinishAsk | null | undefined): Promise<UpFinish> {
    const a = this.upAuth(id, who, owner, kind);
    if (a.status !== 200) return a;
    // A finish sent again while the first still runs (a client retrying
    // after a blip lost the first answer) gets that finish's answer. It
    // used to get 409 "already finishing", and an uploader reading that
    // as a failure gave up on an upload that succeeded.
    const k = id + ":" + kind;
    const running = this._finishing.get(k);
    if (running) return running;
    const p = this.withMediaLock(id, kind, (live) => this.upFinishNow(id, kind, who, owner, room, opts, live));
    this._finishing.set(k, p);
    try { return await p; } finally { if (this._finishing.get(k) === p) this._finishing.delete(k); }
  },

  // Whether this upload still owns its message's row: anything written
  // after a storage await checks it, since a delete of the message (which
  // takes no turn) can have taken the row meanwhile.
  upStill(id: number, kind: string, uploadId: string) {
    return this.sql.exec("SELECT 1 FROM md WHERE msg = ? AND kind = ? AND upload_id = ?", id, kind, uploadId).toArray().length > 0;
  },

  // The upload's rows go, if they are still its own.
  upDrop(id: number, kind: string, uploadId: string) {
    if (!this.upStill(id, kind, uploadId)) return;
    this.sql.exec("DELETE FROM upp WHERE msg = ? AND kind = ?", id, kind);
    this.sql.exec("DELETE FROM md WHERE msg = ? AND kind = ? AND upload_id = ?", id, kind, uploadId);
  },

  /** uploadFinish's work, in the message and kind's turn
   *  @param live false once the room is deleted (withMediaLock) */
  async upFinishNow(id: number, kind: string, who: string | null | undefined, owner: boolean, room: string | null | undefined, opts: UpFinishAsk | null | undefined, live: () => boolean): Promise<UpFinish> {
    const a = this.upAuth(id, who, owner, kind);
    if (a.status !== 200) return a;
    const row = this.upSession(id, kind);
    if (!row) return { status: 409, error: "No upload in progress for that message" };
    if (!row.upload_id) {
      // Finished already, and this is a retry whose first answer was lost
      // (the instance may even have restarted since): the stored file is
      // the answer, as it was the first time. Only a file an engine finish
      // made, though, which the row itself tells, so a restart changes
      // nothing: an engine session keeps its plan's part_size, always whole
      // MiB; an attach (putMedia) leaves it NULL and a video stream writes
      // STREAM_PART, which is not. Any file answered 200 before, so a finish
      // for an upload that an attach had replaced (and aborted) reported
      // the attach's file as its own.
      if (row.part_size == null || row.part_size === STREAM_PART) return { status: 409, error: "No upload in progress for that message" };
      // Another engine upload that replaced the caller's (its start
      // aborts the older one) and finished leaves a row just as
      // engine-made, and a finish from the replaced upload's client - a
      // second device, or its upload link, which names only the message
      // and kind - answered 200 with that other file as its own. A caller
      // that says which file it means (size, the fingerprint it gave at
      // start, or a link minted for another session) is told it is not
      // this one.
      if (opts && ((opts.size != null && opts.size !== row.size)
        || (opts.fp && row.fp && opts.fp.slice(0, 200) !== row.fp)
        || (opts.expires != null && this.upBegan(row, a.msg) + UP_SESSION_MS !== opts.expires))) return { status: 409, error: "No upload in progress for that message" };
      const m = this.sql.exec<Pick<MsgRow, "draft" | "pubauto">>("SELECT draft, pubauto FROM m WHERE id = ?", id).toArray()[0];
      return { status: 200, type: row.type, bytes: row.size, name: kind === "file" ? (row.name || "file") : (row.name || null), published: !!(m && m.pubauto && !m.draft) };
    }
    if (!this.env || !this.env.MEDIA) return { status: 501, error: "The R2 binding (MEDIA) is not configured" };
    const media = this.env.MEDIA;
    const uploadId = row.upload_id;
    const plan = this.upPlan(row);
    // Storage saying it has no such upload can mean that an earlier finish
    // completed it and never recorded so (the instance restarted between
    // the two): an object of the declared size at the key is that upload,
    // checked and indexed like any other. Otherwise it is gone.
    const landed = async () => {
      try { const hd = await media.head(row.r2key); return !!hd && hd.size === row.size; } catch (e) { warn("upload.head", e, { room, id, kind }); return false; }
    };
    const gone = { status: 410, error: "Storage no longer has this upload (it expired or was cancelled); start it again" };
    // The room was deleted during a storage call: its delete has run, so
    // an object this finish completed is nobody's (the key is never used
    // again), and no row is written.
    const roomGone = async () => {
      try { await media.delete(row.r2key); } catch (e) { warn("media.delete", e, { room: this.roomName }); }
      throw goneError();
    };
    let got: Map<number, string> | null = null;
    try { got = await this.upReceived(id, kind, row); }
    catch (e) {
      const em = String((e && (e as Error).message) || e);
      if (!/NoSuchUpload/i.test(em)) return { status: 502, error: "Storage didn't list this upload's parts (" + em + "); finish again" };
      if (!(await landed())) { if (!live()) return roomGone(); this.upDrop(id, kind, uploadId); return gone; }
    }
    if (!live()) return roomGone();
    if (got) {
      const missing = [];
      for (let n = 1; n <= plan.parts; n++) if (!got.has(n)) missing.push(n);
      if (missing.length) return { status: 409, error: missing.length + " of " + plan.parts + " parts have not arrived (first missing: " + missing.slice(0, 10).join(", ") + "). Send them, then finish again.", missing: missing.slice(0, 1000) };
      if (!this.upStill(id, kind, uploadId)) return { status: 409, error: "This upload was cancelled while it finished" };
      const parts = [];
      for (let n = 1; n <= plan.parts; n++) parts.push({ partNumber: n, etag: got.get(n) as string }); // every part is in (checked above)
      try { await media.resumeMultipartUpload(row.r2key, uploadId).complete(parts); }
      catch (e) {
        const em = String((e && (e as Error).message) || e);
        if (!/NoSuchUpload|upload does not exist|10024/i.test(em)) { if (!live()) return roomGone(); return { status: 502, error: "Could not complete the upload (" + em + "). The parts are kept: finish again, or re-send parts and then finish." }; }
        if (!(await landed())) { if (!live()) return roomGone(); this.upDrop(id, kind, uploadId); return gone; }
      }
    }
    /** the R2 object's head */
    let head: { size: number } | null = null;
    try { head = await media.head(row.r2key); } catch (e) { warn("upload.head", e, { room, id, kind }); }
    const sized = !!head && head.size === row.size;
    let type = kind === "file" ? (row.type || "application/octet-stream") : null;
    if (sized && kind !== "file") {
      try {
        const obj = await media.get(row.r2key, { range: { offset: 0, length: 16 } });
        // an upload session exists only for UP_KINDS, and kind is not file here
        if (obj) type = (upSniff(kind) as NonNullable<ReturnType<typeof upSniff>>)(await obj.arrayBuffer());
      } catch (e) {
        warn("upload.sniff", e, { room, id, kind });
      }
    }
    if (!live()) return roomGone();
    if (!this.upStill(id, kind, uploadId)) {
      // The message was deleted while storage answered. Its delete has
      // already run, so the object this upload just made is nobody's:
      // left there, nothing would ever remove it.
      if (!this.upSession(id, kind)) { try { await media.delete(row.r2key); } catch (e) { warn("media.delete", e, { room: this.roomName }); } }
      return { status: 409, error: "This upload was cancelled while it finished" };
    }
    if (!sized || !type) {
      try { await media.delete(row.r2key); } catch (e) { warn("media.delete", e, { room: this.roomName }); }
      if (!live()) throw goneError();
      this.upDrop(id, kind, uploadId);
      return sized ? { status: 415, error: upTypeError(kind) + "; upload discarded" } : { status: 400, error: "The stored file is not the size the upload declared; upload discarded" };
    }
    this.sql.exec("DELETE FROM upp WHERE msg = ? AND kind = ?", id, kind);
    this.sql.exec("UPDATE md SET type = ?, upload_id = NULL, at = ? WHERE msg = ? AND kind = ? AND upload_id = ?", type, Date.now(), id, kind, uploadId);
    const transcript = opts && opts.transcript !== undefined && opts.transcript !== null ? String(opts.transcript).slice(0, MAX_TEXT) : undefined;
    if (kind === "image") this.sql.exec("UPDATE m SET image_type = ?, image_size = ? WHERE id = ?", type, row.size, id);
    if (kind === "audio") {
      if (transcript !== undefined) this.sql.exec("UPDATE m SET audio_type = ?, audio_size = ?, audio_transcript = ? WHERE id = ?", type, row.size, transcript || null, id);
      else this.sql.exec("UPDATE m SET audio_type = ?, audio_size = ? WHERE id = ?", type, row.size, id);
    }
    if (kind === "video") this.sql.exec("UPDATE m SET video_type = ?, video_size = ? WHERE id = ?", type, row.size, id);
    if (kind === "file") this.sql.exec("UPDATE m SET file_type = ?, file_size = ?, file_name = ? WHERE id = ?", type, row.size, row.name || "file", id);
    // a live message is sent again with its file; a draft waits for its publish
    this.mediaLanded(id, room);
    const published = room ? !!(await this.maybeAutoPublish(id, room)) : false;
    return { status: 200, type: type, bytes: row.size, name: kind === "file" ? (row.name || "file") : (row.name || null), published: published };
  },

  async uploadAbort(id: number, kind: string, who: string | null | undefined, owner: boolean) {
    const a = this.upAuth(id, who, owner, kind);
    if (a.status !== 200) return a;
    // In the message and kind's turn: an abort sent while a finish runs
    // waits for it (and then finds nothing to cancel), instead of deleting
    // the row the finish was completing.
    return this.withMediaLock(id, kind, async (live) => {
      const row = this.upSession(id, kind);
      if (!row || !row.upload_id) return { status: 200, aborted: false };
      const uploadId = row.upload_id;
      if (this.env && this.env.MEDIA) { try { await this.env.MEDIA.resumeMultipartUpload(row.r2key, uploadId).abort(); } catch { /* already completed, aborted or expired */ } }
      if (!live()) throw goneError();
      this.upDrop(id, kind, uploadId);
      return { status: 200, aborted: true };
    });
  },

  // One of your drafts with an upload in flight for the same file (size
  // and fingerprint), of any kind unless kind narrows it: how a client
  // that lost its place - a reload, another device - picks it back up.
  // Only a draft that holds nothing but that file: one from a send of a
  // photo and this file, the photo done and the file not, was handed back
  // to a resend of the file alone, and its publish posted the photo the
  // author had removed meanwhile.
  async findResumableUpload(who: string | null | undefined, size: unknown, fp: unknown, owner: boolean, kind: string | null | undefined) {
    if (!fp || !size) return { status: 200, found: false };
    const rows = this.sql.exec<{ msg: number, kind: string, sender: string }>("SELECT md.msg AS msg, md.kind AS kind, m.sender AS sender FROM md JOIN m ON m.id = md.msg WHERE md.upload_id IS NOT NULL AND md.size = ? AND md.fp = ? AND m.draft IS NOT NULL AND m.draft != 0 ORDER BY md.msg DESC", size, String(fp)).toArray();
    for (const r of rows) {
      if (kind && r.kind !== kind) continue;
      if (!owner && String(r.sender).toLowerCase() !== String(who || "").toLowerCase()) continue;
      if (this.sql.exec("SELECT 1 FROM md WHERE msg = ? AND kind != ? LIMIT 1", r.msg, r.kind).toArray().length) continue;
      const st = await this.uploadStatus(r.msg, r.kind);
      if (st.status !== 200 || !st.uploading) continue;
      return { status: 200, found: true, id: r.msg, kind: r.kind, received: st.received, part_size: st.part_size, parts: st.parts, direct: !!st.direct };
    }
    return { status: 200, found: false };
  },

  // Streaming ingest: the Worker receives one whole-file PUT (for clients that
  // can send a file in one request) and uploads R2 multipart parts as bytes
  // arrive. streamBegin reserves the upload, streamFinish completes, checks
  // and indexes it, streamAbort discards it, each in the message's video
  // turn (withMediaLock).
  async streamBegin(id: number, who: string | null | undefined, type: string, size: number, owner: boolean, room: string) {
    const r = this.sql.exec<Pick<MsgRow, "sender" | "draft">>("SELECT sender, draft FROM m WHERE id = ?", id).toArray()[0];
    if (!r || hiddenDraft(r, who, owner)) return { status: 404, error: "No message with that id" };
    if (!owner && String(r.sender).toLowerCase() !== String(who || "").toLowerCase()) return { status: 403, error: "You can only attach a video to your own messages" };
    if (!this.env || !this.env.MEDIA) return { status: 501, error: "The R2 binding (MEDIA) is not configured" };
    if (VIDEO_TYPES.indexOf(type) < 0) return { status: 415, error: "Video must be MP4, WebM or MOV" };
    if (!size || size > VIDEO_MAX_HARD) return { status: 413, error: VIDEO_STREAM_TOO_BIG };
    const media = this.env.MEDIA;
    const key = this.mediaKey(room, id, "video");
    return this.withMediaLock(id, "video", async (live) => {
      const prev = this.sql.exec<Pick<MdRow, "r2key" | "upload_id">>("SELECT r2key, upload_id FROM md WHERE msg = ? AND kind = 'video'", id).toArray()[0];
      if (prev && prev.r2key && !prev.upload_id) return { status: 409, error: "That message already has a video" };
      // created first, swapped in one step after, as in upStartNow
      let up;
      try { up = await media.createMultipartUpload(key, { httpMetadata: { contentType: type } }); }
      catch { return { status: 503, error: STORE_MSG }; }
      // as in uploadStart: the room or the message may be gone by now
      if (!live()) {
        try { await up.abort(); } catch { /* nothing to end */ }
        throw goneError();
      }
      if (!this.sql.exec("SELECT id FROM m WHERE id = ?", id).toArray().length) {
        try { await up.abort(); } catch { /* nothing to end */ }
        return { status: 404, error: "No message with that id" };
      }
      // A newer stream replaces one still in flight (a client retrying a
      // stalled PUT), and the older upload ends here: two left live on the
      // one key let the stream that had lost the row complete over the
      // published video later.
      const old = this.sql.exec<Pick<MdRow, "r2key" | "upload_id">>("SELECT r2key, upload_id FROM md WHERE msg = ? AND kind = 'video'", id).toArray()[0];
      this.sql.exec("DELETE FROM upp WHERE msg = ? AND kind = 'video'", id);
      this.sql.exec("INSERT OR REPLACE INTO md (msg, kind, type, r2key, size, upload_id, fp, part_size, began) VALUES (?, 'video', ?, ?, ?, ?, NULL, ?, ?)", id, type, key, size, up.uploadId, STREAM_PART, Date.now());
      if (old && old.upload_id) { try { await media.resumeMultipartUpload(old.r2key, old.upload_id).abort(); } catch { /* already completed, aborted or expired */ } }
      return { status: 200, key: key, uploadId: up.uploadId };
    });
  },

  // Completes the upload streamBegin answered, once every part is in:
  // here, and only while that upload still owns the message's row. The
  // Worker used to complete it itself, before asking, so a stream that had
  // been replaced wrote its bytes over the key the newer one had published.
  // The object must then be exactly size bytes (what the Worker counted)
  // and start like a video; otherwise it is discarded with its row.
  /** @param parts the parts the Worker uploaded, as R2's complete() takes them
   *  @param sender the streaming member's invite and name, asked again in the
   *  turn (inviteStill, room/members.ts); null for the owner key */
  async streamFinish(id: number, uploadId: string, parts: R2UploadedPart[], size: number, room: string | null | undefined, sender?: { token: string | null, member: string } | null) {
    if (!this.env || !this.env.MEDIA) return { status: 501, error: "The R2 binding (MEDIA) is not configured" };
    const media = this.env.MEDIA;
    return this.withMediaLock(id, "video", async (live) => {
      const replaced = { status: 409, error: "This upload was replaced by a newer one for the same message" };
      const row = this.sql.exec<Pick<MdRow, "r2key" | "upload_id">>("SELECT r2key, upload_id FROM md WHERE msg = ? AND kind = 'video'", id).toArray()[0];
      if (!row || row.upload_id !== uploadId) return replaced;
      // The sender must still be in the room as the video is attached, and
      // that is asked here, in the turn, with no await before complete():
      // the route asked before waiting for the turn, which can be long
      // (another finish or attach of this message's video), so a revoke
      // in that wait still attached the video.
      const gone = sender ? this.inviteStill(sender.token, sender.member) : null;
      if (gone) {
        try { await media.resumeMultipartUpload(row.r2key, uploadId).abort(); } catch { /* already completed, aborted or expired */ }
        if (!live()) throw goneError();
        this.upDrop(id, "video", uploadId);
        return { status: gone.status, error: gone.error };
      }
      // the room was deleted during a storage call (see upFinishNow)
      const roomGone = async () => {
        try { await media.delete(row.r2key); } catch (e) { warn("media.delete", e, { room: this.roomName }); }
        throw goneError();
      };
      const discard = async (status: number, error: string) => {
        if (this.upStill(id, "video", uploadId) || !this.upSession(id, "video")) { try { await media.delete(row.r2key); } catch (e) { warn("media.delete", e, { room: this.roomName }); } }
        if (!live()) throw goneError();
        this.upDrop(id, "video", uploadId);
        return { status: status, error: error };
      };
      try { await media.resumeMultipartUpload(row.r2key, uploadId).complete(parts); }
      catch (e) {
        try { await media.resumeMultipartUpload(row.r2key, uploadId).abort(); } catch { /* already completed, aborted or expired */ }
        if (!live()) throw goneError();
        this.upDrop(id, "video", uploadId);
        return { status: 502, error: "Upload stream failed: " + String((e && (e as Error).message) || e) };
      }
      let head: { size: number } | null = null, sniffed: string | null = null;
      try { head = await media.head(row.r2key); } catch (e) { warn("upload.head", e, { room, id }); }
      if (head && head.size === size) {
        try { const obj = await media.get(row.r2key, { range: { offset: 0, length: 16 } }); if (obj) sniffed = sniffVideo(await obj.arrayBuffer()); } catch (e) { warn("upload.sniff", e, { room, id }); }
      }
      if (!live()) return roomGone();
      if (!head || head.size !== size || !sniffed) return discard(400, "The uploaded bytes do not check out as that video; upload discarded");
      // the message was deleted while storage answered (see upFinishNow)
      if (!this.upStill(id, "video", uploadId)) return discard(409, "This upload was cancelled while it finished");
      // And the sender asked again, with no await before the write: the
      // check above complete() leaves complete, head and the ranged get
      // to wait on, and a revoke landing there still attached the video.
      const left = sender ? this.inviteStill(sender.token, sender.member) : null;
      if (left) return discard(left.status, left.error);
      this.sql.exec("DELETE FROM upp WHERE msg = ? AND kind = 'video'", id);
      this.sql.exec("UPDATE md SET type = ?, size = ?, upload_id = NULL, at = ? WHERE msg = ? AND kind = 'video' AND upload_id = ?", sniffed, size, Date.now(), id, uploadId);
      this.sql.exec("UPDATE m SET video_type = ?, video_size = ? WHERE id = ?", sniffed, size, id);
      this.mediaLanded(id, room);
      const published = room ? await this.maybeAutoPublish(id, room) : null;
      return { status: 200, type: sniffed, bytes: size, published: !!published };
    });
  },

  // Takes the multipart upload id streamBegin answered: a newer upload for
  // the same message replaces the row, and a late abort of the old one must
  // not delete the new one.
  async streamAbort(id: number, uploadId: string | null | undefined) {
    // Discard means the R2 multipart dies too, as in uploadAbort: the
    // one current caller aborts it first, but the upload id is deleted here,
    // so a caller that trusted this method alone would orphan the session.
    return this.withMediaLock(id, "video", async (live) => {
      const row = this.sql.exec<Pick<MdRow, "r2key" | "upload_id">>("SELECT r2key, upload_id FROM md WHERE msg = ? AND kind = 'video'", id).toArray()[0];
      if (!row || !row.upload_id || (uploadId && row.upload_id !== uploadId)) return { status: 200 };
      const own = row.upload_id;
      if (this.env && this.env.MEDIA) { try { await this.env.MEDIA.resumeMultipartUpload(row.r2key, own).abort(); } catch { /* already completed, aborted or expired */ } }
      if (!live()) throw goneError();
      this.upDrop(id, "video", own);
      return { status: 200 };
    });
  },
} satisfies ThisType<Room>;
