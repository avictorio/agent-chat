import { test } from 'node:test';
import assert from 'node:assert/strict';

import { sessionIdFor, derivedSessionId, uuidFromBytes, fenced, wakeText, withRoom, validRouting } from '../../worker/bridge/wake.ts';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const LINK = 'ml_' + '0'.repeat(32);

test('session ids: stable, UUID v4 shaped, distinct per room and per link', async () => {
  assert.equal(await sessionIdFor(LINK, 'main', 'lobby'), null);
  const ac = await sessionIdFor(LINK, 'agent-chat', 'lobby');
  assert.match(ac, UUID_V4);
  assert.equal(await sessionIdFor(LINK, 'agent-chat', 'other-room'), ac, 'agent-chat is one chat for every room');
  assert.equal(await sessionIdFor(LINK, 'agent-chat', 'lobby'), ac, 'stable');

  const lobby = await sessionIdFor(LINK, 'per-room', 'lobby');
  const games = await sessionIdFor(LINK, 'per-room', 'games');
  assert.match(lobby, UUID_V4);
  assert.notEqual(lobby, games);
  assert.equal(await sessionIdFor(LINK, 'per-room', 'lobby'), lobby);
  // A room named "agent-chat" does not land in the Agent Chat chat.
  assert.notEqual(await sessionIdFor(LINK, 'per-room', 'agent-chat'), ac);
  // Another link, another chat.
  assert.notEqual(await sessionIdFor('ml_' + '1'.repeat(32), 'per-room', 'lobby'), lobby);

  const given = 'AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE';
  assert.equal(await sessionIdFor(LINK, given, 'lobby'), given.toLowerCase());
  await assert.rejects(sessionIdFor(LINK, 'side-1', 'lobby'), RangeError);
});

test('derivation: SHA-256(prefix NUL parts...), first 16 bytes, v4 + RFC 4122 variant', async () => {
  const { createHash } = await import('node:crypto');
  const digest = createHash('sha256').update(`muse-bridge session v1\u0000${LINK}\u0000room\u0000lobby`).digest();
  assert.equal(await derivedSessionId(LINK, 'room', 'lobby'), uuidFromBytes(digest));
  assert.equal(uuidFromBytes(new Uint8Array(16).fill(0xff)), 'ffffffff-ffff-4fff-bfff-ffffffffffff');
  assert.equal(uuidFromBytes(new Uint8Array(16)), '00000000-0000-4000-8000-000000000000');
});

test('routing check', () => {
  for (const r of ['main', 'agent-chat', 'per-room', '0e3b5b9a-8f62-4b1e-9d5c-3a2f1e0d9c8b']) assert.ok(validRouting(r), r);
  for (const r of ['', 'Main', 'side-1', null, 3]) assert.ok(!validRouting(r), String(r));
});

test('fence: longer than any backtick run inside, at least three', () => {
  assert.equal(fenced({ a: 1 }), '```\n{\n  "a": 1\n}\n```');
  const f = fenced({ text: 'look: ```` and ``' });
  assert.ok(f.startsWith('`````\n'));
  assert.ok(f.endsWith('\n`````'));
  const close = '\n' + '`'.repeat(6) + '\n';
  const g = fenced({ text: close });
  // JSON escapes the newline, so the run stays inside one line; the fence outruns it.
  assert.ok(g.startsWith('`'.repeat(7) + '\n'));
});

test('wake text: label, room, skipped, one fence per item', () => {
  const items = [
    { seq: 1, kind: 'message', at: 1, data: { id: 7, from: 'ada', text: 'hi' } },
    { seq: 2, kind: 'reaction', at: 2, data: { type: 'reaction', emoji: '👍' } },
  ];
  const plain = wakeText({ room: 'lobby', items });
  assert.equal(
    plain,
    '[Agent Chat]\n' +
      '```\n{\n  "room": "lobby",\n  "id": 7,\n  "from": "ada",\n  "text": "hi"\n}\n```\n' +
      '```\n{\n  "room": "lobby",\n  "type": "reaction",\n  "emoji": "👍"\n}\n```',
  );
  const skipped = wakeText({ room: 'lobby', items, skipped: 3 });
  assert.ok(skipped.startsWith('[Agent Chat]\n(3 older items not shown)\n```'));
  assert.match(wakeText({ room: 'lobby', items, skipped: 1 }), /\(1 older item not shown\)/);
  assert.throws(() => wakeText({ room: 'Bad Room\n', items }), RangeError);
  // The bridge's room wins over a room key in the frame; a non-object frame is wrapped.
  assert.deepEqual(withRoom('lobby', { room: 'x', id: 1 }), { room: 'lobby', id: 1 });
  assert.deepEqual(Object.keys(withRoom('lobby', { id: 1 })), ['room', 'id']);
  assert.deepEqual(withRoom('lobby', 'hi'), { room: 'lobby', data: 'hi' });
});
