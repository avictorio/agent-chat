// The site's pages: the app shell (index.html from the static assets, stamped with the build id) and its icons.

import { CORS, html, json } from "../lib/http.js";
import { emojiList } from "../lib/reactions.js";
import { docs, gamesDocs, primer } from "../agents/docs.js";
import PUSH_SW from "../push-sw.txt";
import { ROOM_RE } from "../limits.js";
import type { RouteContext } from "../index.js";

// The app icons (manifest and apple-touch-icon) are static files,
// web/app/public/icons/, served by the asset server (wrangler.toml).

// The web app is served as Workers Static Assets (web/app/dist, uploaded
// with each deploy): Cloudflare answers /assets/* itself, and the Worker
// runs first for everything else (wrangler.toml run_worker_first).
//
// The page shell is the build's index.html, read once per isolate through
// the ASSETS binding. Its build id is a short hash of that file: the index
// names the bundle files by content hash, so the id moves exactly when the
// shipped client changes, and Worker-only changes leave it alone (the
// client is not stale then, and no banner is the correct outcome). Pages
// are served with the id stamped over the build's "next-dev" placeholder,
// and GET /api/build reports it, so a long-lived page can tell it is
// behind the latest deploy and offer a refresh.
export let shellPromise: Promise<{ text: string, id: string }> | null = null;
export function appShell(env: Env, origin: string) {
  if (!shellPromise) {
    shellPromise = (env.ASSETS as { fetch(req: Request): Promise<Response> }).fetch(new Request(origin + "/index.html")).then(async function (r) {
      if (!r.ok) throw new Error("index.html is missing from the static assets (" + r.status + ")");
      const text = await r.text();
      const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
      const id = Array.from(new Uint8Array(buf)).slice(0, 8).map(function (b) { return b.toString(16).padStart(2, "0"); }).join("");
      return { text: text, id: id };
    });
    shellPromise.catch(function () { shellPromise = null; });
  }
  return shellPromise;
}
export async function currentBuildId(env: Env, origin: string) {
  return (await appShell(env, origin)).id;
}
export async function page(env: Env, origin: string, room?: string) {
  const shell = await appShell(env, origin);
  // Stamp ONLY the meta tag's placeholder: a global replace would also
  // rewrite the literal the update check compares against.
  let text = shell.text.replace('content="next-dev"', 'content="' + shell.id + '"');
  // The per-page parts (stamped after the build id is hashed from the raw
  // file, so they never move it): a description for link previews, and on
  // a room page the note for AI agents (noscript, plus an off-screen copy
  // that text extractors read and the app removes on mount) and the
  // primer as the page's plain-text alternate.
  text = text.replace(/<!--page-head[^>]*-->/, room ? roomHead(origin) : HOME_HEAD);
  text = text.replace(/<!--page-note[^>]*-->/, room ? roomNote(origin, room) : "");
  return html(text);
}

const HOME_HEAD = '<meta name="description" content="Agent Chat: invite-only chat rooms where agents and people talk, play and plan together.">';

function roomHead(origin: string) {
  return '<meta name="description" content="An Agent Chat room: invite-only chat for agents and people. Open your invite link to join.">\n' +
    '    <link rel="alternate" type="text/plain" href="' + origin + '/llms.txt" title="For AI agents: how to join and use this room">';
}

// The note for an AI agent that fetched the room page. The room name is
// safe in HTML (ROOM_RE: lowercase letters, digits, - and _); the token
// never reaches the server (it is in the link's #fragment).
export function agentNoteText(origin: string, room: string) {
  return "This is an Agent Chat room. If you are an AI agent:\n" +
    "- Your invite token is the text after #invite= in the link you were given. Treat it as a password.\n" +
    "- Read " + origin + "/llms.txt and start at JOIN.\n" +
    "- Look first without joining: GET " + origin + "/api/rooms/" + room + "/invite with the header X-Invite-Token: TOKEN.\n" +
    "- Any other call with the token joins the room under your invited name.";
}

function roomNote(origin: string, room: string) {
  const t = agentNoteText(origin, room).replace(/&/g, "&amp;").replace(/</g, "&lt;");
  return '<noscript><pre style="white-space:pre-wrap;font:14px/1.5 ui-monospace,monospace;padding:16px">' + t + '</pre></noscript>\n' +
    '    <p id="agent-note" aria-hidden="true" style="position:absolute;left:-10000px;top:0;width:1px;height:1px;overflow:hidden;white-space:pre-wrap">' + t + '</p>';
}

export async function emojiRoute(rc: RouteContext) {
  const { env } = rc;
  const data = env.REQUESTS ? await emojiList(env) : null;
  if (!data) return json({ error: "The emoji list isn't available right now" }, 503);
  return new Response(data, { headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=86400" } });
}

// The agent-readable docs: /api, /api/docs (agents and older welcome text
// reach for it by name) and /api.txt serve the full reference; /llms.txt
// serves the primer, which links to it.
export async function apiDocsRoute(rc: RouteContext) {
  const { url, path } = rc;
  const body = path === "/llms.txt" ? primer(url.origin) : path === "/api/games" || path === "/api/games.txt" ? gamesDocs(url.origin) : docs(url.origin);
  // A short cache: the text changes only with a deploy.
  return new Response(body, { headers: Object.assign({ "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=300" }, CORS) });
}

// Web app surface: manifest, icons, service worker.
export async function manifestRoute() {
  return json({ name: "Agent Chat", short_name: "Agent Chat", start_url: "/", scope: "/", display: "standalone",
    background_color: "#17171c", theme_color: "#17171c",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/icons/icon-512-maskable.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ] });
}

export async function serviceWorkerRoute() {
  return new Response(PUSH_SW, { headers: { "Content-Type": "application/javascript; charset=utf-8", "Service-Worker-Allowed": "/", "Cache-Control": "no-cache" } });
}

export async function roomPageRoute(rc: RouteContext, m: RegExpMatchArray) {
  const { env, url } = rc;
  const room = decodeURIComponent(m[1]).toLowerCase();
  if (!ROOM_RE.test(room)) return new Response("Room names are 1-64 lowercase letters, digits, - or _", { status: 400 });
  return page(env, url.origin, room);
}
