// The official MCP client libraries against a real local Worker: the
// TypeScript SDK's two lines, as agents' harnesses ship them. v1
// (@modelcontextprotocol/sdk) opens with initialize; v2
// (@modelcontextprotocol/client) does the same by default, probes
// server/discover first in "auto" mode, is answered and stays on revision
// 2026-07-28, and speaks only that revision when pinned to it. What the
// suite's own JSON-RPC calls cannot show is here: that a real client
// connects, negotiates a revision, lists and calls the tools, and is told a
// wrong token's reason; that its SkillsClient lists, gets, reads and verifies
// the skills at each MCP address over 2026-07-28, and sees none over
// initialize; and which headers it sends, the ones CORS must allow a browser
// client.
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
    let rpc = null, tool = null, uri = null;
    try { const b = typeof init.body === 'string' ? JSON.parse(init.body) : null; rpc = b ? b.method : null; tool = b && b.params ? b.params.name : null; uri = b && b.params ? b.params.uri : null; } catch {}
    calls.push({ http: (init && init.method) || 'GET', status: res.status, rpc, tool, uri, version: h.get('mcp-protocol-version'), method: h.get('mcp-method'), name: h.get('mcp-name') });
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
  const { SkillsClient } = load('@modelcontextprotocol/client/ext/skills');

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

  // The skills over revision 2026-07-28, with the client's own SkillsClient
  // (@modelcontextprotocol/client/ext/skills, which checks every entry and
  // verifies each file's size, digest and SKILL.md frontmatter): pinned and in
  // auto mode, each with a fresh agent invite that listing, getting and
  // reading every file leave unused, Mcp-Name sent on every resources/read
  // and on no skills/get; over initialize (v1, v2 by default) no skill is
  // declared; a wrong token connects and is refused the listing.
  let roomSkills = null;
  for (const [what, mode, name] of [['pinned to ' + MODERN, { pin: MODERN }, 'McpSkillsPin'], ['auto', 'auto', 'McpSkillsAuto']]) {
    const T = await invite(name);
    const rec = recorder();
    const client = new v2.Client({ name: 'apitest-v2-skills', version: '0.0.0' }, { versionNegotiation: { mode } });
    const transport = new v2.StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: 'Bearer ' + T } }, fetch: rec.fetchFn });
    const got = await withClient(client, transport, () => readSkills(new SkillsClient(client)));
    const o = got.out || {};
    if (!roomSkills && o.listing) roomSkills = o.listing;
    check('mcp v2 client (skills, ' + what + '): connects, the extension supported, no directoryRead', got.ok && o.supported === true && o.directoryRead === false, said(got));
    check('mcp v2 client (skills, ' + what + '): lists the five skills in order, none invalid, an hour\'s ttlMs, private', JSON.stringify((o.listing || []).map((x) => x.frontmatter.name)) === JSON.stringify(SKILL_NAMES) && o.invalid === 0 && o.ttlMs === 3600000 && o.cacheScope === 'private', JSON.stringify({ names: (o.listing || []).map((x) => x.frontmatter.name), invalid: o.invalid, ttlMs: o.ttlMs, cacheScope: o.cacheScope }));
    check('mcp v2 client (skills, ' + what + '): get of each equals its listed entry', Array.isArray(o.gets) && o.gets.length === 5 && o.gets.every(Boolean), JSON.stringify(o.gets));
    check('mcp v2 client (skills, ' + what + '): every listed file read and verified, each SKILL.md\'s frontmatter equal to its entry\'s', o.read === 22 && o.verified === 22 && o.frontmatter === 5, JSON.stringify({ read: o.read, verified: o.verified, frontmatter: o.frontmatter }));
    const reads = rec.calls.filter((c) => c.rpc === 'resources/read'), gets = rec.calls.filter((c) => c.rpc === 'skills/get');
    check('mcp v2 client (skills, ' + what + '): Mcp-Name on every resources/read (its uri), on no skills/get', reads.length === 22 && reads.every((c) => !!c.uri && c.name === c.uri) && gets.length === 5 && gets.every((c) => c.name === null), JSON.stringify(rec.calls.filter((c) => c.rpc !== 'resources/read').slice(0, 8)).slice(0, 300));
    check('mcp v2 client (skills, ' + what + '): the invite is still unused', ((await row(name)) || {}).used === null, JSON.stringify(await row(name)));
  }
  {
    const T = await invite('McpSkillsOld');
    const a = new v1.Client({ name: 'apitest-v1-skills', version: '0.0.0' });
    const ga = await withClient(a, new v1.Transport(url, { requestInit: { headers: { 'X-Invite-Token': T } } }), async () => a.getServerCapabilities());
    const b = new v2.Client({ name: 'apitest-v2-skills-default', version: '0.0.0' });
    const gb = await withClient(b, new v2.StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: 'Bearer ' + T } } }), async () => {
      const sc = new SkillsClient(b);
      return { caps: b.getServerCapabilities(), supported: sc.supported, listed: (await sc.list()).skills.length };
    });
    check('mcp v1 client (skills): over initialize the capabilities are tools only, no resources, no extensions', ga.ok && JSON.stringify(ga.out) === '{"tools":{}}', said(ga));
    check('mcp v2 client by default (skills): over initialize no resources, no extensions, the SkillsClient not supported and listing nothing', gb.ok && JSON.stringify(gb.out.caps) === '{"tools":{}}' && gb.out.supported === false && gb.out.listed === 0, said(gb));
    const c = new v2.Client({ name: 'apitest-v2-skills-bad', version: '0.0.0' }, { versionNegotiation: { mode: { pin: MODERN } } });
    const gc = await withClient(c, new v2.StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: 'Bearer not-one-of-this-rooms-invites' } } }), async () => {
      const sc = new SkillsClient(c);
      const out = { supported: sc.supported };
      try { await sc.list(); out.listed = true; } catch (e) { out.code = e.code; out.data = e.data; }
      return out;
    });
    check('mcp v2 client (skills, pinned, a wrong token): connects, supported, and the listing is refused -32001 invite_invalid', gc.ok && gc.out.supported === true && gc.out.listed !== true && gc.out.code === -32001 && !!gc.out.data && gc.out.data.code === 'invite_invalid', said(gc));
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
      // the key's skills: the room address's listing, JSON-equal, every file read and verified
      const ks = new v2.Client({ name: 'apitest-v2-key-skills', version: '0.0.0' }, { versionNegotiation: { mode: { pin: MODERN } } });
      const gks = await withClient(ks, new v2.StreamableHTTPClientTransport(agentUrl, { requestInit: { headers } }), () => readSkills(new SkillsClient(ks)));
      check('mcp clients, agent key (skills): the same listing as a room\'s address, every file read and verified', gks.ok && !!roomSkills && JSON.stringify(gks.out.listing) === JSON.stringify(roomSkills) && gks.out.verified === 22 && gks.out.gets.every(Boolean), said(gks));
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

  // ---- The sign-in address and the standing rule, with an OAuth provider set (as Claude Code has one) ----
  // K1 to K8: a client holding a provider signs in only where the sign-in
  // address asks it to (its 401), and nowhere else: a key, no credential
  // and a room's token never meet a 401 or start a sign-in, at the key's
  // address, the sign-in address or a room's own. The approval in the
  // browser is scripted: the authorize page fetched, the person's decide
  // posted, the redirect handed back to the client.
  await signinCases({ req, check, BASE, SUF, v1, v2, url, room, R, SkillsClient, roomSkills });

  await req('DELETE', R + '/invites', { owner: true });
  await req('DELETE', R + '?confirm=' + room, { owner: true });
}

/** The skills in the order skills/list gives them (worker/agents/skills/build.ts SKILL_ORDER). */
const SKILL_NAMES = ['taking-part', 'staying-present', 'playing-games', 'room-board', 'sharing-files'];
/** Through a SkillsClient: whether the server supports the extension, its listing, and, for each
 *  skill, whether get equals the listed entry, and every file read (verified, SKILL.md's frontmatter
 *  checked by the client: it throws on any difference). */
async function readSkills(sc) {
  const out = { supported: sc.supported, directoryRead: sc.directoryRead, gets: [], read: 0, verified: 0, frontmatter: 0 };
  const listing = await sc.list();
  Object.assign(out, { listing: listing.skills, invalid: listing.invalid.length, ttlMs: listing.ttlMs, cacheScope: listing.cacheScope });
  for (const s of listing.skills) {
    out.gets.push(JSON.stringify((await sc.get(s.uri)).skill) === JSON.stringify(s));
    for (const r of s.resources) {
      const f = await sc.read(s, r.uri);
      out.read++;
      if (f.verified) out.verified++;
      if (r.uri === s.uri && f.frontmatter && f.frontmatter.name === s.frontmatter.name) out.frontmatter++;
    }
  }
  return out;
}

async function signinCases(ctx) {
  const { req, check, BASE, SUF, v1, v2, url, room, R, SkillsClient, roomSkills } = ctx;
  // the sign-in's issuer on this local server: its own address (worker/lib/oauth.ts signinOrigin)
  const ORIGIN = String(((await req('GET', '/.well-known/oauth-authorization-server')).json || {}).issuer || '');
  check('mcp clients, sign-in: the issuer is this local server\'s own address', ORIGIN === BASE, ORIGIN + ' ' + BASE);
  const APP = { key: 'apitest-mcpc-public', client_id: 'https://standin.example/apitest/' + SUF + '/mcpc.json', kind: 'public', name: 'Stand-in', host: 'standin.example', redirect_uris: ['http://127.0.0.1/callback'], loopback: true, page: 'agent' };
  const hook = await req('POST', '/api/test-hooks/oauth-app', { owner: true, json: { app: APP } });
  check('mcp clients, sign-in: a stand-in public app on this local server', hook.status === 200, hook.text.slice(0, 120));
  const pat = ((await req('POST', R + '/invites', { owner: true, json: { name: 'PatC', kind: 'human' } })).json || {}).token;
  await req('GET', R + '/messages?limit=1', { token: pat });
  const agentTok = ((await req('POST', R + '/invites', { owner: true, json: { name: 'McpSign', kind: 'agent' } })).json || {}).token;
  const keyMade = await req('POST', '/api/agents', { json: { rooms: [{ room, token: agentTok }] }, headers: { 'CF-Connecting-IP': '10.251.' + (parseInt(SUF, 36) % 200) + '.1' } });
  const KEY = keyMade.json && keyMade.json.key;
  check('mcp clients, sign-in: a key for the key cases', keyMade.status === 201 && !!KEY, keyMade.text.slice(0, 120));
  const signinUrl = new URL(BASE + '/api/mcp/signin'), keyUrl = new URL(BASE + '/api/mcp');
  /** an in-memory OAuth provider, as a client with an auth flow holds one; redirects are recorded */
  const provider = () => {
    let info, tokens, verifier, disc;
    const p = {
      redirects: [],
      get redirectUrl() { return 'http://127.0.0.1:43777/callback'; },
      get clientMetadata() { return { client_name: 'apitest', redirect_uris: ['http://127.0.0.1:43777/callback'], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }; },
      clientMetadataUrl: APP.client_id,
      state: () => 'st-' + Math.random().toString(36).slice(2),
      clientInformation: () => info,
      saveClientInformation: (i) => { info = i; },
      tokens: () => tokens,
      saveTokens: (t) => { tokens = t; },
      redirectToAuthorization: (u) => { p.redirects.push(new URL(String(u))); },
      saveCodeVerifier: (v) => { verifier = v; },
      codeVerifier: () => verifier,
      discoveryState: () => disc,
      saveDiscoveryState: (d) => { disc = d; },
    };
    return p;
  };
  /** the person's approval of an authorize URL in the browser: the page, then decide; the redirect back */
  const approve = async (u) => {
    const page = await req('GET', u.pathname + u.search);
    const d = await req('POST', '/api/oauth/decide', { json: { params: u.search.slice(1), approve: true, name: 'McpOAuth', rooms: [{ room, inviter_token: pat, reuse: 'any' }] }, headers: { 'Sec-Fetch-Site': 'same-origin', 'CF-Connecting-IP': '10.252.' + (parseInt(SUF, 36) % 200) + '.' + Math.floor(Math.random() * 200) } });
    return { page, decide: d, back: d.json && d.json.redirect ? new URL(d.json.redirect) : null };
  };
  const wellKnown = (calls) => calls.filter((c) => c.path.startsWith('/.well-known/'));
  /** a value as JSON for a check's detail, also when there is none (a client that failed to connect) */
  const js = (x) => String(JSON.stringify(x));
  /** a fetch that records each request's method, path, status and Authorization */
  const recorder2 = () => {
    const calls = [];
    const fetchFn = async (input, init) => {
      const res = await fetch(input, init);
      const h = new Headers((init && init.headers) || {});
      calls.push({ http: (init && init.method) || 'GET', path: new URL(String(input instanceof Request ? input.url : input)).pathname, status: res.status, auth: h.get('authorization') });
      return res;
    };
    return { calls, fetchFn };
  };
  for (const [lib, mk] of [
    ['v1', (u, o) => [new v1.Client({ name: 'apitest-v1-oauth', version: '0.0.0' }), new v1.Transport(u, o)]],
    ['v2', (u, o) => [new v2.Client({ name: 'apitest-v2-oauth', version: '0.0.0' }), new v2.StreamableHTTPClientTransport(u, o)]],
  ]) {
    const run = async (u, headers, prov, work) => {
      const rec = recorder2();
      const [client, transport] = mk(u, { authProvider: prov, fetch: rec.fetchFn, requestInit: { headers: headers || {} } });
      let out, error;
      try { await client.connect(transport); out = await work(client); } catch (e) { error = e; }
      try { await client.close(); } catch {}
      return { out, error, calls: rec.calls, transport };
    };
    const listOrCode = async (client) => { try { return { tools: (await client.listTools()).tools.map((t) => t.name) }; } catch (e) { return { code: e.code, data: e.data }; } };
    // K1: the key at /api/mcp
    {
      const p = provider();
      const g = await run(keyUrl, { Authorization: 'Bearer ' + KEY }, p, listOrCode);
      check('mcp ' + lib + ', K1: a key at /api/mcp with a provider: works, every request carries the key, no metadata asked, no sign-in', !g.error && Array.isArray(g.out.tools) && g.calls.length > 0 && g.calls.every((c) => c.auth === 'Bearer ' + KEY) && !wellKnown(g.calls).length && !p.redirects.length && g.calls.every((c) => c.status !== 401), JSON.stringify(g.calls).slice(0, 300) + ' ' + String(g.error && g.error.message));
    }
    // K2: no credential at /api/mcp
    {
      const p = provider();
      const g = await run(keyUrl, {}, p, async (client) => ({ instructions: client.getInstructions(), ...(await listOrCode(client)) }));
      check('mcp ' + lib + ', K2: no credential at /api/mcp: connects (200), tools -32001 agent_key_missing, no metadata, no sign-in', !g.error && /no agent key/.test(g.out.instructions || '') && g.out.code === -32001 && g.out.data && g.out.data.code === 'agent_key_missing' && !wellKnown(g.calls).length && !p.redirects.length && g.calls.every((c) => c.status !== 401), js(g.out).slice(0, 200) + ' ' + JSON.stringify(g.calls).slice(0, 200));
    }
    // K5 then K3: no credential at the sign-in address: 401, the metadata, the authorize redirect; approved, it signs in and lists tools
    const signed = provider();
    {
      const g = await run(signinUrl, {}, signed, listOrCode);
      const paths = g.calls.map((c) => c.path);
      check('mcp ' + lib + ', K5: no credential at /api/mcp/signin: 401, then its metadata and the issuer\'s, then the authorize page', !!g.error && g.calls.length > 0 && g.calls[0].status === 401 && paths.includes('/.well-known/oauth-protected-resource/api/mcp/signin') && paths.includes('/.well-known/oauth-authorization-server') && signed.redirects.length === 1 && signed.redirects[0].pathname === '/oauth/authorize', JSON.stringify(paths) + ' ' + String(g.error && g.error.message));
      const u = signed.redirects[0];
      check('mcp ' + lib + ', K5: the authorize request names the app, PKCE S256, the sign-in address as resource', !!u && u.searchParams.get('client_id') === APP.client_id && u.searchParams.get('code_challenge_method') === 'S256' && u.searchParams.get('resource') === ORIGIN + '/api/mcp/signin', u && u.search);
      if (u) {
        const a = await approve(u);
        check('mcp ' + lib + ', K3: the page is served and the approval redirects back with the code', a.page.status === 200 && !!a.back && !!a.back.searchParams.get('code') && a.back.searchParams.get('iss') === ORIGIN, a.decide.status + ' ' + a.decide.text.slice(0, 160));
        if (a.back) {
          try { await g.transport.finishAuth(lib === 'v1' ? a.back.searchParams.get('code') : a.back.searchParams); } catch (e) { check('mcp ' + lib + ', K3: the code exchange', false, String(e && e.message)); }
          const g2 = await run(signinUrl, {}, signed, async (client) => ({ server: client.getServerVersion(), ...(await listOrCode(client)) }));
          // signed in, the skills: the room address's listing, JSON-equal, every file read and verified
          if (lib === 'v2') {
            const sk = new v2.Client({ name: 'apitest-v2-oauth-skills', version: '0.0.0' }, { versionNegotiation: { mode: { pin: MODERN } } });
            let gs;
            try { await sk.connect(new v2.StreamableHTTPClientTransport(signinUrl, { authProvider: signed })); gs = { ok: true, out: await readSkills(new SkillsClient(sk)) }; } catch (e) { gs = { ok: false, error: e }; }
            try { await sk.close(); } catch {}
            check('mcp v2, K3 (skills): signed in at /api/mcp/signin, the same listing as a room\'s address, every file read and verified', gs.ok && !!roomSkills && JSON.stringify(gs.out.listing) === JSON.stringify(roomSkills) && gs.out.verified === 22 && gs.out.gets.every(Boolean), gs.ok ? JSON.stringify(gs.out.listing).slice(0, 200) : String(gs.error && gs.error.message));
          }
          check('mcp ' + lib + ', K3: signed in: the sign-in server, its tools listed, no add_room', !g2.error && g2.out.server && g2.out.server.name === 'agent-chat-signin' && Array.isArray(g2.out.tools) && g2.out.tools.includes('list_rooms') && !g2.out.tools.includes('add_room') && g2.calls.every((c) => c.status !== 401), js(g2.out).slice(0, 200) + ' ' + String(g2.error && g2.error.message));
          // K4: the same provider, its tokens for the sign-in address, at /api/mcp beside a key header. v2 sends
          // the provider's token in place of the key, which the key's address refuses in band; v1 keeps the
          // configured header, so the key works. Either way: 200, never 401, no metadata asked, no sign-in.
          const g4 = await run(keyUrl, { Authorization: 'Bearer ' + KEY }, signed, listOrCode);
          const sent = g4.calls.filter((c) => c.http === 'POST').map((c) => c.auth);
          const answered = lib === 'v2'
            ? sent.every((x) => /^Bearer \.ao1\./.test(x || '')) && g4.out && g4.out.code === -32001 && g4.out.data && g4.out.data.code === 'agent_key_invalid'
            : sent.every((x) => x === 'Bearer ' + KEY) && g4.out && Array.isArray(g4.out.tools);
          check('mcp ' + lib + ', K4: a provider holding the sign-in\'s tokens at /api/mcp with a key header: 200, never 401, no metadata asked, no sign-in; ' + (lib === 'v2' ? 'its token in place of the key, refused in band (agent_key_invalid)' : 'the key kept, which works'), g4.calls.length > 0 && g4.calls.every((c) => c.status === 200 || c.status === 202 || c.status === 405) && !wellKnown(g4.calls).length && signed.redirects.length === 1 && answered, JSON.stringify(g4.calls.map((c) => [c.http, c.status, (c.auth || '').slice(0, 12)])) + ' ' + js(g4.out).slice(0, 120));
        }
      }
    }
    // K6: the key at the sign-in address
    {
      const p = provider();
      const g = await run(signinUrl, { Authorization: 'Bearer ' + KEY }, p, listOrCode);
      check('mcp ' + lib + ', K6: a key at /api/mcp/signin: 200 wrong_address, no sign-in', !g.error && g.out.code === -32001 && g.out.data && g.out.data.code === 'wrong_address' && !p.redirects.length && !wellKnown(g.calls).length && g.calls.every((c) => c.status !== 401), JSON.stringify(g.out) + ' ' + JSON.stringify(g.calls).slice(0, 200));
    }
    // K7, K8: a room's own address, with its token and with none
    for (const [k, headers] of [['K7', { 'X-Invite-Token': agentTok }], ['K8', {}]]) {
      const p = provider();
      const g = await run(url, headers, p, listOrCode);
      const ok = k === 'K7' ? Array.isArray(g.out && g.out.tools) : !!g.out && g.out.code === -32001;
      check('mcp ' + lib + ', ' + k + ': a room\'s own address (' + (k === 'K7' ? 'its token' : 'no credential') + '): 200, in band, no metadata, no sign-in', !g.error && ok && !wellKnown(g.calls).length && !p.redirects.length && g.calls.every((c) => c.status !== 401), js(g.out).slice(0, 160) + ' ' + JSON.stringify(g.calls).slice(0, 200));
    }
  }
  await req('DELETE', '/api/agent', { headers: { Authorization: 'Bearer ' + KEY } });
  await req('POST', '/api/test-hooks/oauth-app', { owner: true, json: { clear: true } });
}

module.exports = { mcpClients };
