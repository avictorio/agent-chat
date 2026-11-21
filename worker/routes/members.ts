// Members and invites.

import { MAX_ACTIVE_INVITES, MEMBER_INVITES_PER_DAY, ROOM_RE } from "../limits.js";
import { json } from "../lib/http.js";
import { agentOnboarding } from "../agents/onboarding.js";
import { MAX_NAME, memberNameProblem, nameFold } from "../lib/text.js";
import type { RouteContext } from "../index.js";

/** @param m the path's match */
export async function memberRoute(rc: RouteContext, m: RegExpMatchArray) {
  const { request, env, owner } = rc;
  const room = decodeURIComponent(m[1]).toLowerCase();
  if (!ROOM_RE.test(room)) return json({ error: "Room names are 1-64 lowercase letters, digits, - or _" }, 400);
  if (!owner) return json({ error: "Changing a member's type needs the owner key" }, 403);
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  /** the request's JSON body */
  let body: Record<string, any> | null = null;
  try { body = await request.json(); } catch (e) {}
  const kind = String((body && body.kind) || "").toLowerCase();
  if (kind !== "human" && kind !== "agent") return json({ error: "\"kind\" must be human or agent" }, 400);
  const who = decodeURIComponent(m[2]);
  const stub = env.ROOM.get(env.ROOM.idFromName(room));
  if (!(await stub.setKind(who, kind))) return json({ error: "No member with that name" }, 404);
  return json({ room, name: who, kind });
}

/** @param m the path's match */
export async function invitesRoute(rc: RouteContext, m: RegExpMatchArray) {
  const { request, env, url, owner, invite } = rc;
  const room = decodeURIComponent(m[1]).toLowerCase();
  if (!ROOM_RE.test(room)) return json({ error: "Room names are 1-64 lowercase letters, digits, - or _" }, 400);
  const stub = env.ROOM.get(env.ROOM.idFromName(room));
  const link = (t: string) => url.origin + "/r/" + room + "#invite=" + t;
  // Members of an invite-only room may create invites; listing, revoking and unlocking need the owner key.
  const inviter = owner ? null : await stub.inviter(invite);
  const memberCreate = !owner && !m[2] && request.method === "POST" && !!inviter;
  if (!owner && !memberCreate) {
    return json({ error: !m[2] && request.method === "POST" ? "Only members of an invite-only room can invite people. Open your invite link first." : "Managing invites needs the owner key" }, 403);
  }

  if (m[2]) {
    if (request.method !== "DELETE") return json({ error: "Method not allowed" }, 405);
    if (!(await stub.revoke(decodeURIComponent(m[2])))) return json({ error: "No active invite with that token" }, 404);
    return json({ room, revoked: true });
  }
  if (request.method === "GET") {
    const all = await stub.invites();
    return json({ room, invite_only: true, invites: all.map((/** an invite row */ i: Record<string, any>) => { const o = Object.assign({ link: link(i.token) }, i); if (i.kind !== "human" && !i.revoked) o.agent_onboarding = agentOnboarding(url.origin, room, i.name, i.token); return o; }) });
  }
  if (request.method === "POST") {
    /** the request's JSON body */
    let body: Record<string, any> | null = null;
    try { body = await request.json(); } catch (e) {}
    const name = String((body && body.name) || "").trim().slice(0, MAX_NAME);
    if (!name) return json({ error: "\"name\" is required" }, 400);
    const kind = String((body && body.kind) || "agent").toLowerCase();
    if (kind !== "human" && kind !== "agent") return json({ error: "\"kind\" must be human or agent" }, 400);
    if (nameFold(name) === "referee") return json({ error: "\"Referee\" is a reserved name - it belongs to the room's game official and cannot be a member." }, 400);
    const nameErr = memberNameProblem(name);
    if (nameErr) return json({ error: nameErr }, 400);
    const inv = await stub.invite(name, kind, owner ? null : inviter, memberCreate ? { perDay: MEMBER_INVITES_PER_DAY, maxActive: MAX_ACTIVE_INVITES } : null);
    if (inv && inv.limit === "day") return json({ error: "You can create up to " + MEMBER_INVITES_PER_DAY + " invites a day" }, 429);
    if (inv && inv.limit === "active") return json({ error: "This room already has " + MAX_ACTIVE_INVITES + " active invites" }, 429);
    if (!inv) return json({ error: name + " already has an active invite (names match regardless of case). Revoke it first to make a new one." }, 409);
    const created = Object.assign({ room, link: link(inv.token) }, inv);
    if (inv.kind !== "human") created.agent_onboarding = agentOnboarding(url.origin, room, inv.name, inv.token);
    return json(created, 201);
  }
  if (request.method === "DELETE") {
    await stub.unlock();
    return json({ room, invite_only: true });
  }
  return json({ error: "Method not allowed" }, 405);
}
