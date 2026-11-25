// scripts/check-config.js against a live config of the test's own: the
// script reads the live Worker through a connector helper under the home
// directory, so each case runs it with HOME pointing at a scratch
// directory whose helper prints the config the case names. Nothing here
// reaches Cloudflare.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.join(import.meta.dirname, "..", "..");
const SCRIPT = path.join(ROOT, "scripts", "check-config.js");
// the script runs its helper with python3; a machine without one cannot run it at all
const noPython = spawnSync("python3", ["--version"]).status !== 0;

/** wrangler.toml's [vars], as the script reads them. */
function fileVars() {
  const out = {};
  let inVars = false;
  for (const raw of fs.readFileSync(path.join(ROOT, "wrangler.toml"), "utf8").split("\n")) {
    const line = raw.trim();
    if (line.startsWith("[")) { inVars = line === "[vars]"; continue; }
    const m = inVars && line.match(/^([A-Z0-9_]+)\s*=\s*"([^"]*)"/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

const REQUIRED = ["CARTESIA_API_KEY", "GMAIL_SA", "MUSE_SEAL_KEY", "OWNER_KEY"];

/** The script's exit status and output for this live config. */
function check(live) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "check-config-"));
  try {
    const bin = path.join(home, "workspace", "custom-connectors", "custom.cloudflare", "bin");
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, "cloudflare.py"), "import sys\nsys.stdout.write(" + JSON.stringify(JSON.stringify(live)) + ")\n");
    try {
      return { status: 0, out: execFileSync(process.execPath, [SCRIPT], { env: { ...process.env, HOME: home, USERPROFILE: home }, encoding: "utf8" }) };
    } catch (e) {
      return { status: e.status, out: String(e.stdout) };
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test("the unused MUSE_BRIDGE_KEY is noted as kept until the cut-over has held, never as one to delete", { skip: noPython && "no python3" }, () => {
  const r = check({ vars: fileVars(), secrets: [...REQUIRED, "MUSE_BRIDGE_KEY"] });
  assert.equal(r.status, 0, r.out);
  const line = r.out.split("\n").find((l) => l.includes("MUSE_BRIDGE_KEY")) || "";
  assert.match(line, /^note {3}secret MUSE_BRIDGE_KEY is live: unused .*until the owner deletes it with the muse-bridge Worker, once the cut-over has held/);
  assert.doesNotMatch(r.out, /MUSE_BRIDGE_KEY[^\n]*delete it in the dashboard/);
  assert.doesNotMatch(r.out, /MUSE_BRIDGE_KEY[^\n]*not in the AGENTS\.md section 2 inventory/);
});

test("a retired secret still live is noted for deletion; a required one missing is drift", { skip: noPython && "no python3" }, () => {
  let r = check({ vars: fileVars(), secrets: [...REQUIRED, "NTFY_TOPIC"] });
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /retired secret NTFY_TOPIC is still live - delete it in the dashboard/);
  r = check({ vars: fileVars(), secrets: REQUIRED.filter((s) => s !== "MUSE_SEAL_KEY") });
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /DRIFT {2}secret MUSE_SEAL_KEY: required/);
});

test("a test hook in the live config fails the check by name", { skip: noPython && "no python3" }, () => {
  for (const name of ["TEST_HOOKS", "TEST_MUSE_ORIGIN"]) {
    let r = check({ vars: { ...fileVars(), [name]: "1" }, secrets: REQUIRED });
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, new RegExp("DRIFT {2}" + name + ": TEST HOOK LIVE"));
    r = check({ vars: fileVars(), secrets: [...REQUIRED, name] });
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, new RegExp("DRIFT {2}" + name + ": TEST HOOK LIVE"));
  }
});
