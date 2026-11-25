import { test } from 'node:test';
import assert from 'node:assert/strict';

import { FakeVm } from './helpers/fake-vm.mjs';
import {
  MuseSession,
  sendChatOnce,
  acknowledgement,
  chatRequestBody,
  noiseUrl,
  validateAppId,
  workersWebSocketFactory,
  MAX_WS_MESSAGE_BYTES,
  CHAT_PATH,
} from '../../worker/bridge/muse/session.ts';
import { ServiceFrame, ResetCode } from '../../worker/bridge/muse/envelope.ts';
import { RequestRejected, UpgradeRejected, MuseConnectionError, MuseTimeoutError } from '../../worker/bridge/muse/errors.ts';

const TOKEN = 'vm-bearer-SECRET-123';
const utf8 = (s) => new TextEncoder().encode(s);
const text = (b) => new TextDecoder().decode(b);
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond, ms = 2000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('condition not reached');
    await tick(2);
  }
}

function makeLogger() {
  const lines = [];
  const add = (level) => (msg) => lines.push(`${level} ${msg}`);
  return { lines, info: add('info'), warn: add('warn'), error: add('error'), debug: add('debug') };
}

function options(vm, extra = {}) {
  return {
    noiseHost: 'hatch.example',
    vmId: 'vm-1',
    vmAuthToken: TOKEN,
    deviceId: 'homelink-abcdef',
    connect: vm.connect,
    ...extra,
  };
}

const ACK = utf8('{"result":{"message_id":"user-1"}}');

test('send_chat: upgrade headers, exact request, resolves on the ack, stops reading', async () => {
  const vm = new FakeVm();
  const logger = makeLogger();
  const message = 'porch light on 😀 "quoted"';
  const reply = sendChatOnce(options(vm, { logger, appId: '42' }), message, { sessionId: 'side-1' });

  await vm.handshakeDone;
  const request = await vm.nextFrame();

  // The upgrade: the SDK's URL and headers.
  assert.equal(vm.upgrades.length, 1);
  assert.equal(vm.upgrades[0].url, 'wss://hatch.example/v1/noise?vm_id=vm-1&app_id=42');
  assert.deepEqual(Object.keys(vm.upgrades[0].headers).sort(), ['Authorization', 'User-Agent']);
  assert.equal(vm.upgrades[0].headers.Authorization, `Bearer ${TOKEN}`);

  // No /link-control, no link.register: the first request is the chat post.
  assert.equal(request.kind, 'request');
  assert.equal(request.streamId, 1n);
  assert.equal(request.value.verb, 'POST');
  assert.equal(request.value.path, CHAT_PATH);
  assert.equal(request.value.endBody, true);
  const expected =
    '{"message": "porch light on \\ud83d\\ude00 \\"quoted\\"", "output_modality": "text", ' +
    '"device_id": "homelink-abcdef", "session_id": "side-1"}';
  assert.equal(text(request.value.body), expected);
  const headers = request.value.headers.map((h) => [h.key, h.value]);
  assert.deepEqual(headers.map(([k]) => k), ['Content-Type', 'x-request-id', 'x-app-id']);
  assert.equal(headers[0][1], 'application/json');
  assert.match(headers[1][1], /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(headers[2][1], 'musegadget');

  // The ack, then more data on the same stream and a new stream.
  await vm.sendFrame(ServiceFrame.response(request.streamId, { status: 200, body: ACK, endBody: true }));
  const result = await reply;
  assert.deepEqual(result, { ok: true, status: 200, response: { result: { message_id: 'user-1' } } });
  assert.deepEqual(acknowledgement(result), { result: { message_id: 'user-1' } });

  // sendChatOnce closed the socket right after the ack.
  assert.equal(vm.clientClosed, true);
  assert.equal(vm.socket.closeCalls.length, 1);
  await vm.sendFrame(ServiceFrame.bodyChunk(request.streamId, { data: utf8('reply text that must not be read') }));
  await vm.sendFrame(ServiceFrame.response(7n, { status: 200, body: utf8('x'), endBody: true }));
  await waitFor(() => vm.droppedAfterClose === 2);
  assert.deepEqual(vm.errors, []);

  // Logs carry neither the bearer nor the message.
  const all = logger.lines.join('\n');
  assert.ok(!all.includes(TOKEN));
  assert.ok(!all.includes('porch'));
});

test('send_chat on an open session: data after the ack is dropped, not accumulated', async () => {
  const vm = new FakeVm();
  const session = await MuseSession.connect(options(vm));
  const reply = session.sendChat('hello');
  const request = await vm.nextFrame();
  assert.equal(text(request.value.body), '{"message": "hello", "output_modality": "text", "device_id": "homelink-abcdef"}');

  // Head first, then the rest of the ack body in chunks.
  await vm.sendFrame(ServiceFrame.response(request.streamId, { status: 200, body: utf8('{"message_id"') }));
  await vm.sendFrame(ServiceFrame.bodyChunk(request.streamId, { data: utf8(':"m-1"}'), endBody: true }));
  assert.deepEqual(await reply, { ok: true, status: 200, response: { message_id: 'm-1' } });

  const before = session.framesReceived;
  await vm.sendFrame(ServiceFrame.bodyChunk(request.streamId, { data: new Uint8Array(50_000) }));
  await vm.sendFrame(ServiceFrame.bodyChunk(request.streamId, { data: new Uint8Array(50_000), endBody: true }));
  // Decrypted to keep nonces in step, but nothing is registered for the stream.
  await waitFor(() => session.framesReceived === before + 2);
  await tick(20);
  assert.equal(session.framesReceived, before + 2);
  assert.equal(session._requests.size, 0);
  assert.equal(session.running, true);

  // A second chat still works on the same session (stream 2).
  const second = session.sendChat('again', { device: 'mcu-wearable', outputModality: 'voice' });
  const r2 = await vm.nextFrame();
  assert.equal(r2.streamId, 2n);
  assert.equal(
    text(r2.value.body),
    '{"message": "again", "output_modality": "voice", "device_id": "homelink-abcdef", "device": "mcu-wearable"}',
  );
  await vm.sendFrame(ServiceFrame.response(r2.streamId, { status: 200, body: utf8('{}'), endBody: true }));
  assert.equal((await second).ok, true);
  session.close();
  assert.equal(await session.ended.promise, 'stopped');
});

test('send_chat: a refused request returns ok=false and acknowledgement throws', async () => {
  const vm = new FakeVm();
  const session = await MuseSession.connect(options(vm));
  const reply = session.sendChat('hi');
  const req = await vm.nextFrame();
  await vm.sendFrame(ServiceFrame.response(req.streamId, { status: 429, body: utf8('slow down'), endBody: true }));
  const result = await reply;
  assert.deepEqual(result, { ok: false, status: 429, response: 'slow down' });
  assert.throws(() => acknowledgement(result), RequestRejected);
  session.close();
});

test('send_chat: stream reset, body before head, duplicate head fail the request only', async () => {
  const vm = new FakeVm();
  const session = await MuseSession.connect(options(vm));

  let reply = session.sendChat('a');
  let req = await vm.nextFrame();
  await vm.sendFrame(ServiceFrame.reset(req.streamId, { code: ResetCode.INTERNAL_ERROR, reason: 'secret detail' }));
  await assert.rejects(reply, (err) => err instanceof MuseConnectionError && !err.message.includes('secret'));
  // Like the SDK, an incomplete request is reset by the client even after a server reset.
  assert.equal((await vm.nextFrame()).kind, 'reset');

  reply = session.sendChat('b');
  req = await vm.nextFrame();
  await vm.sendFrame(ServiceFrame.bodyChunk(req.streamId, { data: utf8('x') }));
  await assert.rejects(reply, /response body before head/);
  // The SDK resets an abandoned stream.
  const reset = await vm.nextFrame();
  assert.equal(reset.kind, 'reset');
  assert.equal(reset.streamId, req.streamId);
  assert.equal(reset.value.reason, 'request ended');
  assert.equal(reset.value.code, ResetCode.CANCELLED);

  reply = session.sendChat('c');
  req = await vm.nextFrame();
  await vm.sendFrame(ServiceFrame.response(req.streamId, { status: 200 }));
  await vm.sendFrame(ServiceFrame.response(req.streamId, { status: 200, endBody: true }));
  await assert.rejects(reply, /duplicate response head/);
  await vm.nextFrame(); // reset

  reply = session.sendChat('d');
  req = await vm.nextFrame();
  await vm.sendFrame(ServiceFrame.response(req.streamId, { status: 99, endBody: true }));
  await assert.rejects(reply, /invalid or duplicate response head/);
  assert.equal(session.running, true);
  session.close();
});

test('send_chat: response bodies over 1 MiB are refused', async () => {
  const vm = new FakeVm();
  const session = await MuseSession.connect(options(vm));
  const reply = session.sendChat('x');
  const req = await vm.nextFrame();
  await vm.sendFrame(ServiceFrame.response(req.streamId, { status: 200 }));
  for (let i = 0; i < 17; i++) {
    await vm.sendFrame(ServiceFrame.bodyChunk(req.streamId, { data: new Uint8Array(64 * 1024) }));
  }
  await assert.rejects(reply, /response too large/);
  session.close();
});

test('send_chat: times out, then resets the stream', async () => {
  const vm = new FakeVm();
  const session = await MuseSession.connect(options(vm, { requestTimeoutMs: 30 }));
  const reply = session.sendChat('x');
  const req = await vm.nextFrame();
  await assert.rejects(reply, MuseTimeoutError);
  const reset = await vm.nextFrame();
  assert.equal(reset.kind, 'reset');
  assert.equal(reset.streamId, req.streamId);
  session.close();
});

test('send_chat: bodies over 64 KiB go as a stream head plus 16 KiB chunks', async () => {
  const vm = new FakeVm();
  const session = await MuseSession.connect(options(vm));
  const message = 'm'.repeat(100_000);
  const reply = session.sendChat(message);
  const head = await vm.nextFrame();
  assert.equal(head.kind, 'request');
  assert.equal(head.value.endBody, false);
  assert.equal(head.value.body.length, 0);
  const parts = [];
  for (;;) {
    const f = await vm.nextFrame();
    assert.equal(f.kind, 'body_chunk');
    assert.equal(f.streamId, head.streamId);
    assert.ok(f.value.data.length <= 16 * 1024);
    parts.push(text(f.value.data));
    if (f.value.endBody) break;
  }
  assert.equal(parts.join(''), text(chatRequestBody({ message, deviceId: 'homelink-abcdef' })));
  await vm.sendFrame(ServiceFrame.response(head.streamId, { status: 200, body: ACK, endBody: true }));
  assert.equal((await reply).ok, true);
  session.close();
});

test('session: refuses to send before it is connected or after close', async () => {
  const vm = new FakeVm();
  const session = new MuseSession(options(vm));
  await assert.rejects(session.sendChat('x'), /not connected/);
  await session.open();
  session.close();
  await assert.rejects(session.sendChat('x'), /not connected/);
  await assert.rejects(session.open(), /only run once/);
});

test('session: VM close fails pending requests', async () => {
  const vm = new FakeVm();
  const session = await MuseSession.connect(options(vm));
  const reply = session.sendChat('x');
  await vm.nextFrame();
  vm.closeFromServer();
  await assert.rejects(reply, /session ended/);
  assert.equal(await session.ended.promise, 'closed');
});

test('session: a corrupted frame from the VM ends the session', async () => {
  const vm = new FakeVm();
  const session = await MuseSession.connect(options(vm));
  const reply = session.sendChat('x');
  await vm.nextFrame();
  vm.sendRaw(new Uint8Array(40)); // not a valid AES-GCM ciphertext under the session key
  await assert.rejects(reply, /session ended/);
  assert.equal(session.closed, true);
  assert.equal(session.transport.dead, true);
});

test('session: text frames after the handshake are ignored; oversize messages are fatal', async () => {
  const vm = new FakeVm();
  const logger = makeLogger();
  const session = await MuseSession.connect(options(vm, { logger }));
  vm.sendRaw('hello');
  await waitFor(() => logger.lines.some((l) => l.includes('ignoring text frame')));
  assert.equal(session.running, true);
  assert.ok(logger.lines.some((l) => l.includes('ignoring text frame')));
  const reply = session.sendChat('x');
  await vm.nextFrame();
  vm.sendRaw(new Uint8Array(MAX_WS_MESSAGE_BYTES + 1));
  await assert.rejects(reply, /too large/);
  assert.equal(session.closed, true);
});

test('handshake: a text frame instead of message 2 fails', async () => {
  const vm = new FakeVm({ msg2Override: () => 'not binary' });
  await assert.rejects(MuseSession.connect(options(vm)), /text frame/);
  assert.equal(vm.socket.readyState, 3);
});

test('handshake: a short or tampered message 2 fails', async () => {
  const short = new FakeVm({ msg2Override: (m) => m.subarray(0, 50) });
  await assert.rejects(MuseSession.connect(options(short)), /message 2 too short/);
  const tampered = new FakeVm({
    msg2Override: (m) => {
      const c = new Uint8Array(m);
      c[40] ^= 1;
      return c;
    },
  });
  await assert.rejects(MuseSession.connect(options(tampered)), /decrypt failed/);
  const lowOrder = new FakeVm({
    msg2Override: (m) => {
      const c = new Uint8Array(m);
      c.fill(0, 0, 32);
      return c;
    },
  });
  await assert.rejects(MuseSession.connect(options(lowOrder)), /low-order/);
});

test('handshake: times out when the VM never answers', async () => {
  const vm = new FakeVm({ msg2Override: () => null });
  vm.socket = null;
  const silent = {
    connect: async (url, headers) => {
      const s = await vm.connect(url, headers);
      s.peer = { _fromClient() {}, _clientClosed() {} };
      return s;
    },
  };
  await assert.rejects(MuseSession.connect(options(vm, { connect: silent.connect, handshakeTimeoutMs: 30 })), MuseTimeoutError);
});

test('upgrade rejection surfaces the status without the token', async () => {
  const vm = new FakeVm({ rejectStatus: 401 });
  const err = await MuseSession.connect(options(vm)).catch((e) => e);
  assert.ok(err instanceof UpgradeRejected);
  assert.equal(err.status, 401);
  assert.ok(!String(err.message).includes(TOKEN));
  assert.ok(!String(err.stack).includes(TOKEN));
});

test('workersWebSocketFactory: fetch upgrade with https URL, Upgrade header, accept()', async () => {
  const calls = [];
  let accepted = false;
  const fakeWs = { accept: () => (accepted = true) };
  const factory = workersWebSocketFactory({
    fetch: async (url, init) => {
      calls.push({ url, init });
      return { status: 101, webSocket: fakeWs };
    },
  });
  const ws = await factory(noiseUrl('hatch.example', 'vm 1'), { Authorization: 'Bearer t', 'User-Agent': 'ua' });
  assert.equal(ws, fakeWs);
  assert.equal(accepted, true);
  assert.equal(calls[0].url, 'https://hatch.example/v1/noise?vm_id=vm%201');
  assert.deepEqual(calls[0].init.headers, { Authorization: 'Bearer t', 'User-Agent': 'ua', Upgrade: 'websocket' });

  const refusing = workersWebSocketFactory({ fetch: async () => ({ status: 403, webSocket: null, body: null }) });
  const err = await refusing('wss://h/v1/noise?vm_id=v', {}).catch((e) => e);
  assert.ok(err instanceof UpgradeRejected);
  assert.equal(err.status, 403);
  const failing = workersWebSocketFactory({ fetch: async () => ({ status: 502, webSocket: null }) });
  await assert.rejects(failing('wss://h/x', {}), /HTTP 502/);
});

test('chatRequestBody: optional fields follow the SDK rules', () => {
  const body = (o) => text(chatRequestBody({ message: 'm', deviceId: 'd', ...o }));
  assert.equal(body({}), '{"message": "m", "output_modality": "text", "device_id": "d"}');
  assert.equal(body({ sessionId: '' }), '{"message": "m", "output_modality": "text", "device_id": "d"}');
  assert.equal(body({ device: '' }), '{"message": "m", "output_modality": "text", "device_id": "d", "device": ""}');
  assert.throws(() => chatRequestBody({ message: 1, deviceId: 'd' }), TypeError);
  assert.throws(() => chatRequestBody({ message: 'm' }), TypeError);
});

test('validateAppId normalises like the SDK', () => {
  assert.equal(validateAppId('007'), '7');
  assert.equal(validateAppId('hatch-web'), 'hatch-web');
  assert.throws(() => validateAppId(7), RangeError);
});
