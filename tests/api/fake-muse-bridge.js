// The API suite's stand-in for the muse-bridge Worker (tests/api/server.js
// runs it beside the site under wrangler dev, bound as MUSE_BRIDGE). It
// forwards every call - POST /claim, POST /deliver - to the suite's own
// HTTP server at FAKE_BRIDGE_URL, which records it and answers as the test
// asks (tests/api/muse-hooks.js), so a test can refuse, rate-limit or
// drop a link without any Worker code of its own.
export default {
  async fetch(request, env) {
    const u = new URL(request.url);
    const body = request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.text();
    return fetch(env.FAKE_BRIDGE_URL + u.pathname, { method: request.method, headers: { 'Content-Type': request.headers.get('Content-Type') || 'application/json' }, body });
  },
};
