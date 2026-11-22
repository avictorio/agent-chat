// UI scenarios: invites, avatars, uploads and the media shelf.
// Run alone: node -r ./tests/system-chromium.js tests/ui/people-media.test.js
// (ONLY=name1,name2 runs just those). All files: npm test.
const { settle, FIXTURES, TESTS, done, must, run, shot } = require('./harness');

(async () => {
  await run('invites', {}, async (page, S, calls) => {
    await shot(page, 'kinds-chat.png');
    const tags = await page.$$eval('#msgs .msg-head', hs => hs.map(h => Array.from(h.querySelectorAll('.tag')).map(t => t.textContent).join('+') + ':' + h.querySelector('.who').textContent));
    await page.click('.tab[data-tab="members"]'); await settle(page);
    const formShown = await page.$eval('#invForm', f => !f.hidden);
    const instrCount = await page.$$eval('button', bs => bs.filter(b => b.textContent === 'Copy w/ Instructions').length);
    await shot(page, 'members-desktop.png');
    await page.fill('#invName', 'Matheo'); await page.click('[data-kind="human"]'); await page.click('#invForm button[type=submit]'); await settle(page);
    await shot(page, 'invite-human.png');
    const humanFields = await page.$$eval('#invResult input', i => i.map(x => x.value));
    const humanBtns = await page.$$eval('#invResult button', b => b.map(x => x.textContent));
    await page.fill('#invName', 'Scout'); await page.click('[data-kind="agent"]'); await page.click('#invForm button[type=submit]'); await settle(page);
    await shot(page, 'invite-agent.png');
    const agentFields = await page.$$eval('#invResult input', i => i.map(x => x.value));
    const agentBtns = await page.$$eval('#invResult button', b => b.map(x => x.textContent));
    await page.fill('#invName', 'Ada'); await page.click('#invForm button[type=submit]'); await settle(page);
    const dupToast = await page.$eval('#toast', t => t.hidden ? '' : t.textContent);
    const posts = calls.filter(c => c.startsWith('POST') && c.includes('/invites')).map(c => c.split(' ').slice(2).join(' '));
    return { tags, formShown, instrCount, humanFields, agentFields, humanBtns, agentBtns, dupToast, posts };
  });
  await run('invite-card-mobile-dark', { scheme: 'dark', w: 390, h: 844, hash: '#members' }, async (page) => {
    await page.fill('#invName', 'Scout'); await page.click('[data-kind="agent"]'); await page.click('#invForm button[type=submit]'); await settle(page);
    await shot(page, 'invite-agent-mobile-dark.png');
    return { btns: await page.$$eval('#invResult button', b => b.map(x => x.textContent)) };
  });
  await run('invites-dark-mobile', { scheme: 'dark', w: 390, h: 844, hash: '#members' }, async (page) => { await shot(page, 'members-mobile-dark.png'); });
  /* A reload paints avatars at once (2026-11-19): the roster is remembered
     per room on the device, so the chat shows each picture before
     /members answers (here held back 3 s) instead of initials. */
  await run('avatars-instant-reload', {}, async (page) => {
    await page.waitForSelector('#msgs .msg .gutter .avatar.img img', { timeout: 10000 });
    const first = await page.$$eval('#msgs .msg:not(.cont) .gutter .avatar', as => as.filter(a => a.querySelector('img')).length);
    await page.route(/\/api\/rooms\/[^/]+\/members(\?|$)/, async (route) => { await new Promise((r) => setTimeout(r, 3000)); await route.fallback(); });
    await page.reload();
    await page.waitForSelector('#msgs .msg', { timeout: 10000 });
    await settle(page);
    const early = await page.$$eval('#msgs .msg:not(.cont) .gutter .avatar', as => as.filter(a => a.querySelector('img')).length);
    if (!first || early !== first) throw new Error('after a reload, avatars should show before /members answers: ' + early + ' of ' + first);
    return { first, early };
  });
  await run('avatars', {}, async (page, S, calls) => {
    const out = {};
    out.chatAvatars = await page.$$eval('#msgs .msg:not(.cont) .gutter .avatar', as => as.map(a => a.className + (a.querySelector('img') ? ':img' : a.querySelector('svg') ? ':svg' : ':' + a.textContent)));
    await shot(page, 'avatars-chat.png');
    await page.click('.tab[data-tab="members"]'); await settle(page);
    out.before = await page.$$eval('#mList .photo-actions button', b => b.map(x => x.textContent));
    const [fc] = await Promise.all([page.waitForEvent('filechooser'), page.click('#mList .photo-actions button:has-text("Add a photo")')]);
    await fc.setFiles(FIXTURES + 'photo.png'); await settle(page);
    out.upload = calls.filter(c => c.startsWith('PUT') && c.includes('/avatar'));
    out.after = await page.$$eval('#mList .photo-actions button', b => b.map(x => x.textContent));
    out.myAvatarImg = await page.$eval('#mList .card.member .avatar img', i => i.complete && i.naturalWidth + 'x' + i.naturalHeight).catch(() => 'none');
    out.uploadedSize = S.av.anthony ? S.av.anthony.buf.length : 0;
    await shot(page, 'avatars-members.png');
    const [fc2] = await Promise.all([page.waitForEvent('filechooser'), page.click('#mList .photo-actions button:has-text("Change photo")')]);
    await fc2.setFiles(FIXTURES + 'henry.gif'); await settle(page);
    out.gifUpload = calls.filter(c => c.startsWith('PUT') && c.includes('/avatar')).slice(-1)[0];
    const [fc3] = await Promise.all([page.waitForEvent('filechooser'), page.click('#mList .photo-actions button:has-text("Change photo")')]);
    await fc3.setFiles(FIXTURES + 'notimage.png'); await settle(page);
    out.badToast = await page.$eval('#toast', t => t.textContent);
    await page.click('#mList .photo-actions button:has-text("Remove photo")'); await settle(page);
    out.afterRemove = await page.$$eval('#mList .photo-actions button', b => b.map(x => x.textContent));
    await page.click('.tab[data-tab="chat"]'); await settle(page);
    return out;
  });
  await run('avatars-dark-mobile', { scheme: 'dark', w: 390, h: 844 }, async (page) => { await shot(page, 'avatars-mobile-dark.png'); });
  for (const [label, o] of [['avatar-dialog', {}], ['avatar-dialog-dark-mobile', { scheme: 'dark', w: 390, h: 844 }]]) {
    await run(label, o, async (page) => {
      const out = {};
      await page.click('#msgs .msg[data-id="1"] .avatar'); await settle(page);
      out.henry = await page.evaluate(() => ({ open: document.getElementById('avDlg').open, name: document.getElementById('avName').textContent, kind: document.getElementById('avKind').textContent, img: (document.querySelector('#avBig img') || {}).naturalWidth, size: document.querySelector('#avBig .avatar').getBoundingClientRect().width }));
      // Name and kind pill sit on one .title-row line in the current
      // app; stacked block divs are a divergence.
      const avRow = await page.evaluate(() => { const n = document.getElementById('avName'), k = document.getElementById('avKind'); return !!(n && k && n.parentElement && n.parentElement.classList.contains('title-row') && k.parentElement === n.parentElement); });
      if (!avRow) throw new Error('avatar dialog name/kind are not on one title-row');
      await shot(page, label + '-gif.png');
      await page.keyboard.press('Escape'); await settle(page);
      out.closedByEsc = await page.evaluate(() => !document.getElementById('avDlg').open);
      await page.click('#msgs .msg[data-id="4"] .avatar'); await settle(page);
      out.claude = await page.evaluate(() => ({ name: document.getElementById('avName').textContent, kind: document.getElementById('avKind').textContent, svg: !!document.querySelector('#avBig svg') }));
      // The in-room bot is retired (2026-11-12) and "claude" is an ordinary
      // name: a non-member sender by that name gets no Bot pill and no bot glyph.
      if (out.claude.kind !== '' || out.claude.svg) throw new Error('claude should render as an ordinary sender, got ' + JSON.stringify(out.claude));
      await shot(page, label + '-claude.png');
      await page.mouse.click(5, 5); await settle(page);
      out.closedByBackdrop = await page.evaluate(() => !document.getElementById('avDlg').open);
      await page.click('#msgs .msg[data-id="3"] .avatar'); await settle(page);
      out.ada = await page.evaluate(() => ({ text: document.querySelector('#avBig .avatar').textContent, kind: document.getElementById('avKind').textContent }));
      await shot(page, label + '-initials.png');
      await page.click('#avClose'); await settle(page);
      out.closedByButton = await page.evaluate(() => !document.getElementById('avDlg').open);
      await page.focus('#msgs .msg[data-id="5"] .avatar'); await page.keyboard.press('Enter'); await settle(page);
      out.keyboard = await page.evaluate(() => document.getElementById('avDlg').open && document.getElementById('avName').textContent);
      return out;
    });
  }
  await run('upload-file', { state: { files: true }, hash: '#invite=tok_Anthony' }, async (page, S, calls) => {
    const out = {};
    const fc = page.locator('.file-card').first();
    await fc.waitFor({ timeout: 4000 });
    out.dl = await fc.getAttribute('download');
    out.href = await fc.getAttribute('href');
    out.fcText = (await fc.textContent()).replace(/\s+/g, ' ').trim();
    must(out.dl === 'lima-survey-2026.zip' && /\/messages\/60\/file\?/.test(out.href) && /ZIP/.test(out.fcText) && /700 MB/.test(out.fcText), 'file card: ' + JSON.stringify(out));
    out.bigImgCards = await page.locator('.big-img-card').count();
    out.inlineBig = await page.locator('img.msg-img[src*="/61/"]').count();
    must(out.bigImgCards === 1 && out.inlineBig === 0, 'a very large image should be a card: ' + JSON.stringify(out));
    S.partDelay = 120;
    S.failOnce = 3;
    await page.setInputFiles('#anyFile', { name: 'report.pdf', mimeType: 'application/pdf', buffer: Buffer.alloc(300000, 7) });
    await page.locator('#fileChip:not([hidden])').waitFor({ timeout: 3000 });
    out.chip = await page.textContent('#fileName');
    must(/report\.pdf \(293 KB\)/.test(out.chip), 'file chip: ' + out.chip);
    await shot(page, 'upload-armed.png');
    await page.fill('#text', 'Quarterly report');
    await page.click('#send');
    await page.locator('#uplCard').waitFor({ timeout: 3000 });
    await page.waitForFunction(() => /\d+% · .+ of 293 KB/.test((document.querySelector('#uplMeta') || {}).textContent || ''), null, { timeout: 10000 });
    out.meta = await page.textContent('#uplMeta');
    await shot(page, 'upload-progress.png');
    await page.locator('#uplCard').waitFor({ state: 'detached', timeout: 20000 });
    const card = page.locator('.file-card', { hasText: 'report.pdf' });
    await card.waitFor({ timeout: 4000 });
    const seq = calls.map((c) => c.split(' ').slice(0, 2).join(' '));
    const at = (re) => seq.findIndex((c) => re.test(c));
    out.parts = seq.filter((c) => /PUT .*\/messages\/101\/file\/part\?n=/.test(c)).length;
    out.part3 = seq.filter((c) => /\/file\/part\?n=3$/.test(c)).length;
    out.order = [at(/^POST .*\/messages$/), at(/\/101\/file\/start$/), at(/\/101\/file\/finish$/), at(/\/101\/publish$/)];
    must(out.parts === 6 && out.part3 === 2, 'five parts, part 3 retried once: ' + JSON.stringify(out));
    must(out.order.every((x, i) => x >= 0 && (i === 0 || x > out.order[i - 1])), 'draft, start, finish, publish in order: ' + JSON.stringify(out.order));
    out.chipGone = await page.$eval('#fileChip', (e) => e.hidden);
    out.textCleared = (await page.inputValue('#text')) === '';
    must(out.chipGone && out.textCleared, 'composer cleared after the send: ' + JSON.stringify(out));
    out.resumeNote = await page.locator('#uplResume').count();
    must(out.resumeNote === 0, 'no interrupted-upload note after a clean send');
    await shot(page, 'upload-file.png');
    return { meta: out.meta, parts: out.parts };
  });
  await run('upload-file-dark', { state: { files: true }, hash: '#invite=tok_Anthony', scheme: 'dark', w: 390, h: 844, touch: true }, async (page) => {
    const fc = page.locator('.file-card').first();
    await fc.waitFor({ timeout: 4000 });
    await fc.scrollIntoViewIfNeeded();
    const box = await fc.boundingBox();
    must(box && box.x >= 0 && box.x + box.width <= 390, 'file card fits the phone: ' + JSON.stringify(box));
    await shot(page, 'upload-file-dark-phone.png');
    return { w: Math.round(box.width) };
  });
  await run('upload-direct', { hash: '#invite=tok_Anthony' }, async (page, S, calls) => {
    // Parts straight to storage: presigned addresses, no credential on the
    // storage request, an expired address signed again and retried.
    S.direct = true;
    const r2 = [];
    let refused = false;
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'PUT', 'access-control-allow-headers': '*', 'access-control-expose-headers': 'ETag' };
    await page.route('https://acct.r2.cloudflarestorage.com/**', async (route) => {
      const req = route.request();
      if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
      const u = new URL(req.url());
      const n = +u.searchParams.get('partNumber');
      r2.push({ n, token: req.headers()['x-invite-token'] || null, len: (req.postDataBuffer() || []).length, sig: u.searchParams.get('X-Amz-Signature') });
      if (n === 2 && !refused) { refused = true; return route.fulfill({ status: 403, headers: Object.assign({ 'content-type': 'application/xml' }, cors), body: '<Error><Code>AccessDenied</Code><Message>Request has expired</Message></Error>' }); }
      const seg = u.pathname.split('/');
      const up = S.ups[seg[3] + ':' + seg[4]];
      if (up) up.got.add(n);
      return route.fulfill({ status: 200, headers: Object.assign({ etag: '"e' + n + '"' }, cors), body: '' });
    });
    await page.setInputFiles('#anyFile', { name: 'archive.tar', mimeType: 'application/x-tar', buffer: Buffer.alloc(200000, 9) });
    await page.click('#send');
    await page.locator('.file-card', { hasText: 'archive.tar' }).waitFor({ timeout: 20000 });
    const viaSite = calls.filter((c) => /\/file\/part\?n=/.test(c)).length;
    const startBody = calls.find((c) => /\/101\/file\/start /.test(c)) || '';
    const part2 = r2.filter((x) => x.n === 2);
    must(/"direct":true/.test(startBody), 'the client asks for direct: ' + startBody.slice(-120));
    must(viaSite === 0, 'no part went through the site: ' + viaSite);
    must(r2.length === 5 && r2.every((x) => x.token === null), 'four parts plus one retry, none carrying the invite: ' + JSON.stringify(r2));
    must(part2.length === 2 && part2[0].sig !== part2[1].sig && (S.signs || 0) >= 2, 'the refused part was signed again: ' + JSON.stringify({ part2, signs: S.signs }));
    must(calls.some((c) => /\/101\/file\/finish/.test(c)) && calls.some((c) => /\/101\/publish/.test(c)), 'finished and published');
    return { r2: r2.length, signs: S.signs };
  });
  await run('upload-cancel', { hash: '#invite=tok_Anthony' }, async (page, S, calls) => {
    S.partDelay = 900;
    await page.setInputFiles('#anyFile', { name: 'big.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(400000, 1) });
    await page.click('#send');
    await page.locator('#uplCard').waitFor({ timeout: 3000 });
    await page.click('#uplCancel');
    await page.locator('#uplCard').waitFor({ state: 'detached', timeout: 5000 });
    await page.waitForFunction(() => { const t = document.querySelector('#toast'); return t && !t.hidden && /cancelled/i.test(t.textContent || ''); }, null, { timeout: 3000 });
    await settle(page);
    const aborted = calls.some((c) => /^POST .*\/messages\/101\/file\/abort/.test(c));
    const deleted = calls.some((c) => /^DELETE .*\/messages\/101$/.test(c));
    const published = calls.some((c) => /\/publish/.test(c));
    must(aborted && deleted && !published, 'cancel aborts the upload and deletes the draft: ' + JSON.stringify({ aborted, deleted, published }));
    must(await page.locator('#fileChip').isVisible(), 'the file stays armed after a cancel');
    must((await page.locator('#uplResume').count()) === 0, 'a cancelled upload leaves no interrupted note');
    return { aborted, deleted };
  });
  await run('upload-interrupted', {
    hash: '#invite=tok_Anthony', w: 390, h: 844, touch: true,
    init: () => { try { localStorage.setItem('chat-upl:demo', JSON.stringify([{ key: 'chat-draft:demo:x', id: 77, names: ['holiday.mp4'], total: 5e9, kinds: ['video'], ts: Date.now() - 3600e3 }])); } catch {} },
  }, async (page, S, calls) => {
    const note = page.locator('#uplResume');
    await note.waitFor({ timeout: 4000 });
    const text = (await note.textContent()).replace(/\s+/g, ' ');
    must(/holiday\.mp4 didn't finish uploading/.test(text), 'interrupted note: ' + text);
    await shot(page, 'upload-interrupted-phone.png');
    await page.click('#uplDiscard');
    await note.waitFor({ state: 'detached', timeout: 3000 });
    must(calls.some((c) => /^POST .*\/messages\/77\/video\/abort/.test(c)) && calls.some((c) => /^DELETE .*\/messages\/77$/.test(c)), 'discard aborts and deletes the draft');
    const stored = await page.evaluate(() => localStorage.getItem('chat-upl:demo'));
    must(stored === null, 'discard forgets the note: ' + stored);
    return { ok: true };
  });
  await run('upload-route-phone', { hash: '#invite=tok_Anthony', w: 390, h: 844, touch: true }, async (page) => {
    // a photo through the paperclip lands in the image slot
    await page.setInputFiles('#anyFile', require('path').join(TESTS, '../../tests/fixtures/photo.png'));
    await page.locator('#attachRow:not([hidden])').waitFor({ timeout: 3000 });
    // a photo type the chat can't show attaches as a file, with a note
    await page.setInputFiles('#imgFile', { name: 'IMG_0042.heic', mimeType: 'image/heic', buffer: Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypheic'), Buffer.alloc(5000, 3)]) });
    await page.locator('#fileChip:not([hidden])').waitFor({ timeout: 3000 });
    const chip = await page.textContent('#fileName');
    const toastText = await page.$eval('#toast', (t) => t.textContent || '');
    must(/IMG_0042\.heic/.test(chip) && /can't be shown/.test(toastText), 'routing: ' + chip + ' | ' + toastText);
    await shot(page, 'upload-route-phone.png');
    // and the progress card at phone width
    return { chip };
  });
  await run('upload-progress-phone', { hash: '#invite=tok_Anthony', w: 390, h: 844, touch: true }, async (page, S) => {
    S.partDelay = 2500;
    await page.setInputFiles('#anyFile', { name: 'site-survey-final-version-2.dwg', mimeType: 'application/acad', buffer: Buffer.alloc(260000, 5) });
    await page.click('#send');
    await page.locator('#uplCard').waitFor({ timeout: 3000 });
    await page.waitForFunction(() => /\d+% ·/.test((document.querySelector('#uplMeta') || {}).textContent || ''), null, { timeout: 10000 });
    const box = await page.locator('#uplCard').boundingBox();
    must(box && box.width <= 390 && box.x >= 0, 'progress card fits the phone: ' + JSON.stringify(box));
    const sw = await page.evaluate(() => document.documentElement.scrollWidth);
    must(sw <= 390, 'no horizontal scroll: ' + sw);
    await shot(page, 'upload-progress-phone.png');
    await page.locator('#uplCard').waitFor({ state: 'detached', timeout: 20000 });
    return { box: Math.round(box.width) };
  });
  await run('media-shelf', { state: { artifacts: true, shelf: true }, hash: '#invite=tok_Anthony' }, async (page) => {
    await page.click('.tab[data-tab="media"]');
    await page.waitForSelector('.media-tile', { timeout: 10000 });
    const out = {};
    out.tiles = await page.$$eval('.media-tile', ts => ts.length);
    out.allCount = await page.$eval('.media-bar .seg button[aria-pressed="true"] .media-n', e => e.textContent).catch(() => null);
    await shot(page, 'media-grid.png');
    await page.click('.media-bar .seg button:nth-child(2)');
    await page.waitForFunction(() => document.querySelectorAll('.media-tile').length === 1);
    out.photosOnly = await page.$$eval('.media-tile', ts => ts.length);
    await page.click('.media-bar .seg button:nth-child(1)');
    await page.waitForFunction(() => document.querySelectorAll('.media-tile').length === 5);
    await page.selectOption('.media-from', 'Anthony');
    await page.waitForFunction(() => document.querySelectorAll('.media-tile').length === 1);
    out.senderKinds = await page.$$eval('.media-tile .media-kind', ts => ts.map(t => t.textContent));
    await page.selectOption('.media-from', '');
    await page.waitForFunction(() => document.querySelectorAll('.media-tile').length === 5);
    out.tileRef = await page.$eval('.media-tile .media-ref', e => e.textContent);
    await page.click('.media-tile:has(img)');
    await page.waitForSelector('#viewer:not([hidden]) .viewer-img', { timeout: 10000 });
    out.viewerOpen = true;
    out.capRef = await page.$eval('.media-cap-ref code', e => e.textContent);
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.click('.media-cap-ref .btn');
    await page.waitForFunction(() => document.querySelector('.media-cap-ref .btn').textContent === 'Copied', null, { timeout: 10000 });
    out.clipboard = await page.evaluate(() => navigator.clipboard.readText());
    await shot(page, 'media-viewer.png');
    await page.click('.media-cap .media-jump');
    await page.waitForFunction(() => document.querySelector('#viewer').hidden, null, { timeout: 10000 });
    out.backInChat = await page.$eval('#view-chat', e => !e.hidden);
    await page.waitForFunction(() => { const el = document.querySelector('.msg[data-id="8"]'); return !!el && el.classList.contains('flash'); }, null, { timeout: 5000 });
    out.flashed = true;
    return out;
  });
  await run('media-shelf-mobile', { state: { artifacts: true, shelf: true }, hash: '#invite=tok_Anthony', w: 390, h: 844, touch: true }, async (page) => {
    await page.tap('#menu');
    await settle(page);
    await page.tap('.tab[data-tab="media"]');
    await page.waitForSelector('.media-tile', { timeout: 10000 });
    await settle(page); // let the drawer finish closing before the shot
    const tiles = await page.$$eval('.media-tile', ts => ts.length);
    const overflow = await page.evaluate(() => {
      const seg = document.querySelector('.media-bar .seg');
      return {
        doc: document.documentElement.scrollWidth - window.innerWidth,
        bar: seg ? seg.getBoundingClientRect().right - window.innerWidth : 0,
      };
    });
    if (overflow.doc > 0 || overflow.bar > 0) throw new Error('media bar overflows the viewport: ' + JSON.stringify(overflow));
    await shot(page, 'media-grid-mobile.png');
    return { tiles, overflow };
  });

  done('people-media');
})();
