// Staging host for the React rewrite (web/PARITY.md, M1).
// Serves the built app and proxies every /api call to the production
// Worker, so the staging app is same-origin, uses real rooms and real
// invites, and the production Worker is never touched.
//
// The build is embedded as text modules (the same trick the production
// Worker uses for its pages): web/staging/deploy.py copies app/dist's
// index.html next to this file and generates assets-map.js plus one
// .txt part per asset, then uploads the whole script through the
// Workers Scripts API. Text modules are strings, so assets must be
// text (JS/CSS/HTML/SVG/JSON) — the current build has no binary
// assets; revisit if the PWA icons ever need to ride along.
import indexHtml from "./index.html";
import ASSETS from "./assets-map.js";

const ORIGIN = "https://chat.victorio.cloud";

const TYPES = {
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
};

function typeFor(path) {
  const dot = path.lastIndexOf(".");
  return TYPES[path.slice(dot)] || "application/octet-stream";
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    // The PWA icons and manifest are binary/static on production; proxy
    // them too so the staging shell's install strip and manifest link
    // resolve (they can't ride along as text modules).
    const proxied =
      url.pathname === "/api" ||
      url.pathname.startsWith("/api/") ||
      url.pathname.startsWith("/icons/") ||
      url.pathname === "/manifest.webmanifest" ||
      url.pathname === "/sw.js" ||
      url.pathname === "/emoji.json";
    if (proxied) {
      const init = {
        method: request.method,
        headers: request.headers,
        redirect: "manual",
      };
      if (request.method !== "GET" && request.method !== "HEAD") {
        init.body = request.body;
        init.duplex = "half";
      }
      return fetch(ORIGIN + url.pathname + url.search, init);
    }
    const asset = ASSETS[url.pathname];
    if (asset != null) {
      return new Response(asset, {
        headers: {
          "content-type": typeFor(url.pathname),
          "cache-control": "public, max-age=31536000, immutable",
        },
      });
    }
    // SPA fallback: every app route gets the shell.
    return new Response(indexHtml, {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-cache",
      },
    });
  },
};
