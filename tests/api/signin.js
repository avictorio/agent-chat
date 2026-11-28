// The sign-in for known apps against a real local Worker
// (worker/routes/oauth.ts, the sign-in address in worker/routes/agent.ts):
// first Muse, a pinned public client whose Client ID the person types
// (muse), with plain requests as its connector sends them: the authorize
// page, the approval, the code exchange, a tool call, a refresh and a
// revoke; then a second sign-in refreshed twice (the second naming the
// client only in a Basic header) whose first refresh token, presented again
// once OAUTH_REFRESH_GRACE_S has passed (checked at the end, so the wait
// overlaps the rest), ends it. Then
// two stand-in apps put on this local server by its test hook (TEST_HOOKS
// only), a public one with a loopback redirect and a poppy one with its key
// set inline (ES256 and PS384), the second once with DPoP proofs and once
// without. For each: the authorize page, the approval with a person's
// invites in two rooms, the code exchange, the address's tools, a post in
// each room as the agent the person invited (no invite link in any answer),
// a refresh, a revoke, and the access token refused after it. Then a
// re-approval that reuses the seats and the wakes both connections register
// (the fake Muse): the first revoke leaves the wake, the second turns it
// off; the disconnect-only code; a key on the same seat whose disconnect
// lets go and leaves the sign-in's wake; and the times of an approval of
// AGENT_ROOMS_MAX rooms, a refresh, and a revoke letting go of as many
// wakes. Called from api.test.js; its rooms are its own
// (apitest-signin-*), deleted at the end. Every key, token and code is made
// here, and none is printed.
'use strict';

const { museGadget, handover } = require('./muse-hooks.js');

const enc = new TextEncoder();
const b64 = (u8) => Buffer.from(u8).toString('base64url');
const b64json = (v) => b64(enc.encode(JSON.stringify(v)));
async function keyPair(alg, kid) {
  const params = alg === 'ES256' ? { name: 'ECDSA', namedCurve: 'P-256' } : { name: 'RSA-PSS', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-384' };
  const kp = await crypto.subtle.generateKey(params, true, ['sign', 'verify']);
  const full = await crypto.subtle.exportKey('jwk', kp.publicKey);
  const jwk = alg === 'ES256' ? { kty: 'EC', crv: 'P-256', x: full.x, y: full.y } : { kty: 'RSA', n: full.n, e: full.e };
  if (kid) jwk.kid = kid;
  return { alg, privateKey: kp.privateKey, jwk };
}
async function jws(pair, header, payload) {
  const input = b64json(header) + '.' + b64json(payload);
  const algo = pair.alg === 'ES256' ? { name: 'ECDSA', hash: 'SHA-256' } : { name: 'RSA-PSS', saltLength: 48 };
  return input + '.' + b64(new Uint8Array(await crypto.subtle.sign(algo, pair.privateKey, enc.encode(input))));
}
const nowS = () => Math.floor(Date.now() / 1000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let n = 0;
const jti = () => 'jti-' + Date.now() + '-' + (++n) + '-' + Math.random().toString(36).slice(2);

async function signinApi(ctx) {
  const { req, check, SUF } = ctx;
  // the sign-in's issuer on this local server (its own address: worker/lib/oauth.ts signinOrigin)
  const ORIGIN = String(((await req('GET', '/.well-known/oauth-authorization-server')).json || {}).issuer || '');
  const ADDRESS = ORIGIN + '/api/mcp/signin';
  const LIM = await import('../../worker/limits.ts');
  // no document names the key's address or a room's as a resource: those paths stay a 404 (a document
  // there would make an MCP client sign in at an address that takes no sign-in)
  for (const p of ['/.well-known/oauth-protected-resource/api/mcp', '/.well-known/oauth-protected-resource/api/rooms/apitest-signin-' + SUF + '/mcp']) {
    const r = await req('GET', p);
    check('signin: ' + p.replace(SUF, 'SUF') + ' is a 404', r.status === 404 && !(r.json && r.json.resource), r.status + ' ' + r.text.slice(0, 80));
  }
  const made = [];
  const room = async (tag) => {
    const name = 'apitest-signin-' + SUF + '-' + tag;
    const r = await req('POST', '/api/rooms/' + name, { owner: true });
    if (r.status === 201) made.push(name);
    return name;
  };
  const invite = async (name, who, kind) => ((await req('POST', '/api/rooms/' + name + '/invites', { owner: true, json: { name: who, kind } })).json || {}).token;
  const join = (name, tok) => req('GET', '/api/rooms/' + name + '/messages?limit=1', { token: tok });
  let ipn = 0;
  const ip = () => '10.77.' + (parseInt(SUF, 36) % 200) + '.' + (++ipn % 250);
  const same = { 'Sec-Fetch-Site': 'same-origin' };
  const form = (p, fields, headers) => {
    const body = new URLSearchParams();
    for (const [k, v] of Object.entries(fields)) if (v !== undefined && v !== null) body.append(k, v);
    return req('POST', p, { body: body.toString(), headers: Object.assign({ 'Content-Type': 'application/x-www-form-urlencoded', 'CF-Connecting-IP': ip() }, headers || {}) });
  };
  const rpc = (bearer, body) => req('POST', '/api/mcp/signin', { json: body, headers: bearer ? { Authorization: 'Bearer ' + bearer } : {} });
  const tool = async (bearer, name, args) => ((await rpc(bearer, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })).json || {});
  const pkce = async () => { const verifier = b64(crypto.getRandomValues(new Uint8Array(32))); return { verifier, challenge: b64(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(verifier)))) }; };
  const proofOf = (pair) => jws(pair, { typ: 'dpop+jwt', alg: pair.alg, jwk: pair.jwk }, { jti: jti(), htm: 'POST', htu: ORIGIN + '/api/oauth/token', iat: nowS() });

  // the stand-in apps, on this local server only
  const es = await keyPair('ES256', 'es-1'), ps = await keyPair('PS384', 'ps-1');
  const PUB = { key: 'apitest-public', client_id: 'https://standin.example/apitest/' + SUF + '/public.json', kind: 'public', name: 'Stand-in', host: 'standin.example', redirect_uris: ['http://127.0.0.1/callback'], loopback: true, page: 'agent' };
  const POP = { key: 'apitest-poppy', client_id: 'https://agent.example/apitest/' + SUF + '/poppy', kind: 'poppy', name: 'Stand-in agent', host: 'agent.example', redirect_uris: ['https://agent.example/callback'], loopback: false, page: 'agent', jwks: { keys: [es.jwk, ps.jwk] } };
  for (const app of [PUB, POP]) {
    const r = await req('POST', '/api/test-hooks/oauth-app', { owner: true, json: { app } });
    check('signin: the stand-in app is known on this local server (' + app.kind + ')', r.status === 200, r.text.slice(0, 120));
  }
  const auth = async (app, pair) => (app.kind === 'public' ? { client_id: app.client_id } : { client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer', client_assertion: await jws(pair || es, { alg: (pair || es).alg, kid: (pair || es).jwk.kid }, { iss: app.client_id, sub: app.client_id, aud: ORIGIN, iat: nowS(), exp: nowS() + 120, jti: jti() }) });

  /** authorize, approve (rooms: [{room, inviter}]), exchange the code */
  async function connect(app, rooms, o = {}) {
    const { verifier, challenge } = await pkce();
    const q = new URLSearchParams({ response_type: 'code', client_id: app.client_id, redirect_uri: app.loopback ? 'http://127.0.0.1:43999/callback' : app.redirect_uris[0], code_challenge: challenge, code_challenge_method: 'S256', state: 'st-' + SUF, resource: ADDRESS });
    if (app.kind === 'poppy') q.set('scope', 'rooms');
    const page = await req('GET', '/oauth/authorize?' + q.toString());
    const d = await req('POST', '/api/oauth/decide', { json: { params: q.toString(), approve: true, name: o.name || 'Scout', rooms: rooms.map((x) => ({ room: x.room, inviter_token: x.inviter, ...(o.reuse ? { reuse: o.reuse } : {}) })) }, headers: Object.assign({ 'CF-Connecting-IP': ip() }, same) });
    if (d.status !== 200 || !d.json.redirect) return { page, decide: d };
    const back = new URL(d.json.redirect);
    const t = await form('/api/oauth/token', { grant_type: 'authorization_code', code: back.searchParams.get('code'), code_verifier: verifier, redirect_uri: q.get('redirect_uri'), resource: ADDRESS, ...(await auth(app, o.pair)) }, o.proof ? { DPoP: await proofOf(o.proof) } : {});
    return { page, decide: d, back, token: t, access: t.json && t.json.access_token, refresh: t.json && t.json.refresh_token, disconnectCode: d.json.disconnect_code };
  }

  try {
    // ---- Muse: a pinned public client, its Client ID typed by the person; plain requests, as its connector sends them ----
    const MUSE_CB = 'https://agent.meta.ai/api/hatch/oauth/callback';
    const M = await room('muse');
    const patM = await invite(M, 'Pat', 'human');
    await join(M, patM);
    /** Muse's authorize request and the approval: the code, the verifier and the redirect it came back on */
    const museApprove = async (name) => {
      const { verifier, challenge } = await pkce();
      const q = new URLSearchParams({ response_type: 'code', client_id: 'muse', redirect_uri: MUSE_CB, scope: 'rooms', resource: ADDRESS, state: 'ms-' + SUF, code_challenge: challenge, code_challenge_method: 'S256' });
      const page = await req('GET', '/oauth/authorize?' + q.toString());
      const d = await req('POST', '/api/oauth/decide', { json: { params: q.toString(), approve: true, name, rooms: [{ room: M, inviter_token: patM, reuse: 'any' }] }, headers: Object.assign({ 'CF-Connecting-IP': ip() }, same) });
      const back = d.status === 200 && d.json.redirect ? new URL(d.json.redirect) : null;
      return { page, decide: d, back, verifier };
    };
    const museExchange = (a, extra, headers) => form('/api/oauth/token', { grant_type: 'authorization_code', code: a.back.searchParams.get('code'), code_verifier: a.verifier, redirect_uri: MUSE_CB, resource: ADDRESS, ...(extra || { client_id: 'muse' }) }, headers);
    const museRefresh = (rt, extra, headers) => form('/api/oauth/token', { grant_type: 'refresh_token', refresh_token: rt, resource: ADDRESS, ...(extra || { client_id: 'muse' }) }, headers);
    let museReuse = null;
    {
      const a = await museApprove('Muse');
      check('signin (Muse): its authorize request is the approval page', a.page.status === 200 && /<div id="root">/.test(a.page.text), a.page.status + ' ' + a.page.text.slice(0, 80));
      check('signin (Muse): the approval redirects to its own address with the code, the state and iss', !!a.back && a.back.origin + a.back.pathname === MUSE_CB && JSON.stringify([...a.back.searchParams.keys()]) === '["code","state","iss"]' && a.back.searchParams.get('state') === 'ms-' + SUF && a.back.searchParams.get('iss') === ORIGIN, a.decide.status + ' ' + a.decide.text.slice(0, 160));
      const t = a.back ? await museExchange(a) : { status: 0, json: {}, text: '' };
      check('signin (Muse): the code exchange as a public client, client_id in the form and nothing else', t.status === 200 && t.json.token_type === 'Bearer' && t.json.scope === 'rooms', t.text.slice(0, 120));
      if (t.status === 200) {
        const p = await tool(t.json.access_token, 'post_message', { room: M, text: 'hello from Muse' });
        check('signin (Muse): a tool call, a post in the room', !!p.result && !p.result.isError, JSON.stringify(p).slice(0, 160));
        const r = await museRefresh(t.json.refresh_token);
        check('signin (Muse): a refresh rotates the pair', r.status === 200 && r.json.refresh_token !== t.json.refresh_token, r.text.slice(0, 120));
        const rv = await form('/api/oauth/revoke', { token: r.json.refresh_token, client_id: 'muse' });
        const after = await rpc(r.json.access_token, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
        check('signin (Muse): the revoke answers 200 {}, and its access token is refused after it', rv.status === 200 && rv.text === '{}' && after.status === 401, rv.status + ' ' + after.status);
      }
      // a second sign-in: refreshed twice, the second time naming the client only in Authorization: Basic with no password
      const b = await museApprove('Muse');
      const t2 = b.back ? await museExchange(b, {}, { Authorization: 'Basic ' + Buffer.from('muse:').toString('base64') }) : { status: 0, json: {} };
      check('signin (Muse): a code exchange naming the client only in a Basic header with no password', t2.status === 200, t2.status + ' ' + JSON.stringify(t2.json).slice(0, 100));
      if (t2.status === 200) {
        const r1 = await museRefresh(t2.json.refresh_token);
        const r1At = Date.now();
        const r2 = await museRefresh(r1.json.refresh_token, {}, { Authorization: 'Basic ' + Buffer.from('muse:').toString('base64') });
        check('signin (Muse): a second refresh, the client in a Basic header', r1.status === 200 && r2.status === 200 && r2.json.refresh_token !== r1.json.refresh_token, r1.status + ' ' + r2.status);
        museReuse = { first: t2.json.refresh_token, access: r2.json.access_token, at: r1At };
      }
    }

    const A = await room('a'), B = await room('b');
    const patA = await invite(A, 'Pat', 'human'), patB = await invite(B, 'Pat', 'human');
    await join(A, patA);
    await join(B, patB);
    for (const [what, app, o] of [['public', PUB, {}], ['poppy with DPoP', POP, { proof: await keyPair('ES256'), name: 'Muse' }], ['poppy without DPoP', POP, { name: 'Muse2', pair: ps }]]) {
      const c = await connect(app, [{ room: A, inviter: patA }, { room: B, inviter: patB }], o);
      check('signin (' + what + '): the authorize page is the app shell, unframeable, no COOP', c.page.status === 200 && /<div id="root">/.test(c.page.text) && /frame-ancestors 'none'/.test(c.page.headers.get('content-security-policy') || '') && c.page.headers.get('x-frame-options') === 'DENY' && c.page.headers.get('cross-origin-opener-policy') === null, c.page.status + ' ' + c.page.headers.get('content-security-policy'));
      check('signin (' + what + '): the approval makes two seats and redirects with the code, state and iss', c.decide.status === 200 && !!c.back && c.back.searchParams.get('state') === 'st-' + SUF && c.back.searchParams.get('iss') === ORIGIN && c.decide.headers.get('access-control-allow-origin') === null && /^\.ad1\./.test(c.disconnectCode || ''), c.decide.status + ' ' + c.decide.text.slice(0, 200));
      check('signin (' + what + '): the code exchange gives Bearer tokens for an hour, the scope stated', !!c.token && c.token.status === 200 && c.token.json.token_type === 'Bearer' && c.token.json.expires_in === LIM.OAUTH_ACCESS_TTL_S && c.token.json.scope === 'rooms' && c.token.headers.get('pragma') === 'no-cache', c.token && c.token.text.slice(0, 160));
      if (!c.access) continue;
      const list = await rpc(c.access, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
      const names = ((list.json || {}).result || { tools: [] }).tools.map((t) => t.name);
      check('signin (' + what + '): tools/list at the sign-in address, no add_room', list.status === 200 && names.includes('list_rooms') && names.includes('muse_register') && !names.includes('add_room'), list.status + ' ' + names.length);
      for (const name of [A, B]) {
        const p = await tool(c.access, 'post_message', { room: name, text: 'hello from the ' + what + ' sign-in' });
        const members = await tool(c.access, 'get_members', { room: name });
        const agentRow = ((members.result || {}).structuredContent || { members: [] }).members.find((m) => m.name === (o.name || 'Scout')) || {};
        check('signin (' + what + '): a post in ' + name.slice(-1) + ' as the agent the person invited, no invite link in the answers', !!p.result && !p.result.isError && agentRow.invited_by === 'Pat' && agentRow.kind === 'agent' && !/invite_link|#invite=/.test(JSON.stringify(members)) && !/invite_link|#invite=/.test(JSON.stringify(p)), JSON.stringify(agentRow).slice(0, 200));
      }
      const r = await form('/api/oauth/token', { grant_type: 'refresh_token', refresh_token: c.refresh, resource: ADDRESS, ...(await auth(app, o.pair)) }, o.proof ? { DPoP: await proofOf(o.proof) } : {});
      check('signin (' + what + '): a refresh rotates the pair', r.status === 200 && r.json.refresh_token !== c.refresh && r.json.access_token !== c.access, r.text.slice(0, 120));
      const rv = await form('/api/oauth/revoke', { token: r.json.refresh_token, ...(await auth(app, o.pair)) });
      check('signin (' + what + '): the revoke answers 200 {}', rv.status === 200 && rv.text === '{}', rv.status + ' ' + rv.text);
      const after = await rpc(r.json.access_token, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
      check('signin (' + what + '): the access token is refused after it, 401 invalid_token with the challenge', after.status === 401 && /error="invalid_token"/.test(after.headers.get('www-authenticate') || '') && /WWW-Authenticate/.test(after.headers.get('access-control-expose-headers') || ''), after.status + ' ' + after.headers.get('www-authenticate'));
    }

    // a re-approval that reuses the seats, and the wakes both connections register through the fake Muse
    const hand = handover(req, '198.51.' + (parseInt(SUF, 36) % 250) + '.91');
    const roomsOf = async (link) => ((await handover(req, '198.51.' + (parseInt(SUF, 36) % 250) + '.92')('POST', 'status', { museLinkId: link })).json || {}).rooms;
    const hookOf = async (name, tok) => ((await req('GET', '/api/rooms/' + name + '/muse-hook', { token: tok })).json || {}).hook;
    for (const both of [true, false]) {
      const R = await room(both ? 'reapp' : 'reapp1');
      const pat = await invite(R, 'Pat', 'human');
      await join(R, pat);
      const s1 = await connect(PUB, [{ room: R, inviter: pat }]);
      await tool(s1.access, 'get_room_state', { room: R });
      const g = await museGadget(ctx, hand, 'signin-' + (both ? 'b' : 'o'));
      const reg1 = await tool(s1.access, 'muse_register', { code: g.code });
      const s2 = await connect(PUB, [{ room: R, inviter: pat }], { reuse: 'any' });
      check('signin, re-approval' + (both ? '' : ' (only the first registers)') + ': the first connection registers, the second reuses the seat', !!reg1.result && reg1.result.structuredContent.results[0].ok === true && s2.decide.json.rooms[0].seat === 'reused', JSON.stringify(reg1).slice(0, 200) + ' ' + s2.decide.text.slice(0, 160));
      if (both) {
        // the same gadget again (its Add rooms): the same link, a new code
        const again = await hand('POST', 'connect', { sealed: g.sealed, termsVersion: 'v1' });
        const reg2 = await tool(s2.access, 'muse_register', { code: again.json && again.json.code });
        check('signin, re-approval: the second connection registers the same Muse', !!reg2.result && reg2.result.structuredContent.results[0].ok === true && again.json.museLinkId === g.link, JSON.stringify(reg2).slice(0, 200));
      }
      const seat = ((await req('GET', '/api/rooms/' + R + '/invites', { owner: true })).json.invites || []).find((i) => i.name === 'Scout') || {};
      const before = await roomsOf(g.link);
      await form('/api/oauth/revoke', { token: s1.refresh, client_id: PUB.client_id });
      let after = before;
      for (let i = 0; i < 20; i++) { after = await roomsOf(g.link); if (after !== before) break; await new Promise((x) => setTimeout(x, 100)); }
      if (both) {
        check('signin, re-approval: revoking the first leaves the wake on (the bridge hears no hooked: false)', after === before && !!(await hookOf(R, seat.token)), before + ' ' + after);
        await form('/api/oauth/revoke', { token: s2.refresh, client_id: PUB.client_id });
        for (let i = 0; i < 20; i++) { after = await roomsOf(g.link); if (after !== before) break; await new Promise((x) => setTimeout(x, 100)); }
        check('signin, re-approval: revoking the second turns it off', after === before - 1 && !(await hookOf(R, seat.token)), before + ' ' + after);
      } else check('signin, re-approval: with only the first registered, its revoke turns the wake off', after === before - 1 && !(await hookOf(R, seat.token)), before + ' ' + after);
    }

    // the disconnect-only code, and a key on the same seat whose disconnect lets go and leaves the sign-in's wake
    {
      const R = await room('code');
      const pat = await invite(R, 'Pat', 'human');
      await join(R, pat);
      const kp = await req('POST', '/api/agents/invite', { json: { name: 'Scout', rooms: [{ room: R, inviter_token: pat }] }, headers: { 'CF-Connecting-IP': ip() } });
      const KEY = kp.json && kp.json.key;
      await req('POST', '/api/mcp', { json: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'whoami', arguments: { room: R } } }, headers: { Authorization: 'Bearer ' + KEY } });
      const g = await museGadget(ctx, hand, 'signin-k');
      const kreg = await req('POST', '/api/mcp', { json: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'muse_register', arguments: { code: g.code } } }, headers: { Authorization: 'Bearer ' + KEY } });
      const s = await connect(PUB, [{ room: R, inviter: pat }], { reuse: 'any' });
      const again = await hand('POST', 'connect', { sealed: g.sealed, termsVersion: 'v1' });
      const sreg = await tool(s.access, 'muse_register', { code: again.json && again.json.code });
      check('signin: a key and a sign-in on one seat both register the same Muse', kreg.json.result.structuredContent.results[0].ok === true && !!sreg.result && sreg.result.structuredContent.results[0].ok === true, JSON.stringify(sreg).slice(0, 160));
      const d = await req('DELETE', '/api/agent', { headers: { Authorization: 'Bearer ' + KEY } });
      const seat = ((await req('GET', '/api/rooms/' + R + '/invites', { owner: true })).json.invites || []).find((i) => i.name === 'Scout') || {};
      check('signin: the key\'s disconnect lets go, says so, and leaves the sign-in\'s wake on', d.status === 200 && JSON.stringify(d.json.muse_wakes_removed) === '[]' && /it has let go of every Muse wake it set up/.test(d.json.note) && !!(await hookOf(R, seat.token)), d.text.slice(0, 300));
      const dc = await req('POST', '/api/oauth/disconnect', { json: { code: s.disconnectCode }, headers: same });
      check('signin: the disconnect-only code disconnects it and lets go of its wake', dc.status === 200 && dc.json.disconnected === true && JSON.stringify(dc.json.wakes_left) === '[]' && !(await hookOf(R, seat.token)) && dc.headers.get('access-control-allow-origin') === null, dc.text.slice(0, 200));
      const after = await rpc(s.access, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
      check('signin: after it, the connection is refused', after.status === 401, after.status);
      const dc2 = await req('POST', '/api/oauth/disconnect', { json: { code: s.disconnectCode }, headers: same });
      check('signin: the code again: unknown', dc2.status === 200 && JSON.stringify(dc2.json) === JSON.stringify({ disconnected: false, code: 'unknown' }), dc2.text);
    }

    // the times: an approval of AGENT_ROOMS_MAX rooms, a refresh, a revoke letting go of as many wakes
    {
      const many = [];
      for (let i = 0; i < LIM.AGENT_ROOMS_MAX; i++) {
        const R = await room('m' + i);
        const pat = await invite(R, 'Pat', 'human');
        await join(R, pat);
        many.push({ room: R, inviter: pat });
      }
      await req('POST', '/api/test-hooks/agent-limits', { owner: true, json: { per_room: 1000, per_ip: 1000, per_day: 1000 } });
      let t0 = Date.now();
      const s = await connect(PUB, many, { name: 'Many' });
      const approve = Date.now() - t0;
      check('signin: an approval of ' + LIM.AGENT_ROOMS_MAX + ' rooms, under 5 s (' + approve + ' ms)', !!s.access && approve < 5000, s.decide.status + ' ' + s.decide.text.slice(0, 160));
      t0 = Date.now();
      const r = await form('/api/oauth/token', { grant_type: 'refresh_token', refresh_token: s.refresh, resource: ADDRESS, client_id: PUB.client_id });
      const refresh = Date.now() - t0;
      check('signin: a refresh, under 5 s (' + refresh + ' ms)', r.status === 200 && refresh < 5000, r.status);
      for (const m of many) await tool(r.json.access_token, 'get_room_state', { room: m.room });
      const g = await museGadget(ctx, hand, 'signin-many');
      const reg = await tool(r.json.access_token, 'muse_register', { code: g.code });
      const set = ((reg.result || {}).structuredContent || { results: [] }).results.filter((x) => x.ok).length;
      t0 = Date.now();
      const rv = await form('/api/oauth/revoke', { token: r.json.refresh_token, client_id: PUB.client_id });
      const revoke = Date.now() - t0;
      check('signin: a revoke letting go of ' + set + ' wakes, under 5 s (' + revoke + ' ms)', rv.status === 200 && set === LIM.AGENT_ROOMS_MAX && revoke < 5000, rv.status + ' ' + set);
      console.log('signin: an approval of ' + LIM.AGENT_ROOMS_MAX + ' rooms ' + approve + ' ms, a refresh ' + refresh + ' ms, a revoke of ' + set + ' wakes ' + revoke + ' ms (wall time, from the client)');
      await req('POST', '/api/test-hooks/agent-limits', { owner: true, json: { clear: true } });
    }
    // ---- an assertion app's key set at a loopback address (TEST_HOOKS only): a key-set host of this suite's own
    // on 127.0.0.1, which counts every fetch and can answer slowly ----
    {
      const http = require('http');
      const kes = await keyPair('ES256', 'keys-1');
      const hits = {}, ends = {};
      let delay = 0;
      const keyHost = http.createServer((rq, rs) => {
        const p = rq.url;
        hits[p] = (hits[p] || 0) + 1;
        // how each answer ended: written to the end, or the Worker's side gone first
        rs.on('close', () => { (ends[p] = ends[p] || []).push(rs.writableFinished ? 'finished' : 'closed early'); });
        setTimeout(() => {
          if (rs.destroyed) return;
          rs.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=600' });
          rs.end(JSON.stringify({ keys: [kes.jwk] }));
        }, delay);
      });
      await new Promise((r) => keyHost.listen(0, '127.0.0.1', r));
      const port = keyHost.address().port;
      const keysApp = (name) => ({ key: 'apitest-keys-' + name, client_id: 'https://agent.example/apitest/' + SUF + '/keys-' + name, kind: 'poppy', name: 'Stand-in keys', host: 'agent.example', redirect_uris: ['https://agent.example/callback'], loopback: false, page: 'agent', jwks_uri: 'http://127.0.0.1:' + port + '/' + SUF + '/' + name + '.json' });
      const pathOf = (app) => new URL(app.jwks_uri).pathname;
      // a refresh of no token: an assertion taken is invalid_grant, one refused invalid_client
      const tryKey = async (app, signal) => {
        const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: '.ar1.x', ...(await auth(app, kes)) });
        const r = await fetch(ORIGIN + '/api/oauth/token', { method: 'POST', body: body.toString(), headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'CF-Connecting-IP': ip() }, signal });
        const text = await r.text();
        return { status: r.status, text };
      };
      const taken = (r) => r.status === 400 && /"invalid_grant"/.test(r.text);
      try {
        const burst = keysApp('burst'), dropped = keysApp('dropped');
        for (const app of [burst, dropped]) {
          const r = await req('POST', '/api/test-hooks/oauth-app', { owner: true, json: { app } });
          check('signin: a stand-in with a loopback key-set address is known on this local server', r.status === 200, r.text.slice(0, 120));
        }
        // a burst of assertions at once, on a server holding no set: one fetch, and every one taken
        delay = 400;
        const rs = await Promise.all(Array.from({ length: 12 }, () => tryKey(burst)));
        const fetched = hits[pathOf(burst)] || 0;
        check('signin, key sets: a burst of 12 assertions on a server holding no set: one fetch, all taken', fetched === 1 && rs.every(taken), fetched + ' fetches; answers ' + rs.map((x) => x.status).join(','));
        console.log('signin, key sets: the burst: ' + fetched + ' fetch(es) at the key-set host, ' + rs.filter(taken).length + ' of ' + rs.length + ' taken');
        // a request dropped while the fetch it started is under way, then the next one: taken, with no second fetch
        delay = 1500;
        const ctl = new AbortController();
        const gone = tryKey(dropped, ctl.signal).then(() => 'answered', (e) => 'dropped (' + (e && e.name) + ')');
        await sleep(300);
        ctl.abort();
        const firstEnd = await gone;
        await sleep(2000);
        delay = 0;
        const next = await tryKey(dropped);
        const n2 = hits[pathOf(dropped)] || 0;
        check('signin, key sets: a request dropped mid-fetch, then the next one: taken without a second fetch', taken(next) && n2 === 1, n2 + ' fetches; ' + next.status + ' ' + next.text.slice(0, 80));
        console.log('signin, key sets: the dropped request: the client ' + firstEnd + '; ' + n2 + ' fetch(es) at the key-set host, its answer ' + JSON.stringify(ends[pathOf(dropped)] || []) + '; the next request ' + (taken(next) ? 'taken' : 'refused'));
      } finally {
        await new Promise((r) => keyHost.close(r));
      }
    }

    // ---- Muse's first refresh token again, once the grace after its use has passed: a reuse, which ends the sign-in ----
    if (museReuse) {
      await sleep(Math.max(0, museReuse.at + (LIM.OAUTH_REFRESH_GRACE_S + 2) * 1000 - Date.now()));
      const again = await museRefresh(museReuse.first);
      let after = null;
      for (let i = 0; i < 20; i++) { after = await rpc(museReuse.access, { jsonrpc: '2.0', id: 1, method: 'tools/list' }); if (after.status === 401) break; await sleep(100); }
      check('signin (Muse): the first refresh token presented again after the grace is invalid_grant, and the sign-in has ended (its latest access token refused)', again.status === 400 && again.json.error === 'invalid_grant' && after.status === 401, again.status + ' ' + again.text.slice(0, 80) + ' ' + after.status);
    }
  } finally {
    await req('POST', '/api/test-hooks/oauth-app', { owner: true, json: { clear: true } });
    for (const name of made) {
      await req('DELETE', '/api/rooms/' + name + '/invites', { owner: true });
      await req('DELETE', '/api/rooms/' + name + '?confirm=' + name, { owner: true });
    }
  }
}

module.exports = { signinApi };
