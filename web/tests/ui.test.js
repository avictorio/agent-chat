// Parity harness for the React rewrite (web/PARITY.md, M1).
// The fake-API core below (fresh/roomState/setup) and the ported scenarios
// are copied VERBATIM from tests/ui.test.js — same fixtures, same
// assertions — with only the page-serving branches changed: this suite
// serves the built app (app/dist) instead of src/chat.html, and /api/build
// answers the skeleton's stamp ('next-dev'). A scenario counts toward
// parity only when it passes here. Scenarios are ported milestone by
// milestone; everything not yet ported is still missing by definition.
const { chromium } = require('playwright');
const fs = require('fs');
const DIST = __dirname + '/../app/dist';
const HTML = fs.readFileSync(DIST + '/index.html', 'utf8');
const OUT = __dirname + '/shots/';
fs.mkdirSync(OUT, { recursive: true });
const now = Date.now(), H = 3600e3, D = 86400e3;
function ymd(off) { const d = new Date(now + off * D); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
function fresh(opts) {
  opts = opts || {};
  return {
    deny: opts.deny || 0, noYou: !!opts.noYou, behind: !!opts.behind, agentYou: !!opts.agentYou,
    msgs: [
      { id: 1, ts: now - D - 2 * H, from: 'Henry', text: 'Morning all. Draft plan for Lima is in the board.' },
      { id: 2, ts: now - D - 2 * H + 60e3, from: 'Henry', text: 'Second thought: Huaca first, then Barranco.' },
      { id: 3, ts: now - 50 * 60e3, from: 'Ada', text: 'Agreed. Details here: https://example.com/lima-plan, and the constitution is up.', reactions: { '👍': ['Henry', 'Anthony'], '❤️': ['claude'], '🦄': ['Ada'] } },
      { id: 4, ts: now - 40 * 60e3, from: 'claude', text: 'Nice. Mention me if you want anything changed on the site.' },
      { id: 5, ts: now - 5 * 60e3, from: 'Anthony', text: 'Looks good to me.\nLet\'s lock it in.' },
      ...(opts.payloadKind ? [{ id: 6, ts: now - 2 * 60e3, from: 'Visitor', kind: 'human', text: 'Hi, just dropping by.' }] : []),
      ...(opts.artifacts ? [{ id: 8, ts: now - 60e3, from: 'Ada', kind: 'agent', text: 'Sharing the packet and the notes.', html: { type: 'text/html; charset=utf-8', bytes: 2048, name: 'Packet', url: '/api/rooms/demo/messages/8/html' }, doc: { type: 'text/markdown; charset=utf-8', bytes: 1024, name: 'notes.md', url: '/api/rooms/demo/messages/8/doc' }, image: { type: 'image/png', bytes: 4321, url: '/api/rooms/demo/messages/8/image' } }] : []),
      ...(opts.game ? [{ id: 9, ts: now - 45e3, from: 'Henry', kind: 'agent', text: 'Light Cycles match #1 - Ada (cyan) vs Henry (orange) vs Anthony (pink). Tick: 15 min. Tap the card for the arena.', game: { id: 1, type: 'lightcycles', status: 'running', tick: 3, tick_seconds: 900, winner: null, players: [{ name: 'Ada', color: 'cyan', hex: '#22d3ee', alive: true }, { name: 'Henry', color: 'orange', hex: '#fb923c', alive: true }, { name: 'Anthony', color: 'pink', hex: '#f472b6', alive: true }] } }] : []),
      ...(opts.duel || opts.duelDone ? [{ id: 10, ts: now - 45e3, from: 'Ada', kind: 'agent', text: 'Duel match #2 - Ada (cyan) vs Anthony (orange). Rock-paper-scissors, first to 3. Tap the card for the arena.', game: { id: 2, type: 'duel', status: opts.duelDone ? 'finished' : 'running', round: opts.duelDone ? 7 : 4, target: 3, winner: opts.duelDone ? 'Anthony' : null, players: [{ name: 'Ada', color: 'cyan', hex: '#22d3ee', wins: opts.duelDone ? 2 : 1, thrown: !opts.duelDone }, { name: 'Anthony', color: 'orange', hex: '#fb923c', wins: opts.duelDone ? 3 : 0, thrown: false }] } }] : []),
      ...(opts.markdown ? [
        { id: 7, ts: now - 90e3, from: 'Ada', kind: 'agent', text: '## Lima plan\nHere is the **draft**, with *one* open item and `code`.\n\n1. Huaca Pucllana\n2. Barranco dinner\n   - book for 8pm\n   - ask about cake\n3. ~~Miraflores~~ dropped\n\n| Day | Plan | Cost |\n|---|---|--:|\n| Fri | Huaca | $15 |\n| Sat | Dinner | $120 |\n\n> Note: confirm with Jen\n\n```js\nconst x = 1;\nconsole.log(x);\n```\nSee [the doc](https://example.com/doc) or https://example.com/raw.' },
        { id: 8, ts: now - 60e3, from: 'Anthony', kind: 'human', text: '<img src=x onerror=alert(1)> [bad](javascript:alert(1)) snake_case_name and 2 * 3 * 4 stay plain' },
        { id: 9, ts: now - 30e3, from: 'Anthony', kind: 'human', text: 'Second line from me, **bold**.' },
      ] : []),
    ],
    con: { version: 2, ts: now - 3 * H, editor: 'Ada', text: 'Purpose: a shared room where Henry, Hank, Ada and SHA help Anthony plan.\n\nNorms:\n- Be concise and credit ideas.\n- Settle things on the board, not only in chat.' },
    hist: [ { version: 1, ts: now - 2 * D, editor: 'Henry', text: 'First draft.' } ],
    dc: [
      { id: 1, ts: now - D, added_by: 'Henry', title: 'Huaca Pucllana first on the birthday day', note: 'Then dinner in Barranco.', signers: ['Henry', 'Ada'], updated: now },
      { id: 2, ts: now - 3 * H, added_by: 'Ada', title: 'Digests rotate alphabetically', note: null, signers: [], updated: now },
    ],
    q: [
      { id: 1, ts: now - 5 * H, added_by: 'Henry', text: 'Who books the dinner reservation?', status: 'open', claimed_by: null },
      { id: 2, ts: now - 2 * H, added_by: 'SHA', text: 'Do we need a backup plan if it rains in Lima?', status: 'claimed', claimed_by: 'Hank' },
    ],
    qr: [ { id: 3, ts: now - 2 * D, added_by: 'Ada', text: 'Do we need invites?', status: 'resolved', resolved_by: 'Anthony', resolution: 'Yes, the room is now invite-only.' } ],
    sk: [
      { id: 1, ts: now, added_by: 'Ada', title: "Jen's birthday in Lima", date: ymd(9), note: 'Pick a gift by the 8th', done: null },
      { id: 2, ts: now, added_by: 'Henry', title: 'Confirm hotel', date: ymd(1), note: null, done: null },
      { id: 3, ts: now, added_by: 'SHA', title: 'Write constitution v3', date: null, note: null, done: null },
    ],
    skd: [ { id: 4, ts: now - 2 * D, added_by: 'Ada', title: 'Lock the room', date: ymd(-1), done: now - D, done_by: 'Anthony' } ],
    dg: [ { id: 1, ts: now - 6 * H, day: ymd(0), author: 'Ada', text: 'Agreed on invite-only access. Open: digest cadence and dinner booking.' } ],
    game: opts.game ? { id: 1, type: 'lightcycles', status: 'running', created_by: 'Henry', card_msg: 9, w: 12, h: 10, tick: 3, tick_seconds: 900, deadline: now + 600e3, winner: null, record_keeper: null,
      players: [
        { name: 'Ada', color: 'cyan', hex: '#22d3ee', dir: 'right', alive: true, x: 5, y: 5, moved: true },
        { name: 'Henry', color: 'orange', hex: '#fb923c', dir: 'left', alive: true, x: 7, y: 5, moved: false },
        { name: 'Anthony', color: 'pink', hex: '#f472b6', dir: 'down', alive: true, x: 6, y: 3, moved: false },
      ],
      trails: [[3, 5, 0], [4, 5, 0], [5, 5, 0], [9, 5, 1], [8, 5, 1], [7, 5, 1], [6, 0, 2], [6, 1, 2], [6, 2, 2], [6, 3, 2]],
      log: [{ tick: 0, text: 'Match created by Henry - Ada, Henry, Anthony on the grid.' }],
      awaiting: ['Henry', 'Anthony'],
      you: { playing: true, alive: true, dir: 'down', queued: null, legal_moves: ['down', 'left', 'right'] } } : null,
    duel: (opts.duel || opts.duelDone) ? { id: 2, type: 'duel', status: opts.duelDone ? 'finished' : 'running', created_by: 'Ada', card_msg: 10, round: opts.duelDone ? 7 : 4, best_of: 5, target: 3, round_seconds: 600, deadline: now + 400e3, winner: opts.duelDone ? 'Anthony' : null,
      score: opts.duelDone ? { Ada: 2, Anthony: 3 } : { Ada: 1, Anthony: 0 },
      players: [
        { name: 'Ada', color: 'cyan', hex: '#22d3ee', wins: opts.duelDone ? 2 : 1, thrown: !opts.duelDone },
        { name: 'Anthony', color: 'orange', hex: '#fb923c', wins: opts.duelDone ? 3 : 0, thrown: false },
      ],
      rounds: opts.duelDone ? [
        { n: 1, throws: { Ada: 'scissors', Anthony: 'paper' }, winner: 'Ada', at: now - 40e3, throws_at: { Ada: now - 41e3, Anthony: now - 40e3 } },
        { n: 2, throws: { Ada: 'rock', Anthony: 'rock' }, winner: null, at: now - 35e3, throws_at: { Ada: now - 36e3, Anthony: now - 35e3 } },
        { n: 3, throws: { Ada: 'paper', Anthony: 'paper' }, winner: null, at: now - 30e3, throws_at: { Ada: now - 31e3, Anthony: now - 30e3 } },
        { n: 4, throws: { Ada: 'rock', Anthony: 'scissors' }, winner: 'Ada', at: now - 25e3, throws_at: { Ada: now - 26e3, Anthony: now - 25e3 } },
        { n: 5, throws: { Ada: 'paper', Anthony: 'scissors' }, winner: 'Anthony', at: now - 20e3, throws_at: { Ada: now - 21e3, Anthony: now - 20e3 } },
        { n: 6, throws: { Ada: 'scissors', Anthony: 'scissors' }, winner: null, at: now - 15e3, throws_at: { Ada: now - 16e3, Anthony: now - 15e3 } },
        { n: 7, throws: { Ada: 'paper', Anthony: 'scissors' }, winner: 'Anthony', at: now - 10e3, throws_at: { Ada: now - 11e3, Anthony: now - 10e3 } },
      ] : [
        { n: 1, throws: { Ada: 'scissors', Anthony: 'paper' }, winner: 'Ada', at: now - 30e3, throws_at: { Ada: now - 31e3, Anthony: now - 30e3 } },
        { n: 2, throws: { Ada: 'rock', Anthony: 'rock' }, winner: null, at: now - 25e3, throws_at: { Ada: now - 26e3, Anthony: now - 25e3 } },
        { n: 3, throws: { Ada: 'paper', Anthony: 'paper' }, winner: null, at: now - 20e3, throws_at: { Ada: now - 21e3, Anthony: now - 20e3 } },
      ],
      you: { playing: true, queued: null } } : null,
    mb: { invite_only: true, members: [
      { name: 'Anthony', kind: 'human', status: 'active', invited: now - 2 * D, joined: now - D, last_seen: now - 5 * 60e3, revoked: null, invite_link: 'https://chat.victorio.cloud/r/demo#invite=tok_Anthony' },
      { name: 'Henry', kind: 'agent', avatar: 'https://chat.victorio.cloud/api/rooms/demo/avatars/Henry?v=1', invited_by: null, status: 'active', invited: now - 2 * D, joined: now - D, last_seen: now - 2 * H, revoked: null, invite_link: 'https://chat.victorio.cloud/r/demo#invite=tok_Henry', agent_onboarding: 'You are invited to the Agent Chat room "demo" as the agent "Henry".\nThen implement the wake recipe and post a short hello.' },
      { name: 'Ada', kind: 'agent', status: 'active', invited: now - 2 * D, joined: now - D, last_seen: now - 40 * 60e3, revoked: null, invite_link: 'https://chat.victorio.cloud/r/demo#invite=tok_Ada', agent_onboarding: 'You are invited to the Agent Chat room "demo" as the agent "Ada".\nThen implement the wake recipe and post a short hello.' },
      { name: 'Hank', kind: 'agent', invited_by: 'Henry', status: 'unused', invited: now - 2 * D, joined: null, last_seen: null, revoked: null, invite_link: 'https://chat.victorio.cloud/r/demo#invite=tok_Hank', agent_onboarding: 'You are invited to the Agent Chat room "demo" as the agent "Hank".\nThen implement the wake recipe and post a short hello.' },
      { name: 'Old bot', kind: 'agent', status: 'revoked', invited: now - 5 * D, joined: now - 4 * D, last_seen: now - 4 * D, revoked: now - 3 * D },
    ] },
    nid: 100,
    av: { henry: { buf: require('fs').readFileSync(__dirname + '/../../tests/fixtures/henry.gif'), type: 'image/gif' } },
  };
}
function roomState(S) {
  return { v: 1, constitution_version: S.con.version,
    open_questions: S.q.map(x => ({ id: x.id, text: x.text, added_by: x.added_by, claimed_by: x.claimed_by })),
    decisions_awaiting_signatures: S.dc.filter(d => d.signers.length < 3).map(d => ({ id: d.id, title: d.title, signed_by: d.signers, missing: ['Anthony', 'Henry', 'Ada'].filter(n => d.signers.indexOf(n) < 0) })),
    stakes_due: S.sk.filter(s => s.date && s.date <= ymd(7)).map(s => ({ id: s.id, title: s.title, date: s.date, days_away: 1 })),
    memory: { latest_digest_day: ymd(0), latest_digest_by: 'Ada', digests_today: S.dg.length, awaiting_digest_from: 'Henry', digest_due_at: now + 10 * H } };
}
async function setup(page, S, calls) {
  await page.route('https://chat.victorio.cloud/**', async (route) => {
    const req = route.request(); const u = new URL(req.url()); const p = u.pathname; const m = req.method();
    let body = {}; try { body = req.postData() ? JSON.parse(req.postData()) : {}; } catch (e) {}
    calls && calls.push(m + ' ' + p + u.search + (req.postData() ? ' ' + req.postData() : ''));
    const J = (o, s) => route.fulfill({ status: s || 200, contentType: 'application/json', body: JSON.stringify(o) });
    S.av = S.av || {};
    let am;
    if ((am = p.match(/\/avatars\/([^\/]+)$/))) { const a = S.av[decodeURIComponent(am[1]).toLowerCase()]; return a ? route.fulfill({ status: 200, contentType: a.type, body: a.buf }) : route.fulfill({ status: 404, body: 'none' }); }
    if (p.endsWith('/avatar')) {
      calls && calls.push(m + ' ' + p + ' ' + (req.headers()['content-type'] || '') + ' ' + ((req.postDataBuffer() || []).length));
      const me = S.mb.members.find(x => x.name === 'Anthony');
      if (m === 'DELETE') { delete S.av.anthony; me.avatar = null; return J({ ok: 1 }); }
      const buf = req.postDataBuffer(); const type = req.headers()['content-type'];
      if (!/^image\/(png|jpeg|webp|gif)$/.test(type)) return J({ error: 'Avatars must be PNG, JPEG, WebP or GIF' }, 415);
      S.av.anthony = { buf, type }; me.avatar = 'https://chat.victorio.cloud/api/rooms/demo/avatars/Anthony?v=' + Date.now(); return J({ ok: 1 });
    }
    if (p === '/emoji.json') return route.fulfill({ status: 200, contentType: 'application/json', body: require('fs').readFileSync(__dirname + '/../../tests/fixtures/emoji-compact.json') });
    if (p.startsWith('/assets/')) { try { const body = require('fs').readFileSync(DIST + p); return route.fulfill({ status: 200, contentType: p.endsWith('.css') ? 'text/css' : 'text/javascript', body }); } catch (e) { return route.fulfill({ status: 404, body: 'nf' }); } }
    if (p.startsWith('/r/') || p === '/') return route.fulfill({ status: 200, contentType: 'text/html', body: HTML });
    if (p === '/api/build') return J({ build: S.behind ? 'uitestbuild2' : 'next-dev' });
    if (p.startsWith('/api/') && S.deny) return J({ error: S.deny === 403 ? "This invite link has been revoked. Ask the room owner for a new one." : "This room is invite-only. Open your invite link to join." }, S.deny);
    if (p.endsWith('/stream')) return route.fulfill({ status: 200, contentType: 'text/event-stream', body: 'retry: 600000\n\n' });
    if (/\/messages\/\d+\/html$/.test(p)) return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>Probe</title><p>artifact body</p>' });
    if (/\/messages\/\d+\/doc$/.test(p)) return route.fulfill({ status: 200, contentType: 'text/markdown', body: '# Probe doc\n\nRendered **body** here.' });
    if (/\/messages\/\d+\/image$/.test(p)) return route.fulfill({ status: 200, contentType: 'image/png', body: require('fs').readFileSync(__dirname + '/../../tests/fixtures/photo.png') });
    if ((am = p.match(/\/messages\/(\d+)\/reactions$/))) {
      const msg = S.msgs.find(x => x.id == am[1]); if (!msg) return J({ error: 'No message' }, 404);
      const r = msg.reactions || {}; Object.keys(r).forEach(k => { r[k] = r[k].filter(x => x.toLowerCase() !== body.from.toLowerCase()); if (!r[k].length) delete r[k]; });
      if (body.reaction) (r[body.reaction] = r[body.reaction] || []).push(body.from);
      msg.reactions = r; return J({ room: 'demo', id: msg.id, reactions: r });
    }
    if (p.endsWith('/messages') && m === 'POST') { const x = { id: ++S.nid, ts: Date.now(), from: body.from, text: body.text }; S.msgs.push(x); return J(Object.assign({}, x, { room_state: roomState(S) }), 201); }
    if (p.endsWith('/messages')) return J(S.agentYou
      ? { room: 'demo', messages: S.msgs, last_id: S.msgs[S.msgs.length - 1].id, you: 'Probe', you_kind: 'agent', agent_onboarding: 'You are invited to the Agent Chat room "demo" as the agent "Probe".\nConnect over MCP (Model Context Protocol), the room\'s agent surface:\n  Endpoint: POST https://chat.victorio.cloud/api/rooms/demo/mcp\n  Header: X-Invite-Token: tok_Probe\nSend initialize, then tools/list for the room\'s tools (messages, reactions, the board, games, voice, fetch, uploads). Call whoami and get_room_state first.', room_state: roomState(S) }
      : { room: 'demo', messages: S.msgs, last_id: S.msgs[S.msgs.length - 1].id, you: S.noYou ? undefined : 'Anthony', you_kind: 'human', room_state: roomState(S) });
    if (p.endsWith('/constitution') && m === 'PUT') { S.hist.push(S.con); S.con = { version: S.con.version + 1, ts: Date.now(), editor: body.from, text: body.text }; return J({ constitution: S.con }, 201); }
    if (p.endsWith('/constitution')) return J({ constitution: S.con, history: S.hist.concat([S.con]) });
    let mm;
    if (p.endsWith('/decisions') && m === 'POST') { S.dc.push({ id: ++S.nid, ts: Date.now(), added_by: body.from, title: body.title, note: body.note || null, signers: [] }); return J({ ok: 1 }, 201); }
    if (p.endsWith('/decisions')) return J({ decisions: S.dc });
    if ((mm = p.match(/decisions\/(\d+)$/))) { const d = S.dc.find(x => x.id == mm[1]); if (m === 'DELETE') { S.dc = S.dc.filter(x => x !== d); return J({ ok: 1 }); } if (body.action === 'sign') d.signers.push(body.from); if (body.action === 'unsign') d.signers = d.signers.filter(s => s !== body.from); if (body.action === 'edit') { d.title = body.title; d.note = body.note; } return J({ decision: d }); }
    if (p.endsWith('/questions') && m === 'POST') { S.q.push({ id: ++S.nid, ts: Date.now(), added_by: body.from, text: body.text, status: 'open', claimed_by: null }); return J({ ok: 1 }, 201); }
    if (p.endsWith('/questions')) return J({ questions: S.q, resolved: S.qr });
    if ((mm = p.match(/questions\/(\d+)$/))) { let q = S.q.concat(S.qr).find(x => x.id == mm[1]); if (m === 'DELETE') { S.q = S.q.filter(x => x !== q); S.qr = S.qr.filter(x => x !== q); return J({ ok: 1 }); }
      if (body.action === 'claim') { q.status = 'claimed'; q.claimed_by = body.from; } if (body.action === 'unclaim') { q.status = 'open'; q.claimed_by = null; }
      if (body.action === 'resolve') { q.status = 'resolved'; q.resolved_by = body.from; q.resolution = body.note; S.q = S.q.filter(x => x !== q); S.qr.unshift(q); }
      if (body.action === 'edit') q.text = body.text; return J({ question: q }); }
    if (p.endsWith('/stakes') && m === 'POST') { S.sk.push({ id: ++S.nid, ts: Date.now(), added_by: body.from, title: body.title, date: body.date || null, note: body.note || null }); return J({ ok: 1 }, 201); }
    if (p.endsWith('/stakes')) return J({ stakes: S.sk, done: S.skd });
    if ((mm = p.match(/stakes\/(\d+)$/))) { const s = S.sk.concat(S.skd).find(x => x.id == mm[1]); if (body.action === 'done') { s.done = Date.now(); s.done_by = body.from; S.sk = S.sk.filter(x => x !== s); S.skd.unshift(s); } return J({ stake: s }); }
    if (p.endsWith('/digests') && m === 'POST') { S.dg.unshift({ id: ++S.nid, ts: Date.now(), day: ymd(0), author: body.from, text: body.text }); return J({ ok: 1 }, 201); }
    if (p.includes('/digests')) return J({ digests: S.dg });
    if (p.endsWith('/invites') && m === 'POST') { if (S.mb.members.some(x => x.name.toLowerCase() === body.name.toLowerCase() && x.status !== 'revoked')) return J({ error: body.name + ' already has an active invite.' }, 409); S.mb.members.push({ name: body.name, kind: body.kind, invited_by: 'Anthony', status: 'unused', invited: Date.now() }); const inv = { room: 'demo', name: body.name, kind: body.kind, token: 'tok_' + body.name, link: 'https://chat.victorio.cloud/r/demo#invite=tok_' + body.name, created: Date.now() }; if (body.kind !== 'human') inv.agent_onboarding = 'You are invited to the Agent Chat room "demo" as the agent "' + body.name + '".\nInvite link: ' + inv.link + '\nThen implement the wake recipe and post a short hello.'; return J(inv, 201); }
    if ((mm = p.match(/games\/(\d+)\/moves$/)) && m === 'POST') { const gm = S.duel && S.duel.id == mm[1] ? S.duel : S.game; if (!gm || gm.id != mm[1]) return J({ error: 'No game' }, 404); gm.you.queued = body.dir; const pl = gm.players.find(x => x.name === 'Anthony'); if (pl) { pl.moved = true; pl.thrown = true; } if (gm.awaiting) gm.awaiting = gm.awaiting.filter(n => n !== 'Anthony'); return J({ room: 'demo', game: gm, resolved: false }); }
    if ((mm = p.match(/games\/(\d+)$/))) { const gm = S.duel && S.duel.id == mm[1] ? S.duel : S.game; if (!gm || gm.id != mm[1]) return J({ error: 'No game with that id' }, 404); return J({ room: 'demo', game: gm }); }
    if (p.endsWith('/members')) return J(S.mb);
    return route.fulfill({ status: 404, body: 'nf' });
  });
}
let FAILURES = 0;
(async () => {
  const shot = (page, f) => page.screenshot({ path: OUT + f });
  async function run(name, o, fn) {
    const b = await chromium.launch({ args: o.args || [] });
    const ctx = await b.newContext({ colorScheme: o.scheme || 'light', viewport: { width: o.w || 1280, height: o.h || 860 }, userAgent: o.ua, hasTouch: !!o.touch, isMobile: !!o.touch });
    const page = await ctx.newPage();
    const errs = []; page.on('pageerror', e => errs.push(e.message)); page.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
    const S = fresh(o.state); const calls = [];
    await setup(page, S, calls);
    if (o.init) await page.addInitScript(o.init);
    try {
      await page.goto('https://chat.victorio.cloud/r/demo' + (o.hash || ''));
      await page.waitForTimeout(500);
      const r = await fn(page, S, calls);
      const fatal = errs.filter(e => !e.startsWith('console:'));
      if (fatal.length) throw new Error('uncaught page errors: ' + JSON.stringify(fatal));
      console.log('PASS ' + name + (r ? ' ' + JSON.stringify(r) : ''));
    } catch (e) {
      FAILURES++;
      console.log('FAIL ' + name + ': ' + (e && e.message ? String(e.message).split('\n')[0] : String(e)));
    } finally {
      await b.close();
    }
  }
  // M1 smoke scenario (not a parity item): proves the harness discriminates
  // and the skeleton's wiring works — invite fragment stored and scrubbed,
  // fixture messages fetched through the typed client and rendered.
  await run('skeleton', { hash: '#invite=tok_Anthony' }, async (page) => {
    const out = {};
    await page.waitForSelector('.msg', { timeout: 4000 });
    out.msgs = await page.$$eval('.msg', els => els.length);
    out.stored = await page.evaluate(() => { try { return localStorage.getItem('chat-invite:demo'); } catch (e) { return null; } });
    out.hashAfter = await page.evaluate(() => location.hash);
    if (out.msgs < 5) throw new Error('skeleton should render the fixture messages, got ' + out.msgs);
    if (out.stored !== 'tok_Anthony') throw new Error('invite not stored under chat-invite:demo: ' + out.stored);
    if (out.hashAfter !== '') throw new Error('invite fragment not scrubbed: ' + out.hashAfter);
    await shot(page, 'skeleton.png');
    return out;
  });
  await run('duel-card', { state: { duel: true } }, async (page, S, calls) => {
    const out = {};
    await page.waitForSelector('.game-card .duel-board', { timeout: 4000 });
    out.pill = await page.$eval('.game-card .duel-pill', e => e.textContent);
    out.pipColor = await page.$eval('.game-card .duel-row .duel-pips', e => getComputedStyle(e).color);
    out.faceoff = await page.$eval('.game-card .duel-faceoff-line', e => e.textContent);
    out.clockbar = await page.$$eval('.game-card .duel-clockbar', els => els.length);
    if (!/YOUR THROW/.test(out.pill)) throw new Error('card pill wrong: ' + out.pill);
    if (out.pipColor !== 'rgb(34, 211, 238)') throw new Error('Ada pips should be her cyan, got ' + out.pipColor);
    if (!/CLASH/.test(out.faceoff)) throw new Error('card face-off should name the clash: ' + out.faceoff);
    if (out.clockbar !== 1) throw new Error('card should carry one round clock bar, got ' + out.clockbar);
    await shot(page, 'duel-card.png');
    await page.click('.game-card');
    await page.waitForSelector('#viewer:not([hidden]) .duel-tile', { timeout: 4000 });
    out.tiles = await page.$$eval('#viewer .duel-tile .t-beats', els => els.map(e => e.textContent));
    out.status = await page.$eval('#viewer .duel-statusline', e => e.textContent);
    out.verdict = await page.$eval('#viewer .duel-verdict', e => e.textContent);
    if (JSON.stringify(out.tiles) !== JSON.stringify(['crushes scissors', 'covers rock', 'cut paper'])) throw new Error('tile microcopy wrong: ' + JSON.stringify(out.tiles));
    if (!/your throw decides the round/.test(out.status)) throw new Error('status line wrong: ' + out.status);
    if (!/CLASH/.test(out.verdict)) throw new Error('verdict banner should name the clash: ' + out.verdict);
    await shot(page, 'duel-arena.png');
    await page.click('#viewer .duel-tile:nth-child(3)');
    await page.waitForFunction(() => document.querySelector('#viewer .duel-tile.queued'), null, { timeout: 4000 });
    out.moveCall = calls.filter(c => c.includes('/games/2/moves')).pop() || '';
    if (!/"dir":"scissors"/.test(out.moveCall)) throw new Error('move call wrong: ' + out.moveCall);
    await shot(page, 'duel-arena-queued.png');
    await page.goBack();
    await page.waitForFunction(() => document.getElementById('viewer').hidden, null, { timeout: 4000 });
    return out;
  });
  for (const [label, o] of [['markdown-light', {}], ['markdown-dark', { scheme: 'dark' }], ['markdown-mobile', { w: 390, h: 844 }]]) {
    await run(label, Object.assign({ state: { markdown: true }, init: () => { window.__alert = 0; window.alert = () => { window.__alert++; }; } }, o), async (page) => {
      await page.waitForTimeout(300);
      await page.evaluate(() => { const l = document.getElementById('list'); l.scrollTop = l.scrollHeight - 1600; });
      await shot(page, label + '.png');
      await page.evaluate(() => { const l = document.getElementById('list'); l.scrollTop = l.scrollHeight; });
      await shot(page, label + '-bottom.png');
      if (label !== 'markdown-light') return;
      return await page.evaluate(() => {
        const m7 = document.querySelector('.msg[data-id="7"] .text'), m8 = document.querySelector('.msg[data-id="8"] .text');
        return {
          h: m7.querySelector('.md-h2') && m7.querySelector('.md-h2').textContent,
          strong: m7.querySelector('strong').textContent, em: m7.querySelector('em').textContent, code: m7.querySelector('p code').textContent,
          ol: Array.from(m7.querySelectorAll(':scope > ol > li')).length, nested: Array.from(m7.querySelectorAll('ol li ul li')).map(x => x.textContent),
          del: m7.querySelector('del').textContent, table: Array.from(m7.querySelectorAll('td')).map(x => x.textContent + (x.style.textAlign ? '@' + x.style.textAlign : '')),
          quote: m7.querySelector('blockquote').textContent, pre: m7.querySelector('pre code').textContent,
          links: Array.from(m7.querySelectorAll('a')).map(a => a.textContent + '=>' + a.getAttribute('href')),
          xssImgs: document.querySelectorAll('.text img').length, xssText: m8.textContent, xssLinks: Array.from(m8.querySelectorAll('a')).length, xssEm: m8.querySelectorAll('em').length,
          alerts: window.__alert,
          human: Array.from(document.querySelectorAll('.msg')).map(r => r.dataset.id + (r.classList.contains('human') ? 'H' : '')).join(' '),
        };
      });
    });
  }
  await run('agent-gate', { state: { agentYou: true } }, async (page) => {
    const out = {};
    await page.waitForSelector('#view-agent:not([hidden])', { timeout: 4000 });
    out.block = await page.$eval('#agentBlock', e => e.textContent);
    out.intro = await page.$eval('#agentIntro', e => e.textContent);
    if (!/\/api\/rooms\/demo\/mcp/.test(out.block)) throw new Error('setup block must name the MCP endpoint: ' + out.block.slice(0, 80));
    if (!/X-Invite-Token: tok_Probe/.test(out.block)) throw new Error('setup block must carry the invite header');
    if (!/Probe/.test(out.intro)) throw new Error('intro must name the agent: ' + out.intro);
    await shot(page, 'agent-gate.png');
    await page.click('#agentApp');
    await page.waitForSelector('#view-chat:not([hidden])', { timeout: 4000 });
    out.chatAfterEscape = true;
    await page.reload();
    await page.waitForTimeout(700);
    out.gateAfterReload = await page.$eval('#view-agent', e => !e.hidden);
    if (out.gateAfterReload) throw new Error('agent gate must not reappear after the escape on this device');
    return out;
  });
  console.log(FAILURES ? 'PARITY SUITE: ' + FAILURES + ' failing scenario(s)' : 'PARITY SUITE: all ported scenarios pass');
  process.exit(FAILURES ? 1 : 0);
})();
