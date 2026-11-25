// Webhook hooks (worker/routes/webhook.ts, worker/lib/webhook.ts, the
// webhook half of worker/room/muse.ts) against a real local Worker: URL
// checks, the registration challenge, the secret shown once, signed
// wakes (checked here with the secret, as a receiver would), retries,
// Retry-After, redirects not followed, 410 switching the hook off, the
// switches, rotation, the member list's flag and a Muse hook replaced by
// a webhook. The receiver is receiver() below, on 127.0.0.1 (the Worker
// takes http://127.0.0.1 URLs under TEST_HOOKS only). Called from
// api.test.js; its rooms are its own.
'use strict';
const crypto = require('crypto');
const http = require('http');
const { museGadget, handover } = require('./muse-hooks.js');

/** The suite's webhook receiver: records every call; answers a challenge
 *  as state.challenge says ("body", "json", "wrong", or a status), and a
 *  wake as the next of state.plan says ({status, retryAfter, location}),
 *  else 200. */
function receiver() {
  const state = { calls: [], challenge: 'body', plan: [] };
  const server = http.createServer((q, res) => {
    let raw = '';
    q.on('data', (c) => { raw += c; });
    q.on('end', () => {
      let body = null;
      try { body = JSON.parse(raw); } catch {}
      const event = q.headers['x-agentchat-event'] || null;
      state.calls.push({ path: q.url, method: q.method, event, sig: q.headers['x-agentchat-signature'] || null, ua: q.headers['user-agent'] || '', raw, body, at: Date.now() });
      if (event === 'challenge') {
        const c = body && body.challenge;
        if (state.challenge === 'body') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end(c); }
        if (state.challenge === 'json') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ challenge: c })); }
        if (state.challenge === 'wrong') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('hello'); }
        res.writeHead(Number(state.challenge) || 500); return res.end('no');
      }
      const next = state.plan.shift();
      const status = next ? next.status : 200;
      const headers = { 'Content-Type': 'application/json' };
      if (next && next.retryAfter) headers['Retry-After'] = String(next.retryAfter);
      if (next && next.location) headers['Location'] = next.location;
      res.writeHead(status, headers);
      res.end(JSON.stringify({ ok: status < 300 }));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ state, url: 'http://127.0.0.1:' + server.address().port, close: () => server.close() })));
}

/** A receiver's check of a call: the signature over the raw body, with this secret. */
function signed(call, secret) {
  const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(call.sig || '');
  if (!m) return false;
  const want = crypto.createHmac('sha256', secret).update(m[1] + '.' + call.raw).digest('hex');
  const fresh = Math.abs(Date.now() / 1000 - Number(m[1])) < 300;
  return fresh && crypto.timingSafeEqual(Buffer.from(want), Buffer.from(m[2]));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function webhooks(ctx) {
  const { req, check, SUF, muse } = ctx;
  const rx = await receiver();
  const S = rx.state;
  try {
    const room = 'apitest-wh-' + SUF;
    const R = '/api/rooms/' + room;
    await req('POST', R, { owner: true });
    const inv = async (name, kind) => (await req('POST', R + '/invites', { owner: true, json: { name, kind } })).json.token;
    const TA = await inv('HookAda', 'agent'), TB = await inv('HookBob', 'human'), TM = await inv('HookMuse', 'agent');
    const post = async (token, text) => (await req('POST', R + '/messages', { token, json: { text } })).json;
    const wh = (token, method, json) => req(method || 'GET', R + '/webhook', { token, json });
    const wakes = () => S.calls.filter((c) => c.event === 'wake');
    const waitFor = async (fn, ms) => { const end = Date.now() + (ms || 6000); while (Date.now() < end) { if (fn()) return true; await sleep(100); } return !!fn(); };
    const run = async () => (await req('POST', '/api/test-hooks/muse', { owner: true, json: { room, action: 'run' } })).json;
    const URL = rx.url + '/hook/ada';

    // ---- URL checks: nothing is called for a URL that is refused
    const bad = [
      ['http://example.com/hook', /https/],
      ['https://user:pw@example.com/hook', /credentials/],
      ['https://10.0.0.1/hook', /IP address/],
      ['https://[::1]/hook', /IP address/],
      ['https://localhost/hook', /public host/],
      ['https://printer.local/hook', /public host/],
      ['https://example.com:8443/hook', /default https port/],
      ['https://example.com/hook#x', /fragment/],
      ['https://chat.victorio.cloud/api/rooms/x/messages', /this site/],
      ['ftp://example.com/hook', /https/],
      ['not a url', /not a URL/],
    ];
    for (const [u, why] of bad) {
      const r = await wh(TA, 'POST', { url: u });
      check('webhook: refuses ' + u, r.status === 400 && r.json && r.json.code === 'url_invalid' && why.test(r.json.error), r.status + ' ' + r.text.slice(0, 160));
    }
    check('webhook: a refused URL is never called', S.calls.length === 0, S.calls.length);
    let r = await req('POST', R + '/webhook', { json: { url: URL } });
    check('webhook: no token -> 401', r.status === 401, r.status);
    r = await wh('wh-bogus', 'POST', { url: URL });
    check('webhook: a wrong token -> 403, URL not called', r.status === 403 && S.calls.length === 0, r.status + ' ' + S.calls.length);

    // ---- the challenge
    S.challenge = 'wrong';
    r = await wh(TA, 'POST', { url: URL });
    check('webhook: a URL that does not echo the challenge -> 422 challenge_failed', r.status === 422 && r.json.code === 'challenge_failed' && /echo/.test(r.json.error), r.status + ' ' + r.text.slice(0, 200));
    const ch = S.calls[S.calls.length - 1];
    check('webhook: the challenge is a signed POST with the room and member', ch && ch.method === 'POST' && ch.event === 'challenge' && ch.body.type === 'challenge' && /^chl_/.test(ch.body.challenge) && ch.body.room === room && ch.body.member === 'HookAda' && /^t=\d+,v1=[0-9a-f]{64}$/.test(ch.sig) && /AgentChat-Webhook/.test(ch.ua), JSON.stringify(ch && { e: ch.event, b: ch.body, s: ch.sig }));
    r = await wh(TA);
    check('webhook: a failed challenge registers nothing', r.status === 200 && r.json.hook === null, JSON.stringify(r.json));
    S.challenge = '500';
    r = await wh(TA, 'POST', { url: URL });
    check('webhook: a challenge answered 500 -> 422 with the status', r.status === 422 && /HTTP 500/.test(r.json.error), r.status + ' ' + r.text.slice(0, 200));
    S.challenge = 'json';
    r = await wh(TA, 'POST', { url: URL });
    check('webhook: {"challenge"} echoed as JSON registers', r.status === 200 && r.json.hook && r.json.hook.kind === 'webhook' && r.json.hook.url === URL && r.json.hook.enabled === true, r.status + ' ' + r.text.slice(0, 200));
    S.challenge = 'body';
    r = await wh(TA, 'POST', { url: URL });
    let secret = r.json && r.json.secret;
    check('webhook: the challenge echoed as the body registers, with a secret shown once', r.status === 200 && /^whsec_[A-Za-z0-9_-]{43}$/.test(secret || '') && /shown only now/.test(r.json.note), r.status + ' ' + r.text.slice(0, 200));
    check('webhook: the hook view has no routing and no secret', r.json.hook && !('routing' in r.json.hook) && !('secret' in r.json.hook) && !JSON.stringify(r.json.hook).includes(secret), JSON.stringify(r.json.hook));
    r = await wh(TA);
    check('webhook: GET shows it, without the secret', r.status === 200 && r.json.hook.kind === 'webhook' && r.json.hook.url === URL && !r.text.includes(secret) && r.json.hook.last_status === null, r.text.slice(0, 300));
    r = await req('GET', R + '/members', { token: TB });
    const ada = r.json && r.json.members.find((m) => m.name === 'HookAda');
    check('webhook: the member list flags webhook delivery, not Muse delivery', ada && ada.webhook_delivery === true && ada.muse_delivery === false, JSON.stringify(ada && { w: ada.webhook_delivery, m: ada.muse_delivery }));

    // ---- wakes: signed, the same items as a Muse wake
    const before = wakes().length;
    await post(TB, 'hello hook');
    await post(TA, 'my own words');
    check('webhook: another member\'s message wakes it', await waitFor(() => wakes().length > before), wakes().length);
    let w = wakes()[wakes().length - 1];
    check('webhook: the wake verifies with the secret', w && signed(w, secret), w && w.sig);
    check('webhook: a forged signature would not', w && !signed(w, secret + 'x'));
    check('webhook: the wake carries the room, member, cursor and the items as data', w && w.body.type === 'wake' && w.body.room === room && w.body.member === 'HookAda' && typeof w.body.cursor === 'number' && w.body.items.length === 1 && w.body.items[0].kind === 'message' && w.body.items[0].data.text === 'hello hook' && typeof w.body.items[0].seq === 'number', JSON.stringify(w && w.body).slice(0, 300));
    check('webhook: the member\'s own message did not wake it', !wakes().some((c) => c.body.items.some((i) => i.data && i.data.text === 'my own words')));
    r = await wh(TA);
    check('webhook: a delivered wake shows last_status 200, no error', r.json.hook.last_status === 200 && r.json.hook.last_error === null && r.json.hook.last_delivered_at > 0 && r.json.hook.pending === 0, JSON.stringify(r.json.hook));

    // ---- a refusal is retried; Retry-After is kept
    S.plan.push({ status: 500 });
    let n0 = wakes().length;
    await post(TB, 'try twice');
    await waitFor(() => wakes().length > n0);
    r = await wh(TA);
    check('webhook: a 500 is recorded and the item kept', r.json.hook.last_status === 500 && r.json.hook.last_error === 'HTTP 500' && r.json.hook.pending === 1, JSON.stringify(r.json.hook));
    await run();
    check('webhook: the retry delivers it', await waitFor(() => wakes().filter((c) => c.body.items.some((i) => i.data.text === 'try twice')).length === 2), wakes().length);
    r = await wh(TA);
    check('webhook: ... and clears the error', r.json.hook.last_status === 200 && r.json.hook.last_error === null && r.json.hook.pending === 0, JSON.stringify(r.json.hook));
    S.plan.push({ status: 429, retryAfter: 1 });
    n0 = wakes().length;
    await post(TB, 'slow down');
    await waitFor(() => wakes().length > n0);
    check('webhook: after a 429 with Retry-After 1 the wake comes again by itself', await waitFor(() => wakes().filter((c) => c.body.items.some((i) => i.data.text === 'slow down')).length === 2, 8000), wakes().length);

    // ---- redirects are not followed
    S.plan.push({ status: 302, location: rx.url + '/elsewhere' });
    n0 = S.calls.length;
    await post(TB, 'redirect me');
    await waitFor(() => wakes().length > 0 && S.calls.length > n0);
    await sleep(300);
    r = await wh(TA);
    check('webhook: a 302 is a failed wake, not followed', r.json.hook.last_status === 302 && /redirects are not followed/.test(r.json.hook.last_error) && !S.calls.some((c) => c.path === '/elsewhere'), JSON.stringify(r.json.hook));
    await run();
    for (let i = 0; i < 40 && (await wh(TA)).json.hook.pending > 0; i++) await sleep(100);

    // ---- switches
    r = await wh(TA, 'POST', { muted: true });
    check('webhook: mute', r.status === 200 && r.json.hook.muted === true, r.text.slice(0, 200));
    n0 = wakes().length;
    await post(TB, 'while muted');
    await sleep(1200);
    check('webhook: nothing while muted', wakes().length === n0, wakes().length - n0);
    r = await wh(TA, 'POST', { muted: false });
    await sleep(1200);
    check('webhook: unmuted, what came while muted is not sent (as for a Muse hook: muting stops queueing)', r.json.hook.muted === false && !wakes().some((c) => c.body.items.some((i) => i.data.text === 'while muted')), wakes().length);
    n0 = wakes().length;
    await post(TB, 'after unmute');
    check('webhook: ... and new items wake it again', await waitFor(() => wakes().length > n0), wakes().length - n0);
    r = await wh(TA, 'POST', { routing: 'main' });
    check('webhook: routing is not a webhook switch -> 400', r.status === 400, r.status + ' ' + r.text.slice(0, 160));
    r = await req('POST', R + '/muse-hook', { token: TA, json: { routing: 'main' } });
    check('webhook: nor through the Muse route (not_muse)', r.status === 400 && r.json.code === 'not_muse', r.status + ' ' + r.text.slice(0, 160));

    // ---- rotation: the old secret stops at once
    const old = secret;
    r = await wh(TA, 'POST', { rotate_secret: true });
    secret = r.json && r.json.secret;
    check('webhook: rotate gives a new secret', r.status === 200 && /^whsec_/.test(secret || '') && secret !== old, r.status + ' ' + r.text.slice(0, 160));
    n0 = wakes().length;
    await post(TB, 'after rotation');
    await waitFor(() => wakes().length > n0);
    w = wakes()[wakes().length - 1];
    check('webhook: wakes are signed with the new secret only', w && signed(w, secret) && !signed(w, old), w && w.sig);
    r = await wh(TA, 'POST', { url: URL, rotate_secret: true });
    check('webhook: url and rotate_secret together -> 400', r.status === 400, r.status);
    r = await wh(TB, 'POST', { rotate_secret: true });
    check('webhook: rotating without a webhook -> 404 no_webhook', r.status === 404 && r.json.code === 'no_webhook', r.status + ' ' + r.text.slice(0, 160));

    // ---- 410 switches it off
    S.plan.push({ status: 410 });
    n0 = wakes().length;
    await post(TB, 'gone now');
    await waitFor(() => wakes().length > n0);
    await sleep(300);
    r = await wh(TA);
    check('webhook: a 410 switches the hook off (off_reason gone)', r.json.hook.enabled === false && r.json.hook.off_reason === 'gone' && r.json.hook.last_status === 410 && r.json.hook.pending === 0, JSON.stringify(r.json.hook));
    n0 = wakes().length;
    await post(TB, 'after gone');
    await sleep(1200);
    check('webhook: nothing goes to a hook switched off', wakes().length === n0, wakes().length - n0);
    r = await wh(TA, 'POST', { enabled: true });
    check('webhook: enabled again by its member', r.status === 200 && r.json.hook.enabled === true && r.json.hook.off_reason === null, r.text.slice(0, 200));

    // ---- a Muse hook replaced by a webhook: the link loses the room
    const hand = handover(req, '198.51.' + (parseInt(SUF, 36) % 250) + '.4');
    const g = await museGadget(ctx, hand, 'wh');
    const roomsOf = async () => (await hand('POST', 'status', { museLinkId: g.link })).json;
    r = await req('POST', '/api/muse/hooks', { json: { code: g.code, rooms: [{ room, token: TM }] } });
    check('webhook: a Muse hook first', r.status === 200 && r.json.results[0].ok, r.text.slice(0, 200));
    check('webhook: ... counted on its link', (await roomsOf()).rooms === 1);
    r = await wh(TM, 'POST', { url: rx.url + '/hook/muse' });
    check('webhook: then a webhook for the same member replaces it', r.status === 200 && r.json.hook.kind === 'webhook', r.text.slice(0, 200));
    let left = null;
    for (let i = 0; i < 10 && !(left && left.rooms === 0); i++) { await sleep(200); left = await roomsOf(); }
    check('webhook: ... and the link loses the room', !!left && left.rooms === 0, JSON.stringify(left));
    check('webhook: no wake or challenge ever went to the Muse', !muse.state.chats.some((c) => c.vm === g.vm));

    // ---- removal
    r = await wh(TB, 'DELETE');
    check('webhook: DELETE without a webhook -> 404', r.status === 404, r.status);
    r = await wh(TA, 'DELETE');
    check('webhook: DELETE removes it', r.status === 200 && r.json.removed === true, r.text.slice(0, 160));
    r = await wh(TA);
    check('webhook: gone after DELETE', r.json.hook === null, JSON.stringify(r.json));
    check('webhook: no call ever carried a token', !S.calls.some((c) => c.raw.includes(TA) || c.raw.includes(TB) || c.raw.includes(TM)));

    // ---- the registration cap
    let capped = null;
    for (let i = 0; i < 12 && !capped; i++) {
      const x = await wh(TB, 'POST', { url: rx.url + '/hook/bob' });
      if (x.status === 429) capped = x;
    }
    check('webhook: registrations are capped per member (429 with Retry-After)', capped && capped.headers.get('retry-after'), capped ? capped.status : 'never capped');

    await req('DELETE', R, { owner: true });
  } finally {
    rx.close();
  }
}

module.exports = { webhooks };
