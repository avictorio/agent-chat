// A hermetic local Worker for tests: wrangler dev on its own port, with its
// own state directory (removed afterwards), the test owner key, a seal key
// of its own for the Muse bridge and TEST_HOOKS on. Nothing here touches the
// real site, and the Muse bridge reaches no real Muse: its calls go to the
// fake Muse a test names (opts.museOrigin), or fail.
//
// The API suite uses start(); a one-off script (a bug repro, a probe) runs
// against its own instance with
//
//   node tests/api/server.js run path/to/script.js [args...]
//
// which starts a server on a free port, runs the script with BASE (the
// server's URL) and OWNER (the test owner key) in its environment, stops the
// server and exits with the script's status. Several can run side by side.
//
// The Worker's values go in with --var, so no .dev.vars is written. A
// developer's own .dev.vars would be loaded as well and could bring real
// keys into a test run: when one exists it is moved aside for the run and
// put back after (one run at a time in that case; a cloud sandbox has none).
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const OWNER = 'api-test-owner-key';
const DEV_VARS = path.join(ROOT, '.dev.vars');

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

/** The build id this checkout's Worker reports at /api/build: the first 8
 *  bytes of the SHA-256 of the built index.html, as appShell() makes it. */
function localBuildId() {
  const text = fs.readFileSync(path.join(ROOT, 'web', 'app', 'dist', 'index.html'));
  return require('crypto').createHash('sha256').update(text).digest('hex').slice(0, 16);
}

// The config a local server runs: wrangler.toml with its v2 migration,
// which transfers the Muse bridge's classes from the muse-bridge Worker
// (where their live data is), turned into one that creates them with
// new_sqlite_classes. wrangler dev gives a class SQLite storage only from
// new_sqlite_classes, and a transferred class came up without it, so the
// bridge's first query failed. Written in ROOT (its paths are relative to
// it) and removed with the run; a wrangler.toml this cannot rewrite fails
// the start rather than run the bridge without its storage.
let configs = 0;
function testConfig() {
  const text = fs.readFileSync(path.join(ROOT, 'wrangler.toml'), 'utf8');
  const v2 = /^\[\[migrations\]\]\s*\ntag = "v2"\s*\n((?:[ \t]*\[\[migrations\.transferred_classes\]\]\s*\n(?:[ \t]*(?:from|from_script|to)\s*=\s*"[^"]*"\s*\n)+)+)/m.exec(text);
  const classes = v2 ? [...v2[1].matchAll(/^[ \t]*to\s*=\s*"([^"]+)"/gm)].map((m) => m[1]) : [];
  if (!v2 || classes.length !== 2) throw new Error('tests/api/server.js: wrangler.toml\'s v2 migration is not the transfer of the Muse bridge\'s two classes it knows how to run locally');
  const file = path.join(ROOT, '.apitest-wrangler-' + process.pid + '-' + (++configs) + '.toml');
  fs.writeFileSync(file, text.replace(v2[0], '[[migrations]]\ntag = "v2"\nnew_sqlite_classes = ' + JSON.stringify(classes) + '\n'));
  return file;
}

/** A Muse seal key of the run's own: the raw X25519 private key as base64
 *  (what MUSE_SEAL_KEY holds) and its public key, as GET /api/muse/seal-key
 *  serves it. */
function sealKey() {
  const { privateKey, publicKey } = require('crypto').generateKeyPairSync('x25519');
  const raw = (k, part) => Buffer.from(k.export({ format: 'jwk' })[part], 'base64url').toString('base64');
  return { privateKey: raw(privateKey, 'd'), publicKey: raw(publicKey, 'x') };
}

/** Starts wrangler dev and waits until its own child answers.
 *  @param opts {port?: number, museOrigin?: string} - port's default: API_PORT from the environment, else a free port;
 *    museOrigin: the fake Muse (http://127.0.0.1:PORT) the bridge's calls to Muse go to; without it they fail
 *  @returns {{ base: string, port: number, owner: string, sealPublicKey: string, stop: () => void }} */
async function start(opts) {
  opts = opts || {};
  if (!fs.existsSync(path.join(ROOT, 'web', 'app', 'dist', 'index.html'))) {
    throw new Error('the local Worker needs the web build: run `npm run build` first');
  }
  const port = opts.port || Number(process.env.API_PORT) || await freePort();
  const inspector = await freePort();
  const build = localBuildId();
  const config = testConfig();
  const seal = sealKey();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apitest-state-'));
  const aside = fs.existsSync(DEV_VARS) ? DEV_VARS + '.aside-' + process.pid : null;
  if (aside) fs.renameSync(DEV_VARS, aside);
  // wrangler's own entry run by this Node, not `npx`: Windows can't spawn
  // npx (a .cmd) without a shell, so the suite didn't start there.
  const child = spawn(process.execPath, [path.join(path.dirname(require.resolve('wrangler/package.json')), 'bin', 'wrangler.js'), 'dev', '-c', config, '--port', String(port), '--inspector-port', String(inspector), '--persist-to', stateDir,
    // a mail key so room creation counts as set up; under TEST_HOOKS no mail is sent (routes/rooms.ts)
    '--var', 'OWNER_KEY:' + OWNER, '--var', 'RESEND_API_KEY:re_fake_for_tests', '--var', 'TEST_HOOKS:1', '--var', 'MUSE_SEAL_KEY:' + seal.privateKey,
    ...(opts.museOrigin ? ['--var', 'TEST_MUSE_ORIGIN:' + opts.museOrigin] : [])], { cwd: ROOT, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  // The child's own output is the proof that it, and not some other
  // process, holds the port: the ready loop used to take any answer on
  // the port, so a run that found a leftover server (or another run's) on
  // it tested that server, and failed everywhere once its owner stopped it.
  let said = '';
  let ready = false;
  let reloaded = false;
  let exited = null;
  const hear = (b) => {
    said = (said + b.toString()).slice(-8000);
    if (/Ready on /.test(said)) ready = true;
    // wrangler dev watches the tree and reloads the Worker when a file
    // changes, which cuts requests and streams in flight, so checks after
    // it can fail for no fault of the Worker. Say why, once.
    if (ready && !reloaded && /Reloading local server/.test(b.toString())) {
      reloaded = true;
      process.stderr.write('test:api: wrangler dev reloaded mid-run because a file in the tree changed; results from here on are unreliable. Run again without editing the tree.\n');
    }
  };
  child.stdout.on('data', hear);
  child.stderr.on('data', hear);
  let stopped = false;
  child.on('exit', (code, sig) => {
    exited = sig || String(code);
    if (!stopped && ready) process.stderr.write('wrangler dev on port ' + port + ' exited (' + exited + ')\n');
  });
  const stop = () => {
    if (stopped) return;
    stopped = true;
    // The whole tree: wrangler, esbuild and workerd. A negative pid (the
    // process group) only works on POSIX; on Windows it threw, was ignored,
    // and every run left its server running.
    if (process.platform === 'win32') {
      try { require('child_process').spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
    } else {
      try { process.kill(-child.pid, 'SIGKILL'); } catch {}
    }
    if (aside) { try { fs.renameSync(aside, DEV_VARS); } catch {} }
    try { fs.unlinkSync(config); } catch {}
    try { fs.rmSync(stateDir, { recursive: true, force: true }); } catch {}
  };
  // a killed or interrupted run still stops its server and restores .dev.vars
  process.once('exit', stop);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(sig, () => { stop(); process.exit(130); });
  const base = 'http://localhost:' + port;
  // the binding table lists variable values: keep it out of the message
  const ANSI = new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g');
  const tail = () => said.replace(ANSI, '').split('\n').filter((l) => l.trim() && !/^env\./.test(l)).slice(-6).join('\n');
  for (let i = 0; i < 180; i++) {
    if (exited !== null) {
      stop();
      throw new Error('wrangler dev on port ' + port + ' exited before it was ready (' + exited + '):\n' + tail());
    }
    // Ready from our own child, and this checkout's build id from the
    // port: both, because a server from another run of this same tree
    // reports the same build id.
    if (ready) {
      try {
        const r = await fetch(base + '/api/build');
        const j = r.ok ? await r.json() : null;
        if (j && j.build === build && exited === null) return { base, port, owner: OWNER, sealPublicKey: seal.publicKey, stop };
      } catch {}
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  stop();
  throw new Error('wrangler dev did not come up on port ' + port + ':\n' + tail());
}

module.exports = { start, OWNER, ROOT, localBuildId };

if (require.main === module) {
  const [cmd, script, ...rest] = process.argv.slice(2);
  if (cmd !== 'run' || !script) {
    console.error('usage: node tests/api/server.js run path/to/script.js [args...]');
    process.exit(2);
  }
  (async () => {
    const s = await start();
    const c = spawn(process.execPath, [path.resolve(script), ...rest], { stdio: 'inherit', env: Object.assign({}, process.env, { BASE: s.base, OWNER: s.owner }) });
    c.on('exit', (code, sig) => { s.stop(); process.exit(sig ? 1 : code || 0); });
  })().catch((e) => { console.error(String((e && e.stack) || e)); process.exit(1); });
}
