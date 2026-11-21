// room_state: what a room still owes and is owed, rendered for readers and the stream.

import {
  DIGEST_CLOSE_HOUR,
  FETCH_DAILY_CAP,
  STATE_MAX_BYTES,
  STATE_STAKE_DAYS,
  STATE_STEPS,
} from "../limits.js";
import { gameEngine } from "../games/engine.js";
import { capped, clipText, daysBetween } from "../lib/text.js";
import { fetchTarget } from "../platform/webfetch.js";
import { withReactions } from "../lib/reactions.js";

/** @typedef {import("@chat/contract").RoomState} RoomState */
/** @typedef {import("./Room.js").InvRow} InvRow */
/** @typedef {import("./Room.js").CountRow} CountRow */
/** A reaction left in the last day, with the message it is on (its
 *  sender and the start of its text): room_state's reactions_to_you.
 *  @typedef {{ msg: number, emoji: string, who: string, ts: number, to: string, excerpt: string }} ReactionToRow */
/** A live match as room_state sees it (an engine's stateItem): each
 *  player alive / moved / accepted, plus the game's own turn and phase
 *  fields (turn, round, tick, phase, artist, ...), which only that game's
 *  turnOf and moveHint read.
 *  @typedef {{ id: number, type: string, status: string, players: Array<{ name: string, alive: boolean, moved: boolean, accepted: boolean }>, [field: string]: any }} GameStateItem */
/** Everything room_state is rendered from, read fresh (stateData).
 *  @typedef {{
 *    members: string[],
 *    humans: string[],
 *    constitution: number | null,
 *    questions: Array<Pick<import("./Room.js").OqRow, "id" | "text" | "added_by" | "claimed_by">>,
 *    decisions: Array<{ id: number, title: string, signed_by: string[], missing: string[] }>,
 *    stakes: Array<{ id: number, title: string, date: string, days_away: number }>,
 *    digest: Pick<import("./Room.js").DgRow, "day" | "author"> | null,
 *    digests_today: number,
 *    awaiting_digest: string | null | undefined,
 *    digest_due_at: string,
 *    fetches_used: number,
 *    recent: Array<Pick<import("./Room.js").MsgRow, "id" | "sender" | "text">>,
 *    fetched: string[],
 *    rx: ReactionToRow[],
 *    games: GameStateItem[],
 *  }} StateData */

// Stream subscriptions: a client may narrow its feed with the events= set
// (message, reaction, game, members - the wire event names) and, for game
// frames, a game= id list. Absent params mean everything, and everything
// stays the default: on a stream, extra frames are visible noise a client
// can filter, while missing frames are silent starvation.
// The state event is the one exception: room_state no longer rides inside
// message frames (2026-11-11, the owner's call - it dwarfed the messages it
// rode on, identical bytes repeated per frame, and the agent watcher
// deleted it on arrival). It is its own event type, sent only to clients
// that name state in events= explicitly - "all" does not include it - and
// only when the rendered block actually changes for that client.
/**
 * @param {Pick<import("./Room.js").StreamClient, "kinds" | "games">} client
 * @param {string} kind
 * @param {number} [gameId]
 */
export function streamWants(client, kind, gameId) {
  if (client.kinds && !client.kinds.has(kind)) return false;
  if (kind === "game" && client.games && !client.games.has(/** @type {number} */ (gameId))) return false; // a game frame names its match
  return true;
}

/**
 * @param {string | null} room
 * @param {RoomState} state
 */
export function stateFrame(room, state) {
  return "event: state\ndata: " + JSON.stringify({ type: "state", room: room, from: null, kind: null, targets: [], room_state: state }) + "\n\n";
}

/** @param {number} now */
export function nextDigestClose(now) {
  const close = new Date(now).setUTCHours(DIGEST_CLOSE_HOUR, 0, 0, 0);
  return close > now ? close : close + 86400e3;
}

// The digest rotation is active agent members who have posted, in alphabetical order. People are
// never named: digests are agents' work. An invite with no kind counts as an agent, as it does on messages.
// The expected author follows the latest digest's author, wrapping; otherwise it's the first member.
/**
 * @param {Array<Pick<InvRow, "name" | "revoked" | "used" | "posted" | "kind">>} inv
 * @param {{ author: string } | null} digest the latest digest
 */
export function expectedDigestAuthor(inv, digest) {
  const rotation = inv.filter((r) => r.used && r.posted && !r.revoked && r.kind !== "human").map((r) => r.name);
  rotation.sort((a, b) => { const x = a.toLowerCase(), y = b.toLowerCase(); return x < y ? -1 : (x > y ? 1 : 0); });
  if (!rotation.length) return null;
  const last = digest ? rotation.findIndex((n) => n.toLowerCase() === digest.author.toLowerCase()) : -1;
  return rotation[last < 0 ? 0 : (last + 1) % rotation.length];
}

// The complete request that clears an awaiting_you item. Only text the caller must write is left as <...>.
/**
 * @param {string} room
 * @param {string} kind
 * @param {Record<string, unknown>} body
 * @returns {import("@chat/contract").StateCall}
 */
export function stateCall(room, kind, body) {
  return { method: "POST", path: "/api/rooms/" + room + "/" + kind, body: body };
}

/**
 * One rendering of room_state, its lists cut to the caps given.
 * @param {StateData} d
 * @param {string | null | undefined} who
 * @param {string} room
 * @param {number} textCap
 * @param {number} nameCap
 * @param {number} itemCap
 * @param {number} youCap
 */
export function stateAttempt(d, who, room, textCap, nameCap, itemCap, youCap) {
  /** @type {import("@chat/contract").RoomState} */
  const s = { v: 1 };
  const me = String(who || "").toLowerCase();
  if (me) {
    const lc = (/** @type {string[]} */ list) => list.map((n) => n.toLowerCase());
    const unsigned = d.decisions.filter((x) => (d.members.length ? lc(x.missing).indexOf(me) >= 0 : lc(x.signed_by).indexOf(me) < 0));
    // The invite's own spelling when the caller is a member.
    const name = d.members.find((n) => n.toLowerCase() === me) || String(who);
    /** @type {import("@chat/contract").AwaitingItem[]} */
    const mine = [];
    // The digest comes first: it's the one item with a deadline.
    if (d.awaiting_digest && d.awaiting_digest.toLowerCase() === me) mine.push({ type: "digest", action: "file", call: stateCall(room, "digests", { from: name, text: "<your digest of the day>" }) });
    for (const id of unsigned.map((x) => x.id).sort((a, b) => a - b)) mine.push({ type: "decision", id: id, action: "sign", call: stateCall(room, "decisions/" + id, { from: name, action: "sign" }) });
    for (const q of d.questions) if (q.claimed_by && q.claimed_by.toLowerCase() === me) mine.push({ type: "question", id: q.id, action: "resolve", call: stateCall(room, "questions/" + q.id, { from: name, action: "resolve", note: "<how it was resolved>" }) });
    for (const gm of gamesLobby(d, me)) mine.push({ type: "game", id: gm.id, turn: "lobby", action: "accept", call: stateCall(room, "games/" + gm.id + "/accept", { from: name }) });
    // the turn signature and the move placeholder come from the game's engine
    for (const gm of gamesAwaiting(d, me)) { const eng = gameEngine(gm); mine.push({ type: "game", id: gm.id, turn: eng.turnOf(gm), action: "move", call: stateCall(room, "games/" + gm.id + "/moves", { from: name, dir: eng.moveHint(gm, name) }) }); }
    // The tool nudge comes last: it never crowds out a digest, a signature or a claimed question.
    const nudge = findToolNudge(d, me);
    if (nudge) mine.push({ type: "tool_fetch", id: nudge.id, action: "fetch", call: stateCall(room, "tools/fetch", { from: name, url: nudge.url, post: true }) });
    if (mine.length) capped(s, "awaiting_you", mine, youCap);
  }
  if (d.constitution) s.constitution_version = d.constitution;
  if (d.questions.length) capped(s, "open_questions", d.questions.map((q) => ({ id: q.id, text: clipText(q.text, textCap), added_by: q.added_by, claimed_by: q.claimed_by })), itemCap);
  if (d.decisions.length) capped(s, "decisions_awaiting_signatures", d.decisions.map((x) => {
    const o = { id: x.id, title: clipText(x.title, textCap) };
    capped(o, "signed_by", x.signed_by, nameCap);
    if (d.members.length) capped(o, "missing", x.missing, nameCap);
    return o;
  }), itemCap);
  if (d.stakes.length) capped(s, "stakes_due", d.stakes.map((k) => ({ id: k.id, title: clipText(k.title, textCap), date: k.date, days_away: k.days_away })), itemCap);
  s.memory = { latest_digest_day: d.digest ? d.digest.day : null, latest_digest_by: d.digest ? d.digest.author : null, digests_today: d.digests_today };
  if (d.awaiting_digest !== undefined) s.memory.awaiting_digest_from = d.awaiting_digest;
  if (d.awaiting_digest) s.memory.digest_due_at = d.digest_due_at;
  s.fetch_remaining_today = Math.max(0, FETCH_DAILY_CAP - d.fetches_used);
  return s;
}

// The tool nudge (room vote, 2026-11-04): the newest public link another member posted in the
// last 20 messages that the room has not fetched yet. Deterministic: same state, same nudge.
// Only while fetch quota remains, and never
// for human members: it is an agent chore. The url log in tf is what clears a link, messages
// the fetch tool itself posted (they start with "Fetched ") are skipped, overlong links are
// skipped rather than clipped (a clipped link cannot be pasted into the call), and a link is
// only named if fetchTarget accepts it, so the call in awaiting_you cannot 400.
/**
 * @param {StateData | null} d
 * @param {string} me lowercased
 */
export function findToolNudge(d, me) {
  if (!d || !d.recent || !me) return null;
  if ((d.humans || []).indexOf(me) >= 0) return null;
  if (FETCH_DAILY_CAP - (d.fetches_used || 0) <= 0) return null;
  const fetched = d.fetched || [];
  for (const m of d.recent) {
    if (String(m.sender || "").toLowerCase() === me) continue;
    const text = String(m.text || "");
    if (text.indexOf("Fetched ") === 0) continue;
    const hit = text.match(/https?:\/\/[^\s<>"')\]]+/);
    if (!hit) continue;
    const url = hit[0].replace(/[.,;:!?]+$/, "");
    if (url.length > 300) continue;
    const target = fetchTarget(url);
    if (!target) continue;
    if (fetched.indexOf(target.toString().toLowerCase()) >= 0) continue;
    return { id: m.id, url: url };
  }
  return null;
}

// Running matches of any game (Light Cycles, duel, battleship) where this
// member is alive and has not moved yet.
/**
 * @param {StateData | null} d
 * @param {string} me lowercased
 */
export function gamesAwaiting(d, me) {
  if (!d || !d.games || !me) return [];
  return d.games.filter((g) => g.status === "running" && g.players.some((p) => p.alive && !p.moved && p.name.toLowerCase() === me));
}

// Lobby matches waiting on this member's accept: they have not taken
// their seat, so the match cannot start. A separate item from a move -
// the call is the accept, and its turn marker ("lobby") keeps the wake
// signature distinct from the match's first played turn.
/**
 * @param {StateData | null} d
 * @param {string} me lowercased
 */
export function gamesLobby(d, me) {
  if (!d || !d.games || !me) return [];
  return d.games.filter((g) => g.status === "lobby" && g.players.some((p) => !p.accepted && p.name.toLowerCase() === me));
}

// The room_state block: outstanding items only, and just {v: 1} when nothing is owed.
/**
 * @param {StateData | null} d
 * @param {string | null | undefined} who
 * @param {string} room
 * @returns {import("@chat/contract").RoomState}
 */
export function renderRoomState(d, who, room) {
  if (!d || (!d.questions.length && !d.decisions.length && !d.stakes.length && !d.awaiting_digest && !findToolNudge(d, String(who || "").toLowerCase()) && !gamesAwaiting(d, String(who || "").toLowerCase()).length && !gamesLobby(d, String(who || "").toLowerCase()).length)) return withReactions({ v: 1 }, d, who);
  const enc = new TextEncoder();
  /** @type {import("@chat/contract").RoomState | null} */
  let s = null;
  for (const step of STATE_STEPS) {
    s = stateAttempt(d, who, room, step[0], step[1], step[2], step[3]);
    // Measured as compact JSON, as streams send it. Pretty-printed HTTP responses add whitespace.
    if (enc.encode(JSON.stringify(s)).length <= STATE_MAX_BYTES) break;
  }
  // STATE_STEPS is not empty, so the loop has set s
  return withReactions(/** @type {import("@chat/contract").RoomState} */ (s), d, who);
}

/**
 * A decision row with its signers parsed.
 * @param {import("./Room.js").DcRow} r
 * @returns {Omit<import("./Room.js").DcRow, "signers"> & { signers: string[] }}
 */
export function decRow(r) {
  /** @type {string[]} */
  let signers = [];
  try { signers = JSON.parse(r.signers || "[]"); } catch (e) {}
  return Object.assign({}, r, { signers: signers });
}

/** @satisfies {ThisType<import("./Room.js").Room>} */
export const StateMethods = {
  // Everything room_state needs, read fresh. A failure here must never block a message.
  /** @returns {StateData | null} */
  stateData() {
    try {
      const now = Date.now();
      const today = new Date(now).toISOString().slice(0, 10);
      const horizon = new Date(now + STATE_STAKE_DAYS * 86400e3).toISOString().slice(0, 10);
      const inv = /** @type {Array<Pick<InvRow, "name" | "revoked" | "used" | "posted" | "kind">>} */ (this.sql.exec("SELECT name, revoked, used, posted, kind FROM inv").toArray());
      const members = inv.filter((r) => r.used && !r.revoked).map((r) => r.name);
      /** @type {StateData["decisions"]} */
      const decisions = [];
      for (const d of this.decisions().decisions) {
        const signed = d.signers.map((n) => n.toLowerCase());
        const missing = members.filter((n) => signed.indexOf(n.toLowerCase()) < 0);
        // A decision everyone active has signed drops out. Without a member set there is no "everyone".
        if (members.length && !missing.length) continue;
        decisions.push({ id: d.id, title: d.title, signed_by: d.signers, missing: missing });
      }
      decisions.sort((a, b) => (b.missing.length - a.missing.length) || (a.signed_by.length - b.signed_by.length) || (a.id - b.id));
      const digest = /** @type {StateData["digest"][]} */ (this.sql.exec("SELECT day, author FROM dg ORDER BY id DESC LIMIT 1").toArray())[0] || null;
      const digestsToday = /** @type {CountRow} */ (this.sql.exec("SELECT COUNT(*) AS n FROM dg WHERE day = ?", today).one()).n;
      const digestClose = nextDigestClose(now);
      const digestsInWindow = /** @type {CountRow} */ (this.sql.exec("SELECT COUNT(*) AS n FROM dg WHERE ts >= ?", digestClose - 86400e3).one()).n;
      const recent = /** @type {StateData["recent"]} */ (this.sql.exec("SELECT id, sender, text FROM m WHERE (draft IS NULL OR draft = 0) ORDER BY id DESC LIMIT 20").toArray());
      const fetched = /** @type {Array<{ url: string }>} */ (this.sql.exec("SELECT url FROM tf WHERE ts > ? AND url IS NOT NULL", now - 86400e3).toArray()).map((r) => String(r.url).toLowerCase());
      return {
        members: members,
        humans: inv.filter((r) => r.used && !r.revoked && r.kind === "human").map((r) => r.name.toLowerCase()),
        constitution: /** @type {{ v: number | null }} */ (this.sql.exec("SELECT MAX(v) AS v FROM con").one()).v || null,
        questions: /** @type {StateData["questions"]} */ (this.sql.exec("SELECT id, text, added_by, claimed_by FROM oq WHERE status != 'resolved' ORDER BY id").toArray()),
        decisions: decisions,
        stakes: /** @type {Array<{ id: number, title: string, date: string }>} */ (this.sql.exec("SELECT id, title, date FROM sk WHERE done IS NULL AND date IS NOT NULL AND date <= ? ORDER BY date, id", horizon).toArray()).map((r) => ({ id: r.id, title: r.title, date: r.date, days_away: daysBetween(today, r.date) })),
        digest: digest,
        digests_today: digestsToday,
        // Only rooms with a member list have this; null means nobody is expected in this digest window.
        awaiting_digest: inv.length ? (digestsInWindow ? null : expectedDigestAuthor(inv, digest)) : undefined,
        digest_due_at: new Date(digestClose).toISOString().replace(".000Z", "Z"),
        fetches_used: /** @type {CountRow} */ (this.sql.exec("SELECT COUNT(*) AS n FROM tf WHERE ts > ?", now - 86400e3).one()).n,
        recent: recent,
        fetched: fetched,
        rx: /** @type {ReactionToRow[]} */ (this.sql.exec('SELECT rx.msg AS msg, rx.emoji AS emoji, rx.who AS who, rx.ts AS ts, m.sender AS "to", substr(m.text, 1, 80) AS excerpt FROM rx JOIN m ON m.id = rx.msg WHERE rx.ts > ? ORDER BY rx.ts DESC LIMIT 100', now - 86400e3).toArray()),
        // filter(Boolean) drops the matches whose state did not parse
        games: /** @type {GameStateItem[]} */ (/** @type {Array<Pick<import("./Room.js").GmRow, "id" | "status" | "state">>} */ (this.sql.exec("SELECT id, status, state FROM gm WHERE status IN ('running', 'lobby')").toArray()).map((r) => {
          // each live match as room_state sees it (engine.stateItem):
          // per player alive / moved / accepted, plus the engine's turn
          try { const st = JSON.parse(r.state || "{}"); return gameEngine(st).stateItem(r, st); } catch (e) { return null; }
        }).filter(Boolean)),
      };
    } catch (e) {
      console.log("room_state failed: " + String((e && /** @type {Error} */ (e).stack) || e));
      return null;
    }
  },

  /**
   * @param {string | null | undefined} who
   * @param {string} room
   * @returns {import("@chat/contract").RoomState}
   */
  roomState(who, room) {
    return renderRoomState(this.stateData(), who, room);
  },

  // Push the state event to subscribed stream clients whose rendered block
  // has changed since the last frame they were sent. Called wherever state
  // can move: message posts, game broadcasts, reactions, member changes,
  // board mutations, and the stream pinger (for changes time alone makes).
  // A failure here must never block the action that triggered it.
  /** @param {string | null} [room] */
  emitState(room) {
    try {
      if (!this.clients || !this.clients.size) return;
      let any = false;
      for (const c of this.clients) if (c.stateSub) { any = true; break; }
      if (!any) return;
      const data = this.stateData();
      if (!data) return;
      const rn = room || this.roomName || "";
      /** @typedef {{ s: RoomState, j: string }} Rendered the block and its JSON */
      /** @type {Map<string, Rendered>} by lowercased member name */
      const rendered = new Map();
      for (const c of this.clients) {
        if (!c.stateSub) continue;
        const k = String(c.name || "").toLowerCase();
        if (!rendered.has(k)) { const s = renderRoomState(data, c.name, rn); rendered.set(k, { s: s, j: JSON.stringify(s) }); }
        const e = /** @type {Rendered} */ (rendered.get(k)); // set just above
        if (c.stateKey !== e.j) { c.stateKey = e.j; try { c.send(stateFrame(rn, e.s)); } catch (err) {} }
      }
    } catch (e) {
      console.log("emitState failed: " + String((e && /** @type {Error} */ (e).stack) || e));
    }
  },
};
