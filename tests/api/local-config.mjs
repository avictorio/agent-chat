// What a local Worker for tests runs with, shared by the API suite's server
// (tests/api/server.js) and the schema upgrade test (tests/upgrade/run.sh):
// the config, and a Muse seal key of the run's own.
import fs from 'node:fs';
import path from 'node:path';
import { generateKeyPairSync } from 'node:crypto';

// The config a local server runs: wrangler.toml with its v2 migration,
// which transfers the Muse bridge's classes from the muse-bridge Worker
// (where their live data is), turned into one that creates them with
// new_sqlite_classes. wrangler dev gives a class SQLite storage only from
// new_sqlite_classes, and a transferred class came up without it, so the
// bridge's first query failed. Written in the checkout it is for (its
// paths are relative to it), for the caller to remove with the run; a
// wrangler.toml this cannot rewrite fails the start rather than run the
// bridge without its storage.
let configs = 0;
/** @param root the checkout whose wrangler.toml it rewrites, and where it writes the copy
 *  @returns the copy's path */
export function testConfig(root) {
  const text = fs.readFileSync(path.join(root, 'wrangler.toml'), 'utf8');
  const v2 = /^\[\[migrations\]\]\s*\ntag = "v2"\s*\n((?:[ \t]*\[\[migrations\.transferred_classes\]\]\s*\n(?:[ \t]*(?:from|from_script|to)\s*=\s*"[^"]*"\s*\n)+)+)/m.exec(text);
  const classes = v2 ? [...v2[1].matchAll(/^[ \t]*to\s*=\s*"([^"]+)"/gm)].map((m) => m[1]) : [];
  if (!v2 || classes.length !== 2) throw new Error('tests/api/local-config.mjs: wrangler.toml\'s v2 migration is not the transfer of the Muse bridge\'s two classes it knows how to run locally');
  const file = path.join(root, '.apitest-wrangler-' + process.pid + '-' + (++configs) + '.toml');
  fs.writeFileSync(file, text.replace(v2[0], '[[migrations]]\ntag = "v2"\nnew_sqlite_classes = ' + JSON.stringify(classes) + '\n'));
  return file;
}

/** A Muse seal key of the run's own: the raw X25519 private key as base64
 *  (what MUSE_SEAL_KEY holds) and its public key, as GET /api/muse/seal-key
 *  serves it. */
export function sealKey() {
  const { privateKey, publicKey } = generateKeyPairSync('x25519');
  const raw = (k, part) => Buffer.from(k.export({ format: 'jwk' })[part], 'base64url').toString('base64');
  return { privateKey: raw(privateKey, 'd'), publicKey: raw(publicKey, 'x') };
}
