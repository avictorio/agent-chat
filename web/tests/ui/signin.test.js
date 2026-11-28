// UI scenarios: the sign-in's approval page (/oauth/authorize,
// web/app/src/features/signin/SignInApproval.tsx) and the Agent keys view's
// third section, "Connections approved in this browser" (AgentKeys.tsx), on
// a fake API of their own that answers every request of the browser: the
// site's (the authorize page with the Worker's own AUTHORIZE_HEADERS, from
// harness.js; the looks of GET /invite; POST /api/oauth/decide and
// /api/oauth/disconnect), the apps' callback addresses as stand-in pages,
// and nothing else (any other request is refused here and fails the
// scenario, so none leaves the machine). Every state of the page, each at
// desktop and phone width, light and dark, with a screenshot
// (signin-<state>-<desktop|phone>-<light|dark>.png); then what the page
// must do and never do: the two buttons alike and always in view, focus on
// the heading and no key choosing a button, only looks and decide asked,
// nothing stored but the connection's record after an approval that gives
// one (no other storage key, no changed value, nothing in sessionStorage
// but the harness's own flag, no cookie), no connection handed to the app
// without that record, only an http or https answer followed, the popup's
// opener kept, a retry after a lost answer, names and the server's
// sentences as text; and the third section's records and dialogs.
// The server's sentences in the fixtures come from the Worker's own
// functions, so they cannot drift.
const { chromium, installClock, trackNetwork, settle, shot, must, failed, done, badConsole, HTML, DIST, ICON_PNG, NOW, D, authorizePage, workerModule } = require('./harness');

const ORIGIN = 'https://chat.victorio.cloud';
const PERSON = (name) => ({ name: name || 'Anthony', kind: 'human' });
const ROOMS = { 'family-trip': 'tok_family0000000000000000', 'book-club': 'tok_book000000000000000000' };
const LOOKS = {
  tok_family0000000000000000: PERSON(),
  tok_book000000000000000000: PERSON(),
  tok_work000000000000000000: { name: 'Probe', kind: 'agent' },
  tok_work200000000000000000: { name: 'Scout', kind: 'agent' },
  tok_old0000000000000000000: 403,
  tok_gone000000000000000000: 404,
  tok_flaky00000000000000000: 500,
  tok_hold0000000000000000000: 'hold',
  // its first look fails, and Try again finds a person's invite
  tok_flip00000000000000000: (S) => ((S.flips = (S.flips || 0) + 1) === 1 ? 500 : PERSON()),
};
const CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
const CODE = '.oc1.Q2mZp9X4vB1nW8cR5tYaKw.Ab3Cd4Ef5Gh.Hq3Lx8Zr2Vn6Bt0Wk4Sd9Fg1Jc7Pm5Ye3Ua6Io2NbXa';
const DCODE = '.ad1.Q2mZp9X4vB1nW8cR5tYaKw.Zz9Yy8Xx7Ww.Lq3Lx8Zr2Vn6Bt0Wk4Sd9Fg1Jc7Pm5Ye3Ua6Io2NbXb';
const DCODE_ID = 'Q2mZp9X4vB1nW8cR5tYaKw';
const VARIANTS = [
  { tag: 'desktop-light', w: 1280, h: 900, scheme: 'light' },
  { tag: 'desktop-dark', w: 1280, h: 900, scheme: 'dark' },
  { tag: 'phone-light', w: 390, h: 844, scheme: 'light', touch: true },
  { tag: 'phone-dark', w: 390, h: 844, scheme: 'dark', touch: true },
];
// the Worker's pinned apps, its sentences and its numbers, loaded below
let APPS, W, L;
const CALLBACK = { claude: 'https://claude.ai/api/mcp/auth_callback', 'claude-code': 'http://localhost:43123/callback' };

/** The authorize URL an app sends a person to, as its client builds it (the Worker checked it before it served the page). */
function authorizeUrl(appKey, extra = {}) {
  const a = APPS.find((x) => x.key === appKey);
  const q = new URLSearchParams({ response_type: 'code', client_id: a.client_id, redirect_uri: CALLBACK[appKey], code_challenge: CHALLENGE, code_challenge_method: 'S256', state: 'st-1', scope: 'rooms', resource: ORIGIN + '/api/mcp/signin', ...extra });
  return ORIGIN + '/oauth/authorize?' + q.toString();
}
/** The app's redirect address with params and iss appended, as the Worker builds it. */
function back(appKey, params) {
  const u = new URL(CALLBACK[appKey]);
  for (const [k, v] of Object.entries(params)) u.searchParams.append(k, v);
  u.searchParams.append('iss', ORIGIN);
  return u.toString();
}
const seats = (body, seat = 'new') => body.rooms.map((e) => ({ room: e.room, name: e.name || body.name, seat, opened: false }));
/** decide as the Worker answers a request that passes: the check, the approval (with the disconnect-only code), the decline. */
const DECIDE = (appKey) => async (body) => {
  if (body.approve === false) return { body: { redirect: back(appKey, { error: 'access_denied', state: 'st-1' }) } };
  if (body.check) return { body: { ok: true, rooms: seats(body) } };
  return { body: { redirect: back(appKey, { code: CODE, state: 'st-1' }), disconnect_code: DCODE, rooms: seats(body) } };
};

/**
 * One scenario on a browser of its own, every request answered here.
 * o.app: the app whose authorize URL is opened (o.url another address);
 * o.rooms: the rooms this browser holds (room -> token); o.store: more
 * storage keys; o.api: {decide(body, S), disconnect(body, S), looks};
 * o.stayBack: the app's callback answers 204 No Content, so the browser
 * stays on the page as it was when it left (a navigation still pending
 * would leave the page drawing nothing to take a picture of); o.stored: a
 * RegExp of the storage keys the scenario may add or remove (only
 * chat-signin:<id> is ever added); o.init: a script each page runs first.
 * An api answer is {status, body} (JSON), {status, html} or 'network'.
 * S.calls lists every request to the site (method, path, body), S.backs
 * every callback reached.
 */
async function scenario(name, o, fn) {
  if (process.env.ONLY && !process.env.ONLY.split(',').includes(name)) return;
  const b = await chromium.launch({});
  const ctx = await b.newContext({ serviceWorkers: 'block', viewport: { width: o.w || 1280, height: o.h || 900 }, colorScheme: o.scheme || 'light', hasTouch: !!o.touch, isMobile: !!o.touch, timezoneId: 'UTC', locale: 'en-US', permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await ctx.newPage();
  await installClock(page);
  trackNetwork(page);
  const errs = [];
  const watch = (pg) => {
    pg.on('pageerror', (e) => errs.push(e.message));
    pg.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
  };
  watch(page);
  ctx.on('page', watch);
  const S = { calls: [], unhandled: [], holds: [], backs: [] };
  if (o.init) await ctx.addInitScript(o.init);
  const api = o.api || {};
  const looks = Object.assign({}, LOOKS, api.looks || {});
  await ctx.route('**/*', async (route) => {
    const rq = route.request();
    const u = new URL(rq.url());
    const p = u.pathname, m = rq.method();
    const J = (body, status, headers) => route.fulfill({ status: status || 200, contentType: 'application/json', headers: headers || {}, body: JSON.stringify(body) });
    if (u.origin === ORIGIN) {
      if (p === '/oauth/authorize') { S.pages = (S.pages || 0) + 1; return route.fulfill(await authorizePage()); }
      if (p === '/' || p === '/index.html') return route.fulfill({ status: 200, contentType: 'text/html', body: HTML });
      if (p === '/api/build') return J({ build: 'uitestbuild1' });
      if (p.startsWith('/assets/')) { try { return route.fulfill({ status: 200, contentType: p.endsWith('.css') ? 'text/css' : 'text/javascript', body: require('fs').readFileSync(DIST + p) }); } catch { return route.fulfill({ status: 404, body: 'nf' }); } }
      if (p.startsWith('/icons/')) return route.fulfill({ status: 200, contentType: 'image/png', body: ICON_PNG });
      // a blank page of the site's, where the guard below reads a tab's sessionStorage once it has left
      if (p === '/__session') return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>session</title>' });
      // the browser's headers: an intercepted request shows no Sec-Fetch-Site here, so the Origin the browser sends with every POST stands for it
      const h = await rq.allHeaders();
      let body = null;
      try { body = rq.postData() ? JSON.parse(rq.postData()) : null; } catch { body = rq.postData(); }
      S.calls.push({ m, p, token: h['x-invite-token'] || '', auth: h.authorization || '', site: h['sec-fetch-site'] || (h.origin === ORIGIN ? 'same-origin' : h.origin || ''), body });
      const lm = /^\/api\/rooms\/([^/]+)\/invite$/.exec(p);
      if (lm && m === 'GET') {
        const v = typeof looks[h['x-invite-token']] === 'function' ? looks[h['x-invite-token']](S) : looks[h['x-invite-token']];
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
        if (out.html !== undefined) return route.fulfill({ status: out.status || 200, contentType: 'text/html', body: out.html });
        return J(out.body, out.status, out.headers);
      };
      if (p === '/api/oauth/decide' && m === 'POST') return call('decide', body);
      if (p === '/api/oauth/disconnect' && m === 'POST') return call('disconnect', body);
      S.unhandled.push(m + ' ' + p);
      return route.fulfill({ status: 404, body: 'nf' });
    }
    // the apps' own pages: a stand-in that starts a popup, and the callbacks the approval sends the browser to
    if (u.origin + p === 'https://claude.ai/start') return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>Claude</title><p>Connect</p>' });
    if (u.origin + p === CALLBACK.claude || u.origin + p === CALLBACK['claude-code']) {
      S.backs.push(u.toString());
      if (o.stayBack) return route.fulfill({ status: 204, body: '' });
      return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>Back in the app</title><p id="back">Back in the app</p><script>if (window.opener) window.opener.postMessage({ back: location.href }, "*");</script>' });
    }
    S.unhandled.push(m + ' ' + u.toString());
    return route.abort('blockedbyclient');
  });
  const rooms = o.rooms === undefined ? ROOMS : o.rooms;
  await ctx.addInitScript((seed) => {
    try {
      if (location.origin === seed.origin && !sessionStorage.getItem('seeded')) {
        sessionStorage.setItem('seeded', '1');
        for (const [room, tok] of Object.entries(seed.rooms)) { localStorage.setItem('chat-invite:' + room, tok); localStorage.setItem('chat-you:' + room, 'Anthony'); }
        for (const [k, v] of Object.entries(seed.store)) localStorage.setItem(k, v);
      }
    } catch { /* the scenario fails visibly */ }
  }, { origin: ORIGIN, rooms, store: o.store || {} });
  const seeded = Object.assign(Object.fromEntries(Object.entries(rooms).flatMap(([r, tok]) => [['chat-invite:' + r, tok], ['chat-you:' + r, 'Anthony']])), o.store || {});
  let out = null;
  try {
    await page.goto(o.url || authorizeUrl(o.app || 'claude'));
    await page.waitForSelector(o.ready || '#signinHead', { timeout: 10000 });
    if (!o.noSettle) await settle(page);
    out = await fn(page, S, ctx);
    for (const r of S.holds) r();
    const fatal = errs.filter((e) => !e.startsWith('console:'));
    if (fatal.length) throw new Error('uncaught page errors: ' + JSON.stringify(fatal));
    if (S.unhandled.length) throw new Error('requests the stub does not handle: ' + JSON.stringify(S.unhandled));
    const cons = badConsole(errs, o.allowConsole);
    if (cons.length) throw new Error('console errors: ' + JSON.stringify(cons));
    // the page asks the site only its looks and the sign-in's two calls, each same-origin
    const other = S.calls.filter((c) => !(/^\/api\/rooms\/[^/]+\/invite$/.test(c.p) && c.m === 'GET') && !(c.m === 'POST' && (c.p === '/api/oauth/decide' || c.p === '/api/oauth/disconnect')));
    if (other.length) throw new Error('the page asked something beyond the looks and the sign-in: ' + JSON.stringify(other.map((c) => c.m + ' ' + c.p)));
    const cross = S.calls.filter((c) => c.m === 'POST' && c.site !== 'same-origin');
    if (cross.length) throw new Error('a call that is not same-origin: ' + JSON.stringify(cross.map((c) => c.p + ' ' + c.site)));
    // the site's localStorage: every seeded value as it was (one the scenario may change can only be removed), and
    // nothing added but a connection's record where the scenario expects one
    const state = await ctx.storageState();
    const now = Object.fromEntries((state.origins.find((x) => x.origin === ORIGIN) || { localStorage: [] }).localStorage.map((x) => [x.name, x.value]));
    const may = (k) => !!(o.stored && o.stored.test(k));
    const bad = [];
    for (const [k, v] of Object.entries(seeded)) if (k in now ? now[k] !== v : !may(k)) bad.push((k in now ? 'changed ' : 'removed ') + k);
    for (const k of Object.keys(now)) if (!(k in seeded) && !(may(k) && /^chat-signin:[A-Za-z0-9_-]{22}$/.test(k))) bad.push('added ' + k);
    if (bad.length) throw new Error('storage changed: ' + JSON.stringify(bad));
    // no cookie on any origin
    const jar = await ctx.cookies();
    if (jar.length) throw new Error('a cookie was set: ' + JSON.stringify(jar.map((c) => c.domain + ' ' + c.name)));
    // every tab's sessionStorage on the site holds the seeding flag alone (a tab that left the site is brought back to a blank page of it to read its own)
    for (const pg of ctx.pages()) {
      if (pg.isClosed()) continue;
      if (new URL(pg.url()).origin !== ORIGIN) await pg.goto(ORIGIN + '/__session');
      const ss = await pg.evaluate(() => Object.entries(sessionStorage));
      if (JSON.stringify(ss) !== '[["seeded","1"]]') throw new Error('sessionStorage holds more than the seeding flag: ' + JSON.stringify(ss.map(([k]) => k)));
    }
    console.log('PASS ' + name + (out ? ' ' + JSON.stringify(out) : ''));
  } catch (e) {
    failed();
    console.log('FAIL ' + name + ': ' + (e && e.message ? String(e.message).split('\n')[0] : String(e)));
  } finally {
    for (const r of S.holds) r();
    await b.close();
  }
}

/** Every variant of one state: its own scenario and screenshot each, the target scrolled into view first. */
async function state(id, o, fn, target) {
  for (const v of VARIANTS) {
    await scenario('signin-' + id + '-' + v.tag, { ...o, w: v.w, h: v.h, scheme: v.scheme, touch: v.touch }, async (page, S) => {
      const r = await fn(page, S, v);
      if (target) await page.evaluate((sel) => { const el = document.querySelector(sel); if (el) el.scrollIntoView({ block: 'center' }); }, target);
      await page.evaluate(() => new Promise((r2) => requestAnimationFrame(() => requestAnimationFrame(r2))));
      await shot(page, 'signin-' + id + '-' + v.tag + '.png');
      return r;
    });
  }
}

/** true once fn() is, polled; false after ms */
const until = async (fn, ms = 5000) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await new Promise((r) => setTimeout(r, 20)); } return !!fn(); };
const text = (page, sel) => page.$eval(sel, (e) => e.innerText.replace(/\s+/g, ' ').trim());
const row = (page, room) => page.$eval('#signinRooms li[data-room="' + room + '"]', (e) => e.innerText.replace(/\s+/g, ' ').trim());
const tick = (page, room) => page.click('#signinRooms li[data-room="' + room + '"] .key-pick input');
const connect = (page) => page.click('#signinConnect');
const decides = (S) => S.calls.filter((c) => c.p === '/api/oauth/decide');
// the page's own sentences
const NEVER = 'Agent Chat never sends you a link to approve a connection: approve only one you started yourself, in your own app, a moment before.';
const LOST = "The site's answer didn't arrive, so this page can't tell whether the connection was made. If it was, the app never received it and nothing can use it. Choose Connect to try again: if the page then says this link was already used, start again from the app. Approving again with the same name uses the same seats.";
const UNKEPT = "This browser couldn't keep the record that lets you disconnect this connection, so the page stopped before the app received it: nothing is connected. The seats made stay unused, and approving again with the same name uses them. Free up this site's storage in your browser, then start again from the app.";
const UNFOLLOWED = "The site's answer can't be followed from this page. Start again from the app.";
// a page script that makes this browser refuse to keep a connection's record (setItem throws), or lose it (setItem keeps nothing)
const REFUSE_RECORD = '(() => { const set = Storage.prototype.setItem; Storage.prototype.setItem = function (k, v) { if (String(k).startsWith("chat-signin:")) throw new DOMException("full", "QuotaExceededError"); return set.call(this, k, v); }; })();';
const LOSE_RECORD = '(() => { const set = Storage.prototype.setItem; Storage.prototype.setItem = function (k, v) { if (String(k).startsWith("chat-signin:")) return; return set.call(this, k, v); }; })();';
// the platform's own page in place of the Worker's answer
const PLATFORM_502 = { status: 502, html: '<!doctype html><title>502 Bad Gateway</title><h1>Bad gateway</h1>' };
const USED = "This sign-in link has already been used. If you just approved it and the app didn't connect, start again from your own app: approving again uses the same seats. If you didn't approve it yourself, someone else may have sent you this link.";

(async () => {
  W = await workerModule('worker/agents/onboarding.ts');
  L = await workerModule('worker/limits.ts');
  APPS = (await workerModule('worker/lib/oauth.ts')).KNOWN_APPS;
  const AGREE = "It joins each room you tick as its own member: an agent named as you choose below, never as you. Members of those rooms see a new agent invited by you. It can read and post there like any agent member, until it leaves, the site's owner removes it, or this connection is disconnected. It holds no invite link: it reaches the rooms only through this connection. If it already has a seat in a room, that seat stays as it is; a Muse wake an earlier connection or key set up there stays that one's, and goes when it ends, unless this connection registers it too. Unused for " + L.OAUTH_IDLE_DAYS + ' days, the connection stops (its seats stay); you can disconnect it sooner under Agent keys in this browser.';

  // ---- every state, each app's heading first ----
  await state('claude', { app: 'claude', api: { decide: DECIDE('claude') } }, async (page) => {
    must((await text(page, '#signinHead')) === 'Claude (claude.ai) wants to join rooms of yours as an agent', await text(page, '#signinHead'));
    must((await text(page, '#signinWhy')) === "Someone asked Claude to connect to Agent Chat. Agent Chat can't tell who: only you know whether it was you.", await text(page, '#signinWhy'));
    must((await text(page, '#signinWarn')) === "Unless you pressed Connect in your own Claude a moment ago, choose Don't connect. If someone sent you this link, it is their Claude that would join your rooms. " + NEVER, await text(page, '#signinWarn'));
    must((await text(page, '#signinScope')) === L.SIGNIN_SCOPE_TEXT && (await text(page, '#signinAgreeMore')) === AGREE, 'what the person agrees to, word for word');
    must((await page.$eval('#signinName', (i) => i.value)) === 'Claude', 'the name before a room is ticked');
    must(await page.$eval('#signinConnect', (b) => b.disabled), 'Connect waits for a room');
    must((await row(page, 'family-trip')) === 'family-trip as Anthony', await row(page, 'family-trip'));
  });
  await state('code', { app: 'claude-code', api: { decide: DECIDE('claude-code') } }, async (page) => {
    must((await text(page, '#signinHead')) === 'Claude Code, a program on this computer, wants to join rooms of yours as an agent', await text(page, '#signinHead'));
    must((await text(page, '#signinWhy')) === "Someone asked Claude Code to connect to Agent Chat. Agent Chat can't tell who: only you know whether it was you.", await text(page, '#signinWhy'));
    must((await text(page, '#signinWarn')) === "Unless you started this in Claude Code on this computer a moment ago, choose Don't connect. Any program on this computer can ask in Claude Code's name. " + NEVER, await text(page, '#signinWarn'));
  });
  await state('ticked', { app: 'claude', api: { decide: DECIDE('claude') } }, async (page) => {
    await tick(page, 'book-club');
    must((await page.$eval('#signinName', (i) => i.value)) === 'Claude (Anthony)', 'the name is APP (YOU), YOU the person in the first ticked room');
    must(!(await page.$eval('#signinConnect', (b) => b.disabled)), 'Connect once a room is ticked');
  }, '#signinRooms');
  const LONG = {};
  for (let i = 1; i <= 30; i++) LONG['room-' + String(i).padStart(2, '0')] = 'tok_family0000000000000000';
  await state('long', { app: 'claude', rooms: LONG, api: { decide: DECIDE('claude') } }, async (page, S, v) => {
    await page.$eval('.signin-scroll', (e) => { e.scrollTop = e.scrollHeight; });
    const vh = v.h;
    for (const id of ['#signinDeny', '#signinConnect']) {
      const bx = await page.$eval(id, (e) => { const r = e.getBoundingClientRect(); return { top: r.top, bottom: r.bottom }; });
      must(bx.top >= 0 && bx.bottom <= vh, id + ' in view with 30 rooms: ' + JSON.stringify(bx));
    }
    await page.$eval('.signin-scroll', (e) => { e.scrollTop = Math.floor(e.scrollHeight / 2); });
  });
  const ROWS = { 'book-club': ROOMS['book-club'], 'agent-room': 'tok_work000000000000000000', 'gone-room': 'tok_gone000000000000000000', 'old-room': 'tok_old0000000000000000000', 'flaky-room': 'tok_flaky00000000000000000', 'slow-room': 'tok_hold0000000000000000000' };
  await state('rows', { app: 'claude', rooms: ROWS, api: { decide: DECIDE('claude') } }, async (page) => {
    await page.waitForFunction(() => /Couldn't check/.test(document.getElementById('signinRooms')?.innerText || ''), null, { timeout: 5000 });
    const got = {};
    for (const r of Object.keys(ROWS)) got[r] = await row(page, r);
    must(got['agent-room'] === "agent-room The invite this browser holds here is an agent's." && got['gone-room'] === 'gone-room This room no longer exists.' && got['old-room'] === "old-room This browser's invite here no longer works." && got['flaky-room'] === "flaky-room Couldn't check this room; try again. Try again" && got['slow-room'] === 'slow-room Checking…', JSON.stringify(got));
    for (const r of ['agent-room', 'gone-room', 'old-room', 'flaky-room', 'slow-room']) must(await page.$eval('#signinRooms li[data-room="' + r + '"] input', (i) => i.disabled), r + ' disabled');
  }, '#signinRooms');
  await state('agents', { app: 'claude', rooms: { 'work-notes': 'tok_work000000000000000000', 'lab': 'tok_work200000000000000000' }, api: { decide: DECIDE('claude') } }, async (page) => {
    await page.waitForSelector('#signinAgentsOnly', { timeout: 5000 });
    must((await text(page, '#signinAgentsOnly')) === "Your rooms in this browser are all agents' invites. Only a person's own invite can let an agent in.", await text(page, '#signinAgentsOnly'));
    must(!(await page.$('#signinConnect')) && !!(await page.$('#signinDeny')), "only Don't connect");
  });
  await state('norooms', { app: 'claude', rooms: {}, api: { decide: DECIDE('claude') } }, async (page) => {
    must((await text(page, '#signinNoRooms')) === 'This browser holds none of your rooms. If this page opened inside another app (WhatsApp, Muse, a mail app), open it in the browser you use for Agent Chat: Copy link. Otherwise, open one of your invite links in this browser first, then start the connection again. Copy link', await text(page, '#signinNoRooms'));
    must(!(await page.$('#signinConnect')) && !!(await page.$('#signinDeny')), "Copy link and Don't connect only");
    await page.click('#signinCopy');
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    must(copied === page.url(), 'the page\'s own address is copied: ' + copied);
  });
  const used = { decide: async (body) => (body.approve === false ? DECIDE('claude')(body) : { status: 409, body: { error: 'This sign-in link has already been used to connect.', code: 'request_used' } }) };
  await state('used', { app: 'claude', api: used }, async (page) => {
    await tick(page, 'family-trip');
    await connect(page);
    await page.waitForSelector('#signinUsed', { timeout: 5000 });
    must((await text(page, '#signinUsed')) === USED, await text(page, '#signinUsed'));
    must(!(await page.$('#signinConnect')) && !(await page.$('#signinRooms')), "only Don't connect");
  });
  const problem = {
    decide: async (body) => {
      if (body.approve === false) return DECIDE('claude')(body);
      return { body: { ok: false, rooms: [{ room: 'family-trip', name: body.name, problem: { status: 409, code: 'seat_in_use', error: W.seatInUseError('family-trip', body.name) } }, { room: 'book-club', name: body.name, problem: { status: 409, code: 'name_taken', error: W.nameTakenError('book-club', body.name) } }] } };
    },
  };
  await state('problem', { app: 'claude', api: problem }, async (page) => {
    await tick(page, 'family-trip');
    await tick(page, 'book-club');
    await connect(page);
    await page.waitForSelector('#signinErr', { timeout: 5000 });
    must((await text(page, '#signinErr')) === "Some rooms can't take the agent as it is: each one above says why.", await text(page, '#signinErr'));
    must((await row(page, 'family-trip')).includes('Claude (Anthony) is already a member here, invited by you: use that seat, or pick another name. Use Claude (Anthony)\'s seat here (already a member, invited by you)'), await row(page, 'family-trip'));
    must((await row(page, 'book-club')).includes('Claude (Anthony) is already taken here. Pick another name.'), await row(page, 'book-club'));
    must((await page.evaluate(() => document.activeElement && document.activeElement.id)) === 'signinRooms-book-club', 'focus on the first problem\'s room, in reading order');
  }, '#signinRooms');
  const full = { decide: async (body) => (body.approve === false ? DECIDE('claude')(body) : { body: { ok: false, rooms: seats(body), retry_after: 120 } }) };
  await state('full', { app: 'claude', api: full }, async (page) => {
    await tick(page, 'family-trip');
    await connect(page);
    await page.waitForSelector('#signinErr', { timeout: 5000 });
    must((await text(page, '#signinErr')) === 'Too many connections were made just now, from this network, for one of these rooms or on the whole site. Try again in 2 minutes.', await text(page, '#signinErr'));
    must(await page.$eval('#signinConnect', (b) => b.disabled), 'Connect waits for the counter');
  }, '#signinErr');
  // the approval held until the scenario ends, then answered with a failure, so nothing is made
  const busy = { decide: async (body, S) => { if (body.approve && !body.check) { await new Promise((r) => S.holds.push(r)); return { status: 500, body: { error: 'held' } }; } return DECIDE('claude')(body); } };
  await state('busy', { app: 'claude', rooms: { ...ROOMS, 'flaky-room': 'tok_flaky00000000000000000' }, api: busy, stayBack: true }, async (page) => {
    await page.waitForSelector('#signinRooms .key-retry', { timeout: 5000 });
    await tick(page, 'family-trip');
    await connect(page);
    await page.waitForFunction(() => document.getElementById('signinSay')?.textContent === 'Connecting…', null, { timeout: 5000 });
    // the rows' own buttons too: Try again on the room whose look failed, the other-name link on the ticked one
    const rowButtons = await page.$$eval('#signinRooms button', (els) => els.map((e) => e.textContent.trim()));
    must(rowButtons.includes('Try again') && rowButtons.includes('Use another name in this room'), 'the rows have their buttons: ' + JSON.stringify(rowButtons));
    const off = await page.$$eval('#signinRooms input, #signinRooms button, #signinName, #signinDeny, #signinConnect', (els) => els.filter((e) => !e.disabled).map((e) => e.id || e.outerHTML.slice(0, 60)));
    must(!off.length, 'every control disabled while it connects: ' + JSON.stringify(off));
    return { held: true };
  });
  const unused = {
    decide: async (body) => {
      if (body.approve === false || body.check) return DECIDE('claude')(body);
      return { status: 403, body: { error: 'Room "book-club": This invite link has been revoked. Ask whoever gave it to you for a new one.', code: 'invite_revoked', room: 'book-club', left_unused: ['family-trip'], note: W.unusedNote(['family-trip']) } };
    },
  };
  await state('unused', { app: 'claude', api: unused }, async (page) => {
    await tick(page, 'family-trip');
    await tick(page, 'book-club');
    await connect(page);
    await page.waitForSelector('#signinErr', { timeout: 5000 });
    must((await text(page, '#signinErr')) === 'Nothing was connected. The seat made in family-trip stays unused; approving again with the same name uses it.', await text(page, '#signinErr'));
    must((await row(page, 'book-club')).includes('This invite link has been revoked. Ask whoever gave it to you for a new one.'), await row(page, 'book-club'));
  }, '#signinRooms');
  const lost = { decide: async (body) => (body.approve && !body.check ? 'network' : DECIDE('claude')(body)) };
  await state('lost', { app: 'claude', api: lost, allowConsole: /net::ERR_FAILED/ }, async (page) => {
    await tick(page, 'family-trip');
    await connect(page);
    await page.waitForSelector('#signinErr', { timeout: 5000 });
    must((await text(page, '#signinErr')) === LOST, await text(page, '#signinErr'));
    must(!(await page.$eval('#signinConnect', (b) => b.disabled)), 'Connect stays: a request that was not approved is given back, so Connect tries again');
  }, '#signinErr');
  // the platform's own page in place of the approval's answer: as lost, since what was made is not known
  await state('lost-502', { app: 'claude', api: { decide: async (body) => (body.approve && !body.check ? PLATFORM_502 : DECIDE('claude')(body)) } }, async (page) => {
    await tick(page, 'family-trip');
    await connect(page);
    await page.waitForSelector('#signinErr', { timeout: 5000 });
    must((await text(page, '#signinErr')) === LOST, await text(page, '#signinErr'));
    must(!(await page.$eval('#signinConnect', (b) => b.disabled)), 'Connect stays');
  }, '#signinErr');
  // the browser cannot keep the connection's record: the app is not sent the connection, the page disconnects it, and says so
  const unkept = { decide: DECIDE('claude'), disconnect: async () => ({ body: { disconnected: true, wakes_left: [], note: W.signinDropNote([]) } }) };
  await state('unkept', { app: 'claude', api: unkept, init: REFUSE_RECORD, stayBack: true }, async (page, S) => {
    await tick(page, 'family-trip');
    await connect(page);
    await page.waitForSelector('#signinUnkept', { timeout: 5000 });
    must((await text(page, '#signinUnkept')) === UNKEPT, await text(page, '#signinUnkept'));
    must(await until(() => S.calls.some((c) => c.p === '/api/oauth/disconnect')), 'the page disconnects it');
    must(!S.backs.length, 'the app is not sent the connection: ' + JSON.stringify(S.backs));
    must(!(await page.$('#signinConnect')) && !(await page.$('#signinRooms')) && !(await page.$eval('#signinDeny', (b) => b.disabled)), "only Don't connect");
  }, '#signinUnkept');
  // a room whose look failed beside an agent's invite: the form, whose rows say why; Try again then finds the person's own invite
  await state('agent-failed', { app: 'claude', rooms: { 'work-notes': 'tok_work000000000000000000', 'flip-room': 'tok_flip00000000000000000' }, api: { decide: DECIDE('claude') } }, async (page) => {
    await page.waitForSelector('#signinRooms .key-retry', { timeout: 5000 });
    must(!(await page.$('#signinAgentsOnly')), 'not every invite is an agent\'s, so the sentence does not show');
    must(!!(await page.$('#signinForm')) && (await page.$eval('#signinConnect', (b) => b.disabled)), 'the form, with Connect waiting for a room');
    must((await row(page, 'work-notes')) === "work-notes The invite this browser holds here is an agent's." && (await row(page, 'flip-room')) === "flip-room Couldn't check this room; try again. Try again", (await row(page, 'work-notes')) + ' | ' + (await row(page, 'flip-room')));
  }, '#signinRooms');
  // the progress line, empty, stays in the bar (and in the accessibility tree) and takes no height
  await state('bar-empty', { app: 'claude', api: { decide: DECIDE('claude') } }, async (page) => {
    const m = await page.evaluate(() => {
      const say = document.getElementById('signinSay'), bar = document.querySelector('.signin-bar');
      const shown = { say: say.getBoundingClientRect().height, bar: bar.getBoundingClientRect().height, display: getComputedStyle(say).display, live: say.getAttribute('aria-live') };
      say.style.display = 'none';
      const gone = bar.getBoundingClientRect().height;
      say.style.display = '';
      return { ...shown, gone };
    });
    must(m.display !== 'none' && m.live === 'polite' && m.say === 0 && m.bar === m.gone, 'the empty line is rendered, live, and takes no height: ' + JSON.stringify(m));
    return m;
  }, '.signin-bar');
  // an answer the page will not follow (no http or https address): it stays, says so, and keeps Don't connect
  await state('stopped', { app: 'claude', api: { decide: async (body) => (body.check ? { body: { redirect: 'javascript:window.__ran=1' } } : DECIDE('claude')(body)) } }, async (page, S) => {
    const at = page.url();
    await tick(page, 'family-trip');
    await connect(page);
    await page.waitForSelector('#signinStopped', { timeout: 5000 });
    must((await text(page, '#signinStopped')) === UNFOLLOWED, await text(page, '#signinStopped'));
    must(page.url() === at && !S.backs.length && (await page.evaluate(() => window.__ran)) === undefined, 'no navigation, and no script ran');
    must(!(await page.$('#signinConnect')) && !(await page.$eval('#signinDeny', (b) => b.disabled)), "Don't connect stays");
  });
  await state('success', { app: 'claude', api: { decide: DECIDE('claude') }, stayBack: true, stored: /^chat-signin:/ }, async (page, S) => {
    await tick(page, 'family-trip');
    await connect(page);
    await page.waitForFunction(() => document.getElementById('signinSay')?.textContent === 'Returning you to Claude…', null, { timeout: 5000 });
    must(await until(() => S.backs.length === 1), 'the callback asked');
    return { back: S.backs[0] };
  });
  await state('declined', { app: 'claude', api: { decide: DECIDE('claude') }, stayBack: true }, async (page, S) => {
    await page.click('#signinDeny');
    await page.waitForFunction(() => document.getElementById('signinSay')?.textContent === 'Not connected. Returning you to Claude…', null, { timeout: 5000 });
    must(await until(() => S.backs.length === 1) && /error=access_denied/.test(S.backs[0]), 'the deny redirect: ' + S.backs[0]);
  });
  const reuse = { decide: async (body) => (body.check ? { body: { ok: true, rooms: [{ room: 'family-trip', name: body.name, seat: 'reused', opened: true }] } } : DECIDE('claude')(body)) };
  await state('reuse', { app: 'claude', api: reuse, stayBack: true }, async (page) => {
    await tick(page, 'family-trip');
    await connect(page);
    await page.waitForSelector('#signinReuse', { timeout: 5000 });
    must((await text(page, '#signinReuse')) === 'family-trip reuses a seat that already exists. Another key or connection that holds such a seat keeps working for it. Connect goes ahead.', await text(page, '#signinReuse'));
    must((await row(page, 'family-trip')).includes("Uses Claude (Anthony)'s seat here (already a member, invited by you). Another key or connection that holds this seat still works for it: disconnecting this connection does not cut that one."), await row(page, 'family-trip'));
  }, '#signinReuse');
  const wrong = { decide: async () => ({ status: 400, body: { error: 'This sign-in request is not valid.', code: 'invalid_request' } }) };
  await state('wrong', { app: 'claude', api: wrong }, async (page) => {
    await page.click('#signinDeny');
    await page.waitForSelector('#signinWrong', { timeout: 5000 });
    must((await text(page, '#signinWrong')) === "This sign-in link doesn't match the app it names, so it was stopped. Nothing was shared. Start again from the app.", await text(page, '#signinWrong'));
    must(!(await page.$('#signinDeny')) && !(await page.$('#signinConnect')), 'no button: the app is to start again');
  });

  // ---- what the page must do ----
  await scenario('signin-buttons-alike', { app: 'claude', api: { decide: DECIDE('claude') } }, async (page, S) => {
    must((await page.evaluate(() => document.activeElement && document.activeElement.id)) === 'signinHead', 'focus starts on the heading');
    await page.keyboard.press('Enter');
    await settle(page);
    must(!decides(S).length && !S.backs.length, 'Enter at load chooses neither button');
    await tick(page, 'family-trip');
    await page.click('#signinName');
    await page.keyboard.press('Enter');
    await settle(page);
    must(!decides(S).length && !S.backs.length, 'Enter in the name field chooses neither button');
    const style = (id) => page.$eval(id, (e) => { const s = getComputedStyle(e), r = e.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), color: s.color, bg: s.backgroundColor, border: s.borderTopColor, weight: s.fontWeight, size: s.fontSize, opacity: s.opacity }; });
    const a = await style('#signinDeny'), b = await style('#signinConnect');
    must(JSON.stringify(a) === JSON.stringify(b), 'the same size, weight and colours: ' + JSON.stringify([a, b]));
    const order = await page.$$eval('.signin-buttons .btn', (els) => els.map((e) => e.id));
    must(JSON.stringify(order) === '["signinDeny","signinConnect"]', "Don't connect first: " + JSON.stringify(order));
    await tick(page, 'family-trip');
    must(await page.$eval('#signinConnect', (x) => x.disabled), 'Connect disabled again with nothing ticked');
    return { a };
  });
  await scenario('signin-approve-requests', { app: 'claude', api: { decide: DECIDE('claude') }, stored: /^chat-signin:/ }, async (page, S, ctx) => {
    await tick(page, 'family-trip');
    await tick(page, 'book-club');
    await connect(page);
    await page.waitForSelector('#back', { timeout: 10000 });
    const q = new URL(authorizeUrl('claude')).search.slice(1);
    const d = decides(S);
    must(d.length === 2, 'a check, then the approval: ' + d.length);
    must(JSON.stringify(d[0].body) === JSON.stringify({ params: q, approve: true, name: 'Claude (Anthony)', rooms: [{ room: 'book-club', inviter_token: ROOMS['book-club'] }, { room: 'family-trip', inviter_token: ROOMS['family-trip'] }], check: true }), JSON.stringify(d[0].body));
    must(JSON.stringify(d[1].body) === JSON.stringify({ params: q, approve: true, name: 'Claude (Anthony)', rooms: [{ room: 'book-club', inviter_token: ROOMS['book-club'], reuse: 'none' }, { room: 'family-trip', inviter_token: ROOMS['family-trip'], reuse: 'none' }] }), JSON.stringify(d[1].body));
    const looks = S.calls.filter((c) => c.m === 'GET').map((c) => c.p).sort();
    must(JSON.stringify(looks) === '["/api/rooms/book-club/invite","/api/rooms/family-trip/invite"]', 'one look per room: ' + JSON.stringify(looks));
    must(S.backs.length === 1 && S.backs[0] === back('claude', { code: CODE, state: 'st-1' }), 'the app gets its code: ' + S.backs[0]);
    const st = await ctx.storageState();
    const rec = (st.origins.find((x) => x.origin === ORIGIN) || { localStorage: [] }).localStorage.find((x) => x.name === 'chat-signin:' + DCODE_ID);
    const v = rec ? JSON.parse(rec.value) : null;
    must(v && JSON.stringify(Object.keys(v)) === '["app","name","at","rooms","code"]' && v.app === 'claude' && v.name === 'Claude (Anthony)' && JSON.stringify(v.rooms) === '["book-club","family-trip"]' && v.code === DCODE && Math.abs(v.at - NOW) < 600e3, 'the record: ' + (rec && rec.value));
    return { record: v && Object.keys(v) };
  });
  await scenario('signin-approve-no-code', { app: 'claude-code', api: { decide: async (body) => { const r = await DECIDE('claude-code')(body); if (r.body.disconnect_code) delete r.body.disconnect_code; return r; } }, stayBack: true }, async (page, S) => {
    await tick(page, 'family-trip');
    await connect(page);
    await page.waitForFunction(() => document.getElementById('signinSay')?.textContent === 'Returning you to Claude Code…', null, { timeout: 5000 });
    must(await until(() => S.backs.length === 1) && S.backs[0].startsWith('http://localhost:43123/callback?code='), 'the loopback callback: ' + S.backs[0]);
  });
  // decide sends the request back to the app with its error, to the check or to the approval: the page goes with it, and keeps no record
  const errBack = back('claude', { error: 'invalid_request', state: 'st-1' });
  await scenario('signin-check-redirect', { app: 'claude', api: { decide: async (body) => (body.check ? { body: { redirect: errBack } } : DECIDE('claude')(body)) } }, async (page, S) => {
    await tick(page, 'family-trip');
    await connect(page);
    await page.waitForSelector('#back', { timeout: 10000 });
    must(S.backs.length === 1 && S.backs[0] === errBack, 'the app gets its error: ' + JSON.stringify(S.backs));
    must(decides(S).length === 1, 'nothing asked after the check: ' + decides(S).length);
  });
  await scenario('signin-approve-redirect', { app: 'claude', api: { decide: async (body) => (body.approve && !body.check ? { body: { redirect: errBack } } : DECIDE('claude')(body)) } }, async (page, S) => {
    await tick(page, 'family-trip');
    await connect(page);
    await page.waitForSelector('#back', { timeout: 10000 });
    must(S.backs.length === 1 && S.backs[0] === errBack, 'the app gets its error: ' + JSON.stringify(S.backs));
    must(decides(S).length === 2, 'the check, then the approval: ' + decides(S).length);
  });
  // a connection whose record this browser refuses to keep is never handed to the app: the page disconnects it once, with
  // its code, says so, and Don't connect tells the app it did not connect
  await scenario('signin-unkept-requests', { app: 'claude', api: unkept, init: REFUSE_RECORD }, async (page, S) => {
    await tick(page, 'family-trip');
    await connect(page);
    await page.waitForSelector('#signinUnkept', { timeout: 5000 });
    must(await until(() => S.calls.some((c) => c.p === '/api/oauth/disconnect')), 'the page disconnects it');
    await settle(page);
    const d = decides(S);
    must(d.length === 2 && d[0].body.check === true && !('check' in d[1].body), 'the check, then the approval: ' + JSON.stringify(d.map((x) => x.body.check)));
    const sent = S.calls.filter((c) => c.p === '/api/oauth/disconnect').map((c) => c.body);
    must(JSON.stringify(sent) === JSON.stringify([{ code: DCODE }]), 'one disconnect, with the code: ' + JSON.stringify(sent));
    must(!S.backs.length, 'the callback is not reached: ' + JSON.stringify(S.backs));
    await page.click('#signinDeny');
    await page.waitForSelector('#back', { timeout: 10000 });
    must(S.backs.length === 1 && S.backs[0] === back('claude', { error: 'access_denied', state: 'st-1' }), "Don't connect tells the app: " + JSON.stringify(S.backs));
    must(decides(S).length === 3 && decides(S)[2].body.approve === false, 'the decline');
  });
  // the same when the record is written but does not read back
  await scenario('signin-unkept-lost-write', { app: 'claude', api: unkept, init: LOSE_RECORD, stayBack: true }, async (page, S) => {
    await tick(page, 'family-trip');
    await connect(page);
    await page.waitForSelector('#signinUnkept', { timeout: 5000 });
    must(await until(() => S.calls.some((c) => c.p === '/api/oauth/disconnect')) && !S.backs.length, 'disconnected, and not handed to the app');
  });
  // and when that disconnect itself fails: the same sentence, and nothing else changes
  await scenario('signin-unkept-disconnect-fails', { app: 'claude', api: { decide: DECIDE('claude'), disconnect: async () => 'network' }, init: REFUSE_RECORD, stayBack: true, allowConsole: /net::ERR_FAILED/ }, async (page, S) => {
    await tick(page, 'family-trip');
    await connect(page);
    await page.waitForSelector('#signinUnkept', { timeout: 5000 });
    must(await until(() => S.calls.some((c) => c.p === '/api/oauth/disconnect')), 'the disconnect was tried');
    await settle(page);
    must((await text(page, '#signinUnkept')) === UNKEPT && !(await page.$('#signinErr')) && !(await page.$('#signinDeclineErr')) && !S.backs.length, 'the same sentence alone');
    must(!(await page.$eval('#signinDeny', (b) => b.disabled)), "Don't connect stays");
  });
  // an answer the page will not follow, to the decline: it stays, says so, and Don't connect can be chosen again
  await scenario('signin-stopped-decline', { app: 'claude', api: { decide: async (body) => (body.approve === false ? { body: { redirect: 'javascript:window.__ran=1' } } : DECIDE('claude')(body)) } }, async (page, S) => {
    await page.click('#signinDeny');
    await page.waitForSelector('#signinStopped', { timeout: 5000 });
    must((await page.evaluate(() => window.__ran)) === undefined && !S.backs.length, 'not followed');
    must(!(await page.$eval('#signinDeny', (b) => b.disabled)), "Don't connect again");
  });
  // the Worker's own 500 says what was made: it stays a refusal, said as before
  const worker500 = { decide: async (body) => (body.approve && !body.check ? { status: 500, body: { error: 'The connection could not be made. Try again.', left_unused: ['family-trip'], note: W.unusedNote(['family-trip']) } } : DECIDE('claude')(body)) };
  await scenario('signin-worker-500', { app: 'claude', api: worker500 }, async (page) => {
    await tick(page, 'family-trip');
    await connect(page);
    await page.waitForSelector('#signinErr', { timeout: 5000 });
    must((await text(page, '#signinErr')) === 'The connection could not be made. Try again. Nothing was connected. The seat made in family-trip stays unused; approving again with the same name uses it.', await text(page, '#signinErr'));
  });
  // only when every room's invite is an agent's does the page say so: beside a room whose look failed it shows the form,
  // and Try again, finding the person's own invite, makes that room tickable; beside a room that is gone, the form too
  await scenario('signin-agent-beside-failed', { app: 'claude', rooms: { 'work-notes': 'tok_work000000000000000000', 'flip-room': 'tok_flip00000000000000000' }, api: { decide: DECIDE('claude') } }, async (page) => {
    await page.waitForSelector('#signinRooms .key-retry', { timeout: 5000 });
    must(!(await page.$('#signinAgentsOnly')) && !!(await page.$('#signinForm')), 'the form, and no sentence');
    must(await page.$eval('#signinConnect', (b) => b.disabled), 'Connect waits while nothing is ticked');
    await page.click('#signinRooms li[data-room="flip-room"] .key-retry');
    await page.waitForFunction(() => /flip-room as Anthony/.test(document.getElementById('signinRooms')?.innerText.replace(/\s+/g, ' ') || ''), null, { timeout: 5000 });
    must(!(await page.$eval('#signinRooms-flip-room', (i) => i.disabled)) && (await page.$eval('#signinRooms-work-notes', (i) => i.disabled)), 'the person\'s room tickable, the agent\'s not');
    await tick(page, 'flip-room');
    must(!(await page.$eval('#signinConnect', (b) => b.disabled)), 'Connect once it is ticked');
  });
  await scenario('signin-agent-beside-gone', { app: 'claude', rooms: { 'work-notes': 'tok_work000000000000000000', 'gone-room': 'tok_gone000000000000000000' }, api: { decide: DECIDE('claude') } }, async (page) => {
    await page.waitForFunction(() => /no longer exists/.test(document.getElementById('signinRooms')?.innerText || ''), null, { timeout: 5000 });
    must(!(await page.$('#signinAgentsOnly')) && !!(await page.$('#signinForm')) && (await page.$eval('#signinConnect', (b) => b.disabled)), 'the form, no sentence, and Connect waiting');
  });
  await scenario('signin-decline-requests', { app: 'claude', api: { decide: DECIDE('claude') } }, async (page, S) => {
    await page.click('#signinDeny');
    await page.waitForSelector('#back', { timeout: 10000 });
    const d = decides(S);
    must(d.length === 1 && JSON.stringify(d[0].body) === JSON.stringify({ params: new URL(authorizeUrl('claude')).search.slice(1), approve: false }), JSON.stringify(d.map((x) => x.body)));
    must(S.backs[0] === back('claude', { error: 'access_denied', state: 'st-1' }), S.backs[0]);
  });
  await scenario('signin-no-join', { app: 'claude', api: { decide: DECIDE('claude') } }, async (page, S) => {
    await settle(page);
    const room = S.calls.filter((c) => /^\/api\/rooms\//.test(c.p)).map((c) => c.m + ' ' + c.p).sort();
    must(JSON.stringify(room) === '["GET /api/rooms/book-club/invite","GET /api/rooms/family-trip/invite"]', 'the page only looks at its rooms: ' + JSON.stringify(room));
  });
  await scenario('signin-unknown-app', { url: ORIGIN + '/oauth/authorize?client_id=' + encodeURIComponent('https://standin.example/app.json') + '&redirect_uri=' + encodeURIComponent('https://standin.example/cb') + '&response_type=code' }, async (page, S) => {
    must((await text(page, '#signinHead')) === "This app isn't known to Agent Chat yet, so it can't connect here. Nothing was shared. If you run this site, SIGNING IN at chat.victorio.cloud/api says how an app is added.", await text(page, '#signinHead'));
    must(!(await page.$('#signinDeny')) && !(await page.$('#signinConnect')) && !S.calls.length, 'no button, and no room asked');
  });
  // a stand-in claude.ai opens the page as a popup and waits for its callback's message, watching whether the window it holds reads closed
  await scenario('signin-popup', { url: 'https://claude.ai/start', ready: 'p', api: { decide: DECIDE('claude') }, stored: /^chat-signin:/ }, async (page, S, ctx) => {
    const url = authorizeUrl('claude');
    const popped = ctx.waitForEvent('page');
    await page.evaluate((u) => {
      window.__msgs = [];
      window.__closedEarly = false;
      window.addEventListener('message', (e) => window.__msgs.push(e.data));
      const w = window.open(u, 'signin', 'width=600,height=800');
      window.__win = w;
      const t = setInterval(() => { if (window.__msgs.length) clearInterval(t); else if (!w || w.closed) window.__closedEarly = true; }, 20);
    }, url);
    const pop = await popped;
    await pop.waitForSelector('#signinHead', { timeout: 10000 });
    await pop.waitForFunction(() => /as Anthony/.test(document.getElementById('signinRooms')?.innerText || ''), null, { timeout: 5000 });
    await pop.click('#signinRooms li[data-room="family-trip"] .key-pick input');
    await pop.click('#signinConnect');
    const arrived = await page.waitForFunction(() => window.__msgs.length > 0, null, { timeout: 10000 }).then(() => true, () => false);
    const r = await page.evaluate(() => ({ msgs: window.__msgs, closedEarly: window.__closedEarly }));
    must(arrived && r.msgs[0] && r.msgs[0].back === back('claude', { code: CODE, state: 'st-1' }), 'the callback\'s message reached the opener: ' + JSON.stringify(r));
    must(!r.closedEarly, 'the opener\'s handle never read closed before the callback ran');
    return { msgs: r.msgs.length };
  });
  // a retry after a lost answer in the made case: the approval went through, its answer did not reach the page; Connect again checks, and the check finds the link used
  let spent = false;
  const retry = {
    decide: async (body, S) => {
      if (body.approve === false) return DECIDE('claude')(body);
      if (spent) return { status: 409, body: { error: 'This sign-in link has already been used to connect.', code: 'request_used' } };
      if (body.check) return DECIDE('claude')(body);
      spent = true;
      S.spentAt = S.calls.length;
      return 'network';
    },
  };
  await scenario('signin-retry-lost-answer', { app: 'claude', api: retry, allowConsole: /net::ERR_FAILED/ }, async (page, S) => {
    await tick(page, 'family-trip');
    await connect(page);
    await page.waitForSelector('#signinErr', { timeout: 5000 });
    must((await text(page, '#signinErr')) === LOST, await text(page, '#signinErr'));
    await connect(page);
    await page.waitForSelector('#signinUsed', { timeout: 5000 });
    must((await text(page, '#signinUsed')) === USED, await text(page, '#signinUsed'));
    must(decides(S).length === 3, 'check, the approval whose answer was lost, the check that finds the link used: ' + decides(S).length);
  });
  // names and the server's sentences as text, never markup: a room name this browser holds, and a refusal (a person's own
  // name cannot hold < or >, which the name rules refuse)
  const MARK = { '<b>x</b>': 'tok_mark000000000000000000', 'family-trip': ROOMS['family-trip'] };
  const marked = { looks: { tok_mark000000000000000000: PERSON('Pat') }, decide: async (body) => (body.check ? { body: { ok: false, rooms: [{ room: '<b>x</b>', name: body.name, problem: { status: 403, code: 'invite_revoked', error: 'Room "<b>x</b>": <img src=x onerror=alert(1)> <b>refused</b>' } }] } } : DECIDE('claude')(body)) };
  await scenario('signin-text-not-markup', { app: 'claude', rooms: MARK, api: marked }, async (page) => {
    await page.waitForFunction(() => /<b>x<\/b> as Pat/.test(document.getElementById('signinRooms')?.innerText.replace(/\s+/g, ' ') || ''), null, { timeout: 5000 });
    await page.click('#signinRooms li[data-room="<b>x</b>"] .key-pick input');
    must((await page.$eval('#signinName', (i) => i.value)) === 'Claude (Pat)', 'the name from the room\'s look');
    await connect(page);
    await page.waitForSelector('#signinErr', { timeout: 5000 });
    const els = await page.$$eval('.signin b, .signin i, .signin img:not(.signin-brand img)', (e) => e.length);
    must(els === 0, 'no element made from a name or a sentence: ' + els);
    must((await page.$eval('#signinRooms li[data-room="<b>x</b>"]', (e) => e.innerText)).includes('<img src=x onerror=alert(1)> <b>refused</b>'), 'the sentence as text');
  });
  await scenario('signin-keyboard', { app: 'claude', api: { decide: DECIDE('claude') }, stayBack: true, stored: /^chat-signin:/ }, async (page) => {
    const ids = [];
    for (let i = 0; i < 4; i++) {
      await page.keyboard.press('Tab');
      ids.push(await page.evaluate(() => { const a = document.activeElement; return a ? a.id || a.textContent.trim() : ''; }));
    }
    must(JSON.stringify(ids) === JSON.stringify(['signinName', 'signinRooms-book-club', 'signinRooms-family-trip', 'signinDeny']), "from the heading, Tab reaches the name, the rooms, then Don't connect (Connect waits for a room): " + JSON.stringify(ids));
    await page.focus('#signinRooms-family-trip');
    await page.keyboard.press('Space');
    must(await page.$eval('#signinRooms-family-trip', (i) => i.checked), 'Space ticks a room');
    await page.focus('#signinConnect');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.getElementById('signinSay')?.textContent === 'Returning you to Claude…', null, { timeout: 5000 });
    return { tabs: ids };
  });

  // ---- the Agent keys view's third section ----
  const REC = (o) => JSON.stringify({ app: 'claude', name: 'Claude (Anthony)', at: NOW - 2 * D, rooms: ['family-trip', 'book-club'], code: DCODE, ...o });
  const CODE2 = '.ad1.R3nAq0Y5wC2oX9dS6uZbLx.Mm1Nn2Oo3Pp.Kq3Lx8Zr2Vn6Bt0Wk4Sd9Fg1Jc7Pm5Ye3Ua6Io2NbXc';
  const STORE = { ['chat-signin:' + DCODE_ID]: REC(), 'chat-signin:R3nAq0Y5wC2oX9dS6uZbLx': REC({ app: 'claude-code', name: 'Claude Code (Anthony)', at: NOW - 9 * D, rooms: ['book-club'], code: CODE2 }) };
  const KEYS = { url: ORIGIN + '/#keys', ready: '#view-keys', store: STORE };
  // the first disconnect leaves a room to confirm its wakes, the next one finishes
  const leftThenDone = { disconnect: async (body, S) => { S.rounds = (S.rounds || 0) + 1; return S.rounds === 1 ? { body: { disconnected: true, wakes_left: ['family-trip'], note: W.signinDropNote(['family-trip']) } } : { body: { disconnected: true, wakes_left: [], note: W.signinDropNote([]) } }; } };
  await state('conns', { ...KEYS, api: {} }, async (page) => {
    await page.waitForSelector('#keyConns', { timeout: 5000 });
    const rows = await page.$$eval('#keyConnList li', (els) => els.map((e) => e.innerText.replace(/\s+/g, ' ').trim()));
    must(JSON.stringify(rows) === JSON.stringify(['Claude, approved Nov 18, in family-trip, book-club Disconnect Forget', 'Claude Code, approved Nov 11, in book-club Disconnect Forget']), JSON.stringify(rows));
    must(!(await page.$('#keyConns .key-leave')) && !(await page.$$eval('#keyConns button', (b) => b.some((x) => /Leave/.test(x.textContent)))), 'no Leave for a connection');
  }, '#keyConns');
  await state('conns-left', { ...KEYS, api: leftThenDone, stored: /^chat-signin:/ }, async (page) => {
    await page.click('#keyConnList li[data-conn="' + DCODE_ID + '"] .key-conn-drop');
    await page.waitForSelector('#keyConnDropDlg[open]', { timeout: 4000 });
    must((await text(page, '#keyConnDropDlg')) === "Disconnect Claude everywhere? It stops working at once in every room it joined through this connection. It stays a member of each of those rooms that still takes its invite, until it leaves or the site's owner removes it. It lets go of the Muse wakes it set up: each one goes, unless another key or connection holding the same seat, or a registration with the room's own token, also holds it. Cancel Disconnect", await text(page, '#keyConnDropDlg'));
    await page.click('#keyConnDropYes');
    await page.waitForFunction(() => /family-trip/.test(document.getElementById('keyConnSay')?.textContent || ''), null, { timeout: 5000 });
    must((await text(page, '#keyConnSay')) === W.signinDropNote(['family-trip']), await text(page, '#keyConnSay'));
    must((await text(page, '#keyConnList li[data-conn="' + DCODE_ID + '"] .key-conn-drop')) === 'Disconnect again', 'the record stays, to finish its wakes');
  }, '#keyConns');
  await state('conns-dialog', { ...KEYS, api: {} }, async (page) => {
    await page.waitForSelector('#keyConns', { timeout: 5000 });
    await page.click('#keyConnList li[data-conn="' + DCODE_ID + '"] .key-conn-drop');
    await page.waitForSelector('#keyConnDropDlg[open]', { timeout: 4000 });
    must((await text(page, '#keyConnDropDlg')).includes("It stays a member of each of those rooms that still takes its invite, until it leaves or the site's owner removes it."), await text(page, '#keyConnDropDlg'));
  });
  // a disconnect whose wake list did not open: the site ended the connection all the same, so its record goes and nothing is offered again
  const unreadable = { disconnect: async () => ({ body: { disconnected: true, wakes_left: null, note: W.signinDropNote(null) } }) };
  await state('conns-unreadable', { ...KEYS, api: unreadable, stored: /^chat-signin:/ }, async (page) => {
    await page.click('#keyConnList li[data-conn="' + DCODE_ID + '"] .key-conn-drop');
    await page.waitForSelector('#keyConnDropDlg[open]', { timeout: 4000 });
    await page.click('#keyConnDropYes');
    await page.waitForFunction((n) => document.getElementById('keyConnSay')?.textContent === n, W.signinDropNote(null), { timeout: 5000 });
    must((await page.evaluate((k) => localStorage.getItem(k), 'chat-signin:' + DCODE_ID)) === null, 'its record removed');
    must(!(await page.$('#keyConnList li[data-conn="' + DCODE_ID + '"]')) && !/Disconnect again/.test(await text(page, '#keyConns')), 'its row is gone, and nothing says Disconnect again');
  }, '#keyConns');
  // the For agents view's card: Claude's apps sign in, and the same reminder as the approval page's
  await state('agents-card', { url: ORIGIN + '/#agents', ready: '#view-agents', api: {} }, async (page) => {
    must((await text(page, '#agentsSignin')) === 'Sign in from Claude Claude and Claude Code can join your rooms without a key: add a connector for chat.victorio.cloud/api/mcp/signin, connect, and approve the rooms on the page that opens. ' + NEVER, await text(page, '#agentsSignin'));
  }, '#agentsSignin');
  await scenario('signin-conns-disconnect-again', { ...KEYS, api: leftThenDone, stored: /^chat-signin:/ }, async (page, S, ctx) => {
    await page.waitForSelector('#keyConns', { timeout: 5000 });
    await page.click('#keyConnList li[data-conn="' + DCODE_ID + '"] .key-conn-drop');
    await page.waitForSelector('#keyConnDropDlg[open]', { timeout: 4000 });
    await page.click('#keyConnDropYes');
    await page.waitForFunction(() => /Disconnect again/.test(document.getElementById('keyConnList')?.innerText || ''), null, { timeout: 5000 });
    const kept = await page.evaluate((k) => localStorage.getItem(k), 'chat-signin:' + DCODE_ID);
    must(kept === STORE['chat-signin:' + DCODE_ID], 'kept while a room is left to confirm');
    await page.click('#keyConnList li[data-conn="' + DCODE_ID + '"] .key-conn-drop');
    await page.waitForFunction(() => /it has let go of every Muse wake/.test(document.getElementById('keyConnSay')?.textContent || ''), null, { timeout: 5000 });
    must((await page.evaluate((k) => localStorage.getItem(k), 'chat-signin:' + DCODE_ID)) === null, 'removed once none is left');
    must(!(await page.$('#keyConnList li[data-conn="' + DCODE_ID + '"]')), 'its row is gone');
    const sent = S.calls.filter((c) => c.p === '/api/oauth/disconnect').map((c) => c.body);
    must(JSON.stringify(sent) === JSON.stringify([{ code: DCODE }, { code: DCODE }]), JSON.stringify(sent));
    const st = await ctx.storageState();
    const left = (st.origins.find((x) => x.origin === ORIGIN) || { localStorage: [] }).localStorage.map((x) => x.name).filter((k) => k.startsWith('chat-signin:'));
    must(JSON.stringify(left) === '["chat-signin:R3nAq0Y5wC2oX9dS6uZbLx"]', 'the other record untouched: ' + JSON.stringify(left));
  });
  await scenario('signin-conns-unknown', { ...KEYS, api: { disconnect: async () => ({ body: { disconnected: false, code: 'unknown' } }) }, stored: /^chat-signin:/ }, async (page) => {
    await page.waitForSelector('#keyConns', { timeout: 5000 });
    await page.click('#keyConnList li[data-conn="' + DCODE_ID + '"] .key-conn-drop');
    await page.waitForSelector('#keyConnDropDlg[open]', { timeout: 4000 });
    await page.click('#keyConnDropYes');
    await page.waitForFunction(() => document.getElementById('keyConnSay')?.textContent === 'This connection had already ended.', null, { timeout: 5000 });
    must((await page.evaluate((k) => localStorage.getItem(k), 'chat-signin:' + DCODE_ID)) === null, 'removed');
  });
  await scenario('signin-conns-network', { ...KEYS, api: { disconnect: async () => 'network' }, allowConsole: /net::ERR_FAILED/ }, async (page) => {
    await page.waitForSelector('#keyConns', { timeout: 5000 });
    await page.click('#keyConnList li[data-conn="' + DCODE_ID + '"] .key-conn-drop');
    await page.waitForSelector('#keyConnDropDlg[open]', { timeout: 4000 });
    await page.click('#keyConnDropYes');
    await page.waitForFunction(() => /Couldn't reach the site/.test(document.getElementById('keyConnDropDlg')?.innerText || ''), null, { timeout: 5000 });
    must((await page.evaluate((k) => localStorage.getItem(k), 'chat-signin:' + DCODE_ID)) !== null, 'kept');
  });
  await scenario('signin-conns-forget', { ...KEYS, api: {}, stored: /^chat-signin:/ }, async (page, S) => {
    await page.waitForSelector('#keyConns', { timeout: 5000 });
    await page.click('#keyConnList li[data-conn="' + DCODE_ID + '"] .key-conn-forget');
    await page.waitForSelector('#keyConnForgetDlg[open]', { timeout: 4000 });
    must((await text(page, '#keyConnForgetDlg')) === 'Forget this connection here? It keeps working; you will not be able to disconnect it from this browser. Cancel Forget', await text(page, '#keyConnForgetDlg'));
    // Escape closes it, and nothing goes
    await page.keyboard.press('Escape');
    must(!(await page.$eval('#keyConnForgetDlg', (d) => d.open)) && (await page.evaluate((k) => localStorage.getItem(k), 'chat-signin:' + DCODE_ID)) !== null, 'Escape keeps it');
    await page.click('#keyConnList li[data-conn="' + DCODE_ID + '"] .key-conn-forget');
    await page.waitForSelector('#keyConnForgetDlg[open]', { timeout: 4000 });
    await page.click('#keyConnForgetYes');
    must((await page.evaluate((k) => localStorage.getItem(k), 'chat-signin:' + DCODE_ID)) === null, 'forgotten here');
    must(!S.calls.some((c) => c.p === '/api/oauth/disconnect'), 'Forget asks the site nothing');
  });
  await scenario('signin-conns-none', { url: ORIGIN + '/#keys', ready: '#view-keys', api: {} }, async (page) => {
    await settle(page);
    must(!(await page.$('#keyConns')), 'no third section without a record');
  });
  done('signin');
})().catch((e) => {
  console.log('FAIL signin: ' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
