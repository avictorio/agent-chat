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

async function changesFeed(ctx) {
  const { req, check, SUF } = ctx;
  let r = await req('GET', '/api/changes');
  const j = r.json || {};
  check('changes: GET /api/changes answers without a token', r.status === 200 && /^\d{4}-\d{2}-\d{2}$/.test(j.api_version || '') && typeof j.catalog_version === 'string' && Array.isArray(j.notices), r.status + ' ' + r.text.slice(0, 120));
  check('changes: each notice has id, date, text and until', (j.notices || []).every((n) => n.id && n.date && n.text && n.until), JSON.stringify(j.notices).slice(0, 200));
  r = await req('POST', '/api/changes', { json: {} });
  check('changes: only GET', r.status === 405, r.status);

  const room = 'apitest-changes-' + SUF;
  const R = '/api/rooms/' + room;
  await req('POST', R, { owner: true });
  const A = (await req('POST', R + '/invites', { owner: true, json: { name: 'FeedA', kind: 'agent' } })).json.token;
  r = await req('GET', R + '/messages?limit=1', { token: A });
  const fa = (r.json && r.json.for_agents) || {};
  check('changes: a read\'s for_agents carries api_version and changes', fa.api_version === j.api_version && /\/api\/changes$/.test(fa.changes || ''), JSON.stringify(fa));
  r = await req('POST', R + '/messages', { token: A, json: { text: 'feed check' } });
  const fp = (r.json && r.json.for_agents) || {};
  check('changes: a post\'s for_agents carries them too', fp.api_version === j.api_version && !!fp.changes, JSON.stringify(fp));
  r = await req('POST', R + '/mcp', { token: A, json: { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} } });
  const ch = (r.json && r.json.result && r.json.result.changes) || {};
  check('changes: MCP initialize carries the feed', ch.api_version === j.api_version && Array.isArray(ch.notices), JSON.stringify(ch).slice(0, 160));
  await req('DELETE', R + '/invites', { owner: true });
  await req('DELETE', R + '?confirm=' + room, { owner: true });
}

async function preview(ctx) {
  const { req, check, SUF } = ctx;
  const room = 'apitest-preview-' + SUF;
  const R = '/api/rooms/' + room;
  const rpc = (token, body) => req('POST', R + '/mcp', { token, json: body });
  await req('POST', R, { owner: true });
  const mk = async (name, kind) => (await req('POST', R + '/invites', { owner: true, json: { name, kind } })).json.token;
  const H = await mk('PrevH', 'human');
  await req('GET', R + '/messages?limit=1', { token: H }); // H joins
  await req('PUT', R + '/constitution', { token: H, json: { text: 'We plan the Lima trip here. Be kind.' } });
  const statusOf = async (name) => {
    const r = await req('GET', R + '/members', { token: H });
    const row = ((r.json && r.json.members) || []).find((m) => m.name === name);
    return row ? { status: row.status, last_seen: row.last_seen || null } : null;
  };

  // REST preview: a fresh agent invite stays unused
  const P = await mk('PrevP', 'agent');
  let r = await req('GET', R + '/invite', { token: P });
  const j = r.json || {};
  check('preview: answers with the invite, unopened', r.status === 200 && j.invite && j.invite.name === 'PrevP' && j.invite.kind === 'agent' && j.invite.status === 'unused' && j.opened === false && j.invite.invited_by === null, r.status + ' ' + JSON.stringify(j.invite));
  check('preview: purpose is the start of the constitution', j.purpose === 'We plan the Lima trip here. Be kind.', JSON.stringify(j.purpose));
  check('preview: members lists who joined (name and kind)', Array.isArray(j.members) && j.members.length === 1 && j.members[0].name === 'PrevH' && j.members[0].kind === 'human' && Object.keys(j.members[0]).length === 2, JSON.stringify(j.members));
  check('preview: an agent invite carries its onboarding block', typeof j.agent_onboarding === 'string' && j.agent_onboarding.includes(P), String(j.agent_onboarding).slice(0, 60));
  check('preview: next points at the docs, MCP and messages', j.next && /\/llms\.txt$/.test(j.next.docs) && /\/mcp$/.test(j.next.mcp), JSON.stringify(j.next));
  let st = await statusOf('PrevP');
  check('preview: the member stays unused, never seen', st && st.status === 'unused' && st.last_seen === null, JSON.stringify(st));
  r = await req('GET', R + '/invite', { headers: { Authorization: 'Bearer ' + P } });
  check('preview: takes the Bearer header', r.status === 200 && r.json.invite.name === 'PrevP', r.status);

  // refusals: the same status, sentence and code as a read
  for (const [label, opts] of [['no token', {}], ['unknown token', { token: 'prev-bogus' }]]) {
    const a = await req('GET', R + '/invite', opts);
    const b = await req('GET', R + '/messages?limit=1', opts);
    check('preview: ' + label + ' refuses like a read', a.status === b.status && a.json.error === b.json.error && a.json.code === b.json.code && !!a.json.code, a.status + ' ' + a.json.code + ' vs ' + b.status + ' ' + b.json.code);
  }
  const V = await mk('PrevGone', 'agent');
  await req('DELETE', R + '/invites/' + V, { owner: true });
  r = await req('GET', R + '/invite', { token: V });
  check('preview: a revoked token gets 403 invite_revoked', r.status === 403 && r.json.code === 'invite_revoked', r.status + ' ' + r.json.code);
  r = await req('GET', R + '/invite', { owner: true });
  check('preview: the owner key alone has no invite (401 invite_missing)', r.status === 401 && r.json.code === 'invite_missing', r.status + ' ' + r.json.code);
  r = await req('GET', '/api/rooms/apitest-nope-' + SUF + '/invite', { token: P });
  check('preview: a missing room is 404', r.status === 404, r.status);
  r = await req('POST', R + '/invite', { token: P, json: {} });
  check('preview: only GET', r.status === 405, r.status);

  // MCP: connecting does not join
  const Q = await mk('PrevQ', 'agent');
  r = await rpc(Q, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  await rpc(Q, { jsonrpc: '2.0', method: 'notifications/initialized' });
  r = await rpc(Q, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const tools = (r.json && r.json.result && r.json.result.tools) || [];
  const gi = tools.find((t) => t.name === 'get_invite');
  check('mcp: catalog 1.22.0 lists get_invite, read-only', r.json.result.catalog.version === '1.22.0' && !!gi && gi.annotations && gi.annotations.readOnlyHint === true, JSON.stringify(r.json.result.catalog));
  r = await rpc(Q, [{ jsonrpc: '2.0', id: 3, method: 'initialize', params: {} }, { jsonrpc: '2.0', id: 4, method: 'tools/list' }, { jsonrpc: '2.0', id: 5, method: 'ping' }]);
  r = await rpc(Q, { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'get_invite', arguments: {} } });
  const gr = r.json && r.json.result && r.json.result.structuredContent;
  check('mcp: get_invite returns the preview', !!gr && gr.invite && gr.invite.name === 'PrevQ' && gr.invite.status === 'unused', JSON.stringify(r.json).slice(0, 200));
  st = await statusOf('PrevQ');
  check('mcp: initialize, notifications, tools/list, a batch and get_invite leave the invite unused', st && st.status === 'unused' && st.last_seen === null, JSON.stringify(st));
  r = await rpc(Q, { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'whoami', arguments: {} } });
  st = await statusOf('PrevQ');
  check('mcp: the first other tool call opens it', st && st.status === 'active', JSON.stringify(st));
  const B = await mk('PrevB', 'agent');
  r = await rpc(B, [{ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'whoami', arguments: {} } }, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_room_state', arguments: {} } }]);
  st = await statusOf('PrevB');
  check('mcp: a batch with tool calls opens it', Array.isArray(r.json) && r.json.length === 3 && st && st.status === 'active', JSON.stringify(st));
  r = await rpc(V, { jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'get_invite', arguments: {} } });
  check('mcp: get_invite refuses a revoked token with -32001 invite_revoked', r.json.error && r.json.error.code === -32001 && r.json.error.data.code === 'invite_revoked', JSON.stringify(r.json.error));
  r = await rpc('prev-bogus', { jsonrpc: '2.0', id: 9, method: 'no/such' });
  check('mcp: an unknown method with a bad token still gets -32001', r.json.error && r.json.error.code === -32001, JSON.stringify(r.json.error));

  // REST: the first write opens an unused invite too
  const W = await mk('PrevW', 'agent');
  await req('POST', R + '/messages', { token: W, json: { text: 'first a write' } });
  st = await statusOf('PrevW');
  check('preview: a first write opens the invite', st && st.status === 'active', JSON.stringify(st));

  await req('DELETE', R + '/invites', { owner: true });
  await req('DELETE', R + '?confirm=' + room, { owner: true });
}

async function me(ctx) {
  const { req, check, SUF } = ctx;
  const room = 'apitest-me-' + SUF;
  const R = '/api/rooms/' + room;
  await req('POST', R, { owner: true });
  const H = (await req('POST', R + '/invites', { owner: true, json: { name: 'MeH', kind: 'human' } })).json.token;
  await req('GET', R + '/messages?limit=1', { token: H });
  const A = (await req('POST', R + '/invites', { token: H, json: { name: 'MeA', kind: 'agent' } })).json.token;
  const t0 = Date.now();
  let r = await req('GET', R + '/me', { token: A });
  const j = r.json || {};
  check('me: name, kind, status, invited_by, invited, joined', r.status === 200 && j.room === room && j.name === 'MeA' && j.kind === 'agent' && j.status === 'active' && j.invited_by === 'MeH' && typeof j.invited === 'number' && typeof j.joined === 'number' && !('owner' in j), JSON.stringify(j));
  check('me: joined is this first call', j.joined >= t0 - 5000 && j.joined >= j.invited, j.joined + ' vs ' + t0);
  r = await req('GET', R + '/me', { token: A });
  check('me: joined stays the first time', r.json.joined === j.joined, r.json.joined + ' vs ' + j.joined);
  r = await req('GET', R + '/me', { token: H });
  check('me: an owner-made invite has invited_by null', r.status === 200 && r.json.invited_by === null && r.json.kind === 'human', JSON.stringify(r.json));
  r = await req('GET', R + '/me', { owner: true });
  check('me: the owner key alone is no member (owner: true, the rest null)', r.status === 200 && r.json.owner === true && r.json.name === null && r.json.status === null, JSON.stringify(r.json));
  r = await req('GET', R + '/me');
  check('me: no token -> 401 invite_missing', r.status === 401 && r.json.code === 'invite_missing', r.status + ' ' + r.json.code);
  r = await req('POST', R + '/me', { token: A, json: {} });
  check('me: only GET (for now)', r.status === 405, r.status);
  r = await req('POST', R + '/mcp', { token: A, json: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'whoami', arguments: {} } } });
  const w = (r.json && r.json.result && r.json.result.structuredContent) || {};
  check('whoami: /me fields, and owner and invite_only as before', w.name === 'MeA' && w.kind === 'agent' && w.status === 'active' && w.invited_by === 'MeH' && w.joined === j.joined && w.invited === j.invited && w.owner === false && w.invite_only === true, JSON.stringify(w));
  r = await req('POST', R + '/mcp', { owner: true, json: { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'whoami', arguments: { as: 'Builder' } } } });
  const wo = (r.json && r.json.result && r.json.result.structuredContent) || {};
  check('whoami: the owner key keeps owner: true and its "as" name', wo.owner === true && wo.name === 'Builder' && wo.invite_only === true, JSON.stringify(wo));
  r = await req('GET', R + '/invite', { token: A });
  check('preview: next names /me', r.json && r.json.next && /\/me$/.test(r.json.next.me || ''), JSON.stringify(r.json && r.json.next));
  await req('DELETE', R + '/invites', { owner: true });
  await req('DELETE', R + '?confirm=' + room, { owner: true });
}

async function primerDocs(ctx) {
  const { check, BASE, SUF, req } = ctx;
  const get = async (p) => { const r = await fetch(BASE + p); return { status: r.status, type: r.headers.get('content-type') || '', text: await r.text() }; };
  const llms = await get('/llms.txt');
  const apiTxt = await get('/api.txt');
  const api = await get('/api');
  const apiDocs = await get('/api/docs');
  check('docs: /llms.txt is the primer, plain text', llms.status === 200 && /text\/plain/.test(llms.type) && /^Agent Chat - the short version for agents/.test(llms.text) && llms.text.length < 6500, llms.status + ' ' + llms.text.length);
  check('docs: the primer links the full reference first', /https?:\/\/[^ ]+\/api\.txt$/.test(llms.text.split('\n')[0]), llms.text.split('\n')[0]);
  check('docs: /api, /api/docs and /api.txt are the same full reference', apiTxt.status === 200 && apiTxt.text === api.text && api.text === apiDocs.text && apiTxt.text.length > 30000 && /^chat\.victorio\.cloud - /.test(apiTxt.text), apiTxt.text.length + ' ' + api.text.length);
  check('docs: the reference points newcomers at the primer', /https?:\/\/[^ \n]+\/llms\.txt/.test(apiTxt.text.slice(0, 800)));

  const room = 'apitest-docs-' + SUF;
  const R = '/api/rooms/' + room;
  await req('POST', R, { owner: true });
  const H = (await req('POST', R + '/invites', { owner: true, json: { name: 'DocH', kind: 'human' } })).json.token;
  await req('GET', R + '/messages?limit=1', { token: H });
  await req('PUT', R + '/constitution', { token: H, json: { text: 'A room for testing the docs.' } });
  const inv = await req('POST', R + '/invites', { token: H, json: { name: 'DocA', kind: 'agent' } });
  check('onboarding: a member-made invite names who invited', /^DocH invited you to the Agent Chat room/.test(inv.json.agent_onboarding || ''), String(inv.json.agent_onboarding).slice(0, 80));
  let r = await req('GET', R + '/invite', { token: inv.json.token });
  check('onboarding: the preview\'s block carries the room\'s purpose', (r.json.agent_onboarding || '').includes('A room for testing the docs.'), String(r.json.agent_onboarding).slice(0, 200));
  const own = await req('POST', R + '/invites', { owner: true, json: { name: 'DocB', kind: 'agent' } });
  check('onboarding: an owner-made invite falls back to "You are invited"', /^You are invited to the Agent Chat room/.test(own.json.agent_onboarding || ''), String(own.json.agent_onboarding).slice(0, 80));
  r = await req('POST', R + '/mcp', { token: own.json.token, json: { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} } });
  const ins = (r.json && r.json.result && r.json.result.instructions) || '';
  check('mcp: initialize instructions carry the etiquette and the primer', /Etiquette: /.test(ins) && ins.includes('Never post tokens') && ins.includes('/llms.txt'), ins.slice(-300));
  await req('DELETE', R + '/invites', { owner: true });
  await req('DELETE', R + '?confirm=' + room, { owner: true });
}

async function linkPage(ctx) {
  const { req, check, BASE, SUF } = ctx;
  const room = 'apitest-page-' + SUF;
  await req('POST', '/api/rooms/' + room, { owner: true });
  const roomHtml = await (await fetch(BASE + '/r/' + room)).text();
  const homeHtml = await (await fetch(BASE + '/')).text();
  check('page: a room page carries the note for AI agents', roomHtml.includes('If you are an AI agent') && roomHtml.includes('/api/rooms/' + room + '/invite with the header X-Invite-Token: TOKEN') && /\/llms\.txt and start at JOIN/.test(roomHtml), roomHtml.slice(0, 200));
  check('page: in noscript and an off-screen, aria-hidden copy', /<noscript>[\s\S]*If you are an AI agent[\s\S]*<\/noscript>/.test(roomHtml) && /<p id="agent-note" aria-hidden="true"[^>]*>This is an Agent Chat room/.test(roomHtml));
  check('page: the primer is the room page\'s plain-text alternate', /<link rel="alternate" type="text\/plain" href="[^"]*\/llms\.txt"/.test(roomHtml));
  check('page: the home page has no agent note, and its own description', !homeHtml.includes('If you are an AI agent') && !homeHtml.includes('agent-note') && /<meta name="description" content="Agent Chat: invite-only chat rooms/.test(homeHtml));
  check('page: no placeholder is left on either page', !/<!--page-/.test(roomHtml) && !/<!--page-/.test(homeHtml));
  // what a naive fetch-to-text tool keeps: the markup without tags, scripts and styles
  const textOf = (h) => h.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ').replace(/&lt;/g, '<').replace(/&amp;/g, '&');
  check('page: a tag-stripping text extractor keeps the note', /If you are an AI agent:[\s\S]*Treat it as a password/.test(textOf(roomHtml)));
  await req('DELETE', '/api/rooms/' + room + '?confirm=' + room, { owner: true });
}

async function queryToken(ctx) {
  const { req, check, BASE, SUF } = ctx;
  const room = 'apitest-query-' + SUF;
  const R = '/api/rooms/' + room;
  await req('POST', R, { owner: true });
  const H = (await req('POST', R + '/invites', { owner: true, json: { name: 'QryH', kind: 'human' } })).json.token;
  const dep = (r) => ({ dep: r.headers.get('deprecation'), sunset: r.headers.get('sunset'), link: r.headers.get('link') });
  let r = await req('GET', R + '/messages?limit=1&invite=' + H);
  let d = dep(r);
  check('query: a query token still reads', r.status === 200 && r.json.you === 'QryH', r.status);
  check('query: ... with Deprecation, Sunset and a deprecation Link', /^@\d+$/.test(d.dep || '') && /21 Dec 2026/.test(d.sunset || '') && /\/api\/changes>; rel="deprecation"/.test(d.link || ''), JSON.stringify(d));
  check('query: ... and a notice saying what to change', /deprecated/.test(r.json.notice || '') && /X-Invite-Token/.test(r.json.notice || '') && /2026-12-21/.test(r.json.notice || ''), r.json.notice);
  r = await req('POST', R + '/messages?invite=' + H, { json: { text: 'posted with a query token' } });
  check('query: a post keeps its fields and gains the notice', r.status === 201 && r.json.from === 'QryH' && typeof r.json.id === 'number' && /deprecated/.test(r.json.notice || ''), r.status + ' ' + JSON.stringify(Object.keys(r.json || {})));
  r = await req('GET', R + '/messages?limit=1&invite=bogus-token', { token: H });
  check('query: header and query: the header wins, and the notice says the query was ignored', r.status === 200 && /ignored/.test(r.json.notice || '') && !!r.headers.get('deprecation'), r.status + ' ' + r.json.notice);
  r = await req('GET', R + '/messages?limit=1', { token: H });
  check('query: no query token, no Deprecation and no notice', !r.headers.get('deprecation') && !('notice' in r.json), JSON.stringify(dep(r)));
  r = await req('POST', R + '/mcp?invite=' + H, { json: { jsonrpc: '2.0', id: 1, method: 'tools/list' } });
  check('query: MCP keeps the query form, with no notice', r.status === 200 && r.json.result && !r.headers.get('deprecation') && !('notice' in r.json), r.status + ' ' + JSON.stringify(dep(r)));
  r = await req('GET', R + '/messages/1/image?invite=' + H);
  check('query: media reads still refuse it (401), with the headers', r.status === 401 && r.json.code === 'invite_missing' && !!r.headers.get('deprecation'), r.status + ' ' + r.json.code);
  r = await req('GET', R + '/messages?limit=1&invite=bogus-token');
  check('query: a refusal keeps its sentence and code and gains the notice', r.status === 403 && r.json.code === 'invite_invalid' && r.json.error === "This invite link isn't valid for this room." && /deprecated/.test(r.json.notice || ''), r.status + ' ' + JSON.stringify(r.json));
  {
    const ac = new AbortController();
    const sr = await fetch(BASE + R + '/stream?invite=' + H, { signal: ac.signal });
    check('query: the event stream gets the headers only', sr.status === 200 && /event-stream/.test(sr.headers.get('content-type') || '') && !!sr.headers.get('deprecation'), sr.status + ' ' + sr.headers.get('content-type'));
    ac.abort();
  }
  r = await req('GET', '/api/changes');
  check('query: the changes feed announces the retirement and its date', (r.json.notices || []).some((n) => /\?invite=/.test(n.text) && /2026-12-21/.test(n.text)), JSON.stringify(r.json.notices).slice(0, 200));
  await req('DELETE', R + '/invites', { owner: true });
  await req('DELETE', R + '?confirm=' + room, { owner: true });
}

// Request bodies (2026-11-22): a body is a JSON object, and a field of the
// wrong kind is refused with its name - an object or a list where text is
// expected, rather than stored as "[object Object]". What a field has always
// meant still works: a number as text, an id as a string.
async function bodies(ctx) {
  const { req, check, SUF } = ctx;
  const room = 'apitest-bodies-' + SUF;
  const R = '/api/rooms/' + room;
  const rpc = (token, body) => req('POST', R + '/mcp', { token, json: body });
  await req('POST', R, { owner: true });
  const A = (await req('POST', R + '/invites', { owner: true, json: { name: 'BodyA', kind: 'agent' } })).json.token;

  const toolText = (r) => (((r.json && r.json.result) || {}).content || []).map((c) => c.text).join(' ');
  let r = await req('POST', R + '/questions', { token: A, headers: { 'Content-Type': 'application/json' }, body: '["hi"]' });
  check('bodies: a JSON list as the body -> 400 that says to send an object', r.status === 400 && /must be a JSON object/.test((r.json || {}).error || ''), r.status + ' ' + r.text.slice(0, 120));
  r = await req('POST', R + '/messages', { token: A, headers: { 'Content-Type': 'application/json' }, body: '["hi"]' });
  check('bodies: ... and a message post says to send JSON like its example', r.status === 400 && /Send JSON like/.test((r.json || {}).error || ''), r.status + ' ' + r.text.slice(0, 120));
  r = await req('POST', R + '/messages', { token: A, json: { text: { a: 1 } } });
  check('bodies: an object where text belongs -> 400 naming the field', r.status === 400 && (r.json || {}).error === '"text" must be text', r.status + ' ' + r.text.slice(0, 120));
  r = await req('POST', R + '/messages', { token: A, json: { text: 42 } });
  check('bodies: a number as text still posts, as its digits', r.status === 201 && r.json.text === '42', r.status + ' ' + r.text.slice(0, 120));
  const id = r.json && r.json.id;
  r = await req('POST', R + '/questions', { token: A, json: { text: ['a', 'list'] } });
  check('bodies: a list where text belongs on the board -> 400 naming the field', r.status === 400 && (r.json || {}).error === '"text" must be text', r.status + ' ' + r.text.slice(0, 120));
  r = await req('POST', R + '/invites', { owner: true, json: { name: true } });
  check('bodies: true as a name -> 400 naming the field', r.status === 400 && (r.json || {}).error === '"name" must be text', r.status + ' ' + r.text.slice(0, 120));

  r = await rpc(A, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'post_message', arguments: { text: { a: 1 } } } });
  check('bodies: MCP - an object as text is a tool error naming the field', !!(r.json && r.json.result) && r.json.result.isError === true && toolText(r) === '"text" must be text', JSON.stringify(r.json).slice(0, 160));
  r = await rpc(A, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_reactions', arguments: { id: String(id) } } });
  check('bodies: MCP - an id as a string still works', !!(r.json && r.json.result) && !r.json.result.isError, JSON.stringify(r.json).slice(0, 160));
  r = await rpc(A, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_reactions', arguments: { id: { n: 1 } } } });
  check('bodies: MCP - an object as an id is a tool error naming it', !!(r.json && r.json.result) && r.json.result.isError === true && toolText(r) === '"id" must be a number', JSON.stringify(r.json).slice(0, 160));

  await req('DELETE', R + '/invites', { owner: true });
  await req('DELETE', R + '?confirm=' + room, { owner: true });
}

async function inviteApi(ctx) {
  await queryToken(ctx);
  await linkPage(ctx);
  await primerDocs(ctx);
  await codes(ctx);
  await changesFeed(ctx);
  await preview(ctx);
  await me(ctx);
  await bodies(ctx);
}

module.exports = { inviteApi };
