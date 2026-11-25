// Sealed handover of a Muse access token from a gadget to the bridge.
//
// Format ("muse-bridge seal v1"), base64 of:
//   eph_pub (32 B) || nonce (12 B) || AES-256-GCM ciphertext || tag (16 B)
// where
//   shared = X25519(eph_priv, bridge_pub)            (= X25519(bridge_priv, eph_pub))
//   key    = HKDF-SHA256(ikm = shared, salt = eph_pub || bridge_pub,
//                        info = "muse-bridge seal v1", L = 32)
//   AES-GCM with that key and nonce, no additional data, 128-bit tag.
// The plaintext is UTF-8 JSON: {accessToken, nodeId, apiUrlV2?, noiseHost?}.
// Every primitive is in mbedTLS (mbedtls_ecdh on Curve25519, mbedtls_hkdf,
// mbedtls_gcm), so an ESP32 can seal with what it already links.

import { x25519Dh } from './muse/noise.js';
import { concatBytes } from './muse/proto.js';

const subtle = crypto.subtle;
const utf8 = new TextEncoder();

export const SEAL_INFO = 'muse-bridge seal v1';
export const SEAL_ALG = 'X25519-HKDF-SHA256-AES-256-GCM';
export const EPH_LEN = 32;
export const NONCE_LEN = 12;
export const TAG_LEN = 16;
export const SEAL_OVERHEAD = EPH_LEN + NONCE_LEN + TAG_LEN;
/** Largest sealed blob accepted, in bytes before base64. */
export const SEALED_MAX = 16 * 1024;

const PKCS8_X25519_PREFIX = Uint8Array.from([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x04, 0x22, 0x04, 0x20,
]);
const BASEPOINT = (() => {
  const b = new Uint8Array(32);
  b[0] = 9;
  return b;
})();

/** The bridge key pair: the private key stays inside WebCrypto. */
export interface BridgeKey {
  privateKey: CryptoKey;
  publicKey: Uint8Array;
}

/** Never carries key material or plaintext. */
export class SealError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SealError';
  }
}

export function b64encode(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Standard or URL-safe base64, padding optional, whitespace ignored. */
export function b64decode(text: unknown): Uint8Array {
  if (typeof text !== 'string') throw new SealError('expected a base64 string');
  let s = text.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(s)) throw new SealError('not base64');
  s = s.replace(/=+$/, '');
  if (s.length % 4 === 1) throw new SealError('not base64');
  s += '='.repeat((4 - (s.length % 4)) % 4);
  let bin;
  try {
    bin = atob(s);
  } catch {
    throw new SealError('not base64');
  }
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function importPrivate(raw: Uint8Array): Promise<CryptoKey> {
  return subtle.importKey('pkcs8', concatBytes(PKCS8_X25519_PREFIX, raw), { name: 'X25519' }, false, ['deriveBits']);
}

/** X25519 public key of a private key: the scalar times the base point. */
async function publicOf(privateKey: CryptoKey): Promise<Uint8Array> {
  const base = await subtle.importKey('raw', BASEPOINT, { name: 'X25519' }, false, []);
  return new Uint8Array(await subtle.deriveBits({ name: 'X25519', public: base }, privateKey, 256));
}

/**
 * The bridge key pair from MUSE_SEAL_KEY (base64 of the raw 32-byte X25519
 * private key): {privateKey: CryptoKey, publicKey: Uint8Array}.
 */
export async function importBridgeKey(base64Private: string | undefined): Promise<BridgeKey> {
  let raw;
  try {
    raw = b64decode(base64Private ?? '');
  } catch {
    throw new SealError('bridge key is not base64');
  }
  if (raw.length !== 32) throw new SealError('bridge key must be 32 bytes');
  const privateKey = await importPrivate(raw);
  raw.fill(0);
  return { privateKey, publicKey: await publicOf(privateKey) };
}

/** A fresh key pair as base64 strings (scripts/bridge/keygen.mjs, tests). */
export async function generateBridgeKey(): Promise<{ privateKey: string; publicKey: string }> {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  const privateKey = await importPrivate(raw);
  const pub = await publicOf(privateKey);
  const out = { privateKey: b64encode(raw), publicKey: b64encode(pub) };
  raw.fill(0);
  return out;
}

async function aesKey(shared: Uint8Array, ephPub: Uint8Array, bridgePub: Uint8Array, usage: 'encrypt' | 'decrypt'): Promise<CryptoKey> {
  const ikm = await subtle.importKey('raw', shared, 'HKDF', false, ['deriveBits']);
  const bits = await subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: concatBytes(ephPub, bridgePub), info: utf8.encode(SEAL_INFO) },
    ikm,
    256,
  );
  return subtle.importKey('raw', bits, { name: 'AES-GCM' }, false, [usage]);
}

/**
 * Seal bytes or a JSON-able value to a bridge public key (raw 32 bytes or
 * base64). Returns the base64 blob. Used by scripts/bridge/seal.mjs and the tests; the
 * gadget does the same in C.
 */
export async function seal(payload: unknown, bridgePublicKey: Uint8Array | string): Promise<string> {
  const bridgePub = typeof bridgePublicKey === 'string' ? b64decode(bridgePublicKey) : bridgePublicKey;
  if (bridgePub.length !== 32) throw new SealError('bridge public key must be 32 bytes');
  const plain = payload instanceof Uint8Array ? payload : utf8.encode(JSON.stringify(payload));
  // X25519 generateKey() always yields a pair, and a raw export an ArrayBuffer;
  // the Workers types only give the general unions.
  const eph = (await subtle.generateKey({ name: 'X25519' }, false, ['deriveBits'])) as CryptoKeyPair;
  const ephPub = new Uint8Array((await subtle.exportKey('raw', eph.publicKey)) as ArrayBuffer);
  const shared = await x25519Dh(eph.privateKey, bridgePub);
  const key = await aesKey(shared, ephPub, bridgePub, 'encrypt');
  shared.fill(0);
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_LEN));
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv: nonce, tagLength: 128 }, key, plain));
  return b64encode(concatBytes(ephPub, nonce, ct));
}

/** Open a sealed blob to its plaintext bytes; throws SealError on any failure. */
export async function openBytes(sealedBase64: string, bridgeKey: BridgeKey): Promise<Uint8Array> {
  const blob = b64decode(sealedBase64);
  if (blob.length < SEAL_OVERHEAD) throw new SealError('sealed blob too short');
  if (blob.length > SEALED_MAX) throw new SealError('sealed blob too large');
  const ephPub = blob.subarray(0, EPH_LEN);
  const nonce = blob.subarray(EPH_LEN, EPH_LEN + NONCE_LEN);
  const ct = blob.subarray(EPH_LEN + NONCE_LEN);
  try {
    const shared = await x25519Dh(bridgeKey.privateKey, ephPub); // rejects low-order points
    const key = await aesKey(shared, ephPub, bridgeKey.publicKey, 'decrypt');
    shared.fill(0);
    return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: nonce, tagLength: 128 }, key, ct));
  } catch {
    throw new SealError('sealed blob does not open');
  }
}

/** Open a sealed blob holding a JSON object. */
export async function openJson(sealedBase64: string, bridgeKey: BridgeKey): Promise<Record<string, unknown>> {
  const plain = await openBytes(sealedBase64, bridgeKey);
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(plain));
  } catch {
    throw new SealError('sealed payload is not JSON');
  } finally {
    plain.fill(0);
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new SealError('sealed payload is not an object');
  return value as Record<string, unknown>; // checked just above: a JSON object

}
