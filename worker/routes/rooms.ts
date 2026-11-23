// Rooms: creation (the genesis email) and existence.

import { cleanName, escHtml, memberNameProblem, nameFold } from "../lib/text.js";
import { sendViaGmail } from "../platform/gmail.js";
import { json, rateLimited, readBody, secondsToUtcMidnight, settleBody, bodyText } from "../lib/http.js";
import { CREATE_ROOMS_PER_DAY, CREATE_ROOMS_PER_EMAIL, CREATE_ROOMS_PER_IP, PROTECTED_ROOMS, ROOM_RE, SMALL_BODY_MAX } from "../limits.js";
import type { RouteContext } from "../index.js";
import { warn } from "../lib/log.js";

// Sends the genesis invite for a freshly created room. Returns true only when
// the provider accepted the message; the caller rolls the room back on false,
// so a room never exists without its genesis invite on its way.
/** @param linkUrl the genesis invite link */
export async function sendGenesisEmail(env: Env, to: string, room: string, name: string, linkUrl: string) {
  const from = env.RESEND_FROM || "Agent Chat <rooms@send.chat.victorio.cloud>";
  const subject = "Your Agent Chat room is ready: " + room;
  const text = [
    "Hi " + name + ",",
    "",
    "Your room '" + room + "' is ready. This is its genesis invite - the first link into the room, made for your name:",
    "",
    linkUrl,
    "",
    "Open it once and your device remembers the room. Treat the link like a password: anyone who opens it joins the room as you. From inside, you can invite other people and agents, each under their own name.",
    "",
    "- Agent Chat",
  ].join("\n");
  const html = "<p>Hi " + escHtml(name) + ",</p>"
    + "<p>Your room <strong>" + escHtml(room) + "</strong> is ready. This is its genesis invite - the first link into the room, made for your name:</p>"
    + "<p><a href=\"" + linkUrl + "\">Open " + escHtml(room) + "</a></p>"
    + "<p>Open it once and your device remembers the room. Treat the link like a password: anyone who opens it joins the room as you. From inside, you can invite other people and agents, each under their own name.</p>"
    + "<p>- Agent Chat</p>";
  // Tests reach no mail provider: an address whose local part starts
  // "sent-" counts as accepted, any other as refused (TEST_HOOKS is never
  // set live; check:config fails on it).
  if (env.TEST_HOOKS) return /^sent-/.test(to);
  if (env.GMAIL_SA && env.GMAIL_SENDER) return await sendViaGmail(env, to, subject, text, html);
  if (!env.RESEND_API_KEY) return false;
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": "Bearer " + env.RESEND_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ from: from, to: to, subject: subject, text: text, html: html }),
    });
    if (!r.ok) warn("email.resend", "HTTP " + r.status);
    return r.ok;
  } catch (e) {
    warn("email.resend", e);
    return false;
  }
}

// Whether a room exists: its Room object answers from its own storage.
/** @param stub the room */
export async function roomExists(stub: DurableObjectStub) {
  return await stub.exists();
}

// Public room creation (home page form). The genesis invite is emailed to
// the creator and never returned by this API, so the address has to be
// real. Needs an email transport (Gmail or Resend secrets); until one is
// set, creation answers 503 and creates nothing. Abuse caps live in KV
// by UTC day and count ATTEMPTS (counted before the work, so a failed
// attempt still costs quota). KV counters are not atomic, so a parallel
// burst can overshoot a cap slightly - an abuse brake, not a guarantee.
export async function createRoomRoute(rc: RouteContext) {
  const { request, env, url } = rc;
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (!env.RESEND_API_KEY && !(env.GMAIL_SA && env.GMAIL_SENDER)) return json({ error: "Room creation opens soon - email delivery is not set up yet." }, 503);
  // Anyone may call this, and the body used to be read whole whatever
  // its size (a 40 MB one was parsed, then refused): a room, a name and
  // an address fit many times over in SMALL_BODY_MAX.
  const small = await settleBody(request, SMALL_BODY_MAX);
  if (!small) return json({ error: "That request's body is too large: send {\"room\", \"name\", \"email\"}." }, 413);
  const cbody = await readBody(small);
  const croom = bodyText(cbody?.room, "room").trim().toLowerCase();
  const cname = cleanName(bodyText(cbody?.name, "name"));
  const cemail = bodyText(cbody?.email, "email").trim().slice(0, 254);
  if (!ROOM_RE.test(croom)) return json({ error: "Room names are 1-64 lowercase letters, digits, - or _" }, 400);
  if (croom === "create" || croom === "api") return json({ error: "That room name is reserved" }, 400);
  if (!cname) return json({ error: "\"name\" is required" }, 400);
  if (nameFold(cname) === "referee") return json({ error: "\"Referee\" is a reserved name - it belongs to the room's game official and cannot be a member." }, 400);
  const cnameErr = memberNameProblem(cname);
  if (cnameErr) return json({ error: cnameErr }, 400);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cemail)) return json({ error: "A valid email is required" }, 400);
  const cday = new Date().toISOString().slice(0, 10);
  const cip = request.headers.get("CF-Connecting-IP") || "unknown";
  const caps: Array<[string, number]> = [["create:all:" + cday, CREATE_ROOMS_PER_DAY], ["create:email:" + cemail.toLowerCase() + ":" + cday, CREATE_ROOMS_PER_EMAIL], ["create:ip:" + cip + ":" + cday, CREATE_ROOMS_PER_IP]];
  for (const [k, max] of caps) {
    const n = parseInt((await env.REQUESTS.get(k)) || "0", 10);
    if (n >= max) return rateLimited("Too many rooms created - try again tomorrow.", secondsToUtcMidnight());
  }
  for (const [k] of caps) {
    const n = parseInt((await env.REQUESTS.get(k)) || "0", 10);
    await env.REQUESTS.put(k, String(n + 1), { expirationTtl: 172800 });
  }
  const cstub = env.ROOM.get(env.ROOM.idFromName(croom));
  const gen = await cstub.createGenesis(cname);
  if (gen.existed) return json({ error: "That room already exists" }, 409);
  const cinv = gen.invite;
  if (!cinv) {
    try { await cstub.revokeAll(); await cstub.destroy(croom); } catch (e) { warn("room.create.rollback", e, { room: croom }); }
    return json({ error: "Could not create the room's first invite" }, 500);
  }
  const clink = url.origin + "/r/" + croom + "#invite=" + cinv.token;
  let csent = false;
  try { csent = await sendGenesisEmail(env, cemail, croom, cname, clink); } catch (e) { warn("room.create.email", e, { room: croom }); }
  if (!csent) {
    try { await cstub.revokeAll(); await cstub.destroy(croom); } catch (e) { warn("room.create.rollback", e, { room: croom }); }
    return json({ error: "The invite email could not be sent, so the room was not created. Try again." }, 502);
  }
  return json({ ok: true, room: croom }, 201);
}

// Every room route passes through here: only the owner can bring a room into existence.
export async function roomRoute(rc: RouteContext, rm: RegExpMatchArray) {
  const { request, env, url, path, owner } = rc;
  let name = "";
  try { name = decodeURIComponent(rm[1]).toLowerCase(); } catch { /* a malformed escape: the empty name is refused below */ }
  const page = rm[0].charAt(1) === "r";
  if (!ROOM_RE.test(name)) {
    const bad = "Room names are 1-64 lowercase letters, digits, - or _";
    return page ? new Response(bad, { status: 400 }) : json({ error: bad }, 400);
  }
  const rstub = env.ROOM.get(env.ROOM.idFromName(name));
  const exists = await roomExists(rstub);
  if (/^\/api\/rooms\/[^/]+\/?$/.test(path)) {
    if (request.method !== "POST" && request.method !== "DELETE") return json({ error: "Method not allowed" }, 405);
    if (!owner) return json({ error: "Creating or deleting a room needs the owner key" }, 403);
    if (request.method === "POST") {
      if (exists) return json({ error: "That room already exists" }, 409);
      // create() reports whether IT made the room: a second concurrent
      // create that slipped past the exists check gets its 409 too.
      const made = await rstub.create();
      if (!made) return json({ error: "That room already exists" }, 409);
      return json({ room: name, created: true }, 201);
    }
    if (PROTECTED_ROOMS.indexOf(name) >= 0) return json({ error: "This room is protected and can't be deleted" }, 403);
    if (!exists) return json({ error: "No room with that name" }, 404);
    if (url.searchParams.get("confirm") !== name) return json({ error: "Add ?confirm=" + name + " to delete this room for good" }, 400);
    const gone = await rstub.destroy(name);
    if (gone.error) return json({ error: gone.error }, gone.status);
    return json({ room: name, deleted: true });
  }
  if (!exists) {
    if (page) return new Response("No room with that name.", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });
    return json({ error: "No room with that name yet. Create it from the home page." }, 404);
  }
}
