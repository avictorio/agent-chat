// UI scenarios: the room shell: error boundaries, the agent gate, layout, update banner, pull to refresh, the bell, access, unread, and the home page.
// Run alone: node -r ./tests/system-chromium.js tests/ui/shell.test.js
// (ONLY=name1,name2 runs just those). All files: npm test.
const { settle, installClock, fakePush, must, DIST, HTML, ICON_PNG, OUT, badConsole, chromium, done, failed, run, shot } = require('./harness');

(async () => {
  // Error boundaries: a message the feed can't render (here malformed
  // reactions from the API: one name where a list belongs) shows a
  // one-line notice in its place; the rest of the chat, the message box
  // and the other views keep working. Without the boundaries the render
  // error would unmount the whole page.
  await run('error-boundary-row', { state: { broken: true }, allowConsole: /message 71|is not a function|Cannot read|Objects are not valid|The above error/ }, async (page) => {
    await page.waitForSelector('#msgs .msg', { timeout: 10000 });
    const out = await page.evaluate(() => ({
      notice: ((document.querySelector('#msgs .err-box') || {}).textContent || '').trim(),
      rows: document.querySelectorAll('#msgs .msg').length,
      composer: !!document.getElementById('text'),
    }));
    if (!/Message 71 couldn't be shown/.test(out.notice)) throw new Error('no notice in place of the broken message: ' + JSON.stringify(out));
    if (out.rows < 3 || !out.composer) throw new Error('the rest of the room did not render: ' + JSON.stringify(out));
    await shot(page, 'error-boundary-row.png');
    await page.click('#tabs .tab[data-tab="decisions"]');
    await settle(page);
    out.decisions = await page.$$eval('#view-decisions .card', (c) => c.length);
    if (!out.decisions) throw new Error('another view did not render after the broken message: ' + JSON.stringify(out));
    return out;
  });
  await run('error-boundary-row-mobile-dark', { state: { broken: true }, w: 390, h: 844, touch: true, scheme: 'dark', allowConsole: /message 71|is not a function|Cannot read|Objects are not valid|The above error/ }, async (page) => {
    await page.waitForSelector('#msgs .err-box', { timeout: 10000 });
    const box = await page.$eval('#msgs .err-box', (e) => { const r = e.getBoundingClientRect(); return { w: Math.round(r.width), right: Math.round(r.right), text: e.textContent.trim() }; });
    if (box.right > 390) throw new Error('the notice overflows a phone: ' + JSON.stringify(box));
    await page.$eval('#msgs .err-box', (e) => e.scrollIntoView({ block: 'center' }));
    await shot(page, 'error-boundary-row-mobile-dark.png');
    return box;
  });
  // Smoke: proves the harness discriminates and the wiring works —
  // invite fragment stored and scrubbed, fixture messages fetched through
  // the typed client and rendered.
  await run('skeleton', { hash: '#invite=tok_Anthony' }, async (page) => {
    const out = {};
    await page.waitForSelector('.msg', { timeout: 10000 });
    out.msgs = await page.$$eval('.msg', els => els.length);
    out.stored = await page.evaluate(() => { try { return localStorage.getItem('chat-invite:demo'); } catch { return null; } });
    out.hashAfter = await page.evaluate(() => location.hash);
    if (out.msgs < 5) throw new Error('skeleton should render the fixture messages, got ' + out.msgs);
    if (out.stored !== 'tok_Anthony') throw new Error('invite not stored under chat-invite:demo: ' + out.stored);
    if (out.hashAfter !== '') throw new Error('invite fragment not scrubbed: ' + out.hashAfter);
    await shot(page, 'skeleton.png');
    return out;
  });
  await run('agent-gate', { state: { agentYou: true } }, async (page) => {
    const out = {};
    await page.waitForSelector('#view-agent:not([hidden])', { timeout: 10000 });
    out.block = await page.$eval('#agentBlock', e => e.textContent);
    out.intro = await page.$eval('#agentIntro', e => e.textContent);
    if (!/\/api\/rooms\/demo\/mcp/.test(out.block)) throw new Error('setup block must name the MCP endpoint: ' + out.block.slice(0, 80));
    if (!/X-Invite-Token: tok_Probe/.test(out.block)) throw new Error('setup block must carry the invite header');
    if (!/Probe/.test(out.intro)) throw new Error('intro must name the agent: ' + out.intro);
    await shot(page, 'agent-gate.png');
    await page.click('#agentApp');
    await page.waitForSelector('#view-chat:not([hidden])', { timeout: 10000 });
    out.chatAfterEscape = true;
    await page.reload();
    await settle(page);
    out.gateAfterReload = await page.$eval('#view-agent', e => !e.hidden);
    if (out.gateAfterReload) throw new Error('agent gate must not reappear after the escape on this device');
    return out;
  });

  // An agent's invite opened in a browser with its token: the setup view
  // comes from the preview (GET /invite), and nothing reads the room (which
  // would open the invite as the agent) until the person picks the web app.
  await run('agent-gate-preview', { state: { agentYou: true }, hash: '#invite=tok_Probe' }, async (page, S) => {
    await page.waitForSelector('#view-agent:not([hidden])', { timeout: 10000 });
    const block = await page.$eval('#agentBlock', e => e.textContent);
    if (!/X-Invite-Token: tok_Probe/.test(block)) throw new Error('setup block must come from the preview: ' + block.slice(0, 80));
    await page.waitForTimeout(800);
    const before = (S.hits || []).slice();
    if (!before.includes('GET /invite')) throw new Error('the preview was not asked: ' + JSON.stringify(before));
    if (before.includes('GET /messages')) throw new Error('the room was read before the person chose the web app: ' + JSON.stringify(before));
    await shot(page, 'agent-gate-preview.png');
    await page.click('#agentApp');
    await page.waitForSelector('#view-chat:not([hidden])', { timeout: 10000 });
    await page.waitForFunction(() => document.querySelectorAll('#messages .msg, #messages [data-id]').length > 0, null, { timeout: 10000 }).catch(() => {});
    const after = (S.hits || []).slice();
    if (!after.includes('GET /messages')) throw new Error('choosing the web app must load the room: ' + JSON.stringify(after));
    return { previewFirst: true, readAfterChoice: true };
  });
  // A person's own invite: the preview says human, the room loads as usual.
  await run('human-invite-preview', { hash: '#invite=tok_Anthony' }, async (page, S) => {
    await page.waitForSelector('#view-chat:not([hidden])', { timeout: 10000 });
    await settle(page);
    const hits = S.hits || [];
    if (!hits.includes('GET /invite') || !hits.includes('GET /messages')) throw new Error('expected a preview, then the read: ' + JSON.stringify(hits));
    if (await page.$eval('#view-agent', e => !e.hidden)) throw new Error('no setup view for a person');
    return { hits: hits.length };
  });

  // The room page's note for AI agents (stamped by the Worker outside
  // #root) is gone once the app runs: people never see or hear it.
  await run('agent-note-removed', {}, async (page) => {
    await settle(page);
    const left = await page.evaluate(() => ({ el: !!document.getElementById('agent-note'), text: /If you are an AI agent/.test(document.body.innerText) }));
    if (left.el || left.text) throw new Error('the agent note is still in the page: ' + JSON.stringify(left));
    return left;
  });

  // --- layout and themes, update banner, site notice, pull to refresh, the bell, access ---
  for (const scheme of ['light', 'dark']) {
    await run('desktop-' + scheme, { scheme }, async (page) => {
      await shot(page, scheme + '-chat.png');
      for (const t of ['constitution', 'decisions', 'questions', 'stakes', 'memory', 'members']) { await page.click('.tab[data-tab="' + t + '"]'); await settle(page); await shot(page, scheme + '-' + t + '.png'); }
      const counts = await page.$$eval('.tab .count', els => els.map(e => e.parentElement.dataset.tab + '=' + e.textContent + (e.classList.contains('alert') ? '!' : '')));
      // Sidebar counts for this fixture, asserted so a counts
      // divergence cannot pass silently: stakes count when due within
      // SEVEN days, decisions when an active member has not signed.
      const wantCounts = ['chat=', 'games=', 'media=', 'constitution=', 'decisions=2!', 'questions=2', 'stakes=1!', 'memory=', 'members=3'];
      if (JSON.stringify(counts) !== JSON.stringify(wantCounts)) throw new Error('sidebar counts diverge from production: got ' + JSON.stringify(counts));
      return { counts, hash: await page.evaluate(() => location.hash) };
    });
  }
  await run('mobile-light', { w: 390, h: 844 }, async (page) => {
    await shot(page, 'mobile-chat.png');
    await page.click('#menu'); await settle(page); await shot(page, 'mobile-drawer.png');
    await page.click('.tab[data-tab="decisions"]'); await settle(page); await shot(page, 'mobile-decisions.png');
    const sw = await page.evaluate(() => document.documentElement.scrollWidth);
    return { scrollWidth: sw };
  });
  await run('mobile-dark', { w: 390, h: 844, scheme: 'dark' }, async (page) => { await shot(page, 'mobile-dark-chat.png'); await page.click('#menu'); await settle(page); await shot(page, 'mobile-dark-drawer.png'); });
  // Update banner: the page is stamped uitestbuild1, /api/build reports
  // uitestbuild2, so the banner shows; dismissal is per build and the
  // Refresh button reloads the page.
  await run('update-banner', { state: { behind: true } }, async (page) => {
    const out = {};
    out.meta = await page.$eval('meta[name="build"]', e => e.getAttribute('content'));
    await page.waitForSelector('#updateStrip:not([hidden])', { timeout: 10000 });
    await shot(page, 'update-banner.png');
    await page.click('#updateDismiss');
    await page.waitForFunction(() => document.getElementById('updateStrip').hidden, null, { timeout: 10000 });
    await page.reload(); await settle(page);
    out.afterDismissReload = await page.$eval('#updateStrip', e => e.hidden);
    await page.evaluate(() => localStorage.removeItem('ac:build-dismissed'));
    await page.reload();
    await page.waitForSelector('#updateStrip:not([hidden])', { timeout: 10000 });
    await Promise.all([page.waitForNavigation({ timeout: 10000 }), page.click('#updateRefresh')]);
    await page.waitForSelector('#updateStrip:not([hidden])', { timeout: 10000 });
    out.refreshReloaded = true;
    if (out.meta !== 'uitestbuild1') throw new Error('page build meta wrong: ' + out.meta);
    if (!out.afterDismissReload) throw new Error('dismissal did not persist across reload');
    return out;
  });
  await run('update-banner-mobile', { state: { behind: true }, w: 390, h: 844, touch: true }, async (page) => {
    await page.waitForSelector('#updateStrip:not([hidden])', { timeout: 10000 });
    await shot(page, 'update-banner-mobile.png');
    return { ok: true };
  });
  // Site notice: the newest notice from GET /api/changes shows in a strip;
  // dismissing it remembers its id, and a newer notice shows again.
  const NOTICE_A = { id: 'n-old', date: '2026-11-10', until: '2026-12-31', text: 'An older notice that should not show.' };
  const NOTICE_B = { id: 'n-new', date: '2026-11-21', until: '2026-12-31', text: 'Refusals now carry a machine-readable code beside their sentence: branch on code. Authorization: Bearer TOKEN works wherever X-Invite-Token does.' };
  await run('site-notice', { state: { notices: [NOTICE_A, NOTICE_B] } }, async (page) => {
    await page.waitForSelector('#noticeStrip', { timeout: 10000 });
    const text = await page.$eval('#noticeStrip', e => e.textContent);
    if (!/machine-readable code/.test(text) || /older notice/.test(text)) throw new Error('strip should show the newest notice: ' + text);
    await shot(page, 'site-notice.png');
    await page.click('#noticeDismiss');
    await page.waitForFunction(() => !document.getElementById('noticeStrip'), null, { timeout: 10000 });
    await page.reload(); await settle(page);
    const back = await page.$('#noticeStrip');
    if (back) throw new Error('a dismissed notice came back after reload');
    return { shown: true, dismissedStays: true };
  });
  await run('site-notice-mobile', { state: { notices: [NOTICE_B] }, w: 390, h: 844, touch: true }, async (page) => {
    await page.waitForSelector('#noticeStrip', { timeout: 10000 });
    await shot(page, 'site-notice-mobile.png');
    const sw = await page.evaluate(() => document.documentElement.scrollWidth);
    if (sw > 390) throw new Error('the notice strip scrolls the page sideways: ' + sw);
    return { scrollWidth: sw };
  });
  await run('site-notice-none', {}, async (page) => {
    await settle(page);
    if (await page.$('#noticeStrip')) throw new Error('no notice: no strip');
    return { none: true };
  });
  await run('update-banner-current', {}, async (page) => {
    await settle(page);
    const hidden = await page.$eval('#updateStrip', e => e.hidden);
    if (!hidden) throw new Error('banner must stay hidden when the build is current');
    return { hidden };
  });
  // Pull-to-refresh: a downward drag from the top bar. A short drag only
  // shows the hint; past the threshold, releasing reloads the page.
  await run('pull-refresh-mobile', { w: 390, h: 844, touch: true }, async (page) => {
    const out = {};
    const drag = (dy) => page.evaluate((d) => {
      const bar = document.querySelector('.topbar');
      const mk = (t, y) => new PointerEvent(t, { clientY: y, bubbles: true, pointerId: 7, isPrimary: true });
      bar.dispatchEvent(mk('pointerdown', 120));
      bar.dispatchEvent(mk('pointermove', 120 + d));
    }, dy);
    const release = () => page.evaluate(() => {
      document.querySelector('.topbar').dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 7, isPrimary: true }));
    });
    await drag(30);
    out.shortHint = await page.$eval('#pullHintText', e => e.textContent);
    await release(); await settle(page);
    out.shortHidden = await page.$eval('#pullHint', e => e.hidden);
    await drag(120);
    out.fullHint = await page.$eval('#pullHintText', e => e.textContent);
    await shot(page, 'pull-refresh-mobile.png');
    await Promise.all([page.waitForNavigation({ timeout: 10000 }), release()]);
    out.reloaded = true;
    if (out.shortHint !== 'Pull to refresh') throw new Error('short drag hint wrong: ' + out.shortHint);
    if (!out.shortHidden) throw new Error('hint must hide after a short drag');
    if (out.fullHint !== 'Release to refresh') throw new Error('full drag hint wrong: ' + out.fullHint);
    return out;
  });
  await run('push-bell', { init: () => { try { Object.defineProperty(Notification, 'permission', { get: () => 'default' }); } catch {} } }, async (page) => {
    // Regression guard: when /sw.js fails to register,
    // serviceWorker.ready never resolves, so the bell must be painted
    // from the support rule up front, not at the end of that async
    // check. The harness 404s /sw.js; with the permission stubbed to
    // "default" (undecided) the bell must still appear.
    const out = {};
    out.perm = await page.evaluate(() => Notification.permission);
    if (out.perm !== 'default') throw new Error('permission stub did not take: ' + out.perm);
    await settle(page);
    out.vis = await page.$$eval('.pushBtn', bs => bs.map(b => !b.hidden));
    if (!out.vis.some(Boolean)) throw new Error('push bell never became visible: ' + JSON.stringify(out));
    return out;
  });
  // The bell on a device with push (the browser's push machinery faked,
  // the room's registry in S.push). seedPush: this device's subscription,
  // registered in the room in "every message" mode, as after turning the
  // bell on; seeded once, so a reload or navigation keeps what changed.
  const EP = 'https://fcm.googleapis.com/fcm/send/fake-seeded';
  const seedPush = () => {
    try {
      if (!sessionStorage.getItem('seeded')) {
        sessionStorage.setItem('seeded', '1');
        localStorage.setItem('chat-invite:demo', 'tok_Anthony');
        localStorage.setItem('__fake_push_sub', 'https://fcm.googleapis.com/fcm/send/fake-seeded');
        localStorage.setItem('chat-push-mode:/api/rooms/demo', 'all');
        localStorage.setItem('ac-members:demo', '{"names":[],"kinds":{},"avatars":{}}');
        localStorage.setItem('chat-upl:demo', '[]');
        localStorage.setItem('chat-draft:demo:abc-12', '{"id":4}');
        localStorage.setItem('chat-draft:demo-two:abc-12', '{"id":5}');
        localStorage.setItem('chat-invite:demo-two', 'tok_two');
      }
    } catch {}
  };
  const pushInitSrc = '(' + fakePush.toString() + ')(); (' + seedPush.toString() + ')();';
  const bellLabel = (page) => page.$$eval('.pushBtn', (bs) => bs.filter((b) => b.offsetParent).map((b) => b.getAttribute('title'))[0]);
  const bellOff = async (page) => {
    await page.$$eval('.pushBtn', (bs) => bs.filter((b) => b.offsetParent)[0].click());
    await page.waitForSelector('.pushMenu button[data-mode="off"]', { timeout: 4000 });
    await page.click('.pushMenu button[data-mode="off"]');
    await settle(page);
  };
  const forgetKeys = (page) => page.evaluate(() => Object.keys(localStorage).filter((k) => /demo/.test(k) && k !== '__fake_push_sub').sort());
  // Forget on Home turns the room's notifications off on this device
  // first, with the invite it is about to delete (the server asks for
  // it), then removes every key the device kept for the room. It used to
  // delete only the invite and the name: the room went on notifying the
  // device, and nothing on it could stop that any more.
  for (const vp of [{ tag: 'desktop', w: 1280, h: 860 }, { tag: 'phone', w: 390, h: 844, touch: true }]) {
    await run('push-forget-' + vp.tag, { init: pushInitSrc, w: vp.w, h: vp.h, touch: vp.touch }, async (page, S) => {
      S.push = { [EP]: 'all' };
      await page.goto('https://chat.victorio.cloud/');
      await settle(page);
      const forget = async () => { await page.click('.roomrow:has(.rn:text-is("demo")) .forget'); await page.waitForSelector('#forgetDlg[open]', { timeout: 4000 }); await page.click('#forgetYes'); await settle(page); };
      // the room's server refuses: the room stays, the dialog says so and
      // offers Forget anyway
      S.pushFail = 503;
      await forget();
      const refused = await page.evaluate(() => ({ open: document.getElementById('forgetDlg').open, err: (document.getElementById('forgetErr') || {}).textContent || '', shown: !!(document.getElementById('forgetErr') || {}).offsetParent, yes: document.getElementById('forgetYes').textContent, invite: localStorage.getItem('chat-invite:demo') }));
      must(refused.open && refused.shown && /Couldn't turn off this room's notifications/.test(refused.err) && refused.yes === 'Forget anyway' && refused.invite === 'tok_Anthony', 'a refused unsubscribe must keep the room and say so: ' + JSON.stringify(refused));
      await page.screenshot({ path: OUT + 'push-forget-refused-' + vp.tag + '.png' });
      await page.click('#forgetNo');
      await settle(page);
      // the server answers: the device leaves the room's registry, with
      // the room's own token
      S.pushFail = 0;
      await forget();
      const out = { push: S.push, log: S.pushLog.filter((l) => l.startsWith('unsubscribe')), keys: await forgetKeys(page), rows: await page.$$eval('.roomrow .rn', (rs) => rs.map((r) => r.textContent)), open: await page.$eval('#forgetDlg', (d) => d.open) };
      must(!Object.keys(S.push).length, 'after Forget the room still holds this device: ' + JSON.stringify(out));
      must(out.log[out.log.length - 1] === 'unsubscribe tok_Anthony', 'the unsubscribe must carry the room\'s token: ' + JSON.stringify(out));
      must(JSON.stringify(out.keys) === JSON.stringify(['chat-draft:demo-two:abc-12', 'chat-invite:demo-two', 'chat-you:demo-two']), 'Forget must remove every key of the room, and only its: ' + JSON.stringify(out));
      must(!out.open && JSON.stringify(out.rows) === '["demo-two"]', 'the room must leave the list: ' + JSON.stringify(out));
      return out;
    });
  }
  // Bell Off that the server refuses says it failed and keeps the bell
  // on; it used to toast "Notifications off" while the room went on
  // notifying this device.
  await run('push-off-refused', { init: pushInitSrc }, async (page, S) => {
    S.push = { [EP]: 'all' };
    await page.reload();
    await settle(page);
    const before = await bellLabel(page);
    must(before === 'Notifications on', 'the bell must start on: ' + before);
    S.pushFail = 503;
    await bellOff(page);
    const out = { toast: await page.$eval('#toast', (t) => t.textContent), bell: await bellLabel(page), mode: await page.evaluate(() => localStorage.getItem('chat-push-mode:/api/rooms/demo')), push: S.push };
    must(/Couldn't change notifications/.test(out.toast) && out.bell === 'Notifications on' && out.mode === 'all' && S.push[EP] === 'all', 'a refused Off must say so and leave the bell on: ' + JSON.stringify(out));
    S.pushFail = 0;
    await bellOff(page);
    out.after = { toast: await page.$eval('#toast', (t) => t.textContent), bell: await bellLabel(page), mode: await page.evaluate(() => localStorage.getItem('chat-push-mode:/api/rooms/demo')), push: S.push };
    must(/Notifications off for this room/.test(out.after.toast) && out.after.bell === 'Notifications off' && out.after.mode === null && !S.push[EP], 'Off must turn the room off: ' + JSON.stringify(out.after));
    return out;
  });
  await run('denied', { state: { deny: 401 } }, async (page) => { await shot(page, 'denied.png'); return { disabled: await page.$$eval('.tab', e => e.every(x => x.disabled)) }; });
  await run('nonmember', { state: { noYou: true }, hash: '#members' }, async (page) => { return { formShown: await page.$eval('#invForm', f => !f.hidden) }; });
  await run('agent-gate-dark', { state: { agentYou: true }, scheme: 'dark' }, async (page) => { await page.waitForSelector('#view-agent:not([hidden])', { timeout: 10000 }); await shot(page, 'agent-gate-dark.png'); return { ok: true }; });
  await run('agent-gate-mobile', { state: { agentYou: true }, w: 390, h: 844, touch: true }, async (page) => { await page.waitForSelector('#view-agent:not([hidden])', { timeout: 10000 }); await settle(page); await shot(page, 'agent-gate-mobile.png'); return { ok: true }; });
  await run('agent-gate-mobile-dark', { state: { agentYou: true }, w: 390, h: 844, touch: true, scheme: 'dark' }, async (page) => { await page.waitForSelector('#view-agent:not([hidden])', { timeout: 10000 }); await settle(page); await shot(page, 'agent-gate-mobile-dark.png'); return { ok: true }; });
  await run('forced-dark-light', { args: ['--blink-settings=forceDarkModeEnabled=true'], init: () => { try { localStorage.setItem('chat-theme', 'light'); } catch {} } }, async (page) => { await shot(page, 'forcedark-light.png'); });

  // --- message core: unread, naming yourself ---
  await run('unread', {}, async (page) => {
    await page.click('.tab[data-tab="stakes"]'); await settle(page);
    await page.evaluate(() => {});
    return null;
  });
  await run('noname', { state: { noYou: true }, w: 1280, h: 860 }, async (page, S) => {
    await page.evaluate(() => { localStorage.removeItem('chat-name'); }); await page.reload(); await settle(page);
    const before = await page.evaluate(() => ({ input: !document.getElementById('name').hidden, line: !document.getElementById('asLine').hidden }));
    await page.screenshot({ path: OUT + 'noname.png' });
    await page.fill('#text', 'hi'); await page.keyboard.press('Enter'); await settle(page);
    const err = await page.$eval('#err', e => e.hidden ? '' : e.textContent);
    await page.fill('#name', 'Guest Writer'); await page.press('#name', 'Enter'); await settle(page);
    const after = await page.evaluate(() => ({ input: !document.getElementById('name').hidden, line: document.getElementById('asLine').textContent.trim() }));
    await page.keyboard.press('Enter'); await settle(page);
    const posted = S.msgs[S.msgs.length - 1];
    await page.click('#asChange'); await settle(page);
    const changing = await page.evaluate(() => !document.getElementById('name').hidden);
    await page.screenshot({ path: OUT + 'named.png' });
    await page.click('.tab[data-tab="questions"]'); await settle(page);
    await page.fill('#qInput', 'one'); await page.click('#qForm button[type=submit]'); await settle(page);
    const addEnabled = await page.$eval('#qForm button[type=submit]', b => !b.disabled);
    const qCount = await page.$eval('#c-questions', e => e.textContent);
    return { before, err, after, posted: posted.from + ': ' + posted.text, changing, addEnabled, qCount };
  });
  async function runHome() {
    const name = 'home-page';
    const b = await chromium.launch({});
    const ctx = await b.newContext({ serviceWorkers: 'block', viewport: { width: 1280, height: 860 }, timezoneId: 'UTC', locale: 'en-US' });
    const page = await ctx.newPage();
    await installClock(page);
    const errs = [];
    page.on('pageerror', (e) => errs.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
    await page.route('https://chat.victorio.cloud/**', async (route) => {
      const u = new URL(route.request().url());
      const pth = u.pathname;
      const J = (o, st) => route.fulfill({ status: st || 200, contentType: 'application/json', body: JSON.stringify(o) });
      if (pth === '/' || pth === '/index.html' || pth.startsWith('/r/')) return route.fulfill({ status: 200, contentType: 'text/html', body: HTML });
      if (pth === '/api/build') return J({ build: 'uitestbuild2' });
      if (pth.endsWith('/messages')) return J({ messages: [], you: 'Tester' });
      if (pth.endsWith('/members')) return J({ room: 'demo', invite_only: true, members: [] });
      if (pth.startsWith('/assets/')) { try { const b2 = require('fs').readFileSync(DIST + pth); return route.fulfill({ status: 200, contentType: pth.endsWith('.css') ? 'text/css' : 'text/javascript', body: b2 }); } catch { return route.fulfill({ status: 404, body: 'nf' }); } }
      if (pth.startsWith('/icons/')) return route.fulfill({ status: 200, contentType: 'image/png', body: ICON_PNG });
      errs.push('unhandled: ' + route.request().method() + ' ' + pth);
      return route.fulfill({ status: 404, body: 'nf' });
    });
    await page.addInitScript(() => {
      try {
        localStorage.setItem('chat-invite:demo-room', 'tok_demo');
        localStorage.setItem('chat-invite:second-room', 'tok_second');
      } catch {}
    });
    const out = {};
    try {
      await page.goto('https://chat.victorio.cloud/');
      await settle(page);
      out.rows = await page.$$eval('.roomrow', (rs) => rs.length);
      const brandDisplay = await page.$eval('.brand-block', (e) => getComputedStyle(e).display);
      if (brandDisplay !== 'flex') throw new Error('home brand-block is not flex (display=' + brandDisplay + ')');
      out.forgetInsideLink = await page.$eval('body', () => !!document.querySelector('.roomrow a .forget'));
      out.forgetIsSibling = await page.$eval('body', () => !!document.querySelector('.roomrow > .forget'));
      out.asYou = await page.$$eval('.roomrow .who', (ws) => ws.map((w) => w.textContent));
      await page.click('.tab[data-view="create"]');
      await settle(page);
      await page.fill('#cRoom', 'My Room');
      out.preview = await page.$eval('#cRoomUrl', (e) => e.textContent);
      await page.waitForSelector('#updateStrip:not([hidden])', { timeout: 10000 });
      out.updateBanner = true;
      await page.screenshot({ path: OUT + 'home-update-banner.png' });
      await page.evaluate(() => {
        const bar = document.querySelector('.topbar');
        const mk = (t, y) => new PointerEvent(t, { clientY: y, bubbles: true, pointerId: 7, isPrimary: true });
        bar.dispatchEvent(mk('pointerdown', 40));
        bar.dispatchEvent(mk('pointermove', 170));
      });
      out.pullHint = await page.$eval('#pullHintText', (e) => e.textContent);
      await page.screenshot({ path: OUT + 'home-pull.png' });
      await Promise.all([
        page.waitForNavigation({ timeout: 10000 }),
        page.evaluate(() => document.querySelector('.topbar').dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 7, isPrimary: true }))),
      ]);
      out.pullReloaded = true;
    } catch (e) {
      failed();
      console.log('FAIL ' + name + ': harness error: ' + e.message);
    }
    await b.close();
    const fatal = errs.filter((e) => !e.startsWith('console:')).concat(badConsole(errs));
    if (fatal.length) {
      failed();
      console.log('FAIL ' + name + ': ' + JSON.stringify(fatal));
    }
    if (out.rows !== 2 || out.forgetInsideLink || !out.forgetIsSibling || (out.preview || '').indexOf('/r/my-room') < 0 || !out.updateBanner || out.pullHint !== 'Release to refresh' || !out.pullReloaded) {
      failed();
      console.log('FAIL ' + name + ': assertions: ' + JSON.stringify(out));
    } else {
      console.log('PASS ' + name + ' ' + JSON.stringify(out));
    }

  }
  await runHome();
  done('shell');
})();
