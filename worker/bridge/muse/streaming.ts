// Derived from facebookincubator/muse-gadget-sdk at commit e17081a
// (linux/src/musegadget/streaming.py). Copyright (c) Meta Platforms, Inc. and
// affiliates. Licensed under the Apache License, Version 2.0; see
// LICENSE-muse-gadget-sdk and NOTICE. Modified: ported from Python to JavaScript, then TypeScript.
//
// Bounded, duplex HTTP response streams over a MuseSession. send_chat does
// not use this (it uses the buffered request path, as in the SDK); it is
// ported for callers that need a streaming request with the SDK's bounds.
// A slow consumer fails its own stream rather than buffering without limit.

import { HTTPStatusError, MuseConnectionError } from './errors.js';
import type { Header } from './envelope.js';
import type { InboundBody, NoiseTransport } from './transport.js';

export const MAX_BUFFER_BYTES = 2 * 1024 * 1024;
export const MAX_BUFFER_CHUNKS = 256;
export const MAX_LINE_BYTES = 1024 * 1024;
export const MAX_ERROR_BYTES = 64 * 1024;
export const MAX_SEND_BYTES = 64 * 1024;

/** A level-triggered "changed" signal (asyncio.Event used as in the SDK). */
class Signal {
  _waiters: (() => void)[];

  constructor() {
    this._waiters = [];
  }
  set(): void {
    const waiters = this._waiters;
    this._waiters = [];
    for (const w of waiters) w();
  }
  wait(): Promise<void> {
    return new Promise((resolve) => this._waiters.push(resolve));
  }
}

/** Serialises async critical sections (asyncio.Lock). */
export class AsyncLock {
  _tail: Promise<void>;

  constructor() {
    this._tail = Promise.resolve();
  }
  run<T>(fn: () => T | PromiseLike<T>): Promise<T> {
    const result = this._tail.then(fn);
    this._tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

/** What a StreamingRequest needs of its session (MuseSession). */
export interface StreamSession {
  /** Set once the session is open; a stream only exists on an open session. */
  transport: NoiseTransport | null;
  sendEncrypted<T extends Uint8Array[]>(encrypt: () => Promise<T>, options?: { check?: (() => void) | null }): Promise<T>;
  unregister(streamId: bigint): void;
}

/**
 * One request with independent input and output lifetimes; one reader.
 * `session` must provide sendEncrypted(encryptFn, {check}), transport, and
 * unregister(streamId).
 */
export class StreamingRequest {
  session: StreamSession;
  streamId: bigint;
  maxBufferBytes: number;
  maxBufferChunks: number;
  status: number | null;
  headers: Header[];
  _chunks: Uint8Array[];
  _bytes: number;
  _changed: Signal;
  _error: unknown;
  _ended: boolean;
  _closed: boolean;
  _inputClosed: boolean;
  _inputEofSent: boolean;
  _closeComplete: boolean;
  _endLock: AsyncLock;

  constructor(
    session: StreamSession,
    streamId: bigint,
    { maxBufferBytes = MAX_BUFFER_BYTES, maxBufferChunks = MAX_BUFFER_CHUNKS }: { maxBufferBytes?: number; maxBufferChunks?: number } = {},
  ) {
    this.session = session;
    this.streamId = streamId;
    this.maxBufferBytes = maxBufferBytes;
    this.maxBufferChunks = maxBufferChunks;
    this.status = null;
    this.headers = [];
    this._chunks = [];
    this._bytes = 0;
    this._changed = new Signal();
    this._error = null;
    this._ended = false;
    this._closed = false;
    this._inputClosed = false;
    this._inputEofSent = false;
    this._closeComplete = false;
    this._endLock = new AsyncLock();
  }

  get ended(): boolean {
    return this._ended;
  }

  fail(error: unknown): void {
    if (this._error === null) this._error = error;
    this._chunks = [];
    this._bytes = 0;
    this._changed.set();
  }

  onFrame(frame: InboundBody): void {
    if (this._closed || this._error !== null) return;
    if (this._ended) {
      this.fail(new RangeError('response data after EOF'));
      return;
    }
    if (frame.kind === 'reset') {
      this.fail(new MuseConnectionError('request stream reset'));
      return;
    }
    let data;
    if (frame.kind === 'response') {
      if (this.status !== null || !(frame.value.status >= 100 && frame.value.status <= 599)) {
        this.fail(new RangeError('invalid or duplicate response head'));
        return;
      }
      this.status = frame.value.status;
      this.headers = frame.value.headers;
      data = frame.value.body;
    } else if (frame.kind === 'body_chunk' && this.status !== null) {
      data = frame.value.data;
    } else {
      this.fail(new RangeError('response body before head'));
      return;
    }
    if (data.length) {
      if (this._bytes + data.length > this.maxBufferBytes || this._chunks.length >= this.maxBufferChunks) {
        this.fail(new RangeError('response stream buffer full'));
        return;
      }
      this._chunks.push(data);
      this._bytes += data.length;
    }
    this._ended = frame.value.endBody;
    this._changed.set();
  }

  _check(): void {
    if (this._error !== null) throw this._error;
    if (this._closed) throw new MuseConnectionError('request stream closed');
  }

  async waitResponse(): Promise<number> {
    while (this.status === null) {
      this._check();
      await this._changed.wait();
    }
    this._check();
    if (!(this.status >= 200 && this.status < 300)) {
      const parts: Uint8Array[] = [];
      let size = 0;
      while (size < MAX_ERROR_BYTES) {
        const chunk = await this.read();
        if (chunk === null) break;
        const take = chunk.subarray(0, MAX_ERROR_BYTES - size);
        parts.push(take);
        size += take.length;
      }
      const body = new Uint8Array(size);
      let o = 0;
      for (const p of parts) {
        body.set(p, o);
        o += p.length;
      }
      throw new HTTPStatusError(this.status, body);
    }
    return this.status;
  }

  /** Next nonempty response chunk, or null at clean EOF. */
  async read(): Promise<Uint8Array | null> {
    for (;;) {
      this._check();
      if (this._chunks.length) {
        const chunk = this._chunks.shift()!; // not empty: checked just above
        this._bytes -= chunk.length;
        return chunk;
      }
      if (this._ended) return null;
      await this._changed.wait();
    }
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array, void, undefined> {
    for (;;) {
      const chunk = await this.read();
      if (chunk === null) return;
      yield chunk;
    }
  }

  async sendBody(
    data: Uint8Array,
    { endBody = false, check = null }: { endBody?: boolean; check?: (() => void) | null } = {},
  ): Promise<void> {
    this._check();
    if (this._inputClosed) throw new RangeError('request body already closed');
    if (data.length > MAX_SEND_BYTES) throw new RangeError('request chunk exceeds 64 KiB');
    if (endBody) {
      this._inputClosed = true;
      await this._endLock.run(() => this._sendBody(data, { endBody: true, check }));
    } else {
      await this._sendBody(data, { check });
    }
  }

  _checkSend(): void {
    this._check();
    if (this._inputEofSent) throw new RangeError('request body already closed');
  }

  async _sendBody(
    data: Uint8Array,
    { endBody = false, check = null }: { endBody?: boolean; check?: (() => void) | null } = {},
  ): Promise<void> {
    const admissible = () => {
      this._checkSend();
      if (check !== null) check();
    };
    await this.session.sendEncrypted(
      () => this.session.transport!.encryptBodyChunk(this.streamId, data, { endBody }),
      { check: admissible },
    );
    if (endBody) this._inputEofSent = true;
  }

  async halfClose(): Promise<void> {
    this._inputClosed = true;
    await this._endLock.run(async () => {
      this._check();
      if (!this._inputEofSent) await this._sendBody(new Uint8Array(0), { endBody: true });
    });
  }

  async close(): Promise<void> {
    if (this._closeComplete) return;
    this._closed = true;
    this._chunks = [];
    this._bytes = 0;
    this._changed.set();
    await this._endLock.run(async () => {
      if (this._closeComplete) return;
      if (!(this._ended && this._inputEofSent)) {
        await this.session.sendEncrypted(() =>
          this.session.transport!.encryptReset(this.streamId, { reason: 'client closed stream' }),
        );
      }
      this._closeComplete = true;
      this.session.unregister(this.streamId);
    });
  }
}

/**
 * Yield objects from arbitrarily fragmented UTF-8 NDJSON, bounded per line.
 * LF is required even on the last record; CRLF and blank lines are accepted.
 */
export async function* readNdjson(
  stream: AsyncIterable<Uint8Array>,
  { maxLineBytes = MAX_LINE_BYTES }: { maxLineBytes?: number } = {},
): AsyncGenerator<Record<string, unknown>, void, undefined> {
  if (maxLineBytes < 1) throw new RangeError('line limit must be positive');
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
  let pending: Uint8Array[] = [];
  let pendingLen = 0;
  for await (const chunk of stream) {
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(0x0a, offset);
      const end = newline < 0 ? chunk.length : newline + 1;
      if (pendingLen + end - offset > maxLineBytes) throw new RangeError('NDJSON line too large');
      pending.push(chunk.subarray(offset, end));
      pendingLen += end - offset;
      offset = end;
      if (newline >= 0) {
        const line = new Uint8Array(pendingLen);
        let o = 0;
        for (const p of pending) {
          line.set(p, o);
          o += p.length;
        }
        pending = [];
        pendingLen = 0;
        let text;
        try {
          text = decoder.decode(line);
        } catch {
          throw new SyntaxError('invalid NDJSON record');
        }
        // bytes.strip(): ASCII whitespace only.
        if (!/^[ \t\n\r\v\f]*$/.test(text)) {
          let record: unknown;
          try {
            record = JSON.parse(text);
          } catch {
            throw new SyntaxError('invalid NDJSON record');
          }
          if (record === null || typeof record !== 'object' || Array.isArray(record)) {
            throw new TypeError('NDJSON record must be an object');
          }
          yield record as Record<string, unknown>; // checked just above: a JSON object

        }
      }
    }
  }
  if (pendingLen) throw new SyntaxError('response ended within an NDJSON record');
}
