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
  fs.writeFileSync(DEV_VARS, 'OWNER_KEY=' + OWNER + '\nRESEND_API_KEY=re_fake_for_tests\nTEST_HOOKS=1\n');
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
    check('agent onboarding carries the ready-made watcher registry line', typeof invB.json.agent_onboarding === 'string' && invB.json.agent_onboarding.includes('rooms.txt') && invB.json.agent_onboarding.includes('apitest-main-' + SUF + ' ' + TB + ' ApiB'));
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
    check('recipe script: 200 shell with room + self substituted', r.status === 200 && r.text.includes('AGENTCHAT_ROOM:-' + RNAME) && r.text.includes('AGENTCHAT_SELF:-ApiB') && r.text.includes(':-$BASE/stream') && r.text.includes('STREAM_BASE?after='), r.text.slice(0, 80));
    check('recipe script: no placeholders left, no token', !r.text.includes('__ROOM__') && !r.text.includes('__SELF__') && !r.text.includes(TB));
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

    // Push subscribe validates its keys instead of throwing on bad base64url.
    r = await req('POST', R + '/push/subscribe', { token: TA, json: { subscription: { endpoint: 'https://example.com/x', keys: { p256dh: '!!!', auth: 'AAAAAAAAAAAAAAAAAAAAAA' } } } });
    check('malformed push keys -> 400, not 500', r.status === 400, r.status);

    // Draft media privacy.
    const draft = await req('POST', R + '/messages', { token: TA, json: { from: 'ApiA', text: 'draft pic', draft: true } });
    const did = draft.json.id;
    r = await req('PUT', R + '/messages/' + did + '/image', { token: TA, headers: { 'Content-Type': 'image/png' }, body: PNG });
    check('attach image to draft', r.status === 200, r.status);
    r = await req('GET', R + '/messages/' + did + '/image?invite=' + TB);
    check('other member cannot read draft media', r.status === 404, r.status);
    r = await req('GET', R + '/messages/' + did + '/image?invite=' + TA);
    check('sender reads own draft media', r.status === 200, r.status);
    r = await req('GET', R + '/messages/' + did + '/image', { owner: true });
    check('owner reads draft media', r.status === 200, r.status);
    r = await req('POST', R + '/messages/' + did + '/publish', { token: TA, json: {} });
    check('publish works', r.status === 200, r.status);
    r = await req('GET', R + '/messages/' + did + '/image?invite=' + TB);
    check('published media is room-visible', r.status === 200, r.status);

    // Phase A: an R2 outage fails media writes all-or-nothing (503, nothing saved).
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

    // Phase D: avatars live in R2. Set -> served with the right type;
    // replace -> new bytes served; an R2 outage on set -> 503 and the old
    // avatar survives; clear -> 404; the owner migration pair answers and
    // reports zeros when no legacy blobs exist.
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
    r = await req('POST', R + '/admin/migrate-avatars', { owner: true });
    check('migrate-avatars -> 200 zeros', r.status === 200 && r.json.migrated === 0 && r.json.failed === 0, r.status + ' ' + r.text.slice(0, 100));
    r = await req('POST', R + '/admin/purge-avatars', { owner: true });
    check('purge-avatars -> 200 zeros', r.status === 200 && r.json.purged === 0 && r.json.failed === 0, r.status + ' ' + r.text.slice(0, 100));
    r = await req('POST', R + '/admin/migrate-avatars', { token: TA });
    check('migrate-avatars without owner key -> 403', r.status === 403, r.status);

    // Phase E: signed media URLs. Listings mint them (and carry no
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
    await req('DELETE', R + '/avatar', { token: TA });

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
    const defId = r.json.game.id;
    r = await req('POST', R2 + '/games/' + defId + '/cancel', { token: TP, json: {} });
    check('default-tick game cancels clean', r.status === 200 && r.json.game.status === 'cancelled', r.status);
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
    // three throws as public vocabulary, so it is stripped before scanning.)
    const rivalView = JSON.stringify(r.json.game).split('"legal_moves":["rock","paper","scissors"]').join('');
    check('duel throw stays secret from the rival', r.status === 200 && (r.json.game.players.find(p => p.name === 'Poc') || {}).thrown === true && r.json.game.you.queued === null && !rivalView.includes('rock'), JSON.stringify(r.json.game).slice(0, 200));
    await new Promise(res => setTimeout(res, 31000));
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
    check('duel default round clock is 60', r.status === 201 && r.json.game.round_seconds === 60 && r.json.game.status === 'lobby', r.status + ' ' + JSON.stringify(r.json.game).slice(0, 160));
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

    // Battleship: lobby, placement (explicit fleets both sides),
    // secrecy, turn order, a sinking, the win, and the result post.
    // Poc's fleet hugs rows 10/5-8/6/2-4/2, Rex's rows 1/3-6/5/7-9, so
    // every scripted shot's outcome is known in advance.
    r = await req('POST', R2 + '/games', { token: TP, json: { game: 'battleship', from: 'Poc', players: ['Poc', 'Rex', 'Rae'] } });
    check('battleship with 3 players -> 400', r.status === 400, r.status);
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
    check('second placement opens play, creator fires first', r.status === 200 && r.json.resolved === true && r.json.game.phase === 'play' && r.json.game.turn_of === 'Poc', r.status + ' ' + JSON.stringify(r.json.game).slice(0, 160));
    // Secrecy: neither captain's view carries the rival's unhit cells
    // (quoted labels appear only as cell values), and a spectator
    // gets counts, never a fleet.
    r = await req('GET', R2 + '/games/' + bsId, { token: TRex });
    const rexView = JSON.stringify(r.json.game);
    check('rival fleet stays secret from Rex', r.status === 200 && !rexView.includes('"A10"') && !rexView.includes('"J2"'), rexView.slice(0, 220));
    r = await req('GET', R2 + '/games/' + bsId, { token: TP });
    check('rival fleet stays secret from Poc', r.status === 200 && !JSON.stringify(r.json.game).includes('"J9"'), JSON.stringify(r.json.game).slice(0, 220));
    r = await req('GET', R2 + '/games/' + bsId, { token: TRae });
    check('spectator sees no fleet at all', r.status === 200 && r.json.game.you.playing === false && !('fleet' in r.json.game) && (r.json.game.players || []).every(p => p.placed === true), JSON.stringify(r.json.game).slice(0, 220));
    r = await req('POST', R2 + '/games/' + bsId + '/moves', { token: TRex, json: { dir: 'J10' } });
    check('firing out of turn -> 409', r.status === 409, r.status);
    r = await req('POST', R2 + '/games/' + bsId + '/moves', { token: TP, json: { dir: 'A1' } });
    check('first shot hits and passes the turn', r.status === 200 && r.json.game.you.shots.A1 === 'hit' && r.json.game.turn_of === 'Rex' && (r.json.game.players.find(p => p.name === 'Poc') || {}).hits === 1, r.status + ' ' + JSON.stringify(r.json.game).slice(0, 200));
    r = await req('GET', R2 + '/messages?limit=50', { token: TRex });
    const bsNudge = ((r.json.room_state && r.json.room_state.awaiting_you) || []).find(x => x.type === 'game' && x.id === bsId);
    check('room_state nudges the captain to fire', !!bsNudge && typeof bsNudge.turn === 'number', JSON.stringify(bsNudge));
    await req('POST', R2 + '/games/' + bsId + '/moves', { token: TRex, json: { dir: 'J10' } });
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
      await req('POST', R2 + '/games/' + bsId + '/moves', { token: TRex, json: { dir: rexMisses[i] } });
    }
    check('a sunk ship is public and counted', sunkSeen, '');
    check('battleship finishes when the fleet is gone', !!finalBs && finalBs.winner === 'Poc' && (finalBs.players.find(p => p.name === 'Rex') || {}).afloat === 0, JSON.stringify(finalBs).slice(0, 200));
    const shotEntries = ((finalBs && finalBs.log) || []).filter((ln) => ln.by);
    check('battleship log carries structured shot entries for the history tab', shotEntries.length >= 10 && shotEntries.every((ln) => typeof ln.cell === 'string' && (ln.result === 'hit' || ln.result === 'miss')) && shotEntries.some((ln) => ln.sunk === 5), JSON.stringify(shotEntries.slice(0, 2)));
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
    await new Promise(res => setTimeout(res, 32000));
    r = await req('GET', R2 + '/games/' + bsClock, { token: TP });
    check('an expired turn passes to the rival', r.status === 200 && r.json.game.status === 'running' && r.json.game.turn_of === 'Rex' && (r.json.game.log || []).some(e => e.text.includes('let the turn clock run out')), JSON.stringify(r.json.game).slice(0, 240));

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
        } catch (e) {}
      })();
      return { status: resp.status, frames, close: () => { try { ctl.abort(); } catch (e) {} } };
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
    const stateCount = () => s.frames.filter(f => f.includes('event: state')).length;
    const beforeMsg = stateCount();
    await req('POST', R2 + '/messages', { token: TP, json: { from: 'Poc', text: 'state dedupe probe' } });
    await waitFor(() => s.frames.some(f => f.includes('event: message') && f.includes('state dedupe probe')), 4000);
    await new Promise(res => setTimeout(res, 1000));
    check('stream: unchanged state is not re-sent', stateCount() === beforeMsg, 'before=' + beforeMsg + ' after=' + stateCount());
    r = await req('POST', R2 + '/questions', { token: TP, json: { from: 'Poc', text: 'State event probe question?' } });
    const probeQid = r.json && r.json.question && r.json.question.id;
    check('stream: board change pushes a state frame', await waitFor(() => s.frames.some(f => f.includes('event: state') && f.includes('"open_questions"') && f.includes('State event probe question?')), 4000), JSON.stringify(s.frames).slice(-400));
    if (probeQid) await req('DELETE', R2 + '/questions/' + probeQid, { token: TP });
    s.close();
    // Park the stream match: with a real alarm armed it would otherwise
    // keep resolving ticks (and eventually post a result) behind the
    // rest of the suite's back.
    await req('POST', R2 + '/games/' + gid2 + '/cancel', { token: TP, json: {} });

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
    // Phase A on the MCP surface: during a simulated R2 outage, attach_media
    // fails as a tool error carrying the storage message, and recovers after.
    await req('POST', '/api/test-hooks/r2-fail', { owner: true, json: { room: R2.slice('/api/rooms/'.length), on: true } });
    r = await mcp(R2, 'tools/call', { name: 'attach_media', arguments: { id: up.message_id, kind: 'image', base64: PNG.toString('base64') } }, { token: TP });
    check('mcp attach_media during outage -> tool error with the storage message', !!(r.json && r.json.result && r.json.result.isError && JSON.stringify(r.json.result).includes('Storage is unavailable right now. Nothing was saved; try again.')), JSON.stringify(r.json).slice(0, 220));
    await req('POST', '/api/test-hooks/r2-fail', { owner: true, json: { room: R2.slice('/api/rooms/'.length), on: false } });
    r = await mcp(R2, 'tools/call', { name: 'attach_media', arguments: { id: up.message_id, kind: 'image', base64: PNG.toString('base64') } }, { token: TP });
    check('mcp attach_media works again after the outage', !!(r.json && r.json.result && !r.json.result.isError), JSON.stringify(r.json).slice(0, 200));

    // Phase C: upload tickets - lifecycle and failure semantics.
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
    check('oversize on a ticket -> 413', r.status === 413, r.status);
    r = await putTicket(tk2.upload.url, PNG);
    check('the same ticket still works after a 413', r.status === 200, r.status);
    // Ticket media on a draft stays private until publish (existing rule, new path).
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
    await req('DELETE', R2 + '/invites/' + TRev, { owner: true });
    r = await putTicket(tk6.upload.url, PNG);
    check('ticket of a revoked member -> 403', r.status === 403, r.status);
    // begin_upload without text mints an empty container draft: publishing it
    // bare is refused; a caption at publish time completes it.
    r = await mcp(R2, 'tools/call', { name: 'begin_upload', arguments: { kind: 'image' } }, { token: TP });
    const upE = r.json && r.json.result && r.json.result.structuredContent;
    r = await mcp(R2, 'tools/call', { name: 'publish_message', arguments: { id: upE.message_id } }, { token: TP });
    check('empty draft cannot publish', !!(r.json && r.json.result && r.json.result.isError), JSON.stringify(r.json).slice(0, 200));
    r = await mcp(R2, 'tools/call', { name: 'publish_message', arguments: { id: upE.message_id, text: 'captioned at publish' } }, { token: TP });
    check('publish with a caption completes the empty draft', !!(r.json && r.json.result && !r.json.result.isError), JSON.stringify(r.json).slice(0, 200));
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
    const rec = (r.json && r.json.record) || {};
    const recDuel = rec.duel || [];
    check('games list: record carries duel standings', recDuel.length >= 1 && recDuel.every((p) => typeof p.w === 'number' && typeof p.l === 'number'), JSON.stringify(rec).slice(0, 200));
    check('games list: record sorted by wins, wins were recorded', recDuel.every((p, i) => i === 0 || recDuel[i - 1].w >= p.w) && recDuel.reduce((a, p) => a + p.w, 0) >= 1, JSON.stringify(recDuel));

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
