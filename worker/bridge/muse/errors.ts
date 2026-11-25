// Derived from facebookincubator/muse-gadget-sdk at commit e17081a
// (linux/src/musegadget/noise/*.py, link_client.py, streaming.py).
// Copyright (c) Meta Platforms, Inc. and affiliates. Licensed under the
// Apache License, Version 2.0; see LICENSE-muse-gadget-sdk and NOTICE.
// Modified: ported from Python to JavaScript, then TypeScript.
//
// Error messages never carry tokens, message text or key material.

/** A Muse Noise protobuf message is malformed (Python: ProtoError(ValueError)). */
export class ProtoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProtoError';
  }
}

/** A Noise handshake or transport state machine was violated. */
export class NoiseProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NoiseProtocolError';
  }
}

/** Python ConnectionError equivalent: the session or a stream ended or failed. */
export class MuseConnectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MuseConnectionError';
  }
}

/** The edge refused the WebSocket upgrade (401: re-fetch VMs; 403: forbidden). */
export class UpgradeRejected extends MuseConnectionError {
  status: number;

  constructor(status: number) {
    super(`VM refused connection: HTTP ${status}`);
    this.name = 'UpgradeRejected';
    this.status = status;
  }
}

/** streaming.HTTPStatusError: the body is kept but never put in the message. */
export class HTTPStatusError extends MuseConnectionError {
  status: number;
  body: Uint8Array;

  constructor(status: number, body: Uint8Array) {
    super(`request refused: HTTP ${status}`);
    this.name = 'HTTPStatusError';
    this.status = status;
    this.body = body;
  }
}

/** link_client.RequestRejected: Muse refused a send_chat request. */
export class RequestRejected extends MuseConnectionError {
  status: number;

  constructor(status: number) {
    super(`Muse rejected conversation request: HTTP ${status}`);
    this.name = 'RequestRejected';
    this.status = status;
  }
}

/** A deadline passed (Python asyncio.TimeoutError). */
export class MuseTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MuseTimeoutError';
  }
}

/** err?.name ?? 'Error' for a caught value of any type: what the logs carry. */
export function errName(err: unknown): unknown {
  const name = (typeof err === 'object' || typeof err === 'function') && err !== null && 'name' in err ? err.name : undefined;
  return name ?? 'Error';
}
