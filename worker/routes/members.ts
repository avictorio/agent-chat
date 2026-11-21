// Members and invites.

import { MAX_ACTIVE_INVITES, MEMBER_INVITES_PER_DAY, ROOM_RE } from "../limits.js";
import { deny, json, limitReached, rateLimited, readBody } from "../lib/http.js";
import { agentOnboarding } from "../agents/onboarding.js";
import { MAX_NAME, memberNameProblem, nameFold } from "../lib/text.js";
import type { RouteContext } from "../index.js";
import type { InvitePreview } from "../room/Room.js";

/** @param m the path's match */
export async function memberRoute(rc: RouteContext, m: RegExpMatchArray) {
  const { request, env, owner } = rc;
  const room = decodeURIComponent(m[1]).toLowerCase();
  if (!ROOM_RE.test(room)) return json({ error: "Room names are 1-64 lowercase letters, digits, - or _" }, 400);
  if (!owner) return json({ error: "Changing a member's type needs the owner key" }, 403);
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const body = await readBody(request);
  const kind = String((body && body.kind) || "").toLowerCase();
  if (kind !== "human" && kind !== "agent") return json({ error: "\"kind\" must be human or agent" }, 400);
  const who = decodeURIComponent(m[2]);
  const stub = env.ROOM.get(env.ROOM.idFromName(room));
  if (!(await stub.setKind(who, kind))) return json({ error: "No member with that name" }, 404);
  return json({ room, name: who, kind });
}

// GET /api/rooms/ROOM/invite: look before joining. The token holder sees
// the invite (for whom, who invited them, its status), the start of the
// constitution and who is in the room, and the invite stays unopened: any
// other call with the token opens it. Refuses exactly as a read does. The
// owner key previews nothing (it has no invite).
/** @param m the path's match */
export async function invitePreviewRoute(rc: RouteContext, m: RegExpMatchArray) {
  const { request, env, url, invite } = rc;
  const room = decodeURIComponent(m[1]).toLowerCase();
  if (!ROOM_RE.test(room)) return json({ error: "Room names are 1-64 lowercase letters, digits, - or _" }, 400);
  if (request.method !== "GET" && request.method !== "HEAD") return json({ error: "Method not allowed" }, 405);
  const stub = env.ROOM.get(env.ROOM.idFromName(room));
  const pv = await stub.previewInvite(invite);
  if (!pv.ok) return deny(pv);
  return json(invitePreviewBody(url.origin, room, invite, pv));
}

// GET /api/rooms/ROOM/me: who this credential is here - name, kind, the
// invite's status (active: this call opened it if nothing had), who invited
// them, when, and when they joined. Like any call with a token, it opens
// the invite. The owner key without a token is no member: owner: true and
// the rest null (that field goes with the key).
/** @param m the path's match */
export async function meRoute(rc: RouteContext, m: RegExpMatchArray) {
  const { request, env, owner, invite } = rc;
  const room = decodeURIComponent(m[1]).toLowerCase();
  if (!ROOM_RE.test(room)) return json({ error: "Room names are 1-64 lowercase letters, digits, - or _" }, 400);
  if (request.method !== "GET" && request.method !== "HEAD") return json({ error: "Method not allowed" }, 405);
  const stub = env.ROOM.get(env.ROOM.idFromName(room));
  const acc = await stub.access(invite, owner);
  if (!acc.ok) return deny(acc);
  return json(Object.assign({ room }, meFields(acc, owner)));
}

/** The /me fields, shared with MCP whoami. */
export function meFields(acc: { name?: string, kind?: string, invited_by?: string | null, invited?: number, joined?: number }, owner: boolean) {
  if (!acc.name) return { name: null, kind: null, status: null, invited_by: null, invited: null, joined: null, owner: !!owner };
  return { name: acc.name, kind: acc.kind || null, status: "active", invited_by: acc.invited_by || null, invited: acc.invited || null, joined: acc.joined || null };
}

/** The preview's answer, shared by REST and MCP get_invite. */
export function invitePreviewBody(origin: string, room: string, token: string, pv: InvitePreview) {
  const base = origin + "/api/rooms/" + encodeURIComponent(room);
  const out: Record<string, unknown> = { room, invite: pv.invite, purpose: pv.purpose, members: pv.members, opened: pv.opened };
  if (pv.invite.kind === "agent") out.agent_onboarding = agentOnboarding(origin, room, pv.invite.name, token, { invitedBy: pv.invite.invited_by, purpose: pv.purpose });
  out.next = { docs: origin + "/llms.txt", me: base + "/me", mcp: base + "/mcp", messages: base + "/messages", changes: origin + "/api/changes" };
  return out;
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
    const body = await readBody(request);
    const name = String((body && body.name) || "").trim().slice(0, MAX_NAME);
    if (!name) return json({ error: "\"name\" is required" }, 400);
    const kind = String((body && body.kind) || "agent").toLowerCase();
    if (kind !== "human" && kind !== "agent") return json({ error: "\"kind\" must be human or agent" }, 400);
    if (nameFold(name) === "referee") return json({ error: "\"Referee\" is a reserved name - it belongs to the room's game official and cannot be a member." }, 400);
    const nameErr = memberNameProblem(name);
    if (nameErr) return json({ error: nameErr }, 400);
    const inv = await stub.invite(name, kind, owner ? null : inviter, memberCreate ? { perDay: MEMBER_INVITES_PER_DAY, maxActive: MAX_ACTIVE_INVITES } : null);
    if (inv && inv.limit === "day") return rateLimited("You can create up to " + MEMBER_INVITES_PER_DAY + " invites a day", "retry_after" in inv && inv.retry_after ? inv.retry_after : 3600);
    if (inv && inv.limit === "active") return limitReached("This room already has " + MAX_ACTIVE_INVITES + " active invites");
    if (!inv) return json({ error: name + " already has an active invite (names match regardless of case). Revoke it first to make a new one.", code: "name_taken" }, 409);
    const created = Object.assign({ room, link: link(inv.token) }, inv);
    if (inv.kind !== "human") created.agent_onboarding = agentOnboarding(url.origin, room, inv.name, inv.token, { invitedBy: owner ? null : inviter });
    return json(created, 201);
  }
  if (request.method === "DELETE") {
    await stub.unlock();
    return json({ room, invite_only: true });
  }
  return json({ error: "Method not allowed" }, 405);
}
