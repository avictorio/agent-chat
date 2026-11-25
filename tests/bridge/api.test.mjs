import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchVmsWithStatus, apiRoot, API_BASE } from '../../worker/bridge/muse/api.ts';

const TOKEN = 'device-access-SECRET';

function respond(status, body) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    if (body instanceof Error) throw body;
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  };
  return { calls, fetch };
}

function logger() {
  const lines = [];
  const f = (m) => lines.push(m);
  return { lines, info: f, warn: f, error: f, debug: f };
}

test('apiRoot', () => {
  assert.equal(apiRoot(), API_BASE);
  assert.equal(apiRoot('https://x.example/v2//'), 'https://x.example/v2');
});

test('fetch_vms: request shape and VM mapping', async () => {
  const { calls, fetch } = respond(200, {
    vm_list: [
      { vm_ws_url: 'wss://a', vm_url: 'https://a', vm_auth_token: 'ta', vm_name: 'A', vm_id: 'id-a', default: true },
      { vm_url: 'https://b', vm_auth_token: 'tb', vm_id: 'id-b' },
      { vm_url: 'https://c' }, // no token: skipped
      'junk',
    ],
  });
  const log = logger();
  const { vms, status } = await fetchVmsWithStatus(TOKEN, { root: 'https://api.example', fetch, userAgent: 'ua/1', logger: log });
  assert.equal(status, 200);
  assert.equal(calls[0].url, 'https://api.example/fetch_vms');
  assert.equal(calls[0].init.method, 'GET');
  assert.deepEqual(calls[0].init.headers, { Authorization: `Bearer ${TOKEN}`, 'X-API-Version': '1.0.0', 'User-Agent': 'ua/1' });
  assert.deepEqual(vms, [
    { vm_url: 'wss://a', vm_auth_token: 'ta', vm_name: 'A', vm_id: 'id-a', is_default: true },
    { vm_url: 'https://b', vm_auth_token: 'tb', vm_name: '', vm_id: 'id-b', is_default: false },
  ]);
  assert.ok(!log.lines.join('\n').includes(TOKEN));
});

test('fetch_vms: failures return the status the SDK returns', async () => {
  const cases = [
    [respond(401, 'no'), 401],
    [respond(500, 'boom'), 500],
    [respond(200, 'not json'), null],
    [respond(200, new Error(`network down ${TOKEN}`)), null],
    [respond(200, [1, 2]), 200],
    [respond(200, { error_title: 'Bad', backend_error_code: 7 }), 200],
    [respond(200, { vm_list: 'x' }), 200],
  ];
  for (const [{ fetch }, expected] of cases) {
    const log = logger();
    const r = await fetchVmsWithStatus(TOKEN, { fetch, logger: log });
    assert.deepEqual(r, { vms: [], status: expected });
    assert.ok(!log.lines.join('\n').includes(TOKEN));
  }
});
