// Source of truth: https://github.com/avictorio/agent-chat (worker/; this is the main module).
// Deploy by pushing to main: Cloudflare Workers Builds deploys every push. Uploads made any other way
// (API, dashboard, a local wrangler deploy) are overwritten by the next push. See AGENTS.md.
import { CORS, json } from "./lib/http.js";
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
  iconRoute,
  manifestRoute,
  page,
  roomPageRoute,
  serviceWorkerRoute,
} from "./routes/pages.js";
import { createRoomRoute, roomRoute } from "./routes/rooms.js";
import { streamRoute } from "./routes/stream.js";
import {
  hookCoderaceSecret,
  hookGameExpire,
  hookGameImages,
  hookLetterGrid,
  hookLiarsDice,
  hookR2Fail,
  hookSigv4,
  hookSketchJudge,
  hookTicketTtl,
} from "./routes/test-hooks.js";
import { pushKeyRoute, pushRoute } from "./routes/push.js";
import { mcpRoute, recipeRoute, toolsRoute } from "./routes/agents.js";
import { invitesRoute, memberRoute } from "./routes/members.js";
import { boardRoute, constitutionRoute, questionsRoute } from "./routes/board.js";
import { gamesRoute, sketchImageRoute } from "./routes/games.js";
import { artifactRoute, audioRoute, avatarRoute, imageRoute, videoRoute } from "./routes/media.js";
import { speakRoute, voiceRoute } from "./routes/voices.js";

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
 *  token - from the header or ?invite= (invite), or the header alone
 *  (inviteHdr: all that media reads accept). */
export type RouteContext = { request: Request, env: Env, url: URL, path: string, owner: boolean, invite: string, inviteHdr: string };

export default {
  async fetch(request: Request, env: Env) {
    try {
      return await routeRequest(request, env);
    } catch (e) {
      // A malformed %-escape in a path segment (decodeURIComponent throws
      // URIError) is the client's mistake: answer 400, not a 500.
      if (e instanceof URIError) return json({ error: "The URL has a malformed %-escape" }, 400);
      throw e;
    }
  },
};

async function routeRequest(request: Request, env: Env): Promise<Response> {
  {
    const url = new URL(request.url);
    const path = url.pathname;
    const owner = !!env.OWNER_KEY && request.headers.get("X-Owner-Key") === env.OWNER_KEY;
    const invite = (request.headers.get("X-Invite-Token") || url.searchParams.get("invite") || "").trim();
    // Media reads (phase E close-out, 2026-11-11): ?invite= is retired on
    // the byte-serving routes - a media GET/HEAD authenticates with the
    // header or a signed URL only. Writes and non-media routes keep the
    // merged form above.
    const inviteHdr = (request.headers.get("X-Invite-Token") || "").trim();
    const rc: RouteContext = { request, env, url, path, owner, invite, inviteHdr };

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (path === "/") return page(env, url.origin);
    if (path === "/api/build") return json({ build: await currentBuildId(env, url.origin) });
    if (path === "/api/test-hooks/game-images") { const r = await hookGameImages(rc); if (r !== undefined) return r; }
    if (path === "/api/test-hooks/r2-fail") { const r = await hookR2Fail(rc); if (r !== undefined) return r; }
    if (path === "/api/test-hooks/ticket-ttl") { const r = await hookTicketTtl(rc); if (r !== undefined) return r; }
    if (path === "/api/test-hooks/coderace-secret") { const r = await hookCoderaceSecret(rc); if (r !== undefined) return r; }
    if (path === "/api/test-hooks/game-expire") { const r = await hookGameExpire(rc); if (r !== undefined) return r; }
    if (path === "/api/test-hooks/sketch-judge") { const r = await hookSketchJudge(rc); if (r !== undefined) return r; }
    if (path === "/api/test-hooks/lettergrid") { const r = await hookLetterGrid(rc); if (r !== undefined) return r; }
    if (path === "/api/test-hooks/sigv4") { const r = await hookSigv4(rc); if (r !== undefined) return r; }
    if (path === "/api/test-hooks/liarsdice") { const r = await hookLiarsDice(rc); if (r !== undefined) return r; }
    const usm = path.match(/^\/api\/uploads\/([^\/]+)\/([^\/]+)\/(part|sign|status|finish|abort)\/?$/);
    if (usm) { const r = await uploadLinkStepRoute(rc, usm); if (r !== undefined) return r; }
    const um = path.match(/^\/api\/uploads\/([^\/]+)\/([^\/]+)\/?$/);
    if (um) { const r = await uploadLinkRoute(rc, um); if (r !== undefined) return r; }
    if (path === "/emoji.json") { const r = await emojiRoute(rc); if (r !== undefined) return r; }
    if (path === "/api" || path === "/api/" || path === "/api/docs" || path === "/api.txt" || path === "/llms.txt") { const r = await apiDocsRoute(rc); if (r !== undefined) return r; }

    if (path === "/api/create-room") { const r = await createRoomRoute(rc); if (r !== undefined) return r; }

    const rm = path.match(/^\/(?:r|api\/rooms)\/([^\/]+)/);
    if (rm) { const r = await roomRoute(rc, rm); if (r !== undefined) return r; }

    if (path === "/manifest.webmanifest" && request.method === "GET") { const r = await manifestRoute(rc); if (r !== undefined) return r; }
    if (path === "/sw.js" && request.method === "GET") { const r = await serviceWorkerRoute(rc); if (r !== undefined) return r; }
    const iconMatch = path.match(/^\/icons\/icon-(192|512|512-maskable|180)\.png$/);
    if (iconMatch && request.method === "GET") { const r = await iconRoute(rc, iconMatch); if (r !== undefined) return r; }
    if (path === "/api/push/key" && request.method === "GET") { const r = await pushKeyRoute(rc); if (r !== undefined) return r; }

    let m = path.match(/^\/r\/([^\/]+)\/?$/);
    if (m) { const r = await roomPageRoute(rc, m); if (r !== undefined) return r; }

    m = path.match(/^\/api\/rooms\/([^\/]+)\/stream\/?$/);
    if (m) { const r = await streamRoute(rc, m); if (r !== undefined) return r; }

    m = path.match(/^\/api\/rooms\/([^\/]+)\/agent-recipe(?:\/(script))?\/?$/);
    if (m) { const r = await recipeRoute(rc, m); if (r !== undefined) return r; }

    m = path.match(/^\/api\/rooms\/([^\/]+)\/tools(?:\/([a-z]+))?\/?$/);
    if (m) { const r = await toolsRoute(rc, m); if (r !== undefined) return r; }

    m = path.match(/^\/api\/rooms\/([^\/]+)\/mcp\/?$/);
    if (m) { const r = await mcpRoute(rc, m); if (r !== undefined) return r; }

    m = path.match(/^\/api\/rooms\/([^\/]+)\/(?:avatar|members\/([^\/]+)\/avatar|avatars\/([^\/]+))\/?$/);
    if (m) { const r = await avatarRoute(rc, m); if (r !== undefined) return r; }

    m = path.match(/^\/api\/rooms\/([^\/]+)\/(?:voice(?:\/(sample|reclone))?|members\/([^\/]+)\/voice(?:\/(sample|reclone))?)\/?$/);
    if (m) { const r = await voiceRoute(rc, m); if (r !== undefined) return r; }

    m = path.match(/^\/api\/rooms\/([^\/]+)\/members\/([^\/]+)\/?$/);
    if (m) { const r = await memberRoute(rc, m); if (r !== undefined) return r; }

    m = path.match(/^\/api\/rooms\/([^\/]+)\/invites(?:\/([^\/]+))?\/?$/);
    if (m) { const r = await invitesRoute(rc, m); if (r !== undefined) return r; }

    m = path.match(/^\/api\/rooms\/([^\/]+)\/constitution\/?$/);
    if (m) { const r = await constitutionRoute(rc, m); if (r !== undefined) return r; }

    m = path.match(/^\/api\/rooms\/([^\/]+)\/questions(?:\/(\d+))?\/?$/);
    if (m) { const r = await questionsRoute(rc, m); if (r !== undefined) return r; }

    m = path.match(/^\/api\/rooms\/([^\/]+)\/games\/(\d+)\/sketch\/(\d+)\/?$/);
    if (m) { const r = await sketchImageRoute(rc, m); if (r !== undefined) return r; }
    m = path.match(/^\/api\/rooms\/([^\/]+)\/games(?:\/(\d+)(?:\/(moves|cancel|accept|decline))?)?\/?$/);
    if (m) { const r = await gamesRoute(rc, m); if (r !== undefined) return r; }

    m = path.match(/^\/api\/rooms\/([^\/]+)\/(welcome|members|digests|stakes|decisions)(?:\/(\d+))?\/?$/);
    if (m) { const r = await boardRoute(rc, m); if (r !== undefined) return r; }

    m = path.match(/^\/api\/rooms\/([^\/]+)\/push\/(subscribe|unsubscribe|status)\/?$/);
    if (m) { const r = await pushRoute(rc, m); if (r !== undefined) return r; }

    m = path.match(/^\/api\/rooms\/([^\/]+)\/messages\/(\d+)\/speak\/?$/);
    if (m) { const r = await speakRoute(rc, m); if (r !== undefined) return r; }

    m = path.match(/^\/api\/rooms\/([^\/]+)\/messages\/(\d+)\/audio\/?$/);
    if (m) { const r = await audioRoute(rc, m); if (r !== undefined) return r; }

    m = path.match(/^\/api\/rooms\/([^\/]+)\/messages\/(\d+)\/image\/?$/);
    if (m) { const r = await imageRoute(rc, m); if (r !== undefined) return r; }

    m = path.match(/^\/api\/rooms\/([^\/]+)\/messages\/(\d+)\/video\/?$/);
    if (m) { const r = await videoRoute(rc, m); if (r !== undefined) return r; }

    m = path.match(/^\/api\/rooms\/([^\/]+)\/messages\/(\d+)\/(html|doc|file)\/?$/);
    if (m) { const r = await artifactRoute(rc, m); if (r !== undefined) return r; }

    m = path.match(/^\/api\/rooms\/([^\/]+)\/messages\/(\d+)\/video\/stream\/?$/);
    if (m) { const r = await videoStreamRoute(rc, m); if (r !== undefined) return r; }

    m = path.match(/^\/api\/rooms\/([^\/]+)\/messages\/(\d+)\/(image|audio|video|file)\/(start|part|sign|finish|abort|status)\/?$/);
    if (m) { const r = await uploadRoute(rc, m); if (r !== undefined) return r; }

    m = path.match(/^\/api\/rooms\/([^\/]+)\/messages\/(\d+)\/publish\/?$/);
    if (m) { const r = await publishRoute(rc, m); if (r !== undefined) return r; }

    m = path.match(/^\/api\/rooms\/([^\/]+)\/messages\/(\d+)\/upload-ticket\/?$/);
    if (m) { const r = await uploadTicketRoute(rc, m); if (r !== undefined) return r; }

    m = path.match(/^\/api\/rooms\/([^\/]+)\/messages\/(\d+)\/?$/);
    if (m) { const r = await messageRoute(rc, m); if (r !== undefined) return r; }

    m = path.match(/^\/api\/rooms\/([^\/]+)\/(upload|video)\/resume\/?$/);
    if (m) { const r = await uploadResumeRoute(rc, m); if (r !== undefined) return r; }

    m = path.match(/^\/api\/rooms\/([^\/]+)\/messages\/(\d+)\/reactions\/?$/);
    if (m) { const r = await reactionsRoute(rc, m); if (r !== undefined) return r; }

    m = path.match(/^\/api\/rooms\/([^\/]+)\/attachments\/?$/);
    if (m) { const r = await attachmentsRoute(rc, m); if (r !== undefined) return r; }

    m = path.match(/^\/api\/rooms\/([^\/]+)\/messages\/?$/);
    if (m) { const r = await messagesRoute(rc, m); if (r !== undefined) return r; }

    return new Response("Not found", { status: 404 });
  }
}
