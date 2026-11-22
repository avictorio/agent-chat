#!/bin/bash
# The schema upgrade test: rooms written by an older version of the Worker,
# read by this one. Run it before shipping a new schema step (AGENTS.md
# section 13, "Schema changes").
#
#   tests/upgrade/run.sh [OLD_REF]     (default: origin/main)
#
# 1. OLD_REF's Worker (a git worktree) runs under wrangler dev with its own
#    local state and fills two throwaway rooms (phase.js old).
# 2. age.py ages one of them by hand: drops columns newer rooms have,
#    brings back a retired one and clears the schema version - a room as
#    an older deploy could have left it.
# 3. This checkout's Worker starts on the same state and reads both rooms
#    back, posts, opens a draft upload (phase.js new); inspect.py checks
#    every room reached the latest schema version with all its columns.
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
  rm -f "$OLD/.dev.vars"
  git -C "$ROOT" worktree remove --force "$OLD" 2>/dev/null
  rm -rf "$WORK"
}
trap cleanup EXIT
git -C "$ROOT" worktree add --detach -q "$OLD" "$OLD_REF" || exit 1
# the old Worker needs the toolchain and a web build to serve; reuse this checkout's
ln -s "$ROOT/node_modules" "$OLD/node_modules"
[ -d "$OLD/web/app/dist" ] || { mkdir -p "$OLD/web/app"; ln -s "$ROOT/web/app/dist" "$OLD/web/app/dist"; }
VARS='OWNER_KEY=upg-owner\nTEST_HOOKS=1\n'
up() { for _ in $(seq 1 90); do curl -s -o /dev/null "http://localhost:$PORT/api" && return 0; sleep 1; done; return 1; }
start() { # $1: the checkout to run
  printf "$VARS" > "$1/.dev.vars"
  (cd "$1" && exec npx wrangler dev --port $PORT --persist-to "$STATE" > "$WORK/wrangler-$2.log" 2>&1) &
  up || { echo "wrangler dev did not come up"; tail -20 "$WORK/wrangler-$2.log"; exit 1; }
  echo "   wrangler dev is up ($2)"
}
echo "== $OLD_REF fills the rooms"
start "$OLD" old; node "$HERE/phase.js" old "$WORK"; R1=$?; stop; rm -f "$OLD/.dev.vars"
[ $R1 -eq 0 ] || exit 1
echo "== age one room"
python3 "$HERE/age.py" "$STATE" || exit 1
echo "== this checkout reads them"
had_vars=0; [ -f "$ROOT/.dev.vars" ] && { had_vars=1; cp "$ROOT/.dev.vars" "$WORK/dev.vars.bak"; }
start "$ROOT" new; node "$HERE/phase.js" new "$WORK"; R2=$?; stop
if [ $had_vars -eq 1 ]; then cp "$WORK/dev.vars.bak" "$ROOT/.dev.vars"; else rm -f "$ROOT/.dev.vars"; fi
python3 "$HERE/inspect.py" "$STATE"; R3=$?
[ $R2 -eq 0 ] && [ $R3 -eq 0 ] && echo "UPGRADE TEST: passed" || { echo "UPGRADE TEST: failed"; exit 1; }
