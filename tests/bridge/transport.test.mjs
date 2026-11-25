import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CipherState } from '../../worker/bridge/muse/noise.ts';
import { NoiseTransport, decodeRequestEnvelope, encodeResponseEnvelope, EMPTY_AD } from '../../worker/bridge/muse/transport.ts';
import { NoiseFrameDecoder, encodeNoiseFrames, MAX_CHUNK_PAYLOAD } from '../../worker/bridge/muse/framing.ts';
import { ServiceFrame, ServiceType, decodeServiceRequest, ResetCode } from '../../worker/bridge/muse/envelope.ts';

async function pair() {
  const k1 = crypto.getRandomValues(new Uint8Array(32));
  const k2 = crypto.getRandomValues(new Uint8Array(32));
  const mk = async (k) => {
    const c = new CipherState();
    await c.initializeKey(k);
    return c;
  };
  const client = new NoiseTransport(await mk(k1), await mk(k2));
  const server = { recv: await mk(k1), send: await mk(k2), decoder: new NoiseFrameDecoder() };
  server.read = async (frames) => {
    let out = null;
    for (const f of frames) out = server.decoder.decode(await server.recv.decryptWithAd(EMPTY_AD, f));
    return out;
  };
  server.write = async (frame) => {
    const out = [];
    for (const f of encodeNoiseFrames(encodeResponseEnvelope(frame))) out.push(await server.send.encryptWithAd(EMPTY_AD, f));
    return out;
  };
  return { client, server };
}

test('stream ids increase from 1 and requests decode on the server', async () => {
  const { client, server } = await pair();
  const a = await client.encryptHttpRequest('POST', '/a', Uint8Array.of(1), { headers: [{ key: 'k', value: 'v' }] });
  const b = await client.startStreamRequest('GET', '/b');
  assert.equal(a.streamId, 1n);
  assert.equal(b.streamId, 2n);
  const fa = decodeRequestEnvelope(await server.read(a.frames));
  assert.equal(fa.value.path, '/a');
  assert.equal(fa.value.endBody, true);
  const fb = decodeRequestEnvelope(await server.read(b.frames));
  assert.equal(fb.value.endBody, false);
  const chunk = decodeRequestEnvelope(await server.read(await client.encryptBodyChunk(2n, Uint8Array.of(7), { endBody: true })));
  assert.equal(chunk.kind, 'body_chunk');
  const reset = decodeRequestEnvelope(await server.read(await client.encryptReset(2n, { reason: 'bye' })));
  assert.deepEqual(reset.value, { code: ResetCode.CANCELLED, reason: 'bye' });
});

test('service selection', async () => {
  const { client, server } = await pair();
  const r = await client.encryptHttpRequest('GET', '/v', undefined, { service: 'vault' });
  const plain = await server.read(r.frames);
  assert.equal(decodeServiceRequest(plain).service, ServiceType.SERVICE_VAULT);
  await assert.rejects(client.encryptHttpRequest('GET', '/x', undefined, { service: 'nope' }), /unknown noise service/);
  assert.equal(client.dead, true);
  await assert.rejects(client.encryptHttpRequest('GET', '/x'), /dead/);
});

test('large requests are chunked and reassembled', async () => {
  const { client, server } = await pair();
  const body = new Uint8Array(MAX_CHUNK_PAYLOAD * 2 + 5).fill(3);
  const r = await client.encryptHttpRequest('PUT', '/big', body);
  assert.equal(r.frames.length, 3);
  const f = decodeRequestEnvelope(await server.read(r.frames));
  assert.equal(f.value.body.length, body.length);
});

test('server responses, chunks and resets decrypt; requests from the server are refused', async () => {
  const { client, server } = await pair();
  const resp = await client.decryptFrame((await server.write(ServiceFrame.response(1, { status: 200, endBody: true })))[0]);
  assert.equal(resp.kind, 'response');
  assert.equal(resp.value.status, 200);
  const empty = await client.decryptFrame((await server.write({ streamId: 1n, kind: null, value: null }))[0]);
  assert.equal(empty, null); // a ServiceFrame with no oneof set is ignored
  await assert.rejects(
    client.decryptFrame((await server.write(ServiceFrame.request(1, { verb: 'GET' })))[0]),
    /unexpected request frame/,
  );
  assert.equal(client.dead, true);
});
