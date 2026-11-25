#!/usr/bin/env python3
# Generates tests/bridge/fixtures/sdk-fixtures.json from the Python Muse Gadget SDK
# (facebookincubator/muse-gadget-sdk at e17081a, Apache License 2.0), so the
# JavaScript port can be checked byte-for-byte against it without Python.
#
# Usage:
#   scripts/bridge/extract_sdk.sh /path/to/muse-gadget-sdk /tmp/sdk e17081a
#   python3 scripts/bridge/gen_fixtures.py /tmp/sdk/linux/src tests/bridge/fixtures/sdk-fixtures.json
#
# Needs the `cryptography` package (the SDK's only dependency used here).
# Everything is deterministic: fixed keys, fixed chunk ids, no randomness.

import hashlib
import json
import sys

sdk_src, out_path = sys.argv[1], sys.argv[2]
sys.path.insert(0, sdk_src)

import cryptography  # noqa: E402
from cryptography.hazmat.primitives import serialization  # noqa: E402
from cryptography.hazmat.primitives.asymmetric import x25519  # noqa: E402

from musegadget.noise import _proto, envelope, framing, noise_xx, transport  # noqa: E402
from musegadget.noise.envelope import (  # noqa: E402
    ApplicationRequest, ApplicationResponse, BodyChunk, Header, Reset, ResetCode,
    ServiceFrame, ServiceRequest, ServiceResponse, ServiceType,
)
from musegadget import link_client  # noqa: E402


def hx(b):
    return bytes(b).hex()


def sha(b):
    return hashlib.sha256(bytes(b)).hexdigest()


def pattern(n, seed=0):
    return bytes(((i * 31 + seed * 7 + 11) & 0xFF) for i in range(n))


def fails(fn):
    try:
        fn()
    except Exception as exc:  # noqa: BLE001
        return type(exc).__name__
    return None


out = {"sdk_commit": "e17081a", "cryptography": cryptography.__version__,
       "python": sys.version.split()[0]}

# -- _proto ------------------------------------------------------------------------
varints = [0, 1, 127, 128, 300, 16383, 16384, (1 << 32) - 1, 1 << 32, (1 << 53) - 1,
           (1 << 53) + 1, (1 << 63) - 1, 1 << 63, (1 << 64) - 1]
out["proto"] = {
    "varints": [{"value": str(v), "hex": hx(_proto.encode_varint(v))} for v in varints],
    "int64_fields": [{"field": 1, "value": str(v), "hex": hx(_proto.int64_field(1, v))}
                     for v in (0, 1, -1, -(1 << 63), (1 << 63) - 1, 1234567890123)],
    "int32_fields": [{"field": 4, "value": str(v), "hex": hx(_proto.int32_field(4, v))}
                     for v in (0, 200, -1, -(1 << 31), (1 << 31) - 1)],
    "bad_varints": [h for h in ("", "80", "ffff", "80808080808080808002", "8080808080808080808001",
                                "ffffffffffffffffff02")
                    if fails(lambda h=h: _proto.read_varint(bytes.fromhex(h), 0))],
    "good_varints": [{"hex": h, "value": str(_proto.read_varint(bytes.fromhex(h), 0)[0])}
                     for h in ("00", "ffffffffffffffffff01", "8001", "80808080808080808001")],
    "bad_keys": [h for h in ("00", "07", "03", "04", "0e", hx(_proto.encode_varint(19000 << 3)),
                             hx(_proto.encode_varint(19999 << 3 | 2)),
                             hx(_proto.encode_varint(((1 << 29)) << 3)))
                 if fails(lambda h=h: _proto.read_key(bytes.fromhex(h), 0))],
}

# -- framing -----------------------------------------------------------------------
frame_cases = [
    framing.NoiseTransportFrame(),
    framing.NoiseTransportFrame(chunk_id=1, chunk_index=0, total_chunks=1, payload=b"hi"),
    framing.NoiseTransportFrame(chunk_id=-1, chunk_index=3, total_chunks=7, payload=pattern(300)),
    framing.NoiseTransportFrame(chunk_id=-(1 << 63), chunk_index=255, total_chunks=256, payload=b""),
    framing.NoiseTransportFrame(chunk_id=(1 << 63) - 1, chunk_index=0, total_chunks=0, payload=b"\x00"),
]
frames_fixture = []
for f in frame_cases:
    enc = framing.encode_noise_frame(f)
    dec = framing.decode_noise_frame(enc)
    frames_fixture.append({
        "chunk_id": str(f.chunk_id), "chunk_index": f.chunk_index, "total_chunks": f.total_chunks,
        "payload": hx(f.payload), "hex": hx(enc),
        "decoded": {"chunk_id": str(dec.chunk_id), "chunk_index": dec.chunk_index,
                    "total_chunks": dec.total_chunks, "payload": hx(dec.payload)},
    })

split_fixture = []
for n, cid in ((0, 42), (10, -42), (65489, 7), (65490, 8), (200000, -(1 << 62))):
    frames = framing.encode_noise_frames(pattern(n, n % 5), chunk_id=cid)
    split_fixture.append({
        "length": n, "seed": n % 5, "chunk_id": str(cid), "count": len(frames),
        "sha256": [sha(x) for x in frames],
        "first_hex_prefix": hx(frames[0][:48]),
    })


def frame_hex(**kw):
    return hx(framing.encode_noise_frame(framing.NoiseTransportFrame(**kw)))


# Malformed single frames that NoiseFrameDecoder.decode rejects.
decode_errors = [
    frame_hex(chunk_id=1, chunk_index=0, total_chunks=0, payload=b"x"),
    frame_hex(chunk_id=1, chunk_index=0, total_chunks=257, payload=b"x"),
    frame_hex(chunk_id=1, chunk_index=2, total_chunks=2, payload=b"x"),
    "0a01",  # field 1 with wire type 2
    "1001" + "1a01",  # field 3 (wire 2) after index
    "2205" + "6869",  # truncated payload
    "08ffffffffffffffffff02",  # malformed varint chunk id
    "18" + hx(_proto.encode_varint(1 << 32)),  # total_chunks outside uint32
]
decode_errors = [h for h in decode_errors if fails(lambda h=h: framing.NoiseFrameDecoder().decode(bytes.fromhex(h)))]


def run_sequence(steps):
    decoder = framing.NoiseFrameDecoder()
    results = []
    for h in steps:
        try:
            r = decoder.decode(bytes.fromhex(h))
            results.append({"in": h, "out": None if r is None else hx(r)})
        except Exception as exc:  # noqa: BLE001
            results.append({"in": h, "error": type(exc).__name__})
            break
    return results


sequences = {
    "out_of_order": run_sequence([
        frame_hex(chunk_id=5, chunk_index=2, total_chunks=3, payload=b"C"),
        frame_hex(chunk_id=5, chunk_index=0, total_chunks=3, payload=b"A"),
        frame_hex(chunk_id=9, chunk_index=0, total_chunks=1, payload=b"solo"),
        frame_hex(chunk_id=5, chunk_index=1, total_chunks=3, payload=b"B"),
    ]),
    "duplicate_index": run_sequence([
        frame_hex(chunk_id=5, chunk_index=0, total_chunks=2, payload=b"A"),
        frame_hex(chunk_id=5, chunk_index=0, total_chunks=2, payload=b"A"),
    ]),
    "inconsistent_total": run_sequence([
        frame_hex(chunk_id=5, chunk_index=0, total_chunks=2, payload=b"A"),
        frame_hex(chunk_id=5, chunk_index=1, total_chunks=3, payload=b"B"),
    ]),
    "too_many_pending": run_sequence([
        frame_hex(chunk_id=100 + i, chunk_index=0, total_chunks=2, payload=b"x") for i in range(17)
    ]),
    "empty_payload_single": run_sequence([frame_hex(chunk_id=3, chunk_index=0, total_chunks=1)]),
}

out["framing"] = {
    "MAX_CHUNK_PAYLOAD": framing.MAX_CHUNK_PAYLOAD,
    "MAX_TOTAL_CHUNKS": framing.MAX_TOTAL_CHUNKS,
    "MAX_PENDING_ASSEMBLIES": framing.MAX_PENDING_ASSEMBLIES,
    "MAX_ASSEMBLY_BYTES": framing.MAX_ASSEMBLY_BYTES,
    "frames": frames_fixture,
    "splits": split_fixture,
    "too_large_length": framing.MAX_CHUNK_PAYLOAD * framing.MAX_TOTAL_CHUNKS + 1,
    "too_large_rejected": fails(lambda: framing.encode_noise_frames(
        bytes(framing.MAX_CHUNK_PAYLOAD * framing.MAX_TOTAL_CHUNKS + 1), chunk_id=1)) is not None,
    "decode_errors": decode_errors,
    "sequences": sequences,
}

# -- envelope -------------------------------------------------------------------------


def frame_json(frame):
    d = {"stream_id": str(frame.stream_id), "kind": frame.kind}
    v = frame.value
    if isinstance(v, ApplicationRequest):
        d["value"] = {"verb": v.verb, "path": v.path, "headers": [[h.key, h.value] for h in v.headers],
                      "body": hx(v.body), "end_body": v.end_body}
    elif isinstance(v, ApplicationResponse):
        d["value"] = {"status": v.status, "headers": [[h.key, h.value] for h in v.headers],
                      "body": hx(v.body), "end_body": v.end_body}
    elif isinstance(v, BodyChunk):
        d["value"] = {"data": hx(v.data), "end_body": v.end_body}
    elif isinstance(v, Reset):
        d["value"] = {"code": int(v.code), "reason": v.reason}
    else:
        d["value"] = None
    return d


service_frames = [
    ServiceFrame(),
    ServiceFrame(stream_id=1),
    ServiceFrame.request(1, ApplicationRequest(
        verb="POST", path="/chat/stream",
        headers=[Header("Content-Type", "application/json"), Header("x-app-id", "musegadget"),
                 Header("x-ünï", "välue ☃ 😀"), Header("", "")],
        body=b'{"message": "hi"}', end_body=True)),
    ServiceFrame.request(2, ApplicationRequest(verb="GET", path="/x", end_body=False)),
    ServiceFrame.response(3, ApplicationResponse(
        status=200, headers=[Header("content-type", "application/json")],
        body=b'{"result":{"message_id":"user-1"}}', end_body=True)),
    ServiceFrame.response(-5, ApplicationResponse(status=-1)),
    ServiceFrame.response(1 << 40, ApplicationResponse(status=599, body=pattern(1000))),
    ServiceFrame.body_chunk(3, BodyChunk(data=b"more", end_body=False)),
    ServiceFrame.body_chunk(3, BodyChunk(end_body=True)),
    ServiceFrame.reset(4, Reset(code=ResetCode.CANCELLED, reason="client closed stream")),
    ServiceFrame.reset(4, Reset()),
    ServiceFrame.reset((1 << 63) - 1, Reset(code=ResetCode.SERVICE_UNAVAILABLE, reason="ünï")),
]
env_frames = []
for f in service_frames:
    enc = envelope.encode_service_frame(f)
    req = envelope.encode_service_request(ServiceRequest(ServiceType.SERVICE_DAEMON, enc))
    req_vault = envelope.encode_service_request(ServiceRequest(ServiceType.SERVICE_VAULT, enc))
    resp = envelope.encode_service_response(ServiceResponse(enc))
    assert frame_json(envelope.decode_service_frame(enc)) == frame_json(f)
    env_frames.append({"frame": frame_json(f), "hex": hx(enc), "service_request": hx(req),
                       "service_request_vault": hx(req_vault), "service_response": hx(resp)})

# Unknown fields of every wire type are skipped on decode.
unknown_tail = (_proto.varint_field(9, 5) + _proto.encode_key(10, _proto.WIRE_FIXED64) + bytes(8)
                + _proto.delimited_field(11, b"zz") + _proto.encode_key(12, _proto.WIRE_FIXED32) + bytes(4))
with_unknown = envelope.encode_service_frame(service_frames[4]) + unknown_tail
envelope_errors = {
    "frame_wrong_wire_stream_id": hx(_proto.delimited_field(1, b"")),
    "frame_wrong_wire_request": hx(_proto.varint_field(2, 1)),
    "header_bad_utf8": hx(_proto.delimited_field(2, _proto.delimited_field(3, _proto.delimited_field(1, b"\xff")))),
    "reset_unknown_code": hx(_proto.delimited_field(5, _proto.int32_field(1, 99))),
    "response_status_out_of_int32": hx(_proto.delimited_field(3, _proto.varint_field(1, 1 << 40))),
    "truncated_fixed64": hx(_proto.encode_key(10, _proto.WIRE_FIXED64) + bytes(3)),
}
for name, h in envelope_errors.items():
    assert fails(lambda h=h: envelope.decode_service_frame(bytes.fromhex(h))), name
service_request_errors = [hx(_proto.varint_field(1, 7)), hx(_proto.delimited_field(1, b""))]
for h in service_request_errors:
    assert fails(lambda h=h: envelope.decode_service_request(bytes.fromhex(h)))

out["envelope"] = {
    "frames": env_frames,
    "with_unknown_fields": {"hex": hx(with_unknown), "frame": frame_json(envelope.decode_service_frame(with_unknown))},
    "errors": envelope_errors,
    "service_request_errors": service_request_errors,
    "empty_service_response": hx(envelope.encode_service_response(ServiceResponse(b""))),
}

# -- transport (fixed keys, fixed chunk ids) ---------------------------------------------
K1 = hashlib.sha256(b"muse-bridge fixture k1").digest()
K2 = hashlib.sha256(b"muse-bridge fixture k2").digest()
CHUNK_ID = 0x1234_5678_9ABC_DEF0 - (1 << 63)
framing._random_int64 = lambda: CHUNK_ID  # transport -> encode_noise_frames uses it


def cs(key):
    c = noise_xx.CipherState()
    c.initialize_key(key)
    return c


client = transport.NoiseTransport(cs(K1), cs(K2))
chat_headers = [Header("Content-Type", "application/json"),
                Header("x-request-id", "00000000-0000-4000-8000-000000000000"),
                Header("x-app-id", "musegadget")]
chat_body = json.dumps({"message": "porch light on", "output_modality": "text",
                        "device_id": "homelink-abcdef", "session_id": "side-1"}).encode()
big_body = pattern(150000, 3)
ops = []
r1 = client.encrypt_http_request("POST", "/chat/stream", chat_body, headers=chat_headers)
ops.append({"op": "http_request", "method": "POST", "path": "/chat/stream", "body": hx(chat_body),
            "headers": [[h.key, h.value] for h in chat_headers], "stream_id": str(r1.stream_id),
            "frames": [hx(x) for x in r1.frames]})
r2 = client.start_stream_request("POST", "/chat/stream", headers=chat_headers)
ops.append({"op": "start_stream", "method": "POST", "path": "/chat/stream",
            "headers": [[h.key, h.value] for h in chat_headers], "stream_id": str(r2.stream_id),
            "frames": [hx(x) for x in r2.frames]})
r3 = client.encrypt_body_chunk(r2.stream_id, b"part", end_body=True)
ops.append({"op": "body_chunk", "stream_id": str(r2.stream_id), "data": hx(b"part"), "end_body": True,
            "frames": [hx(x) for x in r3]})
r4 = client.encrypt_reset(r2.stream_id, reason="request ended")
ops.append({"op": "reset", "stream_id": str(r2.stream_id), "reason": "request ended",
            "frames": [hx(x) for x in r4]})
r5 = client.encrypt_http_request("PUT", "/big", big_body, service="vault")
ops.append({"op": "http_request", "method": "PUT", "path": "/big", "body_pattern": [150000, 3],
            "service": "vault", "headers": [], "stream_id": str(r5.stream_id),
            "frames_sha256": [sha(x) for x in r5.frames]})

# VM -> client: what NoiseTransport.decrypt_frame sees.
server_send = cs(K2)


def server_frames(frame, chunk_id):
    data = transport.encode_response_envelope(frame)
    return [hx(server_send.encrypt_with_ad(b"", f)) for f in framing.encode_noise_frames(data, chunk_id=chunk_id)]


responses = []
for i, f in enumerate([
    ServiceFrame.response(1, ApplicationResponse(status=200, body=b'{"result":{"message_id":"user-1"}}',
                                                 end_body=True)),
    ServiceFrame.body_chunk(1, BodyChunk(data=b"late", end_body=False)),
    ServiceFrame.reset(2, Reset(code=ResetCode.TIMEOUT, reason="t")),
    ServiceFrame.response(3, ApplicationResponse(status=200, body=pattern(100000, 1), end_body=True)),
]):
    frames = server_frames(f, 1000 + i)
    responses.append({"frames": frames, "frame": frame_json(f) if i != 3 else None,
                      "big_body_pattern": [100000, 1] if i == 3 else None,
                      "count": len(frames)})
# Plaintext-valid frames the client must refuse after decryption.
bad_after_decrypt = {
    "request_from_server": server_frames(ServiceFrame.request(9, ApplicationRequest(verb="GET")), 2001),
    "empty_service_response": [hx(server_send.encrypt_with_ad(b"", f))
                               for f in framing.encode_noise_frames(b"", chunk_id=2002)],
}
out["transport"] = {"k1": hx(K1), "k2": hx(K2), "chunk_id": str(CHUNK_ID), "client_ops": ops,
                    "responses": responses, "bad_after_decrypt": bad_after_decrypt}

# -- CipherState vectors ------------------------------------------------------------------
c = cs(K1)
out["cipher"] = {
    "key": hx(K1),
    "vectors": [{"nonce": i, "ad": hx(ad), "pt": hx(pt), "ct": hx(c.encrypt_with_ad(ad, pt))}
                for i, (ad, pt) in enumerate([(b"", b""), (b"ad", b"hello"), (b"", pattern(1000))])],
    "iv_examples": [{"nonce": n, "iv": hx(noise_xx.build_nonce_iv(n))} for n in (0, 1, 255, (1 << 53) - 1)],
    "hkdf": [],
}
for ck, ikm, n in ((K1, b"", 2), (K1, K2, 3), (bytes(32), b"x" * 77, 2)):
    out["cipher"]["hkdf"].append({"ck": hx(ck), "ikm": hx(ikm), "n": n,
                                  "out": [hx(x) for x in noise_xx._hkdf(ck, ikm, n)]})

# -- Handshake with fixed keys -----------------------------------------------------------


def fixed_pair(label):
    priv = hashlib.sha256(b"muse-bridge fixture " + label).digest()
    key = x25519.X25519PrivateKey.from_private_bytes(priv)
    pub = key.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
    return priv, pub, noise_xx._X25519KeyPair(private_key=key, public_key_bytes=pub)


keys = {name: fixed_pair(name.encode()) for name in ("ie", "is", "re", "rs")}
queue = []
noise_xx._generate_x25519_key_pair = lambda: queue.pop(0)
queue[:] = [keys["ie"][2], keys["re"][2], keys["rs"][2], keys["is"][2]]
ini = noise_xx.NoiseXXInitiator()
res = noise_xx.NoiseXXResponder(payload=b"")
ini.initialize()
res.initialize()
m1 = ini.write_message1()
m2 = res.read_message1_and_write_message2(m1)
p2 = ini.read_message2(m2)
m3 = ini.write_message3()
res.read_message3(m3)
assert ini.handshake_hash() == res.handshake_hash()
hh = ini.handshake_hash()
i_send, i_recv = ini.split()
r_send, r_recv = res.split()
c2s = [hx(i_send.encrypt_with_ad(b"", m)) for m in (b"ping", b"", pattern(70000))]
s2c = [hx(r_send.encrypt_with_ad(b"", m)) for m in (b"pong", b"two")]
for h, m in zip(c2s, (b"ping", b"", pattern(70000))):
    assert r_recv.decrypt_with_ad(b"", bytes.fromhex(h)) == m

# Responder with a payload in message 2.
queue[:] = [keys["ie"][2], keys["re"][2], keys["rs"][2]]
ini2 = noise_xx.NoiseXXInitiator()
res2 = noise_xx.NoiseXXResponder(payload=b"server hello")
ini2.initialize()
res2.initialize()
m1b = ini2.write_message1()
m2b = res2.read_message1_and_write_message2(m1b)

out["handshake"] = {
    "keys": {k: {"private": hx(v[0]), "public": hx(v[1])} for k, v in keys.items()},
    "msg1": hx(m1), "msg2": hx(m2), "msg3": hx(m3), "msg2_payload": hx(p2),
    "handshake_hash": hx(hh),
    "client_to_server": c2s, "client_to_server_plain": [hx(b"ping"), "", None],
    "big_c2s_sha256_plain": sha(pattern(70000)),
    "server_to_client": s2c, "server_to_client_plain": [hx(b"pong"), hx(b"two")],
    "msg2_with_payload": hx(m2b), "msg2_payload_value": hx(b"server hello"),
    "low_order_points": [hx(p) for p in noise_xx.X25519_LOW_ORDER_POINTS],
}

# -- send_chat request body & URL -------------------------------------------------------------
messages = ["hello", "porch light on", 'quote " backslash \\ slash /', "tab\tnl\ncr\rbs\bff\f",
            "ctl \x01\x1f del \x7f", "ünïcödé ☃", "emoji 😀👍🏽", "lone \ud800 surrogate", "", "<script>&amp;"]
bodies = []
for m in messages:
    for sid, dev, mod in ((None, None, "text"), ("side-1", None, "text"), ("", "mcu-wearable", "voice"),
                          ("s ü", "", "text")):
        body = {"message": m, "output_modality": mod, "device_id": "homelink-abcdef"}
        if sid:
            body["session_id"] = sid
        if dev is not None:
            body["device"] = dev
        bodies.append({"message": m, "session_id": sid, "device": dev, "output_modality": mod,
                       "json": json.dumps(body)})
urls = []
for vm, app in (("vm-1", None), ("a-b_c.d!~*'()?&=", None), ("ü /#%", None), ("vm", "123"),
                ("vm", "007"), ("vm", "hatch-web"), ("vm", str((1 << 63) - 1))):
    urls.append({"host": "hatch.metaaivm.com", "vm_id": vm, "app_id": app,
                 "url": link_client.noise_url("hatch.metaaivm.com", vm, app)})
bad_app_ids = [a for a in ("0", "-1", str(1 << 63), "12345678901234567890", "1.5", "", " 1", "١٢", "abc")
               if fails(lambda a=a: link_client.validate_app_id(a))]
out["session"] = {"bodies": bodies, "urls": urls, "bad_app_ids": bad_app_ids,
                  "app_id_header": link_client.APP_ID, "chat_path": link_client.CHAT_PATH,
                  "noise_path": link_client.NOISE_PATH}

with open(out_path, "w", encoding="ascii") as fh:
    json.dump(out, fh, indent=1, ensure_ascii=True)
    fh.write("\n")
print("wrote", out_path)
