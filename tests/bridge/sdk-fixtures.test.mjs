// Interop against bytes produced by the Python SDK (scripts/bridge/gen_fixtures.py at
// e17081a). Byte equality of JS output with the Python output means each side
// decodes what the other encodes; the decode cases feed Python bytes to JS.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

import * as proto from '../../worker/bridge/muse/proto.ts';
import * as framing from '../../worker/bridge/muse/framing.ts';
import * as env from '../../worker/bridge/muse/envelope.ts';
import { CipherState, NoiseXXInitiator, NoiseXXResponder, buildNonceIv, hkdf, importX25519KeyPair, X25519_LOW_ORDER_POINTS } from '../../worker/bridge/muse/noise.ts';
import { NoiseTransport } from '../../worker/bridge/muse/transport.ts';
import { chatRequestBody, noiseUrl, validateAppId, APP_ID, CHAT_PATH, NOISE_PATH } from '../../worker/bridge/muse/session.ts';

const F = JSON.parse(readFileSync(new URL('./fixtures/sdk-fixtures.json', import.meta.url), 'utf8'));
const hex = (b) => Buffer.from(b).toString('hex');
const unhex = (h) => new Uint8Array(Buffer.from(h, 'hex'));
const sha = (b) => createHash('sha256').update(b).digest('hex');
const pattern = (n, seed = 0) => {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = (i * 31 + seed * 7 + 11) & 0xff;
  return out;
};
const utf8 = (s) => new TextEncoder().encode(s);

test('fixtures come from the pinned SDK commit', () => {
  assert.equal(F.sdk_commit, 'e17081a');
});

test('proto: varints and signed fields match Python', () => {
  for (const { value, hex: h } of F.proto.varints) assert.equal(hex(proto.encodeVarint(BigInt(value))), h, value);
  for (const { field, value, hex: h } of F.proto.int64_fields) assert.equal(hex(proto.int64Field(field, BigInt(value))), h);
  for (const { field, value, hex: h } of F.proto.int32_fields) assert.equal(hex(proto.int32Field(field, Number(value))), h);
  for (const { hex: h, value } of F.proto.good_varints) assert.equal(proto.readVarint(unhex(h), 0)[0], BigInt(value));
  for (const h of F.proto.bad_varints) assert.throws(() => proto.readVarint(unhex(h), 0), proto.ProtoError ?? Error, h);
  for (const h of F.proto.bad_keys) assert.throws(() => proto.readKey(unhex(h), 0), Error, h);
});

test('framing: single frames encode and decode identically', () => {
  for (const f of F.framing.frames) {
    const enc = framing.encodeNoiseFrame({
      chunkId: BigInt(f.chunk_id),
      chunkIndex: f.chunk_index,
      totalChunks: f.total_chunks,
      payload: unhex(f.payload),
    });
    assert.equal(hex(enc), f.hex);
    const dec = framing.decodeNoiseFrame(unhex(f.hex));
    assert.equal(dec.chunkId, BigInt(f.decoded.chunk_id));
    assert.equal(dec.chunkIndex, f.decoded.chunk_index);
    assert.equal(dec.totalChunks, f.decoded.total_chunks);
    assert.equal(hex(dec.payload), f.decoded.payload);
  }
});

test('framing: chunk splitting matches Python and reassembles', () => {
  assert.equal(framing.MAX_CHUNK_PAYLOAD, F.framing.MAX_CHUNK_PAYLOAD);
  assert.equal(framing.MAX_TOTAL_CHUNKS, F.framing.MAX_TOTAL_CHUNKS);
  assert.equal(framing.MAX_PENDING_ASSEMBLIES, F.framing.MAX_PENDING_ASSEMBLIES);
  assert.equal(framing.MAX_ASSEMBLY_BYTES, F.framing.MAX_ASSEMBLY_BYTES);
  for (const s of F.framing.splits) {
    const payload = pattern(s.length, s.seed);
    const frames = framing.encodeNoiseFrames(payload, BigInt(s.chunk_id));
    assert.equal(frames.length, s.count);
    assert.deepEqual(frames.map(sha), s.sha256);
    assert.equal(hex(frames[0].subarray(0, 48)), s.first_hex_prefix);
    const d = new framing.NoiseFrameDecoder();
    let out = null;
    for (const fr of frames) out = d.decode(fr);
    assert.equal(sha(out), sha(payload));
  }
  assert.equal(F.framing.too_large_rejected, true);
  assert.throws(() => framing.encodeNoiseFrames(new Uint8Array(F.framing.too_large_length), 1n), RangeError);
});

test('framing: the decoder rejects what Python rejects, step for step', () => {
  for (const h of F.framing.decode_errors) {
    assert.throws(() => new framing.NoiseFrameDecoder().decode(unhex(h)), Error, h);
  }
  for (const [name, steps] of Object.entries(F.framing.sequences)) {
    const d = new framing.NoiseFrameDecoder();
    for (const step of steps) {
      if (step.error) {
        assert.throws(() => d.decode(unhex(step.in)), Error, name);
        assert.throws(() => d.decode(unhex(steps[0].in)), /poisoned/, `${name} poisons`);
      } else {
        const r = d.decode(unhex(step.in));
        assert.equal(r === null ? null : hex(r), step.out, name);
      }
    }
  }
});

function jsFrame(j) {
  const v = j.value;
  let value = null;
  if (j.kind === 'request') {
    value = { verb: v.verb, path: v.path, headers: v.headers.map(([key, val]) => ({ key, value: val })), body: unhex(v.body), endBody: v.end_body };
  } else if (j.kind === 'response') {
    value = { status: v.status, headers: v.headers.map(([key, val]) => ({ key, value: val })), body: unhex(v.body), endBody: v.end_body };
  } else if (j.kind === 'body_chunk') {
    value = { data: unhex(v.data), endBody: v.end_body };
  } else if (j.kind === 'reset') {
    value = { code: v.code, reason: v.reason };
  }
  return { streamId: BigInt(j.stream_id), kind: j.kind, value };
}

function normalize(frame) {
  const n = { streamId: frame.streamId, kind: frame.kind, value: frame.value };
  if (frame.value) {
    n.value = Object.fromEntries(
      Object.entries(frame.value).map(([k, v]) => [k, v instanceof Uint8Array ? hex(v) : v]),
    );
  }
  return n;
}

test('envelope: every ServiceFrame kind matches Python both ways', () => {
  for (const c of F.envelope.frames) {
    const frame = jsFrame(c.frame);
    assert.equal(hex(env.encodeServiceFrame(frame)), c.hex);
    assert.deepEqual(normalize(env.decodeServiceFrame(unhex(c.hex))), normalize(frame));
    assert.equal(hex(env.encodeServiceRequest({ service: env.ServiceType.SERVICE_DAEMON, payload: unhex(c.hex) })), c.service_request);
    assert.equal(hex(env.encodeServiceRequest({ service: env.ServiceType.SERVICE_VAULT, payload: unhex(c.hex) })), c.service_request_vault);
    assert.equal(hex(env.encodeServiceResponse({ payload: unhex(c.hex) })), c.service_response);
    const req = env.decodeServiceRequest(unhex(c.service_request_vault));
    assert.equal(req.service, env.ServiceType.SERVICE_VAULT);
    assert.equal(hex(req.payload), c.hex);
    assert.equal(hex(env.decodeServiceResponse(unhex(c.service_response)).payload), c.hex);
  }
  const u = F.envelope.with_unknown_fields;
  assert.deepEqual(normalize(env.decodeServiceFrame(unhex(u.hex))), normalize(jsFrame(u.frame)));
  for (const [name, h] of Object.entries(F.envelope.errors)) assert.throws(() => env.decodeServiceFrame(unhex(h)), Error, name);
  for (const h of F.envelope.service_request_errors) assert.throws(() => env.decodeServiceRequest(unhex(h)), Error, h);
  assert.equal(F.envelope.empty_service_response, '');
  assert.equal(env.encodeServiceResponse({ payload: new Uint8Array(0) }).length, 0);
});

async function cs(keyHex) {
  const c = new CipherState();
  await c.initializeKey(unhex(keyHex));
  return c;
}

test('cipher: AES-GCM nonces, IVs and HKDF match Python', async () => {
  const c = await cs(F.cipher.key);
  for (const v of F.cipher.vectors) {
    assert.equal(c.nonce, v.nonce);
    assert.equal(hex(await c.encryptWithAd(unhex(v.ad), unhex(v.pt))), v.ct);
  }
  const d = await cs(F.cipher.key);
  for (const v of F.cipher.vectors) assert.equal(hex(await d.decryptWithAd(unhex(v.ad), unhex(v.ct))), v.pt);
  for (const { nonce, iv } of F.cipher.iv_examples) assert.equal(hex(buildNonceIv(nonce)), iv);
  for (const h of F.cipher.hkdf) {
    assert.deepEqual((await hkdf(unhex(h.ck), unhex(h.ikm), h.n)).map(hex), h.out);
  }
});

test('transport: client frames are byte-identical to Python NoiseTransport', async () => {
  const T = F.transport;
  const t = new NoiseTransport(await cs(T.k1), await cs(T.k2), { chunkId: () => BigInt(T.chunk_id) });
  for (const op of T.client_ops) {
    const headers = (op.headers ?? []).map(([key, value]) => ({ key, value }));
    let res;
    if (op.op === 'http_request') {
      const body = op.body_pattern ? pattern(...op.body_pattern) : unhex(op.body);
      res = await t.encryptHttpRequest(op.method, op.path, body, { headers, service: op.service ?? 'daemon' });
      assert.equal(res.streamId, BigInt(op.stream_id));
      res = res.frames;
    } else if (op.op === 'start_stream') {
      res = await t.startStreamRequest(op.method, op.path, { headers });
      assert.equal(res.streamId, BigInt(op.stream_id));
      res = res.frames;
    } else if (op.op === 'body_chunk') {
      res = await t.encryptBodyChunk(BigInt(op.stream_id), unhex(op.data), { endBody: op.end_body });
    } else if (op.op === 'reset') {
      res = await t.encryptReset(BigInt(op.stream_id), { reason: op.reason });
    }
    if (op.frames_sha256) assert.deepEqual(res.map(sha), op.frames_sha256, op.op);
    else assert.deepEqual(res.map(hex), op.frames, op.op);
  }
});

test('transport: Python-encrypted VM frames decrypt and dispatch in JS', async () => {
  const T = F.transport;
  const t = new NoiseTransport(await cs(T.k1), await cs(T.k2));
  for (const r of T.responses) {
    let out = null;
    for (let i = 0; i < r.frames.length; i++) {
      out = await t.decryptFrame(unhex(r.frames[i]));
      if (i < r.frames.length - 1) assert.equal(out, null);
    }
    if (r.big_body_pattern) {
      assert.equal(out.kind, 'response');
      assert.equal(sha(out.value.body), sha(pattern(...r.big_body_pattern)));
      assert.equal(r.count, 2);
    } else {
      assert.deepEqual(normalize(out), normalize(jsFrame(r.frame)));
    }
  }
  // A request frame from the server, or an empty ServiceResponse, kills the transport.
  for (const [name, frames] of Object.entries(T.bad_after_decrypt)) {
    const recv = await cs(T.k2);
    // Advance the receive nonce past the frames already used above.
    let used = T.responses.reduce((n, r) => n + r.frames.length, 0);
    if (name === 'empty_service_response') used += T.bad_after_decrypt.request_from_server.length;
    recv._setNonceForTest(used);
    const t2 = new NoiseTransport(await cs(T.k1), recv);
    await assert.rejects(t2.decryptFrame(unhex(frames[0])), /unexpected request frame|empty ServiceResponse/, name);
    assert.equal(t2.dead, true);
    await assert.rejects(t2.decryptFrame(unhex(frames[0])), /dead/);
  }
});

function fixedKeyGen(order) {
  const H = F.handshake.keys;
  const queue = [...order];
  return async () => {
    const k = H[queue.shift()];
    return importX25519KeyPair(unhex(k.private), unhex(k.public));
  };
}

test('handshake: JS initiator reproduces the Python XX transcript with fixed keys', async () => {
  const H = F.handshake;
  const ini = new NoiseXXInitiator({ keyGen: fixedKeyGen(['ie', 'is']) });
  await ini.initialize();
  assert.equal(hex(await ini.writeMessage1()), H.msg1);
  assert.equal(hex(await ini.readMessage2(unhex(H.msg2))), H.msg2_payload);
  assert.equal(hex(ini.remoteStaticPublicKey()), H.keys.rs.public);
  assert.equal(hex(await ini.writeMessage3()), H.msg3);
  assert.equal(hex(ini.handshakeHash()), H.handshake_hash);
  const [send, recv] = await ini.split();
  const plains = [utf8('ping'), new Uint8Array(0), pattern(70000)];
  for (let i = 0; i < plains.length; i++) {
    const ct = await send.encryptWithAd(new Uint8Array(0), plains[i]);
    assert.equal(hex(ct), H.client_to_server[i]);
  }
  for (let i = 0; i < H.server_to_client.length; i++) {
    assert.equal(hex(await recv.decryptWithAd(new Uint8Array(0), unhex(H.server_to_client[i]))), H.server_to_client_plain[i]);
  }
});

test('handshake: JS responder reproduces Python message 2, with and without payload', async () => {
  const H = F.handshake;
  const res = new NoiseXXResponder({ keyGen: fixedKeyGen(['re', 'rs']) });
  await res.initialize();
  assert.equal(hex(await res.readMessage1AndWriteMessage2(unhex(H.msg1))), H.msg2);
  await res.readMessage3(unhex(H.msg3));
  assert.equal(hex(res.handshakeHash()), H.handshake_hash);
  const res2 = new NoiseXXResponder({ payload: unhex(H.msg2_payload_value), keyGen: fixedKeyGen(['re', 'rs']) });
  await res2.initialize();
  assert.equal(hex(await res2.readMessage1AndWriteMessage2(unhex(H.msg1))), H.msg2_with_payload);
  assert.deepEqual(X25519_LOW_ORDER_POINTS.map(hex), H.low_order_points);
});

test('session: chat bodies are byte-identical to Python json.dumps', () => {
  for (const b of F.session.bodies) {
    const body = chatRequestBody({
      message: b.message,
      outputModality: b.output_modality,
      deviceId: 'homelink-abcdef',
      sessionId: b.session_id,
      device: b.device,
    });
    assert.equal(new TextDecoder().decode(body), b.json, JSON.stringify(b.message));
  }
});

test('session: noise URLs and app ids match link_client', () => {
  assert.equal(APP_ID, F.session.app_id_header);
  assert.equal(CHAT_PATH, F.session.chat_path);
  assert.equal(NOISE_PATH, F.session.noise_path);
  for (const u of F.session.urls) assert.equal(noiseUrl(u.host, u.vm_id, u.app_id), u.url);
  for (const a of F.session.bad_app_ids) assert.throws(() => validateAppId(a), RangeError, a);
});
