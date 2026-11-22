// Golden responses: what today's API already promises, recorded once and
// compared on every run, so an additive change can prove it is additive.
// Each case keeps its status, its content type, its error sentence (exact)
// and the names of its fields (top level, and the first row of a known
// list). A later run passes when every case keeps all of that; fields it
// gains are fine. MCP cases keep the JSON-RPC result's field names, or the
// error's code and message.
//
//   GOLDEN=write npm run test:api   records tests/api/golden.json
//   npm run test:api                compares against it
//
// Record only from a commit whose behavior is the promise (the baseline
// was taken before Phase A of the agent invite link design, 2026-11-21).
// Values that differ per run (ids, timestamps, tokens) are never compared.
'use strict';
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, 'golden.json');
const LISTS = ['messages', 'members', 'invites', 'games', 'questions', 'stakes', 'decisions', 'digests', 'tools', 'notices'];

function kindOf(ct) {
  ct = String(ct || '');
  if (/json/.test(ct)) return 'json';
  if (/event-stream/.test(ct)) return 'sse';
  if (/html/.test(ct)) return 'html';
  if (/text\/plain/.test(ct)) return 'text';
  if (/^image\//.test(ct)) return 'image';
  return ct.split(';')[0] || 'none';
}

function shape(r) {
  const out = { status: r.status, type: kindOf(r.headers && r.headers.get('content-type')) };
  const j = r.json;
  if (j && typeof j === 'object' && !Array.isArray(j)) {
    out.keys = Object.keys(j).sort();
    if (typeof j.error === 'string') out.error = j.error;
    if (j.error && typeof j.error === 'object') out.rpcError = { code: j.error.code, message: j.error.message };
    if (j.result && typeof j.result === 'object') {
      out.resultKeys = Object.keys(j.result).sort();
      const c = j.result.content && j.result.content[0];
      if (c && typeof c.text === 'string') { try { const p = JSON.parse(c.text); if (p && typeof p === 'object' && !Array.isArray(p)) out.toolKeys = Object.keys(p).sort(); } catch {} }
      if (Array.isArray(j.result.tools) && j.result.tools[0]) out.firstTool = Object.keys(j.result.tools[0]).sort();
    }
    for (const k of LISTS) if (Array.isArray(j[k]) && j[k][0] && typeof j[k][0] === 'object') (out.rows = out.rows || {})[k] = Object.keys(j[k][0]).sort();
  }
  return out;
}

function compare(name, want, got) {
  const bad = [];
  if (want.status !== got.status) bad.push('status ' + want.status + ' -> ' + got.status);
  if (want.type !== got.type) bad.push('type ' + want.type + ' -> ' + got.type);
  if (want.error !== undefined && want.error !== got.error) bad.push('error sentence changed: ' + JSON.stringify(want.error) + ' -> ' + JSON.stringify(got.error));
  if (want.rpcError && (!got.rpcError || got.rpcError.code !== want.rpcError.code || got.rpcError.message !== want.rpcError.message)) bad.push('rpc error ' + JSON.stringify(want.rpcError) + ' -> ' + JSON.stringify(got.rpcError));
  const lost = (a, b, label) => { const miss = (a || []).filter((k) => !(b || []).includes(k)); if (miss.length) bad.push(label + ' lost ' + miss.join(', ')); };
  lost(want.keys, got.keys, 'fields');
  lost(want.resultKeys, got.resultKeys, 'result fields');
  lost(want.toolKeys, got.toolKeys, 'tool result fields');
  lost(want.firstTool, got.firstTool, 'tool definition fields');
  for (const k of Object.keys(want.rows || {})) lost(want.rows[k], (got.rows || {})[k], k + ' row fields');
  return bad;
}

// The cases. ctx: { req, BASE, OWNER, SUF, IPO }.
async function runCases(ctx) {
  const { req, SUF } = ctx;
  const room = 'apitest-golden-' + SUF;
  const R = '/api/rooms/' + room;
  const res = {};
  const rec = (name, r) => { res[name] = shape(r); return r; };
  const raw = async (name, p, opts) => {
    const r = await fetch(ctx.BASE + p, opts || {});
    const ct = r.headers.get('content-type') || '';
    let json = null;
    if (/json/.test(ct)) { try { json = JSON.parse(await r.text()); } catch {} } else { try { if (r.body) await r.body.cancel(); } catch {} }
    return rec(name, { status: r.status, json, headers: r.headers });
  };
  const rpc = (token, body) => req('POST', R + '/mcp', { token, json: body });

  await req('POST', R, { owner: true });
  const H = (await req('POST', R + '/invites', { owner: true, json: { name: 'GoldH', kind: 'human' } })).json.token;
  const A = (await req('POST', R + '/invites', { owner: true, json: { name: 'GoldA', kind: 'agent' } })).json.token;
  const H2 = (await req('POST', R + '/invites', { owner: true, json: { name: 'GoldH2', kind: 'human' } })).json.token;
  const V = (await req('POST', R + '/invites', { owner: true, json: { name: 'GoldGone', kind: 'agent' } })).json.token;
  await req('DELETE', R + '/invites/' + V, { owner: true });

  // docs, build, pages
  await raw('docs /api', '/api');
  await raw('docs /llms.txt', '/llms.txt');
  rec('build', await req('GET', '/api/build'));
  await raw('room page', '/r/' + room);
  await raw('home page', '/');

  // access refusals
  rec('read: no token', await req('GET', R + '/messages?limit=1'));
  rec('read: unknown token', await req('GET', R + '/messages?limit=1', { token: 'golden-bogus' }));
  rec('read: revoked token', await req('GET', R + '/messages?limit=1', { token: V }));
  rec('read: no such room', await req('GET', '/api/rooms/apitest-nope-' + SUF + '/messages', { token: H }));
  rec('read: query token on media', await req('GET', R + '/messages/1/image?invite=' + H));

  // messages
  const posted = rec('post: message', await req('POST', R + '/messages', { token: H, json: { text: 'golden hello' } }));
  rec('post: bad JSON', await req('POST', R + '/messages', { token: H, headers: { 'Content-Type': 'application/json' }, body: '{"text": "half' }));
  rec('read: first, human', await req('GET', R + '/messages?limit=5', { token: H }));
  rec('read: first, agent', await req('GET', R + '/messages?limit=5', { token: A }));
  rec('read: after', await req('GET', R + '/messages?after=0&limit=5', { token: A }));
  rec('read: query token', await req('GET', R + '/messages?limit=1&invite=' + H));
  const mid = posted.json && posted.json.id;
  rec('reactions: add', await req('POST', R + '/messages/' + mid + '/reactions', { token: A, json: { reaction: '👍' } }));

  // board and members
  for (const k of ['welcome', 'members', 'constitution', 'questions', 'decisions', 'stakes', 'digests', 'games']) rec('get ' + k, await req('GET', R + '/' + k, { token: H }));
  rec('owner: invites list', await req('GET', R + '/invites', { owner: true }));
  rec('invite: bad JSON', await req('POST', R + '/invites', { owner: true, headers: { 'Content-Type': 'application/json' }, body: '{"name": ' }));
  rec('invite: name taken', await req('POST', R + '/invites', { owner: true, json: { name: 'goldh', kind: 'human' } }));
  rec('invite: by a member', await req('POST', R + '/invites', { token: H, json: { name: 'GoldM0', kind: 'agent' } }));
  for (let i = 1; i < 5; i++) await req('POST', R + '/invites', { token: H, json: { name: 'GoldM' + i, kind: 'agent' } });
  rec('invite: member daily cap', await req('POST', R + '/invites', { token: H, json: { name: 'GoldM5', kind: 'agent' } }));
  // fill the room to its active-invite cap with owner invites, then a member asks
  const live = ((await req('GET', R + '/invites', { owner: true })).json.invites || []).filter((i) => !i.revoked).length;
  for (let i = live; i < 50; i++) await req('POST', R + '/invites', { owner: true, json: { name: 'GoldF' + i, kind: 'agent' } });
  rec('invite: active cap', await req('POST', R + '/invites', { token: H2, json: { name: 'GoldOver', kind: 'agent' } }));

  // digests: three a day, then the cap
  for (let i = 0; i < 3; i++) await req('POST', R + '/digests', { token: H, json: { text: 'golden digest ' + i } });
  rec('digest: daily cap', await req('POST', R + '/digests', { token: H, json: { text: 'golden digest over' } }));

  // upload tickets: twenty outstanding, then the cap
  const draft = await req('POST', R + '/messages', { token: H, json: { text: 'golden draft', draft: true } });
  const did = draft.json && draft.json.id;
  rec('ticket: minted', await req('POST', R + '/messages/' + did + '/upload-ticket', { token: H, json: { kind: 'image' } }));
  for (let i = 1; i < 20; i++) await req('POST', R + '/messages/' + did + '/upload-ticket', { token: H, json: { kind: 'image' } });
  rec('ticket: outstanding cap', await req('POST', R + '/messages/' + did + '/upload-ticket', { token: H, json: { kind: 'image' } }));

  // room creation: three tries per email a day, then the cap
  const email = 'golden-' + SUF + '@example.test';
  const cip = (ctx.IPO || '10.9.0.') + '77';
  for (let i = 0; i < 3; i++) await req('POST', '/api/create-room', { headers: { 'CF-Connecting-IP': cip }, json: { room: 'apitest-gc' + i + '-' + SUF, name: 'Gold', email } });
  rec('create-room: email cap', await req('POST', '/api/create-room', { headers: { 'CF-Connecting-IP': cip }, json: { room: 'apitest-gc9-' + SUF, name: 'Gold', email } }));
  rec('create-room: bad JSON', await req('POST', '/api/create-room', { headers: { 'Content-Type': 'application/json' }, body: '{"room": "half' }));

  // MCP
  rec('mcp: initialize', await rpc(A, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }));
  rec('mcp: initialize, bad token', await rpc('golden-bogus', { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }));
  rec('mcp: tools/list', await rpc(A, { jsonrpc: '2.0', id: 2, method: 'tools/list' }));
  rec('mcp: tools/list, no token', await rpc('', { jsonrpc: '2.0', id: 2, method: 'tools/list' }));
  rec('mcp: tools/list, unknown token', await rpc('golden-bogus', { jsonrpc: '2.0', id: 2, method: 'tools/list' }));
  rec('mcp: tools/list, revoked token', await rpc(V, { jsonrpc: '2.0', id: 2, method: 'tools/list' }));
  rec('mcp: whoami', await rpc(A, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'whoami', arguments: {} } }));
  rec('mcp: get_members', await rpc(A, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'get_members', arguments: {} } }));
  rec('mcp: unknown method', await rpc(A, { jsonrpc: '2.0', id: 5, method: 'no/such' }));
  rec('mcp: parse error', await req('POST', R + '/mcp', { token: A, headers: { 'Content-Type': 'application/json' }, body: '{' }));

  // the stream answers with an event stream (headers only)
  const ac = new AbortController();
  const sr = await fetch(ctx.BASE + R + '/stream', { headers: { 'X-Invite-Token': H }, signal: ac.signal });
  rec('stream', { status: sr.status, json: null, headers: sr.headers });
  ac.abort();

  await req('DELETE', R + '/invites', { owner: true });
  await req('DELETE', R + '?confirm=' + room, { owner: true });
  return res;
}

async function golden(ctx, check) {
  const res = await runCases(ctx);
  if (process.env.GOLDEN === 'write') {
    fs.writeFileSync(FILE, JSON.stringify(res, null, 2) + '\n');
    check('golden responses recorded (' + Object.keys(res).length + ' cases)', true);
    return;
  }
  if (!fs.existsSync(FILE)) { check('golden baseline exists (GOLDEN=write npm run test:api records it)', false); return; }
  const want = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  for (const name of Object.keys(want)) {
    if (!res[name]) { check('golden: ' + name + ' still runs', false); continue; }
    const bad = compare(name, want[name], res[name]);
    check('golden: ' + name, !bad.length, bad.join('; '));
  }
}

module.exports = { golden, shape, compare };
