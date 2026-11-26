// Muse delivery hooks (worker/room/muse.ts, worker/routes/muse.ts) on the
// real Muse bridge (worker/bridge) in a real local Worker, with only Muse
// itself faked: tests/api/fake-muse.mjs answers fetch_vms and each VM's
// Noise socket on 127.0.0.1, where the test server sends the bridge's calls
// to Muse (TEST_MUSE_ORIGIN, under TEST_HOOKS). Each link is made as a
// gadget makes it: its Muse token sealed to GET /api/muse/seal-key and
// handed over with POST /api/muse/connect. Then: registration (the batch
// call, the one-time code), each member's own status and settings, which
// room items wake a hook and what reaches the Muse, grouping, retries (Muse
// refusing a wake or the token, the bridge's rate cap), no duplicates
// across a restart, no delivery while off or muted, a disconnected link
// turning its hooks off, each hook set or removed counted in the link's
// rooms; and the gadget's handover routes (connect, update, disconnect,
// status, seal-key) answering as the gadget expects. Called from
// api.test.js; its rooms are its own.
'use strict';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms) => { const end = Date.now() + (ms || 6000); while (Date.now() < end) { if (await fn()) return true; await sleep(100); } return !!(await fn()); };

/** The gadget's handover calls from one network (each test's own, so the
 *  per-network cap counts them apart). */
function handover(req, ip) {
  return (method, route, json) => req(method, '/api/muse/' + route, { json, headers: { 'CF-Connecting-IP': ip } });
}

/** A gadget linking its Muse: a Muse account with one VM on the fake Muse,
 *  the token sealed to the site's key and handed over as the gadget does.
 *  Returns the link's code and id, and the names the fake Muse knows. */
async function museGadget(ctx, hand, name) {
  const { muse, SUF } = ctx;
  const token = 'tok-' + name + '-' + SUF, vm = 'vm-' + name + '-' + SUF, node = 'gadget-' + name;
  muse.account(token, vm);
  const sealed = await muse.seal({ accessToken: token, nodeId: node }, ctx.sealPublicKey);
  const r = await hand('POST', 'connect', { sealed, termsVersion: 'v1' });
  return { token, vm, node, sealed, status: r.status, code: r.json && r.json.code, link: r.json && r.json.museLinkId, expiresAt: r.json && r.json.expiresAt, text: r.text };
}

async function museHooks(ctx) {
  const { req, check, SUF, muse } = ctx;
  const M = muse.state;
  const room = 'apitest-muse-' + SUF, room2 = 'apitest-muse2-' + SUF;
  const R = '/api/rooms/' + room, R2 = '/api/rooms/' + room2;
  const SIDE = 'A1B2C3D4-0000-4000-8000-0123456789AB';
  const net = '198.51.' + (parseInt(SUF, 36) % 250) + '.';
  const hand = handover(req, net + '3');
  // room counts are read often; their calls count apart from the rest
  const roomsOf = async (g) => (await handover(req, net + '5')('POST', 'status', { museLinkId: g.link })).json;
  await req('POST', R, { owner: true });
  await req('POST', R2, { owner: true });
  const inv = async (P, name, kind) => (await req('POST', P + '/invites', { owner: true, json: { name, kind } })).json.token;
  const TA = await inv(R, 'MuseAda', 'agent'), TB = await inv(R, 'MuseBob', 'agent'), TC = await inv(R, 'MuseCy', 'human');
  const TA2 = await inv(R2, 'MuseAda', 'agent');
  const post = async (P, token, text) => (await req('POST', P + '/messages', { token, json: { text } })).json;
  // what each gadget's Muse has taken so far (the fake VM answered 2xx)
  const chatsOf = (g) => M.chats.filter((c) => c.vm === g.vm && c.status >= 200 && c.status < 300);
  const itemsOf = (g) => [].concat(...chatsOf(g).map((c) => c.items));
  const textsOf = (g) => itemsOf(g).filter((i) => !i.type && typeof i.text === 'string').map((i) => i.text);
  const triesOf = (g, from) => M.chats.slice(from).filter((c) => c.vm === g.vm);
  const hook = (P, token, method, json) => req(method || 'GET', P + '/muse-hook', { token, json });
  const peek = async (rm) => (await req('POST', '/api/test-hooks/muse', { owner: true, json: { room: rm, action: 'peek' } })).json;
  const run = async (rm) => (await req('POST', '/api/test-hooks/muse', { owner: true, json: { room: rm, action: 'run' } })).json;
  // A run that finds the room's alarm still busy with another hook's wake
  // (a real Noise handshake takes a moment) leaves the due wakes to it:
  // run again until what the check waits for has happened.
  const runUntil = async (rm, done) => { for (let i = 0; i < 20; i++) { await run(rm); if (await done()) return true; await sleep(150); } return !!(await done()); };
  const hookOf = (pk, member) => ((pk && pk.hooks) || []).find((h) => h.member === member) || null;
  const reg = (json) => req('POST', '/api/muse/hooks', { json });

  // ---- two gadgets link their Muses
  const ada = await museGadget(ctx, hand, 'ada');
  const bob = await museGadget(ctx, hand, 'bob');
  check('muse: a gadget\'s handover makes a link and a one-time code', ada.status === 200 && /^ml_[0-9a-f]{32}$/.test(ada.link) && /^[0-9A-Z]{5}-[0-9A-Z]{5}$/.test(ada.code) && bob.status === 200 && bob.link !== ada.link, ada.status + ' ' + bob.status);
  check('muse: ... once Muse took the token (fetch_vms)', M.fetches.some((f) => f.token === ada.token && f.status === 200) && M.fetches.some((f) => f.token === bob.token && f.status === 200));

  // ---- registration: validation and refusals; none of them spends the code
  let r = await reg({ rooms: [{ room, token: TA }] });
  check('muse: registration without a code -> 400', r.status === 400, r.status + ' ' + r.text.slice(0, 120));
  r = await reg({ code: ada.code, routing: 'sideways', rooms: [{ room, token: TA }] });
  check('muse: a default routing that is not one -> 400', r.status === 400 && /routing/.test(r.json && r.json.error), r.status + ' ' + r.text.slice(0, 160));
  r = await reg({ code: ada.code, rooms: [] });
  check('muse: an empty rooms list -> 400', r.status === 400, r.status);
  r = await reg({ code: ada.code, rooms: [{ room, token: TA, routing: 'side-chat-7' }] });
  check('muse: a side chat id that is not a UUID is refused for its room', r.status === 403 && r.json.code === 'no_rooms' && r.json.results[0].status === 400 && /UUID/.test(r.json.results[0].error), r.status + ' ' + r.text.slice(0, 200));
  r = await reg({ code: ada.code, rooms: [{ room, token: 'muse-bogus' }] });
  check('muse: a wrong token is refused (invite_invalid)', r.status === 403 && r.json.results[0].status === 403 && r.json.results[0].code === 'invite_invalid', r.status + ' ' + r.text.slice(0, 200));
  r = await reg({ code: ada.code, rooms: [{ room, token: TA2 }] });
  check('muse: a token for a different room is refused', r.status === 403 && r.json.results[0].code === 'invite_invalid', r.status + ' ' + r.text.slice(0, 200));
  r = await reg({ code: ada.code, rooms: [{ room: 'apitest-muse-none-' + SUF, token: TA }] });
  check('muse: a room that does not exist is refused', r.status === 403 && r.json.results[0].status === 404, r.status + ' ' + r.text.slice(0, 200));
  r = await reg({ code: 'not-a-code', rooms: [{ room, token: TA }] });
  check('muse: an unknown code -> 403 code_invalid, saying where a new code comes from (the gadget)', r.status === 403 && r.json.code === 'code_invalid' && r.json.error.includes('tap Agree and connect (or Add rooms) on the gadget again'), r.status + ' ' + r.text.slice(0, 200));
  r = await hook(R, TA);
  check('muse: an unknown code set no hook', r.status === 200 && r.json.hook === null, JSON.stringify(r.json));

  // ---- a batch: two rooms and a bad pair, one claim
  r = await reg({ code: ada.code, rooms: [{ room, token: TA }, { room: room2, token: TA2, routing: SIDE }, { room, token: 'muse-bogus' }] });
  const res = (r.json && r.json.results) || [];
  check('muse: batch registration -> 200 with per-room results (the code was still good after every refusal above)', r.status === 200 && r.json.claimed === true && res.length === 3, r.status + ' ' + r.text.slice(0, 200));
  check('muse: batch: the first room is set, default routing agent-chat', res[0] && res[0].ok && res[0].name === 'MuseAda' && res[0].hook.routing === 'agent-chat' && res[0].hook.enabled === true && res[0].hook.muted === false, JSON.stringify(res[0]));
  check('muse: batch: the second room takes its own routing (a side chat id, lowercased)', res[1] && res[1].ok && res[1].hook.routing === SIDE.toLowerCase(), JSON.stringify(res[1]));
  check('muse: batch: the bad pair fails alone', res[2] && !res[2].ok && res[2].status === 403, JSON.stringify(res[2]));
  check('muse: the response carries no token', !r.text.includes(TA) && !r.text.includes(TA2));
  check('muse: the response carries no link id', !r.text.includes(ada.link), r.text.slice(0, 300));
  r = await reg({ code: ada.code, rooms: [{ room, token: TA }] });
  check('muse: the code is single use: claimed once, then 403 code_invalid', r.status === 403 && r.json.code === 'code_invalid', r.status + ' ' + r.text.slice(0, 160));
  let st = await roomsOf(ada);
  check('muse: each room set is counted on the link (the gadget\'s status: 2 rooms)', st && st.rooms === 2 && st.connected === true && st.termsVersion === 'v1' && st.tokenHeld === true, JSON.stringify(st));
  r = await reg({ code: bob.code, routing: 'main', rooms: [{ room, token: TB }] });
  check('muse: a second member registers with routing main', r.status === 200 && r.json.results[0].ok && r.json.results[0].hook.routing === 'main', r.text.slice(0, 200));

  // ---- status, and the member list's flag
  r = await hook(R, TA);
  check('muse: status shows my hook', r.status === 200 && r.json.name === 'MuseAda' && r.json.hook && r.json.hook.routing === 'agent-chat' && r.json.hook.enabled === true && 'last_delivered_at' in r.json.hook && !('link' in r.json.hook), JSON.stringify(r.json));
  check('muse: the hook view has no link id', !('museLinkId' in r.json.hook) && !r.text.includes(ada.link), r.text);
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
  check('muse: the members list shows no link id', !r.text.includes(ada.link) && !r.text.includes(bob.link));
  check('muse: the members list flags Muse delivery', mem('MuseAda').muse_delivery === true && mem('MuseBob').muse_delivery === true && mem('MuseCy').muse_delivery === false, JSON.stringify(((r.json && r.json.members) || []).map((x) => [x.name, x.muse_delivery])));

  // ---- selection: other members' messages wake; your own never does
  await post(R, TC, 'muse sel one');
  check('muse: another member\'s message wakes both hooks\' Muses', await waitFor(() => textsOf(ada).includes('muse sel one') && textsOf(bob).includes('muse sel one')), JSON.stringify([textsOf(ada), textsOf(bob)]));
  await post(R, TA, 'muse own words');
  check('muse: my message wakes the others', await waitFor(() => textsOf(bob).includes('muse own words')));
  await sleep(1200);
  check('muse: my own message never wakes me', !textsOf(ada).includes('muse own words'), JSON.stringify(textsOf(ada)));
  const one = chatsOf(ada)[0];
  check('muse: the wake reaches the Muse as the bridge writes it: "[Agent Chat]", each item fenced, its room first', !!one && one.body.message.startsWith('[Agent Chat]\n```') && one.items.length >= 1 && one.items.every((i) => Object.keys(i)[0] === 'room' && i.room === room), JSON.stringify(one && one.body).slice(0, 300));
  check('muse: ... in the Agent Chat side chat (routing agent-chat), from the gadget\'s device, as text', !!one && one.body.session_id === muse.derivedSessionId(ada.link, 'agent-chat') && one.body.device_id === ada.node && one.body.output_modality === 'text', JSON.stringify(one && { s: one.body.session_id, d: one.body.device_id }));
  const bobFirst = chatsOf(bob)[0];
  check('muse: routing main lands in the Muse\'s main chat (no session id)', !!bobFirst && !('session_id' in bobFirst.body) && bobFirst.body.device_id === bob.node, JSON.stringify(bobFirst && bobFirst.body).slice(0, 200));
  check('muse: a message item is the stream frame\'s data', !!one && one.items[0].from === 'MuseCy' && one.items[0].text === 'muse sel one' && typeof one.items[0].id === 'number', JSON.stringify(one && one.items[0]));
  check('muse: each VM is reached with its own bearer, from fetch_vms', M.upgrades.filter((u) => u.vm === ada.vm && u.status === 101).every((u) => u.auth === 'Bearer ' + muse.bearer(ada.vm)) && M.upgrades.some((u) => u.vm === ada.vm), JSON.stringify(M.upgrades.slice(-2).map((u) => u.status)));

  // ---- reactions and game frames wake only the members they target
  const adaMsg = (await req('GET', R + '/messages?limit=5', { token: TA })).json.messages.find((x) => x.text === 'muse own words');
  const nAda = itemsOf(ada).length, nBob = itemsOf(bob).length;
  await req('POST', R + '/messages/' + adaMsg.id + '/reactions', { token: TB, json: { reaction: '👍' } });
  check('muse: a reaction wakes the message\'s author', await waitFor(() => itemsOf(ada).slice(nAda).some((i) => i.type === 'reaction' && i.id === adaMsg.id)), JSON.stringify(itemsOf(ada).slice(nAda)));
  await sleep(1000);
  check('muse: a reaction never wakes the one who reacted', !itemsOf(bob).slice(nBob).some((i) => i.type === 'reaction'), JSON.stringify(itemsOf(bob).slice(nBob)));
  r = await req('POST', R + '/games', { token: TA, json: { game: 'duel', players: ['MuseAda', 'MuseBob'], best_of: 1, tick_seconds: 3600 } });
  const gid = r.json && r.json.game && r.json.game.id;
  // the create's own wakes (Bob: the card and the lobby awaiting him) go first
  check('muse: a new match wakes the invited player', await waitFor(() => itemsOf(bob).slice(nBob).some((i) => i.type === 'game' && i.game && i.game.id === gid && i.from === 'MuseAda')), JSON.stringify(itemsOf(bob).slice(nBob)).slice(0, 300));
  await sleep(800);
  const nAda2 = itemsOf(ada).length, nBob2 = itemsOf(bob).length;
  await req('POST', R + '/games/' + gid + '/accept', { token: TB, json: {} });
  check('muse: a game frame wakes the players it awaits', await waitFor(() => itemsOf(ada).slice(nAda2).some((i) => i.type === 'game' && i.game && i.game.id === gid)), JSON.stringify(itemsOf(ada).slice(nAda2)).slice(0, 300));
  await sleep(1000);
  check('muse: a game frame never wakes the one who made it', !itemsOf(bob).slice(nBob2).some((i) => i.type === 'game'), JSON.stringify(itemsOf(bob).slice(nBob2)).slice(0, 300));
  await req('POST', R + '/games/' + gid + '/cancel', { token: TA, json: {} });
  await sleep(1200);

  // ---- grouping: a burst is one wake, at most 10 items to a wake
  let w0 = chatsOf(ada).length;
  for (let i = 0; i < 3; i++) await post(R, TC, 'muse burst3 ' + i);
  await waitFor(() => textsOf(ada).includes('muse burst3 2'));
  await sleep(300);
  let wakes = chatsOf(ada).slice(w0).filter((c) => c.items.some((i) => /^muse burst3/.test(i.text || '')));
  check('muse: three messages in a burst go out as one wake', wakes.length === 1 && wakes[0].items.filter((i) => /^muse burst3/.test(i.text || '')).length === 3, JSON.stringify(wakes.map((c) => c.items.map((i) => i.text))));
  w0 = chatsOf(ada).length;
  await Promise.all(Array.from({ length: 12 }, (_, i) => post(R, TC, 'muse burst12 ' + i)));
  await waitFor(() => textsOf(ada).filter((t) => /^muse burst12/.test(t)).length === 12);
  wakes = chatsOf(ada).slice(w0);
  check('muse: twelve messages in a burst: 10 in the first wake, the rest in the next', wakes.length === 2 && wakes[0].items.length === 10 && wakes[1].items.length === 2, JSON.stringify(wakes.map((c) => c.items.length)));
  const ids = itemsOf(ada).filter((i) => !i.type).map((i) => i.id);
  check('muse: every message is handed over once, in order', ids.every((s, i) => i === 0 || s > ids[i - 1]), JSON.stringify(ids));

  // ---- retry: a wake Muse refuses is tried again with the same items
  muse.plan(ada.vm, { status: 500, body: '{"error":"busy"}' });
  let tries0 = M.chats.length;
  await post(R, TC, 'muse retry one');
  await waitFor(() => triesOf(ada, tries0).some((c) => c.status === 500));
  let pk = await peek(room);
  const ha = hookOf(pk, 'museada');
  check('muse: a wake Muse refused (the bridge\'s 502) is kept, with a backoff', !!ha && ha.fails === 1 && ha.pending === 1 && ha.due_at > pk.now + 2000, JSON.stringify(ha));
  await runUntil(room, () => triesOf(ada, tries0).length >= 2);
  let tries = triesOf(ada, tries0);
  check('muse: the retry goes through, with the same items', tries.length === 2 && tries[0].status === 500 && tries[1].status === 200 && tries[1].body.message === tries[0].body.message, JSON.stringify(tries.map((c) => c.status)));
  pk = await peek(room);
  check('muse: after the retry the hook is clear', hookOf(pk, 'museada').fails === 0 && hookOf(pk, 'museada').pending === 0 && hookOf(pk, 'museada').due_at === null, JSON.stringify(hookOf(pk, 'museada')));
  // Muse cuts the connection: the bridge's 502 muse_unreachable, tried again
  muse.plan(ada.vm, { drop: true });
  tries0 = M.chats.length;
  await post(R, TC, 'muse dropped');
  await waitFor(() => triesOf(ada, tries0).length > 0);
  await sleep(300);
  pk = await peek(room);
  check('muse: a wake whose connection Muse cut is kept, with a backoff', hookOf(pk, 'museada').fails === 1 && hookOf(pk, 'museada').pending === 1, JSON.stringify(hookOf(pk, 'museada')));
  await runUntil(room, () => textsOf(ada).includes('muse dropped'));
  check('muse: ... and goes through on the retry, once', textsOf(ada).filter((t) => t === 'muse dropped').length === 1, JSON.stringify(textsOf(ada).slice(-3)));
  // Muse refuses the access token: the bridge answers 503 with its
  // Retry-After; the room waits that long and keeps the hook on
  muse.refuse(ada.token);
  muse.plan(ada.vm, { reject: 401 });
  const f0 = M.fetches.length;
  await post(R, TC, 'muse token glitch');
  await waitFor(() => M.fetches.slice(f0).some((f) => f.token === ada.token && f.status === 401));
  await sleep(300);
  pk = await peek(room);
  check('muse: Muse refusing the token waits the bridge\'s Retry-After (15 min) and keeps the hook on', hookOf(pk, 'museada').due_at > pk.now + 800000 && hookOf(pk, 'museada').pending === 1 && !!hookOf(pk, 'museada').enabled, JSON.stringify(hookOf(pk, 'museada')));
  st = await roomsOf(ada);
  check('muse: ... and the bridge still holds the token (tokenHeld)', st && st.tokenHeld === true, JSON.stringify(st));
  muse.accept(ada.token);
  await runUntil(room, () => textsOf(ada).includes('muse token glitch'));
  check('muse: once Muse takes the token again the wake goes through', textsOf(ada).filter((t) => t === 'muse token glitch').length === 1, JSON.stringify(textsOf(ada).slice(-3)));

  // ---- a restart loses nothing and sends nothing twice
  muse.plan(ada.vm, { status: 500 });
  tries0 = M.chats.length;
  await post(R, TC, 'muse across restart');
  await waitFor(() => triesOf(ada, tries0).some((c) => c.status === 500));
  await req('POST', '/api/test-hooks/muse', { owner: true, json: { room, action: 'restart' } });
  await sleep(500);
  pk = await peek(room);
  check('muse: the refused wake is still queued after a restart', hookOf(pk, 'museada') && hookOf(pk, 'museada').pending === 1, JSON.stringify(pk).slice(0, 300));
  await runUntil(room, () => textsOf(ada).includes('muse across restart'));
  await run(room);
  check('muse: after the restart it is delivered exactly once', textsOf(ada).filter((t) => t === 'muse across restart').length === 1, JSON.stringify(textsOf(ada).slice(-3)));
  await req('POST', '/api/test-hooks/muse', { owner: true, json: { room, action: 'restart' } });
  await sleep(500);
  await run(room);
  await sleep(800);
  const all = itemsOf(ada).filter((i) => !i.type).map((i) => i.id);
  check('muse: a delivered message is never sent again, restart or not', new Set(all).size === all.length, all.length + ' items, ' + new Set(all).size + ' distinct');

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
  check('muse: nothing is delivered while muted or off', !textsOf(ada).includes('muse while muted') && !textsOf(ada).includes('muse while off'), JSON.stringify(textsOf(ada).slice(-3)));
  check('muse: the other member\'s hook kept delivering meanwhile', textsOf(bob).includes('muse while muted') && textsOf(bob).includes('muse while off'));
  r = await hook(R, TA, 'POST', { enabled: true, routing: SIDE });
  check('muse: back on, with a side chat routing', r.status === 200 && r.json.hook.enabled === true && r.json.hook.routing === SIDE.toLowerCase(), JSON.stringify(r.json));
  await post(R, TC, 'muse back on');
  check('muse: back on, it delivers into that side chat', await waitFor(() => chatsOf(ada).some((c) => c.body.session_id === SIDE.toLowerCase() && c.items.some((i) => i.text === 'muse back on'))));

  // ---- the second room's hook is its own
  await req('POST', R2 + '/messages', { owner: true, json: { from: 'Zed', text: 'muse room two' } });
  check('muse: the other room wakes the same link, with its own room and routing', await waitFor(() => chatsOf(ada).some((c) => c.body.session_id === SIDE.toLowerCase() && c.items.some((i) => i.room === room2 && i.text === 'muse room two'))));

  // ---- the bridge's rate cap: past MUSE_LINK_WAKES_MAX wakes in its window
  // a link's wake waits out the Retry-After the bridge gives, kept
  let capped = null;
  for (let i = 0; i < 40 && !capped; i++) {
    await post(R, TB, 'muse rate ' + i);
    await run(room);
    const h = hookOf(await peek(room), 'museada');
    if (h && h.fails > 0) capped = h;
  }
  pk = await peek(room);
  check('muse: past the bridge\'s rate cap a wake waits out its Retry-After (429), kept, the hook on', !!capped && capped.due_at > pk.now + 60000 && capped.pending >= 1 && !!capped.enabled, JSON.stringify(capped));

  // ---- a hook removed: the link's room count drops
  r = await hook(R2, TA2, 'DELETE');
  check('muse: remove my hook', r.status === 200 && r.json.removed === true, JSON.stringify(r.json));
  r = await hook(R2, TA2, 'DELETE');
  check('muse: removing it again -> 404', r.status === 404, r.status);
  check('muse: a removed hook leaves the link\'s room count', await waitFor(async () => { const x = await roomsOf(ada); return x && x.rooms === 1; }, 3000), JSON.stringify(await roomsOf(ada)));
  r = await hook(R2, TA2);
  check('muse: after removal, status is null', r.status === 200 && r.json.hook === null);

  // ---- the gadget disconnects its link: the hook turns off at the next wake
  r = await hand('POST', 'disconnect', { museLinkId: ada.link });
  check('muse: the gadget disconnects its link', r.status === 200 && r.json.removed === true, r.text.slice(0, 160));
  tries0 = M.chats.length;
  await post(R, TC, 'muse link gone');
  await runUntil(room, async () => { const x = hookOf(await peek(room), 'museada'); return !!x && !x.enabled; });
  r = await hook(R, TA);
  check('muse: a link that is gone (410 link_gone) switches the hook off', r.json.hook && r.json.hook.enabled === false && r.json.hook.off_reason === 'link_gone' && r.json.hook.pending === 0 && r.json.hook.last_status === 410, JSON.stringify(r.json));
  await post(R, TC, 'muse after gone');
  await sleep(1200);
  check('muse: nothing went to the Muse of a gone link', !triesOf(ada, tries0).length, triesOf(ada, tries0).length);

  // ---- revocation
  await req('DELETE', R + '/invites/' + TB, { owner: true });
  tries0 = M.chats.length;
  await post(R, TC, 'muse after revoke');
  await sleep(1200);
  check('muse: a revoked member\'s hook wakes no more', !triesOf(bob, tries0).length);
  pk = await peek(room);
  check('muse: a revoked member\'s hook is gone from storage', !hookOf(pk, 'musebob'), JSON.stringify(pk && pk.hooks));
  check('muse: a revoked member\'s hook leaves the link\'s room count', await waitFor(async () => { const x = await roomsOf(bob); return x && x.rooms === 0; }, 3000), JSON.stringify(await roomsOf(bob)));

  // ---- what Muse saw: never a room token, never a link id
  const seen = M.seen.join('\n');
  check('muse: no room token ever reached Muse', ![TA, TB, TC, TA2].some((t) => seen.includes(t)));
  check('muse: no link id ever reached Muse', ![ada.link, bob.link].some((l) => seen.includes(l)));

  for (const P of [R, R2]) {
    await req('DELETE', P + '/invites', { owner: true });
    await req('DELETE', P + '?confirm=' + P.split('/').pop(), { owner: true });
  }

  await museHandover(ctx);
  await museRedirects(ctx);
}

// A redirect from Muse's hosts, in the real Worker: the bridge's calls carry
// the access token (fetch_vms) or the VM bearer (the Noise socket), and
// under the Worker's compatibility date a followed redirect sent that
// header on to the host it named. The fake Muse answers 302 to its
// elsewhere server, which nothing may reach.
async function museRedirects(ctx) {
  const { req, check, SUF, muse } = ctx;
  const M = muse.state;
  const net = '198.51.' + (parseInt(SUF, 36) % 250) + '.';
  const hand = handover(req, net + '7');
  const room = 'apitest-muse3-' + SUF, R = '/api/rooms/' + room;
  await req('POST', R, { owner: true });
  const inv = async (name, kind) => (await req('POST', R + '/invites', { owner: true, json: { name, kind } })).json.token;
  const TE = await inv('MuseEve', 'agent'), TF = await inv('MuseFay', 'human');
  const post = (text) => req('POST', R + '/messages', { token: TF, json: { text } });
  const run = () => req('POST', '/api/test-hooks/muse', { owner: true, json: { room, action: 'run' } });
  const eveHook = async () => ((await req('POST', '/api/test-hooks/muse', { owner: true, json: { room, action: 'peek' } })).json.hooks || []).find((h) => h.member === 'museeve') || null;
  const texts = (vm) => [].concat(...M.chats.filter((c) => c.vm === vm && c.status === 200).map((c) => c.items)).map((i) => i.text);

  // the handover: fetch_vms answers a redirect
  const tok = 'tok-redir-' + SUF;
  muse.account(tok, 'vm-redir-' + SUF);
  muse.redirect(tok);
  let r = await hand('POST', 'connect', { sealed: await muse.seal({ accessToken: tok, nodeId: 'gadget-redir' }, ctx.sealPublicKey), termsVersion: 'v1' });
  check('muse redirect: a handover whose fetch_vms answers 302 -> 502 muse_unreachable', r.status === 502 && r.json && r.json.code === 'muse_unreachable', r.status + ' ' + r.text.slice(0, 160));
  check('muse redirect: ... Muse was asked, and the redirect\'s target never reached', M.fetches.some((f) => f.token === tok && f.status === 302) && M.elsewhere.length === 0, JSON.stringify(M.elsewhere));

  // a linked Muse, hooked to the room, delivering
  const eve = await museGadget(ctx, hand, 'eve');
  r = await req('POST', '/api/muse/hooks', { json: { code: eve.code, rooms: [{ room, token: TE }] } });
  check('muse redirect: a link registered for the room', eve.status === 200 && r.status === 200 && r.json.results[0].ok, eve.status + ' ' + r.status);
  await post('muse redirect warm-up');
  check('muse redirect: it delivers', await waitFor(() => texts(eve.vm).includes('muse redirect warm-up')), JSON.stringify(texts(eve.vm)));

  // the VM's socket answers a redirect: the wake fails and is kept
  muse.redirect(eve.vm);
  let u0 = M.upgrades.length;
  await post('muse redirect socket');
  await waitFor(() => M.upgrades.slice(u0).some((u) => u.vm === eve.vm && u.status === 302));
  check('muse redirect: a wake whose Noise socket answers 302 is kept, with a backoff (502)', await waitFor(async () => { const h = await eveHook(); return !!h && h.fails === 1 && h.pending === 1; }), JSON.stringify(await eveHook()));
  check('muse redirect: ... and the VM bearer never reached the redirect\'s target', M.elsewhere.length === 0, JSON.stringify(M.elsewhere));
  muse.unredirect(eve.vm);

  // the VM bearer refused, so the wake asks fetch_vms again, which answers a redirect
  muse.plan(eve.vm, { reject: 401 });
  muse.redirect(eve.token);
  const f0 = M.fetches.length;
  await run();
  await waitFor(() => M.fetches.slice(f0).some((f) => f.token === eve.token && f.status === 302));
  check('muse redirect: a wake\'s fetch_vms answering 302 keeps the wake (502)', await waitFor(async () => { const h = await eveHook(); return !!h && h.fails === 2 && h.pending === 1 && !!h.enabled; }), JSON.stringify(await eveHook()));
  check('muse redirect: ... and the access token never reached the redirect\'s target', M.elsewhere.length === 0, JSON.stringify(M.elsewhere));

  // Muse answers again: the kept wake goes through, once
  muse.unredirect(eve.token);
  for (let i = 0; i < 20 && !texts(eve.vm).includes('muse redirect socket'); i++) { await run(); await sleep(150); }
  check('muse redirect: once Muse answers again the kept wake is delivered, once', texts(eve.vm).filter((t) => t === 'muse redirect socket').length === 1, JSON.stringify(texts(eve.vm)));
  check('muse redirect: nothing ever reached the redirect\'s target', M.elsewhere.length === 0, JSON.stringify(M.elsewhere));

  await req('DELETE', R + '/invites', { owner: true });
  await req('DELETE', R + '?confirm=' + room, { owner: true });
}

// The gadget's handover: GET /api/muse/seal-key, POST /api/muse/connect,
// /update, /disconnect and /status, answered by the bridge, with no member
// token. The gadget's firmware reads these answers byte for byte.
async function museHandover(ctx) {
  const { req, check, SUF, muse } = ctx;
  const M = muse.state;
  // each run counts against the per-network cap under its own address
  const net = '198.51.' + (parseInt(SUF, 36) % 250) + '.';
  const hand = handover(req, net + '1');
  const hand2 = handover(req, net + '6');
  let r, n;

  // seal-key: the run's key, with the alg and info the firmware checks, cacheable
  r = await hand('GET', 'seal-key');
  const want = '{"alg":"X25519-HKDF-SHA256-AES-256-GCM","info":"muse-bridge seal v1","publicKey":"' + ctx.sealPublicKey + '"}';
  check('muse handover: seal-key answers the key, its alg and info, byte for byte', r.status === 200 && r.text === want, r.status + ' ' + r.text.slice(0, 160));
  check('muse handover: ... as JSON, cacheable, with CORS', /^application\/json/.test(r.headers.get('content-type') || '') && /public/.test(r.headers.get('cache-control') || '') && /max-age=\d+/.test(r.headers.get('cache-control') || '') && r.headers.get('access-control-allow-origin') === '*', r.headers.get('content-type') + ' ' + r.headers.get('cache-control'));
  r = await hand('GET', 'seal-key');
  check('muse handover: a second seal-key answers the same', r.status === 200 && r.text === want, r.status);
  r = await req('HEAD', '/api/muse/seal-key', { headers: { 'CF-Connecting-IP': net + '1' } });
  check('muse handover: HEAD seal-key -> 200', r.status === 200, r.status);

  // connect: no member token; the answer as the firmware reads it
  const cy = await museGadget(ctx, hand, 'cy');
  check('muse handover: connect with no token -> {code, museLinkId, expiresAt}, in that order', cy.status === 200 && cy.text === JSON.stringify({ code: cy.code, museLinkId: cy.link, expiresAt: cy.expiresAt }) && cy.expiresAt > Date.now() + 25 * 60000, cy.status + ' ' + cy.text.slice(0, 200));
  const again = await museGadget(ctx, hand, 'cy');
  check('muse handover: the same Muse connecting again keeps its link, with a new code (Add rooms)', again.status === 200 && again.link === cy.link && again.code !== cy.code, again.status + ' ' + (again.link === cy.link));
  const refusal = (x, status, code) => x.status === status && x.json && x.json.code === code && typeof x.json.error === 'string' && /^application\/json/.test(x.headers.get('content-type') || '') && x.headers.get('cache-control') === 'no-store';
  const fetches0 = M.fetches.length;
  r = await hand('POST', 'connect', { sealed: 'c2VhbGVk', termsVersion: 'v1' });
  check('muse handover: a seal that does not open -> 400 seal_invalid', refusal(r, 400, 'seal_invalid'), r.status + ' ' + r.text.slice(0, 160));
  check('muse handover: ... and Muse was not asked', M.fetches.length === fetches0, M.fetches.length - fetches0);
  const sealedFor = (token, extra) => muse.seal(Object.assign({ accessToken: token, nodeId: 'gadget-x' }, extra || {}), ctx.sealPublicKey);
  r = await hand('POST', 'connect', { sealed: await sealedFor('tok-unknown-' + SUF), termsVersion: 'v1' });
  check('muse handover: a token Muse refuses -> 403 token_refused', refusal(r, 403, 'token_refused'), r.status + ' ' + r.text.slice(0, 160));
  muse.account('tok-novm-' + SUF);
  r = await hand('POST', 'connect', { sealed: await sealedFor('tok-novm-' + SUF), termsVersion: 'v1' });
  check('muse handover: a Muse account with no VM -> 422 no_vm', refusal(r, 422, 'no_vm'), r.status + ' ' + r.text.slice(0, 160));
  muse.account('tok-down-' + SUF, 'vm-down-' + SUF);
  muse.refuse('tok-down-' + SUF, 500);
  r = await hand('POST', 'connect', { sealed: await sealedFor('tok-down-' + SUF), termsVersion: 'v1' });
  check('muse handover: Muse not answering -> 502 muse_unreachable', refusal(r, 502, 'muse_unreachable'), r.status + ' ' + r.text.slice(0, 160));
  const fetches1 = M.fetches.length;
  r = await hand('POST', 'connect', { sealed: await sealedFor(cy.token, { apiUrlV2: 'https://muse.invalid/' }), termsVersion: 'v1' });
  check('muse handover: a handover naming a host that is not Muse\'s -> 400 host_not_allowed', refusal(r, 400, 'host_not_allowed'), r.status + ' ' + r.text.slice(0, 160));
  r = await hand('POST', 'connect', { sealed: await sealedFor(cy.token, { noiseHost: 'muse.invalid' }), termsVersion: 'v1' });
  check('muse handover: ... for the Noise host too', refusal(r, 400, 'host_not_allowed'), r.status + ' ' + r.text.slice(0, 160));
  r = await hand('POST', 'connect', { sealed: await sealedFor('bad token\n'), termsVersion: 'v1' });
  check('muse handover: a malformed handover -> 400 bad_handover', refusal(r, 400, 'bad_handover'), r.status + ' ' + r.text.slice(0, 160));
  check('muse handover: ... and none of those three reached Muse', M.fetches.length === fetches1, M.fetches.length - fetches1);
  n = M.fetches.length;
  r = await hand('POST', 'connect', { termsVersion: 'v1' });
  check('muse handover: connect without sealed -> 400', r.status === 400, r.status + ' ' + r.text.slice(0, 120));
  r = await hand('POST', 'connect', { sealed: cy.sealed });
  check('muse handover: connect without termsVersion -> 400', r.status === 400, r.status + ' ' + r.text.slice(0, 120));
  r = await hand('POST', 'connect', { sealed: 'x'.repeat(9000), termsVersion: 'v1' });
  check('muse handover: a body over 8 KB -> 413', r.status === 413, r.status + ' ' + r.text.slice(0, 120));
  r = await hand('GET', 'connect');
  check('muse handover: GET connect -> 405', r.status === 405, r.status);
  check('muse handover: refused requests never reached Muse', M.fetches.length === n, M.fetches.length - n);

  // update: a refreshed token for the same Muse
  const fresh = 'tok-cy-fresh-' + SUF;
  muse.account(fresh, cy.vm);
  r = await hand2('POST', 'update', { sealed: await muse.seal({ accessToken: fresh, nodeId: cy.node }, ctx.sealPublicKey), museLinkId: cy.link });
  check('muse handover: update with the link id -> {museLinkId, updated: true}', r.status === 200 && r.text === JSON.stringify({ museLinkId: cy.link, updated: true }), r.status + ' ' + r.text.slice(0, 160));
  r = await hand2('POST', 'update', { sealed: await muse.seal({ accessToken: fresh, nodeId: cy.node }, ctx.sealPublicKey) });
  check('muse handover: update without a link id finds the link by its Muse', r.status === 200 && r.json.museLinkId === cy.link && r.json.updated === true, r.status + ' ' + r.text.slice(0, 160));
  const dee = await museGadget(ctx, hand2, 'dee');
  r = await hand2('POST', 'update', { sealed: dee.sealed, museLinkId: cy.link });
  check('muse handover: an update naming another Muse\'s link -> 409 vm_mismatch (the gadget stops retrying)', refusal(r, 409, 'vm_mismatch'), r.status + ' ' + r.text.slice(0, 120));
  muse.account('tok-nolink-' + SUF, 'vm-nolink-' + SUF);
  r = await hand2('POST', 'update', { sealed: await sealedFor('tok-nolink-' + SUF) });
  check('muse handover: an update for a Muse with no link -> 404 no_link (the gadget forgets its link)', refusal(r, 404, 'no_link'), r.status + ' ' + r.text.slice(0, 120));
  r = await hand2('POST', 'update', { sealed: cy.sealed, museLinkId: 'not-a-link' });
  check('muse handover: a malformed link id -> 400 bad_request', refusal(r, 400, 'bad_request'), r.status + ' ' + r.text.slice(0, 120));

  // status and disconnect
  r = await hand2('POST', 'status', { museLinkId: cy.link, sealed: 'not forwarded' });
  check('muse handover: status -> {museLinkId, connected, rooms, termsVersion, tokenHeld}', r.status === 200 && r.text === JSON.stringify({ museLinkId: cy.link, connected: true, rooms: 0, termsVersion: 'v1', tokenHeld: true }), r.status + ' ' + r.text.slice(0, 200));
  n = M.fetches.length;
  r = await hand2('POST', 'status', {});
  check('muse handover: status without a link id -> 400', r.status === 400, r.status);
  r = await hand2('POST', 'disconnect', { museLinkId: cy.link, sealed: 'not forwarded' });
  check('muse handover: disconnect -> {museLinkId, removed: true}', r.status === 200 && r.text === JSON.stringify({ museLinkId: cy.link, removed: true }), r.status + ' ' + r.text.slice(0, 160));
  r = await hand2('POST', 'disconnect', { museLinkId: cy.link });
  check('muse handover: disconnecting again -> removed false', r.status === 200 && r.json.removed === false, r.status + ' ' + r.text.slice(0, 160));
  r = await hand2('POST', 'disconnect', {});
  check('muse handover: disconnect without a link id -> 400', r.status === 400, r.status);
  r = await hand2('POST', 'status', { museLinkId: cy.link });
  check('muse handover: status of a disconnected link -> 410 link_gone (the gadget forgets it)', refusal(r, 410, 'link_gone'), r.status + ' ' + r.text.slice(0, 120));
  check('muse handover: status and disconnect never ask Muse', M.fetches.length === n, M.fetches.length - n);
  r = await hand2('POST', 'update', { sealed: await muse.seal({ accessToken: fresh, nodeId: cy.node }, ctx.sealPublicKey) });
  check('muse handover: after a disconnect an update finds no link -> 404 no_link', refusal(r, 404, 'no_link'), r.status + ' ' + r.text.slice(0, 120));

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
  check('muse gadget: /muse-gadget is the setup guide, with its screenshots', r.status === 200 && /text\/html/.test(r.headers.get('content-type') || '') && r.text.includes('<h1>Your Muse gadget: setup guide</h1>') && r.text.includes('src="/muse-gadget/settings.png"') && r.text.includes('src="/muse-gadget/agent-chat-off.png"') && r.text.includes('src="/muse-gadget/pair-step1.png"') && r.text.includes('id="pair"') && r.text.includes('href="/muse-terms"'), r.status + ' ' + r.text.slice(0, 120));
  r = await req('GET', '/muse-gadget/agent-chat-connected.png');
  check('muse gadget: its screenshots are served', r.status === 200 && /image\/png/.test(r.headers.get('content-type') || ''), r.status + ' ' + r.headers.get('content-type'));
}

module.exports = { museHooks, museGadget, handover };
