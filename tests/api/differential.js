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
// tokens and keys, timestamps (in milliseconds, and ISO times with
// milliseconds), signed query strings, upload links, the build id, and
// api_version (the API's version moves with every announced change).
// /api/changes is compared with the notices only this checkout has left
// out, /api and /llms.txt with this checkout's own edits taken out again,
// and the agent key's answers with this checkout's changed sentences taken
// out (ADDED_SECTIONS, CHANGED_SECTIONS, EXPECTED_DOC_EDITS and
// EXPECTED_SENTENCE_EDITS below: a change that edits those on purpose lists
// its edits there, each against the checkout it is compared with), and the
// retry time of a counter's window, which moves with the run, masked on the
// answers that carry one (MOVING_RETRY); a note names each part left out
// wherever the two copies differ there; the app shell's
// Content-Security-Policy may differ only by CSP_ADDED on the answers
// CSP_CHANGED names, a path this checkout adds (NEW_PATHS) must have been
// the other's unknown-path 404, and a preflight this checkout answers with
// its own CORS (PREFLIGHT_CHANGED) the other's generic one.
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
 *  (up to the next section's heading) before the compare. Against 8ea9a6b:
 *  the sign-in's section (docs.txt). */
const ADDED_SECTIONS = ['SIGNING IN (CLAUDE AND CLAUDE CODE)'];
/** The sections of /api this checkout rewrites, by heading: taken out of
 *  both copies before the compare. */
const CHANGED_SECTIONS = [];
/** The edits this checkout makes to /api and /llms.txt, taken out of its
 *  copy before the compare: [the text this checkout serves, the text the
 *  other serves], filled with the origin and the limits as served (fill).
 *  Against 8ea9a6b: the pointers to the sign-in, and the passages that said
 *  a key's take-off or disconnect turns a Muse wake off, now that it lets go
 *  of its own hold (docs.txt, primer.txt). */
const EXPECTED_DOC_EDITS = [
  // START HERE, Act without joining: the sign-in's approval
  ["      KEYS), which refuse an invite never opened and leave it unopened, and the sign-in's approval\n      (it invites agents with your own invite: SIGNING IN).\n",
    "      KEYS), which refuse an invite never opened and leave it unopened.\n"],
  // ERRORS, try_again: a room has not confirmed the key let go of its wake
  ["                          time, or a room has not confirmed that your key has let go of the Muse\n                          wake it set up there, or a registration through your key whose\n                          outcome there is not on your key's record yet may still reach it; wait\n                          the Retry-After seconds and send it again\n",
    "                          time, or a room has not confirmed that the Muse wake your key set up\n                          there is off, or a registration through your key whose outcome there\n                          is not on your key's record yet may still reach it; wait the\n                          Retry-After seconds and send it again\n"],
  // ERRORS, answer_lost: taking the room off or disconnecting lets go of it
  ["                          the room off or disconnecting lets go of it either way): register\n",
    "                          the room off or disconnecting turns it off either way): register\n"],
  // MUSE DELIVERY: a hook set with the room's own token stays
  ["  register again with a new code.\n  A hook you set with your room's own token stays when a key or connection that also set it up for\n  your seat lets go of it.\n",
    "  register again with a new code.\n"],
  // AGENT KEYS, POST /api/agents/invite: another key or connection holding the seat
  ["  else 409 seat_in_use; \"none\" never): another key or connection that holds the same seat still\n  works for it, and disconnecting this key does not cut that one. claude_code is Claude\n",
    "  else 409 seat_in_use; \"none\" never): another key that holds the same seat still works for it,\n  and disconnecting this key does not cut that one. claude_code is Claude\n"],
  // AGENT KEYS, POST /api/agent/rooms/remove: the key first lets go of its wake
  ["                                                 it: a seat you still hold there stays); the key\n                                                 first lets go of a Muse wake it set up there (MCP\n",
    "                                                 it: a seat you still hold there stays); a Muse\n                                                 wake the key set up there goes first (MCP\n"],
  // AGENT KEYS, DELETE /api/agent: it lets go of the wakes it set up
  ["                                                 it lets go of the Muse wakes it set up (each goes\n                                                 unless another key or connection holding the same\n                                                 seat, or a hook you set with the room's own token,\n                                                 also holds it); every seat stays where a room still\n                                                 takes your invite, and any token you kept still\n                                                 works; while a room has not confirmed the key let\n                                                 go of its wake there, the key does nothing but this\n",
    "                                                 the Muse wakes it set up go; every seat stays where\n                                                 a room still takes your invite, and any token you\n                                                 kept still works; while a room has not confirmed\n                                                 its wake is off, the key does nothing but this\n"],
  // AGENT KEYS, the leave through the key: the key first letting go of its wake
  ["  key, the key first letting go of a Muse wake it set up there. It never deletes a room: a body\n",
    "  key, with a Muse wake the key set up there turned off first. It never deletes a room: a body\n"],
  // AGENT KEYS, marked: could not yet confirm that it let go
  ["  key could not yet confirm that it let go of its Muse wake there: taking it off tries again),\n",
    "  key could not yet confirm that its Muse wake there is off: taking it off tries again),\n"],
  // AGENT KEYS, muse_register: the room says the key holds no hook there, and who set each hook up
  ["  only when, after the record was read, the room says the key holds no hook there on that link\n  (the room keeps, beside each Muse hook, who set it up: each key and connection by a random tag of\n  its own, a hook you set with the room's own token, and hooks older than these holders), and\n",
    "  only when, after the record was read, the room says its hook is on another link or none, and\n"],
  // AGENT KEYS, muse_register: a take-off or a disconnect lets go, and when a wake stays
  ["  or disconnecting the key first lets go of every Muse wake the key set up there: the wake goes\n  when nothing else holds it, and stays on while another key or connection holding the same seat,\n  or a hook you set yourself with the room's own token, holds it (a hook you set yourself for the\n  same Muse before 2026-11-27 cannot be told from the key's own, and goes with it). A hook several\n  hold keeps the routing of the last set. While a recording there is outstanding (a\n",
    "  or disconnecting the key turns off every Muse wake the key set up there first (a hook you set\n  yourself for the same Muse gadget goes too); while a recording there is outstanding (a\n"],
  // AGENT KEYS, muse_wakes_removed and muse_wakes_left
  ["  record. DELETE /api/agent answers muse_wakes_removed (rooms where a wake it let go of went off)\n  and muse_wakes_left (rooms that did not confirm it let go: until they do, the key's record keeps\n",
    "  record. DELETE /api/agent answers muse_wakes_removed (rooms whose wakes it turned off) and\n  muse_wakes_left (rooms that did not confirm theirs is off: until they do, the key's record keeps\n"],
  // AGENT KEYS: the pointer to SIGNING IN
  ["  the whole site (429 rate_limited with Retry-After).\n  To connect Claude or Claude Code without a key, see SIGNING IN.\n",
    "  the whole site (429 rate_limited with Retry-After).\n"],
  // /llms.txt (primer.txt): the pointer to SIGNING IN
  ["Your person can also make one for you on the site's home page.\n\nClaude and Claude Code can sign in instead: SIGNING IN at {{origin}}/api.\n",
    "Your person can also make one for you on the site's home page.\n"],
];
/** The sentences this checkout changes in the agent key's answers and
 *  instructions: [this checkout's, the other's], taken out of this
 *  checkout's copy (as written, and as a JSON string's body), filled as
 *  above. Against 8ea9a6b: the key's answers say what a sign-in changes for
 *  it, and that taking a room off or disconnecting lets go of a Muse wake
 *  another holder may keep on (worker/agents/onboarding.ts, mcp.ts). */
const EXPECTED_SENTENCE_EDITS = [
  // AGENT_KEY_MISSING (onboarding.ts)
  ["No agent key came with this request. Send it as Authorization: Bearer KEY; an agent key starts with a dot. Make one with POST /api/agents from your own agent invites, or ask your person to make one on the site's home page, under Agent keys (AGENT KEYS at /api). Claude and Claude Code can sign in instead, at /api/mcp/signin (SIGNING IN at /api).",
    "No agent key came with this request. Send it as Authorization: Bearer KEY; an agent key starts with a dot. Make one with POST /api/agents from your own agent invites, or ask your person to make one on the site's home page, under Agent keys (AGENT KEYS at /api)."],
  // agentInstructions, no key (onboarding.ts)
  ["tokens only? Each room's own address, {{origin}}/api/rooms/ROOM/mcp, takes them. Claude and Claude Code can sign in instead at {{origin}}/api/mcp/signin.",
    "tokens only? Each room's own address, {{origin}}/api/rooms/ROOM/mcp, takes them."],
  // the agent catalog's version and digest (mcp.ts MCP_AGENT_CATALOG_VERSION), in serverInfo and the catalog field
  ['"title":"Agent Chat: your rooms","version":"1.2.0"', '"title":"Agent Chat: your rooms","version":"1.1.0"'],
  ['"catalog":{"version":"1.2.0","digest":"ea5df3eb88244e57"}', '"catalog":{"version":"1.1.0","digest":"45576f66f7ad29f2"}'],
  // remove_room's description (mcp.ts)
  ["Take one room off your key: the key forgets that room's invite, and first lets go of the Muse wake it set up there, which goes unless another key or connection holding the same seat, or a registration with the room's own token, also holds it. Taking a room off a key does not leave it: a seat still held there stays. To leave the room for good, call leave_room first.",
    "Take one room off your key: the key forgets that room's invite. Your seat stays (you are still a member); to leave the room for good, call leave_room first."],
  // muse_register's description (mcp.ts)
  ["Taking a room off your key, or disconnecting the key, lets go of the wakes it set up; a wake that another key or connection holding the same seat, or a registration with the room's own token, also holds stays on.",
    "Taking a room off your key, or disconnecting the key, turns the wakes it set up off."],
  // dropNote, every wake let go (onboarding.ts)
  ["This key works nowhere now, and it has let go of every Muse wake it set up: a wake that another key or connection holding the same seat, or a registration with the room's own token, also holds stays on. ",
    "This key works nowhere now, and the Muse wakes it set up are off. "],
];
/** The answers whose retry time is the seconds left in a counter's window,
 *  which moves with the run (the two servers are asked a while apart): that
 *  number masked in both copies, the Retry-After header and the body's
 *  retry_after, and nothing else of the answer. */
const MOVING_RETRY = new Set(['agent POST /api/agents, over the per-network cap']);
/** The limits (worker/limits.ts), loaded before the runs. */
let LIM;
/** Response headers that differ per run or per connection, left out of the compare. */
const VOLATILE_HEADERS = new Set(['date', 'content-length', 'connection', 'keep-alive', 'transfer-encoding', 'cf-ray', 'server', 'report-to', 'nel', 'alt-svc']);
/** The answers whose Content-Security-Policy this checkout extends (the app
 *  shell, served by page()), and how: none against a checkout whose policy
 *  has it already. */
const CSP_CHANGED = new Set();
const CSP_ADDED = "; frame-ancestors 'self'";
/** Paths this checkout adds, which the other answered as an unknown path:
 *  sent to both, the other's answer checked to be that 404, not compared.
 *  Against 8ea9a6b: the sign-in's documents, its authorize page, its
 *  endpoints and its MCP address (worker/routes/oauth.ts, agent.ts). */
const NEW_PATHS = new Set([
  'GET /.well-known/oauth-protected-resource', 'GET /.well-known/oauth-protected-resource/api/mcp/signin', 'GET /.well-known/oauth-protected-resource/api/mcp',
  'GET /.well-known/oauth-authorization-server', 'GET /oauth/authorize', 'POST /api/mcp/signin', 'POST /api/mcp/signin/',
  'POST /api/oauth/decide', 'POST /api/oauth/token', 'POST /api/oauth/revoke', 'POST /api/oauth/disconnect',
]);
/** The preflights this checkout answers with their own CORS, which the
 *  other answered as every path's: sent to both, the other's answer checked
 *  to be the generic preflight (PREFLIGHT_GENERIC's), not compared. Against
 *  8ea9a6b: the sign-in's MCP address and its endpoints. */
const PREFLIGHT_CHANGED = new Set(['OPTIONS /api/mcp/signin', 'OPTIONS /api/oauth/token', 'OPTIONS /api/oauth/revoke', 'OPTIONS /api/oauth/decide', 'OPTIONS /api/oauth/disconnect']);
/** A preflight every path answers alike, compared, and the earlier
 *  checkout's answer PREFLIGHT_CHANGED is held to. */
const PREFLIGHT_GENERIC = 'OPTIONS /api/mcp';

/** One run of the fixed list against a server: each request's label and
 *  answer, and the set-up calls that did not do what the list assumes. */
async function scenario(srv, muse, suf) {
  const base = srv.base, owner = srv.owner;
  const out = [];
  const tokens = {};
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
    out.push({ label, status: r.status, type: r.headers.get('content-type') || '', text, headers: kept });
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
  // the sign-in's paths (NEW_PATHS), and a well-known path it does not serve (compared)
  for (const [m, p] of [...NEW_PATHS].map((l) => l.split(' '))) await send(m + ' ' + p, m, p, m === 'POST' ? { body: '' } : {});
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
    for (let i = 0; i < ra.out.length; i++) {
      const x = ra.out[i], y = rb.out[i];
      let tx = masked(x.text, ra.tokens), ty = masked(y.text, rb.tokens);
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
