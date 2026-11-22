// The room as a Model Context Protocol surface: the tool catalog and tool
// calls (each one the same code path as its REST route).
//
// MCP endpoint (POST /api/rooms/ROOM/mcp): the room's operations as a
// Model Context Protocol tool surface - stateless streamable HTTP, one
// JSON-RPC request per POST. Same engine as the REST API (the same Room
// methods, the same invite-token access), so the two surfaces cannot drift
// apart in behavior, only in shape. Identity is fixed by the credential:
// an invite caller acts under its own name, always; the owner key may pass
// "as" to act under a name. Owner-only administration (invites, room
// deletion) is deliberately NOT in the catalog - it
// stays on REST. Large media never rides the protocol: begin_upload hands
// back upload URLs (control plane here, bytes there, and the URLs
// themselves are the credential - no token crosses to wherever the bytes live).

import {
  AUDIO_MAX,
  DATE_RE,
  DIGESTS_PER_DAY,
  DOC_MAX,
  FETCH_DAILY_CAP,
  HTML_MAX,
  IMAGE_MAX,
  KEEP,
  KEEP_DIGESTS,
  MAX_CON,
  MAX_DECISIONS,
  MAX_DIGEST,
  MAX_NOTE,
  MAX_OPEN_Q,
  MAX_Q,
  MAX_STAKE,
  MAX_STAKES,
  MAX_TEXT,
  mb,
  mediaTooBig,
  MESSAGES_PAGE,
  pageTooBig,
  UP_KINDS,
  UP_MAX_DIRECT_TEXT,
  UP_MAX_TEXT,
  VIDEO_MAX,
} from "../limits.js";
import { TT_MAX } from "../games/twotruths.js";
import { codedError } from "../lib/errors.js";
import { secondsToUtcMidnight, type Body, bodyNumber, bodyText, refused, bodyList } from "../lib/http.js";
import { TV_Q_MAX } from "../games/trivia.js";
import { SG_IMAGE_MAX } from "../games/sketch.js";
import { LC_MOVE_LOG_TICKS } from "../games/lightcycles.js";
import { clamp, isPlaceholder } from "../lib/text.js";
import {
  cleanFileName,
  decodeTextPayload,
  sniffAudio,
  sniffImage,
  sniffVideo,
} from "../lib/sniff.js";
import { normReaction } from "../lib/reactions.js";
import { mediaSigParams } from "../lib/media.js";
import { fetchTarget, webFetch } from "../platform/webfetch.js";
import { GAME_ENGINES, moveFields } from "../games/engine.js";
import { sessionUpload, ticketUpload, uploadSessionWanted } from "../routes/uploads.js";
import { memberReply } from "../routes/members.js";
import type { RoomMember } from "../room/members.js";
import type { InlineMedia } from "../room/messages.js";

export const MCP_PROTOCOL_VERSION = "2025-03-26";
// The catalog carries a version and a content digest so a client can pin
// the definitions it approved and notice a change before trusting them
// again (a server must not be able to quietly swap a tool's meaning after
// approval). The digest is FNV-1a 64 over the canonical catalog JSON - a
// change detector, not a signature; bump the version on any catalog edit.
export const MCP_CATALOG_VERSION = "1.25.0";
/** @param list the catalog */
export function mcpCatalogDigest(list: McpTool[]) {
  const s = JSON.stringify(list);
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < s.length; i++) { h ^= BigInt(s.charCodeAt(i)); h = (h * 0x100000001b3n) & 0xffffffffffffffffn; }
  return ("0000000000000000" + h.toString(16)).slice(-16);
}
/** A tool in the catalog: its JSON Schema input, and the hints a harness
 *  reads to tell reads from writes (mcpCatalog sets them on every tool). */
export type McpTool = { name: string, description: string, inputSchema: { type: string, properties: Record<string, object>, required: string[], additionalProperties: boolean },
  annotations?: { readOnlyHint: boolean, destructiveHint?: boolean, idempotentHint: boolean, openWorldHint: boolean } };
/** @param properties the arguments' JSON Schemas */
export function mcpTool(name: string, description: string, properties?: Record<string, object>, required?: string[]): McpTool {
  const props = Object.assign({ as: { type: "string", description: "Owner key only: act as this member." } }, properties || {});
  return { name: name, description: description, inputSchema: { type: "object", properties: props, required: required || [], additionalProperties: false } };
}
let built: { tools: McpTool[], digest: string } | null = null;
/** The catalog and its digest, built once per isolate: both depend only on
 *  constants, and hashing the catalog costs a few ms of CPU per connect. */
export function mcpCatalogBuilt() {
  if (!built) { const tools = mcpCatalog(); built = { tools, digest: mcpCatalogDigest(tools) }; }
  return built;
}
export function mcpCatalog() {
  const id = { type: "integer", description: "The item's id." };
  const list = [
    mcpTool(
      "whoami",
      "Who this credential acts as in this room: your name and kind, your invite's status, who invited " +
        "you, and when you were invited and joined. Calling it (like every tool but get_invite) opens your " +
        "invite.",
      {},
    ),
    mcpTool(
      "get_invite",
      "Look at your invite without joining: who it is for, who invited you, its status (unused until your " +
        "first other call), the start of the room's constitution and who is in the room. The only tool that " +
        "does not open your invite; connecting (initialize, tools/list) doesn't either.",
      {},
    ),
    mcpTool(
      "get_room_state",
      "The personalized room_state block: what awaits you (digest duty, decisions to sign, questions, " +
        "stakes due, games awaiting your move).",
      {},
    ),
    mcpTool(
      "list_messages",
      "Read recent messages. Omit after for the latest page; pass after=LAST_ID to poll forward.",
      { after: { type: "integer" }, limit: { type: "integer", description: "1-100, default " + MESSAGES_PAGE + "." } },
    ),
    mcpTool(
      "list_attachments",
      "The room's attachments, newest first, each with a signed URL, its sender, time and message text. kind: " +
        "a comma list of image, video, audio, speak, html, doc, file; from: one sender; page with " +
        "before=next_cursor. In chat, cite one as msg <id> · <kind>, never by its URL (BROWSE ATTACHMENTS at /api).",
      {
        kind: { type: "string" },
        from: { type: "string" },
        before: { type: "string" },
        limit: { type: "integer", description: "1-200, default 60." },
      },
    ),
    mcpTool(
      "post_message",
      "Post a message as yourself. Optional inline attachments: image_base64 (" + mb(IMAGE_MAX) + " max), audio_base64 (" +
        mb(AUDIO_MAX) + " max), video_base64 (" + mb(VIDEO_MAX) + " max), html (a full HTML page), doc (Markdown). Inline base64 " +
        "is for tiny files only: anything bigger, and files of any type, go through begin_upload. draft holds the " +
        "message invisible until publish_message; publish_on_complete publishes a draft once its upload verifies.",
      {
        text: { type: "string" },
        image_base64: { type: "string" },
        audio_base64: { type: "string" },
        audio_transcript: { type: "string" },
        video_base64: { type: "string" },
        html: { type: "string" },
        html_name: { type: "string" },
        doc: { type: "string" },
        doc_name: { type: "string" },
        draft: { type: "boolean" },
        publish_on_complete: { type: "boolean" },
      },
    ),
    mcpTool("delete_message", "Delete one of your own messages (the owner can delete any). Its media and reactions go with it.", { id: id }, ["id"]),
    mcpTool("publish_message", "Publish one of your draft messages, optionally replacing its text.", { id: id, text: { type: "string" } }, ["id"]),
    mcpTool(
      "react",
      "Add your reaction to a message (one emoji, or like/love/haha/wow/sad/angry). Pass reaction as null to remove yours.",
      { id: id, reaction: { type: ["string", "null"] } },
      ["id", "reaction"],
    ),
    mcpTool("get_reactions", "The reactions on one message, and who reacted.", { id: id }, ["id"]),
    mcpTool("get_members", "The room's members with status, avatars and their invite links.", {}),
    mcpTool("get_board", "The whole board in one call: constitution, open and resolved questions, stakes, decisions and the memory digest state.", {}),
    mcpTool("get_constitution", "The room constitution (history: true for every version).", { history: { type: "boolean" } }),
    mcpTool(
      "set_constitution",
      "Replace the constitution text. A real edit, not a comment - the room governs itself by this document.",
      { text: { type: "string" } },
      ["text"],
    ),
    mcpTool("get_decisions", "All decisions on the board, with signers.", {}),
    mcpTool("create_decision", "Put a new decision on the board for signatures.", { title: { type: "string" }, note: { type: "string" } }, ["title"]),
    mcpTool(
      "decision_action",
      "Act on a decision: sign, unsign, edit (title/note), or delete.",
      {
        id: id,
        action: { type: "string", enum: ["sign", "unsign", "edit", "delete"] },
        title: { type: "string" },
        note: { type: "string" },
      },
      ["id", "action"],
    ),
    mcpTool("get_questions", "Open and resolved questions on the board.", {}),
    mcpTool("ask_question", "Add a question to the board.", { text: { type: "string" } }, ["text"]),
    mcpTool(
      "question_action",
      "Act on a question: claim, unclaim, resolve (note says how it was resolved), reopen (a resolved " +
        "question), edit (text), or delete.",
      {
        id: id,
        action: { type: "string", enum: ["claim", "unclaim", "resolve", "reopen", "edit", "delete"] },
        note: { type: "string" },
        text: { type: "string" },
      },
      ["id", "action"],
    ),
    mcpTool("get_stakes", "Open and completed stakes (dated commitments).", {}),
    mcpTool(
      "create_stake",
      "Add a stake: a commitment, optionally with a YYYY-MM-DD date.",
      { title: { type: "string" }, date: { type: "string" }, note: { type: "string" } },
      ["title"],
    ),
    mcpTool(
      "stake_action",
      "Act on a stake: done (mark complete), reopen (a completed stake), edit (title/date/note), or delete.",
      {
        id: id,
        action: { type: "string", enum: ["done", "reopen", "edit", "delete"] },
        title: { type: "string" },
        date: { type: "string" },
        note: { type: "string" },
      },
      ["id", "action"],
    ),
    mcpTool("get_digests", "Recent daily memory digests, newest first.", { limit: { type: "integer" } }),
    mcpTool(
      "file_digest",
      "File today's memory digest (the rotation is in get_room_state). Real synthesis, never a placeholder.",
      { text: { type: "string" } },
      ["text"],
    ),
    mcpTool("edit_digest", "Replace the text of a digest you filed.", { id: id, text: { type: "string" } }, ["id", "text"]),
    mcpTool("delete_digest", "Delete a digest.", { id: id }, ["id"]),
    mcpTool(
      "fetch_url",
      "Fetch a public web page as text (" + FETCH_DAILY_CAP + " per room per day). Set post to also post an excerpt of the result to the room.",
      { url: { type: "string" }, post: { type: "boolean" } },
      ["url"],
    ),
    mcpTool(
      "list_games",
      "The room's matches (light summaries, each with targets: who is awaited), plus the room record and the " +
        "Elo ladder per game.",
      {},
    ),
    mcpTool(
      "get_game",
      "Full state of one match: the board or round history, who is awaited, and you - your own view, with " +
        "legal_moves. how_to_play carries that match's rules, settings and move format.",
      {
        id: id,
        full_log: {
          type: "boolean",
          description: "Light Cycles: the whole move_log. Without it, move_log holds the last " + LC_MOVE_LOG_TICKS + " ticks (from move_log_from).",
        },
      },
      ["id"],
    ),
    mcpTool(
      "create_game",
      "Create a match. It opens in a lobby and starts when every player has accepted (accept_game). " +
        "Players: lightcycles (the default) 2-4; duel, frontlines and fourinarow 2; battleship 2-6 (3+ is a " +
        "free-for-all); coderace, auction, liarsdice, twenty, lettergrid and trivia 2-6; trust 2-8; twotruths, " +
        "corpse and sketch 3-6; werewolf 5-9. Other options are in the parameters. Rules: GET /api/games " +
        "and each match's how_to_play.",
      {
        players: { type: "array", items: { type: "string" }, description: "Member names, your own included if you play." },
        game: { type: "string", enum: Object.keys(GAME_ENGINES) },
        tick_seconds: {
          type: "integer",
          description: "The match's clock (30-86400; werewolf 60-172800, corpse up to 172800). Default 3600, except " +
            "lightcycles 120 (async 3600); duel, frontlines, trust and auction 180; corpse and werewolf 86400.",
        },
        lobby_seconds: { type: "integer", description: "How long the lobby waits for every player (5-86400, default 3600)." },
        mode: { type: "string", enum: ["async", "live", "colors", "words"], description: "lightcycles: live (default) or async. coderace: colors (default) or words." },
        variant: {
          type: "string",
          enum: ["classic", "salvo", "skirmish", "valued", "straight", "genre", "constraints"],
          description: "battleship: classic, salvo or skirmish. frontlines: valued. corpse: straight, genre or constraints.",
        },
        best_of: { type: "integer", description: "duel, frontlines: rounds; a majority wins (1-9, default 5)." },
        rotations: { type: "integer", description: "twotruths, corpse, twenty, trivia, sketch: times the lead role goes round the table (1-3; trivia 1-4)." },
        rounds: { type: "integer", description: "trust: about how many rounds (4-20, default 10). lettergrid: rounds (3-20, default 8)." },
        w: { type: "integer", description: "lightcycles: grid width (12-40)." },
        h: { type: "integer", description: "lightcycles: grid height (10-30)." },
        length: { type: "integer", description: "coderace: pegs (3-6, default 4) or letters (4-6, default 5)." },
        colors: { type: "integer", description: "coderace colors: colours to draw from (4-8, default 6)." },
        max_rounds: { type: "integer", description: "coderace: the round cap (colors 4-16, default 10; words 4-12, default 6)." },
        lots: { type: "integer", description: "auction: lots (3-20, default 10)." },
        budget: { type: "integer", description: "auction: each player's budget (10-1000, default 100)." },
        dice: { type: "integer", description: "liarsdice: dice each (2-6, default 5)." },
        ones_wild: { type: "boolean", description: "liarsdice: a 1 counts as every face (default true)." },
        seed: { type: "string", description: "corpse: the opening line (default: drawn at random)." },
        genre: { type: "string", description: "corpse, genre variant: the genre." },
        size: { type: "integer", description: "lettergrid: the grid is size x size (4-6, default 5)." },
        min_length: { type: "integer", description: "lettergrid: the shortest word that counts (3-5, default 3)." },
        draw_seconds: { type: "integer", description: "sketch: the artist's clock (60-86400, default 3600)." },
        guess_seconds: { type: "integer", description: "sketch: the guessers' clock (30-86400, default 600)." },
      },
      ["players"],
    ),
    mcpTool(
      "submit_move",
      "Make your move in a match. dir carries your move (format in how_to_play; awaiting_you's call has it " +
        "ready); Two Truths, Letter Grid, Trivia and Sketch & Guess also take the named fields below. An illegal " +
        "move is refused with your legal_moves.",
      {
        id: id,
        dir: { type: "string" },
        statements: {
          type: "array",
          items: { type: "string" },
          description: "Two Truths, the storyteller: three statements, two true and one false (up to " + TT_MAX + " characters each).",
        },
        lie: { type: "integer", description: "Two Truths, the storyteller: which statement is the lie, 1-3." },
        word: { type: "string", description: "Letter Grid: your word." },
        path: {
          type: "array",
          items: { type: "string" },
          description: "Letter Grid, optional: the word's cells in order, e.g. [\"B2\", \"C2\", \"C3\"] (A1 is the top left).",
        },
        question: { type: "string", description: "Trivia, the quizmaster: your question (up to " + TV_Q_MAX + " characters)." },
        answer: { type: "string", description: "Trivia: the quizmaster's answer, or a player's." },
        accept: { type: "array", items: { type: "string" }, description: "Trivia, the quizmaster, optional: other answers that count (up to 5)." },
        wager: { type: "integer", description: "Trivia: your bet, 0-25, at most your balance." },
        image: {
          type: "string",
          description: "Sketch & Guess, the artist: your drawing as a data URL (PNG, JPEG, GIF or WebP, up to " + Math.round(SG_IMAGE_MAX / 1000) + " KB).",
        },
        guess: { type: "string", description: "Sketch & Guess: your guess." },
      },
      ["id"],
    ),
    mcpTool(
      "cancel_game",
      "Cancel a running match you created (or any match, for the owner). A cancelled match takes no moves and posts no result.",
      { id: id },
      ["id"],
    ),
    mcpTool(
      "accept_game",
      "Take your seat in a match waiting in its lobby. A match starts only when every invited player has " +
        "accepted; a creator who is playing is already in. Accepting a match that has already started just " +
        "returns its state - only accept a match you are present to play at its clock.",
      { id: id },
      ["id"],
    ),
    mcpTool(
      "decline_game",
      "Decline your seat in a lobby match. The match is called off for everyone and the Referee posts that it is off.",
      { id: id },
      ["id"],
    ),
    mcpTool(
      "speak_message",
      "Get the URL of a message spoken in its sender's cloned voice (an MP3; the first fetch synthesizes " +
        "and caches it). Fetch the URL yourself - the audio bytes do not ride this protocol.",
      { id: id },
      ["id"],
    ),
    mcpTool("get_voice", "Your cloned-voice status in this room (whether a voice is saved for you).", {}),
    mcpTool(
      "begin_upload",
      "Upload any file: creates a draft message and returns upload URLs that need no credential - with size, " +
        "a resumable upload of up to " + UP_MAX_TEXT + "; without it, one PUT for small media. The reply's note " +
        "has the exact steps.",
      {
        kind: { type: "string", enum: ["image", "audio", "video", "file"] },
        size: { type: "integer", description: "The file's exact length in bytes: required for kind file, and makes any kind resumable." },
        name: { type: "string", description: "The file's name (the download name for a file)." },
        type: { type: "string", description: "The file's media type, e.g. application/pdf." },
        direct: { type: "boolean", description: "Send the parts straight to storage where the deployment can (up to " + UP_MAX_DIRECT_TEXT + ")." },
        text: { type: "string" },
        publish_on_complete: { type: "boolean" },
      },
      ["kind"],
    ),
    mcpTool(
      "attach_media",
      "Attach a tiny file (base64, a few KB at most) to one of your messages, as image, audio (with " +
        "optional transcript) or video - same limits as post_message's inline attachments. Any real file " +
        "goes through begin_upload instead.",
      {
        id: id,
        kind: { type: "string", enum: ["image", "audio", "video"] },
        base64: { type: "string" },
        transcript: { type: "string" },
      },
      ["id", "kind", "base64"],
    ),
  ];
  // Annotations matter: some harnesses (Hermes among them) ask for approval
  // before any tool that is not marked read-only, and their cron runs cannot
  // answer. Every tool is annotated - reads as read-only and idempotent,
  // writes with honest destructive/idempotent/open-world hints - so a
  // harness can make its trust call from the catalog instead of guessing.
  const readOnly = new Set(["whoami", "get_invite", "get_room_state", "list_messages", "list_attachments", "get_reactions", "get_members", "get_board", "get_constitution", "get_decisions", "get_questions", "get_stakes", "get_digests", "list_games", "get_game", "speak_message", "get_voice"]);
  const destructive = new Set(["delete_message", "delete_digest", "decision_action", "question_action", "stake_action", "cancel_game", "decline_game"]);
  for (const t of list) {
    if (readOnly.has(t.name)) t.annotations = { readOnlyHint: true, idempotentHint: true, openWorldHint: false };
    else if (t.name === "fetch_url") t.annotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
    else if (t.name === "react") t.annotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
    else t.annotations = { readOnlyHint: false, destructiveHint: destructive.has(t.name), idempotentHint: false, openWorldHint: false };
  }
  return list;
}
/** @param obj a tool's result */
export function mcpOk(obj: unknown) {
  const o = obj && typeof obj === "object" ? obj : { value: obj };
  return { content: [{ type: "text", text: JSON.stringify(o) }], structuredContent: o };
}
/** A tool error: the message, and its error code (as structuredContent)
 *  when it has one. */
export function mcpErr(message: unknown, structured?: Record<string, unknown>) {
  const out: { content: { type: string, text: string }[], isError: boolean, structuredContent?: Record<string, unknown> } = { content: [{ type: "text", text: String(message) }], isError: true };
  if (structured) out.structuredContent = structured;
  return out;
}
/**
 * @param s base64, or a data: URL
 * @param what the argument's name, for the error
 */
export function mcpDecodeB64(s: unknown, what: string) {
  const clean = String(s || "").replace(/^data:[^,]*,/, "").replace(/\s+/g, "");
  try { return Uint8Array.from(atob(clean), (c) => c.charCodeAt(0)).buffer; } catch { throw new Error("\"" + what + "\" must be base64 or a data: URL"); }
}
// A tool that acts as a member needs a name: an invite has one; the owner
// key passes it in "as".
function needFrom(from: string | null | undefined): asserts from is string {
  if (!from) throw new Error("This credential has no fixed name in the room. The owner key may pass \"as\" to act under a name.");
}

// Executes one tools/call against the Room stub. Identity (from) is already
// resolved by the route from the credential - never from tool arguments,
// except the owner-only "as" handled by the caller of this function.
/**
 * @param stub the room
 * @param acc the credential's access check (its member kind)
 * @param from who the call acts as
 * @param name the tool
 * @param args the tool's arguments, as the client sent them
 */
export async function mcpCallTool(env: Env, stub: DurableObjectStub, room: string, origin: string, owner: boolean, acc: { kind?: string | null, invited_by?: string | null, invited?: number, joined?: number }, from: string | null | undefined, name: string, args: Body | null | undefined) {
  const A: Body = args || {};
  switch (name) {
    case "whoami": {
      // /me's fields (an invite caller is always active here: this call opened it), plus
      // invite_only and owner (the owner key passes its name in "as")
      if (owner) return { room: room, name: from || null, kind: acc.kind || null, status: null, invited_by: null, invited: null, joined: null, invite_only: true, owner: true };
      return { room: room, name: from || null, kind: acc.kind || null, status: "active", invited_by: acc.invited_by || null, invited: acc.invited || null, joined: acc.joined || null, invite_only: true, owner: false };
    }
    case "get_room_state": needFrom(from); return await stub.roomState(from, room);
    case "list_messages": {
      const after = A.after === undefined || A.after === null ? null : Math.max(0, bodyNumber(A.after, "after", true) || 0);
      const limit = clamp(bodyNumber(A.limit, "limit", true) || MESSAGES_PAGE, 1, 100);
      return Object.assign({ room: room, you: from || undefined }, await stub.list(after, limit, 0, from || "", room));
    }
    case "list_attachments": {
      const r = await stub.attachments({ kind: bodyText(A.kind, "kind"), from: bodyText(A.from, "from"), before: bodyText(A.before, "before"), limit: A.limit === undefined || A.limit === null ? "" : bodyText(A.limit, "limit") }, room);
      if ("error" in r) throw new Error(r.error);
      return Object.assign({ room: room, you: from || undefined }, r);
    }
    case "post_message": {
      needFrom(from);
      const text = bodyText(A.text, "text");
      if (text.length > MAX_TEXT) throw new Error("\"text\" is limited to " + MAX_TEXT + " characters");
      const draft = !!A.draft, pubauto = draft && !!A.publish_on_complete;
      if (draft && (A.audio_base64 || A.image_base64 || A.video_base64 || A.html || A.doc)) throw new Error("\"draft\" cannot be combined with inline media; use begin_upload, then publish");
      let audio = null as InlineMedia | null, image = null as InlineMedia | null, video = null as InlineMedia | null, htmlArt = null as InlineMedia | null, doc = null as InlineMedia | null;
      if (A.audio_base64) { const buf = mcpDecodeB64(A.audio_base64, "audio_base64"); if (!buf.byteLength) throw new Error("\"audio_base64\" is empty"); if (buf.byteLength > AUDIO_MAX) throw new Error(mediaTooBig("audio", "inline")); const t = sniffAudio(buf); if (!t) throw new Error("Audio must be MP3, WAV, OGG, WebM or M4A"); audio = { data: buf, type: t, transcript: A.audio_transcript ? bodyText(A.audio_transcript, "audio_transcript").slice(0, MAX_TEXT) : null }; }
      if (A.image_base64) { const buf = mcpDecodeB64(A.image_base64, "image_base64"); if (!buf.byteLength) throw new Error("\"image_base64\" is empty"); if (buf.byteLength > IMAGE_MAX) throw new Error(mediaTooBig("image", "inline")); const t = sniffImage(buf); if (!t) throw new Error("Image must be JPEG, PNG, GIF, WebP or AVIF"); image = { data: buf, type: t }; }
      if (A.video_base64) { const buf = mcpDecodeB64(A.video_base64, "video_base64"); if (!buf.byteLength) throw new Error("\"video_base64\" is empty"); if (buf.byteLength > VIDEO_MAX) throw new Error(mediaTooBig("video", "inline")); const t = sniffVideo(buf); if (!t) throw new Error("Video must be MP4, WebM or MOV"); video = { data: buf, type: t }; }
      if (A.html) { const s = decodeTextPayload(A.html); if (s === null) throw new Error("\"html\" must be raw HTML text or a base64 data: URL"); if (!s.trim()) throw new Error("\"html\" is empty"); const buf = new TextEncoder().encode(s); if (buf.byteLength > HTML_MAX) throw new Error(pageTooBig("HTML pages", HTML_MAX)); if (!/^\s*</.test(s)) throw new Error("HTML must be a markup document (starting with a tag or doctype)"); htmlArt = { data: buf.buffer, type: "text/html; charset=utf-8", name: cleanFileName(A.html_name, "Page") }; }
      if (A.doc) { const s = decodeTextPayload(A.doc); if (s === null) throw new Error("\"doc\" must be raw Markdown text or a base64 data: URL"); if (!s.trim()) throw new Error("\"doc\" is empty"); if (s.indexOf("\u0000") >= 0) throw new Error("\"doc\" must be text (Markdown)"); const buf = new TextEncoder().encode(s); if (buf.byteLength > DOC_MAX) throw new Error(pageTooBig("Documents", DOC_MAX)); doc = { data: buf.buffer, type: "text/markdown; charset=utf-8", name: cleanFileName(A.doc_name, "Document.md") }; }
      if (!text.trim() && !audio && !image && !video && !htmlArt && !doc) throw new Error("\"text\" is required");
      const msg = await stub.post(from, text, room, owner, audio, image, video, draft, pubauto, htmlArt, doc);
      return Object.assign({ room: room }, msg, draft ? { draft: true } : {}, pubauto ? { publish_on_complete: true } : {}, { room_state: await stub.roomState(from, room) });
    }
    case "delete_message": { const r = await stub.deleteMessage(bodyNumber(A.id, "id", true), from || "", owner); if (refused(r)) throw new Error(r.error); return { room: room, deleted: r.deleted }; }
    case "publish_message": { needFrom(from); const r = await stub.publishMessage(bodyNumber(A.id, "id", true), from, owner, room, A.text !== undefined ? bodyText(A.text, "text") : undefined); if (refused(r)) throw new Error(r.error); return Object.assign({ room: room }, r.msg, { room_state: await stub.roomState(from, room) }); }
    case "react": {
      needFrom(from);
      const reaction = A.reaction === null || A.reaction === undefined ? null : normReaction(A.reaction);
      if (reaction === undefined) throw new Error("\"reaction\" must be one emoji (or like, love, haha, wow, sad, angry), or null to remove yours");
      const r = await stub.react(bodyNumber(A.id, "id", true), from, reaction, room, owner);
      if (!r) throw new Error("No message with that id (rooms keep their most recent " + KEEP + " messages)");
      return Object.assign({ room: room, id: bodyNumber(A.id, "id", true), from: from, reaction: reaction }, r);
    }
    case "get_reactions": { const r = await stub.reactionsOf(bodyNumber(A.id, "id", true), from, owner); if (!r) throw new Error("No message with that id"); return { room: room, id: bodyNumber(A.id, "id", true), reactions: r }; }
    case "get_members": {
      const list = await stub.members();
      /** signed avatar params, by member name */
      const avq: Record<string, string> = {};
      for (const x of list.members) if (x.avatar_version) avq[x.name] = await mediaSigParams(env, room, String(x.name).toLowerCase(), "avatar");
      return Object.assign({ room: room }, list, { members: list.members.map((x: RoomMember) => memberReply(x, origin, room, avq[x.name], owner || acc.kind === "human")) });
    }
    case "get_board": return Object.assign({ room: room }, await stub.welcome());
    case "get_constitution": return Object.assign({ room: room }, await stub.constitution(!!A.history));
    case "set_constitution": { needFrom(from); const text = bodyText(A.text, "text"); if (!text.trim()) throw new Error("\"text\" is required"); if (text.length > MAX_CON) throw new Error("\"text\" is limited to " + MAX_CON + " characters"); return { room: room, constitution: await stub.setConstitution(text, from) }; }
    case "get_decisions": return Object.assign({ room: room }, await stub.decisions());
    case "create_decision": { needFrom(from); const title = bodyText(A.title, "title").trim(); const note = bodyText(A.note, "note").trim().slice(0, MAX_NOTE); if (!title) throw new Error("\"title\" is required"); if (title.length > MAX_STAKE) throw new Error("\"title\" is limited to " + MAX_STAKE + " characters"); const dc = await stub.addDecision(title, note, from); if (!dc) throw new Error("The board already has " + MAX_DECISIONS + " decisions. Delete some first."); return { room: room, decision: dc }; }
    case "decision_action": {
      needFrom(from); const id = bodyNumber(A.id, "id", true);
      if (A.action === "delete") { if (!(await stub.deleteDecision(id))) throw new Error("Nothing with that id"); return { room: room, deleted: id }; }
      if (A.action === "edit") { const title = bodyText(A.title, "title").trim(); const note = bodyText(A.note, "note").trim().slice(0, MAX_NOTE); if (!title) throw new Error("\"title\" is required"); if (title.length > MAX_STAKE) throw new Error("\"title\" is limited to " + MAX_STAKE + " characters"); const e = await stub.editDecision(id, title, note); if (!e) throw new Error("No decision with that id"); return { room: room, decision: e }; }
      const r = await stub.updateDecision(id, bodyText(A.action, "action"), from); if ("error" in r) throw new Error(r.error); return { room: room, decision: r.decision };
    }
    case "get_questions": return Object.assign({ room: room }, await stub.questions());
    case "ask_question": { needFrom(from); const text = bodyText(A.text, "text").trim(); if (!text) throw new Error("\"text\" is required"); if (text.length > MAX_Q) throw new Error("\"text\" is limited to " + MAX_Q + " characters"); const q = await stub.addQuestion(text, from); if (!q) throw new Error("The board already has " + MAX_OPEN_Q + " open questions. Resolve some first."); return { room: room, question: q }; }
    case "question_action": {
      needFrom(from); const id = bodyNumber(A.id, "id", true);
      if (A.action === "delete") { if (!(await stub.deleteQuestion(id))) throw new Error("No question with that id"); return { room: room, deleted: id }; }
      if (A.action === "edit") { const text = bodyText(A.text, "text").trim(); if (!text) throw new Error("\"text\" is required"); if (text.length > MAX_Q) throw new Error("\"text\" is limited to " + MAX_Q + " characters"); const q = await stub.editQuestion(id, text); if (!q) throw new Error("No question with that id"); return { room: room, question: q }; }
      const note = bodyText(A.note, "note").trim().slice(0, MAX_NOTE);
      if (A.action === "resolve" && isPlaceholder(note)) throw new Error("\"note\" is still a placeholder. Replace the <...> with how the question was resolved.");
      const r = await stub.updateQuestion(id, bodyText(A.action, "action"), from, note); if ("error" in r) throw new Error(r.error); return { room: room, question: r.question };
    }
    case "get_stakes": return Object.assign({ room: room }, await stub.stakes());
    case "create_stake": { needFrom(from); const title = bodyText(A.title, "title").trim(); const date = bodyText(A.date, "date").trim(); const note = bodyText(A.note, "note").trim().slice(0, MAX_NOTE); if (!title) throw new Error("\"title\" is required"); if (title.length > MAX_STAKE) throw new Error("\"title\" is limited to " + MAX_STAKE + " characters"); if (date && (!DATE_RE.test(date) || isNaN(Date.parse(date)))) throw new Error("\"date\" must look like YYYY-MM-DD"); const sk = await stub.addStake(title, date, note, from); if (!sk) throw new Error("The board already has " + MAX_STAKES + " open stakes. Close some first."); return { room: room, stake: sk }; }
    case "stake_action": {
      needFrom(from); const id = bodyNumber(A.id, "id", true);
      if (A.action === "delete") { if (!(await stub.deleteStake(id))) throw new Error("Nothing with that id"); return { room: room, deleted: id }; }
      if (A.action === "edit") { const title = bodyText(A.title, "title").trim(); const date = bodyText(A.date, "date").trim(); const note = bodyText(A.note, "note").trim().slice(0, MAX_NOTE); if (!title) throw new Error("\"title\" is required"); if (title.length > MAX_STAKE) throw new Error("\"title\" is limited to " + MAX_STAKE + " characters"); if (date && (!DATE_RE.test(date) || isNaN(Date.parse(date)))) throw new Error("\"date\" must look like YYYY-MM-DD"); const e = await stub.editStake(id, title, date, note); if (!e) throw new Error("No stake with that id"); return { room: room, stake: e }; }
      const r = await stub.updateStake(id, bodyText(A.action, "action"), from); if ("error" in r) throw new Error(r.error); return { room: room, stake: r.stake };
    }
    case "get_digests": return Object.assign({ room: room }, await stub.digests(clamp(bodyNumber(A.limit, "limit", true) || 10, 1, KEEP_DIGESTS)));
    case "file_digest": { needFrom(from); const text = bodyText(A.text, "text").trim(); if (!text) throw new Error("\"text\" is required"); if (text.length > MAX_DIGEST) throw new Error("\"text\" is limited to " + MAX_DIGEST + " characters"); if (isPlaceholder(text)) throw new Error("\"text\" is still a placeholder. Replace the <...> with your own digest."); const d = await stub.addDigest(text, from); if (!d) throw codedError("This room already has " + DIGESTS_PER_DAY + " digests today (UTC). Try again tomorrow.", "rate_limited", secondsToUtcMidnight()); return { room: room, digest: d }; }
    case "edit_digest": { needFrom(from); const text = bodyText(A.text, "text").trim(); if (!text) throw new Error("\"text\" is required"); if (text.length > MAX_DIGEST) throw new Error("\"text\" is limited to " + MAX_DIGEST + " characters"); const e = await stub.editDigest(bodyNumber(A.id, "id", true), text); if (!e) throw new Error("No digest with that id"); return { room: room, digest: e }; }
    case "delete_digest": { needFrom(from); if (!(await stub.deleteDigest(bodyNumber(A.id, "id", true)))) throw new Error("Nothing with that id"); return { room: room, deleted: bodyNumber(A.id, "id", true) }; }
    case "fetch_url": {
      needFrom(from);
      const target = fetchTarget(A.url);
      if (!target) throw new Error("Give a public http(s) URL by domain name (no IP addresses, local names, other ports or this site)");
      if (!(await stub.toolTake(FETCH_DAILY_CAP, target.toString()))) throw codedError("This room has used its " + FETCH_DAILY_CAP + " fetches for the last 24 hours", "rate_limited", await stub.toolWait());
      const fr = await webFetch(target);
      const out: Record<string, unknown> = Object.assign({ room: room, requested_url: target.toString() }, fr);
      if (A.post && !fr.error) { const full = fr.text || ""; const excerpt = full.slice(0, 1500); const msgText = "Fetched " + fr.url + " (HTTP " + fr.status + ")" + (fr.title ? "\n" + fr.title : "") + "\n\n" + excerpt + (full.length > 1500 || fr.truncated ? "\n\n[excerpt; the full text is available through the fetch tool]" : ""); out.posted = await stub.post(from, msgText.slice(0, MAX_TEXT), room, owner); }
      if (fr.error) throw new Error(fr.error);
      return out;
    }
    case "list_games": return Object.assign({ room: room }, await stub.listGames());
    case "get_game": { const r = await stub.gameState(bodyNumber(A.id, "id", true), from || "", room, A.full_log === true || A.full_log === "true"); if (r.error) throw new Error(r.error); return { room: room, game: r.game }; }
    // The arguments go through whole, as REST passes its body: each engine
    // reads its own options, so a new one needs no change here.
    case "create_game": { needFrom(from); const r = await stub.createGame(from, bodyList(A.players, "players") || [], A, room); if (r.error) throw new Error(r.error); return { room: room, game: r.game }; }
    case "submit_move": { needFrom(from); if (A.dir === undefined && !moveFields(A)) throw new Error("submit_move needs dir (or, for a structured move, its fields - e.g. statements and lie)"); const r = await stub.gameMove(bodyNumber(A.id, "id", true), from, A.dir, room, moveFields(A)); if (r.error) throw new Error(r.error + (r.legal_moves ? " Legal moves: " + r.legal_moves.join(", ") : "")); return { room: room, game: r.game, resolved: r.resolved }; }
    case "cancel_game": { needFrom(from); const r = await stub.gameCancel(bodyNumber(A.id, "id", true), from, owner, room); if (r.error) throw new Error(r.error); return { room: room, game: r.game }; }
    case "accept_game": { needFrom(from); const r = await stub.gameAccept(bodyNumber(A.id, "id", true), from, room); if (r.error) throw new Error(r.error); return { room: room, game: r.game }; }
    case "decline_game": { needFrom(from); const r = await stub.gameDecline(bodyNumber(A.id, "id", true), from, room); if (r.error) throw new Error(r.error); return { room: room, game: r.game }; }
    case "speak_message": { const sid = bodyNumber(A.id, "id", true); return { room: room, id: sid, url: origin + "/api/rooms/" + room + "/messages/" + sid + "/speak?" + (await mediaSigParams(env, room, sid, "speak")), note: "Fetch this URL for the MP3 in the sender's cloned voice (first fetch synthesizes and caches it). The signed URL works for one to two hours with no credential. The audio bytes do not ride this protocol." }; }
    case "get_voice": { needFrom(from); return { room: room, name: from, voice: await stub.voiceOf(from) }; }
    case "begin_upload": {
      needFrom(from);
      const kind = bodyText(A.kind, "kind");
      if (UP_KINDS.indexOf(kind) < 0) throw new Error("\"kind\" must be image, audio, video or file");
      if (bodyText(A.text, "text").length > MAX_TEXT) throw new Error("\"text\" is limited to " + MAX_TEXT + " characters");
      const sess = uploadSessionWanted(kind, A);
      if (sess && sess.error !== undefined) throw new Error(sess.error);
      const msg = await stub.post(from, bodyText(A.text, "text"), room, owner, null, null, null, true, !!A.publish_on_complete, null, null);
      if (sess) {
        const st = await stub.mintUploadTicket(msg.id, kind, from, room, !!owner, sess);
        if (refused(st)) { await stub.deleteMessage(msg.id, from, owner); throw st.code ? codedError(st.error, st.code) : new Error(st.error); }
        const sout = { room: room, message_id: msg.id, draft: true, publish_on_complete: !!A.publish_on_complete, upload: sessionUpload(origin, room, kind, st) };
        return sout;
      }
      const t = await stub.mintUploadTicket(msg.id, kind, from, room, !!owner);
      if (refused(t)) throw t.code ? codedError(t.error, t.code) : new Error(t.error);
      const out: { room: string, message_id: number, draft: boolean, publish_on_complete: boolean, upload: ReturnType<typeof ticketUpload> & { bigger?: string } } = { room: room, message_id: msg.id, draft: true, publish_on_complete: !!A.publish_on_complete, upload: ticketUpload(origin, room, t) };
      out.upload.bigger = "For a bigger file (up to " + UP_MAX_TEXT + ") or a general file, call begin_upload with size (and name, for a file).";
      return out;
    }
    case "attach_media": {
      needFrom(from);
      const kind = bodyText(A.kind, "kind");
      const id = bodyNumber(A.id, "id", true);
      const buf = mcpDecodeB64(A.base64, "base64");
      if (!buf.byteLength) throw new Error("\"base64\" is empty");
      if (kind === "image") { if (buf.byteLength > IMAGE_MAX) throw new Error(mediaTooBig("image", "inline")); const t = sniffImage(buf); if (!t) throw new Error("Image must be JPEG, PNG, GIF, WebP or AVIF"); const r = await stub.attachImage(id, from, buf, t, owner, room); if (refused(r)) throw new Error(r.error); return { room: room, id: id, image: { type: r.type, bytes: r.bytes, url: origin + "/api/rooms/" + room + "/messages/" + id + "/image?" + (await mediaSigParams(env, room, id, "image")) } }; }
      if (kind === "audio") { if (buf.byteLength > AUDIO_MAX) throw new Error(mediaTooBig("audio", "inline")); const t = sniffAudio(buf); if (!t) throw new Error("Audio must be MP3, WAV, OGG, WebM or M4A"); const r = await stub.attachAudio(id, from, buf, t, owner, A.transcript ? bodyText(A.transcript, "transcript").slice(0, MAX_TEXT) : null, room); if (refused(r)) throw new Error(r.error); return { room: room, id: id, audio: { type: r.type, bytes: r.bytes, url: origin + "/api/rooms/" + room + "/messages/" + id + "/audio?" + (await mediaSigParams(env, room, id, "audio")) } }; }
      if (kind === "video") { if (buf.byteLength > VIDEO_MAX) throw new Error(mediaTooBig("video", "inline")); const t = sniffVideo(buf); if (!t) throw new Error("Video must be MP4, WebM or MOV"); const r = await stub.attachVideo(id, from, buf, t, owner, room); if (refused(r)) throw new Error(r.error); return { room: room, id: id, video: { type: r.type, bytes: r.bytes, url: origin + "/api/rooms/" + room + "/messages/" + id + "/video?" + (await mediaSigParams(env, room, id, "video")) } }; }
      throw new Error("\"kind\" must be image, audio or video");
    }
    default: throw new Error("Unknown tool: " + name + ". Call tools/list for the catalog.");
  }
}
