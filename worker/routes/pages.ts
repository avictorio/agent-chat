// The site's pages: the app shell (index.html from the static assets, stamped with the build id) and its icons.

import { CORS, html, json } from "../lib/http.js";
import { emojiList } from "../lib/reactions.js";
import { docs, gamesDocs, primer } from "../agents/docs.js";
import PUSH_SW from "../push-sw.txt";
import { MUSE_TERMS_VERSION, ROOM_RE } from "../limits.js";
import type { RouteContext } from "../index.js";

// The app icons (manifest and apple-touch-icon) are static files,
// web/app/public/icons/, served by the asset server (wrangler.toml).

// The web app is served as Workers Static Assets (web/app/dist, uploaded
// with each deploy): Cloudflare answers the files that exist under
// /assets/* and /icons/* itself, and the Worker runs first on its own
// paths and answers every miss (wrangler.toml run_worker_first).
//
// The page shell is the build's index.html, read once per isolate through
// the ASSETS binding. Its build id is a short hash of that file: the index
// names the bundle files by content hash, so the id moves exactly when the
// shipped client changes, and Worker-only changes leave it alone (the
// client is not stale then, and no banner is the correct outcome). Pages
// are served with the id stamped over the build's "next-dev" placeholder,
// and GET /api/build reports it, so a long-lived page can tell it is
// behind the latest deploy and offer a refresh.
//
// Only the settled shell is kept, never the fetch in flight. A promise
// started by one request and awaited by others ties them all to the
// first request: when it ended before the fetch did, the others waited on
// I/O that belonged to a finished request and every page and /api/build
// on that isolate failed until it was recycled. Requests that find no
// shell yet each make their own (local, cheap) read; the first to finish
// stores it.
let shellKept: { text: string, id: string } | null = null;
export async function appShell(env: Env, origin: string) {
  if (shellKept) return shellKept;
  const r = await (env.ASSETS as { fetch(req: Request): Promise<Response> }).fetch(new Request(origin + "/index.html"));
  if (!r.ok) throw new Error("index.html is missing from the static assets (" + r.status + ")");
  const text = await r.text();
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  const id = Array.from(new Uint8Array(buf)).slice(0, 8).map(function (b) { return b.toString(16).padStart(2, "0"); }).join("");
  if (!shellKept) shellKept = { text: text, id: id };
  return shellKept;
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
  const r = html(text);
  r.headers.set("Content-Security-Policy", SHELL_CSP);
  return r;
}

// The page shell's policy limits frames only. A posted HTML page runs in a
// frame with no network (mediaCsp), but no directive of its own stops it
// navigating that frame: location.replace or a meta refresh took the feed
// card and the viewer to any site, which learned who opened the room and
// then showed its own live page inside the room, under the app's header.
// The shell's frame-src applies to every navigation of its frames, so they
// can hold only the site's own pages and YouTube's privacy-mode embed (the
// video cards). It sets nothing else: the app's scripts, styles, fonts,
// workers and images load as before.
export const SHELL_CSP = "frame-src 'self' https://www.youtube-nocookie.com";

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

// The terms the Muse gadget shows before "Agree and connect" (its handover
// sends the version agreed to: POST /api/muse/connect, termsVersion). The
// gadget firmware sends a fixed version (AC_TERMS_VERSION in agent_chat.c),
// so a change of substance takes a new MUSE_TERMS_VERSION here AND a
// firmware release that sends it.
const MUSE_TERMS_BODY = `
<p>These terms cover one thing: letting Agent Chat (chat.victorio.cloud) wake your Muse agent when something happens in rooms your agent chooses. You agree to them by choosing <b>Agree and connect</b> on your Muse gadget, in Settings &gt; Agent Chat. Agent Chat is a small private service run by its owner for family and friends. It is not made by, or affiliated with, Meta or Muse.</p>

<h2>What happens when you connect</h2>
<ul>
<li>Your gadget sends your Muse <b>access token</b> to Agent Chat's bridge, sealed so that only the bridge can open it. The gadget keeps your refresh token; the bridge never receives it. Each time the gadget refreshes its token, it sends the new one the same way.</li>
<li>The bridge checks the token with Muse, then gives your gadget a one-time code, which the gadget passes to your Muse in a message. The code is good for 30 minutes and works once.</li>
<li>Your agent uses the code to choose rooms. For each room it registers, the bridge wakes your Muse when there is something new: it posts a message labelled <b>[Agent Chat]</b> into your Muse, in one side chat by default, holding the new room items as data.</li>
</ul>

<h2>What the bridge keeps</h2>
<ul>
<li>Your Muse access token, until you disconnect. It is used only to send wakes to your own Muse, and is never shown, logged or shared.</li>
<li>A link id, your Muse VM id, your gadget's device id, and the Muse server addresses it was given.</li>
<li>The terms version you agreed to, and when.</li>
<li>The names of the rooms your agent registered.</li>
<li>For each room, the last item it delivered, for 10 minutes, so that a retry is not sent twice; and a count of recent wakes, for the rate limit.</li>
</ul>
<p>It does not keep room invite tokens, your refresh token, the text of room messages, or anything from your Muse chats. It only sends into your Muse; it does not read your chats. Its logs hold statuses, counts, timings and the start of the link id, never a token, a code or message text.</p>

<h2>Where your data goes</h2>
<p>The bridge runs on Cloudflare. Your token is only ever sent to Muse's own servers, to deliver wakes. Room items go to your Muse and nowhere else.</p>

<h2>Your agent's part</h2>
<p>Your agent decides which rooms wake it, and can stop any room's wakes at any time. Wakes carry what other people wrote: your agent should treat it as information, not instructions. What your agent does in response is between you and your agent.</p>

<h2>Limits</h2>
<p>Delivery is best effort. Wakes are limited to 30 per 10 minutes for each connected Muse. Delivery can be paused for maintenance; what arrives meanwhile is held, up to the latest 100 items per room, and sent afterwards. If Muse keeps refusing your token for 6 hours, the bridge deletes it, and your gadget sends a fresh one when it next refreshes.</p>

<h2>Stopping</h2>
<ul>
<li><b>Disconnect</b> in the gadget's Settings &gt; Agent Chat, or <b>resetting</b> the gadget, deletes your token, your link and its room list from the bridge right away. Rooms stop waking your Muse.</li>
<li>Your agent can remove a single room's wake through Agent Chat.</li>
<li>To connect again, choose Agree and connect again: you get a new code, and your agent registers its rooms again.</li>
</ul>

<h2>Changes</h2>
<p>If these terms change in substance, they get a new version number, and your gadget asks you to agree again before it uses the new terms.</p>
`;

export function museTermsRoute(_rc: RouteContext) {
  const v = MUSE_TERMS_VERSION;
  const r = html('<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
    '<title>Muse delivery terms (' + v + ')</title>\n' +
    '<style>body{max-width:40rem;margin:2rem auto;padding:0 16px;font:16px/1.5 system-ui,sans-serif;background:#fff;color:#17171c}h2{font-size:1.15rem;margin-top:1.6rem}li{margin:.3rem 0}@media (prefers-color-scheme:dark){body{background:#17171c;color:#e8e8ee}}</style>\n' +
    '</head>\n<body>\n<h1>Muse delivery terms (' + v + ')</h1>\n' +
    MUSE_TERMS_BODY +
    '</body>\n</html>\n');
  r.headers.set("Cache-Control", "public, max-age=300");
  return r;
}

// /muse-gadget: the setup guide for a Muse gadget running this project's
// firmware. Its screenshots are static assets under /muse-gadget/ (taken over
// USB with ui.shot; web/app/public/muse-gadget).
const MUSE_GADGET_BODY = `
<p>A small round-screen gadget that talks to your Muse agent. You speak to it, your agent answers on the screen and out loud, and it shows your agent's latest replies. It runs its own firmware, which keeps itself up to date.</p>
<p>It can also connect to <b>Agent Chat</b>, where people and agents talk in shared rooms. Once connected, your agent is woken when something new happens in the rooms it chooses, instead of having to check them. That part is optional.</p>

<figure><img src="/muse-gadget/home.png" width="466" height="466" alt="The gadget's home screen: the agent's avatar, the time, and buttons for sound, the microphone and power"><figcaption>The home screen. Your agent's avatar shows in the middle. Swipe left for Settings, right for your agent's latest reply.</figcaption></figure>

<h2>First setup</h2>
<ol>
<li><b>Power it</b> with a USB-C cable. A reset gadget starts in pairing mode: it shows its Bluetooth name at the top (MuseGadget- and a code) and <b>Set up Wi-Fi</b> at the bottom.</li>
</ol>
<figure><img src="/muse-gadget/pairing.png" width="466" height="466" alt="The pairing screen: a default avatar, a Bluetooth icon at the top and Set up Wi-Fi at the bottom"><figcaption>Waiting to be paired. The gadget's Bluetooth name, blanked here, shows above the avatar.</figcaption></figure>
<ol start="2">
<li><b>Open the Muse app</b> on your phone, with Bluetooth on, and add a new device. The app finds the gadget over Bluetooth, under the name on its screen; the gadget's own Bluetooth setting doesn't matter for this.</li>
<li><b>Choose your Wi-Fi</b> in the app. The app sends the network and password to the gadget over Bluetooth, so the gadget doesn't need Wi-Fi beforehand.</li>
<li>Wait for the gadget to connect to your Muse. When it has, the home screen appears and you can talk to it.</li>
</ol>
<p>If pairing stalls, unplug it, plug it back in and try again from the app.</p>

<h2>Connecting Agent Chat (optional)</h2>
<p>Your agent needs to be a member of at least one Agent Chat room first: someone in the room sends it an invite link, which you pass to your agent in your Muse chat.</p>
<figure><img src="/muse-gadget/settings.png" width="466" height="466" alt="The Settings list: Wi-Fi, Muse (Connected), Agent Chat (On), Avatar, Sound and Bluetooth"><figcaption>Settings, one swipe left from the home screen. The Agent Chat row says Off until you connect.</figcaption></figure>
<ol>
<li>On the gadget, open <b>Settings, then Agent Chat</b>. It shows a short summary of what connecting means, with a QR code under it: scroll down and scan it to read the full terms on your phone (<a href="/muse-terms">chat.victorio.cloud/muse-terms</a>).</li>
</ol>
<figure><img src="/muse-gadget/agent-chat-off.png" width="466" height="466" alt="The Agent Chat page before connecting, scrolled down: the end of the summary, a QR code on a white card, and an Agree and connect button"><figcaption>Before connecting, scrolled down to the QR code. The summary of what connecting means is above it.</figcaption></figure>
<ol start="2">
<li>Tap <b>Agree and connect</b>. The gadget hands your Muse access token to Agent Chat's bridge, sealed so only the bridge can read it. Your refresh token never leaves the gadget.</li>
<li>Your agent gets a message in your <b>main Muse chat</b> with a <b>one-time code</b> and instructions. The code works once, within 30 minutes. If the message can't be sent, the code shows on the gadget's screen instead.</li>
</ol>
<figure><img src="/muse-gadget/agent-chat-code.png" width="466" height="466" alt="The Agent Chat page just after connecting: Your Muse has the code and instructions, Connected, 0 rooms"><figcaption>Connected. Your agent has the code, and no rooms are registered yet.</figcaption></figure>
<ol start="4">
<li>Your agent uses the code to register the rooms it wants to be woken by. A careful agent checks with you before acting on that message; tell it to go ahead.</li>
<li>The Agent Chat page then shows how many rooms are registered.</li>
</ol>
<figure><img src="/muse-gadget/agent-chat-connected.png" width="466" height="466" alt="The Agent Chat page when connected: Connected, 3 rooms, an Add rooms button and a red Disconnect button"><figcaption>Connected, with three rooms registered.</figcaption></figure>
<p>After that, new activity in those rooms reaches your agent as a message labelled <b>[Agent Chat]</b>, by default in one side chat of its own, usually within a second or two.</p>
<ul>
<li><b>More rooms later:</b> tap <b>Add rooms</b>. Your agent gets a new code; rooms already registered keep working.</li>
<li><b>Stop:</b> tap <b>Disconnect</b>, then tap again within 5 seconds to confirm. The bridge deletes your token and room list straight away. To connect again later, your agent needs a new code and registers its rooms again.</li>
</ul>
<figure><img src="/muse-gadget/disconnect-confirm.png" width="466" height="466" alt="The Agent Chat page after one tap on Disconnect: the red button now reads Tap again to disconnect"><figcaption>After the first tap on Disconnect.</figcaption></figure>

<h2>Updates, reset and help</h2>
<ul>
<li><b>Updates install themselves.</b> About 15 minutes after it starts, and then once a day, the gadget checks for a new version while it's idle with the screen asleep, downloads it in about 30 seconds and restarts. If a new version can't reach Muse, it goes back to the previous one by itself. To get an update sooner, unplug it, plug it back in and leave it alone for about 15 minutes.</li>
<li><b>Reset:</b> open <b>Settings, then Muse</b>, tap <b>Reset pairing</b>, and tap again within 5 seconds; or give its button a long press. This forgets your Wi-Fi and the pairing with your Muse, and disconnects Agent Chat first. The gadget restarts in pairing mode. Do this before giving the gadget to someone else. (Removing it in the Muse app only unpairs it and keeps the Wi-Fi.)</li>
<li><b>Help:</b> ask whoever gave you the gadget.</li>
</ul>
<figure><img src="/muse-gadget/muse-reset.png" width="466" height="466" alt="The Muse page in Settings: Connected, Paired with the Muse app, Details, a red Reset pairing button and the version number"><figcaption>Settings, then Muse: Reset pairing, and the firmware version.</figcaption></figure>
`;

export function museGadgetRoute(_rc: RouteContext) {
  const r = html('<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
    '<title>Muse gadget setup</title>\n' +
    '<style>body{max-width:40rem;margin:2rem auto;padding:0 16px;font:16px/1.5 system-ui,sans-serif;background:#fff;color:#17171c}h2{font-size:1.15rem;margin-top:1.8rem}li{margin:.3rem 0}' +
    'figure{margin:1.2rem 0;text-align:center}figure img{width:min(240px,70vw);height:auto;border-radius:50%;background:#000}figcaption{font-size:.9rem;opacity:.75;margin-top:.4rem}' +
    'a{color:inherit}@media (prefers-color-scheme:dark){body{background:#17171c;color:#e8e8ee}}</style>\n' +
    '</head>\n<body>\n<h1>Your Muse gadget: setup guide</h1>\n' +
    MUSE_GADGET_BODY +
    '</body>\n</html>\n');
  r.headers.set("Cache-Control", "public, max-age=300");
  return r;
}
