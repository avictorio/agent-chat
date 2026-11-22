// Messages: posting and reading, drafts and publishing, deletion, reactions, the attachments shelf.

import {
  AUDIO_MAX,
  DOC_MAX,
  HTML_MAX,
  IMAGE_MAX,
  KEEP,
  MAX_TEXT,
  ROOM_RE,
  STORE_MSG,
  VIDEO_MAX,
} from "../limits.js";
import { deny, json, readBody, type Body, bodyText, refused } from "../lib/http.js";
import { MAX_NAME, clamp } from "../lib/text.js";
import { normReaction } from "../lib/reactions.js";
import { agentOnboarding, forAgents } from "../agents/onboarding.js";
import {
  cleanFileName,
  decodeTextPayload,
  sniffAudio,
  sniffImage,
  sniffVideo,
} from "../lib/sniff.js";
import { isStoreError } from "../lib/errors.js";
import type { InlineMedia } from "../room/messages.js";
import type { RouteContext } from "../index.js";

// Publish a draft message (created with {"draft": true}, e.g. while its video
// uploaded): only now does it stream and push.
/** @param m the path's match */
export async function publishRoute(rc: RouteContext, m: RegExpMatchArray) {
  const { request, env, owner, invite } = rc;
  const room = decodeURIComponent(m[1]).toLowerCase();
  if (!ROOM_RE.test(room)) return json({ error: "Room names are 1-64 lowercase letters, digits, - or _" }, 400);
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const id = parseInt(m[2], 10);
  const stub = env.ROOM.get(env.ROOM.idFromName(room));
  const acc = await stub.access(invite, owner);
  if (!acc.ok) return deny(acc);
  const body = await readBody(request);
  const r = await stub.publishMessage(id, acc.name || "", owner, room, body && body.text !== undefined ? bodyText(body.text, "text") : undefined);
  if (refused(r)) return json({ error: r.error }, r.status);
  return json(Object.assign({ room: room }, r.msg, { room_state: await stub.roomState(acc.name || r.msg.from, room) }));
}

// Delete one of your own messages (the owner can delete any). Its media
// (R2 objects, upload parts) and reactions go with it.
/** @param m the path's match */
export async function messageRoute(rc: RouteContext, m: RegExpMatchArray) {
  const { request, env, owner, invite } = rc;
  const room = decodeURIComponent(m[1]).toLowerCase();
  if (!ROOM_RE.test(room)) return json({ error: "Room names are 1-64 lowercase letters, digits, - or _" }, 400);
  if (request.method !== "DELETE") return json({ error: "Method not allowed" }, 405);
  const id = parseInt(m[2], 10);
  const stub = env.ROOM.get(env.ROOM.idFromName(room));
  const acc = await stub.access(invite, owner);
  if (!acc.ok) return deny(acc);
  const r = await stub.deleteMessage(id, acc.name || "", owner);
  if (refused(r)) return json({ error: r.error }, r.status);
  return json({ room: room, deleted: r.deleted });
}

/** @param m the path's match */
export async function reactionsRoute(rc: RouteContext, m: RegExpMatchArray) {
  const { request, env, url, owner, invite } = rc;
  const room = decodeURIComponent(m[1]).toLowerCase();
  if (!ROOM_RE.test(room)) return json({ error: "Room names are 1-64 lowercase letters, digits, - or _" }, 400);
  const stub = env.ROOM.get(env.ROOM.idFromName(room));
  const acc = await stub.access(invite, owner);
  if (!acc.ok) return deny(acc);
  const id = parseInt(m[2], 10);
  if (request.method === "GET") {
    const r = await stub.reactionsOf(id, acc.name, owner);
    if (!r) return json({ error: "No message with that id" }, 404);
    return json({ room, id, reactions: r });
  }
  if (request.method !== "POST" && request.method !== "PUT" && request.method !== "DELETE") return json({ error: "Method not allowed" }, 405);
  /** the request's JSON body */
  let body: Body = {};
  if (request.method !== "DELETE") {
    try { body = (await readBody(request)) || {}; } catch { return json({ error: "Send JSON like {\"from\": \"agent-a\", \"reaction\": \"👍\"}" }, 400); }
  }
  // An invite fixes the name, as with messages.
  const from = acc.name || (bodyText(body.from, "from") || url.searchParams.get("from") || "").trim().slice(0, MAX_NAME);
  if (!from) return json({ error: "\"from\" is required" }, 400);
  const reaction = request.method === "DELETE" ? null : normReaction(body.reaction);
  if (reaction === undefined) return json({ error: "\"reaction\" must be one emoji (or like, love, haha, wow, sad, angry), or null to remove yours" }, 400);
  const r = await stub.react(id, from, reaction, room, owner);
  if (!r) return json({ error: "No message with that id (rooms keep their most recent " + KEEP + " messages)" }, 404);
  return json({ room, id, from, reaction, message_from: r.message_from, reactions: r.reactions });
}

/** @param m the path's match */
export async function attachmentsRoute(rc: RouteContext, m: RegExpMatchArray) {
  const { request, env, url, owner, invite } = rc;
  const room = decodeURIComponent(m[1]).toLowerCase();
  if (!ROOM_RE.test(room)) return json({ error: "Room names are 1-64 lowercase letters, digits, - or _" }, 400);
  if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);
  const stub = env.ROOM.get(env.ROOM.idFromName(room));
  const acc = await stub.access(invite, owner);
  if (!acc.ok) return deny(acc);
  const r = await stub.attachments({
    kind: url.searchParams.get("kind") || "",
    from: url.searchParams.get("from") || "",
    before: url.searchParams.get("before") || "",
    limit: url.searchParams.get("limit") || "",
  }, room);
  if ("error" in r) return json({ error: r.error }, r.status || 400);
  const extra: { you?: string } = {};
  if (acc.name) extra.you = acc.name;
  return json(Object.assign({ room }, extra, r));
}

/** @param m the path's match */
export async function messagesRoute(rc: RouteContext, m: RegExpMatchArray) {
  const { request, env, url, owner, invite } = rc;
  const room = decodeURIComponent(m[1]).toLowerCase();
  if (!ROOM_RE.test(room)) return json({ error: "Room names are 1-64 lowercase letters, digits, - or _" }, 400);
  const stub = env.ROOM.get(env.ROOM.idFromName(room));
  const acc = await stub.access(invite, owner);
  if (!acc.ok) return deny(acc);

  if (request.method === "GET") {
    const a = url.searchParams.get("after");
    const after = a === null || a === "" ? null : Math.max(0, parseInt(a, 10) || 0);
    // a missing limit or wait parses as NaN, so the default applies
    const limit = clamp(parseInt(url.searchParams.get("limit") as string, 10) || 100, 1, 500);
    const wait = clamp(parseInt(url.searchParams.get("wait") as string, 10) || 0, 0, 25);
    const r = await stub.list(after, limit, wait, acc.name || "", room);
    const extra: { invite_only: boolean, welcome?: string, you?: string, you_kind?: string, agent_onboarding?: string } = { invite_only: true };
    if (after === null) extra.welcome = url.origin + "/api/rooms/" + encodeURIComponent(room) + "/welcome";
    if (acc.name) { extra.you = acc.name; if (acc.kind) extra.you_kind = acc.kind; }
    if (after === null && acc.name && extra.you_kind === "agent") extra.agent_onboarding = agentOnboarding(url.origin, room, acc.name, invite, { invitedBy: "invited_by" in acc ? acc.invited_by : null });
    return json(Object.assign({ room }, extra, r, { for_agents: forAgents(url.origin, room) }));
  }

  if (request.method === "POST") {
    let body: Body | null;
    const ct = request.headers.get("content-type") || "";
    try {
      if (ct.includes("application/json")) body = await readBody(request);
      else if (ct.includes("form")) {
        const f = await request.formData();
        body = { from: f.get("from"), text: f.get("text") };
      } else body = { from: url.searchParams.get("from"), text: await request.text() };
    } catch {
      return json({ error: "Couldn't read the body. Send JSON like {\"from\":\"agent-a\",\"text\":\"hi\"}" }, 400);
    }
    // An invite fixes the sender's name to the one it was made for.
    const from = acc.name || bodyText(body?.from, "from").trim().slice(0, MAX_NAME);
    const text = bodyText(body?.text, "text");
    if (!from) return json({ error: "\"from\" is required" }, 400);
    if (!text.trim() && !(body && (body.audio || body.image || body.video || body.html || body.doc))) return json({ error: "\"text\" is required" }, 400);
    if (text.length > MAX_TEXT) return json({ error: "\"text\" is limited to " + MAX_TEXT + " characters" }, 413);
    const draftWanted = !!(body && body.draft);
  const pubautoWanted = draftWanted && !!(body && body.publish_on_complete);
  if (draftWanted && body && (body.audio || body.image || body.video || body.html || body.doc)) return json({ error: "\"draft\" cannot be combined with inline media; upload in chunks, then publish" }, 400);
  let audio: InlineMedia | null = null;
    if (body && body.audio) {
      const s = bodyText(body.audio, "audio").replace(/^data:[^,]*,/, "").replace(/\s+/g, "");
      let buf;
      try { buf = Uint8Array.from(atob(s), (c) => c.charCodeAt(0)).buffer; } catch { return json({ error: "\"audio\" must be base64 or a data: URL" }, 400); }
      if (!buf.byteLength) return json({ error: "\"audio\" is empty" }, 400);
      if (buf.byteLength > AUDIO_MAX) return json({ error: "Audio clips can be up to 5 MB" }, 413);
      const atype = sniffAudio(buf);
      if (!atype) return json({ error: "Audio must be MP3, WAV, OGG, WebM or M4A" }, 415);
      const tr = body && body.transcript ? bodyText(body.transcript, "transcript").slice(0, MAX_TEXT) : null;
      audio = { data: buf, type: atype, transcript: tr };
    }
    let image: InlineMedia | null = null;
    if (body && body.image) {
      const s = bodyText(body.image, "image").replace(/^data:[^,]*,/, "").replace(/\s+/g, "");
      let buf;
      try { buf = Uint8Array.from(atob(s), (c) => c.charCodeAt(0)).buffer; } catch { return json({ error: "\"image\" must be base64 or a data: URL" }, 400); }
      if (!buf.byteLength) return json({ error: "\"image\" is empty" }, 400);
      if (buf.byteLength > IMAGE_MAX) return json({ error: "Images can be up to 5 MB" }, 413);
      const itype = sniffImage(buf);
      if (!itype) return json({ error: "Image must be JPEG, PNG, GIF, WebP or AVIF" }, 415);
      image = { data: buf, type: itype };
    }
    let video: InlineMedia | null = null;
    if (body && body.video) {
      const s = bodyText(body.video, "video").replace(/^data:[^,]*,/, "").replace(/\s+/g, "");
      let buf;
      try { buf = Uint8Array.from(atob(s), (c) => c.charCodeAt(0)).buffer; } catch { return json({ error: "\"video\" must be base64 or a data: URL" }, 400); }
      if (!buf.byteLength) return json({ error: "\"video\" is empty" }, 400);
      if (buf.byteLength > VIDEO_MAX) return json({ error: "Videos can be up to 25 MB" }, 413);
      const vtype = sniffVideo(buf);
      if (!vtype) return json({ error: "Video must be MP4, WebM or MOV" }, 415);
      video = { data: buf, type: vtype };
    }
    let htmlArt: InlineMedia | null = null;
    if (body && body.html) {
      const s = decodeTextPayload(body.html);
      if (s === null) return json({ error: "\"html\" must be raw HTML text or a base64 data: URL" }, 400);
      if (!s.trim()) return json({ error: "\"html\" is empty" }, 400);
      const buf = new TextEncoder().encode(s);
      if (buf.byteLength > HTML_MAX) return json({ error: "HTML pages can be up to 2 MB" }, 413);
      if (!/^\s*</.test(s)) return json({ error: "HTML must be a markup document (starting with a tag or doctype)" }, 415);
      htmlArt = { data: buf.buffer, type: "text/html; charset=utf-8", name: cleanFileName(body.html_name, "Page") };
    }
    let doc: InlineMedia | null = null;
    if (body && body.doc) {
      const s = decodeTextPayload(body.doc);
      if (s === null) return json({ error: "\"doc\" must be raw Markdown text or a base64 data: URL" }, 400);
      if (!s.trim()) return json({ error: "\"doc\" is empty" }, 400);
      if (s.indexOf("\u0000") >= 0) return json({ error: "\"doc\" must be text (Markdown)" }, 415);
      const buf = new TextEncoder().encode(s);
      if (buf.byteLength > DOC_MAX) return json({ error: "Documents can be up to 1 MB" }, 413);
      doc = { data: buf.buffer, type: "text/markdown; charset=utf-8", name: cleanFileName(body.doc_name, "Document.md") };
    }
    const trusted = owner;
    let msg;
    try { msg = await stub.post(from, text, room, trusted, audio, image, video, draftWanted, pubautoWanted, htmlArt, doc); }
    catch (e) { if (isStoreError(e)) return json({ error: STORE_MSG }, 503); throw e; }
    return json(Object.assign({ room }, msg, draftWanted ? { draft: true } : {}, pubautoWanted ? { publish_on_complete: true } : {}, { room_state: await stub.roomState(from, room), for_agents: forAgents(url.origin, room) }), 201);
  }

  return json({ error: "Method not allowed" }, 405);
}
