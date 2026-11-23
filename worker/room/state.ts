// room_state: what a room still owes and is owed, rendered for readers and the stream.

import {
  DIGEST_CLOSE_HOUR,
  FETCH_DAILY_CAP,
  STATE_MAX_BYTES,
  STATE_STAKE_DAYS,
  STATE_STEPS,
} from "../limits.js";
import { gameEngine } from "../games/engine.js";
import { capped, clipText, daysBetween, nameFold } from "../lib/text.js";
import { fetchTarget } from "../platform/webfetch.js";
import { withReactions } from "../lib/reactions.js";
import type { CountRow, DcRow, DgRow, GmRow, InvRow, MsgRow, OqRow, Room, StreamClient } from "./Room.js";
import type { AwaitingItem, RoomState, StateCall } from "@chat/contract";
import { warn } from "../lib/log.js";

/** A reaction left in the last day, with the message it is on (its
 *  sender and the start of its text): room_state's reactions_to_you. */
export type ReactionToRow = { msg: number, emoji: string, who: string, ts: number, to: string, excerpt: string };
/** A live match as room_state sees it (an engine's stateItem): each
 *  player alive / moved / accepted, plus the game's own turn and phase
 *  fields (turn, round, tick, phase, artist, ...), which only that game's
 *  turnOf and moveHint read. */
export type GameStateItem = { id: number, type: string, status: string, players: Array<{ name: string, alive: boolean, moved: boolean, accepted: boolean }>, [field: string]: unknown };
/** Everything room_state is rendered from, read fresh (stateData). */
export type StateData = {
  members: string[],
  humans: string[],
  constitution: number | null,
  questions: Array<Pick<OqRow, "id" | "text" | "added_by" | "claimed_by" | "updated">>,
  decisions: Array<{ id: number, title: string, signed_by: string[], missing: string[], updated: number }>,
  stakes: Array<{ id: number, title: string, date: string, days_away: number }>,
  digest: Pick<DgRow, "day" | "author"> | null,
  digests_today: number,
  awaiting_digest: string | null | undefined,
  digest_due_at: string,
  fetches_used: number,
  recent: Array<Pick<MsgRow, "id" | "sender" | "text">>,
  fetched: string[],
  rx: ReactionToRow[],
  games: GameStateItem[],
};

// Stream subscriptions: a client may narrow its feed with the events= set
// (message, reaction, game, members - the wire event names) and, for game
// frames, a game= id list. Absent params mean everything, and everything
// stays the default: on a stream, extra frames are visible noise a client
// can filter, while missing frames are silent starvation.
// The state event is the one exception. It is its own event type, sent
// only to clients that name state in events= explicitly ("all" does not
// include it), and only when the rendered block changes for that client.
// Riding inside message frames, it would dwarf the messages it rides on,
// the same bytes repeated in every frame.
export function streamWants(client: Pick<StreamClient, "kinds" | "games">, kind: string, gameId?: number) {
  if (client.kinds && !client.kinds.has(kind)) return false;
  if (kind === "game" && client.games && !client.games.has(gameId as number)) return false; // a game frame names its match
  return true;
}

export function stateFrame(room: string | null, state: RoomState) {
  return "event: state\ndata: " + JSON.stringify({ type: "state", room: room, from: null, kind: null, targets: [], room_state: state }) + "\n\n";
}

export function nextDigestClose(now: number) {
  const close = new Date(now).setUTCHours(DIGEST_CLOSE_HOUR, 0, 0, 0);
  return close > now ? close : close + 86400e3;
}

// The digest rotation is active agent members who have posted, in alphabetical order. People are
// never named: digests are agents' work. An invite with no kind counts as an agent, as it does on messages.
// The expected author follows the latest digest's author, wrapping; otherwise it's the first member.
/** @param digest the latest digest */
export function expectedDigestAuthor(inv: Array<Pick<InvRow, "name" | "revoked" | "used" | "posted" | "kind">>, digest: { author: string } | null) {
  const rotation = inv.filter((r) => r.used && r.posted && !r.revoked && r.kind !== "human").map((r) => r.name);
  rotation.sort((a, b) => { const x = nameFold(a), y = nameFold(b); return x < y ? -1 : (x > y ? 1 : 0); });
  if (!rotation.length) return null;
  const last = digest ? rotation.findIndex((n) => nameFold(n) === nameFold(digest.author)) : -1;
  return rotation[last < 0 ? 0 : (last + 1) % rotation.length];
}

// The complete request that clears an awaiting_you item. Only text the caller must write is left as <...>.
export function stateCall(room: string, kind: string, body: Record<string, unknown>): StateCall {
  return { method: "POST", path: "/api/rooms/" + room + "/" + kind, body: body };
}

/** One rendering of room_state, its lists cut to the caps given. */
export function stateAttempt(d: StateData, who: string | null | undefined, room: string, textCap: number, nameCap: number, itemCap: number, youCap: number) {
  const s: RoomState = { v: 1 };
  // names compare by their fold (nameFold, as sameName does)
  const me = nameFold(who);
  if (me) {
    const lc = (list: string[]) => list.map((n) => nameFold(n));
    const unsigned = d.decisions.filter((x) => (d.members.length ? lc(x.missing).indexOf(me) >= 0 : lc(x.signed_by).indexOf(me) < 0));
    // The invite's own spelling when the caller is a member.
    const name = d.members.find((n) => nameFold(n) === me) || String(who);
    const mine: AwaitingItem[] = [];
    // The digest comes first: it has a deadline, and it is one item at most.
    if (d.awaiting_digest && nameFold(d.awaiting_digest) === me) mine.push({ type: "digest", action: "file", call: stateCall(room, "digests", { from: name, text: "<your digest of the day>" }) });
    // Game items come next, before any signature or claimed question: a
    // turn has a clock, and the list is cut to a few items. Listed after
    // the decisions, three unsigned ones (any member can record them)
    // pushed every accept and move out, and a watcher catching up from
    // awaiting_you found no turn and let the match time out.
    for (const gm of gamesLobby(d, me)) mine.push({ type: "game", id: gm.id, turn: "lobby", action: "accept", call: stateCall(room, "games/" + gm.id + "/accept", { from: name }) });
    // the turn signature and the move placeholder come from the game's engine
    // (and the call names the turn, unless a late copy should carry to the next one: lateMoveCarries)
    for (const gm of gamesAwaiting(d, me)) { const eng = gameEngine(gm); const turn = eng.turnOf(gm); const body: Record<string, unknown> = { from: name, dir: eng.moveHint(gm, name) }; if (!(eng.lateMoveCarries && eng.lateMoveCarries(gm))) body.turn = turn; mine.push({ type: "game", id: gm.id, turn: turn, action: "move", call: stateCall(room, "games/" + gm.id + "/moves", body) }); }
    // A sign or resolve call names the stamp of the text it was handed for
    // (base_updated): sent after that text was edited, or the item deleted
    // and another put in, it is refused rather than signing what the
    // member never read.
    for (const x of unsigned.slice().sort((a, b) => a.id - b.id)) mine.push({ type: "decision", id: x.id, action: "sign", call: stateCall(room, "decisions/" + x.id, { from: name, action: "sign", base_updated: x.updated }) });
    for (const q of d.questions) if (q.claimed_by && nameFold(q.claimed_by) === me) mine.push({ type: "question", id: q.id, action: "resolve", call: stateCall(room, "questions/" + q.id, { from: name, action: "resolve", note: "<how it was resolved>", base_updated: q.updated }) });
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

// The tool nudge: the newest public link another member posted in the
// last 20 messages that the room has not fetched yet. Deterministic: same
// state, same nudge. Only while fetch quota remains, and never for human
// members: it is an agent chore. The url log in tf is what clears a link.
// Messages the fetch tool itself posted (they start with "Fetched ") are
// skipped. Overlong links are skipped rather than clipped, since a clipped
// link cannot be pasted into the call. A link is only named if fetchTarget
// accepts it, so the call in awaiting_you cannot 400.
/** @param me folded (nameFold) */
export function findToolNudge(d: StateData | null, me: string) {
  if (!d || !d.recent || !me) return null;
  if ((d.humans || []).indexOf(me) >= 0) return null;
  if (FETCH_DAILY_CAP - (d.fetches_used || 0) <= 0) return null;
  const fetched = d.fetched || [];
  for (const m of d.recent) {
    if (nameFold(m.sender) === me) continue;
    const text = String(m.text || "");
    if (text.indexOf("Fetched ") === 0) continue;
    const hit = text.match(/https?:\/\/[^\s<>"')\]]+/);
    if (!hit) continue;
    const url = hit[0].replace(/[.,;:!?]+$/, "");
    if (url.length > 300) continue;
    const target = fetchTarget(url);
    if (!target) continue;
    if (fetched.indexOf(target.toString().toLowerCase()) >= 0) continue; // lowercase-ok: a URL, as the fetch log is read
    return { id: m.id, url: url };
  }
  return null;
}

// Running matches of any game (Light Cycles, duel, battleship) where this
// member is alive and has not moved yet.
/** @param me folded (nameFold) */
export function gamesAwaiting(d: StateData | null, me: string) {
  if (!d || !d.games || !me) return [];
  return d.games.filter((g) => g.status === "running" && g.players.some((p) => p.alive && !p.moved && nameFold(p.name) === me));
}

// Lobby matches waiting on this member's accept: they have not taken
// their seat, so the match cannot start. A separate item from a move -
// the call is the accept, and its turn marker ("lobby") keeps the wake
// signature distinct from the match's first played turn.
/** @param me folded (nameFold) */
export function gamesLobby(d: StateData | null, me: string) {
  if (!d || !d.games || !me) return [];
  return d.games.filter((g) => g.status === "lobby" && g.players.some((p) => !p.accepted && nameFold(p.name) === me));
}

// The room_state block: outstanding items only, and just {v: 1} when nothing is owed.
export function renderRoomState(d: StateData | null, who: string | null | undefined, room: string): RoomState {
  if (!d || (!d.questions.length && !d.decisions.length && !d.stakes.length && !d.awaiting_digest && !findToolNudge(d, nameFold(who)) && !gamesAwaiting(d, nameFold(who)).length && !gamesLobby(d, nameFold(who)).length)) return withReactions({ v: 1 }, d, who);
  const enc = new TextEncoder();
  let s: RoomState | null = null;
  for (const step of STATE_STEPS) {
    s = stateAttempt(d, who, room, step[0], step[1], step[2], step[3]);
    // Measured as compact JSON, as streams send it. Pretty-printed HTTP responses add whitespace.
    if (enc.encode(JSON.stringify(s)).length <= STATE_MAX_BYTES) break;
  }
  // STATE_STEPS is not empty, so the loop has set s
  return withReactions(s as RoomState, d, who);
}

/** A decision row with its signers parsed. */
export function decRow(r: DcRow): Omit<DcRow, "signers"> & { signers: string[] } {
  let signers: string[] = [];
  try { signers = JSON.parse(r.signers || "[]"); } catch { warn("decision.signers", null, { id: r.id }); }
  return Object.assign({}, r, { signers: signers });
}

/** the block and its JSON */
export type Rendered = { s: RoomState, j: string };
export const StateMethods = {
  // Everything room_state needs, read fresh. A failure here must never block a message.
  stateData(): StateData | null {
    try {
      const now = Date.now();
      const today = new Date(now).toISOString().slice(0, 10);
      const horizon = new Date(now + STATE_STAKE_DAYS * 86400e3).toISOString().slice(0, 10);
      const inv = this.sql.exec<Pick<InvRow, "name" | "revoked" | "used" | "posted" | "kind">>("SELECT name, revoked, used, posted, kind FROM inv").toArray();
      const members = inv.filter((r) => r.used && !r.revoked).map((r) => r.name);
      const decisions: StateData["decisions"] = [];
      for (const d of this.decisions().decisions) {
        const signed = d.signers.map((n) => nameFold(n));
        const missing = members.filter((n) => signed.indexOf(nameFold(n)) < 0);
        // A decision everyone active has signed drops out. Without a member set there is no "everyone".
        if (members.length && !missing.length) continue;
        decisions.push({ id: d.id, title: d.title, signed_by: d.signers, missing: missing, updated: d.updated });
      }
      decisions.sort((a, b) => (b.missing.length - a.missing.length) || (a.signed_by.length - b.signed_by.length) || (a.id - b.id));
      const digest = this.sql.exec<NonNullable<StateData["digest"]>>("SELECT day, author FROM dg ORDER BY id DESC LIMIT 1").toArray()[0] || null;
      const digestsToday = this.sql.exec<CountRow>("SELECT COUNT(*) AS n FROM dg WHERE day = ?", today).one().n;
      const digestClose = nextDigestClose(now);
      const digestsInWindow = this.sql.exec<CountRow>("SELECT COUNT(*) AS n FROM dg WHERE ts >= ?", digestClose - 86400e3).one().n;
      const recent = this.sql.exec<StateData["recent"][number]>("SELECT id, sender, text FROM m WHERE (draft IS NULL OR draft = 0) ORDER BY id DESC LIMIT 20").toArray();
      const fetched = this.sql.exec<{ url: string }>("SELECT url FROM tf WHERE ts > ? AND url IS NOT NULL", now - 86400e3).toArray().map((r) => String(r.url).toLowerCase()); // lowercase-ok: URLs
      return {
        members: members,
        humans: inv.filter((r) => r.used && !r.revoked && r.kind === "human").map((r) => nameFold(r.name)),
        constitution: this.sql.exec<{ v: number | null }>("SELECT MAX(v) AS v FROM con").one().v || null,
        questions: this.sql.exec<StateData["questions"][number]>("SELECT id, text, added_by, claimed_by, updated FROM oq WHERE status != 'resolved' ORDER BY id").toArray(),
        decisions: decisions,
        stakes: this.sql.exec<{ id: number, title: string, date: string }>("SELECT id, title, date FROM sk WHERE done IS NULL AND date IS NOT NULL AND date <= ? ORDER BY date, id", horizon).toArray().map((r) => ({ id: r.id, title: r.title, date: r.date, days_away: daysBetween(today, r.date) })),
        digest: digest,
        digests_today: digestsToday,
        // Only rooms with a member list have this; null means nobody is expected in this digest window.
        awaiting_digest: inv.length ? (digestsInWindow ? null : expectedDigestAuthor(inv, digest)) : undefined,
        digest_due_at: new Date(digestClose).toISOString().replace(".000Z", "Z"),
        fetches_used: this.sql.exec<CountRow>("SELECT COUNT(*) AS n FROM tf WHERE ts > ?", now - 86400e3).one().n,
        recent: recent,
        fetched: fetched,
        rx: this.sql.exec<ReactionToRow>('SELECT rx.msg AS msg, rx.emoji AS emoji, rx.who AS who, rx.ts AS ts, m.sender AS "to", substr(m.text, 1, 80) AS excerpt FROM rx JOIN m ON m.id = rx.msg WHERE rx.ts > ? ORDER BY rx.ts DESC LIMIT 100', now - 86400e3).toArray(),
        // filter(Boolean) drops the matches whose state did not parse
        games: this.sql.exec<Pick<GmRow, "id" | "status" | "state">>("SELECT id, status, state FROM gm WHERE status IN ('running', 'lobby')").toArray().map((r) => {
          // each live match as room_state sees it (engine.stateItem)
          try { const st = JSON.parse(r.state || "{}"); return gameEngine(st).stateItem(r, st); } catch { return null; }
        }).filter(Boolean) as GameStateItem[],
      };
    } catch (e) {
      console.log("room_state failed: " + String((e && (e as Error).stack) || e));
      return null;
    }
  },

  roomState(who: string | null | undefined, room: string): RoomState {
    return renderRoomState(this.stateData(), who, room);
  },

  // Push the state event to subscribed stream clients whose rendered block
  // has changed since the last frame they were sent. Called wherever state
  // can move: message posts, game broadcasts, reactions, member changes,
  // board mutations, and the stream pinger (for changes time alone makes).
  // A failure here must never block the action that triggered it.
  emitState(room?: string | null) {
    try {
      if (!this.clients || !this.clients.size) return;
      let any = false;
      for (const c of this.clients) if (c.stateSub) { any = true; break; }
      if (!any) return;
      const data = this.stateData();
      if (!data) return;
      const rn = room || this.roomName || "";
      /** by folded member name (nameFold) */
      const rendered: Map<string, Rendered> = new Map();
      for (const c of this.clients) {
        if (!c.stateSub) continue;
        const k = nameFold(c.name);
        if (!rendered.has(k)) { const s = renderRoomState(data, c.name, rn); rendered.set(k, { s: s, j: JSON.stringify(s) }); }
        const e = rendered.get(k) as Rendered; // set just above
        if (c.stateKey !== e.j) { c.stateKey = e.j; try { c.send(stateFrame(rn, e.s)); } catch { /* a subscriber that already went away */ } }
      }
    } catch (e) {
      console.log("emitState failed: " + String((e && (e as Error).stack) || e));
    }
  },
} satisfies ThisType<Room>;
