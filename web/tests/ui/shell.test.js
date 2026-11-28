// UI scenarios: the room shell: error boundaries, the agent gate, layout, update banner, pull to refresh, the bell, access, unread, and the home page.
// Run alone: node -r ./tests/system-chromium.js tests/ui/shell.test.js
// (ONLY=name1,name2 runs just those). All files: npm test.
const { settle, installClock, fakePush, must, setup, DIST, HTML, ICON_PNG, OUT, START_PAGE, badConsole, chromium, done, failed, run, shot } = require('./harness');

// The device holds the agent Probe's invite (as an invite link stores it).
const probeInvite = () => { try { localStorage.setItem('chat-invite:demo', 'tok_Probe'); } catch { /* the scenario fails visibly */ } };
// ... and its person chose the web app (the gate's escape).
const probeInWebApp = () => { try { localStorage.setItem('chat-invite:demo', 'tok_Probe'); localStorage.setItem('ac:agent-app:demo', '1'); } catch { /* the scenario fails visibly */ } };
// A clipboard that takes what is copied (window.__copied), so a copy's toast
// does not hang on the browser's permission.
const fakeClipboard = () => { Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (t) => { window.__copied = t; } }, configurable: true }); };
const probeGate = '(' + probeInvite + ')(); (' + fakeClipboard + ')();';
const INTRO = 'This invite belongs to Probe, an agent member of this room. Agents join through the API or MCP, with a tool that can send an HTTP header; an assistant that can only be given a link cannot join. Hand your agent this note:';
const CLOSING = 'Opening the web app with this invite acts as Probe: if Probe has not joined yet, that joins the room. The same invite works in the web app, on REST and over MCP.';
// The gate's note as the app builds it (agentNote) from the preview, which
// carries none: GET /invite names Anthony as Probe's inviter, so the
// member-made form, for the token on this device and the page's origin.
const NOTE_BY_ANTHONY = '"Anthony" invited you to the Agent Chat room "demo" as the agent "Probe". Agent Chat hosts invite-only rooms where AI agents and people talk, play games and keep a shared board.\n' +
  'To join you need a tool that can send an HTTP header: curl, an HTTP client, or an MCP client with custom headers. If you have none, you cannot join: stop here and tell your person.\n' +
  'Send this header on every call to the room: X-Invite-Token: tok_Probe (or the same token as Authorization: Bearer). It is your password here: whoever holds it acts as "Probe", so never post it.\n' +
  'Start here: GET https://chat.victorio.cloud/api/rooms/demo with that header. It changes nothing in the room, and its answer is your start page: what to do next, in order.\n' +
  'Or, if your MCP client can set headers: connect to https://chat.victorio.cloud/api/rooms/demo/mcp with that header and call get_start_page for the same page. Neither step joins the room.';
/** The gate's "What your agent reads first": closed, and nothing fetched for it. */
async function startClosed(page, S) {
  // nothing has read the room: the status says so, in the sidebar and on the top bar's dot
  const st = await page.evaluate(() => ({ label: document.querySelector('#status .label').textContent, dot: document.getElementById('topDot').title }));
  must(st.label === 'Not connected' && st.dot === 'Not connected', 'the gate\'s status: ' + JSON.stringify(st));
  const d = await page.$eval('#agentStart', (e) => ({ open: e.open, summary: e.querySelector('summary').textContent.trim(), pre: !!e.querySelector('pre') }));
  must(!d.open && d.summary === 'What your agent reads first' && !d.pre, 'the disclosure starts closed: ' + JSON.stringify(d));
  must(!(S.hits || []).includes('GET /api/rooms/demo'), 'the start page was fetched before the disclosure was opened: ' + JSON.stringify(S.hits));
}
/** Opens it: the start page shows in its own scroll box, the whole page width kept. */
async function startOpened(page, S) {
  await page.click('#agentStart > summary');
  await page.waitForSelector('#agentStartPage', { timeout: 5000 });
  const box = await page.$eval('#agentStartPage', (e) => ({ text: e.textContent, sh: e.scrollHeight, ch: e.clientHeight, sw: e.scrollWidth, cw: e.clientWidth, oy: getComputedStyle(e).overflowY, h: Math.round(e.getBoundingClientRect().height), vh: window.innerHeight, doc: document.documentElement.scrollWidth, vw: window.innerWidth }));
  must(box.text === START_PAGE, 'the start page, as served: ' + box.text.slice(0, 120));
  must(box.oy === 'auto' && box.sh > box.ch && box.h <= box.vh * 0.56 + 2, 'the page scrolls in a box of bounded height: ' + JSON.stringify({ ...box, text: undefined }));
  must(box.sw <= box.cw + 1 && box.doc <= box.vw + 1, 'nothing scrolls sideways: ' + JSON.stringify({ ...box, text: undefined }));
  must((S.hits || []).filter((h) => h === 'GET /api/rooms/demo').length === 1, 'one read of the start page: ' + JSON.stringify(S.hits));
  // the opened box and the closing sentence under it
  await page.$eval('#agentStart', (e) => e.scrollIntoView({ block: 'start' }));
  return { chars: box.text.length, boxHeight: box.h };
}

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
  // The device holds the agent's invite (a token is what reaches the gate:
  // without one the room answers 401): the gate shows the invite's note,
  // five lines, which the app builds from the preview (it carries none).
  await run('agent-gate', { state: { agentYou: true }, init: probeGate }, async (page, S) => {
    const out = {};
    await page.waitForSelector('#view-agent:not([hidden])', { timeout: 10000 });
    out.block = await page.$eval('#agentBlock', e => e.textContent);
    out.intro = await page.$eval('#agentIntro', e => e.textContent.replace(/\s+/g, ' ').trim());
    out.note = await page.$eval('.agent-note', e => e.textContent.replace(/\s+/g, ' ').trim());
    out.buttons = await page.$$eval('.agent-actions button', (bs) => bs.map((b) => b.textContent.trim()));
    if (!/\/api\/rooms\/demo\/mcp/.test(out.block)) throw new Error('the note must name the MCP endpoint: ' + out.block.slice(0, 80));
    if (!/X-Invite-Token: tok_Probe/.test(out.block)) throw new Error('the note must carry the invite header');
    must(out.block.split('\n').length === 5, 'the note is five lines: ' + out.block.split('\n').length);
    must(out.block.includes('Start here: GET https://chat.victorio.cloud/api/rooms/demo with that header'), 'the note names the start page: ' + out.block.slice(0, 200));
    must(out.block === NOTE_BY_ANTHONY, 'the note the app builds, member-made: ' + out.block.slice(0, 200));
    must(out.intro === INTRO, 'the intro: ' + out.intro);
    must(out.note === CLOSING, 'the closing sentence: ' + out.note);
    must(JSON.stringify(out.buttons) === '["Copy the note","Open the web app anyway"]', 'the buttons: ' + JSON.stringify(out.buttons));
    await startClosed(page, S);
    await shot(page, 'agent-gate.png');
    // Copy the note: the note, and its toast
    await page.click('#agentCopy');
    await page.waitForFunction(() => /Note copied/.test(document.querySelector('#toast')?.textContent || ''), null, { timeout: 4000 });
    must(await page.evaluate(() => window.__copied) === out.block, 'Copy the note copies the note');
    out.start = await startOpened(page, S);
    await shot(page, 'agent-gate-start.png');
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
  // and its note come from the preview (GET /invite), and nothing reads the room (which
  // would open the invite as the agent) until the person picks the web app.
  await run('agent-gate-preview', { state: { agentYou: true }, hash: '#invite=tok_Probe' }, async (page, S) => {
    await page.waitForSelector('#view-agent:not([hidden])', { timeout: 10000 });
    const block = await page.$eval('#agentBlock', e => e.textContent);
    must(block === NOTE_BY_ANTHONY, 'the note is the app\'s, from the preview\'s inviter: ' + block.slice(0, 120));
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

  // A link with a different invite than the one this device holds: it is
  // looked at first and never saved unasked. Saving it straight away let
  // any page lock a member out with a junk token, or switch who they post
  // as with someone else's.
  const seedAnthony = () => { if (!sessionStorage.getItem('seeded')) { sessionStorage.setItem('seeded', '1'); localStorage.setItem('chat-invite:demo', 'tok_Anthony'); localStorage.setItem('chat-you:demo', 'Anthony'); } };
  const savedInvite = (page) => page.evaluate(() => [localStorage.getItem('chat-invite:demo'), localStorage.getItem('chat-you:demo'), location.hash]);
  // confirm() is replaced in the page before the app runs (the question
  // would come before the harness could listen for dialogs): it records
  // what it was asked in sessionStorage, which outlives the reload, and
  // answers yes or no.
  const confirmSays = (yes) => '(' + seedAnthony + ')(); window.confirm = (m) => { const a = JSON.parse(sessionStorage.getItem("asked") || "[]"); a.push(m); sessionStorage.setItem("asked", JSON.stringify(a)); return ' + yes + '; };';
  const askedLog = (page) => page.evaluate(() => JSON.parse(sessionStorage.getItem('asked') || '[]'));
  for (const vp of [{ tag: '', w: 1280, h: 860 }, { tag: '-phone', w: 390, h: 844, touch: true }]) await run('invite-link-refused' + vp.tag, { init: confirmSays(true), state: { previews: { tok_junk: 403 } }, hash: '#invite=tok_junk', w: vp.w, h: vp.h, touch: vp.touch, allowConsole: /status of 403/ }, async (page, S) => {
    await page.waitForSelector('#view-chat:not([hidden])', { timeout: 10000 });
    await page.waitForFunction(() => /isn't valid/.test(document.querySelector('#toast')?.textContent || ''), null, { timeout: 5000 });
    await shot(page, 'invite-link-refused' + vp.tag + '.png');
    const out = { saved: await savedInvite(page), hits: S.hits, asked: await askedLog(page) };
    must(JSON.stringify(out.saved) === JSON.stringify(['tok_Anthony', 'Anthony', '']), 'a refused link must leave the saved invite and scrub the address: ' + JSON.stringify(out));
    must(out.hits.includes('GET /invite tok_junk') && !out.asked.length, 'the link must be checked, with no question: ' + JSON.stringify(out));
    return out;
  });
  for (const answer of ['no', 'yes']) {
    await run('invite-link-switch-' + answer, { init: confirmSays(answer === 'yes'), state: { previews: { tok_Carol: 'Carol' } }, hash: '#invite=tok_Carol' }, async (page, S) => {
      await page.waitForFunction(() => sessionStorage.getItem('asked'), null, { timeout: 5000 });
      // yes: the page saves Carol's invite and loads again on it. The link
      // is looked at while the room loads as before, so whether the first
      // load's own read of the room lands before the reload is a race (a
      // count of reads failed a loaded run). The reload is told by what
      // cannot happen without it: the stub sees Carol's invite a second
      // time, now as the page's own, and a read of the room after that.
      const asCarol = () => S.hits.filter((h) => h === 'GET /invite tok_Carol').length;
      const readSince = () => S.hits.lastIndexOf('GET /messages') > S.hits.lastIndexOf('GET /invite tok_Carol');
      if (answer === 'yes') for (let i = 0; i < 500 && !(asCarol() >= 2 && readSince()); i++) await new Promise((r) => setTimeout(r, 20));
      await page.waitForSelector('#view-chat:not([hidden])', { timeout: 10000 });
      await settle(page);
      const reads = S.hits.filter((h) => h === 'GET /messages').length;
      const out = { saved: await savedInvite(page), asked: await askedLog(page), reads, asCarol: asCarol(), readSince: readSince(), hits: S.hits };
      must(out.asked.length === 1 && /You are Anthony in this room\. Switch this device to Carol\?/.test(out.asked[0]), 'switching identity must ask once: ' + JSON.stringify(out));
      // (the stub's reads still answer you: Anthony, so only the invite is compared after yes)
      must(answer === 'yes' ? out.saved[0] === 'tok_Carol' && out.asCarol >= 2 && out.readSince : JSON.stringify(out.saved) === JSON.stringify(['tok_Anthony', 'Anthony', '']) && reads === 1 && out.asCarol === 1, 'the saved invite after ' + answer + ': ' + JSON.stringify(out));
      return out;
    });
  }

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
      // the members tab is the last one opened: Ada's Muse delivery shows, and only hers
      const muse = await page.$$eval('.member .pill.muse', els => els.map(e => e.closest('.member').querySelector('.card-title').textContent));
      if (JSON.stringify(muse) !== JSON.stringify(['Ada'])) throw new Error('Muse delivery pills: ' + JSON.stringify(muse));
      // and Henry's webhook delivery, only his
      const hooked = await page.$$eval('.member .pill.webhook', els => els.map(e => e.closest('.member').querySelector('.card-title').textContent));
      if (JSON.stringify(hooked) !== JSON.stringify(['Henry'])) throw new Error('Webhook delivery pills: ' + JSON.stringify(hooked));
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
    // The hint hides 180 ms after the release, the length of its slide-out
    // transition, and settle() waits for that same transition: the two
    // clocks raced, and on a busy machine the read came first. Wait for
    // the hint itself (up to 2 s) instead.
    await page.waitForFunction(() => document.getElementById('pullHint').hidden, null, { timeout: 2000 }).catch(() => {});
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
  // A toast, an error line or the bell's label is painted after the
  // request settle() waits for, so reading it right after settle() can
  // find it empty or stale on a busy machine (push-off-refused once read an
  // empty toast). Wait up to 2 s for the text to match, then return what is
  // there, so a check that never comes true still fails on the must.
  const textWhen = async (page, sel, re) => {
    await page.waitForFunction(([s, src]) => { const e = [...document.querySelectorAll(s)].find((x) => x.offsetParent) || document.querySelector(s); return !!e && new RegExp(src).test(e.getAttribute('title') || e.textContent || ''); }, [sel, re.source], { timeout: 2000 }).catch(() => {});
    return page.$$eval(sel, (es) => { const e = es.find((x) => x.offsetParent) || es[0]; return e ? e.getAttribute('title') || e.textContent || '' : ''; });
  };
  const forgetKeys = (page) => page.evaluate(() => Object.keys(localStorage).filter((k) => /demo/.test(k) && k !== '__fake_push_sub').sort());
  // Forget on Home turns the room's notifications off on this device
  // first, with the invite it is about to delete (the server asks for
  // it), then removes every key the device kept for the room. It used to
  // delete only the invite and the name: the room went on notifying the
  // device, and nothing on it could stop that any more.
  // The device also holds a connection it approved for that room
  // (chat-signin:<id>): Forget leaves it, since only its own Disconnect or
  // Forget under Agent keys may remove it.
  const SIGNIN_KEY = 'chat-signin:Q2mZp9X4vB1nW8cR5tYaKw';
  const SIGNIN_REC = JSON.stringify({ app: 'claude', name: 'Claude (Anthony)', at: Date.UTC(2026, 10, 18), rooms: ['demo'], code: '.ad1.Q2mZp9X4vB1nW8cR5tYaKw.Zz9Yy8Xx7Ww.Lq3Lx8Zr2Vn6Bt0Wk4Sd9Fg1Jc7Pm5Ye3Ua6Io2NbXb' });
  const seedSignin = '(() => { try { if (!sessionStorage.getItem("seeded-signin")) { sessionStorage.setItem("seeded-signin", "1"); localStorage.setItem(' + JSON.stringify(SIGNIN_KEY) + ', ' + JSON.stringify(SIGNIN_REC) + '); } } catch {} })();';
  for (const vp of [{ tag: 'desktop', w: 1280, h: 860 }, { tag: 'phone', w: 390, h: 844, touch: true }]) {
    await run('push-forget-' + vp.tag, { init: pushInitSrc + ' ' + seedSignin, w: vp.w, h: vp.h, touch: vp.touch }, async (page, S) => {
      S.push = { [EP]: 'all' };
      await page.goto('https://chat.victorio.cloud/');
      await settle(page);
      const forget = async () => { await page.click('.roomrow:has(.rn:text-is("demo")) .forget'); await page.waitForSelector('#forgetDlg[open]', { timeout: 4000 }); await page.click('#forgetYes'); await settle(page); };
      // the room's server refuses: the room stays, the dialog says so and
      // offers Forget anyway
      S.pushFail = 503;
      await forget();
      await textWhen(page, '#forgetErr', /Couldn't turn off this room's notifications/);
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
      must((await page.evaluate((k) => localStorage.getItem(k), SIGNIN_KEY)) === SIGNIN_REC, "Forget must leave the connection's record as it was");
      return out;
    });
  }
  // Forget while the room is open in another tab with the bell on, whose
  // status check is in flight: Home's unsubscribe lands first, the tab hears
  // "not registered", and it re-registers quietly if it still finds the
  // bell's saved mode. Forget used to delete that mode only after the
  // unsubscribe answered, so the tab signed the device up again and
  // notifications kept coming after Forget.
  await run('push-forget-open-tab', { init: pushInitSrc }, async (page, S, calls) => {
    S.push = { [EP]: 'all' };
    const b = await page.context().newPage();
    await installClock(b);
    await setup(b, S, calls);
    await b.addInitScript(pushInitSrc);
    await b.goto('https://chat.victorio.cloud/r/demo');
    await b.waitForFunction(() => [...document.querySelectorAll('.pushBtn')].some((x) => x.getAttribute('title') === 'Notifications on'), null, { timeout: 10000 });
    await page.goto('https://chat.victorio.cloud/');
    await settle(page);
    // tab B starts a status check that the server holds
    let openStatus, openUnsub;
    S.statusGate = new Promise((r) => (openStatus = r));
    const held = S.pushLog.length;
    await b.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    for (let i = 0; i < 100 && S.pushLog.length === held; i++) await new Promise((r) => setTimeout(r, 20));
    // Home forgets; the server drops the registration and holds its answer
    S.unsubGate = new Promise((r) => (openUnsub = r));
    await page.click('.roomrow:has(.rn:text-is("demo")) .forget');
    await page.waitForSelector('#forgetDlg[open]', { timeout: 4000 });
    await page.click('#forgetYes');
    for (let i = 0; i < 100 && S.push[EP]; i++) await new Promise((r) => setTimeout(r, 20));
    // tab B hears "not registered" before Home has its answer
    S.statusGate = null;
    openStatus();
    await new Promise((r) => setTimeout(r, 300));
    await settle(b);
    S.unsubGate = null;
    openUnsub();
    await settle(page);
    await new Promise((r) => setTimeout(r, 300));
    await settle(b);
    const out = { push: S.push, log: S.pushLog.slice(held), keys: await forgetKeys(page), b: await bellLabel(b) };
    must(!Object.keys(S.push).length, 'the open tab registered the room again after Forget: ' + JSON.stringify(out));
    must(!out.keys.some((k) => /[:/]demo($|:)/.test(k)), 'Forget must remove the room\'s keys: ' + JSON.stringify(out));
    return out;
  });
  // Forget clears the bell's mode before its unsubscribe reaches the
  // server, and an open tab of the room repaints on that change: its status
  // check, answered before the unsubscribe, says "registered" and the bell
  // reads on. The invite's removal after the unsubscribe repaints it off;
  // before, nothing did and the bell stayed on with nothing registered.
  await run('push-forget-open-tab-label', { init: pushInitSrc }, async (page, S, calls) => {
    S.push = { [EP]: 'all' };
    const b = await page.context().newPage();
    await installClock(b);
    await setup(b, S, calls);
    await b.addInitScript(pushInitSrc);
    await b.goto('https://chat.victorio.cloud/r/demo');
    await b.waitForFunction(() => [...document.querySelectorAll('.pushBtn')].some((x) => x.getAttribute('title') === 'Notifications on'), null, { timeout: 10000 });
    await page.goto('https://chat.victorio.cloud/');
    await settle(page);
    // Home's unsubscribe waits before the fake server sees it
    let openUnsub, unsubHeld;
    const gate = new Promise((r) => (openUnsub = r));
    const held = new Promise((r) => (unsubHeld = r));
    await page.route('**/push/unsubscribe', async (route) => { unsubHeld(); await gate; await route.fallback(); });
    const before = S.pushLog.length;
    await page.click('.roomrow:has(.rn:text-is("demo")) .forget');
    await page.waitForSelector('#forgetDlg[open]', { timeout: 4000 });
    await page.click('#forgetYes');
    await held;
    // tab B's repaint after the mode went: its status check still hears "registered"
    for (let i = 0; i < 150 && !S.pushLog.slice(before).some((x) => x.startsWith('status')); i++) await new Promise((r) => setTimeout(r, 20));
    await settle(b);
    const mid = await bellLabel(b);
    openUnsub();
    await settle(page);
    await b.waitForFunction(() => [...document.querySelectorAll('.pushBtn')].some((x) => x.getAttribute('title') === 'Notifications off'), null, { timeout: 2000 }).catch(() => {});
    const out = { mid, end: await bellLabel(b), push: S.push, log: S.pushLog.slice(before), keys: await forgetKeys(page) };
    must(out.log.some((x) => x.startsWith('status')) && mid === 'Notifications on', 'tab B should have repainted on while the unsubscribe was held: ' + JSON.stringify(out));
    must(!Object.keys(S.push).length && !out.keys.some((k) => /[:/]demo($|:)/.test(k)), 'Forget must finish: ' + JSON.stringify(out));
    must(out.end === 'Notifications off', 'tab B must read off once the room is forgotten: ' + JSON.stringify(out));
    return out;
  });
  // A failed unsubscribe offers Try again, which runs it again (busy
  // meanwhile); the error line used to say "Try again" with no button for it.
  for (const vp of [{ tag: 'desktop', w: 1280, h: 860 }, { tag: 'phone', w: 390, h: 844, touch: true }]) {
    await run('push-forget-retry-' + vp.tag, { init: pushInitSrc, w: vp.w, h: vp.h, touch: vp.touch }, async (page, S) => {
      S.push = { [EP]: 'all' };
      await page.goto('https://chat.victorio.cloud/');
      await settle(page);
      S.pushFail = 503;
      await page.click('.roomrow:has(.rn:text-is("demo")) .forget');
      await page.waitForSelector('#forgetDlg[open]', { timeout: 4000 });
      await page.click('#forgetYes');
      await page.waitForSelector('#forgetRetry', { timeout: 4000 });
      const btns = () => page.$$eval('#forgetDlg .dlg-actions button', (bs) => bs.map((x) => ({ id: x.id, text: x.textContent, disabled: x.disabled, r: x.getBoundingClientRect().toJSON() })));
      const first = { btns: await btns(), mode: await page.evaluate(() => localStorage.getItem('chat-push-mode:/api/rooms/demo')) };
      must(JSON.stringify(first.btns.map((x) => x.text)) === '["Cancel","Try again","Forget anyway"]' && first.mode === 'all', 'a refused unsubscribe must offer Try again and keep the bell\'s mode: ' + JSON.stringify(first));
      const dlg = await page.$eval('#forgetDlg', (d) => d.getBoundingClientRect().toJSON());
      must(first.btns.every((x) => x.r.left >= dlg.left && x.r.right <= dlg.right), 'the buttons must fit in the dialog: ' + JSON.stringify({ dlg, btns: first.btns }));
      await page.screenshot({ path: OUT + 'push-forget-retry-' + vp.tag + '.png' });
      // Try again, refused again: the line says so
      const sent = S.pushLog.length;
      await page.click('#forgetRetry');
      await settle(page);
      const again = { err: await textWhen(page, '#forgetErr', /^Still couldn't turn off/), log: S.pushLog.slice(sent) };
      must(/^Still couldn't turn off/.test(again.err) && again.log.some((l) => l.startsWith('unsubscribe')), 'Try again must unsubscribe again and say it failed again: ' + JSON.stringify(again));
      // Try again while the server is slow: every button waits
      S.pushFail = 0;
      let openUnsub;
      S.unsubGate = new Promise((r) => (openUnsub = r));
      await page.click('#forgetRetry');
      await page.waitForFunction(() => document.getElementById('forgetRetry') && document.getElementById('forgetRetry').disabled, null, { timeout: 4000 });
      const busy = await btns();
      must(busy.every((x) => x.disabled) && busy[1].text === 'Trying…', 'every button must wait while Try again runs: ' + JSON.stringify(busy));
      S.unsubGate = null;
      openUnsub();
      await settle(page);
      const out = { push: S.push, open: await page.$eval('#forgetDlg', (d) => d.open), rows: await page.$$eval('.roomrow .rn', (rs) => rs.map((r) => r.textContent)) };
      must(!Object.keys(S.push).length && !out.open && JSON.stringify(out.rows) === '["demo-two"]', 'Try again must forget the room once the server answers: ' + JSON.stringify(out));
      return out;
    });
  }
  // A browser with no dialog.showModal asks with confirm. That path used to
  // skip the unsubscribe, so the room went on notifying the device; now it
  // unsubscribes, and when that fails asks whether to forget anyway.
  await run('push-forget-nodialog', { init: pushInitSrc + ' delete HTMLDialogElement.prototype.showModal;' }, async (page, S) => {
    S.push = { [EP]: 'all' };
    await page.goto('https://chat.victorio.cloud/');
    await settle(page);
    const asked = [];
    let answers = [];
    page.on('dialog', (d) => { asked.push(d.message()); void (answers.shift() ? d.accept() : d.dismiss()); });
    // refused, and no to Forget anyway: the room stays, with its bell
    S.pushFail = 503;
    answers = [true, false];
    await page.click('.roomrow:has(.rn:text-is("demo")) .forget');
    await settle(page);
    const kept = { asked: asked.slice(), log: S.pushLog.filter((l) => l.startsWith('unsubscribe')), rows: await page.$$eval('.roomrow .rn', (rs) => rs.map((r) => r.textContent)), mode: await page.evaluate(() => localStorage.getItem('chat-push-mode:/api/rooms/demo')) };
    must(kept.asked.length === 2 && /Forget it anyway\?/.test(kept.asked[1]) && kept.log.length === 1 && kept.rows.includes('demo') && kept.mode === 'all', 'a refused unsubscribe must ask, and No must keep the room: ' + JSON.stringify(kept));
    // the server answers: one confirm, the device leaves the room's registry
    S.pushFail = 0;
    asked.length = 0;
    answers = [true];
    await page.click('.roomrow:has(.rn:text-is("demo")) .forget');
    await settle(page);
    const out = { asked: asked.slice(), push: S.push, log: S.pushLog.filter((l) => l.startsWith('unsubscribe')), rows: await page.$$eval('.roomrow .rn', (rs) => rs.map((r) => r.textContent)) };
    must(out.asked.length === 1 && !Object.keys(S.push).length && out.log[out.log.length - 1] === 'unsubscribe tok_Anthony' && JSON.stringify(out.rows) === '["demo-two"]', 'Forget without a dialog must unsubscribe the room: ' + JSON.stringify(out));
    return out;
  });
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
    const out = { toast: await textWhen(page, '#toast', /Couldn't change notifications/), bell: await textWhen(page, '.pushBtn', /^Notifications on$/), mode: await page.evaluate(() => localStorage.getItem('chat-push-mode:/api/rooms/demo')), push: S.push };
    must(/Couldn't change notifications/.test(out.toast) && out.bell === 'Notifications on' && out.mode === 'all' && S.push[EP] === 'all', 'a refused Off must say so and leave the bell on: ' + JSON.stringify(out));
    S.pushFail = 0;
    await bellOff(page);
    out.after = { toast: await textWhen(page, '#toast', /Notifications off for this room/), bell: await textWhen(page, '.pushBtn', /^Notifications off$/), mode: await page.evaluate(() => localStorage.getItem('chat-push-mode:/api/rooms/demo')), push: S.push };
    must(/Notifications off for this room/.test(out.after.toast) && out.after.bell === 'Notifications off' && out.after.mode === null && !S.push[EP], 'Off must turn the room off: ' + JSON.stringify(out.after));
    return out;
  });
  // The browser dropped its subscription (or replaced it without telling
  // the page): a room turned on here, with permission still granted,
  // subscribes again quietly and re-registers. It used to show Off and
  // stay silent.
  await run('push-resubscribe', { init: pushInitSrc }, async (page, S) => {
    S.push = {};
    await page.evaluate(() => localStorage.removeItem('__fake_push_sub'));
    await page.reload();
    await settle(page);
    const out = { bell: await bellLabel(page), sub: await page.evaluate(() => localStorage.getItem('__fake_push_sub')), push: S.push };
    must(out.sub && S.push[out.sub] === 'all' && out.bell === 'Notifications on', 'a dropped subscription must come back for a room turned on here: ' + JSON.stringify(out));
    return out;
  });
  // Off in one tab while another tab's status check is in flight: the
  // other tab read the saved mode before Off cleared it, then heard
  // "not registered" and quietly registered the room again. It now reads
  // the mode after the status answer.
  await run('push-two-tabs', { init: pushInitSrc }, async (page, S, calls) => {
    S.push = { [EP]: 'all' };
    await page.reload();
    await settle(page);
    const b = await page.context().newPage();
    await installClock(b);
    await setup(b, S, calls);
    await b.addInitScript(pushInitSrc);
    await b.goto('https://chat.victorio.cloud/r/demo');
    await b.waitForSelector('.pushBtn', { timeout: 10000 });
    await b.waitForFunction(() => [...document.querySelectorAll('.pushBtn')].some((x) => x.getAttribute('title') === 'Notifications on'), null, { timeout: 10000 });
    // tab B starts a status check that the server holds
    let open;
    S.statusGate = new Promise((r) => (open = r));
    const held = S.pushLog.length;
    await b.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    for (let i = 0; i < 100 && S.pushLog.length === held; i++) await new Promise((r) => setTimeout(r, 20));
    // tab A turns the bell off
    await page.$$eval('.pushBtn', (bs) => bs.filter((x) => x.offsetParent)[0].click());
    await page.waitForSelector('.pushMenu button[data-mode="off"]', { timeout: 4000 });
    await page.click('.pushMenu button[data-mode="off"]');
    for (let i = 0; i < 100 && S.push[EP]; i++) await new Promise((r) => setTimeout(r, 20));
    S.statusGate = null;
    open();
    await settle(page);
    await new Promise((r) => setTimeout(r, 300));
    await settle(page);
    const out = { push: S.push, a: await bellLabel(page), b: await bellLabel(b), log: S.pushLog.slice(held) };
    must(!Object.keys(S.push).length, 'the other tab registered the room again after Off: ' + JSON.stringify(out));
    must(out.a === 'Notifications off' && out.b === 'Notifications off', 'both bells must show off: ' + JSON.stringify(out));
    return out;
  });
  await run('denied', { state: { deny: 401 } }, async (page) => { await shot(page, 'denied.png'); return { disabled: await page.$$eval('.tab', e => e.every(x => x.disabled)) }; });
  // A revoked invite: the locked screen shows the room's sentence whole
  // (only "This room is invite-only." is stripped), and no room owner is
  // named: only the site's owner revokes, and any member can invite anew.
  for (const vp of [{ tag: 'desktop', w: 1280, h: 860 }, { tag: 'phone', w: 390, h: 844, touch: true }]) for (const scheme of ['light', 'dark']) {
    await run('denied-revoked-' + vp.tag + '-' + scheme, { state: { deny: 403 }, w: vp.w, h: vp.h, touch: vp.touch, scheme }, async (page) => {
      await page.waitForSelector('#lockedText', { state: 'visible', timeout: 10000 });
      const text = await page.$eval('#lockedText', (e) => e.textContent);
      must(text === 'This invite link has been revoked. Ask whoever gave it to you for a new one.', 'the locked screen shows the revoked sentence: ' + text);
      await shot(page, 'denied-revoked-' + vp.tag + '-' + scheme + '.png');
      return { text };
    });
  }
  // An agent's invite where GET /invite failed: the app builds the note
  // itself, the server's owner-made form (agentNote, kept equal to the
  // Worker's by tests/unit/agent-note.test.mjs), and names no call that
  // joins (whoami and get_room_state both do).
  const FALLBACK = 'You are invited to the Agent Chat room "demo" as the agent "Probe". Agent Chat hosts invite-only rooms where AI agents and people talk, play games and keep a shared board.\n' +
    'To join you need a tool that can send an HTTP header: curl, an HTTP client, or an MCP client with custom headers. If you have none, you cannot join: stop here and tell your person.\n' +
    'Send this header on every call to the room: X-Invite-Token: tok_Probe (or the same token as Authorization: Bearer). It is your password here: whoever holds it acts as "Probe", so never post it.\n' +
    'Start here: GET https://chat.victorio.cloud/api/rooms/demo with that header. It changes nothing in the room, and its answer is your start page: what to do next, in order.\n' +
    'Or, if your MCP client can set headers: connect to https://chat.victorio.cloud/api/rooms/demo/mcp with that header and call get_start_page for the same page. Neither step joins the room.';
  for (const vp of [{ tag: 'desktop', w: 1280, h: 860 }, { tag: 'phone', w: 390, h: 844, touch: true }]) for (const scheme of ['light', 'dark']) {
    await run('agent-gate-fallback-' + vp.tag + '-' + scheme, { state: { agentYou: true, noNote: true }, hash: '#invite=tok_Probe', w: vp.w, h: vp.h, touch: vp.touch, scheme }, async (page, S) => {
      await page.waitForSelector('#view-agent:not([hidden])', { timeout: 10000 });
      await settle(page);
      // with no preview the read decides the invite's kind, so the room was
      // read (an unused invite opened) before the gate, unasked
      must((S.hits || []).includes('GET /messages'), 'the fallback gate follows the read: ' + JSON.stringify(S.hits));
      // the room was read: the gate keeps the real status
      must((await page.$eval('#status .label', (e) => e.textContent)) !== 'Not connected', 'the fallback gate shows the room\'s own status');
      const block = await page.$eval('#agentBlock', (e) => e.textContent);
      must(block === FALLBACK, 'the fallback is the owner-made note: ' + block.slice(0, 200));
      must(!/whoami|get_room_state/.test(block), 'the fallback names a call that joins: ' + block);
      // the note's lines wrap inside the block: no sideways scroll at phone width
      const fit = await page.$eval('#agentBlock', (e) => ({ sw: e.scrollWidth, cw: e.clientWidth, sh: e.scrollHeight, ch: e.clientHeight, doc: document.documentElement.scrollWidth, vw: window.innerWidth }));
      must(fit.sw <= fit.cw + 1 && fit.doc <= fit.vw + 1, 'the note scrolls sideways: ' + JSON.stringify(fit));
      // and the whole note shows: the box is not cut partway through it
      must(fit.sh <= fit.ch + 1, 'the note is cut inside its box: ' + JSON.stringify(fit));
      await shot(page, 'agent-gate-fallback-' + vp.tag + '-' + scheme + '.png');
      return { chars: block.length };
    });
  }
  // The owner's agent invite: the preview names no inviter, so the app's
  // note is the owner-made form, the same text as the fallback's.
  await run('agent-gate-owner-made', { state: { agentYou: true, probeBy: null }, init: probeInvite }, async (page, S) => {
    await page.waitForSelector('#view-agent:not([hidden])', { timeout: 10000 });
    const block = await page.$eval('#agentBlock', (e) => e.textContent);
    must(block === FALLBACK, 'the owner-made note: ' + block.slice(0, 120));
    must((S.hits || []).includes('GET /invite') && !(S.hits || []).includes('GET /messages'), 'from the preview, the room unread: ' + JSON.stringify(S.hits));
    return { chars: block.length };
  });
  await run('nonmember', { state: { noYou: true }, hash: '#members' }, async (page) => { return { formShown: await page.$eval('#invForm', f => !f.hidden) }; });
  // The gate at the other widths and schemes: closed, then opened (the
  // start page in its own scroll box). At phone width the note shows whole
  // (its box is not cut) and nothing scrolls sideways.
  for (const [tag, o] of [['dark', { scheme: 'dark' }], ['mobile', { w: 390, h: 844, touch: true }], ['mobile-dark', { w: 390, h: 844, touch: true, scheme: 'dark' }]]) {
    await run('agent-gate-' + tag, { state: { agentYou: true }, init: probeInvite, ...o }, async (page, S) => {
      await page.waitForSelector('#view-agent:not([hidden])', { timeout: 10000 });
      await settle(page);
      await startClosed(page, S);
      must((await page.$eval('#agentBlock', (e) => e.textContent)) === NOTE_BY_ANTHONY, 'the note the app builds, member-made');
      const fit = await page.$eval('#agentBlock', (e) => ({ sw: e.scrollWidth, cw: e.clientWidth, sh: e.scrollHeight, ch: e.clientHeight, doc: document.documentElement.scrollWidth, vw: window.innerWidth }));
      must(fit.sw <= fit.cw + 1 && fit.doc <= fit.vw + 1, 'the note scrolls sideways: ' + JSON.stringify(fit));
      if (o.w) must(fit.sh <= fit.ch + 1, 'the note is cut inside its box: ' + JSON.stringify(fit));
      await shot(page, 'agent-gate-' + tag + '.png');
      const start = await startOpened(page, S);
      await settle(page);
      await shot(page, 'agent-gate-start-' + tag + '.png');
      return start;
    });
  }
  // The start page did not load: the gate says so and offers Try again,
  // which reads it again.
  for (const [tag, o] of [['', {}], ['-dark', { scheme: 'dark' }], ['-mobile', { w: 390, h: 844, touch: true }], ['-mobile-dark', { w: 390, h: 844, touch: true, scheme: 'dark' }]]) {
    await run('agent-gate-start-failed' + tag, { state: { agentYou: true, startFail: 1 }, init: probeInvite, ...o }, async (page, S) => {
      await page.waitForSelector('#view-agent:not([hidden])', { timeout: 10000 });
      await page.click('#agentStart > summary');
      await page.waitForSelector('#agentStartRetry', { timeout: 5000 });
      const said = await page.$eval('#agentStart .agent-start-state', (e) => e.textContent.replace(/\s+/g, ' ').trim());
      must(said === "Couldn't load the start page (HTTP 503).Try again", 'the failure and its way to try again: ' + said);
      must(!(await page.$('#agentStartPage')), 'no page shown');
      await page.$eval('#agentStart', (e) => e.scrollIntoView({ block: 'center' }));
      await shot(page, 'agent-gate-start-failed' + tag + '.png');
      await page.click('#agentStartRetry');
      await page.waitForSelector('#agentStartPage', { timeout: 5000 });
      const hits = (S.hits || []).filter((h) => h === 'GET /api/rooms/demo').length;
      must(hits === 2 && (await page.$eval('#agentStartPage', (e) => e.textContent)) === START_PAGE, 'Try again reads the page again: ' + hits);
      return { said, hits };
    });
  }
  // Nothing joins before the person chooses. A device whose browser holds a
  // push subscription (turned on in another room here) opens an agent's
  // invite: until "Open the web app anyway" the page asks the room only
  // with looks (GET /invite, the start page), whatever tab the address
  // names and whatever wakes the page (it comes back into view, online, a
  // storage change); the bell's menu is off and the status reads "Not
  // connected" meanwhile. The bell's status check, which runs access() and
  // so opens an unused invite, comes after the choice.
  const probePush = () => {
    try {
      if (!sessionStorage.getItem('seeded')) {
        sessionStorage.setItem('seeded', '1');
        localStorage.setItem('chat-invite:demo', 'tok_Probe');
        localStorage.setItem('__fake_push_sub', 'https://fcm.googleapis.com/fcm/send/fake-other-room');
        localStorage.setItem('chat-invite:demo-two', 'tok_two');
        localStorage.setItem('chat-push-mode:/api/rooms/demo-two', 'all');
      }
    } catch { /* the scenario fails visibly */ }
  };
  for (const hash of ['', '#games', '#media', '#decisions']) {
    await run('agent-gate-no-join' + (hash ? '-' + hash.slice(1) : ''), { state: { agentYou: true }, init: '(' + fakePush + ')(); (' + probePush + ')();', hash }, async (page, S, calls) => {
      await page.waitForSelector('#view-agent:not([hidden])', { timeout: 10000 });
      await settle(page, 300);
      await page.evaluate(() => {
        document.dispatchEvent(new Event('visibilitychange'));
        window.dispatchEvent(new Event('online'));
        window.dispatchEvent(new StorageEvent('storage', { key: null }));
      });
      await settle(page, 300);
      const roomCalls = () => calls.filter((c) => / \/api\/rooms\//.test(c));
      const looksOnly = (list) => list.every((c) => /^GET \/api\/rooms\/demo(\/invite)?$/.test(c));
      const early = roomCalls();
      must(looksOnly(early) && early.includes('GET /api/rooms/demo/invite'), 'before the choice only looks reach the room: ' + JSON.stringify(early));
      must(!(S.pushLog || []).length, 'the bell asked the room before the choice: ' + JSON.stringify(S.pushLog));
      const off = await page.evaluate(() => ({ bells: [...document.querySelectorAll('.pushBtn')].map((b) => b.disabled), status: document.querySelector('#status .label').textContent, dot: document.getElementById('topDot').title }));
      must(off.bells.length === 2 && off.bells.every(Boolean), 'the bell\'s menu is off while the gate shows: ' + JSON.stringify(off));
      must(off.status === 'Not connected' && off.dot === 'Not connected', 'nothing is connecting while the gate holds the room: ' + JSON.stringify(off));
      // the start page is a look too
      await page.click('#agentStart > summary');
      await page.waitForSelector('#agentStartPage', { timeout: 5000 });
      await settle(page, 300);
      const before = roomCalls();
      must(looksOnly(before) && before.includes('GET /api/rooms/demo'), 'the start page is the only other call: ' + JSON.stringify(before));
      await page.click('#agentApp');
      await page.waitForSelector('#view-chat:not([hidden])', { timeout: 10000 });
      for (let i = 0; i < 250 && !(S.pushLog || []).includes('status tok_Probe'); i++) await new Promise((r) => setTimeout(r, 20));
      const after = roomCalls().slice(before.length);
      must((S.pushLog || []).includes('status tok_Probe'), 'the bell\'s status check runs after the choice: ' + JSON.stringify(S.pushLog));
      must(after.some((c) => c.startsWith('GET /api/rooms/demo/messages')), 'the room is read after the choice: ' + JSON.stringify(after));
      await page.waitForFunction(() => [...document.querySelectorAll('.pushBtn')].every((b) => !b.disabled) && document.querySelector('#status .label').textContent !== 'Not connected', null, { timeout: 4000 });
      return { early: early.length, before: before.length, after: after.length };
    });
  }
  // A person's page whose preview fails with a 5xx: the app reads the room
  // instead, and only after that read do the bell's status check and the
  // Games tab's load (#games) run.
  await run('person-fallback-held', { state: { noNote: true }, init: pushInitSrc, hash: '#games' }, async (page, S, calls) => {
    for (let i = 0; i < 300 && !((S.pushLog || []).some((l) => l.startsWith('status')) && calls.some((c) => c === 'GET /api/rooms/demo/games')); i++) await new Promise((r) => setTimeout(r, 20));
    const at = (pred) => calls.findIndex(pred);
    const out = { preview: at((c) => c === 'GET /api/rooms/demo/invite'), read: at((c) => c.startsWith('GET /api/rooms/demo/messages')), status: at((c) => c.startsWith('GET /api/rooms/demo/push/status')), games: at((c) => c === 'GET /api/rooms/demo/games') };
    must(out.preview >= 0 && out.read > out.preview && out.status > out.read && out.games > out.read, 'the read comes first, then the bell\'s check and the games: ' + JSON.stringify(out));
    must(!(await page.$eval('#view-agent', (e) => !e.hidden)), 'no gate for a person');
    return out;
  });
  // The home page names a room whose name it has not cached with the look
  // (GET /invite): a read would open the agent's unused invite before its
  // person chose at the room's gate ("All rooms" on the gate leads here).
  await run('home-no-join', { state: { agentYou: true }, init: probeInvite }, async (page, S, calls) => {
    await page.waitForSelector('#view-agent:not([hidden])', { timeout: 10000 });
    await settle(page);
    must(!(await page.evaluate(() => localStorage.getItem('chat-you:demo'))), 'no name cached before the home page');
    const from = calls.length;
    await page.goto('https://chat.victorio.cloud/');
    await page.waitForFunction(() => /as Probe/.test(document.querySelector('.roomrow .who')?.textContent || ''), null, { timeout: 10000 });
    await settle(page);
    const room = calls.slice(from).filter((c) => / \/api\/rooms\//.test(c));
    must(JSON.stringify(room) === '["GET /api/rooms/demo/invite"]', 'the home page only looks at the room: ' + JSON.stringify(room));
    return { room, who: await page.$eval('.roomrow .who', (e) => e.textContent) };
  });
  // Forget with an agent's invite never opened, on a device whose browser
  // holds a push subscription: the look says it was never opened, so no
  // push route is called (it would open the invite), and the room is
  // forgotten.
  await run('push-forget-unopened', { state: { agentYou: true }, init: '(' + fakePush + ')(); (' + probePush + ')();' }, async (page, S, calls) => {
    await page.goto('https://chat.victorio.cloud/');
    await settle(page);
    const from = calls.length;
    await page.click('.roomrow:has(.rn:text-is("demo")) .forget');
    await page.waitForSelector('#forgetDlg[open]', { timeout: 4000 });
    await page.click('#forgetYes');
    await page.waitForFunction(() => ![...document.querySelectorAll('.roomrow .rn')].some((r) => r.textContent === 'demo'), null, { timeout: 5000 });
    await settle(page);
    const room = calls.slice(from).filter((c) => / \/api\/rooms\/demo\//.test(c));
    const out = { room, pushLog: S.pushLog || [], invite: await page.evaluate(() => localStorage.getItem('chat-invite:demo')), open: await page.$eval('#forgetDlg', (d) => d.open) };
    must(JSON.stringify(out.room) === '["GET /api/rooms/demo/invite"]' && !out.pushLog.length, 'Forget only looks at an unopened invite: ' + JSON.stringify(out));
    must(out.invite === null && !out.open, 'the room is forgotten: ' + JSON.stringify(out));
    return out;
  });
  // The gate's choice belongs to one invite. A device that chose the web
  // app for agent Probe's invite is offered agent Bot's for the same room
  // and switches to it: Bot gets its own gate, and the room is not read.
  const switchToBot = () => {
    try {
      if (!sessionStorage.getItem('seeded')) {
        sessionStorage.setItem('seeded', '1');
        localStorage.setItem('chat-invite:demo', 'tok_Probe');
        localStorage.setItem('chat-you:demo', 'Probe');
        localStorage.setItem('ac:agent-app:demo', '1');
      }
    } catch { /* the scenario fails visibly */ }
    window.confirm = () => true;
  };
  await run('agent-gate-switch', { state: { agentYou: true, previews: { tok_Bot: { name: 'Bot', kind: 'agent' } } }, init: switchToBot, hash: '#invite=tok_Bot' }, async (page, S) => {
    const asBot = () => (S.hits || []).filter((h) => h === 'GET /invite tok_Bot').length;
    for (let i = 0; i < 500 && asBot() < 2; i++) await new Promise((r) => setTimeout(r, 20));
    await page.waitForSelector('#view-agent:not([hidden])', { timeout: 10000 });
    await settle(page, 300);
    const out = await page.evaluate(() => ({ token: localStorage.getItem('chat-invite:demo'), flag: localStorage.getItem('ac:agent-app:demo'), intro: document.getElementById('agentIntro').textContent.replace(/\s+/g, ' ').trim(), block: document.getElementById('agentBlock').textContent }));
    must(out.token === 'tok_Bot' && out.flag === null, 'the switch saved Bot\'s invite and dropped the choice: ' + JSON.stringify(out));
    must(out.intro.startsWith('This invite belongs to Bot, an agent member') && out.block.includes('X-Invite-Token: tok_Bot '), 'Bot\'s gate: ' + JSON.stringify(out).slice(0, 300));
    const lastBot = S.hits.lastIndexOf('GET /invite tok_Bot');
    must(!S.hits.slice(lastBot).includes('GET /messages'), 'the room was read as Bot before the choice: ' + JSON.stringify(S.hits));
    return { hits: S.hits.length };
  });
  // A person who opened the web app with an agent's invite: the members list
  // the Worker gives that invite holds its own row's link only, and no
  // row's note, so the rows show one link field and no Copy w/ Instructions.
  for (const vp of [{ tag: 'desktop', w: 1280, h: 860 }, { tag: 'phone', w: 390, h: 844, touch: true }]) for (const scheme of ['light', 'dark']) {
    await run('members-agent-invite-' + vp.tag + '-' + scheme, { state: { agentYou: true }, init: probeInWebApp, hash: '#members', w: vp.w, h: vp.h, touch: vp.touch, scheme }, async (page) => {
      await page.waitForSelector('#mList .card.member', { timeout: 10000 });
      await settle(page);
      const links = await page.$$eval('.member-link input', (is) => is.map((i) => i.value));
      const instr = await page.$$eval('button', (bs) => bs.filter((b) => b.textContent === 'Copy w/ Instructions').length);
      const rows = await page.$$eval('#mList .card.member', (cs) => cs.length);
      must(links.length === 1 && links[0].endsWith('#invite=tok_Probe'), 'one link field, the invite\'s own: ' + JSON.stringify(links));
      must(instr === 0, 'no Copy w/ Instructions: ' + instr);
      must(rows > 1, 'the other members are listed: ' + rows);
      await shot(page, 'members-agent-invite-' + vp.tag + '-' + scheme + '.png');
      return { rows, links: links.length };
    });
  }
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
  // The room's phone stylesheet hides the composer's keyboard hint
  // ("Ctrl+Enter to send"). Its rule hid every .hint, and with both pages
  // on one stylesheet that took Home's hints with it on a phone: a pasted
  // bad invite link did nothing visible, and the create form lost its help.
  await run('home-hints-phone', { w: 390, h: 844, touch: true }, async (page) => {
    const vis = (sel) => page.$eval(sel, (e) => !!e.offsetParent && getComputedStyle(e).display !== 'none');
    const out = { composerHint: await vis('.composer-meta .hint') };
    await page.goto('https://chat.victorio.cloud/');
    await settle(page);
    await page.fill('#link', 'not a link');
    await page.click('#joinlink button[type=submit]');
    out.join = { shown: await vis('#hint'), text: await page.$eval('#hint', (e) => e.textContent) };
    await page.screenshot({ path: OUT + 'home-hints-phone.png' });
    await page.click('#menu');
    await page.click('.tab[data-view="create"]');
    await settle(page);
    out.createHints = await page.$$eval('#view-create .hint', (hs) => hs.map((h) => !!h.offsetParent));
    await page.screenshot({ path: OUT + 'home-hints-phone-create.png', fullPage: true });
    must(!out.composerHint, 'the composer\'s keyboard hint stays hidden on a phone: ' + JSON.stringify(out));
    must(out.join.shown && /not an invite link/.test(out.join.text), 'a bad invite link must say so on a phone: ' + JSON.stringify(out));
    must(out.createHints.length > 2 && out.createHints.slice(0, 3).every(Boolean), 'the create form\'s hints must show on a phone: ' + JSON.stringify(out));
    return out;
  });
  // The home page's How and For agents views: only the site's owner revokes
  // an invite (no room has an owner), and a wrong or revoked token is a 403.
  for (const [view, want] of [['how', /Share them privately; the site's owner can revoke one\s+without disturbing anyone else\./], ['agents', /an agent without a valid invite is refused \(401 with no token, 403 with a wrong or\s+revoked one\) and cannot read or post\./]]) {
    for (const vp of [{ tag: 'desktop', w: 1280, h: 860 }, { tag: 'phone', w: 390, h: 844, touch: true }]) for (const scheme of ['light', 'dark']) {
      await run('home-' + view + '-' + vp.tag + '-' + scheme, { w: vp.w, h: vp.h, touch: vp.touch, scheme }, async (page) => {
        await page.goto('https://chat.victorio.cloud/');
        await settle(page);
        if (vp.touch) { await page.click('#menu'); await settle(page); }
        await page.click('.tab[data-view="' + view + '"]');
        await page.waitForSelector('#view-' + view + ':not([hidden])', { timeout: 10000 });
        await settle(page);
        const text = await page.$eval('#view-' + view, (e) => e.textContent);
        must(want.test(text), 'the ' + view + ' view carries the corrected sentence: ' + text.slice(0, 400));
        must(!/room owner|gets a 401/.test(text), 'the ' + view + ' view keeps a false sentence');
        await shot(page, 'home-' + view + '-' + vp.tag + '-' + scheme + '.png');
        return { ok: true };
      });
    }
  }
  async function runHome() {
    const name = 'home-page';
    const b = await chromium.launch({});
    const ctx = await b.newContext({ serviceWorkers: 'block', viewport: { width: 1280, height: 860 }, timezoneId: 'UTC', locale: 'en-US' });
    const page = await ctx.newPage();
    await installClock(page);
    const errs = [];
    const roomCalls = [];
    page.on('pageerror', (e) => errs.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
    await page.route('https://chat.victorio.cloud/**', async (route) => {
      const u = new URL(route.request().url());
      const pth = u.pathname;
      const J = (o, st) => route.fulfill({ status: st || 200, contentType: 'application/json', body: JSON.stringify(o) });
      if (pth.startsWith('/api/rooms/')) roomCalls.push(route.request().method() + ' ' + pth + u.search);
      if (pth === '/' || pth === '/index.html' || pth.startsWith('/r/')) return route.fulfill({ status: 200, contentType: 'text/html', body: HTML });
      if (pth === '/api/build') return J({ build: 'uitestbuild2' });
      if (pth.endsWith('/messages')) return J({ messages: [], you: 'Tester' });
      // the home page names a room with the look, which opens nothing
      if (pth.endsWith('/invite')) return J({ room: pth.split('/')[3], invite: { name: 'Tester', kind: 'human', status: 'active', invited_by: null, invited: 0, joined: 0 }, purpose: null, members: [], opened: true });
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
      // the names come from the look alone: nothing the home page asks opens an invite
      if (JSON.stringify(roomCalls.slice().sort()) !== JSON.stringify(['GET /api/rooms/demo-room/invite', 'GET /api/rooms/second-room/invite'])) throw new Error('the home page asked the rooms more than a look: ' + JSON.stringify(roomCalls));
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
  // The create form's refusals in plain words: an address with a name or
  // angle brackets around it is stopped before any request (so is one the
  // server's plainAddress refuses for its local part's length or a last
  // label with no letter), the server's email_invalid 400 says the same,
  // and a 503 room_pending (another creator's room still waiting on its
  // mail) says to wait or pick another name, not that creation is down.
  async function runCreateRefusals(name, w, h) {
    if (process.env.ONLY && !process.env.ONLY.split(',').includes(name)) return;
    const b = await chromium.launch({});
    const ctx = await b.newContext({ serviceWorkers: 'block', viewport: { width: w, height: h }, timezoneId: 'UTC', locale: 'en-US', hasTouch: w < 500, isMobile: w < 500 });
    const page = await ctx.newPage();
    await installClock(page);
    const errs = [];
    page.on('pageerror', (e) => errs.push(e.message));
    const answers = [
      { status: 503, body: { error: 'Someone is creating a room with that name right now.', code: 'room_pending' }, headers: { 'Retry-After': '540' } },
      { status: 400, body: { error: '"email" must be a plain address like name@example.com', code: 'email_invalid' } },
    ];
    const sent = [];
    await page.route('https://chat.victorio.cloud/**', async (route) => {
      const pth = new URL(route.request().url()).pathname;
      if (pth === '/' || pth === '/index.html') return route.fulfill({ status: 200, contentType: 'text/html', body: HTML });
      if (pth === '/api/build') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ build: 'next-dev' }) });
      if (pth === '/api/create-room') {
        sent.push(route.request().postDataJSON());
        // a request the form should not have sent finds no answer left
        const a = answers.shift() || { status: 500, body: {} };
        return route.fulfill({ status: a.status, contentType: 'application/json', headers: a.headers || {}, body: JSON.stringify(a.body) });
      }
      if (pth.startsWith('/assets/')) { try { const b2 = require('fs').readFileSync(DIST + pth); return route.fulfill({ status: 200, contentType: pth.endsWith('.css') ? 'text/css' : 'text/javascript', body: b2 }); } catch { return route.fulfill({ status: 404, body: 'nf' }); } }
      if (pth.startsWith('/icons/')) return route.fulfill({ status: 200, contentType: 'image/png', body: ICON_PNG });
      return route.fulfill({ status: 404, body: 'nf' });
    });
    const out = {};
    try {
      await page.goto('https://chat.victorio.cloud/');
      await settle(page);
      await page.evaluate(() => document.querySelector('.tab[data-view="create"]').click());
      await settle(page);
      await page.fill('#cRoom', 'busy-room');
      await page.fill('#cName', 'Ada');
      await page.fill('#cEmail', 'Ada <ada@example.com>');
      await page.click('#cGo');
      out.local = await page.$eval('#cMsg', (e) => e.textContent);
      out.sentAfterLocal = sent.length;
      // the server's two other rules, mirrored: a last label with a letter, a local part of at most 64
      out.mirror = [];
      for (const bad of ['ada@example.123', 'a'.repeat(65) + '@example.com']) {
        // another message first, so the one read below is this address's
        await page.fill('#cEmail', 'ada');
        await page.click('#cGo');
        await page.fill('#cEmail', bad);
        await page.click('#cGo');
        out.mirror.push(await page.$eval('#cMsg', (e) => e.textContent));
      }
      out.sentAfterMirror = sent.length;
      await page.fill('#cEmail', 'ada@example.com');
      await page.click('#cGo');
      await page.waitForFunction(() => /creating a room with that name/.test(document.getElementById('cMsg').textContent), null, { timeout: 5000 });
      out.pending = await page.$eval('#cMsg', (e) => e.textContent);
      await page.$eval('#cMsg', (e) => e.scrollIntoView({ block: 'center' }));
      await page.screenshot({ path: OUT + name + '-pending.png' });
      await page.click('#cGo');
      await page.waitForFunction(() => /on its own/.test(document.getElementById('cMsg').textContent), null, { timeout: 5000 });
      out.server400 = await page.$eval('#cMsg', (e) => e.textContent);
      out.focused = await page.evaluate(() => document.activeElement && document.activeElement.id);
      await page.$eval('#cMsg', (e) => e.scrollIntoView({ block: 'center' }));
      await page.screenshot({ path: OUT + name + '-address.png' });
      out.msgBox = await page.$eval('#cMsg', (e) => { const r = e.getBoundingClientRect(); return { right: Math.round(r.right), bad: e.classList.contains('bad') }; });
    } catch (e) {
      failed();
      console.log('FAIL ' + name + ': harness error: ' + e.message);
    }
    await b.close();
    const ok = /on its own, like name@example.com/.test(out.local || '') && out.sentAfterLocal === 0
      && out.mirror && out.mirror.length === 2 && out.mirror.every((t) => /before the @, an ordinary domain after it/.test(t)) && out.sentAfterMirror === 0
      && /Try again in a few minutes, or pick another name/.test(out.pending || '') && !/unavailable/.test(out.pending || '')
      && /on its own, like name@example.com/.test(out.server400 || '') && out.focused === 'cEmail'
      && out.msgBox && out.msgBox.bad && out.msgBox.right <= w;
    if (errs.length || !ok) {
      failed();
      console.log('FAIL ' + name + ': ' + JSON.stringify({ out, errs }));
    } else {
      console.log('PASS ' + name + ' ' + JSON.stringify(out));
    }
  }
  await runCreateRefusals('home-create-refusals', 1280, 860);
  await runCreateRefusals('home-create-refusals-phone', 390, 844);
  await runHome();
  done('shell');
})();
