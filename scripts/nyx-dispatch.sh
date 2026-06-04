#!/bin/bash
# Nyx dispatch entry point. Invoked by launchd every DISPATCH_INTERVAL_MINUTES.
#
# Responsibilities:
#   1. Acquire atomic lockfile (mkdir is atomic on POSIX).
#   2. Source ~/nyx/.env so the dispatcher sees the configured env.
#   3. Run apps/dispatcher (compiled or via tsx as fallback).
#   4. Release lockfile on exit.

set -u

# NYX_REPO_ROOT: directory containing compiled code (apps/dispatcher/dist/).
# When installed via brew this is set to opt_libexec by the generated wrapper.
NYX_REPO_ROOT="${NYX_REPO_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
# NYX_DATA_DIR: directory containing nyx.md, data/, logs/, .env.
# Defaults to NYX_REPO_ROOT so source installs work unchanged.
NYX_DATA_DIR="${NYX_DATA_DIR:-$NYX_REPO_ROOT}"

# Shell-level lock guards against two launchd ticks both spawning node.
# The Node dispatcher has its own O_EXCL lock at /tmp/nyx-dispatch.lock.
LOCK_DIR="/tmp/nyx-dispatch.sh.lock"
LOG_DIR="${NYX_DATA_DIR}/logs"
LOG_FILE="${LOG_DIR}/dispatch-$(date +%Y-%m-%d).log"

mkdir -p "$LOG_DIR"

if mkdir "$LOCK_DIR" 2>/dev/null; then
  trap 'rm -rf "$LOCK_DIR"' EXIT INT TERM
  echo $$ > "$LOCK_DIR/pid"
else
  echo "[$(date -Iseconds)] another nyx dispatch is running, exiting" >> "$LOG_FILE"
  exit 0
fi

if [ -f "$NYX_DATA_DIR/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  source "$NYX_DATA_DIR/.env"
  set +a
fi

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

cd "$NYX_DATA_DIR" || exit 1

# v0.5 — soft check for Bitwarden tooling. Missing token is fine for most ticks
# (tasks that don't opt-in to bw-project still run). Hard failures show up later
# as 'bitwarden.token.missing' audit events when a tagged task hits a missing file.
BW_TOKEN_PATH="${BITWARDEN_MACHINE_TOKEN_PATH:-$HOME/.config/bitwarden/nyx-machine.token}"
# expand leading ~ if present
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

# Log retention: 7 days
find "$LOG_DIR" -name 'dispatch-*.log' -type f -mtime +"${LOG_RETENTION_DAYS:-7}" -delete 2>/dev/null

exit $EXIT
