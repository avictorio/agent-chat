// The MCP endpoint's revision 2026-07-28 against a real local Worker,
// with requests built by hand (the official clients are in
// tests/api/mcp-clients.js): server/discover in each token state, tools/list
// and tools/call with what that revision adds, one request per refusal
// before a method runs, notifications and batches, the unknown tool that
// joins nothing, the headers that change nothing, and the skills' methods.
// Called from api.test.js; its room is its own.
'use strict';
const crypto = require('crypto');

const NEW = '2026-07-28';
const V = 'io.modelcontextprotocol/protocolVersion', C = 'io.modelcontextprotocol/clientCapabilities';
/** a request of revision 2026-07-28, as the official v2 client writes it */
const rpc = (method, params, id, meta) => ({ jsonrpc: '2.0', id: id === undefined ? 1 : id, method, params: Object.assign({}, params || {}, { _meta: meta || { [V]: NEW, [C]: {} } }) });
/** its headers: the revision, the method and, on tools/call, the tool */
const heads = (method, name) => Object.assign({ 'MCP-Protocol-Version': NEW, 'Mcp-Method': method }, name === undefined ? {} : { 'Mcp-Name': name });

async function mcpModern(ctx) {
  const { req, check, SUF } = ctx;
  const room = 'apitest-mcpn-' + SUF, R = '/api/rooms/' + room;
  let r = await req('POST', R, { owner: true });
  check('mcp 2026-07-28: the room is created', r.status === 201, r.status);
  const mk = async (name) => ((await req('POST', R + '/invites', { owner: true, json: { name, kind: 'agent' } })).json || {}).token;
  const T = await mk('ModA'), U = await mk('ModU');
  /** the room's invite row for that name, as the owner's list shows it */
  const row = async (name) => ((await req('GET', R + '/invites', { owner: true })).json.invites || []).find((i) => i.name === name) || {};
  const post = (body, headers, token) => req('POST', R + '/mcp', { token, headers, json: body });
  const ORIGIN = String(((await req('GET', '/api/changes')).json || {}).url || '').replace(/\/api\/changes$/, '');

  // server/discover answers anyone: tokenless, with the "none" instructions
  r = await post(rpc('server/discover'), heads('server/discover'));
  const d = (r.json || {}).result || {};
  check('mcp 2026-07-28: a tokenless server/discover is answered 200 with its fields', r.status === 200 && JSON.stringify(Object.keys(d)) === JSON.stringify(['resultType', 'supportedVersions', 'capabilities', 'instructions', 'catalog', 'changes', 'ttlMs', 'cacheScope', '_meta']), r.status + ' ' + JSON.stringify(Object.keys(d)));
  check('mcp 2026-07-28: server/discover lists 2026-07-28 only, declares tools, resources and the skills extension, ttlMs 0, private', d.resultType === 'complete' && JSON.stringify(d.supportedVersions) === JSON.stringify([NEW]) && JSON.stringify(d.capabilities) === '{"tools":{},"resources":{},"extensions":{"io.modelcontextprotocol/skills":{}}}' && d.ttlMs === 0 && d.cacheScope === 'private', JSON.stringify(d).slice(0, 300));
  check('mcp 2026-07-28: a tokenless server/discover gets the instructions for no token', /^One Agent Chat room as tools\. This connection sent no invite token, so no tool will work\./.test(d.instructions || ''), String(d.instructions).slice(0, 120));
  check('mcp 2026-07-28: server/discover carries the server in _meta and the changes link', !!d._meta && JSON.stringify(d._meta['io.modelcontextprotocol/serverInfo']) === JSON.stringify({ name: 'agent-chat', title: 'Agent Chat', version: d.catalog && d.catalog.version, websiteUrl: ORIGIN }) && !!d.changes && d.changes.url === ORIGIN + '/api/changes', JSON.stringify(d._meta));
  r = await post(rpc('server/discover'), heads('server/discover'), 'not-one-of-this-rooms');
  check('mcp 2026-07-28: server/discover with an unknown token says invite_invalid', r.status === 200 && /\(invite_invalid\)/.test(((r.json || {}).result || {}).instructions || ''), r.text.slice(0, 160));
  r = await post(rpc('server/discover'), heads('server/discover'), T);
  check('mcp 2026-07-28: server/discover with a good token starts from get_start_page', /^One Agent Chat room as tools\. Call get_start_page first/.test(((r.json || {}).result || {}).instructions || ''), r.text.slice(0, 160));

  // tools/list: the same catalog as the other kind's, with resultType, ttlMs, cacheScope and _meta
  r = await post(rpc('tools/list'), heads('tools/list'), T);
  const l = (r.json || {}).result || {};
  const old = ((await post({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, {}, T)).json || {}).result || {};
  check('mcp 2026-07-28: tools/list carries resultType, ttlMs, cacheScope and the server', r.status === 200 && JSON.stringify(Object.keys(l)) === JSON.stringify(['resultType', 'tools', 'catalog', 'ttlMs', 'cacheScope', '_meta']) && l.resultType === 'complete' && l.ttlMs === 3600000 && l.cacheScope === 'private' && !!l._meta['io.modelcontextprotocol/serverInfo'], JSON.stringify(Object.keys(l)));
  check('mcp 2026-07-28: tools/list has the same tools and digest as the initialize kind\'s, each with a title', !!l.catalog && !!old.catalog && l.catalog.digest === old.catalog.digest && l.catalog.version === old.catalog.version && JSON.stringify(l.tools) === JSON.stringify(old.tools) && l.tools.every((t) => typeof t.title === 'string' && t.title.length > 0), JSON.stringify([l.catalog, old.catalog]));
  check('mcp 2026-07-28: the initialize kind\'s tools/list gains no field', JSON.stringify(Object.keys(old)) === JSON.stringify(['tools', 'catalog']), JSON.stringify(Object.keys(old)));
  r = await post(rpc('tools/list'), heads('tools/list'));
  check('mcp 2026-07-28: a tokenless tools/list is 200 -32001 invite_missing', r.status === 200 && !!r.json.error && r.json.error.code === -32001 && r.json.error.data.code === 'invite_missing', r.status + ' ' + r.text.slice(0, 160));
  const startInvalid = ((await req('GET', R, { token: 'not-one-of-this-rooms' })).json || {}).error;
  r = await post(rpc('tools/list'), heads('tools/list'), 'not-one-of-this-rooms');
  check('mcp 2026-07-28: an unknown token\'s tools/list gets the start page\'s sentence, invite_invalid', r.status === 200 && r.json.error && r.json.error.code === -32001 && r.json.error.data.code === 'invite_invalid' && !!startInvalid && r.json.error.message === startInvalid, r.text.slice(0, 200));

  // one request per refusal before a method runs
  const supported = { supported: [NEW], requested: '2099-01-01' };
  const recover = 'Invalid params: revision 2026-07-28 needs io.modelcontextprotocol/protocolVersion (a string) and io.modelcontextprotocol/clientCapabilities (an object) in params._meta on every request; to open with initialize instead, send the revision initialize answered in MCP-Protocol-Version, or no such header.';
  const refusals = [
    ['3 (a claim that is no string)', rpc('tools/list', {}, 1, { [V]: 20260728, [C]: {} }), heads('tools/list'), 400, -32602, 'Invalid params: io.modelcontextprotocol/protocolVersion in params._meta must be a string naming a revision, such as 2026-07-28.', { missing: [V] }],
    ['4 (the header unlike the claim)', rpc('tools/list'), Object.assign(heads('tools/list'), { 'MCP-Protocol-Version': '2025-11-25' }), 400, -32020, 'Header mismatch: MCP-Protocol-Version header value \'2025-11-25\' does not match body value \'2026-07-28\''],
    ['5 (Mcp-Method unlike the method)', rpc('tools/list'), Object.assign(heads('tools/list'), { 'Mcp-Method': 'tools/call' }), 400, -32020, 'Header mismatch: Mcp-Method header value \'tools/call\' does not match body value \'tools/list\''],
    ['6 (a claim of 2099-01-01)', rpc('tools/list', {}, 1, { [V]: '2099-01-01', [C]: {} }), Object.assign(heads('tools/list'), { 'MCP-Protocol-Version': '2099-01-01' }), 400, -32022, 'Unsupported protocol version', supported],
    ['6 (the header alone naming 2099-01-01)', { jsonrpc: '2.0', id: 1, method: 'tools/list' }, Object.assign(heads('tools/list'), { 'MCP-Protocol-Version': '2099-01-01' }), 400, -32022, 'Unsupported protocol version', supported],
    ['7 (the header alone, no _meta)', { jsonrpc: '2.0', id: 1, method: 'tools/list' }, heads('tools/list'), 400, -32602, recover, { missing: [V, C] }],
    ['8 (no MCP-Protocol-Version)', rpc('tools/list'), { 'Mcp-Method': 'tools/list' }, 400, -32020, 'Header mismatch: the MCP-Protocol-Version header is missing; it must equal io.modelcontextprotocol/protocolVersion in params._meta.'],
    ['9 (no Mcp-Method)', rpc('tools/list'), { 'MCP-Protocol-Version': NEW }, 400, -32020, 'Header mismatch: the Mcp-Method header is missing; it must equal the request\'s method.'],
    ['10 (no Mcp-Name)', rpc('tools/call', { name: 'whoami', arguments: {} }), heads('tools/call'), 400, -32020, 'Header mismatch: the Mcp-Name header is missing; on tools/call it must equal params.name.'],
    ['11 (a malformed Base64 sentinel)', rpc('tools/call', { name: 'whoami', arguments: {} }), heads('tools/call', '=?base64?abc?='), 400, -32020, 'Header mismatch: the Mcp-Name header\'s =?base64?...?= value is not Base64 of UTF-8 text.'],
    ['12 (Mcp-Name unlike the tool)', rpc('tools/call', { name: 'get_invite', arguments: {} }), heads('tools/call', 'whoami'), 400, -32020, 'Header mismatch: Mcp-Name header value \'whoami\' does not match body value \'get_invite\''],
    ['13 (ping)', rpc('ping'), heads('ping'), 404, -32601, 'Method not found: ping'],
  ];
  for (const [label, body, headers, status, code, message, data] of refusals) {
    r = await post(body, headers, U);
    const e = (r.json || {}).error || {};
    check('mcp 2026-07-28: check ' + label + ' answers ' + status + ' ' + code, r.status === status && r.json.id === 1 && e.code === code && e.message === message && JSON.stringify(e.data) === JSON.stringify(data) && r.headers.get('access-control-allow-origin') === '*', r.status + ' ' + r.text.slice(0, 240));
  }
  check('mcp 2026-07-28: the refusals opened nothing', (await row('ModU')).used === null, JSON.stringify(await row('ModU')));

  // Mcp-Name as a Base64 sentinel of a real tool's name is served
  r = await post(rpc('tools/call', { name: 'get_invite', arguments: {} }), heads('tools/call', '=?base64?' + Buffer.from('get_invite').toString('base64') + '?='), U);
  check('mcp 2026-07-28: Mcp-Name as a Base64 sentinel of the tool is served', r.status === 200 && !!r.json.result && r.json.result.resultType === 'complete' && r.json.result.structuredContent.invite.name === 'ModU', r.text.slice(0, 200));

  // notifications: a bare 202 with CORS, in both kinds
  r = await post({ jsonrpc: '2.0', method: 'notifications/initialized', params: { _meta: { [V]: NEW, [C]: {} } } }, { 'MCP-Protocol-Version': NEW, 'Mcp-Method': 'notifications/initialized' }, T);
  check('mcp 2026-07-28: a notification is 202 with an empty body', r.status === 202 && r.text === '', r.status + ' ' + JSON.stringify(r.text));
  check('mcp 2026-07-28: its 202 carries Access-Control-Allow-Origin: *', r.headers.get('access-control-allow-origin') === '*', String(r.headers.get('access-control-allow-origin')));
  r = await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, {}, T);
  check('mcp: a notification\'s 202 over the initialize kind carries Access-Control-Allow-Origin: * too', r.status === 202 && r.text === '' && r.headers.get('access-control-allow-origin') === '*', r.status + ' ' + r.headers.get('access-control-allow-origin'));

  // a batch holding a request of revision 2026-07-28 is refused whole
  r = await post([{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'whoami', arguments: {} } }, rpc('tools/list', {}, 2)], {}, U);
  check('mcp 2026-07-28: a batch with a 2026-07-28 element is 400 -32600, nothing run', r.status === 400 && r.json.id === null && r.json.error.code === -32600 && r.json.error.message === 'Invalid request: revision 2026-07-28 has no batches; send each request as its own POST.' && (await row('ModU')).used === null, r.status + ' ' + r.text.slice(0, 200));

  // the unknown tool joins nothing over revision 2026-07-28
  r = await post(rpc('tools/call', { name: 'no_such_tool', arguments: {} }), heads('tools/call', 'no_such_tool'), U);
  check('mcp 2026-07-28: an unknown tool is 200 -32602, and the invite stays unused', r.status === 200 && !!r.json.error && r.json.error.code === -32602 && r.json.error.message === 'Unknown tool: no_such_tool. Call tools/list for the catalog.' && (await row('ModU')).used === null, r.text.slice(0, 200));
  r = await post(rpc('tools/call', { name: 'whoami', arguments: {} }), heads('tools/call', 'whoami'), U);
  check('mcp 2026-07-28: whoami opens it, its result complete with the server in _meta', r.status === 200 && r.json.result.resultType === 'complete' && r.json.result.structuredContent.status === 'active' && !!r.json.result._meta && (await row('ModU')).used !== null, r.text.slice(0, 200));

  // an Origin header changes nothing
  for (const [body, headers] of [[rpc('tools/list'), heads('tools/list')], [{ jsonrpc: '2.0', id: 1, method: 'tools/list' }, {}], [rpc('server/discover'), heads('server/discover')]]) {
    const a = await post(body, headers, T);
    const b = await post(body, Object.assign({ Origin: 'https://evil.example' }, headers), T);
    check('mcp: an Origin header changes nothing (' + body.method + (body.params && body.params._meta ? ', 2026-07-28' : '') + ')', a.status === b.status && a.text === b.text && b.headers.get('access-control-allow-origin') === '*' && !b.headers.get('mcp-session-id'), a.status + ' ' + b.status);
  }

  // the skills (worker/agents/skills.ts), by hand, with a fresh invite that must stay unused
  const S = await mk('ModSkills');
  const cors = (x) => x.headers.get('access-control-allow-origin') === '*';
  r = await post(rpc('skills/list'), heads('skills/list'));
  check('mcp skills: a tokenless skills/list is 200 -32001 invite_missing', r.status === 200 && !!r.json.error && r.json.error.code === -32001 && r.json.error.data.code === 'invite_missing' && cors(r), r.status + ' ' + r.text.slice(0, 160));
  r = await post(rpc('skills/list'), heads('skills/list'), S);
  const listed = ((r.json || {}).result || {}).skills || [];
  check('mcp skills: skills/list gives the five skills, complete, an hour\'s ttlMs, private, with CORS', r.status === 200 && r.json.result.resultType === 'complete' && JSON.stringify(listed.map((x) => x.frontmatter.name)) === JSON.stringify(['taking-part', 'staying-present', 'playing-games', 'room-board', 'sharing-files']) && r.json.result.ttlMs === 3600000 && r.json.result.cacheScope === 'private' && cors(r), r.status + ' ' + r.text.slice(0, 200));
  r = await post(rpc('skills/list', { cursor: 'x' }), heads('skills/list'), S);
  check('mcp skills: a cursor is 200 -32602', r.status === 200 && r.json.error && r.json.error.code === -32602 && r.json.error.message === 'Invalid cursor: skills/list answers in one page; send it without a cursor.' && cors(r), r.text.slice(0, 160));
  const first = listed[0] && listed[0].uri, support = listed[2] && listed[2].resources[1] && listed[2].resources[1].uri;
  r = await post(rpc('resources/read', { uri: first }), heads('resources/read'), S);
  check('mcp skills: resources/read without Mcp-Name is 400 -32020 with its sentence', r.status === 400 && r.json.error && r.json.error.code === -32020 && r.json.error.message === 'Header mismatch: the Mcp-Name header is missing; on resources/read it must equal params.uri.' && cors(r), r.status + ' ' + r.text.slice(0, 160));
  r = await post(rpc('resources/read', { uri: first }), heads('resources/read', first), S);
  const body = ((r.json || {}).result || {}).contents || [];
  const entry = listed[0] && listed[0].resources[0];
  const bytes = Buffer.from(String(body[0] && body[0].text), 'utf8');
  check('mcp skills: resources/read with Mcp-Name gives the SKILL.md whose size and digest skills/list names', r.status === 200 && body.length === 1 && body[0].mimeType === 'text/markdown' && !!entry && bytes.length === entry.size && 'sha256:' + crypto.createHash('sha256').update(bytes).digest('hex') === entry.digest && cors(r), r.status + ' ' + r.text.slice(0, 160));
  r = await post(rpc('resources/read', { uri: 'skill://agent-chat/no-such/SKILL.md' }), heads('resources/read', 'skill://agent-chat/no-such/SKILL.md'), S);
  check('mcp skills: an unknown URI is 200 -32602 with data.uri', r.status === 200 && r.json.error && r.json.error.code === -32602 && r.json.error.message === 'Resource not found: skill://agent-chat/no-such/SKILL.md' && r.json.error.data && r.json.error.data.uri === 'skill://agent-chat/no-such/SKILL.md' && cors(r), r.text.slice(0, 200));
  r = await post(rpc('skills/get', { uri: support }), heads('skills/get'), S);
  check('mcp skills: skills/get of a supporting file is 200 -32602, no skill', !!support && r.status === 200 && r.json.error && r.json.error.code === -32602 && r.json.error.message === 'No skill is served at ' + support && cors(r), r.text.slice(0, 200));
  r = await post(rpc('skills/get', { uri: first }), heads('skills/get'), S);
  check('mcp skills: skills/get of a SKILL.md gives its entry, the one skills/list gives', r.status === 200 && JSON.stringify(r.json.result.skill) === JSON.stringify(listed[0]), r.text.slice(0, 160));
  r = await post(rpc('resources/templates/list'), heads('resources/templates/list'), S);
  check('mcp skills: resources/templates/list is empty', r.status === 200 && JSON.stringify(r.json.result.resourceTemplates) === '[]' && r.json.result.ttlMs === 3600000 && cors(r), r.text.slice(0, 160));
  r = await post(rpc('resources/list'), heads('resources/list'), S);
  check('mcp skills: resources/list lists every file of every skill', r.status === 200 && (r.json.result.resources || []).length === listed.reduce((n, x) => n + x.resources.length, 0) && cors(r), r.text.slice(0, 160));
  r = await post(rpc('resources/directory/read', { uri: 'skill://agent-chat/taking-part' }), heads('resources/directory/read'), S);
  check('mcp skills: resources/directory/read is 404 -32601', r.status === 404 && r.json.error && r.json.error.code === -32601 && r.json.error.message === 'Method not found: resources/directory/read' && cors(r), r.status + ' ' + r.text.slice(0, 160));
  r = await post({ jsonrpc: '2.0', id: 1, method: 'skills/list' }, {}, S);
  check('mcp skills: skills/list over the initialize kind is -32601, as before', r.status === 200 && r.json.error && r.json.error.code === -32601 && r.json.error.message === 'Method not found: skills/list' && cors(r), r.text.slice(0, 160));
  check('mcp skills: none of it opened the invite', (await row('ModSkills')).used === null, JSON.stringify(await row('ModSkills')));

  await req('DELETE', R + '/invites', { owner: true });
  await req('DELETE', R + '?confirm=' + room, { owner: true });
}

module.exports = { mcpModern };
