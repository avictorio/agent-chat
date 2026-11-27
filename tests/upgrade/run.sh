#!/bin/bash
# The schema upgrade test: rooms written by an older version of the Worker,
# read by this one. Run it before shipping a new schema step (AGENTS.md
# section 13, "Schema changes").
#
#   tests/upgrade/run.sh [OLD_REF]     (default: origin/main)
#
# 1. OLD_REF's Worker (a git worktree) runs under wrangler dev with its own
#    local state and fills two throwaway rooms (phase.js old), Muse hooks
#    included: one a member registered with its own tokens, one an agent
#    key set up (muse_register), on two gadgets' links.
# 2. age.py ages one of them by hand: drops columns newer rooms have,
#    brings back a retired one and clears the schema version - a room as
#    an older deploy could have left it.
# 3. This checkout's Worker starts on the same state and reads both rooms
#    back, posts, opens a draft upload, and turns off the key's wakes
#    (phase.js new). Then the aged room's schema version is cleared again
#    and this checkout starts once more, so every step runs a second time
#    there on rows this code wrote (phase.js again); inspect.py checks every
#    room reached the latest schema version with all its columns, and the
#    holders of its Muse hooks.
# Both Workers run with the config the API suite's server writes (the Muse
# bridge's classes created with SQLite: tests/api/local-config.mjs), a seal
# key of the run's own, and one fake Muse (tests/api/fake-muse.mjs) for both
# phases, which phase.js hosts (phase.js muse).
# Local only: nothing here talks to the live site.
set -u
OLD_REF="${1:-origin/main}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
HERE="$ROOT/tests/upgrade"
WORK="$(mktemp -d -t upgrade-XXXXXX)"
STATE="$WORK/state"
OLD="$WORK/old"
PORT=8799
mkdir -p "$STATE"
# a wrangler dev here is the one on this run's state directory
stop() { pkill -f -- "--persist-to $STATE" 2>/dev/null; for _ in $(seq 1 20); do pgrep -f -- "--persist-to $STATE" > /dev/null || return 0; sleep 0.5; done; pkill -9 -f -- "--persist-to $STATE"; }
cleanup() {
  stop
  [ -n "${MUSE_PID:-}" ] && kill "$MUSE_PID" 2>/dev/null
  rm -f "$OLD/.dev.vars" "$OLD"/.apitest-wrangler-*.toml
  [ -f "$WORK/config-new" ] && rm -f "$(cat "$WORK/config-new")"
  git -C "$ROOT" worktree remove --force "$OLD" 2>/dev/null
  rm -rf "$WORK"
}
trap cleanup EXIT
git -C "$ROOT" worktree add --detach -q "$OLD" "$OLD_REF" || exit 1
# the old Worker needs the toolchain and a web build to serve; reuse this checkout's
ln -s "$ROOT/node_modules" "$OLD/node_modules"
[ -d "$OLD/web/app/dist" ] || { mkdir -p "$OLD/web/app"; ln -s "$ROOT/web/app/dist" "$OLD/web/app/dist"; }
# each checkout's config, and the run's seal key (tests/api/local-config.mjs)
node --input-type=module -e "
import fs from 'node:fs';
import { testConfig, sealKey } from '$ROOT/tests/api/local-config.mjs';
const k = sealKey();
fs.writeFileSync('$WORK/seal.json', JSON.stringify(k));
fs.writeFileSync('$WORK/config-old', testConfig('$OLD'));
fs.writeFileSync('$WORK/config-new', testConfig('$ROOT'));
" || exit 1
# the fake Muse, once for both phases; it writes its address and the gadgets' sealed tokens to muse.json
node "$HERE/phase.js" muse "$WORK" > "$WORK/muse.log" 2>&1 &
MUSE_PID=$!
for _ in $(seq 1 60); do [ -f "$WORK/muse.json" ] && break; kill -0 "$MUSE_PID" 2>/dev/null || break; sleep 0.5; done
[ -f "$WORK/muse.json" ] || { echo "the fake Muse did not start"; cat "$WORK/muse.log"; exit 1; }
MUSE_URL=$(node -e "process.stdout.write(require('$WORK/muse.json').url)")
SEAL=$(node -e "process.stdout.write(require('$WORK/seal.json').privateKey)")
VARS="OWNER_KEY=upg-owner\nTEST_HOOKS=1\nTEST_MUSE_ORIGIN=$MUSE_URL\nMUSE_SEAL_KEY=$SEAL\n"
# Up means OUR wrangler: still running, its own log says it is ready, and
# the port reports the build id of the index.html it serves. Any answer on
# the port used to do, so a leftover server on 8799 (or another run's) was
# filled and read in place of the Worker under test.
up() { # $1: the wrangler pid, $2: its log, $3: the checkout
  local want; want=$(sha256sum "$3/web/app/dist/index.html" | cut -c1-16)
  for _ in $(seq 1 90); do
    kill -0 "$1" 2>/dev/null || return 1
    if grep -q "Ready on " "$2" && curl -s "http://localhost:$PORT/api/build" | grep -q "\"build\":\"$want\""; then return 0; fi
    sleep 1
  done
  return 1
}
start() { # $1: the checkout to run, $2: its name in the logs, $3: its config
  printf "$VARS" > "$1/.dev.vars"
  (cd "$1" && exec npx wrangler dev -c "$3" --port $PORT --persist-to "$STATE" > "$WORK/wrangler-$2.log" 2>&1) &
  up $! "$WORK/wrangler-$2.log" "$1" || { echo "wrangler dev did not come up on port $PORT (is another server on it?)"; tail -20 "$WORK/wrangler-$2.log" | grep -v '^env\.'; exit 1; }
  echo "   wrangler dev is up ($2)"
}
echo "== $OLD_REF fills the rooms"
start "$OLD" old "$(cat "$WORK/config-old")"; node "$HERE/phase.js" old "$WORK"; R1=$?; stop; rm -f "$OLD/.dev.vars"
[ $R1 -eq 0 ] || exit 1
echo "== age one room"
python3 "$HERE/age.py" "$STATE" || exit 1
echo "== this checkout reads them"
had_vars=0; [ -f "$ROOT/.dev.vars" ] && { had_vars=1; cp "$ROOT/.dev.vars" "$WORK/dev.vars.bak"; }
start "$ROOT" new "$(cat "$WORK/config-new")"; node "$HERE/phase.js" new "$WORK"; R2=$?; stop
echo "== the aged room runs every step again, on rows this code wrote"
python3 "$HERE/age.py" --version-only "$STATE" || exit 1
start "$ROOT" again "$(cat "$WORK/config-new")"; node "$HERE/phase.js" again "$WORK"; R4=$?; stop
if [ $had_vars -eq 1 ]; then cp "$WORK/dev.vars.bak" "$ROOT/.dev.vars"; else rm -f "$ROOT/.dev.vars"; fi
python3 "$HERE/inspect.py" "$STATE"; R3=$?
[ $R2 -eq 0 ] && [ $R4 -eq 0 ] && [ $R3 -eq 0 ] && echo "UPGRADE TEST: passed" || { echo "UPGRADE TEST: failed"; exit 1; }
