import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StreamingRequest, readNdjson, MAX_SEND_BYTES } from '../../worker/bridge/muse/streaming.ts';
import { HTTPStatusError } from '../../worker/bridge/muse/errors.ts';
import { FakeVm } from './helpers/fake-vm.mjs';
import { MuseSession } from '../../worker/bridge/muse/session.ts';
import { ServiceFrame } from '../../worker/bridge/muse/envelope.ts';

const utf8 = (s) => new TextEncoder().encode(s);
const head = (status, body = '', endBody = false) => ({ kind: 'response', value: { status, headers: [], body: utf8(body), endBody } });
const chunk = (data, endBody = false) => ({ kind: 'body_chunk', value: { data: utf8(data), endBody } });

function fakeSession() {
  return { sent: [], unregistered: [], sendEncrypted: async () => {}, transport: {}, unregister(id) { this.unregistered.push(id); } };
}

test('reads chunks in order and ends cleanly', async () => {
  const s = new StreamingRequest(fakeSession(), 1n);
  s.onFrame(head(200, 'a'));
  s.onFrame(chunk('b', true));
  assert.equal(await s.waitResponse(), 200);
  const parts = [];
  for await (const c of s) parts.push(new TextDecoder().decode(c));
  assert.deepEqual(parts, ['a', 'b']);
});

test('buffer bounds, ordering rules and data after EOF fail the stream', async () => {
  let s = new StreamingRequest(fakeSession(), 1n, { maxBufferBytes: 3 });
  s.onFrame(head(200, 'abcd'));
  await assert.rejects(s.read(), /buffer full/);

  s = new StreamingRequest(fakeSession(), 1n, { maxBufferChunks: 1 });
  s.onFrame(head(200, 'a'));
  s.onFrame(chunk('b'));
  await assert.rejects(s.read(), /buffer full/);

  s = new StreamingRequest(fakeSession(), 1n);
  s.onFrame(chunk('x'));
  await assert.rejects(s.waitResponse(), /before head/);

  s = new StreamingRequest(fakeSession(), 1n);
  s.onFrame(head(200, '', true));
  s.onFrame(chunk('x'));
  await assert.rejects(s.read(), /after EOF/);

  s = new StreamingRequest(fakeSession(), 1n);
  s.onFrame(head(200));
  s.onFrame(head(200));
  await assert.rejects(s.read(), /duplicate response head/);

  s = new StreamingRequest(fakeSession(), 1n);
  s.onFrame({ kind: 'reset', value: { code: 1, reason: '' } });
  await assert.rejects(s.read(), /reset/);
});

test('non-2xx raises HTTPStatusError with a bounded body and no body in the message', async () => {
  const s = new StreamingRequest(fakeSession(), 1n);
  s.onFrame(head(500, 'secret body', true));
  const err = await s.waitResponse().catch((e) => e);
  assert.ok(err instanceof HTTPStatusError);
  assert.equal(err.status, 500);
  assert.equal(new TextDecoder().decode(err.body), 'secret body');
  assert.ok(!err.message.includes('secret'));
});

test('send limits', async () => {
  const s = new StreamingRequest(fakeSession(), 1n);
  await assert.rejects(s.sendBody(new Uint8Array(MAX_SEND_BYTES + 1)), /exceeds 64 KiB/);
  await s.sendBody(utf8('x'), { endBody: true });
  await assert.rejects(s.sendBody(utf8('y')), /already closed/);
});

test('readNdjson: fragments, CRLF, blank lines and its failure modes', async () => {
  async function* chunks(...parts) {
    for (const p of parts) yield utf8(p);
  }
  const out = [];
  for await (const r of readNdjson(chunks('{"a":', '1}\r\n\n{"b"', ':2}\n'))) out.push(r);
  assert.deepEqual(out, [{ a: 1 }, { b: 2 }]);
  const drain = async (it) => {
    for await (const _ of it);
  };
  await assert.rejects(drain(readNdjson(chunks('{"a":1}'))), /within an NDJSON record/);
  await assert.rejects(drain(readNdjson(chunks('[1]\n'))), /must be an object/);
  await assert.rejects(drain(readNdjson(chunks('nope\n'))), /invalid NDJSON/);
  await assert.rejects(drain(readNdjson(chunks('{"a":"xxxxxxxx"}\n'), { maxLineBytes: 5 })), /too large/);
});

test('session.streamRequest: duplex upload and close resets the stream', async () => {
  const vm = new FakeVm();
  const session = await MuseSession.connect({ vmId: 'v', vmAuthToken: 't', deviceId: 'd', connect: vm.connect });
  const s = await session.streamRequest('POST', '/up');
  const start = await vm.nextFrame();
  assert.equal(start.value.endBody, false);
  await s.sendBody(utf8('part'));
  assert.equal(new TextDecoder().decode((await vm.nextFrame()).value.data), 'part');
  await vm.sendFrame(ServiceFrame.response(s.streamId, { status: 200, body: utf8('ok') }));
  assert.equal(await s.waitResponse(), 200);
  await s.close();
  const reset = await vm.nextFrame();
  assert.equal(reset.kind, 'reset');
  assert.equal(reset.value.reason, 'client closed stream');
  assert.equal(session._requests.size, 0);
  session.close();
});
