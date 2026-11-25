// Live interop: the JS initiator against the Python SDK's NoiseXXResponder and
// transport code (scripts/bridge/interop/py_vm.py), exchanging encrypted messages both
// ways. Needs Python 3 with `cryptography` and an extracted SDK tree:
//
//   MUSE_SDK_SRC=<path to the SDK's linux/src, as Python sees it> npm run test:bridge-interop
//
// On Windows the responder runs in WSL by default (wsl -u root -- python3);
// set MUSE_INTEROP_CMD to a JSON argv array to override the interpreter, e.g.
//   MUSE_INTEROP_CMD='["python3"]'
// Skipped when MUSE_SDK_SRC is not set.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';

import { NoiseXXInitiator } from '../../../worker/bridge/muse/noise.ts';
import { NoiseTransport } from '../../../worker/bridge/muse/transport.ts';
import { MuseSession, chatRequestBody } from '../../../worker/bridge/muse/session.ts';
import { header } from '../../../worker/bridge/muse/envelope.ts';

const SDK_SRC = process.env.MUSE_SDK_SRC;
const skip = SDK_SRC ? false : 'set MUSE_SDK_SRC to run the live Python interop test';

const script = fileURLToPath(new URL('../../../scripts/bridge/interop/py_vm.py', import.meta.url));
const toWsl = (p) => p.replace(/^([A-Za-z]):\\/, (_, d) => `/mnt/${d.toLowerCase()}/`).replaceAll('\\', '/');

function pythonArgv() {
  if (process.env.MUSE_INTEROP_CMD) {
    return [...JSON.parse(process.env.MUSE_INTEROP_CMD), '-I', script, SDK_SRC];
  }
  if (process.platform === 'win32') return ['wsl', '-u', 'root', '--', 'python3', '-I', toWsl(script), SDK_SRC];
  return ['python3', '-I', script, SDK_SRC];
}

const hex = (b) => Buffer.from(b).toString('hex');
const unhex = (h) => new Uint8Array(Buffer.from(h, 'hex'));
const sha = (b) => createHash('sha256').update(b).digest('hex');

/** The Python VM process, exposed as a WebSocket-like socket plus an event log. */
function startPythonVm() {
  const [cmd, ...args] = pythonArgv();
  const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (d) => (stderr += d));
  const listeners = { message: [], close: [], error: [] };
  const events = [];
  const eventWaiters = [];
  const socket = {
    binaryType: 'arraybuffer',
    addEventListener: (type, fn) => listeners[type].push(fn),
    send: (data) => child.stdin.write(JSON.stringify({ data: hex(new Uint8Array(data)) }) + '\n'),
    close: () => child.stdin.end(),
  };
  const rl = createInterface({ input: child.stdout });
  rl.on('line', (line) => {
    const msg = JSON.parse(line);
    if (msg.send !== undefined) {
      const buf = unhex(msg.send);
      for (const fn of listeners.message) fn({ data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length) });
    } else {
      const w = eventWaiters.shift();
      if (w) w(msg.event);
      else events.push(msg.event);
    }
  });
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  child.on('exit', () => {
    for (const fn of listeners.close) fn({ code: 1000 });
    // Fail fast instead of hanging when Python exits early.
    for (const w of eventWaiters.splice(0)) w({ exited: true, stderr });
  });
  return {
    socket,
    child,
    exited,
    stderr: () => stderr,
    nextEvent: () => (events.length ? Promise.resolve(events.shift()) : new Promise((r) => eventWaiters.push(r))),
  };
}

test('JS initiator + NoiseTransport <-> Python NoiseXXResponder, both directions', { skip, timeout: 60_000 }, async () => {
  const vm = startPythonVm();
  try {
    const inbox = [];
    let waiter = null;
    vm.socket.addEventListener('message', (e) => {
      const d = new Uint8Array(e.data);
      if (waiter) {
        const w = waiter;
        waiter = null;
        w(d);
      } else inbox.push(d);
    });
    vm.socket.addEventListener('close', () => waiter?.(new Uint8Array(0)));
    const recv = () => (inbox.length ? Promise.resolve(inbox.shift()) : new Promise((r) => (waiter = r)));

    const ini = new NoiseXXInitiator();
    await ini.initialize();
    vm.socket.send(await ini.writeMessage1());
    await ini.readMessage2(await recv());
    vm.socket.send(await ini.writeMessage3());
    const hs = await vm.nextEvent();
    assert.equal(hs.handshake, 'ok');
    assert.equal(hex(ini.handshakeHash()), hs.hash, 'both sides derive the same handshake hash');
    const [send, recvCs] = await ini.split();
    const t = new NoiseTransport(send, recvCs);

    // Small request -> Python decrypts and decodes it.
    const body = chatRequestBody({ message: 'interop hello', deviceId: 'dev-1', sessionId: 's-1' });
    const r1 = await t.encryptHttpRequest('POST', '/chat/stream', body, { headers: [header('Content-Type', 'application/json')] });
    for (const f of r1.frames) vm.socket.send(f);
    const e1 = await vm.nextEvent();
    assert.deepEqual(
      { kind: e1.kind, verb: e1.verb, path: e1.path, end: e1.end_body, sid: e1.stream_id, body: e1.body },
      { kind: 'request', verb: 'POST', path: '/chat/stream', end: true, sid: 1, body: new TextDecoder().decode(body) },
    );
    assert.deepEqual(e1.headers, [['Content-Type', 'application/json']]);
    // Python-encrypted ack and trailing chunk -> JS decrypts both.
    const ack = await t.decryptFrame(await recv());
    assert.equal(ack.kind, 'response');
    assert.equal(ack.value.status, 200);
    assert.equal(ack.value.endBody, true);
    assert.deepEqual(JSON.parse(new TextDecoder().decode(ack.value.body)), { result: { message_id: 'py-1' } });
    const extra = await t.decryptFrame(await recv());
    assert.equal(extra.kind, 'body_chunk');

    // A 150 KB body spans three Noise transport frames; Python reassembles it.
    const big = new Uint8Array(150_000).map((_, i) => (i * 13) & 0xff);
    const r2 = await t.encryptHttpRequest('PUT', '/big', big);
    assert.equal(r2.frames.length, 3);
    for (const f of r2.frames) vm.socket.send(f);
    assert.equal((await vm.nextEvent()).partial, true);
    assert.equal((await vm.nextEvent()).partial, true);
    const e2 = await vm.nextEvent();
    assert.equal(e2.body_len, big.length);
    assert.equal(e2.body_sha256, sha(big));
    assert.equal((await t.decryptFrame(await recv())).value.status, 200);
    await t.decryptFrame(await recv());

    // Reset frames decode in Python too.
    for (const f of await t.encryptReset(2n, { reason: 'request ended' })) vm.socket.send(f);
    assert.deepEqual(await vm.nextEvent(), { stream_id: 2, kind: 'reset', code: 1, reason: 'request ended' });
  } finally {
    vm.socket.close();
    assert.equal(await vm.exited, 0, vm.stderr());
  }
});

test('MuseSession.sendChat against the Python VM: ack resolves, data after it is not read', { skip, timeout: 60_000 }, async () => {
  const vm = startPythonVm();
  try {
    const upgrades = [];
    const session = await MuseSession.connect({
      noiseHost: 'interop.invalid',
      vmId: 'vm-1',
      vmAuthToken: 'not-a-real-token',
      deviceId: 'dev-1',
      connect: async (url, headers) => {
        upgrades.push({ url, headers });
        return vm.socket;
      },
    });
    assert.equal(upgrades[0].url, 'wss://interop.invalid/v1/noise?vm_id=vm-1');
    assert.equal((await vm.nextEvent()).handshake, 'ok');

    const result = await session.sendChat('hello from JS', { sessionId: 'side-1' });
    assert.deepEqual(result, { ok: true, status: 200, response: { result: { message_id: 'py-1' } } });
    const seen = await vm.nextEvent();
    assert.equal(seen.path, '/chat/stream');
    assert.equal(
      seen.body,
      '{"message": "hello from JS", "output_modality": "text", "device_id": "dev-1", "session_id": "side-1"}',
    );
    assert.deepEqual(seen.headers.map(([k]) => k), ['Content-Type', 'x-request-id', 'x-app-id']);

    // A >64 KiB message goes as head + 16 KiB chunks; Python sees all of it.
    const long = 'x'.repeat(70_000);
    const r2 = await session.sendChat(long);
    assert.deepEqual(r2.response, { result: { message_id: 'py-2' } });
    const head = await vm.nextEvent();
    assert.equal(head.end_body, false);
    let total = 0;
    for (;;) {
      const c = await vm.nextEvent();
      assert.equal(c.kind, 'body_chunk');
      assert.ok(c.data_len <= 16 * 1024);
      total += c.data_len;
      if (c.end_body) break;
    }
    assert.equal(total, chatRequestBody({ message: long, deviceId: 'dev-1' }).length);
    assert.equal(session._requests.size, 0);
    session.close();
  } finally {
    vm.socket.close();
    assert.equal(await vm.exited, 0, vm.stderr());
  }
});
