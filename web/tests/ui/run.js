// The UI suite: runs every <feature>.test.js in this folder, JOBS at a time
// (default: one per CPU but one), each in its own Node process with its
// own browsers, and prints their PASS/FAIL lines as they finish. Exits
// non-zero when any scenario fails. ONLY=name1,name2 runs just those
// scenarios (the files without them finish at once); FILES=chat,games runs
// just those files. Started by `npm test` (web/package.json), which
// preloads tests/system-chromium.js; the files inherit the preload.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const only = process.env.FILES ? process.env.FILES.split(',') : null;
// longest first, so the slow 3D files do not start last
const ORDER = ['arenas', 'battleship', 'games', 'arenas-3d', 'chat', 'people-media', 'shell'];
const files = fs
  .readdirSync(__dirname)
  .filter((f) => f.endsWith('.test.js'))
  .map((f) => f.replace(/\.test\.js$/, ''))
  .filter((f) => !only || only.includes(f))
  .sort((a, b) => (ORDER.indexOf(a) + 1 || 99) - (ORDER.indexOf(b) + 1 || 99));
const JOBS = Math.max(1, +process.env.JOBS || Math.max(1, os.cpus().length - 1));

const started = Date.now();
let failed = 0;
let passed = 0;
const broken = [];
let next = 0;

function start() {
  if (next >= files.length) return null;
  const f = files[next++];
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(process.execPath, [...process.execArgv, path.join(__dirname, f + '.test.js')], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = '';
    const line = (l) => {
      if (l.startsWith('PASS ')) passed++;
      if (l.startsWith('FAIL ')) failed++;
      if (l.startsWith('UI FILE ')) return;
      console.log(l);
    };
    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        line(buf.slice(0, i));
        buf = buf.slice(i + 1);
      }
    });
    child.stderr.on('data', (d) => process.stderr.write(d));
    child.on('close', (code) => {
      if (buf) line(buf);
      console.log('-- ' + f + ' done in ' + Math.round((Date.now() - t0) / 1000) + ' s' + (code ? ' (exit ' + code + ')' : ''));
      if (code) broken.push(f);
      resolve(start());
    });
  });
}

(async () => {
  await Promise.all(Array.from({ length: Math.min(JOBS, files.length) }, () => start()));
  const secs = Math.round((Date.now() - started) / 1000);
  console.log('UI SUITE: ' + passed + ' passed, ' + failed + ' failed in ' + secs + ' s (' + files.length + ' files, ' + JOBS + ' at a time)');
  // a file that crashed outside a scenario fails the run even with no FAIL line
  if (broken.length && !failed) console.log('UI SUITE: files exited non-zero: ' + broken.join(', '));
  console.log(failed || broken.length ? 'PARITY SUITE: ' + (failed || broken.length) + ' failing' : 'PARITY SUITE: all ported scenarios pass');
  process.exit(failed || broken.length ? 1 : 0);
})();
