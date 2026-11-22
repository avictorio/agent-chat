// Test hooks: inert unless the Worker runs with TEST_HOOKS set, as only the
// API suite's local server does (--var). check:config fails if the name ever appears
// in the live config. Owner key required regardless.

import { json, readBody, bodyText, bodyNumber, bodyObject } from "../lib/http.js";
import { ROOM_RE } from "../limits.js";
import { sigv4Presign } from "../platform/r2-s3.js";
import type { RouteContext } from "../index.js";

export async function hookGameImages(rc: RouteContext) {
  const { request, env, owner } = rc;
  if (!env.TEST_HOOKS) return json({ error: "Not found" }, 404);
  if (!owner) return json({ error: "The owner key is required" }, 403);
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const tb = await readBody(request);
  const troom = bodyText(tb?.room, "room").toLowerCase();
  if (!ROOM_RE.test(troom)) return json({ error: "A valid room is required" }, 400);
  const listed = await env.MEDIA.list({ prefix: "games/" + troom + "/" });
  return json({ count: listed.objects.length });
}

export async function hookR2Fail(rc: RouteContext) {
  const { request, env, owner } = rc;
  if (!env.TEST_HOOKS) return json({ error: "Not found" }, 404);
  if (!owner) return json({ error: "The owner key is required" }, 403);
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const tb = await readBody(request);
  const troom = bodyText(tb?.room, "room").toLowerCase();
  if (!ROOM_RE.test(troom)) return json({ error: "A valid room is required" }, 400);
  const tstub = env.ROOM.get(env.ROOM.idFromName(troom));
  return json(await tstub.setTestR2Fail(!!(tb && tb.on)));
}

export async function hookR2Delay(rc: RouteContext) {
  const { request, env, owner } = rc;
  if (!env.TEST_HOOKS) return json({ error: "Not found" }, 404);
  if (!owner) return json({ error: "The owner key is required" }, 403);
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const tb = await readBody(request);
  const troom = bodyText(tb?.room, "room").toLowerCase();
  if (!ROOM_RE.test(troom)) return json({ error: "A valid room is required" }, 400);
  const tstub = env.ROOM.get(env.ROOM.idFromName(troom));
  return json(await tstub.setTestR2Delay(tb && tb.ms));
}

export async function hookTicketTtl(rc: RouteContext) {
  const { request, env, owner } = rc;
  if (!env.TEST_HOOKS) return json({ error: "Not found" }, 404);
  if (!owner) return json({ error: "The owner key is required" }, 403);
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const tb = await readBody(request);
  const troom = bodyText(tb?.room, "room").toLowerCase();
  if (!ROOM_RE.test(troom)) return json({ error: "A valid room is required" }, 400);
  const tstub = env.ROOM.get(env.ROOM.idFromName(troom));
  return json(await tstub.setTestTicketTtl(tb && tb.ttl_ms));
}

export async function hookCoderaceSecret(rc: RouteContext) {
  const { request, env, owner } = rc;
  if (!env.TEST_HOOKS) return json({ error: "Not found" }, 404);
  if (!owner) return json({ error: "The owner key is required" }, 403);
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const tb = await readBody(request);
  const troom = bodyText(tb?.room, "room").toLowerCase();
  if (!ROOM_RE.test(troom)) return json({ error: "A valid room is required" }, 400);
  const tstub = env.ROOM.get(env.ROOM.idFromName(troom));
  return json(await tstub.setTestCrSecret(bodyNumber(tb?.id, "id", true), tb && tb.secret));
}

export async function hookGameExpire(rc: RouteContext) {
  const { request, env, owner } = rc;
  if (!env.TEST_HOOKS) return json({ error: "Not found" }, 404);
  if (!owner) return json({ error: "The owner key is required" }, 403);
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const tb = await readBody(request);
  const troom = bodyText(tb?.room, "room").toLowerCase();
  if (!ROOM_RE.test(troom)) return json({ error: "A valid room is required" }, 400);
  const tstub = env.ROOM.get(env.ROOM.idFromName(troom));
  return json(await tstub.setTestGameExpire(bodyNumber(tb?.id, "id", true)));
}

// POST {room, id}: run the room's alarm now and report the match as stored.
export async function hookAlarm(rc: RouteContext) {
  const { request, env, owner } = rc;
  if (!env.TEST_HOOKS) return json({ error: "Not found" }, 404);
  if (!owner) return json({ error: "The owner key is required" }, 403);
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const tb = await readBody(request);
  const troom = bodyText(tb?.room, "room").toLowerCase();
  if (!ROOM_RE.test(troom)) return json({ error: "A valid room is required" }, 400);
  const tstub = env.ROOM.get(env.ROOM.idFromName(troom));
  return json(await tstub.testRunAlarm(bodyNumber(tb?.id, "id", true)));
}

export async function hookSketchJudge(rc: RouteContext) {
  const { request, env, owner } = rc;
  if (!env.TEST_HOOKS) return json({ error: "Not found" }, 404);
  if (!owner) return json({ error: "The owner key is required" }, 403);
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const tb = await readBody(request);
  const troom = bodyText(tb?.room, "room").toLowerCase();
  if (!ROOM_RE.test(troom)) return json({ error: "A valid room is required" }, 400);
  const tstub = env.ROOM.get(env.ROOM.idFromName(troom));
  return json(await tstub.setTestSketchJudge(tb && tb.verdict));
}

export async function hookLetterGrid(rc: RouteContext) {
  const { request, env, owner } = rc;
  if (!env.TEST_HOOKS) return json({ error: "Not found" }, 404);
  if (!owner) return json({ error: "The owner key is required" }, 403);
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const tb = await readBody(request);
  const troom = bodyText(tb?.room, "room").toLowerCase();
  if (!ROOM_RE.test(troom)) return json({ error: "A valid room is required" }, 400);
  const tstub = env.ROOM.get(env.ROOM.idFromName(troom));
  return json(await tstub.setTestLetterGrid(bodyNumber(tb?.id, "id", true), tb && tb.rows));
}

export async function hookSigv4(rc: RouteContext) {
  const { request, env, owner } = rc;
  if (!env.TEST_HOOKS) return json({ error: "Not found" }, 404);
  if (!owner) return json({ error: "The owner key is required" }, 403);
  const sb = await readBody(request);
  if (!sb) return json({ error: "Send the inputs as JSON" }, 400);
  const query = bodyObject(sb.query, "query");
  return json({ url: await sigv4Presign({ method: bodyText(sb.method, "method"), host: bodyText(sb.host, "host"), path: bodyText(sb.path, "path"), query: query as Record<string, string> | null, accessKey: bodyText(sb.accessKey, "accessKey"), secretKey: bodyText(sb.secretKey, "secretKey"), region: bodyText(sb.region, "region"), expires: bodyNumber(sb.expires, "expires"), date: new Date(bodyText(sb.date, "date")) }) });
}

export async function hookLiarsDice(rc: RouteContext) {
  const { request, env, owner } = rc;
  if (!env.TEST_HOOKS) return json({ error: "Not found" }, 404);
  if (!owner) return json({ error: "The owner key is required" }, 403);
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const tb = await readBody(request);
  const troom = bodyText(tb?.room, "room").toLowerCase();
  if (!ROOM_RE.test(troom)) return json({ error: "A valid room is required" }, 400);
  const tstub = env.ROOM.get(env.ROOM.idFromName(troom));
  return json(await tstub.setTestLiarsDice(bodyNumber(tb?.id, "id", true), bodyObject(tb?.cups, "cups"), !!(tb && tb.expire)));
}
