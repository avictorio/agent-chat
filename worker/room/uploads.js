// Room methods: the resumable upload engine (sessions, parts, direct-to-R2 signing, finish/abort), upload tickets, draft sweeping.

import {
  AUDIO_MAX,
  IMAGE_MAX,
  MAX_TEXT,
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
  VIDEO_TYPES,
} from "../limits.js";
import { b64urlEncode, sha256hex } from "../lib/crypto.js";
import { cleanFileName, sniffAudio, sniffImage, sniffVideo } from "../lib/sniff.js";
import { isStoreError } from "../lib/errors.js";
import {
  cleanMediaType,
  partLength,
  upNoun,
  upSniff,
  upTypeError,
  uploadPlan,
  uploadPlanDirect,
} from "../uploads/plan.js";
import { r2DirectConfigured, r2ListParts } from "../platform/r2-s3.js";

export const UploadMethods = {
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
  },

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
  },

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
  },

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
  },

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
  },

  upSession(id, kind) {
    return this.sql.exec("SELECT type, r2key, size, upload_id, fp, part_size, name, began, mode FROM md WHERE msg = ? AND kind = ?", id, kind).toArray()[0] || null;
  },

  // The plan a session runs on, pinned at its start (streamed ones
  // STREAM_PART).
  upPlan(row) {
    const ps = row.part_size;
    return { part_size: ps, parts: Math.max(1, Math.ceil(row.size / ps)) };
  },

  upBegan(row, msg) { return row.began || (msg && msg.ts) || 0; },

  // An hour short of R2's 7 days, so no part goes to an upload R2 has
  // already thrown away.
  upExpired(row, msg) { return Date.now() - this.upBegan(row, msg) > UP_SESSION_MS - 3600000; },

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
  },

  // Whether a session may send its parts straight to R2: the client asked
  // (direct), the credential is configured, and the switch is on - or the
  // owner asked with "force", to try it live before the switch flips.
  upDirectAllowed(direct, owner) {
    if (!direct || !r2DirectConfigured(this.env)) return false;
    return this.env.R2_DIRECT === "1" || (direct === "force" && !!owner);
  },

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
  },

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
  },

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
  },

  uploadPartDone(id, kind, uploadId, n, etag) {
    const row = this.sql.exec("SELECT upload_id FROM md WHERE msg = ? AND kind = ?", id, kind).toArray()[0];
    // A part that lands after its session was replaced or cancelled
    // belongs to nothing: no receipt.
    if (!row || row.upload_id !== uploadId) return { status: 409, error: "This upload was replaced or cancelled while the part was in flight" };
    this.sql.exec("INSERT OR REPLACE INTO upp (msg, kind, n, etag) VALUES (?, ?, ?, ?)", id, kind, n, String(etag));
    return { status: 200 };
  },

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
  },

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
  },

  async uploadAbort(id, kind, who, owner) {
    const a = this.upAuth(id, who, owner, kind);
    if (a.status !== 200) return a;
    const row = this.upSession(id, kind);
    if (!row || !row.upload_id) return { status: 200, aborted: false };
    if (this.env && this.env.MEDIA) { try { await this.env.MEDIA.resumeMultipartUpload(row.r2key, row.upload_id).abort(); } catch (e) {} }
    this.sql.exec("DELETE FROM upp WHERE msg = ? AND kind = ?", id, kind);
    this.sql.exec("DELETE FROM md WHERE msg = ? AND kind = ? AND upload_id IS NOT NULL", id, kind);
    return { status: 200, aborted: true };
  },

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
  },

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
  },

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
  },

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
  },
};
