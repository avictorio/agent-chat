// Config drift check: compare the victorio-chat Worker's LIVE configuration
// against this repo, so a dashboard-only value is never wiped silently by a
// deploy (AGENTS.md section 7, "About wrangler.toml").
//
//   npm run check:config
//
// It reads the live config through Ada's custom.cloudflare connection, a
// Cloudflare API token held in encrypted storage. The token carries Workers
// Scripts Edit, so treat it as write-capable; this script only reads
// (AGENTS.md section 7). The helper prints plain variable values and secret
// NAMES only: the API never returns secret values. Exit codes: 0 in sync,
// 1 drift found, 2 the live read itself failed (no connection, helper
// missing, API error).
//
// The secret inventory below mirrors AGENTS.md section 2. When a secret
// is added or retired, update both places in the same commit.
"use strict";

const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

// MUSE_SEAL_KEY is the X25519 key every Muse gadget seals its token to:
// without it the gadget's handover (seal-key, connect, update) answers 503
// and tokens stop reaching the bridge, so a deploy must not go out without
// it.
const REQUIRED_SECRETS = [
  "CARTESIA_API_KEY",
  "GMAIL_SA",
  "MUSE_SEAL_KEY",
  "OWNER_KEY",
];
// Optional secrets: fine either way, reported for visibility.
// ANTHROPIC_API_KEY came back 2026-11-20 (the owner's call) for Sketch &
// Guess's Referee, which asks Claude about close-call guesses; without it
// the game falls back to plain text matching.
// R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY (2026-11-20): the R2 API
// credential (one bucket, object read & write) that direct uploads' part
// credentials are derived from; without it every upload goes through the
// Worker (up to ~943 GB).
// MUSE_DELIVER_PAUSED: "1" pauses every Muse wake (rooms keep them queued);
// unset in normal running.
const OPTIONAL_SECRETS = ["RESEND_API_KEY", "ANTHROPIC_API_KEY", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "MUSE_DELIVER_PAUSED"];
// Retired secrets: nothing reads them any more. Still listed live means
// the dashboard Secret should be deleted (and the credential revoked at
// its issuer). Retired 2026-11-12: NTFY_TOPIC, the change-request queue's
// phone alerts. Retired 2026-11-20: FCM_SA, the Android app's push (the
// app and its server side are gone). Both are deleted live (FCM_SA on
// 2026-11-20); they stay listed so one that comes back is flagged.
const RETIRED_SECRETS = ["NTFY_TOPIC", "FCM_SA"];
// Unused secrets that stay live for now, each with what to do about it.
// MUSE_BRIDGE_KEY (unused since 2026-11-25): the key the site showed the
// separate muse-bridge Worker. Deleting a secret is the owner's call:
// this one goes with the muse-bridge Worker, which is still on the
// account (AGENTS.md section 15); then it moves to RETIRED_SECRETS.
const KEPT_SECRETS = {
  MUSE_BRIDGE_KEY: "unused since the Muse bridge moved into this Worker; keep it until the owner deletes it with the muse-bridge Worker (AGENTS.md section 15)",
};
// Optional plain variables that may live only in wrangler.toml when used;
// a live value with no file entry is still drift for these (the deploy
// would delete it), they are listed so the fix is a file entry, not a
// mystery. RESEND_FROM is the current one.
const OPTIONAL_VARS = ["RESEND_FROM"];

function fileVars() {
  const toml = fs.readFileSync(path.join(__dirname, "..", "wrangler.toml"), "utf8");
  const out = {};
  let inVars = false;
  for (const raw of toml.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("[")) { inVars = line === "[vars]"; continue; }
    if (!inVars || !line || line.startsWith("#")) continue;
    const m = line.match(/^([A-Z0-9_]+)\s*=\s*"([^"]*)"/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

function liveConfig() {
  const helper = path.join(os.homedir(), "workspace", "custom-connectors",
    "custom.cloudflare", "bin", "cloudflare.py");
  if (!fs.existsSync(helper)) {
    console.error("check:config: live read unavailable - connector helper not found at " + helper);
    console.error("This check needs Ada's custom.cloudflare connection (its token is write-capable; this script only reads).");
    process.exit(2);
  }
  let stdout;
  try {
    stdout = execFileSync("python3", [helper, "worker-config"], { encoding: "utf8" });
  } catch (e) {
    console.error("check:config: live read failed: " + (e.stderr || e.message));
    process.exit(2);
  }
  return JSON.parse(stdout);
}

const want = fileVars();
const live = liveConfig();
const liveVars = live.vars || {};
const liveSecrets = new Set(live.secrets || []);
let failures = 0;
const fail = (msg) => { failures++; console.log("DRIFT  " + msg); };
const ok = (msg) => console.log("ok     " + msg);
const note = (msg) => console.log("note   " + msg);

// File variables must exist live with the same value.
for (const key of Object.keys(want)) {
  if (!(key in liveVars)) fail(key + ": in wrangler.toml [vars] but NOT live");
  else if (liveVars[key] !== want[key])
    fail(key + ": value differs - file has " + JSON.stringify(want[key]) +
         ", live has " + JSON.stringify(liveVars[key]));
  else ok("var " + key + " = " + JSON.stringify(want[key]));
}
// Live variables must exist in the file, or the next deploy deletes them.
for (const key of Object.keys(liveVars)) {
  if (key in want) continue;
  if (OPTIONAL_VARS.includes(key))
    fail(key + ": live-only optional variable - the next deploy will DELETE it; add it to wrangler.toml [vars]");
  else
    fail(key + ": live but NOT in wrangler.toml [vars] - the next deploy will DELETE it; move it into the file");
}
// Test hooks must never be live: TEST_HOOKS arms the /api/test-hooks routes
// (the API suite passes it to its local server only). If it ever appears in the live
// config - as a var or a secret - the outage simulation is one owner call
// away from production. TEST_MUSE_ORIGIN, with TEST_HOOKS, sends the Muse
// bridge's calls to the suite's fake Muse. Fail loudly and by name.
for (const name of ["TEST_HOOKS", "TEST_MUSE_ORIGIN"]) {
  if (name in liveVars || liveSecrets.has(name))
    fail(name + ": TEST HOOK LIVE - remove it from the dashboard config immediately; it belongs only on the test suite's local server");
}
// Required secrets must be listed live (names only).
for (const name of REQUIRED_SECRETS) {
  if (liveSecrets.has(name)) ok("secret " + name + " present");
  else fail("secret " + name + ": required (AGENTS.md section 2) but NOT listed live");
}
for (const name of OPTIONAL_SECRETS) {
  if (liveSecrets.has(name)) note("optional secret " + name + " is set");
}
for (const name of RETIRED_SECRETS) {
  if (liveSecrets.has(name)) note("retired secret " + name + " is still live - delete it in the dashboard and revoke the credential");
}
for (const [name, why] of Object.entries(KEPT_SECRETS)) {
  if (liveSecrets.has(name)) note("secret " + name + " is live: " + why);
}
for (const name of liveSecrets) {
  if (!REQUIRED_SECRETS.includes(name) && !OPTIONAL_SECRETS.includes(name) && !RETIRED_SECRETS.includes(name) && !(name in KEPT_SECRETS))
    note("secret " + name + " is live but not in the AGENTS.md section 2 inventory");
}

if (failures) {
  console.log("\ncheck:config: " + failures + " drift item(s) - fix before the next deploy");
  process.exit(1);
}
console.log("\ncheck:config: live config matches wrangler.toml and the section 2 inventory");
