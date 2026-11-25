// Derived from facebookincubator/muse-gadget-sdk at commit e17081a
// (linux/src/musegadget/noise/framing.py). Copyright (c) Meta Platforms, Inc.
// and affiliates. Licensed under the Apache License, Version 2.0; see
// LICENSE-muse-gadget-sdk and NOTICE. Modified: ported from Python to JavaScript, then TypeScript.
//
// NoiseTransportFrame: the chunking layer inside each Noise transport message.
//   1: chunk_id int64   2: chunk_index uint32   3: total_chunks uint32   4: payload bytes

import { ProtoError } from './errors.js';
import {
  WIRE_DELIMITED,
  WIRE_VARINT,
  bytesField,
  concatBytes,
  decodeInt64,
  decodeUint32,
  int64Field,
  readDelimited,
  readKey,
  readVarint,
  skipField,
  toBytes,
  uint32Field,
} from './proto.js';
import type { BytesLike } from './proto.js';

export const MAX_CHUNK_PAYLOAD = 65489;
export const MAX_PENDING_ASSEMBLIES = 16;
export const MAX_TOTAL_CHUNKS = 256;
export const MAX_ASSEMBLY_BYTES = 16 * 1024 * 1024;
export const ASSEMBLY_TTL_SECONDS = 60;

const I64_MIN = -(1n << 63n);
const I64_MAX = (1n << 63n) - 1n;

/** Uniform random int64 as BigInt (Python: secrets.randbits(64) shifted to signed). */
export function randomInt64() {
  const buf = new Uint8Array(8);
  crypto.getRandomValues(buf);
  return new DataView(buf.buffer).getBigInt64(0, false);
}

export interface NoiseTransportFrame {
  chunkId: bigint;
  chunkIndex: number;
  totalChunks: number;
  payload: Uint8Array;
}

/** makeNoiseFrame() input: any field may be left out. */
export interface NoiseFrameInit {
  chunkId?: bigint | number;
  chunkIndex?: number;
  totalChunks?: number;
  payload?: BytesLike;
}

interface Assembly {
  chunks: Map<number, Uint8Array>;
  total: number;
  totalBytes: number;
  createdAt: number;
  lastUpdated: number;
}

/** Defaults match the Python dataclass: chunk_id 0, chunk_index 0, total_chunks 1, payload b"". */
export function makeNoiseFrame({ chunkId = 0n, chunkIndex = 0, totalChunks = 1, payload = new Uint8Array(0) }: NoiseFrameInit = {}): NoiseTransportFrame {
  return { chunkId: BigInt(chunkId), chunkIndex, totalChunks, payload: toBytes(payload) };
}

export function encodeNoiseFrame(frame: NoiseFrameInit): Uint8Array<ArrayBuffer> {
  const f = makeNoiseFrame(frame);
  const parts: Uint8Array[] = [];
  if (f.chunkId !== 0n) parts.push(int64Field(1, f.chunkId));
  if (f.chunkIndex !== 0) parts.push(uint32Field(2, f.chunkIndex));
  if (f.totalChunks !== 0) parts.push(uint32Field(3, f.totalChunks));
  if (f.payload.length) parts.push(bytesField(4, f.payload));
  return concatBytes(...parts);
}

export function decodeNoiseFrame(input: BytesLike): NoiseTransportFrame {
  const data = toBytes(input);
  let chunkId = 0n;
  let chunkIndex = 0;
  let totalChunks = 1;
  let payload: Uint8Array = new Uint8Array(0);
  let offset = 0;
  while (offset < data.length) {
    let fieldNumber, wireType;
    [fieldNumber, wireType, offset] = readKey(data, offset);
    if (fieldNumber === 1) {
      if (wireType !== WIRE_VARINT) throw new ProtoError('NoiseTransportFrame.chunk_id wrong wire type');
      let raw;
      [raw, offset] = readVarint(data, offset);
      chunkId = decodeInt64(raw);
    } else if (fieldNumber === 2) {
      if (wireType !== WIRE_VARINT) throw new ProtoError('NoiseTransportFrame.chunk_index wrong wire type');
      let raw;
      [raw, offset] = readVarint(data, offset);
      chunkIndex = decodeUint32(raw);
    } else if (fieldNumber === 3) {
      if (wireType !== WIRE_VARINT) throw new ProtoError('NoiseTransportFrame.total_chunks wrong wire type');
      let raw;
      [raw, offset] = readVarint(data, offset);
      totalChunks = decodeUint32(raw);
    } else if (fieldNumber === 4) {
      if (wireType !== WIRE_DELIMITED) throw new ProtoError('NoiseTransportFrame.payload wrong wire type');
      [payload, offset] = readDelimited(data, offset);
    } else {
      offset = skipField(data, offset, wireType);
    }
  }
  return { chunkId, chunkIndex, totalChunks, payload };
}

/** Split data into encoded NoiseTransportFrames (plaintext; the transport encrypts each). */
export function encodeNoiseFrames(data: BytesLike, chunkId: bigint | number | null = null): Uint8Array<ArrayBuffer>[] {
  const payload = toBytes(data);
  const selected = chunkId === null || chunkId === undefined ? randomInt64() : BigInt(chunkId);
  const totalChunks = Math.max(1, Math.ceil(payload.length / MAX_CHUNK_PAYLOAD));
  if (totalChunks > MAX_TOTAL_CHUNKS) {
    throw new RangeError(
      `payload too large for noise framing (${payload.length} bytes, ${totalChunks} chunks > ${MAX_TOTAL_CHUNKS})`,
    );
  }
  if (!payload.length) {
    return [encodeNoiseFrame({ chunkId: selected, chunkIndex: 0, totalChunks: 1, payload })];
  }
  const frames: Uint8Array<ArrayBuffer>[] = [];
  for (let index = 0; index < totalChunks; index++) {
    const start = index * MAX_CHUNK_PAYLOAD;
    frames.push(
      encodeNoiseFrame({
        chunkId: selected,
        chunkIndex: index,
        totalChunks,
        payload: payload.subarray(start, start + MAX_CHUNK_PAYLOAD),
      }),
    );
  }
  return frames;
}

/** Reassembles chunked frames. Any failure poisons the decoder (as in the SDK). */
export class NoiseFrameDecoder {
  _pending: Map<bigint, Assembly>;
  _poisoned: boolean;
  _now: () => number;

  /** options.now() returns seconds (injectable for tests). */
  constructor({ now }: { now?: (() => number) | undefined } = {}) {
    this._pending = new Map(); // BigInt chunkId -> assembly
    this._poisoned = false;
    this._now = now ?? (() => Date.now() / 1000);
  }

  /** The reassembled message, or null while chunks are missing. */
  decode(frameBytes: BytesLike): Uint8Array | null {
    if (this._poisoned) throw new Error('NoiseFrameDecoder: poisoned after prior failure');
    try {
      const frame = decodeNoiseFrame(frameBytes);
      if (frame.chunkId < I64_MIN || frame.chunkId > I64_MAX) {
        throw new RangeError('chunkId outside int64 range');
      }
      if (frame.totalChunks < 1 || frame.totalChunks > MAX_TOTAL_CHUNKS) {
        throw new RangeError(`invalid totalChunks: ${frame.totalChunks}`);
      }
      if (frame.chunkIndex < 0 || frame.chunkIndex >= frame.totalChunks) {
        throw new RangeError(`chunkIndex ${frame.chunkIndex} out of range [0, ${frame.totalChunks})`);
      }
      if (frame.payload.length > MAX_CHUNK_PAYLOAD) {
        throw new RangeError(`payload too large for noise frame (${frame.payload.length} bytes)`);
      }

      this._evictExpired();

      let assembly = this._pending.get(frame.chunkId);
      if (assembly === undefined) {
        if (this._pending.size >= MAX_PENDING_ASSEMBLIES) {
          throw new RangeError('too many pending noise frame assemblies');
        }
        const now = this._now();
        assembly = { chunks: new Map(), total: frame.totalChunks, totalBytes: 0, createdAt: now, lastUpdated: now };
        this._pending.set(frame.chunkId, assembly);
      }

      if (assembly.total !== frame.totalChunks) {
        this._pending.delete(frame.chunkId);
        throw new RangeError(
          `inconsistent totalChunks for chunkId: expected ${assembly.total}, got ${frame.totalChunks}`,
        );
      }
      if (assembly.chunks.has(frame.chunkIndex)) {
        this._pending.delete(frame.chunkId);
        throw new RangeError(`duplicate chunkIndex ${frame.chunkIndex}`);
      }

      assembly.lastUpdated = this._now();
      assembly.totalBytes += frame.payload.length;
      if (assembly.totalBytes > MAX_ASSEMBLY_BYTES) {
        this._pending.delete(frame.chunkId);
        throw new RangeError('assembly exceeded byte budget');
      }

      assembly.chunks.set(frame.chunkIndex, frame.payload);
      if (assembly.chunks.size < assembly.total) return null;

      this._pending.delete(frame.chunkId);
      // Every index in [0, total) is present: indices are range-checked, unique, and there are total of them.
      if (assembly.total === 1) return assembly.chunks.get(0)!;
      const parts: Uint8Array[] = [];
      for (let i = 0; i < assembly.total; i++) parts.push(assembly.chunks.get(i)!);
      return concatBytes(...parts);
    } catch (err) {
      this._poisoned = true;
      throw err;
    }
  }

  get pendingCount() {
    return this._pending.size;
  }

  _evictExpired(): void {
    const now = this._now();
    for (const [chunkId, assembly] of this._pending) {
      if (now - assembly.createdAt > ASSEMBLY_TTL_SECONDS) this._pending.delete(chunkId);
    }
  }
}
