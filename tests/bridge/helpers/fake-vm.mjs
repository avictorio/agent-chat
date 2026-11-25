// Test double for the Muse VM's /v1/noise endpoint: a fake WebSocket pair
// and a Noise XX responder that speaks the service envelope protocol.

import { NoiseXXResponder } from '../../../worker/bridge/muse/noise.ts';
import { NoiseFrameDecoder, encodeNoiseFrames } from '../../../worker/bridge/muse/framing.ts';
import { decodeRequestEnvelope, encodeResponseEnvelope, EMPTY_AD } from '../../../worker/bridge/muse/transport.ts';

/** Client-side socket with the standard WebSocket event surface. */
export class FakeSocket {
  constructor(peer) {
    this.peer = peer;
    this.listeners = { message: [], close: [], error: [] };
    this.readyState = 1;
    this.sent = [];
    this.closeCalls = [];
    this.binaryType = 'blob';
  }
  addEventListener(type, fn) {
    (this.listeners[type] ??= []).push(fn);
  }
  send(data) {
    if (this.readyState !== 1) throw new Error('socket not open');
    const copy = new Uint8Array(data);
    this.sent.push(copy);
    this.peer._fromClient(copy);
  }
  close(code, reason) {
    this.closeCalls.push({ code, reason });
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.peer._clientClosed();
    setTimeout(() => this._emit('close', { code: code ?? 1005 }), 0);
  }
  _emit(type, event) {
    for (const fn of this.listeners[type] ?? []) fn(event);
  }
  /** Server -> client delivery (dropped once the client has closed). */
  _deliver(data) {
    if (this.readyState !== 1) {
      this.peer.droppedAfterClose += 1;
      return;
    }
    setTimeout(() => {
      if (this.readyState !== 1) {
        this.peer.droppedAfterClose += 1;
        return;
      }
      this._emit('message', { data: typeof data === 'string' ? data : data.slice().buffer });
    }, 0);
  }
}

/**
 * Fake VM. `connect` is the socket factory to hand to MuseSession; it records
 * the URL and headers of the upgrade.
 */
export class FakeVm {
  constructor({ rejectStatus = null, keyGen, msg2Override = null } = {}) {
    this.rejectStatus = rejectStatus;
    this.upgrades = [];
    this.responder = new NoiseXXResponder({ keyGen });
    this.msg2Override = msg2Override;
    this.phase = 'msg1';
    this.send = null;
    this.recv = null;
    this.decoder = new NoiseFrameDecoder();
    this.frames = [];
    this.frameWaiters = [];
    this.chain = Promise.resolve();
    this.errors = [];
    this.clientClosed = false;
    this.droppedAfterClose = 0;
    this.socket = null;
    this.handshakeDone = new Promise((r) => (this._handshakeDone = r));
    this.connect = async (url, headers) => {
      this.upgrades.push({ url, headers });
      if (this.rejectStatus) {
        const { UpgradeRejected } = await import('../../../worker/bridge/muse/errors.ts');
        throw new UpgradeRejected(this.rejectStatus);
      }
      await this.responder.initialize();
      this.socket = new FakeSocket(this);
      return this.socket;
    };
  }

  _fromClient(bytes) {
    this.chain = this.chain.then(() => this._handle(bytes)).catch((err) => this.errors.push(err));
  }

  _clientClosed() {
    this.clientClosed = true;
  }

  async _handle(bytes) {
    if (this.phase === 'msg1') {
      const msg2 = await this.responder.readMessage1AndWriteMessage2(bytes);
      this.phase = 'msg3';
      this.socket._deliver(this.msg2Override ? this.msg2Override(msg2) : msg2);
    } else if (this.phase === 'msg3') {
      await this.responder.readMessage3(bytes);
      [this.send, this.recv] = await this.responder.split();
      this.phase = 'transport';
      this._handshakeDone();
    } else {
      const plain = await this.recv.decryptWithAd(EMPTY_AD, bytes);
      const whole = this.decoder.decode(plain);
      if (whole === null) return;
      const frame = decodeRequestEnvelope(whole);
      const waiter = this.frameWaiters.shift();
      if (waiter) waiter(frame);
      else this.frames.push(frame);
    }
  }

  /** Next ServiceFrame the client sent after the handshake. */
  nextFrame() {
    if (this.frames.length) return Promise.resolve(this.frames.shift());
    return new Promise((resolve) => this.frameWaiters.push(resolve));
  }

  /** Encrypt and deliver a ServiceFrame (VM -> client). */
  async sendFrame(frame) {
    const bytes = encodeResponseEnvelope(frame);
    for (const f of encodeNoiseFrames(bytes)) {
      this.socket._deliver(await this.send.encryptWithAd(EMPTY_AD, f));
    }
  }

  sendRaw(data) {
    this.socket._deliver(data);
  }

  /** Simulate the VM closing the connection. */
  closeFromServer() {
    this.socket.readyState = 3;
    setTimeout(() => this.socket._emit('close', { code: 1000 }), 0);
  }
}
