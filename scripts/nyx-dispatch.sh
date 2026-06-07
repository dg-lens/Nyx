#!/bin/bash
source "$(dirname "$0")/_layout.sh"

set -u

NYX_REPO_ROOT="${NYX_REPO_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
NYX_DATA_DIR="${NYX_DATA_DIR:-$NYX_REPO_ROOT}"

LOCK_DIR="/tmp/nyx-dispatch.sh.lock"
LOG_DIR="${NYX_DATA_DIR}/logs"
LOG_FILE="${LOG_DIR}/dispatch-$(date +%Y-%m-%d).log"

mkdir -p "$LOG_DIR"

acquire_lock() {
  if mkdir "$LOCK_DIR" 2>/dev/null; then
    return 0
  fi
  OWNER_PID=$(cat "$LOCK_DIR/pid" 2>/dev/null)
  if [ -z "$OWNER_PID" ] || ! kill -0 "$OWNER_PID" 2>/dev/null; then
    echo "[$(date -Iseconds)] stale nyx dispatch lock (owner ${OWNER_PID:-unknown} dead), recovering" >> "$LOG_FILE"
    rm -rf "$LOCK_DIR"
    mkdir "$LOCK_DIR" 2>/dev/null && return 0
  fi
  return 1
}

if acquire_lock; then
  trap 'rm -rf "$LOCK_DIR"' EXIT INT TERM
  echo $$ > "$LOCK_DIR/pid"
else
  echo "[$(date -Iseconds)] another nyx dispatch is running, exiting" >> "$LOG_FILE"
  exit 0
fi

if [ -f "$NYX_DATA_DIR/.env" ]; then
  set -a
  source "$NYX_DATA_DIR/.env"
  set +a
fi

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

cd "$NYX_DATA_DIR" || exit 1

BW_TOKEN_PATH="${BITWARDEN_MACHINE_TOKEN_PATH:-$HOME/.config/bitwarden/nyx-machine.token}"
case "$BW_TOKEN_PATH" in "~"*) BW_TOKEN_PATH="${HOME}${BW_TOKEN_PATH#\~}";; esac
if [ ! -f "$BW_TOKEN_PATH" ]; then
  echo "[$(date -Iseconds)] note: bitwarden machine token absent at $BW_TOKEN_PATH — bw-project tasks will fall back to no-secrets" >> "$LOG_FILE"
fi
if ! command -v bws >/dev/null 2>&1; then
  echo "[$(date -Iseconds)] note: bws CLI not on PATH — install with 'brew install bitwarden-sm' if you want secrets injection" >> "$LOG_FILE"
fi

echo "[$(date -Iseconds)] tick" >> "$LOG_FILE"

DISPATCHER_DIST="$NYX_REPO_ROOT/apps/dispatcher/dist/cli/run-once.js"
DISPATCHER_SRC="$NYX_REPO_ROOT/apps/dispatcher/src/cli/run-once.ts"

if [ -f "$DISPATCHER_DIST" ]; then
  node "$DISPATCHER_DIST" >> "$LOG_FILE" 2>&1
  EXIT=$?
elif command -v pnpm >/dev/null 2>&1; then
  pnpm --filter @nyx/dispatcher dev >> "$LOG_FILE" 2>&1
  EXIT=$?
else
  echo "[$(date -Iseconds)] dispatcher not built and pnpm missing" >> "$LOG_FILE"
  EXIT=1
fi

echo "[$(date -Iseconds)] tick exit $EXIT" >> "$LOG_FILE"

find "$LOG_DIR" -name 'dispatch-*.log' -type f -mtime +"${LOG_RETENTION_DAYS:-7}" -delete 2>/dev/null

exit $EXIT
