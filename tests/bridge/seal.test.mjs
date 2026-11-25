import { test } from 'node:test';
import assert from 'node:assert/strict';
import nodeCrypto from 'node:crypto';

import { seal, openJson, openBytes, importBridgeKey, generateBridgeKey, b64decode, b64encode, SealError, SEAL_INFO } from '../../worker/bridge/seal.ts';

const b64url = (s) => Buffer.from(s, 'base64url');

test('seal/open round trip, and the public key is X25519(priv, 9)', async () => {
  const { privateKey, publicKey } = await generateBridgeKey();
  const key = await importBridgeKey(privateKey);
  assert.equal(b64encode(key.publicKey), publicKey);

  const payload = { accessToken: 'tok-ünïcode-123', nodeId: 'gadget-abc123', apiUrlV2: 'https://api.muse.ai' };
  const sealed = await seal(payload, publicKey);
  assert.deepEqual(await openJson(sealed, key), payload);
  // Base64url without padding opens too.
  assert.deepEqual(await openJson(sealed.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''), key), payload);
  // Two seals of one payload differ (ephemeral key and nonce).
  assert.notEqual(await seal(payload, publicKey), sealed);
});

test('the bridge public key matches node:crypto for the same private key', async () => {
  const { privateKey } = nodeCrypto.generateKeyPairSync('x25519');
  const jwk = privateKey.export({ format: 'jwk' });
  const key = await importBridgeKey(b64url(jwk.d).toString('base64'));
  assert.deepEqual(Buffer.from(key.publicKey), b64url(jwk.x));
});

test('the format, opened independently with node:crypto (what an ESP32 must produce)', async () => {
  const { privateKey, publicKey } = await generateBridgeKey();
  const sealed = b64decode(await seal({ accessToken: 't', nodeId: 'n' }, publicKey));
  const eph = sealed.subarray(0, 32);
  const nonce = sealed.subarray(32, 44);
  const ct = sealed.subarray(44, sealed.length - 16);
  const tag = sealed.subarray(sealed.length - 16);
  const priv = nodeCrypto.createPrivateKey({
    key: Buffer.concat([Buffer.from('302e020100300506032b656e04220420', 'hex'), b64decode(privateKey)]),
    format: 'der',
    type: 'pkcs8',
  });
  const ephKey = nodeCrypto.createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: Buffer.from(eph).toString('base64url') }, format: 'jwk' });
  const shared = nodeCrypto.diffieHellman({ privateKey: priv, publicKey: ephKey });
  const aes = Buffer.from(nodeCrypto.hkdfSync('sha256', shared, Buffer.concat([eph, b64decode(publicKey)]), SEAL_INFO, 32));
  const d = nodeCrypto.createDecipheriv('aes-256-gcm', aes, nonce);
  d.setAuthTag(tag);
  const plain = Buffer.concat([d.update(ct), d.final()]).toString('utf8');
  assert.deepEqual(JSON.parse(plain), { accessToken: 't', nodeId: 'n' });
});

test('tampering, a wrong key, or junk is refused with SealError', async () => {
  const a = await generateBridgeKey();
  const b = await generateBridgeKey();
  const keyA = await importBridgeKey(a.privateKey);
  const keyB = await importBridgeKey(b.privateKey);
  const sealed = b64decode(await seal({ accessToken: 'x', nodeId: 'y' }, a.publicKey));
  for (const at of [0, 31, 32, 43, 44, sealed.length - 1]) {
    const t = Uint8Array.from(sealed);
    t[at] ^= 0x01;
    await assert.rejects(openBytes(b64encode(t), keyA), SealError, `flip at ${at}`);
  }
  await assert.rejects(openBytes(b64encode(sealed), keyB), SealError);
  await assert.rejects(openBytes(b64encode(sealed.subarray(0, 59)), keyA), SealError);
  await assert.rejects(openBytes('not base64 !!', keyA), SealError);
  // A low-order ephemeral key (all zeros) never reaches AES.
  const lowOrder = Uint8Array.from(sealed);
  lowOrder.fill(0, 0, 32);
  await assert.rejects(openBytes(b64encode(lowOrder), keyA), SealError);
  // Opens, but is not a JSON object.
  await assert.rejects(openJson(await seal(new TextEncoder().encode('[1]'), a.publicKey), keyA), /not an object/);
  await assert.rejects(openJson(await seal(new TextEncoder().encode('{'), a.publicKey), keyA), /not JSON/);
});

test('bridge key must be 32 bytes of base64', async () => {
  await assert.rejects(importBridgeKey(''), SealError);
  await assert.rejects(importBridgeKey(b64encode(new Uint8Array(31))), SealError);
  await assert.rejects(importBridgeKey(undefined), SealError);
});
