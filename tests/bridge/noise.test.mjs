import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CipherState,
  NoiseXXInitiator,
  NoiseXXResponder,
  MAX_SAFE_NONCE,
  MIN_MSG2_LEN,
  MIN_MSG3_LEN,
  Phase,
  buildNonceIv,
  constantTimeEqual,
  hkdf,
  generateX25519KeyPair,
  x25519Dh,
  X25519_LOW_ORDER_POINTS,
} from '../../worker/bridge/muse/noise.ts';
import { NoiseProtocolError } from '../../worker/bridge/muse/errors.ts';

const utf8 = (s) => new TextEncoder().encode(s);
const EMPTY = new Uint8Array(0);

async function handshake() {
  const ini = new NoiseXXInitiator();
  const res = new NoiseXXResponder();
  await ini.initialize();
  await res.initialize();
  const m2 = await res.readMessage1AndWriteMessage2(await ini.writeMessage1());
  await ini.readMessage2(m2);
  await res.readMessage3(await ini.writeMessage3());
  assert.deepEqual(ini.handshakeHash(), res.handshakeHash());
  const [iSend, iRecv] = await ini.split();
  const [rSend, rRecv] = await res.split();
  return { ini, res, iSend, iRecv, rSend, rRecv };
}

test('message sizes are the XX minimums with empty payloads', async () => {
  const ini = new NoiseXXInitiator();
  const res = new NoiseXXResponder();
  await ini.initialize();
  await res.initialize();
  const m1 = await ini.writeMessage1();
  assert.equal(m1.length, 32);
  const m2 = await res.readMessage1AndWriteMessage2(m1);
  assert.equal(m2.length, MIN_MSG2_LEN);
  await ini.readMessage2(m2);
  const m3 = await ini.writeMessage3();
  assert.equal(m3.length, MIN_MSG3_LEN);
});

test('split cipher states talk both ways and keep nonces in step', async () => {
  const { iSend, iRecv, rSend, rRecv } = await handshake();
  for (let i = 0; i < 3; i++) {
    const ct = await iSend.encryptWithAd(EMPTY, utf8(`c${i}`));
    assert.equal(new TextDecoder().decode(await rRecv.decryptWithAd(EMPTY, ct)), `c${i}`);
    const back = await rSend.encryptWithAd(EMPTY, utf8(`s${i}`));
    assert.equal(new TextDecoder().decode(await iRecv.decryptWithAd(EMPTY, back)), `s${i}`);
  }
  assert.equal(iSend.nonce, 3);
});

test('a failed decrypt poisons the cipher state', async () => {
  const { iSend, rRecv } = await handshake();
  const ct = await iSend.encryptWithAd(EMPTY, utf8('x'));
  ct[0] ^= 1;
  await assert.rejects(rRecv.decryptWithAd(EMPTY, ct), /decrypt failed/);
  await assert.rejects(rRecv.decryptWithAd(EMPTY, ct), /poisoned/);
});

test('replayed or reordered ciphertext fails', async () => {
  const { iSend, rRecv } = await handshake();
  const a = await iSend.encryptWithAd(EMPTY, utf8('a'));
  const b = await iSend.encryptWithAd(EMPTY, utf8('b'));
  await assert.rejects(rRecv.decryptWithAd(EMPTY, b), NoiseProtocolError);
  void a;
});

test('nonce exhaustion poisons the state', async () => {
  const c = new CipherState();
  await c.initializeKey(new Uint8Array(32));
  c._setNonceForTest(MAX_SAFE_NONCE - 1);
  await c.encryptWithAd(EMPTY, EMPTY);
  await assert.rejects(c.encryptWithAd(EMPTY, EMPTY), /nonce exhausted/);
  await assert.rejects(c.encryptWithAd(EMPTY, EMPTY), /poisoned/);
  assert.throws(() => buildNonceIv(-1), NoiseProtocolError);
});

test('unkeyed cipher states pass data through; keys must be 32 bytes', async () => {
  const c = new CipherState();
  assert.deepEqual(await c.encryptWithAd(EMPTY, utf8('p')), utf8('p'));
  await assert.rejects(c.initializeKey(new Uint8Array(16)), /32 bytes/);
});

test('hkdf supports only 2 or 3 outputs', async () => {
  await assert.rejects(hkdf(new Uint8Array(32), EMPTY, 1), RangeError);
  assert.equal((await hkdf(new Uint8Array(32), EMPTY, 3)).length, 3);
});

test('x25519 rejects low-order points and bad lengths', async () => {
  const { privateKey } = await generateX25519KeyPair();
  for (const p of X25519_LOW_ORDER_POINTS) await assert.rejects(x25519Dh(privateKey, p), /low-order/);
  await assert.rejects(x25519Dh(privateKey, new Uint8Array(31)), /length/);
  assert.equal(constantTimeEqual(Uint8Array.of(1), Uint8Array.of(1, 2)), false);
});

test('phase machine refuses out-of-order calls and dies on failure', async () => {
  const ini = new NoiseXXInitiator();
  await assert.rejects(ini.writeMessage1(), /wrong phase/);
  await ini.initialize();
  await assert.rejects(ini.initialize(), /wrong phase/);
  await assert.rejects(ini.writeMessage3(), /wrong phase/);
  await ini.writeMessage1();
  await assert.rejects(ini.readMessage2(new Uint8Array(MIN_MSG2_LEN - 1)), /too short/);
  assert.equal(ini.phase, Phase.DEAD);
  await assert.rejects(ini.readMessage2(new Uint8Array(MIN_MSG2_LEN)), /dead handshake/);
  await assert.rejects(ini.split(), /dead handshake/);
});

test('a tampered message 2 kills the initiator', async () => {
  const ini = new NoiseXXInitiator();
  const res = new NoiseXXResponder({ payload: utf8('hello') });
  await ini.initialize();
  await res.initialize();
  const m2 = await res.readMessage1AndWriteMessage2(await ini.writeMessage1());
  m2[m2.length - 1] ^= 0x80;
  await assert.rejects(ini.readMessage2(m2), /decrypt failed/);
  assert.equal(ini.phase, Phase.DEAD);
});

test('responder payload in message 2 reaches the initiator; responder checks msg sizes', async () => {
  const ini = new NoiseXXInitiator();
  const res = new NoiseXXResponder({ payload: utf8('hello') });
  await ini.initialize();
  await res.initialize();
  const m2 = await res.readMessage1AndWriteMessage2(await ini.writeMessage1());
  assert.equal(new TextDecoder().decode(await ini.readMessage2(m2)), 'hello');
  assert.equal(ini.remoteStaticPublicKey().length, 32);
  await assert.rejects(res.readMessage3(new Uint8Array(MIN_MSG3_LEN - 1)), /too short/);

  const r2 = new NoiseXXResponder();
  await r2.initialize();
  await assert.rejects(r2.readMessage1AndWriteMessage2(new Uint8Array(31)), /too short/);
});

test('destroy drops key references', async () => {
  const ini = new NoiseXXInitiator();
  await ini.initialize();
  await ini.writeMessage1();
  ini.destroy();
  assert.equal(ini._e, null);
  assert.equal(ini.phase, Phase.DEAD);
});
