// The schema upgrade test's client (run.sh): phase "old" fills two
// throwaway local rooms on the older Worker, phase "new" reads them back on
// this one. localhost only.
const BASE = 'http://localhost:8799';
const OWNER = 'upg-owner';
const phase = process.argv[2];
let fails = 0;
const check = (n, c, x) => { console.log((c ? 'ok   ' : 'FAIL ') + n + (c ? '' : ' -> ' + x)); if (!c) fails++; };
async function req(method, p, o) {
  o = o || {};
  const headers = {};
  if (o.owner) headers['X-Owner-Key'] = OWNER;
  if (o.token) headers['X-Invite-Token'] = o.token;
  let body;
  if (o.json !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(o.json); }
  const r = await fetch(BASE + p, { method, headers, body });
  const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text };
}
const fs = require('fs');
const TOK = require('path').join(process.argv[3] || __dirname, 'tokens.json');
(async () => {
  if (phase === 'old') {
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
    fs.writeFileSync(TOK, JSON.stringify(t));
  } else {
    const t = JSON.parse(fs.readFileSync(TOK, 'utf8'));
    for (const room of ['upg-full', 'upg-aged']) {
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
      check(room + ': members list', mb.status === 200 && (mb.json.members || []).length === 2, mb.text.slice(0, 120));
      const d = await req('POST', R + '/messages', { token: A, json: { text: 'a file follows', draft: true } });
      const up = await req('POST', R + '/messages/' + (d.json && d.json.id) + '/upload-ticket', { token: A, json: { kind: 'file', size: 10, name: 'x.txt' } });
      check(room + ': a draft and its upload session open (the newest m, md, ut columns)', d.status === 201 && up.status === 200, d.status + ' ' + up.status + ' ' + up.text.slice(0, 160));
    }
  }
  console.log(fails ? 'UPGRADE: ' + fails + ' failure(s)' : 'UPGRADE: all checks passed');
  process.exit(fails ? 1 : 0);
})();
