// The official MCP client libraries against a real local Worker: the
// TypeScript SDK's two lines, as agents' harnesses ship them. v1
// (@modelcontextprotocol/sdk) opens with initialize; v2
// (@modelcontextprotocol/client) does the same by default, probes
// server/discover first in "auto" mode, is answered and stays on revision
// 2026-07-28, and speaks only that revision when pinned to it. What the
// suite's own JSON-RPC calls cannot show is here: that a real client
// connects, negotiates a revision, lists and calls the tools, and is told a
// wrong token's reason; and which headers it sends, the ones CORS must
// allow a browser client.
// The libraries live in tests/mcp-clients (its own package, so the deploy
// build installs none of them): npm ci --prefix tests/mcp-clients.
// Called from api.test.js; its room is its own.
'use strict';
const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');

const DIR = path.join(__dirname, '..', 'mcp-clients');
/** The newest revision that opens with initialize (worker/agents/mcp.ts
 *  MCP_PROTOCOL_VERSIONS[0]), and the one after it, which does not. */
const NEWEST_LEGACY = '2025-11-25', MODERN = '2026-07-28';

/** a fetch that records each request's method, status and MCP headers */
function recorder() {
  const calls = [];
  const fetchFn = async (input, init) => {
    const res = await fetch(input, init);
    const h = new Headers((init && init.headers) || {});
    let rpc = null, tool = null;
    try { const b = typeof init.body === 'string' ? JSON.parse(init.body) : null; rpc = b ? b.method : null; tool = b && b.params ? b.params.name : null; } catch {}
    calls.push({ http: (init && init.method) || 'GET', status: res.status, rpc, tool, version: h.get('mcp-protocol-version'), method: h.get('mcp-method'), name: h.get('mcp-name') });
    return res;
  };
  return { calls, fetchFn };
}

async function mcpClients(ctx) {
  const { req, check, BASE, SUF } = ctx;
  // the installed libraries are the pinned ones: a missing or stale install fails here, by name
  const pins = JSON.parse(fs.readFileSync(path.join(DIR, 'package.json'), 'utf8')).dependencies;
  const installed = (name) => { try { return JSON.parse(fs.readFileSync(path.join(DIR, 'node_modules', name, 'package.json'), 'utf8')).version; } catch { return null; } };
  const stale = Object.keys(pins).filter((name) => installed(name) !== pins[name]);
  check('mcp clients: the pinned client libraries are installed (run: npm ci --prefix tests/mcp-clients)', stale.length === 0, stale.map((name) => name + ' ' + installed(name) + ', pinned ' + pins[name]).join('; '));
  if (stale.length) return;
  const load = createRequire(path.join(DIR, 'package.json'));
  const v1 = { Client: load('@modelcontextprotocol/sdk/client/index.js').Client, Transport: load('@modelcontextprotocol/sdk/client/streamableHttp.js').StreamableHTTPClientTransport, latest: load('@modelcontextprotocol/sdk/types.js').LATEST_PROTOCOL_VERSION };
  const v2 = load('@modelcontextprotocol/client');

  const room = 'apitest-mcpc-' + SUF, R = '/api/rooms/' + room;
  let r = await req('POST', R, { owner: true });
  check('mcp clients: the room is created', r.status === 201, r.status);
  const invite = async (name) => ((await req('POST', R + '/invites', { owner: true, json: { name, kind: 'agent' } })).json || {}).token;
  const T1 = await invite('McpOne'), T2 = await invite('McpTwo'), T3 = await invite('McpThree');
  r = await req('POST', R + '/mcp', { token: T1, json: { jsonrpc: '2.0', id: 1, method: 'tools/list' } });
  /** the catalog's tool names, as the endpoint lists them */
  const listed = (((r.json || {}).result || {}).tools || []).map((t) => t.name);
  check('mcp clients: three agent invites and the catalog are there', !!T1 && !!T2 && !!T3 && listed.length > 0, r.status + ' ' + listed.length);
  if (!T1 || !T2 || !T3 || !listed.length) return;
  const url = new URL(BASE + R + '/mcp');
  /** the room's invite row for that name, as the owner's list shows it */
  const row = async (name) => ((await req('GET', R + '/invites', { owner: true })).json.invites || []).find((i) => i.name === name);
  /** connect, run, close; a failure is returned, not thrown */
  const withClient = async (client, transport, run) => {
    try { await client.connect(transport); const out = await run(); await client.close(); return { ok: true, out }; }
    catch (e) { try { await client.close(); } catch {} return { ok: false, error: e }; }
  };
  const said = (x) => (x.ok ? JSON.stringify(x.out) : String(x.error && x.error.message)).slice(0, 240);

  // v1, the token in X-Invite-Token: the whole first hour of a tools client
  {
    const rec = recorder();
    const client = new v1.Client({ name: 'apitest-v1', version: '0.0.0' });
    const transport = new v1.Transport(url, { requestInit: { headers: { 'X-Invite-Token': T1 } }, fetch: rec.fetchFn });
    const got = await withClient(client, transport, async () => {
      const out = { version: transport.protocolVersion, server: client.getServerVersion(), instructions: client.getInstructions() };
      out.tools = (await client.listTools()).tools.map((t) => t.name);
      out.page = (await client.callTool({ name: 'get_start_page', arguments: {} })).content[0].text;
      out.look = (await client.callTool({ name: 'get_invite', arguments: {} })).structuredContent;
      out.unused = ((await row('McpOne')) || {}).used === null;
      out.who = (await client.callTool({ name: 'whoami', arguments: {} })).structuredContent;
      out.post = await client.callTool({ name: 'post_message', arguments: { text: 'hello from the v1 client', client_msg_id: 'mcpc-v1-' + SUF } });
      out.read = (await client.callTool({ name: 'list_messages', arguments: {} })).structuredContent;
      out.bad = await client.callTool({ name: 'post_message', arguments: {} });
      return out;
    });
    const o = got.out || {};
    check('mcp v1 client: connects and runs every step', got.ok, said(got));
    check('mcp v1 client: its newest revision is one the server speaks, and is the one negotiated', v1.latest === NEWEST_LEGACY && o.version === NEWEST_LEGACY, v1.latest + ' ' + o.version);
    check('mcp v1 client: serverInfo and the instructions arrive', !!o.server && o.server.name === 'agent-chat' && /^One Agent Chat room as tools\. Call get_start_page first/.test(o.instructions || ''), JSON.stringify(o.server) + ' ' + String(o.instructions).slice(0, 80));
    check('mcp v1 client: tools/list gives the whole catalog, in the server\'s order', Array.isArray(o.tools) && o.tools.length === listed.length && o.tools.join() === listed.join() && o.tools.includes('get_start_page'), (o.tools || []).length + ' of ' + listed.length);
    check('mcp v1 client: get_start_page is the page\'s text', String(o.page).startsWith('Agent Chat start page: "McpOne" in the room "' + room + '"'), String(o.page).slice(0, 80));
    check('mcp v1 client: connecting, listing, the page and get_invite joined nothing', o.unused === true && !!o.look && o.look.invite.status === 'unused' && !('agent_onboarding' in o.look), JSON.stringify(o.look).slice(0, 160));
    check('mcp v1 client: whoami joins and answers structuredContent', !!o.who && o.who.name === 'McpOne' && o.who.status === 'active', JSON.stringify(o.who).slice(0, 160));
    check('mcp v1 client: a post goes through and a read returns it', !!o.post && !o.post.isError && !!o.read && o.read.messages.some((m) => m.text === 'hello from the v1 client' && m.from === 'McpOne'), JSON.stringify(o.post).slice(0, 160));
    check('mcp v1 client: a tool\'s refusal is a tool error (isError), not a thrown protocol error', !!o.bad && o.bad.isError === true && /text/.test(o.bad.content[0].text), JSON.stringify(o.bad).slice(0, 160));
    // what a browser client's preflight must be allowed: the version header on every request after initialize
    const init = rec.calls.find((c) => c.rpc === 'initialize'), after = rec.calls.filter((c) => c.rpc && c.rpc !== 'initialize');
    check('mcp v1 client: initialize carries no MCP-Protocol-Version, every later request the negotiated one', !!init && init.version === null && after.length >= 8 && after.every((c) => c.version === NEWEST_LEGACY), JSON.stringify(rec.calls).slice(0, 300));
    const stream = rec.calls.find((c) => c.http === 'GET');
    check('mcp v1 client: if its GET for a server stream was sent, it was answered 405 (none offered)', !stream || stream.status === 405, JSON.stringify(stream));
  }

  // v1 with a token that is no invite: initialize answers anyone and says why no tool will work
  {
    const client = new v1.Client({ name: 'apitest-v1-bad', version: '0.0.0' });
    const transport = new v1.Transport(url, { requestInit: { headers: { 'X-Invite-Token': 'not-one-of-this-rooms-invites' } } });
    const got = await withClient(client, transport, async () => {
      const out = { instructions: client.getInstructions() };
      try { await client.listTools(); out.listed = true; } catch (e) { out.code = e.code; out.data = e.data; out.message = e.message; }
      return out;
    });
    const o = got.out || {};
    check('mcp v1 client: a wrong token still connects, and the instructions say it is not this room\'s', got.ok && /not one of this room's \(invite_invalid\)/.test(o.instructions || ''), said(got));
    check('mcp v1 client: its tools/list is refused -32001 with data.code invite_invalid', o.listed !== true && o.code === -32001 && !!o.data && o.data.code === 'invite_invalid', JSON.stringify(o).slice(0, 200));
  }

  // v2, the token as Authorization: Bearer: by default (initialize with its
  // newest revision), offering one older revision only (answered as asked),
  // and offering first a revision the endpoint does not speak beside one it
  // does (answered the endpoint's newest, which the client accepts: an echo
  // of the unknown one would be negotiated instead)
  const cases = [
    ['default', undefined, NEWEST_LEGACY],
    ['offering 2025-06-18 only', { supportedProtocolVersions: ['2025-06-18'] }, '2025-06-18'],
    ['offering 2024-10-07 first, then ' + NEWEST_LEGACY, { supportedProtocolVersions: ['2024-10-07', NEWEST_LEGACY] }, NEWEST_LEGACY],
  ];
  for (const [what, options, want] of cases) {
    const client = new v2.Client({ name: 'apitest-v2', version: '0.0.0' }, options);
    const transport = new v2.StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: 'Bearer ' + T2 } } });
    const got = await withClient(client, transport, async () => ({
      era: client.getProtocolEra(), version: transport.protocolVersion,
      tools: (await client.listTools()).tools.length,
      page: (await client.callTool({ name: 'get_start_page', arguments: {} })).content[0].text,
    }));
    const o = got.out || {};
    check('mcp v2 client (' + what + '): connects over initialize with a Bearer token and negotiates ' + want, got.ok && o.era === 'legacy' && o.version === want, said(got));
    check('mcp v2 client (' + what + '): lists the tools and reads its start page', o.tools === listed.length && String(o.page).startsWith('Agent Chat start page: "McpTwo"'), o.tools + ' ' + String(o.page).slice(0, 60));
  }

  // v2 offering only a revision the endpoint does not speak: it is answered
  // the endpoint's newest, which it does not speak, and gives up
  {
    const client = new v2.Client({ name: 'apitest-v2-old', version: '0.0.0' }, { supportedProtocolVersions: ['2024-10-07'] });
    const transport = new v2.StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: 'Bearer ' + T2 } } });
    const got = await withClient(client, transport, async () => ({ version: transport.protocolVersion }));
    check('mcp v2 client (offering 2024-10-07 only): told ' + NEWEST_LEGACY + ', it disconnects', !got.ok && /protocol version is not supported/i.test(String(got.error && got.error.message)), said(got));
  }

  // v2 in auto mode: the server/discover probe is answered, and the client
  // stays on revision 2026-07-28: no initialize, no GET, and every request
  // names the revision and its method (and, on tools/call, its tool) in the
  // headers a browser client's preflight must be allowed
  {
    const rec = recorder();
    const client = new v2.Client({ name: 'apitest-v2-auto', version: '0.0.0' }, { versionNegotiation: { mode: 'auto' } });
    const transport = new v2.StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: 'Bearer ' + T3 } }, fetch: rec.fetchFn });
    const got = await withClient(client, transport, async () => ({
      era: client.getProtocolEra(), version: transport.protocolVersion,
      tools: (await client.listTools()).tools.map((t) => t.name),
      who: (await client.callTool({ name: 'whoami', arguments: {} })).structuredContent,
    }));
    const o = got.out || {};
    const probe = rec.calls.find((c) => c.rpc === 'server/discover');
    check('mcp v2 client (auto): its probe carries MCP-Protocol-Version ' + MODERN + ' and Mcp-Method', !!probe && probe.version === MODERN && probe.method === 'server/discover', JSON.stringify(probe));
    check('mcp v2 client (auto): stays on ' + MODERN + ' and works', got.ok && o.era === 'modern' && o.version === MODERN && Array.isArray(o.tools) && o.tools.join() === listed.join() && !!o.who && o.who.name === 'McpThree', said(got));
    check('mcp v2 client (auto): sends no initialize and no GET', rec.calls.length >= 3 && !rec.calls.some((c) => c.rpc === 'initialize' || c.http === 'GET'), JSON.stringify(rec.calls).slice(0, 300));
    check('mcp v2 client (auto): every request names ' + MODERN + ' and its method, every tools/call its tool', rec.calls.every((c) => c.version === MODERN && c.method === c.rpc) && rec.calls.filter((c) => c.rpc === 'tools/call').every((c) => !!c.tool && c.name === c.tool), JSON.stringify(rec.calls).slice(0, 300));
  }

  // v2 pinned to 2026-07-28, a fresh agent invite: it connects, reads the
  // server from server/discover, lists the catalog with its titles, looks
  // without joining (get_start_page, get_invite, an unknown tool), then
  // joins with whoami; a tool's refusal is still a tool error
  {
    const T4 = await invite('McpFour');
    const ORIGIN = String(((await req('GET', '/api/changes')).json || {}).url || '').replace(/\/api\/changes$/, '');
    const raw = ((await req('POST', R + '/mcp', { token: T1, json: { jsonrpc: '2.0', id: 1, method: 'tools/list' } })).json || {}).result || {};
    const client = new v2.Client({ name: 'apitest-v2-pin', version: '0.0.0' }, { versionNegotiation: { mode: { pin: MODERN } } });
    const transport = new v2.StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: 'Bearer ' + T4 } } });
    const got = await withClient(client, transport, async () => {
      const out = { era: client.getProtocolEra(), server: client.getServerVersion(), instructions: client.getInstructions() };
      out.tools = (await client.listTools()).tools;
      out.page = (await client.callTool({ name: 'get_start_page', arguments: {} })).content[0].text;
      out.look = (await client.callTool({ name: 'get_invite', arguments: {} })).structuredContent;
      try { await client.callTool({ name: 'no_such_tool', arguments: {} }); out.unknown = 'returned'; } catch (e) { out.unknown = e.code; }
      out.unused = ((await row('McpFour')) || {}).used === null;
      out.who = (await client.callTool({ name: 'whoami', arguments: {} })).structuredContent;
      out.bad = await client.callTool({ name: 'post_message', arguments: {} });
      return out;
    });
    const o = got.out || {};
    check('mcp v2 client (pinned to ' + MODERN + '): connects', got.ok && o.era === 'modern', said(got));
    check('mcp v2 client (pinned): the server, from server/discover\'s _meta', JSON.stringify(o.server) === JSON.stringify({ name: 'agent-chat', title: 'Agent Chat', version: raw.catalog && raw.catalog.version, websiteUrl: ORIGIN }), JSON.stringify(o.server));
    check('mcp v2 client (pinned): the instructions, from server/discover', /^One Agent Chat room as tools\. Call get_start_page first/.test(o.instructions || ''), String(o.instructions).slice(0, 80));
    check('mcp v2 client (pinned): listTools gives the catalog in the server\'s order, each tool with a title', Array.isArray(o.tools) && o.tools.map((t) => t.name).join() === (raw.tools || []).map((t) => t.name).join() && o.tools.every((t) => typeof t.title === 'string' && t.title.length > 0), (o.tools || []).length + ' of ' + (raw.tools || []).length);
    check('mcp v2 client (pinned): get_start_page is the page\'s text', String(o.page).startsWith('Agent Chat start page: "McpFour"'), String(o.page).slice(0, 80));
    check('mcp v2 client (pinned): an unknown tool rejects with -32602, and with get_invite it left the invite unused', o.unknown === -32602 && o.unused === true && !!o.look && o.look.invite.status === 'unused', JSON.stringify({ unknown: o.unknown, unused: o.unused }));
    check('mcp v2 client (pinned): whoami joins', !!o.who && o.who.name === 'McpFour' && o.who.status === 'active', JSON.stringify(o.who).slice(0, 160));
    check('mcp v2 client (pinned): a tool\'s refusal is a tool error (isError)', !!o.bad && o.bad.isError === true, JSON.stringify(o.bad).slice(0, 160));
  }

  // v2 pinned with a wrong token and with none: it still connects (server/discover
  // answers anyone, saying why no tool will work), and tools/list is refused
  // -32001 with data.code and the endpoint's sentence
  {
    const startInvalid = ((await req('GET', R, { token: 'not-one-of-this-rooms-invites' })).json || {}).error;
    for (const [what, headers, code] of [['a wrong token', { Authorization: 'Bearer not-one-of-this-rooms-invites' }, 'invite_invalid'], ['no token', {}, 'invite_missing']]) {
      const client = new v2.Client({ name: 'apitest-v2-pin-bad', version: '0.0.0' }, { versionNegotiation: { mode: { pin: MODERN } } });
      const transport = new v2.StreamableHTTPClientTransport(url, { requestInit: { headers } });
      const got = await withClient(client, transport, async () => {
        const out = { era: client.getProtocolEra(), instructions: client.getInstructions() };
        try { await client.listTools(); out.listed = true; } catch (e) { out.code = e.code; out.data = e.data; out.message = e.message; }
        return out;
      });
      const o = got.out || {};
      check('mcp v2 client (pinned, ' + what + '): connects over ' + MODERN, got.ok && o.era === 'modern' && (code !== 'invite_invalid' || /\(invite_invalid\)/.test(o.instructions || '')), said(got));
      check('mcp v2 client (pinned, ' + what + '): listTools rejects with -32001 and data.code ' + code, o.listed !== true && o.code === -32001 && !!o.data && o.data.code === code && (code !== 'invite_invalid' || (!!startInvalid && String(o.message).includes(startInvalid))), JSON.stringify(o).slice(0, 240));
    }
  }

  // The agent key's address, POST /api/mcp, with each library: a key from
  // two rooms' agent invites (this room's and one of its own), sent as
  // Authorization: Bearer. v1 and v2 by default open with initialize, v2
  // in auto mode probes server/discover and stays on 2026-07-28, and v2
  // pinned speaks only it; each connects, lists tools with room on every
  // room tool, lists its rooms and posts in one. A room the key holds whose
  // invite is revoked is a tool error (isError) with structuredContent.code;
  // a wrong key rejects with -32001 agent_key_invalid; and one response
  // cache store shared by a room's address and the agent address keeps each
  // address's own list (the two servers' names differ).
  {
    const room2 = 'apitest-mcpk-' + SUF, R2 = '/api/rooms/' + room2;
    r = await req('POST', R2, { owner: true });
    const K1 = await invite('McpKeyed');
    const K2 = ((await req('POST', R2 + '/invites', { owner: true, json: { name: 'McpKeyed', kind: 'agent' } })).json || {}).token;
    const made = await req('POST', '/api/agents', { json: { rooms: [{ room, token: K1 }, { room: room2, token: K2 }] }, headers: { 'CF-Connecting-IP': '10.250.' + (parseInt(SUF, 36) % 200) + '.1' } });
    const KEY = made.json && made.json.key;
    check('mcp clients, agent key: a key from two rooms\' agent invites', r.status === 201 && made.status === 201 && !!KEY, made.status + ' ' + made.text.slice(0, 120));
    if (KEY) {
      const agentUrl = new URL(BASE + '/api/mcp');
      const headers = { Authorization: 'Bearer ' + KEY };
      const run = async (client, transport) => withClient(client, transport, async () => {
        const out = { era: client.getProtocolEra ? client.getProtocolEra() : 'legacy', server: client.getServerVersion(), instructions: client.getInstructions() };
        const tools = (await client.listTools()).tools;
        out.tools = tools.length;
        out.roomFirst = tools.filter((t) => !['list_rooms', 'whats_waiting', 'add_room', 'remove_room', 'muse_register'].includes(t.name)).every((t) => Object.keys(t.inputSchema.properties)[0] === 'room' && t.inputSchema.required[0] === 'room');
        out.museRegister = tools.some((t) => t.name === 'muse_register' && JSON.stringify(t.inputSchema.required) === '["code"]');
        out.rooms = (await client.callTool({ name: 'list_rooms', arguments: {} })).structuredContent.rooms.map((x) => x.room);
        out.post = await client.callTool({ name: 'post_message', arguments: { room: room2, text: 'hello through the key' } });
        return out;
      });
      const v1run = await run(new v1.Client({ name: 'apitest-v1-key', version: '0.0.0' }), new v1.Transport(agentUrl, { requestInit: { headers } }));
      const v2def = await run(new v2.Client({ name: 'apitest-v2-key', version: '0.0.0' }), new v2.StreamableHTTPClientTransport(agentUrl, { requestInit: { headers } }));
      const v2auto = await run(new v2.Client({ name: 'apitest-v2-key-auto', version: '0.0.0' }, { versionNegotiation: { mode: 'auto' } }), new v2.StreamableHTTPClientTransport(agentUrl, { requestInit: { headers } }));
      const v2pin = await run(new v2.Client({ name: 'apitest-v2-key-pin', version: '0.0.0' }, { versionNegotiation: { mode: { pin: MODERN } } }), new v2.StreamableHTTPClientTransport(agentUrl, { requestInit: { headers } }));
      for (const [what, got, era] of [['v1', v1run, 'legacy'], ['v2 default', v2def, 'legacy'], ['v2 auto', v2auto, 'modern'], ['v2 pinned to ' + MODERN, v2pin, 'modern']]) {
        const o = got.out || {};
        check('mcp clients, agent key (' + what + '): connects to /api/mcp and is told it is the agent server', got.ok && o.era === era && !!o.server && o.server.name === 'agent-chat-agent' && /^All your Agent Chat rooms as tools, through your agent key\./.test(o.instructions || ''), said(got));
        check('mcp clients, agent key (' + what + '): lists the tools, room first on every room tool, and its rooms', o.tools === listed.length + 5 && o.roomFirst === true && JSON.stringify(o.rooms) === JSON.stringify([room, room2]), JSON.stringify({ tools: o.tools, roomFirst: o.roomFirst, rooms: o.rooms }));
        check('mcp clients, agent key (' + what + '): lists muse_register, which takes code', o.museRegister === true, JSON.stringify({ museRegister: o.museRegister }));
        check('mcp clients, agent key (' + what + '): post_message {room} goes through', !!o.post && !o.post.isError, JSON.stringify(o.post).slice(0, 160));
      }
      // a revoked room through the key: a tool error with the code, from both libraries
      await req('DELETE', R2 + '/invites/' + K2, { owner: true });
      for (const [what, client, transport] of [
        ['v1', new v1.Client({ name: 'apitest-v1-key-rev', version: '0.0.0' }), new v1.Transport(agentUrl, { requestInit: { headers } })],
        ['v2 pinned', new v2.Client({ name: 'apitest-v2-key-rev', version: '0.0.0' }, { versionNegotiation: { mode: { pin: MODERN } } }), new v2.StreamableHTTPClientTransport(agentUrl, { requestInit: { headers } })],
      ]) {
        const got = await withClient(client, transport, async () => client.callTool({ name: 'whoami', arguments: { room: room2 } }));
        check('mcp clients, agent key (' + what + '): a revoked room\'s call returns isError with structuredContent.code invite_revoked', got.ok && got.out.isError === true && got.out.structuredContent.code === 'invite_revoked' && got.out.structuredContent.room === room2, said(got));
      }
      // a wrong key: connecting works, listing rejects with -32001 agent_key_invalid
      const fake = '.ac1.' + 'A'.repeat(22) + '.' + 'A'.repeat(43);
      for (const [what, client, transport] of [
        ['v1', new v1.Client({ name: 'apitest-v1-key-bad', version: '0.0.0' }), new v1.Transport(agentUrl, { requestInit: { headers: { Authorization: 'Bearer ' + fake } } })],
        ['v2 pinned', new v2.Client({ name: 'apitest-v2-key-bad', version: '0.0.0' }, { versionNegotiation: { mode: { pin: MODERN } } }), new v2.StreamableHTTPClientTransport(agentUrl, { requestInit: { headers: { Authorization: 'Bearer ' + fake } } })],
      ]) {
        const got = await withClient(client, transport, async () => { try { await client.listTools(); return { listed: true }; } catch (e) { return { code: e.code, data: e.data }; } });
        check('mcp clients, agent key (' + what + '): a wrong key rejects with -32001 agent_key_invalid', got.ok && got.out.code === -32001 && !!got.out.data && got.out.data.code === 'agent_key_invalid', said(got));
      }
      // one response cache store across a room's address and the agent address
      const store = new v2.InMemoryResponseCacheStore();
      const a = new v2.Client({ name: 'apitest-v2-cache-room', version: '0.0.0' }, { versionNegotiation: { mode: { pin: MODERN } }, responseCacheStore: store });
      const ga = await withClient(a, new v2.StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: 'Bearer ' + T1 } } }), async () => (await a.listTools()).tools.map((t) => t.name));
      const b = new v2.Client({ name: 'apitest-v2-cache-agent', version: '0.0.0' }, { versionNegotiation: { mode: { pin: MODERN } }, responseCacheStore: store });
      const gb = await withClient(b, new v2.StreamableHTTPClientTransport(agentUrl, { requestInit: { headers } }), async () => (await b.listTools()).tools.map((t) => t.name));
      check('mcp clients, agent key: one shared response cache gives each address its own list', ga.ok && gb.ok && !ga.out.includes('list_rooms') && gb.out.includes('list_rooms') && gb.out.length === ga.out.length + 5, JSON.stringify({ room: ga.ok && ga.out.length, agent: gb.ok && gb.out.length }));
      await req('DELETE', '/api/agent', { headers });
    }
    await req('DELETE', R2 + '/invites', { owner: true });
    await req('DELETE', R2 + '?confirm=' + room2, { owner: true });
  }

  await req('DELETE', R + '/invites', { owner: true });
  await req('DELETE', R + '?confirm=' + room, { owner: true });
}

module.exports = { mcpClients };
