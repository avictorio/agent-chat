// UI scenarios: Home → Agent keys (web/app/src/features/home/AgentKeys.tsx),
// on a fake API of its own: the rooms this browser holds, each looked at
// with GET /invite; the agent routes (POST /api/agents/invite with and
// without check, GET /api/agent, POST /api/agent/rooms/invite, POST
// /api/agent/rooms/remove, DELETE /api/agent). Every state of the view,
// each at desktop and phone width, light and dark, with a screenshot
// (keys-<state>-<desktop|phone>-<light|dark>.png); then what the view must
// never do: ask a room more than a look, store anything on the device, keep
// a key past Done, leaving the view, a disconnect or pagehide, or render a
// name from the server as markup; and the dialogs' keyboard paths.
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
const HANDOFF = 'You have an Agent Chat agent key for the rooms family-trip, book-club. Connect an MCP client that can send a header to ' + ORIGIN + '/api/mcp with the header Authorization: Bearer KEY, then call list_rooms; get_start_page with a room gives that room\'s steps. The key is a password: keep it with your credentials and never post it. On Muse, the key goes in a custom connector instead: your person asks Muse to add one for ' + ORIGIN + '/api/mcp and pastes the key into the "API Key" box it shows, never into the chat.';
const SETTINGS = JSON.stringify({ mcpServers: { 'agent-chat': { type: 'http', url: ORIGIN + '/api/mcp', headers: { Authorization: 'Bearer KEY' } } } }, null, 2);
const NOTE = "Shown only now: the site keeps no copy it can show again. Whoever holds this key acts as the agent in every room on it: give it only to that agent's settings, never in a message. The seats it holds were made with your invites, so the agent holds no room link of its own for them: disconnecting the key cuts it off from them at once.";
const MADE = { key: KEY, address: ORIGIN + '/api/mcp', rooms: [{ room: 'family-trip', name: 'Scout', opened: false, seat: 'new' }, { room: 'book-club', name: 'Scout', opened: false, seat: 'reused' }], max_rooms: 30, claude_code: SETTINGS, handoff: HANDOFF, note: NOTE + ' A seat it already had keeps any link the agent was given for it.' };
const INFO = {
  rooms: [
    { room: 'family-trip', name: 'Scout', added: NOW - 3 * D, state: 'held', muse_wake: true },
    { room: 'book-club', name: 'Scout', added: NOW - 3 * D, state: 'held' },
    { room: 'old-room', name: 'Scout', added: NOW - 9 * D, state: 'refused', code: 'invite_revoked', at: NOW - 2 * D },
  ],
  max_rooms: 30,
  created: NOW - 9 * D,
};
const DROP_LEFT = { deleted: true, rooms: ['family-trip', 'book-club', 'old-room'], muse_wakes_removed: ['book-club'], muse_wakes_left: ['family-trip'], note: 'This key works nowhere now. Every seat stays: you are still a member of these rooms, and any room token you kept still works. Links the key already handed out, for an upload or a file, run until they expire. These rooms could not be reached to turn off the Muse wakes this key set up: family-trip; in each, DELETE /api/rooms/ROOM/muse-hook with that room\'s own token turns it off, and Disconnect on the Muse gadget stops every wake at once.' };
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
 * drop(ctx), looks}); fn(page, S) runs it. S.calls lists every API request
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

(async () => {
  // ---- section 1: make a key ----
  await state('empty', { rooms: {} }, async (page) => {
    must(/This browser holds none of your rooms yet\. Open one of your invite links here first; then you can make a key for an agent in that room\./.test(await text(page, '#keyEmpty')), 'the empty device\'s sentence');
    must(!(await page.$('#keyName')), 'no form on an empty device');
    must(/One key lets an agent use several of your rooms through one connection\..*so the agent never holds a new seat's own link\. Where it reuses a seat the agent already had, anyone you gave that invite's link can still use it\./.test(await text(page, '#view-keys .lede')), 'the lede, with the reused seat\'s exception');
  });
  await state('rooms', { rooms: { ...ROOMS, 'slow-room': 'tok_slow' }, api: { looks: { tok_slow: 'hold' } }, noSettle: true }, async (page) => {
    await page.waitForFunction(() => /Couldn't check/.test(document.querySelector('#keyRooms')?.textContent || ''), null, { timeout: 8000 });
    await page.waitForFunction(() => [...document.querySelectorAll('#keyRooms li')].filter((li) => /as Anthony/.test(li.textContent)).length === 2, null, { timeout: 8000 });
    const want = {
      'family-trip': 'family-trip as Anthony',
      'work-notes': "work-notes Your invite here is an agent's, not yours.",
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
      { room: 'family-trip', name: 'Scout', problem: { status: 409, code: 'name_taken', error: 'Room "family-trip": Scout is already taken here. Pick another name.' } },
      { room: 'book-club', name: 'Scout', problem: { status: 429, code: 'rate_limited', error: 'Room "book-club": You can create up to 5 invites a day' } },
      { room: 'trip-two', name: 'Scout', problem: { status: 409, code: 'seat_in_use', error: 'Room "trip-two": Scout is already a member here, invited by you: use that seat, or pick another name.' } },
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
    must((await row(page, 'keyRooms', 'trip-three')).includes("Uses Scout's unused invite here (invited by you). Anyone you gave that invite's link can still use it."), 'the unused seat reused, said');
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
    must((await text(page, '#keyMadeHandoff')).includes('Authorization: Bearer ' + KEY + ', then call list_rooms'), 'the hand-off with the key');
    must(JSON.stringify(await page.$$eval('#keyMadeRooms li', (l) => l.map((x) => x.textContent.replace(/\s+/g, ' ').trim()))) === JSON.stringify(['family-trip as Scout new invite', 'book-club as Scout existing seat']), 'the rooms');
    must((await text(page, '#keyMadeNote')) === MADE.note, 'the note');
    const calls = S.calls.filter((c) => c.p === '/api/agents/invite');
    must(calls.length === 2 && calls[0].body.check === true && !('check' in calls[1].body), 'the check, then the call at once');
    must(calls.every((c) => !c.auth), 'no key sent to make one');
    // Copy
    await page.click('#keyMade .row button');
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
  await state('left-unused', { rooms: MINE, api: { invite: async (body) => (body.check ? { body: newSeats(body) } : { status: 409, body: { error: 'Room "book-club": Scout is already taken here. Pick another name.', code: 'name_taken', room: 'book-club', left_unused: ['family-trip'], note: 'The invite this call made in family-trip stays unused, and trying again with the same name uses it.' } }) } }, async (page) => {
    await page.fill('#keyName', 'Scout');
    await tick(page, 'keyRooms', 'family-trip');
    await tick(page, 'keyRooms', 'book-club');
    await page.click('#keyGo');
    await page.waitForSelector('#keyErr', { timeout: 5000 });
    must((await text(page, '#keyErr')) === 'No key was made. The invite this call made in family-trip stays unused, and trying again with the same name uses it.', await text(page, '#keyErr'));
    must((await row(page, 'keyRooms', 'book-club')).includes('Scout is already taken here. Pick another name.'), 'the refusal on its room');
    must(!(await page.$('#keyMade')), 'no key');
  }, '#keyRooms');
  await state('nothing-kept', { rooms: MINE, api: { invite: async (body) => (body.check ? { body: newSeats(body) } : { status: 403, body: { error: 'Room "family-trip": This invite link has been revoked. Ask whoever gave it to you for a new one.', code: 'invite_revoked', room: 'family-trip' } }) } }, async (page) => {
    await page.fill('#keyName', 'Scout');
    await tick(page, 'keyRooms', 'family-trip');
    await page.click('#keyGo');
    await page.waitForSelector('#keyErr', { timeout: 5000 });
    must((await text(page, '#keyErr')) === 'Nothing was kept.', await text(page, '#keyErr'));
    must((await row(page, 'keyRooms', 'family-trip')).includes('This invite link has been revoked.'), 'on its room');
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
    must(await page.$eval('#keyPaste', (i) => i.type === 'text' && i.autocomplete === 'off' && i.spellcheck === false && i.getAttribute('autocapitalize') === 'off'), 'the field offers no saving');
  }, '#keyHeld');
  await state('refused-key', { rooms: MINE, api: { info: async () => ({ status: 403, body: { error: 'This agent key is not a current one: it was mistyped or disconnected.', code: 'agent_key_invalid' } }) } }, async (page) => {
    await paste(page, KEY);
    await page.waitForSelector('#keyHeldErr', { timeout: 5000 });
    must((await text(page, '#keyHeldErr')) === 'This key is not a current one: it was mistyped or disconnected.', await text(page, '#keyHeldErr'));
  }, '#keyHeld');
  await state('unreadable', { rooms: MINE, api: { info: async () => ({ status: 500, body: { error: "This key's record could not be read.", code: 'agent_unreadable' } }) } }, async (page) => {
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
    must((await row(page, 'keyHeldRooms', 'family-trip')) === "family-trip as Scout, added Nov 17 On this key Wakes this agent's Muse Take off this key", await row(page, 'keyHeldRooms', 'family-trip'));
    must((await row(page, 'keyHeldRooms', 'book-club')) === 'book-club as Scout, added Nov 17 On this key Take off this key', await row(page, 'keyHeldRooms', 'book-club'));
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
    await page.click('#keyAdd');
    await page.waitForFunction(() => /Added: trip-two\./.test(document.getElementById('keyHeldSay')?.textContent || ''), null, { timeout: 5000 });
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
    must((await text(page, '#keyOffDlg')).includes('The key forgets this room. The agent stays a member of family-trip. Once it is off the key, the agent cannot leave family-trip through the key: to take it out of family-trip, have it leave first (leave_room), or add family-trip back later. The Muse wake this key set up in family-trip is turned off.'), await text(page, '#keyOffDlg'));
    must(await page.$eval('#keyOffDlg', (d) => d.getAttribute('aria-labelledby') === 'keyOffTitle'), 'labelled by its title');
  });
  await state('takeoff-busy', { rooms: MINE, api: { ...OPEN, remove: async () => ({ status: 503, headers: { 'Retry-After': '1' }, body: { error: 'family-trip could not be reached to turn off the Muse wake this key set up there, so it is still on this key and its wake is still on. Try again shortly.', code: 'try_again', room: 'family-trip' } }) } }, async (page) => {
    await paste(page, KEY);
    await page.waitForSelector('#keyOpened', { timeout: 5000 });
    await page.click('#keyHeldRooms li[data-room="family-trip"] button');
    await page.waitForSelector('#keyOffDlg[open]', { timeout: 3000 });
    await page.click('#keyOffYes');
    await page.waitForSelector('#keyOffDlg [role=alert]', { timeout: 5000 });
    must((await text(page, '#keyOffDlg [role=alert]')) === 'family-trip could not be reached to turn off the Muse wake this key set up there, so it is still on this key and its wake is still on. Try again shortly.', await text(page, '#keyOffDlg [role=alert]'));
    must(await page.$eval('#keyOffDlg', (d) => d.open), 'the dialog stays open');
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
  await state('disconnect-dialog', { rooms: MINE, api: OPEN }, async (page) => {
    await paste(page, KEY);
    await page.waitForSelector('#keyOpened', { timeout: 5000 });
    await page.click('#keyDrop');
    await page.waitForSelector('#keyDropDlg[open]', { timeout: 3000 });
    must((await text(page, '#keyDropDlg')).includes("Disconnect this key everywhere? It stops working at once, in every room. The agent stays a member of each room until it leaves or the site's owner removes it; any room link it was given itself still works; links it already got for an upload or a file run until they expire. The Muse wakes this key set up are turned off."), await text(page, '#keyDropDlg'));
  });
  await state('disconnected', { rooms: MINE, api: { ...OPEN, drop: async () => ({ body: DROP_LEFT }) } }, async (page) => {
    await paste(page, KEY);
    await page.waitForSelector('#keyOpened', { timeout: 5000 });
    await page.click('#keyDrop');
    await page.waitForSelector('#keyDropDlg[open]', { timeout: 3000 });
    await page.click('#keyDropYes');
    await page.waitForSelector('#keyDropped', { timeout: 5000 });
    must((await text(page, '#keyDropped')) === 'Disconnected. The agent is still a member of: family-trip, book-club, old-room. These rooms could not be reached to turn off the Muse wakes this key set up: family-trip. Disconnect on the Muse gadget stops every wake at once.', await text(page, '#keyDropped'));
    must(!(await page.$('#keyOpened')) && await page.$eval('#keyPaste', (i) => i.value) === '', 'the key is cleared');
    await page.waitForFunction(() => document.activeElement && document.activeElement.id === 'keyPaste', null, { timeout: 3000 });
  }, '#keyHeld');
  await scenario('keys-disconnect-unreadable', { rooms: MINE, api: { ...OPEN, drop: async () => ({ body: { deleted: true, rooms: [], muse_wakes_removed: [], muse_wakes_left: null, note: 'x' } }) } }, async (page) => {
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
    await page.evaluate(() => { location.hash = 'how'; });
    await page.waitForSelector('#view-how:not([hidden])', { timeout: 3000 });
    must(!(await has()), 'gone once the view is left');
    await page.evaluate(() => { location.hash = 'keys'; });
    await page.waitForSelector('#view-keys', { timeout: 3000 });
    must(!(await has()) && !(await page.$('#keyOpened')), 'not back when the view is shown again');
    // pagehide
    await paste(page, KEY);
    await page.waitForSelector('#keyOpened', { timeout: 5000 });
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
    await page.waitForFunction(() => !document.querySelector('#keyOpened'), null, { timeout: 3000 });
    must(!(await has()), 'gone on pagehide');
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
