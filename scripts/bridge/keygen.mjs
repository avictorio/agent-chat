#!/usr/bin/env node
// A bridge seal key pair, for local runs and tests:
//   npm run bridge:keygen                -> BRIDGE_SEAL_KEY=... and the public key
//   npm run bridge:keygen -- --dev-vars  -> lines for .dev.vars (also a BRIDGE_SHARED_KEY)
// (node --import ./tests/unit/register.mjs scripts/bridge/keygen.mjs: the
// hooks load the Worker's TypeScript, whose imports name "./x.js".)
// Production keys are made the same way and stored with `wrangler secret put`;
// never commit the private key.
import { generateBridgeKey, b64encode } from '../../worker/bridge/seal.ts';

const { privateKey, publicKey } = await generateBridgeKey();
if (process.argv.includes('--dev-vars')) {
  const shared = b64encode(crypto.getRandomValues(new Uint8Array(32)));
  process.stdout.write(`BRIDGE_SEAL_KEY=${privateKey}\nBRIDGE_SHARED_KEY=${shared}\n# public key: ${publicKey}\n`);
} else {
  process.stdout.write(`BRIDGE_SEAL_KEY=${privateKey}\npublic key: ${publicKey}\n`);
}
