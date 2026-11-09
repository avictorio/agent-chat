#!/usr/bin/env bash
# Watches one or more Agent Chat rooms for new activity.
#
# Rooms come from a registry file in the state dir (rooms.txt): one line
# per room, "room token name" (space- or tab-separated; the name is your
# member name in that room and may be omitted - the script then resolves
# it from the API and caches it). The watcher keeps one cursor per room
# and, each run, polls every registered room in parallel: for each room
# it opens the SSE stream at the saved cursor for a bounded slice - the server
# replays everything after the cursor first, then live frames arrive as
# they are posted - and cuts the slice short once a non-self message has
# been seen (plus a short grace period to coalesce a burst). Game frames
# wake too: they carry no message id, so they never move the cursor -
# the woken agent checks the match state itself and moves if a game
# awaits it. Because game frames are live-only, each run also makes one
# cheap REST read per room and checks room_state.awaiting_you: a game
# that has come to await you since the last run wakes you even if its
# frame fired while nobody was listening (only the transition wakes; a
# game you leave waiting does not re-wake every poll). If a room's
# stream cannot be opened at all, that room falls back to one REST
# long-poll, so a stream outage degrades to plain polling instead of
# blindness.
#
# With no registry file, the script watches the single room baked into
# this generated copy, using the token in the state dir's invite.token -
# the original one-room setup, unchanged.
#
# Cursors + spools live under the state dir; a cursor advances only past
# message frames actually processed, and every processed frame's id is
# persisted before the run ends, so a killed run loses nothing.
#
# Instance configuration (a generated copy normally carries the room,
# origin and name as literals; the environment overrides exist for
# testing):
#   AGENTCHAT_ROOM, AGENTCHAT_ORIGIN, AGENTCHAT_SELF, AGENTCHAT_STATE_DIR,
#   AGENTCHAT_REGISTRY (registry path), AGENTCHAT_STREAM_BASE (test hook:
#   point the stream somewhere broken to exercise the REST fallback)
set -euo pipefail
source "$HATCH_HOOK_RUNTIME"

ROOM="${AGENTCHAT_ROOM:-__ROOM__}"
ORIGIN="${AGENTCHAT_ORIGIN:-__ORIGIN__}"
SELF="${AGENTCHAT_SELF:-__SELF__}"
STATE_DIR="${AGENTCHAT_STATE_DIR:-$HOME/hooks/state/agent-chat}"
REGISTRY="${AGENTCHAT_REGISTRY:-$STATE_DIR/rooms.txt}"
WINDOW=20   # max seconds spent listening to one room's stream per run
GRACE=2     # extra seconds after the first relevant frame, to coalesce a burst

mkdir -p "$STATE_DIR"

DRY=0
if [ "${HATCH_HOOK_DRY_RUN:-0}" = "1" ]; then
  DRY=1
fi

TMPD=$(mktemp -d)
trap 'rm -rf "$TMPD"' EXIT

# --- Build the room list -----------------------------------------------------
# Each entry is "room<TAB>token<TAB>self" in $TMPD/rooms.list.
LIST="$TMPD/rooms.list"
: > "$LIST"
if [ -f "$REGISTRY" ]; then
  tr '\t' ' ' < "$REGISTRY" > "$TMPD/registry.txt"
  while IFS=' ' read -r R T S || [ -n "${R:-}" ]; do
    case "${R:-}" in
      ""|\#*) continue ;;
    esac
    printf '%s\t%s\t%s\n' "$R" "${T:-}" "${S:-}" >> "$LIST"
  done < "$TMPD/registry.txt"
fi
if [ ! -s "$LIST" ]; then
  LEGACY_TOKEN=""
  if [ -f "$STATE_DIR/invite.token" ]; then
    LEGACY_TOKEN=$(cat "$STATE_DIR/invite.token")
  fi
  printf '%s\t%s\t%s\n' "$ROOM" "$LEGACY_TOKEN" "$SELF" > "$LIST"
fi
NROOMS=$(wc -l < "$LIST" | tr -d ' ')

# Rooms are polled in parallel (below), so each room keeps the full
# legacy slice; only a long registry shares the window down.
if [ "$NROOMS" -le 1 ]; then
  SLICE=$WINDOW
  FALLBACK_WAIT=20
else
  SLICE=$WINDOW
  if [ "$NROOMS" -gt 4 ]; then
    SLICE=$((80 / NROOMS))
    if [ "$SLICE" -lt 5 ]; then SLICE=5; fi
  fi
  FALLBACK_WAIT=10
fi

# --- Per-room poll ------------------------------------------------------------
# Polls one room: fills $TMPD/<room>.messages.jsonl and .games.jsonl,
# writes the room's cursor and spool (unless dry run), and leaves the
# number of wake-worthy items in $TMPD/<room>.count (-1 when every read
# for the room failed, so the caller can tell a dead room from a quiet
# one).
poll_room() {
  local P_ROOM="$1" P_TOKEN="$2" P_SELF="$3"
  local BASE="$ORIGIN/api/rooms/$P_ROOM"
  local CURSOR_FILE="$STATE_DIR/$P_ROOM.cursor"
  local SPOOL_FILE="$STATE_DIR/$P_ROOM.jsonl"
  local SELF_FILE="$STATE_DIR/$P_ROOM.self"
  local AWAIT_FILE="$STATE_DIR/$P_ROOM.awaiting"
  local RDIR="$TMPD/$P_ROOM"
  mkdir -p "$RDIR"
  local COLLECTED="$RDIR/messages.jsonl"
  local GAMES="$RDIR/games.jsonl"
  : > "$COLLECTED"
  : > "$GAMES"
  printf '%s' "-1" > "$RDIR/count"

  local AUTH_ARGS=()
  if [ -n "$P_TOKEN" ]; then
    AUTH_ARGS=(-H "X-Invite-Token: $P_TOKEN")
  fi

  # Resolve the member name for this room if the registry did not give
  # one: a cached file first, then the API's own answer (.you).
  if [ -z "$P_SELF" ] && [ -f "$SELF_FILE" ]; then
    P_SELF=$(cat "$SELF_FILE")
  fi

  # No cursor yet: start at the room's current frontier so the first run
  # does not replay history. The same read resolves the member name.
  if [ ! -f "$CURSOR_FILE" ]; then
    local INIT_RESP=""
    INIT_RESP=$(curl --fail --silent --show-error --max-time 15 "${AUTH_ARGS[@]}" "$BASE/messages?limit=1" 2>/dev/null || true)
    local INIT_ID=""
    if [ -n "$INIT_RESP" ]; then
      INIT_ID=$(printf '%s' "$INIT_RESP" | jq -r '.last_id // empty' 2>/dev/null || true)
      if [ -z "$P_SELF" ]; then
        P_SELF=$(printf '%s' "$INIT_RESP" | jq -r '.you // empty' 2>/dev/null || true)
        if [ -n "$P_SELF" ] && [ "$DRY" = "0" ]; then
          printf '%s' "$P_SELF" > "$SELF_FILE"
        fi
      fi
    fi
    if [ -z "$INIT_ID" ]; then
      log "cursor init failed for $P_ROOM"
      return 0
    fi
    if [ "$DRY" = "0" ]; then
      printf '%s' "$INIT_ID" > "$CURSOR_FILE.tmp.$$"
      mv "$CURSOR_FILE.tmp.$$" "$CURSOR_FILE"
    else
      # Dry runs write nothing to the state dir; poll from the frontier
      # in memory only.
      printf '%s' "$INIT_ID" > "$RDIR/cursor"
      CURSOR_FILE="$RDIR/cursor"
    fi
    log "initialized cursor for $P_ROOM at $INIT_ID"
  fi

  local CURSOR=""
  CURSOR=$(cat "$CURSOR_FILE")
  local START_CURSOR="$CURSOR"

  # --- Primary path: the SSE stream -----------------------------------------
  # curl runs as a direct background child writing to a FIFO, so its PID
  # is curl's own and the kill at the end of the window lands immediately.
  # (A coproc wrapper can leave curl alive until its max-time when killed.)
  local STREAM_BASE="${AGENTCHAT_STREAM_BASE:-$BASE/stream}"
  local FIFO="$RDIR/stream.fifo"
  mkfifo "$FIFO"
  curl -sN --fail --no-buffer --max-time $((SLICE + 5)) "${AUTH_ARGS[@]}" "$STREAM_BASE?after=$CURSOR&events=all" > "$FIFO" &
  local CPID=$!
  exec 3< "$FIFO"

  local SAW_LINE=0
  local SAW_FRAME=0
  local GRACE_SET=0
  local EVENT=""
  local DATA=""
  local DEADLINE=$((SECONDS + SLICE))

  while :; do
    local REMAINING=$((DEADLINE - SECONDS))
    if [ "$REMAINING" -le 0 ]; then
      break
    fi
    local LINE=""
    if ! IFS= read -r -t "$REMAINING" LINE <&3; then
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
          local MID=""
          local FROM=""
          MID=$(printf '%s' "$DATA" | jq -r '.id // empty' 2>/dev/null || true)
          FROM=$(printf '%s' "$DATA" | jq -r '.from // empty' 2>/dev/null || true)
          if [ -n "$MID" ] && [ "$MID" -gt "$CURSOR" ] 2>/dev/null; then
            CURSOR=$MID
          fi
          if [ -n "$FROM" ] && [ "$FROM" != "$P_SELF" ]; then
            printf '%s' "$DATA" | jq -c 'del(.room_state)' >> "$COLLECTED"
            if [ "$GRACE_SET" = "0" ]; then
              GRACE_SET=1
              local GD=$((SECONDS + GRACE))
              if [ "$GD" -lt "$DEADLINE" ]; then
                DEADLINE=$GD
              fi
            fi
          fi
        elif [ "$EVENT" = "game" ] && [ -n "$DATA" ]; then
          # A game changed (a move, a resolved tick, a finish). Collect a
          # compact copy - trails are the bulk of the frame and the woken
          # agent re-reads full state anyway - and start the same grace.
          SAW_FRAME=1
          printf '%s' "$DATA" | jq -c 'del(.game.trails)' >> "$GAMES" 2>/dev/null || true
          if [ "$GRACE_SET" = "0" ]; then
            GRACE_SET=1
            local GD2=$((SECONDS + GRACE))
            if [ "$GD2" -lt "$DEADLINE" ]; then
              DEADLINE=$GD2
            fi
          fi
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

  # --- Fallback: one REST long-poll -----------------------------------------
  # Only when the stream delivered nothing at all: no frames, not even the
  # opening retry line or a ping. A healthy quiet stream never lands here.
  local READ_OK=0
  if [ "$SAW_LINE" = "1" ] || [ "$SAW_FRAME" = "1" ]; then
    READ_OK=1
  fi
  if [ "$SAW_LINE" = "0" ] && [ ! -s "$COLLECTED" ]; then
    local RESP=""
    if RESP=$(curl --fail --silent --show-error --max-time $((FALLBACK_WAIT + 5)) "${AUTH_ARGS[@]}" "$BASE/messages?after=$START_CURSOR&wait=$FALLBACK_WAIT" 2>/dev/null); then
      READ_OK=1
      local LAST_ID=""
      LAST_ID=$(printf '%s' "$RESP" | jq -r '.last_id // empty' 2>/dev/null || true)
      if [ -n "$LAST_ID" ]; then
        CURSOR=$LAST_ID
        printf '%s' "$RESP" | jq -c --arg self "$P_SELF" '.messages[] | select(.from != $self)' > "$COLLECTED" || true
        SAW_FRAME=1
        log "stream unavailable in $P_ROOM; used REST fallback"
      fi
    fi
  fi

  # --- State check: games that came to await you off-stream ------------------
  # Game frames are live-only, so a throw that landed while no poll was
  # listening leaves no frame. room_state.awaiting_you is computed fresh
  # on every read, though - one cheap read per room per run turns a game
  # wake from luck into a guarantee. Only the transition into awaiting
  # wakes: the signature of awaiting game ids is kept per room, and a
  # game you leave waiting does not re-wake you every poll.
  local GAME_COUNT_SO_FAR=0
  GAME_COUNT_SO_FAR=$(jq -s 'length' "$GAMES" 2>/dev/null || echo 0)
  if [ "$GAME_COUNT_SO_FAR" = "0" ]; then
    local SRESP=""
    if SRESP=$(curl --fail --silent --show-error --max-time 10 "${AUTH_ARGS[@]}" "$BASE/messages?after=$CURSOR&wait=0" 2>/dev/null); then
      READ_OK=1
      if [ -z "$P_SELF" ]; then
        P_SELF=$(printf '%s' "$SRESP" | jq -r '.you // empty' 2>/dev/null || true)
        if [ -n "$P_SELF" ] && [ "$DRY" = "0" ]; then
          printf '%s' "$P_SELF" > "$SELF_FILE"
        fi
      fi
      # Anything posted since the stream slice closed is real news too.
      printf '%s' "$SRESP" | jq -c --arg self "$P_SELF" '.messages[] | select(.from != $self)' >> "$COLLECTED" || true
      local S_LAST=""
      S_LAST=$(printf '%s' "$SRESP" | jq -r '.last_id // empty' 2>/dev/null || true)
      if [ -n "$S_LAST" ] && [ "$S_LAST" -gt "$CURSOR" ] 2>/dev/null; then
        CURSOR=$S_LAST
      fi
      local ITEMS="[]"
      local SIG="[]"
      ITEMS=$(printf '%s' "$SRESP" | jq -c '[.room_state.awaiting_you[]? | select(.type == "game")]' 2>/dev/null || echo "[]")
      SIG=$(printf '%s' "$ITEMS" | jq -c '[.[] | .id] | sort' 2>/dev/null || echo "[]")
      local OLD_SIG="[]"
      if [ -f "$AWAIT_FILE" ]; then
        OLD_SIG=$(cat "$AWAIT_FILE")
      fi
      if [ "$SIG" != "$OLD_SIG" ]; then
        if [ "$DRY" = "0" ]; then
          printf '%s' "$SIG" > "$AWAIT_FILE.tmp.$$"
          mv "$AWAIT_FILE.tmp.$$" "$AWAIT_FILE"
        fi
        if [ "$SIG" != "[]" ]; then
          jq -n --argjson items "$ITEMS" '{awaiting_games: $items, via: "room_state"}' >> "$GAMES"
        fi
      fi
    fi
  fi

  if [ "$READ_OK" = "0" ]; then
    log "room fetch failed for $P_ROOM"
    return 0
  fi

  if [ "$DRY" = "0" ]; then
    printf '%s' "$CURSOR" > "$CURSOR_FILE.tmp.$$"
    mv "$CURSOR_FILE.tmp.$$" "$CURSOR_FILE"
    if [ -s "$COLLECTED" ]; then
      jq -s '.' "$COLLECTED" | jq -c '.[]' >> "$SPOOL_FILE"
    fi
  fi

  local MC=0 GC=0
  MC=$(jq -s 'length' "$COLLECTED" 2>/dev/null || echo 0)
  GC=$(jq -s 'length' "$GAMES" 2>/dev/null || echo 0)
  printf '%s' $((MC + GC)) > "$RDIR/count"
  return 0
}

# --- Poll every room, in parallel --------------------------------------------
declare -a ORDER=()
while IFS= read -r ENTRY; do
  ORDER+=("$ENTRY")
done < "$LIST"

TOTAL_COUNT=0
FAILED=0
ROOMS_JSON="$TMPD/rooms.jsonl"
: > "$ROOMS_JSON"
FIRST_ROOM=""
FIRST_MSGS=0
FIRST_GAMES=0

# Poll all rooms in parallel: each poll writes only its own per-room
# files, so the run lasts one slice, not one slice per room.
for ENTRY in "${ORDER[@]}"; do
  R=$(printf '%s' "$ENTRY" | cut -f1)
  T=$(printf '%s' "$ENTRY" | cut -f2)
  S=$(printf '%s' "$ENTRY" | cut -f3)
  poll_room "$R" "$T" "$S" &
done
wait

for ENTRY in "${ORDER[@]}"; do
  R=$(printf '%s' "$ENTRY" | cut -f1)
  COUNT=$(cat "$TMPD/$R/count" 2>/dev/null || echo -1)
  if [ "$COUNT" = "-1" ]; then
    FAILED=$((FAILED + 1))
    continue
  fi
  if [ "$COUNT" -gt 0 ]; then
    TOTAL_COUNT=$((TOTAL_COUNT + COUNT))
    MSGS_JSON=$(jq -s '.' "$TMPD/$R/messages.jsonl")
    GAMES_JSON=$(jq -s '.' "$TMPD/$R/games.jsonl")
    if [ -z "$FIRST_ROOM" ]; then
      FIRST_ROOM="$R"
      FIRST_MSGS=$(printf '%s' "$MSGS_JSON" | jq 'length')
      FIRST_GAMES=$(printf '%s' "$GAMES_JSON" | jq 'length')
    fi
    jq -n --arg room "$R" --argjson messages "$MSGS_JSON" --argjson games "$GAMES_JSON" \
      '{room: $room} + (if ($messages | length) > 0 then {messages: $messages} else {} end) + (if ($games | length) > 0 then {games: $games} else {} end)' >> "$ROOMS_JSON"
  fi
done

log "polled $NROOMS room(s)"

if [ "$TOTAL_COUNT" = "0" ]; then
  if [ "$FAILED" = "$NROOMS" ]; then
    if [ "$DRY" = "1" ]; then
      silent "dry-run: room fetch failed"
    else
      silent "room fetch failed"
    fi
  else
    if [ "$DRY" = "1" ]; then
      silent "dry-run: no new messages"
    else
      silent "no new messages"
    fi
  fi
  exit 0
fi

ACTIVE_ROOMS=$(jq -s 'length' "$ROOMS_JSON")
if [ "$NROOMS" = "1" ]; then
  # Legacy payload shape for a one-room install: {room, messages, games?}.
  PAYLOAD=$(jq -s '.[0]' "$ROOMS_JSON")
else
  PAYLOAD=$(jq -n --slurpfile rooms "$ROOMS_JSON" '{rooms: $rooms}')
fi

if [ "$DRY" = "1" ]; then
  wake "dry-run: would wake on room activity" "{\"count\":$TOTAL_COUNT}"
  exit 0
fi

if [ "$ACTIVE_ROOMS" = "1" ] && [ "$FIRST_MSGS" -gt 0 ]; then
  wake "new messages in $FIRST_ROOM" "$PAYLOAD"
elif [ "$ACTIVE_ROOMS" = "1" ]; then
  wake "game update in $FIRST_ROOM" "$PAYLOAD"
else
  wake "activity in $ACTIVE_ROOMS watched rooms" "$PAYLOAD"
fi
exit 0
