// A hermetic local Worker for tests: wrangler dev on its own port, with its
// own state directory (removed afterwards), the test owner key and
// TEST_HOOKS on. Nothing here touches the real site.
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
// what the site sends the Muse bridge stand-in as X-Bridge-Key
const BRIDGE_KEY = 'api-test-bridge-key';
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

// The Muse bridge stand-in (opts.museBridge): wrangler.toml keeps its
// MUSE_BRIDGE service binding commented out until the real muse-bridge
// Worker exists (a deploy refuses a binding to a missing Worker), so the
// run gets a copy of wrangler.toml with the binding added - in ROOT, since
// its paths are relative to it, and removed with the run - and a second
// Worker, tests/api/fake-muse-bridge.js, under the bound name. That Worker
// forwards to the URL given, the suite's own recording server.
const BRIDGE_SERVICE = 'muse-bridge-apitest';
function museConfigs(stateDir, bridgeUrl) {
  const text = fs.readFileSync(path.join(ROOT, 'wrangler.toml'), 'utf8');
  // a binding already live in the file names the service to stand in for
  const live = /^\[\[services\]\]\s*\nbinding\s*=\s*"MUSE_BRIDGE"\s*\nservice\s*=\s*"([^"]+)"/m.exec(text);
  const service = live ? live[1] : BRIDGE_SERVICE;
  const primary = path.join(ROOT, '.apitest-wrangler-' + process.pid + '.toml');
  // appended at the end, where a table header cannot capture anything after it
  fs.writeFileSync(primary, live ? text : text + '\n[[services]]\nbinding = "MUSE_BRIDGE"\nservice = "' + service + '"\n');
  const aux = path.join(stateDir, 'fake-muse-bridge.toml');
  fs.writeFileSync(aux, 'name = "' + service + '"\nmain = ' + JSON.stringify(path.join(ROOT, 'tests', 'api', 'fake-muse-bridge.js')) + '\ncompatibility_date = "2025-04-01"\n\n[vars]\nFAKE_BRIDGE_URL = ' + JSON.stringify(bridgeUrl) + '\n');
  return { primary, aux };
}

/** Starts wrangler dev and waits until its own child answers.
 *  @param opts {port?: number, museBridge?: string} - port's default: API_PORT from the environment, else a free port;
 *    museBridge: the URL the MUSE_BRIDGE stand-in forwards to (no binding without it)
 *  @returns {{ base: string, port: number, owner: string, stop: () => void }} */
async function start(opts) {
  opts = opts || {};
  if (!fs.existsSync(path.join(ROOT, 'web', 'app', 'dist', 'index.html'))) {
    throw new Error('the local Worker needs the web build: run `npm run build` first');
  }
  const port = opts.port || Number(process.env.API_PORT) || await freePort();
  const inspector = await freePort();
  const build = localBuildId();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apitest-state-'));
  const muse = opts.museBridge ? museConfigs(stateDir, opts.museBridge) : null;
  const aside = fs.existsSync(DEV_VARS) ? DEV_VARS + '.aside-' + process.pid : null;
  if (aside) fs.renameSync(DEV_VARS, aside);
  // wrangler's own entry run by this Node, not `npx`: Windows can't spawn
  // npx (a .cmd) without a shell, so the suite didn't start there.
  const child = spawn(process.execPath, [path.join(path.dirname(require.resolve('wrangler/package.json')), 'bin', 'wrangler.js'), 'dev', ...(muse ? ['-c', muse.primary, '-c', muse.aux] : []), '--port', String(port), '--inspector-port', String(inspector), '--persist-to', stateDir,
    // a mail key so room creation counts as set up; under TEST_HOOKS no mail is sent (routes/rooms.ts)
    '--var', 'OWNER_KEY:' + OWNER, '--var', 'RESEND_API_KEY:re_fake_for_tests', '--var', 'TEST_HOOKS:1', '--var', 'MUSE_BRIDGE_KEY:' + BRIDGE_KEY], { cwd: ROOT, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
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
    if (muse) { try { fs.unlinkSync(muse.primary); } catch {} }
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
        if (j && j.build === build && exited === null) return { base, port, owner: OWNER, stop };
      } catch {}
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  stop();
  throw new Error('wrangler dev did not come up on port ' + port + ':\n' + tail());
}

module.exports = { start, OWNER, BRIDGE_KEY, ROOT, localBuildId };

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
