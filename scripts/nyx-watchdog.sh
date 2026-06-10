#!/bin/bash
set -u

NYX_DATA_DIR="${NYX_DATA_DIR:-${HOME}/Nyx/Data}"
LAST_TICK_FILE="$NYX_DATA_DIR/data/last-tick-ok"
UPDATE_FAILED_MARKER="$NYX_DATA_DIR/data/update-failed.marker"
ALERT_STATE_FILE="$NYX_DATA_DIR/data/watchdog-last-alert"
THRESHOLD_MINUTES="${NYX_WATCHDOG_THRESHOLD_MINUTES:-90}"
ALERT_REPEAT_SECONDS="${NYX_WATCHDOG_REPEAT_SECONDS:-3600}"

if [ -f "$NYX_DATA_DIR/.env" ]; then
  set -a
  source "$NYX_DATA_DIR/.env"
  set +a
fi

NAME="${NAME:-Nyx}"
SLACK_BOT_TOKEN="${SLACK_BOT_TOKEN:-}"
SLACK_USER_ID="${SLACK_USER_ID:-}"
SLACK_WEBHOOK_URL="${SLACK_WEBHOOK_URL:-}"
PUSHOVER_APP_TOKEN="${PUSHOVER_APP_TOKEN:-}"
PUSHOVER_USER_KEY="${PUSHOVER_USER_KEY:-}"

NOW=$(date +%s)

json_escape() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  s="${s//$'\n'/\\n}"
  s="${s//$'\t'/\\t}"
  s="${s//$'\r'/}"
  printf '%s' "$s"
}

deliver_message() {
  local text="$1"
  local priority="${2:-1}"
  if [ -n "$PUSHOVER_APP_TOKEN" ] && [ -n "$PUSHOVER_USER_KEY" ]; then
    if curl -fs https://api.pushover.net/1/messages.json \
      -d token="$PUSHOVER_APP_TOKEN" \
      -d user="$PUSHOVER_USER_KEY" \
      -d priority="$priority" \
      -d message="$text" >/dev/null 2>&1; then
      return 0
    fi
  fi
  if [ -n "$SLACK_WEBHOOK_URL" ]; then
    if curl -fs -X POST "$SLACK_WEBHOOK_URL" \
      -H "Content-Type: application/json" \
      --data "{\"text\":\"$(json_escape "$text")\"}" >/dev/null 2>&1; then
      return 0
    fi
  fi
  if [ -n "$SLACK_BOT_TOKEN" ] && [ -n "$SLACK_USER_ID" ]; then
    local resp channel
    resp=$(curl -fs -X POST "https://slack.com/api/conversations.open" \
      -H "Authorization: Bearer $SLACK_BOT_TOKEN" \
      -H "Content-Type: application/json" \
      --data "{\"users\":\"$(json_escape "$SLACK_USER_ID")\"}" 2>/dev/null)
    channel="${resp##*\"id\":\"}"
    channel="${channel%%\"*}"
    if [ -n "$channel" ] && [ "$channel" != "$resp" ]; then
      if curl -fs -X POST "https://slack.com/api/chat.postMessage" \
        -H "Authorization: Bearer $SLACK_BOT_TOKEN" \
        -H "Content-Type: application/json" \
        --data "{\"channel\":\"$channel\",\"text\":\"$(json_escape "$text")\"}" >/dev/null 2>&1; then
        return 0
      fi
    fi
  fi
  printf '[%s] [watchdog] no delivery channel — message: %s\n' "$(date -Iseconds)" "$text" >&2
  return 0
}

maybe_alert() {
  local text="$1"
  local last_alert=0
  if [ -f "$ALERT_STATE_FILE" ]; then
    last_alert=$(cat "$ALERT_STATE_FILE" 2>/dev/null)
    case "$last_alert" in
      ''|*[!0-9]*) last_alert=0 ;;
    esac
    if [ $((NOW - last_alert)) -lt "$ALERT_REPEAT_SECONDS" ]; then
      return 0
    fi
  fi
  deliver_message "$text" 1
  mkdir -p "$NYX_DATA_DIR/data"
  printf '%s' "$NOW" > "$ALERT_STATE_FILE"
}

all_clear() {
  if [ -f "$ALERT_STATE_FILE" ]; then
    deliver_message "✅ $NAME watchdog: dispatcher has recovered — ticks are flowing again." 0
    rm -f "$ALERT_STATE_FILE"
  fi
}

if [ -f "$UPDATE_FAILED_MARKER" ]; then
  maybe_alert "🚨 $NAME watchdog: update-failed marker present at $UPDATE_FAILED_MARKER — a self-update failed and the keg may be broken. Check: brew install --HEAD dg-lens/nyx/nyx"
  exit 0
fi

if [ ! -f "$LAST_TICK_FILE" ]; then
  maybe_alert "🚨 $NAME watchdog: no tick heartbeat at $LAST_TICK_FILE — the dispatcher has never completed a tick or the data directory path is wrong. Check: launchctl list com.nyx.dispatcher"
  exit 0
fi

LAST_OK=$(cat "$LAST_TICK_FILE" 2>/dev/null)
case "$LAST_OK" in
  ''|*[!0-9]*) LAST_OK='' ;;
esac

if [ -z "$LAST_OK" ]; then
  maybe_alert "🚨 $NAME watchdog: tick heartbeat at $LAST_TICK_FILE is malformed or unreadable."
  exit 0
fi

if [ "$LAST_OK" -gt "$NOW" ]; then
  AGE_SECONDS=0
else
  AGE_SECONDS=$((NOW - LAST_OK))
fi

THRESHOLD_SECONDS=$((THRESHOLD_MINUTES * 60))
if [ "$AGE_SECONDS" -gt "$THRESHOLD_SECONDS" ]; then
  AGE_MINUTES=$((AGE_SECONDS / 60))
  maybe_alert "🚨 $NAME watchdog: last successful tick was ${AGE_MINUTES}m ago (threshold: ${THRESHOLD_MINUTES}m). The dispatcher may be down. Check: launchctl list com.nyx.dispatcher"
  exit 0
fi

all_clear
exit 0
