// Phase A of the agent invite link and API design, against a real local
// Worker: error codes, and (as later steps land) the changes feed, the
// invite preview, /me, the primer, the link page and the query-token
// notices. Each section uses its own throwaway room. Called from
// api.test.js after the golden responses.
'use strict';

async function codes(ctx) {
  const { req, check, SUF } = ctx;
  const room = 'apitest-codes-' + SUF;
  const R = '/api/rooms/' + room;
  const rpc = (token, body) => req('POST', R + '/mcp', { token, json: body });
  const codeOf = (r) => r.json && r.json.code;
  const retryOf = (r) => parseInt(r.headers.get('retry-after') || '', 10);
  const toolErr = (r) => (r.json && r.json.result) || {};

  await req('POST', R, { owner: true });
  const H = (await req('POST', R + '/invites', { owner: true, json: { name: 'CodeH', kind: 'human' } })).json.token;
  const H2 = (await req('POST', R + '/invites', { owner: true, json: { name: 'CodeH2', kind: 'human' } })).json.token;
  const A = (await req('POST', R + '/invites', { owner: true, json: { name: 'CodeA', kind: 'agent' } })).json.token;
  const V = (await req('POST', R + '/invites', { owner: true, json: { name: 'CodeGone', kind: 'agent' } })).json.token;
  await req('DELETE', R + '/invites/' + V, { owner: true });

  // the three access refusals, over REST and MCP
  let r = await req('GET', R + '/messages?limit=1');
  check('code: no token -> invite_missing', r.status === 401 && codeOf(r) === 'invite_missing', r.status + ' ' + codeOf(r));
  r = await req('GET', R + '/messages?limit=1', { token: 'codes-bogus' });
  check('code: unknown token -> invite_invalid', r.status === 403 && codeOf(r) === 'invite_invalid', r.status + ' ' + codeOf(r));
  r = await req('GET', R + '/messages?limit=1', { token: V });
  check('code: revoked token -> invite_revoked', r.status === 403 && codeOf(r) === 'invite_revoked', r.status + ' ' + codeOf(r));
  r = await req('POST', R + '/messages', { token: V, json: { text: 'x' } });
  check('code: a write refuses with the same code', r.status === 403 && codeOf(r) === 'invite_revoked', r.status + ' ' + codeOf(r));
  r = await req('GET', R + '/stream', { token: 'codes-bogus' });
  check('code: the stream refuses with a code', r.status === 403 && codeOf(r) === 'invite_invalid', r.status + ' ' + codeOf(r));
  for (const [label, tok, want] of [['no token', '', 'invite_missing'], ['unknown token', 'codes-bogus', 'invite_invalid'], ['revoked token', V, 'invite_revoked']]) {
    r = await rpc(tok, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const e = r.json && r.json.error;
    check('code: MCP ' + label + ' -> -32001 data.code ' + want, !!e && e.code === -32001 && e.data && e.data.code === want, JSON.stringify(e));
  }
  r = await rpc(A, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
  check('code: MCP success carries no error', !!(r.json && r.json.result) && !r.json.error);

  // name taken
  r = await req('POST', R + '/invites', { owner: true, json: { name: 'codeh', kind: 'human' } });
  check('code: name taken -> 409 name_taken', r.status === 409 && codeOf(r) === 'name_taken', r.status + ' ' + codeOf(r));

  // a member's daily invites: rate_limited with Retry-After inside a day
  for (let i = 0; i < 5; i++) await req('POST', R + '/invites', { token: H, json: { name: 'CodeM' + i, kind: 'agent' } });
  r = await req('POST', R + '/invites', { token: H, json: { name: 'CodeM5', kind: 'agent' } });
  check('code: member daily invites -> rate_limited', r.status === 429 && codeOf(r) === 'rate_limited', r.status + ' ' + codeOf(r));
  check('code: ... with Retry-After within a day', retryOf(r) > 0 && retryOf(r) <= 86400, r.headers.get('retry-after'));

  // active invites: limit_reached, no Retry-After
  const live = ((await req('GET', R + '/invites', { owner: true })).json.invites || []).filter((i) => !i.revoked).length;
  for (let i = live; i < 50; i++) await req('POST', R + '/invites', { owner: true, json: { name: 'CodeF' + i, kind: 'agent' } });
  r = await req('POST', R + '/invites', { token: H2, json: { name: 'CodeOver', kind: 'agent' } });
  check('code: active invites -> limit_reached', r.status === 429 && codeOf(r) === 'limit_reached', r.status + ' ' + codeOf(r));
  check('code: ... and no Retry-After', !r.headers.get('retry-after'), r.headers.get('retry-after'));

  // digests: rate_limited until UTC midnight, over REST and MCP
  for (let i = 0; i < 3; i++) await req('POST', R + '/digests', { token: H, json: { text: 'codes digest ' + i } });
  r = await req('POST', R + '/digests', { token: H, json: { text: 'codes digest over' } });
  const now = new Date();
  const toMidnight = Math.ceil((Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1) - now.getTime()) / 1000);
  check('code: digests -> rate_limited', r.status === 429 && codeOf(r) === 'rate_limited', r.status + ' ' + codeOf(r));
  check('code: ... Retry-After is the time to UTC midnight', Math.abs(retryOf(r) - toMidnight) <= 5, retryOf(r) + ' vs ' + toMidnight);
  r = await rpc(A, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'file_digest', arguments: { text: 'codes digest via mcp' } } });
  const sc = toolErr(r).structuredContent || {};
  check('code: MCP tool error carries structuredContent {code, retry_after}', toolErr(r).isError === true && sc.code === 'rate_limited' && sc.retry_after > 0, JSON.stringify(toolErr(r)).slice(0, 200));

  // upload tickets: limit_reached, over REST and MCP
  const draft = await req('POST', R + '/messages', { token: H, json: { text: 'codes draft', draft: true } });
  const did = draft.json && draft.json.id;
  for (let i = 0; i < 20; i++) await req('POST', R + '/messages/' + did + '/upload-ticket', { token: H, json: { kind: 'image' } });
  r = await req('POST', R + '/messages/' + did + '/upload-ticket', { token: H, json: { kind: 'image' } });
  check('code: upload tickets -> limit_reached', r.status === 429 && codeOf(r) === 'limit_reached' && !r.headers.get('retry-after'), r.status + ' ' + codeOf(r));
  for (let i = 0; i < 20; i++) await rpc(A, { jsonrpc: '2.0', id: 10 + i, method: 'tools/call', params: { name: 'begin_upload', arguments: { kind: 'image' } } });
  r = await rpc(A, { jsonrpc: '2.0', id: 40, method: 'tools/call', params: { name: 'begin_upload', arguments: { kind: 'image' } } });
  check('code: MCP upload ticket cap -> structuredContent limit_reached', toolErr(r).isError === true && (toolErr(r).structuredContent || {}).code === 'limit_reached', JSON.stringify(toolErr(r)).slice(0, 200));

  // room creation: rate_limited until UTC midnight
  const email = 'codes-' + SUF + '@example.test';
  const cip = (ctx.IPO || '10.9.0.') + '78';
  for (let i = 0; i < 3; i++) await req('POST', '/api/create-room', { headers: { 'CF-Connecting-IP': cip }, json: { room: 'apitest-cc' + i + '-' + SUF, name: 'Code', email } });
  r = await req('POST', '/api/create-room', { headers: { 'CF-Connecting-IP': cip }, json: { room: 'apitest-cc9-' + SUF, name: 'Code', email } });
  check('code: room creation cap -> rate_limited with Retry-After', r.status === 429 && codeOf(r) === 'rate_limited' && Math.abs(retryOf(r) - toMidnight) <= 5, r.status + ' ' + codeOf(r) + ' ' + retryOf(r));

  await req('DELETE', R + '/invites', { owner: true });
  await req('DELETE', R + '?confirm=' + room, { owner: true });
}

async function inviteApi(ctx) {
  await codes(ctx);
}

module.exports = { inviteApi };
