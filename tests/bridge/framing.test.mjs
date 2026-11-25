import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fr from '../../worker/bridge/muse/framing.ts';

const frame = (o) => fr.encodeNoiseFrame(o);

test('encode/decode with defaults', () => {
  assert.equal(frame({}).length, 2); // total_chunks=1 is written, the rest omitted
  assert.deepEqual(fr.decodeNoiseFrame(new Uint8Array(0)), {
    chunkId: 0n,
    chunkIndex: 0,
    totalChunks: 1,
    payload: new Uint8Array(0),
  });
  const d = fr.decodeNoiseFrame(frame({ chunkId: -5n, chunkIndex: 1, totalChunks: 2, payload: Uint8Array.of(9) }));
  assert.equal(d.chunkId, -5n);
  assert.equal(d.chunkIndex, 1);
});

test('random chunk ids are int64', () => {
  const ids = new Set(Array.from({ length: 50 }, fr.randomInt64));
  assert.ok(ids.size > 45);
  for (const id of ids) assert.ok(id >= -(2n ** 63n) && id < 2n ** 63n);
});

test('chunk payload and chunk count limits', () => {
  const d = new fr.NoiseFrameDecoder();
  assert.throws(
    () => d.decode(frame({ chunkId: 1n, payload: new Uint8Array(fr.MAX_CHUNK_PAYLOAD + 1) })),
    /payload too large/,
  );
  assert.throws(() => fr.encodeNoiseFrames(new Uint8Array(fr.MAX_CHUNK_PAYLOAD * fr.MAX_TOTAL_CHUNKS + 1)), /too large/);
  assert.equal(fr.encodeNoiseFrames(new Uint8Array(fr.MAX_CHUNK_PAYLOAD * 2), 1n).length, 2);
});

test('poisoned after any failure', () => {
  const d = new fr.NoiseFrameDecoder();
  assert.throws(() => d.decode(frame({ chunkId: 1n, chunkIndex: 3, totalChunks: 2 })), /out of range/);
  assert.throws(() => d.decode(frame({ chunkId: 2n, payload: Uint8Array.of(1) })), /poisoned/);
});

test('assemblies expire after the TTL, freeing pending slots', () => {
  let now = 1000;
  const d = new fr.NoiseFrameDecoder({ now: () => now });
  for (let i = 0; i < fr.MAX_PENDING_ASSEMBLIES; i++) {
    const r = d.decode(frame({ chunkId: BigInt(i + 1), chunkIndex: 0, totalChunks: 2, payload: Uint8Array.of(i) }));
    assert.equal(r, null);
  }
  assert.equal(d.pendingCount, fr.MAX_PENDING_ASSEMBLIES);
  now += fr.ASSEMBLY_TTL_SECONDS + 1;
  assert.equal(d.decode(frame({ chunkId: 99n, chunkIndex: 0, totalChunks: 1, payload: Uint8Array.of(7) }))[0], 7);
  assert.equal(d.pendingCount, 0);
  // The second half of an expired message now starts a fresh assembly.
  assert.equal(d.decode(frame({ chunkId: 1n, chunkIndex: 1, totalChunks: 2, payload: Uint8Array.of(1) })), null);
});

test('largest legal assembly fits the byte budget (the SDK check is a backstop)', () => {
  // 256 chunks x 65489 bytes = 16,765,184 < MAX_ASSEMBLY_BYTES (16 MiB), so
  // with the per-chunk and chunk-count checks in place the budget cannot trip.
  assert.ok(fr.MAX_TOTAL_CHUNKS * fr.MAX_CHUNK_PAYLOAD <= fr.MAX_ASSEMBLY_BYTES);
  const d = new fr.NoiseFrameDecoder();
  const chunk = new Uint8Array(fr.MAX_CHUNK_PAYLOAD);
  let out = null;
  for (let i = 0; i < fr.MAX_TOTAL_CHUNKS; i++) {
    out = d.decode(frame({ chunkId: 4n, chunkIndex: i, totalChunks: fr.MAX_TOTAL_CHUNKS, payload: chunk }));
  }
  assert.equal(out.length, fr.MAX_TOTAL_CHUNKS * fr.MAX_CHUNK_PAYLOAD);
});
