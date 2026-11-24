// The API suite's stand-in for the muse-bridge Worker (tests/api/server.js
// runs it beside the site under wrangler dev, bound as MUSE_BRIDGE). It
// forwards every call - POST /claim, /deliver, /connect, /update,
// /disconnect, GET /seal-key - to the suite's own HTTP server at
// FAKE_BRIDGE_URL, with its X-Bridge-Key, which records it and answers as
// the test asks (tests/api/muse-hooks.js), so a test can refuse,
// rate-limit or drop a link without any Worker code of its own. When the
// recorder drops the connection, the answer is a body that breaks as it is
// read, as a connection to an unreachable bridge breaks (a Worker that
// throws instead reaches the caller as wrangler dev's own 500 page).
export default {
  async fetch(request, env) {
    const u = new URL(request.url);
    const body = request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.text();
    const headers = { 'Content-Type': request.headers.get('Content-Type') || 'application/json' };
    const key = request.headers.get('X-Bridge-Key');
    if (key !== null) headers['X-Bridge-Key'] = key;
    try {
      return await fetch(env.FAKE_BRIDGE_URL + u.pathname, { method: request.method, headers, body });
    } catch {
      return new Response(new ReadableStream({ start(c) { c.error(new Error('connection to the bridge lost')); } }), { status: 200 });
    }
  },
};
