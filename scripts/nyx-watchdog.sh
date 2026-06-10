#!/bin/bash
set -u

NYX_DATA_DIR="${NYX_DATA_DIR:-${HOME}/Nyx/Data}"
HEARTBEAT_FILE="$NYX_DATA_DIR/data/heartbeat.json"
THRESHOLD_MINUTES="${NYX_WATCHDOG_THRESHOLD_MINUTES:-90}"

if [ -f "$NYX_DATA_DIR/.env" ]; then
  set -a
  source "$NYX_DATA_DIR/.env"
  set +a
fi

NAME="${NAME:-Nyx}"
SLACK_BOT_TOKEN="${SLACK_BOT_TOKEN:-}"
SLACK_USER_ID="${SLACK_USER_ID:-}"
SLACK_WEBHOOK_URL="${SLACK_WEBHOOK_URL:-}"

json_encode() {
  printf '%s' "$1" | python3 -c "import json,sys; sys.stdout.write(json.dumps(sys.stdin.read()))"
}

send_alert() {
  local text="$1"
  local body="{\"text\":$(json_encode "$text")}"
  if [ -n "$SLACK_WEBHOOK_URL" ]; then
    curl -s -X POST "$SLACK_WEBHOOK_URL" \
      -H "Content-Type: application/json" \
      --data "$body" >/dev/null 2>&1
    return
  fi
  if [ -n "$SLACK_BOT_TOKEN" ] && [ -n "$SLACK_USER_ID" ]; then
    local channel
    channel=$(curl -s -X POST "https://slack.com/api/conversations.open" \
      -H "Authorization: Bearer $SLACK_BOT_TOKEN" \
      -H "Content-Type: application/json" \
      --data "{\"users\":\"$SLACK_USER_ID\"}" \
      | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('channel',{}).get('id',''))" 2>/dev/null)
    if [ -n "$channel" ]; then
      curl -s -X POST "https://slack.com/api/chat.postMessage" \
        -H "Authorization: Bearer $SLACK_BOT_TOKEN" \
        -H "Content-Type: application/json" \
        --data "{\"channel\":\"$channel\",\"text\":$(json_encode "$text")}" >/dev/null 2>&1
    fi
    return
  fi
  printf '[%s] [watchdog] no slack credentials — alert: %s\n' "$(date -Iseconds)" "$text" >&2
}

if [ ! -f "$HEARTBEAT_FILE" ]; then
  send_alert "🚨 $NAME watchdog: no heartbeat file at $HEARTBEAT_FILE — dispatcher has never completed a tick or the data directory path is wrong."
  exit 0
fi

LAST_AT=$(python3 -c "
import json, sys
try:
    d = json.load(open(sys.argv[1]))
    print(d.get('at', ''))
except Exception:
    print('')
" "$HEARTBEAT_FILE" 2>/dev/null)

if [ -z "$LAST_AT" ]; then
  send_alert "🚨 $NAME watchdog: heartbeat file at $HEARTBEAT_FILE is malformed or unreadable."
  exit 0
fi

AGE_SECONDS=$(python3 -c "
from datetime import datetime, timezone
import sys
try:
    at = datetime.fromisoformat(sys.argv[1].replace('Z', '+00:00'))
    now = datetime.now(timezone.utc)
    print(int((now - at).total_seconds()))
except Exception:
    print(-1)
" "$LAST_AT" 2>/dev/null)

if [ "$AGE_SECONDS" -lt 0 ]; then
  send_alert "🚨 $NAME watchdog: could not parse heartbeat timestamp '$LAST_AT'."
  exit 0
fi

THRESHOLD_SECONDS=$((THRESHOLD_MINUTES * 60))
if [ "$AGE_SECONDS" -gt "$THRESHOLD_SECONDS" ]; then
  AGE_MINUTES=$((AGE_SECONDS / 60))
  send_alert "🚨 $NAME watchdog: last successful tick was ${AGE_MINUTES}m ago (threshold: ${THRESHOLD_MINUTES}m). The dispatcher may be down. Check: launchctl list com.nyx.dispatcher"
fi

exit 0
