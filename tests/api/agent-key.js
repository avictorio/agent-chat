// The agent key against a real local Worker (worker/routes/agent.ts): a key
// made from two rooms' agent invites, its rooms listed, a post in each
// through POST /api/mcp read back over REST with the rooms' own tokens, the
// owner's members list unchanged in shape, a revoke and a leave refused at
// the next call through the key while the other room goes on, a room added
// and removed, the key disconnected with every seat kept, the creation caps
// (the per-room one at its constant, the others lowered by a test hook on
// this local server only), the tokenless limits, and whats_waiting's time
// over AGENT_ROOMS_MAX throwaway rooms. Called from api.test.js; its rooms
// are its own (apitest-agent-*), deleted at the end. Every key and token is
// made here, and none is printed.
'use strict';

const NEW = '2026-07-28';
const V = 'io.modelcontextprotocol/protocolVersion', C = 'io.modelcontextprotocol/clientCapabilities';

async function agentKey(ctx) {
  const { req, check, SUF, IPO } = ctx;
  const made = [];
  const room = async (tag) => {
    const name = 'apitest-agent-' + SUF + '-' + tag;
    const r = await req('POST', '/api/rooms/' + name, { owner: true });
    if (r.status === 201) made.push(name);
    return name;
  };
  const invite = async (name, who, kind) => ((await req('POST', '/api/rooms/' + name + '/invites', { owner: true, json: { name: who, kind: kind || 'agent' } })).json || {}).token;
  const bearer = (key) => ({ Authorization: 'Bearer ' + key });
  let ipn = 0;
  const ip = () => IPO.replace(/\.0\.$/, '.') + '9.' + (++ipn);
  const create = (rooms, headers) => req('POST', '/api/agents', { json: { rooms }, headers: Object.assign({ 'CF-Connecting-IP': ip() }, headers || {}) });
  const rpc = (key, body, headers) => req('POST', '/api/mcp', { json: body, headers: Object.assign(key ? bearer(key) : {}, headers || {}) });
  const tool = async (key, name, args) => ((await rpc(key, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })).json || {});
  const ORIGIN = String(((await req('GET', '/api/changes')).json || {}).url || '').replace(/\/api\/changes$/, '');
  // the caps and the most rooms, from limits.ts (the unit tests' module hooks load it)
  const LIM = await import('../../worker/limits.ts');

  try {
    // two rooms, an agent invite in each
    const A = await room('a'), B = await room('b');
    const TA = await invite(A, 'Keyed'), TB = await invite(B, 'Keyed');
    check('agent key: two rooms, an agent invite in each', made.length === 2 && !!TA && !!TB, made.length);
    let r = await create([{ room: A, token: TA }, { room: B, token: TB }]);
    const KEY = r.json && r.json.key;
    check('agent key: POST /api/agents makes a key, 201 with its fields', r.status === 201 && JSON.stringify(Object.keys(r.json || {})) === JSON.stringify(['key', 'address', 'rooms', 'max_rooms', 'claude_code', 'note']) && /^\.ac1\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/.test(KEY || ''), r.status + ' ' + JSON.stringify(Object.keys(r.json || {})));
    check('agent key: the answer names the address and the rooms, and holds the key once and no token', r.json.address === ORIGIN + '/api/mcp' && JSON.stringify(r.json.rooms) === JSON.stringify([{ room: A, name: 'Keyed', opened: false }, { room: B, name: 'Keyed', opened: false }]) && r.text.split(KEY).length === 2 && !r.text.includes(TA) && !r.text.includes(TB) && r.headers.get('cache-control') === 'no-store', JSON.stringify(r.json.rooms));
    if (!KEY) return;
    r = await req('GET', '/api/agent', { headers: bearer(KEY) });
    check('agent key: GET /api/agent lists both rooms, held, with no token', r.status === 200 && JSON.stringify((r.json.rooms || []).map((x) => [x.room, x.name, x.state])) === JSON.stringify([[A, 'Keyed', 'held'], [B, 'Keyed', 'held']]) && !r.text.includes(TA), r.text.slice(0, 200));
    const unused = async (name, who) => (((await req('GET', '/api/rooms/' + name + '/invites', { owner: true })).json || {}).invites || []).find((i) => i.name === who) || {};
    check('agent key: making the key opened neither invite', (await unused(A, 'Keyed')).used === null && (await unused(B, 'Keyed')).used === null);

    // through /api/mcp: list_rooms, a post in each, read back with the rooms' own tokens
    let t = await tool(KEY, 'list_rooms', {});
    check('agent key: list_rooms through /api/mcp', !!t.result && JSON.stringify(t.result.structuredContent.rooms.map((x) => x.room)) === JSON.stringify([A, B]), JSON.stringify(t).slice(0, 200));
    for (const [name, tok] of [[A, TA], [B, TB]]) {
      t = await tool(KEY, 'post_message', { room: name, text: 'hello through the key in ' + name, client_msg_id: 'key-' + name });
      const read = await req('GET', '/api/rooms/' + name + '/messages', { token: tok });
      check('agent key: post_message {room} in ' + name.slice(-1) + ' is read back over REST with the room token', !!t.result && !t.result.isError && read.status === 200 && (read.json.messages || []).some((m) => m.from === 'Keyed' && m.text === 'hello through the key in ' + name), JSON.stringify(t).slice(0, 200));
    }
    // the owner's members list: the agent active in both, its rows as any agent's
    for (const name of [A, B]) {
      const other = await invite(name, 'Plain');
      await req('GET', '/api/rooms/' + name + '/me', { token: other });
      const m = await req('GET', '/api/rooms/' + name + '/members', { owner: true });
      const rows = (m.json.members || []);
      const keyed = rows.find((x) => x.name === 'Keyed'), plain = rows.find((x) => x.name === 'Plain');
      check('agent key: the owner sees the agent active in ' + name.slice(-1) + ', its row with no new field', !!keyed && keyed.status === 'active' && !!plain && JSON.stringify(Object.keys(keyed).sort()) === JSON.stringify(Object.keys(plain).sort()), JSON.stringify(keyed).slice(0, 200));
    }

    // the owner revokes A's invite: A refuses at the next call, B goes on
    await req('DELETE', '/api/rooms/' + A + '/invites/' + TA, { owner: true });
    t = await tool(KEY, 'whoami', { room: A });
    check('agent key: a revoked room\'s next call is the tool error invite_revoked with the room', !!t.result && t.result.isError === true && JSON.stringify(t.result.structuredContent) === JSON.stringify({ code: 'invite_revoked', room: A }), JSON.stringify(t).slice(0, 200));
    t = await tool(KEY, 'whoami', { room: B });
    check('agent key: the other room still works', !!t.result && !t.result.isError && t.result.structuredContent.name === 'Keyed', JSON.stringify(t).slice(0, 200));
    r = await req('GET', '/api/agent', { headers: bearer(KEY) });
    const ea = (r.json.rooms || []).find((x) => x.room === A) || {};
    check('agent key: GET /api/agent shows it refused, with the code', ea.state === 'refused' && ea.code === 'invite_revoked' && ea.at > 0, JSON.stringify(ea));

    // a leave at B's own address with its token: the key's next call there gets the leave's sentence
    r = await req('POST', '/api/rooms/' + B + '/leave', { token: TB, json: { confirm: B } });
    check('agent key: the agent leaves B at the room\'s own address', r.status === 200, r.status + ' ' + r.text.slice(0, 160));
    t = await tool(KEY, 'get_board', { room: B });
    check('agent key: after the leave, the key\'s call there gets the leave\'s sentence', !!t.result && t.result.isError === true && t.result.structuredContent.code === 'invite_revoked' && /You left this room with this invite/.test(t.result.content[0].text), JSON.stringify(t).slice(0, 220));

    // add a third room, take one off, then disconnect
    const Cr = await room('c'), TC = await invite(Cr, 'Keyed');
    t = await tool(KEY, 'add_room', { room: Cr, token: TC });
    check('agent key: add_room puts a third room on the key and opens nothing', !!t.result && !t.result.isError && JSON.stringify(t.result.structuredContent) === JSON.stringify({ room: Cr, name: 'Keyed', opened: false, rooms_held: 3 }) && (await unused(Cr, 'Keyed')).used === null, JSON.stringify(t).slice(0, 200));
    t = await tool(KEY, 'remove_room', { room: A });
    check('agent key: remove_room takes it off; the seat stays', !!t.result && !t.result.isError && t.result.structuredContent.removed === true, JSON.stringify(t).slice(0, 200));
    r = await req('DELETE', '/api/agent', { headers: bearer(KEY) });
    check('agent key: DELETE /api/agent disconnects everywhere', r.status === 200 && r.json.deleted === true && JSON.stringify(r.json.rooms) === JSON.stringify([B, Cr]), r.text.slice(0, 200));
    r = await rpc(KEY, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    check('agent key: the key is refused from then on: -32001 agent_key_invalid at HTTP 200', r.status === 200 && r.json.error && r.json.error.code === -32001 && r.json.error.data.code === 'agent_key_invalid', r.text.slice(0, 200));
    r = await req('GET', '/api/rooms/' + Cr + '/members', { owner: true });
    check('agent key: the seats stay: the owner still lists the agent in C', (r.json.members || []).some((x) => x.name === 'Keyed' && x.status === 'unused'), r.text.slice(0, 200));

    // the creation caps: per room at its constant (each key from its own network)
    const D = await room('d'), TD = await invite(D, 'Keyed');
    const PER_ROOM = LIM.AGENT_KEYS_PER_ROOM_DAY;
    let okd = 0;
    for (let i = 0; i < PER_ROOM; i++) if ((await create([{ room: D, token: TD }])).status === 201) okd++;
    r = await create([{ room: D, token: TD }]);
    check('agent key: the per-room cap answers 429 rate_limited with Retry-After at its constant (' + PER_ROOM + ')', okd === PER_ROOM && r.status === 429 && r.json.code === 'rate_limited' && Number(r.headers.get('retry-after')) > 0, okd + ' then ' + r.status);
    // per network and per day, lowered on this local server only (TEST_HOOKS)
    const E = await room('e'), TE = await invite(E, 'Keyed');
    r = await req('POST', '/api/test-hooks/agent-limits', { owner: true, json: { per_ip: 2 } });
    check('agent key: the test hook lowers the per-network cap', r.status === 200 && r.json.agent_limits.per_ip === 2, r.text);
    const net = { 'CF-Connecting-IP': IPO.replace(/\.0\.$/, '.') + '8.1' };
    const n1 = await create([{ room: E, token: TE }], net), n2 = await create([{ room: E, token: TE }], net), n3 = await create([{ room: E, token: TE }], net);
    check('agent key: the per-network cap answers 429 with Retry-After', n1.status === 201 && n2.status === 201 && n3.status === 429 && n3.json.code === 'rate_limited' && Number(n3.headers.get('retry-after')) > 0 && Number(n3.headers.get('retry-after')) <= 3600, [n1.status, n2.status, n3.status].join());
    await req('POST', '/api/test-hooks/agent-limits', { owner: true, json: { clear: true } });
    await req('POST', '/api/test-hooks/agent-limits', { owner: true, json: { per_day: 1 } });
    r = await create([{ room: E, token: TE }]);
    check('agent key: the site-wide cap answers 429 with Retry-After until midnight', r.status === 429 && r.json.code === 'rate_limited' && Number(r.headers.get('retry-after')) > 0 && Number(r.headers.get('retry-after')) <= 86400, r.status + ' ' + r.headers.get('retry-after'));
    await req('POST', '/api/test-hooks/agent-limits', { owner: true, json: { clear: true } });
    r = await req('POST', '/api/test-hooks/agent-limits', { json: { per_day: 1 } });
    check('agent key: the test hook needs the owner key', r.status === 403, r.status);

    // without a key: a request over SMALL_BODY_MAX is 413, a batch 400 -32600, initialize the none instructions
    r = await req('POST', '/api/mcp', { body: '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"pad":"' + 'x'.repeat(1048576) + '"}}', headers: { 'Content-Type': 'application/json' } });
    check('agent key: without a key, 1 MiB and more is 413 -32600', r.status === 413 && r.json && r.json.error.code === -32600 && /without a valid agent key/.test(r.json.error.message), r.status + ' ' + r.text.slice(0, 120));
    r = await rpc(null, [{ jsonrpc: '2.0', id: 1, method: 'ping' }]);
    check('agent key: a batch is 400 -32600, for anyone', r.status === 400 && r.json.error.code === -32600 && /takes no batches/.test(r.json.error.message), r.status + ' ' + r.text.slice(0, 120));
    r = await rpc(null, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    check('agent key: a keyless initialize is answered, with the instructions for no key and the agent server', r.status === 200 && /^All your Agent Chat rooms as tools, for an agent key\. This connection sent no agent key/.test(r.json.result.instructions) && r.json.result.serverInfo.name === 'agent-chat-agent', r.text.slice(0, 200));
    r = await rpc(null, { jsonrpc: '2.0', id: 1, method: 'server/discover', params: { _meta: { [V]: NEW, [C]: {} } } }, { 'MCP-Protocol-Version': NEW, 'Mcp-Method': 'server/discover' });
    check('agent key: a keyless server/discover is answered, private, ttlMs 0', r.status === 200 && r.json.result.cacheScope === 'private' && r.json.result.ttlMs === 0 && /sent no agent key/.test(r.json.result.instructions), r.text.slice(0, 200));
    r = await rpc(TC, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    check('agent key: a room token at /api/mcp is -32001 not_agent_key', r.status === 200 && r.json.error.data.code === 'not_agent_key', r.text.slice(0, 200));
    r = await req('GET', '/api/agent');
    check('agent key: GET /api/agent with no key is 401 agent_key_missing', r.status === 401 && r.json.code === 'agent_key_missing', r.status);

    // whats_waiting over AGENT_ROOMS_MAX rooms: twenty calls, the gap lowered by the test hook
    const MAX = LIM.AGENT_ROOMS_MAX;
    const many = [];
    for (let i = 0; i < MAX; i++) {
      const name = await room('t' + i);
      const tok = await invite(name, 'Timed'), pat = await invite(name, 'Pat', 'human');
      await req('POST', '/api/rooms/' + name + '/messages', { token: pat, json: { text: 'Hello @Timed, a message for you' } });
      await req('POST', '/api/rooms/' + name + '/decisions', { token: pat, json: { title: 'Book the hotel' } });
      many.push({ room: name, token: tok });
    }
    r = await create(many);
    const TK = r.json && r.json.key;
    check('agent key: a key over ' + MAX + ' rooms', r.status === 201 && !!TK && r.json.rooms.length === MAX, r.status + ' ' + r.text.slice(0, 120));
    if (TK) {
      for (const m of many) await tool(TK, 'post_message', { room: m.room, text: 'here', client_msg_id: 'timed-' + m.room });
      await req('POST', '/api/test-hooks/agent-limits', { owner: true, json: { glance_gap_ms: 1 } });
      const times = [];
      let bytes = 0, ok = 0;
      for (let i = 0; i < 20; i++) {
        const t0 = Date.now();
        const g = await rpc(TK, { jsonrpc: '2.0', id: i, method: 'tools/call', params: { name: 'whats_waiting', arguments: {} } });
        times.push(Date.now() - t0);
        if (g.json && g.json.result && !g.json.result.isError && g.json.result.structuredContent.rooms.length === MAX) ok++;
        bytes = g.text.length;
        await new Promise((res) => setTimeout(res, 5));
      }
      await req('POST', '/api/test-hooks/agent-limits', { owner: true, json: { clear: true } });
      const sorted = times.slice().sort((a, b) => a - b);
      const p95 = sorted[Math.ceil(0.95 * sorted.length) - 1];
      console.log('agent key: whats_waiting over ' + MAX + ' rooms, 20 calls: p95 ' + p95 + ' ms, median ' + sorted[10] + ' ms, max ' + sorted[19] + ' ms, answer ' + bytes + ' characters');
      check('agent key: whats_waiting over ' + MAX + ' rooms answers every room, 95th percentile under 2 s', ok === 20 && p95 < 2000, ok + ' ok, p95 ' + p95 + ' ms');
      await req('DELETE', '/api/agent', { headers: bearer(TK) });
    }
  } finally {
    for (const name of made) {
      await req('DELETE', '/api/rooms/' + name + '/invites', { owner: true });
      await req('DELETE', '/api/rooms/' + name + '?confirm=' + name, { owner: true });
    }
  }
}

module.exports = { agentKey };
