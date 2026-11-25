#!/usr/bin/env node
// A bridge seal key pair, for local runs and tests:
//   npm run bridge:keygen                -> MUSE_SEAL_KEY=... and the public key
//   npm run bridge:keygen -- --dev-vars  -> the same as lines for .dev.vars
// (node --import ./tests/unit/register.mjs scripts/bridge/keygen.mjs: the
// hooks load the Worker's TypeScript, whose imports name "./x.js".)
// Production keys are made the same way and stored with `wrangler secret put
// MUSE_SEAL_KEY` on the chat Worker; never commit the private key. Every
// gadget seals to the public key, so a new key breaks their token updates
// until each connects again (AGENTS.md section 2, MUSE_SEAL_KEY).
import { generateBridgeKey } from '../../worker/bridge/seal.ts';

const { privateKey, publicKey } = await generateBridgeKey();
if (process.argv.includes('--dev-vars')) {
  process.stdout.write(`MUSE_SEAL_KEY=${privateKey}\n# public key: ${publicKey}\n`);
} else {
  process.stdout.write(`MUSE_SEAL_KEY=${privateKey}\npublic key: ${publicKey}\n`);
}
