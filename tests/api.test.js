// API smoke tests against a real local Worker (wrangler dev).
// Covers the server behaviors the UI suite cannot: access rules, the
// invite-only invariants, public room creation (validation, name race
// surface, rollback on email failure), publish-on-complete, draft-media
// privacy, and room destruction. Exits non-zero on any failure.
//
//   npm run test:api
//
// Uses port 8798 and a throwaway .dev.vars (backed up and restored).
// Hermetic: room names, emails and client IPs are unique per run - the
// create-room caps count attempts in the persistent local KV, so reusing
// identities makes the suite fail on its own leftovers.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = 8798;
const BASE = 'http://localhost:' + PORT;
const OWNER = 'api-test-owner-key';
const SUF = Date.now().toString(36);
// Per-run client IPs for the create-room checks: the creation caps count
// attempts per IP in the persistent local KV, so fixed literals exhaust
// their daily budget after a few same-day runs and fail as 429s.
const IPO = '10.' + (20 + (parseInt(SUF, 36) % 180)) + '.0.';
const DEV_VARS = path.join(ROOT, '.dev.vars');

let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log('ok   ' + name);
  else { failures++; console.log('FAIL ' + name + (extra !== undefined ? ' -> ' + extra : '')); }
}

async function req(method, p, opts) {
  opts = opts || {};
  const headers = Object.assign({}, opts.headers || {});
  if (opts.owner) headers['X-Owner-Key'] = OWNER;
  if (opts.token) headers['X-Invite-Token'] = opts.token;
  let body = opts.body;
  if (opts.json !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(opts.json); }
  const r = await fetch(BASE + p, { method, headers, body });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) {}
  return { status: r.status, json, text, headers: r.headers };
}

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
function mp4() {
  const b = Buffer.alloc(48);
  b.writeUInt32BE(24, 0); b.write('ftypisom', 4); b.writeUInt32BE(16, 12); b.write('isomiso2', 16);
  b.writeUInt32BE(24, 24); b.write('mvhd', 28);
  return b;
}

async function waitUp() {
  for (let i = 0; i < 90; i++) {
    try { const r = await fetch(BASE + '/api'); if (r.status) return true; } catch (e) {}
    await new Promise(r => setTimeout(r, 1000));
  }
  return false;
}

(async () => {
  const hadVars = fs.existsSync(DEV_VARS);
  const backup = hadVars ? fs.readFileSync(DEV_VARS) : null;
  fs.writeFileSync(DEV_VARS, 'OWNER_KEY=' + OWNER + '\nRESEND_API_KEY=re_fake_for_tests\n');
  const child = spawn('npx', ['wrangler', 'dev', '--port', String(PORT)], { cwd: ROOT, detached: true, stdio: 'ignore' });
  try {
    check('wrangler dev comes up', await waitUp());
    const R = '/api/rooms/apitest-main-' + SUF;
    let r = await req('POST', R, { owner: true });
    check('owner creates room', r.status === 201, r.status);
    r = await req('GET', R + '/messages?limit=1');
    check('no token -> 401', r.status === 401, r.status);
    r = await req('GET', R + '/messages?limit=1', { token: 'bogus-token' });
    check('bad token -> 403', r.status === 403, r.status);
    const invA = await req('POST', R + '/invites', { owner: true, json: { name: 'ApiA', kind: 'human' } });
    const invB = await req('POST', R + '/invites', { owner: true, json: { name: 'ApiB', kind: 'agent' } });
    const TA = invA.json.token, TB = invB.json.token;
    check('invites minted', !!TA && !!TB);
    r = await req('GET', R + '/messages?limit=1', { token: TA });
    check('valid token -> 200', r.status === 200, r.status);

    // Draft media privacy.
    const draft = await req('POST', R + '/messages', { token: TA, json: { from: 'ApiA', text: 'draft pic', draft: true } });
    const did = draft.json.id;
    r = await req('PUT', R + '/messages/' + did + '/image', { token: TA, headers: { 'Content-Type': 'image/png' }, body: PNG });
    check('attach image to draft', r.status === 200, r.status);
    r = await req('GET', R + '/messages/' + did + '/image?invite=' + TB);
    check('other member cannot read draft media', r.status === 404, r.status);
    r = await req('GET', R + '/messages/' + did + '/image?invite=' + TA);
    check('sender reads own draft media', r.status === 200, r.status);
    r = await req('POST', R + '/messages/' + did + '/publish', { token: TA, json: {} });
    check('publish works', r.status === 200, r.status);
    r = await req('GET', R + '/messages/' + did + '/image?invite=' + TB);
    check('published media is room-visible', r.status === 200, r.status);

    // Revocation.
    const invC = await req('POST', R + '/invites', { owner: true, json: { name: 'ApiC', kind: 'agent' } });
    await req('DELETE', R + '/invites/' + invC.json.token, { owner: true });
    r = await req('GET', R + '/messages?limit=1', { token: invC.json.token });
    check('revoked token -> 403', r.status === 403, r.status);

    // Public creation: existed / validation / send-failure rollback.
    r = await req('POST', '/api/create-room', { headers: { 'CF-Connecting-IP': IPO + '1' }, json: { room: 'apitest-main-' + SUF, name: 'X', email: 'x-' + SUF + '@example.com' } });
    check('create existing -> 409', r.status === 409, r.status);
    r = await req('POST', '/api/create-room', { headers: { 'CF-Connecting-IP': IPO + '2' }, json: { room: 'Bad Name!', name: 'X', email: 'x-' + SUF + '@example.com' } });
    check('create bad name -> 400', r.status === 400, r.status);
    r = await req('POST', '/api/create-room', { headers: { 'CF-Connecting-IP': IPO + '3' }, json: { room: 'apitest-rb-' + SUF, name: 'Rb', email: 'rb-' + SUF + '@example.com' } });
    check('send failure -> 502', r.status === 502, r.status);
    r = await req('GET', '/api/rooms/apitest-rb-' + SUF + '/members', { owner: true });
    check('rolled-back room is gone', r.status === 404, r.status);

    // invite_only invariants.
    r = await req('GET', R + '/members', { owner: true });
    check('members say invite_only', r.json && r.json.invite_only === true, JSON.stringify(r.json && r.json.invite_only));
    r = await req('DELETE', R + '/invites', { owner: true });
    check('delete-invites says invite_only', r.json && r.json.invite_only === true, JSON.stringify(r.json));
    r = await req('GET', R + '/members', { owner: true });
    check('zero-invite room still invite_only', r.json && r.json.invite_only === true && r.json.members.length === 0);

    // Publish-on-complete + destruction (second room).
    const R2 = '/api/rooms/apitest-poc-' + SUF;
    await req('POST', R2, { owner: true });
    const invP = await req('POST', R2 + '/invites', { owner: true, json: { name: 'Poc', kind: 'human' } });
    const TP = invP.json.token;
    const pd = await req('POST', R2 + '/messages', { token: TP, json: { from: 'Poc', text: 'poc', draft: true, publish_on_complete: true } });
    r = await req('PUT', R2 + '/messages/' + pd.json.id + '/video/stream', { token: TP, headers: { 'Content-Type': 'video/mp4' }, body: mp4() });
    check('stream upload auto-publishes', r.json && r.json.published === true, JSON.stringify(r.json));
    r = await req('GET', R2 + '/messages?limit=3', { token: TP });
    check('auto-published message is listed', (r.json.messages || []).some(m => m.id === pd.json.id && m.video), JSON.stringify(r.json.messages && r.json.messages.length));
    // HTML artifacts and Markdown documents (second room, member Poc).
    const HTML = '<!doctype html><title>Probe</title><p style="color:red">hello artifact</p>';
    const MD = '# Probe doc\n\nSome **markdown** body.\n';
    r = await req('POST', R2 + '/messages', { token: TP, json: { from: 'Poc', text: 'with attachments', html: HTML, html_name: 'Probe Page', doc: MD, doc_name: 'probe.md' } });
    check('post with html+doc -> 201', r.status === 201, r.status);
    const amid = r.json && r.json.id;
    check('post response carries html meta', !!(r.json && r.json.html && r.json.html.name === 'Probe Page' && r.json.html.bytes === Buffer.byteLength(HTML)), JSON.stringify(r.json && r.json.html));
    check('post response carries doc meta', !!(r.json && r.json.doc && r.json.doc.name === 'probe.md' && r.json.doc.bytes === Buffer.byteLength(MD)), JSON.stringify(r.json && r.json.doc));
    r = await req('GET', R2 + '/messages?limit=5', { token: TP });
    check('list carries html+doc', (r.json.messages || []).some(m => m.id === amid && m.html && m.doc), 'listed');
    r = await req('GET', R2 + '/messages/' + amid + '/html', { token: TP });
    check('html serves 200 text/html', r.status === 200 && (r.headers.get('content-type') || '').includes('text/html'), r.status + ' ' + r.headers.get('content-type'));
    check('html serves artifact CSP', (r.headers.get('content-security-policy') || '').includes('sandbox allow-scripts'), r.headers.get('content-security-policy'));
    check('html body round-trips', r.text === HTML, r.text.slice(0, 60));
    r = await req('GET', R2 + '/messages/' + amid + '/doc', { token: TP });
    check('doc serves 200 with markdown body', r.status === 200 && r.text === MD, r.status + ' ' + r.text.slice(0, 40));
    r = await req('GET', R2 + '/messages/' + amid + '/html', {});
    check('html denied without access', r.status === 401 || r.status === 403 || r.status === 404, r.status);
    r = await req('POST', R2 + '/messages', { token: TP, json: { from: 'Poc', text: 'x', html: 'not markup at all' } });
    check('non-markup html -> 415', r.status === 415, r.status);
    r = await req('POST', R2 + '/messages', { token: TP, json: { from: 'Poc', text: 'x', doc: '   ' } });
    check('empty doc -> 400', r.status === 400, r.status);
    r = await req('POST', R2 + '/messages', { token: TP, json: { from: 'Poc', text: 'x', html: HTML, draft: true } });
    check('draft + html -> 400', r.status === 400, r.status);

    // Games: Light Cycles end to end - create, legal moves, simultaneous
    // resolution, the referee's finish post, the room_state nudge, and the
    // lazy clock (an expired tick sends every bike straight).
    const invRex = await req('POST', R2 + '/invites', { owner: true, json: { name: 'Rex', kind: 'agent' } });
    const invRae = await req('POST', R2 + '/invites', { owner: true, json: { name: 'Rae', kind: 'agent' } });
    const TRex = invRex.json.token, TRae = invRae.json.token;
    await req('GET', R2 + '/members', { token: TRex });
    await req('GET', R2 + '/members', { token: TRae });
    r = await req('POST', R2 + '/games', { token: TP, json: { from: 'Poc', players: ['Poc', 'Rex', 'Ghost'] } });
    check('game with a non-member -> 400', r.status === 400, r.status);
    r = await req('POST', R2 + '/games', { token: TP, json: { from: 'Poc', players: ['Poc', 'Rex', 'Rae'], tick_seconds: 3600, w: 12, h: 10 } });
    check('game created', r.status === 201 && r.json.game && r.json.game.status === 'running', r.status + ' ' + JSON.stringify(r.json).slice(0, 160));
    const G = r.json.game; const gid = G.id;
    check('spawn + legal moves', G.players[0].x === 3 && G.players[0].y === 5 && G.you.legal_moves.join() === 'up,down,right', JSON.stringify(G.players[0]) + ' ' + JSON.stringify(G.you));
    r = await req('GET', R2 + '/messages?limit=5', { token: TP });
    const card = (r.json.messages || []).find(x => x.game && x.game.id === gid);
    check('card message carries the game', !!card, JSON.stringify(r.json).slice(0, 120));
    r = await req('POST', R2 + '/games/' + gid + '/moves', { token: TP, json: { dir: 'left' } });
    check('reverse move -> 400 with legal_moves', r.status === 400 && Array.isArray(r.json.legal_moves) && !r.json.legal_moves.includes('left'), r.status + ' ' + JSON.stringify(r.json));
    r = await req('POST', R2 + '/games/' + gid + '/moves', { token: TP, json: { dir: 'warp' } });
    check('bogus dir -> 400', r.status === 400, r.status);
    const invRook = await req('POST', R2 + '/invites', { owner: true, json: { name: 'Rook', kind: 'agent' } });
    await req('GET', R2 + '/members', { token: invRook.json.token });
    r = await req('POST', R2 + '/games/' + gid + '/moves', { token: invRook.json.token, json: { dir: 'up' } });
    check('non-player move -> 403', r.status === 403, r.status);
    // The lazy-clock match: created now and left untouched; a later read
    // must show its expired tick resolved with everyone sent straight.
    r = await req('POST', R2 + '/games', { token: TP, json: { from: 'Poc', players: ['Poc', 'Rex'], tick_seconds: 30, w: 12, h: 10 } });
    const clockId = r.json.game.id;
    r = await req('POST', R2 + '/games/' + gid + '/moves', { token: TP, json: { dir: 'down' } });
    check('queue a move', r.status === 200 && r.json.game.you.queued === 'down' && r.json.resolved === false, r.status + ' ' + JSON.stringify(r.json).slice(0, 140));
    await req('POST', R2 + '/games/' + gid + '/moves', { token: TRex, json: { dir: 'up' } });
    r = await req('POST', R2 + '/games/' + gid + '/moves', { token: TRae, json: { dir: 'left' } });
    check('last move resolves the tick', r.status === 200 && r.json.resolved === true && r.json.game.tick === 1, r.status + ' ' + JSON.stringify(r.json).slice(0, 140));
    r = await req('GET', R2 + '/messages?limit=10', { token: TP });
    const tickPost = (r.json.messages || []).find(x => x.from === 'Referee' && x.text.includes('match #' + gid + ' - tick 1 resolved'));
    check('referee posts the tick and calls the awaited', !!tickPost && tickPost.text.includes('@Poc') && tickPost.text.includes('@Rex') && tickPost.text.includes('@Rae'), JSON.stringify(tickPost || (r.json.messages || []).map(x => x.from + ': ' + String(x.text).slice(0, 60))));
    const toks = { Poc: TP, Rex: TRex, Rae: TRae };
    let final = null;
    for (let i = 0; i < 16 && !final; i++) {
      const st = await req('GET', R2 + '/games/' + gid, { token: TP });
      if (st.json.game.status === 'finished') { final = st.json.game; break; }
      for (const p of st.json.game.players) {
        if (!p.alive) continue;
        await req('POST', R2 + '/games/' + gid + '/moves', { token: toks[p.name], json: { dir: p.dir } });
      }
    }
    check('match finishes with a record', !!final && !!final.record_keeper && final.log.length >= 2, JSON.stringify(final).slice(0, 160));
    r = await req('POST', R2 + '/games/' + gid + '/moves', { token: TP, json: { dir: 'up' } });
    check('move after finish -> 409', r.status === 409, r.status);
    r = await req('GET', R2 + '/messages?limit=50', { token: TP });
    check('referee posted the result', (r.json.messages || []).some(x => x.from === 'Referee' && x.text.includes('match #' + gid)), JSON.stringify((r.json.messages || []).map(x => x.from)));
    check('no tick post for the finishing tick', !(r.json.messages || []).some(x => x.from === 'Referee' && x.text.includes('match #' + gid + ' - tick ' + final.tick + ' resolved')), JSON.stringify((r.json.messages || []).filter(x => x.from === 'Referee').map(x => x.text.slice(0, 60))));
    const nudged = ((r.json.room_state && r.json.room_state.awaiting_you) || []).some(x => x.type === 'game' && x.id === clockId);
    check('room_state nudges the clock match', nudged, JSON.stringify(r.json.room_state).slice(0, 200));
    await new Promise(res => setTimeout(res, 31000));
    r = await req('GET', R2 + '/games/' + clockId, { token: TP });
    check('expired tick sends bikes straight', r.json.game.tick >= 1 && r.json.game.players[0].x >= 4 && r.json.game.players[0].alive, JSON.stringify(r.json.game.players));
    // Cancel: only the creator (or the owner) can stop a match; a cancelled
    // match takes no moves and gets no result post.
    r = await req('POST', R2 + '/games/' + clockId + '/cancel', { token: TRex, json: {} });
    check('cancel by non-creator -> 403', r.status === 403, r.status);
    r = await req('POST', R2 + '/games/' + clockId + '/cancel', { token: TP, json: {} });
    check('creator cancels the match', r.status === 200 && r.json.game.status === 'cancelled' && (r.json.game.awaiting || []).length === 0, r.status + ' ' + JSON.stringify(r.json).slice(0, 160));
    r = await req('POST', R2 + '/games/' + clockId + '/cancel', { token: TP, json: {} });
    check('cancel again -> 200, still cancelled', r.status === 200 && r.json.game.status === 'cancelled', r.status);
    r = await req('POST', R2 + '/games/' + clockId + '/moves', { token: TP, json: { dir: 'up' } });
    check('move after cancel -> 409', r.status === 409, r.status);
    r = await req('GET', R2 + '/messages?limit=50', { token: TP });
    check('no result post for a cancelled match', !(r.json.messages || []).some(x => x.from === 'Referee' && x.text.includes('match #' + clockId + ' is over')), JSON.stringify((r.json.messages || []).filter(x => x.from === 'Referee').map(x => x.text.slice(0, 60))));

    // MCP endpoint: the room as a tool surface. Handshake, role-filtered
    // catalog, identity fixed by the credential, and the daily-driver tools
    // delegating to the same engine as REST.
    async function mcp(roomPath, method, params, opts) {
      opts = opts || {};
      return await req('POST', roomPath + '/mcp', Object.assign({}, opts, { json: { jsonrpc: '2.0', id: 7, method: method, params: params } }));
    }
    r = await req('GET', R2 + '/mcp', { token: TP });
    check('mcp GET -> 405', r.status === 405, r.status);
    r = await req('POST', R2 + '/mcp', { headers: { 'Content-Type': 'application/json' }, body: 'not json' });
    check('mcp garbage -> -32700', r.status === 400 && r.json && r.json.error && r.json.error.code === -32700, r.status + ' ' + r.text.slice(0, 80));
    r = await mcp(R2, 'tools/call', { name: 'whoami', arguments: {} });
    check('mcp unauthenticated tools/call -> -32001', !!(r.json && r.json.error && r.json.error.code === -32001), JSON.stringify(r.json).slice(0, 120));
    r = await mcp(R2, 'initialize', { protocolVersion: '2025-03-26', capabilities: {} }, { token: TP });
    check('mcp initialize handshake', !!(r.json && r.json.result && r.json.result.serverInfo && r.json.result.serverInfo.name === 'agent-chat' && r.json.result.protocolVersion === '2025-03-26'), JSON.stringify(r.json).slice(0, 160));
    r = await req('POST', R2 + '/mcp', { token: TP, json: { jsonrpc: '2.0', method: 'notifications/initialized' } });
    check('mcp notification -> bare 202', r.status === 202 && r.text === '', r.status + ' ' + r.text.slice(0, 40));
    r = await mcp(R2, 'tools/list', {}, { token: TP });
    const toolNames = ((r.json && r.json.result && r.json.result.tools) || []).map(t => t.name);
    check('mcp catalog lists the surface', toolNames.includes('post_message') && toolNames.includes('begin_upload') && toolNames.includes('submit_move') && toolNames.includes('react') && toolNames.length >= 25, toolNames.join(',').slice(0, 200));
    const toolByName = {}; for (const t of ((r.json && r.json.result && r.json.result.tools) || [])) toolByName[t.name] = t;
    check('mcp reads carry readOnlyHint, writes do not', !!(toolByName.list_messages && toolByName.list_messages.annotations && toolByName.list_messages.annotations.readOnlyHint === true && toolByName.post_message && !toolByName.post_message.annotations), JSON.stringify(toolByName.list_messages && toolByName.list_messages.annotations));
    r = await mcp(R2, 'tools/call', { name: 'whoami', arguments: {} }, { token: TP });
    check('mcp whoami names the invite holder', !!(r.json && r.json.result && r.json.result.structuredContent && r.json.result.structuredContent.name === 'Poc'), JSON.stringify(r.json).slice(0, 160));
    r = await mcp(R2, 'tools/call', { name: 'post_message', arguments: { text: 'hello over mcp', as: 'Rex' } }, { token: TP });
    const mcpMsg = r.json && r.json.result && r.json.result.structuredContent;
    check('mcp post lands as the invite holder (as ignored)', !!mcpMsg && mcpMsg.from === 'Poc' && !!mcpMsg.id, JSON.stringify(r.json).slice(0, 200));
    r = await req('GET', R2 + '/messages?limit=10', { token: TP });
    check('mcp post visible over REST', (r.json.messages || []).some(x => x.id === (mcpMsg && mcpMsg.id) && x.from === 'Poc' && x.text === 'hello over mcp'), JSON.stringify((r.json.messages || []).map(x => x.from + ':' + x.text)).slice(0, 160));
    r = await mcp(R2, 'tools/call', { name: 'react', arguments: { id: mcpMsg.id, reaction: '👍' } }, { token: TRex });
    check('mcp react works', !!(r.json && r.json.result && !r.json.result.isError && r.json.result.structuredContent && (r.json.result.structuredContent.reactions || {})['👍']), JSON.stringify(r.json).slice(0, 200));
    r = await mcp(R2, 'tools/call', { name: 'no_such_tool', arguments: {} }, { token: TP });
    check('mcp unknown tool -> isError', !!(r.json && r.json.result && r.json.result.isError === true), JSON.stringify(r.json).slice(0, 160));
    r = await mcp(R2, 'tools/call', { name: 'create_game', arguments: { players: ['Poc', 'Rex'], tick_seconds: 3600, w: 12, h: 10 } }, { token: TP });
    const mcpGame = r.json && r.json.result && r.json.result.structuredContent && r.json.result.structuredContent.game;
    check('mcp game created', !!mcpGame && mcpGame.status === 'running', JSON.stringify(r.json).slice(0, 200));
    await mcp(R2, 'tools/call', { name: 'submit_move', arguments: { id: mcpGame.id, dir: 'down' } }, { token: TP });
    r = await mcp(R2, 'tools/call', { name: 'submit_move', arguments: { id: mcpGame.id, dir: 'up' } }, { token: TRex });
    check('mcp moves resolve a tick', !!(r.json && r.json.result && r.json.result.structuredContent && r.json.result.structuredContent.resolved === true && r.json.result.structuredContent.game.tick === 1), JSON.stringify(r.json).slice(0, 200));
    r = await mcp(R2, 'tools/call', { name: 'cancel_game', arguments: { id: mcpGame.id } }, { token: TP });
    check('mcp cancel stops the match', !!(r.json && r.json.result && r.json.result.structuredContent && r.json.result.structuredContent.game.status === 'cancelled'), JSON.stringify(r.json).slice(0, 200));
    r = await mcp(R2, 'tools/call', { name: 'begin_upload', arguments: { kind: 'image', text: 'mcp delegated upload' } }, { token: TP });
    const up = r.json && r.json.result && r.json.result.structuredContent;
    check('mcp begin_upload returns a REST session', !!up && !!up.message_id && up.upload && up.upload.method === 'PUT' && String(up.upload.url).includes('/messages/' + up.message_id + '/image'), JSON.stringify(r.json).slice(0, 220));
    r = await req('PUT', R2 + '/messages/' + up.message_id + '/image', { token: TP, headers: { 'Content-Type': 'image/png' }, body: PNG });
    check('delegated bytes land over REST', r.status === 200, r.status);
    r = await mcp(R2, 'tools/call', { name: 'publish_message', arguments: { id: up.message_id } }, { token: TP });
    check('mcp publish completes the upload', !!(r.json && r.json.result && !r.json.result.isError && r.json.result.structuredContent && r.json.result.structuredContent.id === up.message_id), JSON.stringify(r.json).slice(0, 200));
    r = await req('GET', R2 + '/messages?limit=10', { token: TRex });
    check('delegated upload is room-visible', (r.json.messages || []).some(x => x.id === up.message_id && x.image), JSON.stringify((r.json.messages || []).map(x => x.id)).slice(0, 120));

    await req('DELETE', R2 + '/invites', { owner: true });
    r = await req('DELETE', R2 + '?confirm=apitest-poc-' + SUF, { owner: true });
    check('room destroyed', r.json && r.json.deleted === true, JSON.stringify(r.json));
    r = await req('GET', R2 + '/members', { owner: true });
    check('destroyed room 404s', r.status === 404, r.status);

    // Build id: /api/build reports it, and both served pages carry the
    // same id stamped over the placeholder (no literal left behind).
    r = await req('GET', '/api/build');
    const bid = r.json && r.json.build;
    check('build id shape', /^[0-9a-f]{16}$/.test(bid || ''), JSON.stringify(r.json));
    const homeTxt = await (await fetch(BASE + '/')).text();
    const roomTxt = await (await fetch(BASE + '/r/apitest-main-' + SUF)).text();
    const metaOf = (t) => { const mm = t.match(/<meta name="build" content="([^"]*)">/); return mm && mm[1]; };
    check('home page stamped with the build id', metaOf(homeTxt) === bid, metaOf(homeTxt));
    check('room page stamped with the build id', metaOf(roomTxt) === bid, metaOf(roomTxt));
    check('no unstamped placeholder served', !homeTxt.includes('__BUILD_ID__') && !roomTxt.includes('__BUILD_ID__'));

    // Clean up room one.
    await req('DELETE', R + '?confirm=apitest-main-' + SUF, { owner: true });
  } finally {
    try { process.kill(-child.pid, 'SIGKILL'); } catch (e) {}
    if (backup) fs.writeFileSync(DEV_VARS, backup); else try { fs.unlinkSync(DEV_VARS); } catch (e) {}
  }
  console.log(failures ? 'API SUITE: ' + failures + ' failure(s)' : 'API SUITE: all checks passed');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error('API SUITE crashed: ' + (e && e.stack || e)); process.exit(1); });
