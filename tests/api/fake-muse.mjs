// The API suite's Muse: the real bridge (worker/bridge) in the local Worker
// calls it instead of Muse's hosts (TEST_MUSE_ORIGIN, under TEST_HOOKS:
// worker/bridge/util.ts museFetch). One server on 127.0.0.1 answers both:
//
//   GET /fetch_vms           Muse's API: the VMs an access token leases
//   GET /v1/noise?vm_id=...  a VM's Noise socket: a WebSocket upgrade, then
//                            the bridge tests' fake VM (Noise XX responder,
//                            tests/bridge/helpers/fake-vm.mjs) takes the one
//                            chat request a wake sends and answers it
//
// It records what reached it (state.fetches, upgrades, chats) and answers
// as a test asks (account, refuse, plan). Loaded with the Worker's module
// hooks (tests/unit/txt-hooks.mjs) for the bridge's TypeScript.
import http from 'node:http';
import { createHash } from 'node:crypto';
import { FakeVm } from '../bridge/helpers/fake-vm.mjs';
import { ServiceFrame } from '../../worker/bridge/muse/envelope.ts';
import { seal } from '../../worker/bridge/seal.ts';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const text = (b) => new TextDecoder().decode(b);

/** One WebSocket frame from the server: unmasked, unfragmented. */
function wsFrame(opcode, payload) {
  const len = payload.length;
  let head;
  if (len < 126) head = Buffer.from([0x80 | opcode, len]);
  else if (len < 65536) {
    head = Buffer.alloc(4);
    head.writeUInt16BE(len, 2);
  } else {
    head = Buffer.alloc(10);
    head.writeBigUInt64BE(BigInt(len), 2);
  }
  head[0] = 0x80 | opcode;
  if (len >= 126) head[1] = len < 65536 ? 126 : 127;
  return Buffer.concat([head, payload]);
}

/** Calls onMessage(opcode, payload) for each whole message the client sends
 *  (its frames are masked; a message may come in fragments). */
function wsReader(socket, onMessage) {
  let buf = Buffer.alloc(0);
  let frag = null;
  let fragOp = 0;
  socket.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    for (;;) {
      if (buf.length < 2) return;
      const fin = (buf[0] & 0x80) !== 0;
      const op = buf[0] & 0x0f;
      let len = buf[1] & 0x7f;
      let off = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        len = Number(buf.readBigUInt64BE(2));
        off = 10;
      }
      const masked = (buf[1] & 0x80) !== 0;
      const mask = masked ? buf.subarray(off, off + 4) : null;
      if (masked) off += 4;
      if (buf.length < off + len) return;
      const payload = Buffer.from(buf.subarray(off, off + len));
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      buf = buf.subarray(off + len);
      if (op === 0) {
        frag = Buffer.concat([frag || Buffer.alloc(0), payload]);
        if (fin) {
          onMessage(fragOp, frag);
          frag = null;
        }
      } else if (op >= 8 || fin) onMessage(op, payload);
      else {
        frag = payload;
        fragOp = op;
      }
    }
  });
}

/** Each fenced block of a wake's text, parsed: the items' data, room first. */
export function wakeItems(message) {
  return [...String(message).matchAll(/^(`{3,})\n([\s\S]*?)\n\1$/gm)].map((m) => JSON.parse(m[2]));
}

/** The session id the bridge derives for a routing (worker/bridge/wake.ts),
 *  computed here on its own: SHA-256 over the prefix and parts, NUL
 *  separated, laid out as a version-4 UUID. */
export function derivedSessionId(...parts) {
  const b = createHash('sha256').update(['muse-bridge session v1', ...parts].join('\u0000')).digest().subarray(0, 16);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function startFakeMuse() {
  const state = {
    // access token -> {status, vms: [vm id]}: what fetch_vms answers
    accounts: new Map(),
    // vm id -> the VM's current bearer (fetch_vms hands it out; the socket checks it)
    bearers: new Map(),
    // vm id -> answers to come: {reject: status} at the upgrade; {status, body} or {drop: true} for the chat request
    plans: new Map(),
    fetches: [],
    upgrades: [],
    chats: [],
    // every header and body that reached the fake, for "never sent" checks
    seen: [],
  };
  let bearerN = 0;
  const sockets = new Set();
  const nextPlan = (vm, atUpgrade) => {
    const q = state.plans.get(vm) || [];
    if (!q.length || !!q[0].reject !== atUpgrade) return null;
    return q.shift();
  };

  const server = http.createServer((q, res) => {
    const u = new URL(q.url, 'http://fake-muse');
    state.seen.push(JSON.stringify(q.headers) + ' ' + q.url);
    if (u.pathname !== '/fetch_vms' || q.method !== 'GET') {
      res.writeHead(404);
      return res.end();
    }
    const token = String(q.headers.authorization || '').replace(/^Bearer /, '');
    const a = state.accounts.get(token);
    const status = a ? a.status : 401;
    state.fetches.push({ token, status, path: u.pathname, at: Date.now() });
    if (status !== 200) {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      return res.end('{"error_title":"refused"}');
    }
    const vmList = a.vms.map((vm, i) => ({ vm_id: vm, vm_name: vm, vm_auth_token: state.bearers.get(vm), vm_ws_url: 'wss://hatch.metaaivm.com', default: i === 0 }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ vm_list: vmList }));
  });

  server.on('upgrade', (q, socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => socket.destroy());
    const u = new URL(q.url, 'http://fake-muse');
    const vm = u.searchParams.get('vm_id') || '';
    const auth = String(q.headers.authorization || '');
    state.seen.push(JSON.stringify(q.headers) + ' ' + q.url);
    const plan = nextPlan(vm, true);
    const status = u.pathname !== '/v1/noise' ? 404 : plan ? plan.reject : auth === 'Bearer ' + state.bearers.get(vm) ? 101 : 401;
    state.upgrades.push({ vm, auth, status, at: Date.now() });
    if (status !== 101) {
      socket.end('HTTP/1.1 ' + status + ' Refused\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
      return;
    }
    const accept = createHash('sha1').update(q.headers['sec-websocket-key'] + WS_GUID).digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
    // The bridge tests' fake VM, with the WebSocket as its client socket.
    const fake = new FakeVm();
    let open = true;
    fake.socket = {
      readyState: 1,
      _deliver(data) {
        if (open) socket.write(wsFrame(typeof data === 'string' ? 1 : 2, Buffer.from(data)));
        else fake.droppedAfterClose += 1;
      },
      _emit() {},
    };
    const ready = fake.responder.initialize();
    wsReader(socket, (op, payload) => {
      if (op === 2) ready.then(() => fake._fromClient(new Uint8Array(payload)));
      else if (op === 8) {
        if (open) socket.end(wsFrame(8, payload.subarray(0, 2)));
        open = false;
      } else if (op === 9) socket.write(wsFrame(10, payload));
    });
    (async () => {
      await fake.handshakeDone;
      const fr = await fake.nextFrame();
      const body = JSON.parse(text(fr.value.body));
      state.seen.push(JSON.stringify(body));
      const answer = nextPlan(vm, false) || {};
      const chat = { vm, auth, body, items: wakeItems(body.message), status: answer.drop ? 0 : answer.status ?? 200, at: Date.now() };
      state.chats.push(chat);
      if (answer.drop) return socket.destroy();
      const out = new TextEncoder().encode(answer.body ?? '{"result":{"message_id":"m-' + state.chats.length + '"}}');
      await fake.sendFrame(ServiceFrame.response(fr.streamId, { status: chat.status, body: out, endBody: true }));
    })().catch(() => socket.destroy());
  });

  const muse = {
    state,
    /** The gadget's seal (worker/bridge/seal.ts: the C firmware's twin). */
    seal,
    derivedSessionId,
    /** An access token that leases these VMs (each with a bearer of its own). */
    account(token, ...vms) {
      state.accounts.set(token, { status: 200, vms });
      for (const vm of vms) if (!state.bearers.has(vm)) state.bearers.set(vm, 'vmtok-' + vm + '-' + ++bearerN);
    },
    /** fetch_vms answers this status for the token (401: Muse refuses it). */
    refuse(token, status = 401) {
      state.accounts.get(token).status = status;
    },
    accept(token) {
      state.accounts.get(token).status = 200;
    },
    /** Answers to come for a VM, in order: {reject: 401} refuses the next
     *  upgrade; {status, body} answers the next chat request; {drop: true}
     *  cuts its connection instead. */
    plan(vm, ...answers) {
      state.plans.set(vm, (state.plans.get(vm) || []).concat(answers));
    },
    bearer(vm) {
      return state.bearers.get(vm);
    },
  };
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({
        ...muse,
        url: 'http://127.0.0.1:' + server.address().port,
        close: () => {
          for (const s of sockets) s.destroy();
          server.close();
        },
      }),
    ),
  );
}
