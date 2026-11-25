// The bridge end to end in Node: its router (bridgeFetch, as the chat
// Worker calls it), both Durable Objects on node:sqlite
// (helpers/fake-do.mjs), the Muse API as a stub fetch, the VM as the fake
// Noise VM (helpers/fake-vm.mjs). Nothing leaves the process.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { bridgeFetch, deliverError, checkHandover } from '../../worker/bridge/index.ts';
import { MuseLink } from '../../worker/bridge/link.ts';
import { Directory, normaliseCode } from '../../worker/bridge/directory.ts';
import { generateBridgeKey, seal } from '../../worker/bridge/seal.ts';
import { WAKE_BUDGET_HEADER, deps, hostAllowed, museFetch } from '../../worker/bridge/util.ts';
import { MUSE_WAKE_BUDGET_MS, MUSE_WAKE_LATE_RETRY_S } from '../../worker/limits.ts';
import { sessionIdFor } from '../../worker/bridge/wake.ts';
import { ServiceFrame } from '../../worker/bridge/muse/envelope.ts';
import { FakeVm } from './helpers/fake-vm.mjs';
import { FakeNamespace } from './helpers/fake-do.mjs';

const KEYS = await generateBridgeKey();
const utf8 = (s) => new TextEncoder().encode(s);
const text = (b) => new TextDecoder().decode(b);
const realNow = deps.now;

// The Muse API: access token -> fetch_vms answer.
const MUSE = {
  'tok-A': { status: 200, vms: [{ vm_id: 'vm-A', vm_auth_token: 'vmtok-A', vm_ws_url: 'wss://x', default: true }] },
  'tok-A2': { status: 200, vms: [{ vm_id: 'vm-A', vm_auth_token: 'vmtok-A2', vm_ws_url: 'wss://x', default: true }] },
  'tok-B': { status: 200, vms: [{ vm_id: 'vm-B', vm_auth_token: 'vmtok-B', vm_ws_url: 'wss://x', default: true }] },
  'tok-none': { status: 200, vms: [] },
  'tok-dead': { status: 401 },
};

let env, apiCalls, fleet, logs, clock;

function makeFleet() {
  const f = { plans: [], conns: [], requests: [], errors: [] };
  f.connect = async (url, headers) => {
    const plan = f.plans.shift() ?? {};
    f.conns.push({ url, auth: headers.Authorization });
    if (plan.unreachable) throw new Error('connect failed');
    const vm = new FakeVm({ rejectStatus: plan.reject ?? null });
    const socket = await vm.connect(url, headers);
    (async () => {
      await vm.handshakeDone;
      const fr = await vm.nextFrame();
      f.requests.push(JSON.parse(text(fr.value.body)));
      if (plan.hang) return;
      if (plan.delay) await new Promise((r) => setTimeout(r, plan.delay));
      const body = utf8(plan.body ?? '{"result":{"message_id":"m-1"}}');
      await vm.sendFrame(ServiceFrame.response(fr.streamId, { status: plan.status ?? 200, body, endBody: true }));
    })().catch((e) => f.errors.push(e));
    return socket;
  };
  return f;
}

beforeEach(() => {
  apiCalls = [];
  logs = [];
  clock = 1_800_000_000_000;
  fleet = makeFleet();
  deps.now = () => clock;
  deps.log = (line) => logs.push(line);
  deps.connect = fleet.connect;
  deps.fetch = async (url, init) => {
    const token = init.headers.Authorization.replace(/^Bearer /, '');
    apiCalls.push({ url, token });
    const a = MUSE[token] ?? { status: 401 };
    if (a.status !== 200) return new Response('no', { status: a.status });
    return new Response(JSON.stringify({ vm_list: a.vms }), { status: 200 });
  };
  // a wake that hangs gives up in a moment, not after MUSE_CHAT_TIMEOUT_MS
  deps.limits = { handshakeTimeoutMs: 2000, requestTimeoutMs: 300 };
  env = { MUSE_SEAL_KEY: KEYS.privateKey };
  env.MUSE_LINK = new FakeNamespace(MuseLink, env);
  env.MUSE_DIRECTORY = new FakeNamespace(Directory, env);
});

async function call(path, body, { method = 'POST', headers: extra = {} } = {}) {
  const headers = { 'Content-Type': 'application/json', ...extra };
  const r = await bridgeFetch(
    new Request('https://muse-bridge' + path, { method, headers, body: method === 'GET' || method === 'HEAD' ? undefined : JSON.stringify(body) }),
    env,
  );
  const t = await r.text();
  return { status: r.status, body: t ? JSON.parse(t) : null, headers: r.headers };
}

const sealFor = (accessToken, extra = {}) => seal({ accessToken, nodeId: 'gadget-abc123', ...extra }, KEYS.publicKey);

async function connect(token = 'tok-A') {
  const r = await call('/connect', { sealed: await sealFor(token), termsVersion: '2026-11' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
}

async function linked(token = 'tok-A') {
  const c = await connect(token);
  assert.equal((await call('/claim', { code: c.code })).status, 200);
  return c.museLinkId;
}

function wake(museLinkId, extra = {}) {
  return {
    museLinkId,
    room: 'lobby',
    member: 'Ada',
    routing: 'per-room',
    cursor: 5,
    items: [
      { seq: 4, kind: 'message', at: 1, data: { id: 11, from: 'bob', text: 'secret room text ``` here' } },
      { seq: 5, kind: 'game', at: 2, data: { type: 'game', game: { id: 'g1' } } },
    ],
    ...extra,
  };
}

function assertNoSecrets(...secrets) {
  const all = logs.join('\n');
  for (const s of secrets) assert.ok(!all.includes(s), `log leaked ${s.slice(0, 6)}`);
}

test('seal-key: the public key, with the alg and info the gadget checks', async () => {
  const k = await call('/seal-key', null, { method: 'GET' });
  assert.equal(k.status, 200);
  // the gadget's firmware compares these two strings byte for byte
  assert.deepEqual(k.body, { alg: 'X25519-HKDF-SHA256-AES-256-GCM', info: 'muse-bridge seal v1', publicKey: KEYS.publicKey });
  assert.equal(k.headers.get('Content-Type'), 'application/json');
  assert.equal(k.headers.get('Cache-Control'), 'no-store');
  assert.equal((await call('/seal-key', null, { method: 'HEAD' })).status, 200);
});

test('without MUSE_SEAL_KEY: seal-key, connect and update answer 503 not_configured; the rest work', async () => {
  const id = await linked();
  delete env.MUSE_SEAL_KEY;
  const notConfigured = { code: 'not_configured', error: 'bridge key not set' };
  const k = await call('/seal-key', null, { method: 'GET' });
  assert.deepEqual([k.status, k.body], [503, notConfigured]);
  const c = await call('/connect', { sealed: await sealFor('tok-A'), termsVersion: 'v1' });
  assert.deepEqual([c.status, c.body], [503, notConfigured]);
  const u = await call('/update', { sealed: await sealFor('tok-A2'), museLinkId: id });
  assert.deepEqual([u.status, u.body], [503, notConfigured]);
  assert.equal(env.MUSE_LINK.instance(id).secret().access_token, 'tok-A', 'nothing replaced');
  // a code from before is claimed; the link is woken, counted and shown
  const c2 = await (async () => {
    env.MUSE_SEAL_KEY = KEYS.privateKey;
    const r = await connect();
    delete env.MUSE_SEAL_KEY;
    return r;
  })();
  assert.equal((await call('/claim', { code: c2.code })).status, 200);
  assert.equal((await call('/deliver', wake(id))).status, 200);
  assert.equal((await call('/rooms', { museLinkId: id, room: 'lobby', hooked: true })).body.rooms, 1);
  assert.equal((await call('/status', { museLinkId: id })).body.tokenHeld, true);
  assert.equal((await call('/disconnect', { museLinkId: id })).body.removed, true);
});

test('connect -> claim: one-time code, single use; same Muse reuses its link', async () => {
  const c = await connect();
  assert.match(c.museLinkId, /^ml_[0-9a-f]{32}$/);
  assert.match(c.code, /^[0-9A-Z]{5}-[0-9A-Z]{5}$/);
  assert.equal(c.expiresAt, clock + 30 * 60 * 1000);
  assert.deepEqual(apiCalls.map((x) => x.url), ['https://api.muse.ai/fetch_vms']);

  // Relayed sloppily (lowercase, no dash): still the code.
  const first = await call('/claim', { code: c.code.toLowerCase().replace('-', ' ') });
  assert.deepEqual([first.status, first.body], [200, { museLinkId: c.museLinkId }]);
  const again = await call('/claim', { code: c.code });
  assert.deepEqual([again.status, again.body.code], [410, 'code_used']);
  assert.equal((await call('/claim', { code: 'ZZZZZ-ZZZZZ' })).status, 404);
  assert.equal((await call('/claim', { code: 'short' })).status, 404);

  // The acceptance is recorded in the link.
  const row = env.MUSE_LINK.instance(c.museLinkId).row();
  assert.equal(row.terms_version, '2026-11');
  assert.equal(row.terms_at, clock);
  assert.equal(row.vm_id, 'vm-A');

  // The same Muse again (a refreshed token): same link, new code, old code dead.
  const c2 = await connect('tok-A2');
  assert.equal(c2.museLinkId, c.museLinkId);
  assert.notEqual(c2.code, c.code);
  // A different Muse: a different link.
  const c3 = await connect('tok-B');
  assert.notEqual(c3.museLinkId, c.museLinkId);

  assertNoSecrets('tok-A', 'vmtok-A', c.code, c2.code, normaliseCode(c.code));
});

test('codes expire after 30 minutes, and a new code replaces the old', async () => {
  const c = await connect();
  clock += 30 * 60 * 1000;
  const r = await call('/claim', { code: c.code });
  assert.deepEqual([r.status, r.body.code], [410, 'code_expired']);
  const c2 = await connect();
  const c3 = await connect();
  assert.equal((await call('/claim', { code: c2.code })).status, 404, 'replaced');
  assert.equal((await call('/claim', { code: c3.code })).status, 200);
});

test('connect refuses: bad seal, refused token, no VM, foreign hosts, missing terms', async () => {
  const t = { termsVersion: '1' };
  assert.equal((await call('/connect', { ...t, sealed: 'AAAA' })).body.code, 'seal_invalid');
  const other = await generateBridgeKey();
  assert.equal((await call('/connect', { ...t, sealed: await seal({ accessToken: 'tok-A', nodeId: 'g' }, other.publicKey) })).body.code, 'seal_invalid');
  assert.equal((await call('/connect', { ...t, sealed: await sealFor('tok-dead') })).status, 403);
  assert.equal((await call('/connect', { ...t, sealed: await sealFor('tok-none') })).status, 422);
  const evil = await call('/connect', { ...t, sealed: await sealFor('tok-A', { apiUrlV2: 'https://evil.example/api' }) });
  assert.deepEqual([evil.status, evil.body.code], [400, 'host_not_allowed']);
  const evilNoise = await call('/connect', { ...t, sealed: await sealFor('tok-A', { noiseHost: 'evil.example' }) });
  assert.deepEqual([evilNoise.status, evilNoise.body.code], [400, 'host_not_allowed']);
  assert.equal((await call('/connect', { sealed: await sealFor('tok-A') })).status, 400);
  assert.equal((await call('/connect', { ...t, sealed: await seal({ accessToken: 'tok A\n', nodeId: 'g' }, KEYS.publicKey) })).status, 400);
  // Nothing refused above reached the Muse API with a foreign host.
  assert.ok(apiCalls.every((c) => c.url.startsWith('https://api.muse.ai/')));
  // An allowed apiUrlV2 is used as the root.
  assert.equal((await call('/connect', { ...t, sealed: await sealFor('tok-A', { apiUrlV2: 'https://api.muse.ai/base/' }) })).status, 200);
  assert.equal(apiCalls.at(-1).url, 'https://api.muse.ai/base/fetch_vms');
  // The allow-lists are constants: the names that were the muse-bridge
  // Worker's variables widen nothing now.
  env.MUSE_API_HOSTS = 'api.muse.ai,*.muse.example';
  env.MUSE_NOISE_HOSTS = 'evil.example';
  const calls = apiCalls.length;
  const v2 = await call('/connect', { ...t, sealed: await sealFor('tok-A', { apiUrlV2: 'https://v2.muse.example/base/' }) });
  assert.deepEqual([v2.status, v2.body.code], [400, 'host_not_allowed']);
  const n2 = await call('/connect', { ...t, sealed: await sealFor('tok-A', { noiseHost: 'evil.example' }) });
  assert.deepEqual([n2.status, n2.body.code], [400, 'host_not_allowed']);
  assert.equal(apiCalls.length, calls);
});

test('handover checks', () => {
  assert.equal(checkHandover({ accessToken: 'a', nodeId: 'homelink-1a2b3c' }).noiseHost, 'hatch.metaaivm.com');
  assert.ok(checkHandover({ accessToken: 'a', nodeId: 'homelink-1a2b3c', apiUrlV2: 'http://api.muse.ai' }).error);
  assert.ok(checkHandover({ accessToken: 'a', nodeId: 'x', apiUrlV2: 'https://u:p@api.muse.ai' }).error);
  assert.ok(checkHandover({ accessToken: 'a', nodeId: 'x', apiUrlV2: 'https://api.muse.ai.evil.example' }).error);
  assert.ok(checkHandover({ accessToken: 'a', nodeId: 'x', noiseHost: 'hatch.metaaivm.com/evil' }).error);
  assert.ok(checkHandover({ accessToken: 'a', nodeId: 'x', noiseHost: 'evil.hatch.metaaivm.com' }).error);
  assert.ok(!checkHandover({ accessToken: 'a', nodeId: 'x', noiseHost: 'hatch.metaaivm.com:443' }).error);
  assert.ok(checkHandover({ accessToken: 'a', nodeId: '' }).error);
  // A "*." entry takes its subdomains only (no list holds one today).
  assert.ok(hostAllowed('v2.muse.example', ['*.muse.example']));
  assert.ok(!hostAllowed('muse.example', ['*.muse.example']));
  assert.ok(!hostAllowed('evilmuse.example', ['*.muse.example']));
});

test('a link whose stored hosts are off the allow-lists is not woken, and Muse never sees its token', async () => {
  const id = await linked();
  const row = env.MUSE_LINK.instance(id).sql;
  for (const [apiRoot, noiseHost] of [['https://evil.example', 'hatch.metaaivm.com'], ['https://api.muse.ai', 'evil.example'], ['http://api.muse.ai', 'hatch.metaaivm.com']]) {
    row.exec('UPDATE link SET api_root = ?, noise_host = ?', apiRoot, noiseHost);
    row.exec('UPDATE secret SET vm_auth_token = NULL');
    const calls = apiCalls.length;
    const r = await call('/deliver', wake(id));
    assert.deepEqual([r.status, r.body.code], [502, 'host_not_allowed'], apiRoot + ' ' + noiseHost);
    assert.equal(apiCalls.length, calls);
    assert.equal(fleet.conns.length, 0);
  }
  // the gadget's next update stores checked hosts again
  assert.equal((await call('/update', { sealed: await sealFor('tok-A2') })).status, 200);
  assert.equal((await call('/deliver', wake(id))).status, 200);
  assertNoSecrets('tok-A', 'vmtok-A');
});

test('museFetch: under TEST_HOOKS Muse hosts go to a loopback fake, or nowhere', async () => {
  const seen = [];
  deps.fetch = async (url) => {
    seen.push(String(url));
    return new Response('{}');
  };
  const go = (e, url) => museFetch(e)(url, {}).then(() => 'sent', (err) => err.name);
  // production: as asked
  assert.equal(await go({}, 'https://api.muse.ai/fetch_vms'), 'sent');
  assert.equal(await go({ TEST_MUSE_ORIGIN: 'http://127.0.0.1:9' }, 'https://api.muse.ai/fetch_vms'), 'sent');
  // a test server: a Muse host goes to the fake, or is refused without one
  const t = (o) => ({ TEST_HOOKS: '1', TEST_MUSE_ORIGIN: o });
  assert.equal(await go(t('http://127.0.0.1:9'), 'https://api.muse.ai/base/fetch_vms'), 'sent');
  assert.equal(await go(t('http://127.0.0.1:9'), 'https://hatch.metaaivm.com/v1/noise?vm_id=vm-A'), 'sent');
  assert.equal(await go(t(undefined), 'https://api.muse.ai/fetch_vms'), 'TypeError');
  assert.equal(await go(t('https://evil.example'), 'https://api.muse.ai/fetch_vms'), 'TypeError');
  assert.equal(await go(t('http://127.0.0.1:9.evil.example'), 'https://hatch.metaaivm.com/v1/noise'), 'TypeError');
  assert.equal(await go(t('http://localhost:9'), 'https://api.muse.ai/fetch_vms'), 'TypeError');
  // any other host is not the switch's business
  assert.equal(await go(t('http://127.0.0.1:9'), 'https://elsewhere.example/x'), 'sent');
  assert.deepEqual(seen, [
    'https://api.muse.ai/fetch_vms',
    'https://api.muse.ai/fetch_vms',
    'http://127.0.0.1:9/base/fetch_vms',
    'http://127.0.0.1:9/v1/noise?vm_id=vm-A',
    'https://elsewhere.example/x',
  ]);
});

// Every Muse call carries a credential (the access token or the VM
// bearer), and under the chat Worker's compatibility date a followed
// redirect took the Authorization header on to whatever host it named.
test('museFetch: no call follows a redirect, live or under TEST_HOOKS; a 3xx fails the call', async () => {
  const inits = [];
  let status = 302;
  deps.fetch = async (url, init) => {
    inits.push(init);
    return new Response(null, { status, headers: status === 200 ? {} : { Location: 'https://elsewhere.example/steal' } });
  };
  const go = (e, url) => museFetch(e)(url, { headers: { Authorization: 'Bearer x' }, redirect: 'follow' }).then((r) => r.status, (err) => err.name);
  const t = { TEST_HOOKS: '1', TEST_MUSE_ORIGIN: 'http://127.0.0.1:9' };
  for (const s of [301, 302, 303, 307, 308]) {
    status = s;
    assert.equal(await go({}, 'https://api.muse.ai/fetch_vms'), 'MuseConnectionError', String(s));
    assert.equal(await go(t, 'https://hatch.metaaivm.com/v1/noise?vm_id=vm-A'), 'MuseConnectionError', String(s));
  }
  status = 200;
  assert.equal(await go({}, 'https://api.muse.ai/fetch_vms'), 200);
  assert.equal(inits.length, 11);
  // the caller's own redirect mode is overridden; its headers go as they were
  for (const i of inits) assert.deepEqual([i.redirect, i.headers.Authorization], ['manual', 'Bearer x']);
});

test('a redirect from Muse is never followed: the handover, a wake\'s lookup and the VM socket answer muse_unreachable', async () => {
  const id = await linked();
  const calls = [];
  // Muse's hosts answer a redirect to a host off the allow-lists
  deps.fetch = async (url, init) => {
    calls.push({ url: String(url), redirect: init.redirect, upgrade: init.headers.Upgrade ?? null });
    return new Response(null, { status: 302, headers: { Location: 'https://elsewhere.example/catch' } });
  };
  const c = await call('/connect', { sealed: await sealFor('tok-B'), termsVersion: 'v1' });
  assert.deepEqual([c.status, c.body.code], [502, 'muse_unreachable']);
  const u = await call('/update', { sealed: await sealFor('tok-A2') });
  assert.deepEqual([u.status, u.body.code], [502, 'muse_unreachable']);
  // a wake with no VM bearer cached asks fetch_vms first
  env.MUSE_LINK.instance(id).sql.exec('UPDATE secret SET vm_auth_token = NULL');
  const w = await call('/deliver', wake(id));
  assert.deepEqual([w.status, w.body.code], [502, 'muse_unreachable']);
  // a wake with its VM bearer goes to the socket: the real Workers factory,
  // whose upgrade goes through the same fetch
  env.MUSE_LINK.instance(id).sql.exec("UPDATE secret SET vm_auth_token = 'vmtok-A'");
  deps.connect = null;
  const s = await call('/deliver', wake(id));
  assert.deepEqual([s.status, s.body.code], [502, 'muse_unreachable']);
  assert.deepEqual(calls, [
    { url: 'https://api.muse.ai/fetch_vms', redirect: 'manual', upgrade: null },
    { url: 'https://api.muse.ai/fetch_vms', redirect: 'manual', upgrade: null },
    { url: 'https://api.muse.ai/fetch_vms', redirect: 'manual', upgrade: null },
    { url: 'https://hatch.metaaivm.com/v1/noise?vm_id=vm-A', redirect: 'manual', upgrade: 'websocket' },
  ]);
  // nothing was stored from a redirect, and the link still holds its token
  assert.equal(env.MUSE_LINK.instance(id).secret().access_token, 'tok-A');
  assertNoSecrets('tok-A', 'tok-A2', 'tok-B', 'vmtok-A');
});

test('update: a refreshed token for the same Muse replaces the stored one; another Muse is refused', async () => {
  const id = await linked();
  const u = await call('/update', { sealed: await sealFor('tok-A2') });
  assert.deepEqual([u.status, u.body], [200, { museLinkId: id, updated: true }]);
  assert.equal(env.MUSE_LINK.instance(id).secret().access_token, 'tok-A2');
  assert.equal(env.MUSE_LINK.instance(id).secret().vm_auth_token, 'vmtok-A2');

  // tok-B's Muse has no link: refused, nothing replaced.
  assert.equal((await call('/update', { sealed: await sealFor('tok-B') })).status, 404);
  // tok-B's Muse has a link of its own, but the caller names A's.
  const idB = await linked('tok-B');
  const x = await call('/update', { sealed: await sealFor('tok-B'), museLinkId: id });
  assert.deepEqual([x.status, x.body.code], [409, 'vm_mismatch']);
  assert.equal(env.MUSE_LINK.instance(id).secret().access_token, 'tok-A2');
  assert.equal(env.MUSE_LINK.instance(idB).secret().access_token, 'tok-B');
  // A token Muse refuses is not stored.
  assert.equal((await call('/update', { sealed: await sealFor('tok-dead') })).status, 403);
  assert.equal(env.MUSE_LINK.instance(id).secret().access_token, 'tok-A2');
  assertNoSecrets('tok-A2', 'vmtok-A2', 'tok-B');
});

test('deliver: one session, one text, 2xx on the ack; no title line', async () => {
  const id = await linked();
  const before = apiCalls.length;
  const r = await call('/deliver', wake(id));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body, { ok: true, cursor: 5, delivered: 2 });
  assert.equal(apiCalls.length, before, 'the VM bearer from connect was cached');
  assert.equal(fleet.conns.length, 1);
  assert.equal(fleet.conns[0].url, 'wss://hatch.metaaivm.com/v1/noise?vm_id=vm-A');
  assert.equal(fleet.conns[0].auth, 'Bearer vmtok-A');

  const sent = fleet.requests[0];
  assert.equal(sent.device_id, 'gadget-abc123');
  assert.equal(sent.session_id, await sessionIdFor(id, 'per-room', 'lobby'));
  assert.ok(sent.message.startsWith('[Agent Chat]\n````\n{\n  "room": "lobby",'), sent.message);
  assert.ok(sent.message.includes('"text": "secret room text ``` here"'));
  assert.ok(sent.message.endsWith('\n```'));

  // The next wake into that chat.
  await call('/deliver', wake(id, { cursor: 6, items: [{ seq: 6, kind: 'message', at: 3, data: { id: 12 } }] }));
  assert.ok(fleet.requests[1].message.startsWith('[Agent Chat]\n```\n{\n  "room": "lobby",'));
  // Another room per-room: its own chat.
  await call('/deliver', wake(id, { room: 'games', items: [{ seq: 1, kind: 'message', at: 3, data: {} }], cursor: 1 }));
  assert.equal(fleet.requests[2].session_id, await sessionIdFor(id, 'per-room', 'games'));
  assert.ok(fleet.requests[2].message.includes('"room": "games"'));
  // Main chat: no session id.
  await call('/deliver', wake(id, { routing: 'main', items: [{ seq: 7, kind: 'message', at: 3, data: {} }], cursor: 7 }));
  assert.equal(fleet.requests[3].session_id, undefined);
  assert.ok(fleet.requests[3].message.includes('"room": "lobby"'));
  // agent-chat routing: one shared chat.
  await call('/deliver', wake(id, { routing: 'agent-chat', items: [{ seq: 8, kind: 'message', at: 3, data: {} }], cursor: 8 }));
  assert.ok(fleet.requests[4].message.includes('"room": "lobby"'));
  assert.equal(fleet.requests[4].session_id, await sessionIdFor(id, 'agent-chat', 'lobby'));
  // skipped is told.
  await call('/deliver', wake(id, { skipped: 4, items: [{ seq: 9, kind: 'message', at: 3, data: {} }], cursor: 9 }));
  assert.ok(fleet.requests[5].message.includes('\n(4 older items not shown)\n'));
  assert.deepEqual(fleet.errors, []);
  assertNoSecrets('tok-A', 'vmtok-A', 'secret room text');
});

test('deliver: paused answers 503 + Retry-After and sends nothing; unpaused delivers', async () => {
  const id = await linked();
  env.MUSE_DELIVER_PAUSED = '1';
  try {
    const r = await call('/deliver', wake(id));
    assert.equal(r.status, 503);
    assert.equal(r.body.code, 'paused');
    assert.equal(fleet.conns.length, 0);
  } finally {
    delete env.MUSE_DELIVER_PAUSED;
  }
  assert.equal((await call('/deliver', wake(id))).status, 200);
  assert.equal(fleet.requests.length, 1);
});

test('deliver: a retry of a wake that landed is not sent again', async () => {
  const id = await linked();
  assert.equal((await call('/deliver', wake(id))).status, 200);
  const again = await call('/deliver', wake(id));
  assert.deepEqual([again.status, again.body.duplicate], [200, true]);
  assert.equal(fleet.requests.length, 1);
  // A retry folding in a newer item sends only the new one.
  const more = wake(id, { cursor: 6, items: [...wake(id).items, { seq: 6, kind: 'message', at: 3, data: { id: 'new' } }] });
  assert.equal((await call('/deliver', more)).body.delivered, 1);
  assert.ok(!fleet.requests[1].message.includes('"g1"'));
  assert.ok(fleet.requests[1].message.includes('"new"'));
});

test('deliver: an upgrade refused (401) re-fetches the VM bearer once', async () => {
  const id = await linked();
  fleet.plans.push({ reject: 401 });
  const r = await call('/deliver', wake(id));
  assert.equal(r.status, 200);
  assert.equal(apiCalls.length, 2, 'connect + one re-fetch');
  assert.deepEqual(fleet.conns.map((c) => c.auth), ['Bearer vmtok-A', 'Bearer vmtok-A']);
  // Refused again after the re-fetch: 502, not a loop.
  fleet.plans.push({ reject: 403 }, { reject: 403 });
  const r2 = await call('/deliver', wake(id, { items: [{ seq: 9, kind: 'message', at: 1, data: {} }], cursor: 9 }));
  assert.deepEqual([r2.status, r2.body.code], [502, 'vm_refused']);
  assert.equal(apiCalls.length, 3);
});

test('deliver: a refused access token waits out a grace period before 410', async () => {
  const id = await linked();
  // The device token went stale: the VM bearer is refused, and so is the re-fetch.
  env.MUSE_LINK.instance(id).sql.exec("UPDATE secret SET access_token = 'tok-dead'");
  const refusedOnce = async () => {
    fleet.plans.push({ reject: 401 });
    return call('/deliver', wake(id));
  };
  // A glitch: refusals below the threshold answer 503 with Retry-After and keep the token.
  for (let i = 0; i < 4; i++) {
    const r = await refusedOnce();
    assert.deepEqual([r.status, r.body.code, r.headers.get('Retry-After')], [503, 'token_refused', '900']);
    clock += 15 * 60 * 1000;
  }
  assert.notEqual(env.MUSE_LINK.instance(id).secret(), null);
  // Enough refusals, but not yet over six hours: still waiting.
  assert.equal((await refusedOnce()).status, 503);
  assert.notEqual(env.MUSE_LINK.instance(id).secret(), null);
  // Six hours after the first refusal: gone, and the token deleted.
  clock += 6 * 3600 * 1000;
  const r = await refusedOnce();
  assert.deepEqual([r.status, r.body.code], [410, 'link_gone']);
  assert.equal(env.MUSE_LINK.instance(id).secret(), null);
  // From now on 410 without calling Muse at all.
  const calls = apiCalls.length;
  const conns = fleet.conns.length;
  fleet.plans.length = 0;
  assert.equal((await call('/deliver', wake(id))).status, 410);
  assert.equal(apiCalls.length, calls);
  assert.equal(fleet.conns.length, conns);
  // A fresh token for the same Muse brings the link back.
  assert.equal((await call('/update', { sealed: await sealFor('tok-A2') })).status, 200);
  assert.equal((await call('/deliver', wake(id))).status, 200);
  assertNoSecrets('tok-dead', 'tok-A2');
});

test('deliver: a success clears earlier token refusals', async () => {
  const id = await linked();
  env.MUSE_LINK.instance(id).sql.exec("UPDATE secret SET access_token = 'tok-dead'");
  const one = (seq) => wake(id, { items: [{ seq, kind: 'message', at: 1, data: {} }], cursor: seq });
  // The cached VM bearer is refused once; after that every try goes straight to fetch_vms.
  fleet.plans.push({ reject: 401 });
  for (let i = 0; i < 4; i++) assert.equal((await call('/deliver', one(20 + i))).status, 503);
  assert.equal(fleet.plans.length, 0);
  // Muse takes the token again (the refusals were a glitch): delivered, and the count resets.
  env.MUSE_LINK.instance(id).sql.exec("UPDATE secret SET access_token = 'tok-A'");
  const ok = await call('/deliver', one(30));
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(env.MUSE_LINK.instance(id).sql.exec('SELECT refused_n FROM secret').one().refused_n, 0);
  // Long after, one refusal again: counted afresh, so not gone.
  clock += 7 * 3600 * 1000;
  env.MUSE_LINK.instance(id).sql.exec("UPDATE secret SET access_token = 'tok-dead'");
  fleet.plans.push({ reject: 401 });
  assert.equal((await call('/deliver', one(31))).status, 503, 'one refusal after a success is not gone');
});

test('deliver: 502 when Muse is unreachable, refuses, or does not ack', async () => {
  const id = await linked();
  const one = (seq) => wake(id, { items: [{ seq, kind: 'message', at: 1, data: {} }], cursor: seq });
  fleet.plans.push({ unreachable: true });
  assert.deepEqual(await call('/deliver', one(10)).then((r) => [r.status, r.body.code]), [502, 'muse_unreachable']);
  fleet.plans.push({ status: 500, body: '{"error":"x"}' });
  assert.deepEqual(await call('/deliver', one(11)).then((r) => [r.status, r.body.code]), [502, 'muse_rejected']);
  fleet.plans.push({ hang: true });
  assert.deepEqual(await call('/deliver', one(12)).then((r) => [r.status, r.body.code]), [502, 'muse_unreachable']);
  fleet.plans.push({ body: 'not json' });
  assert.deepEqual(await call('/deliver', one(13)).then((r) => [r.status, r.body.code]), [502, 'no_ack']);
  // Nothing was marked delivered: the same item goes out again.
  assert.equal((await call('/deliver', one(10))).status, 200);
});

// A wake's time (X-Wake-Budget-Ms, at most MUSE_WAKE_BUDGET_MS) bounds
// every step, so the link answers within it whatever Muse does; the room
// waits a little longer and never has to guess. Before, a 15 s lookup, a
// 5 s handshake, an 8 s request and one repeat after a 401 could outlast
// the room's wait, and a wake that had landed was counted as failed.
const budget = (ms) => ({ headers: { [WAKE_BUDGET_HEADER]: String(ms) } });
test('deliver: a slow Muse lookup answers try later, within the wake\'s time', async () => {
  const id = await linked();
  // no VM bearer kept: the wake looks the VM up first
  env.MUSE_LINK.instance(id).sql.exec('UPDATE secret SET vm_auth_token = NULL');
  // Muse's API answers nothing until the call gives up. The held timer
  // stands for the socket a real fetch keeps open: Node does not wait on
  // AbortSignal.timeout's own timer, so without it the test process could
  // end while the lookup waits.
  deps.fetch = (url, init) => new Promise((_, reject) => {
    const held = setTimeout(() => {}, 60_000);
    init.signal.addEventListener('abort', () => {
      clearTimeout(held);
      reject(init.signal.reason);
    });
  });
  deps.limits = { ...deps.limits, stepMinMs: 50, lookupTimeoutMs: 150 };
  // the lookup's own cap comes first: Muse did not answer (the room backs off)
  let t0 = Date.now();
  let r = await call('/deliver', wake(id));
  assert.deepEqual([r.status, r.body.code], [502, 'muse_unreachable']);
  assert.ok(Date.now() - t0 < 1000, Date.now() - t0);
  // the wake's time comes first: out of time, with a Retry-After, inside it
  deps.limits.lookupTimeoutMs = 8000;
  t0 = Date.now();
  r = await call('/deliver', wake(id), budget(400));
  const took = Date.now() - t0;
  assert.deepEqual([r.status, r.body.code], [503, 'out_of_time']);
  assert.equal(r.headers.get('Retry-After'), String(MUSE_WAKE_LATE_RETRY_S));
  assert.ok(took >= 350 && took < 650, 'answered as its time ran out: ' + took + ' ms');
  assert.equal(fleet.conns.length, 0, 'no session was opened');
});

test('deliver: a chat request Muse never answers is given up as the wake\'s time runs out', async () => {
  const id = await linked();
  deps.limits = { ...deps.limits, stepMinMs: 50, requestTimeoutMs: 8000 };
  fleet.plans.push({ hang: true });
  const t0 = Date.now();
  const r = await call('/deliver', wake(id), budget(500));
  const took = Date.now() - t0;
  // the request had gone, so it may have landed: Muse did not answer, not out of time
  assert.deepEqual([r.status, r.body.code], [502, 'muse_unreachable']);
  assert.ok(took < 750, 'within the wake\'s time, not the request\'s cap: ' + took + ' ms');
  assert.equal(fleet.requests.length, 1);
});

test('deliver: a wake still waiting behind another for its link answers when its time is up, and tries nothing', async () => {
  const id = await linked();
  deps.limits = { ...deps.limits, stepMinMs: 50, requestTimeoutMs: 8000 };
  fleet.plans.push({ hang: true });
  const first = call('/deliver', wake(id), budget(700));
  const t0 = Date.now();
  const second = await call('/deliver', wake(id, { room: 'den', cursor: 9, items: [{ seq: 9, kind: 'message', at: 1, data: {} }] }), budget(200));
  const took = Date.now() - t0;
  assert.deepEqual([second.status, second.body.code], [503, 'out_of_time']);
  assert.equal(second.headers.get('Retry-After'), String(MUSE_WAKE_LATE_RETRY_S));
  assert.ok(took < 450, 'answered at its own time, not after the wake ahead of it: ' + took + ' ms');
  assert.equal((await first).status, 502);
  // its turn came after the first: it opened no session and used no wake of the rate cap
  await env.MUSE_LINK.instance(id).chain;
  assert.equal(fleet.conns.length, 1);
  assert.equal(env.MUSE_LINK.instance(id).sql.exec('SELECT COUNT(*) AS n FROM wakes').one().n, 1);
});

test('deliver: a wake that lands late in its time is answered delivered, and its retry is not sent again', async () => {
  const id = await linked();
  deps.limits = { ...deps.limits, stepMinMs: 50, requestTimeoutMs: 8000 };
  fleet.plans.push({ delay: 450 });
  const r = await call('/deliver', wake(id), budget(600));
  assert.deepEqual([r.status, r.body.delivered], [200, 2]);
  const again = await call('/deliver', wake(id), budget(600));
  assert.deepEqual([again.status, again.body.duplicate], [200, true]);
  assert.equal(fleet.requests.length, 1);
});

test('deliver: the wake\'s time is MUSE_WAKE_BUDGET_MS at most; a malformed one is refused', async () => {
  const id = await linked();
  for (const bad of ['0', '-5', '1.5', 'soon', '99999999999']) {
    const r = await call('/deliver', wake(id), budget(bad));
    assert.deepEqual([r.status, r.body.code], [400, 'bad_request'], bad);
  }
  assert.equal(fleet.conns.length, 0);
  // more than the most is cut to it: the wake still goes
  const r = await call('/deliver', wake(id), budget(MUSE_WAKE_BUDGET_MS * 10));
  assert.equal(r.status, 200, JSON.stringify(r.body));
});

test('deliver: per-link rate cap answers 429 with Retry-After', async () => {
  deps.limits = { ...deps.limits, rateWakes: 3, rateWindowMs: 600_000 };
  const id = await linked();
  for (let s = 1; s <= 3; s++) {
    assert.equal((await call('/deliver', wake(id, { items: [{ seq: s, kind: 'message', at: 1, data: {} }], cursor: s }))).status, 200);
    clock += 1000;
  }
  const r = await call('/deliver', wake(id, { items: [{ seq: 4, kind: 'message', at: 1, data: {} }], cursor: 4 }));
  assert.equal(r.status, 429);
  assert.equal(r.headers.get('Retry-After'), String(600 - 3));
  assert.equal(fleet.requests.length, 3);
  // Another link has its own budget.
  const idB = await linked('tok-B');
  assert.equal((await call('/deliver', wake(idB))).status, 200);
  // The window moves on.
  clock += 597 * 1000;
  assert.equal((await call('/deliver', wake(id, { items: [{ seq: 4, kind: 'message', at: 1, data: {} }], cursor: 4 }))).status, 200);
});

test('disconnect: link and token gone, deliver 410, the Muse can link again', async () => {
  const id = await linked();
  const d = await call('/disconnect', { museLinkId: id });
  assert.deepEqual([d.status, d.body], [200, { museLinkId: id, removed: true }]);
  assert.equal(env.MUSE_LINK.instance(id).secret(), null);
  assert.equal(env.MUSE_LINK.instance(id).row(), null);
  assert.equal((await call('/deliver', wake(id))).status, 410);
  assert.equal((await call('/update', { sealed: await sealFor('tok-A') })).status, 404);
  assert.equal((await call('/disconnect', { museLinkId: id })).body.removed, false);
  // Unknown link ids get 410 too.
  assert.equal((await call('/deliver', wake('ml_' + 'f'.repeat(32)))).status, 410);
  const again = await connect();
  assert.notEqual(again.museLinkId, id);
});

test('disconnect kills an unclaimed code', async () => {
  const c = await connect();
  await call('/disconnect', { museLinkId: c.museLinkId });
  assert.equal((await call('/claim', { code: c.code })).status, 404);
});

test('rooms and status: a count of hooked rooms, kept across connect, gone on disconnect', async () => {
  const id = await linked();
  let st = await call('/status', { museLinkId: id });
  assert.deepEqual([st.status, st.body], [200, { museLinkId: id, connected: true, rooms: 0, termsVersion: '2026-11', tokenHeld: true }]);
  assert.deepEqual((await call('/rooms', { museLinkId: id, room: 'lobby', hooked: true })).body, { museLinkId: id, rooms: 1 });
  assert.equal((await call('/rooms', { museLinkId: id, room: 'lobby', hooked: true })).body.rooms, 1); // idempotent
  assert.equal((await call('/rooms', { museLinkId: id, room: 'den', hooked: true })).body.rooms, 2);
  assert.equal((await call('/rooms', { museLinkId: id, room: 'den', hooked: false })).body.rooms, 1);
  assert.equal((await call('/rooms', { museLinkId: id, room: 'den', hooked: false })).body.rooms, 1);
  // Connecting again (to add rooms) keeps them.
  const again = await connect();
  assert.equal(again.museLinkId, id);
  assert.equal((await call('/status', { museLinkId: id })).body.rooms, 1);
  // Bad input.
  assert.equal((await call('/rooms', { museLinkId: id, room: 'Bad Room', hooked: true })).status, 400);
  assert.equal((await call('/rooms', { museLinkId: id, room: 'lobby' })).status, 400);
  assert.equal((await call('/rooms', { museLinkId: 'nope', room: 'lobby', hooked: true })).status, 400);
  assert.equal((await call('/status', {})).status, 400);
  // Unknown link: 410.
  const other = 'ml_' + 'f'.repeat(32);
  assert.equal((await call('/rooms', { museLinkId: other, room: 'lobby', hooked: true })).status, 410);
  assert.equal((await call('/status', { museLinkId: other })).body.code, 'link_gone');
  // Disconnect clears them; the link answers 410.
  await call('/disconnect', { museLinkId: id });
  assert.equal((await call('/status', { museLinkId: id })).status, 410);
  assert.equal((await call('/rooms', { museLinkId: id, room: 'lobby', hooked: true })).status, 410);
  assert.equal(env.MUSE_LINK.instance(id).sql.exec('SELECT COUNT(*) AS n FROM rooms').one().n, 0);
  assertNoSecrets(id, 'tok-A');
});

test('deliver payload checks', () => {
  const ok = wake('ml_' + 'a'.repeat(32));
  assert.equal(deliverError(ok), null);
  assert.equal(deliverError({ ...ok, routing: '0e3b5b9a-8f62-4b1e-9d5c-3a2f1e0d9c8b' }), null);
  for (const bad of [
    { museLinkId: 'x' },
    { room: 'Lobby\n' },
    { routing: 'side-1' },
    { cursor: -1 },
    { items: [] },
    { items: [{ seq: 1, kind: 'poke', at: 1, data: {} }] },
    { items: [{ seq: 0, kind: 'message', at: 1, data: {} }] },
    { items: [{ seq: 1, kind: 'message', at: 1 }] },
    { skipped: 'x' },
  ]) {
    assert.ok(deliverError({ ...ok, ...bad }), JSON.stringify(bad));
  }
});

test('bad requests', async () => {
  assert.equal((await call('/nope', {})).status, 404);
  assert.equal((await call('/claim', null, { method: 'GET' })).status, 405);
  assert.equal((await call('/deliver', { museLinkId: 'nope' })).status, 400);
  const big = await call('/claim', { code: 'x'.repeat(40_000) });
  assert.equal(big.status, 413);
});

test.after(() => {
  deps.now = realNow;
  deps.limits = {};
});
