// Derived from facebookincubator/muse-gadget-sdk at commit e17081a
// (linux/src/musegadget/noise/noise_xx.py). Copyright (c) Meta Platforms, Inc.
// and affiliates. Licensed under the Apache License, Version 2.0; see
// LICENSE-muse-gadget-sdk and NOTICE. Modified: ported from Python to JavaScript, then TypeScript.

//
// Noise_XX_25519_AESGCM_SHA256 on WebCrypto (crypto.subtle), as available in
// Cloudflare Workers and Node 24. Every WebCrypto call is asynchronous, so all
// CipherState / handshake operations return Promises. Nonces are reserved
// synchronously before the first await, but callers must still serialise
// encrypt -> send (and receive -> decrypt) so ciphertexts reach the wire in
// nonce order; session.ts does that with a send queue and a receive queue.
//
// Key material: JavaScript cannot zero CryptoKey objects or guarantee that
// copies are wiped. As in the SDK, references are dropped after split() and
// destroy(); private keys are generated non-extractable.

import { NoiseProtocolError } from './errors.js';
import { concatBytes, toBytes } from './proto.js';
import type { BytesLike } from './proto.js';

const subtle = crypto.subtle;
const textEncoder = new TextEncoder();

export const PROTOCOL_NAME = textEncoder.encode('Noise_XX_25519_AESGCM_SHA256');
export const DH_KEY_LEN = 32;
export const AEAD_TAG_LEN = 16;
export const MIN_MSG2_LEN = DH_KEY_LEN + (DH_KEY_LEN + AEAD_TAG_LEN) + AEAD_TAG_LEN;
export const MIN_MSG3_LEN = DH_KEY_LEN + AEAD_TAG_LEN + AEAD_TAG_LEN;
export const MAX_SAFE_NONCE = Number.MAX_SAFE_INTEGER; // (1 << 53) - 1

const EMPTY = new Uint8Array(0);
const ALL_ZEROS_32 = new Uint8Array(32);

/** An X25519 key pair: the private key stays inside WebCrypto. */
export interface X25519KeyPair {
  privateKey: CryptoKey;
  publicKeyBytes: Uint8Array;
}

/** Key pair source for the handshakes ('e' ephemeral, 's' static); injectable for tests. */
export type KeyGen = (role: 'e' | 's') => Promise<X25519KeyPair>;

// Only ever called on the even-length hex constants below, so match() finds pairs.
const fromHex = (hex: string): Uint8Array => Uint8Array.from(hex.match(/../g)!.map((b) => parseInt(b, 16)));

export const X25519_LOW_ORDER_POINTS = Object.freeze([
  new Uint8Array(32),
  concatBytes(Uint8Array.of(1), new Uint8Array(31)),
  fromHex('e0eb7a7c3b41b8ae1656e3faf19fc46ada098deb9c32b1fd866205165f49b800'),
  fromHex('5f9c95bca3508c24b1d0b1559c83ef5b04445cc4581c8e86d8224eddd09f1157'),
  fromHex('ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f'),
  fromHex('edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f'),
  fromHex('eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f'),
]);

/** Constant-time equality for equal-length byte strings (hmac.compare_digest). */
export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

async function hmacSha256(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const k = await subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await subtle.sign('HMAC', k, data));
}

async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await subtle.digest('SHA-256', data));
}

/** Noise HKDF with 2 or 3 outputs. Exported for tests. */
export async function hkdf(chainingKey: Uint8Array, inputKeyMaterial: Uint8Array, numOutputs: number): Promise<Uint8Array[]> {
  if (numOutputs !== 2 && numOutputs !== 3) throw new RangeError('hkdf supports 2 or 3 outputs');
  const tempKey = await hmacSha256(chainingKey, inputKeyMaterial);
  const output1 = await hmacSha256(tempKey, Uint8Array.of(1));
  const output2 = await hmacSha256(tempKey, concatBytes(output1, Uint8Array.of(2)));
  if (numOutputs === 2) return [output1, output2];
  const output3 = await hmacSha256(tempKey, concatBytes(output2, Uint8Array.of(3)));
  return [output1, output2, output3];
}

/** 12-byte AES-GCM IV: 4 zero bytes then the 64-bit big-endian counter. */
export function buildNonceIv(nonce: number): Uint8Array<ArrayBuffer> {
  if (!Number.isSafeInteger(nonce) || nonce < 0) throw new NoiseProtocolError('nonce outside uint64 range');
  const iv = new Uint8Array(12);
  new DataView(iv.buffer).setBigUint64(4, BigInt(nonce), false);
  return iv;
}

export class CipherState {
  _key: CryptoKey | null;
  _keyed: boolean;
  _nonce: number;
  _poisoned: boolean;

  constructor() {
    this._key = null; // CryptoKey (AES-GCM, non-extractable)
    this._keyed = false;
    this._nonce = 0;
    this._poisoned = false;
  }

  _assertAlive(): void {
    if (this._poisoned) throw new NoiseProtocolError('CipherState: poisoned after prior failure');
  }

  async initializeKey(key: BytesLike): Promise<void> {
    this._assertAlive();
    const raw = toBytes(key);
    if (raw.length !== 32) throw new NoiseProtocolError('CipherState: AES-GCM key must be 32 bytes');
    this._key = await subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
    this._keyed = true;
    this._nonce = 0;
  }

  hasKey(): boolean {
    return this._keyed;
  }

  /** Test hook: the next nonce this state will use. */
  get nonce(): number {
    return this._nonce;
  }

  /** Test hook (nonce exhaustion): jump the counter. Not for production use. */
  _setNonceForTest(n: number): void {
    this._nonce = n;
  }

  _nextNonce(): number {
    if (this._nonce >= MAX_SAFE_NONCE) {
      this._poisoned = true;
      throw new NoiseProtocolError('CipherState: nonce exhausted');
    }
    const current = this._nonce;
    this._nonce += 1;
    return current;
  }

  async encryptWithAd(ad: BytesLike, plaintext: BytesLike): Promise<Uint8Array> {
    this._assertAlive();
    const pt = toBytes(plaintext);
    if (!this._keyed) return pt;
    const nonce = this._nextNonce();
    try {
      const ct = await subtle.encrypt(
        { name: 'AES-GCM', iv: buildNonceIv(nonce), additionalData: toBytes(ad), tagLength: 128 },
        this._key!, // set whenever _keyed is
        pt,
      );
      return new Uint8Array(ct);
    } catch (err) {
      this._poisoned = true;
      throw err;
    }
  }

  async decryptWithAd(ad: BytesLike, ciphertext: BytesLike): Promise<Uint8Array> {
    this._assertAlive();
    const ct = toBytes(ciphertext);
    if (!this._keyed) return ct;
    const nonce = this._nextNonce();
    try {
      const pt = await subtle.decrypt(
        { name: 'AES-GCM', iv: buildNonceIv(nonce), additionalData: toBytes(ad), tagLength: 128 },
        this._key!, // set whenever _keyed is
        ct,
      );
      return new Uint8Array(pt);
    } catch {
      // WebCrypto reports a bad tag (and a too-short input) as OperationError.
      this._poisoned = true;
      throw new NoiseProtocolError('CipherState: decrypt failed');
    }
  }
}

// -- X25519 -----------------------------------------------------------------------

const PKCS8_X25519_PREFIX = fromHex('302e020100300506032b656e04220420');

/** Generate an ephemeral/static key pair: {privateKey: CryptoKey, publicKeyBytes: Uint8Array}. */
export async function generateX25519KeyPair(): Promise<X25519KeyPair> {
  // X25519 generateKey() always yields a pair, and a raw export an ArrayBuffer;
  // the Workers types only give the general unions.
  const pair = (await subtle.generateKey({ name: 'X25519' }, false, ['deriveBits'])) as CryptoKeyPair;
  const publicKeyBytes = new Uint8Array((await subtle.exportKey('raw', pair.publicKey)) as ArrayBuffer);

  return { privateKey: pair.privateKey, publicKeyBytes };
}

/**
 * Import a fixed key pair (deterministic tests / interop fixtures only).
 * @param {Uint8Array} privateBytes 32-byte X25519 scalar
 * @param {Uint8Array} publicBytes its 32-byte public key
 */
export async function importX25519KeyPair(privateBytes: BytesLike, publicBytes: BytesLike): Promise<X25519KeyPair> {
  const privateKey = await subtle.importKey(
    'pkcs8',
    concatBytes(PKCS8_X25519_PREFIX, toBytes(privateBytes)),
    { name: 'X25519' },
    false,
    ['deriveBits'],
  );
  return { privateKey, publicKeyBytes: new Uint8Array(toBytes(publicBytes)) };
}

export async function x25519Dh(privateKey: CryptoKey, publicKeyBytes: BytesLike): Promise<Uint8Array> {
  const pub = toBytes(publicKeyBytes);
  if (pub.length !== DH_KEY_LEN) throw new NoiseProtocolError('x25519: invalid public key length');
  // Check every point (no early exit), like the SDK's compare_digest loop.
  let lowOrder = false;
  for (const p of X25519_LOW_ORDER_POINTS) lowOrder = constantTimeEqual(pub, p) || lowOrder;
  if (lowOrder) throw new NoiseProtocolError('x25519: rejected low-order public key');
  let shared;
  try {
    const publicKey = await subtle.importKey('raw', pub, { name: 'X25519' }, false, []);
    shared = new Uint8Array(await subtle.deriveBits({ name: 'X25519', public: publicKey }, privateKey, 256));
  } catch {
    // Some WebCrypto implementations refuse an all-zero shared secret
    // themselves (OperationError); report it the way the SDK does.
    throw new NoiseProtocolError('x25519: DH failed');
  }
  if (constantTimeEqual(shared, ALL_ZEROS_32)) throw new NoiseProtocolError('x25519: DH produced all-zeros output');
  return shared;
}

// -- SymmetricState -----------------------------------------------------------------

export class SymmetricState {
  _ck: Uint8Array;
  _h: Uint8Array;
  _cipher: CipherState;

  constructor() {
    this._ck = new Uint8Array(32);
    this._h = new Uint8Array(32);
    this._cipher = new CipherState();
  }

  async initialize(): Promise<void> {
    const padded = new Uint8Array(32);
    padded.set(PROTOCOL_NAME);
    this._h = padded;
    this._ck = padded;
    await this.mixHash(EMPTY);
  }

  async mixHash(data: BytesLike): Promise<void> {
    this._h = await sha256(concatBytes(this._h, toBytes(data)));
  }

  async mixKey(inputKeyMaterial: BytesLike): Promise<void> {
    const [ck, tempK] = await hkdf(this._ck, toBytes(inputKeyMaterial), 2);
    this._ck = ck;
    this._cipher = new CipherState();
    await this._cipher.initializeKey(tempK);
  }

  async encryptAndHash(plaintext: BytesLike): Promise<Uint8Array> {
    const ciphertext = await this._cipher.encryptWithAd(this._h, plaintext);
    await this.mixHash(ciphertext);
    return ciphertext;
  }

  async decryptAndHash(ciphertext: BytesLike): Promise<Uint8Array> {
    const plaintext = await this._cipher.decryptWithAd(this._h, ciphertext);
    await this.mixHash(ciphertext);
    return plaintext;
  }

  async split(): Promise<[CipherState, CipherState]> {
    const [tempK1, tempK2] = await hkdf(this._ck, EMPTY, 2);
    this._ck = new Uint8Array(32);
    this._h = new Uint8Array(32);
    const c1 = new CipherState();
    await c1.initializeKey(tempK1);
    const c2 = new CipherState();
    await c2.initializeKey(tempK2);
    return [c1, c2];
  }

  handshakeHash(): Uint8Array {
    return new Uint8Array(this._h);
  }
}

// -- Handshake state machines -------------------------------------------------------

export const Phase = Object.freeze({
  CREATED: 0,
  INITIALIZED: 1,
  MSG1_SENT: 2,
  MSG2_READ: 3,
  MSG3_SENT: 4,
  SPLIT: 5,
  DEAD: 6,
});

export type PhaseValue = (typeof Phase)[keyof typeof Phase];

function requirePhase(actual: PhaseValue, expected: PhaseValue, method: string): void {
  if (actual === Phase.DEAD) throw new NoiseProtocolError(`NoiseXX: ${method} called on dead handshake`);
  if (actual !== expected) {
    throw new NoiseProtocolError(`NoiseXX: ${method} called in wrong phase (expected ${expected}, got ${actual})`);
  }
}

/**
 * XX initiator. `keyGen` is injectable for deterministic tests:
 *   keyGen(role) -> Promise<{privateKey, publicKeyBytes}>, role 'e' or 's'.
 * Each method is guarded against concurrent use by the phase machine: a call
 * moves the phase only after it completes, and a second concurrent call is
 * refused via the `_busy` flag.
 */
export class NoiseXXInitiator {
  _ss: SymmetricState;
  _e: X25519KeyPair | null;
  _s: X25519KeyPair | null;
  _re: Uint8Array | null;
  _rs: Uint8Array | null;
  _phase: PhaseValue;
  _busy: boolean;
  _keyGen: KeyGen;

  constructor({ keyGen }: { keyGen?: KeyGen | undefined } = {}) {
    this._ss = new SymmetricState();
    this._e = null;
    this._s = null;
    this._re = null;
    this._rs = null;
    this._phase = Phase.CREATED;
    this._busy = false;
    this._keyGen = keyGen ?? (() => generateX25519KeyPair());
  }

  get phase(): PhaseValue {
    return this._phase;
  }

  async _step<T>(expected: PhaseValue, method: string, body: () => Promise<T>): Promise<T> {
    requirePhase(this._phase, expected, method);
    if (this._busy) throw new NoiseProtocolError(`NoiseXX: ${method} called while another step runs`);
    this._busy = true;
    try {
      return await body();
    } catch (err) {
      this._phase = Phase.DEAD;
      throw err;
    } finally {
      this._busy = false;
    }
  }

  async initialize(): Promise<void> {
    requirePhase(this._phase, Phase.CREATED, 'initialize');
    await this._ss.initialize();
    this._phase = Phase.INITIALIZED;
  }

  /** -> e */
  async writeMessage1(): Promise<Uint8Array> {
    return this._step(Phase.INITIALIZED, 'write_message1', async () => {
      this._e = await this._keyGen('e');
      await this._ss.mixHash(this._e.publicKeyBytes);
      await this._ss.encryptAndHash(EMPTY);
      this._phase = Phase.MSG1_SENT;
      return new Uint8Array(this._e.publicKeyBytes);
    });
  }

  /** <- e, ee, s, es (+ payload). Returns the decrypted payload. */
  async readMessage2(msg: Uint8Array): Promise<Uint8Array> {
    requirePhase(this._phase, Phase.MSG1_SENT, 'read_message2');
    msg = toBytes(msg);
    if (msg.length < MIN_MSG2_LEN) {
      this._phase = Phase.DEAD;
      throw new NoiseProtocolError(`NoiseXX: message 2 too short (${msg.length} < ${MIN_MSG2_LEN})`);
    }
    return this._step(Phase.MSG1_SENT, 'read_message2', async () => {
      let offset = 0;
      this._re = msg.slice(offset, offset + DH_KEY_LEN);
      await this._ss.mixHash(this._re);
      offset += DH_KEY_LEN;

      if (this._e === null) throw new NoiseProtocolError('NoiseXX: missing initiator ephemeral key');
      const ee = await x25519Dh(this._e.privateKey, this._re);
      await this._ss.mixKey(ee);

      this._rs = await this._ss.decryptAndHash(msg.subarray(offset, offset + DH_KEY_LEN + AEAD_TAG_LEN));
      offset += DH_KEY_LEN + AEAD_TAG_LEN;

      const es = await x25519Dh(this._e.privateKey, this._rs);
      await this._ss.mixKey(es);

      const payload = await this._ss.decryptAndHash(msg.subarray(offset));
      this._phase = Phase.MSG2_READ;
      return payload;
    });
  }

  /** -> s, se (empty payload). */
  async writeMessage3(): Promise<Uint8Array> {
    return this._step(Phase.MSG2_READ, 'write_message3', async () => {
      this._s = await this._keyGen('s');
      const encS = await this._ss.encryptAndHash(this._s.publicKeyBytes);
      if (this._re === null) throw new NoiseProtocolError('NoiseXX: missing responder ephemeral key');
      const se = await x25519Dh(this._s.privateKey, this._re);
      await this._ss.mixKey(se);
      const encPayload = await this._ss.encryptAndHash(EMPTY);
      this._phase = Phase.MSG3_SENT;
      return concatBytes(encS, encPayload);
    });
  }

  /** [send, recv] */
  async split(): Promise<[CipherState, CipherState]> {
    requirePhase(this._phase, Phase.MSG3_SENT, 'split');
    this._phase = Phase.SPLIT;
    const result = await this._ss.split();
    this._e = this._s = this._re = this._rs = null;
    return result;
  }

  destroy(): void {
    this._e = this._s = this._re = this._rs = null;
    this._phase = Phase.DEAD;
  }

  remoteStaticPublicKey(): Uint8Array | null {
    return this._rs === null ? null : new Uint8Array(this._rs);
  }

  handshakeHash(): Uint8Array {
    return this._ss.handshakeHash();
  }
}

/** XX responder: test peer only (the SDK ships it for protocol verification). */
export class NoiseXXResponder {
  _ss: SymmetricState;
  _e: X25519KeyPair | null;
  _s: X25519KeyPair | null;
  _re: Uint8Array | null;
  _payload: Uint8Array;
  _phase: PhaseValue;
  _keyGen: KeyGen;

  constructor({ payload = EMPTY, keyGen }: { payload?: BytesLike; keyGen?: KeyGen | undefined } = {}) {
    this._ss = new SymmetricState();
    this._e = null;
    this._s = null;
    this._re = null;
    this._payload = new Uint8Array(toBytes(payload));
    this._phase = Phase.CREATED;
    this._keyGen = keyGen ?? (() => generateX25519KeyPair());
  }

  async initialize(): Promise<void> {
    requirePhase(this._phase, Phase.CREATED, 'initialize');
    await this._ss.initialize();
    this._phase = Phase.INITIALIZED;
  }

  async readMessage1AndWriteMessage2(msg1: Uint8Array): Promise<Uint8Array> {
    requirePhase(this._phase, Phase.INITIALIZED, 'read_message1_and_write_message2');
    msg1 = toBytes(msg1);
    if (msg1.length < DH_KEY_LEN) {
      this._phase = Phase.DEAD;
      throw new NoiseProtocolError(`NoiseXX: message 1 too short (${msg1.length} < ${DH_KEY_LEN})`);
    }
    try {
      this._re = msg1.slice(0, DH_KEY_LEN);
      await this._ss.mixHash(this._re);
      await this._ss.decryptAndHash(msg1.subarray(DH_KEY_LEN));

      this._e = await this._keyGen('e');
      await this._ss.mixHash(this._e.publicKeyBytes);
      const ee = await x25519Dh(this._e.privateKey, this._re);
      await this._ss.mixKey(ee);

      this._s = await this._keyGen('s');
      const encS = await this._ss.encryptAndHash(this._s.publicKeyBytes);
      const es = await x25519Dh(this._s.privateKey, this._re);
      await this._ss.mixKey(es);

      const encPayload = await this._ss.encryptAndHash(this._payload);
      this._phase = Phase.MSG2_READ;
      return concatBytes(this._e.publicKeyBytes, encS, encPayload);
    } catch (err) {
      this._phase = Phase.DEAD;
      throw err;
    }
  }

  async readMessage3(msg3: Uint8Array): Promise<void> {
    requirePhase(this._phase, Phase.MSG2_READ, 'read_message3');
    msg3 = toBytes(msg3);
    if (msg3.length < MIN_MSG3_LEN) {
      this._phase = Phase.DEAD;
      throw new NoiseProtocolError(`NoiseXX: message 3 too short (${msg3.length} < ${MIN_MSG3_LEN})`);
    }
    try {
      let offset = 0;
      const rs = await this._ss.decryptAndHash(msg3.subarray(offset, offset + DH_KEY_LEN + AEAD_TAG_LEN));
      offset += DH_KEY_LEN + AEAD_TAG_LEN;
      if (this._e === null) throw new NoiseProtocolError('NoiseXX: missing responder ephemeral key');
      const se = await x25519Dh(this._e.privateKey, rs);
      await this._ss.mixKey(se);
      await this._ss.decryptAndHash(msg3.subarray(offset));
      this._phase = Phase.MSG3_SENT;
    } catch (err) {
      this._phase = Phase.DEAD;
      throw err;
    }
  }

  /** [send, recv] for the responder. */
  async split(): Promise<[CipherState, CipherState]> {
    requirePhase(this._phase, Phase.MSG3_SENT, 'split');
    this._phase = Phase.SPLIT;
    const [c1, c2] = await this._ss.split();
    this._e = this._s = this._re = null;
    return [c2, c1];
  }

  handshakeHash(): Uint8Array {
    return this._ss.handshakeHash();
  }
}
