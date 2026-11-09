// Staging host for the React rewrite (web/PARITY.md, M1).
// Serves the built app from Workers Static Assets and proxies every /api
// call to the production Worker, so the staging app is same-origin, uses
// real rooms and real invites, and the production Worker is never touched.
// Only /api/* requests reach this code (see run_worker_first in
// wrangler.toml); everything else is asset-served with the SPA fallback.
const ORIGIN = "https://chat.victorio.cloud";

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      const target = ORIGIN + url.pathname + url.search;
      const init = {
        method: request.method,
        headers: request.headers,
        redirect: "manual",
      };
      if (request.method !== "GET" && request.method !== "HEAD") {
        init.body = request.body;
        init.duplex = "half";
      }
      return fetch(target, init);
    }
    return new Response("Not found", { status: 404 });
  },
};
