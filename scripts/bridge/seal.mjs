#!/usr/bin/env node
// Seal a JSON handover to the bridge's public key, as a gadget would:
//   npm run bridge:seal -- <publicKeyBase64> '{"accessToken":"...","nodeId":"gadget-abc123"}'
//   echo '{...}' | npm run bridge:seal -- <publicKeyBase64> -
// (node --import ./tests/unit/register.mjs scripts/bridge/seal.mjs: the
// hooks load the Worker's TypeScript, whose imports name "./x.js".)
// Prints the base64 sealed blob (the "sealed" field of /connect and /update).
// Test use only: the payload is read from the command line or stdin.
import { seal } from '../../worker/bridge/seal.ts';

const [pub, arg] = process.argv.slice(2);
if (!pub || !arg) {
  process.stderr.write('usage: npm run bridge:seal -- <publicKeyBase64> <json | ->\n');
  process.exit(2);
}
let text = arg;
if (arg === '-') {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  text = Buffer.concat(chunks).toString('utf8');
}
let payload;
try {
  payload = JSON.parse(text);
} catch {
  process.stderr.write('payload is not JSON\n');
  process.exit(2);
}
process.stdout.write((await seal(payload, pub)) + '\n');
