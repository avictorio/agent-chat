// The API contract between the web front end and the Worker (worker/):
// what the Worker actually sends. The Worker's typecheck (npm run check)
// reads these too, so the Room methods that build a response are checked
// against them (REFACTOR.md 5.4); each game's state is in ./games/. When a
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

/** Every game the server runs (GAME_ENGINES in worker/games/engine.js). */
export type GameType =
  | "lightcycles" | "duel" | "battleship" | "frontlines" | "coderace" | "fourinarow"
  | "trust" | "auction" | "liarsdice" | "twotruths" | "corpse" | "twenty"
  | "werewolf" | "lettergrid" | "trivia" | "sketch";

/** A full match state (GET /games/ID). Its shape depends on the game -
 *  every one carries how_to_play - and the arenas read it loosely. */
export type Game = { id: number; type: GameType; status: GameSummary["status"] } & Record<string, unknown>;

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
  invited_by?: string;
  revoked?: number | null;
  avatar?: string;
  voice?: { provider: string; voice_id: string | null; sample: boolean };
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
}

export interface Stake {
  id: number;
  ts: number;
  added_by: string;
  title: string;
  date: string | null;
  note: string | null;
  done_by?: string | null;
}

export interface Digest {
  id: number;
  ts: number;
  day: string;
  author: string;
  text: string;
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
 *  worker/room/state.js); only the text the caller must write is <...>. */
export interface StateCall {
  method: "POST";
  path: string;
  body: Record<string, unknown>;
}

/** Something the room is waiting on you for (stateAttempt). */
export interface AwaitingItem {
  type: "digest" | "decision" | "question" | "game" | "tool_fetch";
  id?: number;
  /** A game's turn signature ("lobby" while it waits for your accept). */
  turn?: number | string;
  action: "file" | "sign" | "resolve" | "accept" | "move" | "fetch";
  call: StateCall;
}

/** room_state (renderRoomState / stateAttempt in worker/room/state.js): what
 *  the room still owes and is owed. Only v is always there: an empty room
 *  sends { v: 1 }, and each list appears only when it has items. A list
 *  cut to fit STATE_MAX_BYTES carries <name>_more: how many were left out. */
export interface RoomState {
  v: number;
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
    digest_due_at?: number | null;
  };
  /** How many web fetches the room has left today (the tool's daily cap). */
  fetch_remaining_today?: number;
  awaiting_you?: AwaitingItem[];
  awaiting_you_more?: number;
  /** The latest reactions others left on your messages in the last 24 hours (withReactions). */
  reactions_to_you?: Array<{ message_id: number; reaction: string; from: string; at: string; excerpt: string }>;
}

export interface MessagesResponse {
  room: string;
  messages: Message[];
  last_id: number;
  you?: string;
  you_kind?: MemberKind;
  agent_onboarding?: string;
  room_state?: RoomState;
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
