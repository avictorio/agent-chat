import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as env from '../../worker/bridge/muse/envelope.ts';
import * as p from '../../worker/bridge/muse/proto.ts';

const roundTrip = (f) => env.decodeServiceFrame(env.encodeServiceFrame(f));

test('frames of every kind round-trip', () => {
  const req = roundTrip(
    env.ServiceFrame.request(3, { verb: 'POST', path: '/p', headers: [env.header('a', 'b')], body: Uint8Array.of(1), endBody: true }),
  );
  assert.equal(req.kind, 'request');
  assert.equal(req.streamId, 3n);
  assert.deepEqual(req.value.headers, [{ key: 'a', value: 'b' }]);
  assert.equal(req.value.endBody, true);
  const res = roundTrip(env.ServiceFrame.response(-1, { status: 204 }));
  assert.equal(res.value.status, 204);
  assert.equal(res.streamId, -1n);
  const chunk = roundTrip(env.ServiceFrame.bodyChunk(9, { data: Uint8Array.of(5), endBody: true }));
  assert.deepEqual([...chunk.value.data], [5]);
  const reset = roundTrip(env.ServiceFrame.reset(9, { code: env.ResetCode.TIMEOUT, reason: 'r' }));
  assert.deepEqual(reset.value, { code: env.ResetCode.TIMEOUT, reason: 'r' });
  assert.deepEqual(roundTrip({ streamId: 0n, kind: null, value: null }), { streamId: 0n, kind: null, value: null });
});

test('encode refuses inconsistent frames', () => {
  assert.throws(() => env.encodeServiceFrame({ streamId: 1n, kind: null, value: {} }), /without kind/);
  assert.throws(() => env.encodeServiceFrame({ streamId: 1n, kind: 'bogus', value: {} }), /unknown ServiceFrame kind/);
  assert.throws(() => env.encodeServiceFrame({ streamId: 1n, kind: 'request', value: null }), /wrong type/);
  assert.throws(() => env.encodeReset({ code: 42 }), /unknown reset code/);
  assert.throws(() => env.encodeServiceRequest({ service: 9 }), /unknown service type/);
});

test('decode rejects wrong wire types, bad UTF-8 and unknown enums', () => {
  assert.throws(() => env.decodeHeader(p.varintField(1, 1)), /Header.key wrong wire type/);
  assert.throws(() => env.decodeHeader(p.delimitedField(2, Uint8Array.of(0xc3))), /invalid utf-8/);
  assert.throws(() => env.decodeBodyChunk(p.varintField(1, 1)), /BodyChunk.data/);
  assert.throws(() => env.decodeApplicationResponse(p.delimitedField(4, new Uint8Array(0))), /end_body wrong wire type/);
  assert.throws(() => env.decodeReset(p.int32Field(1, -1)), /unknown reset code/);
  assert.throws(() => env.decodeServiceRequest(p.varintField(1, 2n ** 40n)), /unknown service type/);
  assert.throws(() => env.decodeServiceResponse(p.varintField(1, 0)), /ServiceResponse.payload/);
});

test('a UTF-8 BOM in a string is kept, as Python does', () => {
  const h = env.decodeHeader(p.delimitedField(1, Uint8Array.of(0xef, 0xbb, 0xbf, 0x61)));
  assert.equal(h.key, '﻿a');
});
