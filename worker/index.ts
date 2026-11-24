// Source of truth: https://github.com/avictorio/agent-chat (worker/; this is the main module).
// Deploy by pushing to main: Cloudflare Workers Builds deploys every push. Uploads made any other way
// (API, dashboard, a local wrangler deploy) are overwritten by the next push. See AGENTS.md.
import { BadRequest, CORS, json, settleBody } from "./lib/http.js";
import { GONE_MSG, isGoneError } from "./lib/errors.js";
import { AUDIO_MAX, AVATAR_MAX, IMAGE_MAX, inlineBodyCap, mb, mediaTooBig, MIB, ROOM_RE, SETTLED_BODY_MAX, VIDEO_MAX, VOICE_SAMPLE_MAX } from "./limits.js";
import { MCP_PATH, headerToken, queryToken, queryTokenNotice } from "./lib/tokens.js";
import { renewDirectVerdict } from "./platform/r2-direct-check.js";
import { r2DirectConfigured } from "./platform/r2-s3.js";
import {
  uploadLinkRoute,
  uploadLinkStepRoute,
  uploadResumeRoute,
  uploadRoute,
  uploadTicketRoute,
  videoStreamRoute,
} from "./routes/uploads.js";
import {
  apiDocsRoute,
  currentBuildId,
  emojiRoute,
  manifestRoute,
  museGadgetRoute,
  museTermsRoute,
  page,
  roomPageRoute,
  serviceWorkerRoute,
} from "./routes/pages.js";
import { createRoomRoute, roomRoute } from "./routes/rooms.js";
import { streamRoute } from "./routes/stream.js";
import {
  hookCoderaceSecret,
  hookAlarm,
  hookGameExpire,
  hookGameImages,
  hookLetterGrid,
  hookLiarsDice,
  hookMuse,
  hookR2Delay,
  hookR2Fail,
  hookSigv4,
  hookSketchJudge,
  hookTicketTtl,
} from "./routes/test-hooks.js";
import { pushKeyRoute, pushRoute } from "./routes/push.js";
import { changesRoute, mcpRoute, recipeRoute, toolsRoute } from "./routes/agents.js";
import { invitePreviewRoute, invitesRoute, meRoute, memberRoute } from "./routes/members.js";
import { boardRoute, constitutionRoute, questionsRoute } from "./routes/board.js";
import { gamesRoute, sketchImageRoute } from "./routes/games.js";
import { artifactRoute, audioRoute, avatarRoute, imageRoute, videoRoute } from "./routes/media.js";
import { speakRoute, voiceRoute } from "./routes/voices.js";
import { museHandoverRoute, museHookRoute, museRegisterRoute, type MuseHandover } from "./routes/muse.js";

import {
  attachmentsRoute,
  messageRoute,
  messagesRoute,
  publishRoute,
  reactionsRoute,
} from "./routes/messages.js";

// The Durable Object class must be exported from the main module.
export { Room } from "./room/Room.js";

/** What every route handler gets: the request and the bindings, the parsed
 *  URL and its path, whether the owner key came with it, and the invite
 *  token from a header (X-Invite-Token or Authorization: Bearer; on the MCP
 *  route also ?invite=), and the request's ctx, whose waitUntil carries work
 *  that must finish even if the client goes away. */
export type RouteContext = { request: Request, env: Env, url: URL, path: string, owner: boolean, invite: string, ctx: ExecutionContext };

/** ?pretty=1: the JSON answer indented, for a person reading it raw. */
async function prettyIfAsked(request: Request, res: Response): Promise<Response> {
  if (new URL(request.url).searchParams.get("pretty") !== "1") return res;
  if (!(res.headers.get("Content-Type") || "").includes("application/json") || !res.body) return res;
  const text = await res.text();
  let out = text;
  try { out = JSON.stringify(JSON.parse(text), null, 2); } catch { /* not JSON after all: send it as it was */ }
  const headers = new Headers(res.headers);
  headers.delete("Content-Length");
  return new Response(out, { status: res.status, statusText: res.statusText, headers });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    try {
      return await prettyIfAsked(request, await queryTokenNotice(request, await routeRequest(request, env, ctx)));
    } catch (e) {
      // A malformed %-escape in a path segment (decodeURIComponent throws
      // URIError) is the client's mistake: answer 400, not a 500.
      if (e instanceof URIError) return json({ error: "The URL has a malformed %-escape" }, 400);
      // A body that is there but is not JSON (lib/http.ts readBody).
      if (e instanceof BadRequest) return json({ error: e.message }, 400);
      // The room was deleted while the request was in flight (Room.fence):
      // it stopped before writing anything, so say that, not 500.
      if (isGoneError(e)) return json({ error: GONE_MSG, code: "room_deleted" }, 410);
      throw e;
    }
  },
};

// The two routes whose bodies are files streamed into storage as they
// arrive (a part of up to 90 MiB, a video): they are never held in
// memory, and they look at the invite again once the stream ends.
const STREAMED_BODY = /^\/api\/rooms\/[^/]+\/messages\/\d+\/(?:video\/stream|(?:image|audio|video|file)\/part)\/?$/;

// The routes that take one file in one request, with a documented cap
// below SETTLED_BODY_MAX, and their 413. Their own Content-Length check
// came after the body had already been read here, so a member's chunked
// voice sample or avatar was held up to SETTLED_BODY_MAX (48 MiB) before
// its 14 MB or 3 MB cap was looked at.
const BODY_CAPS: Array<[RegExp, number, string]> = [
  [/^\/api\/rooms\/[^/]+\/(?:avatar|members\/[^/]+\/avatar)\/?$/, inlineBodyCap(AVATAR_MAX), "Avatars can be up to " + mb(AVATAR_MAX)],
  [/^\/api\/rooms\/[^/]+\/(?:voice|members\/[^/]+\/voice)\/sample\/?$/, inlineBodyCap(VOICE_SAMPLE_MAX), "Voice samples can be up to " + mb(VOICE_SAMPLE_MAX)],
  [/^\/api\/rooms\/[^/]+\/messages\/\d+\/audio\/?$/, inlineBodyCap(AUDIO_MAX), mediaTooBig("audio", "inline")],
  [/^\/api\/rooms\/[^/]+\/messages\/\d+\/image\/?$/, inlineBodyCap(IMAGE_MAX), mediaTooBig("image", "inline")],
  [/^\/api\/rooms\/[^/]+\/messages\/\d+\/video\/?$/, inlineBodyCap(VIDEO_MAX), mediaTooBig("video", "inline")],
];

// A member's request to a room waits here for its whole body, so that
// the route's invite check comes after it (lib/http.ts settleBody says
// why). Only for a request whose invite is good right now: anyone else
// is refused by the route as before, with the body left unread. The
// owner key is not an invite and cannot be revoked, but its body is
// read here too, under the same caps: it was read whole by the route,
// whatever its size, up to the edge's 100 MB. The cap is the route's
// own (BODY_CAPS), or SETTLED_BODY_MAX; a declared Content-Length over
// it is refused before anything is read, and a body sent without one
// is read only up to it.
/** @returns an answer to send now (the body is too large), or nothing */
async function settleRoomBody(rc: RouteContext): Promise<Response | undefined> {
  const { request, env, path, owner, invite } = rc;
  if ((!owner && !invite) || !request.body || STREAMED_BODY.test(path)) return undefined;
  const m = /^\/api\/rooms\/([^/]+)\//.exec(path);
  if (!m) return undefined;
  let room = "";
  try { room = decodeURIComponent(m[1]).toLowerCase(); } catch { return undefined; /* the route answers the malformed escape */ }
  if (!ROOM_RE.test(room)) return undefined;
  if (!owner) {
    const known = await env.ROOM.get(env.ROOM.idFromName(room)).lookupInvite(invite);
    if (!known.ok) return undefined;
  }
  const own = BODY_CAPS.find(([re]) => re.test(path));
  const cap = own ? own[1] : SETTLED_BODY_MAX;
  const settled = await settleBody(request, cap);
  if (!settled) return json({ error: own ? own[2] : "That request's body is over " + Math.floor(SETTLED_BODY_MAX / MIB) + " MiB. Bigger files go up in parts: see UPLOADING FILES at /api." }, 413);
  rc.request = settled;
  return undefined;
}

async function routeRequest(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  {
    const url = new URL(request.url);
    const path = url.pathname;
    const owner = !!env.OWNER_KEY && request.headers.get("X-Owner-Key") === env.OWNER_KEY;
    // The invite token: X-Invite-Token, else Authorization: Bearer (the
    // alias for MCP clients that can set only a bearer token). A token in
    // the URL (?invite=) is retired (lib/tokens.ts): only
    // POST /api/rooms/ROOM/mcp still reads it, for MCP clients configured
    // with a URL alone, and a header wins there too.
    const invite = headerToken(request) || (MCP_PATH.test(path) ? queryToken(url) : "");
    const rc: RouteContext = { request, env, url, path, owner, invite, ctx };

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    {
      const early = await settleRoomBody(rc);
      if (early) return early;
    }
    if (path === "/") return page(env, url.origin);
    if (path === "/api/build") {
      // Every open page asks this every few minutes, which makes it the
      // place to keep the direct-upload check fresh (r2-direct-check.ts),
      // so that no upload's start has to wait for it.
      if (env.R2_DIRECT === "1" && r2DirectConfigured(env)) ctx.waitUntil(renewDirectVerdict(env).catch(() => undefined));
      return json({ build: await currentBuildId(env, url.origin) });
    }
    if (path === "/api/changes") return changesRoute(rc);
    if (path === "/api/test-hooks/game-images") { const r = await hookGameImages(rc); if (r !== undefined) return r; }
    if (path === "/api/test-hooks/r2-fail") { const r = await hookR2Fail(rc); if (r !== undefined) return r; }
    if (path === "/api/test-hooks/r2-delay") { const r = await hookR2Delay(rc); if (r !== undefined) return r; }
    if (path === "/api/test-hooks/ticket-ttl") { const r = await hookTicketTtl(rc); if (r !== undefined) return r; }
    if (path === "/api/test-hooks/coderace-secret") { const r = await hookCoderaceSecret(rc); if (r !== undefined) return r; }
    if (path === "/api/test-hooks/game-expire") { const r = await hookGameExpire(rc); if (r !== undefined) return r; }
    if (path === "/api/test-hooks/alarm") { const r = await hookAlarm(rc); if (r !== undefined) return r; }
    if (path === "/api/test-hooks/sketch-judge") { const r = await hookSketchJudge(rc); if (r !== undefined) return r; }
    if (path === "/api/test-hooks/lettergrid") { const r = await hookLetterGrid(rc); if (r !== undefined) return r; }
    if (path === "/api/test-hooks/sigv4") { const r = await hookSigv4(rc); if (r !== undefined) return r; }
    if (path === "/api/test-hooks/liarsdice") { const r = await hookLiarsDice(rc); if (r !== undefined) return r; }
    if (path === "/api/test-hooks/muse") { const r = await hookMuse(rc); if (r !== undefined) return r; }
    const usm = path.match(/^\/api\/uploads\/([^/]+)\/([^/]+)\/(part|sign|status|finish|abort)\/?$/);
    if (usm) { const r = await uploadLinkStepRoute(rc, usm); if (r !== undefined) return r; }
    const um = path.match(/^\/api\/uploads\/([^/]+)\/([^/]+)\/?$/);
    if (um) { const r = await uploadLinkRoute(rc, um); if (r !== undefined) return r; }
    if (path === "/emoji.json") { const r = await emojiRoute(rc); if (r !== undefined) return r; }
    if (path === "/api" || path === "/api/" || path === "/api/docs" || path === "/api.txt" || path === "/llms.txt" || path === "/api/games" || path === "/api/games.txt") { const r = await apiDocsRoute(rc); if (r !== undefined) return r; }

    if (path === "/api/create-room") { const r = await createRoomRoute(rc); if (r !== undefined) return r; }
    if (path === "/api/muse/hooks" || path === "/api/muse/hooks/") return museRegisterRoute(rc);
    {
      // the Muse gadget's handover (no member token: routes/muse.ts)
      const hm = /^\/api\/muse\/(connect|update|disconnect|status|seal-key)\/?$/.exec(path);
      if (hm) return museHandoverRoute(rc, hm[1] as MuseHandover);
    }
    if (path === "/muse-terms" || path === "/muse-terms/") { const r = await museTermsRoute(rc); if (r !== undefined) return r; }
    if (path === "/muse-gadget" || path === "/muse-gadget/") { const r = await museGadgetRoute(rc); if (r !== undefined) return r; }

    const rm = path.match(/^\/(?:r|api\/rooms)\/([^/]+)/);
    if (rm) { const r = await roomRoute(rc, rm); if (r !== undefined) return r; }

    if (path === "/manifest.webmanifest" && request.method === "GET") { const r = await manifestRoute(); if (r !== undefined) return r; }
    if (path === "/sw.js" && request.method === "GET") { const r = await serviceWorkerRoute(); if (r !== undefined) return r; }
    if (path === "/api/push/key" && request.method === "GET") { const r = await pushKeyRoute(rc); if (r !== undefined) return r; }

    let m = path.match(/^\/r\/([^/]+)\/?$/);
    if (m) { const r = await roomPageRoute(rc, m); if (r !== undefined) return r; }

    m = path.match(/^\/api\/rooms\/([^/]+)\/stream\/?$/);
    if (m) { const r = await streamRoute(rc, m); if (r !== undefined) return r; }

    m = path.match(/^\/api\/rooms\/([^/]+)\/agent-recipe(?:\/(script))?\/?$/);
    if (m) { const r = await recipeRoute(rc, m); if (r !== undefined) return r; }

    m = path.match(/^\/api\/rooms\/([^/]+)\/tools(?:\/([a-z]+))?\/?$/);
    if (m) { const r = await toolsRoute(rc, m); if (r !== undefined) return r; }

    m = path.match(MCP_PATH);
    if (m) { const r = await mcpRoute(rc, m); if (r !== undefined) return r; }

    m = path.match(/^\/api\/rooms\/([^/]+)\/(?:avatar|members\/([^/]+)\/avatar|avatars\/([^/]+))\/?$/);
    if (m) { const r = await avatarRoute(rc, m); if (r !== undefined) return r; }

    m = path.match(/^\/api\/rooms\/([^/]+)\/(?:voice(?:\/(sample|reclone))?|members\/([^/]+)\/voice(?:\/(sample|reclone))?)\/?$/);
    if (m) { const r = await voiceRoute(rc, m); if (r !== undefined) return r; }

    m = path.match(/^\/api\/rooms\/([^/]+)\/members\/([^/]+)\/?$/);
    if (m) { const r = await memberRoute(rc, m); if (r !== undefined) return r; }

    m = path.match(/^\/api\/rooms\/([^/]+)\/muse-hook\/?$/);
    if (m) return museHookRoute(rc, m);

    m = path.match(/^\/api\/rooms\/([^/]+)\/me\/?$/);
    if (m) { const r = await meRoute(rc, m); if (r !== undefined) return r; }

    m = path.match(/^\/api\/rooms\/([^/]+)\/invite\/?$/);
    if (m) { const r = await invitePreviewRoute(rc, m); if (r !== undefined) return r; }

    m = path.match(/^\/api\/rooms\/([^/]+)\/invites(?:\/([^/]+))?\/?$/);
    if (m) { const r = await invitesRoute(rc, m); if (r !== undefined) return r; }

    m = path.match(/^\/api\/rooms\/([^/]+)\/constitution\/?$/);
    if (m) { const r = await constitutionRoute(rc, m); if (r !== undefined) return r; }

    m = path.match(/^\/api\/rooms\/([^/]+)\/questions(?:\/(\d+))?\/?$/);
    if (m) { const r = await questionsRoute(rc, m); if (r !== undefined) return r; }

    m = path.match(/^\/api\/rooms\/([^/]+)\/games\/(\d+)\/sketch\/(\d+)\/?$/);
    if (m) { const r = await sketchImageRoute(rc, m); if (r !== undefined) return r; }
    m = path.match(/^\/api\/rooms\/([^/]+)\/games(?:\/(\d+)(?:\/(moves|cancel|accept|decline))?)?\/?$/);
    if (m) { const r = await gamesRoute(rc, m); if (r !== undefined) return r; }

    m = path.match(/^\/api\/rooms\/([^/]+)\/(welcome|members|digests|stakes|decisions)(?:\/(\d+))?\/?$/);
    if (m) { const r = await boardRoute(rc, m); if (r !== undefined) return r; }

    m = path.match(/^\/api\/rooms\/([^/]+)\/push\/(subscribe|unsubscribe|status)\/?$/);
    if (m) { const r = await pushRoute(rc, m); if (r !== undefined) return r; }

    m = path.match(/^\/api\/rooms\/([^/]+)\/messages\/(\d+)\/speak\/?$/);
    if (m) { const r = await speakRoute(rc, m); if (r !== undefined) return r; }

    m = path.match(/^\/api\/rooms\/([^/]+)\/messages\/(\d+)\/audio\/?$/);
    if (m) { const r = await audioRoute(rc, m); if (r !== undefined) return r; }

    m = path.match(/^\/api\/rooms\/([^/]+)\/messages\/(\d+)\/image\/?$/);
    if (m) { const r = await imageRoute(rc, m); if (r !== undefined) return r; }

    m = path.match(/^\/api\/rooms\/([^/]+)\/messages\/(\d+)\/video\/?$/);
    if (m) { const r = await videoRoute(rc, m); if (r !== undefined) return r; }

    m = path.match(/^\/api\/rooms\/([^/]+)\/messages\/(\d+)\/(html|doc|file)\/?$/);
    if (m) { const r = await artifactRoute(rc, m); if (r !== undefined) return r; }

    m = path.match(/^\/api\/rooms\/([^/]+)\/messages\/(\d+)\/video\/stream\/?$/);
    if (m) { const r = await videoStreamRoute(rc, m); if (r !== undefined) return r; }

    m = path.match(/^\/api\/rooms\/([^/]+)\/messages\/(\d+)\/(image|audio|video|file)\/(start|part|sign|finish|abort|status)\/?$/);
    if (m) { const r = await uploadRoute(rc, m); if (r !== undefined) return r; }

    m = path.match(/^\/api\/rooms\/([^/]+)\/messages\/(\d+)\/publish\/?$/);
    if (m) { const r = await publishRoute(rc, m); if (r !== undefined) return r; }

    m = path.match(/^\/api\/rooms\/([^/]+)\/messages\/(\d+)\/upload-ticket\/?$/);
    if (m) { const r = await uploadTicketRoute(rc, m); if (r !== undefined) return r; }

    m = path.match(/^\/api\/rooms\/([^/]+)\/messages\/(\d+)\/?$/);
    if (m) { const r = await messageRoute(rc, m); if (r !== undefined) return r; }

    m = path.match(/^\/api\/rooms\/([^/]+)\/(upload|video)\/resume\/?$/);
    if (m) { const r = await uploadResumeRoute(rc, m); if (r !== undefined) return r; }

    m = path.match(/^\/api\/rooms\/([^/]+)\/messages\/(\d+)\/reactions\/?$/);
    if (m) { const r = await reactionsRoute(rc, m); if (r !== undefined) return r; }

    m = path.match(/^\/api\/rooms\/([^/]+)\/attachments\/?$/);
    if (m) { const r = await attachmentsRoute(rc, m); if (r !== undefined) return r; }

    m = path.match(/^\/api\/rooms\/([^/]+)\/messages\/?$/);
    if (m) { const r = await messagesRoute(rc, m); if (r !== undefined) return r; }

    // no-store: this is also the answer for a hashed /assets/* file the
    // serving build lacks (wrangler.toml), and a cached 404 would outlive
    // the deploy that brings the file back.
    return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
  }
}
