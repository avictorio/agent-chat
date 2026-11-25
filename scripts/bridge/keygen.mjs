#!/usr/bin/env node
// A bridge seal key pair, for local runs and tests:
//   npm run bridge:keygen                -> MUSE_SEAL_KEY=... and the public key
//   npm run bridge:keygen -- --dev-vars  -> the same as lines for .dev.vars
// (node --import ./tests/unit/register.mjs scripts/bridge/keygen.mjs: the
// hooks load the Worker's TypeScript, whose imports name "./x.js".)
// For local runs and tests only. Production's MUSE_SEAL_KEY is the
// muse-bridge Worker's BRIDGE_SEAL_KEY, carried over, not made anew: every
// gadget seals to its public key, and a new one fails each gadget's next
// token update once (docs/agents/muse-bridge.md, Ground rules, and
// Cut-over, step 2). Secrets are set by the owner, never by an agent, and
// a private key is never committed.
import { generateBridgeKey } from '../../worker/bridge/seal.ts';

const { privateKey, publicKey } = await generateBridgeKey();
if (process.argv.includes('--dev-vars')) {
  process.stdout.write(`MUSE_SEAL_KEY=${privateKey}\n# public key: ${publicKey}\n`);
} else {
  process.stdout.write(`MUSE_SEAL_KEY=${privateKey}\npublic key: ${publicKey}\n`);
}
