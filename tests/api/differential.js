// The differential check: what every existing address answers, byte for
// byte, on this checkout and on an earlier one. It starts two local
// servers, each with its own checkout's tests/api/server.js (its ROOT is
// the checkout the file sits in), sends both the same fixed list of
// requests in the same order (the room's routes and MCP endpoint, the agent
// key's routes and address in each credential state, the page shell), and
// compares each answer's status, content type, headers (all but those that
// differ per connection) and body, with what differs per run masked:
// tokens and keys, timestamps (in milliseconds, and ISO times with
// milliseconds), signed query strings, upload links, the build id, and
// api_version (the API's version moves with every announced change).
// /api/changes is compared with the notices only this checkout has left
// out, /api and /llms.txt with this checkout's own edits taken out again,
// and the agent key's answers with this checkout's changed sentences, the
// disconnect's new fields and the agent catalog's version, digest and new
// tool taken out (ADDED_SECTIONS, CHANGED_SECTIONS, EXPECTED_DOC_EDITS,
// EXPECTED_SENTENCE_EDITS and agentMcpMasked below: a change that edits
// those on purpose lists its edits there); the app shell's
// Content-Security-Policy may differ only by CSP_ADDED, and a path this
// checkout adds (NEW_PATHS) must have been the other's unknown-path 404.
// Everything else must be identical.
//
//   node tests/api/differential.js /path/to/earlier-checkout
//
// The earlier checkout needs its node_modules (a link to this one's is
// fine) and a web build (web/app/dist, the same as this one's). Run it
// before a push that must leave existing answers alone. Nothing reaches
// anything outside this machine. Exits non-zero on any difference.
'use strict';
const path = require('path');
const { register } = require('node:module');
const { pathToFileURL } = require('node:url');

const OTHER = process.argv[2];
if (!OTHER) { console.error('usage: node tests/api/differential.js /path/to/earlier-checkout'); process.exit(2); }

/** The sections of /api this checkout adds, by heading: taken out whole
 *  (up to the next section's heading) before the compare. */
const ADDED_SECTIONS = [];
/** The sections of /api this checkout rewrites, by heading: taken out of
 *  both copies before the compare (AGENT KEYS gains the person's way and
 *  muse_register). */
const CHANGED_SECTIONS = ['AGENT KEYS (ONE MCP SERVER FOR ALL YOUR ROOMS)'];
/** The edits this checkout makes to /api and /llms.txt, taken out of its
 *  copy before the compare: [the text this checkout serves, the text the
 *  other serves], filled with the origin and the limits as served (fill). */
const EXPECTED_DOC_EDITS = [
  ['      VOICES), POST /api/agents and the /api/agent routes (AGENT KEYS), POST /api/agents/invite\n      and POST /api/agent/rooms/invite (a person inviting an agent onto a key with their own\n      invite), muse_register on the agent key\'s address, and POST .../leave and MCP leave_room\n      (LEAVING THE ROOM), which refuse an invite never opened and leave it unopened.', '      VOICES), POST /api/agents and the /api/agent routes (AGENT KEYS), and POST .../leave and MCP\n      leave_room (LEAVING THE ROOM), which refuse an invite never opened and leave it unopened.'],
  ['    not_person_invite\n                     403  an agent\'s invite offered as the inviter of an agent key\'s seat\n    seat_in_use      409  the agent seat of that name you invited is already in use: reuse "any"\n                          takes it (AGENT KEYS)\n', ''],
  ['                          time, or a room could not be reached to turn off the Muse wake your key\n                          set up there; wait the Retry-After seconds and send it again', '                          time; wait the Retry-After seconds and send it again'],
  ['                          using it is all it takes); the call did not open it. muse_register:\n                          a room you have not joined yet, skipped', '                          using it is all it takes); the call did not open it'],
  ['  agent key, call muse_register at {{origin}}/api/mcp instead (AGENT KEYS): it needs no room\n  token. With your room tokens:', '  agent key, keep your room tokens for this call:'],
  ['AGENT KEYS at {{origin}}/api. Your person can also make one for you on the site\'s home page.', 'AGENT KEYS at {{origin}}/api.'],
];
/** The sentences this checkout changes in the agent key's answers and
 *  instructions: [this checkout's, the other's], taken out of this
 *  checkout's copy (as written, and as a JSON string's body), filled as
 *  above. */
const EXPECTED_SENTENCE_EDITS = [
  ['Make one with POST /api/agents from your own agent invites, or ask your person to make one on the site\'s home page, under Agent keys (AGENT KEYS at /api).', 'Make one with POST /api/agents from your own agent invites (AGENT KEYS at /api).'],
  ['Tell your person; a new key can be made from your agent invites, or by your person on the site\'s home page.', 'Tell your person; a new key can be made from your agent invites.'],
  ['(the watcher\'s rooms.txt, a webhook; a Muse wake needs none: muse_register)', '(the watcher\'s rooms.txt, a webhook, POST /api/muse/hooks)'],
  ['This key works nowhere now, and the Muse wakes it set up are off. Every seat stays', 'This key works nowhere now. Every seat stays'],
  ['every tool but list_rooms, whats_waiting, add_room, remove_room and muse_register takes room', 'every tool but list_rooms, whats_waiting, add_room and remove_room takes room'],
  ['never join a room, nor do leave_room and muse_register;', 'never join a room, nor does leave_room;'],
  ['{{origin}}/api/agents, and a person can make one for it on the site\'s home page, under Agent keys (AGENT KEYS at {{origin}}/api).', '{{origin}}/api/agents (AGENT KEYS at {{origin}}/api).'],
  ['a new key can be made from your agent invites, or by your person on the site\'s home page (AGENT KEYS at {{origin}}/api).', 'a new key can be made from your agent invites (AGENT KEYS at {{origin}}/api).'],
  [' For a Muse wake, call muse_register at {{origin}}/api/mcp with your person\'s gadget code instead: it needs no token.', ''],
];
/** Response headers that differ per run or per connection, left out of the compare. */
const VOLATILE_HEADERS = new Set(['date', 'content-length', 'connection', 'keep-alive', 'transfer-encoding', 'cf-ray', 'server', 'report-to', 'nel', 'alt-svc']);
/** The answers whose Content-Security-Policy this checkout extends (the app
 *  shell, served by page()), and how. */
const CSP_CHANGED = new Set(['page /', 'page /r/ROOM']);
const CSP_ADDED = "; frame-ancestors 'self'";
/** Paths this checkout adds, which the other answered as an unknown path:
 *  sent to both, the other's answer checked to be that 404, not compared. */
const NEW_PATHS = new Set(['new POST /api/agents/invite', 'new POST /api/agent/rooms/invite']);

/** An answer of the agent key's address with the agent catalog's version
 *  and digest masked in both copies (they move with the new tool), and in
 *  this checkout's copy the new tool left out of tools/list. */
function agentMcpMasked(text, mine) {
  let j;
  try { j = JSON.parse(text); } catch { return text; /* not JSON: compared as it is */ }
  const r = j && j.result;
  if (r && typeof r === 'object') {
    if (r.catalog) r.catalog = { version: '<AGENT_CATALOG>', digest: '<AGENT_CATALOG>' };
    if (r.serverInfo && r.serverInfo.name === 'agent-chat-agent') r.serverInfo.version = '<AGENT_CATALOG>';
    const m = r._meta && r._meta['io.modelcontextprotocol/serverInfo'];
    if (m && m.name === 'agent-chat-agent') m.version = '<AGENT_CATALOG>';
    if (mine && Array.isArray(r.tools)) r.tools = r.tools.filter((t) => t.name !== 'muse_register');
  }
  return JSON.stringify(j);
}

/** One run of the fixed list against a server: each request's label and answer. */
async function scenario(base, owner, suf) {
  const out = [];
  const tokens = {};
  const send = async (label, method, p, o = {}) => {
    const headers = Object.assign({}, o.headers || {});
    if (o.owner) headers['X-Owner-Key'] = owner;
    if (o.token) headers['X-Invite-Token'] = o.token;
    let body = o.body;
    if (o.json !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(o.json); }
    const r = await fetch(base + p, { method, headers, body });
    const text = await r.text();
    const kept = {};
    for (const [k, v] of r.headers) if (!VOLATILE_HEADERS.has(k)) kept[k] = v;
    out.push({ label, status: r.status, type: r.headers.get('content-type') || '', text, headers: kept });
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON: text pages */ }
    return { status: r.status, json, text };
  };
  const room = 'difftest-' + suf, R = '/api/rooms/' + room;
  await send('create room', 'POST', R, { owner: true });
  const mk = async (name, kind) => { const r = await send('invite ' + name, 'POST', R + '/invites', { owner: true, json: { name, kind } }); tokens[name] = r.json.token; return r.json.token; };
  const ag = await mk('DiffAgent', 'agent'), fresh = await mk('DiffFresh', 'agent'), gone = await mk('DiffGone', 'agent'), per = await mk('DiffPerson', 'human'), leaver = await mk('DiffLeaver', 'agent');
  await send('revoke DiffGone', 'DELETE', R + '/invites/' + gone, { owner: true });
  // the start page and the looks, before and after joining
  await send('start page, unused', 'GET', R, { token: ag });
  await send('invite look', 'GET', R + '/invite', { token: ag });
  await send('me (joins)', 'GET', R + '/me', { token: ag });
  await send('start page, joined', 'GET', R, { token: ag });
  await send('me, person', 'GET', R + '/me', { token: per });
  await send('me, leaver', 'GET', R + '/me', { token: leaver });
  await send('post, person', 'POST', R + '/messages', { token: per, json: { text: 'Hello @DiffAgent https://example.org/page', client_msg_id: 'p1' } });
  await send('post, agent', 'POST', R + '/messages', { token: ag, json: { text: 'Hello back', client_msg_id: 'a1' } });
  await send('messages read', 'GET', R + '/messages', { token: ag });
  await send('members, agent', 'GET', R + '/members', { token: ag });
  await send('members, person', 'GET', R + '/members', { token: per });
  await send('members, owner', 'GET', R + '/members', { owner: true });
  await send('decision', 'POST', R + '/decisions', { token: per, json: { title: 'Book the hotel' } });
  // the per-room MCP endpoint: every kind of request, in each credential state
  const NEW = '2026-07-28', V = 'io.modelcontextprotocol/protocolVersion', C = 'io.modelcontextprotocol/clientCapabilities';
  const legacy = (method, params, id) => ({ jsonrpc: '2.0', id: id === undefined ? 1 : id, method, params: params || {} });
  const modern = (method, params, id) => ({ jsonrpc: '2.0', id: id === undefined ? 1 : id, method, params: Object.assign({}, params || {}, { _meta: { [V]: NEW, [C]: {} } }) });
  const mh = (method, name) => Object.assign({ 'MCP-Protocol-Version': NEW, 'Mcp-Method': method }, name === undefined ? {} : { 'Mcp-Name': name });
  const creds = [['no token', {}], ['an unused invite', { token: fresh }], ['an active invite', { token: ag }], ['a person', { token: per }], ['an unknown token', { token: 'not-one-of-this-rooms-xx' }], ['a revoked token', { token: gone }], ['the owner key', { owner: true }], ['the owner key and a token', { owner: true, token: fresh }], ['a token only in the URL', { query: '?invite=' + fresh }]];
  for (const [what, c] of creds) {
    const p = R + '/mcp' + (c.query || '');
    await send('mcp initialize, ' + what, 'POST', p, Object.assign({}, c, { json: legacy('initialize') }));
    await send('mcp initialize 2025-06-18, ' + what, 'POST', p, Object.assign({}, c, { json: legacy('initialize', { protocolVersion: '2025-06-18' }) }));
    await send('mcp ping, ' + what, 'POST', p, Object.assign({}, c, { json: legacy('ping') }));
    await send('mcp notification, ' + what, 'POST', p, Object.assign({}, c, { json: { jsonrpc: '2.0', method: 'notifications/initialized' } }));
    await send('mcp tools/list, ' + what, 'POST', p, Object.assign({}, c, { json: legacy('tools/list') }));
    await send('mcp server/discover, ' + what, 'POST', p, Object.assign({}, c, { json: modern('server/discover'), headers: mh('server/discover') }));
    await send('mcp tools/list 2026-07-28, ' + what, 'POST', p, Object.assign({}, c, { json: modern('tools/list'), headers: mh('tools/list') }));
    await send('mcp tools/call get_invite 2026-07-28, ' + what, 'POST', p, Object.assign({}, c, { json: modern('tools/call', { name: 'get_invite', arguments: {} }), headers: mh('tools/call', 'get_invite') }));
    await send('mcp unknown tool, ' + what, 'POST', p, Object.assign({}, c, { json: legacy('tools/call', { name: 'no_such_tool', arguments: {} }) }));
    await send('mcp a batch, ' + what, 'POST', p, Object.assign({}, c, { json: [legacy('ping', {}, 1), legacy('tools/list', {}, 2)] }));
  }
  await send('mcp GET', 'GET', R + '/mcp', { token: ag });
  await send('mcp not JSON', 'POST', R + '/mcp', { token: ag, body: '{nope', headers: { 'Content-Type': 'application/json' } });
  await send('mcp header mismatch', 'POST', R + '/mcp', { token: ag, json: modern('tools/list'), headers: { 'MCP-Protocol-Version': '2099-01-01', 'Mcp-Method': 'tools/list' } });
  await send('mcp unspoken revision', 'POST', R + '/mcp', { token: ag, json: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: { [V]: '2099-01-01', [C]: {} } } }, headers: { 'MCP-Protocol-Version': '2099-01-01', 'Mcp-Method': 'tools/list' } });
  // one tools/call per tool, as the active agent, in catalog order
  const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAwS2OUAAAAABJRU5ErkJggg==';
  const calls = [
    ['whoami', {}], ['get_invite', {}], ['get_start_page', {}], ['get_room_state', {}], ['list_messages', {}], ['list_attachments', {}],
    ['post_message', { text: 'through MCP', client_msg_id: 'm1' }], ['delete_message', { id: 999 }], ['publish_message', { id: 999 }],
    ['react', { id: 1, reaction: 'like' }], ['get_reactions', { id: 1 }], ['get_members', {}], ['get_board', {}], ['get_constitution', {}],
    ['set_constitution', { text: 'We plan the trip.' }], ['get_decisions', {}], ['create_decision', { title: 'Take the train' }],
    ['decision_action', { id: 1, action: 'sign' }], ['get_questions', {}], ['ask_question', { text: 'Which day?' }],
    ['question_action', { id: 1, action: 'claim' }], ['get_stakes', {}], ['create_stake', { title: 'Tickets', date: '2027-01-01' }],
    ['stake_action', { id: 1, action: 'done' }], ['get_digests', {}], ['file_digest', { text: 'Today the room planned a trip.' }],
    ['edit_digest', { id: 1, text: 'Today the room planned a trip, and more.' }], ['delete_digest', { id: 999 }],
    ['fetch_url', { url: 'http://127.0.0.1/' }], ['list_games', {}], ['get_game', { id: 999 }],
    ['create_game', { players: ['DiffAgent', 'DiffPerson'], game: 'duel' }], ['submit_move', { id: 1, dir: 'rock', turn: 1 }],
    ['cancel_game', { id: 999 }], ['accept_game', { id: 1 }], ['decline_game', { id: 999 }], ['speak_message', { id: 1 }],
    ['get_voice', {}], ['begin_upload', { kind: 'image' }], ['attach_media', { id: 1, kind: 'image', base64: PNG }],
    ['leave_room', { confirm: 'not-this-room' }],
  ];
  for (const [name, args] of calls) await send('mcp tools/call ' + name, 'POST', R + '/mcp', { token: ag, json: legacy('tools/call', { name, arguments: args }) });
  for (const [name, args] of calls.slice(0, 8)) await send('mcp tools/call 2026-07-28 ' + name, 'POST', R + '/mcp', { token: ag, json: modern('tools/call', { name, arguments: args }), headers: mh('tools/call', name) });
  await send('mcp tools/call leave_room, the leaver', 'POST', R + '/mcp', { token: leaver, json: legacy('tools/call', { name: 'leave_room', arguments: { confirm: room } }) });
  await send('mcp tools/call whoami, after the leave', 'POST', R + '/mcp', { token: leaver, json: legacy('tools/call', { name: 'whoami', arguments: {} }) });
  await send('messages read, after', 'GET', R + '/messages?limit=100', { token: ag });
  await send('start page, after', 'GET', R, { token: ag });
  // the page shell (its headers too) and pages served without it
  await send('page /', 'GET', '/');
  await send('page /r/ROOM', 'GET', '/r/' + room);
  await send('page /r/ROOM, no such room', 'GET', '/r/difftest-none-' + suf);
  await send('page /muse-terms', 'GET', '/muse-terms');
  // the agent key's routes and address, in each credential state
  const room2 = 'difftest2-' + suf, R2 = '/api/rooms/' + room2;
  await send('agent: create room 2', 'POST', R2, { owner: true });
  const k1 = (await send('agent: invite DiffKeyed', 'POST', R + '/invites', { owner: true, json: { name: 'DiffKeyed', kind: 'agent' } })).json.token;
  const k2 = (await send('agent: invite DiffKeyed 2', 'POST', R2 + '/invites', { owner: true, json: { name: 'DiffKeyed', kind: 'agent' } })).json.token;
  const k3 = (await send('agent: invite DiffKeyed2', 'POST', R2 + '/invites', { owner: true, json: { name: 'DiffKeyed2', kind: 'agent' } })).json.token;
  tokens.DiffKeyed = k1; tokens.DiffKeyed2room = k2; tokens.DiffKeyed2 = k3;
  const net = { 'CF-Connecting-IP': '10.99.0.1' };
  await send('agent POST /api/agents, refused (a person\'s invite)', 'POST', '/api/agents', { json: { rooms: [{ room, token: per }] }, headers: net });
  const made = await send('agent POST /api/agents', 'POST', '/api/agents', { json: { rooms: [{ room, token: k1 }] }, headers: net });
  const KEY = (made.json || {}).key || '';
  tokens.KEY = KEY;
  const kh = { Authorization: 'Bearer ' + KEY };
  await send('agent GET /api/agent', 'GET', '/api/agent', { headers: kh });
  await send('agent HEAD /api/agent', 'HEAD', '/api/agent', { headers: kh });
  await send('agent GET /api/agent, no key', 'GET', '/api/agent');
  await send('agent GET /api/agent, a room token', 'GET', '/api/agent', { headers: { Authorization: 'Bearer ' + k1 } });
  await send('agent GET /api/agent, a wrong key', 'GET', '/api/agent', { headers: { Authorization: 'Bearer .ac1.' + 'A'.repeat(22) + '.' + 'A'.repeat(43) } });
  await send('agent POST /api/agent/rooms', 'POST', '/api/agent/rooms', { headers: kh, json: { rooms: [{ room: room2, token: k2 }] } });
  await send('agent POST /api/agent/rooms, held', 'POST', '/api/agent/rooms', { headers: kh, json: { rooms: [{ room: room2, token: k2 }] } });
  const acreds = [['a key', kh], ['no key', {}], ['a room token', { Authorization: 'Bearer ' + k1 }], ['a wrong key', { Authorization: 'Bearer .ac1.' + 'B'.repeat(22) + '.' + 'B'.repeat(43) }]];
  for (const [what, h] of acreds) {
    await send('agent mcp initialize, ' + what, 'POST', '/api/mcp', { headers: h, json: legacy('initialize', { protocolVersion: '2025-06-18' }) });
    await send('agent mcp server/discover, ' + what, 'POST', '/api/mcp', { headers: Object.assign({}, h, mh('server/discover')), json: modern('server/discover') });
    await send('agent mcp tools/list, ' + what, 'POST', '/api/mcp', { headers: h, json: legacy('tools/list') });
    await send('agent mcp tools/list 2026-07-28, ' + what, 'POST', '/api/mcp', { headers: Object.assign({}, h, mh('tools/list')), json: modern('tools/list') });
    await send('agent mcp tools/call whoami, ' + what, 'POST', '/api/mcp', { headers: h, json: legacy('tools/call', { name: 'whoami', arguments: { room } }) });
  }
  for (const [name, args] of [['list_rooms', {}], ['get_start_page', { room }], ['get_invite', { room: room2 }], ['whats_waiting', {}], ['get_members', { room }], ['add_room', { room: room2, token: k3 }], ['remove_room', { room: room2 }], ['add_room', { room: room2, token: k3 }], ['post_message', { room, text: 'through the key', client_msg_id: 'k1' }], ['no_such_tool', { room }], ['whoami', { room: 'difftest-none-' + suf }]]) {
    await send('agent mcp tools/call ' + name + ' ' + JSON.stringify(args).replace(/"token":"[^"]+"/, '"token":"T"'), 'POST', '/api/mcp', { headers: kh, json: legacy('tools/call', { name, arguments: args }) });
  }
  await send('agent POST /api/agent/rooms/remove', 'POST', '/api/agent/rooms/remove', { headers: kh, json: { room: room2 } });
  await send('agent POST /api/agent/rooms/remove, not held', 'POST', '/api/agent/rooms/remove', { headers: kh, json: { room: room2 } });
  await send('new POST /api/agents/invite', 'POST', '/api/agents/invite', { json: { name: 'DiffNew', rooms: [{ room, inviter_token: per }], check: true }, headers: net });
  await send('new POST /api/agent/rooms/invite', 'POST', '/api/agent/rooms/invite', { headers: kh, json: { name: 'DiffNew', rooms: [{ room: room2, inviter_token: per }], check: true } });
  await send('agent DELETE /api/agent', 'DELETE', '/api/agent', { headers: kh });
  await send('agent GET /api/agent, disconnected', 'GET', '/api/agent', { headers: kh });
  await send('agent: delete invites 2', 'DELETE', R2 + '/invites', { owner: true });
  await send('agent: delete room 2', 'DELETE', R2 + '?confirm=' + room2, { owner: true });
  // the site's own pages
  await send('/api/changes', 'GET', '/api/changes');
  await send('/llms.txt', 'GET', '/llms.txt');
  await send('/api', 'GET', '/api');
  await send('/api/games', 'GET', '/api/games');
  await send('tools', 'GET', R + '/tools', { token: ag });
  await send('welcome', 'GET', R + '/welcome', { token: ag });
  await send('no such room', 'GET', '/api/rooms/difftest-none-' + suf + '/messages', { token: ag });
  await send('mcp, no such room', 'POST', '/api/rooms/difftest-none-' + suf + '/mcp', { token: ag, json: legacy('initialize') });
  await send('delete invites', 'DELETE', R + '/invites', { owner: true });
  await send('delete room', 'DELETE', R + '?confirm=' + room, { owner: true });
  return { out, tokens };
}

/** An answer's body with what differs per run masked. */
function masked(text, tokens) {
  let t = text;
  for (const [name, tok] of Object.entries(tokens)) if (tok) t = t.split(tok).join('<TOKEN:' + name + '>');
  return t
    .replace(/\b1\d{12}\b/g, '<TS>')
    .replace(/\b\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z\b/g, '<TIME>')
    .replace(/([?&](?:sig|s)=)[^&"\s\\]+/g, '$1<SIG>')
    .replace(/([?&](?:exp|e|v)=)\d+/g, '$1<N>')
    .replace(/(\/api\/uploads\/[^/"\s\\]+\/)[A-Za-z0-9_-]{16,}/g, '$1<TICKET>')
    .replace(/("build"\s*:\s*")[0-9a-f]+"/g, '$1<BUILD>"')
    .replace(/<meta name="build-id" content="[0-9a-f]+"/g, '<meta name="build-id" content="<BUILD>"')
    .replace(/("api_version"\s*:\s*")[^"]+"/g, '$1<API_VERSION>"')
    .replace(/(\\"api_version\\"\s*:\s*\\")[^"\\]+\\"/g, '$1<API_VERSION>\\"');
}

(async () => {
  // the limits the expected edits quote, from limits.ts (the unit tests' module hooks load it)
  register('../unit/txt-hooks.mjs', pathToFileURL(__filename));
  const LIM = await import('../../worker/limits.ts');
  const mine = require('./server.js');
  const theirs = require(path.resolve(OTHER, 'tests', 'api', 'server.js'));
  const a = await theirs.start();
  const b = await mine.start();
  let diffs = 0, compared = 0, cspChanged = 0;
  try {
    const suf = Date.now().toString(36);
    const ra = await scenario(a.base, a.owner, suf);
    const rb = await scenario(b.base, b.owner, suf);
    // the served origin, to fill the expected edits
    const origin = String((JSON.parse(rb.out.find((x) => x.label === '/api/changes').text).url || '')).replace(/\/api\/changes$/, '');
    const fill = (s) => s.replace(/\{\{origin\}\}/g, origin).replace(/\{\{MUSE_BATCH_MAX\}\}/g, String(LIM.MUSE_BATCH_MAX));
    if (ra.out.length !== rb.out.length) { console.log('FAIL the two runs sent different numbers of requests: ' + ra.out.length + ', ' + rb.out.length); process.exit(1); }
    for (let i = 0; i < ra.out.length; i++) {
      const x = ra.out[i], y = rb.out[i];
      let tx = masked(x.text, ra.tokens), ty = masked(y.text, rb.tokens);
      if (NEW_PATHS.has(y.label)) {
        // a path the other checkout did not serve: it answered the unknown path's 404
        compared++;
        if (x.status !== 404) { diffs++; console.log('FAIL ' + x.label + ': the earlier checkout answered ' + x.status + ', not the unknown path\'s 404'); }
        continue;
      }
      // a section runs to the next line that starts at the margin (its body is indented)
      const cut = (t, head) => {
        const at = t.indexOf('\n' + head + '\n');
        if (at < 0) return t;
        const next = t.slice(at + 1).search(/\n(?=[^ \n])/);
        return t.slice(0, at) + (next < 0 ? '' : t.slice(at + 1 + next));
      };
      if (y.label === '/api') {
        for (const head of ADDED_SECTIONS) ty = cut(ty, head);
        for (const head of CHANGED_SECTIONS) { ty = cut(ty, head); tx = cut(tx, head); }
        for (const [now, was] of EXPECTED_DOC_EDITS) { const n = fill(now); if (ty.includes(n)) ty = ty.replace(n, fill(was)); }
      }
      if (y.label.startsWith('agent ')) {
        for (const [now, was] of EXPECTED_SENTENCE_EDITS) {
          const n = fill(now), w = fill(was);
          ty = ty.split(n).join(w).split(JSON.stringify(n).slice(1, -1)).join(JSON.stringify(w).slice(1, -1));
        }
        // the disconnect's two new fields
        ty = ty.replace('"muse_wakes_removed":[],"muse_wakes_left":[],', '');
        if (y.label.startsWith('agent mcp')) { tx = agentMcpMasked(tx, false); ty = agentMcpMasked(ty, true); }
      }
      if (y.label === '/llms.txt') for (const [now, was] of EXPECTED_DOC_EDITS) { const n = fill(now); if (ty.includes(n)) ty = ty.replace(n, fill(was)); }
      if (y.label === '/api/changes') {
        // the notices only this checkout has, left out
        const jx = JSON.parse(tx), jy = JSON.parse(ty);
        const old = new Set(jx.notices.map((n) => n.id));
        const added = jy.notices.filter((n) => !old.has(n.id)).map((n) => n.id);
        jy.notices = jy.notices.filter((n) => old.has(n.id));
        console.log('note /api/changes: left out the notices only this checkout has: ' + added.join(', '));
        ty = JSON.stringify(jy);
        tx = JSON.stringify(jx);
      }
      compared++;
      // the headers too: every one but those that differ per run, and on the app shell its policy's one new directive
      const hx = Object.assign({}, x.headers), hy = Object.assign({}, y.headers);
      if (CSP_CHANGED.has(y.label)) {
        if (hy['content-security-policy'] !== (hx['content-security-policy'] || '') + CSP_ADDED) { diffs++; console.log('FAIL ' + y.label + ': Content-Security-Policy ' + JSON.stringify(hx['content-security-policy']) + ' / ' + JSON.stringify(hy['content-security-policy'])); }
        else cspChanged++;
        delete hx['content-security-policy'];
        delete hy['content-security-policy'];
      }
      const sortedJson = (o) => JSON.stringify(Object.keys(o).sort().map((k) => [k, o[k]]));
      if (sortedJson(hx) !== sortedJson(hy)) { diffs++; console.log('FAIL ' + y.label + ': headers ' + sortedJson(hx) + ' / ' + sortedJson(hy)); continue; }
      const same = x.status === y.status && x.type === y.type && tx === ty;
      if (!same) {
        diffs++;
        let k = 0;
        while (k < tx.length && tx[k] === ty[k]) k++;
        console.log('FAIL ' + x.label + ': ' + x.status + ' ' + x.type + ' / ' + y.status + ' ' + y.type + '\n  earlier: ...' + tx.slice(Math.max(0, k - 80), k + 160) + '\n  this:    ...' + ty.slice(Math.max(0, k - 80), k + 160));
      }
    }
  } finally {
    a.stop();
    b.stop();
  }
  if (cspChanged !== CSP_CHANGED.size) { diffs++; console.log('FAIL the app shell\'s policy was checked on ' + cspChanged + ' answers, not ' + CSP_CHANGED.size); }
  console.log(diffs ? 'DIFFERENTIAL: ' + diffs + ' of ' + compared + ' answers differ' : 'DIFFERENTIAL: all ' + compared + ' answers identical, headers included (masked as above; the app shell\'s policy gained only "' + CSP_ADDED.slice(2) + '" on ' + cspChanged + ' answers)');
  process.exit(diffs ? 1 : 0);
})().catch((e) => { console.error('differential crashed: ' + ((e && e.stack) || e)); process.exit(1); });
