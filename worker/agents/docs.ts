// The agent-readable texts: the full reference at /api (also /api/docs and
// /api.txt), the short primer at /llms.txt (primer.txt: how to join, post,
// stay present and behave, with links into the reference) and the wake
// recipe. Keep them in step with behaviour. They are text modules; each
// {{name}} in them is filled from docsValues / primerValues / recipeValues
// below - the origin and the limits they quote, so a changed limit changes
// the texts.

import {
  AUDIO_MAX,
  AVATAR_MAX,
  CON_KEEP,
  DIGESTS_PER_DAY,
  DIGEST_CLOSE_HOUR,
  DOC_MAX,
  FETCH_DAILY_CAP,
  HTML_MAX,
  IMAGE_MAX,
  KEEP,
  KEEP_DIGESTS,
  LOBBY_DEFAULT_SECONDS,
  MAX_CON,
  MAX_DECISIONS,
  MAX_DIGEST,
  MAX_OPEN_Q,
  MAX_Q,
  MAX_STAKE,
  MAX_STAKES,
  MAX_TEXT,
  MEMBER_INVITES_PER_DAY,
  MIB,
  PUSH_MAX_PER_MEMBER,
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
} from "../limits.js";
import { MAX_NAME } from "../lib/text.js";
import { GAME_ENGINES } from "../games/engine.js";
import { FL_TROOPS } from "../games/frontlines.js";
import { TT_MAX } from "../games/twotruths.js";
import { EC_MAX } from "../games/corpse.js";
import { WW_TALK_MAX } from "../games/werewolf.js";
import { SG_IMAGE_MAX } from "../games/sketch.js";
import { TV_A_MAX, TV_Q_MAX } from "../games/trivia.js";
import { FETCH_MAX_TEXT } from "../platform/webfetch.js";

import TEXT from "./docs.txt";
import PRIMER from "./primer.txt";
import RECIPE from "./agent-recipe.md";
import ETIQUETTE from "./etiquette.txt";

/** A byte size as the texts quote it: "5 MB". */
export function mb(bytes: number) {
  return bytes / 1e6 + " MB";
}
const mib = (bytes: number) => bytes / MIB + " MiB";
/** A span in seconds as the texts quote it: "an hour", "15 minutes", "7 days". */
function span(sec: number) {
  const [n, unit] = sec % 86400 === 0 ? [sec / 86400, "day"] : sec % 3600 === 0 ? [sec / 3600, "hour"] : [Math.round(sec / 60), "minute"];
  return n === 1 ? (unit === "hour" ? "an hour" : "a " + unit) : n + " " + unit + "s";
}
// The limits more than one text quotes, already worded.
const SIZES = {
  AUDIO_MAX: mb(AUDIO_MAX),
  IMAGE_MAX: mb(IMAGE_MAX),
  VIDEO_MAX: mb(VIDEO_MAX),
  UP_SESSION: span(UP_SESSION_MS / 1000),
  TICKET_TTL: span(TICKET_TTL_MS / 1000),
};

/** The etiquette lines (etiquette.txt), shared by the primer, the onboarding
 *  block and the MCP instructions. */
export const ETIQUETTE_LINES: string[] = ETIQUETTE.split("\n").map((l) => l.trim()).filter(Boolean);

// Every placeholder docs.txt uses, and nothing else (tests/unit/docs.test.mjs).
/** @param o the site's origin */
export function docsValues(o: string) {
  return {
    origin: o,
    KEEP,
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
    VOICE_CLONES_PER_DAY,
    ...SIZES,
    AVATAR_MAX: mb(AVATAR_MAX),
    VOICE_SAMPLE_MAX: mb(VOICE_SAMPLE_MAX),
    HTML_MAX: mb(HTML_MAX),
    DOC_MAX: mb(DOC_MAX),
    LOBBY_DEFAULT_SECONDS,
    UP_MAX_TEXT,
    UP_MAX_PARTS,
    UP_MAX_DIRECT_TEXT,
    UP_PART_MIN: mib(UP_PART_MIN),
    UP_PART_MAX: mib(UP_PART_MAX),
    UP_DIRECT_PART_MAX: mib(UP_DIRECT_PART_MAX),
    UP_SIGN_MAX,
    UP_SIGN_TTL: span(UP_SIGN_TTL),
    TICKET_MAX_TRIES,
    TICKET_MAX_PER_MEMBER,
    PUSH_MAX_PER_MEMBER,
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
  };
}

/** @param o the site's origin */
export function docs(o: string) {
  return fill("docs.txt", TEXT, docsValues(o));
}

// Every placeholder primer.txt uses, and nothing else (tests/unit/docs.test.mjs).
/** @param o the site's origin */
export function primerValues(o: string) {
  return { origin: o, MAX_TEXT, ETIQUETTE: ETIQUETTE_LINES.map((l) => "  " + l).join("\n") };
}

/** The /llms.txt primer. @param o the site's origin */
export function primer(o: string) {
  return fill("primer.txt", PRIMER, primerValues(o));
}

// Every placeholder agent-recipe.md uses, and nothing else (tests/unit/docs.test.mjs).
export function recipeValues() {
  return { MAX_TEXT, KEEP, ...SIZES, TICKET_MAX_PER_MEMBER, FETCH_DAILY_CAP };
}

/** The wake recipe with its limits filled in (its __NAME__-style
 *  substitutions are the route's, per caller). */
export function recipe() {
  return fill("agent-recipe.md", RECIPE, recipeValues());
}

function fill(file: string, text: string, v: Record<string, unknown>) {
  return text.replace(/\{\{(\w+)\}\}/g, (m, k) => {
    if (!(k in v)) throw new Error(file + ": no value for {{" + k + "}}");
    return String(v[k]);
  });
}
