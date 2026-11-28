// The agent-readable texts: the full reference at /api (also /api/docs and
// /api.txt), the site guide at /llms.txt (primer.txt, in the llms.txt form:
// where an invited agent starts, the house rules, links into the
// reference), the wake recipe and the watcher script it installs. Keep
// them in step with behaviour. They are text modules; each {{name}} in the
// texts is filled from docsValues / primerValues / recipeValues below - the
// origin and the limits they quote, so a changed limit changes the texts.
// The watcher script holds no {{name}}: watcher() fills its one __ORIGIN__.

import {
  AGENT_GLANCE_GAP_S,
  AGENT_KEYS_PER_DAY,
  AGENT_KEYS_PER_IP,
  AGENT_KEYS_PER_ROOM_DAY,
  AGENT_KEYS_WINDOW_S,
  AGENT_ROOMS_MAX,
  AGENT_WAKE_SET_MS,
  AGENT_WAKE_SKEW_MS,
  AUDIO_MAX,
  AVATAR_MAX,
  CON_KEEP,
  CREATE_ROOMS_PER_DAY,
  CREATE_ROOMS_PER_EMAIL,
  CREATE_ROOMS_PER_IP,
  DIGEST_CLOSE_HOUR,
  DIGESTS_PER_DAY,
  DOC_MAX,
  GENESIS_PENDING_MS,
  FETCH_DAILY_CAP,
  FETCH_URL_MAX,
  HTML_MAX,
  IMAGE_MAX,
  KEEP,
  KEEP_DIGESTS,
  LOBBY_DEFAULT_SECONDS,
  MOVE_DIR_MAX,
  MAX_CON,
  MAX_DECISIONS,
  MAX_DIGEST,
  MAX_OPEN_Q,
  MAX_Q,
  MAX_STAKE,
  MAX_STAKES,
  INLINE_TOTAL_MAX,
  CLIENT_MSG_ID_KEEP,
  CLIENT_MSG_ID_MAX,
  CLIENT_MSG_ID_MS,
  MAX_ACTIVE_INVITES,
  MAX_TEXT,
  mb,
  span,
  MEMBER_INVITES_PER_DAY,
  MESSAGES_IDS_MAX,
  MESSAGES_PAGE,
  MIB,
  MUSE_LINK_CODE_TTL_S,
  POLL_GAP_S,
  pollGap,
  spanS,
  PUSH_AUTH_MAX,
  PUSH_ENDPOINT_MAX,
  PUSH_FAIL_MS,
  PUSH_MAX_PER_MEMBER,
  PUSH_REST_MS,
  SMALL_BODY_MAX,
  MUSE_BATCH_MAX,
  MUSE_GRACE_MS,
  MUSE_PER_WAKE,
  OAUTH_IDLE_DAYS,
  OAUTH_ACCESS_TTL_S,
  WEBHOOK_FETCH_MS,
  WEBHOOK_MIN_GAP_MS,
  WEBHOOK_REGISTER_MAX,
  WEBHOOK_REGISTER_WINDOW_S,
  WEBHOOK_TOLERANCE_S,
  STATE_ITEMS,
  STATE_MAX_BYTES,
  STATE_STAKE_DAYS,
  TICKET_MAX_PER_MEMBER,
  TICKET_MAX_TRIES,
  TICKET_TTL_MS,
  UP_DIRECT_PART_MAX,
  UP_MAX_DIRECT_TEXT,
  UP_MAX_PARTS,
  UP_MAX_TEXT,
  UP_PART_MAX,
  UP_PART_MIN,
  UP_SESSION_MS,
  UP_SIGN_MAX,
  UP_SIGN_TTL,
  VIDEO_MAX,
  VOICE_CLONES_PER_DAY,
  VOICE_SAMPLE_MAX,
  STREAM_PING_MS,
  WAIT_MAX_S,
} from "../limits.js";
import { MAX_NAME, shellQuote } from "../lib/text.js";
import { sha256hex } from "../lib/crypto.js";
import { MCP_MODERN_VERSIONS, MCP_PROTOCOL_VERSIONS } from "./mcp.js";
import { GAME_ENGINES } from "../games/engine.js";
import { FL_TROOPS } from "../games/frontlines.js";
import { TT_MAX } from "../games/twotruths.js";
import { EC_MAX } from "../games/corpse.js";
import { WW_TALK_MAX } from "../games/werewolf.js";
import { SG_IMAGE_MAX } from "../games/sketch.js";
import { TV_A_MAX, TV_Q_MAX } from "../games/trivia.js";
import { FETCH_MAX_TEXT } from "../platform/webfetch.js";

import TEXT from "./docs.txt";
import GAMES_TEXT from "./games.txt";
import PRIMER from "./primer.txt";
import RECIPE from "./agent-recipe.md";
import WATCHER from "./agent-watch.sh";
import ETIQUETTE from "./etiquette.txt";

const mib = (bytes: number) => bytes / MIB + " MiB";
// The limits more than one text quotes, already worded.
const SIZES = {
  AUDIO_MAX: mb(AUDIO_MAX),
  IMAGE_MAX: mb(IMAGE_MAX),
  VIDEO_MAX: mb(VIDEO_MAX),
  UP_SESSION: span(UP_SESSION_MS / 1000),
  TICKET_TTL: span(TICKET_TTL_MS / 1000),
};

/** The etiquette lines (etiquette.txt), shared by /llms.txt's house rules. */
export const ETIQUETTE_LINES: string[] = ETIQUETTE.split("\n").map((l) => l.trim()).filter(Boolean);

// Every placeholder docs.txt and games.txt use, and nothing else
// (tests/unit/docs.test.mjs).
/** @param o the site's origin */
export function docsValues(o: string) {
  return {
    origin: o,
    KEEP,
    CREATE_ROOMS_PER_DAY,
    CREATE_ROOMS_PER_EMAIL,
    CREATE_ROOMS_PER_IP,
    GENESIS_PENDING_MIN: GENESIS_PENDING_MS / 60000,
    STREAM_PING_S: STREAM_PING_MS / 1000,
    MESSAGES_PAGE,
    MESSAGES_IDS_MAX,
    WAIT_MAX_S,
    POLL_GAP: pollGap(POLL_GAP_S),
    MAX_NAME,
    MAX_TEXT,
    GAMES: Object.keys(GAME_ENGINES).join(", "),
    FL_TROOPS,
    TT_MAX,
    EC_MAX,
    WW_TALK_MAX,
    SG_IMAGE_KB: Math.round(SG_IMAGE_MAX / 1000),
    TV_Q_MAX,
    TV_A_MAX,
    MEMBER_INVITES_PER_DAY,
    MAX_ACTIVE_INVITES,
    VOICE_CLONES_PER_DAY,
    ...SIZES,
    AVATAR_MAX: mb(AVATAR_MAX),
    VOICE_SAMPLE_MAX: mb(VOICE_SAMPLE_MAX),
    HTML_MAX: mb(HTML_MAX),
    INLINE_TOTAL_MAX: mb(INLINE_TOTAL_MAX),
    CLIENT_MSG_ID_MAX,
    CLIENT_MSG_ID_KEEP,
    CLIENT_MSG_ID_KEEP_FOR: span(CLIENT_MSG_ID_MS / 1000),
    DOC_MAX: mb(DOC_MAX),
    LOBBY_DEFAULT_SECONDS,
    MOVE_DIR_MAX,
    UP_MAX_TEXT,
    UP_MAX_PARTS,
    UP_MAX_DIRECT_TEXT,
    UP_PART_MIN: mib(UP_PART_MIN),
    UP_PART_MAX: mib(UP_PART_MAX),
    UP_DIRECT_PART_MAX: mib(UP_DIRECT_PART_MAX),
    SMALL_BODY_MAX: mib(SMALL_BODY_MAX),
    MUSE_BATCH_MAX: String(MUSE_BATCH_MAX),
    MUSE_GRACE_MS: String(MUSE_GRACE_MS),
    MUSE_PER_WAKE: String(MUSE_PER_WAKE),
    OAUTH_IDLE_DAYS: String(OAUTH_IDLE_DAYS),
    OAUTH_ACCESS_TTL: spanS(OAUTH_ACCESS_TTL_S),
    // spanS, as the start page says it (agents/start.ts)
    MUSE_LINK_CODE_TTL: spanS(MUSE_LINK_CODE_TTL_S),
    // the revisions MCP initialize answers, and the one an unknown version gets
    MCP_VERSIONS: MCP_PROTOCOL_VERSIONS.slice(0, -1).join(", ") + " or " + MCP_PROTOCOL_VERSIONS[MCP_PROTOCOL_VERSIONS.length - 1],
    MCP_LATEST: MCP_PROTOCOL_VERSIONS[0],
    // the revisions without initialize the endpoint speaks (server/discover's list)
    MCP_MODERN: MCP_MODERN_VERSIONS.join(" and "),
    WEBHOOK_FETCH: WEBHOOK_FETCH_MS / 1000 + " seconds",
    WEBHOOK_MIN_GAP: WEBHOOK_MIN_GAP_MS / 1000 + " seconds",
    WEBHOOK_REGISTER_MAX: String(WEBHOOK_REGISTER_MAX),
    WEBHOOK_REGISTER_WINDOW: span(WEBHOOK_REGISTER_WINDOW_S),
    WEBHOOK_TOLERANCE: span(WEBHOOK_TOLERANCE_S),
    WEBHOOK_TOLERANCE_S: String(WEBHOOK_TOLERANCE_S),
    UP_SIGN_MAX,
    UP_SIGN_TTL: span(UP_SIGN_TTL),
    TICKET_MAX_TRIES,
    TICKET_MAX_PER_MEMBER,
    PUSH_MAX_PER_MEMBER,
    PUSH_ENDPOINT_MAX,
    PUSH_AUTH_MAX,
    PUSH_FAIL: span(PUSH_FAIL_MS / 1000),
    PUSH_REST: span(PUSH_REST_MS / 1000),
    CON_KEEP,
    MAX_CON,
    MAX_Q,
    MAX_OPEN_Q,
    KEEP_DIGESTS,
    MAX_DIGEST,
    DIGESTS_PER_DAY,
    MAX_STAKE,
    MAX_STAKES,
    MAX_DECISIONS,
    STATE_STAKE_DAYS,
    DIGEST_CLOSE_HOUR,
    STATE_ITEMS,
    STATE_MAX_BYTES,
    FETCH_MAX_TEXT,
    FETCH_DAILY_CAP,
    FETCH_URL_MAX,
    // the agent keys (AGENT KEYS)
    AGENT_ROOMS_MAX,
    AGENT_KEYS_PER_IP,
    AGENT_KEYS_WINDOW: span(AGENT_KEYS_WINDOW_S),
    AGENT_KEYS_PER_DAY,
    AGENT_KEYS_PER_ROOM_DAY,
    AGENT_GLANCE_GAP_S,
    AGENT_WAKE_SET: span(AGENT_WAKE_SET_MS / 1000),
    AGENT_WAKE_SKEW: span(AGENT_WAKE_SKEW_MS / 1000),
  };
}

// The filled texts, kept per origin: they depend only on constants and the
// origin, and /api is about 70 KB to fill. The map stays tiny (one live
// origin, plus a local one under wrangler dev); the cap is a backstop.
const filled = new Map<string, string>();
function once(key: string, make: () => string) {
  let v = filled.get(key);
  if (v === undefined) {
    if (filled.size > 16) filled.clear();
    v = make();
    filled.set(key, v);
  }
  return v;
}

/** @param o the site's origin */
export function docs(o: string) {
  return once("docs " + o, () => fill("docs.txt", TEXT, docsValues(o)));
}

/** The game reference (/api/games): one section per game, split out of
 *  /api so the page an agent reads to start is half the size.
 *  @param o the site's origin */
export function gamesDocs(o: string) {
  return once("games " + o, () => fill("games.txt", GAMES_TEXT, docsValues(o)));
}

// Every placeholder primer.txt uses, and nothing else (tests/unit/docs.test.mjs).
/** @param o the site's origin */
export function primerValues(o: string) {
  // the house rules are a Markdown list: the lines unindented
  return { origin: o, ETIQUETTE: ETIQUETTE_LINES.join("\n") };
}

/** /llms.txt, the site guide. @param o the site's origin */
export function primer(o: string) {
  return once("primer " + o, () => fill("primer.txt", PRIMER, primerValues(o)));
}

// Every placeholder agent-recipe.md uses, and nothing else (tests/unit/docs.test.mjs).
export function recipeValues() {
  return { MAX_TEXT, KEEP, ...SIZES, TICKET_MAX_PER_MEMBER, FETCH_DAILY_CAP };
}

/** The wake recipe with its limits filled in (its __NAME__-style
 *  substitutions are the route's, per caller). */
export function recipe() {
  return once("recipe", () => fill("agent-recipe.md", RECIPE, recipeValues()));
}

/** The watcher's version: the value of the script's own WATCHER_VERSION
 *  line, the one place it is written (empty if the line is gone, which
 *  tests/unit/shell.test.mjs refuses). */
export const WATCHER_VERSION = (/^WATCHER_VERSION="([^"\n]+)"$/m.exec(WATCHER) || ["", ""])[1];

// The hosts a watcher may call over plain http: a local test server's.
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
/** The origin a watcher served at o calls: https on its default port for
 *  every host but loopback, so a copy fetched over http, or through
 *  another port, never sends a token in cleartext from then on; a
 *  loopback origin (a local test server) as it is. */
export function watcherOrigin(o: string) {
  const u = new URL(o);
  return LOOPBACK.has(u.hostname) ? u.origin : "https://" + u.hostname;
}

/** The watcher script as served at origin o: one file, the same bytes for
 *  every caller there, whatever the room or the member. ORIGIN is its only
 *  filled value (watcherOrigin), as a single-quoted shell word (the script
 *  talks only to this site). The route and watcherPin both read it here,
 *  so the hash printed is the hash of what is served. @param o the site's
 *  origin */
export function watcher(o: string) {
  return once("watcher " + o, () => WATCHER.replace("__ORIGIN__", () => shellQuote(watcherOrigin(o))));
}

/** What identifies the watcher an origin serves: its version and the
 *  SHA-256 (hex) of its bytes. The script route sends both as headers, and
 *  the start page and the recipe print them. */
export type WatcherPin = { version: string, sha256: string };
// Kept per origin, as the filled texts are: the digest is async, so each
// origin's is a promise, made once and shared by the requests that wait on it.
const pins = new Map<string, Promise<WatcherPin>>();
/** watcher(o)'s version and SHA-256, computed once per origin. @param o the site's origin */
export function watcherPin(o: string): Promise<WatcherPin> {
  const kept = pins.get(o);
  if (kept) return kept;
  if (pins.size > 16) pins.clear();
  const made = sha256hex(watcher(o)).then((sha256) => ({ version: WATCHER_VERSION, sha256 }));
  // a digest that failed is not kept: the next request tries again
  made.catch(() => { if (pins.get(o) === made) pins.delete(o); });
  pins.set(o, made);
  return made;
}

function fill(file: string, text: string, v: Record<string, unknown>) {
  return text.replace(/\{\{(\w+)\}\}/g, (m, k) => {
    if (!(k in v)) throw new Error(file + ": no value for {{" + k + "}}");
    return String(v[k]);
  });
}
