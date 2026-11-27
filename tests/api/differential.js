// The differential check: what every existing address answers, byte for
// byte, on this checkout and on an earlier one. It starts two local
// servers, each with its own checkout's tests/api/server.js (its ROOT is
// the checkout the file sits in), sends both the same fixed list of
// requests in the same order, and compares each answer's status, content
// type and body, with what differs per run masked: tokens, timestamps (in
// milliseconds, and ISO times with milliseconds),
// signed query strings, upload links, the build id, and api_version (the
// API's version moves with every announced change). /api/changes is
// compared with the notices only this checkout has left out, and /api and
// /llms.txt with this checkout's own edits taken out again
// (ADDED_SECTIONS and EXPECTED_DOC_EDITS below: a change that edits those
// texts on purpose lists its edits there). Every other body must be
// identical.
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
const ADDED_SECTIONS = ['AGENT KEYS (ONE MCP SERVER FOR ALL YOUR ROOMS)'];
/** The edits this checkout makes to /api and /llms.txt, taken out of its
 *  copy before the compare: [the text this checkout serves, the text the
 *  other serves], filled with the origin and the limits as served (fill). */
const EXPECTED_DOC_EDITS = [
  ['      get_start_page; and on the agent key\'s address (AGENT KEYS) initialize, server/discover,\n      ping, notifications, tools/list, list_rooms, whats_waiting, add_room, remove_room,\n      get_invite and get_start_page; the public pages (/llms.txt, /api, /api/games,\n      /api/changes) and the room page\'s HTML (/r/ROOM fetched as a page; the web app it starts in\n      a browser joins once it reads the room).', '      get_start_page; the public pages (/llms.txt, /api, /api/games, /api/changes) and the room\n      page\'s HTML (/r/ROOM fetched as a page; the web app it starts in a browser joins once it\n      reads the room).'],
  ['      VOICES), POST /api/agents and the /api/agent routes (AGENT KEYS), and POST .../leave and MCP\n      leave_room (LEAVING THE ROOM), which refuse an invite never opened and leave it unopened.', '      VOICES), and POST .../leave and MCP leave_room (LEAVING THE ROOM), which refuse an invite\n      never opened and leave it unopened.'],
  ['    Join: every other room call with your token, every other MCP tool call, and every other tool\n      call through an agent key, in the room it names. Most routes check the token before the\n      method or the arguments, so a call they then refuse has joined.', '    Join: every other room call with your token, and every other MCP tool call. Most routes\n      check the token before the method or the arguments, so a call they then refuse has joined.'],
  ['    agent_key_missing\n                     401  an agent key route or address without a key (AGENT KEYS)\n    agent_key_invalid\n                     403  not a current agent key: mistyped or disconnected\n    not_agent_key    403  a room invite token where an agent key goes\n    not_agent_invite 403  a person\'s invite offered to an agent key\n    room_not_held    404  a room that is not on your agent key\n    room_held        409  a room already on your agent key\n    agent_unreadable 500  your agent key\'s record could not be read; the key was not refused\n                          (over MCP, JSON-RPC error -32603): tell your person\n    try_again        503  your agent key\'s list was being changed by another call at the same\n                          time; wait the Retry-After seconds and send it again\n', ''],
  ['  error with structuredContent {"code"}; a room\'s refusal through an agent key is the tool\'s\n  error with structuredContent {"code", "room"}; post_message\'s two client_msg_id refusals come\n  as their sentence only.', '  error with structuredContent {"code"}; post_message\'s two client_msg_id refusals come as\n  their sentence only.'],
  ['  only that person; everyone else keeps access. An agent key may hold your invite (AGENT KEYS):\n  a revoke, or your leave, ends it there too, at once. Leaving the room (LEAVING THE ROOM)\n  revokes your own invite the same way, and does more.', '  only that person; everyone else keeps access. Leaving the room (LEAVING THE ROOM) revokes your\n  own invite the same way, and does more.'],
  ['  rooms as you like in one call (up to {{MUSE_BATCH_MAX}}); this call keeps no token, each is\n  checked by its own room (an agent key keeps its rooms\' tokens, sealed: AGENT KEYS). With an\n  agent key, keep your room tokens for this call:', '  rooms as you like in one call (up to {{MUSE_BATCH_MAX}}); no token is kept by anything but its\n  own room:'],
  ['        {{origin}}/api/rooms/ROOM/mcp --header "Authorization: Bearer TOKEN"\n    One server for all your rooms: AGENT KEYS.\n', '        {{origin}}/api/rooms/ROOM/mcp --header "Authorization: Bearer TOKEN"\n'],
  ['Neither step joins the room.\n\nInvited to several rooms? An agent key puts them all on one MCP server: AGENT KEYS at {{origin}}/api.\n', 'Neither step joins the room.\n'],
];

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
    out.push({ label, status: r.status, type: r.headers.get('content-type') || '', text });
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
  let diffs = 0, compared = 0;
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
      if (y.label === '/api') {
        // a section runs to the next line that starts at the margin (its body is indented)
        for (const head of ADDED_SECTIONS) {
          const at = ty.indexOf('\n' + head + '\n');
          if (at < 0) continue;
          const next = ty.slice(at + 1).search(/\n(?=[^ \n])/);
          ty = ty.slice(0, at) + (next < 0 ? '' : ty.slice(at + 1 + next));
        }
        for (const [now, was] of EXPECTED_DOC_EDITS) { const n = fill(now); if (ty.includes(n)) ty = ty.replace(n, fill(was)); }
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
  console.log(diffs ? 'DIFFERENTIAL: ' + diffs + ' of ' + compared + ' answers differ' : 'DIFFERENTIAL: all ' + compared + ' answers identical (masked as above)');
  process.exit(diffs ? 1 : 0);
})().catch((e) => { console.error('differential crashed: ' + ((e && e.stack) || e)); process.exit(1); });
