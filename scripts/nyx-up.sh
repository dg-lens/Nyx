#!/usr/bin/env bash
# nyx-up: start (or confirm) all Nyx daemons.
#
# Idempotent. Safe to run when things are already up — each subcommand is itself idempotent.
#
#   1. dispatcher (launchd, fires every 15 min)
#
# Use scripts/nyx-down.sh to stop everything.
set -euo pipefail

NYX_ROOT="${NYX_REPO_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
# When installed via brew, NYX_DATA_DIR is set to ~/Nyx by the wrapper;
# for source installs both dirs are the same.
NYX_DATA_DIR="${NYX_DATA_DIR:-$NYX_ROOT}"
DISPATCHER_PLIST="$NYX_ROOT/config/launchd/com.nyx.dispatcher.plist"

# Source .env from the data dir (where operator keeps config, not the code dir).
if [[ -f "$NYX_DATA_DIR/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  . "$NYX_DATA_DIR/.env"
  set +a
fi

cd "$NYX_ROOT"

echo "── 1. dispatcher (launchd) ──────────────────────────────"
if launchctl list 2>/dev/null | grep -q nyx.dispatcher; then
  echo "  ✓ already loaded"
else
  launchctl load -w "$DISPATCHER_PLIST"
  echo "  ✓ loaded"
fi

echo
echo "── status ──────────────────────────────────────────────"
bash "$NYX_ROOT/scripts/nyx-status.sh"
