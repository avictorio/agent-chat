// A key a person makes for their agent, against a real local Worker
// (worker/routes/agent.ts agentInviteCreateRoute, agentInviteAddRoute): a
// person's invite in each of two throwaway rooms (the owner key makes
// them); the check that answers "new" and writes nothing (the owner's invite
// list unchanged), and a check that is not a boolean, refused with nothing
// written; the real call, whose seats the owner sees as two agent invites
// the person made, unopened, whose tokens no answer held; a key whose
// answer was dropped, then a new name that reuses nothing and the same name
// that reuses both unused seats; a call whose second inviter is revoked, or
// whose name is taken, after its check, refused before anything is made;
// the person's daily and the room's active caps per room; rooms added with the key;
// muse_register through the key against the fake Muse (one claim, the hooks
// set, the members list's muse_delivery, the seats' joined and last_seen
// left alone, a seat never opened skipped); and the disconnect that turns
// those wakes off (the bridge's count falls) and keeps a hook the agent set
// with a room's own token on another link. Called from api.test.js; its
// rooms are its own (apitest-agentp-*), deleted at the end. Every key and
// token is made here, and none is printed.
'use strict';

const { museGadget, handover } = require('./muse-hooks.js');

async function agentPerson(ctx) {
  const { req, check, SUF, muse } = ctx;
  const made = [];
  const room = async (tag) => {
    const name = 'apitest-agentp-' + SUF + '-' + tag;
    const r = await req('POST', '/api/rooms/' + name, { owner: true });
    if (r.status === 201) made.push(name);
    return name;
  };
  const inviteOf = async (name, who, kind) => ((await req('POST', '/api/rooms/' + name + '/invites', { owner: true, json: { name: who, kind: kind || 'agent' } })).json || {}).token;
  const listOf = async (name) => (((await req('GET', '/api/rooms/' + name + '/invites', { owner: true })).json || {}).invites || []);
  const rowsOf = async (name, who) => (await listOf(name)).filter((i) => i.name === who);
  const bearer = (key) => ({ Authorization: 'Bearer ' + key });
  let ipn = 0;
  const net = '10.251.' + (parseInt(SUF, 36) % 200) + '.';
  const personKey = (body) => req('POST', '/api/agents/invite', { json: body, headers: { 'CF-Connecting-IP': net + (++ipn) } });
  const tool = async (key, name, args) => ((await req('POST', '/api/mcp', { json: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, headers: bearer(key) })).json || {});
  // every token the call could have made or reused: each room's whole invite list
  const tokensIn = async (names) => (await Promise.all(names.map(listOf))).flat().map((i) => i.token);
  const holdsNone = (text, toks) => toks.every((t) => !text.includes(t));
  const LIM = await import('../../worker/limits.ts');

  try {
    const A = await room('a'), B = await room('b');
    const PA = await inviteOf(A, 'PersonP', 'human'), PB = await inviteOf(B, 'PersonP', 'human');
    check('agent person: two rooms, a person\'s invite in each', made.length === 2 && !!PA && !!PB);
    const rooms = (extra) => [{ room: A, inviter_token: PA }, { room: B, inviter_token: PB }].map((e) => Object.assign(e, extra || {}));

    // the check: what it would do, nothing written
    const listBefore = JSON.stringify([await listOf(A), await listOf(B)]);
    let r = await personKey({ name: 'ScoutP', rooms: rooms(), check: true });
    check('agent person: check answers seat new in both rooms, ok', r.status === 200 && r.json.ok === true && JSON.stringify(r.json.rooms) === JSON.stringify([{ room: A, name: 'ScoutP', seat: 'new', opened: false }, { room: B, name: 'ScoutP', seat: 'new', opened: false }]), r.text.slice(0, 200));
    check('agent person: check wrote nothing (the owner\'s invite lists unchanged)', JSON.stringify([await listOf(A), await listOf(B)]) === listBefore);
    r = await personKey({ name: 'ScoutP', rooms: rooms(), check: 'true' });
    check('agent person: a check that is not a boolean is 400 and writes nothing', r.status === 400 && JSON.stringify(r.json) === JSON.stringify({ error: '"check" must be true or false' }) && JSON.stringify([await listOf(A), await listOf(B)]) === listBefore, r.status + ' ' + r.text.slice(0, 160));

    // the real call: a key; its answer dropped (nobody uses this key)
    r = await personKey({ name: 'ScoutP', rooms: rooms() });
    check('agent person: POST /api/agents/invite makes a key, 201 with its fields', r.status === 201 && JSON.stringify(Object.keys(r.json || {})) === JSON.stringify(['key', 'address', 'rooms', 'max_rooms', 'claude_code', 'mcp_json', 'handoff', 'note']) && /^\.ac1\./.test(r.json.key || '') && r.json.claude_code === 'claude mcp add --transport http agent-chat ' + r.json.address + ' --header "Authorization: Bearer KEY"', r.status + ' ' + r.text.slice(0, 160));
    let seats = [...(await rowsOf(A, 'ScoutP')), ...(await rowsOf(B, 'ScoutP'))];
    check('agent person: the owner sees two agent invites the person made, unopened', seats.length === 2 && seats.every((i) => i.kind === 'agent' && i.used === null && i.revoked === null), JSON.stringify(seats.map((i) => [i.kind, i.used, i.revoked])));
    check('agent person: no answer held their tokens', holdsNone(r.text, seats.map((i) => i.token)) && !/#invite=/.test(r.text) && !r.text.includes('agent_onboarding'));
    r = await req('GET', '/api/rooms/' + A + '/members', { owner: true });
    const mrow = ((r.json || {}).members || []).find((m) => m.name === 'ScoutP') || {};
    check('agent person: the members list shows the agent invited by the person, not yet opened', mrow.invited_by === 'PersonP' && mrow.kind === 'agent' && mrow.status === 'unused', JSON.stringify(mrow).slice(0, 160));

    // a new name reuses nothing; the same name reuses both unused seats
    r = await personKey({ name: 'RangerP', rooms: rooms() });
    check('agent person: a second key with a new name makes new seats', r.status === 201 && r.json.rooms.every((x) => x.seat === 'new'), r.text.slice(0, 160));
    r = await personKey({ name: 'ScoutP', rooms: rooms() });
    const KEY = r.json && r.json.key;
    check('agent person: the same name again reuses both unused seats, no new invite', r.status === 201 && r.json.rooms.every((x) => x.seat === 'reused') && (await rowsOf(A, 'ScoutP')).length === 1 && (await rowsOf(B, 'ScoutP')).length === 1, r.text.slice(0, 200));
    check('agent person: its answer holds no room token', holdsNone(r.text.split(KEY).join(''), await tokensIn([A, B])));
    if (!KEY) return;

    // the key works over /api/mcp: list_rooms, a post in each, read back with the person's own token
    let t = await tool(KEY, 'list_rooms', {});
    check('agent person: list_rooms through the key equals the creation\'s rooms', !!t.result && JSON.stringify(t.result.structuredContent.rooms.map((x) => [x.room, x.name])) === JSON.stringify(r.json.rooms.map((x) => [x.room, x.name])), JSON.stringify(t).slice(0, 200));
    for (const [name, tok] of [[A, PA], [B, PB]]) {
      t = await tool(KEY, 'post_message', { room: name, text: 'hello from the person\'s key in ' + name, client_msg_id: 'pk-' + name });
      const read = await req('GET', '/api/rooms/' + name + '/messages', { token: tok });
      check('agent person: a post through the key in ' + name.slice(-1) + ', read back by the person', !!t.result && !t.result.isError && (read.json.messages || []).some((m) => m.from === 'ScoutP' && m.text === 'hello from the person\'s key in ' + name), JSON.stringify(t).slice(0, 160));
    }

    // a call whose second inviter is revoked after its check: refused at the look, before anything is
    // made (a refusal after an invite was made, which keeps it unused, is the unit suite's:
    // tests/unit/agent-person.test.mjs)
    const C = await room('c'), D = await room('d');
    const PC = await inviteOf(C, 'PersonP', 'human'), PD = await inviteOf(D, 'PersonP', 'human');
    const cd = [{ room: C, inviter_token: PC }, { room: D, inviter_token: PD }];
    r = await personKey({ name: 'Racer', rooms: cd, check: true });
    check('agent person: the check of C and D passes', r.status === 200 && r.json.ok === true, r.text.slice(0, 160));
    await req('DELETE', '/api/rooms/' + D + '/invites/' + PD, { owner: true });
    r = await personKey({ name: 'Racer', rooms: cd });
    check('agent person: the inviter revoked after the check is the answer, 403 invite_revoked, and no invite was made in C', r.status === 403 && r.json.code === 'invite_revoked' && r.json.room === D && !('left_unused' in r.json) && (await rowsOf(C, 'Racer')).length === 0, r.status + ' ' + r.text.slice(0, 200));
    // the name taken in D after the check: refused while planning, nothing made
    const PD2 = await inviteOf(D, 'PersonQ', 'human');
    const cd2 = [{ room: C, inviter_token: PC }, { room: D, inviter_token: PD2 }];
    r = await personKey({ name: 'Racer', rooms: cd2, check: true });
    check('agent person: a new check passes', r.status === 200 && r.json.ok === true, r.text.slice(0, 200));
    await inviteOf(D, 'Racer', 'human');
    r = await personKey({ name: 'Racer', rooms: cd2 });
    check('agent person: D\'s name taken meanwhile: 409 name_taken, nothing made', r.status === 409 && r.json.code === 'name_taken' && !('left_unused' in r.json) && (await rowsOf(C, 'Racer')).length === 0, r.text.slice(0, 200));

    // the caps per room: five a day for the person, fifty active invites in the room
    const E = await room('e'), PE = await inviteOf(E, 'PersonP', 'human');
    for (let i = 0; i < LIM.MEMBER_INVITES_PER_DAY; i++) {
      const x = await req('POST', '/api/rooms/' + E + '/invites', { token: PE, json: { name: 'Pre' + i, kind: 'agent' } });
      if (x.status !== 201) break;
    }
    r = await personKey({ name: 'Capped', rooms: [{ room: E, inviter_token: PE }] });
    check('agent person: the person\'s ' + LIM.MEMBER_INVITES_PER_DAY + ' a day answer 429 rate_limited for that room, with Retry-After', r.status === 429 && r.json.code === 'rate_limited' && r.json.room === E && Number(r.headers.get('retry-after')) > 0, r.status + ' ' + r.text.slice(0, 160));
    const F = await room('f'), PF = await inviteOf(F, 'PersonP', 'human');
    for (let i = 0; i < LIM.MAX_ACTIVE_INVITES - 1; i++) await inviteOf(F, 'Fill' + i);
    r = await personKey({ name: 'Full', rooms: [{ room: F, inviter_token: PF }], check: true });
    check('agent person: ' + LIM.MAX_ACTIVE_INVITES + ' active invites: the check\'s problem is limit_reached', r.status === 200 && r.json.ok === false && r.json.rooms[0].problem && r.json.rooms[0].problem.code === 'limit_reached', r.text.slice(0, 200));

    // rooms added with the key
    const G = await room('g'), PG = await inviteOf(G, 'PersonP', 'human');
    r = await req('POST', '/api/agent/rooms/invite', { json: { name: 'ScoutP', rooms: [{ room: G, inviter_token: PG }] }, headers: bearer(KEY) });
    check('agent person: POST /api/agent/rooms/invite adds a room, a new seat', r.status === 201 && JSON.stringify(r.json) === JSON.stringify({ rooms: [{ room: G, name: 'ScoutP', opened: false, seat: 'new' }], rooms_held: 3 }), r.status + ' ' + r.text.slice(0, 200));
    check('agent person: its answer holds no room token', holdsNone(r.text, await tokensIn([G])));

    // muse_register through the key, against the fake Muse
    const hand = handover(req, '198.51.' + (parseInt(SUF, 36) % 250) + '.77');
    const gadget = await museGadget(ctx, hand, 'agentp');
    const roomsOf = async (link) => (await handover(req, '198.51.' + (parseInt(SUF, 36) % 250) + '.78')('POST', 'status', { museLinkId: link })).json;
    check('agent person: a gadget linked, a code to give the agent', gadget.status === 200 && !!gadget.code, gadget.status);
    // the seats as the owner's members list shows them: status, joined, last_seen
    const seatsSeen = async () => {
      const out = [];
      for (const name of [A, B, G]) {
        const m = (((await req('GET', '/api/rooms/' + name + '/members', { owner: true })).json || {}).members || []).find((x) => x.name === 'ScoutP') || {};
        out.push([m.status, m.joined, m.last_seen]);
      }
      return JSON.stringify(out);
    };
    const before = await seatsSeen();
    t = await tool(KEY, 'muse_register', { code: gadget.code, routing: 'main' });
    const res = (t.result && t.result.structuredContent && t.result.structuredContent.results) || [];
    check('agent person: muse_register claims the code once and sets the hooks in the joined rooms, skipping the one never opened', !!t.result && !t.result.isError && t.result.structuredContent.claimed === true && JSON.stringify(res.map((x) => [x.room, x.ok, x.code || null])) === JSON.stringify([[A, true, null], [B, true, null], [G, false, 'not_joined']]), JSON.stringify(t).slice(0, 300));
    check('agent person: the answer holds no link id', !JSON.stringify(t).includes(gadget.link));
    const st = await roomsOf(gadget.link);
    check('agent person: the bridge counts the two rooms on the link', st && st.rooms === 2, JSON.stringify(st));
    r = await req('GET', '/api/rooms/' + A + '/members', { token: PA });
    const md = ((r.json || {}).members || []).find((m) => m.name === 'ScoutP') || {};
    check('agent person: the members list shows ScoutP\'s Muse delivery', md.muse_delivery === true, JSON.stringify(md).slice(0, 200));
    const after = await seatsSeen();
    check('agent person: muse_register joined nothing and stamped no last_seen (the members list as before; G still unused)', after === before && JSON.parse(after)[2][0] === 'unused', before + ' / ' + after);
    t = await tool(KEY, 'list_rooms', {});
    check('agent person: list_rooms marks the rooms with a wake', !!t.result && JSON.stringify(t.result.structuredContent.rooms.map((x) => [x.room, !!x.muse_wake])) === JSON.stringify([[A, true], [B, true], [G, false]]), JSON.stringify(t).slice(0, 200));
    // the agent also has a hook of its own in B, with B's token, on another link: it replaces the key's there
    const own = await museGadget(ctx, hand, 'agentp-own');
    const TB = ((await rowsOf(B, 'ScoutP'))[0] || {}).token;
    r = await req('POST', '/api/muse/hooks', { json: { code: own.code, rooms: [{ room: B, token: TB }] } });
    check('agent person: a hook of the agent\'s own in B, with its room token', r.status === 200 && r.json.results[0].ok === true, r.text.slice(0, 160));

    // the disconnect: the key's wakes go (A), the agent's own hook stays (B)
    r = await req('DELETE', '/api/agent', { headers: bearer(KEY) });
    check('agent person: DELETE /api/agent disconnects and its wake goes, the key the last to hold it', r.status === 200 && r.json.deleted === true && JSON.stringify(r.json.muse_wakes_removed) === JSON.stringify([A]) && JSON.stringify(r.json.muse_wakes_left) === '[]' && /it has let go of every Muse wake it set up/.test(r.json.note) && /you are still a member of each of these rooms that still takes your invite/.test(r.json.note), r.text.slice(0, 300));
    let st2 = null;
    for (let i = 0; i < 30; i++) { st2 = await roomsOf(gadget.link); if (st2 && st2.rooms === 0) break; await new Promise((x) => setTimeout(x, 100)); }
    check('agent person: the bridge heard the hooks gone (the key\'s link counts none)', st2 && st2.rooms === 0, JSON.stringify(st2));
    r = await req('GET', '/api/rooms/' + B + '/muse-hook', { token: TB });
    check('agent person: the hook the agent set with B\'s own token on another link stays', r.status === 200 && !!r.json.hook && r.json.hook.kind === 'muse', r.text.slice(0, 200));
    t = await tool(KEY, 'list_rooms', {});
    check('agent person: the key works nowhere after', !!t.error && t.error.code === -32001, JSON.stringify(t).slice(0, 160));
    void muse;
  } finally {
    for (const name of made) {
      await req('DELETE', '/api/rooms/' + name + '/invites', { owner: true });
      await req('DELETE', '/api/rooms/' + name + '?confirm=' + name, { owner: true });
    }
  }
}

module.exports = { agentPerson };
