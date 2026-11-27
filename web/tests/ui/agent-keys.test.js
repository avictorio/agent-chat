// UI scenarios: Home → Agent keys (web/app/src/features/home/AgentKeys.tsx),
// on a fake API of its own: the rooms this browser holds, each looked at
// with GET /invite; the agent routes (POST /api/agents/invite with and
// without check, GET /api/agent, POST /api/agent/rooms/invite, POST
// /api/agent/rooms/remove, POST /api/agent/rooms/leave, DELETE /api/agent).
// Every state of the view,
// each at desktop and phone width, light and dark, with a screenshot
// (keys-<state>-<desktop|phone>-<light|dark>.png); then what the view must
// never do: ask a room more than a look, store anything on the device, keep
// a key past Done, leaving the view, a disconnect or pagehide (the last two
// checked within the event itself), reuse a seat that exists without a
// pause, say the agent is a member of a room that refused the key, or
// render a name from the server as markup; and the dialogs' keyboard paths.
// The server's sentences in the fixtures come from the Worker's own
// functions (worker/agents/onboarding.ts), so they cannot drift.
const { chromium, installClock, settle, trackNetwork, shot, must, failed, done, badConsole, HTML, DIST, ICON_PNG, NOW, D } = require('./harness');

const ORIGIN = 'https://chat.victorio.cloud';
const KEY = '.ac1.k7Q2mZp9X4vB1nW8cR5tYa.Hq3Lx8Zr2Vn6Bt0Wk4Sd9Fg1Jc7Pm5Ye3Ua6Io2Nb8X';
const ROOMS = {
  'family-trip': 'tok_family0000000000000000',
  'book-club': 'tok_book000000000000000000',
  'work-notes': 'tok_work000000000000000000',
  'old-room': 'tok_old0000000000000000000',
  'gone-room': 'tok_gone000000000000000000',
  'flaky-room': 'tok_flaky00000000000000000',
};
const PERSON = (name) => ({ name: name || 'Anthony', kind: 'human' });
// what GET /invite says of each token: a person's or an agent's invite, or a refusal status
const LOOKS = {
  tok_family0000000000000000: PERSON(),
  tok_book000000000000000000: PERSON(),
  tok_work000000000000000000: { name: 'Probe', kind: 'agent' },
  tok_old0000000000000000000: 403,
  tok_gone000000000000000000: 404,
  tok_flaky00000000000000000: 500,
};
// the server's sentences, from the Worker's own functions (worker/agents/onboarding.ts), loaded below
let W, HANDOFF, LINE, SETTINGS, NOTE, MADE;
const INFO = {
  rooms: [
    { room: 'family-trip', name: 'Scout', added: NOW - 3 * D, state: 'held', muse_wake: true },
    { room: 'book-club', name: 'Scout', added: NOW - 3 * D, state: 'held' },
    { room: 'old-room', name: 'Scout', added: NOW - 9 * D, state: 'refused', code: 'invite_revoked', at: NOW - 2 * D },
  ],
  max_rooms: 30,
  created: NOW - 9 * D,
};
let DROP_LEFT;
const newSeats = (body) => ({ ok: true, rooms: body.rooms.map((e) => ({ room: e.room, name: e.name || body.name, seat: 'new', opened: false })) });
const VARIANTS = [
  { tag: 'desktop-light', w: 1280, h: 1000, scheme: 'light' },
  { tag: 'desktop-dark', w: 1280, h: 1000, scheme: 'dark' },
  { tag: 'phone-light', w: 390, h: 844, scheme: 'light', touch: true },
  { tag: 'phone-dark', w: 390, h: 844, scheme: 'dark', touch: true },
];

/**
 * One scenario on a page of its own, through the fake API.
 * o.rooms: the rooms this browser holds (room -> token); o.api: the route
 * answers ({invite(body, ctx), info(ctx), add(body, ctx), remove(body, ctx),
 * leave(body, ctx), drop(ctx), looks}); fn(page, S) runs it. S.calls lists every API request
 * (method, path, the credential headers), S.store the device's storage keys
 * before the view ran.
 */
async function scenario(name, o, fn) {
  if (process.env.ONLY && !process.env.ONLY.split(',').includes(name)) return;
  const b = await chromium.launch({});
  const ctx = await b.newContext({ serviceWorkers: 'block', viewport: { width: o.w || 1280, height: o.h || 1000 }, colorScheme: o.scheme || 'light', hasTouch: !!o.touch, isMobile: !!o.touch, timezoneId: 'UTC', locale: 'en-US', permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await ctx.newPage();
  await installClock(page);
  trackNetwork(page);
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
  const S = { calls: [], unhandled: [], holds: [] };
  const api = o.api || {};
  const looks = Object.assign({}, LOOKS, api.looks || {});
  await page.route(ORIGIN + '/**', async (route) => {
    const rq = route.request();
    const u = new URL(rq.url());
    const p = u.pathname, m = rq.method();
    const J = (body, status, headers) => route.fulfill({ status: status || 200, contentType: 'application/json', headers: headers || {}, body: JSON.stringify(body) });
    if (p === '/' || p === '/index.html') return route.fulfill({ status: 200, contentType: 'text/html', body: HTML });
    if (p === '/api/build') return J({ build: 'uitestbuild1' });
    if (p.startsWith('/assets/')) { try { return route.fulfill({ status: 200, contentType: p.endsWith('.css') ? 'text/css' : 'text/javascript', body: require('fs').readFileSync(DIST + p) }); } catch { return route.fulfill({ status: 404, body: 'nf' }); } }
    if (p.startsWith('/icons/')) return route.fulfill({ status: 200, contentType: 'image/png', body: ICON_PNG });
    const h = rq.headers();
    let body = null;
    try { body = rq.postData() ? JSON.parse(rq.postData()) : null; } catch { body = rq.postData(); }
    S.calls.push({ m, p, auth: h.authorization || '', token: h['x-invite-token'] || '', body });
    const lm = /^\/api\/rooms\/([^/]+)\/invite$/.exec(p);
    if (lm && m === 'GET') {
      const v = looks[h['x-invite-token']];
      if (v === 'hold') { await new Promise((r) => S.holds.push(r)); return J({ error: 'held' }, 500); }
      if (typeof v === 'number') return J({ error: v === 404 ? 'No room with that name yet. Create it from the home page.' : v === 403 ? 'This invite link has been revoked. Ask whoever gave it to you for a new one.' : 'upstream connect error' }, v);
      if (!v) return J({ error: "This invite link isn't valid for this room." }, 403);
      return J({ room: decodeURIComponent(lm[1]), invite: { name: v.name, kind: v.kind, status: 'active', invited_by: null, invited: NOW - 30 * D, joined: NOW - 29 * D }, purpose: null, members: [], opened: true });
    }
    const call = async (fnName, ...a) => {
      const f = api[fnName];
      if (!f) { S.unhandled.push(m + ' ' + p); return J({ error: 'not stubbed' }, 500); }
      const out = await f(...a, S);
      if (out === 'network') return route.abort('failed');
      return J(out.body, out.status, out.headers);
    };
    if (p === '/api/agents/invite' && m === 'POST') return call('invite', body);
    if (p === '/api/agent' && m === 'GET') return call('info');
    if (p === '/api/agent/rooms/invite' && m === 'POST') return call('add', body);
    if (p === '/api/agent/rooms/remove' && m === 'POST') return call('remove', body);
    if (p === '/api/agent/rooms/leave' && m === 'POST') return call('leave', body);
    if (p === '/api/agent' && m === 'DELETE') return call('drop');
    S.unhandled.push(m + ' ' + p);
    return route.fulfill({ status: 404, body: 'nf' });
  });
  const rooms = o.rooms === undefined ? ROOMS : o.rooms;
  // each room with its cached name, as a device that opened it has (so Your rooms asks nothing itself)
  await page.addInitScript((r) => {
    try {
      if (!sessionStorage.getItem('seeded')) {
        sessionStorage.setItem('seeded', '1');
        for (const [room, tok] of Object.entries(r)) { localStorage.setItem('chat-invite:' + room, tok); localStorage.setItem('chat-you:' + room, 'Anthony'); }
      }
    } catch { /* the scenario fails visibly */ }
  }, rooms);
  let out = null;
  try {
    await page.goto(ORIGIN + '/#keys');
    await page.waitForSelector('#view-keys', { timeout: 10000 });
    if (!o.noSettle) await settle(page);
    S.store = await page.evaluate(() => Object.keys(localStorage).sort());
    out = await fn(page, S);
    for (const r of S.holds) r();
    const fatal = errs.filter((e) => !e.startsWith('console:'));
    if (fatal.length) throw new Error('uncaught page errors: ' + JSON.stringify(fatal));
    if (S.unhandled.length) throw new Error('requests the stub does not handle: ' + JSON.stringify(S.unhandled));
    const cons = badConsole(errs, o.allowConsole);
    if (cons.length) throw new Error('console errors: ' + JSON.stringify(cons));
    // the view asks the rooms only their look, and stores nothing on the device
    const other = S.calls.filter((c) => !(/^\/api\/rooms\/[^/]+\/invite$/.test(c.p) && c.m === 'GET') && !/^\/api\/agents?(\/|$)/.test(c.p));
    if (other.length) throw new Error('the view asked something beyond the looks and the agent routes: ' + JSON.stringify(other.map((c) => c.m + ' ' + c.p)));
    const store = await page.evaluate(() => Object.keys(localStorage).sort().concat(Object.keys(sessionStorage).filter((k) => k !== 'seeded').map((k) => 'session:' + k))).catch(() => S.store);
    if (JSON.stringify(store) !== JSON.stringify(S.store)) throw new Error('the view wrote to the device\'s storage: ' + JSON.stringify(store));
    const stored = await page.evaluate(() => JSON.stringify(Object.entries(localStorage))).catch(() => '');
    if (stored.includes('.ac1.')) throw new Error('a key reached localStorage');
    console.log('PASS ' + name + (out ? ' ' + JSON.stringify(out) : ''));
  } catch (e) {
    failed();
    console.log('FAIL ' + name + ': ' + (e && e.message ? String(e.message).split('\n')[0] : String(e)));
  } finally {
    for (const r of S.holds) r();
    await b.close();
  }
}

/** Every variant of one state: its own scenario and screenshot each. */
async function state(id, o, fn, target) {
  for (const v of VARIANTS) {
    await scenario('keys-' + id + '-' + v.tag, { ...o, w: v.w, h: v.h, scheme: v.scheme, touch: v.touch }, async (page, S) => {
      const r = await fn(page, S, v);
      await page.evaluate((sel) => { const el = document.querySelector(sel); if (el) el.scrollIntoView({ block: 'start' }); }, target || '#view-keys .page-title');
      await page.evaluate(() => new Promise((r2) => requestAnimationFrame(() => requestAnimationFrame(r2))));
      await shot(page, 'keys-' + id + '-' + v.tag + '.png');
      return r;
    });
  }
}

/** true once fn() is, polled; false after ms */
const until = async (fn, ms = 5000) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await new Promise((r) => setTimeout(r, 20)); } return !!fn(); };
// the text as it reads (innerText: blocks apart, as a screen reader hears them)
const text = (page, sel) => page.$eval(sel, (e) => e.innerText.replace(/\s+/g, ' ').trim());
const row = (page, list, room) => page.$eval('#' + list + ' li[data-room="' + room + '"]', (e) => e.innerText.replace(/\s+/g, ' ').trim());
const tick = (page, list, room) => page.click('#' + list + ' li[data-room="' + room + '"] .key-pick input');
const paste = async (page, value) => {
  await page.fill('#keyPaste', value);
  await page.click('#keyOpen button[type=submit]');
};
// a person's rooms only, for the scenarios that make or manage a key
const MINE = { 'family-trip': ROOMS['family-trip'], 'book-club': ROOMS['book-club'] };
const OPEN = { info: async () => ({ body: INFO }) };

/** The Worker's text functions, through the unit tests' module hooks (TypeScript, and its .js imports). */
async function worker() {
  const { register } = require('node:module');
  const { pathToFileURL } = require('node:url');
  const root = require('path').join(__dirname, '..', '..', '..');
  register(pathToFileURL(root + '/tests/unit/txt-hooks.mjs').href, pathToFileURL(__filename));
  const on = await import(pathToFileURL(root + '/worker/agents/onboarding.ts').href);
  const ak = await import(pathToFileURL(root + '/worker/lib/agentkey.ts').href);
  return { ...on, AGENT_UNREADABLE: ak.AGENT_UNREADABLE };
}

(async () => {
  W = await worker();
  HANDOFF = W.personKeyHandoff(ORIGIN, ['family-trip', 'book-club']);
  LINE = W.claudeCodeLine(ORIGIN + '/api/mcp');
  SETTINGS = W.mcpJsonEntry(ORIGIN + '/api/mcp');
  NOTE = W.personKeyNote(true);
  MADE = { key: KEY, address: ORIGIN + '/api/mcp', rooms: [{ room: 'family-trip', name: 'Scout', opened: false, seat: 'new' }, { room: 'book-club', name: 'Scout', opened: false, seat: 'reused' }], max_rooms: 30, claude_code: LINE, mcp_json: SETTINGS, handoff: HANDOFF, note: NOTE };
  DROP_LEFT = { deleted: true, rooms: ['family-trip', 'book-club', 'old-room'], muse_wakes_removed: ['book-club'], muse_wakes_left: ['family-trip'], note: W.dropNote(['family-trip']) };

  // ---- section 1: make a key ----
  await state('empty', { rooms: {} }, async (page) => {
    must(/This browser holds none of your rooms yet\. Open one of your invite links here first; then you can make a key for an agent in that room\./.test(await text(page, '#keyEmpty')), 'the empty device\'s sentence');
    must(!(await page.$('#keyName')), 'no form on an empty device');
    must(/One key lets an agent use several of your rooms through one connection\..*so the site never gives the agent a new seat's own link \(a person in the room can still see it in the members list\)\. Where it reuses a seat the agent already had, anyone you gave that invite's link can still use it, and so can another key that holds that seat\./.test(await text(page, '#view-keys .lede')), 'the lede, with the reused seat\'s exception and the members list');
  });
  await state('rooms', { rooms: { ...ROOMS, 'slow-room': 'tok_slow' }, api: { looks: { tok_slow: 'hold' } }, noSettle: true }, async (page) => {
    await page.waitForFunction(() => /Couldn't check/.test(document.querySelector('#keyRooms')?.textContent || ''), null, { timeout: 8000 });
    await page.waitForFunction(() => [...document.querySelectorAll('#keyRooms li')].filter((li) => /as Anthony/.test(li.textContent)).length === 2, null, { timeout: 8000 });
    const want = {
      'family-trip': 'family-trip as Anthony',
      'work-notes': "work-notes The invite this browser holds here is an agent's.",
      'old-room': "old-room This browser's invite here no longer works.",
      'gone-room': 'gone-room This room no longer exists.',
      'flaky-room': "flaky-room Couldn't check this room; try again. Try again",
      'slow-room': 'slow-room Checking…',
    };
    for (const [room, t] of Object.entries(want)) must((await row(page, 'keyRooms', room)) === t, room + ': ' + (await row(page, 'keyRooms', room)));
    const disabled = await page.$$eval('#keyRooms li', (lis) => lis.map((li) => [li.dataset.room, li.querySelector('input').disabled, li.querySelector('label').textContent.replace(/\s+/g, ' ').trim()]));
    for (const [room, dis, label] of disabled) {
      must(dis === !['family-trip', 'book-club'].includes(room), room + ' disabled ' + dis);
      must(label.startsWith(room), room + ': the label holds the room\'s name and its reason: ' + label);
    }
    must(!(await page.$eval('#keyRooms li[data-room="family-trip"] input', (i) => i.checked)), 'nothing ticked at first');
    must(await page.$eval('#keyGo', (b) => b.disabled), 'Make key waits for a name and a room');
    return { rows: disabled.length };
  }, '#keyRooms');
  await scenario('keys-try-again', { rooms: { 'flaky-room': ROOMS['flaky-room'] }, api: {} }, async (page) => {
    await page.waitForSelector('#keyRooms .key-retry', { timeout: 5000 });
    // the room answers now
    await page.route(ORIGIN + '/api/rooms/flaky-room/invite', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ room: 'flaky-room', invite: { name: 'Anthony', kind: 'human', status: 'active', invited_by: null, invited: NOW, joined: NOW }, purpose: null, members: [], opened: true }) }));
    await page.click('#keyRooms .key-retry');
    await page.waitForFunction(() => /as Anthony/.test(document.querySelector('#keyRooms li')?.textContent || ''), null, { timeout: 5000 });
    must(!(await page.$eval('#keyRooms li input', (i) => i.disabled)), 'enabled once its look passes');
  });
  await state('agents-only', { rooms: { 'work-notes': ROOMS['work-notes'], 'side-room': 'tok_side' }, api: { looks: { tok_side: { name: 'Helper', kind: 'agent' } } } }, async (page) => {
    await page.waitForSelector('#keyAgentsOnly', { timeout: 5000 });
    must((await text(page, '#keyAgentsOnly')) === "Every invite this browser holds is an agent's. A key is made with a person's own invite: open your own invite link here first.", await text(page, '#keyAgentsOnly'));
  });
  await state('name-error', { rooms: MINE, api: {} }, async (page, S) => {
    await page.fill('#keyName', 'Sc<out');
    await tick(page, 'keyRooms', 'family-trip');
    await page.click('#keyGo');
    await page.waitForSelector('#keyNameErr', { timeout: 3000 });
    must((await text(page, '#keyNameErr')) === "Names can't contain < > \" ' & ` or control characters", await text(page, '#keyNameErr'));
    must(await page.$eval('#keyNameErr', (e) => e.getAttribute('role')) === 'alert', 'an error is an alert');
    must(!S.calls.some((c) => c.p === '/api/agents/invite'), 'refused before any request');
    // Referee, and an empty per-room name
    await page.fill('#keyName', 'referee');
    await page.click('#keyGo');
    must((await text(page, '#keyNameErr')).startsWith('"Referee" is a reserved name'), await text(page, '#keyNameErr'));
    await page.fill('#keyName', 'Scout');
    await page.click('#keyRooms li[data-room="family-trip"] .key-room-more .linkbtn');
    await page.click('#keyGo');
    must((await row(page, 'keyRooms', 'family-trip')).includes('Give the agent a name.'), await row(page, 'keyRooms', 'family-trip'));
    await page.fill('#keyRooms li[data-room="family-trip"] .key-own input', 'Sc<out');
    await page.click('#keyGo');
    await page.fill('#keyName', 'Sc<out');
    await page.click('#keyGo');
  });
  await state('check-problems', { rooms: { ...MINE, 'trip-two': 'tok_two', 'trip-three': 'tok_three' }, api: {
    looks: { tok_two: PERSON(), tok_three: PERSON() },
    invite: async () => ({ body: { ok: false, rooms: [
      { room: 'family-trip', name: 'Scout', problem: { status: 409, code: 'name_taken', error: W.nameTakenError('family-trip', 'Scout') } },
      { room: 'book-club', name: 'Scout', problem: { status: 429, code: 'rate_limited', error: W.dayCapError('book-club') } },
      { room: 'trip-two', name: 'Scout', problem: { status: 409, code: 'seat_in_use', error: W.seatInUseError('trip-two', 'Scout') } },
      { room: 'trip-three', name: 'Scout', seat: 'reused', opened: false },
    ] } }),
  } }, async (page, S) => {
    await page.fill('#keyName', 'Scout');
    for (const r of ['family-trip', 'book-club', 'trip-two', 'trip-three']) await tick(page, 'keyRooms', r);
    await page.click('#keyGo');
    await page.waitForSelector('#keyErr', { timeout: 5000 });
    must((await row(page, 'keyRooms', 'family-trip')).includes('Scout is already taken here. Pick another name.') && !(await row(page, 'keyRooms', 'family-trip')).includes('Room "'), 'the problem, without the room prefix: ' + (await row(page, 'keyRooms', 'family-trip')));
    must((await row(page, 'keyRooms', 'book-club')).includes('You can create up to 5 invites a day'), 'the day cap');
    must((await row(page, 'keyRooms', 'trip-two')).includes("Use Scout's seat here (already a member, invited by you)"), 'the seat in use offered');
    must((await row(page, 'keyRooms', 'trip-three')).includes("Uses Scout's unused invite here (invited by you). Anyone you gave that invite's link can still use it, and another key that holds this seat still works for it: disconnecting this key does not cut that one."), 'the unused seat reused, said, with the other key');
    must(S.calls.filter((c) => c.p === '/api/agents/invite').length === 1 && S.calls.find((c) => c.p === '/api/agents/invite').body.check === true, 'one check, no real call');
    const sent = S.calls.find((c) => c.p === '/api/agents/invite').body;
    // in the device's order (Your rooms sorts them by name)
    must(JSON.stringify(sent.rooms.map((e) => e.room)) === '["book-club","family-trip","trip-three","trip-two"]' && sent.rooms.every((e) => /^tok_/.test(e.inviter_token)) && sent.name === 'Scout', JSON.stringify(sent));
    // the seat offered: ticked, the next check sends reuse any for that room
    await page.click('#keyRooms li[data-room="trip-two"] .key-seat input');
    await page.click('#keyGo');
    await until(() => S.calls.filter((c) => c.p === '/api/agents/invite').length === 2);
    await page.waitForSelector('#keyErr', { timeout: 5000 });
    await settle(page);
    const second = S.calls.filter((c) => c.p === '/api/agents/invite')[1].body;
    must(second.rooms.find((e) => e.room === 'trip-two').reuse === 'any', JSON.stringify(second.rooms));
    await page.click('#keyRooms li[data-room="trip-two"] .key-seat input');
  }, '#keyRooms');
  await state('full-counter', { rooms: MINE, api: { invite: async (body) => ({ body: { ...newSeats(body), ok: false, retry_after: 37 * 60 } }) } }, async (page) => {
    await page.fill('#keyName', 'Scout');
    await tick(page, 'keyRooms', 'family-trip');
    await page.click('#keyGo');
    await page.waitForSelector('#keyErr', { timeout: 5000 });
    must((await text(page, '#keyErr')) === 'Too many agent keys were made just now, from this network, for one of these rooms or on the whole site. Try again in 37 minutes.', await text(page, '#keyErr'));
    must(await page.$eval('#keyGo', (b) => b.disabled), 'the button waits');
  }, '#keyRooms');
  await state('made', { rooms: MINE, api: { invite: async (body) => (body.check ? { body: newSeats(body) } : { status: 201, body: MADE }) } }, async (page, S) => {
    await page.fill('#keyName', 'Scout');
    await tick(page, 'keyRooms', 'family-trip');
    await tick(page, 'keyRooms', 'book-club');
    await page.click('#keyGo');
    await page.waitForSelector('#keyMade', { timeout: 5000 });
    must(await page.evaluate(() => document.activeElement && document.activeElement.id === 'keyMade'), 'focus goes to the key\'s card');
    must((await text(page, '#keyMadeTitle')) === "Scout's agent key", await text(page, '#keyMadeTitle'));
    must(await page.$eval('#keyMadeKey', (i) => i.value) === KEY && await page.$eval('#keyMadeKey', (i) => i.readOnly && i.getAttribute('aria-label') === 'Agent key'), 'the key, read-only, labelled');
    must((await text(page, '#keyMadeSettings')).includes('"Authorization": "Bearer ' + KEY + '"') && !(await text(page, '#keyMadeSettings')).includes('Bearer KEY'), 'the settings with the key filled in');
    must((await text(page, '#keyMadeLine')) === 'claude mcp add --transport http agent-chat ' + ORIGIN + '/api/mcp --header "Authorization: Bearer ' + KEY + '"', 'the one line');
    must(/Or add it with one line\. The line stays in your shell's history\./.test(await text(page, '#keyMade')), 'the history caution beside the line');
    must((await text(page, '#keyMadeMuse')) === 'In Muse, ask it to add a custom connector for ' + ORIGIN + '/api/mcp, then paste the key into the "API Key" box it shows, never into the chat.', 'the Muse line');
    // the hand-off goes into a chat: it keeps the word KEY, and its line says where the key itself goes
    must((await text(page, '#keyMadeHandoff')) === HANDOFF && !(await text(page, '#keyMadeHandoff')).includes(KEY), 'the hand-off as the answer gives it, without the key');
    must((await text(page, '#keyMadeHandoffHint')) === "Send this to your agent in a chat. It says KEY where the key goes: the key itself goes only into the agent's MCP settings or its secure credential field, never into a chat.", 'the hand-off\'s line');
    must(JSON.stringify(await page.$$eval('#keyMadeRooms li', (l) => l.map((x) => x.textContent.replace(/\s+/g, ' ').trim()))) === JSON.stringify(['family-trip as Scout new invite', 'book-club as Scout existing seat']), 'the rooms');
    must((await text(page, '#keyMadeNote')) === MADE.note, 'the note');
    const calls = S.calls.filter((c) => c.p === '/api/agents/invite');
    must(calls.length === 2 && calls[0].body.check === true && !('check' in calls[1].body), 'the check, then the call at once');
    must(calls.every((c) => !c.auth), 'no key sent to make one');
    // Copy: what each button puts on the clipboard (the clipboard recorded here)
    await page.evaluate(() => {
      window.__copied = [];
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: (t) => { window.__copied.push(t); return Promise.resolve(); } } });
    });
    for (const id of ['keyMadeCopyKey', 'keyMadeCopySettings', 'keyMadeCopyLine', 'keyMadeCopyHandoff']) await page.click('#' + id);
    const copied = await page.evaluate(() => window.__copied);
    must(copied.length === 4 && copied[0] === KEY, 'the key copied: ' + copied.length);
    must(copied[1] === SETTINGS.split('Bearer KEY').join('Bearer ' + KEY), 'the settings copied with the key');
    must(copied[2] === LINE.split('Bearer KEY').join('Bearer ' + KEY), 'the one line copied with the key');
    must(copied[3] === HANDOFF && !copied[3].includes(KEY), 'the hand-off copied without the key');
    await page.waitForFunction(() => /Copied|Couldn't copy/.test(document.getElementById('toast')?.textContent || ''), null, { timeout: 3000 });
    must(!page.url().includes('.ac1.'), 'the key is in no URL');
  }, '#keyMade');
  await state('made-end', { rooms: MINE, api: { invite: async (body) => (body.check ? { body: newSeats(body) } : { status: 201, body: MADE }) } }, async (page) => {
    await page.fill('#keyName', 'Scout');
    await tick(page, 'keyRooms', 'family-trip');
    await tick(page, 'keyRooms', 'book-club');
    await page.click('#keyGo');
    await page.waitForSelector('#keyMade', { timeout: 5000 });
    must(await page.$eval('#keyMadeDone', (b) => b.textContent === 'Done'), 'a Done button');
  }, '#keyMadeHandoff');
  // a seat that already exists is never reused silently: the check pauses, says so by the button, and the next tap goes ahead
  const REUSE_CHECK = (body) => ({ body: { ok: true, rooms: body.rooms.map((e) => (e.room === 'book-club' ? { room: e.room, name: e.name || body.name, seat: 'reused', opened: false } : { room: e.room, name: e.name || body.name, seat: 'new', opened: false })) } });
  await state('reuse-pause', { rooms: MINE, api: { invite: async (body) => (body.check ? REUSE_CHECK(body) : { status: 201, body: MADE }) } }, async (page, S) => {
    await page.fill('#keyName', 'Scout');
    await tick(page, 'keyRooms', 'family-trip');
    await tick(page, 'keyRooms', 'book-club');
    await page.click('#keyGo');
    await page.waitForSelector('#keyReuse', { timeout: 5000 });
    must((await text(page, '#keyReuse')) === 'book-club reuses a seat that already exists. Another key that holds such a seat keeps working for it. Make key goes ahead.', await text(page, '#keyReuse'));
    must(await page.$eval('#keyReuse', (e) => e.getAttribute('role') === 'status'), 'said to a screen reader');
    must((await row(page, 'keyRooms', 'book-club')).includes("Uses Scout's unused invite here (invited by you). Anyone you gave that invite's link can still use it, and another key that holds this seat still works for it: disconnecting this key does not cut that one."), 'the room\'s own line');
    const calls = S.calls.filter((c) => c.p === '/api/agents/invite');
    must(calls.length === 1 && calls[0].body.check === true, 'the check only: no key made yet');
    must(!(await page.$('#keyMade')) && await page.$eval('#keyGo', (b) => !b.disabled), 'Make key, still there to go ahead');
  }, '#keyRooms');
  await scenario('keys-reuse-goes-ahead', { rooms: MINE, api: { invite: async (body) => (body.check ? REUSE_CHECK(body) : { status: 201, body: MADE }) } }, async (page, S) => {
    await page.fill('#keyName', 'Scout');
    await tick(page, 'keyRooms', 'family-trip');
    await tick(page, 'keyRooms', 'book-club');
    await page.click('#keyGo');
    await page.waitForSelector('#keyReuse', { timeout: 5000 });
    // any change checks again, and pauses again
    await page.fill('#keyName', 'Scouts');
    must(!(await page.$('#keyReuse')), 'the pause goes with a change');
    await page.click('#keyGo');
    await page.waitForSelector('#keyReuse', { timeout: 5000 });
    must(S.calls.filter((c) => c.p === '/api/agents/invite' && c.body.check === true).length === 2, 'checked again');
    // the next tap, nothing changed: the key, with no second check
    await page.click('#keyGo');
    await page.waitForSelector('#keyMade', { timeout: 5000 });
    const calls = S.calls.filter((c) => c.p === '/api/agents/invite');
    must(calls.length === 3 && !('check' in calls[2].body) && calls[2].body.name === 'Scouts', 'the call itself, as checked: ' + JSON.stringify(calls.map((c) => c.body.check)));
    must((await text(page, '#keyMadeShared')) === 'An existing seat may be held by another key too: that key still works for it, and disconnecting this one does not cut it.', await text(page, '#keyMadeShared'));
    must((await text(page, '#keyMadeNote')).endsWith(W.SEAT_SHARED), 'the note says the same');
  });
  await scenario('keys-add-pause', { rooms: { ...MINE, 'trip-two': 'tok_two' }, api: { ...OPEN, looks: { tok_two: PERSON() }, add: async (body) => (body.check ? { body: { ok: true, rooms: [{ room: 'trip-two', name: 'Scout', seat: 'reused', opened: false }] } } : { status: 201, body: { rooms: [{ room: 'trip-two', name: 'Scout', opened: false, seat: 'reused' }], rooms_held: 4 } }) } }, async (page, S) => {
    await paste(page, KEY);
    await page.waitForSelector('#keyAddRooms', { timeout: 5000 });
    await tick(page, 'keyAddRooms', 'trip-two');
    await page.click('#keyAdd');
    await page.waitForSelector('#keyAddReuse', { timeout: 5000 });
    must((await text(page, '#keyAddReuse')) === 'trip-two reuses a seat that already exists. Another key that holds such a seat keeps working for it. Add rooms goes ahead.', await text(page, '#keyAddReuse'));
    await page.click('#keyAdd');
    await page.waitForFunction(() => /Added: trip-two\./.test(document.getElementById('keyHeldSay')?.textContent || ''), null, { timeout: 5000 });
    const adds = S.calls.filter((c) => c.p === '/api/agent/rooms/invite');
    must(adds.length === 2 && adds[0].body.check === true && !('check' in adds[1].body), 'one check, then the call');
  });
  await state('left-unused', { rooms: MINE, api: { invite: async (body) => (body.check ? { body: newSeats(body) } : { status: 409, body: { error: W.nameTakenError('book-club', 'Scout'), code: 'name_taken', room: 'book-club', left_unused: ['family-trip'], note: W.unusedNote(['family-trip']) } }) } }, async (page) => {
    await page.fill('#keyName', 'Scout');
    await tick(page, 'keyRooms', 'family-trip');
    await tick(page, 'keyRooms', 'book-club');
    await page.click('#keyGo');
    await page.waitForSelector('#keyErr', { timeout: 5000 });
    must((await text(page, '#keyErr')) === 'No key was made. ' + W.unusedNote(['family-trip']), await text(page, '#keyErr'));
    must(W.unusedNote(['family-trip']) === 'The invite this call made in family-trip stays unused, and trying again with the same name uses it.', 'the note as the Worker words it');
    must((await row(page, 'keyRooms', 'book-club')).includes('Scout is already taken here. Pick another name.'), 'the refusal on its room');
    must(!(await page.$('#keyMade')), 'no key');
  }, '#keyRooms');
  await state('nothing-kept', { rooms: MINE, api: { invite: async (body) => (body.check ? { body: newSeats(body) } : { status: 429, body: { error: W.activeCapError('family-trip'), code: 'limit_reached', room: 'family-trip' } }) } }, async (page) => {
    await page.fill('#keyName', 'Scout');
    await tick(page, 'keyRooms', 'family-trip');
    await page.click('#keyGo');
    await page.waitForSelector('#keyErr', { timeout: 5000 });
    must((await text(page, '#keyErr')) === 'Nothing was kept.', await text(page, '#keyErr'));
    must((await row(page, 'keyRooms', 'family-trip')).includes(W.activeCapError('family-trip').replace('Room "family-trip": ', '')), 'on its room');
  }, '#keyRooms');
  // a room the check called new is made new or not at all: the call says reuse none there, so a seat of that
  // name that appeared since the check is the room's refusal, shown on it, never a silent reuse
  await state('seat-appeared', { rooms: MINE, api: { invite: async (body) => (body.check ? { body: newSeats(body) } : { status: 409, body: { error: W.nameTakenError('book-club', 'Scout'), code: 'name_taken', room: 'book-club' } }) } }, async (page, S) => {
    await page.fill('#keyName', 'Scout');
    await tick(page, 'keyRooms', 'family-trip');
    await tick(page, 'keyRooms', 'book-club');
    await page.click('#keyGo');
    await page.waitForSelector('#keyErr', { timeout: 5000 });
    const calls = S.calls.filter((c) => c.p === '/api/agents/invite');
    must(calls.length === 2 && calls[0].body.check === true && !('check' in calls[1].body), 'the check, then the call');
    must(calls[0].body.rooms.every((e) => !('reuse' in e)), 'the check asks as the person chose: ' + JSON.stringify(calls[0].body.rooms));
    must(calls[1].body.rooms.length === 2 && calls[1].body.rooms.every((e) => e.reuse === 'none'), 'every room the check called new is sent reuse none: ' + JSON.stringify(calls[1].body.rooms));
    must((await text(page, '#keyErr')) === 'Nothing was kept.', await text(page, '#keyErr'));
    must((await row(page, 'keyRooms', 'book-club')).includes('Scout is already taken here. Pick another name.'), 'the refusal on its room: ' + (await row(page, 'keyRooms', 'book-club')));
    must(!(await page.$('#keyMade')), 'no key');
  }, '#keyRooms');
  await scenario('keys-add-seat-appeared', { rooms: { ...MINE, 'trip-two': 'tok_two' }, api: { ...OPEN, looks: { tok_two: PERSON() }, add: async (body) => (body.check ? { body: newSeats(body) } : { status: 409, body: { error: W.nameTakenError('trip-two', 'Scout'), code: 'name_taken', room: 'trip-two' } }) } }, async (page, S) => {
    await paste(page, KEY);
    await page.waitForSelector('#keyAddRooms', { timeout: 5000 });
    await tick(page, 'keyAddRooms', 'trip-two');
    await page.click('#keyAdd');
    await until(() => S.calls.filter((c) => c.p === '/api/agent/rooms/invite').length === 2);
    await page.waitForFunction(() => /already taken here/.test(document.getElementById('keyAddRooms')?.textContent || ''), null, { timeout: 5000 });
    const adds = S.calls.filter((c) => c.p === '/api/agent/rooms/invite');
    must(adds[1].body.rooms.length === 1 && adds[1].body.rooms[0].reuse === 'none', 'the add sends reuse none too: ' + JSON.stringify(adds[1].body.rooms));
  });
  // the room's answer to an invite was lost, and the look after it could not tell: never "nothing was kept"
  await state('maybe-made', { rooms: MINE, api: { invite: async (body) => (body.check ? { body: newSeats(body) } : { status: 500, body: { error: 'Room "family-trip" could not be reached, so no key was made. Try again.', room: 'family-trip', maybe_unused: ['family-trip'], note: W.unusedNote([], ['family-trip']) } }) } }, async (page) => {
    await page.fill('#keyName', 'Scout');
    await tick(page, 'keyRooms', 'family-trip');
    await page.click('#keyGo');
    await page.waitForSelector('#keyErr', { timeout: 5000 });
    must((await text(page, '#keyErr')) === 'No key was made. An invite may have been made in family-trip: the room\'s answer was lost. Trying again with the same name uses it if so.', await text(page, '#keyErr'));
    must((await row(page, 'keyRooms', 'family-trip')).includes('could not be reached, so no key was made. Try again.'), 'the refusal on its room');
  }, '#keyRooms');
  await state('network-lost', { rooms: MINE, api: { invite: async (body) => (body.check ? { body: newSeats(body) } : 'network') }, allowConsole: /Failed to load resource|ERR_FAILED/ }, async (page) => {
    await page.fill('#keyName', 'Scout');
    await tick(page, 'keyRooms', 'family-trip');
    await page.click('#keyGo');
    await page.waitForSelector('#keyErr', { timeout: 5000 });
    must((await text(page, '#keyErr')) === "Couldn't reach the site, so this page can't tell whether the key was made. If it was, it is lost: nobody can see it again. Making the key again with the same name uses the same seats.", await text(page, '#keyErr'));
  }, '#keyRooms');

  // ---- section 2: a key you hold ----
  await state('paste-error', { rooms: MINE, api: {} }, async (page, S) => {
    await paste(page, 'https://chat.victorio.cloud/r/family-trip#invite=tok_family0000000000000000');
    must((await text(page, '#keyHeldErr')) === 'That is a room invite link or token, not an agent key.', await text(page, '#keyHeldErr'));
    await paste(page, '.ac2.not-a-key');
    must((await text(page, '#keyHeldErr')) === 'That is not an agent key: one starts with .ac1. and is 71 characters long.', await text(page, '#keyHeldErr'));
    must(!S.calls.some((c) => c.p === '/api/agent'), 'checked here first: no request');
    must(!(await page.$('#keyFinish')), 'a key that is not well formed is offered no DELETE');
    must(await page.$eval('#keyPaste', (i) => i.type === 'text' && i.autocomplete === 'off' && i.spellcheck === false && i.getAttribute('autocapitalize') === 'off'), 'the field offers no saving');
  }, '#keyHeld');
  await state('unreadable', { rooms: MINE, api: { info: async () => ({ status: 500, body: { error: W.AGENT_UNREADABLE, code: 'agent_unreadable' } }) } }, async (page) => {
    await paste(page, KEY);
    await page.waitForSelector('#keyHeldErr', { timeout: 5000 });
    must((await text(page, '#keyHeldErr')) === "This key's record could not be read, so its rooms can't be shown. The key itself was not refused.", await text(page, '#keyHeldErr'));
  }, '#keyHeld');
  await scenario('keys-open-network', { rooms: MINE, api: { info: async () => 'network' }, allowConsole: /Failed to load resource|ERR_FAILED/ }, async (page) => {
    await paste(page, KEY);
    await page.waitForSelector('#keyHeldErr', { timeout: 5000 });
    must((await text(page, '#keyHeldErr')) === "Couldn't reach the site; try again.", await text(page, '#keyHeldErr'));
  });
  await scenario('keys-open-busy', { rooms: MINE, api: { info: async () => ({ status: 503, headers: { 'Retry-After': '1' }, body: { error: 'This key is busy; try again.', code: 'try_again' } }) } }, async (page) => {
    await paste(page, KEY);
    await page.waitForSelector('#keyHeldErr', { timeout: 5000 });
    must((await text(page, '#keyHeldErr')) === 'This key was busy with another change; try again.', await text(page, '#keyHeldErr'));
  });
  await state('opened', { rooms: { ...MINE, 'trip-two': 'tok_two' }, api: { ...OPEN, looks: { tok_two: PERSON() } } }, async (page, S) => {
    await paste(page, KEY);
    await page.waitForSelector('#keyOpened', { timeout: 5000 });
    must((await text(page, '#keyMeta')) === 'Made Nov 11 · 3 of 30 rooms', await text(page, '#keyMeta'));
    must((await row(page, 'keyHeldRooms', 'family-trip')) === "family-trip as Scout, added Nov 17 On this key Muse wake set up with this key Take off this key Leave this room", await row(page, 'keyHeldRooms', 'family-trip'));
    must((await row(page, 'keyHeldRooms', 'book-club')) === 'book-club as Scout, added Nov 17 On this key Take off this key Leave this room', await row(page, 'keyHeldRooms', 'book-club'));
    must((await row(page, 'keyHeldRooms', 'old-room')) === "old-room as Scout, added Nov 11 This room no longer takes the key's invite (revoked, or the agent left) since Nov 18 Take off this key", await row(page, 'keyHeldRooms', 'old-room'));
    // Add rooms lists the rooms not on the key, the name filled in
    must(JSON.stringify(await page.$$eval('#keyAddRooms li', (l) => l.map((x) => x.dataset.room))) === '["trip-two"]', 'the rooms not on the key');
    must(await page.$eval('#keyAddName', (i) => i.value) === 'Scout', 'the name on the key');
    const get = S.calls.find((c) => c.p === '/api/agent');
    must(get.auth === 'Bearer ' + KEY, 'the key as Authorization: Bearer');
  }, '#keyHeld');
  await state('added', { rooms: { ...MINE, 'trip-two': 'tok_two' }, api: { looks: { tok_two: PERSON() }, info: async (S) => ({ body: S.added ? { ...INFO, rooms: INFO.rooms.concat([{ room: 'trip-two', name: 'Scout', added: NOW, state: 'held' }]) } : INFO }), add: async (body, S) => { if (body.check) return { body: newSeats(body) }; S.added = true; return { status: 201, body: { rooms: [{ room: 'trip-two', name: 'Scout', opened: false, seat: 'new' }], rooms_held: 4 } }; } } }, async (page, S) => {
    await paste(page, KEY);
    await page.waitForSelector('#keyAddRooms', { timeout: 5000 });
    await tick(page, 'keyAddRooms', 'trip-two');
    // the held key's live region takes no room while it has nothing to say (the making
    // card's keeps its margin above its button); once it speaks it has its margin
    const margins = () => page.evaluate(() => ['keySay', 'keyHeldSay'].map((id) => { const e = document.getElementById(id); return e ? getComputedStyle(e).marginTop + '/' + e.getBoundingClientRect().height : 'none'; }));
    must(JSON.stringify(await margins()) === JSON.stringify(['8px/0', '0px/0']), 'the empty live regions: ' + JSON.stringify(await margins()));
    await page.click('#keyAdd');
    await page.waitForFunction(() => /Added: trip-two\./.test(document.getElementById('keyHeldSay')?.textContent || ''), null, { timeout: 5000 });
    must((await margins())[1].startsWith('8px/'), 'the live region keeps its margin once it speaks: ' + JSON.stringify(await margins()));
    await page.waitForFunction(() => !!document.querySelector('#keyHeldRooms li[data-room="trip-two"]'), null, { timeout: 5000 });
    const adds = S.calls.filter((c) => c.p === '/api/agent/rooms/invite');
    must(adds.length === 2 && adds[0].body.check === true && adds.every((c) => c.auth === 'Bearer ' + KEY) && adds[1].body.rooms[0].inviter_token === 'tok_two', JSON.stringify(adds.map((c) => c.body)));
  }, '#keyHeldSay');
  await state('full-key', { rooms: { ...MINE, 'trip-two': 'tok_two' }, api: { looks: { tok_two: PERSON() }, info: async () => ({ body: { rooms: Array.from({ length: 30 }, (_, i) => ({ room: 'room-' + i, name: 'Scout', added: NOW - D, state: 'held' })), max_rooms: 30, created: NOW - 2 * D } }) } }, async (page) => {
    await paste(page, KEY);
    await page.waitForSelector('#keyFull', { timeout: 5000 });
    must((await text(page, '#keyFull')) === 'This key holds the most rooms it can (30): take one off before you add another.', await text(page, '#keyFull'));
    must(!(await page.$('#keyAdd')), 'no Add rooms button');
  }, '#keyFull');
  await state('takeoff-dialog', { rooms: MINE, api: OPEN }, async (page) => {
    await paste(page, KEY);
    await page.waitForSelector('#keyOpened', { timeout: 5000 });
    await page.click('#keyHeldRooms li[data-room="family-trip"] button');
    await page.waitForSelector('#keyOffDlg[open]', { timeout: 3000 });
    must((await text(page, '#keyOffTitle')) === 'Take family-trip off this key?', await text(page, '#keyOffTitle'));
    must((await text(page, '#keyOffDlg')).includes('The key forgets this room. The agent stays a member of family-trip if it still is one: to take it out of family-trip, use Leave this room instead. The Muse wake set up with this key in family-trip is turned off.'), await text(page, '#keyOffDlg'));
    must(!/leave_room/.test(await text(page, '#keyOffDlg')), 'no tool named to a person');
    must(await page.$eval('#keyOffDlg', (d) => d.getAttribute('aria-labelledby') === 'keyOffTitle'), 'labelled by its title');
  });
  await state('takeoff-busy', { rooms: MINE, api: { ...OPEN, remove: async () => ({ status: 503, headers: { 'Retry-After': '1' }, body: { error: W.wakeNotSettled('family-trip'), code: 'try_again', room: 'family-trip' } }) } }, async (page) => {
    await paste(page, KEY);
    await page.waitForSelector('#keyOpened', { timeout: 5000 });
    await page.click('#keyHeldRooms li[data-room="family-trip"] button');
    await page.waitForSelector('#keyOffDlg[open]', { timeout: 3000 });
    await page.click('#keyOffYes');
    await page.waitForSelector('#keyOffDlg [role=alert]', { timeout: 5000 });
    must((await text(page, '#keyOffDlg [role=alert]')) === W.wakeNotSettled('family-trip'), await text(page, '#keyOffDlg [role=alert]'));
    must(await page.$eval('#keyOffDlg', (d) => d.open), 'the dialog stays open');
  });
  await scenario('keys-takeoff-unreadable', { rooms: MINE, api: { ...OPEN, remove: async () => ({ status: 500, body: { error: W.AGENT_UNREADABLE, code: 'agent_unreadable' } }) } }, async (page) => {
    await paste(page, KEY);
    await page.waitForSelector('#keyOpened', { timeout: 5000 });
    await page.click('#keyHeldRooms li[data-room="family-trip"] button');
    await page.waitForSelector('#keyOffDlg[open]', { timeout: 3000 });
    await page.click('#keyOffYes');
    await page.waitForSelector('#keyOffDlg [role=alert]', { timeout: 5000 });
    must((await text(page, '#keyOffDlg [role=alert]')) === "This key's record could not be read, so its rooms can't be shown. The key itself was not refused.", await text(page, '#keyOffDlg [role=alert]'));
    must(await page.$eval('#keyOffDlg', (d) => d.open) && !!(await page.$('#keyHeldRooms li[data-room="family-trip"]')), 'the dialog stays open, the room on the list');
  });
  // a row that no longer takes the key's invite: its dialog says so, not that the agent stays a member
  await state('takeoff-refused', { rooms: MINE, api: OPEN }, async (page) => {
    await paste(page, KEY);
    await page.waitForSelector('#keyOpened', { timeout: 5000 });
    await page.click('#keyHeldRooms li[data-room="old-room"] button');
    await page.waitForSelector('#keyOffDlg[open]', { timeout: 3000 });
    const t = await text(page, '#keyOffDlg');
    must(t.includes("Take old-room off this key? The key forgets this room, which no longer takes the key's invite (revoked, or the agent left). Nothing else changes there."), t);
    must(!/stays a member/.test(t), 'it does not say the agent stays a member');
  });
  // the same for a refused row whose Muse wake the key recorded: the dialog says that wake is turned off, and nothing contradicts it
  const INFO_REFUSED_WAKE = { ...INFO, rooms: INFO.rooms.map((r) => (r.room === 'old-room' ? { ...r, muse_wake: true } : r)) };
  await state('takeoff-refused-wake', { rooms: MINE, api: { info: async () => ({ body: INFO_REFUSED_WAKE }) } }, async (page) => {
    await paste(page, KEY);
    await page.waitForSelector('#keyOpened', { timeout: 5000 });
    await page.click('#keyHeldRooms li[data-room="old-room"] button');
    await page.waitForSelector('#keyOffDlg[open]', { timeout: 3000 });
    const t = await text(page, '#keyOffDlg');
    must(t.includes("Take old-room off this key? The key forgets this room, which no longer takes the key's invite (revoked, or the agent left), and the Muse wake set up with this key there is turned off."), t);
    must(!/Nothing else changes/.test(t) && !/stays a member/.test(t), 'no "nothing else changes", no seat');
    must((t.match(/Muse wake/g) || []).length === 1, 'said once');
    must((await row(page, 'keyHeldRooms', 'old-room')).includes('Muse wake set up with this key'), 'the row says the key records one there: ' + (await row(page, 'keyHeldRooms', 'old-room')));
  });
  // a take-off while a registration through the key may still reach the room: the room's sentence, the dialog open
  await scenario('keys-takeoff-still-setting', { rooms: MINE, api: { ...OPEN, remove: async () => ({ status: 503, headers: { 'Retry-After': '12' }, body: { error: W.wakeStillSetting('family-trip', 12), code: 'try_again', room: 'family-trip' } }) } }, async (page) => {
    await paste(page, KEY);
    await page.waitForSelector('#keyOpened', { timeout: 5000 });
    await page.click('#keyHeldRooms li[data-room="family-trip"] button');
    await page.waitForSelector('#keyOffDlg[open]', { timeout: 3000 });
    await page.click('#keyOffYes');
    await page.waitForSelector('#keyOffDlg [role=alert]', { timeout: 5000 });
    must((await text(page, '#keyOffDlg [role=alert]')) === 'family-trip may still be reached by a Muse registration through this key whose outcome there is not on the key\'s record yet, so it is still on this key as it was. Try again in 12 seconds.', await text(page, '#keyOffDlg [role=alert]'));
    must(await page.$eval('#keyOffDlg', (d) => d.open) && !!(await page.$('#keyHeldRooms li[data-room="family-trip"]')), 'the dialog stays open, the room on the list');
  });
  await scenario('keys-takeoff-done', { rooms: MINE, api: { info: async (S) => ({ body: S.removed ? { ...INFO, rooms: INFO.rooms.slice(1) } : INFO }), remove: async (body, S) => { S.removed = true; return { body: { room: body.room, removed: true, muse_wake_removed: true, note: 'x' } }; } } }, async (page, S) => {
    await paste(page, KEY);
    await page.waitForSelector('#keyOpened', { timeout: 5000 });
    await page.click('#keyHeldRooms li[data-room="family-trip"] button');
    await page.waitForSelector('#keyOffDlg[open]', { timeout: 3000 });
    await page.click('#keyOffYes');
    await page.waitForFunction(() => /family-trip is off the key\./.test(document.getElementById('toast')?.textContent || ''), null, { timeout: 5000 });
    await page.waitForFunction(() => !document.querySelector('#keyHeldRooms li[data-room="family-trip"]'), null, { timeout: 5000 });
    const rm = S.calls.find((c) => c.p === '/api/agent/rooms/remove');
    must(rm.m === 'POST' && rm.body.room === 'family-trip' && rm.auth === 'Bearer ' + KEY, 'the room in the body, the key in the header');
  });
  // ---- Leave this room: the agent's own leave through the key ----
  /** a key whose rooms are INFO until the leave, then after(rooms) */
  const leaving = (answer, after) => ({
    info: async (S) => ({ body: S.left && after ? { ...INFO, rooms: after(INFO.rooms) } : INFO }),
    leave: async (body, S) => { S.left = true; return typeof answer === 'function' ? answer(body) : answer; },
  });
  const LEFT = (room, kept) => ({ body: { room, name: 'Scout', left: NOW, room_deleted: false, off_key: kept === 'off', ...(kept === 'off' ? {} : { kept }), note: W.leaveNote('Scout', room, kept) } });
  const askLeave = async (page, room) => {
    await paste(page, KEY);
    await page.waitForSelector('#keyOpened', { timeout: 5000 });
    await page.click('#keyHeldRooms li[data-room="' + room + '"] .key-leave');
    await page.waitForSelector('#keyLeaveDlg[open]', { timeout: 3000 });
  };
  /** the leave asked and answered: the dialog closed, and the key's rooms loaded again after the leave */
  const leaveAnswered = async (page, S, room) => {
    await askLeave(page, room);
    await page.click('#keyLeaveYes');
    await page.waitForFunction(() => !document.getElementById('keyLeaveDlg').open, null, { timeout: 5000 });
    await until(() => S.calls.some((c, i) => c.p === '/api/agent' && c.m === 'GET' && i > S.calls.findIndex((x) => x.p === '/api/agent/rooms/leave')));
    await page.waitForFunction(() => !document.querySelector('#keyHeldRooms button[disabled]'), null, { timeout: 5000 });
    const lv = S.calls.filter((c) => c.p === '/api/agent/rooms/leave');
    must(lv.length === 1 && lv[0].m === 'POST' && JSON.stringify(lv[0].body) === JSON.stringify({ room, confirm: room }) && lv[0].auth === 'Bearer ' + KEY, 'one leave, the room and its confirm in the body, the key in the header: ' + JSON.stringify(lv));
    const after = S.calls.findIndex((c) => c.p === '/api/agent/rooms/leave');
    must(S.calls.slice(after + 1).some((c) => c.p === '/api/agent' && c.m === 'GET'), 'the key loaded again after the answer');
  };
  await state('leave-dialog', { rooms: MINE, api: OPEN }, async (page) => {
    await paste(page, KEY);
    await page.waitForSelector('#keyOpened', { timeout: 5000 });
    // on rows the key holds only
    must(!!(await page.$('#keyHeldRooms li[data-room="family-trip"] .key-leave')) && !!(await page.$('#keyHeldRooms li[data-room="book-club"] .key-leave')), 'held rows have Leave this room');
    must(!(await page.$('#keyHeldRooms li[data-room="old-room"] .key-leave')), 'a refused row keeps only Take off this key');
    must((await text(page, '#keyHeldRooms li[data-room="old-room"] .key-row-acts')) === 'Take off this key', await text(page, '#keyHeldRooms li[data-room="old-room"] .key-row-acts'));
    must((await text(page, '#keyHeldRooms li[data-room="book-club"] .key-row-acts')) === 'Take off this key Leave this room', await text(page, '#keyHeldRooms li[data-room="book-club"] .key-row-acts'));
    await page.click('#keyHeldRooms li[data-room="family-trip"] .key-leave');
    await page.waitForSelector('#keyLeaveDlg[open]', { timeout: 3000 });
    must((await text(page, '#keyLeaveTitle')) === 'Have Scout leave family-trip?', await text(page, '#keyLeaveTitle'));
    must((await text(page, '#keyLeaveDlg')) === 'Have Scout leave family-trip? Scout leaves family-trip for good: its invite there stops working, here and on any other key that holds this seat. Matches not yet started that it created or was invited to are called off for everyone, with a line from the Referee; matches under way go on without it, its turns running out on their clocks. Its claimed questions are released, its picture and voice there are removed, a Muse wake or webhook it has there is turned off, and its uploads in flight end. Its messages and reactions stay, and a member of family-trip can invite it anew. family-trip then comes off this key, or stays listed as left if that cannot be finished yet. Cancel Leave room', await text(page, '#keyLeaveDlg'));
    must(await page.$eval('#keyLeaveDlg', (d) => d.getAttribute('aria-labelledby') === 'keyLeaveTitle'), 'labelled by its title');
    must(JSON.stringify(await page.$$eval('#keyLeaveDlg .dlg-actions button', (bs) => bs.map((b) => [b.id, b.classList.contains('danger-solid')]))) === JSON.stringify([['keyLeaveNo', false], ['keyLeaveYes', true]]), 'Cancel, then the danger button last');
    // both controls fit the row (stacked on a phone, not cut off)
    const fit = await page.$eval('#keyHeldRooms li[data-room="family-trip"]', (li) => [...li.querySelectorAll('.key-row-acts button')].every((b) => { const r = b.getBoundingClientRect(), l = li.getBoundingClientRect(); return r.left >= l.left - 1 && r.right <= l.right + 1; }));
    must(fit, 'both buttons inside the row');
    // the row's text keeps its width: on a phone the controls go on a line of their own below it
    const widths = await page.$$eval('#keyHeldRooms li', (lis) => lis.map((li) => [li.dataset.room, Math.round(li.querySelector('.key-row-main').getBoundingClientRect().width), Math.round(li.getBoundingClientRect().width)]));
    for (const [room, main, li] of widths) must(main >= Math.min(240, li), room + ': the text is ' + main + ' px wide in a row of ' + li);
  }, '#keyHeldRooms');
  await state('leave-done', { rooms: MINE, api: leaving(LEFT('family-trip', 'off'), (rooms) => rooms.filter((r) => r.room !== 'family-trip')) }, async (page, S) => {
    await leaveAnswered(page, S, 'family-trip');
    await page.waitForFunction(() => !document.querySelector('#keyHeldRooms li[data-room="family-trip"]'), null, { timeout: 5000 });
    must((await text(page, '#keyHeldSay')) === 'Scout left family-trip.', await text(page, '#keyHeldSay'));
    must(!(await page.$('#keyHeldErr')), 'no alert');
  }, '#keyHeld');
  await state('leave-kept', { rooms: MINE, api: leaving(LEFT('family-trip', 'marked_wake'), (rooms) => rooms.map((r) => (r.room === 'family-trip' ? { ...r, state: 'refused', code: 'invite_revoked', at: NOW } : r))) }, async (page, S) => {
    await leaveAnswered(page, S, 'family-trip');
    await page.waitForFunction(() => !document.querySelector('#keyHeldRooms li[data-room="family-trip"] .key-leave'), null, { timeout: 5000 });
    must((await text(page, '#keyHeldSay')) === 'Scout left family-trip. This key could not yet confirm that the Muse wake it set up in family-trip is off, so family-trip is still listed on this key, as left: Take off this key tries again.', await text(page, '#keyHeldSay'));
    must(!/\/api\//.test(await text(page, '#keyHeld')), 'no API path shown to a person');
    must((await row(page, 'keyHeldRooms', 'family-trip')).includes("This room no longer takes the key's invite (revoked, or the agent left)"), 'the row as the key holds it now: ' + (await row(page, 'keyHeldRooms', 'family-trip')));
  }, '#keyHeld');
  // every other outcome of a leave the key still lists, from the answer's kept, in the page's own words
  // (its own controls, never the API path the answer's note names for an agent), the rows as the key holds them then
  const KEPT = {
    marked: ['book-club is still listed on this key, as left: Take off this key takes it off.', (rooms) => rooms.map((r) => (r.room === 'book-club' ? { ...r, state: 'refused', code: 'invite_revoked', at: NOW } : r))],
    listed: ['This key could not record the leave yet, so book-club still shows as on this key: Take off this key takes it off.', (rooms) => rooms],
    cut: ['This key was disconnected meanwhile.', null],
    other: ['book-club is on this key again, with another invite.', (rooms) => rooms.map((r) => (r.room === 'book-club' ? { ...r, name: 'Scout2', added: NOW } : r))],
  };
  for (const [kept, [said, after]] of Object.entries(KEPT)) {
    const api = leaving(LEFT('book-club', kept), after);
    // a key disconnected meanwhile refuses the reload, as the other controls show it
    if (!after) api.info = async (S) => (S.left ? { status: 403, body: { error: W.AGENT_KEY_INVALID, code: 'agent_key_invalid' } } : { body: INFO });
    await state('leave-' + kept, { rooms: MINE, api }, async (page, S) => {
      await leaveAnswered(page, S, 'book-club');
      must((await text(page, '#keyHeldSay')) === 'Scout left book-club. ' + said, kept + ': ' + (await text(page, '#keyHeldSay')));
      must(!/\/api\//.test(await text(page, '#keyHeld')), kept + ': no API path shown to a person');
      if (!after) must((await text(page, '#keyHeldErr')) === 'This key is not a current one: it was mistyped or disconnected.', await text(page, '#keyHeldErr'));
    }, '#keyHeld');
  }
  await state('leave-last-member', { rooms: MINE, api: leaving({ status: 409, body: { error: W.leaveLastMember('Scout', 'book-club', 2), code: 'last_member', room: 'book-club', unopened: 2 } }) }, async (page, S) => {
    await leaveAnswered(page, S, 'book-club');
    must((await text(page, '#keyHeldErr')) === 'Scout is the last member of book-club who has joined: leaving would delete the room, and this page never deletes a room. Nothing was changed.', await text(page, '#keyHeldErr'));
    must(!!(await page.$('#keyHeldRooms li[data-room="book-club"] .key-leave')), 'the row as it was');
  }, '#keyHeld');
  await state('leave-not-joined', { rooms: MINE, api: leaving({ status: 409, body: { error: W.leaveNotJoined('Scout', 'book-club'), code: 'not_joined', room: 'book-club' } }) }, async (page, S) => {
    await leaveAnswered(page, S, 'book-club');
    must((await text(page, '#keyHeldErr')) === 'Scout has not joined book-club yet, so there is nothing to leave. To keep it out of book-club, take book-club off this key.', await text(page, '#keyHeldErr'));
  }, '#keyHeld');
  // the seat's token refused, or the room deleted: the row turns refused, in the refused row's own words, never the room's sentence to the agent
  const refusedAfter = (code) => (rooms) => rooms.map((r) => (r.room === 'book-club' ? { ...r, state: 'refused', code, at: NOW } : r));
  await state('leave-refused', { rooms: MINE, api: leaving({ status: 403, body: { error: 'Room "book-club": You left this room with this invite, so it will not work again. A member of the room can invite you anew.', code: 'invite_revoked', room: 'book-club' } }, refusedAfter('invite_revoked')) }, async (page, S) => {
    await leaveAnswered(page, S, 'book-club');
    must((await text(page, '#keyHeldErr')) === "book-club no longer takes the key's invite (revoked, or the agent left), so there was nothing to leave.", await text(page, '#keyHeldErr'));
    must(!/You left/.test(await text(page, '#keyHeld')), 'not the sentence that speaks to the agent');
    await page.waitForFunction(() => !document.querySelector('#keyHeldRooms li[data-room="book-club"] .key-leave'), null, { timeout: 5000 });
    must((await row(page, 'keyHeldRooms', 'book-club')).includes("This room no longer takes the key's invite (revoked, or the agent left)"), 'a refused row now');
  }, '#keyHeld');
  for (const [tag, code, status, error, why] of [['deleted', 'room_deleted', 410, W.leaveRoomGone('book-club'), 'the room was deleted'], ['invalid', 'invite_invalid', 403, 'Room "book-club": This invite link isn\'t valid for this room.', 'no longer valid there'], ['marked-deleted', 'room_deleted', 410, W.leaveEntryRefused('book-club', 'room_deleted'), 'the room was deleted']]) {
    await scenario('keys-leave-refused-' + tag, { rooms: MINE, api: leaving({ status, body: { error, code, room: 'book-club' } }, refusedAfter(code)) }, async (page, S) => {
      await leaveAnswered(page, S, 'book-club');
      must((await text(page, '#keyHeldErr')) === "book-club no longer takes the key's invite (" + why + '), so there was nothing to leave.', code + ': ' + (await text(page, '#keyHeldErr')));
    });
  }
  await state('leave-unreadable', { rooms: MINE, api: leaving({ status: 500, body: { error: W.AGENT_UNREADABLE, code: 'agent_unreadable', room: 'book-club' } }) }, async (page, S) => {
    await leaveAnswered(page, S, 'book-club');
    must((await text(page, '#keyHeldErr')) === "This key's record could not be read, so its rooms can't be shown. The key itself was not refused.", await text(page, '#keyHeldErr'));
  }, '#keyHeld');
  await state('leave-refused-key', { rooms: MINE, api: { ...leaving({ status: 403, body: { error: W.AGENT_KEY_INVALID, code: 'agent_key_invalid' } }), info: async (S) => (S.left ? { status: 403, body: { error: W.AGENT_KEY_INVALID, code: 'agent_key_invalid' } } : { body: INFO }) } }, async (page, S) => {
    await leaveAnswered(page, S, 'book-club');
    must((await text(page, '#keyHeldErr')) === 'This key is not a current one: it was mistyped or disconnected.', await text(page, '#keyHeldErr'));
  }, '#keyHeld');
  await state('leave-network', { rooms: MINE, api: leaving('network'), allowConsole: /Failed to load resource|ERR_FAILED/ }, async (page, S) => {
    await leaveAnswered(page, S, 'book-club');
    must((await text(page, '#keyHeldErr')) === "Couldn't reach the site, so this page can't tell whether Scout left book-club. Open the key again to see.", await text(page, '#keyHeldErr'));
  }, '#keyHeld');
  // a failure with no answer from the site (the edge's own error page) is no answer either
  await scenario('keys-leave-no-answer', { rooms: MINE, api: leaving({ status: 502, body: '<html>bad gateway</html>' }) }, async (page, S) => {
    await leaveAnswered(page, S, 'book-club');
    must((await text(page, '#keyHeldErr')) === "Couldn't reach the site, so this page can't tell whether Scout left book-club. Open the key again to see.", await text(page, '#keyHeldErr'));
  });
  // the keyboard: Enter opens, focus is in the dialog, Cancel then Leave room, Escape closes it and focus goes back to the button
  await scenario('keys-leave-keyboard', { rooms: MINE, api: OPEN }, async (page) => {
    await paste(page, KEY);
    await page.waitForSelector('#keyOpened', { timeout: 5000 });
    await page.focus('#keyHeldRooms li[data-room="book-club"] .key-leave');
    await page.keyboard.press('Enter');
    await page.waitForSelector('#keyLeaveDlg[open]', { timeout: 3000 });
    must(await page.evaluate(() => document.getElementById('keyLeaveDlg').contains(document.activeElement)), 'focus in the dialog');
    const order = [];
    for (let i = 0; i < 3; i++) { order.push(await page.evaluate(() => document.activeElement && document.activeElement.id)); await page.keyboard.press('Tab'); }
    must(order.includes('keyLeaveNo') && order.includes('keyLeaveYes') && order.indexOf('keyLeaveNo') < order.lastIndexOf('keyLeaveYes'), 'Cancel, then Leave room: ' + JSON.stringify(order));
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.getElementById('keyLeaveDlg').open, null, { timeout: 3000 });
    must(await page.evaluate(() => document.activeElement && document.activeElement.matches('#keyHeldRooms li[data-room="book-club"] .key-leave')), 'focus back on the button');
    // Cancel closes it too, and asks nothing
    await page.keyboard.press('Enter');
    await page.waitForSelector('#keyLeaveDlg[open]', { timeout: 3000 });
    await page.click('#keyLeaveNo');
    await page.waitForFunction(() => !document.getElementById('keyLeaveDlg').open, null, { timeout: 3000 });
    return { order };
  });
  // a browser without dialogs asks with confirm, the dialog's title as its question
  await scenario('keys-leave-no-dialog', { rooms: MINE, api: leaving(LEFT('book-club', 'off'), (rooms) => rooms.filter((r) => r.room !== 'book-club')) }, async (page) => {
    await page.evaluate(() => { HTMLDialogElement.prototype.showModal = undefined; window.__asked = []; window.confirm = (q) => { window.__asked.push(q); return true; }; });
    await paste(page, KEY);
    await page.waitForSelector('#keyOpened', { timeout: 5000 });
    await page.click('#keyHeldRooms li[data-room="book-club"] .key-leave');
    await page.waitForFunction(() => /Scout left book-club\./.test(document.getElementById('keyHeldSay')?.textContent || ''), null, { timeout: 5000 });
    must(JSON.stringify(await page.evaluate(() => window.__asked)) === '["Have Scout leave book-club?"]', 'confirm with the same question: ' + JSON.stringify(await page.evaluate(() => window.__asked)));
  });
  await state('disconnect-dialog', { rooms: MINE, api: OPEN }, async (page) => {
    await paste(page, KEY);
    await page.waitForSelector('#keyOpened', { timeout: 5000 });
    await page.click('#keyDrop');
    await page.waitForSelector('#keyDropDlg[open]', { timeout: 3000 });
    must((await text(page, '#keyDropDlg')).includes("Disconnect this key everywhere? It stops working at once, in every room. The agent stays a member of each room that still takes this key's invite until it leaves or the site's owner removes it; any room link it was given itself still works; links it already got for an upload or a file run until they expire. The Muse wakes this key set up are turned off."), await text(page, '#keyDropDlg'));
  });
  await state('disconnected', { rooms: MINE, api: { ...OPEN, drop: async () => ({ body: DROP_LEFT }) } }, async (page) => {
    await paste(page, KEY);
    await page.waitForSelector('#keyOpened', { timeout: 5000 });
    await page.click('#keyDrop');
    await page.waitForSelector('#keyDropDlg[open]', { timeout: 3000 });
    await page.click('#keyDropYes');
    await page.waitForSelector('#keyDropped', { timeout: 5000 });
    // old-room no longer took the key's invite: it is not named as a room the agent is a member of
    must((await text(page, '#keyDropped')) === 'Disconnected. The agent is still a member of: family-trip, book-club. These rooms did not confirm that the Muse wakes this key set up there are off: family-trip. Try again turns them off once they answer; Disconnect on the Muse gadget stops every wake at once.', await text(page, '#keyDropped'));
    must((await text(page, '#keyDropAgain')) === 'Try again' && await page.$eval('#keyDropAgain', (b) => !b.disabled), 'Try again, beside the result');
    must(!(await page.$('#keyOpened')) && await page.$eval('#keyPaste', (i) => i.value) === '', 'the key is cleared from the view');
    await page.waitForFunction(() => document.activeElement && document.activeElement.id === 'keyPaste', null, { timeout: 3000 });
  }, '#keyHeld');
  // Try again: the same DELETE, with the same key, for the wakes the first one left
  const DROP_ALL = { deleted: true, rooms: ['family-trip'], muse_wakes_removed: ['family-trip'], muse_wakes_left: [], note: W.dropNote([]) };
  await state('disconnect-again', { rooms: MINE, api: { ...OPEN, drop: async (S) => { S.drops = (S.drops || 0) + 1; return { body: S.drops === 1 ? DROP_LEFT : DROP_ALL }; } } }, async (page, S) => {
    await paste(page, KEY);
    await page.waitForSelector('#keyOpened', { timeout: 5000 });
    await page.click('#keyDrop');
    await page.waitForSelector('#keyDropDlg[open]', { timeout: 3000 });
    await page.click('#keyDropYes');
    await page.waitForSelector('#keyDropAgain', { timeout: 5000 });
    await page.click('#keyDropAgain');
    await page.waitForFunction(() => !document.getElementById('keyDropAgain'), null, { timeout: 5000 });
    must((await text(page, '#keyDropped')) === 'Disconnected. The agent is still a member of: family-trip, book-club. The Muse wakes this key set up are off.', await text(page, '#keyDropped'));
    const drops = S.calls.filter((c) => c.p === '/api/agent' && c.m === 'DELETE');
    must(drops.length === 2 && drops.every((c) => c.auth === 'Bearer ' + KEY), 'the same DELETE, with the same key: ' + drops.length);
    must(!(await page.$('#keyOpened')), 'the key is still not shown');
    await page.waitForFunction(() => document.activeElement && document.activeElement.id === 'keyPaste', null, { timeout: 3000 });
  }, '#keyHeld');
  await scenario('keys-disconnect-again-left', { rooms: MINE, api: { ...OPEN, drop: async (S) => {
    S.drops = (S.drops || 0) + 1;
    if (S.drops === 1) return { body: { ...DROP_LEFT, muse_wakes_left: ['family-trip', 'book-club'], muse_wakes_removed: [] } };
    if (S.drops === 2) return { body: { deleted: true, rooms: ['family-trip', 'book-club'], muse_wakes_removed: ['book-club'], muse_wakes_left: ['family-trip'], note: W.dropNote(['family-trip']) } };
    return { status: 403, body: { error: W.AGENT_KEY_INVALID, code: 'agent_key_invalid' } };
  } } }, async (page, S) => {
    await paste(page, KEY);
    await page.waitForSelector('#keyOpened', { timeout: 5000 });
    await page.click('#keyDrop');
    await page.waitForSelector('#keyDropDlg[open]', { timeout: 3000 });
    await page.click('#keyDropYes');
    await page.waitForSelector('#keyDropAgain', { timeout: 5000 });
    await page.click('#keyDropAgain');
    await until(() => S.drops === 2);
    await page.waitForFunction(() => /are off: family-trip\. Try again/.test(document.getElementById('keyDropped')?.textContent || ''), null, { timeout: 5000 });
    must((await text(page, '#keyDropped')).endsWith('These rooms did not confirm that the Muse wakes this key set up there are off: family-trip. Try again turns them off once they answer; Disconnect on the Muse gadget stops every wake at once.'), await text(page, '#keyDropped'));
    must(!!(await page.$('#keyDropAgain')), 'still offered while a wake is left');
    // a record gone meanwhile (another disconnect finished it): said, and nothing left to try
    await page.click('#keyDropAgain');
    await page.waitForSelector('#keyHeldErr', { timeout: 5000 });
    must((await text(page, '#keyHeldErr')) === 'This key is not a current one: it was mistyped or disconnected.', await text(page, '#keyHeldErr'));
    must(!(await page.$('#keyDropAgain')), 'no Try again once the key is gone');
  });
  // a disconnected key whose record still holds rooms is refused by Open as any unknown key: the view offers its DELETE again
  const REFUSED_KEY = { info: async () => ({ status: 403, body: { error: W.AGENT_KEY_INVALID, code: 'agent_key_invalid' } }) };
  await state('refused-key', { rooms: MINE, api: REFUSED_KEY }, async (page, S) => {
    await paste(page, KEY);
    await page.waitForSelector('#keyFinish', { timeout: 5000 });
    must((await text(page, '#keyHeldErr')) === 'This key is not a current one: it was mistyped or disconnected.', await text(page, '#keyHeldErr'));
    must((await text(page, '#keyFinish')) === 'If you disconnected this key and the page said some rooms did not confirm their Muse wakes were off, this tries again to turn them off (some may still not confirm); it changes nothing for a key that was mistyped or is fully disconnected. Try its Muse wakes again', await text(page, '#keyFinish'));
    must(!S.calls.some((c) => c.m === 'DELETE'), 'nothing sent until asked');
  }, '#keyHeld');
  await state('refused-key-done', { rooms: MINE, api: { ...REFUSED_KEY, drop: async (S) => { S.drops = (S.drops || 0) + 1; await new Promise((r) => setTimeout(r, 400)); return { body: { deleted: true, rooms: ['family-trip'], muse_wakes_removed: ['family-trip'], muse_wakes_left: [], note: W.dropNote([]) } }; } } }, async (page, S) => {
    await paste(page, KEY);
    await page.waitForSelector('#keyFinishGo', { timeout: 5000 });
    await page.click('#keyFinishGo');
    await page.waitForFunction(() => /Trying this key's Muse wakes again/.test(document.getElementById('keyHeldSay')?.textContent || ''), null, { timeout: 3000 });
    must(await page.$eval('#keyFinishGo', (b) => b.disabled), 'the button waits while it works');
    await page.waitForSelector('#keyDropped', { timeout: 5000 });
    must((await text(page, '#keyDropped')) === 'Disconnected. The Muse wakes this key set up are off.', await text(page, '#keyDropped'));
    const drops = S.calls.filter((c) => c.m === 'DELETE' && c.p === '/api/agent');
    must(drops.length === 1 && drops[0].auth === 'Bearer ' + KEY, 'the DELETE, with the key');
    must(!(await page.$('#keyFinish')) && !(await page.$('#keyDropAgain')), 'nothing more to offer');
    must(await page.$eval('#keyPaste', (i) => i.value) === '', 'the key cleared from the field');
  }, '#keyHeld');
  await scenario('keys-refused-key-left', { rooms: MINE, api: { ...REFUSED_KEY, drop: async (S) => { S.drops = (S.drops || 0) + 1; return { body: S.drops === 1 ? { deleted: true, rooms: ['family-trip'], muse_wakes_removed: [], muse_wakes_left: ['family-trip'], note: W.dropNote(['family-trip']) } : { deleted: true, rooms: ['family-trip'], muse_wakes_removed: ['family-trip'], muse_wakes_left: [], note: W.dropNote([]) } }; } } }, async (page, S) => {
    await paste(page, KEY);
    await page.waitForSelector('#keyFinishGo', { timeout: 5000 });
    await page.click('#keyFinishGo');
    await page.waitForSelector('#keyDropAgain', { timeout: 5000 });
    must((await text(page, '#keyDropped')) === 'Disconnected. These rooms did not confirm that the Muse wakes this key set up there are off: family-trip. Try again turns them off once they answer; Disconnect on the Muse gadget stops every wake at once.', await text(page, '#keyDropped'));
    await page.click('#keyDropAgain');
    await page.waitForFunction(() => !document.getElementById('keyDropAgain'), null, { timeout: 5000 });
    must((await text(page, '#keyDropped')) === 'Disconnected. The Muse wakes this key set up are off.', await text(page, '#keyDropped'));
    must(S.calls.filter((c) => c.m === 'DELETE').every((c) => c.auth === 'Bearer ' + KEY) && S.drops === 2, 'two DELETEs with the key');
  });
  await state('refused-key-unknown', { rooms: MINE, api: { ...REFUSED_KEY, drop: async () => ({ status: 403, body: { error: W.AGENT_KEY_INVALID, code: 'agent_key_invalid' } }) } }, async (page) => {
    await paste(page, KEY);
    await page.waitForSelector('#keyFinishGo', { timeout: 5000 });
    await page.click('#keyFinishGo');
    await page.waitForFunction(() => /Nothing was turned off/.test(document.getElementById('keyHeldErr')?.textContent || ''), null, { timeout: 5000 });
    must((await text(page, '#keyHeldErr')) === 'Nothing was turned off: the site knows no disconnected key like this one with Muse wakes left (it was mistyped, or it is fully disconnected already).', await text(page, '#keyHeldErr'));
    must(!(await page.$('#keyFinish')) && !(await page.$('#keyDropped')), 'no offer left, and no result line');
  }, '#keyHeld');
  await scenario('keys-disconnect-unreadable', { rooms: MINE, api: { ...OPEN, drop: async () => ({ body: { deleted: true, rooms: [], muse_wakes_removed: [], muse_wakes_left: null, note: W.dropNote(null) } }) } }, async (page) => {
    await paste(page, KEY);
    await page.waitForSelector('#keyOpened', { timeout: 5000 });
    await page.click('#keyDrop');
    await page.waitForSelector('#keyDropDlg[open]', { timeout: 3000 });
    await page.click('#keyDropYes');
    await page.waitForSelector('#keyDropped', { timeout: 5000 });
    must((await text(page, '#keyDropped')) === "Disconnected. This key's record could not be read, so the Muse wakes it set up could not be turned off: Disconnect on the Muse gadget stops every wake at once.", await text(page, '#keyDropped'));
  });

  // ---- what the view never does, and its keyboard paths ----
  await scenario('keys-cleared', { rooms: MINE, api: { ...OPEN, invite: async (body) => (body.check ? { body: newSeats(body) } : { status: 201, body: MADE }) } }, async (page) => {
    const has = () => page.evaluate((k) => document.body.innerHTML.includes(k) || [...document.querySelectorAll('input')].some((i) => i.value.includes(k)), KEY);
    // Done
    await page.fill('#keyName', 'Scout');
    await tick(page, 'keyRooms', 'family-trip');
    await page.click('#keyGo');
    await page.waitForSelector('#keyMade', { timeout: 5000 });
    must(await has(), 'shown');
    await page.click('#keyMadeDone');
    must(!(await has()), 'gone on Done');
    must(await page.evaluate(() => document.activeElement && document.activeElement.id === 'keyPaste'), 'focus back to the Open field');
    // leaving the view
    await paste(page, KEY);
    await page.waitForSelector('#keyOpened', { timeout: 5000 });
    // leaving the view by its tab: gone within the click's own task
    const leftAtOnce = await page.evaluate((k) => {
      document.querySelector('[data-view="how"]').click();
      return document.body.innerHTML.includes(k) || [...document.querySelectorAll('input')].some((i) => i.value.includes(k));
    }, KEY);
    must(!leftAtOnce, 'gone once the view is left, within the click');
    await page.waitForSelector('#view-how:not([hidden])', { timeout: 3000 });
    must(!(await has()), 'gone once the view is left');
    await page.evaluate(() => { location.hash = 'keys'; });
    await page.waitForSelector('#view-keys', { timeout: 3000 });
    must(!(await has()) && !(await page.$('#keyOpened')), 'not back when the view is shown again');
    // pagehide
    await paste(page, KEY);
    await page.waitForSelector('#keyOpened', { timeout: 5000 });
    // in the same task as the event, before anything could freeze the page: no input and no text holds the key
    const atOnce = await page.evaluate((k) => {
      window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
      return document.body.innerHTML.includes(k) || document.body.innerText.includes(k) || [...document.querySelectorAll('input, textarea')].some((i) => i.value.includes(k));
    }, KEY);
    must(!atOnce, 'gone on pagehide, within the event');
    must(!(await has()), 'and after');
    // Close
    await paste(page, KEY);
    await page.waitForSelector('#keyOpened', { timeout: 5000 });
    await page.click('#keyClose');
    must(!(await has()), 'gone on Close');
    await page.waitForFunction(() => document.activeElement && document.activeElement.id === 'keyPaste', null, { timeout: 3000 });
    // no URL, no history entry ever held it
    must(!page.url().includes('.ac1.') && !(await page.evaluate(() => JSON.stringify(history.state) || '')).includes('.ac1.'), 'no URL or history state holds a key');
  });
  await scenario('keys-text-not-markup', { rooms: MINE, api: { info: async () => ({ body: { ...INFO, rooms: [{ room: 'family-trip', name: '<img src=x onerror="window.__pwned=1">', added: NOW, state: 'held' }] } }), invite: async () => ({ body: { ok: false, rooms: [{ room: 'family-trip', name: 'x', problem: { status: 409, code: 'name_taken', error: '<b id="bold">bold</b> is taken' } }] } }) } }, async (page) => {
    await paste(page, KEY);
    await page.waitForSelector('#keyOpened', { timeout: 5000 });
    must((await row(page, 'keyHeldRooms', 'family-trip')).includes('as <img src=x onerror="window.__pwned=1">'), 'the name as text');
    await page.fill('#keyName', 'Scout');
    await tick(page, 'keyRooms', 'family-trip');
    await page.click('#keyGo');
    await page.waitForSelector('#keyErr', { timeout: 5000 });
    must((await row(page, 'keyRooms', 'family-trip')).includes('<b id="bold">bold</b> is taken'), 'the sentence as text');
    must(!(await page.$('#view-keys img')) && !(await page.$('#bold')) && !(await page.evaluate(() => window.__pwned)), 'no markup made');
  });
  await scenario('keys-keyboard', { rooms: MINE, api: OPEN }, async (page) => {
    await paste(page, KEY);
    await page.waitForSelector('#keyOpened', { timeout: 5000 });
    // take off: Escape closes, focus stays in the dialog while it is open
    await page.click('#keyHeldRooms li[data-room="book-club"] button');
    await page.waitForSelector('#keyOffDlg[open]', { timeout: 3000 });
    must(await page.evaluate(() => document.getElementById('keyOffDlg').contains(document.activeElement)), 'focus in the dialog');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.getElementById('keyOffDlg').open, null, { timeout: 3000 });
    // disconnect: Tab goes Cancel, then Disconnect, and wraps inside the dialog
    await page.focus('#keyDrop');
    await page.keyboard.press('Enter');
    await page.waitForSelector('#keyDropDlg[open]', { timeout: 3000 });
    const order = [];
    for (let i = 0; i < 3; i++) { order.push(await page.evaluate(() => document.activeElement && document.activeElement.id)); await page.keyboard.press('Tab'); }
    must(order.includes('keyDropNo') && order.includes('keyDropYes') && order.indexOf('keyDropNo') < order.lastIndexOf('keyDropYes'), 'Cancel, then Disconnect: ' + JSON.stringify(order));
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.getElementById('keyDropDlg').open, null, { timeout: 3000 });
    // a click on the backdrop closes it when no call runs
    await page.click('#keyDrop');
    await page.waitForSelector('#keyDropDlg[open]', { timeout: 3000 });
    await page.mouse.click(5, 5);
    await page.waitForFunction(() => !document.getElementById('keyDropDlg').open, null, { timeout: 3000 });
    // the live region and the alerts
    must(await page.$eval('#keyHeldSay', (e) => e.getAttribute('aria-live') === 'polite'), 'one polite live region');
    return { order };
  });
  // a browser without dialogs asks with confirm
  await scenario('keys-no-dialog', { rooms: MINE, api: { ...OPEN, drop: async () => ({ body: { deleted: true, rooms: ['family-trip'], muse_wakes_removed: [], muse_wakes_left: [], note: 'x' } }) } }, async (page) => {
    await page.evaluate(() => { HTMLDialogElement.prototype.showModal = undefined; window.__asked = []; window.confirm = (q) => { window.__asked.push(q); return true; }; });
    await paste(page, KEY);
    await page.waitForSelector('#keyOpened', { timeout: 5000 });
    await page.click('#keyDrop');
    await page.waitForSelector('#keyDropped', { timeout: 5000 });
    must(JSON.stringify(await page.evaluate(() => window.__asked)) === '["Disconnect this key everywhere?"]', 'confirm with the same question');
    must((await text(page, '#keyDropped')) === 'Disconnected. The agent is still a member of: family-trip.', await text(page, '#keyDropped'));
  });
  done('agent-keys');
})();
