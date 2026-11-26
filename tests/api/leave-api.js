// A member leaving a room (POST /api/rooms/ROOM/leave and MCP leave_room:
// worker/routes/members.ts leaveRoute, worker/room/members.ts leave),
// against a real local Worker: the refusals and their codes, an invite
// never opened refused without being opened (over REST and MCP), what a
// leave changes in the members list, the board and a lobby, the name
// invited again, the last member's two steps and the room's 404 (and a
// call in flight's 410) after it. Each part uses its own throwaway room.
// Called from api.test.js after the invite API.
'use strict';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// the refusal of a token whose member left with it (worker/room/Room.ts LEFT_MSG)
const LEFT = 'You left this room with this invite, so it will not work again. A member of the room can invite you anew.';

async function leaveApi(ctx) {
  const { req, check, SUF } = ctx;
  const room = 'apitest-leave-' + SUF;
  const R = '/api/rooms/' + room;
  const codeOf = (r) => r.json && r.json.code;
  const leave = (token, body, opts) => req('POST', R + '/leave', Object.assign({ token, json: body }, opts || {}));
  const rpc = (token, args, opts) => req('POST', R + '/mcp', Object.assign({ token, json: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'leave_room', arguments: args } } }, opts || {}));
  const members = async () => ((await req('GET', R + '/members', { owner: true })).json || {}).members || [];
  const row = async (name) => (await members()).find((m) => m.name === name) || {};
  const OK = { confirm: room };

  await req('POST', R, { owner: true });
  const mint = async (name, kind) => (await req('POST', R + '/invites', { owner: true, json: { name, kind } })).json.token;
  const H = await mint('LvH', 'human');
  const A = await mint('LvA', 'agent');
  const B = await mint('LvB', 'agent');
  const U = await mint('LvU', 'agent');
  for (const t of [H, A, B]) await req('GET', R + '/messages?limit=1', { token: t });

  // refused before the room is asked
  let r = await req('GET', R + '/leave', { token: A });
  check('leave: GET -> 405', r.status === 405, r.status);
  r = await leave('', OK);
  check('leave: no token -> 401 invite_missing', r.status === 401 && codeOf(r) === 'invite_missing', r.status + ' ' + r.text.slice(0, 120));
  r = await leave('', OK, { owner: true });
  check('leave: the owner key alone -> 400 owner_not_member', r.status === 400 && codeOf(r) === 'owner_not_member', r.status + ' ' + r.text.slice(0, 160));
  r = await leave(A, OK, { owner: true });
  check('leave: the owner key beside a token acts as the owner -> 400 owner_not_member', r.status === 400 && codeOf(r) === 'owner_not_member', r.status + ' ' + r.text.slice(0, 160));
  for (const [label, body] of [['no confirm', {}], ['another room', { confirm: 'other-' + room }], ['the name in capitals', { confirm: room.toUpperCase() }]]) {
    r = await leave(A, body);
    check('leave: ' + label + ' -> 400 confirm_mismatch', r.status === 400 && codeOf(r) === 'confirm_mismatch' && r.json.error.includes('{"confirm": "' + room + '"}'), r.status + ' ' + r.text.slice(0, 160));
  }
  r = await leave('leave-bogus', OK);
  check('leave: an unknown token -> 403 invite_invalid', r.status === 403 && codeOf(r) === 'invite_invalid', r.status + ' ' + codeOf(r));
  r = await leave('leave-bogus', {});
  check('leave: ... the token\'s refusal comes before the confirm\'s', r.status === 403 && codeOf(r) === 'invite_invalid', r.status + ' ' + codeOf(r));
  // a body is read only for a token the room takes, and at most SMALL_BODY_MAX
  const filler = '{"confirm": "' + room + '", "pad": "' + 'x'.repeat(2 * 1024 * 1024) + '"}';
  r = await req('POST', R + '/leave', { token: 'leave-bogus', headers: { 'Content-Type': 'application/json' }, body: filler });
  check('leave: a refused token with a large body -> its 403', r.status === 403 && codeOf(r) === 'invite_invalid', r.status + ' ' + r.text.slice(0, 100));
  r = await req('POST', R + '/leave', { token: A, headers: { 'Content-Type': 'application/json' }, body: filler });
  check('leave: a member\'s body over SMALL_BODY_MAX -> 413, nothing changed', r.status === 413 && (await row('LvA')).status === 'active', r.status + ' ' + r.text.slice(0, 100));
  for (const [label, path] of [['muse-hook', '/muse-hook'], ['webhook', '/webhook']]) {
    r = await req('POST', R + path, { token: A, headers: { 'Content-Type': 'application/json' }, body: filler });
    check(label + ': a POST body over SMALL_BODY_MAX -> 413', r.status === 413, r.status + ' ' + r.text.slice(0, 100));
  }
  check('leave: ... and nobody left', (await row('LvA')).status === 'active', JSON.stringify(await row('LvA')));

  // an invite never opened: refused, and left unopened, over REST and MCP
  r = await leave(U, OK);
  check('leave: an invite never opened -> 409 not_joined', r.status === 409 && codeOf(r) === 'not_joined', r.status + ' ' + r.text.slice(0, 160));
  r = await rpc(U, OK);
  const ue = r.json && r.json.result;
  check('leave: MCP leave_room refuses it the same way, as a tool error', !!ue && ue.isError === true && ue.structuredContent && ue.structuredContent.code === 'not_joined', r.text.slice(0, 200));
  let u = await row('LvU');
  check('leave: ... and the invite is still unopened and unseen', u.status === 'unused' && u.joined === null && u.last_seen === null, JSON.stringify(u));

  // LvA has a picture, claims a question, owes a lobby, then leaves
  await req('PUT', R + '/avatar', { token: A, headers: { 'Content-Type': 'image/png' }, body: PNG });
  const q = (await req('POST', R + '/questions', { token: H, json: { text: 'Who books the hotel?' } })).json.question;
  await req('POST', R + '/questions/' + q.id, { token: A, json: { action: 'claim' } });
  const d = (await req('POST', R + '/decisions', { token: H, json: { title: 'Lima first' } })).json.decision;
  await req('POST', R + '/decisions/' + d.id, { token: A, json: { action: 'sign' } });
  const lobby = (await req('POST', R + '/games', { token: H, json: { game: 'duel', players: ['LvH', 'LvA'] } })).json.game;
  await req('POST', R + '/messages', { token: A, json: { text: 'LvA was here' } });
  r = await leave(A, OK);
  check('leave: a joined member leaves -> 200 {room, name, left, room_deleted: false}', r.status === 200 && JSON.stringify(Object.keys(r.json)) === '["room","name","left","room_deleted"]' && r.json.name === 'LvA' && r.json.room_deleted === false && r.json.left > 0, r.status + ' ' + r.text.slice(0, 160));
  const left = r.json && r.json.left;
  const a = await row('LvA');
  check('leave: the members list shows it revoked, with left', a.status === 'revoked' && a.left === left && a.revoked === left && !a.invite_link && a.avatar === null, JSON.stringify(a));
  check('leave: ... and left null on the others', (await row('LvH')).left === null, JSON.stringify(await row('LvH')));
  const inv = ((await req('GET', R + '/invites', { owner: true })).json.invites || []).find((i) => i.name === 'LvA') || {};
  check('leave: the owner\'s invite list carries left too', inv.left === left && inv.revoked === left, JSON.stringify(inv));
  r = await req('GET', R + '/avatars/LvA', { token: H });
  check('leave: its picture is gone', r.status === 404, r.status);
  r = await req('GET', R + '/messages?limit=50', { token: A });
  check('leave: its token is refused from then on (403 invite_revoked), with the sentence that it left', r.status === 403 && codeOf(r) === 'invite_revoked' && r.json.error === LEFT, r.status + ' ' + codeOf(r));
  r = await req('GET', R + '/messages?limit=50', { token: H });
  const texts = ((r.json && r.json.messages) || []).map((m) => m.from + ': ' + m.text);
  check('leave: its message stays, and the Referee calls the lobby off', texts.includes('LvA: LvA was here') && texts.includes('Referee: Duel match #' + lobby.id + ' is off - LvA declined the seat.'), JSON.stringify(texts.slice(-4)));
  r = await req('GET', R + '/games/' + lobby.id, { token: H });
  check('leave: the lobby waiting for it is cancelled', r.json && r.json.game && r.json.game.status === 'cancelled', r.text.slice(0, 120));
  r = await req('GET', R + '/questions', { token: H });
  const qq = ((r.json && r.json.questions) || []).find((x) => x.id === q.id) || {};
  check('leave: its claimed question is open again', qq.status === 'open' && qq.claimed_by === null, JSON.stringify(qq));
  r = await req('GET', R + '/decisions', { token: H });
  const dd = ((r.json && r.json.decisions) || []).find((x) => x.id === d.id) || {};
  check('leave: its signature stays', JSON.stringify(dd.signers) === '["LvA"]', JSON.stringify(dd));
  r = await rpc(A, { confirm: 'nope' });
  check('leave: MCP leave_room answers the token\'s refusal before a wrong confirm', r.json && r.json.error && r.json.error.code === -32001 && r.json.error.data.code === 'invite_revoked', r.text.slice(0, 160));
  r = await rpc(A, OK);
  check('leave: MCP leave_room with the token it left with -> -32001 invite_revoked, with the sentence that it left', r.json && r.json.error && r.json.error.code === -32001 && r.json.error.data.code === 'invite_revoked' && r.json.error.message === LEFT, r.text.slice(0, 160));
  // the name is free at once: a member invites it again
  r = await req('POST', R + '/invites', { token: H, json: { name: 'LvA', kind: 'agent' } });
  check('leave: its name can be invited again at once', r.status === 201 && r.json.name === 'LvA', r.status + ' ' + r.text.slice(0, 120));

  // LvB leaves over MCP
  r = await rpc(B, { confirm: room });
  const sc = r.json && r.json.result && r.json.result.structuredContent;
  check('leave: MCP leave_room leaves -> {room, name, left, room_deleted: false}', !!sc && sc.room === room && sc.name === 'LvB' && sc.left > 0 && sc.room_deleted === false, r.text.slice(0, 200));
  check('leave: ... and the list shows LvB left', (await row('LvB')).left === (sc && sc.left), JSON.stringify(await row('LvB')));

  // LvH is the last member who has joined: LvU and the new LvA are unopened
  r = await leave(H, OK);
  check('leave: the last member without delete_room -> 409 last_member, counting the unopened invites (unopened: 2)', r.status === 409 && codeOf(r) === 'last_member' && r.json.unopened === 2 && r.json.error.includes('the 2 invites not yet opened stop working too'), r.status + ' ' + r.text.slice(0, 220));
  check('leave: ... and nothing changed', (await row('LvH')).status === 'active', JSON.stringify(await row('LvH')));
  r = await rpc(H, OK);
  check('leave: MCP says the same', r.json && r.json.result && r.json.result.structuredContent && r.json.result.structuredContent.code === 'last_member' && r.json.result.structuredContent.unopened === 2, r.text.slice(0, 160));
  for (const v of ['true', 1, 'yes']) {
    r = await leave(H, { confirm: room, delete_room: v });
    check('leave: delete_room ' + JSON.stringify(v) + ' is no yes -> 409 last_member', r.status === 409 && codeOf(r) === 'last_member', r.status + ' ' + codeOf(r));
  }
  // a post in flight while the room goes answers 410
  await req('POST', '/api/test-hooks/r2-delay', { owner: true, json: { room, ms: 1500 } });
  const inflight = req('POST', R + '/messages', { token: H, json: { text: 'posted as the room goes', image: PNG.toString('base64') } });
  await sleep(300);
  r = await leave(H, { confirm: room, delete_room: true });
  check('leave: with delete_room the last member\'s leave deletes the room -> room_deleted: true', r.status === 200 && r.json.name === 'LvH' && r.json.room_deleted === true, r.status + ' ' + r.text.slice(0, 160));
  await req('POST', '/api/test-hooks/r2-delay', { owner: true, json: { room, ms: 0 } });
  r = await inflight;
  check('leave: ... a post in flight then answers 410 room_deleted', r.status === 410 && codeOf(r) === 'room_deleted', r.status + ' ' + r.text.slice(0, 160));
  for (const [label, opts] of [['the unopened invite', { token: U }], ['the leaver', { token: H }], ['the owner key', { owner: true }]]) {
    r = await req('GET', R + '/messages?limit=1', opts);
    check('leave: ... and then ' + label + ' finds no room (404)', r.status === 404, r.status + ' ' + r.text.slice(0, 100));
  }
  r = await req('GET', R, { token: U });
  check('leave: ... the start page too', r.status === 404, r.status);
  r = await rpc(U, OK);
  check('leave: ... and MCP', r.status === 404, r.status);
  r = await req('POST', R, { owner: true });
  check('leave: the name is free for a new room', r.status === 201, r.status);
  await req('DELETE', R + '?confirm=' + room, { owner: true });

  // one other active member: an ordinary leave, the room stays; and a protected room is never deleted
  const room2 = 'apitest-leave2-' + SUF;
  const R2 = '/api/rooms/' + room2;
  await req('POST', R2, { owner: true });
  const X = (await req('POST', R2 + '/invites', { owner: true, json: { name: 'LvX', kind: 'human' } })).json.token;
  const Y = (await req('POST', R2 + '/invites', { owner: true, json: { name: 'LvY', kind: 'agent' } })).json.token;
  for (const t of [X, Y]) await req('GET', R2 + '/messages?limit=1', { token: t });
  r = await req('POST', R2 + '/leave', { token: Y, json: { confirm: room2, delete_room: true } });
  check('leave: beside another active member delete_room is ignored: an ordinary leave', r.status === 200 && r.json.room_deleted === false, r.status + ' ' + r.text.slice(0, 120));
  r = await req('GET', R2 + '/messages?limit=1', { token: X });
  check('leave: ... and the room stays', r.status === 200, r.status);
  await req('DELETE', R2 + '/invites', { owner: true });
  await req('DELETE', R2 + '?confirm=' + room2, { owner: true });
}

module.exports = { leaveApi };
