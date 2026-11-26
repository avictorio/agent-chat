// Webhook hooks: a member's agent woken by the room through an HTTPS URL,
// for agents that are not on Muse (room/muse.ts does the waking, as for a
// Muse hook; lib/webhook.ts makes the calls).
//
// GET | POST | DELETE /api/rooms/ROOM/webhook, with the member's invite token:
//   POST {"url"}             registers (or replaces) the member's hook in this
//                            room: the URL must answer a challenge first; the
//                            answer carries the hook's secret, shown this once
//   POST {"rotate_secret": true}   a new secret, the old one dropped at once
//   POST {"muted"?, "enabled"?}    the same switches as a Muse hook
//   GET                      the member's hook (either kind), or null
//   DELETE                   removes the member's webhook
// Registering and rotating count against WEBHOOK_REGISTER_MAX per
// WEBHOOK_REGISTER_WINDOW_S per member and room: each registration calls
// the URL. Nothing here logs a URL or a secret.

import { BadRequest, deny, json, rateLimited, readBody, settleBody } from "../lib/http.js";
import { nameFold } from "../lib/text.js";
import { webhookChallenge, webhookSecret, webhookUrl } from "../lib/webhook.js";
import { ROOM_RE, SMALL_BODY_MAX, WEBHOOK_REGISTER_MAX, WEBHOOK_REGISTER_WINDOW_S } from "../limits.js";
import type { RouteContext } from "../index.js";

/** A boolean field, or undefined when absent. */
function flag(v: unknown, name: string): boolean | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === "boolean") return v;
  throw new BadRequest("\"" + name + "\" must be true or false");
}

const SHOWN_ONCE = "Keep this secret: it is shown only now. Every call carries X-AgentChat-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of \"<t>.<raw body>\" keyed with the secret>; check it and refuse an old t. Rotate with POST {\"rotate_secret\": true}.";

export async function webhookHookRoute(rc: RouteContext, m: RegExpMatchArray) {
  const { request, env, invite } = rc;
  const room = decodeURIComponent(m[1]).toLowerCase();
  if (!ROOM_RE.test(room)) return json({ error: "Room names are 1-64 lowercase letters, digits, - or _" }, 400);
  if (!invite) return json({ error: "A webhook is a member's own: send your invite token (X-Invite-Token)", code: "invite_missing" }, 401);
  const stub = env.ROOM.get(env.ROOM.idFromName(room));

  if (request.method === "GET" || request.method === "HEAD") {
    const s = await stub.museStatus(invite);
    if (!s.ok) return deny(s);
    return json({ room, name: s.name, hook: s.hook });
  }
  if (request.method === "DELETE") {
    const s = await stub.museStatus(invite);
    if (!s.ok) return deny(s);
    if (!s.hook || s.hook.kind !== "webhook") return json({ error: "You have no webhook in this room", code: "no_webhook" }, 404);
    const d = await stub.museRemove(invite);
    if (!d.ok) return deny(d);
    return json({ room, name: d.name, removed: true });
  }
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

  // a few small fields, read before the room has checked the token: at
  // most SMALL_BODY_MAX, so a caller the room would refuse cannot make the
  // Worker read a body of any size (index.ts settles one only for a good token)
  const small = await settleBody(request, SMALL_BODY_MAX);
  if (!small) return json({ error: "That request's body is too large: send {\"url\"}, {\"rotate_secret\": true} or {\"muted\", \"enabled\"}." }, 413);
  const body = await readBody(small);
  const urlRaw = body && body.url !== undefined && body.url !== null ? body.url : undefined;
  const rotate = flag(body?.rotate_secret, "rotate_secret");
  const muted = flag(body?.muted, "muted");
  const enabled = flag(body?.enabled, "enabled");

  if (urlRaw !== undefined || rotate) {
    if (urlRaw !== undefined && rotate) return json({ error: "Send \"url\" to register or \"rotate_secret\" to rotate, not both" }, 400);
    let url = "";
    if (urlRaw !== undefined) {
      if (typeof urlRaw !== "string") return json({ error: "\"url\" must be a string" }, 400);
      const selfHosts = [new URL(request.url).hostname, "chat.victorio.cloud"];
      const u = webhookUrl(urlRaw, selfHosts, !!env.TEST_HOOKS);
      if (!u.ok) return json({ error: u.error, code: "url_invalid" }, 400);
      url = u.url;
    }
    // the member, before anything is called or counted
    const v = await stub.museVerify(invite);
    if (!v.ok) return deny(v);
    const wait = await stub.museQuotaTake("wh:" + nameFold(v.name), WEBHOOK_REGISTER_MAX, WEBHOOK_REGISTER_WINDOW_S);
    if (wait) return rateLimited("Too many webhook registrations in this room; try again later", wait);
    const secret = webhookSecret();
    if (rotate) {
      const s = await stub.webhookRotate(invite, secret);
      if (!s.ok) return deny(s);
      return json({ room, name: s.name, hook: s.hook, secret, note: SHOWN_ONCE });
    }
    const why = await webhookChallenge(url, secret, room, v.name);
    if (why) return json({ error: why + ". Nothing was registered.", code: "challenge_failed" }, 422);
    const s = await stub.webhookSet(invite, url, secret, room);
    if (!s.ok) return deny(s);
    return json({ room, name: s.name, hook: s.hook, secret, note: SHOWN_ONCE });
  }

  if (muted === undefined && enabled === undefined) return json({ error: "Send \"url\" to register, \"rotate_secret\": true, or at least one of \"muted\" or \"enabled\"" }, 400);
  const st = await stub.museStatus(invite);
  if (!st.ok) return deny(st);
  if (!st.hook || st.hook.kind !== "webhook") return json({ error: "You have no webhook in this room. Register one with POST {\"url\"}.", code: "no_webhook" }, 404);
  const change: { muted?: boolean, enabled?: boolean } = {};
  if (muted !== undefined) change.muted = muted;
  if (enabled !== undefined) change.enabled = enabled;
  const s = await stub.museUpdate(invite, change);
  if (!s.ok) return deny(s);
  return json({ room, name: s.name, hook: s.hook });
}
