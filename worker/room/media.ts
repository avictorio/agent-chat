// Room methods: message media in R2 - keys, signed URLs, the md index rows, attaching media to messages.

import { b64urlDecode, b64urlEncode } from "../lib/crypto.js";
import { mediaSig } from "../lib/media.js";
import { goneError, isStoreError, storeError } from "../lib/errors.js";
import { parseRange } from "../lib/http.js";
import { STORE_MSG } from "../limits.js";
import { sameName } from "../lib/text.js";
import type { CfgRow, MdRow, MsgRow, Room } from "./Room.js";
import type { MediaBytes } from "../lib/media.js";
import { warn } from "../lib/log.js";

export type DraftCols = Pick<MsgRow, "sender" | "draft">;
/** Who is asking for a message's media: drafts are their sender's (and
 *  the owner's) alone. */
export type MediaViewer = { name?: string | null, owner?: boolean };

/** Someone else's draft, asked about without the owner key. Every path
 *  answers such a row exactly like a missing id (404 "No message with that
 *  id"): a 403 there told any member that a draft sat under an id the
 *  listings skip, and when it appeared, published or went. A live message
 *  is everyone's to see, so it keeps its honest 403. */
export function hiddenDraft(r: DraftCols, who: string | null | undefined, owner: boolean | undefined) {
  return !!r.draft && !owner && !sameName(r.sender, who);
}

// One stored file's row for serving it. A page's name is on its message
// (html_name), not on the md row: it names the download a page becomes
// when opened outside a frame (mediaHeaders).
const MEDIA_ROW_SQL = "SELECT md.type AS type, md.r2key AS r2key, md.size AS size, COALESCE(md.name, CASE WHEN md.kind = 'html' THEN m.html_name END) AS name FROM md LEFT JOIN m ON m.id = md.msg WHERE md.msg = ? AND md.kind = ? AND md.upload_id IS NULL";

export const MediaMethods = {
  // ---- Message media (images, audio, video): bytes live in R2, the index lives here ----
  // md maps (msg, kind) to an R2 key. An R2 failure fails the request:
  // there is no other store to fall back to (see STORE_MSG).
  mediaKey(room: string | null | undefined, id: number, kind: string) { return (room || this.roomName || "room") + "/" + id + "/" + kind; },

  // The room's media signing key: 32 random bytes in cfg, created on first
  // use. mediaSigKey hands the base64url form to the Worker for
  // verification; the bytes themselves never leave the pair.
  mediaSigKeyBytes() {
    if (this._sigBytes) return this._sigBytes;
    const row = this.sql.exec<Pick<CfgRow, "v">>("SELECT v FROM cfg WHERE k = 'media_sig_key'").toArray()[0];
    if (row && row.v) {
      try {
        const b = b64urlDecode(row.v);
        if (b.length === 32) { this._sigBytes = b; return b; }
      } catch {
        // not base64url: replaced below, like a key of the wrong length
      }
      // a new key stops every media link signed with the old one
      warn("media.sigkey", "the stored signing key is unreadable; replacing it", { room: this.roomName });
    }
    const b = crypto.getRandomValues(new Uint8Array(32));
    this.sql.exec("INSERT OR REPLACE INTO cfg (k, v) VALUES ('media_sig_key', ?)", b64urlEncode(b));
    this._sigBytes = b;
    return b;
  },

  mediaSigKey() {
    if (!this.ready) return null;
    return b64urlEncode(this.mediaSigKeyBytes());
  },

  /**
   * @param id a message id, or "match.n" for a Sketch & Guess drawing
   * @param ver the stored file's version (md.at), when there is one
   */
  mediaQuery(id: number | string, kind: string, ver?: number | null) {
    // The expiry sits on an hour grid, one to two hours out, so every
    // mint inside the same hour produces the identical URL. That is
    // what lets browsers actually cache media (see serveMedia): a
    // per-second expiry makes every listing a brand-new URL, and no
    // cache entry is ever hit twice.
    // v= is the file's version, unsigned (the read checks only exp and
    // sig). Without it a file replaced in the same hour kept a
    // byte-identical URL, and browsers showed their cached copy of the
    // old one for up to an hour, reloads included. A row from before
    // md.at existed has no version; any new file stamps one.
    const exp = (Math.floor(Date.now() / 3600000) + 2) * 3600;
    return "?exp=" + exp + "&sig=" + mediaSig(this.mediaSigKeyBytes(), this.roomName, id, kind, exp) + (ver ? "&v=" + ver : "");
  },

  /** md.at of one stored file: the v= of its url (null for a row from
   *  before md.at, or none). The attach answers read it right after their
   *  write, with no await between, so it is the version a listing gives. */
  mediaVer(id: number, kind: string): number | null {
    const r = this.sql.exec<Pick<MdRow, "at">>("SELECT at FROM md WHERE msg = ? AND kind = ? AND upload_id IS NULL", id, kind).toArray()[0];
    return (r && r.at) || null;
  },

  /** md.at of these messages' stored files, by "msg:kind": one query for a whole page */
  mediaVersions(ids: number[]): Map<string, number> {
    const out: Map<string, number> = new Map();
    if (!ids.length) return out;
    for (const r of this.sql.exec<Pick<MdRow, "msg" | "kind" | "at">>("SELECT msg, kind, at FROM md WHERE msg BETWEEN ? AND ? AND at IS NOT NULL AND upload_id IS NULL", Math.min(...ids), Math.max(...ids)).toArray()) {
      if (r.at) out.set(r.msg + ":" + r.kind, r.at);
    }
    return out;
  },

  // Every writer of one message's media kind - an attach, an upload's
  // start, finish and abort, a stream's begin, finish and abort - shares
  // its R2 key and its md row, and each awaits storage between reading the
  // row and writing it, when other requests run. Unlocked they overwrote
  // each other: a start replaced a file attached meanwhile with an upload
  // in flight (listed, answering 404), an abort deleted the row a finish
  // was completing, a stream that had lost the row completed over the
  // published video. So they take turns, one at a time per message and
  // kind, in the order they came. The turns live in memory, which is
  // enough: the requests they order die with the instance too.
  // The turn is also where a room deleted meanwhile is noticed (Room.fence):
  // before fn starts and after it ends, and fn asks live() after each of
  // its own storage awaits, before it writes a row, so a writer left over
  // from a deleted room never writes into it or into one created since.
  async withMediaLock<T>(id: number, kind: string, fn: (live: () => boolean) => Promise<T>): Promise<T> {
    const gen = this.gen;
    const live = () => this.alive(gen);
    const k = id + ":" + kind;
    const before = this.mediaLocks.get(k) || Promise.resolve();
    let done = () => {};
    const mine = new Promise<void>((res) => { done = res; });
    const tail = before.then(() => mine);
    this.mediaLocks.set(k, tail);
    try {
      await before;
      this.fence(gen);
      const out = await fn(live);
      this.fence(gen);
      return out;
    } finally {
      done();
      if (this.mediaLocks.get(k) === tail) this.mediaLocks.delete(k);
    }
  },

  async putMedia(id: number, kind: string, data: ArrayBuffer, type: string, room: string | null | undefined) {
    const key = this.mediaKey(room, id, kind);
    if (!this.env || !this.env.MEDIA || this.r2TestFail()) throw storeError();
    const media = this.env.MEDIA;
    return this.withMediaLock(id, kind, async (live) => {
      try { await media.put(key, data, { httpMetadata: { contentType: type } }); } catch { throw storeError(); }
      // the room was deleted while the bytes were stored: its sweep has
      // run, so this object would be nobody's (ids, and so keys, never
      // come back: nothing else is stored under it)
      if (!live()) { try { await media.delete(key); } catch (e) { warn("media.delete", e, { room: this.roomName }); } throw goneError(); }
      // A single-shot attach replaces any upload in flight for the same
      // kind: the row first, then the upload ends.
      const prev = this.sql.exec<Pick<MdRow, "r2key" | "upload_id">>("SELECT r2key, upload_id FROM md WHERE msg = ? AND kind = ?", id, kind).toArray()[0];
      this.sql.exec("DELETE FROM upp WHERE msg = ? AND kind = ?", id, kind);
      this.sql.exec("INSERT OR REPLACE INTO md (msg, kind, type, r2key, size, at) VALUES (?, ?, ?, ?, ?, ?)", id, kind, type, key, data.byteLength, Date.now());
      if (prev && prev.upload_id) { try { await media.resumeMultipartUpload(prev.r2key, prev.upload_id).abort(); } catch { /* already completed, aborted or expired */ } }
      return key;
    });
  },

  // Media exists only with its message: a deleted message has none, even
  // if a row or an object outlived it. (A write that was already under
  // way when the message was deleted - a stream, an upload start, a post
  // still storing its picture - used to finish afterwards, and the file
  // was then served for a message nobody could see or delete. The draft
  // sweep collects such leftovers.) A draft's media is its sender's alone.
  mediaShown(id: number, viewer?: MediaViewer) {
    const m = this.sql.exec<DraftCols>("SELECT sender, draft FROM m WHERE id = ?", id).toArray()[0];
    if (!m) return false;
    return !(viewer && !viewer.owner && m.draft && !sameName(m.sender, viewer.name));
  },

  mediaMeta(id: number, kind: string, viewer?: MediaViewer) {
    if (!this.mediaShown(id, viewer)) return null;
    // An upload still in flight has no object yet.
    const row = this.sql.exec<Pick<MdRow, "type" | "r2key" | "size" | "name">>(MEDIA_ROW_SQL, id, kind).toArray()[0];
    return row ? { type: row.type, r2key: row.r2key, size: row.size, name: row.name || null } : null;
  },

  /** @param range the request's Range header */
  async getMedia(id: number, kind: string, range: string | null | undefined, viewer?: MediaViewer): Promise<MediaBytes | null> {
    if (!this.mediaShown(id, viewer)) return null;
    const row = this.sql.exec<Pick<MdRow, "type" | "r2key" | "size" | "name">>(MEDIA_ROW_SQL, id, kind).toArray()[0];
    if (row && row.r2key && this.env && this.env.MEDIA) {
      try {
        const rr = parseRange(range, row.size);
        const obj = await this.env.MEDIA.get(row.r2key, rr ? { range: rr.r2 } : {});
        if (obj) {
          const buf = await obj.arrayBuffer();
          return { data: buf, type: row.type, size: row.size, name: row.name || null, partial: !!rr, start: rr ? rr.start : 0, end: rr ? rr.start + buf.byteLength - 1 : row.size - 1 };
        }
      } catch (e) {
        warn("media.read", e, { room: this.roomName, id, kind });
      }
    }
    // Media lives in R2 or nowhere.
    return null;
  },

  /** @param transcript undefined keeps the current one */
  async attachAudio(id: number, who: string | null | undefined, data: ArrayBuffer, type: string, owner: boolean, transcript: string | null | undefined, room: string) {
    const r = this.sql.exec<DraftCols>("SELECT sender, draft FROM m WHERE id = ?", id).toArray()[0];
    if (!r || hiddenDraft(r, who, owner)) return { status: 404, error: "No message with that id" };
    if (!owner && !sameName(r.sender, who)) return { status: 403, error: "You can only attach audio to your own messages" };
    try { await this.putMedia(id, "audio", data, type, room); } catch (e) { if (isStoreError(e)) return { status: 503, error: STORE_MSG }; throw e; }
    if (transcript !== undefined) this.sql.exec("UPDATE m SET audio_type = ?, audio_size = ?, audio_transcript = ? WHERE id = ?", type, data.byteLength, transcript, id);
    else this.sql.exec("UPDATE m SET audio_type = ?, audio_size = ? WHERE id = ?", type, data.byteLength, id);
    this.mediaLanded(id, room);
    return { status: 200, type: type, bytes: data.byteLength, ver: this.mediaVer(id, "audio") };
  },

  async attachImage(id: number, who: string | null | undefined, data: ArrayBuffer, type: string, owner: boolean, room: string) {
    const r = this.sql.exec<DraftCols>("SELECT sender, draft FROM m WHERE id = ?", id).toArray()[0];
    if (!r || hiddenDraft(r, who, owner)) return { status: 404, error: "No message with that id" };
    if (!owner && !sameName(r.sender, who)) return { status: 403, error: "You can only attach an image to your own messages" };
    try { await this.putMedia(id, "image", data, type, room); } catch (e) { if (isStoreError(e)) return { status: 503, error: STORE_MSG }; throw e; }
    this.sql.exec("UPDATE m SET image_type = ?, image_size = ? WHERE id = ?", type, data.byteLength, id);
    this.mediaLanded(id, room);
    return { status: 200, type: type, bytes: data.byteLength, ver: this.mediaVer(id, "image") };
  },

  async attachVideo(id: number, who: string | null | undefined, data: ArrayBuffer, type: string, owner: boolean, room: string) {
    const r = this.sql.exec<DraftCols>("SELECT sender, draft FROM m WHERE id = ?", id).toArray()[0];
    if (!r || hiddenDraft(r, who, owner)) return { status: 404, error: "No message with that id" };
    if (!owner && !sameName(r.sender, who)) return { status: 403, error: "You can only attach a video to your own messages" };
    try { await this.putMedia(id, "video", data, type, room); } catch (e) { if (isStoreError(e)) return { status: 503, error: STORE_MSG }; throw e; }
    this.sql.exec("UPDATE m SET video_type = ?, video_size = ? WHERE id = ?", type, data.byteLength, id);
    this.mediaLanded(id, room);
    return { status: 200, type: type, bytes: data.byteLength, ver: this.mediaVer(id, "video") };
  },
} satisfies ThisType<Room>;
