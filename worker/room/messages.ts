// Room methods: messages - posting, reading and listing, reactions, drafts and publishing, deletion, the attachments shelf.

import { streamWants } from "./state.js";
import { isStoreError, storeError } from "../lib/errors.js";
import { KEEP, MAX_TEXT } from "../limits.js";
import { sseFrame } from "../lib/http.js";
import { mentionsName } from "../lib/text.js";
import { gameEngine } from "../games/engine.js";
import type { AttachmentKind, AttachmentsResponse, Message, MessagesResponse } from "@chat/contract";
import type { CfgRow, InvRow, MdRow, MsgRow, Refusal, Room, RxRow, StreamClient } from "./Room.js";
import { warn } from "../lib/log.js";

/** A message as the API serves it (withKinds): the contract's Message,
 *  plus the members its text @-mentions. */
export type ApiMessage = Message & { targets: string[] };
/** A message as a listing reads it (its sender as from), before withKinds
 *  turns its media columns into media references. */
export type MsgListRow = { id: number, ts: number, from: string, text: string }
  & Partial<Omit<MsgRow, "id" | "ts" | "sender" | "text" | "draft" | "pubauto" | "pub_ts" | "owntrust">>;
/** A listing row while withKinds rewrites it in place into an ApiMessage:
 *  its columns as read (typed), plus the fields it gains on the way. */
export type MsgBag = MsgListRow & Record<string, unknown>;
/** Inline media for post(): the bytes and their sniffed type, plus the
 *  audio transcript or the page / document name those kinds carry. */
export type InlineMedia = { data: ArrayBuffer, type: string, transcript?: string | null, name?: string };

export const MessageMethods = {
  // Reactions: one per person per message. Streams get an "event: reaction"; long-polls waiting on the room wake up.
  reactionsFor(id: number) {
    /** who, by emoji */
    const out: Record<string, string[]> = {};
    for (const r of this.sql.exec<Pick<RxRow, "emoji" | "who">>("SELECT emoji, who FROM rx WHERE msg = ? ORDER BY ts", id).toArray()) (out[r.emoji] = out[r.emoji] || []).push(r.who);
    return out;
  },

  reactionsOf(id: number, who: string | null | undefined, owner: boolean) {
    const r = this.sql.exec<Pick<MsgRow, "sender" | "draft">>("SELECT sender, draft FROM m WHERE id = ?", id).toArray()[0];
    if (!r) return null;
    // Drafts are invisible to everyone but their sender and the owner, here
    // as everywhere else: a draft answers exactly like a missing message.
    if (r.draft && !owner && String(r.sender).toLowerCase() !== String(who || "").toLowerCase()) return null;
    return this.reactionsFor(id);
  },

  /** @param emoji null takes the reaction back */
  react(id: number, who: string, emoji: string | null, room: string, owner: boolean) {
    const msg = this.sql.exec<Pick<MsgRow, "sender" | "draft">>("SELECT sender, draft FROM m WHERE id = ?", id).toArray()[0];
    if (!msg) return null;
    if (msg.draft && !owner && String(msg.sender).toLowerCase() !== String(who || "").toLowerCase()) return null;
    const ts = Date.now();
    this.sql.exec("DELETE FROM rx WHERE msg = ? AND lower(who) = lower(?)", id, who);
    if (emoji) this.sql.exec("INSERT INTO rx (msg, emoji, who, ts) VALUES (?, ?, ?, ?)", id, emoji, who, ts);
    const reactions = this.reactionsFor(id);
    const frame = "event: reaction\ndata: " + JSON.stringify({ type: "reaction", room: room, id: id, message_from: msg.sender, from: who, kind: this.memberKind(who), targets: [msg.sender], reaction: emoji, reactions: reactions, ts: ts }) + "\n\n";
    // A draft is private to its sender (and the owner): its reactions are
    // not announced to the rest of the room.
    const sees = (c: StreamClient) => !msg.draft || c.owner || String(c.name || "").toLowerCase() === String(msg.sender).toLowerCase();
    for (const c of this.clients) { if (streamWants(c, "reaction") && sees(c)) c.send(frame); }
    if (msg.draft) return { reactions: reactions, message_from: msg.sender };
    this.emitState(room);
    const ws = this.waiters;
    this.waiters = new Set();
    for (const w of ws) w();
    return { reactions: reactions, message_from: msg.sender };
  },

  /**
   * @param trusted the post carried the owner key (kept as provenance)
   * @param pubauto publish the draft once its upload verifies
   */
  async post(sender: string, text: string, room: string, trusted: boolean, audio: InlineMedia | null = null, image: InlineMedia | null = null, video: InlineMedia | null = null, draft = false, pubauto = false, html: InlineMedia | null = null, doc: InlineMedia | null = null) {
    await this.sweepDrafts();
    this.roomName = room;
    const ts = Date.now();
    const id = this.sql.exec<Pick<MsgRow, "id">>("INSERT INTO m (id, ts, sender, text, draft, pubauto, pub_ts, owntrust) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id", this.nextMsgId(), ts, sender, text, draft ? 1 : null, draft && pubauto ? 1 : null, ts, trusted ? 1 : null).one().id;
    // Inline media is all or nothing: every put lands in R2 before the
    // message is announced at the end of this method, so on a storage
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
        const keys = this.sql.exec<Pick<MdRow, "r2key">>("SELECT r2key FROM md WHERE msg = ?", id).toArray().map((r) => r.r2key).filter(Boolean);
        this.sql.exec("DELETE FROM md WHERE msg = ?", id);
        this.sql.exec("DELETE FROM m WHERE id = ?", id);
        if (keys.length && this.env && this.env.MEDIA) { try { await this.env.MEDIA.delete(keys); } catch (de) { warn("media.delete", de, { room: this.roomName }); } }
        throw storeError();
      }
      throw e;
    }
    if (id > KEEP) {
      // Drafts are exempt from the trim: a long upload can sit on an old id
      // in a busy room, and trimming it would kill the upload mid-flight.
      const staleKeys = this.sql.exec<Pick<MdRow, "r2key">>("SELECT r2key FROM md WHERE msg <= ? AND r2key IS NOT NULL AND msg NOT IN (SELECT id FROM m WHERE draft IS NOT NULL AND draft != 0)", id - KEEP).toArray().map((r) => r.r2key);
      this.sql.exec("DELETE FROM m WHERE id <= ? AND (draft IS NULL OR draft = 0)", id - KEEP); this.sql.exec("DELETE FROM rx WHERE msg <= ? AND msg NOT IN (SELECT id FROM m WHERE draft IS NOT NULL AND draft != 0)", id - KEEP); this.sql.exec("DELETE FROM md WHERE msg <= ? AND msg NOT IN (SELECT id FROM m WHERE draft IS NOT NULL AND draft != 0)", id - KEEP); this.sql.exec("DELETE FROM upp WHERE msg <= ? AND msg NOT IN (SELECT id FROM m WHERE draft IS NOT NULL AND draft != 0)", id - KEEP);
      if (staleKeys.length && this.env && this.env.MEDIA) this.ctx.waitUntil(this.env.MEDIA.delete(staleKeys).catch((e) => warn("media.delete", e, { room: this.roomName })));
    }
    this.sql.exec("UPDATE inv SET posted = ? WHERE lower(name) = lower(?) AND posted IS NULL", ts, sender);
    const row: MsgListRow = { id, ts, from: sender, text };
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
  },

  announce(msg: ApiMessage, room: string | null) {
    const ws = this.waiters;
    this.waiters = new Set();
    for (const w of ws) w();
    if (this.clients.size) {
      // Message frames are lean and identical for every client; the
      // current room state travels as its own event (see emitState).
      const frame = sseFrame(room, msg);
      for (const c of this.clients) {
        if (!streamWants(c, "message")) continue;
        c.send(frame);
      }
      this.emitState(room);
    }
    this.ctx.waitUntil(this.notifyPush(msg, room).catch((e) => this.activityLog(room, "push error: " + String((e && e.message) || e))));
  },

  // Message ids never come back. SQLite hands out max(id)+1, so deleting
  // the newest message would free its id for the next post: cursor
  // readers past it would miss the repost, and a signed media URL for the
  // deleted message would serve the new one's media. A high-water mark in
  // cfg keeps every id fresh.
  nextMsgId() {
    const max = this.sql.exec<{ id: number | null }>("SELECT MAX(id) AS id FROM m").one().id || 0;
    const r = this.sql.exec<Pick<CfgRow, "v">>("SELECT v FROM cfg WHERE k = 'msg_hwm'").toArray()[0];
    const id = Math.max(max, r ? parseInt(r.v, 10) || 0 : 0) + 1;
    this.sql.exec("INSERT OR REPLACE INTO cfg (k, v) VALUES ('msg_hwm', ?)", String(id));
    return id;
  },

  // A room message from the referee itself (match results). Not a member: it
  // never claims a member's name, and members cannot post as it.
  postSystem(text: string, room: string) {
    const ts = Date.now();
    const id = this.sql.exec<Pick<MsgRow, "id">>("INSERT INTO m (id, ts, sender, text, pub_ts) VALUES (?, ?, ?, ?, ?) RETURNING id", this.nextMsgId(), ts, "Referee", text, ts).one().id;
    const msg = this.withKinds([{ id: id, ts: ts, from: "Referee", text: text }])[0];
    this.announce(msg, room);
    return msg;
  },

  /** @param text a caption to publish with (undefined or null keeps the draft's) */
  async publishMessage(id: number, who: string | null | undefined, owner: boolean, room: string, text: unknown) {
    const r = this.sql.exec<MsgRow>("SELECT * FROM m WHERE id = ?", id).toArray()[0];
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
    const f = this.sql.exec<MsgRow>("SELECT * FROM m WHERE id = ?", id).toArray()[0];
    const row = { id: f.id, ts: f.ts, from: f.sender, text: f.text, audio_type: f.audio_type, audio_size: f.audio_size, audio_transcript: f.audio_transcript, image_type: f.image_type, image_size: f.image_size, video_type: f.video_type, video_size: f.video_size, html_type: f.html_type, html_size: f.html_size, html_name: f.html_name, doc_type: f.doc_type, doc_size: f.doc_size, doc_name: f.doc_name, file_type: f.file_type, file_size: f.file_size, file_name: f.file_name };
    const msg = this.withKinds([row])[0];
    this.roomName = room;
    this.announce(msg, room);
    return { status: 200, msg: msg };
  },

  // Publish-on-completion: a draft created with publish_on_complete is
  // the sender's standing instruction to post the moment its media upload
  // verifies - for an uploader that may finish with no client left to
  // call /publish. Runs through publishMessage so the announce path (stream,
  // push) is identical to a manual publish. The owner flag stays false:
  // this server-side path acts with the member's own standing, never the
  // owner's.
  async maybeAutoPublish(id: number, room: string) {
    const r = this.sql.exec<Pick<MsgRow, "sender" | "draft" | "pubauto">>("SELECT sender, draft, pubauto FROM m WHERE id = ?", id).toArray()[0];
    if (!r || !r.draft || !r.pubauto) return null;
    const res = await this.publishMessage(id, r.sender, false, room, undefined);
    return res && res.status === 200 ? res.msg : null;
  },

  // Delete one of your own messages (the owner can delete any). Removes the
  // row, its reactions, and any media: in-flight multipart uploads are
  // aborted and R2 objects deleted.
  async deleteMessage(id: number, who: string | null | undefined, owner: boolean) {
    const r = this.sql.exec<Pick<MsgRow, "sender">>("SELECT sender FROM m WHERE id = ?", id).toArray()[0];
    if (!r) return { status: 404, error: "No message with that id" };
    if (!owner && String(r.sender).toLowerCase() !== String(who || "").toLowerCase()) return { status: 403, error: "You can only delete your own messages" };
    if (this.env && this.env.MEDIA) {
      for (const md of this.sql.exec<Pick<MdRow, "r2key" | "upload_id">>("SELECT r2key, upload_id FROM md WHERE msg = ?", id).toArray()) {
        if (md.upload_id) { try { await this.env.MEDIA.resumeMultipartUpload(md.r2key, md.upload_id).abort(); } catch { /* already completed, aborted or expired */ } }
        if (md.r2key) { try { await this.env.MEDIA.delete(md.r2key); } catch (e) { warn("media.delete", e, { room: this.roomName }); } }
      }
    }
    this.sql.exec("DELETE FROM upp WHERE msg = ?", id);
    this.sql.exec("DELETE FROM md WHERE msg = ?", id);
    this.sql.exec("DELETE FROM rx WHERE msg = ?", id);
    this.sql.exec("DELETE FROM m WHERE id = ?", id);
    return { status: 200, deleted: id };
  },

  // The members @-mentioned in a text: canonical names, in the order they
  // are first mentioned, the sender excluded. The same word-boundary rule
  // as push targeting (mentionsName).
  /** @param names the members (read here when not given) */
  mentionTargets(text: string | null | undefined, selfName: string | null | undefined, names?: string[]): string[] {
    const t = String(text || "");
    if (!t || t.indexOf("@") < 0) return [];
    const self = String(selfName || "").toLowerCase();
    const list = names || this.sql.exec<Pick<InvRow, "name">>("SELECT name FROM inv WHERE used IS NOT NULL AND revoked IS NULL").toArray().map((r) => r.name);
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
  },

  // Adds kind ("human" | "agent") to each message from the sender's invite.
  // A sender with no invite is a system actor - the Referee, above all -
  // and reads "non_interactive": not a member anyone can address. Targets
  // (the members @-mentioned in the text) ride along on every message.
  /**
   * @param rows rewritten in place
   * @returns the same rows
   */
  withKinds(rows: MsgListRow[]): ApiMessage[] {
    if (!rows.length) return rows as ApiMessage[];
    /** kind by lowercased name */
    const map: Map<string, string> = new Map(this.sql.exec<{ n: string, kind: string | null }>("SELECT lower(name) AS n, kind FROM inv").toArray().map((r) => [r.n, r.kind === "human" ? "human" : "agent"]));
    const names = this.sql.exec<Pick<InvRow, "name">>("SELECT name FROM inv WHERE used IS NOT NULL AND revoked IS NULL").toArray().map((r) => r.name);
    for (const r of rows as MsgBag[]) {
      const n = String(r.from || "").toLowerCase();
      r.kind = !r.from ? null : (map.get(n) || "non_interactive");
      r.targets = this.mentionTargets(r.text, r.from, names);
    }
    // Reactions: { "👍": ["Henry", ...], ... } in the order they were first used.
    const ids = rows.map((r) => r.id).filter((x) => typeof x === "number");
    if (ids.length) {
      /** who reacted, by emoji, by message */
      const by: Map<number, Record<string, string[]>> = new Map();
      for (const x of this.sql.exec<Pick<RxRow, "msg" | "emoji" | "who">>("SELECT msg, emoji, who FROM rx WHERE msg BETWEEN ? AND ? ORDER BY ts", Math.min(...ids), Math.max(...ids)).toArray()) {
        if (!by.has(x.msg)) by.set(x.msg, {});
        const o = by.get(x.msg) as Record<string, string[]>; // set just above
        (o[x.emoji] = o[x.emoji] || []).push(x.who);
      }
      for (const r of rows as MsgBag[]) r.reactions = by.get(r.id) || {};
    }
    // Audio and images: listings carry type, size and URL; the bytes live behind the URL.
    for (const r of rows as MsgBag[]) {
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
    return rows as ApiMessage[];
  },

  /** @param after the cursor, or null for the latest */
  read(after: number | null, limit: number) {
    if (after === null) {
      return this.withKinds(this.sql.exec<MsgListRow>('SELECT id, ts, sender AS "from", text, audio_type, audio_size, audio_transcript, image_type, image_size, video_type, video_size, html_type, html_size, html_name, doc_type, doc_size, doc_name, file_type, file_size, file_name, game_id FROM (SELECT * FROM m WHERE (draft IS NULL OR draft = 0) ORDER BY id DESC LIMIT ?) ORDER BY id', limit).toArray());
    }
    // Forward reads are id-ordered, plus one exception: a draft that published
    // after the cursor was taken keeps its original (lower) id, so id alone
    // would skip it forever. pub_ts is the publish time; anything published
    // after the cursor message was is owed to the reader too.
    return this.withKinds(this.sql.exec<MsgListRow>('SELECT id, ts, sender AS "from", text, audio_type, audio_size, audio_transcript, image_type, image_size, video_type, video_size, html_type, html_size, html_name, doc_type, doc_size, doc_name, file_type, file_size, file_name, game_id FROM m WHERE (draft IS NULL OR draft = 0) AND (id > ? OR (pub_ts IS NOT NULL AND pub_ts > (SELECT pub_ts FROM m WHERE id = ?))) ORDER BY id LIMIT ?', after, after, limit).toArray());
  },

  lastId(): number {
    // The highest id a reader can actually see: drafts do not count. A cursor
    // taken from last_id must never skip a message that publishes later.
    return this.sql.exec<{ id: number | null }>("SELECT MAX(id) AS id FROM m WHERE draft IS NULL OR draft = 0").one().id || 0;
  },

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
  /** @param opts the query: kind, from, before, limit */
  attachments(opts: { kind: string, from: string, before: string, limit: string }, room: string): Omit<AttachmentsResponse, "room" | "you"> | { error: string, status: number } {
    this.roomName = room;
    const KINDS = ["image", "video", "audio", "speak", "html", "doc", "file"];
    let kinds = KINDS;
    if (opts.kind) {
      kinds = String(opts.kind).split(",").map((k) => k.trim().toLowerCase()).filter((k) => KINDS.indexOf(k) >= 0);
      if (!kinds.length) return { error: "kind must name one or more of: " + KINDS.join(", "), status: 400 };
    }
    const limit = Math.max(1, Math.min(200, parseInt(opts.limit, 10) || 60));
    const from = String(opts.from || "").trim();
    let curMsg = null as number | null, curKind = null as string | null;
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
    for (const r of this.sql.exec<{ kind: string, n: number }>("SELECT md.kind AS kind, COUNT(*) AS n " + base + fromSql + " GROUP BY md.kind", ...cArgs).toArray()) {
      if (r.kind in counts) { (counts as Record<string, number>)[r.kind] = r.n; counts.all += r.n; }
    }
    let sql = "SELECT md.msg AS id, m.ts AS ts, m.sender AS \"from\", m.text AS text, m.audio_transcript AS transcript, m.html_name AS html_name, m.doc_name AS doc_name, m.file_name AS file_name, md.kind AS kind, md.type AS type, md.size AS bytes " + base + fromSql + " AND md.kind IN (" + inList + ")";
    const args: Array<string | number> = from ? [from, ...kinds] : [...kinds];
    // curKind is set together with curMsg
    if (curMsg !== null) { sql += " AND (md.msg < ? OR (md.msg = ? AND md.kind > ?))"; args.push(curMsg, curMsg, curKind as string); }
    sql += " ORDER BY md.msg DESC, md.kind ASC LIMIT ?";
    args.push(limit + 1);
    const rows = this.sql.exec<{ id: number, ts: number, from: string, text: string, transcript: string | null, html_name: string | null, doc_name: string | null, file_name: string | null, kind: AttachmentKind, type: string, bytes: number }>(sql, ...args).toArray();
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
  },

  /**
   * @param after the cursor, or null for the latest
   * @param wait seconds to hold an empty forward read open
   * @param token the caller's invite, when that is how they came in: looked at again after a wait
   */
  async list(after: number | null, limit: number, wait: number, who: string | null | undefined, room: string, token?: string | null): Promise<Pick<MessagesResponse, "messages" | "last_id" | "room_state"> | Refusal> {
    this.roomName = room;
    let rows = this.read(after, limit);
    if (rows.length || !wait || after === null) return { messages: rows, last_id: this.lastId(), room_state: this.roomState(who, room) };
    await (new Promise((resolve) => {
      let t: number | undefined;
      const done = () => { clearTimeout(t); this.waiters.delete(done); resolve(); };
      t = setTimeout(done, wait * 1000);
      this.waiters.add(done);
    }) as Promise<void>);
    if (!this.ready) return { messages: [], last_id: 0, room_state: { v: 1 } };
    // the wait can outlast the invite: someone removed meanwhile does not get what was posted since
    if (token) { const l = this.lookupInvite(token); if (!l.ok) return l; }
    rows = this.read(after, limit);
    return { messages: rows, last_id: this.lastId(), room_state: this.roomState(who, room) };
  },
} satisfies ThisType<Room>;
