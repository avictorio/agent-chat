// Muse delivery hooks (worker/room/muse.ts, worker/routes/muse.ts) against
// a real local Worker: registration (the batch call, the one-time code),
// each member's own status and settings, which room items wake a hook,
// grouping, retries, no duplicates across a restart, no delivery while
// off or muted, and the refusals; the bridge key on every bridge call and
// the bridge counted as absent without it; the gadget's handover routes
// (connect, update, disconnect, status, seal-key) relayed as the bridge
// answers; each hook set or removed reported to the bridge's room count.
// The bridge is fakeBridge() below: the
// MUSE_BRIDGE stand-in Worker (tests/api/fake-muse-bridge.js) forwards to
// it, it records every call and answers as each check asks. Called from
// api.test.js; its rooms are its own.
'use strict';
const http = require('http');
const { BRIDGE_KEY } = require('./server.js');

/** The suite's Muse bridge: claim codes it knows give a link id; a
 *  delivery answers 200 unless plan[linkId] holds the next answers. The
 *  handover routes answer as next[path] says ({status, body, headers}, or
 *  {drop: true} to cut the connection), else as the real bridge would. */
function fakeBridge() {
  const state = { codes: {}, claims: [], delivers: [], plan: {}, handover: [], next: {}, rooms: [], hooked: {} };
  const HANDOVER = {
    '/connect': () => ({ code: 'ABCDE-FGHJK', museLinkId: 'mlink-0123456789abcdef', expiresAt: 1900000000000 }),
    '/update': (b) => ({ museLinkId: (b && b.museLinkId) || 'mlink-0123456789abcdef', updated: true }),
    '/disconnect': (b) => ({ museLinkId: b && b.museLinkId, removed: true }),
    '/status': (b) => ({ museLinkId: b && b.museLinkId, connected: true, rooms: 2, termsVersion: 'v1', tokenHeld: true }),
    '/seal-key': () => ({ alg: 'X25519-HKDF-SHA256-AES-256-GCM', info: 'muse-bridge seal v1', publicKey: 'cHVibGljLWtleS1mb3ItdGhlLWFwaS1zdWl0ZS0zMmI=' }),
  };
  const server = http.createServer((q, res) => {
    let raw = '';
    q.on('data', (c) => { raw += c; });
    q.on('end', () => {
      let body = null;
      try { body = JSON.parse(raw); } catch {}
      const send = (status, obj, headers) => { res.writeHead(status, Object.assign({ 'Content-Type': 'application/json' }, headers || {})); res.end(JSON.stringify(obj)); };
      const key = q.headers['x-bridge-key'] === undefined ? null : q.headers['x-bridge-key'];
      if (HANDOVER[q.url]) {
        state.handover.push({ path: q.url, method: q.method, key, raw, body });
        const next = (state.next[q.url] || []).shift();
        if (next && next.drop) return q.socket.destroy();
        if (next) return send(next.status, next.body, next.headers);
        return send(200, HANDOVER[q.url](body));
      }
      if (q.url === '/claim') {
        state.claims.push({ raw, body, key });
        const link = body && state.codes[body.code];
        if (!link) return send(404, { error: 'unknown code' });
        delete state.codes[body.code];
        return send(200, { museLinkId: link });
      }
      if (q.url === '/rooms') {
        state.rooms.push({ raw, body, key });
        const link = body && body.museLinkId;
        const set = state.hooked[link] || (state.hooked[link] = new Set());
        if (body && body.hooked) set.add(body.room); else if (body) set.delete(body.room);
        return send(200, { museLinkId: link, rooms: set.size });
      }
      if (q.url === '/deliver') {
        const link = body && body.museLinkId;
        const next = (state.plan[link] || []).shift();
        const status = next ? next.status : 200;
        state.delivers.push({ raw, body, status, key, at: Date.now() });
        if (status === 410) return send(410, { error: 'link gone', code: 'link_gone' });
        if (status === 429) return send(429, { error: 'slow down' }, { 'Retry-After': String(next.retryAfter || 1) });
        if (status === 503 && next.retryAfter) return send(503, { error: 'Muse refused the token; retrying', code: 'token_refused' }, { 'Retry-After': String(next.retryAfter) });
        return send(status, status < 300 ? { ok: true } : { error: 'bridge trouble' });
      }
      send(404, { error: 'no route' });
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ state, url: 'http://127.0.0.1:' + server.address().port, close: () => server.close() })));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function museHooks(ctx) {
  const { req, check, SUF, bridge } = ctx;
  const B = bridge.state;
  const room = 'apitest-muse-' + SUF, room2 = 'apitest-muse2-' + SUF;
  const R = '/api/rooms/' + room, R2 = '/api/rooms/' + room2;
  const SIDE = 'A1B2C3D4-0000-4000-8000-0123456789AB';
  await req('POST', R, { owner: true });
  await req('POST', R2, { owner: true });
  const inv = async (P, name, kind) => (await req('POST', P + '/invites', { owner: true, json: { name, kind } })).json.token;
  const TA = await inv(R, 'MuseAda', 'agent'), TB = await inv(R, 'MuseBob', 'agent'), TC = await inv(R, 'MuseCy', 'human');
  const TA2 = await inv(R2, 'MuseAda', 'agent');
  const post = async (P, token, text) => (await req('POST', P + '/messages', { token, json: { text } })).json;
  // what each link has been handed so far, 2xx answers only
  const taken = (link) => B.delivers.filter((d) => d.body && d.body.museLinkId === link && d.status < 300);
  const takenItems = (link) => [].concat(...taken(link).map((d) => d.body.items));
  const textsOf = (link) => takenItems(link).filter((i) => i.kind === 'message').map((i) => i.data.text);
  const waitFor = async (fn, ms) => { const end = Date.now() + (ms || 6000); while (Date.now() < end) { if (fn()) return true; await sleep(100); } return !!fn(); };
  const hook = (P, token, method, json) => req(method || 'GET', P + '/muse-hook', { token, json });
  const peek = async (rm) => (await req('POST', '/api/test-hooks/muse', { owner: true, json: { room: rm, action: 'peek' } })).json;
  const run = async (rm) => (await req('POST', '/api/test-hooks/muse', { owner: true, json: { room: rm, action: 'run' } })).json;
  const hookOf = (pk, member) => ((pk && pk.hooks) || []).find((h) => h.member === member) || null;
  const reg = (json) => req('POST', '/api/muse/hooks', { json });

  // ---- registration: validation and refusals; none of them spends the code
  B.codes['code-ada'] = 'link-ada';
  let r = await reg({ rooms: [{ room, token: TA }] });
  check('muse: registration without a code -> 400', r.status === 400, r.status + ' ' + r.text.slice(0, 120));
  r = await reg({ code: 'code-ada', routing: 'sideways', rooms: [{ room, token: TA }] });
  check('muse: a default routing that is not one -> 400', r.status === 400 && /routing/.test(r.json && r.json.error), r.status + ' ' + r.text.slice(0, 160));
  r = await reg({ code: 'code-ada', rooms: [] });
  check('muse: an empty rooms list -> 400', r.status === 400, r.status);
  r = await reg({ code: 'code-ada', rooms: [{ room, token: TA, routing: 'side-chat-7' }] });
  check('muse: a side chat id that is not a UUID is refused for its room', r.status === 403 && r.json.code === 'no_rooms' && r.json.results[0].status === 400 && /UUID/.test(r.json.results[0].error), r.status + ' ' + r.text.slice(0, 200));
  r = await reg({ code: 'code-ada', rooms: [{ room, token: 'muse-bogus' }] });
  check('muse: a wrong token is refused (invite_invalid)', r.status === 403 && r.json.results[0].status === 403 && r.json.results[0].code === 'invite_invalid', r.status + ' ' + r.text.slice(0, 200));
  r = await reg({ code: 'code-ada', rooms: [{ room, token: TA2 }] });
  check('muse: a token for a different room is refused', r.status === 403 && r.json.results[0].code === 'invite_invalid', r.status + ' ' + r.text.slice(0, 200));
  r = await reg({ code: 'code-ada', rooms: [{ room: 'apitest-muse-none-' + SUF, token: TA }] });
  check('muse: a room that does not exist is refused', r.status === 403 && r.json.results[0].status === 404, r.status + ' ' + r.text.slice(0, 200));
  check('muse: no refused registration claimed the code', B.claims.length === 0, B.claims.length);
  r = await req('POST', '/api/muse/hooks', { owner: true, headers: { 'X-Test-Muse-No-Key': '1' }, json: { code: 'code-ada', rooms: [{ room, token: TA }] } });
  check('muse: registration without the bridge key -> 503 muse_unavailable', r.status === 503 && r.json && r.json.code === 'muse_unavailable', r.status + ' ' + r.text.slice(0, 160));
  check('muse: ... and the bridge was not called', B.claims.length === 0, B.claims.length);
  r = await reg({ code: 'not-a-code', rooms: [{ room, token: TA }] });
  check('muse: an unknown code -> 403 code_invalid', r.status === 403 && r.json.code === 'code_invalid', r.status + ' ' + r.text.slice(0, 160));
  r = await hook(R, TA);
  check('muse: an unknown code set no hook', r.status === 200 && r.json.hook === null, JSON.stringify(r.json));

  // ---- a batch: two rooms and a bad pair, one claim
  const claimsBefore = B.claims.length;
  r = await reg({ code: 'code-ada', rooms: [{ room, token: TA }, { room: room2, token: TA2, routing: SIDE }, { room, token: 'muse-bogus' }] });
  const res = (r.json && r.json.results) || [];
  check('muse: batch registration -> 200 with per-room results', r.status === 200 && r.json.claimed === true && res.length === 3, r.status + ' ' + r.text.slice(0, 200));
  check('muse: batch: the first room is set, default routing agent-chat', res[0] && res[0].ok && res[0].name === 'MuseAda' && res[0].hook.routing === 'agent-chat' && res[0].hook.enabled === true && res[0].hook.muted === false, JSON.stringify(res[0]));
  check('muse: batch: the second room takes its own routing (a side chat id, lowercased)', res[1] && res[1].ok && res[1].hook.routing === SIDE.toLowerCase(), JSON.stringify(res[1]));
  check('muse: batch: the bad pair fails alone', res[2] && !res[2].ok && res[2].status === 403, JSON.stringify(res[2]));
  check('muse: the code was claimed once, and the bridge saw no token', B.claims.length === claimsBefore + 1 && B.claims[B.claims.length - 1].body.code === 'code-ada' && !B.claims.some((c) => c.raw.includes(TA) || c.raw.includes(TA2)), JSON.stringify(B.claims.map((c) => c.body)));
  check('muse: the response carries no token', !r.text.includes(TA) && !r.text.includes(TA2));
  check('muse: the response carries no link id', !r.text.includes('link-ada'), r.text.slice(0, 300));
  check('muse: every claim carried the bridge key', B.claims.length > 0 && B.claims.every((c) => c.key === BRIDGE_KEY), JSON.stringify(B.claims.map((c) => c.key)));
  const told = (link, rm, hooked) => B.rooms.some((x) => x.body && x.body.museLinkId === link && x.body.room === rm && x.body.hooked === hooked);
  check('muse: each room set is reported to the bridge\'s room count', told('link-ada', room, true) && told('link-ada', room2, true) && B.hooked['link-ada'].size === 2, JSON.stringify(B.rooms.map((x) => x.body)));
  check('muse: room reports carry the bridge key and no token', B.rooms.every((x) => x.key === BRIDGE_KEY && !x.raw.includes(TA) && !x.raw.includes(TA2)), JSON.stringify(B.rooms.map((x) => x.key)));
  B.codes['code-bob'] = 'link-bob';
  r = await reg({ code: 'code-bob', routing: 'main', rooms: [{ room, token: TB }] });
  check('muse: a second member registers with routing main', r.status === 200 && r.json.results[0].ok && r.json.results[0].hook.routing === 'main', r.text.slice(0, 200));

  // ---- status, and the member list's flag
  r = await hook(R, TA);
  check('muse: status shows my hook', r.status === 200 && r.json.name === 'MuseAda' && r.json.hook && r.json.hook.routing === 'agent-chat' && r.json.hook.enabled === true && 'last_delivered_at' in r.json.hook && !('link' in r.json.hook), JSON.stringify(r.json));
  check('muse: the hook view has no link id', !('museLinkId' in r.json.hook) && !r.text.includes('link-ada'), r.text);
  r = await hook(R, TC);
  check('muse: a member with no hook gets null', r.status === 200 && r.json.hook === null, JSON.stringify(r.json));
  r = await req('GET', R + '/muse-hook', { owner: true });
  check('muse: the owner key alone has no hook -> 401', r.status === 401, r.status);
  r = await hook(R, 'muse-bogus');
  check('muse: status with a wrong token -> 403', r.status === 403, r.status);
  r = await hook(R, TA2);
  check('muse: status with another room\'s token -> 403', r.status === 403, r.status);
  r = await req('GET', R + '/members', { token: TC });
  const mem = (n) => ((r.json && r.json.members) || []).find((x) => x.name === n) || {};
  check('muse: the members list shows no link id', !r.text.includes('link-ada') && !r.text.includes('link-bob'));
  check('muse: the members list flags Muse delivery', mem('MuseAda').muse_delivery === true && mem('MuseBob').muse_delivery === true && mem('MuseCy').muse_delivery === false, JSON.stringify(((r.json && r.json.members) || []).map((x) => [x.name, x.muse_delivery])));

  // ---- selection: other members' messages wake; your own never does
  await post(R, TC, 'muse sel one');
  check('muse: another member\'s message wakes both hooks', await waitFor(() => textsOf('link-ada').includes('muse sel one') && textsOf('link-bob').includes('muse sel one')), JSON.stringify([textsOf('link-ada'), textsOf('link-bob')]));
  await post(R, TA, 'muse own words');
  check('muse: my message wakes the others', await waitFor(() => textsOf('link-bob').includes('muse own words')));
  await sleep(1200);
  check('muse: my own message never wakes me', !textsOf('link-ada').includes('muse own words'), JSON.stringify(textsOf('link-ada')));
  const one = taken('link-ada')[0];
  check('muse: the wake payload: link, room, member, routing, cursor, items', !!one && one.body.museLinkId === 'link-ada' && one.body.room === room && one.body.member === 'MuseAda' && one.body.routing === 'agent-chat' && typeof one.body.cursor === 'number' && one.body.items.length >= 1 && one.body.items.every((i) => typeof i.seq === 'number' && i.kind && i.data) && one.body.cursor === one.body.items[one.body.items.length - 1].seq, JSON.stringify(one && one.body).slice(0, 300));
  check('muse: a message item is the stream frame\'s data', !!one && one.body.items[0].data.from === 'MuseCy' && one.body.items[0].data.room === room && typeof one.body.items[0].data.id === 'number', JSON.stringify(one && one.body.items[0]));
  check('muse: a wake carries no token', !B.delivers.some((d) => d.raw.includes(TA) || d.raw.includes(TB) || d.raw.includes(TC)));
  check('muse: every wake carried the bridge key', B.delivers.length > 0 && B.delivers.every((d) => d.key === BRIDGE_KEY), JSON.stringify(B.delivers.map((d) => d.key)));

  // ---- reactions and game frames wake only the members they target
  const adaMsg = (await req('GET', R + '/messages?limit=5', { token: TA })).json.messages.find((x) => x.text === 'muse own words');
  const nAda = takenItems('link-ada').length, nBob = takenItems('link-bob').length;
  await req('POST', R + '/messages/' + adaMsg.id + '/reactions', { token: TB, json: { reaction: '👍' } });
  check('muse: a reaction wakes the message\'s author', await waitFor(() => takenItems('link-ada').slice(nAda).some((i) => i.kind === 'reaction' && i.data.id === adaMsg.id)), JSON.stringify(takenItems('link-ada').slice(nAda)));
  await sleep(1000);
  check('muse: a reaction never wakes the one who reacted', !takenItems('link-bob').slice(nBob).some((i) => i.kind === 'reaction'), JSON.stringify(takenItems('link-bob').slice(nBob)));
  r = await req('POST', R + '/games', { token: TA, json: { game: 'duel', players: ['MuseAda', 'MuseBob'], best_of: 1, tick_seconds: 3600 } });
  const gid = r.json && r.json.game && r.json.game.id;
  // the create's own wakes (Bob: the card and the lobby awaiting him) go first
  check('muse: a new match wakes the invited player', await waitFor(() => takenItems('link-bob').slice(nBob).some((i) => i.kind === 'game' && i.data.game && i.data.game.id === gid && i.data.from === 'MuseAda')), JSON.stringify(takenItems('link-bob').slice(nBob)).slice(0, 300));
  await sleep(800);
  const nAda2 = takenItems('link-ada').length, nBob2 = takenItems('link-bob').length;
  await req('POST', R + '/games/' + gid + '/accept', { token: TB, json: {} });
  check('muse: a game frame wakes the players it awaits', await waitFor(() => takenItems('link-ada').slice(nAda2).some((i) => i.kind === 'game' && i.data.game && i.data.game.id === gid)), JSON.stringify(takenItems('link-ada').slice(nAda2)).slice(0, 300));
  await sleep(1000);
  check('muse: a game frame never wakes the one who made it', !takenItems('link-bob').slice(nBob2).some((i) => i.kind === 'game'), JSON.stringify(takenItems('link-bob').slice(nBob2)).slice(0, 300));
  await req('POST', R + '/games/' + gid + '/cancel', { token: TA, json: {} });
  await sleep(1200);

  // ---- grouping: a burst is one wake, at most 10 items to a wake
  let w0 = taken('link-ada').length;
  for (let i = 0; i < 3; i++) await post(R, TC, 'muse burst3 ' + i);
  await waitFor(() => textsOf('link-ada').includes('muse burst3 2'));
  await sleep(300);
  let wakes = taken('link-ada').slice(w0).filter((d) => d.body.items.some((i) => /^muse burst3/.test(i.data.text || '')));
  check('muse: three messages in a burst go out as one wake', wakes.length === 1 && wakes[0].body.items.filter((i) => /^muse burst3/.test(i.data.text || '')).length === 3, JSON.stringify(wakes.map((d) => d.body.items.map((i) => i.data.text))));
  w0 = taken('link-ada').length;
  await Promise.all(Array.from({ length: 12 }, (_, i) => post(R, TC, 'muse burst12 ' + i)));
  await waitFor(() => textsOf('link-ada').filter((t) => /^muse burst12/.test(t)).length === 12);
  wakes = taken('link-ada').slice(w0);
  check('muse: twelve messages in a burst: 10 in the first wake, the rest in the next', wakes.length === 2 && wakes[0].body.items.length === 10 && wakes[1].body.items.length === 2, JSON.stringify(wakes.map((d) => d.body.items.length)));
  const seqs = takenItems('link-ada').map((i) => i.seq);
  check('muse: every item is handed over once, in order', seqs.every((s, i) => i === 0 || s > seqs[i - 1]), JSON.stringify(seqs));

  // ---- retry: a refused wake is tried again with the same items
  B.plan['link-ada'] = [{ status: 500 }];
  let tries0 = B.delivers.length;
  await post(R, TC, 'muse retry one');
  await waitFor(() => B.delivers.slice(tries0).some((d) => d.status === 500));
  let pk = await peek(room);
  const ha = hookOf(pk, 'museada');
  check('muse: a refused wake is kept, with a backoff', !!ha && ha.fails === 1 && ha.pending === 1 && ha.due_at > pk.now + 2000, JSON.stringify(ha));
  await run(room);
  const tries = B.delivers.slice(tries0).filter((d) => d.body.museLinkId === 'link-ada');
  check('muse: the retry goes through, with the same items and cursor', tries.length === 2 && tries[0].status === 500 && tries[1].status === 200 && tries[1].body.cursor === tries[0].body.cursor && JSON.stringify(tries[1].body.items) === JSON.stringify(tries[0].body.items), JSON.stringify(tries.map((d) => [d.status, d.body.cursor])));
  pk = await peek(room);
  check('muse: after the retry the hook is clear', hookOf(pk, 'museada').fails === 0 && hookOf(pk, 'museada').pending === 0 && hookOf(pk, 'museada').due_at === null, JSON.stringify(hookOf(pk, 'museada')));
  // 429: waits as long as the bridge asks
  B.plan['link-ada'] = [{ status: 429, retryAfter: 120 }];
  tries0 = B.delivers.length;
  await post(R, TC, 'muse slow down');
  await waitFor(() => B.delivers.slice(tries0).some((d) => d.status === 429));
  pk = await peek(room);
  check('muse: a 429 backs off for its Retry-After', hookOf(pk, 'museada').due_at > pk.now + 100000 && hookOf(pk, 'museada').pending === 1, JSON.stringify(hookOf(pk, 'museada')));
  await run(room);
  check('muse: after the 429 the wake goes through', textsOf('link-ada').filter((t) => t === 'muse slow down').length === 1);
  // 503 with Retry-After (the bridge waiting out a refused token): waits as asked, hook stays on
  B.plan['link-ada'] = [{ status: 503, retryAfter: 900 }];
  tries0 = B.delivers.length;
  await post(R, TC, 'muse token glitch');
  await waitFor(() => B.delivers.slice(tries0).some((d) => d.status === 503));
  pk = await peek(room);
  check('muse: a 503 with Retry-After waits that long and keeps the hook on', hookOf(pk, 'museada').due_at > pk.now + 800000 && hookOf(pk, 'museada').pending === 1 && !!hookOf(pk, 'museada').enabled, JSON.stringify(hookOf(pk, 'museada')));
  await run(room);
  check('muse: after the 503 the wake goes through', textsOf('link-ada').filter((t) => t === 'muse token glitch').length === 1);

  // ---- a restart loses nothing and sends nothing twice
  B.plan['link-ada'] = [{ status: 503 }];
  tries0 = B.delivers.length;
  await post(R, TC, 'muse across restart');
  await waitFor(() => B.delivers.slice(tries0).some((d) => d.status === 503));
  await req('POST', '/api/test-hooks/muse', { owner: true, json: { room, action: 'restart' } });
  await sleep(500);
  pk = await peek(room);
  check('muse: the refused wake is still queued after a restart', hookOf(pk, 'museada') && hookOf(pk, 'museada').pending === 1, JSON.stringify(pk).slice(0, 300));
  await run(room);
  await run(room);
  check('muse: after the restart it is delivered exactly once', textsOf('link-ada').filter((t) => t === 'muse across restart').length === 1, JSON.stringify(textsOf('link-ada').slice(-3)));
  await req('POST', '/api/test-hooks/muse', { owner: true, json: { room, action: 'restart' } });
  await sleep(500);
  await run(room);
  await sleep(800);
  const all = takenItems('link-ada').map((i) => i.seq);
  check('muse: a delivered item is never sent again, restart or not', new Set(all).size === all.length, all.length + ' items, ' + new Set(all).size + ' distinct');

  // ---- settings: mute, off, routing; no delivery while muted or off
  r = await hook(R, TA, 'POST', { routing: 'nope' });
  check('muse: settings refuse a bad routing', r.status === 400, r.status);
  r = await hook(R, TA, 'POST', { muted: 'yes' });
  check('muse: settings refuse a muted that is not true/false', r.status === 400, r.status);
  r = await hook(R, TA, 'POST', {});
  check('muse: settings with nothing to change -> 400', r.status === 400, r.status);
  r = await hook(R, 'muse-bogus', 'POST', { muted: true });
  check('muse: settings with a wrong token -> 403', r.status === 403, r.status);
  r = await hook(R, TA2, 'POST', { muted: true });
  check('muse: settings with another room\'s token -> 403', r.status === 403, r.status);
  r = await hook(R, TC, 'POST', { muted: true });
  check('muse: settings for a member with no hook -> 404', r.status === 404 && r.json.code === 'no_hook', r.status);
  r = await hook(R, TA, 'POST', { muted: true });
  check('muse: mute', r.status === 200 && r.json.hook.muted === true && r.json.hook.enabled === true, JSON.stringify(r.json));
  r = await req('GET', R + '/members', { token: TC });
  check('muse: a muted hook shows as off in the members list', mem('MuseAda').muse_delivery === false);
  await post(R, TC, 'muse while muted');
  r = await hook(R, TA, 'POST', { enabled: false, muted: false });
  check('muse: off', r.status === 200 && r.json.hook.enabled === false && r.json.hook.off_reason === 'member', JSON.stringify(r.json));
  await post(R, TC, 'muse while off');
  await sleep(1200);
  await run(room);
  check('muse: nothing is delivered while muted or off', !textsOf('link-ada').includes('muse while muted') && !textsOf('link-ada').includes('muse while off'), JSON.stringify(textsOf('link-ada').slice(-3)));
  check('muse: the other member\'s hook kept delivering meanwhile', textsOf('link-bob').includes('muse while muted') && textsOf('link-bob').includes('muse while off'));
  r = await hook(R, TA, 'POST', { enabled: true, routing: SIDE });
  check('muse: back on, with a side chat routing', r.status === 200 && r.json.hook.enabled === true && r.json.hook.routing === SIDE.toLowerCase(), JSON.stringify(r.json));
  await post(R, TC, 'muse back on');
  check('muse: back on, it delivers with the new routing', await waitFor(() => taken('link-ada').some((d) => d.body.routing === SIDE.toLowerCase() && d.body.items.some((i) => i.data.text === 'muse back on'))));

  // ---- the second room's hook is its own
  await req('POST', R2 + '/messages', { owner: true, json: { from: 'Zed', text: 'muse room two' } });
  check('muse: the other room wakes the same link, with its own room and routing', await waitFor(() => taken('link-ada').some((d) => d.body.room === room2 && d.body.routing === SIDE.toLowerCase() && d.body.items.some((i) => i.data.text === 'muse room two'))));

  // ---- without the bridge key no wake is tried; the queue waits for it
  await req('POST', '/api/test-hooks/muse', { owner: true, json: { room, action: 'nokey' } });
  tries0 = B.delivers.length;
  await post(R, TC, 'muse no key');
  await sleep(1500);
  check('muse: without the bridge key no wake is tried', !B.delivers.slice(tries0).some((d) => d.body.museLinkId === 'link-bob'), JSON.stringify(B.delivers.slice(tries0).map((d) => d.body.museLinkId)));
  pk = await peek(room);
  check('muse: ... and the item stays queued', hookOf(pk, 'musebob') && hookOf(pk, 'musebob').pending === 1 && hookOf(pk, 'musebob').due_at > pk.now && hookOf(pk, 'musebob').fails === 0, JSON.stringify(hookOf(pk, 'musebob')));
  await req('POST', '/api/test-hooks/muse', { owner: true, json: { room, action: 'key' } });
  await run(room);
  check('muse: with the key back, the queued item is delivered once', textsOf('link-bob').filter((t) => t === 'muse no key').length === 1, JSON.stringify(textsOf('link-bob').slice(-3)));

  // ---- the bridge says the link is gone: the hook turns off
  B.plan['link-ada'] = [{ status: 410 }];
  tries0 = B.delivers.length;
  await post(R, TC, 'muse link gone');
  await waitFor(() => B.delivers.slice(tries0).some((d) => d.status === 410));
  await sleep(300);
  r = await hook(R, TA);
  check('muse: a 410 from the bridge switches the hook off', r.json.hook && r.json.hook.enabled === false && r.json.hook.off_reason === 'link_gone' && r.json.hook.pending === 0, JSON.stringify(r.json));
  tries0 = B.delivers.length;
  await post(R, TC, 'muse after gone');
  await sleep(1200);
  check('muse: nothing more goes to a gone link', !B.delivers.slice(tries0).some((d) => d.body.museLinkId === 'link-ada' && d.body.room === room));

  // ---- removal, and revocation
  r = await hook(R, TA, 'DELETE');
  check('muse: remove my hook', r.status === 200 && r.json.removed === true, JSON.stringify(r.json));
  r = await hook(R, TA, 'DELETE');
  check('muse: removing it again -> 404', r.status === 404, r.status);
  check('muse: a removed hook is reported to the bridge (hooked false)', await waitFor(() => told('link-ada', room, false)) && B.hooked['link-ada'].size === 1, JSON.stringify(B.rooms.map((x) => x.body)));
  r = await hook(R, TA);
  check('muse: after removal, status is null', r.status === 200 && r.json.hook === null);
  await req('DELETE', R + '/invites/' + TB, { owner: true });
  tries0 = B.delivers.length;
  await post(R, TC, 'muse after revoke');
  await sleep(1200);
  check('muse: a revoked member\'s hook wakes no more', !B.delivers.slice(tries0).some((d) => d.body.museLinkId === 'link-bob'));
  pk = await peek(room);
  check('muse: a revoked member\'s hook is gone from storage', !hookOf(pk, 'musebob'), JSON.stringify(pk && pk.hooks));
  check('muse: a revoked member\'s hook is reported to the bridge', await waitFor(() => told('link-bob', room, false)), JSON.stringify(B.rooms.map((x) => x.body)));

  for (const P of [R, R2]) {
    await req('DELETE', P + '/invites', { owner: true });
    await req('DELETE', P + '?confirm=' + P.split('/').pop(), { owner: true });
  }

  await museHandover(ctx);
}

// The gadget's handover: POST /api/muse/connect, /update, /disconnect and
// GET /api/muse/seal-key, relayed to the bridge with no member token.
async function museHandover(ctx) {
  const { req, check, SUF, bridge } = ctx;
  const B = bridge.state;
  // each run counts against the per-network cap under its own address
  const net = '198.51.' + (parseInt(SUF, 36) % 250) + '.';
  const IP = { 'CF-Connecting-IP': net + '1' };
  const hand = (method, route, json, extra) => req(method, '/api/muse/' + route, { json, headers: Object.assign({}, IP, extra || {}) });
  const calls = (path) => B.handover.filter((c) => c.path === path);
  let r, n;

  // seal-key: a refusal passes through uncached; the key is cached
  B.next['/seal-key'] = [{ status: 503, body: { code: 'seal_unset', error: 'no seal key' } }];
  r = await hand('GET', 'seal-key');
  check('muse handover: seal-key relays the bridge\'s refusal', r.status === 503 && r.json && r.json.code === 'seal_unset' && r.headers.get('cache-control') === 'no-store', r.status + ' ' + r.text.slice(0, 120));
  r = await hand('GET', 'seal-key');
  check('muse handover: seal-key returns the bridge\'s key, cacheable', r.status === 200 && r.json && r.json.info === 'muse-bridge seal v1' && typeof r.json.publicKey === 'string' && /max-age=\d+/.test(r.headers.get('cache-control') || '') && /public/.test(r.headers.get('cache-control') || ''), r.status + ' ' + r.headers.get('cache-control') + ' ' + r.text.slice(0, 160));
  n = calls('/seal-key').length;
  r = await hand('GET', 'seal-key');
  check('muse handover: a second seal-key is served from the cache', r.status === 200 && r.json.info === 'muse-bridge seal v1' && calls('/seal-key').length === n, calls('/seal-key').length + ' vs ' + n);
  check('muse handover: seal-key carried the bridge key', calls('/seal-key').length === 2 && calls('/seal-key').every((c) => c.key === BRIDGE_KEY && c.method === 'GET'), JSON.stringify(calls('/seal-key').map((c) => [c.method, c.key])));

  // connect: no member token; the answer comes back unchanged
  r = await hand('POST', 'connect', { sealed: 'c2VhbGVkLWJsb2I=', termsVersion: 'v1', extra: 'not forwarded' });
  check('muse handover: connect with no token relays the bridge\'s answer', r.status === 200 && r.json && r.json.code === 'ABCDE-FGHJK' && r.json.museLinkId === 'mlink-0123456789abcdef' && r.json.expiresAt === 1900000000000 && r.text === JSON.stringify({ code: 'ABCDE-FGHJK', museLinkId: 'mlink-0123456789abcdef', expiresAt: 1900000000000 }), r.status + ' ' + r.text.slice(0, 200));
  let last = calls('/connect').slice(-1)[0];
  check('muse handover: connect sends the bridge key and only sealed + termsVersion', !!last && last.key === BRIDGE_KEY && last.method === 'POST' && JSON.stringify(last.body) === JSON.stringify({ sealed: 'c2VhbGVkLWJsb2I=', termsVersion: 'v1' }), JSON.stringify(last));
  for (const [status, code] of [[400, 'seal_invalid'], [403, 'token_refused'], [422, 'no_vm'], [502, 'muse_unreachable']]) {
    B.next['/connect'] = [{ status, body: { code, error: 'bridge says ' + code } }];
    r = await hand('POST', 'connect', { sealed: 'c2VhbGVk', termsVersion: 'v1' });
    check('muse handover: connect passes the bridge\'s ' + status + ' ' + code + ' through', r.status === status && r.json && r.json.code === code && r.json.error === 'bridge says ' + code, r.status + ' ' + r.text.slice(0, 160));
  }
  B.next['/connect'] = [{ status: 429, body: { code: 'rate_limited', error: 'slow down' }, headers: { 'Retry-After': '42' } }];
  r = await hand('POST', 'connect', { sealed: 'c2VhbGVk', termsVersion: 'v1' });
  check('muse handover: a 429 from the bridge keeps its Retry-After', r.status === 429 && r.headers.get('retry-after') === '42', r.status + ' ' + r.headers.get('retry-after'));
  B.next['/connect'] = [{ drop: true }];
  r = await hand('POST', 'connect', { sealed: 'c2VhbGVk', termsVersion: 'v1' });
  check('muse handover: a bridge that cannot be reached -> 502 muse_unreachable', r.status === 502 && r.json && r.json.code === 'muse_unreachable', r.status + ' ' + r.text.slice(0, 160));
  n = B.handover.length;
  r = await hand('POST', 'connect', { termsVersion: 'v1' });
  check('muse handover: connect without sealed -> 400', r.status === 400, r.status + ' ' + r.text.slice(0, 120));
  r = await hand('POST', 'connect', { sealed: 'c2VhbGVk' });
  check('muse handover: connect without termsVersion -> 400', r.status === 400, r.status + ' ' + r.text.slice(0, 120));
  r = await hand('POST', 'connect', { sealed: 'x'.repeat(9000), termsVersion: 'v1' });
  check('muse handover: a body over 8 KB -> 413', r.status === 413, r.status + ' ' + r.text.slice(0, 120));
  r = await hand('GET', 'connect');
  check('muse handover: GET connect -> 405', r.status === 405, r.status);
  check('muse handover: refused requests never reached the bridge', B.handover.length === n, B.handover.length - n);

  // update and disconnect
  r = await hand('POST', 'update', { sealed: 'dXBkYXRl', museLinkId: 'mlink-0123456789abcdef' });
  last = calls('/update').slice(-1)[0];
  check('muse handover: update relays, with the link id', r.status === 200 && r.json && r.json.updated === true && !!last && last.key === BRIDGE_KEY && JSON.stringify(last.body) === JSON.stringify({ sealed: 'dXBkYXRl', museLinkId: 'mlink-0123456789abcdef' }), r.status + ' ' + JSON.stringify(last && last.body));
  r = await hand('POST', 'update', { sealed: 'dXBkYXRl' });
  last = calls('/update').slice(-1)[0];
  check('muse handover: update without a link id sends sealed alone', r.status === 200 && JSON.stringify(last.body) === JSON.stringify({ sealed: 'dXBkYXRl' }), JSON.stringify(last && last.body));
  B.next['/update'] = [{ status: 409, body: { code: 'vm_mismatch', error: 'not that link' } }];
  r = await hand('POST', 'update', { sealed: 'dXBkYXRl', museLinkId: 'mlink-other' });
  check('muse handover: update passes a 409 through', r.status === 409 && r.json.code === 'vm_mismatch', r.status + ' ' + r.text.slice(0, 120));
  r = await hand('POST', 'disconnect', { museLinkId: 'mlink-0123456789abcdef', sealed: 'not forwarded' });
  last = calls('/disconnect').slice(-1)[0];
  check('muse handover: disconnect relays the link id alone', r.status === 200 && r.json && r.json.removed === true && !!last && last.key === BRIDGE_KEY && JSON.stringify(last.body) === JSON.stringify({ museLinkId: 'mlink-0123456789abcdef' }), r.status + ' ' + JSON.stringify(last && last.body));
  n = B.handover.length;
  r = await hand('POST', 'disconnect', {});
  check('muse handover: disconnect without a link id -> 400', r.status === 400 && B.handover.length === n, r.status);
  r = await hand('POST', 'status', { museLinkId: 'mlink-0123456789abcdef', sealed: 'not forwarded' });
  last = calls('/status').slice(-1)[0];
  check('muse handover: status relays the link id alone, with the room count back', r.status === 200 && r.json && r.json.rooms === 2 && r.json.connected === true && !!last && last.key === BRIDGE_KEY && JSON.stringify(last.body) === JSON.stringify({ museLinkId: 'mlink-0123456789abcdef' }), r.status + ' ' + JSON.stringify(last && last.body));
  B.next['/status'] = [{ status: 410, body: { code: 'link_gone', error: 'link gone' } }];
  r = await hand('POST', 'status', { museLinkId: 'mlink-gone' });
  check('muse handover: status passes a 410 link_gone through', r.status === 410 && r.json && r.json.code === 'link_gone', r.status + ' ' + r.text.slice(0, 120));
  n = B.handover.length;
  r = await hand('POST', 'status', {});
  check('muse handover: status without a link id -> 400', r.status === 400 && B.handover.length === n, r.status);

  // without the bridge key: 503 and no bridge call, on every route
  n = B.handover.length;
  const nokey = { 'X-Test-Muse-No-Key': '1', 'X-Owner-Key': ctx.OWNER };
  const off = [
    await hand('GET', 'seal-key', undefined, nokey),
    await hand('POST', 'connect', { sealed: 'c2VhbGVk', termsVersion: 'v1' }, nokey),
    await hand('POST', 'update', { sealed: 'c2VhbGVk' }, nokey),
    await hand('POST', 'disconnect', { museLinkId: 'mlink-x' }, nokey),
    await hand('POST', 'status', { museLinkId: 'mlink-x' }, nokey),
  ];
  check('muse handover: without the bridge key every route -> 503 muse_unavailable', off.every((x) => x.status === 503 && x.json && x.json.code === 'muse_unavailable'), JSON.stringify(off.map((x) => x.status)));
  check('muse handover: ... and the bridge was not called', B.handover.length === n, B.handover.length - n);

  // the per-network cap: a fresh address gets its share, then 429
  const capIp = { 'CF-Connecting-IP': net + '2' };
  let first429 = 0, got = null;
  for (let i = 1; i <= 40; i++) {
    const x = await req('GET', '/api/muse/seal-key', { headers: capIp });
    if (x.status === 429) { first429 = i; got = x; break; }
  }
  check('muse handover: calls from one network are capped (429 rate_limited with Retry-After)', first429 > 1 && got && got.json && got.json.code === 'rate_limited' && Number(got.headers.get('retry-after')) > 0, first429 + ' ' + (got && got.text.slice(0, 120)));
  r = await hand('GET', 'seal-key');
  check('muse handover: another network is not held by that cap', r.status === 200, r.status);

  // the terms page the gadget's "Agree and connect" names
  r = await req('GET', '/muse-terms');
  check('muse terms: /muse-terms is the v1 page', r.status === 200 && /text\/html/.test(r.headers.get('content-type') || '') && r.text.includes('<h1>Muse delivery terms (v1)</h1>') && r.text.includes('[Agent Chat]') && r.text.includes('the bridge never receives it') && !r.text.includes('Full terms to follow'), r.status + ' ' + r.text.slice(0, 120));
  r = await req('GET', '/muse-gadget');
  check('muse gadget: /muse-gadget is the setup guide, with its screenshots', r.status === 200 && /text\/html/.test(r.headers.get('content-type') || '') && r.text.includes('<h1>Your Muse gadget: setup guide</h1>') && r.text.includes('src="/muse-gadget/settings.png"') && r.text.includes('src="/muse-gadget/agent-chat-off.png"') && r.text.includes('src="/muse-gadget/pairing.png"') && r.text.includes('href="/muse-terms"'), r.status + ' ' + r.text.slice(0, 120));
  r = await req('GET', '/muse-gadget/agent-chat-connected.png');
  check('muse gadget: its screenshots are served', r.status === 200 && /image\/png/.test(r.headers.get('content-type') || ''), r.status + ' ' + r.headers.get('content-type'));
}

module.exports = { museHooks, fakeBridge };
