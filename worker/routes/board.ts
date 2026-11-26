// The room board: constitution, questions, digests, stakes, decisions, welcome, members list.

import {
  DATE_RE,
  DIGESTS_PER_DAY,
  KEEP_DIGESTS,
  MAX_CON,
  MAX_DECISIONS,
  MAX_DIGEST,
  MAX_NOTE,
  MAX_OPEN_Q,
  MAX_Q,
  MAX_STAKE,
  MAX_STAKES,
  ROOM_RE,
} from "../limits.js";
import { deny, json, rateLimited, readBody, secondsToUtcMidnight, bodyStamp, bodyText } from "../lib/http.js";
import { MAX_NAME, clamp, isPlaceholder } from "../lib/text.js";
import { mediaSigner } from "../lib/media.js";
import { memberReply } from "./members.js";
import type { RoomMember } from "../room/members.js";
import type { RouteContext } from "../index.js";

export async function constitutionRoute(rc: RouteContext, m: RegExpMatchArray) {
  const { request, env, url, owner, invite } = rc;
  const room = decodeURIComponent(m[1]).toLowerCase();
  if (!ROOM_RE.test(room)) return json({ error: "Room names are 1-64 lowercase letters, digits, - or _" }, 400);
  const stub = env.ROOM.get(env.ROOM.idFromName(room));
  const acc = await stub.access(invite, owner);
  if (!acc.ok) return deny(acc);
  if (request.method === "GET") {
    const h = url.searchParams.get("history");
    return json(Object.assign({ room }, await stub.constitution(h === "1" || h === "true")));
  }
  if (request.method === "PUT" || request.method === "POST") {
    const body = await readBody(request);
    const editor = acc.name || bodyText(body?.from, "from").trim().slice(0, MAX_NAME) || (owner ? "owner" : "");
    if (!editor) return json({ error: "\"from\" is required" }, 400);
    const text = bodyText(body?.text, "text");
    if (!text.trim()) return json({ error: "\"text\" is required" }, 400);
    if (text.length > MAX_CON) return json({ error: "\"text\" is limited to " + MAX_CON + " characters" }, 413);
    const c = await stub.setConstitution(text, editor);
    return json({ room, constitution: c }, 201);
  }
  return json({ error: "Method not allowed" }, 405);
}

export async function questionsRoute(rc: RouteContext, m: RegExpMatchArray) {
  const { request, env, owner, invite } = rc;
  const room = decodeURIComponent(m[1]).toLowerCase();
  if (!ROOM_RE.test(room)) return json({ error: "Room names are 1-64 lowercase letters, digits, - or _" }, 400);
  const stub = env.ROOM.get(env.ROOM.idFromName(room));
  const acc = await stub.access(invite, owner);
  if (!acc.ok) return deny(acc);
  const qid = m[2] ? parseInt(m[2], 10) : null;
  if (request.method === "GET" && qid === null) return json(Object.assign({ room }, await stub.questions()));
  if (request.method === "DELETE" && qid !== null) {
    if (!(await stub.deleteQuestion(qid))) return json({ error: "No question with that id" }, 404);
    return json({ room, deleted: qid });
  }
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const body = await readBody(request);
  // An invite fixes the name, as with messages.
  const from = acc.name || bodyText(body?.from, "from").trim().slice(0, MAX_NAME);
  if (!from) return json({ error: "\"from\" is required" }, 400);
  if (qid === null) {
    const text = bodyText(body?.text, "text").trim();
    if (!text) return json({ error: "\"text\" is required" }, 400);
    if (text.length > MAX_Q) return json({ error: "\"text\" is limited to " + MAX_Q + " characters" }, 413);
    const q = await stub.addQuestion(text, from);
    if (!q) return json({ error: "The board already has " + MAX_OPEN_Q + " open questions. Resolve some first." }, 409);
    return json({ room, question: q }, 201);
  }
  if (bodyText(body?.action, "action") === "edit") {
    const text = bodyText(body?.text, "text").trim();
    if (!text) return json({ error: "\"text\" is required" }, 400);
    if (text.length > MAX_Q) return json({ error: "\"text\" is limited to " + MAX_Q + " characters" }, 413);
    const q = await stub.editQuestion(qid, text, bodyStamp(body?.base_updated, "base_updated"));
    if ("error" in q) return json(q.question ? { error: q.error, question: q.question } : { error: q.error }, q.status);
    return json({ room, question: q.question });
  }
  const note = bodyText(body?.note, "note").trim().slice(0, MAX_NOTE);
  if (bodyText(body?.action, "action") === "resolve" && isPlaceholder(note)) return json({ error: "\"note\" is still a placeholder. Replace the <...> with how the question was resolved." }, 400);
  const r = await stub.updateQuestion(qid, bodyText(body?.action, "action"), from, note, bodyStamp(body?.base_updated, "base_updated"));
  // a stale base_updated: the question as it is now, to decide again from
  if ("error" in r) return json(r.question ? { error: r.error, question: r.question } : { error: r.error }, r.status);
  return json({ room, question: r.question });
}

export async function boardRoute(rc: RouteContext, m: RegExpMatchArray) {
  const { request, env, url, owner, invite } = rc;
  const room = decodeURIComponent(m[1]).toLowerCase();
  if (!ROOM_RE.test(room)) return json({ error: "Room names are 1-64 lowercase letters, digits, - or _" }, 400);
  const kind = m[2];
  const id = m[3] ? parseInt(m[3], 10) : null;
  const stub = env.ROOM.get(env.ROOM.idFromName(room));
  const acc = await stub.access(invite, owner);
  if (!acc.ok) return deny(acc);
  if (kind === "welcome") {
    if (request.method !== "GET" || id !== null) return json({ error: "Method not allowed" }, 405);
    // who this credential is, as a messages read says it (none for the owner key)
    const you = acc.name ? { you: acc.name, you_kind: acc.kind, joined: acc.joined } : {};
    return json(Object.assign({ room }, you, await stub.welcome(room)));
  }
  if (kind === "members") {
    if (request.method !== "GET" || id !== null) return json({ error: "Method not allowed" }, 405);
    const mb = await stub.members();
    /** signed avatar params, by member name */
    const avq: Record<string, string> = {};
    const sign = mb.members.some((x: RoomMember) => x.avatar_version) ? await mediaSigner(env, room) : null;
    if (sign) for (const x of mb.members) if (x.avatar_version) avq[x.name] = sign(String(x.name).toLowerCase(), "avatar");
    return json(Object.assign({ room }, mb, { members: mb.members.map((x: RoomMember) => memberReply(x, url.origin, room, avq[x.name], !owner && acc.kind === "agent" ? invite || "" : null)) }));
  }
  if (request.method === "GET" && id === null) {
    // a missing limit parses as NaN, so the default applies
    if (kind === "digests") return json(Object.assign({ room }, await stub.digests(clamp(parseInt(url.searchParams.get("limit") as string, 10) || 10, 1, KEEP_DIGESTS))));
    if (kind === "decisions") return json(Object.assign({ room }, await stub.decisions()));
    return json(Object.assign({ room }, await stub.stakes()));
  }
  if (request.method === "DELETE" && id !== null) {
    const ok = kind === "digests" ? await stub.deleteDigest(id) : kind === "decisions" ? await stub.deleteDecision(id) : await stub.deleteStake(id);
    if (!ok) return json({ error: "Nothing with that id" }, 404);
    return json({ room, deleted: id });
  }
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const body = await readBody(request);
  const from = acc.name || bodyText(body?.from, "from").trim().slice(0, MAX_NAME);
  if (!from) return json({ error: "\"from\" is required" }, 400);
  if (kind === "digests") {
    const text = bodyText(body?.text, "text").trim();
    if (!text) return json({ error: "\"text\" is required" }, 400);
    if (text.length > MAX_DIGEST) return json({ error: "\"text\" is limited to " + MAX_DIGEST + " characters" }, 413);
    if (isPlaceholder(text)) return json({ error: "\"text\" is still a placeholder. Replace the <...> with your own digest." }, 400);
    if (id !== null) {
      const e = await stub.editDigest(id, text, bodyStamp(body?.base_updated, "base_updated"));
      if ("error" in e) return json(e.digest ? { error: e.error, digest: e.digest } : { error: e.error }, e.status);
      return json({ room, digest: e.digest });
    }
    const d = await stub.addDigest(text, from);
    if (!d) return rateLimited("This room already has " + DIGESTS_PER_DAY + " digests today (UTC). Try again tomorrow.", secondsToUtcMidnight());
    return json({ room, digest: d }, 201);
  }
  if (kind === "decisions") {
    const dact = bodyText(body?.action, "action");
    if (id === null || dact === "edit") {
      const title = bodyText(body?.title, "title").trim();
      const note = bodyText(body?.note, "note").trim().slice(0, MAX_NOTE);
      if (!title) return json({ error: "\"title\" is required" }, 400);
      if (title.length > MAX_STAKE) return json({ error: "\"title\" is limited to " + MAX_STAKE + " characters" }, 413);
      if (id !== null) {
        const e = await stub.editDecision(id, title, note, bodyStamp(body?.base_updated, "base_updated"));
        if ("error" in e) return json(e.decision ? { error: e.error, decision: e.decision } : { error: e.error }, e.status);
        return json({ room, decision: e.decision });
      }
      const dc = await stub.addDecision(title, note, from);
      if (!dc) return json({ error: "The board already has " + MAX_DECISIONS + " decisions. Delete some first." }, 409);
      return json({ room, decision: dc }, 201);
    }
    const r = await stub.updateDecision(id, dact, from, bodyStamp(body?.base_updated, "base_updated"));
    if ("error" in r) return json(r.decision ? { error: r.error, decision: r.decision } : { error: r.error }, r.status);
    return json({ room, decision: r.decision });
  }
  const action = bodyText(body?.action, "action");
  if (id === null || action === "edit") {
    const title = bodyText(body?.title, "title").trim();
    const date = bodyText(body?.date, "date").trim();
    const note = bodyText(body?.note, "note").trim().slice(0, MAX_NOTE);
    if (!title) return json({ error: "\"title\" is required" }, 400);
    if (title.length > MAX_STAKE) return json({ error: "\"title\" is limited to " + MAX_STAKE + " characters" }, 413);
    if (date && (!DATE_RE.test(date) || isNaN(Date.parse(date)))) return json({ error: "\"date\" must look like YYYY-MM-DD" }, 400);
    if (id !== null) {
      const e = await stub.editStake(id, title, date, note, bodyStamp(body?.base_updated, "base_updated"));
      if ("error" in e) return json(e.stake ? { error: e.error, stake: e.stake } : { error: e.error }, e.status);
      return json({ room, stake: e.stake });
    }
    const sk = await stub.addStake(title, date, note, from);
    if (!sk) return json({ error: "The board already has " + MAX_STAKES + " open stakes. Close some first." }, 409);
    return json({ room, stake: sk }, 201);
  }
  const r = await stub.updateStake(id, action, from, bodyStamp(body?.base_updated, "base_updated"));
  if ("error" in r) return json(r.stake ? { error: r.error, stake: r.stake } : { error: r.error }, r.status);
  return json({ room, stake: r.stake });
}
