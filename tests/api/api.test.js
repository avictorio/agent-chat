// API smoke tests against a real local Worker (wrangler dev).
// Covers the server behaviors the UI suite cannot: access rules, the
// invite-only invariants, public room creation (validation, name race
// surface, rollback on email failure), publish-on-complete, draft-media
// privacy, room destruction, the upload engine (direct-upload signing
// included), MCP, stream frames and the game engines. Exits non-zero on
// any failure.
//
//   npm run build     (once, and after web/ changes: the page shell and
//                      its assets come from web/app/dist)
//   npm run test:api
//
// Hermetic (tests/api/server.js): each run gets its own port (8798 unless
// API_PORT says otherwise), its own local state directory, removed
// afterwards, and reaches nothing outside this machine. The create-room caps
// count in KV and one of them is room-wide (30 a day), so shared state would
// fail a later same-day run's create checks as 429s. Room names, emails and
// client IPs stay unique per run as well.
const http = require('http');
const { start, OWNER } = require('./server.js');

let BASE = '';
const SUF = Date.now().toString(36);
// Client IPs for the create-room checks: the creation caps count attempts
// per IP, so each check sends its own address, under a per-run prefix.
const IPO = '10.' + (20 + (parseInt(SUF, 36) % 180)) + '.0.';
const { golden } = require('./golden.js');
const { inviteApi } = require('./invite-api.js');

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
  try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text, headers: r.headers };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A POST whose headers go out now and whose body is sent later: the Worker
// has checked the invite and is waiting for the body. send() finishes it.
function parkedPost(p, token, bodyText) {
  const u = new URL(BASE + p);
  let settle;
  const done = new Promise((r) => { settle = r; });
  const rq = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method: 'POST', headers: { 'X-Invite-Token': token, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyText) } }, (res) => {
    let t = '';
    res.on('data', (c) => { t += c; });
    res.on('end', () => { let j = null; try { j = JSON.parse(t); } catch {} settle({ status: res.statusCode, json: j, text: t }); });
  });
  rq.on('error', (e) => settle({ status: 0, json: null, text: String(e) }));
  rq.flushHeaders();
  return { send: () => { rq.end(bodyText); return done; } };
}

// A request body sent chunked (no Content-Length), so the Worker learns
// its size only by reading it: head, then filler bytes up to size, then tail.
function chunked(size, head, tail) {
  const h = Buffer.from(head || ''), t = Buffer.from(tail || '');
  let left = size - h.length - t.length;
  let first = true;
  return new ReadableStream({
    pull(c) {
      if (first) { first = false; if (h.length) { c.enqueue(new Uint8Array(h)); return; } }
      if (left > 0) { const n = Math.min(left, 1 << 20); left -= n; c.enqueue(new Uint8Array(n).fill(97)); return; }
      if (t.length) c.enqueue(new Uint8Array(t));
      c.close();
    },
  });
}
async function putChunked(p, method, body, headers) {
  const r = await fetch(BASE + p, { method, headers: headers || {}, body, duplex: 'half' });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text };
}

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
function mp4() {
  const b = Buffer.alloc(48);
  b.writeUInt32BE(24, 0); b.write('ftypisom', 4); b.writeUInt32BE(16, 12); b.write('isomiso2', 16);
  b.writeUInt32BE(24, 24); b.write('mvhd', 28);
  return b;
}

(async () => {
  let server;
  try {
    server = await start({ port: Number(process.env.API_PORT) || 8798 });
  } catch (e) {
    console.error('test:api: ' + ((e && e.message) || e));
    process.exit(2);
  }
  BASE = server.base;
  try {
    check('wrangler dev comes up', true);
    // Today's promises first (tests/api/golden.js): every case keeps its
    // status, error sentence and fields, whatever this commit adds.
    await golden({ req, BASE, OWNER, SUF, IPO }, check);
    // The agent invite link API (tests/api/invite-api.js).
    await inviteApi({ req, check, BASE, OWNER, SUF, IPO });
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

    // Invite presentation: humans get the web app, agents get MCP instructions.
    check('human invite has no agent_onboarding', !('agent_onboarding' in (invA.json || {})));
    check('agent invite carries agent_onboarding', typeof invB.json.agent_onboarding === 'string' && invB.json.agent_onboarding.includes('/mcp') && invB.json.agent_onboarding.includes(TB), String(invB.json.agent_onboarding).slice(0, 80));
    r = await req('GET', R + '/messages?limit=1', { token: TA });
    check('first read: human you_kind, no onboarding', r.json && r.json.you === 'ApiA' && r.json.you_kind === 'human' && !('agent_onboarding' in r.json), JSON.stringify(r.json && { you: r.json.you, you_kind: r.json.you_kind }));
    r = await req('GET', R + '/messages?limit=1', { token: TB });
    check('first read: agent you_kind + onboarding', r.json && r.json.you === 'ApiB' && r.json.you_kind === 'agent' && typeof r.json.agent_onboarding === 'string' && r.json.agent_onboarding.includes(TB), JSON.stringify(r.json && { you: r.json.you, you_kind: r.json.you_kind }));
    r = await req('GET', R + '/messages?after=0&limit=1', { token: TB });
    check('later reads keep you_kind, omit the onboarding block', r.json && r.json.you_kind === 'agent' && !('agent_onboarding' in r.json));
    r = await req('GET', R + '/invites', { owner: true });
    const listedB = (r.json.invites || []).find(i => i.name === 'ApiB');
    const listedA = (r.json.invites || []).find(i => i.name === 'ApiA');
    check('owner invite list: agent carries onboarding, human does not', !!(listedB && listedB.agent_onboarding) && !!(listedA && !('agent_onboarding' in listedA)));
    check('agent onboarding points at the wake recipe', typeof invB.json.agent_onboarding === 'string' && invB.json.agent_onboarding.includes('/agent-recipe'));
    check('agent onboarding carries the invite link', typeof invB.json.agent_onboarding === 'string' && invB.json.agent_onboarding.includes('#invite=' + TB));
    check('agent onboarding gives the initiating instructions', typeof invB.json.agent_onboarding === 'string' && invB.json.agent_onboarding.includes('implement the wake recipe') && invB.json.agent_onboarding.includes('post a short hello'));
    check('agent onboarding carries the ready-made watcher registry line', typeof invB.json.agent_onboarding === 'string' && invB.json.agent_onboarding.includes('rooms.txt') && invB.json.agent_onboarding.includes('\n  apitest-main-' + SUF + ' ' + TB + '\n'));
    r = await req('GET', R + '/members', { owner: true });
    const memB = (r.json.members || []).find(m => m.name === 'ApiB');
    const memA = (r.json.members || []).find(m => m.name === 'ApiA');
    check('members list: agent carries invite_link + onboarding', !!(memB && memB.invite_link && typeof memB.agent_onboarding === 'string' && memB.agent_onboarding.includes('implement the wake recipe')));
    check('members list: human carries invite_link, no onboarding', !!(memA && memA.invite_link && !('agent_onboarding' in memA)));

    // Wake recipe: personalized text + the watcher script, never the token.
    const RNAME = 'apitest-main-' + SUF;
    r = await req('GET', R + '/agent-recipe', {});
    check('recipe requires access', r.status === 403 || r.status === 401, r.status);
    r = await req('GET', R + '/agent-recipe', { token: TB });
    check('recipe: 200 text for a member', r.status === 200 && (r.headers.get('content-type') || '').includes('text/plain'), r.status);
    check('recipe: carries room + caller name', r.text.includes(RNAME) && r.text.includes('"ApiB"'), r.text.slice(0, 80));
    check('recipe: points at the script endpoint', r.text.includes('/agent-recipe/script'));
    check('recipe: screener forwards every wake, never filters', r.text.includes('never filter') && r.text.includes('no wake you stay silent on'));
    check('recipe: names the delivery leg (a wake is not a turn)', r.text.includes('A wake is not a turn'));
    check('recipe: stale-frame rule - re-read the live match before moving', r.text.includes('always re-read the live match before moving'));
    check('recipe: exact game calls (no get_game_state)', r.text.includes('There is no get_game_state tool'));
    check('recipe: never contains the caller token', !r.text.includes(TB));
    r = await req('GET', R + '/agent-recipe/script', { token: TB });
    check('recipe script: 200 shell with room + self substituted', r.status === 200 && r.text.includes("|| ROOM='" + RNAME + "'") && r.text.includes("|| SELF='ApiB'") && r.text.includes(':-$BASE/stream') && r.text.includes('STREAM_BASE?after='), r.text.slice(0, 80));
    check('recipe script: no placeholders left, no token', !r.text.includes('__ROOM__') && !r.text.includes('__SELF__') && !r.text.includes(TB));
    // A member's name is someone else's text, and the script is shell that
    // runs on the agent's machine: a name that is shell syntax must arrive
    // as a single-quoted literal (tests/unit/shell.test.mjs runs it in bash).
    const hostile = '$(touch pwned)';
    const invX = await req('POST', R + '/invites', { owner: true, json: { name: hostile, kind: 'agent' } });
    r = await req('GET', R + '/agent-recipe/script', { token: invX.json && invX.json.token });
    check('recipe script: a name that is shell syntax is filled in as a quoted literal', invX.status === 201 && r.status === 200 && r.text.includes("|| SELF='$(touch pwned)'") && !/:-[^}\n]*\$\(touch/.test(r.text) && !/"[^"\n]*\$\(touch pwned\)[^"\n]*"/.test(r.text), invX.status + ' ' + r.status + ' ' + (r.text.match(/^SELF=.*$/m) || [''])[0]);
    if (invX.json && invX.json.token) await req('DELETE', R + '/invites/' + invX.json.token, { owner: true });
    r = await req('POST', R + '/agent-recipe', { token: TB, json: {} });
    check('recipe is GET only', r.status === 405, r.status);

    // Draft cursor integrity: last_id counts only published messages, and a
    // draft that publishes late still reaches a poller whose cursor passed it.
    r = await req('GET', R + '/messages?limit=1', { token: TB });
    const L0 = r.json.last_id;
    const dr = await req('POST', R + '/messages', { token: TA, json: { from: 'ApiA', text: 'cursor draft', draft: true } });
    const D = dr.json.id;
    check('draft minted above the published frontier', D > L0, D + ' vs ' + L0);
    r = await req('GET', R + '/messages?limit=1', { token: TB });
    check('last_id ignores the draft', r.json.last_id === L0, r.json.last_id + ' vs ' + L0);
    const live = await req('POST', R + '/messages', { token: TB, json: { from: 'ApiB', text: 'live after draft' } });
    const M = live.json.id;
    r = await req('POST', R + '/messages/' + D + '/publish', { token: TA, json: {} });
    check('publish the draft', r.status === 200, r.status);
    r = await req('GET', R + '/messages?after=' + M, { token: TB });
    check('late-published draft reaches a poller past its id', (r.json.messages || []).some((x) => x.id === D), JSON.stringify((r.json.messages || []).map((x) => x.id)));
    r = await req('GET', R + '/messages?after=' + L0, { token: TB });
    check('forward read returns both the live message and the draft', (r.json.messages || []).some((x) => x.id === M) && (r.json.messages || []).some((x) => x.id === D));

    // Reactions respect draft privacy: a draft answers like a missing message.
    const dr2 = await req('POST', R + '/messages', { token: TA, json: { from: 'ApiA', text: 'reaction draft', draft: true } });
    const D2 = dr2.json.id;
    r = await req('POST', R + '/messages/' + D2 + '/reactions', { token: TB, json: { reaction: '👍' } });
    check('react to another member\'s draft -> 404', r.status === 404, r.status);
    r = await req('GET', R + '/messages/' + D2 + '/reactions', { token: TB });
    check('read reactions on another member\'s draft -> 404', r.status === 404, r.status);
    r = await req('GET', R + '/messages/' + D2 + '/reactions', { token: TA });
    check('sender reads own draft reactions', r.status === 200, r.status);
    await req('POST', R + '/messages/' + D2 + '/publish', { token: TA, json: {} });
    r = await req('POST', R + '/messages/' + D2 + '/reactions', { token: TB, json: { reaction: '👍' } });
    check('react after publish works', r.status === 200, r.status);
    r = await req('POST', R + '/messages/' + D2 + '/reactions', { token: TB, json: { reaction: 'constructor' } });
    check('reaction "constructor" (not an alias) -> 400', r.status === 400, r.status + ' ' + r.text.slice(0, 80));

    // ?draft_only=1 throws away a draft but never a live message: a client
    // discarding an upload that another device had published got 200 and
    // took the live message, and its media, from everyone.
    const dd = await req('POST', R + '/messages', { token: TA, json: { text: 'draft-only probe', draft: true } });
    const DD = dd.json.id;
    await req('POST', R + '/messages/' + DD + '/publish', { token: TA, json: {} });
    r = await req('DELETE', R + '/messages/' + DD + '?draft_only=1', { token: TA });
    check('draft_only delete of a live message -> 409 with a sentence', r.status === 409 && /already live/.test((r.json && r.json.error) || ''), r.status + ' ' + r.text.slice(0, 80));
    r = await req('GET', R + '/messages?after=' + (DD - 1) + '&limit=5', { token: TB });
    check('draft_only delete leaves the live message for everyone', (r.json.messages || []).some((x) => x.id === DD), JSON.stringify((r.json.messages || []).map((x) => x.id)));
    const dd2 = await req('POST', R + '/messages', { token: TA, json: { text: 'draft-only draft', draft: true } });
    r = await req('DELETE', R + '/messages/' + dd2.json.id + '?draft_only=1', { token: TA });
    check('draft_only delete of a draft -> 200 deleted', r.status === 200 && r.json && r.json.deleted === dd2.json.id, r.status + ' ' + r.text.slice(0, 80));
    r = await req('DELETE', R + '/messages/' + DD, { token: TA });
    check('a plain delete still removes a live message', r.status === 200 && r.json && r.json.deleted === DD, r.status);

    // Push subscribe validates its keys instead of throwing on bad base64url.
    r = await req('POST', R + '/push/subscribe', { token: TA, json: { subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/bad-keys', keys: { p256dh: '!!!', auth: 'AAAAAAAAAAAAAAAAAAAAAA' } } } });
    check('malformed push keys -> 400, not 500', r.status === 400 && /p256dh/.test(r.json.error), r.status + ' ' + r.text.slice(0, 80));
    // Push endpoints must belong to a browser push service, so a member
    // cannot aim the room's fan-out at an arbitrary host.
    const P65 = Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 7)]).toString('base64url');
    const AUTH16 = Buffer.alloc(16, 9).toString('base64url');
    r = await req('POST', R + '/push/subscribe', { token: TA, json: { subscription: { endpoint: 'https://example.com/x', keys: { p256dh: P65, auth: AUTH16 } } } });
    check('push endpoint off the push services -> 400', r.status === 400 && /push service/.test(r.json.error), r.status + ' ' + r.text.slice(0, 80));
    r = await req('POST', R + '/push/subscribe', { token: TA, json: { subscription: { endpoint: 'https://fcm.googleapis.com.evil.example/x', keys: { p256dh: P65, auth: AUTH16 } } } });
    check('look-alike push host -> 400', r.status === 400, r.status);
    r = await req('POST', R + '/push/subscribe', { token: TA, json: { subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/api-ok-' + SUF, keys: { p256dh: P65, auth: AUTH16 } } } });
    check('push service endpoint accepted', r.status === 200, r.status + ' ' + r.text.slice(0, 80));
    await req('POST', R + '/push/unsubscribe', { token: TA, json: { endpoint: 'https://fcm.googleapis.com/fcm/send/api-ok-' + SUF } });

    // Member names: no markup or game syntax, and one
    // member per name however it is cased or composed.
    r = await req('POST', R + '/invites', { owner: true, json: { name: '<img src=x onerror=alert(1)>', kind: 'agent' } });
    check('name with markup -> 400', r.status === 400, r.status);
    r = await req('POST', R + '/invites', { owner: true, json: { name: 'Ada:C5', kind: 'agent' } });
    check('name with a colon -> 400', r.status === 400, r.status);
    r = await req('POST', R + '/invites', { owner: true, json: { name: 'Ann, Bo', kind: 'agent' } });
    check('name with a comma -> 400', r.status === 400, r.status);
    for (const bad of ['__proto__', 'constructor', 'ToString']) {
      r = await req('POST', R + '/invites', { owner: true, json: { name: bad, kind: 'agent' } });
      check('name ' + bad + ' (an Object.prototype key) -> 400', r.status === 400 && /reserved/.test(r.json.error || ''), r.status + ' ' + r.text.slice(0, 80));
    }
    r = await req('POST', R + '/invites', { owner: true, json: { name: 'APIA', kind: 'agent' } });
    check('differently cased duplicate -> 409', r.status === 409, r.status);
    r = await req('POST', R + '/invites', { owner: true, json: { name: 'ＡｐｉＡ', kind: 'agent' } });
    check('full-width look-alike duplicate -> 409', r.status === 409, r.status);
    r = await req('POST', R + '/invites', { owner: true, json: { name: 'Ｒｅｆｅｒｅｅ', kind: 'agent' } });
    check('full-width Referee is reserved -> 400', r.status === 400 && /reserved/.test(r.json.error), r.status);
    const accU = await req('POST', R + '/invites', { owner: true, json: { name: 'José', kind: 'agent' } });
    r = await req('POST', R + '/invites', { owner: true, json: { name: 'JOSÉ', kind: 'agent' } });
    check('non-ASCII case fold duplicate -> 409', accU.status === 201 && r.status === 409, accU.status + ' ' + r.status);
    r = await req('POST', R + '/invites', { owner: true, json: { name: 'José', kind: 'agent' } });
    check('decomposed accent duplicate -> 409', r.status === 409, r.status);
    if (accU.json && accU.json.token) await req('DELETE', R + '/invites/' + encodeURIComponent(accU.json.token), { owner: true });

    // Revoking a member drops their push registrations: no more message
    // text reaches a device of someone who is out. Probed with Web Push:
    // the Android app's device-token routes and App Links file are gone
    // (404).
    const PG_EP = 'https://fcm.googleapis.com/fcm/send/pushgone-' + SUF;
    const PG_STATUS = R + '/push/status?endpoint=' + encodeURIComponent(PG_EP);
    const invPG = await req('POST', R + '/invites', { owner: true, json: { name: 'PushGone', kind: 'agent' } });
    r = await req('POST', R + '/push/subscribe', { token: invPG.json.token, json: { subscription: { endpoint: PG_EP, keys: { p256dh: P65, auth: AUTH16 } } } });
    check('a member subscribes for push', r.status === 200, r.status + ' ' + r.text.slice(0, 80));
    r = await req('GET', PG_STATUS, { token: invPG.json.token });
    check('the subscription is registered', r.status === 200 && r.json.registered === true, r.status + ' ' + r.text.slice(0, 80));
    await req('DELETE', R + '/invites/' + encodeURIComponent(invPG.json.token), { owner: true });
    const invPG2 = await req('POST', R + '/invites', { owner: true, json: { name: 'PushGone', kind: 'agent' } });
    r = await req('GET', PG_STATUS, { token: invPG2.json.token });
    check('revoke drops the member\'s push registrations', r.status === 200 && r.json.registered === false && r.json.count === 0, r.status + ' ' + r.text.slice(0, 80));
    await req('DELETE', R + '/invites/' + encodeURIComponent(invPG2.json.token), { owner: true });
    r = await req('POST', R + '/push/device/register', { token: TA, json: { token: 'dev-' + SUF, platform: 'android' } });
    check('the Android device-token routes are gone -> 404', r.status === 404, r.status);
    r = await req('GET', '/.well-known/assetlinks.json');
    check('no Android App Links file -> 404', r.status === 404, r.status);

    // Message ids are never reused: deleting the newest message must not
    // hand its id to the next post (cursor readers past it would miss it).
    const idA = (await req('POST', R + '/messages', { token: TA, json: { from: 'ApiA', text: 'id reuse probe' } })).json.id;
    r = await req('DELETE', R + '/messages/' + idA, { token: TA });
    check('delete the newest message', r.status === 200, r.status);
    const idB = (await req('POST', R + '/messages', { token: TA, json: { from: 'ApiA', text: 'id reuse repost' } })).json.id;
    check('the repost gets a fresh id', idB > idA, idA + ' -> ' + idB);
    r = await req('GET', R + '/messages?after=' + idA, { token: TB });
    check('a reader past the deleted id sees the repost', (r.json.messages || []).some((x) => x.id === idB), JSON.stringify((r.json.messages || []).map((x) => x.id)));

    // The docs answer at /api/docs too (older welcome packets send agents there).
    r = await req('GET', '/api/docs');
    check('/api/docs serves the API docs, pointing at the game reference', r.status === 200 && r.text.includes('GAMES - EVERY MATCH') && r.text.includes('/api/games') && !r.text.includes('GAMES - LIGHT CYCLES'), r.status);
    r = await req('GET', '/api/games');
    check('/api/games serves every game\'s section', r.status === 200 && /text\/plain/.test(r.headers.get('content-type') || '') && r.text.includes('GAMES - LIGHT CYCLES') && r.text.includes('Absence rule') && r.text.includes('GAMES - SKETCH & GUESS'), r.status);
    r = await req('GET', '/api/games.txt');
    check('/api/games.txt is the same text', r.status === 200 && r.text.includes('GAMES - LIGHT CYCLES'), r.status);
    r = await req('POST', R + '/mcp', { token: TA, json: { jsonrpc: '2.0', id: 1, method: 'tools/list' } });
    const qa = ((r.json && r.json.result && r.json.result.tools) || []).find((t) => t.name === 'question_action');
    check('MCP question_action offers reopen', !!qa && qa.inputSchema.properties.action.enum.includes('reopen'), JSON.stringify(qa && qa.inputSchema.properties.action));

    // A malformed %-escape in a path is a 400, not an unhandled 500.
    r = await req('GET', R + '/avatars/%E0%A4%A', { token: TA });
    check('malformed %-escape -> 400', r.status === 400, r.status);

    // A body that is there but is not JSON is a 400 that says so (lib/http.ts
    // readBody); an empty body still reads as no body, so the route answers
    // about its own fields.
    const notJson = { 'Content-Type': 'application/json' };
    r = await req('POST', R + '/invites', { owner: true, headers: notJson, body: '{"name": "Half' });
    check('invite POST with broken JSON -> 400 naming it', r.status === 400 && /not valid JSON/.test((r.json && r.json.error) || ''), r.status + ' ' + r.text.slice(0, 120));
    r = await req('PUT', R + '/constitution', { token: TA, headers: notJson, body: 'text=hello' });
    check('constitution PUT with a form body -> 400 naming it', r.status === 400 && /not valid JSON/.test((r.json && r.json.error) || ''), r.status + ' ' + r.text.slice(0, 120));
    r = await req('POST', R + '/members/ApiB', { owner: true, headers: notJson, body: "{kind: 'agent'}" });
    check('a converted inline parse answers broken JSON with 400 too', r.status === 400 && /not valid JSON/.test((r.json && r.json.error) || ''), r.status + ' ' + r.text.slice(0, 120));
    r = await req('POST', R + '/invites', { owner: true, headers: notJson });
    check('invite POST with no body -> the field error, not a JSON one', r.status === 400 && /"name" is required/.test((r.json && r.json.error) || ''), r.status + ' ' + r.text.slice(0, 120));
    r = await req('POST', R + '/invites', { owner: true, headers: notJson, body: '  \n' });
    check('a whitespace-only body reads as no body', r.status === 400 && /"name" is required/.test((r.json && r.json.error) || ''), r.status + ' ' + r.text.slice(0, 120));

    // Authorization: Bearer is an alias for X-Invite-Token; a token in
    // X-Invite-Token wins, other schemes are not a token, and browsers may
    // send and read the headers.
    const bearer = (t) => ({ Authorization: 'Bearer ' + t });
    r = await req('GET', R + '/messages?limit=1', { headers: bearer(TA) });
    check('Bearer token reads', r.status === 200 && r.json && r.json.you === 'ApiA', r.status + ' ' + (r.json && r.json.you));
    r = await req('POST', R + '/messages', { headers: bearer(TA), json: { text: 'posted with a bearer token' } });
    check('Bearer token posts under the invite name', r.status === 201 && r.json && r.json.from === 'ApiA', r.status + ' ' + (r.json && r.json.from));
    r = await req('POST', R + '/mcp', { headers: bearer(TB), json: { jsonrpc: '2.0', id: 1, method: 'tools/list' } });
    check('Bearer token lists MCP tools', r.status === 200 && r.json && r.json.result && Array.isArray(r.json.result.tools), r.status + ' ' + r.text.slice(0, 120));
    r = await req('GET', R + '/messages?limit=1', { token: TA, headers: bearer('bogus-token') });
    check('X-Invite-Token wins over a bad Bearer', r.status === 200 && r.json.you === 'ApiA', r.status);
    r = await req('GET', R + '/messages?limit=1', { token: 'bogus-token', headers: bearer(TA) });
    check('a bad X-Invite-Token is not rescued by Bearer', r.status === 403, r.status);
    r = await req('GET', R + '/messages?limit=1', { headers: { Authorization: 'Basic ' + Buffer.from('ApiA:' + TA).toString('base64') } });
    check('Authorization: Basic is not a token', r.status === 401, r.status);
    r = await req('GET', R + '/messages?limit=1&invite=bogus-token', { headers: bearer(TA) });
    check('Bearer is used, a URL token beside it ignored', r.status === 200, r.status);
    {
      const pf = await fetch(BASE + R + '/messages', { method: 'OPTIONS', headers: { Origin: 'https://example.test', 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization' } });
      check('CORS preflight allows Authorization', pf.status === 204 && /Authorization/i.test(pf.headers.get('access-control-allow-headers') || ''), pf.headers.get('access-control-allow-headers'));
      check('CORS exposes Retry-After and Deprecation', /Retry-After/.test(pf.headers.get('access-control-expose-headers') || '') && /Deprecation/.test(pf.headers.get('access-control-expose-headers') || ''), pf.headers.get('access-control-expose-headers'));
    }

    // Draft media privacy.
    const draft = await req('POST', R + '/messages', { token: TA, json: { from: 'ApiA', text: 'draft pic', draft: true } });
    const did = draft.json.id;
    // An image too big to attach inline is refused with the way to send it:
    // as an upload, which has no practical size limit.
    r = await req('PUT', R + '/messages/' + did + '/image', { token: TA, headers: { 'Content-Type': 'image/png' }, body: Buffer.alloc(5000001, 7) });
    check('an inline image over the cap -> 413 naming the upload route', r.status === 413 && /sent inline/.test(r.json && r.json.error) && /\/image\/start/.test(r.json && r.json.error) && /TB/.test(r.json && r.json.error), r.status + ' ' + JSON.stringify(r.json));
    // The storage-delay hook holds every R2 call in the room open, so a test
    // can race a second request into an await (the concurrency checks use it).
    await req('POST', '/api/test-hooks/r2-delay', { owner: true, json: { room: RNAME, ms: 400 } });
    const tDelay = Date.now();
    r = await req('PUT', R + '/messages/' + did + '/image', { token: TA, headers: { 'Content-Type': 'image/png' }, body: PNG });
    const tookMs = Date.now() - tDelay;
    await req('POST', '/api/test-hooks/r2-delay', { owner: true, json: { room: RNAME, ms: 0 } });
    check('attach image to draft', r.status === 200, r.status);
    check('test hook: r2-delay holds a storage call open', tookMs >= 380, tookMs + ' ms');
    r = await req('GET', R + '/messages/' + did + '/image', { token: TB });
    check('other member cannot read draft media', r.status === 404, r.status);
    r = await req('GET', R + '/messages/' + did + '/image', { token: TA });
    check('sender reads own draft media', r.status === 200, r.status);
    r = await req('GET', R + '/messages/' + did + '/image', { headers: { Authorization: 'Bearer ' + TA } });
    check('a media read takes the Bearer header', r.status === 200, r.status);
    r = await req('GET', R + '/messages/' + did + '/image', { owner: true });
    check('owner reads draft media', r.status === 200, r.status);
    r = await req('POST', R + '/messages/' + did + '/publish', { token: TA, json: {} });
    check('publish works', r.status === 200, r.status);
    r = await req('GET', R + '/messages/' + did + '/image', { token: TB });
    check('published media is room-visible', r.status === 200, r.status);

    // An R2 outage fails media writes all-or-nothing (503, nothing saved).
    const STORE_MSG = 'Storage is unavailable right now. Nothing was saved; try again.';
    const roomName = R.slice('/api/rooms/'.length);
    const setFail = (on) => req('POST', '/api/test-hooks/r2-fail', { owner: true, json: { room: roomName, on } });
    r = await setFail(true);
    check('test hook arms the R2 outage', r.status === 200 && r.json && r.json.test_r2_fail === true, r.status + ' ' + r.text.slice(0, 80));
    const beforeOutage = await req('GET', R + '/messages?limit=1000', { token: TA });
    const nBefore = (beforeOutage.json.messages || []).length;
    r = await req('POST', R + '/messages', { token: TA, json: { from: 'ApiA', text: 'outage pic', image: PNG.toString('base64') } });
    check('inline image post during outage -> 503', r.status === 503 && r.json && r.json.error === STORE_MSG, r.status + ' ' + r.text.slice(0, 100));
    const afterOutage = await req('GET', R + '/messages?limit=1000', { token: TA });
    check('failed post left no message behind', (afterOutage.json.messages || []).length === nBefore && !(afterOutage.json.messages || []).some((x) => x.text === 'outage pic'));
    const od = await req('POST', R + '/messages', { token: TA, json: { from: 'ApiA', text: 'outage draft', draft: true } });
    check('text-only draft still works during outage', od.status === 201, od.status);
    r = await req('PUT', R + '/messages/' + od.json.id + '/image', { token: TA, headers: { 'Content-Type': 'image/png' }, body: PNG });
    check('attach during outage -> 503', r.status === 503 && r.json && r.json.error === STORE_MSG, r.status + ' ' + r.text.slice(0, 100));
    r = await req('GET', R + '/messages/' + od.json.id + '/image', { token: TA });
    check('failed attach left no media (GET -> 404)', r.status === 404, r.status);
    r = await setFail(false);
    check('test hook clears the outage', r.status === 200 && r.json && r.json.test_r2_fail === false, r.status);
    r = await req('POST', R + '/messages', { token: TA, json: { from: 'ApiA', text: 'outage pic', image: PNG.toString('base64') } });
    check('same inline post succeeds after the outage (retry works)', r.status === 201 && r.json && !!r.json.image, r.status + ' ' + r.text.slice(0, 100));
    r = await req('PUT', R + '/messages/' + od.json.id + '/image', { token: TA, headers: { 'Content-Type': 'image/png' }, body: PNG });
    check('same attach succeeds after the outage', r.status === 200, r.status);

    // Avatars live in R2. Set -> served with the right type; replace ->
    // new bytes served; an R2 outage on set -> 503 and the old avatar
    // survives; clear -> 404.
    const GIF = Buffer.from('R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==', 'base64');
    r = await req('PUT', R + '/avatar', { token: TA, headers: { 'Content-Type': 'image/png' }, body: PNG });
    check('avatar set (R2) -> 200 with url', r.status === 200 && !!r.json.avatar, r.status + ' ' + r.text.slice(0, 100));
    r = await req('GET', R + '/avatars/ApiA', { token: TA });
    check('avatar served from R2', r.status === 200 && r.headers.get('content-type') === 'image/png', r.status + ' ' + r.headers.get('content-type'));
    r = await req('PUT', R + '/avatar', { token: TA, headers: { 'Content-Type': 'image/gif' }, body: GIF });
    check('avatar replace -> 200', r.status === 200, r.status);
    r = await req('GET', R + '/avatars/ApiA', { token: TA });
    check('replaced avatar served (gif)', r.status === 200 && r.headers.get('content-type') === 'image/gif', r.status + ' ' + r.headers.get('content-type'));
    await setFail(true);
    r = await req('PUT', R + '/avatar', { token: TA, headers: { 'Content-Type': 'image/png' }, body: PNG });
    check('avatar set during R2 outage -> 503 storage text', r.status === 503 && /Storage is unavailable/.test(r.text), r.status + ' ' + r.text.slice(0, 100));
    await setFail(false);
    r = await req('GET', R + '/avatars/ApiA', { token: TA });
    check('old avatar still served after failed set', r.status === 200 && r.headers.get('content-type') === 'image/gif', r.status + ' ' + r.headers.get('content-type'));
    r = await req('DELETE', R + '/avatar', { token: TA });
    check('avatar clear -> 200', r.status === 200, r.status);
    r = await req('GET', R + '/avatars/ApiA', { token: TA });
    check('cleared avatar -> 404', r.status === 404, r.status);
    // Every room holds its avatars in R2 only, so the owner migrate/purge
    // pair is gone.
    r = await req('POST', R + '/admin/migrate-avatars', { owner: true });
    check('retired migrate-avatars route -> 404', r.status === 404, r.status + ' ' + r.text.slice(0, 100));
    r = await req('POST', R + '/admin/purge-avatars', { owner: true });
    check('retired purge-avatars route -> 404', r.status === 404, r.status + ' ' + r.text.slice(0, 100));

    // Signed media URLs. Listings mint them (and carry no
    // invite= anywhere); a signed URL reads with no credential at all;
    // a tampered signature, a signature replayed against another kind,
    // and a past expiry all answer 403; header auth keeps working.
    r = await req('POST', R + '/messages', { token: TA, json: { from: 'ApiA', text: 'signed pic', image: PNG.toString('base64') } });
    check('post for sig tests -> 201 with signed url', r.status === 201 && r.json && /[?&]exp=\d+&sig=/.test(r.json.image.url) && !/invite=/.test(r.json.image.url), r.status + ' ' + (r.json && r.json.image && r.json.image.url));
    const sigPath = new URL(r.json.image.url, BASE).pathname + new URL(r.json.image.url, BASE).search;
    const barePath = new URL(r.json.image.url, BASE).pathname;
    r = await req('GET', sigPath, {});
    check('signed url reads with no credential -> 200', r.status === 200 && r.headers.get('content-type') === 'image/png', r.status);
    const tampered = sigPath.replace(/sig=([A-Za-z0-9_-]+)/, (m, g) => 'sig=' + (g.charAt(0) === 'A' ? 'B' : 'A') + g.slice(1));
    r = await req('GET', tampered, {});
    check('tampered sig -> 403', r.status === 403, r.status);
    r = await req('GET', sigPath.replace('/image', '/video'), {});
    check('sig replayed on another kind -> 403', r.status === 403, r.status);
    r = await req('GET', sigPath.replace(/exp=\d+/, 'exp=1'), {});
    check('past exp -> 403', r.status === 403, r.status);
    r = await req('GET', barePath, { token: TA });
    check('bare url with header auth still -> 200', r.status === 200, r.status);
    // ?invite= does not authenticate a media read.
    r = await req('GET', barePath + '?invite=' + TA, {});
    check('media read with only ?invite= -> 401', r.status === 401, r.status);
    r = await req('GET', R + '/messages?limit=5', { token: TA });
    check('the listing answers header auth', r.status === 200, r.status);
    r = await req('GET', R + '/messages?limit=1000', { token: TA });
    const withImg = (r.json.messages || []).filter((x) => x.image);
    check('listing urls are signed, no invite= anywhere', withImg.length > 0 && withImg.every((x) => /[?&]exp=\d+&sig=/.test(x.image.url)) && !/invite=/.test(r.text), withImg.length + ' images');
    r = await req('PUT', R + '/avatar', { token: TA, headers: { 'Content-Type': 'image/png' }, body: PNG });
    check('avatar set for sig tests -> 200', r.status === 200, r.status);
    r = await req('GET', R + '/members', { token: TA });
    const me = (r.json.members || []).find((x) => x.name === 'ApiA');
    check('members avatar url is signed', !!me && !!me.avatar && /[?&]exp=\d+&sig=/.test(me.avatar) && !/invite=/.test(me.avatar), me && me.avatar);
    const avPath = new URL(me.avatar, BASE).pathname + new URL(me.avatar, BASE).search;
    r = await req('GET', avPath, {});
    check('signed avatar reads with no credential -> 200', r.status === 200 && r.headers.get('content-type') === 'image/png', r.status);
    const avBare = new URL(me.avatar, BASE).pathname;
    r = await req('GET', avBare + '?invite=' + TA, {});
    check('avatar read with only ?invite= -> 401', r.status === 401, r.status);
    await req('DELETE', R + '/avatar', { token: TA });

    // A media url names the stored file: v= (the file's version, unsigned)
    // changes when the file is replaced and nothing else does. Before, a
    // replacement in the same hour had the identical url, and a browser
    // kept showing its cached copy of the old file (media answers are
    // cacheable for an hour) even after a reload.
    r = await req('POST', R + '/messages', { token: TA, json: { from: 'ApiA', text: 'replaced pic', image: PNG.toString('base64'), html: '<!doctype html><title>V</title><p>page</p>', html_name: 'v.html' } });
    const vId = r.json && r.json.id;
    const vRead = async () => { const l = await req('GET', R + '/messages?limit=20', { token: TA }); return (l.json.messages || []).find((x) => x.id === vId) || {}; };
    const v1 = await vRead();
    const v1b = await vRead();
    const u1 = v1.image && v1.image.url;
    check('media version: the url carries v= after exp and sig', /[?&]exp=\d+&sig=[A-Za-z0-9_-]+&v=\d+$/.test(u1 || ''), u1);
    check('media version: reading again without a change gives the same url', !!u1 && u1 === (v1b.image && v1b.image.url) && v1.html.url === v1b.html.url, u1 + ' / ' + (v1b.image && v1b.image.url));
    const b1 = Buffer.from(await (await fetch(BASE + u1)).arrayBuffer());
    r = await req('PUT', R + '/messages/' + vId + '/image', { token: TA, headers: { 'Content-Type': 'image/gif' }, body: GIF });
    check('media version: PUT a different image -> 200', r.status === 200, r.status + ' ' + r.text.slice(0, 120));
    const v2 = await vRead();
    const u2 = v2.image && v2.image.url;
    const qs = (u) => new URL(u, BASE).searchParams;
    check('media version: the replaced image has a new url, the same signature', !!u2 && u2 !== u1 && (qs(u2).get('exp') !== qs(u1).get('exp') || qs(u2).get('sig') === qs(u1).get('sig')) && qs(u2).get('v') !== qs(u1).get('v'), u1 + ' -> ' + u2);
    check('media version: the untouched page keeps its url', v2.html && v2.html.url === v1.html.url, v1.html && v1.html.url);
    const g2 = await fetch(BASE + u2);
    const b2 = Buffer.from(await g2.arrayBuffer());
    check('media version: the new url serves the new image, not the old bytes', g2.status === 200 && b2.equals(GIF) && !b2.equals(b1) && b1.equals(PNG), g2.status + ' ' + b1.length + '/' + b2.length);
    const g2r = await fetch(BASE + u2, { headers: { Range: 'bytes=0-3' } });
    check('media version: a range request with v= -> 206', g2r.status === 206 && Buffer.from(await g2r.arrayBuffer()).equals(GIF.subarray(0, 4)), g2r.status);
    const gh = await fetch(BASE + v2.html.url);
    check('media version: the page opens with v= in its url', gh.status === 200 && /text\/html/.test(gh.headers.get('content-type') || '') && /<p>page<\/p>/.test(await gh.text()), gh.status);
    r = await req('GET', R + '/attachments?kind=image&limit=5', { token: TA });
    const vAtt = (r.json.attachments || []).find((a) => a.id === vId);
    check('media version: the attachments listing carries the same url', !!vAtt && vAtt.url === u2, vAtt && vAtt.url);

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
    // Anyone may call create-room: a body past SMALL_BODY_MAX is refused
    // while it is read, not parsed whole (a 40 MB one used to be).
    r = await putChunked('/api/create-room', 'POST', chunked(2 * 1048576, '{"room":"Bad Name!","pad":"', '"}'), { 'Content-Type': 'application/json', 'CF-Connecting-IP': IPO + '7' });
    check('create-room with a 2 MiB chunked body -> 413', r.status === 413, r.status + ' ' + r.text.slice(0, 120));
    r = await req('POST', '/api/create-room', { headers: { 'CF-Connecting-IP': IPO + '3' }, json: { room: 'apitest-rb-' + SUF, name: 'Rb', email: 'rb-' + SUF + '@example.com' } });
    check('send failure -> 502', r.status === 502, r.status);
    r = await req('GET', '/api/rooms/apitest-rb-' + SUF + '/members', { owner: true });
    check('rolled-back room is gone', r.status === 404, r.status);
    // The success path (the test mail stub accepts "sent-..." addresses):
    // the room stays, with the creator's genesis invite waiting unopened.
    r = await req('POST', '/api/create-room', { headers: { 'CF-Connecting-IP': IPO + '4' }, json: { room: 'apitest-ok-' + SUF, name: 'Founder', email: 'sent-' + SUF + '@example.com' } });
    check('create-room with the email accepted -> 201, no token in the reply', r.status === 201 && !/token|#invite=/.test(r.text), r.status + ' ' + r.text.slice(0, 120));
    r = await req('GET', '/api/rooms/apitest-ok-' + SUF + '/members', { owner: true });
    check('the created room has its genesis invite, unused', r.status === 200 && (r.json.members || []).length === 1 && r.json.members[0].name === 'Founder' && r.json.members[0].status === 'unused', JSON.stringify(r.json).slice(0, 160));
    await req('DELETE', '/api/rooms/apitest-ok-' + SUF + '/invites', { owner: true });
    await req('DELETE', '/api/rooms/apitest-ok-' + SUF + '?confirm=apitest-ok-' + SUF, { owner: true });

    // A room that is being deleted is not free yet. Deleting takes one
    // storage call per media object; a public create that landed in
    // between used to get a genesis invite into the old room's messages,
    // and the name then answered 500.
    {
      const race = 'apitest-race-' + SUF, RR = '/api/rooms/' + race;
      await req('POST', RR, { owner: true });
      const tmp = await req('POST', RR + '/invites', { owner: true, json: { name: 'Old', kind: 'human' } });
      await req('POST', RR + '/messages', { token: tmp.json.token, json: { text: 'old room secret', image: PNG.toString('base64') } });
      await req('DELETE', RR + '/invites', { owner: true });
      await req('POST', '/api/test-hooks/r2-delay', { owner: true, json: { room: race, ms: 1200 } });
      const deleting = req('DELETE', RR + '?confirm=' + race, { owner: true });
      await new Promise((res) => setTimeout(res, 400));
      const mid = await req('POST', '/api/create-room', { headers: { 'CF-Connecting-IP': IPO + '5' }, json: { room: race, name: 'Newcomer', email: 'sent-race-' + SUF + '@example.com' } });
      check('create-room while the room is being deleted -> 409, nothing made', mid.status === 409, mid.status + ' ' + mid.text.slice(0, 120));
      const done = await deleting;
      check('the delete itself completes', done.status === 200 && done.json.deleted === true, done.status + ' ' + done.text.slice(0, 120));
      r = await req('GET', RR + '/members', { owner: true });
      check('afterwards the name is simply free (404, not 500)', r.status === 404, r.status + ' ' + r.text.slice(0, 120));
      r = await req('POST', '/api/create-room', { headers: { 'CF-Connecting-IP': IPO + '6' }, json: { room: race, name: 'Newcomer', email: 'sent-race-' + SUF + '@example.com' } });
      const fresh = await req('GET', RR + '/messages', { owner: true });
      check('and can be created again, empty', r.status === 201 && fresh.status === 200 && (fresh.json.messages || []).length === 0, r.status + ' ' + fresh.status + ' ' + fresh.text.slice(0, 120));
      await req('DELETE', RR + '/invites', { owner: true });
      await req('DELETE', RR + '?confirm=' + race, { owner: true });
    }

    // invite_only invariants.
    r = await req('GET', R + '/members', { owner: true });
    check('members say invite_only', r.json && r.json.invite_only === true, JSON.stringify(r.json && r.json.invite_only));
    r = await req('DELETE', R + '/invites', { owner: true });
    check('delete-invites says invite_only', r.json && r.json.invite_only === true, JSON.stringify(r.json));
    r = await req('GET', R + '/members', { owner: true });
    check('zero-invite room still invite_only', r.json && r.json.invite_only === true && r.json.members.length === 0);

    // Publish-on-complete + destruction (second room).
    const R2 = '/api/rooms/apitest-poc-' + SUF;
    // Game clocks in this room are run out with the test hook (game-expire
    // puts a match's deadline in the past) instead of being waited out:
    // the next read advances the match exactly as the deadline would.
    // runAlarm runs the room's alarm and reports the match as stored, so
    // the alarm path is checked without a read.
    const expireGame = (id) => req('POST', '/api/test-hooks/game-expire', { owner: true, json: { room: R2.slice('/api/rooms/'.length), id } });
    const runAlarm = async (id) => (await req('POST', '/api/test-hooks/alarm', { owner: true, json: { room: R2.slice('/api/rooms/'.length), id } })).json || {};
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

    // Attachments browser: the room's media as one listing (REST).
    r = await req('GET', R2 + '/attachments', { token: TP });
    check('attachments list -> 200', r.status === 200, r.status);
    const atts = (r.json && r.json.attachments) || [];
    check('attachments cover the published media', atts.some(a => a.id === amid && a.kind === 'html' && a.name === 'Probe Page') && atts.some(a => a.id === amid && a.kind === 'doc' && a.name === 'probe.md') && atts.some(a => a.kind === 'video'), JSON.stringify(atts).slice(0, 200));
    check('attachments are newest first', atts.length >= 3 && atts[0].id === amid, JSON.stringify(atts.map(a => a.id + ':' + a.kind)));
    check('attachment entries carry signed urls', atts.every(a => typeof a.url === 'string' && a.url.includes('sig=')), JSON.stringify(atts[0] && atts[0].url));
    check('attachment counts facet by kind', !!(r.json && r.json.counts && r.json.counts.html === 1 && r.json.counts.doc === 1 && r.json.counts.video === 1 && r.json.counts.all === 3), JSON.stringify(r.json && r.json.counts));
    r = await req('GET', R2 + '/attachments?kind=html,doc', { token: TP });
    check('attachments kind filter', ((r.json && r.json.attachments) || []).length === 2 && (r.json.attachments || []).every(a => a.id === amid), JSON.stringify(r.json && r.json.attachments).slice(0, 160));
    check('kind filter leaves counts faceted', !!(r.json && r.json.counts && r.json.counts.all === 3), JSON.stringify(r.json && r.json.counts));
    r = await req('GET', R2 + '/attachments?from=Nobody', { token: TP });
    check('attachments sender filter empties', ((r.json && r.json.attachments) || []).length === 0 && !!(r.json && r.json.counts && r.json.counts.all === 0), JSON.stringify(r.json).slice(0, 120));
    r = await req('GET', R2 + '/attachments?kind=bogus', { token: TP });
    check('attachments bad kind -> 400', r.status === 400, r.status);
    r = await req('GET', R2 + '/attachments?before=nope', { token: TP });
    check('attachments bad cursor -> 400', r.status === 400, r.status);
    r = await req('GET', R2 + '/attachments', {});
    check('attachments denied without access', r.status === 401 || r.status === 403, r.status);
    const imgPost = await req('POST', R2 + '/messages', { token: TP, json: { from: 'Poc', text: 'a picture', image: PNG.toString('base64') } });
    check('post with image -> 201', imgPost.status === 201, imgPost.status);
    const imgId = imgPost.json && imgPost.json.id;
    r = await req('GET', R2 + '/attachments?limit=1', { token: TP });
    check('attachments page 1 is the newest', ((r.json && r.json.attachments) || []).length === 1 && r.json.attachments[0].id === imgId && r.json.attachments[0].kind === 'image' && typeof r.json.next_cursor === 'string', JSON.stringify(r.json).slice(0, 200));
    const cur1 = r.json && r.json.next_cursor;
    r = await req('GET', R2 + '/attachments?limit=2&before=' + encodeURIComponent(cur1), { token: TP });
    check('attachments page 2 continues without repeats', ((r.json && r.json.attachments) || []).length === 2 && r.json.attachments.every(a => a.id !== imgId) && r.json.attachments[0].id === amid, JSON.stringify(r.json).slice(0, 200));
    r = await req('GET', R2 + '/attachments?limit=2&before=' + encodeURIComponent(r.json && r.json.next_cursor), { token: TP });
    check('attachments last page ends the cursor', ((r.json && r.json.attachments) || []).length === 1 && r.json.attachments[0].kind === 'video' && r.json.next_cursor === null, JSON.stringify(r.json).slice(0, 200));
    const attDr = await req('POST', R2 + '/messages', { token: TP, json: { from: 'Poc', text: 'draft pic', draft: true } });
    const attDrId = attDr.json && attDr.json.id;
    r = await req('PUT', R2 + '/messages/' + attDrId + '/image', { token: TP, json: { image: PNG.toString('base64') } });
    check('attach image to draft', r.status === 200, r.status + ' ' + r.text.slice(0, 80));
    r = await req('GET', R2 + '/attachments', { token: TP });
    check('draft attachment is not listed', !((r.json && r.json.attachments) || []).some(a => a.id === attDrId), JSON.stringify(((r.json && r.json.attachments) || []).map(a => a.id)));
    r = await req('POST', R2 + '/messages/' + attDrId + '/publish', { token: TP, json: {} });
    check('publish the pic draft', r.status === 200, r.status);
    r = await req('GET', R2 + '/attachments?kind=image', { token: TP });
    check('published draft attachment is listed', ((r.json && r.json.attachments) || []).some(a => a.id === attDrId), JSON.stringify(r.json).slice(0, 160));
    // Media caching: signed urls sit on an hour grid (stable across
    // listings, so browsers can cache), and media serves immutable
    // cache headers instead of no-cache.
    const lst1 = await req('GET', R2 + '/messages?limit=50', { token: TP });
    const lst2 = await req('GET', R2 + '/messages?limit=50', { token: TP });
    const imgMsg1 = (lst1.json.messages || []).find(m => m.id === imgId);
    const imgMsg2 = (lst2.json.messages || []).find(m => m.id === imgId);
    check('media urls are stable across listings', !!(imgMsg1 && imgMsg2 && imgMsg1.image && imgMsg1.image.url === imgMsg2.image.url), (imgMsg1 && imgMsg1.image && imgMsg1.image.url) + ' vs ' + (imgMsg2 && imgMsg2.image && imgMsg2.image.url));
    const expParam = imgMsg1 && imgMsg1.image && Number(new URLSearchParams(imgMsg1.image.url.split('?')[1]).get('exp'));
    check('media url expiry sits on the hour grid', !!expParam && expParam % 3600 === 0, String(expParam));
    r = await req('GET', R2 + '/messages/' + amid + '/html', { token: TP });
    check('media serves immutable cache headers', (r.headers.get('cache-control') || '') === 'private, max-age=3600, immutable', r.headers.get('cache-control'));

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
    check('game created into its lobby', r.status === 201 && r.json.game && r.json.game.status === 'lobby', r.status + ' ' + JSON.stringify(r.json).slice(0, 160));
    const G = r.json.game; const gid = G.id;
    check('lobby seats: creator in, invitees waiting', G.you.accepted === true && (G.awaiting_accept || []).join() === 'Rex,Rae' && G.players.find(p => p.name === 'Rex').accepted === false && typeof G.lobby_deadline === 'number', JSON.stringify(G).slice(0, 220));
    r = await req('POST', R2 + '/games/' + gid + '/moves', { token: TP, json: { dir: 'down' } });
    check('move in the lobby -> 409', r.status === 409 && String(r.json.error).includes('lobby'), r.status + ' ' + JSON.stringify(r.json));
    r = await req('GET', R2 + '/messages?limit=5', { token: TRex });
    const rexNudge = ((r.json.room_state && r.json.room_state.awaiting_you) || []).find(x => x.type === 'game' && x.id === gid);
    check('room_state nudges the lobby accept', !!rexNudge && rexNudge.action === 'accept' && rexNudge.turn === 'lobby' && rexNudge.call.path.endsWith('/games/' + gid + '/accept'), JSON.stringify(rexNudge));
    const invPip = await req('POST', R2 + '/invites', { owner: true, json: { name: 'Pip', kind: 'agent' } });
    await req('GET', R2 + '/members', { token: invPip.json.token });
    r = await req('POST', R2 + '/games/' + gid + '/accept', { token: invPip.json.token, json: {} });
    check('accept by a non-player -> 403', r.status === 403, r.status);
    r = await req('POST', R2 + '/games/' + gid + '/accept', { token: TRex, json: {} });
    check('first accept keeps the lobby open', r.status === 200 && r.json.game.status === 'lobby' && (r.json.game.awaiting_accept || []).join() === 'Rae', r.status + ' ' + JSON.stringify(r.json.game).slice(0, 160));
    r = await req('POST', R2 + '/games/' + gid + '/accept', { token: TRae, json: {} });
    check('last accept starts the match', r.status === 200 && r.json.game.status === 'running' && typeof r.json.game.deadline === 'number', r.status + ' ' + JSON.stringify(r.json.game).slice(0, 160));
    r = await req('GET', R2 + '/games/' + gid, { token: TP });
    check('spawn + legal moves', r.json.game.players[0].x === 3 && r.json.game.players[0].y === 5 && r.json.game.you.legal_moves.join() === 'up,down,right', JSON.stringify(r.json.game.players[0]) + ' ' + JSON.stringify(r.json.game.you));
    r = await req('POST', R2 + '/games', { token: TP, json: { from: 'Poc', players: ['Poc', 'Rex'] } });
    check('default tick_seconds is 120', r.status === 201 && r.json.game.tick_seconds === 120, r.status + ' tick=' + (r.json.game && r.json.game.tick_seconds));
    check('default mode is live, 2-player grid defaults to 24x18', r.json.game.mode === 'live' && r.json.game.w === 24 && r.json.game.h === 18, JSON.stringify(r.json.game).slice(0, 160));
    const defId = r.json.game.id;
    r = await req('POST', R2 + '/games/' + defId + '/cancel', { token: TP, json: {} });
    check('default-tick game cancels clean', r.status === 200 && r.json.game.status === 'cancelled', r.status);
    r = await req('POST', R2 + '/games', { token: TP, json: { from: 'Poc', players: ['Poc', 'Rex'], mode: 'async' } });
    check('async mode: cap defaults to 3600', r.status === 201 && r.json.game.mode === 'async' && r.json.game.tick_seconds === 3600, r.status + ' ' + JSON.stringify(r.json.game).slice(0, 160));
    const asyncId = r.json.game.id;
    r = await req('POST', R2 + '/games/' + asyncId + '/cancel', { token: TP, json: {} });
    check('async game cancels clean', r.status === 200 && r.json.game.status === 'cancelled', r.status);
    r = await req('POST', R2 + '/games', { token: TP, json: { from: 'Poc', players: ['Poc', 'Rex', 'Rae'], mode: 'async', tick_seconds: 900 } });
    check('async mode honours an explicit cap', r.status === 201 && r.json.game.mode === 'async' && r.json.game.tick_seconds === 900 && r.json.game.w === 30, r.status + ' ' + JSON.stringify(r.json.game).slice(0, 160));
    const asyncCapId = r.json.game.id;
    r = await req('POST', R2 + '/games/' + asyncCapId + '/cancel', { token: TP, json: {} });
    check('async-cap game cancels clean', r.status === 200 && r.json.game.status === 'cancelled', r.status);
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
    r = await req('POST', R2 + '/games/' + clockId + '/accept', { token: TRex, json: {} });
    check('clock match starts on accept', r.status === 200 && r.json.game.status === 'running', r.status);
    r = await req('POST', R2 + '/games/' + gid + '/moves', { token: TP, json: { dir: 'down' } });
    check('queue a move', r.status === 200 && r.json.game.you.queued === 'down' && r.json.resolved === false, r.status + ' ' + JSON.stringify(r.json).slice(0, 140));
    await req('POST', R2 + '/games/' + gid + '/moves', { token: TRex, json: { dir: 'up' } });
    r = await req('POST', R2 + '/games/' + gid + '/moves', { token: TRae, json: { dir: 'left' } });
    check('last move resolves the tick', r.status === 200 && r.json.resolved === true && r.json.game.tick === 1, r.status + ' ' + JSON.stringify(r.json).slice(0, 140));
    r = await req('GET', R2 + '/games/' + gid, { token: TP });
    const tick1 = (r.json.game.log || []).find(e => e.tick === 1);
    check('tick log attributes submitted moves', !!tick1 && tick1.text.includes('Poc down (submitted)') && tick1.text.includes('Rex up (submitted)') && tick1.text.includes('Rae left (submitted)'), JSON.stringify(tick1));
    check('move totals count submissions', !!r.json.game.moves && ['Poc', 'Rex', 'Rae'].every(n => r.json.game.moves[n] && r.json.game.moves[n].submitted === 1 && r.json.game.moves[n].defaulted === 0), JSON.stringify(r.json.game.moves));
    const ml1 = (r.json.game.move_log || []).filter(e => e.tick === 1);
    check('move_log records submitted arrivals', ml1.length === 3 && ml1.every(e => e.submitted === true && typeof e.at === 'number' && typeof e.resolved_at === 'number' && e.at <= e.resolved_at), JSON.stringify(ml1).slice(0, 200));
    r = await req('GET', R2 + '/messages?limit=10', { token: TP });
    check('referee stays quiet on a resolved tick', !(r.json.messages || []).some(x => x.from === 'Referee'), JSON.stringify((r.json.messages || []).map(x => x.from + ': ' + String(x.text).slice(0, 60))));
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
    const refPosts = (r.json.messages || []).filter(x => x.from === 'Referee' && x.text.includes('match #' + gid));
    check('exactly one referee post per match (the result)', refPosts.length === 1 && refPosts[0].text.includes('is over'), JSON.stringify(refPosts.map(x => x.text.slice(0, 60))));
    check('result post reports move totals', refPosts.length === 1 && refPosts[0].text.includes('Moves submitted:'), refPosts.map(x => x.text.slice(0, 160)).join(' | '));
    check('referee post carries kind non_interactive and targets', refPosts.length === 1 && refPosts[0].kind === 'non_interactive' && Array.isArray(refPosts[0].targets), JSON.stringify(refPosts.map(x => x.kind)));
    const nudged = ((r.json.room_state && r.json.room_state.awaiting_you) || []).some(x => x.type === 'game' && x.id === clockId);
    check('room_state nudges the clock match', nudged, JSON.stringify(r.json.room_state).slice(0, 200));
    const nudgeItem = ((r.json.room_state && r.json.room_state.awaiting_you) || []).find(x => x.type === 'game' && x.id === clockId);
    check('awaiting game item carries its turn counter', !!nudgeItem && typeof nudgeItem.turn === 'number', JSON.stringify(nudgeItem));
    // Duel forfeit probe: created before the clock wait below with a 30s
    // round deadline and only one throw in - after the wait, its round
    // must have resolved by forfeit (alarm or read catch-up; same record).
    r = await req('POST', R2 + '/games', { token: TP, json: { game: 'duel', from: 'Poc', players: ['Poc', 'Rex'], best_of: 3, tick_seconds: 30 } });
    check('duel created', r.status === 201 && r.json.game.type === 'duel' && r.json.game.target === 2 && r.json.game.round === 1, r.status + ' ' + JSON.stringify(r.json).slice(0, 160));
    const duelF = r.json.game.id;
    r = await req('POST', R2 + '/games/' + duelF + '/accept', { token: TRex, json: {} });
    check('duel starts when both accept', r.status === 200 && r.json.game.status === 'running' && r.json.game.round_seconds === 30, r.status + ' ' + JSON.stringify(r.json.game).slice(0, 140));
    r = await req('POST', R2 + '/games/' + duelF + '/moves', { token: TP, json: { dir: 'rock' } });
    check('duel throw queues without resolving', r.status === 200 && r.json.resolved === false && r.json.game.you.queued === 'rock', r.status + ' ' + JSON.stringify(r.json).slice(0, 140));
    r = await req('GET', R2 + '/games/' + duelF, { token: TRex });
    // Secrecy: the rival sees Poc has thrown, and his own queued throw is
    // null - Poc's actual throw appears nowhere. (legal_moves names all
    // three throws as public vocabulary, so it is stripped before scanning;
    // so is how_to_play, the rules text, for the same reason.)
    const rivalView = JSON.stringify(Object.assign({}, r.json.game, { how_to_play: null })).split('"legal_moves":["rock","paper","scissors"]').join('');
    check('duel throw stays secret from the rival', r.status === 200 && (r.json.game.players.find(p => p.name === 'Poc') || {}).thrown === true && r.json.game.you.queued === null && !rivalView.includes('rock'), JSON.stringify(r.json.game).slice(0, 200));
    // The alarm is armed by the match's deadline, and the alarm alone (no
    // read) advances the match once that deadline has passed.
    let al = await runAlarm(clockId);
    check('the room alarm is armed by the running match', al.ran === true && al.tick === 0 && typeof al.armed_after === 'number' && al.armed_after <= al.deadline && al.armed_after > Date.now() - 1000, JSON.stringify(al));
    await expireGame(clockId);
    // (the queued-throw duel's 30 s round runs out here too: its forfeit
    // checks follow the cancelled clock match below)
    await expireGame(duelF);
    al = await runAlarm(clockId);
    check('the alarm alone advances an expired match', al.ran === true && al.tick >= 1 && al.status === 'running' && al.deadline > Date.now(), JSON.stringify(al));
    r = await req('GET', R2 + '/games/' + clockId, { token: TP });
    check('expired tick sends bikes straight', r.json.game.tick >= 1 && r.json.game.players[0].x >= 4 && r.json.game.players[0].alive, JSON.stringify(r.json.game.players));
    const clockTick = (r.json.game.log || []).filter(e => e.tick >= 1).pop();
    check('tick log attributes clock defaults', !!clockTick && clockTick.text.includes('Poc right (clock default)') && clockTick.text.includes('Rex left (clock default)'), JSON.stringify(clockTick));
    check('move totals count clock defaults', !!r.json.game.moves && r.json.game.moves.Poc.submitted === 0 && r.json.game.moves.Poc.defaulted >= 1 && r.json.game.moves.Rex.submitted === 0 && r.json.game.moves.Rex.defaulted >= 1, JSON.stringify(r.json.game.moves));
    const mlc = (r.json.game.move_log || []).filter(e => e.tick >= 1);
    check('move_log records clock defaults with no arrival', mlc.length >= 2 && mlc.every(e => e.submitted === false && e.at === null && typeof e.resolved_at === 'number'), JSON.stringify(mlc).slice(0, 200));
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
    r = await req('GET', R2 + '/games/' + duelF, { token: TP });
    const fr = (r.json.game.rounds || [])[0];
    check('duel round resolves by forfeit at the deadline', r.json.game.status === 'running' && r.json.game.round === 2 && !!fr && fr.winner === 'Poc' && fr.throws.Poc === 'rock' && !('Rex' in fr.throws) && typeof fr.throws_at.Poc === 'number', JSON.stringify(r.json.game).slice(0, 220));
    // Play its second round out: Poc reaches the target, and the result
    // post must count the forfeited round.
    await req('POST', R2 + '/games/' + duelF + '/moves', { token: TP, json: { dir: 'rock' } });
    r = await req('POST', R2 + '/games/' + duelF + '/moves', { token: TRex, json: { dir: 'scissors' } });
    check('forfeit duel finishes by play', r.status === 200 && r.json.game.status === 'finished' && r.json.game.winner === 'Poc', JSON.stringify(r.json.game).slice(0, 200));
    r = await req('GET', R2 + '/messages?limit=50', { token: TP });
    check('duel result post counts forfeits', (r.json.messages || []).some(x => x.from === 'Referee' && x.text.includes('Duel match #' + duelF + ' is over') && x.text.includes('(1 by forfeit)')), JSON.stringify((r.json.messages || []).filter(x => x.from === 'Referee').map(x => x.text.slice(0, 90))));
    // A played duel: ties score nobody, throws go public once a round
    // resolves, and reaching the target finishes it with a result post.
    r = await req('POST', R2 + '/games', { token: TP, json: { game: 'duel', from: 'Poc', players: ['Poc', 'Rex'], best_of: 3, tick_seconds: 3600 } });
    const duelP = r.json.game.id;
    await req('POST', R2 + '/games/' + duelP + '/accept', { token: TRex, json: {} });
    r = await req('POST', R2 + '/games/' + duelP + '/moves', { token: TP, json: { dir: 'spock' } });
    check('duel bogus throw -> 400', r.status === 400 && Array.isArray(r.json.legal_moves), r.status + ' ' + JSON.stringify(r.json));
    await req('POST', R2 + '/games/' + duelP + '/moves', { token: TP, json: { dir: 'rock' } });
    r = await req('POST', R2 + '/games/' + duelP + '/moves', { token: TRex, json: { throw: 'rock' } });
    check('duel tie round scores nobody', r.status === 200 && r.json.resolved === true && r.json.game.round === 2 && r.json.game.score.Poc === 0 && r.json.game.score.Rex === 0 && (r.json.game.rounds[0] || {}).winner === null, JSON.stringify(r.json.game).slice(0, 200));
    await req('POST', R2 + '/games/' + duelP + '/moves', { token: TP, json: { dir: 'rock' } });
    r = await req('POST', R2 + '/games/' + duelP + '/moves', { token: TRex, json: { dir: 'scissors' } });
    check('duel round reveals both throws', r.status === 200 && r.json.game.score.Poc === 1 && (r.json.game.rounds[1] || {}).throws.Rex === 'scissors', JSON.stringify(r.json.game).slice(0, 200));
    await req('POST', R2 + '/games/' + duelP + '/moves', { token: TP, json: { dir: 'paper' } });
    r = await req('POST', R2 + '/games/' + duelP + '/moves', { token: TRex, json: { dir: 'rock' } });
    check('duel finishes at the target', r.status === 200 && r.json.game.status === 'finished' && r.json.game.winner === 'Poc', JSON.stringify(r.json.game).slice(0, 200));
    check('duel state carries the pair head-to-head', !!r.json.game.h2h && r.json.game.h2h.total === 2 && r.json.game.h2h.tally.Poc === 2 && !r.json.game.h2h.tally.Rex, JSON.stringify(r.json.game.h2h || null));
    r = await req('POST', R2 + '/games/' + duelP + '/moves', { token: TP, json: { dir: 'rock' } });
    check('duel throw after finish -> 409', r.status === 409, r.status);
    r = await req('GET', R2 + '/messages?limit=50', { token: TP });
    check('referee posted the duel result', (r.json.messages || []).some(x => x.from === 'Referee' && x.text.includes('Duel match #' + duelP + ' is over')), JSON.stringify((r.json.messages || []).filter(x => x.from === 'Referee').map(x => x.text.slice(0, 60))));
    r = await req('POST', R2 + '/games', { token: TP, json: { game: 'duel', from: 'Poc', players: ['Poc', 'Rex', 'Rae'] } });
    check('duel with 3 players -> 400', r.status === 400, r.status);
    // The lobby's endings: a decline calls the match off with a Referee
    // post naming the player, and a lobby nobody completes expires on
    // its join window and is called off the same way.
    r = await req('POST', R2 + '/games', { token: TP, json: { game: 'duel', from: 'Poc', players: ['Poc', 'Rex'], best_of: 3 } });
    check('duel default round clock is 180', r.status === 201 && r.json.game.round_seconds === 180 && r.json.game.status === 'lobby', r.status + ' ' + JSON.stringify(r.json.game).slice(0, 160));
    const duelD = r.json.game.id;
    r = await req('POST', R2 + '/games/' + duelD + '/decline', { token: TRex, json: {} });
    check('decline calls the match off', r.status === 200 && r.json.game.status === 'cancelled' && r.json.game.declined_by === 'Rex', r.status + ' ' + JSON.stringify(r.json.game).slice(0, 160));
    r = await req('POST', R2 + '/games/' + duelD + '/moves', { token: TP, json: { dir: 'rock' } });
    check('throw after a decline -> 409', r.status === 409, r.status);
    r = await req('GET', R2 + '/messages?limit=50', { token: TP });
    check('referee posts the decline', (r.json.messages || []).some(x => x.from === 'Referee' && x.text.includes('Duel match #' + duelD + ' is off') && x.text.includes('Rex declined')), JSON.stringify((r.json.messages || []).filter(x => x.from === 'Referee').map(x => x.text.slice(0, 80))));
    r = await req('POST', R2 + '/games', { token: TP, json: { from: 'Poc', players: ['Poc', 'Rex'], tick_seconds: 3600, lobby_seconds: 5, w: 12, h: 10 } });
    const expId = r.json.game.id;
    check('short lobby created', r.status === 201 && r.json.game.status === 'lobby' && typeof r.json.game.lobby_deadline === 'number', r.status + ' ' + JSON.stringify(r.json.game).slice(0, 160));
    await new Promise(res => setTimeout(res, 6000));
    r = await req('GET', R2 + '/games/' + expId, { token: TP });
    check('expired lobby is called off', r.status === 200 && r.json.game.status === 'cancelled', r.status + ' ' + JSON.stringify(r.json.game).slice(0, 160));
    r = await req('GET', R2 + '/messages?limit=50', { token: TP });
    check('referee posts the expiry', (r.json.messages || []).some(x => x.from === 'Referee' && x.text.includes('match #' + expId + ' never started') && x.text.includes('Rex')), JSON.stringify((r.json.messages || []).filter(x => x.from === 'Referee').map(x => x.text.slice(0, 80))));

    // Light Cycles absence rule: a rider the clock
    // carries for three ticks in a row is taken out. Rex rides on
    // safe_moves every tick; Poc never submits a move.
    r = await req('POST', R2 + '/games', { token: TP, json: { from: 'Poc', players: ['Poc', 'Rex'], tick_seconds: 30 } });
    const lcAbsent = r.json.game.id;
    await req('POST', R2 + '/games/' + lcAbsent + '/accept', { token: TRex, json: {} });
    let lcFinal = null;
    let lcSafeOk = false;
    for (let i = 0; i < 100 && !lcFinal; i++) {
      const st = await req('GET', R2 + '/games/' + lcAbsent, { token: TRex });
      const g = st.json && st.json.game;
      if (!g) break;
      if (g.status === 'finished') { lcFinal = g; break; }
      if (g.you && g.you.alive && !g.you.queued) {
        if (Array.isArray(g.you.safe_moves) && g.you.safe_moves.every(d => (g.you.legal_moves || []).indexOf(d) >= 0)) lcSafeOk = true;
        const mv = (g.you.safe_moves && g.you.safe_moves[0]) || (g.you.legal_moves || [])[0];
        if (mv) await req('POST', R2 + '/games/' + lcAbsent + '/moves', { token: TRex, json: { dir: mv } });
      }
      await expireGame(lcAbsent);
    }
    check('safe_moves ride inside legal_moves', lcSafeOk, '');
    check('an absent rider is taken out after three clock ticks', !!lcFinal && lcFinal.winner === 'Rex' && (lcFinal.log || []).some(e => e.text.includes('taken out - three ticks')), JSON.stringify(lcFinal).slice(0, 240));

    // Light Cycles' move_log window: a full state carries the last 20
    // ticks (LC_MOVE_LOG_TICKS) from move_log_from, and the whole log only
    // when asked (?log=full on REST, full_log on MCP get_game). Two riders
    // on the biggest grid ride scripted paths that cannot meet: Poc up to
    // the top wall, then left; Rex down to the bottom wall, then right.
    r = await req('POST', R2 + '/games', { token: TP, json: { from: 'Poc', players: ['Poc', 'Rex'], mode: 'async', w: 40, h: 30 } });
    const lcWin = r.json.game.id;
    await req('POST', R2 + '/games/' + lcWin + '/accept', { token: TRex, json: {} });
    const lcPath = { Poc: Array(15).fill('up').concat(Array(10).fill('left')), Rex: Array(14).fill('down').concat(Array(9).fill('right'), ['up', 'up']) };
    let lcEarly = null, lcLast = null;
    for (let t = 0; t < 24; t++) {
      await req('POST', R2 + '/games/' + lcWin + '/moves', { token: TP, json: { dir: lcPath.Poc[t] } });
      lcLast = await req('POST', R2 + '/games/' + lcWin + '/moves', { token: TRex, json: { dir: lcPath.Rex[t] } });
      if (t === 2) lcEarly = lcLast.json && lcLast.json.game;
    }
    const lcTicks = (ml) => (ml || []).map((e) => e.tick);
    check('lc move_log is whole before 20 ticks (move_log_from 1)', !!lcEarly && lcEarly.tick === 3 && lcEarly.move_log_from === 1 && (lcEarly.move_log || []).length === 6, JSON.stringify(lcEarly && { tick: lcEarly.tick, from: lcEarly.move_log_from, n: (lcEarly.move_log || []).length }));
    const lcReply = lcLast.json && lcLast.json.game;
    check('lc move reply windows move_log to the last 20 ticks', !!lcReply && lcReply.status === 'running' && lcReply.tick === 24 && lcReply.move_log_from === 5 && lcReply.move_log.length === 40 && Math.min(...lcTicks(lcReply.move_log)) === 5 && Math.max(...lcTicks(lcReply.move_log)) === 24, JSON.stringify(lcReply && { status: lcReply.status, tick: lcReply.tick, from: lcReply.move_log_from, n: (lcReply.move_log || []).length }));
    r = await req('GET', R2 + '/games/' + lcWin, { token: TP });
    check('lc GET windows move_log too', r.status === 200 && r.json.game.move_log_from === 5 && r.json.game.move_log.length === 40 && r.json.game.moves.Poc.submitted === 24, r.status + ' ' + JSON.stringify({ from: r.json.game.move_log_from, n: (r.json.game.move_log || []).length }));
    check('lc GET carries a short narrative log (24 lines at most)', (r.json.game.log || []).length <= 24, String((r.json.game.log || []).length));
    const lcWinBytes = r.text.length;
    r = await req('GET', R2 + '/games/' + lcWin + '?log=full', { token: TP });
    check('lc GET ?log=full returns the whole move_log', r.status === 200 && r.json.game.move_log_from === 1 && r.json.game.move_log.length === 48 && Math.min(...lcTicks(r.json.game.move_log)) === 1 && r.text.length > lcWinBytes, r.status + ' ' + JSON.stringify({ from: r.json.game.move_log_from, n: (r.json.game.move_log || []).length, bytes: [lcWinBytes, r.text.length] }));
    r = await mcp(R2, 'tools/call', { name: 'get_game', arguments: { id: lcWin } }, { token: TP });
    let lcMcp = r.json && r.json.result && r.json.result.structuredContent && r.json.result.structuredContent.game;
    check('lc MCP get_game windows move_log by default', !!lcMcp && lcMcp.move_log_from === 5 && (lcMcp.move_log || []).length === 40, JSON.stringify(r.json).slice(0, 200));
    r = await mcp(R2, 'tools/call', { name: 'get_game', arguments: { id: lcWin, full_log: true } }, { token: TP });
    lcMcp = r.json && r.json.result && r.json.result.structuredContent && r.json.result.structuredContent.game;
    check('lc MCP get_game with full_log returns the whole move_log', !!lcMcp && lcMcp.move_log_from === 1 && (lcMcp.move_log || []).length === 48, JSON.stringify(r.json).slice(0, 200));
    // a move with ?log=full answers with the whole log (the web app's moves)
    await req('POST', R2 + '/games/' + lcWin + '/moves', { token: TP, json: { dir: lcPath.Poc[24] } });
    r = await req('POST', R2 + '/games/' + lcWin + '/moves?log=full', { token: TRex, json: { dir: lcPath.Rex[24] } });
    check('lc move with ?log=full answers with the whole move_log', r.status === 200 && r.json.resolved === true && r.json.game.tick === 25 && r.json.game.move_log_from === 1 && r.json.game.move_log.length === 50, r.status + ' ' + JSON.stringify(r.json.game && { tick: r.json.game.tick, from: r.json.game.move_log_from, n: (r.json.game.move_log || []).length }));
    await req('POST', R2 + '/games/' + lcWin + '/cancel', { token: TP, json: {} });

    // Battleship: lobby, placement (explicit fleets both sides),
    // secrecy, turn order, a sinking, the win, and the result post.
    // Poc's fleet hugs rows 10/5-8/6/2-4/2, Rex's rows 1/3-6/5/7-9, so
    // every scripted shot's outcome is known in advance.
    // Both captains walk away: the late checks at the end run its 30s
    // turns out (expireGame) and verify it ends with no winner, not a
    // win for whoever's clock happened to fire last.
    r = await req('POST', R2 + '/games', { token: TP, json: { game: 'battleship', from: 'Poc', players: ['Poc', 'Rex'], tick_seconds: 30 } });
    const bsAbandon = r.json.game.id;
    await req('POST', R2 + '/games/' + bsAbandon + '/accept', { token: TRex, json: {} });
    await req('POST', R2 + '/games/' + bsAbandon + '/moves', { token: TP, json: { dir: 'random' } });
    await req('POST', R2 + '/games/' + bsAbandon + '/moves', { token: TRex, json: { dir: 'random' } });
    r = await req('POST', R2 + '/games', { token: TP, json: { game: 'battleship', from: 'Poc', players: ['Poc', 'Rex', 'Rae', 'Poc', 'Rex', 'Rae', 'Poc'] } });
    check('battleship with 7 players -> 400', r.status === 400, r.status);
    r = await req('POST', R2 + '/games', { token: TP, json: { game: 'battleship', from: 'Poc', players: ['Poc', 'Rex'], tick_seconds: 3600 } });
    check('battleship created in its lobby', r.status === 201 && r.json.game.type === 'battleship' && r.json.game.status === 'lobby' && r.json.game.turn_seconds === 3600, r.status + ' ' + JSON.stringify(r.json.game).slice(0, 160));
    const bsId = r.json.game.id;
    r = await req('POST', R2 + '/games/' + bsId + '/moves', { token: TP, json: { dir: 'random' } });
    check('battleship move in the lobby -> 409', r.status === 409, r.status);
    r = await req('POST', R2 + '/games/' + bsId + '/accept', { token: TRex, json: {} });
    check('battleship starts into placement when both accept', r.status === 200 && r.json.game.status === 'running' && r.json.game.phase === 'setup', r.status + ' ' + JSON.stringify(r.json.game).slice(0, 160));
    r = await req('POST', R2 + '/games/' + bsId + '/moves', { token: TP, json: { dir: 'C5' } });
    check('a shot before placement -> 400', r.status === 400, r.status + ' ' + JSON.stringify(r.json).slice(0, 120));
    r = await req('POST', R2 + '/games/' + bsId + '/moves', { token: TP, json: { dir: 'A1H,A1V,C3H,E5H,G7H' } });
    check('overlapping placement -> 400', r.status === 400, r.status + ' ' + JSON.stringify(r.json).slice(0, 120));
    r = await req('POST', R2 + '/games/' + bsId + '/moves', { token: TP, json: { dir: 'A10H,C5V,E6H,G2V,I2H' } });
    check('explicit placement lands', r.status === 200 && r.json.game.you.fleet.length === 5 && r.json.game.you.fleet.reduce((n, s) => n + s.cells.length, 0) === 17, r.status + ' ' + JSON.stringify(r.json.game.you || {}).slice(0, 160));
    r = await req('POST', R2 + '/games/' + bsId + '/moves', { token: TRex, json: { dir: 'A1H,C3V,E5H,G7V,I9H' } });
    check('second placement opens play, first shot is a coin flip', r.status === 200 && r.json.resolved === true && r.json.game.phase === 'play' && (r.json.game.turn_of === 'Poc' || r.json.game.turn_of === 'Rex'), r.status + ' ' + JSON.stringify(r.json.game).slice(0, 160));
    const bsFirst = r.json.game.turn_of;
    // Secrecy: neither captain's view carries the rival's unhit cells
    // (quoted labels appear only as cell values), and a spectator
    // gets counts, never a fleet. you.legal_moves is stripped before
    // each string match: it lists every open cell by design, ship and
    // water alike, so a label appearing there says nothing about the
    // fleet.
    r = await req('GET', R2 + '/games/' + bsId, { token: TRex });
    const rexObj = JSON.parse(JSON.stringify(r.json.game));
    if (rexObj.you) delete rexObj.you.legal_moves;
    const rexView = JSON.stringify(rexObj);
    check('rival fleet stays secret from Rex', r.status === 200 && !rexView.includes('"A10"') && !rexView.includes('"J2"'), rexView.slice(0, 220));
    r = await req('GET', R2 + '/games/' + bsId, { token: TP });
    const pocObj = JSON.parse(JSON.stringify(r.json.game));
    if (pocObj.you) delete pocObj.you.legal_moves;
    check('rival fleet stays secret from Poc', r.status === 200 && !JSON.stringify(pocObj).includes('"J9"'), JSON.stringify(pocObj).slice(0, 220));
    r = await req('GET', R2 + '/games/' + bsId, { token: TRae });
    check('spectator sees no fleet at all', r.status === 200 && r.json.game.you.playing === false && !('fleet' in r.json.game) && (r.json.game.players || []).every(p => p.placed === true), JSON.stringify(r.json.game).slice(0, 220));
    r = await req('POST', R2 + '/games/' + bsId + '/moves', { token: bsFirst === 'Poc' ? TRex : TP, json: { dir: 'J10' } });
    check('firing out of turn -> 409', r.status === 409, r.status);
    // If the coin flip gave Rex the first shot, he spends it on water
    // (J10 misses Poc's fleet), so the scripted hunt below always runs
    // Poc-shoots / Rex-misses from Poc's first turn.
    if (bsFirst === 'Rex') await req('POST', R2 + '/games/' + bsId + '/moves', { token: TRex, json: { dir: 'J10' } });
    r = await req('POST', R2 + '/games/' + bsId + '/moves', { token: TP, json: { dir: 'A1' } });
    check('first shot hits and passes the turn', r.status === 200 && r.json.game.you.shots.A1 === 'hit' && r.json.game.turn_of === 'Rex' && (r.json.game.players.find(p => p.name === 'Poc') || {}).hits === 1, r.status + ' ' + JSON.stringify(r.json.game).slice(0, 200));
    r = await req('GET', R2 + '/messages?limit=50', { token: TRex });
    const bsNudge = ((r.json.room_state && r.json.room_state.awaiting_you) || []).find(x => x.type === 'game' && x.id === bsId);
    check('room_state nudges the captain to fire', !!bsNudge && typeof bsNudge.turn === 'number', JSON.stringify(bsNudge));
    await req('POST', R2 + '/games/' + bsId + '/moves', { token: TRex, json: { dir: bsFirst === 'Poc' ? 'J10' : 'J8' } });
    const rxSkip = bsFirst === 'Rex' ? 1 : 0;
    r = await req('POST', R2 + '/games/' + bsId + '/moves', { token: TP, json: { dir: 'A1' } });
    check('firing the same cell twice -> 400', r.status === 400, r.status);
    // Play it out: Poc works Rex's fleet down; Rex answers with water.
    const pocShots = ['B1', 'C1', 'D1', 'E1', 'C3', 'C4', 'C5', 'C6', 'E5', 'F5', 'G5', 'G7', 'G8', 'G9', 'I9', 'J9'];
    const rexMisses = ['J8', 'J6', 'J4', 'H10', 'H1', 'F10', 'F8', 'F4', 'F2', 'D8', 'D4', 'B8', 'B6', 'H6', 'H4', 'B4'];
    let sunkSeen = false;
    let finalBs = null;
    for (let i = 0; i < pocShots.length; i++) {
      const mv = await req('POST', R2 + '/games/' + bsId + '/moves', { token: TP, json: { dir: pocShots[i] } });
      if (pocShots[i] === 'E1') {
        const chk = await req('GET', R2 + '/games/' + bsId, { token: TP });
        sunkSeen = (chk.json.game.you.sunk_ships || []).some(s => s.size === 5) && (chk.json.game.players.find(p => p.name === 'Rex') || {}).afloat === 4;
      }
      if (mv.json.game.status === 'finished') { finalBs = mv.json.game; break; }
      await req('POST', R2 + '/games/' + bsId + '/moves', { token: TRex, json: { dir: rexMisses[i + rxSkip] } });
    }
    check('a sunk ship is public and counted', sunkSeen, '');
    check('battleship finishes when the fleet is gone', !!finalBs && finalBs.winner === 'Poc' && (finalBs.players.find(p => p.name === 'Rex') || {}).afloat === 0, JSON.stringify(finalBs).slice(0, 200));
    // The History rebuilds every shot from shots (the whole record) and
    // reads the log, a short tail, for its notes: the log's shot lines
    // must be the record's last shots, in order.
    const bsFired = ((finalBs && finalBs.players) || []).reduce((n, p) => n + p.shots, 0);
    // An agent's read carries the last BS_SHOTS_TAIL shots; log=full, every one.
    check('a battleship read carries the last 24 shots and where they start', !!finalBs && finalBs.shots.length === Math.min(24, bsFired) && finalBs.shots_from === bsFired - finalBs.shots.length, JSON.stringify(finalBs && { n: finalBs.shots.length, from: finalBs.shots_from, fired: bsFired }));
    const fullBs = (await req('GET', R2 + '/games/' + finalBs.id + '?log=full', { token: TP })).json.game;
    const bsShots = (fullBs && fullBs.shots) || [];
    check('battleship shots record every shot, oldest first, with its time', bsShots.length === bsFired && bsFired >= 30 && bsShots.every((s, i) => typeof s.by === 'string' && typeof s.target === 'string' && typeof s.cell === 'string' && (s.result === 'hit' || s.result === 'miss') && typeof s.turn === 'number' && typeof s.at === 'number' && (i === 0 || s.turn >= bsShots[i - 1].turn)) && bsShots.some((s) => s.sunk === 5 && s.by === 'Poc'), bsShots.length + ' of ' + bsFired + ' ' + JSON.stringify(bsShots.slice(0, 2)));
    const shotEntries = ((finalBs && finalBs.log) || []).filter((ln) => ln.by);
    check('battleship log is a short tail whose shot lines are the record\'s last shots', !!finalBs && finalBs.log.length <= 24 && shotEntries.length >= 10 && shotEntries.every((ln, i) => { const s = bsShots[bsShots.length - shotEntries.length + i] || {}; return ln.by === s.by && ln.cell === s.cell && ln.result === s.result && ln.tick === s.turn; }), (finalBs ? finalBs.log.length : 0) + ' lines ' + JSON.stringify(shotEntries.slice(0, 2)));
    r = await req('POST', R2 + '/games/' + bsId + '/moves', { token: TRex, json: { dir: 'A10' } });
    check('shot after the finish -> 409', r.status === 409, r.status);
    r = await req('GET', R2 + '/messages?limit=50', { token: TP });
    check('referee posted the battleship result', (r.json.messages || []).some(x => x.from === 'Referee' && x.text.includes('Battleship match #' + bsId + ' is over') && x.text.includes('Poc takes the sea')), JSON.stringify((r.json.messages || []).filter(x => x.from === 'Referee').map(x => x.text.slice(0, 90))));
    // The turn clock: a captain who never fires loses the turn (and
    // the log says so) - three in a row would forfeit the match.
    r = await req('POST', R2 + '/games', { token: TP, json: { game: 'battleship', from: 'Poc', players: ['Poc', 'Rex'], tick_seconds: 30 } });
    const bsClock = r.json.game.id;
    await req('POST', R2 + '/games/' + bsClock + '/accept', { token: TRex, json: {} });
    await req('POST', R2 + '/games/' + bsClock + '/moves', { token: TP, json: { dir: 'random' } });
    r = await req('POST', R2 + '/games/' + bsClock + '/moves', { token: TRex, json: { dir: 'random' } });
    check('random placements open play', r.status === 200 && r.json.game.phase === 'play' && r.json.game.you.fleet.length === 5, r.status + ' ' + JSON.stringify(r.json.game).slice(0, 160));
    const bsClockFirst = r.json.game.turn_of;
    await expireGame(bsClock);
    r = await req('GET', R2 + '/games/' + bsClock, { token: TP });
    check('an expired turn passes to the rival', r.status === 200 && r.json.game.status === 'running' && r.json.game.turn_of === (bsClockFirst === 'Poc' ? 'Rex' : 'Poc') && (r.json.game.log || []).some(e => e.text.includes('let the turn clock run out')) && (r.json.game.misses || {})[bsClockFirst] === 1, JSON.stringify(r.json.game).slice(0, 240));

    // Variants: skirmish compresses the board and fleet; salvo holds
    // the turn for one shot per afloat ship.
    r = await req('POST', R2 + '/games', { token: TP, json: { game: 'battleship', variant: 'skirmish', from: 'Poc', players: ['Poc', 'Rex'], tick_seconds: 3600 } });
    check('skirmish created 8x8 with the small fleet', r.status === 201 && r.json.game.variant === 'skirmish' && r.json.game.w === 8 && (r.json.game.fleet_sizes || []).join() === '4,3,3,2' && r.json.game.sonar === null, r.status + ' ' + JSON.stringify(r.json.game).slice(0, 200));
    const skId = r.json.game.id;
    await req('POST', R2 + '/games/' + skId + '/accept', { token: TRex, json: {} });
    r = await req('GET', R2 + '/games/' + skId, { token: TP });
    const skHint = ((r.json.game.you || {}).legal_moves || [])[0] || '';
    check('skirmish placement hint is built for the 8x8 fleet', skHint.includes('A1H,A3H,A5H,A7H') && skHint.includes('4,3,3,2') && !skHint.includes('I9'), skHint);
    r = await req('POST', R2 + '/games/' + skId + '/moves', { token: TP, json: { dir: 'A1H,A3H,A5H,A7H' } });
    check('the skirmish hint example itself places cleanly', r.status === 200 && (r.json.game.you.fleet || []).length === 4, r.status + ' ' + JSON.stringify(r.json).slice(0, 140));
    r = await req('POST', R2 + '/games/' + skId + '/moves', { token: TRex, json: { dir: 'random' } });
    check('skirmish fleets carry 4 ships / 12 cells', r.status === 200 && r.json.game.phase === 'play' && r.json.game.you.fleet.length === 4 && r.json.game.you.fleet.reduce((n, s) => n + s.cells.length, 0) === 12, r.status + ' ' + JSON.stringify(r.json.game.you || {}).slice(0, 160));
    r = await req('GET', R2 + '/games/' + skId, { token: TP });
    const skTurnTok = r.json.game.turn_of === 'Poc' ? TP : TRex;
    r = await req('POST', R2 + '/games/' + skId + '/moves', { token: skTurnTok, json: { dir: 'J10' } });
    check('a shot off the skirmish board -> 400', r.status === 400, r.status + ' ' + JSON.stringify(r.json).slice(0, 120));
    r = await req('POST', R2 + '/games/' + skId + '/moves', { token: skTurnTok, json: { dir: 'B2,B3' } });
    check('a comma list in a non-salvo match -> 400', r.status === 400 && String(r.json.error || '').includes('salvo'), r.status + ' ' + JSON.stringify(r.json).slice(0, 140));
    r = await req('POST', R2 + '/games/' + skId + '/cancel', { token: TP, json: {} });
    check('skirmish cancels clean', r.status === 200 && r.json.game.status === 'cancelled', r.status);
    r = await req('POST', R2 + '/games', { token: TP, json: { game: 'battleship', variant: 'salvo', from: 'Poc', players: ['Poc', 'Rex'], tick_seconds: 3600 } });
    check('salvo created with a full first salvo waiting', r.status === 201 && r.json.game.variant === 'salvo' && r.json.game.w === 10, r.status + ' ' + JSON.stringify(r.json.game).slice(0, 160));
    const svId = r.json.game.id;
    await req('POST', R2 + '/games/' + svId + '/accept', { token: TRex, json: {} });
    await req('POST', R2 + '/games/' + svId + '/moves', { token: TP, json: { dir: 'random' } });
    r = await req('POST', R2 + '/games/' + svId + '/moves', { token: TRex, json: { dir: 'random' } });
    check('salvo opens with 5 shots for the first captain', r.status === 200 && r.json.game.phase === 'play' && (r.json.game.turn_of === 'Poc' || r.json.game.turn_of === 'Rex') && r.json.game.salvo_left === 5, r.status + ' ' + JSON.stringify(r.json.game).slice(0, 200));
    const svFirst = r.json.game.turn_of;
    const svFT = svFirst === 'Poc' ? TP : TRex;
    // One call can carry the whole volley: shots after the first do
    // not change the awaited turn, so a wake-driven player would never
    // be re-woken to send them one per call.
    r = await req('POST', R2 + '/games/' + svId + '/moves', { token: svFT, json: { dir: 'A1,B1' } });
    check('a salvo volley fires its whole list in one call', r.status === 200 && r.json.game.turn_of === svFirst && r.json.game.salvo_left === 3 && (r.json.game.you.shots || {}).A1 && (r.json.game.you.shots || {}).B1, r.status + ' ' + JSON.stringify(r.json.game).slice(0, 200));
    r = await req('POST', R2 + '/games/' + svId + '/moves', { token: svFT, json: { dir: 'A2,A3,A4,A5' } });
    check('a volley longer than the shots left -> 400', r.status === 400, r.status + ' ' + JSON.stringify(r.json).slice(0, 140));
    r = await req('GET', R2 + '/games/' + svId, { token: svFT });
    check('a refused volley fires nothing (the list is validated first)', r.status === 200 && !(r.json.game.you.shots || {}).A2 && r.json.game.salvo_left === 3, r.status + ' ' + JSON.stringify(r.json.game).slice(0, 200));
    r = await req('POST', R2 + '/games/' + svId + '/moves', { token: svFT, json: { dir: 'C1' } });
    check('a single salvo shot still holds the turn', r.status === 200 && r.json.game.turn_of === svFirst && r.json.game.salvo_left === 2, r.status + ' ' + JSON.stringify(r.json.game).slice(0, 200));
    r = await req('POST', R2 + '/games/' + svId + '/moves', { token: svFT, json: { dir: 'D1,E1' } });
    check('a closing volley passes the turn with a fresh salvo', r.status === 200 && r.json.game.turn_of !== svFirst && r.json.game.salvo_left >= 3 && r.json.game.salvo_left <= 5, r.status + ' ' + JSON.stringify(r.json.game).slice(0, 200));
    const svShots = (r.json.game && r.json.game.shots) || [];
    check('a salvo turn records each shell in shots', svShots.length === 5 && svShots.every((s) => s.by === svFirst && s.turn === svShots[0].turn) && svShots.map((s) => s.cell).join() === 'A1,B1,C1,D1,E1', JSON.stringify(svShots).slice(0, 200));
    r = await req('POST', R2 + '/games/' + svId + '/cancel', { token: TP, json: {} });
    check('salvo cancels clean', r.status === 200 && r.json.game.status === 'cancelled', r.status);

    // Free-for-all: three captains, per-target shot
    // records, seat-order rotation, elimination, the salvo spread
    // rule. Scripted fleets keep every outcome known in advance:
    // Poc A10-E10 / C5-C8 / E6-G6 / G2-G4 / I2-J2; Rex A1-E1 /
    // C3-C6 / E5-G5 / G7-G9 / I9-J9; Rae B2-B6 / D4-G4 / F6-F8 /
    // H8-J8 / J1-J2.
    const ffaTok = { Poc: TP, Rex: TRex, Rae: TRae };
    const ffaState = async (id) => (await req('GET', R2 + '/games/' + id, { token: TP })).json.game;
    const ffaFire = async (id, dir) => { const g = await ffaState(id); return req('POST', R2 + '/games/' + id + '/moves', { token: ffaTok[g.turn_of], json: { dir } }); };
    // The abandoned table: the late checks at the end run its 30s turns
    // out (expireGame) and verify a fully silent table ends with no
    // winner.
    r = await req('POST', R2 + '/games', { token: TP, json: { game: 'battleship', from: 'Poc', players: ['Poc', 'Rex', 'Rae'], tick_seconds: 30 } });
    const bsFfaAbandon = r.json.game.id;
    await req('POST', R2 + '/games/' + bsFfaAbandon + '/accept', { token: TRex, json: {} });
    await req('POST', R2 + '/games/' + bsFfaAbandon + '/accept', { token: TRae, json: {} });
    await req('POST', R2 + '/games/' + bsFfaAbandon + '/moves', { token: TP, json: { dir: 'random' } });
    await req('POST', R2 + '/games/' + bsFfaAbandon + '/moves', { token: TRex, json: { dir: 'random' } });
    await req('POST', R2 + '/games/' + bsFfaAbandon + '/moves', { token: TRae, json: { dir: 'random' } });
    r = await req('POST', R2 + '/games', { token: TP, json: { game: 'battleship', variant: 'skirmish', from: 'Poc', players: ['Poc', 'Rex', 'Rae'] } });
    check('skirmish with 3 players -> 400 (a free-for-all is classic or salvo)', r.status === 400 && String(r.json.error || '').includes('skirmish'), r.status + ' ' + JSON.stringify(r.json).slice(0, 140));
    r = await req('POST', R2 + '/games', { token: TP, json: { game: 'battleship', from: 'Poc', players: ['Poc', 'Rex', 'Rae'], tick_seconds: 3600 } });
    check('ffa created in its lobby with 3 captains', r.status === 201 && r.json.game.type === 'battleship' && r.json.game.status === 'lobby' && r.json.game.players.length === 3, r.status + ' ' + JSON.stringify(r.json.game).slice(0, 160));
    const ffaId = r.json.game.id;
    await req('POST', R2 + '/games/' + ffaId + '/accept', { token: TRex, json: {} });
    r = await req('POST', R2 + '/games/' + ffaId + '/accept', { token: TRae, json: {} });
    check('ffa starts into placement when every captain accepts', r.status === 200 && r.json.game.status === 'running' && r.json.game.phase === 'setup', r.status + ' ' + JSON.stringify(r.json.game).slice(0, 160));
    await req('POST', R2 + '/games/' + ffaId + '/moves', { token: TP, json: { dir: 'A10H,C5V,E6H,G2V,I2H' } });
    await req('POST', R2 + '/games/' + ffaId + '/moves', { token: TRex, json: { dir: 'A1H,C3V,E5H,G7V,I9H' } });
    r = await req('POST', R2 + '/games/' + ffaId + '/moves', { token: TRae, json: { dir: 'B2V,D4H,F6V,H8H,J1V' } });
    check('ffa play opens when the last fleet lands, first seat is drawn', r.status === 200 && r.json.game.phase === 'play' && ['Poc', 'Rex', 'Rae'].includes(r.json.game.turn_of), r.status + ' ' + JSON.stringify(r.json.game).slice(0, 160));
    // Secrecy holds per board: Rex's view (legal_moves stripped, as
    // in the two-player checks) never carries Poc's un-hit cells.
    r = await req('GET', R2 + '/games/' + ffaId, { token: TRex });
    const ffaRexObj = JSON.parse(JSON.stringify(r.json.game));
    if (ffaRexObj.you) delete ffaRexObj.you.legal_moves;
    check('ffa rival fleets stay secret', r.status === 200 && !JSON.stringify(ffaRexObj).includes('"A10"') && !JSON.stringify(ffaRexObj).includes('"B6"'), JSON.stringify(ffaRexObj).slice(0, 220));
    check('ffa state is per-target (opponent_afloat is null, targets listed)', r.json.game.you.opponent_afloat === null && (r.json.game.you.targets || []).length === 2 && r.json.game.you.targets.every(t => typeof t.afloat === 'number' && t.shots && typeof t.shots === 'object'), JSON.stringify(r.json.game.you || {}).slice(0, 220));
    // Rotation: one scripted miss per captain must cycle the turn
    // in seat order and come back to the starter.
    const rotShots = { Poc: 'Rex:J10', Rex: 'Rae:A10', Rae: 'Poc:J1' };
    const seats = ['Poc', 'Rex', 'Rae'];
    let rotOk = true, rotDetail = '';
    let expectSeat = (await ffaState(ffaId)).turn_of;
    for (let i = 0; i < 3; i++) {
      const g0 = await ffaState(ffaId);
      if (g0.turn_of !== expectSeat) { rotOk = false; rotDetail = 'turn ' + i + ' held by ' + g0.turn_of + ', expected ' + expectSeat; break; }
      const mv = await ffaFire(ffaId, rotShots[g0.turn_of]);
      if (mv.status !== 200) { rotOk = false; rotDetail = 'shot ' + i + ' -> ' + mv.status + ' ' + JSON.stringify(mv.json).slice(0, 120); break; }
      expectSeat = seats[(seats.indexOf(g0.turn_of) + 1) % 3];
      if (mv.json.game.turn_of !== expectSeat) { rotOk = false; rotDetail = 'after ' + g0.turn_of + ' the turn went to ' + mv.json.game.turn_of + ', expected ' + expectSeat; break; }
    }
    check('ffa turns rotate in seat order, shots name their target', rotOk, rotDetail);
    // The drive: Poc hunts Rae's fleet, then Rex's; Rex and Rae
    // answer with water. On Poc's first drive turn, the invalid
    // targets are probed first (none of them may consume the turn).
    const pocCells = ['A10', 'B10', 'C10', 'D10', 'E10', 'C5', 'C6', 'C7', 'C8', 'E6', 'F6', 'G6', 'G2', 'G3', 'G4', 'I2', 'J2'];
    const rexCells = ['A1', 'B1', 'C1', 'D1', 'E1', 'C3', 'C4', 'C5', 'C6', 'E5', 'F5', 'G5', 'G7', 'G8', 'G9', 'I9', 'J9'];
    const waterAt = (fleetCells, n) => { const out = []; for (let row = 1; row <= 10 && out.length < n; row++) for (let col = 0; col < 10 && out.length < n; col++) { const c = String.fromCharCode(65 + col) + row; if (!fleetCells.includes(c)) out.push(c); } return out; };
    const pocHuntRae = ['B2', 'B3', 'B4', 'B5', 'B6', 'D4', 'E4', 'F4', 'G4', 'F6', 'F7', 'F8', 'H8', 'I8', 'J8', 'J1', 'J2'].map(c => 'Rae:' + c);
    const pocHuntRex = rexCells.map(c => 'Rex:' + c);
    const rexWater = waterAt(pocCells, 40).map(c => 'Poc:' + c);
    const raeWater = waterAt(rexCells, 40).map(c => 'Rex:' + c);
    let probesDone = false, probeResults = [], elimSeen = null, wreckStatus = 0, finalFfa = null, driveErr = '';
    for (let step = 0; step < 180 && !finalFfa; step++) {
      const g = await ffaState(ffaId);
      if (g.status === 'finished') { finalFfa = g; break; }
      if (g.status !== 'running' || g.phase !== 'play') { driveErr = 'unexpected state ' + g.status + '/' + g.phase; break; }
      const shooter = g.turn_of;
      if (shooter === 'Poc' && !probesDone) {
        probesDone = true;
        probeResults.push((await ffaFire(ffaId, 'Poc:A1')).status);      // your own waters
        probeResults.push((await ffaFire(ffaId, 'A1')).status);          // no target named
        probeResults.push((await ffaFire(ffaId, 'Nobody:A1')).status);   // not a captain
        probeResults.push((await ffaFire(ffaId, 'Rex:J10')).status);     // already fired at Rex
        probeResults.push((await ffaFire(ffaId, 'Rae:J10')).status);     // same cell, another board: legal
        continue;
      }
      let dir = null;
      if (shooter === 'Poc') dir = pocHuntRae.length ? pocHuntRae.shift() : pocHuntRex.shift();
      else if (shooter === 'Rex') {
        if (elimSeen && !wreckStatus) wreckStatus = (await ffaFire(ffaId, 'Rae:A1')).status;
        dir = rexWater.shift();
      } else if (shooter === 'Rae') dir = raeWater.shift();
      if (!dir) { driveErr = 'shot queue empty for ' + shooter; break; }
      const mv = await ffaFire(ffaId, dir);
      if (mv.status !== 200) { driveErr = shooter + ' ' + dir + ' -> ' + mv.status + ' ' + JSON.stringify(mv.json).slice(0, 140); break; }
      const raeP = (mv.json.game.players || []).find(p => p.name === 'Rae');
      if (!elimSeen && raeP && raeP.eliminated) elimSeen = mv.json.game;
      if (mv.json.game.status === 'finished') finalFfa = mv.json.game;
    }
    check('ffa invalid targets refused; the same cell on another board is a new shot', probesDone && probeResults.join() === '400,400,400,400,200', probeResults.join() + ' ' + driveErr);
    check('ffa elimination lands on the last ship and the sea fights on', !!elimSeen && elimSeen.status === 'running' && (elimSeen.eliminated || []).join() === 'Rae', JSON.stringify(elimSeen && elimSeen.eliminated) + ' ' + driveErr);
    check('firing at an eliminated captain -> 400 (the wreck is not a target)', wreckStatus === 400, String(wreckStatus));
    check('ffa ends with the last fleet floating', !!finalFfa && finalFfa.winner === 'Poc' && (finalFfa.eliminated || []).join() === 'Rae,Rex', JSON.stringify(finalFfa && { w: finalFfa.winner, e: finalFfa.eliminated }) + ' ' + driveErr);
    const ffaShots = ((await req('GET', R2 + '/games/' + finalFfa.id + '?log=full', { token: TP })).json.game.shots) || [];
    const ffaFired = ((finalFfa && finalFfa.players) || []).reduce((n, p) => n + p.shots, 0);
    check('ffa shots record every shot with its target; the log is a short tail', !!finalFfa && ffaShots.length === ffaFired && ffaFired >= 60 && ffaShots.every((s) => ['Poc', 'Rex', 'Rae'].includes(s.target) && s.target !== s.by && typeof s.at === 'number') && finalFfa.log.length <= 24, ffaShots.length + ' of ' + ffaFired + ', log ' + (finalFfa ? finalFfa.log.length : 0));
    r = await req('GET', R2 + '/games/' + ffaId, { token: TRex });
    const rexTargets = (r.json.game.you && r.json.game.you.targets) || [];
    const raeTarget = rexTargets.find(t => t.name === 'Rae');
    check('ffa per-target records survive to the final state', rexTargets.length === 2 && !!raeTarget && raeTarget.eliminated === true && raeTarget.afloat === 0 && (raeTarget.shots || {}).A10 === 'miss', JSON.stringify(rexTargets).slice(0, 220));
    r = await req('GET', R2 + '/messages?limit=50', { token: TP });
    check('referee posted the ffa result with the elimination order', (r.json.messages || []).some(x => x.from === 'Referee' && x.text.includes('Battleship free-for-all #' + ffaId + ' is over') && x.text.includes('Poc takes the sea') && x.text.includes('Elimination order: Rae, Rex')), JSON.stringify((r.json.messages || []).filter(x => x.from === 'Referee').map(x => x.text.slice(0, 110))));
    // Two captains hitting the same cell make one hole in the hull. It
    // used to count twice: the ship "sank" early and every view, a
    // spectator's included, published the cells nobody had hit.
    {
      r = await req('POST', R2 + '/games', { token: TP, json: { game: 'battleship', from: 'Poc', players: ['Poc', 'Rex', 'Rae'], tick_seconds: 3600 } });
      const dupId = r.json.game.id;
      await req('POST', R2 + '/games/' + dupId + '/accept', { token: TRex, json: {} });
      await req('POST', R2 + '/games/' + dupId + '/accept', { token: TRae, json: {} });
      await req('POST', R2 + '/games/' + dupId + '/moves', { token: TP, json: { dir: 'A10H,C5V,E6H,G2V,I2H' } });
      await req('POST', R2 + '/games/' + dupId + '/moves', { token: TRex, json: { dir: 'A1H,C3V,E5H,G7V,I9H' } });
      await req('POST', R2 + '/games/' + dupId + '/moves', { token: TRae, json: { dir: 'B2V,D4H,F6V,H8H,J1V' } });
      // Rex's two-cell ship is I9, J9. Poc and Rae each fire at I9; Rex fires at water.
      const answers = [];
      for (let k = 0; k < 9 && answers.length < 2; k++) {
        const g = await ffaState(dupId);
        const mv = await ffaFire(dupId, g.turn_of === 'Rex' ? 'Poc:J' + (4 + k) : 'Rex:I9');
        if (g.turn_of !== 'Rex') answers.push(mv.json && mv.json.game ? mv.json.game : {});
      }
      const seen = (await req('GET', R2 + '/games/' + dupId, { owner: true })).json.game;
      const rexBoard = (seen.players || []).find((p) => p.name === 'Rex') || {};
      const mine = (await req('GET', R2 + '/games/' + dupId, { token: TRex })).json.game.you.fleet.find((sh) => sh.size === 2);
      check('ffa: the same cell hit by two captains is one hole, not a sinking', answers.length === 2 && rexBoard.afloat === 5 && !JSON.stringify(seen).includes('"J9"') && mine.sunk === false && mine.hits.join() === 'I9',
        JSON.stringify({ afloat: rexBoard.afloat, mine, leak: JSON.stringify(seen).includes('"J9"') }).slice(0, 200));
      // ...and the ship does sink, once, when its last cell is hit
      let sunkBy = null;
      for (let k = 0; k < 9 && !sunkBy; k++) {
        const g = await ffaState(dupId);
        const mv = await ffaFire(dupId, g.turn_of === 'Rex' ? 'Poc:A' + (1 + k) : 'Rex:J9');
        if (g.turn_of !== 'Rex' && mv.status === 200) sunkBy = g.turn_of;
      }
      const after = (await req('GET', R2 + '/games/' + dupId, { owner: true })).json.game;
      const rexAfter = (after.players || []).find((p) => p.name === 'Rex') || {};
      check('ffa: it sinks when its last cell is hit', !!sunkBy && rexAfter.afloat === 4, JSON.stringify({ sunkBy, afloat: rexAfter.afloat }));
      await req('POST', R2 + '/games/' + dupId + '/cancel', { token: TP, json: {} });
    }
    // FFA salvo: the spread rule. A volley dumped on one board is
    // refused whole; the same shells spread across both rivals
    // resolve.
    r = await req('POST', R2 + '/games', { token: TP, json: { game: 'battleship', variant: 'salvo', from: 'Poc', players: ['Poc', 'Rex', 'Rae'], tick_seconds: 3600 } });
    check('ffa salvo created', r.status === 201 && r.json.game.variant === 'salvo' && r.json.game.players.length === 3, r.status + ' ' + JSON.stringify(r.json.game).slice(0, 160));
    const ffaSv = r.json.game.id;
    await req('POST', R2 + '/games/' + ffaSv + '/accept', { token: TRex, json: {} });
    await req('POST', R2 + '/games/' + ffaSv + '/accept', { token: TRae, json: {} });
    await req('POST', R2 + '/games/' + ffaSv + '/moves', { token: TP, json: { dir: 'random' } });
    await req('POST', R2 + '/games/' + ffaSv + '/moves', { token: TRex, json: { dir: 'random' } });
    await req('POST', R2 + '/games/' + ffaSv + '/moves', { token: TRae, json: { dir: 'random' } });
    const svG = await ffaState(ffaSv);
    const svShooter = svG.turn_of;
    const svRivals = seats.filter(n => n !== svShooter);
    check('ffa salvo opens with a full salvo', svG.phase === 'play' && svG.salvo_left === 5, JSON.stringify(svG).slice(0, 160));
    const conc = [1, 2, 3, 4, 5].map(i => svRivals[0] + ':A' + i).join(',');
    r = await req('POST', R2 + '/games/' + ffaSv + '/moves', { token: ffaTok[svShooter], json: { dir: conc } });
    check('ffa salvo: a concentrated volley is refused (spread rule)', r.status === 400 && String(r.json.error || '').includes('spread'), r.status + ' ' + JSON.stringify(r.json).slice(0, 160));
    r = await req('GET', R2 + '/games/' + ffaSv, { token: ffaTok[svShooter] });
    check('ffa salvo: the refused volley fired nothing', r.status === 200 && r.json.game.salvo_left === 5 && (r.json.game.you.targets || []).every(t => !Object.keys(t.shots || {}).length), r.status + ' ' + JSON.stringify(r.json.game.you || {}).slice(0, 200));
    // The rule spans the turn, not one call: shells sent one per call
    // must still spread.
    r = await req('POST', R2 + '/games/' + ffaSv + '/moves', { token: ffaTok[svShooter], json: { dir: svRivals[0] + ':A1' } });
    check('ffa salvo: a single first shell is fine', r.status === 200 && r.json.game.salvo_left === 4, r.status + ' ' + JSON.stringify(r.json).slice(0, 160));
    r = await req('POST', R2 + '/games/' + ffaSv + '/moves', { token: ffaTok[svShooter], json: { dir: svRivals[0] + ':A2' } });
    check('ffa salvo: a second call at the same board before the other rival -> 400', r.status === 400 && String(r.json.error || '').includes('spread'), r.status + ' ' + JSON.stringify(r.json).slice(0, 160));
    r = await req('POST', R2 + '/games/' + ffaSv + '/moves', { token: ffaTok[svShooter], json: { dir: 'fire: ' + svRivals[1] + ':A1' } });
    check('ffa salvo: the other rival next is fine', r.status === 200 && r.json.game.salvo_left === 3, r.status + ' ' + JSON.stringify(r.json).slice(0, 160));
    const spread = [svRivals[0] + ':A2', svRivals[0] + ':A3', svRivals[1] + ':A2'].join(',');
    r = await req('POST', R2 + '/games/' + ffaSv + '/moves', { token: ffaTok[svShooter], json: { dir: spread } });
    const svT = (r.json.game && r.json.game.you && r.json.game.you.targets) || [];
    const ffaSvShots = (r.json.game && r.json.game.shots) || [];
    check('ffa salvo: shots records the turn\'s five shells with their targets', ffaSvShots.length === 5 && ffaSvShots.filter((s) => s.target === svRivals[0]).length === 3 && ffaSvShots.filter((s) => s.target === svRivals[1]).length === 2 && ffaSvShots.every((s) => s.by === svShooter), JSON.stringify(ffaSvShots).slice(0, 220));
    check('ffa salvo: a spread volley resolves across both targets', r.status === 200 && r.json.game.turn_of !== svShooter && Object.keys((svT.find(t => t.name === svRivals[0]) || {}).shots || {}).length === 3 && Object.keys((svT.find(t => t.name === svRivals[1]) || {}).shots || {}).length === 2, r.status + ' ' + JSON.stringify(r.json).slice(0, 220));
    r = await req('POST', R2 + '/games/' + ffaSv + '/cancel', { token: TP, json: {} });
    check('ffa salvo cancels clean', r.status === 200 && r.json.game.status === 'cancelled', r.status);

    // Game engines: "game" names an engine. An unknown name is refused
    // with the list, not silently made Light Cycles; spacing and case
    // variants of a real one work.
    r = await req('POST', R2 + '/games', { token: TP, json: { game: 'chess', from: 'Poc', players: ['Poc', 'Rex'] } });
    check('unknown game -> 400 naming the games', r.status === 400 && /lightcycles, duel, battleship/.test(String(r.json && r.json.error)), r.status + ' ' + r.text.slice(0, 120));
    r = await req('POST', R2 + '/games', { token: TP, json: { game: 'Light Cycles', from: 'Poc', players: ['Poc', 'Rex'] } });
    check('"Light Cycles" spelled out still creates Light Cycles', r.status === 201 && r.json.game.type === 'lightcycles', r.status + ' ' + r.text.slice(0, 120));
    if (r.json && r.json.game) await req('POST', R2 + '/games/' + r.json.game.id + '/cancel', { token: TP, json: {} });

    // Frontlines: 100 troops over 5 hills, secret splits,
    // hill by hill to the bigger army, the round to more hills held.
    // Earlier sections leave live matches behind, and awaiting_you shows
    // at most 3 items: clear them so a nudge check sees its own match.
    // The two abandoned Battleship tables stay - the late checks wait on
    // them - so a player can still owe up to 2 turns there. A cancel
    // needs a from even for the owner: without one it is a 400, and this
    // sweep would do nothing and leave the column check flaky.
    const clearLive = async (label) => {
      const gl = await req('GET', R2 + '/games', { owner: true });
      const bad = [];
      for (const x of (gl.json.games || []).filter((y) => (y.status === 'lobby' || y.status === 'running') && y.id !== bsAbandon && y.id !== bsFfaAbandon)) {
        const c = await req('POST', R2 + '/games/' + x.id + '/cancel', { owner: true, json: { from: 'Owner' } });
        if (c.status !== 200) bad.push(x.id + ':' + c.status);
      }
      check(label + ': leftover matches cancelled', bad.length === 0, bad.join(' '));
    };
    await clearLive('before frontlines');
    r = await req('POST', R2 + '/games', { token: TP, json: { game: 'frontlines', from: 'Poc', players: ['Poc', 'Rex', 'Rae'] } });
    check('frontlines needs exactly 2 -> 400', r.status === 400, r.status);
    r = await req('POST', R2 + '/games', { token: TP, json: { game: 'frontlines', from: 'Poc', players: ['Poc', 'Rex'], best_of: 3, tick_seconds: 3600 } });
    check('frontlines created in a lobby', r.status === 201 && r.json.game.type === 'frontlines' && r.json.game.status === 'lobby' && r.json.game.target === 2 && r.json.game.hills === 5 && r.json.game.troops === 100 && r.json.game.values === null, r.status + ' ' + r.text.slice(0, 160));
    const flId = r.json.game.id;
    r = await req('POST', R2 + '/games/' + flId + '/accept', { token: TRex, json: {} });
    check('frontlines starts when both accept', r.status === 200 && r.json.game.status === 'running' && r.json.game.round === 1, r.status);
    r = await req('POST', R2 + '/games/' + flId + '/moves', { token: TP, json: { dir: '50,50,10,0,0' } });
    check('a split over 100 -> 400 naming the sum', r.status === 400 && /add up to exactly 100/.test(r.json.error) && /110/.test(r.json.error) && Array.isArray(r.json.legal_moves), r.status + ' ' + r.text.slice(0, 120));
    r = await req('POST', R2 + '/games/' + flId + '/moves', { token: TP, json: { dir: '25,25,50' } });
    check('three numbers -> 400', r.status === 400 && /5 numbers/.test(r.json.error), r.status + ' ' + r.text.slice(0, 120));
    r = await req('POST', R2 + '/games/' + flId + '/moves', { token: TP, json: { dir: '40,30,30,0,0' } });
    check('a split commits without resolving', r.status === 200 && r.json.resolved === false && JSON.stringify(r.json.game.you.queued) === '[40,30,30,0,0]', r.status + ' ' + r.text.slice(0, 160));
    r = await req('GET', R2 + '/games/' + flId, { token: TRex });
    check('the split stays secret from the rival', (r.json.game.players.find((p) => p.name === 'Poc') || {}).committed === true && r.json.game.you.queued === null && !JSON.stringify(r.json.game).includes('40,30,30') && !JSON.stringify(r.json.game.rounds).includes('40'), JSON.stringify(r.json.game).slice(0, 200));
    r = await req('GET', R2 + '/messages?limit=5', { token: TRex });
    check('room_state asks the rival for a split', ((r.json.room_state || {}).awaiting_you || []).some((a) => a.type === 'game' && a.id === flId && a.turn === 1 && /100/.test(a.call.body.dir)), 'flId ' + flId + ': ' + JSON.stringify(((r.json.room_state || {}).awaiting_you || []).map((a) => a.type + ':' + a.id + ':' + a.turn + ':' + ((a.call || {}).body || {}).dir)) + ' more ' + JSON.stringify(Object.keys(r.json.room_state || {})));
    // Poc 40/30/30/0/0 vs Rex 20/20/20/20/20: Poc takes A, B, C (3 hills) - Poc's round
    r = await req('POST', R2 + '/games/' + flId + '/moves', { token: TRex, json: { dir: 'even' } });
    const fr1 = (r.json.game.rounds || [])[0] || {};
    check('the round resolves hill by hill', r.status === 200 && r.json.resolved === true && fr1.winner === 'Poc' && JSON.stringify(fr1.hills) === '["Poc","Poc","Poc","Rex","Rex"]' && fr1.held.Poc === 3 && fr1.held.Rex === 2 && r.json.game.score.Poc === 1, JSON.stringify(fr1));
    check('both splits are public once resolved', JSON.stringify(fr1.alloc.Rex) === '[20,20,20,20,20]' && JSON.stringify(fr1.alloc.Poc) === '[40,30,30,0,0]');
    // a level round: identical splits take nothing
    await req('POST', R2 + '/games/' + flId + '/moves', { token: TP, json: { dir: 'even' } });
    r = await req('POST', R2 + '/games/' + flId + '/moves', { token: TRex, json: { dir: '20 20 20 20 20' } });
    check('a level round scores nobody', r.status === 200 && (r.json.game.rounds[1] || {}).winner === null && r.json.game.round === 3 && r.json.game.score.Poc === 1, JSON.stringify(r.json.game.rounds[1] || {}));
    await req('POST', R2 + '/games/' + flId + '/moves', { token: TP, json: { dir: '0,0,34,33,33' } });
    r = await req('POST', R2 + '/games/' + flId + '/moves', { token: TRex, json: { dir: '30,30,30,10,0' } });
    check('frontlines finishes at the target', r.status === 200 && r.json.game.status === 'finished' && r.json.game.winner === 'Poc', JSON.stringify(r.json.game).slice(0, 200));
    r = await req('GET', R2 + '/messages?limit=20', { token: TP });
    check('the Referee posts the Frontlines result', (r.json.messages || []).some((x) => x.from === 'Referee' && x.text.includes('Frontlines match #' + flId + ' is over') && x.text.includes('Poc takes the field 2-0')), JSON.stringify((r.json.messages || []).filter((x) => x.from === 'Referee').map((x) => x.text.slice(0, 90))));
    r = await req('GET', R2 + '/games', { token: TP });
    check('standings count Frontlines', !!(r.json.record || {}).frontlines && r.json.record.frontlines.some((row) => row.name === 'Poc' && row.w >= 1), JSON.stringify((r.json.record || {}).frontlines || null));
    // valued hills: public values each round, the round to more points
    r = await req('POST', R2 + '/games', { token: TP, json: { game: 'frontlines', variant: 'valued', from: 'Poc', players: ['Poc', 'Rex'], best_of: 1, tick_seconds: 3600 } });
    const flv = r.json.game;
    check('valued hills: five public values, 1,1,2,2,3 shuffled', r.status === 201 && flv.variant === 'valued' && Array.isArray(flv.values) && flv.values.slice().sort().join(',') === '1,1,2,2,3', JSON.stringify(flv.values));
    await req('POST', R2 + '/games/' + flv.id + '/accept', { token: TRex, json: {} });
    // Poc stacks the 3-point hill, Rex takes the other four: Rex holds more hills, but is it more points?
    const three = flv.values.indexOf(3);
    const pocSplit = [0, 0, 0, 0, 0]; pocSplit[three] = 100;
    const rexSplit = [25, 25, 25, 25, 25]; rexSplit[three] = 0;
    await req('POST', R2 + '/games/' + flv.id + '/moves', { token: TP, json: { dir: pocSplit.join(',') } });
    r = await req('POST', R2 + '/games/' + flv.id + '/moves', { token: TRex, json: { dir: rexSplit.join(',') } });
    const vr = (r.json.game.rounds || [])[0] || {};
    check('valued hills: the round goes to more points, not more hills', vr.held.Rex === 4 && vr.points.Poc === 3 && vr.points.Rex === 6 && vr.winner === 'Rex' && r.json.game.status === 'finished', JSON.stringify(vr));

    // Code Race: everyone cracks the same secret; one secret
    // guess a round; a rival's guess shows only as feedback until the
    // race ends; places by the round you cracked it. The suite sets the
    // secret through a TEST_HOOKS-only hook so a race can be solved.
    const roomOf2 = R2.slice('/api/rooms/'.length);
    const crSecret = (id, secret) => req('POST', '/api/test-hooks/coderace-secret', { owner: true, json: { room: roomOf2, id, secret } });
    r = await req('POST', R2 + '/games', { token: TP, json: { game: 'coderace', from: 'Poc', players: ['Poc'] } });
    check('code race needs 2 to 6 -> 400', r.status === 400 && /2 to 6/.test(r.json.error), r.status + ' ' + r.text.slice(0, 120));
    r = await req('POST', R2 + '/games', { token: TP, json: { game: 'coderace', mode: 'chess', from: 'Poc', players: ['Poc', 'Rex'] } });
    check('code race mode must be colors or words -> 400', r.status === 400 && /colors or words/.test(r.json.error), r.status + ' ' + r.text.slice(0, 120));
    r = await req('POST', R2 + '/games', { token: TP, json: { game: 'Code Race', from: 'Poc', players: ['Poc', 'Rex', 'Rae'], max_rounds: 6, tick_seconds: 3600 } });
    const cr0 = r.json.game || {};
    check('code race created in a lobby, colors by default', r.status === 201 && cr0.type === 'coderace' && cr0.status === 'lobby' && cr0.mode === 'colors' && cr0.length === 4 && cr0.colors === 6 && (cr0.palette || []).length === 6 && cr0.max_rounds === 6 && cr0.secret === null, r.status + ' ' + r.text.slice(0, 200));
    const crId = cr0.id;
    await req('POST', R2 + '/games/' + crId + '/accept', { token: TRex, json: {} });
    r = await req('POST', R2 + '/games/' + crId + '/accept', { token: TRae, json: {} });
    check('code race starts when everyone accepts', r.status === 200 && r.json.game.status === 'running' && r.json.game.round === 1, r.status);
    r = await crSecret(crId, 'RGBY');
    check('the suite hook sets the secret', r.status === 200 && r.json.ok === true, r.status + ' ' + r.text.slice(0, 120));
    r = await req('GET', R2 + '/messages?limit=5', { token: TRae });
    check('room_state asks each racer for a guess', ((r.json.room_state || {}).awaiting_you || []).some((a) => a.type === 'game' && a.id === crId && /colours/.test(a.call.body.dir)), JSON.stringify(((r.json.room_state || {}).awaiting_you || []).map((a) => a.type + ':' + a.id + ':' + ((a.call || {}).body || {}).dir)));
    r = await req('POST', R2 + '/games/' + crId + '/moves', { token: TP, json: { dir: 'R G B M' } });
    check('a colour not in the race -> 400 naming the palette', r.status === 400 && /not a colour/.test(r.json.error) && /P \(purple\)/.test(r.json.error), r.status + ' ' + r.text.slice(0, 160));
    r = await req('POST', R2 + '/games/' + crId + '/moves', { token: TP, json: { dir: 'R G B' } });
    check('three pegs in a 4-peg race -> 400', r.status === 400 && /4 colours/.test(r.json.error), r.status + ' ' + r.text.slice(0, 160));
    r = await req('POST', R2 + '/games/' + crId + '/moves', { token: TP, json: { dir: 'red green blue orange' } });
    check('a guess commits without resolving', r.status === 200 && r.json.resolved === false && r.json.game.you.queued === 'RGBO', r.status + ' ' + r.text.slice(0, 160));
    r = await req('GET', R2 + '/games/' + crId, { token: TRex });
    check('the guess stays secret from rivals', (r.json.game.players.find((p) => p.name === 'Poc') || {}).committed === true && !JSON.stringify(r.json.game).includes('RGBO') && r.json.game.secret === null, JSON.stringify(r.json.game).slice(0, 200));
    await req('POST', R2 + '/games/' + crId + '/moves', { token: TRae, json: { dir: 'RRRR' } });
    r = await req('POST', R2 + '/games/' + crId + '/moves', { token: TRex, json: { dir: 'rgby' } });
    const crR1 = (r.json.game.rounds || [])[0] || { guesses: {} };
    check('round 1 resolves once all three guessed', r.status === 200 && r.json.resolved === true && r.json.game.round === 2 && r.json.game.status === 'running', r.status + ' ' + JSON.stringify(r.json.game).slice(0, 200));
    check('black and white pegs: RGBY cracks it, RGBO scores 3 black, RRRR 1 black', JSON.stringify(crR1.guesses.Rex.fb) === '[4,0]' && JSON.stringify(crR1.guesses.Poc.fb) === '[3,0]' && JSON.stringify(crR1.guesses.Rae.fb) === '[1,0]' && JSON.stringify(crR1.solved) === '["Rex"]', JSON.stringify(crR1));
    check('your own guess is yours to see; a rival\'s shows only feedback', crR1.guesses.Rex.guess === 'RGBY' && crR1.guesses.Poc.guess === undefined && crR1.guesses.Rae.guess === undefined && !JSON.stringify(r.json.game).includes('RGBO'), JSON.stringify(crR1));
    r = await req('POST', R2 + '/games/' + crId + '/moves', { token: TRex, json: { dir: 'RGBY' } });
    check('a racer who cracked it is done -> 400', r.status === 400 && /cracked it in round 1/.test(r.json.error), r.status + ' ' + r.text.slice(0, 120));
    // Round 2 waits on the two still racing. Poc cracks it; Rae is then
    // the only racer left with a winner decided, so her place is settled
    // and the race ends
    r = await req('POST', R2 + '/games/' + crId + '/moves', { token: TRae, json: { dir: 'Y Y Y Y' } });
    check('round 2 waits on the racers still racing', r.status === 200 && r.json.resolved === false && JSON.stringify(r.json.game.awaiting) === '["Poc"]', r.status + ' ' + JSON.stringify(r.json.game && r.json.game.awaiting));
    r = await req('POST', R2 + '/games/' + crId + '/moves', { token: TP, json: { dir: 'R G B Y' } });
    check('the race ends when the last racer\'s place is settled', r.status === 200 && r.json.game.status === 'finished' && r.json.game.winner === 'Rex' && JSON.stringify(r.json.game.places) === '["Rex","Poc","Rae"]', JSON.stringify(r.json.game).slice(0, 240));
    check('the end reveals the secret and every guess', JSON.stringify(r.json.game.secret) === '["R","G","B","Y"]' && r.json.game.rounds[0].guesses.Rae.guess === 'RRRR' && r.json.game.rounds[0].guesses.Rex.guess === 'RGBY', JSON.stringify(r.json.game.rounds[0]));
    r = await req('GET', R2 + '/messages?limit=20', { token: TP });
    check('the Referee posts the Code Race result', (r.json.messages || []).some((x) => x.from === 'Referee' && x.text.includes('Code Race match #' + crId + ' is over - Rex cracked the code first, in round 1') && x.text.includes('2. Poc (round 2)') && x.text.includes('The code was R G B Y')), JSON.stringify((r.json.messages || []).filter((x) => x.from === 'Referee').map((x) => x.text.slice(0, 120))));
    r = await req('GET', R2 + '/games', { token: TP });
    const crRec = (r.json.record || {}).coderace || [];
    check('standings count Code Race places', crRec.some((row) => row.name === 'Rex' && row.w >= 1) && crRec.some((row) => row.name === 'Poc' && row.p2 >= 1 && row.l >= 1) && crRec.some((row) => row.name === 'Rae' && row.p3 >= 1), JSON.stringify(crRec));
    // Words: listed words only, per-letter feedback with the classic
    // repeated-letter rule (secret apple, guess paper -> Y Y G Y .)
    r = await req('POST', R2 + '/games', { token: TP, json: { game: 'coderace', mode: 'words', from: 'Poc', players: ['Poc', 'Rex'], tick_seconds: 3600 } });
    const crw = r.json.game || {};
    check('words mode: a 5-letter word, 6 rounds by default', r.status === 201 && crw.mode === 'words' && crw.length === 5 && crw.max_rounds === 6 && crw.colors === null && crw.palette === null, r.status + ' ' + r.text.slice(0, 200));
    await req('POST', R2 + '/games/' + crw.id + '/accept', { token: TRex, json: {} });
    await crSecret(crw.id, 'apple');
    r = await req('POST', R2 + '/games/' + crw.id + '/moves', { token: TP, json: { dir: 'xqzzt' } });
    check('a word not in the list -> 400', r.status === 400 && /not in the word list/.test(r.json.error), r.status + ' ' + r.text.slice(0, 120));
    r = await req('POST', R2 + '/games/' + crw.id + '/moves', { token: TP, json: { dir: 'carts' } });
    r = await req('POST', R2 + '/games/' + crw.id + '/moves', { token: TP, json: { dir: 'PAPER' } });
    check('a guess can be changed until the round resolves', r.status === 200 && r.json.game.you.queued === 'paper', r.status + ' ' + r.text.slice(0, 120));
    r = await req('POST', R2 + '/games/' + crw.id + '/moves', { token: TRex, json: { dir: 'apple' } });
    const wr1 = ((r.json.game || {}).rounds || [])[0] || { guesses: {} };
    check('words feedback: paper vs apple is YYGY.', wr1.guesses.Rex && wr1.guesses.Rex.fb === 'GGGGG' && r.json.game.status === 'finished' && r.json.game.winner === 'Rex' && (r.json.game.rounds[0].guesses.Poc || {}).fb === 'YYGY.' && r.json.game.secret === 'apple', JSON.stringify(r.json.game).slice(0, 260));

    // how_to_play: every full state carries the match's rules
    // with its own settings, so an agent never needs the rulebook.
    const rulesOf = async (id) => ((await req('GET', R2 + '/games/' + id, { token: TP })).json.game || {}).how_to_play || '';
    let hp = await rulesOf(crw.id);
    check('how_to_play: Code Race words names the length and the tile scoring', /Code Race \(Words\)/.test(hp) && /5-letter word/.test(hp) && /G \(right letter, right place\)/.test(hp) && /e\.g\. crane/.test(hp), hp.slice(0, 200));
    hp = await rulesOf(crId);
    check('how_to_play: Code Race colors names the palette and the pegs', /4 pegs from 6 colours/.test(hp) && /R red/.test(hp) && /black pegs/.test(hp) && /up to 6\)/.test(hp), hp.slice(0, 200));
    hp = await rulesOf(flv.id);
    check('how_to_play: Frontlines valued names the hill values', /100 troops/.test(hp) && /more hill points/.test(hp) && /best of 1/.test(hp), hp.slice(0, 200));
    const extra = [];
    for (const body of [{ game: 'duel', best_of: 3 }, { mode: 'async' }, { game: 'battleship', variant: 'salvo' }]) {
      r = await req('POST', R2 + '/games', { token: TP, json: Object.assign({ from: 'Poc', players: ['Poc', 'Rex'] }, body) });
      if (r.json && r.json.game) extra.push(r.json.game.id);
    }
    const [dRules, lRules, bRules] = await Promise.all(extra.map(rulesOf));
    check('how_to_play: a duel names its target and the throws', /first to 2 round wins/i.test(dRules) && /rock, paper or scissors/.test(dRules), dRules.slice(0, 160));
    check('how_to_play: async Light Cycles says ticks resolve on everyone\'s move', /every living rider has moved/.test(lRules) && /up, down, left or right/.test(lRules), lRules.slice(0, 160));
    check('how_to_play: salvo Battleship explains the volley and placement', /Salvo/.test(bRules) && /A1H,C3V,E5H,G7V,I9H/.test(bRules), bRules.slice(0, 200));
    r = await mcp(R2, 'tools/call', { name: 'get_game', arguments: { id: extra[0] } }, { token: TP });
    const mcpHowGame = r.json && r.json.result && r.json.result.structuredContent && r.json.result.structuredContent.game;
    check('MCP get_game carries how_to_play', !!mcpHowGame && /rock-paper-scissors/.test(mcpHowGame.how_to_play || ''), JSON.stringify(r.json).slice(0, 200));
    for (const id of extra) await req('POST', R2 + '/games/' + id + '/cancel', { token: TP, json: {} });
    await clearLive('before four in a row');

    // Four in a Row: turns on the turn-order helper, a 7x6
    // board, four in a line wins; who moves first is drawn at creation.
    const tokOf = { Poc: TP, Rex: TRex };
    r = await req('POST', R2 + '/games', { token: TP, json: { game: 'fourinarow', from: 'Poc', players: ['Poc', 'Rex', 'Rae'] } });
    check('four in a row needs exactly 2 -> 400', r.status === 400 && /exactly 2/.test(r.json.error), r.status);
    r = await req('POST', R2 + '/games', { token: TP, json: { game: 'Connect Four', from: 'Poc', players: ['Poc', 'Rex'] } });
    const c4 = r.json.game || {};
    check('four in a row created in a lobby (the Connect Four alias works)', r.status === 201 && c4.type === 'fourinarow' && c4.status === 'lobby' && c4.board.length === 6 && c4.board.every((row) => row === '.......') && ['Poc', 'Rex'].includes(c4.first) && c4.turn_seconds === 3600 && c4.turn_of === null, r.status + ' ' + r.text.slice(0, 200));
    const F = c4.first, S = F === 'Poc' ? 'Rex' : 'Poc';
    r = await req('POST', R2 + '/games/' + c4.id + '/accept', { token: TRex, json: {} });
    check('four in a row starts with the first mover to play', r.status === 200 && r.json.game.status === 'running' && r.json.game.turn_of === F, JSON.stringify(r.json.game).slice(0, 160));
    check('how_to_play: four in a row names who moves first', /moves first and plays X/.test(r.json.game.how_to_play || '') && /1 to 7 from the left/.test(r.json.game.how_to_play || ''), String(r.json.game.how_to_play).slice(0, 160));
    r = await req('GET', R2 + '/messages?limit=5', { token: tokOf[F] });
    const c4Call = ((r.json.room_state || {}).awaiting_you || []).find((a) => a.type === 'game' && a.id === c4.id);
    check('room_state asks the first mover for a column', ((r.json.room_state || {}).awaiting_you || []).some((a) => a.type === 'game' && a.id === c4.id && /column/.test(a.call.body.dir)), JSON.stringify(((r.json.room_state || {}).awaiting_you || []).map((a) => a.id + ':' + ((a.call || {}).body || {}).dir)) + ' more ' + (r.json.room_state || {}).awaiting_you_more);
    r = await req('POST', R2 + '/games/' + c4.id + '/moves', { token: tokOf[S], json: { dir: '4' } });
    check('moving out of turn -> 409', r.status === 409 && new RegExp("It's " + F + "'s turn").test(r.json.error), r.status + ' ' + r.text.slice(0, 120));
    r = await req('POST', R2 + '/games/' + c4.id + '/moves', { token: tokOf[F], json: { dir: '8' } });
    check('column 8 -> 400 with the open columns', r.status === 400 && (r.json.legal_moves || []).join() === '1,2,3,4,5,6,7', r.status + ' ' + r.text.slice(0, 120));
    r = await req('POST', R2 + '/games/' + c4.id + '/moves', { token: tokOf[F], json: { dir: '4' } });
    check('a disc falls to the bottom and the turn passes', r.status === 200 && r.json.game.board[5] === '...X...' && r.json.game.turn_of === S && r.json.game.turn === 2 && JSON.stringify(r.json.game.last_move && [r.json.game.last_move.col, r.json.game.last_move.row]) === '[4,1]', JSON.stringify(r.json.game).slice(0, 220));
    // A move names its turn: the copy of F's drop re-sent after S answered
    // used to land as F's next disc in column 4.
    check('room_state hands the first mover a call that names the turn', ((r0) => !!r0 && r0.turn === 1 && r0.call.body.turn === 1)(c4Call), JSON.stringify(c4Call));
    r = await req('POST', R2 + '/games/' + c4.id + '/moves', { token: tokOf[S], json: { dir: '2', turn: 2 } });
    check('a move naming the current turn is played', r.status === 200 && r.json.game.turn === 3, r.status + ' ' + r.text.slice(0, 120));
    r = await req('POST', R2 + '/games/' + c4.id + '/moves', { token: tokOf[F], json: { dir: '4', turn: 1 } });
    check('a re-sent move from a past turn -> 409 with the turn and state now', r.status === 409 && /moved on/.test(r.json.error) && r.json.turn === 3 && r.json.game && r.json.game.turn === 3 && r.json.game.board[4] === '.......', r.status + ' ' + r.text.slice(0, 200));
    r = await mcp(R2, 'tools/call', { name: 'submit_move', arguments: { id: c4.id, dir: '4', turn: 1 } }, { token: tokOf[F] });
    check('mcp submit_move with a past turn is refused', !!(r.json && r.json.result && r.json.result.isError === true && /moved on/.test(JSON.stringify(r.json.result))), JSON.stringify(r.json).slice(0, 200));
    // F builds column 1 to four; S stacks column 2 to three, then goes wide
    for (const [who, col] of [[F, 1], [S, 2], [F, 1], [S, 2], [F, 1], [S, 7]]) await req('POST', R2 + '/games/' + c4.id + '/moves', { token: tokOf[who], json: { dir: String(col) } });
    r = await req('POST', R2 + '/games/' + c4.id + '/moves', { token: tokOf[F], json: { dir: 'column 1' } });
    check('four up a column wins', r.status === 200 && r.json.game.status === 'finished' && r.json.game.winner === F && JSON.stringify(r.json.game.line) === '[[1,1],[1,2],[1,3],[1,4]]' && r.json.game.moves.length === 9, JSON.stringify(r.json.game).slice(0, 240));
    r = await req('GET', R2 + '/messages?limit=20', { token: TP });
    check('the Referee posts the Four in a Row result', (r.json.messages || []).some((x) => x.from === 'Referee' && x.text.includes('Four in a Row match #' + c4.id + ' is over - ' + F + ' connects four up a column on move 9')), JSON.stringify((r.json.messages || []).filter((x) => x.from === 'Referee').map((x) => x.text.slice(0, 100)).slice(-3)));
    // a full column refuses the disc
    r = await req('POST', R2 + '/games', { token: TP, json: { game: 'fourinarow', from: 'Poc', players: ['Poc', 'Rex'] } });
    const c4b = r.json.game || {};
    await req('POST', R2 + '/games/' + c4b.id + '/accept', { token: TRex, json: {} });
    const F2 = c4b.first, S2 = F2 === 'Poc' ? 'Rex' : 'Poc';
    for (let k = 0; k < 6; k++) await req('POST', R2 + '/games/' + c4b.id + '/moves', { token: tokOf[k % 2 ? S2 : F2], json: { dir: '3' } });
    r = await req('POST', R2 + '/games/' + c4b.id + '/moves', { token: tokOf[F2], json: { dir: '3' } });
    check('a full column -> 400 without it in legal_moves', r.status === 400 && /Column 3 is full/.test(r.json.error) && (r.json.legal_moves || []).join() === '1,2,4,5,6,7', r.status + ' ' + r.text.slice(0, 140));
    await req('POST', R2 + '/games/' + c4b.id + '/cancel', { token: TP, json: {} });
    // the ladder: an Elo rating per game over 2-player matches
    r = await req('GET', R2 + '/games', { token: TP });
    const lad = (r.json.ladder || {}).fourinarow || [];
    const lw = lad.find((x) => x.name === F) || {}, ll = lad.find((x) => x.name === S) || {};
    check('the ladder rates the Four in a Row win: 1016 vs 984', lw.rating === 1016 && lw.w === 1 && lw.last === 16 && ll.rating === 984 && ll.l === 1 && ll.last === -16 && lad[0].name === F, JSON.stringify(lad));
    // Trust: pairwise C/D, payoffs 3/5/0/1, a hidden last round.
    const tokT = { Poc: TP, Rex: TRex, Rae: TRae };
    let rt = await req('POST', R2 + '/games', { token: TP, json: { game: 'trust', from: 'Poc', players: ['Poc'] } });
    check('trust needs 2 to 8 -> 400', rt.status === 400 && /2 to 8/.test(rt.json.error), rt.status);
    rt = await req('POST', R2 + '/games', { token: TP, json: { game: 'trust', from: 'Poc', players: ['Poc', 'Rex', 'Rae'], rounds: 4, tick_seconds: 3600 } });
    const tr0 = rt.json.game || {};
    check('trust created in a lobby, the last round hidden', rt.status === 201 && tr0.type === 'trust' && tr0.status === 'lobby' && tr0.rounds_about === 4 && tr0.last_round === null && tr0.payoffs && tr0.payoffs.DC === 5 && tr0.payoffs.CD === 0, rt.status + ' ' + rt.text.slice(0, 200));
    await req('POST', R2 + '/games/' + tr0.id + '/accept', { token: TRex, json: {} });
    rt = await req('POST', R2 + '/games/' + tr0.id + '/accept', { token: TRae, json: {} });
    check('trust starts when everyone accepts', rt.status === 200 && rt.json.game.status === 'running' && /about 4 rounds/.test(rt.json.game.how_to_play || ''), rt.status + ' ' + String(rt.json.game && rt.json.game.how_to_play).slice(0, 120));
    rt = await req('POST', R2 + '/games/' + tr0.id + '/moves', { token: TP, json: { dir: 'C, Rex:D' } });
    check('a default plus an exception commits without resolving', rt.status === 200 && rt.json.resolved === false && JSON.stringify(rt.json.game.you.queued) === '{"Rex":"D","Rae":"C"}', rt.status + ' ' + rt.text.slice(0, 200));
    rt = await req('GET', R2 + '/games/' + tr0.id, { token: TRex });
    check('choices stay secret until the round resolves', (rt.json.game.players.find((p) => p.name === 'Poc') || {}).committed === true && rt.json.game.you.queued === null && rt.json.game.rounds.length === 0 && !JSON.stringify(rt.json.game).includes('"Rex":"D"'), JSON.stringify(rt.json.game).slice(0, 200));
    rt = await req('POST', R2 + '/games/' + tr0.id + '/moves', { token: TRae, json: { dir: 'maybe' } });
    check('a choice that is not C or D -> 400', rt.status === 400 && /not C or D/.test(rt.json.error), rt.status + ' ' + rt.text.slice(0, 120));
    rt = await req('POST', R2 + '/games/' + tr0.id + '/moves', { token: TRae, json: { dir: 'Bob:C' } });
    check('a name that is not a rival -> 400', rt.status === 400 && /not a rival/.test(rt.json.error), rt.status + ' ' + rt.text.slice(0, 120));
    rt = await req('POST', R2 + '/games/' + tr0.id + '/moves', { token: TRae, json: { dir: 'Poc:C' } });
    check('a rival left out with no default -> 400 naming them', rt.status === 400 && /no choice for Rex/.test(rt.json.error), rt.status + ' ' + rt.text.slice(0, 120));
    await req('POST', R2 + '/games/' + tr0.id + '/moves', { token: TRex, json: { dir: 'defect' } });
    rt = await req('POST', R2 + '/games/' + tr0.id + '/moves', { token: TRae, json: { dir: 'cooperate' } });
    const trR1 = ((rt.json.game || {}).rounds || [])[0] || {};
    // Poc-Rex: D/D 1 each; Poc-Rae: C/C 3 each; Rex-Rae: D/C 5 to Rex, 0 to Rae
    check('every pairing scores on its own: Poc 4, Rex 6, Rae 3', rt.status === 200 && rt.json.resolved === true && JSON.stringify(trR1.points) === '{"Poc":4,"Rex":6,"Rae":3}' && trR1.moves.Poc.Rex === 'D' && trR1.moves.Rex.Rae === 'D' && trR1.moves.Rae.Poc === 'C', JSON.stringify(trR1));
    let trG = rt.json.game;
    for (let k = 0; k < 8 && trG.status === 'running'; k++) {
      for (const n of ['Poc', 'Rex', 'Rae']) {
        rt = await req('POST', R2 + '/games/' + tr0.id + '/moves', { token: tokT[n], json: { dir: 'C' } });
        if (rt.json && rt.json.game) trG = rt.json.game;
      }
    }
    check('trust ends at its secret last round; Rex wins by 2', trG.status === 'finished' && trG.winner === 'Rex' && trG.last_round === trG.rounds.length && trG.last_round >= 3 && trG.last_round <= 6 && trG.players.find((p) => p.name === 'Rex').score - trG.players.find((p) => p.name === 'Poc').score === 2, JSON.stringify({ status: trG.status, winner: trG.winner, last: trG.last_round, n: (trG.rounds || []).length, players: trG.players }));
    rt = await req('GET', R2 + '/messages?limit=20', { token: TP });
    check('the Referee posts the Trust result', (rt.json.messages || []).some((x) => x.from === 'Referee' && x.text.includes('Trust match #' + tr0.id + ' is over after') && x.text.includes('Rex wins with')), JSON.stringify((rt.json.messages || []).filter((x) => x.from === 'Referee').map((x) => x.text.slice(0, 100)).slice(-2)));
    // Sealed-bid auction: lots from data, sealed bids, first
    // price, a tie at the top to the lower spender then the earlier bid.
    let rau = await req('POST', R2 + '/games', { token: TP, json: { game: 'auction', from: 'Poc', players: ['Poc'] } });
    check('an auction needs 2 to 6 -> 400', rau.status === 400 && /2 to 6/.test(rau.json.error), rau.status);
    rau = await req('POST', R2 + '/games', { token: TP, json: { game: 'auction', from: 'Poc', players: ['Poc', 'Rex', 'Rae'], lots: 3, budget: 50, tick_seconds: 3600 } });
    const au = rau.json.game || {};
    check('an auction is created in a lobby', rau.status === 201 && au.type === 'auction' && au.status === 'lobby' && au.lots_total === 3 && au.budget === 50 && au.lot === null && au.players.every((p) => p.budget === 50), rau.status + ' ' + rau.text.slice(0, 200));
    await req('POST', R2 + '/games/' + au.id + '/accept', { token: TRex, json: {} });
    rau = await req('POST', R2 + '/games/' + au.id + '/accept', { token: TRae, json: {} });
    check('the auction opens on its first lot', rau.status === 200 && rau.json.game.status === 'running' && typeof rau.json.game.lot === 'string' && rau.json.game.lot.length > 3 && /3 lots/.test(rau.json.game.how_to_play || ''), JSON.stringify(rau.json.game).slice(0, 200));
    rau = await req('POST', R2 + '/games/' + au.id + '/moves', { token: TP, json: { dir: '60' } });
    check('a bid over your budget -> 400', rau.status === 400 && /you have 50 left/.test(rau.json.error), rau.status + ' ' + rau.text.slice(0, 120));
    rau = await req('POST', R2 + '/games/' + au.id + '/moves', { token: TP, json: { dir: 'lots' } });
    check('a bid that is not a number -> 400', rau.status === 400 && /whole number/.test(rau.json.error), rau.status + ' ' + rau.text.slice(0, 120));
    rau = await req('POST', R2 + '/games/' + au.id + '/moves', { token: TP, json: { dir: 'bid 20' } });
    check('a bid commits without resolving', rau.status === 200 && rau.json.resolved === false && rau.json.game.you.queued === 20, rau.status + ' ' + rau.text.slice(0, 160));
    rau = await req('GET', R2 + '/games/' + au.id, { token: TRex });
    check('a bid stays sealed from rivals', (rau.json.game.players.find((p) => p.name === 'Poc') || {}).committed === true && rau.json.game.you.queued === null && rau.json.game.rounds.length === 0, JSON.stringify(rau.json.game).slice(0, 200));
    await req('POST', R2 + '/games/' + au.id + '/moves', { token: TRex, json: { dir: '20' } });
    rau = await req('POST', R2 + '/games/' + au.id + '/moves', { token: TRae, json: { dir: 'pass' } });
    const auR1 = ((rau.json.game || {}).rounds || [])[0] || {};
    check('a tie at the top goes to the earlier bid (equal spend)', rau.json.resolved === true && auR1.winner === 'Poc' && auR1.price === 20 && auR1.tie === 'bid first' && JSON.stringify(auR1.bids) === '{"Poc":20,"Rex":20,"Rae":0}' && rau.json.game.players.find((p) => p.name === 'Poc').budget === 30, JSON.stringify(auR1));
    for (const [tok, b] of [[TP, '10'], [TRex, '25'], [TRae, '5']]) rau = await req('POST', R2 + '/games/' + au.id + '/moves', { token: tok, json: { dir: b } });
    const auR2 = ((rau.json.game || {}).rounds || [])[1] || {};
    check('the highest bid wins and pays; losing bids cost nothing', auR2.winner === 'Rex' && auR2.price === 25 && rau.json.game.players.find((p) => p.name === 'Rex').budget === 25 && rau.json.game.players.find((p) => p.name === 'Rae').budget === 50, JSON.stringify(auR2));
    for (const [tok, b] of [[TP, '30'], [TRex, '25'], [TRae, '0']]) rau = await req('POST', R2 + '/games/' + au.id + '/moves', { token: tok, json: { dir: b } });
    check('most lots takes the season', rau.json.game.status === 'finished' && rau.json.game.winner === 'Poc' && JSON.stringify(rau.json.game.places) === '["Poc","Rex","Rae"]' && rau.json.game.players.find((p) => p.name === 'Poc').won === 2, JSON.stringify(rau.json.game).slice(0, 240));
    rau = await req('GET', R2 + '/messages?limit=20', { token: TP });
    check('the Referee posts the auction result', (rau.json.messages || []).some((x) => x.from === 'Referee' && x.text.includes('Auction #' + au.id + ' is over - Poc takes the season with 2 lots')), JSON.stringify((rau.json.messages || []).filter((x) => x.from === 'Referee').map((x) => x.text.slice(0, 100)).slice(-2)));
    // Liar's Dice: hidden cups, raise or call liar, ones wild,
    // an expired turn costs a die. Cups are set through the test hook.
    const ldTok = { Poc: TP, Rex: TRex, Rae: TRae };
    const ldHook = (id, json) => req('POST', '/api/test-hooks/liarsdice', { owner: true, json: Object.assign({ room: roomOf2, id }, json) });
    const ldMove = (id, who, dir) => req('POST', R2 + '/games/' + id + '/moves', { token: ldTok[who], json: { dir } });
    let rld = await req('POST', R2 + '/games', { token: TP, json: { game: 'liarsdice', from: 'Poc', players: ['Poc'] } });
    check("liar's dice needs 2 to 6 -> 400", rld.status === 400 && /2 to 6/.test(rld.json.error), rld.status);
    rld = await req('POST', R2 + '/games', { token: TP, json: { game: "Liar's Dice", from: 'Poc', players: ['Poc', 'Rex', 'Rae'], dice: 2 } });
    const ld = rld.json.game || {};
    check("liar's dice is created in a lobby (the spelled-out name works)", rld.status === 201 && ld.type === 'liarsdice' && ld.status === 'lobby' && ld.dice_each === 2 && ld.ones_wild === true && ld.dice_total === 6 && ld.turn_seconds === 3600 && ld.players.every((p) => p.dice === 2) && ld.you.dice.length === 2 && ld.order.length === 3, rld.status + ' ' + rld.text.slice(0, 200));
    await req('POST', R2 + '/games/' + ld.id + '/accept', { token: TRex, json: {} });
    rld = await req('POST', R2 + '/games/' + ld.id + '/accept', { token: TRae, json: {} });
    const [L1, L2, L3] = ld.order;
    check("liar's dice starts with the first seat to bid", rld.json.game.status === 'running' && rld.json.game.turn_of === L1 && /Ones are wild/.test(rld.json.game.how_to_play || ''), JSON.stringify(rld.json.game).slice(0, 200));
    rld = await req('GET', R2 + '/games/' + ld.id, { token: TRex });
    check('a cup stays secret: only your own dice, no cups before a call', JSON.stringify(rld.json.game.you.dice) !== undefined && rld.json.game.you.dice.length === 2 && !/"cups"/.test(rld.text) && rld.json.game.players.every((p) => typeof p.dice === 'number'), rld.text.slice(0, 200));
    await ldHook(ld.id, { cups: { Poc: [2, 3], Rex: [3, 1], Rae: [5, 6] } });
    rld = await ldMove(ld.id, L2, '1x3');
    check("liar's dice out of turn -> 409", rld.status === 409, rld.status);
    rld = await ldMove(ld.id, L1, '1x1');
    check('ones wild: a bid on ones -> 400', rld.status === 400 && /faces 2 to 6/.test(rld.json.error), rld.status + ' ' + rld.text.slice(0, 120));
    rld = await ldMove(ld.id, L1, '7x3');
    check('a bid over the dice on the table -> 400', rld.status === 400 && /1 to 6/.test(rld.json.error), rld.status + ' ' + rld.text.slice(0, 120));
    rld = await ldMove(ld.id, L1, '2x3');
    check('a bid passes the turn', rld.status === 200 && rld.json.resolved === false && rld.json.game.turn_of === L2 && rld.json.game.bid.qty === 2 && rld.json.game.bid.face === 3 && rld.json.game.bid.by === L1, rld.status + ' ' + rld.text.slice(0, 160));
    rld = await ldMove(ld.id, L2, '2x2');
    check('a raise that does not beat the bid -> 400 with the lowest raises', rld.status === 400 && /must beat 2 threes/.test(rld.json.error) && JSON.stringify(rld.json.legal_moves) === '["3x2","3x3","2x4","2x5","2x6","liar"]', rld.status + ' ' + rld.text.slice(0, 200));
    rld = await ldMove(ld.id, L2, 'three 3s');
    check('a raise in words', rld.status === 200 && rld.json.game.bid.qty === 3 && rld.json.game.bid.face === 3 && rld.json.game.turn_of === L3, rld.status + ' ' + rld.text.slice(0, 160));
    rld = await ldMove(ld.id, L3, 'liar');
    let ldR1 = ((rld.json.game || {}).rounds || [])[0] || {};
    check('liar! the bid stands (a wild 1 counts), so the caller loses a die and opens', rld.json.resolved === true && ldR1.reason === 'call' && ldR1.count === 3 && ldR1.stands === true && ldR1.loser === L3 && ldR1.dice_left === 1 && JSON.stringify(ldR1.cups.Rex) === '[1,3]' && rld.json.game.round === 2 && rld.json.game.turn_of === L3 && rld.json.game.bid === null && rld.json.game.dice_total === 5, JSON.stringify(ldR1) + ' ' + JSON.stringify(rld.json.game).slice(0, 120));
    await ldHook(ld.id, { expire: true });
    rld = await req('GET', R2 + '/games/' + ld.id, { token: TP });
    ldR1 = (rld.json.game.rounds || [])[1] || {};
    check('an expired turn costs that player a die - their last puts them out', ldR1.reason === 'timeout' && ldR1.loser === L3 && ldR1.out === true && rld.json.game.players.find((p) => p.name === L3).out === true && rld.json.game.order.indexOf(L3) < 0 && rld.json.game.round === 3 && rld.json.game.turn_of === L1, JSON.stringify(ldR1).slice(0, 200) + ' ' + JSON.stringify(rld.json.game.order));
    for (let k = 0; k < 2; k++) {
      await ldHook(ld.id, { expire: true });
      rld = await req('GET', R2 + '/games/' + ld.id, { token: TP });
    }
    check('the last player with dice wins; places run back through who went out', rld.json.game.status === 'finished' && rld.json.game.winner === L2 && JSON.stringify(rld.json.game.places) === JSON.stringify([L2, L1, L3]) && rld.json.game.you.dice.length === 0, JSON.stringify(rld.json.game).slice(0, 240));
    rld = await req('GET', R2 + '/messages?limit=20', { token: TP });
    check("the Referee posts the Liar's Dice result", (rld.json.messages || []).some((x) => x.from === 'Referee' && x.text.includes("Liar's Dice #" + ld.id + ' is over - ' + L2 + ' wins with 2 dice left after 4 rounds.') && x.text.includes('Out in order: ' + L3 + ' (round 2), ' + L1 + ' (round 4)')), JSON.stringify((rld.json.messages || []).filter((x) => x.from === 'Referee').map((x) => x.text.slice(0, 140)).slice(-2)));
    // a 2-player match, played to the end by calls, counts on the ladder
    rld = await req('POST', R2 + '/games', { token: TP, json: { game: 'liarsdice', from: 'Poc', players: ['Poc', 'Rex'], dice: 2, ones_wild: false } });
    const ld2 = rld.json.game || {};
    await req('POST', R2 + '/games/' + ld2.id + '/accept', { token: TRex, json: {} });
    const [M1, M2] = ld2.order;
    await ldHook(ld2.id, { cups: { [M1]: [4, 4], [M2]: [1, 5] } });
    rld = await ldMove(ld2.id, M1, '3x4');
    rld = await ldMove(ld2.id, M2, 'call');
    check('ones not wild: a 1 counts only itself; a false bid costs the bidder', (rld.json.game.rounds[0] || {}).count === 2 && rld.json.game.rounds[0].loser === M1 && rld.json.game.turn_of === M1 && rld.json.game.players.find((p) => p.name === M1).dice === 1, JSON.stringify(rld.json.game.rounds[0]));
    await ldHook(ld2.id, { cups: { [M1]: [2], [M2]: [3, 6] } });
    await ldMove(ld2.id, M1, '1x1');
    rld = await ldMove(ld2.id, M2, 'liar');
    check('the last die gone ends the 2-player match', rld.json.game.status === 'finished' && rld.json.game.winner === M2 && (rld.json.game.rounds[1] || {}).count === 0, JSON.stringify(rld.json.game).slice(0, 200));
    rld = await req('GET', R2 + '/games', { token: TP });
    check("the ladder rates Liar's Dice", ((rld.json.ladder || {}).liarsdice || []).length === 2 && rld.json.ladder.liarsdice[0].name === M2, JSON.stringify((rld.json.ladder || {}).liarsdice));
    // Two Truths and a Lie: a rotating storyteller, structured
    // moves (statements + lie), sealed votes, the lie kept secret.
    const ttExpire = (id) => req('POST', '/api/test-hooks/game-expire', { owner: true, json: { room: roomOf2, id } });
    let rtt = await req('POST', R2 + '/games', { token: TP, json: { game: 'twotruths', from: 'Poc', players: ['Poc', 'Rex'] } });
    check('two truths needs 3 to 6 -> 400', rtt.status === 400 && /3 to 6/.test(rtt.json.error), rtt.status);
    rtt = await req('POST', R2 + '/games', { token: TP, json: { game: 'Two Truths and a Lie', from: 'Poc', players: ['Poc', 'Rex', 'Rae'] } });
    const tt = rtt.json.game || {};
    const [T1, T2, T3] = tt.order || [];
    check('two truths is created in a lobby (the spelled-out name works)', rtt.status === 201 && tt.type === 'twotruths' && tt.status === 'lobby' && tt.rounds_total === 3 && tt.teller === null && tt.round_seconds === 3600 && (tt.order || []).length === 3, rtt.status + ' ' + rtt.text.slice(0, 200));
    await req('POST', R2 + '/games/' + tt.id + '/accept', { token: TRex, json: {} });
    rtt = await req('POST', R2 + '/games/' + tt.id + '/accept', { token: TRae, json: {} });
    check('the first storyteller writes first', rtt.json.game.status === 'running' && rtt.json.game.phase === 'write' && rtt.json.game.teller === T1 && /storyteller/.test(rtt.json.game.how_to_play || ''), JSON.stringify(rtt.json.game).slice(0, 200));
    rtt = await ldMove(tt.id, T2, '1');
    check('a vote before the statements are up -> 409', rtt.status === 409, rtt.status);
    rtt = await req('POST', R2 + '/games/' + tt.id + '/moves', { token: ldTok[T1], json: { statements: ['I have two cats', 'I once met a goat'] , lie: 1 } });
    check('a storyteller must send three statements -> 400', rtt.status === 400 && /exactly three/.test(rtt.json.error), rtt.status + ' ' + rtt.text.slice(0, 120));
    rtt = await req('POST', R2 + '/games/' + tt.id + '/moves', { token: ldTok[T1], json: { statements: ['I have two cats', 'I once met a goat', 'I have been to the moon'], lie: 3 } });
    const ttTeller = rtt.json.game || {};
    check('the statements go up shuffled; the storyteller alone sees the lie', rtt.status === 200 && ttTeller.phase === 'vote' && (ttTeller.statements || []).length === 3 && ttTeller.you.lie >= 1 && ttTeller.you.lie <= 3 && ttTeller.statements[ttTeller.you.lie - 1] === 'I have been to the moon', rtt.status + ' ' + rtt.text.slice(0, 240));
    rtt = await req('GET', R2 + '/games/' + tt.id, { token: ldTok[T2] });
    check('a voter sees the statements but never the lie', rtt.json.game.statements.slice().sort().join('|') === ['I have two cats', 'I once met a goat', 'I have been to the moon'].sort().join('|') && !/"lie"/.test(rtt.text) && JSON.stringify(rtt.json.game.you.legal_moves) === '["1","2","3"]', rtt.text.slice(0, 240));
    rtt = await ldMove(tt.id, T1, '1');
    check('the storyteller cannot vote -> 409', rtt.status === 409, rtt.status);
    const ttLie = ttTeller.you.lie;
    rtt = await ldMove(tt.id, T2, 'vote ' + ttLie);
    check('a vote is sealed until all are in', rtt.status === 200 && rtt.json.resolved === false && (rtt.json.game.players.find((p) => p.name === T2) || {}).committed === true, rtt.status + ' ' + rtt.text.slice(0, 160));
    rtt = await ldMove(tt.id, T3, String((ttLie % 3) + 1));
    let ttR = ((rtt.json.game || {}).rounds || [])[0] || {};
    check('the reveal: a right vote scores 2, the storyteller 1 per player fooled', rtt.json.resolved === true && ttR.lie === ttLie && JSON.stringify(ttR.right) === JSON.stringify([T2]) && ttR.fooled === 1 && ttR.points[T2] === 2 && ttR.points[T1] === 1 && rtt.json.game.phase === 'write' && rtt.json.game.teller === T2, JSON.stringify(ttR) + ' ' + JSON.stringify(rtt.json.game).slice(0, 120));
    rtt = await ldMove(tt.id, T2, JSON.stringify({ statements: ['I speak Welsh', 'I am a night owl', 'I have never seen snow'], lie: 1 }));
    const ttLie2 = (rtt.json.game.you || {}).lie;
    check('the same structured move works as JSON in dir', rtt.status === 200 && rtt.json.game.phase === 'vote' && rtt.json.game.statements[ttLie2 - 1] === 'I speak Welsh', rtt.status + ' ' + rtt.text.slice(0, 200));
    await ldMove(tt.id, T1, String(ttLie2));
    rtt = await ldMove(tt.id, T3, String(ttLie2));
    ttR = ((rtt.json.game || {}).rounds || [])[1] || {};
    check('everyone spotting the lie scores the storyteller nothing, with a roast', ttR.points[T2] === 0 && ttR.right.length === 2 && typeof ttR.note === 'string' && ttR.note.includes(T2), JSON.stringify(ttR));
    await ttExpire(tt.id);
    rtt = await req('GET', R2 + '/games/' + tt.id, { token: TP });
    ttR = (rtt.json.game.rounds || [])[2] || {};
    check('a storyteller who runs out forfeits; the last round ends the game', ttR.forfeit === true && ttR.teller === T3 && rtt.json.game.status === 'finished' && rtt.json.game.winner === T1 && rtt.json.game.places[0] === T1 && rtt.json.game.players.find((p) => p.name === T1).score === 3, JSON.stringify(rtt.json.game).slice(0, 260));
    rtt = await req('GET', R2 + '/messages?limit=20', { token: TP });
    check('the Referee posts the Two Truths result', (rtt.json.messages || []).some((x) => x.from === 'Referee' && x.text.includes('Two Truths and a Lie #' + tt.id + ' is over - ' + T1 + ' wins with 3 points.')), JSON.stringify((rtt.json.messages || []).filter((x) => x.from === 'Referee').map((x) => x.text.slice(0, 120)).slice(-2)));
    // Exquisite Corpse: each writer sees only the segment
    // before theirs; the story is revealed at the end; favourite votes.
    let rco = await req('POST', R2 + '/games', { token: TP, json: { game: 'corpse', from: 'Poc', players: ['Poc', 'Rex'] } });
    check('exquisite corpse needs 3 to 6 -> 400', rco.status === 400 && /3 to 6/.test(rco.json.error), rco.status);
    rco = await req('POST', R2 + '/games', { token: TP, json: { game: 'Exquisite Corpse', from: 'Poc', players: ['Poc', 'Rex', 'Rae'], rotations: 1, seed: 'The cat was late for the meeting.', variant: 'constraints' } });
    const ec = rco.json.game || {};
    const [W1, W2, W3] = ec.order || [];
    check('exquisite corpse is created in a lobby (the spelled-out name works)', rco.status === 201 && ec.type === 'corpse' && ec.status === 'lobby' && ec.turns_total === 3 && ec.variant === 'constraints' && ec.turn_seconds === 86400 && ec.story === null && typeof ec.you.constraint === 'string', rco.status + ' ' + rco.text.slice(0, 200));
    await req('POST', R2 + '/games/' + ec.id + '/accept', { token: TRex, json: {} });
    await req('POST', R2 + '/games/' + ec.id + '/accept', { token: TRae, json: {} });
    rco = await req('GET', R2 + '/games/' + ec.id, { token: ldTok[W1] });
    check('the first writer sees only the seed line', rco.json.game.status === 'running' && rco.json.game.turn_of === W1 && rco.json.game.you.tail === 'The cat was late for the meeting.' && /only the segment before yours/i.test(rco.json.game.how_to_play || ''), rco.text.slice(0, 200));
    rco = await req('GET', R2 + '/games/' + ec.id, { token: ldTok[W2] });
    check('everyone else sees no text at all', !rco.text.includes('The cat was late') && rco.json.game.you.tail === undefined && rco.json.game.story === null, rco.text.slice(0, 200));
    rco = await ldMove(ec.id, W2, 'Out of turn.');
    check('writing out of turn -> 409', rco.status === 409, rco.status);
    rco = await ldMove(ec.id, W1, 'One. Two. Three. Four.');
    check('more than three sentences -> 400', rco.status === 400 && /1 to 3 sentences/.test(rco.json.error), rco.status + ' ' + rco.text.slice(0, 120));
    rco = await ldMove(ec.id, W1, 'It had been a long day. The mice were unionising.');
    check('a segment passes the turn', rco.status === 200 && rco.json.game.turn_of === W2 && rco.json.game.segments === 1, rco.status + ' ' + rco.text.slice(0, 160));
    rco = await req('GET', R2 + '/games/' + ec.id, { token: ldTok[W2] });
    const ecW2 = rco.json.game.you.tail;
    rco = await req('GET', R2 + '/games/' + ec.id, { token: ldTok[W3] });
    check('the next writer sees only the segment before theirs; the rest see nothing', ecW2 === 'It had been a long day. The mice were unionising.' && !rco.text.includes('unionising') && !rco.text.includes('The cat was late'), ecW2 + ' | ' + rco.text.slice(0, 160));
    await ttExpire(ec.id);
    rco = await req('GET', R2 + '/games/' + ec.id, { token: ldTok[W3] });
    check('a turn that runs out is a silent beat - the story goes on', rco.json.game.turn_of === W3 && rco.json.game.players.find((p) => p.name === W2).skips === 1 && rco.json.game.you.tail === 'It had been a long day. The mice were unionising.', JSON.stringify(rco.json.game).slice(0, 200));
    rco = await ldMove(ec.id, W3, 'Meanwhile, the moon filed a complaint.');
    const ecRev = rco.json.game || {};
    check('the last turn reveals the whole story, authors and constraint cards', ecRev.phase === 'vote' && ecRev.seed === 'The cat was late for the meeting.' && ecRev.story.length === 2 && ecRev.story[0].by === W1 && ecRev.story[1].by === W3 && Object.keys(ecRev.constraints || {}).length === 3, JSON.stringify(ecRev).slice(0, 260));
    rco = await ldMove(ec.id, W1, '1');
    check('you cannot vote for your own segment -> 400', rco.status === 400 && /own segment/.test(rco.json.error), rco.status + ' ' + rco.text.slice(0, 120));
    await ldMove(ec.id, W1, '2');
    await ldMove(ec.id, W2, 'vote 2');
    rco = await ldMove(ec.id, W3, '1');
    check('the honours go to the most-voted segment', rco.json.game.status === 'finished' && rco.json.game.winner === W3 && JSON.stringify(rco.json.game.honours) === '[2]' && rco.json.game.votes['2'] === 2 && rco.json.game.places[0] === W3, JSON.stringify(rco.json.game).slice(0, 260));
    rco = await req('GET', R2 + '/messages?limit=20', { token: TP });
    check('the Referee posts the Exquisite Corpse result', (rco.json.messages || []).some((x) => x.from === 'Referee' && x.text.includes('Exquisite Corpse #' + ec.id + ' is finished - 2 segments by 2 writers') && x.text.includes('The honours go to ' + W3 + ' for segment 2 (2 votes)')), JSON.stringify((rco.json.messages || []).filter((x) => x.from === 'Referee').map((x) => x.text.slice(0, 140)).slice(-2)));
    // Twenty Questions: a rotating answerer, a hidden secret,
    // a public Q/A log, exact guesses right on their own.
    let rtq = await req('POST', R2 + '/games', { token: TP, json: { game: 'twenty', from: 'Poc', players: ['Poc'] } });
    check('twenty questions needs 2 to 6 -> 400', rtq.status === 400 && /2 to 6/.test(rtq.json.error), rtq.status);
    rtq = await req('POST', R2 + '/games', { token: TP, json: { game: 'Twenty Questions', from: 'Poc', players: ['Poc', 'Rex'] } });
    const tq = rtq.json.game || {};
    const [A1, A2] = tq.order || [];
    check('twenty questions is created in a lobby (the spelled-out name works)', rtq.status === 201 && tq.type === 'twenty' && tq.status === 'lobby' && tq.rounds_total === 2 && tq.budget === 20 && tq.mode === 'duel', rtq.status + ' ' + rtq.text.slice(0, 200));
    rtq = await req('POST', R2 + '/games/' + tq.id + '/accept', { token: TRex, json: {} });
    rtq = await req('GET', R2 + '/games/' + tq.id, { token: ldTok[A1] });
    check('the first answerer chooses a secret', rtq.json.game.status === 'running' && rtq.json.game.phase === 'secret' && rtq.json.game.answerer === A1 && rtq.json.game.you.answerer === true && rtq.json.game.you.legal_moves.includes('random'), rtq.text.slice(0, 200));
    rtq = await ldMove(tq.id, A2, 'Is it alive?');
    check('asking before the secret is chosen -> 409', rtq.status === 409, rtq.status);
    rtq = await ldMove(tq.id, A1, 'a lighthouse');
    check('a registered secret opens the questions', rtq.status === 200 && rtq.json.game.phase === 'ask' && rtq.json.game.you.secret === 'a lighthouse', rtq.status + ' ' + rtq.text.slice(0, 160));
    rtq = await req('GET', R2 + '/games/' + tq.id, { token: ldTok[A2] });
    check('the secret stays hidden from the questioners', !/lighthouse/i.test(rtq.text) && rtq.json.game.you.legal_moves.length === 2, rtq.text.slice(0, 160));
    await ldMove(tq.id, A2, 'Is it alive?');
    rtq = await ldMove(tq.id, A2, 'Is it big?');
    check('one question at a time -> 409', rtq.status === 409 && /waiting/.test(rtq.json.error), rtq.status + ' ' + rtq.text.slice(0, 120));
    rtq = await ldMove(tq.id, A1, 'maybe');
    check('the answer is yes or no -> 400', rtq.status === 400 && /yes or no/.test(rtq.json.error), rtq.status + ' ' + rtq.text.slice(0, 120));
    rtq = await ldMove(tq.id, A1, 'unanswerable');
    check('an unanswerable question costs nothing', rtq.json.game.asked === 0 && rtq.json.game.phase === 'ask' && rtq.json.game.qa[0].flagged === true, JSON.stringify(rtq.json.game.qa));
    await ldMove(tq.id, A2, 'Is it a building?');
    rtq = await ldMove(tq.id, A1, 'yes - by the sea');
    check('a yes with a note spends a question; the log is public', rtq.json.game.asked === 1 && rtq.json.game.remaining === 19 && rtq.json.game.qa[1].a === 'yes' && rtq.json.game.qa[1].note === 'by the sea', JSON.stringify(rtq.json.game.qa));
    rtq = await ldMove(tq.id, A2, 'guess: The Lighthouse!');
    let tqR = ((rtq.json.game || {}).rounds || [])[0] || {};
    check('an exact guess is right on its own: the questions left score', rtq.json.resolved === true && tqR.how === 'guessed' && tqR.guessed_by === A2 && tqR.secret === 'a lighthouse' && tqR.points[A2] === 18 && rtq.json.game.round === 2 && rtq.json.game.answerer === A2 && rtq.json.game.phase === 'secret', JSON.stringify(tqR).slice(0, 200));
    rtq = await ldMove(tq.id, A2, 'random');
    check('random draws a secret', rtq.json.game.phase === 'ask' && typeof rtq.json.game.you.secret === 'string' && rtq.json.game.you.secret.length > 2, rtq.text.slice(0, 160));
    for (let k = 0; k < 3; k++) {
      await ttExpire(tq.id);
      rtq = await req('GET', R2 + '/games/' + tq.id, { token: TP });
    }
    tqR = (rtq.json.game.rounds || [])[1] || {};
    check('three clocks with no question hand the round to the answerer', tqR.how === 'idle' && tqR.points[A2] === 10 && rtq.json.game.status === 'finished' && rtq.json.game.winner === A2 && rtq.json.game.players.find((p) => p.name === A2).score === 28, JSON.stringify(rtq.json.game).slice(0, 240));
    rtq = await req('GET', R2 + '/messages?limit=20', { token: TP });
    check('the Referee posts the Twenty Questions result', (rtq.json.messages || []).some((x) => x.from === 'Referee' && x.text.includes('Twenty Questions #' + tq.id + ' is over - ' + A2 + ' wins with 28 points.') && x.text.includes('Quickest: "a lighthouse" named by ' + A2 + ' in 2.')), JSON.stringify((rtq.json.messages || []).filter((x) => x.from === 'Referee').map((x) => x.text.slice(0, 140)).slice(-2)));
    // Werewolf: secret roles, silent nights, public days, the
    // in-game talk, team wins on the record.
    const invIvy = await req('POST', R2 + '/invites', { owner: true, json: { name: 'Ivy', kind: 'agent' } });
    const invJax = await req('POST', R2 + '/invites', { owner: true, json: { name: 'Jax', kind: 'agent' } });
    ldTok.Ivy = invIvy.json.token;
    ldTok.Jax = invJax.json.token;
    await req('GET', R2 + '/members', { token: ldTok.Ivy });
    await req('GET', R2 + '/members', { token: ldTok.Jax });
    let rww = await req('POST', R2 + '/games', { token: TP, json: { game: 'werewolf', from: 'Poc', players: ['Poc', 'Rex', 'Rae', 'Ivy'] } });
    check('werewolf needs 5 to 9 -> 400', rww.status === 400 && /5 to 9/.test(rww.json.error), rww.status);
    rww = await req('POST', R2 + '/games', { token: TP, json: { game: 'Werewolf', from: 'Poc', players: ['Poc', 'Rex', 'Rae', 'Ivy', 'Jax'] } });
    const ww = rww.json.game || {};
    check('werewolf is created in a lobby with secret roles', rww.status === 201 && ww.type === 'werewolf' && ww.status === 'lobby' && JSON.stringify(ww.roles_in_play) === '{"werewolf":1,"seer":1,"guardian":0,"villager":3}' && ww.players.every((p) => p.role === null) && typeof ww.you.role === 'string' && ww.phase_seconds === 86400, rww.status + ' ' + rww.text.slice(0, 220));
    for (const n of ['Rex', 'Rae', 'Ivy', 'Jax']) await req('POST', R2 + '/games/' + ww.id + '/accept', { token: ldTok[n], json: {} });
    const wwRole = {};
    for (const n of ['Poc', 'Rex', 'Rae', 'Ivy', 'Jax']) wwRole[n] = ((await req('GET', R2 + '/games/' + ww.id, { token: ldTok[n] })).json.game.you || {}).role;
    const WW = Object.keys(wwRole).find((n) => wwRole[n] === 'werewolf');
    const SE = Object.keys(wwRole).find((n) => wwRole[n] === 'seer');
    const VS = Object.keys(wwRole).filter((n) => wwRole[n] === 'villager');
    rww = await req('GET', R2 + '/games/' + ww.id, { token: ldTok[VS[0]] });
    check('the first night falls; a villager sees no one else\'s role', rww.json.game.status === 'running' && rww.json.game.phase === 'night' && rww.json.game.night === 1 && !!WW && !!SE && VS.length === 3 && rww.json.game.players.every((p) => p.role === null) && rww.json.game.den === undefined && rww.json.game.you.pack === undefined && rww.json.game.you.legal_moves.length === 0, rww.text.slice(0, 200));
    rww = await req('GET', R2 + '/games', { token: TP });
    const wwList = (rww.json.games || []).find((x) => x.id === ww.id) || {};
    check('the public waiting list is empty at night (it would point at the roles)', Array.isArray(wwList.targets) && wwList.targets.length === 0, JSON.stringify(wwList.targets));
    rww = await ldMove(ww.id, VS[0], 'kill ' + VS[1]);
    check('a villager has nothing to do at night -> 409', rww.status === 409 && /sleeps/.test(rww.json.error), rww.status + ' ' + rww.text.slice(0, 120));
    rww = await ldMove(ww.id, VS[0], 'say: hello?');
    check('the village does not talk at night -> 409', rww.status === 409, rww.status);
    rww = await ldMove(ww.id, WW, 'check ' + VS[0]);
    check('a werewolf kills, not checks -> 400', rww.status === 400 && /Tonight you kill/.test(rww.json.error), rww.status + ' ' + rww.text.slice(0, 120));
    rww = await ldMove(ww.id, WW, 'den: the seer worries me');
    check('the den is the pack\'s own channel', rww.status === 200 && (rww.json.game.den || []).some((t) => t.text === 'the seer worries me'), rww.text.slice(0, 200));
    rww = await req('GET', R2 + '/games/' + ww.id, { token: ldTok[VS[0]] });
    check('nobody else hears the den', !rww.text.includes('the seer worries me'), rww.text.slice(0, 160));
    await ldMove(ww.id, SE, 'check ' + WW);
    rww = await ldMove(ww.id, WW, 'kill ' + VS[0]);
    let wwEv = ((rww.json.game || {}).events || [])[0] || {};
    check('the night resolves when every role has acted; dawn names the dead and the role', rww.json.resolved === true && wwEv.kind === 'death' && wwEv.who === VS[0] && wwEv.role === 'villager' && rww.json.game.phase === 'day' && rww.json.game.day === 1, JSON.stringify(wwEv) + ' ' + JSON.stringify(rww.json.game).slice(0, 120));
    rww = await req('GET', R2 + '/games/' + ww.id, { token: ldTok[SE] });
    check('the seer learns what they checked, privately', JSON.stringify(rww.json.game.you.checks) === JSON.stringify([{ night: 1, target: WW, wolf: true }]), JSON.stringify(rww.json.game.you.checks));
    rww = await ldMove(ww.id, VS[0], 'vote ' + WW);
    check('the dead neither act nor speak -> 409', rww.status === 409 && /dead/.test(rww.json.error), rww.status);
    await ldMove(ww.id, SE, 'say: I checked ' + WW + ' - a werewolf.');
    rww = await req('GET', R2 + '/games/' + ww.id, { token: ldTok[VS[1]] });
    check('the town talk is in the game for everyone', (rww.json.game.talk || []).some((t) => t.by === SE && t.text.includes('a werewolf')), JSON.stringify(rww.json.game.talk));
    await ldMove(ww.id, SE, 'vote ' + WW);
    await ldMove(ww.id, VS[1], WW);
    await ldMove(ww.id, VS[2], 'vote ' + WW);
    rww = await ldMove(ww.id, WW, 'vote ' + SE);
    wwEv = ((rww.json.game || {}).events || [])[1] || {};
    check('the village votes the werewolf out and wins', rww.json.resolved === true && wwEv.kind === 'eliminated' && wwEv.who === WW && wwEv.role === 'werewolf' && rww.json.game.status === 'finished' && rww.json.game.side === 'village' && rww.json.game.winners.length === 4 && rww.json.game.winners.indexOf(WW) < 0, JSON.stringify(rww.json.game).slice(0, 260));
    check('the end reveals every role and the den', rww.json.game.players.every((p) => !!p.role) && (rww.json.game.den || []).length === 1, JSON.stringify(rww.json.game.players));
    rww = await req('GET', R2 + '/games', { token: TP });
    const wwRec = (rww.json.record || {}).werewolf || [];
    check('a team win counts for everyone on the side', wwRec.find((x) => x.name === SE).w === 1 && wwRec.find((x) => x.name === VS[0]).w === 1 && wwRec.find((x) => x.name === WW).l === 1, JSON.stringify(wwRec));
    rww = await req('GET', R2 + '/messages?limit=20', { token: TP });
    check('the Referee posts the Werewolf result', (rww.json.messages || []).some((x) => x.from === 'Referee' && x.text.includes('Werewolf #' + ww.id + ' is over - the village wins at day 1: the werewolf was ' + WW + '.')), JSON.stringify((rww.json.messages || []).filter((x) => x.from === 'Referee').map((x) => x.text.slice(0, 140)).slice(-2)));
    // Letter Grid: a shared grid (laid by the test hook),
    // words checked when sent, sealed until the round resolves, first
    // claims, the duplicate rule, a same-round contest, and the tiebreaks
    // down to the earlier final-round word.
    let rlg = await req('POST', R2 + '/games', { token: TP, json: { game: 'lettergrid', from: 'Poc', players: ['Poc'] } });
    check('letter grid needs 2 to 6 -> 400', rlg.status === 400 && /2 to 6/.test(rlg.json.error), rlg.status);
    rlg = await req('POST', R2 + '/games', { token: TP, json: { game: 'Letter Grid', from: 'Poc', players: ['Poc', 'Rex', 'Rae'], rounds: 3, size: 4 } });
    const lg = rlg.json.game || {};
    check('letter grid is created in a lobby with a public grid', rlg.status === 201 && lg.type === 'lettergrid' && lg.status === 'lobby' && lg.size === 4 && lg.rounds_total === 3 && lg.min_len === 3 && (lg.grid || []).length === 4 && (lg.claims || []).length === 16 && lg.claims.every((x) => x === null) && lg.word_count > 20 && lg.top_words === null, rlg.status + ' ' + rlg.text.slice(0, 220));
    for (const n of ['Rex', 'Rae']) await req('POST', R2 + '/games/' + lg.id + '/accept', { token: ldTok[n], json: {} });
    rlg = await req('POST', '/api/test-hooks/lettergrid', { owner: true, json: { room: roomOf2, id: lg.id, rows: ['cats', 'orex', 'ding', 'elmp'] } });
    check('the test hook lays a known grid', rlg.json.ok === true && rlg.json.word_count > 10, rlg.text.slice(0, 120));
    const lgMove = (who, body) => req('POST', R2 + '/games/' + lg.id + '/moves', { token: ldTok[who], json: body });
    rlg = await lgMove('Poc', { dir: 'qwzx' });
    check('a word not in the dictionary is refused (send another)', rlg.status === 400 && /not in the dictionary/.test(rlg.json.error), rlg.status + ' ' + rlg.text.slice(0, 120));
    rlg = await lgMove('Poc', { dir: 'dog' });
    check('a word that cannot be traced is refused', rlg.status === 400 && /can't be traced/.test(rlg.json.error), rlg.status + ' ' + rlg.text.slice(0, 120));
    rlg = await lgMove('Poc', { word: 'cat', path: ['A1', 'B1', 'D1'] });
    check('a path that spells something else is refused', rlg.status === 400 && /D1 is S, not T/.test(rlg.json.error), rlg.status + ' ' + rlg.text.slice(0, 120));
    rlg = await lgMove('Poc', { word: 'cats', path: ['A1', 'B1', 'C1'] });
    check('a path of the wrong length is refused', rlg.status === 400 && /3 cells but CATS has 4/.test(rlg.json.error), rlg.status + ' ' + rlg.text.slice(0, 120));
    rlg = await lgMove('Poc', { word: 'cats', path: [[0, 0], [0, 1], [0, 2], [0, 3]] });
    check('a structured word and path (row, col pairs) seal the move', rlg.status === 200 && rlg.json.resolved === false && rlg.json.game.you.queued.word === 'cats', rlg.status + ' ' + rlg.text.slice(0, 160));
    rlg = await req('GET', R2 + '/games/' + lg.id, { token: ldTok.Rex });
    check('a sealed word stays hidden from the others', rlg.json.game.players.find((p) => p.name === 'Poc').committed === true && !/"word":"cats"/.test(rlg.text) && rlg.json.game.you.queued === null, rlg.text.slice(0, 160));
    rlg = await lgMove('Rex', { dir: 'CATS' });
    rlg = await lgMove('Rae', { dir: 'ring B2 B3 C3 D3' });
    let lgR = ((rlg.json.game || {}).rounds || [])[0] || {};
    check('round 1: a shared word scores letters only; a fresh word claims its cells', rlg.json.resolved === true && rlg.json.game.round === 2 && lgR.words.Poc.dup === true && lgR.points.Poc === 4 && lgR.points.Rex === 4 && lgR.words.Rae.bonus === 4 && lgR.points.Rae === 8 && rlg.json.game.claims[5] === 'Rae' && rlg.json.game.claims[11] === 'Rae' && rlg.json.game.claims[0] === null, JSON.stringify(lgR).slice(0, 260));
    rlg = await lgMove('Poc', { dir: 'cats' });
    check('your own words cannot repeat', rlg.status === 400 && /already/.test(rlg.json.error), rlg.status + ' ' + rlg.text.slice(0, 120));
    rlg = await lgMove('Poc', { word: 'core' });
    check('a word without a path gets one traced for it', rlg.status === 200 && JSON.stringify(rlg.json.game.you.queued.path) === '[[0,0],[1,0],[1,1],[1,2]]', rlg.text.slice(0, 200));
    rlg = await lgMove('Rex', { dir: 'care: A1 B1 B2 C2' });
    await ttExpire(lg.id);
    rlg = await req('GET', R2 + '/games/' + lg.id, { token: TP });
    lgR = (rlg.json.game.rounds || [])[1] || {};
    check('round 2: a cell two words take first stays free; the clock resolves a missed word', lgR.missed.includes('Rae') && lgR.points.Poc === 5 && lgR.points.Rex === 5 && JSON.stringify(lgR.words.Poc.contested) === '[0,6]' && rlg.json.game.claims[0] === null && rlg.json.game.claims[6] === null && rlg.json.game.claims[4] === 'Poc' && rlg.json.game.claims[1] === 'Rex', JSON.stringify(lgR).slice(0, 260));
    rlg = await lgMove('Rex', { word: 'rate' });
    rlg = await lgMove('Poc', { dir: 'dine A3 B3 C3 C2' });
    await ttExpire(lg.id);
    rlg = await req('GET', R2 + '/games/' + lg.id, { token: TP });
    const lgG = rlg.json.game || {};
    check('a full tie goes to the earlier final-round word', lgG.status === 'finished' && lgG.winner === 'Rex' && JSON.stringify(lgG.places) === '["Rex","Poc","Rae"]' && lgG.players.find((p) => p.name === 'Rex').score === 14 && lgG.players.find((p) => p.name === 'Poc').score === 14 && lgG.players.find((p) => p.name === 'Poc').cells === 2 && Array.isArray(lgG.top_words) && lgG.top_words.length > 0, JSON.stringify(lgG).slice(0, 260));
    rlg = await req('GET', R2 + '/messages?limit=20', { token: TP });
    check('the Referee posts the Letter Grid result', (rlg.json.messages || []).some((x) => x.from === 'Referee' && x.text.includes('Letter Grid match #' + lg.id + ' is over after 3 rounds - Rex wins with 14 points.')), JSON.stringify((rlg.json.messages || []).filter((x) => x.from === 'Referee').map((x) => x.text.slice(0, 140)).slice(-2)));
    // Trivia: a rotating quizmaster asks their own questions. A sealed
    // answer, wagers capped, lenient matching, the quizmaster's judging,
    // the split bonus, a missed answer and a forfeit ask.
    let rtv = await req('POST', R2 + '/games', { token: TP, json: { game: 'trivia', from: 'Poc', players: ['Poc'] } });
    check('trivia needs 2 to 6 -> 400', rtv.status === 400 && /2 to 6/.test(rtv.json.error), rtv.status);
    rtv = await req('POST', R2 + '/games', { token: TP, json: { game: 'quiz', from: 'Poc', players: ['Poc', 'Rex', 'Rae'], rotations: 1 } });
    const tv = rtv.json.game || {};
    check('trivia is created in a lobby (the quiz alias works)', rtv.status === 201 && tv.type === 'trivia' && tv.status === 'lobby' && tv.rounds_total === 3 && tv.players.every((p) => p.balance === 100) && tv.max_wager === 25, rtv.status + ' ' + rtv.text.slice(0, 200));
    for (const n of ['Rex', 'Rae']) await req('POST', R2 + '/games/' + tv.id + '/accept', { token: ldTok[n], json: {} });
    const [Q0, Q1, Q2] = tv.order || [];
    const tvMove = (who, body) => req('POST', R2 + '/games/' + tv.id + '/moves', { token: ldTok[who], json: body });
    rtv = await req('GET', R2 + '/games/' + tv.id, { token: ldTok[Q0] });
    check('the first quizmaster is asked for a question', rtv.json.game.status === 'running' && rtv.json.game.phase === 'ask' && rtv.json.game.asker === Q0 && rtv.json.game.you.asker === true, rtv.text.slice(0, 160));
    rtv = await tvMove(Q1, { answer: 'x', wager: 1 });
    check('answering before the question is up -> 409', rtv.status === 409, rtv.status);
    rtv = await tvMove(Q0, { dir: 'What is my cat called?' });
    check('a question without its answer -> 400', rtv.status === 400 && /send question and answer/.test(rtv.json.error), rtv.status + ' ' + rtv.text.slice(0, 120));
    rtv = await tvMove(Q0, { question: 'What is my cat called?', answer: 'Biscuit', accept: ['Bisquit'] });
    check('a structured question opens the answers', rtv.status === 200 && rtv.json.game.phase === 'answer' && rtv.json.game.you.answer === 'Biscuit', rtv.status + ' ' + rtv.text.slice(0, 160));
    rtv = await req('GET', R2 + '/games/' + tv.id, { token: ldTok[Q1] });
    check('the question is public, the answer sealed', rtv.json.game.question === 'What is my cat called?' && !/Biscuit/i.test(rtv.text) && rtv.json.game.you.max_wager === 25, rtv.text.slice(0, 200));
    rtv = await tvMove(Q0, { answer: 'Biscuit', wager: 5 });
    check('the quizmaster cannot answer -> 409', rtv.status === 409, rtv.status);
    rtv = await tvMove(Q1, { answer: 'biscuit!', wager: 30 });
    check('a wager over 25 -> 400', rtv.status === 400 && /at most 25/.test(rtv.json.error), rtv.status + ' ' + rtv.text.slice(0, 120));
    rtv = await tvMove(Q1, { answer: 'The Biscuit', wager: 20 });
    check('an answer and a wager are sealed', rtv.status === 200 && rtv.json.resolved === false && rtv.json.game.you.queued.wager === 20, rtv.status + ' ' + rtv.text.slice(0, 160));
    rtv = await req('GET', R2 + '/games/' + tv.id, { token: ldTok[Q2] });
    check('another answer stays hidden from the table', rtv.json.game.players.find((p) => p.name === Q1).committed === true && !/The Biscuit/.test(rtv.text), rtv.text.slice(0, 160));
    rtv = await tvMove(Q2, { dir: 'my cat Bisc @ 10' });
    check('an answer the match misses goes to the quizmaster to judge', rtv.status === 200 && rtv.json.resolved === false && rtv.json.game.phase === 'judge', rtv.status + ' ' + rtv.text.slice(0, 160));
    rtv = await req('GET', R2 + '/games/' + tv.id, { token: ldTok[Q0] });
    check('the quizmaster sees only the answers to judge', JSON.stringify(rtv.json.game.you.to_judge) === JSON.stringify([{ name: Q2, answer: 'my cat Bisc', accepted: false }]) && rtv.json.game.you.legal_moves.includes('accept ' + Q2), JSON.stringify(rtv.json.game.you));
    rtv = await tvMove(Q2, { dir: 'Biscuit @ 10' });
    check('answers are closed while the quizmaster judges -> 409', rtv.status === 409, rtv.status);
    rtv = await tvMove(Q0, { dir: 'accept Nobody' });
    check('judging someone with no answer waiting -> 400', rtv.status === 400 && /no answer waiting/.test(rtv.json.error), rtv.status + ' ' + rtv.text.slice(0, 120));
    rtv = await tvMove(Q0, { dir: 'done' });
    let tvR = ((rtv.json.game || {}).rounds || [])[0] || {};
    check('round 1: right gains the wager, wrong loses it, a split pays the quizmaster', rtv.json.resolved === true && tvR.answers[Q1].right === true && tvR.answers[Q2].right === false && tvR.split === true && tvR.deltas[Q0] === 10 && tvR.totals[Q0] === 110 && tvR.totals[Q1] === 120 && tvR.totals[Q2] === 90 && rtv.json.game.asker === Q1 && rtv.json.game.phase === 'ask', JSON.stringify(tvR).slice(0, 260));
    rtv = await tvMove(Q1, { dir: 'How many legs does a spider have? = eight | 8' });
    check('a question as dir (Question? = answer | variant)', rtv.status === 200 && rtv.json.game.phase === 'answer' && JSON.stringify(rtv.json.game.you.accept) === '["8"]', rtv.status + ' ' + rtv.text.slice(0, 160));
    rtv = await tvMove(Q0, { dir: 'Eight! @ 25' });
    await ttExpire(tv.id);
    rtv = await req('GET', R2 + '/games/' + tv.id, { token: TP });
    tvR = (rtv.json.game.rounds || [])[1] || {};
    check('round 2: the clock closes the answers; a missed answer is 0, no split', tvR.answers[Q0].right === true && tvR.deltas[Q0] === 25 && tvR.missed.includes(Q2) && tvR.deltas[Q2] === 0 && tvR.split === false && rtv.json.game.asker === Q2, JSON.stringify(tvR).slice(0, 240));
    await ttExpire(tv.id);
    rtv = await req('GET', R2 + '/games/' + tv.id, { token: TP });
    const tvG = rtv.json.game || {};
    check('a quizmaster who runs out forfeits; the last round ends the game', tvG.status === 'finished' && tvG.rounds[2].forfeit === true && tvG.winner === Q0 && JSON.stringify(tvG.places) === JSON.stringify([Q0, Q1, Q2]) && tvG.players.find((p) => p.name === Q0).balance === 135, JSON.stringify(tvG).slice(0, 240));
    rtv = await req('GET', R2 + '/messages?limit=20', { token: TP });
    check('the Referee posts the Trivia result', (rtv.json.messages || []).some((x) => x.from === 'Referee' && x.text.includes('Trivia #' + tv.id + ' is over - ' + Q0 + ' wins with 135 points.') && x.text.includes('Best quizmaster: ' + Q0 + ' (split the table 1 time).')), JSON.stringify((rtv.json.messages || []).filter((x) => x.from === 'Referee').map((x) => x.text.slice(0, 160)).slice(-2)));
    // Sketch & Guess: image moves, and the Referee is Claude. The
    // artist's secret prompt, an image move checked by its bytes and
    // served at a signed URL, sealed guesses, the plain match, the
    // Referee's verdict (the test hook stands in for Claude), the fallback
    // when the Referee can't be reached, and a forfeit.
    let rsg = await req('POST', R2 + '/games', { token: TP, json: { game: 'sketch', from: 'Poc', players: ['Poc', 'Rex'] } });
    check('sketch & guess needs 3 to 6 -> 400', rsg.status === 400 && /3 to 6/.test(rsg.json.error), rsg.status);
    rsg = await req('POST', R2 + '/games', { token: TP, json: { game: 'pictionary', from: 'Poc', players: ['Poc', 'Rex', 'Rae'], rotations: 1 } });
    const sg = rsg.json.game || {};
    check('sketch & guess is created in a lobby (the pictionary alias works)', rsg.status === 201 && sg.type === 'sketch' && sg.status === 'lobby' && sg.rounds_total === 3 && sg.guess_seconds === 600 && sg.draw_seconds === 3600, rsg.status + ' ' + rsg.text.slice(0, 200));
    for (const n of ['Rex', 'Rae']) await req('POST', R2 + '/games/' + sg.id + '/accept', { token: ldTok[n], json: {} });
    const [A0sg, A1sg, A2sg] = sg.order || [];
    const sgMove = (who, body) => req('POST', R2 + '/games/' + sg.id + '/moves', { token: ldTok[who], json: body });
    const sgHook = (verdict) => req('POST', '/api/test-hooks/sketch-judge', { owner: true, json: { room: roomOf2, verdict } });
    const pngUrl = 'data:image/png;base64,' + PNG.toString('base64');
    rsg = await req('GET', R2 + '/games/' + sg.id, { token: ldTok[A0sg] });
    const prompt1 = (rsg.json.game.you || {}).prompt || '';
    check('the artist alone sees the prompt', rsg.json.game.status === 'running' && rsg.json.game.phase === 'draw' && rsg.json.game.artist === A0sg && prompt1.length > 3, rsg.text.slice(0, 200));
    rsg = await req('GET', R2 + '/games/' + sg.id, { token: ldTok[A1sg] });
    check('the prompt stays hidden from the guessers', rsg.json.game.you.prompt === undefined && !rsg.text.includes(prompt1), rsg.text.slice(0, 160));
    rsg = await sgMove(A1sg, { guess: 'a cat' });
    check('guessing before the drawing is up -> 409', rsg.status === 409, rsg.status);
    rsg = await sgMove(A0sg, { dir: 'here it is' });
    check('an artist move without an image -> 400', rsg.status === 400 && /data URL/.test(rsg.json.error), rsg.status + ' ' + rsg.text.slice(0, 120));
    rsg = await sgMove(A0sg, { image: 'data:image/png;base64,AAAAAAAAAAAAAAAA' });
    check('an image that is not a PNG, JPEG, GIF or WebP -> 400', rsg.status === 400 && /PNG, JPEG, GIF or WebP/.test(rsg.json.error), rsg.status + ' ' + rsg.text.slice(0, 120));
    rsg = await sgMove(A0sg, { image: pngUrl });
    const sgImg = (rsg.json.game || {}).image || {};
    check('the drawing goes up and opens the guesses', rsg.status === 200 && rsg.json.game.phase === 'guess' && sgImg.type === 'image/png' && /\/games\/\d+\/sketch\/1\?exp=\d+&sig=/.test(sgImg.url || ''), rsg.status + ' ' + rsg.text.slice(0, 200));
    let sgFetch = await fetch(BASE + sgImg.url);
    let sgBytes = Buffer.from(await sgFetch.arrayBuffer());
    check('the signed link serves the drawing', sgFetch.status === 200 && sgFetch.headers.get('content-type') === 'image/png' && sgBytes.equals(PNG), sgFetch.status + ' ' + sgFetch.headers.get('content-type'));
    sgFetch = await fetch(BASE + sgImg.url.replace(/sig=[^&]+/, 'sig=nope'));
    check('a forged signature -> 403', sgFetch.status === 403, sgFetch.status);
    sgFetch = await fetch(BASE + R2 + '/games/' + sg.id + '/sketch/1');
    check('no signature and no credential -> refused', sgFetch.status === 401 || sgFetch.status === 403, sgFetch.status);
    await sgHook({ right: [A2sg], roast: '' });
    rsg = await sgMove(A1sg, { guess: '  ' + prompt1.toUpperCase() + '!  ' });
    check('a sealed guess', rsg.status === 200 && rsg.json.resolved === false && rsg.json.game.you.queued === prompt1.toUpperCase() + '!', rsg.status + ' ' + rsg.text.slice(0, 160));
    rsg = await sgMove(A2sg, { guess: 'something close' });
    let sgR = ((rsg.json.game || {}).rounds || [])[0] || {};
    check('round 1: the plain match and the Referee\'s verdict both count', rsg.json.resolved === true && sgR.prompt === prompt1 && sgR.guesses[A1sg].right === true && sgR.guesses[A1sg].exact === true && sgR.guesses[A1sg].how === 'match' && sgR.guesses[A2sg].right === true && sgR.guesses[A2sg].how === 'referee' && sgR.points[A1sg] === 2 && sgR.points[A2sg] === 2 && sgR.points[A0sg] === 2 && sgR.judge === 'referee' && /\/sketch\/1\?/.test((sgR.image || {}).url || '') && rsg.json.game.artist === A1sg, JSON.stringify(sgR).slice(0, 300));
    rsg = await sgMove(A1sg, { image: pngUrl });
    await sgHook({ error: 'timeout' });
    await sgMove(A0sg, { guess: 'nope' });
    rsg = await sgMove(A2sg, { dir: 'nada' });
    sgR = ((rsg.json.game || {}).rounds || [])[1] || {};
    check('round 2: when the Referee can\'t be reached, the plain match stands, with a roast', rsg.json.resolved === true && sgR.right.length === 0 && sgR.judge === 'match' && sgR.judge_note === 'timeout' && sgR.points[A1sg] === 0 && (sgR.roast || '').includes(sgR.prompt), JSON.stringify(sgR).slice(0, 300));
    await ttExpire(sg.id);
    rsg = await req('GET', R2 + '/games/' + sg.id, { token: TP });
    const sgG = rsg.json.game || {};
    check('an artist who runs out forfeits (the prompt revealed); the last round ends the game', sgG.status === 'finished' && sgG.rounds[2].forfeit === true && sgG.rounds[2].prompt && sgG.winner === A1sg && sgG.places[0] === A1sg, JSON.stringify(sgG).slice(0, 260));
    rsg = await req('GET', R2 + '/messages?limit=20', { token: TP });
    check('the Referee posts the Sketch & Guess result', (rsg.json.messages || []).some((x) => x.from === 'Referee' && x.text.includes('Sketch & Guess #' + sg.id + ' is over - ' + A1sg + ' wins with 2 points.')), JSON.stringify((rsg.json.messages || []).filter((x) => x.from === 'Referee').map((x) => x.text.slice(0, 160)).slice(-2)));
    check('the ladder covers the other 2-player games too', !!(r.json.ladder || {}).frontlines && !!(r.json.ladder || {}).coderace && (r.json.ladder.frontlines || []).every((x) => typeof x.rating === 'number'), JSON.stringify(Object.keys(r.json.ladder || {})));

    // Reserved name: "Referee" is the games' official -
    // it cannot be invited as a member, and it cannot be seated.
    r = await req('POST', R2 + '/invites', { owner: true, json: { name: 'Referee', kind: 'agent' } });
    check('inviting a member named Referee -> 400', r.status === 400 && String(r.json.error || '').toLowerCase().includes('reserved'), r.status + ' ' + JSON.stringify(r.json).slice(0, 140));
    r = await req('POST', R2 + '/games', { token: TP, json: { game: 'duel', from: 'Poc', players: ['Referee', 'Poc'], best_of: 3 } });
    check('seating Referee in a game -> 400', r.status === 400 && String(r.json.error || '').toLowerCase().includes('reserved'), r.status + ' ' + JSON.stringify(r.json).slice(0, 140));
    // Duel clock: the default round deadline is 180s. An agent's
    // wake-to-act cycle runs 1-2 minutes, so a 60s round could end a
    // duel before a woken player threw.
    r = await req('POST', R2 + '/games', { token: TP, json: { game: 'duel', from: 'Poc', players: ['Poc', 'Rex'], best_of: 3 } });
    check('duel default round clock is 180', r.status === 201 && r.json.game.round_seconds === 180, r.status + ' ' + JSON.stringify(r.json.game).slice(0, 140));
    const duelDef = r.json.game.id;
    r = await req('POST', R2 + '/games/' + duelDef + '/cancel', { token: TP, json: {} });
    check('default-clock duel cancels clean', r.status === 200 && r.json.game.status === 'cancelled', r.status);
    // An unthrown round 1 calls the duel off (verified in the late
    // checks at the end of the run, which expire its 30s round).
    r = await req('POST', R2 + '/games', { token: TP, json: { game: 'duel', from: 'Poc', players: ['Poc', 'Rex'], best_of: 3, tick_seconds: 30 } });
    const duelR1 = r.json.game.id;
    await req('POST', R2 + '/games/' + duelR1 + '/accept', { token: TRex, json: {} });

    // Endgame sonar: drive a scripted classic match until both
    // captains are down to their last ship, then trade misses until
    // the referee pings. The ping must name the shooter whose turn
    // it is, and a row/column that truly holds an un-hit cell of the
    // hunted last ship.
    r = await req('POST', R2 + '/games', { token: TP, json: { game: 'battleship', from: 'Poc', players: ['Poc', 'Rex'], tick_seconds: 3600 } });
    const snId = r.json.game.id;
    await req('POST', R2 + '/games/' + snId + '/accept', { token: TRex, json: {} });
    await req('POST', R2 + '/games/' + snId + '/moves', { token: TP, json: { dir: 'A1H,A3H,A5H,A7H,A9H' } });
    await req('POST', R2 + '/games/' + snId + '/moves', { token: TRex, json: { dir: 'J1V,H1V,F1V,F5V,H6V' } });
    // Poc's last ship is A9H (row 9, columns A-B); Rex's is H6V
    // (column H, rows 6-7). Neither queue touches them.
    const snQueues = { Poc: ['J1', 'J2', 'J3', 'J4', 'J5', 'H1', 'H2', 'H3', 'H4', 'F1', 'F2', 'F3', 'F5', 'F6', 'F7'], Rex: ['A1', 'B1', 'C1', 'D1', 'E1', 'A3', 'B3', 'C3', 'D3', 'A5', 'B5', 'C5', 'A7', 'B7', 'C7', 'D7'] };
    const snPads = { Poc: ['A10', 'B10', 'C10', 'D10', 'E10', 'G10', 'I10', 'J10', 'A8', 'J8'], Rex: ['J10', 'I10', 'G10', 'E10', 'C10', 'A10', 'B8', 'D10', 'J8', 'I8'] };
    let st0 = await req('GET', R2 + '/games/' + snId, { token: TP });
    const snHolder = st0.json.game.turn_of;
    if (snHolder !== 'Poc') st0 = await req('GET', R2 + '/games/' + snId, { token: TRex });
    check('play-phase legal_moves list every open cell', ((st0.json.game.you || {}).legal_moves || []).length === 100, JSON.stringify((st0.json.game.you || {}).legal_moves || []).slice(0, 120));
    let snState = null;
    let snPing = null;
    let snShots = 0;
    for (let step = 0; step < 70 && !snPing; step++) {
      const st = await req('GET', R2 + '/games/' + snId, { token: TP });
      const g = st.json && st.json.game;
      if (!g) break;
      snState = g;
      if (g.sonar) { snPing = g.sonar; break; }
      if (g.status !== 'running' || g.phase !== 'play') break;
      const turn = g.turn_of;
      const q = snQueues[turn].length ? snQueues[turn] : snPads[turn];
      const cell = q.shift();
      const mv = await req('POST', R2 + '/games/' + snId + '/moves', { token: turn === 'Poc' ? TP : TRex, json: { dir: cell } });
      if (mv.status !== 200) break;
      snShots++;
    }
    check('sonar pings once both captains are down to one ship', !!snPing, 'shots=' + snShots + ' sonar=' + JSON.stringify(snState && snState.sonar));
    check('the ping names the shooter whose turn it is', !!snPing && !!snState && snPing.for === snState.turn_of, JSON.stringify(snPing));
    const snTruth = snPing ? (snPing.for === 'Poc' ? ['row 6', 'row 7', 'column H'] : ['row 9', 'column A', 'column B']) : [];
    check('the pinged line holds an un-hit cell of the last ship', !!snPing && snTruth.indexOf(snPing.label) >= 0, JSON.stringify(snPing));
    r = await req('GET', R2 + '/games/' + snId + '?log=full', { token: TP });
    check('the shots record is complete and timestamped', (r.json.game.shots || []).length === snShots && (r.json.game.shots || []).every(s => typeof s.at === 'number' && typeof s.cell === 'string' && (s.result === 'hit' || s.result === 'miss')), 'shots=' + ((r.json.game.shots || []).length) + ' fired=' + snShots);
    r = await req('POST', R2 + '/games/' + snId + '/cancel', { token: TP, json: {} });
    check('sonar match cancels clean', r.status === 200 && r.json.game.status === 'cancelled', r.status);

    // Stream subscriptions: events= narrows the frame kinds, game=
    // restricts game frames to given matches, and a malformed
    // subscription answers 400 before the stream opens. The default
    // (no params) stays the full feed.
    r = await req('GET', R2 + '/stream?events=bogus', { token: TP });
    check('stream: unknown event kind -> 400', r.status === 400 && String(r.json && r.json.error).includes('message'), r.status + ' ' + JSON.stringify(r.json));
    r = await req('GET', R2 + '/stream?game=abc', { token: TP });
    check('stream: malformed game list -> 400', r.status === 400, r.status + ' ' + JSON.stringify(r.json));
    async function openStream(p, token) {
      const ctl = new AbortController();
      const resp = await fetch(BASE + p, { headers: { 'X-Invite-Token': token }, signal: ctl.signal });
      const frames = [];
      let buf = '';
      const dec = new TextDecoder();
      (async () => {
        try {
          const reader = resp.body.getReader();
          for (;;) {
            const part = await reader.read();
            if (part.done) break;
            buf += dec.decode(part.value, { stream: true });
            let i;
            while ((i = buf.indexOf('\n\n')) >= 0) { frames.push(buf.slice(0, i)); buf = buf.slice(i + 2); }
          }
        } catch {}
      })();
      return { status: resp.status, frames, close: () => { try { ctl.abort(); } catch {} } };
    }
    async function waitFor(fn, ms) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await new Promise(res => setTimeout(res, 100)); } return fn(); }
    let s = await openStream(R2 + '/stream?after=0', TP);
    check('stream: default feed replays message frames', await waitFor(() => s.frames.some(f => f.includes('event: message')), 4000), JSON.stringify(s.frames).slice(0, 120));
    s.close();
    r = await req('POST', R2 + '/games', { token: TP, json: { from: 'Poc', players: ['Poc', 'Rex'], tick_seconds: 30, w: 12, h: 10 } });
    const gid2 = r.json.game.id;
    await req('POST', R2 + '/games/' + gid2 + '/accept', { token: TRex, json: {} });
    s = await openStream(R2 + '/stream?events=game', TP);
    await req('POST', R2 + '/messages', { token: TP, json: { from: 'Poc', text: 'stream filter probe' } });
    await new Promise(res => setTimeout(res, 1500));
    check('stream: events=game sends no message frames', !s.frames.some(f => f.includes('event: message')), JSON.stringify(s.frames).slice(0, 160));
    // Game frames broadcast when a tick resolves (both riders move), not
    // on a merely queued move - the resolution is the turn signal.
    await req('POST', R2 + '/games/' + gid2 + '/moves', { token: TP, json: { dir: 'down' } });
    await req('POST', R2 + '/games/' + gid2 + '/moves', { token: TRex, json: { dir: 'up' } });
    check('stream: events=game delivers game frames', await waitFor(() => s.frames.some(f => f.includes('event: game') && f.includes('"id":' + gid2)), 4000), JSON.stringify(s.frames).slice(0, 160));
    s.close();
    s = await openStream(R2 + '/stream?events=game&game=' + (gid2 + 999), TP);
    await req('POST', R2 + '/games/' + gid2 + '/moves', { token: TP, json: { dir: 'right' } });
    await req('POST', R2 + '/games/' + gid2 + '/moves', { token: TRex, json: { dir: 'left' } });
    await new Promise(res => setTimeout(res, 1500));
    check('stream: game= restricts frames to the listed matches', !s.frames.some(f => f.includes('event: game')), JSON.stringify(s.frames).slice(0, 160));
    s.close();
    s = await openStream(R2 + '/stream?events=game&game=' + gid2, TP);
    await req('POST', R2 + '/games/' + gid2 + '/moves', { token: TP, json: { dir: 'up' } });
    await req('POST', R2 + '/games/' + gid2 + '/moves', { token: TRex, json: { dir: 'down' } });
    check('stream: game= passes the listed match', await waitFor(() => s.frames.some(f => f.includes('event: game') && f.includes('"id":' + gid2)), 4000), JSON.stringify(s.frames).slice(0, 160));
    s.close();

    // State events: message frames are lean (no room_state riding inside),
    // the default feed gets no state frames at all, and an explicit state
    // subscriber gets one snapshot on connect plus a fresh frame only when
    // the rendered block actually changes.
    s = await openStream(R2 + '/stream?after=0', TP);
    await waitFor(() => s.frames.some(f => f.includes('event: message')), 4000);
    await new Promise(res => setTimeout(res, 800));
    check('stream: message frames carry no room_state', !s.frames.some(f => f.includes('event: message') && f.includes('room_state')), JSON.stringify(s.frames).slice(0, 200));
    check('stream: default feed sends no state frames', !s.frames.some(f => f.includes('event: state')), JSON.stringify(s.frames).slice(0, 200));
    s.close();
    s = await openStream(R2 + '/stream?events=message,state', TP);
    check('stream: state subscriber gets a snapshot on connect', await waitFor(() => s.frames.some(f => f.includes('event: state') && f.includes('"room_state"')), 4000), JSON.stringify(s.frames).slice(0, 200));
    // A post re-checks the state; Poc's block doesn't change with it, so
    // nothing may be re-sent. Compared frame to frame, not counted: Poc's
    // other live matches in this room keep their turn clocks, and on a slow
    // run one can run out here - a real change, rightly sent.
    const stateFrames = () => s.frames.filter(f => f.includes('event: state'));
    await req('POST', R2 + '/messages', { token: TP, json: { from: 'Poc', text: 'state dedupe probe' } });
    await waitFor(() => s.frames.some(f => f.includes('event: message') && f.includes('state dedupe probe')), 4000);
    await new Promise(res => setTimeout(res, 1000));
    const sf = stateFrames();
    check('stream: unchanged state is not re-sent', sf.every((f, i) => i === 0 || f !== sf[i - 1]), sf.length + ' state frames, a repeat at ' + sf.findIndex((f, i) => i > 0 && f === sf[i - 1]));
    r = await req('POST', R2 + '/questions', { token: TP, json: { from: 'Poc', text: 'State event probe question?' } });
    const probeQid = r.json && r.json.question && r.json.question.id;
    check('stream: board change pushes a state frame', await waitFor(() => s.frames.some(f => f.includes('event: state') && f.includes('"open_questions"') && f.includes('State event probe question?')), 4000), JSON.stringify(s.frames).slice(-400));
    if (probeQid) await req('DELETE', R2 + '/questions/' + probeQid, { token: TP });
    s.close();
    // Envelope: every frame kind carries from + kind + targets, and
    // message objects carry targets on reads and post responses too.
    function frameData(f) { const i = f.indexOf('data: '); if (i < 0) return null; try { return JSON.parse(f.slice(i + 6)); } catch { return null; } }
    s = await openStream(R2 + '/stream?events=all,state&after=latest', TP);
    check('envelope: state snapshot has a null actor', await waitFor(() => s.frames.some(f => { const d = frameData(f); return d && d.type === 'state' && d.from === null && d.kind === null && Array.isArray(d.targets); }), 4000), JSON.stringify(s.frames).slice(0, 200));
    r = await req('POST', R2 + '/messages', { token: TP, json: { from: 'Poc', text: '@Rex envelope probe' } });
    const envMsgId = r.json.id;
    check('envelope: post response carries mention targets', JSON.stringify(r.json.targets) === '["Rex"]', JSON.stringify(r.json).slice(0, 200));
    check('envelope: message frame carries from/kind/targets', await waitFor(() => s.frames.some(f => { const d = frameData(f); return d && d.id === envMsgId && d.from === 'Poc' && !!d.kind && JSON.stringify(d.targets) === '["Rex"]'; }), 4000), JSON.stringify(s.frames).slice(-300));
    r = await req('GET', R2 + '/messages?after=' + (envMsgId - 1) + '&limit=5', { token: TP });
    const envListed = (r.json.messages || []).find(x => x.id === envMsgId);
    check('envelope: listing carries mention targets', !!envListed && JSON.stringify(envListed.targets) === '["Rex"]', JSON.stringify(envListed).slice(0, 200));
    await req('POST', R2 + '/messages/' + envMsgId + '/reactions', { token: TRex, json: { from: 'Rex', reaction: '\uD83D\uDC4D' } });
    check('envelope: reaction frame targets the author', await waitFor(() => s.frames.some(f => { const d = frameData(f); return d && d.type === 'reaction' && d.from === 'Rex' && JSON.stringify(d.targets) === '["Poc"]'; }), 4000), JSON.stringify(s.frames).slice(-300));
    await req('PUT', R2 + '/avatar', { token: TP, headers: { 'Content-Type': 'image/png' }, body: PNG });
    check('envelope: members frame names the changed member', await waitFor(() => s.frames.some(f => { const d = frameData(f); return d && d.type === 'members' && d.from === 'Poc' && !!d.kind && Array.isArray(d.targets); }), 4000), JSON.stringify(s.frames).slice(-300));
    r = await req('POST', R2 + '/games', { token: TP, json: { game: 'duel', from: 'Poc', players: ['Poc', 'Rex'], best_of: 3, tick_seconds: 3600 } });
    const envDuel = r.json.game.id;
    check('envelope: game create frame names creator and awaited', await waitFor(() => s.frames.some(f => { const d = frameData(f); return d && d.type === 'game' && d.game.id === envDuel && d.from === 'Poc' && JSON.stringify(d.targets) === '["Rex"]'; }), 4000), JSON.stringify(s.frames).slice(-300));
    await req('POST', R2 + '/games/' + envDuel + '/accept', { token: TRex, json: {} });
    await req('POST', R2 + '/games/' + envDuel + '/moves', { token: TP, json: { dir: 'rock' } });
    check('frames: a submitted throw sends its own frame', await waitFor(() => s.frames.some(f => { const d = frameData(f); return d && d.type === 'game' && d.game.id === envDuel && d.game.status === 'running' && d.game.round === 1 && d.from === 'Poc' && JSON.stringify(d.targets) === '["Rex"]'; }), 4000), JSON.stringify(s.frames).slice(-300));
    await req('POST', R2 + '/games/' + envDuel + '/moves', { token: TRex, json: { dir: 'scissors' } });
    check('frames: the round-opening frame speaks as the Referee', await waitFor(() => s.frames.some(f => { const d = frameData(f); return d && d.type === 'game' && d.game.id === envDuel && d.game.round === 2 && d.from === 'Referee' && d.kind === 'non_interactive' && JSON.stringify(d.targets) === '["Poc","Rex"]'; }), 4000), JSON.stringify(s.frames).slice(-300));
    await req('POST', R2 + '/games/' + envDuel + '/cancel', { token: TP, json: {} });
    r = await req('POST', R2 + '/games', { token: TP, json: { from: 'Poc', players: ['Poc', 'Rex'], tick_seconds: 3600, w: 12, h: 10 } });
    const envLC = r.json.game.id;
    await req('POST', R2 + '/games/' + envLC + '/accept', { token: TRex, json: {} });
    await req('POST', R2 + '/games/' + envLC + '/moves', { token: TP, json: { dir: 'down' } });
    check('frames: a submitted cycle move sends its own frame', await waitFor(() => s.frames.some(f => { const d = frameData(f); return d && d.type === 'game' && d.game.id === envLC && d.game.status === 'running' && d.from === 'Poc' && JSON.stringify(d.targets) === '["Rex"]'; }), 4000), JSON.stringify(s.frames).slice(-300));
    await req('POST', R2 + '/games/' + envLC + '/moves', { token: TRex, json: { dir: 'up' } });
    check('frames: the tick-opening frame speaks as the Referee', await waitFor(() => s.frames.some(f => { const d = frameData(f); return d && d.type === 'game' && d.game.id === envLC && d.from === 'Referee' && d.kind === 'non_interactive' && JSON.stringify(d.targets) === '["Poc","Rex"]'; }), 4000), JSON.stringify(s.frames).slice(-300));
    await req('POST', R2 + '/games/' + envLC + '/cancel', { token: TP, json: {} });
    s.close();

    // Park the stream match: with a real alarm armed it would otherwise
    // keep resolving ticks (and eventually post a result) behind the
    // rest of the suite's back.
    await req('POST', R2 + '/games/' + gid2 + '/cancel', { token: TP, json: {} });

    // Delivery numbers: media landing on a live message delivers it again,
    // whole and once, to every cursor up to and including its own - the
    // stream under a higher id: line (data.id stays the message id), a
    // long poll at the message's cursor with it - and the next long poll
    // from the returned last_id waits. A reader whose cursor was the
    // message itself used to get nothing.
    r = await req('POST', R2 + '/messages', { token: TP, json: { from: 'Poc', text: 'delivery probe' } });
    const dpId = r.json.id;
    r = await req('GET', R2 + '/messages?limit=1', { token: TP });
    const dpCursor = r.json.last_id;
    check('delivery: last_id is the newest message', dpCursor === dpId, dpCursor + ' vs ' + dpId);
    s = await openStream(R2 + '/stream?after=' + dpCursor, TP);
    await waitFor(() => s.frames.some(f => f.startsWith('retry:')), 4000);
    const dpPoll = req('GET', R2 + '/messages?after=' + dpCursor + '&wait=10', { token: TP });
    await new Promise(res => setTimeout(res, 400));
    r = await req('PUT', R2 + '/messages/' + dpId + '/image', { token: TP, headers: { 'Content-Type': 'image/png' }, body: PNG });
    check('delivery: PUT an image on the live message', r.status === 200, r.status + ' ' + r.text.slice(0, 120));
    const dpFrame = () => s.frames.find(f => { const d = frameData(f); return d && d.id === dpId && d.image; });
    await waitFor(() => !!dpFrame(), 4000);
    const dpLine = dpFrame() ? parseInt((/^id: (\d+)$/m.exec(dpFrame()) || [])[1], 10) : NaN;
    check('delivery: the stream sends it again with the image under a higher id: line', dpLine > dpCursor, JSON.stringify(s.frames).slice(-300));
    s.close();
    const dpGot = await dpPoll;
    check('delivery: the long poll at its cursor returns it with the image', dpGot.status === 200 && (dpGot.json.messages || []).length === 1 && dpGot.json.messages[0].id === dpId && !!dpGot.json.messages[0].image && dpGot.json.last_id === dpLine, JSON.stringify(dpGot.json).slice(0, 300));
    const dpT0 = Date.now();
    r = await req('GET', R2 + '/messages?after=' + dpGot.json.last_id + '&wait=2', { token: TP });
    check('delivery: the next long poll from last_id waits', r.status === 200 && r.json.messages.length === 0 && Date.now() - dpT0 >= 1800, (Date.now() - dpT0) + 'ms ' + JSON.stringify(r.json.messages).slice(0, 200));

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
    // Without a valid token MCP takes one small request: a batch of
    // tokenless initialize calls once came back 75 times the size it went in.
    const initCall = (n) => ({ jsonrpc: '2.0', id: n, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {} } });
    r = await req('POST', R2 + '/mcp', { json: initCall(1) });
    check('mcp tokenless initialize still answers', r.status === 200 && !!(r.json && r.json.result && r.json.result.serverInfo), r.status + ' ' + r.text.slice(0, 80));
    r = await req('POST', R2 + '/mcp', { json: [initCall(1), initCall(2)] });
    check('mcp tokenless batch -> -32600 with the token code, nothing run', r.status === 400 && !Array.isArray(r.json) && !!(r.json && r.json.error && r.json.error.code === -32600 && r.json.error.data && r.json.error.data.code === 'invite_missing'), r.status + ' ' + r.text.slice(0, 160));
    r = await req('POST', R2 + '/mcp', { token: 'not-a-token', json: [initCall(1), initCall(2)] });
    check('mcp batch with a wrong token -> -32600 invite_invalid', r.status === 400 && !!(r.json && r.json.error && r.json.error.code === -32600 && r.json.error.data && r.json.error.data.code === 'invite_invalid'), r.status + ' ' + r.text.slice(0, 160));
    r = await req('POST', R2 + '/mcp', { token: TP, json: [{ jsonrpc: '2.0', id: 1, method: 'ping' }, initCall(2)] });
    check('mcp member batch still answers each item', r.status === 200 && Array.isArray(r.json) && r.json.length === 2 && r.json.every(x => x.result), r.status + ' ' + r.text.slice(0, 120));
    r = await putChunked(R2 + '/mcp', 'POST', chunked(1048576 + 1000, '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"pad":"', '"}}'), { 'Content-Type': 'application/json' });
    check('mcp tokenless body over 1 MiB -> 413', r.status === 413 && !!(r.json && r.json.error && r.json.error.code === -32600), r.status + ' ' + r.text.slice(0, 120));
    r = await mcp(R2, 'tools/call', { name: 'whoami', arguments: {} });
    check('mcp unauthenticated tools/call -> -32001', !!(r.json && r.json.error && r.json.error.code === -32001), JSON.stringify(r.json).slice(0, 120));
    r = await mcp(R2, 'initialize', { protocolVersion: '2025-03-26', capabilities: {} }, { token: TP });
    check('mcp initialize handshake', !!(r.json && r.json.result && r.json.result.serverInfo && r.json.result.serverInfo.name === 'agent-chat' && r.json.result.protocolVersion === '2025-03-26'), JSON.stringify(r.json).slice(0, 160));
    check('mcp instructions point agents at games and how_to_play', /awaiting_you/.test((r.json.result || {}).instructions || '') && /how_to_play/.test((r.json.result || {}).instructions || ''), String((r.json.result || {}).instructions || '').slice(0, 120));
    r = await req('POST', R2 + '/mcp', { token: TP, json: { jsonrpc: '2.0', method: 'notifications/initialized' } });
    check('mcp notification -> bare 202', r.status === 202 && r.text === '', r.status + ' ' + r.text.slice(0, 40));
    r = await mcp(R2, 'tools/list', {}, { token: TP });
    const toolNames = ((r.json && r.json.result && r.json.result.tools) || []).map(t => t.name);
    check('mcp catalog lists the surface', toolNames.includes('post_message') && toolNames.includes('begin_upload') && toolNames.includes('submit_move') && toolNames.includes('react') && toolNames.includes('list_attachments') && toolNames.length >= 25, toolNames.join(',').slice(0, 200));
    const ra = await mcp(R2, 'tools/call', { name: 'list_attachments', arguments: { kind: 'image' } }, { token: TP });
    const mcpAtts = ra.json && ra.json.result && ra.json.result.structuredContent;
    check('mcp list_attachments returns the listing', !!(mcpAtts && Array.isArray(mcpAtts.attachments) && mcpAtts.attachments.length >= 1 && mcpAtts.attachments.every(a => a.kind === 'image') && mcpAtts.counts && mcpAtts.counts.image >= 1), JSON.stringify(ra.json).slice(0, 200));
    const toolByName = {}; for (const t of ((r.json && r.json.result && r.json.result.tools) || [])) toolByName[t.name] = t;
    check('mcp reads carry readOnlyHint, writes do not', !!(toolByName.list_messages && toolByName.list_messages.annotations && toolByName.list_messages.annotations.readOnlyHint === true && toolByName.post_message && toolByName.post_message.annotations && toolByName.post_message.annotations.readOnlyHint === false), JSON.stringify(toolByName.list_messages && toolByName.list_messages.annotations));
    check('mcp every tool is annotated', toolNames.length > 0 && toolNames.every(n => { const a = toolByName[n].annotations; return a && typeof a.readOnlyHint === 'boolean' && typeof a.idempotentHint === 'boolean' && typeof a.openWorldHint === 'boolean' && (a.readOnlyHint || typeof a.destructiveHint === 'boolean'); }), toolNames.filter(n => !toolByName[n].annotations).join(','));
    check('mcp destructive hints land on deletes', !!(toolByName.delete_message && toolByName.delete_message.annotations.destructiveHint === true && toolByName.fetch_url && toolByName.fetch_url.annotations.openWorldHint === true && toolByName.react && toolByName.react.annotations.idempotentHint === true), JSON.stringify(toolByName.delete_message && toolByName.delete_message.annotations));
    const catBlock = r.json && r.json.result && r.json.result.catalog;
    check('mcp tools/list carries catalog version + digest', !!(catBlock && catBlock.version && /^[0-9a-f]{16}$/.test(catBlock.digest || '')), JSON.stringify(catBlock));
    r = await mcp(R2, 'tools/list', {}, { token: TP });
    check('mcp catalog digest is stable across calls', !!catBlock && !!(r.json && r.json.result && r.json.result.catalog && r.json.result.catalog.digest === catBlock.digest), JSON.stringify(r.json && r.json.result && r.json.result.catalog));
    r = await mcp(R2, 'initialize', { protocolVersion: '2025-03-26', capabilities: {} }, { token: TP });
    check('mcp initialize carries the same catalog pin', !!(r.json && r.json.result && r.json.result.catalog && catBlock && r.json.result.catalog.digest === catBlock.digest && r.json.result.serverInfo && r.json.result.serverInfo.version === catBlock.version), JSON.stringify(r.json && r.json.result && r.json.result.catalog));
    r = await mcp(R2, 'tools/call', { name: 'whoami', arguments: {} }, { token: 'bogus-token-value' });
    check('mcp bad token refusal names itself', !!(r.json && r.json.error && r.json.error.code === -32001 && /isn't valid/.test(r.json.error.message || '')), JSON.stringify(r.json).slice(0, 160));
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
    check('mcp game created into its lobby', !!mcpGame && mcpGame.status === 'lobby', JSON.stringify(r.json).slice(0, 200));
    r = await mcp(R2, 'tools/call', { name: 'accept_game', arguments: { id: mcpGame.id } }, { token: TRex });
    check('mcp accept starts the match', !!(r.json && r.json.result && r.json.result.structuredContent && r.json.result.structuredContent.game.status === 'running'), JSON.stringify(r.json).slice(0, 200));
    await mcp(R2, 'tools/call', { name: 'submit_move', arguments: { id: mcpGame.id, dir: 'down' } }, { token: TP });
    r = await mcp(R2, 'tools/call', { name: 'submit_move', arguments: { id: mcpGame.id, dir: 'up' } }, { token: TRex });
    check('mcp moves resolve a tick', !!(r.json && r.json.result && r.json.result.structuredContent && r.json.result.structuredContent.resolved === true && r.json.result.structuredContent.game.tick === 1), JSON.stringify(r.json).slice(0, 200));
    r = await mcp(R2, 'tools/call', { name: 'cancel_game', arguments: { id: mcpGame.id } }, { token: TP });
    check('mcp cancel stops the match', !!(r.json && r.json.result && r.json.result.structuredContent && r.json.result.structuredContent.game.status === 'cancelled'), JSON.stringify(r.json).slice(0, 200));
    r = await mcp(R2, 'tools/call', { name: 'create_game', arguments: { game: 'duel', players: ['Poc', 'Rex'], best_of: 1, tick_seconds: 3600 } }, { token: TP });
    const mcpDuel = r.json && r.json.result && r.json.result.structuredContent && r.json.result.structuredContent.game;
    check('mcp duel created', !!mcpDuel && mcpDuel.type === 'duel' && mcpDuel.target === 1, JSON.stringify(r.json).slice(0, 200));
    await mcp(R2, 'tools/call', { name: 'accept_game', arguments: { id: mcpDuel.id } }, { token: TRex });
    await mcp(R2, 'tools/call', { name: 'submit_move', arguments: { id: mcpDuel.id, dir: 'scissors' } }, { token: TP });
    r = await mcp(R2, 'tools/call', { name: 'submit_move', arguments: { id: mcpDuel.id, dir: 'paper' } }, { token: TRex });
    const mcpDuelEnd = r.json && r.json.result && r.json.result.structuredContent;
    check('mcp duel throws resolve and finish a best-of-1', !!mcpDuelEnd && mcpDuelEnd.resolved === true && mcpDuelEnd.game.status === 'finished' && mcpDuelEnd.game.winner === 'Poc', JSON.stringify(r.json).slice(0, 200));
    // create_game passes every option through, as REST does: Letter Grid's
    // size and min_length and Sketch & Guess's clocks once never arrived.
    r = await mcp(R2, 'tools/call', { name: 'create_game', arguments: { game: 'lettergrid', players: ['Poc', 'Rex'], size: 4, min_length: 4 } }, { token: TP });
    const mcpLg = r.json && r.json.result && r.json.result.structuredContent && r.json.result.structuredContent.game;
    check('mcp create_game honours Letter Grid size and min_length', !!mcpLg && mcpLg.size === 4 && mcpLg.min_len === 4, JSON.stringify(r.json).slice(0, 240));
    if (mcpLg) await mcp(R2, 'tools/call', { name: 'cancel_game', arguments: { id: mcpLg.id } }, { token: TP });
    r = await mcp(R2, 'tools/call', { name: 'create_game', arguments: { game: 'sketch', players: ['Poc', 'Rex', 'Rae'], draw_seconds: 120, guess_seconds: 60 } }, { token: TP });
    const mcpSg = r.json && r.json.result && r.json.result.structuredContent && r.json.result.structuredContent.game;
    check('mcp create_game honours Sketch & Guess draw_seconds and guess_seconds', !!mcpSg && mcpSg.draw_seconds === 120 && mcpSg.guess_seconds === 60, JSON.stringify(r.json).slice(0, 240));
    if (mcpSg) await mcp(R2, 'tools/call', { name: 'cancel_game', arguments: { id: mcpSg.id } }, { token: TP });
    r = await mcp(R2, 'tools/call', { name: 'begin_upload', arguments: { kind: 'image', text: 'mcp delegated upload' } }, { token: TP });
    const up = r.json && r.json.result && r.json.result.structuredContent;
    check('mcp begin_upload returns a one-time ticket URL', !!up && !!up.message_id && up.upload && up.upload.method === 'PUT' && String(up.upload.url).includes('/api/uploads/') && up.upload.single_use === true && String(up.upload.auth).includes('URL is the credential') && !String(up.upload.url).includes(TP), JSON.stringify(r.json).slice(0, 220));
    // The whole point of the ticket: the PUT carries no credential at all.
    // (wrangler dev reports the production origin in returned URLs, so the
    // suite rewrites the origin back to the dev base before dereferencing.)
    const putTicket = (url, body, type) => fetch(BASE + new URL(url).pathname, { method: 'PUT', headers: { 'Content-Type': type || 'image/png' }, body });
    r = await putTicket(up.upload.url, PNG);
    check('ticket PUT with no credential lands the bytes', r.status === 200, r.status);
    r = await mcp(R2, 'tools/call', { name: 'publish_message', arguments: { id: up.message_id } }, { token: TP });
    check('mcp publish completes the upload', !!(r.json && r.json.result && !r.json.result.isError && r.json.result.structuredContent && r.json.result.structuredContent.id === up.message_id), JSON.stringify(r.json).slice(0, 200));
    r = await req('GET', R2 + '/messages?limit=10', { token: TRex });
    check('delegated upload is room-visible', (r.json.messages || []).some(x => x.id === up.message_id && x.image), JSON.stringify((r.json.messages || []).map(x => x.id)).slice(0, 120));
    // On the MCP surface: during a simulated R2 outage, attach_media fails
    // as a tool error carrying the storage message, and recovers after.
    await req('POST', '/api/test-hooks/r2-fail', { owner: true, json: { room: R2.slice('/api/rooms/'.length), on: true } });
    r = await mcp(R2, 'tools/call', { name: 'attach_media', arguments: { id: up.message_id, kind: 'image', base64: PNG.toString('base64') } }, { token: TP });
    check('mcp attach_media during outage -> tool error with the storage message', !!(r.json && r.json.result && r.json.result.isError && JSON.stringify(r.json.result).includes('Storage is unavailable right now. Nothing was saved; try again.')), JSON.stringify(r.json).slice(0, 220));
    await req('POST', '/api/test-hooks/r2-fail', { owner: true, json: { room: R2.slice('/api/rooms/'.length), on: false } });
    r = await mcp(R2, 'tools/call', { name: 'attach_media', arguments: { id: up.message_id, kind: 'image', base64: PNG.toString('base64') } }, { token: TP });
    check('mcp attach_media works again after the outage', !!(r.json && r.json.result && !r.json.result.isError), JSON.stringify(r.json).slice(0, 200));

    // Upload tickets: lifecycle and failure semantics.
    const room2Name = R2.slice('/api/rooms/'.length);
    const mintTicket = async (args) => {
      const rr = await mcp(R2, 'tools/call', { name: 'begin_upload', arguments: args || { kind: 'image', text: 'ticket probe' } }, { token: TP });
      return rr.json && rr.json.result && rr.json.result.structuredContent;
    };
    // A spent ticket answers 410 on a second PUT.
    r = await putTicket(up.upload.url, PNG);
    check('spent ticket -> 410', r.status === 410, r.status);
    // A garbled ticket answers 404 with no hint.
    r = await putTicket(BASE + '/api/uploads/' + room2Name + '/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', PNG);
    check('garbled ticket -> 404', r.status === 404, r.status);
    // Wrong-kind bytes answer 415 and do not spend the ticket.
    const tk1 = await mintTicket();
    r = await putTicket(tk1.upload.url, mp4(), 'video/mp4');
    check('video bytes on an image ticket -> 415', r.status === 415, r.status);
    r = await putTicket(tk1.upload.url, PNG);
    check('the same ticket still takes the right file after a 415', r.status === 200, r.status);
    // Oversize answers 413 and does not spend the ticket.
    const tk2 = await mintTicket();
    r = await putTicket(tk2.upload.url, Buffer.alloc(5000001, 7));
    const bigText = await r.text();
    check('oversize on a ticket -> 413, naming begin_upload and its ceiling', r.status === 413 && /begin_upload/.test(bigText) && /TB/.test(bigText), r.status + ' ' + bigText.slice(0, 200));
    // The ticket is looked up before the body is read, and the body read
    // only up to the ticket's max_bytes: a chunked body (no
    // Content-Length) used to be held whole first, whatever its size, and
    // past 32 MiB the hand-off to the room failed with a 500.
    r = await putChunked('/api/uploads/' + room2Name + '/' + 'C'.repeat(43), 'PUT', chunked(34000000));
    check('unknown ticket with a 34 MB chunked body -> 404, not held whole', r.status === 404, r.status + ' ' + r.text.slice(0, 120));
    for (let i = 0; i < 5; i++) r = await putChunked(new URL(tk2.upload.url).pathname, 'PUT', chunked(5000001), { 'Content-Type': 'image/png' });
    check('chunked oversize on a ticket -> 413, naming begin_upload', r.status === 413 && /begin_upload/.test(r.text), r.status + ' ' + r.text.slice(0, 160));
    r = await putTicket(tk2.upload.url, PNG);
    check('the same ticket still works after a 413 (oversize spends no attempt)', r.status === 200, r.status);
    // Ticket media on a draft stays private until publish, as on every other path.
    r = await req('GET', R2 + '/messages/' + tk2.message_id + '/image', { token: TRex });
    check('ticket-uploaded draft media is private before publish', r.status === 404, r.status);
    r = await mcp(R2, 'tools/call', { name: 'publish_message', arguments: { id: tk2.message_id } }, { token: TP });
    check('publish after ticket upload works', !!(r.json && r.json.result && !r.json.result.isError), JSON.stringify(r.json).slice(0, 160));
    r = await req('GET', R2 + '/messages/' + tk2.message_id + '/image', { token: TRex });
    check('ticket-uploaded media is room-visible after publish', r.status === 200, r.status);
    // The ticket string leaks nowhere: not in listings, not in the publish result.
    const listing = await req('GET', R2 + '/messages?limit=50', { token: TP });
    const rawTicket = tk2.upload.url.split('/').pop();
    check('ticket appears in no listing', !JSON.stringify(listing.json).includes(rawTicket));
    // A ticket for an already-published draft answers 409.
    const tk3 = await mintTicket({ kind: 'image', text: 'publish first' });
    await mcp(R2, 'tools/call', { name: 'publish_message', arguments: { id: tk3.message_id } }, { token: TP });
    r = await putTicket(tk3.upload.url, PNG);
    check('ticket whose draft got published -> 409', r.status === 409, r.status);
    // An expired ticket answers 410 (TTL shortened through the test hook).
    await req('POST', '/api/test-hooks/ticket-ttl', { owner: true, json: { room: room2Name, ttl_ms: 1 } });
    const tk4 = await mintTicket();
    await new Promise(res => setTimeout(res, 30));
    r = await putTicket(tk4.upload.url, PNG);
    check('expired ticket -> 410', r.status === 410, r.status);
    await req('POST', '/api/test-hooks/ticket-ttl', { owner: true, json: { room: room2Name, ttl_ms: 0 } });
    // A storage outage answers 503 and does not spend the ticket.
    const tk5 = await mintTicket();
    await req('POST', '/api/test-hooks/r2-fail', { owner: true, json: { room: room2Name, on: true } });
    r = await putTicket(tk5.upload.url, PNG);
    check('ticket PUT during outage -> 503', r.status === 503, r.status);
    await req('POST', '/api/test-hooks/r2-fail', { owner: true, json: { room: room2Name, on: false } });
    r = await putTicket(tk5.upload.url, PNG);
    check('the same ticket retries fine after the outage', r.status === 200, r.status);
    // A ticket dies with its member's invite.
    const invRev = await req('POST', R2 + '/invites', { owner: true, json: { name: 'TickRev', kind: 'agent' } });
    const TRev = invRev.json.token;
    r = await mcp(R2, 'tools/call', { name: 'begin_upload', arguments: { kind: 'image', text: 'revoked member upload' } }, { token: TRev });
    const tk6 = r.json && r.json.result && r.json.result.structuredContent;
    check('second member can mint a ticket', !!tk6 && !!tk6.upload, JSON.stringify(r.json).slice(0, 160));
    // ...and stays dead when the name is invited again: a link is a
    // credential by itself, checked against the name, so one that outlived
    // the revoke worked for whoever had kept it once the name came back.
    r = await mcp(R2, 'tools/call', { name: 'begin_upload', arguments: { kind: 'file', name: 'kept.bin', size: 5, text: 'kept link', publish_on_complete: true } }, { token: TRev });
    const tk6s = r.json && r.json.result && r.json.result.structuredContent;
    check('the member can open a resumable link too', !!tk6s && !!tk6s.upload && !!tk6s.upload.finish, JSON.stringify(r.json).slice(0, 200));
    const linkStep = (u, method, body) => fetch(BASE + new URL(u).pathname + new URL(u).search, { method, body });
    await req('DELETE', R2 + '/invites/' + TRev, { owner: true });
    r = await putTicket(tk6.upload.url, PNG);
    check('ticket of a revoked member -> 404, as if it never was', r.status === 404, r.status);
    const invRev2 = await req('POST', R2 + '/invites', { owner: true, json: { name: 'TickRev', kind: 'agent' } });
    check('the name can be invited again', invRev2.status === 201 && invRev2.json.token !== TRev, invRev2.status);
    r = await putTicket(tk6.upload.url, PNG);
    check('the old ticket stays dead after the name is re-invited', r.status === 404, r.status);
    if (tk6s && tk6s.upload) {
      const part = await linkStep(tk6s.upload.part.url.replace('{n}', '1'), 'PUT', Buffer.from('hello'));
      const fin = await linkStep(tk6s.upload.finish.url, 'POST');
      check('the old resumable link stays dead too: nothing uploads or publishes', part.status === 404 && fin.status === 404, part.status + ' ' + fin.status);
    }
    await req('DELETE', R2 + '/invites/' + invRev2.json.token, { owner: true });

    // A request whose body is held back while its invite is revoked does
    // nothing when the body arrives. The owner revokes the invite and
    // gives the name to someone else in between. (A member's body is read
    // whole before the route checks the invite; the Room's own checks at
    // the write stand behind that.)
    const parkAcross = async (name, path, bodyText, room) => {
      const at = room || R2;
      const first = (await req('POST', at + '/invites', { owner: true, json: { name: name, kind: 'agent' } })).json.token;
      const held = parkedPost(path(first).url, first, bodyText);
      await sleep(300);
      await req('DELETE', at + '/invites/' + first, { owner: true });
      const second = (await req('POST', at + '/invites', { owner: true, json: { name: name, kind: 'agent' } })).json.token;
      return { answer: await held.send(), second: second };
    };
    // the draft is written with the owner key, so the invite stays unopened
    const draftFor = async (name) => (await req('POST', R2 + '/messages', { owner: true, json: { from: name, text: 'a draft for ' + name, draft: true } })).json.id;
    const parkDraft = await draftFor('ParkLink');
    let pk = await parkAcross('ParkLink', () => ({ url: R2 + '/messages/' + parkDraft + '/upload-ticket' }), JSON.stringify({ kind: 'image' }));
    check('a link asked for across a revoke is refused when its body arrives: no link for the old holder', pk.answer.status === 403 && pk.answer.json.code === 'invite_revoked' && !pk.answer.json.upload, pk.answer.status + ' ' + pk.answer.text.slice(0, 160));
    await req('DELETE', R2 + '/invites/' + pk.second, { owner: true });
    const parkDraft2 = await draftFor('ParkSess');
    pk = await parkAcross('ParkSess', () => ({ url: R2 + '/messages/' + parkDraft2 + '/upload-ticket' }), JSON.stringify({ kind: 'file', name: 'held.bin', size: 5 }));
    check('the same for a resumable link', pk.answer.status === 403 && pk.answer.json.code === 'invite_revoked', pk.answer.status + ' ' + pk.answer.text.slice(0, 160));
    await req('DELETE', R2 + '/invites/' + pk.second, { owner: true });
    const parkEp = 'https://fcm.googleapis.com/fcm/send/parked-' + SUF;
    const parkSub = { subscription: { endpoint: parkEp, keys: { p256dh: Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 7)]).toString('base64url'), auth: Buffer.alloc(16, 9).toString('base64url') } }, mode: 'all' };
    pk = await parkAcross('ParkPush', () => ({ url: R2 + '/push/subscribe' }), JSON.stringify(parkSub));
    check('a push registration asked for across a revoke is refused', pk.answer.status === 403 && pk.answer.json.code === 'invite_revoked', pk.answer.status + ' ' + pk.answer.text.slice(0, 160));
    r = await req('GET', R2 + '/push/status?endpoint=' + encodeURIComponent(parkEp), { token: pk.second });
    check('...so the name\'s next holder starts with no registrations', r.status === 200 && r.json.count === 0 && r.json.registered === false, r.text.slice(0, 160));
    r = await req('POST', R2 + '/push/subscribe', { token: pk.second, json: parkSub });
    check('a member in good standing still subscribes', r.status === 200 && r.json.subscribed === true, r.status + ' ' + r.text.slice(0, 120));
    await req('DELETE', R2 + '/invites/' + pk.second, { owner: true });

    // The same for anything a member can do: a post, and the one that
    // matters most, a new invite made on the way out of "revoke everyone".
    const parkRoom = '/api/rooms/apitest-park-' + SUF;
    await req('POST', parkRoom, { owner: true });
    pk = await parkAcross('Poster', () => ({ url: parkRoom + '/messages' }), JSON.stringify({ text: 'posted by a parked request ' + SUF }), parkRoom);
    check('a post held back across a revoke and a re-invite -> 403', pk.answer.status === 403 && pk.answer.json.code === 'invite_revoked', pk.answer.status + ' ' + pk.answer.text.slice(0, 160));
    r = await req('GET', parkRoom + '/messages?after=0&limit=50', { owner: true });
    check('...and nothing was posted under the name', r.status === 200 && !r.text.includes('posted by a parked request'), r.text.slice(0, 200));
    const slowPost = parkedPost(parkRoom + '/messages', pk.second, JSON.stringify({ text: 'a slow but honest post ' + SUF }));
    await sleep(300);
    r = await slowPost.send();
    check('a member whose body is merely slow still posts', r.status === 201 || r.status === 200, r.status + ' ' + r.text.slice(0, 120));
    const sneak = parkedPost(parkRoom + '/invites', pk.second, JSON.stringify({ name: 'Sneak', kind: 'agent' }));
    await sleep(300);
    r = await req('DELETE', parkRoom + '/invites', { owner: true });
    check('everyone is revoked while an invite request waits', r.status === 200, r.status);
    r = await sneak.send();
    check('an invite asked for across "revoke everyone" -> 403, no new invite', r.status === 403 && !r.json.token, r.status + ' ' + r.text.slice(0, 160));
    r = await req('GET', parkRoom + '/invites', { owner: true });
    check('...and the room has no active invite', r.status === 200 && (r.json.invites || []).filter((i) => !i.revoked).length === 0, r.text.slice(0, 200));
    // a member's body over the limit is refused, not held in memory (the
    // dev server answers only once the client has finished sending)
    r = await req('POST', R2 + '/messages', { token: TP, headers: { 'Content-Type': 'application/json' }, body: Buffer.alloc(49 * 1048576, 0x20) });
    check('a member body over the limit -> 413', r.status === 413, r.status + ' ' + r.text.slice(0, 120));
    // The documented reading loop (read after=LAST_ID, keep last_id) gets
    // every message, however many arrived: a full page says has_more and
    // hands back its own last id, not the room's newest.
    const pageTok = (await req('POST', parkRoom + '/invites', { owner: true, json: { name: 'Pager', kind: 'agent' } })).json.token;
    let cursor = (await req('GET', parkRoom + '/messages', { token: pageTok })).json.last_id;
    for (let i = 0; i < 60; i++) await req('POST', parkRoom + '/messages', { owner: true, json: { from: 'Owner', text: 'backlog ' + i } });
    const got = [];
    let pages = 0, sawMore = false;
    for (;;) {
      r = await req('GET', parkRoom + '/messages?after=' + cursor, { token: pageTok });
      pages++;
      for (const m of r.json.messages) got.push(m.text);
      cursor = r.json.last_id;
      if (r.json.has_more) sawMore = true;
      if (!r.json.has_more || pages > 5) break;
    }
    check('reading after=last_id until has_more is false gets all 60 messages, once each', got.length === 60 && new Set(got).size === 60 && got[0] === 'backlog 0' && got[59] === 'backlog 59' && sawMore && pages === 2, got.length + ' in ' + pages + ' pages');
    r = await mcp(parkRoom, 'tools/call', { name: 'list_messages', arguments: { after: 0, limit: 10 } }, { token: pageTok });
    const lm = r.json && r.json.result && r.json.result.structuredContent;
    check('MCP list_messages pages the same way', !!lm && lm.has_more === true && lm.messages.length === 10 && lm.last_id === lm.messages[9].id, JSON.stringify(lm && { more: lm.has_more, last: lm.last_id }));
    r = await req('GET', parkRoom + '/messages', { token: pageTok });
    check('the latest page carries has_more false and the newest id', r.json.has_more === false && r.json.last_id === r.json.messages[r.json.messages.length - 1].id, JSON.stringify({ more: r.json.has_more, last: r.json.last_id }));
    await req('DELETE', parkRoom + '/invites/' + pageTok, { owner: true });
    r = await req('DELETE', parkRoom + '?confirm=apitest-park-' + SUF, { owner: true });
    check('the throwaway room is deleted', r.status === 200, r.status + ' ' + r.text.slice(0, 120));

    // Streams opened while their invite is being revoked: every one either
    // is refused or is closed; none goes on receiving the room.
    const raceTok = (await req('POST', R2 + '/invites', { owner: true, json: { name: 'RaceStream', kind: 'agent' } })).json.token;
    await req('GET', R2 + '/me', { token: raceTok });
    const raced = [];
    const openRaced = async () => {
      const ac = new AbortController();
      const rec = { status: 0, text: '', ended: false, stop: () => ac.abort() };
      raced.push(rec);
      try {
        const res = await fetch(BASE + R2 + '/stream?after=latest', { headers: { 'X-Invite-Token': raceTok }, signal: ac.signal });
        rec.status = res.status;
        if (res.status !== 200) { rec.ended = true; await res.text(); return; }
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        for (;;) { const c = await reader.read(); if (c.done) break; rec.text += dec.decode(c.value, { stream: true }); }
        rec.ended = true;
      } catch { rec.ended = true; }
    };
    const racing = [];
    for (let i = 0; i < 12; i++) racing.push(openRaced());
    const revoking = req('DELETE', R2 + '/invites/' + raceTok, { owner: true });
    for (let i = 0; i < 12; i++) racing.push(openRaced());
    await revoking;
    const afterRevoke = 'posted after the revoke ' + SUF;
    await sleep(300);
    await req('POST', R2 + '/messages', { owner: true, json: { from: 'Owner', text: afterRevoke } });
    await sleep(700);
    const stillOpen = raced.filter((one) => !one.ended).length;
    const leaked = raced.filter((one) => one.text.includes(afterRevoke)).length;
    for (const one of raced) one.stop();
    await Promise.all(racing);
    check('streams opened around a revoke: all refused or closed', stillOpen === 0, stillOpen + ' of ' + raced.length + ' still open; statuses ' + raced.map((one) => one.status).join(','));
    check('...and none receives what is posted afterwards', leaked === 0, leaked + ' leaked');

    // A long poll waiting when its invite is revoked answers with the refusal, not the next message.
    const pollTok = (await req('POST', R2 + '/invites', { owner: true, json: { name: 'RacePoll', kind: 'agent' } })).json.token;
    const lastNow = (await req('GET', R2 + '/messages?limit=1', { token: pollTok })).json.last_id;
    const polling = req('GET', R2 + '/messages?after=' + lastNow + '&wait=10', { token: pollTok });
    await sleep(400);
    await req('DELETE', R2 + '/invites/' + pollTok, { owner: true });
    await req('POST', R2 + '/messages', { owner: true, json: { from: 'Owner', text: 'after the poller left ' + SUF } });
    r = await polling;
    check('a long poll across a revoke -> 403, without the later message', r.status === 403 && r.json.code === 'invite_revoked' && !r.text.includes('after the poller left'), r.status + ' ' + r.text.slice(0, 160));

    // Two invites never end up under one name (one name is one seat in
    // every match). The cut at 40 goes between characters, a name with
    // half a character is refused, letters that lower-case alike count as
    // the same name, and spacing does not make a new one.
    const cutName = 'N'.repeat(39) + '\u{1F600}';
    r = await req('POST', R2 + '/invites', { owner: true, json: { name: cutName, kind: 'human' } });
    check('a name cut at an emoji keeps whole characters', r.status === 201 && r.json.name === 'N'.repeat(39), r.status + ' ' + JSON.stringify(r.json && r.json.name));
    const cutTok = r.json.token;
    r = await req('POST', R2 + '/invites', { owner: true, json: { name: cutName, kind: 'agent' } });
    check('...so the same typed name is taken', r.status === 409 && r.json.code === 'name_taken', r.status + ' ' + r.text.slice(0, 120));
    r = await req('GET', R2 + '/members', { owner: true });
    check('...and one member holds it', (r.json.members || []).filter((m) => m.status !== 'revoked' && m.name.startsWith('N'.repeat(39))).length === 1 && !/\uFFFD/.test(r.text), r.text.slice(0, 200));
    await req('DELETE', R2 + '/invites/' + cutTok, { owner: true });
    r = await fetch(BASE + R2 + '/invites', { method: 'POST', headers: { 'X-Owner-Key': OWNER, 'Content-Type': 'application/json' }, body: '{"name":"half\\ud83d","kind":"agent"}' });
    check('a name with half a character -> 400', r.status === 400, r.status);
    await r.text();
    r = await req('POST', R2 + '/invites', { owner: true, json: { name: '\u03F9arol', kind: 'agent' } });
    const sigmaTok = r.json && r.json.token;
    check('a name with a lunate sigma is fine', r.status === 201, r.status);
    r = await req('POST', R2 + '/invites', { owner: true, json: { name: '\u03F2arol', kind: 'agent' } });
    check('...its other-case spelling is the same name', r.status === 409 && r.json.code === 'name_taken', r.status + ' ' + r.text.slice(0, 120));
    await req('DELETE', R2 + '/invites/' + sigmaTok, { owner: true });
    r = await req('POST', R2 + '/invites', { owner: true, json: { name: 'Spacy  \u00A0 Name', kind: 'agent' } });
    const spacyTok = r.json && r.json.token;
    check('whitespace in a name is stored as single spaces', r.status === 201 && r.json.name === 'Spacy Name', r.status + ' ' + JSON.stringify(r.json && r.json.name));
    r = await req('POST', R2 + '/invites', { owner: true, json: { name: 'Spacy Name', kind: 'agent' } });
    check('...so the single-spaced spelling is taken', r.status === 409, r.status);
    await req('DELETE', R2 + '/invites/' + spacyTok, { owner: true });

    // begin_upload without text mints an empty container draft: publishing it
    // bare is refused; a caption at publish time completes it.
    r = await mcp(R2, 'tools/call', { name: 'begin_upload', arguments: { kind: 'image' } }, { token: TP });
    const upE = r.json && r.json.result && r.json.result.structuredContent;
    r = await mcp(R2, 'tools/call', { name: 'publish_message', arguments: { id: upE.message_id } }, { token: TP });
    check('empty draft cannot publish', !!(r.json && r.json.result && r.json.result.isError), JSON.stringify(r.json).slice(0, 200));
    r = await mcp(R2, 'tools/call', { name: 'publish_message', arguments: { id: upE.message_id, text: 'captioned at publish' } }, { token: TP });
    check('publish with a caption completes the empty draft', !!(r.json && r.json.result && !r.json.result.isError), JSON.stringify(r.json).slice(0, 200));

    // The upload engine: one resumable flow for every kind, general files
    // included. A fresh member keeps these clear of Poc's open-link cap.
    const invU = await req('POST', R2 + '/invites', { owner: true, json: { name: 'Upl', kind: 'human' } });
    const TU = invU.json.token;
    const MiB = 1048576;
    const BIG = Buffer.alloc(17 * MiB + 12345);
    for (let i = 0; i < BIG.length; i += 997) BIG[i] = (i * 31) & 255;
    const sha = (b) => require('crypto').createHash('sha256').update(b).digest('hex');
    const fdr = await req('POST', R2 + '/messages', { token: TU, json: { text: 'a big file', draft: true } });
    const fid = fdr.json && fdr.json.id;
    const FP = 'fp-' + SUF;
    const startArgs = { size: BIG.length, name: 'résumé data.bin', type: 'application/x-probe', fingerprint: FP };
    r = await req('POST', R2 + '/messages/' + fid + '/file/start', { token: TU, json: startArgs });
    check('file upload start pins a plan', r.status === 200 && r.json.part_size === 8 * MiB && r.json.parts === 3 && r.json.resumed === false && !!r.json.expires_at, JSON.stringify(r.json));
    const PS = (r.json && r.json.part_size) || 8 * MiB;
    const slice = (n) => BIG.subarray((n - 1) * PS, Math.min(BIG.length, n * PS));
    const putPart = (n, body, token) => req('PUT', R2 + '/messages/' + fid + '/file/part?n=' + n, { token: token || TU, body });
    r = await putPart(2, slice(2).subarray(1));
    check('a part of the wrong length -> 400 naming the length', r.status === 400 && r.json && r.json.expected_bytes === PS, r.status + ' ' + r.text.slice(0, 160));
    r = await putPart(4, slice(3));
    check('a part number past the plan -> 400', r.status === 400, r.status);
    r = await putPart(3, slice(3));
    check('the last part (the remainder) lands', r.status === 200 && r.json && r.json.part === 3, r.status + ' ' + r.text.slice(0, 120));
    r = await putPart(1, slice(1));
    check('parts land in any order', r.status === 200, r.status);
    r = await putPart(1, slice(1), TP);
    check('another member cannot send parts -> 403', r.status === 403, r.status);
    r = await req('POST', R2 + '/messages/' + fid + '/file/finish', { token: TU });
    check('finish with a part missing -> 409 naming it', r.status === 409 && JSON.stringify(r.json && r.json.missing) === '[2]', r.status + ' ' + r.text.slice(0, 160));
    r = await req('GET', R2 + '/messages/' + fid + '/file/status', { token: TU });
    check('status lists the parts received', !!(r.json && r.json.uploading === true && JSON.stringify(r.json.received) === '[1,3]' && r.json.parts === 3 && r.json.name === 'résumé data.bin'), JSON.stringify(r.json));
    r = await req('GET', R2 + '/messages/' + fid + '/file/status', { token: TP });
    check('status shows nothing to another member', !!(r.json && r.json.uploading === false && r.json.received.length === 0), JSON.stringify(r.json));
    r = await req('POST', R2 + '/upload/resume', { token: TU, json: { size: BIG.length, fingerprint: FP } });
    check('resume lookup finds the draft and its parts', !!(r.json && r.json.found && r.json.id === fid && r.json.kind === 'file' && JSON.stringify(r.json.received) === '[1,3]'), JSON.stringify(r.json));
    r = await req('POST', R2 + '/upload/resume', { token: TP, json: { size: BIG.length, fingerprint: FP } });
    check('resume lookup is per member', !!(r.json && r.json.found === false), JSON.stringify(r.json));
    r = await req('POST', R2 + '/messages/' + fid + '/file/start', { token: TU, json: startArgs });
    check('start again resumes with the parts kept', !!(r.json && r.json.resumed === true && JSON.stringify(r.json.received) === '[1,3]'), JSON.stringify(r.json));
    r = await putPart(2, slice(2));
    check('the missing part lands', r.status === 200, r.status);
    // Two finishes at once (a client retrying while the first runs) both
    // answer the upload's result; storage is held open so they overlap.
    await req('POST', '/api/test-hooks/r2-delay', { owner: true, json: { room: R2.slice('/api/rooms/'.length), ms: 600 } });
    const fin1 = req('POST', R2 + '/messages/' + fid + '/file/finish', { token: TU });
    await new Promise((res) => setTimeout(res, 150));
    const fin2 = req('POST', R2 + '/messages/' + fid + '/file/finish', { token: TU });
    r = await fin1;
    const r2nd = await fin2;
    await req('POST', '/api/test-hooks/r2-delay', { owner: true, json: { room: R2.slice('/api/rooms/'.length), ms: 0 } });
    check('finish assembles and attaches the file', r.status === 200 && !!(r.json && r.json.file && r.json.file.bytes === BIG.length && r.json.file.name === 'résumé data.bin' && /sig=/.test(r.json.file.url) && r.json.published === false), r.status + ' ' + r.text.slice(0, 200));
    check('a finish sent again while the first runs gets the same answer', r2nd.status === 200 && !!(r2nd.json && r.json && r2nd.json.file && r2nd.json.file.url === r.json.file.url && r2nd.json.file.bytes === BIG.length), r2nd.status + ' ' + r2nd.text.slice(0, 200));
    const r3rd = await req('POST', R2 + '/messages/' + fid + '/file/finish', { token: TU });
    check('a finish sent again after it ended answers 200 with the same url', r3rd.status === 200 && !!(r3rd.json && r.json && r3rd.json.file && r3rd.json.file.url === r.json.file.url && r3rd.json.file.name === 'résumé data.bin' && r3rd.json.published === false), r3rd.status + ' ' + r3rd.text.slice(0, 200));
    r = await req('GET', R2 + '/messages/' + fid + '/file', { token: TP });
    check('a draft file stays private before publish', r.status === 404, r.status);
    r = await req('POST', R2 + '/messages/' + fid + '/publish', { token: TU, json: {} });
    check('publish the file draft', r.status === 200 && !!(r.json && r.json.file && r.json.file.name === 'résumé data.bin'), r.status + ' ' + r.text.slice(0, 160));
    r = await req('GET', R2 + '/messages?limit=20', { token: TP });
    const fmsg = ((r.json && r.json.messages) || []).find(x => x.id === fid);
    check('listings carry the file', !!(fmsg && fmsg.file && fmsg.file.bytes === BIG.length && fmsg.file.type === 'application/x-probe' && /sig=/.test(fmsg.file.url)), JSON.stringify(fmsg && fmsg.file));
    const fURL = BASE + new URL(fmsg.file.url, BASE).pathname + new URL(fmsg.file.url, BASE).search;
    let ff = await fetch(fURL);
    const fbuf = Buffer.from(await ff.arrayBuffer());
    check('the file downloads with a signed url, byte for byte', ff.status === 200 && fbuf.length === BIG.length && sha(fbuf) === sha(BIG), ff.status + ' ' + fbuf.length);
    const cd = ff.headers.get('content-disposition') || '';
    check('a file is served only as a download', ff.headers.get('content-type') === 'application/octet-stream' && cd.startsWith('attachment;') && cd.includes("filename*=UTF-8''r%C3%A9sum%C3%A9%20data.bin") && ff.headers.get('x-content-type-options') === 'nosniff' && (ff.headers.get('content-security-policy') || '').includes('sandbox'), ff.headers.get('content-type') + ' | ' + cd);
    ff = await fetch(fURL, { headers: { Range: 'bytes=' + (PS - 8) + '-' + (PS + 7) } });
    const rbuf = Buffer.from(await ff.arrayBuffer());
    check('a file download honours Range across a part boundary', ff.status === 206 && rbuf.equals(BIG.subarray(PS - 8, PS + 8)), ff.status + ' ' + rbuf.length);
    r = await req('PUT', R2 + '/messages/' + fid + '/file', { token: TU, body: PNG });
    check('PUT on a file explains the parts flow -> 405', r.status === 405 && /file\/start/.test(r.text), r.status + ' ' + r.text.slice(0, 120));
    r = await req('GET', R2 + '/attachments?kind=file', { token: TP });
    check('attachments list files with their names', !!(r.json && (r.json.attachments || []).some(a => a.id === fid && a.kind === 'file' && a.name === 'résumé data.bin') && r.json.counts && r.json.counts.file === 1), JSON.stringify(r.json).slice(0, 200));
    // Typed kinds through the engine: part 1 is checked against the kind.
    const idr = await req('POST', R2 + '/messages', { token: TU, json: { text: 'engine image', draft: true } });
    r = await req('POST', R2 + '/messages/' + idr.json.id + '/image/start', { token: TU, json: { size: 9 * MiB } });
    r = await req('PUT', R2 + '/messages/' + idr.json.id + '/image/part?n=1', { token: TU, body: Buffer.alloc(8 * MiB, 3) });
    check('an image upload whose first bytes are not an image -> 415 at part 1', r.status === 415, r.status + ' ' + r.text.slice(0, 120));
    r = await req('GET', R2 + '/messages/' + idr.json.id + '/image/status', { token: TU });
    check('a refused part leaves no receipt', !!(r.json && r.json.uploading === true && r.json.received.length === 0), JSON.stringify(r.json));
    r = await req('POST', R2 + '/messages/' + idr.json.id + '/image/start', { token: TU, json: { size: PNG.length } });
    check('a new size restarts the session', !!(r.json && r.json.resumed === false && r.json.parts === 1), JSON.stringify(r.json));
    r = await req('PUT', R2 + '/messages/' + idr.json.id + '/image/part?n=1', { token: TU, body: PNG });
    r = await req('POST', R2 + '/messages/' + idr.json.id + '/image/finish', { token: TU });
    check('a one-part image finishes as an image', r.status === 200 && !!(r.json && r.json.image && r.json.image.type === 'image/png'), r.status + ' ' + r.text.slice(0, 160));
    // The first chunked flow's addresses are the engine's (kind video), and
    // publish_on_complete fires on finish.
    const vdr = await req('POST', R2 + '/messages', { token: TU, json: { text: 'engine video', draft: true, publish_on_complete: true } });
    r = await req('POST', R2 + '/messages/' + vdr.json.id + '/video/start', { token: TU, json: { type: 'video/mp4', size: mp4().length } });
    r = await req('PUT', R2 + '/messages/' + vdr.json.id + '/video/part?n=1', { token: TU, body: mp4() });
    r = await req('POST', R2 + '/messages/' + vdr.json.id + '/video/finish', { token: TU });
    check('/video/start-part-finish is the engine, publishing on complete', r.status === 200 && !!(r.json && r.json.video && r.json.video.type === 'video/mp4' && r.json.published === true), r.status + ' ' + r.text.slice(0, 160));
    // Abort cancels the session and its parts.
    const adr = await req('POST', R2 + '/messages', { token: TU, json: { text: 'aborted audio', draft: true } });
    await req('POST', R2 + '/messages/' + adr.json.id + '/audio/start', { token: TU, json: { size: 20 * MiB } });
    r = await req('POST', R2 + '/messages/' + adr.json.id + '/audio/abort', { token: TU });
    check('abort cancels an upload', r.status === 200 && !!(r.json && r.json.aborted === true), r.status);
    r = await req('GET', R2 + '/messages/' + adr.json.id + '/audio/status', { token: TU });
    check('nothing is left after abort', !!(r.json && r.json.uploading === false), JSON.stringify(r.json));
    // Agents: begin_upload with a size opens a resumable link set that needs
    // no credential; a file needs a size.
    r = await mcp(R2, 'tools/call', { name: 'begin_upload', arguments: { kind: 'file', name: 'notes.txt' } }, { token: TU });
    check('begin_upload of a file without size is a tool error', !!(r.json && r.json.result && r.json.result.isError), JSON.stringify(r.json).slice(0, 200));
    const NOTE = Buffer.from('agent notes, any type at all\n'.repeat(40));
    r = await mcp(R2, 'tools/call', { name: 'begin_upload', arguments: { kind: 'file', size: NOTE.length, name: 'notes.txt', type: 'text/plain', text: 'agent file', publish_on_complete: true } }, { token: TU });
    const sup = r.json && r.json.result && r.json.result.structuredContent;
    check('begin_upload with a size returns a resumable link set', !!(sup && sup.upload && sup.upload.mode === 'resumable' && sup.upload.parts === 1 && /\/part\?n=\{n\}$/.test(sup.upload.part.url) && String(sup.upload.auth).includes('credential') && !JSON.stringify(sup).includes(TU)), JSON.stringify(r.json).slice(0, 240));
    const linkPath = (u) => new URL(u).pathname + new URL(u).search;
    r = await req('PUT', linkPath(sup.upload.part.url.replace('{n}', '1')), { body: NOTE });
    check('a link part lands with no credential', r.status === 200, r.status + ' ' + r.text.slice(0, 120));
    r = await req('GET', linkPath(sup.upload.status.url), {});
    check('a link status lists the part', !!(r.json && JSON.stringify(r.json.received) === '[1]'), JSON.stringify(r.json));
    r = await req('PUT', new URL(sup.upload.part.url).pathname.replace(/\/part$/, ''), { body: NOTE });
    check('a resumable link is not a single-shot link -> 405', r.status === 405, r.status);
    r = await req('POST', linkPath(sup.upload.finish.url), {});
    check('a link finish attaches and auto-publishes', r.status === 200 && !!(r.json && r.json.file && r.json.file.name === 'notes.txt' && r.json.published === true), r.status + ' ' + r.text.slice(0, 160));
    r = await req('PUT', '/api/uploads/' + room2Name + '/' + 'B'.repeat(43) + '/part?n=1', { body: NOTE });
    check('a garbled link -> 404', r.status === 404, r.status);
    // A size makes every kind resumable, small media too: a script written
    // for upload.part.url once broke on a small image, which got the
    // single-shot shape however it asked.
    r = await mcp(R2, 'tools/call', { name: 'begin_upload', arguments: { kind: 'image', size: PNG.length, text: 'small image, resumable', direct: true } }, { token: TU });
    const sim = r.json && r.json.result && r.json.result.structuredContent;
    check('begin_upload of a small image with a size is resumable', !!(sim && sim.upload && sim.upload.mode === 'resumable' && sim.upload.parts === 1 && sim.upload.part && sim.upload.finish && sim.upload.direct === false && sim.upload.method === undefined), JSON.stringify(r.json).slice(0, 240));
    r = await req('PUT', linkPath(sim.upload.part.url.replace('{n}', '1')), { body: PNG });
    check('the small image part lands', r.status === 200, r.status + ' ' + r.text.slice(0, 120));
    r = await req('POST', linkPath(sim.upload.finish.url), {});
    check('the small image link finishes with the image', r.status === 200 && !!(r.json && r.json.image && r.json.image.type === 'image/png'), r.status + ' ' + r.text.slice(0, 160));
    const tkd = await req('POST', R2 + '/messages', { token: TU, json: { text: 'small clip via ticket', draft: true } });
    r = await req('POST', R2 + '/messages/' + tkd.json.id + '/upload-ticket', { token: TU, json: { kind: 'audio', size: 50000 } });
    check('upload-ticket with a size for small audio is resumable', r.status === 200 && !!(r.json && r.json.upload && r.json.upload.mode === 'resumable' && r.json.upload.parts === 1 && r.json.upload.part && r.json.upload.finish), r.status + ' ' + r.text.slice(0, 200));
    await req('POST', linkPath(r.json.upload.abort.url), {});
    r = await req('POST', R2 + '/messages/' + tkd.json.id + '/upload-ticket', { token: TU, json: { kind: 'audio' } });
    check('upload-ticket without a size stays single-shot', r.status === 200 && !!(r.json && r.json.upload && r.json.upload.method === 'PUT' && r.json.upload.single_use === true && !r.json.upload.part), r.status + ' ' + r.text.slice(0, 200));
    // Direct uploads. The signer must match AWS's published SigV4
    // presigned-URL example (its documented, non-secret example keys).
    r = await req('POST', '/api/test-hooks/sigv4', { owner: true, json: { method: 'GET', host: 'examplebucket.s3.amazonaws.com', path: '/test.txt', query: {}, accessKey: 'AKIAIOSFODNN7EXAMPLE', secretKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', region: 'us-east-1', expires: 86400, date: '2013-05-24T00:00:00Z' } });
    check('sigv4 presign matches the AWS example signature', !!(r.json && /X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404$/.test(r.json.url) && r.json.url.includes('X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request')), JSON.stringify(r.json).slice(0, 200));
    // Without the R2 credential (as in dev), asking for direct falls back to
    // parts through the site, and /sign says so.
    const ddr = await req('POST', R2 + '/messages', { token: TU, json: { text: 'direct probe', draft: true } });
    r = await req('POST', R2 + '/messages/' + ddr.json.id + '/file/start', { token: TU, json: { size: 9 * MiB, name: 'd.bin', direct: true } });
    check('direct asked without the credential -> parts through the site', r.status === 200 && !!r.json && r.json.direct === false && r.json.part_size === 8 * MiB, JSON.stringify(r.json));
    r = await req('POST', R2 + '/messages/' + ddr.json.id + '/file/sign', { token: TU, json: { parts: [1] } });
    check('sign on a through-the-site upload -> 409', r.status === 409, r.status + ' ' + r.text.slice(0, 120));
    r = await req('GET', R2 + '/messages/' + ddr.json.id + '/file/status', { token: TU });
    check('status says the route', !!(r.json && r.json.uploading === true && r.json.direct === false), JSON.stringify(r.json));
    await req('POST', R2 + '/messages/' + ddr.json.id + '/file/abort', { token: TU });
    r = await req('POST', R2 + '/messages/' + ddr.json.id + '/file/start', { token: TU, json: { size: 1e12 } });
    check('past the through-the-site ceiling -> 413', r.status === 413 && /943 GB/.test(r.text), r.status + ' ' + r.text.slice(0, 160));
    // Digest edits need an identity, like every sibling MCP write.
    r = await mcp(R2, 'tools/call', { name: 'file_digest', arguments: { text: 'A digest filed for the identity check.' } }, { token: TP });
    const dg = r.json && r.json.result && r.json.result.structuredContent && r.json.result.structuredContent.digest;
    r = await mcp(R2, 'tools/call', { name: 'edit_digest', arguments: { id: dg.id, text: 'edited anonymously' } }, { owner: true });
    check('mcp edit_digest without an identity is refused', !!(r.json && r.json.result && r.json.result.isError), JSON.stringify(r.json).slice(0, 200));
    r = await mcp(R2, 'tools/call', { name: 'edit_digest', arguments: { id: dg.id, text: 'edited with an identity' } }, { token: TP });
    check('mcp edit_digest as a named member works', !!(r.json && r.json.result && !r.json.result.isError), JSON.stringify(r.json).slice(0, 200));

    // Games list: every live match ahead of the finished tail, and
    // no battleship boards in list payloads.
    r = await req('POST', R2 + '/games', { token: TP, json: { game: 'duel', from: 'Poc', players: ['Poc', 'Rex'], best_of: 3, tick_seconds: 3600 } });
    const liveId = r.json && r.json.game && r.json.game.id;
    r = await req('GET', R2 + '/games', { token: TP });
    const gl = (r.json && r.json.games) || [];
    const liveIdx = gl.findIndex((g) => g.id === liveId);
    const firstDone = gl.findIndex((g) => g.status === 'finished' || g.status === 'cancelled');
    check('games list: the live match is listed', liveIdx >= 0, JSON.stringify(gl.map((g) => g.id + ':' + g.status)));
    check('games list: live matches come before finished ones', firstDone === -1 || liveIdx < firstDone, 'live at ' + liveIdx + ', first finished at ' + firstDone);
    check('games list: no boards in list payloads', gl.every((g) => !('boards' in g)));
    check('games list: entries carry when they began', gl.every((g) => typeof g.created === 'number' && g.created > 0), JSON.stringify(gl.map((g) => g.id + ':' + g.created)));
    check('games list: ended matches carry when they ended, live ones none', gl.every((g) => (g.status === 'finished' || g.status === 'cancelled') ? typeof g.ended === 'number' && g.ended >= g.created : g.ended === null), JSON.stringify(gl.map((g) => g.id + ':' + g.status + ':' + g.ended)));
    check('games list: entries carry collapsed targets', gl.every((g) => Array.isArray(g.targets)) && JSON.stringify((gl[liveIdx] || {}).targets) === '["Rex"]', JSON.stringify(gl.map((g) => g.id + ':' + JSON.stringify(g.targets))));
    const rec = (r.json && r.json.record) || {};
    const recDuel = rec.duel || [];
    check('games list: record carries duel standings', recDuel.length >= 1 && recDuel.every((p) => typeof p.w === 'number' && typeof p.l === 'number'), JSON.stringify(rec).slice(0, 200));
    check('games list: record sorted by wins, wins were recorded', recDuel.every((p, i) => i === 0 || recDuel[i - 1].w >= p.w) && recDuel.reduce((a, p) => a + p.w, 0) >= 1, JSON.stringify(recDuel));

    // Late checks for the clock-driven matches set up earlier (the
    // unthrown-round-1 duel, the double-abandon battleship, the silent
    // free-for-all): run each one's clock out with the test hook, one
    // expired turn per try, until it ends. These run BEFORE the room
    // destruction below: after it, every poll would 404.
    async function pollGame(id, pred, tries) {
      let g = null;
      for (let i = 0; i < tries; i++) {
        const rr = await req('GET', R2 + '/games/' + id, { token: TP });
        if (rr.json && rr.json.game) g = rr.json.game;
        if (g && pred(g)) return g;
        await expireGame(id);
      }
      return g;
    }
    const r1Final = await pollGame(duelR1, g => g.status !== 'running', 8);
    check('an unthrown round 1 calls the duel off (no phantom 0-0)', !!r1Final && r1Final.status === 'cancelled' && !r1Final.winner, JSON.stringify(r1Final || null).slice(0, 200));
    const abFinal = await pollGame(bsAbandon, g => g.status === 'finished', 20);
    check('both captains abandoning ends with no winner', !!abFinal && abFinal.status === 'finished' && !abFinal.winner && (abFinal.log || []).some(e => e.text.includes('abandoned the sea')), JSON.stringify(abFinal || null).slice(0, 240));
    const ffaAbFinal = await pollGame(bsFfaAbandon, g => g.status === 'finished', 30);
    check('a fully silent ffa table ends with no winner', !!ffaAbFinal && ffaAbFinal.status === 'finished' && !ffaAbFinal.winner && (ffaAbFinal.log || []).some(e => e.text.includes('abandoned the sea')), JSON.stringify(ffaAbFinal || null).slice(0, 240));

    const gameImages = async () => ((await req('POST', '/api/test-hooks/game-images', { owner: true, json: { room: roomOf2 } })).json || {}).count;
    const imgsBefore = await gameImages();
    await req('DELETE', R2 + '/invites', { owner: true });
    r = await req('DELETE', R2 + '?confirm=apitest-poc-' + SUF, { owner: true });
    check('room destroyed', r.json && r.json.deleted === true, JSON.stringify(r.json));
    const imgsAfter = await gameImages();
    check('deleting the room deletes its Sketch & Guess drawings', imgsBefore >= 2 && imgsAfter === 0, imgsBefore + ' -> ' + imgsAfter);
    r = await req('GET', R2 + '/members', { owner: true });
    check('destroyed room 404s', r.status === 404, r.status);

    // Build id: /api/build reports it, and both served pages carry the
    // same id stamped over the build's "next-dev" placeholder.
    r = await req('GET', '/api/build');
    const bid = r.json && r.json.build;
    check('build id shape', /^[0-9a-f]{16}$/.test(bid || ''), JSON.stringify(r.json));
    const homeTxt = await (await fetch(BASE + '/')).text();
    const roomTxt = await (await fetch(BASE + '/r/apitest-main-' + SUF)).text();
    const metaOf = (t) => { const mm = t.match(/<meta name="build" content="([^"]*)">/); return mm && mm[1]; };
    check('home page stamped with the build id', metaOf(homeTxt) === bid, metaOf(homeTxt));
    check('room page stamped with the build id', metaOf(roomTxt) === bid, metaOf(roomTxt));
    check('no unstamped placeholder served', !homeTxt.includes('next-dev') && !roomTxt.includes('next-dev'));
    // Static assets: the hashed bundle files come straight from the
    // build, with the one-year immutable cache the _headers file sets.
    const assetPath = (homeTxt.match(/\/assets\/index-[\w-]+\.js/) || [])[0];
    const ar = assetPath ? await fetch(BASE + assetPath) : null;
    check('the page names its bundle', !!assetPath, homeTxt.slice(0, 200));
    check('bundle served from static assets', !!ar && ar.status === 200 && /javascript/.test(ar.headers.get('content-type') || ''), ar && ar.status + ' ' + ar.headers.get('content-type'));
    check('bundle cached for a year, immutable', !!ar && /max-age=31536000/.test(ar.headers.get('cache-control') || '') && /immutable/.test(ar.headers.get('cache-control') || ''), ar && ar.headers.get('cache-control'));
    const miss = await fetch(BASE + '/assets/no-such-file-' + SUF + '.js');
    check('an unknown asset is a 404', miss.status === 404, miss.status);
    // The app icons (static files): the manifest's three
    // and the apple-touch-icon, PNGs with a day's cache.
    for (const ic of ['icon-192', 'icon-512', 'icon-512-maskable', 'icon-180']) {
      const ir = await fetch(BASE + '/icons/' + ic + '.png');
      const ib = Buffer.from(await ir.arrayBuffer());
      check('icon ' + ic + ' is a PNG with a day\'s cache', ir.status === 200 && /image\/png/.test(ir.headers.get('content-type') || '') && ib.slice(0, 4).toString('hex') === '89504e47' && /max-age=86400/.test(ir.headers.get('cache-control') || ''), ir.status + ' ' + ir.headers.get('content-type') + ' ' + ir.headers.get('cache-control') + ' ' + ib.length);
    }
    const mf = await req('GET', '/manifest.webmanifest');
    check('the manifest still names the icons', mf.status === 200 && (mf.json && mf.json.icons || []).length === 3, mf.status + ' ' + mf.text.slice(0, 160));

    // Clean up room one.
    await req('DELETE', R + '?confirm=apitest-main-' + SUF, { owner: true });
  } finally {
    server.stop();
  }
  console.log(failures ? 'API SUITE: ' + failures + ' failure(s)' : 'API SUITE: all checks passed');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error('API SUITE crashed: ' + (e && e.stack || e)); process.exit(1); });
