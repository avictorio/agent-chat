// Rooms: creation (the genesis email) and existence.

import { cleanName, escHtml, memberNameProblem, nameFold } from "../lib/text.js";
import { sendViaGmail } from "../platform/gmail.js";
import { json, rateLimited, readBody, secondsToUtcMidnight, settleBody, bodyText } from "../lib/http.js";
import { CLONE_DELETE_ON_ROOM_DELETE, CREATE_QUOTA_ROOM, CREATE_ROOMS_PER_DAY, CREATE_ROOMS_PER_EMAIL, CREATE_ROOMS_PER_IP, MAIL_FETCH_MS, PROTECTED_ROOMS, ROOM_RE, SMALL_BODY_MAX } from "../limits.js";
import { addressKey, EMAIL_MAX, hashKey, networkKey, plainAddress } from "../lib/address.js";
import type { RouteContext } from "../index.js";
import { retryCloneDeletes } from "./voices.js";
import { startPageRoute } from "./agents.js";
import { warn } from "../lib/log.js";

// Sends the genesis invite for a freshly created room. Returns true only when
// the provider accepted the message; the caller rolls the room back on false,
// so a room never exists without its genesis invite on its way.
// The mail carries nothing the caller wrote but the room's name, in the
// body: it goes out from the site's own mailbox to any address typed in
// the form, and the creator's name in its first line and the room in its
// Subject let anyone send a stranger a line of their choosing from it.
/** @param linkUrl the genesis invite link */
export async function sendGenesisEmail(env: Env, to: string, room: string, linkUrl: string) {
  const from = env.RESEND_FROM || "Agent Chat <rooms@send.chat.victorio.cloud>";
  const subject = "Your Agent Chat room is ready";
  const text = [
    "Hello,",
    "",
    "The room '" + room + "' was created on Agent Chat with this address. This is its genesis invite - the first link into the room, made for the name chosen in the form:",
    "",
    linkUrl,
    "",
    "Open it once and your device remembers the room. Treat the link like a password: anyone who opens it joins the room as you. From inside, you can invite other people and agents, each under their own name.",
    "",
    "If you did not ask for this room, ignore this mail: nothing happens unless the link is opened.",
    "",
    "- Agent Chat",
  ].join("\n");
  const html = "<p>Hello,</p>"
    + "<p>The room <strong>" + escHtml(room) + "</strong> was created on Agent Chat with this address. This is its genesis invite - the first link into the room, made for the name chosen in the form:</p>"
    + "<p><a href=\"" + linkUrl + "\">Open " + escHtml(room) + "</a></p>"
    + "<p>Open it once and your device remembers the room. Treat the link like a password: anyone who opens it joins the room as you. From inside, you can invite other people and agents, each under their own name.</p>"
    + "<p>If you did not ask for this room, ignore this mail: nothing happens unless the link is opened.</p>"
    + "<p>- Agent Chat</p>";
  // Tests reach no mail provider: an address whose local part starts
  // "sent-" counts as accepted, any other as refused, and one starting
  // "slow-" waits a few seconds first, as a mail provider can (TEST_HOOKS
  // is never set live; check:config fails on it).
  if (env.TEST_HOOKS) {
    if (/^slow-/.test(to)) await new Promise((r) => setTimeout(r, 2500));
    return /^(?:slow-)?sent-/.test(to);
  }
  if (env.GMAIL_SA && env.GMAIL_SENDER) return await sendViaGmail(env, to, subject, text, html);
  if (!env.RESEND_API_KEY) return false;
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": "Bearer " + env.RESEND_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ from: from, to: to, subject: subject, text: text, html: html }),
      signal: AbortSignal.timeout(MAIL_FETCH_MS),
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

/** The answer to a creator who meets a room still waiting on its genesis mail. */
function genesisPending(retryAfter: number) {
  return json({ error: "Someone is creating a room with that name right now. If their invite mail does not go out, the name is free again in a few minutes.", code: "room_pending" }, 503, { "Retry-After": String(retryAfter) });
}

// Public room creation (home page form). The genesis invite is emailed to
// the creator and never returned by this API, so the address has to be
// real. Needs an email transport (Gmail or Resend secrets); until one is
// set, creation answers 503 and creates nothing.
// A taken name answers 409 before anything is counted or mailed, and a
// pending one 503 (genesisCheck). The caps (per day, per address, per
// network) count rooms created: one call to the CREATE_QUOTA_ROOM object
// checks all three and takes a place (createReserve), given back when
// the creation then makes nothing (createRelease). They counted attempts
// in KV before: thirty calls at a taken name closed creation for the
// day, three taken names locked a person out, the 429's arrival told
// anyone how many rooms an address had tried, and KV's separate read and
// write let a parallel burst through every cap. One 429 sentence serves
// all three: answering a capped address as if it had succeeded would
// leave a real person waiting for a mail that never comes.
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
  const cemail = bodyText(cbody?.email, "email").trim();
  if (!ROOM_RE.test(croom)) return json({ error: "Room names are 1-64 lowercase letters, digits, - or _" }, 400);
  if (croom === "create" || croom === "api") return json({ error: "That room name is reserved" }, 400);
  if (!cname) return json({ error: "\"name\" is required" }, 400);
  if (nameFold(cname) === "referee") return json({ error: "\"Referee\" is a reserved name - it belongs to the room's game official and cannot be a member." }, 400);
  const cnameErr = memberNameProblem(cname);
  if (cnameErr) return json({ error: cnameErr }, 400);
  if (!plainAddress(cemail)) return json({ error: "\"email\" must be a plain address like name@example.com, at most " + EMAIL_MAX + " characters: no display name, angle brackets, commas, semicolons, colons or spaces.", code: "email_invalid" }, 400);
  const cstub = env.ROOM.get(env.ROOM.idFromName(croom));
  const seen = await cstub.genesisCheck();
  if (seen.state === "taken") return json({ error: "That room already exists" }, 409);
  if (seen.state === "pending") return genesisPending(seen.retry_after);
  const day = new Date().toISOString().slice(0, 10);
  const caps: Array<[string, number]> = [
    ["all:" + day, CREATE_ROOMS_PER_DAY],
    ["email:" + (await hashKey(addressKey(cemail))) + ":" + day, CREATE_ROOMS_PER_EMAIL],
    ["ip:" + (await hashKey(networkKey(request.headers.get("CF-Connecting-IP")))) + ":" + day, CREATE_ROOMS_PER_IP],
  ];
  // From here the room, its invite, the mail and the rollback run to
  // their end even if the caller goes away: cancelled in the mail's wait,
  // the request used to leave a room whose only invite nobody received.
  const work = createRoomNow(env, url, cstub, croom, cname, cemail, caps, day);
  rc.ctx.waitUntil(work.catch(() => undefined));
  return await work;
}

async function createRoomNow(env: Env, url: URL, cstub: DurableObjectStub, croom: string, cname: string, cemail: string, caps: Array<[string, number]>, day: string): Promise<Response> {
  const quota = env.ROOM.get(env.ROOM.idFromName(CREATE_QUOTA_ROOM));
  if (!(await quota.createReserve(caps, day))) return rateLimited("Too many rooms created - try again tomorrow.", secondsToUtcMidnight());
  let kept = false;
  try {
    const gen = await cstub.createGenesis(cname);
    if ("existed" in gen) return json({ error: "That room already exists" }, 409);
    if ("pending" in gen) return genesisPending(gen.retry_after);
    const cinv = gen.invite;
    if (!cinv) {
      try { await cstub.revokeAll(); await cstub.destroy(croom); } catch (e) { warn("room.create.rollback", e, { room: croom }); }
      return json({ error: "Could not create the room's first invite" }, 500);
    }
    const clink = url.origin + "/r/" + croom + "#invite=" + cinv.token;
    let csent = false;
    try { csent = await sendGenesisEmail(env, cemail, croom, clink); } catch (e) { warn("room.create.email", e, { room: croom }); }
    if (!csent) {
      try { await cstub.abandonGenesis(cinv.token, croom); } catch (e) { warn("room.create.rollback", e, { room: croom }); }
      return json({ error: "The invite email could not be sent, so the room was not created. Try again." }, 502);
    }
    kept = true;
    // Unconfirmed, the room stays pending: its first open confirms it too.
    try { await cstub.confirmGenesis(cinv.token); } catch (e) { warn("room.create.confirm", e, { room: croom }); }
    return json({ ok: true, room: croom }, 201);
  } finally {
    if (!kept) { try { await quota.createRelease(caps.map((c) => c[0])); } catch (e) { warn("room.create.release", e, { room: croom }); } }
  }
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
  const exact = /^\/api\/rooms\/[^/]+\/?$/.test(path);
  // The room's own address. POST and DELETE, with the owner key, create and
  // delete the room; GET and HEAD are the start page (routes/agents.ts
  // startPageRoute), answered below once the room is known to exist.
  if (exact && request.method !== "GET" && request.method !== "HEAD") {
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
    // The clones members asked to delete that Cartesia has not confirmed
    // (room/voices.ts, voiceDelPend) are tried as the room goes; destroy
    // keeps the ones still refused, so their ids are not lost with it.
    if (env.CARTESIA_API_KEY) rc.ctx.waitUntil(retryCloneDeletes(env, rstub, name, CLONE_DELETE_ON_ROOM_DELETE));
    const gone = await rstub.destroy(name);
    if (gone.error) return json({ error: gone.error }, gone.status);
    return json({ room: name, deleted: true });
  }
  if (!exists) {
    if (page) return new Response("No room with that name.", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });
    return json({ error: "No room with that name yet. Create it from the home page." }, 404);
  }
  if (exact) return startPageRoute(rc, rstub, name);
}
