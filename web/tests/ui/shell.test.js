// UI scenarios: the room shell: error boundaries, the agent gate, layout, update banner, pull to refresh, the bell, access, unread, and the home page.
// Run alone: node -r ./tests/system-chromium.js tests/ui/shell.test.js
// (ONLY=name1,name2 runs just those). All files: npm test.
const { settle, useClock, DIST, HTML, ICON_PNG, OUT, badConsole, chromium, done, failed, fs, must, path, run, setup, shot } = require('./harness');

(async () => {
  // M1 smoke scenario (not a parity item): proves the harness discriminates
  // and the skeleton's wiring works — invite fragment stored and scrubbed,
  // fixture messages fetched through the typed client and rendered.
  // Error boundaries (2026-11-21): a message the feed can't render (here
  // malformed reactions from the API: one name where a list belongs) shows a one-line notice in its place; the
  // rest of the chat, the message box and the other views keep working.
  // Without the boundaries the render error unmounted the whole page.
  await run('error-boundary-row', { state: { broken: true }, allowConsole: /message 71|is not a function|Cannot read|Objects are not valid|The above error/ }, async (page) => {
    await page.waitForSelector('#msgs .msg', { timeout: 5000 });
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
    await page.waitForSelector('#msgs .err-box', { timeout: 5000 });
    const box = await page.$eval('#msgs .err-box', (e) => { const r = e.getBoundingClientRect(); return { w: Math.round(r.width), right: Math.round(r.right), text: e.textContent.trim() }; });
    if (box.right > 390) throw new Error('the notice overflows a phone: ' + JSON.stringify(box));
    await page.$eval('#msgs .err-box', (e) => e.scrollIntoView({ block: 'center' }));
    await shot(page, 'error-boundary-row-mobile-dark.png');
    return box;
  });
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
    await settle(page);
    out.gateAfterReload = await page.$eval('#view-agent', e => !e.hidden);
    if (out.gateAfterReload) throw new Error('agent gate must not reappear after the escape on this device');
    return out;
  });

  // --- M2 shell scenarios (ported verbatim from tests/ui.test.js) ---
  for (const scheme of ['light', 'dark']) {
    await run('desktop-' + scheme, { scheme }, async (page) => {
      await shot(page, scheme + '-chat.png');
      for (const t of ['constitution', 'decisions', 'questions', 'stakes', 'memory', 'members']) { await page.click('.tab[data-tab="' + t + '"]'); await settle(page); await shot(page, scheme + '-' + t + '.png'); }
      const counts = await page.$$eval('.tab .count', els => els.map(e => e.parentElement.dataset.tab + '=' + e.textContent + (e.classList.contains('alert') ? '!' : '')));
      // Sidebar counts are production-derived for this fixture (the
      // root suite only logs them; assert them here so a counts
      // divergence cannot pass silently — stakes is due within
      // SEVEN days in the current app, decisions count when an
      // active member has not signed).
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
    await page.waitForSelector('#updateStrip:not([hidden])', { timeout: 5000 });
    await shot(page, 'update-banner.png');
    await page.click('#updateDismiss');
    await page.waitForFunction(() => document.getElementById('updateStrip').hidden, null, { timeout: 4000 });
    await page.reload(); await settle(page);
    out.afterDismissReload = await page.$eval('#updateStrip', e => e.hidden);
    await page.evaluate(() => localStorage.removeItem('ac:build-dismissed'));
    await page.reload();
    await page.waitForSelector('#updateStrip:not([hidden])', { timeout: 5000 });
    await Promise.all([page.waitForNavigation({ timeout: 5000 }), page.click('#updateRefresh')]);
    await page.waitForSelector('#updateStrip:not([hidden])', { timeout: 5000 });
    out.refreshReloaded = true;
    if (out.meta !== 'uitestbuild1') throw new Error('page build meta wrong: ' + out.meta);
    if (!out.afterDismissReload) throw new Error('dismissal did not persist across reload');
    return out;
  });
  await run('update-banner-mobile', { state: { behind: true }, w: 390, h: 844, touch: true }, async (page) => {
    await page.waitForSelector('#updateStrip:not([hidden])', { timeout: 5000 });
    await shot(page, 'update-banner-mobile.png');
    return { ok: true };
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
    await Promise.all([page.waitForNavigation({ timeout: 5000 }), release()]);
    out.reloaded = true;
    if (out.shortHint !== 'Pull to refresh') throw new Error('short drag hint wrong: ' + out.shortHint);
    if (!out.shortHidden) throw new Error('hint must hide after a short drag');
    if (out.fullHint !== 'Release to refresh') throw new Error('full drag hint wrong: ' + out.fullHint);
    return out;
  });
  await run('push-bell', { init: () => { try { Object.defineProperty(Notification, 'permission', { get: () => 'default' }); } catch (e) {} } }, async (page) => {
    // Soak defect S2 (2026-11-09): on the owner's phone (Chrome,
    // permission undecided) the staging app showed no bell at all.
    // Two causes stacked: staging served /sw.js as HTML, so
    // registration failed and serviceWorker.ready never resolved -
    // and the port only painted the bell at the end of that async
    // check, while production paints visibility from the support
    // rule. Here the harness 404s /sw.js the same way; with the
    // permission stubbed to "default" the bell must still appear.
    const out = {};
    out.perm = await page.evaluate(() => Notification.permission);
    if (out.perm !== 'default') throw new Error('permission stub did not take: ' + out.perm);
    await settle(page);
    out.vis = await page.$$eval('.pushBtn', bs => bs.map(b => !b.hidden));
    if (!out.vis.some(Boolean)) throw new Error('push bell never became visible: ' + JSON.stringify(out));
    return out;
  });
  await run('denied', { state: { deny: 401 } }, async (page) => { await shot(page, 'denied.png'); return { disabled: await page.$$eval('.tab', e => e.every(x => x.disabled)) }; });
  await run('nonmember', { state: { noYou: true }, hash: '#members' }, async (page) => { return { formShown: await page.$eval('#invForm', f => !f.hidden) }; });
  await run('agent-gate-dark', { state: { agentYou: true }, scheme: 'dark' }, async (page) => { await page.waitForSelector('#view-agent:not([hidden])', { timeout: 4000 }); await shot(page, 'agent-gate-dark.png'); return { ok: true }; });
  await run('agent-gate-mobile', { state: { agentYou: true }, w: 390, h: 844, touch: true }, async (page) => { await page.waitForSelector('#view-agent:not([hidden])', { timeout: 4000 }); await settle(page); await shot(page, 'agent-gate-mobile.png'); return { ok: true }; });
  await run('agent-gate-mobile-dark', { state: { agentYou: true }, w: 390, h: 844, touch: true, scheme: 'dark' }, async (page) => { await page.waitForSelector('#view-agent:not([hidden])', { timeout: 4000 }); await settle(page); await shot(page, 'agent-gate-mobile-dark.png'); return { ok: true }; });
  await run('forced-dark-light', { args: ['--blink-settings=forceDarkModeEnabled=true'], init: () => { try { localStorage.setItem('chat-theme', 'light'); } catch (e) {} } }, async (page) => { await shot(page, 'forcedark-light.png'); });

  // --- M3 message-core scenarios (ported verbatim from tests/ui.test.js) ---
  await run('unread', {}, async (page, S) => {
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
    const ctx = await b.newContext({ viewport: { width: 1280, height: 860 }, timezoneId: 'UTC', locale: 'en-US' });
    const page = await ctx.newPage();
    await useClock(page);
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
      if (pth.startsWith('/assets/')) { try { const b2 = require('fs').readFileSync(DIST + pth); return route.fulfill({ status: 200, contentType: pth.endsWith('.css') ? 'text/css' : 'text/javascript', body: b2 }); } catch (e) { return route.fulfill({ status: 404, body: 'nf' }); } }
      if (pth.startsWith('/icons/')) return route.fulfill({ status: 200, contentType: 'image/png', body: ICON_PNG });
      errs.push('unhandled: ' + route.request().method() + ' ' + pth);
      return route.fulfill({ status: 404, body: 'nf' });
    });
    await page.addInitScript(() => {
      try {
        localStorage.setItem('chat-invite:demo-room', 'tok_demo');
        localStorage.setItem('chat-invite:second-room', 'tok_second');
      } catch (e) {}
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
      await page.waitForSelector('#updateStrip:not([hidden])', { timeout: 4000 });
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
        page.waitForNavigation({ timeout: 5000 }),
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
