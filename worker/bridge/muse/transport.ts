// Derived from facebookincubator/muse-gadget-sdk at commit e17081a
// (linux/src/musegadget/noise/transport.py). Copyright (c) Meta Platforms, Inc.
// and affiliates. Licensed under the Apache License, Version 2.0; see
// LICENSE-muse-gadget-sdk and NOTICE. Modified: ported from Python to JavaScript, then TypeScript.
//
// Request/response multiplexing over an established Noise session:
//   ServiceFrame -> ServiceRequest -> NoiseTransportFrame chunks -> AES-GCM (empty AD).
// Any failure marks the transport dead; a dead transport refuses all work,
// because its cipher states can no longer be trusted to be in sync.

import { NoiseProtocolError } from './errors.js';
import {
  ResetCode,
  ServiceFrame,
  ServiceType,
  decodeServiceFrame,
  decodeServiceRequest,
  decodeServiceResponse,
  encodeServiceFrame,
  encodeServiceRequest,
  encodeServiceResponse,
} from './envelope.js';
import type { Header, ServiceFrameBody, ServiceFrameInit } from './envelope.js';
import { NoiseFrameDecoder, encodeNoiseFrames } from './framing.js';
import type { CipherState } from './noise.js';
import type { BytesLike } from './proto.js';

/** What the VM sends on a stream: a response head, a body chunk or a reset. */
export type InboundBody = Extract<ServiceFrameBody, { kind: 'response' | 'body_chunk' | 'reset' }>;

/** An InboundBody with the stream it is for. */
export type InboundFrame = { streamId: bigint } & InboundBody;

/** A service by name (SERVICE_MAP) or by its ServiceType value. */
export type Service = 'daemon' | 'sentinel' | 'vault' | 'authd' | number;

/** An encrypted request head: its stream id and the WebSocket messages to send. */
export interface EncryptedRequest {
  streamId: bigint;
  frames: Uint8Array[];
}

export const EMPTY_AD = new Uint8Array(0);

export const SERVICE_MAP: Readonly<Record<string, number>> = Object.freeze({
  daemon: ServiceType.SERVICE_DAEMON,
  sentinel: ServiceType.SERVICE_SENTINEL,
  vault: ServiceType.SERVICE_VAULT,
  authd: ServiceType.SERVICE_AUTHD,
});

const SERVICE_VALUES: ReadonlySet<number> = new Set(Object.values(ServiceType));

function coerceService(service: unknown): number {
  if (typeof service === 'number' && SERVICE_VALUES.has(service)) return service;
  if (typeof service === 'string' && Object.hasOwn(SERVICE_MAP, service)) return SERVICE_MAP[service];
  throw new NoiseProtocolError('unknown noise service');
}

export class NoiseTransport {
  _send: CipherState;
  _recv: CipherState;
  _decoder: NoiseFrameDecoder;
  _nextStreamId: bigint;
  _dead: boolean;
  _chunkId: (() => bigint) | null;

  /** options are test hooks. */
  constructor(
    send: CipherState,
    recv: CipherState,
    { chunkId, now }: { chunkId?: (() => bigint) | undefined; now?: (() => number) | undefined } = {},
  ) {
    this._send = send;
    this._recv = recv;
    this._decoder = new NoiseFrameDecoder({ now });
    this._nextStreamId = 1n;
    this._dead = false;
    this._chunkId = chunkId ?? null;
  }

  get dead(): boolean {
    return this._dead;
  }

  _assertAlive(): void {
    if (this._dead) throw new NoiseProtocolError('NoiseTransport: dead after prior failure');
  }

  encryptHttpRequest(
    method: string,
    path: string,
    body: BytesLike = new Uint8Array(0),
    { service = 'daemon', headers = [] }: { service?: Service; headers?: readonly Header[] | null } = {},
  ): Promise<EncryptedRequest> {
    return this._sendApplicationRequest(method, path, body, service, headers, true);
  }

  startStreamRequest(
    method: string,
    path: string,
    { service = 'daemon', headers = [] }: { service?: Service; headers?: readonly Header[] | null } = {},
  ): Promise<EncryptedRequest> {
    return this._sendApplicationRequest(method, path, new Uint8Array(0), service, headers, false);
  }

  async _sendApplicationRequest(
    method: string,
    path: string,
    body: BytesLike,
    service: Service,
    headers: readonly Header[] | null,
    endBody: boolean,
  ): Promise<EncryptedRequest> {
    this._assertAlive();
    // Allocate the id synchronously, like the SDK under its send lock.
    const streamId = this._nextStreamId;
    this._nextStreamId += 1n;
    try {
      const frame = ServiceFrame.request(streamId, {
        verb: method,
        path,
        headers: [...(headers ?? [])],
        body,
        endBody,
      });
      const frames = await this._encryptRequest(coerceService(service), frame);
      return { streamId, frames };
    } catch (err) {
      this._dead = true;
      throw err;
    }
  }

  async encryptBodyChunk(
    streamId: bigint,
    data: BytesLike,
    { service = 'daemon', endBody = false }: { service?: Service; endBody?: boolean } = {},
  ): Promise<Uint8Array[]> {
    this._assertAlive();
    try {
      const frame = ServiceFrame.bodyChunk(streamId, { data, endBody });
      return await this._encryptRequest(coerceService(service), frame);
    } catch (err) {
      this._dead = true;
      throw err;
    }
  }

  async encryptReset(
    streamId: bigint,
    { service = 'daemon', reason = '', code = ResetCode.CANCELLED }: { service?: Service; reason?: string; code?: number } = {},
  ): Promise<Uint8Array[]> {
    this._assertAlive();
    try {
      const frame = ServiceFrame.reset(streamId, { code, reason });
      return await this._encryptRequest(coerceService(service), frame);
    } catch (err) {
      this._dead = true;
      throw err;
    }
  }

  /**
   * Decrypt one WebSocket binary message: null while a chunked message is
   * incomplete (or for an empty oneof).
   */
  async decryptFrame(ciphertext: BytesLike): Promise<InboundFrame | null> {
    this._assertAlive();
    try {
      const plainFrame = await this._recv.decryptWithAd(EMPTY_AD, ciphertext);
      const reassembled = this._decoder.decode(plainFrame);
      if (reassembled === null) return null;

      const response = decodeServiceResponse(reassembled);
      if (response.payload.length === 0) throw new NoiseProtocolError('empty ServiceResponse payload');

      const frame = decodeServiceFrame(response.payload);
      if (frame.kind === 'response' || frame.kind === 'body_chunk' || frame.kind === 'reset') {
        // decodeServiceFrame() made this object for this call, and its value
        // for these kinds is always the decoded message (never null).
        return frame;

      }
      if (frame.kind === 'request') {
        throw new NoiseProtocolError('NoiseTransport: unexpected request frame from server');
      }
      return null;
    } catch (err) {
      this._dead = true;
      throw err;
    }
  }

  async _encryptRequest(service: number, frame: ServiceFrameInit): Promise<Uint8Array[]> {
    const frameBytes = encodeServiceFrame(frame);
    const requestBytes = encodeServiceRequest({ service, payload: frameBytes });
    const protoFrames = encodeNoiseFrames(requestBytes, this._chunkId ? this._chunkId() : null);
    const out: Uint8Array[] = [];
    // Sequential on purpose: each encryption takes the next nonce in order.
    for (const f of protoFrames) out.push(await this._send.encryptWithAd(EMPTY_AD, f));
    return out;
  }
}

/** Server side (tests / fake VM): ServiceRequest bytes -> ServiceFrame. */
export function decodeRequestEnvelope(data: BytesLike): ServiceFrame {
  const request = decodeServiceRequest(data);
  return decodeServiceFrame(request.payload);
}

/** Server side (tests / fake VM): ServiceFrame -> ServiceResponse bytes. */
export function encodeResponseEnvelope(frame: ServiceFrameInit): Uint8Array<ArrayBuffer> {

  return encodeServiceResponse({ payload: encodeServiceFrame(frame) });
}
