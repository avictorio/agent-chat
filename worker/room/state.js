// room_state: what a room still owes and is owed, rendered for readers and the stream.
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

import { DIGEST_CLOSE_HOUR, FETCH_DAILY_CAP, STATE_MAX_BYTES, STATE_STEPS } from "../limits.js";
import { gameEngine } from "../games/engine.js";
import { capped, clipText } from "../lib/text.js";
import { fetchTarget } from "../platform/webfetch.js";
import { withReactions } from "../lib/reactions.js";

export function streamWants(client, kind, gameId) {
  if (client.kinds && !client.kinds.has(kind)) return false;
  if (kind === "game" && client.games && !client.games.has(gameId)) return false;
  return true;
}

export function stateFrame(room, state) {
  return "event: state\ndata: " + JSON.stringify({ type: "state", room: room, from: null, kind: null, targets: [], room_state: state }) + "\n\n";
}

export function nextDigestClose(now) {
  const close = new Date(now).setUTCHours(DIGEST_CLOSE_HOUR, 0, 0, 0);
  return close > now ? close : close + 86400e3;
}

// The digest rotation is active agent members who have posted, in alphabetical order. People are
// never named: digests are agents' work. An invite with no kind counts as an agent, as it does on messages.
// The expected author follows the latest digest's author, wrapping; otherwise it's the first member.
export function expectedDigestAuthor(inv, digest) {
  const rotation = inv.filter((r) => r.used && r.posted && !r.revoked && r.kind !== "human").map((r) => r.name);
  rotation.sort((a, b) => { const x = a.toLowerCase(), y = b.toLowerCase(); return x < y ? -1 : (x > y ? 1 : 0); });
  if (!rotation.length) return null;
  const last = digest ? rotation.findIndex((n) => n.toLowerCase() === digest.author.toLowerCase()) : -1;
  return rotation[last < 0 ? 0 : (last + 1) % rotation.length];
}

// The complete request that clears an awaiting_you item. Only text the caller must write is left as <...>.
export function stateCall(room, kind, body) {
  return { method: "POST", path: "/api/rooms/" + room + "/" + kind, body: body };
}

export function stateAttempt(d, who, room, textCap, nameCap, itemCap, youCap) {
  const s = { v: 1 };
  const me = String(who || "").toLowerCase();
  if (me) {
    const lc = (list) => list.map((n) => n.toLowerCase());
    const unsigned = d.decisions.filter((x) => (d.members.length ? lc(x.missing).indexOf(me) >= 0 : lc(x.signed_by).indexOf(me) < 0));
    // The invite's own spelling when the caller is a member.
    const name = d.members.find((n) => n.toLowerCase() === me) || String(who);
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
export function gamesAwaiting(d, me) {
  if (!d || !d.games || !me) return [];
  return d.games.filter((g) => g.status === "running" && g.players.some((p) => p.alive && !p.moved && p.name.toLowerCase() === me));
}

// Lobby matches waiting on this member's accept: they have not taken
// their seat, so the match cannot start. A separate item from a move -
// the call is the accept, and its turn marker ("lobby") keeps the wake
// signature distinct from the match's first played turn.
export function gamesLobby(d, me) {
  if (!d || !d.games || !me) return [];
  return d.games.filter((g) => g.status === "lobby" && g.players.some((p) => !p.accepted && p.name.toLowerCase() === me));
}

// The room_state block: outstanding items only, and just {v: 1} when nothing is owed.
export function renderRoomState(d, who, room) {
  if (!d || (!d.questions.length && !d.decisions.length && !d.stakes.length && !d.awaiting_digest && !findToolNudge(d, String(who || "").toLowerCase()) && !gamesAwaiting(d, String(who || "").toLowerCase()).length && !gamesLobby(d, String(who || "").toLowerCase()).length)) return withReactions({ v: 1 }, d, who);
  const enc = new TextEncoder();
  let s = null;
  for (const step of STATE_STEPS) {
    s = stateAttempt(d, who, room, step[0], step[1], step[2], step[3]);
    // Measured as compact JSON, as streams send it. Pretty-printed HTTP responses add whitespace.
    if (enc.encode(JSON.stringify(s)).length <= STATE_MAX_BYTES) break;
  }
  return withReactions(s, d, who);
}

export function decRow(r) {
  let signers = [];
  try { signers = JSON.parse(r.signers || "[]"); } catch (e) {}
  return Object.assign({}, r, { signers: signers });
}
