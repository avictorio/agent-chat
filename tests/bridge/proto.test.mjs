import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as p from '../../worker/bridge/muse/proto.ts';
import { ProtoError } from '../../worker/bridge/muse/errors.ts';

test('varint round-trips across the uint64 range', () => {
  for (const v of [0n, 1n, 127n, 128n, 2n ** 53n + 1n, 2n ** 64n - 1n]) {
    const enc = p.encodeVarint(v);
    assert.deepEqual(p.readVarint(enc, 0), [v, enc.length]);
  }
  assert.throws(() => p.encodeVarint(-1n), ProtoError);
  assert.throws(() => p.encodeVarint(2n ** 64n), ProtoError);
  assert.throws(() => p.encodeVarint(1.5), ProtoError);
});

test('signed ranges are enforced', () => {
  assert.throws(() => p.int64Field(1, 2n ** 63n), ProtoError);
  assert.throws(() => p.int32Field(1, 2 ** 31), ProtoError);
  assert.throws(() => p.uint32Field(1, -1), ProtoError);
  assert.throws(() => p.uint32Field(1, 2 ** 32), ProtoError);
  assert.equal(p.decodeInt64(2n ** 64n - 1n), -1n);
  assert.equal(p.decodeInt32(2n ** 64n - 1n), -1);
  assert.throws(() => p.decodeInt32(2n ** 31n), ProtoError);
  assert.throws(() => p.decodeUint32(2n ** 32n), ProtoError);
});

test('keys: field numbers and wire types are validated both ways', () => {
  assert.throws(() => p.encodeKey(0, 0), ProtoError);
  assert.throws(() => p.encodeKey(19500, 0), ProtoError);
  assert.throws(() => p.encodeKey(2 ** 29, 0), ProtoError);
  assert.throws(() => p.encodeKey(1, 3), ProtoError);
  assert.deepEqual(p.readKey(p.encodeKey(5, 2), 0), [5, 2, 1]);
});

test('delimited fields and skipping are bounds-checked', () => {
  const f = p.delimitedField(2, Uint8Array.of(1, 2, 3));
  const [, , off] = p.readKey(f, 0);
  const [data, end] = p.readDelimited(f, off);
  assert.deepEqual([...data], [1, 2, 3]);
  assert.equal(end, f.length);
  assert.throws(() => p.readDelimited(Uint8Array.of(5, 1), 0), /truncated delimited/);
  assert.throws(() => p.skipField(Uint8Array.of(1, 2), 0, p.WIRE_FIXED64), /truncated fixed64/);
  assert.throws(() => p.skipField(Uint8Array.of(1), 0, p.WIRE_FIXED32), /truncated fixed32/);
  assert.equal(p.skipField(new Uint8Array(4), 0, p.WIRE_FIXED32), 4);
  // A huge declared length must not wrap or allocate.
  assert.throws(() => p.readDelimited(p.encodeVarint(2n ** 63n), 0), /truncated/);
});

test('strings are UTF-8', () => {
  assert.deepEqual([...p.stringField(1, 'é')], [0x0a, 2, 0xc3, 0xa9]);
  assert.throws(() => p.stringField(1, 5), ProtoError);
});
