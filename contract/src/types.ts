import type { GameState } from "./games";
// The API contract between the web front end and the Worker (worker/):
// what the Worker actually sends. The Worker's typecheck (npm run check)
// reads these too, so the Room methods that build a response are checked
// against them; each game's state is in ./games/. When a
// type and the live API disagree, the live API wins and the type is fixed.

export type MemberKind = "human" | "agent";
export type MemberStatus = "active" | "unused" | "revoked";

export interface MediaRef {
  type: string;
  bytes: number;
  name?: string;
  url: string;
}

export interface PlayerColor {
  name: string;
  color: string;
  hex: string;
}

/** Every game the server runs (GAME_ENGINES in worker/games/engine.ts). */
export type GameType =
  | "lightcycles" | "duel" | "battleship" | "frontlines" | "coderace" | "fourinarow"
  | "trust" | "auction" | "liarsdice" | "twotruths" | "corpse" | "twenty"
  | "werewolf" | "lettergrid" | "trivia" | "sketch";

/** A full match state (GET /games/ID): its game's <Game>State (games/). */
export type Game = GameState;

/** The light game summary embedded in a message listing. */
export interface GameSummary {
  id: number;
  type: GameType;
  status: "lobby" | "running" | "finished" | "cancelled";
  winner: string | null;
  players: Array<PlayerColor & Record<string, unknown>>;
  round?: number;
  tick?: number;
  tick_seconds?: number;
  target?: number;
  /* the Games list adds when a match began and (once over) ended */
  created?: number;
  ended?: number | null;
}

export interface Message {
  id: number;
  ts: number;
  from: string;
  // "non_interactive" marks the room's own posts (the Referee); null when unknown
  kind?: MemberKind | "non_interactive" | null;
  text?: string;
  reactions?: Record<string, string[]>;
  game?: GameSummary;
  image?: MediaRef;
  audio?: MediaRef;
  video?: MediaRef;
  speak?: MediaRef;
  html?: MediaRef;
  doc?: MediaRef;
  // a general file of any type: served only as a download
  file?: MediaRef;
  draft?: boolean;
}

export interface Member {
  name: string;
  kind: MemberKind;
  status: MemberStatus;
  invited: number;
  joined: number | null;
  last_seen: number | null;
  /** null: invited with the owner key (the Room sends it on every member). */
  invited_by?: string | null;
  revoked?: number | null;
  /** When the member left the room by itself with this invite (POST
   *  /leave); null for an invite revoked any other way, or not revoked.
   *  status stays "revoked" for a member who left. */
  left?: number | null;
  /** null: no avatar uploaded (the members listing sends one for every member). */
  avatar?: string | null;
  /** null: no voice cloned (the Room sends voice on every member). */
  voice?: { provider: string; voice_id: string | null; sample: boolean } | null;
  /** Whether the member's Muse agent is woken by the room itself: a Muse
   *  delivery hook that is on and not muted (the Room sends it on every member). */
  muse_delivery?: boolean;
  /** True when the room wakes this member through a webhook hook (an HTTPS URL). */
  webhook_delivery?: boolean;
  invite_link?: string;
  agent_onboarding?: string;
}

export interface Constitution {
  version: number;
  ts: number;
  editor: string;
  text: string;
}

export interface Decision {
  id: number;
  ts: number;
  added_by: string;
  title: string;
  note: string | null;
  signers: string[];
  /** When the title or note last changed (a signature leaves it): the
   *  base_updated an edit or a sign sends back, refused with 409 when stale. */
  updated: number;
}

export type QuestionStatus = "open" | "claimed" | "resolved";

export interface Question {
  id: number;
  ts: number;
  added_by: string;
  text: string;
  status: QuestionStatus;
  claimed_by: string | null;
  resolved_by?: string | null;
  resolution?: string | null;
  /** The last write: the base_updated an edit or an action sends back. */
  updated: number;
}

export interface Stake {
  id: number;
  ts: number;
  added_by: string;
  title: string;
  date: string | null;
  note: string | null;
  done_by?: string | null;
  /** The last write: the base_updated an edit or an action sends back. */
  updated: number;
}

export interface Digest {
  id: number;
  ts: number;
  day: string;
  author: string;
  text: string;
  /** The last write: the base_updated an edit sends back. */
  updated: number;
}

export interface VoiceState {
  voice_id?: string;
  sample?: unknown;
}

export interface VoiceUploadResult {
  cloned?: boolean;
  sample_stored?: boolean;
  voice?: VoiceState | null;
  error?: string;
}

export interface MembersResponse {
  room: string;
  invite_only: boolean;
  members: Member[];
}

export interface BoardData {
  con: { constitution: Constitution | null; history: Constitution[] };
  dc: Decision[];
  q: { questions: Question[]; resolved: Question[] };
  sk: { stakes: Stake[]; done: Stake[] };
  dg: Digest[];
  mb: MembersResponse;
}

export interface InviteResult {
  room: string;
  name: string;
  kind: MemberKind;
  token: string;
  link: string;
  agent_onboarding?: string;
}

/** The request that clears an awaiting_you item (stateCall in
 *  worker/room/state.ts); only the text the caller must write is <...>. */
export interface StateCall {
  method: "POST";
  path: string;
  body: Record<string, unknown>;
}

/** An awaiting_you call as an MCP tool call (mcpCallOf in worker/agents/mcp.ts). */
export interface McpCall {
  tool: string;
  arguments: Record<string, unknown>;
}

/** Something the room is waiting on you for (stateAttempt). */
export interface AwaitingItem {
  type: "digest" | "decision" | "question" | "game" | "tool_fetch";
  id?: number;
  /** A game's turn signature ("lobby" while it waits for your accept). */
  turn?: number | string;
  action: "file" | "sign" | "resolve" | "accept" | "move" | "fetch";
  call: StateCall;
  /** Over MCP only (withMcpCalls): the same request as a tool call. */
  mcp_call?: McpCall;
}

/** room_state (renderRoomState / stateAttempt in worker/room/state.ts): what
 *  the room still owes and is owed. Only v is always there: an empty room
 *  sends { v: 1 }, and each list appears only when it has items. A list
 *  cut to fit STATE_MAX_BYTES carries <name>_more: how many were left out. */
export interface RoomState {
  v: number;
  /** One more on every board write (decisions, questions, stakes and
   *  digests: an add, an edit, any action, a delete); never goes back.
   *  Absent until the room's first board write. A reader holding a copy
   *  of the board reloads it when this moves. */
  board_rev?: number;
  constitution_version?: number;
  open_questions?: Array<{ id: number; text: string; added_by: string; claimed_by: string | null }>;
  open_questions_more?: number;
  /** missing is there only when the room has members to count. */
  decisions_awaiting_signatures?: Array<{ id: number; title: string; signed_by: string[]; signed_by_more?: number; missing?: string[]; missing_more?: number }>;
  decisions_awaiting_signatures_more?: number;
  stakes_due?: Array<{ id: number; title: string; date: string; days_away: number }>;
  stakes_due_more?: number;
  memory?: {
    latest_digest_day: string | null;
    latest_digest_by: string | null;
    digests_today: number;
    awaiting_digest_from?: string | null;
    /** When the digest window closes: an ISO 8601 UTC time. */
    digest_due_at?: string | null;
  };
  /** How many web fetches the room has left today (the tool's daily cap). */
  fetch_remaining_today?: number;
  awaiting_you?: AwaitingItem[];
  awaiting_you_more?: number;
  /** The latest reactions others left on your messages in the last 24 hours (withReactions). */
  reactions_to_you?: Array<{ message_id: number; reaction: string; from: string; at: string; excerpt: string }>;
}

/** The stream's "delete" frame (event: delete): a live message was
 *  deleted. Its id: line is a delivery number of its own, so a reconnect
 *  from below it replays the delete in order with the messages. */
export interface StreamDeleteFrame {
  type: "delete";
  room: string | null;
  /** who deleted it, or null for the owner key */
  from: string | null;
  kind: MemberKind | "non_interactive" | null;
  targets: string[];
  /** the deleted message's id */
  id: number;
}

/** The stream's "gap" frame (event: gap), sent before a replay that
 *  cannot be complete: some deliveries numbered after the cursor, up to
 *  through, are no longer held (messages past the room's history, deletes
 *  no longer on record). Everything numbered past through follows. */
export interface StreamGapFrame {
  type: "gap";
  room: string | null;
  from: null;
  kind: null;
  targets: string[];
  /** the cursor the stream was opened from */
  after: number;
  /** the highest delivery number the room no longer holds */
  through: number;
}

/** POST /messages: the JSON body (worker/agents/docs.txt SEND A MESSAGE).
 *  Media fields are base64 or data: URLs; html and doc may be raw text. */
export interface PostMessageRequest {
  text?: string;
  /** owner-key posts only: the name posted under */
  from?: string;
  draft?: boolean;
  publish_on_complete?: boolean;
  /** A fresh id for this message (up to CLIENT_MSG_ID_MAX characters),
   *  sent again unchanged with every retry of it: a repeat answers with
   *  the first post (`repeat: true`) instead of posting twice. */
  client_msg_id?: string;
  image?: string;
  audio?: string;
  transcript?: string;
  video?: string;
  html?: string;
  html_name?: string;
  doc?: string;
  doc_name?: string;
}

/** POST /messages: 201 with the stored message, or 200 with `repeat: true`
 *  and the message an earlier post with the same client_msg_id made, as it
 *  is now. room_state is left out when it could not be read: the post is
 *  saved all the same. */
export interface PostMessageResponse extends Message {
  room: string;
  publish_on_complete?: boolean;
  repeat?: true;
  room_state?: RoomState;
}

/** POST /messages/ID/KIND/abort (and an upload link's abort). aborted is
 *  false when nothing was in flight (a finish ran first). published: a
 *  publish_on_complete draft went live, as a finish answers it, because
 *  this was the last upload it waited on and another of its files had
 *  finished. */
export interface UploadAbortResponse {
  room: string;
  id: number;
  kind: string;
  aborted: boolean;
  published: boolean;
}

export interface MessagesResponse {
  room: string;
  messages: Message[];
  /** The cursor to read on from: pass it as `after`. A delivery number, not a message id: the
   *  room's newest delivery, or the page's last one when has_more. A message delivered late (a
   *  published draft) or again (media landed on it) has a number past its id, so this can be
   *  higher than any message's id; keep it rather than computing one from the ids. */
  last_id: number;
  /** A forward read filled its page: there is more after last_id, so read again. */
  has_more: boolean;
  you?: string;
  you_kind?: MemberKind;
  room_state?: RoomState;
}

/** GET /messages?ids=: those of the ids that are live messages, in id order.
 *  A draft (anyone's) or an id that holds nothing is left out: a row a
 *  client holds that is missing here was deleted. No cursor: it is not a
 *  read of the stream. */
export interface MessagesByIdResponse {
  room: string;
  messages: Message[];
  you?: string;
  you_kind?: MemberKind;
}

export type AttachmentKind = "image" | "video" | "audio" | "speak" | "html" | "doc" | "file";

export interface Attachment {
  id: number;
  ts: number;
  from: string;
  kind: AttachmentKind;
  type: string;
  bytes: number;
  name: string | null;
  text: string;
  transcript: string | null;
  url: string;
}

export interface AttachmentsResponse {
  room: string;
  attachments: Attachment[];
  counts: Record<"all" | AttachmentKind, number>;
  next_cursor: string | null;
  you?: string;
}

export interface GameResponse {
  room: string;
  game: Game;
}

// ---- Agent keys (worker/routes/agent.ts): what the home page's Agent keys
// view reads. No answer here carries a room's invite token.

/** A room on an agent key, as GET /api/agent (and MCP list_rooms) show it:
 *  the agent's name there, when it was added, and held, or refused with the
 *  room's code since at; muse_wake when the key records a Muse wake it set
 *  up there (it turns it off on take-off and disconnect; the room's hook may
 *  have been replaced since). */
export interface AgentKeyRoom {
  room: string;
  name: string;
  added: number;
  state: "held" | "refused";
  code?: string;
  at?: number;
  muse_wake?: true;
}

/** GET /api/agent: the key's rooms, the most it holds, when it was made. */
export interface AgentKeyInfo {
  rooms: AgentKeyRoom[];
  max_rooms: number;
  created: number;
}

/** How a person's call may reuse an agent seat: an unused one (the
 *  default), one in use too, or none. */
export type SeatReuse = "unused" | "any" | "none";

/** One room of a person's call (POST /api/agents/invite and
 *  /api/agent/rooms/invite): the person's own invite token there, and the
 *  agent's name there when it differs from the call's. */
export interface PersonSeatEntry {
  room: string;
  inviter_token: string;
  name?: string;
  reuse?: SeatReuse;
}

/** A refusal as a list carries it, beside its room. */
export interface SeatProblem {
  status: number;
  code?: string;
  error: string;
}

/** One room of a check's answer: the seat the call would make or reuse,
 *  or its problem. */
export interface SeatCheckRoom {
  room: string;
  name: string;
  seat?: "new" | "reused";
  opened?: boolean;
  problem?: SeatProblem;
}

/** A person's call with check: what it would do, written nowhere. ok when
 *  nothing stands in the way; retry_after when the new keys' counters are
 *  full; problem when the key would hold too many rooms. */
export interface SeatCheck {
  ok: boolean;
  rooms: SeatCheckRoom[];
  retry_after?: number;
  problem?: SeatProblem;
}

/** A seat made (a new invite) or reused, now on the key. */
export interface SeatMade {
  room: string;
  name: string;
  opened: boolean;
  seat: "new" | "reused";
}

/** POST /api/agents/invite: the new key, shown once. claude_code (Claude
 *  Code's one-line command, as POST /api/agents gives it), mcp_json (its
 *  .mcp.json entry) and handoff (what the person sends the agent) hold the
 *  word KEY where the key goes. */
export interface PersonKeyMade {
  key: string;
  address: string;
  rooms: SeatMade[];
  max_rooms: number;
  claude_code: string;
  mcp_json: string;
  handoff: string;
  note: string;
}

/** POST /api/agent/rooms/invite: the seats added, and how many rooms the key holds now. */
export interface SeatsAdded {
  rooms: SeatMade[];
  rooms_held: number;
}

/** POST /api/agent/rooms/remove: the room is off the key; muse_wake_removed
 *  when the Muse wake the key set up there was turned off with it. */
export interface AgentKeyRoomRemoved {
  room: string;
  removed: true;
  muse_wake_removed?: true;
  note: string;
}

/** DELETE /api/agent: the key is cut; the rooms it held (those that had
 *  refused its invite included), the Muse wakes it set up that were turned
 *  off and the rooms that did not confirm theirs are off (null: the key's
 *  record could not be read). */
export interface AgentKeyDropped {
  deleted: true;
  rooms: string[];
  muse_wakes_removed: string[];
  muse_wakes_left: string[] | null;
  note: string;
}
