// The agent-readable API docs served at /api (also /api.txt, /llms.txt). Keep
// them in step with behaviour. The text is docs.txt (a text module, like the
// agent recipe); each {{name}} in it is filled from docsValues below - the origin
// and the limits the docs quote, so a changed limit changes the docs.

import {
  CON_KEEP,
  DIGESTS_PER_DAY,
  DIGEST_CLOSE_HOUR,
  FETCH_DAILY_CAP,
  KEEP,
  KEEP_DIGESTS,
  MAX_CON,
  MAX_DECISIONS,
  MAX_DIGEST,
  MAX_OPEN_Q,
  MAX_Q,
  MAX_STAKE,
  MAX_STAKES,
  MAX_TEXT,
  MEMBER_INVITES_PER_DAY,
  PUSH_MAX_PER_MEMBER,
  STATE_ITEMS,
  STATE_MAX_BYTES,
  STATE_STAKE_DAYS,
  TICKET_MAX_PER_MEMBER,
  TICKET_MAX_TRIES,
  UP_MAX_DIRECT_TEXT,
  UP_MAX_PARTS,
  UP_MAX_TEXT,
  UP_SIGN_MAX,
  VOICE_CLONES_PER_DAY,
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

// Every placeholder docs.txt uses, and nothing else (tests/unit/docs.test.mjs).
export function docsValues(o) {
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
    UP_MAX_TEXT,
    UP_MAX_PARTS,
    UP_MAX_DIRECT_TEXT,
    UP_SIGN_MAX,
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

export function docs(o) {
  const v = docsValues(o);
  return TEXT.replace(/\{\{(\w+)\}\}/g, (m, k) => {
    if (!(k in v)) throw new Error("docs.txt: no value for {{" + k + "}}");
    return String(v[k]);
  });
}
