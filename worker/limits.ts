// Room-wide limits and constants: sizes, caps, retention, upload bounds. Read by the Room, the routes, the API docs text and MCP.

export const MAX_TEXT = 8000;
// Games open in a lobby: play starts only when every invited player has
// accepted (a creator who is playing is in automatically). This is how
// long a lobby waits for its players before the match is called off.
export const LOBBY_DEFAULT_SECONDS = 3600;
// The longest dir a game move may carry: every legal move fits with room
// to spare (the longest, a Trivia question or Two Truths statements as
// JSON, is under a thousand). With no cap a member could send megabytes
// that one parser read in quadratic or cubic time, holding the whole room
// for seconds. Sketch & Guess raises it for its drawing (an engine's
// dirMax).
export const MOVE_DIR_MAX = 4000;

export const KEEP = 1000;
// How often an open stream gets a ": ping" comment. The web app's reader
// counts a stream silent for three of these as dead and one silent for
// more than one and a half as stale when the tab comes back into view
// (STALL_MS and WAKE_SILENCE in web/app/src/features/room/useRoomStream.ts,
// derived from this number by hand): change them together.
export const STREAM_PING_MS = 15000;
// A messages read without limit= returns this many (REST and MCP alike).
export const MESSAGES_PAGE = 50;
// The most message ids one read by id takes (GET /messages?ids=): a feed
// renewing the media links of the rows it holds asks for the due ones.
export const MESSAGES_IDS_MAX = 100;
export const ROOM_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
// Rooms that can't be deleted through the API, even with the owner key. Changing this takes a commit.
export const PROTECTED_ROOMS = ["henry-hank-order-up"];
export const MAX_CON = 4000;
export const CON_KEEP = 20;
export const MAX_Q = 500;
export const MAX_NOTE = 1000;
export const MAX_OPEN_Q = 50;
export const MAX_DIGEST = 8000;
export const DIGESTS_PER_DAY = 3;
export const KEEP_DIGESTS = 60;
export const MAX_STAKE = 300;
export const MAX_STAKES = 50;
export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const MAX_DECISIONS = 50;
export const MAX_SIGNERS = 100;

export const MEMBER_INVITES_PER_DAY = 5;
export const MAX_ACTIVE_INVITES = 50;
// Push subscriptions kept per member (browsers): every one
// costs a signed request on every message.
export const PUSH_MAX_PER_MEMBER = 10;
// Web push endpoints must belong to a real push service (Chrome/Edge/
// Samsung/Opera via FCM, Firefox autopush, Edge/Windows WNS, Safari/Apple),
// so a member cannot point the room's fan-out at arbitrary hosts.
export const PUSH_HOST_RE = /(^|\.)(fcm\.googleapis\.com|push\.services\.mozilla\.com|notify\.windows\.com|push\.apple\.com)$/;
// The longest subscription values a browser makes, with room to spare:
// endpoints run 200 to 700 characters, p256dh is 87 (65 bytes) and auth 22
// (16 bytes). With no maximum a member stored ten endpoints of megabytes
// each, and every post read them all into the room's memory. Subscribe
// refuses longer ones; a row an older room kept over them stays stored
// (nothing deletes stored data unasked) but the fan-out and push status
// never read it.
export const PUSH_ENDPOINT_MAX = 2048;
export const PUSH_P256DH_MAX = 96;
export const PUSH_AUTH_MAX = 64;
// A subscription whose sends have all failed, at least PUSH_FAIL_MAX times
// and for at least PUSH_FAIL_MS, rests: no send to it for PUSH_REST_MS,
// then one try, and another rest if that fails too. Before, a junk
// registration cost a send on every post forever (only a 404 or 410 ends
// one). It rests rather than being deleted because the failure can be
// ours - a broken signing key fails every send to every phone - and
// deleting would then wipe every member's registration for good; a
// resting one wakes on its first success, or when the browser subscribes
// again. Both conditions, so an hour's outage at one push service does
// not even rest anything.
export const PUSH_FAIL_MAX = 5;
export const PUSH_FAIL_MS = 86400000;
export const PUSH_REST_MS = 86400000;
// A post's fan-out: this many sends at a time (a Worker keeps six
// connections open at once), each given up after PUSH_SEND_MS. They used
// to go one after another with no timeout, so one push service that never
// answered held back every member after it. A fan-out has at most
// (MAX_ACTIVE_INVITES + 1) x PUSH_MAX_PER_MEMBER targets.
export const PUSH_PARALLEL = 6;
export const PUSH_SEND_MS = 10000;
export const AVATAR_MAX = 2000000;
// Media storage failures are all-or-nothing: an R2 failure fails the whole
// request with this message and leaves nothing behind - no message without
// its media, no index row without an object.
export const STORE_MSG = "Storage is unavailable right now. Nothing was saved; try again.";

export const VOICE_SAMPLE_MAX = 10000000; // voice samples up to 10 MB
export const AUDIO_MAX = 5000000;
export const IMAGE_MAX = 5000000;
export const VIDEO_MAX = 25000000;
export const VIDEO_MAX_HARD = 5000000000;
export const HTML_MAX = 2000000;
export const DOC_MAX = 1000000;
export const TICKET_TTL_MS = 900000; // upload tickets live 15 minutes
export const TICKET_MAX_PER_MEMBER = 20;
export const TICKET_MAX_TRIES = 5;
// The server-side part size when ingesting a streamed upload. Kept off a
// whole MiB on purpose: the engine's plans are always whole MiB, and a
// finish sent again tells an engine-finished file from a streamed one by
// it (upFinishNow, room/uploads.ts).
export const STREAM_PART = 10000000;
export const VIDEO_TYPES = ["video/mp4", "video/webm", "video/quicktime"];
// ---- The resumable upload engine ----
// Every attachment past its single-request cap - images, audio, video,
// and general files of any type - uploads one way: start pins a part
// plan, the client PUTs parts (any order, in parallel, any retry), the
// Worker streams each part's request body straight into an R2 multipart
// upload (no part is buffered in the Worker or ever enters the Room),
// and finish checks every part is in before it completes the object.
// All parts but the last are exactly part_size bytes (R2 needs equal
// parts), at least 8 MiB (R2's floor is 5 MiB) and at most 90 MiB, so a
// part always fits under the zone's 100 MB request-body cap. R2 takes
// 10,000 parts, which puts the ceiling through the Worker at 10,000 x
// 90 MiB, about 943 GB. An unfinished R2 multipart upload is dropped 7
// days after it starts (the bucket's default abort rule), so a session
// lasts that long too.
export const MIB = 1048576;
/** The largest body taken from a request that carries no file and no
 *  credential the Worker trusts yet: an upload link's steps, public room
 *  creation, and MCP for a caller without a good token. Their real bodies
 *  are a few hundred bytes; with no cap they were read whole, whatever
 *  their size, before anything was checked. */
export const SMALL_BODY_MAX = MIB;
/** The largest body read whole before a member's request is routed (lib/http.ts settleBody). The largest a route takes that way is a 25 MB video as base64 JSON, about 34 MB; bigger files go in parts. */
export const SETTLED_BODY_MAX = 48 * MIB;
export const UP_KINDS = ["image", "audio", "video", "file"];
export const UP_PART_MIN = 8 * MIB;
export const UP_PART_MAX = 90 * MIB;
export const UP_MAX_PARTS = 10000;
export const UP_TARGET_PARTS = 2000;
export const UP_MAX = UP_MAX_PARTS * UP_PART_MAX;
export const UP_MAX_TEXT = Math.floor(UP_MAX / 1e9) + " GB";
export const UP_SESSION_MS = 7 * 86400000;
// Direct uploads: parts straight to R2. With an R2 API credential (the
// R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY Worker secrets, plus the
// R2_ACCOUNT_ID and R2_BUCKET vars) and the switch on (R2_DIRECT = "1"), a
// client that asks for it gets presigned addresses and sends each part to
// R2 itself. No request cap stands in the way, so parts run up to 512 MiB
// (more only to stay within 10,000) and an upload up to R2's own multipart
// ceiling (4.995 TiB; 4.99 TiB here). The Worker only signs, and reads
// storage's own list of parts (S3 ListParts) for status and finish.
export const UP_DIRECT_PART_MAX = 512 * MIB;
export const UP_MAX_DIRECT = Math.floor(4.99 * 1024 * 1024 * 1024 * 1024);
export const UP_MAX_DIRECT_TEXT = (Math.floor(UP_MAX_DIRECT / 1e11) / 10) + " TB";
export const UP_SIGN_TTL = 3600;
export const UP_SIGN_MAX = 100;

// Reactions: any single emoji; these names are accepted as shortcuts for the six quick ones.
export const REACTION_ALIASES = { like: "👍", love: "❤️", haha: "😂", wow: "😮", sad: "😢", angry: "😡" };
// Emoji list for the web picker: built once from this pinned dataset (iamcal/emoji-data, MIT) and kept in KV.
export const EMOJI_SOURCE = "https://raw.githubusercontent.com/iamcal/emoji-data/e77759c296ed37beb0dbd63908b43d8619509c6d/emoji.json";
export const EMOJI_KV_KEY = "asset:emoji-e77759c.json";

export const STATE_ITEMS = 3;
export const STATE_MAX_BYTES = 1200;
export const STATE_STAKE_DAYS = 7;
// Limits on text length, names per list and items per section, tried in order until the block fits.
// The last limit is for awaiting_you: its calls are given up only after everything else has shrunk.
export const STATE_STEPS = [[120, 100, STATE_ITEMS, STATE_ITEMS], [80, 100, STATE_ITEMS, STATE_ITEMS], [50, 100, STATE_ITEMS, STATE_ITEMS], [30, 100, STATE_ITEMS, STATE_ITEMS], [30, 8, STATE_ITEMS, STATE_ITEMS], [30, 4, STATE_ITEMS, STATE_ITEMS], [30, 2, STATE_ITEMS, STATE_ITEMS], [30, 2, 2, STATE_ITEMS], [30, 2, 1, STATE_ITEMS], [30, 0, 0, STATE_ITEMS], [30, 0, 0, 2], [30, 0, 0, 1], [30, 0, 0, 0]];

// The digest window closes at this UTC hour every day: midnight or 1 AM in Los Angeles, the room's night
// either way. Only the awaiting fields follow it; digests_today and the daily cap stay on the UTC calendar.
export const DIGEST_CLOSE_HOUR = 8;

export const FETCH_DAILY_CAP = 50;

// Each clone is a paid call: members get VOICE_CLONES_PER_DAY a day (the
// owner is not capped), counted in the room's own storage (cloneTake), so
// clones sent together cannot pass it.
export const VOICE_CLONES_PER_DAY = 5;

// A clone Cartesia did not confirm deleted is kept as a pending delete in
// its room (cfg 'voice-del:<id>', room/voices.ts) and tried again: up to
// CLONE_DELETE_RETRY of them each time a voice route of that room runs
// with the key set, and up to CLONE_DELETE_ON_ROOM_DELETE when the room
// is deleted. Bounded so one call never waits on a long list.
export const CLONE_DELETE_RETRY = 3;
export const CLONE_DELETE_ON_ROOM_DELETE = 50;

// Public room creation (POST /api/create-room): rooms per UTC day, site-wide,
// per email address and per IP.
export const CREATE_ROOMS_PER_DAY = 30;
export const CREATE_ROOMS_PER_EMAIL = 3;
export const CREATE_ROOMS_PER_IP = 5;

/** A byte size as the texts quote it: "5 MB". */
export function mb(bytes: number) {
  return bytes / 1e6 + " MB";
}

const MEDIA_CAP = { image: ["Images", IMAGE_MAX], audio: ["Audio clips", AUDIO_MAX], video: ["Videos", VIDEO_MAX] } as const;

/** The refusal for an image, clip or video too big for a one-request route
 *  (inline in a post, or a single-shot upload ticket). Those caps protect the
 *  Worker's memory; as an upload the same file can be up to UP_MAX_DIRECT_TEXT,
 *  so the sentence says how to send it. */
export function mediaTooBig(kind: keyof typeof MEDIA_CAP, route: "inline" | "single-shot"): string {
  const [what, max] = MEDIA_CAP[kind];
  return route === "inline"
    ? what + " sent inline can be up to " + mb(max) + ". Send a larger one as an upload (begin_upload over MCP, or POST /api/rooms/ROOM/messages/ID/" + kind + "/start), up to " + UP_MAX_DIRECT_TEXT + "."
    : "A single-shot " + kind + " upload can be up to " + mb(max) + ". For a larger one, call begin_upload with its size (up to " + UP_MAX_DIRECT_TEXT + ").";
}

/** The refusal for a page the room renders (HTML or Markdown) over its cap;
 *  a bigger file can still go up as a plain file. */
export function pageTooBig(what: "HTML pages" | "Documents", max: number): string {
  return what + " can be up to " + mb(max) + "; a bigger one can go up as a file upload (KIND file).";
}

/** The refusal for a video streamed through the Worker over its cap. */
export const VIDEO_STREAM_TOO_BIG = "Videos streamed through the site can be up to " + VIDEO_MAX_HARD / 1e9 + " GB. Send a larger one as an upload (POST /api/rooms/ROOM/messages/ID/video/start), up to " + UP_MAX_DIRECT_TEXT + ".";

