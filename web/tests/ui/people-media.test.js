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
  /* A reload paints avatars at once: the roster is remembered
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
      // There is no in-room bot: "claude" is an ordinary name, so a
      // non-member sender by that name gets no Bot pill and no bot glyph.
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
    const deleted = calls.some((c) => /^DELETE .*\/messages\/101\?draft_only=1$/.test(c));
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
    must(calls.some((c) => /^POST .*\/messages\/77\/video\/abort/.test(c)) && calls.some((c) => /^DELETE .*\/messages\/77\?draft_only=1$/.test(c)), 'discard aborts and deletes the draft, and only a draft');
    const stored = await page.evaluate(() => localStorage.getItem('chat-upl:demo'));
    must(stored === null, 'discard forgets the note: ' + stored);
    return { ok: true };
  });
  await run('upload-discard-posted', {
    // the note is this browser's, but another device picked the draft up
    // by fingerprint and published it: Discard must not delete it
    hash: '#invite=tok_Anthony',
    init: () => { try { localStorage.setItem('chat-upl:demo', JSON.stringify([{ key: 'chat-draft:demo:x', id: 77, names: ['holiday.mp4'], total: 5e9, kinds: ['video'], ts: Date.now() - 3600e3 }])); } catch {} },
  }, async (page, S, calls) => {
    S.msgs.push({ id: 77, ts: S.msgs[S.msgs.length - 1].ts + 1000, from: 'Anthony', text: 'from the laptop' });
    const note = page.locator('#uplResume');
    await note.waitFor({ timeout: 4000 });
    await page.click('#uplDiscard');
    await note.waitFor({ state: 'detached', timeout: 3000 });
    await page.waitForFunction(() => { const t = document.querySelector('#toast'); return t && !t.hidden && /already posted/.test(t.textContent || ''); }, null, { timeout: 3000 });
    const toastText = await page.$eval('#toast', (t) => t.textContent || '');
    must(calls.some((c) => /^DELETE .*\/messages\/77\?draft_only=1$/.test(c)), 'discard asks for a draft-only delete');
    must(S.msgs.some((x) => x.id === 77), 'the live message is still in the room');
    must(/holiday\.mp4 was already posted/.test(toastText), 'the person is told it was posted: ' + toastText);
    const stored = await page.evaluate(() => localStorage.getItem('chat-upl:demo'));
    must(stored === null, 'the note is forgotten: ' + stored);
    await shot(page, 'upload-discard-posted.png');
    return { toastText };
  });
  await run('upload-cancel-after-publish', { hash: '#invite=tok_Anthony' }, async (page, S, calls) => {
    // the publish lands but its answer is lost: the engine retries, and a
    // Cancel then must not delete what is already live
    S.publishLost = true;
    await page.setInputFiles('#anyFile', { name: 'notes.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(100000, 2) });
    await page.fill('#text', 'the notes');
    await page.click('#send');
    await page.waitForFunction(() => /Connection trouble/.test((document.querySelector('#uplMeta') || {}).textContent || ''), null, { timeout: 10000 });
    await page.click('#uplCancel');
    await page.locator('#uplCard').waitFor({ state: 'detached', timeout: 5000 });
    await page.waitForFunction(() => { const t = document.querySelector('#toast'); return t && !t.hidden && /already posted/.test(t.textContent || ''); }, null, { timeout: 3000 });
    await settle(page);
    const out = {};
    out.toast = await page.$eval('#toast', (t) => t.textContent || '');
    out.live = S.msgs.some((x) => x.id === 101);
    out.draftOnly = calls.some((c) => /^DELETE .*\/messages\/101\?draft_only=1$/.test(c));
    out.chipGone = await page.$eval('#fileChip', (e) => e.hidden);
    out.textCleared = (await page.inputValue('#text')) === '';
    out.note = await page.locator('#uplResume').count();
    must(out.live && out.draftOnly, 'the live message stays: ' + JSON.stringify(out));
    must(!/nothing was posted/.test(out.toast), 'no claim that nothing was posted: ' + out.toast);
    must(out.chipGone && out.textCleared && out.note === 0, 'what was posted leaves the composer: ' + JSON.stringify(out));
    await shot(page, 'upload-cancel-after-publish.png');
    return out;
  });
  await run('upload-pick-during-send', { hash: '#invite=tok_Anthony' }, async (page, S) => {
    // A photo and a second file picked while a send uploads are for the
    // next message: the send must not wipe them when it finishes, and the
    // file being uploaded is not "replaced".
    S.partDelay = 400;
    await page.setInputFiles('#anyFile', { name: 'report.pdf', mimeType: 'application/pdf', buffer: Buffer.alloc(300000, 7) });
    await page.locator('#fileChip:not([hidden])').waitFor({ timeout: 3000 });
    await page.fill('#text', 'the report');
    await page.click('#send');
    await page.locator('#uplCard').waitFor({ timeout: 3000 });
    const out = {};
    out.fileRemoveHidden = await page.$eval('#fileRemove', (e) => e.hidden);
    await page.setInputFiles('#imgFile', FIXTURES + 'photo.png');
    await page.locator('#attachRow:not([hidden])').waitFor({ timeout: 3000 });
    await page.setInputFiles('#anyFile', { name: 'next.txt', mimeType: 'text/plain', buffer: Buffer.from('for later') });
    await page.waitForFunction(() => /next\.txt/.test((document.querySelector('#fileName') || {}).textContent || ''), null, { timeout: 3000 });
    out.toast = await page.$eval('#toast', (t) => t.textContent || '');
    out.nextFileRemove = await page.$eval('#fileRemove', (e) => !e.hidden);
    await shot(page, 'upload-pick-during-send.png');
    await page.locator('#uplCard').waitFor({ state: 'detached', timeout: 30000 });
    await page.locator('.file-card', { hasText: 'report.pdf' }).waitFor({ timeout: 4000 });
    await settle(page);
    const last = S.msgs[S.msgs.length - 1];
    out.posted = { text: last.text, file: last.file && last.file.name, image: !!last.image };
    out.imgKept = !(await page.$eval('#attachRow', (e) => e.hidden));
    out.fileKept = await page.textContent('#fileName');
    must(out.fileRemoveHidden, 'the uploading file has no Remove: ' + JSON.stringify(out));
    must(/next\.txt attaches to your next message - report\.pdf is still uploading/.test(out.toast), 'no false "replaces": ' + out.toast);
    must(out.posted.file === 'report.pdf' && !out.posted.image, 'the send posted what it was sent with: ' + JSON.stringify(out.posted));
    must(out.imgKept && /next\.txt/.test(out.fileKept), 'what was picked meanwhile stays for the next message: ' + JSON.stringify(out));
    must(out.nextFileRemove, 'the next file can be removed');
    return out;
  });
  await run('upload-remove-during-send', { hash: '#invite=tok_Anthony', w: 390, h: 844, touch: true }, async (page, S) => {
    // What a send is carrying can't be removed mid-send: Remove hid the
    // chip while the send posted the image anyway.
    S.partDelay = 400;
    await page.setInputFiles('#imgFile', FIXTURES + 'photo.png');
    await page.locator('#attachRow:not([hidden])').waitFor({ timeout: 3000 });
    await page.setInputFiles('#anyFile', { name: 'report.pdf', mimeType: 'application/pdf', buffer: Buffer.alloc(300000, 7) });
    await page.locator('#fileChip:not([hidden])').waitFor({ timeout: 3000 });
    await page.click('#send');
    await page.locator('#uplCard').waitFor({ timeout: 3000 });
    const out = {};
    out.imgRemoveVisible = await page.locator('#imgRemove').isVisible();
    out.fileRemoveVisible = await page.locator('#fileRemove').isVisible();
    await shot(page, 'upload-remove-during-send-phone.png');
    await page.locator('#uplCard').waitFor({ state: 'detached', timeout: 30000 });
    await settle(page);
    const last = S.msgs[S.msgs.length - 1];
    out.posted = !!(last && last.image && last.file);
    out.cleared = await page.$eval('#attachRow', (e) => e.hidden) && await page.$eval('#fileChip', (e) => e.hidden);
    must(!out.imgRemoveVisible && !out.fileRemoveVisible, 'no Remove on what is being sent: ' + JSON.stringify(out));
    must(out.posted && out.cleared, 'both posted, both cleared after: ' + JSON.stringify(out));
    return out;
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
  // The voice dialog reads the server's refusals: an upload whose clone was
  // refused (the daily cap, a provider failure) still stored the sample,
  // and it said only "Upload failed.", then "being prepared" for a clone
  // nothing would ever make.
  const voiceTake = { name: 'take.webm', mimeType: 'audio/webm', buffer: Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4]) };
  const voiceUpload = async (page) => {
    await page.setInputFiles('#voiceFile', voiceTake);
    await page.click('#voiceUpload');
    await page.waitForFunction(() => document.querySelector('#voiceStatus').textContent !== 'Uploading…', null, { timeout: 5000 });
    await settle(page);
    return { status: await page.$eval('#voiceStatus', (e) => e.textContent), toast: await page.$eval('#toast', (e) => e.textContent || '') };
  };
  for (const [tag, w, h] of [['', 1280, 860], ['-phone', 390, 844]]) {
    await run('voice-clone-refused' + tag, { hash: '#invite=tok_Anthony', w, h, touch: !!tag, allowConsole: /status of 429/ }, async (page, S, calls) => {
      S.voiceSample = { status: 429, body: { error: 'You can clone a voice up to 5 times a day. Try again tomorrow.', retry_after: 3600, voice: { provider: 'cartesia', voice_id: null, sample: true, updated: 1 }, cloned: false, sample_stored: true } };
      if (tag) { await page.tap('#menu'); await settle(page); }
      await page.click('#voiceBtn'); await settle(page);
      const out = await voiceUpload(page);
      out.retry = await page.locator('#voiceReclone').isVisible();
      await shot(page, 'voice-clone-refused' + tag + '.png');
      must(/stored, but it was not cloned: You can clone a voice up to 5 times a day\. Try again tomorrow\.$/.test(out.status), 'the cap and the stored sample are named: ' + out.status);
      must(/5 times a day/.test(out.toast) && out.retry, 'toast gives the reason, Retry clone offered: ' + JSON.stringify(out));
      await page.click('#voiceClose'); await settle(page);
      await page.click('#voiceBtn'); await settle(page);
      out.reopened = await page.$eval('#voiceStatus', (e) => e.textContent);
      must(!/being prepared/.test(out.reopened) && /not cloned yet/.test(out.reopened) && await page.locator('#voiceReclone').isVisible(), 'reopened: no promise of a clone in the works: ' + out.reopened);
      S.voiceSample = null;
      await page.click('#voiceReclone');
      await page.waitForFunction(() => /Your voice is set/.test(document.querySelector('#voiceStatus').textContent), null, { timeout: 5000 });
      out.recloned = calls.some((c) => /^POST .*\/voice\/reclone/.test(c));
      out.retryAfter = await page.locator('#voiceReclone').isVisible();
      must(out.recloned && !out.retryAfter, 'Retry clone posts reclone and goes away once cloned: ' + JSON.stringify(out));
      return out;
    });
  }
  await run('voice-upload-refused', { hash: '#invite=tok_Anthony', allowConsole: /status of (415|502)/ }, async (page, S) => {
    S.voiceSample = { status: 502, body: { error: 'Cartesia clone failed (400): audio too short', sample_stored: true } };
    await page.click('#voiceBtn'); await settle(page);
    const failed = await voiceUpload(page);
    must(/stored, but it was not cloned: Cartesia clone failed \(400\): audio too short\.$/.test(failed.status), 'a failed clone: ' + failed.status);
    S.voiceSample = { status: 415, body: { error: 'Samples must be MP3, WAV, M4A, OGG or WebM audio' } };
    const wrong = await voiceUpload(page);
    must(wrong.status === 'Upload failed: Samples must be MP3, WAV, M4A, OGG or WebM audio.' && /MP3, WAV/.test(wrong.toast), 'a refused upload says why: ' + JSON.stringify(wrong));
    return { failed: failed.status, wrong: wrong.status };
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

  // Signed media links die one to two hours after they are minted, and the
  // feed gets each row once. A tab left open past 50 minutes (or brought
  // back into view after one) re-reads the rows that carry media and
  // swaps in their new links: the same elements, the same scroll, and
  // no other row touched. Before, nothing renewed them and an afternoon
  // later the images, clips, documents and downloads answered 403.
  for (const [tag, w, h] of [['', 1280, 860], ['-phone', 390, 844]]) {
    await run('media-links-renew' + tag, { state: { artifacts: true, files: true }, hash: '#invite=tok_Anthony', w, h, touch: !!tag }, async (page, S, calls) => {
      const reads = () => calls.filter((c) => /^GET \/api\/rooms\/demo\/messages\?after=/.test(c));
      const fresh = (u) => u.split('?')[0] + '?exp=2&sig=fresh';
      const img = await page.$('.msg[data-id="8"] img.msg-img');
      const plain = await page.$('.msg[data-id="2"]');
      must(img && plain, 'the image row and a plain row are on screen');
      await page.evaluate(() => { const l = document.querySelector('#list'); l.scrollTop = Math.max(0, l.scrollHeight - l.clientHeight - 150); });
      const top0 = await page.$eval('#list', (l) => l.scrollTop);
      // a look back too soon reads nothing
      await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
      await settle(page);
      must(reads().length === 0, 'no re-read before the links are old: ' + JSON.stringify(reads()));
      // the server now mints new links; the tab's clock moves 51 minutes on
      for (const m of S.msgs) for (const k of ['image', 'html', 'doc', 'file']) if (m[k]) m[k] = Object.assign({}, m[k], { url: fresh(m[k].url) });
      await page.evaluate(() => { const real = Date.now; Date.now = () => real.call(Date) + 51 * 60e3; });
      await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
      await page.waitForFunction(() => /sig=fresh/.test(document.querySelector('.msg[data-id="8"] img.msg-img').getAttribute('src')), null, { timeout: 5000 });
      await settle(page);
      const out = {
        reads: reads(),
        sameImg: await img.evaluate((e) => e.isConnected),
        plainKept: await plain.evaluate((e) => e.isConnected),
        file: await page.$eval('.msg[data-id="60"] .file-card', (a) => a.getAttribute('href')),
        frame: await page.$eval('.msg[data-id="8"] .art-frame', (f) => f.getAttribute('src')),
        scroll: [top0, await page.$eval('#list', (l) => l.scrollTop)],
      };
      must(out.reads.length === 1 && /\?after=7&limit=54$/.test(out.reads[0]), 'one read, from the first media row to the last: ' + JSON.stringify(out.reads));
      must(out.sameImg && out.plainKept, 'the rows stay mounted: ' + JSON.stringify(out));
      must(/sig=fresh/.test(out.file) && /sig=fresh/.test(out.frame), 'the download and the page preview carry the new links: ' + JSON.stringify(out));
      must(Math.abs(out.scroll[0] - out.scroll[1]) < 2, 'the scroll position holds: ' + JSON.stringify(out.scroll));
      // renewed just now: the next look reads nothing
      await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
      await settle(page);
      must(reads().length === 1, 'renewed rows are not read again at once: ' + JSON.stringify(reads()));
      await img.evaluate((e) => e.scrollIntoView({ block: 'start' }));
      await settle(page);
      must(await img.evaluate((e) => e.complete && e.naturalWidth > 0), 'the renewed image shows');
      await shot(page, 'media-links-renew' + tag + '.png');
      return out;
    });
  }
  // A media element that fails to load (its link died while the device
  // slept) asks for its row again and retries once, with the new link;
  // one that keeps failing is not retried in a loop.
  await run('media-links-retry', { state: { artifacts: true }, hash: '#invite=tok_Anthony', allowConsole: /status of 403/ }, async (page, S, calls) => {
    const hits = { image: [], doc: [], gone: 0 };
    const dead = '?exp=1&sig=dead';
    S.msgs.find((m) => m.id === 8).image.url += dead;
    S.msgs.find((m) => m.id === 8).doc.url += dead;
    S.msgs.push({ id: 90, ts: S.msgs[S.msgs.length - 1].ts + 1000, from: 'Ada', kind: 'agent', text: 'This photo is gone for good.', image: { type: 'image/png', bytes: 4321, url: '/api/rooms/demo/messages/90/image?exp=1&sig=gone' } });
    await page.route(/\/messages\/(8\/(image|doc)|90\/image)\?/, (route) => {
      const u = new URL(route.request().url());
      const kind = u.pathname.split('/').pop();
      if (/\/90\//.test(u.pathname)) { hits.gone++; return route.fulfill({ status: 403, contentType: 'application/json', body: '{"error":"This media link is invalid or has expired."}' }); }
      hits[kind].push(u.searchParams.get('sig'));
      if (u.searchParams.get('sig') === 'dead') {
        // the server signs anew from here on
        const m = S.msgs.find((x) => x.id === 8);
        m[kind] = Object.assign({}, m[kind], { url: m[kind].url.replace('sig=dead', 'sig=live') });
        return route.fulfill({ status: 403, contentType: 'application/json', body: '{"error":"This media link is invalid or has expired."}' });
      }
      return route.fallback();
    });
    await page.reload();
    await page.waitForFunction(() => {
      const i = document.querySelector('.msg[data-id="8"] img.msg-img');
      return i && /sig=live/.test(i.getAttribute('src')) && i.complete && i.naturalWidth > 0;
    }, null, { timeout: 8000 });
    await page.waitForFunction(() => /Probe doc/.test(document.querySelector('.msg[data-id="8"] .doc-body').textContent), null, { timeout: 8000 });
    await page.evaluate(() => document.querySelector('.msg[data-id="90"]').scrollIntoView());
    await page.waitForFunction(() => document.querySelector('.msg[data-id="90"] img.msg-img').complete, null, { timeout: 5000 });
    await settle(page);
    await page.waitForTimeout(300);
    await settle(page);
    const out = { hits, reads: calls.filter((c) => /^GET \/api\/rooms\/demo\/messages\?after=/.test(c)) };
    must(out.hits.image.join() === 'dead,live' && out.hits.doc.join() === 'dead,live', 'each retried once, with the new link: ' + JSON.stringify(out.hits));
    must(out.hits.gone === 2, 'a link that keeps failing is retried once, not in a loop: ' + JSON.stringify(out.hits));
    must(out.reads.length >= 1 && out.reads.length <= 3, 'failures share re-reads: ' + JSON.stringify(out.reads));
    return out;
  });

  // A forward read comes back in delivery order: a row published late, or
  // sent again when its media landed, sits after higher ids. Here row 8
  // went live after sixty newer rows. Its link dies; the re-read follows
  // the cursor past them and finds it, and so does the hourly renewal,
  // never sending the same query twice. Before, a page was taken to cover
  // every id up to its last row's, so row 8 never got a new link.
  for (const [tag, w, h] of [['', 1280, 860], ['-phone', 390, 844]]) {
    await run('media-links-late-row' + tag, { state: { artifacts: true }, hash: '#invite=tok_Anthony', w, h, touch: !!tag, allowConsole: /status of 403/ }, async (page, S, calls) => {
      const base = S.msgs[S.msgs.length - 1].ts;
      for (let i = 0; i < 60; i++) S.msgs.push({ id: 200 + i, ts: base + 1000 * (i + 1), from: i % 2 ? 'Henry' : 'Ada', kind: 'agent', text: 'Catching up, line ' + (i + 1) + '.' });
      S.dn = { 8: 300 };
      const m8 = S.msgs.find((m) => m.id === 8);
      m8.image = Object.assign({}, m8.image, { url: m8.image.url + '?exp=1&sig=dead' });
      const sigs = [];
      const reads = () => calls.filter((c) => /^GET \/api\/rooms\/demo\/messages\?after=/.test(c));
      await page.route(/\/messages\/8\/image\?/, (route) => {
        const sig = new URL(route.request().url()).searchParams.get('sig');
        sigs.push(sig);
        if (sig !== 'dead') return route.fallback();
        // the server signs anew from here on
        m8.image = Object.assign({}, m8.image, { url: m8.image.url.replace('sig=dead', 'sig=live') });
        return route.fulfill({ status: 403, contentType: 'application/json', body: '{"error":"This media link is invalid or has expired."}' });
      });
      await page.reload();
      await settle(page);
      await page.evaluate(() => document.querySelector('.msg[data-id="8"]').scrollIntoView({ block: 'center' }));
      await page.waitForFunction(() => /sig=live/.test(document.querySelector('.msg[data-id="8"] img.msg-img').getAttribute('src')), null, { timeout: 8000 })
        .catch(() => { throw new Error('the late row\'s image never got its new link: ' + JSON.stringify({ sigs, reads: reads() })); });
      // the lazy image loads once it is in view
      await page.evaluate(() => document.querySelector('.msg[data-id="8"] img.msg-img').scrollIntoView({ block: 'center' }));
      await page.waitForFunction(() => { const i = document.querySelector('.msg[data-id="8"] img.msg-img'); return i.complete && i.naturalWidth > 0; }, null, { timeout: 5000 });
      await settle(page);
      const first = reads();
      must(sigs.join() === 'dead,live', 'the image is retried once, with the new link: ' + JSON.stringify(sigs));
      must(new Set(first).size === first.length && first.length >= 2, 'the re-read pages on past the newer rows, never repeating a query: ' + JSON.stringify(first));
      await page.evaluate(() => document.querySelector('.msg[data-id="8"]').scrollIntoView({ block: 'start' }));
      await shot(page, 'media-links-late-row' + tag + '.png');
      // an hour on, the renewal finds the late row the same way
      m8.image = Object.assign({}, m8.image, { url: m8.image.url.replace('sig=live', 'sig=fresh') });
      await page.evaluate(() => { const real = Date.now; Date.now = () => real.call(Date) + 51 * 60e3; });
      await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
      await page.waitForFunction(() => /sig=fresh/.test(document.querySelector('.msg[data-id="8"] img.msg-img').getAttribute('src')), null, { timeout: 5000 })
        .catch(() => { throw new Error('the renewal missed the late row: ' + JSON.stringify(reads())); });
      await settle(page);
      const later = reads().slice(first.length);
      must(later.length >= 1 && new Set(later).size === later.length, 'the renewal never repeats a query: ' + JSON.stringify(later));
      return { first, later };
    });
  }

  done('people-media');
})();
