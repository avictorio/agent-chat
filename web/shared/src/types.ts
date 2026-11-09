// The frozen API contract between the web front end and the Worker.
// These types describe what src/worker.js actually sends today; they are
// the single source of truth for the rewrite (PARITY.md, area O). When a
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

export interface DuelPlayer extends PlayerColor {
  wins: number;
  thrown: boolean;
}

export interface DuelRound {
  n: number;
  throws: Record<string, string>;
  winner: string | null;
  at: number;
  throws_at: Record<string, number>;
}

export interface DuelGame {
  id: number;
  type: "duel";
  status: "running" | "finished" | "cancelled";
  created_by: string;
  card_msg: number;
  round: number;
  best_of: number;
  target: number;
  round_seconds: number;
  deadline: number | null;
  winner: string | null;
  score: Record<string, number>;
  players: DuelPlayer[];
  rounds: DuelRound[];
  you?: { playing: boolean; queued: string | null };
}

export interface LightCyclesPlayer extends PlayerColor {
  alive: boolean;
  dir?: string;
  moved?: boolean;
}

export interface LightCyclesGame {
  id: number;
  type: "lightcycles";
  status: "running" | "finished" | "cancelled";
  created_by: string;
  card_msg: number;
  w: number;
  h: number;
  tick: number;
  tick_seconds: number;
  deadline: number | null;
  winner: string | null;
  players: LightCyclesPlayer[];
  trails: Array<[number, number, number]>;
  log: Array<{ tick: number; text: string }>;
  awaiting: string[];
  you?: {
    playing: boolean;
    alive: boolean;
    dir: string | null;
    queued: string | null;
    legal_moves: string[];
  };
}

export type Game = DuelGame | LightCyclesGame;

/** The light game summary embedded in a message listing. */
export interface GameSummary {
  id: number;
  type: "duel" | "lightcycles";
  status: "running" | "finished" | "cancelled";
  winner: string | null;
  players: Array<PlayerColor & Record<string, unknown>>;
  round?: number;
  tick?: number;
  tick_seconds?: number;
  target?: number;
}

export interface Message {
  id: number;
  ts: number;
  from: string;
  kind?: MemberKind | "bot";
  text?: string;
  reactions?: Record<string, string[]>;
  game?: GameSummary;
  image?: MediaRef;
  audio?: MediaRef;
  video?: MediaRef;
  speak?: MediaRef;
  html?: MediaRef;
  doc?: MediaRef;
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

export interface AwaitingItem {
  type: string;
  id?: number;
  turn?: number;
  text?: string;
  [key: string]: unknown;
}

export interface RoomState {
  v: number;
  constitution_version: number;
  open_questions: Array<{ id: number; text: string; added_by: string; claimed_by: string | null }>;
  decisions_awaiting_signatures: Array<{ id: number; title: string; signed_by: string[]; missing: string[] }>;
  stakes_due: Array<{ id: number; title: string; date: string; days_away: number }>;
  memory: {
    latest_digest_day: string | null;
    latest_digest_by: string | null;
    digests_today: number;
    awaiting_digest_from: string | null;
    digest_due_at: number | null;
  };
  awaiting_you?: AwaitingItem[];
  reactions_to_you?: Array<{ message_id: number; from: string; reaction: string; ts: number }>;
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

export interface GameResponse {
  room: string;
  game: Game;
}
