// Derived from facebookincubator/muse-gadget-sdk at commit e17081a
// (linux/src/musegadget/link_client.py: noise_url, LinkSession with
// register_device=False, send_chat, _request, _send_encrypted, _read_loop,
// _Request, acknowledgement). Copyright (c) Meta Platforms, Inc. and
// affiliates. Licensed under the Apache License, Version 2.0; see
// LICENSE-muse-gadget-sdk and NOTICE. Modified: ported from Python to
// JavaScript, then TypeScript; only the send path is ported (no /link-control, link.register,
// invokes, subscriptions, TTS, voice, images).
//
// Wire flow (what the SDK does, and what this does):
//   1. WebSocket upgrade to wss://<noise_host>/v1/noise?vm_id=<id>[&app_id=<id>]
//      with "Authorization: Bearer <vm_auth_token>" and a User-Agent header.
//      The Python SDK (websockets 15) sends exactly those two non-standard
//      headers, offers no compression, no subprotocol, no Origin. 401/403 on
//      the upgrade means: re-fetch the VM list (do not retry the same bearer).
//   2. Noise XX as initiator: send msg1 (binary), receive msg2 (binary; a
//      text frame aborts), send msg3 (empty payload: the bearer already
//      authenticated us), split. Whole handshake bounded by 20 s.
//   3. "Transport ready" right after the handshake. With register_device=False
//      the SDK opens no /link-control stream and sends no link.register; this
//      port never does either.
//   4. send_chat: one buffered request, POST /chat/stream, with headers
//      Content-Type: application/json, x-request-id: <uuid4>, x-app-id: musegadget,
//      and the JSON body {message, output_modality, device_id[, session_id][, device]}
//      serialised exactly like Python's json.dumps (", " / ": " separators,
//      ASCII-only escapes). end_body is set on the request frame (bodies over
//      64 KiB go as a stream head plus 16 KiB body chunks, as in the SDK).
//   5. The ack: the VM answers that stream with a response head, status 200,
//      whose (possibly chunked) body is one JSON object and which ends the
//      stream (end_body). Shapes seen in the SDK's tests and MuseTurn:
//          {"result":{"message_id":"<user message id>"}}
//          {"message_id":"<id>"}
//          {"result":{"message_id":"…","reply_to_message_id":"…","session_id":"…","is_thread":true}}
//      send_chat resolves with {ok: 200<=status<300, status, response: <parsed JSON
//      or up to 2000 chars of text>} once end_body arrives. The reply itself
//      is NOT on this stream; Muse posts it to the chat (/chat/subscribe,
//      not ported). Frames for the stream after the ack are dropped, and
//      sendChatOnce() closes the WebSocket right after the ack.

import {
  MuseConnectionError,
  MuseTimeoutError,
  RequestRejected,
  UpgradeRejected,
  errName,
} from './errors.js';
import type { Logger, MuseVm } from './api.js';
import { NoiseXXInitiator } from './noise.js';
import type { KeyGen } from './noise.js';
import { NoiseTransport } from './transport.js';
import type { EncryptedRequest, InboundBody } from './transport.js';
import { AsyncLock, MAX_BUFFER_BYTES, MAX_BUFFER_CHUNKS, StreamingRequest } from './streaming.js';
import { header } from './envelope.js';
import type { Header } from './envelope.js';
import { toBytes } from './proto.js';
import type { BytesLike } from './proto.js';

export const NOISE_PATH = '/v1/noise';
export const CHAT_PATH = '/chat/stream';
export const APP_ID = 'musegadget';
export const DEFAULT_NOISE_HOST = 'hatch.metaaivm.com'; // service.DEFAULT_NOISE_HOST
export const REQUEST_TIMEOUT_MS = 60_000;
export const MAX_RESPONSE_BYTES = 1024 * 1024;
export const HANDSHAKE_TIMEOUT_MS = 20_000;
export const REQUEST_CHUNK_BYTES = 16 * 1024;
export const MAX_INLINE_REQUEST_BYTES = 64 * 1024;
/** websockets max_size=128 KiB in the SDK: larger inbound messages fail the connection. */
export const MAX_WS_MESSAGE_BYTES = 128 * 1024;
/**
 * Not in the SDK (websockets applies TCP backpressure with max_queue=16);
 * Workers sockets have no backpressure, so bound the unread inbox instead.
 */
export const MAX_INBOX_MESSAGES = 1024;
export const DEFAULT_USER_AGENT = 'musegadget/0.1.0 (Cloudflare Workers) JavaScript';

const CLOSED = Symbol('closed');
const utf8 = new TextEncoder();
const silentLogger: Logger = { info() {}, warn() {}, error() {}, debug() {} };

/** The WebSocket surface a session uses (Workers, undici and the test fake all have it). */
export interface MuseSocket {
  binaryType?: string;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  addEventListener(type: 'close' | 'error', listener: () => void): void;
  send(data: Uint8Array): void;
  close(code?: number, reason?: string): void;
}

/** Opens a socket to url with these headers; resolves once it is open. */
export type SocketFactory = (url: string, headers: Record<string, string>) => Promise<MuseSocket>;

/** A WebSocket constructor that takes {headers} (Node 24's undici). */
export type HeaderWebSocketConstructor = new (
  url: string,
  options: { headers: Record<string, string> },
) => MuseSocket & {
  binaryType: string;
  addEventListener(type: 'open' | 'error', listener: () => void, options?: { once?: boolean }): void;
  removeEventListener(type: 'open' | 'error', listener: () => void): void;
};

/** sendChat()/request() result: response is the parsed JSON body, up to 2000 chars of text, or null. */
export interface ChatResult {
  ok: boolean;
  status: number;
  response: unknown;
}

export interface ChatRequestInit {
  message: string;
  outputModality?: string;
  deviceId: string;
  sessionId?: string | null;
  device?: string | null;
}

export interface ChatOptions {
  sessionId?: string | null;
  outputModality?: string;
  device?: string | null;
}

export interface MuseSessionOptions {
  /** Default DEFAULT_NOISE_HOST. */
  noiseHost?: string;
  vmId: string;
  /** Per-VM bearer from fetch_vms. */
  vmAuthToken: string;
  /** The device's node_id (send_chat's device_id). */
  deviceId: string;
  /** Optional app_id query parameter. */
  appId?: string | null;
  userAgent?: string;
  connect?: SocketFactory;
  /** Messages carry no secrets. */
  logger?: Logger;
  handshakeTimeoutMs?: number;
  requestTimeoutMs?: number;
  /** Test hooks. */
  noise?: { keyGen?: KeyGen; chunkId?: () => bigint };
}

/** A Blob-like WebSocket message (a socket whose binaryType could not be set). */
interface BlobLike {
  size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

function isBlobLike(data: unknown): data is BlobLike {
  return typeof data === 'object' && data !== null && 'arrayBuffer' in data && typeof data.arrayBuffer === 'function';
}

type InboxItem = Uint8Array | string | Promise<Uint8Array> | typeof CLOSED;

// -- URL ---------------------------------------------------------------------------

/** Voice app identity is fixed for the entire Noise connection. */
export function validateAppId(appId: unknown): string {
  if (appId === 'hatch-web') return appId;
  if (typeof appId === 'string' && /^[0-9]{1,19}$/.test(appId)) {
    const n = BigInt(appId);
    if (n > 0n && n <= (1n << 63n) - 1n) return n.toString();
  }
  throw new RangeError('app ID must be a positive int64 or hatch-web');
}

/** Matches the SDK's quote(vm_id, safe="-_.!~*'()") == encodeURIComponent. */
export function noiseUrl(noiseHost: string, vmId: string, appId: string | null = null): string {
  let url = `wss://${noiseHost}${NOISE_PATH}?vm_id=${encodeURIComponent(vmId)}`;
  if (appId !== null && appId !== undefined) url += '&app_id=' + encodeURIComponent(validateAppId(appId));
  return url;
}

/** service.py: LinkSession(vm_id=vm["vm_id"] or vm["vm_name"]). */
export function vmIdOf(vm: Pick<MuseVm, 'vm_id' | 'vm_name'>): string | undefined {
  return vm.vm_id || vm.vm_name;
}

// -- Python-compatible JSON ------------------------------------------------------

/**
 * json.dumps(obj) with Python's defaults: separators (", ", ": "), ensure_ascii
 * (every char outside 0x20..0x7E escaped as lowercase \uXXXX, surrogate pairs
 * as two escapes). Supports the types send_chat needs.
 */
export function pythonJsonDumps(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') {
    return JSON.stringify(value).replace(/[\u007f-￿]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('non-finite number');
    if (!Number.isInteger(value)) throw new TypeError('only integers are supported');
    return String(value);
  }
  if (Array.isArray(value)) return '[' + value.map(pythonJsonDumps).join(', ') + ']';
  if (typeof value === 'object') {
    return '{' + Object.entries(value).map(([k, v]) => pythonJsonDumps(k) + ': ' + pythonJsonDumps(v)).join(', ') + '}';
  }
  throw new TypeError('unsupported JSON value');
}

/** The exact body bytes send_chat posts. */
export function chatRequestBody({ message, outputModality = 'text', deviceId, sessionId = null, device = null }: ChatRequestInit): Uint8Array {
  if (typeof message !== 'string') throw new TypeError('message must be a string');
  if (typeof outputModality !== 'string') throw new TypeError('output_modality must be a string');
  if (typeof deviceId !== 'string' || !deviceId) throw new TypeError('device_id must be a non-empty string');
  const body: { message: string; output_modality: string; device_id: string; session_id?: string; device?: string } = {
    message,
    output_modality: outputModality,
    device_id: deviceId,
  };
  if (sessionId) {
    if (typeof sessionId !== 'string') throw new TypeError('session_id must be a string');
    body.session_id = sessionId;
  }
  if (device !== null && device !== undefined) {
    if (typeof device !== 'string') throw new TypeError('device must be a string');
    body.device = device;
  }
  return utf8.encode(pythonJsonDumps(body));
}

/** link_client.acknowledgement: the ack object, or throw. */
export function acknowledgement(result: ChatResult): object {
  if (!result.ok) throw new RequestRejected(result.status);
  const response = result.response;
  if (response === null || typeof response !== 'object' || Array.isArray(response)) {
    throw new TypeError('Muse did not acknowledge the request');
  }
  return response;
}

// -- WebSocket factories --------------------------------------------------------
//
// A factory is `async (url, headers) => socket`, where socket has the standard
// WebSocket surface: addEventListener('message'|'close'|'error'), send(bytes),
// close(code, reason). It must resolve only once the socket is open.

/** Cloudflare Workers / Durable Objects: outbound upgrade via fetch(). */
export function workersWebSocketFactory({ fetch: fetchImpl = globalThis.fetch }: { fetch?: typeof fetch } = {}): SocketFactory {
  return async (url, headers) => {
    // Workers' fetch() takes http(s) URLs for WebSocket upgrades.
    const httpUrl = url.replace(/^wss:/i, 'https:').replace(/^ws:/i, 'http:');
    const resp = await fetchImpl(httpUrl, { headers: { ...headers, Upgrade: 'websocket' } });
    const ws = resp.webSocket;
    if (!ws) {
      try {
        await resp.body?.cancel();
      } catch {
        // ignore
      }
      if (resp.status === 401 || resp.status === 403) throw new UpgradeRejected(resp.status);
      throw new MuseConnectionError(`WebSocket upgrade failed: HTTP ${resp.status}`);
    }
    ws.accept();
    return ws;
  };
}

/**
 * Node 24 (undici) WebSocket, which accepts a non-standard {headers} option.
 * Undici does not expose the HTTP status of a refused upgrade.
 */
export function standardWebSocketFactory(
  // Node 24's global WebSocket (undici) takes {headers}; the Workers types this
  // project compiles against describe workerd's, which does not.
  WebSocketImpl: HeaderWebSocketConstructor = globalThis.WebSocket as unknown as HeaderWebSocketConstructor,
): SocketFactory {
  return (url, headers) =>
    new Promise((resolve, reject) => {
      const ws = new WebSocketImpl(url, { headers });
      ws.binaryType = 'arraybuffer';
      const onOpen = () => {
        ws.removeEventListener('error', onError);
        resolve(ws);
      };
      const onError = () => {
        ws.removeEventListener('open', onOpen);
        reject(new MuseConnectionError('WebSocket connect failed'));
      };
      ws.addEventListener('open', onOpen, { once: true });
      ws.addEventListener('error', onError, { once: true });
    });
}

// -- request bookkeeping ---------------------------------------------------------

/** A promise with its settle functions. */
interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  // Both are assigned synchronously by the Promise executor.
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  promise.catch(() => {}); // observed by whoever awaits it
  return { promise, resolve, reject };
}

const RESET_CODE_NAMES = ['CODE_UNSPECIFIED', 'CANCELLED', 'TIMEOUT', 'PROTOCOL_ERROR', 'REFUSED_STREAM', 'INTERNAL_ERROR', 'SERVICE_UNAVAILABLE'];

/** link_client._Request: collects one buffered response, bounded. */
class PendingRequest {
  done: Deferred<[number, Uint8Array]>;
  settled: boolean;
  status: number;
  parts: Uint8Array[];
  size: number;

  constructor() {
    this.done = deferred();
    this.settled = false;
    this.status = 0;
    this.parts = [];
    this.size = 0;
  }

  fail(error: unknown): void {
    if (this.settled) return;
    this.settled = true;
    this.parts = [];
    this.done.reject(error);
  }

  onFrame(frame: InboundBody): void {
    if (this.settled) return;
    if (frame.kind === 'reset') {
      // The SDK puts the server's reason in the error; only the code is kept here.
      this.fail(new MuseConnectionError(`stream reset: ${RESET_CODE_NAMES[frame.value.code] ?? 'unknown'}`));
      return;
    }
    let data, ended;
    if (frame.kind === 'response') {
      if (this.status || !(frame.value.status >= 100 && frame.value.status <= 599)) {
        this.fail(new RangeError('invalid or duplicate response head'));
        return;
      }
      this.status = frame.value.status;
      data = frame.value.body;
      ended = frame.value.endBody;
    } else if (frame.kind === 'body_chunk' && this.status) {
      data = frame.value.data;
      ended = frame.value.endBody;
    } else {
      this.fail(new RangeError('response body before head'));
      return;
    }
    if (this.size + data.length > MAX_RESPONSE_BYTES) {
      this.fail(new RangeError('response too large'));
      return;
    }
    if (data.length) {
      this.parts.push(new Uint8Array(data));
      this.size += data.length;
    }
    if (ended) {
      const body = new Uint8Array(this.size);
      let o = 0;
      for (const p of this.parts) {
        body.set(p, o);
        o += p.length;
      }
      this.parts = [];
      this.settled = true;
      this.done.resolve([this.status, body]);
    }
  }
}

function decodeResponseBody(body: Uint8Array): unknown {
  if (!body.length) return null;
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(body));
  } catch {
    return new TextDecoder('utf-8').decode(body).slice(0, 2000);
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  // A loser that rejects after the deadline must not become an unhandled rejection.
  promise.catch(() => {});
  let timer!: ReturnType<typeof setTimeout>; // set synchronously by the executor below

  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new MuseTimeoutError(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function newRequestId(): string {
  return crypto.randomUUID();
}

// -- the session -----------------------------------------------------------------

export class MuseSession {
  _url: string;
  _deviceId: string;
  _connect: SocketFactory;
  _log: Logger;
  _handshakeTimeoutMs: number;
  _requestTimeoutMs: number;
  _noise: { keyGen?: KeyGen; chunkId?: () => bigint };
  _userAgent: string;
  // Defined in the constructor as a non-enumerable, read-only property.
  declare readonly _token: string;
  _ws: MuseSocket | null;
  transport: NoiseTransport | null;
  _sendLock: AsyncLock;
  _requests: Map<bigint, PendingRequest | StreamingRequest>;
  _inbox: InboxItem[];
  _inboxWaiter: (() => void) | null;
  _running: boolean;
  _closed: boolean;
  _used: boolean;
  _reader: Promise<void> | null;
  framesReceived: number;
  ended: Deferred<unknown>;

  constructor(options: MuseSessionOptions) {
    const {
      noiseHost = DEFAULT_NOISE_HOST,
      vmId,
      vmAuthToken,
      deviceId,
      appId = null,
      userAgent = DEFAULT_USER_AGENT,
      connect = workersWebSocketFactory(),
      logger = silentLogger,
      handshakeTimeoutMs = HANDSHAKE_TIMEOUT_MS,
      requestTimeoutMs = REQUEST_TIMEOUT_MS,
      noise = {},
    } = options;
    if (typeof vmId !== 'string' || !vmId) throw new TypeError('vmId is required');
    if (typeof vmAuthToken !== 'string' || !vmAuthToken) throw new TypeError('vmAuthToken is required');
    this._url = noiseUrl(noiseHost, vmId, appId);
    this._deviceId = deviceId;
    this._connect = connect;
    this._log = logger;
    this._handshakeTimeoutMs = handshakeTimeoutMs;
    this._requestTimeoutMs = requestTimeoutMs;
    this._noise = noise;
    this._userAgent = userAgent;
    // Kept private and never logged.
    Object.defineProperty(this, '_token', { value: vmAuthToken, enumerable: false });

    this._ws = null;
    this.transport = null;
    this._sendLock = new AsyncLock();
    this._requests = new Map(); // BigInt streamId -> PendingRequest | StreamingRequest
    this._inbox = [];
    this._inboxWaiter = null;
    this._running = false;
    this._closed = false;
    this._used = false;
    this._reader = null;
    /** Binary messages processed after the handshake (diagnostics/tests). */
    this.framesReceived = 0;
    /** Resolves with 'closed' | 'stopped' | Error when the session ends. */
    this.ended = deferred();
  }

  /** The URL the session connects to (contains no secret). */
  get url(): string {
    return this._url;
  }

  get running(): boolean {
    return this._running;
  }

  get closed(): boolean {
    return this._closed;
  }

  /** Open, handshake, start the reader; resolves when the transport is ready. */
  static async connect(options: MuseSessionOptions): Promise<MuseSession> {
    const session = new MuseSession(options);
    await session.open();
    return session;
  }

  async open(): Promise<void> {
    if (this._used) throw new Error('a MuseSession can only run once');
    this._used = true;
    try {
      const ws = await this._connect(this._url, {
        Authorization: `Bearer ${this._token}`,
        'User-Agent': this._userAgent,
      });
      if (this._closed) {
        // close() raced the connect: do not leave the socket open.
        try {
          ws.close(1000, 'session closed');
        } catch {
          // ignore
        }
        throw new MuseConnectionError('session closed');
      }
      this._attach(ws);
      this.transport = await withTimeout(this._handshake(), this._handshakeTimeoutMs, 'Noise handshake timed out');
      this._running = true;
      this._log.info('Noise session established');
      this._reader = this._readLoop();
    } catch (err) {
      if (err instanceof UpgradeRejected) this._log.warn(`VM refused connection: HTTP ${err.status}`);
      this._shutdown(new MuseConnectionError('Noise transport did not become ready'));
      throw err;
    }
  }

  _attach(ws: MuseSocket): void {
    this._ws = ws;
    if ('binaryType' in ws) {
      try {
        ws.binaryType = 'arraybuffer';
      } catch {
        // some implementations make it read-only
      }
    }
    ws.addEventListener('message', (event) => this._onMessage(event.data));
    ws.addEventListener('close', () => this._push(CLOSED));
    ws.addEventListener('error', () => this._push(CLOSED));
  }

  _onMessage(data: unknown): void {
    if (this._closed) return;
    let item: InboxItem;
    if (typeof data === 'string') {
      if (utf8.encode(data).length > MAX_WS_MESSAGE_BYTES) return this._fatal('inbound WebSocket message too large');
      item = data;
    } else if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
      item = toBytes(data);
      if (item.length > MAX_WS_MESSAGE_BYTES) return this._fatal('inbound WebSocket message too large');
    } else if (isBlobLike(data)) {
      if (data.size > MAX_WS_MESSAGE_BYTES) return this._fatal('inbound WebSocket message too large');
      item = data.arrayBuffer().then((b) => new Uint8Array(b)); // Blob
    } else {
      return this._fatal('unsupported WebSocket message type');
    }
    if (this._inbox.length >= MAX_INBOX_MESSAGES) return this._fatal('receive queue overflow');
    this._push(item);
  }

  _fatal(reason: string): void {
    this._log.warn(reason);
    this._shutdown(new MuseConnectionError(reason));
  }

  _push(item: InboxItem): void {
    this._inbox.push(item);
    const w = this._inboxWaiter;
    if (w) {
      this._inboxWaiter = null;
      w();
    }
  }

  async _recv(): Promise<Uint8Array | string | typeof CLOSED> {
    while (!this._inbox.length) {
      if (this._closed) return CLOSED;
      await new Promise<void>((resolve) => {
        this._inboxWaiter = resolve;
      });
    }
    const item = this._inbox.shift()!; // not empty: the loop above waited for an item
    return item instanceof Promise ? await item : item;
  }

  async _handshake(): Promise<NoiseTransport> {
    const initiator = new NoiseXXInitiator({ keyGen: this._noise.keyGen });
    await initiator.initialize();
    // _attach() set _ws just before the handshake starts.
    this._ws!.send(await initiator.writeMessage1());
    const msg2 = await this._recv();
    if (msg2 === CLOSED) throw new MuseConnectionError('connection closed during Noise handshake');
    if (typeof msg2 === 'string') throw new MuseConnectionError('Noise handshake got a text frame');
    await initiator.readMessage2(msg2);
    // The bearer already authenticated us at the upgrade; message 3 carries an empty payload.
    this._ws!.send(await initiator.writeMessage3());
    const [send, recv] = await initiator.split();
    return new NoiseTransport(send, recv, { chunkId: this._noise.chunkId });
  }

  async _readLoop(): Promise<void> {
    try {
      for (;;) {
        const raw = await this._recv();
        if (raw === CLOSED || this._closed) {
          this._log.info('Noise connection closed');
          this._shutdown(new MuseConnectionError('session ended'), 'closed');
          return;
        }
        if (typeof raw === 'string') {
          this._log.warn('ignoring text frame on Noise connection');
          continue;
        }
        this.framesReceived += 1;
        const frame = await this.transport!.decryptFrame(raw); // set before the reader starts
        if (frame === null || this._closed) continue;
        const target = this._requests.get(frame.streamId);
        if (target) target.onFrame(frame);
        // Frames for unknown streams (e.g. after an ack) are dropped, as in the SDK.
      }
    } catch (err) {
      // Decrypt/framing/protocol failures end the session (the SDK's reader raises).
      this._log.warn(`Noise receive failed: ${errName(err)}`);
      this._shutdown(new MuseConnectionError('session ended'), err);
    }
  }

  _shutdown(error: Error, outcome: unknown = 'closed'): void {
    if (this._closed) return;
    this._closed = true;
    this._running = false;
    for (const r of this._requests.values()) r.fail(error);
    this._requests.clear();
    this._inbox.length = 0;
    const w = this._inboxWaiter;
    this._inboxWaiter = null;
    if (w) w();
    if (this._ws) {
      try {
        this._ws.close(1000, 'session closed');
      } catch {
        this._log.warn('could not close Noise connection');
      }
    }
    this.ended.resolve(outcome);
  }

  /** Close the session (Python: stop.set() / run() finally). Idempotent. */
  close(): void {
    this._shutdown(new MuseConnectionError('session ended'), 'stopped');
  }

  unregister(streamId: bigint): void {
    this._requests.delete(streamId);
  }

  /**
   * _send_encrypted: encrypt and send under one lock, so concurrent requests
   * cannot reorder ciphertext. Any failure poisons the session.
   */
  sendEncrypted<T extends Uint8Array[] | EncryptedRequest>(
    encrypt: () => Promise<T>,
    { check = null }: { check?: (() => void) | null } = {},
  ): Promise<T> {
    return this._sendLock.run(async () => {
      if (this._closed) throw new MuseConnectionError('session closed');
      if (check !== null) check(); // no nonce consumed: a stale stream need not fail the session
      try {
        const result = await encrypt();
        const frames = Array.isArray(result) ? result : result.frames;
        for (const f of frames) this._ws!.send(f); // open: transport (so _ws) is set
        return result;
      } catch (err) {
        // Delivery is now ambiguous; never reuse this cipher state.
        this._shutdown(new MuseConnectionError('send failed'));
        throw err;
      }
    });
  }

  static httpHeaders(headers: readonly Header[] = []): Header[] {
    return [...headers, header('x-request-id', newRequestId()), header('x-app-id', APP_ID)];
  }

  /**
   * Post a user message to the Muse as coming from this device; resolves on the ack.
   */
  async sendChat(message: string, { sessionId = null, outputModality = 'text', device = null }: ChatOptions = {}): Promise<ChatResult> {
    const body = chatRequestBody({ message, outputModality, deviceId: this._deviceId, sessionId, device });
    return this._postChat(body);
  }

  async _postChat(body: Uint8Array): Promise<ChatResult> {
    if (!this._running) throw new MuseConnectionError('Muse session is not connected');
    return this._request('POST', CHAT_PATH, body, {
      headers: MuseSession.httpHeaders([header('Content-Type', 'application/json')]),
      timeoutMs: this._requestTimeoutMs,
    });
  }

  /** Buffered request for small JSON replies (LinkSession.request). */
  async request(
    method: string,
    path: string,
    body: BytesLike = new Uint8Array(0),
    { headers = [], timeoutMs = this._requestTimeoutMs }: { headers?: readonly Header[]; timeoutMs?: number } = {},
  ): Promise<ChatResult> {
    if (!this._running) throw new MuseConnectionError('Muse session is not connected');
    return this._request(method, path, toBytes(body), { headers, timeoutMs });
  }

  async _request(
    method: string,
    path: string,
    body: Uint8Array,
    { headers, timeoutMs }: { headers: readonly Header[]; timeoutMs: number },
  ): Promise<ChatResult> {
    const uploadInParts = body.length > MAX_INLINE_REQUEST_BYTES;
    const request = new PendingRequest();
    // Set by encrypt(), inside sendEncrypted(); declared wide so the checks below see that.
    let streamId = null as bigint | null;

    // The callers checked _running, so the transport is set.
    const encrypt = async () => {
      const encrypted = uploadInParts
        ? await this.transport!.startStreamRequest(method, path, { headers })
        : await this.transport!.encryptHttpRequest(method, path, body, { headers });
      streamId = encrypted.streamId;
      this._requests.set(streamId, request);
      return encrypted;
    };

    let completed = false;
    let status: number;
    let response: Uint8Array;
    try {
      await this.sendEncrypted(encrypt);
      if (uploadInParts) {
        for (let offset = 0; offset < body.length; offset += REQUEST_CHUNK_BYTES) {
          const part = body.subarray(offset, offset + REQUEST_CHUNK_BYTES);
          const endBody = offset + part.length === body.length;
          await this.sendEncrypted(() => this.transport!.encryptBodyChunk(streamId!, part, { endBody }));
        }
      }
      [status, response] = await withTimeout(request.done.promise, timeoutMs, 'Muse request timed out');
      completed = true;
    } finally {
      if (streamId !== null) this._requests.delete(streamId);
      request.fail(new MuseConnectionError('request ended')); // no-op once settled
      if (!completed && streamId !== null && !this._closed) {
        try {
          await withTimeout(
            this.sendEncrypted(() => this.transport!.encryptReset(streamId!, { reason: 'request ended' })),
            1000,
            'reset timed out',
          );
        } catch {
          this._log.warn('could not reset abandoned request');
        }
      }
    }
    return { ok: status >= 200 && status < 300, status, response: decodeResponseBody(response) };
  }

  /** LinkSession.stream_request: a bounded duplex StreamingRequest. */
  async streamRequest(
    method: string,
    path: string,
    {
      headers = [],
      maxBufferBytes = MAX_BUFFER_BYTES,
      maxBufferChunks = MAX_BUFFER_CHUNKS,
    }: { headers?: readonly Header[]; maxBufferBytes?: number; maxBufferChunks?: number } = {},
  ): Promise<StreamingRequest> {
    if (maxBufferBytes < 1 || maxBufferChunks < 1) throw new RangeError('stream limits must be positive');
    // Set inside the sendEncrypted() callback; declared wide so the checks below see that.
    let stream = null as StreamingRequest | null;
    try {
      await this.sendEncrypted(async () => {
        const encrypted = await this.transport!.startStreamRequest(method, path, { headers });
        stream = new StreamingRequest(this, encrypted.streamId, { maxBufferBytes, maxBufferChunks });
        this._requests.set(encrypted.streamId, stream);
        return encrypted;
      });
    } catch (err) {
      if (stream !== null) this._requests.delete(stream.streamId);
      throw err;
    }
    return stream!; // set: sendEncrypted() resolved, so its callback ran
  }
}

/**
 * One-shot helper for a Durable Object: connect, send one chat message, wait
 * for the ack, close the socket (so nothing after the ack is read).
 */
export async function sendChatOnce(options: MuseSessionOptions, message: string, chatOptions: ChatOptions = {}): Promise<ChatResult> {

  const session = await MuseSession.connect(options);
  try {
    return await session.sendChat(message, chatOptions);
  } finally {
    session.close();
  }
}
