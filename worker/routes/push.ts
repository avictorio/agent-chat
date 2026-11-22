// Web Push: the site's public key and members' subscriptions.

import { deny, json, readBody, bodyText, bodyObject } from "../lib/http.js";
import { PUSH_HOST_RE, ROOM_RE } from "../limits.js";
import { b64urlDecode } from "../lib/crypto.js";
import type { RouteContext } from "../index.js";

export async function pushKeyRoute(rc: RouteContext) {
  const { env } = rc;
  const keys = env.ROOM.get(env.ROOM.idFromName("__vapid"));
  return json({ key: await keys.vapidPublic() });
}

// Web Push subscriptions for a room, tied to the invite's member name.
export async function pushRoute(rc: RouteContext, m: RegExpMatchArray) {
  const { request, env, url, owner, invite } = rc;
  const room = decodeURIComponent(m[1]).toLowerCase();
  if (!ROOM_RE.test(room)) return json({ error: "Room names are 1-64 lowercase letters, digits, - or _" }, 400);
  const stub = env.ROOM.get(env.ROOM.idFromName(room));
  const acc = await stub.access(invite, owner);
  if (!acc.ok) return deny(acc);
  const action = m[2];
  if (action === "status") {
    if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);
    return json(Object.assign({ room }, await stub.pushStatus(acc.name || "", url.searchParams.get("endpoint") || "")));
  }
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const body = await readBody(request);
  if (action === "subscribe") {
    const sub = bodyObject(body?.subscription, "subscription") || {};
    const keysIn = bodyObject(sub.keys, "subscription.keys") || {};
    const endpoint = bodyText(sub.endpoint, "subscription.endpoint");
    const p256dh = bodyText(keysIn.p256dh, "subscription.keys.p256dh");
    const auth = bodyText(keysIn.auth, "subscription.keys.auth");
    if (!/^https:\/\//.test(endpoint)) return json({ error: "subscription.endpoint must be an https URL" }, 400);
    let pushHost = "";
    try { pushHost = new URL(endpoint).hostname.toLowerCase(); } catch { /* not a URL: refused below */ }
    if (!PUSH_HOST_RE.test(pushHost)) return json({ error: "subscription.endpoint must be a browser push service URL" }, 400);
    // b64urlDecode throws on malformed input (bad characters, impossible
    // lengths): validate like every other base64 input and
    // answer 400, not an unhandled 500.
    let pLen = -1, aLen = -1;
    try { pLen = b64urlDecode(p256dh).length; } catch { /* refused below */ }
    try { aLen = b64urlDecode(auth).length; } catch { /* refused below */ }
    if (pLen !== 65) return json({ error: "subscription.keys.p256dh is not a 65-byte public key" }, 400);
    if (aLen < 16) return json({ error: "subscription.keys.auth looks too short" }, 400);
    // a missing body has no endpoint, refused above
    const mode = body && body.mode === "mentions" ? "mentions" : "all";
    await stub.pushSubscribe(acc.name || "", { endpoint: endpoint, p256dh: p256dh, auth: auth }, mode);
    return json({ room, subscribed: true, mode: mode });
  }
  const endpoint = bodyText(body?.endpoint, "endpoint");
  if (!endpoint) return json({ error: "\"endpoint\" is required" }, 400);
  await stub.pushUnsubscribe(acc.name || "", endpoint, owner);
  return json({ room, subscribed: false });
}
