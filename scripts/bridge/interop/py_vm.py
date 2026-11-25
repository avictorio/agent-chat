#!/usr/bin/env python3
# A stand-in Muse VM built from the Python SDK's own Noise code (e17081a):
# NoiseXXResponder, CipherState, NoiseFrameDecoder, the service envelopes and
# encode_noise_frames. It speaks JSON lines on stdio in place of a WebSocket:
#
#   stdin : {"data": "<hex>"}        one binary WebSocket message from the client
#   stdout: {"send": "<hex>"}        one binary WebSocket message to the client
#           {"event": {...}}         what the VM saw, for the test to assert on
#
# For each complete client request it answers with the /chat/stream ack (a
# 200 response with end_body) and then, to check the client stops reading,
# one more body_chunk on the same stream.
#
# Usage: python3 -I py_vm.py <sdk linux/src dir>

import hashlib
import json
import sys

sys.path.insert(0, sys.argv[1])

from musegadget.noise import NoiseFrameDecoder, NoiseXXResponder, encode_noise_frames  # noqa: E402
from musegadget.noise.envelope import ApplicationResponse, BodyChunk, ServiceFrame  # noqa: E402
from musegadget.noise.transport import decode_request_envelope, encode_response_envelope  # noqa: E402


def emit(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


responder = NoiseXXResponder(payload=b"")
responder.initialize()
phase = "msg1"
send = recv = None
decoder = NoiseFrameDecoder()
count = 0

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    data = bytes.fromhex(json.loads(line)["data"])
    if phase == "msg1":
        emit({"send": responder.read_message1_and_write_message2(data).hex()})
        phase = "msg3"
    elif phase == "msg3":
        responder.read_message3(data)
        handshake_hash = responder.handshake_hash().hex()  # split() zeroes it
        send, recv = responder.split()
        phase = "transport"
        emit({"event": {"handshake": "ok", "hash": handshake_hash}})
    else:
        whole = decoder.decode(recv.decrypt_with_ad(b"", data))
        if whole is None:
            emit({"event": {"partial": True}})
            continue
        frame = decode_request_envelope(whole)
        v = frame.value
        event = {"stream_id": frame.stream_id, "kind": frame.kind}
        if frame.kind == "request":
            event.update(verb=v.verb, path=v.path, end_body=v.end_body,
                         headers=[[h.key, h.value] for h in v.headers],
                         body_len=len(v.body), body_sha256=hashlib.sha256(v.body).hexdigest(),
                         body=v.body.decode("utf-8", "replace") if len(v.body) < 4096 else None)
        elif frame.kind == "body_chunk":
            event.update(data_len=len(v.data), end_body=v.end_body,
                         data_sha256=hashlib.sha256(v.data).hexdigest())
        elif frame.kind == "reset":
            event.update(code=int(v.code), reason=v.reason)
        emit({"event": event})
        if frame.kind in ("request", "body_chunk") and v.end_body:
            count += 1
            ack = json.dumps({"result": {"message_id": f"py-{count}"}}).encode()
            for reply in (
                ServiceFrame.response(frame.stream_id, ApplicationResponse(
                    status=200, body=ack, end_body=True)),
                ServiceFrame.body_chunk(frame.stream_id, BodyChunk(data=b"after the ack", end_body=False)),
            ):
                for f in encode_noise_frames(encode_response_envelope(reply)):
                    emit({"send": send.encrypt_with_ad(b"", f).hex()})
