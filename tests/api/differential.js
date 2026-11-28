// The differential check: what every existing address answers, byte for
// byte, on this checkout and on an earlier one. It starts two local
// servers, each with its own checkout's tests/api/server.js (its ROOT is
// the checkout the file sits in), and one fake Muse both bridges call,
// sends both the same fixed list of requests in the same order (the room's
// routes and MCP endpoint, a Muse registration with room tokens, the agent
// key's routes and address in each credential state, their refusals, a
// room that refused the key's invite, a leave through the key and the
// disconnect after it, the page shell),
// checks on both sides that each set-up call did what the list assumes (a
// room made, an invite made, a key made, a gadget linked), so two
// identical refusals cannot pass for a match, and
// compares each answer's status, content type, headers (all but those that
// differ per connection) and body, with what differs per run masked:
// tokens and keys, each server's own address (the sign-in's issuer on a
// test server), timestamps (in milliseconds, and ISO times with
// milliseconds), signed query strings, upload links, the build id, and
// api_version (the API's version moves with every announced change).
// /api/changes is compared with the notices only this checkout has left
// out, /api and /llms.txt with this checkout's own edits taken out again,
// and the agent key's answers with this checkout's changed sentences taken
// out (ADDED_SECTIONS, CHANGED_SECTIONS, EXPECTED_DOC_EDITS and
// EXPECTED_SENTENCE_EDITS below: a change that edits those on purpose lists
// its edits there, each against the checkout it is compared with), a page
// this checkout's markup changes with its edits taken out (PAGE_EDITS), and the
// retry time of a counter's window, which moves with the run, masked on the
// answers that carry one (MOVING_RETRY); a note names each part left out
// wherever the two copies differ there; the app shell's
// Content-Security-Policy may differ only by CSP_ADDED on the answers
// CSP_CHANGED names, a path this checkout adds (NEW_PATHS) must have been
// the other's unknown-path 404, and a preflight this checkout answers with
// its own CORS (PREFLIGHT_CHANGED) the other's generic one. The MCP skills'
// methods (worker/agents/skills.ts) are sent to both, at a room's address
// and the agent key's, for every file this checkout serves: against a
// checkout that serves none (NEW_METHODS) the other's answer must be the
// unknown method's 404; otherwise they are compared, but for a skill whose
// version moved. server/discover's capabilities may differ only by
// EXPECTED_ANSWER_EDITS. After the compare, two rules about the skills
// across the two checkouts: the versions rule (versions.json only grows, and
// a skill's bytes and its version move together) and the facts rule (a fact
// whose text stays while its anchors or sources change is listed, and passes
// only when ANCHOR_ONLY_FACTS names it with those new anchors: a person's
// record of having read them against the fact, which nothing checks; a fact
// whose text and anchors stay while a sentence they sit in is served
// otherwise passes only when FACT_SENTENCES_READ names it with that sentence;
// facts are matched by their text when renamed; and a fact verbatim there
// and a paraphrase here with the same text fails).
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
 *  (up to the next section's heading) before the compare. Against 1f2b85b:
 *  the skills' section. */
const ADDED_SECTIONS = ['SKILLS (OVER MCP)'];
/** The sections of /api this checkout rewrites, by heading: taken out of
 *  both copies before the compare. */
const CHANGED_SECTIONS = [];
/** The edits this checkout makes to /api and /llms.txt, taken out of its
 *  copy before the compare: [the text this checkout serves, the text the
 *  other serves], filled with the origin and the limits as served (fill).
 *  Against 1f2b85b: the skills' methods in START HERE and ROOM TOOLS, and
 *  GAMES - EVERY MATCH's sentence on what create_game and submit_move take
 *  over MCP (docs.txt). */
const EXPECTED_DOC_EDITS = [
  ["      initialize, server/discover, ping, notifications, tools/list, the skills' methods\n      (SKILLS), get_invite and get_start_page; and on the agent key's address (AGENT KEYS)\n      initialize, server/discover, ping, notifications, tools/list, the skills' methods,\n      list_rooms, whats_waiting, add_room, remove_room,\n",
    "      initialize, server/discover, ping, notifications, tools/list, get_invite and\n      get_start_page; and on the agent key's address (AGENT KEYS) initialize, server/discover,\n      ping, notifications, tools/list, list_rooms, whats_waiting, add_room, remove_room,\n"],
  ["      Mcp-Name, resources/read its uri). server/discover answers anyone, as initialize does;\n      tools/list, tools/call and the skills' methods (SKILLS) need your token. A request that\n      breaks those rules gets the protocol's own error: HTTP\n",
    "      Mcp-Name). server/discover answers anyone, as initialize does; tools/list and tools/call\n      need your token. A request that breaks those rules gets the protocol's own error: HTTP\n"],
  ["  Over MCP, create_game takes the fields of the POST /games body as its arguments, and submit_move\n  the fields of the moves body.\n", ""],
];
/** The sentences this checkout changes in the agent key's answers and
 *  instructions: [this checkout's, the other's], taken out of this
 *  checkout's copy (as written, and as a JSON string's body), filled as
 *  above. Against 1f2b85b: the start page's one line through a key
 *  (worker/agents/start.ts), which now also says what stops a wake there,
 *  what step 3's Checks and Stops are, and how a refusal comes back. */
const EXPECTED_SENTENCE_EDITS = [
  [" it needs no token. The Checks and Stops of step 3, which step 7 points to, are among those REST calls: list_rooms shows \"muse_wake\": true for a room where your key's record holds a link to your person's Muse, and remove_room takes a room off your key and first lets go of the Muse wake it set up there, without leaving the room. Done with the room? Stop reading and take it off your key with remove_room: you stay a member. A room's refusal of your seat is the tool's error with structuredContent {\"code\", \"room\"}; a refused key is error -32001 with its code in data, and connecting succeeds even with a wrong key.",
    " it needs no token."],
];
/** The pages whose markup this checkout changes, by label: [this
 *  checkout's, the other's], each taken out of this checkout's copy before
 *  the compare, the words and headers compared as they are. Against
 *  1f2b85b: none. */
const PAGE_EDITS = {};
/** The parts this checkout changes in existing answers: [this checkout's,
 *  the other's], taken out of this checkout's copy of every answer whose
 *  label holds server/discover. Against 1f2b85b: server/discover declares
 *  the resources capability and the skills extension. */
const EXPECTED_ANSWER_EDITS = [['"capabilities":{"tools":{},"resources":{},"extensions":{"io.modelcontextprotocol/skills":{}}}', '"capabilities":{"tools":{}}']];
/** The MCP methods this checkout adds over 2026-07-28, which the other did
 *  not serve: each request of these (tagged where it is sent) is sent to
 *  both, the other's answer checked to be 404 -32601 "Method not found: M",
 *  and this one's not compared (the suites check it). Against a checkout
 *  that serves the skills: empty. Against 1f2b85b: the skills' five. */
const NEW_METHODS = new Set(['skills/list', 'skills/get', 'resources/list', 'resources/templates/list', 'resources/read']);
/** The facts whose anchors (or verbatim sources) this checkout changes while
 *  their text stays: [id, the anchors (or sources) exactly as this checkout's
 *  facts.ts holds them], each put here by the person who has read those new
 *  anchors against the fact. The facts rule prints every such fact and fails
 *  for one not here, or here with other anchors, and for an entry it did not
 *  print. Against 1f2b85b, which has no facts.ts: none. */
const ANCHOR_ONLY_FACTS = [];
/** The facts whose served sentence this checkout changes while the fact,
 *  its text and its anchors stay: [id, source, the sentence as this checkout
 *  serves it], each put here by the person who has read that sentence
 *  against the fact. A change to a clause of a sentence that no anchor holds
 *  shows here and nowhere else. The facts rule prints every such sentence
 *  (as both checkouts serve it) and fails for one not here, or here with
 *  another sentence, and for an entry it did not print. Against 1f2b85b,
 *  which has no facts.ts: none. */
const FACT_SENTENCES_READ = [];
/** The answers whose retry time is the seconds left in a counter's window,
 *  which moves with the run (the two servers are asked a while apart): that
 *  number masked in both copies, the Retry-After header and the body's
 *  retry_after, and nothing else of the answer. */
const MOVING_RETRY = new Set(['agent POST /api/agents, over the per-network cap']);
/** The limits (worker/limits.ts), loaded before the runs. */
let LIM;
/** The skills' requests both servers are sent, at a room's address and the
 *  key's: [label, method, params, Mcp-Name], every file of this checkout's
 *  SERVED_SKILLS (worker/agents/skills/served/index.ts), loaded before the
 *  runs, so both receive the same list. */
let SKILL_REQUESTS = [];
/** Response headers that differ per run or per connection, left out of the compare. */
const VOLATILE_HEADERS = new Set(['date', 'content-length', 'connection', 'keep-alive', 'transfer-encoding', 'cf-ray', 'server', 'report-to', 'nel', 'alt-svc']);
/** The answers whose Content-Security-Policy this checkout extends (the app
 *  shell, served by page()), and how: none against a checkout whose policy
 *  has it already. */
const CSP_CHANGED = new Set();
const CSP_ADDED = "; frame-ancestors 'self'";
/** The sign-in's paths, each sent to both with no query and no body: its
 *  documents, its authorize page, its endpoints and its MCP address
 *  (worker/routes/oauth.ts, agent.ts). */
const SIGNIN_PATHS = [
  'GET /.well-known/oauth-protected-resource', 'GET /.well-known/oauth-protected-resource/api/mcp/signin', 'GET /.well-known/oauth-protected-resource/api/mcp',
  'GET /.well-known/oauth-authorization-server', 'GET /oauth/authorize', 'POST /api/mcp/signin', 'POST /api/mcp/signin/',
  'POST /api/oauth/decide', 'POST /api/oauth/token', 'POST /api/oauth/revoke', 'POST /api/oauth/disconnect',
];
/** Paths this checkout adds, which the other answered as an unknown path:
 *  sent to both, the other's answer checked to be that 404, not compared.
 *  Against fc84da6: none (its sign-in paths are compared). */
const NEW_PATHS = new Set([]);
/** The preflights this checkout answers with their own CORS, which the
 *  other answered as every path's: sent to both, the other's answer checked
 *  to be the generic preflight (PREFLIGHT_GENERIC's), not compared. Against
 *  fc84da6: none (the sign-in's own preflights are compared). */
const PREFLIGHT_CHANGED = new Set([]);
/** A preflight every path answers alike, compared, and the earlier
 *  checkout's answer PREFLIGHT_CHANGED is held to. */
const PREFLIGHT_GENERIC = 'OPTIONS /api/mcp';

/** One run of the fixed list against a server: each request's label and
 *  answer, and the set-up calls that did not do what the list assumes. */
async function scenario(srv, muse, suf) {
  const base = srv.base, owner = srv.owner;
  const out = [];
  // the server's own address, masked as a token: on a test server the sign-in names it as its issuer
  // (TEST_SIGNIN_ORIGIN), in its documents and its challenge, and each server has a port of its own
  const tokens = { serverOrigin: base };
  const setup = [];
  /** a set-up call must have done what the rest of the list assumes */
  const must = (label, ok) => { if (!ok) setup.push(label); };
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
    out.push({ label, status: r.status, type: r.headers.get('content-type') || '', text, headers: kept, skills: o.skills });
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON: text pages */ }
    return { status: r.status, json, text };
  };
  const room = 'difftest-' + suf, R = '/api/rooms/' + room;
  must('create room', (await send('create room', 'POST', R, { owner: true })).status === 201);
  const mk = async (name, kind) => { const r = await send('invite ' + name, 'POST', R + '/invites', { owner: true, json: { name, kind } }); must('invite ' + name, r.status === 201 && !!(r.json && r.json.token)); tokens[name] = r.json.token; return r.json.token; };
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
  // a Muse registration with room tokens (POST /api/muse/hooks, its claim in museClaim): a gadget linked on the fake Muse
  const { museGadget, handover } = require('./muse-hooks.js');
  const gadget = await museGadget({ muse, SUF: suf + '-' + srv.port, sealPublicKey: srv.sealPublicKey }, handover((method, p, o) => send('muse ' + p, method, p, o), '198.51.100.9'), 'diff');
  must('muse: a gadget linked', gadget.status === 200 && !!gadget.code && !!gadget.link);
  tokens.museCode = gadget.code; tokens.museLink = gadget.link;
  await send('muse hooks, a revoked token only (code not used)', 'POST', '/api/muse/hooks', { json: { code: gadget.code, rooms: [{ room, token: gone }] } });
  const reg = await send('muse hooks, the active agent', 'POST', '/api/muse/hooks', { json: { code: gadget.code, routing: 'main', rooms: [{ room, token: ag }, { room, token: gone }] } });
  must('muse: registered', reg.status === 200 && !!reg.json && reg.json.claimed === true);
  await send('muse hooks, the code again', 'POST', '/api/muse/hooks', { json: { code: gadget.code, rooms: [{ room, token: ag }] } });
  await send('muse hooks, a made-up code', 'POST', '/api/muse/hooks', { json: { code: 'not-a-code-of-any-gadget', rooms: [{ room, token: ag }] } });
  await send('muse hook, the agent\'s own view', 'GET', R + '/muse-hook', { token: ag });
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
    // the skills' methods over the initialize kind: answered as they always were
    await send('mcp resources/list, ' + what, 'POST', p, Object.assign({}, c, { json: legacy('resources/list') }));
    await send('mcp skills/list, ' + what, 'POST', p, Object.assign({}, c, { json: legacy('skills/list') }));
  }
  await send('mcp GET', 'GET', R + '/mcp', { token: ag });
  await send('mcp not JSON', 'POST', R + '/mcp', { token: ag, body: '{nope', headers: { 'Content-Type': 'application/json' } });
  await send('mcp header mismatch', 'POST', R + '/mcp', { token: ag, json: modern('tools/list'), headers: { 'MCP-Protocol-Version': '2099-01-01', 'Mcp-Method': 'tools/list' } });
  await send('mcp unspoken revision', 'POST', R + '/mcp', { token: ag, json: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: { [V]: '2099-01-01', [C]: {} } } }, headers: { 'MCP-Protocol-Version': '2099-01-01', 'Mcp-Method': 'tools/list' } });
  // the skills' methods over 2026-07-28 with the active invite, every file this checkout serves
  const skillCalls = async (prefix, p, o) => {
    for (const [label, method, params, name] of SKILL_REQUESTS) await send(prefix + label, 'POST', p, Object.assign({}, o, { json: modern(method, params), headers: Object.assign({}, o.headers || {}, mh(method, name)), skills: { method, uri: params.uri } }));
  };
  await skillCalls('mcp skills ', R + '/mcp', { token: ag });
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
  must('agent: create room 2', (await send('agent: create room 2', 'POST', R2, { owner: true })).status === 201);
  const k1 = (await send('agent: invite DiffKeyed', 'POST', R + '/invites', { owner: true, json: { name: 'DiffKeyed', kind: 'agent' } })).json.token;
  const k2 = (await send('agent: invite DiffKeyed 2', 'POST', R2 + '/invites', { owner: true, json: { name: 'DiffKeyed', kind: 'agent' } })).json.token;
  const k3 = (await send('agent: invite DiffKeyed2', 'POST', R2 + '/invites', { owner: true, json: { name: 'DiffKeyed2', kind: 'agent' } })).json.token;
  must('agent: three agent invites', !!k1 && !!k2 && !!k3);
  tokens.DiffKeyed = k1; tokens.DiffKeyed2room = k2; tokens.DiffKeyed2 = k3;
  const net = { 'CF-Connecting-IP': '10.99.0.1' };
  await send('agent POST /api/agents, refused (a person\'s invite)', 'POST', '/api/agents', { json: { rooms: [{ room, token: per }] }, headers: net });
  const made = await send('agent POST /api/agents', 'POST', '/api/agents', { json: { rooms: [{ room, token: k1 }] }, headers: net });
  const KEY = (made.json || {}).key || '';
  must('agent: a key made', made.status === 201 && /^\.ac1\./.test(KEY));
  tokens.KEY = KEY;
  const kh = { Authorization: 'Bearer ' + KEY };
  await send('agent GET /api/agent', 'GET', '/api/agent', { headers: kh });
  await send('agent HEAD /api/agent', 'HEAD', '/api/agent', { headers: kh });
  await send('agent GET /api/agent, no key', 'GET', '/api/agent');
  await send('agent GET /api/agent, a room token', 'GET', '/api/agent', { headers: { Authorization: 'Bearer ' + k1 } });
  await send('agent GET /api/agent, a wrong key', 'GET', '/api/agent', { headers: { Authorization: 'Bearer .ac1.' + 'A'.repeat(22) + '.' + 'A'.repeat(43) } });
  must('agent: a room added', (await send('agent POST /api/agent/rooms', 'POST', '/api/agent/rooms', { headers: kh, json: { rooms: [{ room: room2, token: k2 }] } })).status === 201);
  await send('agent POST /api/agent/rooms, held', 'POST', '/api/agent/rooms', { headers: kh, json: { rooms: [{ room: room2, token: k2 }] } });
  const acreds = [['a key', kh], ['no key', {}], ['a room token', { Authorization: 'Bearer ' + k1 }], ['a wrong key', { Authorization: 'Bearer .ac1.' + 'B'.repeat(22) + '.' + 'B'.repeat(43) }]];
  for (const [what, h] of acreds) {
    await send('agent mcp initialize, ' + what, 'POST', '/api/mcp', { headers: h, json: legacy('initialize', { protocolVersion: '2025-06-18' }) });
    await send('agent mcp server/discover, ' + what, 'POST', '/api/mcp', { headers: Object.assign({}, h, mh('server/discover')), json: modern('server/discover') });
    await send('agent mcp tools/list, ' + what, 'POST', '/api/mcp', { headers: h, json: legacy('tools/list') });
    await send('agent mcp tools/list 2026-07-28, ' + what, 'POST', '/api/mcp', { headers: Object.assign({}, h, mh('tools/list')), json: modern('tools/list') });
    await send('agent mcp tools/call whoami, ' + what, 'POST', '/api/mcp', { headers: h, json: legacy('tools/call', { name: 'whoami', arguments: { room } }) });
  }
  // the skills' methods over 2026-07-28 with the current key, every file this checkout serves
  await skillCalls('agent mcp skills ', '/api/mcp', { headers: kh });
  for (const [name, args] of [['list_rooms', {}], ['get_start_page', { room }], ['get_invite', { room: room2 }], ['whats_waiting', {}], ['get_members', { room }], ['add_room', { room: room2, token: k3 }], ['remove_room', { room: room2 }], ['add_room', { room: room2, token: k3 }], ['post_message', { room, text: 'through the key', client_msg_id: 'k1' }], ['no_such_tool', { room }], ['whoami', { room: 'difftest-none-' + suf }]]) {
    await send('agent mcp tools/call ' + name + ' ' + JSON.stringify(args).replace(/"token":"[^"]+"/, '"token":"T"'), 'POST', '/api/mcp', { headers: kh, json: legacy('tools/call', { name, arguments: args }) });
  }
  // a Muse wake set up through the key (a second gadget's code) in the room its seat joined: the set, its own write and its tidy;
  // the leave through the key and the disconnect further down settle it
  const gadget2 = await museGadget({ muse, SUF: suf + '-' + srv.port + '-k', sealPublicKey: srv.sealPublicKey }, handover((method, p, o) => send('agent: muse ' + p, method, p, o), '198.51.100.10'), 'diffkey');
  must('agent: a second gadget linked', gadget2.status === 200 && !!gadget2.code && !!gadget2.link);
  tokens.museCode2 = gadget2.code; tokens.museLink2 = gadget2.link;
  const reg2 = await send('agent mcp tools/call muse_register', 'POST', '/api/mcp', { headers: kh, json: legacy('tools/call', { name: 'muse_register', arguments: { code: gadget2.code, rooms: [room] } }) });
  must('agent: muse_register set the wake', !!reg2.json && !!reg2.json.result && !reg2.json.result.isError && reg2.json.result.structuredContent.results[0].ok === true);
  await send('agent GET /api/agent, a Muse wake', 'GET', '/api/agent', { headers: kh });
  await send('agent POST /api/agent/rooms/remove', 'POST', '/api/agent/rooms/remove', { headers: kh, json: { room: room2 } });
  await send('agent POST /api/agent/rooms/remove, not held', 'POST', '/api/agent/rooms/remove', { headers: kh, json: { room: room2 } });
  // set-up calls of the test hooks, not compared (each server answers its own)
  const hook = async (label, json) => {
    const r = await fetch(base + '/api/test-hooks/agent-limits', { method: 'POST', headers: { 'X-Owner-Key': owner, 'Content-Type': 'application/json' }, body: JSON.stringify(json) });
    must(label, r.status === 200);
    await r.text();
  };
  // POST /api/agents refused beyond a person's invite: the shapes, the size, the method, the per-network cap
  await send('agent POST /api/agents, rooms not a list', 'POST', '/api/agents', { json: { rooms: 'x' }, headers: net });
  await send('agent POST /api/agents, no rooms', 'POST', '/api/agents', { json: { rooms: [] }, headers: net });
  await send('agent POST /api/agents, a bad room name', 'POST', '/api/agents', { json: { rooms: [{ room: 'Not A Room', token: 'x' }] }, headers: net });
  await send('agent POST /api/agents, no token', 'POST', '/api/agents', { json: { rooms: [{ room }] }, headers: net });
  await send('agent POST /api/agents, a room twice', 'POST', '/api/agents', { json: { rooms: [{ room, token: k1 }, { room, token: k1 }] }, headers: net });
  await send('agent POST /api/agents, a token the room never had', 'POST', '/api/agents', { json: { rooms: [{ room, token: 'not-one-of-this-rooms-xx' }] }, headers: net });
  await send('agent POST /api/agents, a revoked token', 'POST', '/api/agents', { json: { rooms: [{ room, token: gone }] }, headers: net });
  await send('agent POST /api/agents, no such room', 'POST', '/api/agents', { json: { rooms: [{ room: 'difftest-none-' + suf, token: k1 }] }, headers: net });
  await send('agent POST /api/agents, not JSON', 'POST', '/api/agents', { body: '{nope', headers: Object.assign({ 'Content-Type': 'application/json' }, net) });
  await send('agent POST /api/agents, too large', 'POST', '/api/agents', { body: '{"rooms":"' + 'x'.repeat(LIM.SMALL_BODY_MAX) + '"}', headers: Object.assign({ 'Content-Type': 'application/json' }, net) });
  await send('agent GET /api/agents', 'GET', '/api/agents');
  await hook('agent: one key per network (test hook)', { per_ip: 1 });
  const net2 = { 'CF-Connecting-IP': '10.99.0.2' };
  const made2 = await send('agent POST /api/agents, another network', 'POST', '/api/agents', { json: { rooms: [{ room, token: k1 }] }, headers: net2 });
  must('agent: a second key made', made2.status === 201 && !!made2.json && /^\.ac1\./.test(made2.json.key || ''));
  tokens.KEY2 = (made2.json || {}).key || '';
  await send('agent POST /api/agents, over the per-network cap', 'POST', '/api/agents', { json: { rooms: [{ room, token: k1 }] }, headers: net2 });
  await hook('agent: caps as they were (test hook)', { clear: true });
  // adding refused beyond a room already held: the shapes, the size, the method, no key, tokens the room refuses
  const p2 = (await send('agent: invite DiffPerson2', 'POST', R2 + '/invites', { owner: true, json: { name: 'DiffPerson2', kind: 'human' } })).json.token;
  const g2 = (await send('agent: invite DiffGone2', 'POST', R2 + '/invites', { owner: true, json: { name: 'DiffGone2', kind: 'agent' } })).json.token;
  must('agent: two more invites', !!p2 && !!g2);
  tokens.DiffPerson2 = p2; tokens.DiffGone2 = g2;
  await send('agent: revoke DiffGone2', 'DELETE', R2 + '/invites/' + g2, { owner: true });
  for (const [what, body] of [['a person\'s invite', { rooms: [{ room: room2, token: p2 }] }], ['a revoked token', { rooms: [{ room: room2, token: g2 }] }], ['a token the room never had', { rooms: [{ room: room2, token: 'not-one-of-this-rooms-xx' }] }], ['no such room', { rooms: [{ room: 'difftest-none-' + suf, token: k3 }] }], ['no rooms', { rooms: [] }], ['a bad room name', { rooms: [{ room: 'Not A Room', token: 'x' }] }], ['no token', { rooms: [{ room: room2 }] }], ['a room twice', { rooms: [{ room: room2, token: k3 }, { room: room2, token: k3 }] }]]) {
    await send('agent POST /api/agent/rooms, ' + what, 'POST', '/api/agent/rooms', { headers: kh, json: body });
  }
  await send('agent POST /api/agent/rooms, not JSON', 'POST', '/api/agent/rooms', { body: '{nope', headers: Object.assign({ 'Content-Type': 'application/json' }, kh) });
  await send('agent POST /api/agent/rooms, too large', 'POST', '/api/agent/rooms', { body: '{"rooms":"' + 'x'.repeat(LIM.SMALL_BODY_MAX) + '"}', headers: Object.assign({ 'Content-Type': 'application/json' }, kh) });
  await send('agent GET /api/agent/rooms', 'GET', '/api/agent/rooms', { headers: kh });
  await send('agent POST /api/agent/rooms, no key', 'POST', '/api/agent/rooms', { json: { rooms: [{ room: room2, token: k3 }] } });
  for (const [what, args] of [['no token', { room: room2 }], ['a person\'s invite', { room: room2, token: p2 }], ['a revoked token', { room: room2, token: g2 }], ['a bad room name', { room: 'Not A Room', token: k3 }]]) {
    await send('agent mcp tools/call add_room, ' + what, 'POST', '/api/mcp', { headers: kh, json: legacy('tools/call', { name: 'add_room', arguments: args }) });
  }
  // a room that refuses the key's invite: marked, listed, glanced at, taken off
  must('agent: room 2 on the key again', (await send('agent POST /api/agent/rooms, room 2 again', 'POST', '/api/agent/rooms', { headers: kh, json: { rooms: [{ room: room2, token: k3 }] } })).status === 201);
  await send('agent: revoke DiffKeyed2', 'DELETE', R2 + '/invites/' + k3, { owner: true });
  await send('agent mcp tools/call whoami, a refused room', 'POST', '/api/mcp', { headers: kh, json: legacy('tools/call', { name: 'whoami', arguments: { room: room2 } }) });
  await hook('agent: whats_waiting\'s gap lowered (test hook)', { glance_gap_ms: 1 });
  await send('agent mcp tools/call list_rooms, a refused room', 'POST', '/api/mcp', { headers: kh, json: legacy('tools/call', { name: 'list_rooms', arguments: {} }) });
  await send('agent mcp tools/call whats_waiting, a refused room', 'POST', '/api/mcp', { headers: kh, json: legacy('tools/call', { name: 'whats_waiting', arguments: {} }) });
  await send('agent GET /api/agent, a refused room', 'GET', '/api/agent', { headers: kh });
  await send('agent mcp tools/call get_start_page, a refused room', 'POST', '/api/mcp', { headers: kh, json: legacy('tools/call', { name: 'get_start_page', arguments: { room: room2 } }) });
  await send('agent POST /api/agent/rooms/remove, a refused room', 'POST', '/api/agent/rooms/remove', { headers: kh, json: { room: room2 } });
  await hook('agent: limits as they were (test hook)', { clear: true });
  // leave_room through the key: the seat leaves, and the key marks the room left (it stays on the key for the disconnect)
  await send('agent mcp tools/call leave_room, wrong confirm', 'POST', '/api/mcp', { headers: kh, json: legacy('tools/call', { name: 'leave_room', arguments: { room, confirm: 'not-this-room' } }) });
  await send('agent mcp tools/call leave_room', 'POST', '/api/mcp', { headers: kh, json: legacy('tools/call', { name: 'leave_room', arguments: { room, confirm: room } }) });
  await send('agent mcp tools/call list_rooms, after the leave', 'POST', '/api/mcp', { headers: kh, json: legacy('tools/call', { name: 'list_rooms', arguments: {} }) });
  await send('agent mcp tools/call whoami, after the leave', 'POST', '/api/mcp', { headers: kh, json: legacy('tools/call', { name: 'whoami', arguments: { room } }) });
  await send('agent POST /api/agents/invite, a check', 'POST', '/api/agents/invite', { json: { name: 'DiffNew', rooms: [{ room, inviter_token: per }], check: true }, headers: net });
  await send('agent POST /api/agent/rooms/invite, a check', 'POST', '/api/agent/rooms/invite', { headers: kh, json: { name: 'DiffNew', rooms: [{ room: room2, inviter_token: per }], check: true } });
  // a leave through the key, refused before it asks any room, so nothing changes on either server
  await send('agent POST /api/agent/rooms/leave, delete_room', 'POST', '/api/agent/rooms/leave', { headers: kh, json: { room, confirm: room, delete_room: true } });
  await send('agent POST /api/agent/rooms/leave, a room the key marks left', 'POST', '/api/agent/rooms/leave', { headers: kh, json: { room, confirm: room } });
  // the disconnect with a room the key holds that refused its invite (the agent left it)
  must('agent: disconnected', (await send('agent DELETE /api/agent', 'DELETE', '/api/agent', { headers: kh })).status === 200);
  await send('agent GET /api/agent, disconnected', 'GET', '/api/agent', { headers: kh });
  await send('agent DELETE /api/agent, disconnected', 'DELETE', '/api/agent', { headers: kh });
  must('agent: the second key disconnected', (await send('agent DELETE /api/agent, the second key', 'DELETE', '/api/agent', { headers: { Authorization: 'Bearer ' + tokens.KEY2 } })).status === 200);
  await send('agent: delete invites 2', 'DELETE', R2 + '/invites', { owner: true });
  await send('agent: delete room 2', 'DELETE', R2 + '?confirm=' + room2, { owner: true });
  // preflights: the key's address and a room's (compared), and the paths that answer with their own CORS (PREFLIGHT_CHANGED)
  const pre = { Origin: 'https://example.org', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization, content-type' };
  await send('OPTIONS /api/mcp', 'OPTIONS', '/api/mcp', { headers: pre });
  await send('OPTIONS a room\'s /mcp', 'OPTIONS', R + '/mcp', { headers: pre });
  for (const p of ['/api/mcp/signin', '/api/oauth/token', '/api/oauth/revoke', '/api/oauth/decide', '/api/oauth/disconnect']) await send('OPTIONS ' + p, 'OPTIONS', p, { headers: pre });
  // the sign-in's paths (SIGNIN_PATHS), and a well-known path it does not serve (compared)
  for (const [m, p] of SIGNIN_PATHS.map((l) => l.split(' '))) await send(m + ' ' + p, m, p, m === 'POST' ? { body: '' } : {});
  await send('GET /.well-known/openid-configuration', 'GET', '/.well-known/openid-configuration');
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
  return { out, tokens, setup };
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
  LIM = await import('../../worker/limits.ts');
  const { SERVED_SKILLS } = await import('../../worker/agents/skills/served/index.ts');
  SKILL_REQUESTS = [
    ['skills/list 2026-07-28', 'skills/list', {}],
    ['skills/get ' + SERVED_SKILLS[0].uri, 'skills/get', { uri: SERVED_SKILLS[0].uri }],
    ['resources/list 2026-07-28', 'resources/list', {}],
    ['resources/templates/list 2026-07-28', 'resources/templates/list', {}],
    ...SERVED_SKILLS.flatMap((s) => s.files.map((f) => ['resources/read ' + f.uri, 'resources/read', { uri: f.uri }, f.uri])),
  ];
  const mine = require('./server.js');
  const theirs = require(path.resolve(OTHER, 'tests', 'api', 'server.js'));
  // one fake Muse for both bridges (a gadget's account is its own per server)
  const muse = await (await import('./fake-muse.mjs')).startFakeMuse();
  const a = await theirs.start({ museOrigin: muse.url });
  const b = await mine.start({ museOrigin: muse.url });
  let diffs = 0, compared = 0, cspChanged = 0;
  /** the parts left out of the compare where the copies differ: part -> the answers' labels */
  const left = new Map();
  const leftOut = (part, label) => { if (!left.has(part)) left.set(part, []); left.get(part).push(label); };
  try {
    const suf = Date.now().toString(36);
    const ra = await scenario(a, muse, suf);
    const rb = await scenario(b, muse, suf);
    for (const [side, r] of [['the earlier checkout', ra], ['this checkout', rb]]) {
      if (r.setup.length) { console.log('FAIL on ' + side + ', set-up calls did not do what the list assumes: ' + r.setup.join('; ')); process.exit(1); }
    }
    // the served origin, to fill the expected edits
    const origin = String((JSON.parse(rb.out.find((x) => x.label === '/api/changes').text).url || '')).replace(/\/api\/changes$/, '');
    const fill = (s) => s.replace(/\{\{origin\}\}/g, origin).replace(/\{\{MUSE_BATCH_MAX\}\}/g, String(LIM.MUSE_BATCH_MAX)).replace(/\{\{room2\}\}/g, 'difftest2-' + suf);
    if (ra.out.length !== rb.out.length) { console.log('FAIL the two runs sent different numbers of requests: ' + ra.out.length + ', ' + rb.out.length); process.exit(1); }
    // each server's skills, as its skills/list answered at the room's address (none from one that serves none)
    const listing = (r) => { const hit = r.out.find((o) => o.label === 'mcp skills skills/list 2026-07-28'); try { const j = JSON.parse(hit.text); return j.result && Array.isArray(j.result.skills) ? j.result.skills : null; } catch { return null; /* no skills there */ } };
    const skillsA = listing(ra), skillsB = listing(rb);
    const versionOf = (list, name) => { const e = (list || []).find((s) => s.frontmatter && s.frontmatter.name === name); return e ? e.frontmatter.metadata.version : null; };
    const skillOfUri = (uri) => String(uri).replace(/^skill:\/\/agent-chat\//, '').split('/')[0];
    /** the skills whose version moved between the two (a skill new here among them): their entries and files are not compared */
    const moved = new Set((skillsB || []).map((s) => s.frontmatter.name).filter((n) => skillsA && versionOf(skillsA, n) !== versionOf(skillsB, n)));
    for (let i = 0; i < ra.out.length; i++) {
      const x = ra.out[i], y = rb.out[i];
      let tx = masked(x.text, ra.tokens), ty = masked(y.text, rb.tokens);
      if (y.skills && NEW_METHODS.has(y.skills.method)) {
        // a method the other checkout did not serve: it answered the unknown method's 404
        compared++;
        let e = null;
        try { e = JSON.parse(x.text).error; } catch { /* not JSON: refused below */ }
        if (x.status !== 404 || !e || e.code !== -32601 || e.message !== 'Method not found: ' + y.skills.method) { diffs++; console.log('FAIL ' + x.label + ': the earlier checkout answered ' + x.status + ' ' + JSON.stringify(x.text.slice(0, 80)) + ', not the unknown method\'s 404 -32601'); }
        continue;
      }
      if (y.skills && moved.size) {
        // a skill whose version moved: its entries and files are left out of the compare
        if (y.skills.uri !== undefined && moved.has(skillOfUri(y.skills.uri))) { leftOut('the files and entry of a skill whose version moved (' + skillOfUri(y.skills.uri) + ')', y.label); continue; }
        const drop = (t, key) => { try { const j = JSON.parse(t); if (j.result && Array.isArray(j.result[key])) j.result[key] = j.result[key].filter((e) => !moved.has(e.frontmatter ? e.frontmatter.name : skillOfUri(e.uri))); return JSON.stringify(j); } catch { return t; /* not a list: compared as it is */ } };
        const key = y.skills.method === 'skills/list' ? 'skills' : y.skills.method === 'resources/list' ? 'resources' : null;
        if (key) { const before = tx + ty; tx = drop(tx, key); ty = drop(ty, key); if (before !== tx + ty) leftOut('the entries of the skills whose version moved (' + [...moved].join(', ') + ')', y.label); }
      }
      if (y.label.includes('server/discover')) {
        EXPECTED_ANSWER_EDITS.forEach(([now, was], e) => { if (ty.includes(now)) { ty = ty.split(now).join(was); leftOut('answer edit ' + (e + 1) + ' (' + JSON.stringify(now.slice(0, 56)) + '...)', y.label); } });
      }
      if (NEW_PATHS.has(y.label)) {
        // a path the other checkout did not serve: it answered the unknown path's 404
        compared++;
        if (x.status !== 404 || x.text !== 'Not found') { diffs++; console.log('FAIL ' + x.label + ': the earlier checkout answered ' + x.status + ' ' + JSON.stringify(x.text.slice(0, 60)) + ', not the unknown path\'s 404'); }
        continue;
      }
      if (PREFLIGHT_CHANGED.has(y.label)) {
        // a preflight this checkout answers with its own CORS: the other answered every path's
        compared++;
        const g = ra.out.find((o) => o.label === PREFLIGHT_GENERIC);
        if (!g || x.status !== g.status || x.text !== g.text || JSON.stringify(x.headers) !== JSON.stringify(g.headers)) { diffs++; console.log('FAIL ' + x.label + ': the earlier checkout did not answer the generic preflight: ' + x.status + ' ' + JSON.stringify(x.headers)); }
        continue;
      }
      // a section runs to the next line that starts at the margin (its body is indented)
      const sectionOf = (t, head) => {
        const at = t.indexOf('\n' + head + '\n');
        if (at < 0) return '';
        const next = t.slice(at + 1).search(/\n(?=[^ \n])/);
        return next < 0 ? t.slice(at) : t.slice(at, at + 1 + next);
      };
      const cut = (t, head) => { const sec = sectionOf(t, head); return sec ? t.replace(sec, '') : t; };
      if (y.label === '/api') {
        for (const head of ADDED_SECTIONS) { if (ty.includes('\n' + head + '\n')) leftOut('the section ' + head + ', which only this checkout has', y.label); ty = cut(ty, head); }
        for (const head of CHANGED_SECTIONS) {
          if (sectionOf(tx, head) !== sectionOf(ty, head)) leftOut('the section ' + head + ', which this checkout rewrites', y.label);
          ty = cut(ty, head); tx = cut(tx, head);
        }
        EXPECTED_DOC_EDITS.forEach(([now, was], e) => { const n = fill(now); if (ty.includes(n)) { ty = ty.replace(n, fill(was)); leftOut('docs edit ' + (e + 1) + ' (' + JSON.stringify(n.trim().slice(0, 56)) + '...)', y.label); } });
      }
      if (y.label.startsWith('agent ')) {
        EXPECTED_SENTENCE_EDITS.forEach(([now, was], e) => {
          const n = fill(now), w = fill(was);
          const before = ty;
          ty = ty.split(n).join(w).split(JSON.stringify(n).slice(1, -1)).join(JSON.stringify(w).slice(1, -1));
          if (ty !== before) leftOut('changed sentence ' + (e + 1) + ' (' + JSON.stringify(n.trim().slice(0, 56)) + '...)', y.label);
        });
      }
      if (y.label === '/llms.txt') EXPECTED_DOC_EDITS.forEach(([now, was], e) => { const n = fill(now); if (ty.includes(n)) { ty = ty.replace(n, fill(was)); leftOut('docs edit ' + (e + 1) + ' (' + JSON.stringify(n.trim().slice(0, 56)) + '...)', y.label); } });
      if (PAGE_EDITS[y.label]) {
        const before = ty;
        for (const [now, was] of PAGE_EDITS[y.label]) ty = ty.split(now).join(was);
        if (ty !== before) leftOut('the markup this checkout changes on the page (PAGE_EDITS)', y.label);
      }
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
      for (const [h, own] of [[hx, ra.tokens.serverOrigin], [hy, rb.tokens.serverOrigin]]) for (const k of Object.keys(h)) h[k] = h[k].split(own).join('<TOKEN:serverOrigin>');
      if (MOVING_RETRY.has(y.label) && /^\d+$/.test(hx['retry-after'] || '') && /^\d+$/.test(hy['retry-after'] || '')) {
        const was = hx['retry-after'] + tx + hy['retry-after'] + ty;
        hx['retry-after'] = hy['retry-after'] = '<RETRY>';
        tx = tx.replace(/("retry_after":)\d+/, '$1<RETRY>');
        ty = ty.replace(/("retry_after":)\d+/, '$1<RETRY>');
        if (was !== hx['retry-after'] + tx + hy['retry-after'] + ty && x.headers['retry-after'] + x.text !== y.headers['retry-after'] + y.text) leftOut('the retry time of a counter\'s window (seconds to its end, which moves with the run)', y.label);
      }
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
    // The versions rule (worker/agents/skills/versions.json, which only grows): every version the other
    // checkout recorded is recorded here with the same manifest digest; a skill whose files differ
    // between the two servers carries a version the other had not recorded; and a skill whose version
    // moved changed more than its version line.
    const fs = require('fs');
    const crypto = require('crypto');
    const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; /* none there */ } };
    const vA = readJson(path.resolve(OTHER, 'worker', 'agents', 'skills', 'versions.json')), vB = readJson(path.join(__dirname, '..', '..', 'worker', 'agents', 'skills', 'versions.json'));
    const ruleFail = (s) => { diffs++; console.log('FAIL ' + s); };
    if (!vB) ruleFail('versions: this checkout has no worker/agents/skills/versions.json: run npm run skills');
    if (!vA) console.log('note versions: the earlier checkout records no skill versions (no worker/agents/skills/versions.json: it serves no skills), so nothing holds this one to an earlier record');
    else {
      for (const [name, versions] of Object.entries(vA)) {
        for (const [v, d] of Object.entries(versions)) {
          const here = vB && vB[name] ? vB[name][v] : undefined;
          if (here !== d) ruleFail('versions: ' + name + ' version ' + v + ' is recorded in the earlier checkout with ' + d + (here ? ', and here with ' + here : ', and not here') + ': an earlier entry was rewritten or deleted; put it back as it was published, and move the skill\'s metadata.version instead');
        }
      }
      const manifest = (e) => crypto.createHash('sha256').update(JSON.stringify(e.resources)).digest('hex');
      const fileText = (r, uri) => { const hit = r.out.find((o) => o.label === 'mcp skills resources/read ' + uri); try { const j = JSON.parse(hit.text); return j.result ? j.result.contents[0].text : null; } catch { return null; /* not served there */ } };
      for (const e of skillsB || []) {
        const name = e.frontmatter.name, o = (skillsA || []).find((s) => s.frontmatter.name === name);
        if (!o) continue;
        const version = e.frontmatter.metadata.version;
        if (manifest(o) !== manifest(e) && Object.hasOwn(vA[name] || {}, version)) ruleFail('versions: ' + name + '\'s files differ from the earlier checkout\'s, but it carries version ' + version + ', which that checkout recorded: move its metadata.version to a new one (npm run skills says which)');
        if (moved.has(name)) {
          const unversioned = (t) => (t === null ? null : t.replace(/^ {2}version: "\d+"$/m, '  version: "N"'));
          const same = JSON.stringify(o.resources.map((r) => r.uri)) === JSON.stringify(e.resources.map((r) => r.uri)) && e.resources.every((r) => fileText(ra, r.uri) !== null && unversioned(fileText(ra, r.uri)) === unversioned(fileText(rb, r.uri)));
          if (manifest(o) === manifest(e) || same) ruleFail('versions: ' + name + '\'s version moved from ' + versionOf(skillsA, name) + ' to ' + version + ', but nothing else in its files changed: a version moved for nothing');
          else console.log('note versions: ' + name + ' moved from version ' + versionOf(skillsA, name) + ' to ' + version + ' with its files');
        }
      }
    }
    // The facts rule (worker/agents/skills/facts.ts), on facts matched by id, or by their text when
    // the id is new or names another text there (a rename): a fact whose text stays the same while its
    // anchors (or verbatim sources) change is printed, for a person to read the new anchors against
    // it; it passes only when ANCHOR_ONLY_FACTS holds it with exactly those anchors, and every entry
    // there must be printed. A fact here whose text was verbatim there, under any id, and is a
    // paraphrase here fails: that sentence is no longer served, so its text, and its skill's
    // version, must change. And a fact whose text and anchors both stay, while a sentence one of
    // them sits in is served otherwise here (rendered as the unit test renders it), is printed with
    // both sentences, and passes only when FACT_SENTENCES_READ holds it with this one.
    const theirFile = path.resolve(OTHER, 'worker', 'agents', 'skills', 'facts.ts');
    const factsHere = (await import('../../worker/agents/skills/facts.ts')).FACTS;
    const factsThere = fs.existsSync(theirFile) ? (await import(pathToFileURL(theirFile).href)).FACTS : null;
    const printed = new Set(), readHere = new Set();
    if (!factsThere) console.log('note facts: the earlier checkout has no worker/agents/skills/facts.ts (it serves no skills): no fact to compare');
    else {
      const { factSources, placeOf } = await import('../unit/skills-sources.mjs');
      const srcHere = (await factSources(path.join(__dirname, '..', '..'))).source;
      const srcThere = (await factSources(path.resolve(OTHER), { lenient: true })).source;
      const thereByText = new Map();
      for (const [id, o] of Object.entries(factsThere)) { if (!thereByText.has(o.text)) thereByText.set(o.text, []); thereByText.get(o.text).push([id, o]); }
      const fold = (t) => t.replace(/\s+/g, ' ').trim().toLowerCase().replace(/[.:;,]$/, '');
      for (const [id, f] of Object.entries(factsHere)) {
        const sameText = thereByText.get(f.text) || [];
        if (f.anchors) for (const [was] of sameText.filter(([, o]) => o.verbatim)) ruleFail('facts: ' + id + ' is a paraphrase here, and its text was verbatim in the earlier checkout' + (was === id ? '' : ' (as ' + was + ')') + ': the sentence it was is no longer served, so change its text (and move its skill\'s metadata.version)');
        const byId = Object.hasOwn(factsThere, id) && factsThere[id].text === f.text ? [id, factsThere[id]] : null;
        const match = byId || sameText[0] || null;
        if (!match) continue;
        const [thereId, o] = match;
        const was = o.anchors || o.verbatim, now = f.anchors || f.verbatim;
        if (JSON.stringify(was) !== JSON.stringify(now) || !!o.anchors !== !!f.anchors) {
          printed.add(id);
          console.log('facts: ' + id + (thereId === id ? '' : ' (' + thereId + ' in the earlier checkout)') + ' keeps its text and changes its ' + (f.anchors ? 'anchors' : 'sources') + '\n  text: ' + f.text + '\n  was:  ' + JSON.stringify(was) + '\n  now:  ' + JSON.stringify(now));
          if (o.verbatim && f.anchors) continue;
          const entry = ANCHOR_ONLY_FACTS.find(([x]) => x === id);
          if (!entry) ruleFail('facts: ' + id + '\'s anchors changed while its text did not: read the new anchors against the fact and, if they state all of it, add [' + JSON.stringify(id) + ', its anchors as facts.ts holds them] to ANCHOR_ONLY_FACTS');
          else if (JSON.stringify(entry[1]) !== JSON.stringify(now)) ruleFail('facts: ANCHOR_ONLY_FACTS holds ' + id + ' with other anchors than facts.ts does: copy the anchors that were read');
          continue;
        }
        // the same fact, the same anchors: the sentences they sit in, as each checkout serves them
        const needles = f.anchors ? f.anchors.map(([k, anchor]) => [k, anchor, false]) : f.verbatim.map((k) => [k, fold(f.text), true]);
        for (const [k, needle, folded] of needles) {
          const here = placeOf(srcHere(k).text, needle, { fold: folded }), there = placeOf(srcThere(k).text, needle, { fold: folded });
          if (!here || !there) { console.log('note facts: ' + id + '\'s ' + (folded ? 'text' : 'anchor') + ' is not found in ' + k + ' as ' + (here ? 'the earlier' : 'this') + ' checkout serves it'); continue; }
          if (here.sentence === there.sentence) continue;
          readHere.add(JSON.stringify([id, k, here.sentence]));
          console.log('facts: ' + id + ' keeps its text and anchors, and a sentence it sits in (' + k + ') is served otherwise\n  text: ' + f.text + '\n  was:  ' + there.sentence + '\n  now:  ' + here.sentence);
          // an entry is the fact's id, the source and the sentence exactly as printed here
          if (FACT_SENTENCES_READ.some(([x, y, z]) => x === id && y === k && z === here.sentence)) continue;
          if (FACT_SENTENCES_READ.some(([x, y]) => x === id && y === k)) ruleFail('facts: FACT_SENTENCES_READ holds ' + id + ' (' + k + ') with another sentence than this checkout serves: copy the sentence that was read');
          else ruleFail('facts: ' + id + '\'s sentence in ' + k + ' changed while the fact did not: read the new sentence against the fact; if it still states all of it, add [' + JSON.stringify(id) + ', ' + JSON.stringify(k) + ', the sentence as printed] to FACT_SENTENCES_READ, else change the fact');
        }
      }
    }
    for (const [id] of ANCHOR_ONLY_FACTS) if (!printed.has(id)) ruleFail('facts: ANCHOR_ONLY_FACTS names ' + id + ', whose anchors did not change against the earlier checkout: take it out (the list is written for each release)');
    for (const [id, k, sentence] of FACT_SENTENCES_READ) if (!readHere.has(JSON.stringify([id, k, sentence]))) ruleFail('facts: FACT_SENTENCES_READ holds ' + id + ' (' + k + ') with a sentence this checkout does not print as changed: take it out, or copy the sentence printed (the list is written for each release)');
  } finally {
    a.stop();
    b.stop();
    muse.close();
  }
  // each part left out of the compare, where the two copies differ there, and on which answers
  for (const [part, labels] of left) console.log('note left out ' + part + ': on ' + labels.length + ' answer' + (labels.length === 1 ? '' : 's') + ' (' + labels.slice(0, 4).join('; ') + (labels.length > 4 ? '; ...' : '') + ')');
  if (cspChanged !== CSP_CHANGED.size) { diffs++; console.log('FAIL the app shell\'s policy was checked on ' + cspChanged + ' answers, not ' + CSP_CHANGED.size); }
  console.log(diffs ? 'DIFFERENTIAL: ' + diffs + ' of ' + compared + ' answers differ' : 'DIFFERENTIAL: all ' + compared + ' answers identical, headers included (masked as above' + (cspChanged ? '; the app shell\'s policy gained only "' + CSP_ADDED.slice(2) + '" on ' + cspChanged + ' answers' : '') + ')');
  process.exit(diffs ? 1 : 0);
})().catch((e) => { console.error('differential crashed: ' + ((e && e.stack) || e)); process.exit(1); });
