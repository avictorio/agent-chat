// Derived from facebookincubator/muse-gadget-sdk at commit e17081a
// (linux/src/musegadget/noise/_proto.py). Copyright (c) Meta Platforms, Inc.
// and affiliates. Licensed under the Apache License, Version 2.0; see
// LICENSE-muse-gadget-sdk and NOTICE. Modified: ported from Python to JavaScript, then TypeScript.
//
// Hand-rolled protobuf wire encoding, as the SDK does. Varints are BigInt so
// the full uint64 / int64 range round-trips exactly.

import { ProtoError } from './errors.js';

export const WIRE_VARINT = 0;
export const WIRE_FIXED64 = 1;
export const WIRE_DELIMITED = 2;
export const WIRE_FIXED32 = 5;

export const MAX_FIELD_NUMBER = (1 << 29) - 1;
export const FIRST_RESERVED_FIELD_NUMBER = 19000;
export const LAST_RESERVED_FIELD_NUMBER = 19999;

const U64_LIMIT = 1n << 64n;
const I64_MIN = -(1n << 63n);
const I64_MAX = (1n << 63n) - 1n;
const I32_MIN = -(1n << 31n);
const I32_MAX = (1n << 31n) - 1n;
const VALID_WIRE_TYPES: ReadonlySet<number> = new Set([WIRE_VARINT, WIRE_FIXED64, WIRE_DELIMITED, WIRE_FIXED32]);

const utf8Encoder = new TextEncoder();

/** What the encoders accept as an integer. */
export type IntLike = bigint | number | boolean;

/** What toBytes() accepts: bytes, a buffer or view, or nothing (empty). */
export type BytesLike = Uint8Array | ArrayBuffer | ArrayBufferView | null | undefined;

function toBigInt(value: unknown): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isInteger(value)) return BigInt(value);
  if (typeof value === 'boolean') return value ? 1n : 0n;
  throw new ProtoError('integer value required');
}

function validFieldNumber(fieldNumber: number): boolean {
  return (
    fieldNumber !== 0 &&
    fieldNumber <= MAX_FIELD_NUMBER &&
    !(fieldNumber >= FIRST_RESERVED_FIELD_NUMBER && fieldNumber <= LAST_RESERVED_FIELD_NUMBER)
  );
}

/** Concatenate Uint8Arrays. */
export function concatBytes(...chunks: Uint8Array[]): Uint8Array<ArrayBuffer> {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

export function encodeVarint(value: IntLike): Uint8Array<ArrayBuffer> {
  let v = toBigInt(value);
  if (v < 0n) throw new ProtoError('varint value must be non-negative');
  if (v >= U64_LIMIT) throw new ProtoError('varint value exceeds uint64 range');
  const out: number[] = [];
  for (;;) {
    const byte = Number(v & 0x7fn);
    v >>= 7n;
    if (v) {
      out.push(byte | 0x80);
    } else {
      out.push(byte);
      return Uint8Array.from(out);
    }
  }
}

export function signedInt64Value(value: IntLike): bigint {
  const v = toBigInt(value);
  if (v < I64_MIN || v > I64_MAX) throw new ProtoError('int64 value out of range');
  return v & (U64_LIMIT - 1n);
}

export function signedInt32Value(value: IntLike): bigint {
  const v = toBigInt(value);
  if (v < I32_MIN || v > I32_MAX) throw new ProtoError('int32 value out of range');
  return v & (U64_LIMIT - 1n);
}

/** uint64 wire value (BigInt) -> signed int64 (BigInt). */
export function decodeInt64(value: bigint): bigint {
  if (value >= U64_LIMIT) throw new ProtoError('int64 wire value exceeds uint64 range');
  if (value >= 1n << 63n) return value - U64_LIMIT;
  return value;
}

/** uint64 wire value (BigInt) -> int32 (Number). */
export function decodeInt32(value: bigint): number {
  if (value >= U64_LIMIT) throw new ProtoError('int32 wire value exceeds uint64 range');
  const signed = value >= 1n << 63n ? value - U64_LIMIT : value;
  if (signed < I32_MIN || signed > I32_MAX) throw new ProtoError('int32 value out of range');
  return Number(signed);
}

/** uint64 wire value (BigInt) -> uint32 (Number). */
export function decodeUint32(value: bigint): number {
  if (value > 0xffffffffn) throw new ProtoError('uint32 value out of range');
  return Number(value);
}

export function encodeKey(fieldNumber: number, wireType: number): Uint8Array<ArrayBuffer> {
  if (!Number.isInteger(fieldNumber) || !validFieldNumber(fieldNumber)) {
    throw new ProtoError('invalid field number');
  }
  if (!VALID_WIRE_TYPES.has(wireType)) throw new ProtoError('invalid wire type');
  return encodeVarint((BigInt(fieldNumber) << 3n) | BigInt(wireType));
}

export function varintField(fieldNumber: number, value: IntLike): Uint8Array<ArrayBuffer> {
  return concatBytes(encodeKey(fieldNumber, WIRE_VARINT), encodeVarint(value));
}

export function int64Field(fieldNumber: number, value: IntLike): Uint8Array<ArrayBuffer> {
  return varintField(fieldNumber, signedInt64Value(value));
}

export function int32Field(fieldNumber: number, value: IntLike): Uint8Array<ArrayBuffer> {
  return varintField(fieldNumber, signedInt32Value(value));
}

export function uint32Field(fieldNumber: number, value: IntLike): Uint8Array<ArrayBuffer> {
  const v = toBigInt(value);
  if (v < 0n || v > 0xffffffffn) throw new ProtoError('uint32 value out of range');
  return varintField(fieldNumber, v);
}

export function boolField(fieldNumber: number, value: unknown): Uint8Array<ArrayBuffer> {
  return varintField(fieldNumber, value ? 1n : 0n);
}

export function delimitedField(fieldNumber: number, payload: Uint8Array): Uint8Array<ArrayBuffer> {
  return concatBytes(encodeKey(fieldNumber, WIRE_DELIMITED), encodeVarint(payload.length), payload);
}

export function stringField(fieldNumber: number, value: string): Uint8Array<ArrayBuffer> {
  if (typeof value !== 'string') throw new ProtoError('string value required');
  return delimitedField(fieldNumber, utf8Encoder.encode(value));
}

export function bytesField(fieldNumber: number, value: BytesLike): Uint8Array<ArrayBuffer> {
  return delimitedField(fieldNumber, toBytes(value));
}

/** Coerce a byte-ish value to Uint8Array (copying views is unnecessary). */
export function toBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (value === undefined || value === null) return new Uint8Array(0);
  throw new ProtoError('bytes value required');
}

/** Returns [value: BigInt, offset]. */
export function readVarint(data: Uint8Array, offset: number): [bigint, number] {
  let value = 0n;
  let shift = 0n;
  for (let i = 0; i < 10; i++) {
    if (offset >= data.length) throw new ProtoError('truncated varint');
    const byte = data[offset];
    offset += 1;
    if (i === 9 && (byte & 0xfe) !== 0) throw new ProtoError('malformed varint');
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return [value, offset];
    shift += 7n;
  }
  throw new ProtoError('malformed varint');
}

/** Returns [fieldNumber, wireType, offset]. */
export function readKey(data: Uint8Array, offset: number): [number, number, number] {
  const [key, next] = readVarint(data, offset);
  const fieldNumberBig = key >> 3n;
  const wireType = Number(key & 0x07n);
  if (fieldNumberBig > BigInt(MAX_FIELD_NUMBER)) throw new ProtoError('invalid field number');
  const fieldNumber = Number(fieldNumberBig);
  if (!validFieldNumber(fieldNumber)) throw new ProtoError('invalid field number');
  if (!VALID_WIRE_TYPES.has(wireType)) throw new ProtoError('invalid wire type');
  return [fieldNumber, wireType, next];
}

/** Returns [bytes (subarray view), offset]. */
export function readDelimited(data: Uint8Array, offset: number): [Uint8Array, number] {
  const [length, next] = readVarint(data, offset);
  const end = BigInt(next) + length;
  if (end > BigInt(data.length)) throw new ProtoError('truncated delimited field');
  return [data.subarray(next, Number(end)), Number(end)];
}

export function skipField(data: Uint8Array, offset: number, wireType: number): number {
  if (wireType === WIRE_VARINT) return readVarint(data, offset)[1];
  if (wireType === WIRE_FIXED64) {
    const end = offset + 8;
    if (end > data.length) throw new ProtoError('truncated fixed64 field');
    return end;
  }
  if (wireType === WIRE_DELIMITED) return readDelimited(data, offset)[1];
  if (wireType === WIRE_FIXED32) {
    const end = offset + 4;
    if (end > data.length) throw new ProtoError('truncated fixed32 field');
    return end;
  }
  throw new ProtoError('invalid wire type');
}
