// Muse delivery hooks (worker/room/muse.ts, worker/routes/muse.ts) against
// a real local Worker: registration (the batch call, the one-time code),
// each member's own status and settings, which room items wake a hook,
// grouping, retries, no duplicates across a restart, no delivery while
// off or muted, and the refusals. The bridge is fakeBridge() below: the
// MUSE_BRIDGE stand-in Worker (tests/api/fake-muse-bridge.js) forwards to
// it, it records every call and answers as each check asks. Called from
// api.test.js; its rooms are its own.
'use strict';
const http = require('http');

/** The suite's Muse bridge: claim codes it knows give a link id; a
 *  delivery answers 200 unless plan[linkId] holds the next answers. */
function fakeBridge() {
  const state = { codes: {}, claims: [], delivers: [], plan: {} };
  const server = http.createServer((q, res) => {
    let raw = '';
    q.on('data', (c) => { raw += c; });
    q.on('end', () => {
      let body = null;
      try { body = JSON.parse(raw); } catch {}
      const send = (status, obj, headers) => { res.writeHead(status, Object.assign({ 'Content-Type': 'application/json' }, headers || {})); res.end(JSON.stringify(obj)); };
      if (q.url === '/claim') {
        state.claims.push({ raw, body });
        const link = body && state.codes[body.code];
        if (!link) return send(404, { error: 'unknown code' });
        delete state.codes[body.code];
        return send(200, { museLinkId: link });
      }
      if (q.url === '/deliver') {
        const link = body && body.museLinkId;
        const next = (state.plan[link] || []).shift();
        const status = next ? next.status : 200;
        state.delivers.push({ raw, body, status, at: Date.now() });
        if (status === 410) return send(410, { error: 'link gone', code: 'link_gone' });
        if (status === 429) return send(429, { error: 'slow down' }, { 'Retry-After': String(next.retryAfter || 1) });
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
  B.codes['code-bob'] = 'link-bob';
  r = await reg({ code: 'code-bob', routing: 'main', rooms: [{ room, token: TB }] });
  check('muse: a second member registers with routing main', r.status === 200 && r.json.results[0].ok && r.json.results[0].hook.routing === 'main', r.text.slice(0, 200));

  // ---- status, and the member list's flag
  r = await hook(R, TA);
  check('muse: status shows my hook', r.status === 200 && r.json.name === 'MuseAda' && r.json.hook && r.json.hook.routing === 'agent-chat' && r.json.hook.enabled === true && 'last_delivered_at' in r.json.hook && !('link' in r.json.hook), JSON.stringify(r.json));
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
  r = await hook(R, TA);
  check('muse: after removal, status is null', r.status === 200 && r.json.hook === null);
  await req('DELETE', R + '/invites/' + TB, { owner: true });
  tries0 = B.delivers.length;
  await post(R, TC, 'muse after revoke');
  await sleep(1200);
  check('muse: a revoked member\'s hook wakes no more', !B.delivers.slice(tries0).some((d) => d.body.museLinkId === 'link-bob'));
  pk = await peek(room);
  check('muse: a revoked member\'s hook is gone from storage', !hookOf(pk, 'musebob'), JSON.stringify(pk && pk.hooks));

  for (const P of [R, R2]) {
    await req('DELETE', P + '/invites', { owner: true });
    await req('DELETE', P + '?confirm=' + P.split('/').pop(), { owner: true });
  }
}

module.exports = { museHooks, fakeBridge };
