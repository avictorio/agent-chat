// Test hooks: inert unless the Worker runs with TEST_HOOKS set (the API
// suite's .dev.vars only - never wrangler.toml; check:config fails if the
// name ever appears in the live config). Owner key required regardless.

import { json, readBody } from "../lib/http.js";
import { ROOM_RE } from "../limits.js";
import { sigv4Presign } from "../platform/r2-s3.js";
import type { RouteContext } from "../index.js";

export async function hookGameImages(rc: RouteContext) {
  const { request, env, owner } = rc;
  if (!env.TEST_HOOKS) return json({ error: "Not found" }, 404);
  if (!owner) return json({ error: "The owner key is required" }, 403);
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const tb = await readBody(request);
  const troom = String((tb && tb.room) || "").toLowerCase();
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
  const troom = String((tb && tb.room) || "").toLowerCase();
  if (!ROOM_RE.test(troom)) return json({ error: "A valid room is required" }, 400);
  const tstub = env.ROOM.get(env.ROOM.idFromName(troom));
  return json(await tstub.setTestR2Fail(!!(tb && tb.on)));
}

export async function hookTicketTtl(rc: RouteContext) {
  const { request, env, owner } = rc;
  if (!env.TEST_HOOKS) return json({ error: "Not found" }, 404);
  if (!owner) return json({ error: "The owner key is required" }, 403);
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const tb = await readBody(request);
  const troom = String((tb && tb.room) || "").toLowerCase();
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
  const troom = String((tb && tb.room) || "").toLowerCase();
  if (!ROOM_RE.test(troom)) return json({ error: "A valid room is required" }, 400);
  const tstub = env.ROOM.get(env.ROOM.idFromName(troom));
  return json(await tstub.setTestCrSecret(parseInt(tb && tb.id, 10), tb && tb.secret));
}

export async function hookGameExpire(rc: RouteContext) {
  const { request, env, owner } = rc;
  if (!env.TEST_HOOKS) return json({ error: "Not found" }, 404);
  if (!owner) return json({ error: "The owner key is required" }, 403);
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const tb = await readBody(request);
  const troom = String((tb && tb.room) || "").toLowerCase();
  if (!ROOM_RE.test(troom)) return json({ error: "A valid room is required" }, 400);
  const tstub = env.ROOM.get(env.ROOM.idFromName(troom));
  return json(await tstub.setTestGameExpire(parseInt(tb && tb.id, 10)));
}

export async function hookSketchJudge(rc: RouteContext) {
  const { request, env, owner } = rc;
  if (!env.TEST_HOOKS) return json({ error: "Not found" }, 404);
  if (!owner) return json({ error: "The owner key is required" }, 403);
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const tb = await readBody(request);
  const troom = String((tb && tb.room) || "").toLowerCase();
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
  const troom = String((tb && tb.room) || "").toLowerCase();
  if (!ROOM_RE.test(troom)) return json({ error: "A valid room is required" }, 400);
  const tstub = env.ROOM.get(env.ROOM.idFromName(troom));
  return json(await tstub.setTestLetterGrid(parseInt(tb && tb.id, 10), tb && tb.rows));
}

export async function hookSigv4(rc: RouteContext) {
  const { request, env, owner } = rc;
  if (!env.TEST_HOOKS) return json({ error: "Not found" }, 404);
  if (!owner) return json({ error: "The owner key is required" }, 403);
  const sb = await readBody(request);
  if (!sb) return json({ error: "Send the inputs as JSON" }, 400);
  return json({ url: await sigv4Presign({ method: sb.method, host: sb.host, path: sb.path, query: sb.query, accessKey: sb.accessKey, secretKey: sb.secretKey, region: sb.region, expires: sb.expires, date: new Date(sb.date) }) });
}

export async function hookLiarsDice(rc: RouteContext) {
  const { request, env, owner } = rc;
  if (!env.TEST_HOOKS) return json({ error: "Not found" }, 404);
  if (!owner) return json({ error: "The owner key is required" }, 403);
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const tb = await readBody(request);
  const troom = String((tb && tb.room) || "").toLowerCase();
  if (!ROOM_RE.test(troom)) return json({ error: "A valid room is required" }, 400);
  const tstub = env.ROOM.get(env.ROOM.idFromName(troom));
  return json(await tstub.setTestLiarsDice(parseInt(tb && tb.id, 10), tb && tb.cups, !!(tb && tb.expire)));
}
