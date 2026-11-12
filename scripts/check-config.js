// Config drift check: compare the victorio-chat Worker's LIVE configuration
// against this repo, so a dashboard-only value can never again be wiped
// silently by a deploy (the GMAIL_SENDER / FCM_SA trap, AGENTS.md section 12).
//
//   npm run check:config
//
// Reads live config through Ada's custom.cloudflare connection (a
// read-only Cloudflare API token held in encrypted storage; the helper
// prints plain variable values and secret NAMES only - the API never
// returns secret values). Exit codes: 0 in sync, 1 drift found,
// 2 the live read itself failed (no connection, helper missing, API error).
//
// The secret inventory below mirrors AGENTS.md section 2. When a secret
// is added or retired, update both places in the same commit.
"use strict";

const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const REQUIRED_SECRETS = [
  "CARTESIA_API_KEY",
  "FCM_SA",
  "GMAIL_SA",
  "OWNER_KEY",
];
// Optional secrets: fine either way, reported for visibility.
const OPTIONAL_SECRETS = ["RESEND_API_KEY"];
// Retired secrets: nothing reads them any more. Still listed live means
// the dashboard Secret should be deleted (and the credential revoked at
// its issuer). Both retired 2026-11-12: ANTHROPIC_API_KEY fed the in-room
// bot, NTFY_TOPIC the change-request queue's phone alerts.
const RETIRED_SECRETS = ["ANTHROPIC_API_KEY", "NTFY_TOPIC"];
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
    console.error("This check needs Ada's custom.cloudflare connection (read-only token).");
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
// (the API suite sets it in .dev.vars only). If it ever appears in the live
// config - as a var or a secret - the outage simulation is one owner call
// away from production. Fail loudly and by name.
for (const name of ["TEST_HOOKS", "TEST_R2_FAIL"]) {
  if (name in liveVars || liveSecrets.has(name))
    fail(name + ": TEST HOOK LIVE - remove it from the dashboard config immediately; it belongs only in the test suite's .dev.vars");
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
for (const name of liveSecrets) {
  if (!REQUIRED_SECRETS.includes(name) && !OPTIONAL_SECRETS.includes(name) && !RETIRED_SECRETS.includes(name))
    note("secret " + name + " is live but not in the AGENTS.md section 2 inventory");
}

if (failures) {
  console.log("\ncheck:config: " + failures + " drift item(s) - fix before the next deploy");
  process.exit(1);
}
console.log("\ncheck:config: live config matches wrangler.toml and the section 2 inventory");
