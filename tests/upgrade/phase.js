// The schema upgrade test's client (run.sh): phase "old" fills two
// throwaway local rooms on the older Worker, phase "new" reads them back on
// this one, phase "again" reads each room again after the aged one's
// schema version was cleared again (so its steps run a second time), and
// "muse" hosts the fake Muse both Workers' bridges call (it writes its
// address and three gadgets' sealed tokens to muse.json, and runs until
// stopped). localhost only.
const BASE = 'http://localhost:8799';
const OWNER = 'upg-owner';
const phase = process.argv[2];
let fails = 0;
const check = (n, c, x) => { console.log((c ? 'ok   ' : 'FAIL ') + n + (c ? '' : ' -> ' + x)); if (!c) fails++; };
async function req(method, p, o) {
  o = o || {};
  const headers = Object.assign({}, o.headers || {});
  if (o.owner) headers['X-Owner-Key'] = OWNER;
  if (o.token) headers['X-Invite-Token'] = o.token;
  let body;
  if (o.json !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(o.json); }
  const r = await fetch(BASE + p, { method, headers, body });
  const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text };
}
const fs = require('fs');
const path = require('path');
const WORK = process.argv[3] || __dirname;
const TOK = path.join(WORK, 'tokens.json');
const ROOMS = ['upg-full', 'upg-aged'];
/** the gadget's handover (POST /api/muse/connect), as tests/api/muse-hooks.js makes it */
const connect = (sealed, n) => req('POST', '/api/muse/connect', { json: { sealed, termsVersion: 'v1' }, headers: { 'CF-Connecting-IP': '198.51.100.' + n } });
/** a tools/call at the agent key's address */
const tool = (key, name, args) => req('POST', '/api/mcp', { json: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, headers: { Authorization: 'Bearer ' + key } });
(async () => {
  if (phase === 'muse') {
    // the fake Muse (tests/api/fake-muse.mjs, the bridge's TypeScript through the unit tests' module hooks), and three Muse accounts whose tokens three gadgets seal to the run's key
    const { register } = require('node:module');
    const { pathToFileURL } = require('node:url');
    register('../unit/txt-hooks.mjs', pathToFileURL(__filename));
    const muse = await (await import(pathToFileURL(path.join(__dirname, '..', 'api', 'fake-muse.mjs')).href)).startFakeMuse();
    const pub = JSON.parse(fs.readFileSync(path.join(WORK, 'seal.json'), 'utf8')).publicKey;
    const gadgets = [];
    for (const n of [1, 2, 3]) {
      muse.account('tok-upg-' + n, 'vm-upg-' + n);
      gadgets.push({ sealed: await muse.seal({ accessToken: 'tok-upg-' + n, nodeId: 'gadget-upg-' + n }, pub) });
    }
    fs.writeFileSync(path.join(WORK, 'muse.json'), JSON.stringify({ url: muse.url, gadgets }));
    process.on('SIGTERM', () => { muse.close(); process.exit(0); });
    return;
  }
  if (phase === 'again') {
    // one read of each room starts it, and the aged one runs every step a second time
    const t = JSON.parse(fs.readFileSync(TOK, 'utf8'));
    for (const room of ROOMS) {
      const r = await req('GET', '/api/rooms/' + room + '/messages?limit=1', { token: t[room].H });
      check(room + ': read again after its schema version was cleared', r.status === 200, r.status + ' ' + r.text.slice(0, 100));
    }
  } else if (phase === 'old') {
    const t = {};
    for (const room of ['upg-full', 'upg-aged']) {
      const R = '/api/rooms/' + room;
      check(room + ' created', (await req('POST', R, { owner: true })).status < 300);
      const H = (await req('POST', R + '/invites', { owner: true, json: { name: 'OldHuman', kind: 'human' } })).json.token;
      const A = (await req('POST', R + '/invites', { owner: true, json: { name: 'OldAgent', kind: 'agent' } })).json.token;
      const m1 = await req('POST', R + '/messages', { token: H, json: { text: 'hello from the old code in ' + room } });
      check(room + ' posted', m1.status === 201, m1.text.slice(0, 100));
      await req('POST', R + '/messages', { token: A, json: { text: 'an agent reply' } });
      await req('POST', R + '/messages/' + m1.json.id + '/reactions', { token: A, json: { reaction: '👍' } });
      await req('PUT', R + '/constitution', { token: H, json: { text: 'We test upgrades here.' } });
      await req('POST', R + '/questions', { token: A, json: { text: 'Does the data survive?' } });
      // "game" names the game; this once sent "type", which the server
      // never read, so every run carried a Light Cycles lobby, not a duel
      const g = await req('POST', R + '/games', { token: H, json: { game: 'duel', players: ['OldHuman', 'OldAgent'] } });
      check(room + ' duel created', g.status === 201 && g.json.game && g.json.game.type === 'duel', g.text.slice(0, 120));
      // an ended match for the results table's backfill (schema step 6)
      const off = await req('POST', R + '/games', { token: H, json: { game: 'duel', players: ['OldHuman', 'OldAgent'] } });
      const dec = await req('POST', R + '/games/' + (off.json && off.json.game && off.json.game.id) + '/decline', { token: A });
      check(room + ' a duel declined', dec.status === 200 && dec.json.game && dec.json.game.status === 'cancelled', dec.text.slice(0, 120));
      t[room] = { H, A, msg: m1.json.id, game: g.json && g.json.game && g.json.game.id, off: off.json && off.json.game && off.json.game.id };
    }
    // Muse hooks on OLD_REF's code: two gadgets link two Muses; in each room
    // two agents join, WakeA registers its hook with its own tokens (the
    // first gadget's code, one batch), and WakeB's tokens make an agent key
    // whose muse_register sets its hooks (the second gadget's code): two
    // entries that record a link, with no holder tag
    const m = JSON.parse(fs.readFileSync(path.join(WORK, 'muse.json'), 'utf8'));
    const g1 = await connect(m.gadgets[0].sealed, 1), g2 = await connect(m.gadgets[1].sealed, 2);
    check('two gadgets linked', g1.status === 200 && g2.status === 200 && !!(g1.json && g1.json.code) && !!(g2.json && g2.json.code), g1.status + ' ' + g2.status + ' ' + g1.text.slice(0, 100));
    for (const room of ROOMS) {
      const R = '/api/rooms/' + room;
      t[room].WA = (await req('POST', R + '/invites', { owner: true, json: { name: 'WakeA', kind: 'agent' } })).json.token;
      t[room].WB = (await req('POST', R + '/invites', { owner: true, json: { name: 'WakeB', kind: 'agent' } })).json.token;
      // each joins with a post (inspect.py checks every member's inv.posted)
      for (const tk of [t[room].WA, t[room].WB]) check(room + ': an agent joins', (await req('POST', R + '/messages', { token: tk, json: { text: 'a wake follows' } })).status === 201);
    }
    const reg = await req('POST', '/api/muse/hooks', { json: { code: g1.json.code, rooms: ROOMS.map((room) => ({ room, token: t[room].WA })) } });
    check('WakeA registers its Muse hook in both rooms with its own tokens', reg.status === 200 && reg.json && reg.json.claimed === true && (reg.json.results || []).every((x) => x.ok), reg.status + ' ' + reg.text.slice(0, 200));
    const key = await req('POST', '/api/agents', { json: { rooms: ROOMS.map((room) => ({ room, token: t[room].WB })) }, headers: { 'CF-Connecting-IP': '10.77.0.1' } });
    check('WakeB\'s tokens make an agent key', key.status === 201 && !!(key.json && key.json.key), key.status + ' ' + key.text.slice(0, 120));
    const mr = await tool(key.json.key, 'muse_register', { code: g2.json.code });
    const res = mr.json && mr.json.result && mr.json.result.structuredContent;
    check('muse_register through the key sets its hooks in both rooms', !!res && res.claimed === true && res.results.length === 2 && res.results.every((x) => x.ok), mr.text.slice(0, 200));
    t.key = key.json.key;
    fs.writeFileSync(TOK, JSON.stringify(t));
  } else {
    const t = JSON.parse(fs.readFileSync(TOK, 'utf8'));
    // the hooks OLD_REF's code set: the key still records its wakes, WakeA's are on, and the key's
    // disconnect turns its own off (settling through the holder step 10 gave them, pre), WakeA's staying on
    const g = await req('GET', '/api/agent', { headers: { Authorization: 'Bearer ' + t.key } });
    check('the key lists both rooms with their Muse wakes', g.status === 200 && JSON.stringify((g.json.rooms || []).map((x) => [x.room, x.muse_wake])) === JSON.stringify(ROOMS.map((room) => [room, true])), g.status + ' ' + g.text.slice(0, 200));
    const onFor = async (room) => { const h = await req('GET', '/api/rooms/' + room + '/muse-hook', { token: t[room].WA }); return h.status === 200 && !!h.json.hook && h.json.hook.kind === 'muse' && h.json.hook.enabled === true; };
    for (const room of ROOMS) check(room + ': WakeA\'s hook is on', await onFor(room));
    const cut = await req('DELETE', '/api/agent', { headers: { Authorization: 'Bearer ' + t.key } });
    check('the key\'s disconnect turns off its wakes in both rooms, none left', cut.status === 200 && JSON.stringify(cut.json.muse_wakes_removed) === JSON.stringify(ROOMS) && JSON.stringify(cut.json.muse_wakes_left) === '[]', cut.status + ' ' + cut.text.slice(0, 200));
    for (const room of ROOMS) check(room + ': WakeA\'s hook is still on', await onFor(room));
    for (const room of ROOMS) {
      const R = '/api/rooms/' + room;
      const { H, A, msg, game } = t[room];
      const r = await req('GET', R + '/messages?limit=50', { token: H });
      const texts = (r.json && r.json.messages || []).map((m) => m.text);
      check(room + ': old messages read back', r.status === 200 && texts.includes('hello from the old code in ' + room) && texts.includes('an agent reply'), r.status + ' ' + JSON.stringify(texts));
      const first = (r.json.messages || []).find((m) => m.id === msg) || {};
      check(room + ': the old reaction is there', JSON.stringify(first.reactions || {}) === JSON.stringify({ '👍': ['OldAgent'] }), JSON.stringify(first.reactions));
      const p = await req('POST', R + '/messages', { token: A, json: { text: 'posted on the new code' } });
      check(room + ': a new post works', p.status === 201, p.text.slice(0, 120));
      const c = await req('GET', R + '/constitution', { token: A });
      check(room + ': constitution kept', c.json && c.json.constitution && c.json.constitution.text === 'We test upgrades here.', c.text.slice(0, 100));
      const q = await req('GET', R + '/questions', { token: A });
      check(room + ': question kept', q.text.includes('Does the data survive?'), q.text.slice(0, 100));
      const gm = await req('GET', R + '/games/' + game, { token: H });
      check(room + ': the old duel reads', gm.status === 200 && gm.json.game && gm.json.game.id === game && gm.json.game.type === 'duel' && gm.json.game.status === 'lobby', gm.status + ' ' + gm.text.slice(0, 100));
      const acc = await req('POST', R + '/games/' + game + '/accept', { token: A });
      check(room + ': the old duel accepts a seat and starts', acc.status === 200 && acc.json.game && acc.json.game.type === 'duel' && acc.json.game.status === 'running', acc.status + ' ' + acc.text.slice(0, 120));
      const gl = await req('GET', R + '/games', { token: H });
      const offRow = gl.json && (gl.json.games || []).find((x) => x.id === t[room].off);
      check(room + ': the old declined duel is in the games list', gl.status === 200 && offRow && offRow.status === 'cancelled' && offRow.type === 'duel', gl.status + ' ' + gl.text.slice(0, 160));
      const mb = await req('GET', R + '/members', { token: H });
      check(room + ': members list', mb.status === 200 && (mb.json.members || []).length === 4, mb.text.slice(0, 120));
      const d = await req('POST', R + '/messages', { token: A, json: { text: 'a file follows', draft: true } });
      const up = await req('POST', R + '/messages/' + (d.json && d.json.id) + '/upload-ticket', { token: A, json: { kind: 'file', size: 10, name: 'x.txt' } });
      check(room + ': a draft and its upload session open (the newest m, md, ut columns)', d.status === 201 && up.status === 200, d.status + ' ' + up.status + ' ' + up.text.slice(0, 160));
      // inv.left_ts (schema step 9): the old agent leaves, and the list carries when
      const lv = await req('POST', R + '/leave', { token: A, json: { confirm: room } });
      check(room + ': a member leaves (inv.left_ts)', lv.status === 200 && lv.json && lv.json.name === 'OldAgent' && lv.json.room_deleted === false && lv.json.left > 0, lv.status + ' ' + lv.text.slice(0, 160));
      const after = await req('GET', R + '/members', { token: H });
      const gone = ((after.json && after.json.members) || []).find((x) => x.name === 'OldAgent') || {};
      const stays = ((after.json && after.json.members) || []).find((x) => x.name === 'OldHuman') || {};
      check(room + ': ... the list shows it revoked with left, the others with left null', gone.status === 'revoked' && gone.left === lv.json.left && stays.left === null, JSON.stringify([gone, stays]).slice(0, 200));
    }
    // in the aged room WakeA registers again with its own token, on a third gadget's link: its hook there is
    // held by "self" alone, which a second run of step 10 must leave as it is (inspect.py)
    const m = JSON.parse(fs.readFileSync(path.join(WORK, 'muse.json'), 'utf8'));
    const g3 = await connect(m.gadgets[2].sealed, 3);
    const reg3 = await req('POST', '/api/muse/hooks', { json: { code: g3.json && g3.json.code, rooms: [{ room: 'upg-aged', token: t['upg-aged'].WA }] } });
    const res3 = (reg3.json && reg3.json.results) || [];
    check('upg-aged: WakeA registers again on a third gadget\'s link', g3.status === 200 && reg3.status === 200 && reg3.json.claimed === true && res3.length === 1 && res3[0].ok === true, g3.status + ' ' + reg3.status + ' ' + reg3.text.slice(0, 160));
  }
  console.log(fails ? 'UPGRADE: ' + fails + ' failure(s)' : 'UPGRADE: all checks passed');
  process.exit(fails ? 1 : 0);
})();
