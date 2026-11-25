// Derived from facebookincubator/muse-gadget-sdk at commit e17081a
// (linux/src/musegadget/noise/envelope.py). Copyright (c) Meta Platforms, Inc.
// and affiliates. Licensed under the Apache License, Version 2.0; see
// LICENSE-muse-gadget-sdk and NOTICE. Modified: ported from Python to JavaScript, then TypeScript.

//
// Service envelopes carried inside reassembled Noise frames:
//   client -> VM: ServiceRequest{1: service enum, 2: payload = ServiceFrame}
//   VM -> client: ServiceResponse{1: payload = ServiceFrame}
//   ServiceFrame{1: stream_id int64, oneof 2: request, 3: response, 4: body_chunk, 5: reset}
//
// JS shapes (field names camelCased, bytes are Uint8Array, stream ids BigInt):
//   Header {key, value}
//   ApplicationRequest {verb, path, headers, body, endBody}
//   ApplicationResponse {status, headers, body, endBody}
//   BodyChunk {data, endBody}
//   Reset {code, reason}
//   ServiceFrame {streamId, kind: 'request'|'response'|'body_chunk'|'reset'|null, value}

import { ProtoError } from './errors.js';
import {
  WIRE_DELIMITED,
  WIRE_VARINT,
  boolField,
  bytesField,
  concatBytes,
  decodeInt32,
  decodeInt64,
  delimitedField,
  int32Field,
  int64Field,
  readDelimited,
  readKey,
  readVarint,
  skipField,
  stringField,
  toBytes,
  varintField,
} from './proto.js';
import type { BytesLike } from './proto.js';

export const ServiceType = Object.freeze({
  SERVICE_DAEMON: 0,
  SERVICE_SENTINEL: 1,
  SERVICE_VAULT: 2,
  SERVICE_AUTHD: 3,
});

export const ResetCode = Object.freeze({
  CODE_UNSPECIFIED: 0,
  CANCELLED: 1,
  TIMEOUT: 2,
  PROTOCOL_ERROR: 3,
  REFUSED_STREAM: 4,
  INTERNAL_ERROR: 5,
  SERVICE_UNAVAILABLE: 6,
});

export interface Header {
  key: string;
  value: string;
}

export interface ApplicationRequest {
  verb: string;
  path: string;
  headers: Header[];
  body: Uint8Array;
  endBody: boolean;
}

export interface ApplicationResponse {
  status: number;
  headers: Header[];
  body: Uint8Array;
  endBody: boolean;
}

export interface BodyChunk {
  data: Uint8Array;
  endBody: boolean;
}

export interface Reset {
  code: number;
  reason: string;
}

export type ServiceFrameKind = 'request' | 'response' | 'body_chunk' | 'reset';

/** The ServiceFrame oneof: kind names the field that is set (null: none). */
export type ServiceFrameBody =
  | { kind: 'request'; value: ApplicationRequest }
  | { kind: 'response'; value: ApplicationResponse }
  | { kind: 'body_chunk'; value: BodyChunk }
  | { kind: 'reset'; value: Reset }
  | { kind: null; value: null };

export type ServiceFrame = { streamId: bigint } & ServiceFrameBody;

/** Constructor inputs: a field left out takes the Python dataclass default. */
export interface ApplicationRequestInit {
  verb?: string;
  path?: string;
  headers?: readonly Header[];
  body?: BytesLike;
  endBody?: boolean;
}

export interface ApplicationResponseInit {
  status?: number;
  headers?: readonly Header[];
  body?: BytesLike;
  endBody?: boolean;
}

export interface BodyChunkInit {
  data?: BytesLike;
  endBody?: boolean;
}

export interface ResetInit {
  code?: number;
  reason?: string;
}

/** What encodeServiceFrame() takes; kind and value are checked at run time. */
export interface ServiceFrameInit {
  streamId?: bigint | number;
  kind?: ServiceFrameKind | null;
  value?: (ApplicationRequestInit & ApplicationResponseInit & BodyChunkInit & ResetInit) | null;
}

const SERVICE_TYPES: ReadonlySet<number> = new Set(Object.values(ServiceType));
const RESET_CODES: ReadonlySet<number> = new Set(Object.values(ResetCode));
const EMPTY: Uint8Array = new Uint8Array(0);
const utf8Decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function decodeString(raw: Uint8Array): string {
  try {
    return utf8Decoder.decode(raw);
  } catch {
    throw new ProtoError('invalid utf-8 string');
  }
}

function coerceServiceType(value: unknown): number {
  const n = typeof value === 'bigint' ? (value <= 0xffffffffn ? Number(value) : -1) : Number(value);
  if (!SERVICE_TYPES.has(n)) throw new ProtoError('unknown service type');
  return n;
}

function coerceResetCode(value: unknown): number {
  const n = Number(value);
  if (!RESET_CODES.has(n)) throw new ProtoError('unknown reset code');
  return n;
}

// -- constructors with the Python dataclass defaults ---------------------------

export const header = (key = '', value = ''): Header => ({ key, value });

export function applicationRequest({ verb = '', path = '', headers = [], body = EMPTY, endBody = false }: ApplicationRequestInit = {}): ApplicationRequest {
  return { verb, path, headers: [...headers], body: toBytes(body), endBody: Boolean(endBody) };
}

export function applicationResponse({ status = 0, headers = [], body = EMPTY, endBody = false }: ApplicationResponseInit = {}): ApplicationResponse {
  return { status, headers: [...headers], body: toBytes(body), endBody: Boolean(endBody) };
}

export function bodyChunk({ data = EMPTY, endBody = false }: BodyChunkInit = {}): BodyChunk {
  return { data: toBytes(data), endBody: Boolean(endBody) };
}

export function reset({ code = ResetCode.CODE_UNSPECIFIED, reason = '' }: ResetInit = {}): Reset {
  return { code, reason };
}

export const ServiceFrame = Object.freeze({
  request: (streamId: bigint | number, value?: ApplicationRequestInit): ServiceFrame => ({ streamId: BigInt(streamId), kind: 'request', value: applicationRequest(value) }),
  response: (streamId: bigint | number, value?: ApplicationResponseInit): ServiceFrame => ({ streamId: BigInt(streamId), kind: 'response', value: applicationResponse(value) }),
  bodyChunk: (streamId: bigint | number, value?: BodyChunkInit): ServiceFrame => ({ streamId: BigInt(streamId), kind: 'body_chunk', value: bodyChunk(value) }),
  reset: (streamId: bigint | number, value?: ResetInit): ServiceFrame => ({ streamId: BigInt(streamId), kind: 'reset', value: reset(value) }),
});

// -- Header ---------------------------------------------------------------------

export function encodeHeader(h: Header): Uint8Array<ArrayBuffer> {
  const parts: Uint8Array[] = [];
  if (h.key) parts.push(stringField(1, h.key));
  if (h.value) parts.push(stringField(2, h.value));
  return concatBytes(...parts);
}

export function decodeHeader(data: Uint8Array): Header {
  let key = '';
  let value = '';
  let offset = 0;
  while (offset < data.length) {
    let fieldNumber, wireType, raw;
    [fieldNumber, wireType, offset] = readKey(data, offset);
    if (fieldNumber === 1) {
      if (wireType !== WIRE_DELIMITED) throw new ProtoError('Header.key wrong wire type');
      [raw, offset] = readDelimited(data, offset);
      key = decodeString(raw);
    } else if (fieldNumber === 2) {
      if (wireType !== WIRE_DELIMITED) throw new ProtoError('Header.value wrong wire type');
      [raw, offset] = readDelimited(data, offset);
      value = decodeString(raw);
    } else {
      offset = skipField(data, offset, wireType);
    }
  }
  return { key, value };
}

// -- ApplicationRequest -------------------------------------------------------------

export function encodeApplicationRequest(request: ApplicationRequestInit): Uint8Array<ArrayBuffer> {
  const r = applicationRequest(request);
  const parts: Uint8Array[] = [];
  if (r.verb) parts.push(stringField(1, r.verb));
  if (r.path) parts.push(stringField(2, r.path));
  for (const h of r.headers) parts.push(delimitedField(3, encodeHeader(h)));
  if (r.body.length) parts.push(bytesField(4, r.body));
  if (r.endBody) parts.push(boolField(5, true));
  return concatBytes(...parts);
}

export function decodeApplicationRequest(data: Uint8Array): ApplicationRequest {
  let verb = '';
  let path = '';
  const headers: Header[] = [];
  let body = EMPTY;
  let endBody = false;
  let offset = 0;
  while (offset < data.length) {
    let fieldNumber, wireType, raw;
    [fieldNumber, wireType, offset] = readKey(data, offset);
    if (fieldNumber === 1) {
      if (wireType !== WIRE_DELIMITED) throw new ProtoError('ApplicationRequest.verb wrong wire type');
      [raw, offset] = readDelimited(data, offset);
      verb = decodeString(raw);
    } else if (fieldNumber === 2) {
      if (wireType !== WIRE_DELIMITED) throw new ProtoError('ApplicationRequest.path wrong wire type');
      [raw, offset] = readDelimited(data, offset);
      path = decodeString(raw);
    } else if (fieldNumber === 3) {
      if (wireType !== WIRE_DELIMITED) throw new ProtoError('ApplicationRequest.headers wrong wire type');
      [raw, offset] = readDelimited(data, offset);
      headers.push(decodeHeader(raw));
    } else if (fieldNumber === 4) {
      if (wireType !== WIRE_DELIMITED) throw new ProtoError('ApplicationRequest.body wrong wire type');
      [body, offset] = readDelimited(data, offset);
    } else if (fieldNumber === 5) {
      if (wireType !== WIRE_VARINT) throw new ProtoError('ApplicationRequest.end_body wrong wire type');
      [raw, offset] = readVarint(data, offset);
      endBody = raw !== 0n;
    } else {
      offset = skipField(data, offset, wireType);
    }
  }
  return { verb, path, headers, body, endBody };
}

// -- ApplicationResponse ------------------------------------------------------------

export function encodeApplicationResponse(response: ApplicationResponseInit): Uint8Array<ArrayBuffer> {
  const r = applicationResponse(response);
  const parts: Uint8Array[] = [];
  if (r.status !== 0) parts.push(int32Field(1, r.status));
  for (const h of r.headers) parts.push(delimitedField(2, encodeHeader(h)));
  if (r.body.length) parts.push(bytesField(3, r.body));
  if (r.endBody) parts.push(boolField(4, true));
  return concatBytes(...parts);
}

export function decodeApplicationResponse(data: Uint8Array): ApplicationResponse {
  let status = 0;
  const headers: Header[] = [];
  let body = EMPTY;
  let endBody = false;
  let offset = 0;
  while (offset < data.length) {
    let fieldNumber, wireType, raw;
    [fieldNumber, wireType, offset] = readKey(data, offset);
    if (fieldNumber === 1) {
      if (wireType !== WIRE_VARINT) throw new ProtoError('ApplicationResponse.status wrong wire type');
      [raw, offset] = readVarint(data, offset);
      status = decodeInt32(raw);
    } else if (fieldNumber === 2) {
      if (wireType !== WIRE_DELIMITED) throw new ProtoError('ApplicationResponse.headers wrong wire type');
      [raw, offset] = readDelimited(data, offset);
      headers.push(decodeHeader(raw));
    } else if (fieldNumber === 3) {
      if (wireType !== WIRE_DELIMITED) throw new ProtoError('ApplicationResponse.body wrong wire type');
      [body, offset] = readDelimited(data, offset);
    } else if (fieldNumber === 4) {
      if (wireType !== WIRE_VARINT) throw new ProtoError('ApplicationResponse.end_body wrong wire type');
      [raw, offset] = readVarint(data, offset);
      endBody = raw !== 0n;
    } else {
      offset = skipField(data, offset, wireType);
    }
  }
  return { status, headers, body, endBody };
}

// -- BodyChunk ------------------------------------------------------------------

export function encodeBodyChunk(chunk: BodyChunkInit): Uint8Array<ArrayBuffer> {
  const c = bodyChunk(chunk);
  const parts: Uint8Array[] = [];
  if (c.data.length) parts.push(bytesField(1, c.data));
  if (c.endBody) parts.push(boolField(2, true));
  return concatBytes(...parts);
}

export function decodeBodyChunk(data: Uint8Array): BodyChunk {
  let chunkData = EMPTY;
  let endBody = false;
  let offset = 0;
  while (offset < data.length) {
    let fieldNumber, wireType, raw;
    [fieldNumber, wireType, offset] = readKey(data, offset);
    if (fieldNumber === 1) {
      if (wireType !== WIRE_DELIMITED) throw new ProtoError('BodyChunk.data wrong wire type');
      [chunkData, offset] = readDelimited(data, offset);
    } else if (fieldNumber === 2) {
      if (wireType !== WIRE_VARINT) throw new ProtoError('BodyChunk.end_body wrong wire type');
      [raw, offset] = readVarint(data, offset);
      endBody = raw !== 0n;
    } else {
      offset = skipField(data, offset, wireType);
    }
  }
  return { data: chunkData, endBody };
}

// -- Reset --------------------------------------------------------------------------

export function encodeReset(r: ResetInit): Uint8Array<ArrayBuffer> {
  const parts: Uint8Array[] = [];
  const code = coerceResetCode(r.code ?? ResetCode.CODE_UNSPECIFIED);
  if (code !== ResetCode.CODE_UNSPECIFIED) parts.push(int32Field(1, code));
  if (r.reason) parts.push(stringField(2, r.reason));
  return concatBytes(...parts);
}

export function decodeReset(data: Uint8Array): Reset {
  let code: number = ResetCode.CODE_UNSPECIFIED;
  let reason = '';
  let offset = 0;
  while (offset < data.length) {
    let fieldNumber, wireType, raw;
    [fieldNumber, wireType, offset] = readKey(data, offset);
    if (fieldNumber === 1) {
      if (wireType !== WIRE_VARINT) throw new ProtoError('Reset.code wrong wire type');
      [raw, offset] = readVarint(data, offset);
      code = coerceResetCode(decodeInt32(raw));
    } else if (fieldNumber === 2) {
      if (wireType !== WIRE_DELIMITED) throw new ProtoError('Reset.reason wrong wire type');
      [raw, offset] = readDelimited(data, offset);
      reason = decodeString(raw);
    } else {
      offset = skipField(data, offset, wireType);
    }
  }
  return { code, reason };
}

// -- ServiceFrame -------------------------------------------------------------------

function isObject(v: unknown): v is object {
  return v !== null && typeof v === 'object' && !ArrayBuffer.isView(v);
}

export function encodeServiceFrame(frame: ServiceFrameInit): Uint8Array<ArrayBuffer> {
  const parts: Uint8Array[] = [];
  const streamId = BigInt(frame.streamId ?? 0n);
  if (streamId !== 0n) parts.push(int64Field(1, streamId));

  const kind = frame.kind ?? null;
  const value = frame.value ?? null;
  if (kind === null) {
    if (value !== null) throw new ProtoError('ServiceFrame value provided without kind');
    return concatBytes(...parts);
  }
  if (!isObject(value)) throw new ProtoError(`ServiceFrame ${kind} value has wrong type`);
  if (kind === 'request') parts.push(delimitedField(2, encodeApplicationRequest(value)));
  else if (kind === 'response') parts.push(delimitedField(3, encodeApplicationResponse(value)));
  else if (kind === 'body_chunk') parts.push(delimitedField(4, encodeBodyChunk(value)));
  else if (kind === 'reset') parts.push(delimitedField(5, encodeReset(value)));
  else throw new ProtoError('unknown ServiceFrame kind');
  return concatBytes(...parts);
}

export function decodeServiceFrame(input: BytesLike): ServiceFrame {
  const data = toBytes(input);
  let streamId = 0n;
  // kind and value are set together, as one ServiceFrameBody.
  let body: ServiceFrameBody = { kind: null, value: null };
  let offset = 0;
  while (offset < data.length) {
    let fieldNumber, wireType, raw;
    [fieldNumber, wireType, offset] = readKey(data, offset);
    if (fieldNumber === 1) {
      if (wireType !== WIRE_VARINT) throw new ProtoError('ServiceFrame.stream_id wrong wire type');
      [raw, offset] = readVarint(data, offset);
      streamId = decodeInt64(raw);
    } else if (fieldNumber === 2) {
      if (wireType !== WIRE_DELIMITED) throw new ProtoError('ServiceFrame.request wrong wire type');
      [raw, offset] = readDelimited(data, offset);
      body = { kind: 'request', value: decodeApplicationRequest(raw) };
    } else if (fieldNumber === 3) {
      if (wireType !== WIRE_DELIMITED) throw new ProtoError('ServiceFrame.response wrong wire type');
      [raw, offset] = readDelimited(data, offset);
      body = { kind: 'response', value: decodeApplicationResponse(raw) };
    } else if (fieldNumber === 4) {
      if (wireType !== WIRE_DELIMITED) throw new ProtoError('ServiceFrame.body_chunk wrong wire type');
      [raw, offset] = readDelimited(data, offset);
      body = { kind: 'body_chunk', value: decodeBodyChunk(raw) };
    } else if (fieldNumber === 5) {
      if (wireType !== WIRE_DELIMITED) throw new ProtoError('ServiceFrame.reset wrong wire type');
      [raw, offset] = readDelimited(data, offset);
      body = { kind: 'reset', value: decodeReset(raw) };
    } else {
      offset = skipField(data, offset, wireType);
    }
  }
  return { streamId, ...body };
}

// -- ServiceRequest / ServiceResponse -----------------------------------------------

export function encodeServiceRequest({ service = ServiceType.SERVICE_DAEMON, payload = EMPTY }: { service?: number | bigint; payload?: BytesLike } = {}): Uint8Array<ArrayBuffer> {
  const s = coerceServiceType(service);
  const p = toBytes(payload);
  const parts: Uint8Array[] = [];
  if (s !== ServiceType.SERVICE_DAEMON) parts.push(varintField(1, s));
  if (p.length) parts.push(bytesField(2, p));
  return concatBytes(...parts);
}

export function decodeServiceRequest(input: BytesLike): { service: number; payload: Uint8Array } {
  const data = toBytes(input);
  let service: number = ServiceType.SERVICE_DAEMON;
  let payload = EMPTY;
  let offset = 0;
  while (offset < data.length) {
    let fieldNumber, wireType, raw;
    [fieldNumber, wireType, offset] = readKey(data, offset);
    if (fieldNumber === 1) {
      if (wireType !== WIRE_VARINT) throw new ProtoError('ServiceRequest.service wrong wire type');
      [raw, offset] = readVarint(data, offset);
      service = coerceServiceType(raw);
    } else if (fieldNumber === 2) {
      if (wireType !== WIRE_DELIMITED) throw new ProtoError('ServiceRequest.payload wrong wire type');
      [payload, offset] = readDelimited(data, offset);
    } else {
      offset = skipField(data, offset, wireType);
    }
  }
  return { service, payload };
}

export function encodeServiceResponse({ payload = EMPTY }: { payload?: BytesLike } = {}): Uint8Array<ArrayBuffer> {
  const p = toBytes(payload);
  if (!p.length) return new Uint8Array(0);
  return bytesField(1, p);
}

export function decodeServiceResponse(input: BytesLike): { payload: Uint8Array } {
  const data = toBytes(input);
  let payload = EMPTY;
  let offset = 0;
  while (offset < data.length) {
    let fieldNumber, wireType;
    [fieldNumber, wireType, offset] = readKey(data, offset);
    if (fieldNumber === 1) {
      if (wireType !== WIRE_DELIMITED) throw new ProtoError('ServiceResponse.payload wrong wire type');
      [payload, offset] = readDelimited(data, offset);
    } else {
      offset = skipField(data, offset, wireType);
    }
  }
  return { payload };
}
