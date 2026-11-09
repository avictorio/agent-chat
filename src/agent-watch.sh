#!/usr/bin/env bash
# Watches an Agent Chat room for new messages over the room's SSE stream.
#
# Each run opens the stream at the saved cursor and listens for a bounded
# window: the server replays everything after the cursor first, then live
# frames arrive as they are posted. The run returns early once a non-self
# message has been seen (plus a short grace period to coalesce a burst).
# Game frames wake too: they carry no message id, so they never move the
# cursor - the woken agent checks the match state itself and moves if a
# game awaits it.
# If the stream cannot be opened at all, the run falls back to one REST
# long-poll, so a stream outage degrades to plain polling instead of
# blindness. Cursor + spool live under the state dir; the cursor advances
# only past message frames actually processed, and every processed frame's
# id is persisted before the run ends, so a killed run loses nothing.
#
# Instance configuration (a generated copy per room normally carries these
# as literals; the environment overrides exist for testing):
#   AGENTCHAT_ROOM, AGENTCHAT_ORIGIN, AGENTCHAT_SELF, AGENTCHAT_STATE_DIR,
#   AGENTCHAT_STREAM_BASE (test hook: point the stream somewhere broken to
#   exercise the REST fallback)
set -euo pipefail
source "$HATCH_HOOK_RUNTIME"

ROOM="${AGENTCHAT_ROOM:-__ROOM__}"
ORIGIN="${AGENTCHAT_ORIGIN:-__ORIGIN__}"
SELF="${AGENTCHAT_SELF:-__SELF__}"
BASE="$ORIGIN/api/rooms/$ROOM"
STATE_DIR="${AGENTCHAT_STATE_DIR:-$HOME/hooks/state/agent-chat}"
CURSOR_FILE="$STATE_DIR/$ROOM.cursor"
SPOOL_FILE="$STATE_DIR/$ROOM.jsonl"
TOKEN_FILE="$STATE_DIR/invite.token"
WINDOW=20   # max seconds spent listening to the stream per run
GRACE=2     # extra seconds after the first relevant frame, to coalesce a burst

mkdir -p "$STATE_DIR"

DRY=0
if [ "${HATCH_HOOK_DRY_RUN:-0}" = "1" ]; then
  DRY=1
fi

AUTH_ARGS=()
if [ -f "$TOKEN_FILE" ]; then
  AUTH_ARGS=(-H "X-Invite-Token: $(cat "$TOKEN_FILE")")
fi

write_cursor() {
  printf '%s' "$1" > "$CURSOR_FILE.tmp.$$"
  mv "$CURSOR_FILE.tmp.$$" "$CURSOR_FILE"
}

# No cursor yet: start at the room's current frontier so the first run does
# not replay history.
if [ ! -f "$CURSOR_FILE" ]; then
  INIT_ID=$(curl --fail --silent --show-error --max-time 15 "${AUTH_ARGS[@]}" "$BASE/messages" | jq -r '.last_id // 0') || INIT_ID=""
  if [ -z "$INIT_ID" ] || [ "$INIT_ID" = "null" ]; then
    log "cursor init failed"
    silent "cursor init failed"
    exit 0
  fi
  if [ "$DRY" = "0" ]; then
    write_cursor "$INIT_ID"
  fi
  log "initialized cursor at $INIT_ID"
  silent "initialized cursor"
  exit 0
fi

CURSOR=$(cat "$CURSOR_FILE")
START_CURSOR="$CURSOR"

TMPD=$(mktemp -d)
trap 'rm -rf "$TMPD"' EXIT
COLLECTED="$TMPD/messages.jsonl"
: > "$COLLECTED"
GAMES="$TMPD/games.jsonl"
: > "$GAMES"

# --- Primary path: the SSE stream -------------------------------------------
# curl runs as a direct background child writing to a FIFO, so its PID is
# curl's own and the kill at the end of the window lands immediately. (A
# coproc wrapper can leave curl alive until its max-time when killed.)
STREAM_BASE="${AGENTCHAT_STREAM_BASE:-$BASE/stream}"
FIFO="$TMPD/stream.fifo"
mkfifo "$FIFO"
curl -sN --fail --no-buffer --max-time $((WINDOW + 5)) "${AUTH_ARGS[@]}" "$STREAM_BASE?after=$CURSOR&events=all" > "$FIFO" &
CPID=$!
exec 3< "$FIFO"
FD=3

SAW_LINE=0
SAW_FRAME=0
GRACE_SET=0
EVENT=""
DATA=""
DEADLINE=$((SECONDS + WINDOW))

start_grace() {
  if [ "$GRACE_SET" = "0" ]; then
    GRACE_SET=1
    GRACE_DEADLINE=$((SECONDS + GRACE))
    if [ "$GRACE_DEADLINE" -lt "$DEADLINE" ]; then
      DEADLINE=$GRACE_DEADLINE
    fi
  fi
}

while :; do
  REMAINING=$((DEADLINE - SECONDS))
  if [ "$REMAINING" -le 0 ]; then
    break
  fi
  LINE=""
  if ! IFS= read -r -t "$REMAINING" LINE <&"$FD"; then
    break
  fi
  SAW_LINE=1
  case "$LINE" in
    "event: "*)
      EVENT=${LINE#event: }
      ;;
    "data: "*)
      DATA=${LINE#data: }
      ;;
    "")
      # Blank line: a frame is complete. Only message frames carry a
      # message id, so only they move the cursor; game frames wake
      # without touching it.
      if [ "$EVENT" = "message" ] && [ -n "$DATA" ]; then
        SAW_FRAME=1
        MID=$(printf '%s' "$DATA" | jq -r '.id // empty' 2>/dev/null || true)
        FROM=$(printf '%s' "$DATA" | jq -r '.from // empty' 2>/dev/null || true)
        if [ -n "$MID" ] && [ "$MID" -gt "$CURSOR" ] 2>/dev/null; then
          CURSOR=$MID
        fi
        if [ -n "$FROM" ] && [ "$FROM" != "$SELF" ]; then
          printf '%s' "$DATA" | jq -c 'del(.room_state)' >> "$COLLECTED"
          start_grace
        fi
      elif [ "$EVENT" = "game" ] && [ -n "$DATA" ]; then
        # A game changed (a move, a resolved tick, a finish). Collect a
        # compact copy - trails are the bulk of the frame and the woken
        # agent re-reads full state anyway - and start the same grace.
        SAW_FRAME=1
        printf '%s' "$DATA" | jq -c 'del(.game.trails)' >> "$GAMES" 2>/dev/null || true
        start_grace
      fi
      EVENT=""
      DATA=""
      ;;
    *)
      : # "id:" lines (already reflected in the data), "retry:", ": ping"
      ;;
  esac
done

exec 3<&- 2>/dev/null || true
kill "$CPID" 2>/dev/null || true
wait "$CPID" 2>/dev/null || true

# --- Fallback: one REST long-poll -------------------------------------------
# Only when the stream delivered nothing at all: no frames, not even the
# opening retry line or a ping. A healthy quiet stream never lands here.
if [ "$SAW_LINE" = "0" ] && [ ! -s "$COLLECTED" ]; then
  if RESP=$(curl --fail --silent --show-error --max-time 25 "${AUTH_ARGS[@]}" "$BASE/messages?after=$START_CURSOR&wait=20"); then
    LAST_ID=$(printf '%s' "$RESP" | jq -r '.last_id // empty')
    if [ -n "$LAST_ID" ]; then
      CURSOR=$LAST_ID
      printf '%s' "$RESP" | jq -c --arg self "$SELF" '.messages[] | select(.from != $self)' > "$COLLECTED" || true
      SAW_FRAME=1
      log "stream unavailable; used REST fallback"
    fi
  fi
  if [ "$SAW_FRAME" = "0" ]; then
    log "room fetch failed"
    silent "room fetch failed"
    exit 0
  fi
fi

MSG_COUNT=$(jq -s 'length' "$COLLECTED")
GAME_COUNT=$(jq -s 'length' "$GAMES")
COUNT=$((MSG_COUNT + GAME_COUNT))

if [ "$DRY" = "1" ]; then
  log "dry run"
  if [ "$COUNT" -gt 0 ]; then
    wake "dry-run: would wake on room activity" "{\"count\":$COUNT}"
  else
    silent "dry-run: no new messages"
  fi
  exit 0
fi

write_cursor "$CURSOR"
if [ "$MSG_COUNT" -gt 0 ]; then
  jq -s '.' "$COLLECTED" | jq -c '.[]' >> "$SPOOL_FILE"
fi

log "polled room (stream)"
if [ "$COUNT" -gt 0 ]; then
  MSGS_JSON=$(jq -s '.' "$COLLECTED")
  if [ "$GAME_COUNT" -gt 0 ]; then
    GAMES_JSON=$(jq -s '.' "$GAMES")
    PAYLOAD=$(jq -n --arg room "$ROOM" --argjson messages "$MSGS_JSON" --argjson games "$GAMES_JSON" '{room:$room,messages:$messages,games:$games}')
  else
    PAYLOAD=$(jq -n --arg room "$ROOM" --argjson messages "$MSGS_JSON" '{room:$room,messages:$messages}')
  fi
  if [ "$MSG_COUNT" -gt 0 ]; then
    wake "new messages in $ROOM" "$PAYLOAD"
  else
    wake "game update in $ROOM" "$PAYLOAD"
  fi
else
  silent "no new messages"
fi
exit 0
